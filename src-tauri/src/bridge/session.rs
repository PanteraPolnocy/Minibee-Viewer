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
use std::fmt::Write;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};

use crate::bridge::util::truthy;

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
    /// Ask the region for a 360-degree interest list, so object updates aren't culled to
    /// a camera frustum we don't have. Sent on arrival, since each region decides this
    /// for itself. See `caps::interest_list_360`.
    InterestList360,
    /// A transient sim-driven animation (landing, standing up...) is playing on
    /// our avatar. A rendering viewer plays the clip and reports back when it
    /// ends; we wait roughly a clip length, then send AGENT_CONTROL_FINISH_ANIM
    /// and re-assert the default stand. Without that reply the sim's avatar
    /// state machine parks mid-transition ("about to land, forever").
    FinishAnim { delay_ms: u64 },
    /// Rez any Current Outfit Folder attachments the sim didn't restore by
    /// itself, a little while after arriving in a region. See `outfit::restore`.
    RestoreOutfit { delay_ms: u64 },
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
    /// The sim product label from the handshake ("Mainland / Full Region"...).
    pub region_product: String,
    /// Region flags (extended when the sim sends them): resell/subdivide
    /// clauses for the Covenant tab live in bits 7 and 26.
    pub region_flags: u64,
    pub handshake_reply_sent: bool,
    /// Resolved display name per agent id, fed by name replies and agent data.
    pub names: HashMap<String, String>,
    /// Last self position we emitted (coarse), used for the 0.25m move threshold.
    pub last_pos: Option<[f64; 3]>,
    /// The last coarse self-position rejected as a wild jump (x, y). If the
    /// next radar tick lands on the same spot, last_pos is the stale side and
    /// the jump is accepted as a repair. See the CoarseLocationUpdate arm.
    pub coarse_repair: Option<[f64; 2]>,
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
    /// What we know about each group we belong to (lowercased id -> that group's
    /// row). The sim may describe our membership across several
    /// AgentGroupDataUpdate messages, so these accumulate rather than replace;
    /// see merge_group_data.
    pub group_data: HashMap<String, Value>,
    /// True while we're sitting on something, learned from AvatarSitResponse and
    /// cleared when we stand. Teleports check this: the sim won't move a seated
    /// avatar, so we have to stand up first.
    pub sitting: bool,
    /// The object we're sitting on, when we are.
    pub sit_object: String,
    /// True between sending AgentRequestSit and hearing back. A named alert
    /// (CantSitNoRoom and friends) arriving while this is set means the sim
    /// refused the sit; a timeout in `sl_object_sit` covers the silent refusals.
    pub sit_pending: bool,
    /// Whether we've asked to fly. Unlike the one-shot sit/stand requests, the sim
    /// expects AGENT_CONTROL_FLY on every AgentUpdate, so we have to remember it.
    pub flying: bool,
    /// Whether the Interactions tab has asked for the nearby list. Tracking itself is
    /// always on - this only records that somebody is looking.
    pub object_scan: bool,
    pub objects: crate::bridge::objects::ObjectTable,
    /// When we last asked the sim for object names, so a busy list can't turn into a
    /// stream of requests. Nothing here is worth annoying Linden Lab over.
    pub props_asked_ms: u64,
    /// Where the last teleport was aimed, so `teleport-started` can tell the UI the
    /// destination. TeleportStart itself only carries flags.
    pub tp_target: Option<Value>,
    /// Wall-clock ms, refreshed by the IO layer before every route() call so that
    /// time-based dedup stays deterministic and testable.
    pub now_ms: u64,
    /// IM content dedup: key -> last-seen ms (1500ms window, capped at 600 entries).
    pub im_dedup: HashMap<String, u64>,
    /// Per-IM-session roster, so the incremental ChatterBoxSessionAgentListUpdates
    /// deltas can be merged into a full snapshot (the UI replaces the list wholesale).
    pub im_rosters: HashMap<String, ImRoster>,
    /// Inbound file transfers in progress, keyed by the id we chose when asking. The mute
    /// list is the only thing we fetch this way.
    pub xfers: HashMap<u64, XferIn>,
    /// Counter feeding unique transfer ids.
    pub xfer_seq: u32,
    /// True once we've asked for the mute list, so `UseCachedMuteList` - which we can
    /// never honour, having no disk cache - can't bounce us into asking forever.
    pub mute_asked: bool,
    /// The grid block list as an inbound filter: lowercased id -> mute flags,
    /// agents, objects, and groups alike (the UI's people-only list is a
    /// subset). Flag bits are exemptions - 0 is a full block, bit 1 spares
    /// text - matching how the reference viewer reads its mute list.
    pub muted: HashMap<String, u32>,
    /// Blocks and unblocks made this session (id -> Some(flags) / None for a
    /// removal), re-applied over every fetched list. The sim's file can predate
    /// a write that's already on the wire, so a fetch alone would undo it.
    pub mute_overrides: HashMap<String, Option<u32>>,
    /// Residents whose notes the AgentProfile cap has actually delivered, lowercased.
    ///
    /// The cap is authoritative where it answers, but it does not always carry a
    /// `notes` key - so the presence of the capability alone can't be what silences
    /// the legacy `AvatarNotesReply`, or notes would never arrive at all and the
    /// field would sit on "Loading notes" forever. Recording real deliveries lets
    /// the legacy reply fill in, while still keeping a late empty one from blanking
    /// notes the cap already gave us.
    pub cap_notes: HashSet<String>,
    /// Directory search results accumulated per QueryID. One DirFindQuery answer
    /// arrives as several UDP reply packets (~30 rows each); the search command
    /// polls this until a page is complete, then takes the whole batch at once.
    pub dir_searches: HashMap<String, DirSearch>,
    /// Highest agent-parcel SequenceID seen this region. The sim numbers its
    /// own parcel pushes; an out-of-order one is stale and must not repaint
    /// the Land tab / music stream with old data.
    pub agent_parcel_seq: i64,
    /// Hash of the last `parcel` payload we emitted, so duplicate replies
    /// (request races, resends) don't re-blink the UI.
    pub last_parcel_hash: u64,
    /// Authoritative snapshot of the current parcel, refreshed by every gated
    /// parcel emit. Money-moving commands (buy, buy pass) read price and area
    /// from HERE, never from the frontend - a stale or tampered UI must not be
    /// able to buy the wrong parcel or at the wrong price.
    pub parcel_snapshot: Option<ParcelSnapshot>,
    /// Access/ban list entries accumulated across ParcelAccessListReply
    /// packets, keyed by (local_id, list flags).
    pub access_lists: HashMap<(i64, u32), Vec<Value>>,
    /// An in-flight covenant download over the estate transfer channel:
    /// (transfer id, packets by sequence number).
    pub covenant_xfer: Option<(String, BTreeMap<i64, Vec<u8>>)>,
}

/// Extract the plain text out of a Linden notecard container ("Linden text
/// version N { ... Text length NNN\n<text>}"). Anything that doesn't look
/// like a notecard comes back as-is - old covenants can be bare text.
pub(crate) fn notecard_text(raw: &[u8]) -> String {
    let looks_notecard = raw.starts_with(b"Linden text version");
    if looks_notecard {
        if let Some(idx) = raw.windows(12).position(|w| w == b"Text length ") {
            let after = &raw[idx + 12..];
            if let Some(nl) = after.iter().position(|&b| b == b'\n') {
                let n: usize = String::from_utf8_lossy(&after[..nl]).trim().parse().unwrap_or(0);
                let body = &after[nl + 1..];
                let take = n.min(body.len());
                return String::from_utf8_lossy(&body[..take]).to_string();
            }
        }
    }
    String::from_utf8_lossy(raw).trim_end_matches('\0').to_string()
}

/// What the money paths need to know about the parcel under our feet.
#[derive(Debug, Clone, PartialEq)]
pub struct ParcelSnapshot {
    pub local_id: i64,
    pub region_id: String,
    pub sale_price: i64,
    pub area: i64,
    pub auth_buyer_id: String,
    pub for_sale: bool,
    pub group_id: String,
    pub is_group_owned: bool,
    pub owner_id: String,
    pub pass_price: i64,
    pub pass_hours: f64,
    pub sell_passes: bool,
}

/// Gate a decoded parcel against staleness before it may repaint the UI.
/// `seq` is the reply's SequenceID (>= 0 are sim-initiated agent-parcel pushes,
/// negatives answer our own requests); `aabb` is the parcel's bounding box.
/// Returns false when the parcel must be dropped.
fn parcel_fresh(state: &mut SessionState, seq: i64, aabb: Option<([f64; 3], [f64; 3])>) -> bool {
    // Sim pushes carry an increasing sequence; anything older than what we
    // already applied is a late duplicate.
    if seq > 0 {
        if seq <= state.agent_parcel_seq {
            crate::dlog!("parcel: dropped out-of-order push (seq {seq} <= {})", state.agent_parcel_seq);
            return false;
        }
        state.agent_parcel_seq = seq;
        return true;
    }
    // A reply to one of our own requests: it describes the parcel at wherever
    // we asked, which may no longer be where we stand (the login placeholder
    // race). If we know our position and the parcel's box, require a match.
    if let (Some(pos), Some((min, max))) = (state.last_pos, aabb) {
        let unset = min == [0.0; 3] && max == [0.0; 3];
        const PAD: f64 = 16.0; // absorbs movement between request and reply
        if !unset
            && (pos[0] < min[0] - PAD || pos[0] > max[0] + PAD
                || pos[1] < min[1] - PAD || pos[1] > max[1] + PAD)
        {
            crate::dlog!(
                "parcel: dropped stale reply (we stand at {:.0},{:.0}, parcel spans {:.0},{:.0}-{:.0},{:.0})",
                pos[0], pos[1], min[0], min[1], max[0], max[1]
            );
            return false;
        }
    }
    true
}

/// Emit a `parcel` payload unless it's byte-identical to the last one - the
/// request races used to repaint the Land tab with the same data several
/// times in a row, which read as "blinking". Every accepted parcel also
/// refreshes the engine's authoritative snapshot for the money commands.
fn emit_parcel_deduped(state: &mut SessionState, payload: Value) -> Option<Action> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let g = |k: &str| payload.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let gi = |k: &str| payload.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    const PF_FOR_SALE: u32 = 1 << 2;
    let flags = payload.get("parcelFlags").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    state.parcel_snapshot = Some(ParcelSnapshot {
        local_id: gi("localId"),
        region_id: g("regionId"),
        sale_price: gi("salePrice"),
        area: gi("area"),
        auth_buyer_id: g("authBuyerId"),
        for_sale: flags & PF_FOR_SALE != 0,
        group_id: g("groupId"),
        is_group_owned: payload.get("isGroupOwned").and_then(|v| v.as_bool()).unwrap_or(false),
        owner_id: g("ownerId"),
        pass_price: gi("passPrice"),
        pass_hours: payload.get("passHours").and_then(|v| v.as_f64()).unwrap_or(0.0),
        sell_passes: flags & pflag::PASS_LIST != 0,
    });
    let mut h = DefaultHasher::new();
    payload.to_string().hash(&mut h);
    let hash = h.finish();
    if hash == state.last_parcel_hash {
        crate::dlog!("parcel: identical payload suppressed");
        return None;
    }
    state.last_parcel_hash = hash;
    Some(Action::emit("parcel", payload))
}

/// One in-flight directory search: every reply packet appends its rows here.
#[derive(Debug, Default, Clone)]
pub struct DirSearch {
    pub rows: Vec<Value>,
    /// Status bits from the reply's StatusData block (banned word, none found...).
    pub status: u64,
    /// When the last packet for this query arrived (state.now_ms), for idle detection.
    pub last_ms: u64,
}

/// A confused or hostile sim must not grow the search accumulator without bound.
const MAX_DIR_ROWS: usize = 1000;

