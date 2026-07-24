//! Tauri IPC command handlers: bridge helpers plus UDP circuit control.

use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::bridge::state::AppState;
use crate::bridge::util::{normalize_seed_url, normalize_sim_ip, trim_quotes};
use crate::bridge::{circuit, login, map, proxy};
use crate::codec;
use crate::urlmatch;

type Cmd = Result<Value, String>;

fn gs(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

#[tauri::command]
pub async fn bridge_health(state: State<'_, Arc<AppState>>) -> Cmd {
    Ok(json!({
        "ok": true,
        "role": "native",
        "sessions": state.sessions.lock().unwrap().len(),
        "udp": true,
        "poll": { "ok": true },
        "viewer": state.version.clone(),
        // In a debug build the WebView keeps its context menu (Reload etc.);
        // release builds turn it off, and the frontend reads this flag to decide.
        "dev": cfg!(debug_assertions),
    }))
}

#[tauri::command]
pub async fn bridge_version(state: State<'_, Arc<AppState>>) -> Cmd {
    Ok(state.version.clone())
}

/// "About Minibee" metadata for the Settings → About subtab. It comes from
/// tauri.conf.json (baked in with `include_str!`) plus Cargo package info, so
/// author/contact/catchphrase all share a single source of truth. Read lazily:
/// the frontend only invokes it the first time the About subtab is opened.
#[tauri::command]
pub fn app_about() -> Cmd {
    let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap_or(Value::Null);
    let bundle = conf.get("bundle").cloned().unwrap_or(Value::Null);
    let field = |v: &Value, key: &str| v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let or = |value: String, fallback: &str| if value.is_empty() { fallback.to_string() } else { value };

    let name = or(field(&conf, "productName"), "Minibee Viewer").replace('-', " ");
    // LTO is enabled only for the release profile (see Cargo.toml).
    let is_release = env!("MINIBEE_PROFILE") == "release";

    // Cross-platform OS detection: name + version + edition, e.g. "Windows 11 (Pro)".
    let osi = os_info::get();
    let mut os_version = osi.os_type().to_string();
    let ver = osi.version().to_string();
    if !ver.is_empty() && !ver.eq_ignore_ascii_case("unknown") {
        os_version.push(' ');
        os_version.push_str(&ver);
    }
    if let Some(edition) = osi.edition() {
        os_version.push_str(&format!(" ({edition})"));
    }
    let (mem_total, mem_used, mem_proc) = mem_snapshot();

    Ok(json!({
        "name": name,
        "version": env!("CARGO_PKG_VERSION"),
        "catchphrase": or(field(&bundle, "longDescription"), "A lightweight buzz into the infinite grid."),
        "description": or(field(&bundle, "shortDescription"), "Minimalist client for Second Life"),
        "author": or(field(&bundle, "publisher"), env!("CARGO_PKG_AUTHORS")),
        "homepage": field(&bundle, "homepage"),
        // Build metadata (from build.rs). buildEpoch is in seconds; the UI formats it.
        "build": {
            "profile": env!("MINIBEE_PROFILE"),
            "optLevel": env!("MINIBEE_OPT_LEVEL"),
            "lto": is_release,
            "rustc": env!("MINIBEE_RUSTC"),
            "target": env!("MINIBEE_TARGET"),
            "host": env!("MINIBEE_HOST"),
            "buildEpoch": env!("MINIBEE_BUILD_EPOCH"),
            "debugAssertions": cfg!(debug_assertions),
        },
        // Specs of the host we're actually running on.
        "system": {
            "os": std::env::consts::OS,
            "osVersion": os_version,
            "arch": std::env::consts::ARCH,
            "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
            "memTotal": mem_total,
            "memUsed": mem_used,
            "memProcess": mem_proc,
        },
    }))
}

/// Memory in bytes, returned as (total, used, minibee-process).
fn mem_snapshot() -> (u64, u64, u64) {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let total = sys.total_memory();
    let used = sys.used_memory();
    let proc = sysinfo::get_current_pid()
        .ok()
        .map(|pid| {
            sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
            sys.process(pid).map(|p| p.memory()).unwrap_or(0)
        })
        .unwrap_or(0);
    (total, used, proc)
}

/// Current system and Minibee memory (bytes) for the About tab's periodic refresh.
#[tauri::command]
pub fn app_memory() -> Cmd {
    let (total, used, proc) = mem_snapshot();
    Ok(json!({ "total": total, "used": used, "process": proc }))
}

/// Write the About-tab details (version, build, system) to the diagnostic log at
/// startup, so a shared log carries the same context even without opening the app.
pub fn log_about() {
    let (mem_total, _used, _proc) = mem_snapshot();
    let osi = os_info::get();
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    crate::dlog!(
        "about: Minibee Viewer v{} [{}] lto={} opt={}",
        env!("CARGO_PKG_VERSION"),
        env!("MINIBEE_PROFILE"),
        env!("MINIBEE_PROFILE") == "release",
        env!("MINIBEE_OPT_LEVEL")
    );
    crate::dlog!(
        "about: compiler [{}] target {}",
        env!("MINIBEE_RUSTC"),
        env!("MINIBEE_TARGET")
    );
    crate::dlog!(
        "about: os {} {} arch {} cpus {} memTotal {}MB",
        osi.os_type(),
        osi.version(),
        std::env::consts::ARCH,
        cpus,
        mem_total / (1024 * 1024)
    );
}

/// The complete LICENSE text, baked in at build time; Settings → License reads it lazily.
#[tauri::command]
pub fn app_license() -> Cmd {
    Ok(json!({ "text": include_str!("../../LICENSE") }))
}

/// The complete README text, baked in at build time; Settings → README reads it lazily.
#[tauri::command]
pub fn app_readme() -> Cmd {
    Ok(json!({ "text": include_str!("../../README.md") }))
}

/// The plain-language user guide, baked in at build time; Settings → Help reads it lazily.
#[tauri::command]
pub fn app_help() -> Cmd {
    Ok(json!({ "text": include_str!("../../HELP.md") }))
}

/// Turn window-close interception on or off. The frontend sets this true while a
/// session is live, so closing the window raises a logout confirmation, and false
/// otherwise (on the login screen) so the window just closes immediately.
#[tauri::command]
pub fn set_close_guard(state: State<'_, Arc<AppState>>, guard: bool) {
    state
        .close_guard
        .store(guard, std::sync::atomic::Ordering::SeqCst);
}

/// Quit the app once the user confirms the close in the logout dialog. It only
/// acts on a close the user genuinely initiated via the window control (which
/// arms `close_pending`); any other caller is ignored, so a malicious
/// in-world link cannot quit the viewer.
#[tauri::command]
pub fn confirm_close(window: tauri::Window, state: State<'_, Arc<AppState>>) {
    if state
        .close_pending
        .swap(false, std::sync::atomic::Ordering::SeqCst)
    {
        let _ = window.destroy();
    }
}

#[tauri::command]
pub async fn bridge_login(state: State<'_, Arc<AppState>>, payload: Value) -> Cmd {
    login::login(state.inner().clone(), payload).await
}

/// Auto-reconnect: replay the last successful login from the credentials the
/// core cached (obfuscated) at login time. It returns the same shape as
/// bridge_login, so the frontend reuses its normal session-start path. Errors
/// if nothing is cached (e.g. the user never logged in, or logged out).
#[tauri::command]
pub async fn bridge_relogin(state: State<'_, Arc<AppState>>) -> Cmd {
    let creds = state
        .creds
        .reveal()
        .ok_or_else(|| "No stored session to reconnect".to_string())?;
    login::login(state.inner().clone(), creds).await
}

fn is_eventqueue_poll(payload: &str) -> bool {
    payload.contains("<key>done</key>")
}

#[tauri::command]
pub async fn bridge_proxy(state: State<'_, Arc<AppState>>, params: Value) -> Cmd {
    let method = {
        let m = gs(&params, "method");
        if m.is_empty() { "POST".to_string() } else { m.to_ascii_uppercase() }
    };
    let raw_url = gs(&params, "url");
    if raw_url.is_empty() {
        return Err("url required".into());
    }
    let url = normalize_seed_url(&raw_url);
    if let Some(reason) = proxy::egress_block_reason(&url) {
        return Err(format!("Proxy target refused: {reason}"));
    }
    let is_post = method == "POST";
    let payload = if is_post { gs(&params, "body") } else { String::new() };
    let content_type = {
        let c = gs(&params, "contentType");
        if c.is_empty() { "application/llsd+xml".to_string() } else { c }
    };
    let session_id = gs(&params, "sessionId");
    let pre_circuit = params.get("preCircuit").and_then(|v| v.as_bool()).unwrap_or(false);
    let explicit_port = params.get("udpListenPort").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
    let sim_ip_param = gs(&params, "simIp");
    let pin_sim_ip = params.get("pinSimIp").map(|v| v != &Value::Bool(false)).unwrap_or(true);
    let agent_session_id = trim_quotes(&gs(&params, "agentSessionId"));
    let parse_llsd = params.get("parseLlsd").and_then(|v| v.as_bool()).unwrap_or(false);
    let timeout_sec = params
        .get("timeoutSec")
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(10, 95))
        .unwrap_or(45);

    // Pull the UDP listen port and sim IP from the circuit session when we have one.
    let session = if session_id.is_empty() { None } else { state.session(&session_id) };
    let udp_listen_port = if pre_circuit {
        0
    } else if explicit_port > 0 {
        explicit_port
    } else {
        session.as_ref().map(|s| s.local_port).unwrap_or(0)
    };
    let sim_ip = if !sim_ip_param.is_empty() {
        normalize_sim_ip(&json!(sim_ip_param))
    } else {
        session.as_ref().map(|s| s.sim_ip()).unwrap_or_default()
    };

    let mut headers: Vec<(String, String)> = Vec::new();
    if !agent_session_id.is_empty() {
        headers.push(("X-SecondLife-Session-ID".into(), agent_session_id.clone()));
    }
    if udp_listen_port > 0 {
        headers.push(("X-SecondLife-UDP-Listen-Port".into(), udp_listen_port.to_string()));
    }

    let (pin, pinned_ip) = proxy::simhost_pin(&url, if pin_sim_ip { &sim_ip } else { "" }).await;

    // EventQueueGet long-polls are single-flight per (url, agent session).
    // `lane` must outlive `_lane_guard` (the guard borrows lane), so declare it first.
    let lane;
    let _lane_guard;
    if is_eventqueue_poll(&payload) {
        let key = format!("{}|{}", normalize_seed_url(&url), agent_session_id);
        lane = state.eq_lane(&key).await;
        _lane_guard = lane.lock().await;
    }

    let exchange = proxy::exchange(
        &state.ua,
        &method,
        &url,
        &payload,
        &content_type,
        &headers,
        pin,
        Duration::from_secs(timeout_sec),
        true,
    )
    .await?;

    let mut out = json!({
        "status": exchange.status,
        "contentType": exchange.content_type,
        "body": exchange.body,
        "effectiveUrl": exchange.effective_url,
        "redirectCount": exchange.redirect_count,
        "requestBytes": if is_post { payload.len() } else { 0 },
        "responseBytes": exchange.body.len(),
        "udpListenPort": udp_listen_port,
        "simPinnedIp": pinned_ip,
    });
    // Optionally parse the LLSD response body in Rust so the caller (EventQueue,
    // caps) gets structured data without needing a second parse on the JS side.
    if parse_llsd {
        let parsed = codec::llsd::parse(&exchange.body, &exchange.content_type).unwrap_or(Value::Null);
        if let Value::Object(ref mut m) = out {
            m.insert("parsed".into(), parsed);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn bridge_destinations(state: State<'_, Arc<AppState>>, feed: String) -> Cmd {
    let f = feed.trim().to_ascii_lowercase();
    Ok(map::fetch_destinations_feed(state.inner(), &f).await)
}

#[tauri::command]
pub async fn bridge_map_tile(
    state: State<'_, Arc<AppState>>,
    level: i64,
    x: i64,
    y: i64,
    server: Option<String>,
) -> Cmd {
    let level = level.clamp(1, 8);
    if !(0..=65535).contains(&x) || !(0..=65535).contains(&y) {
        return Err("invalid tile coordinates".into());
    }
    let server = server.unwrap_or_else(|| "https://map.secondlife.com/".into());
    map::fetch_map_tile(state.inner(), level, x, y, &server).await
}

#[tauri::command]
pub async fn bridge_map_region(state: State<'_, Arc<AppState>>, x: i64, y: i64) -> Cmd {
    if !(0..=65535).contains(&x) || !(0..=65535).contains(&y) {
        return Err("invalid grid coordinates".into());
    }
    Ok(map::fetch_region_by_grid(state.inner(), x, y).await)
}

#[tauri::command]
pub async fn bridge_map_regions(state: State<'_, Arc<AppState>>, tiles: String) -> Cmd {
    if tiles.trim().is_empty() {
        return Err("tiles required".into());
    }
    Ok(map::fetch_regions_by_grid_batch(state.inner(), &tiles).await)
}

#[tauri::command]
pub async fn bridge_region_by_name(state: State<'_, Arc<AppState>>, name: String) -> Cmd {
    if name.trim().is_empty() {
        return Err("region name required".into());
    }
    Ok(map::fetch_region_by_name(state.inner(), &name).await)
}

/// Break chat/IM text into link segments, each with a trust classification.
#[tauri::command]
pub async fn bridge_linkify(text: String) -> Cmd {
    Ok(json!({ "segments": urlmatch::linkify(&text) }))
}

/// Append a line from the frontend to the shared diagnostic log (a no-op unless enabled).
#[tauri::command]
pub async fn bridge_log(source: Option<String>, message: String) -> Cmd {
    crate::diaglog::log(source.as_deref().unwrap_or("js"), &message);
    Ok(json!({ "ok": true }))
}

/// Report whether diagnostic logging is on, and where its file lives.
#[tauri::command]
pub async fn bridge_log_path() -> Cmd {
    Ok(json!({
        "enabled": crate::diaglog::is_enabled(),
        "path": crate::diaglog::path().to_string_lossy(),
    }))
}

// --- Outbound UI-action commands (engine path) ------------------------------
//
// Each one acts on the single active engine circuit and encodes exactly one SL
// message. Variable string fields are NUL-terminated then base64'd (`vstr`). The
// UI paints its own optimistic echo (e.g. an outgoing IM), so these only send.

const ZERO_UUID: &str = "00000000-0000-0000-0000-000000000000";

/// NUL-terminate a string and base64-encode it for a Variable field.
fn vstr(s: &str) -> Value {
    json!(B64.encode(format!("{s}\0").as_bytes()))
}

/// The active engine circuit together with its (agent_id, session_uuid).
fn active_ids(
    state: &AppState,
) -> Result<(std::sync::Arc<crate::bridge::circuit::Session>, String, String), String> {
    let s = state.active().ok_or("No active session")?;
    let (a, sess) = s.agent_ids().ok_or("Session not ready")?;
    Ok((s, a, sess))
}

/// Parse a leading `/<channel> message` prefix (channel 0 if there isn't one).
fn parse_chat_channel(msg: &str, default_ch: i64) -> (String, i64) {
    if let Some(after) = msg.strip_prefix('/') {
        let bytes = after.as_bytes();
        let mut idx = if bytes.first() == Some(&b'-') { 1 } else { 0 };
        let start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        if idx > start {
            let ch = after[..idx].parse().unwrap_or(default_ch);
            return (after[idx..].trim_start().to_string(), ch);
        }
    }
    (msg.to_string(), default_ch)
}

/// Build a region handle from grid indices (X in the high 32 bits, both in metres).
fn region_handle(grid_x: i64, grid_y: i64) -> u64 {
    ((grid_x.max(0) as u64 * 256) << 32) | (grid_y.max(0) as u64 * 256)
}

#[tauri::command]
pub async fn sl_chat_send(
    state: State<'_, Arc<AppState>>,
    message: String,
    channel: Option<i64>,
    chat_type: Option<i64>,
) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let (text, ch) = parse_chat_channel(&message, channel.unwrap_or(0));
    s.send_encoded(
        "ChatFromViewer",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ChatData": [{ "Message": vstr(&text), "Type": chat_type.unwrap_or(1), "Channel": ch }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_im_send(
    state: State<'_, Arc<AppState>>,
    to_id: String,
    im_id: Option<String>,
    dialog: Option<i64>,
    text: String,
    from_group: Option<bool>,
) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let dialog = dialog.unwrap_or(0);
    let id = im_id.unwrap_or_else(|| ZERO_UUID.to_string());
    s.send_encoded(
        "ImprovedInstantMessage",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "MessageBlock": [{
                "FromGroup": from_group.unwrap_or(false),
                "ToAgentID": if to_id.is_empty() { ZERO_UUID.to_string() } else { to_id },
                "ParentEstateID": 0, "RegionID": ZERO_UUID, "Position": [0.0, 0.0, 0.0],
                "Offline": 0, "Dialog": dialog, "ID": id, "Timestamp": 0,
                "FromAgentName": vstr(""), "Message": vstr(&text), "BinaryBucket": vstr(""),
            }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_send_typing(state: State<'_, Arc<AppState>>, to_id: String, typing: bool) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "ImprovedInstantMessage",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "MessageBlock": [{
                "FromGroup": false, "ToAgentID": to_id, "ParentEstateID": 0, "RegionID": ZERO_UUID,
                "Position": [0.0, 0.0, 0.0], "Offline": 0, "Dialog": if typing { 41 } else { 42 },
                "ID": ZERO_UUID, "Timestamp": 0, "FromAgentName": vstr(""),
                "Message": vstr("typing"), "BinaryBucket": vstr(""),
            }],
        }),
        false,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_group_join(state: State<'_, Arc<AppState>>, group_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "JoinGroupRequest",
        &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess }], "GroupData": [{ "GroupID": group_id }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_group_leave(state: State<'_, Arc<AppState>>, group_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "LeaveGroupRequest",
        &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess }], "GroupData": [{ "GroupID": group_id }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_group_activate(state: State<'_, Arc<AppState>>, group_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let gid = if group_id.is_empty() { ZERO_UUID.to_string() } else { group_id };
    // Diagnostic for those intermittent "active group didn't change" reports: the
    // UI only reflects the change once the sim answers with AgentDataUpdate
    // (logged there too), so pairing these two lines shows if a reply went missing.
    crate::dlog!("ActivateGroup -> {}", gid);
    s.send_encoded(
        "ActivateGroup",
        &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess, "GroupID": gid }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_group_save_title(state: State<'_, Arc<AppState>>, group_id: String, role_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    // role_id may legitimately be the zero UUID (the default "Everyone" title), but
    // the group itself must be real.
    if group_id.is_empty() || group_id == ZERO_UUID {
        return Err("No group for title".into());
    }
    s.send_encoded(
        "GroupTitleUpdate",
        &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess, "GroupID": group_id, "TitleRoleID": role_id }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_avatar_properties(state: State<'_, Arc<AppState>>, avatar_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    // The sim answers back with the AvatarProperties, Interests, and Groups replies.
    s.send_encoded(
        "AvatarPropertiesRequest",
        &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess, "AvatarID": avatar_id }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_group_profile(state: State<'_, Arc<AppState>>, group_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "GroupProfileRequest",
        &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess }], "GroupData": [{ "GroupID": group_id }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

/// A legacy `GenericMessage` request carrying a param list of single strings.
async fn generic_message(s: &crate::bridge::circuit::Session, agent: &str, sess: &str, method: &str, params: &[String]) {
    let param_list: Vec<Value> = params.iter().map(|p| json!({ "Parameter": vstr(p) })).collect();
    s.send_encoded(
        "GenericMessage",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess, "TransactionID": ZERO_UUID }],
            "MethodData": [{ "Method": vstr(method), "Invoice": ZERO_UUID }],
            "ParamList": param_list,
        }),
        true,
    )
    .await;
}

#[tauri::command]
pub async fn sl_request_avatar_notes(state: State<'_, Arc<AppState>>, avatar_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    generic_message(&s, &agent, &sess, "avatarnotesrequest", &[avatar_id]).await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_avatar_picks(state: State<'_, Arc<AppState>>, avatar_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    generic_message(&s, &agent, &sess, "avatarpicksrequest", &[avatar_id]).await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_avatar_classifieds(state: State<'_, Arc<AppState>>, avatar_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    generic_message(&s, &agent, &sess, "avatarclassifiedsrequest", &[avatar_id]).await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_pick_info(state: State<'_, Arc<AppState>>, avatar_id: String, pick_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    generic_message(&s, &agent, &sess, "pickinforequest", &[avatar_id, pick_id]).await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_classified_info(state: State<'_, Arc<AppState>>, classified_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "ClassifiedInfoRequest",
        &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess }], "Data": [{ "ClassifiedID": classified_id }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_parcel_info(state: State<'_, Arc<AppState>>, parcel_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "ParcelInfoRequest",
        &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess }], "Data": [{ "ParcelID": parcel_id }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_search_groups(state: State<'_, Arc<AppState>>, query: String, start: Option<i64>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let query_id = crate::bridge::circuit::gen_id();
    // DFQ_GROUPS (0x1 << 4); the reply arrives as DirGroupsReply.
    s.send_encoded(
        "DirFindQuery",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "QueryData": [{ "QueryID": query_id, "QueryText": vstr(&query), "QueryFlags": 16, "QueryStart": start.unwrap_or(0) }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true, "queryId": query_id }))
}

#[tauri::command]
pub async fn sl_search_places(state: State<'_, Arc<AppState>>, query: String, category: Option<i64>, flags: Option<i64>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let query_id = crate::bridge::circuit::gen_id();
    s.send_encoded(
        "DirPlacesQuery",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "QueryData": [{
                "QueryID": query_id, "QueryText": vstr(&query), "QueryFlags": flags.unwrap_or(0),
                "Category": category.unwrap_or(-1), "SimName": vstr(""), "QueryStart": 0
            }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true, "queryId": query_id }))
}

#[tauri::command]
pub async fn sl_group_request_titles(state: State<'_, Arc<AppState>>, group_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "GroupTitlesRequest",
        &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess, "GroupID": group_id, "RequestID": crate::bridge::circuit::gen_id() }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_pay(state: State<'_, Arc<AppState>>, dest_id: String, amount: i64, description: Option<String>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if amount < 1 {
        return Err("amount must be >= 1".into());
    }
    s.send_encoded(
        "MoneyTransferRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "MoneyData": [{
                "SourceID": agent, "DestID": dest_id, "Flags": 0, "Amount": amount,
                "AggregatePermNextOwner": 0, "AggregatePermInventory": 0,
                "TransactionType": 5001, "Description": vstr(&description.unwrap_or_default()),
            }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_teleport_to(
    state: State<'_, Arc<AppState>>,
    grid_x: i64,
    grid_y: i64,
    x: f64,
    y: f64,
    z: f64,
) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let handle = region_handle(grid_x, grid_y);
    s.send_encoded(
        "TeleportLocationRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "Info": [{ "RegionHandle": handle.to_string(), "Position": [x, y, z], "LookAt": [x + 1.0, y, z] }],
        }),
        true,
    )
    .await;
    // Echo the resolved target back so the caller (map selection) has the coords
    // instead of a bare {ok:true}.
    Ok(json!({ "ok": true, "gridX": grid_x, "gridY": grid_y, "x": x, "y": y, "z": z }))
}

