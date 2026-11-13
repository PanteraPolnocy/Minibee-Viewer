// The language files against the sources: every key the code, the markup
// and the core use is in src/lang/en.json, nothing in en.json is unused, the
// placeholders match the arguments the calls name, and every translation in
// src/lang/ covers en.json with the right plural forms and placeholders. The
// language menu in BeeI18n must list exactly the files that ship.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectUsage, validateEnglish, validateTranslation, translationFiles, readJson, EN_FILE } from '../scripts/sync-lang.mjs';
import { loadBeeModule } from './load-module.mjs';

const usage = collectUsage();
const english = fs.existsSync(EN_FILE) ? readJson(EN_FILE) : null;

test('the sources carry their UI lines in a form the collector accepts (keys only, no words)', () => {
  assert.deepEqual(usage.problems, []);
  assert.ok(usage.uses.size > 0, 'no keys collected at all');
});

test('src/lang/en.json covers every key the sources use, and nothing more', () => {
  assert.ok(english, 'src/lang/en.json is missing');
  assert.deepEqual(validateEnglish(english, usage.uses), []);
});

for (const { code, file } of translationFiles()) {
  test(`src/lang/${code}.json covers every key with matching placeholders`, () => {
    assert.deepEqual(validateTranslation(english || {}, readJson(file), code), []);
  });
}

test('the language menu lists exactly the files that ship', () => {
  const BeeI18n = loadBeeModule('js/i18n.ts', 'BeeI18n', {
    BeeUtils: { escapeHtml: (s) => String(s) },
    document: { documentElement: {}, querySelectorAll: () => [] },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) })
  });
  const menu = BeeI18n.languages().map(([code]) => code).sort();
  const shipped = ['en'].concat(translationFiles().map((f) => f.code)).sort();
  assert.deepEqual(menu, shipped);
});
