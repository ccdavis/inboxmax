use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// App-level user (from registration / device cookie).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSession {
    pub user_id: String,
    pub email: String,
    pub display_name: Option<String>,
}

/// IMAP account connection (temporary, in-memory).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionAccount {
    pub id: String,
    pub email: String,
    pub password: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
}

/// Full session: optional user + optional IMAP connection.
#[derive(Debug, Clone)]
pub struct Session {
    pub user: Option<UserSession>,
    pub account: Option<SessionAccount>,
}

/// Simple in-memory session store keyed by token.
#[derive(Debug, Clone)]
pub struct SessionStore {
    sessions: Arc<RwLock<HashMap<String, Session>>>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn set_user(&self, token: &str, user: UserSession) {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .entry(token.to_string())
            .or_insert_with(|| Session {
                user: None,
                account: None,
            });
        session.user = Some(user);
    }

    pub async fn set_account(&self, token: &str, account: SessionAccount) {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .entry(token.to_string())
            .or_insert_with(|| Session {
                user: None,
                account: None,
            });
        session.account = Some(account);
    }

    pub async fn get_user(&self, token: &str) -> Option<UserSession> {
        self.sessions
            .read()
            .await
            .get(token)
            .and_then(|s| s.user.clone())
    }

    pub async fn get_account(&self, token: &str) -> Option<SessionAccount> {
        self.sessions
            .read()
            .await
            .get(token)
            .and_then(|s| s.account.clone())
    }

    pub async fn remove(&self, token: &str) {
        self.sessions.write().await.remove(token);
    }
}

// Device token helpers — we hash tokens before storing in the DB.
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

/// Create a device token row in the DB. Returns the raw token (not hashed).
pub async fn create_device_token(db: &SqlitePool, user_id: &str) -> Result<String, sqlx::Error> {
    let raw_token = uuid::Uuid::new_v4().to_string();
    let token_id = uuid::Uuid::new_v4().to_string();
    let hashed = hash_token(&raw_token);

    sqlx::query("INSERT INTO device_tokens (id, user_id, token_hash) VALUES (?, ?, ?)")
        .bind(&token_id)
        .bind(user_id)
        .bind(&hashed)
        .execute(db)
        .await?;

    Ok(raw_token)
}

/// Look up a device token and return the associated user. Updates last_used.
pub async fn validate_device_token(
    db: &SqlitePool,
    raw_token: &str,
) -> Result<Option<UserSession>, sqlx::Error> {
    let hashed = hash_token(raw_token);

    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT u.id, u.email, u.display_name
         FROM device_tokens dt
         JOIN users u ON u.id = dt.user_id
         WHERE dt.token_hash = ?",
    )
    .bind(&hashed)
    .fetch_optional(db)
    .await?;

    if let Some((user_id, email, display_name)) = row {
        // Update last_used
        sqlx::query("UPDATE device_tokens SET last_used = unixepoch() WHERE token_hash = ?")
            .bind(&hashed)
            .execute(db)
            .await?;

        Ok(Some(UserSession {
            user_id,
            email,
            display_name,
        }))
    } else {
        Ok(None)
    }
}

/// Delete a device token (sign out).
pub async fn delete_device_token(db: &SqlitePool, raw_token: &str) -> Result<(), sqlx::Error> {
    let hashed = hash_token(raw_token);
    sqlx::query("DELETE FROM device_tokens WHERE token_hash = ?")
        .bind(&hashed)
        .execute(db)
        .await?;
    Ok(())
}

/// Keep only the N most recent device tokens for a user, delete the rest.
pub async fn cleanup_device_tokens(
    db: &SqlitePool,
    user_id: &str,
    keep: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM device_tokens WHERE user_id = ? AND id NOT IN (
            SELECT id FROM device_tokens WHERE user_id = ? ORDER BY last_used DESC LIMIT ?
        )",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(keep)
    .execute(db)
    .await?;
    Ok(())
}
