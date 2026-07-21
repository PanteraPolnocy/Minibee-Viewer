pub mod bridge;
pub mod codec;
pub mod commands;
pub mod urlmatch;

use bridge::state::{version_payload, AppState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Single source of truth for version: tauri.conf.json
            // (productName = channel, version = semver). No version.json.
            let channel = app
                .config()
                .product_name
                .clone()
                .unwrap_or_else(|| "Minibee-Viewer".to_string());
            let v = app.package_info().version.clone();
            let build: u64 = v.build.as_str().parse().unwrap_or(0);
            let (version, ua) = version_payload(&channel, v.major, v.minor, v.patch, build);
            app.manage(AppState::new(version, ua));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bridge_health,
            commands::bridge_version,
            commands::bridge_login,
            commands::bridge_proxy,
            commands::bridge_destinations,
            commands::bridge_map_tile,
            commands::bridge_map_region,
            commands::bridge_map_regions,
            commands::bridge_region_by_name,
            commands::bridge_linkify,
            commands::sl_open_circuit,
            commands::sl_close_circuit,
            commands::sl_retarget,
            commands::sl_send,
            commands::sl_send_raw,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
