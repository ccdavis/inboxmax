//! Mail accounts: normalizing addresses, verifying and saving IMAP
//! connections, and listing or removing the accounts a user owns.

use crate::config::{detect_provider, guess_provider};
use crate::error::{AppError, AppResult};
use crate::imap_client::{MailCredentials, MailFetcher};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// A mail account whose IMAP password is currently available.
#[derive(Clone)]
pub struct ConnectedAccount {
    pub id: String,
    pub email: String,
    pub password: String,
    pub imap_host: String,
    pub imap_port: u16,
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

#[derive(Deserialize)]
pub struct ConnectRequest {
    pub email: String,
    pub password: String,
    pub imap_host: Option<String>,
    pub imap_port: Option<u16>,
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

/// Work out the IMAP server for a connect request (explicit override,
/// known provider, or `imap.<domain>`) without contacting it.
pub fn resolve_connection(req: ConnectRequest) -> AppResult<(MailCredentials, bool)> {
    let email = normalize_email(&req.email)?;
    let custom_host = req
        .imap_host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .map(str::to_lowercase);
    let detected_provider = detect_provider(&email);
    let provider_detected = detected_provider.is_some() && custom_host.is_none();
    let provider = detected_provider
        .or_else(|| guess_provider(&email))
        .ok_or_else(|| AppError::BadRequest("Unable to determine IMAP host".into()))?;
    let host = custom_host.unwrap_or(provider.imap_host);
    let port = req.imap_port.unwrap_or(provider.imap_port);
    if port == 0 {
        return Err(AppError::BadRequest("Invalid IMAP port".into()));
    }
    Ok((
        MailCredentials {
            host,
            port,
            email,
            password: req.password,
        },
        provider_detected,
    ))
}

/// Verify credentials against the mail server and save the account for
/// `owner_user_id`. Reconnecting keeps the account's inbox state.
pub async fn connect_account(
    db: &SqlitePool,
    mail: &dyn MailFetcher,
    owner_user_id: &str,
    req: ConnectRequest,
) -> AppResult<ConnectOutcome> {
    let (credentials, provider_detected) = resolve_connection(req)?;
    mail.verify_credentials(&credentials).await?;
    let id = save_account(db, owner_user_id, &credentials).await?;
    Ok(ConnectOutcome {
        account: ConnectedAccount {
            id,
            email: credentials.email,
            password: credentials.password,
            imap_host: credentials.host,
            imap_port: credentials.port,
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
) -> AppResult<String> {
    // The conditional upsert makes ownership enforcement atomic. The SMTP
    // columns are legacy schema fields retained for migration compatibility.
    let result = sqlx::query(
        "INSERT INTO accounts (id, email, imap_host, imap_port, smtp_host, smtp_port, user_id)
         VALUES (?, ?, ?, ?, '', 0, ?)
         ON CONFLICT DO UPDATE SET
           imap_host = excluded.imap_host,
           imap_port = excluded.imap_port,
           user_id = excluded.user_id
         WHERE accounts.user_id IS NULL OR accounts.user_id = excluded.user_id",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&credentials.email)
    .bind(&credentials.host)
    .bind(i64::from(credentials.port))
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
        "SELECT id, email, imap_host, imap_port FROM accounts
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
        "SELECT id, email, imap_host, imap_port FROM accounts WHERE id = ? AND user_id = ?",
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
    use super::{ConnectRequest, normalize_email, resolve_connection};

    fn request(email: &str, host: Option<&str>) -> ConnectRequest {
        ConnectRequest {
            email: email.into(),
            password: "secret".into(),
            imap_host: host.map(Into::into),
            imap_port: None,
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
        let (known, detected) = resolve_connection(request("me@gmail.com", None)).unwrap();
        assert_eq!((known.host.as_str(), detected), ("imap.gmail.com", true));

        let (guessed, detected) = resolve_connection(request("me@example.com", None)).unwrap();
        assert_eq!(
            (guessed.host.as_str(), detected),
            ("imap.example.com", false)
        );

        // A blank override is ignored rather than treated as a custom host.
        let (blank, detected) = resolve_connection(request("me@gmail.com", Some("  "))).unwrap();
        assert_eq!((blank.host.as_str(), detected), ("imap.gmail.com", true));

        let (custom, detected) =
            resolve_connection(request("me@gmail.com", Some(" IMAP.Custom.test "))).unwrap();
        assert_eq!(
            (custom.host.as_str(), detected),
            ("imap.custom.test", false)
        );
    }
}
