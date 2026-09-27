use crate::attachment::{Attachment, AttachmentInfo};
use crate::config::server_files_sent_mail;
use crate::error::{AppError, AppResult};
use crate::outgoing::{OutgoingEmail, SendReceipt};
use async_imap::types::Fetch;
use async_native_tls::TlsConnector;
use chrono::{DateTime, NaiveDate, Utc};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt};

type TlsStream = async_native_tls::TlsStream<Compat<TcpStream>>;
type ImapSession = async_imap::Session<TlsStream>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAIL_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct MailCredentials {
    pub host: String,
    pub port: u16,
    pub email: String,
    pub password: String,
}

/// Where an account submits outgoing mail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtpServer {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone)]
pub struct MailboxSnapshot {
    pub envelopes: Vec<EmailEnvelope>,
    pub uid_validity: Option<u32>,
}

/// Abstraction over the mail servers (IMAP for reading, SMTP for sending) so
/// handlers can be tested without real ones.
#[async_trait::async_trait]
pub trait MailFetcher: Send + Sync {
    /// Send a message and file a copy in the account's Sent folder. Mail
    /// clients that only read (as many test doubles do) refuse.
    async fn send(
        &self,
        credentials: &MailCredentials,
        smtp: &SmtpServer,
        email: &OutgoingEmail,
    ) -> AppResult<SendReceipt> {
        let _ = (credentials, smtp, email);
        Err(AppError::BadRequest("Sending mail is not available".into()))
    }

    async fn fetch_envelopes(
        &self,
        credentials: &MailCredentials,
        since: NaiveDate,
    ) -> AppResult<MailboxSnapshot>;

    async fn fetch_email(&self, credentials: &MailCredentials, uid: u32) -> AppResult<FullEmail>;

    /// One attachment of a message, by its position among the attachments.
    async fn fetch_attachment(
        &self,
        credentials: &MailCredentials,
        uid: u32,
        index: usize,
    ) -> AppResult<Attachment> {
        let _ = (credentials, uid, index);
        Err(AppError::NotFound("Attachment not found".into()))
    }

    async fn search(
        &self,
        credentials: &MailCredentials,
        query: &str,
    ) -> AppResult<Vec<EmailEnvelope>>;

    async fn verify_credentials(&self, credentials: &MailCredentials) -> AppResult<()>;
}

/// Real implementation that talks to IMAP servers.
pub struct RealMailFetcher;

#[async_trait::async_trait]
impl MailFetcher for RealMailFetcher {
    async fn fetch_envelopes(
        &self,
        credentials: &MailCredentials,
        since: NaiveDate,
    ) -> AppResult<MailboxSnapshot> {
        run_with_timeout(async {
            let mut session = connect(credentials).await?;
            let snapshot = fetch_envelopes_since(&mut session, since).await?;
            let _ = session.logout().await;
            Ok(snapshot)
        })
        .await
    }

    async fn fetch_email(&self, credentials: &MailCredentials, uid: u32) -> AppResult<FullEmail> {
        run_with_timeout(async {
            let mut session = connect(credentials).await?;
            let email = fetch_email_by_uid(&mut session, uid).await?;
            let _ = session.logout().await;
            Ok(email)
        })
        .await
    }

    async fn fetch_attachment(
        &self,
        credentials: &MailCredentials,
        uid: u32,
        index: usize,
    ) -> AppResult<Attachment> {
        run_with_timeout(async {
            let mut session = connect(credentials).await?;
            // PEEK: downloading an attachment is not reading the message.
            let fetched = fetch_raw(&mut session, uid, "(UID BODY.PEEK[])").await;
            let _ = session.logout().await;
            crate::attachment::extract(&fetched?.0, index)
        })
        .await
    }

    async fn search(
        &self,
        credentials: &MailCredentials,
        query: &str,
    ) -> AppResult<Vec<EmailEnvelope>> {
        run_with_timeout(async {
            let mut session = connect(credentials).await?;
            let results = search_emails(&mut session, query).await?;
            let _ = session.logout().await;
            Ok(results)
        })
        .await
    }

