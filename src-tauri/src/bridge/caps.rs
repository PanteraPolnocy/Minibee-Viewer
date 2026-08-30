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
pub(crate) fn cap_endpoint(url: &str) -> String {
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
/// engine name cache (emits `names-updated`). Falls back to UDP when the cap is
/// missing or individual ids are unresolved.
pub(crate) async fn resolve_display_names(
    app: &AppHandle,
    state: &Arc<AppState>,
    session: &Arc<crate::bridge::circuit::Session>,
    ids: &[String],
) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let cap = match session.cap("GetDisplayNames") {
        Some(u) => u,
        None => {
            session.request_uuid_names(ids).await;
            return Ok(());
        }
    };
    let base = cap_endpoint(&cap);
    let agent_session = session.agent_ids().map(|(_, s)| s).unwrap_or_default();
    let headers: Vec<(String, String)> = if agent_session.is_empty() {
        Vec::new()
    } else {
        vec![("X-SecondLife-Session-ID".to_string(), agent_session)]
    };

    let mut resolved: Vec<(String, String)> = Vec::new();
    let mut rich: Vec<Value> = Vec::new();
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
    if !bad_ids.is_empty() {
        session.request_uuid_names(&bad_ids).await;
    }
    crate::dlog!(
        "GetDisplayNames: requested={} resolved={} fellBackToUdp={} sample=[{}]",
        ids.len(),
        resolved.len(),
        bad_ids.len(),
        sample
    );
    Ok(())
}

#[tauri::command]
pub async fn sl_resolve_display_names(app: AppHandle, state: State<'_, Arc<AppState>>, ids: Vec<String>) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    resolve_display_names(&app, state.inner(), &session, &ids).await?;
    Ok(json!({ "ok": true, "requested": ids.len() }))
}

fn xml_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Read-only summary of a parcel's (or the region's, local_id <= 0)
/// environment through the ExtEnvironment cap.
#[tauri::command]
pub async fn sl_parcel_environment(state: State<'_, Arc<AppState>>, local_id: i64) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let cap = session
        .cap("ExtEnvironment")
        .ok_or("Environment capability unavailable")?;
    let url = if local_id > 0 {
        format!("{}?parcelid={}", cap.trim_end_matches('/'), local_id)
    } else {
        cap
    };
    let (pin, _) = proxy::simhost_pin(&url, "").await;
    let ex = proxy::exchange(&state.ua, "GET", &url, "", "application/llsd+xml", &[], pin, Duration::from_secs(30), true).await?;
    if !(200..300).contains(&ex.status) {
        return Err(format!("Environment fetch failed (HTTP {}).", ex.status));
    }
    let parsed = codec::llsd::parse(&ex.body, &ex.content_type).unwrap_or(Value::Null);
    let env = parsed.get("environment").cloned().unwrap_or(Value::Null);
    let day_name = env
        .get("day_names")
        .and_then(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Array(a) => a.iter().filter_map(|x| x.as_str()).find(|s| !s.is_empty()).map(String::from),
            _ => None,
        })
        .or_else(|| env.get("day_cycle").and_then(|d| d.get("name")).and_then(|v| v.as_str()).map(String::from))
        .unwrap_or_default();
    Ok(json!({
        "ok": true,
        // Absent means "uses the region default" per the cap's contract.
        "isDefault": env.get("is_default").and_then(|v| v.as_bool()).unwrap_or(true),
        "dayName": day_name,
        "dayLength": env.get("day_length").and_then(|v| v.as_i64()).unwrap_or(-1),
        "dayOffset": env.get("day_offset").and_then(|v| v.as_i64()).unwrap_or(-1),
        "trackAltitudes": env.get("track_altitudes").cloned().unwrap_or(json!([])),
        "envVersion": env.get("env_version").and_then(|v| v.as_i64()).unwrap_or(-2),
    }))
}

