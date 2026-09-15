// Unit tests for the theme handling in src/js/settings.ts (BeeSettings): the
// three theme values, how 'system' follows the device preference, and what
// the top-bar toggle does from each of them. The module is loaded as an IIFE
// with stubbed browser globals, like the other frontend tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

// A fake `prefers-color-scheme: dark` query: `matches` is flipped by the test
// and `flip()` tells the listeners the module registered.
function makeMediaQuery(dark) {
  const listeners = [];
  return {
    matches: dark,
    addEventListener: (type, fn) => { if (type === 'change') listeners.push(fn); },
    flip(dark) {
      this.matches = dark;
      listeners.forEach((fn) => fn({ matches: dark }));
    },
    listenerCount: () => listeners.length
  };
}

function load(stored, mq) {
  const attrs = {};
  const saved = { value: null };
  const BeeSettings = loadBeeModule('js/settings.ts', 'BeeSettings', {
    window: { matchMedia: () => mq },
    document: {
      documentElement: { setAttribute: (name, value) => { attrs[name] = value; } },
      querySelector: () => null,
      getElementById: () => null
    },
    BeeUtils: {
      storageGet: () => stored,
      storageSet: (_key, value) => { saved.value = value; }
    },
    BeeState: { patch: () => {} }
  });
  BeeSettings.init();
  return { BeeSettings, attrs, saved };
}

test('the fixed themes paint exactly what they say', () => {
  const dark = load({ theme: 'dark' }, makeMediaQuery(false));
  assert.equal(dark.attrs['data-theme'], 'dark');
  assert.equal(dark.BeeSettings.effectiveTheme(), 'dark');
  const light = load({ theme: 'light' }, makeMediaQuery(true));
  assert.equal(light.attrs['data-theme'], 'light');
  assert.equal(light.BeeSettings.effectiveTheme(), 'light');
});

test('system follows the device preference', () => {
  const onDark = load({ theme: 'system' }, makeMediaQuery(true));
  assert.equal(onDark.BeeSettings.get('theme'), 'system', 'the stored choice stays "system"');
  assert.equal(onDark.attrs['data-theme'], 'dark');
  const onLight = load({ theme: 'system' }, makeMediaQuery(false));
  assert.equal(onLight.attrs['data-theme'], 'light');
});

test('system repaints when the device preference flips', () => {
  const mq = makeMediaQuery(true);
  const { BeeSettings, attrs } = load({ theme: 'system' }, mq);
  assert.equal(attrs['data-theme'], 'dark');
  mq.flip(false);
  assert.equal(attrs['data-theme'], 'light');
  mq.flip(true);
  assert.equal(attrs['data-theme'], 'dark');
  // Re-applying never stacks another listener.
  BeeSettings.set('theme', 'system');
  assert.equal(mq.listenerCount(), 1);
});

test('a device flip is ignored while the theme is fixed', () => {
  const mq = makeMediaQuery(true);
  const { BeeSettings, attrs } = load({ theme: 'system' }, mq);
  BeeSettings.set('theme', 'light');
  assert.equal(attrs['data-theme'], 'light');
  mq.flip(true);
  assert.equal(attrs['data-theme'], 'light', 'an explicit theme does not follow the device');
});

test('the toggle flips what is on screen, leaving system for an explicit theme', () => {
  const dark = load({ theme: 'system' }, makeMediaQuery(true));
  dark.BeeSettings.toggleTheme();
  assert.equal(dark.BeeSettings.get('theme'), 'light');
  assert.equal(dark.attrs['data-theme'], 'light');
  const light = load({ theme: 'system' }, makeMediaQuery(false));
  light.BeeSettings.toggleTheme();
  assert.equal(light.BeeSettings.get('theme'), 'dark');
  // ...and between the fixed themes it is a plain flip.
  light.BeeSettings.toggleTheme();
  assert.equal(light.BeeSettings.get('theme'), 'light');
});

test('an unknown stored theme falls back to the default', () => {
  const { BeeSettings, attrs } = load({ theme: 'purple' }, makeMediaQuery(false));
  assert.equal(BeeSettings.get('theme'), 'dark');
  assert.equal(attrs['data-theme'], 'dark');
  BeeSettings.set('theme', 'sepia');
  assert.equal(BeeSettings.get('theme'), 'dark');
});

test('without matchMedia, system means dark', () => {
  const attrs = {};
  const BeeSettings = loadBeeModule('js/settings.ts', 'BeeSettings', {
    window: {},
    document: {
      documentElement: { setAttribute: (name, value) => { attrs[name] = value; } },
      querySelector: () => null,
      getElementById: () => null
    },
    BeeUtils: { storageGet: () => ({ theme: 'system' }), storageSet: () => {} },
    BeeState: { patch: () => {} }
  });
  BeeSettings.init();
  assert.equal(attrs['data-theme'], 'dark');
});
