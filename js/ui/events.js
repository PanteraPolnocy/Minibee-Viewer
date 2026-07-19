/**
 * Events panel - script dialogs, permissions, prompts, and payments.
 */
const FSEvents = (function () {
  'use strict';

  const LIST_ID = 'event-messages';

  function syncEmptyState() {
    const empty = document.getElementById('events-empty');
    const list = document.getElementById(LIST_ID);
    if (!empty || !list) return;
    const hasMessages = FSState.get().eventMessages.length > 0;
    empty.hidden = hasMessages;
    list.hidden = !hasMessages;
  }

  function renderAll() {
    if (typeof FSChat.renderAllTo === 'function') {
      FSChat.renderAllTo(LIST_ID);
    }
    syncEmptyState();
  }

  function appendMessage(msg) {
    if (typeof FSChat.appendMessage === 'function') {
      FSChat.appendMessage(msg, true, LIST_ID);
    }
    syncEmptyState();
  }

  function updateMessage(msg) {
    if (typeof FSChat.updateMessage === 'function') {
      FSChat.updateMessage(msg, LIST_ID);
    }
  }

  function activate() {
    FSState.patch({ unreadEvents: 0 });
    renderAll();
  }

  function init() {
    FSState.on('event', function (msg) {
      if (FSState.get().activeTab === 'events') {
        appendMessage(msg);
      }
    });

    FSState.on('event-updated', function (msg) {
      if (FSState.get().activeTab === 'events') {
        updateMessage(msg);
      }
    });

    FSState.on('reset', function () {
      const list = document.getElementById(LIST_ID);
      if (list) list.innerHTML = '';
      syncEmptyState();
    });

    syncEmptyState();
  }

  return { init: init, activate: activate, renderAll: renderAll };
})();
