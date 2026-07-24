//! Session engine: turns decoded UDP packets into the responses we send back and
//! the UI-level events we surface, taking over from the frontend `Circuit` +
//! `sl-transport` layer.
//!
//! The heart of it, `route`, is a pure function: hand it the mutable session
//! state and a decoded packet and it hands back a list of `Action`s (packets to
//! send, events to emit). The caller does all the socket / IPC I/O, which keeps
//! the routing logic unit-testable without a live circuit.
//!
//! We're growing this module a message at a time; it isn't wired into the live
//! reader yet, and the cutover happens once the handler set is complete.
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap, HashSet};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};

/// A UI-facing event name; it goes out as `minibee-viewer://<event>`.
pub type EventName = String;

/// A single piece of work that routing a packet produces.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Encode this message and send it out on the circuit.
    Send { name: String, blocks: Value, reliable: bool },
    /// Hand a UI event to the frontend.
    Emit { event: EventName, payload: Value },
    /// Queue these agent ids for name resolution. The IO layer debounces them and
    /// uses the GetDisplayNames cap, falling back to UUIDNameRequest.
    ResolveNames(Vec<String>),
    /// Point the circuit at a new sim and re-handshake, as on a teleport or region cross.
    Retarget {
        sim_ip: String,
        sim_port: u16,
        agent_id: String,
        session_uuid: String,
        circuit_code: u32,
    },
    /// After moving to a different sim, re-fetch that region's capabilities from
    /// the new seed URL and restart the EventQueue against them. This is
    /// best-effort: if it fails, the (already retargeted) UDP circuit still works.
    RefreshCaps { seed_url: String, sim_ip: String },
    /// Accept a ChatterBox conference/ad-hoc invitation through the
    /// ChatSessionRequest cap, so the sim enrolls us and sends the roster plus any
    /// later messages. Skip it and the agent only ever sees a conference's first line.
    AcceptChatSession { session_id: String },
}

impl Action {
    fn send(name: &str, blocks: Value, reliable: bool) -> Action {
        Action::Send { name: name.to_string(), blocks, reliable }
    }
    fn emit(event: &str, payload: Value) -> Action {
        Action::Emit { event: event.to_string(), payload }
    }
}

/// Live session state built up from the circuit. It grows as more handlers are ported.
#[derive(Debug, Default, Clone)]
pub struct SessionState {
    pub agent_id: String,
    pub session_uuid: String,
    pub region_name: String,
    pub region_id: String,
    /// Region grid coords (global/256) and access level. We keep these current
    /// across teleports and region crossings so region and position events carry
    /// them; otherwise the UI map's self-marker and "center on self" stay stuck on
    /// the old region. 0 means "not yet known", so don't overwrite the login value.
    pub region_grid_x: i64,
    pub region_grid_y: i64,
    pub region_access: i64,
    pub handshake_reply_sent: bool,
    /// Resolved display name per agent id, fed by name replies and agent data.
    pub names: HashMap<String, String>,
    /// Last self position we emitted (coarse), used for the 0.25m move threshold.
    pub last_pos: Option<[f64; 3]>,
    pub active_group_id: String,
    pub active_group_title: String,
    /// Current sim endpoint and circuit code, needed for the teleport/region-cross re-handshake.
    pub sim_ip: String,
    pub sim_port: u16,
    pub circuit_code: u32,
    /// Region capability URLs (EventQueueGet, GetDisplayNames, and so on).
    pub caps: HashMap<String, String>,
    /// Groups the agent belongs to (lowercased ids), used for parcel edit-gating.
    pub groups: HashSet<String>,
    /// The agent's group powers (lowercased group id -> GP_* bitmask), so that
    /// editing group land can demand the actual land power rather than mere membership.
    pub group_powers: HashMap<String, u64>,
    /// Wall-clock ms, refreshed by the IO layer before every route() call so that
    /// time-based dedup stays deterministic and testable.
    pub now_ms: u64,
    /// IM content dedup: key -> last-seen ms (1500ms window, capped at 600 entries).
    pub im_dedup: HashMap<String, u64>,
    /// Per-IM-session roster, so the incremental ChatterBoxSessionAgentListUpdates
    /// deltas can be merged into a full snapshot (the UI replaces the list wholesale).
    pub im_rosters: HashMap<String, ImRoster>,
}

/// A chat session's live participant set, built up from delta updates.
#[derive(Debug, Default, Clone)]
pub struct ImRoster {
    /// participant id -> (is_moderator, text-muted). Kept ordered for stable output.
    pub participants: BTreeMap<String, (bool, bool)>,
    /// The local agent's own moderator flag, held onto across deltas that leave it out.
    pub self_moderator: bool,
}

impl SessionState {
    /// Insert a name only when we don't already have one (chat/radar hints).
    fn cache_name(&mut self, id: &str, name: &str) {
        if id.is_empty() || name.trim().is_empty() {
            return;
        }
        self.names.entry(id.to_string()).or_insert_with(|| name.to_string());
    }
    /// An authoritative name reply, so overwrite. Returns true if the label changed.
    pub(crate) fn set_name(&mut self, id: &str, name: &str) -> bool {
        if id.is_empty() || name.trim().is_empty() {
            return false;
        }
        match self.names.get(id) {
            Some(existing) if existing == name => false,
            _ => {
                self.names.insert(id.to_string(), name.to_string());
                true
            }
        }
    }
    fn cached_name(&self, id: &str) -> Option<&str> {
        self.names.get(id).map(|s| s.as_str())
    }

    /// True if this IM key turned up within the 1500ms window, i.e. a duplicate.
    /// Otherwise it records the key and prunes stale or oversized entries.
    fn is_duplicate_im(&mut self, key: &str) -> bool {
        const WINDOW: u64 = 1500;
        const CAP: usize = 600;
        let now = self.now_ms;
        if let Some(&last) = self.im_dedup.get(key) {
            if now.saturating_sub(last) < WINDOW {
                return true;
            }
        }
        self.im_dedup.retain(|_, &mut t| now.saturating_sub(t) < WINDOW);
        if self.im_dedup.len() >= CAP {
            self.im_dedup.clear();
        }
        self.im_dedup.insert(key.to_string(), now);
        false
    }
}

/// Join a legacy "First Last" name; a "Resident" last name collapses to just the first.
fn resident_name(first: &str, last: &str) -> String {
    let first = first.trim();
    let last = last.trim();
    if last.is_empty() || last.eq_ignore_ascii_case("Resident") {
        first.to_string()
    } else {
        format!("{first} {last}").trim().to_string()
    }
}

fn as_i64(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

/// LLSD booleans usually arrive as a JSON bool, but some sims (OpenSim) send a
/// 0/1 integer instead, so accept both, mirroring the reference viewer's LLSD::asBoolean.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().map(|i| i != 0).unwrap_or(false),
        Some(Value::String(s)) => s == "1" || s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn as_f64(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// A decoded Vec3 field comes through as `[f32;3]`.
fn vec3(v: Option<&Value>) -> (f64, f64, f64) {
    if let Some(Value::Array(a)) = v {
        let g = |i: usize| a.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0);
        (g(0), g(1), g(2))
    } else {
        (0.0, 0.0, 0.0)
    }
}

/// An EventQueue IPADDR arrives as a 4-byte LLSD binary array (`[a,b,c,d]`), though
/// some paths send it as a dotted string. Either way, normalize to `"a.b.c.d"`.
fn llsd_ip(v: Option<&Value>) -> String {
    match v {
        Some(Value::Array(a)) if a.len() == 4 => a
            .iter()
            .map(|n| n.as_u64().unwrap_or(0).to_string())
            .collect::<Vec<_>>()
            .join("."),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// Decode an EventQueue RegionHandle (8-byte big-endian LLSD binary: global X
/// then global Y) into region grid coordinates (global / 256), so the UI map can
/// recenter on the destination region once a teleport lands.
fn llsd_region_grid(v: Option<&Value>) -> Option<(i64, i64)> {
    if let Some(Value::Array(a)) = v {
        if a.len() >= 8 {
            let u32be = |o: usize| -> i64 {
                (0..4).fold(0i64, |acc, i| (acc << 8) | (a[o + i].as_i64().unwrap_or(0) & 0xff))
            };
            return Some((u32be(0) / 256, u32be(4) / 256));
        }
    }
    None
}

/// An EventQueue U64 (e.g. GroupPowers) arrives as an 8-byte big-endian LLSD
/// binary array, though some sims send a plain number. Return a decimal string to
/// match what the UDP handler emits for the same field.
fn llsd_u64_str(v: Option<&Value>) -> String {
    match v {
        Some(Value::Array(a)) => {
            let n = a.iter().take(8).fold(0u64, |acc, b| (acc << 8) | (b.as_u64().unwrap_or(0) & 0xff));
            n.to_string()
        }
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn is_zero_uuid(s: &str) -> bool {
    s.is_empty() || s.chars().all(|c| c == '0' || c == '-')
}

/// Global SL coordinates -> (grid_x, grid_y, local_x, local_y, local_z). A region
/// is 256m, so the grid index is the region corner / 256 and the local coord is
/// the offset within it. This lets the UI show a pick/classified location and
/// teleport there without redoing the math in JS (mirrors FSSlurl.globalToGrid).
fn global_to_grid(gx: f64, gy: f64, gz: f64) -> (i64, i64, i64, i64, i64) {
    let grid_x = (gx / 256.0).floor();
    let grid_y = (gy / 256.0).floor();
    let local_x = (gx - grid_x * 256.0).round() as i64;
    let local_y = (gy - grid_y * 256.0).round() as i64;
    (grid_x as i64, grid_y as i64, local_x, local_y, gz.round() as i64)
}

/// Decode a ScriptQuestion permission mask into human-readable lines plus a caution flag.
fn describe_script_permissions(mask: u32) -> (Vec<String>, bool) {
    const BITS: &[(u32, &str, bool)] = &[
        (2, "Take Linden dollars (L$) from your account", true),
        (4, "Act on your control inputs", false),
        (8, "Remap your control inputs", false),
        (16, "Animate your avatar", false),
        (32, "Attach to your avatar", false),
        (64, "Release ownership", false),
        (128, "Link and delink", false),
        (256, "Add and remove joints", false),
        (512, "Change permissions", false),
        (1024, "Track your camera", false),
        (2048, "Control your camera", false),
        (4096, "Teleport your agent", false),
        (8192, "Join an experience", false),
        (16384, "Silently manage estate access", false),
        (32768, "Override your animations", false),
        (65536, "Return objects on your land", false),
        (131072, "Force sit your avatar", false),
        (262144, "Change environment settings", false),
        (524288, "Privileged land access", true),
    ];
    let mut lines = Vec::new();
    let mut caution = false;
    for &(bit, label, c) in BITS {
        if mask & bit != 0 {
            lines.push(label.to_string());
            if c {
                caution = true;
            }
        }
    }
    if lines.is_empty() && mask != 0 {
        lines.push(format!("Unknown permission flags (0x{mask:x})"));
    }
    (lines, caution)
}

// Parcel flag bits - just the subset the UI surfaces.
mod pflag {
    pub const FLY: u32 = 1 << 0;
    pub const OTHER_SCRIPTS: u32 = 1 << 1;
    pub const TERRAFORM: u32 = 1 << 4;
    pub const DAMAGE: u32 = 1 << 5;
    pub const CREATE_OBJECTS: u32 = 1 << 6;
    pub const ACCESS_GROUP: u32 = 1 << 8;
    pub const ACCESS_LIST: u32 = 1 << 9;
    pub const PASS_LIST: u32 = 1 << 11;
    pub const SHOW_DIR: u32 = 1 << 12;
    pub const SOUND_LOCAL: u32 = 1 << 15;
    pub const RESTRICT_PUSH: u32 = 1 << 21;
    pub const GROUP_SCRIPTS: u32 = 1 << 25;
    pub const CREATE_GROUP_OBJ: u32 = 1 << 26;
    pub const VOICE: u32 = 1 << 29;
}

fn set_flag(flags: u32, bit: u32, on: bool) -> u32 {
    if on { flags | bit } else { flags & !bit }
}

/// Fold the About-Land checkbox booleans (from the UI's update payload) onto the
/// parcel's CURRENT flags, so that a save preserves every bit the UI doesn't
/// manage (mature/publish, landmark, allow-terraform, etc.) instead of zeroing
/// them - the payload only carries the handful of booleans the form exposes. Each
/// field toggles its bit only when it's present. `safeEnvironment` is the inverse
/// of DAMAGE.
pub fn fold_parcel_flags(baseline: u32, p: &Value) -> u32 {
    let mut f = baseline;
    let b = |k: &str| p.get(k).and_then(|v| v.as_bool());
    if let Some(v) = b("allowFly") { f = set_flag(f, pflag::FLY, v); }
    if let Some(v) = b("allowScriptsEveryone") { f = set_flag(f, pflag::OTHER_SCRIPTS, v); }
    if let Some(v) = b("allowScriptsGroup") { f = set_flag(f, pflag::GROUP_SCRIPTS, v); }
    if let Some(v) = b("allowBuildEveryone") { f = set_flag(f, pflag::CREATE_OBJECTS, v); }
    if let Some(v) = b("allowBuildGroup") { f = set_flag(f, pflag::CREATE_GROUP_OBJ, v); }
    if let Some(v) = b("safeEnvironment") { f = set_flag(f, pflag::DAMAGE, !v); }
    if let Some(v) = b("soundLocal") { f = set_flag(f, pflag::SOUND_LOCAL, v); }
    if let Some(v) = b("allowVoice") { f = set_flag(f, pflag::VOICE, v); }
    if let Some(v) = b("showInSearch") { f = set_flag(f, pflag::SHOW_DIR, v); }
    if let Some(v) = b("pushRestricted") { f = set_flag(f, pflag::RESTRICT_PUSH, v); }
    if let Some(v) = b("sellPasses") { f = set_flag(f, pflag::PASS_LIST, v); }
    f
}

/// Compare two UUIDs ignoring case and formatting (decoded ids are lowercase, but
/// login ids may differ).
fn same_uuid(a: &str, b: &str) -> bool {
    a.trim().trim_matches(|c| c == '{' || c == '}').eq_ignore_ascii_case(b.trim().trim_matches(|c| c == '{' || c == '}'))
}

/// The region descriptor we emit with region/position events. Grid coords and
/// access go in only once they're known (nonzero), so an early handshake doesn't
/// clobber the coords the login already gave us.
fn region_obj(state: &SessionState) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("name".into(), json!(state.region_name));
    m.insert("id".into(), json!(state.region_id));
    m.insert("regionId".into(), json!(state.region_id));
    if state.region_grid_x != 0 || state.region_grid_y != 0 {
        m.insert("x".into(), json!(state.region_grid_x));
        m.insert("y".into(), json!(state.region_grid_y));
        m.insert("gridX".into(), json!(state.region_grid_x));
        m.insert("gridY".into(), json!(state.region_grid_y));
        m.insert("globalX".into(), json!(state.region_grid_x * 256));
        m.insert("globalY".into(), json!(state.region_grid_y * 256));
    }
    if state.region_access != 0 {
        m.insert("access".into(), json!(state.region_access));
    }
    Value::Object(m)
}

/// A system chat line; the IO layer stamps in the id and timestamp.
fn system_chat(text: &str) -> Action {
    Action::emit(
        "chat",
        json!({
            "fromId": "00000000-0000-0000-0000-000000000000", "fromName": "System",
            "text": text, "type": "normal", "source": "system", "ownerId": "", "channel": 0,
        }),
    )
}

fn chat_type_name(n: u64) -> &'static str {
    match n {
        0 => "whisper",
        2 => "shout",
        _ => "normal",
    }
}

/// A deterministic P2P session id: the two agent uuids XORed together.
fn xor_session_id(a: &str, b: &str) -> String {
    fn to_u128(s: &str) -> u128 {
        u128::from_str_radix(&s.replace('-', ""), 16).unwrap_or(0)
    }
    let x = to_u128(a) ^ to_u128(b);
    let h = format!("{x:032x}");
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// Strip a trailing SLURL line (maps.secondlife.com / slurl) off a lure message.
fn strip_slurl(text: &str) -> String {
    let mut out = text;
    if let Some(idx) = text.find("\nhttp") {
        out = &text[..idx];
    }
    out.trim().to_string()
}

/// Parse a teleport-lure BinaryBucket of the form `gx|gy|x|y|z|lx|ly|lz[|access]`.
fn parse_lure_bucket(text: &str) -> Option<Value> {
    let parts: Vec<&str> = text.split('|').collect();
    if parts.len() < 8 {
        return None;
    }
    let nums: Vec<f64> = parts.iter().take(8).map(|p| p.trim().parse::<f64>().ok()).collect::<Option<Vec<_>>>()?;
    let to_grid = |n: f64| -> f64 { if n >= 4096.0 { (n / 256.0).floor() } else { n } };
    let access = parts.get(8).map(|a| match a.trim() {
        "A" => "Adult",
        "M" => "Mature",
        _ => "PG",
    });
    Some(json!({
        "gridX": to_grid(nums[0]), "gridY": to_grid(nums[1]),
        "position": { "x": nums[2], "y": nums[3], "z": nums[4] },
        "lookAt": { "x": nums[5], "y": nums[6], "z": nums[7] },
        "regionAccess": access,
    }))
}

// --- decoded-packet field access ------------------------------------------

fn block0<'a>(d: &'a Value, block: &str) -> Option<&'a Value> {
    d.get("blocks")?.get(block)?.get(0)
}

fn field<'a>(d: &'a Value, block: &str, name: &str) -> Option<&'a Value> {
    block0(d, block)?.get(name)
}

/// A Variable/Fixed field decodes to base64, so render it as text and trim the
/// protocol's trailing NUL.
fn field_text(d: &Value, block: &str, name: &str) -> Option<String> {
    field(d, block, name).and_then(inst_text_val)
}

/// Every instance of a (possibly Variable/Multiple) block.
fn block_instances<'a>(d: &'a Value, block: &str) -> &'a [Value] {
    d.get("blocks")
        .and_then(|b| b.get(block))
        .and_then(|a| a.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(&[])
}

fn inst_text_val(v: &Value) -> Option<String> {
    let bytes = B64.decode(v.as_str()?).ok()?;
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    Some(String::from_utf8_lossy(&bytes[..end]).into_owned())
}

/// The text of a Variable/Fixed field inside one specific block instance.
fn inst_text(inst: &Value, name: &str) -> String {
    inst.get(name).and_then(inst_text_val).unwrap_or_default()
}

