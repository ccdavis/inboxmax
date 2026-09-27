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

/// A message with the most attachments allowed, base64-encoded in JSON
/// (4 bytes for every 3), plus room for the text.
const SEND_BODY_LIMIT: usize =
    inboxmax_core::outgoing::MAX_ATTACHMENT_BYTES / 3 * 4 + 4 * 1024 * 1024;

/// Build the complete API router so production and tests exercise the same routes.
pub fn api_router(state: AppState) -> axum::Router {
    use axum::extract::DefaultBodyLimit;
    use axum::routing::{get, post, put};
    use handlers::{accounts, auth, contacts, drafts, emails, remembered, signature};

    let router = axum::Router::new()
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
            "/api/contacts",
            get(contacts::list_contacts).post(contacts::save_contact),
        )
        .route(
            "/api/contacts/{id}",
            axum::routing::delete(contacts::delete_contact),
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
            "/api/accounts/{account_id}/emails/{uid}/attachments/{index}",
            get(emails::download_attachment),
        )
        .route(
            "/api/accounts/{account_id}/emails/{uid}/move",
            post(emails::move_email),
        )
        .route(
            "/api/accounts/{account_id}/restore",
            post(emails::restore_email),
        )
        .route(
            "/api/accounts/{account_id}/folders",
            get(emails::list_folders),
        )
        .route(
            "/api/accounts/{account_id}/folders/{folder}/emails",
            get(emails::folder_emails),
        )
        .route(
            "/api/accounts/{account_id}/folders/{folder}/emails/{uid}",
            get(emails::get_folder_email),
        )
        .route(
            "/api/accounts/{account_id}/folders/{folder}/emails/{uid}/attachments/{index}",
            get(emails::download_folder_attachment),
        )
        .route(
            "/api/accounts/{account_id}/drafts",
            get(drafts::list_drafts),
        )
        .route(
            "/api/accounts/{account_id}/drafts/{draft_id}",
            get(drafts::get_draft)
                .put(drafts::save_draft)
                .delete(drafts::delete_draft)
                .layer(DefaultBodyLimit::max(
                    inboxmax_core::drafts::MAX_DRAFT_BYTES + 1024,
                )),
        )
        .route(
            "/api/accounts/{account_id}/send",
            post(emails::send_email).layer(DefaultBodyLimit::max(SEND_BODY_LIMIT)),
        )
        .route(
            "/api/accounts/{account_id}/signature",
            get(signature::get_signature).put(signature::set_signature),
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
        );
    // End-to-end tests read what the fake mailbox "sent".
    #[cfg(feature = "fake-mail")]
    let router = router.route("/api/test/outbox", get(handlers::test_support::outbox));
    router.with_state(state)
}
