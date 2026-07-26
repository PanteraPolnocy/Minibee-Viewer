//! A light object table for the "Objects nearby" list.
//!
//! The viewer has no 3D world, but it still has to follow object updates the way a
//! full viewer does: the sim describes a region's contents when you ARRIVE, so a list
//! built on demand would find nothing. Tracking therefore runs from login onward and
//! the table is dropped when you teleport to another region.
//!
//! Only ever one region's worth of objects lives here. A full viewer keeps its
//! neighbours connected and holds their objects too, dropping them per-region when a
//! sim disconnects; we deliberately ignore EnableSimulator, so there is only one
//! circuit and only one region to track.
//!
//! We keep only what the list and detail views need: id, position, owner, parent and
//! a few flags. No textures, no mesh, no inventory.

use std::collections::HashMap;

use serde_json::{json, Value};

/// PCode for a primitive; avatars (47) and the rest are not "objects nearby".
const PCODE_PRIM: u8 = 9;

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
#[derive(Debug, Clone, Default)]
pub struct ObjectRow {
    pub local_id: u32,
    pub full_id: [u8; 16],
    pub owner_id: [u8; 16],
    /// Who made it. Only the full ObjectProperties reply carries this, so it stays zero
    /// until the properties round-trip finishes.
    pub creator_id: [u8; 16],
    pub parent_id: u32,
    /// Region-local position, metres.
    pub pos: [f32; 3],
    /// Filled in later, from the properties reply. Boxed so an unnamed object costs a
    /// pointer rather than a full String.
    pub name: Option<Box<str>>,
    pub sale_price: i32,
    pub sale_type: u8,
    /// The sim's UpdateFlags word (object_flags.h). This is what says whether an object
    /// answers a touch or takes money, so it decides which row actions make sense.
    pub flags: u32,
    /// llSetClickAction, from the update itself. CLICK_ACTION_SIT and friends.
    pub click_action: u8,
    /// True once properties have arrived, so we ask only once per object.
    pub have_props: bool,
    /// True once a request has gone out. Without this the drain would re-ask for the
    /// same objects on its next pass, because a reply takes longer to come back than
    /// the next batch takes to leave. The reference marks its rows SENT for exactly the
    /// same reason (FSObjectProperties::SENT).
    pub asked_props: bool,
}

/// Sim-to-viewer object flags we act on (object_flags.h).
pub const FLAGS_SCRIPTED: u32 = 1 << 6;
pub const FLAGS_HANDLE_TOUCH: u32 = 1 << 7;
pub const FLAGS_TAKES_MONEY: u32 = 1 << 9;

/// Click actions we care about (indra_constants.h).
pub const CLICK_ACTION_SIT: u8 = 1;
pub const CLICK_ACTION_BUY: u8 = 2;
pub const CLICK_ACTION_PAY: u8 = 3;

impl ObjectRow {
    /// Would a touch reach a script? `enable_object_touch` in the reference checks
    /// `flagHandleTouch()` on the object or its parent; we only list root prims, so
    /// there's no parent to consult. A click action of "touch" doesn't imply a handler,
    /// but PAY and BUY both mean somebody scripted an interaction.
    pub fn can_touch(&self) -> bool {
        self.flags & FLAGS_HANDLE_TOUCH != 0
    }

    /// `enable_pay_object` in llviewermenu.cpp: flagTakesMoney on the object or its
    /// parent, nothing else. A pay click action counts too - it's set by the same script
    /// that would take the money.
    pub fn can_pay(&self) -> bool {
        self.flags & FLAGS_TAKES_MONEY != 0 || self.click_action == CLICK_ACTION_PAY
    }
}

/// 16 raw bytes as the canonical UUID string, for the UI.
pub fn id_string(b: &[u8; 16]) -> String {
    let s: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &s[0..8], &s[8..12], &s[12..16], &s[16..20], &s[20..32])
}

