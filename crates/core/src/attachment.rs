//! Files attached to messages: listing them, extracting one, and naming it
//! safely for a download.

use crate::error::{AppError, AppResult};
use mail_parser::{MessagePart, MimeHeaders, PartType};
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

/// The most UTF-16 units a saved name has, well within every file system.
const MAX_FILENAME_UNITS: usize = 150;
/// An extension longer than this is not kept apart when shortening a name.
const MAX_EXTENSION_CHARS: usize = 16;
/// Names Windows reserves for devices, whatever the extension.
const DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Invisible characters that change how a name reads, such as a
/// right-to-left override making "fdp.exe" show as "exe.pdf".
pub(crate) fn is_invisible_format(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FEFF}')
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s`'s longest start within `units` UTF-16 units.
fn truncate_utf16(s: &str, units: usize) -> &str {
    let mut used = 0;
    for (at, c) in s.char_indices() {
        used += c.len_utf16();
        if used > units {
            return &s[..at];
        }
    }
    s
}

/// Leading dots would hide the file (or climb directories as ".."), and
/// Windows drops trailing dots and spaces.
fn trim_dots_and_spaces(s: &str) -> &str {
    s.trim_matches(|c: char| c == '.' || c.is_whitespace())
}

/// A file name that is safe to save under: no directories, no control,
/// reserved or invisible formatting characters, no device name, not empty,
/// and short enough for any file system, keeping its extension.
pub fn safe_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|&c| !is_invisible_format(c))
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = trim_dots_and_spaces(&cleaned);
    let mut safe = if utf16_len(trimmed) <= MAX_FILENAME_UNITS {
        trimmed.to_string()
    } else {
        // Shorten the name, not the extension that says what the file is.
        let (stem, extension) = match trimmed.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() && ext.chars().count() <= MAX_EXTENSION_CHARS => {
                (stem, format!(".{ext}"))
            }
            _ => (trimmed, String::new()),
        };
        let room = MAX_FILENAME_UNITS - utf16_len(&extension);
        let stem = trim_dots_and_spaces(truncate_utf16(stem, room));
        format!("{stem}{extension}")
    };
    if trim_dots_and_spaces(&safe).is_empty() {
        safe = "attachment".into();
    }
    let device = safe.split('.').next().unwrap_or_default().trim_end();
    if DEVICE_NAMES.iter().any(|d| d.eq_ignore_ascii_case(device)) {
        safe.insert(0, '_');
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
    // Text parts come out of the parser converted to UTF-8, so say so, or a
    // forwarded Latin-1 file would be read in the wrong character set.
    if matches!(part.body, PartType::Text(_) | PartType::Html(_)) {
        let subtype = if matches!(part.body, PartType::Html(_)) {
            "html".to_string()
        } else {
            part.content_type()
                .and_then(|ct| ct.subtype())
                .unwrap_or("plain")
                .to_ascii_lowercase()
        };
        return format!("text/{subtype}; charset=utf-8");
    }
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

    #[test]
    fn file_names_cannot_disguise_themselves_or_name_devices() {
        // A right-to-left override would show "Invoice_fdp.exe" as "Invoice_exe.pdf".
        assert_eq!(safe_filename("Invoice_\u{202E}fdp.exe"), "Invoice_fdp.exe");
        assert_eq!(safe_filename("a\u{200B}b\u{FEFF}.txt"), "ab.txt");
        assert_eq!(safe_filename("NUL"), "_NUL");
        assert_eq!(safe_filename("con.txt"), "_con.txt");
        assert_eq!(safe_filename("COM1 .log"), "_COM1 .log");
        assert_eq!(safe_filename("console.txt"), "console.txt");
    }

    #[test]
    fn long_names_keep_their_extension() {
        let long = format!("{}.pdf", "x".repeat(400));
        let safe = safe_filename(&long);
        assert!(safe.ends_with("x.pdf"));
        assert_eq!(safe.chars().count(), MAX_FILENAME_UNITS);
        // Characters outside the BMP take two UTF-16 units each.
        let emoji = format!("{}.txt", "😀".repeat(200));
        let safe = safe_filename(&emoji);
        assert!(safe.ends_with(".txt"));
        assert!(utf16_len(&safe) <= MAX_FILENAME_UNITS);
        // No trailing dot or space left where the name was cut.
        let dotted = format!("{}. .{}.doc", "a".repeat(144), "b".repeat(20));
        assert!(!safe_filename(&dotted).contains(". .doc"));
        assert!(
            !safe_filename(&dotted)
                .trim_end_matches(".doc")
                .ends_with(['.', ' '])
        );
    }

    #[test]
    fn text_attachments_say_they_are_utf8() {
        let raw = concat!(
            "Content-Type: multipart/mixed; boundary=b\r\n\r\n",
            "--b\r\nContent-Type: text/plain\r\n\r\nBody\r\n",
            "--b\r\nContent-Type: text/csv; charset=iso-8859-1\r\n",
            "Content-Disposition: attachment; filename=\"list.csv\"\r\n",
            "Content-Transfer-Encoding: quoted-printable\r\n\r\n",
            "caf=E9\r\n--b--\r\n",
        );
        let csv = extract(raw.as_bytes(), 0).unwrap();
        assert_eq!(csv.content_type, "text/csv; charset=utf-8");
        assert_eq!(csv.data, "café".as_bytes());
    }
}
