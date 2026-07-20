# Minibee Viewer - To-do

Living backlog for Minibee parity, correctness, and architecture.  
Reference parcel for land work: **Pantera Polnocy's Family Den** (Sekiei, Linden Homes).

---

## 1. Group chat & conference chat

**Status: implemented (2026-07).** Group and conference chat, live rosters, conference invites, P2P typing indicators, and moderator text mute are all working and matched to Firestorm. Retained here as a parity reference. Remaining follow-up: persisted group-name resolution so group-IM titles no longer fall back to the binary-bucket name (see sections 2 and 14).

### Current state (Minibee)

| Feature | Status |
|---------|--------|
| Local region chat (`ChatFromSimulator`) | Working |
| 1:1 IM (`ImprovedInstantMessage`, agent-to-agent) | Working |
| **Group IM session** (`IM_SESSION_GROUP_START` = 15) | **Working** |
| **Conference / ad-hoc group IM** (`IM_SESSION_CONFERENCE_START` = 16) | **Working** |
| Session invite / start (`ChatterBoxInvitation`, `ChatSessionRequest` cap) | **Working** |
| Participant list per session (`ChatterBoxSessionAgentListUpdates`) | **Working** |
| Conference invite into an open session (`ChatSessionRequest` "invite") | **Working** |
| Session-scoped typing indicators (`IM_TYPING_START/STOP`, P2P) | **Working** |
| Moderator text mute (`ChatSessionRequest` "mute update") | **Working** |
| Local per-session notification mute | **Working** |
| Leave / close session | **Working** (`IM_SESSION_LEAVE`) |

**Implemented (2026-07):** `sl-transport.js` now classifies session IMs (`IM_SESSION_SEND`, `FromGroup`) and keys them by the sim `SessionID` instead of the P2P XOR. Incoming group chat is delivered directly over UDP (the sim streams it to members); conferences arrive as a `ChatterBoxInvitation` on the EventQueue and are auto-accepted through the `ChatSessionRequest` capability. Rosters are tracked from `ChatterBoxSessionAgentListUpdates` / `ChatterBoxSessionStartReply` and rendered in a collapsible member sidebar. Group chat opens from the Land tab group; conferences start from the IM tab picker. `parseImprovedInstantMessage` now captures `FromGroup`.

**Polish (2026-07):** P2P typing indicators match FS (`LLIMModel::sendTypingState` / `processIMTypingCore`): `IM_TYPING_START/STOP` are sent throttled while composing and shown as a "typing..." bar and list hint; they are P2P-only (the sim does not broadcast typing to sessions). Conference participants can be invited into an open session (`ChatSessionRequest` "invite", `FSFloaterIM::inviteToSession`). Session moderators can mute/unmute a participant's text (`ChatSessionRequest` "mute update", `LLIMSpeakerMgr::allowTextChat`); the roster shows MOD tags and mute toggles, and the local user's moderator status comes from `is_moderator` on their own roster row. A local per-session mute suppresses the unread badge for noisy sessions.

### Target behaviour (Firestorm parity)

- **Group chat session:** one persistent IM tab per group the agent belongs to; title = group name; messages from any member; roster shows online members with speaking/typing state.
- **Conference chat:** ad-hoc multi-avatar session; roster lists all participants; add/remove members; session survives until closed.
- **User lists:** live participant list updated via `ChatterBoxSessionAgentListUpdates` (and initial list in `ChatterBoxSessionStartReply`).
- **Send path:** `ImprovedInstantMessage` with correct `SessionID`, `dialog` type, and `binaryBucket` for session metadata where required.
- **Start session:** `StartSession` / invite flow matching `LLIMModel::sendStartSession` for group and conference types.

### Protocol / packets (implemented)

| Message | Direction | Purpose |
|---------|-----------|---------|
| `ImprovedInstantMessage` | Both | Carry group/conference messages; honour `SessionID`, `FromGroup`, `dialog` |
| `ChatterBoxSessionStartReply` | In | New session metadata + initial agent list |
| `ChatterBoxSessionAgentListUpdates` | In | Roster add/remove |
| `ChatterBoxSessionEventReply` | In | Session events (errors, forced close) |
| `StartSession` (or cap equivalent) | Out | Open group / conference session |

Dialog types (`indra/llmessage/llinstantmessage.h`): `IM_SESSION_INVITE` (13), `IM_SESSION_P2P_INVITE` (14), `IM_SESSION_GROUP_START` (15), `IM_SESSION_CONFERENCE_START` (16), `IM_SESSION_SEND` (17), `IM_SESSION_LEAVE` (18), `IM_TYPING_START` (41), `IM_TYPING_STOP` (42).

### UI work

- [x] Extend `FSState.imSessions` to support `type` (`p2p` | `group` | `conference`), `sessionId` (UUID from sim), `title`, `participants[]`.
- [x] IM tab: distinct session rows for group/conference (icon, member count).
- [x] IM panel: participant sidebar / collapsible roster with online/offline and resolved display names.
- [x] Wire **open group chat** from land tab group link. Conference start from IM tab picker (buddies). (Search-result group links still TODO.)
- [x] Conference: **Leave** action; handle `ForceCloseChatterBoxSession` notification.
- [x] Conference **Invite** existing session (add participant to an open conference).
- [x] Session-scoped typing indicators (P2P) with composer send + "typing..." display.
- [x] Per-session mute: local notification mute + moderator text mute toggle in roster.
- [x] Parse and route session-start IMs instead of filtering them as unknown dialogs.

### Firestorm file index

| Area | Primary files |
|------|----------------|
| IM manager / sessions | `indra/newview/llimmgr.cpp`, `llimmgr.h` |
| Session processing | `indra/newview/llimprocessing.cpp` |
| IM model / send | `indra/newview/llimmodel.cpp` |
| IM floater UI | `indra/newview/llimview.cpp`, `llfloaterimcontainer.cpp` |
| Speakers / roster | `indra/newview/llspeakers.cpp` |
| Group chat entry | `indra/newview/llgroupactions.cpp` (`IM_SESSION_GROUP_START`) |
| Conference entry | `indra/newview/llavataractions.cpp` (`IM_SESSION_CONFERENCE_START`) |
| Dialog constants | `indra/llmessage/llinstantmessage.h` |

---

## 2. Avatar profiles & group profiles

### Current state (Minibee)

| Feature | Status |
|---------|--------|
| Display name resolution (`GetDisplayNames` cap) | Working for agents |
| **Avatar profile floater** (`js/ui/profile.js`) | **Working** - IM, buddies, radar, search, chat, land |
| **AgentProfile cap** (full about, picks, groups, notes) | **Working** - region seed grant + retry |
| UDP `AvatarPropertiesReply` fallback | Working (smaller about, image UUID, flags) |
| Profile actions (IM, Pay, teleport, add friend) | Working |
| Profile photo in floater + image preview | Working |
| Account level / membership tier in subtitle | Working |
| Name hint from search / radar / buddies on open | Working |
| **Group profile floater** | **Partial** - charter, insignia, meta; open group chat when member |
| Group name resolution (land tab, IM titles) | **Partial** - cached from profile replies; land may still show UUID |
| Avatar thumbnails in lists | **Partial** - `avatar-thumb.js`; auto-resolve for buddies only |
| Classified / pick detail (teleport from profile) | **Partial** - list + detail pane; no teleport action yet |
| Join / leave / activate group from profile | **Not implemented** |
| Edit own profile / notes | **Not implemented** (notes display only) |

**Implemented (2026-07):** `sl-profiles.js` fetches and caches avatar profiles via `AgentProfile` cap (bulk region grant includes cap) with UDP fallback. `profile.js` renders a modal floater with Resident / Web / Places / Classifieds / More / Notes tabs, scrollable about text, and action buttons. Search passes name hints so the header resolves immediately. Thumbnails use `secondlife.com/app/image/` URLs with a friends-only auto-fetch policy to limit UDP traffic.

