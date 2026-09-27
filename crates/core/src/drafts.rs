//! Drafts: the compose form's state, saved as the user types so closing a
//! message (or the app) never loses it. The content is the client's JSON;
//! the list shows the recipients and subject it contains.

use crate::error::{AppError, AppResult};
use crate::imap_client::MailAddress;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;

/// A draft may hold as much as a message can send (its attachments are in
/// the content), with room for the text.
pub const MAX_DRAFT_BYTES: usize = crate::outgoing::MAX_ATTACHMENT_BYTES / 3 * 4 + 2 * 1024 * 1024;

/// A draft as the list shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DraftSummary {
    pub id: String,
    pub subject: String,
    pub to: Vec<MailAddress>,
    /// Unix seconds.
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Draft {
    pub id: String,
    pub content: Value,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct SaveDraft {
    pub content: Value,
}

/// Drafts are named by the client (a UUID), so saving is idempotent.
fn check_id(id: &str) -> AppResult<()> {
    let valid = id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if valid {
        Ok(())
    } else {
        Err(AppError::BadRequest("Invalid draft id".into()))
    }
}

fn summary(id: String, content: &str, updated_at: i64) -> DraftSummary {
    let content: Value = serde_json::from_str(content).unwrap_or(Value::Null);
    DraftSummary {
        id,
        subject: content["subject"].as_str().unwrap_or_default().to_string(),
        to: serde_json::from_value(content["to"].clone()).unwrap_or_default(),
        updated_at,
    }
}

/// The mailbox's drafts, most recently changed first.
pub async fn list(db: &SqlitePool, account_id: &str) -> AppResult<Vec<DraftSummary>> {
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT id, content, updated_at FROM drafts
         WHERE account_id = ? ORDER BY updated_at DESC, rowid DESC",
    )
    .bind(account_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, content, updated_at)| summary(id, &content, updated_at))
        .collect())
}

pub async fn get(db: &SqlitePool, account_id: &str, id: &str) -> AppResult<Draft> {
    check_id(id)?;
    let (content, updated_at): (String, i64) =
        sqlx::query_as("SELECT content, updated_at FROM drafts WHERE id = ? AND account_id = ?")
            .bind(id)
            .bind(account_id)
            .fetch_optional(db)
            .await?
            .ok_or_else(|| AppError::NotFound("Draft not found".into()))?;
    Ok(Draft {
        id: id.to_string(),
        content: serde_json::from_str(&content)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("Unreadable draft {id}: {e}")))?,
        updated_at,
    })
}

/// Create or replace a draft. A draft id already used by another mailbox is
/// refused rather than moved.
pub async fn save(
    db: &SqlitePool,
    account_id: &str,
    id: &str,
    content: &Value,
) -> AppResult<DraftSummary> {
    check_id(id)?;
    if !content.is_object() {
        return Err(AppError::BadRequest("A draft must be an object".into()));
    }
    let text = content.to_string();
    if text.len() > MAX_DRAFT_BYTES {
        return Err(AppError::BadRequest(
            "The draft is too large to save".into(),
        ));
    }
    let saved: Option<i64> = sqlx::query_scalar(
        "INSERT INTO drafts (id, account_id, content, updated_at) VALUES (?, ?, ?, unixepoch())
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
         WHERE drafts.account_id = excluded.account_id
         RETURNING updated_at",
    )
    .bind(id)
    .bind(account_id)
    .bind(&text)
    .fetch_optional(db)
    .await?;
    let updated_at =
        saved.ok_or_else(|| AppError::Conflict("This draft belongs to another mailbox".into()))?;
    Ok(summary(id.to_string(), &text, updated_at))
}

/// Remove a draft. Removing one that is already gone is fine (a sent
/// message's draft, deleted twice).
pub async fn delete(db: &SqlitePool, account_id: &str, id: &str) -> AppResult<()> {
    check_id(id)?;
    sqlx::query("DELETE FROM drafts WHERE id = ? AND account_id = ?")
        .bind(id)
        .bind(account_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Remove every draft of a mailbox (the demo starting over).
pub async fn delete_all(db: &SqlitePool, account_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM drafts WHERE account_id = ?")
        .bind(account_id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";

    async fn db() -> SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::MIGRATOR.run(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, email, password_hash) VALUES ('u', 'u@x.example', '!')",
        )
        .execute(&db)
        .await
        .unwrap();
        for account in ["work", "home"] {
            sqlx::query(
                "INSERT INTO accounts (id, email, imap_host, smtp_host, user_id)
                 VALUES (?, ?, 'imap.x.example', 'smtp.x.example', 'u')",
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
    async fn saves_lists_updates_and_deletes() {
        let db = db().await;
        let first = json!({ "subject": "Plans", "to": [{ "name": "Sarah", "email": "s@x.example" }], "body": "Hi" });
        save(&db, "work", A, &first).await.unwrap();
        save(&db, "work", B, &json!({ "body": "no subject yet" }))
            .await
            .unwrap();

        let listed = list(&db, "work").await.unwrap();
        assert_eq!(listed.len(), 2);
        let plans = listed.iter().find(|d| d.id == A).unwrap();
        assert_eq!(plans.subject, "Plans");
        assert_eq!(plans.to, [MailAddress::new(Some("Sarah"), "s@x.example")]);
        assert!(list(&db, "home").await.unwrap().is_empty(), "per mailbox");

        save(
            &db,
            "work",
            A,
            &json!({ "subject": "Plans v2", "body": "Hi again" }),
        )
        .await
        .unwrap();
        let draft = get(&db, "work", A).await.unwrap();
        assert_eq!(draft.content["body"], "Hi again");
        assert_eq!(
            list(&db, "work").await.unwrap().len(),
            2,
            "replaced, not added"
        );

        delete(&db, "work", A).await.unwrap();
        delete(&db, "work", A).await.unwrap();
        assert!(matches!(
            get(&db, "work", A).await,
            Err(AppError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn a_draft_stays_with_its_mailbox() {
        let db = db().await;
        save(&db, "work", A, &json!({ "body": "work" }))
            .await
            .unwrap();
        assert!(matches!(
            save(&db, "home", A, &json!({ "body": "hijack" })).await,
            Err(AppError::Conflict(_))
        ));
        assert!(matches!(
            get(&db, "home", A).await,
            Err(AppError::NotFound(_))
        ));
        delete(&db, "home", A).await.unwrap();
        assert_eq!(get(&db, "work", A).await.unwrap().content["body"], "work");

        // Removing the mailbox removes its drafts.
        sqlx::query("DELETE FROM accounts WHERE id = 'work'")
            .execute(&db)
            .await
            .unwrap();
        assert!(list(&db, "work").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn refuses_bad_ids_and_content() {
        let db = db().await;
        assert!(save(&db, "work", "../x", &json!({})).await.is_err());
        assert!(save(&db, "work", A, &json!("text")).await.is_err());
        let huge = json!({ "body": "x".repeat(MAX_DRAFT_BYTES) });
        assert_eq!(
            save(&db, "work", A, &huge).await.unwrap_err().to_string(),
            "The draft is too large to save"
        );
    }
}
