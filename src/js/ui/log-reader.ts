/**
 * Chat log reader - the dialog behind Bee -> About -> Chat logs. The log
 * files on the left, by account and then by kind; the chosen one on the
 * right, read-only, a page at a time, with a search across the whole file.
 * A file can be deleted, or a whole kind at once. It is the Notecards layout
 * in a dialog, without the editing. Which lines make a page, and which of
 * them hold the words searched for, is the core's answer (chat_log_read);
 * this module only paints it.
 */
const BeeLogReader = (function () {
  'use strict';

  const t = BeeI18n.t;

  // The kinds of log file, in the order the list shows them.
  const KINDS = [
    { kind: 'local', label: function () { return t('logs.kindLocal'); } },
    { kind: 'avatars', label: function () { return t('logs.kindAvatars'); } },
    { kind: 'groups', label: function () { return t('logs.kindGroups'); } }
  ];
  // Typing in the search field asks the core once the typing pauses.
  const SEARCH_DELAY_MS = 300;
  // A line made of one letter repeated would otherwise be marked a thousand
  // times over; past this many stretches the rest of it stays plain.
  const MAX_MARKS = 40;
  const TRASH_ICON = 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z';

  type LogFile = { agent: string; kind: string; name: string };
  type LogLine = { n: number; text: string };
  type LogView = { lines: LogLine[]; page: number; pages: number; matched: number; total: number };
  // Where a freshly painted page is scrolled to: one of its ends, or a line.
  type Landing = 'top' | 'bottom' | number | null;

  let files = [];                    // chat_log_list rows: { agent, kind, name, bytes }
  let listState = 'idle';            // 'idle' | 'loading' | 'failed' | 'ready'
  let listSeq = 0;
  let current: LogFile | null = null; // the open file
  let view: LogView | null = null;   // its page on screen
  let query = '';                    // the search that page answers
  let found = 0;                     // the line a search result was opened at, marked on the page
  let reading = false;
  let readError = null;              // what the last read rejected with, until the next read
  let readSeq = 0;                   // a later read wins over an earlier one still on its way
  const deletedListeners = [];

  function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  function dialog() {
    return el<HTMLDialogElement>('log-reader-dialog');
  }

  function formatSize(bytes) {
    const b = Number(bytes) || 0;
    return b >= 1024 * 1024
      ? t('units.mb', { value: (b / (1024 * 1024)).toFixed(1) })
      : t('units.kb', { value: Math.max(1, Math.round(b / 1024)) });
  }

  function isFile(row, file: LogFile | null) {
    return !!row && !!file && String(row.agent || '') === file.agent &&
      row.kind === file.kind && row.name === file.name;
  }

  function rowOf(file: LogFile | null) {
    return files.find(function (row) { return isFile(row, file); }) || null;
  }

  function kindLabel(kind) {
    const entry = KINDS.find(function (k) { return k.kind === kind; });
    return entry ? entry.label() : String(kind || '');
  }

  // What a file reads as, in the list and over its page. The nearby-chat
  // file has one fixed name on disk in every language and reads as its
  // section does. An avatar or group log can carry a bare UUID as its name
  // (written before the name was known): the name cache answers for it when
  // it can - by username, as the other files are named - and is asked to
  // find out when it cannot yet.
  function fileLabel(row) {
    const name = String(row.name || '');
    if (row.kind === 'local') return t('logs.nearbyChatFile');
    if (!BeeUtils.isUuid(name) || typeof BeeTransport === 'undefined') return name;
    if (row.kind === 'avatars') {
      const info = BeeTransport.getCachedNameInfo ? BeeTransport.getCachedNameInfo(name) : null;
      const resolved = info && (info.userName || info.label || info.displayName);
      if (resolved) return String(resolved);
      if (BeeTransport.queueNameResolve && BeeState.gridOnline()) {
        BeeTransport.queueNameResolve(name); // a names-updated event repaints
      }
    } else if (row.kind === 'groups') {
      const group = BeeTransport.getGroupName ? BeeTransport.getGroupName(name) : '';
      if (group) return String(group);
      if (BeeTransport.queueGroupNameResolve && BeeState.gridOnline()) {
        BeeTransport.queueGroupNameResolve(name);
      }
    }
    return name;
  }

  // An account's heading: the avatar's name when the cache knows it, the raw
  // account id otherwise.
  function accountLabel(agent, me) {
    if (!agent) return t('logs.olderShared');
    let label = '';
    if (typeof BeeTransport !== 'undefined' && BeeTransport.getCachedNameInfo) {
      const info = BeeTransport.getCachedNameInfo(agent);
      label = (info && (info.displayName || info.label || info.userName)) || '';
    }
    if (!label && typeof BeeTransport !== 'undefined' && BeeTransport.queueNameResolve && BeeState.gridOnline()) {
      BeeTransport.queueNameResolve(agent); // a names-updated event repaints
    }
    if (agent === me) {
      return label ? t('logs.namedThisAccount', { name: label }) : t('logs.thisAccount');
    }
    return label || agent;
  }

  function icon(d: string) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  // --- the list ---

  function fileRow(row, label) {
    const agent = String(row.agent || '');
    const item = document.createElement('div');
    item.className = 'log-reader__file';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'scripts-list__item log-reader__open' +
      (isFile(row, current) ? ' scripts-list__item--open' : '');
    open.dataset.agent = agent;
    open.dataset.kind = row.kind;
    open.dataset.name = row.name;
    open.title = row.name;
    const name = document.createElement('span');
    name.className = 'log-reader__file-name';
    name.textContent = label;
    const size = document.createElement('span');
    size.className = 'log-reader__file-size';
    size.textContent = formatSize(row.bytes);
    open.appendChild(name);
    open.appendChild(size);
    open.addEventListener('click', function () { openFile(row); });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn log-reader__file-delete';
    del.title = t('logs.delete');
    del.setAttribute('aria-label', t('logs.delete'));
    del.appendChild(icon(TRASH_ICON));
    del.addEventListener('click', function () {
      void deleteLogs(agent, row.kind, row.name, t('logs.theLogFor', { name: row.name }));
    });
    item.appendChild(open);
    item.appendChild(del);
    return item;
  }

  function renderList() {
    const host = el('log-reader-files');
    const status = el('log-reader-status');
    if (!host) return;
    const filter = el<HTMLInputElement>('log-reader-filter');
    const typed = filter ? filter.value.trim() : '';
    const q = typed.toLowerCase();
    const shown = files
      .map(function (row) { return { row: row, label: fileLabel(row) }; })
      .filter(function (f) {
        return !q || f.label.toLowerCase().indexOf(q) !== -1 ||
          String(f.row.name || '').toLowerCase().indexOf(q) !== -1;
      });
    // One section per account ("" marks files from before logs were split per
    // account): the logged-in account first, the shared leftovers last.
    const me = String((BeeState.get().agent || {}).id || '').toLowerCase();
    const agents = [];
    files.forEach(function (row) {
      const a = String(row.agent || '');
      if (agents.indexOf(a) === -1) agents.push(a);
    });
    agents.sort(function (a, b) {
      const rank = function (x) { return x === me ? 0 : (x === '' ? 2 : 1); };
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    const top = host.scrollTop;
    host.innerHTML = '';
    agents.forEach(function (agent) {
      const mine = shown.filter(function (f) { return String(f.row.agent || '') === agent; });
      if (!mine.length) return;
      if (agents.length > 1) {
        const acc = document.createElement('div');
        acc.className = 'log-reader__account';
        acc.textContent = accountLabel(agent, me);
        host.appendChild(acc);
      }
      KINDS.forEach(function (entry) {
        const rows = mine.filter(function (f) { return f.row.kind === entry.kind; });
        if (!rows.length) return;
        const label = entry.label();
        const head = document.createElement('div');
        head.className = 'log-reader__kind';
        const title = document.createElement('span');
        title.className = 'log-reader__kind-name';
        title.textContent = t('logs.kindCount', { kind: label, count: rows.length });
        head.appendChild(title);
        // "Delete all" means the whole kind, so it is only offered while the
        // whole kind is on screen - not beside a filtered handful of it.
        if (!q) {
          const all = document.createElement('button');
          all.type = 'button';
          all.className = 'btn btn--ghost btn--sm';
          all.textContent = t('logs.deleteAll');
          all.addEventListener('click', function () {
            // The section's own label, as written: lowercasing it would mangle
            // "IM" and words in other languages.
            void deleteLogs(agent, entry.kind, null, t('logs.allInSection', { kind: label }));
          });
          head.appendChild(all);
        }
        host.appendChild(head);
        rows.forEach(function (f) { host.appendChild(fileRow(f.row, f.label)); });
      });
    });
    host.scrollTop = top;

    let text = '';
    if (listState === 'loading' && !files.length) text = t('common.loading');
    else if (listState === 'failed') text = t('logs.listUnavailable');
    else if (listState === 'ready' && !files.length) text = t('logs.noneOnDevice');
    else if (listState === 'ready' && !shown.length) text = t('interact.noFilterMatch', { filter: typed });
    if (status) {
      status.textContent = text;
      status.hidden = !text;
    }
  }

  // Moves the "open" mark without rebuilding the list, so the row that was
  // clicked keeps the focus and the list keeps its place.
  function markOpen() {
    const host = el('log-reader-files');
    if (!host) return;
    host.querySelectorAll<HTMLElement>('.log-reader__open').forEach(function (btn) {
      btn.classList.toggle('scripts-list__item--open', isFile(btn.dataset, current));
    });
  }

  async function loadList() {
    const seq = ++listSeq;
    listState = 'loading';
    renderList();
    try {
      const res = await BeeBridge.invoke('chat_log_list');
      if (seq !== listSeq) return;
      files = (res && res.logs) || [];
      listState = 'ready';
    } catch (_e) {
      if (seq !== listSeq) return;
      files = [];
      listState = 'failed';
    }
    // The open log may be among what was just deleted.
    if (current && !rowOf(current)) closeFile();
    renderList();
    paintHead();
  }

  // --- the page ---

  // A line cut into the pieces it is painted from: its leading "[date time]"
  // apart from what was said, and in either the stretches that match the
  // search. The core finds lines by their lowercase form; where lowercasing
  // changes a text's length (a few letters do) the positions no longer line
  // up, and the line is left unmarked rather than marked in the wrong place.
  // Plain arithmetic on strings, kept away from the DOM so the tests can
  // drive it.
  function pieces(text: string, needle: string) {
    const stamp = /^\[[^\]\n]{1,40}\]/.exec(text);
    const stampEnd = stamp ? stamp[0].length : 0;
    const hits: number[][] = [];
    const lower = text.toLowerCase();
    const find = String(needle || '').toLowerCase();
    if (find && lower.length === text.length) {
      let from = 0;
      while (hits.length < MAX_MARKS) {
        const at = lower.indexOf(find, from);
        if (at === -1) break;
        from = at + find.length;
        const last = hits[hits.length - 1];
        if (last && last[1] === at) last[1] = from; // side by side: one stretch
        else hits.push([at, from]);
      }
    }
    const cuts = [0, text.length];
    if (stampEnd) cuts.push(stampEnd);
    hits.forEach(function (h) { cuts.push(h[0], h[1]); });
    const edges = Array.from(new Set(cuts)).sort(function (a, b) { return a - b; });
    const out: { text: string; stamp: boolean; hit: boolean }[] = [];
    let h = 0;
    for (let i = 0; i + 1 < edges.length; i++) {
      const a = edges[i];
      const b = edges[i + 1];
      while (h < hits.length && hits[h][1] <= a) h++;
      out.push({
        text: text.slice(a, b),
        stamp: a < stampEnd,
        hit: h < hits.length && a >= hits[h][0] && b <= hits[h][1]
      });
    }
    return out;
  }

  function fillLine(node: HTMLElement, text: string) {
    pieces(text, query).forEach(function (p) {
      let piece: Node = document.createTextNode(p.text);
      if (p.hit) {
        const mark = document.createElement('mark');
        mark.className = 'log-reader__mark';
        mark.appendChild(piece);
        piece = mark;
      }
      if (p.stamp) {
        const stamp = document.createElement('span');
        stamp.className = 'log-reader__stamp';
        stamp.appendChild(piece);
        piece = stamp;
      }
      node.appendChild(piece);
    });
  }

  // A line of the log as it stands; while a search is on, a result that
  // opens the log at that line.
  function lineNode(line: LogLine) {
    if (query) {
      const hit = document.createElement('button');
      hit.type = 'button';
      hit.className = 'log-reader__line log-reader__line--hit';
      hit.title = t('logs.showInContext');
      fillLine(hit, line.text);
      hit.addEventListener('click', function () { showInPlace(line.n); });
      return hit;
    }
    const row = document.createElement('div');
    row.className = 'log-reader__line' + (line.n === found ? ' log-reader__line--found' : '');
    row.dataset.line = String(line.n);
    fillLine(row, line.text);
    return row;
  }

  function note(host: HTMLElement, text: string) {
    const p = document.createElement('p');
    p.className = 'log-reader__note';
    p.textContent = text;
    host.appendChild(p);
  }

  // The name over the page, the line under it, and whether a page is open.
  function paintHead() {
    const open = !!current;
    const head = el('log-reader-head');
    const body = el('log-reader-body');
    const empty = el('log-reader-empty');
    if (head) head.hidden = !open;
    if (body) body.hidden = !open;
    if (empty) empty.hidden = open;
    if (!current) return;
    const row = rowOf(current);
    const name = el('log-reader-name');
    if (name) {
      name.textContent = row ? fileLabel(row) : current.name;
      name.title = current.name;
    }
    const state = el('log-reader-state');
    if (!state) return;
    let line = '';
    if (reading) line = t('common.loading');
    else if (query && view) line = t('search.resultCount', { count: view.matched });
    else if (row) line = kindLabel(current.kind) + ' \u00b7 ' + formatSize(row.bytes);
    state.textContent = line;
  }

  function paintPager() {
    const pages = view ? view.pages : 0;
    const page = view ? view.page : 0;
    const pager = el('log-reader-pager');
    if (pager) pager.hidden = pages < 2;
    const label = el('log-reader-page');
    if (label) label.textContent = pages ? t('logs.pageOf', { page: page, pages: pages }) : '';
    const set = function (id: string, enabled: boolean) {
      const btn = el<HTMLButtonElement>(id);
      if (btn) btn.disabled = !enabled || reading;
    };
    set('log-reader-first', page > 1);
    set('log-reader-prev', page > 1);
    set('log-reader-next', page < pages);
    set('log-reader-last', page < pages);
  }

  function renderPage(land: Landing) {
    paintHead();
    paintPager();
    const host = el('log-reader-lines');
    if (!host) return;
    const top = host.scrollTop;
    host.innerHTML = '';
    if (readError) {
      note(host, BeeUtils.errText(readError) || t('scripts.statusLoadFailed'));
    } else if (view && !view.lines.length) {
      note(host, query ? t('interact.noFilterMatch', { filter: query }) : t('logs.emptyLog'));
    } else if (view) {
      view.lines.forEach(function (line) { host.appendChild(lineNode(line)); });
    }
    if (land === 'bottom') {
      host.scrollTop = host.scrollHeight;
    } else if (land === 'top') {
      host.scrollTop = 0;
    } else if (typeof land === 'number') {
      const row = host.querySelector<HTMLElement>('[data-line="' + land + '"]');
      if (row) {
        const gap = row.getBoundingClientRect().top - host.getBoundingClientRect().top;
        host.scrollTop += gap - Math.max(0, (host.clientHeight - row.offsetHeight) / 2);
      }
    } else {
      host.scrollTop = top; // the same page painted again (a language switch)
    }
  }

  // Asks the core for a page of the open file: `want.page` by number,
  // `want.around` the page a line is on, neither for the newest one.
  async function read(want: { page?: number; around?: number }, land: Landing) {
    if (!current) return;
    const file = current;
    const seq = ++readSeq;
    reading = true;
    readError = null;
    paintHead();
    paintPager();
    try {
      const res = await BeeBridge.invoke('chat_log_read', {
        agent: file.agent,
        kind: file.kind,
        name: file.name,
        query: query || null,
        page: want.page || null,
        around: want.around || null
      });
      if (seq !== readSeq) return;
      view = {
        lines: Array.isArray(res && res.lines) ? res.lines : [],
        page: Number(res && res.page) || 0,
        pages: Number(res && res.pages) || 0,
        matched: Number(res && res.matched) || 0,
        total: Number(res && res.total) || 0
      };
    } catch (err) {
      if (seq !== readSeq) return;
      view = null;
      readError = err || new Error('');
    }
    reading = false;
    renderPage(land);
  }

  // On a narrow screen one pane shows at a time; the class is the switch the
  // Scripts and Notecards tabs use for the same thing.
  function showPane(open: boolean) {
    const layout = el('log-reader-layout');
    if (layout) layout.classList.toggle('panel--scripts--editor-open', open);
  }

  function openFile(row) {
    current = { agent: String(row.agent || ''), kind: String(row.kind || ''), name: String(row.name || '') };
    view = null;
    query = '';
    found = 0;
    readError = null;
    const search = el<HTMLInputElement>('log-reader-search');
    if (search) search.value = '';
    markOpen();
    showPane(true);
    renderPage('top');
    // A log opens where a conversation is picked up: at its newest lines.
    void read({}, 'bottom');
  }

  function closeFile() {
    current = null;
    view = null;
    query = '';
    found = 0;
    reading = false;
    readError = null;
    readSeq++;
    showPane(false);
    markOpen();
    // The page goes with the file: nothing of a closed (or deleted) log is
    // left standing behind the hint.
    renderPage('top');
  }

  function applySearch() {
    if (!current) return;
    const search = el<HTMLInputElement>('log-reader-search');
    const next = search ? search.value.trim() : '';
    if (next === query) return;
    query = next;
    found = 0;
    void read({}, 'bottom');
  }

  // A search result opened where it stands: the search is put away and the
  // log shows the page that line is on, with the line marked.
  function showInPlace(n: number) {
    const search = el<HTMLInputElement>('log-reader-search');
    if (search) search.value = '';
    query = '';
    found = n;
    void read({ around: n }, n);
  }

  // --- deleting ---

  async function deleteLogs(agent, kind, name, what) {
    const ok = await BeeUtils.confirm({
      title: t('logs.deleteTitle'),
      message: t('logs.deleteMessage', { what: what }),
      confirmLabel: t('logs.delete'),
      danger: true
    });
    if (!ok) return;
    try {
      await BeeBridge.invoke('chat_log_delete', { agent: agent || '', kind: kind, name: name || null });
      BeeUtils.showToast(t('logs.deleted'), 'success');
    } catch (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || t('logs.deleteFailed'), 'error');
    }
    await loadList();
    deletedListeners.forEach(function (fn) {
      try { fn(); } catch (_e) { /* a listener's trouble is its own */ }
    });
  }

  // --- the dialog ---

  function open() {
    const d = dialog();
    if (!d || typeof d.showModal !== 'function') return;
    closeFile();
    files = [];
    listState = 'idle';
    const filter = el<HTMLInputElement>('log-reader-filter');
    if (filter) filter.value = '';
    renderList();
    if (!d.open) d.showModal();
    void loadList();
  }

  function isOpen() {
    const d = dialog();
    return !!(d && d.open);
  }

  function init() {
    const close = el('log-reader-close');
    if (close) {
      close.addEventListener('click', function () {
        const d = dialog();
        if (d && d.open) BeeUtils.dismissDialog(d);
      });
    }
    const filter = el('log-reader-filter');
    if (filter) filter.addEventListener('input', renderList);
    const back = el('log-reader-back');
    if (back) back.addEventListener('click', function () { showPane(false); });
    const del = el('log-reader-delete');
    if (del) {
      del.addEventListener('click', function () {
        if (!current) return;
        void deleteLogs(current.agent, current.kind, current.name, t('logs.theLogFor', { name: current.name }));
      });
    }
    const search = el('log-reader-search');
    if (search) {
      search.addEventListener('input', BeeUtils.debounce(applySearch, SEARCH_DELAY_MS));
      search.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        applySearch();
      });
    }
    // Going back in time lands at the end of the older page - the lines just
    // before the ones left - and going forward at the start of the newer one,
    // so the reading carries on across the page edge either way.
    const step = function (id: string, go: () => void) {
      const btn = el(id);
      if (btn) btn.addEventListener('click', function () { if (view && !reading) go(); });
    };
    step('log-reader-first', function () { void read({ page: 1 }, 'top'); });
    step('log-reader-prev', function () { void read({ page: view.page - 1 }, 'bottom'); });
    step('log-reader-next', function () { void read({ page: view.page + 1 }, 'top'); });
    step('log-reader-last', function () { void read({}, 'bottom'); });

    // UUID-named files resolve to people and groups as the names come in.
    if (typeof BeeTransport !== 'undefined' && BeeTransport.on) {
      const repaint = function () {
        if (!isOpen()) return;
        renderList();
        paintHead();
      };
      BeeTransport.on('names-updated', repaint);
      BeeTransport.on('group-names', repaint);
    }
    // A language switch repaints what was painted from data already fetched.
    BeeI18n.onChange(function () {
      if (!isOpen()) return;
      renderList();
      renderPage(null);
    });
  }

  return {
    init: init,
    open: open,
    // Called after files were deleted, so a figure kept elsewhere (the About
    // tab's) can be fetched again.
    onDeleted: function (fn: () => void) { if (typeof fn === 'function') deletedListeners.push(fn); },
    formatSize: formatSize,
    pieces: pieces
  };
})();
