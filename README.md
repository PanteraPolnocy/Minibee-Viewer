# Minibee Viewer (JS Experiment)

A Second Life client with a JavaScript / HTML / CSS UI and a native Rust core (Tauri) - chat, IM (1:1, group, and conference), events, search, radar, map, land, destination guide, and teleport. No 3D rendering.

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
  src/                   Frontend (served by the app)
    index.html           Shell, login screen, side navigation
    css/app.css          Styles (dark/light themes)
    js/                  Client application and SL protocol
    screenshots/         UI screenshots
  src-tauri/             Native core (Rust)
    src/                 Transport, message codec, circuit, commands
    resources/           message_template.msg (bundled)
    tauri.conf.json      App config (single source of version)
```

## Quick start

Minibee is a desktop application: the UI runs in a WebView and the native
**Rust core** does everything a browser cannot — the SL UDP circuit, the
XML-RPC login, and cross-origin capability/map requests. The frontend talks to
the core over Tauri IPC (`window.__TAURI__.core.invoke`); there is no local HTTP
server and no separate bridge process to start.

Prerequisites (Windows):

- [Rust](https://rustup.rs) with the MSVC toolchain (`stable-x86_64-pc-windows-msvc`)
- Visual Studio Build Tools (**Desktop development with C++**)
- WebView2 runtime (preinstalled on Windows 11)
- Node.js (for the Tauri CLI)

Run in development:

```bat
cd Minibee-Viewer
npm install
npm run tauri dev
```

Release builds and installers are covered in **Build & distribute** below.

**Certificates:** TLS is validated against the operating system trust store, so
there is no CA bundle to download or configure.

### Opening the viewer

Launch the app with `npm run tauri dev` (or the built `Minibee-Viewer`
executable). Pick a grid (Agni, Aditi, or local OpenSim), enter credentials, and
log in. After frontend changes, reload the window; after Rust changes, restart
`npm run tauri dev`.

## Build & distribute

Version is defined once in `src-tauri/tauri.conf.json` (`productName` =
`Minibee-Viewer`, `version` = `0.5.1`); `src-tauri/Cargo.toml` mirrors it. Rust
edition 2024. The frontend is served live from `src/` in `dev` and **embedded
into the binary** for release builds.

Optimized standalone binary:

```bat
cd Minibee-Viewer/src-tauri
cargo build --release
```

Installers (recommended for sharing):

```bat
cd Minibee-Viewer
npm run tauri build
```

Artifacts, under `src-tauri/target/release/`:

| Artifact | Path | Notes |
|----------|------|-------|
| Standalone exe | `minibee-viewer.exe` | Windowed (~14 MB), frontend embedded; needs WebView2 already installed |
| NSIS setup | `bundle/nsis/Minibee-Viewer_0.5.1_x64-setup.exe` | **Recommended** — bootstraps WebView2, adds Start-menu shortcut + uninstaller |
| MSI | `bundle/msi/Minibee-Viewer_0.5.1_x64_en-US.msi` | For group-policy / enterprise deploys |

- **WebView2**: preinstalled on Windows 11 and updated Windows 10. The bare exe needs it present; the NSIS installer bootstraps it if missing.
- **Unsigned**: all builds are unsigned, so Windows SmartScreen shows an "unknown publisher" prompt (*More info → Run anyway*). A code-signing certificate (configured in `tauri.conf.json`) removes it.
- **Console**: `target/debug` exes show a console window (logs); the release exe and installers are windowed with no console (`main.rs` `windows_subsystem = "windows"` in release).

### Icons

The app icon is defined once in `tauri.conf.json` `bundle.icon` and applies to
every target — the Windows exe, the macOS `.app`/DMG (`icon.icns`), and Linux
`.deb`/`.rpm`/AppImage (PNGs). Assets live in `src-tauri/icons/`: `32x32.png`,
`64x64.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.icns`,
`icon.ico` (plus `android/` and `ios/` sets for future mobile targets).

- NSIS setup `.exe` icon: `bundle.windows.nsis.installerIcon` → `icons/icon.ico`.
- MSI: the `.msi` file's own icon is fixed by Windows Installer and cannot be changed; its Add/Remove Programs entry uses the app icon.
- NSIS header/sidebar and WiX banner/dialog graphics need `.bmp` files (none shipped), so they stay at Tauri defaults.

## Architecture

```
src/
  index.html + css/app.css       Shell, login screen, side navigation
  js/app.js                      Bootstrap and event wiring
  js/serve-guard.js              Block file://; require the app WebView
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
  js/protocol/bridge.js          IPC client (invoke + event subscription)
  js/version.js                  Loads version from the native core (bridge_version)
