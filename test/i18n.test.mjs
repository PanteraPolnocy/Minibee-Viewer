// Tests for src/js/i18n.ts (BeeI18n): lookups through the chosen language
// and the English file, plural forms, placeholder escaping, the lines the
// core writes, and what load() does when a file is not there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const EN = {
  'chat.joined': '<strong>{name}</strong> joined',
  'common.cancel': 'Cancel',
  'friends.offered': '{name} offered a friendship card.',
  'im.members': { one: '{count} member', other: '{count} members' },
  'radar.count': { one: '{count} nearby', other: '{count} nearby' },
  'radar.empty': 'Nobody nearby',
  'err.noNotice': 'No notice'
};

const PL = {
  'chat.joined': '<strong>{name}</strong> dołącza',
  'common.cancel': 'Anuluj',
  'friends.offered': '{name} proponuje znajomość.',
  'radar.count': { one: '{count} osoba w pobliżu', few: '{count} osoby w pobliżu', many: '{count} osób w pobliżu', other: '{count} osoby w pobliżu' },
  'err.noNotice': 'Brak ogłoszenia'
};

// A BeeI18n with `fetch` answering from `files` (code -> dictionary object,
// or an Error to fail the fetch) and no DOM to speak of. The module starts
// on lang/en.json as soon as it loads.
function load(files = { en: EN }) {
  const html = { lang: 'en' };
  const fetched = [];
  const BeeI18n = loadBeeModule('js/i18n.ts', 'BeeI18n', {
    BeeUtils: { escapeHtml },
    document: { documentElement: html, querySelectorAll: () => [] },
    fetch: async (url) => {
      fetched.push(url);
      const code = /lang\/(\w+)\.json$/.exec(url)[1];
      const body = files[code];
      if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
      if (body instanceof Error) throw body;
      return { ok: true, status: 200, json: async () => body };
    }
  });
  return { BeeI18n, html, fetched };
}

test('English comes from lang/en.json, fetched once, and a key nobody defined shows itself', async () => {
  const { BeeI18n, fetched } = load();
  assert.equal(await BeeI18n.load('en'), 'en');
  await BeeI18n.load('en');
  assert.deepEqual(fetched, ['lang/en.json']);
  assert.equal(BeeI18n.lang(), 'en');
  assert.equal(BeeI18n.t('common.cancel'), 'Cancel');
  assert.equal(BeeI18n.t('friends.offered', { name: 'Ruth' }), 'Ruth offered a friendship card.');
  assert.equal(BeeI18n.t('nope.missing'), 'nope.missing');
  assert.equal(BeeI18n.has('common.cancel'), true);
  assert.equal(BeeI18n.has('nope.missing'), false);
  // a value nobody passed stays visible rather than vanishing
  assert.equal(BeeI18n.t('friends.offered', {}), '{name} offered a friendship card.');
  assert.equal(BeeI18n.t('friends.offered', { name: null }), ' offered a friendship card.');
});

test('English plural forms pick one/other', async () => {
  const { BeeI18n } = load();
  await BeeI18n.load('en');
  assert.equal(BeeI18n.t('im.members', { count: 1 }), '1 member');
  assert.equal(BeeI18n.t('im.members', { count: 0 }), '0 members');
  assert.equal(BeeI18n.t('im.members', { count: 5 }), '5 members');
  assert.equal(BeeI18n.t('im.members'), '{count} members');
});

