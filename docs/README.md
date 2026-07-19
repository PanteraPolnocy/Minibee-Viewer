# Minibee Viewer (JS Experiment)

Pure JavaScript / HTML / CSS / PHP UI for Second Life — chat, IM, radar, map, land, destination guide, and teleport. No 3D rendering.

## Important notice

Minibee is **experimental software** — a lightweight work-in-progress, not a finished or official Second Life client. It is not endorsed by Linden Lab or the Firestorm team.

**You choose to use it at your own responsibility.** That includes logging in, spending Linden dollars, accepting script permissions, opening URLs, and any other actions you take in-world. The code has been written carefully and in good faith, with attention to protocol correctness and sensible safety defaults (for example, script dialogs and permission prompts require an explicit tap before anything is sent back to the simulator). Even so, experimental code can have gaps, bugs, or behaviour that does not match a full viewer.

Please treat Minibee accordingly: helpful for exploration and testing, not something to rely on blindly for critical account activity.

## Quick start

Browsers cannot speak SL's UDP protocol or call `login.cgi` directly (CORS). Run the **PHP bridge** on the same machine as the browser:

```bat
start-minibee.bat
```

Or one command (single terminal):

```bat
php bridge/run.php
```

`start-minibee.bat` and `run.php` start **poll** in the background and **caps** in the foreground in the **same window**. Ctrl+C stops both. `start-minibee.bat` also opens **`http://127.0.0.1:8765/`** in your default browser when the bridge is ready.

To debug poll alone: `php bridge/poll.php` in a separate terminal.

Requires PHP with **curl** and **sockets** enabled. The batch file tries `php` on PATH first, then falls back to loading curl/sockets from the PHP install directory if extensions are not loaded by default.

Optional override when `php` is not on PATH:

```bat
set FS_BRIDGE_PHP=C:\path\to\php.exe
start-minibee.bat
```

**SSL / CA certificates:** Minibee does **not** ship a CA bundle (Mozilla's PEM is [MPL 2.0](https://curl.se/docs/caextract.html)). On startup the bridge tries to download it from [curl.se](https://curl.se/ca/cacert.pem) into `bridge/cacert.pem` (etag-aware, per curl's recommended method). The viewer also attempts this when you open the login screen or log in.

Check status:

```bat
php bridge/daemon.php --check-ca
php bridge/daemon.php --fetch-ca
```

If auto-download fails, the viewer shows a modal with manual steps. You can also set `FS_BRIDGE_CACERT`, `SSL_CERT_FILE`, or `CURL_CA_BUNDLE` to an existing system CA bundle.

### Opening the viewer

Run **`start-minibee.bat`** (Windows) or **`php bridge/run.php`**. The batch launcher opens **`http://127.0.0.1:8765/`** automatically once the bridge is listening. You can also open that URL yourself at any time.

Do **not** open `index.html` directly from the filesystem (`file://`). The viewer blocks that and shows instructions to use the bridge URL instead.

Pick a grid (Agni, Aditi, or local OpenSim), enter credentials, and log in.

After code or bridge changes: **hard-refresh** the page (`Ctrl+Shift+R`) and **restart both bridge processes** (poll + caps).

## Architecture

```
index.html + css/app.css       Shell, login screen, bottom navigation
js/app.js                      Bootstrap and event wiring
js/serve-guard.js              Block file://; require HTTP(S)
js/settings.js                 Local preferences (localStorage)
js/ui/*                        Tabs: chat, IM, buddies, radar, map, land, guide, log
js/protocol/sl-transport.js    Live SL session (login, circuit, caps, teleport)
js/protocol/sl-packet.js       UDP message codec and circuit
js/protocol/sl-login.js        XML-RPC login + MFA/TOS challenge loop
js/protocol/sl-caps.js         Seed capabilities, display names, remote parcel
js/protocol/sl-eventqueue.js   EventQueueGet (parcel + teleport lifecycle)
js/protocol/sl-slurl.js        SLURL / map coordinate helpers
js/protocol/sl-teleport.js     Teleport flags, lure buckets, SLURL helpers
js/protocol/bridge.js          HTTP client (caps 8765 + poll 8766)
js/version.json                Viewer version metadata (channel, semver, build)
js/version.js                  Loads version.json for login label and bridge user-agent
bridge/poll.php                UDP circuit relay (127.0.0.1:8766)
bridge/caps.php                Login proxy + UI + map (127.0.0.1:8765)
bridge/daemon.php              Shared core (library; use --check-ca / --fetch-ca only)
bridge/run.php                 One-terminal launcher (poll child + caps foreground)
start-minibee.bat              Windows launcher (poll + caps + browser)
docs/README.md                 This file
```

The bridge runs as **two processes** for isolation:

| Process | Port | Role |
|---------|------|------|
| **poll** | 8766 | UDP circuit: `/circuit/poll`, send, exchange — never blocked by caps |
| **caps** | 8765 | Viewer UI, login, `/proxy`, map, destinations |

The JS client sends circuit traffic to poll and everything else to caps. Each process also uses concurrent HTTP internally (`stream_select`; caps uses `curl_multi` for proxy).

### Connection flow

