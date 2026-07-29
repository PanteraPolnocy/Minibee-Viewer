/**
 * Interactions panel: what's nearby, and what your avatar can do.
 *
 */
const BeeInteract = (function () {
  'use strict';

  let state = { sitting: false, flying: false };

  function invoke(cmd: string, args?: Record<string, unknown>) {
    if (typeof BeeBridge === 'undefined' || !BeeBridge.invoke) {
      return Promise.reject(new Error('Native bridge unavailable'));
    }
    return BeeBridge.invoke(cmd, args || {});
  }

  function describe() {
    if (state.sitting) return 'sitting';
    if (sitPendingOn) return 'sitting down...';
    if (state.flying) return 'flying';
    return 'standing';
  }

  function paint() {
    const label = document.getElementById('interact-state');
    if (label) label.textContent = describe();
    const online = BeeState.gridOnline();
    const set = function (id, enabled) {
      const btn = document.getElementById(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = !(online && enabled);
    };
    // Only offer what makes sense: no point sitting twice, or landing mid-stand.
    set('interact-sit-ground', !state.sitting);
    set('interact-stand', state.sitting);
    set('interact-fly', !state.flying);
    set('interact-stop-fly', state.flying);
  }

  function applyResult(res) {
    if (!res) return;
    if (typeof res.sitting === 'boolean') state.sitting = res.sitting;
    if (typeof res.flying === 'boolean') state.flying = res.flying;
    paint();
  }

  function run(cmd, args, failure) {
    if (!BeeState.gridOnline()) {
      BeeUtils.showToast('Not connected to the grid', 'warning');
      return;
    }
    invoke(cmd, args).then(applyResult).catch(function () {
      BeeUtils.showToast(failure, 'warning');
    });
  }

  function refreshState() {
    invoke('sl_avatar_state').then(applyResult).catch(function () { /* keep what we have */ });
  }

  const RANGE_CHOICES = [16, 32, 48, 64, 96, 128, 256, 384];
  const DEFAULT_RANGE = 32;
  let range = DEFAULT_RANGE;
  let entries = [];
  let objects = [];
  let sortKey = 'distance';
  let sortAsc = true;
  /// True once Load has been pressed here, so an empty list can say why it's empty.
  let loaded = false;
  /// Last Load response metadata - helps distinguish "nothing here" from "still fetching".
  let lastScan = { pending: 0, tracked: 0, cached: 0, nearest: -1, roots: 0, unresolvedParents: 0, attachmentsTracked: 0, attachmentsInRange: 0, interest360: true };
  /// Linkset roots whose child rows are visible.
  const expandedRoots = {};
  /// Matches name or creator, both at once - see `matchesFilter`.
  let filterText = '';
  let includeAttachments = false;
  let includePhysical = true;
  let openDetailId = '';
  /// Which object we're sitting on, when we are - so "Sit on" can be out for that one row.
  let sittingOn = '';
  /// Set while a sit request awaits the sim's verdict; the sit-state event
  /// (success, refusal, or the Rust-side timeout) always clears it.
  let sitPendingOn = '';

  // Ask to sit and wait for the sim's answer instead of assuming it worked -
  // the verdict arrives as a sit-state event (see init).
  function requestSit(obj) {
    sitPendingOn = obj.id;
    paint();
    invoke('sl_object_sit', { objectId: obj.id }).catch(function () {
      sitPendingOn = '';
      paint();
      BeeUtils.showToast('Could not sit on that.', 'warning');
    });
  }

  function flattenEntries(list) {
    const out = [];
    (list || []).forEach(function (root) {
      out.push(root);
      (root.children || []).forEach(function (child) { out.push(child); });
    });
    return out;
  }

  // The plain name of whoever holds this key, or '' if we don't know yet. Deliberately
  // no placeholder text: `matchesFilter` compares against this, and a placeholder would
  // mean typing "res" matched every unresolved row.
  function nameOf(id) {
    if (!id || BeeProfiles.isZero(id)) return '';
    const cached = BeeTransport.getCachedName ? BeeTransport.getCachedName(id) : '';
    if (cached) return cached;
    // An object can belong to a group, and group names live in a different cache.
    return BeeTransport.getGroupName ? BeeTransport.getGroupName(id) : '';
  }

  // What the list shows: "Display Name (username)" where the resident has set one, the
  // same shape the buddies and radar lists use.
  function ownerLabel(id) {
    if (!id || BeeProfiles.isZero(id)) return '';
    const info = BeeTransport.getCachedNameInfo ? BeeTransport.getCachedNameInfo(id) : null;
    if (info && (info.displayName || info.userName || info.label)) {
      const lines = BeeUtils.agentNameLines({
        displayName: info.displayName || '',
        userName: info.userName || info.label || '',
        name: info.label || ''
      });
      return lines.subtitle ? lines.title + ' (' + lines.subtitle + ')' : lines.title;
    }
    const group = BeeTransport.getGroupName ? BeeTransport.getGroupName(id) : '';
    return group || 'resolving...';
  }

  function groupLabel(id) {
    if (!id || BeeProfiles.isZero(id)) return '';
    const fromTransport = BeeTransport.getGroupName ? BeeTransport.getGroupName(id) : '';
    if (fromTransport) return fromTransport;
    if (typeof BeeProfiles !== 'undefined' && BeeProfiles.getGroupName) {
      const cached = BeeProfiles.getGroupName(id);
      if (cached) return cached;
    }
    return 'resolving...';
  }

  function queueGroupResolve(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(function (id) {
      return id && !BeeProfiles.isZero(id);
    });
    if (!list.length) return;
    if (BeeTransport.queueGroupNameResolve) BeeTransport.queueGroupNameResolve(list);
    else if (typeof BeeProfiles !== 'undefined' && BeeProfiles.queueGroupName) {
      BeeProfiles.queueGroupName(list);
    }
  }

  // The filter matches the columns you can actually see: Name and Owner.
  //
  // Creator is deliberately not matched. It isn't a column, so a row that matched on it
  // would sit there with nothing on it resembling what you typed - which reads as a bug
  // rather than a feature. Creator is still on the details window and in the row menu.
  //
  // Names resolve asynchronously, so a row can only match on a name we already hold;
  // that's why the list repaints on names-updated.
  function matchesFilter(obj) {
    if (!filterText) return true;
    const needle = filterText.toLowerCase();
    const hit = function (text) {
      return !!text && text.toLowerCase().indexOf(needle) !== -1;
    };
    if (hit(obj.name)) return true;
    if (hit(nameHaystack(obj.ownerId))) return true;
    // A pasted key too: not on screen, but if you paste one you know what you're after.
    return hit(obj.ownerId);
  }

  // Every name we hold for someone, for matching against. A resident with a display name
  // set should still be findable by their username, and the other way round.
  function nameHaystack(id) {
    if (!id || BeeProfiles.isZero(id)) return '';
    const info = BeeTransport.getCachedNameInfo ? BeeTransport.getCachedNameInfo(id) : null;
    if (!info) return nameOf(id);
    return [info.label, info.userName, info.displayName].filter(Boolean).join(' ');
  }

  function isAttachmentObject(obj) {
    return !!(obj && obj.isAttachment);
  }

  function visibleEntries() {
    return sortList(entries.filter(matchesFilter));
  }

  function sortList(list) {
    const dir = sortAsc ? 1 : -1;
    return list.slice().sort(function (a, b) {
      if (sortKey === 'distance') return (a.distance - b.distance) * dir;
      const av = sortKey === 'owner' ? ownerLabel(a.ownerId) : (a.name || '');
      const bv = sortKey === 'owner' ? ownerLabel(b.ownerId) : (b.name || '');
      return av.toLowerCase().localeCompare(bv.toLowerCase()) * dir;
    });
  }

  function attachRowHandlers(row, obj) {
    row.addEventListener('click', function (e) {
      if (e.target.closest('.objects-cell--expandable')) return;
      e.stopPropagation();
      showRowMenu(e, obj);
    });
    row.addEventListener('contextmenu', function (e) {
      if (e.target.closest('.objects-cell--expandable')) return;
      e.preventDefault();
      e.stopPropagation();
      showRowMenu(e, obj);
    });
    row.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.objects-cell--expandable')) return;
      e.preventDefault();
      showRowMenu(e, obj);
    });
  }

  function buildObjectRow(obj, opts) {
    opts = opts || {};
    const row = document.createElement('div');
    row.className = 'objects-row objects-row--item' + (opts.child ? ' objects-row--child' : '');
    row.setAttribute('role', 'row');
    row.tabIndex = 0;

    const expandCell = document.createElement('span');
    expandCell.className = 'objects-cell objects-cell--expand';
    if (opts.expandable) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'objects-expand' + (opts.expanded ? ' objects-expand--open' : '');
      toggle.setAttribute(
        'aria-label',
        opts.expanded ? 'Hide linked prims' : 'Show ' + opts.childCount + ' linked prim' +
          (opts.childCount === 1 ? '' : 's')
      );
      toggle.addEventListener('pointerdown', function (e) {
        e.stopPropagation();
      });
      toggle.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        expandedRoots[obj.localId] = !expandedRoots[obj.localId];
        renderObjects();
      });
      expandCell.classList.add('objects-cell--expandable');
      expandCell.appendChild(toggle);
    }
    row.appendChild(expandCell);

    const dist = document.createElement('span');
    dist.className = 'objects-cell objects-cell--num';
    dist.textContent = obj.distance.toFixed(1) + ' m';
    row.appendChild(dist);

    const name = document.createElement('span');
    name.className = 'objects-cell';
    name.textContent = obj.name || '(unnamed)';
    row.appendChild(name);

    const owner = document.createElement('span');
    owner.className = 'objects-cell';
    owner.textContent = ownerLabel(obj.ownerId) || '-';
    row.appendChild(owner);

    attachRowHandlers(row, obj);
    return row;
  }

  function renderObjects() {
    const host = document.getElementById('objects-rows');
    if (!host) return;
    const shownRoots = visibleEntries();
    host.innerHTML = '';
    if (!shownRoots.length) {
      host.innerHTML = !loaded
        ? '<p class="settings-note">Press <strong>Load</strong> to list the objects around you.</p>'
        : filterText
          ? '<p class="settings-note">Nothing here matches "' + BeeUtils.escapeHtml(filterText) + '".</p>'
            : lastScan.cached > 0 && lastScan.tracked === 0
            ? '<p class="settings-note">The region listed ' + lastScan.cached +
              ' object' + (lastScan.cached === 1 ? '' : 's') +
              ' but none have arrived yet. Press <strong>Load</strong> again in a moment.</p>'
            : lastScan.pending > 0
              ? '<p class="settings-note">Still naming ' + lastScan.pending +
                ' object' + (lastScan.pending === 1 ? '' : 's') +
                ' within ' + range + 'm...</p>'
              : !lastScan.interest360
                ? '<p class="settings-note">This region did not grant the InterestList capability, ' +
                  'so object updates may be incomplete. Try <strong>Load</strong> again after moving.</p>'
                : includeAttachments && lastScan.attachmentsTracked > 0 && lastScan.attachmentsInRange === 0
                ? '<p class="settings-note">The sim reported ' + lastScan.attachmentsTracked +
                  ' worn attachment' + (lastScan.attachmentsTracked === 1 ? '' : 's') +
                  ' but none are in range yet. Wait for radar updates, then press <strong>Load</strong> again.</p>'
                : '<p class="settings-note">Nothing within ' + range + 'm (' + lastScan.tracked +
                  ' tracked, ' + lastScan.cached + ' cached' +
                  (lastScan.nearest >= 0 ? ', nearest ' + lastScan.nearest.toFixed(0) + 'm' : '') +
                  (lastScan.unresolvedParents > 0
                    ? ', ' + lastScan.unresolvedParents + ' missing parent link' +
                      (lastScan.unresolvedParents === 1 ? '' : 's')
                    : '') +
                  '). Press <strong>Load</strong> again after a moment.</p>';
      return;
    }
    shownRoots.forEach(function (root) {
      const kids = sortList(root.children || []);
      const hasKids = kids.length > 0;
      const expanded = !!expandedRoots[root.localId];
      host.appendChild(buildObjectRow(root, {
        expandable: hasKids,
        expanded: expanded,
        childCount: kids.length
      }));
      if (expanded && hasKids) {
        kids.forEach(function (child) {
          host.appendChild(buildObjectRow(child, { child: true }));
        });
      }
    });
    const title = document.getElementById('objects-title');
    if (title) {
      const totalRoots = entries.length;
      if (!totalRoots) {
        title.textContent = 'Nearby objects';
      } else if (shownRoots.length !== totalRoots) {
        title.textContent = 'Nearby objects (' + shownRoots.length + ' of ' + totalRoots +
          ' roots within ' + range + 'm)';
      } else {
        title.textContent = 'Nearby objects (' + totalRoots + ' roots within ' + range + 'm)';
      }
    }
    document.querySelectorAll<HTMLElement>('[data-objects-sort]').forEach(function (btn) {
      btn.classList.toggle('objects-sort--active', btn.dataset.objectsSort === sortKey);
    });
  }

  let objectsLoadBusy = false;

  function setObjectsControlsBusy(busy) {
    ['objects-refresh', 'objects-include-attachments', 'objects-include-physical', 'objects-range'].forEach(function (id) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.disabled = busy;
    });
  }

  function normalizeEntry(row) {
    return Object.assign({}, row, {
      physical: !!row.physical,
      isAttachment: !!row.isAttachment,
      children: (row.children || []).map(normalizeEntry)
    });
  }

  function applyScanResponse(res) {
    entries = (res && res.entries ? res.entries : []).map(normalizeEntry);
    objects = flattenEntries(entries);
    lastScan = {
      pending: (res && res.pending) || 0,
      tracked: (res && res.tracked) || 0,
      cached: (res && res.cached) || 0,
      nearest: res && typeof res.nearest === 'number' ? res.nearest : -1,
      roots: (res && res.roots) || 0,
      unresolvedParents: (res && res.unresolvedParents) || 0,
      attachmentsTracked: (res && res.attachmentsTracked) || 0,
      attachmentsInRange: (res && res.attachmentsInRange) || 0,
      interest360: !(res && res.interest360 === false)
    };
  }

  function nearbyQuery() {
    return {
      range: range,
      includeAttachments: includeAttachments,
      includePhysical: includePhysical
    };
  }

  function refreshObjects() {
    if (!BeeState.gridOnline()) return;
    if (objectsLoadBusy) return;
    objectsLoadBusy = true;
    setObjectsControlsBusy(true);

    function finishLoad() {
      objectsLoadBusy = false;
      setObjectsControlsBusy(false);
    }

    invoke('sl_nearby_objects', nearbyQuery()).then(function (res) {
      applyScanResponse(res);
      loaded = true;
      renderObjects();
      const pending = lastScan.pending;
      if (pending > 0) {
        BeeUtils.showToast('Naming ' + pending + ' object' + (pending === 1 ? '' : 's') + '...', 'info');
      }
      if (pending > 0 || entries.length === 0) {
        let followUpsLeft = 2;
        function followDone() {
          followUpsLeft -= 1;
          if (followUpsLeft <= 0) finishLoad();
        }
        [2000, 5000].forEach(function (delayMs) {
          window.setTimeout(function () {
            if (!objectsLoadBusy) return;
            if (!BeeState.gridOnline()) {
              followDone();
              return;
            }
            invoke('sl_nearby_objects', nearbyQuery()).then(function (r2) {
              if (r2 && r2.entries) {
                applyScanResponse(r2);
                renderObjects();
              }
            }).catch(function () {}).finally(followDone);
          }, delayMs);
        });
      } else {
        finishLoad();
      }
    }).catch(function () {
      BeeUtils.showToast('Could not read the nearby objects.', 'warning');
      finishLoad();
    });
  }

  function setRange(metres) {
    const next = RANGE_CHOICES.indexOf(Number(metres)) !== -1 ? Number(metres) : DEFAULT_RANGE;
    if (next === range) return;
    if (objectsLoadBusy) return;
    range = next;
    if (typeof BeeSettings !== 'undefined') BeeSettings.set('objectsRange', range);
    // A different radius is a different question, so ask it rather than filtering what
    // we happen to be holding - a wider one needs rows we never fetched.
    if (loaded) refreshObjects();
    else renderObjects();
  }

  // A small menu on the row, matching the entity menus elsewhere in the viewer.
  function showRowMenu(e, obj) {
    const menu = document.getElementById('context-menu');
    if (!menu) return;
    menu.innerHTML = '';
    const forSale = !!obj.forSale;
    const add = function (label, enabled, fn) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (!enabled) b.disabled = true;
      else b.addEventListener('click', function () { menu.hidden = true; fn(); });
      menu.appendChild(b);
    };
    add('Show details', true, function () { showDetails(obj); });
    // Touch and Pay only when the sim's flags say the object handles them.
    if (obj.canTouch) {
      add('Touch', true, function () {
        invoke('sl_object_touch', { localId: obj.localId })
          .catch(function () { BeeUtils.showToast('Could not touch that.', 'warning'); });
      });
    }
    // Sit on anything except worn attachments.
    if (!isAttachmentObject(obj)) {
      add('Sit on', !(state.sitting && sittingOn === obj.id), function () {
        requestSit(obj);
      });
    }
    if (canPayNow(obj)) {
      add('Pay...', true, function () { payObject(obj); });
    }
    // Whoever it belongs to, and whoever made it, are people you may want to look up.
    if (obj.ownerId && !BeeProfiles.isZero(obj.ownerId)) {
      add('Owner profile', true, function () { openProfile(obj.ownerId); });
    }
    if (obj.creatorId && !BeeProfiles.isZero(obj.creatorId) && obj.creatorId !== obj.ownerId) {
      add('Creator profile', true, function () { openProfile(obj.creatorId); });
    }
    const copyItem = function (label, value, what) {
      if (!value) return;
      add(label, true, function () {
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(value).then(function () {
          BeeUtils.showToast(what + ' copied', 'success');
        }).catch(function () {});
      });
    };
    copyItem('Copy name', obj.name, 'Name');
    copyItem('Copy UUID', obj.id, 'UUID');
    menu.hidden = false;
    // At the pointer, the way the buddies and radar menus open, but kept on screen.
    const rect = menu.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX, window.innerWidth - rect.width - 8));
    const y = Math.max(0, Math.min(e.clientY, window.innerHeight - rect.height - 8));
    menu.style.left = Math.round(x) + 'px';
    menu.style.top = Math.round(y) + 'px';
  }

  // Pay needs FLAGS_TAKES_MONEY and a non-blocking PayPriceReply when we have one.
  function canPayNow(obj) {
    if (!obj.canPay) return false;
    const price = payPrices[obj.id];
    return !price || price.payable !== false;
  }

  function permText(mask, decoded) {
    if (decoded) return decoded;
    const m = Number(mask) || 0;
    const parts = [];
    if (m & 0x00004000) parts.push('modify');
    if (m & 0x00008000) parts.push('copy');
    if (m & 0x00002000) parts.push('transfer');
    return parts.length ? parts.join(', ') : 'none';
  }

  function detailRow(label, value) {
    if (value === undefined || value === null || value === '') return '';
    return '<div class="profile-field"><span class="profile-field__label">' +
      BeeUtils.escapeHtml(label) + '</span><span>' + BeeUtils.escapeHtml(String(value)) + '</span></div>';
  }

  // The same row, but the value opens a profile. Used for owner, creator and last owner:
  // a key on its own is no use, and a name you can't click is only half of one.
  function personRow(label, id) {
    if (!id || BeeProfiles.isZero(id)) return '';
    const text = ownerLabel(id) || id;
    const isGroup = !!(BeeTransport.getGroupName && BeeTransport.getGroupName(id)) ||
      (typeof BeeProfiles !== 'undefined' && BeeProfiles.getGroupName && BeeProfiles.getGroupName(id));
    return '<div class="profile-field"><span class="profile-field__label">' +
      BeeUtils.escapeHtml(label) + '</span><span><a href="#" class="settings-link" ' +
      'data-profile-id="' + BeeUtils.escapeHtml(id) + '" ' +
      'data-profile-kind="' + (isGroup ? 'group' : 'avatar') + '">' +
      BeeUtils.escapeHtml(text) + '</a></span></div>';
  }

  function groupRow(label, id) {
    if (!id || BeeProfiles.isZero(id)) return '';
    return '<div class="profile-field"><span class="profile-field__label">' +
      BeeUtils.escapeHtml(label) + '</span><span><a href="#" class="settings-link" ' +
      'data-profile-id="' + BeeUtils.escapeHtml(id) + '" data-profile-kind="group">' +
      BeeUtils.escapeHtml(groupLabel(id)) + '</a></span></div>';
  }

  function openProfile(id, kind?) {
    if (!id || typeof BeeProfile === 'undefined') return;
    if (kind === 'group' || (BeeTransport.getGroupName && BeeTransport.getGroupName(id)) ||
        (typeof BeeProfiles !== 'undefined' && BeeProfiles.getGroupName && BeeProfiles.getGroupName(id))) {
      if (BeeProfile.openGroup) BeeProfile.openGroup(id);
      return;
    }
    if (BeeProfile.openAvatar) BeeProfile.openAvatar(id);
  }

  // Everything expensive happens here and nowhere else: the capability calls
  // (GetObjectCost for land impact, ObjectMedia for media URLs) and the brief select
  // that makes the sim tell us the creator and creation date. One object, once, when
  // you ask - the list itself never triggers any of it, and none of it re-polls.
  const detailExtra = {}; // object id -> cap results, so reopening costs nothing

  function closeDetails() {
    openDetailId = '';
    const dlg = document.getElementById('objects-detail') as HTMLDialogElement | null;
    if (dlg && dlg.open) dlg.close();
  }

  function showDetails(obj) {
    const dlg = document.getElementById('objects-detail') as HTMLDialogElement | null;
    if (!dlg) return;
    openDetailId = obj.id;
    if (!dlg.open) dlg.showModal();
    paintDetails(obj, null);
    invoke('sl_object_details', { objectId: obj.id }).catch(function () {});
    // Creator and creation date only come with a selection.
    invoke('sl_object_select', { localId: obj.localId }).catch(function () {});
    // And ask what it charges, so the Pay button knows whether to offer anything.
    if (!payPrices[obj.id]) {
      invoke('sl_request_pay_price', { objectId: obj.id }).catch(function () {});
    }
    if (detailExtra[obj.id]) {
      paintDetails(obj, detailProps[obj.id] || null);
    } else {
      invoke('sl_object_extra', { objectId: obj.id }).then(function (extra) {
        if (!extra) return;
        detailExtra[obj.id] = extra;
        if (openDetailId === obj.id) paintDetails(obj, detailProps[obj.id] || null);
      }).catch(function () { /* land impact and media are best-effort */ });
    }
  }

  const detailProps = {}; // object id -> latest ObjectProperties(Family) reply
  const payPrices = {};   // object id -> PayPriceReply (suggested amounts)

  // Paying money always goes through an explicit confirmation naming the object and
  // the amount. Amounts come from the object itself (PayPriceReply) rather than being
  // typed, so there's no chance of a slipped digit.
  function payObject(obj) {
    const price = payPrices[obj.id];
    if (!price) {
      // Ask, then let the reply reopen this with real choices.
      invoke('sl_request_pay_price', { objectId: obj.id }).catch(function () {});
      BeeUtils.showToast('Asking the object what it charges...', 'info');
      return;
    }
    if (!price.payable) {
      BeeUtils.showToast('This object is not asking for payment.', 'warning');
      return;
    }
    const amounts = [];
    if (price.defaultPrice > 0) amounts.push(price.defaultPrice);
    (price.suggested || []).forEach(function (v) {
      if (amounts.indexOf(v) === -1) amounts.push(v);
    });
    // An object can be payable while suggesting nothing (PAY_PRICE_DEFAULT), which is
    // how most tip jars behave - so there has to be a way to name an amount.
    if (!amounts.length && price.allowCustom) {
      askCustomAmount(obj);
      return;
    }
    const menu = document.getElementById('context-menu');
    if (!menu) return;
    menu.innerHTML = '';
    amounts.forEach(function (amount) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Pay L$ ' + amount;
      b.addEventListener('click', function () {
        menu.hidden = true;
        sendPay(obj, amount);
      });
      menu.appendChild(b);
    });
    if (price.allowCustom) {
      const other = document.createElement('button');
      other.type = 'button';
      other.textContent = 'Other amount...';
      other.addEventListener('click', function () {
        menu.hidden = true;
        askCustomAmount(obj);
      });
      menu.appendChild(other);
    }
    menu.hidden = false;
    const pane = document.getElementById('interact-pane-objects');
    const box = pane ? pane.getBoundingClientRect() : { left: 20, top: 80 };
    menu.style.left = Math.round(box.left + 20) + 'px';
    menu.style.top = Math.round(box.top + 60) + 'px';
  }

  // Type an amount, then confirm it. The input is inside the detail view rather than
  // a browser prompt, and the confirmation still names the object and the amount.
  function askCustomAmount(obj) {
    const dlg = document.getElementById('objects-detail') as HTMLDialogElement | null;
    if (!dlg || !dlg.open || openDetailId !== obj.id) {
      showDetails(obj);
    }
    const row = document.getElementById('objects-pay-row');
    if (!row) return;
    row.hidden = false;
    const input = document.getElementById('objects-pay-amount') as HTMLInputElement | null;
    if (input) {
      input.value = '';
      input.focus();
    }
  }

  async function sendPay(obj, amount) {
    const value = Math.floor(Number(amount));
    if (!Number.isFinite(value) || value < 1) {
      BeeUtils.showToast('Enter an amount of L$ 1 or more.', 'warning');
      return;
    }
    const ok = await BeeUtils.confirm({
      title: 'Pay this object?',
      message: 'Pay L$ ' + value + ' to "' + (obj.name || 'object') + '"? This cannot be undone.',
      confirmLabel: 'Pay L$ ' + value,
      danger: true
    });
    if (!ok) return;
    invoke('sl_object_pay', { objectId: obj.id, amount: value, objectName: obj.name || '' })
      .then(function () { BeeUtils.showToast('Paid L$ ' + value + '.', 'success'); })
      .catch(function (err) {
        BeeUtils.showToast((err && err.message) || 'Payment failed.', 'error');
      });
  }

  // Creation time is whole seconds since the epoch; anything else means unknown.
  function formatCreated(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n * 1000);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(); } catch (_e) { return ''; }
  }

  function paintDetails(obj, props) {
    const host = document.getElementById('objects-detail-body');
    if (!host || openDetailId !== obj.id) return;
    const p = props || detailProps[obj.id] || {};
    const extra = detailExtra[obj.id] || {};
    const pos = obj.position || {};
    host.innerHTML =
      '<div class="objects-detail__head">' +
        '<h4 class="profile-split__title">' + BeeUtils.escapeHtml(p.name || obj.name || '(unnamed)') + '</h4>' +
        '<button type="button" class="btn btn--ghost btn--sm" id="objects-detail-close">Close</button>' +
      '</div>' +
      (p.description || obj.description
        ? '<p class="objects-detail__desc">' + BeeUtils.escapeHtml(p.description || obj.description) + '</p>'
        : '') +
      '<div class="objects-detail__fields">' +
        detailRow('Position', Math.round(pos.x) + ', ' + Math.round(pos.y) + ', ' + Math.round(pos.z)) +
        detailRow('Distance', obj.distance.toFixed(1) + ' m') +
        personRow('Owner', p.ownerId || obj.ownerId) +
        (p.groupId && !BeeProfiles.isZero(p.groupId) ? groupRow('Group', p.groupId) : '') +
        personRow('Last owner', p.lastOwnerId) +
        detailRow('You may', props ? permText(p.everyoneMask, p.everyonePerms) : '') +
        detailRow('Next owner may', props ? permText(p.nextOwnerMask, p.nextOwnerPerms) : '') +
        detailRow('For sale', obj.forSale ? 'L$ ' + obj.salePrice : (props ? 'no' : '')) +
        personRow('Creator', p.creatorId || obj.creatorId) +
        detailRow('Created', formatCreated(p.creationDate)) +
        detailRow('Land impact', extra.landImpact) +
        detailRow('Physics cost', extra.physicsCost) +
        detailRow('Object key', obj.id) +
        mediaHtml(extra.media) +
      '</div>' +
      '<div class="interact-actions objects-detail__actions">' +
        // Same rule as the row menu: only offer what the object handles, and drop Pay
        // outright once the object has said it wants nothing - a button that can only
        // ever refuse is worse than no button.
        (obj.canTouch
          ? '<button type="button" class="btn btn--secondary btn--sm" data-obj-action="touch">Touch</button>'
          : '') +
        (!isAttachmentObject(obj)
          ? '<button type="button" class="btn btn--secondary btn--sm" data-obj-action="sit"' +
            (state.sitting && sittingOn === obj.id ? ' disabled' : '') + '>Sit on</button>'
          : '') +
        (canPayNow(obj)
          ? '<button type="button" class="btn btn--secondary btn--sm" data-obj-action="pay">' +
            (payPrices[obj.id] && payPrices[obj.id].defaultPrice > 0
              ? 'Pay L$ ' + payPrices[obj.id].defaultPrice + '...'
              : 'Pay...') + '</button>'
          : '') +
      '</div>' +
      '<div class="interact-actions" id="objects-pay-row" hidden>' +
        '<input type="number" id="objects-pay-amount" class="settings-control__select" ' +
          'min="1" step="1" placeholder="L$ amount" inputmode="numeric">' +
        '<button type="button" class="btn btn--primary btn--sm" id="objects-pay-send">Pay</button>' +
      '</div>' +
      (props && extra.ok ? '' : '<p class="settings-note">Still gathering details...</p>');

    const close = document.getElementById('objects-detail-close');
    if (close) close.addEventListener('click', closeDetails);
    // The same actions as the row menu, since they're handy right here too.
    host.querySelectorAll<HTMLElement>('[data-obj-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const act = btn.dataset.objAction;
        if (act === 'touch') {
          invoke('sl_object_touch', { localId: obj.localId })
            .catch(function () { BeeUtils.showToast('Could not touch that.', 'warning'); });
        } else if (act === 'sit') {
          requestSit(obj);
        } else {
          payObject(obj);
        }
      });
    });
    const paySend = document.getElementById('objects-pay-send');
    if (paySend) {
      paySend.addEventListener('click', function () {
        const input = document.getElementById('objects-pay-amount') as HTMLInputElement | null;
        sendPay(obj, input ? input.value : 0);
      });
    }
    // Owner / creator / group open their profile, the way names do everywhere else.
    host.querySelectorAll<HTMLElement>('[data-profile-id]').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        openProfile(link.dataset.profileId, link.dataset.profileKind);
      });
    });
    // Media URLs open in the browser rather than inside the viewer.
    host.querySelectorAll<HTMLElement>('[data-media-url]').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        const url = link.dataset.mediaUrl;
        if (typeof BeeSlurl !== 'undefined' && BeeSlurl.openExternalUrl) BeeSlurl.openExternalUrl(url);
        else window.open(url, '_blank', 'noopener,noreferrer');
      });
    });
    if (p.groupId && !BeeProfiles.isZero(p.groupId)) queueGroupResolve(p.groupId);
  }

  // Media-on-a-prim entries arrive as "face|url" so we can say which side it's on.
  function mediaHtml(list) {
    if (!Array.isArray(list) || !list.length) return '';
    const rows = list.map(function (entry) {
      const split = String(entry).indexOf('|');
      const face = split > 0 ? String(entry).slice(0, split) : '';
      const url = split > 0 ? String(entry).slice(split + 1) : String(entry);
      return '<div class="profile-field"><span class="profile-field__label">Media' +
        (face ? ' (face ' + BeeUtils.escapeHtml(face) + ')' : '') + '</span>' +
        '<span><a href="#" class="settings-link" data-media-url="' + BeeUtils.escapeHtml(url) + '">' +
        BeeUtils.escapeHtml(url) + '</a></span></div>';
    });
    return rows.join('');
  }

  // Nothing loads or refreshes on its own - the user presses Load. The core tracks
  // objects continuously anyway, so this only reads the table it already has.
  function startScan() {
    if (!BeeState.gridOnline()) return;
    invoke('sl_object_scan', { enable: true }).catch(function () {});
  }

  function activate() {
    refreshState();
    startScan();
    // Draw the list as soon as the panel shows, so the "press Load" note is there to be
    // read - it used to appear only after the first Load, which is the one moment it
    // isn't any use.
    renderObjects();
  }

  function deactivate() {
    closeDetails();
  }

  function init() {
    const bind = function (id, cmd, args, failure) {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', function () { run(cmd, args, failure); });
    };
    bind('interact-sit-ground', 'sl_sit_ground', {}, 'Could not sit down.');
    bind('interact-stand', 'sl_stand_up', {}, 'Could not stand up.');
    bind('interact-fly', 'sl_set_flying', { flying: true }, 'Could not start flying.');
    bind('interact-stop-fly', 'sl_set_flying', { flying: false }, 'Could not stop flying.');

    const refreshBtn = document.getElementById('objects-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshObjects);

    // How far to look. Remembered, so it's set once rather than every session.
    const rangeBox = document.getElementById('objects-range') as HTMLSelectElement | null;
    if (rangeBox) {
      const saved = typeof BeeSettings !== 'undefined' ? Number(BeeSettings.get('objectsRange')) : 0;
      if (RANGE_CHOICES.indexOf(saved) !== -1) range = saved;
      rangeBox.value = String(range);
      rangeBox.addEventListener('change', function () { setRange(rangeBox.value); });
    }

    // Filtering is local to the rows we already have - it sends nothing.
    const filterBox = document.getElementById('objects-filter') as HTMLInputElement | null;
    if (filterBox) {
      filterBox.addEventListener('input', BeeUtils.debounce(function () {
        filterText = filterBox.value.trim();
        renderObjects();
      }, 150));
    }

    function initTypeFilter(id, key, getValue, setValue) {
      const box = document.getElementById(id) as HTMLInputElement;
      if (!box) return;
      if (typeof BeeSettings !== 'undefined') {
        const saved = BeeSettings.get(key);
        if (typeof saved === 'boolean') setValue(saved);
      }
      box.checked = getValue();
      box.addEventListener('change', function () {
        if (objectsLoadBusy) return;
        setValue(box.checked);
        if (typeof BeeSettings !== 'undefined') BeeSettings.set(key, box.checked);
        if (loaded) refreshObjects();
        else renderObjects();
      });
    }

    initTypeFilter(
      'objects-include-attachments',
      'objectsIncludeAttachments',
      function () { return includeAttachments; },
      function (v) { includeAttachments = v; }
    );
    initTypeFilter(
      'objects-include-physical',
      'objectsIncludePhysical',
      function () { return includePhysical; },
      function (v) { includePhysical = v; }
    );

    // When range or type filters change in Bee -> Settings, mirror them here.
    if (typeof BeeSettings !== 'undefined' && BeeSettings.onChange) {
      BeeSettings.onChange(function (key, value) {
        if (key === 'objectsRange') {
          const next = Number(value);
          if (RANGE_CHOICES.indexOf(next) === -1) return;
          if (rangeBox) rangeBox.value = String(next);
          setRange(next);
        } else if (key === 'objectsIncludeAttachments') {
          includeAttachments = !!value;
          const box = document.getElementById('objects-include-attachments') as HTMLInputElement | null;
          if (box) box.checked = includeAttachments;
          if (objectsLoadBusy) return;
          if (loaded) refreshObjects();
          else renderObjects();
        } else if (key === 'objectsIncludePhysical') {
          includePhysical = !!value;
          const box = document.getElementById('objects-include-physical') as HTMLInputElement | null;
          if (box) box.checked = includePhysical;
          if (objectsLoadBusy) return;
          if (loaded) refreshObjects();
          else renderObjects();
        }
      });
    }

    // Escape or the backdrop closes the detail window; keep our own state in step.
    const dlg = document.getElementById('objects-detail') as HTMLDialogElement | null;
    if (dlg) {
      dlg.addEventListener('close', function () { openDetailId = ''; });
      dlg.addEventListener('click', function (e) {
        if (e.target === dlg) closeDetails(); // a click on the backdrop, not the card
      });
    }

    document.querySelectorAll<HTMLElement>('[data-objects-sort]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const key = btn.dataset.objectsSort;
        // Clicking the active column flips the direction, like any other table.
        if (key === sortKey) sortAsc = !sortAsc;
        else { sortKey = key; sortAsc = true; }
        renderObjects();
      });
    });

    // Object properties come back asynchronously; update the list row and, if it's
    // the one being examined, the open detail view. A batch of a hundred replies means a
    // hundred of these events, so the list repaint is coalesced - repainting per reply
    // would rebuild the whole table a hundred times over.
    if (typeof BeeTransport !== 'undefined' && BeeTransport.on) {
      const repaintSoon = BeeUtils.debounce(renderObjects, 120);
      BeeTransport.on('object-properties', function (props) {
        if (!props || !props.id) return;
        const row = objects.find(function (o) {
          return o.id && o.id.toLowerCase() === String(props.id).toLowerCase();
        });
        if (!row) return;
        if (props.name) row.name = props.name;
        if (props.ownerId) row.ownerId = props.ownerId;
        if (props.creatorId) row.creatorId = props.creatorId;
        // An object's group is usually one we're not in, so membership never named it.
        if (props.groupId && !BeeProfiles.isZero(props.groupId)) {
          queueGroupResolve(props.groupId);
        }
        // Merge, because the Family reply and the full one carry different fields.
        detailProps[row.id] = Object.assign({}, detailProps[row.id], props);
        repaintSoon();
        if (openDetailId === row.id) paintDetails(row, detailProps[row.id]);
      });
      BeeTransport.on('pay-price', function (price) {
        if (!price || !price.id) return;
        payPrices[price.id] = price;
        const row = objects.find(function (o) {
          return o.id && o.id.toLowerCase() === String(price.id).toLowerCase();
        });
        if (row && openDetailId === row.id) paintDetails(row, detailProps[row.id] || null);
      });
      // A teleport means a different set of objects, and the core drops its table on
      // arrival - so clear the list rather than leave the old region's rows sitting
      // there with distances that no longer mean anything.
      BeeTransport.on('teleport-finish', function () {
        objectsLoadBusy = false;
        setObjectsControlsBusy(false);
        entries = [];
        objects = [];
        loaded = false;
        Object.keys(expandedRoots).forEach(function (k) { delete expandedRoots[k]; });
        lastScan = { pending: 0, tracked: 0, cached: 0, nearest: -1, roots: 0, unresolvedParents: 0, attachmentsTracked: 0, attachmentsInRange: 0, interest360: true };
        closeDetails();
        renderObjects();
      });
      // Owner and creator names resolve after the fact; repaint so the labels replace
      // the "resolving..." placeholders and the ids.
      const repaintNames = function () {
        if (objects.length) repaintSoon();
        if (!openDetailId) return;
        const row = objects.find(function (o) { return o.id === openDetailId; });
        if (row) paintDetails(row, detailProps[row.id] || null);
      };
      BeeTransport.on('names-updated', repaintNames);
      // Group names arrive on their own event, and the details window shows one.
      BeeTransport.on('group-names', repaintNames);
    }
    if (typeof BeeProfiles !== 'undefined' && BeeProfiles.onChange) {
      BeeProfiles.onChange(function (evt) {
        if (!evt || (evt.kind !== 'group' && evt.kind !== 'membership')) return;
        if (!openDetailId) return;
        const row = objects.find(function (o) { return o.id === openDetailId; });
        if (row) paintDetails(row, detailProps[row.id] || null);
      });
    }

    // Stop scanning when the user navigates away from the Interactions panel.
    BeeState.on('tab', function (tab) {
      if (tab !== 'interact') deactivate();
    });

    // The core tells us when something else seats us (AvatarSitResponse), e.g. an
    // object we clicked or a script that sat us down.
    if (typeof BeeTransport !== 'undefined' && BeeTransport.on) {
      BeeTransport.on('sit-state', function (data) {
        if (data && typeof data.sitting === 'boolean') {
          state.sitting = data.sitting;
          if (!data.sitting) sittingOn = '';
          else if (data.objectId) sittingOn = data.objectId;
          // Any verdict ends the pending state; a refusal carries the reason.
          sitPendingOn = '';
          if (!data.sitting && data.error) {
            BeeUtils.showToast(data.error, 'warning');
          }
          paint();
        }
      });
    }
    // A fresh session starts standing, and losing one clears the buttons.
    BeeState.on('change', function (partial) {
      if (partial.connected === true) {
        state = { sitting: false, flying: false };
      }
      if (partial.connected !== undefined || partial.sessionLost !== undefined) paint();
    });
    BeeState.on('reset', function () {
      state = { sitting: false, flying: false };
      sittingOn = '';
      objects = [];
      loaded = false;
      Object.keys(expandedRoots).forEach(function (k) { delete expandedRoots[k]; });
      lastScan = { pending: 0, tracked: 0, cached: 0, nearest: -1, roots: 0, unresolvedParents: 0, attachmentsTracked: 0, attachmentsInRange: 0, interest360: true };
      filterText = '';
      const box = document.getElementById('objects-filter') as HTMLInputElement | null;
      if (box) box.value = '';
      closeDetails();
      paint();
    });
    paint();
  }

  return { init: init, activate: activate, refreshState: refreshState };
})();

window.BeeInteract = BeeInteract;
