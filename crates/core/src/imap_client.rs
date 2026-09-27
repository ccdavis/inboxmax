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

    /// Move a message out of the inbox, into Trash or the archive.
    async fn move_message(
        &self,
        credentials: &MailCredentials,
        uid: u32,
        to: Folder,
    ) -> AppResult<()> {
        let _ = (credentials, uid, to);
        Err(AppError::BadRequest("Moving mail is not available".into()))
    }

    /// Move a message back to the inbox from Trash or the archive, found by
    /// its Message-ID (moving gives it a new UID). Returns its inbox UID.
    async fn restore_message(
        &self,
        credentials: &MailCredentials,
        from: Folder,
        message_id: &str,
    ) -> AppResult<u32> {
        let _ = (credentials, from, message_id);
        Err(AppError::BadRequest("Moving mail is not available".into()))
    }

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

    /// The server folders the account has, besides the inbox.
    async fn list_folders(&self, credentials: &MailCredentials) -> AppResult<Vec<FolderInfo>> {
        let _ = credentials;
        Ok(Vec::new())
    }

    /// The newest messages in a server folder, newest first.
    async fn fetch_folder(
        &self,
        credentials: &MailCredentials,
        folder: Folder,
    ) -> AppResult<Vec<EmailEnvelope>> {
        let _ = (credentials, folder);
        Err(AppError::NotFound(format!(
            "There is no {} folder",
            folder.label()
        )))
    }

    /// A message in a server folder, without marking it read.
    async fn fetch_folder_email(
        &self,
        credentials: &MailCredentials,
        folder: Folder,
        uid: u32,
    ) -> AppResult<FullEmail> {
        let _ = (credentials, folder, uid);
        Err(AppError::NotFound("Message not found".into()))
    }

    /// One attachment of a message in a server folder.
    async fn fetch_folder_attachment(
        &self,
        credentials: &MailCredentials,
        folder: Folder,
        uid: u32,
        index: usize,
    ) -> AppResult<Attachment> {
        let _ = (credentials, folder, uid, index);
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

    async fn move_message(
        &self,
        credentials: &MailCredentials,
        uid: u32,
        to: Folder,
    ) -> AppResult<()> {
        run_with_timeout(async {
            let mut session = connect(credentials).await?;
            let moved = async {
                let destination = folder_for(&mut session, to).await?;
                select(&mut session, "INBOX").await?;
                let present = session
                    .uid_search(format!("UID {uid}"))
                    .await
                    .map_err(|e| AppError::Imap(format!("SEARCH failed: {e}")))?;
                if !present.contains(&uid) {
                    return Err(AppError::NotFound("Message not found".into()));
                }
                move_uid(&mut session, uid, &destination).await
            }
            .await;
            let _ = session.logout().await;
            moved
        })
        .await
    }

    async fn restore_message(
        &self,
        credentials: &MailCredentials,
        from: Folder,
        message_id: &str,
    ) -> AppResult<u32> {
        run_with_timeout(async {
            let mut session = connect(credentials).await?;
            let restored = async {
                let folder = existing_folder(&mut session, from).await?;
                select(&mut session, &folder).await?;
                let Some(&uid) = find_message_id(&mut session, message_id).await?.first() else {
                    return Err(AppError::NotFound(format!(
                        "The message is no longer in {folder}"
                    )));
                };
                move_uid(&mut session, uid, "INBOX").await?;
                select(&mut session, "INBOX").await?;
                find_message_id(&mut session, message_id)
                    .await?
                    .first()
                    .copied()
                    .ok_or_else(|| AppError::Imap("The message did not arrive in the inbox".into()))
            }
            .await;
            let _ = session.logout().await;
            restored
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
            let fetched = fetch_raw(&mut session, "INBOX", uid, "(UID BODY.PEEK[])").await;
            let _ = session.logout().await;
            crate::attachment::extract(&fetched?.0, index)
        })
        .await
    }

    async fn list_folders(&self, credentials: &MailCredentials) -> AppResult<Vec<FolderInfo>> {
        run_with_timeout(async {
            let mut session = connect(credentials).await?;
            let folders = folder_names(&mut session).await;
            let _ = session.logout().await;
            let folders = folders?;
            // Gmail's archive is All Mail, which also holds everything else;
            // it is shown, but only once even if it matches twice.
            let mut found: Vec<FolderInfo> = Vec::new();
            for kind in Folder::ALL {
                if let Some(name) = locate(&folders, kind)
                    && !found.iter().any(|f| f.name == name)
                {
                    found.push(FolderInfo { kind, name });
                }
            }
            Ok(found)
        })
        .await
    }

    async fn fetch_folder(
        &self,
        credentials: &MailCredentials,
        folder: Folder,
    ) -> AppResult<Vec<EmailEnvelope>> {
        run_with_timeout(async {
            let mut session = connect(credentials).await?;
            let listed = async {
                let name = existing_folder(&mut session, folder).await?;
                newest_matching(&mut session, &name, "ALL", FOLDER_VIEW_LIMIT).await
            }
            .await;
            let _ = session.logout().await;
            listed
        })
        .await
    }

    async fn fetch_folder_email(
        &self,
        credentials: &MailCredentials,
        folder: Folder,
        uid: u32,
    ) -> AppResult<FullEmail> {
        run_with_timeout(async {
            let mut session = connect(credentials).await?;
            let fetched = async {
                let name = existing_folder(&mut session, folder).await?;
                // PEEK: looking through a folder is not reading its mail.
                fetch_raw(&mut session, &name, uid, "(UID INTERNALDATE BODY.PEEK[])").await
            }
            .await;
            let _ = session.logout().await;
            let (raw, received) = fetched?;
            parse_message(uid, &raw, received)
        })
        .await
    }

    async fn fetch_folder_attachment(
        &self,
        credentials: &MailCredentials,
        folder: Folder,
        uid: u32,
        index: usize,
    ) -> AppResult<Attachment> {
        run_with_timeout(async {
            let mut session = connect(credentials).await?;
            let fetched = async {
                let name = existing_folder(&mut session, folder).await?;
                fetch_raw(&mut session, &name, uid, "(UID BODY.PEEK[])").await
            }
            .await;
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
            // Uploading a large message takes a while on a slow line.
            let deadline = MAIL_OPERATION_TIMEOUT + upload_time(copy.len());
            let filed = timeout(deadline, async {
                let mut session = connect(credentials).await?;
                let filed = file_in_sent(&mut session, &copy, &email.message_id).await;
                let _ = session.logout().await;
                filed
            })
            .await
            .unwrap_or_else(|_| Err(AppError::Imap("Mail operation timed out".into())));
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

const TRASH_FOLDER_NAMES: &[&str] = &[
    "Trash",
    "Deleted Items",
    "Deleted Messages",
    "INBOX.Trash",
    "[Gmail]/Trash",
    "[Google Mail]/Trash",
];

/// Gmail archives by taking a message out of the inbox, so its All Mail
/// folder serves when there is no archive folder.
const ARCHIVE_FOLDER_NAMES: &[&str] = &[
    "Archive",
    "Archives",
    "INBOX.Archive",
    "INBOX/Archive",
    "[Gmail]/All Mail",
    "[Google Mail]/All Mail",
];

const DRAFTS_FOLDER_NAMES: &[&str] = &[
    "Drafts",
    "INBOX.Drafts",
    "[Gmail]/Drafts",
    "[Google Mail]/Drafts",
];
const JUNK_FOLDER_NAMES: &[&str] = &[
    "Junk",
    "Spam",
    "Junk E-mail",
    "Junk Email",
    "Bulk Mail",
    "INBOX.Junk",
    "INBOX.Spam",
    "[Gmail]/Spam",
    "[Google Mail]/Spam",
];

/// A folder the mail server itself provides (marked with a special-use
/// attribute, or under a name servers commonly give it). The app moves mail
/// to Trash and Archive, and shows all of them; it does not create or
/// manage folders of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Folder {
    Sent,
    Drafts,
    Archive,
    Trash,
    Junk,
}

impl Folder {
    pub const ALL: [Folder; 5] = [
        Folder::Sent,
        Folder::Drafts,
        Folder::Archive,
        Folder::Trash,
        Folder::Junk,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Folder::Sent => "Sent",
            Folder::Drafts => "Drafts",
            Folder::Archive => "Archive",
            Folder::Trash => "Trash",
            Folder::Junk => "Junk",
        }
    }

    /// Whether mail can be moved here from the inbox.
    pub fn accepts_moves(self) -> bool {
        matches!(self, Folder::Trash | Folder::Archive)
    }
}

/// A server folder the account has, and its name on the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderInfo {
    pub kind: Folder,
    pub name: String,
}

/// The newest messages a folder view shows.
pub const FOLDER_VIEW_LIMIT: usize = 100;

type NameAttribute<'a> = imap_proto::types::NameAttribute<'a>;

async fn folder_names(session: &mut ImapSession) -> AppResult<Vec<async_imap::types::Name>> {
    session
        .list(Some(""), Some("*"))
        .await
        .map_err(|e| AppError::Imap(format!("LIST failed: {e}")))?
        .try_collect()
        .await
        .map_err(|e| AppError::Imap(format!("LIST failed: {e}")))
}

/// The folder the server marks with a special-use attribute (the first
/// kind in `special` that any folder has), else the first of `names` it has.
fn find_folder(
    folders: &[async_imap::types::Name],
    special: &[fn(&NameAttribute<'_>) -> bool],
    names: &[&str],
) -> Option<String> {
    special
        .iter()
        .find_map(|is_kind| {
            folders
                .iter()
                .find(|folder| folder.attributes().iter().any(is_kind))
        })
        .or_else(|| {
            names.iter().find_map(|candidate| {
                folders
                    .iter()
                    .find(|folder| folder.name().eq_ignore_ascii_case(candidate))
            })
        })
        .map(|folder| folder.name().to_string())
}

/// The server's name for a kind of folder, if it has one.
fn locate(folders: &[async_imap::types::Name], kind: Folder) -> Option<String> {
    match kind {
        Folder::Sent => find_folder(
            folders,
            &[|a| matches!(a, NameAttribute::Sent)],
            SENT_FOLDER_NAMES,
        ),
        Folder::Drafts => find_folder(
            folders,
            &[|a| matches!(a, NameAttribute::Drafts)],
            DRAFTS_FOLDER_NAMES,
        ),
        // A folder meant for archiving, by role or name, before all mail
        // (Gmail's archive), which elsewhere may be a virtual folder.
        Folder::Archive => find_folder(
            folders,
            &[|a| matches!(a, NameAttribute::Archive)],
            ARCHIVE_FOLDER_NAMES,
        )
        .or_else(|| find_folder(folders, &[|a| matches!(a, NameAttribute::All)], &[])),
        Folder::Trash => find_folder(
            folders,
            &[|a| matches!(a, NameAttribute::Trash)],
            TRASH_FOLDER_NAMES,
        ),
        Folder::Junk => find_folder(
            folders,
            &[|a| matches!(a, NameAttribute::Junk)],
            JUNK_FOLDER_NAMES,
        ),
    }
}

/// The account's folder of a kind. A missing archive folder is created, as
/// other mail clients do; any other missing folder is an error (for Trash,
/// deleting would otherwise have nowhere safe to go).
async fn folder_for(session: &mut ImapSession, folder: Folder) -> AppResult<String> {
    let folders = folder_names(session).await?;
    if let Some(name) = locate(&folders, folder) {
        return Ok(name);
    }
    if folder == Folder::Archive {
        let listed: Vec<(&str, Option<&str>)> =
            folders.iter().map(|f| (f.name(), f.delimiter())).collect();
        let name = new_folder_name(&listed, "Archive");
        session
            .create(&name)
            .await
            .map_err(|e| AppError::Imap(format!("Could not create {name}: {e}")))?;
        // Some mail programs show only subscribed folders.
        if let Err(e) = session.subscribe(&name).await {
            tracing::debug!("Could not subscribe to {name}: {e}");
        }
        return Ok(name);
    }
    Err(no_such_folder(folder))
}

/// Where a new top-level folder called `leaf` goes: under INBOX on servers
/// that keep every folder there (Courier, some Cyrus), else at the top.
/// `listed` is each folder's name and hierarchy delimiter.
fn new_folder_name(listed: &[(&str, Option<&str>)], leaf: &str) -> String {
    let delimiter = listed.iter().find_map(|(_, d)| *d).unwrap_or(".");
    let prefix = format!("INBOX{delimiter}");
    let mut others = listed
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| !name.eq_ignore_ascii_case("INBOX"))
        .peekable();
    let under_inbox = others.peek().is_some()
        && others.all(|name| {
            name.get(..prefix.len())
                .is_some_and(|start| start.eq_ignore_ascii_case(&prefix))
        });
    if under_inbox {
        format!("{prefix}{leaf}")
    } else {
        leaf.to_string()
    }
}

/// A folder the server already has; looking never creates one.
async fn existing_folder(session: &mut ImapSession, folder: Folder) -> AppResult<String> {
    let folders = folder_names(session).await?;
    locate(&folders, folder).ok_or_else(|| no_such_folder(folder))
}

fn no_such_folder(folder: Folder) -> AppError {
    AppError::NotFound(format!("The mail server has no {} folder", folder.label()))
}

/// A mailbox name as an IMAP quoted string. (async-imap quotes the name for
/// SELECT and MOVE, but sends COPY's as given.)
fn quoted_mailbox(name: &str) -> String {
    format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Move one message out of the selected folder. Uses MOVE where the server
/// has it, else copies it and marks the original deleted. The original is
/// expunged only where UIDPLUS can expunge it alone: a plain EXPUNGE would
/// also remove anything another mail program had marked deleted. Listings
/// leave out messages marked deleted.
async fn move_uid(session: &mut ImapSession, uid: u32, to: &str) -> AppResult<()> {
    let capabilities = session
        .capabilities()
        .await
        .map_err(|e| AppError::Imap(format!("CAPABILITY failed: {e}")))?;
    let uid = uid.to_string();
    if capabilities.has_str("MOVE") {
        return session
            .uid_mv(&uid, to)
            .await
            .map_err(|e| AppError::Imap(format!("MOVE to {to} failed: {e}")));
    }
    session
        .uid_copy(&uid, quoted_mailbox(to))
        .await
        .map_err(|e| AppError::Imap(format!("COPY to {to} failed: {e}")))?;
    session
        .uid_store(&uid, "+FLAGS.SILENT (\\Deleted)")
        .await
        .map_err(|e| AppError::Imap(format!("STORE failed: {e}")))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|e| AppError::Imap(format!("STORE failed: {e}")))?;
    if !capabilities.has_str("UIDPLUS") {
        return Ok(());
    }
    session
        .uid_expunge(&uid)
        .await
        .map_err(|e| AppError::Imap(format!("EXPUNGE failed: {e}")))?
        .try_collect::<Vec<_>>()
        .await
        .map(|_| ())
        .map_err(|e| AppError::Imap(format!("EXPUNGE failed: {e}")))
}

/// Candidates checked for an exact Message-ID; more would be a strange search.
const MAX_MESSAGE_ID_MATCHES: usize = 50;

/// A Message-ID as compared: without spaces or angle brackets (which not
/// every sender uses).
fn bare_message_id(id: &str) -> &str {
    id.trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim()
}

/// UIDs in the selected folder with exactly this Message-ID, newest first.
async fn find_message_id(session: &mut ImapSession, message_id: &str) -> AppResult<Vec<u32>> {
    let wanted = bare_message_id(message_id);
    let id = sanitize_imap_query(wanted);
    // Nothing left to search for would match every message.
    if id.trim().is_empty() {
        return Ok(Vec::new());
    }
    // HEADER matches substrings ("123@x" is in "<99123@x>"), so the
    // candidates are checked against the whole ID.
    let candidates = newest_uid_strings(
        session
            .uid_search(format!("HEADER Message-ID \"{id}\""))
            .await
            .map_err(|e| AppError::Imap(format!("SEARCH failed: {e}")))?,
        MAX_MESSAGE_ID_MATCHES,
    );
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let fetched: Vec<_> = session
        .uid_fetch(candidates.join(","), "(UID ENVELOPE)")
        .await
        .map_err(|e| AppError::Imap(format!("FETCH failed: {e}")))?
        .try_collect()
        .await
        .map_err(|e| AppError::Imap(format!("FETCH stream failed: {e}")))?;
    let mut uids: Vec<u32> = fetched
        .iter()
        .filter_map(parse_envelope)
        .filter(|e| e.message_id.as_deref().map(bare_message_id) == Some(wanted))
        .map(|e| e.uid)
        .collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.dedup();
    Ok(uids)
}

async fn select(session: &mut ImapSession, folder: &str) -> AppResult<()> {
    session
        .select(folder)
        .await
        .map(|_| ())
        .map_err(|e| AppError::Imap(format!("SELECT {folder} failed: {e}")))
}

/// Append `raw` to the Sent folder, unless a message with this Message-ID is
/// already there. Returns false when there is no Sent folder.
async fn file_in_sent(session: &mut ImapSession, raw: &[u8], message_id: &str) -> AppResult<bool> {
    let folders = folder_names(session).await?;
    let Some(folder) = locate(&folders, Folder::Sent) else {
        return Ok(false);
    };

    select(session, &folder).await?;
    if find_message_id(session, message_id).await?.is_empty() {
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
    /// Without angle brackets. Identifies the message after a move changes
    /// its UID, as undoing a delete needs.
    pub message_id: Option<String>,
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

/// Extra time to upload `bytes`, at a slow 1 Mbit/s.
fn upload_time(bytes: usize) -> Duration {
    Duration::from_secs((bytes as u64).div_ceil(125_000))
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
    // Messages marked deleted (by a move on a server without UIDPLUS, or by
    // another client) are on their way out.
    let search_query = format!("SINCE {date_str} UNDELETED");

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

/// A message's raw source and the server's delivery time, by UID in `mailbox`.
async fn fetch_raw(
    session: &mut ImapSession,
    mailbox: &str,
    uid: u32,
    query: &str,
) -> AppResult<(Vec<u8>, Option<DateTime<Utc>>)> {
    select(session, mailbox).await?;
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
    let (raw, received) = fetch_raw(session, "INBOX", uid, "(UID INTERNALDATE BODY[])").await?;
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
    newest_matching(session, "INBOX", &build_search_query(query), 50).await
}

/// The newest `limit` messages in `mailbox` matching SEARCH `criteria`,
/// newest first.
async fn newest_matching(
    session: &mut ImapSession,
    mailbox: &str,
    criteria: &str,
    limit: usize,
) -> AppResult<Vec<EmailEnvelope>> {
    select(session, mailbox).await?;
    // Search keys are ANDed; any CHARSET has to stay first.
    let uids = session
        .uid_search(format!("{criteria} UNDELETED"))
        .await
        .map_err(|e| AppError::Imap(format!("SEARCH failed: {e}")))?;

    if uids.is_empty() {
        return Ok(vec![]);
    }

    let uid_list = newest_uid_strings(uids, limit);
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
        message_id: envelope.message_id.as_ref().and_then(|id| {
            let id = String::from_utf8_lossy(id);
            let id = id.trim().trim_start_matches('<').trim_end_matches('>');
            (!id.is_empty()).then(|| id.to_string())
        }),
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
        MailAddress, build_search_query, decode_header_text, is_public_ip, new_folder_name,
        newest_uid_strings, parse_message, quoted_mailbox,
    };
    use chrono::{TimeZone, Utc};
    use std::borrow::Cow;
    use std::net::IpAddr;

    #[test]
    fn a_new_archive_goes_where_the_server_keeps_folders() {
        let top = [
            ("INBOX", Some("/")),
            ("Sent", Some("/")),
            ("Trash", Some("/")),
        ];
        assert_eq!(new_folder_name(&top, "Archive"), "Archive");
        let under_inbox = [
            ("INBOX", Some(".")),
            ("INBOX.Sent", Some(".")),
            ("inbox.Trash", Some(".")),
        ];
        assert_eq!(new_folder_name(&under_inbox, "Archive"), "INBOX.Archive");
        // Mixed, or only INBOX: the top level.
        let mixed = [
            ("INBOX", Some(".")),
            ("INBOX.Sent", Some(".")),
            ("Trash", Some(".")),
        ];
        assert_eq!(new_folder_name(&mixed, "Archive"), "Archive");
        assert_eq!(new_folder_name(&[("INBOX", None)], "Archive"), "Archive");
    }

    #[test]
    fn mailbox_names_are_quoted_for_copy() {
        assert_eq!(quoted_mailbox("Deleted Items"), "\"Deleted Items\"");
        assert_eq!(quoted_mailbox(r#"a"b\c"#), r#""a\"b\\c""#);
    }

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