/// Append one reply packet's rows into the per-query accumulator.
fn dir_accumulate(state: &mut SessionState, decoded: &Value, rows: Vec<Value>) -> String {
    let query_id = inst_str(block0(decoded, "QueryData").unwrap_or(&Value::Null), "QueryID");
    let status = block_instances(decoded, "StatusData")
        .first()
        .and_then(|s| s.get("Status"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let now = state.now_ms;
    // Drop stale finished searches so abandoned queries can't pile up.
    state.dir_searches.retain(|_, s| now.saturating_sub(s.last_ms) < 30_000);
    let entry = state.dir_searches.entry(query_id.clone()).or_default();
    let room = MAX_DIR_ROWS.saturating_sub(entry.rows.len());
    entry.rows.extend(rows.into_iter().take(room));
    entry.status |= status;
    entry.last_ms = now;
    query_id
}

/// A file the sim is sending us a packet at a time.
#[derive(Debug, Clone, Default)]
pub struct XferIn {
    pub data: Vec<u8>,
    /// The packet number we expect next; the sim numbers them from zero.
    pub next: u32,
    /// What to do with the bytes once they're all here.
    pub kind: String,
}

/// The mute list is a few hundred lines at most. A cap keeps a confused or hostile sim
/// from feeding us a file until we run out of memory.
const MAX_XFER_BYTES: usize = 1 << 20;

/// Mute-entry types. Only agents belong in a "blocked people" list.
const MUTE_TYPE_BY_NAME: i64 = 0;
const MUTE_TYPE_AGENT: i64 = 1;

/// AgentUpdate has to carry it or the sim quietly lands us.
pub const AGENT_CONTROL_FLY: u64 = 0x1 << 13;

/// "The transient animation you started on me has finished." The sim starts
/// landing/standup clips and then waits for the owning viewer to say so; this
/// bit on an AgentUpdate is that reply.
pub const AGENT_CONTROL_FINISH_ANIM: u64 = 0x1 << 15;

/// The built-in default standing animation.
pub const ANIM_AGENT_STAND: &str = "2408fe9e-df1d-1d7d-f4ff-1384fa7b350f";

/// Sim-driven transient locomotion clips: after starting one of these on our
/// avatar the sim waits for a FINISH_ANIM before moving on to stand.
const TRANSIENT_ANIMS: &[&str] = &[
    "7a17b059-12b2-41b1-570a-186368b6aa6f", // land
    "f4f00d6e-b9fe-9292-f4cb-0ae06ea58d57", // soft (medium) land
    "7a4e87fe-de39-6fcb-6223-024b00893244", // prejump
    "3da1d753-028a-5446-24f3-9c9b856d9422", // standup
    "666307d9-a860-572d-6fd4-c3ab8865c094", // falldown
];

/// Build an AgentAnimation request starting or stopping one animation.
pub fn build_agent_animation(agent: &str, sess: &str, anim_id: &str, start: bool) -> Value {
    json!({
        "AgentData": [{ "AgentID": agent, "SessionID": sess }],
        "AnimationList": [{ "AnimID": anim_id, "StartAnim": start }],
        "PhysicalAvatarEventList": [],
    })
}

/// How much of the region around us we ask the sim to describe, in metres.
pub const INTEREST_FAR: f64 = 128.0;

/// Where to look from when we don't know yet: the middle of the region.
const REGION_CENTRE: [f64; 3] = [128.0, 128.0, 25.0];

/// Build an AgentUpdate body for the position we're standing at.
pub fn build_agent_update(agent: &str, sess: &str, pos: [f64; 3], flags: u64) -> Value {
    json!({
        "AgentData": [{
            "AgentID": agent, "SessionID": sess,
            // Identity orientation: we have no body to aim and the sim doesn't mind.
            "BodyRotation": [0.0, 0.0, 0.0, 1.0],
            "HeadRotation": [0.0, 0.0, 0.0, 1.0],
            "State": 0,
            "CameraCenter": [pos[0], pos[1], pos[2]],
            "CameraAtAxis": [1.0, 0.0, 0.0],
            "CameraLeftAxis": [0.0, 1.0, 0.0],
            "CameraUpAxis": [0.0, 0.0, 1.0],
            "Far": INTEREST_FAR,
            "ControlFlags": flags,
            "Flags": 0,
        }],
    })
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
    pub(crate) fn cached_name(&self, id: &str) -> Option<&str> {
        self.names.get(id).map(|s| s.as_str())
    }

    pub(crate) fn knows_name(&self, id: &str) -> bool {
        self.cached_name(id).is_some_and(|n| !n.trim().is_empty())
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

/// Friendly wording for the named sit-refusal alerts the sim can send
/// (notification ids, also seen with a legacy "NOTIFY: " prefix).
fn sit_failure_text(alert_id: &str) -> Option<&'static str> {
    Some(match alert_id {
        "CantSitNoRoom" => "No room to sit there - try another spot.",
        "CantSitNoSuitableSurface" => "There is no suitable surface to sit on - try another spot.",
        "SitFailCantMove" => "You cannot sit because you cannot move right now.",
        "SitFailNotAllowedOnLand" => "You cannot sit there: you are not allowed on that land.",
        "SitFailNotSameRegion" => "That seat is in a different region - move closer first.",
        _ => return None,
    })
}

/// Join a legacy "First Last" name; a "Resident" last name collapses to just the first.
fn resident_name(first: &str, last: &str) -> String {
    let first = first.trim();
    let last = last.trim();
    if last.is_empty() || last.eq_ignore_ascii_case("Resident") {
        first.to_string()
    } else {
        format!("{first} {last}")
    }
}

fn as_i64(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
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
        Some(Value::Array(a)) if a.len() == 4 => {
            let mut s = String::with_capacity(15);
            for (i, n) in a.iter().enumerate() {
                if i > 0 {
                    s.push('.');
                }
                let _ = write!(s, "{}", n.as_u64().unwrap_or(0));
            }
            s
        }
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

/// Grid coordinates from a template-decoded U64 RegionHandle (a decimal
/// string): high 32 bits = global X meters, low 32 = global Y, /256 = grid.
/// Zero on either axis means a malformed handle - no real region sits at
/// grid 0, and 0 is this codebase's "not yet known" sentinel.
fn wire_region_grid(handle: &str) -> Option<(i64, i64)> {
    let h: u64 = handle.trim().parse().ok()?;
    let (gx, gy) = (((h >> 32) / 256) as i64, ((h & 0xFFFF_FFFF) / 256) as i64);
    if gx == 0 || gy == 0 {
        return None;
    }
    Some((gx, gy))
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
/// teleport there without redoing the math in JS.
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
    pub const FOR_SALE: u32 = 1 << 2;
    pub const TERRAFORM: u32 = 1 << 4;
    pub const DAMAGE: u32 = 1 << 5;
    pub const CREATE_OBJECTS: u32 = 1 << 6;
    pub const ACCESS_GROUP: u32 = 1 << 8;
    pub const ACCESS_LIST: u32 = 1 << 9;
    pub const BAN_LIST: u32 = 1 << 10;
    pub const PASS_LIST: u32 = 1 << 11;
    pub const SHOW_DIR: u32 = 1 << 12;
    pub const ALLOW_DEED_TO_GROUP: u32 = 1 << 13;
    pub const SOUND_LOCAL: u32 = 1 << 15;
    pub const SELL_PARCEL_OBJECTS: u32 = 1 << 16;
    /// "Moderate Content" on the Options tab - the parcel's listing rating.
    pub const MATURE_PUBLISH: u32 = 1 << 18;
    pub const RESTRICT_PUSH: u32 = 1 << 21;
    pub const DENY_ANONYMOUS: u32 = 1 << 22;
    pub const GROUP_SCRIPTS: u32 = 1 << 25;
    pub const CREATE_GROUP_OBJ: u32 = 1 << 26;
    pub const ALL_OBJECT_ENTRY: u32 = 1 << 27;
    pub const GROUP_OBJECT_ENTRY: u32 = 1 << 28;
    pub const VOICE: u32 = 1 << 29;
    /// Voice runs on the estate-wide channel rather than this parcel's own.
    pub const USE_ESTATE_VOICE_CHAN: u32 = 1 << 30;
    pub const DENY_AGEUNVERIFIED: u32 = 1 << 31;
}

fn set_flag(flags: u32, bit: u32, on: bool) -> u32 {
    if on { flags | bit } else { flags & !bit }
}

/// Every ParcelData field the sim is known to send, from the message template
/// plus the three the LLSD form adds (SeeAVs / GroupAVSounds / AnyAVSounds).
///
/// This exists as an early warning. The capability save replaces a parcel
/// wholesale, so a setting Linden Lab adds after this build ships is one this
/// build cannot echo back - and every capability save would quietly reset it.
/// Seeing an unknown name here is the signal to add support before that
/// matters.
const KNOWN_PARCEL_DATA_KEYS: &[&str] = &[
    "RequestResult", "SequenceID", "SnapSelection", "SelfCount", "OtherCount",
    "PublicCount", "LocalID", "OwnerID", "IsGroupOwned", "AuctionID", "ClaimDate",
    "ClaimPrice", "RentPrice", "AABBMin", "AABBMax", "Bitmap", "Area", "Status",
    "SimWideMaxPrims", "SimWideTotalPrims", "MaxPrims", "TotalPrims", "OwnerPrims",
    "GroupPrims", "OtherPrims", "SelectedPrims", "ParcelPrimBonus", "OtherCleanTime",
    "ParcelFlags", "SalePrice", "Name", "Desc", "MusicURL", "MediaURL", "MediaID",
    "MediaAutoScale", "GroupID", "PassPrice", "PassHours", "Category", "AuthBuyerID",
    "SnapshotID", "UserLocation", "UserLookAt", "LandingType", "RegionPushOverride",
    "RegionDenyAnonymous", "RegionDenyIdentified", "RegionDenyTransacted",
    "SeeAVs", "GroupAVSounds", "AnyAVSounds",
];

/// Log any ParcelData field this build does not know, once each per run.
fn note_unknown_parcel_fields(pd: &Value) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let Some(map) = pd.as_object() else { return };
    let seen = SEEN.get_or_init(|| Mutex::new(HashSet::new()));
    let mut guard = match seen.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    for key in map.keys() {
        if KNOWN_PARCEL_DATA_KEYS.contains(&key.as_str()) {
            continue;
        }
        if guard.insert(key.clone()) {
            crate::dlog!(
                "ParcelProperties: unknown ParcelData field '{}' - this build cannot \
                 round-trip it, so a capability save would reset it",
                key
            );
        }
    }
}

/// A parcel BOOL that older sims leave out entirely. Absent means "allowed" -
/// the legacy default for the avatar visibility/sound trio when a sim
/// doesn't send all three.
fn parcel_bool_or_allowed(v: Option<&Value>) -> bool {
    match v {
        Some(x) => truthy(Some(x)),
        None => true,
    }
}

fn merge_group_data(state: &mut SessionState, incoming: Vec<Value>) -> Vec<Value> {
    for g in incoming {
        let id = g.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if is_zero_uuid(&id) {
            continue;
        }
        let key = id.to_lowercase();
        let powers = g
            .get("powers")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        state.group_powers.insert(key.clone(), powers);
        state.groups.insert(key.clone());
        state.group_data.insert(key, g);
    }
    group_list(state)
}

/// The name of a group we belong to, if we know it.
fn group_name_of(state: &SessionState, group_id: &str) -> String {
    if is_zero_uuid(group_id) {
        return String::new();
    }
    state
        .group_data
        .get(&group_id.to_lowercase())
        .and_then(|g| g.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Our membership as the UI wants it: every group we know of, sorted by name.
fn group_list(state: &SessionState) -> Vec<Value> {
    let mut out: Vec<Value> = state.group_data.values().cloned().collect();
    out.sort_by_key(|g| {
        g.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase()
    });
    out
}

/// Forget a group we've left or been ejected from, and hand back what's left.
/// Because membership accumulates (see merge_group_data), this is the only thing
/// that removes a group - without it a group you left would linger until relog.
fn drop_group(state: &mut SessionState, group_id: &str) -> Vec<Value> {
    let key = group_id.to_lowercase();
    state.group_data.remove(&key);
    state.group_powers.remove(&key);
    state.groups.remove(&key);
    group_list(state)
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
    if let Some(v) = b("voiceUseEstate") { f = set_flag(f, pflag::USE_ESTATE_VOICE_CHAN, v); }
    if let Some(v) = b("maturePublish") { f = set_flag(f, pflag::MATURE_PUBLISH, v); }
    if let Some(v) = b("showInSearch") { f = set_flag(f, pflag::SHOW_DIR, v); }
    if let Some(v) = b("pushRestricted") { f = set_flag(f, pflag::RESTRICT_PUSH, v); }
    if let Some(v) = b("sellPasses") { f = set_flag(f, pflag::PASS_LIST, v); }
    if let Some(v) = b("allowTerraform") { f = set_flag(f, pflag::TERRAFORM, v); }
    if let Some(v) = b("allowObjectEntryAll") { f = set_flag(f, pflag::ALL_OBJECT_ENTRY, v); }
    if let Some(v) = b("allowObjectEntryGroup") { f = set_flag(f, pflag::GROUP_OBJECT_ENTRY, v); }
    if let Some(v) = b("allowDeedToGroup") { f = set_flag(f, pflag::ALLOW_DEED_TO_GROUP, v); }
    if let Some(v) = b("denyAnonymous") { f = set_flag(f, pflag::DENY_ANONYMOUS, v); }
    if let Some(v) = b("denyAgeUnverified") { f = set_flag(f, pflag::DENY_AGEUNVERIFIED, v); }
    if let Some(v) = b("useAccessGroup") { f = set_flag(f, pflag::ACCESS_GROUP, v); }
    if let Some(v) = b("useAccessList") { f = set_flag(f, pflag::ACCESS_LIST, v); }
    // The ban list is forced active on every Access-tab save, so a save that
    // carries access settings does the same here.
    if b("useAccessList").is_some() || b("useAccessGroup").is_some() {
        f = set_flag(f, pflag::BAN_LIST, true);
    }
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
    if !state.region_product.is_empty() {
        m.insert("productName".into(), json!(state.region_product));
    }
    if state.region_flags != 0 {
        const BLOCK_LAND_RESELL: u64 = 1 << 7;
        const ALLOW_PARCEL_CHANGES: u64 = 1 << 26;
        m.insert("blockLandResell".into(), json!(state.region_flags & BLOCK_LAND_RESELL != 0));
        m.insert("allowParcelChanges".into(), json!(state.region_flags & ALLOW_PARCEL_CHANGES != 0));
    }
    Value::Object(m)
}

/// The teleport destination's region name, when the teleport command recorded
/// one. The session's own region_name still names the ORIGIN region at
/// TeleportFinish time (the new handshake hasn't landed yet), so stamping it
/// on the arrival event mislabeled the destination on the map.
fn tp_target_region_name(state: &SessionState) -> Option<String> {
    state
        .tp_target
        .as_ref()
        .and_then(|t| t.get("regionName"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
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

/// A group notice's message is "Subject|Body" - split at the first pipe.
fn split_notice_text(text: &str) -> (String, String) {
    match text.split_once('|') {
        Some((subject, body)) => (subject.trim().to_string(), body.trim().to_string()),
        None => (String::new(), text.trim().to_string()),
    }
}

/// A group notice's binary bucket: `[has_attachment u8][asset_type u8]
/// [group_id 16 bytes][attachment name, NUL-terminated]`. Returns
/// (has_attachment, group_id, attachment_name); empty/short buckets mean
/// "no attachment, group unknown".
fn parse_group_notice_bucket(raw: &[u8]) -> (bool, String, String) {
    if raw.len() < 18 {
        return (false, String::new(), String::new());
    }
    let has_attachment = raw[0] != 0;
    let mut gid = [0u8; 16];
    gid.copy_from_slice(&raw[2..18]);
    let group_id = crate::bridge::objects::id_string(&gid);
    let name_bytes = &raw[18..];
    let end = name_bytes.iter().position(|&b| b == 0).unwrap_or(name_bytes.len());
    let item = String::from_utf8_lossy(&name_bytes[..end]).trim().to_string();
    (has_attachment, group_id, item)
}

/// The item name of an inventory-offer IM. Object offers arrive as
/// "'Item name'  ( http://slurl.com/... )" - one line, location in parens -
/// while resident offers are just the item name (sometimes with a trailing
/// SLURL line). Both reduce to the bare name.
fn offer_item_name(text: &str) -> String {
    let t = text.trim();
    let t = t.find("( http").or_else(|| t.find("(http")).map_or(t, |i| &t[..i]);
    let t = t.find("\nhttp").map_or(t, |i| &t[..i]);
    t.trim().trim_matches('\'').trim().to_string()
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

/// Raw bytes of a Variable field (no NUL trimming - some buckets are binary).
fn inst_bytes(inst: &Value, name: &str) -> Vec<u8> {
    inst.get(name)
        .and_then(|v| v.as_str())
        .and_then(|s| B64.decode(s).ok())
        .unwrap_or_default()
}

fn inst_i64(inst: &Value, name: &str) -> i64 {
    as_i64(inst.get(name))
}

/// Ask the sim for the block list. A zero CRC means "I have nothing cached, send it".
pub(crate) fn mute_list_request(state: &SessionState) -> Action {
    Action::send(
        "MuteListRequest",
        json!({
            "AgentData": [{ "AgentID": state.agent_id, "SessionID": state.session_uuid }],
            "MuteData": [{ "MuteCRC": 0 }],
        }),
        true,
    )
}

fn confirm_xfer(id: u64, packet: u32) -> Action {
    Action::send(
        "ConfirmXferPacket",
        json!({ "XferID": [{ "ID": id.to_string(), "Packet": packet }] }),
        false,
    )
}

/// Parse the sim's mute-list file.
pub(crate) fn parse_mute_list(text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Some((kind, id, name, flags)) = parse_mute_line(line) else { continue };
        if kind != MUTE_TYPE_AGENT && kind != MUTE_TYPE_BY_NAME {
            continue; // objects and groups aren't people
        }
        if is_zero_uuid(id) || id.len() < 36 {
            continue; // a by-name entry has no profile to open
        }
        out.push(json!({ "id": id, "name": name, "type": kind, "flags": flags }));
    }
    out
}

/// One mute-list line: type, then id, then the name up to a '|', then the flags.
fn parse_mute_line(line: &str) -> Option<(i64, &str, &str, i64)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let (kind, rest) = line.split_once(char::is_whitespace)?;
    let kind: i64 = kind.trim().parse().ok()?;
    let rest = rest.trim_start();
    let (id, rest) = match rest.split_once(char::is_whitespace) {
        Some(p) => p,
        None => (rest, ""),
    };
    let (name, flags) = match rest.split_once('|') {
        Some((n, f)) => (n.trim(), f.trim().parse::<i64>().unwrap_or(0)),
        None => (rest.trim(), 0),
    };
    Some((kind, id, name, flags))
}

/// Flag bit meaning "this entry does NOT mute text" (flags are exemptions).
const MUTE_FLAG_TEXT_EXEMPT: u32 = 1;

/// Canonical key into the block-list filter map.
pub(crate) fn mute_key(id: &str) -> String {
    id.trim().to_ascii_lowercase()
}

/// Every usable entry in the mute-list file, whatever its type - the map the
/// inbound filters check. Objects and groups blocked from a full viewer must
/// keep silencing chat and prompts here even though only people are listed.
pub(crate) fn parse_mute_filters(text: &str) -> HashMap<String, u32> {
    text.lines()
        .filter_map(parse_mute_line)
        .filter(|(_, id, _, _)| !is_zero_uuid(id) && id.len() >= 36)
        .map(|(_, id, _, flags)| (mute_key(id), flags as u32))
        .collect()
}

impl SessionState {
    fn mute_flags(&self, id: &str) -> Option<u32> {
        if id.is_empty() || self.muted.is_empty() {
            return None;
        }
        // Wire-decoded ids are already canonical; normalize only on a miss.
        self.muted.get(id).or_else(|| self.muted.get(&mute_key(id))).copied()
    }

    /// Whether an id has any block-list entry at all - what the reference
    /// viewer's flag-less checks (script dialogs and prompts) ask.
    pub fn is_muted(&self, id: &str) -> bool {
        self.mute_flags(id).is_some()
    }

    /// Whether an id's TEXT is blocked - chat, IMs, offers, invites. An entry
    /// can exempt text (say, a voice-only mute made in a full viewer).
    pub fn is_muted_text(&self, id: &str) -> bool {
        self.mute_flags(id).is_some_and(|flags| flags & MUTE_FLAG_TEXT_EXEMPT == 0)
    }

    /// Record a block (full, flags 0) or unblock the moment its write is sent.
    pub fn set_block_state(&mut self, id: &str, blocked: bool) {
        let key = mute_key(id);
        if blocked {
            self.muted.insert(key.clone(), 0);
            self.mute_overrides.insert(key, Some(0));
        } else {
            self.muted.remove(&key);
            self.mute_overrides.insert(key, None);
        }
    }

    /// Lay this session's own blocks/unblocks back over a freshly fetched list.
    fn apply_mute_overrides(&mut self) {
        for (key, flags) in &self.mute_overrides {
            match flags {
                Some(f) => {
                    self.muted.insert(key.clone(), *f);
                }
                None => {
                    self.muted.remove(key);
                }
            }
        }
    }
}

/// You cannot arrive somewhere still sitting on the thing you left behind.
fn stand_up_on_arrival(state: &mut SessionState) -> Vec<Action> {
    if !state.sitting {
        return Vec::new();
    }
    state.sitting = false;
    state.sit_object.clear();
    vec![Action::emit(
        "sit-state",
        crate::bridge::events::payload(crate::bridge::events::SitState {
            sitting: false,
            object_id: String::new(),
            error: None,
        }),
    )]
}

/// Fold our own avatar's ObjectUpdate into the session: where we are, and whether we're
/// sitting on something.
fn track_self(state: &mut SessionState, inst: &Value) -> Vec<Action> {
    let mut actions = Vec::new();
    let parent_id = inst_i64(inst, "ParentID") as u32;
    let blob = B64.decode(inst_str(inst, "ObjectData")).unwrap_or_default();
    let local = crate::bridge::objects::position_from_object_data(&blob);

    if let Some(local) = local {
        let region_pos = if parent_id == 0 {
            Some(local)
        } else {
            state
                .objects
                .sit_anchor_pos(parent_id)
                .map(|seat| [seat[0] + local[0], seat[1] + local[1], seat[2] + local[2]])
        };
        if let Some(p) = region_pos {
            let moved = state
                .last_pos
                .map(|old| {
                    (old[0] - p[0] as f64).abs() > 0.5
                        || (old[1] - p[1] as f64).abs() > 0.5
                        || (old[2] - p[2] as f64).abs() > 0.5
                })
                .unwrap_or(true);
            state.last_pos = Some([p[0] as f64, p[1] as f64, p[2] as f64]);
            if moved {
                actions.push(Action::emit(
                    "position",
                    json!({
                        "position": { "x": p[0], "y": p[1], "z": p[2] },
                        "region": region_obj(state),
                        "source": "object-update",
                    }),
                ));
            }
        }
    }

    let sitting = parent_id != 0;
    if sitting != state.sitting {
        state.sitting = sitting;
        if !sitting {
            state.sit_object.clear();
        }
        actions.push(Action::emit(
            "sit-state",
            crate::bridge::events::payload(crate::bridge::events::SitState {
                sitting,
                object_id: state.sit_object.clone(),
                error: None,
            }),
        ));
    }
    actions
}

/// Push a position event when the avatar row moves (full or terse update).
fn sync_self_from_avatar_row(state: &mut SessionState) -> Vec<Action> {
    let Some(p) = state.objects.agent_region_pos(&state.agent_id) else {
        return Vec::new();
    };
    let new_pos = [p[0] as f64, p[1] as f64, p[2] as f64];
    let moved = state.last_pos.map_or(true, |old| {
        (old[0] - new_pos[0]).abs() > 0.25
            || (old[1] - new_pos[1]).abs() > 0.25
            || (old[2] - new_pos[2]).abs() > 0.25
    });
    state.last_pos = Some(new_pos);
    if !moved {
        return Vec::new();
    }
    vec![Action::emit(
        "position",
        json!({
            "position": { "x": p[0], "y": p[1], "z": p[2] },
            "region": region_obj(state),
            "source": "object-update",
        }),
    )]
}

/// An object's CreationDate as seconds since the epoch, or 0 if the sim didn't say.
fn creation_seconds(inst: &Value) -> i64 {
    let raw = inst.get("CreationDate");
    let micros = raw
        .and_then(|v| v.as_str())
        .and_then(|s| s.trim().parse::<i64>().ok())
        .or_else(|| raw.and_then(|v| v.as_i64()))
        .unwrap_or(0);
    if micros <= 0 { 0 } else { micros / 1_000_000 }
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
            // The block list: the sim keeps relaying chat from blocked residents
            // (and their objects), so dropping it is the viewer's job.
            if !is_self
                && (source == "agent" && state.is_muted_text(&source_id)
                    || source == "object"
                        && (state.is_muted_text(&source_id) || state.is_muted_text(&owner_id)))
            {
                return actions;
            }
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

        // The block list. The sim doesn't send it inline - it writes a file and tells us
        // the name, and we fetch it over the Xfer protocol
        "MuteListUpdate" => {
            let filename = field_text(decoded, "MuteData", "Filename").unwrap_or_default();
            let filename = filename.trim().to_string();
            if filename.is_empty() || state.agent_id.is_empty() {
                return actions;
            }
            state.xfer_seq = state.xfer_seq.wrapping_add(1);
            let id = (state.now_ms << 20) | (state.xfer_seq as u64 & 0xF_FFFF);
            state.xfers.insert(id, XferIn { kind: "mute-list".into(), ..Default::default() });
            crate::dlog!("mute list: fetching {filename} as xfer {id}");
            actions.push(Action::send(
                "RequestXfer",
                json!({ "XferID": [{
                    "ID": id.to_string(),
                    "Filename": B64.encode(format!("{filename}\0").as_bytes()),
                    // LL_PATH_CACHE. The sim's xfer manager only serves path 0 (none)
                    // or 4 (cache) and silently drops anything else, mute list included.
                    "FilePath": 4,
                    "DeleteOnCompletion": true,
                    "UseBigPackets": false,
                    "VFileID": "00000000-0000-0000-0000-000000000000",
                    "VFileType": -1,
                }] }),
                true,
            ));
        }

        // "Use your cached copy" - which we haven't got, having no disk cache. Ask once
        // more with a zero CRC, which is what makes the sim send the file itself.
        "UseCachedMuteList" => {
            if !state.mute_asked && !state.agent_id.is_empty() {
                state.mute_asked = true;
                actions.push(mute_list_request(state));
            }
        }

        // One packet of a file we asked for.
        "SendXferPacket" => {
            let x = block0(decoded, "XferID").cloned().unwrap_or(Value::Null);
            let id: u64 = inst_str(&x, "ID").parse().unwrap_or(0);
            let packet = inst_i64(&x, "Packet") as u32;
            let is_last = packet & 0x8000_0000 != 0;
            let seq = packet & 0x7FFF_FFFF;
            // Raw bytes, not text: a file arrives a chunk at a time and the usual text
            // helper would trim a trailing NUL out of the middle of it.
            let data = field(decoded, "DataPacket", "Data")
                .and_then(|v| v.as_str())
                .and_then(|s| B64.decode(s).ok())
                .unwrap_or_default();

            let done = match state.xfers.get_mut(&id) {
                None => {
                    // Not ours, or already finished. Still acknowledge it, or the sim
                    // keeps resending.
                    actions.push(confirm_xfer(id, seq));
                    return actions;
                }
                Some(x) => {
                    if seq == x.next {
                        // First packet: total size prefix (4 bytes, big-endian), then payload.
                        let payload = if seq == 0 && data.len() >= 4 { &data[4..] } else { &data[..] };
                        if x.data.len() + payload.len() <= MAX_XFER_BYTES {
                            x.data.extend_from_slice(payload);
                        }
                        x.next += 1;
                    }
                    // A repeat of the packet before is a resend crossing our ack; confirm
                    // it again and otherwise ignore it.
                    is_last
                }
            };
            actions.push(confirm_xfer(id, seq));
            if done {
                if let Some(x) = state.xfers.remove(&id) {
                    if x.kind == "mute-list" {
                        let text = String::from_utf8_lossy(&x.data).to_string();
                        let people = parse_mute_list(&text);
                        state.muted = parse_mute_filters(&text);
                        state.apply_mute_overrides();
                        crate::dlog!("mute list: {} blocked person/people", people.len());
                        let ids: Vec<String> = people
                            .iter()
                            .filter_map(|p| p.get("id").and_then(|v| v.as_str()))
                            .filter(|id| !is_zero_uuid(id))
                            .map(|s| s.to_string())
                            .collect();
                        actions.push(Action::emit("mute-list", json!({ "people": people })));
                        if !ids.is_empty() {
                            actions.push(Action::ResolveNames(ids));
                        }
                    }
                }
            }
        }

        // Estate-channel transfer status (the covenant download). A negative
        // status means refused/unknown; surface it instead of hanging.
        "TransferInfo" => {
            let ti = block0(decoded, "TransferInfo").cloned().unwrap_or(Value::Null);
            let id = inst_str(&ti, "TransferID");
            let status = inst_i64(&ti, "Status");
            let ours = state.covenant_xfer.as_ref().is_some_and(|(t, _)| same_uuid(t, &id));
            if ours && status < 0 {
                state.covenant_xfer = None;
                actions.push(Action::emit(
                    "covenant-text",
                    json!({ "ok": false, "error": "The covenant could not be downloaded." }),
                ));
            }
        }

        // One packet of an estate-channel transfer (covenant text).
        "TransferPacket" => {
            let td = block0(decoded, "TransferData").cloned().unwrap_or(Value::Null);
            let id = inst_str(&td, "TransferID");
            let ours = state.covenant_xfer.as_ref().is_some_and(|(t, _)| same_uuid(t, &id));
            if !ours {
                return actions;
            }
            let packet = inst_i64(&td, "Packet");
            let status = inst_i64(&td, "Status");
            let data = td
                .get("Data")
                .and_then(|v| v.as_str())
                .and_then(|s| B64.decode(s).ok())
                .unwrap_or_default();
            const MAX_COVENANT_BYTES: usize = 1 << 20;
            if let Some((_, packets)) = state.covenant_xfer.as_mut() {
                let total: usize = packets.values().map(|d| d.len()).sum();
                if total + data.len() <= MAX_COVENANT_BYTES {
                    packets.insert(packet, data);
                }
            }
            // LLTS_DONE = 1 marks the final packet.
            if status == 1 {
                if let Some((_, packets)) = state.covenant_xfer.take() {
                    let mut raw = Vec::new();
                    for (_, chunk) in packets {
                        raw.extend_from_slice(&chunk);
                    }
                    actions.push(Action::emit(
                        "covenant-text",
                        json!({ "ok": true, "text": notecard_text(&raw) }),
                    ));
                }
            }
        }

        // The sim refused or dropped a transfer we asked for. Without this the
        // failure is invisible and a mute-list fetch just never finishes.
        "AbortXfer" => {
            let x = block0(decoded, "XferID").cloned().unwrap_or(Value::Null);
            let id: u64 = inst_str(&x, "ID").parse().unwrap_or(0);
            if let Some(x) = state.xfers.remove(&id) {
                crate::dlog!("xfer {id} ({}) aborted by sim, result {}", x.kind, inst_i64(block0(decoded, "XferID").unwrap_or(&Value::Null), "Result"));
                if x.kind == "mute-list" {
                    actions.push(Action::emit(
                        "mute-list",
                        json!({ "people": [], "error": "The region refused to send the block list." }),
                    ));
                }
            }
        }

        // A group's name, for a group we aren't in.
        "UUIDGroupNameReply" => {
            let mut groups = Vec::new();
            for inst in block_instances(decoded, "UUIDNameBlock") {
                let id = inst_str(inst, "ID");
                let name = inst_text(inst, "GroupName").trim().to_string();
                if !id.is_empty() && !is_zero_uuid(&id) && !name.is_empty() {
                    groups.push(json!({ "id": id, "name": name }));
                }
            }
            if !groups.is_empty() {
                actions.push(Action::emit("group-names", json!({ "groups": groups })));
            }
        }

        // A simulator alert, which we surface as a system chat line.
        // AgentAlertMessage carries the same AlertData.Message as AlertMessage
        // (agent-directed notices like "not allowed on this land").
        "AlertMessage" | "AgentAlertMessage" => {
            let raw = field_text(decoded, "AlertData", "Message").unwrap_or_default();
            let raw = raw.trim().to_string();
            // Modern sims name the notification in AlertInfo; older ones prefix
            // AlertData with "ALERT: "/"NOTIFY: ". Normalise both into an id.
            let info_id = block_instances(decoded, "AlertInfo")
                .first()
                .map(|i| inst_text(i, "Message"))
                .unwrap_or_default();
            let alert_id = if info_id.trim().is_empty() {
                raw.strip_prefix("ALERT: ")
                    .or_else(|| raw.strip_prefix("NOTIFY: "))
                    .unwrap_or("")
                    .trim()
                    .to_string()
            } else {
                info_id.trim().to_string()
            };
            // A region restart countdown. It deserves more than a chat line -
            // the UI raises a modal - so it gets its own event, with the chat
            // line kept as the record.
            if alert_id == "RegionRestartMinutes" || alert_id == "RegionRestartSeconds" {
                let extra = block_instances(decoded, "AlertInfo")
                    .first()
                    .map(|i| inst_text(i, "ExtraParams"))
                    .unwrap_or_default();
                let parsed = crate::codec::llsd::parse(&extra, "application/llsd+xml").unwrap_or(Value::Null);
                let n = as_i64(parsed.get(if alert_id == "RegionRestartMinutes" { "MINUTES" } else { "SECONDS" }));
                let seconds = if alert_id == "RegionRestartMinutes" { n * 60 } else { n };
                let region = parsed
                    .get("NAME")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&state.region_name)
                    .to_string();
                actions.push(Action::emit(
                    "region-restart",
                    json!({ "seconds": seconds, "regionName": region }),
                ));
                let when = if seconds >= 120 {
                    format!("{} minutes", seconds / 60)
                } else {
                    format!("{seconds} seconds")
                };
                actions.push(system_chat(&format!(
                    "The region '{region}' is about to restart (in roughly {when}). Teleport out or you will be logged off."
                )));
                return actions;
            }
            // A sit refusal while our request is in flight: stop pretending the
            // sit might still land, and tell the user why it didn't.
            let sit_reason = sit_failure_text(&alert_id);
            if state.sit_pending {
                if let Some(reason) = sit_reason {
                    state.sit_pending = false;
                    actions.push(Action::emit(
                        "sit-state",
                        json!({ "sitting": false, "objectId": "", "error": reason }),
                    ));
                }
            }
            // Prefer the friendly wording for ids we know; otherwise show the raw
            // text (when there is any - AlertInfo-only alerts used to vanish here).
            let text = match sit_reason {
                Some(t) => t.to_string(),
                None if !raw.is_empty() => raw,
                None => String::new(),
            };
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

        // Our own animation state, echoed back by the sim. When it starts a
        // transient locomotion clip (landing, standing up) it waits for the
        // owning viewer to report the clip finished; we have no renderer, so we
        // wait roughly a clip length and reply. See Action::FinishAnim.
        "AvatarAnimation" => {
            let sender = inst_str(block0(decoded, "Sender").unwrap_or(&Value::Null), "ID");
            if !same_uuid(&sender, &state.agent_id) {
                return actions;
            }
            let transient = block_instances(decoded, "AnimationList").iter().any(|a| {
                let id = inst_str(a, "AnimID").to_ascii_lowercase();
                TRANSIENT_ANIMS.contains(&id.as_str())
            });
            if transient {
                actions.push(Action::FinishAnim { delay_ms: 1000 });
            }
        }

        // Nearby-avatar positions for the radar, plus our own coarse position.
        "CoarseLocationUpdate" => {
            let locs = block_instances(decoded, "Location");
            let agents = block_instances(decoded, "AgentData");
            let you = as_i64(field(decoded, "Index", "You"));
            // Coarse Z is a byte * 4, capped at 1020. 0 and 255 mean unknown Z.
            let loc_pos = |i: usize| -> Option<(f64, f64, f64, bool)> {
                locs.get(i).map(|l| {
                    let rz = inst_i64(l, "Z");
                    let unknown_z = rz == 0 || rz == 255;
                    let z = rz as f64 * 4.0;
                    (
                        inst_i64(l, "X") as f64,
                        inst_i64(l, "Y") as f64,
                        z,
                        unknown_z,
                    )
                })
            };
            let self_pos = if you >= 0 {
                loc_pos(you as usize).and_then(|(x, y, z, unknown_z)| {
                    if unknown_z {
                        state.last_pos.map(|p| [x, y, p[2]])
                    } else {
                        Some([x, y, z])
                    }
                })
            } else {
                None
            };
            if let Some(sp) = self_pos {
                // Coarse self-positions are only a fallback
                let garbage = sp[0] == 0.0 && sp[1] == 0.0;
                let far = state
                    .last_pos
                    .is_some_and(|p| (p[0] - sp[0]).hypot(p[1] - sp[1]) > 100.0);
                // One far tick is radar noise. The SAME far spot on two ticks
                // running means last_pos is the stale side (e.g. poisoned by a
                // mis-framed update), and the radar is the only signal left
                // that can re-anchor a stationary avatar - take the repair.
                let confirmed_repair = far
                    && !garbage
                    && state
                        .coarse_repair
                        .is_some_and(|c| (c[0] - sp[0]).hypot(c[1] - sp[1]) < 8.0);
                state.coarse_repair = if far && !confirmed_repair && !garbage {
                    Some([sp[0], sp[1]])
                } else {
                    None
                };
                let wild_jump = far && !confirmed_repair;
                let moved = state
                    .last_pos
                    .map_or(true, |p| (p[0] - sp[0]).abs() > 0.25 || (p[1] - sp[1]).abs() > 0.25 || (p[2] - sp[2]).abs() > 0.25);
                if !garbage && !wild_jump && moved {
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
                let coarse_z = if unknown {
                    state
                        .last_pos
                        .map(|p| p[2] as f32)
                        .unwrap_or(25.0)
                } else {
                    z as f32
                };
                state
                    .objects
                    .note_coarse_agent(&id, [x as f32, y as f32, coarse_z]);
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
                    "region": state.region_name,
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
            let seq = inst_i64(&pd, "SequenceID");
            let aabb = Some((
                {
                    let (x, y, z) = vec3(pd.get("AABBMin"));
                    [x, y, z]
                },
                {
                    let (x, y, z) = vec3(pd.get("AABBMax"));
                    [x, y, z]
                },
            ));
            if !parcel_fresh(state, seq, aabb) {
                return actions;
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
            let (lx, ly, lz) = vec3(pd.get("UserLookAt"));
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
            // GP_LAND_CHANGE_IDENTITY is the group power that lets you edit a
            // parcel's identity/options in About Land.
            const GP_LAND_CHANGE_IDENTITY: u64 = 1 << 18;
            let can_edit = if owner_id.is_empty() || same_uuid(&owner_id, GOVERNOR_LINDEN) {
                false
            } else if is_group_owned {
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
            let payload = json!({
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
                    "allowObjectEntryAll": has(pflag::ALL_OBJECT_ENTRY),
                    "allowObjectEntryGroup": has(pflag::GROUP_OBJECT_ENTRY),
                    "allowDeedToGroup": has(pflag::ALLOW_DEED_TO_GROUP),
                    "denyAnonymous": has(pflag::DENY_ANONYMOUS),
                    "denyAgeUnverified": has(pflag::DENY_AGEUNVERIFIED),
                    "useAccessGroup": has(pflag::ACCESS_GROUP),
                    "useAccessList": has(pflag::ACCESS_LIST),
                    "forSale": has(pflag::FOR_SALE),
                    "sellWithObjects": has(pflag::SELL_PARCEL_OBJECTS),
                    "auctionId": inst_i64(&pd, "AuctionID"),
                    "status": inst_i64(&pd, "Status"),
                    "musicUrl": inst_text(&pd, "MusicURL"),
                    "mediaUrl": inst_text(&pd, "MediaURL"),
                    "mediaId": inst_str(&pd, "MediaID"),
                    "mediaAutoScale": inst_i64(&pd, "MediaAutoScale"),
                    "mediaType": field_text(decoded, "MediaData", "MediaType").unwrap_or_default(),
                    "mediaDesc": field_text(decoded, "MediaData", "MediaDesc").unwrap_or_default(),
                    // The rest of the Media 2.0 set, plus the avatar
                    // visibility/sound trio. None of these can be edited over
                    // UDP, but the capability save replaces the parcel
                    // wholesale, so they have to round-trip or they'd be lost.
                    "mediaWidth": as_i64(field(decoded, "MediaData", "MediaWidth")),
                    "mediaHeight": as_i64(field(decoded, "MediaData", "MediaHeight")),
                    "mediaLoop": as_i64(field(decoded, "MediaData", "MediaLoop")),
                    "mediaCurrentUrl": field_text(decoded, "MediaLinkSharing", "MediaCurrentURL").unwrap_or_default(),
                    "mediaAllowNavigate": truthy(field(decoded, "MediaLinkSharing", "MediaAllowNavigate")),
                    "mediaPreventCameraZoom": truthy(field(decoded, "MediaLinkSharing", "MediaPreventCameraZoom")),
                    "mediaUrlTimeout": as_f64(field(decoded, "MediaLinkSharing", "MediaURLTimeout")),
                    "seeAvs": parcel_bool_or_allowed(pd.get("SeeAVs")),
                    "anyAvSounds": parcel_bool_or_allowed(pd.get("AnyAVSounds")),
                    "groupAvSounds": parcel_bool_or_allowed(pd.get("GroupAVSounds")),
                    "obscureMoap": as_i64(field(decoded, "ParcelExtendedFlags", "Flags")) != 0,
                    "maturePublish": has(pflag::MATURE_PUBLISH),
                    "voiceUseEstate": has(pflag::USE_ESTATE_VOICE_CHAN),
                    // Only the capability save can write the avatar
                    // visibility/sound trio, so the UI greys them out where the
                    // region offers no capability rather than pretending.
                    "canEditCapFields": state.caps.contains_key("ParcelPropertiesUpdate"),
                    "salePrice": inst_i64(&pd, "SalePrice"),
                    "passPrice": inst_i64(&pd, "PassPrice"),
                    "passHours": as_f64(pd.get("PassHours")),
                    "category": inst_i64(&pd, "Category"),
                    "authBuyerId": inst_str(&pd, "AuthBuyerID"),
                    "snapshotId": snapshot,
                    "snapshotUrl": snapshot_url,
                    "landingPoint": { "x": ux.round(), "y": uy.round(), "z": uz.round() },
                    "landingHeading": landing_heading.round(),
                    // Exact vectors for the save round-trip; the rounded
                    // landingPoint/heading above are display-only. Rebuilding
                    // them from the rounded forms drifted the landing point by
                    // up to half a metre per save.
                    "userLocation": { "x": ux, "y": uy, "z": uz },
                    "userLookAt": { "x": lx, "y": ly, "z": lz },
                    "landingType": inst_i64(&pd, "LandingType"),
                    "claimDate": inst_i64(&pd, "ClaimDate"),
                    "otherCleanTime": inst_i64(&pd, "OtherCleanTime"),
                    // A LocalID is only unique per region; the save checks this
                    // so a pre-teleport baseline can't edit a same-id stranger.
                    "regionId": state.region_id,
                    "canEdit": can_edit,
                    "source": "udp",
                    "stub": false,
            });
            actions.extend(emit_parcel_deduped(state, payload));
        }

        // The estate covenant header. The covenant text itself is a notecard
        // asset; the IO layer fetches it through the asset cap when the id is
        // set (see caps::fetch_covenant_text).
        "EstateCovenantReply" => {
            let d = block0(decoded, "Data").cloned().unwrap_or(Value::Null);
            actions.push(Action::emit(
                "covenant",
                json!({
                    "covenantId": inst_str(&d, "CovenantID"),
                    "timestamp": inst_i64(&d, "CovenantTimestamp"),
                    "estateName": inst_text(&d, "EstateName"),
                    "estateOwnerId": inst_str(&d, "EstateOwnerID"),
                }),
            ));
            let owner = inst_str(&d, "EstateOwnerID");
            if !owner.is_empty() && !is_zero_uuid(&owner) {
                actions.push(Action::ResolveNames(vec![owner]));
            }
        }

        // One page of a parcel's access or ban list. Pages accumulate per
        // (parcel, list) until the UI asks for the collected set - large lists
        // span several packets with the same SequenceID.
        "ParcelAccessListReply" => {
            let d = block0(decoded, "Data").cloned().unwrap_or(Value::Null);
            let local_id = inst_i64(&d, "LocalID");
            let flags = inst_i64(&d, "Flags") as u32;
            let mut ids = Vec::new();
            let entries: Vec<Value> = block_instances(decoded, "List")
                .iter()
                .filter_map(|e| {
                    let id = inst_str(e, "ID");
                    if id.is_empty() || is_zero_uuid(&id) {
                        return None;
                    }
                    ids.push(id.clone());
                    Some(json!({ "id": id, "time": inst_i64(e, "Time") }))
                })
                .collect();
            let list = state.access_lists.entry((local_id, flags)).or_default();
            for e in entries {
                if !list.iter().any(|x| x.get("id") == e.get("id")) {
                    list.push(e);
                }
            }
            actions.push(Action::emit(
                "parcel-access",
                json!({ "localId": local_id, "flags": flags, "entries": state.access_lists[&(local_id, flags)].clone() }),
            ));
            if !ids.is_empty() {
                actions.push(Action::ResolveNames(ids));
            }
        }

        // Who owns how many prims on the parcel (the Objects tab's owner list).
        "ParcelObjectOwnersReply" => {
            let mut ids = Vec::new();
            let owners: Vec<Value> = block_instances(decoded, "Data")
                .iter()
                .filter_map(|o| {
                    let id = inst_str(o, "OwnerID");
                    if id.is_empty() || is_zero_uuid(&id) {
                        return None;
                    }
                    ids.push(id.clone());
                    Some(json!({
                        "id": id,
                        "isGroup": o.get("IsGroupOwned").and_then(|v| v.as_bool()).unwrap_or(false),
                        "count": inst_i64(o, "Count"),
                        "online": o.get("OnlineStatus").and_then(|v| v.as_bool()).unwrap_or(false),
                    }))
                })
                .collect();
            actions.push(Action::emit("parcel-object-owners", json!({ "owners": owners })));
            if !ids.is_empty() {
                actions.push(Action::ResolveNames(ids));
            }
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
            if state.is_muted(&object_id) || state.is_muted(&owner_id) {
                return actions;
            }
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
            if task_id.is_empty() || item_id.is_empty() || state.is_muted(&task_id) {
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
            if state.is_muted(&inst_str(&d, "ObjectID")) || state.is_muted(&owner_id) {
                return actions;
            }
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
            let success = g.get("Success").and_then(|v| v.as_bool()).unwrap_or(false);
            actions.push(Action::emit(
                "group-action",
                json!({
                    "groupId": inst_str(&g, "GroupID"),
                    "action": if name == "JoinGroupReply" { "join" } else { "leave" },
                    "success": success,
                }),
            ));
            if success && !state.agent_id.is_empty() {
                actions.push(Action::send(
                    "AgentDataUpdateRequest",
                    json!({
                        "AgentData": [{ "AgentID": state.agent_id, "SessionID": state.session_uuid }],
                    }),
                    true,
                ));
            }
        }

        // Our own group membership (this also arrives via HTTP trusted-message).
        "AgentGroupDataUpdate" => {
            let agent = inst_str(block0(decoded, "AgentData").unwrap_or(&Value::Null), "AgentID");
            if !agent.is_empty() && !same_uuid(&agent, &state.agent_id) {
                return actions; // this update isn't about us
            }
            let incoming: Vec<Value> = block_instances(decoded, "GroupData")
                .iter()
                .filter_map(|g| {
                    let id = inst_str(g, "GroupID");
                    if is_zero_uuid(&id) {
                        return None;
                    }
                    Some(json!({
                        "id": id, "name": inst_text(g, "GroupName"),
                        "insigniaId": inst_str(g, "GroupInsigniaID"),
                        "powers": inst_str(g, "GroupPowers"),
                        "acceptNotices": g.get("AcceptNotices").and_then(|v| v.as_bool()).unwrap_or(false),
                        "contribution": inst_i64(g, "Contribution"),
                    }))
                })
                .collect();
            let groups = merge_group_data(state, incoming);
            actions.push(Action::emit("group-membership", json!({ "groups": groups })));
        }

        // Nearby objects. Tracked from login onward rather than when the tab opens: the
        // sim describes a region's contents on arrival and never again, so a list built
        // on demand would find nothing. Listening costs the sim nothing - it sends these
        // whether we read them or not - and only one region's worth is ever held.
        "ObjectUpdateCompressed" => {
            for inst in block_instances(decoded, "ObjectData") {
                let blob = match B64.decode(inst_str(inst, "Data")) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                if let Some((mut row, has_parent)) = crate::bridge::objects::decode_compressed(&blob) {
                    // UpdateFlags rides on the message block, not inside the blob.
                    row.flags = inst_i64(inst, "UpdateFlags") as u32;
                    state.objects.upsert_compressed(row, has_parent);
                } else if !blob.is_empty() {
                    crate::dlog!(
                        "ObjectUpdateCompressed: decode failed ({} bytes)",
                        blob.len()
                    );
                }
            }
        }

        // The uncompressed form. Rarer than the compressed one, but a linkset's root
        // often arrives this way - and it's the only place our OWN avatar is described.
        "ObjectUpdate" => {
            for inst in block_instances(decoded, "ObjectData") {
                let pcode = inst_i64(inst, "PCode") as u8;
                let local_id = inst_i64(inst, "ID") as u32;
                let parent_id = inst_i64(inst, "ParentID") as u32;
                let flags = inst_i64(inst, "UpdateFlags") as u32;
                let click_action = inst_i64(inst, "ClickAction") as u8;
                let attachment_state = inst_i64(inst, "State") as u8;
                // Our own avatar first, before the prim filter throws it away.
                if !state.agent_id.is_empty() && same_uuid(&inst_str(inst, "FullID"), &state.agent_id) {
                    actions.extend(track_self(state, inst));
                    if let Some(pos) = crate::bridge::objects::position_from_object_data(
                        &B64.decode(inst_str(inst, "ObjectData")).unwrap_or_default(),
                    ) {
                        state.objects.upsert(crate::bridge::objects::ObjectRow {
                            local_id,
                            full_id: crate::bridge::objects::id_bytes(&inst_str(inst, "FullID")),
                            parent_id,
                            pcode: crate::bridge::objects::PCODE_AVATAR,
                            pos,
                            flags,
                            click_action,
                            attachment_state,
                            ..Default::default()
                        });
                    }
                    continue;
                }
                if pcode == crate::bridge::objects::PCODE_AVATAR {
                    let blob = B64.decode(inst_str(inst, "ObjectData")).unwrap_or_default();
                    if let Some(pos) = crate::bridge::objects::position_from_object_data(&blob) {
                        state.objects.upsert(crate::bridge::objects::ObjectRow {
                            local_id,
                            full_id: crate::bridge::objects::id_bytes(&inst_str(inst, "FullID")),
                            parent_id,
                            pcode,
                            pos,
                            flags,
                            click_action,
                            attachment_state,
                            ..Default::default()
                        });
                    }
                    continue;
                }
                if pcode != 9 {
                    continue; // 9 = primitive; avatars handled above
                }
                let blob = B64.decode(inst_str(inst, "ObjectData")).unwrap_or_default();
                if let Some(pos) = crate::bridge::objects::position_from_object_data(&blob) {
                    state.objects.upsert(crate::bridge::objects::ObjectRow {
                        local_id,
                        full_id: crate::bridge::objects::id_bytes(&inst_str(inst, "FullID")),
                        parent_id,
                        pcode,
                        pos,
                        flags,
                        click_action,
                        attachment_state,
                        ..Default::default()
                    });
                } else {
                    state.objects.merge_partial(
                        local_id,
                        parent_id,
                        flags,
                        click_action,
                        attachment_state,
                    );
                }
            }
        }

        // Movement-only updates for objects we already know about (no parenting changes).
        "ImprovedTerseObjectUpdate" => {
            for inst in block_instances(decoded, "ObjectData") {
                let blob = match B64.decode(inst_str(inst, "Data")) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                if let Some((local_id, pos)) = crate::bridge::objects::decode_terse_improved(&blob) {
                    state.objects.update_movement(local_id, pos);
                    // A terse position is parent-frame but carries no parenting,
                    // so for OUR OWN avatar it's only trustworthy as a region
                    // position while we're verifiably standing. Across a sit
                    // boundary the row's parent can lag the sim by a packet,
                    // and a seat offset like (0,0,1) written into last_pos
                    // poisons everything anchored to it (parcel gating, list
                    // distances). Full self updates carry parent + position
                    // together and re-anchor us via track_self instead.
                    if state.objects.agent_local_id(&state.agent_id) == Some(local_id)
                        && !state.sitting
                        && !state.sit_pending
                        && state.objects.parent_id_of(local_id) == Some(0)
                    {
                        actions.extend(sync_self_from_avatar_row(state));
                    }
                }
            }
        }

        // The sim's shorthand on region entry: "object N, checksum C"
        "ObjectUpdateCached" => {
            // EVERY id the sim lists, not a slice of them.
            const IDS_PER_REQUEST: usize = 200;
            let ids: Vec<u32> = block_instances(decoded, "ObjectData")
                .iter()
                .map(|inst| inst_i64(inst, "ID") as u32)
                .filter(|id| *id != 0)
                .collect();
            state.objects.note_cached_ids(ids.iter().copied());
            crate::dlog!(
                "ObjectUpdateCached: {} id(s), {} new",
                ids.len(),
                ids.iter().filter(|id| !state.objects.contains(**id)).count()
            );
            let unknown: Vec<u32> = ids.into_iter().filter(|id| !state.objects.contains(*id)).collect();
            if !unknown.is_empty() && !state.agent_id.is_empty() {
                for chunk in unknown.chunks(IDS_PER_REQUEST) {
                    let data: Vec<Value> = chunk
                        .iter()
                        .map(|id| json!({ "CacheMissType": 0, "ID": id }))
                        .collect();
                    actions.push(Action::send(
                        "RequestMultipleObjects",
                        json!({
                            "AgentData": [{ "AgentID": state.agent_id, "SessionID": state.session_uuid }],
                            "ObjectData": data,
                        }),
                        true,
                    ));
                }
            }
        }

        // Something was removed or moved out of range.
        "KillObject" => {
            for inst in block_instances(decoded, "ObjectData") {
                state.objects.remove(inst_i64(inst, "ID") as u32);
            }
        }

        // What an object would like to be paid.
        "PayPriceReply" => {
            const PAY_PRICE_HIDE: i64 = -1;
            const PAY_PRICE_DEFAULT: i64 = -2;
            const MAX_PAY_BUTTONS: usize = 4;
            let d = block0(decoded, "ObjectData").cloned().unwrap_or(Value::Null);
            let raw = inst_i64(&d, "DefaultPayPrice");
            let hidden = raw == PAY_PRICE_HIDE;
            let suggested_default = if hidden || raw == PAY_PRICE_DEFAULT { 0 } else { raw.abs() };
            let buttons: Vec<i64> = block_instances(decoded, "ButtonData")
                .iter()
                .map(|b| inst_i64(b, "PayButton"))
                .filter(|v| *v > 0)
                .take(MAX_PAY_BUTTONS)
                .collect();
            actions.push(Action::emit(
                "pay-price",
                json!({
                    "id": inst_str(&d, "ObjectID"),
                    // 0 means "it didn't suggest one", not "free".
                    "defaultPrice": suggested_default,
                    "suggested": buttons,
                    // Only PAY_PRICE_HIDE means "don't offer to pay this".
                    "payable": !hidden,
                    // Whenever payment is possible the amount box is shown, so a
                    // custom amount is always allowed unless payment is hidden.
                    "allowCustom": !hidden,
                }),
            ));
        }

        // The fuller reply. It arrives for anything currently selected
        "ObjectProperties" => {
            let mut creators: Vec<String> = Vec::new();
            for d in block_instances(decoded, "ObjectData") {
                let id = inst_str(d, "ObjectID");
                if is_zero_uuid(&id) {
                    continue;
                }
                let creator = inst_str(d, "CreatorID");
                let owner = inst_str(d, "OwnerID");
                if !creator.is_empty() && !is_zero_uuid(&creator) && !creators.contains(&creator) {
                    creators.push(creator.clone());
                }
                state.objects.set_props(
                    &id,
                    &inst_text(d, "Name"),
                    &owner,
                    &creator,
                    inst_i64(d, "SalePrice"),
                    inst_i64(d, "SaleType") as u8,
                );
                actions.push(Action::emit(
                    "object-properties",
                    json!({
                        "id": id,
                        "creatorId": creator,
                        "ownerId": owner,
                        "groupId": inst_str(d, "GroupID"),
                        "lastOwnerId": inst_str(d, "LastOwnerID"),
                        "creationDate": creation_seconds(d),
                        "name": inst_text(d, "Name"),
                        "description": inst_text(d, "Description"),
                        "touchName": inst_text(d, "TouchName"),
                        "sitName": inst_text(d, "SitName"),
                        "ownerMask": inst_i64(d, "OwnerMask"),
                        "nextOwnerMask": inst_i64(d, "NextOwnerMask"),
                        "groupMask": inst_i64(d, "GroupMask"),
                        "everyoneMask": inst_i64(d, "EveryoneMask"),
                        "everyonePerms": crate::bridge::objects::perm_mask_text(inst_i64(d, "EveryoneMask")),
                        "baseMask": inst_i64(d, "BaseMask"),
                        "nextOwnerPerms": crate::bridge::objects::perm_mask_text(inst_i64(d, "NextOwnerMask")),
                        "salePrice": inst_i64(d, "SalePrice"),
                        "saleType": inst_i64(d, "SaleType"),
                        "source": "properties",
                    }),
                ));
            }
            if !creators.is_empty() {
                actions.push(Action::ResolveNames(creators));
            }
        }

        // The reply to our (throttled) name lookups.
        "ObjectPropertiesFamily" => {
            let d = block0(decoded, "ObjectData").cloned().unwrap_or(Value::Null);
            state.objects.set_props(
                &inst_str(&d, "ObjectID"),
                &inst_text(&d, "Name"),
                &inst_str(&d, "OwnerID"),
                "", // the Family reply has no creator; only a selection produces one
                inst_i64(&d, "SalePrice"),
                inst_i64(&d, "SaleType") as u8,
            );
            // The detail view wants more than the list does, so pass the whole reply
            // through as well; the UI matches it up by object id.
            actions.push(Action::emit(
                "object-properties",
                json!({
                    "id": inst_str(&d, "ObjectID"),
                    "name": inst_text(&d, "Name"),
                    "description": inst_text(&d, "Description"),
                    "ownerId": inst_str(&d, "OwnerID"),
                    "groupId": inst_str(&d, "GroupID"),
                    "lastOwnerId": inst_str(&d, "LastOwnerID"),
                    "ownerMask": inst_i64(&d, "OwnerMask"),
                    "nextOwnerMask": inst_i64(&d, "NextOwnerMask"),
                    "groupMask": inst_i64(&d, "GroupMask"),
                    "everyoneMask": inst_i64(&d, "EveryoneMask"),
                    "everyonePerms": crate::bridge::objects::perm_mask_text(inst_i64(&d, "EveryoneMask")),
                    "baseMask": inst_i64(&d, "BaseMask"),
                    "nextOwnerPerms": crate::bridge::objects::perm_mask_text(inst_i64(&d, "NextOwnerMask")),
                    "salePrice": inst_i64(&d, "SalePrice"),
                    "saleType": inst_i64(&d, "SaleType"),
                    "ownershipCost": inst_i64(&d, "OwnershipCost"),
                    "category": inst_i64(&d, "Category"),
                }),
            ));
        }

        // The sim approved our sit request. Complete the two-phase handshake by
        // sending AgentSit (only now - sending it up front races the approval),
        // and track the seat because a seated avatar can't teleport.
        "AvatarSitResponse" => {
            let obj = inst_str(block0(decoded, "SitObject").unwrap_or(&Value::Null), "ID");
            state.sit_pending = false;
            state.sitting = true;
            state.sit_object = obj.clone();
            actions.push(Action::send(
                "AgentSit",
                json!({ "AgentData": [{ "AgentID": state.agent_id, "SessionID": state.session_uuid }] }),
                true,
            ));
            actions.push(Action::emit(
                "sit-state",
                json!({ "sitting": true, "objectId": obj }),
            ));
        }

        // We've left a group, or been ejected from one. Mostly arrives over the
        // EventQueue these days (the UDP form is deprecated), so route_eq handles
        // it too.
        "AgentDropGroup" => {
            let ad = block0(decoded, "AgentData").cloned().unwrap_or(Value::Null);
            let agent = inst_str(&ad, "AgentID");
            if !agent.is_empty() && !same_uuid(&agent, &state.agent_id) {
                return actions; // not about us
            }
            let gid = inst_str(&ad, "GroupID");
            if is_zero_uuid(&gid) {
                return actions;
            }
            let groups = drop_group(state, &gid);
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
            if is_zero_uuid(&transaction_id) || state.is_muted_text(&source_id) {
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
        // frame rate and 0 is the time dilation; the top bar shows the FPS.
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
            state.tp_target = None; // this trip is over either way
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
            let mut started = json!({ "flags": flags });
            if let Some(t) = state.tp_target.clone() {
                if let (Some(dst), Some(obj)) = (started.as_object_mut(), t.as_object()) {
                    for (k, v) in obj {
                        dst.insert(k.clone(), v.clone());
                    }
                }
            }
            actions.push(Action::emit("teleport-started", started));
        }

        // A within-region teleport: it completes immediately, with no sim change.
        "TeleportLocal" => {
            state.tp_target = None;
            let (px, py, pz) = vec3(field(decoded, "Info", "Position"));
            state.last_pos = Some([px, py, pz]);
            actions.extend(stand_up_on_arrival(state));
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
                state.agent_parcel_seq = 0; // new region, new parcel sequence space
                state.last_parcel_hash = 0;
                state.parcel_snapshot = None;
                state.access_lists.clear();
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
            state.objects.clear();
            let mut fin = json!({ "url": seed, "simIp": sim_ip, "simPort": sim_port, "regionHandle": handle });
            if let Some(name) = tp_target_region_name(state) {
                fin["regionName"] = json!(name);
            }
            // The recorded destination belongs to THIS trip only: consume it,
            // or the next target-less arrival (home, landmark, lure) would be
            // stamped with a previous teleport's name.
            state.tp_target = None;
            if let Some((gx, gy)) = wire_region_grid(&handle) {
                state.region_grid_x = gx;
                state.region_grid_y = gy;
                fin["gridX"] = json!(gx);
                fin["gridY"] = json!(gy);
                fin["region"] = json!({ "x": gx, "y": gy, "gridX": gx, "gridY": gy });
            }
            actions.push(Action::emit("teleport-finish", fin));
        }

        // A region crossing, whether by walking or teleport: switch the circuit and update position.
        "CrossedRegion" => {
            state.tp_target = None; // whatever was recorded, we're somewhere new now
            let sim_ip = inst_str(block0(decoded, "RegionData").unwrap_or(&Value::Null), "SimIP");
            let sim_port = as_i64(field(decoded, "RegionData", "SimPort")) as u16;
            let seed = field_text(decoded, "RegionData", "SeedCapability").unwrap_or_default();
            let (px, py, pz) = vec3(field(decoded, "Info", "Position"));
            let handle = inst_str(block0(decoded, "RegionData").unwrap_or(&Value::Null), "RegionHandle");
            if let Some((gx, gy)) = wire_region_grid(&handle) {
                state.region_grid_x = gx;
                state.region_grid_y = gy;
            }
            if !sim_ip.is_empty() && (sim_ip != state.sim_ip || sim_port != state.sim_port) {
                state.sim_ip = sim_ip.clone();
                state.sim_port = sim_port;
                state.handshake_reply_sent = false;
                state.agent_parcel_seq = 0;
                state.last_parcel_hash = 0;
                state.parcel_snapshot = None;
                state.access_lists.clear();
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
            state.objects.clear();
            state.last_pos = Some([px, py, pz]);
            actions.push(Action::InterestList360);
            actions.push(Action::emit(
                "position",
                json!({ "position": { "x": px, "y": py, "z": pz }, "region": region_obj(state), "source": "teleport" }),
            ));
        }

        // The sim confirmed our placement on a (new) region.
        "AgentMovementComplete" => {
            let (px, py, pz) = vec3(field(decoded, "Data", "Position"));
            state.last_pos = Some([px, py, pz]);
            let handle = inst_str(block0(decoded, "Data").unwrap_or(&Value::Null), "RegionHandle");
            if let Some((gx, gy)) = wire_region_grid(&handle) {
                state.region_grid_x = gx;
                state.region_grid_y = gy;
            }
            actions.push(Action::emit(
                "position",
                json!({ "position": { "x": px, "y": py, "z": pz }, "region": region_obj(state), "source": "movement" }),
            ));
            actions.push(Action::InterestList360);
            actions.extend(stand_up_on_arrival(state));
            // Belt and braces for the landing clip: the sim drops us slightly
            // above ground on arrival and plays land/soft-land, and if that
            // AvatarAnimation packet is lost our FINISH_ANIM reply never fires.
            actions.push(Action::FinishAnim { delay_ms: 2000 });
            // A little later, rez whatever Current Outfit attachments the sim
            // didn't restore by itself (the delay lets its own restore finish).
            actions.push(Action::RestoreOutfit { delay_ms: 8000 });
            if !state.agent_id.is_empty() {
                actions.push(Action::send(
                    "MoneyBalanceRequest",
                    json!({
                        "AgentData": [{ "AgentID": state.agent_id, "SessionID": state.session_uuid }],
                        "MoneyData": [{ "TransactionID": "00000000-0000-0000-0000-000000000000" }],
                    }),
                    true,
                ));
                // Now that the sim has told us where we actually are, ask about the
                // parcel under our feet. Doing it here rather than leaving it to the
                // UI means the request always carries the real position: the
                // frontend can still be holding the login placeholder of 128,128,
                // which is the middle of the region and so the wrong parcel.
                let west = 4.0 * (px / 4.0).floor();
                let south = 4.0 * (py / 4.0).floor();
                actions.push(Action::send(
                    "ParcelPropertiesRequest",
                    json!({
                        "AgentData": [{ "AgentID": state.agent_id, "SessionID": state.session_uuid }],
                        "ParcelData": [{
                            "SequenceID": -50000, "West": west, "South": south,
                            "East": west + 4.0, "North": south + 4.0, "SnapSelection": false,
                        }],
                    }),
                    true,
                ));
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
        //
        // Suppressed only for residents whose notes the AgentProfile cap has
        // already delivered: there the cap is the authority, and this legacy
        // reply can arrive afterwards carrying an empty string, which would
        // blank them. Everywhere else - OpenSim, and Second Life replies that
        // simply carry no `notes` key - this is the only path notes travel, so
        // it has to emit even when empty. Otherwise the field never resolves
        // and sits on "Loading notes".
        "AvatarNotesReply" => {
            let target_id = inst_str(block0(decoded, "Data").unwrap_or(&Value::Null), "TargetID");
            if state.cap_notes.contains(&target_id.to_ascii_lowercase()) {
                crate::dlog!("notes: cap already answered for {} - ignoring legacy reply", target_id);
            } else {
                actions.push(Action::emit(
                    "avatar-notes",
                    json!({ "targetId": target_id, "notes": field_text(decoded, "Data", "Notes").unwrap_or_default() }),
                ));
            }
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
                    "maturity": match inst_i64(&d, "Flags") {
                        f if f & 0x2 != 0 => "Adult",
                        f if f & 0x1 != 0 => "Moderate",
                        _ => "General",
                    },
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
                    let id = inst_str(r, "AgentID");
                    if id.is_empty() || is_zero_uuid(&id) { return None; }
                    let first = inst_text(r, "FirstName");
                    let last = inst_text(r, "LastName");
                    let name = format!("{} {}", first, last).trim().to_string();
                    Some(json!({
                        "id": id,
                        "name": name.clone(),
                        "userName": name,
                        "firstName": first,
                        "lastName": last,
                        "group": inst_text(r, "Group"),
                        "online": r.get("Online").and_then(|v| v.as_bool()).unwrap_or(false),
                        "reputation": inst_i64(r, "Reputation"),
                    }))
                })
                .collect();
            let query_id = dir_accumulate(state, decoded, people.clone());
            actions.push(Action::emit(
                "dir-people-reply",
                json!({ "queryId": query_id, "people": people }),
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
            let query_id = dir_accumulate(state, decoded, places.clone());
            actions.push(Action::emit(
                "dir-places-reply",
                json!({ "queryId": query_id, "places": places }),
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
            let query_id = dir_accumulate(state, decoded, groups.clone());
            actions.push(Action::emit(
                "dir-groups-reply",
                json!({ "queryId": query_id, "groups": groups }),
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
            // SimAccess (RegionInfo, U8) is PG=13, Mature=21, Adult=42.
            let access = as_i64(field(decoded, "RegionInfo", "SimAccess"));
            if access != 0 {
                state.region_access = access;
            }
            if let Some(product) = field_text(decoded, "RegionInfo3", "ProductName") {
                if !product.is_empty() {
                    state.region_product = product;
                }
            }
            let flags_ext = block_instances(decoded, "RegionInfo4")
                .first()
                .map(|r| llsd_u64_str(r.get("RegionFlagsExtended")))
                .and_then(|s| s.parse::<u64>().ok());
            state.region_flags = flags_ext
                .unwrap_or_else(|| as_i64(field(decoded, "RegionInfo", "RegionFlags")) as u64);
            let mut region = region_obj(state);
            if let Value::Object(ref mut m) = region {
                m.insert("handshakeOnly".into(), json!(true));
            }
            actions.push(Action::emit("region", region));
            if !state.handshake_reply_sent {
                state.handshake_reply_sent = true;
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
fn parcel_from_eq(state: &mut SessionState, body: &Value) -> Option<Action> {
    let pd = body.get("ParcelData").and_then(|v| v.as_array()).and_then(|a| a.first())?;
    if inst_i64(pd, "RequestResult") == -1 {
        return None; // the sim has no parcel data here
    }
    // Same staleness gates as the UDP arm: out-of-order pushes and replies for
    // somewhere we no longer stand are what made the Land tab "blink".
    let seq = inst_i64(pd, "SequenceID");
    let aabb = Some((
        {
            let (x, y, z) = vec3(pd.get("AABBMin"));
            [x, y, z]
        },
        {
            let (x, y, z) = vec3(pd.get("AABBMax"));
            [x, y, z]
        },
    ));
    if !parcel_fresh(state, seq, aabb) {
        return None;
    }
    note_unknown_parcel_fields(pd);
    // The Media 2.0 fields live in a separate MediaData block, not in ParcelData.
    let media = body.get("MediaData").and_then(|v| v.as_array()).and_then(|a| a.first());
    // Link sharing and the obscure-MOAP bit have blocks of their own again.
    let link = body.get("MediaLinkSharing").and_then(|v| v.as_array()).and_then(|a| a.first());
    let ext = body.get("ParcelExtendedFlags").and_then(|v| v.as_array()).and_then(|a| a.first());
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
    let (lx, ly, lz) = vec3(pd.get("UserLookAt"));
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
    let payload = json!({
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
            "groupName": group_name_of(state, &group_id),
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
            "allowObjectEntryAll": has(pflag::ALL_OBJECT_ENTRY),
            "allowObjectEntryGroup": has(pflag::GROUP_OBJECT_ENTRY),
            "allowDeedToGroup": has(pflag::ALLOW_DEED_TO_GROUP),
            "denyAnonymous": has(pflag::DENY_ANONYMOUS),
            "denyAgeUnverified": has(pflag::DENY_AGEUNVERIFIED),
            "useAccessGroup": has(pflag::ACCESS_GROUP),
            "useAccessList": has(pflag::ACCESS_LIST),
            "forSale": has(pflag::FOR_SALE),
            "sellWithObjects": has(pflag::SELL_PARCEL_OBJECTS),
            "auctionId": inst_i64(pd, "AuctionID"),
            "status": inst_i64(pd, "Status"),
            "musicUrl": inst_str(pd, "MusicURL"),
            "mediaUrl": inst_str(pd, "MediaURL"),
            "mediaId": inst_str(pd, "MediaID"),
            "mediaAutoScale": inst_i64(pd, "MediaAutoScale"),
            "mediaType": media.and_then(|m| m.get("MediaType")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "mediaDesc": media.and_then(|m| m.get("MediaDesc")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            // This is the path Second Life actually uses, and the only one that
            // carries these at all. The capability save replaces the parcel
            // wholesale, so every one of them has to round-trip.
            "mediaWidth": as_i64(media.and_then(|m| m.get("MediaWidth"))),
            "mediaHeight": as_i64(media.and_then(|m| m.get("MediaHeight"))),
            "mediaLoop": as_i64(media.and_then(|m| m.get("MediaLoop"))),
            "mediaCurrentUrl": link.and_then(|m| m.get("MediaCurrentURL")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "mediaAllowNavigate": truthy(link.and_then(|m| m.get("MediaAllowNavigate"))),
            "mediaPreventCameraZoom": truthy(link.and_then(|m| m.get("MediaPreventCameraZoom"))),
            "mediaUrlTimeout": as_f64(link.and_then(|m| m.get("MediaURLTimeout"))),
            "seeAvs": parcel_bool_or_allowed(pd.get("SeeAVs")),
            "anyAvSounds": parcel_bool_or_allowed(pd.get("AnyAVSounds")),
            "groupAvSounds": parcel_bool_or_allowed(pd.get("GroupAVSounds")),
            "obscureMoap": as_i64(ext.and_then(|m| m.get("Flags"))) != 0,
            "maturePublish": has(pflag::MATURE_PUBLISH),
            "voiceUseEstate": has(pflag::USE_ESTATE_VOICE_CHAN),
            // See the UDP arm: cap-only fields are greyed out without the cap.
            "canEditCapFields": state.caps.contains_key("ParcelPropertiesUpdate"),
            "salePrice": inst_i64(pd, "SalePrice"),
            "passPrice": inst_i64(pd, "PassPrice"),
            "passHours": as_f64(pd.get("PassHours")),
            "category": inst_i64(pd, "Category"),
            "authBuyerId": inst_str(pd, "AuthBuyerID"),
            "snapshotId": snapshot,
            "snapshotUrl": snapshot_url,
            "landingPoint": { "x": ux.round(), "y": uy.round(), "z": uz.round() },
            "landingHeading": landing_heading.round(),
            // Exact vectors for the save round-trip (see the UDP handler).
            "userLocation": { "x": ux, "y": uy, "z": uz },
            "userLookAt": { "x": lx, "y": ly, "z": lz },
            "landingType": inst_i64(pd, "LandingType"),
            "claimDate": inst_i64(pd, "ClaimDate"),
            "otherCleanTime": inst_i64(pd, "OtherCleanTime"),
            "regionId": state.region_id,
            "canEdit": can_edit,
            "source": "eq",
            "stub": false,
    });
    emit_parcel_deduped(state, payload)
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
            // A blocked sender must not pull us into a session: if the tab isn't
            // already open, ignore the invitation entirely; if it is, keep the
            // session but drop their text.
            let muted_sender = state.is_muted_text(&from_id) || state.is_muted_text(&session_id);
            if muted_sender && !state.im_rosters.contains_key(&session_id) {
                return actions;
            }
            let from_name = str_field(mp, &["from_name", "fromName"]);
            state.cache_name(&from_id, &from_name);
            let display = state.cached_name(&from_id).unwrap_or(&from_name).to_string();
            actions.push(Action::ResolveNames(vec![from_id.clone()]));
            actions.push(Action::AcceptChatSession { session_id: session_id.clone() });

            // Group vs conference is decided by session-id membership.
            let stype = if state.groups.contains(&session_id.to_lowercase()) { "group" } else { "conference" };
            let text = str_field(mp, &["message"]);
            if !text.is_empty() && !muted_sender {
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
                state.agent_parcel_seq = 0;
                state.last_parcel_hash = 0;
                state.parcel_snapshot = None;
                state.access_lists.clear();
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
            // Destination name only (see the UDP TeleportFinish arm) - the
            // session still carries the origin's name at this point.
            let mut fin = json!({ "url": seed, "simIp": sim_ip, "simPort": sim_port });
            if let Some(name) = tp_target_region_name(state) {
                fin["regionName"] = json!(name);
            }
            // Consumed: the name must never outlive its own trip (a landmark
            // or lure arrival carries no target of its own to overwrite it).
            state.tp_target = None;
            if let Some((gx, gy)) = llsd_region_grid(info.get("RegionHandle")) {
                state.region_grid_x = gx;
                state.region_grid_y = gy;
                state.objects.clear();
                fin["gridX"] = json!(gx);
                fin["gridY"] = json!(gy);
                fin["region"] = json!({ "x": gx, "y": gy, "gridX": gx, "gridY": gy });
            }
            actions.push(Action::emit("teleport-finish", fin));
        }

        // Walking across a region border also comes in via the EventQueue.
        "CrossedRegion" => {
            state.tp_target = None; // whatever was recorded, we're somewhere new now
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
                state.agent_parcel_seq = 0;
                state.last_parcel_hash = 0;
                state.parcel_snapshot = None;
                state.access_lists.clear();
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
            state.objects.clear();
            state.last_pos = Some([px, py, pz]);
            actions.push(Action::InterestList360);
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

        // The prim-owner census is UDP-deprecated on SL, so it lands here.
        "ParcelObjectOwnersReply" => {
            let mut ids = Vec::new();
            let owners: Vec<Value> = body
                .get("Data")
                .and_then(|v| v.as_array())
                .map(|rows| {
                    rows.iter()
                        .filter_map(|o| {
                            let id = str_field(o, &["OwnerID", "owner_id"]);
                            if id.is_empty() || is_zero_uuid(&id) {
                                return None;
                            }
                            ids.push(id.clone());
                            Some(json!({
                                "id": id,
                                "isGroup": truthy(o.get("IsGroupOwned")),
                                "count": as_i64(o.get("Count")),
                                "online": truthy(o.get("OnlineStatus")),
                            }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            actions.push(Action::emit("parcel-object-owners", json!({ "owners": owners })));
            if !ids.is_empty() {
                actions.push(Action::ResolveNames(ids));
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
            let incoming: Vec<Value> = body
                .get("GroupData")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|g| {
                            let id = g.get("GroupID").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            if is_zero_uuid(&id) {
                                return None;
                            }
                            Some(json!({
                                "id": id,
                                "name": g.get("GroupName").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                "insigniaId": g.get("GroupInsigniaID").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                "powers": llsd_u64_str(g.get("GroupPowers")),
                                "acceptNotices": g.get("AcceptNotices").and_then(|v| v.as_bool()).unwrap_or(false),
                                "contribution": g.get("Contribution").and_then(|v| v.as_i64()).unwrap_or(0),
                            }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let groups = merge_group_data(state, incoming);
            actions.push(Action::emit("group-membership", json!({ "groups": groups })));
        }

        // Left or ejected from a group. This is the path that actually fires these
        // days, since the UDP AgentDropGroup is deprecated.
        "AgentDropGroup" => {
            let ad = body
                .get("AgentData")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .cloned()
                .unwrap_or(Value::Null);
            let agent = ad.get("AgentID").and_then(|v| v.as_str()).unwrap_or("");
            if !agent.is_empty() && !same_uuid(agent, &state.agent_id) {
                return actions; // not about us
            }
            let gid = ad.get("GroupID").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if is_zero_uuid(&gid) {
                return actions;
            }
            let groups = drop_group(state, &gid);
            actions.push(Action::emit("group-membership", json!({ "groups": groups })));
        }

        // A teleport failure also arrives via the EventQueue, so surface it to stop
        // the UI waiting (e.g. an invalid destination -> "invalid_tport").
        "TeleportFailed" => {
            state.tp_target = None; // this trip is over either way
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

    // Nothing unsolicited gets through from a blocked sender: messages, typing,
    // offers, invites. Replies to things WE sent (inventory 5/6, teleport 23/24,
    // friendship 39/40) still land, matching the reference viewer. The ID field
    // names the object for an object IM (dialog 19) and the group for session
    // chat, so a blocked object or group is checked there.
    let is_reply_dialog = matches!(dialog, 5 | 6 | 23 | 24 | 39 | 40);
    if !is_reply_dialog
        && (state.is_muted_text(&from_id)
            || (dialog == 19 && state.is_muted(&im_id))
            || (is_session && state.is_muted_text(&im_id)))
    {
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
        // A group notice (32, or 37 when re-requested): "Subject|Body" in the
        // message text, the group id and an optional inventory attachment in
        // the binary bucket. It gets an Events-tab card of its own instead of
        // drowning in group chat.
        32 | 37 => {
            let raw_bucket = inst_bytes(&msg, "BinaryBucket");
            let (has_attachment, bucket_group, item_name) = parse_group_notice_bucket(&raw_bucket);
            // The sender rides in the AgentData/FromAgentName fields; the group
            // is named by the bucket (fall back to the from id, which some
            // grids set to the group).
            let group_id = if is_zero_uuid(&bucket_group) || bucket_group.is_empty() {
                from_id.clone()
            } else {
                bucket_group
            };
            if state.is_muted_text(&group_id) {
                return actions; // the group itself is blocked
            }
            let (subject, body) = split_notice_text(&text);
            // Notices can replay (online + offline delivery); one card is enough.
            if state.is_duplicate_im(&format!("group-notice\0{im_id}\0{text}")) {
                return actions;
            }
            actions.push(Action::ResolveNames(vec![from_id.clone()]));
            let mut payload = json!({
                "kind": "group-notice",
                "fromId": &from_id, "fromName": &display,
                "groupId": &group_id, "groupName": group_name_of(state, &group_id),
                "subject": subject, "text": body,
                "type": "group-notice", "source": "system", "channel": 0,
            });
            if has_attachment {
                // The accept/decline reply (dialog 33/34) is addressed to the
                // group id, carrying this IM's id as the transaction.
                payload["prompt"] = json!({
                    "type": "group-notice-attachment",
                    "fromId": &group_id, "fromName": &display,
                    "itemName": item_name,
                    "transactionId": &im_id, "resolved": false, "response": "",
                });
            }
            actions.push(Action::emit("event", payload));
            return actions;
        }

        // Inventory offered by a resident (4) or by an object's script (9).
        // These used to fall through to the plain-IM path, so the offer showed
        // up as a message with the location blob in it and no way to answer.
        // The IM ID is the transaction id the accept/decline reply must carry.
        4 | 9 => {
            let from_task = dialog == 9;
            let item = offer_item_name(&text);
            // A resident offer's bucket is binary: asset type (1 byte) then the
            // item's UUID - the item is already in our inventory, and a decline
            // is supposed to move it to Trash. Task offers only carry the type.
            let raw_bucket = inst_bytes(&msg, "BinaryBucket");
            let item_id = if !from_task && raw_bucket.len() >= 17 {
                let mut b = [0u8; 16];
                b.copy_from_slice(&raw_bucket[1..17]);
                crate::bridge::objects::id_string(&b)
            } else {
                String::new()
            };
            let item_label = if item.is_empty() { "an item".to_string() } else { format!("'{item}'") };
            let text_line = if from_task {
                format!("The object '{display}' has offered you {item_label}.")
            } else {
                format!("{display} has offered you {item_label}.")
            };
            actions.push(Action::ResolveNames(vec![from_id.clone()]));
            actions.push(Action::emit(
                "event",
                json!({
                    "kind": "interactive-prompt", "fromId": &from_id, "fromName": &display,
                    "text": text_line,
                    "type": "inventory-offer", "source": "system", "channel": 0,
                    "prompt": {
                        "type": "inventory-offer", "fromId": &from_id, "fromName": &display,
                        "fromTask": from_task, "itemName": item, "itemId": item_id,
                        "transactionId": &im_id, "resolved": false, "response": "",
                    }
                }),
            ));
            return actions;
        }
        // The other party answered an inventory offer we sent.
        5 => {
            actions.push(system_chat(&format!("{display} accepted your inventory offer.")));
            return actions;
        }
        6 => {
            actions.push(system_chat(&format!("{display} declined your inventory offer.")));
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
    if is_session && !session_im_id.is_empty() {
        let dedup_key = format!("{session_im_id}\0{from_id}\0{dialog}\0{text}\0{wire_ts}");
        if state.is_duplicate_im(&dedup_key) {
            return actions;
        }
    }

    let mut participant = json!({ "id": &from_id, "name": &display });
    if offline == 0 {
        participant["online"] = json!(true);
    }
    let msg_im_id = if is_session && !session_im_id.is_empty() { &session_im_id } else { &im_id };
    let mut payload = json!({
        "participant": participant,
        "message": {
            "imId": msg_im_id, "fromId": &from_id, "fromName": &display,
            "text": &text, "outgoing": false,
        }
    });

    if is_session && !session_im_id.is_empty() {
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
    fn agent_update_looks_from_where_we_are() {
        let body = build_agent_update("a", "s", [42.5, 200.0, 30.0], AGENT_CONTROL_FLY);
        let data = &body["AgentData"][0];
        assert_eq!(data["CameraCenter"], json!([42.5, 200.0, 30.0]));
        assert_eq!(data["Far"], json!(INTEREST_FAR));
        assert!(INTEREST_FAR > 0.0, "a zero draw distance asks the sim for nothing");
        assert_eq!(data["ControlFlags"], json!(AGENT_CONTROL_FLY));
        // The axes have to be a real frame or the sim can't work out where we're facing.
        assert_eq!(data["CameraAtAxis"], json!([1.0, 0.0, 0.0]));
        assert_eq!(data["CameraUpAxis"], json!([0.0, 0.0, 1.0]));
    }

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
    fn every_cached_object_id_is_requested() {
        let mut st = SessionState { agent_id: "me".into(), session_uuid: "s".into(), ..Default::default() };
        let total = 512usize;
        let data: Vec<Value> = (1..=total as u32)
            .map(|id| json!({ "ID": id, "CRC": 0, "UpdateFlags": 0 }))
            .collect();
        let actions = route(&mut st, &json!({
            "name": "ObjectUpdateCached",
            "blocks": { "RegionData": [{ "RegionHandle": "0", "TimeDilation": 0 }], "ObjectData": data },
        }));

        let mut asked: Vec<u64> = Vec::new();
        for a in &actions {
            if let Action::Send { name, blocks, reliable } = a {
                assert_eq!(name, "RequestMultipleObjects");
                assert!(*reliable, "a dropped request is an object we never hear about again");
                let ids = blocks["ObjectData"].as_array().expect("ObjectData");
                assert!(ids.len() <= 200, "each message has to stay inside one datagram");
                for entry in ids {
                    assert_eq!(entry["CacheMissType"], 0);
                    asked.push(entry["ID"].as_u64().expect("ID"));
                }
            }
        }
        asked.sort();
        assert_eq!(asked.len(), total, "no id may be left out");
        assert_eq!(asked, (1..=total as u64).collect::<Vec<u64>>());

        // Ids we already hold aren't asked about twice.
        st.objects.upsert(crate::bridge::objects::ObjectRow { local_id: 7, ..Default::default() });
        let again = route(&mut st, &json!({
            "name": "ObjectUpdateCached",
            "blocks": { "ObjectData": [{ "ID": 7 }, { "ID": 8 }] },
        }));
        let sent: Vec<u64> = again
            .iter()
            .filter_map(|a| match a {
                Action::Send { blocks, .. } => Some(blocks["ObjectData"].clone()),
                _ => None,
            })
            .flat_map(|d| d.as_array().cloned().unwrap_or_default())
            .filter_map(|e| e["ID"].as_u64())
            .collect();
        assert_eq!(sent, vec![8]);
    }

    const SELF_AGENT: &str = "aa000000-0000-0000-0000-000000000001";

    /// A full ObjectUpdate blob in the avatar wire form (76 bytes): the 16-byte
    /// collision plane comes FIRST - reading it as the position is the classic
    /// everyone-stands-at-the-region-corner bug - and `pos` follows it.
    fn self_blob(pos: [f32; 3]) -> String {
        let mut b = Vec::with_capacity(76);
        for v in [0.0f32, 0.0, 1.0, 20.0] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        for v in pos {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b.resize(76, 0);
        B64.encode(b)
    }

    fn self_update(agent: &str, parent: u32, pos: [f32; 3]) -> Value {
        json!({
            "name": "ObjectUpdate",
            "blocks": { "ObjectData": [{
                "ID": 99u32, "FullID": agent, "PCode": 47, "ParentID": parent,
                "ObjectData": self_blob(pos),
            }] },
        })
    }

    /// An ImprovedTerseObjectUpdate Data blob for an avatar: LocalID, State,
    /// agent flag, the collision plane, then the (parent-frame) position.
    fn terse_avatar_blob(local_id: u32, pos: [f32; 3]) -> String {
        let mut b = Vec::with_capacity(60);
        b.extend_from_slice(&local_id.to_le_bytes());
        b.push(0); // State
        b.push(1); // agent flag: a collision plane follows
        for v in [0.0f32, 0.0, 1.0, 2088.0] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        for v in pos {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b.resize(60, 0);
        B64.encode(b)
    }

    fn terse_update(local_id: u32, pos: [f32; 3]) -> Value {
        json!({
            "name": "ImprovedTerseObjectUpdate",
            "blocks": { "ObjectData": [{ "Data": terse_avatar_blob(local_id, pos) }] },
        })
    }

    #[test]
    fn terse_self_update_moves_us_while_standing() {
        let mut st = SessionState { agent_id: SELF_AGENT.into(), ..Default::default() };
        route(&mut st, &self_update(SELF_AGENT, 0, [197.0, 171.0, 2088.0]));
        let a = route(&mut st, &terse_update(99, [199.0, 173.0, 2088.0]));
        assert_eq!(st.last_pos, Some([199.0, 173.0, 2088.0]));
        assert!(emit_of(&a, "position").is_some());
    }

    #[test]
    fn terse_seat_offset_never_becomes_our_region_position() {
        // The sit race: a terse update carrying the seat-relative (0,0,1) can
        // be processed before the full update that records the parenting. It
        // must not be mistaken for standing at the region corner - that spot
        // poisons the parcel gate and every list distance until repaired.
        let mut st = SessionState { agent_id: SELF_AGENT.into(), ..Default::default() };
        route(&mut st, &self_update(SELF_AGENT, 0, [197.0, 171.0, 2088.0]));
        st.sit_pending = true; // the sit was requested; the sim is switching us
        let a = route(&mut st, &terse_update(99, [0.0, 0.0, 1.0]));
        assert!(emit_of(&a, "position").is_none());
        assert_eq!(
            st.last_pos,
            Some([197.0, 171.0, 2088.0]),
            "a seat offset must not become our position"
        );
    }

    #[test]
    fn terse_while_seated_defers_to_the_seat_chain() {
        let mut st = SessionState { agent_id: SELF_AGENT.into(), ..Default::default() };
        st.objects.upsert(crate::bridge::objects::ObjectRow {
            local_id: 4242,
            pos: [100.0, 50.0, 2000.0],
            ..Default::default()
        });
        route(&mut st, &self_update(SELF_AGENT, 4242, [0.0, 0.0, 1.0]));
        assert_eq!(st.last_pos, Some([100.0, 50.0, 2001.0]), "track_self resolves via the seat");
        // A terse tick with a fresh seat-relative offset changes nothing:
        // while seated, the full updates and the radar own our position.
        let a = route(&mut st, &terse_update(99, [0.0, 0.0, 1.1]));
        assert!(emit_of(&a, "position").is_none());
        assert_eq!(st.last_pos, Some([100.0, 50.0, 2001.0]));
    }

    #[test]
    fn our_own_object_update_says_where_we_are() {
        let mut st = SessionState { agent_id: SELF_AGENT.into(), ..Default::default() };
        let a = route(&mut st, &self_update(SELF_AGENT, 0, [64.0, 192.0, 2013.5]));
        assert_eq!(st.last_pos, Some([64.0, 192.0, 2013.5]));
        let pos = &emit_of(&a, "position").expect("position")["position"];
        assert_eq!(pos["z"], 2013.5);
        // Avatar row is tracked for sit/stand, but never listable as a nearby prim.
        assert!(
            st.objects.nearby([64.0, 192.0, 2013.5], 96.0).is_empty(),
            "our own avatar is not a nearby object"
        );
    }

    #[test]
    fn sitting_position_is_relative_to_the_seat() {
        let mut st = SessionState { agent_id: SELF_AGENT.into(), ..Default::default() };
        st.objects.upsert(crate::bridge::objects::ObjectRow {
            local_id: 4242,
            pos: [100.0, 100.0, 2000.0],
            ..Default::default()
        });
        let a = route(&mut st, &self_update(SELF_AGENT, 4242, [0.5, -1.0, 0.75]));
        assert_eq!(st.last_pos, Some([100.5, 99.0, 2000.75]));
        assert!(st.sitting, "a parent means we're sitting on it");
        assert_eq!(emit_of(&a, "sit-state").expect("sit-state")["sitting"], true);

        // An untracked seat can't be resolved, so the last known position stands rather
        // than being overwritten with a bare offset.
        st.last_pos = Some([1.0, 2.0, 3.0]);
        route(&mut st, &self_update(SELF_AGENT, 777, [0.5, 0.5, 0.5]));
        assert_eq!(st.last_pos, Some([1.0, 2.0, 3.0]));
    }

    #[test]
    fn losing_the_parent_means_we_stood_up() {
        let mut st = SessionState { agent_id: "me".into(), sitting: true, ..Default::default() };
        st.sit_object = "sofa".into();
        let a = route(&mut st, &self_update("me", 0, [10.0, 10.0, 25.0]));
        assert!(!st.sitting);
        assert!(st.sit_object.is_empty());
        assert_eq!(emit_of(&a, "sit-state").expect("sit-state")["sitting"], false);
    }

    #[test]
    fn standing_after_sit_clears_parent_and_keeps_region_position() {
        let mut st = SessionState { agent_id: SELF_AGENT.into(), ..Default::default() };
        st.objects.upsert(crate::bridge::objects::ObjectRow {
            local_id: 4242,
            pos: [200.0, 171.0, 2088.0],
            ..Default::default()
        });
        route(&mut st, &self_update(SELF_AGENT, 4242, [1.0, 0.0, 0.5]));
        assert!(st.sitting);
        route(&mut st, &self_update(SELF_AGENT, 0, [201.0, 171.0, 2088.0]));
        assert!(!st.sitting);
        assert_eq!(st.last_pos, Some([201.0, 171.0, 2088.0]));
        let avatar_id = st.objects.agent_local_id(SELF_AGENT).expect("avatar row");
        assert_eq!(st.objects.parent_id_of(avatar_id), Some(0));
        let pos = st
            .objects
            .agent_region_pos(SELF_AGENT)
            .expect("avatar region pos");
        assert!(
            (pos[2] - 2088.0).abs() < 0.1,
            "stand-up must not double seat height, got z={}",
            pos[2]
        );
    }

    #[test]
    fn a_teleport_stands_us_up() {
        let mut st = SessionState { agent_id: "me".into(), sitting: true, ..Default::default() };
        let a = route(&mut st, &json!({
            "name": "TeleportLocal",
            "blocks": { "Info": [{
                "AgentID": "me", "LocationID": 1, "Position": [20.0, 30.0, 40.0],
                "LookAt": [0.0, 0.0, 0.0], "TeleportFlags": 0,
            }] },
        }));
        assert!(!st.sitting, "arriving anywhere means we're on our feet");
        assert_eq!(emit_of(&a, "sit-state").expect("sit-state")["sitting"], false);
    }

    #[test]
    fn mute_list_file_parses_to_people() {
        let file = "\
1 11111111-1111-1111-1111-111111111111 Ruth Resident|0
2 22222222-2222-2222-2222-222222222222 Noisy Box|1
3 33333333-3333-3333-3333-333333333333 Some Group|0
1 44444444-4444-4444-4444-444444444444 Bob Linden|4
0 00000000-0000-0000-0000-000000000000 Legacy Name|0

";
        let people = parse_mute_list(file);
        assert_eq!(people.len(), 2, "objects, groups and by-name entries aren't people");
        assert_eq!(people[0]["name"], "Ruth Resident");
        assert_eq!(people[0]["id"], "11111111-1111-1111-1111-111111111111");
        assert_eq!(people[1]["flags"], 4);
        assert!(parse_mute_list("").is_empty());
        assert!(parse_mute_list("nonsense").is_empty());
    }

    /// A file arrives a packet at a time: the first carries a big-endian size in front of
    /// the payload, the last is flagged, and every packet has to be acknowledged or the
    /// sim keeps resending it.
    #[test]
    fn an_xfer_is_reassembled_and_acknowledged() {
        let mut st = SessionState { agent_id: "me".into(), now_ms: 1, ..Default::default() };
        let id = 4242u64;
        st.xfers.insert(id, XferIn { kind: "mute-list".into(), ..Default::default() });

        let line = "1 55555555-5555-5555-5555-555555555555 Mute Me|0\n";
        let (head, tail) = line.as_bytes().split_at(10);
        let mut first = (line.len() as u32).to_be_bytes().to_vec();
        first.extend_from_slice(head);

        let packet = |id: u64, num: u32, data: &[u8]| {
            json!({
                "name": "SendXferPacket",
                "blocks": {
                    "XferID": [{ "ID": id.to_string(), "Packet": num }],
                    "DataPacket": [{ "Data": B64.encode(data) }],
                },
            })
        };
        let a = route(&mut st, &packet(id, 0, &first));
        assert!(
            a.iter().any(|x| matches!(x, Action::Send { name, .. } if name == "ConfirmXferPacket")),
            "every packet has to be confirmed"
        );
        assert_eq!(st.xfers[&id].data.len(), head.len(), "the size prefix isn't payload");

        // Last packet: high bit set.
        let a = route(&mut st, &packet(id, 1 | 0x8000_0000, tail));
        assert!(!st.xfers.contains_key(&id), "a finished transfer is dropped");
        let people = emit_of(&a, "mute-list").expect("mute-list")["people"].as_array().cloned().unwrap();
        assert_eq!(people.len(), 1);
        assert_eq!(people[0]["name"], "Mute Me");
    }

    #[test]
    fn cached_mute_list_prompts_one_fresh_request() {
        let mut st = SessionState { agent_id: "me".into(), ..Default::default() };
        let pkt = json!({ "name": "UseCachedMuteList", "blocks": { "AgentData": [{ "AgentID": "me" }] } });
        let first = route(&mut st, &pkt);
        assert!(first.iter().any(|a| matches!(a, Action::Send { name, .. } if name == "MuteListRequest")));
        let second = route(&mut st, &pkt);
        assert!(second.is_empty(), "asking twice would never end");
    }

    #[test]
    fn mute_filter_covers_every_type_while_the_people_list_stays_people() {
        let text = "1 55555555-5555-5555-5555-555555555555 Rude Resident|0\n\
                    2 66666666-6666-6666-6666-666666666666 Spammy Object|0\n\
                    3 77777777-7777-7777-7777-777777777777 Loud Group|0\n\
                    0 00000000-0000-0000-0000-000000000000 legacy name|\n";
        let people = parse_mute_list(text);
        assert_eq!(people.len(), 1, "objects, groups, and legacy names aren't people");
        assert_eq!(people[0]["name"], "Rude Resident");
        let ids = parse_mute_filters(text);
        assert_eq!(ids.len(), 3, "every real id filters, whatever its type");
        assert!(ids.contains_key("66666666-6666-6666-6666-666666666666"));
        assert!(ids.contains_key("77777777-7777-7777-7777-777777777777"));
    }

    #[test]
    fn blocks_made_during_a_list_fetch_survive_the_fetch() {
        let mut st = me_state();
        // A block sent while the (older) list file is in flight must not be
        // undone when that file lands.
        st.set_block_state(OTHER, true);
        st.muted = parse_mute_filters("");
        st.apply_mute_overrides();
        assert!(st.is_muted_text(OTHER));
        // Same for an unblock racing a file that still carries the entry.
        st.set_block_state(OTHER, false);
        st.muted = parse_mute_filters(&format!("1 {OTHER} Ruth Resident|0\n"));
        st.apply_mute_overrides();
        assert!(!st.is_muted(OTHER));
    }

    #[test]
    fn mute_flags_exempt_text_but_not_prompts() {
        // A voice-only mute made in a full viewer (flags bit 1 = text exempt)
        // must NOT silence text here, while a full mute (flags 0) must.
        let text = "1 55555555-5555-5555-5555-555555555555 Voice Only|1\n";
        let mut st = me_state();
        st.muted = parse_mute_filters(text);
        assert!(st.is_muted("55555555-5555-5555-5555-555555555555"), "still a mute entry");
        assert!(!st.is_muted_text("55555555-5555-5555-5555-555555555555"), "text is exempt");
        let a = route(&mut st, &chat_packet(1, 1, 1, "Voice Only", "55555555-5555-5555-5555-555555555555", "hi"));
        assert!(emit_of(&a, "chat").is_some(), "text-exempt entries keep chatting");
    }

    #[test]
    fn chat_from_blocked_agents_and_their_objects_is_dropped() {
        let mut st = me_state();
        st.muted.insert(OTHER.into(), 0);
        assert!(route(&mut st, &chat_packet(1, 1, 1, "Ruth Resident", OTHER, "unheard")).is_empty());
        // Their objects are silent too, whether muted by object id or by owner.
        let mut pkt = chat_packet(2, 1, 1, "Cube", "66666666-6666-6666-6666-666666666666", "buy now");
        pkt["blocks"]["ChatData"][0]["OwnerID"] = json!(OTHER);
        assert!(route(&mut st, &pkt).is_empty());
        // Everyone else still comes through.
        let ok = route(&mut st, &chat_packet(1, 1, 1, "Ann", "33333333-3333-3333-3333-333333333333", "hello"));
        assert!(emit_of(&ok, "chat").is_some());
    }

    #[test]
    fn ims_and_offers_from_blocked_senders_are_dropped_but_replies_pass() {
        let mut st = me_state();
        st.muted.insert(OTHER.into(), 0);
        let zero = "00000000-0000-0000-0000-000000000000";
        let tx = "33333333-3333-3333-3333-333333333333";
        assert!(route(&mut st, &im_packet(0, OTHER, ME, false, zero, "hello", "")).is_empty(), "plain IM");
        assert!(route(&mut st, &im_packet(41, OTHER, ME, false, "0", "", "")).is_empty(), "typing ping");
        assert!(route(&mut st, &im_packet(22, OTHER, ME, false, tx, "Join me", "1|1|1|1|1|1|1|1|M")).is_empty(), "teleport offer");
        assert!(route(&mut st, &im_packet(38, OTHER, ME, false, tx, "", "")).is_empty(), "friendship offer");
        assert!(route(&mut st, &im_packet(4, OTHER, ME, false, tx, "Blue Hat", "")).is_empty(), "inventory offer");
        // A friendship card offer is an offer too.
        let card = json!({
            "name": "OfferCallingCard",
            "blocks": {
                "AgentData": [{ "AgentID": OTHER, "SessionID": "s" }],
                "AgentBlock": [{ "DestID": ME, "TransactionID": tx }],
            }
        });
        assert!(route(&mut st, &card).is_empty(), "calling card offer");
        // Answers to things WE initiated still land.
        let a = route(&mut st, &im_packet(23, OTHER, ME, false, tx, "", ""));
        assert!(emit_of(&a, "teleport-accepted").is_some(), "their reply to our offer");
    }

    #[test]
    fn object_im_is_dropped_when_the_object_id_is_blocked() {
        let mut st = me_state();
        // Dialog 19 carries the object's id in the ID field; the sender field
        // holds the owner. Blocking the object alone must be enough.
        let object_id = "66666666-6666-6666-6666-666666666666";
        st.muted.insert(object_id.into(), 0);
        assert!(route(&mut st, &im_packet(19, OTHER, ME, false, object_id, "spam", "")).is_empty());
    }

    #[test]
    fn group_notice_from_blocked_group_is_dropped() {
        let mut st = me_state();
        st.muted.insert("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into(), 0);
        let mut bucket = vec![0u8, 0u8];
        bucket.extend_from_slice(&[0xAA; 16]);
        let pkt = json!({
            "name": "ImprovedInstantMessage",
            "blocks": {
                "AgentData": [{ "AgentID": OTHER, "SessionID": "s" }],
                "MessageBlock": [{
                    "FromGroup": true, "ToAgentID": ME, "Offline": 0, "Dialog": 32,
                    "ID": "33333333-3333-3333-3333-333333333333", "Timestamp": 0,
                    "FromAgentName": B64.encode(b"Pantera\0"),
                    "Message": B64.encode(b"Meeting|Bring snacks.\0"),
                    "BinaryBucket": B64.encode(&bucket),
                }]
            }
        });
        assert!(route(&mut st, &pkt).is_empty());
    }

    #[test]
    fn chatterbox_invitation_from_blocked_sender_cannot_open_a_session() {
        let mut st = me_state();
        st.muted.insert(OTHER.into(), 0);
        let session = "55555555-5555-5555-5555-555555555555";
        let body = json!({ "instantmessage": { "message_params": {
            "from_id": OTHER, "id": session, "from_name": "Ruth", "message": "ping",
        } } });
        assert!(route_eq(&mut st, "ChatterBoxInvitation", &body).is_empty());
        // With the session already open, it stays open but their text is dropped.
        st.im_rosters.insert(session.into(), ImRoster::default());
        let a = route_eq(&mut st, "ChatterBoxInvitation", &body);
        assert!(emit_of(&a, "im").is_none());
        assert!(
            a.iter().any(|x| matches!(x, Action::AcceptChatSession { .. })),
            "an open session keeps its lifeline"
        );
    }

    #[test]
    fn block_list_fetch_fills_the_filter_set() {
        let mut st = me_state();
        st.now_ms = 1;
        let id = 4243u64;
        st.xfers.insert(id, XferIn { kind: "mute-list".into(), ..Default::default() });
        let line = "2 66666666-6666-6666-6666-666666666666 Spammy Object|0\n";
        let mut first = (line.len() as u32).to_be_bytes().to_vec();
        first.extend_from_slice(line.as_bytes());
        route(&mut st, &json!({
            "name": "SendXferPacket",
            "blocks": {
                "XferID": [{ "ID": id.to_string(), "Packet": 0x8000_0000u32 }],
                "DataPacket": [{ "Data": B64.encode(&first) }],
            },
        }));
        assert!(st.is_muted("66666666-6666-6666-6666-666666666666"));
        assert!(!st.is_muted("77777777-7777-7777-7777-777777777777"));
    }

    #[test]
    fn group_name_reply_is_surfaced() {
        let mut st = SessionState::default();
        let actions = route(&mut st, &json!({
            "name": "UUIDGroupNameReply",
            "blocks": { "UUIDNameBlock": [
                { "ID": "cccccccc-0000-0000-0000-000000000001", "GroupName": B64.encode(b"Beekeepers\0") },
                { "ID": "00000000-0000-0000-0000-000000000000", "GroupName": B64.encode(b"nobody\0") },
            ] },
        }));
        let groups = emit_of(&actions, "group-names").expect("group-names")["groups"]
            .as_array()
            .cloned()
            .unwrap();
        assert_eq!(groups.len(), 1, "the null key isn't a group");
        assert_eq!(groups[0]["name"], "Beekeepers");
        assert_eq!(groups[0]["id"], "cccccccc-0000-0000-0000-000000000001");
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

    #[test]
    fn coarse_unknown_z_does_not_poison_high_altitude() {
        let mut st = SessionState {
            agent_id: "me".into(),
            last_pos: Some([128.0, 235.0, 2099.0]),
            ..Default::default()
        };
        let pkt = json!({
            "name": "CoarseLocationUpdate",
            "blocks": {
                "Location": [ { "X": 128, "Y": 235, "Z": 255 } ],
                "Index": [ { "You": 0, "Prey": -1 } ],
                "AgentData": [ { "AgentID": "me" } ],
            }
        });
        let a = route(&mut st, &pkt);
        assert!(emit_of(&a, "position").is_none(), "unknown coarse Z should not move us");
        assert_eq!(st.last_pos, Some([128.0, 235.0, 2099.0]));
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
    fn inventory_offer_from_resident_prompts() {
        let mut st = me_state();
        let tx = "33333333-3333-3333-3333-333333333333";
        let a = route(&mut st, &im_packet(4, OTHER, ME, false, tx, "Blue Hat", ""));
        assert!(emit_of(&a, "im").is_none(), "an offer is a prompt, not a plain IM");
        let e = emit_of(&a, "event").expect("interactive prompt");
        assert_eq!(e["kind"], "interactive-prompt");
        assert_eq!(e["prompt"]["type"], "inventory-offer");
        assert_eq!(e["prompt"]["fromTask"], false);
        assert_eq!(e["prompt"]["itemName"], "Blue Hat");
        assert_eq!(e["prompt"]["transactionId"], tx);
        assert_eq!(e["prompt"]["resolved"], false);
    }

    #[test]
    fn inventory_offer_from_object_strips_location_blob() {
        let mut st = me_state();
        let tx = "33333333-3333-3333-3333-333333333333";
        // Task offers arrive as "'Item'  ( http://slurl.com/... )" and the
        // location used to leak into the visible message.
        let a = route(&mut st, &im_packet(
            9, OTHER, ME, false, tx,
            "'Free Gift'  ( http://slurl.com/secondlife/Natoma/128/128/25 )", "",
        ));
        let e = emit_of(&a, "event").expect("interactive prompt");
        assert_eq!(e["prompt"]["type"], "inventory-offer");
        assert_eq!(e["prompt"]["fromTask"], true);
        assert_eq!(e["prompt"]["itemName"], "Free Gift");
        let text = e["text"].as_str().unwrap();
        assert!(!text.contains("slurl.com"), "the location blob must not leak: {text}");
    }

    #[test]
    fn offer_item_name_variants() {
        assert_eq!(offer_item_name("Blue Hat"), "Blue Hat");
        assert_eq!(offer_item_name("'Free Gift'  ( http://slurl.com/secondlife/Natoma/128/128/25 )"), "Free Gift");
        assert_eq!(offer_item_name("'Free Gift'(http://slurl.com/secondlife/A/1/2/3)"), "Free Gift");
        assert_eq!(offer_item_name("Landmark thing\nhttp://maps.secondlife.com/x"), "Landmark thing");
        assert_eq!(offer_item_name("  'Quoted'  "), "Quoted");
        assert_eq!(offer_item_name(""), "");
    }

    #[test]
    fn split_notice_text_variants() {
        assert_eq!(split_notice_text("Meeting tonight|Bring snacks."),
            ("Meeting tonight".into(), "Bring snacks.".into()));
        assert_eq!(split_notice_text("No subject separator here"),
            (String::new(), "No subject separator here".into()));
        assert_eq!(split_notice_text("Subject|Body|with|pipes"),
            ("Subject".into(), "Body|with|pipes".into()));
        assert_eq!(split_notice_text(""), (String::new(), String::new()));
    }

    #[test]
    fn group_notice_bucket_parses_attachment_and_group() {
        let mut raw = vec![1u8, 6u8]; // has attachment, asset type object
        raw.extend_from_slice(&[0xAA; 16]);
        raw.extend_from_slice(b"Free Hat\0");
        let (has, group, item) = parse_group_notice_bucket(&raw);
        assert!(has);
        assert_eq!(group, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        assert_eq!(item, "Free Hat");
        // No attachment, no name.
        let mut raw2 = vec![0u8, 0u8];
        raw2.extend_from_slice(&[0xBB; 16]);
        let (has2, group2, item2) = parse_group_notice_bucket(&raw2);
        assert!(!has2);
        assert_eq!(group2, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
        assert_eq!(item2, "");
        // Too short to mean anything.
        assert_eq!(parse_group_notice_bucket(&[1, 6]), (false, String::new(), String::new()));
    }

    #[test]
    fn group_notice_becomes_event_card_with_attachment_prompt() {
        let mut st = me_state();
        let tx = "33333333-3333-3333-3333-333333333333";
        let mut bucket = vec![1u8, 6u8];
        bucket.extend_from_slice(&[0xAA; 16]);
        bucket.extend_from_slice(b"Free Hat\0");
        let pkt = json!({
            "name": "ImprovedInstantMessage",
            "blocks": {
                "AgentData": [{ "AgentID": OTHER, "SessionID": "s" }],
                "MessageBlock": [{
                    "FromGroup": true, "ToAgentID": ME, "Offline": 0, "Dialog": 32,
                    "ID": tx, "Timestamp": 0,
                    "FromAgentName": B64.encode(b"Pantera\0"),
                    "Message": B64.encode(b"Meeting|Bring snacks.\0"),
                    "BinaryBucket": B64.encode(&bucket),
                }]
            }
        });
        let a = route(&mut st, &pkt);
        assert!(emit_of(&a, "im").is_none(), "a notice is an event card, not a group IM");
        let e = emit_of(&a, "event").expect("group-notice event");
        assert_eq!(e["kind"], "group-notice");
        assert_eq!(e["subject"], "Meeting");
        assert_eq!(e["text"], "Bring snacks.");
        assert_eq!(e["fromName"], "Pantera");
        assert_eq!(e["groupId"], "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        assert_eq!(e["prompt"]["type"], "group-notice-attachment");
        assert_eq!(e["prompt"]["itemName"], "Free Hat");
        assert_eq!(e["prompt"]["transactionId"], tx);
        // The reply must go to the group, so that's the prompt's target.
        assert_eq!(e["prompt"]["fromId"], "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        // A replay of the same notice (offline + online delivery) is dropped.
        assert!(route(&mut st, &pkt).is_empty(), "duplicate notice must not repeat");
    }

    #[test]
    fn group_notice_without_attachment_has_no_prompt() {
        let mut st = me_state();
        let mut bucket = vec![0u8, 0u8];
        bucket.extend_from_slice(&[0xAA; 16]);
        let pkt = json!({
            "name": "ImprovedInstantMessage",
            "blocks": {
                "AgentData": [{ "AgentID": OTHER, "SessionID": "s" }],
                "MessageBlock": [{
                    "FromGroup": true, "ToAgentID": ME, "Offline": 0, "Dialog": 37,
                    "ID": "44444444-4444-4444-4444-444444444444", "Timestamp": 0,
                    "FromAgentName": B64.encode(b"Pantera\0"),
                    "Message": B64.encode(b"Just a note\0"),
                    "BinaryBucket": B64.encode(&bucket),
                }]
            }
        });
        let a = route(&mut st, &pkt);
        let e = emit_of(&a, "event").expect("group-notice event");
        assert_eq!(e["subject"], "");
        assert_eq!(e["text"], "Just a note");
        assert!(e.get("prompt").is_none(), "no attachment, no Keep/Discard buttons");
    }

    #[test]
    fn inventory_offer_replies_become_system_chat() {
        let mut st = me_state();
        let a = route(&mut st, &im_packet(5, OTHER, ME, false, "0", "", ""));
        let p = emit_of(&a, "chat").expect("accepted notice");
        assert!(p["text"].as_str().unwrap().contains("accepted"));
        let a = route(&mut st, &im_packet(6, OTHER, ME, false, "0", "", ""));
        let p = emit_of(&a, "chat").expect("declined notice");
        assert!(p["text"].as_str().unwrap().contains("declined"));
    }

    #[test]
    fn repeated_p2p_im_is_never_deduped() {
        let mut st = me_state();
        let pkt = im_packet(0, OTHER, ME, false, "0", "ok", "");
        assert!(emit_of(&route(&mut st, &pkt), "im").is_some());
        st.now_ms = 1500;
        // Saying "ok" twice is two messages: wire resends are filtered at the
        // circuit, and plain IMs have no double-delivery path to dedup.
        assert!(emit_of(&route(&mut st, &pkt), "im").is_some());
    }

    #[test]
    fn session_im_dedup_within_window() {
        let mut st = me_state();
        // Session chat double-delivers (EventQueue + UDP dialog 17), so the
        // same line arriving twice back-to-back is one message.
        let pkt = im_packet(17, OTHER, "00000000-0000-0000-0000-000000000000", true,
            "44444444-4444-4444-4444-444444444444", "hi group", "Explorers");
        assert!(emit_of(&route(&mut st, &pkt), "im").is_some());
        st.now_ms = 1500; // still inside 1000 + 1500
        assert!(emit_of(&route(&mut st, &pkt), "im").is_none());
        st.now_ms = 3000; // the window has elapsed - a genuine repeat
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
        // A successful join must also re-request our group data, otherwise the
        // freshly joined group keeps offering its "Join" button.
        assert!(join.iter().any(|x| matches!(x, Action::Send { name, .. } if name == "AgentDataUpdateRequest")));

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
    fn movement_complete_seeds_region_grid_from_handle() {
        // The login region's grid spot comes from nowhere else: the EventQueue
        // only names it on the FIRST teleport/crossing, so radar teleports and
        // map placement in the login region depend on this handle.
        let mut st = SessionState::default();
        let handle = ((1000u64 * 256) << 32) | (2000u64 * 256);
        let pkt = json!({
            "name": "AgentMovementComplete",
            "blocks": { "Data": [{ "Position": [10.0, 20.0, 30.0], "LookAt": [1.0, 0.0, 0.0], "RegionHandle": handle.to_string(), "Timestamp": 0 }] }
        });
        let a = route(&mut st, &pkt);
        assert_eq!(st.region_grid_x, 1000);
        assert_eq!(st.region_grid_y, 2000);
        let p = emit_of(&a, "position").unwrap();
        assert_eq!(p["region"]["gridX"], 1000);
        assert_eq!(p["region"]["gridY"], 2000);
        // Garbage handles must not fake a location (0 is "not yet known").
        assert_eq!(wire_region_grid("1"), None);
        assert_eq!(wire_region_grid(""), None);
        assert_eq!(wire_region_grid("junk"), None);
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
        // The parcel is requested for where we actually landed, snapped to the
        // sim's 4m grid - not the region centre the login response suggests.
        let parcel_req = a.iter().find_map(|x| match x {
            Action::Send { name, blocks, .. } if name == "ParcelPropertiesRequest" => Some(blocks),
            _ => None,
        }).expect("parcel request");
        assert_eq!(parcel_req["ParcelData"][0]["West"], 0.0);
        assert_eq!(parcel_req["ParcelData"][0]["South"], 0.0);
        assert_eq!(parcel_req["ParcelData"][0]["East"], 4.0);
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
    fn a_recorded_destination_labels_only_its_own_teleport() {
        let mut st = SessionState { sim_ip: "1.1.1.1".into(), sim_port: 13000, ..Default::default() };
        // A map teleport recorded where we asked to go.
        st.tp_target = Some(json!({ "regionName": "Aurora", "gridX": 1000, "gridY": 2000 }));
        let pkt = |port: u16| json!({
            "name": "TeleportFinish",
            "blocks": { "Info": [{ "SimIP": "2.2.2.2", "SimPort": port, "RegionHandle": "1", "SeedCapability": B64.encode(b"\0"), "TeleportFlags": 0 }] }
        });
        let a = route(&mut st, &pkt(13001));
        let fin = emit_of(&a, "teleport-finish").expect("arrival");
        assert_eq!(fin["regionName"], "Aurora", "our own trip carries its name");
        assert!(st.tp_target.is_none(), "the destination is consumed by its arrival");
        // Teleporting HOME next records no target of its own: the previous
        // trip's name must not label the arrival (the map falls back to its
        // own region cache and the handshake supplies the real name).
        let a = route(&mut st, &pkt(13002));
        let fin = emit_of(&a, "teleport-finish").expect("home arrival");
        assert!(fin.get("regionName").is_none(), "a landmark arrival got a stale name: {fin}");
    }

    #[test]
    fn a_failed_or_local_teleport_drops_the_recorded_destination() {
        let mut st = SessionState::default();
        st.tp_target = Some(json!({ "regionName": "Aurora" }));
        route(&mut st, &json!({ "name": "TeleportFailed", "blocks": { "Info": [{ "AgentID": "x", "Reason": B64.encode(b"Region full\0") }] } }));
        assert!(st.tp_target.is_none(), "a failed trip must not label the next one");
        st.tp_target = Some(json!({ "regionName": "Aurora" }));
        route(&mut st, &json!({ "name": "TeleportLocal", "blocks": { "Info": [{
            "AgentID": "x", "LocationID": 1, "Position": [20.0, 30.0, 40.0],
            "LookAt": [0.0, 0.0, 0.0], "TeleportFlags": 0,
        }] } }));
        assert!(st.tp_target.is_none());
    }

    #[test]
    fn avatar_notes_reply_yields_only_once_the_cap_has_answered() {
        let pkt = json!({
            "name": "AvatarNotesReply",
            "blocks": {
                "AgentData": [{ "AgentID": "me" }],
                "Data": [{ "TargetID": OTHER, "Notes": B64.encode(b"\0") }],
            }
        });
        // Once the cap has actually delivered notes for this resident it is the
        // authority: the legacy reply can arrive afterwards carrying an empty
        // string, and applying it would blank what the cap gave us.
        let mut answered = SessionState::default();
        answered.caps.insert("AgentProfile".into(), "https://x/cap".into());
        answered.cap_notes.insert(OTHER.to_ascii_lowercase());
        assert!(
            emit_of(&route(&mut answered, &pkt), "avatar-notes").is_none(),
            "the legacy reply must not overwrite cap-sourced notes"
        );

        // The cap existing is NOT enough. Plenty of replies carry no `notes` key
        // at all, and suppressing on mere capability presence left the field
        // stuck on "Loading notes" forever - so this must still emit, empty
        // included, because it is the only answer the UI will ever get.
        let mut cap_but_silent = SessionState::default();
        cap_but_silent.caps.insert("AgentProfile".into(), "https://x/cap".into());
        let a = route(&mut cap_but_silent, &pkt);
        let e = emit_of(&a, "avatar-notes").expect("notes when the cap carried none");
        assert_eq!(e["targetId"], OTHER);
        assert_eq!(e["notes"], "", "an empty answer still has to resolve the field");

        // A different resident's cap delivery must not silence this one.
        let mut other_answered = SessionState::default();
        other_answered.caps.insert("AgentProfile".into(), "https://x/cap".into());
        other_answered.cap_notes.insert("11111111-2222-3333-4444-555555555555".into());
        assert!(
            emit_of(&route(&mut other_answered, &pkt), "avatar-notes").is_some(),
            "the suppression is per resident, not global"
        );

        // A capless grid (OpenSim) has no other source, so it still applies.
        let mut capless = SessionState::default();
        let real = json!({
            "name": "AvatarNotesReply",
            "blocks": {
                "AgentData": [{ "AgentID": "me" }],
                "Data": [{ "TargetID": OTHER, "Notes": B64.encode(b"remember the hat\0") }],
            }
        });
        let a = route(&mut capless, &real);
        let e = emit_of(&a, "avatar-notes").expect("notes on a capless grid");
        assert_eq!(e["targetId"], OTHER);
        assert_eq!(e["notes"], "remember the hat");
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
    fn parcel_event_round_trips_exact_landing_and_region() {
        // The save path re-sends UserLocation/UserLookAt verbatim; the parcel
        // event must therefore carry the EXACT vectors (the rounded
        // landingPoint is display-only) plus the region the data belongs to.
        let mut st = SessionState {
            agent_id: "owner-1".into(),
            region_id: "33333333-3333-3333-3333-333333333333".into(),
            ..Default::default()
        };
        let pkt = json!({
            "name": "ParcelProperties",
            "blocks": { "ParcelData": [{
                "RequestResult": 0, "LocalID": 5, "OwnerID": "owner-1", "IsGroupOwned": false,
                "Area": 512, "ParcelFlags": 0, "SalePrice": 0,
                "Name": B64.encode(b"Lot\0"), "Desc": B64.encode(b"\0"),
                "MusicURL": B64.encode(b"\0"), "MediaURL": B64.encode(b"\0"),
                "MediaID": "00000000-0000-0000-0000-000000000000",
                "GroupID": "00000000-0000-0000-0000-000000000000",
                "SnapshotID": "00000000-0000-0000-0000-000000000000",
                "AuthBuyerID": "00000000-0000-0000-0000-000000000000",
                "MaxPrims": 100, "ParcelPrimBonus": 1.0,
                "OwnerPrims": 0, "GroupPrims": 0, "OtherPrims": 0, "SelectedPrims": 0,
                "UserLocation": [10.5, 20.25, 30.75], "UserLookAt": [0.0, 0.0, 0.0],
                "LandingType": 1,
                "PassPrice": 0, "PassHours": 0.0, "Category": 0, "MediaAutoScale": 0,
            }] }
        });
        let a = route(&mut st, &pkt);
        let p = emit_of(&a, "parcel").expect("parcel");
        // Display fields round, wire fields don't.
        assert_eq!(p["landingPoint"]["x"], 11.0);
        assert_eq!(p["userLocation"]["x"], 10.5);
        assert_eq!(p["userLocation"]["y"], 20.25);
        assert_eq!(p["userLocation"]["z"], 30.75);
        // "No look-at set" must survive as exactly (0,0,0), not a made-up heading.
        assert_eq!(p["userLookAt"]["x"], 0.0);
        assert_eq!(p["userLookAt"]["y"], 0.0);
        assert_eq!(p["regionId"], "33333333-3333-3333-3333-333333333333");
    }

    fn minimal_parcel_pkt(seq: i64, local_id: i64, name: &str, aabb: Option<([f64; 3], [f64; 3])>) -> Value {
        let mut pd = json!({
            "RequestResult": 0, "SequenceID": seq, "LocalID": local_id,
            "OwnerID": "owner-1", "IsGroupOwned": false,
            "Area": 512, "ParcelFlags": 0, "SalePrice": 0,
            "Name": B64.encode(format!("{name}\0").as_bytes()), "Desc": B64.encode(b"\0"),
            "MusicURL": B64.encode(b"\0"), "MediaURL": B64.encode(b"\0"),
            "MediaID": "00000000-0000-0000-0000-000000000000",
            "GroupID": "00000000-0000-0000-0000-000000000000",
            "SnapshotID": "00000000-0000-0000-0000-000000000000",
            "AuthBuyerID": "00000000-0000-0000-0000-000000000000",
            "MaxPrims": 100, "ParcelPrimBonus": 1.0,
            "OwnerPrims": 0, "GroupPrims": 0, "OtherPrims": 0, "SelectedPrims": 0,
            "UserLocation": [0.0, 0.0, 0.0], "LandingType": 0,
            "PassPrice": 0, "PassHours": 0.0, "Category": 0, "MediaAutoScale": 0,
        });
        if let Some((min, max)) = aabb {
            pd["AABBMin"] = json!([min[0], min[1], min[2]]);
            pd["AABBMax"] = json!([max[0], max[1], max[2]]);
        }
        json!({ "name": "ParcelProperties", "blocks": { "ParcelData": [pd] } })
    }

    #[test]
    fn fold_parcel_flags_new_option_bits() {
        // Terraform 1<<4, entry all 1<<27, entry group 1<<28, deed 1<<13,
        // deny-anon 1<<22, deny-unverified 1<<31, group access 1<<8,
        // access list 1<<9, ban list 1<<10.
        let folded = fold_parcel_flags(0, &json!({
            "allowTerraform": true, "allowObjectEntryAll": true, "allowObjectEntryGroup": true,
            "allowDeedToGroup": true, "denyAnonymous": true, "denyAgeUnverified": true,
            "useAccessGroup": true, "useAccessList": false,
        }));
        assert_ne!(folded & (1 << 4), 0);
        assert_ne!(folded & (1 << 27), 0);
        assert_ne!(folded & (1 << 28), 0);
        assert_ne!(folded & (1 << 13), 0);
        assert_ne!(folded & (1 << 22), 0);
        assert_ne!(folded & (1u32 << 31), 0);
        assert_ne!(folded & (1 << 8), 0);
        assert_eq!(folded & (1 << 9), 0, "public access clears the access-list bit");
        assert_ne!(folded & (1 << 10), 0, "an access save always forces the ban list on");
        // Bits the payload doesn't mention survive the fold untouched.
        let keep = fold_parcel_flags(1 << 17, &json!({ "allowTerraform": false }));
        assert_ne!(keep & (1 << 17), 0);
        assert_eq!(keep & (1 << 4), 0);
        assert_eq!(keep & (1 << 10), 0, "no access keys, no forced ban bit");
    }

    #[test]
    fn parcel_snapshot_feeds_the_money_guards() {
        let mut st = SessionState {
            agent_id: "owner-1".into(),
            region_id: "33333333-3333-3333-3333-333333333333".into(),
            ..Default::default()
        };
        // PF_FOR_SALE (4) | PF_USE_PASS_LIST (2048)
        let mut pkt = minimal_parcel_pkt(0, 7, "Sale Lot", None);
        pkt["blocks"]["ParcelData"][0]["ParcelFlags"] = json!(4 + 2048);
        pkt["blocks"]["ParcelData"][0]["SalePrice"] = json!(1500);
        pkt["blocks"]["ParcelData"][0]["PassPrice"] = json!(25);
        route(&mut st, &pkt);
        let snap = st.parcel_snapshot.as_ref().expect("snapshot");
        assert_eq!(snap.local_id, 7);
        assert_eq!(snap.sale_price, 1500);
        assert_eq!(snap.area, 512);
        assert!(snap.for_sale);
        assert!(snap.sell_passes);
        assert_eq!(snap.pass_price, 25);
        assert_eq!(snap.region_id, "33333333-3333-3333-3333-333333333333");
        assert_eq!(snap.owner_id, "owner-1");
    }

    #[test]
    fn covenant_reply_and_text_assembly() {
        let mut st = SessionState::default();
        let a = route(&mut st, &json!({
            "name": "EstateCovenantReply",
            "blocks": { "Data": [{
                "CovenantID": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "CovenantTimestamp": 1700000000i64,
                "EstateName": B64.encode(b"Bee Estate\0"),
                "EstateOwnerID": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            }] }
        }));
        let c = emit_of(&a, "covenant").expect("covenant event");
        assert_eq!(c["estateName"], "Bee Estate");
        assert_eq!(c["covenantId"], "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

        // The text arrives as transfer packets, possibly out of order.
        st.covenant_xfer = Some(("77777777-7777-7777-7777-777777777777".into(), BTreeMap::new()));
        let note = b"Linden text version 2\n{\nText length 8\nBe kind.}";
        let (head, tail) = note.split_at(20);
        let pkt = |n: i64, status: i64, data: &[u8]| json!({
            "name": "TransferPacket",
            "blocks": { "TransferData": [{
                "TransferID": "77777777-7777-7777-7777-777777777777",
                "ChannelType": 2, "Packet": n, "Status": status,
                "Data": B64.encode(data),
            }] }
        });
        // Final packet first: it must not emit until packet 0 lands... the
        // sim marks DONE on the LAST packet it sends, so deliver in order for
        // the done check but verify assembly uses packet numbers.
        assert!(route(&mut st, &pkt(0, 0, head)).is_empty());
        let done = route(&mut st, &pkt(1, 1, tail));
        let t = emit_of(&done, "covenant-text").expect("covenant text");
        assert_eq!(t["ok"], true);
        assert_eq!(t["text"], "Be kind.");
        assert!(st.covenant_xfer.is_none(), "transfer state cleared");

        // A refused transfer reports instead of hanging.
        st.covenant_xfer = Some(("88888888-8888-8888-8888-888888888888".into(), BTreeMap::new()));
        let fail = route(&mut st, &json!({
            "name": "TransferInfo",
            "blocks": { "TransferInfo": [{
                "TransferID": "88888888-8888-8888-8888-888888888888",
                "ChannelType": 2, "TargetType": 0, "Status": -2, "Size": 0,
                "Params": B64.encode(b""),
            }] }
        }));
        let e = emit_of(&fail, "covenant-text").expect("failure event");
        assert_eq!(e["ok"], false);
    }

    #[test]
    fn notecard_text_unwraps_the_envelope() {
        assert_eq!(notecard_text(b"Linden text version 2\n{\nText length 5\nHello}"), "Hello");
        assert_eq!(notecard_text(b"plain covenant text"), "plain covenant text");
        assert_eq!(notecard_text(b""), "");
        // A length larger than the body must not panic.
        assert_eq!(notecard_text(b"Linden text version 2\n{\nText length 999\nabc"), "abc");
    }

    #[test]
    fn access_list_replies_accumulate_per_kind() {
        let mut st = SessionState::default();
        let reply = |flags: u32, ids: &[&str]| json!({
            "name": "ParcelAccessListReply",
            "blocks": {
                "Data": [{ "AgentID": "me", "SequenceID": 0, "Flags": flags, "LocalID": 7 }],
                "List": ids.iter().map(|id| json!({ "ID": id, "Time": 0, "Flags": 0 })).collect::<Vec<_>>(),
            }
        });
        let a1 = route(&mut st, &reply(1, &["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"]));
        let p1 = emit_of(&a1, "parcel-access").unwrap();
        assert_eq!(p1["flags"], 1);
        assert_eq!(p1["entries"].as_array().unwrap().len(), 1);
        // A second page of the same list appends; a duplicate id does not.
        let a2 = route(&mut st, &reply(1, &[
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2",
        ]));
        let p2 = emit_of(&a2, "parcel-access").unwrap();
        assert_eq!(p2["entries"].as_array().unwrap().len(), 2);
        // The ban list accumulates separately.
        let a3 = route(&mut st, &reply(2, &["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1"]));
        let p3 = emit_of(&a3, "parcel-access").unwrap();
        assert_eq!(p3["flags"], 2);
        assert_eq!(p3["entries"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn object_owners_reply_resolves_names_and_maps_fields() {
        let mut st = SessionState::default();
        let a = route(&mut st, &json!({
            "name": "ParcelObjectOwnersReply",
            "blocks": { "Data": [
                { "OwnerID": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", "IsGroupOwned": false, "Count": 12, "OnlineStatus": true },
                { "OwnerID": "00000000-0000-0000-0000-000000000000", "IsGroupOwned": false, "Count": 1, "OnlineStatus": false },
            ] }
        }));
        let p = emit_of(&a, "parcel-object-owners").expect("owners");
        let owners = p["owners"].as_array().unwrap();
        assert_eq!(owners.len(), 1, "the null-owner row is skipped");
        assert_eq!(owners[0]["count"], 12);
        assert!(a.iter().any(|x| matches!(x, Action::ResolveNames(_))));
    }

    #[test]
    fn region_handshake_carries_product_and_covenant_clauses() {
        let mut st = SessionState {
            agent_id: "me".into(),
            session_uuid: "s".into(),
            ..Default::default()
        };
        let pkt = json!({
            "name": "RegionHandshake",
            "blocks": {
                "RegionInfo": [{ "SimName": B64.encode(b"Natoma\0"), "SimAccess": 21, "RegionFlags": 0 }],
                "RegionInfo2": [{ "RegionID": "33333333-3333-3333-3333-333333333333" }],
                "RegionInfo3": [{ "ProductName": B64.encode(b"Estate / Full Region\0"), "ColoName": B64.encode(b"\0"), "ProductSKU": B64.encode(b"\0"), "CPUClassID": 0, "CPURatio": 0 }],
                "RegionInfo4": [{ "RegionFlagsExtended": "128", "RegionProtocols": "0" }],
            }
        });
        let a = route(&mut st, &pkt);
        assert_eq!(st.region_product, "Estate / Full Region");
        let r = emit_of(&a, "region").expect("region");
        assert_eq!(r["productName"], "Estate / Full Region");
        // Bit 7 (128) = block land resell.
        assert_eq!(r["blockLandResell"], true);
        assert_eq!(r["allowParcelChanges"], false);
    }

    #[test]
    fn parcel_out_of_order_pushes_are_dropped() {
        let mut st = SessionState { agent_id: "owner-1".into(), ..Default::default() };
        assert!(emit_of(&route(&mut st, &minimal_parcel_pkt(5, 1, "A", None)), "parcel").is_some());
        // A late push from before the one we already applied: stale, dropped.
        assert!(emit_of(&route(&mut st, &minimal_parcel_pkt(3, 2, "B", None)), "parcel").is_none());
        // The next one in order goes through.
        assert!(emit_of(&route(&mut st, &minimal_parcel_pkt(6, 3, "C", None)), "parcel").is_some());
    }

    #[test]
    fn parcel_reply_for_somewhere_else_is_dropped() {
        // We stand at (200, 200); a reply describing a parcel spanning only the
        // region's other corner is an answer to a stale (placeholder) request.
        let mut st = SessionState { agent_id: "owner-1".into(), last_pos: Some([200.0, 200.0, 25.0]), ..Default::default() };
        let stale = minimal_parcel_pkt(-50000, 1, "Wrong", Some(([100.0, 100.0, 0.0], [160.0, 160.0, 0.0])));
        assert!(emit_of(&route(&mut st, &stale), "parcel").is_none());
        // The parcel we actually stand on is accepted.
        let right = minimal_parcel_pkt(-50000, 2, "Right", Some(([196.0, 196.0, 0.0], [256.0, 256.0, 0.0])));
        assert!(emit_of(&route(&mut st, &right), "parcel").is_some());
        // No AABB in the packet (or no known position) means no gating.
        let mut st2 = SessionState { agent_id: "owner-1".into(), ..Default::default() };
        assert!(emit_of(&route(&mut st2, &minimal_parcel_pkt(-50000, 3, "NoBox", None)), "parcel").is_some());
    }

    #[test]
    fn identical_parcel_payloads_do_not_re_emit() {
        let mut st = SessionState { agent_id: "owner-1".into(), ..Default::default() };
        let pkt = minimal_parcel_pkt(0, 1, "Same", None);
        assert!(emit_of(&route(&mut st, &pkt), "parcel").is_some());
        assert!(emit_of(&route(&mut st, &pkt), "parcel").is_none(), "byte-identical repaint suppressed");
        // A real change (name) still comes through.
        let changed = minimal_parcel_pkt(0, 1, "Renamed", None);
        assert!(emit_of(&route(&mut st, &changed), "parcel").is_some());
    }

    #[test]
    fn coarse_self_position_rejects_zero_and_wild_jumps() {
        let me = "11111111-1111-1111-1111-111111111111";
        let mk = |x: i64, y: i64| {
            json!({
                "name": "CoarseLocationUpdate",
                "blocks": {
                    "Location": [{ "X": x, "Y": y, "Z": 10 }],
                    "AgentData": [{ "AgentID": me }],
                    "Index": { "You": 0, "Prey": -1 },
                }
            })
        };
        let mut st = SessionState { agent_id: me.into(), last_pos: Some([120.0, 120.0, 25.0]), ..Default::default() };
        // (0,0) is the sim's junk value around login/TP, never a real spot.
        assert!(emit_of(&route(&mut st, &mk(0, 0)), "position").is_none());
        assert_eq!(st.last_pos.unwrap()[0], 120.0, "position must be untouched");
        // A 200m coarse "jump" can't be genuine either.
        assert!(emit_of(&route(&mut st, &mk(20, 250)), "position").is_none());
        // A believable nearby move goes through.
        assert!(emit_of(&route(&mut st, &mk(125, 118)), "position").is_some());
        assert_eq!(st.last_pos.unwrap()[0], 125.0);
    }

    #[test]
    fn coarse_repairs_a_poisoned_position_after_two_agreeing_ticks() {
        let me = "11111111-1111-1111-1111-111111111111";
        let mk = |x: i64, y: i64| {
            json!({
                "name": "CoarseLocationUpdate",
                "blocks": {
                    "Location": [{ "X": x, "Y": y, "Z": 10 }],
                    "AgentData": [{ "AgentID": me }],
                    "Index": { "You": 0, "Prey": -1 },
                }
            })
        };
        // last_pos stuck near the region origin (a mis-framed update wrote a
        // seat offset). The radar is the only signal left that can re-anchor
        // a stationary avatar.
        let mut st = SessionState { agent_id: me.into(), last_pos: Some([0.0, 0.0, 1.0]), ..Default::default() };
        // The first far tick reads as noise...
        assert!(emit_of(&route(&mut st, &mk(197, 171)), "position").is_none());
        assert_eq!(st.last_pos.unwrap()[0], 0.0);
        // ...but the same spot twice running is the truth winning.
        assert!(emit_of(&route(&mut st, &mk(197, 171)), "position").is_some());
        assert_eq!(st.last_pos.unwrap()[0], 197.0);
        assert_eq!(st.last_pos.unwrap()[1], 171.0);
    }

    #[test]
    fn coarse_repair_needs_agreement_not_two_random_glitches() {
        let me = "11111111-1111-1111-1111-111111111111";
        let mk = |x: i64, y: i64| {
            json!({
                "name": "CoarseLocationUpdate",
                "blocks": {
                    "Location": [{ "X": x, "Y": y, "Z": 10 }],
                    "AgentData": [{ "AgentID": me }],
                    "Index": { "You": 0, "Prey": -1 },
                }
            })
        };
        let mut st = SessionState { agent_id: me.into(), last_pos: Some([120.0, 120.0, 25.0]), ..Default::default() };
        assert!(emit_of(&route(&mut st, &mk(20, 250)), "position").is_none());
        // A different far spot doesn't confirm the first one.
        assert!(emit_of(&route(&mut st, &mk(250, 20)), "position").is_none());
        assert_eq!(st.last_pos.unwrap()[0], 120.0, "two disagreeing glitches must not move us");
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
    fn pay_price_reply_follows_the_reference_sentinels() {
        let mut st = SessionState::default();
        let reply = |price: i64, buttons: Vec<i64>| {
            let blocks = json!({
                "ObjectData": [{ "ObjectID": "0b000000-0000-0000-0000-00000000000a", "DefaultPayPrice": price }],
                "ButtonData": buttons.iter().map(|b| json!({ "PayButton": b })).collect::<Vec<_>>(),
            });
            json!({ "name": "PayPriceReply", "blocks": blocks })
        };
        // PAY_PRICE_HIDE (-1): the object takes no payment.
        let a = route(&mut st, &reply(-1, vec![]));
        let p = emit_of(&a, "pay-price").unwrap();
        assert_eq!(p["payable"], false);
        assert_eq!(p["allowCustom"], false);

        // PAY_PRICE_DEFAULT (-2): payable, but it suggests nothing - this must NOT be
        // mistaken for "not payable", or tip jars become unusable.
        let b = route(&mut st, &reply(-2, vec![]));
        let p = emit_of(&b, "pay-price").unwrap();
        assert_eq!(p["payable"], true);
        assert_eq!(p["defaultPrice"], 0);
        assert_eq!(p["allowCustom"], true);

        // A negative non-sentinel is a real amount; take abs().
        let c = route(&mut st, &reply(-250, vec![]));
        assert_eq!(emit_of(&c, "pay-price").unwrap()["defaultPrice"], 250);

        // Buttons: positives only, capped at four.
        let d = route(&mut st, &reply(10, vec![5, 0, -3, 20, 30, 40, 50]));
        let p = emit_of(&d, "pay-price").unwrap();
        assert_eq!(p["defaultPrice"], 10);
        assert_eq!(p["suggested"], json!([5, 20, 30, 40]));
    }

    #[test]
    fn avatar_sit_response_marks_us_seated() {
        // Teleports rely on this flag to know they must stand us up first.
        let mut st = SessionState::default();
        assert!(!st.sitting);
        let a = route(&mut st, &json!({
            "name": "AvatarSitResponse",
            "blocks": {
                "SitObject": [{ "ID": "0bbe1f2c-0000-0000-0000-0000000000ff" }],
                "SitTransform": [{
                    "AutoPilot": false, "SitPosition": [0.0, 0.0, 0.5],
                    "SitRotation": [0.0, 0.0, 0.0, 1.0],
                    "CameraEyeOffset": [0.0, 0.0, 0.0], "CameraAtOffset": [0.0, 0.0, 0.0],
                    "ForceMouselook": false,
                }]
            }
        }));
        assert!(st.sitting);
        assert_eq!(st.sit_object, "0bbe1f2c-0000-0000-0000-0000000000ff");
        let ev = emit_of(&a, "sit-state").unwrap();
        assert_eq!(ev["sitting"], true);
        assert_eq!(ev["objectId"], "0bbe1f2c-0000-0000-0000-0000000000ff");
    }

    #[test]
    fn group_membership_accumulates_across_updates() {
        // The sim can describe our groups over several messages (and sends a
        // single-group update after a join). Each one must add to what we know,
        // never replace it, or groups vanish from the profile.
        let mut st = SessionState { agent_id: "me".into(), ..Default::default() };
        let update = |st: &mut SessionState, id: &str, name: &[u8], powers: &str| {
            route(st, &json!({
                "name": "AgentGroupDataUpdate",
                "blocks": {
                    "AgentData": [{ "AgentID": "me" }],
                    "GroupData": [{
                        "GroupID": id, "GroupName": B64.encode(name), "GroupPowers": powers,
                        "GroupInsigniaID": "00000000-0000-0000-0000-000000000000",
                        "AcceptNotices": true, "Contribution": 0,
                    }]
                }
            }))
        };
        let a = update(&mut st, "g0000000-0000-0000-0000-00000000000b", b"Bees\0", "0");
        assert_eq!(emit_of(&a, "group-membership").unwrap()["groups"].as_array().unwrap().len(), 1);

        // A second, separate update must leave the first group in place.
        let b = update(&mut st, "g0000000-0000-0000-0000-00000000000a", b"Ants\0", "262144");
        let groups = emit_of(&b, "group-membership").unwrap()["groups"].clone();
        let list = groups.as_array().unwrap();
        assert_eq!(list.len(), 2, "earlier group was dropped");
        assert_eq!(list[0]["name"], "Ants"); // sorted by name
        assert_eq!(list[1]["name"], "Bees");
        // Membership + powers stay in sync for parcel edit-gating.
        assert_eq!(st.groups.len(), 2);
        assert_eq!(st.group_powers.get("g0000000-0000-0000-0000-00000000000a"), Some(&(1 << 18)));

        // Since membership accumulates, AgentDropGroup is what removes one again.
        let d = route(&mut st, &json!({
            "name": "AgentDropGroup",
            "blocks": { "AgentData": [{ "AgentID": "me", "GroupID": "g0000000-0000-0000-0000-00000000000a" }] }
        }));
        let left = emit_of(&d, "group-membership").unwrap()["groups"].clone();
        assert_eq!(left.as_array().unwrap().len(), 1);
        assert_eq!(left[0]["name"], "Bees");
        assert!(!st.groups.contains("g0000000-0000-0000-0000-00000000000a"));
        assert!(st.group_powers.get("g0000000-0000-0000-0000-00000000000a").is_none());
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

    // --- directory search accumulation (the "32 results max" fix) ---

    fn people_packet(query_id: &str, ids: &[&str]) -> Value {
        let rows: Vec<Value> = ids
            .iter()
            .map(|id| {
                json!({
                    "AgentID": id,
                    "FirstName": B64.encode(b"Ann\0"), "LastName": B64.encode(b"Lee\0"),
                    "Group": B64.encode(b"\0"), "Online": false, "Reputation": 0
                })
            })
            .collect();
        json!({
            "name": "DirPeopleReply",
            "blocks": {
                "AgentData": [{ "AgentID": "me" }],
                "QueryData": [{ "QueryID": query_id }],
                "QueryReplies": rows,
            }
        })
    }

    #[test]
    fn dir_search_accumulates_across_packets() {
        // One query's answer arrives split over several UDP packets; every row
        // must land in the same per-query accumulator.
        let mut st = SessionState { now_ms: 1_000, ..Default::default() };
        route(&mut st, &people_packet("q1", &["p1", "p2"]));
        route(&mut st, &people_packet("q1", &["p3"]));
        let acc = st.dir_searches.get("q1").expect("accumulator");
        assert_eq!(acc.rows.len(), 3);
        assert_eq!(acc.last_ms, 1_000);
        // A different query accumulates separately.
        route(&mut st, &people_packet("q2", &["p9"]));
        assert_eq!(st.dir_searches.get("q1").unwrap().rows.len(), 3);
        assert_eq!(st.dir_searches.get("q2").unwrap().rows.len(), 1);
    }

    #[test]
    fn dir_search_skips_placeholder_rows_but_still_stamps_time() {
        // The sim pads empty results with a null-key row; it must not count.
        let mut st = SessionState { now_ms: 5_000, ..Default::default() };
        route(&mut st, &people_packet("q1", &["00000000-0000-0000-0000-000000000000"]));
        let acc = st.dir_searches.get("q1").expect("accumulator");
        assert_eq!(acc.rows.len(), 0);
        assert_eq!(acc.last_ms, 5_000, "idle detection needs the packet time even when empty");
    }

    #[test]
    fn dir_search_records_status_bits() {
        let mut st = SessionState { now_ms: 1, ..Default::default() };
        let pkt = json!({
            "name": "DirPlacesReply",
            "blocks": {
                "AgentData": [{ "AgentID": "me" }],
                "QueryData": [{ "QueryID": "q1" }],
                "QueryReplies": [],
                "StatusData": [{ "Status": 4u64 }], // STATUS_SEARCH_PLACES_FOUNDNONE
            }
        });
        route(&mut st, &pkt);
        assert_eq!(st.dir_searches.get("q1").unwrap().status, 4);
    }

    #[test]
    fn dir_search_caps_accumulated_rows() {
        let mut st = SessionState { now_ms: 1, ..Default::default() };
        let ids: Vec<String> = (0..120).map(|i| format!("{i:08}-0000-0000-0000-000000000001")).collect();
        let refs: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
        for _ in 0..12 {
            route(&mut st, &people_packet("q1", &refs));
        }
        assert_eq!(st.dir_searches.get("q1").unwrap().rows.len(), MAX_DIR_ROWS);
    }

    #[test]
    fn dir_search_prunes_stale_queries() {
        let mut st = SessionState { now_ms: 1_000, ..Default::default() };
        route(&mut st, &people_packet("old", &["p1"]));
        // Half a minute later an unrelated query arrives; the abandoned one goes.
        st.now_ms = 32_000;
        route(&mut st, &people_packet("new", &["p2"]));
        assert!(st.dir_searches.get("old").is_none(), "stale accumulators must be dropped");
        assert!(st.dir_searches.get("new").is_some());
    }

    #[test]
    fn dir_search_still_emits_per_packet_events() {
        // The accumulator is additive: the existing per-packet events stay.
        let mut st = SessionState::default();
        let a = route(&mut st, &people_packet("q1", &["p1"]));
        let p = emit_of(&a, "dir-people-reply").expect("event");
        assert_eq!(p["queryId"], "q1");
        assert_eq!(p["people"][0]["name"], "Ann Lee");
    }

    // --- transient animation handshake (the "about to land forever" fix) ---

    fn anim_packet(sender: &str, anims: &[&str]) -> Value {
        let list: Vec<Value> = anims.iter().map(|a| json!({ "AnimID": a, "AnimSequenceID": 1 })).collect();
        json!({
            "name": "AvatarAnimation",
            "blocks": { "Sender": [{ "ID": sender }], "AnimationList": list }
        })
    }

    #[test]
    fn own_transient_animation_requests_finish() {
        let me = "11111111-1111-1111-1111-111111111111";
        let mut st = SessionState { agent_id: me.into(), ..Default::default() };
        for anim in TRANSIENT_ANIMS {
            let actions = route(&mut st, &anim_packet(me, &[anim]));
            assert!(
                actions.iter().any(|a| matches!(a, Action::FinishAnim { .. })),
                "transient anim {anim} must schedule a FINISH_ANIM"
            );
        }
    }

    #[test]
    fn own_stand_animation_needs_no_finish() {
        let me = "11111111-1111-1111-1111-111111111111";
        let mut st = SessionState { agent_id: me.into(), ..Default::default() };
        let actions = route(&mut st, &anim_packet(me, &[ANIM_AGENT_STAND]));
        assert!(actions.is_empty(), "stand is steady-state, nothing to finish");
    }

    #[test]
    fn other_avatars_animations_are_ignored() {
        let mut st = SessionState { agent_id: "11111111-1111-1111-1111-111111111111".into(), ..Default::default() };
        let actions = route(
            &mut st,
            &anim_packet("22222222-2222-2222-2222-222222222222", &[TRANSIENT_ANIMS[0]]),
        );
        assert!(actions.is_empty(), "we only own our own animation state");
    }

    #[test]
    fn transient_anim_id_match_is_case_insensitive() {
        let me = "11111111-1111-1111-1111-111111111111";
        let mut st = SessionState { agent_id: me.into(), ..Default::default() };
        let upper = TRANSIENT_ANIMS[0].to_ascii_uppercase();
        let actions = route(&mut st, &anim_packet(me, &[upper.as_str()]));
        assert!(actions.iter().any(|a| matches!(a, Action::FinishAnim { .. })));
    }

    #[test]
    fn build_agent_animation_shapes_the_message() {
        let body = build_agent_animation("a", "s", ANIM_AGENT_STAND, true);
        assert_eq!(body["AgentData"][0]["AgentID"], "a");
        assert_eq!(body["AnimationList"][0]["AnimID"], ANIM_AGENT_STAND);
        assert_eq!(body["AnimationList"][0]["StartAnim"], true);
        assert!(body["PhysicalAvatarEventList"].as_array().unwrap().is_empty());
    }

    #[test]
    fn arrival_schedules_finish_anim_and_outfit_restore() {
        let mut st = SessionState {
            agent_id: "11111111-1111-1111-1111-111111111111".into(),
            session_uuid: "22222222-2222-2222-2222-222222222222".into(),
            ..Default::default()
        };
        let pkt = json!({
            "name": "AgentMovementComplete",
            "blocks": {
                "AgentData": [{ "AgentID": st.agent_id, "SessionID": st.session_uuid }],
                "Data": [{ "Position": [128.0, 128.0, 25.0], "LookAt": [1.0, 0.0, 0.0], "RegionHandle": "0", "Timestamp": 0 }],
            }
        });
        let actions = route(&mut st, &pkt);
        assert!(actions.iter().any(|a| matches!(a, Action::FinishAnim { .. })),
            "the landing clip needs finishing even if its AvatarAnimation packet drops");
        assert!(actions.iter().any(|a| matches!(a, Action::RestoreOutfit { .. })),
            "arrival must schedule the outfit reconciliation");
    }

    // --- sit failure detection ---

    #[test]
    fn sit_failure_texts_cover_the_known_ids() {
        for id in [
            "CantSitNoRoom",
            "CantSitNoSuitableSurface",
            "SitFailCantMove",
            "SitFailNotAllowedOnLand",
            "SitFailNotSameRegion",
        ] {
            assert!(sit_failure_text(id).is_some(), "{id} must map to a friendly reason");
        }
        assert!(sit_failure_text("SomethingElse").is_none());
        assert!(sit_failure_text("").is_none());
    }

    fn alert_packet(alert_data: &str, info_id: &str) -> Value {
        let mut blocks = json!({
            "AlertData": [{ "Message": B64.encode(format!("{alert_data}\0").as_bytes()) }],
        });
        if !info_id.is_empty() {
            blocks["AlertInfo"] = json!([{
                "Message": B64.encode(format!("{info_id}\0").as_bytes()),
                "ExtraParams": B64.encode(b"\0"),
            }]);
        }
        json!({ "name": "AlertMessage", "blocks": blocks })
    }

    #[test]
    fn sit_refusal_via_alert_info_clears_pending_and_reports() {
        let mut st = SessionState { sit_pending: true, ..Default::default() };
        let actions = route(&mut st, &alert_packet("", "CantSitNoRoom"));
        assert!(!st.sit_pending);
        let sit = emit_of(&actions, "sit-state").expect("sit-state");
        assert_eq!(sit["sitting"], false);
        assert!(sit["error"].as_str().unwrap().contains("No room"));
        let chat = emit_of(&actions, "chat").expect("chat line");
        assert!(chat["text"].as_str().unwrap().contains("No room"));
    }

    #[test]
    fn sit_refusal_via_legacy_notify_prefix() {
        let mut st = SessionState { sit_pending: true, ..Default::default() };
        let actions = route(&mut st, &alert_packet("NOTIFY: SitFailNotAllowedOnLand", ""));
        assert!(!st.sit_pending);
        let sit = emit_of(&actions, "sit-state").expect("sit-state");
        assert_eq!(sit["sitting"], false);
        assert!(sit["error"].as_str().unwrap().contains("not allowed"));
    }

    #[test]
    fn unrelated_alert_keeps_sit_pending_and_shows_raw_text() {
        let mut st = SessionState { sit_pending: true, ..Default::default() };
        let actions = route(&mut st, &alert_packet("Region restart in 5 minutes.", ""));
        assert!(st.sit_pending, "a generic alert is not a sit verdict");
        assert!(emit_of(&actions, "sit-state").is_none());
        let chat = emit_of(&actions, "chat").expect("chat line");
        assert_eq!(chat["text"], "Region restart in 5 minutes.");
    }

    #[test]
    fn sit_refusal_without_pending_sit_only_chats() {
        // Someone else's script alert, or a stale refusal: no sit-state noise.
        let mut st = SessionState { sit_pending: false, ..Default::default() };
        let actions = route(&mut st, &alert_packet("", "CantSitNoRoom"));
        assert!(emit_of(&actions, "sit-state").is_none());
        assert!(emit_of(&actions, "chat").is_some(), "the friendly text still shows");
    }

    #[test]
    fn sit_approval_completes_handshake_with_agent_sit() {
        let mut st = SessionState {
            agent_id: "11111111-1111-1111-1111-111111111111".into(),
            session_uuid: "22222222-2222-2222-2222-222222222222".into(),
            sit_pending: true,
            ..Default::default()
        };
        let actions = route(&mut st, &json!({
            "name": "AvatarSitResponse",
            "blocks": {
                "SitObject": [{ "ID": "33333333-3333-3333-3333-333333333333" }],
                "SitTransform": [{ "AutoPilot": false, "SitPosition": [0.0,0.0,0.0], "SitRotation": [0.0,0.0,0.0,1.0],
                    "CameraEyeOffset": [0.0,0.0,0.0], "CameraAtOffset": [0.0,0.0,0.0], "ForceMouselook": false }],
            }
        }));
        assert!(st.sitting);
        assert!(!st.sit_pending);
        assert_eq!(st.sit_object, "33333333-3333-3333-3333-333333333333");
        let sent = actions.iter().find_map(|a| match a {
            Action::Send { name, blocks, reliable } if name == "AgentSit" => Some((blocks, reliable)),
            _ => None,
        });
        let (blocks, reliable) = sent.expect("AgentSit completes the two-phase sit");
        assert!(*reliable);
        assert_eq!(blocks["AgentData"][0]["AgentID"], st.agent_id);
        let sit = emit_of(&actions, "sit-state").expect("sit-state");
        assert_eq!(sit["sitting"], true);
    }

    #[test]
    fn region_restart_alert_raises_its_own_event() {
        let mut st = SessionState { region_name: "Natoma".into(), ..Default::default() };
        let extra = "<?xml version=\"1.0\"?><llsd><map><key>MINUTES</key><integer>5</integer><key>NAME</key><string>Natoma</string></map></llsd>";
        let pkt = json!({
            "name": "AlertMessage",
            "blocks": {
                "AlertData": [{ "Message": B64.encode(b"\0") }],
                "AlertInfo": [{
                    "Message": B64.encode(b"RegionRestartMinutes\0"),
                    "ExtraParams": B64.encode(format!("{extra}\0").as_bytes()),
                }],
            }
        });
        let actions = route(&mut st, &pkt);
        let e = emit_of(&actions, "region-restart").expect("region-restart event");
        assert_eq!(e["seconds"], 300);
        assert_eq!(e["regionName"], "Natoma");
        let chat = emit_of(&actions, "chat").expect("chat record");
        assert!(chat["text"].as_str().unwrap().contains("restart"));
    }

    #[test]
    fn region_restart_seconds_variant() {
        let mut st = SessionState { region_name: "Natoma".into(), ..Default::default() };
        let extra = "<?xml version=\"1.0\"?><llsd><map><key>SECONDS</key><integer>30</integer></map></llsd>";
        let pkt = json!({
            "name": "AlertMessage",
            "blocks": {
                "AlertData": [{ "Message": B64.encode(b"\0") }],
                "AlertInfo": [{
                    "Message": B64.encode(b"RegionRestartSeconds\0"),
                    "ExtraParams": B64.encode(format!("{extra}\0").as_bytes()),
                }],
            }
        });
        let actions = route(&mut st, &pkt);
        let e = emit_of(&actions, "region-restart").expect("region-restart event");
        assert_eq!(e["seconds"], 30);
        assert_eq!(e["regionName"], "Natoma", "falls back to the current region name");
    }

    // --- mute list transfer ---

    #[test]
    fn mute_list_update_requests_xfer_from_cache_path() {
        let mut st = SessionState {
            agent_id: "11111111-1111-1111-1111-111111111111".into(),
            now_ms: 42,
            ..Default::default()
        };
        let actions = route(&mut st, &json!({
            "name": "MuteListUpdate",
            "blocks": { "MuteData": [{ "Filename": B64.encode(b"mute_agent.tmp\0") }] }
        }));
        let req = actions.iter().find_map(|a| match a {
            Action::Send { name, blocks, .. } if name == "RequestXfer" => Some(blocks),
            _ => None,
        });
        let blocks = req.expect("RequestXfer");
        // LL_PATH_CACHE. Anything else (this used to say 5) is silently
        // discarded by the sim's xfer manager and the list never arrives.
        assert_eq!(blocks["XferID"][0]["FilePath"], 4);
        assert_eq!(st.xfers.len(), 1, "the transfer must be tracked");
    }

    #[test]
    fn abort_xfer_reports_mute_list_failure() {
        let mut st = SessionState::default();
        st.xfers.insert(7, XferIn { kind: "mute-list".into(), ..Default::default() });
        let actions = route(&mut st, &json!({
            "name": "AbortXfer",
            "blocks": { "XferID": [{ "ID": "7", "Result": -1 }] }
        }));
        assert!(st.xfers.is_empty(), "the aborted transfer must be dropped");
        let p = emit_of(&actions, "mute-list").expect("mute-list error event");
        assert_eq!(p["people"], json!([]));
        assert!(p["error"].as_str().unwrap().contains("refused"));
    }

    #[test]
    fn abort_xfer_for_unknown_transfer_is_silent() {
        let mut st = SessionState::default();
        let actions = route(&mut st, &json!({
            "name": "AbortXfer",
            "blocks": { "XferID": [{ "ID": "99", "Result": -1 }] }
        }));
        assert!(actions.is_empty());
    }
}
