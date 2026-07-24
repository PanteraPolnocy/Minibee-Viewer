/**
 * Degraded-capabilities banner (view only).
 *
 * The Rust core is the one that decides a region's capabilities or EventQueue
 * came up degraded; it hands us the finished assessment - human-readable title
 * and detail included - on `caps-status`. This module diagnoses nothing on its
 * own. It just paints whatever the core reports and wires up the Dismiss and
 * Relog buttons. An `ok: true` status clears the banner, for instance after a
 * clean relog or once we cross into a healthy region.
 */
const FSCapsBanner = (function () {
  'use strict';

  let userDismissed = false;

  function el() {
    return document.getElementById('caps-banner');
  }

  function hide() {
    const banner = el();
    if (banner) banner.hidden = true;
  }

  function update(status) {
    const banner = el();
    if (!banner || !status) return;

    if (status.ok) {
      userDismissed = false; // healthy again, so let any later failure show afresh
      hide();
      return;
    }
    // Once the user dismisses it, honor that until the situation actually changes.
    if (userDismissed) return;

    const titleEl = document.getElementById('caps-banner-title');
    const detailEl = document.getElementById('caps-banner-detail');
    if (titleEl) titleEl.textContent = status.title || 'Some region features unavailable';
    if (detailEl) detailEl.textContent = status.detail || '';
    banner.hidden = false;
  }

  function init() {
    const dismiss = document.getElementById('caps-banner-dismiss');
    if (dismiss) {
      dismiss.addEventListener('click', function () {
        userDismissed = true;
        hide();
      });
    }
    const relog = document.getElementById('caps-banner-relog');
    if (relog) {
      relog.addEventListener('click', function () {
        if (window.FSApp) window.FSApp.logout({ skipConfirm: true });
      });
    }
    // Clear on logout or reset so a fresh session never inherits a stale banner.
    if (typeof FSState !== 'undefined' && FSState.on) {
      FSState.on('reset', function () {
        userDismissed = false;
        hide();
      });
    }
  }

  return { init: init, update: update, hide: hide };
})();
