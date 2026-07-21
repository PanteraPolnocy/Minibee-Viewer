//! Tauri command surface invoked from the frontend over IPC.
//!
//! `bridge_*` commands cover login, the capability proxy, and map/destinations
//! lookups. `sl_*` commands drive the UDP circuit; decoded packets and inbound
//! trusted messages are delivered to the frontend as `minibee-viewer://packet` /
//! `minibee-viewer://http-message` events.

use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

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
    }))
}

#[tauri::command]
pub async fn bridge_version(state: State<'_, Arc<AppState>>) -> Cmd {
    Ok(state.version.clone())
}

#[tauri::command]
pub async fn bridge_login(state: State<'_, Arc<AppState>>, payload: Value) -> Cmd {
    login::login(state.inner().clone(), payload).await
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

    // Resolve UDP listen port + sim IP from the circuit session when present.
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
    // `lane` must outlive `_lane_guard` (guard borrows lane), so declare it first.
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
    // caps) consumes structured data without a second JS-side parse.
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

/// Split a line of chat/IM text into ordered text/link segments with trust
/// classification (to-do §9). Canonical URL grammar lives in `urlmatch`; the
/// frontend renders the returned segments (escaping text spans itself).
#[tauri::command]
pub async fn bridge_linkify(text: String) -> Cmd {
    Ok(json!({ "segments": urlmatch::linkify(&text) }))
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
    let (id, session, local_port) = circuit::open(app, &ip, sim_port).await?;
    state.sessions.lock().unwrap().insert(id.clone(), session);
    Ok(json!({
        "sessionId": id,
        "localPort": local_port,
        "sim": format!("{}:{}", ip, sim_port),
    }))
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

/// Send a base64-encoded, already-framed packet (the frontend codec's output).
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
    // Optional per-send target override (teleport handoff to another sim).
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
