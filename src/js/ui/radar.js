/**
 * Radar - the nearby-avatar list (enumerated client-side in the real viewer).
 */
const FSRadar = (function () {
  'use strict';

  let filter = '';
  let renderScheduled = false;

  // CoarseLocationUpdate gives us only an id per nearby avatar; the names
  // resolve asynchronously (names-updated), so prefer a resolved name when
  // one is cached.
  function nameLines(agent) {
    const info = agent && agent.id && typeof FSTransport.getCachedNameInfo === 'function'
      ? FSTransport.getCachedNameInfo(agent.id)
      : null;
    if (info && (info.userName || info.label || info.displayName)) {
      return FSUtils.agentNameLines({
        displayName: info.displayName || '',
        userName: info.userName || info.label || '',
        name: info.label || (agent && agent.name) || ''
      });
    }
    return FSUtils.agentNameLines(agent);
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
    const p = (typeof FSProfiles !== 'undefined' && FSProfiles.getAvatarProfile)
      ? FSProfiles.getAvatarProfile(entry.id) : null;
    if (p && p.bornOn) return compactAge(p.bornOn);
    if (typeof FSProfiles !== 'undefined' && FSProfiles.queueAvatarThumb && entry.id) {
      FSProfiles.queueAvatarThumb(entry.id); // deduped; bornOn will be ready for the next render
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
    const region = FSState.get().region;
    FSIm.startImWith({
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
    const ageText = age ? ('Age: ' + age) : 'Age: …';
    li.innerHTML =
      '<div class="entity-item__avatar" data-agent-id="' + FSUtils.escapeHtml(entry.id) +
        '" data-resolve-image="0" data-label="' + FSUtils.escapeHtml(names.title) + '"></div>' +
      '<div class="entity-item__body">' +
        '<div class="entity-item__name">' + FSUtils.escapeHtml(names.title) + '</div>' +
        (names.subtitle
          ? '<div class="entity-item__legacy">' + FSUtils.escapeHtml(names.subtitle) + '</div>'
          : '') +
        '<div class="entity-item__sub">' + FSUtils.escapeHtml(ageText) +
          ' · ' + FSUtils.escapeHtml(String(entry.range)) + 'm' + FSUtils.escapeHtml(status) + '</div>' +
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
        FSProfile.openAvatar(entry.id, { agent: entry });
        return;
      }
      if (e.target.closest('[data-action="im"]')) {
        e.stopPropagation();
        openIm(entry);
        return;
      }
      openIm(entry);
    });

    li.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      showContextMenu(e, entry);
    });

    return li;
  }

  function showContextMenu(e, entry) {
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    menu.hidden = false;

    const actions = [
      { label: 'Send IM', fn: function () { openIm(entry); } },
      { label: 'Profile', fn: function () { FSProfile.openAvatar(entry.id, { agent: entry }); } },
      { label: 'Track on map', fn: function () { FSUtils.showToast('Map tracking: ' + entry.name); } },
      { label: 'Copy UUID', fn: function () {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(entry.id);
          FSUtils.showToast('UUID copied', 'success');
        }
      }}
    ];

    actions.forEach(function (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      btn.addEventListener('click', function () {
        menu.hidden = true;
        action.fn();
      });
      menu.appendChild(btn);
    });

    menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 120) + 'px';
  }

  function render() {
    const list = document.getElementById('radar-list');
    const countEl = document.getElementById('radar-count');
    const regionEl = document.getElementById('radar-region');
    if (!list) return;

    const s = FSState.get();
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
      empty.innerHTML = '<div class="entity-item__sub">' + FSUtils.escapeHtml(msg) + '</div>';
      list.appendChild(empty);
    } else {
      entries.forEach(function (entry) {
        const outOfRange = entry.range > s.radarRange;
        const highlightAlert = s.radarAlerts && isAlertCandidate(entry);
        list.appendChild(renderItem(entry, { outOfRange: outOfRange, highlightAlert: highlightAlert }));
      });
      list.querySelectorAll('.entity-item__avatar[data-agent-id]').forEach(function (node) {
        FSAvatarThumb.refresh(node);
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

    if (typeof FSSettings !== 'undefined') {
      const savedRange = FSSettings.get('radarRange');
      const savedAlerts = FSSettings.get('radarAlerts');
      if (rangeInput) rangeInput.value = String(savedRange);
      if (rangeLabel) rangeLabel.textContent = savedRange + 'm';
      if (alertInput) alertInput.checked = !!savedAlerts;
    }

    rangeInput.addEventListener('input', function () {
      const val = parseInt(rangeInput.value, 10);
      rangeLabel.textContent = val + 'm';
      if (typeof FSSettings !== 'undefined') {
        FSSettings.set('radarRange', val);
      } else {
        FSState.patch({ radarRange: val });
      }
      render();
      if (typeof FSNavigation.noteRadarUpdate === 'function') {
        FSNavigation.noteRadarUpdate(FSState.get().radar);
      }
      FSNavigation.updateBadges();
    });

    document.getElementById('radar-search').addEventListener('input', FSUtils.debounce(function (e) {
      filter = e.target.value.trim();
      render();
    }, 200));

    alertInput.addEventListener('change', function (e) {
      if (typeof FSSettings !== 'undefined') {
        FSSettings.set('radarAlerts', e.target.checked);
      } else {
        FSState.patch({ radarAlerts: e.target.checked });
      }
      render();
    });

    document.addEventListener('click', function (e) {
      const menu = document.getElementById('context-menu');
      if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
    });

    FSState.on('change', function (partial) {
      if (partial.radar && FSNavigation.isTabActive('radar')) scheduleRender();
    });

    FSState.on('radar-update', function () {
      if (FSNavigation.isTabActive('radar')) scheduleRender();
    });

    // Repaint once names resolve, so entries show the real name rather than the UUID/"?".
    FSTransport.on('names-updated', function () {
      if (FSNavigation.isTabActive('radar')) scheduleRender();
    });
    // Repaint when the avatar properties (age/born-on) come in.
    if (typeof FSProfiles !== 'undefined' && FSProfiles.onChange) {
      FSProfiles.onChange(function (evt) {
        if (evt && evt.kind === 'avatar' && FSNavigation.isTabActive('radar')) scheduleRender();
      });
    }

    // When range or alerts are changed elsewhere (e.g. the Settings tab), mirror
    // those changes back into the radar controls and list.
    if (typeof FSSettings !== 'undefined' && FSSettings.onChange) {
      FSSettings.onChange(function (key, value) {
        if (key === 'radarRange') {
          if (rangeInput) rangeInput.value = String(value);
          if (rangeLabel) rangeLabel.textContent = value + 'm';
          if (FSNavigation.isTabActive('radar')) scheduleRender();
        } else if (key === 'radarAlerts') {
          if (alertInput) alertInput.checked = !!value;
          if (FSNavigation.isTabActive('radar')) scheduleRender();
        }
      });
    }
  }

  return { init: init, render: render };
})();
