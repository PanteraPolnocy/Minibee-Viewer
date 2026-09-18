#!/usr/bin/env node
/**
 * Android builds come in two flavours that must NOT share a binary:
 *
 *   node scripts/build-android.mjs          # sideload APK - full app, L$ purchase included
 *   node scripts/build-android.mjs --play   # Play Store AAB - L$ purchase compiled out
 *
 * The Play edition is built with MINIBEE_PLAY_BUILD=1: Google Play requires
 * virtual-currency purchases to use its own billing, and a monetized listing
 * publishes the developer's legal address, so the AAB the store gets ships
 * without the Buy L$ flow. Spending an existing balance is unaffected.
 *
 * Before building, the NDK revision is checked: Play requires 16 KB-aligned
 * native libraries for apps targeting Android 15+, which the NDK only links
 * by default from r28 on. CI (release.yml) pins r28c and calls the Tauri CLI
 * directly, so this guard is for local builds.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const play = process.argv.includes('--play');

// Oldest NDK whose linker aligns .so segments to 16 KB pages out of the box.
const MIN_NDK_MAJOR = 28;

// `Pkg.Revision` from an NDK directory's source.properties (e.g. 28.2.13676358), or null.
function ndkRevision(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'source.properties'), 'utf8');
    const m = /^Pkg\.Revision\s*=\s*(\S+)/m.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// The NDK the build will most likely use: the explicit env vars the Tauri CLI
// and Gradle read, then the SDK's ndk/ folder (the revision pinned through
// MINIBEE_NDK_VERSION if set, otherwise the highest installed).
function findNdk() {
  for (const name of ['NDK_HOME', 'ANDROID_NDK_HOME', 'ANDROID_NDK_ROOT']) {
    const dir = process.env[name];
    if (dir && ndkRevision(dir)) return { dir, from: name };
  }
  for (const name of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const sdk = process.env[name];
    if (!sdk) continue;
    const ndkRoot = path.join(sdk, 'ndk');
    const pinned = process.env.MINIBEE_NDK_VERSION;
    if (pinned && ndkRevision(path.join(ndkRoot, pinned))) {
      return { dir: path.join(ndkRoot, pinned), from: `${name}/ndk (MINIBEE_NDK_VERSION)` };
    }
    let entries = [];
    try {
      entries = fs.readdirSync(ndkRoot);
    } catch {
      continue;
    }
    const versions = entries
      .map((e) => ({ dir: path.join(ndkRoot, e), rev: ndkRevision(path.join(ndkRoot, e)) }))
      .filter((v) => v.rev)
      .sort((a, b) => compareRevisions(b.rev, a.rev));
    if (versions.length) return { dir: versions[0].dir, from: `${name}/ndk (highest installed)` };
  }
  return null;
}

function compareRevisions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function checkNdk() {
  if (process.env.MINIBEE_SKIP_NDK_CHECK === '1') return;
  const ndk = findNdk();
  if (!ndk) {
    console.warn(
      '[build-android] No NDK found through NDK_HOME / ANDROID_NDK_HOME / ANDROID_HOME/ndk; ' +
        `cannot confirm it is r${MIN_NDK_MAJOR}+ (16 KB page alignment). The Tauri CLI will complain if there is none.`,
    );
    return;
  }
  const rev = ndkRevision(ndk.dir);
  const major = Number.parseInt(rev, 10);
  if (Number.isNaN(major) || major >= MIN_NDK_MAJOR) {
    console.log(`[build-android] NDK ${rev} at ${ndk.dir} (from ${ndk.from})`);
    return;
  }
  console.error(
    `[build-android] NDK ${rev} at ${ndk.dir} (from ${ndk.from}) is older than r${MIN_NDK_MAJOR}.\n` +
      '  Google Play requires 16 KB page-size support for apps targeting Android 15+, and NDKs before\n' +
      '  r28 link 4 KB-aligned native libraries that Play rejects. Install NDK 28+ and point NDK_HOME\n' +
      '  at it (or set MINIBEE_NDK_VERSION to the installed folder name under ANDROID_HOME/ndk).\n' +
      '  MINIBEE_SKIP_NDK_CHECK=1 bypasses this check.',
  );
  process.exit(1);
}

checkNdk();

const tauriBin = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
);
const tauriArgs = ['android', 'build', play ? '--aab' : '--apk'];

const env = { ...process.env };
if (play) {
  env.MINIBEE_PLAY_BUILD = '1';
} else {
  // A leftover flag from a Play build must not leak into the sideload APK.
  delete env.MINIBEE_PLAY_BUILD;
}

const result = spawnSync(tauriBin, tauriArgs, {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env,
});
process.exit(result.status ?? 1);