    async fn verify_credentials(&self, credentials: &MailCredentials) -> AppResult<()> {
        run_with_timeout(async {
            let mut session = connect(credentials).await?;
            let _ = session.logout().await;
            Ok(())
        })
        .await
    }

    async fn send(
        &self,
        credentials: &MailCredentials,
        smtp: &SmtpServer,
        email: &OutgoingEmail,
    ) -> AppResult<SendReceipt> {
        crate::smtp::send(credentials, smtp, email.message(false)?).await?;
        // The message is sent; failing to file a copy must not look like a
        // failed send (a retry would send it twice), so it only reports back.
        let saved_to_sent = if server_files_sent_mail(&smtp.host) {
            true
        } else {
            let copy = email.message(true)?.formatted();
            let filed = run_with_timeout(async {
                let mut session = connect(credentials).await?;
                let filed = file_in_sent(&mut session, &copy, &email.message_id).await;
                let _ = session.logout().await;
                filed
            })
            .await;
            filed.unwrap_or_else(|e| {
                tracing::warn!(
                    "Sent, but could not file a copy for {}: {e}",
                    credentials.email
                );
                false
            })
        };
        Ok(SendReceipt {
            message_id: email.message_id.clone(),
            saved_to_sent,
        })
    }
}

/// Names servers commonly give the Sent folder when they do not mark it with
/// the \Sent special-use attribute.
const SENT_FOLDER_NAMES: &[&str] = &[
    "Sent",
    "Sent Items",
    "Sent Messages",
    "Sent Mail",
    "INBOX.Sent",
];

/// Append `raw` to the Sent folder, unless a message with this Message-ID is
/// already there. Returns false when there is no Sent folder.
async fn file_in_sent(session: &mut ImapSession, raw: &[u8], message_id: &str) -> AppResult<bool> {
    let names: Vec<_> = session
        .list(Some(""), Some("*"))
        .await
        .map_err(|e| AppError::Imap(format!("LIST failed: {e}")))?
        .try_collect()
        .await
        .map_err(|e| AppError::Imap(format!("LIST failed: {e}")))?;
    let special_use = names.iter().find(|name| {
        name.attributes()
            .iter()
            .any(|attribute| matches!(attribute, imap_proto::types::NameAttribute::Sent))
    });
    let by_name = || {
        SENT_FOLDER_NAMES.iter().find_map(|candidate| {
            names
                .iter()
                .find(|name| name.name().eq_ignore_ascii_case(candidate))
        })
    };
    let Some(folder) = special_use
        .or_else(by_name)
        .map(|name| name.name().to_string())
    else {
        return Ok(false);
    };

    session
        .select(&folder)
        .await
        .map_err(|e| AppError::Imap(format!("SELECT {folder} failed: {e}")))?;
    let already_filed = session
        .uid_search(format!(
            "HEADER Message-ID \"{}\"",
            sanitize_imap_query(message_id)
        ))
        .await
        .map_err(|e| AppError::Imap(format!("SEARCH failed: {e}")))?;
    if already_filed.is_empty() {
        session
            .append(&folder, Some("(\\Seen)"), None, raw)
            .await
            .map_err(|e| AppError::Imap(format!("APPEND to {folder} failed: {e}")))?;
    }
    Ok(true)
}

#[derive(Debug, Clone, Serialize)]
pub struct EmailEnvelope {
    pub uid: u32,
    pub subject: String,
    pub from: String,
    pub date: Option<DateTime<Utc>>,
}

/// One mailbox from an address header: the display name, if any, and the
/// address itself, kept apart so the address is never hidden behind a name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailAddress {
    pub name: Option<String>,
    pub email: String,
}

