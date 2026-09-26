//! An in-process mailbox with generated messages, for demos, development
//! without an IMAP account, and end-to-end tests. The desktop app serves it
//! to its demo account (see [`WithDemoMailbox`]); builds with the `fake-mail`
//! feature also serve it to every account when `INBOXMAX_FAKE_MAIL=1`.

use crate::error::{AppError, AppResult};
use crate::imap_client::{
    EmailEnvelope, FullEmail, MailAddress, MailCredentials, MailFetcher, MailboxSnapshot,
    SmtpServer,
};
use crate::mailbox::{self, RememberRequest};
use crate::outgoing::{OutgoingEmail, SendReceipt};
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

/// One generated message. The mix covers what the reader has to show: a
/// Reply-To that differs from the sender, Cc, and a delivery delayed hours
/// after the sender's Date.
struct FakeMessage {
    from: Mailbox,
    subject: &'static str,
    reply_to: Option<Mailbox>,
    cc: &'static [Mailbox],
    /// Minutes between the sender's Date header and the server receiving it.
    delivery_delay_minutes: i64,
}

const fn message(from: Mailbox, subject: &'static str) -> FakeMessage {
    FakeMessage {
        from,
        subject,
        reply_to: None,
        cc: &[],
        delivery_delay_minutes: 0,
    }
}

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
        ..message(
            ("Sarah Chen", "sarah.chen@acme.example"),
            "Quick question about the API spec",
        )
    },
    message(("Notion", "notify@mail.notion.so"), "Team standup notes"),
    FakeMessage {
        reply_to: Some(("Sarah Chen", "sarah.chen@acme.example")),
        ..message(
            ("Google Calendar", "calendar-notification@google.com"),
            "Invitation: Design review @ Wed 2pm",
        )
    },
    message(
        ("Amazon", "shipment-tracking@amazon.com"),
        "Your order has shipped!",
    ),
    FakeMessage {
        reply_to: Some(("Acme Corp Billing", "billing@acme.example")),
        ..message(
            ("Stripe", "invoices@stripe.com"),
            "Invoice #1042 from Acme Corp",
        )
    },
    FakeMessage {
        delivery_delay_minutes: 180,
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
        }
    }
}

fn generate(credentials: &MailCredentials) -> Vec<Generated> {
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
        "UPDATE accounts SET uid_validity = ?, watermark_uid = ?, last_open = ? WHERE id = ?",
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
    /// The formatted message as sent (without a Bcc header).
    pub raw: String,
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
        let generated = generate(credentials)
            .into_iter()
            .find(|g| g.uid == uid)
            .ok_or_else(|| AppError::NotFound("Message not found".into()))?;
        let message = generated.message;
        Ok(FullEmail {
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
            body_html: Some(format!(
                "<h2>{subject}</h2><p>This is a generated message from the demo mailbox.</p>\
                 <ul><li>Sender: {name}</li><li>UID: {uid}</li></ul>\
                 <p>Read more at <a href=\"https://example.com/\">example.com</a>.</p>",
                subject = message.subject,
                name = generated.sender_name,
            )),
            body_text: None,
            message_id: Some(format!("{uid}.{UID_VALIDITY}@fake.inboxmax.invalid")),
        })
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
        let raw = String::from_utf8_lossy(&email.message(false)?.formatted()).into_owned();
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

    #[tokio::test]
    async fn sending_records_the_message_as_it_would_go_out() {
        let account = connected("outbox-test@example.com");
        let receipt = mailbox::send(
            &FakeMailFetcher,
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
    }

    #[tokio::test]
    async fn a_refused_recipient_fails_the_send_and_nothing_is_recorded() {
        let account = connected("refused-test@example.com");
        let error = mailbox::send(
            &FakeMailFetcher,
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
    }

    #[tokio::test]
    async fn read_only_mail_clients_refuse_to_send() {
        let error = mailbox::send(
            &Unreachable,
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
