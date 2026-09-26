//! The address book: names for the addresses a user sends to and reads mail
//! from, for suggestions while addressing a message. Every entry is one
//! address, so someone who writes from two addresses has two entries and
//! suggestions always say which is which.

use crate::account::normalize_email;
use crate::error::{AppError, AppResult};
use crate::imap_client::MailAddress;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// Suggestions returned for one query.
pub const SUGGESTION_LIMIT: i64 = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct Contact {
    pub id: i64,
    pub email: String,
    pub name: Option<String>,
    /// Messages sent to this address.
    pub times_sent: i64,
}

/// Adding or renaming an entry by hand.
#[derive(Debug, Deserialize)]
pub struct ContactRequest {
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// Words that mark an automated sender wherever they appear in the local
/// part, once punctuation is dropped (`no-reply-aws`, `calendar-notification`).
const AUTOMATED: &[&str] = &[
    "noreply",
    "donotreply",
    "notification",
    "mailerdaemon",
    "postmaster",
    "bounce",
];

/// Whether an address belongs to a machine rather than a person: one of the
/// automated words, or a one-off reply token such as
/// `reply+abc123@reply.github.com`.
fn is_automated(email: &str) -> bool {
    let (local, domain) = email.split_once('@').unwrap_or((email, ""));
    let squashed: String = local
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase();
    AUTOMATED.iter().any(|word| squashed.contains(word))
        || local.to_ascii_lowercase().starts_with("reply+")
        || domain.to_ascii_lowercase().starts_with("reply.")
}

fn clean_name(name: Option<&str>) -> Option<String> {
    name.map(|n| n.chars().filter(|c| !c.is_control()).collect::<String>())
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
}

/// Remember everyone a message was sent to. Sending counts toward ranking,
/// and a name given while addressing fills in a missing one.
pub async fn record_sent(
    db: &SqlitePool,
    user_id: &str,
    recipients: &[MailAddress],
) -> AppResult<()> {
    for recipient in recipients {
        let Ok(email) = normalize_email(&recipient.email) else {
            continue;
        };
        sqlx::query(
            "INSERT INTO contacts (user_id, email, name, times_sent, last_used)
             VALUES (?, ?, ?, 1, unixepoch())
             ON CONFLICT(user_id, email) DO UPDATE SET
               times_sent = contacts.times_sent + 1,
               last_used = excluded.last_used,
               name = CASE WHEN contacts.name_locked OR excluded.name IS NULL
                           THEN contacts.name ELSE excluded.name END",
        )
        .bind(user_id)
        .bind(&email)
        .bind(clean_name(recipient.name.as_deref()))
        .execute(db)
        .await?;
    }
    Ok(())
}

/// Remember the people behind a message the user opened (its sender and
/// Reply-To), skipping automated senders and the user's own `mailboxes`.
/// The name in the message updates the entry unless the user set one.
pub async fn record_seen(
    db: &SqlitePool,
    user_id: &str,
    people: &[MailAddress],
    mailboxes: &[&str],
) -> AppResult<()> {
    for person in people {
        let Ok(email) = normalize_email(&person.email) else {
            continue;
        };
        if is_automated(&email) || mailboxes.iter().any(|own| own.eq_ignore_ascii_case(&email)) {
            continue;
        }
        sqlx::query(
            "INSERT INTO contacts (user_id, email, name, last_used)
             VALUES (?, ?, ?, unixepoch())
             ON CONFLICT(user_id, email) DO UPDATE SET
               last_used = excluded.last_used,
               name = CASE WHEN contacts.name_locked OR excluded.name IS NULL
                           THEN contacts.name ELSE excluded.name END",
        )
        .bind(user_id)
        .bind(&email)
        .bind(clean_name(person.name.as_deref()))
        .execute(db)
        .await?;
    }
    Ok(())
}

/// `%`, `_`, and the escape character itself match literally in LIKE.
fn like_prefix(query: &str) -> String {
    let escaped: String = query
        .chars()
        .flat_map(|c| match c {
            '%' | '_' | '\\' => vec!['\\', c],
            c => vec![c],
        })
        .collect();
    format!("{escaped}%")
}

/// Entries whose address, or any word of whose name, starts with `query`:
/// the most written-to first, then the most recently used.
pub async fn search(db: &SqlitePool, user_id: &str, query: &str) -> AppResult<Vec<Contact>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let prefix = like_prefix(query);
    Ok(sqlx::query_as(
        "SELECT id, email, name, times_sent FROM contacts
         WHERE user_id = ?
           AND (email LIKE ?2 ESCAPE '\\'
                OR name LIKE ?2 ESCAPE '\\'
                OR name LIKE '% ' || ?2 ESCAPE '\\')
         ORDER BY times_sent DESC, last_used DESC, email
         LIMIT ?3",
    )
    .bind(user_id)
    .bind(prefix)
    .bind(SUGGESTION_LIMIT)
    .fetch_all(db)
    .await?)
}