test('a chosen language wins, Polish plurals use one/few/many, and a missing key reads in English', async () => {
  const { BeeI18n, html, fetched } = load({ en: EN, pl: PL });
  assert.equal(await BeeI18n.load('pl'), 'pl');
  assert.deepEqual(fetched, ['lang/en.json', 'lang/pl.json']);
  assert.equal(html.lang, 'pl');
  assert.equal(BeeI18n.t('common.cancel'), 'Anuluj');
  assert.equal(BeeI18n.t('radar.count', { count: 1 }), '1 osoba w pobliżu');
  assert.equal(BeeI18n.t('radar.count', { count: 3 }), '3 osoby w pobliżu');
  assert.equal(BeeI18n.t('radar.count', { count: 5 }), '5 osób w pobliżu');
  assert.equal(BeeI18n.t('radar.count', { count: 22 }), '22 osoby w pobliżu');
  assert.equal(BeeI18n.t('radar.empty'), 'Nobody nearby');
  assert.equal(BeeI18n.t('im.members', { count: 2 }), '2 members');
  assert.equal(BeeI18n.has('radar.empty'), true);
  // back to English without a reload
  assert.equal(await BeeI18n.load('en'), 'en');
  assert.equal(BeeI18n.t('common.cancel'), 'Cancel');
  assert.equal(html.lang, 'en');
});

test('html() escapes the values but not the template', async () => {
  const { BeeI18n } = load({ en: EN, pl: PL });
  await BeeI18n.load('en');
  assert.equal(BeeI18n.html('chat.joined', { name: '<b>Ruth & Co</b>' }),
    '<strong>&lt;b&gt;Ruth &amp; Co&lt;/b&gt;</strong> joined');
  await BeeI18n.load('pl');
  assert.equal(BeeI18n.html('chat.joined', { name: 'A"B' }), '<strong>A&quot;B</strong> dołącza');
  // t() leaves the value alone
  assert.equal(BeeI18n.t('chat.joined', { name: '<b>' }), '<strong><b></strong> dołącza');
});

test('lines from the core: field(), textOf() and fromCore() in both languages', async () => {
  const { BeeI18n } = load({ en: EN, pl: PL });
  await BeeI18n.load('en');
  const line = { text: 'Bob offered a friendship card.', textKey: 'friends.offered', textArgs: { name: 'Bob' } };
  const plain = { text: 'hello there' };
  const standalone = { key: 'err.noNotice', text: 'No notice', args: {} };
  const encoded = JSON.stringify(standalone);
  const unknownKey = { key: 'err.other', text: 'Something else', args: {} };

  assert.equal(BeeI18n.textOf(line), 'Bob offered a friendship card.');
  assert.equal(BeeI18n.textOf(plain), 'hello there');
  assert.equal(BeeI18n.field({ reason: 'gone' }, 'reason'), 'gone');
  assert.equal(BeeI18n.fromCore(standalone), 'No notice');
  assert.equal(BeeI18n.fromCore(encoded), 'No notice');
  assert.equal(BeeI18n.fromCore('{ not json'), '{ not json');
  assert.equal(BeeI18n.fromCore('plain words'), 'plain words');
  assert.equal(BeeI18n.fromCore(null), '');
  assert.equal(BeeI18n.fromCore({ text: 'only text' }), 'only text');
  // a key no file has: the core's own English text
  assert.equal(BeeI18n.fromCore(unknownKey), 'Something else');

  await BeeI18n.load('pl');
  assert.equal(BeeI18n.textOf(line), 'Bob proponuje znajomość.');
  assert.equal(BeeI18n.textOf(plain), 'hello there');
  assert.equal(BeeI18n.fromCore(standalone), 'Brak ogłoszenia');
  assert.equal(BeeI18n.fromCore(encoded), 'Brak ogłoszenia');
  assert.equal(BeeI18n.fromCore(unknownKey), 'Something else');
});

