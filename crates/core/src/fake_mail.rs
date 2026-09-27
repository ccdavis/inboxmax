//! An in-process mailbox with generated messages, for demos, development
//! without an IMAP account, and end-to-end tests. The desktop app serves it
//! to its demo account (see [`WithDemoMailbox`]); builds with the `fake-mail`
//! feature also serve it to every account when `INBOXMAX_FAKE_MAIL=1`.

use crate::attachment::{Attachment, safe_filename};
use crate::error::{AppError, AppResult};
use crate::imap_client::{
    EmailEnvelope, Folder, FolderInfo, FullEmail, MailAddress, MailCredentials, MailFetcher,
    MailboxSnapshot, SmtpServer,
};
use crate::mailbox::{self, RememberRequest};
use crate::outgoing::{OutgoingEmail, SendReceipt};
use base64::Engine;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Serialize;
use sqlx::SqlitePool;
use std::sync::{Arc, Mutex};

/// The demo account, which people can open to try the app without a mail
/// account. `.invalid` names are reserved (RFC 2606), so no real mailbox or
/// IMAP server can have them.
pub const DEMO_EMAIL: &str = "demo@inboxmax.invalid";
pub const DEMO_HOST: &str = "demo.inboxmax.invalid";
/// The demo mailbox accepts any password; this is the one the app uses.
pub const DEMO_PASSWORD: &str = "demo";

/// Whether an account is the demo account: both its address and its IMAP
/// host, so a real address with a mistyped host is never taken for it.
pub fn is_demo_account(email: &str, host: &str) -> bool {
    email.eq_ignore_ascii_case(DEMO_EMAIL) && host.eq_ignore_ascii_case(DEMO_HOST)
}

/// Any password is accepted except this one, which simulates a rejected login.
pub const REJECTED_PASSWORD: &str = "wrong-password";

const UID_VALIDITY: u32 = 1;

/// Where the demo starts: this many of the newest messages are unseen...
const DEMO_UNSEEN: usize = 4;
/// ...and these (by position, newest first) are remembered.
const DEMO_REMEMBERED: [usize; 2] = [7, 8];

type Mailbox = (&'static str, &'static str);

/// One generated message. The mix covers what the reader and replies have to
/// handle: a Reply-To that differs from the sender, Cc, a delivery delayed
/// hours after the sender's Date, a plain-text body, and an existing thread.
struct FakeMessage {
    from: Mailbox,
    subject: &'static str,
    reply_to: Option<Mailbox>,
    cc: &'static [Mailbox],
    /// Minutes between the sender's Date header and the server receiving it.
    delivery_delay_minutes: i64,
    /// A plain-text body instead of the generated HTML one.
    text: Option<&'static str>,
    /// An HTML body instead of the generated one.
    html: Option<&'static str>,
    /// Message-IDs of earlier messages in the thread (References).
    thread: &'static [&'static str],
    /// (file name as sent, content type, contents)
    attachments: &'static [(&'static str, &'static str, &'static [u8])],
}

const fn message(from: Mailbox, subject: &'static str) -> FakeMessage {
    FakeMessage {
        from,
        subject,
        reply_to: None,
        cc: &[],
        delivery_delay_minutes: 0,
        text: None,
        html: None,
        thread: &[],
        attachments: &[],
    }
}

/// The remote image is on a host where nothing answers.
const SHIPPED_HTML: &str = "<p><img src=\"cid:logo@shipment.example\" alt=\"Logo\"></p>\
<h2>Your order is on its way</h2>\
<p><img alt=\"Wireless headphones\" width=\"160\" height=\"120\" src=\"data:image/svg+xml,\
%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='120'%3E\
%3Crect width='160' height='120' rx='12' fill='%236366f1'/%3E\
%3Ctext x='80' y='68' font-family='sans-serif' font-size='16' fill='white' text-anchor='middle'%3E\
Headphones%3C/text%3E%3C/svg%3E\"></p>\
<p>Wireless headphones, arriving Thursday.</p>\
<p><a href=\"https://example.com/track\">Track your package</a></p>\
<img src=\"https://images.inboxmax.invalid/open.gif?id=demo\" width=\"1\" height=\"1\" alt=\"\">";

const MESSAGES: &[FakeMessage] = &[
    FakeMessage {
        reply_to: Some(("ccdavis/inboxmax", "reply+a1b2c3@reply.github.com")),
        ..message(
            ("GitHub", "notifications@github.com"),
            "PR #47 merged: fix dashboard layout",
        )
    },
    message(
        ("Amazon Web Services", "no-reply-aws@amazon.com"),
        "Your AWS billing summary",
    ),
    FakeMessage {
        cc: &[("Bob Park", "bob.park@acme.example")],
        text: Some(
            "Hi,\n\nDoes the v2 spec still allow partial updates?\n\
             Bob thinks we dropped them.\n\nThanks,\nSarah",
        ),
        thread: &["api-spec-kickoff@acme.example"],
        attachments: &[(
            "API spec v2 (draft).txt",
            "text/plain",
            b"PATCH /v2/items/{id} accepts partial updates.\n",
        )],
        ..message(
            ("Sarah Chen", "sarah.chen@acme.example"),
            "Quick question about the API spec",
        )
    },
    FakeMessage {
        // A name that tries to climb out of the download folder.
        attachments: &[(
            "../../../standup notes.md",
            "text/markdown",
            b"# Standup\n- Shipped the dashboard fix\n",
        )],
        ..message(("Notion", "notify@mail.notion.so"), "Team standup notes")
    },
    FakeMessage {
        reply_to: Some(("Sarah Chen", "sarah.chen@acme.example")),
        ..message(
            ("Google Calendar", "calendar-notification@google.com"),
            "Invitation: Design review @ Wed 2pm",
        )
    },
    FakeMessage {
        // Images, as marketing mail has them: a picture, a tracking pixel
        // on a remote server, and an inline part the app cannot show.
        html: Some(SHIPPED_HTML),
        ..message(
            ("Amazon", "shipment-tracking@amazon.com"),
            "Your order has shipped!",
        )
    },
    FakeMessage {
        reply_to: Some(("Acme Corp Billing", "billing@acme.example")),
        attachments: &[
            (
                "Invoice-1042.pdf",
                "application/pdf",
                b"%PDF-1.4\n% Inbox Max demo invoice\n%%EOF\n",
            ),
            (
                "Receipt-1042.pdf",
                "application/pdf",
                b"%PDF-1.4\n% Inbox Max demo receipt\n%%EOF\n",
            ),
        ],
        ..message(
            ("Stripe", "invoices@stripe.com"),
            "Invoice #1042 from Acme Corp",
        )
    },
    FakeMessage {
        delivery_delay_minutes: 180,
        attachments: &[(
            "Itinerary SFO-JFK.ics",
            "text/calendar",
            b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n",
        )],
        ..message(
            ("Delta Air Lines", "deltaairlines@t.delta.com"),
            "Flight confirmation - SFO to JFK",
        )
    },
    message(
        ("Property Management", "leasing@parkview-apts.example"),
        "Apartment lease renewal",
    ),
    message(
        ("Café Olé", "hallo@cafe-ole.example"),
        "Menü der Woche — Grüße aus der Küche",
    ),
    message(
        ("Ada Lovelace", "ada@analytical.example"),
        "Notes on the analytical engine",
    ),
    message(
        ("Newsletter", "editor@this-week-in-rust.example"),
        "This week in Rust",
    ),
];

