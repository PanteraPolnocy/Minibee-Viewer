//! Tauri IPC command handlers: bridge helpers plus UDP circuit control.

use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::bridge::state::{viewer_identity_for_product, AppState};
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

/// "About Minibee" metadata for the Bee -> About subtab. It comes from
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
    let channel_base = field(&conf, "productName");
    let homepage = field(&bundle, "homepage");
    let repo = if homepage.is_empty() {
        "https://github.com/PanteraPolnocy/Minibee-Viewer".to_string()
    } else {
        homepage.clone()
    };
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
    let mut about = viewer_identity_for_product(&channel_base);
    let about_obj = about
        .as_object_mut()
        .ok_or_else(|| "about payload".to_string())?;
    about_obj.insert("name".into(), json!(name));
    about_obj.insert(
        "disclaimer".into(),
        json!("This software is not provided or supported by Linden Lab, the makers of Second Life."),
    );
    about_obj.insert("dedication".into(), json!("Dedicated to Panther Maurer."));
    about_obj.insert(
        "catchphrase".into(),
        json!(or(field(&bundle, "longDescription"), "A lightweight buzz into the infinite grid.")),
    );
    about_obj.insert(
        "description".into(),
        json!(or(field(&bundle, "shortDescription"), "Minimalist client for Second Life")),
    );
    about_obj.insert("author".into(), json!(or(field(&bundle, "publisher"), env!("CARGO_PKG_AUTHORS"))));
    about_obj.insert("homepage".into(), json!(homepage));
    // Contact is the author's in-world profile, not the repo: the About subtab
    // renders this as a link that opens the avatar profile inside the viewer.
    about_obj.insert(
        "contact".into(),
        json!({
            "agentId": "5e9cbbb8-1aef-4692-bfc4-a53f8c8fcbc9",
            "label": "Pantera Północy",
        }),
    );
    about_obj.insert(
        "support".into(),
        json!({
            "issues": format!("{repo}/issues"),
            "discussions": format!("{repo}/discussions"),
        }),
    );
    about_obj.insert("sourceUrl".into(), json!(repo));
    about_obj.insert(
        "build".into(),
        json!({
            "profile": env!("MINIBEE_PROFILE"),
            "optLevel": env!("MINIBEE_OPT_LEVEL"),
            "lto": is_release,
            "rustc": env!("MINIBEE_RUSTC"),
            "target": env!("MINIBEE_TARGET"),
            "host": env!("MINIBEE_HOST"),
            "buildEpoch": env!("MINIBEE_BUILD_EPOCH"),
            "debugAssertions": cfg!(debug_assertions),
        }),
    );
    about_obj.insert(
        "system".into(),
        json!({
            "os": std::env::consts::OS,
            "osVersion": os_version,
            "arch": std::env::consts::ARCH,
            "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
            "memTotal": mem_total,
            "memUsed": mem_used,
            "memProcess": mem_proc,
        }),
    );
    Ok(about)
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
    let identity = viewer_identity_for_product("Minibee-Viewer");
    let display = identity
        .get("displayVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    crate::dlog!(
        "about: Minibee Viewer {} [{}] lto={} opt={}",
        display,
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

/// Privacy policy text; Bee -> Privacy reads it lazily.
/// Bundled PRIVACY.md; Bee -> Privacy (after License).
#[tauri::command]
pub fn app_privacy() -> Cmd {
    Ok(json!({ "text": include_str!("../../PRIVACY.md") }))
}

/// The complete LICENSE text, baked in at build time; Bee -> License reads it lazily.
#[tauri::command]
pub fn app_license() -> Cmd {
    Ok(json!({ "text": include_str!("../../LICENSE") }))
}

/// The complete README text, baked in at build time; Bee -> README reads it lazily.
#[tauri::command]
pub fn app_readme() -> Cmd {
    Ok(json!({ "text": include_str!("../../README.md") }))
}

/// The plain-language user guide, baked in at build time; Bee -> Help reads it lazily.
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
    if !guard {
        state
            .close_pending
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The user said no to the close confirmation.
#[tauri::command]
pub fn cancel_close(state: State<'_, Arc<AppState>>) {
    state
        .close_pending
        .store(false, std::sync::atomic::Ordering::SeqCst);
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
pub async fn bridge_feed(state: State<'_, Arc<AppState>>, feed: String) -> Cmd {
    let f = feed.trim().to_ascii_lowercase();
    Ok(crate::bridge::feeds::fetch(state.inner(), &f).await)
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

#[tauri::command]
pub fn bridge_classify_url(url: String) -> Cmd {
    Ok(serde_json::to_value(urlmatch::classify_external_url(&url)).unwrap_or(Value::Null))
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
pub(crate) fn active_ids(
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

/// A dashless-hex-tolerant UUID to raw 16 bytes; zeros on anything malformed.
fn uuid_bytes(s: &str) -> Vec<u8> {
    let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 32 {
        return vec![0u8; 16];
    }
    (0..16)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap_or(0))
        .collect()
}

/// The reply dialog for an inventory offer: the accept code is offer+1 and the
/// decline is offer+2 (4 -> 5/6 resident, 9 -> 10/11 object, 32 -> 33/34
/// group-notice attachment).
fn offer_response_dialog(group_notice: bool, task: bool, accept: bool) -> i64 {
    match (group_notice, task, accept) {
        (true, _, true) => 33,     // IM_GROUP_NOTICE_INVENTORY_ACCEPTED
        (true, _, false) => 34,    // IM_GROUP_NOTICE_INVENTORY_DECLINED
        (false, false, true) => 5, // IM_INVENTORY_ACCEPTED
        (false, false, false) => 6,
        (false, true, true) => 10, // IM_TASK_INVENTORY_ACCEPTED
        (false, true, false) => 11,
    }
}

/// Answer an inventory offer (from a resident, an object's script, or a group
/// notice's attachment). The reply is an ImprovedInstantMessage back to the
/// offerer - for group notices, to the group id. Accepting an object's or a
/// notice's item must name the folder to file it into (the binary bucket
/// carries its raw UUID); we use the inventory root from login.
#[tauri::command]
pub async fn sl_inventory_offer_respond(
    state: State<'_, Arc<AppState>>,
    from_id: String,
    transaction_id: String,
    accept: bool,
    from_task: Option<bool>,
    kind: Option<String>,
) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if from_id.is_empty() || from_id == ZERO_UUID {
        return Err("No offerer".into());
    }
    let group_notice = kind.as_deref() == Some("group-notice");
    let task = from_task.unwrap_or(false);
    let dialog = offer_response_dialog(group_notice, task, accept);
    let bucket = if (task || group_notice) && accept {
        let root = state.inv_root.lock().unwrap().clone();
        if root.is_empty() {
            return Err("No inventory root folder known".into());
        }
        json!(B64.encode(uuid_bytes(&root)))
    } else {
        vstr("")
    };
    s.send_encoded(
        "ImprovedInstantMessage",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "MessageBlock": [{
                "FromGroup": false, "ToAgentID": from_id, "ParentEstateID": 0, "RegionID": ZERO_UUID,
                "Position": [0.0, 0.0, 0.0], "Offline": 0, "Dialog": dialog,
                "ID": transaction_id, "Timestamp": 0, "FromAgentName": vstr(""),
                "Message": vstr(""), "BinaryBucket": bucket,
            }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true, "sent": true }))
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

/// One directory page as the server sends it: at most 100 rows, plus a 101st
/// sentinel row whose only meaning is "another page exists".
const DIR_PAGE: usize = 100;

/// DirFindQuery / DirPlacesQuery flag bits.
const DFQ_PEOPLE: i64 = 1 << 0;
const DFQ_GROUPS: i64 = 1 << 4;
const DFQ_DWELL_SORT: i64 = 1 << 10;
/// Ask for every maturity band; the dataserver intersects these with what the
/// account is actually allowed to see, so over-asking is safe.
const DFQ_INC_ALL: i64 = (1 << 24) | (1 << 25) | (1 << 26);

/// Wait for every reply packet of one directory query, then hand the batch back
/// as (rows, status). One query's answer arrives spread across several UDP
/// packets (~30 rows each) with no end marker, so "done" means: a full page
/// (overflow sentinel included), or no new packet for a while, or the deadline
/// for a sim that never answers at all.
async fn await_dir_results(s: &Arc<crate::bridge::circuit::Session>, query_id: &str) -> (Vec<Value>, u64) {
    const POLL_MS: u64 = 120;
    const IDLE_MS: u64 = 700;
    const DEADLINE_MS: u64 = 8_000;
    let wall = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    };
    let started = wall();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
        let now = wall();
        if let Some((rows, last_ms)) = s.dir_search_progress(query_id) {
            if rows > DIR_PAGE || now.saturating_sub(last_ms) >= IDLE_MS {
                break;
            }
        }
        if now.saturating_sub(started) >= DEADLINE_MS {
            break;
        }
    }
    match s.take_dir_search(query_id) {
        Some(d) => (d.rows, d.status),
        None => (Vec::new(), 0),
    }
}

/// Trim the overflow sentinel off and shape the reply the search UI renders.
fn dir_result_payload(query_id: &str, mut rows: Vec<Value>, status: u64, start: i64) -> Value {
    let has_more = rows.len() > DIR_PAGE;
    rows.truncate(DIR_PAGE);
    json!({
        "ok": true,
        "queryId": query_id,
        "results": rows,
        "hasMore": has_more,
        "nextStart": start + DIR_PAGE as i64,
        "status": status,
        "statusText": dir_status_text(status),
    })
}

/// Human-readable reason when the sim answers with a status instead of rows.
/// The bit layout is shared by the places/events/classifieds replies;
/// DirPeopleReply carries no StatusData, so 0 is the norm.
fn dir_status_text(status: u64) -> &'static str {
    if status & (1 << 0) != 0 {
        "The search query contained a banned word."
    } else if status & (1 << 1) != 0 {
        "The search text is too short."
    } else if status & (1 << 3) != 0 {
        "Search is disabled on this grid."
    } else {
        ""
    }
}

#[tauri::command]
pub async fn sl_search_groups(state: State<'_, Arc<AppState>>, query: String, start: Option<i64>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let query_id = crate::bridge::circuit::gen_id();
    let start = start.unwrap_or(0);
    // The reply arrives as DirGroupsReply packets, collected by await_dir_results.
    s.send_encoded(
        "DirFindQuery",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "QueryData": [{ "QueryID": query_id, "QueryText": vstr(&query), "QueryFlags": DFQ_GROUPS | DFQ_INC_ALL, "QueryStart": start }],
        }),
        true,
    )
    .await;
    let (rows, status) = await_dir_results(&s, &query_id).await;
    Ok(dir_result_payload(&query_id, rows, status, start))
}

