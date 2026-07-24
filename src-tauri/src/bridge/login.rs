//! The `login_to_simulator` XML-RPC call: building it, parsing the response, and fetching seed capabilities.

use std::sync::Arc;
use std::time::Duration;

use md5::{Digest, Md5};
use serde_json::{json, Map, Value};

use crate::bridge::proxy;
use crate::bridge::state::AppState;
use crate::bridge::util::{
    llsd_cap_keys, llsd_cap_map, normalize_seed_url, normalize_sim_ip, seed_has_region_caps,
    trim_quotes, xml_escape,
};

fn gs(p: &Value, key: &str) -> String {
    match p.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn not_empty(p: &Value, key: &str) -> bool {
    match p.get(key) {
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(_)) => true,
        Some(Value::Bool(b)) => *b,
        _ => false,
    }
}

fn md5_hex(input: &str) -> String {
    let mut h = Md5::new();
    h.update(input.as_bytes());
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

fn sl_login_passwd(p: &Value) -> String {
    // Follow the reference viewer (llpanellogin.cpp): MD5 the whole password, and
    // never trim or truncate it. That old 16-char SL limit was only a UI cap, not
    // part of the wire hash - truncating here would break login for any longer
    // password set through another viewer, and OpenSim allows up to 255 chars.
    let plain = gs(p, "passwd");
    if gs(p, "auth_type") == "account" {
        plain
    } else {
        format!("$1${}", md5_hex(&plain))
    }
}

fn member_string(name: &str, value: &str) -> String {
    format!(
        "<member><name>{}</name><value><string>{}</string></value></member>",
        xml_escape(name),
        xml_escape(value)
    )
}
fn member_bool(name: &str, value: bool) -> String {
    format!(
        "<member><name>{}</name><value><boolean>{}</boolean></value></member>",
        name,
        if value { "1" } else { "0" }
    )
}
fn member_int(name: &str, value: i64) -> String {
    format!(
        "<member><name>{}</name><value><int>{}</int></value></member>",
        xml_escape(name),
        value
    )
}

pub fn build_login_xml(p: &Value) -> String {
    let mut options = String::new();
    if let Some(arr) = p.get("options").and_then(|o| o.as_array()) {
        for opt in arr {
            if let Some(s) = opt.as_str() {
                options.push_str(&format!("<value><string>{}</string></value>", xml_escape(s)));
            }
        }
    }

    let mut members: Vec<String> = Vec::new();
    let has_username = not_empty(p, "username");
    if has_username {
        members.push(member_string("username", &gs(p, "username")));
    }
    if not_empty(p, "first") || !has_username {
        members.push(member_string("first", &gs(p, "first")));
    }
    if not_empty(p, "last") || !has_username {
        members.push(member_string("last", &gs(p, "last")));
    }
    members.push(member_string("passwd", &sl_login_passwd(p)));
    members.push(member_string("start", &{
        let s = gs(p, "start");
        if s.is_empty() { "last".to_string() } else { s }
    }));
    members.push(member_string("channel", &gs(p, "channel")));
    members.push(member_string("version", &gs(p, "version")));
    members.push(member_string("platform", &{
        let s = gs(p, "platform");
        if s.is_empty() { "Win".to_string() } else { s }
    }));
    // mac/id0 identify this machine to the login server. Derive them here from
    // hardware (see hwid) rather than trust the frontend, which can't reach it.
    let hw = crate::bridge::hwid::hwid();
    members.push(member_string("mac", &hw.mac));
    members.push(member_string("id0", &hw.id0));
    if not_empty(p, "host_id") {
        members.push(member_string("host_id", &gs(p, "host_id")));
    }
    if not_empty(p, "platform_version") {
        members.push(member_string("platform_version", &gs(p, "platform_version")));
    }
    if not_empty(p, "platform_string") {
        members.push(member_string("platform_string", &gs(p, "platform_string")));
    }
    if let Some(n) = p.get("address_size").and_then(|x| x.as_i64()) {
        members.push(member_int("address_size", n));
    }
    if not_empty(p, "extended_errors") {
        members.push(member_bool("extended_errors", true));
    }
    if let Some(n) = p.get("last_exec_event").and_then(|x| x.as_i64()) {
        members.push(member_int("last_exec_event", n));
    }
    if let Some(n) = p.get("last_exec_duration").and_then(|x| x.as_i64()) {
        members.push(member_int("last_exec_duration", n));
    }
    // Always sent (a null UUID when we don't know it) so the server can tie this
    // login to the prior session for last-exec accounting and stale-session cleanup.
    members.push(member_string("last_exec_session_id", &gs(p, "last_exec_session_id")));
    members.push(member_bool("agree_to_tos", p.get("agree_to_tos").and_then(|x| x.as_bool()).unwrap_or(false)));
    members.push(member_bool("read_critical", p.get("read_critical").and_then(|x| x.as_bool()).unwrap_or(false)));
    members.push(member_string("token", &gs(p, "token")));
    members.push(member_string("mfa_hash", &gs(p, "mfa_hash")));
    members.push(format!(
        "<member><name>options</name><value><array><data>{}</data></array></value></member>",
        options
    ));

    format!(
        "<?xml version=\"1.0\"?><methodCall><methodName>login_to_simulator</methodName><params><param><value><struct>{}</struct></value></param></params></methodCall>",
        members.join("")
    )
}

/// Cap on nesting depth: a maliciously deep XML-RPC login response mustn't be able
/// to overflow the stack in this recursion and take the app down. The login URL is
/// grid-configurable, so we don't fully trust the server.
const MAX_XMLRPC_DEPTH: u32 = 64;

fn xml_value_to_json(value: roxmltree::Node) -> Value {
    xml_value_to_json_at(value, 0)
}

fn xml_value_to_json_at(value: roxmltree::Node, depth: u32) -> Value {
    if depth >= MAX_XMLRPC_DEPTH {
        return Value::Null;
    }
    let child = value.children().find(|c| c.is_element());
    match child {
        None => Value::String(value.text().unwrap_or("").trim().to_string()),
        Some(el) => match el.tag_name().name() {
            "string" | "URI" | "uri" => Value::String(el.text().unwrap_or("").to_string()),
            "int" | "i4" => json!(el.text().and_then(|t| t.trim().parse::<i64>().ok()).unwrap_or(0)),
            "boolean" => {
                let t = el.text().unwrap_or("").trim().to_ascii_lowercase();
                json!(t == "1" || t == "true")
            }
            "double" => json!(el.text().and_then(|t| t.trim().parse::<f64>().ok()).unwrap_or(0.0)),
            "array" => {
                let mut out = Vec::new();
                if let Some(data) = el.children().find(|c| c.has_tag_name("data")) {
                    for v in data.children().filter(|c| c.has_tag_name("value")) {
                        out.push(xml_value_to_json_at(v, depth + 1));
                    }
                }
                Value::Array(out)
            }
            "struct" => {
                let mut map = Map::new();
                for member in el.children().filter(|c| c.has_tag_name("member")) {
                    let name = member
                        .children()
                        .find(|c| c.has_tag_name("name"))
                        .and_then(|n| n.text())
                        .unwrap_or("")
                        .to_string();
                    if let Some(v) = member.children().find(|c| c.has_tag_name("value")) {
                        map.insert(name, xml_value_to_json_at(v, depth + 1));
                    }
                }
                Value::Object(map)
            }
            _ => Value::String(el.text().unwrap_or("").to_string()),
        },
    }
}

fn map_str(m: &Map<String, Value>, k: &str) -> String {
    match m.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn map_i64(m: &Map<String, Value>, k: &str) -> i64 {
    match m.get(k) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// Parse an SL vector string such as `[r0.5, r1, r0]` into its (x, y, z) parts.
fn parse_sl_vector(raw: &str) -> Option<(f64, f64, f64)> {
    let inner = raw.trim().trim_start_matches('[').trim_end_matches(']');
    let parts: Vec<f64> = inner
        .split(',')
        .filter_map(|p| p.trim().trim_start_matches('r').trim().parse::<f64>().ok())
        .collect();
    if parts.len() >= 3 {
        Some((parts[0], parts[1], parts[2]))
    } else {
        None
    }
}

/// Sort a login response into a category the UI understands: ok / tos / critical / mfa / error.
pub fn classify_login(login: &Map<String, Value>) -> Value {
    let ok = matches!(login.get("login"), Some(Value::Bool(true)))
        || matches!(login.get("login"), Some(Value::String(s)) if s == "true");
    if ok {
        return json!({ "ok": true });
    }
    let reason = login
        .get("reason")
        .and_then(|v| v.as_str())
        .or_else(|| login.get("status").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_lowercase();
    let message = login
        .get("message")
        .and_then(|v| v.as_str())
        .or_else(|| login.get("message_id").and_then(|v| v.as_str()))
        .unwrap_or("Login failed.")
        .to_string();
    let mfa_hash = login.get("mfa_hash").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let ml = message.to_lowercase();
    let ty = if reason == "tos" {
        "tos"
    } else if reason == "critical" {
        "critical"
    } else if reason == "update" {
        // The viewer is too old, so the server wants a mandatory update rather than a plain error.
        "update"
    } else if reason == "mfa_challenge"
        || !mfa_hash.is_empty()
        || ml.contains("multifactor")
        || ml.contains("authenticator")
        || ml.contains("two-factor")
        || ml.contains("mfa")
    {
        "mfa"
    } else {
        "error"
    };
    json!({ "ok": false, "type": ty, "reason": reason, "message": message, "mfaHash": mfa_hash })
}

fn parse_buddies(login: &Map<String, Value>) -> Value {
    let list = login.get("buddy-list").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let out: Vec<Value> = list
        .iter()
        .map(|b| {
            let id = trim_quotes(b.get("buddy_id").or_else(|| b.get("id")).and_then(|v| v.as_str()).unwrap_or(""));
            let ri = |k: &str| b.get(k).and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0);
            let online = matches!(b.get("online"), Some(Value::Bool(true)))
                || matches!(b.get("online"), Some(Value::String(s)) if s == "Y" || s == "true");
            json!({
                "id": id, "name": id, "displayName": "", "userName": "", "online": online,
                "rightsHas": ri("buddy_rights_has"), "rightsGiven": ri("buddy_rights_given")
            })
        })
        .collect();
    json!(out)
}

/// Structured login data for the frontend - agent, region, buddies, sim, and so on -
/// so that none of the login parsing has to live in JS.
pub fn normalize_login(login: &Map<String, Value>) -> Value {
    let first = map_str(login, "first_name").replace('"', "");
    let last = map_str(login, "last_name").replace('"', "");
    let region_x = map_i64(login, "region_x");
    let region_y = map_i64(login, "region_y");
    let grid_x = region_x / 256;
    let grid_y = region_y / 256;
    let sim_name = map_str(login, "sim_name");
    let region_name = if sim_name.is_empty() {
        format!("Region {region_x},{region_y}")
    } else {
        sim_name
    };
    let look_at = login
        .get("look_at")
        .and_then(|v| v.as_str())
        .and_then(parse_sl_vector)
        .unwrap_or((0.0, 1.0, 0.0));
    let sim_ip = normalize_sim_ip(login.get("sim_ip").unwrap_or(&Value::Null));
    let display_name = format!("{first} {last}").trim().to_string();

    json!({
        "agent": { "id": trim_quotes(&map_str(login, "agent_id")), "first": first, "last": last, "displayName": display_name },
        "sessionId": trim_quotes(&map_str(login, "session_id")),
        "secureSessionId": trim_quotes(&map_str(login, "secure_session_id")),
        "circuitCode": map_i64(login, "circuit_code"),
        "simIp": sim_ip,
        "simPort": map_i64(login, "sim_port"),
        "region": {
            "name": region_name,
            "globalX": grid_x * 256, "globalY": grid_y * 256,
            "x": grid_x, "y": grid_y, "id": ""
        },
        "seedCapability": map_str(login, "seed_capability"),
        "buddies": parse_buddies(login),
        "lookAt": { "x": look_at.0, "y": look_at.1, "z": look_at.2 },
        "spawnPosition": { "x": 128, "y": 128, "z": 25 },
        "message": map_str(login, "message"),
    })
}

pub fn parse_login_response(xml: &str) -> Result<Map<String, Value>, String> {
    // The login URL is grid-configurable, so screen for a nesting-bomb response
    // before roxmltree builds the tree (and could overflow the stack on it).
    if crate::codec::llsd::max_xml_nesting(xml) > MAX_XMLRPC_DEPTH as usize {
        return Err("XML-RPC response nested too deeply".to_string());
    }
    let doc = roxmltree::Document::parse(xml).map_err(|_| "Invalid XML-RPC response".to_string())?;
    let struct_node = doc
        .descendants()
        .find(|n| n.has_tag_name("struct"))
        .ok_or("XML-RPC response has no struct")?;
    let mut result = Map::new();
    for member in struct_node.children().filter(|c| c.has_tag_name("member")) {
        let name = member
            .children()
            .find(|c| c.has_tag_name("name"))
            .and_then(|n| n.text())
            .unwrap_or("")
            .to_string();
        if let Some(v) = member.children().find(|c| c.has_tag_name("value")) {
            result.insert(name, xml_value_to_json(v));
        }
    }
    Ok(result)
}

fn trim_login_for_client(login: &Map<String, Value>) -> Value {
    const KEYS: &[&str] = &[
        "login", "reason", "status", "message", "message_id", "agent_id", "first_name",
        "last_name", "session_id", "secure_session_id", "circuit_code", "sim_ip", "sim_port",
        "seed_capability", "buddy-list", "region_x", "region_y", "sim_name", "look_at",
        "home_info", "home", "start_location", "mfa_hash", "agent_access",
        // Inventory skeleton: we need it to resolve folders (e.g. Landmarks). Nothing secret.
        "inventory-root", "inventory-skeleton", "inventory-lib-root", "inventory-lib-owner",
        "inventory-skel-lib",
    ];
    let mut out = Map::new();
    for k in KEYS {
        if let Some(v) = login.get(*k) {
            out.insert((*k).to_string(), v.clone());
        }
    }
    if let Some(seed) = out.get("seed_capability").and_then(|v| v.as_str()).map(|s| s.to_string()) {
        let raw = trim_quotes(&seed);
        let normalized = normalize_seed_url(&raw);
        if !normalized.is_empty() && normalized != raw {
            out.insert("seed_capability_raw".into(), json!(raw));
        }
        out.insert(
            "seed_capability".into(),
            json!(if normalized.is_empty() { raw } else { normalized }),
        );
    }
    Value::Object(out)
}

fn seed_bootstrap_cap_names() -> Vec<&'static str> {
    vec![
        "EventQueueGet", "GetDisplayNames", "AgentPreferences", "ChatSessionRequest",
        "RemoteParcelRequest", "LandResources", "ParcelPropertiesUpdate", "ViewerBenefits",
        "AgentProfile",
    ]
}

/// Re-fetch a region's capability map from its seed URL (we do this on teleport and
/// region cross). Returns the `name -> url` map, or None if the fetch failed or came
/// back with no usable region caps.
pub(crate) async fn fetch_region_caps(
    state: &AppState,
    seed_url: &str,
    sim_ip: &str,
    session_id: &str,
) -> Option<std::collections::HashMap<String, String>> {
    let res = fetch_login_seed_caps(state, seed_url, sim_ip, session_id).await;
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let caps = res.get("caps")?.as_object()?;
    let map: std::collections::HashMap<String, String> = caps
        .iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .collect();
    if map.is_empty() {
        None
    } else {
        Some(map)
    }
}

async fn fetch_login_seed_caps(
    state: &AppState,
    seed_url: &str,
    sim_ip: &str,
    session_id: &str,
) -> Value {
    let seed_url = normalize_seed_url(seed_url);
    if seed_url.is_empty() {
        return json!({ "ok": false, "error": "No seed capability URL" });
    }
    let sim_ip = normalize_sim_ip(&json!(sim_ip));

    let mut full = seed_bootstrap_cap_names();
    full.extend_from_slice(&[
        "AgentState", "AvatarPickerSearch", "HomeLocation", "ReadOfflineMsgs", "UserInfo",
        "GetMetadata", "GetMesh", "GetMesh2", "GetTexture", "FetchInventory2",
        "FetchInventoryDescendents2", "InventoryAPIv3", "LibraryAPIv3", "ViewerAsset",
        "SimulatorFeatures",
    ]);
    // Ask for the FULL cap set first, in a single POST - the seed grant only hands
    // back the caps you request (the reference viewer posts its whole list at once), so
    // asking for just the bootstrap names would leave inventory/texture/mesh/asset/
    // SimulatorFeatures/etc ungranted, here and on every region entered later.
    // The bootstrap-only list is kept purely as a fallback for a picky grid.
    let lists = [full, seed_bootstrap_cap_names()];

    let session_id = trim_quotes(session_id);
    let mut last_keys: Vec<String> = Vec::new();
    let mut last_status = 0u16;
    let mut last_body = String::new();

    for names in &lists {
        let payload = crate::bridge::util::llsd_array_xml(names);
        let mut headers = vec![
            ("Content-Type".to_string(), "application/llsd+xml".to_string()),
        ];
        if !session_id.is_empty() {
            headers.push(("X-SecondLife-Session-ID".to_string(), session_id.clone()));
        }
        let (pin, pinned_ip) = proxy::simhost_pin(&seed_url, &sim_ip).await;
        let exchange = match proxy::exchange(
            &state.ua,
            "POST",
            &seed_url,
            &payload,
            "application/llsd+xml",
            &headers,
            pin,
            Duration::from_secs(45),
            true,
        )
        .await
        {
            Ok(e) => e,
            Err(e) => {
                // One request erroring shouldn't sink the whole seed grant - fall
                // through to the next (smaller) list, and only fail if every one does.
                crate::dlog!("seed caps: request failed ({e})");
                last_body = String::new();
                last_keys.clear();
                continue;
            }
        };
        last_status = exchange.status;
        last_body = exchange.body.clone();
        last_keys = llsd_cap_keys(&last_body);
        if seed_has_region_caps(&last_keys) {
            return json!({
                "ok": true,
                "body": last_body,
                "caps": llsd_cap_map(&last_body),
                "contentType": if exchange.content_type.is_empty() { "application/llsd+xml".to_string() } else { exchange.content_type },
                "capKeys": last_keys,
                "status": last_status,
                "responseBytes": exchange.body.len(),
                "requestBytes": payload.len(),
                "simPinnedIp": pinned_ip,
            });
        }
    }

    json!({
        "ok": false,
        "error": format!(
            "Seed grant missing region caps (got: {})",
            last_keys.iter().take(12).cloned().collect::<Vec<_>>().join(", ")
        ),
        "body": last_body,
        "caps": llsd_cap_map(&last_body),
        "contentType": "application/llsd+xml",
        "capKeys": last_keys,
        "status": last_status,
        "simPinnedIp": sim_ip,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn md5_known_vector() {
        assert_eq!(md5_hex("password"), "5f4dcc3b5aa765d61d8327deb882cf99");
    }

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn parse_username_variants() {
        assert_eq!(parse_username("Ruth Lee"), ("Ruth".into(), "Lee".into()));
        assert_eq!(parse_username("ruth.resident"), ("ruth".into(), "resident".into()));
        assert_eq!(parse_username("Ruth"), ("Ruth".into(), "Resident".into()));
        assert_eq!(parse_username("Bob Resident"), ("Bob".into(), "Resident".into()));
    }

    #[test]
    fn parse_sl_vector_reads_r_prefixed() {
        assert_eq!(parse_sl_vector("[r0.5, r1, r0]"), Some((0.5, 1.0, 0.0)));
        assert_eq!(parse_sl_vector("garbage"), None);
    }

    #[test]
    fn classify_login_cases() {
        let case = |v: Value| classify_login(&obj(v));
        assert_eq!(case(json!({ "login": true }))["ok"], true);
        assert_eq!(case(json!({ "login": false, "reason": "tos" }))["type"], "tos");
        assert_eq!(case(json!({ "login": false, "reason": "critical" }))["type"], "critical");
        assert_eq!(case(json!({ "login": false, "reason": "mfa_challenge" }))["type"], "mfa");
        assert_eq!(case(json!({ "login": false, "message": "Enter your authenticator code" }))["type"], "mfa");
        assert_eq!(case(json!({ "login": false, "reason": "key", "message": "bad login" }))["type"], "error");
    }

    #[test]
    fn normalize_login_maps_agent_region_buddies() {
        let m = obj(json!({
            "login": true, "agent_id": "\"11111111-1111-1111-1111-111111111111\"",
            "session_id": "22222222-2222-2222-2222-222222222222", "circuit_code": 12345,
            "sim_ip": "1.2.3.4", "sim_port": 13005, "first_name": "Ruth", "last_name": "Resident",
            "region_x": 256000, "region_y": 257024, "sim_name": "Natoma",
            "look_at": "[r0, r1, r0]",
            "buddy-list": [{ "buddy_id": "33333333-3333-3333-3333-333333333333", "buddy_rights_has": 1, "buddy_rights_given": 2 }],
        }));
        let n = normalize_login(&m);
        assert_eq!(n["agent"]["id"], "11111111-1111-1111-1111-111111111111");
        assert_eq!(n["agent"]["displayName"], "Ruth Resident");
        assert_eq!(n["circuitCode"], 12345);
        assert_eq!(n["simIp"], "1.2.3.4");
        assert_eq!(n["region"]["name"], "Natoma");
        assert_eq!(n["region"]["x"], 1000); // = 256000 / 256
        assert_eq!(n["region"]["y"], 1004); // = 257024 / 256
        assert_eq!(n["buddies"][0]["id"], "33333333-3333-3333-3333-333333333333");
        assert_eq!(n["buddies"][0]["rightsGiven"], 2);
        assert_eq!(n["lookAt"]["y"], 1.0);
    }

    #[test]
    fn password_is_salted_md5_of_full_password() {
        // "password" becomes "$1$" + md5("password").
        let p = json!({ "passwd": "password" });
        assert_eq!(sl_login_passwd(&p), "$1$5f4dcc3b5aa765d61d8327deb882cf99");
        // The full password is hashed, never truncated - just like the reference viewer.
        let a = sl_login_passwd(&json!({ "passwd": "0123456789abcdefEXTRA" }));
        let b = sl_login_passwd(&json!({ "passwd": "0123456789abcdef" }));
        assert_ne!(a, b);
    }

    #[test]
    fn account_auth_type_sends_plain_password() {
        let p = json!({ "passwd": "secrettoken", "auth_type": "account" });
        assert_eq!(sl_login_passwd(&p), "secrettoken");
    }

    #[test]
    fn password_not_trimmed() {
        // Leading and trailing spaces are part of the password; trimming them would
        // hash something other than what the user actually set.
        let spaced = sl_login_passwd(&json!({ "passwd": " secret " }));
        let plain = sl_login_passwd(&json!({ "passwd": "secret" }));
        assert_ne!(spaced, plain);
    }

    #[test]
    fn long_passwords_hash_in_full() {
        // A password past the old 16-char SL cap must still hash in full, and hash
        // the same regardless of any passwdMax hint - the reference viewer never trims.
        let pw = "0123456789abcdefghij"; // 20 characters
        let a = sl_login_passwd(&json!({ "passwd": pw, "passwdMax": 16 }));
        let b = sl_login_passwd(&json!({ "passwd": pw, "passwdMax": 255 }));
        assert_eq!(a, b);
        assert_ne!(a, sl_login_passwd(&json!({ "passwd": "0123456789abcdef" })));
    }

    #[test]
    fn build_login_xml_shapes_request() {
        let p = json!({
            "username": "resident",
            "passwd": "password",
            "channel": "Minibee",
            "version": "1.2.3",
            "agree_to_tos": true,
            "options": ["inventory-root", "buddy-list"]
        });
        let xml = build_login_xml(&p);
        assert!(xml.contains("<methodName>login_to_simulator</methodName>"));
        assert!(xml.contains("<name>username</name><value><string>resident</string>"));
        assert!(xml.contains("$1$5f4dcc3b5aa765d61d8327deb882cf99"));
        assert!(xml.contains("<name>agree_to_tos</name><value><boolean>1</boolean>"));
        assert!(xml.contains("<value><string>inventory-root</string></value>"));
        // When start isn't set, it should default to "last".
        assert!(xml.contains("<name>start</name><value><string>last</string>"));
    }

    #[test]
    fn parse_login_response_reads_scalars_and_nested() {
        let xml = r#"<?xml version="1.0"?><methodResponse><params><param><value><struct>
            <member><name>login</name><value><boolean>1</boolean></value></member>
            <member><name>sim_port</name><value><int>13005</int></value></member>
            <member><name>first_name</name><value><string>Test</string></value></member>
            <member><name>look_at</name><value><array><data>
                <value><string>r0</string></value><value><string>r1</string></value>
            </data></array></value></member>
        </struct></value></param></params></methodResponse>"#;
        let m = parse_login_response(xml).unwrap();
        assert_eq!(m.get("login"), Some(&json!(true)));
        assert_eq!(m.get("sim_port"), Some(&json!(13005)));
        assert_eq!(m.get("first_name"), Some(&json!("Test")));
        assert_eq!(m.get("look_at").unwrap().as_array().unwrap().len(), 2);
    }

    #[test]
    fn parse_login_response_rejects_bad_xml() {
        assert!(parse_login_response("<not-xmlrpc").is_err());
    }

    #[test]
    fn trim_login_keeps_whitelist_and_normalizes_seed() {
        let mut m = Map::new();
        m.insert("login".into(), json!(true));
        m.insert("sim_ip".into(), json!("8.8.8.8"));
        m.insert("secret_extra".into(), json!("should be dropped"));
        m.insert(
            "seed_capability".into(),
            json!("https://simhost-1234/abcdef.agni.secondlife.io:12043/cap/foo"),
        );
        let out = trim_login_for_client(&m);
        let obj = out.as_object().unwrap();
        assert!(obj.contains_key("login"));
        assert!(obj.contains_key("sim_ip"));
        assert!(!obj.contains_key("secret_extra"), "non-whitelisted keys dropped");
        assert_eq!(
            obj.get("seed_capability").unwrap().as_str().unwrap(),
            "https://simhost-1234abcdef.agni.secondlife.io:12043/cap/foo"
        );
        assert!(obj.contains_key("seed_capability_raw"));
    }
}

const LOGIN_OPTIONS: &[&str] = &[
    "inventory-root", "inventory-skeleton", "inventory-lib-root", "inventory-lib-owner",
    "inventory-skel-lib", "initial-outfit", "gestures", "display_names", "event_categories",
    "event_notifications", "classified_categories", "adult_compliant", "buddy-list",
    "newuser-config", "ui-config", "advanced-mode", "login-flags", "map-server-url",
    "global-textures", "max-agent-groups", "voice-config", "tutorial_setting",
];

fn grid_login_url(grid: &str) -> &'static str {
    match grid {
        "aditi" => "https://login.aditi.lindenlab.com/cgi-bin/login.cgi",
        "local" => "http://127.0.0.1:9000/",
        _ => "https://login.agni.lindenlab.com/cgi-bin/login.cgi",
    }
}

/// Split a username into first/last, treating a space, dot, or underscore as the
/// separator. Deliberately lenient, to match the legacy viewer forms "First Last",
/// "first.last", and "first_last"; a lone name gets "Resident" as the last name.
fn parse_username(raw: &str) -> (String, String) {
    let t = raw.trim();
    if let Some(i) = t.find([' ', '.', '_']) {
        let first = t[..i].trim().to_string();
        let last = t[i + 1..].trim();
        (first, if last.is_empty() { "Resident".into() } else { last.to_string() })
    } else {
        (t.to_string(), "Resident".to_string())
    }
}

/// Assemble the full login payload from the UI credentials plus native version/hwid,
/// so that none of the payload construction has to happen in JS.
fn assemble_login_body(state: &AppState, cred: &Value) -> Value {
    let cs = |k: &str| cred.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let cb = |k: &str| cred.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    let grid = cs("grid");
    let url = {
        let u = cs("loginUrl");
        if u.is_empty() { grid_login_url(&grid).to_string() } else { u }
    };
    let raw_username = cs("username");
    let (first, last) = parse_username(&raw_username);
    // On a non-Linden (OpenSim) grid, a single-word username means an account-type
    // login: we send username + cleartext secret rather than first/last + hashed pass.
    let is_linden = grid.is_empty() || grid == "agni" || grid == "aditi";
    let account_login =
        !is_linden && !raw_username.trim().is_empty() && !raw_username.trim().contains([' ', '.', '_']);
    let channel = state.version.get("channel").and_then(|v| v.as_str()).unwrap_or("Minibee-Viewer");
    let version = state.version.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0");
    let start = {
        let s = cs("start");
        if s.is_empty() { "last".to_string() } else { s }
    };
    let mut body = json!({
        "url": url,
        "passwd": cs("password"),
        "start": start,
        "channel": channel,
        "version": version,
        "platform": "Win",
        "platform_version": "10.0",
        "platform_string": "Windows 10",
        "address_size": 64,
        "extended_errors": true,
        "last_exec_event": 0,
        "last_exec_duration": 0,
        "agree_to_tos": cb("agreeToTos"),
        "read_critical": cb("readCritical"),
        "token": cs("token"),
        "mfa_hash": cs("mfaHash"),
        "options": LOGIN_OPTIONS,
    });
    if account_login {
        body["auth_type"] = json!("account");
        body["username"] = json!(raw_username.trim());
    } else {
        body["first"] = json!(first);
        body["last"] = json!(last);
    }
    body
}

pub async fn login(state: Arc<AppState>, credentials: Value) -> Result<Value, String> {
    let body = assemble_login_body(&state, &credentials);
    let url = body.get("url").and_then(|u| u.as_str()).ok_or("url required")?.to_string();
    let xml = build_login_xml(&body);

    // The login URL is grid-supplied, so route it through the same guarded path as
    // seed caps: proxy::exchange re-guards every redirect hop and, with the pinned
    // IP below, connects to the exact address the guard validated - which closes the
    // redirect-to-internal and DNS-rebinding SSRF windows that a plain
    // redirect-following client would leave open.
    let pin = proxy::resolve_public_pin(&url).await;
    let ex = proxy::exchange(
        &state.ua,
        "POST",
        &url,
        &xml,
        "text/xml",
        &[],
        pin,
        Duration::from_secs(90),
        // The login endpoint is the user's own grid choice (possibly a loopback/LAN
        // OpenSim), so allow it. The redirect hops are still guarded.
        false,
    )
    .await
    .map_err(|e| format!("Login HTTP error: {e}"))?;
    if !(200..300).contains(&ex.status) {
        return Err(format!("Login HTTP status {}", ex.status));
    }
    let parsed = parse_login_response(&ex.body)?;

    let login_ok = matches!(parsed.get("login"), Some(Value::Bool(true)))
        || matches!(parsed.get("login"), Some(Value::String(s)) if s == "true");

    // Stash the login payload for auto-reconnect (SecretStore keeps it obfuscated
    // in memory). Reuse the persistent MFA hash from the response and pre-accept
    // TOS/critical so a replay can log back in without a fresh interactive
    // challenge. Only the Rust core ever holds this - the JS side never keeps the
    // password after the initial submit.
    if login_ok {
        let mut relogin = credentials.clone();
        if let Value::Object(ref mut m) = relogin {
            m.insert("token".into(), json!(""));
            m.insert("agreeToTos".into(), json!(true));
            m.insert("readCritical".into(), json!(true));
            if let Some(hash) = parsed.get("mfa_hash").cloned() {
                m.insert("mfaHash".into(), hash);
            }
        }
        state.creds.stash(&relogin);
    }

    let seed_caps = if login_ok {
        if let Some(seed) = parsed.get("seed_capability").and_then(|v| v.as_str()) {
            if !seed.is_empty() {
                let sim_ip = parsed.get("sim_ip").map(|v| v.clone()).unwrap_or(json!(""));
                let sim_ip = match &sim_ip {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                let session_id = parsed.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
                fetch_login_seed_caps(&state, seed, &sim_ip, session_id).await
            } else {
                json!({ "ok": false })
            }
        } else {
            json!({ "ok": false })
        }
    } else {
        json!({ "ok": false })
    };

    crate::dlog!(
        "login ok={} seedCaps ok={} keys={} status={} err={}",
        login_ok,
        seed_caps.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        seed_caps.get("capKeys").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
        seed_caps.get("status").and_then(|v| v.as_u64()).unwrap_or(0),
        seed_caps.get("error").and_then(|v| v.as_str()).unwrap_or("")
    );

    Ok(json!({
        "login": trim_login_for_client(&parsed),
        "classified": classify_login(&parsed),
        "parsed": if login_ok { normalize_login(&parsed) } else { Value::Null },
        "circuit": Value::Null,
        "seedCaps": seed_caps,
    }))
}
