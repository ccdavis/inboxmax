use crate::error::{AppError, AppResult};
use async_imap::types::Fetch;
use async_native_tls::TlsConnector;
use chrono::{DateTime, NaiveDate, Utc};
use futures::TryStreamExt;
use serde::Serialize;
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

#[derive(Debug, Clone)]
pub struct MailboxSnapshot {
    pub envelopes: Vec<EmailEnvelope>,
    pub uid_validity: Option<u32>,
}

/// Abstraction over IMAP operations so handlers can be tested without a real server.
#[async_trait::async_trait]
pub trait MailFetcher: Send + Sync {
    async fn fetch_envelopes(
        &self,
        credentials: &MailCredentials,
        since: NaiveDate,
    ) -> AppResult<MailboxSnapshot>;

    async fn fetch_email(&self, credentials: &MailCredentials, uid: u32) -> AppResult<FullEmail>;

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
}

#[derive(Debug, Clone, Serialize)]
pub struct EmailEnvelope {
    pub uid: u32,
    pub subject: String,
    pub from: String,
    pub date: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FullEmail {
    pub uid: u32,
    pub subject: String,
    pub from: String,
    pub to: String,
    pub date: Option<DateTime<Utc>>,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub message_id: Option<String>,
}

/// Connect to an IMAP server and return an authenticated session.
async fn run_with_timeout<T>(future: impl Future<Output = AppResult<T>>) -> AppResult<T> {
    timeout(MAIL_OPERATION_TIMEOUT, future)
        .await
        .map_err(|_| AppError::Imap("Mail operation timed out".into()))?
}

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
    .map_err(|(e, _client)| AppError::Imap(format!("Login failed: {e}")))?;

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

/// Fetch a full email by UID.
pub async fn fetch_email_by_uid(session: &mut ImapSession, uid: u32) -> AppResult<FullEmail> {
    session
        .select("INBOX")
        .await
        .map_err(|e| AppError::Imap(format!("SELECT INBOX failed: {e}")))?;

    let messages = session
        .uid_fetch(uid.to_string(), "(UID ENVELOPE BODY[])")
        .await
        .map_err(|e| AppError::Imap(format!("FETCH failed: {e}")))?;

    let collected: Vec<_> = messages
        .try_collect()
        .await
        .map_err(|e| AppError::Imap(format!("FETCH stream failed: {e}")))?;

    let msg = collected
        .first()
        .ok_or_else(|| AppError::Imap("Message not found".into()))?;

    let body_raw = msg.body().unwrap_or_default();
    let parsed = mail_parser::MessageParser::default()
        .parse(body_raw)
        .ok_or_else(|| AppError::Imap("Failed to parse message".into()))?;

    let envelope = msg
        .envelope()
        .ok_or_else(|| AppError::Imap("No envelope".into()))?;

    Ok(FullEmail {
        uid: msg.uid.unwrap_or(uid),
        subject: cow_bytes_to_string(envelope.subject.as_ref()),
        from: format_addresses(envelope.from.as_ref()),
        to: format_addresses(envelope.to.as_ref()),
        date: parse_imap_date(envelope.date.as_ref()),
        body_html: parsed.body_html(0).map(|s| s.to_string()),
        body_text: parsed.body_text(0).map(|s| s.to_string()),
        message_id: parsed.message_id().map(|s| s.to_string()),
    })
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

    let sanitized = sanitize_imap_query(query);
    let search_query = format!("OR SUBJECT \"{}\" FROM \"{}\"", sanitized, sanitized);

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
        subject: cow_bytes_to_string(envelope.subject.as_ref()),
        from: format_addresses(envelope.from.as_ref()),
        date: parse_imap_date(envelope.date.as_ref()),
    })
}

async fn resolve_public_address(host: &str, port: u16) -> AppResult<SocketAddr> {
    if host.is_empty() || host.len() > 253 || host.contains(['\0', '/', '\\']) {
        return Err(AppError::BadRequest("Invalid IMAP host".into()));
    }

    let addresses = timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((host, port)))
        .await
        .map_err(|_| AppError::Imap("DNS lookup timed out".into()))?
        .map_err(|e| AppError::Imap(format!("DNS lookup failed: {e}")))?;

    addresses
        .into_iter()
        .find(|address| is_public_ip(address.ip()))
        .ok_or_else(|| AppError::BadRequest("IMAP host must resolve to a public address".into()))
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
    let first = ip.segments()[0];
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
        || (first & 0xffc0) == 0xfec0
        || (ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8))
}

fn newest_uid_strings(uids: impl IntoIterator<Item = u32>, limit: usize) -> Vec<String> {
    let mut uids: Vec<u32> = uids.into_iter().collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.into_iter()
        .take(limit)
        .map(|uid| uid.to_string())
        .collect()
}

/// Convert Cow<[u8]> to String (IMAP envelope fields are bytes).
fn cow_bytes_to_string(cow: Option<&std::borrow::Cow<'_, [u8]>>) -> String {
    match cow {
        Some(bytes) => String::from_utf8_lossy(bytes).to_string(),
        None => String::new(),
    }
}

fn format_addresses(addrs: Option<&Vec<imap_proto::types::Address<'_>>>) -> String {
    let Some(addrs) = addrs else {
        return String::new();
    };
    addrs
        .iter()
        .map(|a| {
            let name = a
                .name
                .as_ref()
                .map(|n| String::from_utf8_lossy(n).to_string());
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
            if let Some(name) = name {
                name
            } else {
                format!("{mailbox}@{host}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
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
    use super::{is_public_ip, newest_uid_strings};
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
        ] {
            assert!(
                !is_public_ip(address.parse::<IpAddr>().unwrap()),
                "{address}"
            );
        }
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn search_uid_limit_prefers_newest_messages() {
        assert_eq!(newest_uid_strings([3, 100, 2, 50], 3), ["100", "50", "3"]);
    }
}
