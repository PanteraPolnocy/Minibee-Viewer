//! EventQueueGet long-poll (the engine path). We poll the region's EventQueue
//! capability and fan the resulting LLSD events (ChatterBox chat sessions and the
//! like) out through the session engine. Teleport and region events land here too,
//! but the UDP path already delivers those, so for now we only route chat-session ones.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::AppHandle;
use tokio::task::JoinHandle;

use crate::bridge::circuit::Session;
use crate::bridge::proxy;
use crate::codec;

/// The sim is supposed to hold a poll open for ~20-30s. If a "no events" signal
/// (timeout, 499, 5xx, or empty body) comes back sooner than that, we treat it as a
/// real error and back off instead of hammering the sim.
const MIN_HOLD_SECS: f64 = 10.0;
/// The backoff after an error grows as 1 + n*3 seconds, and we give up after 15
/// tries (~5 minutes).
const MAX_ERRORS: u32 = 15;
/// The closing `done` post is a courtesy to a region we may already have left,
/// so it gets a short leash.
const DONE_TIMEOUT: Duration = Duration::from_secs(5);

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

/// What the poll task and its owner (the session) share: the last ack the sim
/// gave us, and whether the poll is still worth saying goodbye to.
struct Shared {
    ack: Mutex<Option<i64>>,
    /// Cleared by the task when it ends on its own (404, gave up), so the
    /// session does not post a `done` for a queue that already told us it's gone.
    alive: AtomicBool,
}

/// One EventQueue poll as the session sees it: enough to send the closing
/// `done: true` request when the poll is replaced or the session closes.
pub struct EqPoll {
    ua: String,
    cap_url: String,
    agent_session_id: String,
    shared: Arc<Shared>,
}

/// A 2xx reply we can act on: an LLSD map carrying `events` and/or an `id`.
/// Anything else (a proxy's HTML page, a bare `<llsd><undef/></llsd>`) is a
/// failed poll, not a zero-event tick, and takes the same path as an error so
/// a sim that keeps answering that way is not hammered in a tight loop.
fn eq_reply_usable(parsed: &Value) -> bool {
    match parsed.as_object() {
        Some(m) => ["events", "Events", "id", "ID"].iter().any(|k| m.contains_key(*k)),
        None => false,
    }
}

fn session_headers(agent_session_id: &str) -> Vec<(String, String)> {
    if agent_session_id.is_empty() {
        Vec::new()
    } else {
        vec![("X-SecondLife-Session-ID".to_string(), agent_session_id.to_string())]
    }
}

/// Start the EventQueue long-poll against `cap_url` and install it on the
/// session, replacing (and saying `done` to) whichever poll ran before.
pub fn start(app: AppHandle, session: Arc<Session>, ua: String, cap_url: String, agent_session_id: String) {
    let shared = Arc::new(Shared { ack: Mutex::new(None), alive: AtomicBool::new(true) });
    let poll = EqPoll {
        ua: ua.clone(),
        cap_url: cap_url.clone(),
        agent_session_id: agent_session_id.clone(),
        shared: shared.clone(),
    };
    let handle = spawn(app, session.clone(), ua, cap_url, agent_session_id, shared);
    session.set_eq_task(handle, poll);
}

/// Claim the sign-off for a poll: the ack to send if it was still alive, None
/// when it already ended on its own or was signed off before.
fn claim_sign_off(shared: &Shared) -> Option<Option<i64>> {
    if !shared.alive.swap(false, Ordering::SeqCst) {
        return None;
    }
    Some(*shared.ack.lock().unwrap())
}

/// Tell the sim we are leaving this queue: one last request with `done: true`
/// and the latest ack, the way the classic viewer's poll signed off. Fire and
/// forget - the region may already be behind us - and a no-op for a poll that
/// ended by itself. Skipped quietly when there is no runtime to spawn on.
pub fn send_done(poll: EqPoll) {
    let Some(ack) = claim_sign_off(&poll.shared) else {
        return;
    };
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    rt.spawn(async move {
        crate::dlog!("eventqueue: signing off (done) on {}", poll.cap_url);
        let (pin, _) = proxy::simhost_pin(&poll.cap_url, "").await;
        let _ = proxy::exchange(
            &poll.ua,
            "POST",
            &poll.cap_url,
            &request_body(ack, true),
            "application/llsd+xml",
            &session_headers(&poll.agent_session_id),
            pin,
            DONE_TIMEOUT,
            true,
        )
        .await;
    });
}

