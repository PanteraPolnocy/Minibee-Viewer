# Minibee Viewer - Privacy Policy

Last updated: 2026-07-27

Minibee Viewer ("Minibee") is developed by **Pantera Polnocy**. It is **not** provided by Linden Lab.

If you do not agree with this policy, do not use Minibee.

Also in the app: **Bee -> Privacy**.

---

## In short

- Minibee runs **on your device**. We do not run servers that receive your chat or IM.
- The **microphone** is used only if you turn voice on and join a voice channel; audio goes directly to your grid's voice service (Linden Lab's, on Second Life), never to us.
- Your **password is never saved** to disk.
- Login data goes **only to the grid you choose** (by default Linden Lab's Second Life).
- No analytics, ads, or third-party tracking.
- Desktop builds **check GitHub for updates** after startup. **You confirm** before any download or install.

---

## What goes to Linden Lab (or your grid) when you log in

| Data | Why |
|------|-----|
| Username and password | To log you in |
| Viewer name and version | So the grid knows which client you use (`Minibee-Viewer Release` or `Test`) |
| Operating system info | Standard login fields |
| Device identifiers | Same kind as other viewers use for MFA "remember this device" and login security - **not hidden or faked** |
| MFA and terms-of-service flags | Normal login flow |

After login, traffic to simulators and Linden services is governed by [Linden Lab's privacy policy](https://www.lindenlab.com/privacy).

Your password is **not** sent anywhere except the login server you picked.

---

## What stays on your device

| Data | When |
|------|------|
| Username, grid, "remember me" | If you turn on remember me |
| MFA "remember device" | If you opt in |
| Preferences (theme, radar, etc.) | As you change settings |
| Auto-reconnect login details | In memory only while connected or reconnecting - **never on disk**; cleared on logout |
| IM chat logs (plain text files in the app's data folder) | Only if you say yes - asked once at first login, off by default, separate people/groups switches in Bee -> Settings; delete the files any time (Bee -> About shows where and how much) |
| Diagnostic log file | Only if you start with `--enablelogfiles` (off by default) |

---

## What we do not do

- No Second Life account or sign-up
- No uploading your chat, IM, or inventory to us
- No selling or sharing data with advertisers
- No personal information required to install or uninstall

---

## Desktop updates

- **When:** shortly after startup, and **Bee -> About -> Check for updates**
- **Where it checks:** GitHub Releases ([latest.json](https://github.com/PanteraPolnocy/Minibee-Viewer/releases/latest/download/latest.json) on the project repo)
- **If you accept:** installer from that release

No Second Life account data is sent with the update check. Android has no automatic updater.

---

## Android

Same login and on-device storage behaviour as desktop. APK on GitHub Releases today; Google Play planned - this policy will be updated when that ships.

---

## Open source

https://github.com/PanteraPolnocy/Minibee-Viewer

---

## Children

Minibee is not aimed at children. Second Life has its own age rules under Linden Lab.

---

## Changes

The copy in the repository is the current version.

---

## Contact

- [Issues](https://github.com/PanteraPolnocy/Minibee-Viewer/issues)
- [Discussions](https://github.com/PanteraPolnocy/Minibee-Viewer/discussions)
- Security: [SECURITY.md](SECURITY.md)
