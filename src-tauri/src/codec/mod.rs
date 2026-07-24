//! A generic codec for Second Life's UDP packets, driven by `message_template.msg`.
//!
//! Every decoded packet comes back as JSON, carrying: name, id, seq, flags, reliable, acks, blocks.
//! Byte fields are base64; U64 and S64 values arrive as decimal strings.

pub mod llsd;
pub mod template;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Map, Value};

use template::{FieldType, Frequency, MessageDef, Quantity, Registry};

pub const FLAG_ACK: u8 = 0x10;
pub const FLAG_RESENT: u8 = 0x20;
pub const FLAG_RELIABLE: u8 = 0x40;
pub const FLAG_ZEROCODED: u8 = 0x80;

// ---------------------------------------------------------------------------
// Zerocoding: run-length encoding of runs of zero bytes.
// ---------------------------------------------------------------------------

/// Run-length encode the zero runs in `buf[start..=end]`, leaving `buf[0..start]` untouched.
pub fn zerocode_encode(buf: &[u8], start: usize, end: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(buf.len() + 16);
    out.extend_from_slice(&buf[0..start]);
    let mut zero: u32 = 0;
    for &b in &buf[start..=end] {
        if b == 0 {
            zero += 1;
            continue;
        }
        while zero > 0 {
            let run = zero.min(255) as u8;
            out.push(0);
            out.push(run);
            zero -= run as u32;
        }
        out.push(b);
    }
    while zero > 0 {
        let run = zero.min(255) as u8;
        out.push(0);
        out.push(run);
        zero -= run as u32;
    }
    out
}

