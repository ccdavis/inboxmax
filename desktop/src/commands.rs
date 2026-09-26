//! Tauri commands: the desktop counterpart of the web server's HTTP API.
//! Each one is a thin wrapper over the shared core operations, and returns
//! the same JSON shapes so the frontend can use either transport.

use crate::state::{DesktopState, LOCAL_USER_ID};
use inboxmax_core::account::{self, AccountStatus, ConnectRequest, ConnectResponse};
use inboxmax_core::contacts::{self, Contact, ContactRequest};
use inboxmax_core::fake_mail::{self, DEMO_EMAIL, DEMO_HOST, DEMO_PASSWORD};
use inboxmax_core::imap_client::{EmailEnvelope, FullEmail};
use inboxmax_core::mailbox::{self, EmailListResponse, RememberRequest, RememberedEmail};
use inboxmax_core::outgoing::{SendReceipt, SendRequest};
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
    /// The same fields as the web API's connect request.
    #[serde(flatten)]
    pub connection: ConnectRequest,
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
    connect(&state, request).await
}

/// Open the generated demo mailbox in its starting state (some new mail,
/// some seen, a couple remembered), so the app can be tried without a mail
/// account. Opening it again starts it over.
#[tauri::command]
pub async fn connect_demo(state: State<'_, DesktopState>) -> AppResult<ConnectResponse> {
    let response = connect(
        &state,
        ConnectArgs {
            connection: ConnectRequest {
                email: DEMO_EMAIL.into(),
                password: DEMO_PASSWORD.into(),
                imap_host: Some(DEMO_HOST.into()),
                ..ConnectRequest::default()
            },
            remember: false,
        },
    )
    .await?;
    fake_mail::reset_demo(&state.db, &response.account.id).await?;
    Ok(response)
}

async fn connect(state: &DesktopState, request: ConnectArgs) -> AppResult<ConnectResponse> {
    let outcome = account::connect_account(
        &state.db,
        state.mail.as_ref(),
        LOCAL_USER_ID,
        request.connection,
    )
    .await?;
    let status = AccountStatus {
        id: outcome.account.id.clone(),
        email: outcome.account.email.clone(),
        connected: true,
        password_saved: false,
    };
    let password_saved = state.add_connected(outcome.account, request.remember).await;
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
    mailbox::get_email(&state.db, state.mail.as_ref(), LOCAL_USER_ID, &account, uid).await
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
pub async fn send_email(
    state: State<'_, DesktopState>,
    account_id: String,
    request: SendRequest,
) -> AppResult<SendReceipt> {
    let account = state.require_account(&account_id).await?;
    mailbox::send(
        &state.db,
        state.mail.as_ref(),
        LOCAL_USER_ID,
        &account,
        request,
    )
    .await
}

/// The address book, or with a query, suggestions whose address or name
/// starts with it.
#[tauri::command]
pub async fn list_contacts(
    state: State<'_, DesktopState>,
    query: Option<String>,
) -> AppResult<Vec<Contact>> {
    match query {
        Some(query) => contacts::search(&state.db, LOCAL_USER_ID, &query).await,
        None => contacts::list(&state.db, LOCAL_USER_ID).await,
    }
}

#[tauri::command]
pub async fn save_contact(
    state: State<'_, DesktopState>,
    request: ContactRequest,
) -> AppResult<Contact> {
    contacts::save(&state.db, LOCAL_USER_ID, request).await
}

#[tauri::command]
pub async fn delete_contact(state: State<'_, DesktopState>, id: i64) -> AppResult<()> {
    contacts::delete(&state.db, LOCAL_USER_ID, id).await
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