/// Resolve experience names for the Experiences tab through GetExperienceInfo.
/// Returns `{ names: { id: name } }`; unknown ids are simply absent.
#[tauri::command]
pub async fn sl_experience_names(state: State<'_, Arc<AppState>>, ids: Vec<String>) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let cap = session
        .cap("GetExperienceInfo")
        .ok_or("Experience capability unavailable")?;
    let mut names = serde_json::Map::new();
    for chunk in ids.chunks(20) {
        let query = chunk
            .iter()
            .filter(|id| !id.is_empty())
            .map(|id| format!("public_id={}", urlencoding::encode(id)))
            .collect::<Vec<_>>()
            .join("&");
        if query.is_empty() {
            continue;
        }
        // The by-id lookup lives under the cap's `id/` sub-path; the bare cap
        // does not answer public_id queries.
        let url = format!("{}id/?page_size=20&{}", cap_endpoint(&cap), query);
        let (pin, _) = proxy::simhost_pin(&url, "").await;
        let ex = match proxy::exchange(&state.ua, "GET", &url, "", "application/llsd+xml", &[], pin, Duration::from_secs(30), true).await {
            Ok(e) if (200..300).contains(&e.status) => e,
            _ => continue,
        };
        let parsed = codec::llsd::parse(&ex.body, &ex.content_type).unwrap_or(Value::Null);
        if let Some(rows) = parsed.get("experience_keys").and_then(|v| v.as_array()) {
            for row in rows {
                let id = row.get("public_id").and_then(|v| v.as_str()).unwrap_or("");
                let name = row.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if !id.is_empty() && !name.is_empty() {
                    names.insert(id.to_string(), json!(name));
                }
            }
        }
    }
    Ok(json!({ "ok": true, "names": names }))
}

/// Minimal LLSD-XML writer for the values a parcel save needs.
///
/// Only the shapes the ParcelPropertiesUpdate body actually uses. LLSD has no
/// unsigned 32-bit type, so a U32 travels as a 4-byte big-endian binary blob -
/// that is the only representation it has, and a sim reading
/// `parcel_flags` as anything else would misread every option on the parcel.
pub(crate) mod llsd_xml {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;

    pub fn string(v: &str) -> String {
        format!("<string>{}</string>", super::xml_text(v))
    }
    pub fn integer(v: i64) -> String {
        format!("<integer>{v}</integer>")
    }
    pub fn real(v: f64) -> String {
        // Non-finite values have no LLSD spelling; 0 is the safe stand-in.
        let n = if v.is_finite() { v } else { 0.0 };
        format!("<real>{n}</real>")
    }
    pub fn boolean(v: bool) -> String {
        format!("<boolean>{}</boolean>", if v { 1 } else { 0 })
    }
    pub fn uuid(v: &str) -> String {
        let id = v.trim();
        let id = if id.is_empty() { "00000000-0000-0000-0000-000000000000" } else { id };
        format!("<uuid>{}</uuid>", super::xml_text(id))
    }
    /// A U32 as LLSD carries one: 4 bytes, network order, base64.
    pub fn u32_binary(v: u32) -> String {
        format!(
            "<binary encoding=\"base64\">{}</binary>",
            B64.encode(v.to_be_bytes())
        )
    }
    pub fn vector3(v: [f64; 3]) -> String {
        format!("<array>{}{}{}</array>", real(v[0]), real(v[1]), real(v[2]))
    }
    /// Wrap `<key>value</key>` pairs into a complete LLSD document.
    pub fn map(pairs: &[(&str, String)]) -> String {
        let body: String = pairs
            .iter()
            .map(|(k, v)| format!("<key>{}</key>{}", super::xml_text(k), v))
            .collect();
        format!("<?xml version=\"1.0\"?><llsd><map>{body}</map></llsd>")
    }
}