/// Every generated mailbox: one message received every five hours, newest
/// first. Outside the demo account, the mailbox login's domain is added to
/// the sender names so accounts differ.
pub struct FakeMailFetcher;

/// A generated message with its sender name for this mailbox, and when the
/// server received it.
struct Generated {
    uid: u32,
    message: &'static FakeMessage,
    sender_name: String,
    received: DateTime<Utc>,
}

impl Generated {
    /// When the sender says it was sent.
    fn sent(&self) -> DateTime<Utc> {
        self.received - Duration::minutes(self.message.delivery_delay_minutes)
    }

    fn envelope(&self) -> EmailEnvelope {
        EmailEnvelope {
            uid: self.uid,
            subject: self.message.subject.to_string(),
            from: self.sender_name.clone(),
            date: Some(self.sent()),
            message_id: Some(message_id(self.uid)),
        }
    }
}

fn message_id(uid: u32) -> String {
    format!("{uid}.{UID_VALIDITY}@fake.inboxmax.invalid")
}

/// Messages moved out of each mailbox's inbox: (account, UID, where to).
static MOVED: Mutex<Vec<(String, u32, Folder)>> = Mutex::new(Vec::new());

fn moved() -> std::sync::MutexGuard<'static, Vec<(String, u32, Folder)>> {
    MOVED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn is_moved(account: &str, uid: u32) -> bool {
    moved()
        .iter()
        .any(|(a, u, _)| *u == uid && a.eq_ignore_ascii_case(account))
}

/// Put every message moved out of `account`'s inbox back.
fn forget_moves(account: &str) {
    moved().retain(|(a, _, _)| !a.eq_ignore_ascii_case(account));
}

/// The messages in a mailbox's inbox (those not moved out).
fn generate(credentials: &MailCredentials) -> Vec<Generated> {
    generate_all(credentials)
        .into_iter()
        .filter(|g| !is_moved(&credentials.email, g.uid))
        .collect()
}

fn generate_all(credentials: &MailCredentials) -> Vec<Generated> {
    let now = Utc::now();
    let demo = is_demo_account(&credentials.email, &credentials.host);
    let domain = credentials
        .email
        .rsplit('@')
        .next()
        .unwrap_or("example.com");
    MESSAGES
        .iter()
        .enumerate()
        .map(|(i, message)| Generated {
            uid: 1000 - i as u32,
            message,
            sender_name: if demo {
                message.from.0.to_string()
            } else {
                format!("{} ({domain})", message.from.0)
            },
            received: now - Duration::minutes(5 + i as i64 * 300),
        })
        .collect()
}

fn envelopes(credentials: &MailCredentials) -> Vec<EmailEnvelope> {
    generate(credentials)
        .iter()
        .map(Generated::envelope)
        .collect()
}

/// A generated message as the reader shows it.
fn full_email(credentials: &MailCredentials, generated: &Generated) -> FullEmail {
    let message = generated.message;
    let uid = generated.uid;
    FullEmail {
        uid,
        subject: message.subject.to_string(),
        from: vec![MailAddress::new(
            Some(&generated.sender_name),
            message.from.1,
        )],
        reply_to: addresses(message.reply_to.as_slice()),
        to: vec![MailAddress::new(None, &credentials.email)],
        cc: addresses(message.cc),
        date: Some(generated.sent()),
        received: Some(generated.received),
        body_html: message.text.is_none().then(|| {
            if let Some(html) = message.html {
                return html.to_string();
            }
            format!(
                "<h2>{subject}</h2><p>This is a generated message from the demo mailbox.</p>\
                 <ul><li>Sender: {name}</li><li>UID: {uid}</li></ul>\
                 <p>Read more at <a href=\"https://example.com/\">example.com</a>.</p>",
                subject = message.subject,
                name = generated.sender_name,
            )
        }),
        body_text: message.text.map(Into::into),
        message_id: Some(message_id(uid)),
        references: message.thread.iter().map(|id| id.to_string()).collect(),
        attachments: attachments(message)
            .iter()
            .enumerate()
            .map(|(index, attachment)| attachment.info(index))
            .collect(),
    }
}

/// Messages moved from the inbox into `folder`, as they were.
fn moved_to(credentials: &MailCredentials, folder: Folder) -> Vec<Generated> {
    let moved: Vec<u32> = moved()
        .iter()
        .filter(|(account, _, to)| {
            account.eq_ignore_ascii_case(&credentials.email) && *to == folder
        })
        .map(|(_, uid, _)| *uid)
        .collect();
    generate_all(credentials)
        .into_iter()
        .filter(|g| moved.contains(&g.uid))
        .collect()
}