#[tauri::command]
pub async fn sl_search_places(
    state: State<'_, Arc<AppState>>,
    query: String,
    category: Option<i64>,
    flags: Option<i64>,
    start: Option<i64>,
) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let query_id = crate::bridge::circuit::gen_id();
    let start = start.unwrap_or(0);
    s.send_encoded(
        "DirPlacesQuery",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "QueryData": [{
                "QueryID": query_id, "QueryText": vstr(&query),
                "QueryFlags": flags.unwrap_or(DFQ_INC_ALL | DFQ_DWELL_SORT),
                "Category": category.unwrap_or(-1), "SimName": vstr(""), "QueryStart": start
            }],
        }),
        true,
    )
    .await;
    let (rows, status) = await_dir_results(&s, &query_id).await;
    Ok(dir_result_payload(&query_id, rows, status, start))
}

/// Invite residents to a group. RoleID zero means the implicit Everyone role.
/// Fire-and-forget on the wire: the sim notifies the invitees and sends the
/// inviter nothing back, success or fail.
#[tauri::command]
pub async fn sl_group_invite(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    invitee_ids: Vec<String>,
    role_id: Option<String>,
) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if group_id.is_empty() || group_id == ZERO_UUID {
        return Err("No group".into());
    }
    let role = role_id
        .filter(|r| !r.trim().is_empty())
        .unwrap_or_else(|| ZERO_UUID.to_string());
    let invites: Vec<Value> = invitee_ids
        .iter()
        .filter(|id| !id.is_empty() && id.as_str() != ZERO_UUID)
        .map(|id| json!({ "InviteeID": id, "RoleID": role }))
        .collect();
    if invites.is_empty() {
        return Err("No invitees".into());
    }
    let count = invites.len();
    s.send_encoded(
        "InviteGroupRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "GroupData": [{ "GroupID": group_id }],
            "InviteData": invites,
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true, "invited": count }))
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

/// Ask the sim for the current L$ balance; the answer arrives as `money-balance`.
#[tauri::command]
pub async fn sl_request_balance(state: State<'_, Arc<AppState>>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "MoneyBalanceRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "MoneyData": [{ "TransactionID": ZERO_UUID }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

// Agent control flags. STAND_UP and SIT_ON_GROUND are one-shot; FLY is a state
// the viewer keeps re-sending, which is why we track it.
use crate::bridge::session::AGENT_CONTROL_FLY; // 0x1 << 13
const AGENT_CONTROL_STAND_UP: u64 = 0x1 << 16; // 0x00010000
const AGENT_CONTROL_SIT_ON_GROUND: u64 = 0x1 << 17; // 0x00020000

async fn send_agent_update(
    s: &Arc<crate::bridge::circuit::Session>,
    agent: &str,
    sess: &str,
    one_shot: u64,
) {
    let flags = one_shot | if s.is_flying() { AGENT_CONTROL_FLY } else { 0 };
    let repeats = if one_shot != 0 { 3 } else { 2 };
    for i in 0..repeats {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        send_one_agent_update(s, agent, sess, flags).await;
    }
}

async fn send_one_agent_update(
    s: &Arc<crate::bridge::circuit::Session>,
    agent: &str,
    sess: &str,
    flags: u64,
) {
    let pos = s.last_position().unwrap_or([128.0, 128.0, 25.0]);
    let body = crate::bridge::session::build_agent_update(agent, sess, pos, flags);
    s.send_encoded("AgentUpdate", &body, true).await;
}

/// Stand the avatar up. Harmless when we aren't sitting - the sim ignores it.
async fn send_stand_up(s: &Arc<crate::bridge::circuit::Session>, agent: &str, sess: &str) {
    send_agent_update(s, agent, sess, AGENT_CONTROL_STAND_UP).await;
    s.set_sitting(false);
    // The sim now plays the "standup" clip on us and waits for the viewer to
    // declare it finished; without this reply other viewers see the avatar
    // frozen mid-stand. The AvatarAnimation handler also triggers this, but
    // that packet is unreliable, so close the loop from here too.
    let me = s.clone();
    tokio::spawn(async move {
        me.finish_transient_anim(1200).await;
    });
}

/// A seated avatar can't be teleported, so stand up first and give the sim a
/// moment to actually do it before asking to move. Every teleport path calls
/// this, so it doesn't matter which button the user pressed.
pub(crate) async fn stand_before_teleport(s: &Arc<crate::bridge::circuit::Session>, agent: &str, sess: &str) {
    if !s.is_sitting() {
        return;
    }
    crate::dlog!("teleport: standing up first (we're seated)");
    send_stand_up(s, agent, sess).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
}

/// Stand the avatar up on request (Interactions -> avatar actions).
#[tauri::command]
pub async fn sl_stand_up(state: State<'_, Arc<AppState>>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    send_stand_up(&s, &agent, &sess).await;
    Ok(json!({ "ok": true, "sitting": false, "flying": s.is_flying() }))
}

/// Sit on the ground. Flying and sitting are mutually exclusive.
#[tauri::command]
pub async fn sl_sit_ground(state: State<'_, Arc<AppState>>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    // Coming out of flight first: tell the sim to stop flying, let it land us, and
    // only then ask to sit. Bundling both into one message meant the sit was often
    // ignored because we were still airborne.
    if s.is_flying() {
        s.set_flying(false);
        send_agent_update(&s, &agent, &sess, 0).await;
        tokio::time::sleep(Duration::from_millis(800)).await;
    }
    s.set_flying(false);
    send_agent_update(&s, &agent, &sess, AGENT_CONTROL_SIT_ON_GROUND).await;
    // The sim only sends AvatarSitResponse for sitting on an object, so record the
    // ground sit ourselves - teleports need to know we have to stand up first.
    s.set_sitting(true);
    Ok(json!({ "ok": true, "sitting": true, "flying": false }))
}

/// Start or stop flying. Sitting first? Stand up in the same breath, since the sim
/// won't fly a seated avatar.
#[tauri::command]
pub async fn sl_set_flying(state: State<'_, Arc<AppState>>, flying: bool) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let one_shot = if flying && s.is_sitting() {
        s.set_sitting(false);
        AGENT_CONTROL_STAND_UP
    } else {
        0
    };
    s.set_flying(flying);
    send_agent_update(&s, &agent, &sess, one_shot).await;
    Ok(json!({ "ok": true, "sitting": s.is_sitting(), "flying": flying }))
}

