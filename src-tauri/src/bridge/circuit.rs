//! The SL UDP circuit: one socket per session, a datagram relay, and an HTTP listener for inbound trusted messages.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

use crate::bridge::session::{self, Action, SessionState};
use crate::codec;
use crate::codec::template::Registry;

/// A reliable send still waiting on its ack: the framed bytes, when we last sent it (ms), and the attempt count.
type Pending = (Vec<u8>, u64, u8);

/// Everything needed to start a circuit in native engine mode.
pub struct EngineInit {
    pub agent_id: String,
    pub session_uuid: String,
    pub sim_ip: String,
    pub sim_port: u16,
    pub circuit_code: u32,
    pub caps: HashMap<String, String>,
}

pub struct Session {
    pub udp: Arc<UdpSocket>,
    pub target: Mutex<SocketAddr>,
    pub local_port: u16,
    seq: AtomicU32,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    /// The parsed message template, used for both encode and decode.
    pub registry: Arc<Registry>,
    /// Engine state when this circuit drives the native session engine (the new
    /// path); `None` when it's the legacy raw-relay path the JS frontend uses.
    engine: Mutex<Option<SessionState>>,
    /// Reliable sends still waiting to be acked, keyed by sequence number.
    awaiting: Mutex<HashMap<u32, Pending>>,
    /// Sequence numbers of inbound reliable packets we still owe an ack for.
    pending_acks: Mutex<Vec<u32>>,
    /// Reliable inbound seqs we've handled recently (seq, received_ms), used to
    /// spot duplicate resends. We purge by age, like the reference viewer's
    /// mRecentlyReceivedReliablePackets (60s window), so a seq the sim may still
    /// be resending is never evicted too early; a large count cap backstops memory.
    recent_reliable: Mutex<VecDeque<(u32, u64)>>,
    /// Agent ids waiting to be resolved, batched together into a UUIDNameRequest.
    pending_names: Mutex<Vec<String>>,
    /// The active EventQueue long-poll task, swapped out whenever the region changes.
    eq_task: Mutex<Option<JoinHandle<()>>>,
    /// Wall-clock ms of the last inbound datagram we accepted, feeding the liveness
    /// watchdog (a silently dead sim sends nothing at all, not even ping checks).
    last_inbound: AtomicU64,
    /// The current region's seed cap and sim IP, saved on every cap refresh so a
    /// dead EventQueue can be recovered by re-fetching caps.
    last_seed: Mutex<Option<(String, String)>>,
    /// How many EventQueue recovery attempts we've made since the last healthy poll,
    /// bounded so a region whose EQ never comes back doesn't retry forever.
    eq_recover: AtomicU32,
}

impl Session {
    fn next_seq(&self) -> u32 {
        self.seq.fetch_add(1, Ordering::SeqCst)
    }

    pub async fn send_bytes(&self, bytes: &[u8]) -> usize {
        let addr = *self.target.lock().unwrap();
        self.udp.send_to(bytes, addr).await.unwrap_or(0)
    }

    /// Encode a message by its template name and send it. We assign the sequence
    /// number locally; reliability (resending) is left to the frontend.
    pub async fn send_message(
        &self,
        reg: &Registry,
        name: &str,
        blocks: &Value,
        reliable: bool,
    ) -> Option<(u32, usize)> {
        let seq = self.next_seq();
        let flags = if reliable { codec::FLAG_RELIABLE } else { 0 };
        let bytes = codec::encode(reg, name, blocks, seq, flags)?;
        let sent = self.send_bytes(&bytes).await;
        Some((seq, sent))
    }

    pub fn retarget(&self, addr: SocketAddr) {
        *self.target.lock().unwrap() = addr;
    }

    pub fn sim_ip(&self) -> String {
        self.target.lock().unwrap().ip().to_string()
    }

    pub fn close(&self) {
        for t in self.tasks.lock().unwrap().drain(..) {
            t.abort();
        }
        if let Some(eq) = self.eq_task.lock().unwrap().take() {
            eq.abort();
        }
    }