### Avatar profile - fields (Firestorm parity)

- [x] Profile photo (texture from `AgentProfile` cap or `AvatarPropertiesReply` image UUID).
- [x] **Avatar thumbnails in lists** - buddies resolve images; radar, IM, search, chat show initials (`data-resolve-image="0"`).
- [x] Display name + username (legacy name) in header.
- [x] Partner, born date, account level, payment info.
- [x] About / description (HTML subset; full text via cap).
- [x] Picks list (name + detail pane).
- [x] Classifieds (title + detail pane).
- [x] Groups (name + role; link to group profile).
- [x] Notes tab (display when returned by cap).
- [x] Pay, IM, Offer teleport, Add friend actions.
- [x] Pick / classified teleport from profile detail.
- [x] Remove friend action.
- [x] Edit notes (private notes about other residents; save via `AvatarNotesUpdate`).
- [x] Thumbnail auto-resolve on radar / search / chat / IM — **declined** (buddies-only policy kept; avoids UDP flood on transient UUIDs in radar/search/chat/IM).

### Group profile - fields

- [x] Group name, charter / description.
- [x] Group insignia (image).
- [x] Member count, open/enrollment, Mature rating.
- [x] Open group chat (when member).
- [ ] Founder name resolution (link only).
- [ ] Roles list (if member).
- [ ] Actions: Join / Leave, Activate group, Pay group.

### Data sources

| Data | Preferred source | Minibee status |
|------|------------------|----------------|
| Avatar about (full), picks, groups, notes | `AgentProfile` cap | Working |
| Avatar about (short), image, flags | `AvatarPropertiesReply` (UDP) | Working (fallback) |
| Classified / pick detail | `ClassifiedInfoRequest`, `PickInfoRequest` | Partial (detail fetch wired) |
| Group name, charter, insignia | `GroupProfileReply` (UDP) | Working in profile floater |
| Group membership | `AgentGroupDataUpdate` | Partial |

### Avatar thumbnails in lists (buddies, IM, radar, chat)

**Current state (Minibee):** `js/ui/avatar-thumb.js` renders initials or cached texture URLs. Buddies set `data-resolve-image="1"` so `FSProfiles.queueAvatarThumb` fetches the image UUID (UDP legacy path; cap when available). Other surfaces use initials unless the image id is already cached from a prior profile view.

**Decision (2026-07):** Auto-resolve list thumbnails outside the buddies list is **not planned**. Radar, search, chat, and IM keep initials (`data-resolve-image="0"`). Profile floaters and cached image IDs still show photos when already known. Revisit only if we add strict batching or a user setting later.

**Target surfaces (Minibee):**

| Surface | File(s) | Status |
|---------|---------|--------|
| Buddies list | `js/ui/buddies.js` | Image resolve on |
| IM session list + thread header | `js/ui/im.js` | Initials only |
| Radar | `js/ui/radar.js` | Initials only |
| People search | `js/ui/search.js` | Initials only |
| Chat history | `js/ui/chat.js` | Initials only |
| Profile floater | `js/ui/profile.js` | Full image + preview |

**Remaining work:**

- [x] Optional thumb resolve for radar / IM / search / chat — declined (see decision above).
- [ ] `localStorage` TTL cache for `imageId` (see section 14).
- [ ] Respect RLV / blocked users if added later.

### Implementation plan

- [x] `js/protocol/sl-profiles.js` - request/merge/cache avatar and group profile records.
- [x] `js/ui/avatar-thumb.js` - shared profile image element for list surfaces.
- [x] `js/ui/profile.js` - shared floater for avatar and group modes.
- [x] Enable profile buttons in IM, search, buddies, radar, chat.
- [x] Land tab: owner and group fields open profile floater.
- [ ] Group join / leave / activate actions.
- [x] Pick / classified teleport from profile.
- [ ] Do **not** use `GetDisplayNames` for group UUIDs (already avoided).

### Firestorm file index

| Area | Primary files |
|------|----------------|
| Profile floater shell | `indra/newview/llfloaterprofile.cpp`, `llfloaterprofile.h` |
| Avatar panels | `indra/newview/llpanelavatar.cpp`, `llpanelprofile.cpp` |
| Avatar properties processor | `indra/llcharacter/llavatarpropertiesprocessor.cpp` |
| Group manager | `indra/newview/llgroupmgr.cpp`, `llgroupactions.cpp` |
| Search profile observer | `indra/newview/fsfloatersearch.cpp` (`FSSearchAvatarPropertiesObserver`) |

---

## 3. Bridge architecture - reduce stalls / multi-lane processing

### Problem

The bridge is a bottleneck on two levels:

1. **PHP daemon (`bridge/daemon.php`):** single accept loop - one HTTP request is handled to completion before the next. A long `/proxy` call (EventQueue long-poll up to 90s, `RemoteParcelRequest`, `GetDisplayNames` batch) blocks `/circuit/poll`, so UDP packets (chat, IM, radar) queue in the session inbox until the proxy returns.

2. **JS client (`js/protocol/bridge.js`):** `this._queue` serialises **all** `fetch()` calls through one Promise chain. Even if PHP could serve concurrent requests, the browser client would still send them one at a time.

Symptom: IMs and chat feel delayed while land tab, EventQueue, or cap lookups are active; diagnostics show bursty UDP delivery.

### What will *not* help alone

- Splitting JS into more source files without changing concurrency - same thread, same queue.
- PHP `pthreads` - not available in standard PHP builds; not a practical path.
- Spawning a new PHP process per request without shared UDP socket state - breaks circuit/session model.

### Recommended approach (phased)

#### P0 - Quick wins (no new processes)

- [x] **Priority lane in `bridge.js`:** separate queues - `poll`, `exchange`, and `send` bypass the cap/proxy background queue (immediate `fetch`). Only `/proxy`, `/login`, map HTTP use the background queue.
- [x] **Never block poll on proxy:** circuit poll/exchange/send no longer share the background Promise chain with caps/EventQueue.
- [x] **Cap request coalescing:** `GetDisplayNames` in-flight dedupe for identical ID batches (`sl-caps.js`).
- [x] **EventQueue:** long-poll stays on background lane; circuit poll uses priority lane.

#### P1 - PHP concurrent serving

- [x] **Non-blocking HTTP server:** daemon uses `stream_select` + concurrent clients; `/circuit/poll` and `/circuit/exchange` wait asynchronously; `/proxy` uses `curl_multi`.
- [x] **Two-process split:** `bridge/poll.php` (UDP + `/circuit/*` on **8795**) and `bridge/caps.php` (UI, login, proxy, map on **8794**). `start-minibee.bat` launches both; JS client routes circuit traffic to the poll port.

#### P2 - JS worker offload (packet processing)

- [ ] Move heavy **inbound UDP decode** (`sl-packet.js` parse hot path) to a **Web Worker** - main thread only dispatches typed events (`im`, `chat`, `parcel`, `radar`). Reduces main-thread stalls when many `ObjectUpdate` or parcel packets arrive.
- [ ] Keep **outbound send** and state mutation on main thread (simpler ordering).

#### P3 - Logical module split (maintainability)

Even without threads, split `sl-transport.js` into focused modules with a thin dispatcher:

| Module | Responsibility |
|--------|----------------|
| `sl-transport-im.js` | IM routing, sessions, typing |
| `sl-transport-chat.js` | Local chat |
| `sl-transport-parcel.js` | Land / parcel merge |
| `sl-transport-map.js` | Map blocks |
| `sl-transport-radar.js` | Coarse location |
| `sl-transport.js` | Circuit lifecycle, event demux |

This does not fix blocking by itself but makes it easier to reason about priorities and test each lane.

### Success criteria

- IM delivery latency &lt; 500ms under load (land tab open, EventQueue polling, display-name resolve in flight).
- `/circuit/poll` p99 response time independent of longest `/proxy` duration.
- No duplicate or dropped UDP packets when caps are active.

### Files to change

