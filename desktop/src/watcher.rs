//! Watching for new mail while the app runs, whether or not its window is
//! showing: the page is told to refresh, and when the window is not the one
//! in use, a system notification says what came in.

use crate::state::DesktopState;
use chrono::{Duration, Utc};
use inboxmax_core::imap_client::{EmailEnvelope, MailboxSnapshot};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// How often each mailbox is checked; INBOXMAX_CHECK_SECONDS changes it.
const CHECK_SECONDS: u64 = 120;
/// Senders named in a notification about several messages.
const NAMED_SENDERS: usize = 2;

/// What has been seen of each mailbox: its UIDVALIDITY and newest UID.
#[derive(Default)]
pub struct Watcher {
    newest: HashMap<String, (Option<u32>, u32)>,
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
    }
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
    let seconds = std::env::var("INBOXMAX_CHECK_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
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
    if let Some(path) = std::env::var_os("INBOXMAX_NOTIFICATION_LOG") {
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
        let snapshot = match state
            .mail
            .fetch_envelopes(&account.mail_credentials(), since)
            .await
        {
            Ok(snapshot) => snapshot,
            Err(e) => {
                // Offline or refused: try again next time.
                tracing::debug!("Could not check {} for new mail: {e}", account.email);
                continue;
            }
        };
        let arrived = watcher.check(&account.id, &snapshot);
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
