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
const BeeCapsBanner = (function () {
  'use strict';

  const t = BeeI18n.t;

  let userDismissed = false;
  let lastStatus = null; // the newest assessment, repainted on a language switch

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
    lastStatus = status;

    if (status.ok) {
      userDismissed = false; // healthy again, so let any later failure show afresh
      hide();
      return;
    }
    // Once the user dismisses it, honor that until the situation actually changes.
    if (userDismissed) return;

    // The title and detail are the core's assessment, read through their keys.
    const titleEl = document.getElementById('caps-banner-title');
    const detailEl = document.getElementById('caps-banner-detail');
    if (titleEl) titleEl.textContent = BeeI18n.field(status, 'title') || t('caps.title');
    if (detailEl) detailEl.textContent = BeeI18n.field(status, 'detail');
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
        if (window.BeeApp) window.BeeApp.logout({ skipConfirm: true });
      });
    }
    // Clear on logout or reset so a fresh session never inherits a stale banner.
    if (typeof BeeState !== 'undefined' && BeeState.on) {
      BeeState.on('reset', function () {
        userDismissed = false;
        lastStatus = null;
        hide();
      });
    }
    // A language switch while the banner is up: paint the same assessment again.
    BeeI18n.onChange(function () {
      if (lastStatus && !lastStatus.ok) update(lastStatus);
    });
  }

  return { init: init, update: update, hide: hide };
})();
