/**
 * Login screen.
 */
const FSLogin = (function () {
  'use strict';

  const STORAGE_KEY = 'minibee-credentials';
  const STORAGE_KEY_LEGACY = 'fs-mobile-credentials';
  const GRID_OPTIONS = ['agni', 'aditi', 'local'];

  function defaultGrid() {
    const grid = document.getElementById('login-grid');
    if (grid) grid.value = 'agni';
  }

  function showError(msg) {
    const el = document.getElementById('login-error');
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  function showScreen(loggedIn) {
    document.getElementById('screen-login').classList.toggle('screen--active', !loggedIn);
    document.getElementById('screen-main').hidden = !loggedIn;
    document.getElementById('screen-main').classList.toggle('screen--active', loggedIn);
  }

  function loadSaved() {
    let saved = FSUtils.storageGet(STORAGE_KEY, null);
    if (!saved) {
      saved = FSUtils.storageGet(STORAGE_KEY_LEGACY, null);
      if (saved) {
        FSUtils.storageSet(STORAGE_KEY, saved);
        try { localStorage.removeItem(STORAGE_KEY_LEGACY); } catch (_e) { /* ignore */ }
      }
    }
    if (!saved) {
      defaultGrid();
      return;
    }
    const user = document.getElementById('login-username');
    const grid = document.getElementById('login-grid');
    const remember = document.getElementById('login-remember');
    if (user && saved.username) user.value = saved.username;
    if (grid) {
      grid.value = GRID_OPTIONS.indexOf(saved.grid) >= 0 ? saved.grid : 'agni';
    }
    if (remember) remember.checked = !!saved.remember;
  }

  function saveCredentials(data) {
    if (data.remember) {
      FSUtils.storageSet(STORAGE_KEY, {
        username: data.username,
        grid: data.grid,
        remember: true
      });
    } else {
      try { localStorage.removeItem(STORAGE_KEY); } catch (_e) { /* ignore */ }
    }
  }

  function showChallenge(challenge) {
    return new Promise(function (resolve) {
      const dialog = document.getElementById('login-challenge');
      const title = document.getElementById('challenge-title');
      const body = document.getElementById('challenge-body');
      const mfaFields = document.getElementById('challenge-mfa-fields');
      const mfaToken = document.getElementById('challenge-mfa-token');
      const mfaRemember = document.getElementById('challenge-mfa-remember');
      const form = document.getElementById('login-challenge-form');
      const decline = document.getElementById('challenge-decline');
      const accept = document.getElementById('challenge-accept');

      function finish(result) {
        form.removeEventListener('submit', onSubmit);
        decline.removeEventListener('click', onDecline);
        dialog.removeEventListener('cancel', onCancel);
        if (dialog.open) dialog.close();
        resolve(result);
      }

      function onDecline() {
        finish({ action: 'decline' });
      }

      function onCancel(e) {
        e.preventDefault();
        onDecline();
      }

      function onSubmit(e) {
        e.preventDefault();
        if (challenge.type === 'mfa') {
          const token = mfaToken.value.trim();
          if (!token) {
            mfaToken.focus();
            return;
          }
          finish({
            action: 'submit',
            token: token,
            rememberMfa: mfaRemember.checked
          });
          return;
        }
        finish({ action: 'accept' });
      }

      if (challenge.type === 'tos') {
        title.textContent = 'Terms of Service';
        accept.textContent = 'I Agree';
        decline.textContent = 'Decline';
        mfaFields.hidden = true;
      } else if (challenge.type === 'critical') {
        title.textContent = 'Important message';
        accept.textContent = 'I have read this';
        decline.textContent = 'Cancel';
        mfaFields.hidden = true;
      } else if (challenge.type === 'mfa') {
        title.textContent = 'Two-factor authentication';
        accept.textContent = 'Verify';
        decline.textContent = 'Cancel';
        mfaFields.hidden = false;
        mfaToken.value = '';
        mfaRemember.checked = true;
      } else {
        title.textContent = 'Action required';
        accept.textContent = 'Continue';
        decline.textContent = 'Cancel';
        mfaFields.hidden = true;
      }

      body.textContent = challenge.message || 'Please confirm to continue.';
      decline.hidden = false;

      form.addEventListener('submit', onSubmit);
      decline.addEventListener('click', onDecline);
      dialog.addEventListener('cancel', onCancel);
      dialog.showModal();

      if (challenge.type === 'mfa') {
        mfaToken.focus();
      }
    });
  }

  let caBundleReady = false;

  function isCaBundleReady(health) {
    return !!(health && health.caBundle && health.caBundle.ok);
  }

  function setCaBundleError(msg) {
    const el = document.getElementById('ca-bundle-error');
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  function showCaBundleModal(message) {
    return new Promise(function (resolve) {
      const dialog = document.getElementById('ca-bundle-prompt');
      const msgEl = document.getElementById('ca-bundle-message');
      const retryBtn = document.getElementById('ca-bundle-retry');
      const dismissBtn = document.getElementById('ca-bundle-dismiss');
      if (!dialog || !retryBtn || !dismissBtn) {
        resolve(false);
        return;
      }

      if (msgEl && message) msgEl.textContent = message;
      setCaBundleError('');

      function cleanup() {
        retryBtn.removeEventListener('click', onRetry);
        dismissBtn.removeEventListener('click', onDismiss);
        dialog.removeEventListener('cancel', onCancel);
      }

      function closeDialog() {
        if (dialog.open) dialog.close();
      }

      function onDismiss() {
        cleanup();
        closeDialog();
        resolve(false);
      }

      function onCancel(e) {
        e.preventDefault();
        onDismiss();
      }

      async function onRetry() {
        setCaBundleError('');
        retryBtn.disabled = true;
        retryBtn.textContent = 'Downloading...';
        try {
          const ok = await fetchCaBundle();
          if (ok) {
            cleanup();
            closeDialog();
            resolve(true);
            return;
          }
          setCaBundleError('Download failed. Check your internet connection and try again, or follow the manual steps.');
        } catch (err) {
          setCaBundleError(err.message || 'Download failed.');
        } finally {
          retryBtn.disabled = false;
          retryBtn.textContent = 'Download now';
        }
      }

      retryBtn.addEventListener('click', onRetry);
      dismissBtn.addEventListener('click', onDismiss);
      dialog.addEventListener('cancel', onCancel);
      dialog.showModal();
    });
  }

  async function fetchCaBundle() {
    const b = new FSBridge.Bridge();
    const result = await b.fetchCaBundle();
    if (result && result.ok) {
      caBundleReady = true;
      return true;
    }
    const health = await b.health();
    if (isCaBundleReady(health)) {
      caBundleReady = true;
      return true;
    }
    return false;
  }

  async function ensureCaBundle() {
    const b = new FSBridge.Bridge();
    let health;
    try {
      health = await b.health();
    } catch (_e) {
      return false;
    }
    if (isCaBundleReady(health)) {
      caBundleReady = true;
      return true;
    }
    try {
      if (await fetchCaBundle()) return true;
    } catch (_e) { /* fall through to modal */ }
    const ok = await showCaBundleModal(
      'Minibee could not find or download a CA certificate bundle. Login and the Destination Guide need it for HTTPS.'
    );
    return ok;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    showError('');

    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const grid = document.getElementById('login-grid').value;
    const remember = document.getElementById('login-remember').checked;
    const btn = document.getElementById('login-submit');

    if (!window.FSApp || typeof window.FSApp.login !== 'function') {
      showError('Viewer failed to load. Hard-refresh (Ctrl+Shift+R) and check the browser console.');
      return;
    }
    if (typeof FSSLTransport === 'undefined') {
      showError('Protocol module failed to load. Hard-refresh (Ctrl+Shift+R).');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Connecting...';

    try {
      const caOk = await ensureCaBundle();
      if (!caOk) {
        showError('HTTPS certificates are required before login.');
        return;
      }
      FSState.patch({ connecting: true });
      saveCredentials({ username: username, grid: grid, remember: remember });
      await window.FSApp.login({
        username: username,
        password: password,
        grid: grid,
        remember: remember,
        onChallenge: showChallenge
      });
      showScreen(true);
    } catch (err) {
      showError(err.message || 'Login failed.');
      FSState.patch({ connecting: false });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Log In';
    }
  }

  function setViewerVersion() {
    const el = document.getElementById('login-version');
    if (!el) return;
    const apply = function () {
      if (typeof MinibeeVersion !== 'undefined' && MinibeeVersion.isLoaded()) {
        el.textContent = MinibeeVersion.getVersionString();
      } else if (typeof FSLoginSL !== 'undefined' && FSLoginSL.getViewerVersion) {
        el.textContent = FSLoginSL.getViewerVersion();
      }
    };
    if (typeof MinibeeVersion !== 'undefined') {
      MinibeeVersion.load().then(apply).catch(function () { /* keep HTML placeholder */ });
    }
  }

  function init() {
    if (window.MINIBEE_BLOCKED) return;
    loadSaved();
    setViewerVersion();
    const form = document.getElementById('login-form');
    if (!form) {
      console.error('Login form not found');
      return;
    }
    form.addEventListener('submit', handleSubmit);
    checkBridge();
    const gridEl = document.getElementById('login-grid');
    if (gridEl) gridEl.addEventListener('change', checkBridge);
  }

  async function checkBridge() {
    const el = document.getElementById('bridge-status');
    if (!el) return;
    el.textContent = 'Checking bridge...';
    try {
      const b = new FSBridge.Bridge();
      const health = await b.health();
      if (!health || !health.ok) {
        el.textContent = 'Bridge offline - run: start-minibee.bat';
        caBundleReady = false;
        return;
      }
      const pollOk = health.poll ? !!health.poll.ok : false;
      if (!pollOk) {
        try {
          const poll = await b.pollHealth();
          if (!poll || !poll.ok) {
            el.textContent = 'Poll bridge offline (8795) - restart start-minibee.bat';
            caBundleReady = false;
            return;
          }
        } catch (_pollErr) {
          el.textContent = 'Poll bridge offline (8795) - restart start-minibee.bat';
          caBundleReady = false;
          return;
        }
      }
      if (isCaBundleReady(health)) {
        caBundleReady = true;
        el.textContent = 'Bridge online (caps + poll)';
        return;
      }
      el.textContent = 'Bridge online - fetching CA certificates...';
      try {
        if (await fetchCaBundle()) {
          el.textContent = 'Bridge online (caps + poll)';
          return;
        }
      } catch (_e) { /* show warning below */ }
      caBundleReady = false;
      el.textContent = 'Bridge online - HTTPS certificates missing (login will prompt)';
    } catch (_e) {
      caBundleReady = false;
      el.textContent = 'Bridge offline - run: start-minibee.bat';
    }
  }

  return {
    init: init,
    showScreen: showScreen,
    showError: showError,
    checkBridge: checkBridge,
    ensureCaBundle: ensureCaBundle
  };
})();
