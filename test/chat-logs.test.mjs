// Unit tests for src/js/chat-logs.ts (BeeChatLogs) over the real BeeState:
// what is asked of a log file is asked in order (the history before the
// lines, the lines one at a time), and the history block of a conversation
// is built from the log's tail and the earlier messages the grid keeps
// without showing a message twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

const ME = '11111111-1111-1111-1111-111111111111';
const ALICE = '22222222-2222-2222-2222-222222222222';
const SHOP = 'aaaaaaaa-0000-0000-0000-00000000000a';

function xorSessionId(a, b) {
  const strip = (id) => id.replace(/-/g, '');
  const hex = (BigInt('0x' + strip(a)) ^ BigInt('0x' + strip(b))).toString(16).padStart(32, '0');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

// Lets everything already resolved run its course.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A transport whose every answer waits to be given by the test.
function makeTransport() {
  const handlers = new Map();
  const calls = [];
  const names = new Map();
  const ask = (kind, args) => new Promise((resolve, reject) => {
    calls.push({ kind, args, resolve, reject });
  });
  return {
    calls,
    names,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    emit(event, payload) {
      (handlers.get(event) || []).forEach((fn) => fn(payload));
    },
    of: (kind) => calls.filter((c) => c.kind === kind),
    chatLogAppend: (kind, name, line) => ask('append', { kind, name, line }),
    chatLogTail: (kind, name, lines) => ask('tail', { kind, name, lines }),
    imHistory: (peer) => ask('history', { peer }),
    getCachedNameInfo: (id) => names.get(String(id).toLowerCase()) || null,
    queueNameResolve: () => {},
    getGroupName: () => ''
  };
}

// One viewer: the real state, the log keeper over it, and timers that only
// run when the test says so.
function boot(options = {}) {
  const BeeState = loadBeeModule('js/state.ts', 'BeeState', {
    BeeUtils: { storageGet: (_key, fallback) => fallback, storageSet: () => {}, xorSessionId },
    console: { error: () => {} }
  });
  const transport = makeTransport();
  const settings = Object.assign({
    chatLogsAvatars: true, chatLogsGroups: true, chatLogsLocal: true, chatLogsAsked: true
  }, options.settings || {});
  const timers = [];
  const BeeChatLogs = loadBeeModule('js/chat-logs.ts', 'BeeChatLogs', {
    BeeState,
    BeeTransport: transport,
    BeeSettings: { get: (key) => settings[key], set: (key, value) => { settings[key] = value; } },
    BeeUtils: { confirm: async () => false },
    window: {},
    setTimeout: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.live = false; }
  });
  BeeChatLogs.init();
  BeeState.patch({ connected: true, agent: { id: ME, name: 'Me Resident', displayName: 'Me' }, activeTab: 'chat' });
  return { BeeState, transport, settings, timers };
}

let seq = 0;
function line(text, extra = {}) {
  seq += 1;
  return Object.assign({
    id: 'm' + seq, fromId: ALICE, fromName: 'Alice', text, outgoing: false,
    timestamp: new Date(2026, 10, 24, 10, 5).getTime()
  }, extra);
}

// A moment of 24 November 2026 in this device's time, as a timestamp.
const at = (hour, minute, second = 0) => new Date(2026, 10, 24, hour, minute, second).getTime();

const ALICE_KNOWN = { id: ALICE, name: 'Alice', userName: 'Alice Resident' };

const historyOf = (BeeState, sid) => BeeState.get().imSessions[sid].messages.filter((m) => m.history);
const textsOf = (BeeState, sid) => BeeState.get().imSessions[sid].messages.map((m) => m.text);

