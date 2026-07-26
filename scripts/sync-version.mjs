#!/usr/bin/env node
/**
 * Copy the app version from src-tauri/Cargo.toml into npm and iOS project files.
 *
 * Committed copies of those files use the placeholder 0.0.0; sync runs before every
 * build (local via tauri.conf beforeBuildCommand, CI in release.yml). Android reads
 * Cargo.toml directly at Gradle time.
 *
 * Usage:
 *   node scripts/sync-version.mjs          # write synced versions
 *   node scripts/sync-version.mjs --check  # exit 1 if anything drifts from Cargo.toml
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CARGO_TOML = path.join(ROOT, 'src-tauri', 'Cargo.toml');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const PACKAGE_LOCK = path.join(ROOT, 'package-lock.json');
const APPLE_PROJECT = path.join(ROOT, 'src-tauri', 'gen', 'apple', 'project.yml');
const APPLE_PLIST = path.join(ROOT, 'src-tauri', 'gen', 'apple', 'minibee-viewer_iOS', 'Info.plist');

const checkOnly = process.argv.includes('--check');

function readCargoVersion() {
  const toml = readFileSync(CARGO_TOML, 'utf8');
  const match = toml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    console.error('sync-version: no version = "..." in src-tauri/Cargo.toml');
    process.exit(1);
  }
  return match[1];
}

function syncPackageJson(version) {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  const before = pkg.version;
  pkg.version = version;
  return {
    path: PACKAGE_JSON,
    before,
    after: version,
    write: () => writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8'),
  };
}

function syncPackageLock(version) {
  const lock = JSON.parse(readFileSync(PACKAGE_LOCK, 'utf8'));
  const before = lock.version;
  lock.version = version;
  if (lock.packages?.['']) {
    lock.packages[''].version = version;
  }
  return {
    path: PACKAGE_LOCK,
    before,
    after: version,
    write: () => writeFileSync(PACKAGE_LOCK, `${JSON.stringify(lock, null, 2)}\n`, 'utf8'),
  };
}

function syncAppleProject(version) {
  const file = APPLE_PROJECT;
  let text = readFileSync(file, 'utf8');
  const beforeShort = text.match(/CFBundleShortVersionString:\s*(\S+)/)?.[1] ?? '';
  const beforeBuild = text.match(/CFBundleVersion:\s*"([^"]+)"/)?.[1] ?? '';
  text = text.replace(
    /CFBundleShortVersionString:\s*\S+/,
    `CFBundleShortVersionString: ${version}`,
  );
  text = text.replace(
    /CFBundleVersion:\s*"[^"]+"/,
    `CFBundleVersion: "${version}"`,
  );
  return {
    path: file,
    before: `${beforeShort} / ${beforeBuild}`,
    after: `${version} / ${version}`,
    write: () => writeFileSync(file, text, 'utf8'),
  };
}

function syncApplePlist(version) {
  const file = APPLE_PLIST;
  let text = readFileSync(file, 'utf8');
  const beforeShort = text.match(
    /<key>CFBundleShortVersionString<\/key>\s*\n\s*<string>([^<]+)<\/string>/,
  )?.[1] ?? '';
  const beforeBuild = text.match(
    /<key>CFBundleVersion<\/key>\s*\n\s*<string>([^<]+)<\/string>/,
  )?.[1] ?? '';
  text = text.replace(
    /(<key>CFBundleShortVersionString<\/key>\s*\n\s*<string>)[^<]+(<\/string>)/,
    `$1${version}$2`,
  );
  text = text.replace(
    /(<key>CFBundleVersion<\/key>\s*\n\s*<string>)[^<]+(<\/string>)/,
    `$1${version}$2`,
  );
  return {
    path: file,
    before: `${beforeShort} / ${beforeBuild}`,
    after: `${version} / ${version}`,
    write: () => writeFileSync(file, text, 'utf8'),
  };
}

const version = readCargoVersion();
const targets = [
  syncPackageJson(version),
  syncPackageLock(version),
  syncAppleProject(version),
  syncApplePlist(version),
];

const drifted = targets.filter((t) => t.before !== t.after);

if (checkOnly) {
  if (drifted.length === 0) {
    console.log(`sync-version: ok (${version} everywhere)`);
    process.exit(0);
  }
  console.error(`sync-version: drift from Cargo.toml (${version}):`);
  for (const t of drifted) {
    console.error(`  ${path.relative(ROOT, t.path)}: ${t.before} -> ${t.after}`);
  }
  console.error('Run: npm run version:sync');
  process.exit(1);
}

if (drifted.length === 0) {
  console.log(`sync-version: already synced at ${version}`);
  process.exit(0);
}

for (const t of drifted) {
  t.write();
  console.log(`sync-version: ${path.relative(ROOT, t.path)} ${t.before} -> ${t.after}`);
}
