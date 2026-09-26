//! An in-process mailbox with generated messages, for demos, development
//! without an IMAP account, and end-to-end tests. Enabled with the
//! `fake-mail` feature and selected at runtime by `INBOXMAX_FAKE_MAIL=1`.

use crate::error::{AppError, AppResult};
use crate::imap_client::{EmailEnvelope, FullEmail, MailCredentials, MailFetcher, MailboxSnapshot};
use chrono::{Duration, NaiveDate, Utc};

/// Any password is accepted except this one, which simulates a rejected login.
pub const REJECTED_PASSWORD: &str = "wrong-password";

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
/// The mailbox login's domain is added to the senders so accounts differ.
pub struct FakeMailFetcher;

fn envelopes(credentials: &MailCredentials) -> Vec<EmailEnvelope> {
    let now = Utc::now();
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
            from: format!("{from} ({domain})"),
            date: Some(now - Duration::minutes(5 + i as i64 * 300)),
        })
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
            uid_validity: Some(1),
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
}
