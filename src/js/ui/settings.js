/**
 * Settings tab: interactive viewer preferences, plus About / License / README.
 *
 * Every preference control wires straight into FSSettings, so a change made here
 * ripples out across the rest of the viewer (FSSettings.set fires its listeners
 * and patches FSState). The About / License / README text comes from the Rust
 * core (app_about / app_license / app_readme), fetched lazily - only the first
 * time each subtab is opened.
 */
const FSSettingsUI = (function () {
  'use strict';

  const DEFAULT_TAB = 'prefs';
  const PANES = {
    prefs: 'settings-pane-prefs',
    about: 'settings-pane-about',
    help: 'settings-pane-help',
    readme: 'settings-pane-readme',
    license: 'settings-pane-license'
  };

  // Interactive preference controls, grouped for display. Numeric bounds and
  // steps come from FSSettings.SCHEMA, so this list stays in sync with the schema.
  const GROUPS = [
    { section: 'Appearance', items: [
      { key: 'theme', label: 'Theme', kind: 'select',
        options: [['dark', 'Dark'], ['light', 'Light']] }
    ] },
    { section: 'Connection', items: [
      { key: 'autoReconnect', label: 'Auto-reconnect after disconnect', kind: 'toggle' }
    ] },
    { section: 'Radar', items: [
      { key: 'radarRange', label: 'Range', kind: 'range', unit: 'm' },
      { key: 'radarAlerts', label: 'Proximity alerts', kind: 'toggle' }
    ] },
    { section: 'Buddies', items: [
      { key: 'buddiesOnlineOnly', label: 'Show online friends only', kind: 'toggle' }
    ] },
    { section: 'Destination guide', items: [
      { key: 'destFeed', label: 'Default feed', kind: 'select',
        options: [['mobile', 'Mobile'], ['popular', 'Popular'], ['new', 'New'],
          ['editor', 'Editor'], ['events', 'Events']] }
    ] },
    { section: 'Parcel music', items: [
      { key: 'parcelMusicEnabled', label: 'Auto-play stream', kind: 'toggle' },
      { key: 'parcelMusicVolume', label: 'Volume', kind: 'range', unit: '%' }
    ] }
  ];

  let activeTab = DEFAULT_TAB;
  const loaded = { about: false, help: false, license: false, readme: false };
  const rendered = {}; // per-control state, keyed by setting: { item, input, valueEl }
  let aboutInfo = null; // cached app_about payload, kept around for the Copy-all button
  let memTimer = null;  // refreshes the memory figure every 5s while About is open

  function invoke(cmd) {
    if (typeof FSBridge === 'undefined' || typeof FSBridge.invoke !== 'function') {
      return Promise.reject(new Error('Native bridge unavailable'));
    }
    return FSBridge.invoke(cmd);
  }

  function openExternal(url) {
    const raw = String(url || '').trim();
    if (!raw) return;
    if (typeof FSSlurl !== 'undefined' && typeof FSSlurl.openExternalUrl === 'function') {
      FSSlurl.openExternalUrl(raw);
      return;
    }
    try {
      if (window.__TAURI__ && window.__TAURI__.opener &&
          typeof window.__TAURI__.opener.openUrl === 'function') {
        window.__TAURI__.opener.openUrl(raw);
        return;
      }
    } catch (_e) { /* fall through to window.open */ }
    window.open(raw, '_blank', 'noopener,noreferrer');
  }

  // --- Preference controls ---------------------------------------------------

  function schemaOf(key) {
    return (typeof FSSettings !== 'undefined' && FSSettings.SCHEMA && FSSettings.SCHEMA[key]) || {};
  }

  function formatValue(item, value) {
    if (!item.unit) return String(value);
    return item.unit === '%' ? String(value) + '%' : String(value) + ' ' + item.unit;
  }

  function buildRow(item) {
    const row = document.createElement('div');
    row.className = 'settings-control';
    const id = 'set-' + item.key;
    const label = document.createElement('label');
    label.className = 'settings-control__label';
    label.textContent = item.label;
    label.setAttribute('for', id);
    const current = FSSettings.get(item.key);

    if (item.kind === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.className = 'settings-control__toggle';
      input.checked = !!current;
      input.addEventListener('change', function () {
        FSSettings.set(item.key, input.checked);
      });
      row.appendChild(label);
      row.appendChild(input);
      rendered[item.key] = { item: item, input: input, valueEl: null };
    } else if (item.kind === 'select') {
      const select = document.createElement('select');
      select.id = id;
      select.className = 'settings-control__select';
      (item.options || []).forEach(function (opt) {
        const o = document.createElement('option');
        o.value = opt[0];
        o.textContent = opt[1];
        select.appendChild(o);
      });
      select.value = String(current);
      select.addEventListener('change', function () {
        FSSettings.set(item.key, select.value);
      });
      row.appendChild(label);
      row.appendChild(select);
      rendered[item.key] = { item: item, input: select, valueEl: null };
    } else if (item.kind === 'range') {
      const spec = schemaOf(item.key);
      const input = document.createElement('input');
      input.type = 'range';
      input.id = id;
      input.className = 'settings-control__range';
      if (spec.min !== undefined) input.min = String(spec.min);
      if (spec.max !== undefined) input.max = String(spec.max);
      if (spec.step !== undefined) input.step = String(spec.step);
      input.value = String(current);
      const valueEl = document.createElement('span');
      valueEl.className = 'settings-control__value';
      valueEl.textContent = formatValue(item, current);
      input.addEventListener('input', function () {
        valueEl.textContent = formatValue(item, input.value);
        FSSettings.set(item.key, input.value);
      });
      const head = document.createElement('div');
      head.className = 'settings-control__head';
      head.appendChild(label);
      head.appendChild(valueEl);
      row.classList.add('settings-control--stacked');
      row.appendChild(head);
      row.appendChild(input);
      rendered[item.key] = { item: item, input: input, valueEl: valueEl };
    }
    return row;
  }

  function buildControls() {
    const root = document.getElementById('settings-controls');
    if (!root || typeof FSSettings === 'undefined') return;
    root.innerHTML = '';
    Object.keys(rendered).forEach(function (k) { delete rendered[k]; });
    GROUPS.forEach(function (group) {
      const section = document.createElement('section');
      section.className = 'settings-group';
      const title = document.createElement('h3');
      title.className = 'settings-group__title';
      title.textContent = group.section;
      section.appendChild(title);
      group.items.forEach(function (item) {
        if (schemaOf(item.key)) section.appendChild(buildRow(item));
      });
      root.appendChild(section);
    });
  }

  // Mirror an external settings change (e.g. the top-bar theme toggle, or the
  // radar tab's own range control) back into our own controls.
  function syncControl(key) {
    const entry = rendered[key];
    if (!entry || typeof FSSettings === 'undefined') return;
    const value = FSSettings.get(key);
    const el = entry.input;
    if (el.type === 'checkbox') {
      if (el.checked !== !!value) el.checked = !!value;
    } else if (String(el.value) !== String(value)) {
      el.value = String(value);
      if (entry.valueEl) entry.valueEl.textContent = formatValue(entry.item, value);
    }
  }

  // --- About / License / README ---------------------------------------------

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function metaRow(dl, label, value) {
    if (value === undefined || value === null || value === '') return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function fmtBuildDate(epoch) {
    const n = Number(epoch);
    if (!Number.isFinite(n) || n <= 0) return '';
    try { return new Date(n * 1000).toLocaleString(); } catch (_e) { return ''; }
  }

  function buildSummary(b) {
    return (b.profile || 'unknown') + (b.debugAssertions ? ' (debug)' : '') +
      (b.optLevel ? ' · opt ' + b.optLevel : '');
  }

  function fmtBytes(n) {
    const b = Number(n);
    if (!Number.isFinite(b) || b <= 0) return '-';
    const gb = b / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(1) + ' GB';
    return (b / (1024 * 1024)).toFixed(0) + ' MB';
  }

  function memText(used, total) {
    return fmtBytes(used) + ' / ' + fmtBytes(total) + ' used';
  }

  // Refresh the used-memory figure every 5s while the About tab is open, and
  // quietly stop once the user has navigated away from the Settings tab.
  function updateMemory() {
    if (typeof FSNavigation !== 'undefined' && typeof FSNavigation.isTabActive === 'function' &&
        !FSNavigation.isTabActive('settings')) {
      stopMemPoll();
      return;
    }
    invoke('app_memory').then(function (m) {
      if (!m) return;
      const cell = document.getElementById('about-mem');
      if (cell) cell.textContent = memText(m.used, m.total);
      const pcell = document.getElementById('about-mem-proc');
      if (pcell) pcell.textContent = fmtBytes(m.process);
    }).catch(function () {});
  }

  function startMemPoll() {
    if (memTimer) return;
    memTimer = window.setInterval(updateMemory, 5000);
  }

  function stopMemPoll() {
    if (memTimer) { window.clearInterval(memTimer); memTimer = null; }
  }

  function loadAbout() {
    if (loaded.about) return;
    loaded.about = true;
    invoke('app_about').then(function (info) {
      aboutInfo = info || {};
      const data = aboutInfo;
      setText('about-name', data.name || 'Minibee Viewer');
      setText('about-version', data.version ? ('Version ' + data.version) : '');
      setText('about-catchphrase', data.catchphrase || '');
      setText('about-author', data.author || 'Unknown');
      const contact = document.getElementById('about-contact');
      if (contact) {
        contact.innerHTML = '';
        if (data.homepage) {
          const link = document.createElement('a');
          link.href = data.homepage;
          link.className = 'settings-link';
          link.textContent = data.homepage;
          link.addEventListener('click', function (e) {
            e.preventDefault();
            openExternal(data.homepage);
          });
          contact.appendChild(link);
        } else {
          contact.textContent = '-';
        }
      }
      const b = data.build || {};
      const buildDl = document.getElementById('about-build');
      if (buildDl) {
        buildDl.innerHTML = '';
        metaRow(buildDl, 'Build', buildSummary(b));
        metaRow(buildDl, 'LTO', b.lto ? 'Enabled' : 'Disabled');
        metaRow(buildDl, 'Built', fmtBuildDate(b.buildEpoch));
        metaRow(buildDl, 'Compiler', b.rustc);
        metaRow(buildDl, 'Target', b.target);
        if (b.host && b.host !== b.target) metaRow(buildDl, 'Build host', b.host);
      }
      const s = data.system || {};
      const sysDl = document.getElementById('about-system');
      if (sysDl) {
        sysDl.innerHTML = '';
        metaRow(sysDl, 'OS', s.osVersion || s.os);
        metaRow(sysDl, 'Architecture', s.arch);
        if (s.cpus) metaRow(sysDl, 'Logical CPUs', s.cpus);
        // Memory rows get stable ids so the 5s poll can update just the values in place.
        const dt = document.createElement('dt');
        dt.textContent = 'Memory';
        const dd = document.createElement('dd');
        dd.id = 'about-mem';
        dd.textContent = memText(s.memUsed, s.memTotal);
        sysDl.appendChild(dt);
        sysDl.appendChild(dd);
        const dtp = document.createElement('dt');
        dtp.textContent = 'Minibee memory';
        const ddp = document.createElement('dd');
        ddp.id = 'about-mem-proc';
        ddp.textContent = fmtBytes(s.memProcess);
        sysDl.appendChild(dtp);
        sysDl.appendChild(ddp);
      }
    }).catch(function () {
      loaded.about = false; // clear the flag so a later open can retry
      setText('about-catchphrase', 'Could not load application info.');
    });
  }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(!!ok);
    } catch (_e) { done(false); }
  }

  function copyAbout() {
    const d = aboutInfo || {};
    const b = d.build || {};
    const s = d.system || {};
    const lines = [
      (d.name || 'Minibee Viewer') + (d.version ? ' ' + d.version : ''),
      d.catchphrase || '',
      'Author: ' + (d.author || ''),
      d.homepage ? 'Homepage: ' + d.homepage : '',
      '',
      'Build: ' + buildSummary(b),
      'LTO: ' + (b.lto ? 'Enabled' : 'Disabled'),
      'Built: ' + fmtBuildDate(b.buildEpoch),
      'Compiler: ' + (b.rustc || ''),
      'Target: ' + (b.target || ''),
      (b.host && b.host !== b.target) ? 'Build host: ' + b.host : '',
      '',
      'OS: ' + (s.osVersion || s.os || '') + ' (' + (s.arch || '') + ')',
      s.cpus ? 'Logical CPUs: ' + s.cpus : '',
      (s.memTotal ? 'Memory: ' + memText(s.memUsed, s.memTotal) : ''),
      (s.memProcess ? 'Minibee memory: ' + fmtBytes(s.memProcess) : '')
    ].filter(function (l) { return l !== ''; });
    const text = lines.join('\n');
    const done = function (ok) {
      setText('about-copy-status', ok ? 'Copied!' : 'Copy failed');
      window.setTimeout(function () { setText('about-copy-status', ''); }, 2500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); })
        .catch(function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function loadDoc(name, cmd, targetId) {
    if (loaded[name]) return;
    loaded[name] = true;
    const target = document.getElementById(targetId);
    if (target) target.textContent = 'Loading…';
    invoke(cmd).then(function (result) {
      const text = result && typeof result.text === 'string' ? result.text : '';
      if (target) target.textContent = text || 'No content.';
    }).catch(function () {
      loaded[name] = false; // clear the flag so the next open retries
      if (target) target.textContent = 'Could not load ' + name + '.';
    });
  }

  // --- Subtabs ---------------------------------------------------------------

  function setTab(tab) {
    activeTab = PANES[tab] ? tab : DEFAULT_TAB;
    document.querySelectorAll('.settings-tab').forEach(function (btn) {
      const on = btn.dataset.settingsTab === activeTab;
      btn.classList.toggle('settings-tab--active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.keys(PANES).forEach(function (key) {
      const pane = document.getElementById(PANES[key]);
      if (pane) pane.hidden = key !== activeTab;
    });
    stopMemPoll();
    if (activeTab === 'about') { loadAbout(); startMemPoll(); }
    else if (activeTab === 'help') loadDoc('help', 'app_help', 'settings-help');
    else if (activeTab === 'readme') loadDoc('readme', 'app_readme', 'settings-readme');
    else if (activeTab === 'license') loadDoc('license', 'app_license', 'settings-license');
  }

  function activate() {
    // Rebuild the controls every time, in case the schema-backed values changed.
    buildControls();
    setTab(activeTab);
  }

  function init() {
    document.querySelectorAll('.settings-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setTab(btn.dataset.settingsTab || DEFAULT_TAB);
      });
    });
    const copyBtn = document.getElementById('about-copy');
    if (copyBtn) copyBtn.addEventListener('click', copyAbout);
    buildControls();
    if (typeof FSSettings !== 'undefined' && typeof FSSettings.onChange === 'function') {
      FSSettings.onChange(function (key) {
        syncControl(key);
      });
    }
  }

  return {
    init: init,
    activate: activate
  };
})();
