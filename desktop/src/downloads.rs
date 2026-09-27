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
                let written = file.write_all(data).await.and(file.flush().await);
                drop(file);
                if let Err(e) = written {
                    // No half-written file left behind under the name.
                    let _ = tokio::fs::remove_file(&path).await;
                    return Err(AppError::Internal(anyhow::anyhow!(
                        "Could not save {filename}: {e}"
                    )));
                }
                mark_from_internet(&path).await;
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

/// Mark a saved attachment as coming from the internet (the "Mark of the
/// Web"), as browsers do, so Windows warns before running it and Office
/// opens it in Protected View.
async fn mark_from_internet(path: &Path) {
    #[cfg(windows)]
    {
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        // Zone 3 is the internet.
        if let Err(e) = tokio::fs::write(&stream, "[ZoneTransfer]\r\nZoneId=3\r\n").await {
            tracing::warn!("Could not mark {} as downloaded: {e}", path.display());
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// Whether `path` is a file directly inside `dir`, so a request to show a
/// file cannot point anywhere else. The path is checked as written before
/// the file system is asked anything, so a network path is never looked up.
pub fn is_inside(dir: &Path, path: &Path) -> bool {
    let named_inside = path.is_absolute()
        && path.parent() == Some(dir)
        && path
            .file_name()
            .is_some_and(|name| Path::new(name).components().count() == 1);
    if !named_inside {
        return false;
    }
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
        // Written another way, it is refused without being looked up.
        assert!(!is_inside(
            &dir.0,
            &dir.0.join("sub").join("..").join("_.._escape.txt")
        ));
        assert!(!is_inside(
            &dir.0,
            Path::new(r"\\attacker.example\share\x.txt")
        ));
        assert!(!is_inside(&dir.0, Path::new("_.._escape.txt")));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn saved_files_are_marked_as_downloaded() {
        let dir = TempDir::new();
        let path = save_new(&dir.0, "report.docm", b"x").await.unwrap();
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        assert_eq!(
            std::fs::read_to_string(stream).unwrap(),
            "[ZoneTransfer]\r\nZoneId=3\r\n"
        );
    }

    #[test]
    fn numbers_copies_before_the_extension() {
        assert_eq!(candidate("notes", 2), "notes (2)");
        assert_eq!(candidate("archive.tar.gz", 1), "archive.tar (1).gz");
        assert_eq!(candidate("a.txt", 0), "a.txt");
    }
}
