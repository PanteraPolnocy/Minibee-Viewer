//! Diagnostic log, off by default. Turn it on with the `--enablelogfiles` CLI
//! flag or `MINIBEE_ENABLE_LOGFILES=1`. Once enabled, timestamped lines from
//! both Rust and the frontend (the latter via `bridge_log`) are gathered into a
//! single file; when it's off, every log call is a cheap no-op.

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;

static ENABLED: AtomicBool = AtomicBool::new(false);
static SINK: Lazy<Mutex<Option<std::fs::File>>> = Lazy::new(|| Mutex::new(None));

/// We keep our own subdirectory under the temp dir, created 0700 on unix (see
/// `init`). That way, on a shared /tmp the log isn't world-readable and no other
/// local user can pre-plant its path as a symlink.
fn log_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("minibee-viewer")
}

/// Full path to the log file: `<temp>/minibee-viewer/minibee-viewer.log`.
pub fn path() -> std::path::PathBuf {
    log_dir().join("minibee-viewer.log")
}

/// True when the user has asked for logging, whether via the flag or the env var.
pub fn wants_logging() -> bool {
    std::env::args().any(|a| a == "--enablelogfiles")
        || std::env::var("MINIBEE_ENABLE_LOGFILES")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Called once at startup to decide whether we're logging; if so, truncate the
/// file and open it.
pub fn init() {
    if !wants_logging() {
        return;
    }
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path())
        .ok();
    if file.is_some() {
        if let Ok(mut guard) = SINK.lock() {
            *guard = file;
        }
        ENABLED.store(true, Ordering::Relaxed);
        log("rust", "diaglog started");
    }
}

fn millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Append a single line in the form `<unix_ms> [<source>] <msg>`. Does nothing
/// unless logging is enabled.
pub fn log(source: &str, msg: &str) {
    if !is_enabled() {
        return;
    }
    if let Ok(mut guard) = SINK.lock() {
        if let Some(file) = guard.as_mut() {
            let _ = writeln!(file, "{} [{}] {}", millis(), source, msg);
            let _ = file.flush();
        }
    }
}

#[macro_export]
macro_rules! dlog {
    ($($arg:tt)*) => {
        if $crate::diaglog::is_enabled() {
            $crate::diaglog::log("rust", &format!($($arg)*));
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_by_default_is_noop() {
        // With no init() call we stay disabled, so this must neither panic nor write.
        assert!(!is_enabled());
        log("test", "should be dropped");
    }

    #[test]
    fn path_is_named() {
        assert!(path().to_string_lossy().ends_with("minibee-viewer.log"));
    }
}
