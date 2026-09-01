//! Optional on-disk chat transcripts. Off by default; the frontend only calls
//! in here when the user has said yes to keeping logs. Files live in the
//! app's data directory (never the OS cache, which the system may wipe),
//! split into `logs/avatars/` and `logs/groups/`, one plain-text file per
//! conversation.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

type Cmd = Result<Value, String>;

const KINDS: [&str; 2] = ["avatars", "groups"];
/// One appended line is a chat message plus a timestamp; anything much bigger
/// is not chat.
const MAX_LINE_BYTES: usize = 8 * 1024;

/// A conversation name as a filename: no path separators or characters any of
/// the supported filesystems refuse, no control characters, no leading/trailing
/// dots or spaces, bounded length. Empty results fall back to "unnamed".
pub fn sanitize_log_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    out = out.trim().trim_matches('.').trim().to_string();
    while out.len() > 100 {
        out.pop();
    }
    if out.is_empty() {
        out = "unnamed".to_string();
    }
    out
}

fn log_file(base: &Path, kind: &str, name: &str) -> Option<PathBuf> {
    if !KINDS.contains(&kind) {
        return None;
    }
    let dir = base.join("logs").join(kind);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{}.txt", sanitize_log_name(name))))
}

pub fn append_line(base: &Path, kind: &str, name: &str, line: &str) -> Result<(), String> {
    let path = log_file(base, kind, name).ok_or("Bad log target")?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Could not open the log file: {e}"))?;
    // One line per message: embedded newlines become the visual "¦" so a log
    // line always equals one message.
    let flat: String = line.chars().map(|c| if c == '\n' || c == '\r' { '¦' } else { c }).collect();
    writeln!(file, "{flat}").map_err(|e| format!("Could not write the log file: {e}"))
}

/// Total size and file count under `logs/`, for the About tab.
pub fn usage(base: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut files = 0u64;
    for kind in KINDS {
        let Ok(entries) = std::fs::read_dir(base.join("logs").join(kind)) else {
            continue;
        };
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    bytes += meta.len();
                    files += 1;
                }
            }
        }
    }
    (bytes, files)
}

/// Append one line to a conversation's log file.
#[tauri::command]
pub fn chat_log_append(app: tauri::AppHandle, kind: String, name: String, line: String) -> Cmd {
    if line.len() > MAX_LINE_BYTES {
        return Err("Log line too long".into());
    }
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or("No data directory")?;
    append_line(&base, &kind, &name, &line)?;
    Ok(json!({ "ok": true }))
}

/// How much disk the chat logs take, and where they live.
#[tauri::command]
pub fn chat_log_usage(app: tauri::AppHandle) -> Cmd {
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or("No data directory")?;
    let (bytes, files) = usage(&base);
    Ok(json!({
        "ok": true,
        "bytes": bytes,
        "files": files,
        "path": base.join("logs").to_string_lossy(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_become_safe_filenames() {
        assert_eq!(sanitize_log_name("Pantera Polnocy"), "Pantera Polnocy");
        assert_eq!(sanitize_log_name("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize_log_name("  ..hidden..  "), "hidden");
        assert_eq!(sanitize_log_name(""), "unnamed");
        assert_eq!(sanitize_log_name("..."), "unnamed");
        assert!(sanitize_log_name(&"x".repeat(300)).len() <= 100);
        // Multi-byte names get cut on a char boundary.
        let cut = sanitize_log_name(&"ż".repeat(80));
        assert!(cut.len() <= 100 && cut.chars().all(|c| c == 'ż'));
    }

    #[test]
    fn append_and_usage_work_on_disk() {
        let base = std::env::temp_dir().join(format!("minibee-logtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        append_line(&base, "avatars", "Some One", "[2026-09-01 12:00] Some One: hi\nthere").unwrap();
        append_line(&base, "avatars", "Some One", "[2026-09-01 12:01] Me: hello").unwrap();
        append_line(&base, "groups", "Bee Lovers", "[2026-09-01 12:02] Some One: buzz").unwrap();
        // An unknown kind is refused, not written somewhere surprising.
        assert!(append_line(&base, "..", "x", "y").is_err());
        let text = std::fs::read_to_string(base.join("logs/avatars/Some One.txt")).unwrap();
        assert_eq!(text.lines().count(), 2, "embedded newline flattened: {text}");
        let (bytes, files) = usage(&base);
        assert_eq!(files, 2);
        assert!(bytes > 0);
        let _ = std::fs::remove_dir_all(&base);
    }
}
