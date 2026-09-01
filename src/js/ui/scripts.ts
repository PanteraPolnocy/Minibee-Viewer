/**
 * Scripts tab - browse the inventory's Scripts folder, read a script's source,
 * edit it with LSL highlighting and completion, and save (which the sim
 * compiles). The protocol work all lives in the Rust core; this renders.
 */
const BeeScripts = (function () {
  'use strict';

  const SOURCE_TIMEOUT_MS = 30000;

  let rows = [];
  let loaded = false;
  let loading = false;
  let loadError = '';
  // The grid's LSL language data (functions/events/constants/types/controls).
  let lang = null;
  let langSets = null;
  let langLoading = false;
  let current = null; // { itemId, assetId, creatorId, lastOwnerId, name, savedText, dirty }
  let saving = false;
  let openSeq = 0;
  const sourceWaiters = new Map(); // itemId -> { resolve, reject, timer }
  let createWaiter = null; // { resolve, reject, timer } for the pending New Script

  function sortRows() {
    rows.sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    });
  }

  function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  function isPhone() {
    return window.matchMedia('(max-width: 640px)').matches;
  }

  // --- list ---

  function renderList() {
    const list = el('scripts-items');
    const status = el('scripts-status');
    if (!list) return;
    const filter = el<HTMLInputElement>('scripts-filter');
    const q = filter ? filter.value.trim().toLowerCase() : '';
    const shown = rows.filter(function (r) {
      return !q || String(r.name || '').toLowerCase().indexOf(q) !== -1;
    });
    list.innerHTML = '';
    shown.forEach(function (r) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scripts-list__item' +
        (current && current.itemId === r.itemId ? ' scripts-list__item--open' : '');
      btn.dataset.itemId = r.itemId;
      // Right-click / long-press: the shared context menu offers this copy.
      btn.dataset.copy = r.itemId;
      btn.dataset.copyLabel = 'Copy item UUID';
      btn.textContent = r.name || 'Unnamed script';
      btn.title = btn.textContent;
      li.appendChild(btn);
      list.appendChild(li);
    });

    let text = '';
    if (loading) text = 'Loading scripts...';
    else if (loadError) text = loadError;
    else if (loaded && !rows.length) text = 'No scripts yet.';
    else if (loaded && !shown.length) text = 'No scripts match.';
    else if (!loaded && !BeeState.gridOnline()) text = 'Log in to see your scripts.';
    if (status) {
      status.textContent = text;
      status.hidden = !text;
    }
  }

  async function load(force?: boolean) {
    if (loading || (loaded && !force)) return;
    if (!BeeState.gridOnline()) return;
    loading = true;
    loadError = '';
    renderList();
    try {
      const fetched = await BeeTransport.listScripts();
      rows = fetched || [];
      loaded = true;
    } catch (err) {
      loadError = BeeUtils.errText(err) || 'Could not load scripts.';
    } finally {
      loading = false;
      renderList();
    }
  }

  // --- language data ---

  async function loadLanguage() {
    if (lang || langLoading || !BeeState.gridOnline()) return;
    langLoading = true;
    try {
      const data = await BeeTransport.lslLanguage();
      if (data && data.ok) {
        lang = data;
        langSets = {
          types: new Set(data.types || []),
          controls: new Set(data.controls || []),
          functions: new Map((data.functions || []).map(function (f) { return [f.name, f]; })),
          events: new Map((data.events || []).map(function (e) { return [e.name, e]; })),
          constants: new Map((data.constants || []).map(function (c) { return [c.name, c]; }))
        };
        if (current) refreshHighlight();
      }
    } catch (_e) {
      // Highlighting degrades to comments/strings/numbers only.
    } finally {
      langLoading = false;
    }
  }

  // --- editor: highlighting ---

  const TOKEN_RE = /(\/\/[^\n]*)|(\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*(?:"|$))|(\b(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)\b)|([A-Za-z_][A-Za-z0-9_]*)/g;

  function wordClass(word) {
    if (!langSets) return '';
    if (langSets.types.has(word)) return 'lsl-typ';
    if (langSets.controls.has(word) || word === 'state_entry') return 'lsl-kw';
    if (langSets.functions.has(word)) return 'lsl-fn';
    if (langSets.events.has(word)) return 'lsl-ev';
    if (langSets.constants.has(word)) return 'lsl-const';
    return '';
  }

  function highlightCore(text) {
    let out = '';
    let last = 0;
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      out += BeeUtils.escapeHtml(text.slice(last, m.index));
      const tok = m[0];
      let cls = '';
      if (m[1] || m[2]) cls = 'lsl-cmt';
      else if (m[3]) cls = 'lsl-str';
      else if (m[4]) cls = 'lsl-num';
      else if (m[5]) cls = wordClass(tok);
      out += cls
        ? '<span class="' + cls + '">' + BeeUtils.escapeHtml(tok) + '</span>'
        : BeeUtils.escapeHtml(tok);
      last = m.index + tok.length;
    }
    return out + BeeUtils.escapeHtml(text.slice(last));
  }

  // The current find match, marked in the overlay so it stays visible while
  // focus sits in the find box (an unfocused textarea hides its selection).
  let findMark = null; // { start, end }

  function highlightHtml(text) {
    let out;
    if (findMark && findMark.start < findMark.end && findMark.end <= text.length) {
      // Highlight the three segments separately; a token cut by the mark
      // boundary loses its color, which is harmless and brief.
      out = highlightCore(text.slice(0, findMark.start)) +
        '<span class="lsl-mark">' + highlightCore(text.slice(findMark.start, findMark.end)) + '</span>' +
        highlightCore(text.slice(findMark.end));
    } else {
      out = highlightCore(text);
    }
    // The trailing newline keeps the overlay exactly as tall as the textarea.
    return out + '\n';
  }

  // --- editor: local symbols (variables, functions, states in this source) ---

  let localSyms = { vars: new Map(), fns: new Map(), states: [] };

  function isBuiltinWord(word) {
    return !!langSets && (
      langSets.functions.has(word) || langSets.events.has(word) ||
      langSets.constants.has(word) || langSets.types.has(word) ||
      langSets.controls.has(word)
    );
  }

  const LSL_TYPE_WORDS = 'integer|float|string|key|vector|rotation|quaternion|list';

  function scanLocals(text) {
    const vars = new Map();
    const fns = new Map();
    const states = [];
    let m;
    // Declarations and parameters share one shape: "<type> <name>".
    const declRe = new RegExp('\\b(' + LSL_TYPE_WORDS + ')\\s+([A-Za-z_]\\w*)', 'g');
    while ((m = declRe.exec(text)) !== null) {
      if (!isBuiltinWord(m[2])) vars.set(m[2], m[1]);
    }
    // A user function: optional return type, a name that isn't a builtin or
    // event, an argument list, and an opening brace.
    const fnRe = new RegExp(
      '(?:^|\\n)[ \\t]*(?:(' + LSL_TYPE_WORDS + ')[ \\t]+)?([A-Za-z_]\\w*)[ \\t]*\\(([^()\\n]*)\\)[ \\t]*(?:\\n[ \\t]*)?\\{',
      'g'
    );
    while ((m = fnRe.exec(text)) !== null) {
      const name = m[2];
      if (isBuiltinWord(name) || name === 'default') continue;
      fns.set(name, { ret: m[1] || '', argsText: m[3].trim() });
    }
    const stateRe = /(?:^|\n)[ \t]*state[ \t]+([A-Za-z_]\w*)/g;
    while ((m = stateRe.exec(text)) !== null) {
      if (states.indexOf(m[1]) === -1) states.push(m[1]);
    }
    localSyms = { vars: vars, fns: fns, states: states };
  }

  function localFnSignature(name, def) {
    return (def.ret ? def.ret + ' ' : '') + name + '(' + def.argsText + ')';
  }

  let highlightQueued = false;
  let gutterLines = 0;
  function refreshHighlight() {
    if (highlightQueued) return;
    highlightQueued = true;
    requestAnimationFrame(function () {
      highlightQueued = false;
      const input = el<HTMLTextAreaElement>('script-input');
      const pre = el('script-highlight');
      if (!input || !pre) return;
      pre.innerHTML = highlightHtml(input.value);
      scanLocals(input.value);
      const lines = input.value.split('\n').length;
      if (lines !== gutterLines) {
        gutterLines = lines;
        const gutter = el('script-gutter');
        if (gutter) {
          gutter.textContent = Array.from({ length: lines }, function (_, i) { return i + 1; }).join('\n') + '\n';
        }
      }
      syncScroll();
    });
  }

  function syncScroll() {
    const input = el<HTMLTextAreaElement>('script-input');
    const pre = el('script-highlight');
    const gutter = el('script-gutter');
    if (!input || !pre) return;
    pre.scrollTop = input.scrollTop;
    pre.scrollLeft = input.scrollLeft;
    if (gutter) gutter.scrollTop = input.scrollTop;
  }

  function lineHeightOf(input) {
    return parseFloat(getComputedStyle(input).lineHeight) || 19;
  }

  // Scroll the textarea so `offset` sits mid-view, without moving focus.
  function revealOffset(offset) {
    const input = el<HTMLTextAreaElement>('script-input');
    if (!input) return;
    const head = input.value.slice(0, offset);
    const line = head.split('\n').length - 1;
    const column = offset - (head.lastIndexOf('\n') + 1);
    input.scrollTop = Math.max(0, line * lineHeightOf(input) - input.clientHeight / 2);
    // Monospace 13px runs ~7.8px per character; near enough to center on.
    input.scrollLeft = Math.max(0, column * 7.8 - input.clientWidth / 2);
    syncScroll();
  }

  // --- editor: undo/redo ---
  // Our own stack: the programmatic edits (Tab indent, completion, format)
  // never enter the native textarea history, so Ctrl+Z has to be ours to be
  // able to step back over them.

  const UNDO_MAX = 200;
  const UNDO_COALESCE_MS = 600;
  let undoStack = [];
  let redoStack = [];
  let undoLastAt = 0;

  function editorSnapshot(input) {
    return { text: input.value, start: input.selectionStart, end: input.selectionEnd };
  }

  function clearUndo() {
    undoStack = [];
    redoStack = [];
    undoLastAt = 0;
  }

  // Record the state BEFORE a change. A typing burst coalesces into one step;
  // `force` (a programmatic edit) always records its own step.
  function pushUndo(force?) {
    const input = el<HTMLTextAreaElement>('script-input');
    if (!input) return;
    redoStack = [];
    const now = Date.now();
    const top = undoStack[undoStack.length - 1];
    if (top && top.text === input.value) {
      undoLastAt = now;
      return;
    }
    if (!force && top !== undefined && now - undoLastAt < UNDO_COALESCE_MS) return;
    undoStack.push(editorSnapshot(input));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    undoLastAt = now;
  }

  function dropFindMark() {
    if (!findMark) return;
    findMark = null;
    findMatches = [];
    findIndex = -1;
    updateFindCount();
  }

  // Dirty follows the text, so undoing back to the saved source reads Saved.
  function recomputeDirty() {
    const input = el<HTMLTextAreaElement>('script-input');
    if (!current || !input) return;
    if (input.value === current.savedText) {
      current.dirty = false;
      setStatus('Saved');
      const save = el<HTMLButtonElement>('script-save');
      if (save) save.disabled = true;
    } else {
      markDirty();
    }
  }

  function applyEditorSnapshot(snap) {
    const input = el<HTMLTextAreaElement>('script-input');
    if (!input) return;
    input.value = snap.text;
    input.setSelectionRange(snap.start, snap.end);
    input.focus();
    dropFindMark();
    recomputeDirty();
    hideCompletion();
    refreshHighlight();
    refreshSignature();
  }

  function undoEdit() {
    const input = el<HTMLTextAreaElement>('script-input');
    if (!input || input.disabled || !undoStack.length) return;
    redoStack.push(editorSnapshot(input));
    applyEditorSnapshot(undoStack.pop());
    undoLastAt = 0;
  }

  function redoEdit() {
    const input = el<HTMLTextAreaElement>('script-input');
    if (!input || input.disabled || !redoStack.length) return;
    undoStack.push(editorSnapshot(input));
    applyEditorSnapshot(redoStack.pop());
    undoLastAt = 0;
  }

  // --- editor: find / go-to-line ---

  let findMatches = [];
  let findIndex = -1;

  function updateFindCount() {
    const count = el('script-find-count');
    if (!count) return;
    count.textContent = findMatches.length
      ? (findIndex + 1) + '/' + findMatches.length
      : (el<HTMLInputElement>('script-find-input') || { value: '' }).value ? '0/0' : '';
  }

  function clearFindMark() {
    if (!findMark) return;
    findMark = null;
    refreshHighlight();
  }

  function runFind(dir) {
    const input = el<HTMLTextAreaElement>('script-input');
    const box = el<HTMLInputElement>('script-find-input');
    if (!input || !box) return;
    const q = box.value;
    // ":123" jumps straight to that line, marking it whole.
    const goto = q.match(/^:(\d+)$/);
    if (goto) {
      const lines = input.value.split('\n');
      const line = Math.min(Math.max(1, parseInt(goto[1], 10)), lines.length) - 1;
      let start = 0;
      for (let i = 0; i < line; i++) start += lines[i].length + 1;
      findMatches = [];
      findIndex = -1;
      findMark = { start: start, end: start + lines[line].length };
      refreshHighlight();
      revealOffset(start);
      updateFindCount();
      return;
    }
    findMatches = [];
    if (q) {
      const hay = input.value.toLowerCase();
      const needle = q.toLowerCase();
      let at = hay.indexOf(needle);
      while (at !== -1 && findMatches.length < 5000) {
        findMatches.push(at);
        at = hay.indexOf(needle, at + Math.max(1, needle.length));
      }
    }
    if (!findMatches.length) {
      findIndex = -1;
      clearFindMark();
      updateFindCount();
      return;
    }
    findIndex = dir === 0
      ? 0
      : (findIndex + dir + findMatches.length) % findMatches.length;
    const start = findMatches[findIndex];
    findMark = { start: start, end: start + q.length };
    refreshHighlight();
    revealOffset(start);
    updateFindCount();
  }

  function openFind() {
    const bar = el('script-find');
    const box = el<HTMLInputElement>('script-find-input');
    const input = el<HTMLTextAreaElement>('script-input');
    if (!bar || !box) return;
    bar.hidden = false;
    if (input && input.selectionStart !== input.selectionEnd) {
      const sel = input.value.slice(input.selectionStart, input.selectionEnd);
      if (sel.length < 200 && sel.indexOf('\n') === -1) box.value = sel;
    }
    box.focus();
    box.select();
    findIndex = -1;
    runFind(0);
  }

  function closeFind() {
    const bar = el('script-find');
    if (bar) bar.hidden = true;
    findMatches = [];
    findIndex = -1;
    clearFindMark();
    const input = el<HTMLTextAreaElement>('script-input');
    if (input && !input.disabled) input.focus();
  }

  // --- editor: signature help (caret-driven, so it works on touch too) ---

  // The innermost unclosed call around the caret, plus which argument the
  // caret sits in. Scans a bounded window backwards, tracking paren depth.
  function enclosingCall(text, caret) {
    const stop = Math.max(0, caret - 800);
    let depth = 0;
    let commas = 0;
    let i = caret - 1;
    for (; i >= stop; i--) {
      const ch = text[i];
      if (ch === ')') depth++;
      else if (ch === '(') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) commas++;
      else if ((ch === ';' || ch === '{' || ch === '}') && depth === 0) return null;
    }
    if (i < stop || i < 0 || text[i] !== '(') return null;
    const head = text.slice(Math.max(0, i - 64), i);
    const m = head.match(/([A-Za-z_]\w*)\s*$/);
    return m ? { name: m[1], argIndex: commas } : null;
  }

  function refreshSignature() {
    const bar = el('script-signature');
    const input = el<HTMLTextAreaElement>('script-input');
    if (!bar || !input) return;
    const call = current && !input.disabled ? enclosingCall(input.value, input.selectionStart) : null;
    let html = '';
    let tooltip = '';
    if (call && langSets) {
      const def = langSets.functions.get(call.name) || langSets.events.get(call.name);
      if (def) {
        const args = (def.args || []).map(function (a, i) {
          const piece = BeeUtils.escapeHtml(a.type + ' ' + a.name);
          return i === call.argIndex ? '<b>' + piece + '</b>' : piece;
        });
        html = (def.return ? BeeUtils.escapeHtml(def.return) + ' ' : '') +
          '<span class="sig-name">' + BeeUtils.escapeHtml(call.name) + '</span>(' + args.join(', ') + ')';
        tooltip = def.tooltip || '';
      } else if (localSyms.fns.has(call.name)) {
        html = '<span class="sig-name">' + BeeUtils.escapeHtml(call.name) + '</span>(' +
          BeeUtils.escapeHtml(localSyms.fns.get(call.name).argsText) + ')';
      }
    }
    bar.hidden = !html;
    bar.innerHTML = html;
    bar.title = tooltip;
  }

  // --- editor: completion ---

  function currentWord(input) {
    const head = input.value.slice(0, input.selectionStart);
    const m = head.match(/[A-Za-z_][A-Za-z0-9_]*$/);
    return m ? m[0] : '';
  }

  function signatureText(f) {
    const args = (f.args || []).map(function (a) { return a.type + ' ' + a.name; }).join(', ');
    return (f.return ? f.return + ' ' : '') + f.name + '(' + args + ')';
  }

  function completionCandidates(prefix) {
    if (prefix.length < 2) return [];
    const p = prefix.toLowerCase();
    const out = [];
    const push = function (name, kind, detail) {
      if (out.length < 8 && name.toLowerCase().indexOf(p) === 0 && name !== prefix) {
        out.push({ name: name, kind: kind, detail: detail });
      }
    };
    // This script's own symbols come first: they're what's most likely meant.
    localSyms.fns.forEach(function (def, name) { push(name, 'fn', localFnSignature(name, def)); });
    localSyms.vars.forEach(function (type, name) { push(name, 'var', type); });
    localSyms.states.forEach(function (name) { push(name, 'state', 'state'); });
    if (!lang) return out;
    (lang.functions || []).forEach(function (f) { push(f.name, 'fn', signatureText(f)); });
    (lang.constants || []).forEach(function (c) { push(c.name, 'const', (c.type || '') + (c.value ? ' = ' + c.value : '')); });
    (lang.events || []).forEach(function (e) { push(e.name, 'ev', signatureText(e)); });
    (lang.types || []).forEach(function (t) { push(t, 'typ', 'type'); });
    (lang.controls || []).forEach(function (k) { push(k, 'kw', 'keyword'); });
    return out;
  }

  function hideCompletion() {
    const bar = el('script-complete');
    if (bar) {
      bar.hidden = true;
      bar.innerHTML = '';
    }
  }

  function applyCompletion(name) {
    const input = el<HTMLTextAreaElement>('script-input');
    if (!input) return;
    const prefix = currentWord(input);
    if (!prefix) return;
    const start = input.selectionStart - prefix.length;
    const fn = langSets && langSets.functions.get(name);
    const localFn = localSyms.fns.get(name);
    const callable = !!(fn || localFn);
    const hasArgs = fn ? (fn.args || []).length > 0 : !!(localFn && localFn.argsText);
    const insert = callable ? name + '()' : name;
    pushUndo(true);
    input.setRangeText(insert, start, input.selectionStart, 'end');
    if (callable && hasArgs) {
      // Land the caret between the parentheses, ready for the arguments.
      input.setSelectionRange(input.selectionStart - 1, input.selectionStart - 1);
    }
    input.focus();
    markDirty();
    refreshHighlight();
    refreshSignature();
    hideCompletion();
  }

  function refreshCompletion() {
    const input = el<HTMLTextAreaElement>('script-input');
    const bar = el('script-complete');
    if (!input || !bar) return;
    const prefix = currentWord(input);
    const items = completionCandidates(prefix);
    if (!items.length) {
      hideCompletion();
      return;
    }
    bar.innerHTML = '';
    items.forEach(function (item, i) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'script-complete__item' + (i === 0 ? ' script-complete__item--first' : '');
      btn.innerHTML = '<span class="script-complete__name">' + BeeUtils.escapeHtml(item.name) + '</span>' +
        '<span class="script-complete__detail">' + BeeUtils.escapeHtml(item.detail || '') + '</span>';
      btn.title = item.detail || item.name;
      // mousedown, so the textarea keeps focus and the selection survives.
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault();
        applyCompletion(item.name);
      });
      bar.appendChild(btn);
    });
    bar.hidden = false;
  }

  // --- editor: state ---

  function setStatus(text, kind?) {
    const state = el('script-state');
    if (!state) return;
    state.textContent = text || '';
    state.className = 'script-editor__state' + (kind ? ' script-editor__state--' + kind : '');
  }

  function markDirty() {
    if (!current || current.dirty) return;
    current.dirty = true;
    setStatus('Modified', 'dirty');
    const save = el<HTMLButtonElement>('script-save');
    if (save) save.disabled = false;
  }

  function renderDiagnostics(diags) {
    const box = el('script-diagnostics');
    if (!box) return;
    box.innerHTML = '';
    if (!diags || !diags.length) {
      box.hidden = true;
      return;
    }
    diags.forEach(function (d) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'script-diag';
      const hasPos = typeof d.line === 'number';
      // The compiler reports 0-based positions; people count from 1.
      row.textContent = (hasPos ? '(' + (d.line + 1) + ', ' + (d.column + 1) + ') ' : '') + (d.text || '');
      if (hasPos) {
        row.addEventListener('click', function () { jumpTo(d.line, d.column); });
      } else {
        row.disabled = true;
      }
      box.appendChild(row);
    });
    box.hidden = false;
  }

  function jumpTo(line, column) {
    const input = el<HTMLTextAreaElement>('script-input');
    if (!input) return;
    const lines = input.value.split('\n');
    let offset = 0;
    for (let i = 0; i < line && i < lines.length; i++) offset += lines[i].length + 1;
    offset += Math.min(column, (lines[line] || '').length);
    input.focus();
    input.setSelectionRange(offset, offset);
    revealOffset(offset);
  }

  // The small per-item menu behind the copy button: creator and last-owner
  // profiles plus the UUID copies. Shared with the notecards tab.
  function openItemMenu(anchor, item) {
    const menu = el('context-menu');
    if (!menu) return;
    menu.innerHTML = '';

    function knownId(id) {
      const s = String(id || '');
      return s && !/^0+$/.test(s.replace(/-/g, '')) ? s : '';
    }

    function profileEntry(label, id) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (id && typeof BeeProfile !== 'undefined' && BeeProfile.openAvatar) {
        btn.addEventListener('click', function () {
          menu.hidden = true;
          BeeProfile.openAvatar(id);
        });
      } else {
        btn.disabled = true;
      }
      menu.appendChild(btn);
    }

    function copyEntry(label, value) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (!value) {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', function () {
          menu.hidden = true;
          if (!navigator.clipboard) return;
          navigator.clipboard.writeText(value).then(function () {
            BeeUtils.showToast(label.replace('Copy ', '') + ' copied', 'success');
          }).catch(function () {});
        });
      }
      menu.appendChild(btn);
    }

    const creator = knownId(item.creatorId);
    const lastOwner = knownId(item.lastOwnerId);
    profileEntry('Creator profile', creator);
    profileEntry('Last owner profile', lastOwner);
    copyEntry('Copy item UUID', item.itemId);
    copyEntry('Copy creator UUID', creator);
    copyEntry('Copy last owner UUID', lastOwner);
    menu.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const mrect = menu.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(rect.left, window.innerWidth - mrect.width - 8)) + 'px';
    menu.style.top = Math.max(0, Math.min(rect.bottom + 4, window.innerHeight - mrect.height - 8)) + 'px';
  }

  function setEditorOpen(open) {
    const panel = el('panel-scripts');
    if (panel) panel.classList.toggle('panel--scripts--editor-open', open);
    const body = el('script-editor-body');
    const empty = el('script-editor-empty');
    if (body) body.hidden = !open;
    if (empty) empty.hidden = open;
  }

  function waitForSource(itemId): Promise<string> {
    return new Promise<string>(function (resolve, reject) {
      const existing = sourceWaiters.get(itemId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.reject(new Error('Superseded'));
      }
      const timer = setTimeout(function () {
        sourceWaiters.delete(itemId);
        reject(new Error('The script download timed out.'));
      }, SOURCE_TIMEOUT_MS);
      sourceWaiters.set(itemId, { resolve: resolve, reject: reject, timer: timer });
    });
  }

  async function createNew() {
    if (!BeeState.gridOnline()) return;
    const name = await BeeUtils.prompt({
      title: 'New script',
      message: 'Name for the new script:',
      confirmLabel: 'Create',
      value: 'New Script'
    });
    if (name === null || !name.trim()) return;
    try {
      const wait = new Promise<any>(function (resolve, reject) {
        if (createWaiter) {
          clearTimeout(createWaiter.timer);
          createWaiter.reject(new Error('Superseded'));
        }
        const timer = setTimeout(function () {
          createWaiter = null;
          reject(new Error('The sim did not confirm the new script.'));
        }, 15000);
        createWaiter = { resolve: resolve, reject: reject, timer: timer };
      });
      await BeeTransport.createScript(name.trim());
      const created = await wait;
      const agent = BeeState.get().agent;
      const row = {
        itemId: created.itemId,
        assetId: created.assetId || '',
        creatorId: (agent && agent.id) || '',
        lastOwnerId: (agent && agent.id) || '',
        name: created.name || name.trim()
      };
      rows = rows.filter(function (r) { return r.itemId !== row.itemId; });
      rows.push(row);
      sortRows();
      renderList();
      BeeUtils.showToast('Script created.', 'success');
      open(row);
    } catch (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || 'Could not create the script.', 'error');
    }
  }

  // Re-indent the whole source through the Rust formatter. One undo step.
  async function formatCurrent() {
    const input = el<HTMLTextAreaElement>('script-input');
    if (!current || !input || input.disabled) return;
    try {
      const res = await BeeTransport.formatLsl(input.value);
      if (!res || !res.ok || typeof res.text !== 'string') return;
      if (res.text === input.value) {
        BeeUtils.showToast('Already tidy.', 'success');
        return;
      }
      pushUndo(true);
      // Keep the caret on the same line; columns shift with the re-indent.
      const line = input.value.slice(0, input.selectionStart).split('\n').length - 1;
      input.value = res.text;
      const lines = res.text.split('\n');
      let offset = 0;
      for (let i = 0; i < line && i < lines.length; i++) offset += lines[i].length + 1;
      input.setSelectionRange(offset, offset);
      dropFindMark();
      recomputeDirty();
      refreshHighlight();
      refreshSignature();
      revealOffset(offset);
      BeeUtils.showToast('Script formatted.', 'success');
    } catch (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || 'Could not format the script.', 'error');
    }
  }

  async function renameCurrent() {
    if (!current) return;
    const name = await BeeUtils.prompt({
      title: 'Rename script',
      message: 'New name:',
      confirmLabel: 'Rename',
      value: current.name || ''
    });
    if (name === null || !name.trim() || name.trim() === current.name) return;
    try {
      const res = await BeeTransport.renameScript(current.itemId, name.trim());
      const finalName = (res && res.name) || name.trim();
      current.name = finalName;
      const nameEl = el('script-name');
      if (nameEl) nameEl.textContent = finalName;
      const row = rows.find(function (r) { return r.itemId === current.itemId; });
      if (row) row.name = finalName;
      sortRows();
      renderList();
      BeeUtils.showToast('Script renamed.', 'success');
    } catch (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || 'Could not rename the script.', 'error');
    }
  }

  async function open(row) {
    if (current && current.dirty) {
      const ok = await BeeUtils.confirm({
        title: 'Discard changes?',
        message: '"' + (current.name || 'This script') + '" has unsaved changes.',
        confirmLabel: 'Discard',
        danger: true
      });
      if (!ok) return;
    }
    const seq = ++openSeq;
    current = { itemId: row.itemId, assetId: row.assetId, creatorId: row.creatorId || '', lastOwnerId: row.lastOwnerId || '', name: row.name, savedText: '', dirty: false };
    clearUndo();
    ['script-rename', 'script-find-open', 'script-format', 'script-copy-ids'].forEach(function (id) {
      const btn = el(id);
      if (btn) btn.hidden = false;
    });
    closeFind();
    const name = el('script-name');
    if (name) name.textContent = row.name || 'Unnamed script';
    const save = el<HTMLButtonElement>('script-save');
    if (save) save.disabled = true;
    const input = el<HTMLTextAreaElement>('script-input');
    if (input) {
      input.value = '';
      input.disabled = true;
    }
    renderDiagnostics([]);
    hideCompletion();
    setStatus('Loading...');
    setEditorOpen(true);
    renderList();
    refreshHighlight();
    try {
      const wait = waitForSource(row.itemId);
      await BeeTransport.requestScriptSource(row.itemId, row.assetId);
      const text = await wait;
      if (seq !== openSeq) return;
      current.savedText = text;
      if (input) {
        input.value = text;
        input.disabled = false;
      }
      setStatus('Saved');
      refreshHighlight();
    } catch (err) {
      if (seq !== openSeq) return;
      setStatus('Load failed', 'error');
      BeeUtils.showToast(BeeUtils.errText(err) || 'Could not load the script.', 'error');
    }
  }

  async function save() {
    const input = el<HTMLTextAreaElement>('script-input');
    if (!current || !input || saving) return;
    const mono = el<HTMLInputElement>('script-mono');
    const text = input.value;
    saving = true;
    const btn = el<HTMLButtonElement>('script-save');
    if (btn) btn.disabled = true;
    setStatus('Compiling...');
    renderDiagnostics([]);
    try {
      const res = await BeeTransport.saveScript(current.itemId, text, mono && !mono.checked ? 'lsl2' : 'mono');
      renderDiagnostics(res && res.diagnostics);
      if (res && res.ok && res.compiled) {
        current.savedText = text;
        current.dirty = false;
        setStatus('Saved ✓ compiled', 'ok');
        BeeUtils.showToast('Script saved and compiled.', 'success');
      } else if (res && res.ok) {
        // The upload landed but the compiler rejected it; the asset holds the
        // new (broken) source, matching how the grid treats a failed compile.
        current.savedText = text;
        current.dirty = false;
        setStatus('Compile failed', 'error');
        BeeUtils.showToast('Saved, but the script did not compile.', 'warning');
      } else {
        setStatus('Upload failed', 'error');
        BeeUtils.showToast('The script upload failed.', 'error');
      }
    } catch (err) {
      setStatus('Upload failed', 'error');
      BeeUtils.showToast(BeeUtils.errText(err) || 'The script upload failed.', 'error');
      if (btn) btn.disabled = false;
    } finally {
      saving = false;
      if (btn && current && current.dirty) btn.disabled = false;
    }
  }

  function reset() {
    rows = [];
    loaded = false;
    loading = false;
    loadError = '';
    lang = null;
    langSets = null;
    current = null;
    openSeq++;
    clearUndo();
    sourceWaiters.forEach(function (w) {
      clearTimeout(w.timer);
      w.reject(new Error('Session ended'));
    });
    sourceWaiters.clear();
    if (createWaiter) {
      clearTimeout(createWaiter.timer);
      createWaiter.reject(new Error('Session ended'));
      createWaiter = null;
    }
    ['script-rename', 'script-find-open', 'script-format', 'script-copy-ids'].forEach(function (id) {
      const btn = el(id);
      if (btn) btn.hidden = true;
    });
    closeFind();
    const sig = el('script-signature');
    if (sig) sig.hidden = true;
    const input = el<HTMLTextAreaElement>('script-input');
    if (input) input.value = '';
    setStatus('');
    setEditorOpen(false);
    renderDiagnostics([]);
    hideCompletion();
    renderList();
    refreshHighlight();
  }

  function activate() {
    load(false);
    loadLanguage();
    renderList();
  }

  function init() {
    const list = el('scripts-items');
    if (list) {
      list.addEventListener('click', function (e) {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('.scripts-list__item');
        if (!btn) return;
        const row = rows.find(function (r) { return r.itemId === btn.dataset.itemId; });
        if (row) open(row);
      });
    }
    const filter = el<HTMLInputElement>('scripts-filter');
    if (filter) filter.addEventListener('input', renderList);
    const refresh = el('scripts-refresh');
    if (refresh) refresh.addEventListener('click', function () { load(true); });
    const newBtn = el('scripts-new');
    if (newBtn) newBtn.addEventListener('click', function () { void createNew(); });
    const renameBtn = el('script-rename');
    if (renameBtn) renameBtn.addEventListener('click', function () { void renameCurrent(); });

    const findOpenBtn = el('script-find-open');
    if (findOpenBtn) findOpenBtn.addEventListener('click', openFind);
    const formatBtn = el('script-format');
    if (formatBtn) formatBtn.addEventListener('click', function () { void formatCurrent(); });
    const findBox = el<HTMLInputElement>('script-find-input');
    if (findBox) {
      findBox.addEventListener('input', function () { findIndex = -1; runFind(0); });
      findBox.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          runFind(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeFind();
        }
      });
    }
    const findPrev = el('script-find-prev');
    if (findPrev) findPrev.addEventListener('click', function () { runFind(-1); });
    const findNext = el('script-find-next');
    if (findNext) findNext.addEventListener('click', function () { runFind(1); });
    const findClose = el('script-find-close');
    if (findClose) findClose.addEventListener('click', closeFind);

    const copyBtn = el('script-copy-ids');
    if (copyBtn) {
      copyBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!current) return;
        openItemMenu(copyBtn, current);
      });
    }
    const back = el('script-back');
    if (back) {
      back.addEventListener('click', function () {
        const panel = el('panel-scripts');
        if (panel) panel.classList.remove('panel--scripts--editor-open');
      });
    }
    const saveBtn = el('script-save');
    if (saveBtn) saveBtn.addEventListener('click', function () { void save(); });

    const input = el<HTMLTextAreaElement>('script-input');
    if (input) {
      // The value BEFORE each native edit is the undo step.
      input.addEventListener('beforeinput', function () { pushUndo(); });
      input.addEventListener('input', function () {
        // Edits shift offsets, so a lingering find mark would sit on the
        // wrong text; searching again re-marks.
        if (findMark) {
          findMark = null;
          findMatches = [];
          findIndex = -1;
          updateFindCount();
        }
        markDirty();
        refreshHighlight();
        refreshCompletion();
        refreshSignature();
      });
      input.addEventListener('scroll', syncScroll);
      input.addEventListener('click', function () {
        hideCompletion();
        refreshSignature();
      });
      input.addEventListener('keyup', function (e) {
        if (e.key.indexOf('Arrow') === 0 || e.key === 'Home' || e.key === 'End') refreshSignature();
      });
      // Delayed, so a completion chip's mousedown still lands first.
      input.addEventListener('blur', function () { setTimeout(hideCompletion, 120); });
      input.addEventListener('keydown', function (e) {
        const bar = el('script-complete');
        const barOpen = bar && !bar.hidden;
        if (e.key === 'Tab' && barOpen) {
          e.preventDefault();
          const first = bar.querySelector<HTMLElement>('.script-complete__item--first .script-complete__name');
          if (first) applyCompletion(first.textContent || '');
          return;
        }
        if (e.key === 'Escape' && barOpen) {
          e.preventDefault();
          hideCompletion();
          return;
        }
        if (e.key === 'Escape') {
          const findBar = el('script-find');
          if (findBar && !findBar.hidden) {
            e.preventDefault();
            closeFind();
            return;
          }
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          openFind();
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          pushUndo(true);
          input.setRangeText('    ', input.selectionStart, input.selectionEnd, 'end');
          markDirty();
          refreshHighlight();
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          undoEdit();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
          e.preventDefault();
          redoEdit();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (current && current.dirty) void save();
        }
      });
    }

    BeeTransport.on('script-created', function (data) {
      if (!data || !data.itemId || !createWaiter) return;
      const waiter = createWaiter;
      createWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(data);
    });

    BeeTransport.on('script-source', function (data) {
      if (!data || !data.itemId) return;
      const waiter = sourceWaiters.get(data.itemId);
      if (!waiter) return;
      sourceWaiters.delete(data.itemId);
      clearTimeout(waiter.timer);
      if (data.ok) waiter.resolve(String(data.text || ''));
      else waiter.reject(new Error(data.error || 'The script could not be downloaded.'));
    });

    BeeState.on('reset', reset);
    BeeTransport.on('connected', function () {
      if (BeeState.get().activeTab === 'scripts') {
        load(false);
        loadLanguage();
      } else {
        renderList();
      }
    });
    renderList();
  }

  return {
    init: init,
    activate: activate,
    reload: function () { return load(true); },
    reset: reset,
    openItemMenu: openItemMenu
  };
})();

window.BeeScripts = BeeScripts;
