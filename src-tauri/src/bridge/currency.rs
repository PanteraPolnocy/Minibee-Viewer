//! Buying L$ through the grid's currency helper.
//!
//! The flow is the one the helper expects, two XML-RPC calls against its
//! `currency.php`: `getCurrencyQuote` prices an amount (and hands back a
//! `confirm` token), then `buyCurrency` carries that quote back to make the
//! purchase. The context these calls need - agent id, secure session id, and
//! the helper URL - is captured at login and never taken from the frontend.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::State;

use crate::bridge::login::{member_int, member_string, parse_login_response, xmlrpc_call};
use crate::bridge::proxy;
use crate::bridge::state::AppState;
use crate::bridge::util::{trim_quotes, truthy};

#[derive(Debug, Clone, Default)]
pub struct CurrencyContext {
    pub agent_id: String,
    pub secure_session_id: String,
    /// Helper base URL ("https://.../helpers/"); empty when the grid has none,
    /// in which case buying is unavailable.
    pub helper_uri: String,
    /// Whether this session is on a Linden grid (agni/aditi).
    pub linden_grid: bool,
}

/// The per-grid currency helper. Linden grids have fixed helpers; other grids
/// name theirs in the login reply or go without.
pub fn helper_uri_for(grid: &str, login_helper: &str) -> String {
    match grid {
        "agni" | "" => "https://secondlife.com/helpers/".into(),
        "aditi" => "https://secondlife.aditi.lindenlab.com/helpers/".into(),
        _ => trim_quotes(login_helper),
    }
}

fn endpoint(helper: &str) -> String {
    match helper {
        "" => String::new(),
        h if h.ends_with('/') => format!("{h}currency.php"),
        h => format!("{h}/currency.php"),
    }
}

/// The parameters both calls share: who is asking, for how much, from which viewer.
fn base_members(state: &AppState, ctx: &CurrencyContext, amount: i64) -> String {
    let vi = |k: &str| state.version.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    let channel = state.version.get("channel").and_then(|x| x.as_str()).unwrap_or("");
    [
        member_string("agentId", &ctx.agent_id),
        member_string("secureSessionId", &ctx.secure_session_id),
        member_string("language", "en"),
        member_int("currencyBuy", amount),
        member_string("viewerChannel", channel),
        member_int("viewerMajorVersion", vi("major")),
        member_int("viewerMinorVersion", vi("minor")),
        member_int("viewerPatchVersion", vi("patch")),
        // A string on purpose: CI build numbers overflow XML-RPC's 32-bit int.
        member_string("viewerBuildVersion", &vi("build").to_string()),
    ]
    .join("")
}

async fn call(state: &AppState, url: &str, method: &str, members: &str) -> Result<Map<String, Value>, String> {
    let xml = xmlrpc_call(method, members);
    // Same trust class as the login endpoint: the helper is the user's own grid
    // (possibly a LAN OpenSim), so no private-host guard, but the pin still stops
    // DNS rebinding on public hosts.
    let pin = proxy::resolve_public_pin(url).await;
    let ex = proxy::exchange(&state.ua, "POST", url, &xml, "text/xml", &[], pin, Duration::from_secs(60), false)
        .await
        .map_err(|e| format!("Currency service error: {e}"))?;
    if !(200..300).contains(&ex.status) {
        return Err(format!("Currency service HTTP {}", ex.status));
    }
    parse_login_response(&ex.body)
}

