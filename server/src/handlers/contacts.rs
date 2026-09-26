//! The signed-in user's address book.

use crate::AppState;
use crate::error::AppResult;
use crate::handlers::auth::require_user;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum_extra::extract::CookieJar;
use inboxmax_core::contacts::{self, Contact, ContactRequest};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ContactsQuery {
    pub q: Option<String>,
}

/// GET /api/contacts — the whole address book, or with `?q=` suggestions
/// whose address or name starts with the query.
pub async fn list_contacts(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<ContactsQuery>,
) -> AppResult<Json<Vec<Contact>>> {
    let user = require_user(&state, &jar).await?;
    Ok(Json(match query.q {
        Some(q) => contacts::search(&state.db, &user.user_id, &q).await?,
        None => contacts::list(&state.db, &user.user_id).await?,
    }))
}

/// POST /api/contacts — add an entry, or rename an existing one.
pub async fn save_contact(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<ContactRequest>,
) -> AppResult<Json<Contact>> {
    let user = require_user(&state, &jar).await?;
    Ok(Json(
        contacts::save(&state.db, &user.user_id, request).await?,
    ))
}

/// DELETE /api/contacts/{id}
pub async fn delete_contact(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let user = require_user(&state, &jar).await?;
    contacts::delete(&state.db, &user.user_id, id).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
