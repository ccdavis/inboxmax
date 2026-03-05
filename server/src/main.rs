use axum::routing::{delete, get, post, put};
use axum::Router;
use inboxmax_server::imap_client::RealMailFetcher;
use inboxmax_server::session::SessionStore;
use inboxmax_server::{db, handlers, AppState};
use std::sync::Arc;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "inboxmax_server=debug,tower_http=debug".into()),
        )
        .init();

    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:data/inboxmax.db".into());

    if let Some(path) = database_url.strip_prefix("sqlite:") {
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let pool = db::init_pool(&database_url).await?;

    let state = AppState {
        db: pool,
        sessions: SessionStore::new(),
        mail: Arc::new(RealMailFetcher),
    };

    // API routes
    let api = Router::new()
        // App auth
        .route("/api/register", post(handlers::auth::register))
        .route("/api/signin", post(handlers::auth::signin))
        .route("/api/signout", post(handlers::auth::signout))
        .route("/api/me", get(handlers::auth::me))
        // IMAP connect
        .route("/api/connect", post(handlers::auth::connect))
        // Auth status
        .route("/api/auth/status", get(handlers::auth::status))
        // Emails
        .route("/api/emails", get(handlers::emails::list_emails))
        .route("/api/emails/{uid}", get(handlers::emails::get_email))
        .route("/api/search", get(handlers::emails::search_emails))
        .route("/api/watermark", put(handlers::emails::set_watermark))
        // Remembered
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
        .with_state(state);

    // Serve the built React frontend for all non-API routes.
    // `npm run build` in client/ outputs to client/dist/.
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "../client/dist".into());
    let index_file = format!("{static_dir}/index.html");

    let app = api
        .fallback_service(
            ServeDir::new(&static_dir).fallback(ServeFile::new(&index_file)),
        )
        .layer(TraceLayer::new_for_http());

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3001);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("Inbox Max running at http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