impl MailAddress {
    pub fn new(name: Option<&str>, email: &str) -> Self {
        Self {
            name: name
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(Into::into),
            email: email.trim().to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FullEmail {
    pub uid: u32,
    pub subject: String,
    pub from: Vec<MailAddress>,
    /// Where replies should go, when the sender asked for somewhere other
    /// than `from`.
    pub reply_to: Vec<MailAddress>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    /// When the sender says it was sent (the Date header, set by the sender).
    pub date: Option<DateTime<Utc>>,
    /// When the mail server received it (IMAP INTERNALDATE).
    pub received: Option<DateTime<Utc>>,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    /// Without angle brackets, like `references`.
    pub message_id: Option<String>,
    /// The thread this message continues (its References header), oldest
    /// first, so a reply can extend it.
    pub references: Vec<String>,
    pub attachments: Vec<AttachmentInfo>,
}

/// Bound an entire mail operation (connect, login, and commands) by one deadline.
async fn run_with_timeout<T>(future: impl Future<Output = AppResult<T>>) -> AppResult<T> {
    timeout(MAIL_OPERATION_TIMEOUT, future)
        .await
        .map_err(|_| AppError::Imap("Mail operation timed out".into()))?
}

/// Connect to an IMAP server and return an authenticated session.
pub async fn connect(credentials: &MailCredentials) -> AppResult<ImapSession> {
    let address = resolve_public_address(&credentials.host, credentials.port).await?;
    let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect(address))
        .await
        .map_err(|_| AppError::Imap("TCP connect timed out".into()))?
        .map_err(|e| AppError::Imap(format!("TCP connect failed: {e}")))?;

    let tcp_compat = tcp.compat();

    let tls = timeout(
        CONNECT_TIMEOUT,
        TlsConnector::new().connect(&credentials.host, tcp_compat),
    )
    .await
    .map_err(|_| AppError::Imap("TLS connect timed out".into()))?
    .map_err(|e| AppError::Imap(format!("TLS connect failed: {e}")))?;

    let client = async_imap::Client::new(tls);

    let session = timeout(
        CONNECT_TIMEOUT,
        client.login(&credentials.email, &credentials.password),
    )
    .await
    .map_err(|_| AppError::Imap("Login timed out".into()))?
    .map_err(|(e, _client)| AppError::MailAuth(e.to_string()))?;

    Ok(session)
}

/// Fetch email envelopes (headers) since a given date.
pub async fn fetch_envelopes_since(
    session: &mut ImapSession,
    since: NaiveDate,
) -> AppResult<MailboxSnapshot> {
    let mailbox = session
        .select("INBOX")
        .await
        .map_err(|e| AppError::Imap(format!("SELECT INBOX failed: {e}")))?;

    let date_str = since.format("%d-%b-%Y").to_string();
    let search_query = format!("SINCE {date_str}");

    let uids = session
        .uid_search(&search_query)
        .await
        .map_err(|e| AppError::Imap(format!("SEARCH failed: {e}")))?;

    if uids.is_empty() {
        return Ok(MailboxSnapshot {
            envelopes: vec![],
            uid_validity: mailbox.uid_validity,
        });
    }

    let uid_list: Vec<String> = uids.iter().map(|u| u.to_string()).collect();
    let uid_set = uid_list.join(",");

    let messages = session
        .uid_fetch(&uid_set, "(UID ENVELOPE)")
        .await
        .map_err(|e| AppError::Imap(format!("FETCH failed: {e}")))?;

    let collected: Vec<_> = messages
        .try_collect()
        .await
        .map_err(|e| AppError::Imap(format!("FETCH stream failed: {e}")))?;

    let mut envelopes = Vec::new();
    for msg in &collected {
        if let Some(env) = parse_envelope(msg) {
            envelopes.push(env);
        }
    }

    envelopes.sort_by_key(|item| std::cmp::Reverse(item.date));
    Ok(MailboxSnapshot {
        envelopes,
        uid_validity: mailbox.uid_validity,
    })
}

/// A message's raw source and the server's delivery time, by UID.
async fn fetch_raw(
    session: &mut ImapSession,
    uid: u32,
    query: &str,
) -> AppResult<(Vec<u8>, Option<DateTime<Utc>>)> {
    session
        .select("INBOX")
        .await
        .map_err(|e| AppError::Imap(format!("SELECT INBOX failed: {e}")))?;
    let messages = session
        .uid_fetch(uid.to_string(), query)
        .await
        .map_err(|e| AppError::Imap(format!("FETCH failed: {e}")))?;
    let collected: Vec<_> = messages
        .try_collect()
        .await
        .map_err(|e| AppError::Imap(format!("FETCH stream failed: {e}")))?;

    // Servers may interleave unsolicited FETCH responses for other messages.
    let msg = collected
        .iter()
        .find(|msg| msg.uid == Some(uid))
        .ok_or_else(|| AppError::NotFound("Message not found".into()))?;
    Ok((
        msg.body().unwrap_or_default().to_vec(),
        msg.internal_date().map(|d| d.with_timezone(&Utc)),
    ))
}

/// Fetch a full email by UID.
pub async fn fetch_email_by_uid(session: &mut ImapSession, uid: u32) -> AppResult<FullEmail> {
    // BODY[] (rather than BODY.PEEK[]) deliberately sets \Seen on the server:
    // opening a message counts as reading it, as in other mail clients. The
    // app's own "seen" marker is independent and tracks headers the user has
    // scanned in the list.
    let (raw, received) = fetch_raw(session, uid, "(UID INTERNALDATE BODY[])").await?;
    parse_message(uid, &raw, received)
}

/// Build a [`FullEmail`] from a raw RFC 5322 message. Headers come from the
/// message itself (with RFC 2047 names decoded); `received` is the server's
/// delivery time, which the message cannot state for itself.
pub fn parse_message(
    uid: u32,
    raw: &[u8],
    received: Option<DateTime<Utc>>,
) -> AppResult<FullEmail> {
    let parsed = mail_parser::MessageParser::default()
        .parse(raw)
        .ok_or_else(|| AppError::Imap("Failed to parse message".into()))?;
    Ok(FullEmail {
        uid,
        subject: parsed.subject().unwrap_or_default().trim().to_string(),
        from: mail_addresses(parsed.from()),
        reply_to: mail_addresses(parsed.reply_to()),
        to: mail_addresses(parsed.to()),
        cc: mail_addresses(parsed.cc()),
        date: parsed
            .date()
            .and_then(|d| DateTime::from_timestamp(d.to_timestamp(), 0)),
        received,
        body_html: parsed.body_html(0).map(|s| s.to_string()),
        body_text: parsed.body_text(0).map(|s| s.to_string()),
        message_id: parsed.message_id().map(|s| s.to_string()),
        references: match parsed.references() {
            mail_parser::HeaderValue::Text(id) => vec![id.to_string()],
            mail_parser::HeaderValue::TextList(ids) => {
                ids.iter().map(|id| id.to_string()).collect()
            }
            _ => Vec::new(),
        },
        attachments: crate::attachment::list(&parsed),
    })
}

/// Every mailbox in an address header, groups flattened. Entries without an
/// address (such as `undisclosed-recipients:;`) are dropped.
fn mail_addresses(header: Option<&mail_parser::Address<'_>>) -> Vec<MailAddress> {
    let Some(header) = header else {
        return Vec::new();
    };
    header
        .iter()
        .filter_map(|addr| {
            let email = addr.address().map(str::trim).filter(|a| !a.is_empty())?;
            Some(MailAddress::new(addr.name(), email))
        })
        .collect()
}

/// Search emails using IMAP SEARCH.
pub async fn search_emails(
    session: &mut ImapSession,
    query: &str,
) -> AppResult<Vec<EmailEnvelope>> {
    session
        .select("INBOX")
        .await
        .map_err(|e| AppError::Imap(format!("SELECT INBOX failed: {e}")))?;

    let search_query = build_search_query(query);

    let uids = session
        .uid_search(&search_query)
        .await
        .map_err(|e| AppError::Imap(format!("SEARCH failed: {e}")))?;

    if uids.is_empty() {
        return Ok(vec![]);
    }

    let uid_list = newest_uid_strings(uids, 50);
    let uid_set = uid_list.join(",");

    let messages = session
        .uid_fetch(&uid_set, "(UID ENVELOPE)")
        .await
        .map_err(|e| AppError::Imap(format!("FETCH failed: {e}")))?;

    let collected: Vec<_> = messages
        .try_collect()
        .await
        .map_err(|e| AppError::Imap(format!("FETCH stream failed: {e}")))?;

    let mut envelopes = Vec::new();
    for msg in &collected {
        if let Some(env) = parse_envelope(msg) {
            envelopes.push(env);
        }
    }

    envelopes.sort_by_key(|item| std::cmp::Reverse(item.date));
    Ok(envelopes)
}

fn parse_envelope(msg: &Fetch) -> Option<EmailEnvelope> {
    let envelope = msg.envelope()?;
    let uid = msg.uid?;

    Some(EmailEnvelope {
        uid,
        subject: decode_header_text(envelope.subject.as_ref()),
        from: format_addresses(envelope.from.as_ref()),
        date: parse_imap_date(envelope.date.as_ref()),
    })
}

/// Resolve a mail server's host name, accepting only public addresses so
/// neither IMAP nor SMTP can be aimed at the local network.
pub(crate) async fn resolve_public_address(host: &str, port: u16) -> AppResult<SocketAddr> {
    if host.is_empty() || host.len() > 253 || host.contains(['\0', '/', '\\']) {
        return Err(AppError::BadRequest("Invalid mail server host".into()));
    }

    let addresses = timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((host, port)))
        .await
        .map_err(|_| AppError::Imap("DNS lookup timed out".into()))?
        .map_err(|e| AppError::Imap(format!("DNS lookup failed: {e}")))?;

    addresses
        .into_iter()
        .find(|address| is_public_ip(address.ip()))
        .ok_or_else(|| {
            AppError::BadRequest("Mail server host must resolve to a public address".into())
        })
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (b == 18 || b == 19))
        || a >= 240)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    // Cover both IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible
    // (::a.b.c.d) forms before applying native IPv6 range checks.
    if let Some(ipv4) = ip.to_ipv4() {
        return is_public_ipv4(ipv4);
    }
    let segments = ip.segments();
    let embedded_ipv4 = |high: u16, low: u16| {
        Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
    };
    // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses route to an embedded
    // IPv4 address, which must itself be public.
    if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_public_ipv4(embedded_ipv4(segments[6], segments[7]));
    }
    if segments[0] == 0x2002 {
        return is_public_ipv4(embedded_ipv4(segments[1], segments[2]));
    }
    let first = segments[0];
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
        || (first & 0xffc0) == 0xfec0
        // Local-use NAT64 (64:ff9b:1::/48) can translate to private networks.
        || (first == 0x64 && segments[1] == 0xff9b && segments[2] == 1)
        // Teredo tunnels (2001::/32) and documentation (2001:db8::/32).
        || (first == 0x2001 && (segments[1] == 0 || segments[1] == 0x0db8)))
}

