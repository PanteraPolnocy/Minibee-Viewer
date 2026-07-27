# Minibee Viewer - Help

Your plain guide to the viewer. Also built into the app: **Bee -> Help**.

Minibee is a **text-and-map** client for Second Life - chat, IM, friends, land, map, teleport. No 3D world, no avatar mesh, no inventory. (For the project's own introduction and disclaimers, see [README.md](README.md).)

---

## Logging in

1. **Username** - `firstname.lastname`, or just `firstname` on very old accounts.
2. **Password** - never saved to disk.
3. **Grid** - **Agni** is main Second Life; **Aditi** is the beta grid.
4. **Remember me** - saves username and grid only.
5. **2FA** - enter the code when asked; **remember this device** skips it next time on this machine.

**Forget saved login** wipes username, grid, and remembered 2FA.

Linden Lab's Terms of Service (and MFA when enabled) are shown when you connect - you must accept to continue.

---

## The layout

**Navigation** - down the left on desktop, along the bottom on a phone:

| Tab | For |
|-----|-----|
| Chat | Nearby talk |
| IM | Private, group, and conference messages |
| Interact | Nearby objects and avatar actions |
| Events | Things waiting for your answer |
| People | Friends and block list |
| Search | People, places, groups |
| Radar | Who is near you |
| Map | World map and teleport |
| Land | Parcel under your feet |
| Guide | Destination Guide |
| News | Blog, calendar, grid status, bloggers |
| Bee | Preferences and bundled docs |

**Numbers** on Chat, IM, Events = new stuff. **Dots** on Radar or Land = something changed.

**Top bar** - your name (profile), active group title, parcel and region, L$, Second Life time, connection, theme, logout. Speaker icon when the parcel streams music.

---

## Chat, IM, and Events

**Chat** - local conversation and system lines.

**IM** - one-to-one (with typing indicator), group chat, and conferences. Start a conference from IM or invite more people into an open one. Group moderators can mute participants in **group** chats; conferences don't get that.

**Events** - script menus, permission requests, payments, teleport offers, LoadURL prompts. **Nothing answers by itself.**

Links in chat and IM open the map, profiles, or your browser. Unfamiliar websites ask first.

**Right-click** in text: Cut, Copy, Paste, Select all. On links: Copy link, Open in browser.

---

## People and profiles

**Friends** - tap for profile, IM, teleport, remove. Filter online-only; search by name or private note.

**Blocked** - grid-wide mute list. Block or unblock from a profile, IM, or here.

**Profiles** - About, picks, groups, private Notes (even on yourself). Pay, teleport offer/request, add/remove friend, block.

**Groups** - charter, insignia, join/leave, activate, set active title, open group chat.

---

## Search, radar, map

**Search** - three characters minimum; People, Places, or Groups.

**Radar** - who's nearby; range and alerts in **Bee -> Settings** or on the Radar tab.

**Map** - pan, click, or type a region / SLURL -> **Show on map** -> **Teleport Here** or **Teleport Home**. Bad names get a toast, not a wild teleport. Progress dialog while moving.

**Guide** - featured destinations; teleport from a card.

---

## Land

Parcel you're standing on. **Refresh** if stale.

Edit when you **own** it or have the right **group land powers**; otherwise view-only. Group owner opens the group profile.

Tabs: General, Objects, Options, Media, Audio, Access (access lists view-only for now).

---

## Interact

**Sit / Stand / Fly / Stop flying** strip at the top.

**Load** fetches nearby objects (not automatic). Pick radius, filter by name or owner, sort columns.

Row menu: details, profiles, Touch (if the object supports it), Sit on, Pay (with confirm).

---

## News and music

**News** - four feeds; cards expand; **Read on the web** for full articles. Loads when you open the tab.

**Parcel music** - top-bar speaker; auto-play and volume under **Bee -> Settings** (off by default).

---

## Bee

Open **Bee** in the nav. Sub-tabs:

| Sub-tab | What |
|---------|------|
| Settings | Theme, auto-reconnect, sit after login, radar, buddies, guide feed, parcel music |
| About | Version, updates, **Copy all** for bug reports |
| Help | This guide |
| README | Project overview |
| License | LGPL 2.1 |
| Privacy | Privacy policy |

Closing the window while logged in asks you to confirm.

---

## Connection trouble

**Connection lost** - read history offline; grid actions pause. **Auto-reconnect** (**Bee -> Settings**, off by default) retries quietly.

Yellow banner about region features? Try relogging.

---

## Something not working?

- Names as codes for a few seconds - normal.
- No music - check **Bee -> Settings**; tap play once.
- Stuck - log out and in; **Bee -> About -> Copy all** for bug reports.
- Deep logging (optional): `--enablelogfiles` - no in-app log viewer; off by default.

**Support:** [Issues](https://github.com/PanteraPolnocy/Minibee-Viewer/issues) · [Discussions](https://github.com/PanteraPolnocy/Minibee-Viewer/discussions)
