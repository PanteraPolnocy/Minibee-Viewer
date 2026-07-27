#!/usr/bin/env node
/**
 * Local tauri build without updater signing (no TAURI_SIGNING_PRIVATE_KEY needed).
 *
 * Usage:
 *   node scripts/build-local.mjs          # release build
 *   node scripts/build-local.mjs --debug  # debug / Test channel build
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const debug = process.argv.includes('--debug');
const configDir = mkdtempSync(path.join(tmpdir(), 'minibee-build-'));
const configPath = path.join(configDir, 'local.json');
writeFileSync(configPath, JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));

const tauriBin = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
);
const tauriArgs = ['build', '--config', configPath];
if (debug) {
  tauriArgs.push('--debug');
}

try {
  const result = spawnSync(tauriBin, tauriArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(result.status ?? 1);
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
