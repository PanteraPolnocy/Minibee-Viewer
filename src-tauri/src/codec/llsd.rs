//! LLSD XML/JSON codec for capability and EventQueue bodies.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Map, Value};

/// Parse an LLSD document. `content_type` selects JSON vs XML; XML is the
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
    let doc = roxmltree::Document::parse(text).map_err(|_| "Invalid LLSD XML".to_string())?;
    // The payload is the first element child of <llsd>, or the root element.
    let root = doc.root_element();
    let container = if root.has_tag_name("llsd") {
        match root.children().find(|c| c.is_element()) {
            Some(c) => c,
            None => return Ok(json!({})),
        }
    } else {
        root
    };
    Ok(parse_node(container))
}

fn node_text(node: roxmltree::Node) -> String {
    node.text().unwrap_or("").trim().to_string()
}

fn parse_node(node: roxmltree::Node) -> Value {
    match node.tag_name().name() {
        "map" => {
            let mut map = Map::new();
            let elems: Vec<roxmltree::Node> = node.children().filter(|c| c.is_element()).collect();
            let mut i = 0;
            while i < elems.len() {
                if elems[i].has_tag_name("key") {
                    let key = node_text(elems[i]);
                    if let Some(val) = elems.get(i + 1) {
                        map.insert(key, parse_node(*val));
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
                .map(parse_node)
                .collect(),
        ),
        "boolean" => {
            let t = node_text(node).to_ascii_lowercase();
            json!(t == "1" || t == "true")
        }
        "integer" | "int" => json!(node_text(node).parse::<i64>().unwrap_or(0)),
        "real" | "double" => json!(node_text(node).parse::<f64>().unwrap_or(0.0)),
        "uuid" | "string" | "date" | "uri" => json!(node_text(node)),
        "binary" => {
            // Honor the encoding attribute; strip whitespace from wrapped base64.
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

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;")
}

fn value_xml(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("<undef/>"),
        Value::Bool(b) => {
            out.push_str("<boolean>");
            out.push_str(if *b { "true" } else { "false" });
            out.push_str("</boolean>");
        }
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                out.push_str(&format!("<integer>{}</integer>", n));
            } else {
                out.push_str(&format!("<real>{}</real>", n));
            }
        }
        Value::String(s) => {
            out.push_str("<string>");
            out.push_str(&xml_escape(s));
            out.push_str("</string>");
        }
        Value::Array(arr) => {
            out.push_str("<array>");
            for item in arr {
                value_xml(item, out);
            }
            out.push_str("</array>");
        }
        Value::Object(map) => {
            out.push_str("<map>");
            for (k, v) in map {
                out.push_str("<key>");
                out.push_str(&xml_escape(k));
                out.push_str("</key>");
                value_xml(v, out);
            }
            out.push_str("</map>");
        }
    }
}

/// Serialize a `Value` to an LLSD XML document.
pub fn to_xml(value: &Value) -> String {
    let mut out = String::from("<?xml version=\"1.0\"?><llsd>");
    value_xml(value, &mut out);
    out.push_str("</llsd>");
    out
}

/// Build the `<llsd><array>` of strings used by cap requests (e.g. seed grant).
pub fn array_xml(strings: &[&str]) -> String {
    to_xml(&Value::Array(strings.iter().map(|s| json!(s)).collect()))
}

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
        // base64 of [0,0,0,42]
        let b64 = B64.encode([0u8, 0, 0, 42]);
        let xml = format!(
            "<llsd><map><key>ParcelFlags</key><binary encoding=\"base64\">{}</binary></map></llsd>",
            b64
        );
        let v = parse(&xml, "application/llsd+xml").unwrap();
        assert_eq!(v["ParcelFlags"], json!([0, 0, 0, 42]));
    }

    #[test]
    fn roundtrip_xml() {
        let v = json!({ "ack": 3, "done": false, "list": ["x", "y"] });
        let xml = to_xml(&v);
        let back = parse(&xml, "application/llsd+xml").unwrap();
        assert_eq!(back["ack"], 3);
        assert_eq!(back["done"], false);
        assert_eq!(back["list"][0], "x");
    }

    #[test]
    fn json_passthrough() {
        let v = parse(r#"{"a":1,"b":[2,3]}"#, "application/json").unwrap();
        assert_eq!(v["a"], 1);
        assert_eq!(v["b"][1], 3);
    }
}
