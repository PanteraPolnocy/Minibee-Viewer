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

use crate::bridge::session::Maturity;
use crate::bridge::state::AppState;
use crate::uitext::{ui_err, UiText};

/// `error`, `errorKey` and `errorArgs` written onto `extra`: why a lookup
/// gave nothing, beside whatever the reply still carries.
fn failed(line: UiText, mut extra: Value) -> Value {
    line.fields(&mut extra, "error");
    extra
}

/// The lookup services know no region by that name or at those coordinates.
/// The frontend matches these words (map.ts regionErrorMessage), so they stay
/// as they are; the key rides beside them.
fn region_not_found() -> UiText {
    UiText::new("map.regionNotFound", json!({}))
}

/// Nobody could be asked: the sim's map kept silent and the web lookups were
/// out of reach or out of order. Not the same thing as "no such region", and
/// said differently so that nobody takes a broken lookup for a missing region.
fn region_lookup_failed(name: &str) -> UiText {
    UiText::new("map.regionLookupFailed", json!({ "region": name }))
}

/// What the sim's own map says about a region name that is being looked up.
#[derive(Debug, Clone, PartialEq)]
pub enum MapNameAnswer {
    /// The region, where it lies on the grid, and its access code.
    Found { name: String, grid_x: i64, grid_y: i64, access: i64 },
    /// The sim closed its answer without that name in it.
    NotFound,
}

/// The access code of a region the map lists but which is not running.
const SIM_ACCESS_DOWN: i64 = 254;

/// The access code of a block with no region behind it.
const SIM_ACCESS_NONE: i64 = 255;

fn block_i64(block: &Value, field: &str) -> i64 {
    block.get(field).and_then(|v| v.as_i64()).unwrap_or(0)
}

/// Whether a block lies at the grid's origin, where no region is: the place
/// of the mark that closes a name search.
fn at_origin(block: &Value) -> bool {
    block_i64(block, "gridX") == 0 && block_i64(block, "gridY") == 0
}

/// What a batch of map blocks (the `map-blocks` payload) says about `wanted`.
/// A name search is answered with the regions whose names begin that way,
/// closed by a block with no region behind it: the one carrying the name
/// itself, whatever its case, is the region; the closing block without it
/// means there is none. Blocks that only describe an area of the map say
/// nothing either way (`None`) - unless the region happens to be among them.
pub fn map_name_answer(wanted: &str, blocks: &[Value]) -> Option<MapNameAnswer> {
    let wanted = wanted.trim().to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    let mut closed = false;
    for block in blocks {
        let access = block_i64(block, "access");
        // No region behind this block: the closing mark. Some grids write
        // the searched name on it, which does not make it that region.
        if access == SIM_ACCESS_NONE || at_origin(block) {
            closed = true;
            continue;
        }
        // A nameless block that is not that mark says nothing about any name.
        let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        if !name.is_empty() && name.to_lowercase() == wanted {
            return Some(MapNameAnswer::Found {
                name: name.to_string(),
                grid_x: block_i64(block, "gridX"),
                grid_y: block_i64(block, "gridY"),
                access,
            });
        }
    }
    closed.then_some(MapNameAnswer::NotFound)
}

/// Take the marks that close a name search out of a batch of map blocks
/// before the interface draws it: they are part of the search's answer, not
/// tiles of the map.
pub fn without_search_marks(blocks: &mut Value) {
    if let Some(list) = blocks.as_array_mut() {
        list.retain(|block| !at_origin(block));
    }
}

/// Put a name to the sim's map through `ask` and, should the answer be that
/// there is no such region, put it once more before believing it. The reply
/// carries no mark of the question it answers and can come in more than one
/// packet, so a packet gone astray - or the late reply to an earlier
/// question - reads exactly like "no such region". Silence the second time
/// leaves the first answer standing.
async fn asked_again_before_no<F, Fut>(ask: F) -> Option<MapNameAnswer>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Option<MapNameAnswer>>,
{
    match ask().await {
        Some(MapNameAnswer::NotFound) => Some(ask().await.unwrap_or(MapNameAnswer::NotFound)),
        other => other,
    }
}

