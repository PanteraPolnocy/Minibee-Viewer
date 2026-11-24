//! Optional on-disk chat transcripts. Off by default; the frontend only calls
//! in here when the user has said yes to keeping logs. Files live in the
//! app's data directory (never the OS cache, which the system may wipe),
//! one folder per account: `<agent-uuid>/logs/avatars|groups|local/`, one
//! plain-text file per conversation. Logs written before accounts were
//! separated stay readable (and deletable) in the shared `logs/` folder.

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::uitext::ui_err;

type Cmd = Result<Value, String>;

const KINDS: [&str; 3] = ["avatars", "groups", "local"];

/// The app data directory could not be found or created.
fn no_data_directory() -> String {
    ui_err("err.noDataDirectory", json!({}))
}

/// An agent id that cannot name an account folder.
fn bad_log_account() -> String {
    ui_err("err.badLogAccount", json!({}))
}

/// A kind or name that resolves to no log file.
fn bad_log_target() -> String {
    ui_err("err.badLogTarget", json!({}))
}
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

/// Where one conversation's log lives, without touching the filesystem.
fn log_path(base: &Path, segment: &str, kind: &str, name: &str) -> Option<PathBuf> {
    let dir = kind_dir(base, segment, kind)?;
    let file = format!("{}.txt", sanitize_log_name(name));
    let path = dir.join(&file);
    // The sanitizer guarantees a single plain component; keep that invariant
    // checked where the path is actually assembled.
    if Path::new(&file).components().count() != 1 || !path.starts_with(&dir) {
        return None;
    }
    Some(path)
}

fn log_file(base: &Path, segment: &str, kind: &str, name: &str) -> Option<PathBuf> {
    let path = log_path(base, segment, kind, name)?;
    std::fs::create_dir_all(path.parent()?).ok()?;
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

/// Appends take turns. Messages can arrive dozens at a time, and each is
/// written by a command of its own on the thread pool: two of them in one
/// file at once could run a line into the next.
static APPENDING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A message as one line: embedded newlines become the visual "¦", so a log
/// line always equals one message.
pub fn one_line(text: &str) -> String {
    text.chars().map(|c| if c == '\n' || c == '\r' { '¦' } else { c }).collect()
}

pub fn append_line(base: &Path, agent: &str, kind: &str, name: &str, line: &str) -> Result<(), String> {
    // New lines always belong to an account; only old files live in the shared folder.
    let segment = canonical_uuid(agent).ok_or_else(bad_log_account)?;
    let path = log_file(base, &segment, kind, name).ok_or_else(bad_log_target)?;
    // One line per message; the line and its end go out in a single write.
    let mut flat = one_line(line);
    flat.push('\n');
    let _turn = APPENDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| ui_err("err.logOpenFailed", json!({ "error": e.to_string() })))?;
    file.write_all(flat.as_bytes())
        .map_err(|e| ui_err("err.logWriteFailed", json!({ "error": e.to_string() })))
}

/// Reading the last few lines only needs the end of the file; this is far more
/// than ten chat lines ever take.
const TAIL_CHUNK_BYTES: u64 = 64 * 1024;

/// The last `max` lines of one conversation's log, oldest first. Falls back to
/// the shared pre-account folder so history written by older builds still
/// shows. A missing file is an empty history, not an error, and nothing is
/// created on the way.
pub fn read_tail(base: &Path, agent: &str, kind: &str, name: &str, max: usize) -> Result<Vec<String>, String> {
    let segment = canonical_uuid(agent).ok_or_else(bad_log_account)?;
    let Some(path) = [segment.as_str(), ""]
        .iter()
        .filter_map(|seg| log_path(base, seg, kind, name))
        .find(|p| p.is_file())
    else {
        return Ok(Vec::new());
    };
    let err = |e: std::io::Error| {
        ui_err("err.logReadFailed", json!({ "error": e.to_string() }))
    };
    let mut file = std::fs::File::open(&path).map_err(err)?;
    let len = file.metadata().map_err(err)?.len();
    let start = len.saturating_sub(TAIL_CHUNK_BYTES);
    file.seek(SeekFrom::Start(start)).map_err(err)?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(err)?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    // A mid-file start point can land inside a line; the fragment goes.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let skip = lines.len().saturating_sub(max);
    Ok(lines[skip..].iter().map(|s| s.to_string()).collect())
}

