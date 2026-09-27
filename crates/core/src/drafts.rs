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
pub const MAX_DRAFT_BYTES: usize = crate::outgoing::MAX_ATTACHMENT_BYTES / 3 * 4 + 4 * 1024 * 1024;
/// Drafts a mailbox can keep, and how much they can hold in all.
pub const MAX_DRAFTS: i64 = 100;
pub const MAX_DRAFTS_TOTAL_BYTES: i64 = 200 * 1024 * 1024;

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

fn summary(id: String, content: &Value, updated_at: i64) -> DraftSummary {
    DraftSummary {
        id,
        subject: content["subject"].as_str().unwrap_or_default().to_string(),
        to: serde_json::from_value(content["to"].clone()).unwrap_or_default(),
        updated_at,
    }
}

/// The mailbox's drafts, most recently changed first.
pub async fn list(db: &SqlitePool, account_id: &str) -> AppResult<Vec<DraftSummary>> {
    // Only the subject and recipients, not the whole (attachment-laden) drafts.
    let rows: Vec<(String, Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT id,
                CASE json_type(content, '$.subject') WHEN 'text' THEN json_extract(content, '$.subject') END,
                CASE json_type(content, '$.to') WHEN 'array' THEN json_extract(content, '$.to') END,
                updated_at
         FROM drafts
         WHERE account_id = ? ORDER BY updated_at DESC, rowid DESC",
    )
    .bind(account_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, subject, to, updated_at)| DraftSummary {
            id,
            subject: subject.unwrap_or_default(),
            to: to
                .and_then(|to| serde_json::from_str(&to).ok())
                .unwrap_or_default(),
            updated_at,
        })
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

/// Create or replace a draft, within the mailbox's quota. A draft id already
/// used by another mailbox is refused (as not found) rather than moved.
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
    // Room for this one among the mailbox's other drafts.
    let (others, others_bytes): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(length(CAST(content AS BLOB))), 0) FROM drafts
         WHERE account_id = ? AND id != ?",
    )
    .bind(account_id)
    .bind(id)
    .fetch_one(db)
    .await?;
    if others >= MAX_DRAFTS || others_bytes + text.len() as i64 > MAX_DRAFTS_TOTAL_BYTES {
        return Err(AppError::BadRequest(
            "There are too many drafts to save another: send or discard some".into(),
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
    // The id belongs to another mailbox; saying so would tell that it exists.
    let updated_at = saved.ok_or_else(|| AppError::NotFound("Draft not found".into()))?;
    Ok(summary(id.to_string(), content, updated_at))
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
            Err(AppError::NotFound(_))
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

    #[tokio::test]
    async fn a_mailbox_keeps_only_so_many_drafts() {
        let db = db().await;
        let id = |n: i64| format!("{n:08x}-0000-4000-8000-000000000000");
        for n in 0..MAX_DRAFTS {
            save(&db, "work", &id(n), &json!({ "subject": format!("#{n}") }))
                .await
                .unwrap();
        }
        assert!(matches!(
            save(&db, "work", &id(MAX_DRAFTS), &json!({})).await,
            Err(AppError::BadRequest(_))
        ));
        // Changing one it has is fine, and so is another mailbox.
        save(&db, "work", &id(0), &json!({ "subject": "changed" }))
            .await
            .unwrap();
        save(&db, "home", &id(MAX_DRAFTS), &json!({}))
            .await
            .unwrap();

        let listed = list(&db, "work").await.unwrap();
        assert_eq!(listed.len() as i64, MAX_DRAFTS);
        assert!(listed.iter().any(|d| d.subject == "changed"));
        // Odd content lists as blank rather than failing.
        save(&db, "home", A, &json!({ "subject": 5, "to": "x" }))
            .await
            .unwrap();
        let home = list(&db, "home").await.unwrap();
        let odd = home.iter().find(|d| d.id == A).unwrap();
        assert_eq!((odd.subject.as_str(), odd.to.len()), ("", 0));
    }
}