test('localize() renders a whole core payload in place: fields beside their keys, nested, and keyed objects in lists', async () => {
  const { BeeI18n } = load({ en: EN, pl: PL });
  await BeeI18n.load('pl');
  const payload = {
    kind: 'interactive-prompt',
    text: 'Bob offered a friendship card.', textKey: 'friends.offered', textArgs: { name: 'Bob' },
    fromName: 'Bob',
    prompt: { reason: 'No notice', reasonKey: 'err.noNotice', reasonArgs: {} },
    permission: { lines: [{ key: 'err.noNotice', text: 'No notice', args: {} }, 'plain'] },
    other: { text: 'from the grid' }
  };
  const same = BeeI18n.localize(payload);
  assert.equal(same, payload);
  assert.equal(payload.text, 'Bob proponuje znajomość.');
  assert.equal(payload.textKey, 'friends.offered'); // kept for a later re-render
  assert.equal(payload.fromName, 'Bob');
  assert.equal(payload.prompt.reason, 'Brak ogłoszenia');
  assert.equal(payload.permission.lines[0].text, 'Brak ogłoszenia');
  assert.equal(payload.permission.lines[1], 'plain');
  assert.equal(payload.other.text, 'from the grid');
  // anything that is not an object passes through
  assert.equal(BeeI18n.localize(null), null);
  assert.equal(BeeI18n.localize('x'), 'x');
  // a key no file has keeps the core's English
  const unknown = BeeI18n.localize({ note: 'English note', noteKey: 'search.nope', noteArgs: {} });
  assert.equal(unknown.note, 'English note');
});

test('en() is the English line whatever the language', async () => {
  const { BeeI18n } = load({ en: EN, pl: PL });
  await BeeI18n.load('pl');
  assert.equal(BeeI18n.t('common.cancel'), 'Anuluj');
  assert.equal(BeeI18n.en('common.cancel'), 'Cancel');
  assert.equal(BeeI18n.en('im.members', { count: 2 }), '2 members');
  assert.equal(BeeI18n.en('nope.missing'), 'nope.missing');
});

test('a language whose file is missing or broken falls back to English, and listeners hear every load', async () => {
  const { BeeI18n, html } = load({ en: EN, pl: new Error('offline') });
  const heard = [];
  const off = BeeI18n.onChange((code) => heard.push(code));
  assert.equal(await BeeI18n.load('pl'), 'en');
  assert.equal(await BeeI18n.load('xx'), 'en');
  assert.equal(html.lang, 'en');
  assert.equal(BeeI18n.t('common.cancel'), 'Cancel');
  assert.deepEqual(heard, ['en', 'en']);
  off();
  await BeeI18n.load('en');
  assert.deepEqual(heard, ['en', 'en']);
});

test('without lang/en.json the keys stand in for the words, and the next load tries again', async () => {
  const files = { en: new Error('gone') };
  const { BeeI18n, fetched } = load(files);
  assert.equal(await BeeI18n.load('en'), 'en');
  assert.equal(BeeI18n.t('common.cancel'), 'common.cancel');
  files.en = EN;
  await BeeI18n.load('en');
  assert.equal(BeeI18n.t('common.cancel'), 'Cancel');
  assert.ok(fetched.filter((u) => u === 'lang/en.json').length >= 2);
});

test('numbers follow the UI language; dates follow the device in English only', async () => {
  const { BeeI18n } = load({ en: EN, pl: PL });
  await BeeI18n.load('en');
  assert.equal(BeeI18n.formatNumber(1234567), '1,234,567');
  assert.equal(BeeI18n.dateLocale(), undefined);
  await BeeI18n.load('pl');
  assert.equal(BeeI18n.formatNumber(1234567).replace(/ /g, ' '), '1 234 567');
  assert.equal(BeeI18n.dateLocale(), 'pl-PL');
  assert.equal(BeeI18n.formatNumber('nope'), 'nope');
});

test('the language menu starts with English and names each language in itself', () => {
  const { BeeI18n } = load();
  const langs = BeeI18n.languages();
  assert.equal(langs[0][0], 'en');
  assert.equal(langs[0][1], 'English');
  assert.ok(langs.some(([code, name]) => code === 'pl' && name === 'Polski'));
  // a copy, not the module's own table
  langs.push(['xx', 'Nope']);
  assert.equal(BeeI18n.languages().length, langs.length - 1);
});
