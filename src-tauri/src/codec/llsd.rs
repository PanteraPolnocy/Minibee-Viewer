//! LLSD codec for the XML and JSON bodies that come back from capabilities and the EventQueue.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Map, Value};

/// Parse an LLSD document. `content_type` picks JSON or XML, with XML as the
/// default for `application/llsd+xml`.
pub fn parse(body: &str, content_type: &str) -> Result<Value, String> {
    let text = body.trim();
    if text.is_empty() {
        return Ok(json!({}));
    }
    let ct = content_type.to_ascii_lowercase();
    let looks_json = ct.contains("json") || text.starts_with('{') || text.starts_with('[');
    if looks_json {
        return serde_json::from_str(text).map_err(|e| format!("Invalid LLSD JSON: {e}"));
    }
    // Turn away pathologically nested XML before roxmltree ever touches it: building
    // (and then dropping) a very deep tree can overflow the stack, and our
    // parse_node depth cap alone can't prevent that, since it only runs after the
    // tree already exists. Real LLSD is only ever a handful of levels deep.
    if max_xml_nesting(text) > MAX_LLSD_DEPTH as usize {
        return Err("LLSD XML nested too deeply".to_string());
    }
    let doc = roxmltree::Document::parse(text).map_err(|_| "Invalid LLSD XML".to_string())?;
    // The payload is either the first element child of <llsd>, or the root element itself.
    let root = doc.root_element();
    let container = if root.has_tag_name("llsd") {
        match root.children().find(|c| c.is_element()) {
            Some(c) => c,
            None => return Ok(json!({})),
        }
    } else {
        root
    };
    Ok(parse_node(container, 0))
}

fn node_text(node: roxmltree::Node) -> String {
    node.text().unwrap_or("").trim().to_string()
}

/// Read a leading signed-integer prefix (matching the reference's `sscanf("%d")`),
/// then fall back to a truncated float, else 0 - so `1.23`/`42x` give 1/42, not 0.
fn parse_int_prefix(s: &str) -> i64 {
    let t = s.trim();
    let b = t.as_bytes();
    let mut end = 0;
    if end < b.len() && (b[end] == b'+' || b[end] == b'-') {
        end += 1;
    }
    let digits_start = end;
    while end < b.len() && b[end].is_ascii_digit() {
        end += 1;
    }
    if end > digits_start {
        if let Ok(n) = t[..end].parse::<i64>() {
            return n;
        }
    }
    t.parse::<f64>().ok().map(|f| f as i64).unwrap_or(0)
}

/// Cap on nesting depth so a maliciously deep LLSD body can't overflow the thread
/// stack and abort the process. Real cap/EventQueue payloads are nowhere near it.
const MAX_LLSD_DEPTH: u32 = 64;

/// A cheap O(n) scan for the deepest element nesting in an XML string, so we can
/// reject a nesting bomb before a recursive tree builder can overflow. It's rough
/// by design (it ignores `>` inside attribute values, and `<!`/`<?` aren't elements) -
/// all it needs to catch is "far too deep", not the exact count.
pub(crate) fn max_xml_nesting(s: &str) -> usize {
    let b = s.as_bytes();
    let (mut depth, mut max, mut i) = (0usize, 0usize, 0usize);
    while i < b.len() {
        if b[i] == b'<' {
            match b.get(i + 1) {
                Some(b'/') => depth = depth.saturating_sub(1),
                Some(b'!') | Some(b'?') => {}
                _ => {
                    let mut j = i + 1;
                    while j < b.len() && b[j] != b'>' {
                        j += 1;
                    }
                    // `<tag .../>` closes itself, so there's no net change in depth.
                    if b.get(j.wrapping_sub(1)) != Some(&b'/') {
                        depth += 1;
                        if depth > max {
                            max = depth;
                        }
                    }
                    i = j;
                }
            }
        }
        i += 1;
    }
    max
}

