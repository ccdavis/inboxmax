use crate::AppState;
use crate::error::AppResult;
use crate::handlers::auth::{require_account, require_user_and_account};
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum_extra::extract::CookieJar;
use inboxmax_core::attachment;
use inboxmax_core::attachment::Attachment;
use inboxmax_core::imap_client::{EmailEnvelope, FullEmail};
use inboxmax_core::imap_client::{Folder, FolderInfo};
use inboxmax_core::mailbox::{self, EmailListResponse, Restored};
use inboxmax_core::outgoing::{SendReceipt, SendRequest};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ListQuery {
    pub since: Option<i64>,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

#[derive(Deserialize)]
pub struct WatermarkRequest {
    pub uid: i64,
}

#[derive(Deserialize)]
pub struct MoveRequest {
    pub to: Folder,
}

#[derive(Deserialize)]
pub struct RestoreRequest {
    pub from: Folder,
    pub message_id: String,
}

/// POST /api/accounts/{account_id}/emails/{uid}/move — to Trash or the archive.
pub async fn move_email(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((account_id, uid)): Path<(String, i64)>,
    Json(request): Json<MoveRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let account = require_account(&state, &jar, &account_id).await?;
    mailbox::move_email(&state.db, state.mail.as_ref(), &account, uid, request.to).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// POST /api/accounts/{account_id}/restore — undo a move.
pub async fn restore_email(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
    Json(request): Json<RestoreRequest>,
) -> AppResult<Json<Restored>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(
        mailbox::restore_email(
            state.mail.as_ref(),
            &account,
            request.from,
            &request.message_id,
        )
        .await?,
    ))
}

/// GET /api/accounts/{account_id}/emails?since=
pub async fn list_emails(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
    Query(params): Query<ListQuery>,
) -> AppResult<Json<EmailListResponse>> {
    let account = require_account(&state, &jar, &account_id).await?;
    let emails =
        mailbox::list_emails(&state.db, state.mail.as_ref(), &account, params.since).await?;
    Ok(Json(emails))
}

/// GET /api/accounts/{account_id}/emails/{uid}
pub async fn get_email(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((account_id, uid)): Path<(String, i64)>,
) -> AppResult<Json<FullEmail>> {
    let (user, account) = require_user_and_account(&state, &jar, &account_id).await?;
    Ok(Json(
        mailbox::get_email(&state.db, state.mail.as_ref(), &user.user_id, &account, uid).await?,
    ))
}

/// GET /api/accounts/{account_id}/emails/{uid}/attachments/{index} — always
/// served as a download, never shown in the page.
pub async fn download_attachment(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((account_id, uid, index)): Path<(String, i64, usize)>,
) -> AppResult<Response> {
    let account = require_account(&state, &jar, &account_id).await?;
    let attachment = mailbox::get_attachment(state.mail.as_ref(), &account, uid, index).await?;
    Ok(download(attachment))
}

/// GET /api/accounts/{account_id}/folders
pub async fn list_folders(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
) -> AppResult<Json<Vec<FolderInfo>>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(
        mailbox::list_folders(state.mail.as_ref(), &account).await?,
    ))
}

/// GET /api/accounts/{account_id}/folders/{folder}/emails
pub async fn folder_emails(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((account_id, folder)): Path<(String, Folder)>,
) -> AppResult<Json<Vec<EmailEnvelope>>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(
        mailbox::folder_emails(state.mail.as_ref(), &account, folder).await?,
    ))
}

/// GET /api/accounts/{account_id}/folders/{folder}/emails/{uid}
pub async fn get_folder_email(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((account_id, folder, uid)): Path<(String, Folder, i64)>,
) -> AppResult<Json<FullEmail>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(
        mailbox::get_folder_email(state.mail.as_ref(), &account, folder, uid).await?,
    ))
}

/// GET /api/accounts/{account_id}/folders/{folder}/emails/{uid}/attachments/{index}
pub async fn download_folder_attachment(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((account_id, folder, uid, index)): Path<(String, Folder, i64, usize)>,
) -> AppResult<Response> {
    let account = require_account(&state, &jar, &account_id).await?;
    let attachment =
        mailbox::get_folder_attachment(state.mail.as_ref(), &account, folder, uid, index).await?;
    Ok(download(attachment))
}

/// An attachment as a download, never shown in the page.
fn download(attachment: Attachment) -> Response {
    let content_type = HeaderValue::from_str(&attachment.content_type)
        .unwrap_or(HeaderValue::from_static("application/octet-stream"));
    let disposition = HeaderValue::from_str(&attachment::content_disposition(&attachment.filename))
        .unwrap_or(HeaderValue::from_static("attachment"));
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_DISPOSITION, disposition),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            // Even if a browser displayed it, it could run nothing.
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("sandbox"),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, no-store"),
            ),
        ],
        attachment.data,
    )
        .into_response()
}

/// PUT /api/accounts/{account_id}/watermark
pub async fn set_watermark(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
    Json(req): Json<WatermarkRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let account = require_account(&state, &jar, &account_id).await?;
    mailbox::set_watermark(&state.db, &account, req.uid).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// POST /api/accounts/{account_id}/send
pub async fn send_email(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
    Json(request): Json<SendRequest>,
) -> AppResult<Json<SendReceipt>> {
    let (user, account) = require_user_and_account(&state, &jar, &account_id).await?;
    Ok(Json(
        mailbox::send(
            &state.db,
            state.mail.as_ref(),
            &user.user_id,
            &account,
            request,
        )
        .await?,
    ))
}

/// GET /api/accounts/{account_id}/search?q=
pub async fn search_emails(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(account_id): Path<String>,
    Query(params): Query<SearchQuery>,
) -> AppResult<Json<Vec<EmailEnvelope>>> {
    let account = require_account(&state, &jar, &account_id).await?;
    Ok(Json(
        mailbox::search(state.mail.as_ref(), &account, &params.q).await?,
    ))
}