/// How many lines the log reader shows at a time.
const PAGE_LINES: usize = 200;

/// The longest line a log can hold: a message of MAX_LINE_BYTES made of
/// nothing but line breaks, each flattened to the two-byte "¦". The reader
/// keeps this much of a line and drops the rest, so a file that is not a log
/// (megabytes without one line break, say) never reaches the page whole.
const MAX_STORED_LINE_BYTES: usize = 2 * MAX_LINE_BYTES;

/// A search phrase is something typed into a field, not a document.
const MAX_QUERY_CHARS: usize = 200;

/// Which page of a log the reader asks for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Want {
    /// The newest one: what a log opens on.
    Newest,
    /// A page by its number, counted from 1 (the oldest); out of range lands
    /// on the nearest end.
    Page(u64),
    /// The page that holds a given line (its place in the file, counted from
    /// 1) - a search result opened where it stands.
    Around(u64),
}

/// One page of a log, as the reader shows it.
#[derive(Debug, Default, PartialEq)]
pub struct LogPage {
    /// The page's lines, oldest first: each line's place among the file's
    /// lines (counted from 1, blank lines left out) and its text.
    pub lines: Vec<(u64, String)>,
    /// Which page this is, counted from 1 (the oldest); 0 with nothing to show.
    pub page: u64,
    pub pages: u64,
    /// Lines the search found - every line when nothing is searched for.
    pub matched: u64,
    /// Lines in the file.
    pub total: u64,
}