test('the history is read before the first line is written, and lines go out one at a time', async () => {
  const { BeeState, transport } = boot();
  // A message opens the conversation, and two more come right behind it:
  // the burst a login brings when messages were kept while offline.
  const sid = BeeState.ensureImSession(ALICE_KNOWN);
  BeeState.addImMessage(sid, line('one'), ALICE_KNOWN, null);
  BeeState.addImMessage(sid, line('two'), ALICE_KNOWN, null);
  BeeState.addImMessage(sid, line('three'), ALICE_KNOWN, null);
  await settle();

  // Only the tail has been asked for; nothing is written under it yet.
  assert.deepEqual(transport.calls.map((c) => c.kind), ['tail']);
  assert.deepEqual(transport.calls[0].args, { kind: 'avatars', name: 'alice', lines: 10 });

  // The tail arrives - the file as it was before this conversation's lines.
  transport.calls[0].resolve({ ok: true, lines: ['[2026-11-23 21:00] Alice: yesterday'] });
  await settle();
  assert.deepEqual(transport.calls.map((c) => c.kind), ['tail', 'append'], 'one line at a time');
  assert.equal(transport.calls[1].args.line, '[2026-11-24 10:05] Alice: one');

  transport.calls[1].resolve({ ok: true });
  await settle();
  assert.equal(transport.of('append').length, 2);
  // A write that fails holds nothing up.
  transport.calls[2].reject(new Error('disk full'));
  await settle();
  assert.deepEqual(
    transport.of('append').map((c) => c.args.line),
    ['[2026-11-24 10:05] Alice: one', '[2026-11-24 10:05] Alice: two', '[2026-11-24 10:05] Alice: three'],
    'in the order it was said'
  );

  // On screen: the tail, then the three lines, each once.
  assert.deepEqual(textsOf(BeeState, sid), ['[2026-11-23 21:00] Alice: yesterday', 'one', 'two', 'three']);
});

test('a name that arrives late: the history is read first, then the waiting lines are filed', async () => {
  const { BeeState, transport } = boot();
  // Nobody knows this person's username yet.
  const stranger = { id: ALICE, name: 'Alice' };
  const sid = BeeState.ensureImSession(stranger);
  BeeState.addImMessage(sid, line('hello'), stranger, null);
  await settle();
  assert.equal(transport.calls.length, 0, 'nothing is read or written under a name nobody knows');

  transport.names.set(ALICE, { userName: 'alice.wonder', displayName: 'Alice' });
  transport.emit('names-updated');
  await settle();
  assert.deepEqual(transport.calls.map((c) => c.kind), ['tail']);
  assert.equal(transport.calls[0].args.name, 'alice.wonder');

  transport.calls[0].resolve({ ok: true, lines: [] });
  await settle();
  assert.deepEqual(transport.calls.map((c) => c.kind), ['tail', 'append']);
  assert.deepEqual(transport.calls[1].args, { kind: 'avatars', name: 'alice.wonder', line: '[2026-11-24 10:05] Alice: hello' });
  assert.deepEqual(textsOf(BeeState, sid), ['hello'], 'an empty file adds nothing');
});

test('group lines and nearby chat take turns in their own files', async () => {
  const { BeeState, transport } = boot();
  BeeState.addImMessage(SHOP, line('first'), ALICE_KNOWN, { id: SHOP, type: 'group', title: 'The Shop' });
  BeeState.addImMessage(SHOP, line('second'), ALICE_KNOWN, { id: SHOP, type: 'group', title: 'The Shop' });
  BeeState.addChatMessage({ id: 'c1', fromName: 'Bob', text: 'nearby', timestamp: at(10, 6) });
  await settle();
  // The group's tail and the nearby line are different files: neither waits for the other.
  assert.deepEqual(transport.calls.map((c) => c.kind + ':' + c.args.kind), ['tail:groups', 'append:local']);
  transport.calls[0].resolve({ ok: true, lines: [] });
  await settle();
  transport.of('append').find((c) => c.args.kind === 'groups').resolve({ ok: true });
  await settle();
  assert.deepEqual(
    transport.of('append').filter((c) => c.args.kind === 'groups').map((c) => c.args.line),
    ['[2026-11-24 10:05] Alice: first', '[2026-11-24 10:05] Alice: second']
  );
  assert.equal(transport.of('append').find((c) => c.args.kind === 'local').args.name, 'Nearby Chat');
  // A group has no history kept by the grid: none is asked for.
  BeeState.patch({ activeImSession: SHOP });
  assert.equal(transport.of('history').length, 0);
});