fn inst_str(inst: &Value, name: &str) -> String {
    inst.get(name).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn inst_i64(inst: &Value, name: &str) -> i64 {
    as_i64(inst.get(name))
}

/// Route a single decoded packet into outbound sends and UI events, updating state as it goes.
pub fn route(state: &mut SessionState, decoded: &Value) -> Vec<Action> {
    let name = decoded.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let mut actions = Vec::new();
    match name {
        // Answer the sim's keepalive, echoing back the same ping id.
        "StartPingCheck" => {
            let ping = field(decoded, "PingID", "PingID").cloned().unwrap_or(json!(0));
            actions.push(Action::send(
                "CompletePingCheck",
                json!({ "PingID": [{ "PingID": ping }] }),
                false,
            ));
        }
        "CompletePingCheck" => {}

        // Nearby / object / system chat. The IO layer stamps `id` and `timestamp`
        // on emit, which keeps routing pure.
        "ChatFromSimulator" => {
            let source_id = field(decoded, "ChatData", "SourceID")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // The sim echoes our own channel-0 chat back (SourceID == us), and that
            // echo IS how a viewer shows what you said - there's no local echo - so
            // render it (flagged outgoing) rather than dropping it.
            let is_self = !state.agent_id.is_empty() && same_uuid(&source_id, &state.agent_id);
            // ChatType START(4)/STOP(5) are just typing pings, so no transcript line.
            let chat_type = field(decoded, "ChatData", "ChatType").and_then(|v| v.as_u64()).unwrap_or(1);
            if chat_type == 4 || chat_type == 5 {
                return actions;
            }
            // Audible 255 (== -1) means out of range, so there's nothing to render.
            let audible = field(decoded, "ChatData", "Audible").and_then(|v| v.as_u64()).unwrap_or(1);
            if audible == 255 {
                return actions;
            }
            // EChatSourceType: 1 is agent, 2 is object, anything else is system.
            let source_type = field(decoded, "ChatData", "SourceType").and_then(|v| v.as_u64()).unwrap_or(0);
            let source = match source_type {
                1 => "agent",
                2 => "object",
                _ => "system",
            };
            let raw_name = field_text(decoded, "ChatData", "FromName").unwrap_or_default();
            let text = field_text(decoded, "ChatData", "Message").unwrap_or_default();
            let owner_id = if source == "object" {
                field(decoded, "ChatData", "OwnerID").and_then(|v| v.as_str()).unwrap_or("").to_string()
            } else {
                String::new()
            };
            if source == "agent" {
                state.cache_name(&source_id, &raw_name);
            }
            let from_name = if source == "agent" {
                state.cached_name(&source_id).unwrap_or(&raw_name).to_string()
            } else {
                raw_name
            };
            actions.push(Action::emit(
                "chat",
                json!({
                    "fromId": source_id,
                    "fromName": from_name,
                    "text": text,
                    "type": chat_type_name(chat_type),
                    "source": source,
                    "ownerId": owner_id,
                    "channel": 0,
                    "outgoing": is_self,
                }),
            ));
        }

        // Instant messages fan out by dialog code into IM, typing, or teleport.
        "ImprovedInstantMessage" => {
            return route_im(state, decoded);
        }

        // A balance update, plus payment metadata when it's part of a transaction.
        "MoneyBalanceReply" => {
            actions.push(Action::emit(
                "money-balance",
                json!({
                    "balance": as_i64(field(decoded, "MoneyData", "MoneyBalance")),
                    "landCredit": as_i64(field(decoded, "MoneyData", "SquareMetersCredit")),
                    "landCommitted": as_i64(field(decoded, "MoneyData", "SquareMetersCommitted")),
                    "description": field_text(decoded, "MoneyData", "Description").unwrap_or_default(),
                    "transactionType": as_i64(field(decoded, "TransactionInfo", "TransactionType")),
                }),
            ));
        }

        // Our own agent data, including the active group and its title.
        "AgentDataUpdate" => {
            let id = inst_str(block0(decoded, "AgentData").unwrap_or(&Value::Null), "AgentID");
            let name = resident_name(
                &field_text(decoded, "AgentData", "FirstName").unwrap_or_default(),
                &field_text(decoded, "AgentData", "LastName").unwrap_or_default(),
            );
            if state.set_name(&id, &name) {
                actions.push(Action::emit("names-updated", json!({ "names": [{ "id": id, "name": name }] })));
            }
            let active = inst_str(block0(decoded, "AgentData").unwrap_or(&Value::Null), "ActiveGroupID");
            let title = field_text(decoded, "AgentData", "GroupTitle").unwrap_or_default();
            let group_name = field_text(decoded, "AgentData", "GroupName").unwrap_or_default();
            let norm_active = if same_uuid(&active, "00000000-0000-0000-0000-000000000000") { String::new() } else { active };
            crate::dlog!("AgentDataUpdate: activeGroup={} title='{}'", norm_active, title);
            if norm_active != state.active_group_id || title != state.active_group_title {
                state.active_group_id = norm_active.clone();
                state.active_group_title = title.clone();
                actions.push(Action::emit(
                    "active-group",
                    json!({ "id": norm_active, "name": group_name, "title": title }),
                ));
            }
        }

        // Name lookups, delivered as batched replies.
        "UUIDNameReply" => {
            let mut changed = Vec::new();
            for inst in block_instances(decoded, "UUIDNameBlock") {
                let id = inst_str(inst, "ID");
                let name = resident_name(&inst_text(inst, "FirstName"), &inst_text(inst, "LastName"));
                if state.set_name(&id, &name) {
                    changed.push(json!({ "id": id, "name": name }));
                }
            }
            if !changed.is_empty() {
                actions.push(Action::emit("names-updated", json!({ "names": changed })));
            }
        }

        // A simulator alert, which we surface as a system chat line.
        // AgentAlertMessage carries the same AlertData.Message as AlertMessage
        // (agent-directed notices like "not allowed on this land").
        "AlertMessage" | "AgentAlertMessage" => {
            let text = field_text(decoded, "AlertData", "Message").unwrap_or_default();
            let text = text.trim();
            if !text.is_empty() {
                actions.push(Action::emit(
                    "chat",
                    json!({
                        "fromId": "00000000-0000-0000-0000-000000000000",
                        "fromName": "System", "text": text, "type": "normal",
                        "source": "system", "ownerId": "", "channel": 0,
                    }),
                ));
            }
        }

        // Nearby-avatar positions for the radar, plus our own coarse position.
        "CoarseLocationUpdate" => {
            let locs = block_instances(decoded, "Location");
            let agents = block_instances(decoded, "AgentData");
            let you = as_i64(field(decoded, "Index", "You"));
            let loc_pos = |i: usize| -> Option<(f64, f64, f64, bool)> {
                locs.get(i).map(|l| {
                    let rz = inst_i64(l, "Z");
                    (inst_i64(l, "X") as f64, inst_i64(l, "Y") as f64, rz as f64 * 4.0, rz == 0 || rz == 255)
                })
            };
            let self_pos = if you >= 0 { loc_pos(you as usize).map(|(x, y, z, _)| [x, y, z]) } else { None };
            if let Some(sp) = self_pos {
                let moved = state
                    .last_pos
                    .map_or(true, |p| (p[0] - sp[0]).abs() > 0.25 || (p[1] - sp[1]).abs() > 0.25 || (p[2] - sp[2]).abs() > 0.25);
                if moved {
                    state.last_pos = Some(sp);
                    actions.push(Action::emit(
                        "position",
                        json!({
                            "position": { "x": sp[0], "y": sp[1], "z": sp[2] },
                            "region": region_obj(state),
                            "source": "coarse",
                        }),
                    ));
                }
            }
            let sp = self_pos.unwrap_or([128.0, 128.0, 25.0]);
            let mut entries = Vec::new();
            let mut resolve = Vec::new();
            for (i, inst) in agents.iter().enumerate() {
                if you >= 0 && i == you as usize {
                    continue;
                }
                let id = inst_str(inst, "AgentID");
                if id.is_empty()
                    || same_uuid(&id, &state.agent_id)
                    || same_uuid(&id, "00000000-0000-0000-0000-000000000000")
                {
                    continue;
                }
                let (x, y, z, unknown) = loc_pos(i).unwrap_or((0.0, 0.0, 0.0, true));
                let range = if unknown {
                    (x - sp[0]).hypot(y - sp[1]).round()
                } else {
                    (((x - sp[0]).powi(2) + (y - sp[1]).powi(2) + (z - sp[2]).powi(2)).sqrt()).round()
                };
                let name = state.cached_name(&id).unwrap_or("").to_string();
                if name.is_empty() {
                    resolve.push(id.clone());
                }
                entries.push(json!({
                    "id": id, "name": name, "pos": { "x": x, "y": y, "z": z },
                    "range": range, "unknownZ": unknown, "age": "?", "status": "",
                }));
            }
            actions.push(Action::emit("radar-update", json!(entries)));
            if !resolve.is_empty() {
                actions.push(Action::ResolveNames(resolve));
            }
        }

        // Full parcel data for the parcel the agent is standing on.
        "ParcelProperties" => {
            let pd = block0(decoded, "ParcelData").cloned().unwrap_or(Value::Null);
            if inst_i64(&pd, "RequestResult") == -1 {
                return actions; // the sim has no parcel data here
            }
            let flags = inst_i64(&pd, "ParcelFlags") as u32;
            let has = |b: u32| flags & b != 0;
            let bonus = {
                let b = as_f64(pd.get("ParcelPrimBonus"));
                if b > 0.0 { b } else { 1.0 }
            };
            let used = inst_i64(&pd, "OwnerPrims") + inst_i64(&pd, "GroupPrims")
                + inst_i64(&pd, "OtherPrims") + inst_i64(&pd, "SelectedPrims");
            let capacity = (inst_i64(&pd, "MaxPrims") as f64 * bonus).round() as i64;
            let owner_id = inst_str(&pd, "OwnerID");
            let group_id = inst_str(&pd, "GroupID");
            let snapshot = inst_str(&pd, "SnapshotID");
            let (ux, uy, uz) = vec3(pd.get("UserLocation"));
            let (lx, ly, _lz) = vec3(pd.get("UserLookAt"));
            // Landing heading in degrees (0-360), derived from the look-at vector for
            // the About Land Options tab; 0 when no landing direction is set.
            let landing_heading = if lx == 0.0 && ly == 0.0 {
                0.0
            } else {
                (ly.atan2(lx).to_degrees() + 360.0) % 360.0
            };
            let access = if has(pflag::ACCESS_LIST) { 1 } else if has(pflag::ACCESS_GROUP) { 2 } else { 0 };
            let is_group_owned = pd.get("IsGroupOwned").and_then(|v| v.as_bool()).unwrap_or(false);
            // Editable if you own it, or, for group land, if you belong to the owning
            // group. The sim enforces the actual land powers, and our update just
            // round-trips the current data, so a rejected attempt changes nothing.
            const GOVERNOR_LINDEN: &str = "3d6181b0-6a4b-97ef-18d8-722652995cf1";
            // GP_LAND_CHANGE_IDENTITY (roles_constants.h) is the group power that lets
            // you edit a parcel's identity/options in About Land.
            const GP_LAND_CHANGE_IDENTITY: u64 = 1 << 18;
            let can_edit = if owner_id.is_empty() || same_uuid(&owner_id, GOVERNOR_LINDEN) {
                false
            } else if is_group_owned {
                // Group land needs the actual land power, not just membership - a
                // plain member can't edit, so their fields have to stay disabled
                // (this matches LLParcel / About Land in the reference viewer).
                state
                    .group_powers
                    .get(&owner_id.to_lowercase())
                    .is_some_and(|p| p & GP_LAND_CHANGE_IDENTITY != 0)
            } else {
                same_uuid(&owner_id, &state.agent_id)
            };
            let snapshot_url = if is_zero_uuid(&snapshot) {
                String::new()
            } else {
                format!("https://secondlife.com/app/image/{snapshot}/256")
            };
            actions.push(Action::emit(
                "parcel",
                json!({
                    "localId": inst_i64(&pd, "LocalID"),
                    "name": inst_text(&pd, "Name"),
                    "desc": inst_text(&pd, "Desc"),
                    "area": inst_i64(&pd, "Area"),
                    "primsUsed": used,
                    "primsTotal": if capacity > 0 { capacity } else { inst_i64(&pd, "MaxPrims") },
                    "parcelPrimBonus": bonus,
                    "ownerPrims": inst_i64(&pd, "OwnerPrims"),
                    "groupPrims": inst_i64(&pd, "GroupPrims"),
                    "otherPrims": inst_i64(&pd, "OtherPrims"),
                    "simWideTotalPrims": inst_i64(&pd, "SimWideTotalPrims"),
                    "simWideMaxPrims": inst_i64(&pd, "SimWideMaxPrims"),
                    "ownerId": owner_id,
                    "ownerName": state.cached_name(&inst_str(&pd, "OwnerID")).unwrap_or("").to_string(),
                    "isGroupOwned": is_group_owned,
                    "groupId": group_id,
                    "parcelFlags": flags,
                    "access": access,
                    "pushRestricted": has(pflag::RESTRICT_PUSH),
                    "allowBuild": has(pflag::CREATE_OBJECTS) || has(pflag::CREATE_GROUP_OBJ),
                    "allowBuildEveryone": has(pflag::CREATE_OBJECTS),
                    "allowBuildGroup": has(pflag::CREATE_GROUP_OBJ),
                    "allowScripts": has(pflag::OTHER_SCRIPTS) || has(pflag::GROUP_SCRIPTS),
                    "allowScriptsEveryone": has(pflag::OTHER_SCRIPTS),
                    "allowScriptsGroup": has(pflag::GROUP_SCRIPTS),
                    "allowFly": has(pflag::FLY),
                    "allowTerraform": has(pflag::TERRAFORM),
                    "safeEnvironment": !has(pflag::DAMAGE),
                    "soundLocal": has(pflag::SOUND_LOCAL),
                    "allowVoice": has(pflag::VOICE),
                    "showInSearch": has(pflag::SHOW_DIR),
                    "sellPasses": has(pflag::PASS_LIST),
                    "musicUrl": inst_text(&pd, "MusicURL"),
                    "mediaUrl": inst_text(&pd, "MediaURL"),
                    "mediaId": inst_str(&pd, "MediaID"),
                    "mediaAutoScale": inst_i64(&pd, "MediaAutoScale"),
                    "mediaType": field_text(decoded, "MediaData", "MediaType").unwrap_or_default(),
                    "mediaDesc": field_text(decoded, "MediaData", "MediaDesc").unwrap_or_default(),
                    "salePrice": inst_i64(&pd, "SalePrice"),
                    "passPrice": inst_i64(&pd, "PassPrice"),
                    "passHours": as_f64(pd.get("PassHours")),
                    "category": inst_i64(&pd, "Category"),
                    "authBuyerId": inst_str(&pd, "AuthBuyerID"),
                    "snapshotId": snapshot,
                    "snapshotUrl": snapshot_url,
                    "landingPoint": { "x": ux.round(), "y": uy.round(), "z": uz.round() },
                    "landingHeading": landing_heading.round(),
                    "landingType": inst_i64(&pd, "LandingType"),
                    "claimDate": inst_i64(&pd, "ClaimDate"),
                    "otherCleanTime": inst_i64(&pd, "OtherCleanTime"),
                    "canEdit": can_edit,
                    "source": "udp",
                    "stub": false,
                }),
            ));
        }

        // Map region blocks: region names plus per-tile agent counts.
        "MapBlockReply" => {
            let mut out = Vec::new();
            for d in block_instances(decoded, "Data") {
                out.push(json!({
                    "gridX": inst_i64(d, "X"),
                    "gridY": inst_i64(d, "Y"),
                    "name": inst_text(d, "Name"),
                    "access": inst_i64(d, "Access"),
                    "regionFlags": inst_i64(d, "RegionFlags"),
                    "agents": inst_i64(d, "Agents"),
                }));
            }
            if !out.is_empty() {
                // Diagnostic for stale or wrong map region names after a teleport:
                // log the grid coords and names the sim actually returned, so we can
                // tell whether the block coords or the names are the ones that are off.
                crate::dlog!(
                    "MapBlockReply: {} region(s), sample=[{}]",
                    out.len(),
                    out.iter().take(5).map(|b| format!("({},{})='{}' acc={}",
                        b["gridX"].as_i64().unwrap_or(-1), b["gridY"].as_i64().unwrap_or(-1),
                        b["name"].as_str().unwrap_or(""), b["access"].as_i64().unwrap_or(-1)))
                        .collect::<Vec<_>>().join(", ")
                );
                for b in &out {
                    if b["agents"].as_i64().unwrap_or(0) > 0 {
                        actions.push(Action::emit(
                            "map-agents",
                            json!({ "gridX": b["gridX"], "gridY": b["gridY"], "agents": b["agents"] }),
                        ));
                    }
                }
                actions.push(Action::emit("map-blocks", json!(out)));
            }
        }

        // Per-region live agent counts, from the map's periodic refresh. ItemType 6
        // is MAP_ITEM_AGENT_LOCATIONS; each Data block is a cluster at global X/Y
        // holding `Extra` agents. Sum them per region (gridX = X/256) and emit
        // map-agents in the same shape MapBlockReply uses.
        "MapItemReply" => {
            if as_i64(field(decoded, "RequestData", "ItemType")) == 6 {
                let mut counts: HashMap<(i64, i64), i64> = HashMap::new();
                for d in block_instances(decoded, "Data") {
                    let x = inst_i64(d, "X");
                    let y = inst_i64(d, "Y");
                    if x == 0 && y == 0 {
                        continue;
                    }
                    let extra = inst_i64(d, "Extra");
                    *counts.entry((x / 256, y / 256)).or_insert(0) += if extra > 0 { extra } else { 1 };
                }
                for ((gx, gy), agents) in counts {
                    actions.push(Action::emit(
                        "map-agents",
                        json!({ "gridX": gx, "gridY": gy, "agents": agents }),
                    ));
                }
            }
        }

        // A script dialog prompt. We surface it for the user and NEVER auto-answer it.
        "ScriptDialog" => {
            let object_id = inst_str(block0(decoded, "Data").unwrap_or(&Value::Null), "ObjectID");
            let object_name = field_text(decoded, "Data", "ObjectName").unwrap_or_default();
            let message = field_text(decoded, "Data", "Message").unwrap_or_default();
            let owner_first = field_text(decoded, "Data", "FirstName").unwrap_or_default();
            let owner_last = field_text(decoded, "Data", "LastName").unwrap_or_default();
            let owner_id = inst_str(block0(decoded, "OwnerData").unwrap_or(&Value::Null), "OwnerID");
            let is_group = owner_first.trim().is_empty() && !owner_last.trim().is_empty();
            let owner_name = resident_name(&owner_first, &owner_last);
            let channel = inst_i64(block0(decoded, "Data").unwrap_or(&Value::Null), "ChatChannel");
            let buttons: Vec<String> = block_instances(decoded, "Buttons")
                .iter()
                .map(|b| inst_text(b, "ButtonLabel"))
                .filter(|s| !s.is_empty())
                .collect();
            // llTextBox() arrives as a ScriptDialog whose single button label is a
            // sentinel, so render it as a free-text input rather than a literal button.
            const TEXTBOX_MAGIC_TOKEN: &str = "!!llTextBox!!";
            let is_text_box = buttons.len() == 1 && buttons[0] == TEXTBOX_MAGIC_TOKEN;
            let buttons = if is_text_box { Vec::new() } else { buttons };
            let name = if object_name.trim().is_empty() { "Object".to_string() } else { object_name };
            if !owner_id.is_empty() && !is_zero_uuid(&owner_id) && !is_group {
                actions.push(Action::ResolveNames(vec![owner_id.clone()]));
            }
            actions.push(Action::emit(
                "event",
                json!({
                    "kind": "script-dialog", "fromId": object_id, "fromName": name,
                    "text": if message.trim().is_empty() { "(no message)".to_string() } else { message.clone() },
                    "type": "script", "source": "script", "channel": channel,
                    "dialog": {
                        "objectId": object_id, "objectName": name,
                        "ownerId": if is_zero_uuid(&owner_id) { String::new() } else { owner_id },
                        "ownerName": owner_name, "isGroup": is_group,
                        "message": message, "chatChannel": channel, "buttons": buttons,
                        "isTextBox": is_text_box, "resolved": false, "response": "",
                    }
                }),
            ));
        }

        // A script permission request. We surface it for the user and NEVER auto-answer it.
        "ScriptQuestion" => {
            let d = block0(decoded, "Data").cloned().unwrap_or(Value::Null);
            let task_id = inst_str(&d, "TaskID");
            let item_id = inst_str(&d, "ItemID");
            if task_id.is_empty() || item_id.is_empty() {
                return actions;
            }
            let name = {
                let n = inst_text(&d, "ObjectName");
                if n.trim().is_empty() { "Object".to_string() } else { n }
            };
            let questions = inst_i64(&d, "Questions") as u32;
            let (lines, caution) = describe_script_permissions(questions);
            let text = if lines.is_empty() {
                "Permission request".to_string()
            } else {
                format!("Permission request: {}", lines.join("; "))
            };
            actions.push(Action::emit(
                "event",
                json!({
                    "kind": "script-permission", "fromId": task_id, "fromName": name,
                    "text": text, "type": "script", "source": "script", "channel": 0,
                    "permission": {
                        "taskId": task_id, "itemId": item_id, "objectName": name,
                        "objectOwner": inst_text(&d, "ObjectOwner"), "questions": questions,
                        "lines": lines, "hasCaution": caution, "resolved": false, "response": "",
                    }
                }),
            ));
        }

        // An object wants to open a URL, so we surface it as an interactive prompt.
        "LoadURL" => {
            let d = block0(decoded, "Data").cloned().unwrap_or(Value::Null);
            let url = inst_text(&d, "URL");
            if url.trim().is_empty() {
                return actions;
            }
            let owner_id = inst_str(&d, "OwnerID");
            let object_name = {
                let n = inst_text(&d, "ObjectName");
                if n.trim().is_empty() { "Object".to_string() } else { n }
            };
            let message = inst_text(&d, "Message");
            if !owner_id.is_empty() && !is_zero_uuid(&owner_id) {
                actions.push(Action::ResolveNames(vec![owner_id.clone()]));
            }
            let owner_name = state.cached_name(&owner_id).unwrap_or("").to_string();
            let text = if message.trim().is_empty() { format!("Open {url}?") } else { message.clone() };
            actions.push(Action::emit(
                "event",
                json!({
                    "kind": "interactive-prompt", "fromId": inst_str(&d, "ObjectID"),
                    "fromName": object_name, "text": text, "type": "script", "source": "script", "channel": 0,
                    "prompt": {
                        "type": "load-url", "objectName": object_name, "ownerId": owner_id,
                        "ownerName": owner_name, "ownerIsGroup": d.get("OwnerIsGroup").and_then(|v| v.as_bool()).unwrap_or(false),
                        "message": message, "url": url, "resolved": false, "response": "",
                    }
                }),
            ));
        }

        // The group's active-title choices, which feed the title dropdown.
        "GroupTitlesReply" => {
            let group_id = inst_str(block0(decoded, "AgentData").unwrap_or(&Value::Null), "GroupID");
            if is_zero_uuid(&group_id) {
                return actions;
            }
            // Keep every title the agent may wear, blanks included - a group's
            // default/Everyone title is often empty, and the UI shows a "(no title)"
            // placeholder for those. Dropping the empties hid the default title from
            // the picker.
            let mut titles: Vec<Value> = block_instances(decoded, "GroupData")
                .iter()
                .map(|g| {
                    json!({
                        "title": inst_text(g, "Title"),
                        "roleId": inst_str(g, "RoleID"),
                        "selected": g.get("Selected").and_then(|v| v.as_bool()).unwrap_or(false),
                    })
                })
                .collect();
            // Sort alphabetically, case-insensitive, with the blank/default title first.
            titles.sort_by(|a, b| {
                let ta = a.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let tb = b.get("title").and_then(|v| v.as_str()).unwrap_or("");
                (!ta.is_empty(), ta.to_lowercase()).cmp(&(!tb.is_empty(), tb.to_lowercase()))
            });
            actions.push(Action::emit(
                "group-titles",
                json!({
                    "groupId": group_id,
                    "requestId": inst_str(block0(decoded, "AgentData").unwrap_or(&Value::Null), "RequestID"),
                    "titles": titles,
                }),
            ));
        }

        // Results of joining or leaving a group.
        "JoinGroupReply" | "LeaveGroupReply" => {
            let g = block0(decoded, "GroupData").cloned().unwrap_or(Value::Null);
            actions.push(Action::emit(
                "group-action",
                json!({
                    "groupId": inst_str(&g, "GroupID"),
                    "action": if name == "JoinGroupReply" { "join" } else { "leave" },
                    "success": g.get("Success").and_then(|v| v.as_bool()).unwrap_or(false),
                }),
            ));
        }

        // Our own group membership (this also arrives via HTTP trusted-message).
        "AgentGroupDataUpdate" => {
            let agent = inst_str(block0(decoded, "AgentData").unwrap_or(&Value::Null), "AgentID");
            if !agent.is_empty() && !same_uuid(&agent, &state.agent_id) {
                return actions; // this update isn't about us
            }
            let mut ids = HashSet::new();
            let mut powers = HashMap::new();
            let groups: Vec<Value> = block_instances(decoded, "GroupData")
                .iter()
                .filter_map(|g| {
                    let id = inst_str(g, "GroupID");
                    if is_zero_uuid(&id) {
                        return None;
                    }
                    ids.insert(id.to_lowercase());
                    let power_str = inst_str(g, "GroupPowers");
                    powers.insert(id.to_lowercase(), power_str.parse::<u64>().unwrap_or(0));
                    Some(json!({
                        "id": id, "name": inst_text(g, "GroupName"),
                        "insigniaId": inst_str(g, "GroupInsigniaID"),
                        "powers": power_str,
                        "acceptNotices": g.get("AcceptNotices").and_then(|v| v.as_bool()).unwrap_or(false),
                        "contribution": inst_i64(g, "Contribution"),
                    }))
                })
                .collect();
            state.groups = ids;
            state.group_powers = powers;
            actions.push(Action::emit("group-membership", json!({ "groups": groups })));
        }

        // An object asks to map or teleport somewhere, shown as an interactive prompt.
        "ScriptTeleportRequest" => {
            let d = block0(decoded, "Data").cloned().unwrap_or(Value::Null);
            let object_name = {
                let n = inst_text(&d, "ObjectName");
                if n.trim().is_empty() { "Object".to_string() } else { n }
            };
            let region = {
                let n = inst_text(&d, "SimName");
                if n.trim().is_empty() { "Region".to_string() } else { n }
            };
            let (px, py, pz) = vec3(d.get("SimPosition"));
            let (lx, ly, lz) = vec3(d.get("LookAt"));
            let flags = as_i64(field(decoded, "Options", "Flags"));
            actions.push(Action::emit(
                "event",
                json!({
                    "kind": "interactive-prompt", "fromId": "", "fromName": object_name,
                    "text": format!("{region} ({}, {}, {:.1})", px.round(), py.round(), pz),
                    "type": "script", "source": "script", "channel": 0,
                    "prompt": {
                        "type": "script-teleport", "objectName": object_name, "regionName": region,
                        "position": { "x": px, "y": py, "z": pz },
                        "lookAt": { "x": lx, "y": ly, "z": lz }, "flags": flags,
                        "resolved": false, "response": "",
                    }
                }),
            ));
        }

        // Someone offers us a friendship via a calling card, shown as an interactive prompt.
        "OfferCallingCard" => {
            let source_id = inst_str(block0(decoded, "AgentData").unwrap_or(&Value::Null), "AgentID");
            let ab = block0(decoded, "AgentBlock").cloned().unwrap_or(Value::Null);
            let transaction_id = inst_str(&ab, "TransactionID");
            if is_zero_uuid(&transaction_id) {
                return actions;
            }
            if !source_id.is_empty() && !is_zero_uuid(&source_id) {
                actions.push(Action::ResolveNames(vec![source_id.clone()]));
            }
            let from_name = state.cached_name(&source_id).unwrap_or("Someone").to_string();
            actions.push(Action::emit(
                "event",
                json!({
                    "kind": "interactive-prompt", "fromId": source_id, "fromName": from_name,
                    "text": format!("{from_name} offered a friendship card."),
                    "type": "script", "source": "script", "channel": 0,
                    "prompt": {
                        "type": "calling-card", "sourceId": source_id, "destId": inst_str(&ab, "DestID"),
                        "transactionId": transaction_id, "fromName": from_name, "resolved": false, "response": "",
                    }
                }),
            ));
        }

        // The other side answered our friendship offer.
        "AcceptCallingCard" => actions.push(system_chat("Your friendship offer was accepted.")),
        "DeclineCallingCard" => actions.push(system_chat("Your friendship offer was declined.")),

        // A region performance sample, roughly once a second. StatID 1 is the sim's
        // frame rate and 0 is the time dilation (llviewerstats.h); the top bar shows the FPS.
        "SimStats" => {
            let mut fps = 0.0_f64;
            let mut dilation = 1.0_f64;
            for s in block_instances(decoded, "Stat") {
                match inst_i64(s, "StatID") {
                    0 => dilation = as_f64(s.get("StatValue")),
                    1 => fps = as_f64(s.get("StatValue")),
                    _ => {}
                }
            }
            actions.push(Action::emit(
                "stats",
                json!({ "fps": fps.round(), "timeDilation": dilation }),
            ));
        }

        // Friends coming online or going offline. The frontend owns the roster, so we
        // hand it just the changed ids and let it flip presence and re-render.
        "OnlineNotification" | "OfflineNotification" => {
            let online = name == "OnlineNotification";
            let ids: Vec<String> = block_instances(decoded, "AgentBlock")
                .iter()
                .map(|b| inst_str(b, "AgentID"))
                .filter(|id| !id.is_empty() && !is_zero_uuid(id))
                .collect();
            if !ids.is_empty() {
                actions.push(Action::emit(
                    if online { "buddy-online" } else { "buddy-offline" },
                    json!({ "ids": ids, "online": online }),
                ));
            }
        }

        // The sim froze or unfroze the avatar.
        "ViewerFrozenMessage" => {
            let frozen = field(decoded, "FrozenData", "Data").and_then(|v| v.as_bool()).unwrap_or(false);
            actions.push(system_chat(if frozen { "You have been frozen." } else { "You are no longer frozen." }));
        }

        // A teleport progress note.
        "TeleportProgress" => {
            let message = field_text(decoded, "Info", "Message").unwrap_or_default();
            actions.push(Action::emit("teleport-progress", json!({ "message": message.trim() })));
        }

        // A teleport failure, except "could not teleport closer" actually means we arrived.
        "TeleportFailed" => {
            let reason = field_text(decoded, "Info", "Reason").unwrap_or_default();
            let reason = reason.trim();
            if reason.to_lowercase().contains("could not teleport closer") {
                actions.push(Action::emit("teleport-finish", json!({ "benign": true, "reason": reason })));
            } else {
                actions.push(Action::emit("teleport-failed", json!({ "reason": reason, "source": "udp" })));
            }
        }

        // The sim acknowledged a clean logout.
        "LogoutReply" => actions.push(Action::emit("disconnected", json!({}))),

        // The sim is forcing us to disconnect.
        "KickUser" => {
            let reason = field_text(decoded, "UserInfo", "Reason").unwrap_or_default();
            actions.push(Action::emit("session-lost", json!({ "reason": reason.trim() })));
        }
        "SystemKickUser" => {
            let hit = block_instances(decoded, "AgentInfo").iter().any(|a| {
                let id = inst_str(a, "AgentID");
                state.agent_id.is_empty() || same_uuid(&id, &state.agent_id)
            });
            if hit {
                actions.push(Action::emit("session-lost", json!({ "reason": "You were kicked by the system." })));
            }
        }

        // A feature the sim won't allow, such as object entry being denied.
        "FeatureDisabled" => {
            let msg = field_text(decoded, "FailureInfo", "ErrorMessage").unwrap_or_default();
            if !msg.trim().is_empty() {
                actions.push(system_chat(msg.trim()));
            }
        }

        // The teleport has begun, confirmed by the sim.
        "TeleportStart" => {
            let flags = as_i64(field(decoded, "Info", "TeleportFlags"));
            actions.push(Action::emit("teleport-started", json!({ "flags": flags })));
        }

        // A within-region teleport: it completes immediately, with no sim change.
        "TeleportLocal" => {
            let (px, py, pz) = vec3(field(decoded, "Info", "Position"));
            state.last_pos = Some([px, py, pz]);
            let pos = json!({ "x": px, "y": py, "z": pz });
            actions.push(Action::emit(
                "position",
                json!({ "position": pos, "region": region_obj(state), "source": "teleport" }),
            ));
            actions.push(Action::emit(
                "teleport-finish",
                json!({ "regionName": state.region_name, "position": pos, "simIp": state.sim_ip, "simPort": state.sim_port }),
            ));
        }

        // A teleport to another sim: switch the circuit first, then report arrival.
        "TeleportFinish" => {
            let sim_ip = inst_str(block0(decoded, "Info").unwrap_or(&Value::Null), "SimIP");
            let sim_port = as_i64(field(decoded, "Info", "SimPort")) as u16;
            let handle = inst_str(block0(decoded, "Info").unwrap_or(&Value::Null), "RegionHandle");
            let seed = field_text(decoded, "Info", "SeedCapability").unwrap_or_default();
            if !sim_ip.is_empty() && (sim_ip != state.sim_ip || sim_port != state.sim_port) {
                state.sim_ip = sim_ip.clone();
                state.sim_port = sim_port;
                state.handshake_reply_sent = false; // the new sim triggers a fresh handshake
                actions.push(Action::Retarget {
                    sim_ip: sim_ip.clone(),
                    sim_port,
                    agent_id: state.agent_id.clone(),
                    session_uuid: state.session_uuid.clone(),
                    circuit_code: state.circuit_code,
                });
                if !seed.is_empty() {
                    actions.push(Action::RefreshCaps { seed_url: seed.clone(), sim_ip: sim_ip.clone() });
                }
            }
            actions.push(Action::emit(
                "teleport-finish",
                json!({ "url": seed, "simIp": sim_ip, "simPort": sim_port, "regionHandle": handle, "regionName": state.region_name }),
            ));
        }

        // A region crossing, whether by walking or teleport: switch the circuit and update position.
        "CrossedRegion" => {
            let sim_ip = inst_str(block0(decoded, "RegionData").unwrap_or(&Value::Null), "SimIP");
            let sim_port = as_i64(field(decoded, "RegionData", "SimPort")) as u16;
            let seed = field_text(decoded, "RegionData", "SeedCapability").unwrap_or_default();
            let (px, py, pz) = vec3(field(decoded, "Info", "Position"));
            if !sim_ip.is_empty() && (sim_ip != state.sim_ip || sim_port != state.sim_port) {
                state.sim_ip = sim_ip.clone();
                state.sim_port = sim_port;
                state.handshake_reply_sent = false;
                actions.push(Action::Retarget {
                    sim_ip: sim_ip.clone(),
                    sim_port,
                    agent_id: state.agent_id.clone(),
                    session_uuid: state.session_uuid.clone(),
                    circuit_code: state.circuit_code,
                });
                if !seed.is_empty() {
                    actions.push(Action::RefreshCaps { seed_url: seed, sim_ip });
                }
            }
            state.last_pos = Some([px, py, pz]);
            actions.push(Action::emit(
                "position",
                json!({ "position": { "x": px, "y": py, "z": pz }, "region": region_obj(state), "source": "teleport" }),
            ));
        }

        // The sim confirmed our placement on a (new) region.
        "AgentMovementComplete" => {
            let (px, py, pz) = vec3(field(decoded, "Data", "Position"));
            state.last_pos = Some([px, py, pz]);
            actions.push(Action::emit(
                "position",
                json!({ "position": { "x": px, "y": py, "z": pz }, "region": region_obj(state), "source": "movement" }),
            ));
            // Fetch the initial L$ balance. MoneyBalanceReply only comes back in
            // response to a request - the reference viewer sends one at login with a
            // null TransactionID (llstatusbar.cpp sendMoneyBalanceRequest, triggered
            // from llstartup STATE_INVENTORY_SEND). Without it the balance never
            // arrives and the UI stays stuck at "L$ -".
            if !state.agent_id.is_empty() {
                actions.push(Action::send(
                    "MoneyBalanceRequest",
                    json!({
                        "AgentData": [{ "AgentID": state.agent_id, "SessionID": state.session_uuid }],
                        "MoneyData": [{ "TransactionID": "00000000-0000-0000-0000-000000000000" }],
                    }),
                    true,
                ));
                // Ask the sim for our agent data (active group + title). It's NOT
                // pushed proactively on login - the initial AgentDataUpdate carries an
                // empty group - so without this the active-group tag stays blank until
                // the user changes it. The reference viewer sends this right after the
                // money-balance request at startup (llstartup.cpp).
                actions.push(Action::send(
                    "AgentDataUpdateRequest",
                    json!({
                        "AgentData": [{ "AgentID": state.agent_id, "SessionID": state.session_uuid }],
                    }),
                    true,
                ));
            }
        }

        // EnableSimulator (neighbour/child sims) is a rendering optimisation that a
        // no-3D client doesn't need; the actual sim switch happens on
        // TeleportFinish/CrossedRegion. So we intentionally ignore it.
        "EnableSimulator" => {}

        // A group's profile.
        "GroupProfileReply" => {
            let g = block0(decoded, "GroupData").cloned().unwrap_or(Value::Null);
            let group_id = inst_str(&g, "GroupID");
            if is_zero_uuid(&group_id) {
                return actions;
            }
            actions.push(Action::emit(
                "group-profile",
                json!({
                    "groupId": group_id,
                    "name": inst_text(&g, "Name"),
                    "charter": inst_text(&g, "Charter"),
                    "showInList": g.get("ShowInList").and_then(|v| v.as_bool()).unwrap_or(false),
                    "memberTitle": inst_text(&g, "MemberTitle"),
                    "powersMask": inst_str(&g, "PowersMask"),
                    "insigniaId": inst_str(&g, "InsigniaID"),
                    "founderId": inst_str(&g, "FounderID"),
                    "membershipFee": inst_i64(&g, "MembershipFee"),
                    "openEnrollment": g.get("OpenEnrollment").and_then(|v| v.as_bool()).unwrap_or(false),
                    "money": inst_i64(&g, "Money"),
                    "memberCount": inst_i64(&g, "GroupMembershipCount"),
                    "rolesCount": inst_i64(&g, "GroupRolesCount"),
                    "allowPublish": g.get("AllowPublish").and_then(|v| v.as_bool()).unwrap_or(false),
                    "maturePublish": g.get("MaturePublish").and_then(|v| v.as_bool()).unwrap_or(false),
                }),
            ));
        }

        // The groups a resident belongs to, shown on their profile.
        "AvatarGroupsReply" => {
            let avatar_id = inst_str(block0(decoded, "AgentData").unwrap_or(&Value::Null), "AvatarID");
            let list_in_profile = block0(decoded, "NewGroupData")
                .and_then(|n| n.get("ListInProfile"))
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let groups: Vec<Value> = block_instances(decoded, "GroupData")
                .iter()
                .filter_map(|g| {
                    let id = inst_str(g, "GroupID");
                    let name = inst_text(g, "GroupName");
                    if is_zero_uuid(&id) || name.is_empty() {
                        return None;
                    }
                    Some(json!({
                        "id": id, "name": name, "title": inst_text(g, "GroupTitle"),
                        "insigniaId": inst_str(g, "GroupInsigniaID"), "powers": inst_str(g, "GroupPowers"),
                        "acceptNotices": g.get("AcceptNotices").and_then(|v| v.as_bool()).unwrap_or(false),
                        "listInProfile": list_in_profile,
                    }))
                })
                .collect();
            actions.push(Action::emit("avatar-groups", json!({ "avatarId": avatar_id, "groups": groups })));
        }

        // A resident's interests, for the profile tab. We decode the masks to labels here.
        "AvatarInterestsReply" => {
            const WANT_TO: &[&str] = &["Build", "Explore", "Meet", "Group", "Buy", "Sell", "Be Hired", "Hire"];
            const SKILLS: &[&str] = &["Textures", "Architecture", "Event Planning", "Modeling", "Scripting", "Custom Characters"];
            let mask_labels = |mask: i64, labels: &[&str]| -> Vec<Value> {
                let m = mask as u32;
                labels.iter().enumerate().filter(|(i, _)| m & (1 << i) != 0).map(|(_, l)| json!(l)).collect()
            };
            let avatar_id = inst_str(block0(decoded, "AgentData").unwrap_or(&Value::Null), "AvatarID");
            let want_mask = inst_i64(block0(decoded, "PropertiesData").unwrap_or(&Value::Null), "WantToMask");
            let skills_mask = inst_i64(block0(decoded, "PropertiesData").unwrap_or(&Value::Null), "SkillsMask");
            actions.push(Action::emit(
                "avatar-interests",
                json!({
                    "avatarId": avatar_id,
                    "wantToMask": want_mask, "wantTo": mask_labels(want_mask, WANT_TO),
                    "wantToText": field_text(decoded, "PropertiesData", "WantToText").unwrap_or_default(),
                    "skillsMask": skills_mask, "skills": mask_labels(skills_mask, SKILLS),
                    "skillsText": field_text(decoded, "PropertiesData", "SkillsText").unwrap_or_default(),
                    "languagesText": field_text(decoded, "PropertiesData", "LanguagesText").unwrap_or_default(),
                }),
            ));
        }

        // Our private notes about a resident.
        "AvatarNotesReply" => {
            let target_id = inst_str(block0(decoded, "Data").unwrap_or(&Value::Null), "TargetID");
            actions.push(Action::emit(
                "avatar-notes",
                json!({ "targetId": target_id, "notes": field_text(decoded, "Data", "Notes").unwrap_or_default() }),
            ));
        }

        // A parcel-info lookup (about-land or a search result). It's kept separate from
        // the current-parcel `parcel` event so it never clobbers where you're standing.
        "ParcelInfoReply" => {
            let d = block0(decoded, "Data").cloned().unwrap_or(Value::Null);
            let area = {
                let a = inst_i64(&d, "ActualArea");
                if a > 0 { a } else { inst_i64(&d, "BillableArea") }
            };
            // Region-local coords, a snapshot image, and a SLURL/location string, so
            // the place-search detail can render a picture and a "Show on map" link.
            let gx = as_f64(d.get("GlobalX"));
            let gy = as_f64(d.get("GlobalY"));
            let gz = as_f64(d.get("GlobalZ"));
            let (grid_x, grid_y, lx, ly, lz) = global_to_grid(gx, gy, gz);
            let sim = inst_text(&d, "SimName");
            let snapshot = inst_str(&d, "SnapshotID");
            let image = if is_zero_uuid(&snapshot) {
                String::new()
            } else {
                format!("https://secondlife.com/app/image/{snapshot}/256")
            };
            let (slurl, location) = if sim.is_empty() {
                (String::new(), String::new())
            } else {
                (
                    format!("secondlife://{}/{}/{}/{}", sim.replace(' ', "%20"), lx, ly, lz),
                    format!("{} ({}, {}, {})", sim, lx, ly, lz),
                )
            };
            actions.push(Action::emit(
                "parcel-info",
                json!({
                    "parcelId": inst_str(&d, "ParcelID"), "ownerId": inst_str(&d, "OwnerID"),
                    "name": inst_text(&d, "Name"), "desc": inst_text(&d, "Desc"), "description": inst_text(&d, "Desc"), "area": area,
                    "infoFlags": inst_i64(&d, "Flags"),
                    "globalX": gx, "globalY": gy, "globalZ": gz,
                    "gridX": grid_x, "gridY": grid_y,
                    "x": lx, "y": ly, "z": lz,
                    "simName": sim, "location": location, "slurl": slurl,
                    "snapshotId": snapshot, "image": image,
                    "dwell": as_f64(d.get("Dwell")), "salePrice": inst_i64(&d, "SalePrice"),
                }),
            ));
        }

        // A resident's picks and classifieds lists, for the profile tabs.
        "AvatarPicksReply" => {
            let avatar_id = inst_str(block0(decoded, "AgentData").unwrap_or(&Value::Null), "TargetID");
            let picks: Vec<Value> = block_instances(decoded, "Data")
                .iter()
                .filter_map(|p| {
                    let id = inst_str(p, "PickID");
                    let name = inst_text(p, "PickName");
                    if is_zero_uuid(&id) { None } else { Some(json!({ "id": id, "name": name })) }
                })
                .collect();
            actions.push(Action::emit("avatar-picks", json!({ "avatarId": avatar_id, "picks": picks })));
        }
        "AvatarClassifiedReply" => {
            let avatar_id = inst_str(block0(decoded, "AgentData").unwrap_or(&Value::Null), "TargetID");
            let classifieds: Vec<Value> = block_instances(decoded, "Data")
                .iter()
                .filter_map(|c| {
                    let id = inst_str(c, "ClassifiedID");
                    let name = inst_text(c, "Name");
                    if is_zero_uuid(&id) { None } else { Some(json!({ "id": id, "name": name })) }
                })
                .collect();
            actions.push(Action::emit("avatar-classifieds", json!({ "avatarId": avatar_id, "classifieds": classifieds })));
        }

        // The detail of a single pick or classified.
        "PickInfoReply" => {
            let d = block0(decoded, "Data").cloned().unwrap_or(Value::Null);
            let (gx, gy, gz) = vec3(d.get("PosGlobal"));
            // Diagnostic for the pick-detail location row and its map/teleport buttons:
            // an empty SimName hides both (profileDetailLocation needs a region name),
            // and a zero PosGlobal means the pick has no location at all.
            crate::dlog!(
                "PickInfoReply: pick={} sim='{}' posGlobal=({:.0},{:.0},{:.0}) parcel={}",
                inst_str(&d, "PickID"), inst_text(&d, "SimName"), gx, gy, gz, inst_str(&d, "ParcelID")
            );
            let (grid_x, grid_y, lx, ly, lz) = global_to_grid(gx, gy, gz);
            actions.push(Action::emit(
                "pick-info",
                json!({
                    "pickId": inst_str(&d, "PickID"), "creatorId": inst_str(&d, "CreatorID"),
                    "topPick": d.get("TopPick").and_then(|v| v.as_bool()).unwrap_or(false),
                    "parcelId": inst_str(&d, "ParcelID"), "name": inst_text(&d, "Name"),
                    "desc": inst_text(&d, "Desc"), "description": inst_text(&d, "Desc"), "snapshotId": inst_str(&d, "SnapshotID"),
                    "simName": inst_text(&d, "SimName"), "location": inst_text(&d, "SimName"),
                    "posGlobal": { "x": gx, "y": gy, "z": gz },
                    "globalX": gx, "globalY": gy,
                    "gridX": grid_x, "gridY": grid_y, "x": lx, "y": ly, "z": lz,
                    "enabled": d.get("Enabled").and_then(|v| v.as_bool()).unwrap_or(true),
                }),
            ));
        }
        "ClassifiedInfoReply" => {
            let d = block0(decoded, "Data").cloned().unwrap_or(Value::Null);
            let (gx, gy, gz) = vec3(d.get("PosGlobal"));
            let (grid_x, grid_y, lx, ly, lz) = global_to_grid(gx, gy, gz);
            actions.push(Action::emit(
                "classified-info",
                json!({
                    "classifiedId": inst_str(&d, "ClassifiedID"), "creatorId": inst_str(&d, "CreatorID"),
                    "name": inst_text(&d, "Name"), "desc": inst_text(&d, "Desc"), "description": inst_text(&d, "Desc"),
                    "category": inst_i64(&d, "Category"), "parcelId": inst_str(&d, "ParcelID"),
                    "snapshotId": inst_str(&d, "SnapshotID"), "simName": inst_text(&d, "SimName"),
                    "parcelName": inst_text(&d, "ParcelName"), "location": inst_text(&d, "ParcelName"),
                    "posGlobal": { "x": gx, "y": gy, "z": gz },
                    "globalX": gx, "globalY": gy,
                    "gridX": grid_x, "gridY": grid_y, "x": lx, "y": ly, "z": lz,
                    "priceForListing": inst_i64(&d, "PriceForListing"),
                }),
            ));
        }

        // An avatar profile over the UDP path; the AgentProfile cap is a richer superset.
        "AvatarPropertiesReply" => {
            let avatar_id = inst_str(block0(decoded, "AgentData").unwrap_or(&Value::Null), "AvatarID");
            if avatar_id.is_empty() {
                return actions;
            }
            let pd = block0(decoded, "PropertiesData").cloned().unwrap_or(Value::Null);
            let raw = inst_i64(&pd, "Flags") as u32;
            let mut profile = json!({
                "avatarId": avatar_id,
                "imageId": inst_str(&pd, "ImageID"),
                "flImageId": inst_str(&pd, "FLImageID"),
                "partnerId": inst_str(&pd, "PartnerID"),
                "about": field_text(decoded, "PropertiesData", "AboutText").unwrap_or_default(),
                "flAbout": field_text(decoded, "PropertiesData", "FLAboutText").unwrap_or_default(),
                "bornOn": field_text(decoded, "PropertiesData", "BornOn").unwrap_or_default(),
                "profileUrl": field_text(decoded, "PropertiesData", "ProfileURL").unwrap_or_default(),
                "charterMember": field_text(decoded, "PropertiesData", "CharterMember").unwrap_or_default(),
                "flags": {
                    "raw": raw,
                    "allowPublish": raw & 0x1 != 0,
                    "identified": raw & 0x4 != 0,
                    "transacted": raw & 0x8 != 0,
                },
                "source": "udp",
            });
            // Online is tri-state, so only assert it when the bit is actually set.
            if raw & 0x10 != 0 {
                profile["flags"]["online"] = json!(true);
            }
            actions.push(Action::emit("avatar-profile", profile));
        }

        // Directory search results, correlated back by queryId.
        "DirPeopleReply" => {
            let people: Vec<Value> = block_instances(decoded, "QueryReplies")
                .iter()
                .filter_map(|r| {
                    // The sim prepends a null-key status row when a query has no real
                    // matches (e.g. punctuation-only queries like "////"), so skip those
                    // placeholder rows to keep them from surfacing as a bogus "Resident"
                    // result (this matches the reference viewer's behaviour).
                    let id = inst_str(r, "AgentID");
                    if id.is_empty() || is_zero_uuid(&id) { return None; }
                    let first = inst_text(r, "FirstName");
                    let last = inst_text(r, "LastName");
                    let name = format!("{} {}", first, last).trim().to_string();
                    Some(json!({
                        "id": id,
                        "name": name.clone(),
                        // Directory search returns only the legacy name, so expose it as
                        // userName to give the search row's second line and IM-from-search a
                        // value (display names, if any, resolve later via GetDisplayNames).
                        "userName": name,
                        "firstName": first,
                        "lastName": last,
                        "group": inst_text(r, "Group"),
                        "online": r.get("Online").and_then(|v| v.as_bool()).unwrap_or(false),
                        "reputation": inst_i64(r, "Reputation"),
                    }))
                })
                .collect();
            actions.push(Action::emit(
                "dir-people-reply",
                json!({ "queryId": inst_str(block0(decoded, "QueryData").unwrap_or(&Value::Null), "QueryID"), "people": people }),
            ));
        }
        "DirPlacesReply" => {
            let places: Vec<Value> = block_instances(decoded, "QueryReplies")
                .iter()
                .filter_map(|r| {
                    // Skip the sim's null-key placeholder row (same as in DirPeopleReply).
                    let pid = inst_str(r, "ParcelID");
                    if pid.is_empty() || is_zero_uuid(&pid) { return None; }
                    Some(json!({
                        "parcelId": pid,
                        "name": inst_text(r, "Name"),
                        "forSale": r.get("ForSale").and_then(|v| v.as_bool()).unwrap_or(false),
                        "auction": r.get("Auction").and_then(|v| v.as_bool()).unwrap_or(false),
                        "dwell": as_f64(r.get("Dwell")),
                    }))
                })
                .collect();
            actions.push(Action::emit(
                "dir-places-reply",
                json!({ "queryId": inst_str(block0(decoded, "QueryData").unwrap_or(&Value::Null), "QueryID"), "places": places }),
            ));
        }
        "DirGroupsReply" => {
            let groups: Vec<Value> = block_instances(decoded, "QueryReplies")
                .iter()
                .filter_map(|r| {
                    // Skip the sim's null-key placeholder row (same as in DirPeopleReply).
                    let gid = inst_str(r, "GroupID");
                    if gid.is_empty() || is_zero_uuid(&gid) { return None; }
                    Some(json!({
                        "id": gid,
                        "name": inst_text(r, "GroupName"),
                        "members": inst_i64(r, "Members"),
                        "searchOrder": as_f64(r.get("SearchOrder")),
                    }))
                })
                .collect();
            actions.push(Action::emit(
                "dir-groups-reply",
                json!({ "queryId": inst_str(block0(decoded, "QueryData").unwrap_or(&Value::Null), "QueryID"), "groups": groups }),
            ));
        }
        // First contact with a region: record it, tell the UI, and ack exactly once.
        "RegionHandshake" => {
            if let Some(sim) = field_text(decoded, "RegionInfo", "SimName") {
                if !sim.is_empty() {
                    state.region_name = sim;
                }
            }
            if let Some(id) = field(decoded, "RegionInfo2", "RegionID").and_then(|v| v.as_str()) {
                state.region_id = id.to_string();
            }
            // SimAccess (RegionInfo, U8) is PG=13, Mature=21, Adult=42 (indra_constants.h).
            let access = as_i64(field(decoded, "RegionInfo", "SimAccess"));
            if access != 0 {
                state.region_access = access;
            }
            let mut region = region_obj(state);
            if let Value::Object(ref mut m) = region {
                m.insert("handshakeOnly".into(), json!(true));
            }
            actions.push(Action::emit("region", region));
            if !state.handshake_reply_sent {
                state.handshake_reply_sent = true;
                // These flags mirror the reference viewer's RegionHandshakeReply (llviewerregion.cpp):
                // 0x4 SUPPORTS_SELF_APPEARANCE and 0x2 "cache file is empty" (we keep no
                // object cache). We deliberately leave out 0x1 (VOCache culling / "send all
                // cacheable objects") - a text client has no use for an object flood.
                actions.push(Action::send(
                    "RegionHandshakeReply",
                    json!({
                        "AgentData": [{ "AgentID": state.agent_id, "SessionID": state.session_uuid }],
                        "RegionInfo": [{ "Flags": 6 }],
                    }),
                    true,
                ));
            }
        }
        _ => {}
    }
    actions
}

/// A bucket that looks like a UUID or base64 blob isn't a human-readable title.
fn looks_uuid_or_b64(s: &str) -> bool {
    let t = s.trim();
    t.len() >= 16 && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '+' | '/' | '='))
}

