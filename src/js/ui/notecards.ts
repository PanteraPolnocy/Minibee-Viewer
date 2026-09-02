/**
 * Notecards tab - browse the inventory's Notecards folder, read a notecard,
 * edit the text, and save it back. A plain-text sibling of the Scripts tab:
 * same list-plus-editor layout, no highlighting or compiler.
 */
const BeeNotecards = (function () {
  'use strict';

  const SOURCE_TIMEOUT_MS = 30000;

  let rows = [];
  let loaded = false;
  let loading = false;
  let loadError = '';
  let current = null; // { itemId, assetId, creatorId, lastOwnerId, name, savedText, dirty, hasEmbeds }
  let saving = false;
  let openSeq = 0;
  const sourceWaiters = new Map(); // itemId -> { resolve, reject, timer }
  let createWaiter = null;

  function sortRows() {
    rows.sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    });
  }

  function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  // --- list ---

  function renderList() {
    const list = el('notecards-items');
    const status = el('notecards-status');
    if (!list) return;
    const filter = el<HTMLInputElement>('notecards-filter');
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
      btn.dataset.copy = r.itemId;
      btn.dataset.copyLabel = 'Copy item UUID';
      btn.textContent = r.name || 'Unnamed notecard';
      btn.title = btn.textContent;
      li.appendChild(btn);
      list.appendChild(li);
    });

    let text = '';
    if (loading) text = 'Loading notecards...';
    else if (loadError) text = loadError;
    else if (loaded && !rows.length) text = 'No notecards yet.';
    else if (loaded && !shown.length) text = 'No notecards match.';
    else if (!loaded && !BeeState.gridOnline()) text = 'Log in to see your notecards.';
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
      const fetched = await BeeTransport.listNotecards();
      rows = fetched || [];
      loaded = true;
    } catch (err) {
      loadError = BeeUtils.errText(err) || 'Could not load notecards.';
    } finally {
      loading = false;
      renderList();
    }
  }

  // --- editor ---

  function setStatus(text, kind?) {
    const state = el('notecard-state');
    if (!state) return;
    state.textContent = text || '';
    state.className = 'script-editor__state' + (kind ? ' script-editor__state--' + kind : '');
  }

  function markDirty() {
    if (!current || current.dirty) return;
    current.dirty = true;
    setStatus('Modified', 'dirty');
    const save = el<HTMLButtonElement>('notecard-save');
    if (save) save.disabled = false;
  }

  function setEditorOpen(open) {
    const panel = el('panel-notecards');
    if (panel) panel.classList.toggle('panel--scripts--editor-open', open);
    const body = el('notecard-editor-body');
    const empty = el('notecard-editor-empty');
    if (body) body.hidden = !open;
    if (empty) empty.hidden = open;
  }

  function waitForSource(itemId): Promise<{ text: string; hasEmbeds: boolean }> {
    return new Promise(function (resolve, reject) {
      const existing = sourceWaiters.get(itemId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.reject(new Error('Superseded'));
      }
      const timer = setTimeout(function () {
        sourceWaiters.delete(itemId);
        reject(new Error('The notecard download timed out.'));
      }, SOURCE_TIMEOUT_MS);
      sourceWaiters.set(itemId, { resolve: resolve, reject: reject, timer: timer });
    });
  }

  function isZeroId(id) {
    return !id || /^0+(-0+)*$/.test(String(id).replace(/-/g, ''));
  }

  async function createNew() {
    if (!BeeState.gridOnline()) return;
    const name = await BeeUtils.prompt({
      title: 'New notecard',
      message: 'Name for the new notecard:',
      confirmLabel: 'Create',
      value: 'New Note'
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
          reject(new Error('The sim did not confirm the new notecard.'));
        }, 15000);
        createWaiter = { resolve: resolve, reject: reject, timer: timer };
      });
      await BeeTransport.createNotecard(name.trim());
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
      BeeUtils.showToast('Notecard created.', 'success');
      open(row);
    } catch (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || 'Could not create the notecard.', 'error');
    }
  }

  async function renameCurrent() {
    if (!current) return;
    const name = await BeeUtils.prompt({
      title: 'Rename notecard',
      message: 'New name:',
      confirmLabel: 'Rename',
      value: current.name || ''
    });
    if (name === null || !name.trim() || name.trim() === current.name) return;
    try {
      const res = await BeeTransport.renameScript(current.itemId, name.trim());
      const finalName = (res && res.name) || name.trim();
      current.name = finalName;
      const nameEl = el('notecard-name');
      if (nameEl) nameEl.textContent = finalName;
      const row = rows.find(function (r) { return r.itemId === current.itemId; });
      if (row) row.name = finalName;
      sortRows();
      renderList();
      BeeUtils.showToast('Notecard renamed.', 'success');
    } catch (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || 'Could not rename the notecard.', 'error');
    }
  }

  async function open(row) {
    if (current && current.dirty) {
      const ok = await BeeUtils.confirm({
        title: 'Discard changes?',
        message: '"' + (current.name || 'This notecard') + '" has unsaved changes.',
        confirmLabel: 'Discard',
        danger: true
      });
      if (!ok) return;
    }
    const seq = ++openSeq;
    current = { itemId: row.itemId, assetId: row.assetId, creatorId: row.creatorId || '', lastOwnerId: row.lastOwnerId || '', name: row.name, savedText: '', dirty: false, hasEmbeds: false };
    ['notecard-rename', 'notecard-copy-ids'].forEach(function (id) {
      const btn = el(id);
      if (btn) btn.hidden = false;
    });
    const name = el('notecard-name');
    if (name) name.textContent = row.name || 'Unnamed notecard';
    const save = el<HTMLButtonElement>('notecard-save');
    if (save) save.disabled = true;
    const input = el<HTMLTextAreaElement>('notecard-input');
    if (input) {
      input.value = '';
      input.disabled = true;
    }
    setStatus('Loading...');
    setEditorOpen(true);
    renderList();
    // A brand-new notecard has no asset yet; there is nothing to download.
    if (isZeroId(row.assetId)) {
      if (input) input.disabled = false;
      setStatus('Saved');
      return;
    }
    try {
      const wait = waitForSource(row.itemId);
      await BeeTransport.requestNotecardSource(row.itemId, row.assetId);
      const got = await wait;
      if (seq !== openSeq) return;
      current.savedText = got.text;
      current.hasEmbeds = got.hasEmbeds;
      if (input) {
        input.value = got.text;
        input.disabled = false;
      }
      setStatus('Saved');
    } catch (err) {
      if (seq !== openSeq) return;
      setStatus('Load failed', 'error');
      BeeUtils.showToast(BeeUtils.errText(err) || 'Could not load the notecard.', 'error');
    }
  }

  async function save() {
    const input = el<HTMLTextAreaElement>('notecard-input');
    if (!current || !input || saving) return;
    // A text-only save drops any items embedded in the original notecard.
    if (current.hasEmbeds) {
      const ok = await BeeUtils.confirm({
        title: 'Notecard has attachments',
        message: 'This notecard carries embedded inventory items. Saving from here keeps the text but removes those items. Save anyway?',
        confirmLabel: 'Save without items',
        danger: true
      });
      if (!ok) return;
    }
    const text = input.value;
    saving = true;
    const btn = el<HTMLButtonElement>('notecard-save');
    if (btn) btn.disabled = true;
    setStatus('Saving...');
    try {
      const res = await BeeTransport.saveNotecard(current.itemId, text);
      if (res && res.ok) {
        current.savedText = text;
        current.dirty = false;
        current.hasEmbeds = false;
        if (res.newAsset) current.assetId = res.newAsset;
        setStatus('Saved', 'ok');
        BeeUtils.showToast('Notecard saved.', 'success');
      } else {
        setStatus('Save failed', 'error');
        BeeUtils.showToast('The notecard save failed.', 'error');
      }
    } catch (err) {
      setStatus('Save failed', 'error');
      BeeUtils.showToast(BeeUtils.errText(err) || 'The notecard save failed.', 'error');
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
    current = null;
    openSeq++;
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
    ['notecard-rename', 'notecard-copy-ids'].forEach(function (id) {
      const btn = el(id);
      if (btn) btn.hidden = true;
    });
    const input = el<HTMLTextAreaElement>('notecard-input');
    if (input) input.value = '';
    setStatus('');
    setEditorOpen(false);
    renderList();
  }

  function activate() {
    load(false);
    renderList();
  }

  function init() {
    const list = el('notecards-items');
    if (list) {
      list.addEventListener('click', function (e) {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('.scripts-list__item');
        if (!btn) return;
        const row = rows.find(function (r) { return r.itemId === btn.dataset.itemId; });
        if (row) open(row);
      });
    }
    // Right-click on a list row: open + creator, like the scripts list.
    if (typeof BeeContextMenu !== 'undefined' && BeeContextMenu.register) {
      BeeContextMenu.register('#notecards-items .scripts-list__item', function (host) {
        const row = rows.find(function (r) { return r.itemId === host.dataset.itemId; });
        if (!row) return [];
        const creatorKnown = /^[0-9a-f]{8}-/i.test(String(row.creatorId || '')) &&
          !/^0+(-0+)*$/.test(String(row.creatorId || '').replace(/-/g, ''));
        return [
          { label: 'Open notecard', action: function () { void open(row); } },
          {
            label: 'Creator profile',
            disabled: !creatorKnown,
            action: function () {
              if (typeof BeeProfile !== 'undefined' && BeeProfile.openAvatar) BeeProfile.openAvatar(row.creatorId);
            }
          }
        ];
      });
    }
    const filter = el<HTMLInputElement>('notecards-filter');
    if (filter) filter.addEventListener('input', renderList);
    const refresh = el('notecards-refresh');
    if (refresh) refresh.addEventListener('click', function () { load(true); });
    const newBtn = el('notecards-new');
    if (newBtn) newBtn.addEventListener('click', function () { void createNew(); });
    const renameBtn = el('notecard-rename');
    if (renameBtn) renameBtn.addEventListener('click', function () { void renameCurrent(); });
    const copyBtn = el('notecard-copy-ids');
    if (copyBtn) {
      copyBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!current) return;
        BeeScripts.openItemMenu(copyBtn, current);
      });
    }
    const back = el('notecard-back');
    if (back) {
      back.addEventListener('click', function () {
        const panel = el('panel-notecards');
        if (panel) panel.classList.remove('panel--scripts--editor-open');
      });
    }
    const saveBtn = el('notecard-save');
    if (saveBtn) saveBtn.addEventListener('click', function () { void save(); });

    const input = el<HTMLTextAreaElement>('notecard-input');
    if (input) {
      input.addEventListener('input', markDirty);
      input.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (current && current.dirty) void save();
        }
      });
    }

    BeeTransport.on('notecard-created', function (data) {
      if (!data || !data.itemId || !createWaiter) return;
      const waiter = createWaiter;
      createWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(data);
    });

    BeeTransport.on('notecard-source', function (data) {
      if (!data || !data.itemId) return;
      const waiter = sourceWaiters.get(data.itemId);
      if (!waiter) return;
      sourceWaiters.delete(data.itemId);
      clearTimeout(waiter.timer);
      if (data.ok) waiter.resolve({ text: String(data.text || ''), hasEmbeds: !!data.hasEmbeds });
      else waiter.reject(new Error(data.error || 'The notecard could not be downloaded.'));
    });

    BeeState.on('reset', reset);
    BeeTransport.on('connected', function () {
      if (BeeState.get().activeTab === 'notecards') load(false);
      else renderList();
    });
    renderList();
  }

  return {
    init: init,
    activate: activate,
    reload: function () { return load(true); },
    reset: reset
  };
})();

window.BeeNotecards = BeeNotecards;
