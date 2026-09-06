//! The viewer's persistent key-value store: one JSON file in the app data
//! directory, next to the chat logs. The webview works out of memory and
//! pushes snapshots here, so preferences survive webview storage wipes and
//! are shared by every instance on the machine.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

type Cmd = Result<Value, String>;

/// Settings are small; anything bigger than this is not settings.
const MAX_STORE_BYTES: usize = 1024 * 1024;

fn store_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(crate::bridge::scripts::app_data_dir(app)?.join("settings.json"))
}

/// Read the store, tolerating a missing or unreadable file: the frontend
/// treats an empty object as "use defaults".
pub fn read_store(path: &Path) -> Value {
    let Ok(text) = std::fs::read_to_string(path) else {
        return json!({});
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) if v.is_object() => v,
        _ => json!({}),
    }
}

/// Replace the store atomically: write a sibling temp file, then rename it
/// over the old one, so a crash mid-write never leaves half a settings file.
pub fn write_store(path: &Path, data: &Value) -> Result<(), String> {
    if !data.is_object() {
        return Err("Settings must be an object".into());
    }
    let text = serde_json::to_string_pretty(data).map_err(|e| format!("Bad settings: {e}"))?;
    if text.len() > MAX_STORE_BYTES {
        return Err("Settings too large".into());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the data directory: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("Could not write settings: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Could not replace settings: {e}"))
}

/// The stored settings object, plus where it lives (shown in About).
#[tauri::command]
pub fn settings_load(app: tauri::AppHandle) -> Cmd {
    let path = store_path(&app).ok_or("No data directory")?;
    Ok(json!({ "ok": true, "settings": read_store(&path), "path": path.to_string_lossy() }))
}

/// Replace the stored settings object.
#[tauri::command]
pub fn settings_save(app: tauri::AppHandle, settings: Value) -> Cmd {
    let path = store_path(&app).ok_or("No data directory")?;
    write_store(&path, &settings)?;
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_roundtrips_and_survives_junk() {
        let dir = std::env::temp_dir().join(format!("minibee-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("settings.json");

        assert_eq!(read_store(&path), json!({}), "missing file reads as empty");

        let data = json!({ "minibee-settings": { "theme": "light" }, "minibee-voice-peers": {} });
        write_store(&path, &data).unwrap();
        assert_eq!(read_store(&path), data);

        // Overwrites are whole-file replacements.
        let smaller = json!({ "minibee-settings": { "theme": "dark" } });
        write_store(&path, &smaller).unwrap();
        assert_eq!(read_store(&path), smaller);

        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(read_store(&path), json!({}), "corrupt file reads as empty");

        assert!(write_store(&path, &json!([1, 2, 3])).is_err(), "only an object is a store");
        let big = json!({ "blob": "x".repeat(MAX_STORE_BYTES) });
        assert!(write_store(&path, &big).is_err(), "oversized stores are refused");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
