pub mod config;
pub mod db;
pub mod error;
pub mod handlers;
pub mod imap_client;
pub mod rate_limit;
pub mod session;

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
    use axum::routing::{delete, get, post, put};

    axum::Router::new()
        .route("/api/register", post(handlers::auth::register))
        .route("/api/signin", post(handlers::auth::signin))
        .route("/api/signout", post(handlers::auth::signout))
        .route("/api/me", get(handlers::auth::me))
        .route("/api/connect", post(handlers::auth::connect))
        .route("/api/auth/status", get(handlers::auth::status))
        .route("/api/emails", get(handlers::emails::list_emails))
        .route("/api/emails/{uid}", get(handlers::emails::get_email))
        .route("/api/search", get(handlers::emails::search_emails))
        .route("/api/watermark", put(handlers::emails::set_watermark))
        .route(
            "/api/remembered",
            get(handlers::remembered::list_remembered),
        )
        .route(
            "/api/remembered/{uid}",
            post(handlers::remembered::remember_email),
        )
        .route(
            "/api/remembered/{uid}",
            delete(handlers::remembered::forget_email),
        )
        .with_state(state)
}
