use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use chrono::NaiveDate;
use http_body_util::BodyExt;
use inboxmax_server::error::AppResult;
use inboxmax_server::imap_client::{
    EmailEnvelope, FullEmail, MailCredentials, MailFetcher, MailboxSnapshot,
};
use inboxmax_server::session::SessionStore;
use inboxmax_server::{AppState, api_router};
use serde_json::Value;
use sqlx::sqlite::SqlitePoolOptions;
use std::sync::Arc;
use tower::ServiceExt;

struct AcceptingMailFetcher;

#[async_trait::async_trait]
impl MailFetcher for AcceptingMailFetcher {
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

    async fn verify_credentials(&self, _credentials: &MailCredentials) -> AppResult<()> {
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
        mail: Arc::new(AcceptingMailFetcher),
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
