//! The desktop app's single local profile: its database, mailbox access,
//! and the accounts whose passwords are available.

use crate::credentials::CredentialStore;
use inboxmax_core::account::{self, AccountStatus};
use inboxmax_core::imap_client::MailFetcher;
use inboxmax_core::{AppError, AppResult, ConnectedAccount};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Owner of every account in the desktop database. The desktop app has no
/// sign-in; the operating-system user account is the boundary.
pub const LOCAL_USER_ID: &str = "local";

pub struct DesktopState {
    pub db: SqlitePool,
    pub mail: Arc<dyn MailFetcher>,
    /// Accounts whose password is known this run, by account id.
    connected: RwLock<HashMap<String, ConnectedAccount>>,
    /// The OS credential store, if one is usable. Passwords that are not
    /// saved there live only in `connected`, for this run of the app.
    saved: Option<Arc<dyn CredentialStore>>,
    /// Emails whose password is in the OS store, so listing accounts never
    /// touches the keychain (which may prompt or block).
    saved_emails: RwLock<HashSet<String>>,
}

/// Run a (blocking, possibly prompting) credential-store call off the async runtime.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(f)
        .await
        .expect("credential store task panicked")
}

impl DesktopState {
    /// Prepare the local profile and reconnect accounts whose passwords
    /// were saved in the OS credential store.
    pub async fn load(
        db: SqlitePool,
        mail: Arc<dyn MailFetcher>,
        saved: Option<Arc<dyn CredentialStore>>,
    ) -> AppResult<Self> {
        // The password hash is not a valid PHC string, so the local profile
        // can never be used to sign in to a web server sharing the database.
        sqlx::query(
            "INSERT OR IGNORE INTO users (id, email, password_hash, display_name)
             VALUES (?, 'local@inboxmax.invalid', '!', 'This computer')",
        )
        .bind(LOCAL_USER_ID)
        .execute(&db)
        .await?;

        let state = Self {
            db,
            mail,
            connected: RwLock::new(HashMap::new()),
            saved,
            saved_emails: RwLock::new(HashSet::new()),
        };
        if let Some(store) = state.saved.clone() {
            let mut connected = state.connected.write().await;
            let mut saved_emails = state.saved_emails.write().await;
            for record in account::list_accounts(&state.db, LOCAL_USER_ID).await? {
                let (store, email) = (store.clone(), record.email.clone());
                if let Some(password) = blocking(move || store.load(&email)).await {
                    saved_emails.insert(record.email.clone());
                    let port = u16::try_from(record.imap_port).unwrap_or(993);
                    connected.insert(
                        record.id.clone(),
                        ConnectedAccount {
                            id: record.id,
                            email: record.email,
                            password,
                            imap_host: record.imap_host,
                            imap_port: port,
                        },
                    );
                }
            }
        }
        Ok(state)
    }

    pub fn can_save_passwords(&self) -> bool {
        self.saved.is_some()
    }

    pub async fn list_accounts(&self) -> AppResult<Vec<AccountStatus>> {
        let connected = self.connected.read().await;
        let saved_emails = self.saved_emails.read().await;
        Ok(account::list_accounts(&self.db, LOCAL_USER_ID)
            .await?
            .into_iter()
            .map(|record| AccountStatus {
                connected: connected.contains_key(&record.id),
                password_saved: saved_emails.contains(&record.email),
                id: record.id,
                email: record.email,
            })
            .collect())
    }

    /// Remember a verified account's password, in the OS store when asked
    /// and possible. Returns whether it was saved to the OS store.
    pub async fn add_connected(&self, account: ConnectedAccount, remember: bool) -> bool {
        let saved = match self.saved.clone() {
            Some(store) => {
                let (email, password) = (account.email.clone(), account.password.clone());
                let result = blocking(move || {
                    if remember {
                        store.save(&email, &password)
                    } else {
                        // The user opted out: drop any password saved earlier.
                        store.delete(&email);
                        Err("not requested".into())
                    }
                })
                .await;
                if let Err(e) = &result
                    && remember
                {
                    tracing::warn!("Could not save the password for {}: {e}", account.email);
                }
                result.is_ok()
            }
            None => false,
        };
        let mut saved_emails = self.saved_emails.write().await;
        if saved {
            saved_emails.insert(account.email.clone());
        } else {
            saved_emails.remove(&account.email);
        }
        drop(saved_emails);
        self.connected
            .write()
            .await
            .insert(account.id.clone(), account);
        saved
    }

