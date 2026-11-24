//! Earlier messages of a private conversation, as the grid keeps them.
//!
//! The region's `PersistentChatHistoryRequest` capability hands back the
//! newest messages exchanged with a resident, whichever device they were
//! written or read on. A private conversation opens with them above its live
//! lines - for a resident who keeps chat logs of people; without that switch
//! nothing is asked for (see `session::grid_history`).
//!
//! Nothing read here is ever written to the chat logs. The logs record what
//! this device saw as it happened, each message once; a second source of the
//! same messages written into them is how a log comes to say everything
//! twice. What the service returns is shown and then forgotten.
//!
//! The service keeps every message, the ones of this login among them, and
//! those already stand in the conversation as live lines. `Threads` is the
//! core's record of what stands there. A page is checked against it before
//! anything is handed over, so a message is never shown both as history and
//! as a live line; and a message that arrives after its stored copy was
//! handed over names that copy, for the interface to take away.
//!
//! When to ask is decided here as well: once a login for each conversation,
//! a failed attempt is not repeated for a while, and requests to the service
//! take turns. The interface only says that a conversation was opened.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

use crate::bridge::inventory;
use crate::bridge::proxy;
use crate::bridge::session::SessionState;
use crate::bridge::state::AppState;
use crate::codec;

type Cmd = Result<Value, String>;

const HISTORY_CAP: &str = "PersistentChatHistoryRequest";

/// The size of a page: the one the service hands out and the only one it is
/// asked for.
const PAGE_ROWS: usize = 100;

/// The service wants its requests no closer together than this.
const SPACING: Duration = Duration::from_millis(2100);

/// After it answers "too many requests", nothing is asked for this long.
const COOL_DOWN: Duration = Duration::from_secs(120);

/// A request whose turn is further off than this is not made at all: the
/// conversation opens with what the device has, and asks again another time.
const MAX_WAIT: Duration = Duration::from_secs(15);

/// How long the service is given to answer.
const ANSWER_WAIT: Duration = Duration::from_secs(30);

/// A conversation whose history could not be had is not asked about again
/// sooner than this. Longer than a request can take from start to finish
/// (`MAX_WAIT` and `ANSWER_WAIT`), so it also keeps a second request for the
/// same conversation from starting while the first is still out.
const RETRY_AFTER_MS: u64 = 60_000;

/// A message of the service is at most this long; anything longer is not one.
const MAX_MESSAGE_CHARS: usize = 1024;

/// 100-nanosecond ticks from the UUID epoch (15 October 1582) to the Unix one.
const UUID_EPOCH_TICKS: u64 = 122_192_928_000_000_000;

/// The kinds of stored message that are conversation: a plain instant
/// message, and the automatic reply of someone who is busy. The service also
/// keeps offers and invitations sent between the two; those were prompts
/// with buttons, and a line of text is no substitute for one.
const CONVERSATION_DIALOGS: [i64; 2] = [0, 20];

/// How many live lines of one conversation are remembered: as many as the
/// interface keeps on screen.
const LINES_PER_THREAD: usize = 1000;

/// How many conversations are remembered at once. Far more than a login
/// sees; past it the one that has been quiet longest is forgotten.
const MAX_THREADS: usize = 512;

/// A stored message and a live line that say the same thing, the same way
/// round, are one message when they are dated within this of each other. The
/// two dates come from different clocks - the service's and this device's -
/// so the margin has to cover a device whose clock is off.
const STANDING_WINDOW_MS: u64 = 60 * 60 * 1000;

/// The same, for a line that arrives after the history was handed over. Only
/// a message that was already on its way can have a stored copy in that
/// page, so the two are close together; anything further apart is somebody
/// saying the same thing again.
const LATE_WINDOW_MS: u64 = 2 * 60 * 1000;

/// When the next request to the service may go out. Requests take turns, so
/// that several conversations opening at once do not arrive as a burst.
static NEXT_TURN: Lazy<AsyncMutex<Instant>> = Lazy::new(|| AsyncMutex::new(Instant::now()));

/// One stored message of a private conversation.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    /// The service's id for the message: a version-1 UUID, which dates it.
    pub id: String,
    /// What the service orders messages by: the id's time, then its tail.
    key: (u64, [i8; 8]),
    pub from_id: String,
    pub from_name: String,
    pub text: String,
    /// When the message was stored, in Unix milliseconds (from the id).
    pub at_ms: u64,
    /// Written by this account rather than by the other resident.
    pub outgoing: bool,
}