    fn has_engine(&self) -> bool {
        self.engine.lock().unwrap().is_some()
    }

    /// The (agent_id, session_uuid) pair used to build outbound AgentData blocks.
    pub fn agent_ids(&self) -> Option<(String, String)> {
        self.engine
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| (s.agent_id.clone(), s.session_uuid.clone()))
    }

    /// Look up a region capability URL by name.
    pub fn cap(&self, name: &str) -> Option<String> {
        self.engine.lock().unwrap().as_ref().and_then(|s| s.caps.get(name).cloned())
    }

    /// Swap in a fresh capability map for the engine, e.g. after a region change.
    pub fn set_caps(&self, caps: std::collections::HashMap<String, String>) {
        if let Some(st) = self.engine.lock().unwrap().as_mut() {
            st.caps = caps;
        }
    }

    /// Install the EventQueue task, aborting whichever one was running before.
    pub fn set_eq_task(&self, handle: JoinHandle<()>) {
        let mut slot = self.eq_task.lock().unwrap();
        if let Some(old) = slot.replace(handle) {
            old.abort();
        }
    }

    /// Remember the current region's seed cap and sim IP so a dead EventQueue can
    /// be recovered later by re-fetching caps.
    pub fn set_last_seed(&self, seed_url: &str, sim_ip: &str) {
        *self.last_seed.lock().unwrap() = Some((seed_url.to_string(), sim_ip.to_string()));
    }

    /// A healthy EventQueue poll resets the recovery budget.
    pub fn note_eq_healthy(&self) {
        self.eq_recover.store(0, Ordering::SeqCst);
    }

    /// Recover a 404'd EventQueue by re-fetching the current region's caps and
    /// restarting the poll. A 404 is usually harmless (the region changed and the
    /// sim canceled the old cap - the reference viewer simply stops that poll), so
    /// keep this a bounded, gentle self-heal for a genuine main-region cap expiry:
    /// at most EQ_MAX_RECOVER attempts (any healthy poll resets the count), one cap
    /// refetch apiece, and never a tight retry loop hammering Linden's servers.
    /// Returns true once a fresh poll is running (the caller then ends this task).
    pub async fn recover_eq(self: &Arc<Self>, app: &AppHandle) -> bool {
        const EQ_MAX_RECOVER: u32 = 6;
        if self.eq_recover.fetch_add(1, Ordering::SeqCst) >= EQ_MAX_RECOVER {
            return false;
        }
        let seed = self.last_seed.lock().unwrap().clone();
        let (seed_url, sim_ip) = match seed {
            Some(s) => s,
            None => return false,
        };
        crate::dlog!("eventqueue: 404 recovery - refetching region caps");
        self.refresh_region_caps(app, &seed_url, &sim_ip).await;
        true
    }

    /// Store resolved names in the engine cache; returns the entries that actually
    /// changed as `[{id,name}]`, ready for a names-updated event.
    pub fn merge_names(&self, resolved: &[(String, String)]) -> Vec<Value> {
        let mut guard = self.engine.lock().unwrap();
        let st = match guard.as_mut() {
            Some(s) => s,
            None => return Vec::new(),
        };
        let mut changed = Vec::new();
        for (id, name) in resolved {
            if st.set_name(id, name) {
                changed.push(json!({ "id": id, "name": name }));
            }
        }
        changed
    }

    fn clear_acks(&self, ids: &[u32]) {
        if ids.is_empty() {
            return;
        }
        let mut a = self.awaiting.lock().unwrap();
        for id in ids {
            a.remove(id);
        }
    }

    /// Decode one datagram, handle its acks, run the session router, and carry out
    /// whatever sends/emits come back. Engine path only.
    async fn handle_datagram(self: &Arc<Self>, app: &AppHandle, bytes: &[u8]) {
        let reg = self.registry.clone();
        let decoded = match codec::decode(&reg, bytes) {
            Some(d) => d,
            None => {
                crate::dlog!("recv: undecodable datagram ({} bytes)", bytes.len());
                return;
            }
        };
        // Log inbound message names, skipping the constant keepalive/ack chatter, so
        // a diagnostic run shows exactly which sim replies are landing.
        if let Some(name) = decoded.get("name").and_then(|v| v.as_str()) {
            if !matches!(name, "PacketAck" | "StartPingCheck" | "CompletePingCheck") {
                crate::dlog!("recv {}", name);
            }
        }

        // Clear out the reliable sends the sim just acked (both piggybacked and via PacketAck).
        if let Some(acks) = decoded.get("acks").and_then(|a| a.as_array()) {
            let ids: Vec<u32> = acks.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect();
            self.clear_acks(&ids);
        }
        if decoded.get("name").and_then(|v| v.as_str()) == Some("PacketAck") {
            if let Some(pkts) = decoded.get("blocks").and_then(|b| b.get("Packets")).and_then(|a| a.as_array()) {
                let ids: Vec<u32> = pkts.iter().filter_map(|p| p.get("ID").and_then(|v| v.as_u64()).map(|n| n as u32)).collect();
                self.clear_acks(&ids);
            }
        }

        // We owe an ack for reliable inbound, and we drop duplicate resends: a
        // packet carrying the RESENT flag whose seq we've already processed gets
        // re-acked (so the sim stops resending) but isn't routed a second time.
        let mut duplicate_resend = false;
        if decoded.get("reliable").and_then(|v| v.as_bool()) == Some(true) {
            if let Some(seq) = decoded.get("seq").and_then(|v| v.as_u64()) {
                let seq = seq as u32;
                self.pending_acks.lock().unwrap().push(seq);
                let resent = decoded
                    .get("flags")
                    .and_then(|v| v.as_u64())
                    .map(|f| (f as u8) & codec::FLAG_RESENT != 0)
                    .unwrap_or(false);
                let now = mono_ms();
                let mut recent = self.recent_reliable.lock().unwrap();
                // Drop entries past the sim's ~60s resend window; anything still
                // inside it stays put, so a genuine resend is always caught.
                while let Some(&(_, t)) = recent.front() {
                    if now.saturating_sub(t) > 60_000 {
                        recent.pop_front();
                    } else {
                        break;
                    }
                }
                if recent.iter().any(|&(s, _)| s == seq) {
                    if resent {
                        duplicate_resend = true;
                    }
                } else {
                    recent.push_back((seq, now));
                    // Purely a memory backstop, set well above any 60s burst of reliables.
                    while recent.len() > 8192 {
                        recent.pop_front();
                    }
                }
            }
        }
        if duplicate_resend {
            self.flush_acks().await;
            return;
        }

        // Route while holding the lock (sync), then execute once it's released (async).
        let actions = {
            let mut guard = self.engine.lock().unwrap();
            match guard.as_mut() {
                Some(st) => {
                    st.now_ms = now_ms();
                    session::route(st, &decoded)
                }
                None => return,
            }
        };
        for action in actions {
            self.execute(app, &reg, action).await;
        }
        self.flush_acks().await;
    }

    /// Route a single EventQueue event (LLSD body) and carry out its actions.
    pub async fn handle_eq_event(self: &Arc<Self>, app: &AppHandle, name: &str, body: &Value) {
        crate::dlog!("eq event {} body={:.2500}", name, body.to_string());
        let reg = self.registry.clone();
        let actions = {
            let mut guard = self.engine.lock().unwrap();
            match guard.as_mut() {
                Some(st) => {
                    st.now_ms = now_ms();
                    session::route_eq(st, name, body)
                }
                None => return,
            }
        };
        for action in actions {
            self.execute(app, &reg, action).await;
        }
    }

    /// Encode a message by name, send it, and - if it's reliable - track it for resend.
    pub async fn send_encoded(&self, name: &str, blocks: &Value, reliable: bool) {
        let seq = self.next_seq();
        let flags = if reliable { codec::FLAG_RELIABLE } else { 0 };
        if let Some(pkt) = codec::encode(&self.registry, name, blocks, seq, flags) {
            if reliable {
                self.awaiting.lock().unwrap().insert(seq, (pkt.clone(), mono_ms(), 0));
            }
            self.send_bytes(&pkt).await;
        }
    }

    /// Bring the circuit up: UseCircuitCode, then CompleteAgentMovement, both reliable.
    pub async fn start_handshake(&self, agent_id: &str, session_uuid: &str, circuit_code: u32) {
        self.send_encoded(
            "UseCircuitCode",
            &json!({ "CircuitCode": [{ "Code": circuit_code, "SessionID": session_uuid, "ID": agent_id }] }),
            true,
        )
        .await;
        self.send_encoded(
            "CompleteAgentMovement",
            &json!({ "AgentData": [{ "AgentID": agent_id, "SessionID": session_uuid, "CircuitCode": circuit_code }] }),
            true,
        )
        .await;
    }

    async fn execute(self: &Arc<Self>, app: &AppHandle, _reg: &Registry, action: Action) {
        match action {
            Action::Send { name, blocks, reliable } => {
                self.send_encoded(&name, &blocks, reliable).await;
            }
            Action::Emit { event, mut payload } => {
                stamp_event(&event, &mut payload);
                let _ = app.emit(&format!("minibee-viewer://{event}"), payload);
            }
            Action::ResolveNames(ids) => {
                let batch: Vec<String> = {
                    let mut p = self.pending_names.lock().unwrap();
                    for id in ids {
                        if !p.contains(&id) {
                            p.push(id);
                        }
                    }
                    let take = p.len().min(40);
                    p.drain(..take).collect()
                };
                if !batch.is_empty() {
                    let blocks = json!({
                        "UUIDNameBlock": batch.iter().map(|id| json!({ "ID": id })).collect::<Vec<_>>()
                    });
                    self.send_encoded("UUIDNameRequest", &blocks, false).await;
                }
            }
            Action::Retarget { sim_ip, sim_port, agent_id, session_uuid, circuit_code } => {
                if let Ok(addr) = format!("{sim_ip}:{sim_port}").parse::<SocketAddr>() {
                    self.retarget(addr);
                }
                // Once we switch sims, anything tied to the old sim's sequence space
                // is meaningless. The reference viewer gets this for free (a new region is a new
                // per-host circuit); we reuse one Session, so we clear it by hand -
                // otherwise a new-region reliable packet whose seq collides with a
                // stale entry would be dropped as a false duplicate, or acked stale.
                self.awaiting.lock().unwrap().clear();
                self.recent_reliable.lock().unwrap().clear();
                self.pending_acks.lock().unwrap().clear();
                self.start_handshake(&agent_id, &session_uuid, circuit_code).await;
            }
            Action::RefreshCaps { seed_url, sim_ip } => {
                self.refresh_region_caps(app, &seed_url, &sim_ip).await;
            }
            Action::AcceptChatSession { session_id } => {
                let state = app.state::<Arc<crate::bridge::state::AppState>>().inner().clone();
                let _ = crate::bridge::caps::chat_session_post(
                    &state,
                    "accept invitation",
                    &session_id,
                    &[],
                    None,
                )
                .await;
            }
        }
    }

    /// Re-fetch the new region's caps and restart the EventQueue against them.
    /// Best-effort: if anything fails, the retargeted UDP circuit is left untouched.
    async fn refresh_region_caps(self: &Arc<Self>, app: &AppHandle, seed_url: &str, sim_ip: &str) {
        // Save the region's seed so a later EventQueue 404 can self-heal.
        self.set_last_seed(seed_url, sim_ip);
        let session_uuid = match self.agent_ids() {
            Some((_, s)) => s,
            None => return,
        };
        let state = app.state::<Arc<crate::bridge::state::AppState>>().inner().clone();
        let caps = match crate::bridge::login::fetch_region_caps(&state, seed_url, sim_ip, &session_uuid).await {
            Some(c) => c,
            None => {
                // Cap refetch failed for the new region: the UDP circuit still
                // works, but names/land/live updates won't. Better to warn than
                // to fail silently.
                crate::bridge::caps::emit_caps_status(app, None, "region-cross");
                return;
            }
        };
        let eq_url = caps.get("EventQueueGet").cloned().unwrap_or_default();
        // Re-evaluate against the new region's caps: clear the banner if this
        // region is healthy, raise it again if it isn't.
        crate::bridge::caps::emit_caps_status(app, Some(&caps), "region-cross");
        self.set_caps(caps);
        if !eq_url.is_empty() {
            let handle = crate::bridge::eventqueue::spawn(
                app.clone(),
                self.clone(),
                state.ua.clone(),
                eq_url,
                session_uuid,
            );
            self.set_eq_task(handle);
        }
    }

    async fn flush_acks(&self) {
        let ids: Vec<u32> = {
            let mut p = self.pending_acks.lock().unwrap();
            if p.is_empty() {
                return;
            }
            p.drain(..).collect()
        };
        let blocks = json!({ "Packets": ids.iter().map(|id| json!({ "ID": id })).collect::<Vec<_>>() });
        let seq = self.next_seq();
        if let Some(pkt) = codec::encode(&self.registry, "PacketAck", &blocks, seq, 0) {
            self.send_bytes(&pkt).await;
        }
    }

    /// Resend reliable packets that still haven't been acked, up to 5 attempts,
    /// then drop the packet. Giving up on one does NOT tear the session down -
    /// circuit death is decided solely by the heartbeat watchdog, so a brief
    /// loss spike that eats one message's retries can't disconnect us.
    async fn resend_unacked(&self) {
        let now = mono_ms();
        let due: Vec<(u32, Vec<u8>)> = {
            let mut a = self.awaiting.lock().unwrap();
            let mut due = Vec::new();
            a.retain(|&_seq, (bytes, last, attempts)| {
                if now.saturating_sub(*last) < 2000 {
                    return true;
                }
                if *attempts >= 5 {
                    return false; // give up on just this one packet
                }
                *attempts += 1;
                *last = now;
                let mut resent = bytes.clone();
                resent[0] |= codec::FLAG_RESENT;
                due.push((_seq, resent));
                true
            });
            due
        };
        for (_seq, bytes) in due {
            self.send_bytes(&bytes).await;
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Monotonic milliseconds since process start. Circuit liveness, resend, and
/// dedup timing all use this, so a wall-clock jump (NTP/VM/manual) can't fake a
/// >100s silence and trigger a spurious session-lost; `now_ms` (wall) stays for
/// the UI timestamps that genuinely want real time.
static MONO_BASE: Lazy<Instant> = Lazy::new(Instant::now);
fn mono_ms() -> u64 {
    MONO_BASE.elapsed().as_millis() as u64
}

/// A uuid-shaped id for UI list keys and request ids - not cryptographically secure.
pub(crate) fn gen_id() -> String {
    let h = now_id();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamp_adds_id_and_timestamp_to_chat() {
        let mut p = json!({ "text": "hi" });
        stamp_event("chat", &mut p);
        assert!(p.get("id").and_then(|v| v.as_str()).is_some());
        assert!(p.get("timestamp").and_then(|v| v.as_u64()).is_some());
    }

    #[test]
    fn stamp_targets_im_message_and_leaves_others() {
        let mut im = json!({ "sessionId": "s", "message": { "text": "hi" } });
        stamp_event("im", &mut im);
        assert!(im["message"].get("id").is_some());
        assert!(im.get("id").is_none()); // no top-level id for im, it goes on the message
        let mut region = json!({ "name": "Natoma" });
        stamp_event("region", &mut region);
        assert!(region.get("id").is_none()); // left untouched
    }

    #[test]
    fn gen_id_is_uuid_shaped() {
        let id = gen_id();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[8], b'-');
    }
}

/// Stamp `id` and `timestamp` onto the events the UI keys by them.
fn stamp_event(event: &str, payload: &mut Value) {
    let now = now_ms();
    if let Value::Object(m) = payload {
        match event {
            "chat" | "event" => {
                m.entry("id").or_insert_with(|| json!(gen_id()));
                m.entry("timestamp").or_insert_with(|| json!(now));
            }
            "im" => {
                if let Some(Value::Object(msg)) = m.get_mut("message") {
                    msg.entry("id").or_insert_with(|| json!(gen_id()));
                    msg.entry("timestamp").or_insert_with(|| json!(now));
                }
            }
            _ => {}
        }
    }
}

fn now_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:032x}", nanos ^ ((c as u128) << 96))
}

