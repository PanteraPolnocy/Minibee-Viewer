//! Map tiles, region-name/coordinate lookups, and the Destination Guide proxy.
//! Lookups hit fixed Linden hosts and use the shared redirect-following client;
//! map tiles take their base URL from the grid, so they use the no-redirect client
//! and re-guard every hop. TLS rides the OS trust store, so no CA bundle is needed.

use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};

use crate::bridge::state::AppState;

static RE_REGION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)var\s+region\s*=\s*['"]([^'"]*)['"]"#).unwrap());
static RE_ERROR_TRUE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)['"]error['"]\s*:\s*true"#).unwrap());
static RE_X: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)['"]x['"]\s*:\s*(-?\d+)"#).unwrap());
static RE_Y: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)['"]y['"]\s*:\s*(-?\d+)"#).unwrap());

fn parse_region_cap_js(body: &str) -> Option<String> {
    RE_REGION.captures(body).map(|c| c[1].to_string())
}

fn parse_region_coords_cap_js(body: &str) -> Option<(i64, i64)> {
    if RE_ERROR_TRUE.is_match(body) {
        return None;
    }
    let x = RE_X.captures(body)?[1].parse::<i64>().ok()?;
    let y = RE_Y.captures(body)?[1].parse::<i64>().ok()?;
    Some((x, y))
}

struct Grid {
    grid_x: i64,
    grid_y: i64,
    global_x: i64,
    global_y: i64,
}

fn cap_coords_to_grid(x: i64, y: i64) -> Grid {
    // Grid indices run 0..MAP_MAX_SIZE (16384 regions per axis); anything at or above
    // that is really global metres (grid * 256). A region could genuinely sit at grid
    // index >= 4096, and we still need to treat those as grid indices, so we draw the
    // line at 16384.
    const MAP_MAX_SIZE: i64 = 16384;
    if x < MAP_MAX_SIZE && y < MAP_MAX_SIZE {
        Grid { grid_x: x, grid_y: y, global_x: x * 256, global_y: y * 256 }
    } else {
        let gx = x / 256;
        let gy = y / 256;
        Grid { grid_x: gx, grid_y: gy, global_x: gx * 256, global_y: gy * 256 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_name_extracted_from_jsonp() {
        assert_eq!(parse_region_cap_js("var region = 'Natoma';").as_deref(), Some("Natoma"));
        assert_eq!(parse_region_cap_js(r#"var region="Da Boom";"#).as_deref(), Some("Da Boom"));
        assert_eq!(parse_region_cap_js("no region here"), None);
    }

    #[test]
    fn region_coords_parsed_and_error_rejected() {
        assert_eq!(parse_region_coords_cap_js(r#"{'x':1000,'y':1001}"#), Some((1000, 1001)));
        assert_eq!(parse_region_coords_cap_js(r#"{"error":true}"#), None);
        assert_eq!(parse_region_coords_cap_js("garbage"), None);
    }

    #[test]
    fn cap_coords_grid_index_branch() {
        // Small values come in as grid indices already.
        let g = cap_coords_to_grid(1000, 1001);
        assert_eq!((g.grid_x, g.grid_y), (1000, 1001));
        assert_eq!((g.global_x, g.global_y), (256000, 256256));
    }

    #[test]
    fn cap_coords_global_metres_branch() {
        // Large values are global metres, so divide by the region width.
        let g = cap_coords_to_grid(256000, 256256);
        assert_eq!((g.grid_x, g.grid_y), (1000, 1001));
        assert_eq!((g.global_x, g.global_y), (256000, 256256));
    }
}

pub async fn fetch_map_tile(
    state: &AppState,
    level: i64,
    grid_x: i64,
    grid_y: i64,
    server: &str,
) -> Result<Value, String> {
    let server = server.trim();
    let base = if server.is_empty() || !(server.starts_with("http://") || server.starts_with("https://")) {
        "https://map.secondlife.com/"
    } else {
        server
    };
    let url = format!(
        "{}/map-{}-{}-{}-objects.jpg",
        base.trim_end_matches('/'),
        level,
        grid_x,
        grid_y
    );
    // The map-server base comes from the caller (OpenSim grids vary), so we guard it
    // like any other egress. And because a hostile grid could 3xx us onto an internal
    // host, or DNS-rebind between the check and the connect, we follow redirects by
    // hand: on each hop we re-run the SSRF guard AND pin the validated IP, so the GET
    // connects to exactly the address we checked (mirrors proxy::exchange).
    let mut current = url;
    let mut resp;
    let mut hops = 0u32;
    loop {
        crate::bridge::proxy::guard_url(&current).await?;
        let pin = crate::bridge::proxy::resolve_public_pin(&current).await;
        let mut builder = reqwest::Client::builder()
            .user_agent(&state.ua)
            .redirect(reqwest::redirect::Policy::none())
            .gzip(true);
        if let Some((host, addr)) = &pin {
            builder = builder.resolve(host, *addr);
        }
        let client = builder.build().map_err(|e| e.to_string())?;
        resp = client
            .get(&current)
            .header("Referer", "https://secondlife.com/")
            .header("Accept", "image/jpeg,image/*,*/*")
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("map tile fetch failed: {e}"))?;
        if resp.status().is_redirection() && hops < 4 {
            let next = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|loc| resp.url().join(loc).ok())
                .ok_or_else(|| "map tile fetch failed: bad redirect".to_string())?;
            current = next.to_string();
            hops += 1;
            continue;
        }
        break;
    }
    if !resp.status().is_success() {
        return Err(format!("map tile fetch failed: HTTP {}", resp.status().as_u16()));
    }
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    // Cap the read: the map-server host is grid-supplied, so a hostile or broken
    // server must not be able to stream an unbounded body into memory.
    const MAX_TILE_BYTES: usize = 8 * 1024 * 1024;
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_TILE_BYTES {
            return Err("map tile fetch failed: response too large".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let content_type = if ctype.starts_with("image/") { ctype } else { "image/jpeg".to_string() };
    Ok(json!({ "contentType": content_type, "b64": B64.encode(&bytes) }))
}

async fn fetch_region_cap_body(state: &AppState, grid_x: i64, grid_y: i64) -> Option<String> {
    let urls = [
        format!("https://cap.secondlife.com/cap/0/b713fe80-283b-4585-af4d-a3b7d9a32492?var=region&grid_x={grid_x}&grid_y={grid_y}"),
        format!("http://slurl.com/get-region-name-by-coords?var=region&grid_x={grid_x}&grid_y={grid_y}"),
    ];
    for url in urls {
        let resp = state
            .http
            .get(&url)
            .header("Accept", "text/plain,*/*")
            .timeout(Duration::from_secs(12))
            .send()
            .await;
        if let Ok(r) = resp {
            if r.status().is_success() {
                if let Ok(body) = r.text().await {
                    if let Some(name) = parse_region_cap_js(&body) {
                        if !name.is_empty() {
                            return Some(name);
                        }
                    }
                }
            }
        }
    }
    None
}

pub async fn fetch_region_by_grid(state: &AppState, grid_x: i64, grid_y: i64) -> Value {
    match fetch_region_cap_body(state, grid_x, grid_y).await {
        Some(name) if !name.is_empty() => json!({ "name": name, "gridX": grid_x, "gridY": grid_y }),
        _ => json!({ "error": "region not found", "gridX": grid_x, "gridY": grid_y }),
    }
}

pub async fn fetch_region_by_name(state: &AppState, name: &str) -> Value {
    let name = name.trim();
    if name.is_empty() {
        return json!({ "error": "region name required" });
    }
    let urls = [
        format!("https://cap.secondlife.com/cap/0/d661249b-2b5a-4436-966a-3d3b8d7a574f?var=coords&sim_name={}", urlencoding::encode(name)),
        format!("http://slurl.com/get-region-coords-by-name?var=coords&sim_name={}", urlencoding::encode(name)),
    ];
    for url in urls {
        let resp = state
            .http
            .get(&url)
            .header("Accept", "text/plain,*/*")
            .timeout(Duration::from_secs(25))
            .send()
            .await;
        let body = match resp {
            Ok(r) => {
                let st = r.status();
                if !st.is_success() {
                    crate::dlog!("region_by_name '{}': {} -> HTTP {}", name, url, st.as_u16());
                    continue;
                }
                match r.text().await {
                    Ok(t) => t,
                    Err(_) => continue,
                }
            }
            Err(e) => {
                crate::dlog!("region_by_name '{}': {} -> transport error: {}", name, url, e);
                continue;
            }
        };
        let (x, y) = match parse_region_coords_cap_js(&body) {
            Some(v) => v,
            None => {
                crate::dlog!("region_by_name '{}': {} -> 200 but unparseable body ({} bytes)", name, url, body.len());
                continue;
            }
        };
        let grid = cap_coords_to_grid(x, y);
        let verified = fetch_region_cap_body(state, grid.grid_x, grid.grid_y).await;
        match verified {
            Some(v) if v.eq_ignore_ascii_case(name) => {
                return json!({
                    "name": v,
                    "globalX": grid.global_x,
                    "globalY": grid.global_y,
                    "gridX": grid.grid_x,
                    "gridY": grid.grid_y,
                })
            }
            _ => continue,
        }
    }
    crate::dlog!("region_by_name '{}': all lookup services failed -> region not found", name);
    json!({ "error": "region not found", "name": name })
}

pub async fn fetch_regions_by_grid_batch(state: &Arc<AppState>, tiles_param: &str) -> Value {
    let mut tiles: Vec<(i64, i64)> = Vec::new();
    for part in tiles_param.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let xy: Vec<&str> = part.splitn(2, ',').collect();
        if xy.len() < 2 {
            continue;
        }
        let x = xy[0].trim().parse::<i64>().unwrap_or(-1);
        let y = xy[1].trim().parse::<i64>().unwrap_or(-1);
        if !(0..=65535).contains(&x) || !(0..=65535).contains(&y) {
            continue;
        }
        tiles.push((x, y));
    }
    if tiles.is_empty() {
        return json!({ "error": "no valid tiles" });
    }
    tiles.truncate(25);

    let futures: Vec<_> = tiles
        .iter()
        .map(|&(x, y)| {
            let state = state.clone();
            async move {
                let name = fetch_region_cap_body(&state, x, y).await.unwrap_or_default();
                json!({
                    "gridX": x,
                    "gridY": y,
                    "name": name,
                    "empty": name.is_empty(),
                })
            }
        })
        .collect();
    let results = futures::future::join_all(futures).await;
    json!({ "regions": results })
}

pub async fn fetch_destinations_feed(state: &AppState, feed: &str) -> Value {
    let allowed = ["mobile", "popular", "new", "editor", "events"];
    if !allowed.contains(&feed) {
        return json!({ "error": "invalid feed" });
    }
    let url = format!("https://worldaping.agni.lindenlab.com/v2/destinations/{}/", feed);
    let resp = state
        .http
        .get(&url)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(25))
        .send()
        .await;
    let body = match resp {
        Ok(r) if r.status().is_success() => match r.text().await {
            Ok(t) => t,
            Err(e) => return json!({ "error": format!("destinations fetch failed: {e}") }),
        },
        Ok(r) => return json!({ "error": format!("destinations fetch failed: HTTP {}", r.status().as_u16()) }),
        Err(e) => return json!({ "error": format!("destinations fetch failed: {e}") }),
    };
    match serde_json::from_str::<Value>(&body) {
        Ok(items) if items.is_array() || items.is_object() => {
            json!({ "ok": true, "feed": feed, "items": items })
        }
        _ => json!({ "error": "invalid destinations response" }),
    }
}
