use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::{NaiveDate, Utc};
use http_body_util::BodyExt;
use inboxmax_core::ConnectedAccount;
use inboxmax_core::outgoing::{OutgoingEmail, SendReceipt};
use inboxmax_server::error::{AppError, AppResult};
use inboxmax_server::imap_client::{
    EmailEnvelope, FullEmail, MailAddress, MailCredentials, MailFetcher, MailboxSnapshot,
    SmtpServer,
};
use inboxmax_server::rate_limit::AttemptLimiter;
use inboxmax_server::session::SessionStore;
use inboxmax_server::{AppState, api_router};
use serde_json::Value;
use sqlx::SqlitePool;
use std::sync::Arc;
use std::sync::Mutex;
use tower::ServiceExt;

// ---------------------------------------------------------------------------
// Mock IMAP
// ---------------------------------------------------------------------------

/// UID the mock mailbox reports as deleted.
const MISSING_UID: u32 = 404;

struct MockMailFetcher {
    envelopes: Vec<EmailEnvelope>,
    /// What was sent, and through which SMTP server.
    sent: Mutex<Vec<(SmtpServer, OutgoingEmail)>>,
}

impl MockMailFetcher {
    fn with_envelopes(envelopes: Vec<EmailEnvelope>) -> Self {
        Self {
            envelopes,
            sent: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait::async_trait]
impl MailFetcher for MockMailFetcher {
    async fn send(
        &self,
        _credentials: &MailCredentials,
        smtp: &SmtpServer,
        email: &OutgoingEmail,
    ) -> AppResult<SendReceipt> {
        self.sent
            .lock()
            .unwrap()
            .push((smtp.clone(), email.clone()));
        Ok(SendReceipt {
            message_id: email.message_id.clone(),
            saved_to_sent: false,
        })
    }

    async fn fetch_envelopes(
        &self,
        _credentials: &MailCredentials,
        _since: NaiveDate,
    ) -> AppResult<MailboxSnapshot> {
        Ok(MailboxSnapshot {
            envelopes: self.envelopes.clone(),
            uid_validity: Some(1),
        })
    }

    async fn fetch_email(&self, _credentials: &MailCredentials, uid: u32) -> AppResult<FullEmail> {
        if uid == MISSING_UID {
            return Err(AppError::NotFound("Message not found".into()));
        }
        Ok(FullEmail {
            uid,
            subject: "Test".into(),
            from: vec![MailAddress::new(Some("Tess"), "test@example.com")],
            reply_to: vec![],
            to: vec![MailAddress::new(None, "me@example.com")],
            cc: vec![],
            date: Some(Utc::now()),
            received: Some(Utc::now()),
            body_html: None,
            body_text: Some("body".into()),
            message_id: None,
        })
    }

    async fn search(
        &self,
        _credentials: &MailCredentials,
        _query: &str,
    ) -> AppResult<Vec<EmailEnvelope>> {
        Ok(self.envelopes.clone())
    }

    async fn verify_credentials(&self, _credentials: &MailCredentials) -> AppResult<()> {
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
        },
        EmailEnvelope {
            uid: 99,
            subject: "Older".into(),
            from: "bob@example.com".into(),
            date: Some(Utc::now() - chrono::Duration::hours(2)),
        },
    ]
}

async fn setup_test_db() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    inboxmax_core::db::MIGRATOR.run(&pool).await.unwrap();
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
    api_router(state)
}

async fn build_state(envelopes: Vec<EmailEnvelope>) -> AppState {
    build_state_with(Arc::new(MockMailFetcher::with_envelopes(envelopes))).await
}

async fn build_state_with(mail: Arc<MockMailFetcher>) -> AppState {
    let pool = setup_test_db().await;
    seed_account(&pool).await;
    let sessions = SessionStore::new();
    sessions
        .add_account(
            SESSION_TOKEN,
            ConnectedAccount {
                id: ACCOUNT_ID.into(),
                email: "test@example.com".into(),
                password: "pass".into(),
                imap_host: "imap.test.com".into(),
                imap_port: 993,
                smtp: SmtpServer {
                    host: "smtp.test.com".into(),
                    port: 587,
                },
            },
        )
        .await;
    AppState {
        db: pool,
        sessions,
        mail,
        limiter: AttemptLimiter::new(),
    }
}

