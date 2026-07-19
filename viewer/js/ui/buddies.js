/**
 * Buddies / friends list.
 */
const FSBuddies = (function () {
  'use strict';

  let filter = '';
  let onlineOnly = false;

  function rightsLabel(buddy) {
    const parts = [];
    if (buddy.rightsGiven & 1) parts.push('map');
    if (buddy.rightsGiven & 2) parts.push('edit');
    return parts.length ? parts.join(', ') : 'none';
  }

  function renderItem(buddy) {
    const li = document.createElement('li');
    li.className = 'entity-item';
    li.dataset.id = buddy.id;
    const names = FSUtils.agentNameLines(buddy);
    const status = buddy.online ? (buddy.region || 'Online') : 'Offline';
    const notes = buddy.notes ? ' - ' + buddy.notes : '';

    li.innerHTML =
      '<div class="entity-item__avatar' + (buddy.online ? ' entity-item__avatar--online' : '') + '">' +
        FSUtils.escapeHtml(FSUtils.initials(names.title)) +
      '</div>' +
      '<div class="entity-item__body">' +
        '<div class="entity-item__name">' + FSUtils.escapeHtml(names.title) + '</div>' +
        (names.subtitle
          ? '<div class="entity-item__legacy">' + FSUtils.escapeHtml(names.subtitle) + '</div>'
          : '') +
        '<div class="entity-item__sub">' + FSUtils.escapeHtml(status + notes) + '</div>' +
      '</div>' +
      '<div class="entity-item__actions">' +
        '<button type="button" class="icon-btn" data-action="im" title="Send IM" aria-label="Send IM">' +
          '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6l8 5 8-5v12z"/></svg>' +
        '</button>' +
      '</div>';

    li.addEventListener('click', function (e) {
      if (e.target.closest('[data-action="im"]')) {
        e.stopPropagation();
        FSIm.startImWith(buddy);
        return;
      }
      showContextMenu(e, buddy);
    });

    return li;
  }

  function showContextMenu(e, buddy) {
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    menu.hidden = false;

    const actions = [
      { label: 'Send IM', fn: function () { FSIm.startImWith(buddy); } },
      { label: 'Profile', fn: function () { FSUtils.showToast('Profile: ' + buddy.name, 'success'); } },
      { label: 'Teleport offer', fn: function () { FSTeleportUI.offerTo(buddy.id, buddy.name); } },
      { label: 'Teleport request', fn: function () { FSTeleportUI.requestFrom(buddy.id, buddy.name); } },
      { label: 'Remove friend', fn: function () { FSUtils.showToast('Not implemented yet', 'warning'); }, danger: true }
    ];

    actions.forEach(function (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      if (action.danger) btn.dataset.danger = 'true';
      btn.addEventListener('click', function () {
        menu.hidden = true;
        action.fn();
      });
      menu.appendChild(btn);
    });

    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 160);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function render() {
    const list = document.getElementById('buddies-list');
    if (!list) return;
    list.innerHTML = '';

    let buddies = FSState.get().buddies.slice();
    if (onlineOnly) buddies = buddies.filter(function (b) { return b.online; });
    if (filter) {
      const q = filter.toLowerCase();
      buddies = buddies.filter(function (b) {
        const names = FSUtils.agentNameLines(b);
        return names.title.toLowerCase().indexOf(q) !== -1 ||
          (names.subtitle && names.subtitle.toLowerCase().indexOf(q) !== -1) ||
          (b.notes && b.notes.toLowerCase().indexOf(q) !== -1);
      });
    }

    buddies.sort(function (a, b) {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    if (!buddies.length) {
      const empty = document.createElement('li');
      empty.className = 'entity-item';
      empty.style.cursor = 'default';
      empty.innerHTML = '<div class="entity-item__sub">No buddies match your filter.</div>';
      list.appendChild(empty);
      return;
    }

    buddies.forEach(function (buddy) {
      list.appendChild(renderItem(buddy));
    });
  }

  function init() {
    if (typeof FSSettings !== 'undefined') {
      onlineOnly = !!FSSettings.get('buddiesOnlineOnly');
      const onlineEl = document.getElementById('buddies-online-only');
      if (onlineEl) onlineEl.checked = onlineOnly;
    }

    document.getElementById('buddies-search').addEventListener('input', FSUtils.debounce(function (e) {
      filter = e.target.value.trim();
      render();
    }, 200));

    document.getElementById('buddies-online-only').addEventListener('change', function (e) {
      onlineOnly = e.target.checked;
      if (typeof FSSettings !== 'undefined') {
        FSSettings.set('buddiesOnlineOnly', onlineOnly);
      }
      render();
    });

    document.addEventListener('click', function (e) {
      const menu = document.getElementById('context-menu');
      if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
    });

    FSState.on('change', function (partial) {
      if (partial.buddies && FSNavigation.isTabActive('buddies')) render();
    });

    FSState.on('reset', function () {
      filter = '';
      onlineOnly = typeof FSSettings !== 'undefined' ? !!FSSettings.get('buddiesOnlineOnly') : false;
      document.getElementById('buddies-search').value = '';
      document.getElementById('buddies-online-only').checked = onlineOnly;
      render();
    });
  }

  return { init: init, render: render };
})();
