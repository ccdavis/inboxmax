//! Saving attachments into the Downloads folder.

use inboxmax_core::attachment::safe_filename;
use inboxmax_core::{AppError, AppResult};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

/// Tries before giving up on finding a free name.
const MAX_COPIES: usize = 1000;

/// `name.ext`, then `name (1).ext`, `name (2).ext`, ...
fn candidate(filename: &str, copy: usize) -> String {
    if copy == 0 {
        return filename.to_string();
    }
    match filename.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} ({copy}).{ext}"),
        _ => format!("{filename} ({copy})"),
    }
}

/// Write `data` into `dir` under `filename` (made safe), never replacing a
/// file already there: a taken name gets a number. Returns the path written.
pub async fn save_new(dir: &Path, filename: &str, data: &[u8]) -> AppResult<PathBuf> {
    let filename = safe_filename(filename);
    for copy in 0..MAX_COPIES {
        let path = dir.join(candidate(&filename, copy));
        // create_new fails if the file exists, so two saves cannot collide.
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(mut file) => {
                file.write_all(data)
                    .await
                    .and(file.flush().await)
                    .map_err(|e| {
                        AppError::Internal(anyhow::anyhow!("Could not save {filename}: {e}"))
                    })?;
                return Ok(path);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(AppError::Internal(anyhow::anyhow!(
                    "Could not save {filename}: {e}"
                )));
            }
        }
    }
    Err(AppError::Conflict(format!(
        "Too many files named {filename} in Downloads"
    )))
}

/// Whether `path` is a file directly inside `dir`, so a request to show a
/// file cannot point anywhere else.
pub fn is_inside(dir: &Path, path: &Path) -> bool {
    match (dir.canonicalize(), path.canonicalize()) {
        (Ok(dir), Ok(path)) => path.is_file() && path.parent() == Some(dir.as_path()),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "inboxmax-downloads-{}-{:x}",
                std::process::id(),
                rand_suffix()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    #[tokio::test]
    async fn never_replaces_an_existing_file() {
        let dir = TempDir::new();
        let names: Vec<_> = [b"one" as &[u8], b"two", b"three"]
            .iter()
            .map(|data| save_new(&dir.0, "report.pdf", data))
            .collect();
        let mut saved = Vec::new();
        for save in names {
            saved.push(save.await.unwrap());
        }
        let file_names: Vec<_> = saved
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            file_names,
            ["report.pdf", "report (1).pdf", "report (2).pdf"]
        );
        assert_eq!(std::fs::read(&saved[0]).unwrap(), b"one");
        assert_eq!(std::fs::read(&saved[2]).unwrap(), b"three");
    }

    #[tokio::test]
    async fn names_stay_inside_the_folder() {
        let dir = TempDir::new();
        let path = save_new(&dir.0, "../../escape.txt", b"x").await.unwrap();
        assert_eq!(path.parent(), Some(dir.0.as_path()));
        assert_eq!(path.file_name().unwrap(), "_.._escape.txt");
        assert!(is_inside(&dir.0, &path));
        assert!(
            !is_inside(&dir.0, &dir.0),
            "the folder itself is not a file in it"
        );
        assert!(!is_inside(&dir.0, &dir.0.join("missing.txt")));
        assert!(
            !is_inside(dir.0.join("..").as_path(), &path),
            "only directly inside"
        );
    }

    #[test]
    fn numbers_copies_before_the_extension() {
        assert_eq!(candidate("notes", 2), "notes (2)");
        assert_eq!(candidate("archive.tar.gz", 1), "archive.tar (1).gz");
        assert_eq!(candidate("a.txt", 0), "a.txt");
    }
}
