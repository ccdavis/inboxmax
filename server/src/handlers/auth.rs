use crate::AppState;
use crate::config::{detect_provider, guess_provider};
use crate::error::{AppError, AppResult};
use crate::imap_client::MailCredentials;
use crate::session::{self, SessionAccount, UserSession};
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::Json;
use axum::extract::State;
use axum_extra::extract::cookie::{Cookie, CookieJar};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

const SESSION_COOKIE: &str = "inboxmax_session";
const DEVICE_COOKIE: &str = "inboxmax_device";
const MIN_PASSWORD_CHARS: usize = 8;
const MAX_PASSWORD_CHARS: usize = 256;

/// Verified when an email has no account, so sign-in takes the same time
/// whether or not the account exists.
static DUMMY_PASSWORD_HASH: LazyLock<String> = LazyLock::new(|| {
    Argon2::default()
        .hash_password(
            b"inboxmax-dummy-password",
            &SaltString::generate(&mut OsRng),
        )
        .expect("hashing a constant password cannot fail")
        .to_string()
});

// ---------- Request / Response types ----------

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Serialize)]
pub struct UserResponse {
    pub user_id: String,
    pub email: String,
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
pub struct SignInRequest {
    pub email: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct ConnectRequest {
    pub email: String,
    pub password: String,
    pub imap_host: Option<String>,
    pub imap_port: Option<u16>,
}

#[derive(Serialize)]
pub struct ConnectResponse {
    pub email: String,
    pub provider_detected: bool,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub logged_in: bool,
    pub email: Option<String>,
    pub user: Option<UserResponse>,
    pub imap_connected: bool,
    pub imap_email: Option<String>,
}

// ---------- Handlers ----------

/// POST /api/register — create an app account
pub async fn register(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<RegisterRequest>,
) -> AppResult<(CookieJar, Json<UserResponse>)> {
    let email = normalize_email(&req.email)?;
    if req.password.is_empty() {
        return Err(AppError::BadRequest(
            "Email and password are required".into(),
        ));
    }
    let password_chars = req.password.chars().count();
    if password_chars < MIN_PASSWORD_CHARS {
        return Err(AppError::BadRequest(format!(
            "Password must be at least {MIN_PASSWORD_CHARS} characters"
        )));
    }
    if password_chars > MAX_PASSWORD_CHARS {
        return Err(AppError::BadRequest(format!(
            "Password must be at most {MAX_PASSWORD_CHARS} characters"
        )));
    }

    // Hash password
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let password_hash = argon2
        .hash_password(req.password.as_bytes(), &salt)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Password hash error: {e}")))?
        .to_string();

    let user_id = uuid::Uuid::new_v4().to_string();
    let display_name = req
        .display_name
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // Atomic insert — use INSERT OR IGNORE + check rows affected to avoid TOCTOU race
    let result = sqlx::query(
        "INSERT OR IGNORE INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)",
    )
    .bind(&user_id)
    .bind(&email)
    .bind(&password_hash)
    .bind(&display_name)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::Conflict(
            "An account with this email already exists".into(),
        ));
    }

    let user = UserSession {
        user_id: user_id.clone(),
        email: email.clone(),
        display_name: display_name.clone(),
    };
    let jar = issue_session(&state, jar, user).await?;

    Ok((
        jar,
        Json(UserResponse {
            user_id,
            email,
            display_name,
        }),
    ))
}

/// POST /api/signin — sign in with app credentials
pub async fn signin(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<SignInRequest>,
) -> AppResult<(CookieJar, Json<UserResponse>)> {
    let email = normalize_email(&req.email).map_err(|_| AppError::InvalidCredentials)?;
    let limiter_key = format!("signin:{email}");
    state.limiter.check(&limiter_key)?;

    if req.password.chars().count() > MAX_PASSWORD_CHARS {
        state.limiter.record_failure(&limiter_key);
        return Err(AppError::InvalidCredentials);
    }

    let row: Option<(String, String, Option<String>)> =
        sqlx::query_as("SELECT id, password_hash, display_name FROM users WHERE email = ?")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;

    let stored_hash = row
        .as_ref()
        .map_or(DUMMY_PASSWORD_HASH.as_str(), |(_, hash, _)| hash.as_str());
    let parsed_hash = PasswordHash::new(stored_hash)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Hash parse error: {e}")))?;
    let password_ok = Argon2::default()
        .verify_password(req.password.as_bytes(), &parsed_hash)
        .is_ok();

    let Some((user_id, _, display_name)) = row.filter(|_| password_ok) else {
        state.limiter.record_failure(&limiter_key);
        return Err(AppError::InvalidCredentials);
    };
    state.limiter.reset(&limiter_key);

    let user = UserSession {
        user_id: user_id.clone(),
        email: email.clone(),
        display_name: display_name.clone(),
    };
    let jar = issue_session(&state, jar, user).await?;

    Ok((
        jar,
        Json(UserResponse {
            user_id,
            email,
            display_name,
        }),
    ))
}

