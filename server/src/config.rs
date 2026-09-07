use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub imap_host: String,
    pub imap_port: u16,
}

/// Return known-good IMAP settings for providers we explicitly recognize.
pub fn detect_provider(email: &str) -> Option<ProviderConfig> {
    let (_, domain) = email.rsplit_once('@')?;
    let domain = domain.to_lowercase();

    match domain.as_str() {
        "gmail.com" | "googlemail.com" => Some(ProviderConfig {
            imap_host: "imap.gmail.com".into(),
            imap_port: 993,
        }),
        "outlook.com" | "hotmail.com" | "live.com" => Some(ProviderConfig {
            imap_host: "outlook.office365.com".into(),
            imap_port: 993,
        }),
        "yahoo.com" | "ymail.com" => Some(ProviderConfig {
            imap_host: "imap.mail.yahoo.com".into(),
            imap_port: 993,
        }),
        "icloud.com" | "me.com" | "mac.com" => Some(ProviderConfig {
            imap_host: "imap.mail.me.com".into(),
            imap_port: 993,
        }),
        "aol.com" => Some(ProviderConfig {
            imap_host: "imap.aol.com".into(),
            imap_port: 993,
        }),
        _ => None,
    }
}

/// Conventional fallback for providers that are not explicitly recognized.
pub fn guess_provider(email: &str) -> Option<ProviderConfig> {
    let (_, domain) = email.rsplit_once('@')?;
    Some(ProviderConfig {
        imap_host: format!("imap.{}", domain.to_lowercase()),
        imap_port: 993,
    })
}

#[cfg(test)]
mod tests {
    use super::{detect_provider, guess_provider};

    #[test]
    fn detection_distinguishes_known_providers_from_guesses() {
        assert_eq!(
            detect_provider("user@gmail.com").unwrap().imap_host,
            "imap.gmail.com"
        );
        assert!(detect_provider("user@example.com").is_none());
        assert_eq!(
            guess_provider("user@example.com").unwrap().imap_host,
            "imap.example.com"
        );
        assert!(guess_provider("not-an-email").is_none());
    }
}
