// The chat log reader: BeeLogReader in src/js/ui/log-reader.ts.
//
// Which lines make a page, and which of them hold the words searched for, is
// the core's answer (chat_log_read, tested in chatlogs.rs). What these tests
// hold is the module's side of it: what it asks the core for as a log is
// opened, paged, searched and a result opened in its place; that an answer
// arriving late is not painted over a newer one; what deleting does; and how
// a line is cut into the pieces it is painted from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

const ME = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = '11111111-2222-3333-4444-555555555555';
const LIST = [
  { agent: ME, kind: 'avatars', name: 'alice.wonder', bytes: 2048 },
  { agent: ME, kind: 'avatars', name: 'bob.builder', bytes: 4096 },
  { agent: ME, kind: 'groups', name: 'Bee Lovers', bytes: 3 * 1024 * 1024 },
  { agent: ME, kind: 'local', name: 'Nearby Chat', bytes: 512 }
];

// Just enough of a document for the module to build its list and its page in.
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this.own = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.title = '';
    this.open = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.offsetHeight = 0;
    const node = this;
    const names = () => node.className.split(/\s+/).filter(Boolean);
    this.classList = {
      contains: (name) => names().includes(name),
      add: (name) => { if (!names().includes(name)) node.className = names().concat(name).join(' '); },
      toggle: (name, on) => {
        const want = on === undefined ? !names().includes(name) : !!on;
        node.className = names().filter((c) => c !== name).concat(want ? [name] : []).join(' ');
      }
    };
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this.own;
  }
  set textContent(value) { this.children = []; this.own = String(value); }
  set innerHTML(_value) { this.children = []; this.own = ''; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0 }; }
  showModal() { this.open = true; }
  fire(type, event) {
    (this.listeners[type] || []).forEach((fn) => fn(Object.assign({ preventDefault() {} }, event)));
  }
  click() { this.fire('click'); }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  // Two shapes of selector are all the module uses: a class, and a line by its place.
  querySelectorAll(selector) {
    const line = /^\[data-line="(\d+)"\]$/.exec(selector);
    return this.descendants().filter((n) => (line
      ? n.dataset.line === line[1]
      : n.classList.contains(selector.replace(/^\./, ''))));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function boot(options = {}) {
  const elements = {};
  const byId = (id) => {
    if (!elements[id]) elements[id] = new FakeNode('div');
    return elements[id];
  };
  // The core, answering when the test says so.
  const asked = [];
  const confirms = [];
  const toasts = [];
  const stubs = {
    document: {
      getElementById: byId,
      createElement: (tag) => new FakeNode(tag),
      createElementNS: (_ns, tag) => new FakeNode(tag),
      createTextNode: (text) => {
        const node = new FakeNode('');
        node.own = String(text);
        return node;
      }
    },
    BeeBridge: {
      invoke(cmd, args) {
        return new Promise((resolve, reject) => { asked.push({ cmd, args, resolve, reject, done: false }); });
      }
    },
    BeeUtils: {
      confirm: (o) => { confirms.push(o); return Promise.resolve(options.confirm !== false); },
      showToast: (text, kind) => { toasts.push({ text, kind }); },
      errText: (err) => (typeof err === 'string' ? err : (err && err.message) || ''),
      isUuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '')),
      // No waiting in a test: a search goes out as it is typed.
      debounce: (fn) => fn,
      dismissDialog: (d) => { d.open = false; }
    },
    BeeState: { get: () => ({ agent: { id: ME } }), gridOnline: () => false },
    BeeTransport: { on() {}, getCachedNameInfo: () => null, getGroupName: () => '' }
  };
  const BeeLogReader = loadBeeModule('js/ui/log-reader.ts', 'BeeLogReader', stubs);
  BeeLogReader.init();
  // Answers the oldest request of that kind still waiting, and lets the
  // module act on it.
  const settle = async (cmd, how, value) => {
    const request = asked.find((a) => a.cmd === cmd && !a.done);
    assert.ok(request, `the core was asked for ${cmd}`);
    request.done = true;
    request[how](value);
    await flush();
    return request;
  };
  return {
    BeeLogReader, byId, asked, confirms, toasts,
    answer: (cmd, value) => settle(cmd, 'resolve', value),
    refuse: (cmd, error) => settle(cmd, 'reject', error),
    waiting: (cmd) => asked.filter((a) => a.cmd === cmd && !a.done)
  };
}

