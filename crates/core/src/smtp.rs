//! Submitting mail over SMTP, with the same public-address rule as IMAP so a
//! server cannot be pointed at the private network.

use crate::error::{AppError, AppResult};
use crate::imap_client::{MailCredentials, SmtpServer, resolve_public_address};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use std::time::Duration;

const SMTP_TIMEOUT: Duration = Duration::from_secs(30);
/// SMTP over implicit TLS; every other port uses STARTTLS, which is required.
const IMPLICIT_TLS_PORT: u16 = 465;

/// Send `message` through the account's SMTP server, signing in with the
/// mailbox address and password.
pub async fn send(
    credentials: &MailCredentials,
    smtp: &SmtpServer,
    message: Message,
) -> AppResult<()> {
    let address = resolve_public_address(&smtp.host, smtp.port).await?;
    // Connect to the checked address but verify the certificate for the name.
    let parameters = TlsParameters::new(smtp.host.clone())
        .map_err(|e| AppError::Imap(format!("TLS setup failed: {e}")))?;
    let tls = if smtp.port == IMPLICIT_TLS_PORT {
        Tls::Wrapper(parameters)
    } else {
        Tls::Required(parameters)
    };
    let transport =
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(address.ip().to_string())
            .port(address.port())
            .tls(tls)
            .credentials(Credentials::new(
                credentials.email.clone(),
                credentials.password.clone(),
            ))
            .timeout(Some(SMTP_TIMEOUT))
            .build();
    transport
        .send(message)
        .await
        .map(|_| ())
        .map_err(|e| send_error(&e))
}

fn send_error(error: &lettre::transport::smtp::Error) -> AppError {
    let code = error.status().map(|code| code.to_string());
    match code.as_deref() {
        // Authentication required / too weak / credentials invalid.
        Some("530" | "534" | "535") => AppError::MailAuth(format!("sending was refused: {error}")),
        _ if error.is_permanent() => {
            AppError::BadRequest(format!("The mail server refused the message: {error}"))
        }
        _ => AppError::Imap(format!("Sending failed: {error}")),
    }
}