/// The mailbox's Sent folder: what it sent through the fake mailbox, as a
/// mail client reads it back, numbered in the order sent.
fn sent_as_received(credentials: &MailCredentials) -> Vec<FullEmail> {
    sent_messages(&credentials.email)
        .iter()
        .enumerate()
        .filter_map(|(i, sent)| {
            crate::imap_client::parse_message(i as u32 + 1, sent.raw.as_bytes(), None).ok()
        })
        .map(|email| FullEmail {
            received: email.date,
            ..email
        })
        .collect()
}

/// The one message in the Junk folder.
fn junk(credentials: &MailCredentials) -> (EmailEnvelope, FullEmail) {
    let received = Utc::now() - Duration::hours(3);
    let email = FullEmail {
        uid: 1,
        subject: "You have won a prize!".into(),
        from: vec![MailAddress::new(
            Some("Prize Department"),
            "winner@lottery.invalid",
        )],
        reply_to: vec![],
        to: vec![MailAddress::new(None, &credentials.email)],
        cc: vec![],
        date: Some(received),
        received: Some(received),
        body_html: None,
        body_text: Some("Claim your prize by sending your bank details.".into()),
        // Spam often has none, and without one the reader offers no
        // "Move to Inbox" that the fake could not carry out.
        message_id: None,
        references: vec![],
        attachments: vec![],
    };
    let envelope = EmailEnvelope {
        uid: 1,
        subject: email.subject.clone(),
        from: "Prize Department".into(),
        date: email.date,
        message_id: email.message_id.clone(),
    };
    (envelope, email)
}

/// A message's attachments as a mail server would hand them over: named
/// safely, the way real messages are parsed.
fn attachments(message: &FakeMessage) -> Vec<Attachment> {
    message
        .attachments
        .iter()
        .map(|(name, content_type, data)| Attachment {
            filename: safe_filename(name),
            content_type: (*content_type).into(),
            data: data.to_vec(),
        })
        .collect()
}

fn addresses(mailboxes: &[Mailbox]) -> Vec<MailAddress> {
    mailboxes
        .iter()
        .map(|(name, email)| MailAddress::new(Some(name), email))
        .collect()
}

/// Put a demo account in its starting state, as if it were last opened a
/// couple of days ago: the newest few messages unseen, older ones already
/// seen, and a couple remembered. Everything the inbox does is then on show.
pub async fn reset_demo(db: &SqlitePool, account_id: &str) -> AppResult<()> {
    forget_moves(DEMO_EMAIL);
    crate::drafts::delete_all(db, account_id).await?;
    let envelopes = envelopes(&MailCredentials {
        host: DEMO_HOST.into(),
        port: 993,
        email: DEMO_EMAIL.into(),
        password: DEMO_PASSWORD.into(),
    });
    // Just before the oldest message, so the whole mailbox is in the window.
    let last_open = envelopes
        .last()
        .and_then(|e| e.date)
        .map(|oldest| (oldest - Duration::hours(1)).timestamp_millis());
    sqlx::query(
        "UPDATE accounts SET uid_validity = ?, watermark_uid = ?, last_open = ?, signature = '' WHERE id = ?",
    )
    .bind(i64::from(UID_VALIDITY))
    .bind(i64::from(envelopes[DEMO_UNSEEN].uid))
    .bind(last_open)
    .bind(account_id)
    .execute(db)
    .await?;

    sqlx::query("DELETE FROM remembered WHERE account_id = ?")
        .bind(account_id)
        .execute(db)
        .await?;
    for envelope in DEMO_REMEMBERED.map(|i| &envelopes[i]) {
        mailbox::remember(
            db,
            account_id,
            i64::from(envelope.uid),
            RememberRequest {
                subject: Some(envelope.subject.clone()),
                sender: Some(envelope.from.clone()),
                date: envelope.date.map(|d| d.timestamp_millis()),
            },
        )
        .await?;
    }
    Ok(())
}

/// Serves the demo mailbox to the demo account and passes every other
/// account to the wrapped mail client. Only for the single-user desktop app:
/// the demo accepts any password, so on the multi-user web server it would
/// let anyone claim the demo address.
pub struct WithDemoMailbox(pub Arc<dyn MailFetcher>);

impl WithDemoMailbox {
    fn pick(&self, credentials: &MailCredentials) -> &dyn MailFetcher {
        if is_demo_account(&credentials.email, &credentials.host) {
            &FakeMailFetcher
        } else {
            self.0.as_ref()
        }
    }
}

#[async_trait::async_trait]
impl MailFetcher for WithDemoMailbox {
    async fn fetch_envelopes(
        &self,
        credentials: &MailCredentials,
        since: NaiveDate,
    ) -> AppResult<MailboxSnapshot> {
        self.pick(credentials)
            .fetch_envelopes(credentials, since)
            .await
    }

    async fn fetch_email(&self, credentials: &MailCredentials, uid: u32) -> AppResult<FullEmail> {
        self.pick(credentials).fetch_email(credentials, uid).await
    }

    async fn fetch_attachment(
        &self,
        credentials: &MailCredentials,
        uid: u32,
        index: usize,
    ) -> AppResult<Attachment> {
        self.pick(credentials)
            .fetch_attachment(credentials, uid, index)
            .await
    }

    async fn move_message(
        &self,
        credentials: &MailCredentials,
        uid: u32,
        to: Folder,
    ) -> AppResult<()> {
        self.pick(credentials)
            .move_message(credentials, uid, to)
            .await
    }

    async fn restore_message(
        &self,
        credentials: &MailCredentials,
        from: Folder,
        message_id: &str,
    ) -> AppResult<u32> {
        self.pick(credentials)
            .restore_message(credentials, from, message_id)
            .await
    }

    async fn list_folders(&self, credentials: &MailCredentials) -> AppResult<Vec<FolderInfo>> {
        self.pick(credentials).list_folders(credentials).await
    }

