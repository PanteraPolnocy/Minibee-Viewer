//! A light object table for the "Objects nearby" list.
//!
//! The sim streams region contents on arrival, so tracking starts at login and the
//! table is cleared on teleport. One region only (EnableSimulator is ignored).
//!
//! Stores id, position, owner, parent, and flags - not mesh, textures, or inventory.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

/// PCode for a primitive; avatars (47) are tracked for parenting but not listed.
pub const PCODE_PRIM: u8 = 9;
pub const PCODE_AVATAR: u8 = 47;

/// Don't let a busy region grow the table without bound.
///
/// Set at a region's default prim allowance rather than a round guess: below that we'd be
/// dropping objects that genuinely exist, which is the one thing this list must not do.
/// A row is around 100 bytes, so the ceiling is ten megabytes - and only a region
/// that is truly full gets anywhere near it.
const MAX_OBJECTS: usize = 100000;

/// One tracked object, kept deliberately small: a busy region can mean thousands of
/// these, and they live for as long as you're in the region.
///
/// The ids are raw 16-byte keys rather than the 36-character strings they're usually
/// written as - that alone saves two heap allocations and ~45 bytes per object, and
/// the compressed update hands us the bytes anyway, so no conversion is needed on the
/// way in. The description isn't stored at all: only the detail view wants it, and
/// that reads it straight from the sim's reply.
#[derive(Debug, Clone)]
pub struct ObjectRow {
    pub local_id: u32,
    pub full_id: [u8; 16],
    pub owner_id: [u8; 16],
    /// Who made it. Only the full ObjectProperties reply carries this, so it stays zero
    /// until the properties round-trip finishes.
    pub creator_id: [u8; 16],
    pub parent_id: u32,
    /// PCode from the sim. Only primitives (9) appear in the nearby list.
    pub pcode: u8,
    /// Region-local position, metres.
    pub pos: [f32; 3],
    /// Filled in later, from the properties reply. Boxed so an unnamed object costs a
    /// pointer rather than a full String.
    pub name: Option<Box<str>>,
    pub sale_price: i32,
    pub sale_type: u8,
    /// The sim's UpdateFlags word. Decides which row actions make sense.
    pub flags: u32,
    /// llSetClickAction, from the update itself. CLICK_ACTION_SIT and friends.
    pub click_action: u8,
    /// ObjectUpdate State byte. Non-zero means worn attachment.
    pub attachment_state: u8,
    /// True once properties have arrived, so we ask only once per object.
    pub have_props: bool,
    /// True once a request has gone out. Stops the drain re-asking the same ids
    /// before replies land.
    pub asked_props: bool,
    /// When `asked_props` was set, so unanswered rows can be retried (30s).
    pub props_asked_ms: u64,
}

impl Default for ObjectRow {
    fn default() -> Self {
        Self {
            local_id: 0,
            full_id: [0u8; 16],
            owner_id: [0u8; 16],
            creator_id: [0u8; 16],
            parent_id: 0,
            pcode: PCODE_PRIM,
            pos: [0.0; 3],
            name: None,
            sale_price: 0,
            sale_type: 0,
            flags: 0,
            click_action: 0,
            attachment_state: 0,
            have_props: false,
            asked_props: false,
            props_asked_ms: 0,
        }
    }
}

/// Sim-to-viewer object flags we act on.
pub const FLAGS_USE_PHYSICS: u32 = 1 << 0;
pub const FLAGS_SCRIPTED: u32 = 1 << 6;
pub const FLAGS_HANDLE_TOUCH: u32 = 1 << 7;
pub const FLAGS_TAKES_MONEY: u32 = 1 << 9;
pub const FLAGS_TEMPORARY_ON_REZ: u32 = 1 << 29;

/// Click actions we care about.
pub const CLICK_ACTION_SIT: u8 = 1;
pub const CLICK_ACTION_BUY: u8 = 2;
pub const CLICK_ACTION_PAY: u8 = 3;

/// Permission bits decoded for the object detail view.
pub const PERM_TRANSFER: i64 = 0x00002000;
pub const PERM_MODIFY: i64 = 0x00004000;
pub const PERM_COPY: i64 = 0x00008000;

/// Type filters for the nearby objects list (applied in the core).
#[derive(Clone, Copy, Debug)]
pub struct ListFilters {
    pub include_attachments: bool,
    pub include_physical: bool,
}

impl Default for ListFilters {
    fn default() -> Self {
        Self {
            include_attachments: false,
            include_physical: true,
        }
    }
}

/// Human-readable modify / copy / transfer from an object permission mask.
pub fn perm_mask_text(mask: i64) -> String {
    let mut out = String::with_capacity(24);
    if mask & PERM_MODIFY != 0 {
        out.push_str("modify");
    }
    if mask & PERM_COPY != 0 {
        if !out.is_empty() {
            out.push_str(", ");
        }
        out.push_str("copy");
    }
    if mask & PERM_TRANSFER != 0 {
        if !out.is_empty() {
            out.push_str(", ");
        }
        out.push_str("transfer");
    }
    if out.is_empty() {
        "none".to_string()
    } else {
        out
    }
}

impl ObjectRow {
    pub fn is_listable(&self) -> bool {
        self.pcode == PCODE_PRIM
    }

    /// Would a touch reach a script? We only list root prims, so there is no parent
    /// to consult. PAY and BUY imply a scripted handler.
    pub fn can_touch(&self) -> bool {
        self.flags & FLAGS_HANDLE_TOUCH != 0
    }

    /// True when FLAGS_TAKES_MONEY is set or the click action is PAY.
    pub fn can_pay(&self) -> bool {
        self.flags & FLAGS_TAKES_MONEY != 0 || self.click_action == CLICK_ACTION_PAY
    }
}

/// 16 raw bytes as the canonical UUID string, for the UI.
pub fn id_string(b: &[u8; 16]) -> String {
    crate::bridge::util::format_uuid_bytes(b)
}

/// Parse a UUID string (with or without dashes) into raw bytes.
pub fn id_bytes(s: &str) -> [u8; 16] {
    let mut out = [0u8; 16];
    let mut slot = 0usize;
    let mut pending: Option<u8> = None;
    for b in s.bytes() {
        if !b.is_ascii_hexdigit() {
            continue;
        }
        match pending {
            None => pending = Some(b),
            Some(hi) => {
                let hi = match hi {
                    b'0'..=b'9' => hi - b'0',
                    b'a'..=b'f' => hi - b'a' + 10,
                    b'A'..=b'F' => hi - b'A' + 10,
                    _ => return [0u8; 16],
                };
                let lo = match b {
                    b'0'..=b'9' => b - b'0',
                    b'a'..=b'f' => b - b'a' + 10,
                    b'A'..=b'F' => b - b'A' + 10,
                    _ => return [0u8; 16],
                };
                if slot >= 16 {
                    return [0u8; 16];
                }
                out[slot] = (hi << 4) | lo;
                slot += 1;
                pending = None;
            }
        }
    }
    if slot == 16 && pending.is_none() {
        out
    } else {
        [0u8; 16]
    }
}

fn is_zero_id(b: &[u8; 16]) -> bool {
    b.iter().all(|x| *x == 0)
}

/// Read a little-endian f32 vector at `off`, if the slice is long enough.
fn vec3_at(b: &[u8], off: usize) -> Option<[f32; 3]> {
    if b.len() < off + 12 {
        return None;
    }
    let f = |i: usize| f32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    Some([f(off), f(off + 4), f(off + 8)])
}

fn u32_at(b: &[u8], off: usize) -> Option<u32> {
    if b.len() < off + 4 {
        return None;
    }
    Some(u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]]))
}

/// Position out of a full ObjectUpdate's packed ObjectData blob.
///
/// The blob's LENGTH names its layout: avatar forms (76, or 140 with appended
/// extended data) lead with a 16-byte collision plane before the position;
/// object forms (60 / 124) start straight at it. Reading an avatar blob at
/// offset 0 yields the plane's normal - (0,0,1) on flat ground - which is how
/// every avatar in the region once ended up "standing" at the region corner.
/// The 16-bit quantized forms (48 avatar / 32 object) follow the same rule.
pub fn position_from_object_data(data: &[u8]) -> Option<[f32; 3]> {
    match data.len() {
        76 | 140 => vec3_at(data, 16),
        60 | 124 => vec3_at(data, 0),
        48 => quantized_pos_at(data, 16),
        32 => quantized_pos_at(data, 0),
        _ => None,
    }
}

/// Rotation out of a full ObjectUpdate blob: the packed quaternion (x, y, z
/// with w reconstructed) that follows position/velocity/acceleration. Only
/// the full-precision forms carry one worth reading.
pub fn rotation_from_object_data(data: &[u8]) -> Option<[f32; 4]> {
    let off = match data.len() {
        76 | 140 => 52,
        60 | 124 => 40,
        _ => return None,
    };
    let v = vec3_at(data, off)?;
    let w2 = (1.0 - (v[0] * v[0] + v[1] * v[1] + v[2] * v[2])).max(0.0);
    Some([v[0], v[1], v[2], w2.sqrt()])
}

/// Decode one ObjectUpdateCompressed data blob (compressed, non-terse layout).
pub fn decode_compressed(data: &[u8]) -> Option<(ObjectRow, bool)> {
    if data.len() < 84 {
        return None;
    }
    let mut full_id = [0u8; 16];
    full_id.copy_from_slice(data.get(0..16)?);
    let local_id = u32_at(data, 16)?;
    let pcode = *data.get(20)?;
    if pcode != PCODE_PRIM && pcode != PCODE_AVATAR {
        return None;
    }
    // State@21 CRC@22 Material@26 ClickAction@27 Scale@28 Pos@40 Rot@52 Special@64 Owner@68
    let attachment_state = *data.get(21)?;
    let click_action = *data.get(27)?;
    let pos = vec3_at(data, 40)?;
    let special = u32_at(data, 64)?;
    let mut owner_id = [0u8; 16];
    owner_id.copy_from_slice(data.get(68..84)?);
    let mut off = 84usize;
    if special & 0x80 != 0 {
        if data.len() < off + 12 {
            return None;
        }
        off += 12; // Omega
    }
    let has_parent = special & 0x20 != 0 && data.len() >= off + 4;
    let parent_id = if has_parent {
        u32_at(data, off).unwrap_or(0)
    } else {
        0
    };
    Some((
        ObjectRow {
            local_id,
            full_id,
            owner_id,
            parent_id,
            pcode,
            pos,
            click_action,
            attachment_state,
            ..Default::default()
        },
        has_parent,
    ))
}

