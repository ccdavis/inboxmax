//! Inbox operations on one connected account: the "since last open" email
//! window, the last-seen watermark, search, and remembered (bookmarked) emails.
//! The web and desktop front ends expose these unchanged.

use crate::account::ConnectedAccount;
use crate::attachment::Attachment;
use crate::error::{AppError, AppResult};
use crate::imap_client::{EmailEnvelope, Folder, FolderInfo, FullEmail, MailAddress, MailFetcher};
use crate::outgoing::{OutgoingEmail, SendReceipt, SendRequest};
use crate::{contacts, drafts};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Serialize)]
pub struct EmailListResponse {
    pub emails: Vec<EmailEnvelope>,
    pub since_timestamp: i64,
    pub last_open: Option<i64>,
    pub watermark_uid: Option<i64>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct RememberedEmail {
    pub id: i64,
    pub email_uid: i64,
    pub subject: Option<String>,
    pub sender: Option<String>,
    pub date: Option<i64>,
    pub added_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct RememberRequest {
    pub subject: Option<String>,
    pub sender: Option<String>,
    pub date: Option<i64>,
}

/// Calculate the effective `since` timestamp for email listing: an explicit
/// cursor wins; else, for a last visit in the past week, everything since then
/// plus the day before it, so the mail already seen by then (the last-seen
/// marker and what came before it) is still shown below the new mail. Else
/// the last day.
pub fn calculate_since_ms(param_since: Option<i64>, last_open: Option<i64>, now_ms: i64) -> i64 {
    param_since.unwrap_or_else(|| {
        if let Some(lo) = last_open
            && lo > 0
            && lo > now_ms - 7 * DAY_MS
        {
            return (lo - DAY_MS).max(now_ms - 7 * DAY_MS);
        }
        // First visit or stale: fetch the last 24 hours.
        now_ms - DAY_MS
    })
}

fn validate_uid(uid: i64) -> AppResult<u32> {
    u32::try_from(uid)
        .ok()
        .filter(|uid| *uid > 0)
        .ok_or_else(|| AppError::BadRequest("Invalid email UID".into()))
}

/// Emails since `since` (or since the last visit), with the watermark.
pub async fn list_emails(
    db: &SqlitePool,
    mail: &dyn MailFetcher,
    account: &ConnectedAccount,
    since: Option<i64>,
) -> AppResult<EmailListResponse> {
    let (mut last_open, mut watermark_uid, stored_uid_validity): (
        Option<i64>,
        Option<i64>,
        Option<i64>,
    ) = sqlx::query_as("SELECT last_open, watermark_uid, uid_validity FROM accounts WHERE id = ?")
        .bind(&account.id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("Account not found".into()))?;

    let now_ms = Utc::now().timestamp_millis();
    if since.is_some_and(|since| {
        since <= 0 || since < now_ms - 7 * DAY_MS || since > now_ms + 5 * 60 * 1000
    }) {
        return Err(AppError::BadRequest(
            "since must be a timestamp within the last seven days".into(),
        ));
    }
    let since_ms = calculate_since_ms(since, last_open, now_ms);
    let since_date = chrono::DateTime::from_timestamp_millis(since_ms)
        .map(|dt| dt.date_naive())
        .unwrap_or_else(|| Utc::now().date_naive());

    tracing::debug!(
        "list_emails for {} since_ms={since_ms} since_date={since_date} last_open={last_open:?}",
        account.email
    );

    let mut snapshot = mail
        .fetch_envelopes(&account.mail_credentials(), since_date)
        .await
        .inspect_err(|e| tracing::error!("IMAP fetch failed for {}: {e}", account.email))?;

    // IMAP SINCE works at calendar-day granularity. Apply the requested instant
    // after fetching while retaining messages whose date cannot be parsed.
    snapshot.envelopes.retain(|email| {
        email
            .date
            .is_none_or(|date| date.timestamp_millis() >= since_ms)
    });

    let fetched_uid_validity = snapshot.uid_validity.map(i64::from);
    // A changed UIDVALIDITY means stored UIDs may now name different messages.
    // Seeing it for the first time (legacy or new accounts) is not a change.
    let uid_validity_changed =
        stored_uid_validity.is_some() && fetched_uid_validity != stored_uid_validity;
    if uid_validity_changed {
        watermark_uid = None;
        last_open = None;
        sqlx::query(
            "UPDATE accounts
             SET uid_validity = ?, watermark_uid = NULL, last_open = ?
             WHERE id = ?",
        )
        .bind(fetched_uid_validity)
        .bind(now_ms)
        .bind(&account.id)
        .execute(db)
        .await?;
    } else if fetched_uid_validity != stored_uid_validity {
        sqlx::query("UPDATE accounts SET uid_validity = ? WHERE id = ?")
            .bind(fetched_uid_validity)
            .bind(&account.id)
            .execute(db)
            .await?;
        // Bookmarks saved before UIDVALIDITY was tracked belong to this mailbox.
        sqlx::query(
            "UPDATE remembered SET uid_validity = ?
             WHERE account_id = ? AND uid_validity IS NULL",
        )
        .bind(fetched_uid_validity)
        .bind(&account.id)
        .execute(db)
        .await?;
    }

    // Only set last_open on first visit (when it was NULL).
    // Subsequent updates happen when the watermark is saved.
    if last_open.is_none() && !uid_validity_changed {
        sqlx::query("UPDATE accounts SET last_open = ? WHERE id = ?")
            .bind(now_ms)
            .bind(&account.id)
            .execute(db)
            .await?;
    }

    Ok(EmailListResponse {
        emails: snapshot.envelopes,
        since_timestamp: since_ms,
        last_open,
        watermark_uid,
    })
}

/// Open a message. Its sender (and Reply-To) join `user_id`'s address book.
pub async fn get_email(
    db: &SqlitePool,
    mail: &dyn MailFetcher,
    user_id: &str,
    account: &ConnectedAccount,
    uid: i64,
) -> AppResult<FullEmail> {
    let uid = validate_uid(uid)?;
    let email = mail.fetch_email(&account.mail_credentials(), uid).await?;
    let people: Vec<_> = email.from.iter().chain(&email.reply_to).cloned().collect();
    // The address book is a convenience; reading must not fail because of it.
    if let Err(e) = contacts::record_seen(db, user_id, &people, &[&account.email]).await {
        tracing::warn!("Could not update the address book: {e}");
    }
    Ok(email)
}

/// Where a restored message now is.
#[derive(Debug, Serialize)]
pub struct Restored {
    pub uid: u32,
}

/// Move a message out of the inbox, into Trash or the archive. Its
/// remembered entry goes too, since its UID no longer names it.
pub async fn move_email(
    db: &SqlitePool,
    mail: &dyn MailFetcher,
    account: &ConnectedAccount,
    uid: i64,
    to: Folder,
) -> AppResult<()> {
    let checked = validate_uid(uid)?;
    if !to.accepts_moves() {
        return Err(AppError::BadRequest(format!(
            "Mail cannot be moved to {}",
            to.label()
        )));
    }
    mail.move_message(&account.mail_credentials(), checked, to)
        .await?;
    if let Err(e) = forget(db, &account.id, uid).await {
        tracing::warn!("Could not forget a moved message: {e}");
    }
    Ok(())
}

/// Undo a move: bring the message with this Message-ID back to the inbox.
pub async fn restore_email(
    mail: &dyn MailFetcher,
    account: &ConnectedAccount,
    from: Folder,
    message_id: &str,
) -> AppResult<Restored> {
    if matches!(from, Folder::Sent | Folder::Drafts) {
        return Err(AppError::BadRequest(format!(
            "Mail in {} cannot be moved to the inbox",
            from.label()
        )));
    }
    let message_id = message_id
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>');
    if message_id.is_empty() {
        return Err(AppError::BadRequest(
            "This message cannot be found again to restore it".into(),
        ));
    }
    let uid = mail
        .restore_message(&account.mail_credentials(), from, message_id)
        .await?;
    Ok(Restored { uid })
}

/// The server folders the mailbox has, besides the inbox.
pub async fn list_folders(
    mail: &dyn MailFetcher,
    account: &ConnectedAccount,
) -> AppResult<Vec<FolderInfo>> {
    mail.list_folders(&account.mail_credentials()).await
}

/// The newest messages in a server folder.
pub async fn folder_emails(
    mail: &dyn MailFetcher,
    account: &ConnectedAccount,
    folder: Folder,
) -> AppResult<Vec<EmailEnvelope>> {
    mail.fetch_folder(&account.mail_credentials(), folder).await
}

/// A message in a server folder, left unread on the server.
pub async fn get_folder_email(
    mail: &dyn MailFetcher,
    account: &ConnectedAccount,
    folder: Folder,
    uid: i64,
) -> AppResult<FullEmail> {
    let uid = validate_uid(uid)?;
    mail.fetch_folder_email(&account.mail_credentials(), folder, uid)
        .await
}

pub async fn get_folder_attachment(
    mail: &dyn MailFetcher,
    account: &ConnectedAccount,
    folder: Folder,
    uid: i64,
    index: usize,
) -> AppResult<Attachment> {
    let uid = validate_uid(uid)?;
    mail.fetch_folder_attachment(&account.mail_credentials(), folder, uid, index)
        .await
}

/// One attachment of a message, by its position among the attachments.
pub async fn get_attachment(
    mail: &dyn MailFetcher,
    account: &ConnectedAccount,
    uid: i64,
    index: usize,
) -> AppResult<Attachment> {
    let uid = validate_uid(uid)?;
    mail.fetch_attachment(&account.mail_credentials(), uid, index)
        .await
}

/// Record `uid` as the last-seen email and the visit time.
pub async fn set_watermark(db: &SqlitePool, account: &ConnectedAccount, uid: i64) -> AppResult<()> {
    validate_uid(uid)?;
    sqlx::query("UPDATE accounts SET watermark_uid = ?, last_open = ? WHERE id = ?")
        .bind(uid)
        .bind(Utc::now().timestamp_millis())
        .bind(&account.id)
        .execute(db)
        .await?;
    Ok(())
}

/// Send a message from the account and file a copy in its Sent folder. The
/// recipients join `user_id`'s address book.
pub async fn send(
    db: &SqlitePool,
    mail: &dyn MailFetcher,
    user_id: &str,
    account: &ConnectedAccount,
    request: SendRequest,
) -> AppResult<SendReceipt> {
    let forward = request.forward.clone();
    let draft_id = request.draft_id.clone();
    let mut email = OutgoingEmail::new(MailAddress::new(None, &account.email), request)?;
    // A forward's attachments come straight from the original message.
    if let Some(forward) = forward {
        let uid = validate_uid(forward.uid)?;
        let mut originals = Vec::with_capacity(forward.indexes.len());
        let credentials = account.mail_credentials();
        for index in forward.indexes {
            originals.push(match forward.folder {
                Some(folder) => {
                    mail.fetch_folder_attachment(&credentials, folder, uid, index)
                        .await?
                }
                None => mail.fetch_attachment(&credentials, uid, index).await?,
            });
        }
        email.attach(originals)?;
    }
    let receipt = mail
        .send(&account.mail_credentials(), &account.smtp, &email)
        .await?;
    let recipients: Vec<_> = email.recipients().cloned().collect();
    // Sent is sent: a failed address-book update must not look like a failed send.
    if let Err(e) = contacts::record_sent(db, user_id, &recipients).await {
        tracing::warn!("Could not update the address book: {e}");
    }
    if let Some(draft_id) = draft_id
        && let Err(e) = drafts::delete(db, &account.id, &draft_id).await
    {
        tracing::warn!("Could not remove the sent message's draft: {e}");
    }
    Ok(receipt)
}

/// Search subjects and senders; returns the newest 50 matches.
pub async fn search(
    mail: &dyn MailFetcher,
    account: &ConnectedAccount,
    query: &str,
) -> AppResult<Vec<EmailEnvelope>> {
    let query = query.trim();
    if query.is_empty() {
        return Err(AppError::BadRequest("Search query is required".into()));
    }
    mail.search(&account.mail_credentials(), query).await
}

/// Remembered emails that still belong to the mailbox's current UIDVALIDITY.
pub async fn list_remembered(db: &SqlitePool, account_id: &str) -> AppResult<Vec<RememberedEmail>> {
    Ok(sqlx::query_as::<_, RememberedEmail>(
        "SELECT r.id, r.email_uid, r.subject, r.sender, r.date, r.added_at
         FROM remembered r
         JOIN accounts a ON a.id = r.account_id
         WHERE r.account_id = ? AND r.uid_validity = a.uid_validity
         ORDER BY r.added_at DESC",
    )
    .bind(account_id)
    .fetch_all(db)
    .await?)
}

pub async fn remember(
    db: &SqlitePool,
    account_id: &str,
    uid: i64,
    req: RememberRequest,
) -> AppResult<()> {
    validate_uid(uid)?;
    let uid_validity: Option<i64> =
        sqlx::query_scalar("SELECT uid_validity FROM accounts WHERE id = ?")
            .bind(account_id)
            .fetch_optional(db)
            .await?
            .flatten();
    let uid_validity = uid_validity.ok_or_else(|| {
        AppError::BadRequest("Mailbox must be refreshed before remembering messages".into())
    })?;

    sqlx::query(
        "INSERT INTO remembered
            (account_id, email_uid, subject, sender, date, uid_validity)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, email_uid) DO UPDATE SET
           subject = excluded.subject,
           sender = excluded.sender,
           date = excluded.date,
           uid_validity = excluded.uid_validity",
    )
    .bind(account_id)
    .bind(uid)
    .bind(&req.subject)
    .bind(&req.sender)
    .bind(req.date)
    .bind(uid_validity)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn forget(db: &SqlitePool, account_id: &str, uid: i64) -> AppResult<()> {
    validate_uid(uid)?;
    sqlx::query("DELETE FROM remembered WHERE account_id = ? AND email_uid = ?")
        .bind(account_id)
        .bind(uid)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{DAY_MS, calculate_since_ms, validate_uid};

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn since_prefers_explicit_then_recent_last_open_then_one_day() {
        assert_eq!(
            calculate_since_ms(Some(NOW - 5), Some(NOW - 1000), NOW),
            NOW - 5
        );
        // A day before the last visit, for the mail already seen by then...
        assert_eq!(
            calculate_since_ms(None, Some(NOW - 1000), NOW),
            NOW - 1000 - DAY_MS
        );
        // ...but never more than a week back.
        assert_eq!(
            calculate_since_ms(None, Some(NOW - 13 * DAY_MS / 2), NOW),
            NOW - 7 * DAY_MS
        );
        assert_eq!(
            calculate_since_ms(None, Some(NOW - 8 * DAY_MS), NOW),
            NOW - DAY_MS
        );
        assert_eq!(calculate_since_ms(None, None, NOW), NOW - DAY_MS);
        assert_eq!(calculate_since_ms(None, Some(0), NOW), NOW - DAY_MS);
        assert_eq!(calculate_since_ms(None, Some(-1), NOW), NOW - DAY_MS);
    }

    #[test]
    fn uids_must_be_positive_u32() {
        assert_eq!(validate_uid(7).unwrap(), 7);
        assert!(validate_uid(0).is_err());
        assert!(validate_uid(-1).is_err());
        assert!(validate_uid(i64::from(u32::MAX) + 1).is_err());
    }
}