| Layer | Files |
|-------|-------|
| JS queue | `js/protocol/bridge.js` |
| Poll loop | `js/protocol/sl-packet.js` (`Circuit.prototype._pollLoop`) |
| Cap callers | `js/protocol/sl-caps.js`, `js/protocol/sl-eventqueue.js`, `js/protocol/sl-transport.js` |
| PHP daemon | `bridge/daemon.php` |
| Docs | `docs/README.md` (update single-threaded note once lanes exist) |

---

## 4. Events tab - duplicate event messages

### Symptom

A single in-world action (e.g. paying another avatar L$2) produces **multiple identical entries** in the Events panel - same description, same balance, timestamps a second apart. Observed: five "You paid panterapolnocy Resident L$2" cards after one payment.

### Likely cause

`MoneyBalanceReply` can arrive more than once per transaction (sim retries, multiple economy packets, or the same packet delivered via repeated UDP poll batches). `postPaymentEvent()` in `sl-transport.js` appends a **new** event on every `money-balance` emit that has a `description`, with a fresh `FSUtils.uuid()` and **no deduplication** (unlike IM, which uses `isDuplicateIm`).

### Fix direction

- [x] **Dedupe payment events** before `postEventMessage` - key on `transactionId` when present, else `(description, balance, transactionType)` within 15s TTL.
- [ ] **Update in place** when the same payment is seen again (refresh balance line only) instead of pushing another card.
- [ ] Audit other event kinds (`script-dialog`, `interactive-prompt`, MOTD) for the same pattern - any `postEventMessage` without a signature check may duplicate.
- [ ] Confirm whether duplicates originate from the sim (multiple `MoneyBalanceReply`) or from viewer-side double-handling (poll + exchange, or repeated handler registration).

### Files

| Layer | Files |
|-------|-------|
| Payment -> event | `js/protocol/sl-transport.js` (`postPaymentEvent`, `money-balance` handler) |
| Event state | `js/state.js` (`addEventMessage`) |
| Events UI | `js/ui/events.js`, `js/ui/chat.js` (`renderPayment`) |
| Packet parse | `js/protocol/sl-packet.js` (`MoneyBalanceReply`) |

### Firestorm reference

`indra/newview/llviewerwindow.cpp` / money notification handling - FS typically shows one toast per balance change; compare dedupe in `LLFloaterMoneyBalance` or notification manager.

---

## 5. Land tab vs Firestorm About Land

Screenshots compared: Minibee (6 subtabs) vs Firestorm `llfloaterland.cpp` (8+ subtabs).

### Tab coverage

| Firestorm tab | Minibee tab | Status |
|---------------|-------------|--------|
| General (Ogólne) | General | Partial |
| Covenant (Umowa) | - | **Missing entire tab** |
| Objects (Obiekty) | Objects | Partial |
| Options (Opcje) | Options | Partial |
| Media | Media | Partial |
| Sound (Dźwięk) | Audio | Partial |
| Access (Dostęp) | Access | Partial |
| Experiences (Przygody) | - | **Missing entire tab** |
| Environment (Otoczenie) | - | **Missing entire tab** |

### General

| Field / feature | Firestorm | Minibee | Fix |
|-----------------|-----------|---------|-----|
| Parcel name | Editable if owner | Shown | OK (read-only for visitor) |
| Parcel UUID | Read-only | Shown | OK |
| Description | Editable | Shown | OK |
| **Owner** | Clickable profile link + avatar icon (`LLPanelLandGeneral::refreshNames`) | Link opens profile floater | **Resolve display name in field** (link works) |
| **Group** | Clickable group name + Set / Deed buttons | Link opens group profile; may show UUID prefix | **Group name in field** when not yet cached |
| Group deed / contribute checkboxes | Shown | - | **Missing** |
| For sale / sale price | Shown | - | **Missing** (`salePrice`, auction) |
| Claim / purchase date | Shown | - | **Missing** (`claimDate` from ParcelProperties) |
| Area | `1024 m2` | `1024 m2` | OK |
| Traffic (dwell) | `11` | `11` | OK (needs `ParcelInfoReply` / dwell from info packet) |
| **Region / land type** | "Linden Homes / Full Region" | - | **Missing** (region info + parcel category) |
| **Content rating** | Moderate `[M]` | - | **Missing** (region maturity + parcel flag) |
| Buy / abandon / buy pass / buy for group | Action buttons | - | **Missing** |
| Scripts button | Opens script limits floater | - | **Missing** |

**FS source hints:** `llfloaterland.cpp` - `LLPanelLandGeneral`, `refreshNames()`, `mBtnProfile`, group profile via `LLGroupMgr`.

### Covenant (missing tab)

| Field / feature | Firestorm | Minibee |
|-----------------|-----------|---------|
| Estate name | Linden Homes 2 | - |
| Estate owner | Governor Linden (profile link) | - |
| Covenant text (scrollable) | Full text | - |
| Last modified date | Shown | - |
| Region name / type / rating | Shown | - |
| Resell / subdivide rules | Shown | - |

**FS source:** `LLPanelLandCovenant`, region `LLViewerRegion::getEstateCovenant()`.

**Todo:** Add Covenant subtab; fetch via region covenant / `DispatchRegionInfo` cap.

### Objects

| Field / feature | Firestorm | Minibee | Fix |
|-----------------|-----------|---------|-----|
| Region capacity | `415 / 468 (53 available)` | `415 / 468` | Add **available count** |
| Max prims label | Separate field | - | Optional label parity |
| Prims on parcel | `415` | `415 / 468` | OK |
| **Owner prims** | `388` + **Show / Return** buttons | `388` (number only) | **Labels**: "Owner prims" not profile; add Show/Return (`ParcelObjectOwnersRequest`) |
| **Group prims** | `27` + Show/Return | `27` | Same |
| **Other residents** | `0` + Show/Return | `0` | Same |
| Selected prims | `0` | - | **Missing** |
| Auto-return minutes | Input `0` | - | **Missing** (`otherCleanTime`) |
| Owner list table | Name links, counts, newest | - | **Missing** (`ParcelObjectOwnersReply`) |
| Refresh / Return all | Buttons | - | **Missing** |

**FS source:** `LLPanelLandObjects`, `ParcelObjectOwnersRequest` / `Reply`.

### Options

| Field / feature | Firestorm | Minibee | Fix |
|-----------------|-----------|---------|-----|
| Allow flying | Everyone checkbox | Shown | OK |
| Allow build | Everyone + **Group** columns | Everyone + Group | OK |
| Allow scripts | Everyone + Group | Everyone + Group | OK |
| Allow terraform | Everyone | - | **Missing** checkbox |
| Allow object entry | Everyone + Group | - | **Missing** (`PF_ALLOW_ALL_OBJECT_ENTRY`, `PF_ALLOW_GROUP_OBJECT_ENTRY`) |
| Push restricted | "No pushing (whole Region)" | "Push restricted" | OK (wording differs) |
| Safe (no damage) | Shown | Shown | OK |
| Show in search | Shown | Shown | OK |
| **Moderate content** flag | Shown with icon | - | **Missing** |
| **Search category** dropdown | "Any category" | - | **Missing** (`category` U8) |
| **See avatars on other parcels** | Checkbox | - | **Missing** (`SeeAVs` from ParcelProperties LLSD) |
| Snapshot | Image + Set/Clear | Image only | Add **Set/Clear** (owner only) |
| Landing point | Coords + heading `348 deg` | `130, 218, 29` | Add **heading** (`userLookAt` / landing type) |
| Set / Clear landing | Buttons | - | **Missing** |
| **Teleport to landing** | Button | - | **Missing** |
| Landing route dropdown | Shown | - | **Missing** |

**FS source:** `LLPanelLandOptions`, `llparcel.h` flag bits, `LandingType` / `UserLookAt`.

### Media

