//! SL UDP circuit: one bound socket per session, a background reader that
//! relays each datagram to the frontend as `minibee-viewer://packet-raw` (after
//! filtering out high-frequency floods the UI never uses), plus an inbound HTTP
//! listener for trusted messages (e.g. `AgentGroupDataUpdate`, surfaced as
//! `minibee-viewer://http-message`).
//!
//! The frontend sends with `sl_send_raw` (pre-encoded bytes) or `sl_send`
//! (encode by message name from the template). Reliability/acks are driven by
//! the frontend so there is a single owner of sequence/ack state.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};
use tokio::task::JoinHandle;

use crate::codec;
use crate::codec::template::Registry;

pub struct Session {
    pub udp: Arc<UdpSocket>,
    pub target: Mutex<SocketAddr>,
    pub local_port: u16,
    seq: AtomicU32,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Session {
    fn next_seq(&self) -> u32 {
        self.seq.fetch_add(1, Ordering::SeqCst)
    }

    pub async fn send_bytes(&self, bytes: &[u8]) -> usize {
        let addr = *self.target.lock().unwrap();
        self.udp.send_to(bytes, addr).await.unwrap_or(0)
    }

    /// Encode a message by template name and send it. Sequence numbering is
    /// local; reliability (resend) is the frontend's responsibility.
    pub async fn send_message(
        &self,
        reg: &Registry,
        name: &str,
        blocks: &Value,
        reliable: bool,
    ) -> Option<(u32, usize)> {
        let seq = self.next_seq();
        let flags = if reliable { codec::FLAG_RELIABLE } else { 0 };
        let bytes = codec::encode(reg, name, blocks, seq, flags)?;
        let sent = self.send_bytes(&bytes).await;
        Some((seq, sent))
    }

    pub fn retarget(&self, addr: SocketAddr) {
        *self.target.lock().unwrap() = addr;
    }

    pub fn sim_ip(&self) -> String {
        self.target.lock().unwrap().ip().to_string()
    }

    pub fn close(&self) {
        for t in self.tasks.lock().unwrap().drain(..) {
            t.abort();
        }
    }
}

fn now_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:032x}", nanos ^ ((c as u128) << 96))
}

fn parse_addr(ip: &str, port: u16) -> Option<SocketAddr> {
    format!("{}:{}", ip, port).parse().ok()
}

/// High-frequency inbound messages the UI never consumes (no 3D world). These
/// are single-byte message ids that sit at offset 6; they are dropped only when
/// unreliable, so a needed ack is never skipped.
const IGNORED_HIGH_FREQ: &[u8] = &[
    11, // LayerData
    12, // ObjectUpdate
    13, // ObjectUpdateCompressed
    14, // ObjectUpdateCached
    15, // ImprovedTerseObjectUpdate
    16, // KillObject
    20, // AvatarAnimation
    29, // SoundTrigger
    30, // ObjectAnimation
];

/// Medium-frequency inbound messages the UI never uses (encoded as `0xFF <n>`
/// at offset 6-7). These also spike with many avatars around (gesture/typing
/// beams, object property pushes, attached sounds). CoarseLocationUpdate (6,
/// radar) and CrossedRegion/ConfirmEnableSimulator (7/8, teleport) are kept.
const IGNORED_MEDIUM_FREQ: &[u8] = &[
    9,  // ObjectProperties
    10, // ObjectPropertiesFamily
    13, // AttachedSound
    14, // AttachedSoundGainChange
    15, // PreloadSound
    17, // ViewerEffect
];

/// Open a new circuit toward `sim_ip:sim_port`, spawning its background tasks.
/// Returns `(session_id, session, local_port)`.
pub async fn open(
    app: AppHandle,
    sim_ip: &str,
    sim_port: u16,
) -> Result<(String, Arc<Session>, u16), String> {
    let target = parse_addr(sim_ip, sim_port).ok_or("Invalid sim_ip or sim_port")?;
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("socket bind failed: {e}"))?;
    let local_port = socket.local_addr().map(|a| a.port()).unwrap_or(0);
    let udp = Arc::new(socket);

    let session = Arc::new(Session {
        udp: udp.clone(),
        target: Mutex::new(target),
        local_port,
        seq: AtomicU32::new(1),
        tasks: Mutex::new(Vec::new()),
    });
    let session_id = now_id();

    let reader = spawn_reader(app.clone(), session.clone(), session_id.clone());
    let http = spawn_http_listener(app, session_id.clone(), local_port);
    {
        let mut tasks = session.tasks.lock().unwrap();
        tasks.push(reader);
        tasks.push(http);
    }

    Ok((session_id, session, local_port))
}