/// Region-name lookups waiting on the sim's map. The map's reply carries no
/// mark of which question it answers, so there is one lookup at a time: a
/// second waits its turn, and then nothing but its own answer - or blocks
/// that happen to contain the region - can settle it.
#[derive(Default)]
pub struct RegionLookups {
    /// The name being looked up, and where its answer goes.
    waiter: std::sync::Mutex<Option<(String, tokio::sync::oneshot::Sender<MapNameAnswer>)>>,
    turn: tokio::sync::Mutex<()>,
}

impl RegionLookups {
    /// Put the question (`send` is what sends it, once the wait is set up)
    /// and wait for the map's answer: the region, no such region, or - `None`
    /// - nothing within `wait`.
    pub async fn ask<F, Fut>(&self, name: &str, wait: Duration, send: F) -> Option<MapNameAnswer>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let _turn = self.turn.lock().await;
        let (tx, rx) = tokio::sync::oneshot::channel();
        *self.waiter.lock().unwrap() = Some((name.to_string(), tx));
        send().await;
        let answer = tokio::time::timeout(wait, rx).await.ok().and_then(|sent| sent.ok());
        // Timed out: nobody is waiting any more.
        self.waiter.lock().unwrap().take();
        answer
    }

    /// Map blocks arrived: if they answer the name being looked up, hand the
    /// answer over. Blocks that say nothing about it (an area of the map the
    /// interface asked for meanwhile) leave the lookup waiting.
    pub fn settle(&self, blocks: &Value) {
        let mut waiter = self.waiter.lock().unwrap();
        let Some((wanted, _)) = waiter.as_ref() else { return };
        let Some(list) = blocks.as_array() else { return };
        if let Some(answer) = map_name_answer(wanted, list) {
            if let Some((_, tx)) = waiter.take() {
                let _ = tx.send(answer);
            }
        }
    }
}

/// A found region as the lookup commands hand it over. `offline` is the
/// map's word that the region exists but is not running.
fn found_region(name: &str, grid_x: i64, grid_y: i64, access: Option<i64>) -> Value {
    let mut out = json!({
        "name": name,
        "globalX": grid_x * 256,
        "globalY": grid_y * 256,
        "gridX": grid_x,
        "gridY": grid_y,
    });
    if access == Some(SIM_ACCESS_DOWN) {
        out["offline"] = json!(true);
    }
    out
}

/// What one web lookup made of a region name.
enum WebLookup {
    Found(Value),
    /// The service answered, and knows no such region.
    NotFound,
    /// No usable answer: unreachable, an HTTP error, or a body that is not
    /// what the service is supposed to say.
    Unavailable,
}

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

/// Whether a coordinates-by-name reply is the service saying "no such
/// region" (its `error: true`) rather than something else entirely - an
/// error page, or the plain refusal a retired lookup address answers with.
fn says_no_such_region(body: &str) -> bool {
    RE_ERROR_TRUE.is_match(body)
}

struct Grid {
    grid_x: i64,
    grid_y: i64,
}

