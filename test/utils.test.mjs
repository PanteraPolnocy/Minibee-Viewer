// Tests for pure helpers in src/js/utils.js. Loaded like the other IIFE modules
// with minimal browser globals stubbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'js', 'utils.js'), 'utf8');
const stubDoc = { createElement: () => ({}) };
// eslint-disable-next-line no-new-func
const FSUtils = new Function('window', 'document', 'navigator', 'localStorage',
  src + '\n;return FSUtils;')({}, stubDoc, {}, {});

test('escapeHtml escapes the five HTML-significant characters', () => {
  assert.equal(FSUtils.escapeHtml('a<b>&"\''), 'a&lt;b&gt;&amp;&quot;&#39;');
});

test('escapeHtml neutralises an attribute-breakout payload', () => {
  const evil = '" onmouseover=alert(1) x="';
  const out = FSUtils.escapeHtml(evil);
  assert.ok(!out.includes('"'), 'double quotes must be encoded');
  assert.ok(out.includes('&quot;'));
});

test('escapeHtml handles null/undefined without throwing', () => {
  assert.equal(FSUtils.escapeHtml(null), '');
  assert.equal(FSUtils.escapeHtml(undefined), '');
});