/// POST /api/signout — clear device cookie + session
pub async fn signout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    // Remove device token from DB
    if let Some(cookie) = jar.get(DEVICE_COOKIE) {
        session::delete_device_token(&state.db, cookie.value()).await?;
    }
    // Remove in-memory session
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        state.sessions.remove(cookie.value()).await;
    }

    let jar = jar
        .remove(removal_cookie(DEVICE_COOKIE))
        .remove(removal_cookie(SESSION_COOKIE));
    Ok((jar, Json(serde_json::json!({ "ok": true }))))
}

/// GET /api/me — get current user info
pub async fn me(State(state): State<AppState>, jar: CookieJar) -> AppResult<Json<UserResponse>> {
    let user = get_user_from_jar(&state, &jar)
        .await
        .ok_or(AppError::Unauthorized)?;
    Ok(Json(UserResponse {
        user_id: user.user_id,
        email: user.email,
        display_name: user.display_name,
    }))
}

/// POST /api/connect — connect an IMAP account (requires app auth)
pub async fn connect(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<ConnectRequest>,
) -> AppResult<(CookieJar, Json<ConnectResponse>)> {
    // Require app-level auth
    let user = get_user_from_jar(&state, &jar)
        .await
        .ok_or(AppError::Unauthorized)?;

    let email = normalize_email(&req.email)?;
    let custom_host = req
        .imap_host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .map(str::to_lowercase);
    let detected_provider = detect_provider(&email);
    let provider_detected = detected_provider.is_some() && custom_host.is_none();
    let provider = detected_provider
        .or_else(|| guess_provider(&email))
        .ok_or_else(|| AppError::BadRequest("Unable to determine IMAP host".into()))?;
    let imap_host = custom_host.unwrap_or(provider.imap_host);
    let imap_port = req.imap_port.unwrap_or(provider.imap_port);
    if imap_port == 0 {
        return Err(AppError::BadRequest("Invalid IMAP port".into()));
    }
    let credentials = MailCredentials {
        host: imap_host.clone(),
        port: imap_port,
        email: email.clone(),
        password: req.password,
    };

    // Verify credentials by connecting to IMAP. Rejected logins are limited per
    // user so this endpoint cannot be used to guess mailbox passwords.
    let limiter_key = format!("connect:{}", user.user_id);
    state.limiter.check(&limiter_key)?;
    match state.mail.verify_credentials(&credentials).await {
        Ok(()) => state.limiter.reset(&limiter_key),
        Err(error) => {
            if matches!(error, AppError::MailAuth(_)) {
                state.limiter.record_failure(&limiter_key);
            }
            return Err(error);
        }
    }

    // The conditional upsert makes ownership enforcement atomic. Reconnecting
    // preserves the existing visit/window state.
    let account_id = uuid::Uuid::new_v4().to_string();
    // The SMTP columns are legacy schema fields retained for migration
    // compatibility; the application no longer exposes unused SMTP settings.
    let result = sqlx::query(
        "INSERT INTO accounts (id, email, imap_host, imap_port, smtp_host, smtp_port, user_id)
         VALUES (?, ?, ?, ?, '', 0, ?)
         ON CONFLICT DO UPDATE SET
           imap_host = excluded.imap_host,
           imap_port = excluded.imap_port,
           user_id = excluded.user_id
         WHERE accounts.user_id IS NULL OR accounts.user_id = excluded.user_id",
    )
    .bind(&account_id)
    .bind(&email)
    .bind(&imap_host)
    .bind(imap_port as i64)
    .bind(&user.user_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::Conflict(
            "This email account is already linked to a different user".into(),
        ));
    }

    let row: (String,) = sqlx::query_as("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE")
        .bind(&email)
        .fetch_one(&state.db)
        .await?;

    // Store IMAP credentials in session
    let session_token = jar
        .get(SESSION_COOKIE)
        .map(|c| c.value().to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let account = SessionAccount {
        id: row.0,
        email: email.clone(),
        password: credentials.password,
        imap_host,
        imap_port,
    };
    state.sessions.set_account(&session_token, account).await;

    // Ensure the session cookie is set (might be a new token)
    let session_cookie = auth_cookie(SESSION_COOKIE, session_token);

    Ok((
        jar.add(session_cookie),
        Json(ConnectResponse {
            email,
            provider_detected,
        }),
    ))
}

