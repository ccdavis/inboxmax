use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use chrono::NaiveDate;
use http_body_util::BodyExt;
use inboxmax_server::error::{AppError, AppResult};
use inboxmax_server::imap_client::{
    EmailEnvelope, FullEmail, MailCredentials, MailFetcher, MailboxSnapshot,
};
use inboxmax_server::rate_limit::AttemptLimiter;
use inboxmax_server::session::SessionStore;
use inboxmax_server::{AppState, api_router};
use serde_json::Value;
use sqlx::sqlite::SqlitePoolOptions;
use std::sync::Arc;
use tower::ServiceExt;

/// Mailbox password that the fake mail server rejects.
const REJECTED_MAIL_PASSWORD: &str = "wrong-mail-password";

struct FakeMailFetcher;

#[async_trait::async_trait]
impl MailFetcher for FakeMailFetcher {
    async fn fetch_envelopes(
        &self,
        _credentials: &MailCredentials,
        _since: NaiveDate,
    ) -> AppResult<MailboxSnapshot> {
        Ok(MailboxSnapshot {
            envelopes: vec![],
            uid_validity: Some(1),
        })
    }

    async fn fetch_email(&self, _credentials: &MailCredentials, _uid: u32) -> AppResult<FullEmail> {
        unreachable!()
    }

    async fn search(
        &self,
        _credentials: &MailCredentials,
        _query: &str,
    ) -> AppResult<Vec<EmailEnvelope>> {
        Ok(vec![])
    }

    async fn verify_credentials(&self, credentials: &MailCredentials) -> AppResult<()> {
        if credentials.password == REJECTED_MAIL_PASSWORD {
            return Err(AppError::MailAuth("[AUTHENTICATIONFAILED]".into()));
        }
        Ok(())
    }
}

async fn state() -> AppState {
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&db).await.unwrap();
    AppState {
        db,
        sessions: SessionStore::new(),
        mail: Arc::new(FakeMailFetcher),
        limiter: AttemptLimiter::with_limits(3, std::time::Duration::from_secs(60)),
    }
}

fn json_request(method: &str, uri: &str, body: Value, cookies: Option<&str>) -> Request<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(cookies) = cookies {
        request = request.header(header::COOKIE, cookies);
    }
    request.body(Body::from(body.to_string())).unwrap()
}

