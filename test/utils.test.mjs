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

// --- shouldPreserveDraft ---------------------------------------------------
//
// Guards the profile notes field across the pane rebuilds that every async
// profile reply triggers. Both conditions here have shipped broken once:
// preserving across a subject change filed one resident's notes against
// another, and inferring "edited" by diffing against the incoming value made a
// still-loading empty field look like a draft, which blanked the notes the
// instant they arrived.

test('shouldPreserveDraft: keeps a typed draft for the same subject', () => {
  assert.equal(BeeUtils.shouldPreserveDraft('abc', 'abc', '1'), true);
  assert.equal(BeeUtils.shouldPreserveDraft('abc', 'abc', true), true);
});

test('shouldPreserveDraft: an untouched field is not a draft', () => {
  // the regression: notes arriving into a field nobody typed in must win
  assert.equal(BeeUtils.shouldPreserveDraft('abc', 'abc', undefined), false);
  assert.equal(BeeUtils.shouldPreserveDraft('abc', 'abc', ''), false);
  assert.equal(BeeUtils.shouldPreserveDraft('abc', 'abc', '0'), false);
  assert.equal(BeeUtils.shouldPreserveDraft('abc', 'abc', false), false);
});

test('shouldPreserveDraft: never carries a draft to another subject', () => {
  assert.equal(BeeUtils.shouldPreserveDraft('abc', 'xyz', '1'), false);
  assert.equal(BeeUtils.shouldPreserveDraft('abc', '', '1'), false);
  assert.equal(BeeUtils.shouldPreserveDraft('abc', null, '1'), false);
  assert.equal(BeeUtils.shouldPreserveDraft('abc', undefined, '1'), false);
});

test('shouldPreserveDraft: an unidentified field is never a draft', () => {
  // two blank ids must not compare equal and let text leak between residents
  assert.equal(BeeUtils.shouldPreserveDraft('', '', '1'), false);
  assert.equal(BeeUtils.shouldPreserveDraft(null, null, '1'), false);
  assert.equal(BeeUtils.shouldPreserveDraft(undefined, undefined, '1'), false);
});
