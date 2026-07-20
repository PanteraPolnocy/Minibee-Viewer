# Minibee Viewer (JS Experiment)

Pure JavaScript / HTML / CSS / PHP UI for Second Life - chat, IM (1:1, group, and conference), events, search, radar, map, land, destination guide, and teleport. No 3D rendering.

## Important notice

Minibee is **experimental software** - a lightweight work-in-progress, not a finished or official Second Life client. It is not endorsed by Linden Lab or the Firestorm team.

**You choose to use it at your own responsibility.** That includes logging in, spending Linden dollars, accepting script permissions, opening URLs, and any other actions you take in-world. The code has been written carefully and in good faith, with attention to protocol correctness and sensible safety defaults (for example, script dialogs and permission prompts require an explicit tap before anything is sent back to the simulator). Even so, experimental code can have gaps, bugs, or behaviour that does not match a full viewer.

Please treat Minibee accordingly: helpful for exploration and testing, not something to rely on blindly for critical account activity.

## Repository layout

```
Minibee-Viewer/
  README.md              Project overview (this file)
  LICENSE                LGPL 2.1
  SECURITY.md            Vulnerability reporting
  CODE_OF_CONDUCT.md
  CONTRIBUTING.md
  viewer/                Minibee viewer and PHP bridge
    index.html           Shell, login screen, side navigation
    css/app.css          Styles (dark/light themes)
    js/                  Client application and SL protocol
    bridge/              PHP bridge (poll + caps)
    screenshots/         UI screenshots
    start-minibee.bat    Windows launcher
```

All commands below assume you are in the `viewer/` directory unless noted otherwise.

## Quick start

Browsers cannot speak SL's UDP protocol or call `login.cgi` directly (CORS). Run the **PHP bridge** on the same machine as the browser:

```bat
cd viewer
start-minibee.bat
```

Or one command (single terminal):

```bat
cd viewer
php bridge/run.php
```

`start-minibee.bat` and `run.php` start **poll** in the background and **caps** in the foreground in the **same window**. Ctrl+C stops both. `start-minibee.bat` also opens **`http://127.0.0.1:8794/`** in your default browser when the bridge is ready.

To debug poll alone: `php bridge/poll.php` in a separate terminal (from `viewer/`).

Requires PHP with **curl** and **sockets** enabled. The batch file tries `php` on PATH first, then falls back to loading curl/sockets from the PHP install directory if extensions are not loaded by default.

Optional override when `php` is not on PATH:

```bat
set FS_BRIDGE_PHP=C:\path\to\php.exe
start-minibee.bat
```

**SSL / CA certificates:** Minibee does **not** ship a CA bundle (Mozilla's PEM is [MPL 2.0](https://curl.se/docs/caextract.html)). On startup the bridge tries to download it from [curl.se](https://curl.se/ca/cacert.pem) into `bridge/cacert.pem` (etag-aware, per curl's recommended method). The viewer also attempts this when you open the login screen or log in.

Check status (from `viewer/`):

```bat
php bridge/daemon.php --check-ca
php bridge/daemon.php --fetch-ca
```

If auto-download fails, the viewer shows a modal with manual steps. You can also set `FS_BRIDGE_CACERT`, `SSL_CERT_FILE`, or `CURL_CA_BUNDLE` to an existing system CA bundle.

### Opening the viewer

Run **`viewer/start-minibee.bat`** (Windows) or **`php bridge/run.php`** from `viewer/`. The batch launcher opens **`http://127.0.0.1:8794/`** automatically once the bridge is listening. You can also open that URL yourself at any time.

Do **not** open `viewer/index.html` directly from the filesystem (`file://`). The viewer blocks that and shows instructions to use the bridge URL instead.

Pick a grid (Agni, Aditi, or local OpenSim), enter credentials, and log in.

After code or bridge changes: **hard-refresh** the page (`Ctrl+Shift+R`) and **restart both bridge processes** (poll + caps).

## Architecture

