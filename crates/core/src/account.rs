//! Mail accounts: normalizing addresses, verifying and saving IMAP
//! connections, and listing or removing the accounts a user owns.

use crate::config::{DEFAULT_SMTP_PORT, detect_provider, guess_provider};
use crate::error::{AppError, AppResult};
use crate::imap_client::{MailCredentials, MailFetcher, SmtpServer};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// A mail account whose password is currently available.
#[derive(Clone)]
pub struct ConnectedAccount {
    pub id: String,
    pub email: String,
    pub password: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp: SmtpServer,
}

impl ConnectedAccount {
    pub fn mail_credentials(&self) -> MailCredentials {
        MailCredentials {
            host: self.imap_host.clone(),
            port: self.imap_port,
            email: self.email.clone(),
            password: self.password.clone(),
        }
    }
}

/// A stored account, whether or not its password is available right now.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AccountRecord {
    pub id: String,
    pub email: String,
    pub imap_host: String,
    pub imap_port: i64,
    /// Empty for accounts saved before sending existed.
    pub smtp_host: String,
    pub smtp_port: i64,
}

impl AccountRecord {
    /// The account, usable now that its password is known.
    pub fn connected(self, password: String) -> ConnectedAccount {
        let smtp = stored_smtp_server(&self.email, &self.smtp_host, self.smtp_port);
        ConnectedAccount {
            imap_port: u16::try_from(self.imap_port).unwrap_or(993),
            id: self.id,
            email: self.email,
            password,
            imap_host: self.imap_host,
            smtp,
        }
    }
}

/// The saved SMTP server, or for accounts saved before sending existed, the
/// provider's (or a guess from the domain).
fn stored_smtp_server(email: &str, host: &str, port: i64) -> SmtpServer {
    if !host.is_empty() {
        return SmtpServer {
            host: host.to_string(),
            port: u16::try_from(port)
                .ok()
                .filter(|p| *p != 0)
                .unwrap_or(DEFAULT_SMTP_PORT),
        };
    }
    detect_provider(email)
        .or_else(|| guess_provider(email))
        .map(|provider| SmtpServer {
            host: provider.smtp_host,
            port: provider.smtp_port,
        })
        .unwrap_or(SmtpServer {
            host: String::new(),
            port: DEFAULT_SMTP_PORT,
        })
}

/// An account as shown to the client.
#[derive(Debug, Clone, Serialize)]
pub struct AccountStatus {
    pub id: String,
    pub email: String,
    /// The password is available, so the mailbox can be read.
    pub connected: bool,
    /// The password is stored on this device (desktop keychain) and will
    /// survive a restart.
    pub password_saved: bool,
}

#[derive(Default, Deserialize)]
pub struct ConnectRequest {
    pub email: String,
    pub password: String,
    pub imap_host: Option<String>,
    pub imap_port: Option<u16>,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<u16>,
}

/// Where a connect request's mailbox lives, worked out without contacting it.
pub struct Connection {
    pub credentials: MailCredentials,
    pub smtp: SmtpServer,
    /// Settings came from a recognized provider rather than a guess or override.
    pub provider_detected: bool,
}

/// Reply to a successful connect, from both the web API and desktop IPC.
#[derive(Serialize)]
pub struct ConnectResponse {
    pub account: AccountStatus,
    /// Settings came from a recognized provider rather than a guess or override.
    pub provider_detected: bool,
}

pub struct ConnectOutcome {
    pub account: ConnectedAccount,
    /// Settings came from a recognized provider rather than a guess or override.
    pub provider_detected: bool,
}

/// Lower-case and sanity-check an email address.
pub fn normalize_email(input: &str) -> AppResult<String> {
    let email = input.trim().to_lowercase();
    let Some((local, domain)) = email.split_once('@') else {
        return Err(AppError::BadRequest("Invalid email address".into()));
    };
    if email.len() > 254
        || local.is_empty()
        || domain.is_empty()
        || domain.contains('@')
        || email.chars().any(char::is_whitespace)
    {
        return Err(AppError::BadRequest("Invalid email address".into()));
    }
    Ok(email)
}

