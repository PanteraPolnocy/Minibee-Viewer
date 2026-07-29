// @ts-nocheck - not yet migrated to checked types. Remove this line, then fix
// what npm run typecheck reports for this file.
/**
 * The Events panel - where script dialogs, permissions, prompts, payments and
 * group notices land. Split into subtabs (All / Notices / Offers / Scripts /
 * Money), each with its own unread badge so nothing sneaks in unseen.
 */
const BeeEvents = (function () {
  'use strict';

  const LIST_ID = 'event-messages';

  const CATEGORIES = ['notices', 'offers', 'scripts', 'payments'];
  let activeSub = 'all';
  // Per-category "arrived while you weren't looking at that subtab" counts.
  const unseen = { notices: 0, offers: 0, scripts: 0, payments: 0 };

  // Which subtab a message belongs to. Everything falls somewhere: an
  // uncategorized kind lands in Notices rather than vanishing.
  function categoryOf(msg) {
    if (!msg) return 'notices';
    if (msg.kind === 'payment') return 'payments';
    if (msg.kind === 'script-dialog' || msg.kind === 'script-permission') return 'scripts';
    if (msg.kind === 'interactive-prompt') {
      const t = msg.prompt && msg.prompt.type;
      if (t === 'load-url' || t === 'script-teleport') return 'scripts';
      return 'offers';
    }
    if (msg.kind === 'group-notice' || msg.kind === 'motd') return 'notices';
    return 'notices';
  }

  function matchesActiveSub(msg) {
    return activeSub === 'all' || categoryOf(msg) === activeSub;
  }

  function subFilter(msg) {
    return matchesActiveSub(msg);
  }

  function isEventsTabActive() {
    return BeeState.get().activeTab === 'events';
  }

  function updateSubBadges() {
    document.querySelectorAll('.events-subtab').forEach(function (btn) {
      const cat = btn.dataset.eventsSub;
      const badge = btn.querySelector('.events-subtab__badge');
      if (!badge) return; // "All" carries no badge; the main tab covers it
      const count = unseen[cat] || 0;
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.hidden = count === 0;
    });
  }

  function clearUnseen(cat) {
    if (cat === 'all') {
      CATEGORIES.forEach(function (c) { unseen[c] = 0; });
    } else if (cat in unseen) {
      unseen[cat] = 0;
    }
    updateSubBadges();
  }

  function syncEmptyState() {
    const empty = document.getElementById('events-empty');
    const list = document.getElementById(LIST_ID);
    if (!empty || !list) return;
    const hasMessages = BeeState.get().eventMessages.some(subFilter);
    empty.hidden = hasMessages;
    list.hidden = !hasMessages;
  }

  function renderAll() {
    if (typeof BeeChat.renderAllTo === 'function') {
      BeeChat.renderAllTo(LIST_ID, subFilter);
    }
    syncEmptyState();
  }

  function appendMessage(msg) {
    if (typeof BeeChat.appendMessage === 'function') {
      BeeChat.appendMessage(msg, true, LIST_ID);
    }
    syncEmptyState();
  }

  function updateMessage(msg) {
    if (typeof BeeChat.updateMessage === 'function') {
      BeeChat.updateMessage(msg, LIST_ID);
    }
  }

  function setSub(cat) {
    activeSub = CATEGORIES.indexOf(cat) !== -1 ? cat : 'all';
    document.querySelectorAll('.events-subtab').forEach(function (btn) {
      const active = btn.dataset.eventsSub === activeSub;
      btn.classList.toggle('events-subtab--active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    clearUnseen(activeSub);
    renderAll();
  }

  function activate() {
    BeeState.patch({ unreadEvents: 0 });
    // Opening the tab shows whatever the current subtab covers.
    clearUnseen(activeSub);
    renderAll();
  }

  function init() {
    document.querySelectorAll('.events-subtab').forEach(function (btn) {
      btn.addEventListener('click', function () { setSub(btn.dataset.eventsSub); });
    });

    BeeState.on('event', function (msg) {
      const visible = isEventsTabActive() && matchesActiveSub(msg);
      if (visible) {
        appendMessage(msg);
      } else {
        // Not on screen right now: light up that category's badge.
        const cat = categoryOf(msg);
        unseen[cat] = (unseen[cat] || 0) + 1;
        updateSubBadges();
      }
    });

    BeeState.on('event-updated', function (msg) {
      if (isEventsTabActive() && matchesActiveSub(msg)) {
        updateMessage(msg);
      }
    });

    BeeState.on('reset', function () {
      const list = document.getElementById(LIST_ID);
      if (list) list.innerHTML = '';
      clearUnseen('all');
      syncEmptyState();
    });

    syncEmptyState();
  }

  return { init: init, activate: activate, renderAll: renderAll };
})();