fn parse_addr(ip: &str, port: u16) -> Option<SocketAddr> {
    format!("{}:{}", ip, port).parse().ok()
}

/// Resolve a target that may be an IP literal or (rarely, on OpenSim) a hostname.
/// The DNS lookup is async so it never blocks a Tokio worker.
async fn resolve_target(ip: &str, port: u16) -> Option<SocketAddr> {
    if let Some(addr) = parse_addr(ip, port) {
        return Some(addr);
    }
    tokio::net::lookup_host((ip, port))
        .await
        .ok()
        .and_then(|mut it| it.find(|a| a.is_ipv4()).or_else(|| it.next()))
}

/// High-frequency inbound messages the UI never consumes (we have no 3D world).
/// These are single-byte message ids sitting at offset 6; we drop them only when
/// they're unreliable, so a needed ack is never skipped.
const IGNORED_HIGH_FREQ: &[u8] = &[
    11, // LayerData
    12, // ObjectUpdate
    13, // ObjectUpdateCompressed
    14, // ObjectUpdateCached
    15, // ImprovedTerseObjectUpdate
    16, // KillObject
    20, // AvatarAnimation
    29, // SoundTrigger
    30, // ObjectAnimation
];

/// Medium-frequency inbound messages the UI never uses (encoded as `0xFF <n>`
/// at offset 6-7). These spike too when lots of avatars are around (gesture/typing
/// beams, object property pushes, attached sounds). We keep CoarseLocationUpdate
/// (6, radar) and CrossedRegion/ConfirmEnableSimulator (7/8, teleport).
const IGNORED_MEDIUM_FREQ: &[u8] = &[
    9,  // ObjectProperties
    10, // ObjectPropertiesFamily
    13, // AttachedSound
    14, // AttachedSoundGainChange
    15, // PreloadSound
    17, // ViewerEffect
];

