//! Composing mail: checking what the user wrote and building the RFC 5322
//! message. Sending it is up to the [`MailFetcher`](crate::imap_client::MailFetcher).

use crate::account::normalize_email;
use crate::attachment::{Attachment, safe_filename};
use crate::error::{AppError, AppResult};
use crate::imap_client::MailAddress;
use base64::Engine;
use lettre::Message;
use lettre::message::header::ContentType;
use lettre::message::{Mailbox, MultiPart, SinglePart};
use serde::{Deserialize, Serialize};
use std::time::SystemTime;

pub const MAX_RECIPIENTS: usize = 100;
/// RFC 5322's line limit, which a folded subject stays well within.
const MAX_SUBJECT_CHARS: usize = 998;
const MAX_BODY_BYTES: usize = 1024 * 1024;
/// All attachments together, as most providers (Gmail among them) allow.
pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

/// A file attached while composing, base64-encoded.
#[derive(Debug, Clone, Deserialize)]
pub struct AttachmentUpload {
    pub filename: String,
    #[serde(default)]
    pub content_type: Option<String>,
    /// Standard base64.
    pub data: String,
}

/// Attachments of a message in the same mailbox to send along, as a forward
/// does, by their positions among its attachments.
#[derive(Debug, Clone, Deserialize)]
pub struct ForwardedAttachments {
    pub uid: i64,
    pub indexes: Vec<usize>,
}

/// What the compose form sends.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SendRequest {
    #[serde(default)]
    pub to: Vec<MailAddress>,
    #[serde(default)]
    pub cc: Vec<MailAddress>,
    #[serde(default)]
    pub bcc: Vec<MailAddress>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub body: String,
    /// Message-ID of the message being answered, for threading.
    #[serde(default)]
    pub in_reply_to: Option<String>,
    /// Message-IDs of the thread so far, oldest first.
    #[serde(default)]
    pub references: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<AttachmentUpload>,
    /// The original's attachments, when forwarding.
    #[serde(default)]
    pub forward: Option<ForwardedAttachments>,
    /// The draft this was written in, removed once the message is sent.
    #[serde(default)]
    pub draft_id: Option<String>,
}

/// The outcome of a send.
#[derive(Debug, Clone, Serialize)]
pub struct SendReceipt {
    pub message_id: String,
    /// A copy is in the account's Sent folder (filed by the app or by the
    /// provider). False when no Sent folder could be found or written.
    pub saved_to_sent: bool,
}

/// A checked message, ready to build and send.
#[derive(Debug, Clone)]
pub struct OutgoingEmail {
    pub from: MailAddress,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub bcc: Vec<MailAddress>,
    pub subject: String,
    pub body: String,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<Attachment>,
    /// Without angle brackets.
    pub message_id: String,
    pub date: SystemTime,
}

const BINARY: &str = "application/octet-stream";

/// The content type if lettre accepts it, else the generic binary one.
fn checked_content_type(content_type: Option<&str>) -> String {
    content_type
        .map(str::trim)
        .filter(|ct| ContentType::parse(ct).is_ok())
        .map_or_else(|| BINARY.into(), str::to_ascii_lowercase)
}

fn decoded(upload: &AttachmentUpload) -> AppResult<Attachment> {
    let filename = safe_filename(&upload.filename);
    let data = base64::engine::general_purpose::STANDARD
        .decode(upload.data.trim())
        .map_err(|_| AppError::BadRequest(format!("Could not read the attachment “{filename}”")))?;
    Ok(Attachment {
        content_type: checked_content_type(upload.content_type.as_deref()),
        filename,
        data,
    })
}

/// Drop control characters (CR and LF included, so nothing can start a new
/// header) and trim.
fn single_line(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

fn checked_address(address: &MailAddress) -> AppResult<MailAddress> {
    let email = normalize_email(&address.email)
        .ok()
        .filter(|email| email.parse::<lettre::Address>().is_ok())
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "“{}” is not a valid email address",
                single_line(&address.email)
            ))
        })?;
    Ok(MailAddress::new(
        address.name.as_deref().map(single_line).as_deref(),
        &email,
    ))
}

fn checked_list(addresses: &[MailAddress]) -> AppResult<Vec<MailAddress>> {
    addresses.iter().map(checked_address).collect()
}

/// A Message-ID without its angle brackets, or None if it is not usable.
fn bare_message_id(id: &str) -> Option<String> {
    let id = id.trim().trim_start_matches('<').trim_end_matches('>');
    let usable = !id.is_empty()
        && id.len() <= 250
        && !id
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>'));
    usable.then(|| id.to_string())
}

