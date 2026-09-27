//! Inbox Max desktop app. The same React UI as the web app runs in the
//! system WebView and talks to the shared `inboxmax-core` operations over
//! Tauri IPC instead of HTTP, so there is no local network server. There is
//! one local profile (no sign-in) and mailbox passwords are kept in the
//! operating system's credential store.

mod commands;
mod credentials;
mod downloads;
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

/// The window's preferred size, in logical pixels.
const PREFERRED_SIZE: (f64, f64) = (1200.0, 800.0);
/// The most of the screen's work area the window takes at first.
const MAX_SCREEN_SHARE: f64 = 0.9;

/// The first window size for a work area of `screen` logical pixels: the
/// preferred size, shrunk to fit. Wide enough for the sidebar layout on any
/// screen that can show it.
fn initial_size(screen: (f64, f64)) -> (f64, f64) {
    (
        PREFERRED_SIZE.0.min(screen.0 * MAX_SCREEN_SHARE),
        PREFERRED_SIZE.1.min(screen.1 * MAX_SCREEN_SHARE),
    )
}

/// Size the main window for the monitor it opened on, and center it. A
/// fixed size in the config came out at physical pixels on scaled Windows
/// displays (1100 px at 150% is 734 CSS pixels: the phone layout).
fn fit_to_screen(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area().size;
    let (width, height) = initial_size((
        f64::from(area.width) / scale,
        f64::from(area.height) / scale,
    ));
    window.set_size(tauri::LogicalSize::new(width, height))?;
    window.center()
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
            if let Some(window) = app.get_webview_window("main")
                && let Err(e) = fit_to_screen(&window)
            {
                tracing::warn!("Could not size the window: {e}");
            }
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
            commands::send_email,
            commands::move_email,
            commands::restore_email,
            commands::save_attachment,
            commands::show_in_folder,
            commands::list_contacts,
            commands::save_contact,
            commands::delete_contact,
            commands::set_watermark,
            commands::list_remembered,
            commands::remember_email,
            commands::forget_email,
            commands::open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Inbox Max");
}

#[cfg(test)]
mod tests {
    use super::initial_size;

    #[test]
    fn the_first_window_fits_the_screen_and_prefers_room_for_the_sidebar() {
        // A 1920x1080 display at 150% (the taskbar leaves 688 of 720).
        assert_eq!(initial_size((1280.0, 688.0)), (1152.0, 619.2));
        // Room to spare: the preferred size.
        assert_eq!(initial_size((2560.0, 1400.0)), (1200.0, 800.0));
        // A small screen gets most of it rather than overflowing.
        assert_eq!(initial_size((800.0, 600.0)), (720.0, 540.0));
    }
}