fn cap_coords_to_grid(x: i64, y: i64) -> Grid {
    // Grid indices run 0..MAP_MAX_SIZE (16384 regions per axis); anything at or above
    // that is really global metres (grid * 256). A region could genuinely sit at grid
    // index >= 4096, and we still need to treat those as grid indices, so we draw the
    // line at 16384.
    const MAP_MAX_SIZE: i64 = 16384;
    if x < MAP_MAX_SIZE && y < MAP_MAX_SIZE {
        Grid { grid_x: x, grid_y: y }
    } else {
        Grid { grid_x: x / 256, grid_y: y / 256 }
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
    fn destinations_above_the_setting_are_left_out() {
        let feed = json!([
            { "name": "Park", "maturity": "G" },
            { "name": "Club", "maturity": "m" },
            { "name": "Den", "maturity": "Adult" },
            { "name": "Unrated" }
        ]);
        let names = |v: &Value| -> Vec<String> {
            v.as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap().to_string()).collect()
        };
        let (kept, dropped) = destinations_within(feed.clone(), Maturity::General);
        assert_eq!(names(&kept), ["Park", "Unrated"]);
        assert_eq!(dropped, 2);
        let (kept, dropped) = destinations_within(feed.clone(), Maturity::Moderate);
        assert_eq!(names(&kept), ["Park", "Club", "Unrated"]);
        assert_eq!(dropped, 1);
        let (kept, dropped) = destinations_within(feed.clone(), Maturity::Adult);
        assert_eq!(kept, feed);
        assert_eq!(dropped, 0);
        // Not a list: handed back untouched.
        let odd = json!({ "items": 3 });
        assert_eq!(destinations_within(odd.clone(), Maturity::General), (odd, 0));
    }

    #[test]
    fn a_failed_lookup_keeps_its_fields_and_carries_the_key() {
        let v = failed(region_not_found(), json!({ "gridX": 1000, "gridY": 1001 }));
        // The words stay exactly as the frontend matches them; the key rides beside.
        assert_eq!(v["error"], "region not found");
        assert_eq!(v["errorKey"], "map.regionNotFound");
        assert_eq!(v["errorArgs"], json!({}));
        assert_eq!(v["gridX"], 1000);
        assert_eq!(v["gridY"], 1001);
    }

    #[test]
    fn cap_coords_grid_index_branch() {
        // Small values come in as grid indices already.
        let g = cap_coords_to_grid(1000, 1001);
        assert_eq!((g.grid_x, g.grid_y), (1000, 1001));
    }

    #[test]
    fn cap_coords_global_metres_branch() {
        // Large values are global metres, so divide by the region width.
        let g = cap_coords_to_grid(256000, 256256);
        assert_eq!((g.grid_x, g.grid_y), (1000, 1001));
    }

    #[test]
    fn a_found_region_carries_both_kinds_of_coordinates() {
        let v = found_region("Da Boom", 1000, 1001, Some(13));
        assert_eq!(v["name"], "Da Boom");
        assert_eq!((v["gridX"].as_i64(), v["gridY"].as_i64()), (Some(1000), Some(1001)));
        assert_eq!((v["globalX"].as_i64(), v["globalY"].as_i64()), (Some(256000), Some(256256)));
        assert!(v.get("offline").is_none(), "a running region is not marked");
        assert!(v.get("error").is_none());
        // The map lists a region that is down with its own access code.
        assert_eq!(found_region("Da Boom", 1000, 1001, Some(254))["offline"], true);
        // The web lookups say nothing about a region's state.
        assert!(found_region("Da Boom", 1000, 1001, None).get("offline").is_none());
    }

    fn block(name: &str, x: i64, y: i64, access: i64) -> Value {
        json!({ "gridX": x, "gridY": y, "name": name, "access": access, "regionFlags": 0, "agents": 0 })
    }

    #[test]
    fn the_sims_map_names_the_region_whatever_the_case() {
        let blocks = vec![block("Coral Reach", 1100, 1050, 13)];
        let found = MapNameAnswer::Found { name: "Coral Reach".into(), grid_x: 1100, grid_y: 1050, access: 13 };
        assert_eq!(map_name_answer("Coral Reach", &blocks), Some(found.clone()));
        assert_eq!(map_name_answer("  coral REACH ", &blocks), Some(found.clone()));
        // A name search answers with everything that begins that way, then
        // closes with an empty block; the exact name is the one that counts,
        // wherever in the batch it comes.
        let many = vec![
            block("Coral Reach Annex", 1102, 1050, 13),
            block("", 0, 0, 255),
            block("Coral Reach", 1100, 1050, 13),
        ];
        assert_eq!(map_name_answer("coral reach", &many), Some(found));
    }

    #[test]
    fn the_closing_block_without_the_name_means_no_such_region() {
        assert_eq!(map_name_answer("Nowhere At All", &[block("", 0, 0, 255)]), Some(MapNameAnswer::NotFound));
        // Only longer names matched: still not this one.
        let near = vec![block("Coral Reach Annex", 1102, 1050, 13), block("", 0, 0, 255)];
        assert_eq!(map_name_answer("Coral Reach", &near), Some(MapNameAnswer::NotFound));
        // The mark is the same mark with the searched name written on it...
        assert_eq!(map_name_answer("Coral Reach", &[block("Coral Reach", 0, 0, 255)]), Some(MapNameAnswer::NotFound));
        // ...and wherever it is put: a block with no region behind it is never the region.
        assert_eq!(map_name_answer("Coral Reach", &[block("Coral Reach", 1100, 1050, 255)]), Some(MapNameAnswer::NotFound));
        assert_eq!(map_name_answer("Coral Reach", &[block("", 0, 0, 0)]), Some(MapNameAnswer::NotFound));
    }

    #[test]
    fn blocks_about_something_else_leave_the_question_open() {
        // An area of the map arriving while the name is being looked up.
        let area = vec![block("Da Boom", 1000, 1000, 13), block("Ahern", 997, 1002, 13)];
        assert_eq!(map_name_answer("Coral Reach", &area), None);
        // The first half of an answer, before its closing block.
        assert_eq!(map_name_answer("Coral Reach", &[block("Coral Reach Annex", 1102, 1050, 13)]), None);
        assert_eq!(map_name_answer("Coral Reach", &[]), None);
        assert_eq!(map_name_answer("   ", &[block("", 0, 0, 255)]), None, "nothing was asked");
        // A nameless block somewhere on the map is not the closing mark.
        assert_eq!(map_name_answer("Coral Reach", &[block("", 1100, 1051, 13)]), None);
        // ...unless the region happens to be in that area.
        let lucky = vec![block("Da Boom", 1000, 1000, 13), block("Coral Reach", 1100, 1050, 13)];
        assert!(matches!(map_name_answer("Coral Reach", &lucky), Some(MapNameAnswer::Found { grid_x: 1100, .. })));
    }

    #[test]
    fn the_closing_mark_is_not_drawn_as_a_tile() {
        let mut answer = json!([block("Coral Reach", 1100, 1050, 13), block("", 0, 0, 255)]);
        without_search_marks(&mut answer);
        assert_eq!(answer, json!([block("Coral Reach", 1100, 1050, 13)]));
        // The mark alone leaves nothing to draw.
        let mut none = json!([block("Coral Reach", 0, 0, 255)]);
        without_search_marks(&mut none);
        assert_eq!(none, json!([]));
        // An area of the map is handed on as it came.
        let area = json!([block("Da Boom", 1000, 1000, 13), block("Ahern", 997, 1002, 254)]);
        let mut same = area.clone();
        without_search_marks(&mut same);
        assert_eq!(same, area);
        // Not a list of blocks: left alone.
        let mut odd = json!({ "gridX": 0, "gridY": 0 });
        without_search_marks(&mut odd);
        assert_eq!(odd, json!({ "gridX": 0, "gridY": 0 }));
    }

    #[tokio::test]
    async fn the_map_is_asked_again_before_a_region_is_said_not_to_exist() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let found = MapNameAnswer::Found { name: "Coral Reach".into(), grid_x: 1100, grid_y: 1050, access: 13 };
        // What the map says, ask after ask, and how often it was asked.
        async fn run(script: &[Option<MapNameAnswer>]) -> (Option<MapNameAnswer>, usize) {
            let asked = AtomicUsize::new(0);
            let answer = asked_again_before_no(|| async {
                let turn = asked.fetch_add(1, Ordering::SeqCst);
                script.get(turn).cloned().flatten()
            })
            .await;
            (answer, asked.load(Ordering::SeqCst))
        }
        // The region, or silence: taken as it comes.
        assert_eq!(run(&[Some(found.clone())]).await, (Some(found.clone()), 1));
        assert_eq!(run(&[None]).await, (None, 1));
        // "No such region" because the part of the answer naming it went
        // astray: the second answer is the one that counts.
        assert_eq!(run(&[Some(MapNameAnswer::NotFound), Some(found.clone())]).await, (Some(found), 2));
        // Said twice, it is the map's word - and it is not asked a third time.
        assert_eq!(
            run(&[Some(MapNameAnswer::NotFound), Some(MapNameAnswer::NotFound), None]).await,
            (Some(MapNameAnswer::NotFound), 2)
        );
        // Silence the second time leaves the first answer standing.
        assert_eq!(run(&[Some(MapNameAnswer::NotFound), None]).await, (Some(MapNameAnswer::NotFound), 2));
    }

    #[test]
    fn a_region_that_is_down_is_found_and_said_to_be_down() {
        let answer = map_name_answer("Sleepy", &[block("Sleepy", 900, 900, 254)]).unwrap();
        let MapNameAnswer::Found { name, grid_x, grid_y, access } = answer else { panic!("found") };
        assert_eq!(found_region(&name, grid_x, grid_y, Some(access))["offline"], true);
    }

    #[test]
    fn a_refusal_is_not_an_answer() {
        // What a lookup address that was retired answers every name with:
        // neither coordinates nor the service's own "no such region".
        let refusal = "Invalid Capability ID.";
        assert_eq!(parse_region_coords_cap_js(refusal), None);
        assert!(!says_no_such_region(refusal));
        assert_eq!(parse_region_cap_js(refusal), None);
        // The service's real "no such region".
        assert!(says_no_such_region("var coords = {'error' : true };"));
        assert_eq!(parse_region_coords_cap_js("var coords = {'error' : true };"), None);
        // And a real answer.
        assert!(!says_no_such_region("var coords = {'x' : 1100, 'y' : 1050 };"));
        assert_eq!(parse_region_coords_cap_js("var coords = {'x' : 1100, 'y' : 1050 };"), Some((1100, 1050)));
    }

    #[tokio::test]
    async fn a_lookup_waits_for_the_maps_answer_and_for_nothing_else() {
        let lookups = RegionLookups::default();
        let sent = std::sync::atomic::AtomicUsize::new(0);
        let found = MapNameAnswer::Found { name: "Coral Reach".into(), grid_x: 1100, grid_y: 1050, access: 13 };
        let (answer, ()) = tokio::join!(
            lookups.ask("coral reach", Duration::from_secs(5), || async {
                sent.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }),
            async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                // An area of the map the interface asked for meanwhile: not an answer.
                lookups.settle(&json!([block("Da Boom", 1000, 1000, 13)]));
                tokio::time::sleep(Duration::from_millis(20)).await;
                lookups.settle(&json!([block("Coral Reach", 1100, 1050, 13), block("", 0, 0, 255)]));
            }
        );
        assert_eq!(answer, Some(found));
        assert_eq!(sent.load(std::sync::atomic::Ordering::SeqCst), 1, "asked once");

        // The closing block without the name: there is no such region.
        let (answer, ()) = tokio::join!(
            lookups.ask("Nowhere At All", Duration::from_secs(5), || async {}),
            async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                lookups.settle(&json!([block("", 0, 0, 255)]));
            }
        );
        assert_eq!(answer, Some(MapNameAnswer::NotFound));
    }

    #[tokio::test]
    async fn a_silent_map_leaves_the_question_open() {
        let lookups = RegionLookups::default();
        let answer = lookups.ask("Coral Reach", Duration::from_millis(40), || async {}).await;
        assert_eq!(answer, None, "no answer is not \"no such region\"");
        // What arrives after the wait is over settles nothing and harms nothing...
        lookups.settle(&json!([block("", 0, 0, 255)]));
        lookups.settle(&json!("not blocks at all"));
        // ...and does not leak into the next lookup.
        let next = lookups.ask("Da Boom", Duration::from_millis(40), || async {}).await;
        assert_eq!(next, None);
    }

    #[tokio::test]
    async fn lookups_take_turns() {
        // The reply names no request: with two in flight, the closing block of
        // one would read as "no such region" for the other.
        let lookups = RegionLookups::default();
        let order = std::sync::Mutex::new(Vec::new());
        let first = lookups.ask("Missing", Duration::from_secs(5), || async {
            order.lock().unwrap().push("asked: Missing");
        });
        let second = lookups.ask("Da Boom", Duration::from_secs(5), || async {
            order.lock().unwrap().push("asked: Da Boom");
        });
        let (a, b, ()) = tokio::join!(first, second, async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            order.lock().unwrap().push("map: no such region");
            lookups.settle(&json!([block("", 0, 0, 255)]));
            tokio::time::sleep(Duration::from_millis(30)).await;
            order.lock().unwrap().push("map: Da Boom");
            lookups.settle(&json!([block("Da Boom", 1000, 1000, 13)]));
        });
        assert_eq!(a, Some(MapNameAnswer::NotFound));
        assert!(matches!(b, Some(MapNameAnswer::Found { grid_x: 1000, .. })), "{b:?}");
        assert_eq!(
            *order.lock().unwrap(),
            ["asked: Missing", "map: no such region", "asked: Da Boom", "map: Da Boom"],
            "the second question is not put before the first is answered"
        );
    }

    #[test]
    fn a_tile_nobody_answered_for_is_not_an_empty_tile() {
        let named = tile_row(1000, 1001, Ok(Some("Da Boom".into())));
        assert_eq!((named["name"].as_str(), named["empty"].as_bool(), named["unknown"].as_bool()), (Some("Da Boom"), Some(false), Some(false)));
        // A service looked and found open water.
        let empty = tile_row(5, 6, Ok(None));
        assert_eq!((empty["name"].as_str(), empty["empty"].as_bool(), empty["unknown"].as_bool()), (Some(""), Some(true), Some(false)));
        // No service gave an answer: the map must not draw a hole for that.
        let unknown = tile_row(1000, 1001, Err(()));
        assert_eq!((unknown["name"].as_str(), unknown["empty"].as_bool(), unknown["unknown"].as_bool()), (Some(""), Some(false), Some(true)));
        assert_eq!((unknown["gridX"].as_i64(), unknown["gridY"].as_i64()), (Some(1000), Some(1001)));
    }

    #[test]
    fn a_lookup_nobody_answered_is_not_a_missing_region() {
        let v = failed(region_lookup_failed("Coral Reach"), json!({ "name": "Coral Reach", "unavailable": true }));
        assert_eq!(v["errorKey"], "map.regionLookupFailed");
        assert_eq!(v["errorArgs"]["region"], "Coral Reach");
        assert_eq!(v["unavailable"], true);
        assert!(v["error"].as_str().unwrap().contains("Coral Reach"), "the words name the region");
        assert_ne!(v["errorKey"], failed(region_not_found(), json!({}))["errorKey"]);
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
        let client = crate::bridge::proxy::pooled_client(&state.ua, &pin)?;
        resp = client
            .get(&current)
            .header("Referer", "https://secondlife.com/")
            .header("Accept", "image/jpeg,image/*,*/*")
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| ui_err("err.mapTileFetchFailed", json!({ "error": e.to_string() })))?;
        if resp.status().is_redirection() && hops < 4 {
            let next = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|loc| resp.url().join(loc).ok())
                .ok_or_else(|| ui_err("err.mapTileBadRedirect", json!({})))?;
            current = next.to_string();
            hops += 1;
            continue;
        }
        break;
    }
    if !resp.status().is_success() {
        return Err(ui_err("err.mapTileFetchFailedHttp", json!({ "status": resp.status().as_u16() })));
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
            return Err(ui_err("err.mapTileTooLarge", json!({})));
        }
        bytes.extend_from_slice(&chunk);
    }
    let content_type = if ctype.starts_with("image/") { ctype } else { "image/jpeg".to_string() };
    Ok(json!({ "contentType": content_type, "b64": B64.encode(&bytes) }))
}

