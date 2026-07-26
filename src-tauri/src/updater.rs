//! Desktop auto-update checks and installs via `tauri-plugin-updater`.

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum UpdateCheckResponse {
    Available { version: String, notes: String },
    UpToDate,
    Unavailable,
    Error { message: String },
}

pub fn format_check_error(raw: &str) -> String {
    if raw.contains("404") || raw.to_ascii_lowercase().contains("not found") {
        return "Update feed not found. On GitHub, this release must not be marked pre-release, or /releases/latest/latest.json will 404.".into();
    }
    if raw.is_empty() {
        return "Could not check for updates.".into();
    }
    format!("Could not check for updates: {raw}")
}

#[cfg(desktop)]
mod desktop {
    use std::sync::Mutex;

    use tauri::{AppHandle, State};
    use tauri_plugin_process::ProcessExt;
    use tauri_plugin_updater::UpdaterExt;

    use super::{format_check_error, UpdateCheckResponse};

    pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

    impl Default for PendingUpdate {
        fn default() -> Self {
            Self(Mutex::new(None))
        }
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
    ) -> UpdateCheckResponse {
        let updater = match build_updater(&app) {
            Ok(updater) => updater,
            Err(_) => return UpdateCheckResponse::Unavailable,
        };

        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.to_string();
                let notes = update.body.clone().unwrap_or_default();
                *pending.0.lock().unwrap() = Some(update);
                UpdateCheckResponse::Available { version, notes }
            }
            Ok(None) => UpdateCheckResponse::UpToDate,
            Err(err) => UpdateCheckResponse::Error {
                message: format_check_error(&err.to_string()),
            },
        }
    }

    #[tauri::command]
    pub async fn app_install_update(
        app: AppHandle,
        pending: State<'_, PendingUpdate>,
    ) -> Result<(), String> {
        let update = pending
            .0
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| "No pending update.".to_string())?;

        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|err| err.to_string())?;

        app.process().restart();
        Ok(())
    }
}

#[cfg(not(desktop))]
mod desktop {
    use super::UpdateCheckResponse;

    #[tauri::command]
    pub fn app_updater_available() -> bool {
        false
    }

    #[tauri::command]
    pub async fn app_check_update() -> UpdateCheckResponse {
        UpdateCheckResponse::Unavailable
    }

    #[tauri::command]
    pub async fn app_install_update() -> Result<(), String> {
        Err("Updater is not available on this platform.".into())
    }
}

pub use desktop::{app_check_update, app_install_update, app_updater_available};

#[cfg(desktop)]
pub use desktop::PendingUpdate;

#[cfg(test)]
mod tests {
    use super::format_check_error;

    #[test]
    fn maps_404_to_prerelease_hint() {
        let msg = format_check_error("HTTP status client error (404 Not Found)");
        assert!(msg.contains("pre-release"));
    }

    #[test]
    fn empty_error_uses_default_message() {
        assert_eq!(format_check_error(""), "Could not check for updates.");
    }
}
