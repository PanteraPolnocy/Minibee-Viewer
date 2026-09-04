/**
 * Login screen - credential entry, the login-challenge flow (MFA, ToS,
 * critical messages), and the handoff to the app once the user connects.
 */
const BeeLogin = (function () {
  'use strict';

  const STORAGE_KEY = 'minibee-credentials';
  // MFA tokens live one key per account, matched by this prefix.
  const MFA_KEY_PATTERNS = [/^minibee-mfa-/i];
  const GRID_OPTIONS = ['agni', 'aditi', 'local'];

  function defaultGrid() {
    const grid = document.getElementById('login-grid') as HTMLSelectElement;
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
    const saved = BeeUtils.storageGet(STORAGE_KEY, null);
    if (!saved) {
      defaultGrid();
      return;
    }
    const user = document.getElementById('login-username') as HTMLInputElement;
    const grid = document.getElementById('login-grid') as HTMLSelectElement;
    const remember = document.getElementById('login-remember') as HTMLInputElement;
    if (user && saved.username) user.value = saved.username;
    if (grid) {
      grid.value = GRID_OPTIONS.indexOf(saved.grid) >= 0 ? saved.grid : 'agni';
    }
    if (remember) remember.checked = !!saved.remember;
  }

  function saveCredentials(data) {
    if (data.remember) {
      BeeUtils.storageSet(STORAGE_KEY, {
        username: data.username,
        grid: data.grid,
        remember: true
      });
    } else {
      BeeUtils.storageRemove(STORAGE_KEY);
    }
  }

  function mfaKeys() {
    return BeeUtils.storageKeys().filter(function (key) {
      return MFA_KEY_PATTERNS.some(function (re) { return re.test(key); });
    });
  }

  function hasSavedLogin() {
    if (BeeUtils.storageGet(STORAGE_KEY, null)) return true;
    return mfaKeys().length > 0;
  }

  // Forget the saved username/grid and every remembered MFA token.
  async function forgetCredentials() {
    const ok = await BeeUtils.confirm({
      title: 'Forget saved login?',
      message: 'This clears the saved username, grid, and any remembered MFA tokens on this device. Your password is never stored.',
      confirmLabel: 'Forget',
      danger: true
    });
    if (!ok) return;
    [STORAGE_KEY].concat(mfaKeys()).forEach(function (key) {
      BeeUtils.storageRemove(key);
    });
    const user = document.getElementById('login-username') as HTMLInputElement;
    const pass = document.getElementById('login-password') as HTMLInputElement;
    const remember = document.getElementById('login-remember') as HTMLInputElement;
    if (user) user.value = '';
    if (pass) pass.value = '';
    if (remember) remember.checked = true;
    defaultGrid();
    updateForgetVisibility();
    BeeUtils.showToast('Saved login and MFA tokens cleared.', 'success');
  }

  function updateForgetVisibility() {
    const btn = document.getElementById('login-forget') as HTMLButtonElement;
    if (btn) btn.hidden = !hasSavedLogin();
  }

  function showChallenge(challenge) {
    return new Promise(function (resolve) {
      const dialog = document.getElementById('login-challenge') as HTMLDialogElement;
      const title = document.getElementById('challenge-title');
      const body = document.getElementById('challenge-body');
      const mfaFields = document.getElementById('challenge-mfa-fields');
      const mfaToken = document.getElementById('challenge-mfa-token') as HTMLInputElement;
      const mfaRemember = document.getElementById('challenge-mfa-remember') as HTMLInputElement;
      const form = document.getElementById('login-challenge-form');
      const decline = document.getElementById('challenge-decline');
      const accept = document.getElementById('challenge-accept');

      function finish(result) {
        form.removeEventListener('submit', onSubmit);
        decline.removeEventListener('click', onDecline);
        dialog.removeEventListener('cancel', onCancel);
        BeeUtils.dismissDialog(dialog);
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

      // Render the message with clickable, safely-opened links, so a user can
      // read a Terms of Service or critical-message URL before having to agree.
      const rawMsg = challenge.message || 'Please confirm to continue.';
      if (typeof BeeSlurl !== 'undefined' && BeeSlurl.linkify) {
        body.innerHTML = BeeSlurl.linkify(rawMsg, BeeUtils.escapeHtml).replace(/\n/g, '<br>');
        if (BeeSlurl.bindLinks) BeeSlurl.bindLinks(body);
      } else {
        body.textContent = rawMsg;
      }
      decline.hidden = false;

      form.addEventListener('submit', onSubmit);
      decline.addEventListener('click', onDecline);
      dialog.addEventListener('cancel', onCancel);
      if (typeof dialog.showModal === 'function') {
        try {
          if (!dialog.open) dialog.showModal();
        } catch (_e) {
          dialog.setAttribute('open', '');
        }
      } else {
        dialog.setAttribute('open', '');
      }

      if (challenge.type === 'mfa') {
        mfaToken.focus();
      }
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    showError('');

    const username = (document.getElementById('login-username') as HTMLInputElement).value;
    const password = (document.getElementById('login-password') as HTMLInputElement).value;
    const grid = (document.getElementById('login-grid') as HTMLSelectElement).value;
    const remember = (document.getElementById('login-remember') as HTMLInputElement).checked;
    const btn = document.getElementById('login-submit') as HTMLButtonElement;

    if (!window.BeeApp || typeof window.BeeApp.login !== 'function') {
      showError('Viewer failed to load. Hard-refresh (Ctrl+Shift+R) and check the browser console.');
      return;
    }
    if (typeof BeeSLBridge === 'undefined') {
      showError('Protocol module failed to load. Hard-refresh (Ctrl+Shift+R).');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Connecting...';

    try {
      BeeState.patch({ connecting: true });
      saveCredentials({ username: username, grid: grid, remember: remember });
      await window.BeeApp.login({
        username: username,
        password: password,
        grid: grid,
        remember: remember,
        onChallenge: showChallenge
      });
      showScreen(true);
    } catch (err) {
      showError(err.message || 'Login failed.');
      BeeState.patch({ connecting: false });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Log In';
    }
  }

  function setViewerVersion() {
    if (typeof MinibeeVersion !== 'undefined') {
      MinibeeVersion.load().catch(function () { /* version label optional */ });
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
    const gridEl = document.getElementById('login-grid') as HTMLSelectElement;
    if (gridEl) gridEl.addEventListener('change', checkBridge);
    const forgetBtn = document.getElementById('login-forget') as HTMLButtonElement;
    if (forgetBtn) forgetBtn.addEventListener('click', forgetCredentials);
    updateForgetVisibility();
  }

  async function checkBridge() {
    const el = document.getElementById('bridge-status');
    if (!el) return;
    el.textContent = 'Checking backend...';
    try {
      const b = new BeeBridge.Bridge();
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