/// A line standing in a private conversation: something said in this login.
#[derive(Debug, Clone, PartialEq)]
struct Line {
    outgoing: bool,
    at_ms: u64,
    text: String,
}

/// A stored message the interface is showing as history.
#[derive(Debug, Clone, PartialEq)]
struct Shown {
    id: String,
    outgoing: bool,
    at_ms: u64,
    text: String,
}

/// What the core knows of one private conversation.
#[derive(Debug, Default, Clone, PartialEq)]
struct Thread {
    /// The live lines, oldest first.
    lines: VecDeque<Line>,
    /// The history the interface was handed and has not been told to drop.
    shown: Vec<Shown>,
    /// The history was handed over; it is not asked for again this login.
    handed: bool,
    /// When it was last asked for, in Unix milliseconds.
    tried_at: Option<u64>,
}

impl Thread {
    /// When something last happened here, for telling the quiet ones apart.
    fn last_touched(&self) -> u64 {
        let said = self.lines.back().map_or(0, |line| line.at_ms);
        said.max(self.tried_at.unwrap_or(0))
    }
}

/// The private conversations of this login, by the other resident's id: what
/// stands in each as live lines, and what each was handed as history. Kept
/// with the session; a reconnect, which keeps its conversations on screen,
/// carries it over to the session that follows.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Threads {
    by_peer: HashMap<String, Thread>,
}

/// Two texts that are the same message: the service may store a message
/// without the blanks around it.
fn same_words(a: &str, b: &str) -> bool {
    a.trim() == b.trim()
}

impl Threads {
    fn thread(&mut self, peer: &str) -> &mut Thread {
        let key = peer.trim().to_ascii_lowercase();
        if !self.by_peer.contains_key(&key) && self.by_peer.len() >= MAX_THREADS {
            let quietest = self.by_peer.iter().min_by_key(|(_, t)| t.last_touched()).map(|(k, _)| k.clone());
            if let Some(quietest) = quietest {
                self.by_peer.remove(&quietest);
            }
        }
        self.by_peer.entry(key).or_default()
    }

    /// A line was said in the private conversation with `peer`, by them or
    /// (`outgoing`) by this account, and stands there from now on. When the
    /// other resident's line is one the interface is already showing as
    /// history - its stored copy arrived first - the answer is that copy's
    /// id, and it is no longer counted as shown.
    pub fn said(&mut self, peer: &str, outgoing: bool, at_ms: u64, text: &str) -> Option<String> {
        if text.trim().is_empty() {
            return None;
        }
        let thread = self.thread(peer);
        let copy = if outgoing {
            // What this account writes goes out from here and is in no page
            // fetched before it was written.
            None
        } else {
            thread
                .shown
                .iter()
                .enumerate()
                .filter(|(_, s)| !s.outgoing && same_words(&s.text, text) && s.at_ms.abs_diff(at_ms) <= LATE_WINDOW_MS)
                .min_by_key(|(_, s)| s.at_ms.abs_diff(at_ms))
                .map(|(i, _)| i)
        };
        let superseded = copy.map(|i| thread.shown.remove(i).id);
        thread.lines.push_back(Line { outgoing, at_ms, text: text.to_string() });
        while thread.lines.len() > LINES_PER_THREAD {
            thread.lines.pop_front();
        }
        superseded
    }

    /// Whether the history of the conversation with `peer` is to be asked
    /// for now, and if so, that it is being asked for. The refusals: "done"
    /// when it was handed over this login, "wait" when an attempt was made a
    /// moment ago.
    pub fn begin(&mut self, peer: &str, now_ms: u64) -> Result<(), &'static str> {
        let thread = self.thread(peer);
        if thread.handed {
            return Err("done");
        }
        if thread.tried_at.is_some_and(|at| now_ms.saturating_sub(at) < RETRY_AFTER_MS) {
            return Err("wait");
        }
        thread.tried_at = Some(now_ms);
        Ok(())
    }

    /// The page for the conversation with `peer` arrived: what of it is
    /// shown as history. Each live line takes away one stored message that
    /// says the same thing, the same way round, at about the same time - its
    /// own copy - the nearest in time first, so that somebody who said "ok"
    /// yesterday and again today keeps yesterday's in the history.
    pub fn hand_over(&mut self, peer: &str, rows: Vec<Row>) -> Vec<Row> {
        let thread = self.thread(peer);
        let mut standing = vec![false; rows.len()];
        for line in thread.lines.iter().rev() {
            let own = rows
                .iter()
                .enumerate()
                .filter(|(i, row)| {
                    !standing[*i]
                        && row.outgoing == line.outgoing
                        && same_words(&row.text, &line.text)
                        && row.at_ms.abs_diff(line.at_ms) <= STANDING_WINDOW_MS
                })
                .min_by_key(|(_, row)| row.at_ms.abs_diff(line.at_ms))
                .map(|(i, _)| i);
            if let Some(i) = own {
                standing[i] = true;
            }
        }
        let kept: Vec<Row> = rows.into_iter().zip(standing).filter(|(_, gone)| !gone).map(|(row, _)| row).collect();
        thread.handed = true;
        thread.shown = kept
            .iter()
            .map(|row| Shown { id: row.id.clone(), outgoing: row.outgoing, at_ms: row.at_ms, text: row.text.clone() })
            .collect();
        kept
    }
}