/// The name of the region at a grid position, as the web lookups tell it:
/// `Ok(Some(name))`; `Ok(None)` when a service answered and named nothing;
/// `Err` when none of them gave an answer that could be read - which is not
/// the same as there being no region.
async fn fetch_region_name_at(state: &AppState, grid_x: i64, grid_y: i64) -> Result<Option<String>, ()> {
    let urls = [
        format!("https://cap.secondlife.com/cap/0/b713fe80-283b-4585-af4d-a3b7d9a32492?var=region&grid_x={grid_x}&grid_y={grid_y}"),
        format!("http://slurl.com/get-region-name-by-coords?var=region&grid_x={grid_x}&grid_y={grid_y}"),
    ];
    let mut answered = false;
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
                            return Ok(Some(name));
                        }
                        answered = true;
                    } else if says_no_such_region(&body) {
                        // The service looked, and there is no region there.
                        answered = true;
                    }
                }
            }
        }
    }
    if answered {
        Ok(None)
    } else {
        Err(())
    }
}

pub async fn fetch_region_by_grid(state: &AppState, grid_x: i64, grid_y: i64) -> Value {
    match fetch_region_name_at(state, grid_x, grid_y).await {
        Ok(Some(name)) => json!({ "name": name, "gridX": grid_x, "gridY": grid_y }),
        Ok(None) => failed(region_not_found(), json!({ "gridX": grid_x, "gridY": grid_y })),
        Err(()) => failed(
            region_lookup_failed(&format!("{grid_x}, {grid_y}")),
            json!({ "gridX": grid_x, "gridY": grid_y, "unavailable": true }),
        ),
    }
}

