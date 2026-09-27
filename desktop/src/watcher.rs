//! Watching for new mail while the app runs, whether or not its window is
//! showing: the page is told to refresh, and when the window is not the one
//! in use, a system notification says what came in.

use crate::state::DesktopState;
use chrono::{Duration, Utc};
use inboxmax_core::AppError;
use inboxmax_core::imap_client::{EmailEnvelope, MailboxSnapshot};
use serde::Serialize;
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// How often each mailbox is checked; INBOXMAX_CHECK_SECONDS changes it.
const CHECK_SECONDS: u64 = 120;
/// Senders named in a notification about several messages.
const NAMED_SENDERS: usize = 2;
/// How long a mailbox whose password was refused is left alone.
const REFUSED_PAUSE: std::time::Duration = std::time::Duration::from_secs(30 * 60);
/// How long mail put back in the inbox is kept from counting as new.
const RESTORED_WINDOW: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// What has been seen of each mailbox: its UIDVALIDITY and newest UID; and
/// the mailboxes whose server refused their password, which are left alone
/// for a while (trying again and again can lock an account) or until the
/// password changes.
#[derive(Default)]
pub struct Watcher {
    newest: HashMap<String, (Option<u32>, u32)>,
    /// Account id to a hash of the refused password, and when.
    refused: HashMap<String, (u64, Instant)>,
}

impl Watcher {
    /// Messages in `account_id`'s inbox newer than any seen before, newest
    /// first. The first look at a mailbox (and any look after its UIDs were
    /// renumbered) only notes where it is, so nothing already there counts.
    pub fn check(&mut self, account_id: &str, snapshot: &MailboxSnapshot) -> Vec<EmailEnvelope> {
        let newest = snapshot.envelopes.iter().map(|e| e.uid).max().unwrap_or(0);
        // The newest UID seen before, if those UIDs still mean the same messages.
        let seen = self
            .newest
            .get(account_id)
            .filter(|(validity, _)| *validity == snapshot.uid_validity)
            .map(|&(_, seen)| seen);
        let mut arrived: Vec<EmailEnvelope> = match seen {
            Some(seen) => snapshot
                .envelopes
                .iter()
                .filter(|e| e.uid > seen)
                .cloned()
                .collect(),
            None => Vec::new(),
        };
        self.newest.insert(
            account_id.to_string(),
            (snapshot.uid_validity, seen.unwrap_or(0).max(newest)),
        );
        arrived.sort_by_key(|e| std::cmp::Reverse(e.uid));
        arrived
    }

    /// Stop following mailboxes that are no longer open.
    pub fn retain(&mut self, open: &[String]) {
        self.newest.retain(|id, _| open.contains(id));
        self.refused.retain(|id, _| open.contains(id));
    }

    /// Note that the server refused this password for the mailbox.
    pub fn refused(&mut self, account_id: &str, password: &str, now: Instant) {
        self.refused
            .insert(account_id.to_string(), (password_hash(password), now));
    }

    /// Whether to check the mailbox: not for a while after its server
    /// refused the password still in use (a refusal can be passing: too
    /// many connections, say).
    pub fn may_check(&self, account_id: &str, password: &str, now: Instant) -> bool {
        match self.refused.get(account_id) {
            Some(&(hash, at)) => {
                hash != password_hash(password) || now.duration_since(at) >= REFUSED_PAUSE
            }
            None => true,
        }
    }
}

fn password_hash(password: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    password.hash(&mut hasher);
    hasher.finish()
}

/// `arrived` without messages the user just put back in the inbox (they
/// come back under new UIDs, but are not new mail); those are forgotten,
/// as is anything put back longer ago than a check or two.
pub fn without_restored(
    arrived: Vec<EmailEnvelope>,
    restored: &mut HashMap<String, Instant>,
    now: Instant,
) -> Vec<EmailEnvelope> {
    restored.retain(|_, at| now.duration_since(*at) < RESTORED_WINDOW);
    arrived
        .into_iter()
        .filter(|e| {
            !e.message_id
                .as_ref()
                .is_some_and(|id| restored.remove(id).is_some())
        })
        .collect()
}

fn sender(envelope: &EmailEnvelope) -> &str {
    let from = envelope.from.trim();
    if from.is_empty() {
        "Unknown sender"
    } else {
        from
    }
}

