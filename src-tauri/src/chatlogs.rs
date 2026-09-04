//! Optional on-disk chat transcripts. Off by default; the frontend only calls
//! in here when the user has said yes to keeping logs. Files live in the
//! app's data directory (never the OS cache, which the system may wipe),
//! one folder per account: `<agent-uuid>/logs/avatars|groups|local/`, one
//! plain-text file per conversation. Logs written before accounts were
//! separated stay readable (and deletable) in the shared `logs/` folder.

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

/// A canonical lowercase hyphenated UUID rebuilt character by character, or
/// None. This is the only shape an account folder name can take, so the
/// caller's string can never traverse anywhere. The nil UUID means "no agent"
/// and is refused too.
pub fn canonical_uuid(agent: &str) -> Option<String> {
    let bytes = agent.trim().as_bytes();
    if bytes.len() != 36 {
        return None;
    }
    let mut out = String::with_capacity(36);
    for (i, &b) in bytes.iter().enumerate() {
        let hyphen = matches!(i, 8 | 13 | 18 | 23);
        match (hyphen, b) {
            (true, b'-') => out.push('-'),
            (false, b'0'..=b'9' | b'a'..=b'f') => out.push(b as char),
            (false, b'A'..=b'F') => out.push((b as char).to_ascii_lowercase()),
            _ => return None,
        }
    }
    if out == "00000000-0000-0000-0000-000000000000" {
        return None;
    }
    Some(out)
}

/// The account half of a log path: a canonical UUID, or "" for the shared
/// pre-account folder. Anything else is refused.
fn account_segment(agent: &str) -> Option<String> {
    if agent.is_empty() {
        return Some(String::new());
    }
    canonical_uuid(agent)
}

/// `<uuid>/logs/` for an account, plain `logs/` for the shared legacy folder.
fn logs_root(base: &Path, segment: &str) -> PathBuf {
    if segment.is_empty() {
        base.join("logs")
    } else {
        base.join(segment).join("logs")
    }
}

/// The log folder for one (account, kind). The kind string never reaches the
/// filesystem - it only selects one of the fixed KINDS entries.
fn kind_dir(base: &Path, segment: &str, kind: &str) -> Option<PathBuf> {
    let kind = KINDS.into_iter().find(|k| *k == kind)?;
    Some(logs_root(base, segment).join(kind))
}

fn log_file(base: &Path, segment: &str, kind: &str, name: &str) -> Option<PathBuf> {
    let dir = kind_dir(base, segment, kind)?;
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

/// Every account folder that exists under `base`, shared legacy folder first.
fn account_segments(base: &Path) -> Vec<String> {
    let mut out = vec![String::new()];
    if let Ok(entries) = std::fs::read_dir(base) {
        let mut accounts: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| canonical_uuid(&e.file_name().to_string_lossy()))
            .collect();
        accounts.sort();
        out.extend(accounts);
    }
    out
}

pub fn append_line(base: &Path, agent: &str, kind: &str, name: &str, line: &str) -> Result<(), String> {
    // New lines always belong to an account; only old files live in the shared folder.
    let segment = canonical_uuid(agent).ok_or("Bad log account")?;
    let path = log_file(base, &segment, kind, name).ok_or("Bad log target")?;
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

/// Every log file: (account segment, kind, file stem, bytes). The shared
/// legacy folder lists with an empty account. Sorted by account, kind, name.
pub fn list_logs(base: &Path) -> Vec<(String, String, String, u64)> {
    let mut rows = Vec::new();
    for segment in account_segments(base) {
        for kind in KINDS {
            let Ok(entries) = std::fs::read_dir(logs_root(base, &segment).join(kind)) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(meta) = entry.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(stem) = name.strip_suffix(".txt") else { continue };
                rows.push((segment.clone(), kind.to_string(), stem.to_string(), meta.len()));
            }
        }
    }
    rows.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.2.to_lowercase().cmp(&b.2.to_lowercase()))
    });
    rows
}

