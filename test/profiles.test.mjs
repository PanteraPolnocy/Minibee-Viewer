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
  // The module arms long timers (fetch timeouts, in-flight guards). Real ones,
  // but unref'd, so a test file does not sit around for 30s after its last
  // assertion waiting for them to fire.
  setTimeout: (fn, ms) => {
    const t = globalThis.setTimeout(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  },
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

// --- a notice reply is matched to the read that asked for it ----------------
//
// GroupNoticeRequest is answered with an IM whose id should be the notice's.
// The reference viewer never checks that id - it shows whatever notice the
// group server sends back - so a reply under an unexpected (or null) id is
// filed under the oldest pending read rather than left unclaimed while the
// Notices tab waits until it gives up.

test('notice detail: an exact id match resolves that read', async () => {
  const notice = '31313131-3434-5656-7878-909090909090';
  const p = BeeProfiles.fetchGroupNotice(notice);
  emit('group-notice-detail', { noticeId: notice, subject: 'Meeting', text: 'Bring snacks.' });
  const got = await p;
  assert.equal(got.subject, 'Meeting');
  assert.equal(got.noticeId, notice);
  assert.equal(BeeProfiles.getGroupNoticeDetail(notice).text, 'Bring snacks.');
});

test('notice detail: an exact match wins over the pending order', async () => {
  const first = '32323232-3434-5656-7878-909090909090';
  const second = '33333333-3434-5656-7878-909090909090';
  const p1 = BeeProfiles.fetchGroupNotice(first);
  const p2 = BeeProfiles.fetchGroupNotice(second);
  emit('group-notice-detail', { noticeId: second, subject: 'Second' });
  emit('group-notice-detail', { noticeId: first, subject: 'First' });
  assert.equal((await p1).subject, 'First');
  assert.equal((await p2).subject, 'Second');
});

test('notice detail: a reply under an unexpected id is filed under the oldest pending read', async () => {
  const asked = '34343434-3434-5656-7878-909090909090';
  const wire = '35353535-3434-5656-7878-909090909090';
  const p = BeeProfiles.fetchGroupNotice(asked);
  emit('group-notice-detail', {
    noticeId: wire, subject: 'Party', text: 'Saturday',
    attachment: { itemName: 'Hat', transactionId: wire }
  });
  const got = await p;
  assert.equal(got.subject, 'Party');
  assert.equal(got.noticeId, asked, 'the detail is keyed by the notice that was asked for');
  assert.equal(got.attachment.transactionId, wire, 'the wire id still drives the attachment reply');
  assert.equal(BeeProfiles.getGroupNoticeDetail(asked).subject, 'Party');
  assert.equal(BeeProfiles.getGroupNoticeDetail(wire), null, 'nothing is left under the stray id');
});

test('notice detail: replies under the null id answer pending reads in order', async () => {
  const first = '36363636-3434-5656-7878-909090909090';
  const second = '37373737-3434-5656-7878-909090909090';
  const p1 = BeeProfiles.fetchGroupNotice(first);
  const p2 = BeeProfiles.fetchGroupNotice(second);
  emit('group-notice-detail', { noticeId: ZERO, subject: 'One' });
  emit('group-notice-detail', { noticeId: ZERO, subject: 'Two' });
  assert.equal((await p1).subject, 'One');
  assert.equal((await p2).subject, 'Two');
});

test('notice detail: with nothing pending, a reply is kept under its own id', () => {
  const wire = '38383838-3434-5656-7878-909090909090';
  emit('group-notice-detail', { noticeId: wire, subject: 'Late' });
  assert.equal(BeeProfiles.getGroupNoticeDetail(wire).subject, 'Late');
  // ...and one with no usable id at all is dropped rather than cached under ''.
  emit('group-notice-detail', { noticeId: ZERO, subject: 'Nobody asked' });
  assert.equal(BeeProfiles.getGroupNoticeDetail(ZERO), null);
});

test('notice detail: a re-read keeps the attachment answer already given', async () => {
  const notice = '39393939-3434-5656-7878-909090909090';
  const p = BeeProfiles.fetchGroupNotice(notice);
  emit('group-notice-detail', { noticeId: notice, subject: 'Gift', attachment: { itemName: 'Hat' } });
  await p;
  assert.equal(BeeProfiles.markGroupNoticeAttachment(notice, 'Kept'), true);
  const again = BeeProfiles.fetchGroupNotice(notice);
  emit('group-notice-detail', { noticeId: notice, subject: 'Gift', attachment: { itemName: 'Hat' } });
  assert.equal((await again).attachmentResponse, 'Kept');
});