/// A notification's title and text for new mail in `mailbox`. With more than
/// one mailbox open, it says which one.
pub fn describe(
    mailbox: &str,
    arrived: &[EmailEnvelope],
    several_mailboxes: bool,
) -> (String, String) {
    let place = if several_mailboxes {
        format!(" in {mailbox}")
    } else {
        String::new()
    };
    if let [only] = arrived {
        let subject = if only.subject.trim().is_empty() {
            "(no subject)"
        } else {
            only.subject.trim()
        };
        let title = format!("{}{place}", sender(only));
        return (title, subject.to_string());
    }
    let mut senders: Vec<&str> = Vec::new();
    for envelope in arrived {
        if !senders.contains(&sender(envelope)) {
            senders.push(sender(envelope));
        }
    }
    let named = senders
        .iter()
        .take(NAMED_SENDERS)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    let body = match senders.len().saturating_sub(NAMED_SENDERS) {
        0 => format!("From {named}"),
        more => format!("From {named} and {more} more"),
    };
    (format!("{} new messages{place}", arrived.len()), body)
}

/// Told to the page when a mailbox has new mail, so it refreshes at once.
#[derive(Clone, Serialize)]
struct NewMail {
    account_id: String,
}

fn check_interval() -> std::time::Duration {
    let seconds = crate::test_setting("INBOXMAX_CHECK_SECONDS")
        .and_then(|s| s.to_str()?.parse().ok())
        .filter(|&s| s > 0)
        .unwrap_or(CHECK_SECONDS);
    std::time::Duration::from_secs(seconds)
}

/// Whether the person is using the Inbox Max window right now; if so the
/// inbox itself shows (and announces) the new mail.
fn window_in_use(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .is_some_and(|window| window.is_focused().unwrap_or(false))
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    // Tests read notifications from a file instead of the screen.
    if let Some(path) = crate::test_setting("INBOXMAX_NOTIFICATION_LOG") {
        let written = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| writeln!(file, "{title}\t{body}"));
        if let Err(e) = written {
            tracing::warn!("Could not log a notification: {e}");
        }
        return;
    }
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!("Could not show a notification: {e}");
    }
}

/// Check every open mailbox now, then every little while, for as long as
/// the app runs.
pub async fn run(app: AppHandle) {
    let mut watcher = Watcher::default();
    let interval = check_interval();
    loop {
        check_all(&app, &mut watcher).await;
        tokio::time::sleep(interval).await;
    }
}

