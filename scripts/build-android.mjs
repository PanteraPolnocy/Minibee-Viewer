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
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const play = process.argv.includes('--play');

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
