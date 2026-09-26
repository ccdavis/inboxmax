use sqlx::SqlitePool;
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
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

    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::init_pool_at;

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
