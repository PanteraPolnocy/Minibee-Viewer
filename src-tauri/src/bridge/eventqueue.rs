//! EventQueueGet long-poll (the engine path). We poll the region's EventQueue
//! capability and fan the resulting LLSD events (ChatterBox chat sessions and the
//! like) out through the session engine. Teleport and region events land here too,
//! but the UDP path already delivers those, so for now we only route chat-session ones.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

use crate::bridge::circuit::Session;
use crate::bridge::proxy;
use crate::codec;

/// The sim is supposed to hold a poll open for ~20-30s. If a "no events" signal
/// (timeout, 499, 5xx, or empty body) comes back sooner than that, we treat it as a
/// real error and back off instead of hammering the sim (mirrors the reference viewer's MIN_SECONDS_PASSED).
const MIN_HOLD_SECS: f64 = 10.0;
/// The backoff after an error grows as 1 + n*3 seconds, and we give up after 15
/// tries (~5 minutes), matching the reference viewer's EVENT_POLL_ERROR constants.
const MAX_ERRORS: u32 = 15;

/// Sleep through the backoff for the current error count. Returns false once we've
/// used up MAX_ERRORS, which is the caller's cue to stop polling.
async fn backoff(errors: &mut u32) -> bool {
    if *errors >= MAX_ERRORS {
        return false;
    }
    let wait = 1.0 + (*errors as f64) * 3.0;
    *errors += 1;
    tokio::time::sleep(Duration::from_secs_f64(wait)).await;
    true
}

/// Spawn the EventQueue long-poll. Each request holds for up to 90s; a full-hold
/// 499/5xx/empty body is just the sim's "no events" tick, and a 404 means the cap is gone and we stop.
pub fn spawn(
    app: AppHandle,
    session: Arc<Session>,
    ua: String,
    cap_url: String,
    agent_session_id: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        crate::dlog!("eventqueue: started");
        let mut ack: Option<i64> = None;
        let mut errors = 0u32;
        let mut gave_up = false;
        let headers: Vec<(String, String)> = if agent_session_id.is_empty() {
            Vec::new()
        } else {
            vec![("X-SecondLife-Session-ID".to_string(), agent_session_id)]
        };

        loop {
            let (pin, _) = proxy::simhost_pin(&cap_url, "").await;
            let started = Instant::now();
            let result = proxy::exchange(
                &ua,
                "POST",
                &cap_url,
                &request_body(ack),
                "application/llsd+xml",
                &headers,
                pin,
                Duration::from_secs(90),
                true,
            )
            .await;
            let held_full = started.elapsed().as_secs_f64() >= MIN_HOLD_SECS;

            let ex = match result {
                Ok(e) => e,
                Err(_) => {
                    // A transport error after the full hold is really just the sim's
                    // poll timing out ("no events"); anything sooner than that is a real failure.
                    if held_full {
                        errors = 0;
                        continue;
                    }
                    if !backoff(&mut errors).await {
                        gave_up = true;
                        break;
                    }
                    continue;
                }
            };

            // A 404 means the cap is gone, which is normally benign: the region
            // changed and the sim canceled the old poll (the reference viewer's
            // lleventpoll.cpp does the same, quietly stopping the poll on a 404 with
            // no user alarm). So instead of raising the scary banner here, we try a
            // bounded, gentle self-heal (re-fetch the current region's caps and
            // restart) in case it really was a main-region cap expiring. If recovery
            // isn't possible, or we've exhausted it, we stop quietly - a truly lost
            // region still surfaces via the repeated-error path below (session-lost)
            // or the UDP watchdog.
            if ex.status == 404 {
                crate::dlog!("eventqueue: 404 (cap gone) on {}", cap_url);
                if session.recover_eq(&app).await {
                    crate::dlog!("eventqueue: handed off to refetched poll");
                } else {
                    crate::dlog!("eventqueue: 404, no recovery - stopping quietly");
                }
                break;
            }
            // A 499, 5xx, or empty body that held for the full poll is just a normal "no events".
            if ex.status == 499 || ex.status >= 500 || ex.body.trim().is_empty() {
                if held_full {
                    errors = 0;
                    continue;
                }
                if !backoff(&mut errors).await {
                    gave_up = true;
                    break;
                }
                continue;
            }
            // Anything else that isn't a 2xx is an unexpected error, so back off.
            if !(200..300).contains(&ex.status) {
                if !backoff(&mut errors).await {
                    gave_up = true;
                    break;
                }
                continue;
            }
            errors = 0;
            session.note_eq_healthy();

            let parsed = codec::llsd::parse(&ex.body, &ex.content_type).unwrap_or(Value::Null);
            if let Some(id) = parsed.get("id").or_else(|| parsed.get("ID")).and_then(|v| v.as_i64()) {
                ack = Some(id);
            }
            let events = parsed
                .get("events")
                .or_else(|| parsed.get("Events"))
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            crate::dlog!("eventqueue: poll ok, {} event(s)", events.len());
            for ev in events {
                let name = ev
                    .get("message")
                    .or_else(|| ev.get("Message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let body = ev.get("body").or_else(|| ev.get("Body")).cloned().unwrap_or(Value::Null);
                if !name.is_empty() {
                    session.handle_eq_event(&app, &name, &body).await;
                }
            }
        }
        // Repeated poll failures on the region's EventQueue mean the region is
        // lost, so we force a disconnect. (A plain 404/cap-rotation break doesn't
        // set this - the region-cross path respawns the poll in that case.)
        if gave_up {
            crate::dlog!("eventqueue: gave up after repeated errors -> session-lost");
            let _ = app.emit(
                "minibee-viewer://session-lost",
                serde_json::json!({ "reason": "Lost connection to the region." }),
            );
        } else {
            crate::dlog!("eventqueue: stopped");
        }
    })
}

fn request_body(ack: Option<i64>) -> String {
    match ack {
        Some(a) => format!("<llsd><map><key>ack</key><integer>{a}</integer><key>done</key><boolean>0</boolean></map></llsd>"),
        None => "<llsd><map><key>ack</key><undef /><key>done</key><boolean>0</boolean></map></llsd>".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_body_shapes() {
        assert!(request_body(None).contains("<undef"));
        assert!(request_body(Some(7)).contains("<integer>7</integer>"));
    }
}