// The dialog open with its list in.
async function opened(logs = LIST, options = {}) {
  const app = boot(options);
  app.BeeLogReader.open();
  await app.answer('chat_log_list', { ok: true, logs: logs.map((row) => Object.assign({}, row)) });
  return app;
}

// A page as the core sends it: lines `from`..`to` of a log of `total` lines.
function pageOf(from, to, page, pages, total) {
  const lines = [];
  for (let n = from; n <= to; n++) lines.push({ n, text: `[2026-09-01 12:00] Some One: line ${n}` });
  return { ok: true, lines, page, pages, matched: total, total };
}

function fileButton(app, name) {
  const found = app.byId('log-reader-files').querySelectorAll('.log-reader__open')
    .find((btn) => btn.dataset.name === name);
  assert.ok(found, `${name} is in the list`);
  return found;
}

const texts = (nodes) => nodes.map((n) => n.textContent);
const readArgs = (name, extra) => Object.assign(
  { agent: ME, kind: 'avatars', name, query: null, page: null, around: null }, extra);

test('the list is laid out by kind, each file with its size', async () => {
  const app = await opened();
  const files = app.byId('log-reader-files');
  assert.deepEqual(texts(files.querySelectorAll('.log-reader__kind-name')),
    ['Nearby chat (1)', 'IM logs (people) (2)', 'Group and conference logs (1)']);
  // The nearby-chat file reads as its section does, whatever it is called on disk.
  assert.deepEqual(texts(files.querySelectorAll('.log-reader__file-name')),
    ['Nearby chat', 'alice.wonder', 'bob.builder', 'Bee Lovers']);
  assert.deepEqual(texts(files.querySelectorAll('.log-reader__file-size')),
    ['1 KB', '2 KB', '4 KB', '3.0 MB']);
  // One account: no account headings. Nothing is open yet.
  assert.equal(files.querySelectorAll('.log-reader__account').length, 0);
  assert.equal(app.byId('log-reader-head').hidden, true);
  assert.equal(app.byId('log-reader-empty').hidden, false);
  assert.equal(app.byId('log-reader-dialog').open, true);
});

test('accounts get a heading each: this one first, the shared leftovers last', async () => {
  const app = await opened([
    { agent: '', kind: 'avatars', name: 'old.friend', bytes: 100 },
    { agent: OTHER, kind: 'avatars', name: 'carol.c', bytes: 100 },
    { agent: ME, kind: 'avatars', name: 'alice.wonder', bytes: 100 }
  ]);
  const files = app.byId('log-reader-files');
  assert.deepEqual(texts(files.querySelectorAll('.log-reader__account')),
    ['This account', OTHER, 'Older shared logs']);
  assert.deepEqual(texts(files.querySelectorAll('.log-reader__file-name')),
    ['alice.wonder', 'carol.c', 'old.friend']);
});

