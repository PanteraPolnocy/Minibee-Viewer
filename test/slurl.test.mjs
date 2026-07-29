// Unit tests for the pure logic in src/js/protocol/sl-slurl.js.
//
// The frontend modules are browser IIFEs that assign a global (`const BeeSlurl =
// (function(){...})()`), not ES modules. We load the source in a function scope
// with stubbed browser globals and return the resulting object, so the pure
// helpers (parse, scanLinks/linkify, coordinate math) can be tested under
// `node --test`. DOM-dependent helpers (bindLinks/openExternalUrl) are not
// exercised here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

// Just enough of a document for appendLinkified: element/text nodes that record
// their tag, attributes and children. Nothing here renders - the assertions walk
// the node tree directly.
function fakeDocument() {
  const mkText = (data) => ({ nodeName: '#text', textContent: String(data) });
  const mkEl = (tag) => ({
    nodeName: tag.toUpperCase(),
    className: '',
    attrs: {},
    childNodes: [],
    set textContent(v) { this.childNodes = [mkText(v)]; },
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { this.childNodes.push(c); return c; },
  });
  return { createElement: mkEl, createTextNode: mkText };
}

const BeeSlurl = loadBeeModule('js/core/sl-slurl.ts', 'BeeSlurl', {
  window: {},
  document: fakeDocument(),
});

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

test('parse: secondlife:// SLURL with coordinates', () => {
  const p = BeeSlurl.parse('secondlife://Natoma/128/64/25');
  assert.equal(p.type, 'slurl');
  assert.equal(p.regionName, 'Natoma');
  assert.equal(p.x, 128);
  assert.equal(p.y, 64);
  assert.equal(p.z, 25);
});

test('parse: maps.secondlife.com URL', () => {
  const p = BeeSlurl.parse('http://maps.secondlife.com/secondlife/Foo%20Bar/1/2/3');
  assert.equal(p.type, 'maps');
  assert.equal(p.regionName, 'Foo Bar');
  assert.equal(p.x, 1);
});

test('parse: bare region name', () => {
  const p = BeeSlurl.parse('Da Boom');
  assert.equal(p.type, 'region');
  assert.equal(p.regionName, 'Da Boom');
});

test('parse: app agent SLURL is a profile link, not a region', () => {
  const p = BeeSlurl.parse('secondlife:///app/agent/11223344-5566-7788-99aa-bbccddeeff00/about');
  assert.equal(p.type, 'app-agent');
  assert.equal(p.id, '11223344-5566-7788-99aa-bbccddeeff00');
});

test('parse: app group SLURL', () => {
  const p = BeeSlurl.parse('secondlife:///app/group/11223344-5566-7788-99aa-bbccddeeff00/inspect');
  assert.equal(p.type, 'app-group');
  assert.equal(p.id, '11223344-5566-7788-99aa-bbccddeeff00');
});

test('scanLinks: bare http is untrusted', () => {
  const segs = BeeSlurl.scanLinks('see http://www.example.org/page here');
  const link = segs.find((s) => s.type === 'link');
  assert.equal(link.kind, 'http');
  assert.equal(link.url, 'http://www.example.org/page');
  assert.equal(link.trusted, false);
});

test('scanLinks: secondlife.com is trusted', () => {
  const segs = BeeSlurl.scanLinks('https://community.secondlife.com/blog');
  const link = segs.find((s) => s.type === 'link');
  assert.equal(link.trusted, true);
});

test('scanLinks: bracket label masks the URL', () => {
  const segs = BeeSlurl.scanLinks('go [http://www.example.org/x  Click me] now');
  const link = segs.find((s) => s.type === 'link');
  assert.equal(link.url, 'http://www.example.org/x');
  assert.equal(link.label, 'Click me');
  assert.equal(link.bracketed, true);
});

test('scanLinks: unterminated bracket keeps [ as text but still links URL', () => {
  const segs = BeeSlurl.scanLinks('[http://www.example.org/x');
  assert.equal(segs[0].type, 'text');
  assert.equal(segs[0].text, '[');
  assert.equal(segs[1].type, 'link');
  assert.equal(segs[1].url, 'http://www.example.org/x');
});

test('scanLinks: SLURL gets a friendly label and is trusted', () => {
  const segs = BeeSlurl.scanLinks('tp to secondlife://Natoma/128/64/25 ok');
  const link = segs.find((s) => s.type === 'link');
  assert.equal(link.kind, 'slurl');
  assert.equal(link.trusted, true);
  assert.equal(link.label, 'Natoma (128, 64, 25)');
});

test('scanLinks: maps link classified as slurl, not bare http', () => {
  const segs = BeeSlurl.scanLinks('http://maps.secondlife.com/secondlife/Natoma/1/2/3');
  const links = segs.filter((s) => s.type === 'link');
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'slurl');
});

test('scanLinks: trailing punctuation trimmed, balanced paren kept', () => {
  const a = BeeSlurl.scanLinks('go http://example.com/p, ok').find((s) => s.type === 'link');
  assert.equal(a.url, 'http://example.com/p');
  const b = BeeSlurl.scanLinks('wiki http://en.wikipedia.org/wiki/Foo_(bar) end').find((s) => s.type === 'link');
  assert.equal(b.url, 'http://en.wikipedia.org/wiki/Foo_(bar)');
});

test('scanLinks: email becomes mailto', () => {
  const link = BeeSlurl.scanLinks('mail bob@example.com please').find((s) => s.type === 'link');
  assert.equal(link.kind, 'email');
  assert.equal(link.url, 'mailto:bob@example.com');
});