fn newest_uid_strings(uids: impl IntoIterator<Item = u32>, limit: usize) -> Vec<String> {
    let mut uids: Vec<u32> = uids.into_iter().collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.into_iter()
        .take(limit)
        .map(|uid| uid.to_string())
        .collect()
}

/// Decode an IMAP envelope text field. Envelopes carry raw header bytes, so
/// non-ASCII text arrives as RFC 2047 encoded-words (`=?UTF-8?B?...?=`).
fn decode_header_text(raw: Option<&std::borrow::Cow<'_, [u8]>>) -> String {
    let Some(raw) = raw else {
        return String::new();
    };
    let text = String::from_utf8_lossy(raw);
    if !text.contains("=?") {
        return text.trim().to_string();
    }
    // mail-parser only exposes its RFC 2047 decoder through header parsing, so
    // parse a one-line synthetic message. Line breaks are stripped first so the
    // value cannot inject further headers.
    let unfolded: String = text
        .chars()
        .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
        .collect();
    let synthetic = format!("Subject: {unfolded}\r\n\r\n");
    mail_parser::MessageParser::default()
        .parse(synthetic.as_bytes())
        .and_then(|message| message.subject().map(|s| s.trim().to_string()))
        .unwrap_or_else(|| unfolded.trim().to_string())
}

