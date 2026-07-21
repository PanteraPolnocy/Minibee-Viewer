/**
 * Application bootstrap.
 */
const FSApp = (function () {
  'use strict';

  let allowUnload = false;

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

  function bindTransport() {
    FSTransport.on('connected', function (payload) {
      allowUnload = false;
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
      FSNavigation.switchTab('chat');
      FSUtils.showToast('Welcome, ' + payload.agent.displayName, 'success');
    });

    FSTransport.on('session-lost', function (data) {
      FSSessionLost.show(data && data.reason);
    });

    FSTransport.on('disconnected', function () {
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

    FSTransport.on('im-session-remap', function (data) {
      if (!data || !data.tempId || !data.sessionId) return;
      FSState.migrateSession(data.tempId, data.sessionId, {
        type: data.type,
        title: data.title
      });
    });

    FSTransport.on('im-session-force-close', function (data) {
      if (!data || !data.sessionId) return;
      const session = FSState.get().imSessions[data.sessionId];
      const label = session ? (session.title || 'chat session') : 'chat session';
      FSState.closeImSession(data.sessionId);
      FSUtils.showToast((data.reason || 'The chat session was closed') +
        ' (' + label + ')', 'warning', 5000);
    });

    FSTransport.on('im-session-cleanup', function (data) {
      if (!data || !data.sessionId) return;
      FSState.closeImSession(data.sessionId);
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

    FSTransport.on('stats', function (stats) {
      if (stats.fps) FSState.patch({ fps: stats.fps });
    });

    FSTransport.on('money-balance', function (data) {
      if (!data || data.balance === undefined || data.balance === null) return;
      FSState.patch({ lindenBalance: data.balance });
    });

    FSTransport.on('parcel', function (parcel) {
      if (!parcel) return;
      const prev = FSState.get().parcel || {};
      if (parcel.stub && (!prev || prev.stub)) {
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

    FSTransport.on('teleport-failed', function (data) {
      FSUtils.showToast((data && data.reason) || 'Teleport failed', 'error', 5000);
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
      FSUtils.showToast('Teleport complete', 'success', 3500);
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
    FSTransport.use(FSSLTransport);
    const result = await FSTransport.login(credentials);
    FSTransport.start();
    return result;
  }

  async function logout(options) {
    const opts = options || {};
    const s = FSState.get();
    if (!opts.skipConfirm && (s.connected || s.connecting)) {
      const ok = window.confirm(
        'Log out of Minibee Viewer? You will be disconnected from Second Life.'
      );
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
      FSAvatarThumb.init();
      FSProfile.init();
      FSErrorsUI.init();
      FSSessionLost.init();
    } catch (err) {
      console.error('Minibee init failed:', err);
      const el = document.getElementById('login-error');
      if (el) {
        el.hidden = false;
        el.textContent = 'Viewer init failed: ' + (err.message || String(err));
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { login: login, logout: logout, init: init };
})();

window.FSApp = FSApp;