impl OutgoingEmail {
    /// Check a compose request from `from`. Recipient addresses must be
    /// valid; header text loses line breaks; threading IDs that are not
    /// usable are dropped rather than failing the send.
    pub fn new(from: MailAddress, request: SendRequest) -> AppResult<Self> {
        let from = checked_address(&from)?;
        let to = checked_list(&request.to)?;
        let cc = checked_list(&request.cc)?;
        let bcc = checked_list(&request.bcc)?;
        let recipients = to.len() + cc.len() + bcc.len();
        if recipients == 0 {
            return Err(AppError::BadRequest("Add at least one recipient".into()));
        }
        if recipients > MAX_RECIPIENTS {
            return Err(AppError::BadRequest(format!(
                "A message can have at most {MAX_RECIPIENTS} recipients"
            )));
        }
        let subject = single_line(&request.subject);
        if subject.chars().count() > MAX_SUBJECT_CHARS {
            return Err(AppError::BadRequest("The subject is too long".into()));
        }
        if request.body.len() > MAX_BODY_BYTES {
            return Err(AppError::BadRequest("The message is too long".into()));
        }
        let attachments = request
            .attachments
            .iter()
            .map(decoded)
            .collect::<AppResult<Vec<_>>>()?;
        check_attachment_size(&attachments)?;
        let domain = from.email.rsplit('@').next().unwrap_or("inboxmax.invalid");
        Ok(Self {
            attachments,
            message_id: format!("{}@{domain}", uuid::Uuid::new_v4()),
            date: SystemTime::now(),
            in_reply_to: request.in_reply_to.as_deref().and_then(bare_message_id),
            references: request
                .references
                .iter()
                .filter_map(|id| bare_message_id(id))
                .collect(),
            from,
            to,
            cc,
            bcc,
            subject,
            body: request.body,
        })
    }

    /// Everyone the message goes to.
    pub fn recipients(&self) -> impl Iterator<Item = &MailAddress> {
        self.to.iter().chain(&self.cc).chain(&self.bcc)
    }

    /// Attach more files (a forward's originals), within the size limit.
    pub fn attach(&mut self, more: Vec<Attachment>) -> AppResult<()> {
        self.attachments.extend(more);
        check_attachment_size(&self.attachments)
    }

    /// The message as sent. `keep_bcc` keeps the Bcc header, for the copy
    /// filed in the sender's own Sent folder; recipients never see it.
    pub fn message(&self, keep_bcc: bool) -> AppResult<Message> {
        let mailbox = |address: &MailAddress| -> AppResult<Mailbox> {
            let email = address.email.parse().map_err(|_| {
                AppError::BadRequest(format!("“{}” is not a valid email address", address.email))
            })?;
            Ok(Mailbox::new(address.name.clone(), email))
        };
        let mut builder = Message::builder()
            .from(mailbox(&self.from)?)
            .subject(&self.subject)
            .date(self.date)
            .message_id(Some(format!("<{}>", self.message_id)))
            .user_agent("Inbox Max".into());
        for address in &self.to {
            builder = builder.to(mailbox(address)?);
        }
        for address in &self.cc {
            builder = builder.cc(mailbox(address)?);
        }
        for address in &self.bcc {
            builder = builder.bcc(mailbox(address)?);
        }
        if let Some(id) = &self.in_reply_to {
            builder = builder.in_reply_to(format!("<{id}>"));
        }
        if !self.references.is_empty() {
            let references = self
                .references
                .iter()
                .map(|id| format!("<{id}>"))
                .collect::<Vec<_>>()
                .join(" ");
            builder = builder.references(references);
        }
        if keep_bcc {
            builder = builder.keep_bcc();
        }
        let built = if self.attachments.is_empty() {
            builder
                .header(ContentType::TEXT_PLAIN)
                .body(self.body.clone())
        } else {
            let mut parts = MultiPart::mixed().singlepart(SinglePart::plain(self.body.clone()));
            for attachment in &self.attachments {
                let content_type =
                    ContentType::parse(&checked_content_type(Some(&attachment.content_type)))
                        .map_err(|e| {
                            AppError::BadRequest(format!("Could not build the message: {e}"))
                        })?;
                parts = parts.singlepart(
                    lettre::message::Attachment::new(attachment.filename.clone())
                        .body(attachment.data.clone(), content_type),
                );
            }
            builder.multipart(parts)
        };
        built.map_err(|e| AppError::BadRequest(format!("Could not build the message: {e}")))
    }
}

