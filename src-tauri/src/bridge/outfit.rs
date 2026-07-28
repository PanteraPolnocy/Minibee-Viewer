//! Current Outfit restore: re-rez worn attachments the sim didn't bring back.
//!
//! In Second Life the viewer owns the outfit. On login the simulator restores
//! attachments by itself, but the restore is partial and timing-dependent; the
//! viewer is expected to reconcile against the Current Outfit folder (COF) and
//! rez whatever is missing.
//! Minibee has no inventory model, so this module does the minimal version of
//! that: read the COF's object links over the inventory caps and ask the sim
//! to attach each linked object. Re-attaching something already worn is safe -
//! an inventory item can only be attached once, so the sim treats it as a
//! no-op/replace - which means we don't need a perfect diff, only the list.

use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};

use crate::bridge::circuit::Session;
use crate::bridge::proxy;
use crate::bridge::state::AppState;
use crate::codec;

/// Inventory asset types: a rezzable object, and an inventory link.
const AT_OBJECT: i64 = 6;
const AT_LINK: i64 = 24;

/// AttachmentPt high bit: "add" (keep the point's other attachments). With the
/// point byte 0 the sim uses the item's own stored attachment point.
const ATTACHMENT_ADD: u8 = 0x80;

/// One attachment per message, spaced out. Batched rez requests are known to
/// misbehave server-side, especially when replacing already-worn items.
const REZ_SPACING_MS: u64 = 300;

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// NUL-terminate a string and base64-encode it for a Variable message field.
fn vstr(s: &str) -> Value {
    json!(B64.encode(format!("{s}\0").as_bytes()))
}

/// POST an LLSD body to a region cap; None when the cap is missing or the
/// request fails. The response is parsed LLSD.
async fn cap_post(state: &Arc<AppState>, session: &Arc<Session>, cap: &str, body: &str) -> Option<Value> {
    let url = session.cap(cap)?;
    let agent_session = session.agent_ids().map(|(_, s)| s).unwrap_or_default();
    let headers: Vec<(String, String)> = if agent_session.is_empty() {
        Vec::new()
    } else {
        vec![("X-SecondLife-Session-ID".to_string(), agent_session)]
    };
    let (pin, _) = proxy::simhost_pin(&url, "").await;
    match proxy::exchange(
        &state.ua,
        "POST",
        &url,
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
            crate::dlog!("outfit: {cap} HTTP {} body={:.200}", ex.status, ex.body);
            None
        }
        Err(e) => {
            crate::dlog!("outfit: {cap} failed: {e}");
            None
        }
    }
}

/// Fetch the item rows of one inventory folder (FetchInventoryDescendents2).
async fn fetch_folder_items(
    state: &Arc<AppState>,
    session: &Arc<Session>,
    folder_id: &str,
    owner_id: &str,
) -> Option<Vec<Value>> {
    let body = format!(
        "<?xml version=\"1.0\"?><llsd><map><key>folders</key><array><map>\
         <key>folder_id</key><uuid>{}</uuid>\
         <key>owner_id</key><uuid>{}</uuid>\
         <key>fetch_folders</key><boolean>0</boolean>\
         <key>fetch_items</key><boolean>1</boolean>\
         <key>sort_order</key><integer>0</integer>\
         </map></array></map></llsd>",
        xml_escape(folder_id),
        xml_escape(owner_id),
    );
    let parsed = cap_post(state, session, "FetchInventoryDescendents2", &body).await?;
    let folder = parsed.get("folders")?.as_array()?.first()?;
    Some(folder.get("items")?.as_array()?.clone())
}

