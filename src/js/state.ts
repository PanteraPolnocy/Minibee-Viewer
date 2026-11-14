/**
 * The single source of truth for app state, with a small pub/sub layer on top.
 */
const BeeState = (function () {
  'use strict';

  const t = BeeI18n.t;

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
    // Unread IM lines in every conversation, and the share of them that sits
    // in group chats and conferences: the menu shows the two apart, people
    // loudly and groups quietly (see syncImUnread).
    unreadIm: 0,
    unreadImGroups: 0,
    unreadChat: 0,
    unreadEvents: 0,
    unreadRadar: 0,
    landUpdated: false,
    activeTab: 'chat',
    radarRange: 96,
    radarAlerts: true,
    sessionLost: false,
    sessionLostReason: '',
    sessionLostDismissed: false,
    // Which edition this is, as the core reports it at startup
    // (app_distribution): the Google Play build has no L$ purchase, and
    // every Buy L$ entry point checks canBuyCurrency and shows buyNotice
    // in its place.
    playStore: false,
    canBuyCurrency: true,
    buyNotice: ''
  };

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return function () { listeners.get(event).delete(fn); };
  }

  function emit(event: string, payload?: any) {
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
    state.unreadImGroups = 0;
    state.unreadChat = 0;
    state.unreadEvents = 0;
    state.unreadRadar = 0;
    state.landUpdated = false;
    state.lindenBalance = null;
    state.sessionLost = false;
    state.sessionLostReason = '';
    state.sessionLostDismissed = false;
    // The login is over: the conferences left during it are forgotten, and
    // the next account reads its own lists.
    closedThisLogin.clear();
    standing = null;
    lastRefused = null;
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
        msg.kind === 'interactive-prompt' || msg.kind === 'payment' || msg.kind === 'motd' ||
        msg.kind === 'group-notice') {
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

  // Transcripts keep the newest MAX_TRANSCRIPT entries. Without a cap, hours in
  // a busy region grow the arrays (and their rendered DOM) without bound.
  const MAX_TRANSCRIPT = 1000;
  function trimTranscript(list) {
    if (list.length > MAX_TRANSCRIPT) list.splice(0, list.length - MAX_TRANSCRIPT);
  }

  function addEventMessage(msg) {
    state.eventMessages.push(msg);
    trimTranscript(state.eventMessages);
    if (state.activeTab !== 'events' && isEventUnread(msg)) {
      state.unreadEvents += 1;
    }
    emit('event', msg);
  }

  // A group chat or a conference, as opposed to a private thread (which has
  // no type, see ensureImSession).
  function isSessionChat(session) {
    return !!session && (session.type === 'group' || session.type === 'conference');
  }

  // The IM badges are sums of what the conversation rows show - derived from
  // them, never kept as running tallies of their own. A tally drifts as soon
  // as any path zeroes or drops a conversation's count without adjusting it
  // too, and then no amount of closing brings the badge down. There are two
  // sums: every row (unreadIm, which the phone notification also reports),
  // and the group chats and conferences among them (unreadImGroups) - people
  // are the difference. syncImUnread folds what changed into a pending
  // 'change' partial; recountImUnread emits it.
  function imUnreadCounts() {
    let total = 0;
    let groups = 0;
    Object.keys(state.imSessions).forEach(function (id) {
      const session = state.imSessions[id];
      const n = session.unread || 0;
      total += n;
      if (isSessionChat(session)) groups += n;
    });
    return { total: total, groups: groups };
  }

  function syncImUnread(partial) {
    const counts = imUnreadCounts();
    if (counts.total !== state.unreadIm) {
      state.unreadIm = counts.total;
      partial.unreadIm = counts.total;
    }
    if (counts.groups !== state.unreadImGroups) {
      state.unreadImGroups = counts.groups;
      partial.unreadImGroups = counts.groups;
    }
    return partial;
  }

  // --- group chats that were turned away ---
  //
  // A group whose chat the user closed, or muted, is refused: its chat opens
  // no tab by itself and counts nowhere. It comes back when the user opens it
  // from the group; a muted one then keeps its mute until it is unmuted, and
  // a muted chat that is open stays open, quietly. Both lists belong to the
  // account and live in the settings file. A conference has no group to open
  // it from and its id means nothing after logout, so the conferences left
  // are only remembered until then.
  //
  // The core does the refusing (it never joins such a session, see
  // SessionState::closed_chats); what it must refuse is refusedChats(), and
  // 'im-refused-chats' says when that list changed.
  const CHAT_STANDING_KEY = 'minibee-group-chats';
  const closedThisLogin = new Set<string>();
  let standing: { agent: string; closed: Set<string>; muted: Set<string> } | null = null;
  let lastRefused: string | null = null;

  // The account's lists, read once per login. `agentId` names the account
  // while the login is still on its way (the session is started before
  // state.agent is set).
  function chatStanding(agentId?) {
    const agent = normAgentId(agentId || (state.agent && state.agent.id));
    if (standing && standing.agent === agent) return standing;
    const stored = BeeUtils.storageGet(CHAT_STANDING_KEY, null);
    const mine = (agent && stored && typeof stored === 'object' && stored[agent]) || {};
    const ids = function (list) {
      return new Set<string>((Array.isArray(list) ? list : []).map(normAgentId).filter(looksLikeUuid));
    };
    standing = { agent: agent, closed: ids(mine.closed), muted: ids(mine.muted) };
    return standing;
  }

  function saveChatStanding() {
    const s = chatStanding();
    if (!s.agent) return;
    const stored = BeeUtils.storageGet(CHAT_STANDING_KEY, null);
    const all = stored && typeof stored === 'object' && !Array.isArray(stored)
      ? Object.assign({}, stored) : {};
    if (s.closed.size || s.muted.size) {
      all[s.agent] = { closed: Array.from(s.closed).sort(), muted: Array.from(s.muted).sort() };
    } else {
      delete all[s.agent];
    }
    BeeUtils.storageSet(CHAT_STANDING_KEY, all);
  }

  // Rows are keyed by the id as it arrived; the lists hold it lowercased.
  function hasChatRow(id) {
    if (state.imSessions[id]) return true;
    return Object.keys(state.imSessions).some(function (key) {
      return key.toLowerCase() === id;
    });
  }

  function isGroupMuted(groupId) {
    return chatStanding().muted.has(normAgentId(groupId));
  }

  // Whether this chat must not open by itself: it was closed, or it is a
  // muted group's with no tab open.
  function isChatRefused(sessionId) {
    const id = normAgentId(sessionId);
    if (!id) return false;
    if (closedThisLogin.has(id)) return true;
    const s = chatStanding();
    return s.closed.has(id) || (s.muted.has(id) && !hasChatRow(id));
  }

  // Every chat the core has to refuse, for the account logged in (or, with
  // `agentId`, the one logging in).
  function refusedChats(agentId?) {
    const s = chatStanding(agentId);
    const out = new Set<string>(closedThisLogin);
    s.closed.forEach(function (id) { out.add(id); });
    s.muted.forEach(function (id) { if (!hasChatRow(id)) out.add(id); });
    return Array.from(out).sort();
  }

  // Called wherever the list can have changed: a chat closed or opened, a
  // mute toggled, a tab that came or went.
  function syncRefusedChats() {
    if (!state.agent) return;
    const ids = refusedChats();
    const key = ids.join(',');
    if (key === lastRefused) return;
    lastRefused = key;
    emit('im-refused-chats', ids);
  }

  // The user closed this group chat or left this conference, and it is to
  // stay that way. Only the user's own doing counts: a tab that goes for
  // another reason (the grid closed the session, a call's throwaway
  // conference was tidied up) refuses nothing.
  function refuseChat(sessionId) {
    const id = normAgentId(sessionId);
    if (!looksLikeUuid(id)) return false;
    const session = state.imSessions[sessionId];
    if (session && session.type === 'group') {
      const s = chatStanding();
      if (!s.closed.has(id)) {
        s.closed.add(id);
        saveChatStanding();
      }
    } else {
      closedThisLogin.add(id);
    }
    syncRefusedChats();
    return true;
  }

  // The user asked for this chat again (from the group): it is no longer
  // closed. A mute is not touched - that is undone on the chat itself.
  function welcomeChat(sessionId) {
    const id = normAgentId(sessionId);
    if (!id) return false;
    let changed = closedThisLogin.delete(id);
    const s = chatStanding();
    if (s.closed.delete(id)) {
      saveChatStanding();
      changed = true;
    }
    syncRefusedChats();
    return changed;
  }

  function rememberGroupMute(groupId, muted) {
    const id = normAgentId(groupId);
    if (!looksLikeUuid(id)) return;
    const s = chatStanding();
    if (s.muted.has(id) === !!muted) return;
    if (muted) s.muted.add(id);
    else s.muted.delete(id);
    saveChatStanding();
  }

  // A chat that is, or has just turned out to be, a group's: it takes the
  // mute the group carries, or hands over the one it was given while it
  // still passed for a conference.
  function adoptGroupMute(session) {
    if (!session || session.type !== 'group') return;
    if (isGroupMuted(session.id)) {
      session.muted = true;
      session.unread = 0;
    } else if (session.muted) {
      rememberGroupMute(session.id, true);
    }
  }

  function recountImUnread() {
    const partial = syncImUnread({});
    if (Object.keys(partial).length) emit('change', partial);
    return state.unreadIm;
  }

  // The conversation is on screen: its count is spent.
  function markImSessionRead(sessionId) {
    const session = state.imSessions[sessionId];
    if (!session || !session.unread) return false;
    session.unread = 0;
    recountImUnread();
    return true;
  }

  type ImPartial = { activeImSession?: string | null; unreadIm?: number; unreadImGroups?: number };

  function closeImSession(sessionId) {
    const session = state.imSessions[sessionId];
    if (!session) return false;
    delete state.imSessions[sessionId];
    const partial: ImPartial = {};
    if (state.activeImSession === sessionId) {
      partial.activeImSession = null;
      state.activeImSession = null;
    }
    syncImUnread(partial);
    emit('im-session-closed', sessionId);
    if (Object.keys(partial).length) {
      emit('change', partial);
    }
    // A muted group whose tab is gone is refused from here on.
    syncRefusedChats();
    return true;
  }

  function dismissImSession(sessionId) {
    const session = state.imSessions[sessionId];
    if (!session) return false;
    if (session.type === 'group' || session.type === 'conference') {
      return closeImSession(sessionId);
    }
    if (session.dismissed) return false;
    session.dismissed = true;
    session.unread = 0;
    if (session.typing) {
      session.typing = false;
      session.typingName = '';
    }
    const partial: ImPartial = {};
    if (state.activeImSession === sessionId) {
      partial.activeImSession = null;
      state.activeImSession = null;
    }
    syncImUnread(partial);
    emit('im-session-dismissed', sessionId);
    emit('im-sessions-updated');
    if (Object.keys(partial).length) {
      emit('change', partial);
    }
    return true;
  }

  // Unread means "not on screen": the open thread only absorbs a message while
  // the IM tab is actually showing it. From any other tab it counts like the
  // rest, and BeeIm.activate spends the count the moment the tab comes back.
  function shouldCountImUnread(sessionId, msg) {
    if (!isImUnread(msg)) return false;
    const session = state.imSessions[sessionId];
    if (!session || session.muted) return false;
    if (state.activeTab === 'im' && state.activeImSession === sessionId) return false;
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
    trimTranscript(state.chatMessages);
    if (state.activeTab !== 'chat' && isChatUnread(msg)) {
      state.unreadChat += 1;
    }
    emit('chat', msg);
  }

  // The stub title a session chat carries until the grid names it (the core
  // sends none): the one in the UI language. The English one stays
  // recognised as well, so a title given before a switch from English still
  // counts as a placeholder.
  function defaultSessionTitle(type) {
    return type === 'conference'
      ? t('im.conference')
      : t('im.groupChat');
  }

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
    return !text ||
      text === defaultSessionTitle('group') || text === defaultSessionTitle('conference') ||
      text === BeeI18n.en('im.groupChat') || text === BeeI18n.en('im.conference') ||
      looksLikeUuid(text) || looksLikeBase64Bucket(text);
  }

  // Open the tab of a group chat or a conference. Whether the chat may open
  // at all is the caller's question (isChatRefused): the user's own request
  // welcomes it first, the grid's messages are checked on their way in.
  function ensureKeyedSession(sessionId, info) {
    if (!sessionId || state.imSessions[sessionId]) return sessionId;
    const type = (info && info.type) || 'group';
    const title = (info && info.title) || defaultSessionTitle(type);
    const session: any = {
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
    state.imSessions[sessionId] = session;
    // A muted group's chat opens muted, whenever and however it opens.
    adoptGroupMute(session);
    emit('im-session-new', session);
    // With its tab open, a muted group is no longer turned away.
    syncRefusedChats();
    return sessionId;
  }

  // Rebind a conference session from the client's temporary id to the sim's real
  // one (ChatterBoxSessionStartReply), keeping the existing tab and its messages.
  function remapImSession(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return;
    const session = state.imSessions[oldId];
    const partial: ImPartial = {};
    if (session) {
      const target = state.imSessions[newId];
      if (target) {
        // A session under the real id already exists (the roster arrived first),
        // so fold the temp session's messages (and their unread) into it and
        // drop the temp.
        target.messages = (session.messages || []).concat(target.messages || []);
        target.unread = (target.unread || 0) + (session.unread || 0);
        target.historyLoaded = !!(target.historyLoaded || session.historyLoaded);
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
    syncImUnread(partial);
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

  function setSessionTyping(sessionId, typing, fromName?) {
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

  // Mute or unmute a chat (toggle when `muted` is left out). A group's mute
  // is the group's own: it is remembered for the account and outlives both
  // the tab and the login. A conference's lasts as long as its tab.
  function setSessionMuted(sessionId, muted?) {
    const session = state.imSessions[sessionId];
    if (!session) return false;
    const next = muted === undefined ? !session.muted : !!muted;
    if (!!session.muted === next) return next;
    session.muted = next;
    if (session.type === 'group') rememberGroupMute(sessionId, next);
    if (next && session.unread) {
      session.unread = 0;
      recountImUnread();
    }
    emit('im-sessions-updated');
    syncRefusedChats();
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

  // A private thread has no type (see ensureImSession) and never becomes a
  // session chat; only conference -> group, once a session id turns out to be
  // a joined group, is a legitimate change.
  function isPrivateSession(session) {
    return !!session && (!session.type || session.type === 'p2p');
  }

  function setSessionType(sessionId, type) {
    const session = state.imSessions[sessionId];
    if (!session || !type || session.type === type) return false;
    if (isPrivateSession(session)) return false;
    if (type !== 'group' && type !== 'conference') return false;
    if (session.type === 'group' && type === 'conference') return false;
    session.type = type;
    retypedAsGroup(session);
    emit('im-sessions-updated');
    return true;
  }

  // A chat that passed for a conference turned out to be a group's: the
  // group's mute applies to it from here on, and the counts follow.
  function retypedAsGroup(session) {
    if (session.type !== 'group') return;
    adoptGroupMute(session);
    recountImUnread();
    syncRefusedChats();
  }

  function addImMessage(sessionId, msg, participant, sessionInfo) {
    let resolvedId = sessionId;
    if (!state.imSessions[resolvedId]) {
      if (sessionInfo && sessionInfo.type && sessionInfo.type !== 'p2p') {
        // A chat that was turned away opens for the user alone. The core
        // refuses it at the door; this is for the line that was already on
        // its way in when the chat was closed.
        if (isChatRefused(resolvedId)) return;
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
      retypedAsGroup(session);
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
    trimTranscript(session.messages);
    session.lastMessage = msg.text;
    session.updatedAt = msg.timestamp;
    if (shouldCountImUnread(resolvedId, msg)) {
      session.unread = (session.unread || 0) + 1;
      recountImUnread();
    }
    emit('im', { sessionId: resolvedId, message: msg });
  }

  // Lines read back from the on-disk log slide in above the live transcript
  // when a conversation opens. Once per session: the flag stops a remap or a
  // slow second read from doubling them. History never touches unread counts,
  // previews or timestamps - it is context, not news.
  function addImHistory(sessionId, msgs) {
    const session = state.imSessions[sessionId];
    if (!session || session.historyLoaded) return false;
    session.historyLoaded = true;
    if (!Array.isArray(msgs) || !msgs.length) return false;
    session.messages = msgs.concat(session.messages);
    trimTranscript(session.messages);
    emit('im-history', { sessionId: sessionId });
    return true;
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

    const sessionId = BeeUtils.xorSessionId(agentId, normAgentId(participant.id));
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
    addImHistory: addImHistory,
    closeImSession: closeImSession,
    dismissImSession: dismissImSession,
    markImSessionRead: markImSessionRead,
    recountImUnread: recountImUnread,
    ensureImSession: ensureImSession,
    ensureKeyedSession: ensureKeyedSession,
    remapImSession: remapImSession,
    updateSessionRoster: updateSessionRoster,
    setSessionTyping: setSessionTyping,
    setSessionMuted: setSessionMuted,
    refuseChat: refuseChat,
    welcomeChat: welcomeChat,
    isChatRefused: isChatRefused,
    refusedChats: refusedChats,
    renameSession: renameSession,
    setSessionType: setSessionType,
    isDefaultSessionTitle: isDefaultSessionTitle,
    refreshImSessionPresence: refreshImSessionPresence,
    resolveParticipantPresence: resolveParticipantPresence,
    get: get,
    gridOnline: gridOnline
  };
})();
