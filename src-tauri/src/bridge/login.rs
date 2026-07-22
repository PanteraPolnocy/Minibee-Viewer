//! XML-RPC `login_to_simulator`, response parsing, and seed-capability fetch.

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
    let raw = gs(p, "passwd");
    // Do not trim passwords. SL caps at 16 chars, OpenSim at 255 (`passwdMax`).
    let max = p.get("passwdMax").and_then(|v| v.as_u64()).unwrap_or(16).clamp(1, 255) as usize;
    let plain: String = raw.chars().take(max).collect();
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
    members.push(member_string("mac", &gs(p, "mac")));
    members.push(member_string("id0", &gs(p, "id0")));
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

fn xml_value_to_json(value: roxmltree::Node) -> Value {
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
                        out.push(xml_value_to_json(v));
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
                        map.insert(name, xml_value_to_json(v));
                    }
                }
                Value::Object(map)
            }
            _ => Value::String(el.text().unwrap_or("").to_string()),
        },
    }
}

pub fn parse_login_response(xml: &str) -> Result<Map<String, Value>, String> {
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
        // Inventory skeleton: needed to resolve folders (e.g. Landmarks). Not secret.
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

    let mut extended = seed_bootstrap_cap_names();
    extended.extend_from_slice(&[
        "AgentState", "AvatarPickerSearch", "HomeLocation", "ReadOfflineMsgs", "UserInfo",
        "GetMetadata", "GetMesh", "GetMesh2", "GetTexture", "FetchInventory2",
        "FetchInventoryDescendents2", "InventoryAPIv3", "LibraryAPIv3", "ViewerAsset",
        "SimulatorFeatures",
    ]);
    let lists = [seed_bootstrap_cap_names(), extended];

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
        )
        .await
        {
            Ok(e) => e,
            Err(e) => return json!({ "ok": false, "error": e }),
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

    #[test]
    fn password_is_salted_md5_of_first_16_chars() {
        // "password" -> "$1$" + md5("password").
        let p = json!({ "passwd": "password" });
        assert_eq!(sl_login_passwd(&p), "$1$5f4dcc3b5aa765d61d8327deb882cf99");
        // Only the first 16 characters are hashed (LL truncates).
        let a = sl_login_passwd(&json!({ "passwd": "0123456789abcdefEXTRA" }));
        let b = sl_login_passwd(&json!({ "passwd": "0123456789abcdef" }));
        assert_eq!(a, b);
    }

    #[test]
    fn account_auth_type_sends_plain_password() {
        let p = json!({ "passwd": "secrettoken", "auth_type": "account" });
        assert_eq!(sl_login_passwd(&p), "secrettoken");
    }

    #[test]
    fn password_not_trimmed() {
        // Leading/trailing spaces are part of the password; trimming them would
        // hash something different than the user set.
        let spaced = sl_login_passwd(&json!({ "passwd": " secret " }));
        let plain = sl_login_passwd(&json!({ "passwd": "secret" }));
        assert_ne!(spaced, plain);
    }

    #[test]
    fn passwd_max_allows_long_opensim_passwords() {
        // A 20-char password must hash in full when passwdMax is 255 (OpenSim),
        // not be silently truncated to 16 as it would be for an SL grid.
        let pw = "0123456789abcdefghij"; // 20 chars
        let sl = sl_login_passwd(&json!({ "passwd": pw, "passwdMax": 16 }));
        let opensim = sl_login_passwd(&json!({ "passwd": pw, "passwdMax": 255 }));
        assert_ne!(sl, opensim);
        assert_eq!(sl, sl_login_passwd(&json!({ "passwd": "0123456789abcdef" })));
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
        // start defaults to "last" when unset.
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

pub async fn login(state: Arc<AppState>, body: Value) -> Result<Value, String> {
    let url = body.get("url").and_then(|u| u.as_str()).ok_or("url required")?.to_string();
    // The login URL is grid-supplied; guard it like any other egress.
    proxy::guard_url(&url).await.map_err(|e| format!("Login target refused: {e}"))?;
    let xml = build_login_xml(&body);

    let resp = state
        .http
        .post(&url)
        .header("Content-Type", "text/xml")
        .timeout(Duration::from_secs(90))
        .body(xml)
        .send()
        .await
        .map_err(|e| format!("Login HTTP error: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Login HTTP status {}", status.as_u16()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let parsed = parse_login_response(&text)?;

    let login_ok = matches!(parsed.get("login"), Some(Value::Bool(true)))
        || matches!(parsed.get("login"), Some(Value::String(s)) if s == "true");

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

    Ok(json!({
        "login": trim_login_for_client(&parsed),
        "circuit": Value::Null,
        "seedCaps": seed_caps,
    }))
}
