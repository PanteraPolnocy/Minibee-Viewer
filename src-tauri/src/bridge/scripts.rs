//! LSL scripts: list the ones in the agent's inventory, download their source,
//! save/compile through the region caps, and serve the grid's LSL language
//! data to the editor.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Map, Value};
use tauri::State;

use crate::bridge::inventory::{self, AT_LSL_TEXT};
use crate::bridge::proxy;
use crate::bridge::state::AppState;
use crate::codec;

type Cmd = Result<Value, String>;

/// The compiler enforces a much smaller source limit; this only stops a runaway
/// frontend from shipping megabytes at the sim.
const MAX_SOURCE_BYTES: usize = 512 * 1024;

fn script_row(item: &Value) -> Option<Value> {
    if inventory::item_i64(item, "type") != AT_LSL_TEXT {
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

/// Script rows for the UI: one per item, sorted by name.
pub fn script_rows(items: &[Value]) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut rows: Vec<Value> = items
        .iter()
        .filter_map(script_row)
        .filter(|r| seen.insert(r["itemId"].as_str().unwrap_or("").to_string()))
        .collect();
    rows.sort_by_cached_key(|r| r["name"].as_str().unwrap_or("").to_lowercase());
    rows
}

#[tauri::command]
pub async fn sl_scripts_list(state: State<'_, Arc<AppState>>) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let (agent, _) = session.agent_ids().ok_or("Session not ready")?;
    let roots = state.script_folders.lock().unwrap().clone();
    if roots.is_empty() {
        return Ok(json!({ "ok": true, "scripts": [], "noFolder": true }));
    }
    if session.cap("FetchInventoryDescendents2").is_none() {
        return Err("Inventory capability unavailable".into());
    }
    let items = inventory::collect_folder_items(state.inner(), &session, &roots, &agent).await;
    Ok(json!({ "ok": true, "scripts": script_rows(&items) }))
}

/// Ask the sim for an agent-inventory text asset over the transfer channel.
/// The text arrives as a `script-source` / `notecard-source` event once the
/// packets are assembled. One download at a time: a newer request replaces a
/// stalled older one.
pub(crate) async fn request_item_source(
    state: &State<'_, Arc<AppState>>,
    item_id: &str,
    asset_id: &str,
    asset_type: i64,
    notecard: bool,
) -> Cmd {
    let (s, agent, sess) = crate::commands::active_ids(state)?;
    let item_id = item_id.trim().to_ascii_lowercase();
    if !inventory::is_uuid(&item_id) || inventory::is_zero_uuid(&item_id) {
        return Err("Not an inventory item".into());
    }
    const CHANNEL_ASSET: i64 = 2; // LLTCT_ASSET
    const SOURCE_SIM_INV_ITEM: i64 = 3; // LLTST_SIM_INV_ITEM
    let transfer_id = crate::bridge::circuit::gen_id();
    // Params: agent, session, owner, task (null for agent inventory), item,
    // asset - six raw UUIDs - then the asset type as S32 LE.
    let mut params = Vec::with_capacity(100);
    for id in [&agent as &str, &sess, &agent, "", &item_id, asset_id] {
        params.extend_from_slice(&crate::commands::uuid_bytes(id));
    }
    params.extend_from_slice(&(asset_type as i32).to_le_bytes());
    s.begin_script_transfer(&transfer_id, &item_id, notecard);
    s.send_encoded(
        "TransferRequest",
        &json!({
            "TransferInfo": [{
                "TransferID": transfer_id,
                "ChannelType": CHANNEL_ASSET,
                "SourceType": SOURCE_SIM_INV_ITEM,
                "Priority": 101.0,
                "Params": B64.encode(&params),
            }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sl_script_source(state: State<'_, Arc<AppState>>, item_id: String, asset_id: String) -> Cmd {
    request_item_source(&state, &item_id, &asset_id, AT_LSL_TEXT, false).await
}

/// Tags our CreateInventoryItem so the UpdateCreateInventoryItem reply can be
/// told apart from item creations we didn't ask for.
pub const SCRIPT_CREATE_CALLBACK: i64 = 0x4D69_4265; // "MiBe"

/// An inventory-legal item name: trimmed, no control characters, cut to the
/// server's 63-byte limit.
fn clean_item_name(name: &str) -> Result<String, String> {
    let mut name: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    if name.is_empty() {
        return Err("A name is required".into());
    }
    while name.len() > 63 {
        name.pop();
    }
    Ok(name)
}

/// Create a new inventory item of `asset_type` in `folder`. The reply routes
/// back as a `script-created` / `notecard-created` event (by item type) once
/// UpdateCreateInventoryItem lands.
pub(crate) async fn create_inventory_item(
    state: &State<'_, Arc<AppState>>,
    name: &str,
    folder: &str,
    asset_type: i64,
) -> Cmd {
    let (s, agent, sess) = crate::commands::active_ids(state)?;
    let name = clean_item_name(name)?;
    // Next owner: move + transfer, the grid's usual default for new items.
    const NEXT_OWNER_DEFAULT: i64 = 0x0008_2000;
    s.send_encoded(
        "CreateInventoryItem",
        &json!({
            "AgentData": [{ "AgentID": agent, "SessionID": sess }],
            "InventoryBlock": [{
                "CallbackID": SCRIPT_CREATE_CALLBACK,
                "FolderID": folder,
                "TransactionID": "00000000-0000-0000-0000-000000000000",
                "NextOwnerMask": NEXT_OWNER_DEFAULT,
                "Type": asset_type,
                "InvType": asset_type,
                "WearableType": 0,
                "Name": name,
                "Description": "",
            }],
        }),
        true,
    )
    .await;
    Ok(json!({ "ok": true }))
}

/// Create a new script in the Scripts folder. The server assigns the default
/// "Hello, Avatar!" source.
#[tauri::command]
pub async fn sl_script_create(state: State<'_, Arc<AppState>>, name: String) -> Cmd {
    let folder = state.script_folders.lock().unwrap().first().cloned().unwrap_or_default();
    if folder.is_empty() {
        return Err("No Scripts folder in this inventory".into());
    }
    create_inventory_item(&state, &name, &folder, AT_LSL_TEXT).await
}

/// Rename an inventory item over the AIS inventory cap (a PATCH of `name`).
#[tauri::command]
pub async fn sl_script_rename(state: State<'_, Arc<AppState>>, item_id: String, name: String) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let item_id = item_id.trim().to_ascii_lowercase();
    if !inventory::is_uuid(&item_id) || inventory::is_zero_uuid(&item_id) {
        return Err("Not an inventory item".into());
    }
    let name = clean_item_name(&name)?;
    let cap = session.cap("InventoryAPIv3").ok_or("Inventory update capability unavailable")?;
    let url = format!("{}/item/{item_id}", cap.trim_end_matches('/'));
    let body = format!(
        "<?xml version=\"1.0\"?><llsd><map><key>name</key><string>{}</string></map></llsd>",
        inventory::xml_escape(&name)
    );
    let agent_session = session.agent_ids().map(|(_, s)| s).unwrap_or_default();
    let headers: Vec<(String, String)> = if agent_session.is_empty() {
        Vec::new()
    } else {
        vec![("X-SecondLife-Session-ID".to_string(), agent_session)]
    };
    let (pin, _) = proxy::simhost_pin(&url, "").await;
    let ex = proxy::exchange(&state.ua, "PATCH", &url, &body, "application/llsd+xml", &headers, pin, Duration::from_secs(30), true).await?;
    if !(200..300).contains(&ex.status) {
        crate::dlog!("scripts: rename HTTP {} body={:.200}", ex.status, ex.body);
        return Err(format!("Rename failed (HTTP {})", ex.status));
    }
    Ok(json!({ "ok": true, "name": name }))
}

/// One "(line, column) : severity : text" compiler message, split into parts
/// the editor can jump to. Lines/columns are 0-based on the wire.
pub fn parse_diagnostic(raw: &str) -> Value {
    let raw = raw.trim();
    let parsed = (|| {
        let rest = raw.strip_prefix('(')?;
        let (nums, tail) = rest.split_once(')')?;
        let (line, column) = nums.split_once(',')?;
        let line: i64 = line.trim().parse().ok()?;
        let column: i64 = column.trim().parse().ok()?;
        let text = tail.trim_start().strip_prefix(':').unwrap_or(tail).trim();
        Some(json!({ "line": line, "column": column, "text": text }))
    })();
    parsed.unwrap_or_else(|| json!({ "text": raw }))
}

/// Save an agent-inventory script: UpdateScriptAgent hands back a one-shot
/// uploader URL, the source is posted there, and the sim compiles it as part
/// of accepting the upload.
#[tauri::command]
pub async fn sl_script_save(
    state: State<'_, Arc<AppState>>,
    item_id: String,
    text: String,
    target: Option<String>,
) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let item_id = item_id.trim().to_ascii_lowercase();
    if !inventory::is_uuid(&item_id) || inventory::is_zero_uuid(&item_id) {
        return Err("Not a script".into());
    }
    if text.len() > MAX_SOURCE_BYTES {
        return Err("Script is too large".into());
    }
    let target = match target.as_deref() {
        None | Some("mono") => "mono",
        Some("lsl2") => "lsl2",
        Some(_) => return Err("Unknown script target".into()),
    };
    if session.cap("UpdateScriptAgent").is_none() {
        return Err("Script upload capability unavailable".into());
    }
    let body = format!(
        "<?xml version=\"1.0\"?><llsd><map>\
         <key>item_id</key><uuid>{item_id}</uuid>\
         <key>target</key><string>{target}</string>\
         </map></llsd>"
    );
    let first = inventory::cap_post(state.inner(), &session, "UpdateScriptAgent", &body)
        .await
        .ok_or("The script update request failed")?;
    let uploader = first.get("uploader").and_then(|v| v.as_str()).unwrap_or("");
    if uploader.is_empty() {
        let msg = first
            .get("message")
            .or_else(|| first.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("The sim refused the script update");
        return Err(msg.to_string());
    }
    let (pin, _) = proxy::simhost_pin(uploader, "").await;
    let ex = proxy::exchange(
        &state.ua,
        "POST",
        uploader,
        &text,
        "application/octet-stream",
        &[],
        pin,
        Duration::from_secs(60),
        true,
    )
    .await?;
    if !(200..300).contains(&ex.status) {
        return Err(format!("Script upload failed (HTTP {})", ex.status));
    }
    let result = codec::llsd::parse(&ex.body, &ex.content_type).unwrap_or(Value::Null);
    let compiled = result.get("compiled").and_then(|v| v.as_bool()).unwrap_or(false);
    let uploaded = result.get("state").and_then(|v| v.as_str()).unwrap_or("") == "complete";
    let diagnostics: Vec<Value> = result
        .get("errors")
        .and_then(|v| v.as_array())
        .map(|errs| errs.iter().filter_map(|e| e.as_str()).map(parse_diagnostic).collect())
        .unwrap_or_default();
    Ok(json!({
        "ok": uploaded,
        "compiled": compiled,
        "diagnostics": diagnostics,
        "newAsset": result.get("new_asset").and_then(|v| v.as_str()).unwrap_or(""),
    }))
}

fn short_tooltip(attrs: &Value) -> String {
    let mut t = attrs.get("tooltip").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if t.len() > 400 {
        let mut cut = 400;
        while !t.is_char_boundary(cut) {
            cut -= 1;
        }
        t.truncate(cut);
        t.push('\u{2026}');
    }
    t
}

/// Argument list out of the syntax file's shape: an array of one-key maps,
/// each `name -> { type, tooltip }`.
fn syntax_args(attrs: &Value) -> Vec<Value> {
    attrs
        .get("arguments")
        .and_then(|v| v.as_array())
        .map(|args| {
            args.iter()
                .filter_map(|a| {
                    let (name, info) = a.as_object()?.iter().next()?;
                    Some(json!({
                        "name": name,
                        "type": info.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn sorted_names(group: Option<&Map<String, Value>>) -> Vec<String> {
    let mut names: Vec<String> = group.map(|g| g.keys().cloned().collect()).unwrap_or_default();
    names.sort_unstable();
    names
}

/// Reshape the grid's LSLSyntax document into the flat lists the editor uses.
pub fn transform_syntax(doc: &Value) -> Value {
    let group = |key: &str| doc.get(key).and_then(|v| v.as_object());
    let functions: Vec<Value> = group("functions")
        .map(|g| {
            let mut rows: Vec<Value> = g
                .iter()
                .map(|(name, attrs)| {
                    json!({
                        "name": name,
                        "return": attrs.get("return").and_then(|v| v.as_str()).unwrap_or("void"),
                        "args": syntax_args(attrs),
                        "tooltip": short_tooltip(attrs),
                    })
                })
                .collect();
            rows.sort_by_cached_key(|r| r["name"].as_str().unwrap_or("").to_string());
            rows
        })
        .unwrap_or_default();
    let events: Vec<Value> = group("events")
        .map(|g| {
            let mut rows: Vec<Value> = g
                .iter()
                .map(|(name, attrs)| {
                    json!({ "name": name, "args": syntax_args(attrs), "tooltip": short_tooltip(attrs) })
                })
                .collect();
            rows.sort_by_cached_key(|r| r["name"].as_str().unwrap_or("").to_string());
            rows
        })
        .unwrap_or_default();
    let constants: Vec<Value> = group("constants")
        .map(|g| {
            let mut rows: Vec<Value> = g
                .iter()
                .map(|(name, attrs)| {
                    json!({
                        "name": name,
                        "type": attrs.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                        "value": attrs.get("value").and_then(|v| v.as_str()).unwrap_or(""),
                    })
                })
                .collect();
            rows.sort_by_cached_key(|r| r["name"].as_str().unwrap_or("").to_string());
            rows
        })
        .unwrap_or_default();
    json!({
        "ok": true,
        "functions": functions,
        "events": events,
        "constants": constants,
        "types": sorted_names(group("types")),
        "controls": sorted_names(group("controls")),
    })
}

/// The types and flow keywords every LSL grid shares - just enough for the
/// editor to color code when the region has no LSLSyntax capability.
fn fallback_language() -> Value {
    json!({
        "ok": true,
        "fallback": true,
        "functions": [],
        "events": [],
        "constants": [],
        "types": ["float", "integer", "key", "list", "quaternion", "rotation", "string", "vector"],
        "controls": ["default", "do", "else", "for", "if", "jump", "return", "state", "while"],
    })
}

/// How the disk copy of the language data is laid out; bump when
/// `transform_syntax` changes shape so stale caches are refetched.
const SYNTAX_CACHE_VERSION: i64 = 1;
const SYNTAX_CACHE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);

/// The app's own data directory - not the OS cache, which the system (and
/// "clear cache" buttons) may wipe at will. Chat logs live under here too.
pub(crate) fn app_data_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn syntax_cache_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    Some(app_data_dir(app)?.join("lsl-syntax.json"))
}

/// The cached language file, plus whether it is still fresh (under a week old).
fn read_syntax_cache(path: &std::path::Path) -> Option<(Value, bool)> {
    let meta = std::fs::metadata(path).ok()?;
    let fresh = meta
        .modified()
        .ok()
        .and_then(|m| m.elapsed().ok())
        .is_some_and(|age| age < SYNTAX_CACHE_MAX_AGE);
    let text = std::fs::read_to_string(path).ok()?;
    let doc: Value = serde_json::from_str(&text).ok()?;
    if doc.get("cacheVersion").and_then(|v| v.as_i64()) != Some(SYNTAX_CACHE_VERSION) {
        return None;
    }
    Some((doc, fresh))
}

/// The grid's LSL language data (functions, events, constants, types), from
/// the LSLSyntax capability. Cached in memory per cap URL and on disk for a
/// week - the file barely ever changes, and it is over a megabyte to fetch.
#[tauri::command]
pub async fn sl_lsl_language(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Cmd {
    let session = state.active().ok_or("No active session")?;
    let Some(cap) = session.cap("LSLSyntax") else {
        return Ok(fallback_language());
    };
    if let Some((url, cached)) = state.lsl_syntax.lock().unwrap().as_ref() {
        if *url == cap {
            return Ok(cached.clone());
        }
    }
    let cache_path = syntax_cache_path(&app);
    let disk = cache_path.as_deref().and_then(read_syntax_cache);
    if let Some((doc, true)) = &disk {
        *state.lsl_syntax.lock().unwrap() = Some((cap, doc.clone()));
        return Ok(doc.clone());
    }
    let (pin, _) = proxy::simhost_pin(&cap, "").await;
    let fetched = match proxy::exchange(&state.ua, "GET", &cap, "", "application/llsd+xml", &[], pin, Duration::from_secs(60), true).await {
        Ok(ex) if (200..300).contains(&ex.status) => codec::llsd::parse(&ex.body, &ex.content_type).ok(),
        Ok(ex) => {
            crate::dlog!("scripts: LSLSyntax HTTP {}", ex.status);
            None
        }
        Err(e) => {
            crate::dlog!("scripts: LSLSyntax fetch failed: {e}");
            None
        }
    };
    let lang = match fetched {
        Some(doc) => {
            let mut lang = transform_syntax(&doc);
            lang["cacheVersion"] = json!(SYNTAX_CACHE_VERSION);
            if let Some(path) = &cache_path {
                if let Ok(text) = serde_json::to_string(&lang) {
                    let _ = std::fs::write(path, text);
                }
            }
            lang
        }
        // A week-stale copy still beats bare types-and-keywords highlighting.
        None => match disk {
            Some((doc, _)) => doc,
            None => return Ok(fallback_language()),
        },
    };
    *state.lsl_syntax.lock().unwrap() = Some((cap, lang.clone()));
    Ok(lang)
}

/// Conservative LSL pretty-printer: re-indents each line to its brace depth
/// (4 spaces per level) and trims trailing whitespace. Nothing inside strings
/// or comments is touched, and multi-line strings / block-comment bodies pass
/// through byte-for-byte, so a format can never change what the code does.
pub fn format_lsl(src: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut in_block_comment = false;
    for line in src.split('\n') {
        let starts_in_code = !in_string && !in_block_comment;
        // Leading closers un-indent the line they sit on.
        let mut indent = depth;
        if starts_in_code {
            let mut rest = line.trim_start();
            while let Some(r) = rest.strip_prefix('}') {
                indent -= 1;
                rest = r.trim_start();
            }
        }
        // Scan the line to carry depth/string/comment state to the next one.
        let bytes = line.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];
            if in_string {
                if b == b'\\' {
                    i += 1; // the escaped byte can't close the string
                } else if b == b'"' {
                    in_string = false;
                }
            } else if in_block_comment {
                if b == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    in_block_comment = false;
                    i += 1;
                }
            } else {
                match b {
                    b'/' if bytes.get(i + 1) == Some(&b'/') => break, // line comment
                    b'/' if bytes.get(i + 1) == Some(&b'*') => {
                        in_block_comment = true;
                        i += 1;
                    }
                    b'"' => in_string = true,
                    b'{' => depth += 1,
                    b'}' => depth = (depth - 1).max(0),
                    _ => {}
                }
            }
            i += 1;
        }
        if !starts_in_code {
            // Inside a string or block comment: the line is content, not code.
            out.push(line.to_string());
            continue;
        }
        // A line that ends inside a string keeps its tail (trailing spaces there
        // are string content); a pure code line loses trailing whitespace.
        let content = if in_string { line.trim_start() } else { line.trim() };
        if content.is_empty() {
            out.push(String::new());
        } else {
            out.push(format!("{}{}", "    ".repeat(indent.max(0) as usize), content));
        }
    }
    out.join("\n")
}

/// Re-indent an LSL source. Pure text work; no session needed.
#[tauri::command]
pub fn sl_lsl_format(text: String) -> Cmd {
    if text.len() > MAX_SOURCE_BYTES {
        return Err("Script is too large".into());
    }
    Ok(json!({ "ok": true, "text": format_lsl(&text) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_keep_scripts_only_sorted() {
        let items = vec![
            json!({ "item_id": "aa000000-0000-0000-0000-000000000001", "type": AT_LSL_TEXT, "asset_id": "BB000000-0000-0000-0000-000000000002", "name": "zeta", "permissions": { "creator_id": "CC000000-0000-0000-0000-000000000003", "last_owner_id": "DD000000-0000-0000-0000-000000000004" } }),
            json!({ "item_id": "aa000000-0000-0000-0000-000000000002", "type": AT_LSL_TEXT, "asset_id": "", "name": "Alpha" }),
            json!({ "item_id": "aa000000-0000-0000-0000-000000000002", "type": AT_LSL_TEXT, "asset_id": "", "name": "Alpha again" }),
            json!({ "item_id": "aa000000-0000-0000-0000-000000000003", "type": 3, "asset_id": "", "name": "a landmark" }),
            json!({ "item_id": "not-a-uuid", "type": AT_LSL_TEXT, "asset_id": "", "name": "broken" }),
        ];
        let rows = script_rows(&items);
        let names: Vec<&str> = rows.iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["Alpha", "zeta"]);
        assert_eq!(rows[1]["assetId"], "bb000000-0000-0000-0000-000000000002");
        assert_eq!(rows[1]["creatorId"], "cc000000-0000-0000-0000-000000000003");
        assert_eq!(rows[1]["lastOwnerId"], "dd000000-0000-0000-0000-000000000004");
    }

    #[test]
    fn item_names_are_cleaned_and_capped() {
        assert_eq!(clean_item_name("  My Script  ").unwrap(), "My Script");
        assert_eq!(clean_item_name("a\tb\nc").unwrap(), "abc");
        assert!(clean_item_name("   ").is_err());
        let long = "x".repeat(100);
        assert_eq!(clean_item_name(&long).unwrap().len(), 63);
        // Multi-byte characters get cut on a boundary, not mid-codepoint.
        let uni = "ż".repeat(40);
        let cleaned = clean_item_name(&uni).unwrap();
        assert!(cleaned.len() <= 63 && cleaned.chars().all(|c| c == 'ż'));
    }

    #[test]
    fn diagnostics_split_position_from_text() {
        let d = parse_diagnostic("(24, 9) : ERROR : Syntax error");
        assert_eq!(d["line"], 24);
        assert_eq!(d["column"], 9);
        assert_eq!(d["text"], "ERROR : Syntax error");
        // No parsable position: the raw message survives untouched.
        let d = parse_diagnostic("Compile failed");
        assert_eq!(d["text"], "Compile failed");
        assert!(d.get("line").is_none());
    }

    #[test]
    fn format_reindents_by_brace_depth() {
        let src = "default\n{\nstate_entry()\n{\nif (TRUE)\n{\nllOwnerSay(\"hi\");   \n}\n}\n}";
        let want = "default\n{\n    state_entry()\n    {\n        if (TRUE)\n        {\n            llOwnerSay(\"hi\");\n        }\n    }\n}";
        assert_eq!(format_lsl(src), want);
        // Leading closers un-indent their own line ("} else {").
        let src = "default {\ntouch_start(integer n) {\nif (n) {\n} else {\nllSay(0, \"x\");\n}\n}\n}";
        let out = format_lsl(src);
        assert!(out.contains("\n        } else {\n"), "got:\n{out}");
        // Idempotent: formatting twice changes nothing.
        assert_eq!(format_lsl(&out), out);
    }

    #[test]
    fn format_leaves_strings_and_comments_alone() {
        // Braces inside strings and comments must not shift the indent.
        let src = "default\n{\nstate_entry()\n{\nllSay(0, \"}{}{\"); // }}}\n/* {{{\n   raw comment body\n*/\nllSay(0, \"ok\");\n}\n}";
        let out = format_lsl(src);
        assert!(out.contains("        llSay(0, \"}{}{\"); // }}}"), "got:\n{out}");
        // The block-comment body passes through untouched.
        assert!(out.contains("\n   raw comment body\n"), "got:\n{out}");
        assert!(out.contains("        llSay(0, \"ok\");"), "got:\n{out}");
        // A string spanning lines keeps its inner lines byte-for-byte.
        let src = "default\n{\nstate_entry()\n{\nllSay(0, \"line one\n  spaced line   \n\");\n}\n}";
        let out = format_lsl(src);
        assert!(out.contains("\n  spaced line   \n"), "got:\n{out}");
    }

    #[test]
    fn syntax_transform_flattens_the_llsd_shape() {
        let doc = json!({
            "functions": {
                "llOwnerSay": {
                    "return": "void",
                    "arguments": [ { "msg": { "type": "string" } } ],
                    "tooltip": "Says msg to the owner only.",
                },
            },
            "events": { "touch_start": { "arguments": [ { "total_number": { "type": "integer" } } ] } },
            "constants": { "TRUE": { "type": "integer", "value": "1" } },
            "types": { "integer": {}, "float": {} },
            "controls": { "if": {}, "for": {} },
        });
        let lang = transform_syntax(&doc);
        assert_eq!(lang["functions"][0]["name"], "llOwnerSay");
        assert_eq!(lang["functions"][0]["args"][0]["name"], "msg");
        assert_eq!(lang["functions"][0]["args"][0]["type"], "string");
        assert_eq!(lang["events"][0]["name"], "touch_start");
        assert_eq!(lang["constants"][0]["value"], "1");
        assert_eq!(lang["types"], json!(["float", "integer"]));
        assert_eq!(lang["controls"], json!(["for", "if"]));
    }
}
