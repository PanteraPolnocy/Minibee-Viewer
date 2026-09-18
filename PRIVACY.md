# Minibee Viewer - Privacy Policy

Last updated: 2026-09-18

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
| Device identifiers | Same kind as other viewers use for MFA "remember this device" and login security - **not hidden or faked**. On desktop they are derived from the machine (hardware UUID, disk or volume serial, network adapter address); on Android from a random id Minibee generates once and keeps in its data folder (a hardware serial only when the system exposes one). Sent hashed |
| MFA and terms-of-service flags | Normal login flow |

After login, traffic to simulators and Linden services is governed by [Linden Lab's privacy policy](https://www.lindenlab.com/privacy).

Your password is **not** sent anywhere except the login server you picked.

---

## What stays on your device

| Data | When |
|------|------|
| Username, grid, "remember me" | If you turn on remember me (in `settings.json` in the app's data folder) |
| MFA "remember device" | If you opt in (same `settings.json`, encrypted with your account password - unreadable without it; it is unlocked with the password you type at login) |
| Preferences (theme, radar, etc.) | As you change settings (same `settings.json`) |
| Auto-reconnect login details | In memory only while connected or reconnecting - **never on disk**; cleared on logout |
| IM chat logs (plain text files in the app's data folder, one folder per account) | Only if you say yes - asked once at first login, off by default, separate people/groups switches in Bee -> Settings; delete the files any time (Bee -> About shows where and how much) |
| Diagnostic log file | Desktop only, off by default: only if you start Minibee with `--enablelogfiles` or with `MINIBEE_ENABLE_LOGFILES=1` in the environment. Written to a Minibee folder in the system temp directory; old files are removed after 3 days. Android has no way to turn it on |
| Android device id | A random id created on first login and kept in the app's data folder (see "Device identifiers" above); removed with the app's data |

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

Same login and on-device storage behaviour as desktop. Distributed on Google Play and, as an APK, on GitHub Releases. The Google Play edition has no in-app L$ purchase (Play policy); everything else is the same app.

While the viewer runs, a persistent notification keeps the connection alive; it can show the number of unread IMs and, expanded, the newest message's sender and text. That preview lives only in the device's own notification shade (your lock-screen notification settings govern what shows when locked) and is never sent anywhere. While voice is connected and you have granted the microphone permission, the same connection service is marked as using the microphone so voice keeps working when the app is in the background; the marking is dropped when voice disconnects.

Android's Auto Backup is turned off for Minibee: its data folder (`settings.json`, chat logs if enabled, the device id, the web view's storage) is not included in Google backups or device-to-device transfers. Uninstalling removes it.

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