test('linkify: escapes text and emits anchors', () => {
  const html = BeeSlurl.linkify('a <b> http://x.com/y', esc);
  assert.ok(html.includes('a &lt;b&gt; '), 'text escaped');
  assert.ok(html.includes('class="chat-link chat-link--external"'));
  assert.ok(html.includes('data-url="http://x.com/y"'));
  assert.ok(html.includes('data-trusted="0"'));
});

test('linkify: SLURL renders slurl-link', () => {
  const html = BeeSlurl.linkify('secondlife://Natoma/1/2/3', esc);
  assert.ok(html.includes('class="slurl-link"'));
  assert.ok(html.includes('data-slurl="secondlife://Natoma/1/2/3"'));
});

test('coordinate: gridToRegionHandle <-> fromRegionHandle round-trip', () => {
  const handle = BeeSlurl.gridToRegionHandle(1000, 1001);
  const back = BeeSlurl.fromRegionHandle(handle);
  assert.equal(back.gridX, 1000);
  assert.equal(back.gridY, 1001);
});

test('coordinate: capCoordsToGrid treats small values as grid indices', () => {
  const g = BeeSlurl.capCoordsToGrid(1000, 1001);
  assert.equal(g.gridX, 1000);
  assert.equal(g.gridY, 1001);
  assert.equal(g.globalX, 1000 * BeeSlurl.REGION_WIDTH);
});

test('coordinate: globalToGrid snaps to region origin', () => {
  const g = BeeSlurl.globalToGrid(256300, 256010);
  assert.equal(g.gridX, 1001);
  assert.equal(g.gridY, 1000);
  assert.equal(g.globalX, 1001 * 256);
});

// --- appendLinkified -------------------------------------------------------
//
// This is the DOM path every chat body renders through. It replaced innerHTML +
// linkify(), and a rewrite that dropped the link scan left the message of the
// day with unclickable URLs - so the link nodes are pinned here explicitly.

const linkNodes = (parent) => parent.childNodes.filter((n) => n.nodeName === 'A');

test('appendLinkified: turns a plain http URL into an anchor', () => {
  const p = BeeSlurl.appendLinkified(fakeDocument().createElement('p'), 'see https://example.com/x now');
  const links = linkNodes(p);
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('data-url'), 'https://example.com/x');
  assert.equal(links[0].textContent, 'https://example.com/x');
  // the URL must never land in href - that is what keeps javascript: inert
  assert.equal(links[0].getAttribute('href'), '#');
  assert.equal(p.textContent, 'see https://example.com/x now');
});

test('appendLinkified: marks a secondlife:// SLURL with data-slurl', () => {
  const p = BeeSlurl.appendLinkified(fakeDocument().createElement('p'), 'at secondlife://Natoma/128/64/25 today');
  const links = linkNodes(p);
  assert.equal(links.length, 1);
  assert.equal(links[0].className, 'slurl-link');
  assert.equal(links[0].getAttribute('data-slurl'), 'secondlife://Natoma/128/64/25');
  assert.equal(links[0].getAttribute('data-url'), null);
});

test('appendLinkified: untrusted hosts are flagged, trusted ones are not', () => {
  const bad = BeeSlurl.appendLinkified(fakeDocument().createElement('p'), 'https://evil.example/x');
  assert.equal(linkNodes(bad)[0].getAttribute('data-trusted'), '0');
  assert.match(linkNodes(bad)[0].className, /chat-link--external/);

  // a maps.secondlife.com URL would be classified 'slurl' and carry no
  // data-trusted at all, so use a trusted host that stays a plain http link
  const good = BeeSlurl.appendLinkified(fakeDocument().createElement('p'), 'https://community.secondlife.com/blog');
  assert.equal(linkNodes(good)[0].getAttribute('data-trusted'), '1');
  assert.match(linkNodes(good)[0].className, /chat-link--trusted/);
});

test('appendLinkified: markup in the text stays text, never nodes', () => {
  const p = BeeSlurl.appendLinkified(fakeDocument().createElement('p'), '<img src=x onerror=alert(1)>');
  assert.equal(linkNodes(p).length, 0);
  assert.equal(p.childNodes.every((n) => n.nodeName === '#text'), true);
  assert.equal(p.textContent, '<img src=x onerror=alert(1)>');
});

test('appendLinkified: breaks option maps newlines to <br>, default does not', () => {
  const withBreaks = BeeSlurl.appendLinkified(fakeDocument().createElement('p'), 'one\ntwo', { breaks: true });
  assert.equal(withBreaks.childNodes.filter((n) => n.nodeName === 'BR').length, 1);

  const without = BeeSlurl.appendLinkified(fakeDocument().createElement('p'), 'one\ntwo');
  assert.equal(without.childNodes.filter((n) => n.nodeName === 'BR').length, 0);
  assert.equal(without.textContent, 'one\ntwo');
});

test('appendLinkified: a multi-line body keeps both links and breaks', () => {
  const p = BeeSlurl.appendLinkified(
    fakeDocument().createElement('p'),
    'Grid status:\nhttps://status.secondlifegrid.net/\nsecondlife://Natoma/128/64/25',
    { breaks: true }
  );
  assert.equal(linkNodes(p).length, 2);
  assert.equal(p.childNodes.filter((n) => n.nodeName === 'BR').length, 2);
});

test('appendLinkified: empty and nullish text add nothing', () => {
  assert.equal(BeeSlurl.appendLinkified(fakeDocument().createElement('p'), '').childNodes.length, 0);
  assert.equal(BeeSlurl.appendLinkified(fakeDocument().createElement('p'), null).childNodes.length, 0);
  assert.equal(BeeSlurl.appendLinkified(fakeDocument().createElement('p'), undefined).childNodes.length, 0);
});