/// Expand a zerocoded UDP payload; the first 6 header bytes are copied through verbatim.
pub fn zerocode_expand(input: &[u8]) -> Vec<u8> {
    const HDR: usize = 6;
    // Cap the expanded size at the reference viewer's NET_BUFFER_SIZE (0x2000). A well-formed
    // SL message never grows past this, but an all-zero zerocoded datagram amplifies
    // roughly 256x, so without the cap a ~64KB malicious packet would balloon to ~16MB - a
    // remote memory/CPU DoS, and nastier still on the memory-constrained Android target.
    const MAX_EXPANDED: usize = 0x2000;
    let n = input.len();
    let mut out = Vec::with_capacity((n * 2 + HDR).min(MAX_EXPANDED));
    for k in 0..HDR.min(n) {
        out.push(input[k]);
    }
    if !out.is_empty() {
        out[0] &= !FLAG_ZEROCODED;
    }
    let mut i = HDR;
    while i < n && out.len() < MAX_EXPANDED {
        let b = input[i];
        i += 1;
        out.push(b);
        if b == 0 {
            // Each consecutive literal zero expands into its own 256-zero block.
            while i < n && input[i] == 0 && out.len() < MAX_EXPANDED {
                out.push(0);
                out.extend(std::iter::repeat(0).take(255));
                i += 1;
            }
            if i >= n {
                break;
            }
            let count = input[i];
            i += 1;
            out.extend(std::iter::repeat(0).take(count.saturating_sub(1) as usize));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Message-id framing on the wire.
// ---------------------------------------------------------------------------

fn write_message_id(out: &mut Vec<u8>, def: &MessageDef) {
    match def.frequency {
        Frequency::High => out.push((def.id & 0xFF) as u8),
        Frequency::Medium => {
            out.push(0xFF);
            out.push((def.id & 0xFF) as u8);
        }
        Frequency::Low => {
            out.push(0xFF);
            out.push(0xFF);
            out.push(((def.id >> 8) & 0xFF) as u8);
            out.push((def.id & 0xFF) as u8);
        }
        Frequency::Fixed => out.extend_from_slice(&def.id.to_be_bytes()),
    }
}

/// Returns the pair `(message_id, bytes_consumed)`.
fn read_message_id(buf: &[u8], pos: usize) -> Option<(u32, usize)> {
    let first = *buf.get(pos)?;
    if first == 0xFF {
        let second = *buf.get(pos + 1)?;
        if second == 0xFF {
            let hi = *buf.get(pos + 2)?;
            let lo = *buf.get(pos + 3)?;
            let id = 0xFFFF_0000 | ((hi as u32) << 8) | (lo as u32);
            return Some((id, pos + 4));
        }
        return Some((0xFF00 | second as u32, pos + 2));
    }
    Some((first as u32, pos + 1))
}

// ---------------------------------------------------------------------------
// Reader - sequential reads over the decoded payload that never panic on a short buffer.
// ---------------------------------------------------------------------------

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8], pos: usize) -> Self {
        Reader { buf, pos }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.pos + n > self.buf.len() {
            return None;
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u16le(&mut self) -> Option<u16> {
        let s = self.take(2)?;
        Some(u16::from_le_bytes([s[0], s[1]]))
    }
    fn u16be(&mut self) -> Option<u16> {
        let s = self.take(2)?;
        Some(u16::from_be_bytes([s[0], s[1]]))
    }
    fn u32le(&mut self) -> Option<u32> {
        let s = self.take(4)?;
        Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u64le(&mut self) -> Option<u64> {
        let s = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        Some(u64::from_le_bytes(a))
    }
    fn f32le(&mut self) -> Option<f32> {
        let s = self.take(4)?;
        Some(f32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn f64le(&mut self) -> Option<f64> {
        let s = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        Some(f64::from_le_bytes(a))
    }
}

fn uuid_string(b: &[u8]) -> String {
    let h: String = b.iter().map(|x| format!("{:02x}", x)).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn fin32(x: f32) -> f32 {
    if x.is_finite() { x } else { 0.0 }
}
fn fin64(x: f64) -> f64 {
    if x.is_finite() { x } else { 0.0 }
}
/// Zero the whole vector when any component is non-finite (matching the reference
/// reader), otherwise pass the components straight through.
fn fin_vec32(v: &[f32]) -> Vec<f32> {
    if v.iter().all(|x| x.is_finite()) { v.to_vec() } else { vec![0.0; v.len()] }
}
fn fin_vec64(v: &[f64]) -> Vec<f64> {
    if v.iter().all(|x| x.is_finite()) { v.to_vec() } else { vec![0.0; v.len()] }
}

/// An LLQuaternion travels the wire as a packed 3-vector: normalize [x,y,z,w] and,
/// when w<0, negate the vector part so the receiver can recover w>=0.
fn pack_quat_to_vec3(x: f32, y: f32, z: f32, w: f32) -> [f32; 3] {
    let mag = (x * x + y * y + z * z + w * w).sqrt();
    let (mut x, mut y, mut z, w) = if mag > 0.0 {
        (x / mag, y / mag, z / mag, w / mag)
    } else {
        (x, y, z, w)
    };
    if w < 0.0 {
        x = -x;
        y = -y;
        z = -z;
    }
    [x, y, z]
}
/// The inverse of `pack_quat_to_vec3`: recover w = sqrt(1 - |v|^2) (always >=0);
/// non-finite input falls back to the identity quaternion.
fn unpack_quat_from_vec3(x: f32, y: f32, z: f32) -> [f32; 4] {
    if !x.is_finite() || !y.is_finite() || !z.is_finite() {
        return [0.0, 0.0, 0.0, 1.0];
    }
    let sq = 1.0 - (x * x + y * y + z * z);
    let w = if sq > 0.0 { sq.sqrt() } else { 0.0 };
    [x, y, z, w]
}

fn decode_field(ty: FieldType, r: &mut Reader) -> Option<Value> {
    Some(match ty {
        FieldType::U8 => json!(r.u8()?),
        FieldType::U16 => json!(r.u16le()?),
        FieldType::U32 => json!(r.u32le()?),
        FieldType::U64 => json!(r.u64le()?.to_string()),
        FieldType::S8 => json!(r.u8()? as i8),
        FieldType::S16 => json!(r.u16le()? as i16),
        FieldType::S32 => json!(r.u32le()? as i32),
        FieldType::S64 => json!((r.u64le()? as i64).to_string()),
        // Sanitize non-finite floats to 0: serde_json turns NaN/Inf into null, and a
        // null landing in a position/velocity field breaks the JS math downstream. A
        // vector is zeroed whole when any component is non-finite (matching the
        // reference reader's getVector3/getQuat behaviour).
        FieldType::F32 => json!(fin32(r.f32le()?)),
        FieldType::F64 => json!(fin64(r.f64le()?)),
        FieldType::Bool => json!(r.u8()? != 0),
        FieldType::Uuid => json!(uuid_string(r.take(16)?)),
        FieldType::Vec3 => json!(fin_vec32(&[r.f32le()?, r.f32le()?, r.f32le()?])),
        FieldType::Vec4 => json!(fin_vec32(&[r.f32le()?, r.f32le()?, r.f32le()?, r.f32le()?])),
        // The wire quaternion is a packed 3-vector, so rebuild the full [x,y,z,w].
        FieldType::Quat => json!(unpack_quat_from_vec3(r.f32le()?, r.f32le()?, r.f32le()?)),
        FieldType::Vec3d => json!(fin_vec64(&[r.f64le()?, r.f64le()?, r.f64le()?])),
        FieldType::IpAddr => {
            let s = r.take(4)?;
            json!(format!("{}.{}.{}.{}", s[0], s[1], s[2], s[3]))
        }
        FieldType::IpPort => json!(r.u16be()?),
        FieldType::Fixed(n) => json!(B64.encode(r.take(n as usize)?)),
        FieldType::VarLen(k) => {
            let len = match k {
                2 => r.u16le()? as usize,
                4 => r.u32le()? as usize,
                _ => r.u8()? as usize,
            };
            json!(B64.encode(r.take(len)?))
        }
    })
}

/// Decode a single packet into the generic JSON form described in the module docs.
pub fn decode(reg: &Registry, bytes: &[u8]) -> Option<Value> {
    if bytes.len() < 6 {
        return None;
    }
    let flags = bytes[0];
    let seq = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);

    // Peel off any acks appended at the tail (network byte order).
    let mut receive_size = bytes.len();
    let mut appended_acks: Vec<u32> = Vec::new();
    if flags & FLAG_ACK != 0 && receive_size >= 1 {
        let ack_count = bytes[receive_size - 1] as usize;
        receive_size -= 1;
        if ack_count > 0 {
            // A bogus ack count that won't fit (leaving no room for the 6-byte
            // header) means the packet is malformed; drop it rather than decode the
            // mangled remainder, matching the reference viewer's valid_packet=false path.
            if receive_size < ack_count * 4 + 6 {
                return None;
            }
            receive_size -= ack_count * 4;
            for i in 0..ack_count {
                let off = receive_size + i * 4;
                appended_acks.push(u32::from_be_bytes([
                    bytes[off],
                    bytes[off + 1],
                    bytes[off + 2],
                    bytes[off + 3],
                ]));
            }
        }
    }

    // The offset byte (PHL_OFFSET = 5) skips the bytes *after* the message number,
    // not before it. The message number always sits at PHL_NAME = 6.
    let offset = bytes[5] as usize;
    if receive_size < 6 {
        return None;
    }

    let payload: Vec<u8> = if flags & FLAG_ZEROCODED != 0 {
        zerocode_expand(&bytes[0..receive_size])
    } else {
        bytes[0..receive_size].to_vec()
    };

    let (msg_id, after_id) = read_message_id(&payload, 6)?;
    let msg_pos = after_id + offset;

    let mut root = Map::new();
    root.insert("seq".into(), json!(seq));
    root.insert("flags".into(), json!(flags));
    root.insert("reliable".into(), json!(flags & FLAG_RELIABLE != 0));
    if !appended_acks.is_empty() {
        root.insert("acks".into(), json!(appended_acks));
    }
    root.insert("id".into(), json!(msg_id));

    let def = match reg.by_id(msg_id) {
        Some(d) => d,
        None => {
            root.insert("name".into(), Value::Null);
            root.insert("unknown".into(), json!(true));
            root.insert("blocks".into(), json!({}));
            return Some(Value::Object(root));
        }
    };
    root.insert("name".into(), json!(def.name));

    let mut r = Reader::new(&payload, msg_pos);
    let mut blocks = Map::new();
    'blocks: for block in &def.blocks {
        let count = match block.quantity {
            Quantity::Single => 1usize,
            Quantity::Multiple(n) => n as usize,
            // Count missing at EOF: treat this block as zero repeats and keep decoding the rest.
            Quantity::Variable => match r.u8() {
                Some(c) => c as usize,
                None => 0,
            },
        };
        let mut instances = Vec::with_capacity(count);
        for _ in 0..count {
            let mut obj = Map::new();
            for field in &block.fields {
                match decode_field(field.ty, &mut r) {
                    Some(v) => {
                        obj.insert(field.name.clone(), v);
                    }
                    // Packet truncated here, so hold on to the partial data.
                    None => {
                        instances.push(Value::Object(obj));
                        blocks.insert(block.name.clone(), Value::Array(instances));
                        break 'blocks;
                    }
                }
            }
            instances.push(Value::Object(obj));
        }
        blocks.insert(block.name.clone(), Value::Array(instances));
    }
    root.insert("blocks".into(), Value::Object(blocks));
    Some(Value::Object(root))
}

// ---------------------------------------------------------------------------
// Encoding packets back onto the wire.
// ---------------------------------------------------------------------------

fn v_u64(v: Option<&Value>) -> u64 {
    match v {
        Some(Value::Number(n)) => n.as_u64().or_else(|| n.as_i64().map(|x| x as u64)).unwrap_or(0),
        Some(Value::String(s)) => s.parse::<u64>().or_else(|_| s.parse::<i64>().map(|x| x as u64)).unwrap_or(0),
        Some(Value::Bool(b)) => *b as u64,
        _ => 0,
    }
}

fn v_i64(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_u64().map(|x| x as i64)).unwrap_or(0),
        Some(Value::String(s)) => s.parse::<i64>().unwrap_or(0),
        Some(Value::Bool(b)) => *b as i64,
        _ => 0,
    }
}

fn v_f64(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn v_bytes(v: Option<&Value>) -> Vec<u8> {
    match v {
        // Text is UTF-8; callers append the NUL themselves wherever the protocol needs one.
        Some(Value::String(s)) => B64.decode(s).unwrap_or_else(|_| s.as_bytes().to_vec()),
        Some(Value::Object(o)) => o
            .get("b64")
            .and_then(|x| x.as_str())
            .and_then(|x| B64.decode(x).ok())
            .unwrap_or_default(),
        Some(Value::Array(a)) => a.iter().map(|x| x.as_u64().unwrap_or(0) as u8).collect(),
        _ => Vec::new(),
    }
}

fn v_vec_f32(v: Option<&Value>, n: usize) -> Vec<f32> {
    let mut out = vec![0f32; n];
    if let Some(Value::Array(a)) = v {
        for (i, item) in a.iter().take(n).enumerate() {
            out[i] = item.as_f64().unwrap_or(0.0) as f32;
        }
    }
    out
}

fn uuid_to_bytes(v: Option<&Value>) -> [u8; 16] {
    let s = v.and_then(|x| x.as_str()).unwrap_or("");
    crate::bridge::util::uuid_to_bytes(s)
}

fn encode_field(ty: FieldType, v: Option<&Value>, out: &mut Vec<u8>) {
    match ty {
        FieldType::U8 => out.push(v_u64(v) as u8),
        FieldType::U16 => out.extend_from_slice(&(v_u64(v) as u16).to_le_bytes()),
        FieldType::U32 => out.extend_from_slice(&(v_u64(v) as u32).to_le_bytes()),
        FieldType::U64 => out.extend_from_slice(&v_u64(v).to_le_bytes()),
        FieldType::S8 => out.push(v_i64(v) as i8 as u8),
        FieldType::S16 => out.extend_from_slice(&(v_i64(v) as i16).to_le_bytes()),
        FieldType::S32 => out.extend_from_slice(&(v_i64(v) as i32).to_le_bytes()),
        FieldType::S64 => out.extend_from_slice(&v_i64(v).to_le_bytes()),
        FieldType::F32 => out.extend_from_slice(&(v_f64(v) as f32).to_le_bytes()),
        FieldType::F64 => out.extend_from_slice(&v_f64(v).to_le_bytes()),
        FieldType::Bool => out.push(if v_u64(v) != 0 { 1 } else { 0 }),
        FieldType::Uuid => out.extend_from_slice(&uuid_to_bytes(v)),
        FieldType::Vec3 => {
            for f in v_vec_f32(v, 3) {
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        FieldType::Vec4 => {
            for f in v_vec_f32(v, 4) {
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        FieldType::Quat => {
            // Callers hand us a full [x,y,z,w] quaternion; pack it down to the wire vec3.
            let q = v_vec_f32(v, 4);
            for f in pack_quat_to_vec3(q[0], q[1], q[2], q[3]) {
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        FieldType::Vec3d => {
            let mut vals = [0f64; 3];
            if let Some(Value::Array(a)) = v {
                for (i, item) in a.iter().take(3).enumerate() {
                    vals[i] = item.as_f64().unwrap_or(0.0);
                }
            }
            for f in vals {
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        FieldType::IpAddr => {
            let s = v.and_then(|x| x.as_str()).unwrap_or("0.0.0.0");
            for part in s.split('.').take(4) {
                out.push(part.parse::<u8>().unwrap_or(0));
            }
        }
        FieldType::IpPort => out.extend_from_slice(&(v_u64(v) as u16).to_be_bytes()),
        FieldType::Fixed(n) => {
            let mut b = v_bytes(v);
            b.resize(n as usize, 0);
            out.extend_from_slice(&b);
        }
        FieldType::VarLen(k) => {
            let mut b = v_bytes(v);
            match k {
                2 => out.extend_from_slice(&(b.len() as u16).to_le_bytes()),
                4 => out.extend_from_slice(&(b.len() as u32).to_le_bytes()),
                // A Variable-1 length is a single byte, so clamp and truncate to 255 to
                // keep the prefix and payload in step (as the reference viewer's addData does). Writing a
                // wrapped length while still emitting the full slice would misalign every
                // later field on the wire.
                _ => {
                    b.truncate(255);
                    out.push(b.len() as u8);
                }
            }
            out.extend_from_slice(&b);
        }
    }
}

fn encode_body(def: &MessageDef, blocks: &Value) -> Vec<u8> {
    let mut body = Vec::new();
    let empty = Map::new();
    let blocks_map = blocks.as_object().unwrap_or(&empty);
    for block in &def.blocks {
        let instances: Vec<Value> = match blocks_map.get(&block.name) {
            Some(Value::Array(a)) => a.clone(),
            Some(other) => vec![other.clone()],
            None => Vec::new(),
        };
        match block.quantity {
            Quantity::Single => {
                let inst = instances.into_iter().next().unwrap_or(Value::Null);
                encode_instance(block, &inst, &mut body);
            }
            Quantity::Multiple(n) => {
                for idx in 0..n as usize {
                    let inst = instances.get(idx).cloned().unwrap_or(Value::Null);
                    encode_instance(block, &inst, &mut body);
                }
            }
            Quantity::Variable => {
                // The count is a single byte, so clamp: past 255 instances we truncate
                // the list to match rather than write a byte that disagrees
                // with how many blocks actually follow (which would corrupt decoding).
                let n = instances.len().min(255);
                body.push(n as u8);
                for inst in instances.iter().take(n) {
                    encode_instance(block, inst, &mut body);
                }
            }
        }
    }
    body
}

fn encode_instance(block: &template::BlockDef, inst: &Value, out: &mut Vec<u8>) {
    let empty = Map::new();
    let obj = inst.as_object().unwrap_or(&empty);
    for field in &block.fields {
        encode_field(field.ty, obj.get(&field.name), out);
    }
}

/// Encode a complete UDP packet for `name` from the given block data.
/// `flags` is the base packet flag byte (reliable/ack); zerocoding is applied
/// automatically whenever the message template marks the message Zerocoded.
pub fn encode(reg: &Registry, name: &str, blocks: &Value, seq: u32, flags: u8) -> Option<Vec<u8>> {
    let def = reg.by_name(name)?;
    let body = encode_body(def, blocks);

    let mut flags = flags;
    if def.zerocoded {
        flags |= FLAG_ZEROCODED;
    }

    let mut buf = Vec::with_capacity(body.len() + 16);
    buf.push(flags);
    buf.extend_from_slice(&seq.to_be_bytes());
    buf.push(0); // extra header length, zero here
    let id_start = buf.len();
    write_message_id(&mut buf, def);
    buf.extend_from_slice(&body);

    if def.zerocoded {
        let end = buf.len() - 1;
        let mut out = zerocode_encode(&buf, id_start, end);
        out[0] = flags;
        Some(out)
    } else {
        Some(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zerocode_roundtrip() {
        let mut buf = vec![0x00, 0, 0, 0, 1, 0]; // the 6-byte header; encode adds the flag
        buf.extend_from_slice(&[0xFF, 0xFF, 0x00, 0x50]); // message id, with a zero byte in it on purpose
        buf.extend_from_slice(&[1, 0, 0, 0, 2, 9]); // body carrying a run of zeros
        let end = buf.len() - 1;
        let mut enc = zerocode_encode(&buf, 6, end);
        enc[0] |= FLAG_ZEROCODED;
        let dec = zerocode_expand(&enc);
        assert_eq!(dec, buf); // expand clears the flag, so we land back on the original
    }

    #[test]
    fn zerocode_expand_wrap_form() {
        // 0x00, then another 0x00, then a count of 5, expands to 1 + 256 + 4 zeros.
        let mut pkt = vec![0x80u8, 0, 0, 0, 1, 0]; // header with the zerocoded flag set
        pkt.push(1); // a non-zero literal at offset 6 so the header stays untouched
        pkt.extend_from_slice(&[0x00, 0x00, 0x05]);
        let out = zerocode_expand(&pkt);
        // 6 header bytes + the literal 1 + (1 + 256 + 4) zeros
        assert_eq!(out.len(), 6 + 1 + 261);
        assert_eq!(&out[0..7], &[0x00, 0, 0, 0, 1, 0, 1]);
        assert!(out[7..].iter().all(|&b| b == 0));
    }

    #[test]
    fn zerocode_expand_is_capped() {
        // A ~64KB all-zero zerocoded body must not amplify without bound.
        let mut pkt = vec![0x80u8, 0, 0, 0, 1, 0];
        pkt.extend(std::iter::repeat(0u8).take(64_000));
        let out = zerocode_expand(&pkt);
        assert!(out.len() <= 0x2000 + 256, "expanded {} bytes", out.len());
    }

    #[test]
    fn non_finite_floats_decode_to_zero() {
        // NaN bits in an F32 field have to decode to 0.0, never JSON null.
        let nan = f32::NAN.to_le_bytes();
        let mut r = Reader::new(&nan, 0);
        assert_eq!(decode_field(FieldType::F32, &mut r).unwrap(), json!(0.0));
        // A Vec3 with even one non-finite component is zeroed whole.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1.0f32.to_le_bytes());
        bytes.extend_from_slice(&f32::INFINITY.to_le_bytes());
        bytes.extend_from_slice(&2.0f32.to_le_bytes());
        let mut r = Reader::new(&bytes, 0);
        assert_eq!(decode_field(FieldType::Vec3, &mut r).unwrap(), json!([0.0, 0.0, 0.0]));
    }

    #[test]
    fn quat_packs_and_unpacks_round_trip() {
        // A quaternion with w<0 must round-trip through the packed 3-vector wire
        // form back to an equivalent rotation (w recovered as >=0, the vector negated).
        let mut out = Vec::new();
        // [x,y,z,w] with w<0, already normalized.
        let q = json!([0.2f64, 0.3, 0.4, -0.8406]);
        encode_field(FieldType::Quat, Some(&q), &mut out);
        assert_eq!(out.len(), 12); // three f32s go out on the wire
        let mut r = Reader::new(&out, 0);
        let back = decode_field(FieldType::Quat, &mut r).unwrap();
        let a = back.as_array().unwrap();
        assert_eq!(a.len(), 4);
        // w comes back non-negative, and the packed vector was negated because w<0.
        assert!(a[3].as_f64().unwrap() >= 0.0);
        assert!((a[0].as_f64().unwrap() - (-0.2)).abs() < 1e-3);
    }

    #[test]
    fn varlen1_field_length_clamps_to_255() {
        // A Variable-1 field longer than 255 bytes must write a length byte that agrees
        // with the truncated payload rather than a wrapped length.
        let mut out = Vec::new();
        let v = json!(vec![7u8; 300]); // a byte array, so 300 raw bytes
        encode_field(FieldType::VarLen(1), Some(&v), &mut out);
        assert_eq!(out[0], 255); // the length prefix
        assert_eq!(out.len(), 1 + 255); // one prefix byte plus the truncated payload
    }

    #[test]
    fn all_outbound_messages_exist() {
        // Every message name the outbound commands and handshake encode has to be in
        // the registry, or the send silently no-ops.
        let reg = template::build_registry();
        const NAMES: &[&str] = &[
            "ChatFromViewer", "ImprovedInstantMessage", "JoinGroupRequest", "LeaveGroupRequest",
            "ActivateGroup", "GroupTitleUpdate", "GroupTitlesRequest", "MoneyTransferRequest",
            "TeleportLocationRequest", "TeleportLandmarkRequest", "TeleportLureRequest", "StartLure",
            "TerminateFriendship", "AcceptCallingCard", "DeclineCallingCard", "MapBlockRequest",
            "MapNameRequest", "MapItemRequest", "ScriptAnswerYes", "ScriptDialogReply",
            "AvatarNotesUpdate", "DirFindQuery", "ParcelPropertiesRequest", "ParcelPropertiesUpdate",
            "UUIDNameRequest", "LogoutRequest", "UseCircuitCode", "CompleteAgentMovement",
            "RegionHandshakeReply", "PacketAck", "CompletePingCheck",
        ];
        let missing: Vec<&str> = NAMES.iter().copied().filter(|n| reg.by_name(n).is_none()).collect();
        assert!(missing.is_empty(), "missing outbound messages: {missing:?}");
    }

    #[test]
    fn parcel_update_field_names_roundtrip() {
        // Guards the ParcelData field names that sl_update_parcel depends on.
        let reg = template::build_registry();
        let blocks = json!({
            "AgentData": [{ "AgentID": "11111111-1111-1111-1111-111111111111", "SessionID": "22222222-2222-2222-2222-222222222222" }],
            "ParcelData": [{
                "LocalID": 7, "Flags": 1, "ParcelFlags": 320, "SalePrice": 0,
                "Name": B64.encode(b"Lot\0"), "Desc": B64.encode(b"\0"),
                "MusicURL": B64.encode(b"\0"), "MediaURL": B64.encode(b"\0"),
                "MediaID": "00000000-0000-0000-0000-000000000000", "MediaAutoScale": 0,
                "GroupID": "00000000-0000-0000-0000-000000000000", "PassPrice": 0, "PassHours": 0.0,
                "Category": 0, "AuthBuyerID": "00000000-0000-0000-0000-000000000000",
                "SnapshotID": "00000000-0000-0000-0000-000000000000",
                "UserLocation": [1.0, 2.0, 3.0], "UserLookAt": [0.0, 0.0, 0.0], "LandingType": 1,
            }]
        });
        let pkt = encode(&reg, "ParcelPropertiesUpdate", &blocks, 1, 0).expect("encode");
        let dec = decode(&reg, &pkt).expect("decode");
        assert_eq!(dec["name"], "ParcelPropertiesUpdate");
        assert_eq!(dec["blocks"]["ParcelData"][0]["LocalID"], 7);
        assert_eq!(dec["blocks"]["ParcelData"][0]["ParcelFlags"], 320);
        assert_eq!(dec["blocks"]["ParcelData"][0]["LandingType"], 1);
    }

    #[test]
    fn teleport_location_request_roundtrips() {
        let reg = template::build_registry();
        let blocks = json!({
            "AgentData": [{ "AgentID": "11111111-1111-1111-1111-111111111111", "SessionID": "22222222-2222-2222-2222-222222222222" }],
            "Info": [{ "RegionHandle": "1099511628032", "Position": [128.0, 64.0, 25.0], "LookAt": [129.0, 64.0, 25.0] }],
        });
        let pkt = encode(&reg, "TeleportLocationRequest", &blocks, 1, 0).expect("encode");
        let dec = decode(&reg, &pkt).expect("decode");
        assert_eq!(dec["blocks"]["Info"][0]["RegionHandle"], "1099511628032");
        assert_eq!(dec["blocks"]["Info"][0]["Position"][0], 128.0);
    }

    #[test]
    fn encode_decode_chat_from_viewer() {
        let reg = template::build_registry();
        // ChatFromViewer layout: AgentData { AgentID, SessionID }, ChatData { Message(Var2), Type(U8), Channel(S32) }
        let blocks = json!({
            "AgentData": [{
                "AgentID": "11111111-1111-1111-1111-111111111111",
                "SessionID": "22222222-2222-2222-2222-222222222222"
            }],
            "ChatData": [{
                "Message": B64.encode(b"hello\0"),
                "Type": 1,
                "Channel": 0
            }]
        });
        let packet = encode(&reg, "ChatFromViewer", &blocks, 7, FLAG_RELIABLE).expect("encode");
        assert_eq!(packet[0] & FLAG_ZEROCODED, FLAG_ZEROCODED); // the template marks this one zerocoded
        let decoded = decode(&reg, &packet).expect("decode");
        assert_eq!(decoded["name"], "ChatFromViewer");
        assert_eq!(decoded["seq"], 7);
        let msg_b64 = decoded["blocks"]["ChatData"][0]["Message"].as_str().unwrap();
        assert_eq!(B64.decode(msg_b64).unwrap(), b"hello\0");
        assert_eq!(decoded["blocks"]["ChatData"][0]["Channel"], 0);
    }
}
