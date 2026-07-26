/**
 * Desktop auto-update helper (Tauri updater + process plugins).
 * Uses the global API exposed by withGlobalTauri.
 */
const FSUpdater = (function () {
  'use strict';

  let startupChecked = false;
  let buildTarget = '';

  function tauri() {
    return (typeof window !== 'undefined' && window.__TAURI__) ? window.__TAURI__ : null;
  }

  function available() {
    const t = tauri();
    return !!(t && t.updater && typeof t.updater.check === 'function');
  }

  function setBuildTarget(target) {
    buildTarget = typeof target === 'string' ? target : '';
  }

  function checkOptions() {
    if (buildTarget.indexOf('universal') !== -1) {
      return { target: 'darwin-universal' };
    }
    return {};
  }

  function checkForUpdate() {
    if (!available()) return Promise.resolve(null);
    return tauri().updater.check(checkOptions()).then(function (update) {
      return update || null;
    });
  }

  function formatNotes(update) {
    const body = update && update.body ? String(update.body).trim() : '';
    if (body) return body;
    return '';
  }

  function promptInstall(update) {
    if (!update || typeof FSUtils === 'undefined' || typeof FSUtils.confirm !== 'function') {
      return Promise.resolve(false);
    }
    const version = update.version ? String(update.version) : 'a new version';
    const notes = formatNotes(update);
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

  function downloadAndInstall(update) {
    if (!update || !available()) {
      return Promise.reject(new Error('Updater unavailable'));
    }
    if (typeof FSUtils !== 'undefined' && FSUtils.showToast) {
      FSUtils.showToast('Downloading update…', 'info', 4000);
    }
    return update.downloadAndInstall(function (event) {
      if (!event || event.event !== 'Progress' || typeof FSUtils === 'undefined' || !FSUtils.showToast) {
        return;
      }
      const total = event.data && event.data.contentLength;
      if (!total) return;
    }).then(function () {
      const t = tauri();
      if (t && t.process && typeof t.process.relaunch === 'function') {
        return t.process.relaunch();
      }
    });
  }

  function offerUpdate(update) {
    if (!update) return Promise.resolve(false);
    return promptInstall(update).then(function (accepted) {
      if (!accepted) return false;
      return downloadAndInstall(update).then(function () {
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
    if (startupChecked || !available()) return Promise.resolve();
    startupChecked = true;
    return checkForUpdate().then(function (update) {
      if (!update) return;
      return offerUpdate(update);
    }).catch(function () {});
  }

  function checkManual(statusEl) {
    function setStatus(text) {
      if (statusEl) statusEl.textContent = text || '';
    }
    if (!available()) {
      setStatus('Updates are not available in this build.');
      return Promise.resolve();
    }
    setStatus('Checking…');
    return checkForUpdate().then(function (update) {
      if (!update) {
        setStatus('You are up to date.');
        window.setTimeout(function () { setStatus(''); }, 3500);
        return;
      }
      setStatus('Update ' + update.version + ' found.');
      return offerUpdate(update).then(function (installed) {
        if (!installed) setStatus('Update postponed.');
        window.setTimeout(function () { setStatus(''); }, 3500);
      });
    }).catch(function (err) {
      const msg = err && err.message ? err.message : 'Could not check for updates.';
      setStatus(msg);
      window.setTimeout(function () { setStatus(''); }, 5000);
    });
  }

  return {
    available: available,
    setBuildTarget: setBuildTarget,
    checkStartup: checkStartup,
    checkManual: checkManual
  };
})();