    pub async fn require_account(&self, account_id: &str) -> AppResult<ConnectedAccount> {
        if let Some(account) = self.connected.read().await.get(account_id) {
            return Ok(account.clone());
        }
        // Known but locked accounts ask the client to reconnect; unknown ids are 404.
        account::find_account(&self.db, LOCAL_USER_ID, account_id).await?;
        Err(AppError::Unauthorized)
    }

    pub async fn remove_account(&self, account_id: &str) -> AppResult<()> {
        let record = account::find_account(&self.db, LOCAL_USER_ID, account_id).await?;
        account::delete_account(&self.db, LOCAL_USER_ID, account_id).await?;
        if let Some(store) = self.saved.clone() {
            let email = record.email.clone();
            blocking(move || store.delete(&email)).await;
        }
        self.saved_emails.write().await.remove(&record.email);
        self.connected.write().await.remove(account_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryStore;
    use inboxmax_core::account::ConnectRequest;
    use inboxmax_core::imap_client::{EmailEnvelope, FullEmail, MailCredentials, MailboxSnapshot};

    struct AcceptAll;

    #[async_trait::async_trait]
    impl MailFetcher for AcceptAll {
        async fn fetch_envelopes(
            &self,
            _: &MailCredentials,
            _: chrono::NaiveDate,
        ) -> AppResult<MailboxSnapshot> {
            Ok(MailboxSnapshot {
                envelopes: vec![],
                uid_validity: Some(1),
            })
        }
        async fn fetch_email(&self, _: &MailCredentials, _: u32) -> AppResult<FullEmail> {
            Err(AppError::NotFound("none".into()))
        }
        async fn search(&self, _: &MailCredentials, _: &str) -> AppResult<Vec<EmailEnvelope>> {
            Ok(vec![])
        }
        async fn verify_credentials(&self, _: &MailCredentials) -> AppResult<()> {
            Ok(())
        }
    }

    async fn db() -> SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        inboxmax_core::db::MIGRATOR.run(&db).await.unwrap();
        db
    }

    async fn connect(state: &DesktopState, email: &str, remember: bool) -> (String, bool) {
        let outcome = account::connect_account(
            &state.db,
            state.mail.as_ref(),
            LOCAL_USER_ID,
            ConnectRequest {
                email: email.into(),
                password: "pw".into(),
                imap_host: Some("imap.example.com".into()),
                imap_port: None,
            },
        )
        .await
        .unwrap();
        let id = outcome.account.id.clone();
        (id, state.add_connected(outcome.account, remember).await)
    }

    #[tokio::test]
    async fn saved_passwords_reconnect_on_the_next_launch() {
        let db = db().await;
        let store: Arc<dyn CredentialStore> = Arc::new(MemoryStore::default());
        let state = DesktopState::load(db.clone(), Arc::new(AcceptAll), Some(store))
            .await
            .unwrap();
        let (saved_id, saved) = connect(&state, "saved@example.com", true).await;
        let (_, unsaved) = connect(&state, "session@example.com", false).await;
        assert!(saved);
        assert!(!unsaved);

        // Simulate a relaunch that shares the same OS store.
        let DesktopState { saved: store, .. } = state;
        let relaunched = DesktopState::load(db, Arc::new(AcceptAll), store)
            .await
            .unwrap();
        let accounts = relaunched.list_accounts().await.unwrap();
        let status: Vec<_> = accounts
            .iter()
            .map(|a| (a.email.as_str(), a.connected))
            .collect();
        assert_eq!(
            status,
            [("saved@example.com", true), ("session@example.com", false)]
        );
        assert!(relaunched.require_account(&saved_id).await.is_ok());
    }

    #[tokio::test]
    async fn locked_and_unknown_accounts_are_distinguished() {
        let state = DesktopState::load(db().await, Arc::new(AcceptAll), None)
            .await
            .unwrap();
        assert!(!state.can_save_passwords());
        let (id, saved) = connect(&state, "me@example.com", true).await;
        assert!(!saved, "nothing to save to without an OS store");
        assert!(state.require_account(&id).await.is_ok());

        state.remove_account(&id).await.unwrap();
        assert!(matches!(
            state.require_account(&id).await,
            Err(AppError::NotFound(_))
        ));
        assert!(state.list_accounts().await.unwrap().is_empty());
    }
}
