//! The signature of one mailbox connected in this session.

use crate::AppState;
use crate::error::AppResult;
use crate::handlers::auth::require_account;
use axum::Json;
use axum::extract::{Path, State};
use axum_extra::extract::CookieJar;
use inboxmax_core::signature::{self, Signature};

/// GET /api/accounts/{account_id}/signature
pub async fn get_signature(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
) -> AppResult<Json<Signature>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(signature::get(&state.db, &account.id).await?))
}

/// PUT /api/accounts/{account_id}/signature
pub async fn set_signature(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
    Json(request): Json<Signature>,
) -> AppResult<Json<Signature>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(
        signature::set(&state.db, &account.id, &request.signature).await?,
    ))
}