impl SessionState {
    /// Whether the history of the private conversation with `peer` is to be
    /// asked for now (see `Threads::begin`). Nothing is fetched about a
    /// blocked resident: their words are not shown as they arrive, and are
    /// not brought back as history either.
    pub(crate) fn im_history_begin(&mut self, peer: &str, now_ms: u64) -> Result<(), &'static str> {
        if self.is_muted_text(peer) {
            return Err("blocked");
        }
        self.im_threads.begin(peer, now_ms)
    }

    /// The page of the conversation with `peer` as the interface is to show
    /// it: less what already stands there as live lines, each row under the
    /// name the rest of the viewer knows its writer by, its words on one
    /// line the way a chat log holds them. `me` is the account the page was
    /// asked for; a session that has since become another account's, or a
    /// resident blocked while the answer was on its way, gets nothing.
    pub(crate) fn im_history_hand_over(&mut self, me: &str, peer: &str, rows: Vec<Row>) -> Result<Vec<Value>, &'static str> {
        if !same_id(&self.agent_id, me) {
            return Err("no-session");
        }
        if self.is_muted_text(peer) {
            return Err("blocked");
        }
        let kept = self.im_threads.hand_over(peer, rows);
        Ok(kept
            .iter()
            .map(|row| {
                let name = self
                    .cached_name(&row.from_id)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .unwrap_or(&row.from_name);
                json!({
                    "id": row.id,
                    "fromId": row.from_id,
                    "fromName": name,
                    "text": crate::chatlogs::one_line(row.text.trim()),
                    "timestamp": row.at_ms,
                    "outgoing": row.outgoing,
                })
            })
            .collect())
    }
}

/// The id the service files a private conversation under: the two agent ids
/// in their canonical lowercase form, the lower one first.
pub fn conversation_id(a: &str, b: &str) -> String {
    let (a, b) = (a.trim().to_ascii_lowercase(), b.trim().to_ascii_lowercase());
    if a < b {
        format!("{a}_{b}")
    } else {
        format!("{b}_{a}")
    }
}

/// A UUID in the one spelling the service uses, or nothing.
fn canonical_uuid(text: &str) -> Option<&str> {
    let ok = inventory::is_uuid(text) && !text.bytes().any(|b| b.is_ascii_uppercase());
    ok.then_some(text)
}

/// The sixteen bytes of a canonical UUID.
fn uuid_bytes(id: &str) -> Option<[u8; 16]> {
    let hex: Vec<u8> = id.bytes().filter(|b| *b != b'-').collect();
    if hex.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, pair) in hex.chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(out)
}

