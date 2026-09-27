#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
}

/// SMTP submission with STARTTLS; port 465 (implicit TLS) also works when
/// set explicitly.
pub const DEFAULT_SMTP_PORT: u16 = 587;

fn known(imap_host: &str, smtp_host: &str) -> Option<ProviderConfig> {
    Some(ProviderConfig {
        imap_host: imap_host.into(),
        imap_port: 993,
        smtp_host: smtp_host.into(),
        smtp_port: DEFAULT_SMTP_PORT,
    })
}

/// Return known-good IMAP and SMTP settings for providers we explicitly recognize.
pub fn detect_provider(email: &str) -> Option<ProviderConfig> {
    let (_, domain) = email.rsplit_once('@')?;
    let domain = domain.to_lowercase();

    match domain.as_str() {
        "gmail.com" | "googlemail.com" => known("imap.gmail.com", "smtp.gmail.com"),
        "outlook.com" | "hotmail.com" | "live.com" => {
            known("outlook.office365.com", "smtp-mail.outlook.com")
        }
        "yahoo.com" | "ymail.com" => known("imap.mail.yahoo.com", "smtp.mail.yahoo.com"),
        "icloud.com" | "me.com" | "mac.com" => known("imap.mail.me.com", "smtp.mail.me.com"),
        "aol.com" => known("imap.aol.com", "smtp.aol.com"),
        _ => None,
    }
}

/// Conventional fallback for providers that are not explicitly recognized.
pub fn guess_provider(email: &str) -> Option<ProviderConfig> {
    let (_, domain) = email.rsplit_once('@')?;
    let domain = domain.to_lowercase();
    Some(ProviderConfig {
        imap_host: format!("imap.{domain}"),
        imap_port: 993,
        smtp_host: format!("smtp.{domain}"),
        smtp_port: DEFAULT_SMTP_PORT,
    })
}

/// Whether the provider files messages sent through this SMTP server in the
/// Sent folder itself, so the app must not add a second copy.
pub fn server_files_sent_mail(smtp_host: &str) -> bool {
    matches!(
        smtp_host.to_ascii_lowercase().as_str(),
        "smtp.gmail.com" | "smtp-mail.outlook.com" | "smtp.office365.com"
    )
}

#[cfg(test)]
mod tests {
    use super::{detect_provider, guess_provider, server_files_sent_mail};

    #[test]
    fn detection_distinguishes_known_providers_from_guesses() {
        let gmail = detect_provider("user@gmail.com").unwrap();
        assert_eq!(
            (gmail.imap_host.as_str(), gmail.smtp_host.as_str()),
            ("imap.gmail.com", "smtp.gmail.com")
        );
        assert!(detect_provider("user@example.com").is_none());
        let guess = guess_provider("user@Example.com").unwrap();
        assert_eq!(
            (
                guess.imap_host.as_str(),
                guess.smtp_host.as_str(),
                guess.smtp_port
            ),
            ("imap.example.com", "smtp.example.com", 587)
        );
        assert!(guess_provider("not-an-email").is_none());
    }

    #[test]
    fn only_some_providers_file_sent_mail_themselves() {
        assert!(server_files_sent_mail("SMTP.gmail.com"));
        assert!(!server_files_sent_mail("smtp.mail.me.com"));
        assert!(!server_files_sent_mail("smtp.example.com"));
    }
}