test('opening a private conversation asks the core for the earlier messages the grid keeps', async () => {
  const { BeeState, transport } = boot();
  const sid = BeeState.ensureImSession(ALICE_KNOWN);
  await settle();
  transport.of('tail')[0].resolve({ ok: true, lines: [] });
  assert.equal(transport.of('history').length, 0, 'a conversation nobody has opened asks for nothing');

  // Opened: the state says which conversation is on screen, then the tab is shown.
  BeeState.patch({ activeImSession: sid });
  BeeState.patch({ activeTab: 'im' });
  assert.equal(transport.of('history').length, 1, 'once, while the answer is on its way');
  assert.deepEqual(transport.of('history')[0].args, { peer: ALICE });

  // The core could not have it this time: it is asked again at the next opening.
  transport.of('history')[0].resolve({ ok: false, reason: 'busy' });
  await settle();
  assert.equal(historyOf(BeeState, sid).length, 0);
  BeeState.patch({ activeImSession: sid });
  assert.equal(transport.of('history').length, 2);

  // Handed over: shown, and not asked for again.
  transport.of('history')[1].resolve({
    ok: true,
    rows: [
      { id: 'g1', fromId: ALICE, fromName: 'Alice', text: 'are you there?', timestamp: at(9, 0, 30), outgoing: false },
      { id: 'g2', fromId: ME, fromName: 'Me Resident', text: 'yes', timestamp: at(9, 1, 10), outgoing: true }
    ]
  });
  await settle();
  assert.deepEqual(
    historyOf(BeeState, sid).map((m) => m.text),
    ['[2026-11-24 09:00] Alice: are you there?', '[2026-11-24 09:01] Me: yes'],
    'in the shape of log lines, this account under the name it shows'
  );
  assert.ok(historyOf(BeeState, sid).every((m) => m.grid));
  BeeState.patch({ activeImSession: sid });
  BeeState.patch({ activeTab: 'chat' });
  BeeState.patch({ activeTab: 'im' });
  assert.equal(transport.of('history').length, 2);

  // The core saying it is done settles it too.
  const { BeeState: other, transport: second } = boot();
  const sid2 = other.ensureImSession(ALICE_KNOWN);
  other.patch({ activeImSession: sid2 });
  second.of('history')[0].resolve({ ok: false, reason: 'done' });
  await settle();
  other.patch({ activeImSession: sid2 });
  assert.equal(second.of('history').length, 1);
});

test('the grid\'s messages stand in for the log lines they overlap; older log lines stay above', async () => {
  const { BeeState, transport } = boot();
  const sid = BeeState.ensureImSession(ALICE_KNOWN);
  await settle();
  transport.of('tail')[0].resolve({
    ok: true,
    lines: [
      '[2026-11-20 18:30] Alice: last week',
      '[2026-11-24 08:59] Me: morning',
      '[2026-11-24 09:00] Alice: are you there?',
      '[2026-11-24 09:01] Me: yes',
      'a line with no stamp'
    ]
  });
  await settle();
  assert.equal(historyOf(BeeState, sid).length, 5, 'the tail as the file holds it');

  BeeState.patch({ activeImSession: sid });
  transport.of('history')[0].resolve({
    ok: true,
    rows: [
      { id: 'g1', fromId: ALICE, fromName: 'Alice', text: 'are you there?', timestamp: at(9, 0, 30), outgoing: false },
      { id: 'g2', fromId: ME, fromName: '', text: 'yes', timestamp: at(9, 1, 10), outgoing: true },
      { id: 'g3', fromId: ALICE, fromName: '', text: 'written on the phone', timestamp: at(9, 30), outgoing: false }
    ]
  });
  await settle();
  // Lines stamped before the grid's first message stay; from that minute on
  // the grid's messages are the ones shown, and nothing is there twice.
  assert.deepEqual(textsOf(BeeState, sid), [
    '[2026-11-20 18:30] Alice: last week',
    '[2026-11-24 08:59] Me: morning',
    '[2026-11-24 09:00] Alice: are you there?',
    '[2026-11-24 09:01] Me: yes',
    '[2026-11-24 09:30] Alice: written on the phone'
  ]);
  assert.deepEqual(historyOf(BeeState, sid).map((m) => !!m.grid), [false, false, true, true, true]);

  // Nothing of this was written to the log: history is only shown.
  assert.equal(transport.of('append').length, 0);

  // An empty page leaves the log's tail as it was.
  const { BeeState: other, transport: second } = boot();
  const sid2 = other.ensureImSession(ALICE_KNOWN);
  await settle();
  second.of('tail')[0].resolve({ ok: true, lines: ['[2026-11-24 09:00] Alice: are you there?'] });
  await settle();
  other.patch({ activeImSession: sid2 });
  second.of('history')[0].resolve({ ok: true, rows: [] });
  await settle();
  assert.deepEqual(textsOf(other, sid2), ['[2026-11-24 09:00] Alice: are you there?']);
});

