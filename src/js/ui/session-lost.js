/**
 * Session lost overlay - sim disconnect without tearing down the shell.
 */
const FSSessionLost = (function () {
  'use strict';

  let modalOpen = false;

  function appEl() {
    return document.getElementById('app');
  }

  function blockerEl() {
    return document.getElementById('session-lost-blocker');
  }

  function setBlockerVisible(visible) {
    const blocker = blockerEl();
    if (!blocker) return;
    blocker.hidden = !visible;
    blocker.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function syncChrome() {
    const app = appEl();
    if (!app) return;
    const s = FSState.get();
    app.classList.toggle('app--offline', !!s.sessionLost);
    app.classList.toggle('app--session-lost-modal', modalOpen);
    app.classList.toggle(
      'app--logout-pulse',
      !!s.sessionLost && !!s.sessionLostDismissed && !modalOpen
    );
  }

  function show(reason) {
    const text = String(reason || '').trim() || 'Disconnected from the simulator.';
    modalOpen = true;

    FSState.patch({
      sessionLost: true,
      sessionLostReason: text,
      sessionLostDismissed: false
    });

    const reasonEl = document.getElementById('session-lost-reason');
    if (reasonEl) reasonEl.textContent = text;
    setBlockerVisible(true);
    syncChrome();

    const teleportDlg = document.getElementById('teleport-prompt');
    if (teleportDlg && teleportDlg.open) FSUtils.dismissDialog(teleportDlg);

    FSUtils.showToast('Session ended', 'warning', 4500);
  }

  function dismiss() {
    if (!modalOpen || !FSState.get().sessionLost) return;
    modalOpen = false;
    setBlockerVisible(false);
    FSState.patch({ sessionLostDismissed: true });
    syncChrome();
  }

  function hide() {
    modalOpen = false;
    setBlockerVisible(false);
    const app = appEl();
    if (app) {
      app.classList.remove('app--offline', 'app--session-lost-modal', 'app--logout-pulse');
    }
  }

  function returnToLogin() {
    if (window.FSApp) window.FSApp.logout({ skipConfirm: true });
  }

  function onStateChange(partial) {
    if (partial.sessionLost === false || partial.connected === true) {
      if (!FSState.get().sessionLost) {
        modalOpen = false;
        setBlockerVisible(false);
        syncChrome();
      }
    }
    if (partial.sessionLostDismissed !== undefined || partial.sessionLost !== undefined) {
      syncChrome();
    }
  }

  function init() {
    const loginBtn = document.getElementById('session-lost-login');
    if (loginBtn) {
      loginBtn.addEventListener('click', returnToLogin);
    }

    const dismissBtn = document.getElementById('session-lost-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', dismiss);
    }
    document.querySelectorAll('[data-session-lost-dismiss]').forEach(function (btn) {
      btn.addEventListener('click', dismiss);
    });

    const blocker = blockerEl();
    if (blocker) {
      blocker.addEventListener('click', function (e) {
        if (e.target === blocker) dismiss();
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !modalOpen) return;
      e.preventDefault();
      dismiss();
    });

    FSState.on('reset', hide);
    FSState.on('change', onStateChange);
  }

  return { init: init, show: show, hide: hide, dismiss: dismiss };
})();
