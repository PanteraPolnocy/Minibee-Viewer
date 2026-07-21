/**
 * Log / diagnostics panel with settings browser.
 */
const FSErrorsUI = (function () {
  'use strict';

  let viewedErrorCount = 0;
  let activeLogTab = 'diagnostics';

  function errorCount() {
    return FSErrors.list().filter(function (r) { return r.level === 'error'; }).length;
  }

  function markViewed() {
    viewedErrorCount = errorCount();
    updateNavBadge();
  }

  function updateNavBadge() {
    const badge = document.getElementById('badge-errors');
    if (!badge) return;
    const total = errorCount();
    const unread = FSNavigation.isTabActive('errors')
      ? 0
      : Math.max(0, total - viewedErrorCount);
    badge.hidden = unread === 0;
  }

  function setLogTab(tab) {
    activeLogTab = tab === 'settings' ? 'settings' : 'diagnostics';
    if (typeof FSSettings !== 'undefined') {
      FSSettings.set('logSubtab', activeLogTab);
    }

    document.querySelectorAll('.log-tab').forEach(function (btn) {
      const isActive = btn.dataset.logTab === activeLogTab;
      btn.classList.toggle('log-tab--active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    const diagnostics = document.getElementById('log-pane-diagnostics');
    const settings = document.getElementById('log-pane-settings');
    if (diagnostics) diagnostics.hidden = activeLogTab !== 'diagnostics';
    if (settings) settings.hidden = activeLogTab !== 'settings';

    if (activeLogTab === 'diagnostics') {
      render();
    } else {
      renderSettings();
    }
  }

  function renderSettings() {
    const root = document.getElementById('settings-list');
    if (!root || typeof FSSettings === 'undefined') return;
    root.innerHTML = '';

    FSSettings.getDisplaySections().forEach(function (section) {
      const block = document.createElement('section');
      block.className = 'settings-section';

      const title = document.createElement('h3');
      title.className = 'settings-section__title';
      title.textContent = section.title;
      block.appendChild(title);

      const list = document.createElement('dl');
      list.className = 'settings-dl';
      (section.items || []).forEach(function (item) {
        const dt = document.createElement('dt');
        dt.textContent = item.label;
        const dd = document.createElement('dd');
        dd.textContent = item.value;
        list.appendChild(dt);
        list.appendChild(dd);
      });
      block.appendChild(list);
      root.appendChild(block);
    });
  }

  function render() {
    const list = document.getElementById('errors-list');
    if (!list) return;
    const rows = FSErrors.list();
    list.innerHTML = '';
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'errors-item errors-item--empty';
      li.textContent = 'No diagnostics yet.';
      list.appendChild(li);
      markViewed();
      return;
    }
    rows.slice().reverse().forEach(function (row) {
      const li = document.createElement('li');
      li.className = 'errors-item errors-item--' + row.level;
      const time = new Date(row.timestamp);
      const stamp = time.toLocaleTimeString();
      li.innerHTML =
        '<div class="errors-item__meta">' +
          '<span class="errors-item__source">' + FSUtils.escapeHtml(row.source) + '</span>' +
          '<span class="errors-item__time">' + FSUtils.escapeHtml(stamp) + '</span>' +
        '</div>' +
        '<div class="errors-item__text">' + FSUtils.escapeHtml(row.text) + '</div>';
      list.appendChild(li);
    });
    markViewed();
  }

  function activate() {
    if (typeof FSSettings !== 'undefined') {
      activeLogTab = FSSettings.get('logSubtab') === 'settings' ? 'settings' : 'diagnostics';
    }
    setLogTab(activeLogTab);
  }

  function init() {
    const clearBtn = document.getElementById('errors-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        FSErrors.clear();
        viewedErrorCount = 0;
        render();
      });
    }

    const recordToggle = document.getElementById('errors-record-toggle');
    if (recordToggle && typeof FSSettings !== 'undefined') {
      recordToggle.checked = !!FSSettings.get('debugLogDiagnostics');
      recordToggle.addEventListener('change', function () {
        FSSettings.set('debugLogDiagnostics', recordToggle.checked);
      });
      FSSettings.onChange(function (key, value) {
        if (key === 'debugLogDiagnostics') recordToggle.checked = !!value;
      });
    }

    document.querySelectorAll('.log-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setLogTab(btn.dataset.logTab || 'diagnostics');
      });
    });

    if (typeof FSSettings !== 'undefined') {
      FSSettings.onChange(function () {
        if (activeLogTab === 'settings') renderSettings();
      });
    }

    FSErrors.on(function () {
      updateNavBadge();
      if (FSNavigation.isTabActive('errors') && activeLogTab === 'diagnostics') render();
    });
    markViewed();
  }

  return {
    init: init,
    render: render,
    renderSettings: renderSettings,
    activate: activate,
    markViewed: markViewed,
    updateNavBadge: updateNavBadge
  };
})();
