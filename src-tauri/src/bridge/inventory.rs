//! Inventory reads over the region caps. There is no local inventory model;
//! each caller fetches the folder or items it needs and keeps nothing.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::bridge::circuit::Session;
use crate::bridge::proxy;
use crate::bridge::state::AppState;
use crate::codec;

/// Inventory asset types the core reads.
pub const AT_LANDMARK: i64 = 3;
pub const AT_OBJECT: i64 = 6;
pub const AT_NOTECARD: i64 = 7;
pub const AT_LSL_TEXT: i64 = 10;
pub const AT_LINK: i64 = 24;

/// Bounds on the folder walks the item listings do.
pub const MAX_FOLDERS: usize = 64;
pub const MAX_DEPTH: usize = 6;

/// One FetchInventory2 request carries at most this many item ids.
const FETCH_ITEMS_MAX: usize = 200;

pub fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// A well-formed UUID string: the one shape the caps accept, and the only
/// thing we let into a request body unescaped.
pub fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

pub fn is_zero_uuid(s: &str) -> bool {
    s.is_empty() || s.chars().all(|c| c == '0' || c == '-')
}

/// POST an LLSD body to a region cap; None when the cap is missing or the
/// request fails. The response is parsed LLSD.
pub async fn cap_post(state: &Arc<AppState>, session: &Arc<Session>, cap: &str, body: &str) -> Option<Value> {
    let url = session.cap(cap)?;
    cap_post_url(state, session, &url, body).await
}

/// Same POST against an explicit cap URL - for endpoints that belong to a
/// region other than the one the session's cap map describes (a voice
/// neighbour's, say).
pub async fn cap_post_url(state: &Arc<AppState>, session: &Arc<Session>, url: &str, body: &str) -> Option<Value> {
    let agent_session = session.agent_ids().map(|(_, s)| s).unwrap_or_default();
    let headers: Vec<(String, String)> = if agent_session.is_empty() {
        Vec::new()
    } else {
        vec![("X-SecondLife-Session-ID".to_string(), agent_session)]
    };
    let (pin, _) = proxy::simhost_pin(url, "").await;
    match proxy::exchange(
        &state.ua,
        "POST",
        url,
        body,
        "application/llsd+xml",
        &headers,
        pin,
        Duration::from_secs(30),
        true,
    )
    .await
    {
        Ok(ex) if (200..300).contains(&ex.status) => codec::llsd::parse(&ex.body, &ex.content_type).ok(),
        Ok(ex) => {
            crate::dlog!("inventory: {url} HTTP {} body={:.200}", ex.status, ex.body);
            None
        }
        Err(e) => {
            crate::dlog!("inventory: {url} failed: {e}");
            None
        }
    }
}

/// One folder's direct contents (FetchInventoryDescendents2): its items and,
/// when asked for, its subfolders.
pub async fn fetch_folder(
    state: &Arc<AppState>,
    session: &Arc<Session>,
    folder_id: &str,
    owner_id: &str,
    with_folders: bool,
) -> Option<(Vec<Value>, Vec<Value>)> {
    let body = format!(
        "<?xml version=\"1.0\"?><llsd><map><key>folders</key><array><map>\
         <key>folder_id</key><uuid>{}</uuid>\
         <key>owner_id</key><uuid>{}</uuid>\
         <key>fetch_folders</key><boolean>{}</boolean>\
         <key>fetch_items</key><boolean>1</boolean>\
         <key>sort_order</key><integer>0</integer>\
         </map></array></map></llsd>",
        xml_escape(folder_id),
        xml_escape(owner_id),
        with_folders as u8,
    );
    let parsed = cap_post(state, session, "FetchInventoryDescendents2", &body).await?;
    let folder = parsed.get("folders")?.as_array()?.first()?;
    let rows = |key: &str| folder.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    Some((rows("items"), rows("categories")))
}

/// Fetch full inventory items by id (FetchInventory2): real type, name,
/// asset and permission masks.
pub async fn fetch_items(
    state: &Arc<AppState>,
    session: &Arc<Session>,
    owner_id: &str,
    ids: &[String],
) -> Vec<Value> {
    if ids.is_empty() {
        return Vec::new();
    }
    let rows: String = ids
        .iter()
        .take(FETCH_ITEMS_MAX)
        .map(|id| {
            format!(
                "<map><key>item_id</key><uuid>{}</uuid><key>owner_id</key><uuid>{}</uuid></map>",
                xml_escape(id),
                xml_escape(owner_id)
            )
        })
        .collect();
    let body = format!(
        "<?xml version=\"1.0\"?><llsd><map><key>agent_id</key><uuid>{}</uuid>\
         <key>items</key><array>{rows}</array></map></llsd>",
        xml_escape(owner_id),
    );
    match cap_post(state, session, "FetchInventory2", &body).await {
        Some(parsed) => parsed
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        None => Vec::new(),
    }
}

