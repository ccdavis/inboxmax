//! Routes for end-to-end tests, only in builds with the `fake-mail` feature.

use crate::AppState;
use crate::error::AppResult;
use crate::handlers::auth::require_user;
use axum::Json;
use axum::extract::State;
use axum_extra::extract::CookieJar;
use inboxmax_core::account;
use inboxmax_core::fake_mail::{self, SentMessage};

/// GET /api/test/outbox — what the signed-in user's mailboxes sent through
/// the fake mailbox, oldest first.
pub async fn outbox(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<Vec<SentMessage>>> {
    let user = require_user(&state, &jar).await?;
    let sent = account::list_accounts(&state.db, &user.user_id)
        .await?
        .iter()
        .flat_map(|record| fake_mail::sent_messages(&record.email))
        .collect();
    Ok(Json(sent))
}
