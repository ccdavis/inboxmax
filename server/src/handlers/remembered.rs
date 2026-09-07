use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::handlers::auth::require_account;
use axum::Json;
use axum::extract::{Path, State};
use axum_extra::extract::CookieJar;
use serde::Serialize;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct RememberedEmail {
    pub id: i64,
    pub email_uid: i64,
    pub subject: Option<String>,
    pub sender: Option<String>,
    pub date: Option<i64>,
    pub added_at: i64,
}

pub async fn list_remembered(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<Vec<RememberedEmail>>> {
    let account = require_account(&state, &jar).await?;

    let rows = sqlx::query_as::<_, RememberedEmail>(
        "SELECT r.id, r.email_uid, r.subject, r.sender, r.date, r.added_at
         FROM remembered r
         JOIN accounts a ON a.id = r.account_id
         WHERE r.account_id = ? AND r.uid_validity = a.uid_validity
         ORDER BY r.added_at DESC",
    )
    .bind(&account.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

#[derive(serde::Deserialize)]
pub struct RememberRequest {
    pub subject: Option<String>,
    pub sender: Option<String>,
    pub date: Option<i64>,
}

pub async fn remember_email(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(uid): Path<i64>,
    Json(req): Json<RememberRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let account = require_account(&state, &jar).await?;

    if uid <= 0 || uid > i64::from(u32::MAX) {
        return Err(AppError::BadRequest("Invalid email UID".into()));
    }

    let uid_validity: Option<i64> =
        sqlx::query_scalar("SELECT uid_validity FROM accounts WHERE id = ?")
            .bind(&account.id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    let uid_validity = uid_validity.ok_or_else(|| {
        AppError::BadRequest("Mailbox must be refreshed before remembering messages".into())
    })?;

    sqlx::query(
        "INSERT INTO remembered
            (account_id, email_uid, subject, sender, date, uid_validity)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, email_uid) DO UPDATE SET
           subject = excluded.subject,
           sender = excluded.sender,
           date = excluded.date,
           uid_validity = excluded.uid_validity",
    )
    .bind(&account.id)
    .bind(uid)
    .bind(&req.subject)
    .bind(&req.sender)
    .bind(req.date)
    .bind(uid_validity)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn forget_email(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(uid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let account = require_account(&state, &jar).await?;

    if uid <= 0 || uid > i64::from(u32::MAX) {
        return Err(AppError::BadRequest("Invalid email UID".into()));
    }

    sqlx::query("DELETE FROM remembered WHERE account_id = ? AND email_uid = ?")
        .bind(&account.id)
        .bind(uid)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}