/// Open a new circuit toward `sim_ip:sim_port` and spawn its background tasks.
/// `engine` = Some((agent_id, session_uuid)) runs the native session engine
/// (decoding and routing inbound); None falls back to the legacy raw relay (JS
/// frontend). Returns `(session_id, session, local_port)`.
pub async fn open(
    app: AppHandle,
    registry: Arc<Registry>,
    sim_ip: &str,
    sim_port: u16,
    engine: Option<EngineInit>,
) -> Result<(String, Arc<Session>, u16), String> {
    let target = resolve_target(sim_ip, sim_port).await.ok_or("Invalid sim_ip or sim_port")?;
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("socket bind failed: {e}"))?;
    let local_port = socket.local_addr().map(|a| a.port()).unwrap_or(0);
    let udp = Arc::new(socket);

    let engine_state = engine.map(|e| SessionState {
        agent_id: e.agent_id,
        session_uuid: e.session_uuid,
        sim_ip: e.sim_ip,
        sim_port: e.sim_port,
        circuit_code: e.circuit_code,
        caps: e.caps,
        ..Default::default()
    });
    let engine_mode = engine_state.is_some();

    let session = Arc::new(Session {
        udp: udp.clone(),
        target: Mutex::new(target),
        local_port,
        seq: AtomicU32::new(1),
        tasks: Mutex::new(Vec::new()),
        registry,
        engine: Mutex::new(engine_state),
        awaiting: Mutex::new(HashMap::new()),
        pending_acks: Mutex::new(Vec::new()),
        recent_reliable: Mutex::new(VecDeque::new()),
        pending_names: Mutex::new(Vec::new()),
        eq_task: Mutex::new(None),
        last_inbound: AtomicU64::new(mono_ms()),
        last_seed: Mutex::new(None),
        eq_recover: AtomicU32::new(0),
    });
    let session_id = now_id();

    let reader = spawn_reader(app.clone(), session.clone(), session_id.clone());
    let watchdog_app = app.clone();
    let http = spawn_http_listener(app, session.clone(), session_id.clone(), local_port);
    {
        let mut tasks = session.tasks.lock().unwrap();
        tasks.push(reader);
        tasks.push(http);
        if engine_mode {
            tasks.push(spawn_resender(session.clone()));
            tasks.push(spawn_watchdog(watchdog_app, session.clone()));
        }
    }

    Ok((session_id, session, local_port))
}

