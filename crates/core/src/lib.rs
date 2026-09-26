//! Mailbox access, storage, and inbox operations shared by the Inbox Max web
//! server and desktop app. Each front end adds its own identity and transport:
//! the server has multi-user sign-in over HTTP, the desktop app a single local
//! profile over Tauri IPC.

pub mod account;
pub mod config;
pub mod db;
pub mod error;
#[cfg(feature = "fake-mail")]
pub mod fake_mail;
pub mod imap_client;
pub mod mailbox;

pub use account::ConnectedAccount;
pub use error::{AppError, AppResult};

use std::sync::Arc;

/// The mail client the front ends should use: real IMAP, or in builds with
/// the `fake-mail` feature, the generated demo mailbox when
/// `INBOXMAX_FAKE_MAIL=1`.
pub fn default_mail_fetcher() -> Arc<dyn imap_client::MailFetcher> {
    #[cfg(feature = "fake-mail")]
    if std::env::var("INBOXMAX_FAKE_MAIL").is_ok_and(|v| v == "1") {
        tracing::warn!("Using the fake demo mailbox (INBOXMAX_FAKE_MAIL=1)");
        return Arc::new(fake_mail::FakeMailFetcher);
    }
    Arc::new(imap_client::RealMailFetcher)
}
