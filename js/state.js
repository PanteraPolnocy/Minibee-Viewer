/**
 * Central application state with pub/sub.
 */
const FSState = (function () {
  'use strict';

  const listeners = new Map();

  const state = {
    connected: false,
    connecting: false,
    agent: null,
    region: null,
    grid: 'agni',
    position: { x: 128, y: 128, z: 25 },
    fps: 45,
    lindenBalance: null,
    buddies: [],
    radar: [],
    chatMessages: [],
    eventMessages: [],
    imSessions: {},
    activeImSession: null,
    parcel: null,
    unreadIm: 0,
    unreadChat: 0,
    unreadEvents: 0,
    unreadRadar: 0,
    landUpdated: false,
    activeTab: 'chat',
    radarRange: 96,
    radarAlerts: true,
    sessionLost: false,
    sessionLostReason: '',
    sessionLostDismissed: false
  };

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return function () { listeners.get(event).delete(fn); };
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (set) {
      set.forEach(function (fn) { fn(payload, state); });
    }
  }

  function patch(partial) {
    Object.assign(state, partial);
    emit('change', partial);
  }

  function reset() {
    state.connected = false;
    state.connecting = false;
    state.agent = null;
    state.region = null;
    state.buddies = [];
    state.radar = [];
    state.chatMessages = [];
    state.eventMessages = [];
    state.imSessions = {};
    state.activeImSession = null;
    state.parcel = null;
    state.unreadIm = 0;
    state.unreadChat = 0;
    state.unreadEvents = 0;
    state.unreadRadar = 0;
    state.landUpdated = false;
    state.lindenBalance = null;
    state.sessionLost = false;
    state.sessionLostReason = '';
    state.sessionLostDismissed = false;
    emit('reset');
  }

  function gridOnline() {
    return state.connected && !state.sessionLost;
  }

  function isEventUnread(msg) {
    if (!msg) return false;
    if (msg.kind === 'script-dialog' && msg.dialog && msg.dialog.resolved) return false;
    if (msg.kind === 'script-permission' && msg.permission && msg.permission.resolved) return false;
    if (msg.kind === 'interactive-prompt' && msg.prompt && msg.prompt.resolved) return false;
    if (msg.kind === 'payment' && msg.payment && msg.payment.seen) return false;
    return true;
  }

  function isChatUnread(msg) {
    if (!msg) return false;
    if (msg.outgoing) return false;
    if (msg.type === 'system' || msg.source === 'system') return false;
    if (msg.kind === 'script-dialog' || msg.kind === 'script-permission' ||
        msg.kind === 'interactive-prompt' || msg.kind === 'payment' || msg.kind === 'motd') {
      return false;
    }
    return true;
  }

  function patchEventMessage(id, partial) {
    const msg = state.eventMessages.find(function (m) { return m.id === id; });
    if (!msg) return false;
    Object.assign(msg, partial || {});
    if (partial && partial.dialog) {
      msg.dialog = Object.assign({}, msg.dialog, partial.dialog);
    }
    if (partial && partial.permission) {
      msg.permission = Object.assign({}, msg.permission, partial.permission);
    }
    if (partial && partial.prompt) {
      msg.prompt = Object.assign({}, msg.prompt, partial.prompt);
    }
    if (partial && partial.payment) {
      msg.payment = Object.assign({}, msg.payment, partial.payment);
    }
    emit('event-updated', msg);
    return true;
  }

  function patchMessage(id, partial) {
    if (patchChatMessage(id, partial)) return true;
    return patchEventMessage(id, partial);
  }

  function addEventMessage(msg) {
    state.eventMessages.push(msg);
    if (state.activeTab !== 'events' && isEventUnread(msg)) {
      state.unreadEvents += 1;
    }
    emit('event', msg);
  }

  function closeImSession(sessionId) {
    const session = state.imSessions[sessionId];
    if (!session) return false;
    const unread = session.unread || 0;
    delete state.imSessions[sessionId];
    const partial = {};
    if (state.activeImSession === sessionId) {
      partial.activeImSession = null;
      state.activeImSession = null;
    }
    if (unread > 0) {
      partial.unreadIm = Math.max(0, state.unreadIm - unread);
      state.unreadIm = partial.unreadIm;
    }
    emit('im-session-closed', sessionId);
    if (Object.keys(partial).length) {
      emit('change', partial);
    }
    return true;
  }

  function patchChatMessage(id, partial) {
    const msg = state.chatMessages.find(function (m) { return m.id === id; });
    if (!msg) return false;
    Object.assign(msg, partial || {});
    if (partial && partial.dialog) {
      msg.dialog = Object.assign({}, msg.dialog, partial.dialog);
    }
    if (partial && partial.permission) {
      msg.permission = Object.assign({}, msg.permission, partial.permission);
    }
    if (partial && partial.prompt) {
      msg.prompt = Object.assign({}, msg.prompt, partial.prompt);
    }
    emit('chat-updated', msg);
    return true;
  }

  function isImUnread(msg) {
    if (!msg || msg.outgoing) return false;
    return String(msg.text || '').trim().length > 0;
  }

  function addChatMessage(msg) {
    state.chatMessages.push(msg);
    if (state.activeTab !== 'chat' && isChatUnread(msg)) {
      state.unreadChat += 1;
    }
    emit('chat', msg);
  }

  function addImMessage(sessionId, msg, participant) {
    if (!state.imSessions[sessionId] && participant) {
      ensureImSession(participant);
    }
    if (!state.imSessions[sessionId]) return;
    const session = state.imSessions[sessionId];
    if (msg && msg.id) {
      const dup = session.messages.some(function (m) { return m.id === msg.id; });
      if (dup) return;
    }
    session.messages.push(msg);
    session.lastMessage = msg.text;
    session.updatedAt = msg.timestamp;
    if (isImUnread(msg) && state.activeTab !== 'im' && state.activeImSession !== sessionId) {
      session.unread = (session.unread || 0) + 1;
      state.unreadIm += 1;
    }
    emit('im', { sessionId: sessionId, message: msg });
  }

  function looksLikeUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
  }

  function normAgentId(id) {
    return String(id || '').toLowerCase();
  }

  function resolveParticipantPresence(participant) {
    if (!participant || !participant.id) return participant;
    const target = normAgentId(participant.id);
    const out = Object.assign({}, participant);

    const buddy = (state.buddies || []).find(function (b) {
      return normAgentId(b.id) === target;
    });
    if (buddy) {
      if (buddy.online) {
        out.online = true;
        if (buddy.region) out.region = buddy.region;
      }
      if (!out.name || out.name === 'Resident') out.name = buddy.name || out.name;
      if (!out.userName) out.userName = buddy.userName || buddy.legacyName || out.userName;
      if (!out.displayName) out.displayName = buddy.displayName || out.displayName;
    }

    const radar = (state.radar || []).find(function (r) {
      return normAgentId(r.id) === target;
    });
    if (radar) {
      out.online = true;
      if (radar.region) out.region = radar.region;
    }
    return out;
  }

  function refreshImSessionPresence(sessionId) {
    const session = state.imSessions[sessionId];
    if (!session || !session.participant) return false;
    const prevOnline = !!session.participant.online;
    const prevRegion = String(session.participant.region || '');
    session.participant = resolveParticipantPresence(session.participant);
    const changed = !!session.participant.online !== prevOnline ||
      String(session.participant.region || '') !== prevRegion;
    if (changed) {
      emit('im-sessions-updated');
    }
    return changed;
  }

  function ensureImSession(participant) {
    const agentId = state.agent && state.agent.id;
    if (!agentId || !participant || !participant.id) return null;

    const sessionId = FSUtils.xorSessionId(agentId, participant.id);
    if (!state.imSessions[sessionId]) {
      state.imSessions[sessionId] = {
        id: sessionId,
        participant: resolveParticipantPresence(participant),
        messages: [],
        unread: 0,
        lastMessage: '',
        updatedAt: Date.now()
      };
      emit('im-session-new', state.imSessions[sessionId]);
    } else {
      const prev = state.imSessions[sessionId].participant || {};
      let name = participant.name;
      if (looksLikeUuid(name) && prev.name && !looksLikeUuid(prev.name)) {
        name = prev.name;
      } else if (!looksLikeUuid(participant.name)) {
        name = participant.name;
      }
      const merged = Object.assign({}, prev, participant, { name: name });
      state.imSessions[sessionId].participant = resolveParticipantPresence(merged);
    }
    return sessionId;
  }

  function get() {
    return state;
  }

  return {
    on: on,
    emit: emit,
    patch: patch,
    reset: reset,
    addChatMessage: addChatMessage,
    addEventMessage: addEventMessage,
    patchChatMessage: patchChatMessage,
    patchEventMessage: patchEventMessage,
    patchMessage: patchMessage,
    addImMessage: addImMessage,
    closeImSession: closeImSession,
    ensureImSession: ensureImSession,
    refreshImSessionPresence: refreshImSessionPresence,
    resolveParticipantPresence: resolveParticipantPresence,
    get: get,
    gridOnline: gridOnline
  };
})();