/// Reads the next line into `buf`, without its line break and without what
/// it holds past `cap` bytes. False once the file has ended.
fn read_capped_line(reader: &mut impl BufRead, buf: &mut Vec<u8>, cap: usize) -> std::io::Result<bool> {
    buf.clear();
    let mut any = false;
    loop {
        let chunk = match reader.fill_buf() {
            Ok(chunk) => chunk,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if chunk.is_empty() {
            return Ok(any);
        }
        any = true;
        let (len, ended) = match chunk.iter().position(|&b| b == b'\n') {
            Some(at) => (at, true),
            None => (chunk.len(), false),
        };
        let room = cap.saturating_sub(buf.len());
        buf.extend_from_slice(&chunk[..len.min(room)]);
        reader.consume(len + usize::from(ended));
        if ended {
            return Ok(true);
        }
    }
}

/// Walks a file's lines in order, handing each one that is not blank to
/// `each` with its place among them (counted from 1), until `each` answers
/// false or the file ends. The file is never held whole.
fn walk_lines(path: &Path, mut each: impl FnMut(u64, &str) -> bool) -> std::io::Result<()> {
    let mut reader = BufReader::new(std::fs::File::open(path)?);
    let mut raw = Vec::new();
    let mut place = 0u64;
    while read_capped_line(&mut reader, &mut raw, MAX_STORED_LINE_BYTES)? {
        let text = String::from_utf8_lossy(&raw);
        let text = text.trim_end_matches('\r');
        if text.trim().is_empty() {
            continue;
        }
        place += 1;
        if !each(place, text) {
            break;
        }
    }
    Ok(())
}

/// One page of a log for the reader: the whole log, or only the lines that
/// hold `query` (letter case aside). Pages are cut from the end, so the
/// newest page is always a full one and it is the oldest that comes up
/// short. The file is read exactly where the list found it - an account's
/// folder, or the shared one for an empty `agent` - with no fallback between
/// the two; a file that is not there reads as an empty log, and nothing is
/// created on the way.
pub fn read_page(
    base: &Path,
    agent: &str,
    kind: &str,
    name: &str,
    query: &str,
    want: Want,
    per_page: usize,
) -> Result<LogPage, String> {
    let segment = account_segment(agent).ok_or_else(bad_log_account)?;
    let path = log_path(base, &segment, kind, name).ok_or_else(bad_log_target)?;
    if !path.is_file() {
        return Ok(LogPage::default());
    }
    let err = |e: std::io::Error| ui_err("err.logReadFailed", json!({ "error": e.to_string() }));
    let per_page = per_page.max(1) as u64;
    let needle = query.trim().chars().take(MAX_QUERY_CHARS).collect::<String>().to_lowercase();
    let found = |text: &str| needle.is_empty() || text.to_lowercase().contains(&needle);

    // The first walk only counts: the lines, the ones the search finds, and
    // how many of those stand before the line the reader wants to land on.
    let around = match want {
        Want::Around(place) => place,
        _ => 0,
    };
    let (mut total, mut matched, mut before) = (0u64, 0u64, 0u64);
    walk_lines(&path, |place, text| {
        total = place;
        if found(text) {
            if place < around {
                before += 1;
            }
            matched += 1;
        }
        true
    })
    .map_err(err)?;
    if matched == 0 {
        return Ok(LogPage { total, ..LogPage::default() });
    }

    let pages = matched.div_ceil(per_page);
    let page = match want {
        Want::Newest => pages,
        Want::Page(page) => page.clamp(1, pages),
        // The found line at or after the wanted one; past the last, the last.
        Want::Around(_) => pages - (matched - 1 - before.min(matched - 1)) / per_page,
    };
    let end = matched - (pages - page) * per_page;
    let start = end.saturating_sub(per_page);

    // The second walk keeps the page's lines and stops where the page does.
    // The app may have added lines in between; they belong to a later read.
    let mut lines = Vec::with_capacity((end - start) as usize);
    let mut index = 0u64;
    walk_lines(&path, |place, text| {
        if found(text) {
            if index >= start {
                lines.push((place, text.to_string()));
            }
            index += 1;
        }
        index < end
    })
    .map_err(err)?;
    Ok(LogPage { lines, page, pages, matched, total })
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
    let segment = account_segment(agent).ok_or_else(bad_log_account)?;
    let dir = kind_dir(base, &segment, kind).ok_or_else(|| ui_err("err.badLogKind", json!({})))?;
    let mut deleted = 0u64;
    match name {
        Some(name) => {
            let path = log_file(base, &segment, kind, name).ok_or_else(bad_log_target)?;
            if path.is_file() {
                std::fs::remove_file(&path).map_err(|e| {
                    ui_err("err.logDeleteFailed", json!({ "error": e.to_string() }))
                })?;
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

// The commands below are `async` so Tauri runs them on its thread pool: they
// touch the filesystem, and a synchronous command would do that on the main
// (UI) thread. The JS caller sees the same result either way.

/// Append one line to a conversation's log file.
#[tauri::command]
pub async fn chat_log_append(app: tauri::AppHandle, agent: String, kind: String, name: String, line: String) -> Cmd {
    if line.len() > MAX_LINE_BYTES {
        return Err(ui_err("err.logLineTooLong", json!({})));
    }
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or_else(no_data_directory)?;
    append_line(&base, &agent, &kind, &name, &line)?;
    Ok(json!({ "ok": true }))
}

/// The last few lines of a conversation's log, shown as history when the
/// conversation opens. An absent file just means no history.
#[tauri::command]
pub async fn chat_log_tail(app: tauri::AppHandle, agent: String, kind: String, name: String, lines: Option<usize>) -> Cmd {
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or_else(no_data_directory)?;
    let max = lines.unwrap_or(10).clamp(1, 100);
    let rows = read_tail(&base, &agent, &kind, &name, max)?;
    Ok(json!({ "ok": true, "lines": rows }))
}

/// One page of a log for the log reader, optionally only the lines that hold
/// `query`. `around` asks for the page a given line is on; otherwise `page`
/// picks one, and with neither the newest page comes back.
#[tauri::command]
pub async fn chat_log_read(
    app: tauri::AppHandle,
    agent: String,
    kind: String,
    name: String,
    query: Option<String>,
    page: Option<u64>,
    around: Option<u64>,
) -> Cmd {
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or_else(no_data_directory)?;
    let want = match (around, page) {
        (Some(place), _) => Want::Around(place),
        (None, Some(page)) => Want::Page(page),
        (None, None) => Want::Newest,
    };
    let view = read_page(&base, &agent, &kind, &name, query.as_deref().unwrap_or(""), want, PAGE_LINES)?;
    let lines: Vec<Value> = view
        .lines
        .iter()
        .map(|(place, text)| json!({ "n": place, "text": text }))
        .collect();
    Ok(json!({
        "ok": true,
        "lines": lines,
        "page": view.page,
        "pages": view.pages,
        "matched": view.matched,
        "total": view.total,
    }))
}

/// The log files on disk, for the log reader. An empty `agent` marks files
/// from before logs were split per account.
#[tauri::command]
pub async fn chat_log_list(app: tauri::AppHandle) -> Cmd {
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or_else(no_data_directory)?;
    let rows: Vec<Value> = list_logs(&base)
        .into_iter()
        .map(|(agent, kind, name, bytes)| json!({ "agent": agent, "kind": kind, "name": name, "bytes": bytes }))
        .collect();
    Ok(json!({ "ok": true, "logs": rows }))
}

/// Delete one log file, or a whole kind (name omitted). Called only from the
/// log reader, behind its own confirmation.
#[tauri::command]
pub async fn chat_log_delete(app: tauri::AppHandle, agent: String, kind: String, name: Option<String>) -> Cmd {
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or_else(no_data_directory)?;
    let deleted = delete_logs(&base, &agent, &kind, name.as_deref())?;
    Ok(json!({ "ok": true, "deleted": deleted }))
}

/// How much disk the chat logs take, and where they live.
#[tauri::command]
pub async fn chat_log_usage(app: tauri::AppHandle) -> Cmd {
    let base = crate::bridge::scripts::app_data_dir(&app).ok_or_else(no_data_directory)?;
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
        let bad_kind = append_line(&base, AGENT, "..", "x", "y").unwrap_err();
        assert_eq!(crate::uitext::plain(&bad_kind), "Bad log target");
        let bad_agent = append_line(&base, "", "avatars", "x", "y").unwrap_err();
        assert_eq!(crate::uitext::plain(&bad_agent), "Bad log account");
        assert_eq!(crate::uitext::UiText::decode(&bad_agent).unwrap().key, "err.badLogAccount");
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
    fn lines_written_at_the_same_moment_stay_whole() {
        let base = std::env::temp_dir().join(format!("minibee-logburst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // A burst of messages for one conversation, each written by a thread
        // of its own, the way the commands run on the pool.
        let writers: Vec<_> = (0..8)
            .map(|w| {
                let base = base.clone();
                std::thread::spawn(move || {
                    for i in 0..25 {
                        let line = format!("[t] writer {w} line {i} {}", "x".repeat(200));
                        append_line(&base, AGENT, "avatars", "Some One", &line).unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let text = std::fs::read_to_string(base.join(AGENT).join("logs/avatars/Some One.txt")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 200);
        let tail = "x".repeat(200);
        let mut seen = std::collections::HashSet::new();
        for line in &lines {
            assert!(line.starts_with("[t] writer ") && line.ends_with(&tail), "a line ran into another: {line}");
            assert!(seen.insert(*line), "a line was written twice: {line}");
        }
        // Each writer's own lines are in the order it wrote them.
        for w in 0..8 {
            let own: Vec<&&str> = lines.iter().filter(|l| l.starts_with(&format!("[t] writer {w} "))).collect();
            let order: Vec<String> = (0..25).map(|i| format!("[t] writer {w} line {i} {tail}")).collect();
            assert_eq!(own.iter().map(|l| l.to_string()).collect::<Vec<_>>(), order);
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn tail_returns_the_last_lines_oldest_first() {
        let base = std::env::temp_dir().join(format!("minibee-logtail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        for i in 1..=15 {
            append_line(&base, AGENT, "avatars", "Some One", &format!("[t] line {i}")).unwrap();
        }
        let tail = read_tail(&base, AGENT, "avatars", "Some One", 10).unwrap();
        assert_eq!(tail.len(), 10);
        assert_eq!(tail[0], "[t] line 6");
        assert_eq!(tail[9], "[t] line 15");
        // A conversation without a file has no history, quietly, and reading
        // never plants directories.
        assert!(read_tail(&base, AGENT, "avatars", "Nobody", 10).unwrap().is_empty());
        assert!(read_tail(&base, AGENT, "groups", "No Such Group", 10).unwrap().is_empty());
        assert!(!base.join(AGENT).join("logs").join("groups").exists());
        // History written by an older build in the shared folder still shows.
        let legacy_dir = base.join("logs").join("avatars");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(legacy_dir.join("Old Friend.txt"), "[old] hello\n[old] again\n").unwrap();
        assert_eq!(
            read_tail(&base, AGENT, "avatars", "Old Friend", 10).unwrap(),
            vec!["[old] hello", "[old] again"],
        );
        // Reads carry the same account and kind checks as writes.
        assert!(read_tail(&base, "", "avatars", "x", 5).is_err());
        assert!(read_tail(&base, AGENT, "..", "x", 5).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A page as the places of its lines, which is what the tests compare.
    fn places(page: &LogPage) -> Vec<u64> {
        page.lines.iter().map(|(place, _)| *place).collect()
    }

    #[test]
    fn lines_are_read_whole_across_buffer_edges_and_cut_at_the_cap() {
        // A four-byte buffer: every line here crosses at least one refill.
        let data: &[u8] = b"abcdefghij\nxy\n\nz";
        let mut reader = BufReader::with_capacity(4, data);
        let mut buf = Vec::new();
        let mut seen = Vec::new();
        while read_capped_line(&mut reader, &mut buf, 6).unwrap() {
            seen.push(String::from_utf8(buf.clone()).unwrap());
        }
        // The long line keeps its first six bytes, the rest of it is skipped
        // (not read as a line of its own), and a last line without a line
        // break still counts.
        assert_eq!(seen, vec!["abcdef", "xy", "", "z"]);
        assert!(!read_capped_line(&mut reader, &mut buf, 6).unwrap());
    }

    #[test]
    fn pages_are_cut_from_the_end() {
        let base = std::env::temp_dir().join(format!("minibee-logpages-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        for i in 1..=45 {
            append_line(&base, AGENT, "avatars", "Some One", &format!("[t] line {i}")).unwrap();
        }
        let read = |want| read_page(&base, AGENT, "avatars", "Some One", "", want, 20).unwrap();
        // A log opens on its newest page, and that page is a full one.
        let newest = read(Want::Newest);
        assert_eq!((newest.page, newest.pages, newest.matched, newest.total), (3, 3, 45, 45));
        assert_eq!(places(&newest), (26..=45).collect::<Vec<u64>>());
        assert_eq!(newest.lines[0].1, "[t] line 26");
        assert_eq!(newest.lines[19].1, "[t] line 45");
        assert_eq!(places(&read(Want::Page(2))), (6..=25).collect::<Vec<u64>>());
        // The oldest page is the one that comes up short.
        assert_eq!(places(&read(Want::Page(1))), (1..=5).collect::<Vec<u64>>());
        // A page number out of range lands on the nearest end.
        assert_eq!(read(Want::Page(0)).page, 1);
        assert_eq!(read(Want::Page(99)).page, 3);
        // A found line opens on the page it stands on.
        assert_eq!(read(Want::Around(1)).page, 1);
        assert_eq!(read(Want::Around(5)).page, 1);
        assert_eq!(read(Want::Around(6)).page, 2);
        assert_eq!(read(Want::Around(25)).page, 2);
        assert_eq!(read(Want::Around(26)).page, 3);
        assert_eq!(read(Want::Around(45)).page, 3);
        assert_eq!(read(Want::Around(0)).page, 1);
        assert_eq!(read(Want::Around(999)).page, 3, "past the last line: the last page");
        // A count that divides evenly leaves no short page.
        let even = read_page(&base, AGENT, "avatars", "Some One", "", Want::Page(1), 15).unwrap();
        assert_eq!((even.pages, places(&even)), (3, (1..=15).collect::<Vec<u64>>()));
        // One page holds a log shorter than a page.
        let all = read_page(&base, AGENT, "avatars", "Some One", "", Want::Newest, 200).unwrap();
        assert_eq!((all.page, all.pages, all.lines.len()), (1, 1, 45));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn search_finds_lines_and_keeps_their_places() {
        let base = std::env::temp_dir().join(format!("minibee-logsearch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        for i in 1..=30 {
            let word = match i % 3 {
                0 if i % 2 == 0 => "HONEY",
                0 => "honey",
                _ => "wax",
            };
            append_line(&base, AGENT, "groups", "Bee Lovers", &format!("[t] {i} {word}")).unwrap();
        }
        append_line(&base, AGENT, "groups", "Bee Lovers", "[t] 31 Żółw idzie").unwrap();
        let read = |query, want| read_page(&base, AGENT, "groups", "Bee Lovers", query, want, 4).unwrap();
        // Ten lines hold the word, whatever its case; they come four to a
        // page, newest page first, each under its place in the whole file.
        let hits = read("Honey", Want::Newest);
        assert_eq!((hits.page, hits.pages, hits.matched, hits.total), (3, 3, 10, 31));
        assert_eq!(places(&hits), vec![21, 24, 27, 30]);
        assert_eq!(hits.lines[3].1, "[t] 30 HONEY");
        assert_eq!(places(&read("honey", Want::Page(1))), vec![3, 6]);
        // Opened around a line, the search lands on the first hit at or after it.
        assert_eq!(places(&read("honey", Want::Around(10))), vec![9, 12, 15, 18]);
        // Case folding is not ASCII-only, and spaces around the phrase are not part of it.
        assert_eq!(places(&read("  żÓŁW ", Want::Newest)), vec![31]);
        // Nothing found is not an error: no page, and the file's size still told.
        let none = read("propolis", Want::Newest);
        assert_eq!((none.page, none.pages, none.matched, none.total), (0, 0, 0, 31));
        assert!(none.lines.is_empty());
        // A phrase of spaces searches for nothing.
        assert_eq!(read("   ", Want::Newest).matched, 31);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_reader_takes_a_file_as_it_finds_it() {
        let base = std::env::temp_dir().join(format!("minibee-logread-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let read = |agent, kind, name| read_page(&base, agent, kind, name, "", Want::Newest, 50);
        // A log that is not there reads as empty, and reading plants nothing.
        assert_eq!(read(AGENT, "avatars", "Nobody").unwrap(), LogPage::default());
        assert!(!base.join(AGENT).exists());
        // The same account and kind checks as everywhere else.
        assert_eq!(crate::uitext::plain(&read("not-an-account", "avatars", "x").unwrap_err()), "Bad log account");
        assert_eq!(crate::uitext::plain(&read(AGENT, "..", "x").unwrap_err()), "Bad log target");
        // A shared file from before accounts is read under the empty account
        // only: the list says where a file is, and the reader looks nowhere else.
        let legacy_dir = base.join("logs").join("avatars");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(legacy_dir.join("Old Friend.txt"), "[old] hello\n[old] again\n").unwrap();
        assert_eq!(places(&read("", "avatars", "Old Friend").unwrap()), vec![1, 2]);
        assert!(read(AGENT, "avatars", "Old Friend").unwrap().lines.is_empty());
        // Blank lines are not lines, Windows line ends are not text, and a
        // last line without a line break is still read.
        std::fs::write(legacy_dir.join("Mixed.txt"), "one\r\n\r\n   \r\ntwo\r\nthree").unwrap();
        let mixed = read("", "avatars", "Mixed").unwrap();
        assert_eq!(
            mixed.lines,
            vec![(1, "one".to_string()), (2, "two".to_string()), (3, "three".to_string())],
        );
        // Something that is not a log: bytes that are not text, and one
        // endless line. Neither stops the reader, and the endless line is cut.
        let mut junk = vec![0xff, 0xfe, b'o', b'k', b'\n'];
        junk.extend(vec![b'x'; MAX_STORED_LINE_BYTES * 3]);
        junk.extend_from_slice(b"\nlast\n");
        std::fs::write(legacy_dir.join("Junk.txt"), &junk).unwrap();
        let odd = read("", "avatars", "Junk").unwrap();
        assert_eq!(odd.total, 3);
        assert!(odd.lines[0].1.ends_with("ok"));
        assert_eq!(odd.lines[1].1.len(), MAX_STORED_LINE_BYTES);
        assert_eq!(odd.lines[2].1, "last");
        // The longest line the app itself can write comes back whole.
        let longest = "\n".repeat(MAX_LINE_BYTES);
        append_line(&base, AGENT, "local", "chat", &longest).unwrap();
        let whole = read(AGENT, "local", "chat").unwrap();
        assert_eq!(whole.lines[0].1.chars().count(), MAX_LINE_BYTES);
        assert!(whole.lines[0].1.chars().all(|c| c == '¦'));
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
