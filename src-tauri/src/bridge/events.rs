//! Typed payloads for the events the core pushes to the interface.
//!
//! Every struct here is the single source of truth for one event's shape: the
//! core serialises it, and `npm run types:sync` turns the very same definition
//! into the TypeScript the frontend checks against. That is the point - a
//! hand-written interface on the JavaScript side can only ever record what
//! someone *believed* the core sends, and a belief is exactly what goes stale.
//!
//! Adding an event:
//!   1. Declare the struct here with the three derives and camelCase renaming.
//!   2. Emit it with `emit_typed` (or `payload`) instead of a `json!` literal.
//!   3. Run `npm run types:sync` so the generated declarations catch up.
//!   4. Add a parity test below if the event previously used a `json!` literal,
//!      so the wire shape is proven unchanged.

use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

/// Serialise a payload for `Action::emit`. Falls back to null rather than
/// panicking: a broken event is a missing update, never a dead session.
pub fn payload<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Throughput for the top-bar traffic meter (`net-rate`).
///
/// `label` and `level` are computed here rather than in the interface so the
/// formatting rules and the log scale live with the numbers they describe.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../types/generated/")]
pub struct NetRate {
    // `number`, not the `bigint` ts-rs would infer from u64: serde writes these
    // as plain JSON numbers, so bigint would be a type that lies about the wire.
    // Byte rates sit far inside the range a double represents exactly.
    /// Bytes per second inbound, averaged over the tick.
    #[ts(type = "number")]
    pub in_bps: u64,
    /// Bytes per second outbound, averaged over the tick.
    #[ts(type = "number")]
    pub out_bps: u64,
    /// Ready-to-display summary, e.g. "↓ 1.5 KB/s  ↑ 320 B/s".
    pub label: String,
    /// Log-scaled 0..1 fill for the meter bar.
    pub level: f64,
}

/// Whether the avatar is seated, and on what (`sit-state`).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../types/generated/")]
pub struct SitState {
    pub sitting: bool,
    /// The object sat on, or empty when standing.
    pub object_id: String,
    /// Why the sit did not happen, when a request was refused or timed out.
    /// Omitted entirely on the ordinary sit/stand updates, so those keep the
    /// exact two-field shape the interface has always received.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // These assert the exact JSON the interface used to receive from the old
    // `json!` literals. If a field is renamed or its casing slips, the wire
    // shape changed and something on the other side just went blind.

    #[test]
    fn net_rate_serialises_to_the_documented_shape() {
        let v = payload(NetRate {
            in_bps: 1500,
            out_bps: 300,
            label: "down 1.5 KB/s".into(),
            level: 0.25,
        });
        assert_eq!(
            v,
            json!({ "inBps": 1500, "outBps": 300, "label": "down 1.5 KB/s", "level": 0.25 })
        );
    }

    #[test]
    fn sit_state_serialises_to_the_documented_shape() {
        let seated = payload(SitState { sitting: true, object_id: "abc".into(), error: None });
        assert_eq!(seated, json!({ "sitting": true, "objectId": "abc" }));
        let standing = payload(SitState { sitting: false, object_id: String::new(), error: None });
        assert_eq!(standing, json!({ "sitting": false, "objectId": "" }));
    }

    #[test]
    fn sit_state_carries_a_refusal_reason_only_when_there_is_one() {
        // A refused sit adds the field; the ordinary updates above must not,
        // or every stand would look like a failure to the interface.
        let refused = payload(SitState {
            sitting: false,
            object_id: String::new(),
            error: Some("Could not sit there.".into()),
        });
        assert_eq!(
            refused,
            json!({ "sitting": false, "objectId": "", "error": "Could not sit there." })
        );
    }
}
