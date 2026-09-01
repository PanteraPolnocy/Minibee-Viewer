//! WebRTC voice signalling. The WebView owns the RTCPeerConnection, the
//! microphone, and the audio; this side owns every authenticated exchange
//! with the simulator: provisioning a voice session (the SDP offer/answer
//! ride the ProvisionVoiceAccountRequest capability), trickling ICE
//! candidates (VoiceSignalingRequest), and the logout courtesy call. Spatial
//! ("local" channel) voice only, for now.
//!
//! The grid's WebRTC voice server mixes and spatialises audio server-side,
//! steered by the listener/speaker positions the client reports over the
//! WebRTC data channel - so the incoming stereo track is already spatial.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::State;

use crate::bridge::inventory::{self, xml_escape};
use crate::bridge::state::AppState;

type Cmd = Result<Value, String>;

const VOICE_SERVER_TYPE: &str = "webrtc";

/// Parcel flag bits that steer voice (llparcelflags.h).
const PF_ALLOW_VOICE_CHAT: u32 = 1 << 29;
const PF_USE_ESTATE_VOICE_CHAN: u32 = 1 << 30;

/// Which spatial channel the parcel under our feet calls for, the way the
/// standard client decides it: no voice at all when the parcel forbids it, the
/// parcel's own channel when it opts out of the estate-wide one, the estate
/// channel (no parcel id) otherwise - also the default when no parcel data
/// has arrived yet.
pub fn parcel_channel(parcel: Option<(i64, u32)>) -> Result<Option<i64>, &'static str> {
    match parcel {
        Some((_, flags)) if flags & PF_ALLOW_VOICE_CHAT == 0 => Err("Voice is not allowed on this parcel"),
        Some((local_id, flags)) if flags & PF_USE_ESTATE_VOICE_CHAN == 0 && local_id > 0 => Ok(Some(local_id)),
        _ => Ok(None),
    }
}

/// The grid's STUN pool: stunN.<grid>.secondlife.io. Agni runs three, the
/// other Linden grids two. Non-Linden grids get none (their regions would
/// have to advertise their own).
pub fn stun_servers(grid: &str) -> Vec<String> {
    let grid = grid.trim().to_ascii_lowercase();
    if grid.is_empty() || !grid.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Vec::new();
    }
    let count = if grid == "agni" {
        3
    } else if grid == "aditi" {
        2
    } else {
        return Vec::new();
    };
    (1..=count)
        .map(|i| format!("stun:stun{i}.{grid}.secondlife.io:3478"))
        .collect()
}

/// The LLSD body for a spatial-voice provision: the browser's SDP offer plus
/// the channel selection. The parcel id only rides along on parcels that use
/// their own voice channel instead of the estate-wide one.
pub fn provision_body(offer_sdp: &str, parcel_local_id: Option<i64>) -> String {
    let parcel = parcel_local_id
        .map(|id| format!("<key>parcel_local_id</key><integer>{id}</integer>"))
        .unwrap_or_default();
    format!(
        "<?xml version=\"1.0\"?><llsd><map>\
         <key>jsep</key><map><key>type</key><string>offer</string>\
         <key>sdp</key><string>{}</string></map>\
         {parcel}\
         <key>channel_type</key><string>local</string>\
         <key>voice_server_type</key><string>{VOICE_SERVER_TYPE}</string>\
         </map></llsd>",
        xml_escape(offer_sdp)
    )
}

/// The LLSD body for an ICE trickle: gathered candidates, and/or the
/// gathering-complete marker.
pub fn ice_body(viewer_session: &str, candidates: &[Value], completed: bool) -> String {
    let mut parts = String::new();
    if !candidates.is_empty() {
        let rows: String = candidates
            .iter()
            .map(|c| {
                format!(
                    "<map><key>sdpMid</key><string>{}</string>\
                     <key>sdpMLineIndex</key><integer>{}</integer>\
                     <key>candidate</key><string>{}</string></map>",
                    xml_escape(c.get("sdpMid").and_then(|v| v.as_str()).unwrap_or("")),
                    c.get("sdpMLineIndex").and_then(|v| v.as_i64()).unwrap_or(0),
                    xml_escape(c.get("candidate").and_then(|v| v.as_str()).unwrap_or("")),
                )
            })
            .collect();
        parts.push_str(&format!("<key>candidates</key><array>{rows}</array>"));
    }
    if completed {
        parts.push_str("<key>candidate</key><map><key>completed</key><boolean>1</boolean></map>");
    }
    format!(
        "<?xml version=\"1.0\"?><llsd><map>\
         {parts}\
         <key>viewer_session</key><string>{}</string>\
         <key>voice_server_type</key><string>{VOICE_SERVER_TYPE}</string>\
         </map></llsd>",
        xml_escape(viewer_session)
    )
}

