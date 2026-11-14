// Unit tests for the IM side of src/js/state.ts (BeeState): the two unread
// counts (people, and group chats with conferences), and the group chats the
// user turned away - closed ones stay closed, a group's mute belongs to the
// group, both are remembered per account, and a conference only for the login.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

const ME = '11111111-1111-1111-1111-111111111111';
const SOMEONE_ELSE = '99999999-0000-0000-0000-000000000009';
const ALICE = '22222222-2222-2222-2222-222222222222';
const SHOP = 'aaaaaaaa-0000-0000-0000-00000000000a';
const CLUB = 'bbbbbbbb-0000-0000-0000-00000000000b';
const CONF = 'cccccccc-0000-0000-0000-00000000000c';
const STORE_KEY = 'minibee-group-chats';

function xorSessionId(a, b) {
  const strip = (id) => id.replace(/-/g, '');
  const hex = (BigInt('0x' + strip(a)) ^ BigInt('0x' + strip(b))).toString(16).padStart(32, '0');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

// One viewer: a fresh BeeState over a settings store that outlives it (pass
// the same `store` to the next call to play a restart).
function boot(store = new Map()) {
  const BeeState = loadBeeModule('js/state.ts', 'BeeState', {
    BeeUtils: {
      storageGet: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      storageSet: (key, value) => { store.set(key, JSON.parse(JSON.stringify(value))); },
      xorSessionId
    },
    console: { error: () => {} }
  });
  const refused = [];
  BeeState.on('im-refused-chats', (ids) => refused.push(ids.slice()));
  return { BeeState, store, refused };
}

function login(BeeState, agentId = ME) {
  BeeState.patch({ connected: true, agent: { id: agentId, name: 'Me' }, activeTab: 'chat' });
}

let seq = 0;
function line(text, from = ALICE) {
  seq += 1;
  return { id: 'm' + seq, fromId: from, fromName: 'Alice', text, outgoing: false, timestamp: 1000 + seq };
}

function groupLine(BeeState, groupId, text = 'hello group', type = 'group') {
  BeeState.addImMessage(groupId, line(text), { id: ALICE, name: 'Alice' }, { id: groupId, type, title: '' });
}

function personLine(BeeState, text = 'hello you') {
  const sid = BeeState.ensureImSession({ id: ALICE, name: 'Alice' });
  BeeState.addImMessage(sid, line(text), { id: ALICE, name: 'Alice' }, null);
  return sid;
}

test('people and group chats are counted apart', () => {
  const { BeeState } = boot();
  login(BeeState);
  const changes = [];
  BeeState.on('change', (partial) => changes.push(partial));

  personLine(BeeState);
  assert.equal(BeeState.get().unreadIm, 1);
  assert.equal(BeeState.get().unreadImGroups, 0, 'a person is not a group');

  groupLine(BeeState, SHOP);
  groupLine(BeeState, SHOP);
  groupLine(BeeState, CONF, 'hi all', 'conference');
  assert.equal(BeeState.get().unreadIm, 4, 'the total is every row');
  assert.equal(BeeState.get().unreadImGroups, 3, 'group chats and conferences share the quiet count');
  assert.ok(changes.some((p) => 'unreadImGroups' in p), 'the split is announced like the total');

  // Reading the group leaves the person's count alone.
  BeeState.markImSessionRead(SHOP);
  assert.equal(BeeState.get().unreadIm, 2);
  assert.equal(BeeState.get().unreadImGroups, 1);
});

test('a closed group chat stays closed', () => {
  const { BeeState, store, refused } = boot();
  login(BeeState);
  groupLine(BeeState, SHOP);
  assert.ok(BeeState.get().imSessions[SHOP]);
  assert.equal(BeeState.isChatRefused(SHOP), false);

  // What the IM tab does when the user closes the row.
  assert.equal(BeeState.refuseChat(SHOP), true);
  BeeState.closeImSession(SHOP);
  assert.equal(BeeState.get().unreadIm, 0, 'its count went with it');
  assert.equal(BeeState.isChatRefused(SHOP), true);
  assert.deepEqual(BeeState.refusedChats(), [SHOP]);
  assert.deepEqual(refused.at(-1), [SHOP], 'the core is told');
  assert.deepEqual(store.get(STORE_KEY), { [ME]: { closed: [SHOP], muted: [] } }, 'remembered for the account');

  // The line that was already on its way in opens nothing and counts nowhere.
  let heard = 0;
  BeeState.on('im', () => { heard += 1; });
  groupLine(BeeState, SHOP, 'still here?');
  assert.equal(BeeState.get().imSessions[SHOP], undefined, 'no tab comes back');
  assert.equal(BeeState.get().unreadIm, 0);
  assert.equal(BeeState.get().unreadImGroups, 0);
  assert.equal(heard, 0, 'no sound, no log line, no phone alert hangs off it');

  // Another group is not affected.
  groupLine(BeeState, CLUB);
  assert.ok(BeeState.get().imSessions[CLUB]);
  assert.equal(BeeState.get().unreadImGroups, 1);
});

test('a closed group comes back when the user opens it', () => {
  const { BeeState, store, refused } = boot();
  login(BeeState);
  groupLine(BeeState, SHOP);
  BeeState.refuseChat(SHOP);
  BeeState.closeImSession(SHOP);

  // What "Open group chat" on the group does: welcome first, then the tab.
  assert.equal(BeeState.welcomeChat(SHOP), true);
  assert.equal(BeeState.isChatRefused(SHOP), false);
  assert.deepEqual(refused.at(-1), [], 'the core is told before the session is started');
  assert.equal(store.get(STORE_KEY)[ME], undefined, 'nothing left to remember');
  BeeState.ensureKeyedSession(SHOP, { type: 'group', title: 'Shop' });
  const session = BeeState.get().imSessions[SHOP];
  assert.ok(session, 'the tab is there to open');
  assert.equal(session.messages.length, 0, 'a new tab, not the old one');
  assert.ok(!session.muted);

  // And it is a live chat again.
  groupLine(BeeState, SHOP, 'welcome back');
  assert.equal(BeeState.get().imSessions[SHOP].messages.length, 1);
  assert.equal(BeeState.get().unreadImGroups, 1);

  // Welcoming a chat that was never closed changes nothing.
  assert.equal(BeeState.welcomeChat(CLUB), false);
});

test('a mute belongs to the group and outlives the tab and the login', () => {
  const first = boot();
  login(first.BeeState);
  groupLine(first.BeeState, SHOP);
  assert.equal(first.BeeState.get().unreadImGroups, 1);

  assert.equal(first.BeeState.setSessionMuted(SHOP), true);
  assert.equal(first.BeeState.get().unreadImGroups, 0, 'muting spends the count');
  assert.deepEqual(first.store.get(STORE_KEY), { [ME]: { closed: [], muted: [SHOP] } });
  // The open chat stays - that is where it can be unmuted - and stays quiet.
  assert.equal(first.BeeState.isChatRefused(SHOP), false);
  assert.deepEqual(first.BeeState.refusedChats(), []);
  groupLine(first.BeeState, SHOP, 'sale!');
  assert.equal(first.BeeState.get().imSessions[SHOP].messages.length, 2, 'the open chat still fills');
  assert.equal(first.BeeState.get().unreadIm, 0, 'and lights nothing');

  // Logging out takes the tab away; from then on the group is turned away.
  first.BeeState.reset();

  const second = boot(first.store);
  assert.deepEqual(second.BeeState.refusedChats(ME), [SHOP], 'the list the session starts with');
  login(second.BeeState);
  assert.equal(second.BeeState.isChatRefused(SHOP), true);
  groupLine(second.BeeState, SHOP, 'sale again!');
  assert.equal(second.BeeState.get().imSessions[SHOP], undefined, 'a muted group opens no tab by itself');
  assert.equal(second.BeeState.get().unreadIm, 0);

  // Opened from the group, it is still muted, and no longer turned away.
  second.BeeState.welcomeChat(SHOP);
  second.BeeState.ensureKeyedSession(SHOP, { type: 'group', title: 'Shop' });
  assert.equal(second.BeeState.get().imSessions[SHOP].muted, true);
  assert.equal(second.BeeState.isChatRefused(SHOP), false);
  assert.deepEqual(second.refused.at(-1), [], 'the core lets its chat in again');
  groupLine(second.BeeState, SHOP, 'psst');
  assert.equal(second.BeeState.get().imSessions[SHOP].messages.length, 1);
  assert.equal(second.BeeState.get().unreadIm, 0, 'its count stays at zero');

  // Unmuting is undone on the chat, and forgotten with it.
  assert.equal(second.BeeState.setSessionMuted(SHOP), false);
  assert.equal(second.store.get(STORE_KEY)[ME], undefined);
  groupLine(second.BeeState, SHOP, 'now you hear me');
  assert.equal(second.BeeState.get().unreadImGroups, 1);
});

test('a muted group whose tab goes away is turned away again', () => {
  const { BeeState, refused } = boot();
  login(BeeState);
  groupLine(BeeState, SHOP);
  BeeState.setSessionMuted(SHOP, true);
  assert.deepEqual(BeeState.refusedChats(), []);
  // The grid closed the session: not the user's doing, but the tab is gone.
  BeeState.closeImSession(SHOP);
  assert.deepEqual(BeeState.refusedChats(), [SHOP]);
  assert.deepEqual(refused.at(-1), [SHOP]);
});

test('a conference that was left stays away for the login only', () => {
  const first = boot();
  login(first.BeeState);
  groupLine(first.BeeState, CONF, 'hi all', 'conference');
  first.BeeState.refuseChat(CONF);
  first.BeeState.closeImSession(CONF);
  assert.equal(first.BeeState.isChatRefused(CONF), true);
  assert.deepEqual(first.BeeState.refusedChats(), [CONF]);
  assert.equal(first.store.has(STORE_KEY), false, 'its id means nothing tomorrow: not written down');
  groupLine(first.BeeState, CONF, 'come back', 'conference');
  assert.equal(first.BeeState.get().imSessions[CONF], undefined);

  // A conference's mute lasts as long as its tab.
  groupLine(first.BeeState, CLUB, 'hi', 'conference');
  first.BeeState.setSessionMuted(CLUB, true);
  assert.equal(first.store.has(STORE_KEY), false);

  first.BeeState.reset();
  assert.equal(first.BeeState.isChatRefused(CONF), false, 'forgotten at logout');
  login(first.BeeState);
  assert.deepEqual(first.BeeState.refusedChats(), []);
});

test('every account has its own lists', () => {
  const first = boot();
  login(first.BeeState);
  groupLine(first.BeeState, SHOP);
  first.BeeState.refuseChat(SHOP);
  first.BeeState.closeImSession(SHOP);
  first.BeeState.reset();

  const other = boot(first.store);
  assert.deepEqual(other.BeeState.refusedChats(SOMEONE_ELSE), []);
  login(other.BeeState, SOMEONE_ELSE);
  assert.equal(other.BeeState.isChatRefused(SHOP), false);
  groupLine(other.BeeState, SHOP);
  assert.ok(other.BeeState.get().imSessions[SHOP], 'the other account never closed it');
  other.BeeState.setSessionMuted(SHOP, true);
  assert.deepEqual(first.store.get(STORE_KEY), {
    [ME]: { closed: [SHOP], muted: [] },
    [SOMEONE_ELSE]: { closed: [], muted: [SHOP] }
  });
  other.BeeState.reset();

  // Back as the first account: the id's case in storage or on the wire does not matter.
  const back = boot(first.store);
  assert.deepEqual(back.BeeState.refusedChats(ME.toUpperCase()), [SHOP]);
  login(back.BeeState);
  assert.equal(back.BeeState.isChatRefused(SHOP.toUpperCase()), true);
});

test('the core only hears about real changes', () => {
  const { BeeState, refused } = boot();
  login(BeeState);
  groupLine(BeeState, SHOP);
  groupLine(BeeState, CLUB);
  const before = refused.length;
  // Tabs opening, a mute on an open chat: the list of chats to refuse is unchanged.
  BeeState.setSessionMuted(CLUB, true);
  BeeState.setSessionMuted(CLUB, false);
  groupLine(BeeState, SHOP, 'more');
  assert.equal(refused.length, before);
  BeeState.refuseChat(SHOP);
  BeeState.refuseChat(SHOP);
  BeeState.closeImSession(SHOP);
  assert.equal(refused.length, before + 1, 'one change, one word');
  assert.equal(BeeState.refuseChat('not-an-id'), false);
  assert.equal(refused.length, before + 1);
});

test('a chat that turns out to be a group takes the group\'s mute', () => {
  const first = boot();
  login(first.BeeState);
  groupLine(first.BeeState, SHOP);
  first.BeeState.setSessionMuted(SHOP, true);
  first.BeeState.reset();

  // The next login's first line arrives before the membership list, typed as
  // a conference, and the user had already opened the tab by hand.
  const second = boot(first.store);
  login(second.BeeState);
  second.BeeState.welcomeChat(SHOP);
  second.BeeState.ensureKeyedSession(SHOP, { type: 'conference', title: '' });
  assert.ok(!second.BeeState.get().imSessions[SHOP].muted, 'nothing says it is the group yet');
  second.BeeState.setSessionType(SHOP, 'group');
  assert.equal(second.BeeState.get().imSessions[SHOP].muted, true);

  // The other way round: muted while it passed for a conference, it hands the mute to the group.
  second.BeeState.ensureKeyedSession(CLUB, { type: 'conference', title: '' });
  second.BeeState.setSessionMuted(CLUB, true);
  second.BeeState.setSessionType(CLUB, 'group');
  assert.deepEqual(second.store.get(STORE_KEY)[ME].muted, [SHOP, CLUB].sort());
});

test('closing a person is unchanged: the next message brings them back', () => {
  const { BeeState, store } = boot();
  login(BeeState);
  const sid = personLine(BeeState);
  assert.equal(BeeState.get().unreadIm, 1);
  BeeState.dismissImSession(sid);
  assert.equal(BeeState.get().imSessions[sid].dismissed, true);
  assert.equal(BeeState.get().unreadIm, 0);
  assert.equal(BeeState.isChatRefused(sid), false);
  personLine(BeeState, 'are you there?');
  assert.equal(BeeState.get().imSessions[sid].dismissed, false);
  assert.equal(BeeState.get().unreadIm, 1);
  assert.equal(BeeState.get().unreadImGroups, 0);
  assert.equal(store.has(STORE_KEY), false);
});
