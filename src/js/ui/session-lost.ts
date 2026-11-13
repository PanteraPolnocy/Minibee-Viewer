/**
 * Session lost overlay - lets us flag a sim disconnect without tearing down the app shell.
 */
const BeeSessionLost = (function () {
  'use strict';

  const t = BeeI18n.t;

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
    const s = BeeState.get();
    app.classList.toggle('app--offline', !!s.sessionLost);
    app.classList.toggle('app--session-lost-modal', modalOpen);
    app.classList.toggle(
      'app--logout-pulse',
      !!s.sessionLost && !!s.sessionLostDismissed && !modalOpen
    );
  }

  // `reason` is the line to show: the core's words already resolved by the
  // caller (BeeApp's session-lost handler), or the event payload itself, whose
  // reason is read through its key when the core sent one; a kick reason from
  // the grid passes through as it is.
  function show(reason) {
    const given = reason && typeof reason === 'object'
      ? BeeI18n.field(reason, 'reason')
      : String(reason || '');
    const text = given.trim() || t('session.disconnected');
    modalOpen = true;

    BeeState.patch({
      sessionLost: true,
      sessionLostReason: text,
      sessionLostDismissed: false
    });

    const reasonEl = document.getElementById('session-lost-reason');
    if (reasonEl) reasonEl.textContent = text;
    setBlockerVisible(true);
    syncChrome();

    const teleportDlg = document.getElementById('teleport-prompt') as HTMLDialogElement | null;
    if (teleportDlg && teleportDlg.open) BeeUtils.dismissDialog(teleportDlg);

    BeeUtils.showToast(t('session.ended'), 'warning', 4500);
  }

  function dismiss() {
    if (!modalOpen || !BeeState.get().sessionLost) return;
    modalOpen = false;
    setBlockerVisible(false);
    BeeState.patch({ sessionLostDismissed: true });
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
    if (window.BeeApp) window.BeeApp.logout({ skipConfirm: true });
  }

  function onStateChange(partial) {
    if (partial.sessionLost === false || partial.connected === true) {
      if (!BeeState.get().sessionLost) {
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
    document.querySelectorAll<HTMLElement>('[data-session-lost-dismiss]').forEach(function (btn) {
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

    BeeState.on('reset', hide);
    BeeState.on('change', onStateChange);
  }

  return { init: init, show: show, hide: hide, dismiss: dismiss };
})();
