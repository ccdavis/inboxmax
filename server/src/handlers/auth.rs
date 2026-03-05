use crate::config::detect_provider;
use crate::error::{AppError, AppResult};
use crate::session::{self, SessionAccount, UserSession};
use crate::AppState;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use rand_core::OsRng;
use axum::extract::State;
use axum::Json;
use axum_extra::extract::cookie::{Cookie, CookieJar};
use serde::{Deserialize, Serialize};

const SESSION_COOKIE: &str = "inboxmax_session";
const DEVICE_COOKIE: &str = "inboxmax_device";
const MAX_PASSWORD_LEN: usize = 256;

// ---------- Request / Response types ----------

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Serialize)]
pub struct RegisterResponse {
    pub user_id: String,
    pub email: String,
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
pub struct SignInRequest {
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct SignInResponse {
    pub user_id: String,
    pub email: String,
    pub display_name: Option<String>,
}

#[derive(Serialize)]
pub struct MeResponse {
    pub user_id: String,
    pub email: String,
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
pub struct ConnectRequest {
    pub email: String,
    pub password: String,
    pub imap_host: Option<String>,
    pub imap_port: Option<u16>,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<u16>,
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
    pub user: Option<MeResponse>,
    pub imap_connected: bool,
    pub imap_email: Option<String>,
}

// ---------- Handlers ----------

/// POST /api/register — create an app account
pub async fn register(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<RegisterRequest>,
) -> AppResult<(CookieJar, Json<RegisterResponse>)> {
    let email = req.email.trim().to_lowercase();
    if email.is_empty() || req.password.is_empty() {
        return Err(AppError::BadRequest(
            "Email and password are required".into(),
        ));
    }
    if req.password.len() < 8 {
        return Err(AppError::BadRequest(
            "Password must be at least 8 characters".into(),
        ));
    }
    if req.password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::BadRequest(
            format!("Password must be at most {MAX_PASSWORD_LEN} characters"),
        ));
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

    // Create device token (and clean up old ones — N/A for new user)
    let device_token = session::create_device_token(&state.db, &user_id).await?;
    let device_cookie = Cookie::build((DEVICE_COOKIE, device_token))
        .path("/")
        .http_only(true)
        .max_age(max_age_30_days())
        .same_site(axum_extra::extract::cookie::SameSite::Lax);

    // Also set up an in-memory session
    let session_token = uuid::Uuid::new_v4().to_string();
    state
        .sessions
        .set_user(
            &session_token,
            UserSession {
                user_id: user_id.clone(),
                email: email.clone(),
                display_name: display_name.clone(),
            },
        )
        .await;
    let session_cookie = Cookie::build((SESSION_COOKIE, session_token))
        .path("/")
        .http_only(true)
        .same_site(axum_extra::extract::cookie::SameSite::Lax);

