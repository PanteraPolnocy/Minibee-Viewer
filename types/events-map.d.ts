// Which generated payload belongs to which event name.
//
// This index is the one hand-written link in the chain, and deliberately so:
// it holds nothing but a name-to-type mapping. The *shapes* still come from
// the Rust structs (see types/bee-ipc.d.ts, generated from
// src-tauri/src/bridge/events.rs), so this file cannot drift about what a
// payload contains - only about which event carries it, which is a single
// obvious line to read.
//
// Events absent from this map still work; their handler payload is `any`.
// Add a line here as each event's payload gains a Rust struct.

interface BeeEventMap {
  'net-rate': NetRate;
  'sit-state': SitState;
}

/** Event names that carry a generated, checked payload type. */
type BeeTypedEvent = keyof BeeEventMap;
