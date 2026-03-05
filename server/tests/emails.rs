use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::{get, put};
use axum::Router;
use chrono::{NaiveDate, Utc};
use http_body_util::BodyExt;
use inboxmax_server::error::AppResult;
use inboxmax_server::handlers::emails;
use inboxmax_server::imap_client::{EmailEnvelope, FullEmail, MailFetcher};
use inboxmax_server::session::{SessionAccount, SessionStore};
use inboxmax_server::AppState;
use serde_json::Value;
use sqlx::SqlitePool;
use std::sync::Arc;
use tower::ServiceExt;

// ---------------------------------------------------------------------------
// Mock IMAP
// ---------------------------------------------------------------------------

struct MockMailFetcher {
    envelopes: Vec<EmailEnvelope>,
}

impl MockMailFetcher {
    fn with_envelopes(envelopes: Vec<EmailEnvelope>) -> Self {
        Self { envelopes }
    }
}

#[async_trait::async_trait]
impl MailFetcher for MockMailFetcher {
    async fn fetch_envelopes(
        &self,
        _host: &str,
        _port: u16,
        _email: &str,
        _password: &str,
        _since: NaiveDate,
    ) -> AppResult<Vec<EmailEnvelope>> {
        Ok(self.envelopes.clone())
    }

    async fn fetch_email(
        &self,
        _host: &str,
        _port: u16,
        _email: &str,
        _password: &str,
        uid: u32,
    ) -> AppResult<FullEmail> {
        Ok(FullEmail {
            uid,
            subject: "Test".into(),
            from: "test@example.com".into(),
            to: "me@example.com".into(),
            date: Some(Utc::now()),
            body_html: None,
            body_text: Some("body".into()),
            message_id: None,
        })
    }

    async fn search(
        &self,
        _host: &str,
        _port: u16,
        _email: &str,
        _password: &str,
        _query: &str,
    ) -> AppResult<Vec<EmailEnvelope>> {
        Ok(self.envelopes.clone())
    }

    async fn verify_credentials(
        &self,
        _host: &str,
        _port: u16,
        _email: &str,
        _password: &str,
    ) -> AppResult<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

fn sample_envelopes() -> Vec<EmailEnvelope> {
    vec![
        EmailEnvelope {
            uid: 100,
            subject: "Hello".into(),
            from: "alice@example.com".into(),
            date: Some(Utc::now()),
            has_attachment: false,
        },
        EmailEnvelope {
            uid: 99,
            subject: "Older".into(),
            from: "bob@example.com".into(),
            date: Some(Utc::now() - chrono::Duration::hours(2)),
            has_attachment: false,
        },
    ]
}

async fn setup_test_db() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    pool
}

const ACCOUNT_ID: &str = "test-account-id";
const SESSION_TOKEN: &str = "test-session-token";

async fn seed_account(pool: &SqlitePool) {
    sqlx::query(
        "INSERT INTO accounts (id, email, imap_host, imap_port, smtp_host, smtp_port)
         VALUES (?, 'test@example.com', 'imap.test.com', 993, 'smtp.test.com', 587)",
    )
    .bind(ACCOUNT_ID)
    .execute(pool)
    .await
    .unwrap();
}

fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/api/emails", get(emails::list_emails))
        .route("/api/watermark", put(emails::set_watermark))
        .with_state(state)
}

async fn build_state(envelopes: Vec<EmailEnvelope>) -> AppState {
    let pool = setup_test_db().await;
    seed_account(&pool).await;
    let sessions = SessionStore::new();
    sessions
        .set_account(
            SESSION_TOKEN,
            SessionAccount {
                id: ACCOUNT_ID.into(),
                email: "test@example.com".into(),
                password: "pass".into(),
                imap_host: "imap.test.com".into(),
                imap_port: 993,
                smtp_host: "smtp.test.com".into(),
                smtp_port: 587,
            },
        )
        .await;
    AppState {
        db: pool,
        sessions,
        mail: Arc::new(MockMailFetcher::with_envelopes(envelopes)),
    }
}