/// Decode ImprovedTerseObjectUpdate `Data`: LocalID, State, agent flag, optional
/// collision plane, then a full-precision parent-relative position.
pub fn decode_terse_improved(data: &[u8]) -> Option<(u32, [f32; 3])> {
    if data.len() < 18 {
        return None;
    }
    let local_id = u32_at(data, 0)?;
    let agent = *data.get(5)?;
    let pos_off = if agent != 0 {
        if data.len() < 34 {
            return None;
        }
        22
    } else {
        6
    };
    let pos = vec3_at(data, pos_off)?;
    if !pos[0].is_finite() || !pos[1].is_finite() || !pos[2].is_finite() {
        return None;
    }
    Some((local_id, pos))
}

const REGION_SIZE: f32 = 256.0;
const REGION_MIN_HEIGHT: f32 = 0.0;
const REGION_MAX_HEIGHT: f32 = 4096.0;

fn u16_to_f32(v: u16, min: f32, max: f32) -> f32 {
    min + (max - min) * (f32::from(v) / 65535.0)
}

/// 16-bit quantised position at `off` in an ObjectUpdate ObjectData blob.
fn quantized_pos_at(data: &[u8], off: usize) -> Option<[f32; 3]> {
    if data.len() < off + 6 {
        return None;
    }
    Some([
        u16_to_f32(
            u16::from_le_bytes([data[off], data[off + 1]]),
            -0.5 * REGION_SIZE,
            1.5 * REGION_SIZE,
        ),
        u16_to_f32(
            u16::from_le_bytes([data[off + 2], data[off + 3]]),
            -0.5 * REGION_SIZE,
            1.5 * REGION_SIZE,
        ),
        u16_to_f32(
            u16::from_le_bytes([data[off + 4], data[off + 5]]),
            REGION_MIN_HEIGHT,
            REGION_MAX_HEIGHT,
        ),
    ])
}

/// The table itself, plus the bookkeeping the list command needs.
#[derive(Debug, Clone)]
pub struct ObjectTable {
    rows: HashMap<u32, ObjectRow>,
    /// LocalIDs of rows thrown away on the way out of a region - see
    /// `clear_for_teleport`. Empty unless a teleport is in flight.
    dropped: Vec<u32>,
    /// Which region those ids belong to. LocalIDs mean nothing outside it.
    dropped_region: (i64, i64),
    /// Every local id the sim listed in ObjectUpdateCached for this region.
    /// The sim only broadcasts that list once on arrival; Load re-asks for any
    /// we still do not have rows for.
    cached_ids: HashSet<u32>,
    /// Coarse avatar positions from CoarseLocationUpdate (1 m XY, 4 m Z steps).
    /// Used when an attachment's wearer never got a full ObjectUpdate row.
    coarse_agents: HashMap<[u8; 16], [f32; 3]>,
}

impl Default for ObjectTable {
    fn default() -> Self {
        Self {
            rows: HashMap::new(),
            dropped: Vec::new(),
            dropped_region: (0, 0),
            cached_ids: HashSet::new(),
            coarse_agents: HashMap::new(),
        }
    }
}

impl ObjectTable {
    /// Forget everything. Assigning a fresh map rather than calling `clear` hands the
    /// buckets back to the allocator instead of holding a busy region's worth of
    /// capacity for the rest of the session.
    pub fn clear(&mut self) {
        self.rows = HashMap::new();
        self.cached_ids.clear();
        self.coarse_agents.clear();
        self.forget_dropped();
    }

    /// Drop decoded rows but keep cached local ids, so Load can re-request every
    /// object and pick up positions decoded with a fixed layout.
    pub fn clear_rows_keep_cache(&mut self) {
        self.rows.clear();
    }

    /// Remember local ids from ObjectUpdateCached even before we have rows.
    pub fn note_cached_ids(&mut self, ids: impl IntoIterator<Item = u32>) {
        for id in ids {
            if id != 0 {
                self.cached_ids.insert(id);
            }
        }
    }

    pub fn cached_id_count(&self) -> usize {
        self.cached_ids.len()
    }

    /// Re-request cached local ids the sim announced but we have no row for.
    pub fn ids_missing_rows(&self, limit: usize) -> Vec<u32> {
        self.cached_ids
            .iter()
            .filter(|id| !self.rows.contains_key(id))
            .take(limit)
            .copied()
            .collect()
    }

    pub fn ids_missing_rows_all(&self) -> Vec<u32> {
        self.cached_ids
            .iter()
            .filter(|id| !self.rows.contains_key(id))
            .copied()
            .collect()
    }

    /// Every cached id we know about, for a full refetch after interest-list changes.
    pub fn all_cached_ids(&self) -> Vec<u32> {
        self.cached_ids.iter().copied().collect()
    }

    /// Best region position for distance filtering: a root's update position
    /// is authoritative (it arrives region-relative on the wire); children
    /// resolve through the actual parent chain.
    pub fn region_pos(&self, local_id: u32) -> Option<[f32; 3]> {
        let root_id = self.root_local_id(local_id);
        let root_pos = self.resolve_root_region_pos(root_id)?;
        if local_id == root_id {
            return Some(root_pos);
        }
        self.pos_from_resolved_root(local_id, root_id, root_pos)
    }

    /// How many attachment roots hang directly off the given avatar. Used after
    /// arriving in a region to judge whether the sim restored the worn outfit.
    pub fn attachments_of_avatar(&self, agent_id: &str) -> usize {
        let want = id_bytes(agent_id);
        if is_zero_id(&want) {
            return 0;
        }
        let av_local = self
            .rows
            .values()
            .find(|r| r.pcode == PCODE_AVATAR && r.full_id == want && r.parent_id == 0)
            .map(|r| r.local_id);
        let Some(av_local) = av_local else {
            return 0;
        };
        self.rows.values().filter(|r| r.parent_id == av_local).count()
    }

    /// Best known region position for a resident: their avatar row when we
    /// track it (exact), else the coarse radar spot.
    pub fn resident_region_pos(&self, agent_id: &str) -> Option<[f32; 3]> {
        if let Some(pos) = self.agent_region_pos(agent_id) {
            return Some(pos);
        }
        let id = id_bytes(agent_id);
        if is_zero_id(&id) {
            return None;
        }
        self.coarse_agents.get(&id).copied()
    }

    /// Remember a resident's coarse position from CoarseLocationUpdate (radar).
    /// It stays in its own map: a coarse spot is quantized to whole meters and
    /// must never overwrite an avatar row's precise update position - rows win,
    /// coarse is the fallback for residents we hold no row for.
    pub fn note_coarse_agent(&mut self, agent_id: &str, pos: [f32; 3]) {
        let id = id_bytes(agent_id);
        if is_zero_id(&id) {
            return;
        }
        self.coarse_agents.insert(id, pos);
    }

    /// Best region position for list distance: object resolution, then attachment
    /// fallbacks via avatar rows or coarse radar.
    pub fn region_pos_for_list(&self, local_id: u32) -> Option<[f32; 3]> {
        if let Some(pos) = self.region_pos(local_id) {
            return Some(pos);
        }
        self.attachment_fallback_pos(local_id)
    }

    fn attachment_fallback_pos(&self, local_id: u32) -> Option<[f32; 3]> {
        let root = self.root_local_id(local_id);
        if !self.is_attachment(root) {
            return None;
        }
        self.attachment_region_pos(root)
    }

    /// Region position for a worn attachment root: avatar anchor, then wearer radar.
    fn attachment_region_pos(&self, root_id: u32) -> Option<[f32; 3]> {
        let row = self.rows.get(&root_id)?;
        let offset = row.pos;
        if let Some(avatar_id) = self.attachment_anchor_avatar(root_id) {
            if let Some(anchor) = self.anchor_region_pos(avatar_id) {
                return Some([
                    anchor[0] + offset[0],
                    anchor[1] + offset[1],
                    anchor[2] + offset[2],
                ]);
            }
            if let Some(avatar) = self.rows.get(&avatar_id) {
                if let Some(&coarse) = self.coarse_agents.get(&avatar.full_id) {
                    return Some([
                        coarse[0] + offset[0],
                        coarse[1] + offset[1],
                        coarse[2] + offset[2],
                    ]);
                }
            }
        }
        if let Some(wearer) = self.wearer_region_pos(&row.owner_id) {
            return Some([
                wearer[0] + offset[0],
                wearer[1] + offset[1],
                wearer[2] + offset[2],
            ]);
        }
        None
    }

    /// Best known region position for a resident (avatar row or coarse radar).
    fn wearer_region_pos(&self, wearer_id: &[u8; 16]) -> Option<[f32; 3]> {
        if is_zero_id(wearer_id) {
            return None;
        }
        if let Some(avatar) = self
            .rows
            .values()
            .find(|r| r.pcode == PCODE_AVATAR && r.full_id == *wearer_id)
        {
            if let Some(pos) = self.anchor_region_pos(avatar.local_id) {
                return Some(pos);
            }
            return Some(avatar.pos);
        }
        self.coarse_agents.get(wearer_id).copied()
    }

    /// Region position for a linkset root. The sim's own update position is
    /// the truth for a root; only attachments need anchoring to their wearer.
    fn resolve_root_region_pos(&self, root_id: u32) -> Option<[f32; 3]> {
        let actual_root = self.root_local_id(root_id);
        let row = self.rows.get(&actual_root)?;
        if self.is_attachment(actual_root) {
            return self.attachment_region_pos(actual_root);
        }
        if row.parent_id != 0 {
            return None;
        }
        Some(row.pos)
    }

    /// Region position for an avatar or seat used as an attachment / sit anchor.
    fn anchor_region_pos(&self, local_id: u32) -> Option<[f32; 3]> {
        let row = self.rows.get(&local_id)?;
        if row.parent_id == 0 {
            return Some(row.pos);
        }
        let parent_pos = self.anchor_region_pos(row.parent_id)?;
        Some([
            parent_pos[0] + row.pos[0],
            parent_pos[1] + row.pos[1],
            parent_pos[2] + row.pos[2],
        ])
    }

    /// Walk parent-relative offsets from an already-resolved root position.
    fn pos_from_resolved_root(
        &self,
        local_id: u32,
        root_id: u32,
        root_pos: [f32; 3],
    ) -> Option<[f32; 3]> {
        if local_id == root_id {
            return Some(root_pos);
        }
        let row = self.rows.get(&local_id)?;
        if row.parent_id == 0 {
            return None;
        }
        let parent_pos = self.pos_from_resolved_root(row.parent_id, root_id, root_pos)?;
        Some([
            parent_pos[0] + row.pos[0],
            parent_pos[1] + row.pos[1],
            parent_pos[2] + row.pos[2],
        ])
    }