```
viewer/
  index.html + css/app.css       Shell, login screen, side navigation
  js/app.js                      Bootstrap and event wiring
  js/serve-guard.js              Block file://; require HTTP(S)
  js/settings.js                 Local preferences (localStorage, theme)
  js/state.js                    Shared UI/session state and unread counts
  js/errors.js                   Error log and diagnostics
  js/ui/chat.js                  Nearby chat composer and rendering
  js/ui/im.js                    IM, group & conference chat, roster, typing, moderation, pay dialog
  js/ui/events.js                Script dialogs, permissions, prompts, payments
  js/ui/buddies.js               Friends list and context actions
  js/ui/search.js                People / places / groups search UI
  js/ui/radar.js                 Coarse nearby avatars, range, alerts
  js/ui/map.js                   World map, teleport, teleport home
  js/ui/land.js                  Parcel view and edit
  js/ui/destinations.js          Destination Guide feeds
  js/ui/teleport.js              Incoming teleport offer/request prompts
  js/ui/errors.js                Log tab (diagnostics + settings browser)
  js/ui/navigation.js            Tab switching, top bar, badges, SLT clock
  js/ui/session-lost.js          Disconnect overlay and offline browse mode
  js/ui/panel-busy.js            Per-panel loading overlays
  js/ui/profile.js               Avatar and group profile floater
  js/ui/avatar-thumb.js          Shared profile image thumbnails in lists
  js/protocol/sl-transport.js    Live SL session (login, circuit, caps, teleport)
  js/protocol/sl-profiles.js     Avatar/group profile fetch, cache, and cap merge
  js/protocol/sl-packet.js       UDP message codec and circuit
  js/protocol/sl-login.js        XML-RPC login + MFA/TOS challenge loop
  js/protocol/sl-caps.js         Seed capabilities, display names, remote parcel
  js/protocol/sl-eventqueue.js   EventQueueGet (parcel + teleport lifecycle)
  js/protocol/sl-search.js       Directory search (UDP + caps)
  js/protocol/sl-slurl.js        SLURL / map coordinate helpers
  js/protocol/sl-teleport.js     Teleport flags, lure buckets, SLURL helpers
  js/protocol/bridge.js          HTTP client (caps 8794 + poll 8795, priority lane)
  js/version.json                Viewer version metadata (channel, semver, build)
  js/version.js                  Loads version.json for login label and bridge user-agent
  bridge/poll.php                UDP circuit relay (127.0.0.1:8795)
  bridge/caps.php                Login proxy + UI + map (127.0.0.1:8794)
  bridge/daemon.php              Shared core (library; use --check-ca / --fetch-ca only)
  bridge/run.php                 One-terminal launcher (poll child + caps foreground)
  start-minibee.bat              Windows launcher (poll + caps + browser)
```

The bridge runs as **two processes** for isolation:

| Process | Port | Role |
|---------|------|------|
| **poll** | 8795 | UDP circuit: `/circuit/poll`, send, exchange - never blocked by caps |
| **caps** | 8794 | Viewer UI, login, `/proxy`, map, destinations |

The JS client sends circuit traffic to poll on a **priority lane** (immediate fetch) and everything else to caps. Each process uses concurrent HTTP internally (`stream_select`; caps uses `curl_multi` for proxy). EventQueue long-polls are **single-flight** per session so reconnects do not orphan sim-side polls.

### Connection flow

1. `POST /login` - XML-RPC `login_to_simulator` (optional seed cap grant in the same response)
2. `POST /circuit/open` - local UDP socket toward `sim_ip:sim_port`
3. Handshake - `UseCircuitCode`, `CompleteAgentMovement`, etc. via `/circuit/send` and `/circuit/exchange`
4. `GET /circuit/poll` - receive chat, IM, radar, parcel packets
5. HTTP caps - presence caps (`GetDisplayNames`, etc.) at login; land caps deferred until the Land tab is opened
6. `EventQueueGet` - started when a teleport is in progress; delivers `TeleportFinish`, `CrossedRegion`, etc.

Use the **Log** tab (protocol diagnostics) when debugging parcel or UDP issues (`pkts`, `udp` counters on parcel lines). The Log tab also has a **Settings** subtab for saved preferences (non-secret keys only).

### Lazy tab loading

Tabs fetch and render their data only when you open them. This keeps login light and avoids unnecessary bridge traffic:

- **Chat / IM / Events / Buddies / Radar** - render on first visit; UDP data still flows in the background once connected
- **Search** - directory queries run when you submit a search
- **Map** - tiles and region names load when the Map tab is active
- **Land** - parcel refresh and land HTTP caps run when the Land tab is opened
- **Guide** - destination feeds load on first visit
- **Log** - error log and settings browser render when opened

