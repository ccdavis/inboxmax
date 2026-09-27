//! Drafts of one mailbox connected in this session.

use crate::AppState;
use crate::error::AppResult;
use crate::handlers::auth::require_account;
use axum::Json;
use axum::extract::{Path, State};
use axum_extra::extract::CookieJar;
use inboxmax_core::drafts::{self, Draft, DraftSummary, SaveDraft};

/// GET /api/accounts/{account_id}/drafts
pub async fn list_drafts(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
) -> AppResult<Json<Vec<DraftSummary>>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(drafts::list(&state.db, &account.id).await?))
}

/// GET /api/accounts/{account_id}/drafts/{draft_id}
pub async fn get_draft(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((account_id, draft_id)): Path<(String, String)>,
) -> AppResult<Json<Draft>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(drafts::get(&state.db, &account.id, &draft_id).await?))
}

/// PUT /api/accounts/{account_id}/drafts/{draft_id} — create or replace.
pub async fn save_draft(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((account_id, draft_id)): Path<(String, String)>,
    Json(request): Json<SaveDraft>,
) -> AppResult<Json<DraftSummary>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(
        drafts::save(&state.db, &account.id, &draft_id, &request.content).await?,
    ))
}

/// DELETE /api/accounts/{account_id}/drafts/{draft_id}
pub async fn delete_draft(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((account_id, draft_id)): Path<(String, String)>,
) -> AppResult<Json<serde_json::Value>> {
    let account = require_account(&state, &jar, &account_id).await?;
    drafts::delete(&state.db, &account.id, &draft_id).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
