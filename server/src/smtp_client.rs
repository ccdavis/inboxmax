use crate::error::{AppError, AppResult};
use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

pub async fn send_reply(
    smtp_host: &str,
    smtp_port: u16,
    email: &str,
    password: &str,
    to: &str,
    subject: &str,
    body: &str,
    in_reply_to: Option<&str>,
) -> AppResult<()> {
    let creds = Credentials::new(email.to_string(), password.to_string());

    let mailer = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(smtp_host)
        .map_err(|e| AppError::Smtp(format!("SMTP relay error: {e}")))?
        .port(smtp_port)
        .credentials(creds)
        .build();

    let mut builder = Message::builder()
        .from(
            email
                .parse()
                .map_err(|e| AppError::Smtp(format!("Invalid from address: {e}")))?,
        )
        .to(to
            .parse()
            .map_err(|e| AppError::Smtp(format!("Invalid to address: {e}")))?)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN);

    if let Some(msg_id) = in_reply_to {
        builder = builder.in_reply_to(msg_id.to_string());
    }

    let message = builder
        .body(body.to_string())
        .map_err(|e| AppError::Smtp(format!("Message build error: {e}")))?;

    mailer
        .send(message)
        .await
        .map_err(|e| AppError::Smtp(format!("Send failed: {e}")))?;

    Ok(())
}
