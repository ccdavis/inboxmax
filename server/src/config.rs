use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
}

/// Auto-detect IMAP/SMTP settings from email domain.
pub fn detect_provider(email: &str) -> Option<ProviderConfig> {
    let domain = email.rsplit('@').next()?.to_lowercase();

    match domain.as_str() {
        "gmail.com" | "googlemail.com" => Some(ProviderConfig {
            imap_host: "imap.gmail.com".into(),
            imap_port: 993,
            smtp_host: "smtp.gmail.com".into(),
            smtp_port: 587,
        }),
        "outlook.com" | "hotmail.com" | "live.com" => Some(ProviderConfig {
            imap_host: "outlook.office365.com".into(),
            imap_port: 993,
            smtp_host: "smtp.office365.com".into(),
            smtp_port: 587,
        }),
        "yahoo.com" | "ymail.com" => Some(ProviderConfig {
            imap_host: "imap.mail.yahoo.com".into(),
            imap_port: 993,
            smtp_host: "smtp.mail.yahoo.com".into(),
            smtp_port: 587,
        }),
        "icloud.com" | "me.com" | "mac.com" => Some(ProviderConfig {
            imap_host: "imap.mail.me.com".into(),
            imap_port: 993,
            smtp_host: "smtp.mail.me.com".into(),
            smtp_port: 587,
        }),
        "aol.com" => Some(ProviderConfig {
            imap_host: "imap.aol.com".into(),
            imap_port: 993,
            smtp_host: "smtp.aol.com".into(),
            smtp_port: 587,
        }),
        // Fallback: guess from domain
        _ => Some(ProviderConfig {
            imap_host: format!("imap.{domain}"),
            imap_port: 993,
            smtp_host: format!("smtp.{domain}"),
            smtp_port: 587,
        }),
    }
}