    /// True 3D distance from `from` to a prim's resolved region position.
    pub fn list_distance(&self, local_id: u32, from: [f32; 3]) -> f32 {
        self.region_pos(local_id)
            .map(|pos| distance(from, pos))
            .unwrap_or(f32::MAX)
    }

    /// Drop the rows on the way out of a region, but keep their LocalIDs.
    ///
    /// A sim only describes its contents when you arrive, so if the teleport fails
    /// we'd be left standing in the old region with an empty list and no way to ask
    /// for it back. Four bytes per object - 32 KB at the cap, against the rows
    /// themselves - buys a second chance via RequestMultipleObjects. See
    /// `take_dropped`.
    pub fn clear_for_teleport(&mut self, region: (i64, i64)) {
        self.dropped = self.rows.keys().copied().collect();
        self.dropped_region = region;
        self.rows = HashMap::new();
    }

    /// Take up to `limit` of the ids kept by `clear_for_teleport`, so a stalled
    /// teleport can be recovered from a batch at a time rather than in one blast.
    ///
    /// Only while we're still in the region they came from: LocalIDs are region-scoped,
    /// so asking a new sim about them would be meaningless at best and a collision with
    /// somebody else's object at worst. If the region has changed they're forgotten.
    pub fn take_dropped(&mut self, region: (i64, i64), limit: usize) -> Vec<u32> {
        if self.dropped_region != region {
            self.forget_dropped();
            return Vec::new();
        }
        let n = limit.min(self.dropped.len());
        self.dropped.drain(..n).collect()
    }