/// Ask the sim for one object's properties (name, owner, permissions, sale price).
async fn request_object_props(
    s: &Arc<crate::bridge::circuit::Session>,
    agent: &str,
    sess: &str,
    object_id: &str,
) {
    s.send_encoded(
        "RequestObjectPropertiesFamily",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ObjectData": [{ "RequestFlags": 0, "ObjectID": object_id }],
        }),
        true,
    )
    .await;
}

/// Ask the sim to describe objects we already know the ids of. Same call the
/// cached-update path uses, and the same 200-per-message ceiling.
async fn request_objects_again(
    s: &Arc<crate::bridge::circuit::Session>,
    agent: &str,
    sess: &str,
    ids: &[u32],
) {
    for chunk in ids.chunks(200) {
        let data: Vec<Value> =
            chunk.iter().map(|id| json!({ "CacheMissType": 0, "ID": id })).collect();
        s.send_encoded(
            "RequestMultipleObjects",
            &json!({
                "AgentData": [{ "AgentID": agent, "SessionID": sess }],
                "ObjectData": data,
            }),
            true,
        )
        .await;
    }
}

/// After switching to 360 interest, ask the sim again for anything we know about but
/// do not have rows for yet.
async fn refresh_object_requests(
    state: &Arc<AppState>,
    s: &Arc<crate::bridge::circuit::Session>,
    agent: &str,
    sess: &str,
) -> bool {
    let interest360 = crate::bridge::caps::interest_list_360(state, s).await;
    send_agent_update(s, agent, sess, 0).await;
    for round in 0..3 {
        let recover = if round == 0 { s.objects_to_recover(400) } else { Vec::new() };
        let mut refetch = s.objects_missing_from_cache_all();
        refetch.extend(s.missing_parent_object_ids());
        refetch.extend(recover);
        refetch.sort_unstable();
        refetch.dedup();
        if refetch.is_empty() {
            break;
        }
        crate::dlog!(
            "re-requesting {} object(s) from region cache (Load retry round {})",
            refetch.len(),
            round + 1
        );
        request_objects_again(s, agent, sess, &refetch).await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
    interest360
}

/// Ask the sim to describe a batch of objects by selecting them briefly.
///
/// ObjectSelect makes the sim send full ObjectProperties (with creator); we chunk
/// at 64 ids per message.
async fn request_object_batch(
    s: &Arc<crate::bridge::circuit::Session>,
    agent: &str,
    sess: &str,
    local_ids: &[u32],
) {
    for chunk in local_ids.chunks(64) {
        let data: Vec<Value> = chunk.iter().map(|id| json!({ "ObjectLocalID": id })).collect();
        let body = json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ObjectData": data,
        });
        s.send_encoded("ObjectSelect", &body, true).await;
        s.send_encoded("ObjectDeselect", &body, true).await;
    }
}

/// Let the list know we want the objects. Tracking itself runs from login onward,
/// because the sim only describes a region when you arrive - this just says the tab
/// is open and the nearby list is worth answering.
#[tauri::command]
pub async fn sl_object_scan(state: State<'_, Arc<AppState>>, enable: bool) -> Cmd {
    let s = state.active().ok_or("No active session")?;
    s.set_object_scan(enable);
    if enable {
        let caps_state = state.inner().clone();
        let session = s.clone();
        let (_, agent, sess) = active_ids(&state)?;
        refresh_object_requests(&caps_state, &session, &agent, &sess).await;
    }
    crate::dlog!("object scan {}", if enable { "on" } else { "off" });
    Ok(json!({ "ok": true, "scanning": enable }))
}

/// Work through every in-range object that still has no properties, a batch at a time.
///
/// Phase 1: ObjectSelect/Deselect batches. Phase 2: RequestObjectPropertiesFamily
/// for anything still unnamed.
///
/// Each press of Load bumps `drain_gen`, so a new drain always replaces any stale one.
fn spawn_props_drain(
    s: Arc<crate::bridge::circuit::Session>,
    agent: String,
    sess: String,
    range: f32,
    drain_gen: u64,
) {
    /// Up to 200 ids per ObjectSelect message.
    const PROPS_PER_MESSAGE: usize = 200;
    /// Breathing room between select batches.
    const PROPS_GAP_MS: u64 = 250;
    /// Retry unanswered rows after this long.
    const PROPS_TIMEOUT_MS: u64 = 30_000;
    /// One family request per object; keep a short gap.
    const FAMILY_GAP_MS: u64 = 60;

    tokio::spawn(async move {
        let mut asked = 0usize;
        loop {
            if s.props_drain_stale(drain_gen) {
                return;
            }
            let ids = s.next_props_batch(range, PROPS_PER_MESSAGE, PROPS_TIMEOUT_MS);
            if ids.is_empty() {
                break;
            }
            asked += ids.len();
            request_object_batch(&s, &agent, &sess, &ids).await;
            tokio::time::sleep(Duration::from_millis(PROPS_GAP_MS)).await;
        }
        loop {
            if s.props_drain_stale(drain_gen) {
                return;
            }
            let uuids = s.next_props_family_batch(range, 8, PROPS_TIMEOUT_MS);
            if uuids.is_empty() {
                break;
            }
            for uuid in uuids {
                if s.props_drain_stale(drain_gen) {
                    return;
                }
                request_object_props(&s, &agent, &sess, &uuid).await;
                tokio::time::sleep(Duration::from_millis(FAMILY_GAP_MS)).await;
            }
        }
        if asked > 0 {
            crate::dlog!("object properties: asked about {asked} object(s) within {range}m");
        }
    });
}