async fn register(state: &AppState, email: &str) -> (String, Value) {
    let response = api_router(state.clone())
        .oneshot(json_request(
            "POST",
            "/api/register",
            serde_json::json!({ "email": email, "password": "password123" }),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let cookies = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap().split(';').next().unwrap())
        .collect::<Vec<_>>()
        .join("; ");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (cookies, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn registration_normalizes_email_and_sets_scoped_cookies() {
    let state = state().await;
    let response = api_router(state)
        .oneshot(json_request(
            "POST",
            "/api/register",
            serde_json::json!({
                "email": "  User@Example.COM ",
                "password": "password123"
            }),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    for cookie in response.headers().get_all(header::SET_COOKIE) {
        let cookie = cookie.to_str().unwrap();
        assert!(cookie.contains("Path=/"), "{cookie}");
        assert!(cookie.contains("HttpOnly"), "{cookie}");
        assert!(cookie.contains("SameSite=Lax"), "{cookie}");
        assert!(cookie.contains("Max-Age=2592000"), "{cookie}");
    }
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["email"], "user@example.com");
}

#[tokio::test]
async fn signout_revokes_tokens_and_removes_root_path_cookies() {
    let state = state().await;
    let (cookies, _) = register(&state, "logout@example.com").await;

    let response = api_router(state.clone())
        .oneshot(json_request(
            "POST",
            "/api/signout",
            serde_json::json!({}),
            Some(&cookies),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    for cookie in response.headers().get_all(header::SET_COOKIE) {
        let cookie = cookie.to_str().unwrap();
        assert!(cookie.contains("Path=/"), "{cookie}");
        assert!(cookie.contains("Max-Age=0"), "{cookie}");
    }

    let response = api_router(state)
        .oneshot(
            Request::builder()
                .uri("/api/auth/status")
                .header(header::COOKIE, cookies)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["logged_in"], false);
}

#[tokio::test]
async fn a_mailbox_cannot_be_relinked_using_an_email_case_variant() {
    let state = state().await;
    let (first_cookies, _) = register(&state, "first@example.com").await;
    let (second_cookies, _) = register(&state, "second@example.com").await;

    let connect = |cookies: String, email: &'static str| {
        api_router(state.clone()).oneshot(json_request(
            "POST",
            "/api/connect",
            serde_json::json!({
                "email": email,
                "password": "mail-password",
                "imap_host": "imap.example.com"
            }),
            Some(&cookies),
        ))
    };

    let first = connect(first_cookies, "Mailbox@Example.com").await.unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let second = connect(second_cookies, "mailbox@example.COM")
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::CONFLICT);
}

async fn body_json(response: axum::response::Response) -> Value {
    let body = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&body).unwrap()
}

fn signin_request(email: &str, password: &str) -> Request<Body> {
    json_request(
        "POST",
        "/api/signin",
        serde_json::json!({ "email": email, "password": password }),
        None,
    )
}

#[tokio::test]
async fn wrong_password_reports_invalid_credentials() {
    let state = state().await;
    register(&state, "user@example.com").await;

    for email in ["user@example.com", "nobody@example.com"] {
        let response = api_router(state.clone())
            .oneshot(signin_request(email, "not-the-password"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            body_json(response).await["error"],
            "Invalid email or password"
        );
    }
}

#[tokio::test]
async fn repeated_signin_failures_are_rate_limited_per_account() {
    let state = state().await;
    register(&state, "user@example.com").await;
    register(&state, "other@example.com").await;

    for _ in 0..3 {
        let response = api_router(state.clone())
            .oneshot(signin_request("user@example.com", "guess"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    // Even the right password is refused until the window passes...
    let blocked = api_router(state.clone())
        .oneshot(signin_request("USER@example.com", "password123"))
        .await
        .unwrap();
    assert_eq!(blocked.status(), StatusCode::TOO_MANY_REQUESTS);

    // ...but other accounts are unaffected.
    let other = api_router(state.clone())
        .oneshot(signin_request("other@example.com", "password123"))
        .await
        .unwrap();
    assert_eq!(other.status(), StatusCode::OK);
}

#[tokio::test]
async fn password_length_counts_characters_not_bytes() {
    let state = state().await;
    let register_with = |password: &'static str| {
        api_router(state.clone()).oneshot(json_request(
            "POST",
            "/api/register",
            serde_json::json!({ "email": format!("{}@example.com", password.len()), "password": password }),
            None,
        ))
    };

    // Four two-byte characters: eight bytes, but only four characters.
    let short = register_with("éééé").await.unwrap();
    assert_eq!(short.status(), StatusCode::BAD_REQUEST);
    let long_enough = register_with("éééééééé").await.unwrap();
    assert_eq!(long_enough.status(), StatusCode::OK);
}

#[tokio::test]
async fn rejected_mailbox_logins_are_rate_limited_per_user() {
    let state = state().await;
    let (cookies, _) = register(&state, "user@example.com").await;
    let connect = |password: &'static str| {
        api_router(state.clone()).oneshot(json_request(
            "POST",
            "/api/connect",
            serde_json::json!({
                "email": "mailbox@example.com",
                "password": password,
                "imap_host": "imap.example.com"
            }),
            Some(&cookies),
        ))
    };

    for _ in 0..3 {
        let response = connect(REJECTED_MAIL_PASSWORD).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let error = body_json(response).await["error"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(error.contains("rejected"), "{error}");
    }
    let blocked = connect("right-password").await.unwrap();
    assert_eq!(blocked.status(), StatusCode::TOO_MANY_REQUESTS);
}