## Features

| Feature | Status |
|---------|--------|
| Login (Agni / Aditi / local) | Yes |
| MFA / TOS / critical prompts | Yes (login dialog) |
| Dark / light theme | Yes (top bar toggle; saved locally) |
| Nearby chat | Yes (UDP) |
| Events tab (scripts, prompts, payments) | Yes (separate from chat; unread badge) |
| Script dialogs / permissions | Yes (Events cards; no auto-reply) |
| LoadURL / map prompts / friendship offers | Yes (Events cards; user confirms) |
| Linden dollar balance | Yes (top bar; `MoneyBalanceReply`) |
| SLT clock | Yes (top bar, US Pacific) |
| IM (send and receive) | Yes (UDP) |
| Group chat | Yes (`IM_SESSION_GROUP_START`; sim-streamed session; group name from membership cache) |
| Conference (ad-hoc) chat | Yes (`ChatSessionRequest` cap; invite participants) |
| Session roster + moderation | Yes (live member list; moderator text mute; roster refresh on reopen) |
| Typing indicators | Yes (1:1; `IM_TYPING_START/STOP`) |
| IM pay resident | Yes (L$ transfer dialog) |
| Close / leave / dismiss conversation | Yes (P2P dismiss keeps history; group/conference leave server-side) |
| Buddies + display names | Yes (`GetDisplayNames` cap) |
| Buddy teleport offer / request | Yes (context menu) |
| Remove friend | Yes (buddies context menu + profile; confirmation prompt) |
| Avatar profiles | Yes (`AgentProfile` cap + UDP; about, picks, classifieds, notes) — **own profile groups list incomplete** (hidden memberships; see Limitations) |
| Group profiles | Yes (charter, insignia, join / leave, activate, YOUR TITLE + ACTIVE TITLE picker + save, open group chat when member) |
| Avatar thumbnails in lists | Partial (buddies resolve profile images; others show initials) |
| Search - people | Yes (UDP directory + avatar cap; profile + IM from results) |
| Search - places | Yes (UDP directory; show on map, expandable details) |
| Search - groups | Yes (UDP directory; open group profile) |
| Radar (coarse positions) | Yes (`CoarseLocationUpdate`; filter, range, optional alerts) |
| World map + tiles | Yes (map server JPEG tiles via bridge) |
| Region lookup / SLURL | Yes (map location field, linkified chat/IM) |
| Manual teleport | Yes (map selection, Destination Guide, `Teleport Here`) |
| Teleport home | Yes (map sidebar button) |
| Teleport progress | Yes (stage label + percentage on busy buttons) |
| Sim-initiated teleport | Yes (force / god / home / death; not plain lure offers) |
| Destination Guide | Yes (Linden feeds: suggested, popular, new, editor, events) |
| Session disconnect detection | Yes (modal overlay; browse offline; gentle status/logout pulse) |
| Unread badges | Yes (chat, IM, events counts; radar/land/log indicators) |
| Land parcel view/edit | Partial (owner parcels; HTTP + UDP parcel data) |
| Teleport offers / requests | Partial (IM accept/decline prompts; buddy send) |
| 3D world / inventory / attachments | No |

## Shell and navigation

- **Side navigation** - Chat, IM, Events, Buddies, Search, Radar, Map, Land, Guide, and Log tabs along the left edge.
- **Top bar** - connection status dot beside agent name (vertically aligned), agent name (click to open your profile when connected), **active group title** under the name (or "No active group title"; group name is not shown here), parcel name and region, L$ balance, SLT clock, sim FPS, theme toggle, logout.
- **Unread badges** - numeric badges on Chat, IM, and Events; dots on Radar (new avatars in range), Land (parcel updated), and Log (new errors). Incoming IM increments the IM badge without switching tabs automatically.

## Chat and Events

**Chat** is for nearby conversation and system lines (including login MOTD). **Events** holds interactive items that need a deliberate response:

- Script dialogs and text boxes
- Script permission requests
- LoadURL, map, and friendship prompts
- Payment / economy notices (deduplicated when the sim retries the same transaction)

Nothing in Events auto-replies. Unresolved items increment the Events badge until you open the tab.

## Instant messages