/// Fetch full inventory items by id (FetchInventory2), for the linked items'
/// real type, name and permission masks.
async fn fetch_items(
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

fn item_str(item: &Value, key: &str) -> String {
    item.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn item_i64(item: &Value, key: &str) -> i64 {
    match item.get(key) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

/// The item id a COF link points at. Links carry it as `linked_id` (AIS) or in
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

/// Build one RezMultipleAttachmentsFromInv for one inventory object,
/// FirstDetachAll=false and point "add" so nothing already worn is disturbed.
pub fn build_attach_message(agent: &str, sess: &str, compound_id: &str, item: &Value) -> Value {
    let perms = item.get("permissions").cloned().unwrap_or(Value::Null);
    let owner = {
        let o = item_str(&perms, "owner_id");
        if o.is_empty() { agent.to_string() } else { o }
    };
    json!({
        "AgentData": [{ "AgentID": agent, "SessionID": sess }],
        "HeaderData": [{
            "CompoundMsgID": compound_id,
            "TotalObjects": 1,
            "FirstDetachAll": false,
        }],
        "ObjectData": [{
            "ItemID": item_str(item, "item_id"),
            "OwnerID": owner,
            "AttachmentPt": ATTACHMENT_ADD,
            "ItemFlags": item_i64(item, "flags") as u64,
            "GroupMask": item_i64(&perms, "group_mask") as u64,
            "EveryoneMask": item_i64(&perms, "everyone_mask") as u64,
            "NextOwnerMask": item_i64(&perms, "next_owner_mask") as u64,
            "Name": vstr(&item_str(item, "name")),
            "Description": vstr(&item_str(item, "desc")),
        }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // A plain object row in COF is not a link.
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
    fn attach_message_is_one_additive_item() {
        let item = json!({
            "item_id": "aa000000-0000-0000-0000-000000000001",
            "name": "Hat",
            "desc": "A hat",
            "type": AT_OBJECT,
            "flags": 3,
            "permissions": {
                "owner_id": "bb000000-0000-0000-0000-000000000002",
                "group_mask": 1234, "everyone_mask": 0, "next_owner_mask": 581632
            }
        });
        let body = build_attach_message("agent", "sess", "cid", &item);
        assert_eq!(body["HeaderData"][0]["TotalObjects"], 1);
        // FirstDetachAll=true would strip whatever the sim already restored -
        // the exact opposite of a gap-filling re-rez.
        assert_eq!(body["HeaderData"][0]["FirstDetachAll"], false);
        let obj = &body["ObjectData"][0];
        assert_eq!(obj["ItemID"], "aa000000-0000-0000-0000-000000000001");
        assert_eq!(obj["OwnerID"], "bb000000-0000-0000-0000-000000000002");
        // Point 0 (the item's stored point) plus the ADD bit.
        assert_eq!(obj["AttachmentPt"], ATTACHMENT_ADD);
        assert_eq!(obj["ItemFlags"], 3);
        assert_eq!(obj["NextOwnerMask"], 581632);
        // Variable fields ride as NUL-terminated base64.
        assert_eq!(obj["Name"], vstr("Hat"));
    }

    #[test]
    fn attach_message_owner_falls_back_to_agent() {
        let item = json!({ "item_id": "aa000000-0000-0000-0000-000000000001", "type": AT_OBJECT });
        let body = build_attach_message("agent", "sess", "cid", &item);
        assert_eq!(body["ObjectData"][0]["OwnerID"], "agent");
    }

    #[test]
    fn attach_message_encodes_in_the_registry() {
        // The whole point is that this hits the wire: encode it for real.
        let reg = crate::codec::template::build_registry();
        let item = json!({
            "item_id": "aa000000-0000-0000-0000-000000000001",
            "name": "Hat", "desc": "", "type": AT_OBJECT, "flags": 0,
            "permissions": { "owner_id": "bb000000-0000-0000-0000-000000000002" }
        });
        let body = build_attach_message(
            "cc000000-0000-0000-0000-000000000003",
            "dd000000-0000-0000-0000-000000000004",
            "ee000000-0000-0000-0000-000000000005",
            &item,
        );
        let pkt = crate::codec::encode(&reg, "RezMultipleAttachmentsFromInv", &body, 1, 0);
        assert!(pkt.is_some(), "RezMultipleAttachmentsFromInv must encode");
    }
}

/// Re-rez Current Outfit attachments the sim didn't restore. Called a little
/// while after every region arrival (login and teleport); does nothing when
/// everything is already worn.
pub async fn restore(state: &Arc<AppState>, session: &Arc<Session>) {
    let cof = state.cof_folder.lock().unwrap().clone();
    if cof.is_empty() {
        crate::dlog!("outfit: no COF folder known, skipping restore");
        return;
    }
    let Some((agent, sess_uuid)) = session.agent_ids() else {
        return;
    };
    let Some(rows) = fetch_folder_items(state, session, &cof, &agent).await else {
        crate::dlog!("outfit: COF fetch failed");
        return;
    };
    let linked: Vec<String> = rows.iter().filter_map(link_target).collect();
    if linked.is_empty() {
        crate::dlog!("outfit: COF has no links, nothing to restore");
        return;
    }
    let items = fetch_items(state, session, &agent, &linked).await;
    let objects: Vec<&Value> = items
        .iter()
        .filter(|it| item_i64(it, "type") == AT_OBJECT)
        .collect();
    let worn = session.own_attachment_count();
    crate::dlog!(
        "outfit: COF has {} object link(s), sim shows {} attachment(s) on us",
        objects.len(),
        worn
    );
    if objects.is_empty() || worn >= objects.len() {
        return; // everything (or more) already attached
    }
    for it in objects {
        let compound = crate::bridge::circuit::gen_id();
        let body = build_attach_message(&agent, &sess_uuid, &compound, it);
        session.send_encoded("RezMultipleAttachmentsFromInv", &body, true).await;
        tokio::time::sleep(Duration::from_millis(REZ_SPACING_MS)).await;
    }
    crate::dlog!("outfit: restore requests sent");
}