/// The nearby list: linkset roots within the chosen radius, with type filters applied
/// in the core. Pressing Load also kicks off the properties drain for anything still unnamed.
#[tauri::command]
pub async fn sl_nearby_objects(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    range: Option<f64>,
    include_attachments: Option<bool>,
    include_physical: Option<bool>,
) -> Cmd {
    // No gate on the scan flag. Reading a table we maintain anyway costs nothing, and a
    // flag that hadn't been set yet used to mean Load answered with an empty list and no
    // explanation.
    let (s, agent, sess) = active_ids(&state)?;
    // 128m is as far as the interest list reaches (session::INTEREST_FAR), so asking for
    // more than that would promise objects the sim never sends.
    let range = range.unwrap_or(32.0).clamp(8.0, 384.0) as f32;
    let filters = crate::bridge::objects::ListFilters {
        include_attachments: include_attachments.unwrap_or(false),
        include_physical: include_physical.unwrap_or(true),
    };
    let interest360 =
        refresh_object_requests(state.inner(), &s, &agent, &sess).await;
    // Pressing Load is also the retry: anything the sim never answered about becomes
    // askable again.
    s.allow_props_retry();
    let drain_gen = s.bump_props_drain();
    let (
        entries,
        resolve_ids,
        pending,
        tracked,
        cached,
        nearest,
        roots,
        unresolved,
        attachments_tracked,
        attachments_in_range,
    ) = s.nearby_objects(range, filters);
    let names_needed = s.filter_names_needed(resolve_ids);
    if !names_needed.is_empty() {
        let app = app.clone();
        let core = state.inner().clone();
        let session = s.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::bridge::caps::resolve_display_names(&app, &core, &session, &names_needed).await {
                crate::dlog!("nearby objects: owner name resolve failed: {}", e);
            }
        });
    }
    crate::dlog!(
        "nearby objects: {} list root(s) within {}m, {} awaiting properties, {} tracked, {} cached ids, {} roots, {} unresolved parents, {} attachment(s) in range ({} tracked), nearest={:.1}m, interest360={}",
        entries.len(),
        range,
        pending,
        tracked,
        cached,
        roots,
        unresolved,
        attachments_in_range,
        attachments_tracked,
        nearest,
        interest360
    );
    if pending > 0 {
        spawn_props_drain(s.clone(), agent, sess, range, drain_gen);
    }
    Ok(json!({
        "ok": true,
        "scanning": true,
        "entries": entries,
        "pending": pending,
        "tracked": tracked,
        "cached": cached,
        "nearest": nearest,
        "roots": roots,
        "unresolvedParents": unresolved,
        "attachmentsTracked": attachments_tracked,
        "attachmentsInRange": attachments_in_range,
        "interest360": interest360,
    }))
}

/// Full details for one object, fetched on demand when the user opens the detail
/// view. Never polled - the reply arrives as an `object-properties` event.
#[tauri::command]
pub async fn sl_object_details(state: State<'_, Arc<AppState>>, object_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if object_id.is_empty() || object_id == ZERO_UUID {
        return Err("No object".into());
    }
    request_object_props(&s, &agent, &sess, &object_id).await;
    Ok(json!({ "ok": true }))
}

/// Pay an object (not a resident). TRANS_PAY_OBJECT with the object name in the
/// description field.
#[tauri::command]
pub async fn sl_object_pay(
    state: State<'_, Arc<AppState>>,
    object_id: String,
    amount: i64,
    object_name: Option<String>,
) -> Cmd {
    const TRANS_PAY_OBJECT: i64 = 5008;
    let (s, agent, sess) = active_ids(&state)?;
    if object_id.is_empty() || object_id == ZERO_UUID {
        return Err("No object".into());
    }
    // Zero amount is rejected; pay the absolute value.
    let amount = amount.abs();
    if amount < 1 {
        return Err("amount must be >= 1".into());
    }
    crate::dlog!("paying object {} L${}", object_id, amount);
    s.send_encoded(
        "MoneyTransferRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "MoneyData": [{
                "SourceID": agent, "DestID": object_id, "Flags": 0, "Amount": amount,
                "AggregatePermNextOwner": 0, "AggregatePermInventory": 0,
                "TransactionType": TRANS_PAY_OBJECT,
                "Description": vstr(&object_name.unwrap_or_default()),
            }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true, "amount": amount }))
}

/// Ask an object what it would like to be paid. The sim answers with PayPriceReply,
/// which carries a default price and up to four suggested amounts.
#[tauri::command]
pub async fn sl_request_pay_price(state: State<'_, Arc<AppState>>, object_id: String) -> Cmd {
    let (s, _agent, _sess) = active_ids(&state)?;
    if object_id.is_empty() || object_id == ZERO_UUID {
        return Err("No object".into());
    }
    s.send_encoded(
        "RequestPayPrice",
        &json!({ "ObjectData": [{ "ObjectID": object_id }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

/// Briefly select an object so the sim sends the full `ObjectProperties` reply, which
/// is the only place creator and creation date appear, then deselect immediately.
/// Detail view only - selecting every row of a list would be rude to the simhost.
#[tauri::command]
pub async fn sl_object_select(state: State<'_, Arc<AppState>>, local_id: u32) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if local_id == 0 {
        return Err("No object".into());
    }
    s.send_encoded(
        "ObjectSelect",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ObjectData": [{ "ObjectLocalID": local_id }],
        }),
        true,
    )
    .await;
    s.send_encoded(
        "ObjectDeselect",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ObjectData": [{ "ObjectLocalID": local_id }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

/// Touch an object, as clicking it in-world would (grab then immediately let go).
#[tauri::command]
pub async fn sl_object_touch(state: State<'_, Arc<AppState>>, local_id: u32) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    // Send one SurfaceInfo block with default "no pick point" values (-1 UV/ST, face -1).
    let surface = json!([{
        "UVCoord": [-1.0, -1.0, 0.0],
        "STCoord": [-1.0, -1.0, 0.0],
        "FaceIndex": -1,
        "Position": [0.0, 0.0, 0.0],
        "Normal": [0.0, 0.0, 0.0],
        "Binormal": [0.0, 0.0, 0.0],
    }]);
    s.send_encoded(
        "ObjectGrab",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ObjectData": [{ "LocalID": local_id, "GrabOffset": [0.0, 0.0, 0.0] }],
            "SurfaceInfo": surface,
        }),
        true,
    )
    .await;
    s.send_encoded(
        "ObjectDeGrab",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ObjectData": [{ "LocalID": local_id }],
            "SurfaceInfo": surface,
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

/// Sit on an object. This only *requests* the sit: the sim approves it with
/// AvatarSitResponse (whose handler then sends the completing AgentSit and
/// emits `sit-state {sitting:true}`) or refuses it with a named alert. A
/// refusal can also be silent, so a watchdog here reports the timeout - the UI
/// must not assume success from this command returning.
#[tauri::command]
pub async fn sl_object_sit(app: AppHandle, state: State<'_, Arc<AppState>>, object_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if object_id.is_empty() || object_id == ZERO_UUID {
        return Err("No object".into());
    }
    s.set_sit_pending(true);
    s.send_encoded(
        "AgentRequestSit",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "TargetObject": [{ "TargetID": object_id, "Offset": [0.0, 0.0, 0.0] }],
        }),
        true,
    )
    .await;
    // The silent-failure watchdog: if neither an approval nor a named refusal
    // arrives, stop the UI from claiming we're seated forever.
    let me = s.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        if me.is_sit_pending() && !me.is_sitting() {
            me.set_sit_pending(false);
            let _ = app.emit(
                "minibee-viewer://sit-state",
                crate::bridge::events::payload(crate::bridge::events::SitState {
                    sitting: false,
                    object_id: String::new(),
                    error: Some("Could not sit there - the object did not respond.".into()),
                }),
            );
        }
    });
    Ok(json!({ "ok": true, "pending": true }))
}

/// Current sit/fly state, so the UI can show the right buttons after a tab switch.
#[tauri::command]
pub fn sl_avatar_state(state: State<'_, Arc<AppState>>) -> Cmd {
    let s = match state.active() {
        Some(s) => s,
        None => return Ok(json!({ "ok": false, "sitting": false, "flying": false })),
    };
    Ok(json!({ "ok": true, "sitting": s.is_sitting(), "flying": s.is_flying() }))
}