pub fn item_str(item: &Value, key: &str) -> String {
    item.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

pub fn item_i64(item: &Value, key: &str) -> i64 {
    match item.get(key) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

/// A folder row's id. Descendents replies label it `category_id`; other
/// shapes of the same data say `folder_id` or `cat_id`.
pub fn folder_id(cat: &Value) -> String {
    ["category_id", "folder_id", "cat_id"]
        .iter()
        .map(|k| item_str(cat, k))
        .find(|v| !v.is_empty())
        .unwrap_or_default()
}

/// A per-item agent id, wherever this reply shape put it: inside the
/// permissions block, or flat on the item.
fn item_agent_field(item: &Value, key: &str) -> String {
    let nested = item
        .get("permissions")
        .map(|p| item_str(p, key))
        .unwrap_or_default();
    if nested.is_empty() { item_str(item, key) } else { nested }
}

/// The item's creator.
pub fn item_creator(item: &Value) -> String {
    item_agent_field(item, "creator_id")
}

/// Who owned the item before the current owner.
pub fn item_last_owner(item: &Value) -> String {
    item_agent_field(item, "last_owner_id")
}

/// Walk a folder tree breadth-first, resolving links to the items they point
/// at, and hand back every item found (bounded by MAX_FOLDERS / MAX_DEPTH).
pub async fn collect_folder_items(
    state: &Arc<AppState>,
    session: &Arc<Session>,
    roots: &[String],
    owner: &str,
) -> Vec<Value> {
    use std::collections::{HashSet, VecDeque};
    let mut queue: VecDeque<(String, usize)> = roots.iter().map(|r| (r.clone(), 0)).collect();
    let mut visited: HashSet<String> = HashSet::new();
    let mut items = Vec::new();
    let mut linked = Vec::new();
    while let Some((folder, depth)) = queue.pop_front() {
        if visited.len() >= MAX_FOLDERS || !visited.insert(folder.to_ascii_lowercase()) {
            continue;
        }
        let Some((rows, cats)) = fetch_folder(state, session, &folder, owner, depth < MAX_DEPTH).await else {
            continue;
        };
        for row in rows {
            match link_target(&row) {
                Some(target) => linked.push(target),
                None => items.push(row),
            }
        }
        for cat in cats {
            let id = folder_id(&cat);
            if !id.is_empty() {
                queue.push_back((id, depth + 1));
            }
        }
    }
    items.extend(fetch_items(state, session, owner, &linked).await);
    items
}

/// The item id a link points at. Links carry it as `linked_id` (AIS) or in
/// `asset_id` (legacy LLSD); non-link rows return None.
pub fn link_target(item: &Value) -> Option<String> {
    if item_i64(item, "type") != AT_LINK {
        return None;
    }
    let target = {
        let l = item_str(item, "linked_id");
        if l.is_empty() { item_str(item, "asset_id") } else { l }
    };
    if target.is_empty() || target.starts_with("00000000-0000-0000-0000") {
        None
    } else {
        Some(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn link(item_type: i64, linked_id: &str, asset_id: &str) -> Value {
        let mut v = json!({ "item_id": "0f000000-0000-0000-0000-00000000000f", "type": item_type });
        if !linked_id.is_empty() {
            v["linked_id"] = json!(linked_id);
        }
        if !asset_id.is_empty() {
            v["asset_id"] = json!(asset_id);
        }
        v
    }

    #[test]
    fn link_target_prefers_linked_id_then_asset_id() {
        let real = "aa000000-0000-0000-0000-000000000001";
        assert_eq!(link_target(&link(AT_LINK, real, "bb000000-0000-0000-0000-000000000002")), Some(real.to_string()));
        assert_eq!(link_target(&link(AT_LINK, "", real)), Some(real.to_string()));
    }

    #[test]
    fn link_target_rejects_non_links_and_null_targets() {
        let real = "aa000000-0000-0000-0000-000000000001";
        // A plain object row is not a link.
        assert_eq!(link_target(&link(AT_OBJECT, real, real)), None);
        // A link to nothing.
        assert_eq!(link_target(&link(AT_LINK, "", "")), None);
        assert_eq!(link_target(&link(AT_LINK, "00000000-0000-0000-0000-000000000000", "")), None);
        // Type as a string still parses (LLSD integers sometimes arrive stringly).
        let mut v = link(0, real, "");
        v["type"] = json!("24");
        assert_eq!(link_target(&v), Some(real.to_string()));
    }

    #[test]
    fn folder_id_accepts_every_spelling() {
        assert_eq!(folder_id(&json!({ "category_id": "a" })), "a");
        assert_eq!(folder_id(&json!({ "folder_id": "b" })), "b");
        assert_eq!(folder_id(&json!({ "cat_id": "c" })), "c");
        assert_eq!(folder_id(&json!({ "name": "Landmarks" })), "");
    }

    #[test]
    fn uuid_shape_check() {
        assert!(is_uuid("aa000000-0000-0000-0000-000000000001"));
        assert!(is_uuid("AA000000-0000-0000-0000-000000000001"));
        assert!(!is_uuid("aa000000-0000-0000-0000-00000000000"));
        assert!(!is_uuid("aa000000-0000-0000-0000-00000000000g"));
        assert!(!is_uuid("<uuid>aa000000-0000-0000-0000-000000000001"));
        assert!(is_zero_uuid("00000000-0000-0000-0000-000000000000"));
        assert!(!is_zero_uuid("aa000000-0000-0000-0000-000000000001"));
    }
}
