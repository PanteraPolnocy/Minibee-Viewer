//! RSS/Atom feeds for the News panel

use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};

use crate::bridge::state::AppState;

const MAX_ITEMS: usize = 40;

fn feed_url(kind: &str) -> Option<&'static str> {
    match kind {
        "linden-news" => Some("https://community.secondlife.com/rss/1-blog-rss.xml"),
        "grid-status" => Some("https://status.secondlifegrid.net/history.rss"),
        "blogs" => Some("https://www.inoreader.com/stream/user/1003852272/tag/Second%20Life%20Bloggers"),
        _ => None,
    }
}

static IMG_SRC: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)<img[^>]+src\s*=\s*["']([^"']+)["']"#).unwrap());

fn decode_entities(s: &str) -> String {
    static NUMERIC: Lazy<Regex> = Lazy::new(|| Regex::new(r"&#(x?)([0-9A-Fa-f]+);").unwrap());
    let out = NUMERIC.replace_all(s, |c: &regex::Captures| {
        let raw = &c[2];
        let n = if c[1].is_empty() {
            raw.parse::<u32>().ok()
        } else {
            u32::from_str_radix(raw, 16).ok()
        };
        n.and_then(char::from_u32).map(String::from).unwrap_or_default()
    });
    ascii_punct(
        out.replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&#39;", "'"),
    )
}

fn ascii_punct(s: String) -> String {
    s.chars()
        .flat_map(|c| match c {
            '\u{2018}' | '\u{2019}' => vec!['\''],
            '\u{201C}' | '\u{201D}' => vec!['"'],
            '\u{2013}' | '\u{2014}' => vec!['-'],
            '\u{2026}' => vec!['.', '.', '.'],
            _ => vec![c],
        })
        .collect()
}

pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' => {
                in_tag = false;
                let name = tag.trim_start_matches('/').trim().to_ascii_lowercase();
                let name = name.split_whitespace().next().unwrap_or("");
                // Block-level tags become line breaks; everything else just goes.
                if matches!(
                    name,
                    "p" | "br" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                        | "blockquote" | "ul" | "ol" | "table" | "section" | "article" | "hr"
                ) {
                    out.push('\n');
                }
            }
            _ if in_tag => tag.push(ch),
            _ => out.push(ch),
        }
    }
    let decoded = decode_entities(&out);
    let mut lines: Vec<String> = Vec::new();
    for line in decoded.lines() {
        let t = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if t.is_empty() {
            if matches!(lines.last().map(|l| l.is_empty()), Some(true) | None) {
                continue;
            }
            lines.push(String::new());
        } else {
            lines.push(t);
        }
    }
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines.join("\n")
}

fn summarize(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= limit {
        return flat;
    }
    let mut cut: String = flat.chars().take(limit).collect();
    // Prefer to break on a word boundary rather than mid-word.
    if let Some(pos) = cut.rfind(' ') {
        cut.truncate(pos);
    }
    format!("{}...", cut.trim_end())
}

fn child_text(node: roxmltree::Node, name: &str) -> String {
    node.children()
        .find(|c| c.is_element() && c.tag_name().name() == name)
        .and_then(|c| c.text())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn item_link(node: roxmltree::Node) -> String {
    let mut fallback = String::new();
    for c in node.children().filter(|c| c.is_element() && c.tag_name().name() == "link") {
        if let Some(t) = c.text() {
            let t = t.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
        if let Some(href) = c.attribute("href") {
            let rel = c.attribute("rel").unwrap_or("alternate");
            if rel == "alternate" {
                return href.to_string();
            }
            if fallback.is_empty() {
                fallback = href.to_string();
            }
        }
    }
    fallback
}

fn item_image(node: roxmltree::Node, body_html: &str) -> String {
    for c in node.children().filter(|c| c.is_element()) {
        let name = c.tag_name().name();
        if matches!(name, "content" | "thumbnail") {
            if let Some(url) = c.attribute("url") {
                let ty = c.attribute("type").unwrap_or("image");
                if ty.starts_with("image") || name == "thumbnail" {
                    return url.to_string();
                }
            }
        }
        if name == "enclosure" {
            let ty = c.attribute("type").unwrap_or("");
            if ty.starts_with("image") {
                if let Some(url) = c.attribute("url") {
                    return url.to_string();
                }
            }
        }
    }
    IMG_SRC
        .captures(body_html)
        .and_then(|c| c.get(1))
        .map(|m| decode_entities(m.as_str()))
        .unwrap_or_default()
}

pub fn parse_feed(xml: &str) -> Result<Vec<Value>, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("feed parse failed: {e}"))?;
    let root = doc.root_element();
    let items: Vec<roxmltree::Node> = root
        .descendants()
        .filter(|n| n.is_element() && matches!(n.tag_name().name(), "item" | "entry"))
        .collect();

    let mut out = Vec::new();
    for item in items.into_iter().take(MAX_ITEMS) {
        // Richest body first: content:encoded, then Atom content, then description.
        let body = ["encoded", "content", "description", "summary"]
            .iter()
            .map(|k| child_text(item, k))
            .find(|s| !s.is_empty())
            .unwrap_or_default();
        let text = html_to_text(&body);
        let categories: Vec<String> = item
            .children()
            .filter(|c| c.is_element() && c.tag_name().name() == "category")
            .filter_map(|c| c.text().map(|t| t.trim().to_string()))
            .filter(|t| !t.is_empty())
            .collect();
        let published = ["pubDate", "published", "updated", "date"]
            .iter()
            .map(|k| child_text(item, k))
            .find(|s| !s.is_empty())
            .unwrap_or_default();
        let author = ["creator", "author"]
            .iter()
            .map(|k| {
                let direct = child_text(item, k);
                if !direct.is_empty() {
                    return direct;
                }
                // Atom wraps the name in <author><name>...</name></author>.
                item.children()
                    .find(|c| c.is_element() && c.tag_name().name() == *k)
                    .map(|c| child_text(c, "name"))
                    .unwrap_or_default()
            })
            .find(|s| !s.is_empty())
            .unwrap_or_default();

        let title = decode_entities(&child_text(item, "title"));
        if title.is_empty() && text.is_empty() {
            continue;
        }
        out.push(json!({
            "title": title,
            "link": item_link(item),
            "published": published,
            "author": author,
            "categories": categories,
            "summary": summarize(&text, 260),
            "text": text,
            "image": item_image(item, &body),
        }));
    }
    Ok(out)
}