fn send_request(body: Value, signed_in: bool) -> Request<Body> {
    let mut request = Request::builder()
        .uri(format!("/api/accounts/{ACCOUNT_ID}/send"))
        .method("POST")
        .header("Content-Type", "application/json");
    if signed_in {
        request = request.header("Cookie", format!("inboxmax_session={SESSION_TOKEN}"));
    }
    request.body(Body::from(body.to_string())).unwrap()
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
        .uri(format!("/api/accounts/{ACCOUNT_ID}/watermark"))
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
    let row: (Option<i64>,) = sqlx::query_as("SELECT last_open FROM accounts WHERE id = ?")
        .bind(ACCOUNT_ID)
        .fetch_one(pool)
        .await
        .unwrap();
    row.0
}

async fn get_watermark_uid(pool: &SqlitePool) -> Option<i64> {
    let row: (Option<i64>,) = sqlx::query_as("SELECT watermark_uid FROM accounts WHERE id = ?")
        .bind(ACCOUNT_ID)
        .fetch_one(pool)
        .await
        .unwrap();
    row.0
}

async fn get_uid_validity(pool: &SqlitePool) -> Option<i64> {
    sqlx::query_scalar("SELECT uid_validity FROM accounts WHERE id = ?")
        .bind(ACCOUNT_ID)
        .fetch_one(pool)
        .await
        .unwrap()
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

    let resp = app
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/emails"
        )))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // After first fetch, last_open should be set
    let last_open = get_last_open(&state.db).await;
    assert!(
        last_open.is_some(),
        "last_open should be set after first fetch"
    );
}

#[tokio::test]
async fn list_emails_does_not_update_last_open_on_subsequent_calls() {
    let state = build_state(sample_envelopes()).await;

    // First call: sets last_open
    let app = build_app(state.clone());
    let resp = app
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/emails"
        )))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let first_last_open = get_last_open(&state.db).await.unwrap();

    // Small delay to ensure timestamps would differ
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    // Second call: last_open should NOT change
    let app = build_app(state.clone());
    let resp = app
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/emails"
        )))
        .await
        .unwrap();
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
    let since = Utc::now().timestamp_millis() - 24 * 60 * 60 * 1000;

    // First call
    let app = build_app(state.clone());
    let resp = app
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/emails?since={since}"
        )))
        .await
        .unwrap();
    let json = parse_response(resp).await;
    let first_count = json["emails"].as_array().unwrap().len();
    assert_eq!(first_count, 2);

    // Second call — should still return emails (the bug was returning 0)
    let app = build_app(state.clone());
    let resp = app
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/emails?since={since}"
        )))
        .await
        .unwrap();
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
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/emails?since={since}"
        )))
        .await
        .unwrap();
    let json = parse_response(resp).await;
    assert_eq!(json["since_timestamp"].as_i64().unwrap(), since);
}

#[tokio::test]
async fn list_emails_filters_imap_day_results_to_the_exact_timestamp() {
    let now = Utc::now();
    let state = build_state(vec![
        EmailEnvelope {
            uid: 2,
            subject: "New".into(),
            from: "new@example.com".into(),
            date: Some(now),
        },
        EmailEnvelope {
            uid: 1,
            subject: "Before cursor".into(),
            from: "old@example.com".into(),
            date: Some(now - chrono::Duration::hours(2)),
        },
    ])
    .await;
    let since = (now - chrono::Duration::hours(1)).timestamp_millis();
    let response = build_app(state)
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/emails?since={since}"
        )))
        .await
        .unwrap();
    let json = parse_response(response).await;

    assert_eq!(json["emails"].as_array().unwrap().len(), 1);
    assert_eq!(json["emails"][0]["uid"], 2);
}

#[tokio::test]
async fn uid_validity_change_clears_a_stale_watermark() {
    let state = build_state(sample_envelopes()).await;
    sqlx::query("UPDATE accounts SET uid_validity = 999, watermark_uid = 100 WHERE id = ?")
        .bind(ACCOUNT_ID)
        .execute(&state.db)
        .await
        .unwrap();

    let response = build_app(state.clone())
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/emails"
        )))
        .await
        .unwrap();
    let json = parse_response(response).await;

    assert!(json["watermark_uid"].is_null());
    assert_eq!(get_watermark_uid(&state.db).await, None);
    assert_eq!(get_uid_validity(&state.db).await, Some(1));
}

