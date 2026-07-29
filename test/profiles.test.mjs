// Unit tests for the pure helpers in src/js/protocol/sl-profiles.js (the
// Rust-fed profile/group cache mirror). Loaded as an IIFE in a function scope
// with stubbed globals, like the other frontend tests. Event ingestion +
// fetches (which need the live core) are not exercised here - only the pure
// formatting/URL/getter helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

const handlers = {};
const requests = [];

const BeeProfiles = loadBeeModule('js/core/sl-profiles.ts', 'BeeProfiles', {
  window: {},
  document: undefined,
  // Mirrors BeeUtils.normUuid exactly - a looser stub would let the id guard in
  // normId() look stricter here than it really is.
  BeeUtils: { normUuid: (id) => String(id || '').toLowerCase().replace(/[{}]/g, '').trim() },
  // Capture the event handlers the module registers at load, so the cache-merge
  // behaviour can be driven directly. Every "the image vanished a moment later"
  // bug has lived in these handlers, and a no-op listen stub could never see them.
  BeeBridge: {
    listen: (name, fn) => { handlers[name] = fn; },
    // Record sl_request_* calls into whichever collector is on top, so tests
    // can assert that a thumbnail actually got requested.
    invoke: (cmd, args) => {
      const sink = requests[requests.length - 1];
      if (sink && cmd === 'sl_request_avatar_properties') sink.push(args || {});
      return Promise.resolve();
    },
  },
});

const emit = (name, payload) => {
  const fn = handlers['minibee-viewer://' + name];
  if (!fn) throw new Error('no handler registered for ' + name);
  fn(payload);
};

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

// --- cache merges must never erase what they already know -------------------
//
// The profile cache is fed by several messages describing the same subject, and
// most of them carry only a subset of the fields. Overwriting wholesale means a
// reply that simply omits a picture erases the picture - which is exactly how
// avatar and group images appeared and then vanished a moment later.

const ZERO = '00000000-0000-0000-0000-000000000000';
const GID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const INSIGNIA = '11111111-2222-3333-4444-555555555555';
const AID = '99999999-8888-7777-6666-555555555555';
const PORTRAIT = 'abcdef01-2345-6789-abcd-ef0123456789';

test('group insignia survives an active-group notification', () => {
  emit('group-profile', { groupId: GID, name: 'Bee Keepers', insigniaId: INSIGNIA });
  assert.equal(BeeProfiles.getGroupInsigniaId(GID), INSIGNIA);
  // active-group never carries an insignia at all
  emit('active-group', { id: GID, name: 'Bee Keepers', title: 'Drone' });
  assert.equal(BeeProfiles.getGroupInsigniaId(GID), INSIGNIA, 'insignia was erased');
  assert.equal(BeeProfiles.getGroupName(GID), 'Bee Keepers');
});

test('group insignia survives a membership list without one', () => {
  emit('group-profile', { groupId: GID, name: 'Bee Keepers', insigniaId: INSIGNIA });
  emit('group-membership', { groups: [{ id: GID, name: 'Bee Keepers' }] });
  assert.equal(BeeProfiles.getGroupInsigniaId(GID), INSIGNIA);
});

test('group insignia survives a profile groups list without one', () => {
  emit('group-profile', { groupId: GID, name: 'Bee Keepers', insigniaId: INSIGNIA });
  emit('avatar-groups', { avatarId: AID, groups: [{ id: GID, name: 'Bee Keepers' }] });
  assert.equal(BeeProfiles.getGroupInsigniaId(GID), INSIGNIA);
});

test('group insignia is still updated when a reply does carry a new one', () => {
  const next = '22222222-3333-4444-5555-666666666666';
  emit('group-profile', { groupId: GID, name: 'Bee Keepers', insigniaId: INSIGNIA });
  emit('group-profile', { groupId: GID, name: 'Bee Keepers', insigniaId: next });
  assert.equal(BeeProfiles.getGroupInsigniaId(GID), next, 'a real insignia must win');
});