#[tauri::command]
pub async fn sl_teleport_to(
    state: State<'_, Arc<AppState>>,
    grid_x: i64,
    grid_y: i64,
    x: f64,
    y: f64,
    z: f64,
    region_name: Option<String>,
) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    stand_before_teleport(&s, &agent, &sess).await;
    // Free the tracked objects before we go, if this is a different region - they
    // belong to where we're standing now and would be dead weight in transit.
    s.clear_objects_for_teleport(grid_x, grid_y);
    // Remember the destination so the TeleportStart/TeleportFinish events can
    // carry it; the sim's own messages have no coordinates, and the session's
    // region_name still holds the ORIGIN region until the new handshake lands.
    let mut target = json!({ "gridX": grid_x, "gridY": grid_y, "x": x, "y": y, "z": z });
    if let Some(name) = region_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        target["regionName"] = json!(name);
    }
    s.set_tp_target(Some(target));
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
pub async fn sl_teleport_to_agent(state: State<'_, Arc<AppState>>, agent_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let (grid_x, grid_y, region_name, pos) = s
        .resident_teleport_target(&agent_id)
        .ok_or("No known position for that resident yet.")?;
    if grid_x == 0 && grid_y == 0 {
        return Err("The region location isn't known yet.".into());
    }
    stand_before_teleport(&s, &agent, &sess).await;
    s.clear_objects_for_teleport(grid_x, grid_y);
    let mut target = json!({ "gridX": grid_x, "gridY": grid_y, "x": pos[0], "y": pos[1], "z": pos[2] });
    if !region_name.is_empty() {
        target["regionName"] = json!(region_name);
    }
    s.set_tp_target(Some(target));
    let handle = region_handle(grid_x, grid_y);
    s.send_encoded(
        "TeleportLocationRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "Info": [{ "RegionHandle": handle.to_string(), "Position": [pos[0], pos[1], pos[2]], "LookAt": [pos[0] + 1.0, pos[1], pos[2]] }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true, "x": pos[0], "y": pos[1], "z": pos[2], "regionName": region_name }))
}

#[tauri::command]
pub fn sl_current_slurl(state: State<'_, Arc<AppState>>) -> Cmd {
    let s = state.active().ok_or("No active session")?;
    let region = s.region_name();
    if region.is_empty() {
        return Err("The region name isn't known yet.".into());
    }
    let pos = s.last_position().unwrap_or([128.0, 128.0, 25.0]);
    let slurl = format!(
        "https://maps.secondlife.com/secondlife/{}/{}/{}/{}",
        urlencoding::encode(&region),
        pos[0].round() as i64,
        pos[1].round() as i64,
        pos[2].round() as i64
    );
    Ok(json!({ "ok": true, "slurl": slurl, "regionName": region }))
}

#[tauri::command]
pub async fn sl_teleport_home(state: State<'_, Arc<AppState>>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    stand_before_teleport(&s, &agent, &sess).await;
    // A landmark teleport's destination isn't known here; make sure no
    // earlier trip's recorded target can label this arrival.
    s.set_tp_target(None);
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
    // A cancelled trip never reaches the arrival that would consume its
    // recorded destination, so drop it here.
    s.set_tp_target(None);
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

/// Ask the sim for the block list.
///
/// The reply doesn't come back inline: the sim writes a file, tells us its name in
/// `MuteListUpdate`, and we fetch it over Xfer - so the list arrives later, as a
/// `mute-list` event. A zero CRC is what says "send it, I have nothing cached".
#[tauri::command]
pub async fn sl_request_mute_list(state: State<'_, Arc<AppState>>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    // An explicit refresh gets a fresh chance at the "cached copy" retry.
    s.arm_mute_retry();
    s.send_encoded(
        "MuteListRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "MuteData": [{ "MuteCRC": 0 }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

/// Block a resident, grid-wide. The sim owns the list, so this is a write to it rather
/// than something we keep to ourselves.
///
/// MuteType 1 is agent; flags 0 blocks everything.
#[tauri::command]
pub async fn sl_block_agent(
    state: State<'_, Arc<AppState>>,
    agent_id: String,
    name: Option<String>,
) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if agent_id.is_empty() || agent_id == ZERO_UUID {
        return Err("No resident".into());
    }
    if agent_id.eq_ignore_ascii_case(&agent) {
        return Err("You cannot block yourself".into());
    }
    let label = name.unwrap_or_default();
    // Lindens can't be blocked - but only where Lindens exist, and judged by the
    // resolved account name when we have it, not whatever label the UI passed
    // (which can be a display name that merely ends in "Linden").
    let linden_grid = state.currency.lock().unwrap().as_ref().map_or(false, |c| c.linden_grid);
    let check = s.cached_name_of(&agent_id).unwrap_or_else(|| label.clone());
    if linden_grid && is_linden_name(&check) {
        return Err("Linden Lab employees cannot be blocked".into());
    }
    s.send_encoded(
        "UpdateMuteListEntry",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "MuteData": [{
                "MuteID": agent_id,
                "MuteName": vstr(&label),
                "MuteType": 1,
                "MuteFlags": 0,
            }],
        }),
        true,
    )
    .await;
    s.set_block_state(&agent_id, true);
    crate::dlog!("blocked {}", agent_id);
    Ok(json!({ "ok": true }))
}

/// Whether a login name belongs to Linden Lab staff (last name "Linden"),
/// spelled "First Linden" or "first.linden".
fn is_linden_name(name: &str) -> bool {
    name.trim()
        .rsplit_once([' ', '.'])
        .is_some_and(|(_, last)| last.eq_ignore_ascii_case("linden"))
}

#[tauri::command]
pub async fn sl_unblock_agent(
    state: State<'_, Arc<AppState>>,
    agent_id: String,
    name: Option<String>,
) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if agent_id.is_empty() || agent_id == ZERO_UUID {
        return Err("No resident".into());
    }
    s.send_encoded(
        "RemoveMuteListEntry",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "MuteData": [{ "MuteID": agent_id, "MuteName": vstr(&name.unwrap_or_default()) }],
        }),
        true,
    )
    .await;
    s.set_block_state(&agent_id, false);
    crate::dlog!("unblocked {}", agent_id);
    Ok(json!({ "ok": true }))
}