#[tokio::test]
async fn list_emails_returns_since_timestamp_and_last_open() {
    let state = build_state(sample_envelopes()).await;
    let app = build_app(state.clone());

    let resp = app
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/emails"
        )))
        .await
        .unwrap();
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
    app.oneshot(emails_request(&format!(
        "/api/accounts/{ACCOUNT_ID}/emails"
    )))
    .await
    .unwrap();
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
    let since = Utc::now().timestamp_millis() - 24 * 60 * 60 * 1000;

    // First fetch
    let app = build_app(state.clone());
    app.oneshot(emails_request(&format!(
        "/api/accounts/{ACCOUNT_ID}/emails?since={since}"
    )))
    .await
    .unwrap();

    // Save watermark (simulates tabbing away)
    let app = build_app(state.clone());
    app.oneshot(watermark_request(100)).await.unwrap();

    // Fetch again (simulates coming back) — the mock always returns
    // the same envelopes, but the important thing is last_open is set
    // and it doesn't cause an error
    let app = build_app(state.clone());
    let resp = app
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/emails?since={since}"
        )))
        .await
        .unwrap();
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
                .uri(format!("/api/accounts/{ACCOUNT_ID}/emails"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn accounts_not_connected_in_the_session_are_unauthorized() {
    let state = build_state(sample_envelopes()).await;
    let response = build_app(state)
        .oneshot(emails_request("/api/accounts/some-other-account/emails"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------
// Integration tests: mailbox identity and message lookup
// ---------------------------------------------------------------------------

#[tokio::test]
async fn first_uid_validity_observation_keeps_legacy_state_and_bookmarks() {
    let state = build_state(sample_envelopes()).await;
    // A pre-UIDVALIDITY account with a watermark and a legacy bookmark.
    sqlx::query("UPDATE accounts SET watermark_uid = 100, last_open = ? WHERE id = ?")
        .bind(Utc::now().timestamp_millis() - 60_000)
        .bind(ACCOUNT_ID)
        .execute(&state.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO remembered (account_id, email_uid, subject) VALUES (?, 7, 'Old')")
        .bind(ACCOUNT_ID)
        .execute(&state.db)
        .await
        .unwrap();

    let response = build_app(state.clone())
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/emails"
        )))
        .await
        .unwrap();
    let json = parse_response(response).await;
    assert_eq!(json["watermark_uid"], 100);
    assert_eq!(get_uid_validity(&state.db).await, Some(1));

    let response = build_app(state.clone())
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/remembered"
        )))
        .await
        .unwrap();
    let remembered = parse_response(response).await;
    assert_eq!(remembered.as_array().unwrap().len(), 1);
    assert_eq!(remembered[0]["email_uid"], 7);
}

#[tokio::test]
async fn missing_message_returns_not_found() {
    let state = build_state(sample_envelopes()).await;
    let response = build_app(state)
        .oneshot(emails_request(&format!(
            "/api/accounts/{ACCOUNT_ID}/emails/{MISSING_UID}"
        )))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// Integration tests: sending
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sending_goes_through_the_accounts_smtp_server() {
    let mail = Arc::new(MockMailFetcher::with_envelopes(vec![]));
    let state = build_state_with(mail.clone()).await;
    let response = build_app(state)
        .oneshot(send_request(
            serde_json::json!({
                "to": [{ "name": "Sarah Chen", "email": "sarah@acme.example" }],
                "cc": [{ "name": null, "email": "bob@acme.example" }],
                "subject": "Hello",
                "body": "Hi Sarah",
                "in_reply_to": "<orig@acme.example>",
            }),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let receipt = parse_response(response).await;

    let sent = mail.sent.lock().unwrap();
    let (smtp, email) = &sent[0];
    assert_eq!(smtp.host, "smtp.test.com");
    assert_eq!(email.from.email, "test@example.com");
    assert_eq!(email.to[0].name.as_deref(), Some("Sarah Chen"));
    assert_eq!(email.cc[0].email, "bob@acme.example");
    assert_eq!(email.in_reply_to.as_deref(), Some("orig@acme.example"));
    assert_eq!(receipt["message_id"], email.message_id.as_str());
    assert_eq!(receipt["saved_to_sent"], false);
}

#[tokio::test]
async fn sending_explains_what_is_wrong_with_a_message() {
    let mail = Arc::new(MockMailFetcher::with_envelopes(vec![]));
    let state = build_state_with(mail.clone()).await;
    for (body, message) in [
        (
            serde_json::json!({ "subject": "No one" }),
            "Add at least one recipient",
        ),
        (
            serde_json::json!({ "to": [{ "name": null, "email": "not-an-address" }] }),
            "“not-an-address” is not a valid email address",
        ),
    ] {
        let response = build_app(state.clone())
            .oneshot(send_request(body, true))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(parse_response(response).await["error"], message);
    }
    assert!(mail.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn sending_requires_a_signed_in_session() {
    let mail = Arc::new(MockMailFetcher::with_envelopes(vec![]));
    let state = build_state_with(mail.clone()).await;
    let response = build_app(state)
        .oneshot(send_request(
            serde_json::json!({ "to": [{ "name": null, "email": "a@example.com" }] }),
            false,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(mail.sent.lock().unwrap().is_empty());
}
