//! Abuse reports: file a complaint about a resident with the grid's
//! moderation team - the SendUserReport capability when the region grants it,
//! the classic UserReport message otherwise.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::State;

use crate::bridge::inventory::{self, xml_escape};
use crate::bridge::state::AppState;
use crate::uitext::{ui_err, UiText};

type Cmd = Result<Value, String>;

/// The categories the report form offers, each with its code and its label:
/// the English the moderation queue reads in the report itself, carrying the
/// key the interface translates the picker entry under. The numeric codes are
/// the grid's own; 0 is reserved for "no category picked".
pub fn abuse_categories() -> Vec<(i64, UiText)> {
    vec![
        (31, UiText::new("abuse.catAgePlay", json!({}))),
        (35, UiText::new("abuse.catAssault", json!({}))),
        (39, UiText::new("abuse.catDisclosure", json!({}))),
        (43, UiText::new("abuse.catScriptedObjects", json!({}))),
        (44, UiText::new("abuse.catLittering", json!({}))),
        (45, UiText::new("abuse.catSpam", json!({}))),
        (50, UiText::new("abuse.catFraud", json!({}))),
        (55, UiText::new("abuse.catHarassment", json!({}))),
        (57, UiText::new("abuse.catOffensive", json!({}))),
        (59, UiText::new("abuse.catAvatarName", json!({}))),
        (60, UiText::new("abuse.catRegionRating", json!({}))),
        (61, UiText::new("abuse.catIntolerance", json!({}))),
        (63, UiText::new("abuse.catEncroachment", json!({}))),
        (67, UiText::new("abuse.catSkillGaming", json!({}))),
    ]
}

/// A resident's complaint (as opposed to the retired bug-report kind).
const REPORT_TYPE_COMPLAINT: i64 = 2;

/// The wire caps: Summary rides a one-byte-length field (255 bytes max),
/// Details a two-byte one. Inputs are cut well under both.
const MAX_SUMMARY_BYTES: usize = 250;
const MAX_DETAILS_BYTES: usize = 8192;

/// The English label of a category, the way the report's summary line names it.
pub fn category_label(category: i64) -> Option<String> {
    abuse_categories().into_iter().find(|(v, _)| *v == category).map(|(_, l)| l.text)
}

fn truncate_bytes(mut s: String, max: usize) -> String {
    while s.len() > max {
        s.pop();
    }
    s
}

/// The summary and details lines, shaped the way the moderation queue is used
/// to reading them: region and location, category, abuser, then the words.
pub fn compose_report(
    region: &str,
    location: &str,
    category_label: &str,
    abuser_name: &str,
    summary: &str,
    details: &str,
    version: &str,
) -> (String, String) {
    let summary_line = format!(" |{region}| ({location}) [{category_label}]  {{{abuser_name}}}  \"{summary}\"");
    let details_text = format!("V{version}\n\nAbuser name: {abuser_name} \nAbuser location: {location} \n{details}");
    (
        truncate_bytes(summary_line, MAX_SUMMARY_BYTES),
        truncate_bytes(details_text, MAX_DETAILS_BYTES),
    )
}

/// The categories, for the report dialog's picker: `value` with `label`,
/// `labelKey` and `labelArgs`.
#[tauri::command]
pub fn sl_abuse_categories() -> Cmd {
    let rows: Vec<Value> = abuse_categories()
        .into_iter()
        .map(|(value, label)| {
            let mut row = json!({ "value": value });
            label.fields(&mut row, "label");
            row
        })
        .collect();
    Ok(json!({ "ok": true, "categories": rows }))
}