/// Build the ParcelPropertiesUpdate capability body.
///
/// This mirrors `LLParcel::packMessage(LLSD&)` key for key, and it has to: the
/// capability replaces the parcel wholesale, so anything omitted or defaulted
/// here is a setting quietly wiped off the land. Everything is taken from the
/// parcel the sim last sent us (`p`), with the form's edits already folded in
/// by the caller - the same baseline discipline the UDP path uses.
///
/// `message_flags` is 0x01, which is what the sim expects here.
pub(crate) fn parcel_update_body(p: &Value, folded_flags: u32, landing: [f64; 3], look_at: [f64; 3]) -> String {
    let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let i = |k: &str| p.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    let f = |k: &str| p.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let b = |k: &str| p.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    // The avatar visibility/sound trio defaults to allowed when absent.
    let b_allowed = |k: &str| p.get(k).and_then(|v| v.as_bool()).unwrap_or(true);

    llsd_xml::map(&[
        ("flags", llsd_xml::u32_binary(0x01)),
        ("local_id", llsd_xml::integer(i("localId"))),
        ("parcel_flags", llsd_xml::u32_binary(folded_flags)),
        ("sale_price", llsd_xml::integer(i("salePrice"))),
        ("name", llsd_xml::string(&s("name"))),
        ("description", llsd_xml::string(&s("desc"))),
        ("music_url", llsd_xml::string(&s("musicUrl"))),
        ("media_url", llsd_xml::string(&s("mediaUrl"))),
        ("media_desc", llsd_xml::string(&s("mediaDesc"))),
        ("media_type", llsd_xml::string(&s("mediaType"))),
        ("media_width", llsd_xml::integer(i("mediaWidth"))),
        ("media_height", llsd_xml::integer(i("mediaHeight"))),
        ("auto_scale", llsd_xml::integer(i("mediaAutoScale"))),
        ("media_loop", llsd_xml::integer(i("mediaLoop"))),
        ("media_current_url", llsd_xml::string(&s("mediaCurrentUrl"))),
        // Obsolete, but the sim still expects both keys in the body.
        ("obscure_media", llsd_xml::boolean(false)),
        ("obscure_music", llsd_xml::boolean(false)),
        ("media_id", llsd_xml::uuid(&s("mediaId"))),
        ("media_allow_navigate", llsd_xml::boolean(b("mediaAllowNavigate"))),
        ("media_prevent_camera_zoom", llsd_xml::boolean(b("mediaPreventCameraZoom"))),
        ("media_url_timeout", llsd_xml::real(f("mediaUrlTimeout"))),
        ("group_id", llsd_xml::uuid(&s("groupId"))),
        ("pass_price", llsd_xml::integer(i("passPrice"))),
        ("pass_hours", llsd_xml::real(f("passHours"))),
        ("category", llsd_xml::integer(i("category"))),
        ("auth_buyer_id", llsd_xml::uuid(&s("authBuyerId"))),
        ("snapshot_id", llsd_xml::uuid(&s("snapshotId"))),
        ("user_location", llsd_xml::vector3(landing)),
        ("user_look_at", llsd_xml::vector3(look_at)),
        ("landing_type", llsd_xml::integer(i("landingType"))),
        ("see_avs", llsd_xml::boolean(b_allowed("seeAvs"))),
        ("group_av_sounds", llsd_xml::boolean(b_allowed("groupAvSounds"))),
        ("any_av_sounds", llsd_xml::boolean(b_allowed("anyAvSounds"))),
        ("obscure_moap", llsd_xml::boolean(b("obscureMoap"))),
    ])
}

/// Save a parcel through the ParcelPropertiesUpdate capability.
///
/// Preferred over the UDP message because the UDP form physically cannot carry
/// see_avs / the avatar-sound pair / obscure_moap - they exist only in this
/// body. Callers fall back to UDP when a region offers no such capability.
pub(crate) async fn update_parcel_via_cap(
    state: &Arc<AppState>,
    session: &Arc<crate::bridge::circuit::Session>,
    body: &str,
) -> Result<(), String> {
    let cap = session
        .cap("ParcelPropertiesUpdate")
        .ok_or("ParcelPropertiesUpdate capability unavailable")?;
    let (pin, _) = proxy::simhost_pin(&cap, "").await;
    let ex = proxy::exchange(
        &state.ua,
        "POST",
        &cap,
        body,
        "application/llsd+xml",
        &[],
        pin,
        Duration::from_secs(30),
        true,
    )
    .await?;
    if (200..300).contains(&ex.status) {
        crate::dlog!("parcel: saved via ParcelPropertiesUpdate cap (HTTP {})", ex.status);
        Ok(())
    } else {
        crate::dlog!("parcel: cap save REFUSED: HTTP {} body={:.200}", ex.status, ex.body);
        Err(format!("The server refused the parcel update (HTTP {}).", ex.status))
    }
}

/// The LLSD body for a notes save: a single-key map - the cap applies partial
/// updates, so only the field being changed is sent.
pub(crate) fn notes_put_body(notes: &str) -> String {
    format!(
        "<?xml version=\"1.0\"?><llsd><map><key>notes</key><string>{}</string></map></llsd>",
        xml_text(notes)
    )
}

