//! Shared helpers for the Second Life UDP/HTTP transport: address and UUID
//! normalisation, seed-capability URL rewriting, and LLSD capability parsing.

use std::collections::HashMap;
use std::net::ToSocketAddrs;

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

/// Escape a string for embedding in XML text/attributes (XML1 entities plus
/// both quote characters).
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

/// Interpret a 32-bit integer as a dotted IPv4 address.
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

/// Normalise a sim IP that may arrive as an integer, dotted string, numeric
/// string, or hostname.
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
    // Hostname: resolve to the first IPv4 address, else return unchanged.
    if let Ok(addrs) = (s, 0u16).to_socket_addrs() {
        for addr in addrs {
            if addr.is_ipv4() {
                return addr.ip().to_string();
            }
        }
    }
    s.to_string()
}

/// Convert a UUID string to its 16 raw bytes; zero-filled when malformed.
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

/// Rewrite the split simhost seed capability form into the collapsed host form
/// (e.g. `https://simhost-N/HEX.agni.secondlife.io/...` -> `https://simhost-NHEX...`).
pub fn normalize_seed_url(url: &str) -> String {
    let mut url = url.trim().to_string();
    if url.is_empty() {
        return String::new();
    }
    if !SEED_HAS_SCHEME.is_match(&url) {
        url = format!("https://{}", url.trim_start_matches('/'));
    }

    // Parsed-URL branch: `simhost-N` host + `/HEX.agni.secondlife.io.../cap/...`
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

    // Raw-string branch.
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

/// Build the LLSD `<array>` of capability names sent to the seed cap.
pub fn llsd_array_xml(names: &[&str]) -> String {
    let mut inner = String::new();
    for name in names {
        inner.push_str("<string>");
        inner.push_str(&xml_escape(name));
        inner.push_str("</string>");
    }
    format!("<llsd><array>{inner}</array></llsd>\n")
}

/// Extract capability name→URL pairs from an LLSD map response.
pub fn llsd_cap_map(body: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for caps in LLSD_CAP_MAP.captures_iter(body) {
        map.insert(caps[1].to_string(), caps[2].to_string());
    }
    map
}

/// Extract the ordered list of capability keys present in an LLSD map.
pub fn llsd_cap_keys(body: &str) -> Vec<String> {
    LLSD_CAP_KEYS
        .captures_iter(body)
        .map(|c| c[1].to_string())
        .collect()
}

/// A seed grant is usable once it contains at least one region cap.
pub fn seed_has_region_caps(keys: &[String]) -> bool {
    let needles = ["eventqueueget", "getdisplaynames", "remoteparcelrequest"];
    keys.iter()
        .any(|k| needles.contains(&k.to_ascii_lowercase().as_str()))
}

/// Trim spaces, tabs, and surrounding single/double quotes.
pub fn trim_quotes(s: &str) -> String {
    s.trim_matches(|c| c == ' ' || c == '\t' || c == '"' || c == '\'')
        .to_string()
}