The **IM** tab handles 1:1, group, and conference conversations in one list:

- **1:1 IM** - direct `ImprovedInstantMessage`; shows a "typing..." indicator while the other person composes. Closing a 1:1 conversation hides it from the list but keeps message history; it reopens when you or they message again.
- **Notifications** - new IMs raise the IM badge on the side nav; Minibee does **not** switch tabs automatically. Open IM when you want to read.
- **Group chat** - open from the Land tab's parcel group, a group profile, or when another member starts chatting; the simulator streams messages to members over UDP (`IM_SESSION_GROUP_START`). Session title resolves from your group membership, not the binary bucket.
- **Conference chat** - start an ad-hoc session from the IM tab or a buddy's context menu; incoming invitations are accepted through the `ChatSessionRequest` capability. Use **Invite** to add more people to an open conference.
- **Roster** - a collapsible member sidebar lists participants with online state and resolved display names; click a member to open a 1:1 IM. Reopening group chat requests the roster from the sim and seeds from recent participants.
- **Moderation** - session moderators can mute or unmute a participant's text (`ChatSessionRequest` "mute update"). Moderator status comes from the sim roster (`is_moderator` on `ChatterBoxSessionAgentListUpdates`), not from group role data in the profile floater.
- **Mute** - silence a noisy session locally so it stops raising the unread badge; **Leave** exits a group or conference server-side.

## Profiles

Open a resident or group profile from **Search**, **Buddies**, **Radar**, **IM**, **Chat** (speaker name), **Land** (owner / group links), or the **top bar** (your own name).

**Avatar profiles** load through the `AgentProfile` HTTP cap when available (full about text, up to ~64 KB) with UDP `AvatarPropertiesReply` as a fallback for smaller fields. The floater includes:

- Display name and username in the header; account level (membership tier) in the subtitle
- Resident tab: profile photo, born date, partner, payment info, about text (scrollable), groups list
  - **Your own profile:** should list every membership (including hidden) with the active group bold — **not working yet** (see Limitations)
  - **Other residents:** profile-visible groups only
- Places, Classifieds, Web, More (First Life), and Notes tabs when data is present
- Pick / classified detail: resolved parcel + region location, map preview, teleport (closes profile like Destination Guide)
- Actions: IM, Pay, Offer teleport, Request teleport, Add friend / Remove friend (with confirmation)

**Group profiles** show name, charter, insignia, enrollment flags, member count, and founder (linked name when resolved). Members can:

- Open group chat from the profile
- **Activate** the group (`ActivateGroup`; confirmed via `AgentDataUpdate`)
- **Your title** and **Active title** sections: pooled titles from `GroupTitlesRequest`, pick in a dropdown, **Save** (`GroupTitleUpdate`)
- **Join** or **Leave** with confirmation (`JoinGroupRequest` / `LeaveGroupRequest`)

Non-members can join when enrollment is open (fee shown in the join prompt).

Profile images in list rows are resolved for **buddies** only (to limit sim traffic); other surfaces show initials until you open the full profile or the image is already cached (`localStorage` TTL, 7 days).

## Search

The **Search** tab queries the simulator directory over UDP (minimum three characters):

| Category | Results | Actions |
|----------|---------|---------|
| **People** | Residents by username | Open profile; start IM |
| **Places** | Regions, parcels, destinations | Show on map; expand for description and traffic |
| **Groups** | Group names and member counts | Open group profile |

Avatar hits are enriched with `GetDisplayNames` when the cap is available. Radar entries are also searched locally for quick matches.

## Map and teleport

- **Map** - pan, centre on avatar (`@`), click a region tile to select, enter a SLURL or region name and **Show on map**, then **Teleport Here** or **Teleport Home**.
- **Invalid region names** - map does not move; you get a toast instead of centring on a bogus location.
- **SLURLs** in chat and IM open the map tab with the location pre-filled.
- Region names on the map are resolved via sim `MapBlock` UDP and HTTP region lookup where available.
- **In-progress teleports** - the teleport button shows stage and percentage; clicking again does not cancel an outbound teleport.

### Teleport types