    /// The teleport worked, so the ids belong to a region we've left.
    pub fn forget_dropped(&mut self) {
        self.dropped = Vec::new();
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Merge fields from a partial ObjectUpdate that carried no decodable position.
    pub fn merge_partial(
        &mut self,
        local_id: u32,
        parent_id: u32,
        flags: u32,
        click_action: u8,
        attachment_state: u8,
    ) {
        if let Some(existing) = self.rows.get_mut(&local_id) {
            // Partial updates may send ParentID 0 when the field is absent; avatars
            // must still accept an explicit stand-up (ParentID 0).
            if parent_id != 0 || existing.parent_id == 0 || existing.pcode == PCODE_AVATAR {
                existing.parent_id = parent_id;
            }
            if flags != 0 {
                existing.flags = flags;
            }
            existing.click_action = click_action;
            if attachment_state != 0 {
                existing.attachment_state = attachment_state;
            }
        }
    }

    /// Merge a decoded update, keeping any properties we've already fetched.
    pub fn upsert(&mut self, row: ObjectRow) {
        self.upsert_inner(row, true);
    }

    /// Merge a compressed ObjectUpdate blob. ParentID is optional in the blob; when it is
    /// absent we must not wipe a link we already learned from a fuller update.
    pub fn upsert_compressed(&mut self, row: ObjectRow, has_parent_field: bool) {
        self.upsert_inner(row, has_parent_field);
    }

    fn upsert_inner(&mut self, row: ObjectRow, has_parent_field: bool) {
        if self.rows.len() >= MAX_OBJECTS && !self.rows.contains_key(&row.local_id) {
            // Say so rather than quietly under-report the region. Once is enough - this
            // would otherwise fire for every further update in a full region.
            if self.rows.len() == MAX_OBJECTS {
                crate::dlog!("object table full at {MAX_OBJECTS}; further objects ignored");
            }
            return;
        }
        // The sim recycles local ids. A different FullID on a known local id
        // means a brand-new tenant: nothing learned about the old object (name,
        // props, attachment state) may leak onto it, and any children still
        // pointing here belonged to the OLD linkset - grouping them under the
        // newcomer painted unrelated objects as one linkset in the nearby list.
        let recycled = self
            .rows
            .get(&row.local_id)
            .is_some_and(|e| !is_zero_id(&row.full_id) && !is_zero_id(&e.full_id) && e.full_id != row.full_id);
        if recycled {
            self.remove_descendants(row.local_id);
            self.rows.remove(&row.local_id);
            self.cached_ids.insert(row.local_id);
            self.rows.insert(row.local_id, row);
            return;
        }
        match self.rows.get_mut(&row.local_id) {
            Some(existing) => {
                self.cached_ids.insert(row.local_id);
                existing.full_id = row.full_id;
                if has_parent_field {
                    existing.parent_id = row.parent_id;
                } else if row.parent_id != 0 {
                    existing.parent_id = row.parent_id;
                } else if existing.pcode == PCODE_AVATAR {
                    // Uncompressed stand-up sends ParentID 0 explicitly; movement-only
                    // compressed updates omit the field and must not undo that.
                }
                existing.pos = row.pos;
                existing.click_action = row.click_action;
                if row.attachment_state != 0 {
                    existing.attachment_state = row.attachment_state;
                }
                // A cached-id update carries flags but no blob, so don't let a zero from
                // one message wipe what a fuller one told us.
                if row.flags != 0 {
                    existing.flags = row.flags;
                }
                if !is_zero_id(&row.owner_id) {
                    existing.owner_id = row.owner_id;
                }
            }
            None => {
                self.cached_ids.insert(row.local_id);
                self.rows.insert(row.local_id, row);
            }
        }
    }

    /// Do we already know this object? Lets the cached-update path ask only for the
    /// ones we're missing.
    pub fn contains(&self, local_id: u32) -> bool {
        self.rows.contains_key(&local_id)
    }

    /// Apply a movement update (parent-relative or region-local, same as the sim).
    pub fn update_movement(&mut self, local_id: u32, pos: [f32; 3]) {
        if let Some(row) = self.rows.get_mut(&local_id) {
            row.pos = pos;
        }
    }

    /// Rows with a parent id the table does not have yet (linksets need the root first).
    pub fn unresolved_parent_count(&self) -> usize {
        self.rows
            .values()
            .filter(|r| r.parent_id != 0 && !self.rows.contains_key(&r.parent_id))
            .count()
    }

    /// Parent local ids referenced by children but not present in the table yet.
    pub fn missing_parent_ids(&self) -> Vec<u32> {
        let mut out: Vec<u32> = self
            .rows
            .values()
            .filter(|r| r.parent_id != 0 && !self.rows.contains_key(&r.parent_id))
            .map(|r| r.parent_id)
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Where an object is, by LocalID. Needed to turn a seated avatar's parent-relative
    /// position into a region one.
    pub fn position_of(&self, local_id: u32) -> Option<[f32; 3]> {
        self.rows.get(&local_id).map(|r| r.pos)
    }

    pub fn parent_id_of(&self, local_id: u32) -> Option<u32> {
        self.rows.get(&local_id).map(|r| r.parent_id)
    }

    /// Remove an object AND its descendants. A KillObject for a linkset root
    /// stands for the whole linkset; leaving the children behind kept ghost
    /// rows pointing at a dead id, and once the sim recycled that id they
    /// re-attached to whatever unrelated object received it.
    pub fn remove(&mut self, local_id: u32) {
        self.remove_descendants(local_id);
        self.rows.remove(&local_id);
        // A killed id must leave the cached set too, or every later Load
        // re-requests the dead object forever (ids_missing_rows never rests).
        self.cached_ids.remove(&local_id);
    }

    /// Drop every row whose parent chain reaches `local_id` (not the row itself).
    fn remove_descendants(&mut self, local_id: u32) {
        let mut doomed: Vec<u32> = vec![local_id];
        let mut i = 0;
        while i < doomed.len() {
            let parent = doomed[i];
            i += 1;
            for row in self.rows.values() {
                if row.parent_id == parent && row.pcode != PCODE_AVATAR && !doomed.contains(&row.local_id) {
                    doomed.push(row.local_id);
                }
            }
        }
        for id in doomed.into_iter().skip(1) {
            self.rows.remove(&id);
            self.cached_ids.remove(&id);
        }
    }

    /// Fold in a properties reply, from either the Family form or the full one.
    ///
    /// `creator_id` is empty for the Family reply - only the full ObjectProperties that
    /// a selection produces carries it. The description isn't stored: only the detail
    /// view wants it, and that reads it from the reply as it arrives.
    pub fn set_props(
        &mut self,
        full_id: &str,
        name: &str,
        owner_id: &str,
        creator_id: &str,
        sale_price: i64,
        sale_type: u8,
    ) {
        let want = id_bytes(full_id);
        for row in self.rows.values_mut() {
            if row.full_id == want {
                row.name = Some(name.into());
                if !owner_id.is_empty() {
                    row.owner_id = id_bytes(owner_id);
                }
                if !creator_id.is_empty() {
                    row.creator_id = id_bytes(creator_id);
                }
                row.sale_price = sale_price as i32;
                row.sale_type = sale_type;
                row.have_props = true;
                return;
            }
        }
    }

    /// World position for sit-offset math: parent chain summed with raw stored
    /// positions, without skybox linkset heuristics (a seat at altitude is real).
    pub fn sit_anchor_pos(&self, local_id: u32) -> Option<[f32; 3]> {
        let row = self.rows.get(&local_id)?;
        if row.parent_id == 0 {
            return Some(row.pos);
        }
        let parent = self.sit_anchor_pos(row.parent_id)?;
        Some([
            parent[0] + row.pos[0],
            parent[1] + row.pos[1],
            parent[2] + row.pos[2],
        ])
    }

    /// Region position of the agent's own avatar row, if we have one.
    pub fn agent_region_pos(&self, agent_id: &str) -> Option<[f32; 3]> {
        let id = self.agent_local_id(agent_id)?;
        let row = self.rows.get(&id)?;
        if row.parent_id == 0 {
            return Some(row.pos);
        }
        let parent_pos = self.region_pos(row.parent_id)?;
        Some([
            parent_pos[0] + row.pos[0],
            parent_pos[1] + row.pos[1],
            parent_pos[2] + row.pos[2],
        ])
    }

    /// True when a prim is parented directly to an avatar (wearable attachment).
    fn is_parented_to_avatar(&self, local_id: u32) -> bool {
        let Some(row) = self.rows.get(&local_id) else {
            return false;
        };
        if row.parent_id == 0 {
            return false;
        }
        self.rows
            .get(&row.parent_id)
            .is_some_and(|p| p.pcode == PCODE_AVATAR)
    }

    /// Avatar local id an attachment hangs from: parent link, or owner UUID match.
    pub fn attachment_anchor_avatar(&self, local_id: u32) -> Option<u32> {
        let root = self.root_local_id(local_id);
        let row = self.rows.get(&root)?;
        if row.attachment_state == 0 && !self.is_parented_to_avatar(root) {
            return None;
        }
        if row.parent_id != 0 {
            if let Some(parent) = self.rows.get(&row.parent_id) {
                if parent.pcode == PCODE_AVATAR {
                    return Some(row.parent_id);
                }
            }
        }
        if !is_zero_id(&row.owner_id) {
            return self
                .rows
                .values()
                .find(|r| r.pcode == PCODE_AVATAR && r.full_id == row.owner_id)
                .map(|r| r.local_id);
        }
        None
    }

    /// True when a prim is a worn attachment (State byte or parented to an avatar).
    pub fn is_attachment(&self, local_id: u32) -> bool {
        let Some(row) = self.rows.get(&local_id) else {
            return false;
        };
        if row.attachment_state != 0 {
            return true;
        }
        self.is_parented_to_avatar(local_id)
    }

    /// Primitives that belong in the nearby interact list (not avatars).
    fn is_nearby_listable(&self, local_id: u32) -> bool {
        self.rows
            .get(&local_id)
            .is_some_and(|r| r.is_listable())
    }

    /// True when a prim belongs to a worn attachment linkset (root parent is an avatar).
    pub fn is_in_attachment(&self, local_id: u32) -> bool {
        self.is_attachment(self.root_local_id(local_id))
    }

    pub fn agent_local_id(&self, agent_id: &str) -> Option<u32> {
        let want = id_bytes(agent_id);
        if is_zero_id(&want) {
            return None;
        }
        self.rows
            .values()
            .find(|r| r.pcode == PCODE_AVATAR && r.full_id == want)
            .map(|r| r.local_id)
    }

    /// Walk the parent chain to the linkset root local id.
    ///
    /// Stops at avatars so attachments and sit targets are not folded into furniture linksets.
    pub fn root_local_id(&self, local_id: u32) -> u32 {
        let mut id = local_id;
        for _ in 0..33 {
            let Some(row) = self.rows.get(&id) else {
                return local_id;
            };
            if row.parent_id == 0 {
                return id;
            }
            let Some(parent) = self.rows.get(&row.parent_id) else {
                return id;
            };
            if parent.pcode == PCODE_AVATAR {
                return id;
            }
            id = row.parent_id;
        }
        local_id
    }

    /// In-range prims plus any linkset ancestors needed to group children under roots.
    pub fn nearby_for_list(&self, from: [f32; 3], range: f32) -> Vec<(&ObjectRow, [f32; 3])> {
        let in_range = self.nearby(from, range);
        let mut out: Vec<(&ObjectRow, [f32; 3])> = Vec::new();
        let mut seen: HashSet<u32> = HashSet::new();
        let mut add = |local_id: u32| {
            if seen.contains(&local_id) {
                return;
            }
            let Some(row) = self.rows.get(&local_id) else {
                return;
            };
            if !self.is_nearby_listable(local_id) {
                return;
            }
            let Some(pos) = self.region_pos_for_list(local_id) else {
                return;
            };
            seen.insert(local_id);
            out.push((row, pos));
        };
        for (row, _) in &in_range {
            add(row.local_id);
            let mut pid = row.parent_id;
            while pid != 0 {
                let Some(parent) = self.rows.get(&pid) else {
                    break;
                };
                if parent.pcode == PCODE_AVATAR {
                    break;
                }
                add(pid);
                pid = parent.parent_id;
            }
        }
        // Second pass: worn attachment roots whose parent link was lost on a
        // movement-only compressed update.
        for row in self.rows.values() {
            let root = self.root_local_id(row.local_id);
            if root != row.local_id || !self.is_attachment(root) {
                continue;
            }
            add(root);
        }
        out.sort_by(|a, b| {
            distance_sq(from, a.1)
                .partial_cmp(&distance_sq(from, b.1))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out
    }

    fn is_list_root(&self, local_id: u32) -> bool {
        let Some(row) = self.rows.get(&local_id) else {
            return false;
        };
        if row.parent_id == 0 {
            return true;
        }
        let root = self.root_local_id(local_id);
        local_id == root && self.is_attachment(local_id)
    }

    fn linkset_passes_type_filters(&self, root_id: u32, filters: ListFilters) -> bool {
        let mut attachment = false;
        let mut physical = false;
        for row in self.rows.values() {
            if self.root_local_id(row.local_id) != root_id {
                continue;
            }
            if !self.is_nearby_listable(row.local_id) {
                continue;
            }
            if self.is_in_attachment(row.local_id) {
                attachment = true;
            }
            if row.flags & FLAGS_USE_PHYSICS != 0 {
                physical = true;
            }
        }
        if !filters.include_attachments && attachment {
            return false;
        }
        if !filters.include_physical && physical {
            return false;
        }
        true
    }

    /// Nearby list as linkset roots with child rows, after type filters.
    ///
    /// Returns `(entries, owner/creator ids still needing a name lookup)`.
    pub fn nearby_list_entries(
        &self,
        from: [f32; 3],
        range: f32,
        filters: ListFilters,
    ) -> (Vec<Value>, Vec<String>) {
        let flat: Vec<(u32, [f32; 3])> = self
            .nearby_for_list(from, range)
            .into_iter()
            .map(|(r, pos)| (r.local_id, pos))
            .collect();
        let mut by_id: HashMap<u32, [f32; 3]> = HashMap::new();
        for (id, pos) in flat {
            by_id.insert(id, pos);
        }

        let mut root_ids: Vec<u32> = by_id
            .keys()
            .copied()
            .filter(|id| self.is_list_root(*id))
            .collect();
        root_ids.sort_by(|a, b| {
            distance_sq(from, by_id[a])
                .partial_cmp(&distance_sq(from, by_id[b]))
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut children_by_root: HashMap<u32, Vec<u32>> = HashMap::new();
        for &id in by_id.keys() {
            if let Some(row) = self.rows.get(&id) {
                if row.parent_id != 0 {
                    let root = self.root_local_id(id);
                    if root != id {
                        children_by_root.entry(root).or_default().push(id);
                    }
                }
            }
        }

        let mut resolve_ids: Vec<String> = Vec::new();
        let mut seen_resolve: HashSet<String> = HashSet::new();
        let mut note_id = |id: &str| {
            if id.is_empty() || is_zero_id(&id_bytes(id)) {
                return;
            }
            let key = id.to_ascii_lowercase();
            if seen_resolve.insert(key) {
                resolve_ids.push(id.to_string());
            }
        };

        let mut entries: Vec<Value> = Vec::new();
        for root_id in root_ids {
            if !self.linkset_passes_type_filters(root_id, filters) {
                continue;
            }
            let Some(root_row) = self.rows.get(&root_id) else {
                continue;
            };
            let Some(root_pos) = by_id.get(&root_id).copied() else {
                continue;
            };
            let list_dist = distance(from, root_pos);
            let in_attachment = self.is_in_attachment(root_id);

            let mut child_entries: Vec<Value> = Vec::new();
            let mut child_ids = children_by_root.remove(&root_id).unwrap_or_default();
            child_ids.sort_by(|a, b| {
                distance_sq(from, by_id[a])
                    .partial_cmp(&distance_sq(from, by_id[b]))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            for child_id in child_ids {
                let Some(child_row) = self.rows.get(&child_id) else {
                    continue;
                };
                let child_pos = by_id[&child_id];
                let child_dist = distance(from, child_pos);
                let child_attachment = self.is_in_attachment(child_id);
                child_entries.push(row_json(
                    child_row,
                    child_pos,
                    root_id,
                    child_dist,
                    child_attachment,
                ));
                note_id(&id_string(&child_row.owner_id));
                note_id(&id_string(&child_row.creator_id));
            }

            note_id(&id_string(&root_row.owner_id));
            note_id(&id_string(&root_row.creator_id));

            let mut entry = row_json(root_row, root_pos, root_id, list_dist, in_attachment);
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("children".to_string(), Value::Array(child_entries));
            }
            entries.push(entry);
        }

        (entries, resolve_ids)
    }

    /// Objects within `range` metres of `from`, nearest first.
    ///
    /// Child prims are included with their region position (root position plus
    /// parent-relative offsets), so a linkset skybox still lists its parts.
    pub fn nearby(&self, from: [f32; 3], range: f32) -> Vec<(&ObjectRow, [f32; 3])> {
        let range_sq = range * range;
        let mut out: Vec<(&ObjectRow, [f32; 3])> = self
            .rows
            .values()
            .filter(|r| self.is_nearby_listable(r.local_id))
            .filter_map(|r| {
                self.region_pos_for_list(r.local_id)
                    .map(|pos| (r, pos))
            })
            .filter(|(_, pos)| distance_sq(from, *pos) <= range_sq)
            .collect();
        out.sort_by(|a, b| {
            distance_sq(from, a.1)
                .partial_cmp(&distance_sq(from, b.1))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out
    }

    /// Objects in range we haven't asked about yet, nearest first, up to `limit`.
    ///
    /// Marks each one as asked, so successive calls walk through the whole set instead
    /// of handing back the same batch until the replies land. Rows that were asked but
    /// never answered become eligible again once `timeout_ms` has passed.
    pub fn take_needing_props(
        &mut self,
        from: [f32; 3],
        range: f32,
        limit: usize,
        now_ms: u64,
        timeout_ms: u64,
    ) -> Vec<u32> {
        let stale = |r: &ObjectRow| {
            !r.have_props
                && (!r.asked_props
                    || now_ms.saturating_sub(r.props_asked_ms) >= timeout_ms)
        };
        let ids: Vec<u32> = self
            .nearby(from, range)
            .into_iter()
            .filter(|(r, _)| stale(r))
            .take(limit)
            .map(|(r, _)| r.local_id)
            .collect();
        for id in &ids {
            if let Some(row) = self.rows.get_mut(id) {
                row.asked_props = true;
                row.props_asked_ms = now_ms;
            }
        }
        ids
    }

    /// UUIDs for in-range objects still missing properties - used as a fallback when
    /// ObjectSelect batches go unanswered (RequestObjectPropertiesFamily / hover path).
    pub fn take_needing_props_family(
        &mut self,
        from: [f32; 3],
        range: f32,
        limit: usize,
        now_ms: u64,
        timeout_ms: u64,
    ) -> Vec<String> {
        let stale = |r: &ObjectRow| {
            !r.have_props
                && (!r.asked_props
                    || now_ms.saturating_sub(r.props_asked_ms) >= timeout_ms)
        };
        let ids: Vec<String> = self
            .nearby(from, range)
            .into_iter()
            .filter(|(r, _)| stale(r))
            .take(limit)
            .map(|(r, _)| id_string(&r.full_id))
            .collect();
        for row in self.rows.values_mut() {
            if ids.iter().any(|id| id_bytes(id) == row.full_id) {
                row.asked_props = true;
                row.props_asked_ms = now_ms;
            }
        }
        ids
    }

    /// Let anything still unnamed be asked about again.
    ///
    /// Load clears the marks, so unanswered rows can be asked again.
    pub fn allow_props_retry(&mut self) {
        for row in self.rows.values_mut() {
            if !row.have_props {
                row.asked_props = false;
                row.props_asked_ms = 0;
            }
        }
    }

    /// `(tracked, roots, nearest root m, nearest prim m)` measured from `from`.
    pub fn census(&self, from: [f32; 3]) -> (usize, usize, f32, f32) {
        let mut roots = 0usize;
        let mut nearest_root = f32::MAX;
        let mut nearest_any = f32::MAX;
        for r in self.rows.values() {
            if !self.is_nearby_listable(r.local_id) {
                continue;
            }
            if r.parent_id == 0 {
                roots += 1;
            }
            let Some(pos) = self.region_pos(r.local_id) else {
                continue;
            };
            let d = distance(from, pos);
            if d < nearest_any {
                nearest_any = d;
            }
            if r.parent_id == 0 && d < nearest_root {
                nearest_root = d;
            }
        }
        let root = if roots == 0 { -1.0 } else { nearest_root };
        let any = if nearest_any == f32::MAX { -1.0 } else { nearest_any };
        (self.rows.len(), roots, root, any)
    }

    /// `(tracked attachments, in-range attachment roots)` for diagnostics.
    pub fn attachment_stats(&self, from: [f32; 3], range: f32) -> (usize, usize) {
        let range_sq = range * range;
        let mut tracked = 0usize;
        let mut in_range = 0usize;
        for row in self.rows.values() {
            let root = self.root_local_id(row.local_id);
            if root != row.local_id || !self.is_attachment(root) {
                continue;
            }
            tracked += 1;
            if let Some(pos) = self.region_pos_for_list(root) {
                if distance_sq(from, pos) <= range_sq {
                    in_range += 1;
                }
            }
        }
        (tracked, in_range)
    }

    /// How many in-range objects are still waiting on a reply. Only for reporting.
    pub fn pending_props(&self, from: [f32; 3], range: f32) -> usize {
        self.nearby(from, range)
            .into_iter()
            .filter(|(r, _)| !r.have_props)
            .count()
    }
}

pub fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    distance_sq(a, b).sqrt()
}

/// Squared distance; use for ordering (same sort order as [`distance`]).
#[inline]
fn distance_sq(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    dx * dx + dy * dy + dz * dz
}

/// Shape one row for the UI.
pub fn row_json(
    row: &ObjectRow,
    region_pos: [f32; 3],
    root_local_id: u32,
    list_distance: f32,
    in_attachment: bool,
) -> Value {
    json!({
        "localId": row.local_id,
        "parentId": row.parent_id,
        "rootLocalId": root_local_id,
        "id": id_string(&row.full_id),
        "name": row.name.as_deref().unwrap_or(""),
        "ownerId": if is_zero_id(&row.owner_id) { String::new() } else { id_string(&row.owner_id) },
        "creatorId": if is_zero_id(&row.creator_id) { String::new() } else { id_string(&row.creator_id) },
        "distance": (list_distance * 10.0).round() / 10.0,
        "position": { "x": region_pos[0], "y": region_pos[1], "z": region_pos[2] },
        "salePrice": row.sale_price,
        "saleType": row.sale_type,
        "forSale": row.sale_type > 0 && row.sale_price > 0,
        "haveProps": row.have_props,
        // Row actions follow the sim's flags so the UI can hide useless buttons.
        "canTouch": row.can_touch(),
        "canPay": row.can_pay(),
        "scripted": row.flags & FLAGS_SCRIPTED != 0,
        "physical": row.flags & FLAGS_USE_PHYSICS != 0,
        "temporary": row.flags & FLAGS_TEMPORARY_ON_REZ != 0,
        "isAttachment": in_attachment,
        "clickAction": row.click_action,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a compressed blob the way the sim would, so the decoder is exercised
    /// against the real field order rather than its own assumptions.
    fn compressed_blob(local_id: u32, pos: [f32; 3], owner: u8, special: u32, parent: u32) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&[0x11; 16]); // FullID
        b.extend_from_slice(&local_id.to_le_bytes());
        b.push(PCODE_PRIM);
        b.push(0); // State
        b.extend_from_slice(&7u32.to_le_bytes()); // CRC
        b.push(3); // Material
        b.push(0); // ClickAction
        b.extend_from_slice(&[0u8; 12]); // Scale
        for v in pos {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b.extend_from_slice(&[0u8; 12]); // Rot
        b.extend_from_slice(&special.to_le_bytes());
        b.extend_from_slice(&[owner; 16]); // Owner
        if special & 0x80 != 0 {
            b.extend_from_slice(&[0u8; 12]); // Omega
        }
        if special & 0x20 != 0 {
            b.extend_from_slice(&parent.to_le_bytes());
        }
        b
    }

    #[test]
    fn compressed_layout_matches_reference_offsets() {
        // State@21 CRC@22 Material@26 ClickAction@27 Scale@28 Pos@40 Rot@52 Special@64 Owner@68
        let blob = compressed_blob(1, [128.0, 235.0, 1020.0], 0xCD, 0, 0);
        assert_eq!(blob.len(), 84);
        let (row, has_parent) = decode_compressed(&blob).expect("decoded");
        assert!(!has_parent);
        assert_eq!(row.pos, [128.0, 235.0, 1020.0]);
        assert_eq!(row.click_action, 0);
        assert!(id_string(&row.owner_id).starts_with("cdcdcdcd-"));
    }

    #[test]
    fn decodes_compressed_position_and_owner() {
        let blob = compressed_blob(4242, [10.0, 20.0, 30.0], 0xAB, 0, 0);
        let (row, _) = decode_compressed(&blob).expect("decoded");
        assert_eq!(row.local_id, 4242);
        assert_eq!(row.pos, [10.0, 20.0, 30.0]);
        assert_eq!(row.parent_id, 0);
        assert!(id_string(&row.owner_id).starts_with("abababab-"));
        assert_eq!(id_string(&row.full_id), "11111111-1111-1111-1111-111111111111");
    }

    #[test]
    fn compressed_optional_fields_shift_the_parent_id() {
        // 0x80 adds angular velocity before the parent id, 0x20 says a parent follows.
        let blob = compressed_blob(7, [0.0, 0.0, 0.0], 1, 0x80 | 0x20, 99);
        let (row, has_parent) = decode_compressed(&blob).expect("decoded");
        assert!(has_parent);
        assert_eq!(row.parent_id, 99, "omega must be skipped before the parent id");
        // Without 0x80 the parent sits 12 bytes earlier.
        let blob2 = compressed_blob(8, [0.0, 0.0, 0.0], 1, 0x20, 55);
        assert_eq!(decode_compressed(&blob2).unwrap().0.parent_id, 55);
    }

    #[test]
    fn ignores_non_prims_and_short_blobs() {
        let mut blob = compressed_blob(1, [0.0; 3], 1, 0, 0);
        blob[20] = 47; // avatar - stored for parenting, not listing
        let (row, _) = decode_compressed(&blob).expect("avatar row");
        assert_eq!(row.pcode, PCODE_AVATAR);
        assert!(!row.is_listable());
        blob[20] = 47;
        let mut t = ObjectTable::default();
        t.upsert(row);
        assert!(t.nearby([0.0; 3], 128.0).is_empty());
        blob[20] = 12; // grass
        assert!(decode_compressed(&blob).is_none());
        assert!(decode_compressed(&[0u8; 8]).is_none());
    }

    // A root's position arrives region-relative on the wire, so a root at
    // (0,0,983) IS at the region corner - it must never be re-anchored onto
    // some other root's position by a guess.
    #[test]
    fn a_root_near_the_region_corner_stays_at_the_corner() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow {
            local_id: 10,
            parent_id: 0,
            pos: [128.0, 235.0, 37.0],
            ..Default::default()
        });
        t.upsert(ObjectRow {
            local_id: 11,
            parent_id: 0,
            pos: [0.0, 0.0, 983.0],
            ..Default::default()
        });
        assert_eq!(t.region_pos(11), Some([0.0, 0.0, 983.0]));
        // From a skybox near the region centre, the corner root is ~270m out
        // and the ground root ~983m below - neither is within 128m.
        let from = [128.0, 235.0, 1020.0];
        assert!(t.nearby(from, 128.0).is_empty());
    }

    #[test]
    fn linkset_chain_places_the_matching_storey_next_to_the_avatar() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow {
            local_id: 1,
            parent_id: 0,
            pos: [120.9, 229.3, 37.0],
            ..Default::default()
        });
        t.upsert(ObjectRow {
            local_id: 2,
            parent_id: 1,
            pos: [0.0, 0.0, 983.0],
            ..Default::default()
        });
        t.upsert(ObjectRow {
            local_id: 3,
            parent_id: 2,
            pos: [0.0, 0.0, 983.0],
            ..Default::default()
        });
        t.upsert(ObjectRow {
            local_id: 4,
            parent_id: 3,
            pos: [0.0, -0.4, -2.9],
            ..Default::default()
        });
        let from = [128.0, 235.0, 1020.0];
        let (_, _, _, nearest) = t.census(from);
        assert!(nearest < 16.0, "the middle storey resolves beside the avatar via the parent chain");
        assert!(!t.nearby(from, 128.0).is_empty());
    }

    #[test]
    fn orphaned_linkset_child_without_parent_is_not_listed() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow {
            local_id: 11,
            parent_id: 10,
            pcode: PCODE_PRIM,
            pos: [0.0, 0.0, 983.0],
            ..Default::default()
        });
        let from = [128.0, 235.0, 1020.0];
        let rows = t.nearby(from, 128.0);
        assert!(rows.is_empty(), "child without parent row cannot be placed");
    }

    #[test]
    fn linkset_children_inherit_root_position() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow {
            local_id: 1,
            parent_id: 0,
            pos: [132.0, 236.0, 2098.0],
            ..Default::default()
        });
        t.upsert(ObjectRow {
            local_id: 2,
            parent_id: 1,
            pos: [0.5, 0.0, 0.0],
            ..Default::default()
        });
        t.upsert(ObjectRow {
            local_id: 3,
            parent_id: 1,
            pos: [1.0, 0.5, 0.0],
            ..Default::default()
        });
        let from = [128.0, 235.0, 2099.0];
        let root_d = t.list_distance(1, from);
        let child_d = t.list_distance(2, from);
        assert!((root_d - 4.5).abs() < 2.0, "root distance {root_d}");
        assert!(
            (child_d - root_d).abs() < 2.0,
            "child should track root, root={root_d} child={child_d}"
        );
    }

    #[test]
    fn full_update_position_follows_the_blob_length() {
        // Object form (60): the position leads.
        let mut obj = Vec::new();
        for v in [1.5f32, 2.5, 3.5] {
            obj.extend_from_slice(&v.to_le_bytes());
        }
        obj.extend_from_slice(&[0u8; 48]); // velocity, accel, rot, angular velocity
        assert_eq!(position_from_object_data(&obj), Some([1.5, 2.5, 3.5]));

        // Avatar form (76): a 16-byte collision plane comes FIRST. Reading it
        // as the position put every avatar at the region corner (0,0,1).
        let mut av = Vec::new();
        for v in [0.0f32, 0.0, 1.0, 20.0] {
            av.extend_from_slice(&v.to_le_bytes());
        }
        av.extend_from_slice(&obj);
        assert_eq!(av.len(), 76);
        assert_eq!(position_from_object_data(&av), Some([1.5, 2.5, 3.5]));

        // The extended-data forms (124/140) keep the same offsets.
        let mut av140 = av.clone();
        av140.resize(140, 0);
        assert_eq!(position_from_object_data(&av140), Some([1.5, 2.5, 3.5]));
        let mut obj124 = obj.clone();
        obj124.resize(124, 0);
        assert_eq!(position_from_object_data(&obj124), Some([1.5, 2.5, 3.5]));

        // Quantized object form (32): u16 midpoint decodes near the middle of
        // the [-128, 384] range; the avatar form (48) skips the plane first.
        let mut q = Vec::new();
        q.extend_from_slice(&0x8000u16.to_le_bytes()); // x ~ 128
        q.extend_from_slice(&0x8000u16.to_le_bytes()); // y ~ 128
        q.extend_from_slice(&0u16.to_le_bytes()); // z = 0
        q.resize(32, 0);
        let p = position_from_object_data(&q).expect("quantized object form");
        assert!((p[0] - 128.0).abs() < 0.5 && (p[1] - 128.0).abs() < 0.5);
        let mut q48 = vec![0u8; 16];
        q48.extend_from_slice(&q[..6]);
        q48.resize(48, 0);
        let p = position_from_object_data(&q48).expect("quantized avatar form");
        assert!((p[0] - 128.0).abs() < 0.5, "plane must be skipped, got x={}", p[0]);

        // Unknown lengths are refused rather than misread.
        assert!(position_from_object_data(&[0u8; 44]).is_none());
        assert!(position_from_object_data(&[0u8; 16]).is_none());
        assert!(position_from_object_data(&[]).is_none());
    }

    #[test]
    fn ids_survive_the_round_trip_and_bad_input() {
        let text = "aabbccdd-1122-3344-5566-778899aabbcc";
        assert_eq!(id_string(&id_bytes(text)), text);
        // Uppercase and undashed forms parse to the same key, which is what makes
        // set_props match regardless of how the sim spelled the id.
        assert_eq!(id_bytes("AABBCCDD11223344 5566-778899AABBCC"), id_bytes(text));
        // Junk yields the null id rather than a panic or a wrong match.
        assert!(is_zero_id(&id_bytes("nonsense")));
        assert!(is_zero_id(&id_bytes("")));
    }

    #[test]
    fn the_list_never_shows_the_same_object_twice() {
        // Objects are keyed by local id, so repeated updates - which the sim sends
        // constantly for anything that moves - must refresh a row, never add one.
        let mut t = ObjectTable::default();
        let row = |pos: [f32; 3]| ObjectRow {
            local_id: 77,
            full_id: id_bytes("cc000000-0000-0000-0000-000000000003"),
            pos,
            ..Default::default()
        };
        t.upsert(row([1.0, 0.0, 0.0]));
        t.upsert(row([2.0, 0.0, 0.0]));
        t.upsert(row([3.0, 0.0, 0.0]));
        assert_eq!(t.len(), 1, "repeat updates must not duplicate the row");
        let rows = t.nearby([0.0, 0.0, 0.0], 100.0);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0.pos[0], 3.0, "the newest position wins");
    }

