/**
 * Block file:// — Minibee must be served over HTTP(S).
 */
(function () {
  'use strict';

  if (location.protocol !== 'file:') return;

  document.documentElement.classList.add('require-http');
  window.MINIBEE_BLOCKED = true;
})();
