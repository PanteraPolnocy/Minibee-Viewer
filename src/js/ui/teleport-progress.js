/**
 * Full-screen teleport lock. While a teleport is running, a centered modal
 * with a progress bar covers the UI, and its backdrop blocks interaction
 * underneath. It opens on teleport start/progress and closes on finish,
 * failure, or disconnect, with a safety timeout so the screen can never stay
 * locked forever.
 */
const FSTeleportProgress = (function () {
  'use strict';

  const MAX_MS = 120000; // mirrors the sim's teleport timeout; lets the lock release itself
  const STAGE = { requesting: 8, request: 8, starting: 25, start: 25, teleporting: 55, arriving: 92, arrive: 92 };

  let timeoutTimer = null;
  let closeTimer = null;

  function el(id) { return document.getElementById(id); }

  function humanize(message) {
    const key = String(message || '').toLowerCase();
    if (!key || key.indexOf('request') >= 0) return 'Requesting teleport…';
    if (key.indexOf('start') >= 0) return 'Starting teleport…';
    if (key.indexOf('arriv') >= 0) return 'Arriving…';
    // Anything else the sim reports (e.g. "resolving", "downloading") passes straight through.
    return message.charAt(0).toUpperCase() + message.slice(1) + '…';
  }

  function percentFor(message) {
    const key = String(message || '').toLowerCase();
    if (STAGE[key] !== undefined) return STAGE[key];
    if (key.indexOf('request') >= 0) return 8;
    if (key.indexOf('start') >= 0) return 25;
    if (key.indexOf('arriv') >= 0) return 92;
    return 55;
  }

  function setProgress(message, pct) {
    const bar = el('teleport-progress-bar');
    const label = el('teleport-progress-label');
    if (bar) bar.style.width = (pct !== undefined ? pct : percentFor(message)) + '%';
    if (label) label.textContent = humanize(message);
  }

  function open(message) {
    const dialog = el('teleport-progress-dialog');
    if (!dialog) return;
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    setProgress(message);
    if (!dialog.open && typeof dialog.showModal === 'function') {
      try { dialog.showModal(); } catch (_e) { /* already open, so ignore */ }
    }
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(close, MAX_MS);
  }

  function finish() {
    const dialog = el('teleport-progress-dialog');
    if (!dialog || !dialog.open) { close(); return; }
    setProgress('arriving', 100);
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(close, 450);
  }

  function close() {
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    const dialog = el('teleport-progress-dialog');
    if (dialog && dialog.open) FSUtils.dismissDialog(dialog);
  }

  function init() {
    const dialog = el('teleport-progress-dialog');
    // Hold the lock open: Escape must not dismiss it - only finish, failure, or the timeout should.
    if (dialog) dialog.addEventListener('cancel', function (e) { e.preventDefault(); });

    if (typeof FSTransport === 'undefined') return;
    FSTransport.on('teleport-started', function () { open('starting'); });
    FSTransport.on('teleport-progress', function (data) { open(data && data.message); });
    FSTransport.on('teleport-finish', finish);
    FSTransport.on('teleport-failed', close);
    FSTransport.on('teleport-cancelled', close);
    FSTransport.on('session-lost', close);
    FSTransport.on('disconnected', close);
    if (typeof FSState !== 'undefined' && FSState.on) FSState.on('reset', close);
  }

  return {
    init: init,
    begin: open,
    finish: finish,
    close: close
  };
})();
