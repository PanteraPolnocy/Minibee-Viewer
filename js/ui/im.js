/**
 * Instant messaging panel.
 */
const FSIm = (function () {
  'use strict';

  function renderSession(session) {
    const row = document.createElement('div');
    row.className = 'im-session';
    row.dataset.sessionId = session.id;
    if (FSState.get().activeImSession === session.id) {
      row.classList.add('im-session--active');
    }

    const p = session.participant;
    const online = p && p.online;
    const names = FSUtils.agentNameLines(p || {});
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'im-session__open';
    openBtn.innerHTML =
      '<div class="im-session__avatar' + (online ? ' im-session__avatar--online' : '') + '">' +
        FSUtils.escapeHtml(FSUtils.initials(names.title)) +
      '</div>' +
      '<div class="im-session__body">' +
        '<div class="im-session__top">' +
          '<span class="im-session__name">' + FSUtils.escapeHtml(names.title) + '</span>' +
          '<span class="im-session__time">' + FSUtils.escapeHtml(FSUtils.formatRelative(session.updatedAt)) + '</span>' +
        '</div>' +
        (names.subtitle
          ? '<div class="im-session__legacy">' + FSUtils.escapeHtml(names.subtitle) + '</div>'
          : '') +
        '<p class="im-session__preview">' + FSUtils.escapeHtml(session.lastMessage || 'No messages yet') + '</p>' +
      '</div>' +
      (session.unread ? '<span class="im-session__unread">' + session.unread + '</span>' : '');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'im-session__close icon-btn';
    closeBtn.title = 'Close conversation';
    closeBtn.setAttribute('aria-label', 'Close conversation');
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
    return row;
  }

  function closeSession(sessionId) {
    if (!sessionId) return;
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
    document.getElementById('im-thread-name').textContent = names.title;
    let status = names.subtitle || '';
    if (p && p.online) {
      const online = p.region ? 'Online - ' + p.region : 'Online';
      status = status ? (status + ' · ' + online) : online;
    } else {
      status = status ? (status + ' · Offline') : 'Offline';
    }
    document.getElementById('im-thread-status').textContent = status;
    syncImLayout();
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
    const participantId = session && session.participant ? session.participant.id : '';
    const isFriend = participantId && typeof FSTransport.isBuddy === 'function'
      ? FSTransport.isBuddy(participantId)
      : false;

    if (layout) layout.classList.toggle('im-layout--active', hasSession);
    if (empty) empty.hidden = hasSession;
    if (messages) messages.hidden = !hasSession;
    if (form) form.classList.toggle('composer--disabled', !hasSession);
    if (input) input.disabled = !hasSession;
    if (form) {
      const sendBtn = form.querySelector('[type="submit"]');
      if (sendBtn) sendBtn.disabled = !hasSession;
    }
    if (tpOffer) tpOffer.disabled = !hasSession;
    if (tpRequest) tpRequest.disabled = !hasSession;
    if (profileBtn) profileBtn.disabled = !hasSession;
    if (payBtn) payBtn.disabled = !hasSession;
    if (friendBtn) {
      friendBtn.disabled = !hasSession || isFriend;
      friendBtn.title = isFriend ? 'Already friends' : 'Offer friendship';
    }
    if (closeBtn) closeBtn.disabled = !hasSession;

    if (!hasSession) {
      document.getElementById('im-thread-name').textContent = 'Conversation';
      document.getElementById('im-thread-status').textContent = '';
      if (messages) messages.innerHTML = '';
    }
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

  function handleSubmit(e) {
    e.preventDefault();
    const sessionId = FSState.get().activeImSession;
    const input = document.getElementById('im-input');
    const text = input.value.trim();
    if (!sessionId || !text || !FSState.gridOnline()) return;

    FSTransport.sendIm(sessionId, text);
    input.value = '';
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
    document.querySelectorAll('.im-tab-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const tab = btn.getAttribute('data-tab-link');
        if (tab) FSNavigation.switchTab(tab);
      });
    });
    document.getElementById('im-tp-offer').addEventListener('click', function () {
      const session = FSState.get().imSessions[FSState.get().activeImSession];
      if (!session || !session.participant) return;
      FSTeleportUI.offerTo(session.participant.id, session.participant.name);
    });
    document.getElementById('im-tp-request').addEventListener('click', function () {
      const session = FSState.get().imSessions[FSState.get().activeImSession];
      if (!session || !session.participant) return;
      FSTeleportUI.requestFrom(session.participant.id, session.participant.name);
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
      document.getElementById('im-sessions').innerHTML = '';
      document.getElementById('im-messages').innerHTML = '';
      syncImLayout();
    });

    syncImLayout();
  }

  return { init: init, openSession: openSession, startImWith: startImWith, activate: activate, closeSession: closeSession };
})();