/// File an abuse report against a resident. The report goes to the grid's
/// moderation team; nothing is shown to the person being reported.
#[tauri::command]
pub async fn sl_report_abuse(
    state: State<'_, Arc<AppState>>,
    abuser_id: String,
    abuser_name: String,
    category: i64,
    summary: String,
    details: String,
) -> Cmd {
    let (s, agent, sess) = crate::commands::active_ids(&state)?;
    let abuser_id = abuser_id.trim().to_ascii_lowercase();
    if !inventory::is_uuid(&abuser_id) || inventory::is_zero_uuid(&abuser_id) {
        return Err(ui_err("err.notAResident", json!({})));
    }
    let label = category_label(category).ok_or_else(|| ui_err("err.pickACategory", json!({})))?;
    let summary = summary.trim();
    if summary.is_empty() {
        return Err(ui_err("err.summaryRequired", json!({})));
    }
    let details = details.trim();
    let abuser_name = abuser_name.trim();

    let region = s.region_name();
    let region_id = s.region_id();
    let pos = s.agent_position();
    let location = format!(
        "{} ({}, {}, {})",
        region,
        pos[0].round() as i64,
        pos[1].round() as i64,
        pos[2].round() as i64
    );
    let version = state
        .version
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0.0")
        .to_string();
    let (summary_line, details_text) = compose_report(&region, &location, &label, abuser_name, summary, details, &version);

    const ZERO: &str = "00000000-0000-0000-0000-000000000000";
    if s.cap("SendUserReport").is_some() {
        let body = format!(
            "<?xml version=\"1.0\"?><llsd><map>\
             <key>report-type</key><integer>{REPORT_TYPE_COMPLAINT}</integer>\
             <key>category</key><integer>{category}</integer>\
             <key>position</key><array><real>{}</real><real>{}</real><real>{}</real></array>\
             <key>check-flags</key><integer>0</integer>\
             <key>screenshot-id</key><uuid>{ZERO}</uuid>\
             <key>object-id</key><uuid>{ZERO}</uuid>\
             <key>abuser-id</key><uuid>{abuser_id}</uuid>\
             <key>abuse-region-name</key><string></string>\
             <key>abuse-region-id</key><uuid>{ZERO}</uuid>\
             <key>summary</key><string>{}</string>\
             <key>version-string</key><string>{}</string>\
             <key>details</key><string>{}</string>\
             </map></llsd>",
            pos[0],
            pos[1],
            pos[2],
            xml_escape(&summary_line),
            xml_escape(&version),
            xml_escape(&details_text),
        );
        inventory::cap_post(state.inner(), &s, "SendUserReport", &body)
            .await
            .ok_or_else(|| ui_err("err.reportNotSent", json!({})))?;
    } else {
        s.send_encoded(
            "UserReport",
            &json!({
                "AgentData": [{ "AgentID": agent, "SessionID": sess }],
                "ReportData": [{
                    "ReportType": REPORT_TYPE_COMPLAINT,
                    "Category": category,
                    "Position": pos,
                    "CheckFlags": 0,
                    "ScreenshotID": ZERO,
                    "ObjectID": ZERO,
                    "AbuserID": abuser_id,
                    "AbuseRegionName": "",
                    "AbuseRegionID": region_id,
                    "Summary": summary_line,
                    "Details": details_text,
                    "VersionString": version,
                }],
            }),
            true,
        )
        .await;
    }
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories_resolve_to_labels() {
        assert_eq!(category_label(45).as_deref(), Some("Disturbing the peace > Repetitive spam"));
        assert_eq!(category_label(0), None);
        assert_eq!(category_label(999), None);
        // Every listed category is nonzero, uniquely coded and uniquely keyed.
        let mut seen = std::collections::HashSet::new();
        let mut keys = std::collections::HashSet::new();
        for (v, l) in abuse_categories() {
            assert!(v > 0 && !l.text.is_empty());
            assert!(seen.insert(v), "duplicate category code {v}");
            assert!(keys.insert(l.key.clone()), "duplicate category key {}", l.key);
        }
    }

    #[test]
    fn picker_rows_carry_the_label_with_its_key() {
        let rows = sl_abuse_categories().unwrap();
        let first = &rows["categories"][0];
        assert_eq!(first["value"], 31);
        assert_eq!(first["label"], "Age > Age play");
        assert_eq!(first["labelKey"], "abuse.catAgePlay");
        assert_eq!(first["labelArgs"], json!({}));
        assert_eq!(rows["categories"].as_array().unwrap().len(), abuse_categories().len());
    }

    #[test]
    fn report_lines_carry_the_expected_shape() {
        let (summary, details) = compose_report(
            "Natoma",
            "Natoma (12, 34, 25)",
            "Intolerance",
            "Bad Actor",
            "slurs in local chat",
            "Repeatedly, after being asked to stop.",
            "0.11.3.68",
        );
        assert_eq!(
            summary,
            " |Natoma| (Natoma (12, 34, 25)) [Intolerance]  {Bad Actor}  \"slurs in local chat\""
        );
        assert!(details.starts_with("V0.11.3.68\n\n"));
        assert!(details.contains("Abuser name: Bad Actor \n"));
        assert!(details.ends_with("Repeatedly, after being asked to stop."));
    }

    #[test]
    fn overlong_fields_are_cut_on_char_boundaries() {
        let long = "ż".repeat(300);
        let (summary, details) = compose_report("R", "R (0, 0, 0)", "Intolerance", &long, &long, &long, "1.0");
        assert!(summary.len() <= MAX_SUMMARY_BYTES);
        assert!(details.len() <= MAX_DETAILS_BYTES);
        assert!(summary.chars().all(|c| c != '\u{FFFD}'));
    }
}
