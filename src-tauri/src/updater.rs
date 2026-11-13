//! Desktop auto-update checks and installs via `tauri-plugin-updater`.

use serde::Serialize;
use serde_json::{json, Value};

use crate::uitext::UiText;

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum UpdateCheckResponse {
    Available {
        version: String,
        notes: String,
        current_display_version: String,
    },
    UpToDate {
        current_display_version: String,
    },
    Unavailable,
    /// `message` is the English; `messageKey` and `messageArgs` beside it
    /// let the interface translate it (BeeI18n.field).
    Error {
        message: String,
        #[serde(rename = "messageKey")]
        message_key: String,
        #[serde(rename = "messageArgs")]
        message_args: Value,
    },
}

impl UpdateCheckResponse {
    /// The failed-check reply for a line: its words, key and arguments.
    pub fn error(line: UiText) -> Self {
        Self::Error { message: line.text, message_key: line.key, message_args: line.args }
    }
}

/// What a failed update check tells the person, from the updater's raw error.
pub fn format_check_error(raw: &str) -> UiText {
    if raw.contains("404") || raw.to_ascii_lowercase().contains("not found") {
        return UiText::new("updater.feedNotFound", json!({}));
    }
    if raw.is_empty() {
        return UiText::new("updater.checkFailed", json!({}));
    }
    UiText::new("updater.checkFailedDetail", json!({ "error": raw }))
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub mod imp {
    use std::sync::{Arc, Mutex};

    use serde_json::json;
    use tauri::{AppHandle, State};
    use tauri_plugin_updater::UpdaterExt;

    use crate::bridge::state::AppState;
    use crate::uitext::ui_err;

    use super::{format_check_error, UpdateCheckResponse};

    pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

    impl Default for PendingUpdate {
        fn default() -> Self {
            Self(Mutex::new(None))
        }
    }

    /// The pending-update lock was left poisoned by a panic elsewhere.
    fn lock_poisoned() -> String {
        ui_err("err.updateLockPoisoned", json!({}))
    }

    fn updater_target() -> Option<&'static str> {
        if env!("MINIBEE_TARGET").contains("universal") {
            Some("darwin-universal")
        } else {
            None
        }
    }

    fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, tauri_plugin_updater::Error> {
        let mut builder = app.updater_builder();
        if let Some(target) = updater_target() {
            builder = builder.target(target);
        }
        builder.build()
    }

    #[tauri::command]
    pub fn app_updater_available() -> bool {
        true
    }

    #[tauri::command]
    pub async fn app_check_update(
        app: AppHandle,
        pending: State<'_, PendingUpdate>,
        viewer: State<'_, Arc<AppState>>,
    ) -> Result<UpdateCheckResponse, String> {
        let current_display_version = viewer.display_version();
        let updater = match build_updater(&app) {
            Ok(updater) => updater,
            Err(_) => return Ok(UpdateCheckResponse::Unavailable),
        };

        Ok(match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.to_string();
                let notes = update.body.clone().unwrap_or_default();
                *pending.0.lock().map_err(|_| lock_poisoned())? = Some(update);
                UpdateCheckResponse::Available {
                    version,
                    notes,
                    current_display_version,
                }
            }
            Ok(None) => UpdateCheckResponse::UpToDate {
                current_display_version,
            },
            Err(err) => UpdateCheckResponse::error(format_check_error(&err.to_string())),
        })
    }

    #[tauri::command]
    pub async fn app_install_update(
        app: AppHandle,
        pending: State<'_, PendingUpdate>,
    ) -> Result<(), String> {
        let update = pending
            .0
            .lock()
            .map_err(|_| lock_poisoned())?
            .take()
            .ok_or_else(|| ui_err("err.noPendingUpdate", json!({})))?;

        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|err| err.to_string())?;

        app.restart();
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod imp {
    use serde_json::json;

    use crate::uitext::ui_err;

    use super::UpdateCheckResponse;

    #[tauri::command]
    pub fn app_updater_available() -> bool {
        false
    }

    #[tauri::command]
    pub async fn app_check_update() -> Result<UpdateCheckResponse, String> {
        Ok(UpdateCheckResponse::Unavailable)
    }

    #[tauri::command]
    pub async fn app_install_update() -> Result<(), String> {
        Err(ui_err("err.updaterUnavailableOnPlatform", json!({})))
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub use imp::PendingUpdate;

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{format_check_error, UpdateCheckResponse};

    #[test]
    fn maps_404_to_prerelease_hint() {
        let msg = format_check_error("HTTP status client error (404 Not Found)");
        assert!(msg.text.contains("pre-release"));
        assert_eq!(msg.key, "updater.feedNotFound");
    }

    #[test]
    fn empty_error_uses_default_message() {
        assert_eq!(format_check_error("").text, "Could not check for updates.");
        let detailed = format_check_error("boom");
        assert_eq!(detailed.text, "Could not check for updates: boom");
        assert_eq!(detailed.args["error"], "boom");
    }

    #[test]
    fn a_failed_check_carries_the_key_beside_the_words() {
        let v = serde_json::to_value(UpdateCheckResponse::error(format_check_error(""))).unwrap();
        assert_eq!(v["status"], "error");
        assert_eq!(v["message"], "Could not check for updates.");
        assert_eq!(v["messageKey"], "updater.checkFailed");
        assert_eq!(v["messageArgs"], json!({}));
    }
}
