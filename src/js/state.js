/**
 * The single source of truth for app state, with a small pub/sub layer on top.
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
    if (!set) return;
    // Keep listeners isolated from one another: if one subscriber throws, it must
    // not unwind through the transport and skip the rest (e.g. the UDP batch's ACK flush).
    set.forEach(function (fn) {
      try {
        fn(payload, state);
      } catch (err) {
        if (typeof console !== 'undefined') console.error('state listener error (' + event + '):', err);
      }
    });
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

  function dismissImSession(sessionId) {
    const session = state.imSessions[sessionId];
    if (!session) return false;
    if (session.type === 'group' || session.type === 'conference') {
      return closeImSession(sessionId);
    }
    if (session.dismissed) return false;
    const unread = session.unread || 0;
    session.dismissed = true;
    session.unread = 0;
    if (session.typing) {
      session.typing = false;
      session.typingName = '';
    }
    const partial = {};
    if (state.activeImSession === sessionId) {
      partial.activeImSession = null;
      state.activeImSession = null;
    }
    if (unread > 0) {
      partial.unreadIm = Math.max(0, state.unreadIm - unread);
      state.unreadIm = partial.unreadIm;
    }
    emit('im-session-dismissed', sessionId);
    emit('im-sessions-updated');
    if (Object.keys(partial).length) {
      emit('change', partial);
    }
    return true;
  }

  function shouldCountImUnread(sessionId, msg) {
    if (!isImUnread(msg)) return false;
    const session = state.imSessions[sessionId];
    if (!session || session.muted) return false;
    if (state.activeImSession === sessionId) return false;
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

  const DEFAULT_SESSION_TITLES = { group: 'Group chat', conference: 'Conference' };

  // A base64 session bucket decodes to binary (UUIDs and flags), whereas a real
  // group name that just happens to be alphanumeric decodes to printable ASCII.
  // We lean on that so names like "Adventurers" don't get mistaken for placeholders.
  function looksLikeBase64Bucket(text) {
    if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(text) || text.length % 4 !== 0) return false;
    if (typeof atob !== 'function') return false;
    try {
      const bin = atob(text);
      for (let i = 0; i < bin.length; i++) {
        const c = bin.charCodeAt(i);
        if (c < 0x20 || c > 0x7e) return true; // a non-printable byte means this is a real bucket
      }
      return false;
    } catch (_e) {
      return false;
    }
  }

  function isDefaultSessionTitle(title) {
    const text = String(title || '').trim();
    return !text || text === DEFAULT_SESSION_TITLES.group ||
      text === DEFAULT_SESSION_TITLES.conference || looksLikeUuid(text) ||
      looksLikeBase64Bucket(text);
  }

  function ensureKeyedSession(sessionId, info) {
    if (!sessionId || state.imSessions[sessionId]) return sessionId;
    const type = (info && info.type) || 'group';
    const title = (info && info.title) ||
      (type === 'conference' ? DEFAULT_SESSION_TITLES.conference : DEFAULT_SESSION_TITLES.group);
    state.imSessions[sessionId] = {
      id: sessionId,
      type: type,
      title: title,
      participant: { id: sessionId, name: title, isSession: true },
      participants: [],
      messages: [],
      unread: 0,
      lastMessage: '',
      updatedAt: Date.now()
    };
    emit('im-session-new', state.imSessions[sessionId]);
    return sessionId;
  }

  // Rebind a conference session from the client's temporary id to the sim's real
  // one (ChatterBoxSessionStartReply), keeping the existing tab and its messages.
  function remapImSession(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return;
    const session = state.imSessions[oldId];
    const partial = {};
    if (session) {
      const target = state.imSessions[newId];
      if (target) {
        // A session under the real id already exists (the roster arrived first),
        // so fold the temp session's messages into it and drop the temp.
        target.messages = (session.messages || []).concat(target.messages || []);
        delete state.imSessions[oldId];
      } else {
        session.id = newId;
        if (session.participant) session.participant.id = newId;
        state.imSessions[newId] = session;
        delete state.imSessions[oldId];
      }
    }
    if (state.activeImSession === oldId) {
      state.activeImSession = newId;
      partial.activeImSession = newId;
    }
    if (Object.keys(partial).length) patch(partial);
    emit('im-sessions-updated');
  }

  function updateSessionRoster(sessionId, participants, moderator) {
    const session = state.imSessions[sessionId];
    if (!session) return false;
    session.participants = Array.isArray(participants) ? participants : [];
    if (moderator !== undefined) session.canModerate = !!moderator;
    emit('im-roster-updated', {
      sessionId: sessionId,
      participants: session.participants,
      moderator: !!session.canModerate
    });
    return true;
  }

  function setSessionTyping(sessionId, typing, fromName) {
    const session = state.imSessions[sessionId];
    if (!session) return false;
    const active = !!typing;
    const name = active ? (fromName || '') : '';
    if (!!session.typing === active && session.typingName === name) return false;
    session.typing = active;
    session.typingName = name;
    emit('im-typing-changed', { sessionId: sessionId, typing: active, fromName: name });
    return true;
  }

  function setSessionMuted(sessionId, muted) {
    const session = state.imSessions[sessionId];
    if (!session) return false;
    const next = muted === undefined ? !session.muted : !!muted;
    if (!!session.muted === next) return next;
    session.muted = next;
    if (next && session.unread) {
      state.unreadIm = Math.max(0, state.unreadIm - session.unread);
      session.unread = 0;
      emit('change', { unreadIm: state.unreadIm });
    }
    emit('im-sessions-updated');
    return next;
  }

  function renameSession(sessionId, title) {
    const session = state.imSessions[sessionId];
    if (!session || !title || isDefaultSessionTitle(title)) return false;
    if (session.title === title) return false;
    session.title = title;
    if (session.participant && session.participant.isSession) {
      session.participant.name = title;
    }
    emit('im-sessions-updated');
    return true;
  }

  function setSessionType(sessionId, type) {
    const session = state.imSessions[sessionId];
    if (!session || !type || session.type === type) return false;
    if (session.type === 'group' && type === 'conference') return false;
    session.type = type;
    emit('im-sessions-updated');
    return true;
  }

  function addImMessage(sessionId, msg, participant, sessionInfo) {
    let resolvedId = sessionId;
    if (!state.imSessions[resolvedId]) {
      if (sessionInfo && sessionInfo.type && sessionInfo.type !== 'p2p') {
        ensureKeyedSession(resolvedId, sessionInfo);
      } else if (participant) {
        const ensured = ensureImSession(participant);
        if (ensured) resolvedId = ensured;
      }
    }
    if (!state.imSessions[resolvedId]) return;
    const session = state.imSessions[resolvedId];
    if (sessionInfo && sessionInfo.type === 'group' && session.type !== 'group') {
      session.type = 'group';
    }
    if (sessionInfo && sessionInfo.title && !isDefaultSessionTitle(sessionInfo.title) &&
        isDefaultSessionTitle(session.title)) {
      session.title = sessionInfo.title;
      if (session.participant && session.participant.isSession) {
        session.participant.name = sessionInfo.title;
      }
    }
    if (msg && msg.id) {
      const dup = session.messages.some(function (m) { return m.id === msg.id; });
      if (dup) return;
    }
    if (msg && !msg.outgoing && session.typing) {
      session.typing = false;
      session.typingName = '';
    }
    if (session.dismissed && msg && !msg.outgoing) {
      session.dismissed = false;
      emit('im-session-reopened', { sessionId: resolvedId });
      emit('im-sessions-updated');
    }
    session.messages.push(msg);
    session.lastMessage = msg.text;
    session.updatedAt = msg.timestamp;
    if (shouldCountImUnread(resolvedId, msg)) {
      session.unread = (session.unread || 0) + 1;
      state.unreadIm += 1;
      emit('change', { unreadIm: state.unreadIm });
    }
    emit('im', { sessionId: resolvedId, message: msg });
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
    const agentId = normAgentId(state.agent && state.agent.id);
    if (!agentId || !participant || !participant.id) return null;

    const sessionId = FSUtils.xorSessionId(agentId, normAgentId(participant.id));
    if (!state.imSessions[sessionId]) {
      state.imSessions[sessionId] = {
        id: sessionId,
        participant: resolveParticipantPresence(participant),
        messages: [],
        unread: 0,
        dismissed: false,
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
      if (state.imSessions[sessionId].dismissed) {
        state.imSessions[sessionId].dismissed = false;
        emit('im-sessions-updated');
      }
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
    dismissImSession: dismissImSession,
    ensureImSession: ensureImSession,
    ensureKeyedSession: ensureKeyedSession,
    remapImSession: remapImSession,
    updateSessionRoster: updateSessionRoster,
    setSessionTyping: setSessionTyping,
    setSessionMuted: setSessionMuted,
    renameSession: renameSession,
    setSessionType: setSessionType,
    refreshImSessionPresence: refreshImSessionPresence,
    resolveParticipantPresence: resolveParticipantPresence,
    get: get,
    gridOnline: gridOnline
  };
})();