/// One tile of a batch lookup, as the map reads it: the region's `name`;
/// `empty` when a service looked and found no region there; `unknown` when
/// none of them gave an answer - which says nothing about the tile, and must
/// not be drawn as a hole in the map.
fn tile_row(grid_x: i64, grid_y: i64, looked_up: Result<Option<String>, ()>) -> Value {
    let (name, empty, unknown) = match looked_up {
        Ok(Some(name)) => (name, false, false),
        Ok(None) => (String::new(), true, false),
        Err(()) => (String::new(), false, true),
    };
    json!({ "gridX": grid_x, "gridY": grid_y, "name": name, "empty": empty, "unknown": unknown })
}

/// How long the sim's map is given to answer a name before the web lookups
/// are tried instead.
const GRID_LOOKUP_WAIT: Duration = Duration::from_secs(6);

/// Where a region is, by name.
///
/// The grid is asked first, through the sim the session is on: its map is
/// the one every region answers from, and it is there whenever the session
/// is. The web lookups are for when it keeps silent, and for a lookup made
/// with nobody logged in - they are a separate service, and one that has
/// been found answering nothing but a refusal for every name on the grid.
/// When that was the only source, a live region came out as "not found".
///
/// Three outcomes are told apart: the region (with `offline` when the map
/// lists it as down), no such region - which the map has to say twice - and
/// nobody could be asked.
pub async fn region_by_name(state: &Arc<AppState>, name: &str) -> Value {
    let name = name.trim();
    if name.is_empty() {
        return failed(UiText::new("map.regionNameRequired", json!({})), json!({}));
    }
    if let Some(session) = state.active() {
        match asked_again_before_no(|| session.lookup_region_name(name, GRID_LOOKUP_WAIT)).await {
            Some(MapNameAnswer::Found { name: found, grid_x, grid_y, access }) => {
                return found_region(&found, grid_x, grid_y, Some(access));
            }
            Some(MapNameAnswer::NotFound) => {
                crate::dlog!("region_by_name '{}': the sim's map knows no such region", name);
                return failed(region_not_found(), json!({ "name": name }));
            }
            None => {
                crate::dlog!("region_by_name '{}': the sim's map did not answer; trying the web lookups", name);
            }
        }
    }
    match web_region_by_name(state, name).await {
        WebLookup::Found(region) => region,
        WebLookup::NotFound => {
            crate::dlog!("region_by_name '{}': the web lookups know no such region", name);
            failed(region_not_found(), json!({ "name": name }))
        }
        WebLookup::Unavailable => {
            crate::dlog!("region_by_name '{}': no lookup gave an answer", name);
            failed(region_lookup_failed(name), json!({ "name": name, "unavailable": true }))
        }
    }
}

