/**
 * Buddies - the friends list.
 */
const FSBuddies = (function () {
  'use strict';

  let filter = '';
  let onlineOnly = false;

  // A buddy arrives with just a UUID; its display name resolves later and
  // asynchronously via GetDisplayNames (which reaches us as names-updated).
  // Prefer the resolved cache, falling back to whatever the buddy object carries.
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

  function iconProfile() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
  }

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
    const names = nameLines(buddy);
    const status = buddy.online ? 'Online' : 'Offline';
    const notes = notesFor(buddy) ? ' - ' + notesFor(buddy) : '';

    li.innerHTML =
      '<div class="entity-item__avatar' + (buddy.online ? ' entity-item__avatar--online' : '') +
        '" data-agent-id="' + FSUtils.escapeHtml(buddy.id) + '" data-resolve-image="1" data-label="' +
        FSUtils.escapeHtml(names.title) + '"></div>' +
      '<div class="entity-item__body">' +
        '<div class="entity-item__name">' + FSUtils.escapeHtml(names.title) + '</div>' +
        (names.subtitle
          ? '<div class="entity-item__legacy">' + FSUtils.escapeHtml(names.subtitle) + '</div>'
          : '') +
        '<div class="entity-item__sub">' + FSUtils.escapeHtml(status + notes) + '</div>' +
      '</div>' +
      '<div class="entity-item__actions">' +
        '<button type="button" class="icon-btn" data-action="profile" title="Profile" aria-label="Profile">' +
          iconProfile() +
        '</button>' +
        '<button type="button" class="icon-btn" data-action="im" title="Send IM" aria-label="Send IM">' +
          '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6l8 5 8-5v12z"/></svg>' +
        '</button>' +
      '</div>';

    li.addEventListener('click', function (e) {
      if (e.target.closest('[data-action="profile"]')) {
        e.stopPropagation();
        FSProfile.openAvatar(buddy.id, { agent: buddy });
        return;
      }
      if (e.target.closest('[data-action="im"]')) {
        e.stopPropagation();
        FSIm.startImWith(buddy);
        return;
      }
      // Stop here - otherwise this same click bubbles up to the document
      // handler that closes the menu, and it would open and shut in one event.
      e.stopPropagation();
      showContextMenu(e, buddy);
    });

    li.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e, buddy);
    });

    return li;
  }

  function notesFor(buddy) {
    if (!buddy) return '';
    if (buddy.notes) return buddy.notes;
    if (typeof FSProfiles === 'undefined' || !FSProfiles.getAvatarProfile) return '';
    const p = FSProfiles.getAvatarProfile(buddy.id);
    return (p && p.notes) || '';
  }

  function showContextMenu(e, buddy) {
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    menu.hidden = false;

    const actions = [
      { label: 'Send IM', fn: function () { FSIm.startImWith(buddy); } },
      { label: 'Start conference...', fn: function () {
        if (FSIm && typeof FSIm.openConferenceDialog === 'function') {
          FSIm.openConferenceDialog([buddy.id]);
        }
      } },
      { label: 'Profile', fn: function () { FSProfile.openAvatar(buddy.id, { agent: buddy }); } },
      { label: 'Teleport offer', fn: function () { FSTeleportUI.offerTo(buddy.id, buddy.name, buddy); }, disabled: !buddy.online },
      { label: 'Teleport request', fn: function () { FSTeleportUI.requestFrom(buddy.id, buddy.name, buddy); }, disabled: !buddy.online },
      { label: 'Remove friend', fn: async function () {
        const names = nameLines(buddy);
        const label = names.title || buddy.name || 'this friend';
        const ok = await FSUtils.confirm({
          title: 'Remove friend?',
          message: 'Remove ' + label + ' from your friends list?',
          confirmLabel: 'Remove',
          danger: true
        });
        if (!ok) return;
        FSTransport.removeFriendship(buddy.id).then(function (result) {
          if (result && result.sent) {
            FSUtils.showToast('Friend removed.', 'success');
          } else if (result && result.notFriend) {
            FSUtils.showToast('Not on your friends list.', 'warning');
          } else {
            FSUtils.showToast('Could not remove friend.', 'warning');
          }
        });
      }, danger: true }
    ];

    actions.forEach(function (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      if (action.danger) btn.dataset.danger = 'true';
      if (action.disabled) {
        btn.disabled = true;
        if (action.label.indexOf('Teleport') === 0) {
          btn.title = 'Resident is offline';
        }
      }
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
        const names = nameLines(b);
        return names.title.toLowerCase().indexOf(q) !== -1 ||
          (names.subtitle && names.subtitle.toLowerCase().indexOf(q) !== -1) ||
          (notesFor(b) && notesFor(b).toLowerCase().indexOf(q) !== -1);
      });
    }

    const sortKey = function (b) {
      const names = nameLines(b);
      return String(names.title || b.name || b.id || '').toLowerCase();
    };
    buddies.sort(function (a, b) {
      if (!a.online !== !b.online) return a.online ? -1 : 1;
      return sortKey(a).localeCompare(sortKey(b));
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
    list.querySelectorAll('.entity-item__avatar[data-agent-id]').forEach(function (node) {
      FSAvatarThumb.refresh(node);
    });
  }

  // --- Blocked ---------------------------------------------------------------

  let blocked = [];
  let blockedFilter = '';
  let blockedAsked = false;

  function requestBlocked(force) {
    if (blockedAsked && !force) return;
    if (!FSState.gridOnline()) return;
    blockedAsked = true;
    if (typeof FSBridge !== 'undefined' && FSBridge.invoke) {
      FSBridge.invoke('sl_request_mute_list').catch(function () { blockedAsked = false; });
    }
  }

  function renderBlocked() {
    const list = document.getElementById('blocked-list');
    if (!list) return;
    list.innerHTML = '';

    let people = blocked.slice();
    if (blockedFilter) {
      const q = blockedFilter.toLowerCase();
      people = people.filter(function (p) {
        return labelFor(p).toLowerCase().indexOf(q) !== -1;
      });
    }
    people.sort(function (a, b) {
      return labelFor(a).toLowerCase().localeCompare(labelFor(b).toLowerCase());
    });

    if (!people.length) {
      const empty = document.createElement('li');
      empty.className = 'entity-item';
      empty.style.cursor = 'default';
      empty.innerHTML = '<div class="entity-item__sub">' +
        (blockedFilter ? 'Nobody blocked matches your filter.'
          : blockedAsked ? 'You have not blocked anyone.'
            : 'Press Refresh to load your block list.') + '</div>';
      list.appendChild(empty);
      return;
    }

    people.forEach(function (person) {
      const li = document.createElement('li');
      li.className = 'entity-item';
      li.dataset.id = person.id;
      li.innerHTML =
        '<div class="entity-item__body">' +
          '<div class="entity-item__name">' + FSUtils.escapeHtml(labelFor(person)) + '</div>' +
          '<div class="entity-item__sub">Blocked</div>' +
        '</div>';
      const actions = document.createElement('div');
      actions.className = 'entity-item__actions';
      const profile = document.createElement('button');
      profile.type = 'button';
      profile.className = 'btn btn--ghost btn--sm';
      profile.textContent = 'Profile';
      profile.addEventListener('click', function (e) {
        e.stopPropagation();
        FSProfile.openAvatar(person.id);
      });
      const unblock = document.createElement('button');
      unblock.type = 'button';
      unblock.className = 'btn btn--secondary btn--sm';
      unblock.textContent = 'Unblock';
      unblock.addEventListener('click', function (e) {
        e.stopPropagation();
        unblock(person.id, labelFor(person));
      });
      actions.appendChild(profile);
      actions.appendChild(unblock);
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  // The sim's copy of the list keeps account names, not display names, and can be stale -
  // so prefer whatever the name cache knows.
  function labelFor(person) {
    const cached = FSTransport.getCachedName ? FSTransport.getCachedName(person.id) : '';
    return cached || person.name || person.id;
  }

  function setTab(tab) {
    const which = tab === 'blocked' ? 'blocked' : 'friends';
    document.querySelectorAll('[data-people-tab]').forEach(function (btn) {
      const on = btn.dataset.peopleTab === which;
      btn.classList.toggle('settings-tab--active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const friends = document.getElementById('people-pane-friends');
    const blockedPane = document.getElementById('people-pane-blocked');
    if (friends) friends.hidden = which !== 'friends';
    if (blockedPane) blockedPane.hidden = which !== 'blocked';
    if (which === 'blocked') {
      requestBlocked(false);
      renderBlocked();
    } else {
      render();
    }
  }

  function init() {
    if (typeof FSSettings !== 'undefined') {
      onlineOnly = !!FSSettings.get('buddiesOnlineOnly');
      const onlineEl = document.getElementById('buddies-online-only');
      if (onlineEl) onlineEl.checked = onlineOnly;
    }

    document.querySelectorAll('[data-people-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () { setTab(btn.dataset.peopleTab); });
    });
    const blockedSearch = document.getElementById('blocked-search');
    if (blockedSearch) {
      blockedSearch.addEventListener('input', FSUtils.debounce(function () {
        blockedFilter = blockedSearch.value.trim();
        renderBlocked();
      }, 200));
    }
    const blockedBtn = document.getElementById('blocked-refresh');
    if (blockedBtn) blockedBtn.addEventListener('click', function () { requestBlocked(true); });

    FSTransport.on('mute-list', function (data) {
      blocked = (data && data.people) || [];
      blockedAsked = true;
      renderBlocked();
    });

    FSState.on('change', function (partial) {
      if (partial.connected === true) {
        blockedAsked = false;
        requestBlocked(true);
      }
    });

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

    // Names land asynchronously, after the list has first rendered, so repaint
    // to swap the UUID placeholder out for the real names on each row.
    FSTransport.on('names-updated', function () {
      if (FSNavigation.isTabActive('buddies')) {
        render();
        renderBlocked();
      }
    });

    FSState.on('reset', function () {
      filter = '';
      onlineOnly = typeof FSSettings !== 'undefined' ? !!FSSettings.get('buddiesOnlineOnly') : false;
      document.getElementById('buddies-search').value = '';
      document.getElementById('buddies-online-only').checked = onlineOnly;
      blocked = [];
      blockedFilter = '';
      blockedAsked = false;
      const bs = document.getElementById('blocked-search');
      if (bs) bs.value = '';
      setTab('friends');
    });
  }

  function block(id, name) {
    if (!id || typeof FSBridge === 'undefined') return Promise.resolve(false);
    return FSBridge.invoke('sl_block_agent', { agentId: id, name: name || '' })
      .then(function () {
        FSUtils.showToast('Blocked ' + (name || 'resident') + '.', 'success');
        requestBlocked(true);
        return true;
      })
      .catch(function (err) {
        FSUtils.showToast((err && err.message) || 'Could not block that resident.', 'warning');
        return false;
      });
  }

  function unblock(id, name) {
    if (!id || typeof FSBridge === 'undefined') return Promise.resolve(false);
    return FSBridge.invoke('sl_unblock_agent', { agentId: id, name: name || '' })
      .then(function () {
        FSUtils.showToast('Unblocked ' + (name || 'resident') + '.', 'success');
        blocked = blocked.filter(function (p) {
          return String(p.id).toLowerCase() !== String(id).toLowerCase();
        });
        renderBlocked();
        requestBlocked(true);
        return true;
      })
      .catch(function (err) {
        FSUtils.showToast((err && err.message) || 'Could not unblock that resident.', 'warning');
        return false;
      });
  }

  function isBlocked(id) {
    if (!id) return false;
    const key = String(id).toLowerCase();
    return blocked.some(function (p) { return String(p.id).toLowerCase() === key; });
  }

  return {
    init: init, render: render, setTab: setTab,
    block: block, unblock: unblock, isBlocked: isBlocked,
    requestBlocked: requestBlocked
  };
})();
