// The parcel handler builds one big json! literal, and the default limit of 128 is too low to expand it.
#![recursion_limit = "512"]

pub mod bridge;
pub mod chatlogs;
pub mod codec;
pub mod commands;
pub mod diaglog;
pub mod settings;
pub mod updater;
pub mod urlmatch;

use bridge::state::{version_payload, viewer_channel, viewer_display_version, AppState};
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager};

/// Turn off the webview's own right-click menu, so the one the viewer draws is the only
/// one there is.
#[cfg(target_os = "windows")]
fn silence_native_context_menu(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        if let Ok(core) = webview.controller().CoreWebView2() {
            if let Ok(settings) = core.Settings() {
                let _ = settings.SetAreDefaultContextMenusEnabled(false.into());
            }
        }
    });
}

/// Elsewhere the webview has no equivalent switch, so frames keep the platform's menu.
#[cfg(not(target_os = "windows"))]
fn silence_native_context_menu(_window: &tauri::WebviewWindow) {}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn register_desktop_plugins(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    let builder = register_desktop_plugins(builder);
    builder
        .setup(|app| {
            diaglog::init();
            // Log the viewer, build, and system details right under the "diaglog started" line.
            commands::log_about();
            // Grab the version straight from Cargo.toml.
            let channel_base = app
                .config()
                .product_name
                .clone()
                .unwrap_or_else(|| "Minibee-Viewer".to_string());
            let channel = viewer_channel(&channel_base);
            let v = app.package_info().version.clone();
            let tauri_build: u64 = v.build.as_str().parse().unwrap_or(0);
            let build = bridge::state::login_build_number(tauri_build);
            let (version, ua) = version_payload(&channel, v.major, v.minor, v.patch, build);
            let window_title = format!(
                "Minibee Viewer {}",
                viewer_display_version(v.major, v.minor, v.patch, build, &channel)
            );
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&window_title);
                silence_native_context_menu(&window);
            }
            app.manage(AppState::new(version, ua));
            #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
            app.manage(updater::PendingUpdate::default());
            Ok(())
        })
        // Catch the native window close so the frontend can raise a logout
        // confirmation while a session is still live. Only fires once the frontend
        // has armed close_guard (i.e. logged in); the login screen closes normally.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<std::sync::Arc<AppState>>();
                let already_asked = state.close_pending.load(Ordering::SeqCst);
                if state.close_guard.load(Ordering::SeqCst) && !already_asked {
                    state.close_pending.store(true, Ordering::SeqCst);
                    api.prevent_close();
                    let _ = window.emit("minibee-viewer://close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::bridge_health,
            commands::bridge_version,
            commands::bridge_relogin,
            commands::app_about,
            commands::app_license,
            commands::app_readme,
            commands::app_help,
            commands::app_privacy,
            commands::app_memory,
            commands::app_distribution,
            updater::imp::app_updater_available,
            updater::imp::app_check_update,
            updater::imp::app_install_update,
            commands::set_close_guard,
            commands::confirm_close,
            commands::cancel_close,
            commands::bridge_login,
            commands::bridge_proxy,
            commands::bridge_destinations,
            commands::bridge_feed,
            commands::bridge_map_tile,
            commands::bridge_map_region,
            commands::bridge_map_regions,
            commands::bridge_region_by_name,
            commands::bridge_linkify,
            commands::bridge_classify_url,
            commands::bridge_log,
            commands::bridge_log_path,
            commands::sl_open_circuit,
            commands::sl_start_session,
            commands::sl_close_circuit,
            commands::sl_retarget,
            commands::sl_send,
            commands::sl_send_raw,
            commands::sl_chat_send,
            commands::sl_im_send,
            commands::sl_send_typing,
            commands::sl_inventory_offer_respond,
            commands::sl_group_join,
            commands::sl_group_leave,
            commands::sl_group_activate,
            commands::sl_group_save_title,
            commands::sl_group_request_titles,
            commands::sl_group_invite,
            commands::sl_pay,
            commands::sl_request_balance,
            bridge::currency::sl_currency_quote,
            bridge::currency::sl_currency_buy,
            commands::sl_teleport_to,
            commands::sl_teleport_home,
            bridge::landmarks::sl_landmarks_list,
            bridge::landmarks::sl_landmark_info,
            bridge::landmarks::sl_teleport_landmark,
            bridge::scripts::sl_scripts_list,
            bridge::scripts::sl_script_source,
            bridge::scripts::sl_script_save,
            bridge::scripts::sl_script_create,
            bridge::scripts::sl_script_rename,
            bridge::scripts::sl_lsl_language,
            bridge::scripts::sl_lsl_format,
            bridge::notecards::sl_notecards_list,
            bridge::notecards::sl_notecard_source,
            bridge::notecards::sl_notecard_save,
            bridge::notecards::sl_notecard_create,
            chatlogs::chat_log_append,
            chatlogs::chat_log_usage,
            chatlogs::chat_log_list,
            chatlogs::chat_log_delete,
            settings::settings_load,
            settings::settings_save,
            bridge::abuse::sl_abuse_categories,
            bridge::abuse::sl_report_abuse,
            bridge::voice::sl_voice_stun,
            bridge::voice::sl_voice_neighbours,
            bridge::voice::sl_voice_provision,
            bridge::voice::sl_voice_ice,
            bridge::voice::sl_voice_logout,
            bridge::voice::sl_voice_position,
            bridge::voice::sl_voice_call_request,
            bridge::voice::sl_voice_call_p2p,
            bridge::voice::sl_voice_call_provision,
            commands::sl_teleport_to_agent,
            commands::sl_current_slurl,
            commands::sl_teleport_cancel,
            commands::sl_stand_up,
            commands::sl_sit_ground,
            commands::sl_set_flying,
            commands::sl_avatar_state,
            commands::sl_object_scan,
            commands::sl_nearby_objects,
            commands::sl_object_details,
            commands::sl_object_touch,
            commands::sl_object_sit,
            commands::sl_object_select,
            commands::sl_object_pay,
            commands::sl_request_pay_price,
            bridge::caps::sl_object_extra,
            commands::sl_resolve_names,
            commands::sl_resolve_group_names,
            commands::sl_request_mute_list,
            commands::sl_block_agent,
            commands::sl_unblock_agent,
            commands::sl_request_parcel,
            commands::sl_request_covenant,
            commands::sl_fetch_covenant_text,
            bridge::caps::sl_parcel_environment,
            bridge::caps::sl_experience_names,
            commands::sl_request_parcel_access,
            commands::sl_update_parcel_access,
            commands::sl_request_parcel_object_owners,
            commands::sl_parcel_return_objects,
            commands::sl_parcel_set_autoreturn,
            commands::sl_parcel_buy,
            commands::sl_parcel_release,
            commands::sl_parcel_buy_pass,
            commands::sl_parcel_deed_to_group,
            commands::sl_reply_script_dialog,
            commands::sl_logout,
            commands::sl_accept_teleport_offer,
            commands::sl_decline_teleport_offer,
            commands::sl_send_teleport_offer,
            commands::sl_send_teleport_request,
            commands::sl_offer_friendship,
            commands::sl_accept_friendship,
            commands::sl_decline_friendship,
            commands::sl_remove_friendship,
            commands::sl_accept_calling_card,
            commands::sl_decline_calling_card,
            commands::sl_request_map_area,
            commands::sl_request_map_name,
            commands::sl_request_map_agents,
            commands::sl_reply_script_permission,
            commands::sl_save_notes,
            commands::sl_search_people,
            commands::sl_update_parcel,
            commands::sl_request_avatar_properties,
            commands::sl_request_group_profile,
            commands::sl_request_avatar_notes,
            commands::sl_request_avatar_picks,
            commands::sl_request_avatar_classifieds,
            commands::sl_request_pick_info,
            commands::sl_request_classified_info,
            commands::sl_request_parcel_info,
            commands::sl_search_places,
            commands::sl_search_groups,
            bridge::caps::sl_resolve_display_names,
            bridge::caps::sl_remote_parcel,
            bridge::caps::sl_fetch_agent_profile,
            bridge::caps::sl_chat_session_accept,
            bridge::caps::sl_chat_session_decline,
            bridge::caps::sl_chat_session_start_conference,
            bridge::caps::sl_chat_session_invite,
            bridge::caps::sl_chat_session_moderate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
