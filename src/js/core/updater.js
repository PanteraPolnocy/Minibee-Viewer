/**
 * Desktop auto-update UI. Checks and installs run in Rust (`app_check_update` / `app_install_update`).
 */
const FSUpdater = (function () {
  'use strict';

  let startupChecked = false;
  let updaterAvailable = null;

  function invoke(cmd, args) {
    if (typeof FSBridge === 'undefined' || typeof FSBridge.invoke !== 'function') {
      return Promise.reject(new Error('Native bridge unavailable'));
    }
    return FSBridge.invoke(cmd, args || {});
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
    if (!info || typeof FSUtils === 'undefined' || typeof FSUtils.confirm !== 'function') {
      return Promise.resolve(false);
    }
    const version = info.version ? String(info.version) : 'a new version';
    const notes = info.notes ? String(info.notes).trim() : '';
    const message = notes
      ? ('Version ' + version + ' is available.\n\n' + notes + '\n\nInstall now?')
      : ('Version ' + version + ' is available. Install now?');
    return FSUtils.confirm({
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
      if (typeof FSUtils !== 'undefined' && FSUtils.showToast) {
        FSUtils.showToast('Downloading update…', 'info', 4000);
      }
      return invoke('app_install_update').then(function () {
        return true;
      }).catch(function (err) {
        const msg = err && err.message ? err.message : String(err || 'Update failed');
        if (typeof FSUtils !== 'undefined' && FSUtils.showToast) {
          FSUtils.showToast('Update failed: ' + msg, 'warning', 6000);
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
      setStatus('Checking…');
      return invoke('app_check_update').then(function (result) {
        if (!result) return;
        if (result.status === 'error') {
          setStatus(result.message || 'Could not check for updates.');
          clearLater(5000);
          return;
        }
        if (result.status === 'up_to_date') {
          setStatus('You are up to date.');
          clearLater(3500);
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
