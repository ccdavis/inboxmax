use inboxmax_server::imap_client::RealMailFetcher;
use inboxmax_server::rate_limit::AttemptLimiter;
use inboxmax_server::session::SessionStore;
use inboxmax_server::{AppState, api_router, db};
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

    if let Some(path) = database_url.strip_prefix("sqlite:")
        && path != ":memory:"
        && let Some(parent) = std::path::Path::new(path).parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }

    let pool = db::init_pool(&database_url).await?;

    let state = AppState {
        db: pool,
        sessions: SessionStore::new(),
        mail: Arc::new(RealMailFetcher),
        limiter: AttemptLimiter::new(),
    };

    let api = api_router(state);

    // Serve the built React frontend for all non-API routes.
    // `npm run build` in client/ outputs to client/dist/.
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "../client/dist".into());
    let index_file = format!("{static_dir}/index.html");

    let app = api
        .fallback_service(ServeDir::new(&static_dir).fallback(ServeFile::new(&index_file)))
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