/// Periodically resend unacked reliable packets (engine path). Declaring the
/// circuit dead is the watchdog's job, not the resender's, so this just loops for
/// the whole life of the session.
fn spawn_resender(session: Arc<Session>) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            session.resend_unacked().await;
        }
    })
}

/// Watchdog: a live sim always sends *something* within a minute or two (region
/// data, object/terse updates, or at least a periodic StartPingCheck), so if we
/// hear nothing for the whole heartbeat window the circuit is dead - report it and
/// stop. Catches silent network drops and OS suspend that no resend timeout would.
fn spawn_watchdog(app: AppHandle, session: Arc<Session>) -> JoinHandle<()> {
    const HEARTBEAT_TIMEOUT_MS: u64 = 100_000; // same value the reference viewer uses
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let last = session.last_inbound.load(Ordering::Relaxed);
            if mono_ms().saturating_sub(last) > HEARTBEAT_TIMEOUT_MS {
                let _ = app.emit(
                    "minibee-viewer://session-lost",
                    json!({ "reason": "Lost connection to the region (no response)." }),
                );
                break;
            }
        }
    })
}

fn spawn_reader(app: AppHandle, session: Arc<Session>, session_id: String) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65535];
        loop {
            let (n, from) = match session.udp.recv_from(&mut buf).await {
                Ok(v) => v,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    continue;
                }
            };
            // Only accept datagrams from the sim this circuit currently points at.
            // The socket is unconnected (retarget swaps the sim on region change),
            // so without this an off-path attacker who found the ephemeral port
            // could inject forged sim traffic. Mirrors the trusted-message TCP
            // listener, which already pins the sender IP.
            if from.ip() != session.target.lock().unwrap().ip() {
                continue;
            }
            session.last_inbound.store(mono_ms(), Ordering::Relaxed);
            let datagram = &buf[..n];

            // Drop high/medium-frequency floods before they reach IPC, but only when
            // unreliable and ack-free (acks for our reliable sends ride along on these).
            if datagram.len() >= 7
                && (datagram[0] & codec::FLAG_RELIABLE) == 0
                && (datagram[0] & codec::FLAG_ACK) == 0
                && datagram[5] == 0
            {
                let b6 = datagram[6];
                if b6 != 0xFF {
                    if IGNORED_HIGH_FREQ.contains(&b6) {
                        continue;
                    }
                } else if datagram.len() >= 8
                    && datagram[7] != 0xFF
                    && IGNORED_MEDIUM_FREQ.contains(&datagram[7])
                {
                    continue;
                }
            }

            if session.has_engine() {
                // Native engine: decode, route, and perform the sends/emits right here.
                let dg = datagram.to_vec();
                session.handle_datagram(&app, &dg).await;
            } else {
                // Legacy raw relay: hand it off for the JS frontend's codec to decode and route.
                let _ = app.emit(
                    "minibee-viewer://packet-raw",
                    json!({ "sessionId": session_id, "packet": B64.encode(datagram) }),
                );
            }
        }
    })
}