| Field / feature | Firestorm | Minibee | Fix |
|-----------------|-----------|---------|-----|
| Media type | Dropdown + MIME | `text/html` read-only | OK |
| Media URL | URL + **Set** button | URL field | Add Set button (owner) |
| Description | Editable | Read-only | Owner should edit |
| **Texture preview** | Large square + picker | - | **Missing** (`MediaID` texture) |
| Auto-scale | Checkbox | - | **Missing** |
| **Width / height** | 1024 x 1024 px | - | **Missing** |
| Loop playback | Checkbox | - | **Missing** |

**FS source:** `LLPanelLandMedia`, `MediaData` block in ParcelProperties.

### Audio

| Field / feature | Firestorm | Minibee | Fix |
|-----------------|-----------|---------|-----|
| Music URL | URL + add/remove/copy | URL | Add **URL helper buttons** |
| Restrict sounds to parcel | Checkbox | "Restrict sounds to parcel" | OK (`soundLocal`) |
| **Avatar sounds - Everyone** | Checkbox | - | **Missing** (`AnyAVSounds`) |
| **Avatar sounds - Group** | Checkbox | - | **Missing** (`GroupAVSounds`) |
| Voice enabled | Checkbox | "Voice enabled" | OK |
| **Restrict voice to parcel** | Checkbox | - | **Missing** (separate from voice on/off) |
| **Restrict MOAP to parcel** | Checkbox | - | **Missing** (`obscureMOAP` / extended flags) |

**FS source:** `LLPanelLandAudio`, `SeeAVs` / `AnyAVSounds` / `GroupAVSounds` in message template comment.

### Access

| Field / feature | Firestorm | Minibee | Fix |
|-----------------|-----------|---------|-----|
| Access dropdown | Anyone + sub-restrictions | "Anyone can visit" | Partial |
| **18+ / payment info** sub-checkboxes | Shown | - | **Missing** |
| **Group access bypass** | Named group checkbox | - | **Missing** |
| Sell passes | Checkbox + audience | Checkbox only | Add **pass audience** dropdown |
| Pass price / hours | Shown | Shown | OK |
| **Always allow list** | List + Add/Remove/Import/Export | - | **Missing** (`ParcelAccessListRequest`) |
| **Banned list** | List with names + times | - | **Missing** |
| Ban lines note | Explained in UI | - | **Missing** |

**FS source:** `LLPanelLandAccess`, `ParcelAccessListReply`.

### Experiences (missing tab)

| Feature | Firestorm | Minibee |
|---------|-----------|---------|
| Allowed experiences list | Up to 24 | - |
| Blocked experiences list | Up to 24 | - |
| Add / Remove / Profile | Buttons | - |

**FS source:** `LLPanelExperienceListEditor`, parcel experience caps.

### Environment (missing tab)

| Feature | Firestorm | Minibee |
|---------|-----------|---------|
| Parcel environment version | Shown | - |
| Region environment override | Shown | - |
| Day cycle / sky / water | Extended environment UI | - |

**FS source:** `LLPanelLandEnvironment`, `ParcelEnvironmentBlock`.

### Cross-cutting UI issues

| Issue | Detail | Fix |
|-------|--------|-----|
| **Owner/group as plain text** | Should show resolved names like FS | Owner/group links open profile floater; **inline name resolution** still TODO |
| **Objects tab shows prim counts as bare numbers** | Labels say "Parcel owner: 388" - user expects names in summary, counts in Objects | OK for counts; fix **General** group field label |
| **Apply Changes looks enabled** | Yellow button while read-only | CSS: `.land-form--readonly .btn--primary` should match disabled state |
| **Header group** | `Group: Pantera...` | Same as General group name fix |
| **No Covenant / Experiences / Environment** | FS has 9 tabs | Roadmap tabs |

### Protocol / data gaps (backend)

| Data | Source in FS | Minibee status |
|------|----------------|----------------|
| Parcel flags, prims, music, media | EventQueue `ParcelProperties` | Working (`0x36a4840b`) |
| Parcel UUID, dwell, snapshot | `ParcelInfoReply` / HTTP | Partial (UUID + dwell after info reply) |
| Group name | `LLGroupMgr` / group profile | **Partial** - cached when profile opened; land may show UUID |
| Sale / claim / category | ParcelProperties | **Not parsed to UI** |
| Access lists | `ParcelAccessListReply` | **Not implemented** |
| Object owners | `ParcelObjectOwnersReply` | **Not implemented** |
| Covenant | Region estate data | **Not implemented** |
| Experiences | Experience caps | **Not implemented** |
| Environment | `ParcelEnvironmentBlock` | **Not parsed** |

### Land tab - priority todo

#### P0 - Correctness / noise

- [x] **Dedupe EventQueue parcel updates** - signature check in `emitParcelFromData`.
- [x] **Stop hammering HTTP** - `RemoteParcelRequest` only when UUID/dwell/flags missing.
- [x] **Throttle automatic refresh** - `PARCEL_REFRESH_MIN_INTERVAL_MS`; manual refresh uses `{ force: true }`.
- [x] **Reduce parcel diagnostic spam** - `logParcelChange` logs one line per actual change.
- [x] **Fix Apply button appearance** when `canEdit === false`.

#### P1 - General tab parity

- [x] Owner profile link (display name + username) - opens avatar profile floater.
- [ ] Group name resolution + profile link (not UUID) - profile floater works; land header/group field may still show UUID until `GroupProfileReply` is cached.
- [ ] Region type, content rating, for-sale state, claim date.
- [ ] Buy / abandon / buy pass buttons (disabled when not applicable).

#### P2 - Objects tab

- [ ] Selected prims, available region prims count.
- [ ] Show / Return buttons + object owner list.
- [ ] Auto-return minutes field.

#### P3 - Options / Media / Audio

- [ ] Terraform, object entry, SeeAVs, moderate flag, search category.
- [ ] Landing heading, teleport-to-landing, set/clear landing.
- [ ] Media texture preview, dimensions, loop, auto-scale.
- [ ] Avatar sounds everyone/group, voice restrict, MOAP restrict.
- [ ] **In-browser parcel music playback + volume** - see section 6.

#### P4 - Access

- [ ] 18+ / payment sub-restrictions.
- [ ] Group access bypass checkbox.
- [ ] Allow / ban lists with add/remove.

#### P5 - New tabs

- [ ] Covenant (estate name, owner, text, resell rules).
- [ ] Experiences (allow/block lists).
- [ ] Environment (parcel environment version).

### Firestorm file index (land)

| Area | Primary files |
|------|----------------|
| Main floater / tabs | `indra/newview/llfloaterland.cpp`, `llfloaterland.h` |
| Parcel manager / UDP | `indra/newview/llviewerparcelmgr.cpp` |
| Parcel data model | `indra/llinventory/llparcel.cpp`, `llparcel.h` |
| Remote parcel HTTP | `indra/newview/llremoteparcelrequest.cpp` |
| Message layout | `scripts/messages/message_template.msg` (`ParcelProperties`, `ParcelInfoReply`) |
| EventQueue delivery | `indra/newview/lleventpoll.cpp` |

---

## 6. Parcel music - in-browser playback

### Current state (Minibee)

| Feature | Status |
|---------|--------|
| Parcel `musicUrl` parsed and shown (Land -> Audio tab) | Working |
| Stream playback in browser | **Not implemented** |
| Volume control | **Not implemented** |
| Auto-play preference | **Not implemented** |
| Stop / mute when leaving parcel or URL clears | **Not implemented** |

Minibee displays the stream URL (e.g. `http://128k.hotwaxradio.com`) but does not play it. Firestorm uses FMOD/`LLViewerAudio` to open the URL as an audio stream when the agent is on a parcel with music enabled.

### Feasibility

**Yes, for many parcels** - most SL parcel music URLs are plain HTTP/HTTPS Shoutcast/Icecast or direct MP3 streams. The browser can play these via `<audio>` or `Audio()` with `src` set to the parcel URL.

**Caveats:**

