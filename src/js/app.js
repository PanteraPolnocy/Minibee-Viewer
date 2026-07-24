/**
 * Application bootstrap - brings the viewer up and wires the modules together.
 */
const FSApp = (function () {
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
    const s = FSState.get();
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
    if (typeof FSBridge !== 'undefined' && FSBridge.invoke) {
      FSBridge.invoke('set_close_guard', { guard: !!on }).catch(function () {});
    }
  }

  function cancelReconnect() {
    if (reconnectTimer) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempt = 0;
    reconnecting = false;
  }

  function autoReconnectEnabled() {
    return typeof FSSettings !== 'undefined' && !!FSSettings.get('autoReconnect') &&
      typeof FSTransport.reconnect === 'function';
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
    const s = FSState.get();
    if (s.connected && !s.sessionLost) { cancelReconnect(); return; }
    if (reconnecting) { scheduleReconnect(RECONNECT_INTERVAL); return; }
    reconnecting = true;
    reconnectAttempt += 1;
    FSUtils.showToast('Connection lost - reconnecting (attempt ' + reconnectAttempt + ')…',
      'warning', 4000);
    Promise.resolve(FSTransport.reconnect()).then(function () {
      reconnecting = false;
      // 'connected' normally cancels the loop; guard here in case it doesn't fire.
      if (!FSState.get().connected) scheduleReconnect(RECONNECT_INTERVAL);
    }).catch(function () {
      reconnecting = false;
      scheduleReconnect(RECONNECT_INTERVAL); // keep trying, there's no limit
    });
  }

  function startReconnect() {
    if (reconnectTimer || reconnecting) return; // we're already looping
    reconnectAttempt = 0;
    FSState.patch({ connecting: true });
    scheduleReconnect(RECONNECT_FIRST_DELAY);
  }

  // Confirm before quitting the app - this is raised by the Rust window-close
  // intercept. Distinct from the logout button, which returns to the login screen.
  async function confirmAppClose() {
    const s = FSState.get();
    if (!(s.connected || s.connecting)) {
      if (typeof FSBridge !== 'undefined' && FSBridge.invoke) {
        FSBridge.invoke('confirm_close').catch(function () {});
      }
      return;
    }
    const ok = await FSUtils.confirm({
      title: 'Close Minibee?',
      message: 'You are still connected to Second Life. Closing will log you out and quit the viewer.',
      confirmLabel: 'Log out & quit',
      danger: true
    });
    if (!ok) return;
    allowUnload = true;
    if (typeof FSBridge !== 'undefined' && FSBridge.invoke) {
      FSBridge.invoke('confirm_close').catch(function () {});
    }
  }

  function bindTransport() {
    FSTransport.on('connected', function (payload) {
      allowUnload = false;
      wasConnected = true;
      cancelReconnect();
      setCloseGuard(true);
      FSState.patch({
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

      FSMap.onConnected(payload);
      FSState.patch({ unreadChat: 0, unreadIm: 0, unreadEvents: 0 });
      // Grab the current parcel up front so the top-bar parcel line resolves
      // without waiting for the user to open the Land tab.
      if (typeof FSTransport.refreshParcel === 'function') FSTransport.refreshParcel();
      FSNavigation.switchTab('chat');
      FSUtils.showToast('Welcome, ' + payload.agent.displayName, 'success');

      // Show the login Message-of-the-Day as a system line (see renderMotdMessage).
      const motd = payload.motd ? String(payload.motd).trim() : '';
      if (motd) {
        FSState.addChatMessage({
          id: FSUtils.uuid(),
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

    FSTransport.on('session-lost', function (data) {
      const reason = data && data.reason;
      // Auto-reconnect if it's enabled and we actually had a session; otherwise
      // fall back to the manual session-lost overlay.
      if (wasConnected && autoReconnectEnabled()) {
        startReconnect();
      } else {
        FSSessionLost.show(reason);
      }
    });

    // Rust intercepted a window-close while a session is live - confirm before we quit.
    FSTransport.on('close-requested', function () {
      confirmAppClose();
    });

    // Region capability health, as assessed by the Rust core (see caps::assess_caps).
    // Raises the degraded-features banner when caps or the EventQueue fail to come
    // up, and clears it once a region is healthy again.
    FSTransport.on('caps-status', function (data) {
      FSCapsBanner.update(data);
    });

    FSTransport.on('disconnected', function () {
      wasConnected = false;
      cancelReconnect();
      setCloseGuard(false);
      FSSessionLost.hide();
      FSState.reset();
      FSLogin.showScreen(false);
    });

    FSTransport.on('region', function (data) {
      if (!data) return;
      FSState.patch({
        region: Object.assign({}, FSState.get().region, data)
      });
    });

    FSTransport.on('chat', function (msg) {
      FSState.addChatMessage(msg);
    });

    FSTransport.on('event', function (msg) {
      FSState.addEventMessage(msg);
    });

    FSTransport.on('im', function (data) {
      const isSession = data.session && data.session.type && data.session.type !== 'p2p';
      if (data.participant && !isSession) {
        FSState.ensureImSession(data.participant);
      }
      FSState.addImMessage(data.sessionId, data.message, data.participant, data.session);
    });

    FSTransport.on('im-session-open', function (data) {
      if (!data || !data.sessionId) return;
      FSState.ensureKeyedSession(data.sessionId, { type: data.type, title: data.title });
    });

    // A conference we started just got its real session id back from the sim, so
    // rebind the tab we opened under the client temp id (see route_eq
    // ChatterBoxSessionStartReply).
    FSTransport.on('im-session-remap', function (data) {
      if (!data || !data.tempId || !data.sessionId) return;
      if (data.success !== false) FSState.remapImSession(data.tempId, data.sessionId);
    });

    FSTransport.on('im-roster', function (data) {
      if (!data || !data.sessionId) return;
      FSState.ensureKeyedSession(data.sessionId, { type: data.type, title: data.title });
      if (data.title) FSState.renameSession(data.sessionId, data.title);
      if (data.type) FSState.setSessionType(data.sessionId, data.type);
      FSState.updateSessionRoster(data.sessionId, data.participants || [], data.moderator);
    });

    FSTransport.on('im-typing', function (data) {
      if (!data || !data.sessionId) return;
      const session = FSState.get().imSessions[data.sessionId];
      if (!session) return;
      if (session.dismissed) {
        session.dismissed = false;
        FSState.emit('im-sessions-updated');
      }
      FSState.setSessionTyping(data.sessionId, data.typing, data.fromName);
    });

    FSTransport.on('im-session-force-close', function (data) {
      if (!data || !data.sessionId) return;
      const session = FSState.get().imSessions[data.sessionId];
      const label = session ? (session.title || 'chat session') : 'chat session';
      FSState.closeImSession(data.sessionId);
      FSUtils.showToast((data.reason || 'The chat session was closed') +
        ' (' + label + ')', 'warning', 5000);
    });

    FSTransport.on('radar-update', function (entries) {
      FSState.patch({ radar: entries });
      FSState.emit('radar-update', entries);
    });

    FSState.on('radar-alert', function (entry) {
      if (!FSState.get().radarAlerts || !entry) return;
      const names = FSUtils.agentNameLines(entry);
      const label = names.title || entry.name || entry.id || 'Someone';
      FSUtils.showToast('Radar: ' + label + ' (' + entry.range + 'm)', 'warning', 4500);
    });

    // The sim sends SimStats roughly once a second; coalesce fps patches so the top bar doesn't churn.
    let lastFpsValue = null;
    let lastFpsPatchAt = 0;
    const FPS_PATCH_MIN_MS = 3000;
    FSTransport.on('stats', function (stats) {
      if (!stats || !stats.fps) return;
      const now = Date.now();
      if (stats.fps === lastFpsValue || now - lastFpsPatchAt < FPS_PATCH_MIN_MS) return;
      lastFpsValue = stats.fps;
      lastFpsPatchAt = now;
      FSState.patch({ fps: stats.fps });
    });

    // Payment/transaction events: the sim sometimes sends the same MoneyBalanceReply
    // more than once, so we dedupe on (type, description, balance) within a TTL and
    // refresh the existing card in place rather than stacking duplicates.
    const recentPayments = new Map(); // keyed by signature -> { id, at }
    const PAYMENT_TTL_MS = 15000;
    FSTransport.on('money-balance', function (data) {
      if (!data || data.balance === undefined || data.balance === null) return;
      FSState.patch({ lindenBalance: data.balance });
      const desc = (data.description || '').trim();
      if (!desc) return; // balance-only update, so there's nothing to post as a transaction
      const now = Date.now();
      recentPayments.forEach(function (v, k) { if (now - v.at > PAYMENT_TTL_MS) recentPayments.delete(k); });
      const sig = (data.transactionType != null ? data.transactionType : '') + '|' + desc + '|' + data.balance;
      const existing = recentPayments.get(sig);
      if (existing) {
        FSState.patchEventMessage(existing.id, { payment: { balance: data.balance } });
        existing.at = now;
        return;
      }
      const id = FSUtils.uuid();
      recentPayments.set(sig, { id: id, at: now });
      FSState.addEventMessage({
        id: id,
        kind: 'payment',
        text: desc,
        timestamp: now,
        payment: { balance: data.balance, transactionType: data.transactionType, description: desc }
      });
    });

    FSTransport.on('parcel', function (parcel) {
      if (!parcel) return;
      const prev = FSState.get().parcel || {};
      if (parcel.stub && prev.stub) {
        FSState.patch({ parcel: parcel });
      } else {
        const next = Object.assign({}, prev, parcel);
        if (parcel.stub !== true) next.stub = false;
        FSState.patch({ parcel: next });
      }
      if (!parcel.stub && !FSNavigation.isTabActive('land')) {
        FSState.patch({ landUpdated: true });
      }
    });

    FSTransport.on('parcel-updated', function (data) {
      const merged = Object.assign({}, FSState.get().parcel, data, { stub: false });
      FSState.patch({ parcel: merged });
      if (!FSNavigation.isTabActive('land')) {
        FSState.patch({ landUpdated: true });
      }
    });

    FSTransport.on('buddies-updated', function (buddies) {
      FSState.patch({ buddies: buddies });
      if (FSNavigation.isTabActive('buddies')) {
        FSBuddies.render();
      }
    });


    FSTransport.on('teleport-finish', function (data) {
      const patch = {};
      if (data && data.position) patch.position = data.position;
      if (data && data.region) {
        patch.region = Object.assign({}, FSState.get().region, data.region);
      }
      const resolvedName = (data && data.region && data.region.name) ||
        (data && data.regionName) || '';
      if (resolvedName && !/^(home|region)$/i.test(String(resolvedName).trim())) {
        patch.region = Object.assign({}, patch.region || FSState.get().region, {
          name: resolvedName
        });
      }
      if (Object.keys(patch).length) FSState.patch(patch);
      // Refresh the parcel for the new region so the top-bar parcel line updates
      // without opening Land, delayed a touch so the retargeted circuit has settled.
      if (typeof FSTransport.refreshParcel === 'function') {
        window.setTimeout(function () {
          if (!FSState.get().sessionLost) FSTransport.refreshParcel();
        }, 1500);
      }
      // teleport.js owns the arrival toast, so we don't raise a second one here.
    });

    FSTransport.on('position', function (data) {
      if (data && data.position) {
        FSState.patch({ position: data.position });
      }
      if (data && data.region) {
        FSState.patch({ region: Object.assign({}, FSState.get().region, data.region) });
      }
    });
  }

  async function login(credentials) {
    allowUnload = false;
    FSState.patch({ connecting: true });
    FSTransport.use(FSSLBridge);
    const result = await FSTransport.login(credentials);
    FSTransport.start();
    return result;
  }

  async function logout(options) {
    const opts = options || {};
    const s = FSState.get();
    if (!opts.skipConfirm && (s.connected || s.connecting)) {
      const ok = await FSUtils.confirm({
        title: 'Log out?',
        message: 'You will be disconnected from Second Life.',
        confirmLabel: 'Log out',
        danger: true
      });
      if (!ok) return;
    }
    allowUnload = true;
    await FSTransport.logout();
    FSState.reset();
    FSLogin.showScreen(false);
  }

  function init() {
    if (window.MINIBEE_BLOCKED) return;
    try {
      if (typeof FSDiag !== 'undefined') FSDiag.init();
      disableContextMenuInRelease();
      if (typeof FSSettings !== 'undefined') FSSettings.init();
      bindUnloadGuard();
      bindTransport();
      FSLogin.init();
      FSNavigation.init();
      FSChat.init();
      FSIm.init();
      FSEvents.init();
      FSBuddies.init();
      FSSearch.init();
      FSRadar.init();
      FSMap.init();
      FSLand.init();
      FSDestinations.init();
      FSTeleportUI.init();
      FSTeleportProgress.init();
      FSAvatarThumb.init();
      FSProfile.init();
      FSSettingsUI.init();
      FSSessionLost.init();
      FSCapsBanner.init();
      if (typeof FSParcelMusic !== 'undefined') FSParcelMusic.init();
    } catch (err) {
      console.error('Minibee init failed:', err);
      const el = document.getElementById('login-error');
      if (el) {
        el.hidden = false;
        el.textContent = 'Viewer init failed: ' + (err.message || String(err));
      }
    }
  }

  // In release builds the WebView's default right-click menu exposes a Reload
  // item that just confuses end users, so suppress it. Dev builds keep it.
  function disableContextMenuInRelease() {
    if (typeof FSBridge === 'undefined' || !FSBridge.invoke) return;
    FSBridge.invoke('bridge_health').then(function (h) {
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

window.FSApp = FSApp;
