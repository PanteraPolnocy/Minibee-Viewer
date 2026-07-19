/**
 * Per-panel loading overlay for lazy-loaded tab content.
 */
const FSPanelBusy = (function () {
  'use strict';

  function resolvePanel(panelOrId) {
    if (!panelOrId) return null;
    if (typeof panelOrId === 'string') {
      return document.getElementById(panelOrId);
    }
    return panelOrId;
  }

  function ensureOverlay(panel) {
    let overlay = panel.querySelector('.panel-busy');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.className = 'panel-busy';
    overlay.hidden = true;
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML =
      '<div class="panel-busy__card">' +
        '<p class="panel-busy__text"></p>' +
      '</div>';
    panel.appendChild(overlay);
    return overlay;
  }

  function show(panelOrId, message) {
    const panel = resolvePanel(panelOrId);
    if (!panel) return;
    panel.classList.add('panel--busy-host');
    const overlay = ensureOverlay(panel);
    const text = overlay.querySelector('.panel-busy__text');
    if (text) {
      text.textContent = message || 'Loading, please wait...';
    }
    overlay.hidden = false;
  }

  function hide(panelOrId) {
    const panel = resolvePanel(panelOrId);
    if (!panel) return;
    const overlay = panel.querySelector('.panel-busy');
    if (overlay) overlay.hidden = true;
  }

  function run(panelOrId, message, work) {
    show(panelOrId, message);
    return Promise.resolve()
      .then(work)
      .finally(function () {
        hide(panelOrId);
      });
  }

  return { show: show, hide: hide, run: run };
})();