/// The same question put to the web lookups. A name is only "not found"
/// when a service said so, or handed back coordinates that hold some other
/// region; a service that cannot be reached, or answers with something that
/// is not an answer, leaves the question open.
async fn web_region_by_name(state: &AppState, name: &str) -> WebLookup {
    let urls = [
        format!("https://cap.secondlife.com/cap/0/d661249b-2b5a-4436-966a-3d3b8d7a574f?var=coords&sim_name={}", urlencoding::encode(name)),
        format!("http://slurl.com/get-region-coords-by-name?var=coords&sim_name={}", urlencoding::encode(name)),
    ];
    let mut denied = false;
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
                if says_no_such_region(&body) {
                    denied = true;
                } else {
                    crate::dlog!(
                        "region_by_name '{}': {} -> 200 but not an answer ({} bytes: {:.60})",
                        name, url, body.len(), body.trim()
                    );
                }
                continue;
            }
        };
        let grid = cap_coords_to_grid(x, y);
        match fetch_region_name_at(state, grid.grid_x, grid.grid_y).await {
            Ok(Some(v)) if v.eq_ignore_ascii_case(name) => {
                return WebLookup::Found(found_region(&v, grid.grid_x, grid.grid_y, None));
            }
            // Those coordinates hold another region, or none: not this name's.
            Ok(_) => denied = true,
            // The name could not be checked against the coordinates.
            Err(()) => {}
        }
    }
    if denied {
        WebLookup::NotFound
    } else {
        WebLookup::Unavailable
    }
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
        return failed(UiText::new("map.noValidTiles", json!({})), json!({}));
    }
    tiles.truncate(25);

    let futures: Vec<_> = tiles
        .iter()
        .map(|&(x, y)| {
            let state = state.clone();
            async move { tile_row(x, y, fetch_region_name_at(&state, x, y).await) }
        })
        .collect();
    let results = futures::future::join_all(futures).await;
    json!({ "regions": results })
}