/// The first non-empty string among several candidate keys (LLSD naming varies).
fn str_field(v: &Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    String::new()
}

/// Build the `parcel` event from an EventQueue-delivered ParcelProperties.
/// On current SL this comes through as `flavor=llsd`, so its shape differs from the
/// UDP block: text fields are native strings (not base64), and ParcelFlags is a
/// 4-byte big-endian LLSD binary rather than a decoded U32. The output mirrors the
/// UDP ParcelProperties handler, so the land UI gets identical fields either way.
fn parcel_from_eq(state: &SessionState, body: &Value) -> Option<Action> {
    let pd = body.get("ParcelData").and_then(|v| v.as_array()).and_then(|a| a.first())?;
    if inst_i64(pd, "RequestResult") == -1 {
        return None; // the sim has no parcel data here
    }
    // The Media 2.0 fields live in a separate MediaData block, not in ParcelData.
    let media = body.get("MediaData").and_then(|v| v.as_array()).and_then(|a| a.first());
    let flags: u32 = match pd.get("ParcelFlags") {
        // An LLSD binary U32 in network (big-endian) byte order, just like SimIP.
        Some(Value::Array(a)) if a.len() >= 4 => {
            let b = |i: usize| a.get(i).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            (b(0) << 24) | (b(1) << 16) | (b(2) << 8) | b(3)
        }
        // Some sims (OpenSim) may send it as a plain integer instead.
        Some(v) => v.as_u64().unwrap_or(0) as u32,
        None => 0,
    };
    let has = |bit: u32| flags & bit != 0;
    let bonus = {
        let b = as_f64(pd.get("ParcelPrimBonus"));
        if b > 0.0 { b } else { 1.0 }
    };
    let used = inst_i64(pd, "OwnerPrims") + inst_i64(pd, "GroupPrims")
        + inst_i64(pd, "OtherPrims") + inst_i64(pd, "SelectedPrims");
    let capacity = (inst_i64(pd, "MaxPrims") as f64 * bonus).round() as i64;
    let owner_id = inst_str(pd, "OwnerID");
    let group_id = inst_str(pd, "GroupID");
    let snapshot = inst_str(pd, "SnapshotID");
    let (ux, uy, uz) = vec3(pd.get("UserLocation"));
    let (lx, ly, _lz) = vec3(pd.get("UserLookAt"));
    let landing_heading = if lx == 0.0 && ly == 0.0 {
        0.0
    } else {
        (ly.atan2(lx).to_degrees() + 360.0) % 360.0
    };
    let access = if has(pflag::ACCESS_LIST) { 1 } else if has(pflag::ACCESS_GROUP) { 2 } else { 0 };
    let is_group_owned = truthy(pd.get("IsGroupOwned"));
    const GOVERNOR_LINDEN: &str = "3d6181b0-6a4b-97ef-18d8-722652995cf1";
    // GP_LAND_CHANGE_IDENTITY is the group power to edit a parcel's About Land.
    const GP_LAND_CHANGE_IDENTITY: u64 = 1 << 18;
    let can_edit = if owner_id.is_empty() || same_uuid(&owner_id, GOVERNOR_LINDEN) {
        false
    } else if is_group_owned {
        // Group land needs the actual land power, not just membership (see route()).
        state
            .group_powers
            .get(&owner_id.to_lowercase())
            .is_some_and(|p| p & GP_LAND_CHANGE_IDENTITY != 0)
    } else {
        same_uuid(&owner_id, &state.agent_id)
    };
    let snapshot_url = if is_zero_uuid(&snapshot) {
        String::new()
    } else {
        format!("https://secondlife.com/app/image/{snapshot}/256")
    };
    Some(Action::emit(
        "parcel",
        json!({
            "localId": inst_i64(pd, "LocalID"),
            "name": inst_str(pd, "Name"),
            "desc": inst_str(pd, "Desc"),
            "area": inst_i64(pd, "Area"),
            "primsUsed": used,
            "primsTotal": if capacity > 0 { capacity } else { inst_i64(pd, "MaxPrims") },
            "parcelPrimBonus": bonus,
            "ownerPrims": inst_i64(pd, "OwnerPrims"),
            "groupPrims": inst_i64(pd, "GroupPrims"),
            "otherPrims": inst_i64(pd, "OtherPrims"),
            "simWideTotalPrims": inst_i64(pd, "SimWideTotalPrims"),
            "simWideMaxPrims": inst_i64(pd, "SimWideMaxPrims"),
            "ownerId": owner_id,
            "ownerName": state.cached_name(&inst_str(pd, "OwnerID")).unwrap_or("").to_string(),
            "isGroupOwned": is_group_owned,
            "groupId": group_id,
            "parcelFlags": flags,
            "access": access,
            "pushRestricted": has(pflag::RESTRICT_PUSH),
            "allowBuild": has(pflag::CREATE_OBJECTS) || has(pflag::CREATE_GROUP_OBJ),
            "allowBuildEveryone": has(pflag::CREATE_OBJECTS),
            "allowBuildGroup": has(pflag::CREATE_GROUP_OBJ),
            "allowScripts": has(pflag::OTHER_SCRIPTS) || has(pflag::GROUP_SCRIPTS),
            "allowScriptsEveryone": has(pflag::OTHER_SCRIPTS),
            "allowScriptsGroup": has(pflag::GROUP_SCRIPTS),
            "allowFly": has(pflag::FLY),
            "allowTerraform": has(pflag::TERRAFORM),
            "safeEnvironment": !has(pflag::DAMAGE),
            "soundLocal": has(pflag::SOUND_LOCAL),
            "allowVoice": has(pflag::VOICE),
            "showInSearch": has(pflag::SHOW_DIR),
            "sellPasses": has(pflag::PASS_LIST),
            "musicUrl": inst_str(pd, "MusicURL"),
            "mediaUrl": inst_str(pd, "MediaURL"),
            "mediaId": inst_str(pd, "MediaID"),
            "mediaAutoScale": inst_i64(pd, "MediaAutoScale"),
            "mediaType": media.and_then(|m| m.get("MediaType")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "mediaDesc": media.and_then(|m| m.get("MediaDesc")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "salePrice": inst_i64(pd, "SalePrice"),
            "passPrice": inst_i64(pd, "PassPrice"),
            "passHours": as_f64(pd.get("PassHours")),
            "category": inst_i64(pd, "Category"),
            "authBuyerId": inst_str(pd, "AuthBuyerID"),
            "snapshotId": snapshot,
            "snapshotUrl": snapshot_url,
            "landingPoint": { "x": ux.round(), "y": uy.round(), "z": uz.round() },
            "landingHeading": landing_heading.round(),
            "landingType": inst_i64(pd, "LandingType"),
            "claimDate": inst_i64(pd, "ClaimDate"),
            "otherCleanTime": inst_i64(pd, "OtherCleanTime"),
            "canEdit": can_edit,
            "source": "eq",
            "stub": false,
        }),
    ))
}

/// Route an EventQueue event (an LLSD body). On current SL a lot of messages come
/// through here instead of over UDP (`message.xml` `flavor=llsd`): the ChatterBox
/// chat-session family, plus teleport / region-cross (`TeleportFinish`,
/// `CrossedRegion`), which have to switch the circuit to the new sim - miss that
/// and the client stays pinned to the old sim, gets `DisableSimulator`, and is
/// stranded (no names/land/updates until relog). The LLSD field shapes differ from
/// the UDP decode (native values, IPADDR as a byte array, no base64), so we parse
/// them here rather than reuse `route`.
pub fn route_eq(state: &mut SessionState, name: &str, body: &Value) -> Vec<Action> {
    const ZERO: &str = "00000000-0000-0000-0000-000000000000";
    let mut actions = Vec::new();
    match name {
        "ChatterBoxInvitation" => {
            let im = body.get("instantmessage").or_else(|| body.get("instant_message"));
            let mp = match im.and_then(|v| v.get("message_params").or_else(|| v.get("messageParams"))) {
                Some(m) => m,
                None => return actions,
            };
            let from_id = str_field(mp, &["from_id", "fromId"]);
            let session_id = str_field(mp, &["id", "session_id", "sessionId"]);
            if from_id.is_empty()
                || session_id.is_empty()
                || same_uuid(&session_id, ZERO)
                || same_uuid(&from_id, &state.agent_id)
            {
                return actions;
            }
            let from_name = str_field(mp, &["from_name", "fromName"]);
            state.cache_name(&from_id, &from_name);
            let display = state.cached_name(&from_id).unwrap_or(&from_name).to_string();
            actions.push(Action::ResolveNames(vec![from_id.clone()]));
            // Enroll in the session (this mirrors the reference viewer's
            // chatterBoxInvitationCoro "accept invitation"); without it the sim never
            // sends the roster or any message past this first one.
            actions.push(Action::AcceptChatSession { session_id: session_id.clone() });

            // Group vs conference is decided by session-id membership, like the reference viewer.
            let stype = if state.groups.contains(&session_id.to_lowercase()) { "group" } else { "conference" };
            let text = str_field(mp, &["message"]);
            if !text.is_empty() {
                let key = format!("{session_id}\0{from_id}\017\0{text}\0");
                if !state.is_duplicate_im(&key) {
                    actions.push(Action::emit(
                        "im",
                        json!({
                            "sessionId": session_id,
                            "participant": { "id": from_id, "name": display, "online": true },
                            "session": { "id": session_id, "type": stype, "title": "" },
                            "message": { "imId": session_id, "fromId": from_id, "fromName": display, "text": text, "outgoing": false },
                        }),
                    ));
                }
            }
        }
        "ForceCloseChatterBoxSession" => {
            let sid = str_field(body, &["session_id", "sessionId"]);
            if !sid.is_empty() {
                state.im_rosters.remove(&sid);
                let reason = str_field(body, &["reason"]);
                actions.push(Action::emit(
                    "im-session-force-close",
                    json!({ "sessionId": sid, "reason": if reason.is_empty() { "The chat session was closed".to_string() } else { reason } }),
                ));
            }
        }

        // The reply to a conference we started: the sim assigns its own session id,
        // distinct from the client temp id the UI opened the tab under. Tell the UI
        // to rebind that tab so the roster and messages, which arrive under the real
        // id, land in it instead of in a duplicate or empty tab.
        "ChatterBoxSessionStartReply" => {
            let temp = str_field(body, &["temp_session_id", "tempSessionId"]);
            let sid = str_field(body, &["session_id", "sessionId"]);
            let success = body.get("success").and_then(|v| v.as_bool()).unwrap_or(!sid.is_empty());
            if !temp.is_empty() {
                actions.push(Action::emit(
                    "im-session-remap",
                    json!({
                        "tempId": temp,
                        "sessionId": if sid.is_empty() { temp.clone() } else { sid },
                        "success": success,
                    }),
                ));
            }
        }
        "ChatterBoxSessionAgentListUpdates" => {
            let sid = str_field(body, &["session_id", "sessionId"]);
            if sid.is_empty() {
                return actions;
            }
            // The update is a per-agent DELTA (ENTER/LEAVE plus moderator/mute
            // changes), so merge it into the session's roster and emit the full
            // snapshot. Emitting just the delta would wipe everyone else, since the
            // UI replaces the participant list wholesale.
            let agent_id = state.agent_id.clone();
            let (snapshot, self_mod) = {
                let roster = state.im_rosters.entry(sid.clone()).or_default();
                // Prefer the rich `agent_updates` form, falling back to the legacy `updates`.
                if let Some(Value::Object(updates)) = body.get("agent_updates").or_else(|| body.get("updates")) {
                    for (aid, entry) in updates {
                        // There are two wire forms: a map { transition, info:{...} }, or
                        // the legacy bare string "ENTER"/"LEAVE".
                        let (transition, agent_info) = match entry {
                            Value::String(s) => (s.as_str(), None),
                            _ => (
                                entry.get("transition").and_then(|v| v.as_str()).unwrap_or("ENTER"),
                                entry.get("info"),
                            ),
                        };
                        if transition == "LEAVE" {
                            roster.participants.remove(aid);
                            continue;
                        }
                        // A delta is per-field: only the changed keys are sent, so MERGE -
                        // overwrite is_moderator/muted only when the update actually carries
                        // them, otherwise keep the prior value. Blindly recomputing would
                        // reset an omitted field to false, dropping a MOD badge or hiding the
                        // local moderator's controls.
                        let prior = roster.participants.get(aid).copied().unwrap_or((false, false));
                        let has_mod = agent_info.map_or(false, |i| i.get("is_moderator").is_some());
                        let has_mutes = agent_info.map_or(false, |i| i.get("mutes").is_some());
                        // LLSD bools sometimes arrive as 0/1 ints (OpenSim), so accept both.
                        let is_mod = if has_mod { truthy(agent_info.and_then(|i| i.get("is_moderator"))) } else { prior.0 };
                        let muted = if has_mutes {
                            truthy(agent_info.and_then(|i| i.get("mutes")).and_then(|m| m.get("text")))
                        } else {
                            prior.1
                        };
                        roster.participants.insert(aid.clone(), (is_mod, muted));
                        if same_uuid(aid, &agent_id) && has_mod {
                            roster.self_moderator = is_mod;
                        }
                    }
                }
                let snap: Vec<(String, bool, bool)> =
                    roster.participants.iter().map(|(k, (m, u))| (k.clone(), *m, *u)).collect();
                (snap, roster.self_moderator)
            };
            let mut participants = Vec::new();
            let mut resolve = Vec::new();
            for (aid, is_mod, muted) in &snapshot {
                let name = state.cached_name(aid).unwrap_or("").to_string();
                if name.is_empty() && !same_uuid(aid, &agent_id) {
                    resolve.push(aid.clone());
                }
                participants.push(json!({ "id": aid, "name": name, "online": true, "isModerator": is_mod, "muted": muted }));
            }
            let stype = if state.groups.contains(&sid.to_lowercase()) { "group" } else { "conference" };
            actions.push(Action::emit(
                "im-roster",
                json!({ "sessionId": sid, "type": stype, "title": "", "moderator": self_mod, "participants": participants }),
            ));
            if !resolve.is_empty() {
                actions.push(Action::ResolveNames(resolve));
            }
        }

        // A teleport to another region completes over the EventQueue (flavor=llsd),
        // not UDP. Switch the circuit to the new sim and refresh its caps (which also
        // restarts the EventQueue). We guard on a real sim change, so a stray
        // duplicate is a no-op.
        "TeleportFinish" => {
            let info = match body.get("Info").and_then(|v| v.as_array()).and_then(|a| a.first()) {
                Some(i) => i,
                None => return actions,
            };
            let sim_ip = llsd_ip(info.get("SimIP"));
            let sim_port = info.get("SimPort").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let seed = info.get("SeedCapability").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !sim_ip.is_empty() && (sim_ip != state.sim_ip || sim_port != state.sim_port) {
                state.sim_ip = sim_ip.clone();
                state.sim_port = sim_port;
                state.handshake_reply_sent = false;
                actions.push(Action::Retarget {
                    sim_ip: sim_ip.clone(),
                    sim_port,
                    agent_id: state.agent_id.clone(),
                    session_uuid: state.session_uuid.clone(),
                    circuit_code: state.circuit_code,
                });
                if !seed.is_empty() {
                    actions.push(Action::RefreshCaps { seed_url: seed.clone(), sim_ip: sim_ip.clone() });
                }
            }
            let mut fin = json!({ "url": seed, "simIp": sim_ip, "simPort": sim_port, "regionName": state.region_name });
            if let Some((gx, gy)) = llsd_region_grid(info.get("RegionHandle")) {
                state.region_grid_x = gx;
                state.region_grid_y = gy;
                fin["gridX"] = json!(gx);
                fin["gridY"] = json!(gy);
            }
            actions.push(Action::emit("teleport-finish", fin));
        }

        // Walking across a region border also comes in via the EventQueue.
        "CrossedRegion" => {
            let rd = body.get("RegionData").and_then(|v| v.as_array()).and_then(|a| a.first());
            let sim_ip = rd.map(|r| llsd_ip(r.get("SimIP"))).unwrap_or_default();
            let sim_port = rd.and_then(|r| r.get("SimPort")).and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let seed = rd.and_then(|r| r.get("SeedCapability")).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let (px, py, pz) = vec3(
                body.get("Info").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|i| i.get("Position")),
            );
            if let Some((gx, gy)) = rd.and_then(|r| llsd_region_grid(r.get("RegionHandle"))) {
                state.region_grid_x = gx;
                state.region_grid_y = gy;
            }
            if !sim_ip.is_empty() && (sim_ip != state.sim_ip || sim_port != state.sim_port) {
                state.sim_ip = sim_ip.clone();
                state.sim_port = sim_port;
                state.handshake_reply_sent = false;
                actions.push(Action::Retarget {
                    sim_ip: sim_ip.clone(),
                    sim_port,
                    agent_id: state.agent_id.clone(),
                    session_uuid: state.session_uuid.clone(),
                    circuit_code: state.circuit_code,
                });
                if !seed.is_empty() {
                    actions.push(Action::RefreshCaps { seed_url: seed, sim_ip });
                }
            }
            state.last_pos = Some([px, py, pz]);
            actions.push(Action::emit(
                "position",
                json!({ "position": { "x": px, "y": py, "z": pz }, "region": region_obj(state), "source": "teleport" }),
            ));
        }

        // Neighbour/child-sim setup - a rendering optimisation a no-3D client
        // doesn't need (this mirrors the UDP EnableSimulator no-op).
        "EnableSimulator" => {}

        // Parcel data arrives here (flavor=llsd), not as a UDP block.
        "ParcelProperties" => {
            if let Some(action) = parcel_from_eq(state, body) {
                actions.push(action);
            }
        }

        // Our own group membership arrives here (flavor=llsd), not over UDP. This
        // caches the agent's group names (so group-owned parcels show a name rather
        // than a UUID) and fills in state.groups for parcel edit-gating.
        "AgentGroupDataUpdate" => {
            let agent = body
                .get("AgentData")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|a| a.get("AgentID"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !agent.is_empty() && !same_uuid(agent, &state.agent_id) {
                return actions; // this update isn't about us
            }
            let mut ids = HashSet::new();
            let mut powers = HashMap::new();
            let groups: Vec<Value> = body
                .get("GroupData")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|g| {
                            let id = g.get("GroupID").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            if is_zero_uuid(&id) {
                                return None;
                            }
                            ids.insert(id.to_lowercase());
                            let power_str = llsd_u64_str(g.get("GroupPowers"));
                            powers.insert(id.to_lowercase(), power_str.parse::<u64>().unwrap_or(0));
                            Some(json!({
                                "id": id,
                                "name": g.get("GroupName").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                "insigniaId": g.get("GroupInsigniaID").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                "powers": power_str,
                                "acceptNotices": g.get("AcceptNotices").and_then(|v| v.as_bool()).unwrap_or(false),
                                "contribution": g.get("Contribution").and_then(|v| v.as_i64()).unwrap_or(0),
                            }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            state.groups = ids;
            state.group_powers = powers;
            actions.push(Action::emit("group-membership", json!({ "groups": groups })));
        }

        // A teleport failure also arrives via the EventQueue, so surface it to stop
        // the UI waiting (e.g. an invalid destination -> "invalid_tport").
        "TeleportFailed" => {
            let reason = body
                .get("Info")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|i| i.get("Reason"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if reason.to_lowercase().contains("could not teleport closer") {
                actions.push(Action::emit("teleport-finish", json!({ "benign": true, "reason": reason })));
            } else {
                actions.push(Action::emit("teleport-failed", json!({ "reason": reason, "source": "eq" })));
            }
        }

        _ => {}
    }
    actions
}

/// ImprovedInstantMessage fan-out, split into its own fn to keep `route` readable.
fn route_im(state: &mut SessionState, decoded: &Value) -> Vec<Action> {
    let mut actions = Vec::new();
    let agent_data = block0(decoded, "AgentData").cloned().unwrap_or(Value::Null);
    let msg = block0(decoded, "MessageBlock").cloned().unwrap_or(Value::Null);

    let from_id = inst_str(&agent_data, "AgentID");
    let to_id = inst_str(&msg, "ToAgentID");
    let from_group = msg.get("FromGroup").and_then(|v| v.as_bool()).unwrap_or(false);
    let dialog = inst_i64(&msg, "Dialog");
    let im_id = inst_str(&msg, "ID");
    let wire_ts = inst_i64(&msg, "Timestamp");
    let offline = inst_i64(&msg, "Offline");
    let from_name = inst_text(&msg, "FromAgentName");
    let text = inst_text(&msg, "Message");
    let bucket = inst_text(&msg, "BinaryBucket");
    const ZERO: &str = "00000000-0000-0000-0000-000000000000";

    if from_id.is_empty() || same_uuid(&from_id, &state.agent_id) {
        return actions;
    }
    let is_session = from_group || dialog == 15 || dialog == 16 || dialog == 17;
    if !to_id.is_empty() && !same_uuid(&to_id, &state.agent_id) && !same_uuid(&to_id, ZERO) && !is_session {
        return actions;
    }

    state.cache_name(&from_id, &from_name);
    let display = state.cached_name(&from_id).unwrap_or(&from_name).to_string();

    // Typing pings, for non-session IMs.
    if (dialog == 41 || dialog == 42) && !is_session {
        actions.push(Action::emit(
            "im-typing",
            json!({
                "sessionId": xor_session_id(&state.agent_id, &from_id),
                "fromId": &from_id, "fromName": &display, "typing": dialog == 41,
            }),
        ));
        return actions;
    }

    match dialog {
        24 => {
            actions.push(Action::emit("teleport-declined", json!({ "fromId": &from_id, "fromName": &display })));
            return actions;
        }
        23 => {
            actions.push(Action::emit("teleport-accepted", json!({ "fromId": &from_id, "fromName": &display })));
            return actions;
        }
        22 => {
            actions.push(Action::emit(
                "teleport-offer",
                json!({
                    "fromId": &from_id, "fromName": &display,
                    "message": strip_slurl(&text), "lureId": &im_id,
                    "location": parse_lure_bucket(&bucket).unwrap_or(Value::Null),
                    "rawMessage": &text,
                }),
            ));
            return actions;
        }
        26 => {
            actions.push(Action::emit(
                "teleport-request",
                json!({ "fromId": &from_id, "fromName": &display, "message": text.trim(), "lureId": &im_id }),
            ));
            return actions;
        }
        // Friendship offer (38): here the IM ID is the transaction id to accept or decline.
        38 => {
            actions.push(Action::ResolveNames(vec![from_id.clone()]));
            actions.push(Action::emit(
                "event",
                json!({
                    "kind": "interactive-prompt", "fromId": &from_id, "fromName": &display,
                    "text": if text.trim().is_empty() { format!("{display} has offered you friendship.") } else { text.clone() },
                    "type": "friendship", "source": "system", "channel": 0,
                    "prompt": {
                        "type": "friendship-offer", "fromId": &from_id, "fromName": &display,
                        "transactionId": &im_id, "resolved": false, "response": "",
                    }
                }),
            ));
            return actions;
        }
        // Friendship accepted (39) or declined (40) - just confirm it to the user.
        39 => {
            actions.push(system_chat(&format!("{display} is now your friend.")));
            return actions;
        }
        40 => {
            actions.push(system_chat(&format!("{display} declined your friendship offer.")));
            return actions;
        }
        _ => {}
    }

    if text.trim().is_empty() {
        return actions;
    }

    let session_im_id = if !im_id.is_empty() && !same_uuid(&im_id, ZERO) { im_id.clone() } else { String::new() };
    let dedup_key = format!(
        "{}{}\0{}\0{}\0{}",
        if is_session && !session_im_id.is_empty() { format!("{session_im_id}\0") } else { String::new() },
        from_id, dialog, text, wire_ts
    );
    if state.is_duplicate_im(&dedup_key) {
        return actions;
    }

    let online = offline == 0;
    let msg_im_id = if is_session && !session_im_id.is_empty() { &session_im_id } else { &im_id };
    let mut payload = json!({
        "participant": { "id": &from_id, "name": &display, "online": online },
        "message": {
            "imId": msg_im_id, "fromId": &from_id, "fromName": &display,
            "text": &text, "outgoing": false,
        }
    });

    if is_session && !session_im_id.is_empty() {
        // The reference viewer decides group vs conference by membership of the
        // session id, not the FromGroup flag (the sim often sends FromGroup=false on
        // a group IM). Fall back to the flag for grids that aren't in our group set.
        let is_group = state.groups.contains(&session_im_id.to_lowercase()) || from_group;
        let stype = if is_group { "group" } else { "conference" };
        let default_title = if is_group { "Group chat" } else { "Conference" };
        let title = if !bucket.trim().is_empty() && !looks_uuid_or_b64(&bucket) {
            bucket.clone()
        } else {
            default_title.to_string()
        };
        payload["sessionId"] = json!(&session_im_id);
        payload["session"] = json!({ "id": &session_im_id, "type": stype, "title": title });
    } else {
        payload["sessionId"] = json!(xor_session_id(&state.agent_id, &from_id));
    }

    actions.push(Action::emit("im", payload));
    actions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_is_answered_with_same_id() {
        let mut st = SessionState::default();
        let pkt = json!({ "name": "StartPingCheck", "blocks": { "PingID": [{ "PingID": 42, "OldestUnacked": 0 }] } });
        let actions = route(&mut st, &pkt);
        assert_eq!(
            actions,
            vec![Action::send("CompletePingCheck", json!({ "PingID": [{ "PingID": 42 }] }), false)]
        );
    }

    fn chat_packet(source_type: u64, chat_type: u64, audible: u64, from: &str, src_id: &str, msg: &str) -> Value {
        json!({
            "name": "ChatFromSimulator",
            "blocks": { "ChatData": [{
                "FromName": B64.encode(format!("{from}\0").as_bytes()),
                "SourceID": src_id,
                "OwnerID": "00000000-0000-0000-0000-000000000000",
                "SourceType": source_type,
                "ChatType": chat_type,
                "Audible": audible,
                "Message": B64.encode(format!("{msg}\0").as_bytes()),
            }] }
        })
    }

    #[test]
    fn agent_chat_emits_chat_event() {
        let mut st = SessionState::default();
        let pkt = chat_packet(1, 1, 1, "Ruth Resident", "44444444-4444-4444-4444-444444444444", "hi there");
        let actions = route(&mut st, &pkt);
        assert_eq!(actions.len(), 1);
        if let Action::Emit { event, payload } = &actions[0] {
            assert_eq!(event, "chat");
            assert_eq!(payload["fromName"], "Ruth Resident");
            assert_eq!(payload["text"], "hi there");
            assert_eq!(payload["source"], "agent");
            assert_eq!(payload["type"], "normal");
        } else {
            panic!("expected chat emit");
        }
    }

    #[test]
    fn own_chat_is_shown_outgoing_but_typing_and_inaudible_dropped() {
        let me = "44444444-4444-4444-4444-444444444444";
        let mut st = SessionState { agent_id: me.into(), ..Default::default() };
        // The sim's echo of our own channel-0 chat should render, flagged outgoing.
        let a = route(&mut st, &chat_packet(1, 1, 1, "Me", me, "hi all"));
        let p = emit_of(&a, "chat").expect("own chat should render");
        assert_eq!(p["outgoing"], true);
        assert_eq!(p["text"], "hi all");
        // Typing start (ChatType 4) is still dropped, even when it's from us.
        assert!(route(&mut st, &chat_packet(1, 4, 1, "Me", me, "")).is_empty());
        // Inaudible chat (255) is dropped.
        assert!(route(&mut st, &chat_packet(1, 1, 255, "A", "55555555-5555-5555-5555-555555555555", "far")).is_empty());
    }

    #[test]
    fn object_chat_carries_owner() {
        let mut st = SessionState::default();
        let mut pkt = chat_packet(2, 1, 1, "Cube", "66666666-6666-6666-6666-666666666666", "click me");
        pkt["blocks"]["ChatData"][0]["OwnerID"] = json!("77777777-7777-7777-7777-777777777777");
        let actions = route(&mut st, &pkt);
        if let Action::Emit { payload, .. } = &actions[0] {
            assert_eq!(payload["source"], "object");
            assert_eq!(payload["ownerId"], "77777777-7777-7777-7777-777777777777");
        } else {
            panic!("expected emit");
        }
    }

    fn emit_of<'a>(actions: &'a [Action], event: &str) -> Option<&'a Value> {
        actions.iter().find_map(|a| match a {
            Action::Emit { event: e, payload } if e == event => Some(payload),
            _ => None,
        })
    }

    #[test]
    fn money_balance_maps_fields() {
        let mut st = SessionState::default();
        let pkt = json!({
            "name": "MoneyBalanceReply",
            "blocks": {
                "MoneyData": [{ "MoneyBalance": 1234, "SquareMetersCredit": 10, "SquareMetersCommitted": 5, "Description": B64.encode(b"") }],
                "TransactionInfo": [{ "TransactionType": 5001 }],
            }
        });
        let a = route(&mut st, &pkt);
        let p = emit_of(&a, "money-balance").expect("money-balance");
        assert_eq!(p["balance"], 1234);
        assert_eq!(p["landCredit"], 10);
        assert_eq!(p["transactionType"], 5001);
    }

    #[test]
    fn agent_data_update_sets_name_and_active_group() {
        let mut st = SessionState::default();
        let pkt = json!({
            "name": "AgentDataUpdate",
            "blocks": { "AgentData": [{
                "AgentID": "88888888-8888-8888-8888-888888888888",
                "FirstName": B64.encode(b"Ruth\0"),
                "LastName": B64.encode(b"Resident\0"),
                "GroupTitle": B64.encode(b"Member\0"),
                "ActiveGroupID": "99999999-9999-9999-9999-999999999999",
                "GroupPowers": "0",
                "GroupName": B64.encode(b"Explorers\0"),
            }] }
        });
        let a = route(&mut st, &pkt);
        assert_eq!(emit_of(&a, "names-updated").unwrap()["names"][0]["name"], "Ruth");
        let g = emit_of(&a, "active-group").unwrap();
        assert_eq!(g["id"], "99999999-9999-9999-9999-999999999999");
        assert_eq!(g["title"], "Member");
        assert_eq!(g["name"], "Explorers");
        // Idempotent: feeding the same data again -> no active-group re-emit.
        let a2 = route(&mut st, &pkt);
        assert!(emit_of(&a2, "active-group").is_none());
    }

    #[test]
    fn uuid_name_reply_caches_and_reports() {
        let mut st = SessionState::default();
        let pkt = json!({
            "name": "UUIDNameReply",
            "blocks": { "UUIDNameBlock": [
                { "ID": "aaaaaaaa-0000-0000-0000-000000000001", "FirstName": B64.encode(b"Alice\0"), "LastName": B64.encode(b"Wonder\0") },
                { "ID": "aaaaaaaa-0000-0000-0000-000000000002", "FirstName": B64.encode(b"Bob\0"), "LastName": B64.encode(b"Resident\0") },
            ] }
        });
        let a = route(&mut st, &pkt);
        let names = emit_of(&a, "names-updated").unwrap()["names"].as_array().unwrap().clone();
        assert_eq!(names.len(), 2);
        assert_eq!(names[0]["name"], "Alice Wonder");
        assert_eq!(names[1]["name"], "Bob");
        assert_eq!(st.cached_name("aaaaaaaa-0000-0000-0000-000000000002"), Some("Bob"));
    }

    #[test]
    fn coarse_location_builds_radar_and_position() {
        let mut st = SessionState { agent_id: "me".into(), ..Default::default() };
        // index 0 is you, index 1 is another avatar.
        let pkt = json!({
            "name": "CoarseLocationUpdate",
            "blocks": {
                "Location": [ { "X": 128, "Y": 128, "Z": 6 }, { "X": 138, "Y": 128, "Z": 6 } ],
                "Index": [ { "You": 0, "Prey": -1 } ],
                "AgentData": [ { "AgentID": "me" }, { "AgentID": "bbbbbbbb-0000-0000-0000-000000000003" } ],
            }
        });
        let a = route(&mut st, &pkt);
        let pos = emit_of(&a, "position").unwrap();
        assert_eq!(pos["position"]["z"], 24.0); // 6 * 4 = 24
        let radar = emit_of(&a, "radar-update").unwrap().as_array().unwrap();
        assert_eq!(radar.len(), 1);
        assert_eq!(radar[0]["range"], 10.0);
        // An unknown name -> a resolve request gets queued.
        assert!(a.iter().any(|x| matches!(x, Action::ResolveNames(ids) if ids == &vec!["bbbbbbbb-0000-0000-0000-000000000003".to_string()])));
    }

    const ME: &str = "11111111-1111-1111-1111-111111111111";
    const OTHER: &str = "22222222-2222-2222-2222-222222222222";

    #[test]
    fn friendship_offer_emits_accept_prompt() {
        let mut st = me_state();
        let tx = "aaaaaaaa-1111-2222-3333-444444444444";
        // Dialog 38 with an empty message should still surface an accept/decline prompt.
        let a = route(&mut st, &im_packet(38, OTHER, ME, false, tx, "", ""));
        let e = emit_of(&a, "event").expect("friendship offer event");
        assert_eq!(e["prompt"]["type"], "friendship-offer");
        assert_eq!(e["prompt"]["transactionId"], tx);
    }

    #[test]
    fn agent_alert_message_is_surfaced() {
        let mut st = me_state();
        let a = route(&mut st, &json!({
            "name": "AgentAlertMessage",
            "blocks": { "AlertData": [{ "Message": B64.encode(b"You are not allowed on this land.\0") }] }
        }));
        let e = emit_of(&a, "chat").expect("agent alert should surface");
        assert_eq!(e["source"], "system");
        assert_eq!(e["text"], "You are not allowed on this land.");
    }

    fn im_packet(dialog: i64, from: &str, to: &str, from_group: bool, im_id: &str, text: &str, bucket: &str) -> Value {
        json!({
            "name": "ImprovedInstantMessage",
            "blocks": {
                "AgentData": [{ "AgentID": from, "SessionID": "00000000-0000-0000-0000-000000000000" }],
                "MessageBlock": [{
                    "FromGroup": from_group, "ToAgentID": to, "Offline": 0, "Dialog": dialog,
                    "ID": im_id, "Timestamp": 0,
                    "FromAgentName": B64.encode(b"Ruth Resident\0"),
                    "Message": B64.encode(format!("{text}\0").as_bytes()),
                    "BinaryBucket": B64.encode(format!("{bucket}\0").as_bytes()),
                }]
            }
        })
    }

    fn me_state() -> SessionState {
        SessionState { agent_id: ME.into(), now_ms: 1000, ..Default::default() }
    }

    #[test]
    fn p2p_im_emits_im_event() {
        let mut st = me_state();
        let pkt = im_packet(0, OTHER, ME, false, "00000000-0000-0000-0000-000000000000", "hello", "");
        let a = route(&mut st, &pkt);
        let p = emit_of(&a, "im").expect("im");
        assert_eq!(p["participant"]["id"], OTHER);
        assert_eq!(p["message"]["text"], "hello");
        assert_eq!(p["message"]["outgoing"], false);
        assert_eq!(p["sessionId"], xor_session_id(ME, OTHER));
        assert!(p.get("session").is_none());
    }

    #[test]
    fn im_typing_start_stop() {
        let mut st = me_state();
        let start = route(&mut st, &im_packet(41, OTHER, ME, false, "0", "", ""));
        assert_eq!(emit_of(&start, "im-typing").unwrap()["typing"], true);
        let stop = route(&mut st, &im_packet(42, OTHER, ME, false, "0", "", ""));
        assert_eq!(emit_of(&stop, "im-typing").unwrap()["typing"], false);
    }

    #[test]
    fn teleport_offer_parses_bucket() {
        let mut st = me_state();
        let pkt = im_packet(22, OTHER, ME, false, "33333333-3333-3333-3333-333333333333",
            "Join me\nhttp://maps.secondlife.com/x", "256000|256512|128|64|25|129|64|25|M");
        let a = route(&mut st, &pkt);
        let p = emit_of(&a, "teleport-offer").unwrap();
        assert_eq!(p["message"], "Join me");
        assert_eq!(p["lureId"], "33333333-3333-3333-3333-333333333333");
        assert_eq!(p["location"]["gridX"], 1000.0);
        assert_eq!(p["location"]["regionAccess"], "Mature");
    }

    #[test]
    fn im_dedup_within_window() {
        let mut st = me_state();
        let pkt = im_packet(0, OTHER, ME, false, "0", "dup", "");
        assert!(emit_of(&route(&mut st, &pkt), "im").is_some());
        st.now_ms = 1500; // still inside 1000 + 1500
        assert!(emit_of(&route(&mut st, &pkt), "im").is_none());
        st.now_ms = 3000; // the window has elapsed
        assert!(emit_of(&route(&mut st, &pkt), "im").is_some());
    }

    #[test]
    fn group_session_im_has_session_descriptor() {
        let mut st = me_state();
        let pkt = im_packet(17, OTHER, "00000000-0000-0000-0000-000000000000", true,
            "44444444-4444-4444-4444-444444444444", "hi group", "Explorers");
        let a = route(&mut st, &pkt);
        let p = emit_of(&a, "im").unwrap();
        assert_eq!(p["sessionId"], "44444444-4444-4444-4444-444444444444");
        assert_eq!(p["session"]["type"], "group");
        assert_eq!(p["session"]["title"], "Explorers");
    }

    #[test]
    fn script_dialog_emits_event_never_answers() {
        let mut st = SessionState::default();
        let pkt = json!({
            "name": "ScriptDialog",
            "blocks": {
                "Data": [{
                    "ObjectID": "d0000000-0000-0000-0000-000000000001",
                    "FirstName": B64.encode(b"Bob\0"), "LastName": B64.encode(b"Resident\0"),
                    "ObjectName": B64.encode(b"Vendor\0"), "Message": B64.encode(b"Pick one\0"),
                    "ChatChannel": -42, "ImageID": "00000000-0000-0000-0000-000000000000",
                }],
                "Buttons": [ { "ButtonLabel": B64.encode(b"Yes\0") }, { "ButtonLabel": B64.encode(b"No\0") } ],
                "OwnerData": [ { "OwnerID": "b0000000-0000-0000-0000-000000000002" } ],
            }
        });
        let a = route(&mut st, &pkt);
        let e = emit_of(&a, "event").expect("event");
        assert_eq!(e["kind"], "script-dialog");
        assert_eq!(e["dialog"]["buttons"][0], "Yes");
        assert_eq!(e["dialog"]["chatChannel"], -42);
        assert_eq!(e["dialog"]["resolved"], false);
        // No Send action here - the viewer never auto-replies.
        assert!(!a.iter().any(|x| matches!(x, Action::Send { .. })));
    }

    #[test]
    fn script_question_decodes_permissions() {
        let mut st = SessionState::default();
        let pkt = json!({
            "name": "ScriptQuestion",
            "blocks": { "Data": [{
                "TaskID": "d0000000-0000-0000-0000-000000000001",
                "ItemID": "d0000000-0000-0000-0000-000000000003",
                "ObjectName": B64.encode(b"Gadget\0"), "ObjectOwner": B64.encode(b"Bob\0"),
                "Questions": 2, // the debit permission
            }] }
        });
        let a = route(&mut st, &pkt);
        let e = emit_of(&a, "event").unwrap();
        assert_eq!(e["kind"], "script-permission");
        assert_eq!(e["permission"]["hasCaution"], true);
        assert_eq!(e["permission"]["lines"][0], "Take Linden dollars (L$) from your account");
    }

    #[test]
    fn load_url_prompt() {
        let mut st = SessionState::default();
        let pkt = json!({
            "name": "LoadURL",
            "blocks": { "Data": [{
                "ObjectName": B64.encode(b"Sign\0"), "ObjectID": "d0000000-0000-0000-0000-000000000001",
                "OwnerID": "00000000-0000-0000-0000-000000000000", "OwnerIsGroup": false,
                "Message": B64.encode(b"Visit us\0"), "URL": B64.encode(b"https://example.com\0"),
            }] }
        });
        let e = route(&mut st, &pkt);
        let ev = emit_of(&e, "event").unwrap();
        assert_eq!(ev["prompt"]["type"], "load-url");
        assert_eq!(ev["prompt"]["url"], "https://example.com");
    }

    #[test]
    fn group_titles_join_and_membership() {
        let mut st = SessionState { agent_id: "self".into(), ..Default::default() };
        let titles = route(&mut st, &json!({
            "name": "GroupTitlesReply",
            "blocks": {
                "AgentData": [{ "AgentID": "self", "GroupID": "g0000000-0000-0000-0000-000000000001", "RequestID": "r1" }],
                "GroupData": [
                    { "Title": B64.encode(b"Zealot\0"), "RoleID": "z", "Selected": false },
                    { "Title": B64.encode(b"Member\0"), "RoleID": "00000000-0000-0000-0000-000000000000", "Selected": true },
                    { "Title": B64.encode(b"\0"), "RoleID": "x", "Selected": false },
                ]
            }
        }));
        let t = emit_of(&titles, "group-titles").unwrap();
        // Every title is kept (a blank one shows as "(no title)" in the UI) and
        // sorted alphabetically with the blank/default title first.
        assert_eq!(t["titles"].as_array().unwrap().len(), 3);
        assert_eq!(t["titles"][0]["title"], "");
        assert_eq!(t["titles"][1]["title"], "Member");
        assert_eq!(t["titles"][1]["selected"], true);
        assert_eq!(t["titles"][2]["title"], "Zealot");

        let join = route(&mut st, &json!({
            "name": "JoinGroupReply",
            "blocks": { "AgentData": [{ "AgentID": "self" }], "GroupData": [{ "GroupID": "g0000000-0000-0000-0000-000000000001", "Success": true }] }
        }));
        let j = emit_of(&join, "group-action").unwrap();
        assert_eq!(j["action"], "join");
        assert_eq!(j["success"], true);

        let mem = route(&mut st, &json!({
            "name": "AgentGroupDataUpdate",
            "blocks": {
                "AgentData": [{ "AgentID": "self" }],
                "GroupData": [{ "GroupID": "g0000000-0000-0000-0000-000000000001", "GroupPowers": "0", "AcceptNotices": true, "GroupInsigniaID": "00000000-0000-0000-0000-000000000000", "Contribution": 0, "GroupName": B64.encode(b"Explorers\0") }]
            }
        }));
        let m = emit_of(&mem, "group-membership").unwrap();
        assert_eq!(m["groups"][0]["name"], "Explorers");
    }

    #[test]
    fn eq_chatterbox_invitation_emits_session_im() {
        let mut st = me_state();
        let body = json!({
            "instantmessage": { "message_params": {
                "from_id": OTHER, "id": "55555555-5555-5555-5555-555555555555",
                "from_name": "Ruth Resident", "message": "hi group",
            } }
        });
        let a = route_eq(&mut st, "ChatterBoxInvitation", &body);
        let p = emit_of(&a, "im").expect("im");
        assert_eq!(p["sessionId"], "55555555-5555-5555-5555-555555555555");
        assert_eq!(p["session"]["type"], "conference");
        assert_eq!(p["message"]["text"], "hi group");
        // A duplicate within the window is suppressed.
        let a2 = route_eq(&mut st, "ChatterBoxInvitation", &body);
        assert!(emit_of(&a2, "im").is_none());
    }

    #[test]
    fn eq_force_close_and_roster() {
        let mut st = me_state();
        let close = route_eq(&mut st, "ForceCloseChatterBoxSession", &json!({ "session_id": "s1", "reason": "gone" }));
        assert_eq!(emit_of(&close, "im-session-force-close").unwrap()["reason"], "gone");
        let roster = route_eq(&mut st, "ChatterBoxSessionAgentListUpdates", &json!({
            "session_id": "s1",
            "updates": { "aaaaaaaa-0000-0000-0000-000000000009": { "transition": "ENTER", "info": { "is_moderator": true } } }
        }));
        let r = emit_of(&roster, "im-roster").unwrap();
        assert_eq!(r["participants"][0]["isModerator"], true);
    }

    #[test]
    fn eq_teleport_finish_retargets_and_refreshes_caps() {
        let mut st = me_state();
        st.sim_ip = "54.71.12.247".into();
        st.sim_port = 13000;
        st.circuit_code = 42;
        // The real EventQueue body shape, taken from a live log: SimIP is a 4-byte
        // array, SimPort a number, and SeedCapability a native string.
        let body = json!({ "Info": [{
            "SimIP": [34, 220, 14, 80], "SimPort": 13003,
            "SeedCapability": "https://simhost-x.agni.secondlife.io:12043/cap/abc",
        }] });
        let a = route_eq(&mut st, "TeleportFinish", &body);
        assert!(a.iter().any(|x| matches!(x,
            Action::Retarget { sim_ip, sim_port, circuit_code, .. }
            if sim_ip == "34.220.14.80" && *sim_port == 13003 && *circuit_code == 42)),
            "expected a Retarget to the new sim");
        assert!(a.iter().any(|x| matches!(x,
            Action::RefreshCaps { seed_url, sim_ip }
            if seed_url.ends_with("/cap/abc") && sim_ip == "34.220.14.80")),
            "expected a RefreshCaps for the new region");
        assert_eq!(st.sim_ip, "34.220.14.80");
        assert_eq!(st.sim_port, 13003);
        assert_eq!(emit_of(&a, "teleport-finish").unwrap()["simIp"], "34.220.14.80");
    }

    #[test]
    fn eq_parcel_properties_parses_llsd() {
        let mut st = me_state();
        // Trimmed down from a real EventQueue ParcelProperties body.
        let body = json!({
            "ParcelData": [{
                "RequestResult": 0, "LocalID": 2, "Area": 9216, "MaxPrims": 2812,
                "OwnerPrims": 0, "GroupPrims": 46, "OtherPrims": 0, "SelectedPrims": 0,
                "ParcelPrimBonus": 1.5, "IsGroupOwned": true,
                "OwnerID": "8ca577e3-90e1-8865-db50-593b96c1a3ec",
                "GroupID": "8ca577e3-90e1-8865-db50-593b96c1a3ec",
                "Name": "Sandbox Mall", "Desc": "A sandbox.",
                "MusicURL": "http://example/stream.mp3",
                "ParcelFlags": [166, 36, 144, 75],
                "PassPrice": 10, "PassHours": 10.0, "Category": 7, "LandingType": 1,
                "SnapshotID": "00000000-0000-0000-0000-000000000000",
                "UserLocation": [128.0, 128.0, 25.0], "UserLookAt": [1.0, 0.0, 0.0]
            }]
        });
        let a = route_eq(&mut st, "ParcelProperties", &body);
        let p = emit_of(&a, "parcel").expect("parcel event");
        assert_eq!(p["name"], "Sandbox Mall");
        assert_eq!(p["area"], 9216);
        assert_eq!(p["musicUrl"], "http://example/stream.mp3");
        assert_eq!(p["primsUsed"], 46);
        assert_eq!(p["primsTotal"], (2812.0 * 1.5_f64).round() as i64);
        assert_eq!(p["isGroupOwned"], true);
        // ParcelFlags 0xA624904B (big-endian): build + scripts + fly + voice + search,
        // with the DAMAGE bit clear.
        assert_eq!(p["allowBuild"], true);
        assert_eq!(p["allowFly"], true);
        assert_eq!(p["allowVoice"], true);
        assert_eq!(p["showInSearch"], true);
        assert_eq!(p["safeEnvironment"], true);
    }

    #[test]
    fn roster_merges_deltas_keeps_moderator_and_detects_group() {
        let mut st = me_state();
        st.groups.insert("gggggggg-0000-0000-0000-000000000001".into());
        // First delta: two members, and self is a moderator.
        route_eq(&mut st, "ChatterBoxSessionAgentListUpdates", &json!({
            "session_id": "gggggggg-0000-0000-0000-000000000001",
            "agent_updates": {
                ME: { "transition": "ENTER", "info": { "is_moderator": true } },
                OTHER: { "transition": "ENTER", "info": { "is_moderator": false, "mutes": { "text": 1 } } },
            }
        }));
        // Second delta: a single new joiner - it must NOT wipe out the first two.
        let r2 = route_eq(&mut st, "ChatterBoxSessionAgentListUpdates", &json!({
            "session_id": "gggggggg-0000-0000-0000-000000000001",
            "agent_updates": { "cccccccc-0000-0000-0000-000000000003": { "transition": "ENTER", "info": {} } }
        }));
        let r = emit_of(&r2, "im-roster").unwrap();
        assert_eq!(r["type"], "group"); // the session id is a joined group
        assert_eq!(r["moderator"], true); // the self moderator flag persists across deltas
        assert_eq!(r["participants"].as_array().unwrap().len(), 3);
        // OTHER's text-mute, sent as int 1, survives.
        let other = r["participants"].as_array().unwrap().iter().find(|p| p["id"] == OTHER).unwrap();
        assert_eq!(other["muted"], true);
        // A LEAVE removes only that one participant.
        let r3 = route_eq(&mut st, "ChatterBoxSessionAgentListUpdates", &json!({
            "session_id": "gggggggg-0000-0000-0000-000000000001",
            "agent_updates": { OTHER: { "transition": "LEAVE" } }
        }));
        let r = emit_of(&r3, "im-roster").unwrap();
        assert_eq!(r["participants"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn roster_partial_delta_preserves_omitted_fields() {
        let mut st = me_state();
        let sid = "ffffffff-0000-0000-0000-000000000001";
        // Self is a moderator, and a peer is a plain member.
        route_eq(&mut st, "ChatterBoxSessionAgentListUpdates", &json!({
            "session_id": sid,
            "agent_updates": {
                ME: { "transition": "ENTER", "info": { "is_moderator": true } },
                OTHER: { "transition": "ENTER", "info": { "is_moderator": false } },
            }
        }));
        // A later delta that mutes OTHER carries ONLY mutes (no is_moderator), so it
        // must not reset anyone's moderator flag, the local user's included.
        let r = route_eq(&mut st, "ChatterBoxSessionAgentListUpdates", &json!({
            "session_id": sid,
            "agent_updates": { OTHER: { "info": { "mutes": { "text": true } } } }
        }));
        let e = emit_of(&r, "im-roster").unwrap();
        assert_eq!(e["moderator"], true, "self moderator must persist");
        let other = e["participants"].as_array().unwrap().iter().find(|p| p["id"] == OTHER).unwrap();
        assert_eq!(other["muted"], true);
    }

    #[test]
    fn script_dialog_textbox_token_becomes_input() {
        let mut st = me_state();
        let pkt = json!({
            "name": "ScriptDialog",
            "blocks": {
                "Data": [{
                    "ObjectID": "dddddddd-0000-0000-0000-000000000001", "FirstName": "", "LastName": "",
                    "ObjectName": B64.encode(b"Box\0"), "Message": B64.encode(b"Type something\0"),
                    "ChatChannel": -42, "ImageID": "00000000-0000-0000-0000-000000000000",
                }],
                "Buttons": [{ "ButtonLabel": B64.encode(b"!!llTextBox!!\0") }],
                "OwnerData": [{ "OwnerID": "00000000-0000-0000-0000-000000000000" }],
            }
        });
        let a = route(&mut st, &pkt);
        let e = emit_of(&a, "event").unwrap();
        assert_eq!(e["dialog"]["isTextBox"], true);
        assert_eq!(e["dialog"]["buttons"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn avatar_properties_reply_maps_profile_and_flags() {
        let mut st = SessionState::default();
        let pkt = json!({
            "name": "AvatarPropertiesReply",
            "blocks": {
                "AgentData": [{ "AgentID": "me", "AvatarID": "av1" }],
                "PropertiesData": [{
                    "ImageID": "img", "FLImageID": "fl", "PartnerID": "00000000-0000-0000-0000-000000000000",
                    "AboutText": B64.encode(b"hi\0"), "FLAboutText": B64.encode(b"\0"),
                    "BornOn": B64.encode(b"2020-01-01\0"), "ProfileURL": B64.encode(b"\0"),
                    "CharterMember": B64.encode(b"\0"), "Flags": 0x1 | 0x10,
                }]
            }
        });
        let a = route(&mut st, &pkt);
        let p = emit_of(&a, "avatar-profile").unwrap();
        assert_eq!(p["avatarId"], "av1");
        assert_eq!(p["about"], "hi");
        assert_eq!(p["flags"]["allowPublish"], true);
        assert_eq!(p["flags"]["online"], true);
        assert_eq!(p["flags"]["transacted"], false);
    }

    #[test]
    fn parcel_info_picks_classifieds() {
        let mut st = SessionState::default();
        let info = route(&mut st, &json!({
            "name": "ParcelInfoReply",
            "blocks": { "AgentData": [{ "AgentID": "me" }], "Data": [{
                "ParcelID": "pc1", "OwnerID": "o1", "Name": B64.encode(b"Plot\0"), "Desc": B64.encode(b"d\0"),
                "ActualArea": 512, "BillableArea": 512, "Flags": 0, "GlobalX": 256000.0, "GlobalY": 257024.0, "GlobalZ": 25.0,
                "SimName": B64.encode(b"Natoma\0"), "SnapshotID": "00000000-0000-0000-0000-000000000000", "Dwell": 3.0, "SalePrice": 0, "AuctionID": 0
            }] }
        }));
        let pi = emit_of(&info, "parcel-info").unwrap();
        assert_eq!(pi["parcelId"], "pc1");
        assert_eq!(pi["area"], 512);
        assert_eq!(pi["simName"], "Natoma");

        let picks = route(&mut st, &json!({
            "name": "AvatarPicksReply",
            "blocks": { "AgentData": [{ "AgentID": "me", "TargetID": "av1" }],
                "Data": [{ "PickID": "pk1", "PickName": B64.encode(b"My Spot\0") }] }
        }));
        let pk = emit_of(&picks, "avatar-picks").unwrap();
        assert_eq!(pk["avatarId"], "av1");
        assert_eq!(pk["picks"][0]["name"], "My Spot");
    }

    #[test]
    fn group_profile_reply_maps_fields() {
        let mut st = SessionState::default();
        let pkt = json!({
            "name": "GroupProfileReply",
            "blocks": { "GroupData": [{
                "GroupID": "g0000000-0000-0000-0000-000000000001", "Name": B64.encode(b"Explorers\0"),
                "Charter": B64.encode(b"We explore\0"), "ShowInList": true, "MemberTitle": B64.encode(b"Member\0"),
                "PowersMask": "0", "InsigniaID": "i0000000-0000-0000-0000-000000000001",
                "FounderID": "00000000-0000-0000-0000-000000000000", "MembershipFee": 0, "OpenEnrollment": true,
                "Money": 0, "GroupMembershipCount": 42, "GroupRolesCount": 3, "AllowPublish": false, "MaturePublish": false,
            }] }
        });
        let a = route(&mut st, &pkt);
        let p = emit_of(&a, "group-profile").expect("group-profile");
        assert_eq!(p["name"], "Explorers");
        assert_eq!(p["charter"], "We explore");
        assert_eq!(p["memberCount"], 42);
        assert_eq!(p["openEnrollment"], true);
    }

    #[test]
    fn avatar_groups_and_interests() {
        let mut st = SessionState::default();
        let groups = route(&mut st, &json!({
            "name": "AvatarGroupsReply",
            "blocks": {
                "AgentData": [{ "AgentID": "me", "AvatarID": "av1" }],
                "GroupData": [{ "GroupID": "g1", "GroupName": B64.encode(b"Team\0"), "GroupTitle": B64.encode(b"Lead\0"), "GroupInsigniaID": "x", "GroupPowers": "0", "AcceptNotices": true }],
                "NewGroupData": [{ "ListInProfile": true }],
            }
        }));
        let g = emit_of(&groups, "avatar-groups").unwrap();
        assert_eq!(g["groups"][0]["name"], "Team");
        assert_eq!(g["groups"][0]["listInProfile"], true);

        // WantToMask 0x1|0x4 is Build + Meet; SkillsMask 0x10 is Scripting.
        let interests = route(&mut st, &json!({
            "name": "AvatarInterestsReply",
            "blocks": {
                "AgentData": [{ "AgentID": "me", "AvatarID": "av1" }],
                "PropertiesData": [{ "WantToMask": 5, "WantToText": B64.encode(b"stuff\0"), "SkillsMask": 16, "SkillsText": B64.encode(b"\0"), "LanguagesText": B64.encode(b"en\0") }],
            }
        }));
        let i = emit_of(&interests, "avatar-interests").unwrap();
        assert_eq!(i["wantTo"], json!(["Build", "Meet"]));
        assert_eq!(i["skills"], json!(["Scripting"]));
        assert_eq!(i["languagesText"], "en");
    }

    #[test]
    fn dir_places_groups_and_picker() {
        let mut st = SessionState::default();
        let places = route(&mut st, &json!({
            "name": "DirPlacesReply",
            "blocks": { "AgentData": [{ "AgentID": "me" }], "QueryData": [{ "QueryID": "q1" }],
                "QueryReplies": [{ "ParcelID": "p1", "Name": B64.encode(b"Nice Spot\0"), "ForSale": false, "Auction": false, "Dwell": 12.5 }] }
        }));
        let p = emit_of(&places, "dir-places-reply").unwrap();
        assert_eq!(p["queryId"], "q1");
        assert_eq!(p["places"][0]["name"], "Nice Spot");
        assert_eq!(p["places"][0]["dwell"], 12.5);
    }

    #[test]
    fn dir_people_reply_carries_query_and_results() {
        let mut st = SessionState::default();
        let pkt = json!({
            "name": "DirPeopleReply",
            "blocks": {
                "AgentData": [{ "AgentID": "me" }],
                "QueryData": [{ "QueryID": "q1" }],
                "QueryReplies": [
                    { "AgentID": "p1", "FirstName": B64.encode(b"Ann\0"), "LastName": B64.encode(b"Lee\0"), "Group": B64.encode(b"\0"), "Online": true, "Reputation": 0 }
                ]
            }
        });
        let a = route(&mut st, &pkt);
        let p = emit_of(&a, "dir-people-reply").unwrap();
        assert_eq!(p["queryId"], "q1");
        assert_eq!(p["people"][0]["firstName"], "Ann");
        assert_eq!(p["people"][0]["name"], "Ann Lee"); // first + last, combined for the search UI
        assert_eq!(p["people"][0]["online"], true);
    }

    #[test]
    fn sim_stats_reports_fps_and_dilation() {
        let mut st = SessionState::default();
        let a = route(&mut st, &json!({
            "name": "SimStats",
            "blocks": {
                "Region": [{ "RegionX": 0, "RegionY": 0, "RegionFlags": 0, "ObjectCapacity": 0 }],
                "Stat": [
                    { "StatID": 0, "StatValue": 0.98 },
                    { "StatID": 1, "StatValue": 44.6 },
                    { "StatID": 2, "StatValue": 45.0 },
                ],
            }
        }));
        let s = emit_of(&a, "stats").unwrap();
        assert_eq!(s["fps"], 45.0); // from StatID 1, rounded
        assert_eq!(s["timeDilation"], 0.98); // from StatID 0
    }

    #[test]
    fn online_offline_notifications_emit_presence() {
        let mut st = SessionState::default();
        let on = route(&mut st, &json!({
            "name": "OnlineNotification",
            "blocks": { "AgentBlock": [{ "AgentID": "b1" }, { "AgentID": "b2" }] }
        }));
        let e = emit_of(&on, "buddy-online").unwrap();
        assert_eq!(e["online"], true);
        assert_eq!(e["ids"], json!(["b1", "b2"]));

        let off = route(&mut st, &json!({
            "name": "OfflineNotification",
            "blocks": { "AgentBlock": [{ "AgentID": "b1" }] }
        }));
        let e = emit_of(&off, "buddy-offline").unwrap();
        assert_eq!(e["online"], false);
        assert_eq!(e["ids"], json!(["b1"]));
    }

    #[test]
    fn crossed_region_requests_caps_refresh() {
        let mut st = SessionState {
            agent_id: "a".into(), session_uuid: "s".into(), circuit_code: 99,
            sim_ip: "1.1.1.1".into(), sim_port: 13000, ..Default::default()
        };
        let a = route(&mut st, &json!({
            "name": "CrossedRegion",
            "blocks": {
                "AgentData": [{ "AgentID": "a", "SessionID": "s" }],
                "RegionData": [{ "SimIP": "2.2.2.2", "SimPort": 13001, "RegionHandle": "1", "SeedCapability": B64.encode(b"https://new/seed\0") }],
                "Info": [{ "Position": [10.0, 20.0, 30.0], "LookAt": [1.0, 0.0, 0.0] }],
            }
        }));
        let refresh = a.iter().find_map(|x| match x {
            Action::RefreshCaps { seed_url, .. } => Some(seed_url.clone()),
            _ => None,
        });
        assert_eq!(refresh.as_deref(), Some("https://new/seed"));
    }

    #[test]
    fn teleport_finish_switches_sim_and_reports() {
        let mut st = SessionState {
            agent_id: "a".into(), session_uuid: "s".into(), circuit_code: 99,
            sim_ip: "1.1.1.1".into(), sim_port: 13000, ..Default::default()
        };
        let pkt = json!({
            "name": "TeleportFinish",
            "blocks": { "Info": [{
                "AgentID": "a", "LocationID": 0, "SimIP": "2.2.2.2", "SimPort": 13001,
                "RegionHandle": "1099511628032", "SeedCapability": B64.encode(b"https://seed/cap\0"),
                "SimAccess": 13, "TeleportFlags": 16,
            }] }
        });
        let a = route(&mut st, &pkt);
        // We should retarget to the new sim.
        let retarget = a.iter().find(|x| matches!(x, Action::Retarget { .. })).expect("retarget");
        if let Action::Retarget { sim_ip, sim_port, circuit_code, .. } = retarget {
            assert_eq!(sim_ip, "2.2.2.2");
            assert_eq!(*sim_port, 13001);
            assert_eq!(*circuit_code, 99);
        }
        assert_eq!(st.sim_ip, "2.2.2.2");
        let fin = emit_of(&a, "teleport-finish").unwrap();
        assert_eq!(fin["simIp"], "2.2.2.2");
        assert_eq!(fin["url"], "https://seed/cap");
    }

    #[test]
    fn teleport_finish_same_sim_no_retarget() {
        let mut st = SessionState { sim_ip: "1.1.1.1".into(), sim_port: 13000, ..Default::default() };
        let pkt = json!({
            "name": "TeleportFinish",
            "blocks": { "Info": [{ "SimIP": "1.1.1.1", "SimPort": 13000, "RegionHandle": "1", "SeedCapability": B64.encode(b"\0"), "TeleportFlags": 0 }] }
        });
        let a = route(&mut st, &pkt);
        assert!(!a.iter().any(|x| matches!(x, Action::Retarget { .. })));
        assert!(emit_of(&a, "teleport-finish").is_some());
    }

    #[test]
    fn movement_complete_emits_position() {
        let mut st = SessionState::default();
        let pkt = json!({
            "name": "AgentMovementComplete",
            "blocks": { "Data": [{ "Position": [10.0, 20.0, 30.0], "LookAt": [1.0, 0.0, 0.0], "RegionHandle": "1", "Timestamp": 0 }] }
        });
        let a = route(&mut st, &pkt);
        let p = emit_of(&a, "position").unwrap();
        assert_eq!(p["source"], "movement");
        assert_eq!(p["position"]["x"], 10.0);
    }

    #[test]
    fn movement_complete_requests_balance_and_agent_data() {
        // With an agent id set, arriving in-region asks the sim for the L$ balance
        // and the agent data (active group + title). The latter isn't pushed on
        // login, so we need it to show the active-group tag.
        let mut st = SessionState { agent_id: "me".into(), ..Default::default() };
        let pkt = json!({
            "name": "AgentMovementComplete",
            "blocks": { "Data": [{ "Position": [1.0, 2.0, 3.0], "LookAt": [1.0, 0.0, 0.0], "RegionHandle": "1", "Timestamp": 0 }] }
        });
        let a = route(&mut st, &pkt);
        assert!(a.iter().any(|x| matches!(x, Action::Send { name, .. } if name == "MoneyBalanceRequest")));
        assert!(a.iter().any(|x| matches!(x, Action::Send { name, .. } if name == "AgentDataUpdateRequest")));
    }

    #[test]
    fn teleport_failed_benign_vs_real() {
        let mut st = SessionState::default();
        let benign = route(&mut st, &json!({ "name": "TeleportFailed", "blocks": { "Info": [{ "AgentID": "x", "Reason": B64.encode(b"Could not teleport closer to destination\0") }] } }));
        assert!(emit_of(&benign, "teleport-finish").unwrap()["benign"].as_bool().unwrap());
        let real = route(&mut st, &json!({ "name": "TeleportFailed", "blocks": { "Info": [{ "AgentID": "x", "Reason": B64.encode(b"Region full\0") }] } }));
        assert_eq!(emit_of(&real, "teleport-failed").unwrap()["reason"], "Region full");
    }

    #[test]
    fn kick_and_calling_card() {
        let mut st = SessionState { agent_id: "me".into(), ..Default::default() };
        let kick = route(&mut st, &json!({ "name": "KickUser", "blocks": { "TargetBlock": [{ "TargetIP": "0.0.0.0", "TargetPort": 0 }], "UserInfo": [{ "AgentID": "me", "SessionID": "s", "Reason": B64.encode(b"bye\0") }] } }));
        assert_eq!(emit_of(&kick, "session-lost").unwrap()["reason"], "bye");
        let cc = route(&mut st, &json!({ "name": "AcceptCallingCard", "blocks": { "AgentData": [{ "AgentID": "a", "SessionID": "s" }], "TransactionBlock": [{ "TransactionID": "t" }] } }));
        assert!(emit_of(&cc, "chat").unwrap()["text"].as_str().unwrap().contains("accepted"));
    }

    #[test]
    fn parcel_properties_decodes_and_flags() {
        let mut st = SessionState { agent_id: "owner-1".into(), ..Default::default() };
        // Flags here: CREATE_OBJECTS(64) | ACCESS_GROUP(256) = 320.
        let pkt = json!({
            "name": "ParcelProperties",
            "blocks": { "ParcelData": [{
                "RequestResult": 0, "LocalID": 5, "OwnerID": "owner-1", "IsGroupOwned": false,
                "Area": 512, "ParcelFlags": 320, "SalePrice": 0,
                "Name": B64.encode(b"Sunny Lot\0"), "Desc": B64.encode(b"nice\0"),
                "MusicURL": B64.encode(b"http://x/s.mp3\0"), "MediaURL": B64.encode(b"\0"),
                "MediaID": "00000000-0000-0000-0000-000000000000",
                "GroupID": "00000000-0000-0000-0000-000000000000",
                "SnapshotID": "00000000-0000-0000-0000-000000000000",
                "AuthBuyerID": "00000000-0000-0000-0000-000000000000",
                "MaxPrims": 100, "ParcelPrimBonus": 1.0,
                "OwnerPrims": 3, "GroupPrims": 1, "OtherPrims": 0, "SelectedPrims": 0,
                "UserLocation": [10.0, 20.0, 30.0], "LandingType": 1,
                "PassPrice": 0, "PassHours": 0.0, "Category": 0, "MediaAutoScale": 0,
            }] }
        });
        let a = route(&mut st, &pkt);
        let p = emit_of(&a, "parcel").expect("parcel");
        assert_eq!(p["name"], "Sunny Lot");
        assert_eq!(p["area"], 512);
        assert_eq!(p["primsUsed"], 4);
        assert_eq!(p["primsTotal"], 100);
        assert_eq!(p["access"], 2); // group access
        assert_eq!(p["allowBuildEveryone"], true);
        assert_eq!(p["safeEnvironment"], true); // DAMAGE bit is clear
        assert_eq!(p["canEdit"], true); // we own it
        assert_eq!(p["landingPoint"]["x"], 10.0);
    }

    #[test]
    fn parcel_group_owned_canedit_needs_land_power() {
        // A group-owned parcel, so the owner id is the group id.
        let group = "g0000000-0000-0000-0000-0000000000aa";
        let pkt = |st: &mut SessionState| {
            let p = json!({
                "name": "ParcelProperties",
                "blocks": { "ParcelData": [{
                    "RequestResult": 0, "LocalID": 1, "OwnerID": group, "IsGroupOwned": true,
                    "Area": 128, "ParcelFlags": 0, "MaxPrims": 100, "ParcelPrimBonus": 1.0,
                    "OwnerPrims": 0, "GroupPrims": 0, "OtherPrims": 0, "SelectedPrims": 0,
                    "Name": B64.encode(b"G\0"), "Desc": B64.encode(b"\0"),
                    "MusicURL": B64.encode(b"\0"), "MediaURL": B64.encode(b"\0"),
                    "MediaID": "00000000-0000-0000-0000-000000000000", "GroupID": group,
                    "SnapshotID": "00000000-0000-0000-0000-000000000000",
                    "AuthBuyerID": "00000000-0000-0000-0000-000000000000",
                    "UserLocation": [0.0, 0.0, 0.0], "LandingType": 0,
                    "PassPrice": 0, "PassHours": 0.0, "Category": 0, "MediaAutoScale": 0,
                }] }
            });
            route(st, &p)
        };
        // Not a member -> can't edit.
        let mut st = SessionState { agent_id: "me".into(), ..Default::default() };
        assert_eq!(emit_of(&pkt(&mut st), "parcel").unwrap()["canEdit"], false);
        // A member but WITHOUT the land power -> still can't edit (fields stay disabled).
        let mut st2 = SessionState { agent_id: "me".into(), ..Default::default() };
        st2.groups.insert(group.to_lowercase());
        st2.group_powers.insert(group.to_lowercase(), 0);
        assert_eq!(emit_of(&pkt(&mut st2), "parcel").unwrap()["canEdit"], false);
        // A member WITH GP_LAND_CHANGE_IDENTITY (1<<18) -> can edit.
        let mut st3 = SessionState { agent_id: "me".into(), ..Default::default() };
        st3.groups.insert(group.to_lowercase());
        st3.group_powers.insert(group.to_lowercase(), 1 << 18);
        assert_eq!(emit_of(&pkt(&mut st3), "parcel").unwrap()["canEdit"], true);
    }

    #[test]
    fn global_to_grid_derives_region_and_local() {
        // Region corner (1000, 1001) with a 128,128 offset inside the region.
        assert_eq!(global_to_grid(256_128.0, 256_384.0, 25.0), (1000, 1001, 128, 128, 25));
        // No location -> grid 0,0, which the UI treats as "no location set".
        assert_eq!(global_to_grid(0.0, 0.0, 0.0), (0, 0, 0, 0, 0));
    }

    #[test]
    fn fold_parcel_flags_toggles_managed_and_preserves_the_rest() {
        use super::pflag;
        // Baseline: an unmanaged bit (TERRAFORM) plus DAMAGE, both on.
        let baseline = pflag::TERRAFORM | pflag::DAMAGE;
        // An empty payload -> unchanged (no data loss on a no-op save).
        assert_eq!(fold_parcel_flags(baseline, &json!({})), baseline);
        // Turn on fly and build-everyone, and mark the parcel safe.
        let f = fold_parcel_flags(baseline, &json!({
            "allowFly": true, "allowBuildEveryone": true, "safeEnvironment": true
        }));
        assert!(f & pflag::FLY != 0);
        assert!(f & pflag::CREATE_OBJECTS != 0);
        assert_eq!(f & pflag::DAMAGE, 0);        // safeEnvironment clears DAMAGE
        assert!(f & pflag::TERRAFORM != 0);      // the unmanaged bit is preserved
        // safeEnvironment=false turns the DAMAGE bit back on.
        assert!(fold_parcel_flags(0, &json!({ "safeEnvironment": false })) & pflag::DAMAGE != 0);
        // A managed bit already in the baseline is cleared when its boolean is false.
        assert_eq!(fold_parcel_flags(pflag::FLY, &json!({ "allowFly": false })) & pflag::FLY, 0);
    }

    #[test]
    fn parcel_no_data_is_dropped() {
        let mut st = SessionState::default();
        let pkt = json!({ "name": "ParcelProperties", "blocks": { "ParcelData": [{ "RequestResult": -1 }] } });
        assert!(route(&mut st, &pkt).is_empty());
    }

    #[test]
    fn map_block_reply_emits_blocks_and_agents() {
        let mut st = SessionState::default();
        let pkt = json!({
            "name": "MapBlockReply",
            "blocks": {
                "AgentData": [{ "AgentID": "x", "Flags": 0 }],
                "Data": [
                    { "X": 1000, "Y": 1001, "Name": B64.encode(b"Natoma\0"), "Access": 13, "RegionFlags": 0, "Agents": 3 },
                    { "X": 1002, "Y": 1001, "Name": B64.encode(b"Empty\0"), "Access": 13, "RegionFlags": 0, "Agents": 0 },
                ]
            }
        });
        let a = route(&mut st, &pkt);
        let blocks = emit_of(&a, "map-blocks").unwrap().as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["name"], "Natoma");
        let agents = emit_of(&a, "map-agents").unwrap();
        assert_eq!(agents["gridX"], 1000);
        assert_eq!(agents["agents"], 3);
    }

    #[test]
    fn region_handshake_records_emits_and_acks_once() {
        let mut st = SessionState {
            agent_id: "11111111-1111-1111-1111-111111111111".into(),
            session_uuid: "22222222-2222-2222-2222-222222222222".into(),
            ..Default::default()
        };
        // SimName is a Variable field, so it's base64("Natoma\0").
        let sim = B64.encode(b"Natoma\0");
        let pkt = json!({
            "name": "RegionHandshake",
            "blocks": {
                "RegionInfo": [{ "SimName": sim }],
                "RegionInfo2": [{ "RegionID": "33333333-3333-3333-3333-333333333333" }],
            }
        });

        let actions = route(&mut st, &pkt);
        assert_eq!(st.region_name, "Natoma");
        assert_eq!(st.region_id, "33333333-3333-3333-3333-333333333333");
        assert!(matches!(actions[0], Action::Emit { .. }));
        assert!(matches!(actions[1], Action::Send { .. }));

        // A repeat handshake still re-emits region, but doesn't ack again.
        let again = route(&mut st, &pkt);
        assert_eq!(again.len(), 1);
        assert!(matches!(again[0], Action::Emit { .. }));
    }
}