- **Autoplay policy:** browsers block autoplay until the user has interacted with the page (login click counts). Gate auto-play behind a user setting and a visible play/mute control.
- **CORS / mixed content:** some stream hosts send no `Access-Control-Allow-Origin` - usually fine for `<audio src>` (not `fetch`), but HTTPS page + HTTP stream may be blocked.
- **Unsupported formats:** rare proprietary or redirect-heavy URLs may fail; show a clear error and leave the URL linkable.
- **No 3D positional audio** - acceptable for Minibee (no 3D world); parcel-wide stream only, matching FS parcel music behaviour.

### Target behaviour (Firestorm parity, simplified)

- When agent's parcel has a non-empty `musicUrl` and **parcel music is enabled** in preferences, start or switch stream playback.
- **Volume slider** (0-100%) in Land -> Audio tab and/or a compact control in the status bar; persist in `localStorage`.
- **Mute / play toggle** without losing volume setting.
- On parcel change or teleport: stop old stream, start new URL (optional crossfade later).
- Respect empty URL or invalid URL - stop playback, no error spam.

### Implementation plan

- [ ] `js/audio/parcel-music.js` - `HTMLAudioElement` wrapper: `play(url)`, `stop()`, `setVolume(0-1)`, error handling.
- [ ] Subscribe to `FSState` / `parcel` updates in transport; call player when `musicUrl` changes (dedupe same URL).
- [ ] Settings: `parcelMusicEnabled` (default off or on after first user gesture), `parcelMusicVolume` (default 0.5).
- [ ] Land -> Audio tab: volume range input + enable checkbox + now-playing label; disable controls when URL empty.
- [ ] Optional status-bar mini control (speaker icon) for mute/volume without opening Land tab.
- [ ] Handle `soundLocal` / parcel flags only if relevant - parcel music is region-wide stream from URL, not the `soundLocal` checkbox (that restricts object sounds).

### Firestorm file index

| Area | Primary files |
|------|----------------|
| Parcel music URL updates | `indra/newview/llviewerparcelmgr.cpp` |
| Audio stream engine | `indra/newview/llvieweraudio.cpp` |
| Land audio UI | `indra/newview/llpanellandaudio.cpp` |
| Auto-play / fade prefs | `indra/newview/app_settings/settings.xml` (`AudioAutoPlay`, `FSFadeAudioStream`) |

---

## 7. Debug tab - optional diagnostics logging

### Goal

Rename the **Log** tab to **Debug**. Make persisting protocol diagnostics into the log panel **optional** and **off by default**, so idle viewers spend less UI/CPU time rendering and retaining diagnostic lines.

### Tasks

- [ ] Rename shell tab label and nav copy from **Log** to **Debug** (`index.html`, navigation, any user-facing strings).
- [ ] Add a setting (e.g. `debugLogDiagnostics`, default `false`) to gate whether `FSErrors` / protocol diagnostics are appended to the on-screen log.
- [ ] When disabled: keep console-only or silent capture for hard failures if needed; do not grow the Debug list on every EQ poll, cap grant, or teleport trace.
- [ ] When enabled: current behaviour - stream diagnostics into the Debug panel for troubleshooting.
- [ ] Optional: compact toggle in Debug tab header ("Record diagnostics") so users can enable temporarily without opening Settings.

---

## 8. Teleport handoff - EventQueue sequence (Agni)

### Symptom

`TeleportStart` / `TeleportProgress` arrive over UDP, then stall at ~90s with `No TeleportFinish/Failed`. Logs may show `RX DisableSimulator tpl=152` (normal neighbour teardown) but no `EventQueue during teleport: ...` lines.

### Expected EQ order (source sim)

1. `EnableSimulator` - viewer sends `UseCircuitCode` to destination UDP endpoint
2. `EstablishAgentCommunication` - destination seed capability URL (defer cap bootstrap until `TeleportFinish`)
3. `TeleportFinish` - complete handoff; migrate circuit + `CompleteAgentMovement`

### Done / in progress

- [x] Stop aborting in-flight EQ polls on handoff restart (duplicate polls drop events).
- [x] Fix PHP proxy `CURLOPT_TIMEOUT` so client `timeoutSec` (up to 95s) applies.
- [x] Back off on early empty EQ responses (<10s) instead of tight-looping.
- [x] Handle `EstablishAgentCommunication` on EventQueue.
- [x] Clarify `DisableSimulator` UDP during TP (expected; not the finish event).

### Still verify

- [ ] After bridge restart + hard-refresh, confirm logs show `EstablishAgentCommunication (EventQueue)` and `TeleportFinish (EventQueue)` during map TP.
- [ ] If EQ still empty: capture whether caps bridge returns HTTP 502 (normal idle) vs instant 200 with zero events (duplicate poll / wrong cap URL).

---

## 9. Chat links - clickable URLs, trust indicators, bracket syntax

### Current state (Minibee)

| Feature | Status |
|---------|--------|
| SLURL detection in chat / IM (`FSSlurl.linkify`) | **Partial** - bare `secondlife://` / `http://maps.secondlife.com/...` only |
| Plain `http://` / `https://` links in chat | **Not clickable** |
| Bracketed wiki-style links `[http://... Label]` | **Not parsed** - shown as literal text |
| Trusted vs untrusted link affordance | **Not implemented** |
| Hover tooltip showing real URL (esp. masked bracket labels) | **Not implemented** |

`linkify()` in `sl-slurl.js` only matches `SLURL_PATTERN`; it does not implement Firestorm's full `LLUrlRegistry` pipeline.

### Target behaviour (Firestorm parity)

- **All recognised URLs** in chat, IM, MOTD, and (where appropriate) land/profile HTML should be clickable.
- **Trust marking** should mirror Firestorm hovertips / link styling:
  - **Trusted** links (Linden Lab domains, `secondlife.com`, `slurl.com`, in-world SLURLs, Firestorm-trusted patterns) - hand / trusted icon, safe to open in viewer context; tooltip may show destination.
  - **Untrusted** links (arbitrary external `http(s)://`) - distinct styling (e.g. external-link icon, muted or warning colour); tooltip should show the **real URL** so users can verify before opening.
  - Bracketed labels: display text is the label inside `[url Label]`; tooltip shows the underlying URL (Firestorm: `mLabeledLinkMasked` / `getLabeledLinkTrusted()` in `llurlmatch.h`).
- **Content trust context:** object / script / notecard text may be untrusted even when the viewer chrome is trusted - respect a per-surface `trusted_content` flag like `LLTextBase::mTrustedContent` (do not auto-execute SLURLs from untrusted sources).
- **Bracket syntax** (`LLUrlEntryHTTPLabel`):
  - Valid: `[http://www.example.org  Label text]` (URL, whitespace, label; closing `]` required).
  - Invalid partial brackets stay plain text (see `llurlentry_test.cpp` cases).
  - SLURL bracket forms and labelled SLURLs should follow the same rules where FS supports them.

### Implementation plan

- [ ] `js/protocol/sl-urlmatch.js` (or extend `sl-slurl.js`) - URL scanner with ordered matchers: SLURL, `http(s)://`, bracket-labelled HTTP, `mailto:`, etc.
- [ ] **Trusted URL lists** - port Linden / Firestorm trusted patterns from `LLUrlEntryTrustedURL`, `LLUrlEntryFirestormURL` (`llurlregistry.cpp`, `llurlentry.h`).
- [ ] `linkify(text, options)` - return structured spans: `{ url, label, trusted, bracketed }` for renderers.
- [ ] Chat / IM renderers - replace plain `slurl-link` with styled anchors + `title` tooltip; optional icon span (`trusted` / `external`).
- [ ] Click handler - SLURLs -> `FSMap.showLocation` / teleport flow; external URLs -> confirm dialog or new tab (match FS caution for untrusted).
- [ ] **Bracket link parsing** - detect `[http(s)://...  label]` before or after bare-URL pass; never double-link nested regions.
- [ ] Tests - bracket valid/invalid cases from `llurlentry_test.cpp`; trusted vs untrusted host classification.

