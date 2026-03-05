use crate::error::AppResult;
use crate::handlers::auth::require_account;
use crate::imap_client;
use crate::AppState;
use axum::extract::{Path, Query, State};
use axum::Json;
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
        if let Some(lo) = last_open {
            if lo > 0 {
                let seven_days_ago = now_ms - (7 * 24 * 60 * 60 * 1000);
                if lo > seven_days_ago {
                    return lo;
                }
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

    let (last_open, watermark_uid): (Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT last_open, watermark_uid FROM accounts WHERE id = ?",
    )
    .bind(&account.id)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or((None, None));

    let now_ms = Utc::now().timestamp_millis();
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

    let envelopes = state
        .mail
        .fetch_envelopes(
            &account.imap_host,
            account.imap_port,
            &account.email,
            &account.password,
            since_date,
        )
        .await
        .map_err(|e| {
            tracing::error!("list_emails IMAP fetch failed for {}: {e}", account.email);
            e
        })?;

    tracing::debug!(
        "list_emails fetched {} envelopes for {}",
        envelopes.len(),
        account.email
    );

    // Only set last_open on first visit (when it was NULL).
    // Subsequent updates happen via the watermark save endpoint.
    if last_open.is_none() {
        sqlx::query("UPDATE accounts SET last_open = ? WHERE id = ?")
            .bind(now_ms)
            .bind(&account.id)
            .execute(&state.db)
            .await?;
    }

    Ok(Json(EmailListResponse {
        emails: envelopes,
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

    let email = state
        .mail
        .fetch_email(
            &account.imap_host,
            account.imap_port,
            &account.email,
            &account.password,
            uid,
        )
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

    let results = state
        .mail
        .search(
            &account.imap_host,
            account.imap_port,
            &account.email,
            &account.password,
            &params.q,
        )
        .await?;

    Ok(Json(results))
}
