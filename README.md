# Minibee Viewer

A tiny Second Life client: a JavaScript / HTML / CSS interface running in a WebView, with a native **Rust** core (Tauri) doing the heavy lifting underneath. It does chat, IM (1:1, group, and conference), events, search, radar, map, land, the Destination Guide, and teleport.

What it does **not** do is render the 3D world. Minibee is the friend who comes to the party to talk to people and check the map, not to admire the furniture.

## Download

Just want to run it? Grab a prebuilt installer from the **[Releases](https://github.com/PanteraPolnocy/Minibee-Viewer/releases)** page. Want to build it yourself? Jump to [Build & distribute](#build--distribute).

Images to look at sit in the **[Screenshots](https://github.com/PanteraPolnocy/Minibee-Viewer/tree/main/src/screenshots)** directory.

## Read this first (the "use at your own risk" bit)

Minibee is **experimental software** — a lightweight work-in-progress, not a finished or official Second Life client. Linden Lab hasn't blessed it, and neither has the Firestorm team.

**Whatever you do in-world with it is on you** — logging in, spending L$, accepting script permissions, opening links, all of it. The code is written carefully and in good faith, with real attention to protocol correctness and sensible safety defaults (script dialogs and permission requests always wait for an explicit tap before anything goes back to the simulator — Minibee never answers on your behalf). But experimental code has rough edges, and it won't always behave like a full viewer.

Short version: great for exploring and testing, not the thing to bet your account on.

## What's in the box

```
Minibee-Viewer/
  README.md              You are here
  LICENSE                LGPL 2.1
  SECURITY.md            How to report a vulnerability
  CODE_OF_CONDUCT.md
  CONTRIBUTING.md
  src/                   Frontend (served by the app)
    index.html           Shell, login screen, side navigation
    css/app.css          Styles (dark/light themes)
    js/                  The client app + SL protocol
    screenshots/         UI screenshots
  src-tauri/             Native core (Rust)
    src/                 Transport, message codec, circuit, commands
    resources/           message_template.msg (bundled)
    tauri.conf.json      App config — and the single source of the version number
```

## Quick start

Minibee is a desktop app. The UI lives in a WebView; the native **Rust core** does everything a browser flat-out can't — the SL UDP circuit, the XML-RPC login, and the cross-origin capability/map requests. The two talk over Tauri IPC (`window.__TAURI__.core.invoke`). There's no local HTTP server and no separate bridge process to babysit.

You'll need (on Windows):

- [Rust](https://rustup.rs) with the MSVC toolchain (`stable-x86_64-pc-windows-msvc`)
- Visual Studio Build Tools (**Desktop development with C++**)
- WebView2 runtime (already on Windows 11)
- Node.js (for the Tauri CLI)

Then:

```bat
cd Minibee-Viewer
npm install
npm run tauri dev
```

Pick a grid (Agni, Aditi, or a local OpenSim), enter your credentials, and log in. Changed the frontend? Reload the window. Changed Rust? Restart `npm run tauri dev`.

**Certificates:** TLS is checked against the operating system's trust store, so there's no CA bundle to download or configure. One less thing.

## Build & distribute

The version number is defined **once**, in `src-tauri/tauri.conf.json`; `src-tauri/Cargo.toml` just mirrors it. Rust edition 2024. In `dev` the frontend is served live from `src/`; for a release build it's embedded straight into the binary.

Standalone optimized binary:

```bat
cd Minibee-Viewer/src-tauri
cargo build --release
```

Installers (what you actually want to hand to someone):

```bat
cd Minibee-Viewer
npm run tauri build
```

You'll find these under `src-tauri/target/release/`:

| Artifact | Path | Notes |
|----------|------|-------|
| Standalone exe | `minibee-viewer.exe` | Windowed (~14 MB), frontend embedded; needs WebView2 already installed |
| NSIS setup | `bundle/nsis/Minibee-Viewer_0.6.1_x64-setup.exe` | **Recommended** — bootstraps WebView2, adds a Start-menu shortcut + uninstaller; shows the LGPL license during setup |
| MSI | `bundle/msi/Minibee-Viewer_0.6.1_x64_en-US.msi` | For group-policy / enterprise deploys |

Installed copies also include `LICENSE` and `README.md` next to the app executable (configured in `tauri.conf.json` `bundle.resources`). The NSIS installer reads `bundle.licenseFile` for the license agreement page.

- **WebView2**: preinstalled on Windows 11 and current Windows 10. The bare exe needs it present; the NSIS installer fetches it if it's missing.
- **Unsigned**: the builds aren't code-signed, so Windows SmartScreen will do its "unknown publisher" song and dance (*More info → Run anyway*). A signing certificate (configured in `tauri.conf.json`) makes it stop.
- **Console window**: `target/debug` exes show a console with logs; the release exe and installers are windowed and quiet (`main.rs` sets `windows_subsystem = "windows"` in release).

### Icons

The app icon is set once in `tauri.conf.json` (`bundle.icon`) and applies everywhere — the Windows exe, the macOS `.app`/DMG (`icon.icns`), and Linux `.deb`/`.rpm`/AppImage (PNGs). The source assets live in `src-tauri/icons/`: `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.icns`, `icon.ico` (plus `android/` and `ios/` sets for a future mobile life).

- NSIS setup `.exe` icon comes from `bundle.windows.nsis.installerIcon` → `icons/icon.ico`.
- The `.msi` file's own icon is fixed by Windows Installer and can't be changed; its Add/Remove Programs entry uses the app icon.
- NSIS header/sidebar and WiX banner graphics need `.bmp` files (none shipped), so those stay at Tauri's defaults.

## Tests

Two unit-test suites cover the pure logic — the stuff you can check without a live grid:

```bat
cd Minibee-Viewer
npm test            REM JS  — node --test (frontend pure helpers)
npm run test:rust   REM Rust — cargo test (native core)
```

- **Rust** (`src-tauri/src/**`): the message codec + zerocoding, LLSD, URL matching (`urlmatch`), the `bridge_proxy` SSRF egress guard, address/UUID/seed-URL normalisation (`util`), map coord/region parsing, login (password hashing, XML-RPC build + response parse), and the version payload.
- **JS** (`test/*.test.mjs`): SLURL parsing, chat linkify + trust classification, region-coordinate math (`sl-slurl.js`), and the UDP wire primitives — UUID, zerocoding, message-id framing, vectors (`sl-binary.js`). The frontend modules are IIFEs, so the tests load them in a stubbed function scope and poke at the pure helpers without needing a DOM.

## How it's built

### The frontend (`src/js/`)

```
app.js                      Bootstrap and event wiring
serve-guard.js              Blocks file://; insists on running inside the app WebView
settings.js                 Local preferences (localStorage, theme)
state.js                    Shared UI/session state and unread counts
errors.js                   Diagnostics log (recording is opt-in)
audio/parcel-music.js       Parcel music stream player (top-bar control)
ui/chat.js                  Nearby chat composer + rendering
ui/im.js                    IM, group & conference chat, roster, typing, moderation, pay dialog
ui/events.js                Script dialogs, permissions, prompts, payments
ui/buddies.js               Friends list + context actions
ui/search.js                People / places / groups search UI
ui/radar.js                 Coarse nearby avatars, range, alerts
ui/map.js                   World map, teleport, teleport home
ui/land.js                  Parcel view + edit
ui/destinations.js          Destination Guide feeds
ui/teleport.js              Incoming teleport offer/request prompts
ui/errors.js                Debug tab (diagnostics + settings browser)
ui/navigation.js            Tab switching, top bar, badges, SLT clock
ui/session-lost.js          Disconnect overlay + offline browse mode
ui/panel-busy.js            Per-panel loading overlays
ui/profile.js               Avatar + group profile floater
ui/avatar-thumb.js          Shared profile thumbnails in lists
protocol/sl-transport.js    Live SL session (login, circuit, caps, teleport)
protocol/sl-profiles.js     Avatar/group profile fetch, cache, cap merge
protocol/sl-packet.js       UDP message codec + circuit
protocol/sl-login.js        XML-RPC login + MFA/TOS challenge loop
protocol/sl-caps.js         Seed capabilities, display names, remote parcel
protocol/sl-eventqueue.js   EventQueueGet (parcel + teleport lifecycle)
protocol/sl-search.js       Directory search (UDP + caps)
protocol/sl-slurl.js        SLURL / map coord helpers + chat link matching
protocol/sl-teleport.js     Teleport flags, lure buckets, SLURL helpers
protocol/bridge.js          IPC client (invoke + event subscription)
version.js                  Reads the version from the core (bridge_version)
```

### The core (`src-tauri/`)

One async backend (tokio). Because circuit receipt, cap requests, and login all run concurrently, a slow capability call can't stall incoming chat/IM/radar packets — the old "everything waits behind one HTTP request" problem is gone. A single pooled HTTP client reuses TLS/keep-alive connections across cap calls, and EventQueue long-polls are **single-flight** per session so a reconnect doesn't leave an orphaned poll haunting the sim.

| Module | Job |
|--------|-----|
| `codec/template.rs` | Parses the bundled `message_template.msg` into a message registry |
| `codec/mod.rs` | Generic encode/decode + zerocoding for every message |
| `bridge/circuit.rs` | One UDP socket per session; decodes datagrams into events; inbound trusted-message HTTP listener (validates the sender is the sim) |
| `bridge/login.rs` | XML-RPC `login_to_simulator` + seed-capability fetch |
| `bridge/proxy.rs` | Capability HTTP proxy (redirects, simhost IP pinning, EventQueue lane) + SSRF egress guard |
| `bridge/map.rs` | Map tiles, region lookups, Destination Guide |
| `urlmatch.rs` | Chat/IM link matching + trust classification (`bridge_linkify`; mirrors `LLUrlRegistry`) |
| `commands.rs` | The Tauri command surface (`bridge_*`, `sl_*`) |

### How a login actually happens

1. `bridge_login` — XML-RPC `login_to_simulator` (the seed cap grant comes back in the same call).
2. `sl_open_circuit` — a local UDP socket pointed at `sim_ip:sim_port`.
3. Handshake — `UseCircuitCode`, `CompleteAgentMovement`, and friends, sent via `sl_send_raw`.
4. Incoming packets arrive as `minibee-viewer://packet-raw` events (chat, IM, radar, parcel). The high-frequency object/effect/sound firehose that a no-3D client never uses is filtered out in the core first, so it never crosses into JS.
5. HTTP caps via `bridge_proxy` — presence caps (`GetDisplayNames`, etc.) at login; land caps wait until you open the Land tab. LLSD responses are parsed in the core so the UI gets structured data, not raw XML.
6. `EventQueueGet` (through `bridge_proxy`) — runs during a teleport and delivers `TeleportFinish`, `CrossedRegion`, and so on.

### Who does what (and where it's heading)

The core owns transport, the message-template codec, the LLSD codec, login, and caps. The WebView still *interprets* decoded UDP messages (turns them into UI state). That interpretation is being moved into the core one message family at a time — each step independently testable and reversible.

### The Debug tab

Open **Debug** for protocol diagnostics when parcels or UDP are misbehaving (watch the `pkts` / `udp` counters on parcel lines). Recording is **off by default** — flip the "Record diagnostics" toggle in the Debug header (or the `debugLogDiagnostics` setting) when you need it, so an idle viewer isn't logging a line on every EventQueue poll. Hard errors are always kept regardless. There's also a **Settings** subtab that lists your saved preferences (non-secret keys only).

### Lazy tabs

Tabs load their data only when you open them, so login stays quick and the bridge isn't doing busywork:

- **Chat / IM / Events / Buddies / Radar** — render on first visit; UDP keeps flowing in the background once you're connected
- **Search** — queries run when you submit one
- **Map** — tiles and region names load when the tab is active
- **Land** — parcel refresh + land caps run when you open the tab
- **Guide** — feeds load on first visit
- **Debug** — the log + settings browser render when opened

## Features at a glance

| Feature | Status |
|---------|--------|
| Login (Agni / Aditi / local) | Yes |
| Remember / forget login | Yes (username + grid saved locally; **password is never stored**; a "Forget saved login & MFA token" button wipes creds + all MFA tokens) |
| MFA / TOS / critical prompts | Yes (in the login dialog) |
| Dark / light theme | Yes (top-bar toggle; saved locally) |
| Nearby chat | Yes (UDP) |
| Events tab (scripts, prompts, payments) | Yes (separate from chat; has its own unread badge) |
| Script dialogs / permissions | Yes (Events cards; never auto-replies) |
| LoadURL / map prompts / friendship offers | Yes (Events cards; you confirm) |
| Linden dollar balance | Yes (top bar; `MoneyBalanceReply`) |
| SLT clock | Yes (top bar, US Pacific) |
| IM (send + receive) | Yes (UDP) |
| Group chat | Yes (`IM_SESSION_GROUP_START`; sim-streamed; group name from the membership cache) |
| Conference (ad-hoc) chat | Yes (`ChatSessionRequest` cap; invite participants) |
| Session roster + moderation | Yes (live member list; moderator text mute; roster refreshes on reopen) |
| Typing indicators | Yes (1:1; `IM_TYPING_START/STOP`) |
| IM pay resident | Yes (L$ transfer dialog) |
| Close / leave / dismiss conversation | Yes (P2P dismiss keeps history; group/conference leave server-side) |
| Buddies + display names | Yes (`GetDisplayNames` cap) |
| Buddy teleport offer / request | Yes (context menu) |
| Remove friend | Yes (buddies menu + profile; asks first) |
| Avatar profiles | Yes (`AgentProfile` cap + UDP; about, picks, classifieds, notes) — **own-profile groups list is incomplete**, see Limitations |
| Group profiles | Yes (charter, insignia, join / leave, activate, title picker + save, open group chat when a member) |
| Avatar thumbnails in lists | Partial (buddies resolve photos; others show initials) |
| Search — people | Yes (UDP directory + avatar cap; profile + IM from results) |
| Search — places | Yes (UDP directory; show on map, expandable details) |
| Search — groups | Yes (UDP directory; open group profile) |
| Radar (coarse positions) | Yes (`CoarseLocationUpdate`; filter, range, optional alerts) |
| World map + tiles | Yes (map-server JPEG tiles via the bridge) |
| Region lookup / SLURL | Yes (map location field, linkified chat/IM) |
| Clickable links in chat/IM | Yes (SLURL, http(s), `[url Label]`, email; trusted vs external, with a confirm for external) |
| Parcel music playback | Yes (top-bar play/volume control, shown only when the parcel actually streams music; off by default) |
| Manual teleport | Yes (map selection, Destination Guide, `Teleport Here`) |
| Teleport home | Yes (map sidebar button) |
| Teleport progress | Yes (full-screen lock with a centered progress bar; plus stage + percentage on busy buttons) |
| Sim-initiated teleport | Yes (force / god / home / death; not plain lure offers) |
| Destination Guide | Yes (Linden feeds: suggested, popular, new, editor, events) |
| Session disconnect detection | Yes (overlay; browse offline; gentle status/logout pulse) |
| Unread badges | Yes (chat, IM, events counts; radar/land/debug indicators) |
| Land parcel view/edit | Partial (owner + group-member parcels; HTTP + UDP data) |
| Teleport offers / requests | Partial (IM accept/decline prompts; buddy send) |
| 3D world / inventory / attachments | No (and not pretending to) |

## Getting around

- **Side navigation** — Chat, IM, Events, Buddies, Search, Radar, Map, Land, Guide, and Debug down the left edge.
- **Top bar** — connection dot next to your name; your name (click to open your own profile when connected); your **active group title** underneath (or "No active group title" — the group *name* isn't shown here, just the title); parcel name + region; a **parcel-music** play/volume control that only appears when the parcel streams music; L$ balance; SLT clock; sim FPS; theme toggle; logout.
- **Unread badges** — numbers on Chat, IM, and Events; dots on Radar (someone new in range), Land (parcel updated), and Debug (new errors). A new IM bumps the IM badge but doesn't yank you to the tab — you read when you're ready.

## Chat and Events

**Chat** is for nearby conversation and system lines (including the login message of the day). **Events** is the inbox for things that want a deliberate answer:

- Script dialogs and text boxes
- Script permission requests
- LoadURL, map, and friendship prompts
- Payment / economy notices (deduplicated when the sim resends the same transaction — a repeat just refreshes the existing card's balance instead of stacking another one)

Nothing in Events answers by itself. Unresolved items keep the Events badge lit until you look.

**Links in chat/IM/MOTD are clickable.** In-world SLURLs open the map; `secondlife:///app/agent|group/...` links open the relevant profile; recognised `http(s)` links, `[url Label]` bracket forms, and email addresses get linkified with trust-aware styling. Trusted Linden/Firestorm domains open straight away; **an untrusted external link asks first** (and wears a little `↗`) before it takes you out of Second Life. The URL grammar + trust list live in the core (`urlmatch.rs`), mirroring Firestorm's `LLUrlRegistry`.

## Instant messages

The **IM** tab keeps 1:1, group, and conference conversations in one list:

- **1:1 IM** — plain `ImprovedInstantMessage`, with a "typing…" indicator while the other person composes. Closing a 1:1 hides it but keeps the history; it reopens the moment either of you writes again.
- **Notifications** — a new IM raises the IM badge; Minibee won't switch tabs on you.
- **Group chat** — open it from the Land tab's parcel group, a group profile, or when another member starts talking; the sim streams messages to members over UDP (`IM_SESSION_GROUP_START`). The session title comes from your group membership, not the binary bucket.
- **Conference chat** — start an ad-hoc session from the IM tab or a buddy's menu; incoming invites are accepted through the `ChatSessionRequest` capability. **Invite** adds more people to an open conference.
- **Roster** — a collapsible member sidebar with online state and resolved display names; click a member to open a 1:1. Reopening a group re-requests the roster from the sim and seeds from recent participants.
- **Moderation** — in **group** sessions, moderators can mute/unmute a participant's text (`ChatSessionRequest` "mute update"). Moderator status comes from the sim roster (`is_moderator` on `ChatterBoxSessionAgentListUpdates`), not from profile role data. Ad-hoc **conferences** show no MOD tags or mute controls — that's Firestorm parity, moderation is a group thing — and "mute update" is never sent for them.
- **Mute vs Leave** — Mute silences a noisy session locally (it stops nagging the badge); Leave actually exits the group/conference server-side.

## Profiles

Open a resident or group profile from **Search**, **Buddies**, **Radar**, **IM**, **Chat** (the speaker's name), **Land** (owner / group links), or the **top bar** (your own name).

**Avatar profiles** load through the `AgentProfile` HTTP cap when it's available (full about text, up to ~64 KB), falling back to UDP `AvatarPropertiesReply` for the smaller fields. The floater has:

- Display name + username in the header; account level (membership tier) in the subtitle
- Resident tab: photo, born date, partner, payment info, scrollable about text, groups list
  - **Your own profile** should list every membership including hidden ones, with the active group in bold — **not fully working yet** (see Limitations)
  - **Other residents:** profile-visible groups only
- Places, Classifieds, Web, More (First Life), and Notes tabs when there's data
- Pick / classified detail: resolved parcel + region, a map preview, and teleport (which closes the profile, like the Destination Guide does)
- Actions: IM, Pay, Offer teleport, Request teleport, Add / Remove friend (with a confirm)

**Group profiles** show the name, charter, insignia, enrollment flags, member count, and founder (a linked name once resolved). Members can:

- Open group chat
- **Activate** the group (`ActivateGroup`, confirmed via `AgentDataUpdate`)
- Pick and **Save** an active title (`GroupTitlesRequest` / `GroupTitleUpdate`)
- **Join** or **Leave** (with a confirm; `JoinGroupRequest` / `LeaveGroupRequest`)

Non-members can join when enrollment is open (the join prompt shows any fee).

List-row thumbnails resolve photos for **buddies** only (to keep sim traffic down); everywhere else shows initials until you open the full profile or the image is already cached (`localStorage`, 7-day TTL).

## Search

The **Search** tab queries the sim directory over UDP (three characters minimum):

| Category | Results | Actions |
|----------|---------|---------|
| **People** | Residents by username | Open profile; start IM |
| **Places** | Regions, parcels, destinations | Show on map; expand for description + traffic |
| **Groups** | Group names + member counts | Open group profile |

People hits get enriched with `GetDisplayNames` when the cap is around, and your current radar is searched locally too for quick matches.

## Map and teleport

- **Map** — pan, centre on your avatar (`@`), click a region tile to select it, or type a SLURL / region name and hit **Show on map**, then **Teleport Here** or **Teleport Home**.
- **Bad region name?** The map stays put and you get a toast, rather than sailing off to nowhere.
- **SLURLs** in chat/IM open the Map tab with the location pre-filled.
- Region names come from sim `MapBlock` UDP and an HTTP region lookup where available.
- **Mid-teleport**, the teleport button shows the stage and percentage; clicking it again won't cancel an outbound teleport.

| Teleport type | What happens |
|---------------|--------------|
| **Manual** (map, SLURL, Guide) | Sends `TeleportLocationRequest`; waits for `TeleportStart` / `TeleportFinish`. |
| **Home** (map button) | `DataHomeLocationRequest`; arrival uses your home region + name. |
| **Lure offer** (IM) | You accept or decline; accepting sends `TeleportLureRequest`. Never auto-teleports. |
| **Force / god / sim-initiated** | A `TeleportStart` from the sim with non-lure flags (godlike, 911, force-redirect, home…) is followed automatically. |

## Radar

Coarse avatar positions from `CoarseLocationUpdate`. Filter by name, set the range slider (avatars past it are dimmed, not hidden), and optionally turn on **Alerts** to get a toast when someone new wanders into range. When the sim doesn't report an avatar's altitude, Minibee falls back to horizontal distance instead of parking them a fictional kilometre away.

## Land

Standing-parcel data comes from UDP `ParcelProperties` plus HTTP `RemoteParcelRequest` (name, area, flags, owner). Open the Land tab or tap refresh to ask for an update.

Prim **capacity** uses the sim's number when available, otherwise it's estimated from parcel area (Linden's 15000-prims-per-region default). Prim **usage** needs the sim's counts. If a number looks off, peek at Debug → Diagnostics for `prims=used/total` lines.

Editable fields (name, description, build/script flags, fly/damage/search/sound/voice/sell-passes) work on parcels **you own or hold through the owning group** — the sim still enforces the actual land powers, and an update round-trips the *current* parcel data so an edit never silently wipes settings you didn't touch. Others' parcels are view-only. On **group-owned** land the Owner field resolves the group name and opens the group profile, not a resident one.

Objects that message you (script dialogs, LoadURL prompts) show a clickable object title that opens the **owner's** profile — the group's when the object is group-owned, otherwise the resident's.

## Destination Guide

The **Guide** tab pulls curated destinations from Linden Lab's public API (`worldaping.agni.lindenlab.com`), fetched by the core to sidestep WebView CORS:

| Feed | Label |
|------|-------|
| `mobile` | Mobile |
| `popular` | Popular |
| `new` | New |
| `editor` | Editor |
| `events` | Events |

Each entry shows a name, description, maturity rating, and thumbnail. **Map** or **Teleport** straight from it, or follow its SLURL. Teleport progress works the same as on the map.

## When the connection drops

If the sim drops you (`LogoutReply`, a kick, circuit loss, or a bridge 404), you get a **Connection lost** overlay. Dismiss it to **browse offline** — read your chat/IM/log history and flip between tabs while grid actions stay disabled. The status dot and logout button pulse gently as a reminder that you're not really there anymore. **Return to Login** when you're ready to reconnect.

## Limitations (a.k.a. things it honestly can't do)

- No world rendering, inventory, attachments, or movement beyond teleport
- **No RLV / RLVa** — no Restrained Love restrictions (`@getstatus`, folder locks, sit/touch blocks, etc.)
- Buddy names may show as a UUID for a beat until `GetDisplayNames` comes back
- Avatar about text needs the `AgentProfile` cap; without it you get only the UDP packet's ~512 bytes
- **Own-profile groups list:** groups with **Show in profile** turned off should still appear on *your* profile (muted), with the active group bold. The plumbing exists (`getProfileGroupsForDisplay`, the inbound `AgentGroupDataUpdate` listener in the core, the `agentGroups` merge) but **end-to-end delivery still needs verifying** — for now you usually see only the cap-visible groups
- List thumbnails resolve photos for buddies only; radar/search/chat/IM show initials unless the image is already cached
- Radar positions are the sim's coarse ~1 m grid
- Land prim usage depends on UDP `ParcelProperties`; capacity may be estimated from area when the sim doesn't send counts
- If UDP acts up or receive sits at zero packets: close other SL viewers, and make sure Windows Firewall lets Minibee's UDP through

## Roadmap

Simplified view of what's still open.

- **Minibee tab** — left-nav preferences hub: auto-reconnect, theme, radar/buddies/music/debug toggles in one place (today they're scattered).
- **Auto-reconnect** after unexpected disconnect, with backoff and a manual override.
- **MFA reliability** — investigate frequent "invalid" challenges (token, `mfa_hash`, clock skew).
- **Group text moderation** — re-test in-world (`mute update` regression; client path matches Firestorm but reports persist).
- IM list performance (incremental updates, smarter autoscroll, dedup by message id).
- **Own profile groups** — show every membership including hidden ones; bold the active group.
- Avatar thumbnails beyond the buddies list (radar, search, chat).
- Open group chat from search results.
- Selecting an active group role.
- Missing About Land tabs: **Covenant**, **Experiences**, **Environment**.
- **Objects** tab (prim counts, owner list, return).
- **Access** lists, landing-point controls, terraforming / object-entry options.
- Buy, abandon, and buy-pass flows where applicable.
- **Landmarks** — read-only inventory list with teleport.
- Teleport handoff verification on Agni (`EstablishAgentCommunication` / `TeleportFinish` via EventQueue).
- `CrossedRegion` without an active outbound teleport (for when movement exists).
- Nearby **object list** (name, distance, owner, scripted flag).
- **Touch** and **sit** on selected objects.
- Buy / pay / inspect from object context (no 3D pick ray until there's a world view).
- Voice - D'oh.
- Incrementally move UDP message **interpretation** from JS into the Rust core (radar, chat, IM, parcel, teleport, …) so the WebView subscribes to semantic events instead of decoding packets.
- UDP traffic status indicator.
- Maybe: LSL/LUA script editor with validation from server / scripts list from inventory.

## Reference

The core bundles Second Life's `message_template.msg` (from `scripts/messages/message_template.msg` in the Firestorm repo) and drives its codec straight from it, so every message in the template is understood. Firestorm's source is treated as the reference for protocol behaviour throughout.
