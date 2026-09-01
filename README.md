# Minibee Viewer

![Minibee logo](/src-tauri/icons/128x128.png)

A tiny Second Life client: a TypeScript / HTML / CSS interface running in a WebView, with a native **Rust** core (Tauri) doing the heavy lifting underneath. It does chat, IM (1:1, group, and conference), events, search, radar, map, land, the Destination Guide, and teleport.

What it does **not** do is render the 3D world. Minibee is the friend who comes to the party to talk to people and check the map, not to admire the furniture.

## Table of Contents

- [Read this first (the "use at your own risk" bit)](#read-this-first-the-use-at-your-own-risk-bit)
- [Download](#download)
- [Third-party viewer](#third-party-viewer)
- [How Minibee connects](#how-minibee-connects)
- [Bee](#bee)
- [Getting around](#getting-around)
- [Chat and Events](#chat-and-events)
- [Instant messages](#instant-messages)
- [Profiles](#profiles)
- [Search](#search)
- [Map and teleport](#map-and-teleport)
- [People (friends and the block list)](#people-friends-and-the-block-list)
- [Radar](#radar)
- [Interact (nearby objects, avatar actions)](#interact-nearby-objects-avatar-actions)
- [Land](#land)
- [Destination Guide](#destination-guide)
- [Scripts](#scripts)
- [Notecards](#notecards)
- [Voice (experimental)](#voice-experimental)
- [News](#news)
- [When the connection drops](#when-the-connection-drops)
- [Limitations (a.k.a. things it honestly can't do)](#limitations-aka-things-it-honestly-cant-do)
- [For developers](#for-developers)

## Read this first (the "use at your own risk" bit)

Minibee is **experimental software** - a lightweight work-in-progress, not a finished or official Second Life client. Linden Lab hasn't blessed it, and neither has the Firestorm team.

**Whatever you do in-world with it is on you** - logging in, spending L$, accepting script permissions, opening links, all of it. The code is written carefully and in good faith, with real attention to protocol correctness and sensible safety defaults (script dialogs and permission requests always wait for an explicit tap before anything goes back to the simulator - Minibee never answers on your behalf). But experimental code has rough edges, and it won't always behave like a full viewer.

Short version: great for exploring and testing, not the thing to bet your account on.

## Download

Just want to run it? Grab a prebuilt installer from the **[Releases](https://github.com/PanteraPolnocy/Minibee-Viewer/releases/latest)** page (runners build Windows, Linux, Mac and Android versions). Want to build it yourself? Jump to [For developers](#for-developers). Images to look at sit in the [Screenshots](/screenshots) directory.

New to Minibee? The **[plain-language user guide (HELP.md)](HELP.md)** explains what everything does and where to find it - no technical jargon. It's also built into the app under **Bee -> Help**.

## Third-party viewer

Minibee Viewer is a **third-party client** for [Second Life](https://secondlife.com). It follows Linden Lab's [Third Party Viewer Policy](https://secondlife.com/corporate/third-party-viewers).

**Not from Linden Lab.** This software is not provided, endorsed, or supported by Linden Lab. It is developed independently by Pantera Północy. Use it at your own risk.

**What it is:** a text-and-map client - chat, IM, search, radar, map, land, profiles, the Destination Guide, and related features through the Second Life protocol. The sections below walk through the details.

**What it is not:** a 3D viewer. You will not see avatars, objects, or region geometry. Some official-viewer features may be missing or behave differently.

**How we play fair:** Minibee identifies itself honestly at login and does not impersonate the official viewer or another third-party client. Script dialogs, permission requests, and payment prompts always need your tap - nothing is auto-accepted. Untrusted web links from chat ask before opening. Desktop updates only install when you confirm.

**Privacy:** [PRIVACY.md](PRIVACY.md) (also **Bee -> Privacy**).

**Support:** community help through [GitHub Issues](https://github.com/PanteraPolnocy/Minibee-Viewer/issues) and [Discussions](https://github.com/PanteraPolnocy/Minibee-Viewer/discussions). No paid or guaranteed response-time support. Linden Lab does not support third-party viewers.

**Terms:** Linden Lab's Terms of Service (and any login-time prompts for updated terms or critical messages) are presented when you log in. You must accept them to connect.

**Updates (desktop):** after startup, Minibee checks [GitHub Releases](https://github.com/PanteraPolnocy/Minibee-Viewer/releases) for a newer version. Downloads and installs happen only if you confirm. Details in [PRIVACY.md](PRIVACY.md).

**Source:** LGPL 2.1 - https://github.com/PanteraPolnocy/Minibee-Viewer

## How Minibee connects

Minibee speaks Linden Lab's documented viewer protocol to Second Life and compatible OpenSim grids. It does not impersonate the official viewer or another third-party client.

**At login**, the grid sees a channel of `Minibee-Viewer Release` (installers from Releases) or `Minibee-Viewer Test` (local debug builds only), plus a four-part version number from `Cargo.toml` - build `0` when you compile yourself, a CI build id on automated releases. The login screen and **Bee -> About** show the same channel and version.

**Your machine, honestly:** platform fields are the real OS, not hardcoded. Device identifiers the protocol asks for (`mac`, `id0`, and the rest) use the same rules as other viewers in the family - not masked or faked.

**Credentials:** passwords are never saved to disk. Auto-reconnect keeps them in obfuscated memory only until you log out.

**OpenSim:** on grids other than Agni or Aditi, a single-word username can log in the OpenSim way when the grid expects that.

Any future departure from standard protocol behaviour will be documented here before release.

## Bee

Open **Bee** in the nav (bee icon) for preferences and bundled docs:

- **Settings** (sub-tab) - theme, radar range/alerts, buddies filter, destination feed, parcel music, auto-reconnect, optional sit-on-ground after login. Changes apply everywhere immediately.
- **About Minibee** - version, author, support links, **Check for updates** (desktop), **Copy all** for bug reports.
- **Help** - the full user guide ([HELP.md](HELP.md)).
- **README** / **License** / **Privacy** - bundled project docs.

There is **no Debug tab** and no in-app log viewer. For a bug paper trail, start with `--enablelogfiles` (or `MINIBEE_ENABLE_LOGFILES=1`). Log file: `%TEMP%/minibee-viewer/minibee-viewer.log` on Windows (your OS temp dir elsewhere). **Off by default** - truncated fresh each launch.

## Getting around

- **Side navigation** - Chat, IM, Interact, Events, People, Search, Radar, Map, Land, Guide, News, Bee down the left edge (bottom bar on a phone-width screen).
- **Top bar** - connection dot, your name (tap for your profile), **active group title** underneath, parcel + region, parcel-music control when the parcel streams, L$ balance (tap to buy L$ - amount, estimated cost, and new balance, with a confirmation before anything is charged), SLT clock, sim FPS, theme toggle, logout.
- **Unread badges** - numbers on Chat, IM, and Events; dots on Radar (someone new in range) and Land (parcel updated). A new IM bumps the badge but doesn't yank you to the tab - you read when you're ready.

Tabs load their data when you open them, so login stays quick. Chat and IM keep flowing in the background once you're connected.

## Chat and Events

**Chat** is for nearby conversation and system lines (including the login message of the day). **Events** is the inbox for things that want a deliberate answer:

- Script dialogs and text boxes
- Script permission requests
- LoadURL, map, and friendship prompts
- Payment / economy notices (if the sim resends the same payment, Minibee refreshes the existing card instead of stacking duplicates)

Nothing in Events answers by itself. Unresolved items keep the Events badge lit until you look.

**Links in chat/IM are clickable.** Place links open the map; profile links open the right floater; web and email links are recognised. Trusted Linden/Firestorm domains open straight away; **an untrusted external link asks first** (little `^` marker) before it takes you out of Second Life.

## Instant messages

The **IM** tab keeps 1:1, group, and conference conversations in one list:

- **1:1 IM** - with a "typing..." indicator while the other person composes. Closing a 1:1 hides it but keeps the history; it reopens when either of you writes again.
- **Notifications** - a new IM raises the IM badge; Minibee won't switch tabs on you.
- **Group chat** - open from the Land tab's parcel group, a group profile, or when someone posts in that group.
- **Conference chat** - start from the IM tab or a buddy's menu; **Invite** adds more people to an open conference.
- **Roster** - member sidebar with online state; click someone for a 1:1.
- **Moderation** - in **group** sessions, moderators can mute/unmute a participant's text. Ad-hoc conferences don't get moderation controls (that's deliberate - it's a group thing).
- **Mute vs Leave** - Mute silences a session locally; Leave actually exits group/conference chat on the server.

You can pay another resident from the IM pay dialog.

## Profiles

Open a resident or group profile from **Search**, **People**, **Radar**, **IM**, **Chat**, **Land**, or the **top bar** (your own name).

**Avatar profiles** show display name, username, photo, about text, picks, classifieds, groups, and private **Notes** (including on yourself). Actions: IM, Pay, offer/request teleport, add/remove friend (with confirm), block, and **Report abuse** - a category picker plus summary and details, filed with the grid's moderation team over the same channel full viewers use.

**Group profiles** show charter, insignia, member count, founder. Members can open group chat, **Activate** the group, pick and save an **active title**, or **Join** / **Leave**. Non-members can join when enrollment is open.

List-row photos resolve for **buddies** only (to keep traffic down); elsewhere you get initials until a full profile or cache fills in.

## Search

Pick **People**, **Places**, or **Groups**, type at least three characters, and go.

| Category | What you get |
|----------|--------------|
| **People** | Open profile; start IM |
| **Places** | Show on map; description and traffic |
| **Groups** | Open group profile |

Your current radar is searched locally too for quick matches.

## Map and teleport

- **Map** - pan, centre on yourself (`@`), click a tile, or type a region name / SLURL and hit **Show on map**, then **Teleport Here** or **Teleport Home**. On phones the map takes the full width and the controls slide out over it.
- **Landmarks** - your Landmarks folder (subfolders included) and Favorites, listed alphabetically under the map controls with a filter. Tapping one shows the place, region and SLURL it points to, then teleports on confirmation.
- **Bad region name?** The map stays put and you get a toast instead of sailing off to nowhere.
- **SLURLs** in chat/IM open the Map tab with the location pre-filled.
- **Mid-teleport**, a progress dialog shows stage and percentage.

| Teleport type | What happens |
|---------------|--------------|
| **Manual** (map, SLURL, Guide) | You asked; Minibee waits for the sim to finish moving you. |
| **Home** | Uses your set home location. |
| **Lure offer** (IM/Events) | You accept or decline. Never auto-teleports. |
| **Force / sim-initiated** | Home, death, god-redirect, etc. - the sim started it; Minibee follows. |

## People (friends and the block list)

Two sub-tabs. **Friends** is the buddy list (search by name or private note, online-only toggle, right-click or tap for profile / IM / teleport / remove). **Blocked** is everyone you've muted on the grid.

**Block / Unblock** on a profile or in IM (and on each row in Blocked). Blocking writes to the sim's list, so it applies in every viewer - which is why Minibee asks you to confirm first. While someone is blocked their chat, IMs, offers, and script prompts are hidden; entries other viewers added for objects or groups keep silencing those too, even though only people show in the list.

## Radar

Who's near you and roughly how far. Filter by name, set the range slider (avatars past it are dimmed), and optionally turn on **Alerts** for a toast when someone new wanders into range. Range and alerts also live in **Bee -> Settings**.

## Interact (nearby objects, avatar actions)

The **Interact** tab is area-search-lite plus what a bodiless avatar can still be told to do.

A strip along the top reports what you're doing and offers **Sit on ground / Stand up / Fly / Stop flying** - only what makes sense right now.

Below that, nearby objects. Press **Load** when you want the list (it does not auto-refresh):

- **Distance** - 16 to 128 metres, default 32, remembered.
- **Filter** - narrows by object **name** or **owner** (display name, username, or pasted key).
- **Sort** - Distance, Name, or Owner; tap again to reverse.

Names fill in over a few seconds in busy regions. Tap a row for **Show details**, owner/creator profiles, **Touch** (only when the object actually handles touch - most scenery doesn't), **Sit on**, or **Pay** (with confirm).

## Land

Shows the parcel under your feet. Open the tab or tap refresh for an update.

Prim counts come from the sim when available; otherwise capacity may be estimated from parcel area.

Editable fields work on parcels **you own or hold through the owning group** (with the right land powers). Others' parcels are view-only. On **group-owned** land the Owner field opens the **group** profile.

Objects that message you (script dialogs, LoadURL) show a clickable title that opens the **owner's** profile - the group's when group-owned.

## Destination Guide

The **Guide** tab pulls curated destinations from Linden Lab's public feeds: Mobile, Popular, New, Editor, Events. Each entry has a name, blurb, maturity rating, and thumbnail. **Map**, **Teleport**, or follow its SLURL.

## Scripts

The **Scripts** tab is a small LSL editor over your inventory's Scripts folder (subfolders included). Pick a script to download its source - or create a new one with **+** - and edit with line numbers, syntax highlighting and autocomplete built from the grid's own LSL language data (the LSLSyntax capability, cached on disk for a week) plus the script's own variables, functions and states. Caret-driven signature help shows the enclosing call's arguments (touch-friendly - no hover needed), **Find** (Ctrl+F) searches the source with `:123` jumping to a line, **Ctrl+Z / Ctrl+Y** undo and redo every edit (Tab indents, completions and formatting included), and a one-tap **Format** re-indents the whole script by brace depth without ever touching strings or comments. Scripts can be renamed in place, and the item menu opens the creator's or last owner's profile, or copies the item / creator / last-owner UUIDs. **Save** uploads and the sim compiles: compiler errors come back as a clickable list that jumps to the offending line. The **Mono** checkbox chooses the runtime target (off = LSL2). On phones, the list and the editor act as separate screens.

## Notecards

The **Notes** tab is the same layout over your Notecards folder: pick a notecard to download its text - or create one with **+** - edit it in a plain wrapped editor, and **Save** it back to the grid. Renaming and the creator/UUID menu work as in Scripts. Notecards that carry embedded inventory items are detected and warned about before saving, since a save from Minibee keeps the text but not the embedded items.

## Voice (experimental)

Spatial (nearby) voice over Second Life's WebRTC voice system. The WebView's own WebRTC stack carries the audio - microphone in, one stereo stream out - while the Rust core does the authenticated signalling: the SDP offer/answer through the `ProvisionVoiceAccountRequest` capability, ICE trickling through `VoiceSignalingRequest`, and the position reports the voice server uses to spatialise the mix (SL mixes server-side; no 3D renderer needed to hear people where they stand). Login joins **listen-only** - the offer carries a trackless audio transceiver, so no microphone permission is asked until the first unmute. The top-bar mic button goes live/muted with a tap, right-click leaves for the session, and **Bee -> Settings -> Voice** turns the whole thing off. Teleports and region crossings reconnect automatically, voice follows parcel/estate channel rules, and near a border a second connection to the neighbouring region's voice server keeps people across the line audible (the neighbour's endpoints come from EnableSimulator + EstablishAgentCommunication - no extra circuit). Radar shows who is in voice and who is speaking, with per-person mute/volume in the row menu; microphone and output devices are selectable in settings. Current scope: spatial chat only - P2P/group calls are future work - and it is desktop-tested; other WebViews may behave differently.

## News

Four sub-tabs: **Linden News**, **SL Calendar**, **Grid Status**, **Bloggers**.

The three list tabs show cards - tap to expand, **Read on the web** for the full article. The calendar is embedded (links inside it are awkward in a frame, so use **Open in browser** when needed). Nothing loads until you open the News tab.

## When the connection drops

If the sim drops you, you get a **Connection lost** overlay. Dismiss it to **browse offline** - read chat/IM history and flip tabs while grid actions stay disabled. The status dot and logout button pulse gently. **Return to Login** when you're ready.

**Auto-reconnect** (**Bee -> Settings**, off by default) skips the overlay and quietly logs back in with a short back-off.

Your password is never written to disk - only held obfuscated in memory until logout. If every attempt fails, you get the manual overlay anyway.

Closing the window while connected asks **log out and quit** - and that quit path only works from that dialog, so a stray in-world link can't close the viewer on you.

## Limitations (a.k.a. things it honestly can't do)

- No world rendering, inventory, attachments, or walking around (teleport only)
- **No RLV / RLVa** - no Restrained Love restrictions
- Names may show as codes for a moment until they resolve
- Avatar "About" may be truncated if the region can't serve the full profile
- **Parcel music:** some exotic stream formats won't decode; the top bar says why. On Android, plain `http://` audio is allowed on purpose
- Buddy-list photos only in the buddies list; radar/search/chat show initials unless cached
- Radar positions are the sim's coarse ~1 m grid
- If nothing updates and packet counts sit at zero: close other SL viewers and check Windows Firewall for Minibee's UDP

## For developers

Version lives in `src-tauri/Cargo.toml` (run `npm run version:sync` before release).

**Quick start:**

```bat
cd Minibee-Viewer
npm install
npm run tauri dev
```

**The frontend is TypeScript**, but deliberately plain: every file under `src/js`
is a *script* holding one `const BeeThing = (function () { ... })()`, loaded by
ordered `<script>` tags. No imports, no bundler - esbuild transforms each file
on its own, so `src/js/x.ts` becomes `dist/js/x.js` in place. That means the
build never type-checks: `tsc` is a separate gate.

| Task | Command |
|------|---------|
| Check types | `npm run typecheck` |
| Regenerate the core's event types | `npm run types:sync` |

Event payload types are **generated from the Rust structs** in
`src-tauri/src/bridge/events.rs`, so the interface checks against what the core
actually sends rather than against an assumption about it. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to add one. Every file under
`src/js` is type-checked - there are no opt-outs.

**Release build** (`npm run tauri build`) produces installers under `src-tauri/target/release/`:

**Local builds** (no updater signing key needed): `npm run build:local` or `npm run build:local:debug`.

| Artifact | Notes |
|----------|-------|
| Standalone exe | Windowed; needs WebView2 on Windows |
| NSIS setup | **Recommended** - bootstraps WebView2, Start-menu shortcut, uninstaller, LGPL during setup |
| MSI | For group-policy / enterprise deploys |

CI also publishes builds on [GitHub Releases](https://github.com/PanteraPolnocy/Minibee-Viewer/releases) for Windows, Linux, macOS, and Android - an APK for sideloading plus an `.aab` App Bundle ready for the Google Play Console. The two are deliberately different binaries: the Play edition is compiled with `MINIBEE_PLAY_BUILD=1` and ships **without the in-app L$ purchase** (Google Play policy requires virtual-currency sales to use its own billing, and a monetized listing publishes the developer's legal address), while the sideload APK keeps the full app. Locally, `npm run build:android` makes the APK and `npm run build:android:play` the Play bundle. With a `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` repository secret configured, stable releases are also uploaded to the Play **internal track** automatically (the app's first bundle still has to be uploaded in the Play Console by hand).

- **WebView2:** on Windows 11 and current Windows 10 already. The bare exe needs it; the NSIS installer fetches it if missing.
- **Unsigned:** Windows releases are not code-signed, and that is not planned. SmartScreen will show the usual "unknown publisher" warning - use *More info -> Run anyway*.
- **Debug builds** (`npm run build:local:debug`) show a console; release installers are quiet and windowed.
- **CI releases:** `npm run tauri build` also signs updater artifacts (needs `TAURI_SIGNING_PRIVATE_KEY` in the environment).

Installed copies bundle `LICENSE`, `README.md`, `HELP.md`, and `PRIVACY.md` next to the app.

Tests: `npm test` and `npm run test:rust`; types: `npm run typecheck`.

Want to contribute? See **[CONTRIBUTING.md](CONTRIBUTING.md)**.

**License:** LGPL 2.1 · **Security:** [SECURITY.md](SECURITY.md)
