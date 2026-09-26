//! Inbox Max web server: multi-user sign-in and sessions in front of the
//! shared `inboxmax-core` mailbox operations.

pub mod handlers;
pub mod rate_limit;
pub mod session;

pub use inboxmax_core::{config, db, error, imap_client};

use imap_client::MailFetcher;
use rate_limit::AttemptLimiter;
use session::SessionStore;
use sqlx::SqlitePool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub sessions: SessionStore,
    pub mail: Arc<dyn MailFetcher>,
    pub limiter: AttemptLimiter,
}

/// Build the complete API router so production and tests exercise the same routes.
pub fn api_router(state: AppState) -> axum::Router {
    use axum::routing::{get, post, put};
    use handlers::{accounts, auth, emails, remembered};

    axum::Router::new()
        .route("/api/register", post(auth::register))
        .route("/api/signin", post(auth::signin))
        .route("/api/signout", post(auth::signout))
        .route("/api/me", get(auth::me))
        .route("/api/auth/status", get(auth::status))
        .route(
            "/api/accounts",
            get(accounts::list_accounts).post(accounts::connect),
        )
        .route(
            "/api/accounts/{account_id}",
            axum::routing::delete(accounts::remove),
        )
        .route(
            "/api/accounts/{account_id}/emails",
            get(emails::list_emails),
        )
        .route(
            "/api/accounts/{account_id}/emails/{uid}",
            get(emails::get_email),
        )
        .route(
            "/api/accounts/{account_id}/search",
            get(emails::search_emails),
        )
        .route(
            "/api/accounts/{account_id}/watermark",
            put(emails::set_watermark),
        )
        .route(
            "/api/accounts/{account_id}/remembered",
            get(remembered::list_remembered),
        )
        .route(
            "/api/accounts/{account_id}/remembered/{uid}",
            post(remembered::remember_email).delete(remembered::forget_email),
        )
        .with_state(state)
}
