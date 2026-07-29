// @ts-nocheck - not yet migrated to checked types. Remove this line, then fix
// what npm run typecheck reports for this file.
/**
 * Radar - the nearby-avatar list, built from CoarseLocationUpdate.
 */
const BeeRadar = (function () {
  'use strict';

  let filter = '';
  let renderScheduled = false;

  // CoarseLocationUpdate gives us only an id per nearby avatar; the names
  // resolve asynchronously (names-updated), so prefer a resolved name when
  // one is cached.
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
    return BeeUtils.agentNameLines(agent);
  }

  // Turn a born-on date into a compact account age, e.g. "12d", "5mo", "3y".
  function compactAge(bornOn) {
    if (!bornOn) return '';
    const d = bornOn instanceof Date ? bornOn : new Date(bornOn);
    if (Number.isNaN(d.getTime())) return '';
    const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
    if (days < 60) return days + 'd';
    if (days < 730) return Math.floor(days / 30) + 'mo';
    return Math.floor(days / 365) + 'y';
  }

  // Age comes from each avatar's basic properties (born-on), which we fetch
  // lazily and dedupe (queueAvatarThumb -> sl_request_avatar_properties).
  // Deliberately not the extended AgentProfile cap - that stays profile-open only.
  function ageFor(entry) {
    const p = (typeof BeeProfiles !== 'undefined' && BeeProfiles.getAvatarProfile)
      ? BeeProfiles.getAvatarProfile(entry.id) : null;
    if (p && p.bornOn) return compactAge(p.bornOn);
    if (typeof BeeProfiles !== 'undefined' && BeeProfiles.queueAvatarThumb && entry.id) {
      BeeProfiles.queueAvatarThumb(entry.id); // deduped; bornOn will be ready for the next render
    }
    return (entry.age && entry.age !== '?') ? entry.age : '';
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(function () {
      renderScheduled = false;
      render();
    });
  }

  function openIm(entry) {
    const region = BeeState.get().region;
    BeeIm.startImWith({
      id: entry.id,
      name: entry.name,
      online: true,
      region: region ? region.name : ''
    });
  }

  function isAlertCandidate(entry) {
    // Coarse-location radar carries no account age, so the old age check never
    // fired; a name match is the only signal we actually have to go on here.
    const name = String(entry.name || '').toLowerCase();
    return name.indexOf('visitor') !== -1;
  }

  function iconProfile() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
  }

  function renderItem(entry, options) {
    const opts = options || {};
    const names = nameLines(entry);
    const outOfRange = !!opts.outOfRange;
    const highlightAlert = !!opts.highlightAlert && !outOfRange;

    const li = document.createElement('li');
    let className = 'entity-item';
    if (highlightAlert) className += ' entity-item--alert';
    if (outOfRange) className += ' entity-item--out-of-range';
    li.className = className;
    li.dataset.id = entry.id;
    const status = entry.status ? ' [' + entry.status + ']' : '';
    const age = ageFor(entry);
    const ageText = age ? ('Age: ' + age) : 'Age: ...';
    li.innerHTML =
      '<div class="entity-item__avatar" data-agent-id="' + BeeUtils.escapeHtml(entry.id) +
        '" data-resolve-image="0" data-label="' + BeeUtils.escapeHtml(names.title) + '"></div>' +
      '<div class="entity-item__body">' +
        '<div class="entity-item__name">' + BeeUtils.escapeHtml(names.title) + '</div>' +
        (names.subtitle
          ? '<div class="entity-item__legacy">' + BeeUtils.escapeHtml(names.subtitle) + '</div>'
          : '') +
        '<div class="entity-item__sub">' + BeeUtils.escapeHtml(ageText) +
          ' · ' + BeeUtils.escapeHtml(String(entry.range)) + 'm' + BeeUtils.escapeHtml(status) + '</div>' +
      '</div>' +
      '<div class="entity-item__actions">' +
        '<button type="button" class="icon-btn" data-action="profile" title="Profile" aria-label="Profile">' +
          iconProfile() +
        '</button>' +
        '<button type="button" class="icon-btn" data-action="im" title="Send IM" aria-label="Send IM">' +
          '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6l8 5 8-5v12z"/></svg>' +
        '</button>' +
      '</div>' +
      '<span class="entity-item__range">' + entry.range + 'm</span>';

    li.addEventListener('click', function (e) {
      if (e.target.closest('[data-action="profile"]')) {
        e.stopPropagation();
        BeeProfile.openAvatar(entry.id, { agent: entry });
        return;
      }
      if (e.target.closest('[data-action="im"]')) {
        e.stopPropagation();
        openIm(entry);
        return;
      }
      // Poking the row raises the action menu - on a touch screen there is
      // no right-click to reach it, and IM stays one tap away as both the
      // envelope button and the menu's first entry. Stop the bubble so the
      // document-level "click outside closes the menu" listener doesn't
      // immediately swallow what we just opened.
      e.stopPropagation();
      showContextMenu(e, entry);
    });

    li.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      showContextMenu(e, entry);
    });

    return li;
  }

  // The Rust core aims the teleport from its own coarse-position table, so
  // the menu entry only needs to know whether a position exists at all.
  function canTeleportTo(entry) {
    return !!(entry && entry.pos && BeeState.gridOnline());
  }

  function teleportToEntry(entry) {
    const names = nameLines(entry);
    BeeBridge.invoke('sl_teleport_to_agent', { agentId: entry.id }).then(function () {
      BeeUtils.showToast('Teleporting to ' + (names.title || 'resident') + '...', 'info');
    }).catch(function (err) {
      BeeUtils.showToast(err && err.message ? err.message : String(err || 'Teleport failed.'), 'warning');
    });
  }

  function copyToClipboard(text, what) {
    if (!text || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () {
      BeeUtils.showToast(what + ' copied', 'success');
    }).catch(function () {});
  }

  function showContextMenu(e, entry) {
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    menu.hidden = false;

    const names = nameLines(entry);
    const actions = [
      { label: 'Send IM', fn: function () { openIm(entry); } },
      { label: 'Profile', fn: function () { BeeProfile.openAvatar(entry.id, { agent: entry }); } },
      { label: 'Teleport to', fn: function () { teleportToEntry(entry); },
        disabled: !canTeleportTo(entry) },
      { label: 'Copy name', fn: function () { copyToClipboard(names.title || entry.name || '', 'Name'); } },
      { label: 'Copy UUID', fn: function () { copyToClipboard(entry.id, 'UUID'); } }
    ];

    actions.forEach(function (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      if (action.disabled) {
        btn.disabled = true;
        btn.title = 'Position not known yet';
      } else {
        btn.addEventListener('click', function () {
          menu.hidden = true;
          action.fn();
        });
      }
      menu.appendChild(btn);
    });

    // Measure the real menu, then clamp it fully on-screen: as the primary
    // tap action it often opens near the bottom edge on a phone.
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(e.clientX, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(0, Math.min(e.clientY, window.innerHeight - rect.height - 8)) + 'px';
  }

  function render() {
    const list = document.getElementById('radar-list');
    const countEl = document.getElementById('radar-count');
    const regionEl = document.getElementById('radar-region');
    if (!list) return;

    const s = BeeState.get();
    let entries = s.radar.slice();
    const totalInRegion = entries.length;

    if (filter) {
      const q = filter.toLowerCase();
      entries = entries.filter(function (e) {
        const names = nameLines(e);
        return names.title.toLowerCase().indexOf(q) !== -1 ||
          (names.subtitle && names.subtitle.toLowerCase().indexOf(q) !== -1) ||
          e.id.toLowerCase().indexOf(q) !== -1;
      });
    }

    entries.sort(function (a, b) { return a.range - b.range; });

    list.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('li');
      empty.className = 'entity-item';
      empty.style.cursor = 'default';
      let msg = 'No other avatars detected in this region.';
      if (totalInRegion && filter) {
        msg = 'No avatars match your search.';
      }
      empty.innerHTML = '<div class="entity-item__sub">' + BeeUtils.escapeHtml(msg) + '</div>';
      list.appendChild(empty);
    } else {
      entries.forEach(function (entry) {
        const outOfRange = entry.range > s.radarRange;
        const highlightAlert = s.radarAlerts && isAlertCandidate(entry);
        list.appendChild(renderItem(entry, { outOfRange: outOfRange, highlightAlert: highlightAlert }));
      });
      list.querySelectorAll('.entity-item__avatar[data-agent-id]').forEach(function (node) {
        BeeAvatarThumb.refresh(node);
      });
    }

    if (countEl) {
      const nearby = s.radar.filter(function (e) { return e.range <= s.radarRange; }).length;
      if (totalInRegion > nearby) {
        countEl.textContent = nearby + ' / ' + totalInRegion + ' nearby';
      } else {
        countEl.textContent = nearby === 1 ? '1 nearby' : nearby + ' nearby';
      }
    }
    if (regionEl) regionEl.textContent = s.region ? s.region.name : '';
  }

  function init() {
    const rangeInput = document.getElementById('radar-range');
    const rangeLabel = document.getElementById('radar-range-label');
    const alertInput = document.getElementById('radar-alert');

    if (typeof BeeSettings !== 'undefined') {
      const savedRange = BeeSettings.get('radarRange');
      const savedAlerts = BeeSettings.get('radarAlerts');
      if (rangeInput) rangeInput.value = String(savedRange);
      if (rangeLabel) rangeLabel.textContent = savedRange + 'm';
      if (alertInput) alertInput.checked = !!savedAlerts;
    }

    rangeInput.addEventListener('input', function () {
      const val = parseInt(rangeInput.value, 10);
      rangeLabel.textContent = val + 'm';
      if (typeof BeeSettings !== 'undefined') {
        BeeSettings.set('radarRange', val);
      } else {
        BeeState.patch({ radarRange: val });
      }
      render();
      if (typeof BeeNavigation.noteRadarUpdate === 'function') {
        BeeNavigation.noteRadarUpdate(BeeState.get().radar);
      }
      BeeNavigation.updateBadges();
    });

    document.getElementById('radar-search').addEventListener('input', BeeUtils.debounce(function (e) {
      filter = e.target.value.trim();
      render();
    }, 200));

    alertInput.addEventListener('change', function (e) {
      if (typeof BeeSettings !== 'undefined') {
        BeeSettings.set('radarAlerts', e.target.checked);
      } else {
        BeeState.patch({ radarAlerts: e.target.checked });
      }
      render();
    });

    document.addEventListener('click', function (e) {
      const menu = document.getElementById('context-menu');
      if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
    });

    BeeState.on('change', function (partial) {
      if (partial.radar && BeeNavigation.isTabActive('radar')) scheduleRender();
    });

    BeeState.on('radar-update', function () {
      if (BeeNavigation.isTabActive('radar')) scheduleRender();
    });

    // Repaint once names resolve, so entries show the real name rather than the UUID/"?".
    BeeTransport.on('names-updated', function () {
      if (BeeNavigation.isTabActive('radar')) scheduleRender();
    });
    // Repaint when the avatar properties (age/born-on) come in.
    if (typeof BeeProfiles !== 'undefined' && BeeProfiles.onChange) {
      BeeProfiles.onChange(function (evt) {
        if (evt && evt.kind === 'avatar' && BeeNavigation.isTabActive('radar')) scheduleRender();
      });
    }

    // When range or alerts are changed elsewhere (e.g. the Settings tab), mirror
    // those changes back into the radar controls and list.
    if (typeof BeeSettings !== 'undefined' && BeeSettings.onChange) {
      BeeSettings.onChange(function (key, value) {
        if (key === 'radarRange') {
          if (rangeInput) rangeInput.value = String(value);
          if (rangeLabel) rangeLabel.textContent = value + 'm';
          if (BeeNavigation.isTabActive('radar')) scheduleRender();
        } else if (key === 'radarAlerts') {
          if (alertInput) alertInput.checked = !!value;
          if (BeeNavigation.isTabActive('radar')) scheduleRender();
        }
      });
    }
  }

  return { init: init, render: render };
})();