    async fn fetch_folder(
        &self,
        credentials: &MailCredentials,
        folder: Folder,
    ) -> AppResult<Vec<EmailEnvelope>> {
        self.pick(credentials)
            .fetch_folder(credentials, folder)
            .await
    }

    async fn fetch_folder_email(
        &self,
        credentials: &MailCredentials,
        folder: Folder,
        uid: u32,
    ) -> AppResult<FullEmail> {
        self.pick(credentials)
            .fetch_folder_email(credentials, folder, uid)
            .await
    }

    async fn fetch_folder_attachment(
        &self,
        credentials: &MailCredentials,
        folder: Folder,
        uid: u32,
        index: usize,
    ) -> AppResult<Attachment> {
        self.pick(credentials)
            .fetch_folder_attachment(credentials, folder, uid, index)
            .await
    }

    async fn search(
        &self,
        credentials: &MailCredentials,
        query: &str,
    ) -> AppResult<Vec<EmailEnvelope>> {
        self.pick(credentials).search(credentials, query).await
    }

    async fn verify_credentials(&self, credentials: &MailCredentials) -> AppResult<()> {
        self.pick(credentials).verify_credentials(credentials).await
    }

    async fn send(
        &self,
        credentials: &MailCredentials,
        smtp: &SmtpServer,
        email: &OutgoingEmail,
    ) -> AppResult<SendReceipt> {
        self.pick(credentials).send(credentials, smtp, email).await
    }
}

/// Mail to this address is refused, as a real server refuses an unknown mailbox.
pub const REFUSED_RECIPIENT: &str = "nobody@refused.invalid";
/// The outbox keeps only the most recent messages.
const OUTBOX_LIMIT: usize = 200;

/// A message the fake mailbox "sent": what the user asked for, and the
/// message exactly as it would have gone to the SMTP server.
#[derive(Debug, Clone, Serialize)]
pub struct SentMessage {
    /// The sending account's address.
    pub account: String,
    pub message_id: String,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub bcc: Vec<MailAddress>,
    pub subject: String,
    pub body: String,
    /// The attachments as a recipient's mail client decodes them from `raw`.
    pub attachments: Vec<ReceivedAttachment>,
    /// The formatted message as sent (without a Bcc header).
    pub raw: String,
}

/// An attachment of a sent message, decoded from the message itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReceivedAttachment {
    pub filename: String,
    pub content_type: String,
    pub size: usize,
    /// The decoded contents, base64-encoded for JSON.
    pub data: String,
}

/// The attachments a recipient would find in `raw`.
fn received_attachments(raw: &[u8]) -> AppResult<Vec<ReceivedAttachment>> {
    let message = mail_parser::MessageParser::default()
        .parse(raw)
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("sent an unparseable message")))?;
    let count = crate::attachment::list(&message).len();
    (0..count)
        .map(|index| {
            let attachment = crate::attachment::extract(raw, index)?;
            Ok(ReceivedAttachment {
                size: attachment.data.len(),
                data: base64::engine::general_purpose::STANDARD.encode(&attachment.data),
                filename: attachment.filename,
                content_type: attachment.content_type,
            })
        })
        .collect()
}

static OUTBOX: Mutex<Vec<SentMessage>> = Mutex::new(Vec::new());

/// Messages sent from `account` through the fake mailbox, oldest first.
pub fn sent_messages(account: &str) -> Vec<SentMessage> {
    OUTBOX
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .filter(|sent| sent.account.eq_ignore_ascii_case(account))
        .cloned()
        .collect()
}

#[async_trait::async_trait]
impl MailFetcher for FakeMailFetcher {
    async fn fetch_envelopes(
        &self,
        credentials: &MailCredentials,
        since: NaiveDate,
    ) -> AppResult<MailboxSnapshot> {
        let envelopes = envelopes(credentials)
            .into_iter()
            .filter(|e| e.date.is_none_or(|d| d.date_naive() >= since))
            .collect();
        Ok(MailboxSnapshot {
            envelopes,
            uid_validity: Some(UID_VALIDITY),
        })
    }

    async fn fetch_email(&self, credentials: &MailCredentials, uid: u32) -> AppResult<FullEmail> {
        generate(credentials)
            .iter()
            .find(|g| g.uid == uid)
            .map(|g| full_email(credentials, g))
            .ok_or_else(|| AppError::NotFound("Message not found".into()))
    }

    async fn fetch_attachment(
        &self,
        credentials: &MailCredentials,
        uid: u32,
        index: usize,
    ) -> AppResult<Attachment> {
        generate(credentials)
            .into_iter()
            .find(|g| g.uid == uid)
            .and_then(|g| attachments(g.message).into_iter().nth(index))
            .ok_or_else(|| AppError::NotFound("Attachment not found".into()))
    }

    async fn move_message(
        &self,
        credentials: &MailCredentials,
        uid: u32,
        to: Folder,
    ) -> AppResult<()> {
        if !generate(credentials).iter().any(|g| g.uid == uid) {
            return Err(AppError::NotFound("Message not found".into()));
        }
        moved().push((credentials.email.clone(), uid, to));
        Ok(())
    }

    async fn restore_message(
        &self,
        credentials: &MailCredentials,
        from: Folder,
        id: &str,
    ) -> AppResult<u32> {
        let mut moved = moved();
        let position = moved.iter().position(|(account, uid, folder)| {
            account.eq_ignore_ascii_case(&credentials.email)
                && *folder == from
                && message_id(*uid) == id
        });
        let Some(position) = position else {
            return Err(AppError::NotFound(format!(
                "The message is no longer in {}",
                from.label()
            )));
        };
        // A real server would give it a new UID; the fake keeps the old one.
        Ok(moved.remove(position).1)
    }

    async fn list_folders(&self, _credentials: &MailCredentials) -> AppResult<Vec<FolderInfo>> {
        Ok(Folder::ALL
            .iter()
            .map(|&kind| FolderInfo {
                kind,
                name: kind.label().into(),
            })
            .collect())
    }