### Surfaces to wire

| Surface | File(s) |
|---------|---------|
| Local chat | `js/ui/chat.js` |
| IM threads | `js/ui/im.js` |
| Events / system messages | `js/ui/chat.js`, `js/ui/events.js` |
| MOTD / login message | `js/protocol/sl-transport.js` (if rendered as HTML) |
| Profile / land HTML (later) | `js/ui/profile.js`, `js/ui/land.js` |

### Firestorm file index

| Area | Primary files |
|------|----------------|
| URL registry / matching | `indra/llui/llurlregistry.cpp`, `llurlregistry.h` |
| Match metadata (trusted, tooltip) | `indra/llui/llurlmatch.cpp`, `llurlmatch.h` |
| Bracket HTTP labels | `indra/llui/llurlentry.h` (`LLUrlEntryHTTPLabel`) |
| Trusted URL entries | `LLUrlEntryTrustedURL`, `LLUrlEntryFirestormURL` in `llurlentry.h` |
| Render + icons in text | `indra/llui/lltextbase.cpp`, `lltextutil.cpp` |
| Click / dispatch | `indra/llui/llurlaction.cpp`, `indra/newview/llurldispatcher.cpp` |
| Bracket link tests | `indra/llui/tests/llurlentry_test.cpp` |

---

## 10. Landmarks - inventory list (read-only)

### Current state (Minibee)

| Feature | Status |
|---------|--------|
| Teleport home | Working (`TeleportLandmarkRequest` with null UUID) |
| Teleport to landmark UUID | **Protocol only** (`teleportToLandmark` in transport; no UI) |
| Destination Guide tab | Working (search / curated destinations) |
| Map SLURL / coordinate teleport | Working |
| **User's own landmarks from inventory** | **Not implemented** |

Users cannot pick from their personal Landmarks folder; only Destination Guide, map, or manual SLURL entry.

### Target behaviour

- **Read-only** landmarks panel: list folders + landmark items from the agent's inventory (no create, move, delete, or rename in v1).
- Each row: landmark name, region, optional thumbnail; click -> teleport (existing `TeleportLandmarkRequest`).
- Optional: copy SLURL, show on map (centre map on landmark region).
- Landmarks picker also available from map "Teleport Here" flow as an alternative to Destination Guide.

### Data sources

| Data | Source |
|------|--------|
| Inventory tree / Landmarks folder | Login inventory skeleton + `FetchInventory2` / `FetchInventoryDescendents2` caps (`llviewerinventory.cpp`, `FetchInventoryReply` UDP) |
| Landmark position / region | Landmark asset (`LLLandmark`, `LLLandmarkActions::getLandmark`) |
| Teleport | `TeleportLandmarkRequest` (already in `sl-packet.js`) |

Login XML already requests `inventory-root`, `inventory-skeleton`, etc. (`sl-login.js`); caps list includes `FetchInventory2`.

### Implementation plan

- [ ] `js/protocol/sl-inventory.js` - minimal read-only fetch: resolve Landmarks folder UUID from skeleton, descendents, cache item metadata (name, asset UUID, type).
- [ ] Landmark asset decode - HTTP or cap fetch for landmark blob -> region name + global position (mirror `LLLandmark`).
- [ ] `js/ui/landmarks.js` - list UI (search, folder expand); wire row click -> `FSTransport.teleportToLandmark(id)`.
- [ ] Add **Landmarks** entry to navigation or as a sub-tab under Map / Destinations (read-only badge in UI).
- [ ] Graceful empty / loading / cap-missing states; no write paths.

### Firestorm file index

| Area | Primary files |
|------|----------------|
| Landmarks panel UI | `indra/newview/llpanellandmarks.h`, `llpanellandmarks.cpp` |
| Places shell | `indra/newview/llpanelplaces.cpp`, `llpanelplaces.h` |
| Landmark actions | `indra/newview/lllandmarkactions.cpp` |
| Inventory fetch | `indra/newview/llviewerinventory.cpp`, `llinventorymodel.cpp` (`FetchInventoryReply`) |

---

## 11. In-world object interaction - touch, sit, nearby objects

### Current state (Minibee)

| Feature | Status |
|---------|--------|
| 3D world / object rendering | **Not implemented** |
| Object cache from `ObjectUpdate` | **Not implemented** |
| Touch / sit on object | **Not implemented** |
| Nearby / selectable object list | **Not implemented** |
| `ScriptDialog` (touch menus) | **Partial** - inbound dialog display only (`chat.js`) |

Minibee is map + chat + radar (coarse avatars), not a full scene graph. Object interaction requires a foundation that does not exist yet.

### How Firestorm lists nearby objects (Area Search)

Firestorm **Area Search** (`FSAreaSearch`, `fsareasearch.cpp`) does **not** use a special "list all objects" HTTP API. It:

1. Switches interest list to **`IL_MODE_360`** so the sim streams object updates for the whole region (not just view frustum).
2. Walks the **local object list** built from inbound **`ObjectUpdate`** / related UDP (`LLViewerObjectList`).
3. Filters by distance, parcel, name, flags, etc.; refreshes on idle.
4. **Touch:** `ObjectGrab` + `ObjectDeGrab` on the target object (`touchObject`).
5. **Sit:** `ObjectSelect` + `AgentRequestSit` with target object UUID (`sitOnObject`).

So "closest objects" = **client-side cache of sim object data**, not a one-shot query.

### Phased approach for Minibee

#### P0 - Object awareness (prerequisite)

- [ ] Parse and retain a minimal **object table** from UDP (`ObjectUpdate`, `KillObject`, name/value for display name).
- [ ] Track agent position; compute distance to object root positions.
- [ ] Region-scoped list: objects in current sim only (no cross-region until handoff object list exists).

#### P1 - Nearby objects UI ("Area Search lite")

- [ ] Panel: sortable list - name, distance, owner (UUID short), parcel, scripted flag.
- [ ] Filter by name substring, max distance, limit (e.g. 50 nearest).
- [ ] Refresh on timer + after teleport / region change.
- [ ] Optional: request `IL_MODE_360`-equivalent if/when Minibee sends interest-list / throttle messages to sim (research `AgentUpdate` / interest list in `llagent.cpp`).

#### P2 - Interactions

- [ ] **Touch** - `ObjectGrab` / `ObjectDeGrab` (or `ClickAction` path if touch-through needed).
- [ ] **Sit** - `AgentRequestSit` on selected object; handle `AgentSit` / standing up.
- [ ] Wire existing `ScriptDialog` replies to touched object context where applicable.
- [ ] Permission / failure toasts (not sittable, no touch, too far).

#### P3 - Richer parity

- [ ] Buy, pay object, inspect (FS Area Search context menu).
- [ ] Pick ray / click-in-world when 3D view exists (out of scope until render layer).

### Firestorm file index

| Area | Primary files |
|------|----------------|
| Area Search floater | `indra/newview/fsareasearch.cpp`, `fsareasearch.h` |
| Touch / sit | `FSPanelAreaSearchList::touchObject`, `sitOnObject` in `fsareasearch.cpp` |
| Object list | `indra/newview/llviewerobjectlist.cpp` |
| Selection / grab | `indra/newview/llselectmgr.cpp` |
| Interest list mode | `gAgent.changeInterestListMode` (`IL_MODE_360` in `FSAreaSearch` ctor) |

---

## 12. Voice - WebRTC support

### Current state (Minibee)

| Feature | Status |
|---------|--------|
| Parcel "voice enabled" flag (Land tab) | Display only |
| Login `voice-config` | Parsed at login (`sl-login.js`); unused |
| Vivox / SL voice SDK | **Not integrated** |
| WebRTC audio | **Not implemented** |

