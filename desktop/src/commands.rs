//! Tauri commands: the desktop counterpart of the web server's HTTP API.
//! Each one is a thin wrapper over the shared core operations, and returns
//! the same JSON shapes so the frontend can use either transport.

use crate::state::{DesktopState, LOCAL_USER_ID};
use inboxmax_core::account::{self, AccountStatus, ConnectRequest, ConnectResponse};
use inboxmax_core::imap_client::{EmailEnvelope, FullEmail};
use inboxmax_core::mailbox::{self, EmailListResponse, RememberRequest, RememberedEmail};
use inboxmax_core::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
pub struct AppInfo {
    pub version: &'static str,
    /// Passwords can be saved in the operating system's credential store.
    pub can_save_passwords: bool,
}

#[derive(Deserialize)]
pub struct ConnectArgs {
    pub email: String,
    pub password: String,
    pub imap_host: Option<String>,
    pub imap_port: Option<u16>,
    /// Save the password in the OS credential store.
    #[serde(default = "default_true")]
    pub remember: bool,
}

fn default_true() -> bool {
    true
}

#[tauri::command]
pub fn app_info(state: State<'_, DesktopState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        can_save_passwords: state.can_save_passwords(),
    }
}

#[tauri::command]
pub async fn list_accounts(state: State<'_, DesktopState>) -> AppResult<Vec<AccountStatus>> {
    state.list_accounts().await
}

#[tauri::command]
pub async fn connect_account(
    state: State<'_, DesktopState>,
    request: ConnectArgs,
) -> AppResult<ConnectResponse> {
    let remember = request.remember;
    let outcome = account::connect_account(
        &state.db,
        state.mail.as_ref(),
        LOCAL_USER_ID,
        ConnectRequest {
            email: request.email,
            password: request.password,
            imap_host: request.imap_host,
            imap_port: request.imap_port,
        },
    )
    .await?;
    let status = AccountStatus {
        id: outcome.account.id.clone(),
        email: outcome.account.email.clone(),
        connected: true,
        password_saved: false,
    };
    let password_saved = state.add_connected(outcome.account, remember).await;
    Ok(ConnectResponse {
        account: AccountStatus {
            password_saved,
            ..status
        },
        provider_detected: outcome.provider_detected,
    })
}

#[tauri::command]
pub async fn remove_account(state: State<'_, DesktopState>, account_id: String) -> AppResult<()> {
    state.remove_account(&account_id).await
}

#[tauri::command]
pub async fn list_emails(
    state: State<'_, DesktopState>,
    account_id: String,
    since: Option<i64>,
) -> AppResult<EmailListResponse> {
    let account = state.require_account(&account_id).await?;
    mailbox::list_emails(&state.db, state.mail.as_ref(), &account, since).await
}

#[tauri::command]
pub async fn get_email(
    state: State<'_, DesktopState>,
    account_id: String,
    uid: i64,
) -> AppResult<FullEmail> {
    let account = state.require_account(&account_id).await?;
    mailbox::get_email(state.mail.as_ref(), &account, uid).await
}

#[tauri::command]
pub async fn search_emails(
    state: State<'_, DesktopState>,
    account_id: String,
    query: String,
) -> AppResult<Vec<EmailEnvelope>> {
    let account = state.require_account(&account_id).await?;
    mailbox::search(state.mail.as_ref(), &account, &query).await
}

#[tauri::command]
pub async fn set_watermark(
    state: State<'_, DesktopState>,
    account_id: String,
    uid: i64,
) -> AppResult<()> {
    let account = state.require_account(&account_id).await?;
    mailbox::set_watermark(&state.db, &account, uid).await
}

#[tauri::command]
pub async fn list_remembered(
    state: State<'_, DesktopState>,
    account_id: String,
) -> AppResult<Vec<RememberedEmail>> {
    let account = state.require_account(&account_id).await?;
    mailbox::list_remembered(&state.db, &account.id).await
}

#[tauri::command]
pub async fn remember_email(
    state: State<'_, DesktopState>,
    account_id: String,
    uid: i64,
    data: RememberRequest,
) -> AppResult<()> {
    let account = state.require_account(&account_id).await?;
    mailbox::remember(&state.db, &account.id, uid, data).await
}

#[tauri::command]
pub async fn forget_email(
    state: State<'_, DesktopState>,
    account_id: String,
    uid: i64,
) -> AppResult<()> {
    let account = state.require_account(&account_id).await?;
    mailbox::forget(&state.db, &account.id, uid).await
}

/// Open a link from an email in the system browser. Only web and mail links
/// are allowed, so message content cannot launch local files or programs.
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> AppResult<()> {
    let scheme = url
        .split_once(':')
        .map(|(scheme, _)| scheme.to_ascii_lowercase());
    if !matches!(scheme.as_deref(), Some("http" | "https" | "mailto")) {
        return Err(AppError::BadRequest(
            "Only web and email links can be opened".into(),
        ));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Could not open the link: {e}")))
}
