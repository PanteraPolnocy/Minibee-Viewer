//! Notecards: list the ones in the agent's inventory, download their text,
//! save through the region caps, and create new ones. The download and
//! item-creation plumbing is shared with the script editor.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::State;

use crate::bridge::inventory::{self, AT_NOTECARD};
use crate::bridge::proxy;
use crate::bridge::scripts;
use crate::bridge::state::AppState;
use crate::codec;

type Cmd = Result<Value, String>;

/// The grid caps a notecard asset at 64 KiB; refuse anything bigger up front
/// so the failure is instant and explained.
const MAX_NOTECARD_BYTES: usize = 64 * 1024;

fn notecard_row(item: &Value) -> Option<Value> {
    if inventory::item_i64(item, "type") != AT_NOTECARD {
        return None;
    }
    let item_id = inventory::item_str(item, "item_id");
    if !inventory::is_uuid(&item_id) {
        return None;
    }
    Some(json!({
        "itemId": item_id.to_ascii_lowercase(),
        "assetId": inventory::item_str(item, "asset_id").to_ascii_lowercase(),
        "creatorId": inventory::item_creator(item).to_ascii_lowercase(),
        "lastOwnerId": inventory::item_last_owner(item).to_ascii_lowercase(),
        "name": inventory::item_str(item, "name"),
    }))
}

/// Notecard rows for the UI: one per item, sorted by name.
pub fn notecard_rows(items: &[Value]) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut rows: Vec<Value> = items
        .iter()
        .filter_map(notecard_row)
        .filter(|r| seen.insert(r["itemId"].as_str().unwrap_or("").to_string()))
        .collect();
    rows.sort_by_cached_key(|r| r["name"].as_str().unwrap_or("").to_lowercase());
    rows
}

/// Wrap plain text in the Linden notecard container the asset store expects.
/// A save from this client carries no embedded items.
pub fn wrap_notecard(text: &str) -> String {
    format!(
        "Linden text version 2\n{{\nLLEmbeddedItems version 1\n{{\ncount 0\n}}\nText length {}\n{}}}\n",
        text.len(),
        text
    )
}

#[tauri::command]
pub async fn sl_notecards_list(state: State<'_, Arc<AppState>>) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let (agent, _) = session.agent_ids().ok_or("Session not ready")?;
    let roots = state.notecard_folders.lock().unwrap().clone();
    if roots.is_empty() {
        return Ok(json!({ "ok": true, "notecards": [], "noFolder": true }));
    }
    if session.cap("FetchInventoryDescendents2").is_none() {
        return Err("Inventory capability unavailable".into());
    }
    let items = inventory::collect_folder_items(state.inner(), &session, &roots, &agent).await;
    Ok(json!({ "ok": true, "notecards": notecard_rows(&items) }))
}

/// Ask the sim for a notecard's text. It arrives as a `notecard-source` event.
#[tauri::command]
pub async fn sl_notecard_source(state: State<'_, Arc<AppState>>, item_id: String, asset_id: String) -> Cmd {
    scripts::request_item_source(&state, &item_id, &asset_id, AT_NOTECARD, true).await
}

/// Create a new (empty) notecard in the Notecards folder. The item comes back
/// as a `notecard-created` event.
#[tauri::command]
pub async fn sl_notecard_create(state: State<'_, Arc<AppState>>, name: String) -> Cmd {
    let folder = state.notecard_folders.lock().unwrap().first().cloned().unwrap_or_default();
    if folder.is_empty() {
        return Err("No Notecards folder in this inventory".into());
    }
    scripts::create_inventory_item(&state, &name, &folder, AT_NOTECARD).await
}

/// Save a notecard: UpdateNotecardAgentInventory hands back a one-shot
/// uploader URL, and the wrapped text is posted there.
#[tauri::command]
pub async fn sl_notecard_save(state: State<'_, Arc<AppState>>, item_id: String, text: String) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let item_id = item_id.trim().to_ascii_lowercase();
    if !inventory::is_uuid(&item_id) || inventory::is_zero_uuid(&item_id) {
        return Err("Not a notecard".into());
    }
    if text.len() > MAX_NOTECARD_BYTES {
        return Err("Notecard is too large (64 KB limit)".into());
    }
    if session.cap("UpdateNotecardAgentInventory").is_none() {
        return Err("Notecard upload capability unavailable".into());
    }
    let body = format!("<?xml version=\"1.0\"?><llsd><map><key>item_id</key><uuid>{item_id}</uuid></map></llsd>");
    let first = inventory::cap_post(state.inner(), &session, "UpdateNotecardAgentInventory", &body)
        .await
        .ok_or("The notecard update request failed")?;
    let uploader = first.get("uploader").and_then(|v| v.as_str()).unwrap_or("");
    if uploader.is_empty() {
        let msg = first
            .get("message")
            .or_else(|| first.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("The sim refused the notecard update");
        return Err(msg.to_string());
    }
    let (pin, _) = proxy::simhost_pin(uploader, "").await;
    let ex = proxy::exchange(
        &state.ua,
        "POST",
        uploader,
        &wrap_notecard(&text),
        "application/octet-stream",
        &[],
        pin,
        Duration::from_secs(60),
        true,
    )
    .await?;
    if !(200..300).contains(&ex.status) {
        return Err(format!("Notecard upload failed (HTTP {})", ex.status));
    }
    let result = codec::llsd::parse(&ex.body, &ex.content_type).unwrap_or(Value::Null);
    let uploaded = result.get("state").and_then(|v| v.as_str()).unwrap_or("") == "complete";
    Ok(json!({
        "ok": uploaded,
        "newAsset": result.get("new_asset").and_then(|v| v.as_str()).unwrap_or(""),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::session::notecard_text;

    #[test]
    fn rows_keep_notecards_only_sorted() {
        let items = vec![
            json!({ "item_id": "aa000000-0000-0000-0000-000000000001", "type": AT_NOTECARD, "asset_id": "", "name": "Beta", "permissions": { "creator_id": "CC000000-0000-0000-0000-000000000003" } }),
            json!({ "item_id": "aa000000-0000-0000-0000-000000000002", "type": 10, "asset_id": "", "name": "a script" }),
            json!({ "item_id": "aa000000-0000-0000-0000-000000000003", "type": AT_NOTECARD, "asset_id": "", "name": "alpha" }),
            json!({ "item_id": "aa000000-0000-0000-0000-000000000003", "type": AT_NOTECARD, "asset_id": "", "name": "alpha again" }),
        ];
        let rows = notecard_rows(&items);
        let names: Vec<&str> = rows.iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["alpha", "Beta"]);
        assert_eq!(rows[1]["creatorId"], "cc000000-0000-0000-0000-000000000003");
    }

    #[test]
    fn wrap_roundtrips_through_the_parser() {
        for text in ["", "Hello, world!", "multi\nline\ntext with } braces {", "żółć / UTF-8 ✓"] {
            assert_eq!(notecard_text(wrap_notecard(text).as_bytes()), text, "text: {text:?}");
        }
        // The declared length is bytes, not chars.
        let wrapped = wrap_notecard("żż");
        assert!(wrapped.contains("Text length 4\n"), "got: {wrapped}");
    }
}