test('group insignia is not replaced by the null uuid', () => {
  emit('group-profile', { groupId: GID, name: 'Bee Keepers', insigniaId: INSIGNIA });
  emit('group-profile', { groupId: GID, name: 'Bee Keepers', insigniaId: ZERO });
  assert.equal(BeeProfiles.getGroupInsigniaId(GID), INSIGNIA);
});

test('avatar portrait survives a later reply that omits it', () => {
  // UDP lands first with the image id, then the slower HTTP cap reply arrives
  // describing the same resident but carrying no image key at all.
  emit('avatar-profile', { avatarId: AID, imageId: PORTRAIT, source: 'udp' });
  assert.equal(BeeProfiles.getImageId(AID), PORTRAIT);
  emit('avatar-profile', { avatarId: AID, about: 'hello', source: 'cap' });
  assert.equal(BeeProfiles.getImageId(AID), PORTRAIT, 'portrait was erased by the cap reply');
  assert.equal(BeeProfiles.getAvatarProfile(AID).about, 'hello', 'cap fields still applied');
});

test('avatar notes do not disturb the portrait', () => {
  emit('avatar-profile', { avatarId: AID, imageId: PORTRAIT, source: 'udp' });
  emit('avatar-notes', { targetId: AID, notes: 'remember the hat' });
  assert.equal(BeeProfiles.getImageId(AID), PORTRAIT);
  assert.equal(BeeProfiles.getAvatarProfile(AID).notes, 'remember the hat');
});

test('avatar portrait survives a reply that sends it as an empty string', () => {
  // Belt and braces: the engine now omits keys it has no answer for, but no
  // emitter should be able to blank a uuid it already told us about.
  emit('avatar-profile', { avatarId: AID, imageId: PORTRAIT, source: 'udp' });
  emit('avatar-profile', { avatarId: AID, imageId: '', partnerId: '', source: 'cap' });
  assert.equal(BeeProfiles.getImageId(AID), PORTRAIT);
});

test('avatar portrait survives a reply that sends the null uuid', () => {
  emit('avatar-profile', { avatarId: AID, imageId: PORTRAIT, source: 'udp' });
  emit('avatar-profile', { avatarId: AID, imageId: ZERO, source: 'cap' });
  assert.equal(BeeProfiles.getImageId(AID), PORTRAIT);
});

test('a real new portrait still replaces the old one', () => {
  const next = '77777777-6666-5555-4444-333333333333';
  emit('avatar-profile', { avatarId: AID, imageId: PORTRAIT, source: 'udp' });
  emit('avatar-profile', { avatarId: AID, imageId: next, source: 'cap' });
  assert.equal(BeeProfiles.getImageId(AID), next, 'a real image id must win');
});

// --- queueAvatarThumb must not be silenced by a bare cache entry -------------

test('queueAvatarThumb: a notes reply alone does not suppress the request', () => {
  const id = '12121212-3434-5656-7878-909090909090';
  const asked = [];
  requests.push(asked);                       // capture invokes for this test
  emit('avatar-notes', { targetId: id, notes: 'hi' });   // bare cache entry, no picture
  BeeProfiles.queueAvatarThumb(id);
  assert.equal(asked.length, 1, 'the thumbnail was never requested');
  assert.equal(asked[0].avatarId, id);
  requests.pop();
});

test('queueAvatarThumb: a real properties reply does suppress it', () => {
  const id = '13131313-3434-5656-7878-909090909090';
  const asked = [];
  requests.push(asked);
  emit('avatar-profile', { avatarId: id, imageId: PORTRAIT, source: 'udp' });
  BeeProfiles.queueAvatarThumb(id);
  assert.equal(asked.length, 0, 'we already know this picture');
  requests.pop();
});

test('queueAvatarThumb: a properties reply with no picture is still an answer', () => {
  // Someone who simply has no profile picture must not be re-asked forever.
  const id = '14141414-3434-5656-7878-909090909090';
  const asked = [];
  requests.push(asked);
  emit('avatar-profile', { avatarId: id, source: 'udp' });
  BeeProfiles.queueAvatarThumb(id);
  assert.equal(asked.length, 0);
  requests.pop();
});