#[tauri::command]
pub async fn sl_teleport_home(state: State<'_, Arc<AppState>>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "TeleportLandmarkRequest",
        &json!({ "Info": [{ "AgentID": agent, "SessionID": sess, "LandmarkID": ZERO_UUID }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_teleport_cancel(state: State<'_, Arc<AppState>>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "TeleportCancel",
        &json!({ "Info": [{ "AgentID": agent, "SessionID": sess }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_resolve_names(state: State<'_, Arc<AppState>>, ids: Vec<String>) -> Cmd {
    let (s, _a, _sess) = active_ids(&state)?;
    let blocks = json!({ "UUIDNameBlock": ids.iter().take(40).map(|id| json!({ "ID": id })).collect::<Vec<_>>() });
    s.send_encoded("UUIDNameRequest", &blocks, false).await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_parcel(state: State<'_, Arc<AppState>>, x: f64, y: f64) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let west = 4.0 * (x / 4.0).floor();
    let south = 4.0 * (y / 4.0).floor();
    s.send_encoded(
        "ParcelPropertiesRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ParcelData": [{ "SequenceID": -50000, "West": west, "South": south, "East": west + 4.0, "North": south + 4.0, "SnapSelection": false }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_reply_script_dialog(
    state: State<'_, Arc<AppState>>,
    object_id: String,
    chat_channel: i64,
    button_index: i64,
    button_label: String,
) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "ScriptDialogReply",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "Data": [{ "ObjectID": object_id, "ChatChannel": chat_channel, "ButtonIndex": button_index, "ButtonLabel": vstr(&button_label) }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_logout(state: State<'_, Arc<AppState>>) -> Cmd {
    // On an explicit logout, drop the cached reconnect credentials.
    state.creds.clear();
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "LogoutRequest",
        &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

// Teleport flags used when accepting a lure.
const TP_VIA_LURE: u32 = 1 << 2;
const TP_VIA_GODLIKE_LURE: u32 = 1 << 8;
const TP_DISABLE_CANCEL: u32 = 1 << 11;

#[tauri::command]
pub async fn sl_accept_teleport_offer(state: State<'_, Arc<AppState>>, lure_id: String, godlike: Option<bool>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let flags = if godlike.unwrap_or(false) {
        TP_VIA_LURE | TP_VIA_GODLIKE_LURE | TP_DISABLE_CANCEL
    } else {
        TP_VIA_LURE
    };
    s.send_encoded(
        "TeleportLureRequest",
        &json!({ "Info": [{ "AgentID": agent, "SessionID": sess, "LureID": lure_id, "TeleportFlags": flags }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_decline_teleport_offer(state: State<'_, Arc<AppState>>, to_id: String, lure_id: String) -> Cmd {
    // Goes out as IM dialog 24 (IM_LURE_DECLINED).
    sl_im_send(state, to_id, Some(lure_id), Some(24), String::new(), Some(false)).await
}

#[tauri::command]
pub async fn sl_send_teleport_offer(state: State<'_, Arc<AppState>>, to_id: String, message: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "StartLure",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "Info": [{ "LureType": 0, "Message": vstr(&message) }],
            "TargetData": [{ "TargetID": to_id }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_send_teleport_request(state: State<'_, Arc<AppState>>, to_id: String, message: String) -> Cmd {
    // Goes out as IM dialog 26 (IM_TELEPORT_REQUEST).
    sl_im_send(state, to_id, Some(ZERO_UUID.to_string()), Some(26), message, Some(false)).await
}

#[tauri::command]
pub async fn sl_offer_friendship(state: State<'_, Arc<AppState>>, to_id: String, message: String) -> Cmd {
    // A friendship offer goes out as IM dialog 38 (IM_FRIENDSHIP_OFFERED). The recipient
    // accepts or declines via AcceptFriendship/DeclineFriendship, keyed on the IM's ID.
    let msg = if message.is_empty() { "Will you be my friend?".to_string() } else { message };
    sl_im_send(state, to_id, Some(ZERO_UUID.to_string()), Some(38), msg, Some(false)).await
}

#[tauri::command]
pub async fn sl_accept_friendship(state: State<'_, Arc<AppState>>, transaction_id: String) -> Cmd {
    // Answer an inbound friendship offer (IM dialog 38); transaction_id is the
    // offer IM's ID. Leaving FolderData empty lets the sim file the calling card itself.
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "AcceptFriendship",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "TransactionBlock": [{ "TransactionID": transaction_id }],
            "FolderData": [],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_decline_friendship(state: State<'_, Arc<AppState>>, transaction_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "DeclineFriendship",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "TransactionBlock": [{ "TransactionID": transaction_id }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_remove_friendship(state: State<'_, Arc<AppState>>, other_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "TerminateFriendship",
        &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess }], "ExBlock": [{ "OtherID": other_id }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_accept_calling_card(state: State<'_, Arc<AppState>>, transaction_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "AcceptCallingCard",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "TransactionBlock": [{ "TransactionID": transaction_id }],
            "FolderData": [],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_decline_calling_card(state: State<'_, Arc<AppState>>, transaction_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "DeclineCallingCard",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "TransactionBlock": [{ "TransactionID": transaction_id }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_map_area(state: State<'_, Arc<AppState>>, min_x: i64, min_y: i64, max_x: i64, max_y: i64) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "MapBlockRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess, "Flags": 2, "EstateID": 0, "Godlike": false }],
            "PositionData": [{ "MinX": min_x, "MaxX": max_x, "MinY": min_y, "MaxY": max_y }],
        }),
        false,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_map_name(state: State<'_, Arc<AppState>>, name: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "MapNameRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess, "Flags": 2, "EstateID": 0, "Godlike": false }],
            "NameData": [{ "Name": vstr(&name) }],
        }),
        false,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_map_agents(state: State<'_, Arc<AppState>>, grid_x: i64, grid_y: i64) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "MapItemRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess, "Flags": 2, "EstateID": 0, "Godlike": false }],
            "RequestData": [{ "ItemType": 6, "RegionHandle": region_handle(grid_x, grid_y).to_string() }],
        }),
        false,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_reply_script_permission(state: State<'_, Arc<AppState>>, task_id: String, item_id: String, questions: i64) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "ScriptAnswerYes",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "Data": [{ "TaskID": task_id, "ItemID": item_id, "Questions": questions }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_save_notes(state: State<'_, Arc<AppState>>, target_id: String, notes: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if target_id.is_empty() || target_id == ZERO_UUID {
        return Err("No target for notes".into());
    }
    s.send_encoded(
        "AvatarNotesUpdate",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "Data": [{ "TargetID": target_id, "Notes": vstr(&notes) }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_search_people(state: State<'_, Arc<AppState>>, query: String, flags: Option<i64>, start: Option<i64>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    // People are typed in as usernames ("first.last"), but the directory matches on
    // the display "First Last", so we turn the dots into spaces before querying.
    let query = people_query(&query);
    let query_id = crate::bridge::circuit::gen_id();
    s.send_encoded(
        "DirFindQuery",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "QueryData": [{ "QueryID": query_id, "QueryText": vstr(&query), "QueryFlags": flags.unwrap_or(1), "QueryStart": start.unwrap_or(0) }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true, "queryId": query_id }))
}

/// Normalize a people-search query: dots (the username form) become spaces and
/// runs of whitespace collapse down to one, so "john.doe" searches as "john doe".
fn people_query(raw: &str) -> String {
    raw.replace('.', " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::people_query;

    #[test]
    fn people_query_dots_to_spaces() {
        assert_eq!(people_query("john.doe"), "john doe");
        assert_eq!(people_query("  Alice   Liddell "), "Alice Liddell");
        assert_eq!(people_query("first.last.resident"), "first last resident");
    }
}

#[tauri::command]
pub async fn sl_update_parcel(state: State<'_, Arc<AppState>>, parcel: Value) -> Cmd {
    // The UI passes the fully-merged parcel fields (it's the side holding current
    // parcel state); Rust just encodes the ParcelPropertiesUpdate.
    let (s, agent, sess) = active_ids(&state)?;
    let g = |k: &str| gs(&parcel, k);
    let gi = |k: &str| parcel.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    let uuid_or_zero = |k: &str| {
        let v = g(k);
        if v.is_empty() { ZERO_UUID.to_string() } else { v }
    };
    // Never send an update for a parcel we don't actually have (LocalID 0) - that
    // would be a bogus ParcelPropertiesUpdate against whatever parcel 0 happens to be.
    if gi("localId") <= 0 {
        return Err("No parcel selected".into());
    }
    // Fold the edited checkbox booleans back onto the parcel's CURRENT flags. The UI
    // sends `parcelFlags` (the loaded baseline) plus the booleans; recomputing here
    // preserves the bits the form doesn't expose. Without this, a save would send 0
    // and clear every flag (build/scripts/fly/search/... ) - genuine data loss.
    let baseline = parcel.get("parcelFlags").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let folded_flags = crate::bridge::session::fold_parcel_flags(baseline, &parcel);
    // Landing point: the UI holds landingPoint {x,y,z} + landingHeading (deg). We
    // rebuild the sim's UserLocation + a unit UserLookAt from the heading so a save
    // preserves the landing point instead of resetting it to (0,0,0).
    let landing_vec = match parcel.get("landingPoint") {
        Some(o) => json!([
            o.get("x").and_then(|x| x.as_f64()).unwrap_or(0.0),
            o.get("y").and_then(|x| x.as_f64()).unwrap_or(0.0),
            o.get("z").and_then(|x| x.as_f64()).unwrap_or(0.0)
        ]),
        None => json!([0.0, 0.0, 0.0]),
    };
    let heading = parcel.get("landingHeading").and_then(|v| v.as_f64()).unwrap_or(0.0).to_radians();
    let look_vec = json!([heading.cos(), heading.sin(), 0.0]);
    s.send_encoded(
        "ParcelPropertiesUpdate",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ParcelData": [{
                "LocalID": gi("localId"), "Flags": 0x01,
                "ParcelFlags": folded_flags,
                "SalePrice": gi("salePrice"),
                "Name": vstr(&g("name")), "Desc": vstr(&g("desc")),
                "MusicURL": vstr(&g("musicUrl")), "MediaURL": vstr(&g("mediaUrl")),
                "MediaID": uuid_or_zero("mediaId"), "MediaAutoScale": gi("mediaAutoScale"),
                "GroupID": uuid_or_zero("groupId"), "PassPrice": gi("passPrice"),
                "PassHours": parcel.get("passHours").and_then(|v| v.as_f64()).unwrap_or(0.0),
                "Category": gi("category"), "AuthBuyerID": uuid_or_zero("authBuyerId"),
                "SnapshotID": uuid_or_zero("snapshotId"),
                "UserLocation": landing_vec, "UserLookAt": look_vec, "LandingType": gi("landingType"),
            }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

// --- Circuit commands -------------------------------------------------------

#[tauri::command]
pub async fn sl_open_circuit(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    sim_ip: String,
    sim_port: u16,
) -> Cmd {
    let ip = normalize_sim_ip(&json!(sim_ip));
    let (id, session, local_port) = circuit::open(app, state.registry.clone(), &ip, sim_port, None).await?;
    state.sessions.lock().unwrap().insert(id.clone(), session);
    Ok(json!({
        "sessionId": id,
        "localPort": local_port,
        "sim": format!("{}:{}", ip, sim_port),
    }))
}

/// Open a circuit running the native session engine and bring it up
/// (UseCircuitCode + CompleteAgentMovement). Inbound packets are decoded and
/// routed to UI events entirely in Rust. `connected` (optional) is echoed to the
/// UI once the circuit is open.
#[tauri::command]
pub async fn sl_start_session(app: AppHandle, state: State<'_, Arc<AppState>>, params: Value) -> Cmd {
    let sim_ip = normalize_sim_ip(&json!(gs(&params, "simIp")));
    let sim_port = params.get("simPort").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
    let agent_id = gs(&params, "agentId");
    let session_uuid = gs(&params, "sessionId");
    let circuit_code = params.get("circuitCode").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if agent_id.is_empty() || session_uuid.is_empty() || circuit_code == 0 {
        return Err("agentId, sessionId and circuitCode are required".into());
    }

    let caps_map: std::collections::HashMap<String, String> = params
        .get("caps")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let (id, session, local_port) = circuit::open(
        app.clone(),
        state.registry.clone(),
        &sim_ip,
        sim_port,
        Some(circuit::EngineInit {
            agent_id: agent_id.clone(),
            session_uuid: session_uuid.clone(),
            sim_ip: sim_ip.clone(),
            sim_port,
            circuit_code,
            caps: caps_map.clone(),
        }),
    )
    .await?;
    state.sessions.lock().unwrap().insert(id.clone(), session.clone());
    *state.active_session.lock().unwrap() = Some(id.clone());

    session.start_handshake(&agent_id, &session_uuid, circuit_code).await;

    // Start the EventQueue long-poll if we know the region's cap. It's stored as the
    // replaceable EQ task so a later region cross can swap it out.
    let eq_url = gs(&params, "eventQueueCapUrl");
    let cap_count = params.get("caps").and_then(|v| v.as_object()).map(|m| m.len()).unwrap_or(0);
    crate::dlog!(
        "session start: sim={}:{} caps={} eventQueue={}",
        sim_ip,
        sim_port,
        cap_count,
        if eq_url.is_empty() { "MISSING" } else { "starting" }
    );
    if !eq_url.is_empty() {
        let handle = crate::bridge::eventqueue::spawn(
            app.clone(),
            session.clone(),
            state.ua.clone(),
            eq_url,
            session_uuid.clone(),
        );
        session.set_eq_task(handle);
    }

    if let Some(connected) = params.get("connected") {
        let _ = app.emit("minibee-viewer://connected", connected.clone());
    }

    // Raise (or clear) the degraded-features banner based on the caps the
    // session is actually running with. An empty set means the seed-cap fetch
    // failed and the login only *looks* clean - exactly the silent cascade this
    // banner exists to surface.
    crate::bridge::caps::emit_caps_status(&app, Some(&caps_map), "connect");

    Ok(json!({ "sessionId": id, "localPort": local_port, "sim": format!("{}:{}", sim_ip, sim_port) }))
}

#[tauri::command]
pub async fn sl_close_circuit(state: State<'_, Arc<AppState>>, session_id: String) -> Cmd {
    if let Some(s) = state.sessions.lock().unwrap().remove(&session_id) {
        s.close();
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_retarget(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    sim_ip: String,
    sim_port: u16,
) -> Cmd {
    let ip = normalize_sim_ip(&json!(sim_ip));
    let session = state.session(&session_id).ok_or("Unknown circuit session")?;
    let addr = format!("{}:{}", ip, sim_port)
        .parse()
        .map_err(|_| "Invalid sim_ip or sim_port".to_string())?;
    session.retarget(addr);
    Ok(json!({
        "ok": true,
        "target": format!("{}:{}", ip, sim_port),
        "localPort": session.local_port,
    }))
}

#[tauri::command]
pub async fn sl_send(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    name: String,
    blocks: Value,
    reliable: Option<bool>,
) -> Cmd {
    let session = state.session(&session_id).ok_or("Unknown circuit session")?;
    let (seq, sent) = session
        .send_message(&state.registry, &name, &blocks, reliable.unwrap_or(false))
        .await
        .ok_or_else(|| format!("Unknown or unencodable message: {name}"))?;
    Ok(json!({ "seq": seq, "bytesSent": sent }))
}

/// Send an already-framed, base64-encoded packet (straight from the frontend codec).
#[tauri::command]
pub async fn sl_send_raw(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    packet: String,
    sim_ip: Option<String>,
    sim_port: Option<u16>,
) -> Cmd {
    let session = state.session(&session_id).ok_or("Unknown circuit session")?;
    let bytes = B64.decode(packet.as_bytes()).map_err(|_| "Invalid base64 packet".to_string())?;
    if bytes.is_empty() {
        return Err("Empty packet".into());
    }
    // Optional per-send target override, for a teleport handoff to another sim.
    let sent = if let (Some(ip), Some(port)) = (sim_ip, sim_port) {
        let ip = normalize_sim_ip(&json!(ip));
        match format!("{}:{}", ip, port).parse::<std::net::SocketAddr>() {
            Ok(addr) => session.udp.send_to(&bytes, addr).await.unwrap_or(0),
            Err(_) => session.send_bytes(&bytes).await,
        }
    } else {
        session.send_bytes(&bytes).await
    };
    Ok(json!({ "sent": sent > 0, "bytesSent": sent }))
}