static HTTP_MSG_PATH: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)/(?:trusted-message|message)/([^/?]+)").unwrap());

fn spawn_http_listener(
    app: AppHandle,
    session: Arc<Session>,
    session_id: String,
    port: u16,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        // The sim connects back to the viewer's UDP-listen port over TCP, so this
        // socket has to accept from the network - but we then validate that every
        // connection really originates from the current sim.
        let listener = match TcpListener::bind(("0.0.0.0", port)).await {
            Ok(l) => l,
            Err(_) => return, // no inbound trusted-message delivery, but not fatal
        };
        // Cap how many inbound handlers can run at once, so a flood of
        // connections can't exhaust tasks or memory.
        let sem = Arc::new(Semaphore::new(8));
        loop {
            let (mut stream, peer) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => continue,
            };
            // Only the current sim (the circuit's target IP) is allowed to post trusted messages.
            let trusted_ip = session.target.lock().unwrap().ip();
            if peer.ip() != trusted_ip {
                let _ = stream
                    .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await;
                let _ = stream.flush().await;
                continue;
            }
            let permit = match sem.clone().try_acquire_owned() {
                Ok(p) => p,
                Err(_) => {
                    // Too many already in flight; shed load rather than queue without bound.
                    let _ = stream
                        .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                    let _ = stream.flush().await;
                    continue;
                }
            };
            let app = app.clone();
            let session_id = session_id.clone();
            tokio::spawn(async move {
                let _permit = permit; // held until this handler finishes, then released
                let mut data = Vec::new();
                let mut chunk = [0u8; 8192];
                // An overall read budget, so a slow-loris or stuck sender can't pin a
                // handler open forever.
                let read_all = async {
                    loop {
                        match stream.read(&mut chunk).await {
                            Ok(0) => break,
                            Ok(n) => {
                                data.extend_from_slice(&chunk[..n]);
                                if let Some(total) = request_complete_len(&data) {
                                    if data.len() >= total {
                                        break;
                                    }
                                }
                                if data.len() > 1_048_576 {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                };
                if tokio::time::timeout(Duration::from_secs(15), read_all).await.is_err() {
                    return; // timed out, so abandon the connection
                }
                if let Some((name, body, content_type)) = parse_trusted_message(&data) {
                    let _ = app.emit(
                        "minibee-viewer://http-message",
                        json!({
                            "sessionId": session_id,
                            "name": name,
                            "body": body,
                            "contentType": content_type,
                        }),
                    );
                }
                let response = concat!(
                    "HTTP/1.1 200 OK\r\n",
                    "Content-Type: application/llsd+xml\r\n",
                    "Content-Length: 25\r\n",
                    "Connection: close\r\n\r\n",
                    "<llsd><map></map></llsd>\n"
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    })
}

/// The full request length (headers plus body) once we know the Content-Length.
fn request_complete_len(data: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(data);
    let hdr_end = text.find("\r\n\r\n")?;
    let body_start = hdr_end + 4;
    let head = &text[..hdr_end];
    let mut content_length = 0usize;
    for line in head.lines() {
        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = rest.trim().parse().unwrap_or(0);
        }
    }
    Some(body_start + content_length)
}

/// Byte offset of the blank-line (CRLFCRLF) separator between headers and body.
fn header_end(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_trusted_message(data: &[u8]) -> Option<(String, String, String)> {
    // Parse the (ASCII) header region and split the body at the RAW byte boundary,
    // so a non-UTF8 body can't shift the header parse or get silently mangled by
    // decoding the whole request in one go. We still surface the body as text
    // (this path carries LLSD-XML); only the body bytes are lossy-decoded.
    let hdr_end = header_end(data)?;
    let head = String::from_utf8_lossy(&data[..hdr_end]);
    let body = String::from_utf8_lossy(&data[hdr_end + 4..]).to_string();
    let request_line = head.lines().next()?;
    if !request_line.to_ascii_uppercase().starts_with("POST ") {
        return None;
    }
    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    let name = HTTP_MSG_PATH
        .captures(path)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())?;
    if body.is_empty() {
        return None;
    }
    let mut content_type = "application/llsd+xml".to_string();
    for line in head.lines() {
        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-type:") {
            content_type = rest.trim().to_string();
        }
    }
    Some((name, body, content_type))
}
