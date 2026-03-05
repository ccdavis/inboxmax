use crate::error::{AppError, AppResult};
use async_imap::types::Fetch;
use async_native_tls::TlsConnector;
use chrono::{DateTime, NaiveDate, Utc};
use futures::StreamExt;
use serde::Serialize;
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt};

type TlsStream = async_native_tls::TlsStream<Compat<TcpStream>>;
type ImapSession = async_imap::Session<TlsStream>;

/// Abstraction over IMAP operations so handlers can be tested without a real server.
#[async_trait::async_trait]
pub trait MailFetcher: Send + Sync {
    async fn fetch_envelopes(
        &self,
        host: &str,
        port: u16,
        email: &str,
        password: &str,
        since: NaiveDate,
    ) -> AppResult<Vec<EmailEnvelope>>;

    async fn fetch_email(
        &self,
        host: &str,
        port: u16,
        email: &str,
        password: &str,
        uid: u32,
    ) -> AppResult<FullEmail>;

    async fn search(
        &self,
        host: &str,
        port: u16,
        email: &str,
        password: &str,
        query: &str,
    ) -> AppResult<Vec<EmailEnvelope>>;

    async fn verify_credentials(
        &self,
        host: &str,
        port: u16,
        email: &str,
        password: &str,
    ) -> AppResult<()>;
}

/// Real implementation that talks to IMAP servers.
pub struct RealMailFetcher;

#[async_trait::async_trait]
impl MailFetcher for RealMailFetcher {
    async fn fetch_envelopes(
        &self,
        host: &str,
        port: u16,
        email: &str,
        password: &str,
        since: NaiveDate,
    ) -> AppResult<Vec<EmailEnvelope>> {
        let mut session = connect(host, port, email, password).await?;
        let envelopes = fetch_envelopes_since(&mut session, since).await?;
        let _ = session.logout().await;
        Ok(envelopes)
    }

    async fn fetch_email(
        &self,
        host: &str,
        port: u16,
        email: &str,
        password: &str,
        uid: u32,
    ) -> AppResult<FullEmail> {
        let mut session = connect(host, port, email, password).await?;
        let email = fetch_email_by_uid(&mut session, uid).await?;
        let _ = session.logout().await;
        Ok(email)
    }

    async fn search(
        &self,
        host: &str,
        port: u16,
        email: &str,
        password: &str,
        query: &str,
    ) -> AppResult<Vec<EmailEnvelope>> {
        let mut session = connect(host, port, email, password).await?;
        let results = search_emails(&mut session, query).await?;
        let _ = session.logout().await;
        Ok(results)
    }

    async fn verify_credentials(
        &self,
        host: &str,
        port: u16,
        email: &str,
        password: &str,
    ) -> AppResult<()> {
        let mut session = connect(host, port, email, password).await?;
        let _ = session.logout().await;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EmailEnvelope {
    pub uid: u32,
    pub subject: String,
    pub from: String,
    pub date: Option<DateTime<Utc>>,
    pub has_attachment: bool,
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
pub async fn connect(
    host: &str,
    port: u16,
    email: &str,
    password: &str,
) -> AppResult<ImapSession> {
    let tcp = TcpStream::connect((host, port))
        .await
        .map_err(|e| AppError::Imap(format!("TCP connect failed: {e}")))?;

    let tcp_compat = tcp.compat();

    let tls = TlsConnector::new()
        .danger_accept_invalid_certs(false)
        .connect(host, tcp_compat)
        .await
        .map_err(|e| AppError::Imap(format!("TLS connect failed: {e}")))?;

    let client = async_imap::Client::new(tls);

    let session = client
        .login(email, password)
        .await
        .map_err(|(e, _client)| AppError::Imap(format!("Login failed: {e}")))?;

    Ok(session)
}

/// Fetch email envelopes (headers) since a given date.
pub async fn fetch_envelopes_since(
    session: &mut ImapSession,
    since: NaiveDate,
) -> AppResult<Vec<EmailEnvelope>> {
    session
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
        return Ok(vec![]);
    }

    let uid_list: Vec<String> = uids.iter().map(|u| u.to_string()).collect();
    let uid_set = uid_list.join(",");

    let messages = session
        .uid_fetch(&uid_set, "(UID ENVELOPE)")
        .await
        .map_err(|e| AppError::Imap(format!("FETCH failed: {e}")))?;

    let collected: Vec<_> = messages.filter_map(|r| async { r.ok() }).collect().await;

    let mut envelopes = Vec::new();
    for msg in &collected {
        if let Some(env) = parse_envelope(msg) {
            envelopes.push(env);
        }
    }

    envelopes.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(envelopes)
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

    let collected: Vec<_> = messages.filter_map(|r| async { r.ok() }).collect().await;

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
    let search_query = format!(
        "OR SUBJECT \"{}\" FROM \"{}\"",
        sanitized, sanitized
    );

    let uids = session
        .uid_search(&search_query)
        .await
        .map_err(|e| AppError::Imap(format!("SEARCH failed: {e}")))?;

    if uids.is_empty() {
        return Ok(vec![]);
    }

    let uid_list: Vec<String> = uids.iter().take(50).map(|u| u.to_string()).collect();
    let uid_set = uid_list.join(",");

    let messages = session
        .uid_fetch(&uid_set, "(UID ENVELOPE)")
        .await
        .map_err(|e| AppError::Imap(format!("FETCH failed: {e}")))?;

    let collected: Vec<_> = messages.filter_map(|r| async { r.ok() }).collect().await;

    let mut envelopes = Vec::new();
    for msg in &collected {
        if let Some(env) = parse_envelope(msg) {
            envelopes.push(env);
        }
    }

    envelopes.sort_by(|a, b| b.date.cmp(&a.date));
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
        has_attachment: false,
    })
}

/// Convert Cow<[u8]> to String (IMAP envelope fields are bytes).
fn cow_bytes_to_string(cow: Option<&std::borrow::Cow<'_, [u8]>>) -> String {
    match cow {
        Some(bytes) => String::from_utf8_lossy(bytes).to_string(),
        None => String::new(),
    }
}

fn format_addresses(
    addrs: Option<&Vec<imap_proto::types::Address<'_>>>,
) -> String {
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
