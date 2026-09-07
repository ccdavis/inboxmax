use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const DEFAULT_SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const DEFAULT_MAX_SESSIONS: usize = 10_000;
const DEVICE_TOKEN_LIFETIME_SECONDS: i64 = 30 * 24 * 60 * 60;

/// App-level user (from registration / device cookie).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSession {
    pub user_id: String,
    pub email: String,
    pub display_name: Option<String>,
}

/// IMAP account connection (temporary, in-memory).
#[derive(Clone)]
pub struct SessionAccount {
    pub id: String,
    pub email: String,
    pub password: String,
    pub imap_host: String,
    pub imap_port: u16,
}

impl SessionAccount {
    pub fn mail_credentials(&self) -> crate::imap_client::MailCredentials {
        crate::imap_client::MailCredentials {
            host: self.imap_host.clone(),
            port: self.imap_port,
            email: self.email.clone(),
            password: self.password.clone(),
        }
    }
}

/// Full session: optional user + optional IMAP connection.
#[derive(Clone)]
pub struct Session {
    pub user: Option<UserSession>,
    pub account: Option<SessionAccount>,
}

/// Simple in-memory session store keyed by token.
struct StoredSession {
    session: Session,
    last_used: Instant,
}

#[derive(Clone)]
pub struct SessionStore {
    sessions: Arc<RwLock<HashMap<String, StoredSession>>>,
    ttl: Duration,
    max_sessions: usize,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::with_limits(DEFAULT_SESSION_TTL, DEFAULT_MAX_SESSIONS)
    }

    pub fn with_limits(ttl: Duration, max_sessions: usize) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            ttl,
            max_sessions: max_sessions.max(1),
        }
    }

    pub async fn set_user(&self, token: &str, user: UserSession) {
        let mut sessions = self.sessions.write().await;
        Self::prune(&mut sessions, self.ttl);
        let stored = sessions
            .entry(token.to_string())
            .or_insert_with(|| StoredSession {
                session: Session {
                    user: None,
                    account: None,
                },
                last_used: Instant::now(),
            });
        stored.session.user = Some(user);
        stored.last_used = Instant::now();
        Self::enforce_capacity(&mut sessions, self.max_sessions);
    }

    pub async fn set_account(&self, token: &str, account: SessionAccount) {
        let mut sessions = self.sessions.write().await;
        Self::prune(&mut sessions, self.ttl);
        let stored = sessions
            .entry(token.to_string())
            .or_insert_with(|| StoredSession {
                session: Session {
                    user: None,
                    account: None,
                },
                last_used: Instant::now(),
            });
        stored.session.account = Some(account);
        stored.last_used = Instant::now();
        Self::enforce_capacity(&mut sessions, self.max_sessions);
    }

    pub async fn get_user(&self, token: &str) -> Option<UserSession> {
        let mut sessions = self.sessions.write().await;
        Self::get_valid(&mut sessions, token, self.ttl).and_then(|s| s.user.clone())
    }

    pub async fn get_account(&self, token: &str) -> Option<SessionAccount> {
        let mut sessions = self.sessions.write().await;
        Self::get_valid(&mut sessions, token, self.ttl).and_then(|s| s.account.clone())
    }

    pub async fn remove(&self, token: &str) {
        self.sessions.write().await.remove(token);
    }

    fn get_valid<'a>(
        sessions: &'a mut HashMap<String, StoredSession>,
        token: &str,
        ttl: Duration,
    ) -> Option<&'a Session> {
        let expired = sessions
            .get(token)
            .is_some_and(|stored| stored.last_used.elapsed() >= ttl);
        if expired {
            sessions.remove(token);
            return None;
        }
        let stored = sessions.get_mut(token)?;
        stored.last_used = Instant::now();
        Some(&stored.session)
    }

    fn prune(sessions: &mut HashMap<String, StoredSession>, ttl: Duration) {
        sessions.retain(|_, stored| stored.last_used.elapsed() < ttl);
    }

    fn enforce_capacity(sessions: &mut HashMap<String, StoredSession>, max_sessions: usize) {
        while sessions.len() > max_sessions {
            let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, stored)| stored.last_used)
                .map(|(token, _)| token.clone())
            else {
                break;
            };
            sessions.remove(&oldest);
        }
    }
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
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
         WHERE dt.token_hash = ?
           AND dt.created_at >= unixepoch() - ?",
    )
    .bind(&hashed)
    .bind(DEVICE_TOKEN_LIFETIME_SECONDS)
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
    sqlx::query("DELETE FROM device_tokens WHERE created_at < unixepoch() - ?")
        .bind(DEVICE_TOKEN_LIFETIME_SECONDS)
        .execute(db)
        .await?;

    sqlx::query(
        "DELETE FROM device_tokens WHERE user_id = ? AND id NOT IN (
            SELECT id FROM device_tokens WHERE user_id = ?
            ORDER BY last_used DESC, created_at DESC LIMIT ?
        )",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(keep)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        SessionStore, UserSession, cleanup_device_tokens, create_device_token, hash_token,
        validate_device_token,
    };
    use sqlx::sqlite::SqlitePoolOptions;
    use std::time::Duration;

    fn user(id: &str) -> UserSession {
        UserSession {
            user_id: id.into(),
            email: format!("{id}@example.com"),
            display_name: None,
        }
    }

    #[tokio::test]
    async fn expired_sessions_are_removed() {
        let store = SessionStore::with_limits(Duration::ZERO, 10);
        store.set_user("token", user("one")).await;
        assert!(store.get_user("token").await.is_none());
    }

    #[tokio::test]
    async fn capacity_evicts_an_old_session() {
        let store = SessionStore::with_limits(Duration::from_secs(60), 1);
        store.set_user("old", user("one")).await;
        tokio::task::yield_now().await;
        store.set_user("new", user("two")).await;
        assert!(store.get_user("old").await.is_none());
        assert_eq!(store.get_user("new").await.unwrap().user_id, "two");
    }

    async fn token_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, email, password_hash) VALUES ('user', 'u@example.com', 'x')",
        )
        .execute(&db)
        .await
        .unwrap();
        db
    }

    #[tokio::test]
    async fn expired_device_tokens_are_rejected() {
        let db = token_db().await;
        let token = create_device_token(&db, "user").await.unwrap();
        sqlx::query("UPDATE device_tokens SET created_at = 0 WHERE token_hash = ?")
            .bind(hash_token(&token))
            .execute(&db)
            .await
            .unwrap();

        assert!(validate_device_token(&db, &token).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn device_token_cleanup_honors_the_requested_limit() {
        let db = token_db().await;
        for _ in 0..12 {
            create_device_token(&db, "user").await.unwrap();
        }
        cleanup_device_tokens(&db, "user", 10).await.unwrap();

        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM device_tokens WHERE user_id = 'user'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(count, 10);
    }
}
