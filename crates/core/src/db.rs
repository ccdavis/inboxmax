use sqlx::SqlitePool;
use sqlx::migrate::{Migration, Migrator};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::borrow::Cow;
use std::path::Path;
use std::str::FromStr;

/// Schema migrations, embedded at compile time.
pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// Open (creating if needed) the SQLite database at a `sqlite:` URL and bring
/// its schema up to date.
pub async fn init_pool(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    open(SqliteConnectOptions::from_str(database_url)?).await
}

/// Like [`init_pool`] for a file path. Paths are not URLs, so this is safe
/// for directories containing `?`, `%`, or other URL syntax.
pub async fn init_pool_at(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    open(SqliteConnectOptions::new().filename(path)).await
}

async fn open(options: SqliteConnectOptions) -> Result<SqlitePool, sqlx::Error> {
    let options = options
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    accept_either_line_ending(&pool).await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

/// The same migration with `sql` in place of its text, for its checksum.
fn with_sql(migration: &Migration, sql: String) -> Migration {
    Migration::new(
        migration.version,
        migration.description.clone(),
        migration.migration_type,
        Cow::Owned(sql),
        migration.no_tx,
    )
}

/// sqlx checksums each migration's exact bytes, and refuses a database whose
/// recorded checksums differ. Git can check migrations out with CRLF (as it
/// did on Windows before .gitattributes pinned them to LF) or LF endings, so
/// a database migrated by one kind of build would stop another from
/// starting. Recorded checksums that match a migration apart from its line
/// endings are brought up to date; any other change is still refused.
async fn accept_either_line_ending(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let migrated: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(pool)
    .await?;
    if migrated.is_none() {
        return Ok(());
    }
    for migration in MIGRATOR.iter() {
        let lf = migration.sql.replace("\r\n", "\n");
        let crlf = lf.replace('\n', "\r\n");
        for variant in [lf, crlf] {
            let other = with_sql(migration, variant).checksum;
            if other != migration.checksum {
                sqlx::query(
                    "UPDATE _sqlx_migrations SET checksum = ? WHERE version = ? AND checksum = ?",
                )
                .bind(migration.checksum.as_ref())
                .bind(migration.version)
                .bind(other.as_ref())
                .execute(pool)
                .await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MIGRATOR, init_pool_at, with_sql};

    /// A fresh database file, removed when dropped.
    struct TempDb(std::path::PathBuf);

    impl TempDb {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("inboxmax-db-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> std::path::PathBuf {
            self.0.join("inboxmax.db")
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn record_checksum(db: &TempDb, version: i64, checksum: &[u8]) {
        let pool = init_pool_at(&db.path()).await.unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
            .bind(checksum)
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }

    #[tokio::test]
    async fn opens_databases_migrated_with_either_line_ending() {
        let db = TempDb::new();
        let first = MIGRATOR.iter().next().unwrap();
        // As if an earlier build had the other line endings.
        let lf = first.sql.replace("\r\n", "\n");
        let other_ending = if first.sql.contains("\r\n") {
            lf
        } else {
            lf.replace('\n', "\r\n")
        };
        let recorded = with_sql(first, other_ending).checksum;
        assert_ne!(recorded, first.checksum);
        record_checksum(&db, first.version, &recorded).await;

        let pool = init_pool_at(&db.path())
            .await
            .expect("opens despite the line endings");
        let stored: Vec<u8> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = ?")
                .bind(first.version)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, first.checksum.as_ref(), "brought up to date");
        pool.close().await;
    }

    #[tokio::test]
    async fn still_refuses_a_migration_that_really_changed() {
        let db = TempDb::new();
        let first = MIGRATOR.iter().next().unwrap();
        let edited = with_sql(first, format!("{}\n-- edited", first.sql)).checksum;
        record_checksum(&db, first.version, &edited).await;
        assert!(init_pool_at(&db.path()).await.is_err());
    }

    #[tokio::test]
    async fn opens_paths_that_look_like_url_syntax() {
        let dir =
            std::env::temp_dir().join(format!("inboxmax db?%20test {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("inboxmax.db");
        let pool = init_pool_at(&path).await.unwrap();
        pool.close().await;
        assert!(path.exists(), "database created at the literal path");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
