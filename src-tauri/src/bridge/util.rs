//! Small shared helpers for the Second Life UDP/HTTP transport: normalising
//! addresses and UUIDs, rewriting seed-capability URLs, and parsing LLSD caps.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

/// Escape a string so it's safe inside XML text or attributes (the XML1
/// entities, plus both quote characters).
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Format a 32-bit integer as a dotted IPv4 address.
pub fn long2ip(n: u32) -> String {
    format!(
        "{}.{}.{}.{}",
        (n >> 24) & 0xFF,
        (n >> 16) & 0xFF,
        (n >> 8) & 0xFF,
        n & 0xFF
    )
}

fn is_valid_ip(s: &str) -> bool {
    s.parse::<std::net::IpAddr>().is_ok()
}

/// Normalise a sim IP, which may arrive as an integer, a dotted string, a
/// numeric string, or a hostname.
pub fn normalize_sim_ip(value: &Value) -> String {
    match value {
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                return long2ip((u & 0xFFFF_FFFF) as u32);
            }
            if let Some(i) = n.as_i64() {
                return long2ip((i as u64 & 0xFFFF_FFFF) as u32);
            }
            String::new()
        }
        Value::String(s) => normalize_sim_ip_str(s),
        _ => String::new(),
    }
}

pub fn normalize_sim_ip_str(raw: &str) -> String {
    let s = raw.trim_matches(|c| c == ' ' || c == '\t' || c == '"' || c == '\'');
    if s.is_empty() {
        return String::new();
    }
    if is_valid_ip(s) {
        return s.to_string();
    }
    if s.chars().all(|c| c.is_ascii_digit()) {
        if let Ok(u) = s.parse::<u64>() {
            return long2ip((u & 0xFFFF_FFFF) as u32);
        }
    }
    // Hostname: leave it unchanged. DNS gets resolved asynchronously at the
    // point of use (circuit::open via lookup_host); a blocking getaddrinfo
    // here would stall a Tokio worker thread.
    s.to_string()
}

/// Convert a UUID string into its 16 raw bytes, or all zeros if it's malformed.
pub fn uuid_to_bytes(uuid: &str) -> [u8; 16] {
    let hex: String = uuid.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let mut out = [0u8; 16];
    if hex.len() != 32 {
        return out;
    }
    for i in 0..16 {
        if let Ok(b) = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16) {
            out[i] = b;
        } else {
            return [0u8; 16];
        }
    }
    out
}

static SEED_HAS_SCHEME: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.\-]*:").unwrap());
static SEED_SIMHOST_RAW: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(https?)://simhost-(\d+)/([0-9a-f]+)\.agni\.secondlife\.io(:\d+)?(/.*)?$")
        .unwrap()
});
static SEED_SIMHOST_PATH: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^/([0-9a-f]+)\.agni\.secondlife\.io(:\d+)?(/cap/.*)$").unwrap()
});
static SIMHOST_HOST: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^simhost-\d+$").unwrap());

/// Collapse the split simhost seed-capability form back into its single-host form
/// (e.g. `https://simhost-N/HEX.agni.secondlife.io/...` -> `https://simhost-NHEX...`).
pub fn normalize_seed_url(url: &str) -> String {
    let mut url = url.trim().to_string();
    if url.is_empty() {
        return String::new();
    }
    if !SEED_HAS_SCHEME.is_match(&url) {
        url = format!("https://{}", url.trim_start_matches('/'));
    }

    // Parsed-URL branch: a `simhost-N` host with `/HEX.agni.secondlife.io.../cap/...`.
    if let Ok(parsed) = reqwest::Url::parse(&url) {
        if let Some(host) = parsed.host_str() {
            if SIMHOST_HOST.is_match(host) {
                let mut full_path = parsed.path().to_string();
                if let Some(q) = parsed.query() {
                    full_path.push('?');
                    full_path.push_str(q);
                }
                if let Some(f) = parsed.fragment() {
                    full_path.push('#');
                    full_path.push_str(f);
                }
                if let Some(caps) = SEED_SIMHOST_PATH.captures(&full_path) {
                    let hex = &caps[1];
                    let port = caps
                        .get(2)
                        .map(|m| m.as_str().to_string())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| parsed.port().map(|p| format!(":{p}")).unwrap_or_default());
                    let tail = &caps[3];
                    return format!("https://{host}{hex}.agni.secondlife.io{port}{tail}");
                }
            }
        }
    }

    // Raw-string branch: match the URL text directly.
    if let Some(caps) = SEED_SIMHOST_RAW.captures(&url) {
        let n = &caps[2];
        let hex = &caps[3];
        let port = caps.get(4).map(|m| m.as_str()).unwrap_or("");
        let tail = caps.get(5).map(|m| m.as_str()).unwrap_or("");
        return format!("https://simhost-{n}{hex}.agni.secondlife.io{port}{tail}");
    }

    url
}

static LLSD_CAP_MAP: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)<key>([^<]+)</key>\s*<(?:uri|string)>([^<]+)</(?:uri|string)>").unwrap()
});
static LLSD_CAP_KEYS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)<key>([^<]+)</key>\s*<(?:uri|string)>").unwrap());

