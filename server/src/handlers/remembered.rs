use crate::error::AppResult;
use crate::handlers::auth::require_account;
use crate::AppState;
use axum::extract::{Path, State};
use axum::Json;
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
        "SELECT id, email_uid, subject, sender, date, added_at
         FROM remembered WHERE account_id = ? ORDER BY added_at DESC",
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

    sqlx::query(
        "INSERT OR IGNORE INTO remembered (account_id, email_uid, subject, sender, date)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&account.id)
    .bind(uid)
    .bind(&req.subject)
    .bind(&req.sender)
    .bind(req.date)
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

    sqlx::query("DELETE FROM remembered WHERE account_id = ? AND email_uid = ?")
        .bind(&account.id)
        .bind(uid)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}
