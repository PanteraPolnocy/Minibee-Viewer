// The quiet count pill (group chats) has to read in both themes: it is the
// theme's deep surface with accent digits and a thin ring, so its colours are
// tokens of their own in src/app.css. This checks the tokens the way a
// browser resolves them, against the WCAG contrast floors: 4.5:1 for the
// digits on the pill, 3:1 for the ring against every surface a pill sits on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app.css'), 'utf8');

// The custom properties a selector's block declares, e.g. '[data-theme="light"]'.
function tokens(selector) {
  const at = CSS.indexOf(selector + ' {');
  assert.ok(at !== -1, 'theme block ' + selector);
  const body = CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
  const out = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

// A token's value with var() references followed, as [r, g, b, alpha].
function colour(theme, name, depth = 0) {
  assert.ok(depth < 5 && theme[name], 'token ' + name);
  const value = theme[name];
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (ref) return colour(theme, ref[1], depth + 1);
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  assert.ok(rgba, name + ' is a colour: ' + value);
  const parts = rgba[1].split(',').map((p) => Number(p.trim()));
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

function over(fg, bg) {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1);
}

function luminance(c) {
  const [r, g, b] = c.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const THEMES = { dark: tokens('[data-theme="dark"]'), light: tokens('[data-theme="light"]') };
// Where a quiet pill is drawn: the menu, a conversation row, the active sub-tab.
const SURFACES = ['--bg-deep', '--bg-surface', '--surface-2'];

for (const [name, theme] of Object.entries(THEMES)) {
  test(`the quiet pill reads in the ${name} theme`, () => {
    const fill = colour(theme, '--pill-quiet-bg');
    assert.equal(fill[3], 1, 'the pill is opaque: its digits never sit on whatever is behind it');
    const digits = over(colour(theme, '--pill-quiet-fg'), fill);
    assert.ok(contrast(digits, fill) >= 4.5,
      `digits on the pill: ${contrast(digits, fill).toFixed(2)}:1`);
    for (const surface of SURFACES) {
      const bg = colour(theme, surface);
      const ring = over(colour(theme, '--pill-quiet-ring'), bg);
      assert.ok(contrast(ring, bg) >= 3,
        `ring against ${surface}: ${contrast(ring, bg).toFixed(2)}:1`);
    }
    // Quieter than the loud pill: it is never the solid accent.
    assert.notDeepEqual(fill, colour(theme, '--accent'));
  });
}

test('the quiet pill is what group counts wear, everywhere they show', () => {
  const rule = /([^{}]+)\{[^{}]*background:\s*var\(--pill-quiet-bg\)[^{}]*\}/.exec(CSS);
  assert.ok(rule, 'one rule paints the quiet pill');
  const selectors = rule[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim());
  assert.deepEqual(selectors.sort(), [
    '.im-session__unread.im-session__unread--quiet',
    '.im-subtab[data-im-sub="sessions"] .im-subtab__badge',
    '.nav-badge.nav-badge--quiet'
  ]);
  assert.match(rule[0], /color:\s*var\(--pill-quiet-fg\)/);
  assert.match(rule[0], /var\(--pill-quiet-ring\)/);
  // The markup carries the menu's second pill and the Groups tab its badge.
  const html = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.html'), 'utf8');
  assert.match(html, /id="badge-im-groups" class="nav-badge nav-badge--quiet"/);
  assert.match(html, /data-im-sub="sessions"[^>]*>.*im-subtab__badge/);
});
