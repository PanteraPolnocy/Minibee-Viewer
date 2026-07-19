/**
 * Radar - nearby avatar list (client-side enumeration in real viewer).
 */
const FSRadar = (function () {
  'use strict';

  let filter = '';
  let renderScheduled = false;

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
    const name = String(entry.name || '').toLowerCase();
    return entry.age === '3d' || name.indexOf('visitor') !== -1;
  }

  function renderItem(entry, options) {
    const opts = options || {};
    const names = FSUtils.agentNameLines(entry);
    const outOfRange = !!opts.outOfRange;
    const highlightAlert = !!opts.highlightAlert && !outOfRange;

    const li = document.createElement('li');
    let className = 'entity-item';
    if (highlightAlert) className += ' entity-item--alert';
    if (outOfRange) className += ' entity-item--out-of-range';
    li.className = className;
    li.dataset.id = entry.id;
    const status = entry.status ? ' [' + entry.status + ']' : '';
    li.innerHTML =
      '<div class="entity-item__avatar">' +
        FSUtils.escapeHtml(FSUtils.initials(names.title)) +
      '</div>' +
      '<div class="entity-item__body">' +
        '<div class="entity-item__name">' + FSUtils.escapeHtml(names.title) + '</div>' +
        (names.subtitle
          ? '<div class="entity-item__legacy">' + FSUtils.escapeHtml(names.subtitle) + '</div>'
          : '') +
        '<div class="entity-item__sub">Age: ' + FSUtils.escapeHtml(entry.age) + status + '</div>' +
      '</div>' +
      '<div class="entity-item__actions">' +
        '<button type="button" class="icon-btn" data-action="im" title="Send IM" aria-label="Send IM">' +
          '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6l8 5 8-5v12z"/></svg>' +
        '</button>' +
      '</div>' +
      '<span class="entity-item__range">' + entry.range + 'm</span>';

    li.addEventListener('click', function (e) {
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
        const names = FSUtils.agentNameLines(e);
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
  }

  return { init: init, render: render };
})();
