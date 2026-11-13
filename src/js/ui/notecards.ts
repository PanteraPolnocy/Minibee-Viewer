/**
 * Notecards tab - browse the inventory's Notecards folder, read a notecard,
 * edit the text, and save it back. A plain-text sibling of the Scripts tab:
 * same list-plus-editor layout, no highlighting or compiler.
 */
const BeeNotecards = (function () {
  'use strict';

  const t = BeeI18n.t;

  const SOURCE_TIMEOUT_MS = 30000;

  let rows = [];
  let loaded = false;
  let loading = false;
  let loadError = null; // what the last list fetch rejected with, until the next fetch
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
      btn.dataset.copyLabel = t('scripts.copyItemUuid');
      btn.textContent = r.name || t('notecards.unnamed');
      btn.title = btn.textContent;
      li.appendChild(btn);
      list.appendChild(li);
    });

    let text = '';
    if (loading) text = t('notecards.loading');
    else if (loadError) text = BeeUtils.errText(loadError) || t('notecards.loadFailed');
    else if (loaded && !rows.length) text = t('notecards.none');
    else if (loaded && !shown.length) text = t('notecards.noMatch');
    else if (!loaded && !BeeState.gridOnline()) text = t('notecards.logInToSee');
    if (status) {
      status.textContent = text;
      status.hidden = !text;
    }
  }

  async function load(force?: boolean) {
    if (loading || (loaded && !force)) return;
    if (!BeeState.gridOnline()) return;
    loading = true;
    loadError = null;
    renderList();
    try {
      const fetched = await BeeTransport.listNotecards();
      rows = fetched || [];
      loaded = true;
    } catch (err) {
      // Kept as it came: the list renders its words in whatever language is
      // current, so a switch repaints the failure too.
      loadError = err || new Error('');
    } finally {
      loading = false;
      renderList();
    }
  }

  // --- editor ---

  // The editor's state line by id, translated as it is painted, so a
  // language switch repaints the same state. The lines shared with the
  // Scripts tab use its keys.
  const STATUS_LINES = {
    loading: function () { return t('common.loading'); },
    saved: function () { return t('scripts.statusSaved'); },
    modified: function () { return t('scripts.statusModified'); },
    loadFailed: function () { return t('scripts.statusLoadFailed'); },
    saving: function () { return t('profile.saving'); },
    saveFailed: function () { return t('notecards.statusSaveFailed'); }
  };
  let status = { id: '', kind: '' };

  function paintStatus() {
    const state = el('notecard-state');
    if (!state) return;
    const line = STATUS_LINES[status.id];
    state.textContent = line ? line() : '';
    state.className = 'script-editor__state' + (status.kind ? ' script-editor__state--' + status.kind : '');
  }

  function setStatus(id, kind?) {
    status = { id: id || '', kind: kind || '' };
    paintStatus();
  }

  function markDirty() {
    if (!current || current.dirty) return;
    current.dirty = true;
    setStatus('modified', 'dirty');
    const save = el<HTMLButtonElement>('notecard-save');
    if (save) save.disabled = false;
  }

  // --- drafts ---
  // Same scheme as the Scripts tab: Android may kill a backgrounded app, so an
  // unsaved edit is stashed in the settings store when the page leaves the
  // screen and offered back when that notecard opens again. Dropped on a save
  // or when the user chooses to discard.

  const DRAFT_PREFIX = 'minibee-notecard-draft:';

  function stashDraft() {
    const input = el<HTMLTextAreaElement>('notecard-input');
    if (!current || !current.dirty || !input) return;
    BeeUtils.storageSet(DRAFT_PREFIX + current.itemId, { itemId: current.itemId, text: input.value, ts: Date.now() });
    // Push now: the store's own hide-time flush need not run after this one.
    if (BeeUtils.storageFlush) BeeUtils.storageFlush();
  }

  function removeDraft(itemId) {
    if (itemId) BeeUtils.storageRemove(DRAFT_PREFIX + itemId);
  }

  // The stashed text for an item, or null when there is none or it already
  // matches what the server holds (in which case the stash is dropped).
  function pendingDraft(itemId, loadedText) {
    const draft = BeeUtils.storageGet(DRAFT_PREFIX + itemId, null);
    if (!draft || typeof draft.text !== 'string') return null;
    if (draft.text === loadedText) {
      removeDraft(itemId);
      return null;
    }
    return draft.text;
  }

  // Put a stashed edit back into the editor, marked as unsaved so nothing
  // reaches the sim until the user saves it.
  function restoreDraft(input, draft) {
    if (draft === null || !input) return;
    input.value = draft;
    markDirty();
    BeeUtils.showToast(t('scripts.draftRestored'), 'info');
  }

  // Offer a notecard to another resident through the shared recipient picker.
  // Notecards are inventory asset type 7.
  function sendToResident(row) {
    if (!row || !row.itemId || typeof BeeGive === 'undefined') return;
    BeeGive.open({ itemId: row.itemId, assetType: 7, name: row.name || t('notecards.notecard') });
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
        existing.reject(new Error(t('scripts.superseded')));
      }
      const timer = setTimeout(function () {
        sourceWaiters.delete(itemId);
        reject(new Error(t('notecards.downloadTimedOut')));
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
      title: t('notecards.newNotecard'),
      message: t('notecards.newNamePrompt'),
      confirmLabel: t('scripts.create'),
      value: t('notecards.defaultName')
    });
    if (name === null || !name.trim()) return;
    try {
      const wait = new Promise<any>(function (resolve, reject) {
        if (createWaiter) {
          clearTimeout(createWaiter.timer);
          createWaiter.reject(new Error(t('scripts.superseded')));
        }
        const timer = setTimeout(function () {
          createWaiter = null;
          reject(new Error(t('notecards.createTimedOut')));
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
      BeeUtils.showToast(t('notecards.created'), 'success');
      open(row);
    } catch (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || t('notecards.createFailed'), 'error');
    }
  }

  async function renameCurrent() {
    if (!current) return;
    const name = await BeeUtils.prompt({
      title: t('notecards.rename'),
      message: t('scripts.renamePrompt'),
      confirmLabel: t('scripts.renameAction'),
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
      BeeUtils.showToast(t('notecards.renamed'), 'success');
    } catch (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || t('notecards.renameFailed'), 'error');
    }
  }

  async function open(row) {
    if (current && current.dirty) {
      const ok = await BeeUtils.confirm({
        title: t('scripts.discardTitle'),
        message: t('scripts.discardMessage', { name: current.name || t('notecards.thisNotecard') }),
        confirmLabel: t('scripts.discard'),
        danger: true
      });
      if (!ok) return;
      removeDraft(current.itemId);
    }
    const seq = ++openSeq;
    current = { itemId: row.itemId, assetId: row.assetId, creatorId: row.creatorId || '', lastOwnerId: row.lastOwnerId || '', name: row.name, savedText: '', dirty: false, hasEmbeds: false };
    ['notecard-rename', 'notecard-copy-ids', 'notecard-send'].forEach(function (id) {
      const btn = el(id);
      if (btn) btn.hidden = false;
    });
    const name = el('notecard-name');
    if (name) name.textContent = row.name || t('notecards.unnamed');
    const save = el<HTMLButtonElement>('notecard-save');
    if (save) save.disabled = true;
    const input = el<HTMLTextAreaElement>('notecard-input');
    if (input) {
      input.value = '';
      input.disabled = true;
    }
    setStatus('loading');
    setEditorOpen(true);
    renderList();
    // A brand-new notecard has no asset yet; there is nothing to download.
    if (isZeroId(row.assetId)) {
      if (input) input.disabled = false;
      setStatus('saved');
      restoreDraft(input, pendingDraft(row.itemId, ''));
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
      setStatus('saved');
      restoreDraft(input, pendingDraft(row.itemId, got.text));
    } catch (err) {
      if (seq !== openSeq) return;
      setStatus('loadFailed', 'error');
      BeeUtils.showToast(BeeUtils.errText(err) || t('notecards.openFailed'), 'error');
    }
  }

  async function save() {
    const input = el<HTMLTextAreaElement>('notecard-input');
    if (!current || !input || saving) return;
    // A text-only save drops any items embedded in the original notecard.
    if (current.hasEmbeds) {
      const ok = await BeeUtils.confirm({
        title: t('notecards.embedsTitle'),
        message: t('notecards.embedsMessage'),
        confirmLabel: t('notecards.saveWithoutItems'),
        danger: true
      });
      if (!ok) return;
    }
    const text = input.value;
    const itemId = current.itemId;
    saving = true;
    const btn = el<HTMLButtonElement>('notecard-save');
    if (btn) btn.disabled = true;
    setStatus('saving');
    try {
      const res = await BeeTransport.saveNotecard(itemId, text);
      // The round trip takes seconds and the editor may have moved on to
      // another notecard meanwhile; a late reply must not touch that one.
      if (!current || current.itemId !== itemId) return;
      if (res && res.ok) {
        current.savedText = text;
        current.hasEmbeds = false;
        if (res.newAsset) current.assetId = res.newAsset;
        removeDraft(itemId);
        // Anything typed during the upload is still unsaved, so dirty follows
        // the textarea rather than the moment Save was pressed.
        current.dirty = input.value !== text;
        if (current.dirty) setStatus('modified', 'dirty');
        else setStatus('saved', 'ok');
        BeeUtils.showToast(t('notecards.saved'), 'success');
      } else {
        setStatus('saveFailed', 'error');
        BeeUtils.showToast(t('notecards.saveFailed'), 'error');
      }
    } catch (err) {
      if (current && current.itemId === itemId) setStatus('saveFailed', 'error');
      BeeUtils.showToast(BeeUtils.errText(err) || t('notecards.saveFailed'), 'error');
    } finally {
      saving = false;
      if (btn && current && current.dirty) btn.disabled = false;
    }
  }

  function reset() {
    rows = [];
    loaded = false;
    loading = false;
    loadError = null;
    current = null;
    openSeq++;
    sourceWaiters.forEach(function (w) {
      clearTimeout(w.timer);
      w.reject(new Error(t('session.ended')));
    });
    sourceWaiters.clear();
    if (createWaiter) {
      clearTimeout(createWaiter.timer);
      createWaiter.reject(new Error(t('session.ended')));
      createWaiter = null;
    }
    ['notecard-rename', 'notecard-copy-ids', 'notecard-send'].forEach(function (id) {
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
          { label: t('notecards.open'), action: function () { void open(row); } },
          { label: t('scripts.sendToResidentMenu'), action: function () { sendToResident(row); } },
          {
            label: t('interact.creatorProfile'),
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
    const sendBtn = el('notecard-send');
    if (sendBtn) sendBtn.addEventListener('click', function () { if (current) sendToResident(current); });
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
      else {
        waiter.reject(new Error(BeeI18n.field(data, 'error') ||
          t('notecards.downloadFailed')));
      }
    });

    BeeState.on('reset', reset);
    BeeTransport.on('connected', function () {
      if (BeeState.get().activeTab === 'notecards') load(false);
      else renderList();
    });
    // Leaving the screen is the last moment we are sure to get before the OS
    // may kill a backgrounded app.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') stashDraft();
    });
    window.addEventListener('pagehide', stashDraft);
    // A language switch: the list, the state line and the open notecard's
    // heading are painted again in the new words.
    BeeI18n.onChange(function () {
      renderList();
      paintStatus();
      const name = el('notecard-name');
      if (name && current) name.textContent = current.name || t('notecards.unnamed');
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
