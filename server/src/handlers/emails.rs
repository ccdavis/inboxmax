use crate::AppState;
use crate::error::AppResult;
use crate::handlers::auth::require_account;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum_extra::extract::CookieJar;
use inboxmax_core::imap_client::{EmailEnvelope, FullEmail};
use inboxmax_core::mailbox::{self, EmailListResponse};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ListQuery {
    pub since: Option<i64>,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

#[derive(Deserialize)]
pub struct WatermarkRequest {
    pub uid: i64,
}

/// GET /api/accounts/{account_id}/emails?since=
pub async fn list_emails(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
    Query(params): Query<ListQuery>,
) -> AppResult<Json<EmailListResponse>> {
    let account = require_account(&state, &jar, &account_id).await?;
    let emails =
        mailbox::list_emails(&state.db, state.mail.as_ref(), &account, params.since).await?;
    Ok(Json(emails))
}

/// GET /api/accounts/{account_id}/emails/{uid}
pub async fn get_email(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((account_id, uid)): Path<(String, i64)>,
) -> AppResult<Json<FullEmail>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(
        mailbox::get_email(state.mail.as_ref(), &account, uid).await?,
    ))
}

/// PUT /api/accounts/{account_id}/watermark
pub async fn set_watermark(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
    Json(req): Json<WatermarkRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let account = require_account(&state, &jar, &account_id).await?;
    mailbox::set_watermark(&state.db, &account, req.uid).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// GET /api/accounts/{account_id}/search?q=
pub async fn search_emails(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
    Query(params): Query<SearchQuery>,
) -> AppResult<Json<Vec<EmailEnvelope>>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(
        mailbox::search(state.mail.as_ref(), &account, &params.q).await?,
    ))
}