/// The STUN servers for this session's grid.
#[tauri::command]
pub fn sl_voice_stun(state: State<'_, Arc<AppState>>) -> Cmd {
    let grid = state.grid.lock().unwrap().clone();
    Ok(json!({ "ok": true, "servers": stun_servers(&grid) }))
}

/// The neighbour regions whose voice endpoints are known, with their grid
/// coordinates - the frontend connects to the ones the avatar stands near.
#[tauri::command]
pub fn sl_voice_neighbours(state: State<'_, Arc<AppState>>) -> Cmd {
    let rows: Vec<Value> = state
        .neighbour_voice
        .lock()
        .unwrap()
        .iter()
        .map(|(k, (gx, gy, _, _))| json!({ "key": k, "gridX": gx, "gridY": gy }))
        .collect();
    Ok(json!({ "ok": true, "neighbours": rows }))
}

/// The voice cap URL to use: the current region's own capability, or a known
/// neighbour's endpoint when `neighbour` names one.
fn voice_cap_url(
    state: &Arc<AppState>,
    session: &Arc<crate::bridge::circuit::Session>,
    cap: &str,
    neighbour: &Option<String>,
) -> Result<String, String> {
    match neighbour {
        Some(key) => {
            let guard = state.neighbour_voice.lock().unwrap();
            let (_, _, provision, signaling) = guard.get(key).ok_or("Unknown voice neighbour")?;
            let url = if cap == "VoiceSignalingRequest" { signaling } else { provision };
            if url.is_empty() {
                return Err("The neighbour lacks that capability".into());
            }
            Ok(url.clone())
        }
        None => session.cap(cap).ok_or_else(|| "This region has no voice".into()),
    }
}

/// Ask a sim for a spatial voice session - the current region's (on the
/// parcel-local channel when the parcel under our feet calls for one, the
/// estate-wide channel otherwise), or a neighbour region's estate channel
/// when `neighbour` names one. The SDP offer goes up; the answer (and the
/// viewer_session handle every later signalling call needs) comes back.
#[tauri::command]
pub async fn sl_voice_provision(
    state: State<'_, Arc<AppState>>,
    offer: String,
    neighbour: Option<String>,
) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    if offer.trim().is_empty() || offer.len() > 128 * 1024 {
        return Err("Bad SDP offer".into());
    }
    let url = voice_cap_url(state.inner(), &session, "ProvisionVoiceAccountRequest", &neighbour)?;
    // Cross-border listening happens on the neighbour's estate channel, the
    // way the standard client connects its non-primary regions.
    let parcel_local_id = if neighbour.is_some() {
        None
    } else {
        parcel_channel(session.parcel_voice())?
    };
    let body = provision_body(&offer, parcel_local_id);
    let res = inventory::cap_post_url(state.inner(), &session, &url, &body)
        .await
        .ok_or("The voice provisioning request failed")?;
    let viewer_session = res.get("viewer_session").and_then(|v| v.as_str()).unwrap_or("");
    let jsep = res.get("jsep");
    let answer = jsep
        .filter(|j| j.get("type").and_then(|t| t.as_str()) == Some("answer"))
        .and_then(|j| j.get("sdp"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if viewer_session.is_empty() || answer.is_empty() {
        crate::dlog!("voice: bad provision response: {:.300}", res.to_string());
        return Err("The sim refused the voice session".into());
    }
    Ok(json!({
        "ok": true,
        "viewerSession": viewer_session,
        "sdp": answer,
        // Which channel this session landed on; the frontend reconnects when
        // a parcel change calls for a different one.
        "parcelLocalId": parcel_local_id,
    }))
}

/// Trickle gathered ICE candidates (and/or the completion marker) to the sim.
#[tauri::command]
pub async fn sl_voice_ice(
    state: State<'_, Arc<AppState>>,
    viewer_session: String,
    candidates: Vec<Value>,
    completed: bool,
    neighbour: Option<String>,
) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    if viewer_session.is_empty() || (candidates.is_empty() && !completed) {
        return Ok(json!({ "ok": true, "skipped": true }));
    }
    if candidates.len() > 64 {
        return Err("Too many candidates".into());
    }
    let url = voice_cap_url(state.inner(), &session, "VoiceSignalingRequest", &neighbour)?;
    let body = ice_body(&viewer_session, &candidates, completed);
    inventory::cap_post_url(state.inner(), &session, &url, &body)
        .await
        .ok_or("The voice signalling request failed")?;
    Ok(json!({ "ok": true }))
}

