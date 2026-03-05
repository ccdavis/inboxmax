pub mod config;
pub mod db;
pub mod error;
pub mod handlers;
pub mod imap_client;
pub mod session;
pub mod smtp_client;

use imap_client::MailFetcher;
use session::SessionStore;
use sqlx::SqlitePool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub sessions: SessionStore,
    pub mail: Arc<dyn MailFetcher>,
}