    #[test]
    fn clearing_frees_everything_for_a_new_region() {
        let mut t = ObjectTable::default();
        for id in 1..=5u32 {
            t.upsert(ObjectRow { local_id: id, full_id: id_bytes(&format!("{id:032x}")), ..Default::default() });
        }
        assert_eq!(t.len(), 5);
        t.clear();
        assert!(t.is_empty());
        assert!(t.nearby([0.0; 3], 100.0).is_empty());
        assert_eq!(t.cached_id_count(), 0);
        // And a cleared table reports every id as unknown again, so the cached-update
        // path will re-request them in the new region.
        assert!(!t.contains(3));
        // Nothing is left waiting to be re-requested either.
        assert!(t.take_dropped((0, 0), 100).is_empty());
    }

    #[test]
    fn a_failed_teleport_can_ask_for_the_region_again() {
        let mut t = ObjectTable::default();
        for id in 1..=5u32 {
            t.upsert(ObjectRow { local_id: id, ..Default::default() });
        }
        t.clear_for_teleport((1000, 1000));
        assert!(t.is_empty(), "the rows themselves must go");

        // Still in the region we dropped them for: hand them back in batches, and only
        // once each, so repeated presses of Load work through the list.
        let first = t.take_dropped((1000, 1000), 3);
        assert_eq!(first.len(), 3);
        let rest = t.take_dropped((1000, 1000), 3);
        assert_eq!(rest.len(), 2);
        assert!(t.take_dropped((1000, 1000), 3).is_empty());
        let mut all: Vec<u32> = first.into_iter().chain(rest).collect();
        all.sort();
        assert_eq!(all, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn dropped_ids_are_never_used_in_another_region() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow { local_id: 7, ..Default::default() });
        t.clear_for_teleport((1000, 1000));
        // The teleport worked. LocalIDs mean nothing here, so they must be forgotten
        // rather than asked about - another sim's object could share the number.
        assert!(t.take_dropped((1001, 1000), 100).is_empty());
        assert!(t.take_dropped((1000, 1000), 100).is_empty(), "and not come back");
    }

