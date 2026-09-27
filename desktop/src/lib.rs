//! Inbox Max desktop app. The same React UI as the web app runs in the
//! system WebView and talks to the shared `inboxmax-core` operations over
//! Tauri IPC instead of HTTP, so there is no local network server. There is
//! one local profile (no sign-in) and mailbox passwords are kept in the
//! operating system's credential store.

mod commands;
mod credentials;
mod state;

use inboxmax_core::fake_mail::WithDemoMailbox;
use state::DesktopState;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

/// The database lives in the per-user app data directory unless
/// INBOXMAX_DATA_DIR overrides it (used by tests and for portable installs).
fn database_path(app: &tauri::App) -> anyhow::Result<PathBuf> {
    let dir = match std::env::var_os("INBOXMAX_DATA_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => app.path().app_data_dir()?,
    };
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("inboxmax.db"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "inboxmax=info,inboxmax_core=info,inboxmax_desktop_lib=info".into()
            }),
        )
        .init();

    tauri::Builder::default()
        // A second launch focuses the existing window instead of opening
        // another copy against the same database.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = database_path(app)?;
            let state = tauri::async_runtime::block_on(async {
                let db = inboxmax_core::db::init_pool_at(&path).await?;
                // The desktop's one local profile can safely offer the demo
                // account; the multi-user web server does not.
                let mail = Arc::new(WithDemoMailbox(inboxmax_core::default_mail_fetcher()));
                DesktopState::new(db, mail, credentials::system_store())
                    .await
                    .map_err(anyhow::Error::from)
            })?;
            app.manage(state);
            // Reading saved passwords may wait on keychain prompts; do it
            // without holding up the window.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                handle.state::<DesktopState>().load_saved_passwords().await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_accounts,
            commands::connect_account,
            commands::connect_demo,
            commands::remove_account,
            commands::list_emails,
            commands::get_email,
            commands::search_emails,
            commands::set_watermark,
            commands::list_remembered,
            commands::remember_email,
            commands::forget_email,
            commands::open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Inbox Max");
}
