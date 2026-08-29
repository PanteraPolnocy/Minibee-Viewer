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
use crate::bridge::inventory::{fetch_folder, fetch_items, item_i64, item_str, link_target, AT_OBJECT};
use crate::bridge::state::AppState;

/// AttachmentPt high bit: "add" (keep the point's other attachments). With the
/// point byte 0 the sim uses the item's own stored attachment point.
const ATTACHMENT_ADD: u8 = 0x80;

/// One attachment per message, spaced out. Batched rez requests are known to
/// misbehave server-side, especially when replacing already-worn items.
const REZ_SPACING_MS: u64 = 300;

/// NUL-terminate a string and base64-encode it for a Variable message field.
fn vstr(s: &str) -> Value {
    json!(B64.encode(format!("{s}\0").as_bytes()))
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
    let Some((rows, _)) = fetch_folder(state, session, &cof, &agent, false).await else {
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
