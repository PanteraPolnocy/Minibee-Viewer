// Unit tests for the television-remote navigation in src/js/ui/remote-nav.ts
// (BeeRemoteNav). The part that decides where an arrow press goes is plain
// arithmetic on boxes, so it is tested here on the viewer's real layouts
// drawn as numbers; the last test holds the module's list of click-only
// elements against the stylesheet, so nothing clickable can be added
// without deciding how the pad reaches it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBeeModule } from './load-module.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function load(shell) {
  const listeners = {};
  const classes = new Set();
  const win = { MinibeeAndroid: shell, setTimeout: () => 0, innerWidth: 960, innerHeight: 540 };
  const doc = {
    documentElement: { classList: { add: (c) => classes.add(c) } },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    body: {}
  };
  const BeeRemoteNav = loadBeeModule('js/ui/remote-nav.ts', 'BeeRemoteNav', {
    window: win,
    document: doc,
    BeeState: { on: () => {} },
    BeeUtils: { showToast: () => {}, storageGet: (_key, fallback) => fallback, storageSet: () => {} },
    BeeNavigation: { switchTab: () => {} }
  });
  return { BeeRemoteNav, listeners, classes };
}

const { BeeRemoteNav } = load(undefined);
const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });

// pickTarget by name, so a failure reads as a place rather than an index.
function go(from, places, dir) {
  const names = Object.keys(places).filter((name) => places[name] !== from);
  const i = BeeRemoteNav.pickTarget(from, names.map((name) => places[name]), dir);
  return i === -1 ? null : names[i];
}

// The wide layout: tabs down the left edge, the top bar across, a panel
// with a list of rows (an open button and a close button each) and a
// composer under it.
const wide = {
  navChat: box(0, 58, 88, 60),
  navIm: box(0, 118, 88, 60),
  navRadar: box(0, 418, 88, 60),
  topLocation: box(700, 10, 36, 36),
  topLogout: box(910, 10, 36, 36),
  subPeople: box(100, 66, 180, 34),
  subGroups: box(286, 66, 180, 34),
  row1Open: box(100, 110, 330, 64),
  row1Close: box(434, 126, 32, 32),
  row2Open: box(100, 176, 330, 64),
  row2Close: box(434, 192, 32, 32),
  composer: box(480, 490, 380, 40),
  send: box(866, 490, 80, 40)
};

test('up and down step through a column', () => {
  assert.equal(go(wide.navChat, wide, 'down'), 'navIm');
  assert.equal(go(wide.navIm, wide, 'up'), 'navChat');
  assert.equal(go(wide.row1Open, wide, 'down'), 'row2Open');
  assert.equal(go(wide.row2Open, wide, 'up'), 'row1Open');
  // A row's close button leads to the next row's close button, not across.
  assert.equal(go(wide.row1Close, wide, 'down'), 'row2Close');
  assert.equal(go(wide.subPeople, wide, 'down'), 'row1Open');
});

test('left and right stay in the row', () => {
  assert.equal(go(wide.row1Open, wide, 'right'), 'row1Close');
  assert.equal(go(wide.row1Close, wide, 'left'), 'row1Open');
  assert.equal(go(wide.subPeople, wide, 'right'), 'subGroups');
  assert.equal(go(wide.composer, wide, 'right'), 'send');
  assert.equal(go(wide.send, wide, 'left'), 'composer');
  // From the list back to the tabs, at the height the focus is at.
  assert.equal(go(wide.row1Open, wide, 'left'), 'navIm');
  assert.equal(go(wide.navIm, wide, 'right'), 'row1Open');
});

test('a sliver in common is not a row in common', () => {
  // The Chat tab and the top bar overlap by a few pixels of height. Going
  // right from the tab must reach the panel beside it, not a button at the
  // far end of the top bar.
  assert.equal(go(wide.navChat, wide, 'right'), 'subPeople');
  // With nothing level with the tab, the nearest thing in the panel wins
  // over anything far along the top bar.
  const sparse = { navChat: wide.navChat, topLogout: wide.topLogout, composer: wide.composer };
  assert.equal(go(sparse.navChat, sparse, 'right'), 'composer');
});

