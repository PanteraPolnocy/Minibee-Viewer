// Unit tests for the pure helpers in src/js/protocol/sl-profiles.js (the
// Rust-fed profile/group cache mirror). Loaded as an IIFE in a function scope
// with stubbed globals, like the other frontend tests. Event ingestion +
// fetches (which need the live core) are not exercised here — only the pure
// formatting/URL/getter helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'js', 'core', 'sl-profiles.js'), 'utf8');

const FSUtils = { normUuid: (id) => String(id || '').toLowerCase() };
const FSBridge = { listen: () => {}, invoke: () => Promise.resolve() };

// eslint-disable-next-line no-new-func
const FSProfiles = new Function('window', 'document', 'FSUtils', 'FSBridge', src + '\n;return FSProfiles;')(
  {}, undefined, FSUtils, FSBridge
);

test('isZero: empty and null-uuid are zero', () => {
  assert.equal(FSProfiles.isZero(''), true);
  assert.equal(FSProfiles.isZero('00000000-0000-0000-0000-000000000000'), true);
  assert.equal(FSProfiles.isZero('abcdef01-0000-0000-0000-000000000000'), false);
});

test('textureImageUrl: builds SL image URL, empty for zero', () => {
  assert.equal(FSProfiles.textureImageUrl('abc', 256), 'https://secondlife.com/app/image/abc/256');
  assert.equal(FSProfiles.textureImageUrl('abc'), 'https://secondlife.com/app/image/abc/256');
  assert.equal(FSProfiles.textureImageUrl('00000000-0000-0000-0000-000000000000'), '');
});

test('resolveWebProfileUrl: direct url wins, else username, else empty', () => {
  assert.equal(FSProfiles.resolveWebProfileUrl({ profileUrl: 'https://x/y' }), 'https://x/y');
  assert.equal(FSProfiles.resolveWebProfileUrl({ userName: 'ruth.resident' }), 'https://my.secondlife.com/ruth.resident');
  assert.equal(FSProfiles.resolveWebProfileUrl({ userName: 'Ruth Resident' }), ''); // space -> not a slug
  assert.equal(FSProfiles.resolveWebProfileUrl(null), '');
});

test('formatAvatarInterests: arrays + hasContent', () => {
  const full = FSProfiles.formatAvatarInterests({ wantTo: ['Build'], skills: ['Scripting'], languagesText: 'en' });
  assert.equal(full.hasContent, true);
  assert.deepEqual(full.wantTo, ['Build']);
  assert.deepEqual(full.skills, ['Scripting']);
  assert.equal(full.languagesText, 'en');
  const empty = FSProfiles.formatAvatarInterests(null);
  assert.equal(empty.hasContent, false);
  assert.deepEqual(empty.wantTo, []);
});

test('formatBornLabel: hidden, invalid, and dated', () => {
  assert.equal(FSProfiles.formatBornLabel('2020-01-01', true), 'Age hidden');
  assert.equal(FSProfiles.formatBornLabel('', false), '');
  assert.equal(FSProfiles.formatBornLabel('not-a-date', false), 'not-a-date');
  const dated = FSProfiles.formatBornLabel('2000-01-01', false);
  assert.ok(dated.includes('(') && /year/.test(dated)); // includes an age in years
});

test('getters return empty on an unfilled cache', () => {
  assert.equal(FSProfiles.getAvatarProfile('x'), null);
  assert.equal(FSProfiles.getGroupName('x'), '');
  assert.equal(FSProfiles.getActiveGroupInfo(), null);
  assert.equal(FSProfiles.isAgentInGroup('x'), false);
  assert.equal(FSProfiles.hasAgentProfileCap(), false);
});