/// Tell the sim we're dropping a voice session, as a courtesy - closing the
/// peer connection tears it down anyway.
#[tauri::command]
pub async fn sl_voice_logout(
    state: State<'_, Arc<AppState>>,
    viewer_session: String,
    neighbour: Option<String>,
) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    if viewer_session.is_empty() {
        return Ok(json!({ "ok": true }));
    }
    let Ok(url) = voice_cap_url(state.inner(), &session, "ProvisionVoiceAccountRequest", &neighbour) else {
        return Ok(json!({ "ok": true }));
    };
    let body = format!(
        "<?xml version=\"1.0\"?><llsd><map>\
         <key>logout</key><boolean>1</boolean>\
         <key>viewer_session</key><string>{}</string>\
         <key>voice_server_type</key><string>{VOICE_SERVER_TYPE}</string>\
         </map></llsd>",
        xml_escape(&viewer_session)
    );
    let _ = inventory::cap_post_url(state.inner(), &session, &url, &body).await;
    Ok(json!({ "ok": true }))
}

/// Where the voice data channel should say we are: the avatar's grid-global
/// position (head height), which the voice server uses for spatial mixing.
#[tauri::command]
pub fn sl_voice_position(state: State<'_, Arc<AppState>>) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    match session.agent_global_position() {
        Some(p) => Ok(json!({ "ok": true, "position": p })),
        None => Ok(json!({ "ok": false })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stun_pools_per_grid() {
        assert_eq!(
            stun_servers("agni"),
            vec![
                "stun:stun1.agni.secondlife.io:3478",
                "stun:stun2.agni.secondlife.io:3478",
                "stun:stun3.agni.secondlife.io:3478",
            ]
        );
        assert_eq!(stun_servers("Aditi").len(), 2);
        assert!(stun_servers("").is_empty());
        assert!(stun_servers("my.grid").is_empty(), "unknown grids bring their own STUN");
    }

    #[test]
    fn parcel_channel_follows_the_flags() {
        // No parcel data yet: estate channel.
        assert_eq!(parcel_channel(None), Ok(None));
        // Voice forbidden on the parcel: no session at all.
        assert_eq!(parcel_channel(Some((7, 0))), Err("Voice is not allowed on this parcel"));
        // Voice allowed, estate-wide channel opted in: estate.
        assert_eq!(parcel_channel(Some((7, PF_ALLOW_VOICE_CHAT | PF_USE_ESTATE_VOICE_CHAN))), Ok(None));
        // Voice allowed, estate channel opted out: the parcel's own channel.
        assert_eq!(parcel_channel(Some((7, PF_ALLOW_VOICE_CHAT))), Ok(Some(7)));
    }

    #[test]
    fn provision_body_carries_offer_and_channel() {
        let body = provision_body("v=0\no=- 1 1 IN IP4 0.0.0.0\n<&>", Some(42));
        assert!(body.contains("<key>type</key><string>offer</string>"));
        assert!(body.contains("&lt;&amp;&gt;"), "SDP is XML-escaped");
        assert!(body.contains("<key>parcel_local_id</key><integer>42</integer>"));
        assert!(body.contains("<key>channel_type</key><string>local</string>"));
        assert!(body.contains("<key>voice_server_type</key><string>webrtc</string>"));
        // Estate-wide channel: no parcel key at all.
        assert!(!provision_body("sdp", None).contains("parcel_local_id"));
    }

    #[test]
    fn ice_body_lists_candidates_and_completion() {
        let cands = vec![json!({ "sdpMid": "0", "sdpMLineIndex": 0, "candidate": "candidate:1 1 udp 213 1.2.3.4 4444 typ host" })];
        let body = ice_body("sess-1", &cands, false);
        assert!(body.contains("<key>candidates</key><array><map>"));
        assert!(body.contains("candidate:1 1 udp 213 1.2.3.4 4444 typ host"));
        assert!(body.contains("<key>viewer_session</key><string>sess-1</string>"));
        assert!(!body.contains("completed"));
        // Completion-only marker uses the singular key, like the wire expects.
        let done = ice_body("sess-1", &[], true);
        assert!(done.contains("<key>candidate</key><map><key>completed</key><boolean>1</boolean></map>"));
        assert!(!done.contains("<key>candidates</key>"));
    }
}