fn spawn_reader(app: AppHandle, session: Arc<Session>, session_id: String) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65535];
        loop {
            let (n, _from) = match session.udp.recv_from(&mut buf).await {
                Ok(v) => v,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    continue;
                }
            };
            let datagram = &buf[..n];

            // Cheap pre-filter: drop object/layer/sound/effect updates the UI never
            // uses before they cross the IPC boundary. Only when the packet is
            // unreliable (bit 0x40 clear) with no extra header, so a needed ack is
            // never skipped and the message id sits at offset 6. High-frequency ids
            // are a single byte; medium-frequency are `0xFF <n>`.
            if datagram.len() >= 7 && datagram[0] & codec::FLAG_RELIABLE == 0 && datagram[5] == 0 {
                let b6 = datagram[6];
                if b6 != 0xFF {
                    if IGNORED_HIGH_FREQ.contains(&b6) {
                        continue;
                    }
                } else if datagram.len() >= 8
                    && datagram[7] != 0xFF
                    && IGNORED_MEDIUM_FREQ.contains(&datagram[7])
                {
                    continue;
                }
            }

            // Raw relay: the frontend's codec decodes and routes this.
            let _ = app.emit(
                "minibee-viewer://packet-raw",
                json!({ "sessionId": session_id, "packet": B64.encode(datagram) }),
            );
        }
    })
}

static HTTP_MSG_PATH: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)/(?:trusted-message|message)/([^/?]+)").unwrap());

fn spawn_http_listener(app: AppHandle, session_id: String, port: u16) -> JoinHandle<()> {
    tokio::spawn(async move {
        let listener = match TcpListener::bind(("0.0.0.0", port)).await {
            Ok(l) => l,
            Err(_) => return, // inbound trusted-message delivery unavailable; not fatal
        };
        loop {
            let (mut stream, _peer) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => continue,
            };
            let app = app.clone();
            let session_id = session_id.clone();
            tokio::spawn(async move {
                let mut data = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    match stream.read(&mut chunk).await {
                        Ok(0) => break,
                        Ok(n) => {
                            data.extend_from_slice(&chunk[..n]);
                            if let Some(total) = request_complete_len(&data) {
                                if data.len() >= total {
                                    break;
                                }
                            }
                            if data.len() > 1_048_576 {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                if let Some((name, body, content_type)) = parse_trusted_message(&data) {
                    let _ = app.emit(
                        "minibee-viewer://http-message",
                        json!({
                            "sessionId": session_id,
                            "name": name,
                            "body": body,
                            "contentType": content_type,
                        }),
                    );
                }
                let response = concat!(
                    "HTTP/1.1 200 OK\r\n",
                    "Content-Type: application/llsd+xml\r\n",
                    "Content-Length: 25\r\n",
                    "Connection: close\r\n\r\n",
                    "<llsd><map></map></llsd>\n"
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    })
}

/// Total request length (headers + body) once the Content-Length is known.
fn request_complete_len(data: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(data);
    let hdr_end = text.find("\r\n\r\n")?;
    let body_start = hdr_end + 4;
    let head = &text[..hdr_end];
    let mut content_length = 0usize;
    for line in head.lines() {
        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = rest.trim().parse().unwrap_or(0);
        }
    }
    Some(body_start + content_length)
}

fn parse_trusted_message(data: &[u8]) -> Option<(String, String, String)> {
    let text = String::from_utf8_lossy(data);
    let hdr_end = text.find("\r\n\r\n")?;
    let head = &text[..hdr_end];
    let body = text[hdr_end + 4..].to_string();
    let request_line = head.lines().next()?;
    if !request_line.to_ascii_uppercase().starts_with("POST ") {
        return None;
    }
    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    let name = HTTP_MSG_PATH
        .captures(path)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())?;
    if body.is_empty() {
        return None;
    }
    let mut content_type = "application/llsd+xml".to_string();
    for line in head.lines() {
        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-type:") {
            content_type = rest.trim().to_string();
        }
    }
    Some((name, body, content_type))
}