test('a log opens on its newest page and is paged from there', async () => {
  const app = await opened();
  const lines = app.byId('log-reader-lines');
  lines.scrollHeight = 900;
  fileButton(app, 'alice.wonder').click();
  const first = await app.answer('chat_log_read', pageOf(41, 60, 3, 3, 60));
  // No page asked for: the core answers with the newest.
  assert.deepEqual(first.args, readArgs('alice.wonder'));
  assert.equal(lines.children.length, 20);
  assert.equal(lines.children[0].tagName, 'DIV');
  assert.equal(lines.children[0].textContent, '[2026-09-01 12:00] Some One: line 41');
  assert.equal(lines.scrollTop, 900, 'the newest lines are at the bottom, and that is where it opens');
  assert.equal(app.byId('log-reader-name').textContent, 'alice.wonder');
  assert.equal(app.byId('log-reader-state').textContent, 'IM logs (people) \u00b7 2 KB');
  assert.equal(app.byId('log-reader-page').textContent, 'Page 3 of 3');
  assert.equal(app.byId('log-reader-pager').hidden, false);
  assert.equal(app.byId('log-reader-head').hidden, false);
  assert.equal(app.byId('log-reader-empty').hidden, true);
  assert.ok(fileButton(app, 'alice.wonder').classList.contains('scripts-list__item--open'));
  // On the newest page there is nowhere newer to go.
  assert.equal(app.byId('log-reader-next').disabled, true);
  assert.equal(app.byId('log-reader-last').disabled, true);
  assert.equal(app.byId('log-reader-prev').disabled, false);
  assert.equal(app.byId('log-reader-first').disabled, false);

  // Older: the page before, opened at its end - the lines just before these.
  app.byId('log-reader-prev').click();
  const older = await app.answer('chat_log_read', pageOf(21, 40, 2, 3, 60));
  assert.deepEqual(older.args, readArgs('alice.wonder', { page: 2 }));
  assert.equal(lines.scrollTop, 900);
  assert.equal(app.byId('log-reader-page').textContent, 'Page 2 of 3');
  // Newer: the page after, from its start.
  app.byId('log-reader-next').click();
  const newer = await app.answer('chat_log_read', pageOf(41, 60, 3, 3, 60));
  assert.deepEqual(newer.args, readArgs('alice.wonder', { page: 3 }));
  assert.equal(lines.scrollTop, 0);
  // Oldest is page 1; newest asks for no page at all, so lines written since count.
  app.byId('log-reader-first').click();
  const oldest = await app.answer('chat_log_read', pageOf(1, 20, 1, 3, 60));
  assert.deepEqual(oldest.args, readArgs('alice.wonder', { page: 1 }));
  assert.equal(app.byId('log-reader-prev').disabled, true);
  app.byId('log-reader-last').click();
  const newest = await app.answer('chat_log_read', pageOf(42, 61, 3, 3, 61));
  assert.deepEqual(newest.args, readArgs('alice.wonder'));
});

test('a log that fits one page shows no pager', async () => {
  const app = await opened();
  fileButton(app, 'bob.builder').click();
  await app.answer('chat_log_read', pageOf(1, 5, 1, 1, 5));
  assert.equal(app.byId('log-reader-pager').hidden, true);
  assert.equal(app.byId('log-reader-lines').children.length, 5);
});

test('a search lists the lines found, and one of them opens the log at its place', async () => {
  const app = await opened();
  const lines = app.byId('log-reader-lines');
  const search = app.byId('log-reader-search');
  fileButton(app, 'alice.wonder').click();
  await app.answer('chat_log_read', pageOf(41, 60, 3, 3, 60));

  search.value = '  Honey ';
  search.fire('input');
  const hits = await app.answer('chat_log_read', {
    ok: true,
    lines: [
      { n: 7, text: '[2026-09-01 12:00] Some One: honey' },
      { n: 31, text: '[2026-09-02 08:15] Me: a HONEY jar' }
    ],
    page: 1, pages: 1, matched: 2, total: 60
  });
  assert.deepEqual(hits.args, readArgs('alice.wonder', { query: 'Honey' }));
  // The lines found are buttons, with what matched marked in each.
  assert.deepEqual(lines.children.map((n) => n.tagName), ['BUTTON', 'BUTTON']);
  assert.deepEqual(texts(lines.querySelectorAll('.log-reader__mark')), ['honey', 'HONEY']);
  assert.equal(lines.children[1].textContent, '[2026-09-02 08:15] Me: a HONEY jar');
  assert.equal(app.byId('log-reader-state').textContent, '2 results');

  // The same words again ask nothing new.
  search.fire('input');
  assert.equal(app.waiting('chat_log_read').length, 0);

  // One of them, opened: the search is put away and the log shows that line's page.
  lines.children[1].click();
  const there = await app.answer('chat_log_read', pageOf(21, 40, 2, 3, 60));
  assert.deepEqual(there.args, readArgs('alice.wonder', { around: 31 }));
  assert.equal(search.value, '');
  assert.equal(lines.children[0].tagName, 'DIV');
  assert.equal(lines.querySelectorAll('.log-reader__mark').length, 0);
  assert.deepEqual(lines.querySelectorAll('.log-reader__line--found').map((n) => n.dataset.line), ['31']);
  assert.equal(app.byId('log-reader-page').textContent, 'Page 2 of 3');

  // Nothing found says so, in the words searched for.
  search.value = 'propolis';
  search.fire('keydown', { key: 'Enter' });
  await app.answer('chat_log_read', { ok: true, lines: [], page: 0, pages: 0, matched: 0, total: 60 });
  assert.equal(lines.textContent, 'Nothing here matches "propolis".');
  assert.equal(app.byId('log-reader-state').textContent, '0 results');
  assert.equal(app.byId('log-reader-pager').hidden, true);
});