    async fn fetch_folder(
        &self,
        credentials: &MailCredentials,
        folder: Folder,
    ) -> AppResult<Vec<EmailEnvelope>> {
        Ok(match folder {
            Folder::Sent => sent_as_received(credentials)
                .iter()
                .rev()
                .map(|email| EmailEnvelope {
                    uid: email.uid,
                    subject: email.subject.clone(),
                    from: credentials.email.clone(),
                    date: email.date,
                    message_id: email.message_id.clone(),
                })
                .collect(),
            Folder::Trash | Folder::Archive => moved_to(credentials, folder)
                .iter()
                .map(Generated::envelope)
                .collect(),
            Folder::Junk => vec![junk(credentials).0],
            Folder::Drafts => Vec::new(),
        })
    }

    async fn fetch_folder_email(
        &self,
        credentials: &MailCredentials,
        folder: Folder,
        uid: u32,
    ) -> AppResult<FullEmail> {
        let found = match folder {
            Folder::Sent => sent_as_received(credentials)
                .into_iter()
                .find(|email| email.uid == uid),
            Folder::Trash | Folder::Archive => moved_to(credentials, folder)
                .iter()
                .find(|g| g.uid == uid)
                .map(|g| full_email(credentials, g)),
            Folder::Junk => Some(junk(credentials).1).filter(|email| email.uid == uid),
            Folder::Drafts => None,
        };
        found.ok_or_else(|| AppError::NotFound("Message not found".into()))
    }

    async fn fetch_folder_attachment(
        &self,
        credentials: &MailCredentials,
        folder: Folder,
        uid: u32,
        index: usize,
    ) -> AppResult<Attachment> {
        match folder {
            Folder::Sent => {
                let sent = sent_messages(&credentials.email);
                let raw = sent
                    .get((uid as usize).wrapping_sub(1))
                    .ok_or_else(|| AppError::NotFound("Message not found".into()))?;
                crate::attachment::extract(raw.raw.as_bytes(), index)
            }
            Folder::Trash | Folder::Archive => moved_to(credentials, folder)
                .iter()
                .find(|g| g.uid == uid)
                .and_then(|g| attachments(g.message).into_iter().nth(index))
                .ok_or_else(|| AppError::NotFound("Attachment not found".into())),
            Folder::Junk | Folder::Drafts => Err(AppError::NotFound("Attachment not found".into())),
        }
    }

    async fn search(
        &self,
        credentials: &MailCredentials,
        query: &str,
    ) -> AppResult<Vec<EmailEnvelope>> {
        let query = query.to_lowercase();
        Ok(envelopes(credentials)
            .into_iter()
            .filter(|e| {
                e.subject.to_lowercase().contains(&query) || e.from.to_lowercase().contains(&query)
            })
            .collect())
    }

    async fn verify_credentials(&self, credentials: &MailCredentials) -> AppResult<()> {
        if credentials.password == REJECTED_PASSWORD {
            return Err(AppError::MailAuth(
                "[AUTHENTICATIONFAILED] Invalid credentials".into(),
            ));
        }
        Ok(())
    }

