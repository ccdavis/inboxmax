//! Files attached to messages: listing them, extracting one, and naming it
//! safely for a download.

use crate::error::{AppError, AppResult};
use mail_parser::{MessagePart, MimeHeaders};
use serde::Serialize;

/// An attachment as the reader lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttachmentInfo {
    /// Position among the message's attachments; how it is downloaded.
    pub index: usize,
    pub filename: String,
    pub content_type: String,
    /// Bytes, decoded.
    pub size: usize,
}

/// An attachment's name, type, and contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub filename: String,
    pub content_type: String,
    pub data: Vec<u8>,
}

impl Attachment {
    pub fn info(&self, index: usize) -> AttachmentInfo {
        AttachmentInfo {
            index,
            filename: self.filename.clone(),
            content_type: self.content_type.clone(),
            size: self.data.len(),
        }
    }
}

/// A file name that is safe to save under: no directories, no control or
/// reserved characters, not empty, and not too long for a file system.
pub fn safe_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    // Leading dots would hide the file (or climb directories as ".."), and
    // Windows drops trailing dots and spaces.
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let mut safe: String = trimmed.chars().take(150).collect();
    if safe.is_empty() {
        safe = "attachment".into();
    }
    safe
}

/// A Content-Disposition header that makes browsers save the file under its
/// name: a plain-ASCII `filename` for old clients and the exact name as
/// RFC 5987 `filename*`.
pub fn content_disposition(filename: &str) -> String {
    let name = safe_filename(filename);
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_ascii_control() && c != '"' && c != '\\' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

fn content_type(part: &MessagePart<'_>) -> String {
    part.content_type()
        .map(|ct| {
            format!("{}/{}", ct.ctype(), ct.subtype().unwrap_or("octet-stream"))
                .to_ascii_lowercase()
        })
        .unwrap_or_else(|| "application/octet-stream".into())
}

fn attachment(index: usize, part: &MessagePart<'_>) -> Attachment {
    let filename = part
        .attachment_name()
        .map(safe_filename)
        .unwrap_or_else(|| format!("attachment-{}", index + 1));
    Attachment {
        filename,
        content_type: content_type(part),
        data: part.contents().to_vec(),
    }
}

/// Every attachment of a parsed message, in order.
pub fn list(message: &mail_parser::Message<'_>) -> Vec<AttachmentInfo> {
    message
        .attachments()
        .enumerate()
        .map(|(index, part)| attachment(index, part).info(index))
        .collect()
}

/// One attachment of a raw RFC 5322 message, by its position.
pub fn extract(raw: &[u8], index: usize) -> AppResult<Attachment> {
    let message = mail_parser::MessageParser::default()
        .parse(raw)
        .ok_or_else(|| AppError::Imap("Failed to parse message".into()))?;
    message
        .attachments()
        .nth(index)
        .map(|part| attachment(index, part))
        .ok_or_else(|| AppError::NotFound("Attachment not found".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = concat!(
        "From: a@x.example\r\n",
        "Subject: Files\r\n",
        "MIME-Version: 1.0\r\n",
        "Content-Type: multipart/mixed; boundary=b\r\n",
        "\r\n",
        "--b\r\n",
        "Content-Type: text/plain\r\n",
        "\r\n",
        "See attached.\r\n",
        "--b\r\n",
        "Content-Type: application/pdf; name=\"invoice.pdf\"\r\n",
        "Content-Disposition: attachment; filename=\"invoice.pdf\"\r\n",
        "Content-Transfer-Encoding: base64\r\n",
        "\r\n",
        "JVBERi0xLjQK\r\n",
        "--b\r\n",
        "Content-Type: image/JPEG\r\n",
        "Content-Disposition: attachment; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20..%2F..%2Fphoto.jpg\r\n",
        "Content-Transfer-Encoding: base64\r\n",
        "\r\n",
        "/9j/\r\n",
        "--b--\r\n",
    );

    #[test]
    fn lists_attachments_with_decoded_sizes_and_safe_names() {
        let message = mail_parser::MessageParser::default()
            .parse(RAW.as_bytes())
            .unwrap();
        assert_eq!(
            list(&message),
            [
                AttachmentInfo {
                    index: 0,
                    filename: "invoice.pdf".into(),
                    content_type: "application/pdf".into(),
                    size: 9,
                },
                AttachmentInfo {
                    index: 1,
                    filename: "Grüße .._.._photo.jpg".into(),
                    content_type: "image/jpeg".into(),
                    size: 3,
                },
            ]
        );
    }

    #[test]
    fn extracts_one_attachment() {
        let pdf = extract(RAW.as_bytes(), 0).unwrap();
        assert_eq!(pdf.data, b"%PDF-1.4\n");
        assert!(matches!(
            extract(RAW.as_bytes(), 2),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn downloads_keep_their_names_in_any_browser() {
        assert_eq!(
            content_disposition("Grüße \"final\".pdf"),
            "attachment; filename=\"Gr__e _final_.pdf\"; \
             filename*=UTF-8''Gr%C3%BC%C3%9Fe%20_final_.pdf"
        );
        assert_eq!(
            content_disposition("../x.txt"),
            "attachment; filename=\"_x.txt\"; filename*=UTF-8''_x.txt"
        );
    }

    #[test]
    fn file_names_cannot_escape_the_download_folder() {
        assert_eq!(safe_filename("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_filename("..\\..\\boot.ini"), "_.._boot.ini");
        assert_eq!(safe_filename("C:\\Windows\\x.exe"), "C__Windows_x.exe");
        assert_eq!(safe_filename(".hidden"), "hidden");
        assert_eq!(safe_filename("report. "), "report");
        assert_eq!(safe_filename("a\r\nb\0c.txt"), "a__b_c.txt");
        assert_eq!(safe_filename(" .. "), "attachment");
        assert_eq!(safe_filename(&"x".repeat(300)).len(), 150);
        assert_eq!(safe_filename("Café Olé.pdf"), "Café Olé.pdf");
    }
}