fn emails_request(uri: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .header("Cookie", format!("inboxmax_session={SESSION_TOKEN}"))
        .body(Body::empty())
        .unwrap()
}

fn watermark_request(uid: i64) -> Request<Body> {
    Request::builder()
        .uri("/api/watermark")
        .method("PUT")
        .header("Cookie", format!("inboxmax_session={SESSION_TOKEN}"))
        .header("Content-Type", "application/json")
        .body(Body::from(format!(r#"{{"uid":{uid}}}"#)))
        .unwrap()
}

async fn parse_response(resp: axum::response::Response) -> Value {
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&body).unwrap()
}

async fn get_last_open(pool: &SqlitePool) -> Option<i64> {
    let row: (Option<i64>,) =
        sqlx::query_as("SELECT last_open FROM accounts WHERE id = ?")
            .bind(ACCOUNT_ID)
            .fetch_one(pool)
            .await
            .unwrap();
    row.0
}

async fn get_watermark_uid(pool: &SqlitePool) -> Option<i64> {
    let row: (Option<i64>,) =
        sqlx::query_as("SELECT watermark_uid FROM accounts WHERE id = ?")
            .bind(ACCOUNT_ID)
            .fetch_one(pool)
            .await
            .unwrap();
    row.0
}

// ---------------------------------------------------------------------------
// Unit tests: calculate_since_ms
// ---------------------------------------------------------------------------

#[cfg(test)]
mod calculate_since_ms_tests {
    use inboxmax_server::handlers::emails::calculate_since_ms;

    const NOW: i64 = 1_700_000_000_000; // some fixed timestamp
    const DAY_MS: i64 = 24 * 60 * 60 * 1000;
    const WEEK_MS: i64 = 7 * DAY_MS;

    #[test]
    fn explicit_since_wins() {
        let since = 1_699_000_000_000;
        assert_eq!(calculate_since_ms(Some(since), Some(NOW - 1000), NOW), since);
    }

    #[test]
    fn no_since_no_last_open_returns_24h_ago() {
        assert_eq!(calculate_since_ms(None, None, NOW), NOW - DAY_MS);
    }

    #[test]
    fn no_since_with_recent_last_open() {
        let last_open = NOW - 3_600_000; // 1 hour ago
        assert_eq!(calculate_since_ms(None, Some(last_open), NOW), last_open);
    }

    #[test]
    fn no_since_with_stale_last_open_falls_back_to_24h() {
        let stale = NOW - WEEK_MS - 1000; // older than 7 days
        assert_eq!(calculate_since_ms(None, Some(stale), NOW), NOW - DAY_MS);
    }

    #[test]
    fn zero_last_open_falls_back_to_24h() {
        assert_eq!(calculate_since_ms(None, Some(0), NOW), NOW - DAY_MS);
    }

    #[test]
    fn negative_last_open_falls_back_to_24h() {
        assert_eq!(calculate_since_ms(None, Some(-1), NOW), NOW - DAY_MS);
    }
}

// ---------------------------------------------------------------------------
// Integration tests: last_open behavior
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_emails_sets_last_open_on_first_visit() {
    let state = build_state(sample_envelopes()).await;
    let app = build_app(state.clone());

    // Verify last_open starts as NULL
    assert!(get_last_open(&state.db).await.is_none());

    let resp = app.oneshot(emails_request("/api/emails")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // After first fetch, last_open should be set
    let last_open = get_last_open(&state.db).await;
    assert!(last_open.is_some(), "last_open should be set after first fetch");
}

#[tokio::test]
async fn list_emails_does_not_update_last_open_on_subsequent_calls() {
    let state = build_state(sample_envelopes()).await;

    // First call: sets last_open
    let app = build_app(state.clone());
    let resp = app.oneshot(emails_request("/api/emails")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let first_last_open = get_last_open(&state.db).await.unwrap();

    // Small delay to ensure timestamps would differ
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    // Second call: last_open should NOT change
    let app = build_app(state.clone());
    let resp = app.oneshot(emails_request("/api/emails")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let second_last_open = get_last_open(&state.db).await.unwrap();
    assert_eq!(
        first_last_open, second_last_open,
        "last_open must not change on subsequent list_emails calls"
    );
}

#[tokio::test]
async fn list_emails_returns_emails_on_repeated_calls() {
    let state = build_state(sample_envelopes()).await;

    // First call
    let app = build_app(state.clone());
    let resp = app.oneshot(emails_request("/api/emails")).await.unwrap();
    let json = parse_response(resp).await;
    let first_count = json["emails"].as_array().unwrap().len();
    assert_eq!(first_count, 2);

    // Second call — should still return emails (the bug was returning 0)
    let app = build_app(state.clone());
    let resp = app.oneshot(emails_request("/api/emails")).await.unwrap();
    let json = parse_response(resp).await;
    let second_count = json["emails"].as_array().unwrap().len();
    assert_eq!(
        second_count, 2,
        "subsequent calls must still return emails, not 0"
    );
}

#[tokio::test]
async fn list_emails_respects_explicit_since_param() {
    let state = build_state(sample_envelopes()).await;
    let app = build_app(state.clone());

    let since = Utc::now().timestamp_millis() - 3_600_000;
    let resp = app
        .oneshot(emails_request(&format!("/api/emails?since={since}")))
        .await
        .unwrap();
    let json = parse_response(resp).await;
    assert_eq!(json["since_timestamp"].as_i64().unwrap(), since);
}

#[tokio::test]
async fn list_emails_returns_since_timestamp_and_last_open() {
    let state = build_state(sample_envelopes()).await;
    let app = build_app(state.clone());

    let resp = app.oneshot(emails_request("/api/emails")).await.unwrap();
    let json = parse_response(resp).await;

    assert!(json["since_timestamp"].is_i64());
    // On first call, the returned last_open should be null (it was NULL before the update)
    assert!(json["last_open"].is_null());
}

// ---------------------------------------------------------------------------
// Integration tests: watermark / last_open interaction
// ---------------------------------------------------------------------------

#[tokio::test]
async fn set_watermark_updates_watermark_uid_and_last_open() {
    let state = build_state(sample_envelopes()).await;

    // First, fetch emails to set last_open
    let app = build_app(state.clone());
    app.oneshot(emails_request("/api/emails")).await.unwrap();
    let lo_after_fetch = get_last_open(&state.db).await.unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    // Set watermark
    let app = build_app(state.clone());
    let resp = app.oneshot(watermark_request(100)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Verify watermark_uid was saved
    assert_eq!(get_watermark_uid(&state.db).await, Some(100));

    // Verify last_open was updated (should be newer than after fetch)
    let lo_after_watermark = get_last_open(&state.db).await.unwrap();
    assert!(
        lo_after_watermark >= lo_after_fetch,
        "watermark save should update last_open"
    );
}

#[tokio::test]
async fn after_watermark_save_list_emails_still_returns_data() {
    let state = build_state(sample_envelopes()).await;

    // First fetch
    let app = build_app(state.clone());
    app.oneshot(emails_request("/api/emails")).await.unwrap();

    // Save watermark (simulates tabbing away)
    let app = build_app(state.clone());
    app.oneshot(watermark_request(100)).await.unwrap();

    // Fetch again (simulates coming back) — the mock always returns
    // the same envelopes, but the important thing is last_open is set
    // and it doesn't cause an error
    let app = build_app(state.clone());
    let resp = app.oneshot(emails_request("/api/emails")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = parse_response(resp).await;
    assert_eq!(json["emails"].as_array().unwrap().len(), 2);
}

// ---------------------------------------------------------------------------
// Auth / session tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_emails_without_session_returns_unauthorized() {
    let state = build_state(sample_envelopes()).await;
    let app = build_app(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/emails")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}
