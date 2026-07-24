//! HTTP consumers for the region capabilities. The seed-cap fetch itself lives
//! in login.rs; here we lean on the SSRF-guarded `proxy::exchange` and `codec::llsd`.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::bridge::proxy;
use crate::bridge::state::AppState;
use crate::codec;

type Cmd = Result<Value, String>;

/// Capability URLs want a trailing slash before any query string or sub-path.
fn cap_endpoint(url: &str) -> String {
    let t = url.trim();
    if t.is_empty() || t.ends_with('/') {
        t.to_string()
    } else {
        format!("{t}/")
    }
}

fn field<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(|v| v.as_str()).unwrap_or("").trim()
}

/// Is `is_display_name_default` truthy? Depending on the sim, the cap sends it
/// as either a JSON bool or a 0/1 integer, so we accept both forms.
fn is_display_name_default(row: &Value) -> bool {
    match row.get("is_display_name_default") {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().map(|i| i != 0).unwrap_or(false),
        Some(Value::String(s)) => s == "1" || s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// Break a GetDisplayNames agent row into `(display, username, label)`.
/// `display` is the non-default display name (empty when the resident never set
/// one), `username` is the login/legacy name, and `label` is the single string
/// we'd rather show (display if set, else username). The UI pairs display and
/// username to render "Display Name (username)"; the session name cache uses `label`.
fn name_parts(row: &Value) -> (String, String, String) {
    let first = {
        let f = field(row, "legacy_first_name");
        if f.is_empty() { field(row, "legacyFirstName") } else { f }
    };
    let last = {
        let l = field(row, "legacy_last_name");
        if l.is_empty() { field(row, "legacyLastName") } else { l }
    };
    let mut user = {
        let u = field(row, "username");
        if u.is_empty() { field(row, "user_name") } else { u }
    }
    .to_string();
    if user.is_empty() {
        user = if last.is_empty() || last.eq_ignore_ascii_case("Resident") {
            first.to_string()
        } else {
            format!("{first} {last}")
        };
    }
    let is_default = is_display_name_default(row);
    let display_raw = field(row, "display_name");
    let display = if !is_default && !display_raw.is_empty() {
        display_raw.to_string()
    } else {
        String::new()
    };
    let label = if display.is_empty() { user.clone() } else { display.clone() };
    (display, user, label)
}

/// Resolve agent display names through the GetDisplayNames cap and feed the
/// engine name cache (emits `names-updated`). If this errors outright, falling
/// back to UDP UUIDNameRequest is the caller's job.
#[tauri::command]
pub async fn sl_resolve_display_names(app: AppHandle, state: State<'_, Arc<AppState>>, ids: Vec<String>) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let cap = session.cap("GetDisplayNames").ok_or("GetDisplayNames capability unavailable")?;
    let base = cap_endpoint(&cap);
    let agent_session = session.agent_ids().map(|(_, s)| s).unwrap_or_default();
    let headers: Vec<(String, String)> = if agent_session.is_empty() {
        Vec::new()
    } else {
        vec![("X-SecondLife-Session-ID".to_string(), agent_session)]
    };

    let mut resolved: Vec<(String, String)> = Vec::new();
    let mut rich: Vec<Value> = Vec::new(); // one { name, displayName, userName } per id, for the UI
    let mut bad_ids: Vec<String> = Vec::new();
    for chunk in ids.chunks(40) {
        let query = chunk
            .iter()
            .map(|id| format!("ids={}", urlencoding::encode(id)))
            .collect::<Vec<_>>()
            .join("&");
        let sep = if base.contains('?') { "&" } else { "?" };
        let url = format!("{base}{sep}{query}");
        let (pin, _) = proxy::simhost_pin(&url, "").await;
        let ex = match proxy::exchange(
            &state.ua,
            "GET",
            &url,
            "",
            "application/llsd+xml",
            &headers,
            pin,
            Duration::from_secs(30),
            true,
        )
        .await
        {
            Ok(e) => e,
            Err(e) => {
                // This chunk failed, but still send its ids down the UDP fallback
                // so those avatars aren't left stranded on raw UUIDs.
                crate::dlog!("GetDisplayNames: chunk HTTP error, falling back to UDP: {}", e);
                bad_ids.extend(chunk.iter().cloned());
                continue;
            }
        };
        let parsed = codec::llsd::parse(&ex.body, &ex.content_type).unwrap_or(Value::Null);
        if let Some(agents) = parsed.get("agents").and_then(|v| v.as_array()) {
            for row in agents {
                let id = row
                    .get("id")
                    .or_else(|| row.get("agent_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    continue;
                }
                let (display, user, label) = name_parts(row);
                if !label.is_empty() {
                    resolved.push((id.clone(), label.clone()));
                    rich.push(json!({ "id": id, "name": label, "displayName": display, "userName": user }));
                }
            }
        }
        // On the same 200 response the cap hands back any ids it couldn't resolve
        // (expired or pending display names) in `bad_ids`; gather them for the UDP
        // fallback rather than leaving those avatars showing raw UUIDs.
        if let Some(bad) = parsed.get("bad_ids").and_then(|v| v.as_array()) {
            for v in bad {
                if let Some(s) = v.as_str() {
                    if !s.is_empty() {
                        bad_ids.push(s.to_string());
                    }
                }
            }
        }
    }

    // Grab a small sample of the resolved display/username pairs so we can tell
    // whether display names are actually coming back, or everyone's just a username.
    let sample: String = rich
        .iter()
        .take(3)
        .map(|r| {
            format!(
                "d='{}' u='{}'",
                r.get("displayName").and_then(|v| v.as_str()).unwrap_or(""),
                r.get("userName").and_then(|v| v.as_str()).unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let changed = session.merge_names(&resolved);
    if !changed.is_empty() {
        // Emit the rich form (display + username) only for the ids that actually
        // changed, so the UI can render "Display Name (username)".
        let changed_ids: std::collections::HashSet<String> = changed
            .iter()
            .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect();
        let names_out: Vec<Value> = rich
            .into_iter()
            .filter(|r| r.get("id").and_then(|v| v.as_str()).map_or(false, |id| changed_ids.contains(id)))
            .collect();
        if !names_out.is_empty() {
            let _ = app.emit("minibee-viewer://names-updated", json!({ "names": names_out }));
        }
    }
    // Anything the cap couldn't resolve falls back to the legacy UUIDNameRequest.
    for chunk in bad_ids.chunks(40) {
        let blocks = json!({
            "UUIDNameBlock": chunk.iter().map(|id| json!({ "ID": id })).collect::<Vec<_>>()
        });
        session.send_encoded("UUIDNameRequest", &blocks, false).await;
    }
    crate::dlog!(
        "GetDisplayNames: requested={} resolved={} fellBackToUdp={} sample=[{}]",
        ids.len(),
        resolved.len(),
        bad_ids.len(),
        sample
    );
    Ok(json!({ "ok": true, "resolved": resolved.len(), "fellBack": bad_ids.len() }))
}

fn xml_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Build the LLSD body for a ChatSessionRequest (mirrors `chatSessionBodyXml` in sl-caps.js).
fn chat_session_body(method: &str, session_id: &str, params: &[String], mute: Option<(&str, bool)>) -> String {
    let mut inner = format!("<key>method</key><string>{}</string>", xml_text(method));
    if !session_id.is_empty() {
        inner += &format!("<key>session-id</key><uuid>{}</uuid>", xml_text(session_id));
    }
    if !params.is_empty() {
        let arr: String = params
            .iter()
            .filter(|p| !p.is_empty())
            .map(|p| format!("<uuid>{}</uuid>", xml_text(p)))
            .collect();
        inner += &format!("<key>params</key><array>{arr}</array>");
    } else if let Some((agent, text)) = mute {
        inner += &format!(
            "<key>params</key><map><key>agent_id</key><uuid>{}</uuid><key>mute_info</key><map><key>text</key><boolean>{}</boolean></map></map>",
            xml_text(agent),
            if text { "1" } else { "0" }
        );
    }
    format!("<?xml version=\"1.0\"?><llsd><map>{inner}</map></llsd>")
}

pub(crate) async fn chat_session_post(
    state: &Arc<AppState>,
    method: &str,
    session_id: &str,
    params: &[String],
    mute: Option<(&str, bool)>,
) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    // POST to the bare cap URL. ChatSessionRequest is an opaque, sim-granted key
    // matched by exact path, so a trailing slash (what cap_endpoint adds) tacks on an
    // empty path segment and misroutes the request; the reference viewer posts bare too.
    let base = session.cap("ChatSessionRequest").ok_or("ChatSessionRequest capability unavailable")?;
    let agent_session = session.agent_ids().map(|(_, s)| s).unwrap_or_default();
    let headers: Vec<(String, String)> = if agent_session.is_empty() {
        Vec::new()
    } else {
        vec![("X-SecondLife-Session-ID".to_string(), agent_session)]
    };
    let body = chat_session_body(method, session_id, params, mute);
    let (pin, _) = proxy::simhost_pin(&base, "").await;
    let ex = proxy::exchange(&state.ua, "POST", &base, &body, "application/llsd+xml", &headers, pin, Duration::from_secs(30), true).await?;
    Ok(codec::llsd::parse(&ex.body, &ex.content_type).unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn sl_chat_session_accept(state: State<'_, Arc<AppState>>, session_id: String) -> Cmd {
    chat_session_post(state.inner(), "accept invitation", &session_id, &[], None).await
}

#[tauri::command]
pub async fn sl_chat_session_decline(state: State<'_, Arc<AppState>>, session_id: String) -> Cmd {
    chat_session_post(state.inner(), "decline invitation", &session_id, &[], None).await
}

#[tauri::command]
pub async fn sl_chat_session_start_conference(
    state: State<'_, Arc<AppState>>,
    temp_session_id: String,
    agent_ids: Vec<String>,
) -> Cmd {
    chat_session_post(state.inner(), "start conference", &temp_session_id, &agent_ids, None).await
}

#[tauri::command]
pub async fn sl_chat_session_invite(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    agent_ids: Vec<String>,
) -> Cmd {
    chat_session_post(state.inner(), "invite", &session_id, &agent_ids, None).await
}

#[tauri::command]
pub async fn sl_chat_session_moderate(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    agent_id: String,
    mute_text: bool,
) -> Cmd {
    chat_session_post(state.inner(), "mute update", &session_id, &[], Some((&agent_id, mute_text))).await
}

/// RemoteParcelRequest: turn a region location into a parcel id, then fire off a
/// ParcelInfoRequest so a `parcel-info` event follows (the about-land flow).
#[tauri::command]
pub async fn sl_remote_parcel(
    state: State<'_, Arc<AppState>>,
    grid_x: i64,
    grid_y: i64,
    x: f64,
    y: f64,
    z: f64,
) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let cap = session.cap("RemoteParcelRequest").ok_or("RemoteParcelRequest capability unavailable")?;
    let handle: u64 = ((grid_x.max(0) as u64) * 256 << 32) | ((grid_y.max(0) as u64) * 256);
    let handle_b64 = base64::engine::general_purpose::STANDARD.encode(handle.to_be_bytes());
    // region_handle is a 64-bit value, so it goes out as LLSD binary; a 32-bit <integer> would overflow.
    let body = format!(
        "<?xml version=\"1.0\"?><llsd><map><key>location</key><array><real>{x}</real><real>{y}</real><real>{z}</real></array><key>region_handle</key><binary encoding=\"base64\">{handle_b64}</binary></map></llsd>"
    );
    let (pin, _) = proxy::simhost_pin(&cap, "").await;
    let ex = proxy::exchange(&state.ua, "POST", &cap, &body, "application/llsd+xml", &[], pin, Duration::from_secs(30), true).await?;
    let parsed = codec::llsd::parse(&ex.body, &ex.content_type).unwrap_or(Value::Null);
    let parcel_id = parsed
        .get("parcel_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if parcel_id.is_empty() {
        return Ok(json!({ "ok": false }));
    }
    if let Some((agent, sess)) = session.agent_ids() {
        session
            .send_encoded(
                "ParcelInfoRequest",
                &json!({ "AgentData": [{ "AgentID": agent, "SessionID": sess }], "Data": [{ "ParcelID": parcel_id }] }),
                true,
            )
            .await;
    }
    Ok(json!({ "ok": true, "parcelId": parcel_id }))
}

fn cap_str(v: &Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    String::new()
}

/// Fetch a richer avatar profile through the AgentProfile HTTP cap - a superset
/// of the UDP AvatarProperties path. Emits `avatar-profile` with `source: "cap"`.
#[tauri::command]
pub async fn sl_fetch_agent_profile(app: AppHandle, state: State<'_, Arc<AppState>>, avatar_id: String) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let cap = match session.cap("AgentProfile") {
        Some(c) => c,
        None => {
            crate::dlog!("AgentProfile: cap NOT present -> extended profile unavailable for {}", avatar_id);
            return Err("AgentProfile capability unavailable".into());
        }
    };
    let url = format!("{}{}", cap_endpoint(&cap), avatar_id);
    let (pin, _) = proxy::simhost_pin(&url, "").await;
    let ex = match proxy::exchange(&state.ua, "GET", &url, "", "application/llsd+xml", &[], pin, Duration::from_secs(30), true).await {
        Ok(e) => {
            crate::dlog!("AgentProfile {}: HTTP {} ({} bytes, ct={})", avatar_id, e.status, e.body.len(), e.content_type);
            e
        }
        Err(e) => {
            crate::dlog!("AgentProfile {}: request error: {}", avatar_id, e);
            return Err(e);
        }
    };
    // The cap replies in either JSON or LLSD, so try JSON first and fall back to LLSD-XML.
    let data: Value = serde_json::from_str(&ex.body).unwrap_or_else(|_| codec::llsd::parse(&ex.body, &ex.content_type).unwrap_or(Value::Null));
    if !data.is_object() {
        crate::dlog!("AgentProfile {}: body did not parse to an object", avatar_id);
        return Ok(json!({ "ok": false }));
    }
    let id = {
        let i = cap_str(&data, &["id", "agent_id"]);
        if i.is_empty() { avatar_id.clone() } else { i }
    };
    let about = cap_str(&data, &["sl_about_text", "about_text", "about"]);
    // Log the cap's field names once so we can pin down the exact keys for
    // account status / caption, which vary across the profile cap versions.
    if let Some(obj) = data.as_object() {
        crate::dlog!(
            "AgentProfile {}: keys=[{}] aboutLen={}",
            id,
            obj.keys().cloned().collect::<Vec<_>>().join(","),
            about.len()
        );
    }
    let profile = json!({
        "avatarId": id,
        "imageId": cap_str(&data, &["sl_image_id", "image_id"]),
        "flImageId": cap_str(&data, &["fl_image_id"]),
        "partnerId": cap_str(&data, &["partner_id"]),
        "about": about,
        "flAbout": cap_str(&data, &["fl_about_text", "fl_about"]),
        "bornOn": cap_str(&data, &["member_since", "born_on"]),
        "hideAge": data.get("hide_age").and_then(|v| v.as_bool()).unwrap_or(false),
        "profileUrl": cap_str(&data, &["profile_url"]),
        "userName": cap_str(&data, &["username", "user_name", "legacy_name"]),
        "displayName": if is_display_name_default(&data) { String::new() } else { cap_str(&data, &["display_name"]) },
        // Account status / caption. The field names vary, so the diagnostic above
        // confirms the real keys; these candidates cover the variants we know of.
        "customerType": cap_str(&data, &["customer_type", "account_level", "account_type"]),
        "caption": cap_str(&data, &["charter_member", "caption", "account_caption"]),
        "source": "cap",
    });
    let _ = app.emit("minibee-viewer://avatar-profile", profile);
    Ok(json!({ "ok": true }))
}

/// Assess a region's capability health for the degraded-features banner. It's
/// pure (no I/O) so it can be unit-tested; `emit_caps_status` wraps it and does
/// the actual emit. Returns `(ok, title, detail)`, where `ok: true` means healthy
/// (clear the banner).
///
/// `caps` is `None` when the seed / region cap fetch itself failed - a total
/// failure where nothing works - and `Some(map)` after a successful fetch, where
/// an individual cap may still be missing.
fn assess_caps(caps: Option<&std::collections::HashMap<String, String>>) -> (bool, &'static str, String) {
    let has = |name: &str| caps.map_or(false, |m| m.get(name).map_or(false, |v| !v.trim().is_empty()));
    let cap_count = caps.map_or(0, |m| m.len());

    // Non-fatal caps: losing one degrades a specific feature rather than the whole
    // session, so we name them and the banner can tell the user what won't work.
    let mut minor: Vec<&str> = Vec::new();
    if !has("GetDisplayNames") {
        minor.push("resident names");
    }
    if !has("RemoteParcelRequest") {
        minor.push("land / parcel info");
    }

    if cap_count == 0 {
        (
            false,
            "Region features failed to load",
            "Couldn't fetch this region's capabilities. Teleports, resident names, land info \
             and live updates won't work here. Try logging in again."
                .to_string(),
        )
    } else if !has("EventQueueGet") {
        (
            false,
            "Live updates unavailable",
            "The region's event channel didn't come up. Teleports, incoming IMs and land \
             updates may not arrive until you relog."
                .to_string(),
        )
    } else if !minor.is_empty() {
        (
            false,
            "Some region features unavailable",
            format!("These may not work in this region: {}.", minor.join(", ")),
        )
    } else {
        (true, "", String::new())
    }
}

/// Emit a capability-health status to the WebView so it can raise or clear the
/// degraded-features banner. We call this every time a region's caps are
/// (re)established - at login and on every region cross - which keeps the banner a
/// pure function of the latest assessment: a healthy result clears any stale
/// warning left over from an earlier region or a failed session.
pub fn emit_caps_status(app: &AppHandle, caps: Option<&std::collections::HashMap<String, String>>, source: &str) {
    let (ok, title, detail) = assess_caps(caps);
    let _ = app.emit(
        "minibee-viewer://caps-status",
        json!({
            "ok": ok,
            "capCount": caps.map_or(0, |m| m.len()),
            "eventQueue": caps.map_or(false, |m| m.get("EventQueueGet").map_or(false, |v| !v.trim().is_empty())),
            "title": title,
            "detail": detail,
            "source": source,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_session_body_accept() {
        let b = chat_session_body("accept invitation", "abc", &[], None);
        assert!(b.contains("<string>accept invitation</string>"));
        assert!(b.contains("<uuid>abc</uuid>"));
    }

    #[test]
    fn chat_session_body_conference_params() {
        let b = chat_session_body("start conference", "t1", &["a".into(), "b".into()], None);
        assert!(b.contains("<array><uuid>a</uuid><uuid>b</uuid></array>"));
    }

    #[test]
    fn chat_session_body_mute() {
        let b = chat_session_body("mute update", "s", &[], Some(("agent1", true)));
        assert!(b.contains("mute_info"));
        assert!(b.contains("<boolean>1</boolean>"));
    }

    #[test]
    fn label_prefers_display_name() {
        let row = json!({
            "id": "x", "username": "ruth.resident", "display_name": "Ruthie",
            "is_display_name_default": false, "legacy_first_name": "Ruth", "legacy_last_name": "Resident"
        });
        assert_eq!(name_parts(&row).2,"Ruthie");
    }

    #[test]
    fn label_falls_back_to_username_when_default() {
        let row = json!({
            "id": "x", "username": "bob.resident", "display_name": "Bob Resident",
            "is_display_name_default": true, "legacy_first_name": "Bob", "legacy_last_name": "Resident"
        });
        assert_eq!(name_parts(&row).2,"bob.resident");
    }

    #[test]
    fn label_legacy_name_when_no_username() {
        let row = json!({ "id": "x", "legacy_first_name": "Alice", "legacy_last_name": "Wonder", "is_display_name_default": true });
        assert_eq!(name_parts(&row).2,"Alice Wonder");
    }

    #[test]
    fn cap_endpoint_adds_slash() {
        assert_eq!(cap_endpoint("https://x/cap/a"), "https://x/cap/a/");
        assert_eq!(cap_endpoint("https://x/cap/a/"), "https://x/cap/a/");
    }

    #[test]
    fn name_parts_splits_display_and_username() {
        let row = json!({
            "id": "x", "username": "ruth.resident", "display_name": "Ruthie",
            "is_display_name_default": false, "legacy_first_name": "Ruth", "legacy_last_name": "Resident"
        });
        assert_eq!(name_parts(&row), ("Ruthie".into(), "ruth.resident".into(), "Ruthie".into()));
        // A default display name gives no display, so the label falls back to username.
        let row2 = json!({ "id": "y", "username": "bob.resident", "display_name": "Bob Resident", "is_display_name_default": true });
        assert_eq!(name_parts(&row2), (String::new(), "bob.resident".into(), "bob.resident".into()));
    }

    fn caps_from(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn assess_no_caps_is_total_failure() {
        let (ok, title, _) = assess_caps(None);
        assert!(!ok);
        assert_eq!(title, "Region features failed to load");
        let empty = caps_from(&[]);
        assert_eq!(assess_caps(Some(&empty)).1, "Region features failed to load");
    }

    #[test]
    fn assess_missing_event_queue_warns() {
        let caps = caps_from(&[("GetDisplayNames", "http://x/n"), ("RemoteParcelRequest", "http://x/p")]);
        let (ok, title, _) = assess_caps(Some(&caps));
        assert!(!ok);
        assert_eq!(title, "Live updates unavailable");
    }

    #[test]
    fn assess_blank_event_queue_url_counts_as_missing() {
        // A cap key that's present but has an empty URL still isn't usable.
        let caps = caps_from(&[("EventQueueGet", "   "), ("GetDisplayNames", "http://x/n"), ("RemoteParcelRequest", "http://x/p")]);
        assert_eq!(assess_caps(Some(&caps)).1, "Live updates unavailable");
    }

    #[test]
    fn assess_minor_missing_is_named() {
        let caps = caps_from(&[("EventQueueGet", "http://x/eq"), ("RemoteParcelRequest", "http://x/p")]);
        let (ok, title, detail) = assess_caps(Some(&caps));
        assert!(!ok);
        assert_eq!(title, "Some region features unavailable");
        assert!(detail.contains("resident names"));
        assert!(!detail.contains("land / parcel info"));
    }

    #[test]
    fn assess_full_caps_is_healthy() {
        let caps = caps_from(&[
            ("EventQueueGet", "http://x/eq"),
            ("GetDisplayNames", "http://x/n"),
            ("RemoteParcelRequest", "http://x/p"),
        ]);
        let (ok, title, detail) = assess_caps(Some(&caps));
        assert!(ok);
        assert!(title.is_empty());
        assert!(detail.is_empty());
    }
}
