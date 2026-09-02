//! Optional on-disk chat transcripts. Off by default; the frontend only calls
//! in here when the user has said yes to keeping logs. Files live in the
//! app's data directory (never the OS cache, which the system may wipe),
//! split into `logs/avatars/`, `logs/groups/` and `logs/local/` (nearby
//! chat), one plain-text file per conversation.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

type Cmd = Result<Value, String>;

const KINDS: [&str; 3] = ["avatars", "groups", "local"];
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
    // Windows still treats CON/PRN/AUX/NUL/COM1-9/LPT1-9 as devices even with
    // an extension appended.
    let upper = out.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit());
    if reserved {
        out.insert(0, '_');
    }
    out
}

/// `logs/<kind>/` for a known kind. The caller's string never reaches the
/// filesystem - it only selects one of the fixed KINDS entries.
fn kind_dir(base: &Path, kind: &str) -> Option<PathBuf> {
    let kind = KINDS.into_iter().find(|k| *k == kind)?;
    Some(base.join("logs").join(kind))
}

fn log_file(base: &Path, kind: &str, name: &str) -> Option<PathBuf> {
    let dir = kind_dir(base, kind)?;
    std::fs::create_dir_all(&dir).ok()?;
    let file = format!("{}.txt", sanitize_log_name(name));
    let path = dir.join(&file);
    // The sanitizer guarantees a single plain component; keep that invariant
    // checked where the path is actually assembled.
    if Path::new(&file).components().count() != 1 || !path.starts_with(&dir) {
        return None;
    }
    Some(path)
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

/// Every log file, per kind: (kind, file stem, bytes). Sorted by kind then name.
pub fn list_logs(base: &Path) -> Vec<(String, String, u64)> {
    let mut rows = Vec::new();
    for kind in KINDS {
        let Ok(entries) = std::fs::read_dir(base.join("logs").join(kind)) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(".txt") else { continue };
            rows.push((kind.to_string(), stem.to_string(), meta.len()));
        }
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    rows
}

/// Delete one conversation's log, or every log of a kind when `name` is None.
/// The path is rebuilt through the same sanitizer that wrote it, so this can
/// only ever touch files inside `logs/<kind>/`.
pub fn delete_logs(base: &Path, kind: &str, name: Option<&str>) -> Result<u64, String> {
    let dir = kind_dir(base, kind).ok_or("Bad log kind")?;
    let mut deleted = 0u64;
    match name {
        Some(name) => {
            let path = log_file(base, kind, name).ok_or("Bad log target")?;
            if path.is_file() {
                std::fs::remove_file(&path).map_err(|e| format!("Could not delete the log: {e}"))?;
                deleted = 1;
            }
        }
        None => {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    if entry.metadata().map(|m| m.is_file()).unwrap_or(false)
                        && std::fs::remove_file(entry.path()).is_ok()
                    {
                        deleted += 1;
                    }
                }
            }
        }
    }
    Ok(deleted)
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

/// The log files on disk, for the log manager.
#[tauri::command]
pub fn chat_log_list(app: tauri::AppHandle) -> Cmd {
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or("No data directory")?;
    let rows: Vec<Value> = list_logs(&base)
        .into_iter()
        .map(|(kind, name, bytes)| json!({ "kind": kind, "name": name, "bytes": bytes }))
        .collect();
    Ok(json!({ "ok": true, "logs": rows }))
}

/// Delete one log file, or a whole kind (name omitted). Called only from the
/// log manager, behind its own confirmation.
#[tauri::command]
pub fn chat_log_delete(app: tauri::AppHandle, kind: String, name: Option<String>) -> Cmd {
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or("No data directory")?;
    let deleted = delete_logs(&base, &kind, name.as_deref())?;
    Ok(json!({ "ok": true, "deleted": deleted }))
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
        assert_eq!(sanitize_log_name("../../evil"), "_.._evil");
        assert_eq!(sanitize_log_name("con"), "_con");
        assert_eq!(sanitize_log_name("COM3"), "_COM3");
        assert_eq!(sanitize_log_name("Console"), "Console");
        assert!(sanitize_log_name(&"x".repeat(300)).len() <= 100);
        // Multi-byte names get cut on a char boundary.
        let cut = sanitize_log_name(&"ż".repeat(80));
        assert!(cut.len() <= 100 && cut.chars().all(|c| c == 'ż'));
    }

    #[test]
    fn traversal_names_stay_inside_the_log_dir() {
        let base = std::env::temp_dir().join(format!("minibee-logtrav-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        append_line(&base, "avatars", "../../evil", "x").unwrap();
        assert!(base.join("logs").join("avatars").join("_.._evil.txt").is_file());
        assert!(!base.join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(&base);
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
        // The manager sees both files, deletes one by name, then a whole kind.
        let rows = list_logs(&base);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], ("avatars".into(), "Some One".into(), text.len() as u64));
        assert_eq!(delete_logs(&base, "avatars", Some("Some One")).unwrap(), 1);
        assert_eq!(delete_logs(&base, "groups", None).unwrap(), 1);
        assert!(delete_logs(&base, "..", None).is_err());
        assert_eq!(usage(&base).1, 0);
        let _ = std::fs::remove_dir_all(&base);
    }
}
