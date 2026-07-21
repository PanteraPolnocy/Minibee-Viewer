//! Generic SL UDP packet codec.
//!
//! Encoding and decoding are driven entirely by the message template
//! (`template.rs`), so *every* message in the template is supported without
//! per-message code. Framing, zerocoding, message-id widths, and field layout
//! follow the Second Life UDP wire format exactly.
//!
//! Decoded packets become a generic JSON shape:
//! ```json
//! { "name": "ChatFromSimulator", "id": 4294901899, "seq": 12,
//!   "flags": 64, "reliable": true, "acks": [ ... ],
//!   "blocks": { "ChatData": [ { "FromName": "<base64>", ... } ] } }
//! ```
//! Variable/Fixed byte fields are base64 (lossless); U64/S64 are decimal
//! strings (JS `BigInt`); vectors/quaternions are JSON number arrays.

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

pub const PACKET_ACK_ID: u32 = 0xFFFF_FFFB;

// ---------------------------------------------------------------------------
// Zerocoding (run-length encoding of zero bytes).
// ---------------------------------------------------------------------------

/// RLE-encode zero runs in `buf[start..=end]`, preserving `buf[0..start]`.
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

/// Expand a zerocoded packet, faithful to `LLMessageSystem::zeroCodeExpand`.
///
/// The first 6 bytes (packet-id header) are copied verbatim; expansion begins
/// at `PHL_NAME` (offset 6) and runs to the end of `input` (acks already
/// stripped by the caller). A `0x00` byte introduces a zero run: each further
/// literal `0x00` contributes 256 zeros (the "wrap" form the JS decoder gets
/// wrong), and the following count byte `n` contributes `n - 1` more.
pub fn zerocode_expand(input: &[u8]) -> Vec<u8> {
    const HDR: usize = 6;
    let n = input.len();
    let mut out = Vec::with_capacity(n * 2 + HDR);
    for k in 0..HDR.min(n) {
        out.push(input[k]);
    }
    if !out.is_empty() {
        out[0] &= !FLAG_ZEROCODED;
    }
    let mut i = HDR;
    while i < n {
        let b = input[i];
        i += 1;
        out.push(b);
        if b == 0 {
            // Consecutive literal zeros each expand to a 256-zero block.
            while i < n && input[i] == 0 {
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
// Message-id framing.
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

/// Returns `(message_id, bytes_consumed)`.
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
// Reader — panic-free sequential reads over the decoded payload.
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
        FieldType::F32 => json!(r.f32le()?),
        FieldType::F64 => json!(r.f64le()?),
        FieldType::Bool => json!(r.u8()? != 0),
        FieldType::Uuid => json!(uuid_string(r.take(16)?)),
        FieldType::Vec3 => json!([r.f32le()?, r.f32le()?, r.f32le()?]),
        FieldType::Vec4 => json!([r.f32le()?, r.f32le()?, r.f32le()?, r.f32le()?]),
        FieldType::Quat => json!([r.f32le()?, r.f32le()?, r.f32le()?]),
        FieldType::Vec3d => json!([r.f64le()?, r.f64le()?, r.f64le()?]),
        FieldType::IpAddr => {
            let s = r.take(4)?;
            json!(format!("{}.{}.{}.{}", s[0], s[1], s[2], s[3]))
        }
        FieldType::IpPort => json!(r.u16be()?),
        FieldType::Fixed(n) => json!(B64.encode(r.take(n as usize)?)),
        FieldType::VarLen(k) => {
            let len = if k == 2 {
                r.u16le()? as usize
            } else {
                r.u8()? as usize
            };
            json!(B64.encode(r.take(len)?))
        }
    })
}

/// A decoded packet as generic JSON (see module docs).
pub fn decode(reg: &Registry, bytes: &[u8]) -> Option<Value> {
    if bytes.len() < 6 {
        return None;
    }
    let flags = bytes[0];
    let seq = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);

    // Strip appended acks (network byte order).
    let mut receive_size = bytes.len();
    let mut appended_acks: Vec<u32> = Vec::new();
    if flags & FLAG_ACK != 0 && receive_size >= 1 {
        let ack_count = bytes[receive_size - 1] as usize;
        receive_size -= 1;
        if ack_count > 0 && receive_size >= ack_count * 4 {
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

    // The offset byte (PHL_OFFSET = 5) skips bytes *after* the message number,
    // not before it. The message number is always at PHL_NAME = 6.
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
            Quantity::Variable => match r.u8() {
                Some(c) => c as usize,
                None => break 'blocks,
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
                    // Truncated packet: keep what we have (parity with JS).
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
// Encoding.
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
        // Text is UTF-8; callers append a NUL themselves where the protocol needs it.
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
            for f in v_vec_f32(v, 3) {
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
            let b = v_bytes(v);
            if k == 2 {
                out.extend_from_slice(&(b.len() as u16).to_le_bytes());
            } else {
                out.push(b.len() as u8);
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
                body.push(instances.len() as u8);
                for inst in &instances {
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

/// Encode a full UDP packet for `name` with the given block data.
/// `flags` is the base packet flag byte (reliable/ack); zerocoding is applied
/// automatically when the message template marks the message Zerocoded.
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
    buf.push(0); // extra header length
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
        let mut buf = vec![0x00, 0, 0, 0, 1, 0]; // 6-byte header (flag added by encode)
        buf.extend_from_slice(&[0xFF, 0xFF, 0x00, 0x50]); // message id (contains a zero)
        buf.extend_from_slice(&[1, 0, 0, 0, 2, 9]); // body with a zero run
        let end = buf.len() - 1;
        let mut enc = zerocode_encode(&buf, 6, end);
        enc[0] |= FLAG_ZEROCODED;
        let dec = zerocode_expand(&enc);
        assert_eq!(dec, buf); // flag cleared on expand -> equals original
    }

    #[test]
    fn zerocode_expand_wrap_form() {
        // A single 0x00 followed by another 0x00 then count 5 => 1 + 256 + 4 zeros.
        let mut pkt = vec![0x80u8, 0, 0, 0, 1, 0]; // header, zerocoded flag set
        pkt.push(1); // a non-zero literal at offset 6 so we don't touch the header
        pkt.extend_from_slice(&[0x00, 0x00, 0x05]);
        let out = zerocode_expand(&pkt);
        // header(6) + literal 1 + (1 + 256 + 4) zeros
        assert_eq!(out.len(), 6 + 1 + 261);
        assert_eq!(&out[0..7], &[0x00, 0, 0, 0, 1, 0, 1]);
        assert!(out[7..].iter().all(|&b| b == 0));
    }

    #[test]
    fn encode_decode_chat_from_viewer() {
        let reg = template::build_registry();
        // ChatFromViewer: AgentData { AgentID, SessionID }, ChatData { Message(Var2), Type(U8), Channel(S32) }
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
        assert_eq!(packet[0] & FLAG_ZEROCODED, FLAG_ZEROCODED); // template marks it zerocoded
        let decoded = decode(&reg, &packet).expect("decode");
        assert_eq!(decoded["name"], "ChatFromViewer");
        assert_eq!(decoded["seq"], 7);
        let msg_b64 = decoded["blocks"]["ChatData"][0]["Message"].as_str().unwrap();
        assert_eq!(B64.decode(msg_b64).unwrap(), b"hello\0");
        assert_eq!(decoded["blocks"]["ChatData"][0]["Channel"], 0);
    }
}
