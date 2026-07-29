/**
 * Tab navigation and the shell chrome around it - the top bar, nav badges, and status readouts.
 */
const BeeNavigation = (function () {
  'use strict';

  const TABS = ['chat', 'im', 'interact', 'events', 'buddies', 'search', 'radar', 'map', 'land', 'destinations', 'news', 'settings'];
  const radarKnownIds = new Set();
  const SLT_TICK_MS = 60000;
  let sltTimer = null;

  function updateSltClock() {
    const el = document.getElementById('slt-clock');
    if (!el) return;
    if (!BeeState.get().connected || BeeState.get().sessionLost) {
      el.textContent = '--:-- SLT';
      return;
    }
    el.textContent = BeeUtils.formatSltTime(new Date());
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
    return BeeState.get().activeTab === tab;
  }

  function resetRadarTracking() {
    radarKnownIds.clear();
    BeeState.patch({ unreadRadar: 0 });
  }

  function syncRadarKnown(entries) {
    const s = BeeState.get();
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
    const s = BeeState.get();
    const list = entries || s.radar || [];
    const range = s.radarRange;
    pruneRadarDeparted(list);

    if (s.activeTab === 'radar') {
      syncRadarKnown(list);
      if (s.unreadRadar) BeeState.patch({ unreadRadar: 0 });
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

    BeeState.patch({ unreadRadar: (s.unreadRadar || 0) + newEntries.length });
    if (s.radarAlerts) {
      newEntries.forEach(function (entry) {
        BeeState.emit('radar-alert', entry);
      });
    }
  }

  function activateTabPanel(tab) {
    switch (tab) {
      case 'chat':
        if (typeof BeeChat.renderAll === 'function') BeeChat.renderAll();
        break;
      case 'im':
        if (typeof BeeIm.activate === 'function') BeeIm.activate();
        break;
      case 'events':
        if (typeof BeeEvents.activate === 'function') BeeEvents.activate();
        break;
      case 'buddies':
        if (typeof BeeBuddies.render === 'function') BeeBuddies.render();
        break;
      case 'search':
        if (typeof BeeSearch.activate === 'function') BeeSearch.activate();
        break;
      case 'radar':
        if (typeof BeeRadar.render === 'function') BeeRadar.render();
        break;
      case 'map':
        if (typeof BeeMap.activate === 'function') {
          BeeMap.activate();
        } else if (typeof BeeMap.renderTiles === 'function') {
          requestAnimationFrame(function () { BeeMap.renderTiles(); });
        }
        break;
      case 'land':
        if (typeof BeeLand.activate === 'function') BeeLand.activate();
        break;
      case 'destinations':
        if (typeof BeeDestinations.loadFeed === 'function') {
          BeeDestinations.loadFeed(null, false);
        }
        break;
      case 'interact':
        if (typeof BeeInteract !== 'undefined' && typeof BeeInteract.activate === 'function') {
          BeeInteract.activate();
        }
        break;
      case 'news':
        if (typeof BeeNews !== 'undefined' && typeof BeeNews.activate === 'function') {
          BeeNews.activate();
        }
        break;
      case 'settings':
        if (typeof BeeSettingsUI !== 'undefined' && typeof BeeSettingsUI.activate === 'function') {
          BeeSettingsUI.activate();
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
      Object.keys(BeeState.get().imSessions).forEach(function (sid) {
        BeeState.get().imSessions[sid].unread = 0;
      });
    }
    if (tab === 'events') patch.unreadEvents = 0;
    if (tab === 'radar') patch.unreadRadar = 0;
    if (tab === 'land') patch.landUpdated = false;

    BeeState.patch(patch);

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
    BeeState.emit('tab', tab);
  }

  function updateBadges() {
    const s = BeeState.get();
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
    const s = BeeState.get();
    if (!s.connected || s.sessionLost || typeof BeeProfiles === 'undefined' ||
        typeof BeeProfiles.getActiveGroupInfo !== 'function') {
      titleEl.textContent = 'No active group title';
      titleEl.classList.add('top-bar__group-title--empty');
      if (nameEl) nameEl.hidden = true;
      return;
    }
    const active = BeeProfiles.getActiveGroupInfo();
    if (!active || !active.id || BeeProfiles.isZero(active.id)) {
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
    const s = BeeState.get();
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
      const identity = document.querySelector('.top-bar__identity');
      if (identity) {
        identity.classList.toggle('top-bar__identity--interactive', canOpenProfile);
        identity.title = canOpenProfile ? 'View your profile' : '';
      }
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
      balance.textContent = BeeUtils.formatLindenBalance(s.lindenBalance);
      balance.title = 'Linden dollar balance';
    }
    if (fps) fps.textContent = s.connected ? s.fps + ' FPS' : '-- FPS';
    updateActiveGroupLines();
    updateSltClock();
    updateBeeMenu();
  }

  function updateBeeMenu() {
    const s = BeeState.get();
    const balance = document.getElementById('bee-menu-balance');
    const fps = document.getElementById('bee-menu-fps');
    if (balance) balance.textContent = BeeUtils.formatLindenBalance(s.lindenBalance);
    if (fps) fps.textContent = s.connected ? s.fps + ' FPS' : '--';
    const slt = document.getElementById('bee-menu-slt');
    if (slt) {
      slt.textContent = (!s.connected || s.sessionLost)
        ? '--:-- SLT'
        : BeeUtils.formatSltTime(new Date());
    }
  }

  function setBeeMenuOpen(open) {
    const menu = document.getElementById('bee-menu');
    const btn = document.getElementById('btn-bee-menu');
    if (!menu) return;
    menu.hidden = !open;
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) updateBeeMenu();
  }

  function bindBeeMenu() {
    const btn = document.getElementById('btn-bee-menu');
    const menu = document.getElementById('bee-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setBeeMenuOpen(menu.hidden);
    });
    const logout = document.getElementById('bee-menu-logout');
    if (logout) {
      logout.addEventListener('click', function () {
        setBeeMenuOpen(false);
        if (window.BeeApp) window.BeeApp.logout();
      });
    }
    // Tapping anywhere else, or pressing Escape, puts it away.
    document.addEventListener('click', function (e) {
      if (menu.hidden) return;
      if (!menu.contains(e.target) && e.target !== btn) setBeeMenuOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setBeeMenuOpen(false);
    });
  }

  // The top-bar traffic mood ring: a thin vertical bar that grows and shifts
  // green -> amber -> red with throughput. The core throttles net-rate to one
  // event per 2s (and none when idle) and ships the formatted label and the
  // log-scaled 0..1 level; this only turns them into pixels and a hue.
  function bindNetMeter() {
    const meter = document.getElementById('net-meter');
    const bar = document.getElementById('net-meter-bar');
    const menuNet = document.getElementById('bee-menu-net');
    if (!meter || !bar || typeof BeeTransport === 'undefined') return;

    // Rewriting `title` dismisses a tooltip the user is currently reading, so
    // the label freezes while the pointer is over the meter and catches up on
    // leave. The bee-menu row keeps updating live either way.
    let hovered = false;
    let liveTitle = '';
    meter.addEventListener('mouseenter', function () { hovered = true; });
    meter.addEventListener('mouseleave', function () {
      hovered = false;
      if (liveTitle) meter.title = liveTitle;
    });

    BeeTransport.on('net-rate', function (rate) {
      const total = ((rate && rate.inBps) || 0) + ((rate && rate.outBps) || 0);
      const t = (rate && rate.level) || 0;
      meter.hidden = !BeeState.gridOnline();
      bar.style.height = Math.max(total > 0 ? 12 : 4, Math.round(t * 100)) + '%';
      const hue = Math.round(120 - t * 120); // 120 green -> 0 red
      bar.style.background = 'hsl(' + hue + ', 85%, 52%)';
      const text = (rate && rate.label) || '';
      liveTitle = 'Network: ' + text;
      if (!hovered) meter.title = liveTitle;
      if (menuNet) menuNet.textContent = text;
    });

    BeeTransport.on('disconnected', function () {
      meter.hidden = true;
      if (menuNet) menuNet.textContent = '—';
    });
  }

  // Right-clicking the location in the top bar offers the copies that make
  // sense there: the SLURL of where we stand, the region name, the parcel name.
  function bindLocationContextMenu() {
    const center = document.querySelector('.top-bar__center');
    const menu = document.getElementById('context-menu');
    if (!center || !menu) return;

    function copyItem(label, value, what) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (!value) {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', function () {
          menu.hidden = true;
          if (!navigator.clipboard) return;
          navigator.clipboard.writeText(value).then(function () {
            BeeUtils.showToast(what + ' copied', 'success');
          }).catch(function () {});
        });
      }
      menu.appendChild(btn);
    }

    // The SLURL itself comes from the Rust core's own region/position state;
    // the JS mirrors can lag right after login or a teleport.
    function copySlurlItem() {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Copy SLURL';
      btn.disabled = !BeeState.gridOnline();
      btn.addEventListener('click', function () {
        menu.hidden = true;
        BeeBridge.invoke('sl_current_slurl').then(function (res) {
          if (!res || !res.slurl || !navigator.clipboard) return;
          navigator.clipboard.writeText(res.slurl).then(function () {
            BeeUtils.showToast('SLURL copied', 'success');
          }).catch(function () {});
        }).catch(function (err) {
          BeeUtils.showToast(err && err.message ? err.message : String(err || 'No location yet.'), 'warning');
        });
      });
      menu.appendChild(btn);
    }

    center.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const s = BeeState.get();
      const regionName = s.region && s.region.name ? s.region.name : '';
      const parcelName = s.parcel && !s.parcel.stub ? (s.parcel.name || '') : '';
      menu.innerHTML = '';
      menu.hidden = false;
      copySlurlItem();
      copyItem('Copy region name', regionName, 'Region name');
      copyItem('Copy parcel name', parcelName, 'Parcel name');
      const rect = menu.getBoundingClientRect();
      menu.style.left = Math.max(0, Math.min(e.clientX, window.innerWidth - rect.width - 8)) + 'px';
      menu.style.top = Math.max(0, Math.min(e.clientY, window.innerHeight - rect.height - 8)) + 'px';
    });
  }

  function init() {
    document.querySelectorAll('.bottom-nav__item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.dataset.tab);
      });
    });

    bindLocationContextMenu();
    bindNetMeter();

    document.getElementById('btn-logout').addEventListener('click', function () {
      if (window.BeeApp) window.BeeApp.logout();
    });

    const themeBtn = document.getElementById('btn-theme');
    if (themeBtn && typeof BeeSettings !== 'undefined') {
      themeBtn.addEventListener('click', function () {
        BeeSettings.toggleTheme();
      });
    }

    bindBeeMenu();

    const identity = document.querySelector('.top-bar__identity');
    if (identity) {
      identity.addEventListener('click', function () {
        const s = BeeState.get();
        if (!s.connected || s.sessionLost || !s.agent || !s.agent.id) return;
        if (typeof BeeProfile !== 'undefined' && typeof BeeProfile.openAvatar === 'function') {
          BeeProfile.openAvatar(s.agent.id, { agent: s.agent });
        }
      });
    }

    BeeState.on('change', function (partial) {
      updateTopBar();
      updateBadges();
      if (partial.connected === true) startSltClock();
      if (partial.connected === false || partial.sessionLost === true) stopSltClock();
    });

    BeeState.on('reset', function () {
      resetRadarTracking();
      stopSltClock();
      updateTopBar();
    });

    BeeState.on('chat', updateBadges);
    BeeState.on('im', updateBadges);
    BeeState.on('event', updateBadges);
    BeeState.on('radar-update', function (entries) {
      noteRadarUpdate(entries);
      updateBadges();
    });

    if (typeof BeeTransport !== 'undefined') {
      // Both teleport events live on the transport bus - the old BeeState
      // subscription for teleport-finish never fired (dead listener).
      BeeTransport.on('teleport-started', resetRadarTracking);
      BeeTransport.on('teleport-finish', resetRadarTracking);
    }

    if (typeof BeeProfiles !== 'undefined' && typeof BeeProfiles.onChange === 'function') {
      BeeProfiles.onChange(function (evt) {
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
