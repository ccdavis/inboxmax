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
