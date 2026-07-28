/**
 * Application bootstrap - brings the viewer up and wires the modules together.
 */
const BeeApp = (function () {
  'use strict';

  let allowUnload = false;
  let wasConnected = false;      // flips true once a session has connected during this run
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reconnecting = false;       // true while an attempt is in flight (so they never overlap)
  // Keep retrying every 60s, with no cap, until we reconnect or the user logs out.
  const RECONNECT_INTERVAL = 60000;
  const RECONNECT_FIRST_DELAY = 3000; // try again quickly the first time, to ride out a brief blip

  function shouldConfirmUnload() {
    if (allowUnload) return false;
    const s = BeeState.get();
    return !!(s.connected || s.connecting);
  }

  function bindUnloadGuard() {
    window.addEventListener('beforeunload', function (e) {
      if (!shouldConfirmUnload()) return;
      e.preventDefault();
      e.returnValue = '';
      return '';
    });
  }

  // Let the Rust core know whether to intercept a window-close so we can
  // confirm the logout first (only while a session is live).
  function setCloseGuard(on) {
    if (typeof BeeBridge !== 'undefined' && BeeBridge.invoke) {
      BeeBridge.invoke('set_close_guard', { guard: !!on }).catch(function () {});
    }
  }

  function cancelReconnect() {
    if (reconnectTimer) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempt = 0;
    reconnecting = false;
  }

  function autoReconnectEnabled() {
    return typeof BeeSettings !== 'undefined' && !!BeeSettings.get('autoReconnect') &&
      typeof BeeTransport.reconnect === 'function';
  }

  // Auto-reconnect: the Rust core replays the cached login (bridge_relogin).
  // We retry every 60s with no attempt limit (a user preference) until it
  // succeeds or the user logs out; on success the core's 'connected' event
  // resets our state. Attempts never overlap - we schedule the next one only
  // after the previous has ended.
  function scheduleReconnect(delay) {
    reconnectTimer = window.setTimeout(runReconnectAttempt, delay);
  }

  function runReconnectAttempt() {
    reconnectTimer = null;
    const s = BeeState.get();
    if (s.connected && !s.sessionLost) { cancelReconnect(); return; }
    if (reconnecting) { scheduleReconnect(RECONNECT_INTERVAL); return; }
    reconnecting = true;
    reconnectAttempt += 1;
    BeeUtils.showToast('Connection lost - reconnecting (attempt ' + reconnectAttempt + ')...',
      'warning', 4000);
    Promise.resolve(BeeTransport.reconnect()).then(function () {
      reconnecting = false;
      // 'connected' normally cancels the loop; guard here in case it doesn't fire.
      if (!BeeState.get().connected) scheduleReconnect(RECONNECT_INTERVAL);
    }).catch(function () {
      reconnecting = false;
      scheduleReconnect(RECONNECT_INTERVAL); // keep trying, there's no limit
    });
  }

  function startReconnect() {
    if (reconnectTimer || reconnecting) return; // we're already looping
    reconnectAttempt = 0;
    BeeState.patch({ connecting: true });
    scheduleReconnect(RECONNECT_FIRST_DELAY);
  }

  // Confirm before quitting the app - this is raised by the Rust window-close
  // intercept. Distinct from the logout button, which returns to the login screen.
  async function confirmAppClose() {
    const s = BeeState.get();
    if (!(s.connected || s.connecting)) {
      if (typeof BeeBridge !== 'undefined' && BeeBridge.invoke) {
        BeeBridge.invoke('confirm_close').catch(function () {});
      }
      return;
    }
    const ok = await BeeUtils.confirm({
      title: 'Close Minibee?',
      message: 'You are still connected to Second Life. Closing will log you out and quit the viewer.',
      confirmLabel: 'Log out & quit',
      danger: true
    });
    if (!ok) {
      // Tell the core the question was answered with "no", so the next press of X asks
      // again instead of being taken for a confirming second press.
      if (typeof BeeBridge !== 'undefined' && BeeBridge.invoke) {
        BeeBridge.invoke('cancel_close').catch(function () {});
      }
      return;
    }
    allowUnload = true;
    if (typeof BeeBridge !== 'undefined' && BeeBridge.invoke) {
      BeeBridge.invoke('confirm_close').catch(function () {});
    }
  }

  // Optional convenience (off by default): sit on the ground shortly after login.
  // The wait lets the arrival settle - the sim has only just finished seating us in
  // the region - and we check we're still connected before asking.
  const AUTO_SIT_DELAY = 2500;
  function maybeAutoSit() {
    if (typeof BeeSettings === 'undefined' || !BeeSettings.get('autoSitAfterLogin')) return;
    window.setTimeout(function () {
      const s = BeeState.get();
      if (!s.connected || s.sessionLost) return;
      if (typeof BeeBridge === 'undefined' || !BeeBridge.invoke) return;
      BeeBridge.invoke('sl_sit_ground').then(function () {
        if (typeof BeeInteract !== 'undefined' && BeeInteract.refreshState) BeeInteract.refreshState();
      }).catch(function () { /* nothing worth interrupting the user for */ });
    }, AUTO_SIT_DELAY);
  }

  function bindTransport() {
    BeeTransport.on('connected', function (payload) {
      allowUnload = false;
      wasConnected = true;
      cancelReconnect();
      setCloseGuard(true);
      BeeState.patch({
        connected: true,
        connecting: false,
        sessionLost: false,
        sessionLostReason: '',
        sessionLostDismissed: false,
        agent: payload.agent,
        region: payload.region,
        grid: payload.grid,
        buddies: payload.buddies,
        parcel: payload.parcel,
        position: payload.position
      });

      BeeMap.onConnected(payload);
      BeeState.patch({ unreadChat: 0, unreadIm: 0, unreadEvents: 0 });
      // Grab the current parcel up front so the top-bar parcel line resolves
      // without waiting for the user to open the Land tab.
      if (typeof BeeTransport.refreshParcel === 'function') BeeTransport.refreshParcel();
      BeeNavigation.switchTab('chat');
      BeeUtils.showToast('Welcome, ' + payload.agent.displayName, 'success');
      maybeAutoSit();

      // Show the login Message-of-the-Day as a system line (see renderMotdMessage).
      const motd = payload.motd ? String(payload.motd).trim() : '';
      if (motd) {
        BeeState.addChatMessage({
          id: BeeUtils.uuid(),
          kind: 'motd',
          fromId: '00000000-0000-0000-0000-000000000000',
          fromName: 'Second Life',
          text: motd,
          type: 'system',
          source: 'system',
          channel: 0,
          timestamp: Date.now()
        });
      }
    });

    BeeTransport.on('session-lost', function (data) {
      const reason = data && data.reason;
      // Auto-reconnect if it's enabled and we actually had a session; otherwise
      // fall back to the manual session-lost overlay.
      if (wasConnected && autoReconnectEnabled()) {
        startReconnect();
      } else {
        BeeSessionLost.show(reason);
      }
    });

    // Rust intercepted a window-close while a session is live - confirm before we quit.
    BeeTransport.on('close-requested', function () {
      confirmAppClose();
    });

    // Region capability health, as assessed by the Rust core (see caps::assess_caps).
    // Raises the degraded-features banner when caps or the EventQueue fail to come
    // up, and clears it once a region is healthy again.
    BeeTransport.on('caps-status', function (data) {
      BeeCapsBanner.update(data);
    });

    BeeTransport.on('disconnected', function () {
      wasConnected = false;
      cancelReconnect();
      setCloseGuard(false);
      BeeSessionLost.hide();
      BeeState.reset();
      BeeLogin.showScreen(false);
    });

    BeeTransport.on('region', function (data) {
      if (!data) return;
      BeeState.patch({
        region: Object.assign({}, BeeState.get().region, data)
      });
    });

    BeeTransport.on('chat', function (msg) {
      BeeState.addChatMessage(msg);
    });

    BeeTransport.on('event', function (msg) {
      BeeState.addEventMessage(msg);
    });

    BeeTransport.on('im', function (data) {
      const isSession = data.session && data.session.type && data.session.type !== 'p2p';
      if (data.participant && !isSession) {
        BeeState.ensureImSession(data.participant);
      }
      BeeState.addImMessage(data.sessionId, data.message, data.participant, data.session);
    });

    BeeTransport.on('im-session-open', function (data) {
      if (!data || !data.sessionId) return;
      BeeState.ensureKeyedSession(data.sessionId, { type: data.type, title: data.title });
    });

    // A conference we started just got its real session id back from the sim, so
    // rebind the tab we opened under the client temp id (see route_eq
    // ChatterBoxSessionStartReply).
    BeeTransport.on('im-session-remap', function (data) {
      if (!data || !data.tempId || !data.sessionId) return;
      if (data.success !== false) BeeState.remapImSession(data.tempId, data.sessionId);
    });

    BeeTransport.on('im-roster', function (data) {
      if (!data || !data.sessionId) return;
      BeeState.ensureKeyedSession(data.sessionId, { type: data.type, title: data.title });
      if (data.title) BeeState.renameSession(data.sessionId, data.title);
      if (data.type) BeeState.setSessionType(data.sessionId, data.type);
      BeeState.updateSessionRoster(data.sessionId, data.participants || [], data.moderator);
    });

    BeeTransport.on('im-typing', function (data) {
      if (!data || !data.sessionId) return;
      const session = BeeState.get().imSessions[data.sessionId];
      if (!session) return;
      if (session.dismissed) {
        session.dismissed = false;
        BeeState.emit('im-sessions-updated');
      }
      BeeState.setSessionTyping(data.sessionId, data.typing, data.fromName);
    });

    BeeTransport.on('im-session-force-close', function (data) {
      if (!data || !data.sessionId) return;
      const session = BeeState.get().imSessions[data.sessionId];
      const label = session ? (session.title || 'chat session') : 'chat session';
      BeeState.closeImSession(data.sessionId);
      BeeUtils.showToast((data.reason || 'The chat session was closed') +
        ' (' + label + ')', 'warning', 5000);
    });

    BeeTransport.on('radar-update', function (entries) {
      BeeState.patch({ radar: entries });
      BeeState.emit('radar-update', entries);
    });

    // A region restart is impending doom: modal, not a chat line, with a live
    // countdown so nobody misreads how long they have.
    let restartTimer = null;
    let restartDeadline = 0;
    let restartRegion = '';
    let restartBound = false;

    function paintRestartCountdown() {
      const textEl = document.getElementById('region-restart-text');
      if (!textEl) return;
      const left = Math.max(0, Math.round((restartDeadline - Date.now()) / 1000));
      const when = left >= 120
        ? ('about ' + Math.round(left / 60) + ' minutes')
        : left > 0
          ? (left + ' seconds')
          : 'any moment now';
      textEl.textContent = 'The region ' + (restartRegion ? '"' + restartRegion + '" ' : '') +
        'is restarting in ' + when + '.';
      if (left <= 0 && restartTimer) {
        window.clearInterval(restartTimer);
        restartTimer = null;
      }
    }

    BeeTransport.on('region-restart', function (data) {
      const dlg = document.getElementById('region-restart-dialog');
      if (!dlg) return;
      restartDeadline = Date.now() + (Math.max(0, (data && data.seconds) || 0) * 1000);
      restartRegion = (data && data.regionName) || '';
      if (!restartBound) {
        restartBound = true;
        const ok = document.getElementById('region-restart-ok');
        if (ok) ok.addEventListener('click', function () { BeeUtils.dismissDialog(dlg); });
        const map = document.getElementById('region-restart-map');
        if (map) {
          map.addEventListener('click', function () {
            BeeUtils.dismissDialog(dlg);
            if (typeof BeeNavigation !== 'undefined' && BeeNavigation.setTab) BeeNavigation.setTab('map');
          });
        }
      }
      paintRestartCountdown();
      if (restartTimer) window.clearInterval(restartTimer);
      restartTimer = window.setInterval(paintRestartCountdown, 1000);
      if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
    });

    // Leaving the doomed region - a teleport of our own, being teleported, or
    // a region crossing - makes the warning moot, so it closes on any region
    // change. Same when the session ends.
    function clearRestartWarning() {
      const dlg = document.getElementById('region-restart-dialog');
      if (dlg && dlg.open) BeeUtils.dismissDialog(dlg);
      if (restartTimer) { window.clearInterval(restartTimer); restartTimer = null; }
      restartRegion = '';
      restartDeadline = 0;
    }
    BeeTransport.on('teleport-finish', clearRestartWarning);
    BeeTransport.on('disconnected', clearRestartWarning);
    BeeTransport.on('region', function (data) {
      if (!restartRegion && !restartDeadline) return;
      const name = (data && (data.name || data.regionName)) || '';
      // A region event for somewhere else means we left the doomed sim.
      if (name && restartRegion && name.toLowerCase() !== restartRegion.toLowerCase()) {
        clearRestartWarning();
      }
    });

    // Radar alerts whose avatar name hasn't resolved yet: hold the toast until
    // the name lands (or a short timeout), instead of announcing "?".
    const pendingRadarAlerts = new Map(); // lowercased id -> { entry, timer }

    function showRadarToast(entry) {
      const names = BeeUtils.agentNameLines(entry);
      const label = names.title || entry.name || entry.id || 'Someone';
      BeeUtils.showToast('Radar: ' + label + ' (' + entry.range + 'm)', 'warning', 4500);
    }

    BeeTransport.on('names-updated', function (data) {
      if (!pendingRadarAlerts.size) return;
      ((data && data.names) || []).forEach(function (n) {
        const key = n && n.id ? String(n.id).toLowerCase() : '';
        const waiting = key && pendingRadarAlerts.get(key);
        if (!waiting) return;
        pendingRadarAlerts.delete(key);
        clearTimeout(waiting.timer);
        showRadarToast(Object.assign({}, waiting.entry, {
          name: n.name || n.displayName || n.userName || waiting.entry.name,
          displayName: n.displayName || '',
          userName: n.userName || ''
        }));
      });
    });

    BeeState.on('radar-alert', function (entry) {
      if (!BeeState.get().radarAlerts || !entry) return;
      const cached = entry.name ||
        (BeeTransport.getCachedName ? BeeTransport.getCachedName(entry.id) : '');
      if (cached) {
        showRadarToast(entry.name ? entry : Object.assign({}, entry, { name: cached }));
        return;
      }
      const key = String(entry.id || '').toLowerCase();
      if (!key || pendingRadarAlerts.has(key)) return;
      const timer = setTimeout(function () {
        pendingRadarAlerts.delete(key);
        showRadarToast(entry);
      }, 3000);
      pendingRadarAlerts.set(key, { entry: entry, timer: timer });
    });

    // The sim sends SimStats roughly once a second; coalesce fps patches so the top bar doesn't churn.
    let lastFpsValue = null;
    let lastFpsPatchAt = 0;
    const FPS_PATCH_MIN_MS = 3000;
    BeeTransport.on('stats', function (stats) {
      if (!stats || !stats.fps) return;
      const now = Date.now();
      if (stats.fps === lastFpsValue || now - lastFpsPatchAt < FPS_PATCH_MIN_MS) return;
      lastFpsValue = stats.fps;
      lastFpsPatchAt = now;
      BeeState.patch({ fps: stats.fps });
    });

    // Payment/transaction events: the sim sometimes sends the same MoneyBalanceReply
    // more than once, so we dedupe on (type, description, balance) within a TTL and
    // refresh the existing card in place rather than stacking duplicates.
    const recentPayments = new Map(); // keyed by signature -> { id, at }
    const PAYMENT_TTL_MS = 15000;
    BeeTransport.on('money-balance', function (data) {
      if (!data || data.balance === undefined || data.balance === null) return;
      BeeState.patch({ lindenBalance: data.balance });
      const desc = (data.description || '').trim();
      if (!desc) return; // balance-only update, so there's nothing to post as a transaction
      const now = Date.now();
      recentPayments.forEach(function (v, k) { if (now - v.at > PAYMENT_TTL_MS) recentPayments.delete(k); });
      const sig = (data.transactionType != null ? data.transactionType : '') + '|' + desc + '|' + data.balance;
      const existing = recentPayments.get(sig);
      if (existing) {
        BeeState.patchEventMessage(existing.id, { payment: { balance: data.balance } });
        existing.at = now;
        return;
      }
      const id = BeeUtils.uuid();
      recentPayments.set(sig, { id: id, at: now });
      BeeState.addEventMessage({
        id: id,
        kind: 'payment',
        text: desc,
        timestamp: now,
        payment: { balance: data.balance, transactionType: data.transactionType, description: desc }
      });
    });

    BeeTransport.on('parcel', function (parcel) {
      if (!parcel) return;
      const prev = BeeState.get().parcel || {};
      if (parcel.stub && prev.stub) {
        BeeState.patch({ parcel: parcel });
      } else {
        const next = Object.assign({}, prev, parcel);
        if (parcel.stub !== true) next.stub = false;
        BeeState.patch({ parcel: next });
      }
      if (!parcel.stub && !BeeNavigation.isTabActive('land')) {
        BeeState.patch({ landUpdated: true });
      }
    });

    BeeTransport.on('parcel-updated', function (data) {
      const merged = Object.assign({}, BeeState.get().parcel, data, { stub: false });
      BeeState.patch({ parcel: merged });
      if (!BeeNavigation.isTabActive('land')) {
        BeeState.patch({ landUpdated: true });
      }
    });

    BeeTransport.on('buddies-updated', function (buddies) {
      BeeState.patch({ buddies: buddies });
      if (BeeNavigation.isTabActive('buddies')) {
        BeeBuddies.render();
      }
    });


    BeeTransport.on('teleport-finish', function (data) {
      const patch = {};
      if (data && data.position) patch.position = data.position;
      if (data && data.region) {
        patch.region = Object.assign({}, BeeState.get().region, data.region);
      }
      const resolvedName = (data && data.region && data.region.name) ||
        (data && data.regionName) || '';
      if (resolvedName && !/^(home|region)$/i.test(String(resolvedName).trim())) {
        patch.region = Object.assign({}, patch.region || BeeState.get().region, {
          name: resolvedName
        });
      }
      if (Object.keys(patch).length) BeeState.patch(patch);
      // Refresh the parcel for the new region so the top-bar parcel line updates
      // without opening Land, delayed a touch so the retargeted circuit has settled.
      if (typeof BeeTransport.refreshParcel === 'function') {
        window.setTimeout(function () {
          if (!BeeState.get().sessionLost) BeeTransport.refreshParcel();
        }, 1500);
      }
      // teleport.js owns the arrival toast, so we don't raise a second one here.
    });

    BeeTransport.on('position', function (data) {
      if (data && data.position) {
        BeeState.patch({ position: data.position });
      }
      if (data && data.region) {
        BeeState.patch({ region: Object.assign({}, BeeState.get().region, data.region) });
      }
    });
  }

  async function login(credentials) {
    allowUnload = false;
    BeeState.patch({ connecting: true });
    BeeTransport.use(BeeSLBridge);
    const result = await BeeTransport.login(credentials);
    BeeTransport.start();
    return result;
  }

  async function logout(options) {
    const opts = options || {};
    const s = BeeState.get();
    if (!opts.skipConfirm && (s.connected || s.connecting)) {
      const ok = await BeeUtils.confirm({
        title: 'Log out?',
        message: 'You will be disconnected from Second Life.',
        confirmLabel: 'Log out',
        danger: true
      });
      if (!ok) return;
    }
    allowUnload = true;
    await BeeTransport.logout();
    BeeState.reset();
    BeeLogin.showScreen(false);
  }

  function init() {
    if (window.MINIBEE_BLOCKED) return;
    try {
      setCloseGuard(false);
      if (typeof BeeDiag !== 'undefined') BeeDiag.init();
      installContextMenu();
      if (typeof BeeSettings !== 'undefined') BeeSettings.init();
      bindUnloadGuard();
      bindTransport();
      BeeLogin.init();
      BeeNavigation.init();
      BeeChat.init();
      BeeIm.init();
      BeeEvents.init();
      BeeBuddies.init();
      BeeSearch.init();
      BeeRadar.init();
      BeeMap.init();
      BeeLand.init();
      BeeDestinations.init();
      BeeTeleportUI.init();
      BeeTeleportProgress.init();
      BeeAvatarThumb.init();
      BeeProfile.init();
      BeeSettingsUI.init();
      BeeNews.init();
      BeeInteract.init();
      BeeSessionLost.init();
      BeeCapsBanner.init();
      if (typeof BeeParcelMusic !== 'undefined') BeeParcelMusic.init();
      if (typeof MinibeeVersion !== 'undefined' && MinibeeVersion.load) {
        MinibeeVersion.load().catch(function () {});
      }
      if (typeof BeeUpdater !== 'undefined' && BeeUpdater.checkStartup) {
        window.setTimeout(function () { BeeUpdater.checkStartup(); }, 2500);
      }
    } catch (err) {
      console.error('Minibee init failed:', err);
      const el = document.getElementById('login-error');
      if (el) {
        el.hidden = false;
        el.textContent = 'Viewer init failed: ' + (err.message || String(err));
      }
    }
  }

  function installContextMenu() {
    if (typeof BeeContextMenu !== 'undefined' && BeeContextMenu.init) {
      BeeContextMenu.init();
      return;
    }
    if (typeof BeeBridge === 'undefined' || !BeeBridge.invoke) return;
    BeeBridge.invoke('bridge_health').then(function (h) {
      if (h && h.dev === false) {
        window.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      }
    }).catch(function () { /* health check is optional, ignore failures */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { login: login, logout: logout, init: init };
})();

window.BeeApp = BeeApp;
