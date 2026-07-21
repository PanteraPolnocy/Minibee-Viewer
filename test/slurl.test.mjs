// Unit tests for the pure logic in src/js/protocol/sl-slurl.js.
//
// The frontend modules are browser IIFEs that assign a global (`const FSSlurl =
// (function(){...})()`), not ES modules. We load the source in a function scope
// with stubbed browser globals and return the resulting object, so the pure
// helpers (parse, scanLinks/linkify, coordinate math) can be tested under
// `node --test`. DOM-dependent helpers (bindLinks/openExternalUrl) are not
// exercised here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'js', 'protocol', 'sl-slurl.js'), 'utf8');

// eslint-disable-next-line no-new-func
const FSSlurl = new Function('window', 'document', src + '\n;return FSSlurl;')({}, undefined);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

test('parse: secondlife:// SLURL with coordinates', () => {
  const p = FSSlurl.parse('secondlife://Natoma/128/64/25');
  assert.equal(p.type, 'slurl');
  assert.equal(p.regionName, 'Natoma');
  assert.equal(p.x, 128);
  assert.equal(p.y, 64);
  assert.equal(p.z, 25);
});

test('parse: maps.secondlife.com URL', () => {
  const p = FSSlurl.parse('http://maps.secondlife.com/secondlife/Foo%20Bar/1/2/3');
  assert.equal(p.type, 'maps');
  assert.equal(p.regionName, 'Foo Bar');
  assert.equal(p.x, 1);
});

test('parse: bare region name', () => {
  const p = FSSlurl.parse('Da Boom');
  assert.equal(p.type, 'region');
  assert.equal(p.regionName, 'Da Boom');
});

test('parse: app agent SLURL is a profile link, not a region', () => {
  const p = FSSlurl.parse('secondlife:///app/agent/11223344-5566-7788-99aa-bbccddeeff00/about');
  assert.equal(p.type, 'app-agent');
  assert.equal(p.id, '11223344-5566-7788-99aa-bbccddeeff00');
});

test('parse: app group SLURL', () => {
  const p = FSSlurl.parse('secondlife:///app/group/11223344-5566-7788-99aa-bbccddeeff00/inspect');
  assert.equal(p.type, 'app-group');
  assert.equal(p.id, '11223344-5566-7788-99aa-bbccddeeff00');
});

test('scanLinks: bare http is untrusted', () => {
  const segs = FSSlurl.scanLinks('see http://www.example.org/page here');
  const link = segs.find((s) => s.type === 'link');
  assert.equal(link.kind, 'http');
  assert.equal(link.url, 'http://www.example.org/page');
  assert.equal(link.trusted, false);
});

test('scanLinks: secondlife.com is trusted', () => {
  const segs = FSSlurl.scanLinks('https://community.secondlife.com/blog');
  const link = segs.find((s) => s.type === 'link');
  assert.equal(link.trusted, true);
});

test('scanLinks: bracket label masks the URL', () => {
  const segs = FSSlurl.scanLinks('go [http://www.example.org/x  Click me] now');
  const link = segs.find((s) => s.type === 'link');
  assert.equal(link.url, 'http://www.example.org/x');
  assert.equal(link.label, 'Click me');
  assert.equal(link.bracketed, true);
});

test('scanLinks: unterminated bracket keeps [ as text but still links URL', () => {
  const segs = FSSlurl.scanLinks('[http://www.example.org/x');
  assert.equal(segs[0].type, 'text');
  assert.equal(segs[0].text, '[');
  assert.equal(segs[1].type, 'link');
  assert.equal(segs[1].url, 'http://www.example.org/x');
});

test('scanLinks: SLURL gets a friendly label and is trusted', () => {
  const segs = FSSlurl.scanLinks('tp to secondlife://Natoma/128/64/25 ok');
  const link = segs.find((s) => s.type === 'link');
  assert.equal(link.kind, 'slurl');
  assert.equal(link.trusted, true);
  assert.equal(link.label, 'Natoma (128, 64, 25)');
});

test('scanLinks: maps link classified as slurl, not bare http', () => {
  const segs = FSSlurl.scanLinks('http://maps.secondlife.com/secondlife/Natoma/1/2/3');
  const links = segs.filter((s) => s.type === 'link');
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'slurl');
});

test('scanLinks: trailing punctuation trimmed, balanced paren kept', () => {
  const a = FSSlurl.scanLinks('go http://example.com/p, ok').find((s) => s.type === 'link');
  assert.equal(a.url, 'http://example.com/p');
  const b = FSSlurl.scanLinks('wiki http://en.wikipedia.org/wiki/Foo_(bar) end').find((s) => s.type === 'link');
  assert.equal(b.url, 'http://en.wikipedia.org/wiki/Foo_(bar)');
});

test('scanLinks: email becomes mailto', () => {
  const link = FSSlurl.scanLinks('mail bob@example.com please').find((s) => s.type === 'link');
  assert.equal(link.kind, 'email');
  assert.equal(link.url, 'mailto:bob@example.com');
});

test('linkify: escapes text and emits anchors', () => {
  const html = FSSlurl.linkify('a <b> http://x.com/y', esc);
  assert.ok(html.includes('a &lt;b&gt; '), 'text escaped');
  assert.ok(html.includes('class="chat-link chat-link--external"'));
  assert.ok(html.includes('data-url="http://x.com/y"'));
  assert.ok(html.includes('data-trusted="0"'));
});

test('linkify: SLURL renders slurl-link', () => {
  const html = FSSlurl.linkify('secondlife://Natoma/1/2/3', esc);
  assert.ok(html.includes('class="slurl-link"'));
  assert.ok(html.includes('data-slurl="secondlife://Natoma/1/2/3"'));
});

test('coordinate: gridToRegionHandle <-> fromRegionHandle round-trip', () => {
  const handle = FSSlurl.gridToRegionHandle(1000, 1001);
  const back = FSSlurl.fromRegionHandle(handle);
  assert.equal(back.gridX, 1000);
  assert.equal(back.gridY, 1001);
});

test('coordinate: capCoordsToGrid treats small values as grid indices', () => {
  const g = FSSlurl.capCoordsToGrid(1000, 1001);
  assert.equal(g.gridX, 1000);
  assert.equal(g.gridY, 1001);
  assert.equal(g.globalX, 1000 * FSSlurl.REGION_WIDTH);
});

test('coordinate: globalToGrid snaps to region origin', () => {
  const g = FSSlurl.globalToGrid(256300, 256010);
  assert.equal(g.gridX, 1001);
  assert.equal(g.gridY, 1000);
  assert.equal(g.globalX, 1001 * 256);
});
