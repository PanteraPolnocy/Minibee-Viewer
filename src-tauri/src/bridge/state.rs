//! Shared application state that Tauri manages for us.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use md5::{Digest, Md5};
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::bridge::circuit::Session;
use crate::codec::template::{build_registry, Registry};

/// Holds the login payload we need for auto-reconnect. That payload includes
/// the account password, so it is never kept as plaintext in the process: it is
/// XOR-obfuscated with a keystream derived from a per-run random key, so a
/// casual memory dump / `strings` scan cannot recover the password. This is
/// obfuscation, not a defence against a determined reverse-engineer - any
/// in-process secret has to be recoverable by the process itself - but it keeps
/// the credential from lingering in cleartext for the app's lifetime.
pub struct SecretStore {
    key: Vec<u8>,
    blob: Mutex<Option<Vec<u8>>>,
}

impl SecretStore {
    pub fn new() -> Self {
        // Seed a 32-byte key from the OS-randomised hasher; RandomState pulls
        // per-process entropy from the platform RNG, so we need no extra crypto crates.
        let mut key = Vec::with_capacity(32);
        while key.len() < 32 {
            let n = RandomState::new().build_hasher().finish();
            key.extend_from_slice(&n.to_ne_bytes());
        }
        key.truncate(32);
        SecretStore { key, blob: Mutex::new(None) }
    }

    fn keystream(&self, len: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(len + 16);
        let mut counter: u64 = 0;
        while out.len() < len {
            let mut h = Md5::new();
            h.update(&self.key);
            h.update(counter.to_be_bytes());
            out.extend_from_slice(&h.finalize());
            counter += 1;
        }
        out.truncate(len);
        out
    }

    fn xor(&self, data: &[u8]) -> Vec<u8> {
        let ks = self.keystream(data.len());
        data.iter().zip(ks.iter()).map(|(b, k)| b ^ k).collect()
    }

    /// Stash the login payload (obfuscated) so we can reconnect later.
    pub fn stash(&self, payload: &Value) {
        let bytes = serde_json::to_vec(payload).unwrap_or_default();
        *self.blob.lock().unwrap() = Some(self.xor(&bytes));
    }

    /// Recover the stored login payload, if we have one.
    pub fn reveal(&self) -> Option<Value> {
        let guard = self.blob.lock().unwrap();
        let enc = guard.as_ref()?;
        serde_json::from_slice(&self.xor(enc)).ok()
    }

    /// Zero out and drop the stored credential; called on logout.
    pub fn clear(&self) {
        let mut guard = self.blob.lock().unwrap();
        if let Some(b) = guard.as_mut() {
            for x in b.iter_mut() {
                *x = 0;
            }
        }
        *guard = None;
    }
}

impl Default for SecretStore {
    fn default() -> Self {
        Self::new()
    }
}

pub struct AppState {
    /// Shared client for destination and map lookups against fixed Linden hosts;
    /// this one follows redirects. Caller-supplied targets (login, map tiles)
    /// instead build a per-request, no-redirect client pinned to the guard-validated IP.
    pub http: reqwest::Client,
    /// The parsed message template, shared with the circuit reader tasks.
    pub registry: Arc<Registry>,
    /// Live UDP circuits, keyed by opaque session id.
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// The engine circuit UI commands act on; there is only ever one active login.
    pub active_session: Mutex<Option<String>>,
    /// Single-flight lanes for EventQueueGet, keyed by (url, agentSessionId).
    pub eq_lanes: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    pub ua: String,
    pub version: Value,
    /// Obfuscated login payload for auto-reconnect. We fill it in on every
    /// successful login, regardless of the UI setting, so the user can turn
    /// auto-reconnect on mid-session and have it work; the setting only decides
    /// whether the cached payload is *used* on disconnect. Cleared on explicit logout.
    pub creds: SecretStore,
    /// Whether a window-close should be intercepted to confirm the logout first.
    /// The frontend sets this true while a session is live and false otherwise, so
    /// the login screen (and a close the user already confirmed) still closes immediately.
    pub close_guard: AtomicBool,
    /// Armed only when the user genuinely triggers the window's close control.
    /// `confirm_close` refuses to quit unless this is set, so no other code path
    /// (say, a malicious in-world link) can close the app.
    pub close_pending: AtomicBool,
}

/// Build the version payload and user-agent string from Tauri package info.
pub fn version_payload(channel: &str, major: u64, minor: u64, patch: u64, build: u64) -> (Value, String) {
    let mut ver_str = format!("{}.{}.{}", major, minor, patch);
    if build > 0 {
        ver_str.push_str(&format!(".{}", build));
    }
    let ua = format!("SecondLife/{} ({}; Minibee Viewer)", ver_str, channel);
    let payload = json!({
        "channel": channel,
        "version": ver_str,
        "major": major,
        "minor": minor,
        "patch": patch,
        "build": build,
    });
    (payload, ua)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_payload_without_build() {
        let (payload, ua) = version_payload("Minibee-Viewer", 1, 2, 3, 0);
        assert_eq!(payload["version"], "1.2.3");
        assert_eq!(payload["channel"], "Minibee-Viewer");
        assert_eq!(payload["major"], 1);
        assert_eq!(payload["build"], 0);
        assert_eq!(ua, "SecondLife/1.2.3 (Minibee-Viewer; Minibee Viewer)");
    }

    #[test]
    fn secret_store_roundtrips_and_clears() {
        let store = SecretStore::new();
        assert!(store.reveal().is_none());
        let payload = json!({ "username": "ann.lee", "password": "s3cr3t!", "grid": "agni" });
        store.stash(&payload);
        // The stored blob must never contain the raw plaintext password bytes.
        {
            let blob = store.blob.lock().unwrap();
            let enc = blob.as_ref().unwrap();
            let needle = b"s3cr3t!";
            let plaintext_present = enc.windows(needle.len()).any(|w| w == needle);
            assert!(!plaintext_present, "password stored in cleartext");
        }
        assert_eq!(store.reveal().unwrap(), payload);
        store.clear();
        assert!(store.reveal().is_none());
    }

    #[test]
    fn version_payload_with_build_metadata() {
        let (payload, ua) = version_payload("Minibee-Viewer", 1, 2, 3, 456);
        assert_eq!(payload["version"], "1.2.3.456");
        assert!(ua.contains("SecondLife/1.2.3.456"));
    }
}

impl AppState {
    pub fn new(version: Value, ua: String) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .user_agent(&ua)
            .gzip(true)
            .build()
            .expect("failed to build reqwest client");
        Arc::new(AppState {
            http,
            registry: Arc::new(build_registry()),
            sessions: Mutex::new(HashMap::new()),
            active_session: Mutex::new(None),
            eq_lanes: AsyncMutex::new(HashMap::new()),
            ua,
            version,
            creds: SecretStore::new(),
            close_guard: AtomicBool::new(false),
            close_pending: AtomicBool::new(false),
        })
    }

    /// Get the single-flight lane for an EventQueue poll, creating it if needed.
    pub async fn eq_lane(&self, key: &str) -> Arc<AsyncMutex<()>> {
        let mut lanes = self.eq_lanes.lock().await;
        lanes
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    pub fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    /// The engine circuit that UI commands operate on.
    pub fn active(&self) -> Option<Arc<Session>> {
        let id = self.active_session.lock().unwrap().clone()?;
        self.session(&id)
    }
}