fn parse_node(node: roxmltree::Node, depth: u32) -> Value {
    if depth >= MAX_LLSD_DEPTH {
        return Value::Null;
    }
    match node.tag_name().name() {
        "map" => {
            let mut map = Map::new();
            let elems: Vec<roxmltree::Node> = node.children().filter(|c| c.is_element()).collect();
            let mut i = 0;
            while i < elems.len() {
                if elems[i].has_tag_name("key") {
                    let key = node_text(elems[i]);
                    if let Some(val) = elems.get(i + 1) {
                        map.insert(key, parse_node(*val, depth + 1));
                        i += 2;
                        continue;
                    }
                }
                i += 1;
            }
            Value::Object(map)
        }
        "array" => Value::Array(
            node.children()
                .filter(|c| c.is_element())
                .map(|c| parse_node(c, depth + 1))
                .collect(),
        ),
        "boolean" => {
            let t = node_text(node).to_ascii_lowercase();
            json!(t == "1" || t == "true")
        }
        "integer" | "int" => json!(parse_int_prefix(&node_text(node))),
        "real" | "double" => {
            // Coerce non-finite values (inf/nan/overflow) to 0 so the result stays a
            // JSON number rather than becoming null.
            let r = node_text(node).parse::<f64>().unwrap_or(0.0);
            json!(if r.is_finite() { r } else { 0.0 })
        }
        // Strings are preserved byte-for-byte (no trim): leading and trailing whitespace,
        // and whitespace-only values, are all meaningful here (IM text, descriptions, notices).
        "string" => json!(node.text().unwrap_or("").to_string()),
        "uuid" | "date" | "uri" => json!(node_text(node)),
        "binary" => {
            // Respect the encoding attribute, and strip whitespace out of wrapped base64.
            let enc = node.attribute("encoding").unwrap_or("base64");
            if !enc.eq_ignore_ascii_case("base64") {
                Value::Array(Vec::new())
            } else {
                let cleaned: String =
                    node_text(node).chars().filter(|c| !c.is_ascii_whitespace()).collect();
                match B64.decode(cleaned.as_bytes()) {
                    Ok(bytes) => Value::Array(bytes.into_iter().map(|b| json!(b)).collect()),
                    Err(_) => Value::Array(Vec::new()),
                }
            }
        }
        "undef" => Value::Null,
        _ => json!(node_text(node)),
    }
}

// Outbound LLSD XML (the seed-cap grant array) is built over in bridge/util.rs; this
// module only parses, so no serializer lives here.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_map_array_scalars() {
        let xml = r#"<?xml version="1.0"?><llsd><map>
            <key>id</key><integer>7</integer>
            <key>on</key><boolean>true</boolean>
            <key>name</key><string>Region &amp; Co</string>
            <key>events</key><array><string>a</string><string>b</string></array>
        </map></llsd>"#;
        let v = parse(xml, "application/llsd+xml").unwrap();
        assert_eq!(v["id"], 7);
        assert_eq!(v["on"], true);
        assert_eq!(v["name"], "Region & Co");
        assert_eq!(v["events"][1], "b");
    }

    #[test]
    fn parse_binary_as_byte_array() {
        // base64 of the bytes [0,0,0,42]
        let b64 = B64.encode([0u8, 0, 0, 42]);
        let xml = format!(
            "<llsd><map><key>ParcelFlags</key><binary encoding=\"base64\">{}</binary></map></llsd>",
            b64
        );
        let v = parse(&xml, "application/llsd+xml").unwrap();
        assert_eq!(v["ParcelFlags"], json!([0, 0, 0, 42]));
    }

    #[test]
    fn deep_nesting_is_rejected_not_overflow() {
        // A pathologically deep body has to be refused before roxmltree can build
        // (and blow the stack on) it - we want a clean Err, not a crash.
        let deep = format!("<llsd>{}{}</llsd>", "<array>".repeat(500), "</array>".repeat(500));
        assert!(parse(&deep, "application/llsd+xml").is_err());
        // And a normal, shallow body still parses fine.
        let ok = parse("<llsd><array><integer>1</integer></array></llsd>", "application/llsd+xml").unwrap();
        assert!(ok.is_array());
    }

    #[test]
    fn json_passthrough() {
        let v = parse(r#"{"a":1,"b":[2,3]}"#, "application/json").unwrap();
        assert_eq!(v["a"], 1);
        assert_eq!(v["b"][1], 3);
    }
}