| Type | Behaviour |
|------|-----------|
| **Manual** (map, SLURL, Guide) | Viewer sends `TeleportLocationRequest`; waits for `TeleportStart` / `TeleportFinish`. |
| **Home** (map button) | `DataHomeLocationRequest`; arrival uses home region coordinates and name. |
| **Lure offer** (IM) | Prompt to accept or decline; accepting sends `TeleportLureRequest`. Does **not** auto-teleport. |
| **Force / god / sim-initiated** | `TeleportStart` from the sim with non-lure flags (godlike, 911, force redirect, home, etc.) is followed automatically. |

## Radar

Coarse avatar positions from `CoarseLocationUpdate`. Filter by name, adjust range with the slider (avatars beyond range are dimmed, not hidden), and optionally enable **Alerts** for toast notifications when someone new enters range.

## Land

Standing parcel data comes from UDP `ParcelProperties` and HTTP `RemoteParcelRequest` (name, area, flags, owner). Open the Land tab or tap refresh to request an update.

Prim **capacity** is taken from UDP when available; otherwise it is estimated from parcel area (15 prims per 512 m2). Prim **usage** requires UDP counts from the sim. Check Log -> Diagnostics for lines like `prims=used/total` if the field looks wrong.

Editable fields (name, description, access, build/script flags) work on parcels you own; group land and others' parcels are view-only.

## Destination Guide

The **Guide** tab shows curated destinations from Linden Lab's public API (`worldaping.agni.lindenlab.com`), proxied through the bridge (`GET /destinations?feed=...`):

| Feed | Label |
|------|-------|
| `mobile` | Mobile |
| `popular` | Popular |
| `new` | New |
| `editor` | Editor |
| `events` | Events |

Each entry shows name, description, maturity rating, and thumbnail. Use **Map** or **Teleport** on a destination, or follow its SLURL. Teleport progress mirrors the map controls.

## Session disconnect

If the simulator drops the session (`LogoutReply`, kick, circuit loss, or bridge session 404), the viewer shows a **Connection lost** overlay. You can dismiss it to **browse offline** - read chat/IM/log history and switch tabs while grid actions stay disabled. The status dot and logout button use a slow gentle pulse as a reminder. Use **Return to Login** when ready to reconnect.

## Limitations

- No world rendering, inventory, attachments, or built-in movement beyond teleport
- **No RLV / RLVa** - Minibee does not implement Restrained Love viewer restrictions (`@getstatus`, folder locks, sit/touch blocks, etc.)
- Buddy names may show as UUID briefly until `GetDisplayNames` returns
- Avatar profile about text requires the `AgentProfile` cap; without it, about is limited to the UDP packet size (~512 bytes)
- **Own avatar profile — groups list** Groups with **Show in profile** disabled should still appear on **your** profile (muted styling); the active group should be **bold**. Code exists (`getProfileGroupsForDisplay`, bridge HTTP `AgentGroupDataUpdate` listener, `agentGroups` merge) but **end-to-end delivery is not working** — you typically only see cap-visible groups. Needs a proper fix; restart the bridge after `daemon.php` changes.
- List thumbnails resolve profile images for buddies only; radar, search, chat, and IM use initials unless the image is already cached
- Radar uses 1 m coarse positions from the sim
- Land prim usage depends on UDP `ParcelProperties`; capacity may be estimated from area when the sim does not send counts
- Bridge must run on localhost (`127.0.0.1:8794` / `8795`); close other SL viewers if UDP bind or circuit behaviour is odd. Restart poll + caps after bridge (`daemon.php`) updates.
- Windows Firewall must allow `php.exe` UDP if receive stays at zero packets
- Destination Guide requires the bridge (Linden API is fetched server-side to avoid browser CORS)

## Bridge files

All paths relative to `viewer/`:

| File | Purpose |
|------|---------|
| `bridge/poll.php` | UDP circuit relay (port 8795) |
| `bridge/caps.php` | Viewer UI, login, proxy, map (port 8794) |
| `bridge/daemon.php` | Shared PHP core: UDP circuit, cap proxy, **HTTP `AgentGroupDataUpdate` on circuit listen port** (`httpMessages` to JS) |
| `bridge/run.php` | One-terminal launcher (poll child + caps foreground) |
| `start-minibee.bat` | Windows launcher - starts poll + caps and opens the viewer |

No Composer, Node, or build step for the viewer itself.

## Reference

Message layouts follow Firestorm conventions. See `scripts/messages/message_template.msg` in the Firestorm repository.