```

The native core (`src-tauri/`) is one async backend (tokio). Because circuit
receipt, cap requests, and login all run concurrently, a long capability call
never blocks incoming chat/IM/radar packets. A single pooled HTTP client reuses
TLS/keep-alive connections across cap calls, and EventQueue long-polls are
**single-flight** per session so reconnects do not orphan sim-side polls.

| Core module | Role |
|-------------|------|
| `codec/` | Message-template-driven encode/decode (every message, zerocoding) |
| `bridge/circuit` | UDP socket per session; decodes datagrams and pushes them to the UI as events; inbound trusted-message HTTP listener |
| `bridge/login` | XML-RPC `login_to_simulator` + seed-capability fetch |
| `bridge/proxy` | Capability HTTP proxy (redirects, simhost IP pinning, EventQueue lane) |
| `bridge/map` | Map tiles, region lookups, Destination Guide |

### Connection flow

1. `bridge_login` - XML-RPC `login_to_simulator` (seed cap grant fetched in the same call)
2. `sl_open_circuit` - local UDP socket toward `sim_ip:sim_port`
3. Handshake - `UseCircuitCode`, `CompleteAgentMovement`, etc. sent via `sl_send_raw`
4. Incoming packets arrive as `minibee-viewer://packet-raw` events (chat, IM, radar, parcel); high-frequency object/effect/sound floods the UI never uses are filtered out in the core first
5. HTTP caps via `bridge_proxy` - presence caps (`GetDisplayNames`, etc.) at login; land caps deferred until the Land tab is opened. LLSD responses are parsed in the core (`parseLlsd`) so the UI consumes structured data
6. `EventQueueGet` (through `bridge_proxy`) - started when a teleport is in progress; delivers `TeleportFinish`, `CrossedRegion`, etc.

### Where work runs (and roadmap)

The core owns transport, the message-template codec, the LLSD codec, login, and
caps. The WebView still *interprets* decoded UDP messages (turns them into UI
state). That interpretation is being moved into the core one message family at a
time - each step is independently verifiable and reversible; see
`src/_todo/to-do.md` §3 (P2) for the ordered plan.

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
| Remember / forget login | Yes (username + grid saved locally; **password never stored**; "Forget saved login & MFA token" button clears creds + all MFA tokens) |
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
| Teleport progress | Yes (full-screen lock with a centered progress bar while teleporting; also stage label + percentage on busy buttons) |
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
- **Own avatar profile — groups list** Groups with **Show in profile** disabled should still appear on **your** profile (muted styling); the active group should be **bold**. Code exists (`getProfileGroupsForDisplay`, the inbound `AgentGroupDataUpdate` HTTP listener in the native core, `agentGroups` merge) but **end-to-end delivery needs verification** — you typically only see cap-visible groups.
- List thumbnails resolve profile images for buddies only; radar, search, chat, and IM use initials unless the image is already cached
- Radar uses 1 m coarse positions from the sim
- Land prim usage depends on UDP `ParcelProperties`; capacity may be estimated from area when the sim does not send counts
- Close other SL viewers if UDP bind or circuit behaviour is odd
- Windows Firewall must allow the Minibee app's UDP if receive stays at zero packets
- Destination Guide is fetched by the native core (avoids WebView CORS)

## Native core

All paths relative to `src-tauri/src/`:

| File | Purpose |
|------|---------|
| `codec/template.rs` | Parses the bundled `message_template.msg` into a message registry |
| `codec/mod.rs` | Generic encode/decode + zerocoding for every message |
| `bridge/circuit.rs` | UDP socket per session; decodes datagrams to events; inbound `AgentGroupDataUpdate` HTTP listener |
| `bridge/login.rs` | XML-RPC `login_to_simulator` + seed-capability fetch |
| `bridge/proxy.rs` | Capability HTTP proxy (redirects, simhost IP pinning, EventQueue lane) |
| `bridge/map.rs` | Map tiles, region lookups, Destination Guide |
| `commands.rs` | Tauri command surface (`bridge_*`, `sl_*`) |

## Reference

The native core bundles Second Life's `message_template.msg` (from
`scripts/messages/message_template.msg` in the Firestorm repository) and drives
its codec from it, so every message in the template is supported.