pub async fn fetch(state: &AppState, kind: &str) -> Value {
    let url = match feed_url(kind) {
        Some(u) => u,
        None => return json!({ "error": "unknown feed" }),
    };
    let resp = state
        .http
        .get(url)
        .header("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml")
        .timeout(Duration::from_secs(25))
        .send()
        .await;
    let body = match resp {
        Ok(r) if r.status().is_success() => match r.text().await {
            Ok(t) => t,
            Err(e) => return json!({ "error": format!("feed fetch failed: {e}") }),
        },
        Ok(r) => return json!({ "error": format!("feed fetch failed: HTTP {}", r.status().as_u16()) }),
        Err(e) => return json!({ "error": format!("feed fetch failed: {e}") }),
    };
    match parse_feed(&body) {
        Ok(items) => {
            crate::dlog!("feed {}: {} item(s)", kind, items.len());
            json!({ "ok": true, "feed": kind, "items": items })
        }
        Err(e) => json!({ "error": e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_becomes_readable_text() {
        let html = "<p>Hello <b>world</b>&nbsp;&amp; friends</p><p>Second &#8217;graph</p>";
        assert_eq!(html_to_text(html), "Hello world & friends\n\nSecond 'graph");
        assert!(!html_to_text("<script>alert(1)</script>ok").contains('<'));
    }

    #[test]
    fn summary_breaks_on_a_word() {
        let s = summarize("one two three four five", 12);
        assert!(s.ends_with("..."));
        assert!(!s.contains("four"));
    }

    #[test]
    fn parses_rss_items() {
        let xml = r#"<?xml version="1.0"?>
        <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
             xmlns:content="http://purl.org/rss/1.0/modules/content/">
          <channel>
            <title>Feed</title>
            <item>
              <title>Grid maintenance</title>
              <link>https://example.com/a</link>
              <pubDate>Mon, 21 Jul 2026 10:00:00 +0000</pubDate>
              <dc:creator>Linden Lab</dc:creator>
              <category>Status</category>
              <content:encoded><![CDATA[<p>Rolling restarts <img src="https://img/x.png"> today.</p>]]></content:encoded>
            </item>
          </channel>
        </rss>"#;
        let items = parse_feed(xml).expect("parse");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["title"], "Grid maintenance");
        assert_eq!(items[0]["link"], "https://example.com/a");
        assert_eq!(items[0]["author"], "Linden Lab");
        assert_eq!(items[0]["categories"][0], "Status");
        assert_eq!(items[0]["image"], "https://img/x.png");
        assert!(items[0]["text"].as_str().unwrap().contains("Rolling restarts"));
        assert!(!items[0]["text"].as_str().unwrap().contains('<'));
    }

    #[test]
    fn parses_atom_entries_and_rejects_unknown_feeds() {
        let xml = r#"<?xml version="1.0"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <title>Hello</title>
            <link rel="alternate" href="https://example.com/b"/>
            <updated>2026-07-21T10:00:00Z</updated>
            <author><name>Someone</name></author>
            <summary>Plain summary</summary>
          </entry>
        </feed>"#;
        let items = parse_feed(xml).expect("parse");
        assert_eq!(items[0]["link"], "https://example.com/b");
        assert_eq!(items[0]["author"], "Someone");
        assert_eq!(items[0]["summary"], "Plain summary");
        assert!(feed_url("linden-news").is_some());
        assert!(feed_url("grid-status").is_some());
        assert!(feed_url("blogs").is_some());
        assert!(feed_url("../etc/passwd").is_none());
    }

    /// The allowlist is the whole of the guard here - `bridge_feed` takes a name from the
    /// frontend, never a URL - so it must stay a closed set of https hosts.
    #[test]
    fn every_allowed_feed_is_an_https_url_and_nothing_else_is() {
        for kind in ["linden-news", "grid-status", "blogs"] {
            let url = feed_url(kind).expect(kind);
            assert!(url.starts_with("https://"), "{kind} must be https");
        }
        for bogus in ["", "blogs/../..", "http://evil.example", "LINDEN-NEWS"] {
            assert!(feed_url(bogus).is_none(), "{bogus} must not resolve");
        }
    }
}
