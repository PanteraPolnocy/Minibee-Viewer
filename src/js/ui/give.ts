/**
 * "Send to a resident" - offers an inventory item (a script or a notecard
 * from their tabs) to someone picked from your friends, the radar, or a
 * people search. The offer itself (IM_INVENTORY_OFFERED) goes out through the
 * Rust core; the recipient's accept or decline lands in chat as a system line.
 */
const BeeGive = (function () {
  'use strict';

  const t = BeeI18n.t;

  const SEARCH_MIN_LEN = 3;
  const SEARCH_DEBOUNCE_MS = 450;

  let item = null;          // { itemId, assetType, name }
  let source = 'friends';   // friends | nearby | search
  let selectedId = '';
  let searchRows = [];
  let searchStatus = '';    // '' | 'searching' | 'done' | 'error'
  let searchTimer = null;
  let searchToken = 0;
  let bound = false;

  function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  function normId(id) {
    return String(id || '').toLowerCase();
  }

  // Friends and radar rows carry only what the roster knew at the time; the
  // transport's name cache is fresher, so prefer it (same as the IM list).
  function nameLines(agent) {
    const info = agent && agent.id && typeof BeeTransport.getCachedNameInfo === 'function'
      ? BeeTransport.getCachedNameInfo(agent.id)
      : null;
    if (info && (info.userName || info.label || info.displayName)) {
      return BeeUtils.agentNameLines({
        displayName: info.displayName || '',
        userName: info.userName || info.label || '',
        name: info.label || (agent && agent.name) || ''
      });
    }
    return BeeUtils.agentNameLines(agent || {});
  }

  function rowsForSource() {
    if (source === 'friends') return (BeeState.get().buddies || []).slice();
    if (source === 'nearby') return (BeeState.get().radar || []).slice();
    return searchRows.slice();
  }

  function emptyText(query) {
    if (source === 'friends') {
      return query ? t('give.noFriendsMatch') : t('give.noFriends');
    }
    if (source === 'nearby') {
      return query ? t('give.nobodyNearbyMatch') : t('give.nobodyNearby');
    }
    if (searchStatus === 'searching') return t('land.searching');
    if (searchStatus === 'error') return t('give.searchFailed');
    if (searchStatus === 'done') return t('give.noResidents');
    return t('give.typeToSearch', { count: SEARCH_MIN_LEN });
  }

  function updateSubmit() {
    const submit = el<HTMLButtonElement>('give-submit');
    if (submit) submit.disabled = !selectedId || !item;
  }

  function renderPicker() {
    const picker = el('give-picker');
    if (!picker) return;
    const filter = el<HTMLInputElement>('give-filter');
    const query = filter ? filter.value.trim().toLowerCase() : '';
    // For the search source the box IS the query; results are not re-filtered.
    const q = source === 'search' ? '' : query;
    const selfId = normId((BeeState.get().agent || {}).id);

    const rows = rowsForSource().filter(function (r) {
      return r && r.id && normId(r.id) !== selfId;
    }).map(function (r) {
      const names = nameLines(r);
      return {
        id: String(r.id),
        title: names.title || r.name || r.id,
        subtitle: names.subtitle || '',
        hay: [r.userName, r.displayName, r.name, names.subtitle, names.title]
          .filter(Boolean).join(' ').toLowerCase()
      };
    }).filter(function (r) {
      return !q || r.hay.indexOf(q) !== -1;
    }).sort(function (a, b) {
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    });

    // Dedupe: a search can echo one person twice, and the radar might too.
    const seen = {};
    picker.innerHTML = '';
    let shown = 0;
    rows.forEach(function (r) {
      const key = normId(r.id);
      if (seen[key]) return;
      seen[key] = true;
      shown++;
      const row = document.createElement('label');
      row.className = 'conference-picker__row';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'give-recipient';
      radio.value = r.id;
      radio.checked = key === normId(selectedId);
      radio.addEventListener('change', function () {
        if (radio.checked) {
          selectedId = r.id;
          updateSubmit();
        }
      });
      const text = document.createElement('span');
      text.className = 'give-picker__text';
      const name = document.createElement('span');
      name.className = 'give-picker__name';
      name.textContent = r.title;
      text.appendChild(name);
      if (r.subtitle) {
        const sub = document.createElement('span');
        sub.className = 'give-picker__sub';
        sub.textContent = r.subtitle;
        text.appendChild(sub);
      }
      row.appendChild(radio);
      row.appendChild(text);
      picker.appendChild(row);
    });
    if (!shown) {
      const empty = document.createElement('div');
      empty.className = 'conference-picker__empty';
      empty.textContent = emptyText(query);
      picker.appendChild(empty);
    }
    // The selection may have scrolled out of the current source's list.
    if (selectedId && !seen[normId(selectedId)]) selectedId = '';
    updateSubmit();
  }

  // The box under the source tabs is a search box for the directory and a
  // filter for the two lists; its label and placeholder say which.
  function paintFilterLabels() {
    const label = el('give-filter-label');
    const filter = el<HTMLInputElement>('give-filter');
    if (label) {
      label.textContent = source === 'search' ? t('give.nameToSearch') : t('give.filter');
    }
    if (filter) {
      filter.placeholder = source === 'search'
        ? t('search.peoplePlaceholder')
        : t('conference.filterPlaceholder');
    }
  }

  function paintItemName() {
    const nameEl = el('give-item-name');
    if (!nameEl || !item) return;
    nameEl.textContent = t('give.sendTo', { item: item.name || t('chat.item') });
  }

  function setSource(next) {
    source = next === 'nearby' || next === 'search' ? next : 'friends';
    document.querySelectorAll<HTMLElement>('.give-source').forEach(function (btn) {
      const active = btn.dataset.giveSource === source;
      btn.classList.toggle('search-kind--active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    paintFilterLabels();
    const filter = el<HTMLInputElement>('give-filter');
    if (filter) filter.value = '';
    searchRows = [];
    searchStatus = '';
    renderPicker();
  }

  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  }

  async function runSearch() {
    searchTimer = null;
    const filter = el<HTMLInputElement>('give-filter');
    const query = filter ? filter.value.trim() : '';
    if (source !== 'search') return;
    if (query.length < SEARCH_MIN_LEN || !/[\p{L}\p{N}]/u.test(query)) {
      searchRows = [];
      searchStatus = '';
      renderPicker();
      return;
    }
    if (!BeeState.gridOnline()) return;
    const token = ++searchToken;
    searchStatus = 'searching';
    renderPicker();
    try {
      const res = await BeeTransport.searchDirectory('avatars', query, 0);
      if (token !== searchToken) return;
      searchRows = (res && res.rows) || [];
      searchStatus = 'done';
    } catch (_err) {
      if (token !== searchToken) return;
      searchRows = [];
      searchStatus = 'error';
    }
    renderPicker();
  }

  function selectedName() {
    const fallback = t('give.theResident');
    const row = rowsForSource().find(function (r) { return r && normId(r.id) === normId(selectedId); });
    return row ? (nameLines(row).title || row.name || fallback) : fallback;
  }

  function submit(e) {
    e.preventDefault();
    const dialog = el<HTMLDialogElement>('give-dialog');
    if (!item || !selectedId) return;
    if (!BeeState.gridOnline()) {
      BeeUtils.showToast(t('give.connectFirst'), 'warning');
      return;
    }
    const recipient = selectedName();
    const label = item.name || t('chat.item');
    const submitBtn = el<HTMLButtonElement>('give-submit');
    if (submitBtn) submitBtn.disabled = true;
    BeeTransport.giveInventory(selectedId, item).then(function (result) {
      if (!result || !result.sent) throw new Error(t('give.sendFailed'));
      BeeUtils.showToast(t('give.offered', { item: label, name: recipient }), 'success');
      if (dialog) BeeUtils.dismissDialog(dialog);
    }).catch(function (err) {
      BeeUtils.showToast(t('give.sendFailedWith',
        { item: label, error: BeeUtils.errText(err) || t('give.sendFailed') }), 'warning');
      updateSubmit();
    });
  }

  function bindOnce() {
    if (bound) return;
    bound = true;
    const dialog = el<HTMLDialogElement>('give-dialog');
    const form = el<HTMLFormElement>('give-form');
    const cancel = el<HTMLButtonElement>('give-cancel');
    const filter = el<HTMLInputElement>('give-filter');
    if (form) form.addEventListener('submit', submit);
    if (cancel && dialog) {
      cancel.addEventListener('click', function () { BeeUtils.dismissDialog(dialog); });
    }
    document.querySelectorAll<HTMLElement>('.give-source').forEach(function (btn) {
      btn.addEventListener('click', function () { setSource(btn.dataset.giveSource); });
    });
    if (filter) {
      filter.addEventListener('input', function () {
        if (source === 'search') scheduleSearch();
        else renderPicker();
      });
      filter.addEventListener('keydown', function (e) {
        // Enter in the search box searches now instead of submitting the form.
        if (e.key === 'Enter' && source === 'search') {
          e.preventDefault();
          if (searchTimer) clearTimeout(searchTimer);
          void runSearch();
        }
      });
    }
    // Names resolve and people come and go while the picker is open.
    const repaint = function () {
      if (dialog && dialog.open) renderPicker();
    };
    BeeTransport.on('names-updated', repaint);
    BeeTransport.on('buddies-updated', repaint);
    BeeState.on('change', function (partial) {
      if (partial && 'radar' in partial) repaint();
    });
    // A language switch while the picker is open: the lines it paints are
    // ours (the markup's own carry data-i18n and follow on their own).
    BeeI18n.onChange(function () {
      if (!dialog || !dialog.open) return;
      paintItemName();
      paintFilterLabels();
      renderPicker();
    });
    BeeState.on('reset', function () {
      item = null;
      if (dialog && dialog.open) BeeUtils.dismissDialog(dialog);
    });
  }

  // Open the picker for one item: { itemId, assetType, name }.
  function open(nextItem) {
    const dialog = el<HTMLDialogElement>('give-dialog');
    if (!dialog || !nextItem || !nextItem.itemId) return;
    if (!BeeState.gridOnline()) {
      BeeUtils.showToast(t('give.connectFirst'), 'warning');
      return;
    }
    bindOnce();
    item = {
      itemId: String(nextItem.itemId),
      assetType: Number(nextItem.assetType) || 0,
      name: String(nextItem.name || '')
    };
    selectedId = '';
    paintItemName();
    setSource('friends');
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    const filter = el<HTMLInputElement>('give-filter');
    if (filter) filter.focus();
  }

  return { open: open };
})();
