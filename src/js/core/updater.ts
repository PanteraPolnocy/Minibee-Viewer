/**
 * Desktop auto-update UI. Checks and installs run in Rust (`app_check_update` / `app_install_update`).
 */
const BeeUpdater = (function () {
  'use strict';

  const t = BeeI18n.t;

  let startupChecked = false;
  let updaterAvailable = null;

  function invoke(cmd: string, args?: Record<string, unknown>) {
    if (typeof BeeBridge === 'undefined' || typeof BeeBridge.invoke !== 'function') {
      return Promise.reject(new Error(t('updater.bridgeUnavailable')));
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
    const availableVersion = info.version ? String(info.version) : t('updater.newVersion');
    const notes = info.notes ? String(info.notes).trim() : ''; // the release notes, as published
    const current = info.current_display_version ? String(info.current_display_version) : '';
    const currentLine = current ? (t('updater.youHave', { version: current }) + '\n\n') : '';
    const message = notes
      ? (currentLine + t('updater.available', { version: availableVersion }) +
        '\n\n' + notes + '\n\n' + t('updater.installNow'))
      : (currentLine + t('updater.availableInstall', { version: availableVersion }));
    return BeeUtils.confirm({
      title: t('updater.title'),
      message: message,
      confirmLabel: t('updater.install'),
      cancelLabel: t('updater.later')
    });
  }

  function offerUpdate(info) {
    if (!info) return Promise.resolve(false);
    return promptInstall(info).then(function (accepted) {
      if (!accepted) return false;
      if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
        BeeUtils.showToast(t('updater.downloading'), 'info', 4000);
      }
      return invoke('app_install_update').then(function () {
        return true;
      }).catch(function (err) {
        if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
          const msg = BeeUtils.errText(err) || t('updater.failed');
          BeeUtils.showToast(t('updater.failedWith', { error: msg }), 'warning', 6000);
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
        setStatus(t('updater.notAvailable'));
        return;
      }
      setStatus(t('updater.checking'));
      return invoke('app_check_update').then(function (result) {
        if (!result) return;
        if (result.status === 'error') {
          // The core's own account of what went wrong, when it has one.
          setStatus(BeeI18n.field(result, 'message') || t('updater.checkFailed'));
          clearLater(5000);
          return;
        }
        if (result.status === 'up_to_date') {
          const current = result.current_display_version ? String(result.current_display_version) : '';
          setStatus(current
            ? t('updater.upToDateVersion', { version: current })
            : t('updater.upToDate'));
          clearLater(4500);
          return;
        }
        if (result.status === 'available') {
          setStatus(t('updater.found', { version: result.version }));
          return offerUpdate(result).then(function (installed) {
            if (!installed) setStatus(t('updater.postponed'));
            clearLater(3500);
          });
        }
        // 'unavailable' (updater not built in), or any status a future core
        // adds - never leave the label stuck on "Checking...".
        setStatus(result.status === 'unavailable'
          ? t('updater.notAvailable')
          : t('updater.checkFailed'));
        clearLater(4500);
      });
    }).catch(function () {
      setStatus(t('updater.checkFailed'));
      clearLater(5000);
    });
  }

  return {
    available: available,
    checkStartup: checkStartup,
    checkManual: checkManual
  };
})();
