//! Landmarks: list the ones in the agent's inventory, read where one points,
//! and teleport there.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::State;

use crate::bridge::circuit::Session;
use crate::bridge::inventory::{self, AT_LANDMARK};
use crate::bridge::proxy;
use crate::bridge::state::AppState;

type Cmd = Result<Value, String>;

/// Bounds on the folder walk: landmark folders nest, but not forever.
const MAX_FOLDERS: usize = 64;
const MAX_DEPTH: usize = 6;

/// Where a landmark asset points. Version 2 assets name the region by id plus
/// a position inside it; version 1 ones carry a global position instead.
#[derive(Debug, PartialEq)]
pub struct LandmarkTarget {
    pub region_id: String,
    pub grid_x: Option<i64>,
    pub grid_y: Option<i64>,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

fn parse_triple(s: &str) -> Option<[f64; 3]> {
    let mut it = s.split_whitespace().map(|p| p.parse::<f64>().ok());
    let v = [it.next()??, it.next()??, it.next()??];
    v.iter().all(|n| n.is_finite()).then_some(v)
}

pub fn parse_landmark_asset(text: &str) -> Option<LandmarkTarget> {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let version: u32 = lines.next()?.strip_prefix("Landmark version")?.trim().parse().ok()?;
    match version {
        1 => {
            let [gx, gy, gz] = parse_triple(lines.next()?.strip_prefix("position")?)?;
            let (cx, cy) = ((gx / 256.0).floor(), (gy / 256.0).floor());
            Some(LandmarkTarget {
                region_id: String::new(),
                grid_x: Some(cx as i64),
                grid_y: Some(cy as i64),
                x: gx - cx * 256.0,
                y: gy - cy * 256.0,
                z: gz,
            })
        }
        2 => {
            let region_id = lines.next()?.strip_prefix("region_id")?.trim().to_ascii_lowercase();
            if !inventory::is_uuid(&region_id) || inventory::is_zero_uuid(&region_id) {
                return None;
            }
            let [x, y, z] = parse_triple(lines.next()?.strip_prefix("local_pos")?)?;
            Some(LandmarkTarget { region_id, grid_x: None, grid_y: None, x, y, z })
        }
        _ => None,
    }
}

fn landmark_row(item: &Value) -> Option<Value> {
    if inventory::item_i64(item, "type") != AT_LANDMARK {
        return None;
    }
    let asset = inventory::item_str(item, "asset_id").to_ascii_lowercase();
    if !inventory::is_uuid(&asset) || inventory::is_zero_uuid(&asset) {
        return None;
    }
    Some(json!({
        "itemId": inventory::item_str(item, "item_id"),
        "assetId": asset,
        "name": inventory::item_str(item, "name"),
    }))
}

/// Landmark rows for the UI: one per asset (a favourite is a link to a
/// landmark that is usually listed too), sorted by name.
pub fn landmark_rows(items: &[Value]) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut rows: Vec<Value> = items
        .iter()
        .filter_map(landmark_row)
        .filter(|r| seen.insert(r["assetId"].as_str().unwrap_or("").to_string()))
        .collect();
    rows.sort_by_cached_key(|r| r["name"].as_str().unwrap_or("").to_lowercase());
    rows
}

/// Walk the landmark folders, subfolders included, resolving links to the
/// items they point at.
async fn collect(state: &Arc<AppState>, session: &Arc<Session>, roots: &[String], owner: &str) -> Vec<Value> {
    let mut queue: VecDeque<(String, usize)> = roots.iter().map(|r| (r.clone(), 0)).collect();
    let mut visited: HashSet<String> = HashSet::new();
    let mut items = Vec::new();
    let mut linked = Vec::new();
    while let Some((folder, depth)) = queue.pop_front() {
        if visited.len() >= MAX_FOLDERS || !visited.insert(folder.to_ascii_lowercase()) {
            continue;
        }
        let Some((rows, cats)) = inventory::fetch_folder(state, session, &folder, owner, depth < MAX_DEPTH).await else {
            continue;
        };
        for row in rows {
            match inventory::link_target(&row) {
                Some(target) => linked.push(target),
                None => items.push(row),
            }
        }
        for cat in cats {
            let id = inventory::folder_id(&cat);
            if !id.is_empty() {
                queue.push_back((id, depth + 1));
            }
        }
    }
    items.extend(inventory::fetch_items(state, session, owner, &linked).await);
    landmark_rows(&items)
}

#[tauri::command]
pub async fn sl_landmarks_list(state: State<'_, Arc<AppState>>) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let (agent, _) = session.agent_ids().ok_or("Session not ready")?;
    let roots = state.landmark_folders.lock().unwrap().clone();
    if roots.is_empty() {
        return Ok(json!({ "ok": true, "landmarks": [], "noFolder": true }));
    }
    if session.cap("FetchInventoryDescendents2").is_none() {
        return Err("Inventory capability unavailable".into());
    }
    let landmarks = collect(state.inner(), &session, &roots, &agent).await;
    Ok(json!({ "ok": true, "landmarks": landmarks }))
}