async fn check_all(app: &AppHandle, watcher: &mut Watcher) {
    let state = app.state::<DesktopState>();
    let accounts = state.connected_accounts().await;
    watcher.retain(&accounts.iter().map(|a| a.id.clone()).collect::<Vec<_>>());
    // New mail is the newest mail: a day back is plenty.
    let since = (Utc::now() - Duration::days(1)).date_naive();
    for account in &accounts {
        if !watcher.may_check(&account.id, &account.password, Instant::now()) {
            continue;
        }
        let snapshot = match state
            .mail
            .fetch_envelopes(&account.mail_credentials(), since)
            .await
        {
            Ok(snapshot) => snapshot,
            Err(AppError::MailAuth(e)) => {
                // The page reports it when the mailbox is next used.
                tracing::info!("Stopped checking {} for new mail: {e}", account.email);
                watcher.refused(&account.id, &account.password, Instant::now());
                continue;
            }
            Err(e) => {
                // Offline, say: try again next time.
                tracing::debug!("Could not check {} for new mail: {e}", account.email);
                continue;
            }
        };
        let arrived = without_restored(
            watcher.check(&account.id, &snapshot),
            &mut state
                .restored
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            Instant::now(),
        );
        if arrived.is_empty() {
            continue;
        }
        let _ = app.emit(
            "new-mail",
            NewMail {
                account_id: account.id.clone(),
            },
        );
        if !window_in_use(app) {
            let (title, body) = describe(&account.email, &arrived, accounts.len() > 1);
            notify(app, &title, &body);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(uid: u32, from: &str, subject: &str) -> EmailEnvelope {
        EmailEnvelope {
            uid,
            subject: subject.into(),
            from: from.into(),
            date: None,
            message_id: None,
        }
    }

    fn snapshot(uids: &[u32], validity: u32) -> MailboxSnapshot {
        MailboxSnapshot {
            envelopes: uids.iter().map(|&uid| envelope(uid, "A", "S")).collect(),
            uid_validity: Some(validity),
        }
    }

    fn uids(envelopes: &[EmailEnvelope]) -> Vec<u32> {
        envelopes.iter().map(|e| e.uid).collect()
    }

    #[test]
    fn only_mail_newer_than_the_first_look_is_new() {
        let mut watcher = Watcher::default();
        assert!(watcher.check("work", &snapshot(&[1, 2, 3], 1)).is_empty());
        assert!(watcher.check("work", &snapshot(&[1, 2, 3], 1)).is_empty());
        assert_eq!(
            uids(&watcher.check("work", &snapshot(&[1, 2, 3, 4, 5], 1))),
            [5, 4]
        );
        assert!(
            watcher
                .check("work", &snapshot(&[1, 2, 3, 4, 5], 1))
                .is_empty()
        );
        // Deleting the newest does not make older mail new again.
        assert!(watcher.check("work", &snapshot(&[1, 2, 3], 1)).is_empty());
        assert_eq!(uids(&watcher.check("work", &snapshot(&[1, 6], 1))), [6]);
        // Each mailbox is followed separately.
        assert!(watcher.check("home", &snapshot(&[9], 1)).is_empty());
    }

    #[test]
    fn renumbered_or_reopened_mailboxes_start_over_quietly() {
        let mut watcher = Watcher::default();
        watcher.check("work", &snapshot(&[10, 11], 1));
        // New UIDVALIDITY: the numbers mean nothing now.
        assert!(watcher.check("work", &snapshot(&[1, 2, 3], 2)).is_empty());
        assert_eq!(
            uids(&watcher.check("work", &snapshot(&[1, 2, 3, 4], 2))),
            [4]
        );

        // Closed and opened again: a fresh first look.
        watcher.retain(&[]);
        assert!(
            watcher
                .check("work", &snapshot(&[1, 2, 3, 4, 5], 2))
                .is_empty()
        );
        // An empty inbox that then gets mail.
        assert!(watcher.check("empty", &snapshot(&[], 1)).is_empty());
        assert_eq!(uids(&watcher.check("empty", &snapshot(&[1], 1))), [1]);
    }

    #[test]
    fn a_refused_password_is_left_alone_for_a_while() {
        let start = Instant::now();
        let mut watcher = Watcher::default();
        assert!(watcher.may_check("work", "old", start));
        watcher.refused("work", "old", start);
        assert!(!watcher.may_check("work", "old", start + REFUSED_PAUSE / 2));
        // A refusal can pass (too many connections, say): later, try again.
        assert!(watcher.may_check("work", "old", start + REFUSED_PAUSE));
        assert!(watcher.may_check("work", "new", start), "reconnected");
        assert!(watcher.may_check("home", "old", start));
        // Closing the mailbox forgets it.
        watcher.retain(&[]);
        assert!(watcher.may_check("work", "old", start));
    }

    #[test]
    fn mail_put_back_in_the_inbox_is_not_new() {
        let now = Instant::now();
        let mut arrived = vec![envelope(7, "A", "Back"), envelope(8, "B", "New")];
        arrived[0].message_id = Some("back@x".into());
        arrived[1].message_id = Some("new@x".into());
        let mut restored = HashMap::from([("back@x".to_string(), now)]);
        assert_eq!(
            uids(&without_restored(arrived.clone(), &mut restored, now)),
            [8]
        );
        // Only the once: moved out and back in again later, it is noticed.
        assert!(restored.is_empty());
        assert_eq!(
            uids(&without_restored(arrived.clone(), &mut restored, now)),
            [7, 8]
        );
        // Nor is it kept for ever when the watcher never sees it come back.
        restored.insert("gone@x".into(), now);
        without_restored(Vec::new(), &mut restored, now + RESTORED_WINDOW);
        assert!(restored.is_empty());
    }

    #[test]
    fn a_notification_names_the_sender_or_senders() {
        let one = [envelope(5, "Sarah Chen", "Lunch?")];
        assert_eq!(
            describe("me@x.example", &one, false),
            ("Sarah Chen".into(), "Lunch?".into())
        );
        assert_eq!(
            describe("me@x.example", &[envelope(5, " ", "  ")], true),
            (
                "Unknown sender in me@x.example".into(),
                "(no subject)".into()
            )
        );

        let several = [
            envelope(9, "GitHub", "PR"),
            envelope(8, "Sarah Chen", "Lunch?"),
            envelope(7, "GitHub", "Issue"),
        ];
        assert_eq!(
            describe("me@x.example", &several, false),
            ("3 new messages".into(), "From GitHub, Sarah Chen".into())
        );
        let many = [
            envelope(9, "A", "1"),
            envelope(8, "B", "2"),
            envelope(7, "C", "3"),
            envelope(6, "D", "4"),
        ];
        assert_eq!(
            describe("me@x.example", &many, true),
            (
                "4 new messages in me@x.example".into(),
                "From A, B and 2 more".into()
            )
        );
    }
}