fn format_addresses(addrs: Option<&Vec<imap_proto::types::Address<'_>>>) -> String {
    let Some(addrs) = addrs else {
        return String::new();
    };
    addrs
        .iter()
        .map(|a| {
            let name = Some(decode_header_text(a.name.as_ref())).filter(|n| !n.is_empty());
            let mailbox = a
                .mailbox
                .as_ref()
                .map(|m| String::from_utf8_lossy(m).to_string())
                .unwrap_or_default();
            let host = a
                .host
                .as_ref()
                .map(|h| String::from_utf8_lossy(h).to_string())
                .unwrap_or_default();
            match (name, host.is_empty()) {
                (Some(name), _) => name,
                (None, true) => mailbox,
                (None, false) => format!("{mailbox}@{host}"),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Build the SEARCH criteria for a subject-or-sender query. Non-ASCII terms
/// need an explicit CHARSET or many servers reject the command.
fn build_search_query(query: &str) -> String {
    let sanitized = sanitize_imap_query(query);
    let criteria = format!("OR SUBJECT \"{sanitized}\" FROM \"{sanitized}\"");
    if sanitized.is_ascii() {
        criteria
    } else {
        format!("CHARSET UTF-8 {criteria}")
    }
}

/// Sanitize user input for use inside IMAP quoted strings.
/// Strips characters that could break out of the quoted context.
fn sanitize_imap_query(input: &str) -> String {
    input
        .chars()
        .filter(|c| !matches!(c, '"' | '\\' | '\r' | '\n' | '\0'))
        .take(200) // reasonable length limit
        .collect()
}

fn parse_imap_date(date: Option<&std::borrow::Cow<'_, [u8]>>) -> Option<DateTime<Utc>> {
    let date_bytes = date?;
    let date_str = std::str::from_utf8(date_bytes).ok()?;
    if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(date_str.trim()) {
        return Some(dt.with_timezone(&Utc));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        MailAddress, build_search_query, decode_header_text, is_public_ip, newest_uid_strings,
        parse_message,
    };
    use chrono::{TimeZone, Utc};
    use std::borrow::Cow;
    use std::net::IpAddr;

    #[test]
    fn blocks_non_public_connection_targets() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.168.1.1",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::127.0.0.1",
            "64:ff9b::7f00:1",
            "64:ff9b::a00:1",
            "64:ff9b:1::1",
            "2002:7f00:1::",
            "2002:c0a8:101::1",
            "2001::1",
            "2001:db8::1",
        ] {
            assert!(
                !is_public_ip(address.parse::<IpAddr>().unwrap()),
                "{address}"
            );
        }
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
        assert!(is_public_ip("64:ff9b::808:808".parse().unwrap()));
        assert!(is_public_ip("2002:808:808::1".parse().unwrap()));
    }

    fn decode(raw: &str) -> String {
        decode_header_text(Some(&Cow::Borrowed(raw.as_bytes())))
    }

    #[test]
    fn decodes_rfc2047_encoded_words() {
        assert_eq!(decode("=?UTF-8?B?SGVsbG8gV8O2cmxk?="), "Hello Wörld");
        assert_eq!(decode("=?ISO-8859-1?Q?Caf=E9?= menu"), "Café menu");
        assert_eq!(decode("Plain subject"), "Plain subject");
        assert_eq!(decode(""), "");
        assert_eq!(decode_header_text(None), "");
    }

    #[test]
    fn decoding_cannot_inject_extra_headers() {
        assert_eq!(
            decode("=?UTF-8?Q?Hi?=\r\nFrom: evil@example.com"),
            "Hi From: evil@example.com"
        );
    }

    #[test]
    fn non_ascii_search_declares_a_charset() {
        assert_eq!(
            build_search_query("invoice"),
            "OR SUBJECT \"invoice\" FROM \"invoice\""
        );
        assert_eq!(
            build_search_query("café \"x\""),
            "CHARSET UTF-8 OR SUBJECT \"café x\" FROM \"café x\""
        );
    }

    #[test]
    fn search_uid_limit_prefers_newest_messages() {
        assert_eq!(newest_uid_strings([3, 100, 2, 50], 3), ["100", "50", "3"]);
    }

    fn addr(name: Option<&str>, email: &str) -> MailAddress {
        MailAddress::new(name, email)
    }

    #[test]
    fn parses_names_with_addresses_reply_to_cc_and_both_times() {
        let raw = concat!(
            "From: =?UTF-8?Q?Sarah_Ch=C3=A9n?= <sarah@work.example>\r\n",
            "Reply-To: Help Desk <help@work.example>\r\n",
            "To: me@example.com, \"Bob, Jr.\" <bob@example.com>\r\n",
            "Cc: Team: ann@example.com, Cy <cy@example.com>;\r\n",
            "Subject: Quarterly numbers\r\n",
            "Date: Fri, 25 Sep 2026 09:00:00 -0400\r\n",
            "Message-ID: <abc@work.example>\r\n",
            "References: <root@work.example>\r\n <prev@work.example>\r\n",
            "\r\n",
            "Hello\r\n",
        );
        let received = Utc.with_ymd_and_hms(2026, 9, 25, 16, 30, 0).unwrap();
        let email = parse_message(7, raw.as_bytes(), Some(received)).unwrap();

        assert_eq!(email.from, [addr(Some("Sarah Chén"), "sarah@work.example")]);
        assert_eq!(
            email.reply_to,
            [addr(Some("Help Desk"), "help@work.example")]
        );
        assert_eq!(
            email.to,
            [
                addr(None, "me@example.com"),
                addr(Some("Bob, Jr."), "bob@example.com")
            ]
        );
        // Group syntax is flattened into its members.
        assert_eq!(
            email.cc,
            [
                addr(None, "ann@example.com"),
                addr(Some("Cy"), "cy@example.com")
            ]
        );
        assert_eq!(
            email.date,
            Some(Utc.with_ymd_and_hms(2026, 9, 25, 13, 0, 0).unwrap())
        );
        assert_eq!(email.received, Some(received));
        assert_eq!(email.subject, "Quarterly numbers");
        assert_eq!(email.message_id.as_deref(), Some("abc@work.example"));
        assert_eq!(email.references, ["root@work.example", "prev@work.example"]);
        assert!(email.attachments.is_empty());
        assert_eq!(email.body_text.as_deref().map(str::trim), Some("Hello"));
    }

    #[test]
    fn missing_headers_and_undisclosed_recipients_are_empty() {
        let raw = "From: <solo@example.com>\r\nTo: undisclosed-recipients:;\r\n\r\nBody\r\n";
        let email = parse_message(1, raw.as_bytes(), None).unwrap();
        assert_eq!(email.from, [addr(None, "solo@example.com")]);
        assert!(email.to.is_empty() && email.cc.is_empty() && email.reply_to.is_empty());
        assert!(email.references.is_empty() && email.message_id.is_none());
        assert_eq!((email.date, email.received), (None, None));
        assert_eq!(email.subject, "");
    }
}
