//! URL matching and trust classification for chat and IM.
//!
//! [`linkify`] breaks text into plain runs and [`Segment`] links, each carrying a
//! URL, label, trusted flag, and kind. This is the canonical grammar; the WebView
//! mirrors it so both sides stay in sync.

use serde::Serialize;

/// Hosts we trust, so opening them skips the external-link warning.
const TRUSTED_SUFFIXES: &[&str] = &[
    "secondlife.com",
    "secondlife.io",
    "secondlifegrid.net",
    "secondlife-status.statuspage.io",
    "lindenlab.com",
    "tilia-inc.com",
    "phoenixviewer.com",
    "firestormviewer.org",
    "slurl.com", // legacy in-world map host; we treat it as an in-world SLURL
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Slurl,
    Http,
    Email,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Segment {
    /// A stretch of literal text; the renderer still has to HTML-escape it.
    Text { text: String },
    /// A link we recognised.
    Link {
        /// The real URL we act on and show in the tooltip.
        url: String,
        /// What we show: a bracket label, a friendly SLURL label, or the url.
        label: String,
        /// True for Linden/known hosts, false for an arbitrary external URL.
        trusted: bool,
        /// The matcher that produced this link.
        kind: LinkKind,
        /// True when it came from `[url Label]` bracket syntax.
        bracketed: bool,
    },
}

struct Raw {
    start: usize,
    end: usize,
    url: String,
    label: Option<String>,
    kind: LinkKind,
    bracketed: bool,
    /// When two matches share a start offset, the lower number wins.
    priority: u8,
}

fn host_of(url: &str) -> Option<String> {
    // Drop the scheme first.
    let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    // The host ends at the first authority delimiter, and backslash has to count
    // too: the WHATWG URL parser normalizes '\' to '/' in http(s) URLs, so a link
    // like `http://evil.com\.secondlife.com/` really targets evil.com. Leaving '\'
    // in the host would let that phishing URL read as a trusted domain.
    let host = after_scheme
        .split(|c| c == '/' || c == '\\' || c == '?' || c == '#')
        .next()
        .unwrap_or("");
    let host = host.split('@').next_back().unwrap_or(host); // drop any userinfo
    let host = host.split(':').next().unwrap_or(host); // drop the port
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

fn host_trusted(host: &str) -> bool {
    TRUSTED_SUFFIXES
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

/// Strip trailing punctuation that a URL shouldn't swallow.
fn trim_trailing(url: &str) -> &str {
    let mut end = url.len();
    let bytes = url.as_bytes();
    while end > 0 {
        let c = bytes[end - 1] as char;
        let drop = match c {
            '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '"' | '>' => true,
            ')' => !url[..end].contains('('),
            ']' => true,
            _ => false,
        };
        if drop {
            end -= 1;
        } else {
            break;
        }
    }
    &url[..end]
}

/// Build a friendly label for a SLURL: `Region (x, y, z)` when the coordinates
/// are present, otherwise the region name, and failing that the raw URL.
fn slurl_label(url: &str) -> String {
    // Find the path that follows the scheme and host.
    let lower = url.to_ascii_lowercase();
    let path = if let Some(rest) = lower.strip_prefix("secondlife://") {
        // e.g. secondlife://Region/x/y/z  or  secondlife:///app/...
        let orig = &url["secondlife://".len()..];
        if rest.starts_with("/app/") || rest.starts_with("app/") {
            return url.to_string();
        }
        orig.to_string()
    } else if let Some(idx) = lower.find("/secondlife/") {
        url[idx + "/secondlife/".len()..].to_string()
    } else {
        return url.to_string();
    };

    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return url.to_string();
    }
    let region = percent_decode(&parts[0].replace('+', " "));
    let nums: Vec<i64> = parts[1..]
        .iter()
        .take(3)
        .filter_map(|p| p.parse::<i64>().ok())
        .collect();
    match nums.len() {
        // Don't make up a Z the URL never carried: two-coord SLURLs render as (x, y).
        n if n >= 3 => format!("{region} ({}, {}, {})", nums[0], nums[1], nums[2]),
        2 => format!("{region} ({}, {})", nums[0], nums[1]),
        _ => region,
    }
}

/// Just enough percent-decoding for SLURL region names. These feed labels only,
/// so it isn't security sensitive.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Parse the input into an ordered run of text and link segments.
pub fn linkify(text: &str) -> Vec<Segment> {
    use once_cell::sync::Lazy;
    use regex::Regex;

    // `[ (secondlife://|http(s)://)URL  Label ]` becomes a masked label link.
    static BRACKET: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"(?i)\[\s*((?:secondlife://|https?://)[^\s\]]+)[ \t]+([^\]]*?)\s*\]"#).unwrap()
    });
    // SLURLs: either the secondlife:// scheme, or maps.secondlife.com / slurl.com
    // map links (the reference viewer's LLUrlEntrySLURL recognizes both map hosts).
    static SLURL: Lazy<Regex> = Lazy::new(|| {
        Regex::new(
            r#"(?i)(?:secondlife://[^\s<>\]"]+|https?://(?:maps\.secondlife\.com|slurl\.com)/secondlife/[^\s<>\]"]+)"#,
        )
        .unwrap()
    });
    static HTTP: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)https?://[^\s<>\]"]+"#).unwrap());
    static EMAIL: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b"#).unwrap()
    });

    let mut raws: Vec<Raw> = Vec::new();

    for m in BRACKET.captures_iter(text) {
        let whole = m.get(0).unwrap();
        let url = trim_trailing(m.get(1).unwrap().as_str()).to_string();
        let label = m.get(2).map(|l| l.as_str().trim().to_string());
        let lower = url.to_ascii_lowercase();
        let kind = if lower.starts_with("secondlife://")
            || lower.contains("maps.secondlife.com/secondlife/")
            || lower.contains("slurl.com/secondlife/")
        {
            LinkKind::Slurl
        } else {
            LinkKind::Http
        };
        raws.push(Raw {
            start: whole.start(),
            end: whole.end(),
            url,
            label: label.filter(|l| !l.is_empty()),
            kind,
            bracketed: true,
            priority: 0,
        });
    }
    for m in SLURL.find_iter(text) {
        let trimmed = trim_trailing(m.as_str());
        raws.push(Raw {
            start: m.start(),
            end: m.start() + trimmed.len(),
            url: trimmed.to_string(),
            label: None,
            kind: LinkKind::Slurl,
            bracketed: false,
            priority: 1,
        });
    }
    for m in HTTP.find_iter(text) {
        let trimmed = trim_trailing(m.as_str());
        raws.push(Raw {
            start: m.start(),
            end: m.start() + trimmed.len(),
            url: trimmed.to_string(),
            label: None,
            kind: LinkKind::Http,
            bracketed: false,
            priority: 2,
        });
    }
    for m in EMAIL.find_iter(text) {
        raws.push(Raw {
            start: m.start(),
            end: m.end(),
            url: format!("mailto:{}", m.as_str()),
            label: Some(m.as_str().to_string()),
            kind: LinkKind::Email,
            bracketed: false,
            priority: 3,
        });
    }

    // Earliest match wins, and ties go to the higher-priority matcher.
    raws.sort_by(|a, b| a.start.cmp(&b.start).then(a.priority.cmp(&b.priority)));

    let mut segments: Vec<Segment> = Vec::new();
    let mut cursor = 0usize;
    for raw in raws {
        if raw.start < cursor || raw.end <= raw.start {
            continue; // overlaps a link we've already accepted
        }
        if raw.start > cursor {
            segments.push(Segment::Text {
                text: text[cursor..raw.start].to_string(),
            });
        }
        let trusted = match raw.kind {
            LinkKind::Slurl => {
                // secondlife:// is in-world so always trusted; maps links get checked by host.
                raw.url.to_ascii_lowercase().starts_with("secondlife://")
                    || host_of(&raw.url).map(|h| host_trusted(&h)).unwrap_or(false)
            }
            LinkKind::Http => host_of(&raw.url).map(|h| host_trusted(&h)).unwrap_or(false),
            LinkKind::Email => false,
        };
        let label = raw.label.unwrap_or_else(|| match raw.kind {
            LinkKind::Slurl => slurl_label(&raw.url),
            _ => raw.url.clone(),
        });
        segments.push(Segment::Link {
            url: raw.url,
            label,
            trusted,
            kind: raw.kind,
            bracketed: raw.bracketed,
        });
        cursor = raw.end;
    }
    if cursor < text.len() {
        segments.push(Segment::Text {
            text: text[cursor..].to_string(),
        });
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links(segs: &[Segment]) -> Vec<&Segment> {
        segs.iter()
            .filter(|s| matches!(s, Segment::Link { .. }))
            .collect()
    }

    #[test]
    fn plain_text_has_no_links() {
        let segs = linkify("just some ordinary chat text");
        assert_eq!(links(&segs).len(), 0);
        assert_eq!(segs.len(), 1);
    }

    #[test]
    fn bare_http_is_untrusted() {
        let segs = linkify("see http://www.example.org/page for details");
        let l = links(&segs);
        assert_eq!(l.len(), 1);
        match l[0] {
            Segment::Link { url, trusted, kind, bracketed, .. } => {
                assert_eq!(url, "http://www.example.org/page");
                assert!(!*trusted);
                assert_eq!(*kind, LinkKind::Http);
                assert!(!*bracketed);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn secondlife_domain_is_trusted() {
        let segs = linkify("https://community.secondlife.com/blog");
        match links(&segs)[0] {
            Segment::Link { trusted, .. } => assert!(*trusted),
            _ => panic!(),
        }
    }

    #[test]
    fn bracket_label_masks_url() {
        // Mirrors the reference viewer's LLUrlEntryHTTPLabel: [url  Label] shows "Label".
        let segs = linkify("click [http://www.example.org/x  Label text] now");
        let l = links(&segs);
        assert_eq!(l.len(), 1);
        match l[0] {
            Segment::Link { url, label, bracketed, .. } => {
                assert_eq!(url, "http://www.example.org/x");
                assert_eq!(label, "Label text");
                assert!(*bracketed);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn unterminated_bracket_stays_plain_but_url_still_links() {
        // "[http://x" with no closing ]: the bare-URL matcher still links the
        // URL, and the leading '[' is kept as text.
        let segs = linkify("[http://www.example.org/x");
        let l = links(&segs);
        assert_eq!(l.len(), 1);
        assert!(matches!(&segs[0], Segment::Text { text } if text == "["));
    }

    #[test]
    fn slurl_gets_friendly_label() {
        let segs = linkify("come to secondlife://Natoma/128/64/25 now");
        match links(&segs)[0] {
            Segment::Link { label, trusted, kind, .. } => {
                assert_eq!(label, "Natoma (128, 64, 25)");
                assert!(*trusted);
                assert_eq!(*kind, LinkKind::Slurl);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn backslash_host_is_not_trusted() {
        // `http://evil.com\.secondlife.com/` really targets evil.com (WHATWG
        // normalizes '\' to '/'), so it must NOT be classified as a trusted domain.
        let segs = linkify("visit http://evil.com\\.secondlife.com/phish now");
        let l = links(&segs);
        assert_eq!(l.len(), 1);
        match l[0] {
            Segment::Link { trusted, .. } => assert!(!*trusted, "backslash host must be untrusted"),
            _ => panic!(),
        }
        // The userinfo variant mustn't be trusted either.
        let segs2 = linkify("http://evil.com\\@login.secondlife.com/");
        match links(&segs2)[0] {
            Segment::Link { trusted, .. } => assert!(!*trusted),
            _ => panic!(),
        }
    }

    #[test]
    fn slurl_com_is_slurl_and_trusted() {
        // Legacy slurl.com map links count as in-world SLURLs, not untrusted HTTP.
        let segs = linkify("http://slurl.com/secondlife/Natoma/128/64/25");
        let l = links(&segs);
        assert_eq!(l.len(), 1);
        match l[0] {
            Segment::Link { kind, trusted, .. } => {
                assert_eq!(*kind, LinkKind::Slurl);
                assert!(*trusted);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn maps_secondlife_is_slurl_not_bare_http() {
        let segs = linkify("http://maps.secondlife.com/secondlife/Natoma/128/64/25");
        let l = links(&segs);
        assert_eq!(l.len(), 1);
        match l[0] {
            Segment::Link { kind, trusted, label, .. } => {
                assert_eq!(*kind, LinkKind::Slurl);
                assert!(*trusted);
                assert_eq!(label, "Natoma (128, 64, 25)");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn trailing_punctuation_trimmed() {
        let segs = linkify("go to http://example.com/path, ok?");
        match links(&segs)[0] {
            Segment::Link { url, .. } => assert_eq!(url, "http://example.com/path"),
            _ => panic!(),
        }
    }

    #[test]
    fn balanced_paren_kept() {
        let segs = linkify("wiki http://en.wikipedia.org/wiki/Foo_(bar) end");
        match links(&segs)[0] {
            Segment::Link { url, .. } => {
                assert_eq!(url, "http://en.wikipedia.org/wiki/Foo_(bar)")
            }
            _ => panic!(),
        }
    }

    #[test]
    fn email_becomes_mailto() {
        let segs = linkify("mail me at bob@example.com please");
        match links(&segs)[0] {
            Segment::Link { url, label, kind, trusted, .. } => {
                assert_eq!(url, "mailto:bob@example.com");
                assert_eq!(label, "bob@example.com");
                assert_eq!(*kind, LinkKind::Email);
                assert!(!*trusted);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn multiple_links_and_text_ordered() {
        let segs = linkify("a http://x.com b secondlife://R/1/2/3 c");
        let kinds: Vec<_> = segs
            .iter()
            .map(|s| match s {
                Segment::Text { .. } => "t",
                Segment::Link { .. } => "l",
            })
            .collect();
        assert_eq!(kinds, vec!["t", "l", "t", "l", "t"]);
    }
}
