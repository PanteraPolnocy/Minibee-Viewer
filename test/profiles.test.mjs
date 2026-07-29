// Unit tests for the pure helpers in src/js/protocol/sl-profiles.js (the
// Rust-fed profile/group cache mirror). Loaded as an IIFE in a function scope
// with stubbed globals, like the other frontend tests. Event ingestion +
// fetches (which need the live core) are not exercised here - only the pure
// formatting/URL/getter helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

const BeeProfiles = loadBeeModule('js/core/sl-profiles.ts', 'BeeProfiles', {
  window: {},
  document: undefined,
  // Mirrors BeeUtils.normUuid exactly - a looser stub would let the id guard in
  // normId() look stricter here than it really is.
  BeeUtils: { normUuid: (id) => String(id || '').toLowerCase().replace(/[{}]/g, '').trim() },
  BeeBridge: { listen: () => {}, invoke: () => Promise.resolve() },
});

test('isZero: empty and null-uuid are zero', () => {
  assert.equal(BeeProfiles.isZero(''), true);
  assert.equal(BeeProfiles.isZero('00000000-0000-0000-0000-000000000000'), true);
  assert.equal(BeeProfiles.isZero('abcdef01-0000-0000-0000-000000000000'), false);
});

const TEX_ID = 'abcdef01-2345-6789-abcd-ef0123456789';

test('textureImageUrl: builds SL image URL, empty for zero', () => {
  assert.equal(BeeProfiles.textureImageUrl(TEX_ID, 512), 'https://secondlife.com/app/image/' + TEX_ID + '/512');
  assert.equal(BeeProfiles.textureImageUrl(TEX_ID), 'https://secondlife.com/app/image/' + TEX_ID + '/256');
  assert.equal(BeeProfiles.textureImageUrl('00000000-0000-0000-0000-000000000000'), '');
});

// The id guard is what keeps attacker-controlled path fragments out of the
// image URL, so pin both directions: canonical forms survive, junk becomes ''.
test('textureImageUrl: accepts the forms the wire produces', () => {
  // uppercase and brace-wrapped ids are normalised before the shape check
  assert.equal(BeeProfiles.textureImageUrl(TEX_ID.toUpperCase()), 'https://secondlife.com/app/image/' + TEX_ID + '/256');
  assert.equal(BeeProfiles.textureImageUrl('{' + TEX_ID + '}'), 'https://secondlife.com/app/image/' + TEX_ID + '/256');
  assert.equal(BeeProfiles.textureImageUrl('  ' + TEX_ID + '  '), 'https://secondlife.com/app/image/' + TEX_ID + '/256');
});

test('textureImageUrl: rejects anything that is not a canonical uuid', () => {
  assert.equal(BeeProfiles.textureImageUrl('abc'), '');                               // too short
  assert.equal(BeeProfiles.textureImageUrl(TEX_ID.replace(/-/g, '')), '');            // hyphenless
  assert.equal(BeeProfiles.textureImageUrl(TEX_ID + '/../../evil'), '');              // path traversal
  assert.equal(BeeProfiles.textureImageUrl('ghijklmn-2345-6789-abcd-ef0123456789'), ''); // non-hex
  assert.equal(BeeProfiles.textureImageUrl(''), '');
  assert.equal(BeeProfiles.textureImageUrl(null), '');
  assert.equal(BeeProfiles.textureImageUrl(undefined), '');
});

test('resolveWebProfileUrl: direct url wins, else username, else empty', () => {
  assert.equal(BeeProfiles.resolveWebProfileUrl({ profileUrl: 'https://x/y' }), 'https://x/y');
  assert.equal(BeeProfiles.resolveWebProfileUrl({ userName: 'ruth.resident' }), 'https://my.secondlife.com/ruth.resident');
  assert.equal(BeeProfiles.resolveWebProfileUrl({ userName: 'Ruth Resident' }), ''); // space -> not a slug
  assert.equal(BeeProfiles.resolveWebProfileUrl(null), '');
});

test('formatAvatarInterests: arrays + hasContent', () => {
  const full = BeeProfiles.formatAvatarInterests({ wantTo: ['Build'], skills: ['Scripting'], languagesText: 'en' });
  assert.equal(full.hasContent, true);
  assert.deepEqual(full.wantTo, ['Build']);
  assert.deepEqual(full.skills, ['Scripting']);
  assert.equal(full.languagesText, 'en');
  const empty = BeeProfiles.formatAvatarInterests(null);
  assert.equal(empty.hasContent, false);
  assert.deepEqual(empty.wantTo, []);
});

test('formatBornLabel: hidden, invalid, and dated', () => {
  assert.equal(BeeProfiles.formatBornLabel('2020-01-01', true), 'Age hidden');
  assert.equal(BeeProfiles.formatBornLabel('', false), '');
  assert.equal(BeeProfiles.formatBornLabel('not-a-date', false), 'not-a-date');
  const dated = BeeProfiles.formatBornLabel('2000-01-01', false);
  assert.ok(dated.includes('(') && /year/.test(dated)); // includes an age in years
});

test('getters return empty on an unfilled cache', () => {
  assert.equal(BeeProfiles.getAvatarProfile('x'), null);
  assert.equal(BeeProfiles.getGroupName('x'), '');
  assert.equal(BeeProfiles.getActiveGroupInfo(), null);
  assert.equal(BeeProfiles.isAgentInGroup('x'), false);
  assert.equal(BeeProfiles.hasAgentProfileCap(), true);
});