    async fn send(
        &self,
        credentials: &MailCredentials,
        _smtp: &SmtpServer,
        email: &OutgoingEmail,
    ) -> AppResult<SendReceipt> {
        if let Some(refused) = email
            .recipients()
            .find(|r| r.email.eq_ignore_ascii_case(REFUSED_RECIPIENT))
        {
            return Err(AppError::BadRequest(format!(
                "The mail server refused the message: 550 5.1.1 <{}>: mailbox unavailable",
                refused.email
            )));
        }
        let formatted = email.message(false)?.formatted();
        let attachments = received_attachments(&formatted)?;
        let raw = String::from_utf8_lossy(&formatted).into_owned();
        let mut outbox = OUTBOX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if outbox.len() >= OUTBOX_LIMIT {
            outbox.remove(0);
        }
        outbox.push(SentMessage {
            account: credentials.email.clone(),
            message_id: email.message_id.clone(),
            to: email.to.clone(),
            cc: email.cc.clone(),
            bcc: email.bcc.clone(),
            subject: email.subject.clone(),
            body: email.body.clone(),
            attachments,
            raw,
        });
        Ok(SendReceipt {
            message_id: email.message_id.clone(),
            saved_to_sent: true,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials(password: &str) -> MailCredentials {
        MailCredentials {
            host: "imap.example.com".into(),
            port: 993,
            email: "me@example.com".into(),
            password: password.into(),
        }
    }

    #[tokio::test]
    async fn serves_a_consistent_mailbox() {
        let fake = FakeMailFetcher;
        let creds = credentials("anything");
        assert!(fake.verify_credentials(&creds).await.is_ok());
        assert!(
            fake.verify_credentials(&credentials(REJECTED_PASSWORD))
                .await
                .is_err()
        );

        let week_ago = (Utc::now() - Duration::days(7)).date_naive();
        let snapshot = fake.fetch_envelopes(&creds, week_ago).await.unwrap();
        assert_eq!(snapshot.envelopes.len(), MESSAGES.len());
        let first = &snapshot.envelopes[0];
        assert_eq!(
            fake.fetch_email(&creds, first.uid).await.unwrap().subject,
            first.subject
        );
        assert!(fake.fetch_email(&creds, 1).await.is_err());
        assert_eq!(fake.search(&creds, "INVOICE").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn messages_carry_full_addresses_reply_to_cc_and_delivery_time() {
        let fake = FakeMailFetcher;
        let creds = credentials("pw");
        let email = |subject: &'static str| {
            let uid = 1000
                - MESSAGES
                    .iter()
                    .position(|m| m.subject.contains(subject))
                    .unwrap() as u32;
            let fake = &fake;
            let creds = &creds;
            async move { fake.fetch_email(creds, uid).await.unwrap() }
        };

        let github = email("PR #47").await;
        assert_eq!(github.from[0].email, "notifications@github.com");
        assert_eq!(github.reply_to[0].email, "reply+a1b2c3@reply.github.com");
        assert_eq!(github.to, [MailAddress::new(None, "me@example.com")]);
        assert_eq!(github.date, github.received, "delivered at once");

        let sarah = email("API spec").await;
        assert_eq!(
            sarah.cc,
            [MailAddress::new(Some("Bob Park"), "bob.park@acme.example")]
        );
        assert!(sarah.reply_to.is_empty());

        let delta = email("Flight").await;
        assert_eq!(
            delta.received.unwrap() - delta.date.unwrap(),
            Duration::minutes(180)
        );
    }

    fn connected(email: &str) -> crate::ConnectedAccount {
        crate::ConnectedAccount {
            id: "a".into(),
            email: email.into(),
            password: "pw".into(),
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            smtp: SmtpServer {
                host: "smtp.example.com".into(),
                port: 587,
            },
        }
    }

    /// A database with one user, "u".
    async fn db() -> SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::MIGRATOR.run(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, email, password_hash) VALUES ('u', 'u@example.com', '!')",
        )
        .execute(&db)
        .await
        .unwrap();
        db
    }

    #[tokio::test]
    async fn sending_records_the_message_as_it_would_go_out() {
        let db = db().await;
        let account = connected("outbox-test@example.com");
        let receipt = mailbox::send(
            &db,
            &FakeMailFetcher,
            "u",
            &account,
            crate::outgoing::SendRequest {
                to: vec![MailAddress::new(
                    Some("Sarah Chen"),
                    "sarah.chen@acme.example",
                )],
                bcc: vec![MailAddress::new(None, "hidden@example.com")],
                subject: "Hello".into(),
                body: "Hi Sarah".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(receipt.saved_to_sent);

        let sent = sent_messages("OUTBOX-TEST@example.com");
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].message_id, receipt.message_id);
        assert_eq!(sent[0].bcc[0].email, "hidden@example.com");
        assert!(sent[0].raw.contains("From: outbox-test@example.com\r\n"));
        assert!(
            sent[0]
                .raw
                .contains("To: \"Sarah Chen\" <sarah.chen@acme.example>")
        );
        assert!(
            !sent[0].raw.contains("hidden@example.com"),
            "Bcc stays off the wire"
        );
        assert!(sent_messages("someone-else@example.com").is_empty());

        // Everyone it went to, Bcc included, is in the address book.
        let contacts = crate::contacts::list(&db, "u").await.unwrap();
        let book: Vec<_> = contacts
            .iter()
            .map(|c| (c.email.as_str(), c.name.as_deref(), c.times_sent))
            .collect();
        assert_eq!(
            book,
            [
                ("hidden@example.com", None, 1),
                ("sarah.chen@acme.example", Some("Sarah Chen"), 1)
            ]
        );
    }

    #[tokio::test]
    async fn opening_a_message_adds_its_people_to_the_address_book() {
        let db = db().await;
        let account = connected("reader@acme.example");
        let uid_of = |subject: &str| {
            1000 - MESSAGES
                .iter()
                .position(|m| m.subject.contains(subject))
                .unwrap() as i64
        };
        // A person, a person via Reply-To, and a robot with a reply token.
        for subject in ["API spec", "Design review", "PR #47"] {
            mailbox::get_email(&db, &FakeMailFetcher, "u", &account, uid_of(subject))
                .await
                .unwrap();
        }
        let book: Vec<_> = crate::contacts::list(&db, "u")
            .await
            .unwrap()
            .into_iter()
            .map(|c| (c.email, c.name))
            .collect();
        assert_eq!(
            book,
            [(
                "sarah.chen@acme.example".to_string(),
                Some("Sarah Chen".to_string())
            )],
            "Sarah once (as sender and as Reply-To); the calendar and GitHub robots are skipped"
        );
    }

    #[tokio::test]
    async fn sending_removes_the_messages_draft_but_a_failed_send_keeps_it() {
        let db = db().await;
        sqlx::query(
            "INSERT INTO accounts (id, email, imap_host, smtp_host, user_id)
             VALUES ('a', 'drafter@example.com', 'imap.example.com', 'smtp.example.com', 'u')",
        )
        .execute(&db)
        .await
        .unwrap();
        let account = connected("drafter@example.com");
        let draft = "33333333-3333-4333-8333-333333333333";
        crate::drafts::save(&db, "a", draft, &serde_json::json!({ "subject": "Hi" }))
            .await
            .unwrap();
        let request = |to: &str| crate::outgoing::SendRequest {
            to: vec![MailAddress::new(None, to)],
            draft_id: Some(draft.into()),
            ..Default::default()
        };

        assert!(
            mailbox::send(
                &db,
                &FakeMailFetcher,
                "u",
                &account,
                request(REFUSED_RECIPIENT)
            )
            .await
            .is_err()
        );
        assert_eq!(
            crate::drafts::list(&db, "a").await.unwrap().len(),
            1,
            "kept"
        );

        mailbox::send(
            &db,
            &FakeMailFetcher,
            "u",
            &account,
            request("ok@example.com"),
        )
        .await
        .unwrap();
        assert!(
            crate::drafts::list(&db, "a").await.unwrap().is_empty(),
            "removed"
        );
    }

    #[tokio::test]
    async fn forwarding_sends_the_originals_attachments() {
        let db = db().await;
        let account = connected("forwarder@example.com");
        let stripe = 1000
            - MESSAGES
                .iter()
                .position(|m| m.subject.starts_with("Invoice"))
                .unwrap() as i64;
        let original = mailbox::get_email(&db, &FakeMailFetcher, "u", &account, stripe)
            .await
            .unwrap();
        assert_eq!(original.attachments.len(), 2);

        mailbox::send(
            &db,
            &FakeMailFetcher,
            "u",
            &account,
            crate::outgoing::SendRequest {
                to: vec![MailAddress::new(None, "accounts@acme.example")],
                subject: "Fwd: Invoice".into(),
                // Only the receipt, which is the second attachment.
                forward: Some(crate::outgoing::ForwardedAttachments {
                    uid: stripe,
                    indexes: vec![1],
                    folder: None,
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let [sent] = &sent_messages("forwarder@example.com")[..] else {
            panic!("one message")
        };
        let receipt = FakeMailFetcher
            .fetch_attachment(&account.mail_credentials(), stripe as u32, 1)
            .await
            .unwrap();
        assert_eq!(
            sent.attachments,
            [ReceivedAttachment {
                filename: receipt.filename,
                content_type: receipt.content_type,
                size: receipt.data.len(),
                data: base64::engine::general_purpose::STANDARD.encode(&receipt.data),
            }],
            "the recipient gets the original's bytes"
        );

        // A missing attachment fails the send rather than dropping it.
        let error = mailbox::send(
            &db,
            &FakeMailFetcher,
            "u",
            &account,
            crate::outgoing::SendRequest {
                to: vec![MailAddress::new(None, "accounts@acme.example")],
                forward: Some(crate::outgoing::ForwardedAttachments {
                    uid: stripe,
                    indexes: vec![5],
                    folder: None,
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)));
        assert_eq!(sent_messages("forwarder@example.com").len(), 1);

        // Forwarding from a server folder takes the attachment from that
        // folder's message, not the inbox message with the same UID.
        mailbox::send(
            &db,
            &FakeMailFetcher,
            "u",
            &account,
            crate::outgoing::SendRequest {
                to: vec![MailAddress::new(None, "someone@acme.example")],
                forward: Some(crate::outgoing::ForwardedAttachments {
                    uid: 1,
                    indexes: vec![0],
                    folder: Some(Folder::Sent),
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let sent = sent_messages("forwarder@example.com");
        assert_eq!(sent[1].attachments, sent[0].attachments);
    }

    #[tokio::test]
    async fn moved_messages_leave_the_inbox_and_can_come_back() {
        let db = db().await;
        let account = connected("mover@example.com");
        let creds = account.mail_credentials();
        async fn inbox(creds: &MailCredentials) -> Vec<u32> {
            let week_ago = (Utc::now() - Duration::days(7)).date_naive();
            FakeMailFetcher
                .fetch_envelopes(creds, week_ago)
                .await
                .unwrap()
                .envelopes
                .into_iter()
                .map(|e| e.uid)
                .collect()
        }
        sqlx::query("INSERT INTO accounts (id, email, imap_host, smtp_host, user_id, uid_validity) VALUES ('a', 'mover@example.com', 'imap.example.com', 'smtp.example.com', 'u', 1)")
            .execute(&db)
            .await
            .unwrap();
        mailbox::remember(
            &db,
            "a",
            998,
            RememberRequest {
                subject: Some("API spec".into()),
                sender: None,
                date: None,
            },
        )
        .await
        .unwrap();

        mailbox::move_email(&db, &FakeMailFetcher, &account, 998, Folder::Trash)
            .await
            .unwrap();
        assert!(!inbox(&creds).await.contains(&998));
        assert!(FakeMailFetcher.fetch_email(&creds, 998).await.is_err());
        assert!(
            FakeMailFetcher
                .search(&creds, "API spec")
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            mailbox::list_remembered(&db, "a").await.unwrap().is_empty(),
            "a moved message is no longer remembered"
        );
        // It is not in the archive, and cannot be moved twice.
        assert!(
            mailbox::restore_email(
                &FakeMailFetcher,
                &account,
                Folder::Archive,
                &message_id(998)
            )
            .await
            .is_err()
        );
        assert!(
            mailbox::move_email(&db, &FakeMailFetcher, &account, 998, Folder::Archive)
                .await
                .is_err()
        );

        let restored = mailbox::restore_email(
            &FakeMailFetcher,
            &account,
            Folder::Trash,
            &format!("<{}>", message_id(998)),
        )
        .await
        .unwrap();
        assert_eq!(restored.uid, 998);
        assert!(inbox(&creds).await.contains(&998));
        let again =
            mailbox::restore_email(&FakeMailFetcher, &account, Folder::Trash, &message_id(998))
                .await
                .unwrap_err();
        assert_eq!(again.to_string(), "The message is no longer in Trash");
        assert!(
            mailbox::restore_email(&FakeMailFetcher, &account, Folder::Trash, " <> ")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn server_folders_show_what_was_sent_moved_and_filtered() {
        let db = db().await;
        let account = connected("folders@example.com");
        mailbox::send(
            &db,
            &FakeMailFetcher,
            "u",
            &account,
            crate::outgoing::SendRequest {
                to: vec![MailAddress::new(Some("Sarah"), "sarah@acme.example")],
                subject: "Sent one".into(),
                attachments: vec![crate::outgoing::AttachmentUpload {
                    filename: "a.txt".into(),
                    content_type: None,
                    data: base64::engine::general_purpose::STANDARD.encode("hi"),
                }],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mailbox::move_email(&db, &FakeMailFetcher, &account, 997, Folder::Trash)
            .await
            .unwrap();

        let kinds: Vec<_> = mailbox::list_folders(&FakeMailFetcher, &account)
            .await
            .unwrap()
            .into_iter()
            .map(|f| f.kind)
            .collect();
        assert_eq!(kinds, Folder::ALL);

        let sent = mailbox::folder_emails(&FakeMailFetcher, &account, Folder::Sent)
            .await
            .unwrap();
        assert_eq!(sent[0].subject, "Sent one");
        let read = mailbox::get_folder_email(&FakeMailFetcher, &account, Folder::Sent, 1)
            .await
            .unwrap();
        assert_eq!(
            read.to,
            [MailAddress::new(Some("Sarah"), "sarah@acme.example")]
        );
        let file = mailbox::get_folder_attachment(&FakeMailFetcher, &account, Folder::Sent, 1, 0)
            .await
            .unwrap();
        assert_eq!(file.data, b"hi");

        let trash = mailbox::folder_emails(&FakeMailFetcher, &account, Folder::Trash)
            .await
            .unwrap();
        assert_eq!(trash.iter().map(|e| e.uid).collect::<Vec<_>>(), [997]);
        assert!(
            mailbox::get_folder_email(&FakeMailFetcher, &account, Folder::Archive, 997)
                .await
                .is_err(),
            "it is in Trash, not the archive"
        );
        let junk = mailbox::folder_emails(&FakeMailFetcher, &account, Folder::Junk)
            .await
            .unwrap();
        assert_eq!(junk[0].subject, "You have won a prize!");

        // Only Trash and the archive take moves; Sent and Drafts give none back.
        for folder in [Folder::Sent, Folder::Drafts, Folder::Junk] {
            assert!(
                mailbox::move_email(&db, &FakeMailFetcher, &account, 996, folder)
                    .await
                    .is_err()
            );
        }
        assert!(
            mailbox::restore_email(&FakeMailFetcher, &account, Folder::Sent, "x@y")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn attachment_names_are_made_safe() {
        let creds = credentials("pw");
        let notion = 1000
            - MESSAGES
                .iter()
                .position(|m| m.subject.contains("standup"))
                .unwrap() as u32;
        let attachment = FakeMailFetcher
            .fetch_attachment(&creds, notion, 0)
            .await
            .unwrap();
        assert_eq!(attachment.filename, "_.._.._standup notes.md");
        assert!(
            FakeMailFetcher
                .fetch_attachment(&creds, notion, 1)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_refused_recipient_fails_the_send_and_nothing_is_recorded() {
        let db = db().await;
        let account = connected("refused-test@example.com");
        let error = mailbox::send(
            &db,
            &FakeMailFetcher,
            "u",
            &account,
            crate::outgoing::SendRequest {
                to: vec![
                    MailAddress::new(None, "fine@example.com"),
                    MailAddress::new(None, REFUSED_RECIPIENT),
                ],
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("refused"));
        assert!(sent_messages("refused-test@example.com").is_empty());
        assert!(
            crate::contacts::list(&db, "u").await.unwrap().is_empty(),
            "an unsent message adds no one"
        );
    }

    #[tokio::test]
    async fn read_only_mail_clients_refuse_to_send() {
        let error = mailbox::send(
            &db().await,
            &Unreachable,
            "u",
            &connected("x@example.com"),
            crate::outgoing::SendRequest {
                to: vec![MailAddress::new(None, "y@example.com")],
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "Sending mail is not available");
    }

    /// Stands in for real IMAP: every call fails.
    struct Unreachable;

    #[async_trait::async_trait]
    impl MailFetcher for Unreachable {
        async fn fetch_envelopes(
            &self,
            _: &MailCredentials,
            _: NaiveDate,
        ) -> AppResult<MailboxSnapshot> {
            Err(AppError::MailAuth("unreachable".into()))
        }
        async fn fetch_email(&self, _: &MailCredentials, _: u32) -> AppResult<FullEmail> {
            Err(AppError::MailAuth("unreachable".into()))
        }
        async fn search(&self, _: &MailCredentials, _: &str) -> AppResult<Vec<EmailEnvelope>> {
            Err(AppError::MailAuth("unreachable".into()))
        }
        async fn verify_credentials(&self, _: &MailCredentials) -> AppResult<()> {
            Err(AppError::MailAuth("unreachable".into()))
        }
    }

    #[tokio::test]
    async fn only_the_demo_account_gets_the_demo_mailbox() {
        let mail = WithDemoMailbox(Arc::new(Unreachable));
        let demo = MailCredentials {
            host: DEMO_HOST.into(),
            port: 993,
            email: DEMO_EMAIL.into(),
            password: DEMO_PASSWORD.into(),
        };
        assert!(mail.verify_credentials(&demo).await.is_ok());
        let week_ago = (Utc::now() - Duration::days(7)).date_naive();
        let snapshot = mail.fetch_envelopes(&demo, week_ago).await.unwrap();
        assert_eq!(snapshot.envelopes[0].from, "GitHub", "no domain suffix");

        assert!(mail.verify_credentials(&credentials("pw")).await.is_err());
        // The demo host alone does not make a real address the demo.
        let real_address_on_demo_host = MailCredentials {
            email: "me@example.com".into(),
            ..demo
        };
        assert!(
            mail.verify_credentials(&real_address_on_demo_host)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn the_demo_starts_with_new_seen_and_remembered_mail() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::MIGRATOR.run(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, email, password_hash) VALUES ('u', 'u@example.com', '!')",
        )
        .execute(&db)
        .await
        .unwrap();
        let outcome = crate::account::connect_account(
            &db,
            &FakeMailFetcher,
            "u",
            crate::account::ConnectRequest {
                email: DEMO_EMAIL.into(),
                password: DEMO_PASSWORD.into(),
                imap_host: Some(DEMO_HOST.into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let account = outcome.account;

        // Moving the marker and forgetting are undone by a reset.
        reset_demo(&db, &account.id).await.unwrap();
        mailbox::set_watermark(&db, &account, 1000).await.unwrap();
        mailbox::forget(&db, &account.id, 993).await.unwrap();
        reset_demo(&db, &account.id).await.unwrap();

        let inbox = mailbox::list_emails(&db, &FakeMailFetcher, &account, None)
            .await
            .unwrap();
        assert_eq!(inbox.emails.len(), MESSAGES.len(), "whole mailbox in view");
        let watermark = inbox.watermark_uid.unwrap();
        let unseen = inbox.emails.iter().filter(|e| i64::from(e.uid) > watermark);
        assert_eq!(unseen.count(), DEMO_UNSEEN);

        let remembered = mailbox::list_remembered(&db, &account.id).await.unwrap();
        let mut subjects: Vec<_> = remembered
            .iter()
            .filter_map(|r| r.subject.as_deref())
            .collect();
        subjects.sort_unstable();
        assert_eq!(
            subjects,
            [
                "Apartment lease renewal",
                "Flight confirmation - SFO to JFK"
            ]
        );
    }
}