/// Delete one conversation's log, or every log of a kind when `name` is None.
/// The path is rebuilt through the same sanitizer that wrote it, so this can
/// only ever touch files inside one account's `logs/<kind>/`.
pub fn delete_logs(base: &Path, agent: &str, kind: &str, name: Option<&str>) -> Result<u64, String> {
    let segment = account_segment(agent).ok_or("Bad log account")?;
    let dir = kind_dir(base, &segment, kind).ok_or("Bad log kind")?;
    let mut deleted = 0u64;
    match name {
        Some(name) => {
            let path = log_file(base, &segment, kind, name).ok_or("Bad log target")?;
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

/// Total size and file count across every account's logs, for the About tab.
pub fn usage(base: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut files = 0u64;
    for (_, _, _, len) in list_logs(base) {
        bytes += len;
        files += 1;
    }
    (bytes, files)
}

/// Append one line to a conversation's log file.
#[tauri::command]
pub fn chat_log_append(app: tauri::AppHandle, agent: String, kind: String, name: String, line: String) -> Cmd {
    if line.len() > MAX_LINE_BYTES {
        return Err("Log line too long".into());
    }
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or("No data directory")?;
    append_line(&base, &agent, &kind, &name, &line)?;
    Ok(json!({ "ok": true }))
}

/// The log files on disk, for the log manager. An empty `agent` marks files
/// from before logs were split per account.
#[tauri::command]
pub fn chat_log_list(app: tauri::AppHandle) -> Cmd {
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or("No data directory")?;
    let rows: Vec<Value> = list_logs(&base)
        .into_iter()
        .map(|(agent, kind, name, bytes)| json!({ "agent": agent, "kind": kind, "name": name, "bytes": bytes }))
        .collect();
    Ok(json!({ "ok": true, "logs": rows }))
}

/// Delete one log file, or a whole kind (name omitted). Called only from the
/// log manager, behind its own confirmation.
#[tauri::command]
pub fn chat_log_delete(app: tauri::AppHandle, agent: String, kind: String, name: Option<String>) -> Cmd {
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or("No data directory")?;
    let deleted = delete_logs(&base, &agent, &kind, name.as_deref())?;
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
        "path": base.to_string_lossy(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

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
    fn only_real_uuids_name_account_folders() {
        assert_eq!(canonical_uuid(AGENT).as_deref(), Some(AGENT));
        assert_eq!(
            canonical_uuid("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE").as_deref(),
            Some(AGENT),
        );
        assert_eq!(canonical_uuid(""), None);
        assert_eq!(canonical_uuid("not-a-uuid"), None);
        assert_eq!(canonical_uuid("00000000-0000-0000-0000-000000000000"), None);
        assert_eq!(canonical_uuid("../../../../../../etc/passwd/aaaaaaaa"), None);
        assert_eq!(canonical_uuid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeeg"), None);
        assert_eq!(canonical_uuid("aaaaaaaa/bbbb-cccc-dddd-eeeeeeeeeeee"), None);
    }

    #[test]
    fn traversal_names_stay_inside_the_log_dir() {
        let base = std::env::temp_dir().join(format!("minibee-logtrav-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        append_line(&base, AGENT, "avatars", "../../evil", "x").unwrap();
        assert!(base.join(AGENT).join("logs").join("avatars").join("_.._evil.txt").is_file());
        assert!(!base.join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn append_and_usage_work_on_disk() {
        let base = std::env::temp_dir().join(format!("minibee-logtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        append_line(&base, AGENT, "avatars", "Some One", "[2026-09-01 12:00] Some One: hi\nthere").unwrap();
        append_line(&base, AGENT, "avatars", "Some One", "[2026-09-01 12:01] Me: hello").unwrap();
        append_line(&base, AGENT, "groups", "Bee Lovers", "[2026-09-01 12:02] Some One: buzz").unwrap();
        // An unknown kind or a non-account agent is refused, not written somewhere surprising.
        assert!(append_line(&base, AGENT, "..", "x", "y").is_err());
        assert!(append_line(&base, "", "avatars", "x", "y").is_err());
        assert!(append_line(&base, "../escape/aaaa-bbbb-cccc-dddd-ee", "avatars", "x", "y").is_err());
        let text = std::fs::read_to_string(base.join(AGENT).join("logs/avatars/Some One.txt")).unwrap();
        assert_eq!(text.lines().count(), 2, "embedded newline flattened: {text}");
        let (bytes, files) = usage(&base);
        assert_eq!(files, 2);
        assert!(bytes > 0);
        // The manager sees both files, deletes one by name, then a whole kind.
        let rows = list_logs(&base);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], (AGENT.into(), "avatars".into(), "Some One".into(), text.len() as u64));
        assert_eq!(delete_logs(&base, AGENT, "avatars", Some("Some One")).unwrap(), 1);
        assert_eq!(delete_logs(&base, AGENT, "groups", None).unwrap(), 1);
        assert!(delete_logs(&base, AGENT, "..", None).is_err());
        assert!(delete_logs(&base, "not-an-account", "avatars", None).is_err());
        assert_eq!(usage(&base).1, 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn legacy_shared_logs_stay_visible_and_deletable() {
        let base = std::env::temp_dir().join(format!("minibee-loglegacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // A file written by an older build, before per-account folders.
        let legacy_dir = base.join("logs").join("avatars");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(legacy_dir.join("Old Friend.txt"), "[old] line\n").unwrap();
        append_line(&base, AGENT, "avatars", "New Friend", "[new] line").unwrap();
        let rows = list_logs(&base);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "", "legacy rows carry an empty account");
        assert_eq!(rows[0].2, "Old Friend");
        assert_eq!(rows[1].0, AGENT);
        assert_eq!(usage(&base).1, 2);
        assert_eq!(delete_logs(&base, "", "avatars", Some("Old Friend")).unwrap(), 1);
        assert_eq!(usage(&base).1, 1);
        let _ = std::fs::remove_dir_all(&base);
    }
}