/// Build the LLSD `<array>` of capability names we send to the seed cap.
pub fn llsd_array_xml(names: &[&str]) -> String {
    let mut inner = String::new();
    for name in names {
        inner.push_str("<string>");
        inner.push_str(&xml_escape(name));
        inner.push_str("</string>");
    }
    format!("<llsd><array>{inner}</array></llsd>\n")
}

/// Pull the capability name-to-URL pairs out of an LLSD map response.
pub fn llsd_cap_map(body: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for caps in LLSD_CAP_MAP.captures_iter(body) {
        map.insert(caps[1].to_string(), caps[2].to_string());
    }
    map
}

/// List the capability keys found in an LLSD map, in the order they appear.
pub fn llsd_cap_keys(body: &str) -> Vec<String> {
    LLSD_CAP_KEYS
        .captures_iter(body)
        .map(|c| c[1].to_string())
        .collect()
}

/// A seed grant becomes usable as soon as it carries at least one region cap.
pub fn seed_has_region_caps(keys: &[String]) -> bool {
    let needles = ["eventqueueget", "getdisplaynames", "remoteparcelrequest"];
    keys.iter()
        .any(|k| needles.contains(&k.to_ascii_lowercase().as_str()))
}

/// Strip leading and trailing spaces, tabs, and any wrapping single or double quotes.
pub fn trim_quotes(s: &str) -> String {
    s.trim_matches(|c| c == ' ' || c == '\t' || c == '"' || c == '\'')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn xml_escape_covers_entities() {
        assert_eq!(xml_escape("a<b>&\"'"), "a&lt;b&gt;&amp;&quot;&apos;");
    }

    #[test]
    fn long2ip_big_endian() {
        assert_eq!(long2ip(0x7F00_0001), "127.0.0.1");
        assert_eq!(long2ip(0xC0A8_0101), "192.168.1.1");
    }

    #[test]
    fn normalize_sim_ip_from_integer() {
        // 3232235777 is 0xC0A80101, i.e. 192.168.1.1
        assert_eq!(normalize_sim_ip(&json!(3232235777u64)), "192.168.1.1");
    }

    #[test]
    fn normalize_sim_ip_from_dotted_and_numeric_string() {
        assert_eq!(normalize_sim_ip(&json!("54.10.20.30")), "54.10.20.30");
        assert_eq!(normalize_sim_ip(&json!("2130706433")), "127.0.0.1");
        assert_eq!(normalize_sim_ip(&json!("  \"8.8.8.8\" ")), "8.8.8.8");
    }

    #[test]
    fn uuid_to_bytes_round_trips_and_rejects_bad() {
        let b = uuid_to_bytes("00112233-4455-6677-8899-aabbccddeeff");
        assert_eq!(b[0], 0x00);
        assert_eq!(b[1], 0x11);
        assert_eq!(b[15], 0xff);
        assert_eq!(uuid_to_bytes("not-a-uuid"), [0u8; 16]);
    }

    #[test]
    fn normalize_seed_url_collapses_split_simhost() {
        // Split form: a `simhost-<digits>` host with a `/<hex>.agni.secondlife.io.../cap/...` path.
        let input = "https://simhost-1234/abcdef.agni.secondlife.io:12043/cap/foo";
        assert_eq!(
            normalize_seed_url(input),
            "https://simhost-1234abcdef.agni.secondlife.io:12043/cap/foo"
        );
    }

    #[test]
    fn normalize_seed_url_passthrough_for_normal_urls() {
        let u = "https://simhost-1234.agni.secondlife.io:12043/cap/x";
        assert_eq!(normalize_seed_url(u), u);
    }

    #[test]
    fn normalize_seed_url_adds_scheme() {
        assert_eq!(normalize_seed_url("example.com/x"), "https://example.com/x");
    }

    #[test]
    fn llsd_array_xml_wraps_names() {
        let xml = llsd_array_xml(&["EventQueueGet", "GetDisplayNames"]);
        assert!(xml.contains("<string>EventQueueGet</string>"));
        assert!(xml.contains("<string>GetDisplayNames</string>"));
        assert!(xml.starts_with("<llsd><array>"));
    }

    #[test]
    fn llsd_cap_map_and_keys_parse() {
        let body = "<llsd><map>\
            <key>EventQueueGet</key><uri>https://sim/cap/eq</uri>\
            <key>GetDisplayNames</key><string>https://sim/cap/dn</string>\
            </map></llsd>";
        let map = llsd_cap_map(body);
        assert_eq!(map.get("EventQueueGet").unwrap(), "https://sim/cap/eq");
        assert_eq!(map.get("GetDisplayNames").unwrap(), "https://sim/cap/dn");
        let keys = llsd_cap_keys(body);
        assert_eq!(keys, vec!["EventQueueGet", "GetDisplayNames"]);
    }

    #[test]
    fn seed_has_region_caps_detects_needles() {
        assert!(seed_has_region_caps(&["EventQueueGet".into(), "Foo".into()]));
        assert!(seed_has_region_caps(&["remoteparcelrequest".into()]));
        assert!(!seed_has_region_caps(&["Foo".into(), "Bar".into()]));
    }

    #[test]
    fn trim_quotes_strips_wrapping() {
        assert_eq!(trim_quotes("  '\"abc\"'  "), "abc");
    }
}