Second Life's native viewer uses **Vivox** (signaling + media) via simulator caps (`VoiceSignalingRequest`, `ProvisionVoiceAccountRequest`, `ParcelVoiceInfoRequest`, `SpatialVoiceModerationRequest` - listed in `sl-caps.js` REGION_CAP_NAMES). Login returns a `voice-config` blob for the official client.

### Target behaviour (exploratory)

- **WebRTC-based** voice suitable for a browser viewer: capture mic, play spatial or channel audio, mute/deafen, push-to-talk optional.
- Parcel voice rules respected (voice disabled on parcel, restrict to parcel when flag set - see Land tab section 5).
- UI: status bar speaker icon, device picker, volume sliders, speaking indicator on radar/chat where possible.

### Open questions / research

- [ ] Does Agni still provision Vivox only, or is there a WebRTC-capable path via newer caps? Inspect login `voice-config` and region `VoiceSignalingRequest` responses on a test login.
- [ ] **WebRTC vs Vivox:** Vivox Web SDK in browser vs custom WebRTC SFU if LL exposes TURN/STUN/signaling URLs in caps.
- [ ] Spatial audio: FS uses Vivox positional channels; WebRTC may need simplified **non-spatial** channel per region/parcel for v1.
- [ ] Autoplay / mic permission: browser `getUserMedia` requires user gesture; gate first enable behind explicit "Join voice" click.
- [ ] Bridge role: likely **no** audio through PHP bridge - direct client <-> voice service WebSocket/WebRTC; bridge only for cap URL discovery if needed.

### Implementation plan (high level)

- [ ] `js/protocol/sl-voice.js` - cap discovery, session join, channel/parcel mapping.
- [ ] `js/audio/voice-webrtc.js` - `RTCPeerConnection` / signaling client, mute, device selection.
- [ ] Settings: enable voice, input/output device, push-to-talk key.
- [ ] Integrate with radar (speaking indicator) when protocol provides speaking state.
- [ ] Fallback: voice disabled with clear message if caps or WebRTC unavailable.

### Firestorm file index

| Area | Primary files |
|------|----------------|
| Voice manager | `indra/newview/llvoicevivox.cpp`, `llvoiceclient.cpp` |
| Parcel voice info | `ParcelVoiceInfoRequest` handling in `llviewerparcelmgr.cpp` |
| Voice UI | `indra/newview/llfloatervoicecontrols.cpp` |
| Caps | `VoiceSignalingRequest`, `ProvisionVoiceAccountRequest` in region cap grant |

---

## 13. Bridge security - audit findings & hardening

Full code audit (2026-07) of the PHP bridge (`daemon.php`, `caps.php`, `poll.php`, `run.php`) and the client transport. This replaces the earlier "live verification" checklist. An automated pass once tried to implement that checklist, over-reached (a blanket token broke `<img>`-loaded map tiles and the caps -> poll cross-origin), and was reverted - so **none of the hardening is in the code today**, and the env knobs the old checklist named (`FS_BRIDGE_CORS_ORIGIN`, `FS_BRIDGE_OPENSIM_PORTS`) do not exist. The original concerns were sound; only the execution regressed. This section records what is actually true now and how to fix it without breaking the viewer.

### Why the earlier attempt broke, and the constraints any fix must respect

The concerns were sane - wildcard CORS, an unauthenticated `/proxy`, and a launcher that force-kills foreign processes are all real. They just have to be fixed surgically:

- **Map tiles and favicon load via `<img src>`** (`ui/map.js`), which cannot send an `X-Minibee-Token` header. A token required on every endpoint kills the map. Any token must be scoped to `/proxy`, `/login`, `/circuit/*` only.
- **The viewer (caps, 8794) calls poll (8795) cross-origin.** ACAO must keep allowing the caps origin on the poll server; a single wrong value breaks the circuit lane.
- **Proxy targets are diverse:** `simhost-*.agni/aditi.secondlife.io`, `*.secondlife.com`, and raw OpenSim `host:port`. An allowlist that is too tight blocks login/teleport. It must cover all three, and be configurable for OpenSim (no OpenSim host config exists today).

### Threat model

The TCP bind is `127.0.0.1` only, which keeps LAN peers out, but the realistic attacker is **any web page the user has open**. With wildcard CORS, no auth, and no `Host`/`Origin` validation, that page can drive the bridge and read the responses; a DNS-rebinding record pointing at 127.0.0.1 removes even the CORS barrier. Local malware is out of scope (it already owns the machine).

### Findings

| # | Sev | Issue | Where |
|---|-----|-------|-------|
| A | High | **Unauthenticated SSRF.** `/proxy` fetches a client-supplied `url` with no egress allowlist; only `simhost-*` hosts get IP-pinned, everything else is fetched as-is and the body is returned to the caller (GET and POST). | `handle_request` `/proxy`, `normalize_seed_url`, `proxy_simhost_curl_opts` |
| B | High | **Wildcard CORS** (`Access-Control-Allow-Origin: *`) on every response, so any origin can read `/health`, `/proxy`, `/map`, etc. | `cors_header_array` |
| C | High | **No DNS-rebinding guard.** The `Host` header is never validated, so a rebound hostname is treated as same-origin and bypasses CORS entirely. This is the amplifier that makes A/B/D remotely exploitable. | `parse_bridge_http_request`, `bridge_apply_request_context` |
| D | Med | **No CSRF/Origin check on state-changing endpoints.** A page can `POST /circuit/open` then `/circuit/send` to emit arbitrary UDP to any `host:port` (UDP SSRF / scan / reflection), and `POST /login` to send login XML to any URL. | `handle_request` circuit + login |
| E | Med | **Secondary SSRF** via `/map/tile?server=` (arbitrary host, fixed `/map-*-objects.jpg` suffix) and the client-supplied `/login` `url`. | `fetch_map_tile`, `/login` |
| F | Med | **JSONP still live.** `resolveRegionByName` runs `fetchRegionByNameCap` in parallel with the safe bridge lookup, injecting `<script src="https://cap.secondlife.com/...">` and executing remote JS in the page origin. Redundant with `/map/region-by-name`. | `sl-slurl.js`, `sl-transport.js` |
| G | Med | **Launcher force-kills foreign processes.** `bridge_kill_port_listeners` runs `taskkill /F` on whatever holds 8794/8795 with no Minibee check, no confirmation, and no `MINIBEE_FORCE_PORT` gate or PID file. | `run.php` |
| H | Low/Med | **Unbounded request body.** Once `Content-Length` is set there is no size cap; the read buffer grows to whatever the client declares (local memory DoS). | `bridge_request_complete` |
| I | Low/Med | **CA trust-on-first-use.** The first `cacert.pem` download runs with `SSL_VERIFYPEER=false` when no system CA exists, so a MITM could poison the bundle. Only triggers when no CA is present. | `download_ca_bundle` |
| J | Low | **Static prefix check** uses `str_starts_with($candidate, $root)` without a trailing separator (sibling-dir escape). Low impact given the `/`, `/favicon.ico`, `/js/*`, `/css/*` routing. | `serve_static_file` |
| K | Low | **Secrets in URL query.** GET `/proxy` and `/circuit/poll` carry `agentSessionId` / `sessionId` in the query string (logs, history) instead of a header/body. | `bridge.js` `proxyGet`, `poll` |
| L | Low | **No Content-Security-Policy** on served HTML - no defence-in-depth behind the many `innerHTML` sinks, and nothing blocking the JSONP in F. | `serve_static_file` |

### Already sound (do not regress)

- TCP server binds `127.0.0.1` only.
- TLS verification is on by default everywhere (`SSL_VERIFYPEER=true`, `VERIFYHOST=2`) for login, proxy, map, and destinations.
- No credential logging; the password is only MD5'd into the login XML (`sl_login_passwd`) and never persisted.
- Inbound UDP is source-validated (`sim_packet_matches`); manual redirect handling refuses cross-host redirects off `simhost-*`.
- XSS discipline: `escapeHtml` is applied at the `innerHTML` sinks (chat / IM / search / etc.), and `linkify` is safe (`href="#"` + escaped `data-slurl`, no `javascript:` sink).
- Destinations feed is allowlisted; the client has one fetch choke point (`_fetchDirect`) so a token is a one-line addition.