test('straight ahead beats a little nearer but off to the side', () => {
  const places = {
    from: box(100, 100, 100, 30),
    below: box(100, 150, 100, 30),      // straight down, 20 away
    beside: box(260, 140, 100, 30)      // 10 down, but well to the right
  };
  assert.equal(go(places.from, places, 'down'), 'below');
  // Row by row, though: a whole row nearer wins over something straight
  // down but far off - "down" means the next line, not the same column.
  const rows = {
    from: box(100, 100, 100, 30),
    nextRow: box(260, 140, 100, 30),
    farBelow: box(100, 300, 100, 30)
  };
  assert.equal(go(rows.from, rows, 'down'), 'nextRow');
  // A wide field directly underneath is nearer than a small button further on,
  // however far apart their centres are.
  const form = {
    from: box(700, 100, 60, 30),
    field: box(100, 140, 700, 40),
    button: box(700, 230, 60, 30)
  };
  assert.equal(go(form.from, form, 'down'), 'field');
});

test('up and down, the beam only wins while it is the nearer', () => {
  // From a top-bar button, the list just underneath (a little to the left)
  // is where "down" goes - not a button in the same column at the bottom.
  const places = {
    top: box(910, 10, 36, 36),
    list: box(480, 60, 400, 300),
    send: box(900, 490, 46, 40)
  };
  assert.equal(go(places.top, places, 'down'), 'list');
});

test('nothing that way is nothing', () => {
  assert.equal(go(wide.topLogout, wide, 'right'), null);
  assert.equal(go(wide.navChat, wide, 'left'), null);
  assert.equal(go(wide.send, wide, 'down'), null);
  assert.equal(BeeRemoteNav.pickTarget(wide.navChat, [], 'down'), -1);
  // Something that merely overlaps the origin is not "further that way".
  const overlapping = { from: box(100, 100, 200, 40), inside: box(120, 110, 40, 20) };
  assert.equal(go(overlapping.from, overlapping, 'right'), null);
  assert.equal(go(overlapping.from, overlapping, 'down'), null);
});

test('the narrow layout: tabs along the bottom', () => {
  const narrow = {
    row: box(0, 120, 360, 64),
    composer: box(8, 560, 270, 40),
    send: box(286, 560, 66, 40),
    navChat: box(0, 610, 56, 50),
    navIm: box(56, 610, 56, 50),
    navEvents: box(168, 610, 56, 50)
  };
  // Several tabs lie under the wide field: the one under its middle.
  assert.equal(go(narrow.composer, narrow, 'down'), 'navEvents');
  assert.equal(go(narrow.send, narrow, 'down'), 'navEvents');
  assert.equal(go(narrow.row, narrow, 'down'), 'composer');
  assert.equal(go(narrow.navChat, narrow, 'right'), 'navIm');
  assert.equal(go(narrow.navIm, narrow, 'up'), 'composer');
  assert.equal(go(narrow.composer, narrow, 'up'), 'row');
});

test('a lost focus is picked up where it was', () => {
  const boxes = [wide.row1Open, wide.row2Open, wide.composer];
  // The row was redrawn in place: the stop on the same spot.
  assert.equal(BeeRemoteNav.nearestBox(box(100, 176, 330, 64), boxes), 1);
  // The list shrank: the nearest one left.
  assert.equal(BeeRemoteNav.nearestBox(box(100, 250, 330, 64), boxes), 1);
  assert.equal(BeeRemoteNav.nearestBox(box(500, 470, 100, 20), boxes), 2);
  assert.equal(BeeRemoteNav.nearestBox(box(0, 0, 10, 10), []), -1);
});

