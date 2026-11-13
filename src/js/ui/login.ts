/**
 * Login screen - credential entry, the login-challenge flow (MFA, ToS,
 * critical messages), and the handoff to the app once the user connects.
 */
const BeeLogin = (function () {
  'use strict';

  const t = BeeI18n.t;

  const STORAGE_KEY = 'minibee-credentials';
  // MFA tokens live one key per account, matched by this prefix.
  const MFA_KEY_PATTERNS = [/^minibee-mfa-/i];
  // Second Life only: the main grid and the beta grid.
  const GRID_OPTIONS = ['agni', 'aditi'];

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
      title: t('login.forgetTitle'),
      message: t('login.forgetMessage'),
      confirmLabel: t('login.forgetConfirm'),
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
    BeeUtils.showToast(t('login.forgetDone'), 'success');
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
        title.textContent = t('login.tosTitle');
        accept.textContent = t('login.tosAccept');
        decline.textContent = t('common.decline');
        mfaFields.hidden = true;
      } else if (challenge.type === 'critical') {
        title.textContent = t('login.criticalTitle');
        accept.textContent = t('login.criticalAccept');
        decline.textContent = t('common.cancel');
        mfaFields.hidden = true;
      } else if (challenge.type === 'mfa') {
        title.textContent = t('login.mfaTitle');
        accept.textContent = t('login.mfaVerify');
        decline.textContent = t('common.cancel');
        mfaFields.hidden = false;
        mfaToken.value = '';
        mfaRemember.checked = true;
      } else {
        title.textContent = t('login.challengeTitle');
        accept.textContent = t('common.continue');
        decline.textContent = t('common.cancel');
        mfaFields.hidden = true;
      }

      // Render the message with clickable, safely-opened links, so a user can
      // read a Terms of Service or critical-message URL before having to agree.
      // The message itself is the grid's (the ToS text, a critical notice).
      const rawMsg = challenge.message || t('login.challengeDefault');
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
      showError(t('login.viewerNotLoaded'));
      return;
    }
    if (typeof BeeSLBridge === 'undefined') {
      showError(t('login.protocolNotLoaded'));
      return;
    }

    btn.disabled = true;
    btn.textContent = t('login.connecting');

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
      // The grid's own refusal (a wrong password, a banned account) shows as
      // the grid worded it; only the fallback is ours.
      showError(BeeUtils.errText(err) || t('login.failed'));
      BeeState.patch({ connecting: false });
    } finally {
      btn.disabled = false;
      btn.textContent = t('login.submit');
    }
  }

  function setViewerVersion() {
    if (typeof MinibeeVersion !== 'undefined') {
      MinibeeVersion.load().catch(function () { /* version label optional */ });
    }
  }

  function init() {
    loadSaved();
    setViewerVersion();
    const form = document.getElementById('login-form');
    if (!form) {
      console.error('Login form not found');
      return;
    }
    form.addEventListener('submit', handleSubmit);
    const forgetBtn = document.getElementById('login-forget') as HTMLButtonElement;
    if (forgetBtn) forgetBtn.addEventListener('click', forgetCredentials);
    updateForgetVisibility();
  }

  return {
    init: init,
    showScreen: showScreen,
    showError: showError
  };
})();