### Remediation (ordered, non-breaking)

- [ ] **Host allowlist (kills DNS rebinding, fixes C).** Reject any request whose `Host` is not `127.0.0.1:PORT` / `localhost:PORT`. Applies to every endpoint including `<img>` loads; single highest-value fix.
- [ ] **Origin check on sensitive endpoints (D).** For `/proxy`, `/login`, `/circuit/*`: allow only a missing `Origin` (non-browser / same-origin) or the exact viewer origin; reject foreign origins. Leave asset GETs to the Host check.
- [ ] **Tighten CORS (B).** Poll (8795) returns `Access-Control-Allow-Origin: <caps origin>` (env-configurable), not `*`; caps is same-origin so drops `*`.
- [ ] **`/proxy` egress allowlist (A, E).** Permit only `*.secondlife.io` (incl. `simhost-*`), `*.secondlife.com`, `*.lindenlab.com`, and the configured OpenSim `host:port`; deny RFC1918 / loopback / link-local / ULA IPs; deny redirects that leave the allowlist. Keep it wide enough for Agni + Aditi + OpenSim (this is where the last attempt over-restricted). Apply the same host check to `/map/tile?server=` and the `/login` url.
- [ ] **Token as defence-in-depth (optional).** One secret **per bridge run** (not per account - it authenticates the Minibee page/origin, and at page-serve time no account exists yet). caps injects it into the page; `_fetchDirect` adds `X-Minibee-Token`; enforce on `/proxy`, `/login`, `/circuit/*` **only** - never on static, `/map/tile`, or `/favicon.ico` (those load via `<img>` and cannot set headers).
  - Both processes must share it (poll validates `/circuit/*`, caps validates `/proxy` + `/login`). Prefer `run.php` minting it once and passing via env to both children; **no file needed**.
  - Fallback when `poll.php` / `caps.php` are started separately: a file **keyed by port** (e.g. `bridge/.minibee-<capsPort>.token`, locked-down perms, in `bridge/` not the shared temp dir) so parallel bridge instances on different port pairs never collide. Precedent: the cookie jar is already `fs_bridge_cookies_<pid>.txt`.
  - **Multi-account / multi-tab:** N accounts in N tabs share one bridge, one origin, and therefore one token - this is fine. Per-account secrecy for circuit ops is already provided by the server-generated circuit `sessionId` + `agentSessionId`, so a per-account token is neither needed nor workable.
- [ ] **Remove JSONP (F).** Drop `fetchRegionByNameCap`; rely on the bridge `/map/region-by-name`.
- [ ] **Fix the launcher (G).** Never kill a process not confirmed as our own `poll.php` / `caps.php`; if the port is held by something else, print the PID and exit 1; gate any kill behind `MINIBEE_FORCE_PORT=1`; add a `bridge/.minibee.pid` for "already running" detection.
- [ ] **Cap request size (H).** Reject bodies over a few MB in `bridge_request_complete`.
- [ ] **Add a CSP (L).** `default-src 'self'` plus the bridge origins and SL image/map hosts; removing JSONP lets `script-src` stay tight.
- [ ] **Hygiene:** move `agentSessionId` / `sessionId` out of the GET query into headers/body (K); add the trailing separator to the static root check (J); prefer a system CA (`FS_BRIDGE_CACERT` / `SSL_CERT_FILE`) to avoid the trust-on-first-use path (I).

### Live verification (after a fix + `Ctrl+Shift+R`)

- [ ] `curl -i` to `/health` from a foreign `Origin:` - response not readable cross-origin (no `*`).
- [ ] `curl` with `Host: evil.com` - rejected (rebinding guard).
- [ ] `POST /proxy` with `url=http://169.254.169.254/` or `url=http://127.0.0.1:9000/` - blocked; `simhost-*.agni.secondlife.io` still reaches sim caps.
- [ ] Agni + Aditi login, teleport / cross-region, and OpenSim login all still work (seed caps, EventQueue, `GetDisplayNames`, remote parcel).
- [ ] Map tiles still render (still `<img>`, no token needed); region-name lookup works with no `cap.secondlife.com` `<script>` in DevTools.
- [ ] Second `start-minibee.bat` with a foreign process on 8794/8795 - names the PID, exits 1, no `taskkill`, no new browser tab.

---

## 14. Caching - resolve once, reuse everywhere

### Principle

Cache any value that is expensive to fetch and stable enough to reuse, provided caching cannot serve wrong data. Resolve a datum once (name, group, parcel, tile, profile) and reuse it across every surface (chat, IM, radar, buddies, land, map, search) instead of re-requesting it. When in doubt prefer a short TTL over no cache, and never cache values that must always be live. This should be a default habit, not a per-feature afterthought.

### Already cached

- **Agent names / display names:** in-memory `nameCache` Map in `sl-transport.js` (`cacheName` / `cacheNameInfo` / `getCachedName`), filled from `GetDisplayNames`, `UUIDNameReply`, and IM/chat `FromName`; batched via `queueNameResolve`; cleared on logout. Feeds `pickDisplayName` and `refreshNamedEntities`.
- **Region-name lookups:** client-side de-dupe so the same region is not looked up twice over HTTP (see section 13, finding F).

### Candidates to cache (safe, high value)

| Data | Source | Cache key | Notes / invalidation |
|------|--------|-----------|----------------------|
| Group names | `GroupProfileReply` / group-name cap / `AgentGroupDataUpdate` | group UUID | Partially cached via `sl-profiles.js` when profiles are opened; land tab may still show UUID until resolved. |
| Group membership + roles | `AgentGroupDataUpdate` | self | Changes on join/leave; refresh on the next `AgentGroupDataUpdate`. |
| Avatar profile (about, born, picks) | `AvatarPropertiesReply` / `AgentProfile` cap | agent UUID | **Implemented** in `sl-profiles.js` with cap-first merge and 15 min stale window. |
| Avatar thumbnails / profile images | `AgentProfile` cap texture id | agent / texture UUID | In-memory per session; buddies auto-fetch; optional `localStorage` TTL still TODO. |
| Parcel / region info | `ParcelProperties` / `ParcelInfoReply` / `RemoteParcelRequest` | parcel UUID or (region, localId) | Invalidate on parcel update and on region cross. |
| Map tiles | map image server | (grid x, y, zoom) | Immutable per zoom level; long-lived. |
| Landmark / place names | `ParcelInfoReply` | parcel UUID | Stable. |

### Do NOT cache (or only very briefly)

- **Online / presence state** - must track live radar and buddy updates.
- **Agent position / current region** - changes constantly.
- **Security-sensitive values** - session ids, tokens, and caps URLs (caps rotate per region and per teleport).
- **Session moderator / mute state** - authoritative from `ChatterBoxSessionAgentListUpdates`.

### Persistence options

- **In-memory `Map`** (current approach): simplest, resets each session. Good default for most data.
- **`localStorage` / `IndexedDB` with a stored `fetchedAt` + TTL:** survives reloads; use for expensive, stable data (names, group names, profile images). Always expire on read, version the store so a schema change invalidates it, and never persist secrets.

### Implementation notes

- Centralise each datum behind one get-or-fetch helper with in-flight de-dupe so concurrent callers share a single request - `queueNameResolve` already batches name lookups; mirror that pattern for groups and profiles.
- Every cache needs a clear on logout (like `nameCache.clear()`), plus targeted invalidation on the update packet that supersedes it.
- Prefer lazy population (fetch on first need) over eager pre-fetch, except when a batch reply is already in hand (e.g. resolve all roster ids in one `GetDisplayNames` call).

---

*Last updated Jul 2026 - avatar profiles working (`AgentProfile` cap, profile floater); group profiles partial; group IM, caching, and bridge security audit (section 13).*
