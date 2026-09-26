use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Not authenticated")]
    Unauthorized,

    #[error("Invalid email or password")]
    InvalidCredentials,

    #[error("{0}")]
    NotFound(String),

    #[error("Too many attempts. Please wait a few minutes and try again.")]
    TooManyRequests,

    #[error("{0}")]
    Conflict(String),

    #[error("{0}")]
    BadRequest(String),

    /// The mail server was unreachable or failed an operation.
    #[error("Mail server error: {0}")]
    Imap(String),

    /// The mail server rejected the mailbox credentials.
    #[error("The mail server rejected this email and password: {0}")]
    MailAuth(String),

    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::Unauthorized | AppError::InvalidCredentials => {
                (StatusCode::UNAUTHORIZED, self.to_string())
            }
            AppError::NotFound(_) => (StatusCode::NOT_FOUND, self.to_string()),
            AppError::TooManyRequests => (StatusCode::TOO_MANY_REQUESTS, self.to_string()),
            AppError::MailAuth(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            AppError::Conflict(_) => (StatusCode::CONFLICT, self.to_string()),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            AppError::Imap(_) => (StatusCode::BAD_GATEWAY, self.to_string()),
            AppError::Database(_) => {
                tracing::error!("Database error: {self}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
            AppError::Internal(_) => {
                tracing::error!("Internal error: {self}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };

        let body = axum::Json(json!({ "error": message }));
        (status, body).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
