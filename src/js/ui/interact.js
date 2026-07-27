/**
 * Interactions panel: what's nearby, and what your avatar can do.
 *
 */
const FSInteract = (function () {
  'use strict';

  let state = { sitting: false, flying: false };

  function invoke(cmd, args) {
    if (typeof FSBridge === 'undefined' || !FSBridge.invoke) {
      return Promise.reject(new Error('Native bridge unavailable'));
    }
    return FSBridge.invoke(cmd, args || {});
  }

  function describe() {
    if (state.sitting) return 'sitting';
    if (state.flying) return 'flying';
    return 'standing';
  }

  function paint() {
    const label = document.getElementById('interact-state');
    if (label) label.textContent = describe();
    const online = FSState.gridOnline();
    const set = function (id, enabled) {
      const btn = document.getElementById(id);
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
    if (!FSState.gridOnline()) {
      FSUtils.showToast('Not connected to the grid', 'warning');
      return;
    }
    invoke(cmd, args).then(applyResult).catch(function () {
      FSUtils.showToast(failure, 'warning');
    });
  }

  function refreshState() {
    invoke('sl_avatar_state').then(applyResult).catch(function () { /* keep what we have */ });
  }

  const RANGE_CHOICES = [16, 32, 48, 64, 96, 128];
  const DEFAULT_RANGE = 32;
  let range = DEFAULT_RANGE;
  let objects = [];
  let sortKey = 'distance';
  let sortAsc = true;
  /// True once Load has been pressed here, so an empty list can say why it's empty.
  let loaded = false;
  /// Matches name or creator, both at once - see `matchesFilter`.
  let filterText = '';
  let openDetailId = '';
  /// Which object we're sitting on, when we are - so "Sit on" can be out for that one row.
  let sittingOn = '';

  // Owners we've already asked the sim to name, so a repaint can't turn into a stream
  // of requests. Names arrive on 'names-updated' and the list repaints itself.
  const namesAsked = {};

  // The plain name of whoever holds this key, or '' if we don't know yet. Deliberately
  // no placeholder text: `matchesFilter` compares against this, and a placeholder would
  // mean typing "res" matched every unresolved row.
  function nameOf(id) {
    if (!id || FSProfiles.isZero(id)) return '';
    const cached = FSTransport.getCachedName ? FSTransport.getCachedName(id) : '';
    if (cached) return cached;
    // An object can belong to a group, and group names live in a different cache.
    return FSTransport.getGroupName ? FSTransport.getGroupName(id) : '';
  }

  // What the list shows: "Display Name (username)" where the resident has set one, the
  // same shape the buddies and radar lists use.
  function ownerLabel(id) {
    if (!id || FSProfiles.isZero(id)) return '';
    const info = FSTransport.getCachedNameInfo ? FSTransport.getCachedNameInfo(id) : null;
    if (info && (info.displayName || info.userName || info.label)) {
      const lines = FSUtils.agentNameLines({
        displayName: info.displayName || '',
        userName: info.userName || info.label || '',
        name: info.label || ''
      });
      return lines.subtitle ? lines.title + ' (' + lines.subtitle + ')' : lines.title;
    }
    const group = FSTransport.getGroupName ? FSTransport.getGroupName(id) : '';
    return group || 'resolving...';
  }

  // Ask about the owners and creators we don't have names for yet.
  //
  // Through FSTransport.queueNameResolve, so it takes the same route as every other
  // list: the GetDisplayNames cap first (which is what gives us display names rather
  // than bare usernames), falling back to UUIDNameRequest in the core. One batch per
  // Load, never per row and never on a timer.
  function resolveOwners() {
    const wanted = [];
    const want = function (id) {
      if (!id || FSProfiles.isZero(id) || namesAsked[id]) return;
      if (nameOf(id)) return;
      namesAsked[id] = true;
      wanted.push(id);
    };
    objects.forEach(function (obj) {
      want(obj.ownerId);
      want(obj.creatorId);
    });
    if (!wanted.length) return;
    if (FSTransport.queueNameResolve) FSTransport.queueNameResolve(wanted);
    else invoke('sl_resolve_names', { ids: wanted }).catch(function () {});
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
    if (!id || FSProfiles.isZero(id)) return '';
    const info = FSTransport.getCachedNameInfo ? FSTransport.getCachedNameInfo(id) : null;
    if (!info) return nameOf(id);
    return [info.label, info.userName, info.displayName].filter(Boolean).join(' ');
  }

  function visibleObjects() {
    return objects.filter(matchesFilter);
  }

  function sortObjects() {
    const dir = sortAsc ? 1 : -1;
    objects.sort(function (a, b) {
      if (sortKey === 'distance') return (a.distance - b.distance) * dir;
      const av = sortKey === 'owner' ? ownerLabel(a.ownerId) : (a.name || '');
      const bv = sortKey === 'owner' ? ownerLabel(b.ownerId) : (b.name || '');
      return av.toLowerCase().localeCompare(bv.toLowerCase()) * dir;
    });
  }

  function renderObjects() {
    const host = document.getElementById('objects-rows');
    if (!host) return;
    sortObjects();
    const shown = visibleObjects();
    host.innerHTML = '';
    if (!shown.length) {
      host.innerHTML = !loaded
        ? '<p class="settings-note">Press <strong>Load</strong> to list the objects around you.</p>'
        : filterText
          ? '<p class="settings-note">Nothing here matches "' + FSUtils.escapeHtml(filterText) + '".</p>'
          : '<p class="settings-note">Nothing within ' + range + 'm. The region may still be ' +
            'describing itself - give it a moment and press <strong>Load</strong> again.</p>';
    }
    shown.forEach(function (obj) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'objects-row objects-row--item';
      row.setAttribute('role', 'row');
      row.innerHTML =
        '<span class="objects-cell objects-cell--num">' + obj.distance.toFixed(1) + ' m</span>' +
        '<span class="objects-cell">' + FSUtils.escapeHtml(obj.name || '(unnamed)') + '</span>' +
        '<span class="objects-cell">' + FSUtils.escapeHtml(ownerLabel(obj.ownerId) || '-') + '</span>';
      // stopPropagation matters: other panels hide the shared menu on any document
      // click, so without it the menu opened and closed again in the same event.
      row.addEventListener('click', function (e) {
        e.stopPropagation();
        showRowMenu(e, obj);
      });
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault(); // and so the general edit menu leaves this alone
        e.stopPropagation();
        showRowMenu(e, obj);
      });
      host.appendChild(row);
    });
    // The count belongs in the heading rather than trailing off behind the button.
    const title = document.getElementById('objects-title');
    if (title) {
      if (!objects.length) {
        title.textContent = 'Nearby objects';
      } else if (shown.length !== objects.length) {
        title.textContent = 'Nearby objects (' + shown.length + ' of ' + objects.length +
          ' within ' + range + 'm)';
      } else {
        title.textContent = 'Nearby objects (' + objects.length + ' within ' + range + 'm)';
      }
    }
    document.querySelectorAll('[data-objects-sort]').forEach(function (btn) {
      btn.classList.toggle('objects-sort--active', btn.dataset.objectsSort === sortKey);
    });
  }

  // Load, and only when asked. Reads the table the core already keeps - no polling.
  //
  // `pending` is how many of those rows are still waiting on the sim to say what they
  // are. The core asks about all of them, paced, so they fill in over the next few
  // seconds without another press.
  function refreshObjects() {
    if (!FSState.gridOnline()) return;
    invoke('sl_nearby_objects', { range: range }).then(function (res) {
      objects = (res && res.objects) || [];
      loaded = true;
      resolveOwners();
      renderObjects();
      const pending = res && res.pending;
      if (pending > 0) {
        FSUtils.showToast('Naming ' + pending + ' object' + (pending === 1 ? '' : 's') + '...', 'info');
      }
    }).catch(function () {
      FSUtils.showToast('Could not read the nearby objects.', 'warning');
    });
  }

  function setRange(metres) {
    const next = RANGE_CHOICES.indexOf(Number(metres)) !== -1 ? Number(metres) : DEFAULT_RANGE;
    if (next === range) return;
    range = next;
    if (typeof FSSettings !== 'undefined') FSSettings.set('objectsRange', range);
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
    // Touch and Pay appear only when the object actually handles them. The sim says so
    // in the update's flags, and that's the same test the reference makes in
    // enable_object_touch / enable_pay_object - so an entry that's here will do
    // something, and one that isn't wouldn't have.
    if (obj.canTouch) {
      add('Touch', true, function () {
        invoke('sl_object_touch', { localId: obj.localId })
          .catch(function () { FSUtils.showToast('Could not touch that.', 'warning'); });
      });
    }
    // "By default, we can sit on anything" (llinspectobject.cpp), so this is only out
    // when we're already sitting on this very object.
    add('Sit on', !(state.sitting && sittingOn === obj.id), function () {
      invoke('sl_object_sit', { objectId: obj.id }).then(function () {
        state.sitting = true;
        sittingOn = obj.id;
        paint();
      }).catch(function () { FSUtils.showToast('Could not sit on that.', 'warning'); });
    });
    if (canPayNow(obj)) {
      add('Pay...', true, function () { payObject(obj); });
    }
    // Whoever it belongs to, and whoever made it, are people you may want to look up.
    if (obj.ownerId && !FSProfiles.isZero(obj.ownerId)) {
      add('Owner profile', true, function () { openProfile(obj.ownerId); });
    }
    if (obj.creatorId && !FSProfiles.isZero(obj.creatorId) && obj.creatorId !== obj.ownerId) {
      add('Creator profile', true, function () { openProfile(obj.creatorId); });
    }
    menu.hidden = false;
    // At the pointer, the way the buddies and radar menus open, but kept on screen.
    const rect = menu.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX, window.innerWidth - rect.width - 8));
    const y = Math.max(0, Math.min(e.clientY, window.innerHeight - rect.height - 8));
    menu.style.left = Math.round(x) + 'px';
    menu.style.top = Math.round(y) + 'px';
  }

  // Two sources agree before we offer to pay: the sim's FLAGS_TAKES_MONEY on the update
  // (what the reference's enable_pay_object checks), and PayPriceReply if it has come
  // back. Either one saying no means no button at all.
  function canPayNow(obj) {
    if (!obj.canPay) return false;
    const price = payPrices[obj.id];
    return !price || price.payable !== false;
  }

  function permText(mask) {
    // Permission bits from llpermissionsflags.h.
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
      FSUtils.escapeHtml(label) + '</span><span>' + FSUtils.escapeHtml(String(value)) + '</span></div>';
  }

  // The same row, but the value opens a profile. Used for owner, creator and last owner:
  // a key on its own is no use, and a name you can't click is only half of one.
  function personRow(label, id) {
    if (!id || FSProfiles.isZero(id)) return '';
    const text = ownerLabel(id) || id;
    const isGroup = !!(FSTransport.getGroupName && FSTransport.getGroupName(id));
    return '<div class="profile-field"><span class="profile-field__label">' +
      FSUtils.escapeHtml(label) + '</span><span><a href="#" class="settings-link" ' +
      'data-profile-id="' + FSUtils.escapeHtml(id) + '" ' +
      'data-profile-kind="' + (isGroup ? 'group' : 'avatar') + '">' +
      FSUtils.escapeHtml(text) + '</a></span></div>';
  }

  function openProfile(id, kind) {
    if (!id || typeof FSProfile === 'undefined') return;
    if (kind === 'group' || (FSTransport.getGroupName && FSTransport.getGroupName(id))) {
      if (FSProfile.openGroup) FSProfile.openGroup(id);
      return;
    }
    if (FSProfile.openAvatar) FSProfile.openAvatar(id);
  }

  // Everything expensive happens here and nowhere else: the capability calls
  // (GetObjectCost for land impact, ObjectMedia for media URLs) and the brief select
  // that makes the sim tell us the creator and creation date. One object, once, when
  // you ask - the list itself never triggers any of it, and none of it re-polls.
  const detailExtra = {}; // object id -> cap results, so reopening costs nothing

  function closeDetails() {
    openDetailId = '';
    const dlg = document.getElementById('objects-detail');
    if (dlg && dlg.open) dlg.close();
  }

  function showDetails(obj) {
    const dlg = document.getElementById('objects-detail');
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
      FSUtils.showToast('Asking the object what it charges...', 'info');
      return;
    }
    if (!price.payable) {
      FSUtils.showToast('This object is not asking for payment.', 'warning');
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
    const dlg = document.getElementById('objects-detail');
    if (!dlg || !dlg.open || openDetailId !== obj.id) {
      showDetails(obj);
    }
    const row = document.getElementById('objects-pay-row');
    if (!row) return;
    row.hidden = false;
    const input = document.getElementById('objects-pay-amount');
    if (input) {
      input.value = '';
      input.focus();
    }
  }

  async function sendPay(obj, amount) {
    const value = Math.floor(Number(amount));
    if (!Number.isFinite(value) || value < 1) {
      FSUtils.showToast('Enter an amount of L$ 1 or more.', 'warning');
      return;
    }
    const ok = await FSUtils.confirm({
      title: 'Pay this object?',
      message: 'Pay L$ ' + value + ' to "' + (obj.name || 'object') + '"? This cannot be undone.',
      confirmLabel: 'Pay L$ ' + value,
      danger: true
    });
    if (!ok) return;
    invoke('sl_object_pay', { objectId: obj.id, amount: value, objectName: obj.name || '' })
      .then(function () { FSUtils.showToast('Paid L$ ' + value + '.', 'success'); })
      .catch(function (err) {
        FSUtils.showToast((err && err.message) || 'Payment failed.', 'error');
      });
  }

  // The core hands over whole seconds since the epoch (it divides the sim's
  // microseconds down, as the reference does). Anything else means the sim hasn't told
  // us yet, so show nothing rather than an invalid date.
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
        '<h4 class="profile-split__title">' + FSUtils.escapeHtml(p.name || obj.name || '(unnamed)') + '</h4>' +
        '<button type="button" class="btn btn--ghost btn--sm" id="objects-detail-close">Close</button>' +
      '</div>' +
      (p.description || obj.description
        ? '<p class="objects-detail__desc">' + FSUtils.escapeHtml(p.description || obj.description) + '</p>'
        : '') +
      '<div class="objects-detail__fields">' +
        detailRow('Position', Math.round(pos.x) + ', ' + Math.round(pos.y) + ', ' + Math.round(pos.z)) +
        detailRow('Distance', obj.distance.toFixed(1) + ' m') +
        personRow('Owner', p.ownerId || obj.ownerId) +
        (p.groupId && !FSProfiles.isZero(p.groupId) ? personRow('Group', p.groupId) : '') +
        personRow('Last owner', p.lastOwnerId) +
        detailRow('You may', props ? permText(p.everyoneMask) : '') +
        detailRow('Next owner may', props ? permText(p.nextOwnerMask) : '') +
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
        '<button type="button" class="btn btn--secondary btn--sm" data-obj-action="sit"' +
          (state.sitting && sittingOn === obj.id ? ' disabled' : '') + '>Sit on</button>' +
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
    host.querySelectorAll('[data-obj-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const act = btn.dataset.objAction;
        if (act === 'touch') {
          invoke('sl_object_touch', { localId: obj.localId })
            .catch(function () { FSUtils.showToast('Could not touch that.', 'warning'); });
        } else if (act === 'sit') {
          invoke('sl_object_sit', { objectId: obj.id }).then(function () {
            state.sitting = true;
            sittingOn = obj.id;
            paint();
          }).catch(function () { FSUtils.showToast('Could not sit on that.', 'warning'); });
        } else {
          payObject(obj);
        }
      });
    });
    const paySend = document.getElementById('objects-pay-send');
    if (paySend) {
      paySend.addEventListener('click', function () {
        const input = document.getElementById('objects-pay-amount');
        sendPay(obj, input ? input.value : 0);
      });
    }
    // Owner / creator / group open their profile, the way names do everywhere else.
    host.querySelectorAll('[data-profile-id]').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        openProfile(link.dataset.profileId, link.dataset.profileKind);
      });
    });
    // Media URLs open in the browser rather than inside the viewer.
    host.querySelectorAll('[data-media-url]').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        const url = link.dataset.mediaUrl;
        if (typeof FSSlurl !== 'undefined' && FSSlurl.openExternalUrl) FSSlurl.openExternalUrl(url);
        else window.open(url, '_blank', 'noopener,noreferrer');
      });
    });
  }

  // Media-on-a-prim entries arrive as "face|url" so we can say which side it's on.
  function mediaHtml(list) {
    if (!Array.isArray(list) || !list.length) return '';
    const rows = list.map(function (entry) {
      const split = String(entry).indexOf('|');
      const face = split > 0 ? String(entry).slice(0, split) : '';
      const url = split > 0 ? String(entry).slice(split + 1) : String(entry);
      return '<div class="profile-field"><span class="profile-field__label">Media' +
        (face ? ' (face ' + FSUtils.escapeHtml(face) + ')' : '') + '</span>' +
        '<span><a href="#" class="settings-link" data-media-url="' + FSUtils.escapeHtml(url) + '">' +
        FSUtils.escapeHtml(url) + '</a></span></div>';
    });
    return rows.join('');
  }

  // Nothing loads or refreshes on its own - the user presses Load. The core tracks
  // objects continuously anyway, so this only reads the table it already has.
  function startScan() {
    if (!FSState.gridOnline()) return;
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
    const rangeBox = document.getElementById('objects-range');
    if (rangeBox) {
      const saved = typeof FSSettings !== 'undefined' ? Number(FSSettings.get('objectsRange')) : 0;
      if (RANGE_CHOICES.indexOf(saved) !== -1) range = saved;
      rangeBox.value = String(range);
      rangeBox.addEventListener('change', function () { setRange(rangeBox.value); });
    }

    // Filtering is local to the rows we already have - it sends nothing.
    const filterBox = document.getElementById('objects-filter');
    if (filterBox) {
      filterBox.addEventListener('input', FSUtils.debounce(function () {
        filterText = filterBox.value.trim();
        renderObjects();
      }, 150));
    }

    // Escape or the backdrop closes the detail window; keep our own state in step.
    const dlg = document.getElementById('objects-detail');
    if (dlg) {
      dlg.addEventListener('close', function () { openDetailId = ''; });
      dlg.addEventListener('click', function (e) {
        if (e.target === dlg) closeDetails(); // a click on the backdrop, not the card
      });
    }

    document.querySelectorAll('[data-objects-sort]').forEach(function (btn) {
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
    if (typeof FSTransport !== 'undefined' && FSTransport.on) {
      const repaintSoon = FSUtils.debounce(renderObjects, 120);
      FSTransport.on('object-properties', function (props) {
        if (!props || !props.id) return;
        const row = objects.find(function (o) {
          return o.id && o.id.toLowerCase() === String(props.id).toLowerCase();
        });
        if (!row) return;
        if (props.name) row.name = props.name;
        if (props.ownerId) row.ownerId = props.ownerId;
        if (props.creatorId) row.creatorId = props.creatorId;
        // An object's group is usually one we're not in, so membership never named it.
        if (props.groupId && !FSProfiles.isZero(props.groupId) &&
            FSTransport.queueGroupNameResolve) {
          FSTransport.queueGroupNameResolve([props.groupId]);
        }
        // Merge, because the Family reply and the full one carry different fields.
        detailProps[row.id] = Object.assign({}, detailProps[row.id], props);
        repaintSoon();
        if (openDetailId === row.id) paintDetails(row, detailProps[row.id]);
      });
      FSTransport.on('pay-price', function (price) {
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
      FSTransport.on('teleport-finish', function () {
        objects = [];
        loaded = false;
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
      FSTransport.on('names-updated', repaintNames);
      // Group names arrive on their own event, and the details window shows one.
      FSTransport.on('group-names', repaintNames);
    }

    // Stop scanning when the user navigates away from the Interactions panel.
    FSState.on('tab', function (tab) {
      if (tab !== 'interact') deactivate();
    });

    // The core tells us when something else seats us (AvatarSitResponse), e.g. an
    // object we clicked or a script that sat us down.
    if (typeof FSTransport !== 'undefined' && FSTransport.on) {
      FSTransport.on('sit-state', function (data) {
        if (data && typeof data.sitting === 'boolean') {
          state.sitting = data.sitting;
          if (!data.sitting) sittingOn = '';
          else if (data.objectId) sittingOn = data.objectId;
          paint();
        }
      });
    }
    // A fresh session starts standing, and losing one clears the buttons.
    FSState.on('change', function (partial) {
      if (partial.connected === true) {
        state = { sitting: false, flying: false };
      }
      if (partial.connected !== undefined || partial.sessionLost !== undefined) paint();
    });
    FSState.on('reset', function () {
      state = { sitting: false, flying: false };
      sittingOn = '';
      objects = [];
      loaded = false;
      filterText = '';
      const box = document.getElementById('objects-filter');
      if (box) box.value = '';
      closeDetails();
      paint();
    });
    paint();
  }

  return { init: init, activate: activate, refreshState: refreshState };
})();

window.FSInteract = FSInteract;
