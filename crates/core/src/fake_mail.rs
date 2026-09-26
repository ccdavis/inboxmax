//! An in-process mailbox with generated messages, for demos, development
//! without an IMAP account, and end-to-end tests. Every build serves it to
//! the demo account (see [`WithDemoMailbox`]); builds with the `fake-mail`
//! feature also serve it to every account when `INBOXMAX_FAKE_MAIL=1`.

use crate::error::{AppError, AppResult};
use crate::imap_client::{EmailEnvelope, FullEmail, MailCredentials, MailFetcher, MailboxSnapshot};
use crate::mailbox::{self, RememberRequest};
use chrono::{Duration, NaiveDate, Utc};
use sqlx::SqlitePool;

/// The demo account, which people can open to try the app without a mail
/// account. `.invalid` names are reserved (RFC 2606), so no real mailbox or
/// IMAP server can have them.
pub const DEMO_EMAIL: &str = "demo@inboxmax.invalid";
pub const DEMO_HOST: &str = "demo.inboxmax.invalid";
/// The demo mailbox accepts any password; this is the one the app uses.
pub const DEMO_PASSWORD: &str = "demo";

/// Whether an account's IMAP host is the demo mailbox.
pub fn is_demo_host(host: &str) -> bool {
    host.eq_ignore_ascii_case(DEMO_HOST)
}

/// Any password is accepted except this one, which simulates a rejected login.
pub const REJECTED_PASSWORD: &str = "wrong-password";

const UID_VALIDITY: u32 = 1;

/// Where the demo starts: this many of the newest messages are unseen...
const DEMO_UNSEEN: usize = 4;
/// ...and these (by position, newest first) are remembered.
const DEMO_REMEMBERED: [usize; 2] = [7, 8];

const MESSAGES: &[(&str, &str)] = &[
    ("GitHub", "PR #47 merged: fix dashboard layout"),
    ("Amazon Web Services", "Your AWS billing summary"),
    ("Sarah Chen", "Quick question about the API spec"),
    ("Notion", "Team standup notes"),
    ("Google Calendar", "Invitation: Design review @ Wed 2pm"),
    ("Amazon", "Your order has shipped!"),
    ("Stripe", "Invoice #1042 from Acme Corp"),
    ("Delta Air Lines", "Flight confirmation - SFO to JFK"),
    ("Property Management", "Apartment lease renewal"),
    ("Café Olé", "Menü der Woche — Grüße aus der Küche"),
    ("Ada Lovelace", "Notes on the analytical engine"),
    ("Newsletter", "This week in Rust"),
];

/// Every generated mailbox: one message every five hours, newest first.
/// Outside the demo account, the mailbox login's domain is added to the
/// senders so accounts differ.
pub struct FakeMailFetcher;

fn envelopes(credentials: &MailCredentials) -> Vec<EmailEnvelope> {
    let now = Utc::now();
    let demo = is_demo_host(&credentials.host);
    let domain = credentials
        .email
        .rsplit('@')
        .next()
        .unwrap_or("example.com");
    MESSAGES
        .iter()
        .enumerate()
        .map(|(i, (from, subject))| EmailEnvelope {
            uid: 1000 - i as u32,
            subject: (*subject).to_string(),
            from: if demo {
                (*from).to_string()
            } else {
                format!("{from} ({domain})")
            },
            date: Some(now - Duration::minutes(5 + i as i64 * 300)),
        })
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

/// Serves the demo mailbox to accounts on [`DEMO_HOST`] and passes every
/// other account to the wrapped mail client.
pub struct WithDemoMailbox<F>(pub F);

impl<F: MailFetcher> WithDemoMailbox<F> {
    fn pick(&self, credentials: &MailCredentials) -> &dyn MailFetcher {
        if is_demo_host(&credentials.host) {
            &FakeMailFetcher
        } else {
            &self.0
        }
    }
}

#[async_trait::async_trait]
impl<F: MailFetcher> MailFetcher for WithDemoMailbox<F> {
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
        let envelope = envelopes(credentials)
            .into_iter()
            .find(|e| e.uid == uid)
            .ok_or_else(|| AppError::NotFound("Message not found".into()))?;
        Ok(FullEmail {
            uid,
            body_html: Some(format!(
                "<h2>{subject}</h2><p>This is a generated message from the demo mailbox.</p>\
                 <ul><li>Sender: {from}</li><li>UID: {uid}</li></ul>\
                 <p>Read more at <a href=\"https://example.com/\">example.com</a>.</p>",
                subject = envelope.subject,
                from = envelope.from,
            )),
            body_text: None,
            to: credentials.email.clone(),
            message_id: None,
            subject: envelope.subject,
            from: envelope.from,
            date: envelope.date,
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
        let mail = WithDemoMailbox(Unreachable);
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
                imap_port: None,
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
