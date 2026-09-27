//! A mailbox's signature: plain text the compose form adds below what the
//! user writes. It goes with the mailbox, so removing one removes it.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// Long enough for a name, title, phone numbers and a disclaimer.
pub const MAX_SIGNATURE_CHARS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signature {
    pub signature: String,
}

pub async fn get(db: &SqlitePool, account_id: &str) -> AppResult<Signature> {
    let (signature,): (String,) = sqlx::query_as("SELECT signature FROM accounts WHERE id = ?")
        .bind(account_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("Account not found".into()))?;
    Ok(Signature { signature })
}

/// Save the signature, with line endings made plain and trailing blank
/// space dropped; an empty one means none.
pub async fn set(db: &SqlitePool, account_id: &str, signature: &str) -> AppResult<Signature> {
    let signature = signature.replace("\r\n", "\n").replace('\r', "\n");
    let signature = signature.trim_end().to_string();
    if signature.chars().count() > MAX_SIGNATURE_CHARS {
        return Err(AppError::BadRequest(format!(
            "A signature can be at most {MAX_SIGNATURE_CHARS} characters"
        )));
    }
    let result = sqlx::query("UPDATE accounts SET signature = ? WHERE id = ?")
        .bind(&signature)
        .bind(account_id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Account not found".into()));
    }
    Ok(Signature { signature })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::MIGRATOR.run(&db).await.unwrap();
        for account in ["work", "home"] {
            sqlx::query(
                "INSERT INTO accounts (id, email, imap_host, smtp_host)
                 VALUES (?, ?, 'imap.x.example', 'smtp.x.example')",
            )
            .bind(account)
            .bind(format!("{account}@x.example"))
            .execute(&db)
            .await
            .unwrap();
        }
        db
    }

    #[tokio::test]
    async fn each_mailbox_has_its_own_signature() {
        let db = db().await;
        assert_eq!(get(&db, "work").await.unwrap().signature, "");

        let saved = set(&db, "work", "Ada Lovelace\r\nAnalyst\r\n\r\n  ")
            .await
            .unwrap();
        assert_eq!(saved.signature, "Ada Lovelace\nAnalyst");
        assert_eq!(get(&db, "work").await.unwrap(), saved);
        assert_eq!(get(&db, "home").await.unwrap().signature, "");

        set(&db, "work", "").await.unwrap();
        assert_eq!(get(&db, "work").await.unwrap().signature, "");
    }

    #[tokio::test]
    async fn refuses_an_overlong_signature_and_unknown_mailboxes() {
        let db = db().await;
        let long = "é".repeat(MAX_SIGNATURE_CHARS + 1);
        assert!(matches!(
            set(&db, "work", &long).await,
            Err(AppError::BadRequest(_))
        ));
        // Characters, not bytes, are counted.
        set(&db, "work", &"é".repeat(MAX_SIGNATURE_CHARS))
            .await
            .unwrap();
        assert!(matches!(
            set(&db, "nobody", "x").await,
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            get(&db, "nobody").await,
            Err(AppError::NotFound(_))
        ));
    }
}