test('an answer that comes late is not painted over a newer one', async () => {
  const app = await opened();
  const lines = app.byId('log-reader-lines');
  fileButton(app, 'alice.wonder').click();
  fileButton(app, 'bob.builder').click();
  const [forAlice, forBob] = app.waiting('chat_log_read');
  assert.equal(forAlice.args.name, 'alice.wonder');
  assert.equal(forBob.args.name, 'bob.builder');
  forBob.resolve({ ok: true, lines: [{ n: 1, text: 'bob speaking' }], page: 1, pages: 1, matched: 1, total: 1 });
  await flush();
  forAlice.resolve({ ok: true, lines: [{ n: 1, text: 'alice speaking' }], page: 1, pages: 1, matched: 1, total: 1 });
  await flush();
  assert.equal(lines.textContent, 'bob speaking');
  assert.equal(app.byId('log-reader-name').textContent, 'bob.builder');
});

test('a read that fails says why, and an empty log says so', async () => {
  const app = await opened();
  const lines = app.byId('log-reader-lines');
  fileButton(app, 'alice.wonder').click();
  await app.refuse('chat_log_read', 'Could not read the log file: denied');
  assert.equal(lines.textContent, 'Could not read the log file: denied');
  assert.equal(app.byId('log-reader-pager').hidden, true);
  fileButton(app, 'bob.builder').click();
  await app.answer('chat_log_read', { ok: true, lines: [], page: 0, pages: 0, matched: 0, total: 0 });
  assert.equal(lines.textContent, 'This log is empty.');
});

test('a list that cannot be read says so', async () => {
  const app = boot();
  app.BeeLogReader.open();
  assert.equal(app.byId('log-reader-status').textContent, 'Loading...');
  await app.refuse('chat_log_list', 'no data directory');
  assert.equal(app.byId('log-reader-status').textContent, 'The log list is unavailable.');
  assert.equal(app.byId('log-reader-status').hidden, false);
});

test('the filter narrows the list, and a narrowed kind cannot be deleted whole', async () => {
  const app = await opened();
  const files = app.byId('log-reader-files');
  const filter = app.byId('log-reader-filter');
  const status = app.byId('log-reader-status');
  // One "Delete all" per kind while every file is on screen.
  assert.equal(files.querySelectorAll('.btn').length, 3);
  filter.value = 'ALICE';
  filter.fire('input');
  assert.deepEqual(texts(files.querySelectorAll('.log-reader__file-name')), ['alice.wonder']);
  assert.deepEqual(texts(files.querySelectorAll('.log-reader__kind-name')), ['IM logs (people) (1)']);
  assert.equal(files.querySelectorAll('.btn').length, 0);
  assert.equal(status.hidden, true);
  filter.value = 'zzz';
  filter.fire('input');
  assert.equal(files.children.length, 0);
  assert.equal(status.textContent, 'Nothing here matches "zzz".');
  filter.value = '';
  filter.fire('input');
  assert.equal(files.querySelectorAll('.log-reader__open').length, 4);
  assert.equal(files.querySelectorAll('.btn').length, 3);
});

test('deleting the open log asks first, then closes it and tells who is listening', async () => {
  const app = await opened();
  let told = 0;
  app.BeeLogReader.onDeleted(() => { told += 1; });
  fileButton(app, 'alice.wonder').click();
  await app.answer('chat_log_read', pageOf(1, 5, 1, 1, 5));
  app.byId('log-reader-delete').click();
  await flush();
  assert.equal(app.confirms.length, 1);
  assert.equal(app.confirms[0].message,
    'Delete the log for "alice.wonder"? The text files are removed from this device permanently.');
  const gone = await app.answer('chat_log_delete', { ok: true, deleted: 1 });
  assert.deepEqual(gone.args, { agent: ME, kind: 'avatars', name: 'alice.wonder' });
  assert.equal(told, 0, 'not before the list is read again');
  await app.answer('chat_log_list', { ok: true, logs: LIST.filter((row) => row.name !== 'alice.wonder') });
  assert.equal(told, 1);
  assert.deepEqual(app.toasts, [{ text: 'Deleted.', kind: 'success' }]);
  assert.equal(app.byId('log-reader-head').hidden, true);
  assert.equal(app.byId('log-reader-empty').hidden, false);
  assert.equal(app.byId('log-reader-files').querySelectorAll('.log-reader__open').length, 3);

  // A file's own button deletes that file; a kind's button the whole kind.
  app.byId('log-reader-files').querySelectorAll('.log-reader__file-delete')[1].click();
  await flush();
  const one = await app.answer('chat_log_delete', { ok: true, deleted: 1 });
  assert.deepEqual(one.args, { agent: ME, kind: 'avatars', name: 'bob.builder' });
  await app.answer('chat_log_list', { ok: true, logs: LIST.filter((row) => row.kind !== 'avatars') });
  app.byId('log-reader-files').querySelectorAll('.btn')[1].click();
  await flush();
  assert.equal(app.confirms[2].message,
    'Delete ALL "Group and conference logs" files in this section? The text files are removed from this device permanently.');
  const kind = await app.answer('chat_log_delete', { ok: true, deleted: 1 });
  assert.deepEqual(kind.args, { agent: ME, kind: 'groups', name: null });
});

