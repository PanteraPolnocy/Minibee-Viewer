// GENERATED FILE - DO NOT EDIT.
//
// Produced from the Rust payload structs in src-tauri/src/bridge/events.rs by
// `npm run types:sync`. Edit the Rust structs, not this file: they are what the
// core actually serialises, which is the whole reason these types can be
// trusted. Declared globally because the frontend files are scripts, not
// modules - no import needed to use them.

/**
 * Throughput for the top-bar traffic meter (`net-rate`).
 *
 * `label` and `level` are computed here rather than in the interface so the
 * formatting rules and the log scale live with the numbers they describe.
 */
type NetRate = { 
/**
 * Bytes per second inbound, averaged over the tick.
 */
inBps: number, 
/**
 * Bytes per second outbound, averaged over the tick.
 */
outBps: number, 
/**
 * Ready-to-display summary, e.g. "↓ 1.5 KB/s  ↑ 320 B/s".
 */
label: string, 
/**
 * Log-scaled 0..1 fill for the meter bar.
 */
level: number, };

/**
 * Whether the avatar is seated, and on what (`sit-state`).
 */
type SitState = { sitting: boolean, 
/**
 * The object sat on, or empty when standing.
 */
objectId: string, };
