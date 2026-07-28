/**
 * Desktop auto-update UI. Checks and installs run in Rust (`app_check_update` / `app_install_update`).
 */
const BeeUpdater = (function () {
  'use strict';

  let startupChecked = false;
  let updaterAvailable = null;

  function invoke(cmd, args) {
    if (typeof BeeBridge === 'undefined' || typeof BeeBridge.invoke !== 'function') {
      return Promise.reject(new Error('Native bridge unavailable'));
    }
    return BeeBridge.invoke(cmd, args || {});
  }

  function available() {
    if (updaterAvailable !== null) {
      return Promise.resolve(updaterAvailable);
    }
    return invoke('app_updater_available').then(function (ok) {
      updaterAvailable = !!ok;
      return updaterAvailable;
    }).catch(function () {
      updaterAvailable = false;
      return false;
    });
  }

  function promptInstall(info) {
    if (!info || typeof BeeUtils === 'undefined' || typeof BeeUtils.confirm !== 'function') {
      return Promise.resolve(false);
    }
    const availableVersion = info.version ? String(info.version) : 'a new version';
    const notes = info.notes ? String(info.notes).trim() : '';
    const current = info.current_display_version ? String(info.current_display_version) : '';
    const currentLine = current ? ('You have ' + current + '.\n\n') : '';
    const message = notes
      ? (currentLine + 'Update ' + availableVersion + ' is available.\n\n' + notes + '\n\nInstall now?')
      : (currentLine + 'Update ' + availableVersion + ' is available. Install now?');
    return BeeUtils.confirm({
      title: 'Update available',
      message: message,
      confirmLabel: 'Install',
      cancelLabel: 'Later'
    });
  }

  function offerUpdate(info) {
    if (!info) return Promise.resolve(false);
    return promptInstall(info).then(function (accepted) {
      if (!accepted) return false;
      if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
        BeeUtils.showToast('Downloading update...', 'info', 4000);
      }
      return invoke('app_install_update').then(function () {
        return true;
      }).catch(function (err) {
        const msg = err && err.message ? err.message : String(err || 'Update failed');
        if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
          BeeUtils.showToast('Update failed: ' + msg, 'warning', 6000);
        }
        return false;
      });
    });
  }

  function checkStartup() {
    if (startupChecked) return Promise.resolve();
    return available().then(function (ok) {
      if (!ok) return;
      startupChecked = true;
      return invoke('app_check_update').then(function (result) {
        if (result && result.status === 'available') {
          return offerUpdate(result);
        }
      }).catch(function () {});
    });
  }

  function checkManual(statusEl) {
    function setStatus(text) {
      if (statusEl) statusEl.textContent = text || '';
    }
    function clearLater(ms) {
      window.setTimeout(function () { setStatus(''); }, ms);
    }

    return available().then(function (ok) {
      if (!ok) {
        setStatus('Updates are not available in this build.');
        return;
      }
      setStatus('Checking...');
      return invoke('app_check_update').then(function (result) {
        if (!result) return;
        if (result.status === 'error') {
          setStatus(result.message || 'Could not check for updates.');
          clearLater(5000);
          return;
        }
        if (result.status === 'up_to_date') {
          const current = result.current_display_version ? String(result.current_display_version) : '';
          setStatus(current ? ('You are up to date (' + current + ').') : 'You are up to date.');
          clearLater(4500);
          return;
        }
        if (result.status === 'available') {
          setStatus('Update ' + result.version + ' found.');
          return offerUpdate(result).then(function (installed) {
            if (!installed) setStatus('Update postponed.');
            clearLater(3500);
          });
        }
      });
    }).catch(function () {
      setStatus('Could not check for updates.');
      clearLater(5000);
    });
  }

  return {
    available: available,
    checkStartup: checkStartup,
    checkManual: checkManual
  };
})();