    #[test]
    fn nearby_sorts_by_distance_and_includes_child_prims() {
        let mut t = ObjectTable::default();
        let mk = |id: u32, pos: [f32; 3], parent: u32| ObjectRow {
            local_id: id,
            full_id: id_bytes(&format!("{id:032x}")),
            parent_id: parent,
            pos,
            ..Default::default()
        };
        t.upsert(mk(1, [10.0, 0.0, 0.0], 0));
        t.upsert(mk(2, [2.0, 0.0, 0.0], 0));
        t.upsert(mk(3, [1.0, 0.0, 0.0], 2)); // child of 2 -> region pos [3, 0, 0]
        t.upsert(mk(4, [500.0, 0.0, 0.0], 0)); // out of range
        let rows = t.nearby([0.0, 0.0, 0.0], 100.0);
        assert_eq!(rows.len(), 3, "child prims count; distant objects are excluded");
        assert_eq!(rows[0].0.local_id, 2, "nearest first");
        assert_eq!(rows[1].0.local_id, 3, "child at parent offset");
        assert_eq!(rows[2].0.local_id, 1);
        assert!((rows[1].1[0] - 3.0).abs() < 0.01, "child uses region position");
    }

    #[test]
    fn props_merge_onto_the_right_object_and_updates_keep_them() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow {
            local_id: 5,
            full_id: id_bytes("aa000000-0000-0000-0000-000000000001"),
            pos: [1.0, 1.0, 1.0],
            ..Default::default()
        });
        t.set_props(
            "AA000000-0000-0000-0000-000000000001",
            "Chair",
            "bb000000-0000-0000-0000-000000000002",
            "cc000000-0000-0000-0000-000000000003",
            250,
            2,
        );
        // A later movement update must not wipe the name we just fetched.
        t.upsert(ObjectRow {
            local_id: 5,
            full_id: id_bytes("aa000000-0000-0000-0000-000000000001"),
            pos: [2.0, 1.0, 1.0],
            ..Default::default()
        });
        let rows = t.nearby([0.0, 0.0, 0.0], 100.0);
        assert_eq!(rows[0].0.name.as_deref(), Some("Chair"));
        assert_eq!(id_string(&rows[0].0.owner_id), "bb000000-0000-0000-0000-000000000002");
        assert_eq!(id_string(&rows[0].0.creator_id), "cc000000-0000-0000-0000-000000000003");
        assert_eq!(rows[0].0.pos[0], 2.0);
        assert!(t.take_needing_props([0.0; 3], 100.0, 10, 1000, 30_000).is_empty());
    }

    /// The drain has to cover everything in range and ask about each object once - it's
    /// the "asked" marking that makes it terminate instead of re-requesting the same
    /// batch until the replies land.
    #[test]
    fn the_drain_covers_everything_in_range_exactly_once() {
        let mut t = ObjectTable::default();
        for id in 1..=10u32 {
            t.upsert(ObjectRow {
                local_id: id,
                full_id: id_bytes(&format!("{id:032x}")),
                pos: [id as f32, 0.0, 0.0],
                ..Default::default()
            });
        }
        // Something well outside the radius must be left alone.
        t.upsert(ObjectRow { local_id: 99, pos: [400.0, 0.0, 0.0], ..Default::default() });

        let mut seen: Vec<u32> = Vec::new();
        loop {
            let batch = t.take_needing_props([0.0; 3], 64.0, 4, 1000, 30_000);
            if batch.is_empty() {
                break;
            }
            assert!(batch.len() <= 4, "batches stay bounded");
            seen.extend(batch);
        }
        seen.sort();
        assert_eq!(seen, (1..=10).collect::<Vec<u32>>(), "everything in range, nothing twice");
        assert!(!seen.contains(&99), "and nothing out of range");

        // Load presses again: the ones that never answered become askable once more.
        t.set_props(&format!("{:032x}", 3), "Lamp", "", "", 0, 0);
        t.allow_props_retry();
        let retry = t.take_needing_props([0.0; 3], 64.0, 64, 1000, 30_000);
        assert_eq!(retry.len(), 9, "the one that answered isn't asked again");
        assert!(!retry.contains(&3));
    }

    /// A wider radius means more rows, not a truncated list.
    #[test]
    fn the_radius_decides_the_list_and_nothing_is_capped() {
        let mut t = ObjectTable::default();
        for id in 1..=200u32 {
            t.upsert(ObjectRow {
                local_id: id,
                pos: [(id as f32) * 0.5, 0.0, 0.0], // 0.5m apart, out to 100m
                ..Default::default()
            });
        }
        assert_eq!(t.nearby([0.0; 3], 16.0).len(), 32);
        assert_eq!(t.nearby([0.0; 3], 32.0).len(), 64);
        assert_eq!(t.nearby([0.0; 3], 128.0).len(), 200, "no ceiling on the result");
        assert_eq!(t.pending_props([0.0; 3], 32.0), 64);
    }

    /// The Family reply has no creator in it, so it must not blank one we already got
    /// from a full properties reply.
    #[test]
    fn a_family_reply_does_not_erase_a_known_creator() {
        let mut t = ObjectTable::default();
        let id = "aa000000-0000-0000-0000-000000000009";
        t.upsert(ObjectRow { local_id: 9, full_id: id_bytes(id), ..Default::default() });
        t.set_props(id, "Bench", "", "cc000000-0000-0000-0000-000000000003", 0, 0);
        t.set_props(id, "Bench", "bb000000-0000-0000-0000-000000000002", "", 0, 0);
        let rows = t.nearby([0.0; 3], 100.0);
        assert_eq!(id_string(&rows[0].0.creator_id), "cc000000-0000-0000-0000-000000000003");
        assert_eq!(id_string(&rows[0].0.owner_id), "bb000000-0000-0000-0000-000000000002");
    }

    #[test]
    fn skybox_linkset_child_resolves_at_altitude() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow {
            local_id: 10,
            parent_id: 0,
            pos: [128.0, 235.0, 37.0],
            ..Default::default()
        });
        t.upsert(ObjectRow {
            local_id: 11,
            parent_id: 10,
            pos: [0.0, 0.0, 983.0],
            ..Default::default()
        });
        let from = [128.0, 235.0, 1020.0];
        let rows = t.nearby(from, 128.0);
        // The child resolves at altitude through the REAL parent chain; the
        // ground root itself is truthfully 983m below and out of range.
        assert_eq!(rows.len(), 1, "only the platform piece is within 128m");
        let (_, platform_pos) = rows.iter().find(|(r, _)| r.local_id == 11).expect("platform");
        assert!((platform_pos[2] - 1020.0).abs() < 0.1);
        let (_, _roots, _nr, nearest) = t.census(from);
        assert!(nearest < 5.0, "nearest prim should be under your feet, not 983m away");
    }

    #[test]
    fn agent_region_pos_resolves_the_avatar_row() {
        let mut t = ObjectTable::default();
        let agent = "aa000000-0000-0000-0000-000000000001";
        t.upsert(ObjectRow {
            local_id: 42,
            full_id: id_bytes(agent),
            pcode: PCODE_AVATAR,
            pos: [128.0, 235.0, 2099.0],
            ..Default::default()
        });
        let pos = t.agent_region_pos(agent).expect("avatar pos");
        assert!((pos[2] - 2099.0).abs() < 0.1);
    }

    // A root's update position is region-relative on the wire and must be
    // trusted verbatim - the two scenarios below used to be "corrected".
    #[test]
    fn sky_root_in_the_sw_quadrant_keeps_its_exact_position() {
        let mut t = ObjectTable::default();
        // A ground root that a re-anchoring guess would have latched onto.
        t.upsert(ObjectRow { local_id: 1, parent_id: 0, pos: [50.0, 50.0, 20.0], ..Default::default() });
        // A genuine platform root at (100,100,2000): x<128, y<128, z>64.
        t.upsert(ObjectRow { local_id: 2, parent_id: 0, pos: [100.0, 100.0, 2000.0], ..Default::default() });
        assert_eq!(t.region_pos(2), Some([100.0, 100.0, 2000.0]));
        // Standing right next to it, the distance is meters - not a re-anchor
        // to groundRoot.xy + offset.
        let eye = [102.0, 100.0, 2020.0];
        assert!(t.list_distance(2, eye) < 25.0, "got {}", t.list_distance(2, eye));
    }

    #[test]
    fn ground_object_below_a_skybox_is_not_storey_snapped() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow { local_id: 7, parent_id: 0, pos: [128.0, 128.0, 100.0], ..Default::default() });
        // Eye at 1080m, object 980m below - close to one "storey" of 983m,
        // which used to snap its Z onto the eye's altitude.
        let eye = [128.0, 128.0, 1080.0];
        let d = t.list_distance(7, eye);
        assert!((d - 980.0).abs() < 0.5, "true vertical distance, got {d}");
    }

    #[test]
    fn kill_object_removes_the_whole_linkset_but_not_seated_avatars() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow { local_id: 10, full_id: [0xAA; 16], parent_id: 0, ..Default::default() });
        t.upsert(ObjectRow { local_id: 11, full_id: [0xAB; 16], parent_id: 10, ..Default::default() });
        t.upsert(ObjectRow { local_id: 12, full_id: [0xAC; 16], parent_id: 11, ..Default::default() });
        // A visitor sitting on the couch is not part of the linkset.
        t.upsert(ObjectRow { local_id: 90, full_id: [0xEE; 16], parent_id: 10, pcode: PCODE_AVATAR, ..Default::default() });
        // An unrelated object stays.
        t.upsert(ObjectRow { local_id: 50, full_id: [0xDD; 16], parent_id: 0, ..Default::default() });
        t.remove(10);
        assert!(t.rows.get(&10).is_none());
        assert!(t.rows.get(&11).is_none(), "child must go with its killed root");
        assert!(t.rows.get(&12).is_none(), "grandchild too");
        assert!(t.rows.get(&90).is_some(), "a seated avatar is not furniture");
        assert!(t.rows.get(&50).is_some());
    }

    #[test]
    fn recycled_local_id_starts_clean_and_orphans_the_old_children() {
        let mut t = ObjectTable::default();
        // Old tenant: a couch root with a cushion child and fetched props.
        t.upsert(ObjectRow { local_id: 10, full_id: [0xAA; 16], parent_id: 0, ..Default::default() });
        t.set_props(&id_string(&[0xAA; 16]), "Old Couch", "", "", 0, 0);
        t.upsert(ObjectRow { local_id: 11, full_id: [0xAB; 16], parent_id: 10, ..Default::default() });
        // The sim recycles local id 10 for a completely different object.
        t.upsert(ObjectRow { local_id: 10, full_id: [0xBB; 16], parent_id: 0, ..Default::default() });
        let row = t.rows.get(&10).unwrap();
        assert_eq!(row.full_id, [0xBB; 16]);
        assert!(row.name.is_none(), "the newcomer must not wear the old tenant's name");
        assert!(!row.have_props, "props belong to the old object");
        assert!(
            t.rows.get(&11).is_none(),
            "the old tenant's children must not be grouped under the newcomer"
        );
        // Same full id, same local id: a normal update still merges (name kept).
        let mut t2 = ObjectTable::default();
        t2.upsert(ObjectRow { local_id: 20, full_id: [0xCC; 16], parent_id: 0, ..Default::default() });
        t2.set_props(&id_string(&[0xCC; 16]), "Kept", "", "", 0, 0);
        t2.upsert(ObjectRow { local_id: 20, full_id: [0xCC; 16], parent_id: 0, ..Default::default() });
        assert_eq!(t2.rows.get(&20).unwrap().name.as_deref(), Some("Kept"));
    }

    #[test]
    fn attachments_of_avatar_counts_only_that_avatars_roots() {
        let mut t = ObjectTable::default();
        let me = "aa000000-0000-0000-0000-000000000001";
        let other = "bb000000-0000-0000-0000-000000000002";
        // Two avatars...
        t.upsert(ObjectRow { local_id: 1, full_id: id_bytes(me), pcode: PCODE_AVATAR, parent_id: 0, ..Default::default() });
        t.upsert(ObjectRow { local_id: 2, full_id: id_bytes(other), pcode: PCODE_AVATAR, parent_id: 0, ..Default::default() });
        // ...two attachments on us (one with a child link), one on them, and a
        // free-standing prim.
        t.upsert(ObjectRow { local_id: 10, parent_id: 1, attachment_state: 6, ..Default::default() });
        t.upsert(ObjectRow { local_id: 11, parent_id: 1, attachment_state: 8, ..Default::default() });
        t.upsert(ObjectRow { local_id: 12, parent_id: 11, attachment_state: 8, ..Default::default() });
        t.upsert(ObjectRow { local_id: 20, parent_id: 2, attachment_state: 6, ..Default::default() });
        t.upsert(ObjectRow { local_id: 30, parent_id: 0, ..Default::default() });
        assert_eq!(t.attachments_of_avatar(me), 2, "only roots hanging off our own avatar");
        assert_eq!(t.attachments_of_avatar(other), 1);
    }

    #[test]
    fn attachments_of_avatar_without_avatar_row_is_zero() {
        let t = ObjectTable::default();
        assert_eq!(t.attachments_of_avatar("aa000000-0000-0000-0000-000000000001"), 0);
        assert_eq!(t.attachments_of_avatar(""), 0);
    }

    #[test]
    fn upsert_clears_avatar_parent_on_stand() {
        let mut t = ObjectTable::default();
        let agent = "aa000000-0000-0000-0000-000000000001";
        t.upsert(ObjectRow {
            local_id: 1,
            full_id: id_bytes(agent),
            pcode: PCODE_AVATAR,
            parent_id: 500,
            pos: [0.0, 0.0, 0.5],
            ..Default::default()
        });
        t.upsert(ObjectRow {
            local_id: 1,
            full_id: id_bytes(agent),
            pcode: PCODE_AVATAR,
            parent_id: 0,
            pos: [201.0, 171.0, 2088.0],
            ..Default::default()
        });
        let row = t.rows.get(&1).unwrap();
        assert_eq!(row.parent_id, 0);
        let pos = t.agent_region_pos(agent).expect("avatar pos");
        assert!((pos[2] - 2088.0).abs() < 0.1, "must not double-add seat offset, got {}", pos[2]);
    }

    #[test]
    fn attachments_list_without_pulling_in_sit_target() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow {
            local_id: 100,
            pcode: PCODE_AVATAR,
            full_id: id_bytes("aa000000-0000-0000-0000-000000000001"),
            parent_id: 0,
            pos: [200.0, 171.0, 2088.0],
            ..Default::default()
        });
        t.upsert(ObjectRow {
            local_id: 500,
            parent_id: 0,
            pos: [400.0, 400.0, 2088.0],
            ..Default::default()
        });
        t.upsert(ObjectRow {
            local_id: 200,
            parent_id: 100,
            attachment_state: 0x31,
            pos: [0.1, 0.0, 0.0],
            ..Default::default()
        });
        assert!(t.is_attachment(200));
        assert_eq!(t.root_local_id(200), 200);
        assert!(t.is_in_attachment(200));
        let from = [201.0, 171.0, 2088.5];
        let list = t.nearby_for_list(from, 48.0);
        assert!(
            !list.iter().any(|(r, _)| r.local_id == 500),
            "sit target must not appear via attachment ancestor walk"
        );
        assert!(
            list.iter().any(|(r, _)| r.local_id == 200),
            "attachment should be listable when in range"
        );
        let pos = t.region_pos(200).expect("attachment region position");
        assert!((pos[0] - 200.1).abs() < 0.2, "attachment x, got {}", pos[0]);
    }

    #[test]
    fn other_avatar_attachment_uses_coarse_radar_when_avatar_row_missing() {
        let mut t = ObjectTable::default();
        let other = id_bytes("bb000000-0000-0000-0000-000000000002");
        t.note_coarse_agent(
            "bb000000-0000-0000-0000-000000000002",
            [100.0, 100.0, 25.0],
        );
        t.upsert(ObjectRow {
            local_id: 201,
            owner_id: other,
            attachment_state: 0x31,
            pos: [0.0, 0.0, 1.0],
            ..Default::default()
        });
        let from = [100.5, 100.0, 25.0];
        let list = t.nearby_for_list(from, 8.0);
        assert!(
            list.iter().any(|(r, _)| r.local_id == 201),
            "attachment should list via coarse wearer position"
        );
    }

    #[test]
    fn other_avatar_attachment_anchors_via_owner_when_parent_unlinked() {
        let mut t = ObjectTable::default();
        let other = id_bytes("bb000000-0000-0000-0000-000000000002");
        t.upsert(ObjectRow {
            local_id: 50,
            full_id: other,
            pcode: PCODE_AVATAR,
            parent_id: 0,
            pos: [100.0, 100.0, 25.0],
            ..Default::default()
        });
        t.upsert(ObjectRow {
            local_id: 201,
            owner_id: other,
            attachment_state: 0x31,
            pos: [0.0, 0.0, 1.0],
            ..Default::default()
        });
        assert!(t.is_attachment(201));
        assert_eq!(t.attachment_anchor_avatar(201), Some(50));
        let pos = t.region_pos(201).expect("attachment position");
        assert!((pos[2] - 26.0).abs() < 0.1, "expected ~26m, got {}", pos[2]);
        let from = [100.5, 100.0, 25.0];
        let list = t.nearby_for_list(from, 8.0);
        assert!(
            list.iter().any(|(r, _)| r.local_id == 201),
            "other resident attachment should list when avatar is in range"
        );
    }

    #[test]
    fn temporary_flag_surfaces_in_row_json() {
        let row = ObjectRow {
            flags: FLAGS_TEMPORARY_ON_REZ | FLAGS_USE_PHYSICS,
            ..Default::default()
        };
        let json = row_json(&row, [0.0; 3], 1, 0.0, false);
        assert_eq!(json["temporary"], true);
        assert_eq!(json["physical"], true);
    }

    #[test]
    fn list_distance_matches_true_3d_offset() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow {
            local_id: 1,
            parent_id: 0,
            pos: [123.0, 235.0, 2003.0],
            ..Default::default()
        });
        let from = [128.0, 235.0, 2098.0];
        let d = t.list_distance(1, from);
        let expected = distance(from, [123.0, 235.0, 2003.0]);
        assert!((d - expected).abs() < 0.1, "got {d}, want {expected}");
        assert!(d > 90.0, "must include vertical separation, got {d}");
    }

    #[test]
    fn terse_improved_blob_decodes_position() {
        let mut blob = Vec::new();
        blob.extend_from_slice(&42u32.to_le_bytes());
        blob.push(0); // state
        blob.push(0); // not agent
        blob.extend_from_slice(&128.0f32.to_le_bytes());
        blob.extend_from_slice(&235.0f32.to_le_bytes());
        blob.extend_from_slice(&1020.0f32.to_le_bytes());
        let (id, pos) = decode_terse_improved(&blob).expect("decode");
        assert_eq!(id, 42);
        assert!((pos[2] - 1020.0).abs() < 0.01);
    }

    #[test]
    fn missing_parent_ids_lists_roots_we_still_need() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow { local_id: 11, parent_id: 10, ..Default::default() });
        assert_eq!(t.missing_parent_ids(), vec![10]);
        t.upsert(ObjectRow { local_id: 10, parent_id: 0, ..Default::default() });
        assert!(t.missing_parent_ids().is_empty());
    }

    #[test]
    fn cached_ids_survive_until_clear_and_drive_refetch() {
        let mut t = ObjectTable::default();
        t.note_cached_ids([1, 2, 3]);
        t.upsert(ObjectRow { local_id: 2, ..Default::default() });
        assert_eq!(t.cached_id_count(), 3);
        let missing = t.ids_missing_rows(10);
        assert_eq!(missing.len(), 2);
        assert!(missing.contains(&1));
        assert!(missing.contains(&3));
        t.clear();
        assert_eq!(t.cached_id_count(), 0);
        assert!(t.ids_missing_rows(10).is_empty());
    }

    #[test]
    fn coarse_radar_never_overwrites_a_precise_avatar_row() {
        let mut t = ObjectTable::default();
        let other = "bb000000-0000-0000-0000-000000000002";
        t.upsert(ObjectRow {
            local_id: 60,
            full_id: id_bytes(other),
            pcode: PCODE_AVATAR,
            parent_id: 0,
            pos: [128.34, 235.67, 25.1],
            ..Default::default()
        });
        // A radar packet quantized to whole meters (and a wildly wrong Z, as
        // happens when the sim reports "unknown") must stay in its own map.
        t.note_coarse_agent(other, [128.0, 235.0, 2000.0]);
        let pos = t.resident_region_pos(other).expect("resident pos");
        assert!((pos[2] - 25.1).abs() < 0.01, "the precise row wins, got z={}", pos[2]);
    }

    #[test]
    fn kill_object_prunes_cached_ids_so_load_stops_asking() {
        let mut t = ObjectTable::default();
        t.note_cached_ids([10, 11, 20]);
        t.upsert(ObjectRow { local_id: 10, parent_id: 0, ..Default::default() });
        t.upsert(ObjectRow { local_id: 11, parent_id: 10, ..Default::default() });
        // KillObject on the root: the whole linkset leaves the cached set too,
        // or every later Load would re-request the dead ids forever.
        t.remove(10);
        let missing = t.ids_missing_rows_all();
        assert_eq!(missing, vec![20], "only the never-seen id is still worth asking about");
    }

    #[test]
    fn perm_mask_text_decodes_common_bits() {
        assert_eq!(perm_mask_text(0), "none");
        assert_eq!(
            perm_mask_text(PERM_MODIFY | PERM_COPY | PERM_TRANSFER),
            "modify, copy, transfer"
        );
        assert_eq!(perm_mask_text(PERM_COPY), "copy");
    }

    /// Touch and Pay follow the sim's FLAGS_HANDLE_TOUCH / FLAGS_TAKES_MONEY bits.
    #[test]
    fn row_actions_follow_the_sims_flags() {
        let plain = ObjectRow::default();
        assert!(!plain.can_touch(), "a prim with no touch handler must not offer Touch");
        assert!(!plain.can_pay(), "and must not offer Pay");

        let touchy = ObjectRow { flags: FLAGS_HANDLE_TOUCH, ..Default::default() };
        assert!(touchy.can_touch());
        assert!(!touchy.can_pay(), "handling touch says nothing about taking money");

        let till = ObjectRow { flags: FLAGS_TAKES_MONEY | FLAGS_SCRIPTED, ..Default::default() };
        assert!(till.can_pay());

        // A pay click action is set by the same script that would take the money.
        let paybox = ObjectRow { click_action: CLICK_ACTION_PAY, ..Default::default() };
        assert!(paybox.can_pay());
    }

    /// Click action sits between Material and Scale in the compressed blob; reading it
    /// from the wrong offset would silently mislabel every row.
    #[test]
    fn compressed_blob_carries_the_click_action() {
        let mut blob = compressed_blob(7, [1.0, 2.0, 3.0], 0xcd, 0, 0);
        blob[21 + 6] = CLICK_ACTION_SIT;
        assert_eq!(decode_compressed(&blob).unwrap().0.click_action, CLICK_ACTION_SIT);
    }

    #[test]
    fn compressed_movement_preserves_attachment_parent_link() {
        let mut t = ObjectTable::default();
        t.upsert(ObjectRow {
            local_id: 100,
            pcode: PCODE_AVATAR,
            full_id: id_bytes("aa000000-0000-0000-0000-000000000001"),
            parent_id: 0,
            pos: [200.0, 171.0, 2088.0],
            ..Default::default()
        });
        let (row, true_parent) = decode_compressed(&compressed_blob(
            200,
            [0.1, 0.0, 0.0],
            0xaa,
            0x20,
            100,
        ))
        .expect("attachment with parent");
        assert!(true_parent);
        t.upsert_compressed(row, true_parent);
        let (move_only, false_parent) = decode_compressed(&compressed_blob(
            200,
            [0.2, 0.0, 0.0],
            0xaa,
            0,
            0,
        ))
        .expect("movement without parent field");
        assert!(!false_parent);
        t.upsert_compressed(move_only, false_parent);
        let stored = t.rows.get(&200).expect("attachment row");
        assert_eq!(stored.parent_id, 100, "parent link must survive movement-only updates");
        assert!(t.is_attachment(200));
        let from = [200.1, 171.0, 2088.5];
        assert!(
            t.nearby_for_list(from, 8.0)
                .iter()
                .any(|(r, _)| r.local_id == 200),
            "attachment should stay listable after parent-preserving upsert"
        );
    }
}