test('the tail arriving after the grid\'s messages does not double them', async () => {
  const { BeeState, transport } = boot();
  // Opened by hand, the username still unknown: the tail has to wait for it.
  const stranger = { id: ALICE, name: 'Alice' };
  const sid = BeeState.ensureImSession(stranger);
  BeeState.patch({ activeImSession: sid });
  transport.of('history')[0].resolve({
    ok: true,
    rows: [{ id: 'g1', fromId: ALICE, fromName: 'Alice', text: 'are you there?', timestamp: at(9, 0, 30), outgoing: false }]
  });
  await settle();
  assert.deepEqual(textsOf(BeeState, sid), ['[2026-11-24 09:00] Alice: are you there?']);

  transport.names.set(ALICE, { userName: 'alice.wonder' });
  transport.emit('names-updated');
  await settle();
  transport.of('tail')[0].resolve({
    ok: true,
    lines: ['[2026-11-23 20:00] Alice: yesterday', '[2026-11-24 09:00] Alice: are you there?']
  });
  await settle();
  assert.deepEqual(textsOf(BeeState, sid), [
    '[2026-11-23 20:00] Alice: yesterday',
    '[2026-11-24 09:00] Alice: are you there?'
  ]);
});

test('a history row its live message took out is not put back', async () => {
  const { BeeState, transport } = boot();
  const stranger = { id: ALICE, name: 'Alice' };
  const sid = BeeState.ensureImSession(stranger);
  BeeState.patch({ activeImSession: sid });
  transport.of('history')[0].resolve({
    ok: true,
    rows: [
      { id: 'g1', fromId: ALICE, fromName: 'Alice', text: 'earlier', timestamp: at(8, 0), outgoing: false },
      { id: 'g2', fromId: ALICE, fromName: 'Alice', text: 'are you there?', timestamp: at(9, 0, 30), outgoing: false }
    ]
  });
  await settle();
  assert.equal(historyOf(BeeState, sid).length, 2);

  // The message itself is delivered (it was kept while the account was
  // offline): the core names the row that was its stored copy.
  BeeState.addImMessage(sid, line('are you there?', { timestamp: at(9, 0, 30), offline: true, supersedes: 'g2' }), stranger, null);
  assert.deepEqual(textsOf(BeeState, sid), ['[2026-11-24 08:00] Alice: earlier', 'are you there?']);

  // The log's tail comes in late and the block is built again: the row stays out.
  transport.names.set(ALICE, { userName: 'alice.wonder' });
  transport.emit('names-updated');
  await settle();
  transport.of('tail')[0].resolve({ ok: true, lines: ['[2026-11-23 20:00] Alice: yesterday'] });
  await settle();
  assert.deepEqual(textsOf(BeeState, sid), [
    '[2026-11-23 20:00] Alice: yesterday',
    '[2026-11-24 08:00] Alice: earlier',
    'are you there?'
  ]);
  // The live message is the one that is logged, once, dated by when it was sent.
  transport.of('append')[0].resolve({ ok: true });
  await settle();
  assert.deepEqual(transport.of('append').map((c) => c.args.line), ['[2026-11-24 09:00] Alice: are you there?']);
});

test('an answer for a login that is over is nobody\'s', async () => {
  const { BeeState, transport } = boot();
  const sid = BeeState.ensureImSession(ALICE_KNOWN);
  BeeState.patch({ activeImSession: sid });
  await settle();
  const tail = transport.of('tail')[0];
  const history = transport.of('history')[0];

  // Logged out and in again as the same account: the conversation is a new one.
  BeeState.reset();
  BeeState.patch({ connected: true, agent: { id: ME, name: 'Me Resident', displayName: 'Me' }, activeTab: 'chat' });
  const again = BeeState.ensureImSession(ALICE_KNOWN);
  assert.equal(again, sid);
  tail.resolve({ ok: true, lines: ['[2026-11-24 09:00] Alice: stale'] });
  history.resolve({
    ok: true,
    rows: [{ id: 'g1', fromId: ALICE, fromName: 'Alice', text: 'stale', timestamp: at(9, 0), outgoing: false }]
  });
  await settle();
  assert.deepEqual(textsOf(BeeState, again), []);
  // The new conversation reads its own tail and may ask for its own history.
  assert.equal(transport.of('tail').length, 2);
  BeeState.patch({ activeImSession: again });
  assert.equal(transport.of('history').length, 2);
});
