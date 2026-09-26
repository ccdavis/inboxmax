use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::handlers::auth::require_account;
use crate::imap_client;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum_extra::extract::CookieJar;
use chrono::Utc;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct ListQuery {
    pub since: Option<i64>,
}

#[derive(Serialize)]
pub struct EmailListResponse {
    pub emails: Vec<imap_client::EmailEnvelope>,
    pub since_timestamp: i64,
    pub last_open: Option<i64>,
    pub watermark_uid: Option<i64>,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

/// Calculate the effective `since` timestamp for email listing.
/// Exported for unit testing.
pub fn calculate_since_ms(param_since: Option<i64>, last_open: Option<i64>, now_ms: i64) -> i64 {
    param_since.unwrap_or_else(|| {
        if let Some(lo) = last_open
            && lo > 0
        {
            let seven_days_ago = now_ms - (7 * 24 * 60 * 60 * 1000);
            if lo > seven_days_ago {
                return lo;
            }
        }
        // First visit or stale: fetch last 24 hours to avoid timezone issues
        now_ms - (24 * 60 * 60 * 1000)
    })
}

pub async fn list_emails(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(params): Query<ListQuery>,
) -> AppResult<Json<EmailListResponse>> {
    tracing::debug!("list_emails called, since={:?}", params.since);

    let account = require_account(&state, &jar).await.map_err(|e| {
        tracing::warn!("list_emails auth failed: {e}");
        e
    })?;

    tracing::debug!("list_emails for account={} ({})", account.id, account.email);

    let (mut last_open, mut watermark_uid, stored_uid_validity): (
        Option<i64>,
        Option<i64>,
        Option<i64>,
    ) = sqlx::query_as("SELECT last_open, watermark_uid, uid_validity FROM accounts WHERE id = ?")
        .bind(&account.id)
        .fetch_optional(&state.db)
        .await?
        .unwrap_or((None, None, None));

    let now_ms = Utc::now().timestamp_millis();
    let seven_days_ms = 7 * 24 * 60 * 60 * 1000;
    if params.since.is_some_and(|since| {
        since <= 0 || since < now_ms - seven_days_ms || since > now_ms + 5 * 60 * 1000
    }) {
        return Err(AppError::BadRequest(
            "since must be a timestamp within the last seven days".into(),
        ));
    }
    let since_ms = calculate_since_ms(params.since, last_open, now_ms);

    let since_date = chrono::DateTime::from_timestamp_millis(since_ms)
        .map(|dt| dt.date_naive())
        .unwrap_or_else(|| Utc::now().date_naive());

    tracing::debug!(
        "list_emails since_ms={} since_date={} last_open={:?}",
        since_ms,
        since_date,
        last_open
    );

    tracing::debug!(
        "list_emails connecting to IMAP {}:{} for {}",
        account.imap_host,
        account.imap_port,
        account.email
    );

    let mut snapshot = state
        .mail
        .fetch_envelopes(&account.mail_credentials(), since_date)
        .await
        .map_err(|e| {
            tracing::error!("list_emails IMAP fetch failed for {}: {e}", account.email);
            e
        })?;

    // IMAP SINCE works at calendar-day granularity. Apply the requested instant
    // after fetching while retaining messages whose date cannot be parsed.
    snapshot.envelopes.retain(|email| {
        email
            .date
            .is_none_or(|date| date.timestamp_millis() >= since_ms)
    });

    let fetched_uid_validity = snapshot.uid_validity.map(i64::from);
    // A changed UIDVALIDITY means stored UIDs may now name different messages.
    // Seeing it for the first time (legacy or new accounts) is not a change.
    let uid_validity_changed =
        stored_uid_validity.is_some() && fetched_uid_validity != stored_uid_validity;
    if uid_validity_changed {
        watermark_uid = None;
        last_open = None;
        sqlx::query(
            "UPDATE accounts
             SET uid_validity = ?, watermark_uid = NULL, last_open = ?
             WHERE id = ?",
        )
        .bind(fetched_uid_validity)
        .bind(now_ms)
        .bind(&account.id)
        .execute(&state.db)
        .await?;
    } else if fetched_uid_validity != stored_uid_validity {
        sqlx::query("UPDATE accounts SET uid_validity = ? WHERE id = ?")
            .bind(fetched_uid_validity)
            .bind(&account.id)
            .execute(&state.db)
            .await?;
        // Bookmarks saved before UIDVALIDITY was tracked belong to this mailbox.
        sqlx::query(
            "UPDATE remembered SET uid_validity = ?
             WHERE account_id = ? AND uid_validity IS NULL",
        )
        .bind(fetched_uid_validity)
        .bind(&account.id)
        .execute(&state.db)
        .await?;
    }

    tracing::debug!(
        "list_emails fetched {} envelopes for {}",
        snapshot.envelopes.len(),
        account.email
    );

    // Only set last_open on first visit (when it was NULL).
    // Subsequent updates happen via the watermark save endpoint.
    if last_open.is_none() && !uid_validity_changed {
        sqlx::query("UPDATE accounts SET last_open = ? WHERE id = ?")
            .bind(now_ms)
            .bind(&account.id)
            .execute(&state.db)
            .await?;
    }

    Ok(Json(EmailListResponse {
        emails: snapshot.envelopes,
        since_timestamp: since_ms,
        last_open,
        watermark_uid,
    }))
}

pub async fn get_email(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(uid): Path<u32>,
) -> AppResult<Json<imap_client::FullEmail>> {
    let account = require_account(&state, &jar).await?;

    if uid == 0 {
        return Err(AppError::BadRequest("Invalid email UID".into()));
    }

    let email = state
        .mail
        .fetch_email(&account.mail_credentials(), uid)
        .await?;

    Ok(Json(email))
}

#[derive(Deserialize)]
pub struct WatermarkRequest {
    pub uid: i64,
}

pub async fn set_watermark(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<WatermarkRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let account = require_account(&state, &jar).await?;

    if req.uid <= 0 || req.uid > i64::from(u32::MAX) {
        return Err(AppError::BadRequest("Invalid email UID".into()));
    }

    let now_ms = Utc::now().timestamp_millis();
    sqlx::query("UPDATE accounts SET watermark_uid = ?, last_open = ? WHERE id = ?")
        .bind(req.uid)
        .bind(now_ms)
        .bind(&account.id)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn search_emails(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(params): Query<SearchQuery>,
) -> AppResult<Json<Vec<imap_client::EmailEnvelope>>> {
    let account = require_account(&state, &jar).await?;

    let query = params.q.trim();
    if query.is_empty() {
        return Err(AppError::BadRequest("Search query is required".into()));
    }

    let results = state
        .mail
        .search(&account.mail_credentials(), query)
        .await?;

    Ok(Json(results))
}