    Ok((
        jar.add(device_cookie).add(session_cookie),
        Json(RegisterResponse {
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
) -> AppResult<(CookieJar, Json<SignInResponse>)> {
    let email = req.email.trim().to_lowercase();

    if req.password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::Unauthorized);
    }

    let row: Option<(String, String, Option<String>)> =
        sqlx::query_as("SELECT id, password_hash, display_name FROM users WHERE email = ?")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;

    let (user_id, password_hash, display_name) = row.ok_or(AppError::Unauthorized)?;

    // Verify password
    let parsed_hash = PasswordHash::new(&password_hash)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Hash parse error: {e}")))?;
    Argon2::default()
        .verify_password(req.password.as_bytes(), &parsed_hash)
        .map_err(|_| AppError::Unauthorized)?;

    // Clean up old device tokens for this user (keep max 10)
    session::cleanup_device_tokens(&state.db, &user_id, 10).await?;

    // Create device token
    let device_token = session::create_device_token(&state.db, &user_id).await?;
    let device_cookie = Cookie::build((DEVICE_COOKIE, device_token))
        .path("/")
        .http_only(true)
        .max_age(max_age_30_days())
        .same_site(axum_extra::extract::cookie::SameSite::Lax);

    // Set up in-memory session
    let session_token = uuid::Uuid::new_v4().to_string();
    state
        .sessions
        .set_user(
            &session_token,
            UserSession {
                user_id: user_id.clone(),
                email: email.clone(),
                display_name: display_name.clone(),
            },
        )
        .await;
    let session_cookie = Cookie::build((SESSION_COOKIE, session_token))
        .path("/")
        .http_only(true)
        .same_site(axum_extra::extract::cookie::SameSite::Lax);

    Ok((
        jar.add(device_cookie).add(session_cookie),
        Json(SignInResponse {
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
        let _ = session::delete_device_token(&state.db, cookie.value()).await;
    }
    // Remove in-memory session
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        state.sessions.remove(cookie.value()).await;
    }

    let jar = jar
        .remove(Cookie::from(DEVICE_COOKIE))
        .remove(Cookie::from(SESSION_COOKIE));
    Ok((jar, Json(serde_json::json!({ "ok": true }))))
}

/// GET /api/me — get current user info
pub async fn me(State(state): State<AppState>, jar: CookieJar) -> AppResult<Json<MeResponse>> {
    let user = get_user_from_jar(&state, &jar)
        .await
        .ok_or(AppError::Unauthorized)?;
    Ok(Json(MeResponse {
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

    let provider = detect_provider(&req.email);
    let provider_detected = provider.is_some() && req.imap_host.is_none();

    let (imap_host, imap_port, smtp_host, smtp_port) = if let Some(p) = provider {
        (
            req.imap_host.unwrap_or(p.imap_host),
            req.imap_port.unwrap_or(p.imap_port),
            req.smtp_host.unwrap_or(p.smtp_host),
            req.smtp_port.unwrap_or(p.smtp_port),
        )
    } else {
        (
            req.imap_host
                .ok_or_else(|| AppError::Imap("IMAP host required".into()))?,
            req.imap_port.unwrap_or(993),
            req.smtp_host
                .ok_or_else(|| AppError::Smtp("SMTP host required".into()))?,
            req.smtp_port.unwrap_or(587),
        )
    };

    // Verify credentials by connecting to IMAP
    state
        .mail
        .verify_credentials(&imap_host, imap_port, &req.email, &req.password)
        .await?;

    // Check if this IMAP account already belongs to a different user
    let existing: Option<(Option<String>,)> =
        sqlx::query_as("SELECT user_id FROM accounts WHERE email = ?")
            .bind(&req.email)
            .fetch_optional(&state.db)
            .await?;
    if let Some((Some(existing_user_id),)) = &existing {
        if existing_user_id != &user.user_id {
            return Err(AppError::Conflict(
                "This email account is already linked to a different user".into(),
            ));
        }
    }

    // Upsert account in DB, now linked to user
    let account_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO accounts (id, email, imap_host, imap_port, smtp_host, smtp_port, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           imap_host = excluded.imap_host,
           imap_port = excluded.imap_port,
           smtp_host = excluded.smtp_host,
           smtp_port = excluded.smtp_port,
           user_id = excluded.user_id,
           last_open = NULL",
    )
    .bind(&account_id)
    .bind(&req.email)
    .bind(&imap_host)
    .bind(imap_port as i64)
    .bind(&smtp_host)
    .bind(smtp_port as i64)
    .bind(&user.user_id)
    .execute(&state.db)
    .await?;

    let row: (String,) = sqlx::query_as("SELECT id FROM accounts WHERE email = ?")
        .bind(&req.email)
        .fetch_one(&state.db)
        .await?;

    // Store IMAP credentials in session
    let session_token = jar
        .get(SESSION_COOKIE)
        .map(|c| c.value().to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let account = SessionAccount {
        id: row.0,
        email: req.email.clone(),
        password: req.password,
        imap_host,
        imap_port,
        smtp_host,
        smtp_port,
    };
    state.sessions.set_account(&session_token, account).await;

    // Ensure the session cookie is set (might be a new token)
    let session_cookie = Cookie::build((SESSION_COOKIE, session_token))
        .path("/")
        .http_only(true)
        .same_site(axum_extra::extract::cookie::SameSite::Lax);

    Ok((
        jar.add(session_cookie),
        Json(ConnectResponse {
            email: req.email,
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
        user: user.map(|u| MeResponse {
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
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        if let Some(user) = state.sessions.get_user(cookie.value()).await {
            return Some(user);
        }
    }
    // Fall back to device token (persistent)
    if let Some(cookie) = jar.get(DEVICE_COOKIE) {
        if let Ok(Some(user)) = session::validate_device_token(&state.db, cookie.value()).await {
            // Hydrate the in-memory session for future requests
            if let Some(session_cookie) = jar.get(SESSION_COOKIE) {
                state
                    .sessions
                    .set_user(session_cookie.value(), user.clone())
                    .await;
            }
            return Some(user);
        }
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
