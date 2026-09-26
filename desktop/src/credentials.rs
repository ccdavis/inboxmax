//! Where the desktop app keeps IMAP passwords: the operating system's
//! credential store (macOS Keychain, Windows Credential Manager, or the
//! Secret Service on Linux), with an in-memory fallback when no store is
//! available.

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;

const SERVICE: &str = "app.inboxmax.desktop";

pub trait CredentialStore: Send + Sync {
    /// Save a password, returning an explanation if it could not be stored.
    fn save(&self, account: &str, password: &str) -> Result<(), String>;
    fn load(&self, account: &str) -> Option<String>;
    fn delete(&self, account: &str);
}

/// The operating system's credential store.
pub struct KeyringStore;

impl CredentialStore for KeyringStore {
    fn save(&self, account: &str, password: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, account)
            .and_then(|entry| entry.set_password(password))
            .map_err(|e| e.to_string())
    }

    fn load(&self, account: &str) -> Option<String> {
        match keyring::Entry::new(SERVICE, account).and_then(|entry| entry.get_password()) {
            Ok(password) => Some(password),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                tracing::warn!("Could not read the saved password for {account}: {e}");
                None
            }
        }
    }

    fn delete(&self, account: &str) {
        match keyring::Entry::new(SERVICE, account).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => tracing::warn!("Could not delete the saved password for {account}: {e}"),
        }
    }
}

/// A store that forgets everything when the app exits, for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    passwords: Mutex<HashMap<String, String>>,
}

#[cfg(test)]
impl CredentialStore for MemoryStore {
    fn save(&self, account: &str, password: &str) -> Result<(), String> {
        self.passwords
            .lock()
            .expect("credential lock poisoned")
            .insert(account.to_string(), password.to_string());
        Ok(())
    }

    fn load(&self, account: &str) -> Option<String> {
        self.passwords
            .lock()
            .expect("credential lock poisoned")
            .get(account)
            .cloned()
    }

    fn delete(&self, account: &str) {
        self.passwords
            .lock()
            .expect("credential lock poisoned")
            .remove(account);
    }
}

/// The OS store if one is usable, otherwise nothing: callers then keep
/// passwords only for the session and tell the user they were not saved.
pub fn system_store() -> Option<std::sync::Arc<dyn CredentialStore>> {
    if std::env::var("INBOXMAX_NO_KEYCHAIN").is_ok_and(|v| v == "1") {
        return None;
    }
    match keyring::Entry::store_status() {
        Ok(()) => Some(std::sync::Arc::new(KeyringStore)),
        Err(e) => {
            tracing::warn!("No OS credential store available; passwords will not be saved: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CredentialStore, MemoryStore};

    #[test]
    fn memory_store_round_trips() {
        let store = MemoryStore::default();
        assert_eq!(store.load("a"), None);
        store.save("a", "secret").unwrap();
        assert_eq!(store.load("a").as_deref(), Some("secret"));
        store.delete("a");
        assert_eq!(store.load("a"), None);
    }
}