test('a delete that is not confirmed asks the core for nothing', async () => {
  const app = await opened(LIST, { confirm: false });
  app.byId('log-reader-files').querySelectorAll('.log-reader__file-delete')[0].click();
  await flush();
  assert.equal(app.confirms.length, 1);
  assert.equal(app.waiting('chat_log_delete').length, 0);
  assert.equal(app.waiting('chat_log_list').length, 0);
});

test('sizes read in kilobytes up to a megabyte', () => {
  const { BeeLogReader } = boot();
  assert.equal(BeeLogReader.formatSize(0), '1 KB');
  assert.equal(BeeLogReader.formatSize(1536), '2 KB');
  assert.equal(BeeLogReader.formatSize(1024 * 1024), '1.0 MB');
  assert.equal(BeeLogReader.formatSize(5.25 * 1024 * 1024), '5.3 MB');
});

// --- a line cut into pieces ---

const { BeeLogReader } = boot();
const cut = (text, needle) => BeeLogReader.pieces(text, needle)
  .map((p) => (p.stamp ? 'S' : '-') + (p.hit ? 'H' : '-') + ':' + p.text);
const whole = (text, needle) => BeeLogReader.pieces(text, needle).map((p) => p.text).join('');

test('the date and time a line starts with stand apart from what was said', () => {
  assert.deepEqual(cut('[2026-09-01 12:00] Some One: hi', ''),
    ['S-:[2026-09-01 12:00]', '--: Some One: hi']);
  // Only at the very start, and only a short bracket, is it a stamp.
  assert.deepEqual(cut('Some One: see [the notes] later', ''), ['--:Some One: see [the notes] later']);
  const long = '[' + 'x'.repeat(60) + '] hi';
  assert.deepEqual(cut(long, ''), ['--:' + long]);
});

test('what matches the search is marked, whatever its case, and nothing is lost', () => {
  assert.deepEqual(cut('[t] Honey and honey', 'HONEY'),
    ['S-:[t]', '--: ', '-H:Honey', '--: and ', '-H:honey']);
  // A match that runs across the end of the stamp is marked on both sides of it.
  assert.deepEqual(cut('[12:00] alice: hi', '] ali'),
    ['S-:[12:00', 'SH:]', '-H: ali', '--:ce: hi']);
  // A search inside the stamp - for a date, say - is marked there.
  assert.deepEqual(cut('[2026-09-01 12:00] hi', '09-01'),
    ['S-:[2026-', 'SH:09-01', 'S-: 12:00]', '--: hi']);
  // Matches side by side are one stretch, not one mark a letter.
  assert.deepEqual(cut('aaaa!', 'a'), ['-H:aaaa', '--:!']);
  assert.equal(whole('[t] Honey and honey', 'HONEY'), '[t] Honey and honey');
});

test('a line is not marked without end, nor in the wrong place', () => {
  const many = 'ab'.repeat(100);
  const marked = BeeLogReader.pieces(many, 'a').filter((p) => p.hit);
  assert.equal(marked.length, 40);
  assert.equal(whole(many, 'a'), many);
  // Lowercasing this capital makes the text longer, so positions found in the
  // lowercase form would land a letter off: the line is shown unmarked.
  const dotted = '\u0130stanbul calling';
  assert.notEqual(dotted.toLowerCase().length, dotted.length);
  assert.deepEqual(cut(dotted, 'calling'), ['--:' + dotted]);
});
