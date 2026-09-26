use serde::ser::{Serialize, SerializeStruct, Serializer};

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

impl AppError {
    /// HTTP-style status code, shared by the web API and desktop IPC errors.
    pub fn status(&self) -> u16 {
        match self {
            AppError::Unauthorized | AppError::InvalidCredentials => 401,
            AppError::NotFound(_) => 404,
            AppError::TooManyRequests => 429,
            AppError::MailAuth(_) | AppError::BadRequest(_) => 400,
            AppError::Conflict(_) => 409,
            AppError::Imap(_) => 502,
            AppError::Database(_) | AppError::Internal(_) => 500,
        }
    }

    /// Message that is safe to show to the user. Storage and internal
    /// failures are logged and replaced with a generic message.
    pub fn public_message(&self) -> String {
        match self {
            AppError::Database(_) | AppError::Internal(_) => {
                tracing::error!("{self}");
                "Internal server error".to_string()
            }
            _ => self.to_string(),
        }
    }
}

/// Serialized as `{ "status": 404, "message": "..." }` for desktop IPC.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("AppError", 2)?;
        error.serialize_field("status", &self.status())?;
        error.serialize_field("message", &self.public_message())?;
        error.end()
    }
}

#[cfg(feature = "axum")]
impl axum::response::IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let status = axum::http::StatusCode::from_u16(self.status())
            .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
        let body = axum::Json(serde_json::json!({ "error": self.public_message() }));
        (status, body).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