/// Parse a UUID string (with or without dashes) into raw bytes.
pub fn id_bytes(s: &str) -> [u8; 16] {
    let hex: Vec<u8> = s.bytes().filter(|c| c.is_ascii_hexdigit()).collect();
    let mut out = [0u8; 16];
    if hex.len() < 32 {
        return out;
    }
    for (i, slot) in out.iter_mut().enumerate() {
        let hi = (hex[i * 2] as char).to_digit(16).unwrap_or(0) as u8;
        let lo = (hex[i * 2 + 1] as char).to_digit(16).unwrap_or(0) as u8;
        *slot = (hi << 4) | lo;
    }
    out
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
/// The layout depends on the length (llviewerobject.cpp): 60 bytes is full
/// precision - position, velocity, acceleration, rotation and angular velocity as
/// three floats each - and position is simply the first vector. The quantised 32
/// and 16 byte forms are for moving objects mid-flight; we skip those rather than
/// guess, since a fresh full update always follows.
pub fn position_from_object_data(data: &[u8]) -> Option<[f32; 3]> {
    if data.len() >= 60 {
        vec3_at(data, 0)
    } else {
        None
    }
}

/// Decode one ObjectUpdateCompressed data blob.
///
/// Field order is taken straight from the reference: the list code reads
/// FullID, LocalID and PCode (llviewerobjectlist.cpp), then
/// LLViewerObject::processUpdateMessage reads State, CRC, Material, ClickAction,
/// Scale, Pos, Rot, a flags word and the owner id. The flags then say whether
/// angular velocity and a parent id follow, which is why they're read in order.
pub fn decode_compressed(data: &[u8]) -> Option<ObjectRow> {
    let mut full_id = [0u8; 16];
    full_id.copy_from_slice(data.get(0..16)?);
    let local_id = u32_at(data, 16)?;
    let pcode = *data.get(20)?;
    if pcode != PCODE_PRIM {
        return None; // avatars and friends aren't objects for this list
    }
    // State(1) CRC(4) Material(1) then ClickAction(1), then Scale(12), Pos(12),
    // Rot(12), SpecialCode(4), Owner(16).
    let click_action = *data.get(21 + 6)?;
    let mut off = 21 + 7 + 12;
    let pos = vec3_at(data, off)?;
    off += 12 + 12; // past Pos and Rot
    let special = u32_at(data, off)?;
    off += 4;
    let mut owner_id = [0u8; 16];
    owner_id.copy_from_slice(data.get(off..off + 16)?);
    off += 16;
    if special & 0x80 != 0 {
        off += 12; // angular velocity
    }
    let parent_id = if special & 0x20 != 0 {
        u32_at(data, off).unwrap_or(0)
    } else {
        0
    };
    Some(ObjectRow {
        local_id,
        full_id,
        owner_id,
        parent_id,
        pos,
        click_action,
        ..Default::default()
    })
}

/// The table itself, plus the bookkeeping the list command needs.
#[derive(Debug, Default, Clone)]
pub struct ObjectTable {
    rows: HashMap<u32, ObjectRow>,
    /// LocalIDs of rows thrown away on the way out of a region - see
    /// `clear_for_teleport`. Empty unless a teleport is in flight.
    dropped: Vec<u32>,
    /// Which region those ids belong to. LocalIDs mean nothing outside it.
    dropped_region: (i64, i64),
}

impl ObjectTable {
    /// Forget everything. Assigning a fresh map rather than calling `clear` hands the
    /// buckets back to the allocator instead of holding a busy region's worth of
    /// capacity for the rest of the session.
    pub fn clear(&mut self) {
        self.rows = HashMap::new();
        self.forget_dropped();
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

    /// Merge a decoded update, keeping any properties we've already fetched.
    pub fn upsert(&mut self, row: ObjectRow) {
        if self.rows.len() >= MAX_OBJECTS && !self.rows.contains_key(&row.local_id) {
            // Say so rather than quietly under-report the region. Once is enough - this
            // would otherwise fire for every further update in a full region.
            if self.rows.len() == MAX_OBJECTS {
                crate::dlog!("object table full at {MAX_OBJECTS}; further objects ignored");
            }
            return;
        }
        match self.rows.get_mut(&row.local_id) {
            Some(existing) => {
                existing.full_id = row.full_id;
                existing.parent_id = row.parent_id;
                existing.pos = row.pos;
                existing.click_action = row.click_action;
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
                self.rows.insert(row.local_id, row);
            }
        }
    }

    /// Do we already know this object? Lets the cached-update path ask only for the
    /// ones we're missing.
    pub fn contains(&self, local_id: u32) -> bool {
        self.rows.contains_key(&local_id)
    }

    /// Where an object is, by LocalID. Needed to turn a seated avatar's parent-relative
    /// position into a region one.
    pub fn position_of(&self, local_id: u32) -> Option<[f32; 3]> {
        self.rows.get(&local_id).map(|r| r.pos)
    }

    pub fn remove(&mut self, local_id: u32) {
        self.rows.remove(&local_id);
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

    /// Root objects within `range` metres of `from`, nearest first.
    ///
    /// Child prims are left out: a linkset should appear once, under its root, which
    /// is also what keeps the list readable.
    pub fn nearby(&self, from: [f32; 3], range: f32) -> Vec<&ObjectRow> {
        let mut out: Vec<&ObjectRow> = self
            .rows
            .values()
            .filter(|r| r.parent_id == 0)
            .filter(|r| distance(from, r.pos) <= range)
            .collect();
        out.sort_by(|a, b| {
            distance(from, a.pos)
                .partial_cmp(&distance(from, b.pos))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out
    }

    /// Objects in range we haven't asked about yet, nearest first, up to `limit`.
    ///
    /// Marks each one as asked, so successive calls walk through the whole set instead
    /// of handing back the same batch until the replies land. That's what makes the
    /// drain terminate and what stops us asking twice.
    pub fn take_needing_props(&mut self, from: [f32; 3], range: f32, limit: usize) -> Vec<u32> {
        let ids: Vec<u32> = self
            .nearby(from, range)
            .into_iter()
            .filter(|r| !r.have_props && !r.asked_props)
            .take(limit)
            .map(|r| r.local_id)
            .collect();
        for id in &ids {
            if let Some(row) = self.rows.get_mut(id) {
                row.asked_props = true;
            }
        }
        ids
    }

    /// Let anything still unnamed be asked about again.
    ///
    /// A request can go unanswered - the sim drops it, or we walked out of range and
    /// back - and an object marked as asked would then stay nameless for good. Pressing
    /// Load clears the marks, so it doubles as the retry the reference gets from its
    /// FAILED/timeout bookkeeping.
    pub fn allow_props_retry(&mut self) {
        for row in self.rows.values_mut() {
            if !row.have_props {
                row.asked_props = false;
            }
        }
    }

    /// `(objects tracked, of which root prims, distance to the closest root)` measured from
    /// `from`. Purely for the log - it's what distinguishes "the sim told us nothing" from
    /// "we're looking in the wrong place".
    pub fn census(&self, from: [f32; 3]) -> (usize, usize, f32) {
        let mut roots = 0usize;
        let mut nearest = f32::MAX;
        for r in self.rows.values().filter(|r| r.parent_id == 0) {
            roots += 1;
            let d = distance(from, r.pos);
            if d < nearest {
                nearest = d;
            }
        }
        (self.rows.len(), roots, if roots == 0 { -1.0 } else { nearest })
    }

    /// How many in-range objects are still waiting on a reply. Only for reporting.
    pub fn pending_props(&self, from: [f32; 3], range: f32) -> usize {
        self.nearby(from, range).into_iter().filter(|r| !r.have_props).count()
    }
}

pub fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}

/// Shape one row for the UI. Distance is precomputed here so the list can sort on
/// it without repeating the maths in JS.
pub fn row_json(row: &ObjectRow, from: [f32; 3]) -> Value {
    json!({
        "localId": row.local_id,
        "id": id_string(&row.full_id),
        "name": row.name.as_deref().unwrap_or(""),
        "ownerId": if is_zero_id(&row.owner_id) { String::new() } else { id_string(&row.owner_id) },
        "creatorId": if is_zero_id(&row.creator_id) { String::new() } else { id_string(&row.creator_id) },
        "distance": (distance(from, row.pos) * 10.0).round() / 10.0,
        "position": { "x": row.pos[0], "y": row.pos[1], "z": row.pos[2] },
        "salePrice": row.sale_price,
        "saleType": row.sale_type,
        "forSale": row.sale_type > 0 && row.sale_price > 0,
        "haveProps": row.have_props,
        // What the row is actually allowed to do, decided the way the reference decides
        // it - so the UI can hide an action instead of offering one that does nothing.
        "canTouch": row.can_touch(),
        "canPay": row.can_pay(),
        "scripted": row.flags & FLAGS_SCRIPTED != 0,
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
    fn decodes_compressed_position_and_owner() {
        let blob = compressed_blob(4242, [10.0, 20.0, 30.0], 0xAB, 0, 0);
        let row = decode_compressed(&blob).expect("decoded");
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
        let row = decode_compressed(&blob).expect("decoded");
        assert_eq!(row.parent_id, 99, "omega must be skipped before the parent id");
        // Without 0x80 the parent sits 12 bytes earlier.
        let blob2 = compressed_blob(8, [0.0, 0.0, 0.0], 1, 0x20, 55);
        assert_eq!(decode_compressed(&blob2).unwrap().parent_id, 55);
    }

    #[test]
    fn ignores_non_prims_and_short_blobs() {
        let mut blob = compressed_blob(1, [0.0; 3], 1, 0, 0);
        blob[20] = 47; // avatar PCode
        assert!(decode_compressed(&blob).is_none());
        assert!(decode_compressed(&[0u8; 8]).is_none());
    }

    #[test]
    fn full_update_position_needs_the_uncompressed_form() {
        let mut data = Vec::new();
        for v in [1.5f32, 2.5, 3.5] {
            data.extend_from_slice(&v.to_le_bytes());
        }
        data.extend_from_slice(&[0u8; 48]); // velocity, accel, rot, angular velocity
        assert_eq!(position_from_object_data(&data), Some([1.5, 2.5, 3.5]));
        // Quantised forms are skipped rather than misread.
        assert!(position_from_object_data(&[0u8; 32]).is_none());
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
        assert_eq!(rows[0].pos[0], 3.0, "the newest position wins");
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
    fn nearby_sorts_by_distance_and_hides_child_prims() {
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
        t.upsert(mk(3, [1.0, 0.0, 0.0], 2)); // child of 2
        t.upsert(mk(4, [500.0, 0.0, 0.0], 0)); // out of range
        let rows = t.nearby([0.0, 0.0, 0.0], 100.0);
        assert_eq!(rows.len(), 2, "child prims and distant objects are excluded");
        assert_eq!(rows[0].local_id, 2, "nearest first");
        assert_eq!(rows[1].local_id, 1);
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
        assert_eq!(rows[0].name.as_deref(), Some("Chair"));
        assert_eq!(id_string(&rows[0].owner_id), "bb000000-0000-0000-0000-000000000002");
        assert_eq!(id_string(&rows[0].creator_id), "cc000000-0000-0000-0000-000000000003");
        assert_eq!(rows[0].pos[0], 2.0);
        assert!(t.take_needing_props([0.0; 3], 100.0, 10).is_empty());
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
            let batch = t.take_needing_props([0.0; 3], 64.0, 4);
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
        let retry = t.take_needing_props([0.0; 3], 64.0, 64);
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
        assert_eq!(id_string(&rows[0].creator_id), "cc000000-0000-0000-0000-000000000003");
        assert_eq!(id_string(&rows[0].owner_id), "bb000000-0000-0000-0000-000000000002");
    }

    /// Touch and Pay are offered only when the sim says the object handles them - the
    /// same test the reference makes in enable_object_touch / enable_pay_object.
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
        assert_eq!(decode_compressed(&blob).unwrap().click_action, CLICK_ACTION_SIT);
    }
}
