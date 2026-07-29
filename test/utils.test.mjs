// Tests for pure helpers in src/js/utils.ts. Loaded like the other IIFE modules
// with minimal browser globals stubbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

const BeeUtils = loadBeeModule('js/utils.ts', 'BeeUtils', {
  window: {},
  document: { createElement: () => ({}) },
  navigator: {},
  localStorage: {},
});

test('escapeHtml escapes the five HTML-significant characters', () => {
  assert.equal(BeeUtils.escapeHtml('a<b>&"\''), 'a&lt;b&gt;&amp;&quot;&#39;');
});

test('escapeHtml neutralises an attribute-breakout payload', () => {
  const evil = '" onmouseover=alert(1) x="';
  const out = BeeUtils.escapeHtml(evil);
  assert.ok(!out.includes('"'), 'double quotes must be encoded');
  assert.ok(out.includes('&quot;'));
});

test('escapeHtml handles null/undefined without throwing', () => {
  assert.equal(BeeUtils.escapeHtml(null), '');
  assert.equal(BeeUtils.escapeHtml(undefined), '');
});
