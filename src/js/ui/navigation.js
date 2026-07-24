/**
 * Tab navigation and the shell chrome around it - the top bar, nav badges, and status readouts.
 */
const FSNavigation = (function () {
  'use strict';

  const TABS = ['chat', 'im', 'events', 'buddies', 'search', 'radar', 'map', 'land', 'destinations', 'settings'];
  const radarKnownIds = new Set();
  const SLT_TICK_MS = 60000;
  let sltTimer = null;

  function updateSltClock() {
    const el = document.getElementById('slt-clock');
    if (!el) return;
    if (!FSState.get().connected || FSState.get().sessionLost) {
      el.textContent = '--:-- SLT';
      return;
    }
    el.textContent = FSUtils.formatSltTime(new Date());
  }

  function startSltClock() {
    updateSltClock();
    if (sltTimer) clearInterval(sltTimer);
    sltTimer = setInterval(updateSltClock, SLT_TICK_MS);
  }

  function stopSltClock() {
    if (sltTimer) {
      clearInterval(sltTimer);
      sltTimer = null;
    }
    updateSltClock();
  }

  function isTabActive(tab) {
    return FSState.get().activeTab === tab;
  }

  function resetRadarTracking() {
    radarKnownIds.clear();
    FSState.patch({ unreadRadar: 0 });
  }

  function syncRadarKnown(entries) {
    const s = FSState.get();
    radarKnownIds.clear();
    (entries || s.radar || []).forEach(function (entry) {
      if (entry.range <= s.radarRange) {
        radarKnownIds.add(entry.id);
      }
    });
  }

  function pruneRadarDeparted(list) {
    const present = new Set((list || []).map(function (entry) { return entry.id; }));
    radarKnownIds.forEach(function (id) {
      if (!present.has(id)) radarKnownIds.delete(id);
    });
  }

  function noteRadarUpdate(entries) {
    const s = FSState.get();
    const list = entries || s.radar || [];
    const range = s.radarRange;
    pruneRadarDeparted(list);

    if (s.activeTab === 'radar') {
      syncRadarKnown(list);
      if (s.unreadRadar) FSState.patch({ unreadRadar: 0 });
      return;
    }

    if (!radarKnownIds.size && list.length > 0) {
      syncRadarKnown(list);
      return;
    }

    const newEntries = [];
    list.forEach(function (entry) {
      if (entry.range > range) return;
      if (!radarKnownIds.has(entry.id)) {
        radarKnownIds.add(entry.id);
        newEntries.push(entry);
      }
    });

    if (!newEntries.length) return;

    FSState.patch({ unreadRadar: (s.unreadRadar || 0) + newEntries.length });
    if (s.radarAlerts) {
      newEntries.forEach(function (entry) {
        FSState.emit('radar-alert', entry);
      });
    }
  }

  function activateTabPanel(tab) {
    switch (tab) {
      case 'chat':
        if (typeof FSChat.renderAll === 'function') FSChat.renderAll();
        break;
      case 'im':
        if (typeof FSIm.activate === 'function') FSIm.activate();
        break;
      case 'events':
        if (typeof FSEvents.activate === 'function') FSEvents.activate();
        break;
      case 'buddies':
        if (typeof FSBuddies.render === 'function') FSBuddies.render();
        break;
      case 'search':
        if (typeof FSSearch.activate === 'function') FSSearch.activate();
        break;
      case 'radar':
        if (typeof FSRadar.render === 'function') FSRadar.render();
        break;
      case 'map':
        if (typeof FSMap.activate === 'function') {
          FSMap.activate();
        } else if (typeof FSMap.renderTiles === 'function') {
          requestAnimationFrame(function () { FSMap.renderTiles(); });
        }
        break;
      case 'land':
        if (typeof FSLand.activate === 'function') FSLand.activate();
        break;
      case 'destinations':
        if (typeof FSDestinations.loadFeed === 'function') {
          FSDestinations.loadFeed(null, false);
        }
        break;
      case 'settings':
        if (typeof FSSettingsUI !== 'undefined' && typeof FSSettingsUI.activate === 'function') {
          FSSettingsUI.activate();
        }
        break;
      default:
        break;
    }
  }

  function switchTab(tab) {
    if (TABS.indexOf(tab) === -1) return;

    const patch = { activeTab: tab };
    if (tab === 'chat') patch.unreadChat = 0;
    if (tab === 'im') {
      patch.unreadIm = 0;
      Object.keys(FSState.get().imSessions).forEach(function (sid) {
        FSState.get().imSessions[sid].unread = 0;
      });
    }
    if (tab === 'events') patch.unreadEvents = 0;
    if (tab === 'radar') patch.unreadRadar = 0;
    if (tab === 'land') patch.landUpdated = false;

    FSState.patch(patch);

    document.querySelectorAll('.bottom-nav__item').forEach(function (btn) {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('bottom-nav__item--active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    document.querySelectorAll('.panel').forEach(function (panel) {
      const active = panel.dataset.panel === tab;
      panel.classList.toggle('panel--active', active);
      panel.hidden = !active;
    });

    if (tab === 'radar') syncRadarKnown();

    activateTabPanel(tab);
    updateBadges();
    FSState.emit('tab', tab);
  }

  function updateBadges() {
    const s = FSState.get();
    const chatUnread = s.activeTab === 'chat' ? 0 : s.unreadChat;
    const imUnread = s.activeTab === 'im' ? 0 : s.unreadIm;
    const eventsUnread = s.activeTab === 'events' ? 0 : (s.unreadEvents || 0);
    setBadge('badge-chat', chatUnread);
    setBadge('badge-im', imUnread);
    setBadge('badge-events', eventsUnread);
    setDot('badge-radar', (s.unreadRadar || 0) > 0 && s.activeTab !== 'radar');
    setDot('badge-land', !!s.landUpdated && s.activeTab !== 'land');
  }

  function setBadge(id, count) {
    const el = document.getElementById(id);
    if (!el) return;
    if (count > 0) {
      el.hidden = false;
      el.textContent = count > 99 ? '99+' : String(count);
    } else {
      el.hidden = true;
    }
  }

  function setDot(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !show;
  }

  function formatParcelLine(state) {
    const pos = state.position;
    const coordSuffix = pos && pos.x !== undefined
      ? ' (' + Math.round(pos.x) + ', ' + Math.round(pos.y) + ', ' + Math.round(pos.z) + ')'
      : '';
    if (!state.connected || state.sessionLost) return '';
    const parcel = state.parcel;
    if (!parcel) {
      return coordSuffix ? 'Land' + coordSuffix : '';
    }
    const rawName = String(parcel.name || parcel.parcelName || '').trim();
    const placeholder = !rawName || rawName === 'Current parcel' || rawName === 'Parcel';
    if (parcel.stub && placeholder) {
      return coordSuffix ? 'Land' + coordSuffix : '';
    }
    const name = placeholder ? 'Land' : rawName;
    return name + coordSuffix;
  }

  function updateActiveGroupLines() {
    const titleEl = document.getElementById('agent-group-title');
    const nameEl = document.getElementById('agent-group-name');
    if (!titleEl) return;
    const s = FSState.get();
    if (!s.connected || s.sessionLost || typeof FSProfiles === 'undefined' ||
        typeof FSProfiles.getActiveGroupInfo !== 'function') {
      titleEl.textContent = 'No active group title';
      titleEl.classList.add('top-bar__group-title--empty');
      if (nameEl) nameEl.hidden = true;
      return;
    }
    const active = FSProfiles.getActiveGroupInfo();
    if (!active || !active.id || FSProfiles.isZero(active.id)) {
      titleEl.textContent = 'No active group title';
      titleEl.classList.add('top-bar__group-title--empty');
      if (nameEl) {
        nameEl.hidden = true;
        nameEl.textContent = '';
      }
      return;
    }
    titleEl.classList.remove('top-bar__group-title--empty');
    const title = String(active.title || '').trim();
    titleEl.textContent = title || 'Member';
    if (nameEl) {
      nameEl.hidden = true;
      nameEl.textContent = '';
    }
  }

  function updateTopBar() {
    const s = FSState.get();
    const dot = document.getElementById('status-dot');
    const name = document.getElementById('agent-name');
    const region = document.getElementById('region-name');
    const parcelLine = document.getElementById('parcel-line');
    const fps = document.getElementById('fps-badge');
    const stats = document.getElementById('top-bar-stats');
    const balance = document.getElementById('balance-badge');

    if (dot) {
      dot.className = 'status-dot ' + (
        s.sessionLost ? 'status-dot--lost' :
        s.connecting ? 'status-dot--connecting' :
        s.connected ? 'status-dot--online' : 'status-dot--offline'
      );
      if (s.sessionLost) {
        dot.title = 'Disconnected from simulator';
      } else if (s.connected) {
        dot.title = 'Connected';
      } else if (s.connecting) {
        dot.title = 'Connecting';
      } else {
        dot.title = 'Offline';
      }
    }
    if (name) {
      name.textContent = s.agent ? s.agent.displayName : 'Agent';
      const canOpenProfile = !!(s.connected && !s.sessionLost && s.agent && s.agent.id);
      name.classList.toggle('top-bar__name--interactive', canOpenProfile);
      name.title = canOpenProfile ? 'View your profile' : '';
      if (name.tagName === 'BUTTON') name.disabled = !canOpenProfile;
    }
    if (region) {
      region.textContent = s.sessionLost ? 'Disconnected' : (s.region ? s.region.name : 'Offline');
    }
    if (parcelLine) {
      const line = formatParcelLine(s);
      parcelLine.textContent = line || '\u2014';
      parcelLine.title = line || 'Parcel';
    }
    if (stats) {
      stats.hidden = !(s.connected && !s.sessionLost);
    }
    if (balance) {
      balance.textContent = FSUtils.formatLindenBalance(s.lindenBalance);
      balance.title = 'Linden dollar balance';
    }
    if (fps) fps.textContent = s.connected ? s.fps + ' FPS' : '-- FPS';
    updateActiveGroupLines();
    updateSltClock();
  }

  function init() {
    document.querySelectorAll('.bottom-nav__item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.dataset.tab);
      });
    });

    document.getElementById('btn-logout').addEventListener('click', function () {
      if (window.FSApp) window.FSApp.logout();
    });

    const themeBtn = document.getElementById('btn-theme');
    if (themeBtn && typeof FSSettings !== 'undefined') {
      themeBtn.addEventListener('click', function () {
        FSSettings.toggleTheme();
      });
    }

    const agentName = document.getElementById('agent-name');
    if (agentName) {
      agentName.addEventListener('click', function () {
        const s = FSState.get();
        if (!s.connected || s.sessionLost || !s.agent || !s.agent.id) return;
        if (typeof FSProfile !== 'undefined' && typeof FSProfile.openAvatar === 'function') {
          FSProfile.openAvatar(s.agent.id, { agent: s.agent });
        }
      });
    }

    FSState.on('change', function (partial) {
      updateTopBar();
      updateBadges();
      if (partial.connected === true) startSltClock();
      if (partial.connected === false || partial.sessionLost === true) stopSltClock();
    });

    FSState.on('reset', function () {
      resetRadarTracking();
      stopSltClock();
      updateTopBar();
    });

    FSState.on('chat', updateBadges);
    FSState.on('im', updateBadges);
    FSState.on('event', updateBadges);
    FSState.on('radar-update', function (entries) {
      noteRadarUpdate(entries);
      updateBadges();
    });

    FSState.on('teleport-finish', resetRadarTracking);

    if (typeof FSTransport !== 'undefined') {
      FSTransport.on('teleport-started', resetRadarTracking);
    }

    if (typeof FSProfiles !== 'undefined' && typeof FSProfiles.onChange === 'function') {
      FSProfiles.onChange(function (evt) {
        if (evt && evt.kind === 'active-group') updateActiveGroupLines();
      });
    }
  }

  return {
    init: init,
    switchTab: switchTab,
    updateBadges: updateBadges,
    isTabActive: isTabActive,
    resetRadarTracking: resetRadarTracking,
    noteRadarUpdate: noteRadarUpdate
  };
})();