/// Read a string member the way login does: numbers stringify rather than vanish.
fn str_of(m: &Map<String, Value>, k: &str) -> String {
    match m.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Everything a currency command needs up front, or the reply that ends it early.
fn gate(state: &AppState, amount: i64) -> Result<Result<(CurrencyContext, String), Value>, String> {
    if amount <= 0 {
        return Err("Amount must be a positive number".into());
    }
    state.active().ok_or("No active session")?;
    let ctx = state
        .currency
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No currency session".to_string())?;
    let url = endpoint(&ctx.helper_uri);
    if url.is_empty() {
        return Ok(Err(json!({
            "ok": false,
            "unsupported": true,
            "error": "Buying currency is not available on this grid.",
        })));
    }
    Ok(Ok((ctx, url)))
}

fn failure(r: &Map<String, Value>) -> Value {
    // A refusal carries errorMessage; a protocol-level fault carries faultString.
    let msg = match str_of(r, "errorMessage") {
        m if m.is_empty() => str_of(r, "faultString"),
        m => m,
    };
    json!({
        "ok": false,
        "error": if msg.is_empty() { "The billing service is unavailable right now.".to_string() } else { msg },
    })
}

/// Price `amount` L$. Returns the estimate plus the confirm token a purchase
/// must echo; `{ ok: false, unsupported: true }` on grids with no helper.
#[tauri::command]
pub async fn sl_currency_quote(state: State<'_, Arc<AppState>>, amount: i64) -> Result<Value, String> {
    let (ctx, url) = match gate(&state, amount)? {
        Ok(ready) => ready,
        Err(reply) => return Ok(reply),
    };
    let r = call(&state, &url, "getCurrencyQuote", &base_members(&state, &ctx, amount)).await?;
    if !truthy(r.get("success")) {
        return Ok(failure(&r));
    }
    let currency = r.get("currency").cloned().unwrap_or_else(|| json!({}));
    let usd_cents = currency.get("estimatedCost").and_then(|v| v.as_i64());
    let local_cost = currency.get("estimatedLocalCost").and_then(|v| v.as_str()).map(str::to_string);
    // Old-style helpers price in US cents; newer ones send a local-currency string.
    let estimate = match (&local_cost, usd_cents) {
        (Some(l), _) if !l.is_empty() => l.clone(),
        (_, Some(c)) => format!("US$ {:.2}", c as f64 / 100.0),
        _ => String::new(),
    };
    Ok(json!({
        "ok": true,
        // The helper may round or clamp the amount; its figure is the one bought.
        "amount": currency.get("currencyBuy").and_then(|v| v.as_i64()).unwrap_or(amount),
        "estimate": estimate,
        "usdCents": usd_cents,
        "localCost": local_cost,
        "confirm": str_of(&r, "confirm"),
    }))
}

/// Buy `amount` L$, echoing the estimate and confirm token from the quote.
#[tauri::command]
pub async fn sl_currency_buy(
    state: State<'_, Arc<AppState>>,
    amount: i64,
    confirm: String,
    usd_cents: Option<i64>,
    local_cost: Option<String>,
    password: Option<String>,
) -> Result<Value, String> {
    let (ctx, url) = match gate(&state, amount)? {
        Ok(ready) => ready,
        Err(reply) => return Ok(reply),
    };
    let mut members = base_members(&state, &ctx, amount);
    members.push_str(&member_string("confirm", &confirm));
    if let Some(c) = usd_cents {
        members.push_str(&member_int("estimatedCost", c));
    }
    if let Some(l) = local_cost.filter(|l| !l.is_empty()) {
        members.push_str(&member_string("estimatedLocalCost", &l));
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        members.push_str(&member_string("password", &p));
    }
    let r = call(&state, &url, "buyCurrency", &members).await?;
    if !truthy(r.get("success")) {
        return Ok(failure(&r));
    }
    crate::dlog!("currency: bought L${amount}");
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_uri_is_fixed_for_linden_grids_and_login_supplied_elsewhere() {
        assert_eq!(helper_uri_for("agni", ""), "https://secondlife.com/helpers/");
        assert_eq!(helper_uri_for("agni", "https://evil.example/"), "https://secondlife.com/helpers/");
        assert_eq!(helper_uri_for("aditi", ""), "https://secondlife.aditi.lindenlab.com/helpers/");
        assert_eq!(helper_uri_for("local", "\"http://127.0.0.1:9000/\""), "http://127.0.0.1:9000/");
        assert_eq!(helper_uri_for("local", "'http://10.0.0.5/economy/'"), "http://10.0.0.5/economy/");
        assert_eq!(helper_uri_for("local", ""), "");
    }

    #[test]
    fn endpoint_joins_cleanly() {
        assert_eq!(endpoint("https://x/helpers/"), "https://x/helpers/currency.php");
        assert_eq!(endpoint("https://x/helpers"), "https://x/helpers/currency.php");
        assert_eq!(endpoint(""), "");
    }

    #[test]
    fn quote_response_parses_both_estimate_styles() {
        let xml = r#"<?xml version="1.0"?><methodResponse><params><param><value><struct>
            <member><name>success</name><value><boolean>1</boolean></value></member>
            <member><name>confirm</name><value><string>click</string></value></member>
            <member><name>currency</name><value><struct>
                <member><name>estimatedCost</name><value><int>399</int></value></member>
                <member><name>estimatedLocalCost</name><value><string>3.70 Euro</string></value></member>
                <member><name>currencyBuy</name><value><int>1000</int></value></member>
            </struct></value></member>
        </struct></value></param></params></methodResponse>"#;
        let r = parse_login_response(xml).expect("parse");
        assert!(truthy(r.get("success")));
        assert_eq!(str_of(&r, "confirm"), "click");
        let c = r.get("currency").unwrap();
        assert_eq!(c["estimatedCost"], 399);
        assert_eq!(c["estimatedLocalCost"], "3.70 Euro");
        assert_eq!(c["currencyBuy"], 1000);
    }

    #[test]
    fn failure_keeps_the_server_message() {
        let xml = r#"<?xml version="1.0"?><methodResponse><params><param><value><struct>
            <member><name>success</name><value><boolean>0</boolean></value></member>
            <member><name>errorMessage</name><value><string>Billing is down for maintenance.</string></value></member>
        </struct></value></param></params></methodResponse>"#;
        let r = parse_login_response(xml).expect("parse");
        assert!(!truthy(r.get("success")));
        assert_eq!(failure(&r)["error"], "Billing is down for maintenance.");
    }

    #[test]
    fn failure_surfaces_an_xmlrpc_fault() {
        let xml = r#"<?xml version="1.0"?><methodResponse><fault><value><struct>
            <member><name>faultCode</name><value><int>4</int></value></member>
            <member><name>faultString</name><value><string>Method not supported.</string></value></member>
        </struct></value></fault></methodResponse>"#;
        let r = parse_login_response(xml).expect("parse");
        assert!(!truthy(r.get("success")));
        assert_eq!(failure(&r)["error"], "Method not supported.");
    }

    #[test]
    fn call_xml_carries_the_quote_fields() {
        let (payload, ua) = crate::bridge::state::version_payload("Minibee-Viewer Test", 1, 2, 3, 456);
        let state = AppState::new(payload, ua);
        let ctx = CurrencyContext {
            agent_id: "agent".into(),
            secure_session_id: "secure".into(),
            helper_uri: "https://x/helpers/".into(),
            linden_grid: true,
        };
        let xml = xmlrpc_call("getCurrencyQuote", &base_members(&state, &ctx, 1000));
        assert!(xml.contains("<methodName>getCurrencyQuote</methodName>"));
        assert!(xml.contains("<name>agentId</name><value><string>agent</string></value>"));
        assert!(xml.contains("<name>secureSessionId</name><value><string>secure</string></value>"));
        assert!(xml.contains("<name>currencyBuy</name><value><int>1000</int></value>"));
        assert!(xml.contains("<name>viewerBuildVersion</name><value><string>456</string></value>"));
        assert!(xml.contains("<name>viewerMajorVersion</name><value><int>1</int></value>"));
    }
}
