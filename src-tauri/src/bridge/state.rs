//! Shared application state managed by Tauri.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::bridge::circuit::Session;
use crate::codec::template::{build_registry, Registry};

pub struct AppState {
    /// Shared client for login / map / destinations (follows redirects).
    pub http: reqwest::Client,
    /// Parsed message template, shared with circuit reader tasks.
    pub registry: Arc<Registry>,
    /// Active UDP circuits keyed by opaque session id.
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// EventQueueGet single-flight lanes keyed by (url, agentSessionId).
    pub eq_lanes: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    pub ua: String,
    pub version: Value,
}

/// Build the version payload + user-agent from Tauri's package info, which is
/// sourced from `tauri.conf.json` (`productName` = channel, `version` = semver).
/// This is the single source of truth; there is no separate version.json.
/// `build` is an optional 4th component carried as semver build metadata.
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
            eq_lanes: AsyncMutex::new(HashMap::new()),
            ua,
            version,
        })
    }

    /// Acquire (creating if needed) the single-flight lane for an EventQueue poll.
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
}