1. `POST /login` — XML-RPC `login_to_simulator` (optional seed cap grant in the same response)
2. `POST /circuit/open` — local UDP socket toward `sim_ip:sim_port`
3. Handshake — `UseCircuitCode`, `CompleteAgentMovement`, etc. via `/circuit/send` and `/circuit/exchange`
4. `GET /circuit/poll` — receive chat, IM, radar, parcel packets
5. HTTP caps — presence caps (`GetDisplayNames`, etc.) at login; land caps deferred until the Land tab is opened
6. `EventQueueGet` — started when a teleport is in progress; delivers `TeleportFinish`, `CrossedRegion`, etc.

Use the **Log** tab (protocol diagnostics) when debugging parcel or UDP issues (`pkts`, `udp` counters on parcel lines). The Log tab also has a **Settings** subtab for saved preferences (non-secret keys only).

### Lazy tab loading

Tabs fetch and render their data only when you open them. This keeps login light and avoids unnecessary bridge traffic:

- **Chat / IM / Buddies / Radar** — render on first visit; UDP data still flows in the background once connected
- **Map** — tiles and region names load when the Map tab is active
- **Land** — parcel refresh and land HTTP caps run when the Land tab is opened
- **Guide** — destination feeds load on first visit
- **Log** — error log and settings browser render when opened

## Features

| Feature | Status |
|---------|--------|
| Login (Agni / Aditi / local) | Yes |
| MFA / TOS / critical prompts | Yes (login dialog) |
| Nearby chat | Yes (UDP) |
| Script dialogs / permissions | Yes (interactive Chat cards; no auto-reply) |
| LoadURL / map prompts / friendship offers | Yes (interactive Chat cards; user confirms) |
| IM (send and receive) | Yes (UDP) |
| Buddies + display names | Yes (`GetDisplayNames` cap) |
| Radar (coarse positions) | Yes (`CoarseLocationUpdate`; out-of-range avatars dimmed, not hidden) |
| World map + tiles | Yes (map server JPEG tiles via bridge) |
| Region lookup / SLURL | Yes (map location field, linkified chat/IM) |
| Manual teleport | Yes (map selection, `Teleport Here`) |
| Sim-initiated teleport | Yes (force / god / home / death; not plain lure offers) |
| Destination Guide | Yes (Linden feeds: suggested, popular, new, editor, events) |
| Session disconnect detection | Yes (modal overlay; browse history, logout still works) |
| Land parcel view/edit | Partial (owner parcels; HTTP + UDP parcel data) |
| Teleport offers / requests | Partial (IM accept/decline prompts) |
| 3D world / inventory / attachments | No |

## Map and teleport

- **Map** — pan, centre on avatar (`@`), click a region tile to select, enter a SLURL or region name and **Show on map**, then **Teleport Here**.
- **Invalid region names** — map does not move; you get a toast instead of centring on a bogus location.
- **SLURLs** in chat and IM open the map tab with the location pre-filled.
- Region names on the map are resolved via sim `MapBlock` UDP and HTTP region lookup where available.

### Teleport types

| Type | Behaviour |
|------|-----------|
| **Manual** (map, SLURL) | Viewer sends `TeleportLocationRequest`; waits for `TeleportStart` / `TeleportFinish`. |
| **Lure offer** (IM) | Prompt to accept or decline; accepting sends `TeleportLureRequest`. Does **not** auto-teleport. |
| **Force / god / sim-initiated** | `TeleportStart` from the sim with non-lure flags (godlike, 911, force redirect, home, etc.) is followed automatically. |

## Radar

Coarse avatar positions from `CoarseLocationUpdate`. The range slider dims avatars beyond the selected distance rather than hiding them; the header still shows how many are within range.

## Land

Standing parcel data comes from UDP `ParcelProperties` and HTTP `RemoteParcelRequest` (name, area, flags, owner). Open the Land tab or tap refresh to request an update.

Prim **capacity** is taken from UDP when available; otherwise it is estimated from parcel area (15 prims per 512 m²). Prim **usage** requires UDP counts from the sim. Check Log → Diagnostics for lines like `prims=used/total` if the field looks wrong.

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

Each entry shows name, description, maturity rating, and thumbnail. Use **Map** or **Teleport** on a destination, or follow its SLURL.

## Session disconnect

If the simulator drops the session (`LogoutReply`, kick, circuit loss, or bridge session 404), the viewer shows a **Connection lost** overlay. The UI is frozen except for the bottom navigation and logout. You can still read chat history and switch tabs. Use **Return to Login** when ready to reconnect.

## Limitations

- No world rendering, inventory, attachments, or built-in movement beyond teleport
- Buddy names may show as UUID briefly until `GetDisplayNames` returns
- Radar uses 1 m coarse positions from the sim
- Land prim usage depends on UDP `ParcelProperties`; capacity may be estimated from area when the sim does not send counts
- Bridge must run on localhost (`127.0.0.1:8765`); close other SL viewers if UDP bind or circuit behaviour is odd
- Windows Firewall must allow `php.exe` UDP if receive stays at zero packets
- Destination Guide requires the bridge (Linden API is fetched server-side to avoid browser CORS)

## Bridge files

| File | Purpose |
|------|---------|
| `bridge/poll.php` | UDP circuit relay (port 8766) |
| `bridge/caps.php` | Viewer UI, login, proxy, map (port 8765) |
| `bridge/daemon.php` | Shared PHP core (not a server; `--check-ca` / `--fetch-ca` only) |
| `start-minibee.bat` | Windows launcher — starts poll + caps and opens the viewer |

No Composer, Node, or build step for the viewer itself.

## Reference

Message layouts follow Firestorm conventions. See `scripts/messages/message_template.msg` in the Firestorm repository.