/// Read where a landmark points: its asset, over the ViewerAsset cap.
#[tauri::command]
pub async fn sl_landmark_info(state: State<'_, Arc<AppState>>, asset_id: String) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let asset_id = asset_id.trim().to_ascii_lowercase();
    if !inventory::is_uuid(&asset_id) || inventory::is_zero_uuid(&asset_id) {
        return Err("Not a landmark".into());
    }
    let cap = session.cap("ViewerAsset").ok_or("Asset capability unavailable")?;
    let url = format!("{}?landmark_id={asset_id}", crate::bridge::caps::cap_endpoint(&cap));
    let (pin, _) = proxy::simhost_pin(&url, "").await;
    let ex = proxy::exchange(&state.ua, "GET", &url, "", "application/llsd+xml", &[], pin, Duration::from_secs(30), true).await?;
    if !(200..300).contains(&ex.status) {
        return Err(format!("Landmark data unavailable (HTTP {})", ex.status));
    }
    let t = parse_landmark_asset(&ex.body).ok_or("This landmark's data is unreadable")?;
    Ok(json!({
        "ok": true, "regionId": t.region_id, "gridX": t.grid_x, "gridY": t.grid_y,
        "x": t.x, "y": t.y, "z": t.z,
    }))
}

/// Teleport to a landmark by asset id; the sim resolves the destination.
/// `target` is where the UI worked out it points, if it could, so the arrival
/// events can be labelled.
#[tauri::command]
pub async fn sl_teleport_landmark(state: State<'_, Arc<AppState>>, asset_id: String, target: Option<Value>) -> Cmd {
    let (s, agent, sess) = crate::commands::active_ids(&state)?;
    let asset_id = asset_id.trim().to_ascii_lowercase();
    if !inventory::is_uuid(&asset_id) || inventory::is_zero_uuid(&asset_id) {
        return Err("Not a landmark".into());
    }
    crate::commands::stand_before_teleport(&s, &agent, &sess).await;
    let grid = |t: &Value| Some((t.get("gridX")?.as_i64()?, t.get("gridY")?.as_i64()?));
    let target = target.filter(|t| grid(t).is_some());
    if let Some((gx, gy)) = target.as_ref().and_then(grid) {
        s.clear_objects_for_teleport(gx, gy);
    }
    s.set_tp_target(target);
    s.send_encoded(
        "TeleportLandmarkRequest",
        &json!({ "Info": [{ "AgentID": agent, "SessionID": sess, "LandmarkID": asset_id }] }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_version_2_landmark() {
        let t = parse_landmark_asset(
            "Landmark version 2\nregion_id AA000000-0000-0000-0000-000000000001\nlocal_pos 12.5 200 25\n",
        )
        .expect("valid landmark");
        assert_eq!(t.region_id, "aa000000-0000-0000-0000-000000000001");
        assert_eq!((t.grid_x, t.grid_y), (None, None));
        assert_eq!((t.x, t.y, t.z), (12.5, 200.0, 25.0));
    }

    #[test]
    fn parses_a_version_1_landmark_into_grid_and_local() {
        let t = parse_landmark_asset("Landmark version 1\nposition 256128 256384 25\n").expect("valid landmark");
        assert_eq!(t.region_id, "");
        assert_eq!((t.grid_x, t.grid_y), (Some(1000), Some(1001)));
        assert_eq!((t.x, t.y, t.z), (128.0, 128.0, 25.0));
    }

    #[test]
    fn rejects_bad_landmarks() {
        assert_eq!(parse_landmark_asset(""), None);
        assert_eq!(parse_landmark_asset("Landmark version 3\nregion_id x\n"), None);
        assert_eq!(parse_landmark_asset("Landmark version 2\nregion_id not-a-uuid\nlocal_pos 1 2 3\n"), None);
        assert_eq!(
            parse_landmark_asset("Landmark version 2\nregion_id 00000000-0000-0000-0000-000000000000\nlocal_pos 1 2 3\n"),
            None
        );
        assert_eq!(parse_landmark_asset("Landmark version 2\nregion_id aa000000-0000-0000-0000-000000000001\nlocal_pos 1 2\n"), None);
    }

    #[test]
    fn rows_keep_landmarks_only_deduped_and_sorted() {
        let items = vec![
            json!({ "item_id": "i1", "type": AT_LANDMARK, "asset_id": "BB000000-0000-0000-0000-000000000002", "name": "zeta" }),
            json!({ "item_id": "i2", "type": AT_LANDMARK, "asset_id": "aa000000-0000-0000-0000-000000000001", "name": "Alpha" }),
            // A favourite pointing at the same landmark as i2.
            json!({ "item_id": "i3", "type": AT_LANDMARK, "asset_id": "aa000000-0000-0000-0000-000000000001", "name": "Alpha" }),
            json!({ "item_id": "i4", "type": AT_LANDMARK, "asset_id": "00000000-0000-0000-0000-000000000000", "name": "broken" }),
            json!({ "item_id": "i5", "type": 6, "asset_id": "cc000000-0000-0000-0000-000000000003", "name": "a hat" }),
            json!({ "item_id": "i6", "type": "3", "asset_id": "dd000000-0000-0000-0000-000000000004", "name": "mid" }),
        ];
        let rows = landmark_rows(&items);
        let names: Vec<&str> = rows.iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["Alpha", "mid", "zeta"]);
        assert_eq!(rows[2]["assetId"], "bb000000-0000-0000-0000-000000000002");
    }
}