/// Spawn the EventQueue long-poll. Each request holds for up to 90s; a full-hold
/// 499/5xx/empty body is just the sim's "no events" tick, and a 404 means the cap is gone and we stop.
fn spawn(
    app: AppHandle,
    session: Arc<Session>,
    ua: String,
    cap_url: String,
    agent_session_id: String,
    shared: Arc<Shared>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        crate::dlog!("eventqueue: started");
        let mut ack: Option<i64> = None;
        let mut errors = 0u32;
        let mut gave_up = false;
        let headers = session_headers(&agent_session_id);

        loop {
            let (pin, _) = proxy::simhost_pin(&cap_url, "").await;
            let started = Instant::now();
            let result = proxy::exchange(
                &ua,
                "POST",
                &cap_url,
                &request_body(ack, false),
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
            // changed and the sim canceled the old poll, so it doesn't warrant
            // any user alarm. Instead of raising the scary banner here, we try a
            // bounded, gentle self-heal (re-fetch the current region's caps and
            // restart) in case it really was a main-region cap expiring. If recovery
            // isn't possible, or we've exhausted it, we stop quietly - a truly lost
            // region still surfaces via the repeated-error path below (session-lost)
            // or the UDP watchdog.
            if ex.status == 404 {
                crate::dlog!("eventqueue: 404 (cap gone) on {}", cap_url);
                // The queue is gone; there is nobody left to say `done` to.
                shared.alive.store(false, Ordering::SeqCst);
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

            let parsed = codec::llsd::parse(&ex.body, &ex.content_type).unwrap_or(Value::Null);
            // A 2xx whose body is not an event reply used to loop straight back
            // into the next request with no pause at all.
            if !eq_reply_usable(&parsed) {
                crate::dlog!("eventqueue: 2xx without an LLSD event reply ({} bytes)", ex.body.len());
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
            errors = 0;
            session.note_eq_healthy();

            if let Some(id) = parsed.get("id").or_else(|| parsed.get("ID")).and_then(|v| v.as_i64()) {
                ack = Some(id);
                *shared.ack.lock().unwrap() = ack;
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
        // This poll ended on its own; the session must not post a `done` for it later.
        shared.alive.store(false, Ordering::SeqCst);
        // Repeated poll failures mean this EventQueue is finished. Whether that's worth
        // telling the user they're disconnected is a separate question, and we were
        // getting it wrong: the answer used to be an unconditional yes, so a broken poll
        // put up "connection lost" while the UDP circuit was perfectly alive and chat,
        // IMs and teleports all still worked.
        //
        // A poll whose cap is no longer the session's is a leftover from a region
        // we've left, so it just stops quietly. For the current region's poll,
        // most of what we need still runs over UDP - a dead poll costs ChatterBox
        // sessions and live updates, not the session. So if the circuit is still
        // answering, that's a degraded-features banner, not a disconnect. And a
        // session that is no longer the live one (logged out, replaced by a
        // reconnect) has nothing to tell the UI at all.
        if !gave_up {
            crate::dlog!("eventqueue: stopped");
        } else if !session.is_current_eq(&cap_url) {
            crate::dlog!("eventqueue: gave up on a stale cap, leaving the session alone");
        } else if !session.is_live(&app) {
            crate::dlog!("eventqueue: gave up on a circuit that is no longer the live session");
        } else if session.circuit_alive() {
            crate::dlog!("eventqueue: gave up, but the circuit is alive - degraded, not lost");
            crate::bridge::caps::emit_caps_status(&app, None, "eventqueue");
        } else {
            crate::dlog!("eventqueue: gave up and the circuit is silent -> session-lost");
            session.emit_live(
                &app,
                "session-lost",
                serde_json::json!({ "reason": "Lost connection to the region." }),
            );
        }
    })
}

fn request_body(ack: Option<i64>, done: bool) -> String {
    let done = if done { 1 } else { 0 };
    match ack {
        Some(a) => format!("<llsd><map><key>ack</key><integer>{a}</integer><key>done</key><boolean>{done}</boolean></map></llsd>"),
        None => format!("<llsd><map><key>ack</key><undef /><key>done</key><boolean>{done}</boolean></map></llsd>"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_body_shapes() {
        assert!(request_body(None, false).contains("<undef"));
        assert!(request_body(None, false).contains("<boolean>0</boolean>"));
        assert!(request_body(Some(7), false).contains("<integer>7</integer>"));
        // The sign-off keeps the last ack and flips done.
        let bye = request_body(Some(7), true);
        assert!(bye.contains("<integer>7</integer>"));
        assert!(bye.contains("<boolean>1</boolean>"));
    }

    #[test]
    fn only_an_event_reply_counts_as_usable() {
        assert!(eq_reply_usable(&json!({ "id": 3, "events": [] })));
        assert!(eq_reply_usable(&json!({ "id": 3 })));
        assert!(eq_reply_usable(&json!({ "Events": [] })));
        // Not LLSD at all, an undef, or a map with nothing we know: a failed poll.
        assert!(!eq_reply_usable(&Value::Null));
        assert!(!eq_reply_usable(&json!("<html>gateway</html>")));
        assert!(!eq_reply_usable(&json!({})));
        assert!(!eq_reply_usable(&json!({ "error": "nope" })));
    }

    #[test]
    fn a_poll_signs_off_once_and_only_while_alive() {
        let shared = Shared { ack: Mutex::new(Some(9)), alive: AtomicBool::new(true) };
        // The first sign-off claims the poll and its last ack; a second finds it gone.
        assert_eq!(claim_sign_off(&shared), Some(Some(9)));
        assert_eq!(claim_sign_off(&shared), None);
        // A poll that ended on its own (404, gave up) has nobody to say done to.
        let ended = Shared { ack: Mutex::new(Some(2)), alive: AtomicBool::new(false) };
        assert_eq!(claim_sign_off(&ended), None);
        // A poll that never got an id signs off with no ack.
        let fresh = Shared { ack: Mutex::new(None), alive: AtomicBool::new(true) };
        assert_eq!(claim_sign_off(&fresh), Some(None));
    }
}