pub async fn fetch_destinations_feed(state: &AppState, feed: &str) -> Value {
    let allowed = ["mobile", "popular", "new", "editor", "events"];
    if !allowed.contains(&feed) {
        return failed(UiText::new("map.invalidFeed", json!({})), json!({}));
    }
    let url = format!("https://worldaping.agni.lindenlab.com/v2/destinations/{}/", feed);
    let resp = state
        .http
        .get(&url)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(25))
        .send()
        .await;
    let fetch_failed = |e: reqwest::Error| {
        failed(
            UiText::new("map.destinationsFetchFailed", json!({ "error": e.to_string() })),
            json!({}),
        )
    };
    let body = match resp {
        Ok(r) if r.status().is_success() => match r.text().await {
            Ok(t) => t,
            Err(e) => return fetch_failed(e),
        },
        Ok(r) => {
            return failed(
                UiText::new("map.destinationsFetchFailedHttp", json!({ "status": r.status().as_u16() })),
                json!({}),
            )
        }
        Err(e) => return fetch_failed(e),
    };
    match serde_json::from_str::<Value>(&body) {
        Ok(items) if items.is_array() || items.is_object() => {
            let level = crate::bridge::session::max_maturity();
            let (items, hidden) = destinations_within(items, level);
            let mut out = json!({ "ok": true, "feed": feed, "items": items });
            if hidden > 0 {
                out["hidden"] = json!(hidden);
                if let Some(note) = crate::bridge::session::maturity_hidden_line(level, "destinations") {
                    note.fields(&mut out, "note");
                }
            }
            out
        }
        _ => failed(
            UiText::new("map.invalidDestinationsResponse", json!({})),
            json!({}),
        ),
    }
}

/// Leave out feed entries rated above `level`. The feed is a flat array of
/// destinations, each carrying a `maturity` code (G, M or A); an entry
/// without a readable rating stays. Returns the kept items and how many
/// were dropped.
pub fn destinations_within(items: Value, level: Maturity) -> (Value, usize) {
    match items {
        Value::Array(list) => {
            let total = list.len();
            let kept: Vec<Value> = list
                .into_iter()
                .filter(|item| destination_allowed(item, level))
                .collect();
            let dropped = total - kept.len();
            (Value::Array(kept), dropped)
        }
        other => (other, 0),
    }
}

fn destination_allowed(item: &Value, level: Maturity) -> bool {
    match item.get("maturity").and_then(Value::as_str).and_then(Maturity::parse) {
        Some(rating) => rating <= level,
        None => true,
    }
}