test('the pad is off unless the shell reports a television', () => {
  const none = load(undefined);
  none.BeeRemoteNav.init();
  assert.equal(none.BeeRemoteNav.isEnabled(), false);

  const phone = load({ updateState: () => {}, isTelevision: () => false });
  phone.BeeRemoteNav.init();
  assert.equal(phone.BeeRemoteNav.isEnabled(), false);
  assert.equal(phone.classes.has('remote-nav'), false);
  assert.equal(phone.listeners.keydown, undefined, 'a phone\'s arrow keys are left alone');
  assert.equal(phone.BeeRemoteNav.back(), false);

  const old = load({ updateState: () => {} });
  old.BeeRemoteNav.init();
  assert.equal(old.BeeRemoteNav.isEnabled(), false, 'a shell that cannot say stays as it was');

  const tv = load({ updateState: () => {}, isTelevision: () => true });
  tv.BeeRemoteNav.init();
  assert.equal(tv.BeeRemoteNav.isEnabled(), true);
  assert.ok(tv.classes.has('remote-nav'), 'the heavy focus ring is switched on with it');
  assert.equal(typeof tv.listeners.keydown, 'function');

  const broken = load({ updateState: () => {}, isTelevision: () => { throw new Error('gone'); } });
  broken.BeeRemoteNav.init();
  assert.equal(broken.BeeRemoteNav.isEnabled(), false);
});

// Every selector the stylesheet gives a pointer cursor is something a
// finger can press. Each has to be within the pad's reach: either a control
// the browser focuses by itself (listed here, by what the code creates), or
// an element in the module's click-only list.
const NATIVE = [
  '.btn', '.icon-btn', '.top-bar__name--interactive:not(:disabled)', 'button.bee-menu__value--action',
  '.composer__volume', '.im-new-btn', '.im-subtab', '.im-roster__name-btn', '.im-roster__mute',
  '.im-thread__name', '.im-tab-link', '.im-session__open', '.dest-feedbar__item',
  '.dest-card__link', '.dest-slurl-link', '.events-subtab', '.land-tab', '.bottom-nav__item',
  '.objects-sort', '.objects-expand', '.objects-range', '.news-item__head', '.settings-tab',
  '.settings-link', '.chat-link', '.map-pan-btn', '.map-landmark', '.context-menu button',
  '.search-kind', '.search-result__toggle', 'button.status-chip--balance', '.buy-currency__link',
  '.profile-tab', '.group-notices__item', 'button.profile-uuid--menu', '.profile-split__item',
  '.profile-link', '.profile-inline-link', '.scripts-list__item', '.script-signature__toggle',
  '.script-complete__item', '.script-diag', '.chat-radar__item', '.script-dialog__ignore--link',
  '.script-dialog__object--link',
  // A read-only field that opens a profile: focusable, clicked by Select.
  '.land-field--profile',
  // Labels around a real checkbox, which is what takes the focus.
  '.toggle', '.conference-picker__row', '.log-record-toggle', '.log-record-toggle input',
  // Made focusable by the code that builds it (tabindex and its own keys).
  '.objects-row--item',
  // Wrappers whose click only repeats a button inside them.
  '.top-bar__identity--interactive', '.objects-cell--expandable'
];
// Click-only elements, as the stylesheet names them -> what in the module's
// list covers them.
const CLICK_ONLY = {
  '.entity-item': 'li.entity-item',
  '.entity-item__body--clickable': '.entity-item__body--clickable',
  '.msg__name--link': '.msg__name--link'
};

test('everything with a pointer cursor is within the pad\'s reach', () => {
  const css = fs.readFileSync(path.join(SRC, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const pointers = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/cursor:\s*pointer/.test(m[2])) continue;
    m[1].split(',').forEach((s) => pointers.push(s.trim().replace(/\s+/g, ' ')));
  }
  assert.ok(pointers.length > 40, 'the stylesheet was read');
  const clickable = BeeRemoteNav.selectors.clickable.split(',').map((s) => s.trim());
  const unknown = pointers.filter((selector) => {
    if (NATIVE.includes(selector)) return false;
    return !(selector in CLICK_ONLY && clickable.includes(CLICK_ONLY[selector]));
  });
  assert.deepEqual(unknown, [],
    'new clickable styles: list each under NATIVE (a real control) or add it to CLICKABLE in remote-nav.ts');
  // And the lists here hold nothing the stylesheet has dropped.
  const stale = NATIVE.concat(Object.keys(CLICK_ONLY)).filter((s) => !pointers.includes(s));
  assert.deepEqual(stale, []);
});