fn custom_host(host: Option<&str>) -> Option<String> {
    host.map(str::trim)
        .filter(|host| !host.is_empty())
        .map(str::to_lowercase)
}

/// Work out the IMAP and SMTP servers for a connect request (explicit
/// overrides, known provider, or `imap.`/`smtp.<domain>`) without contacting them.
pub fn resolve_connection(req: ConnectRequest) -> AppResult<Connection> {
    let email = normalize_email(&req.email)?;
    let imap_host = custom_host(req.imap_host.as_deref());
    let smtp_host = custom_host(req.smtp_host.as_deref());
    let detected_provider = detect_provider(&email);
    let provider_detected =
        detected_provider.is_some() && imap_host.is_none() && smtp_host.is_none();
    let provider = detected_provider
        .or_else(|| guess_provider(&email))
        .ok_or_else(|| AppError::BadRequest("Unable to determine IMAP host".into()))?;
    let imap_port = req.imap_port.unwrap_or(provider.imap_port);
    if imap_port == 0 {
        return Err(AppError::BadRequest("Invalid IMAP port".into()));
    }
    let smtp_port = req.smtp_port.unwrap_or(provider.smtp_port);
    if smtp_port == 0 {
        return Err(AppError::BadRequest("Invalid SMTP port".into()));
    }
    Ok(Connection {
        credentials: MailCredentials {
            host: imap_host.unwrap_or(provider.imap_host),
            port: imap_port,
            email,
            password: req.password,
        },
        smtp: SmtpServer {
            host: smtp_host.unwrap_or(provider.smtp_host),
            port: smtp_port,
        },
        provider_detected,
    })
}

/// Verify credentials against the mail server and save the account for
/// `owner_user_id`. Reconnecting keeps the account's inbox state.
pub async fn connect_account(
    db: &SqlitePool,
    mail: &dyn MailFetcher,
    owner_user_id: &str,
    req: ConnectRequest,
) -> AppResult<ConnectOutcome> {
    let Connection {
        credentials,
        smtp,
        provider_detected,
    } = resolve_connection(req)?;
    mail.verify_credentials(&credentials).await?;
    let id = save_account(db, owner_user_id, &credentials, &smtp).await?;
    Ok(ConnectOutcome {
        account: ConnectedAccount {
            id,
            email: credentials.email,
            password: credentials.password,
            imap_host: credentials.host,
            imap_port: credentials.port,
            smtp,
        },
        provider_detected,
    })
}

/// Insert or update the account row and return its id. Fails with Conflict
/// if the mailbox already belongs to a different user.
pub async fn save_account(
    db: &SqlitePool,
    owner_user_id: &str,
    credentials: &MailCredentials,
    smtp: &SmtpServer,
) -> AppResult<String> {
    // The conditional upsert makes ownership enforcement atomic.
    let result = sqlx::query(
        "INSERT INTO accounts (id, email, imap_host, imap_port, smtp_host, smtp_port, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET
           imap_host = excluded.imap_host,
           imap_port = excluded.imap_port,
           smtp_host = excluded.smtp_host,
           smtp_port = excluded.smtp_port,
           user_id = excluded.user_id
         WHERE accounts.user_id IS NULL OR accounts.user_id = excluded.user_id",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&credentials.email)
    .bind(&credentials.host)
    .bind(i64::from(credentials.port))
    .bind(&smtp.host)
    .bind(i64::from(smtp.port))
    .bind(owner_user_id)
    .execute(db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::Conflict(
            "This email account is already linked to a different user".into(),
        ));
    }

    let (id,): (String,) = sqlx::query_as("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE")
        .bind(&credentials.email)
        .fetch_one(db)
        .await?;
    Ok(id)
}

/// Accounts owned by a user, in the order they were added.
pub async fn list_accounts(db: &SqlitePool, owner_user_id: &str) -> AppResult<Vec<AccountRecord>> {
    Ok(sqlx::query_as(
        "SELECT id, email, imap_host, imap_port, smtp_host, smtp_port FROM accounts
         WHERE user_id = ? ORDER BY created_at, rowid",
    )
    .bind(owner_user_id)
    .fetch_all(db)
    .await?)
}

