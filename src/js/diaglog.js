/**
 * The frontend half of the diagnostic log. It hands each line off to the
 * native core (`bridge_log`), which only bothers to write it when logging was
 * switched on at startup (`--enablelogfiles`); otherwise the whole thing is a
 * cheap no-op. It also quietly captures any uncaught errors.
 */
const FSDiag = (function () {
  'use strict';

  let enabled = false;
  let ready = false;

  function forward(source, message) {
    if (!enabled) return;
    try {
      FSBridge.invoke('bridge_log', { source: String(source || 'js'), message: String(message) });
    } catch (_e) { /* never let logging itself be the thing that throws */ }
  }

  function log(source, message) {
    forward(source, message);
  }

  // Ask the core once up front, so we can skip IPC entirely when logging is off.
  function init() {
    if (ready) return Promise.resolve(enabled);
    ready = true;
    let probe;
    try {
      probe = FSBridge.invoke('bridge_log_path');
    } catch (_e) {
      return Promise.resolve(false);
    }
    return Promise.resolve(probe).then(function (info) {
      enabled = !!(info && info.enabled);
      if (enabled) {
        installErrorHooks();
        log('js', 'frontend diaglog attached; core log at ' + (info.path || '?'));
      }
      return enabled;
    }).catch(function () { return false; });
  }

  function installErrorHooks() {
    window.addEventListener('error', function (e) {
      const where = e.filename ? (' @ ' + e.filename + ':' + e.lineno + ':' + e.colno) : '';
      log('js-error', (e.message || 'error') + where);
    });
    window.addEventListener('unhandledrejection', function (e) {
      const reason = e.reason && e.reason.stack ? e.reason.stack : (e.reason || 'unhandledrejection');
      log('js-reject', String(reason));
    });
  }

  return {
    init: init,
    log: log,
    isEnabled: function () { return enabled; }
  };
})();
