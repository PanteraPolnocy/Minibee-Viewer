//! Parser for Linden Lab's `message_template.msg`.
//!
//! We bake the template into the binary at build time and parse it just once
//! at startup, building a registry keyed by message name (for encoding) and by
//! wire id (for decoding). That gives us a single generic codec covering every
//! message in the template, rather than a hand-written parser for each one.

use std::collections::HashMap;
use std::sync::Arc;

/// Raw template text, shipped inside the binary.
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
    /// A fixed-length byte blob of exactly the given size.
    Fixed(u16),
    /// A variable-length blob, sized by a 1- or 2-byte little-endian prefix.
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
    /// The full wire id (e.g. Low 80 becomes 0xFFFF0050).
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
        // Drop anything from a `//` line comment onward.
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

/// Turn the embedded template into a registry ready for lookups.
pub fn build_registry() -> Registry {
    let toks = tokenize(TEMPLATE_SRC);
    let mut by_name = HashMap::new();
    let mut by_id = HashMap::new();

    let mut i = 0usize;
    let n = toks.len();
    while i < n {
        // Walk forward to the next top-level `{`, which opens a message.
        match &toks[i] {
            Tok::LBrace => {}
            _ => {
                i += 1;
                continue;
            }
        }
        i += 1; // step past the message's opening `{`

        // Gather the header words up to the first `{` (a block) or `}` (a bodyless message).
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
            // Header isn't well-formed, so skip ahead to its closing brace.
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

        // Read the blocks until the message's closing `}`.
        let mut blocks = Vec::new();
        while i < n {
            match &toks[i] {
                Tok::RBrace => {
                    i += 1;
                    break;
                }
                Tok::LBrace => {
                    i += 1; // step past the block's opening `{`
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

                    // Read the fields until the block's closing `}`.
                    let mut fields = Vec::new();
                    while i < n {
                        match &toks[i] {
                            Tok::RBrace => {
                                i += 1;
                                break;
                            }
                            Tok::LBrace => {
                                i += 1; // step past the field's opening `{`
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
                                // step past the field's closing `}`
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

/// Skip past a single balanced `{ ... }` group, so we can recover from bad input.
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
        // A healthy template should hand us hundreds of messages.
        assert!(reg.len() > 300, "only parsed {} messages", reg.len());

        // ChatFromViewer is Low 80, which comes out as 0xFFFF0050.
        let cfv = reg.by_name("ChatFromViewer").expect("ChatFromViewer");
        assert_eq!(cfv.frequency, Frequency::Low);
        assert_eq!(cfv.id, 0xFFFF_0050);
        assert!(cfv.zerocoded);

        // PacketAck is Fixed 0xFFFFFFFB and not zerocoded.
        let ack = reg.by_name("PacketAck").expect("PacketAck");
        assert_eq!(ack.frequency, Frequency::Fixed);
        assert_eq!(ack.id, 0xFFFF_FFFB);
        assert!(!ack.zerocoded);

        // AgentUpdate lives at High 4.
        let au = reg.by_name("AgentUpdate").expect("AgentUpdate");
        assert_eq!(au.frequency, Frequency::High);
        assert_eq!(au.id, 4);

        // Looking it back up by id round-trips to the same message.
        assert_eq!(reg.by_id(0xFFFF_0050).unwrap().name, "ChatFromViewer");
    }

    /// Every message the frontend circuit handles (MSG_META in sl-packet.js) has
    /// to exist in the registry, or else the Rust engine can't replace it.
    #[test]
    fn registry_covers_all_frontend_messages() {
        let reg = build_registry();
        const NEEDED: &[&str] = &[
            "AcceptCallingCard", "ActivateGroup", "AgentAlertMessage", "AgentDataUpdate",
            "AgentDataUpdateRequest", "AgentGroupDataUpdate", "AgentMovementComplete",
            "AgentUpdate", "AlertMessage", "AvatarNotesUpdate", "AvatarPickerRequest",
            "AvatarPropertiesRequest", "ChatFromSimulator", "ChatFromViewer",
            "ClassifiedInfoRequest", "CoarseLocationUpdate", "CompleteAgentMovement",
            "CompletePingCheck", "ConfirmEnableSimulator", "CrossedRegion",
            "DataHomeLocationReply", "DataHomeLocationRequest", "DeclineCallingCard",
            "DirFindQuery", "DirPlacesQuery", "DisableSimulator", "EconomyDataRequest",
            "EnableSimulator", "FeatureDisabled", "GenericMessage", "GroupProfileRequest",
            "GroupRoleDataRequest", "GroupTitleUpdate", "GroupTitlesRequest", "HealthMessage",
            "ImprovedInstantMessage", "JoinGroupReply", "JoinGroupRequest", "KickUser",
            "KillChildAgents", "LeaveGroupReply", "LeaveGroupRequest", "LoadURL", "LogoutReply",
            "LogoutRequest", "MapBlockReply", "MapBlockRequest", "MapItemReply", "MapItemRequest",
            "MapLayerReply", "MapNameRequest", "MeanCollisionAlert", "MoneyBalanceReply",
            "MoneyBalanceRequest", "MoneyTransferRequest", "OfferCallingCard",
            "OfflineNotification", "OnlineNotification", "PacketAck", "ParcelInfoReply",
            "ParcelInfoRequest", "ParcelProperties", "ParcelPropertiesRequest",
            "ParcelPropertiesRequestByID", "ParcelPropertiesUpdate", "RegionHandshake",
            "RegionHandshakeReply", "ScriptAnswerYes", "ScriptControlChange", "ScriptDialog",
            "ScriptDialogReply", "ScriptQuestion", "ScriptTeleportRequest",
            "SimulatorViewerTimeMessage", "StartLure", "StartPingCheck", "SystemKickUser",
            "TeleportCancel", "TeleportFailed", "TeleportFinish", "TeleportLandmarkRequest",
            "TeleportLocal", "TeleportLocationRequest", "TeleportLureRequest", "TeleportProgress",
            "TeleportStart", "TerminateFriendship", "UUIDNameReply", "UUIDNameRequest",
            "UseCircuitCode", "ViewerFrozenMessage",
        ];
        let missing: Vec<&str> = NEEDED.iter().copied().filter(|m| reg.by_name(m).is_none()).collect();
        assert!(missing.is_empty(), "registry missing frontend messages: {missing:?}");
    }
}
