/**
 * Remote-control navigation: a television remote's five-way pad drives the
 * viewer.
 *
 * On a television (Fire TV, Android TV) there is no pointer and no Tab key.
 * The arrows move the focus to the nearest control that way, Select (Enter)
 * activates it, and Menu opens its context menu - what a long-press does
 * under a finger. Lists and transcripts scroll as the focus travels through
 * them; a stretch of plain text with nothing to land on becomes a stop of
 * its own, which the arrows scroll until it runs out. The focus is drawn
 * heavily enough to be read from across a room (html.remote-nav in app.css)
 * and is put back whenever a list redraws the row it was on.
 *
 * All of it is off unless the Android shell reports a television (the
 * isTelevision() hook MainActivity adds to MinibeeAndroid): everywhere else
 * the arrows keep their usual meaning and this module does nothing. The same
 * shell forwards the keys a WebView does not reliably hand to a page - Menu
 * and the media row - through remoteKey(), and asks back() before it decides
 * what the Back button does.
 *
 * The geometry (pickTarget and what it leans on) is plain arithmetic on
 * boxes, kept away from the DOM so the tests can drive it.
 */
const BeeRemoteNav = (function () {
  'use strict';

  const t = BeeI18n.t;

  type Box = { left: number; top: number; right: number; bottom: number };
  type Dir = 'up' | 'down' | 'left' | 'right';
  // A place the focus can land: the element, where it is, the part of it
  // that shows through the scroll areas around it (innermost first).
  type Stop = { el: HTMLElement; box: Box; areas: Area[] };
  // An element that clips its content, and which ways it scrolls.
  type Area = { el: HTMLElement; box: Box; scrollX: boolean; scrollY: boolean };

  // What the browser focuses by itself...
  const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], ' +
    '[contenteditable=""], [contenteditable="true"]';
  // ...and what only answers a click: rows that open a menu, names that open
  // a profile. test/remote-nav.test.mjs holds this list against every
  // pointer cursor in the stylesheet, so a new clickable thing cannot be
  // left out of the pad's reach unnoticed.
  const CLICKABLE = 'li.entity-item, .entity-item__body--clickable, .msg__name--link, [role="button"]';
  // What takes the pad for itself while it is up.
  const LAYERS = 'dialog[open], .session-lost-blocker, .bee-menu, menu.context-menu';
  // The bars: the tabs and the top bar. The pad crosses into and out of a
  // bar freely (left and right, for the column of tabs) but along its length
  // only straight on - "down" from the end of a list must not slide
  // sideways into the tabs.
  const BARS = '.side-nav, .top-bar';
  const ARROWS: Record<string, Dir> = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right'
  };
  // One press scrolls this much of a scroll area's extent - and the focus
  // never jumps further than that past its edge, so no text is skipped.
  const SCROLL_STEP = 0.4;
  // Set on what this module made focusable: 'click' (activated with a click)
  // or 'scroll' (a stretch of text the arrows scroll).
  const MARK = 'data-remote-focus';
  // Set on a slider while the arrows are its own (see `adjusting`).
  const ADJUST = 'data-remote-adjust';
  // Set on a text field the focus reached with the pad, holding the
  // field's own inputmode: it has not asked for the on-screen keyboard yet
  // (see quiet and wake).
  const KEYBOARD = 'data-remote-keyboard';
  // The hint about the keys is shown on the first few starts, then no more.
  const HINT_KEY = 'minibee-remote-hints';
  const HINT_RUNS = 3;

  let enabled = false;
  let lastBox: Box | null = null;      // where the focus last was, for when its element is redrawn
  let returnTo: HTMLElement | null = null; // what had the focus before a menu took it
  // A slider being adjusted. The pad's arrows move the focus, so a slider
  // would either swallow them (a trap in the middle of the top bar) or never
  // move; Select on it hands it the arrows, Select or Back takes them back.
  let adjusting: HTMLElement | null = null;

  // --- geometry ---

  function horizontal(dir: Dir) {
    return dir === 'left' || dir === 'right';
  }

  // Whether `c` lies `dir` of `o` at all: both its edges on that axis are
  // further that way than the origin's.
  function liesToward(o: Box, c: Box, dir: Dir) {
    if (dir === 'right') return c.right > o.right + 0.5 && c.left > o.left + 0.5;
    if (dir === 'left') return c.left < o.left - 0.5 && c.right < o.right - 0.5;
    if (dir === 'down') return c.bottom > o.bottom + 0.5 && c.top > o.top + 0.5;
    return c.top < o.top - 0.5 && c.bottom < o.bottom - 0.5;
  }

  // The gap to cross along the way (nothing, when the two overlap).
  function ahead(o: Box, c: Box, dir: Dir) {
    const gap = dir === 'right' ? c.left - o.right
      : dir === 'left' ? o.left - c.right
        : dir === 'down' ? c.top - o.bottom
          : o.top - c.bottom;
    return Math.max(0, gap);
  }

  // The same, measured to the far side of `c`.
  function aheadFar(o: Box, c: Box, dir: Dir) {
    const gap = dir === 'right' ? c.right - o.right
      : dir === 'left' ? o.left - c.left
        : dir === 'down' ? c.bottom - o.bottom
          : o.top - c.top;
    return Math.max(1, gap);
  }

  // Across the way: whether `c` sits in the origin's beam (their extents
  // overlap by a quarter of the smaller one - a sliver in common is not a
  // row in common), how far outside it otherwise, and how far off-centre.
  function sideways(o: Box, c: Box, dir: Dir) {
    const o1 = horizontal(dir) ? o.top : o.left;
    const o2 = horizontal(dir) ? o.bottom : o.right;
    const c1 = horizontal(dir) ? c.top : c.left;
    const c2 = horizontal(dir) ? c.bottom : c.right;
    const overlap = Math.min(o2, c2) - Math.max(o1, c1);
    const smaller = Math.min(o2 - o1, c2 - c1);
    return {
      beam: overlap > 0 && overlap >= smaller * 0.25,
      gap: Math.max(0, -overlap),
      off: Math.abs((c1 + c2) - (o1 + o2)) / 2
    };
  }

  // Lower is nearer. Distance along the way counts far more than distance
  // across it; inside the beam only the former counts, with the centres as a
  // tie-break.
  function weighted(o: Box, c: Box, dir: Dir) {
    const major = ahead(o, c, dir);
    const side = sideways(o, c, dir);
    const minor = side.beam ? 0 : Math.max(side.gap, 1);
    return 13 * major * major + minor * minor + side.off * 0.01;
  }

  // Whether `a` is the better place to go than `b`. Something in the beam
  // beats something outside it - always along a row, and up or down for as
  // long as it is nearer than the far side of the other; past that, the
  // weighted distance decides.
  function beats(o: Box, a: Box, b: Box, dir: Dir) {
    const aBeam = sideways(o, a, dir).beam;
    const bBeam = sideways(o, b, dir).beam;
    if (aBeam !== bBeam) {
      const inBeam = aBeam ? a : b;
      const other = aBeam ? b : a;
      if (horizontal(dir) || ahead(o, inBeam, dir) < aheadFar(o, other, dir)) return aBeam;
    }
    return weighted(o, a, dir) < weighted(o, b, dir);
  }

  // The index of the box to move to from `origin`, or -1 when nothing lies
  // that way.
  function pickTarget(origin: Box, boxes: Box[], dir: Dir) {
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (!liesToward(origin, boxes[i], dir)) continue;
      if (best === -1 || beats(origin, boxes[i], boxes[best], dir)) best = i;
    }
    return best;
  }

  // The index of the box nearest to `box` - on it, or failing that beside
  // it - or -1.
  function nearestBox(box: Box, boxes: Box[]) {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const c = boxes[i];
      const dx = Math.max(0, c.left - box.right, box.left - c.right);
      const dy = Math.max(0, c.top - box.bottom, box.top - c.bottom);
      const cx = ((c.left + c.right) - (box.left + box.right)) / 2;
      const cy = ((c.top + c.bottom) - (box.top + box.bottom)) / 2;
      const score = (dx * dx + dy * dy) * 1000 + cx * cx + cy * cy;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  function intersect(a: Box, b: Box): Box | null {
    const box = {
      left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom)
    };
    return box.right - box.left >= 1 && box.bottom - box.top >= 1 ? box : null;
  }

  // The edge of `box` a move toward `dir` starts from when the focus is the
  // box itself (a scroll area): the side it is leaving.
  function trailingEdge(box: Box, dir: Dir): Box {
    if (dir === 'down') return { left: box.left, right: box.right, top: box.top, bottom: box.top };
    if (dir === 'up') return { left: box.left, right: box.right, top: box.bottom, bottom: box.bottom };
    if (dir === 'right') return { left: box.left, right: box.left, top: box.top, bottom: box.bottom };
    return { left: box.right, right: box.right, top: box.top, bottom: box.bottom };
  }

  // Whether `box` shows in `view`, or would after one scroll step toward `dir`.
  function withinReach(box: Box, view: Box, dir: Dir, step: number) {
    if (dir === 'down') return box.top <= view.bottom + step;
    if (dir === 'up') return box.bottom >= view.top - step;
    if (dir === 'right') return box.left <= view.right + step;
    return box.right >= view.left - step;
  }

  // --- the page ---

  function boxOf(el: Element): Box {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }

  function viewport(): Box {
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  }

  function isShown(el: Element | null) {
    return !!el && el.getClientRects().length > 0;
  }

  // What is up, innermost first and always ending with the page: a menu,
  // over the newest dialog (or, with none, the session-lost card).
  function layerStack(): HTMLElement[] {
    const shown = Array.prototype.filter.call(
      document.querySelectorAll<HTMLElement>(LAYERS), isShown) as HTMLElement[];
    const stack: HTMLElement[] = [];
    const menus = shown.filter(function (l) { return l.matches('menu.context-menu, .bee-menu'); });
    if (menus.length) stack.push(menus[menus.length - 1]);
    const dialogs = shown.filter(function (l) { return l.tagName === 'DIALOG'; });
    const cards = shown.filter(function (l) { return l.matches('.session-lost-blocker'); });
    if (dialogs.length) stack.push(dialogs[dialogs.length - 1]);
    else if (cards.length) stack.push(cards[cards.length - 1]);
    stack.push(document.body);
    return stack;
  }

  function topLayer(): HTMLElement {
    return layerStack()[0];
  }

  // The layer the pad works in, with its stops: the innermost one that has
  // anything to land on. A menu whose every entry is greyed out, or a
  // progress box without a button, holds nothing - the pad stays below it.
  function workLayer() {
    const stack = layerStack();
    for (let i = 0; i < stack.length - 1; i++) {
      const found = collect(stack[i]);
      if (found.stops.length) return { layer: stack[i], stops: found.stops, areas: found.areas };
    }
    const page = collect(document.body);
    return { layer: document.body as HTMLElement, stops: page.stops, areas: page.areas };
  }

  // Everything in the layer that clips what is inside it. Reading the scroll
  // extents first keeps the style lookups to the few elements that overflow.
  function clipAreas(layer: HTMLElement) {
    const areas = new Map<Element, Area>();
    const all = layer.getElementsByTagName('*');
    const consider = function (el: HTMLElement) {
      const overY = el.scrollHeight - el.clientHeight > 1;
      const overX = el.scrollWidth - el.clientWidth > 1;
      if (!overX && !overY) return;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
      // A label cut short with an ellipsis clips nothing the focus could be
      // on; only a tall block of bare text (a page of help) matters.
      if (!el.firstElementChild && !(overY && el.clientHeight >= 48)) return;
      const style = window.getComputedStyle(el);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') return;
      const scrolls = function (value) { return value === 'auto' || value === 'scroll' || value === 'overlay'; };
      areas.set(el, {
        el: el, box: boxOf(el),
        scrollX: overX && scrolls(style.overflowX),
        scrollY: overY && scrolls(style.overflowY)
      });
    };
    if (layer !== document.body) consider(layer);
    for (let i = 0; i < all.length; i++) consider(all[i] as HTMLElement);
    return areas;
  }

  function enclosing(el: Element, layer: HTMLElement, areas: Map<Element, Area>) {
    const out: Area[] = [];
    let p = el.parentElement;
    while (p) {
      const area = areas.get(p);
      if (area) out.push(area);
      if (p === layer) break;
      p = p.parentElement;
    }
    return out;
  }

  function wanted(el: HTMLElement) {
    if ((el as any).disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden') return false;
    const mark = el.getAttribute(MARK);
    // A stretch of text is a stop only while it qualifies (see collect).
    if (mark === 'scroll') return false;
    // Whatever the page itself took out of the keyboard's way stays out.
    if (!mark && el.getAttribute('tabindex') === '-1' &&
        !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName)) {
      return false;
    }
    return true;
  }

  // Every place in the layer the focus can land.
  function collect(layer: HTMLElement) {
    const areas = clipAreas(layer);
    const stops: Stop[] = [];
    const byElement = new Map<Element, Stop>();
    const nodes = layer.querySelectorAll<HTMLElement>(FOCUSABLE + ', ' + CLICKABLE);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!wanted(el)) continue;
      const box = boxOf(el);
      if (box.right - box.left < 1 || box.bottom - box.top < 1) continue;
      const stop = { el: el, box: box, areas: enclosing(el, layer, areas) };
      stops.push(stop);
      byElement.set(el, stop);
    }

    // A row that answers a click and also holds controls of its own stands
    // for the part of itself they do not cover, so that left and right step
    // between the row and its buttons, and up and down between rows.
    const dropped = new Set<Stop>();
    stops.forEach(function (stop) {
      if (!stop.el.matches(CLICKABLE)) return;
      const inner = stop.el.querySelectorAll(FOCUSABLE + ', ' + CLICKABLE);
      let innerLeft = Infinity;
      let innerRight = -Infinity;
      for (let i = 0; i < inner.length; i++) {
        const other = byElement.get(inner[i]);
        if (!other) continue;
        innerLeft = Math.min(innerLeft, other.box.left);
        innerRight = Math.max(innerRight, other.box.right);
      }
      if (innerLeft === Infinity) return;
      if (innerLeft - stop.box.left >= 24) {
        stop.box = { left: stop.box.left, top: stop.box.top, right: innerLeft, bottom: stop.box.bottom };
      } else if (stop.box.right - innerRight >= 24) {
        stop.box = { left: innerRight, top: stop.box.top, right: stop.box.right, bottom: stop.box.bottom };
      } else {
        dropped.add(stop);
      }
    });
    const kept = stops.filter(function (stop) { return !dropped.has(stop); });

    // A scroll area showing nothing to land on - a transcript, a page of
    // help - is a stop itself: the arrows scroll it.
    areas.forEach(function (area) {
      if (!area.scrollY || area.el.clientHeight < 48 || byElement.has(area.el)) return;
      const busy = kept.some(function (stop) {
        return stop.areas.indexOf(area) !== -1 && !!showing(stop, null);
      });
      if (!busy) kept.push({ el: area.el, box: area.box, areas: enclosing(area.el, layer, areas) });
    });
    return { stops: kept, areas: areas };
  }

  // The part of a stop that shows through the scroll areas around it, up to
  // but not including `level` (null: all the way out to the screen).
  function showing(stop: Stop, level: Area | null): Box | null {
    let box: Box | null = stop.box;
    for (let i = 0; i < stop.areas.length && box; i++) {
      if (stop.areas[i] === level) return box;
      box = intersect(box, stop.areas[i].box);
    }
    return box && !level ? intersect(box, viewport()) : box;
  }

  // Whether the stop can really be landed on: not hidden by a style, and not
  // lying under something else (a layer this module does not know of).
  function reachable(stop: Stop) {
    const el = stop.el;
    if (!el.isConnected || el.closest('[inert]')) return false;
    const check = (el as any).checkVisibility;
    if (typeof check === 'function') {
      if (!check.call(el, { checkVisibilityCSS: true })) return false;
    } else if (window.getComputedStyle(el).visibility === 'hidden') {
      return false;
    }
    const seen = showing(stop, null);
    // Scrolled out of sight: its scroll area will bring it back.
    if (!seen) return true;
    const hit = document.elementFromPoint((seen.left + seen.right) / 2, (seen.top + seen.bottom) / 2);
    if (!hit || hit === el || el.contains(hit)) return true;
    // A toast passing over it is not in the way, and neither is a sticky
    // header of its own list; anything else is.
    if (hit.closest('#toast-container')) return true;
    return stop.areas.length > 0 && stop.areas[0].el.contains(hit);
  }

  // The bar (see BARS) an element belongs to, and whether a move toward
  // `dir` runs along that bar's length.
  function barOf(el: Element) {
    return el.closest ? el.closest(BARS) : null;
  }

  function runsAlong(bar: Element | null, dir: Dir) {
    if (!bar) return false;
    const b = boxOf(bar);
    const column = b.bottom - b.top >= b.right - b.left;
    return column !== horizontal(dir);
  }

  function canScroll(area: Area, dir: Dir) {
    const el = area.el;
    if (horizontal(dir)) {
      if (!area.scrollX) return false;
      return dir === 'left' ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    }
    if (!area.scrollY) return false;
    return dir === 'up' ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }

  function stepOf(area: Area, dir: Dir) {
    const extent = horizontal(dir) ? area.el.clientWidth : area.el.clientHeight;
    return Math.max(40, Math.round(extent * SCROLL_STEP));
  }

  function scrollArea(area: Area, dir: Dir) {
    const by = stepOf(area, dir) * (dir === 'up' || dir === 'left' ? -1 : 1);
    if (horizontal(dir)) area.el.scrollLeft += by;
    else area.el.scrollTop += by;
  }

  function remember(el: HTMLElement) {
    lastBox = boxOf(el);
  }

  // A text field the pad lands on must not raise the on-screen keyboard:
  // that keyboard takes the pad for itself, and every field passed on the
  // way somewhere else would have to be backed out of. A focus set from a
  // key press does raise it, so the field is told it wants none (inputmode
  // "none", its own value kept in the marker) until Select asks - wake().
  // A keyboard that is plugged in types either way.
  function quiet(el: HTMLElement) {
    if (el.hasAttribute(KEYBOARD)) return;
    el.setAttribute(KEYBOARD, el.getAttribute('inputmode') || '');
    el.setAttribute('inputmode', 'none');
  }

  function wake(el: HTMLElement) {
    const own = el.getAttribute(KEYBOARD);
    el.removeAttribute(KEYBOARD);
    if (own) el.setAttribute('inputmode', own);
    else el.removeAttribute('inputmode');
    // Focusing it again, inside the key press, is what brings the keyboard up.
    el.blur();
    el.focus({ preventScroll: true });
  }

  // Put the focus on a stop, making the element focusable first where the
  // page never did, and bring it into view.
  function land(stop: Stop) {
    const el = stop.el;
    if (!el.matches(FOCUSABLE)) {
      el.setAttribute('tabindex', '-1');
      el.setAttribute(MARK, el.matches(CLICKABLE) ? 'click' : 'scroll');
    } else if (el.getAttribute(MARK) === 'scroll' && el.matches(CLICKABLE)) {
      el.setAttribute(MARK, 'click');
    }
    if (isTyping(el)) quiet(el);
    el.focus({ preventScroll: true });
    if (document.activeElement !== el) return false;
    const seen = showing(stop, null);
    const whole = seen && seen.right - seen.left >= stop.box.right - stop.box.left - 1 &&
      seen.bottom - seen.top >= stop.box.bottom - stop.box.top - 1;
    // A scroll area is where it is; anything else comes fully into view.
    if (!whole && el.getAttribute(MARK) !== 'scroll') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    remember(el);
    return true;
  }

  // The best stop toward `dir` among `pool`, skipping any that turn out to
  // be covered or hidden.
  function choose(origin: Box, pool: Stop[], boxes: Box[], dir: Dir) {
    for (let tries = 0; tries < 12 && pool.length; tries++) {
      const i = pickTarget(origin, boxes, dir);
      if (i === -1) return null;
      if (reachable(pool[i])) return pool[i];
      pool.splice(i, 1);
      boxes.splice(i, 1);
    }
    return null;
  }

  // Nothing has the focus (the app just started, a screen changed, a list
  // redrew the row it was on): pick it up again - what a menu took it from,
  // then wherever it last was, then the layer's natural starting point.
  function enter(layer: HTMLElement, stops: Stop[]) {
    if (returnTo && returnTo.isConnected && isShown(returnTo) && layer.contains(returnTo)) {
      const back = returnTo;
      returnTo = null;
      back.focus({ preventScroll: true });
      if (document.activeElement === back) {
        remember(back);
        return true;
      }
    }
    const visible: Stop[] = [];
    const boxes: Box[] = [];
    stops.forEach(function (stop) {
      const seen = showing(stop, null);
      if (seen) {
        visible.push(stop);
        boxes.push(seen);
      }
    });
    if (!visible.length) return false;
    const order: Stop[] = [];
    if (lastBox && layer === document.body) {
      const i = nearestBox(lastBox, boxes);
      if (i !== -1) order.push(visible[i]);
    }
    const home = layer.querySelector<HTMLElement>('[autofocus], .bottom-nav__item--active');
    visible.forEach(function (stop) { if (stop.el === home) order.push(stop); });
    // Reading order: what a person would call the first thing on the screen.
    visible.slice().sort(function (a, b) {
      return (a.box.top - b.box.top) || (a.box.left - b.box.left);
    }).forEach(function (stop) { order.push(stop); });
    for (let i = 0; i < order.length; i++) {
      if (reachable(order[i]) && land(order[i])) return true;
    }
    return false;
  }

  // One press of an arrow. Works outwards through the scroll areas around
  // the focus: within each, first a stop that shows or is one step away,
  // then the scrolling itself, and only when that has run out the area
  // beyond.
  function move(dir: Dir) {
    const found = workLayer();
    const layer = found.layer;
    const stops = found.stops;
    let from = document.activeElement as HTMLElement | null;
    if (!from || from === document.body || !layer.contains(from) || !isShown(from)) from = null;
    if (!from) {
      // A menu that just came up takes the focus from whatever had it.
      const had = document.activeElement as HTMLElement | null;
      if (had && had !== document.body && layer !== document.body && !returnTo) returnTo = had;
      enter(layer, stops);
      return;
    }

    const self = stops.filter(function (stop) { return stop.el === from; })[0];
    const own = found.areas.get(from);
    let origin = self ? self.box : boxOf(from);
    // The scroll areas to work through: the focus itself when it is one (a
    // stretch of text made a stop here, or a block the page made focusable
    // so that it can be scrolled), then those around it, then (null) the
    // layer as a whole.
    const levels: Array<Area | null> = [];
    if (own && (own.scrollX || own.scrollY)) levels.push(own);
    (self ? self.areas : enclosing(from, layer, found.areas)).forEach(function (area) { levels.push(area); });
    levels.push(null);

    // Along the length of a bar - its own, or one it would enter - the focus
    // only moves straight on (see BARS).
    const fromBar = barOf(from);
    const fromAlong = runsAlong(fromBar, dir);
    const along = new Map<Element, boolean>();
    const straightOnly = function (stop: Stop) {
      const bar = barOf(stop.el);
      if (bar === fromBar) return false;
      if (fromAlong) return true;
      if (!bar) return false;
      if (!along.has(bar)) along.set(bar, runsAlong(bar, dir));
      return along.get(bar);
    };

    for (let n = 0; n < levels.length; n++) {
      const level = levels[n];
      const inside = !!level && level.el === from;
      const start = inside ? trailingEdge(level.box, dir) : origin;
      const pool: Stop[] = [];
      const boxes: Box[] = [];
      stops.forEach(function (stop) {
        if (stop.el === from) return;
        if (level && (stop.el === level.el || stop.areas.indexOf(level) === -1)) return;
        const seen = showing(stop, level);
        if (!seen) return;
        if (level ? !withinReach(seen, level.box, dir, stepOf(level, dir)) : !intersect(seen, viewport())) return;
        if (straightOnly(stop) && !sideways(start, seen, dir).beam) return;
        pool.push(stop);
        boxes.push(seen);
      });
      const target = choose(start, pool, boxes, dir);
      if (target && land(target)) return;
      if (level && canScroll(level, dir)) {
        scrollArea(level, dir);
        return;
      }
      // Out of this area: go on from what still shows of the focus, or
      // from the area itself.
      if (level) origin = (!inside && intersect(origin, level.box)) || level.box;
    }
  }

  // --- keys ---

  function isTyping(el: HTMLElement) {
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly;
    if (el.tagName !== 'INPUT') return false;
    const input = el as HTMLInputElement;
    if (input.readOnly) return false;
    return ['text', 'search', 'url', 'tel', 'email', 'password', 'number', ''].indexOf(
      String(input.type || '').toLowerCase()) !== -1;
  }

  function setAdjusting(el: HTMLElement | null) {
    if (adjusting && adjusting !== el) adjusting.removeAttribute(ADJUST);
    adjusting = el;
    if (el) el.setAttribute(ADJUST, '1');
  }

  // A click where the element is, as a finger would land it: handlers that
  // open a menu at the pointer then open it beside the row, not in the
  // corner of the screen.
  function clickAt(el: HTMLElement) {
    const box = boxOf(el);
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window,
      clientX: Math.round(Math.min(box.left + 24, (box.left + box.right) / 2)),
      clientY: Math.round((box.top + box.bottom) / 2)
    }));
  }

  // Whether an arrow may take the focus out of the element that has it. In
  // a text field the arrows are the caret's until it reaches the end of the
  // text (a one-line field has no up or down to speak of); a slider has
  // them only while it is being adjusted.
  function mayLeave(el: HTMLElement, dir: Dir) {
    if (el === adjusting) return false;
    if (!isTyping(el)) return true;
    if (el.isContentEditable) return false;
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    const oneLine = el.tagName === 'INPUT';
    if (oneLine && !horizontal(dir)) return true;
    let start: number | null = null;
    let end: number | null = null;
    try {
      start = field.selectionStart;
      end = field.selectionEnd;
    } catch (_e) { /* a field type with no caret to ask about */ }
    if (start === null || end === null) return !field.value;
    if (start !== end) return false;
    return dir === 'left' || dir === 'up' ? start === 0 : start === field.value.length;
  }

  // Select. A real control activates itself on Enter; what is left is the
  // things only a click reaches, the boxes Enter does not tick, and a pad
  // whose centre key arrives under another name.
  function activate(e: KeyboardEvent) {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return;
    const isEnter = e.key === 'Enter';
    if (isTyping(el)) return; // a text field's Select is settled in onSelectInField
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const input = el as HTMLInputElement;
      if (input.type === 'range') {
        // Select takes the slider up, and puts it down again.
        e.preventDefault();
        setAdjusting(adjusting === el ? null : el);
        return;
      }
      if (input.type === 'checkbox' || input.type === 'radio' || input.readOnly || !isEnter) {
        e.preventDefault();
        clickAt(el);
      }
      return;
    }
    if (tag === 'SELECT') {
      if (!isEnter && typeof (el as any).showPicker === 'function') {
        e.preventDefault();
        try { (el as any).showPicker(); } catch (_e) { /* needs a gesture some engines do not see here */ }
      }
      return;
    }
    if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') {
      if (!isEnter) {
        e.preventDefault();
        clickAt(el);
      }
      return;
    }
    // Made focusable here, so nothing of the page's listens for its keys.
    if (el.getAttribute(MARK) === 'click') {
      e.preventDefault();
      clickAt(el);
    }
  }

  // Menu: the context menu of whatever has the focus, as a right-click on
  // it would raise - and then the pad moves into that menu.
  function openMenu() {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || !isShown(el)) return;
    const box = boxOf(el);
    const x = Math.round(Math.min(box.left + 24, (box.left + box.right) / 2));
    const y = Math.round((box.top + box.bottom) / 2);
    const before = topLayer();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 2
    }));
    window.setTimeout(function () {
      const layer = topLayer();
      if (layer === before || layer === document.body || layer.contains(document.activeElement)) return;
      const stops = collect(layer).stops;
      // Nothing to choose from in it: the focus stays where it was.
      if (!stops.length) return;
      returnTo = el;
      enter(layer, stops);
    }, 0);
  }

  // The pad's centre key: Enter, or where a WebView reports it otherwise,
  // "Select" or key code 23.
  function isSelect(e: KeyboardEvent) {
    return e.key === 'Enter' || e.key === 'Select' || e.keyCode === 23;
  }

  // Select in a text field, heard before the field's own listeners (this one
  // is registered for the capture phase): the first press on a field the pad
  // landed on asks for the on-screen keyboard and goes no further - a
  // composer would otherwise take it for "send". After that Enter is the
  // field's own (see settleField).
  function onSelectInField(e: KeyboardEvent) {
    if (!enabled || !isSelect(e) || e.isComposing) return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || !isTyping(el) || !el.hasAttribute(KEYBOARD)) return;
    e.preventDefault();
    e.stopPropagation();
    wake(el);
  }

  // An Enter the field took for itself - the message sent, the form sent -
  // which is also how the on-screen keyboard's own Done key arrives. The
  // typing is over, so the field goes quiet again and the next Select
  // brings the keyboard back. An Enter that only starts a new line (a
  // script, a notecard) leaves the keyboard where it is.
  function settleField(e: KeyboardEvent) {
    if (!isSelect(e) || e.isComposing || e.shiftKey) return;
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || !isTyping(el) || el.hasAttribute(KEYBOARD)) return;
    if (el.tagName !== 'INPUT' && !e.defaultPrevented) return;
    window.setTimeout(function () {
      if (document.activeElement === el) quiet(el);
    }, 0);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!enabled) return;
    settleField(e);
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const dir = ARROWS[e.key];
    if (dir) {
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body && !mayLeave(el, dir)) return;
      // Ours either way: nothing that way must not scroll the page or wake
      // the WebView's own navigation.
      e.preventDefault();
      move(dir);
      return;
    }
    if (e.key === 'ContextMenu') {
      e.preventDefault();
      openMenu();
      return;
    }
    if (isSelect(e)) activate(e);
  }

  function onFocusIn(e: FocusEvent) {
    const el = e.target as HTMLElement | null;
    if (adjusting && el !== adjusting) setAdjusting(null);
    if (el && el !== document.body && el.getBoundingClientRect) remember(el);
  }

  // The focus fell off the page - its element was redrawn or hidden. A
  // highlight that vanishes every time a list refreshes is no use on a
  // television, so once the redraw has settled it is put back.
  function onFocusOut(e: FocusEvent) {
    if (e.relatedTarget) return;
    window.setTimeout(function () {
      if (!enabled || !document.hasFocus()) return;
      const active = document.activeElement;
      if (active && active !== document.body && isShown(active)) return;
      const found = workLayer();
      enter(found.layer, found.stops);
    }, 60);
  }

  // The start of a screen: the active tab once logged in, the first field
  // of the login form before that.
  function focusHome() {
    if (!enabled) return;
    const found = workLayer();
    if (found.layer !== document.body) {
      if (!found.layer.contains(document.activeElement)) enter(found.layer, found.stops);
      return;
    }
    lastBox = null;
    returnTo = null;
    enter(found.layer, found.stops);
  }

  // The tab before or after the one showing.
  function stepTab(by: number) {
    if (topLayer() !== document.body || !isShown(document.getElementById('screen-main'))) return;
    const tabs = Array.prototype.filter.call(
      document.querySelectorAll<HTMLElement>('.side-nav .bottom-nav__item'), isShown) as HTMLElement[];
    if (!tabs.length) return;
    let at = 0;
    tabs.forEach(function (tab, i) { if (tab.classList.contains('bottom-nav__item--active')) at = i; });
    const next = tabs[(at + by + tabs.length) % tabs.length];
    if (next.dataset.tab) BeeNavigation.switchTab(next.dataset.tab);
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    remember(next);
  }

  // A remote key the Android shell caught for the page (see MainActivity's
  // dispatchKeyEvent): Menu, and the media row - play/pause for the parcel's
  // music, rewind and fast-forward for the tab before and after.
  function remoteKey(name: string) {
    if (!enabled) return;
    if (name === 'menu') {
      openMenu();
    } else if (name === 'playpause') {
      if (typeof BeeParcelMusic !== 'undefined' && BeeParcelMusic.toggle &&
          BeeParcelMusic.state && BeeParcelMusic.state().url) {
        BeeParcelMusic.toggle();
      }
    } else if (name === 'next' || name === 'previous') {
      stepTab(name === 'next' ? 1 : -1);
    }
  }

  // Back, asked by the Android bridge once nothing is left to close: a
  // slider being adjusted is put down; from inside a panel the first press
  // returns the focus to the tabs, where the next one is the question of
  // leaving. True when the press was used.
  function back() {
    if (!enabled) return false;
    if (adjusting) {
      setAdjusting(null);
      return true;
    }
    if (topLayer() !== document.body) return false;
    if (!isShown(document.getElementById('screen-main'))) return false;
    const tab = document.querySelector<HTMLElement>('.side-nav .bottom-nav__item--active');
    const active = document.activeElement as HTMLElement | null;
    if (!tab || !isShown(tab) || (active && active.closest && active.closest('.side-nav'))) return false;
    tab.focus({ preventScroll: true });
    if (document.activeElement !== tab) return false;
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    remember(tab);
    return true;
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    document.documentElement.classList.add('remote-nav');
    document.addEventListener('keydown', onSelectInField, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    // Logging in and out swaps the whole screen: start again at its top.
    BeeState.on('change', function (partial) {
      if (partial && 'connected' in partial) window.setTimeout(focusHome, 200);
    });
    BeeState.on('reset', function () { window.setTimeout(focusHome, 200); });
    window.setTimeout(function () {
      focusHome();
      const shown = Number(BeeUtils.storageGet(HINT_KEY, 0)) || 0;
      if (shown < HINT_RUNS) {
        BeeUtils.storageSet(HINT_KEY, shown + 1);
        BeeUtils.showToast(t('remote.hint'), 'info', 10000);
      }
    }, 600);
  }

  function isEnabled() {
    return enabled;
  }

  function init() {
    // The shell's object is injected before the page loads; the short retry
    // only covers it arriving a beat late. No shell, or one that does not
    // say "television": the pad stays off.
    let attempts = 0;
    (function detect() {
      const shell = window.MinibeeAndroid;
      if (shell && typeof shell.isTelevision === 'function') {
        let tv = false;
        try { tv = !!shell.isTelevision(); } catch (_e) { tv = false; }
        if (tv) enable();
      } else if (attempts++ < 10) {
        window.setTimeout(detect, 500);
      }
    })();
  }

  return {
    init: init,
    enable: enable,
    isEnabled: isEnabled,
    remoteKey: remoteKey,
    back: back,
    pickTarget: pickTarget,
    nearestBox: nearestBox,
    selectors: { focusable: FOCUSABLE, clickable: CLICKABLE }
  };
})();

window.BeeRemoteNav = BeeRemoteNav;
