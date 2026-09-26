use crate::AppState;
use crate::error::AppResult;
use crate::handlers::auth::require_account;
use axum::Json;
use axum::extract::{Path, State};
use axum_extra::extract::CookieJar;
use inboxmax_core::mailbox::{self, RememberRequest, RememberedEmail};

/// GET /api/accounts/{account_id}/remembered
pub async fn list_remembered(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
) -> AppResult<Json<Vec<RememberedEmail>>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(
        mailbox::list_remembered(&state.db, &account.id).await?,
    ))
}

/// POST /api/accounts/{account_id}/remembered/{uid}
pub async fn remember_email(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((account_id, uid)): Path<(String, i64)>,
    Json(req): Json<RememberRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let account = require_account(&state, &jar, &account_id).await?;
    mailbox::remember(&state.db, &account.id, uid, req).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// DELETE /api/accounts/{account_id}/remembered/{uid}
pub async fn forget_email(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((account_id, uid)): Path<(String, i64)>,
) -> AppResult<Json<serde_json::Value>> {
    let account = require_account(&state, &jar, &account_id).await?;
    mailbox::forget(&state.db, &account.id, uid).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