/// Ask the sim for group names by key.
///
/// Group membership only covers our own groups; other keys need a UUIDGroupNameRequest.
#[tauri::command]
pub async fn sl_resolve_group_names(state: State<'_, Arc<AppState>>, ids: Vec<String>) -> Cmd {
    let s = state.active().ok_or("No active session")?;
    if ids.is_empty() {
        return Ok(json!({ "ok": true }));
    }
    for chunk in ids.chunks(40) {
        let blocks = json!({
            "UUIDNameBlock": chunk.iter().map(|id| json!({ "ID": id })).collect::<Vec<_>>()
        });
        s.send_encoded("UUIDGroupNameRequest", &blocks, false).await;
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_parcel(state: State<'_, Arc<AppState>>, x: Option<f64>, y: Option<f64>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let _ = (x, y);
    let (x, y) = match s.last_position() {
        Some(p) => (p[0], p[1]),
        None => {
            crate::dlog!("ParcelPropertiesRequest deferred - no authoritative position yet");
            return Ok(json!({ "ok": false, "deferred": true }));
        }
    };
    let west = 4.0 * (x / 4.0).floor();
    let south = 4.0 * (y / 4.0).floor();
    crate::dlog!("ParcelPropertiesRequest at ({:.0},{:.0})", x, y);
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

// --- About Land -------------------------------------------------------------

pub const PARCEL_LIST_ACCESS: u32 = 0x1;
pub const PARCEL_LIST_BAN: u32 = 0x2;
pub const PARCEL_LIST_ALLOW_EXPERIENCE: u32 = 0x8;
pub const PARCEL_LIST_BLOCK_EXPERIENCE: u32 = 0x10;

#[tauri::command]
pub async fn sl_request_covenant(state: State<'_, Arc<AppState>>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    s.send_encoded(
        "EstateCovenantRequest",
        &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_fetch_covenant_text(state: State<'_, Arc<AppState>>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    const CHANNEL_ASSET: i64 = 2; // LLTCT_ASSET
    const SOURCE_SIM_ESTATE: i64 = 4; // LLTST_SIM_ESTATE
    const ET_COVENANT: i32 = 0;
    let transfer_id = crate::bridge::circuit::gen_id();
    // Params: raw agent id + session id + estate asset type (S32 LE).
    let mut params = Vec::with_capacity(36);
    params.extend_from_slice(&uuid_bytes(&agent));
    params.extend_from_slice(&uuid_bytes(&sess));
    params.extend_from_slice(&ET_COVENANT.to_le_bytes());
    s.begin_covenant_transfer(&transfer_id);
    s.send_encoded(
        "TransferRequest",
        &json!({
            "TransferInfo": [{
                "TransferID": transfer_id,
                "ChannelType": CHANNEL_ASSET,
                "SourceType": SOURCE_SIM_ESTATE,
                "Priority": 101.0,
                "Params": B64.encode(&params),
            }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_request_parcel_access(state: State<'_, Arc<AppState>>, local_id: i64, flags: u32) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if local_id <= 0 {
        return Err("No parcel selected".into());
    }
    let mut flags = flags;
    // Experience lists only exist where the region speaks experiences.
    if s.cap("RegionExperiences").is_none() {
        flags &= !(PARCEL_LIST_ALLOW_EXPERIENCE | PARCEL_LIST_BLOCK_EXPERIENCE);
    }
    if flags == 0 {
        return Ok(json!({ "ok": false, "unsupported": true }));
    }
    for bit in [
        PARCEL_LIST_ACCESS,
        PARCEL_LIST_BAN,
        PARCEL_LIST_ALLOW_EXPERIENCE,
        PARCEL_LIST_BLOCK_EXPERIENCE,
    ] {
        if flags & bit != 0 {
            s.clear_access_list(local_id, bit);
        }
    }
    s.send_encoded(
        "ParcelAccessListRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "Data": [{ "SequenceID": 0, "Flags": flags, "LocalID": local_id }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

fn access_entry_expiry(e: &Value, now: i64) -> i64 {
    match e.get("time").and_then(|v| v.as_i64()) {
        Some(t) if t > 0 => t,
        _ => {
            let hours = e.get("hours").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if hours > 0.0 && now > 0 {
                now + (hours * 3600.0) as i64
            } else {
                0
            }
        }
    }
}

#[tauri::command]
pub async fn sl_update_parcel_access(
    state: State<'_, Arc<AppState>>,
    local_id: i64,
    flags: u32,
    entries: Vec<Value>,
) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if local_id <= 0 {
        return Err("No parcel selected".into());
    }
    // Guard: only ever touch the parcel we're standing on (the UI can't ask
    // about anything else), so a stale LocalID can't rewrite a stranger's list.
    match s.parcel_snapshot() {
        Some(snap) if snap.local_id == local_id => {}
        _ => return Err("The land data on screen is stale - refresh the Land tab first.".into()),
    }
    // Exactly one list kind per update - the sim groups chunks by
    // TransactionID and applies the wholesale replacement per kind.
    if flags.count_ones() != 1 {
        return Err("One list at a time".into());
    }
    const CHUNK: usize = 48; // PARCEL_MAX_ENTRIES_PER_PACKET
    const MAX_ENTRIES: usize = 300; // PARCEL_MAX_ACCESS_LIST
    let rows: Vec<Value> = entries
        .iter()
        .filter_map(|e| {
            let id = gs(e, "id");
            if id.is_empty() || id == ZERO_UUID {
                return None;
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Some(json!({ "ID": id, "Time": access_entry_expiry(e, now), "Flags": 0 }))
        })
        .take(MAX_ENTRIES)
        .collect();
    let tx = crate::bridge::circuit::gen_id();
    if rows.is_empty() {
        // Clearing a list is one packet with Sections=0 and a single null
        // entry - an entirely empty List block is not what the sim expects.
        s.send_encoded(
            "ParcelAccessListUpdate",
            &json!({
                "AgentData": [{ "AgentID": agent, "SessionID": sess }],
                "Data": [{
                    "Flags": flags, "LocalID": local_id, "TransactionID": tx,
                    "SequenceID": 1, "Sections": 0,
                }],
                "List": [{ "ID": ZERO_UUID, "Time": 0, "Flags": 0 }],
            }),
            true,
        )
        .await;
        return Ok(json!({ "ok": true, "entries": 0 }));
    }
    let sections = rows.len().div_ceil(CHUNK) as i64;
    for (i, chunk) in rows.chunks(CHUNK).enumerate() {
        s.send_encoded(
            "ParcelAccessListUpdate",
            &json!({
                "AgentData": [{ "AgentID": agent, "SessionID": sess }],
                "Data": [{
                    "Flags": flags, "LocalID": local_id, "TransactionID": tx,
                    "SequenceID": (i + 1) as i64, "Sections": sections,
                }],
                "List": chunk,
            }),
            true,
        )
        .await;
    }
    Ok(json!({ "ok": true, "entries": rows.len() }))
}

#[tauri::command]
pub async fn sl_request_parcel_object_owners(state: State<'_, Arc<AppState>>, local_id: i64) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if local_id <= 0 {
        return Err("No parcel selected".into());
    }
    s.send_encoded(
        "ParcelObjectOwnersRequest",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ParcelData": [{ "LocalID": local_id }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

/// Return objects on the current parcel. `return_type` uses the protocol's
/// RT_* bits; `owner_ids` narrows an RT_LIST return to specific owners.
#[tauri::command]
pub async fn sl_parcel_return_objects(
    state: State<'_, Arc<AppState>>,
    local_id: i64,
    return_type: u32,
    owner_ids: Vec<String>,
) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if local_id <= 0 {
        return Err("No parcel selected".into());
    }
    match s.parcel_snapshot() {
        Some(snap) if snap.local_id == local_id => {}
        _ => return Err("The land data on screen is stale - refresh the Land tab first.".into()),
    }
    let mut owners: Vec<Value> = owner_ids
        .iter()
        .filter(|id| !id.is_empty() && id.as_str() != ZERO_UUID)
        .map(|id| json!({ "OwnerID": id }))
        .collect();
    // The message needs at least one block of each Variable kind to be
    // well-formed: a dummy null TaskID always, and a null OwnerID when the
    // return isn't narrowed to specific owners.
    if owners.is_empty() {
        owners.push(json!({ "OwnerID": ZERO_UUID }));
    }
    s.send_encoded(
        "ParcelReturnObjects",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ParcelData": [{ "LocalID": local_id, "ReturnType": return_type }],
            "TaskIDs": [{ "TaskID": ZERO_UUID }],
            "OwnerIDs": owners,
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

/// Set the parcel's autoreturn (minutes; 0 disables).
#[tauri::command]
pub async fn sl_parcel_set_autoreturn(state: State<'_, Arc<AppState>>, local_id: i64, minutes: i64) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if local_id <= 0 {
        return Err("No parcel selected".into());
    }
    s.send_encoded(
        "ParcelSetOtherCleanTime",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ParcelData": [{ "LocalID": local_id, "OtherCleanTime": minutes.max(0) }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_parcel_buy(state: State<'_, Arc<AppState>>, local_id: i64) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let snap = s
        .parcel_snapshot()
        .ok_or("No parcel data - refresh the Land tab first.")?;
    if snap.local_id != local_id || local_id <= 0 {
        return Err("The land data on screen is stale - refresh the Land tab first.".into());
    }
    let has_auth_buyer = !snap.auth_buyer_id.is_empty() && snap.auth_buyer_id != ZERO_UUID;
    // For-sale means the flag AND a real price (or a named buyer); the flag
    // alone is not enough to let a purchase through.
    if !snap.for_sale || (snap.sale_price <= 0 && !has_auth_buyer) {
        return Err("This parcel is not for sale.".into());
    }
    if snap.owner_id.eq_ignore_ascii_case(&agent) {
        return Err("You already own this parcel.".into());
    }
    if has_auth_buyer && !snap.auth_buyer_id.eq_ignore_ascii_case(&agent) {
        return Err("This parcel is reserved for a different buyer.".into());
    }
    s.send_encoded(
        "ParcelBuy",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "Data": [{
                "GroupID": ZERO_UUID, "IsGroupOwned": false,
                "RemoveContribution": false, "LocalID": snap.local_id, "Final": true,
            }],
            "ParcelData": [{ "Price": snap.sale_price, "Area": snap.area }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true, "price": snap.sale_price, "area": snap.area }))
}

/// Abandon (release) the parcel.
#[tauri::command]
pub async fn sl_parcel_release(state: State<'_, Arc<AppState>>, local_id: i64) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    match s.parcel_snapshot() {
        Some(snap) if snap.local_id == local_id && local_id > 0 => {}
        _ => return Err("The land data on screen is stale - refresh the Land tab first.".into()),
    }
    s.send_encoded(
        "ParcelRelease",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "Data": [{ "LocalID": local_id }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_parcel_deed_to_group(state: State<'_, Arc<AppState>>, local_id: i64, group_id: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if group_id.is_empty() || group_id == ZERO_UUID {
        return Err("No group selected".into());
    }
    match s.parcel_snapshot() {
        Some(snap) if snap.local_id == local_id && local_id > 0 => {}
        _ => return Err("The land data on screen is stale - refresh the Land tab first.".into()),
    }
    s.send_encoded(
        "ParcelDeedToGroup",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "Data": [{ "GroupID": group_id, "LocalID": local_id }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

/// Buy a temporary access pass to the parcel (price/hours are the sim's).
#[tauri::command]
pub async fn sl_parcel_buy_pass(state: State<'_, Arc<AppState>>, local_id: i64) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    let snap = s
        .parcel_snapshot()
        .ok_or("No parcel data - refresh the Land tab first.")?;
    if snap.local_id != local_id || local_id <= 0 {
        return Err("The land data on screen is stale - refresh the Land tab first.".into());
    }
    if !snap.sell_passes {
        return Err("This parcel does not sell passes.".into());
    }
    if snap.owner_id.eq_ignore_ascii_case(&agent) {
        return Err("This is your own parcel.".into());
    }
    s.send_encoded(
        "ParcelBuyPass",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "ParcelData": [{ "LocalID": local_id }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true, "price": snap.pass_price, "hours": snap.pass_hours }))
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
    *state.currency.lock().unwrap() = None;
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
    stand_before_teleport(&s, &agent, &sess).await;
    // A lure's destination is the inviter's secret until we arrive; an older
    // trip's recorded target must not label it.
    s.set_tp_target(None);
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

/// Save the private notes about a resident. On Second Life the ONLY working
/// path is a PUT through the AgentProfile cap; the AvatarNotesUpdate message
/// is silently ignored there (it only still works on capless OpenSim grids),
/// so sending it and reporting success would lose the notes on relog.
#[tauri::command]
pub async fn sl_save_notes(state: State<'_, Arc<AppState>>, target_id: String, notes: String) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    if target_id.is_empty() || target_id == ZERO_UUID {
        return Err("No target for notes".into());
    }
    if s.cap("AgentProfile").is_some() {
        crate::bridge::caps::save_avatar_notes(state.inner(), &s, &target_id, &notes).await?;
        return Ok(json!({ "ok": true, "via": "cap" }));
    }
    // Capless grid (OpenSim): the legacy message is still the real save path there.
    s.send_encoded(
        "AvatarNotesUpdate",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "Data": [{ "TargetID": target_id, "Notes": vstr(&notes) }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true, "via": "udp" }))
}

#[tauri::command]
pub async fn sl_search_people(state: State<'_, Arc<AppState>>, query: String, flags: Option<i64>, start: Option<i64>) -> Cmd {
    let (s, agent, sess) = active_ids(&state)?;
    // People are typed in as usernames ("first.last"), but the directory matches on
    // the display "First Last", so we turn the dots into spaces before querying.
    let query = people_query(&query);
    let query_id = crate::bridge::circuit::gen_id();
    let start = start.unwrap_or(0);
    s.send_encoded(
        "DirFindQuery",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "QueryData": [{ "QueryID": query_id, "QueryText": vstr(&query), "QueryFlags": flags.unwrap_or(DFQ_PEOPLE), "QueryStart": start }],
        }),
        true,
    )
    .await;
    let (rows, status) = await_dir_results(&s, &query_id).await;
    Ok(dir_result_payload(&query_id, rows, status, start))
}

/// Normalize a people-search query: dots (the username form) become spaces and
/// runs of whitespace collapse down to one, so "john.doe" searches as "john doe".
fn people_query(raw: &str) -> String {
    raw.replace('.', " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn people_query_dots_to_spaces() {
        assert_eq!(people_query("john.doe"), "john doe");
        assert_eq!(people_query("  Alice   Liddell "), "Alice Liddell");
        assert_eq!(people_query("first.last.resident"), "first last resident");
    }

    fn rows(n: usize) -> Vec<Value> {
        (0..n).map(|i| json!({ "id": i })).collect()
    }

    #[test]
    fn dir_result_payload_within_one_page() {
        let p = dir_result_payload("q1", rows(37), 0, 0);
        assert_eq!(p["results"].as_array().unwrap().len(), 37);
        assert_eq!(p["hasMore"], false);
        assert_eq!(p["queryId"], "q1");
        assert_eq!(p["statusText"], "");
    }

    #[test]
    fn dir_result_payload_trims_the_overflow_sentinel() {
        // The server sends 101 rows to say "another page exists"; the 101st is
        // a flag, not a result.
        let p = dir_result_payload("q1", rows(DIR_PAGE + 1), 0, 0);
        assert_eq!(p["results"].as_array().unwrap().len(), DIR_PAGE);
        assert_eq!(p["hasMore"], true);
        assert_eq!(p["nextStart"], DIR_PAGE as i64);
    }

    #[test]
    fn dir_result_payload_advances_next_start_from_the_requested_page() {
        let p = dir_result_payload("q1", rows(DIR_PAGE + 1), 0, 200);
        assert_eq!(p["nextStart"], 300);
    }

    #[test]
    fn dir_result_payload_empty_page() {
        let p = dir_result_payload("q1", rows(0), 0, 0);
        assert_eq!(p["results"].as_array().unwrap().len(), 0);
        assert_eq!(p["hasMore"], false);
    }

    #[test]
    fn access_entry_expiry_keeps_an_existing_absolute_time() {
        // Re-saving a list must not extend anyone's ban.
        let e = json!({ "id": "x", "time": 1_700_000_000, "hours": 5.0 });
        assert_eq!(access_entry_expiry(&e, 1_800_000_000), 1_700_000_000);
    }

    #[test]
    fn access_entry_expiry_turns_hours_into_absolute_time() {
        let e = json!({ "id": "x", "time": 0, "hours": 2.0 });
        assert_eq!(access_entry_expiry(&e, 1_000_000), 1_000_000 + 7200);
        // Fractional hours round down to whole seconds.
        let e = json!({ "id": "x", "hours": 0.5 });
        assert_eq!(access_entry_expiry(&e, 1_000_000), 1_000_000 + 1800);
    }

    #[test]
    fn access_entry_expiry_defaults_to_permanent() {
        assert_eq!(access_entry_expiry(&json!({ "id": "x" }), 1_000_000), 0);
        assert_eq!(access_entry_expiry(&json!({ "id": "x", "time": 0 }), 1_000_000), 0);
        assert_eq!(access_entry_expiry(&json!({ "id": "x", "hours": 0.0 }), 1_000_000), 0);
        assert_eq!(access_entry_expiry(&json!({ "id": "x", "hours": -3.0 }), 1_000_000), 0);
        // A negative/zero absolute time means "no expiry", not "in the past".
        assert_eq!(access_entry_expiry(&json!({ "id": "x", "time": -5 }), 1_000_000), 0);
        // A broken clock must never manufacture a short ban out of "permanent".
        assert_eq!(access_entry_expiry(&json!({ "id": "x", "hours": 2.0 }), 0), 0);
    }

    #[test]
    fn offer_response_dialogs_map_to_offer_plus_one_and_two() {
        assert_eq!(offer_response_dialog(false, false, true), 5);
        assert_eq!(offer_response_dialog(false, false, false), 6);
        assert_eq!(offer_response_dialog(false, true, true), 10);
        assert_eq!(offer_response_dialog(false, true, false), 11);
        // Group-notice attachments win regardless of the task flag.
        assert_eq!(offer_response_dialog(true, false, true), 33);
        assert_eq!(offer_response_dialog(true, true, false), 34);
    }

    #[test]
    fn parcel_region_guard_blocks_only_known_mismatches() {
        // Same region (case-insensitive) or unknown on either side: allowed.
        assert!(!parcel_region_mismatch("", ""));
        assert!(!parcel_region_mismatch("", "aaaa"));
        assert!(!parcel_region_mismatch("aaaa", ""));
        assert!(!parcel_region_mismatch("AAAA", "aaaa"));
        // A baseline from another region must be refused - LocalIDs collide.
        assert!(parcel_region_mismatch("aaaa", "bbbb"));
    }

    #[test]
    fn uuid_bytes_parses_and_rejects() {
        assert_eq!(
            uuid_bytes("00010203-0405-0607-0809-0a0b0c0d0e0f"),
            (0u8..16).collect::<Vec<u8>>()
        );
        assert_eq!(uuid_bytes(""), vec![0u8; 16]);
        assert_eq!(uuid_bytes("not-a-uuid"), vec![0u8; 16]);
        assert_eq!(uuid_bytes("00010203-0405-0607-0809"), vec![0u8; 16]);
    }

    #[test]
    fn dir_status_texts() {
        assert!(dir_status_text(1 << 0).contains("banned"));
        assert!(dir_status_text(1 << 1).contains("short"));
        assert!(dir_status_text(1 << 3).contains("disabled"));
        // FOUNDNONE (1 << 2) is just an empty result, not an error message.
        assert_eq!(dir_status_text(1 << 2), "");
        assert_eq!(dir_status_text(0), "");
    }

    #[test]
    fn search_query_flags_ask_for_every_maturity_band() {
        // The dataserver intersects these with the account's allowance, so the
        // right request is always "everything".
        assert_eq!(DFQ_INC_ALL, (1 << 24) | (1 << 25) | (1 << 26));
        assert_eq!(DFQ_PEOPLE, 1);
        assert_eq!(DFQ_GROUPS, 16);
        assert_eq!(DFQ_DWELL_SORT, 1 << 10);
    }
}

/// True when the parcel baseline was captured in a different region than the
/// one the circuit is on now. Unknown ids (either side) don't block: old
/// cached parcels have no regionId, and the guard must not break them.
fn parcel_region_mismatch(baseline_region: &str, current_region: &str) -> bool {
    !baseline_region.is_empty()
        && !current_region.is_empty()
        && !baseline_region.eq_ignore_ascii_case(current_region)
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
    // A LocalID is only unique within its region. A baseline captured before a
    // teleport must not be applied in the new region - it would overwrite an
    // unrelated parcel that happens to share the id.
    if parcel_region_mismatch(&g("regionId"), &s.region_id()) {
        return Err("The land data on screen is from another region - refresh the Land tab first.".into());
    }
    // And within a region: the engine's own snapshot is the authority on which
    // parcel we are actually standing on. Walking onto a neighbouring parcel
    // with the form still open would otherwise write this form's values onto
    // whatever parcel the id now belongs to. The access-list save has always
    // checked this; a full parcel save is the one that can lose more.
    if let Some(snap) = s.parcel_snapshot() {
        if snap.local_id != gi("localId") {
            return Err("The land data on screen is stale - refresh the Land tab first.".into());
        }
    }
    // Fold the edited checkbox booleans back onto the parcel's CURRENT flags. The UI
    // sends `parcelFlags` (the loaded baseline) plus the booleans; recomputing here
    // preserves the bits the form doesn't expose. Without this, a save would send 0
    // and clear every flag (build/scripts/fly/search/... ) - genuine data loss.
    let baseline = parcel.get("parcelFlags").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let folded_flags = crate::bridge::session::fold_parcel_flags(baseline, &parcel);
    // Landing point: round-trip the EXACT UserLocation/UserLookAt vectors the
    // sim gave us (the parcel event carries them since 0.9.0). The old path
    // rebuilt them from the rounded display values (whole metres, whole
    // degrees), which drifted the landing point by up to half a metre on every
    // save and turned "no look-at set" (0,0,0) into a fabricated direction.
    let exact_vec = |k: &str| {
        parcel.get(k).map(|o| {
            json!([
                o.get("x").and_then(|x| x.as_f64()).unwrap_or(0.0),
                o.get("y").and_then(|x| x.as_f64()).unwrap_or(0.0),
                o.get("z").and_then(|x| x.as_f64()).unwrap_or(0.0)
            ])
        })
    };
    let landing_vec = exact_vec("userLocation")
        .or_else(|| exact_vec("landingPoint"))
        .unwrap_or_else(|| json!([0.0, 0.0, 0.0]));
    let look_vec = exact_vec("userLookAt").unwrap_or_else(|| {
        // A pre-0.9.0 cached parcel only carries the derived heading.
        let heading = parcel.get("landingHeading").and_then(|v| v.as_f64()).unwrap_or(0.0).to_radians();
        json!([heading.cos(), heading.sin(), 0.0])
    });
    // Which wire to use.
    //
    // A viewer shipped in lockstep with the server's own parcel definition can
    // always prefer the capability, because its full-replace body is guaranteed
    // to mention every field that exists. Minibee does
    // not have that guarantee. If Linden Lab adds a parcel setting tomorrow,
    // this build cannot echo it back, and a capability save - being a
    // wholesale replace - would reset it to default every single time.
    //
    // The ordinary message carries only the fields it defines and leaves the
    // rest alone, which makes it the safer default for a viewer that updates
    // on its own schedule. So it is used unless the edit genuinely needs the
    // capability: see_avs and the avatar-sound pair exist nowhere else.
    let needs_cap = parcel.get("useCapSave").and_then(|v| v.as_bool()).unwrap_or(false);
    if needs_cap && s.cap("ParcelPropertiesUpdate").is_some() {
        let as_arr = |v: &Value| -> [f64; 3] {
            let a = v.as_array();
            let g = |i: usize| a.and_then(|x| x.get(i)).and_then(|n| n.as_f64()).unwrap_or(0.0);
            [g(0), g(1), g(2)]
        };
        let body = crate::bridge::caps::parcel_update_body(
            &parcel,
            folded_flags,
            as_arr(&landing_vec),
            as_arr(&look_vec),
        );
        crate::bridge::caps::update_parcel_via_cap(state.inner(), &s, &body).await?;
        return Ok(json!({ "ok": true, "via": "cap" }));
    }
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
    Ok(json!({ "ok": true, "via": "udp" }))
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
        let mut connected = connected.clone();
        if let Some(p) = session.last_position() {
            if let Some(obj) = connected.as_object_mut() {
                obj.insert(
                    "position".into(),
                    json!({ "x": p[0], "y": p[1], "z": p[2] }),
                );
            }
        }
        let _ = app.emit("minibee-viewer://connected", connected);
    }

    // Raise (or clear) the degraded-features banner based on the caps the
    // session is actually running with. An empty set means the seed-cap fetch
    // failed and the login only *looks* clean - exactly the silent cascade this
    // banner exists to surface.
    crate::bridge::caps::emit_caps_status(&app, Some(&caps_map), "connect");

    // Request 360-degree interest at connect; we have no camera frustum to aim.
    let boot_state = state.inner().clone();
    let boot_session = session.clone();
    tokio::spawn(async move {
        crate::bridge::caps::interest_list_360(&boot_state, &boot_session).await;
    });

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