/// What a version-1 UUID is ordered by, and the moment it was made: its
/// 60-bit count of 100-nanosecond ticks, and its last eight bytes compared
/// as signed values where two ids share a tick. Nothing for any other kind
/// of UUID - a random one says nothing about time.
fn time_uuid(id: &str) -> Option<(u64, [i8; 8])> {
    let b = uuid_bytes(canonical_uuid(id)?)?;
    if b[6] >> 4 != 1 || b[8] & 0xc0 != 0x80 {
        return None;
    }
    let low = u64::from(u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    let mid = u64::from(u16::from_be_bytes([b[4], b[5]]));
    let high = u64::from(u16::from_be_bytes([b[6] & 0x0f, b[7]]));
    let ticks = (high << 48) | (mid << 32) | low;
    let mut tail = [0i8; 8];
    for (i, byte) in b[8..].iter().enumerate() {
        tail[i] = *byte as i8;
    }
    Some((ticks, tail))
}

fn same_id(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// The messages on one page of the service's answer, oldest first: plain
/// conversation only, each from one of the two parties, each with an id that
/// dates it. An answer for another conversation, or one that is not the
/// shape the service has, yields nothing at all; a single row that does not
/// hold up is left out and the others stand.
pub fn parse_page(page: &Value, me: &str, peer: &str) -> Option<Vec<Row>> {
    let wanted = conversation_id(me, peer);
    if let Some(echoed) = page.get("conversation_id").and_then(|v| v.as_str()) {
        if echoed != wanted {
            return None;
        }
    }
    let messages = page.get("messages")?.as_array()?;
    let mut seen = HashSet::new();
    let mut rows: Vec<Row> = messages
        .iter()
        .take(PAGE_ROWS)
        .filter_map(|m| {
            let id = m.get("msg_id")?.as_str()?;
            let key = time_uuid(id)?;
            let from_id = canonical_uuid(m.get("from_id")?.as_str()?)?;
            let outgoing = same_id(from_id, me);
            if !outgoing && !same_id(from_id, peer) {
                return None;
            }
            if let Some(conversation) = m.get("conversation_id").and_then(|v| v.as_str()) {
                if conversation != wanted {
                    return None;
                }
            }
            // A row without a kind is taken for a plain message.
            let dialog = m.get("dialog").map_or(Some(0), |d| d.as_i64())?;
            if !CONVERSATION_DIALOGS.contains(&dialog) {
                return None;
            }
            let text = m.get("message")?.as_str()?;
            if text.trim().is_empty() || text.chars().count() > MAX_MESSAGE_CHARS {
                return None;
            }
            let at_ms = key.0.checked_sub(UUID_EPOCH_TICKS)? / 10_000;
            Some(Row {
                id: id.to_string(),
                key,
                from_id: from_id.to_string(),
                from_name: m.get("from_name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
                text: text.to_string(),
                at_ms,
                outgoing,
            })
        })
        .filter(|row| seen.insert(row.id.clone()))
        .collect();
    rows.sort_by(|a, b| a.key.cmp(&b.key));
    Some(rows)
}

/// The body of a request for the newest page of a conversation.
fn request_body(conversation: &str) -> String {
    format!(
        "<?xml version=\"1.0\"?><llsd><map>\
         <key>conversation_id</key><string>{}</string>\
         <key>limit</key><integer>{PAGE_ROWS}</integer>\
         </map></llsd>",
        inventory::xml_escape(conversation)
    )
}

/// Waits for this request's turn. False when the turn is too far off to wait
/// for - the service has asked for a pause, or a queue has built up.
async fn take_turn() -> bool {
    let slot = {
        let mut next = NEXT_TURN.lock().await;
        let now = Instant::now();
        let slot = (*next).max(now);
        if slot.duration_since(now) > MAX_WAIT {
            return false;
        }
        *next = slot + SPACING;
        slot
    };
    tokio::time::sleep_until(tokio::time::Instant::from_std(slot)).await;
    true
}

/// The service said "too many requests": nobody asks again for a while.
async fn cool_down() {
    let mut next = NEXT_TURN.lock().await;
    *next = (*next).max(Instant::now() + COOL_DOWN);
}

/// An answer that is no history, with the reason for the diagnostic log and
/// the tests. The interface treats every one of them alike: the conversation
/// keeps the history it has from the device.
fn none(reason: &str) -> Cmd {
    Ok(json!({ "ok": false, "reason": reason }))
}

/// The earlier messages of the private conversation with `agent_id`, as the
/// grid keeps them: up to a page of the newest, oldest first, without the
/// ones that already stand in the conversation as live lines. The interface
/// calls this whenever a private conversation is opened; whether anything is
/// asked of the grid is decided here. Best effort - anything in the way (the
/// switch off, the history already handed over, the region not offering the
/// service, a blocked resident, the service busy or failing) answers
/// `ok: false` rather than an error, and the conversation stays as it is.
#[tauri::command]
pub async fn sl_im_history(state: State<'_, Arc<AppState>>, agent_id: String) -> Cmd {
    if !crate::bridge::session::grid_history() {
        return none("off");
    }
    let Some(session) = state.active() else {
        return none("no-session");
    };
    let peer = agent_id.trim().to_ascii_lowercase();
    let Some((me, _)) = session.agent_ids() else {
        return none("no-session");
    };
    if !inventory::is_uuid(&peer) || inventory::is_zero_uuid(&peer) || same_id(&peer, &me) {
        return none("not-a-resident");
    }
    let Some(cap) = session.cap(HISTORY_CAP).filter(|url| !url.trim().is_empty()) else {
        return none("no-cap");
    };
    if let Err(reason) = session.im_history_begin(&peer) {
        return none(reason);
    }
    if !take_turn().await {
        return none("busy");
    }

    let body = request_body(&conversation_id(&me, &peer));
    let (pin, _) = proxy::simhost_pin(&cap, "").await;
    let ex = match proxy::exchange(
        &state.ua,
        "POST",
        &cap,
        &body,
        "application/llsd+xml",
        &[],
        pin,
        ANSWER_WAIT,
        true,
    )
    .await
    {
        Ok(ex) => ex,
        Err(e) => {
            crate::dlog!("chat history: request failed: {e}");
            return none("failed");
        }
    };
    if ex.status == 429 {
        crate::dlog!("chat history: the service asked for a pause");
        cool_down().await;
        return none("busy");
    }
    if !(200..300).contains(&ex.status) {
        crate::dlog!("chat history: HTTP {}", ex.status);
        return none("failed");
    }
    let Some(rows) = codec::llsd::parse(&ex.body, &ex.content_type)
        .ok()
        .and_then(|page| parse_page(&page, &me, &peer))
    else {
        crate::dlog!("chat history: the answer was not a page of this conversation");
        return none("failed");
    };
    // The answer took its time: the session may have been replaced by a
    // reconnect since, which carries the conversations over. Whichever
    // session is live now holds what stands in them.
    let Some(live) = state.active() else {
        return none("no-session");
    };
    let stored = rows.len();
    match live.im_history_hand_over(&me, &peer, rows) {
        Ok(rows) => {
            crate::dlog!("chat history: {stored} message(s) kept by the grid, {} shown", rows.len());
            Ok(json!({ "ok": true, "rows": rows }))
        }
        Err(reason) => none(reason),
    }
}

/// A version-1 UUID made at `unix_ms`, with `n` in its tail to tell two made
/// in the same tick apart.
#[cfg(test)]
pub(crate) fn id_at(unix_ms: u64, n: u8) -> String {
    let ticks = unix_ms * 10_000 + UUID_EPOCH_TICKS;
    let low = (ticks & 0xffff_ffff) as u32;
    let mid = ((ticks >> 32) & 0xffff) as u16;
    let high = (((ticks >> 48) & 0x0fff) as u16) | 0x1000;
    format!("{low:08x}-{mid:04x}-{high:04x}-80{n:02x}-0123456789ab")
}

/// A stored message as a page yields it, for the tests of what the session
/// does with one.
#[cfg(test)]
pub(crate) fn stored_row(at_ms: u64, from_id: &str, outgoing: bool, text: &str) -> Row {
    let id = id_at(at_ms, 0);
    Row {
        key: time_uuid(&id).expect("a dated id"),
        id,
        from_id: from_id.to_string(),
        from_name: String::new(),
        text: text.to_string(),
        at_ms,
        outgoing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "11111111-1111-1111-1111-111111111111";
    const PEER: &str = "99999999-8888-7777-6666-555555555555";

    /// 2026-11-24 10:00:00 UTC.
    const T: u64 = 1_795_514_400_000;

    fn message(id: &str, from: &str, text: &str) -> Value {
        json!({
            "conversation_id": conversation_id(ME, PEER), "msg_id": id, "from_id": from,
            "from_name": "Some One", "message": text, "dialog": 0, "created_at": "2026-11-24T10:00:00Z",
        })
    }

    fn page(messages: Vec<Value>) -> Value {
        json!({ "conversation_id": conversation_id(ME, PEER), "limit": 100, "messages": messages })
    }

    /// The rows of a page holding one message for each (sent at, from, text).
    fn rows(messages: &[(u64, &str, &str)]) -> Vec<Row> {
        let list = messages.iter().map(|(at, from, text)| message(&id_at(*at, 0), from, text)).collect();
        parse_page(&page(list), ME, PEER).expect("a page")
    }

    fn texts(rows: &[Row]) -> Vec<&str> {
        rows.iter().map(|r| r.text.as_str()).collect()
    }

    #[test]
    fn a_conversation_is_filed_under_both_ids_lower_first() {
        assert_eq!(conversation_id(ME, PEER), format!("{ME}_{PEER}"));
        assert_eq!(conversation_id(PEER, ME), format!("{ME}_{PEER}"));
        // However the ids were spelled on the way in.
        assert_eq!(conversation_id(&PEER.to_uppercase(), &format!(" {ME} ")), format!("{ME}_{PEER}"));
    }

    #[test]
    fn a_message_id_gives_its_time_and_only_a_dated_one_does() {
        let (ticks, tail) = time_uuid(&id_at(T, 7)).expect("a version-1 id");
        assert_eq!((ticks - UUID_EPOCH_TICKS) / 10_000, T);
        assert_eq!(tail[1], 7);
        // A tail byte with its top bit set compares as negative, the way the
        // service orders two ids of the same tick.
        let (_, high_tail) = time_uuid("00000001-0000-1000-80ff-0123456789ab").unwrap();
        assert_eq!(high_tail[1], -1);
        // A random (version-4) id, a malformed one and an uppercase spelling date nothing.
        assert!(time_uuid("11111111-1111-4111-8111-111111111111").is_none());
        assert!(time_uuid("not-an-id").is_none());
        assert!(time_uuid(&id_at(T, 7).to_uppercase()).is_none());
        // Nor does one whose variant is not the standard layout.
        assert!(time_uuid("00000001-0000-1000-00ff-0123456789ab").is_none());
    }

    #[test]
    fn a_page_comes_out_oldest_first_whatever_order_it_came_in() {
        // The service lists the newest first.
        let p = page(vec![
            message(&id_at(T + 3000, 0), PEER, "third"),
            message(&id_at(T + 2000, 0), ME, "second"),
            message(&id_at(T + 1000, 0), PEER, "first"),
        ]);
        let rows = parse_page(&p, ME, PEER).expect("a page");
        assert_eq!(texts(&rows), vec!["first", "second", "third"]);
        assert_eq!(rows[0].at_ms, T + 1000);
        assert_eq!(rows[1].from_id, ME);
        assert_eq!(rows[0].from_name, "Some One");
        // Which way round each went.
        assert_eq!(rows.iter().map(|r| r.outgoing).collect::<Vec<_>>(), vec![false, true, false]);
        // Two messages of the same tick keep the order of their tails.
        let same_tick = page(vec![message(&id_at(T, 2), PEER, "b"), message(&id_at(T, 1), PEER, "a")]);
        let rows = parse_page(&same_tick, ME, PEER).unwrap();
        assert_eq!(texts(&rows), vec!["a", "b"]);
    }

    #[test]
    fn rows_that_do_not_hold_up_are_left_out_and_the_rest_stand() {
        let stranger = "22222222-2222-2222-2222-222222222222";
        let mut offer = message(&id_at(T + 5000, 0), PEER, "A notecard");
        offer["dialog"] = json!(4);
        let mut busy = message(&id_at(T + 6000, 0), PEER, "I am busy.");
        busy["dialog"] = json!(20);
        let mut elsewhere = message(&id_at(T + 7000, 0), PEER, "for another conversation");
        elsewhere["conversation_id"] = json!(conversation_id(ME, stranger));
        let mut unkinded = message(&id_at(T + 8000, 0), PEER, "no kind given");
        unkinded.as_object_mut().unwrap().remove("dialog");
        let p = page(vec![
            message(&id_at(T + 1000, 0), PEER, "kept"),
            message(&id_at(T + 1000, 0), PEER, "the same id again"),
            message("11111111-1111-4111-8111-111111111111", PEER, "undated id"),
            message(&id_at(T + 2000, 0), stranger, "from somebody else"),
            message(&id_at(T + 3000, 0), PEER, "   "),
            message(&id_at(T + 4000, 0), PEER, &"x".repeat(MAX_MESSAGE_CHARS + 1)),
            offer,
            busy,
            elsewhere,
            unkinded,
            json!("not a message"),
        ]);
        let rows = parse_page(&p, ME, PEER).expect("a page");
        assert_eq!(texts(&rows), vec!["kept", "I am busy.", "no kind given"]);
    }

    #[test]
    fn an_answer_that_is_not_this_conversation_is_no_history() {
        let stranger = "22222222-2222-2222-2222-222222222222";
        // Another conversation's page, however good its rows.
        let mut other = page(vec![message(&id_at(T, 0), PEER, "hello")]);
        other["conversation_id"] = json!(conversation_id(ME, stranger));
        assert!(parse_page(&other, ME, PEER).is_none());
        // Not the shape of a page at all.
        assert!(parse_page(&json!({ "error": "nope" }), ME, PEER).is_none());
        assert!(parse_page(&json!({ "messages": "none" }), ME, PEER).is_none());
        assert!(parse_page(&json!([]), ME, PEER).is_none());
        // An empty page is a conversation with nothing kept: that is an answer.
        assert_eq!(parse_page(&page(vec![]), ME, PEER), Some(vec![]));
        // Only a page's worth is read, however much is sent.
        let many: Vec<Value> = (0..150u64).map(|i| message(&id_at(T + i, 0), PEER, "m")).collect();
        assert_eq!(parse_page(&page(many), ME, PEER).unwrap().len(), PAGE_ROWS);
    }

    #[test]
    fn the_request_names_the_conversation_and_the_page_size() {
        let body = request_body(&conversation_id(ME, PEER));
        assert!(body.contains(&format!("<key>conversation_id</key><string>{ME}_{PEER}</string>")));
        assert!(body.contains("<key>limit</key><integer>100</integer>"));
        let back = codec::llsd::parse(&body, "application/llsd+xml").unwrap();
        assert_eq!(back["limit"], 100);
        assert_eq!(back["conversation_id"], format!("{ME}_{PEER}"));
    }

    #[test]
    fn what_stands_in_the_conversation_is_not_shown_again_as_history() {
        const DAY: u64 = 24 * 60 * 60 * 1000;
        let mut threads = Threads::default();
        // This login so far: they said hello, this account answered, they said "ok".
        assert_eq!(threads.said(PEER, false, T + 1000, "hello"), None);
        assert_eq!(threads.said(PEER, true, T + 2000, "hi there"), None);
        assert_eq!(threads.said(PEER, false, T + 3000, "ok"), None);
        // The service has all three, and what came before them.
        let kept = threads.hand_over(
            PEER,
            rows(&[
                (T - DAY, PEER, "ok"),
                (T - DAY + 1000, ME, "see you tomorrow"),
                // Stored a moment after it was said, by the service's clock.
                (T + 1400, PEER, "hello"),
                (T + 2300, ME, "hi there"),
                (T + 3100, PEER, "ok"),
            ]),
        );
        // Yesterday's "ok" stays: today's line took its own copy, not that one.
        assert_eq!(texts(&kept), vec!["ok", "see you tomorrow"]);
        assert_eq!(kept[0].at_ms, T - DAY);
    }

    #[test]
    fn a_line_takes_away_one_copy_and_only_one_the_same_way_round() {
        let mut threads = Threads::default();
        // "ok" said once by them in this login.
        threads.said(PEER, false, T, "ok");
        let kept = threads.hand_over(
            PEER,
            rows(&[
                (T - 120_000, PEER, "ok"),
                (T - 60_000, ME, "ok"),
                (T + 500, PEER, " ok "),
            ]),
        );
        // The copy nearest in time goes - blanks around it or not; the
        // earlier "ok" of theirs and this account's own stay.
        assert_eq!(kept.iter().map(|r| (r.at_ms, r.outgoing)).collect::<Vec<_>>(), vec![(T - 120_000, false), (T - 60_000, true)]);

        // A line with no copy near it in time takes nothing away: the page
        // simply does not reach it, or the service has not stored it yet.
        let mut threads = Threads::default();
        threads.said(PEER, false, T, "ok");
        let kept = threads.hand_over(PEER, rows(&[(T - STANDING_WINDOW_MS - 1000, PEER, "ok")]));
        assert_eq!(kept.len(), 1);

        // Two lines the same take two copies, the rest stay.
        let mut threads = Threads::default();
        threads.said(PEER, false, T, "ok");
        threads.said(PEER, false, T + 5000, "ok");
        let kept = threads.hand_over(
            PEER,
            rows(&[(T - 30_000, PEER, "ok"), (T + 100, PEER, "ok"), (T + 5100, PEER, "ok")]),
        );
        assert_eq!(kept.iter().map(|r| r.at_ms).collect::<Vec<_>>(), vec![T - 30_000]);

        // Another resident's conversation is another matter.
        let other = "22222222-2222-2222-2222-222222222222";
        let mut threads = Threads::default();
        threads.said(other, false, T, "ok");
        assert_eq!(threads.hand_over(PEER, rows(&[(T + 100, PEER, "ok")])).len(), 1);
    }

    #[test]
    fn a_message_arriving_after_its_stored_copy_was_shown_names_that_copy() {
        let mut threads = Threads::default();
        let shown = threads.hand_over(
            PEER,
            rows(&[(T - 3_600_000, PEER, "ok"), (T, PEER, "are you there?"), (T + 1000, ME, "ok")]),
        );
        assert_eq!(shown.len(), 3);
        let stored_copy = shown[1].id.clone();

        // The message itself comes in a moment later (it was on its way, or
        // was kept while the account was offline and is delivered now).
        assert_eq!(threads.said(PEER, false, T + 2000, "are you there?"), Some(stored_copy));
        // Once: said again, it is a new line and nothing more gives way.
        assert_eq!(threads.said(PEER, false, T + 4000, "are you there?"), None);
        // The same words much later are somebody saying them again, not the
        // copy of an hour ago turning up.
        assert_eq!(threads.said(PEER, false, T, "ok"), None);
        // What this account writes is in no page fetched before it was written.
        assert_eq!(threads.said(PEER, true, T + 1500, "ok"), None);
        // An empty line is no line.
        assert_eq!(threads.said(PEER, false, T, "   "), None);
    }

    #[test]
    fn history_is_asked_for_once_a_login_and_a_failure_waits_before_the_next_try() {
        let mut threads = Threads::default();
        assert_eq!(threads.begin(PEER, T), Ok(()));
        // Still out, or just failed: not again yet.
        assert_eq!(threads.begin(PEER, T + 1000), Err("wait"));
        assert_eq!(threads.begin(&PEER.to_uppercase(), T + RETRY_AFTER_MS - 1), Err("wait"));
        // Another conversation is not held up by this one.
        assert_eq!(threads.begin("22222222-2222-2222-2222-222222222222", T + 1000), Ok(()));
        // Later it may be tried again.
        assert_eq!(threads.begin(PEER, T + RETRY_AFTER_MS), Ok(()));
        // Handed over - even an empty page - it is done for this login.
        assert!(threads.hand_over(PEER, Vec::new()).is_empty());
        assert_eq!(threads.begin(PEER, T + 10 * RETRY_AFTER_MS), Err("done"));
    }

    #[test]
    fn only_so_much_is_remembered() {
        let mut threads = Threads::default();
        for i in 0..(LINES_PER_THREAD as u64 + 10) {
            threads.said(PEER, false, T + i, &format!("line {i}"));
        }
        assert_eq!(threads.by_peer[PEER].lines.len(), LINES_PER_THREAD);
        assert_eq!(threads.by_peer[PEER].lines.front().unwrap().text, "line 10");

        // Past the limit on conversations, the one quiet for longest goes.
        let mut threads = Threads::default();
        for i in 0..MAX_THREADS as u64 {
            threads.said(&format!("00000000-0000-0000-0000-{i:012x}"), false, T + i, "hi");
        }
        assert_eq!(threads.by_peer.len(), MAX_THREADS);
        threads.said(PEER, false, T + MAX_THREADS as u64, "hi");
        assert_eq!(threads.by_peer.len(), MAX_THREADS);
        assert!(!threads.by_peer.contains_key("00000000-0000-0000-0000-000000000000"));
        assert!(threads.by_peer.contains_key(PEER));
    }

    #[test]
    fn the_session_hands_history_over_under_the_names_it_knows() {
        let mut st = SessionState { agent_id: ME.into(), ..Default::default() };
        st.set_name(PEER, "Ruth Resident");
        assert_eq!(st.im_history_begin(PEER, T), Ok(()));
        st.im_threads.said(PEER, false, T + 1000, "hello");
        let handed = st
            .im_history_hand_over(ME, PEER, rows(&[(T - 5000, ME, "anyone?"), (T - 4000, PEER, "yes"), (T + 1200, PEER, "hello")]))
            .expect("history");
        assert_eq!(handed.len(), 2);
        // This account's own name is not in the cache: the service's stands.
        assert_eq!(handed[0]["fromName"], "Some One");
        assert_eq!(handed[0]["outgoing"], true);
        assert_eq!(handed[0]["timestamp"], T - 5000);
        assert_eq!(handed[1]["fromName"], "Ruth Resident");
        assert_eq!(handed[1]["text"], "yes");
        assert_eq!(handed[1]["id"], id_at(T - 4000, 0));

        // A page that was asked for by another account is nobody's here.
        let mut st = SessionState { agent_id: ME.into(), ..Default::default() };
        assert_eq!(st.im_history_hand_over(PEER, ME, Vec::new()), Err("no-session"));

        // Nothing is asked about a blocked resident, and a page that arrives
        // after the block is not shown.
        let mut st = SessionState { agent_id: ME.into(), ..Default::default() };
        st.set_block_state(PEER, true);
        assert_eq!(st.im_history_begin(PEER, T), Err("blocked"));
        assert_eq!(st.im_history_hand_over(ME, PEER, rows(&[(T, PEER, "hello")])), Err("blocked"));
    }
}
