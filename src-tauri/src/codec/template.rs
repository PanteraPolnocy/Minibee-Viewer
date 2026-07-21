//! Parser for Linden Lab's `message_template.msg`.
//!
//! The template is embedded at build time and parsed once at startup into a
//! registry keyed by message name (for encoding) and by wire id (for decoding).
//! This gives a single generic codec that supports every message in the
//! template instead of hand-written per-message parsers.

use std::collections::HashMap;
use std::sync::Arc;

/// Raw template text, bundled with the binary.
const TEMPLATE_SRC: &str = include_str!("../../resources/message_template.msg");

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Frequency {
    High,
    Medium,
    Low,
    Fixed,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FieldType {
    U8,
    U16,
    U32,
    U64,
    S8,
    S16,
    S32,
    S64,
    F32,
    F64,
    Bool,
    Uuid,
    Vec3,
    Vec3d,
    Vec4,
    Quat,
    IpAddr,
    IpPort,
    /// Fixed-length byte blob of the given size.
    Fixed(u16),
    /// Variable-length blob with a 1- or 2-byte little-endian length prefix.
    VarLen(u8),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Quantity {
    Single,
    Multiple(u16),
    Variable,
}

#[derive(Clone, Debug)]
pub struct FieldDef {
    pub name: String,
    pub ty: FieldType,
}

#[derive(Clone, Debug)]
pub struct BlockDef {
    pub name: String,
    pub quantity: Quantity,
    pub fields: Vec<FieldDef>,
}

#[derive(Clone, Debug)]
pub struct MessageDef {
    pub name: String,
    pub frequency: Frequency,
    /// Full wire id (e.g. Low 80 -> 0xFFFF0050).
    pub id: u32,
    pub zerocoded: bool,
    pub blocks: Vec<BlockDef>,
}

pub struct Registry {
    by_name: HashMap<String, Arc<MessageDef>>,
    by_id: HashMap<u32, Arc<MessageDef>>,
}

impl Registry {
    pub fn by_name(&self, name: &str) -> Option<&Arc<MessageDef>> {
        self.by_name.get(name)
    }
    pub fn by_id(&self, id: u32) -> Option<&Arc<MessageDef>> {
        self.by_id.get(&id)
    }
    pub fn len(&self) -> usize {
        self.by_name.len()
    }
}

#[derive(Debug)]
enum Tok {
    LBrace,
    RBrace,
    Word(String),
}

fn tokenize(src: &str) -> Vec<Tok> {
    let mut toks = Vec::new();
    for raw_line in src.lines() {
        // Strip `//` line comments.
        let line = match raw_line.find("//") {
            Some(i) => &raw_line[..i],
            None => raw_line,
        };
        let mut word = String::new();
        for ch in line.chars() {
            match ch {
                '{' | '}' => {
                    if !word.is_empty() {
                        toks.push(Tok::Word(std::mem::take(&mut word)));
                    }
                    toks.push(if ch == '{' { Tok::LBrace } else { Tok::RBrace });
                }
                c if c.is_whitespace() => {
                    if !word.is_empty() {
                        toks.push(Tok::Word(std::mem::take(&mut word)));
                    }
                }
                c => word.push(c),
            }
        }
        if !word.is_empty() {
            toks.push(Tok::Word(word));
        }
    }
    toks
}

fn parse_number(s: &str) -> Option<u32> {
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u32::from_str_radix(hex, 16).ok()
    } else {
        s.parse::<u32>().ok()
    }
}

fn field_type(name: &str, count: Option<u32>) -> Option<FieldType> {
    Some(match name {
        "U8" => FieldType::U8,
        "U16" => FieldType::U16,
        "U32" => FieldType::U32,
        "U64" => FieldType::U64,
        "S8" => FieldType::S8,
        "S16" => FieldType::S16,
        "S32" => FieldType::S32,
        "S64" => FieldType::S64,
        "F32" => FieldType::F32,
        "F64" => FieldType::F64,
        "BOOL" => FieldType::Bool,
        "LLUUID" => FieldType::Uuid,
        "LLVector3" => FieldType::Vec3,
        "LLVector3d" => FieldType::Vec3d,
        "LLVector4" => FieldType::Vec4,
        "LLQuaternion" => FieldType::Quat,
        "IPADDR" => FieldType::IpAddr,
        "IPPORT" => FieldType::IpPort,
        "Fixed" => FieldType::Fixed(count? as u16),
        "Variable" => FieldType::VarLen(count.unwrap_or(1) as u8),
        _ => return None,
    })
}

/// Parse the embedded template into a lookup registry.
pub fn build_registry() -> Registry {
    let toks = tokenize(TEMPLATE_SRC);
    let mut by_name = HashMap::new();
    let mut by_id = HashMap::new();

    let mut i = 0usize;
    let n = toks.len();
    while i < n {
        // Advance to the next message-opening brace at top level.
        match &toks[i] {
            Tok::LBrace => {}
            _ => {
                i += 1;
                continue;
            }
        }
        i += 1; // consume message `{`

        // Header words until the first `{` (a block) or `}` (bodyless message).
        let mut header = Vec::new();
        while i < n {
            match &toks[i] {
                Tok::Word(w) => {
                    header.push(w.clone());
                    i += 1;
                }
                _ => break,
            }
        }
        if header.len() < 5 {
            // Not a well-formed message header; skip to its closing brace.
            i = skip_to_brace_close(&toks, i);
            continue;
        }
        let name = header[0].clone();
        let frequency = match header[1].as_str() {
            "High" => Frequency::High,
            "Medium" => Frequency::Medium,
            "Low" => Frequency::Low,
            "Fixed" => Frequency::Fixed,
            _ => {
                i = skip_to_brace_close(&toks, i);
                continue;
            }
        };
        let number = match parse_number(&header[2]) {
            Some(v) => v,
            None => {
                i = skip_to_brace_close(&toks, i);
                continue;
            }
        };
        let zerocoded = header.iter().any(|w| w == "Zerocoded");
        let id = match frequency {
            Frequency::High => number,
            Frequency::Medium => 0xFF00 | (number & 0xFF),
            Frequency::Low => 0xFFFF_0000 | (number & 0xFFFF),
            Frequency::Fixed => number,
        };

        // Parse blocks until the message-closing `}`.
        let mut blocks = Vec::new();
        while i < n {
            match &toks[i] {
                Tok::RBrace => {
                    i += 1;
                    break;
                }
                Tok::LBrace => {
                    i += 1; // consume block `{`
                    let mut bhdr = Vec::new();
                    while i < n {
                        match &toks[i] {
                            Tok::Word(w) => {
                                bhdr.push(w.clone());
                                i += 1;
                            }
                            _ => break,
                        }
                    }
                    let quantity = if bhdr.len() >= 2 {
                        match bhdr[1].as_str() {
                            "Single" => Quantity::Single,
                            "Multiple" => Quantity::Multiple(
                                bhdr.get(2).and_then(|s| s.parse().ok()).unwrap_or(1),
                            ),
                            "Variable" => Quantity::Variable,
                            _ => Quantity::Single,
                        }
                    } else {
                        Quantity::Single
                    };
                    let bname = bhdr.first().cloned().unwrap_or_default();

                    // Parse fields until the block-closing `}`.
                    let mut fields = Vec::new();
                    while i < n {
                        match &toks[i] {
                            Tok::RBrace => {
                                i += 1;
                                break;
                            }
                            Tok::LBrace => {
                                i += 1; // consume field `{`
                                let mut fw = Vec::new();
                                while i < n {
                                    match &toks[i] {
                                        Tok::Word(w) => {
                                            fw.push(w.clone());
                                            i += 1;
                                        }
                                        _ => break,
                                    }
                                }
                                // consume field-closing `}`
                                if i < n {
                                    if let Tok::RBrace = &toks[i] {
                                        i += 1;
                                    }
                                }
                                if fw.len() >= 2 {
                                    let cnt = fw.get(2).and_then(|s| parse_number(s));
                                    if let Some(ty) = field_type(&fw[1], cnt) {
                                        fields.push(FieldDef {
                                            name: fw[0].clone(),
                                            ty,
                                        });
                                    }
                                }
                            }
                            _ => {
                                i += 1;
                            }
                        }
                    }
                    blocks.push(BlockDef {
                        name: bname,
                        quantity,
                        fields,
                    });
                }
                _ => {
                    i += 1;
                }
            }
        }

        let def = Arc::new(MessageDef {
            name,
            frequency,
            id,
            zerocoded,
            blocks,
        });
        by_name.insert(def.name.clone(), def.clone());
        by_id.insert(def.id, def);
    }

    Registry { by_name, by_id }
}

/// Skip forward past one balanced `{ ... }` group (defensive recovery).
fn skip_to_brace_close(toks: &[Tok], mut i: usize) -> usize {
    let mut depth = 1i32;
    while i < toks.len() && depth > 0 {
        match &toks[i] {
            Tok::LBrace => depth += 1,
            Tok::RBrace => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_messages() {
        let reg = build_registry();
        // A healthy template yields hundreds of messages.
        assert!(reg.len() > 300, "only parsed {} messages", reg.len());

        // ChatFromViewer is Low 80 -> 0xFFFF0050.
        let cfv = reg.by_name("ChatFromViewer").expect("ChatFromViewer");
        assert_eq!(cfv.frequency, Frequency::Low);
        assert_eq!(cfv.id, 0xFFFF_0050);
        assert!(cfv.zerocoded);

        // PacketAck is Fixed 0xFFFFFFFB, unencoded.
        let ack = reg.by_name("PacketAck").expect("PacketAck");
        assert_eq!(ack.frequency, Frequency::Fixed);
        assert_eq!(ack.id, 0xFFFF_FFFB);
        assert!(!ack.zerocoded);

        // AgentUpdate is High 4.
        let au = reg.by_name("AgentUpdate").expect("AgentUpdate");
        assert_eq!(au.frequency, Frequency::High);
        assert_eq!(au.id, 4);

        // Lookup by id round-trips.
        assert_eq!(reg.by_id(0xFFFF_0050).unwrap().name, "ChatFromViewer");
    }
}