/// Look up one of a user's accounts.
pub async fn find_account(
    db: &SqlitePool,
    owner_user_id: &str,
    account_id: &str,
) -> AppResult<AccountRecord> {
    sqlx::query_as(
        "SELECT id, email, imap_host, imap_port, smtp_host, smtp_port FROM accounts WHERE id = ? AND user_id = ?",
    )
    .bind(account_id)
    .bind(owner_user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound("Account not found".into()))
}

/// Delete one of a user's accounts along with its remembered emails and
/// inbox state.
pub async fn delete_account(
    db: &SqlitePool,
    owner_user_id: &str,
    account_id: &str,
) -> AppResult<()> {
    let result = sqlx::query("DELETE FROM accounts WHERE id = ? AND user_id = ?")
        .bind(account_id)
        .bind(owner_user_id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Account not found".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{AccountRecord, ConnectRequest, normalize_email, resolve_connection};
    use crate::imap_client::SmtpServer;

    fn request(email: &str, host: Option<&str>) -> ConnectRequest {
        ConnectRequest {
            email: email.into(),
            password: "secret".into(),
            imap_host: host.map(Into::into),
            ..ConnectRequest::default()
        }
    }

    fn smtp(host: &str, port: u16) -> SmtpServer {
        SmtpServer {
            host: host.into(),
            port,
        }
    }

    #[test]
    fn normalizes_and_rejects_addresses() {
        assert_eq!(
            normalize_email("  Ada@Example.COM ").unwrap(),
            "ada@example.com"
        );
        for bad in ["", "no-at-sign", "@example.com", "a@", "a@b@c", "a b@c.com"] {
            assert!(normalize_email(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn resolves_known_guessed_and_overridden_hosts() {
        let known = resolve_connection(request("me@gmail.com", None)).unwrap();
        assert_eq!(known.credentials.host, "imap.gmail.com");
        assert_eq!(known.smtp, smtp("smtp.gmail.com", 587));
        assert!(known.provider_detected);

        let guessed = resolve_connection(request("me@example.com", None)).unwrap();
        assert_eq!(guessed.credentials.host, "imap.example.com");
        assert_eq!(guessed.smtp, smtp("smtp.example.com", 587));
        assert!(!guessed.provider_detected);

        // A blank override is ignored rather than treated as a custom host.
        let blank = resolve_connection(request("me@gmail.com", Some("  "))).unwrap();
        assert_eq!(blank.credentials.host, "imap.gmail.com");
        assert!(blank.provider_detected);

        let custom =
            resolve_connection(request("me@gmail.com", Some(" IMAP.Custom.test "))).unwrap();
        assert_eq!(custom.credentials.host, "imap.custom.test");
        assert!(!custom.provider_detected);

        let custom_smtp = resolve_connection(ConnectRequest {
            smtp_host: Some(" Mail.Custom.test ".into()),
            smtp_port: Some(465),
            ..request("me@gmail.com", None)
        })
        .unwrap();
        assert_eq!(custom_smtp.credentials.host, "imap.gmail.com");
        assert_eq!(custom_smtp.smtp, smtp("mail.custom.test", 465));
        assert!(!custom_smtp.provider_detected);

        assert!(
            resolve_connection(ConnectRequest {
                smtp_port: Some(0),
                ..request("me@gmail.com", None)
            })
            .is_err()
        );
    }

    #[test]
    fn accounts_saved_before_sending_existed_get_the_providers_smtp_server() {
        let record = |email: &str, host: &str, port: i64| AccountRecord {
            id: "a".into(),
            email: email.into(),
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            smtp_host: host.into(),
            smtp_port: port,
        };
        let legacy = record("me@icloud.com", "", 0).connected("pw".into());
        assert_eq!(legacy.smtp, smtp("smtp.mail.me.com", 587));
        let guessed = record("me@example.com", "", 0).connected("pw".into());
        assert_eq!(guessed.smtp, smtp("smtp.example.com", 587));
        let saved = record("me@example.com", "mail.example.com", 465).connected("pw".into());
        assert_eq!(saved.smtp, smtp("mail.example.com", 465));
    }
}