/// GET /api/auth/status — returns both app auth and IMAP connection status
pub async fn status(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<StatusResponse>> {
    let user = get_user_from_jar(&state, &jar).await;
    let account = get_account_from_jar(&state, &jar).await;

    tracing::debug!(
        "status check: logged_in={}, imap_connected={}",
        user.is_some(),
        account.is_some()
    );

    Ok(Json(StatusResponse {
        logged_in: user.is_some(),
        email: user.as_ref().map(|u| u.email.clone()),
        user: user.map(|u| UserResponse {
            user_id: u.user_id,
            email: u.email,
            display_name: u.display_name,
        }),
        imap_connected: account.is_some(),
        imap_email: account.map(|a| a.email),
    }))
}

// ---------- Helpers (used by other handlers) ----------

/// Get the app user from cookies (checks session first, then device token).
pub async fn get_user_from_jar(state: &AppState, jar: &CookieJar) -> Option<UserSession> {
    // Check in-memory session first
    if let Some(cookie) = jar.get(SESSION_COOKIE)
        && let Some(user) = state.sessions.get_user(cookie.value()).await
    {
        return Some(user);
    }
    // Fall back to device token (persistent)
    if let Some(cookie) = jar.get(DEVICE_COOKIE)
        && let Ok(Some(user)) = session::validate_device_token(&state.db, cookie.value()).await
    {
        // Hydrate the in-memory session for future requests
        if let Some(session_cookie) = jar.get(SESSION_COOKIE) {
            state
                .sessions
                .set_user(session_cookie.value(), user.clone())
                .await;
        }
        return Some(user);
    }
    None
}

/// Get IMAP account from session cookie.
pub async fn get_account_from_jar(state: &AppState, jar: &CookieJar) -> Option<SessionAccount> {
    let cookie = jar.get(SESSION_COOKIE)?;
    state.sessions.get_account(cookie.value()).await
}

/// Require IMAP account or return Unauthorized.
pub async fn require_account(state: &AppState, jar: &CookieJar) -> AppResult<SessionAccount> {
    let account = get_account_from_jar(state, jar).await;
    if account.is_none() {
        let has_session = jar.get(SESSION_COOKIE).is_some();
        let has_device = jar.get(DEVICE_COOKIE).is_some();
        tracing::warn!(
            "require_account failed: no IMAP session (session_cookie={}, device_cookie={})",
            has_session,
            has_device
        );
    }
    account.ok_or(AppError::Unauthorized)
}

// ---------- Utility ----------

fn max_age_30_days() -> time::Duration {
    time::Duration::days(30)
}

fn cookies_secure() -> bool {
    std::env::var("COOKIE_SECURE")
        .map(|value| !matches!(value.to_ascii_lowercase().as_str(), "0" | "false" | "no"))
        .unwrap_or(false)
}

fn auth_cookie(name: &'static str, value: String) -> Cookie<'static> {
    Cookie::build((name, value))
        .path("/")
        .http_only(true)
        .secure(cookies_secure())
        .max_age(max_age_30_days())
        .same_site(axum_extra::extract::cookie::SameSite::Lax)
        .build()
}

fn removal_cookie(name: &'static str) -> Cookie<'static> {
    Cookie::build(name)
        .path("/")
        .http_only(true)
        .secure(cookies_secure())
        .same_site(axum_extra::extract::cookie::SameSite::Lax)
        .build()
}

async fn issue_session(
    state: &AppState,
    jar: CookieJar,
    user: UserSession,
) -> AppResult<CookieJar> {
    if let Some(previous) = jar.get(SESSION_COOKIE) {
        state.sessions.remove(previous.value()).await;
    }

    // Keep nine existing devices, then add this one as the guaranteed tenth.
    session::cleanup_device_tokens(&state.db, &user.user_id, 9).await?;
    let device_token = session::create_device_token(&state.db, &user.user_id).await?;
    let session_token = uuid::Uuid::new_v4().to_string();
    state.sessions.set_user(&session_token, user).await;

    Ok(jar
        .add(auth_cookie(DEVICE_COOKIE, device_token))
        .add(auth_cookie(SESSION_COOKIE, session_token)))
}

fn normalize_email(input: &str) -> AppResult<String> {
    let email = input.trim().to_lowercase();
    let Some((local, domain)) = email.split_once('@') else {
        return Err(AppError::BadRequest("Invalid email address".into()));
    };
    if email.len() > 254
        || local.is_empty()
        || domain.is_empty()
        || domain.contains('@')
        || email.chars().any(char::is_whitespace)
    {
        return Err(AppError::BadRequest("Invalid email address".into()));
    }
    Ok(email)
}