/// The whole address book, by name (entries without one by address).
pub async fn list(db: &SqlitePool, user_id: &str) -> AppResult<Vec<Contact>> {
    Ok(sqlx::query_as(
        "SELECT id, email, name, times_sent FROM contacts
         WHERE user_id = ?
         ORDER BY COALESCE(name, email) COLLATE NOCASE, email",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?)
}

/// Add an entry by hand, or set the name of an existing one. A name set
/// here is kept even when mail shows a different one; a blank name clears it.
pub async fn save(db: &SqlitePool, user_id: &str, request: ContactRequest) -> AppResult<Contact> {
    let email = normalize_email(&request.email)
        .ok()
        .filter(|email| email.parse::<lettre::Address>().is_ok())
        .ok_or_else(|| AppError::BadRequest("Enter a valid email address".into()))?;
    let name = clean_name(request.name.as_deref());
    Ok(sqlx::query_as(
        "INSERT INTO contacts (user_id, email, name, name_locked)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(user_id, email) DO UPDATE SET name = excluded.name, name_locked = 1
         RETURNING id, email, name, times_sent",
    )
    .bind(user_id)
    .bind(&email)
    .bind(name)
    .fetch_one(db)
    .await?)
}

pub async fn delete(db: &SqlitePool, user_id: &str, id: i64) -> AppResult<()> {
    let result = sqlx::query("DELETE FROM contacts WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user_id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Contact not found".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::MIGRATOR.run(&db).await.unwrap();
        for user in ["u", "other"] {
            sqlx::query("INSERT INTO users (id, email, password_hash) VALUES (?, ?, '!')")
                .bind(user)
                .bind(format!("{user}@users.example"))
                .execute(&db)
                .await
                .unwrap();
        }
        db
    }

    fn addr(name: Option<&str>, email: &str) -> MailAddress {
        MailAddress::new(name, email)
    }

    fn emails(contacts: &[Contact]) -> Vec<&str> {
        contacts.iter().map(|c| c.email.as_str()).collect()
    }

    #[tokio::test]
    async fn suggests_by_address_or_any_word_of_the_name() {
        let db = db().await;
        record_seen(
            &db,
            "u",
            &[
                addr(Some("Sarah Chen"), "Sarah.Chen@acme.example"),
                addr(Some("Bob Park"), "bob@acme.example"),
            ],
            &[],
        )
        .await
        .unwrap();

        assert_eq!(
            emails(&search(&db, "u", "sar").await.unwrap()),
            ["sarah.chen@acme.example"]
        );
        assert_eq!(
            emails(&search(&db, "u", "CHEN").await.unwrap()),
            ["sarah.chen@acme.example"]
        );
        assert_eq!(
            emails(&search(&db, "u", "bob@").await.unwrap()),
            ["bob@acme.example"]
        );
        assert!(
            search(&db, "u", "arah").await.unwrap().is_empty(),
            "prefixes only"
        );
        assert!(search(&db, "u", "  ").await.unwrap().is_empty());
        assert!(
            search(&db, "other", "sar").await.unwrap().is_empty(),
            "per user"
        );
    }

    #[tokio::test]
    async fn people_written_to_most_come_first() {
        let db = db().await;
        record_seen(&db, "u", &[addr(Some("Sam Seen"), "sam@x.example")], &[])
            .await
            .unwrap();
        record_sent(&db, "u", &[addr(Some("Sally"), "sally@x.example")])
            .await
            .unwrap();
        record_sent(&db, "u", &[addr(None, "sally@x.example")])
            .await
            .unwrap();

        let found = search(&db, "u", "sa").await.unwrap();
        assert_eq!(emails(&found), ["sally@x.example", "sam@x.example"]);
        assert_eq!(found[0].times_sent, 2);
        assert_eq!(
            found[0].name.as_deref(),
            Some("Sally"),
            "a missing name does not erase one"
        );
    }

    #[tokio::test]
    async fn two_addresses_for_one_person_stay_separate() {
        let db = db().await;
        record_seen(
            &db,
            "u",
            &[addr(Some("Sarah Chen"), "sarah.chen@acme.example")],
            &[],
        )
        .await
        .unwrap();
        record_sent(&db, "u", &[addr(Some("Sarah Chen"), "sarah@home.example")])
            .await
            .unwrap();
        let found = search(&db, "u", "sarah").await.unwrap();
        assert_eq!(
            emails(&found),
            ["sarah@home.example", "sarah.chen@acme.example"]
        );
    }

    #[tokio::test]
    async fn skips_automated_senders_and_own_mailboxes() {
        let db = db().await;
        let robots = [
            "notifications@github.com",
            "no-reply-aws@amazon.com",
            "noreply@x.example",
            "DoNotReply@x.example",
            "reply+a1b2c3@reply.github.com",
            "mailer-daemon@x.example",
            "calendar-notification@google.com",
            "bounces+123@mail.x.example",
        ];
        let mut people: Vec<_> = robots.iter().map(|e| addr(None, e)).collect();
        people.push(addr(None, "Me@Example.com"));
        people.push(addr(Some("Real Person"), "person@x.example"));
        record_seen(&db, "u", &people, &["me@example.com"])
            .await
            .unwrap();
        assert_eq!(emails(&list(&db, "u").await.unwrap()), ["person@x.example"]);
        for person in [
            "notion-team@x.example",
            "replyall@x.example",
            "sarah.chen@acme.example",
        ] {
            assert!(!is_automated(person), "{person}");
        }
    }

    #[tokio::test]
    async fn a_name_set_by_hand_is_kept() {
        let db = db().await;
        record_seen(
            &db,
            "u",
            &[addr(Some("S. Chen (Acme)"), "sarah@acme.example")],
            &[],
        )
        .await
        .unwrap();
        let saved = save(
            &db,
            "u",
            ContactRequest {
                email: "SARAH@acme.example".into(),
                name: Some("Sarah".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.name.as_deref(), Some("Sarah"));

        record_seen(
            &db,
            "u",
            &[addr(Some("Different"), "sarah@acme.example")],
            &[],
        )
        .await
        .unwrap();
        record_sent(&db, "u", &[addr(Some("Other"), "sarah@acme.example")])
            .await
            .unwrap();
        let [contact] = &list(&db, "u").await.unwrap()[..] else {
            panic!("one entry")
        };
        assert_eq!(contact.name.as_deref(), Some("Sarah"));
        assert_eq!(contact.times_sent, 1);
    }

    #[tokio::test]
    async fn adds_renames_clears_and_deletes_by_hand() {
        let db = db().await;
        let added = save(
            &db,
            "u",
            ContactRequest {
                email: " dana@x.example ".into(),
                name: Some(" Dana Lee\r\n".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            (added.email.as_str(), added.name.as_deref()),
            ("dana@x.example", Some("Dana Lee"))
        );

        let cleared = save(
            &db,
            "u",
            ContactRequest {
                email: "dana@x.example".into(),
                name: Some("   ".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!((cleared.id, cleared.name), (added.id, None));

        let invalid = save(
            &db,
            "u",
            ContactRequest {
                email: "not an address".into(),
                name: None,
            },
        )
        .await;
        assert!(invalid.is_err());

        assert!(
            delete(&db, "other", added.id).await.is_err(),
            "only the owner's"
        );
        delete(&db, "u", added.id).await.unwrap();
        assert!(list(&db, "u").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn wildcards_in_queries_match_literally() {
        let db = db().await;
        record_sent(
            &db,
            "u",
            &[
                addr(None, "a_b@x.example"),
                addr(None, "axb@x.example"),
                addr(None, "100%@x.example"),
            ],
        )
        .await
        .unwrap();
        assert_eq!(
            emails(&search(&db, "u", "a_").await.unwrap()),
            ["a_b@x.example"]
        );
        assert_eq!(
            emails(&search(&db, "u", "100%").await.unwrap()),
            ["100%@x.example"]
        );
    }
}
