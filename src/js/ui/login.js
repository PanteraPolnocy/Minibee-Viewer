/**
 * Login screen.
 */
const FSLogin = (function () {
  'use strict';

  const STORAGE_KEY = 'minibee-credentials';
  const STORAGE_KEY_LEGACY = 'fs-mobile-credentials';
  // MFA tokens are stored one key per account under these prefixes.
  const MFA_KEY_PATTERNS = [/^minibee-mfa-/i, /^fs-mobile-mfa-/i];
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

  function mfaKeys() {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && MFA_KEY_PATTERNS.some(function (re) { return re.test(key); })) {
          keys.push(key);
        }
      }
    } catch (_e) { /* ignore */ }
    return keys;
  }

  function hasSavedLogin() {
    if (FSUtils.storageGet(STORAGE_KEY, null)) return true;
    if (FSUtils.storageGet(STORAGE_KEY_LEGACY, null)) return true;
    return mfaKeys().length > 0;
  }

  // Clear the saved username/grid and every remembered MFA token.
  async function forgetCredentials() {
    const ok = await FSUtils.confirm({
      title: 'Forget saved login?',
      message: 'This clears the saved username, grid, and any remembered MFA tokens on this device. Your password is never stored.',
      confirmLabel: 'Forget',
      danger: true
    });
    if (!ok) return;
    [STORAGE_KEY, STORAGE_KEY_LEGACY].concat(mfaKeys()).forEach(function (key) {
      try { localStorage.removeItem(key); } catch (_e) { /* ignore */ }
    });
    const user = document.getElementById('login-username');
    const pass = document.getElementById('login-password');
    const remember = document.getElementById('login-remember');
    if (user) user.value = '';
    if (pass) pass.value = '';
    if (remember) remember.checked = true;
    defaultGrid();
    updateForgetVisibility();
    FSUtils.showToast('Saved login and MFA tokens cleared.', 'success');
  }

  function updateForgetVisibility() {
    const btn = document.getElementById('login-forget');
    if (btn) btn.hidden = !hasSavedLogin();
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
        FSUtils.dismissDialog(dialog);
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
    const forgetBtn = document.getElementById('login-forget');
    if (forgetBtn) forgetBtn.addEventListener('click', forgetCredentials);
    updateForgetVisibility();
  }

  async function checkBridge() {
    const el = document.getElementById('bridge-status');
    if (!el) return;
    el.textContent = 'Checking backend...';
    try {
      const b = new FSBridge.Bridge();
      const health = await b.health();
      if (!health || !health.ok) {
        el.textContent = 'Backend unavailable - run the Minibee app';
        return;
      }
      el.textContent = 'Backend ready';
    } catch (_e) {
      el.textContent = 'Backend unavailable - run the Minibee app';
    }
  }

  return {
    init: init,
    showScreen: showScreen,
    showError: showError,
    checkBridge: checkBridge
  };
})();
