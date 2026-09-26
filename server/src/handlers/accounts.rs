//! Mail accounts for the signed-in user. Passwords are kept only in the
//! in-memory session, so after a server restart accounts are listed but
//! must be reconnected.

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::handlers::auth::{ensure_session_token, require_user, session_token};
use axum::Json;
use axum::extract::{Path, State};
use axum_extra::extract::CookieJar;
use inboxmax_core::account::{self, AccountStatus, ConnectRequest};
use serde::Serialize;

#[derive(Serialize)]
pub struct ConnectResponse {
    pub account: AccountStatus,
    pub provider_detected: bool,
}

/// GET /api/accounts
pub async fn list_accounts(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<Vec<AccountStatus>>> {
    let user = require_user(&state, &jar).await?;
    let connected = match session_token(&jar) {
        Some(token) => state.sessions.connected_account_ids(&token).await,
        None => Vec::new(),
    };
    let accounts = account::list_accounts(&state.db, &user.user_id)
        .await?
        .into_iter()
        .map(|record| AccountStatus {
            connected: connected.contains(&record.id),
            id: record.id,
            email: record.email,
            password_saved: false,
        })
        .collect();
    Ok(Json(accounts))
}

/// POST /api/accounts — verify an IMAP login and connect it in this session.
pub async fn connect(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<ConnectRequest>,
) -> AppResult<(CookieJar, Json<ConnectResponse>)> {
    let user = require_user(&state, &jar).await?;

    // Rejected logins are limited per user so this endpoint cannot be used to
    // guess mailbox passwords.
    let limiter_key = format!("connect:{}", user.user_id);
    state.limiter.check(&limiter_key)?;
    let outcome =
        match account::connect_account(&state.db, state.mail.as_ref(), &user.user_id, req).await {
            Ok(outcome) => {
                state.limiter.reset(&limiter_key);
                outcome
            }
            Err(error) => {
                if matches!(error, AppError::MailAuth(_)) {
                    state.limiter.record_failure(&limiter_key);
                }
                return Err(error);
            }
        };

    let (jar, token) = ensure_session_token(jar);
    let status = AccountStatus {
        id: outcome.account.id.clone(),
        email: outcome.account.email.clone(),
        connected: true,
        password_saved: false,
    };
    state.sessions.add_account(&token, outcome.account).await;
    Ok((
        jar,
        Json(ConnectResponse {
            account: status,
            provider_detected: outcome.provider_detected,
        }),
    ))
}

/// DELETE /api/accounts/{account_id} — remove the account, its remembered
/// emails, and inbox state.
pub async fn remove(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let user = require_user(&state, &jar).await?;
    account::delete_account(&state.db, &user.user_id, &account_id).await?;
    if let Some(token) = session_token(&jar) {
        state.sessions.remove_account(&token, &account_id).await;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}