fn check_attachment_size(attachments: &[Attachment]) -> AppResult<()> {
    let total: usize = attachments.iter().map(|a| a.data.len()).sum();
    if total > MAX_ATTACHMENT_BYTES {
        return Err(AppError::BadRequest(format!(
            "Attachments can total at most {} MB",
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(name: Option<&str>, email: &str) -> MailAddress {
        MailAddress::new(name, email)
    }

    fn request() -> SendRequest {
        SendRequest {
            to: vec![addr(Some("Sarah Chen"), "Sarah.Chen@acme.example")],
            subject: "Lunch?".into(),
            body: "Noon at the usual place.\nCafé Olé.".into(),
            ..SendRequest::default()
        }
    }

    fn me() -> MailAddress {
        addr(None, "me@example.com")
    }

    fn formatted(email: &OutgoingEmail, keep_bcc: bool) -> String {
        String::from_utf8(email.message(keep_bcc).unwrap().formatted()).unwrap()
    }

    #[test]
    fn builds_a_plain_text_message_with_threading_headers() {
        let email = OutgoingEmail::new(
            me(),
            SendRequest {
                cc: vec![addr(None, "bob@acme.example")],
                in_reply_to: Some("<orig@acme.example>".into()),
                references: vec!["root@acme.example".into(), "<orig@acme.example>".into()],
                ..request()
            },
        )
        .unwrap();
        assert_eq!(email.to[0].email, "sarah.chen@acme.example", "normalized");
        let raw = formatted(&email, false);
        assert!(raw.contains("From: me@example.com\r\n"));
        assert!(raw.contains("To: \"Sarah Chen\" <sarah.chen@acme.example>\r\n"));
        assert!(raw.contains("Cc: bob@acme.example\r\n"));
        assert!(raw.contains("Subject: Lunch?\r\n"));
        assert!(raw.contains("In-Reply-To: <orig@acme.example>\r\n"));
        assert!(raw.contains("References: <root@acme.example> <orig@acme.example>\r\n"));
        assert!(raw.contains(&format!("Message-ID: <{}>\r\n", email.message_id)));
        assert!(email.message_id.ends_with("@example.com"));
        assert!(raw.contains("Content-Type: text/plain; charset=utf-8"));
    }

    #[test]
    fn several_recipients_share_one_header() {
        let email = OutgoingEmail::new(
            me(),
            SendRequest {
                to: vec![
                    addr(Some("Chen, Sarah"), "sarah.chen@acme.example"),
                    addr(None, "bob@acme.example"),
                ],
                ..request()
            },
        )
        .unwrap();
        // What the recipient's mail client reads back: names intact (a comma
        // in a name is sent RFC 2047-encoded), both addresses in one header.
        let raw = formatted(&email, false);
        assert_eq!(
            raw.lines().filter(|line| line.starts_with("To:")).count(),
            1
        );
        let received = crate::imap_client::parse_message(1, raw.as_bytes(), None).unwrap();
        assert_eq!(
            received.to,
            [
                addr(Some("Chen, Sarah"), "sarah.chen@acme.example"),
                addr(None, "bob@acme.example"),
            ]
        );
        assert_eq!(received.from, [me()]);
        assert_eq!(received.subject, "Lunch?");
        // Lines go out CRLF-terminated, as SMTP requires.
        assert_eq!(
            received
                .body_text
                .as_deref()
                .map(|b| b.trim_end().replace("\r\n", "\n")),
            Some("Noon at the usual place.\nCafé Olé.".to_string())
        );
    }

    #[test]
    fn bcc_is_kept_only_for_the_senders_copy() {
        let email = OutgoingEmail::new(
            me(),
            SendRequest {
                bcc: vec![addr(None, "secret@example.com")],
                ..request()
            },
        )
        .unwrap();
        assert!(!formatted(&email, false).contains("secret@example.com"));
        assert!(formatted(&email, true).contains("Bcc: secret@example.com"));
        assert_eq!(email.recipients().count(), 2);
    }

    #[test]
    fn header_text_cannot_inject_headers() {
        let email = OutgoingEmail::new(
            me(),
            SendRequest {
                subject: "Hi\r\nBcc: evil@example.com".into(),
                to: vec![addr(
                    Some("Eve\r\nBcc: evil@example.com"),
                    "eve@example.com",
                )],
                ..request()
            },
        )
        .unwrap();
        assert_eq!(email.subject, "Hi  Bcc: evil@example.com");
        let raw = formatted(&email, false);
        assert!(!raw.contains("\r\nBcc:"));
    }

    #[test]
    fn rejects_bad_recipients_and_limits() {
        let fails =
            |request: SendRequest| OutgoingEmail::new(me(), request).unwrap_err().to_string();
        assert_eq!(
            fails(SendRequest {
                to: vec![],
                ..request()
            }),
            "Add at least one recipient"
        );
        assert!(
            fails(SendRequest {
                to: vec![addr(None, "not an address")],
                ..request()
            })
            .contains("not a valid email address")
        );
        assert!(
            fails(SendRequest {
                bcc: vec![addr(None, "a@b.example"); MAX_RECIPIENTS],
                ..request()
            })
            .contains("at most")
        );
        assert!(
            fails(SendRequest {
                body: "x".repeat(MAX_BODY_BYTES + 1),
                ..request()
            })
            .contains("too long")
        );
    }

    fn upload(filename: &str, content_type: Option<&str>, data: &[u8]) -> AttachmentUpload {
        AttachmentUpload {
            filename: filename.into(),
            content_type: content_type.map(Into::into),
            data: base64::engine::general_purpose::STANDARD.encode(data),
        }
    }

    #[test]
    fn attachments_arrive_as_sent() {
        let mut email = OutgoingEmail::new(
            me(),
            SendRequest {
                attachments: vec![
                    upload("notes.txt", Some("text/plain"), b"hello"),
                    upload("../photo.jpg", Some("not a type"), &[0xff, 0xd8, 0xff]),
                ],
                ..request()
            },
        )
        .unwrap();
        email
            .attach(vec![Attachment {
                filename: "Invoice-1042.pdf".into(),
                content_type: "application/pdf".into(),
                data: b"%PDF-1.4".to_vec(),
            }])
            .unwrap();

        let raw = formatted(&email, false);
        assert!(raw.contains("Content-Type: multipart/mixed"));
        let received = crate::imap_client::parse_message(1, raw.as_bytes(), None).unwrap();
        let listed: Vec<_> = received
            .attachments
            .iter()
            .map(|a| (a.filename.as_str(), a.content_type.as_str(), a.size))
            .collect();
        assert_eq!(
            listed,
            [
                ("notes.txt", "text/plain", 5),
                ("_photo.jpg", "application/octet-stream", 3),
                ("Invoice-1042.pdf", "application/pdf", 8),
            ]
        );
        assert_eq!(
            received.body_text.as_deref().map(str::trim_end),
            Some("Noon at the usual place.\r\nCafé Olé.")
        );
        let photo = crate::attachment::extract(raw.as_bytes(), 1).unwrap();
        assert_eq!(photo.data, [0xff, 0xd8, 0xff]);
    }

    #[test]
    fn rejects_unreadable_and_oversized_attachments() {
        let fails = |attachments| {
            OutgoingEmail::new(
                me(),
                SendRequest {
                    attachments,
                    ..request()
                },
            )
            .unwrap_err()
            .to_string()
        };
        assert_eq!(
            fails(vec![AttachmentUpload {
                filename: "x.bin".into(),
                content_type: None,
                data: "not base64!".into(),
            }]),
            "Could not read the attachment “x.bin”"
        );
        let big = vec![0u8; MAX_ATTACHMENT_BYTES / 2 + 1];
        assert_eq!(
            fails(vec![upload("a", None, &big), upload("b", None, &big)]),
            "Attachments can total at most 25 MB"
        );

        let mut email = OutgoingEmail::new(
            me(),
            SendRequest {
                attachments: vec![upload("a", None, &big)],
                ..request()
            },
        )
        .unwrap();
        let more = Attachment {
            filename: "b".into(),
            content_type: "application/octet-stream".into(),
            data: big,
        };
        assert!(
            email.attach(vec![more]).is_err(),
            "forwarded files count too"
        );
    }

    #[test]
    fn unusable_threading_ids_are_dropped() {
        let email = OutgoingEmail::new(
            me(),
            SendRequest {
                in_reply_to: Some("has space@x".into()),
                references: vec!["".into(), "ok@x".into(), "bad<id>@x".into()],
                ..request()
            },
        )
        .unwrap();
        assert_eq!(email.in_reply_to, None);
        assert_eq!(email.references, ["ok@x"]);
    }
}