/// Save the private notes about `target_id`: PUT <AgentProfile cap>/<target>
/// with `{"notes": ...}`. This is the only save path Second Life still
/// honours - the AvatarNotesUpdate UDP message is OpenSim-only legacy - and a
/// refused PUT must surface as an error, never as a fake "saved".
pub(crate) async fn save_avatar_notes(
    state: &Arc<AppState>,
    session: &Arc<crate::bridge::circuit::Session>,
    target_id: &str,
    notes: &str,
) -> Result<(), String> {
    let cap = session
        .cap("AgentProfile")
        .ok_or("AgentProfile capability unavailable")?;
    let url = format!("{}{}", cap_endpoint(&cap), target_id);
    let body = notes_put_body(notes);
    let (pin, _) = proxy::simhost_pin(&url, "").await;
    let ex = proxy::exchange(
        &state.ua,
        "PUT",
        &url,
        &body,
        "application/llsd+xml",
        &[],
        pin,
        Duration::from_secs(30),
        true,
    )
    .await?;
    if (200..300).contains(&ex.status) {
        crate::dlog!("notes: saved for {} via AgentProfile cap (HTTP {})", target_id, ex.status);
        Ok(())
    } else {
        crate::dlog!("notes: save for {} REFUSED: HTTP {} body={:.200}", target_id, ex.status, ex.body);
        Err(format!("The server refused the notes update (HTTP {}).", ex.status))
    }
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

/// Ask the sim for a 360-degree interest list. Returns true when the cap was granted
/// and the POST succeeded.
pub(crate) async fn interest_list_360(state: &Arc<AppState>, session: &Arc<crate::bridge::circuit::Session>) -> bool {
    let url = match session.cap("InterestList") {
        Some(u) => u,
        None => {
            crate::dlog!(
                "InterestList cap NOT GRANTED - object updates stay culled to a camera frustum, \
                 so the nearby list will be incomplete (worst at altitude)"
            );
            return false;
        }
    };
    let body = "<?xml version=\"1.0\"?><llsd><map><key>mode</key><string>360</string></map></llsd>";
    let (pin, _) = proxy::simhost_pin(&url, "").await;
    match proxy::exchange(
        &state.ua,
        "POST",
        &url,
        body,
        "application/llsd+xml",
        &[],
        pin,
        Duration::from_secs(15),
        true,
    )
    .await
    {
        Ok(ex) if (200..300).contains(&ex.status) => {
            crate::dlog!("interest list set to 360 (HTTP {})", ex.status);
            true
        }
        Ok(ex) => {
            crate::dlog!(
                "InterestList POST refused: HTTP {} body={:.200} url={}",
                ex.status,
                ex.body,
                url
            );
            false
        }
        Err(e) => {
            crate::dlog!("InterestList POST failed: {e} url={url}");
            false
        }
    }
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
    // matched by exact path, so a trailing slash misroutes the request.
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
/// Extra detail for one object, gathered only when the user opens the detail view.
pub async fn sl_object_extra(state: State<'_, Arc<AppState>>, object_id: String) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    if object_id.is_empty() {
        return Err("No object".into());
    }
    let mut out = json!({ "ok": true, "id": object_id });

    if let Some(cap) = session.cap("GetObjectCost") {
        let body = format!(
            "<?xml version=\"1.0\"?><llsd><map><key>object_ids</key><array><uuid>{object_id}</uuid></array></map></llsd>"
        );
        let (pin, _) = proxy::simhost_pin(&cap, "").await;
        if let Ok(ex) = proxy::exchange(
            &state.ua, "POST", &cap, &body, "application/llsd+xml", &[], pin,
            Duration::from_secs(20), true,
        )
        .await
        {
            let parsed = codec::llsd::parse(&ex.body, &ex.content_type).unwrap_or(Value::Null);
            if let Some(row) = parsed.get(&object_id).or_else(|| {
                // Some sims echo the id in a different case than we sent.
                parsed.as_object().and_then(|m| {
                    m.iter()
                        .find(|(k, _)| k.eq_ignore_ascii_case(&object_id))
                        .map(|(_, v)| v)
                })
            }) {
                let num = |k: &str| row.get(k).and_then(|v| v.as_f64());
                if let Some(o) = out.as_object_mut() {
                    if let Some(v) = num("linked_set_resource_cost") {
                        o.insert("landImpact".into(), json!(v.round()));
                    }
                    if let Some(v) = num("resource_cost") {
                        o.insert("objectCost".into(), json!(v.round()));
                    }
                    if let Some(v) = num("linked_set_physics_cost") {
                        o.insert("physicsCost".into(), json!((v * 10.0).round() / 10.0));
                    }
                }
            }
        }
    }

    if let Some(cap) = session.cap("ObjectMedia") {
        let body = format!(
            "<?xml version=\"1.0\"?><llsd><map><key>verb</key><string>GET</string><key>object_id</key><uuid>{object_id}</uuid></map></llsd>"
        );
        let (pin, _) = proxy::simhost_pin(&cap, "").await;
        if let Ok(ex) = proxy::exchange(
            &state.ua, "POST", &cap, &body, "application/llsd+xml", &[], pin,
            Duration::from_secs(20), true,
        )
        .await
        {
            let parsed = codec::llsd::parse(&ex.body, &ex.content_type).unwrap_or(Value::Null);
            let mut urls: Vec<String> = Vec::new();
            if let Some(faces) = parsed.get("object_media_data").and_then(|v| v.as_array()) {
                for (face, entry) in faces.iter().enumerate() {
                    for key in ["current_url", "home_url"] {
                        let url = entry.get(key).and_then(|v| v.as_str()).unwrap_or("").trim();
                        if url.is_empty() {
                            continue;
                        }
                        let label = format!("{face}|{url}");
                        if !urls.iter().any(|u| u.ends_with(url)) {
                            urls.push(label);
                        }
                        break;
                    }
                }
            }
            if let Some(o) = out.as_object_mut() {
                o.insert("media".into(), json!(urls));
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn sl_remote_parcel(
    state: State<'_, Arc<AppState>>,
    grid_x: i64,
    grid_y: i64,
    x: f64,
    y: f64,
    z: f64,
    region_id: Option<String>,
) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let cap = session.cap("RemoteParcelRequest").ok_or("RemoteParcelRequest capability unavailable")?;
    // A landmark knows its region only by id; everything else names it by grid
    // position. region_handle is a 64-bit value, so it goes out as LLSD binary;
    // a 32-bit <integer> would overflow.
    let region = match region_id.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(id) if crate::bridge::inventory::is_uuid(id) => format!("<key>region_id</key><uuid>{id}</uuid>"),
        Some(_) => return Err("Invalid region id".into()),
        None => {
            let handle: u64 = ((grid_x.max(0) as u64) * 256 << 32) | ((grid_y.max(0) as u64) * 256);
            let handle_b64 = base64::engine::general_purpose::STANDARD.encode(handle.to_be_bytes());
            format!("<key>region_handle</key><binary encoding=\"base64\">{handle_b64}</binary>")
        }
    };
    let body = format!(
        "<?xml version=\"1.0\"?><llsd><map><key>location</key><array><real>{x}</real><real>{y}</real><real>{z}</real></array>{region}</map></llsd>"
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
    // A reply about somebody else must not be filed under the requested id -
    // notes especially, where a mixup could later overwrite the wrong person's
    // notes.
    if !id.eq_ignore_ascii_case(avatar_id.trim()) {
        crate::dlog!("AgentProfile {}: reply carries mismatched id {} - discarded", avatar_id, id);
        return Ok(json!({ "ok": false }));
    }
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
    let mut profile = json!({
        "avatarId": id,
        "hideAge": data.get("hide_age").and_then(|v| v.as_bool()).unwrap_or(false),
        // Sent even when empty, because empty is the answer: it means this
        // resident has no display name of their own and the username stands in.
        "displayName": if is_display_name_default(&data) { String::new() } else { cap_str(&data, &["display_name"]) },
        "source": "cap",
    });
    // Everything else is carried ONLY when the reply actually answered it.
    //
    // `cap_str` cannot tell an absent key from an empty one - both come back as
    // "" - and the profile cache merges an incoming reply over what it already
    // holds. So sending "" for a key this reply simply lacked erases whatever the
    // UDP path already supplied. That is how avatar and group pictures appeared
    // and then vanished a moment later: UDP delivered the image id, then this
    // slower HTTP reply overwrote it with nothing.
    //
    // Account status / caption field names vary between cap versions, so the
    // diagnostic above confirms the real keys; these candidates cover the
    // variants we know of.
    for (key, val) in [
        ("imageId", cap_str(&data, &["sl_image_id", "image_id"])),
        ("flImageId", cap_str(&data, &["fl_image_id"])),
        ("partnerId", cap_str(&data, &["partner_id"])),
        ("about", about.clone()),
        ("flAbout", cap_str(&data, &["fl_about_text", "fl_about"])),
        ("bornOn", cap_str(&data, &["member_since", "born_on"])),
        ("profileUrl", cap_str(&data, &["profile_url"])),
        ("userName", cap_str(&data, &["username", "user_name", "legacy_name"])),
        ("customerType", cap_str(&data, &["customer_type", "account_level", "account_type"])),
        ("caption", cap_str(&data, &["charter_member", "caption", "account_caption"])),
    ] {
        if !val.is_empty() {
            profile[key] = json!(val);
        }
    }
    // Only claim authority over the notes when the cap actually carried them;
    // otherwise the legacy AvatarNotesReply stays the path they arrive on.
    if let Some(n) = data.get("notes").and_then(|v| v.as_str()) {
        profile["notes"] = json!(n);
        session.mark_cap_notes(&id);
    } else {
        crate::dlog!("AgentProfile {}: no notes key - leaving notes to the legacy reply", id);
    }
    let _ = app.emit("minibee-viewer://avatar-profile", profile);
    if let Some(rows) = data.get("groups").and_then(|v| v.as_array()) {
        let groups: Vec<Value> = rows
            .iter()
            .filter_map(|g| {
                let gid = cap_str(g, &["group_id", "id"]);
                let name = cap_str(g, &["group_name", "name"]);
                if gid.is_empty() || name.is_empty() {
                    return None;
                }
                Some(json!({
                    "id": gid,
                    "name": name,
                    "insigniaId": cap_str(g, &["group_insignia", "insignia_id", "group_insignia_id"]),
                    "powers": cap_str(g, &["group_powers", "powers"]),
                    // The cap says whether it's hidden from the profile; assume
                    // visible when it doesn't mention it.
                    "listInProfile": g
                        .get("list_in_profile")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true),
                }))
            })
            .collect();
        crate::dlog!("AgentProfile {}: {} group(s) from cap", id, groups.len());
        if !groups.is_empty() {
            let _ = app.emit(
                "minibee-viewer://avatar-groups",
                json!({ "avatarId": id, "groups": groups }),
            );
        }
    }
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

    /// A full parcel as the sim describes it, for the save round-trip tests.
    fn parcel_fixture() -> Value {
        json!({
            "localId": 42, "salePrice": 1500, "name": "Beach ", "desc": "nice & <cosy>",
            "musicUrl": "http://x/s.mp3", "mediaUrl": "http://x/v.mp4",
            "mediaDesc": "clip", "mediaType": "video/mp4",
            "mediaWidth": 640, "mediaHeight": 480, "mediaAutoScale": 1, "mediaLoop": 1,
            "mediaCurrentUrl": "http://x/now", "mediaId": "aaaaaaaa-0000-0000-0000-000000000001",
            "mediaAllowNavigate": true, "mediaPreventCameraZoom": false, "mediaUrlTimeout": 12.5,
            "groupId": "bbbbbbbb-0000-0000-0000-000000000002", "passPrice": 25, "passHours": 1.5,
            "category": 3, "authBuyerId": "", "snapshotId": "cccccccc-0000-0000-0000-000000000003",
            "landingType": 2,
            "seeAvs": false, "groupAvSounds": false, "anyAvSounds": false, "obscureMoap": true,
        })
    }

    #[test]
    fn parcel_body_carries_every_expected_field() {
        let body = parcel_update_body(&parcel_fixture(), 0x8000_0001, [1.5, 2.5, 3.5], [1.0, 0.0, 0.0]);
        // Every key the ParcelPropertiesUpdate cap accepts, plus the message flags.
        for key in [
            "flags", "local_id", "parcel_flags", "sale_price", "name", "description",
            "music_url", "media_url", "media_desc", "media_type", "media_width",
            "media_height", "auto_scale", "media_loop", "media_current_url",
            "obscure_media", "obscure_music", "media_id", "media_allow_navigate",
            "media_prevent_camera_zoom", "media_url_timeout", "group_id", "pass_price",
            "pass_hours", "category", "auth_buyer_id", "snapshot_id", "user_location",
            "user_look_at", "landing_type", "see_avs", "group_av_sounds", "any_av_sounds",
            "obscure_moap",
        ] {
            assert!(body.contains(&format!("<key>{key}</key>")), "missing key: {key}");
        }
    }

    #[test]
    fn parcel_body_packs_u32_flags_as_network_order_binary() {
        // LLSD has no U32; it travels as 4 big-endian bytes. Getting this
        // wrong would misread every option bit on the parcel.
        let body = parcel_update_body(&parcel_fixture(), 0x8000_0001, [0.0; 3], [0.0; 3]);
        // 0x80000001 -> 80 00 00 01
        assert!(body.contains("<binary encoding=\"base64\">gAAAAQ==</binary>"), "{body}");
        // message flags 0x01 -> 00 00 00 01
        assert!(body.contains("<binary encoding=\"base64\">AAAAAQ==</binary>"), "{body}");
    }

    #[test]
    fn parcel_body_preserves_values_verbatim_and_escapes_xml() {
        let body = parcel_update_body(&parcel_fixture(), 0, [1.5, 2.5, 3.5], [1.0, 0.0, 0.0]);
        // A trailing space in the name must survive untouched.
        assert!(body.contains("<key>name</key><string>Beach </string>"), "{body}");
        // Markup in free text is escaped, never injected.
        assert!(body.contains("nice &amp; &lt;cosy&gt;"), "{body}");
        // Media settings the UI never shows still round-trip.
        assert!(body.contains("<key>media_width</key><integer>640</integer>"));
        assert!(body.contains("<key>media_loop</key><integer>1</integer>"));
        assert!(body.contains("<key>media_url_timeout</key><real>12.5</real>"));
        // An empty UUID becomes the null id, not an empty element.
        assert!(body.contains("<key>auth_buyer_id</key><uuid>00000000-0000-0000-0000-000000000000</uuid>"));
        // The landing vectors keep full precision.
        assert!(body.contains("<key>user_location</key><array><real>1.5</real><real>2.5</real><real>3.5</real></array>"));
    }

    #[test]
    fn parcel_body_defaults_the_avatar_trio_to_allowed_when_absent() {
        // Sims that never sent SeeAVs/AnyAVSounds/GroupAVSounds leave them out;
        // saving must not read that silence as "deny".
        let body = parcel_update_body(&json!({ "localId": 1 }), 0, [0.0; 3], [0.0; 3]);
        assert!(body.contains("<key>see_avs</key><boolean>1</boolean>"), "{body}");
        assert!(body.contains("<key>any_av_sounds</key><boolean>1</boolean>"), "{body}");
        assert!(body.contains("<key>group_av_sounds</key><boolean>1</boolean>"), "{body}");
        // ...while the explicit false from the sim is honoured.
        let off = parcel_update_body(&parcel_fixture(), 0, [0.0; 3], [0.0; 3]);
        assert!(off.contains("<key>see_avs</key><boolean>0</boolean>"), "{off}");
        assert!(off.contains("<key>obscure_moap</key><boolean>1</boolean>"), "{off}");
    }

    #[test]
    fn cap_endpoint_adds_slash() {
        assert_eq!(cap_endpoint("https://x/cap/a"), "https://x/cap/a/");
        assert_eq!(cap_endpoint("https://x/cap/a/"), "https://x/cap/a/");
    }

    #[test]
    fn notes_put_body_is_single_key_and_escaped() {
        let body = notes_put_body("likes <cats> & \"dogs\"");
        assert_eq!(
            body,
            "<?xml version=\"1.0\"?><llsd><map><key>notes</key><string>likes &lt;cats&gt; &amp; \"dogs\"</string></map></llsd>"
        );
        assert!(notes_put_body("").contains("<string></string>"));
        let parsed = crate::codec::llsd::parse(&notes_put_body("hello"), "application/llsd+xml").unwrap();
        assert_eq!(parsed["notes"], "hello");
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
