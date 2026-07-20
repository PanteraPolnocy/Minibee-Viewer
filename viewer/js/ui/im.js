/**
 * Instant messaging panel.
 */
const FSIm = (function () {
  'use strict';

  const GROUP_GLYPH = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>';
  const MUTE_GLYPH = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z"/></svg>';
  const MUTE_BELL_GLYPH = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M20 18.69L7.84 6.14 5.27 3.49 4 4.76l2.8 2.8v.01c-.52.99-.8 2.16-.8 3.42v5l-2 2v1h13.73l2 2L21 19.72l-1-1.03zM12 22c1.11 0 2-.89 2-2h-4c0 1.11.89 2 2 2zm6-7.32V11c0-3.08-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68c-.15.03-.29.08-.42.12L18 14.68z"/></svg>';

  let rosterVisible = true;

  const ME_TYPING_RESEND_MS = 4000;
  const ME_TYPING_IDLE_MS = 5000;
  const OTHER_TYPING_TIMEOUT_MS = 12000;
  let meTyping = { sessionId: null, active: false, lastSent: 0, timer: null };
  const incomingTypingTimers = {};
  let conferenceMode = { mode: 'create', sessionId: null };

  function isSessionChat(session) {
    return !!session && (session.type === 'group' || session.type === 'conference');
  }

  function renderSession(session) {
    const row = document.createElement('div');
    row.className = 'im-session';
    row.dataset.sessionId = session.id;
    if (FSState.get().activeImSession === session.id) {
      row.classList.add('im-session--active');
    }

    const p = session.participant;
    const online = p && p.online;
    const sessionChat = isSessionChat(session);
    const memberCount = sessionChat && Array.isArray(session.participants)
      ? session.participants.length : 0;
    const names = FSUtils.agentNameLines(p || {});
    const avatarClass = 'im-session__avatar' + (sessionChat
      ? ' im-session__avatar--session'
      : (online ? ' im-session__avatar--online' : ''));
    const avatarInner = sessionChat
      ? GROUP_GLYPH + (memberCount
        ? '<span class="im-session__count">' + memberCount + '</span>' : '')
      : '';
    const avatarNode = sessionChat
      ? '<div class="' + avatarClass + '">' + avatarInner + '</div>'
      : '<div class="' + avatarClass + '" data-agent-id="' + FSUtils.escapeHtml((p && p.id) || '') +
        '" data-resolve-image="0" data-label="' + FSUtils.escapeHtml(names.title) + '"' +
        (online ? ' data-online="1"' : '') + '></div>';
    const mutedGlyph = session.muted
      ? '<span class="im-session__muted-glyph" title="Notifications muted">' + MUTE_BELL_GLYPH + '</span>'
      : '';
    const typingActive = !sessionChat && session.typing;
    const previewText = typingActive ? 'typing...' : (session.lastMessage || 'No messages yet');
    const previewClass = 'im-session__preview' + (typingActive ? ' im-session__preview--typing' : '');
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'im-session__open';
    openBtn.innerHTML =
      avatarNode +
      '<div class="im-session__body">' +
        '<div class="im-session__top">' +
          '<span class="im-session__name">' + FSUtils.escapeHtml(names.title) + '</span>' +
          mutedGlyph +
          '<span class="im-session__time">' + FSUtils.escapeHtml(FSUtils.formatRelative(session.updatedAt)) + '</span>' +
        '</div>' +
        (names.subtitle
          ? '<div class="im-session__legacy">' + FSUtils.escapeHtml(names.subtitle) + '</div>'
          : '') +
        '<p class="' + previewClass + '">' + FSUtils.escapeHtml(previewText) + '</p>' +
      '</div>' +
      (session.unread ? '<span class="im-session__unread">' + session.unread + '</span>' : '');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'im-session__close icon-btn';
    const closeLabel = sessionChat ? 'Leave session' : 'Close conversation';
    closeBtn.title = closeLabel;
    closeBtn.setAttribute('aria-label', closeLabel);
    closeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

    openBtn.addEventListener('click', function () {
      openSession(session.id);
    });
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeSession(session.id);
    });

    row.appendChild(openBtn);
    row.appendChild(closeBtn);
    if (!sessionChat) {
      const thumb = openBtn.querySelector('[data-agent-id]');
      if (thumb) FSAvatarThumb.refresh(thumb);
    }
    return row;
  }

  function closeSession(sessionId) {
    if (!sessionId) return;
    const session = FSState.get().imSessions[sessionId];
    if (isSessionChat(session) && typeof FSTransport.leaveImSession === 'function') {
      FSTransport.leaveImSession(sessionId);
    }
    const wasActive = FSState.get().activeImSession === sessionId;
    FSState.closeImSession(sessionId);
    if (wasActive) {
      syncImLayout();
      renderSessions();
    } else {
      renderSessions();
    }
  }

  function refreshSessionPresence(session) {
    if (!session || !session.id) return;
    if (typeof FSState.refreshImSessionPresence === 'function') {
      FSState.refreshImSessionPresence(session.id);
    } else if (typeof FSState.resolveParticipantPresence === 'function') {
      session.participant = FSState.resolveParticipantPresence(session.participant);
    }
  }

  function renderSessions() {
    const container = document.getElementById('im-sessions');
    if (!container) return;
    container.innerHTML = '';

    const sessions = Object.values(FSState.get().imSessions);
    sessions.sort(function (a, b) { return b.updatedAt - a.updatedAt; });

    sessions.forEach(function (session) {
      refreshSessionPresence(session);
      container.appendChild(renderSession(session));
    });
  }

  function renderImMessage(msg) {
    const el = document.createElement('div');
    el.className = 'msg ' + (msg.outgoing ? 'msg--outgoing' : 'msg--incoming');
    el.innerHTML =
      '<div class="msg__meta">' +
        '<span class="msg__name">' + FSUtils.escapeHtml(msg.fromName) + '</span>' +
        '<span class="msg__time">' + FSUtils.escapeHtml(FSUtils.formatTime(msg.timestamp)) + '</span>' +
      '</div>' +
      '<p class="msg__body">' + FSSlurl.linkify(msg.text, FSUtils.escapeHtml) + '</p>';
    el.querySelectorAll('.slurl-link').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        FSMap.showLocation(link.dataset.slurl || link.textContent);
      });
    });
    return el;
  }

  function renderThread(sessionId) {
    const list = document.getElementById('im-messages');
    if (!list) return;
    list.innerHTML = '';

    const session = FSState.get().imSessions[sessionId];
    if (!session) return;

    if (typeof FSState.resolveParticipantPresence === 'function') {
      session.participant = FSState.resolveParticipantPresence(session.participant);
    }

    session.messages.forEach(function (msg) {
      list.appendChild(renderImMessage(msg));
    });
    list.scrollTop = list.scrollHeight;

    const p = session.participant;
    const names = FSUtils.agentNameLines(p || {});
    const nameEl = document.getElementById('im-thread-name');
    const statusEl = document.getElementById('im-thread-status');
    if (isSessionChat(session)) {
      const count = Array.isArray(session.participants) ? session.participants.length : 0;
      const typeLabel = session.type === 'group' ? 'Group chat' : 'Conference';
      if (nameEl) nameEl.textContent = session.title || names.title || typeLabel;
      if (statusEl) {
        statusEl.textContent = typeLabel + ' - ' + count +
          (count === 1 ? ' member' : ' members');
      }
      renderRoster(session);
    } else {
      if (nameEl) nameEl.textContent = names.title;
      let status = names.subtitle || '';
      if (p && p.online) {
        const online = p.region ? 'Online - ' + p.region : 'Online';
        status = status ? (status + ' \u00b7 ' + online) : online;
      } else {
        status = status ? (status + ' \u00b7 Offline') : 'Offline';
      }
      if (statusEl) statusEl.textContent = status;
    }
    syncImLayout();
  }

  function renderRoster(session) {
    const list = document.getElementById('im-roster-list');
    const countEl = document.getElementById('im-roster-count');
    if (!list) return;
    const participants = (session && Array.isArray(session.participants))
      ? session.participants : [];
    if (countEl) countEl.textContent = participants.length;
    list.innerHTML = '';
    if (!participants.length) {
      const empty = document.createElement('div');
      empty.className = 'conference-picker__empty';
      empty.textContent = 'No members yet';
      list.appendChild(empty);
      return;
    }
    const selfId = String((FSState.get().agent || {}).id || '').toLowerCase();
    const canModerate = !!(session && session.canModerate);
    const sessionId = session.id;
    participants.slice().sort(function (a, b) {
      if (!!a.isModerator !== !!b.isModerator) return a.isModerator ? -1 : 1;
      return String(a.name || a.id).localeCompare(String(b.name || b.id));
    }).forEach(function (member) {
      const names = FSUtils.agentNameLines(member);
      const label = names.title || member.name || member.id;
      const isSelf = member.id && String(member.id).toLowerCase() === selfId;

      const item = document.createElement('div');
      item.className = 'im-roster__item';
      item.dataset.agentId = member.id;

      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.className = 'im-roster__name-btn' + (isSelf ? ' im-roster__name-btn--static' : '');
      nameBtn.title = isSelf ? label : ('IM ' + label);
      nameBtn.innerHTML =
        '<span class="im-roster__dot' + (member.online ? ' im-roster__dot--online' : '') + '"></span>' +
        '<span class="im-roster__name' + (member.muted ? ' im-roster__name--muted' : '') + '">' +
          FSUtils.escapeHtml(label) + '</span>' +
        (member.isModerator ? '<span class="im-roster__mod">MOD</span>' : '');
      if (!isSelf) {
        nameBtn.addEventListener('click', function () {
          startImWith({ id: member.id, name: label });
        });
      } else {
        nameBtn.disabled = true;
      }
      item.appendChild(nameBtn);

      if (canModerate && !isSelf) {
        const muteBtn = document.createElement('button');
        muteBtn.type = 'button';
        muteBtn.className = 'im-roster__mute' + (member.muted ? ' im-roster__mute--active' : '');
        muteBtn.title = member.muted ? 'Allow text chat' : 'Mute text chat';
        muteBtn.setAttribute('aria-label', muteBtn.title);
        muteBtn.setAttribute('aria-pressed', member.muted ? 'true' : 'false');
        muteBtn.innerHTML = MUTE_GLYPH;
        muteBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          muteBtn.disabled = true;
          Promise.resolve(FSTransport.moderateSessionText(sessionId, member.id, !member.muted))
            .catch(function (err) {
              FSUtils.showToast('Moderation failed: ' +
                (err && err.message ? err.message : err), 'warning');
            })
            .then(function () { muteBtn.disabled = false; });
        });
        item.appendChild(muteBtn);
      }
      list.appendChild(item);
    });
  }

  function renderTyping() {
    const bar = document.getElementById('im-typing');
    const textEl = document.getElementById('im-typing-text');
    if (!bar) return;
    const activeId = FSState.get().activeImSession;
    const session = activeId ? FSState.get().imSessions[activeId] : null;
    const show = !!(session && !isSessionChat(session) && session.typing);
    if (show) {
      const name = session.typingName ||
        (session.participant &&
          (FSUtils.agentNameLines(session.participant).title || session.participant.name)) ||
        'Someone';
      if (textEl) textEl.textContent = name + ' is typing...';
      bar.hidden = false;
    } else {
      bar.hidden = true;
    }
  }

  function activeP2PSessionId() {
    const sid = FSState.get().activeImSession;
    if (!sid) return null;
    const session = FSState.get().imSessions[sid];
    if (!session || isSessionChat(session)) return null;
    return sid;
  }

  function scheduleTypingIdle() {
    if (meTyping.timer) clearTimeout(meTyping.timer);
    meTyping.timer = setTimeout(endTyping, ME_TYPING_IDLE_MS);
  }

  function beginTyping() {
    if (typeof FSTransport.sendTypingState !== 'function') return;
    const sid = activeP2PSessionId();
    if (!sid || !FSState.gridOnline()) return;
    const now = Date.now();
    if (!meTyping.active || meTyping.sessionId !== sid) {
      if (meTyping.active && meTyping.sessionId && meTyping.sessionId !== sid) {
        FSTransport.sendTypingState(meTyping.sessionId, false);
      }
      meTyping.sessionId = sid;
      meTyping.active = true;
      meTyping.lastSent = now;
      FSTransport.sendTypingState(sid, true);
    } else if (now - meTyping.lastSent > ME_TYPING_RESEND_MS) {
      meTyping.lastSent = now;
      FSTransport.sendTypingState(sid, true);
    }
    scheduleTypingIdle();
  }

  function endTyping() {
    if (meTyping.timer) { clearTimeout(meTyping.timer); meTyping.timer = null; }
    if (meTyping.active && meTyping.sessionId &&
        typeof FSTransport.sendTypingState === 'function') {
      FSTransport.sendTypingState(meTyping.sessionId, false);
    }
    meTyping.active = false;
    meTyping.sessionId = null;
  }

  function syncImLayout() {
    const sessionId = FSState.get().activeImSession;
    const layout = document.querySelector('.im-layout');
    const empty = document.getElementById('im-empty');
    const messages = document.getElementById('im-messages');
    const form = document.getElementById('im-form');
    const input = document.getElementById('im-input');
    const tpOffer = document.getElementById('im-tp-offer');
    const tpRequest = document.getElementById('im-tp-request');
    const profileBtn = document.getElementById('im-profile');
    const payBtn = document.getElementById('im-pay');
    const friendBtn = document.getElementById('im-friend');
    const closeBtn = document.getElementById('im-close');
    const hasSession = !!sessionId;
    const session = hasSession ? FSState.get().imSessions[sessionId] : null;
    const sessionChat = isSessionChat(session);
    const p2p = hasSession && !sessionChat;
    const participantId = p2p && session.participant ? session.participant.id : '';
    const participant = p2p && session.participant ? session.participant : null;
    const isFriend = participantId && typeof FSTransport.isBuddy === 'function'
      ? FSTransport.isBuddy(participantId)
      : false;
    const tpOnline = participant && typeof FSTransport.isAgentOnline === 'function'
      ? FSTransport.isAgentOnline(participantId, participant)
      : true;
    const body = document.getElementById('im-thread-body');
    const roster = document.getElementById('im-roster');
    const membersBtn = document.getElementById('im-members');
    const inviteBtn = document.getElementById('im-invite');
    const muteSessionBtn = document.getElementById('im-mute-session');
    const isConference = sessionChat && session && session.type === 'conference';

    if (layout) layout.classList.toggle('im-layout--active', hasSession);
    if (empty) empty.hidden = hasSession;
    if (body) body.hidden = !hasSession;
    if (messages) messages.hidden = !hasSession;
    if (form) form.classList.toggle('composer--disabled', !hasSession);
    if (input) input.disabled = !hasSession;
    if (form) {
      const sendBtn = form.querySelector('[type="submit"]');
      if (sendBtn) sendBtn.disabled = !hasSession;
    }
    [profileBtn, payBtn, friendBtn, tpOffer, tpRequest].forEach(function (btn) {
      if (!btn) return;
      btn.hidden = sessionChat;
      btn.disabled = !p2p;
    });
    if (tpOffer) {
      tpOffer.disabled = !p2p || !tpOnline;
      tpOffer.title = !p2p ? 'Offer teleport' : (tpOnline ? 'Offer teleport' : 'Resident is offline');
    }
    if (tpRequest) {
      tpRequest.disabled = !p2p || !tpOnline;
      tpRequest.title = !p2p ? 'Request teleport' : (tpOnline ? 'Request teleport' : 'Resident is offline');
    }
    if (profileBtn) {
      profileBtn.disabled = !p2p;
      profileBtn.title = 'Profile';
      profileBtn.removeAttribute('aria-disabled');
    }
    if (friendBtn) {
      friendBtn.disabled = !p2p || isFriend;
      friendBtn.title = isFriend ? 'Already friends' : 'Offer friendship';
    }
    if (membersBtn) membersBtn.hidden = !sessionChat;
    if (inviteBtn) {
      inviteBtn.hidden = !isConference;
      inviteBtn.disabled = !isConference;
    }
    if (muteSessionBtn) {
      muteSessionBtn.hidden = !sessionChat;
      const muted = !!(session && session.muted);
      muteSessionBtn.classList.toggle('im-action-btn--active', muted);
      muteSessionBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
      muteSessionBtn.title = muted ? 'Unmute notifications' : 'Mute notifications';
    }
    if (roster) roster.hidden = !(sessionChat && rosterVisible);
    if (closeBtn) {
      closeBtn.disabled = !hasSession;
      closeBtn.title = sessionChat ? 'Leave session' : 'Close conversation';
      closeBtn.setAttribute('aria-label', sessionChat ? 'Leave session' : 'Close conversation');
    }

    if (!hasSession) {
      document.getElementById('im-thread-name').textContent = 'Conversation';
      document.getElementById('im-thread-status').textContent = '';
      if (messages) messages.innerHTML = '';
    }
    renderTyping();
  }

  function getActiveParticipant() {
    const sessionId = FSState.get().activeImSession;
    if (!sessionId) return null;
    const session = FSState.get().imSessions[sessionId];
    return session && session.participant ? session.participant : null;
  }

  function openPayDialog(participant) {
    const dialog = document.getElementById('pay-dialog');
    const nameEl = document.getElementById('pay-target-name');
    const amountEl = document.getElementById('pay-amount');
    const noteEl = document.getElementById('pay-note');
    if (!dialog || !participant) return;
    const names = FSUtils.agentNameLines(participant);
    if (nameEl) nameEl.textContent = 'Pay ' + (names.title || participant.name || 'resident');
    if (amountEl) amountEl.value = '';
    if (noteEl) noteEl.value = '';
    dialog.dataset.targetId = participant.id || '';
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
  }

  function openSession(sessionId) {
    const session = FSState.get().imSessions[sessionId];
    if (!session) return;

    refreshSessionPresence(session);

    const prevUnread = session.unread || 0;
    session.unread = 0;
    FSState.patch({
      activeImSession: sessionId,
      unreadIm: Math.max(0, FSState.get().unreadIm - prevUnread)
    });

    syncImLayout();
    renderSessions();
    renderThread(sessionId);
    FSNavigation.switchTab('im');
  }

  function startImWith(participant) {
    const sessionId = FSState.ensureImSession(participant);
    if (sessionId) openSession(sessionId);
  }

  function openGroupChat(groupId, groupName) {
    if (!groupId) return;
    if (!FSState.gridOnline()) {
      FSUtils.showToast('Connect to the grid to open group chat.', 'warning');
      return;
    }
    FSState.ensureKeyedSession(groupId, { type: 'group', title: groupName || '' });
    if (typeof FSTransport.openGroupChat === 'function') {
      FSTransport.openGroupChat(groupId, groupName || '');
    }
    openSession(groupId);
  }

  function openConferenceDialog(preselectIds, options) {
    const dialog = document.getElementById('conference-dialog');
    const picker = document.getElementById('conference-picker');
    const titleEl = document.getElementById('conference-title');
    const titleField = document.getElementById('conference-title-field');
    const heading = document.getElementById('conference-dialog-title');
    const submit = document.getElementById('conference-submit');
    if (!dialog || !picker) return;
    if (!FSState.gridOnline()) {
      FSUtils.showToast('Connect to the grid to start a conference.', 'warning');
      return;
    }
    const opts = options || {};
    const mode = opts.mode === 'invite' ? 'invite' : 'create';
    conferenceMode = { mode: mode, sessionId: opts.sessionId || null };
    if (heading) heading.textContent = mode === 'invite' ? 'Invite to conference' : 'New conference chat';
    if (submit) submit.textContent = mode === 'invite' ? 'Invite' : 'Start';
    if (titleField) titleField.hidden = mode === 'invite';

    const exclude = {};
    (opts.excludeIds || []).forEach(function (id) {
      exclude[String(id).toLowerCase()] = true;
    });
    const preselect = {};
    (preselectIds || []).forEach(function (id) {
      preselect[String(id).toLowerCase()] = true;
    });
    if (titleEl) titleEl.value = '';
    picker.innerHTML = '';
    const buddies = (FSState.get().buddies || []).slice().filter(function (b) {
      return !exclude[String(b.id).toLowerCase()];
    }).sort(function (a, b) {
      const an = FSUtils.agentNameLines(a).title || a.name || '';
      const bn = FSUtils.agentNameLines(b).title || b.name || '';
      return an.localeCompare(bn);
    });
    if (!buddies.length) {
      const empty = document.createElement('div');
      empty.className = 'conference-picker__empty';
      empty.textContent = 'No contacts available. Add friends first.';
      picker.appendChild(empty);
    } else {
      buddies.forEach(function (buddy) {
        const label = FSUtils.agentNameLines(buddy).title || buddy.name || buddy.id;
        const row = document.createElement('label');
        row.className = 'conference-picker__row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = buddy.id;
        if (preselect[String(buddy.id).toLowerCase()]) cb.checked = true;
        const span = document.createElement('span');
        span.textContent = label;
        row.appendChild(cb);
        row.appendChild(span);
        picker.appendChild(row);
      });
    }
    if (typeof dialog.showModal === 'function') dialog.showModal();
  }

  function handleSubmit(e) {
    e.preventDefault();
    const sessionId = FSState.get().activeImSession;
    const input = document.getElementById('im-input');
    const text = input.value.trim();
    if (!sessionId || !text || !FSState.gridOnline()) return;

    FSTransport.sendIm(sessionId, text);
    input.value = '';
    endTyping();
  }

  function activate() {
    renderSessions();
    const active = FSState.get().activeImSession;
    syncImLayout();
    if (active) renderThread(active);
  }

  function init() {
    document.getElementById('im-form').addEventListener('submit', handleSubmit);
    document.getElementById('im-back').addEventListener('click', function () {
      FSState.patch({ activeImSession: null });
      syncImLayout();
      renderSessions();
    });
    const closeBtn = document.getElementById('im-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        const sessionId = FSState.get().activeImSession;
        if (sessionId) closeSession(sessionId);
      });
    }
    const membersBtn = document.getElementById('im-members');
    if (membersBtn) {
      membersBtn.addEventListener('click', function () {
        rosterVisible = !rosterVisible;
        membersBtn.title = rosterVisible ? 'Hide members' : 'Show members';
        syncImLayout();
      });
    }
    const inviteBtn = document.getElementById('im-invite');
    if (inviteBtn) {
      inviteBtn.addEventListener('click', function () {
        const sid = FSState.get().activeImSession;
        const session = sid ? FSState.get().imSessions[sid] : null;
        if (!session || session.type !== 'conference') return;
        const existing = (session.participants || []).map(function (p) { return p.id; });
        openConferenceDialog([], { mode: 'invite', sessionId: sid, excludeIds: existing });
      });
    }
    const muteSessionBtn = document.getElementById('im-mute-session');
    if (muteSessionBtn) {
      muteSessionBtn.addEventListener('click', function () {
        const sid = FSState.get().activeImSession;
        if (!sid) return;
        const muted = FSState.setSessionMuted(sid);
        FSUtils.showToast(muted ? 'Notifications muted for this session.'
          : 'Notifications unmuted.', 'success', 2500);
        syncImLayout();
        renderSessions();
      });
    }
    const imInput = document.getElementById('im-input');
    if (imInput) {
      imInput.addEventListener('input', function () {
        if (imInput.value.trim()) beginTyping();
        else endTyping();
      });
      imInput.addEventListener('blur', endTyping);
    }
    const newConfBtn = document.getElementById('im-new-conference');
    if (newConfBtn) {
      newConfBtn.addEventListener('click', function () { openConferenceDialog(); });
    }
    const conferenceDialog = document.getElementById('conference-dialog');
    const conferenceForm = document.getElementById('conference-form');
    const conferenceCancel = document.getElementById('conference-cancel');
    if (conferenceCancel && conferenceDialog) {
      conferenceCancel.addEventListener('click', function () {
        conferenceDialog.close();
      });
    }
    if (conferenceForm && conferenceDialog) {
      conferenceForm.addEventListener('submit', function (e) {
        e.preventDefault();
        const picker = document.getElementById('conference-picker');
        const titleEl = document.getElementById('conference-title');
        const ids = Array.prototype.slice
          .call(picker.querySelectorAll('input[type="checkbox"]:checked'))
          .map(function (cb) { return cb.value; });
        if (!ids.length) {
          FSUtils.showToast('Select at least one participant.', 'warning');
          return;
        }
        conferenceDialog.close();
        if (conferenceMode.mode === 'invite' && conferenceMode.sessionId) {
          Promise.resolve(FSTransport.inviteToSession(conferenceMode.sessionId, ids))
            .then(function (count) {
              FSUtils.showToast('Invited ' + count +
                (count === 1 ? ' person.' : ' people.'), 'success');
            }).catch(function (err) {
              FSUtils.showToast('Could not invite: ' +
                (err && err.message ? err.message : err), 'warning');
            });
          return;
        }
        const title = titleEl ? titleEl.value.trim() : '';
        Promise.resolve(FSTransport.startConference(ids, title)).then(function (tempId) {
          if (tempId) openSession(tempId);
        }).catch(function (err) {
          FSUtils.showToast('Could not start conference: ' +
            (err && err.message ? err.message : err), 'warning');
        });
      });
    }
    document.querySelectorAll('.im-tab-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const tab = btn.getAttribute('data-tab-link');
        if (tab) FSNavigation.switchTab(tab);
      });
    });
    document.getElementById('im-profile').addEventListener('click', function () {
      const participant = getActiveParticipant();
      if (!participant || !participant.id) return;
      FSProfile.openAvatar(participant.id, { agent: participant });
    });
    document.getElementById('im-tp-offer').addEventListener('click', function () {
      const session = FSState.get().imSessions[FSState.get().activeImSession];
      if (!session || !session.participant) return;
      FSTeleportUI.offerTo(session.participant.id, session.participant.name, session.participant);
    });
    document.getElementById('im-tp-request').addEventListener('click', function () {
      const session = FSState.get().imSessions[FSState.get().activeImSession];
      if (!session || !session.participant) return;
      FSTeleportUI.requestFrom(session.participant.id, session.participant.name, session.participant);
    });
    document.getElementById('im-pay').addEventListener('click', function () {
      const participant = getActiveParticipant();
      if (!participant) return;
      openPayDialog(participant);
    });
    document.getElementById('im-friend').addEventListener('click', function () {
      const participant = getActiveParticipant();
      if (!participant || !participant.id) return;
      FSTransport.offerFriendship(participant.id).then(function (result) {
        if (result && result.alreadyFriend) {
          FSUtils.showToast('Already friends.', 'warning');
          syncImLayout();
          return;
        }
        if (result && result.sent) {
          FSUtils.showToast('Friendship offer sent.', 'success');
        } else {
          FSUtils.showToast('Could not send friendship offer.', 'warning');
        }
      });
    });
    const payForm = document.getElementById('pay-form');
    const payDialog = document.getElementById('pay-dialog');
    const payCancel = document.getElementById('pay-cancel');
    if (payCancel && payDialog) {
      payCancel.addEventListener('click', function () {
        payDialog.close();
      });
    }
    if (payForm && payDialog) {
      payForm.addEventListener('submit', function (e) {
        e.preventDefault();
        const targetId = payDialog.dataset.targetId;
        const amount = parseInt(document.getElementById('pay-amount').value, 10);
        const note = document.getElementById('pay-note').value.trim();
        if (!targetId || !amount || amount < 1) return;
        FSTransport.payResident(targetId, amount, note).then(function (result) {
          if (result && result.sent) {
            FSUtils.showToast('Payment sent.', 'success');
            payDialog.close();
          } else {
            FSUtils.showToast('Payment failed.', 'warning');
          }
        }).catch(function (err) {
          FSUtils.showToast('Payment failed: ' + (err.message || err), 'warning');
        });
      });
    }

    FSState.on('im-session-new', function () {
      if (FSNavigation.isTabActive('im')) renderSessions();
    });
    FSState.on('im-sessions-updated', function () {
      if (!FSNavigation.isTabActive('im')) return;
      renderSessions();
      const active = FSState.get().activeImSession;
      if (active) renderThread(active);
    });
    FSState.on('im', function (data) {
      if (!FSNavigation.isTabActive('im')) return;
      renderSessions();
      if (FSState.get().activeImSession === data.sessionId) {
        renderThread(data.sessionId);
      }
    });
    FSState.on('im-roster-updated', function (data) {
      if (!FSNavigation.isTabActive('im')) return;
      renderSessions();
      const active = FSState.get().activeImSession;
      if (active && data && active === data.sessionId) {
        const session = FSState.get().imSessions[active];
        if (session) renderRoster(session);
        renderThread(active);
      }
    });
    FSState.on('im-session-migrated', function (data) {
      if (!data) return;
      if (FSState.get().activeImSession === data.sessionId) {
        openSession(data.sessionId);
      } else if (FSNavigation.isTabActive('im')) {
        renderSessions();
      }
    });
    FSState.on('im-typing-changed', function (data) {
      if (!data || !data.sessionId) return;
      if (incomingTypingTimers[data.sessionId]) {
        clearTimeout(incomingTypingTimers[data.sessionId]);
        delete incomingTypingTimers[data.sessionId];
      }
      if (data.typing) {
        incomingTypingTimers[data.sessionId] = setTimeout(function () {
          delete incomingTypingTimers[data.sessionId];
          FSState.setSessionTyping(data.sessionId, false);
        }, OTHER_TYPING_TIMEOUT_MS);
      }
      if (!FSNavigation.isTabActive('im')) return;
      renderSessions();
      if (FSState.get().activeImSession === data.sessionId) renderTyping();
    });

    FSTransport.on('buddies-updated', function () {
      if (!FSNavigation.isTabActive('im')) return;
      syncImLayout();
      const active = FSState.get().activeImSession;
      if (active) renderThread(active);
      renderSessions();
    });

    FSState.on('im-session-closed', function () {
      if (FSNavigation.isTabActive('im')) {
        syncImLayout();
        renderSessions();
      }
    });

    FSState.on('reset', function () {
      Object.keys(incomingTypingTimers).forEach(function (sid) {
        clearTimeout(incomingTypingTimers[sid]);
        delete incomingTypingTimers[sid];
      });
      if (meTyping.timer) clearTimeout(meTyping.timer);
      meTyping = { sessionId: null, active: false, lastSent: 0, timer: null };
      document.getElementById('im-sessions').innerHTML = '';
      document.getElementById('im-messages').innerHTML = '';
      const typingBar = document.getElementById('im-typing');
      if (typingBar) typingBar.hidden = true;
      syncImLayout();
    });

    syncImLayout();
  }

  return {
    init: init,
    openSession: openSession,
    startImWith: startImWith,
    openGroupChat: openGroupChat,
    openConferenceDialog: openConferenceDialog,
    activate: activate,
    closeSession: closeSession
  };
})();
