/**
 * Settings tab: interactive viewer preferences, plus About / License / README.
 *
 * Every preference control wires straight into BeeSettings, so a change made here
 * ripples out across the rest of the viewer (BeeSettings.set fires its listeners
 * and patches BeeState). The About / License / README text comes from the Rust
 * core (app_about / app_license / app_readme / app_help / app_privacy), fetched lazily
 */
const BeeSettingsUI = (function () {
  'use strict';

  const DEFAULT_TAB = 'prefs';
  const PANES = {
    prefs: 'settings-pane-prefs',
    about: 'settings-pane-about',
    packages: 'settings-pane-packages',
    help: 'settings-pane-help',
    privacy: 'settings-pane-privacy',
    readme: 'settings-pane-readme',
    license: 'settings-pane-license'
  };

  // Interactive preference controls, grouped for display. Numeric bounds and
  // steps come from BeeSettings.SCHEMA, so this list stays in sync with the schema.
  const GROUPS = [
    { section: 'Appearance', items: [
      { key: 'theme', label: 'Theme', kind: 'select',
        options: [['dark', 'Dark'], ['light', 'Light']] }
    ] },
    { section: 'Connection', items: [
      { key: 'autoReconnect', label: 'Auto-reconnect after disconnect', kind: 'toggle' }
    ] },
    { section: 'Avatar', items: [
      { key: 'autoSitAfterLogin', label: 'Sit on the ground after logging in', kind: 'toggle' }
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
    { section: 'Voice', items: [
      { key: 'voiceEnabled', label: 'Voice chat (experimental)', kind: 'toggle' },
      { key: 'voiceVolume', label: 'Volume', kind: 'range', unit: '%' },
      { key: 'voiceMicVolume', label: 'Microphone volume', kind: 'range', unit: '%' },
      { key: 'voiceMicDevice', label: 'Microphone', kind: 'select', missingLabel: 'Saved microphone (unavailable)',
        optionsFn: function () {
          return (typeof window.BeeVoice !== 'undefined' && window.BeeVoice)
            ? window.BeeVoice.listDevices('audioinput')
            : Promise.resolve([['', 'System default']]);
        } },
      { key: 'voiceOutputDevice', label: 'Output device', kind: 'select', missingLabel: 'Saved output (unavailable)',
        optionsFn: function () {
          return (typeof window.BeeVoice !== 'undefined' && window.BeeVoice)
            ? window.BeeVoice.listDevices('audiooutput')
            : Promise.resolve([['', 'System default']]);
        } }
    ] },
    { section: 'Chat logs', items: [
      { key: 'chatLogsAvatars', label: 'Keep IM logs (people)', kind: 'toggle' },
      { key: 'chatLogsGroups', label: 'Keep IM logs (groups and conferences)', kind: 'toggle' },
      { key: 'chatLogsLocal', label: 'Keep nearby chat log', kind: 'toggle' }
    ] },
    { section: 'Parcel music', items: [
      { key: 'parcelMusicEnabled', label: 'Auto-play stream', kind: 'toggle' },
      { key: 'parcelMusicVolume', label: 'Volume', kind: 'range', unit: '%' }
    ] },
    { section: 'Interact', items: [
      { key: 'objectsRange', label: 'Nearby objects range', kind: 'select',
        options: [['16', '16 m'], ['32', '32 m'], ['48', '48 m'], ['64', '64 m'],
          ['96', '96 m'], ['128', '128 m'], ['256', '256 m'], ['384', '384 m']] },
      { key: 'objectsIncludeAttachments', label: 'Include attachments', kind: 'toggle' },
      { key: 'objectsIncludePhysical', label: 'Include physical', kind: 'toggle' }
    ] }
  ];

  let activeTab = DEFAULT_TAB;
  const loaded = { about: false, help: false, license: false, readme: false, privacy: false };
  const rendered = {}; // per-control state, keyed by setting: { item, input, valueEl }
  let aboutInfo = null; // cached app_about payload, kept around for the Copy-all button
  let memTimer = null;  // refreshes the memory figure every 5s while About is open

  function invoke(cmd) {
    if (typeof BeeBridge === 'undefined' || typeof BeeBridge.invoke !== 'function') {
      return Promise.reject(new Error('Native bridge unavailable'));
    }
    return BeeBridge.invoke(cmd);
  }

  function openExternal(url) {
    const raw = String(url || '').trim();
    if (!raw) return;
    if (typeof BeeSlurl !== 'undefined' && typeof BeeSlurl.openExternalUrl === 'function') {
      BeeSlurl.openExternalUrl(raw);
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
    return (typeof BeeSettings !== 'undefined' && BeeSettings.SCHEMA && BeeSettings.SCHEMA[key]) || {};
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
    const current = BeeSettings.get(item.key);

    if (item.kind === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.className = 'settings-control__toggle';
      input.checked = !!current;
      input.addEventListener('change', function () {
        BeeSettings.set(item.key, input.checked);
      });
      row.appendChild(label);
      row.appendChild(input);
      rendered[item.key] = { item: item, input: input, valueEl: null };
    } else if (item.kind === 'select') {
      const select = document.createElement('select');
      select.id = id;
      select.className = 'settings-control__select';
      const fill = function (options) {
        select.innerHTML = '';
        (options || []).forEach(function (opt) {
          const o = document.createElement('option');
          o.value = opt[0];
          o.textContent = opt[1];
          select.appendChild(o);
        });
        // A stored value the list doesn't know (an unplugged device) still
        // shows up, so the user can see and change it.
        if (current !== undefined && !Array.from(select.options).some(function (o) { return o.value === String(current); })) {
          const o = document.createElement('option');
          o.value = String(current);
          o.textContent = item.missingLabel || 'Saved choice (unavailable)';
          select.appendChild(o);
        }
        select.value = String(current);
      };
      if (item.optionsFn) {
        fill([['', 'Loading...']]);
        Promise.resolve(item.optionsFn()).then(fill).catch(function () { fill([['', 'System default']]); });
      } else {
        fill(item.options);
      }
      select.addEventListener('change', function () {
        BeeSettings.set(item.key, select.value);
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
        BeeSettings.set(item.key, input.value);
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
    if (!root || typeof BeeSettings === 'undefined') return;
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
    if (!entry || typeof BeeSettings === 'undefined') return;
    const value = BeeSettings.get(key);
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
    if (typeof BeeNavigation !== 'undefined' && typeof BeeNavigation.isTabActive === 'function' &&
        !BeeNavigation.isTabActive('settings')) {
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

  function fmtLogSize(b) {
    return b >= 1024 * 1024
      ? (b / (1024 * 1024)).toFixed(1) + ' MB'
      : Math.max(1, Math.round(b / 1024)) + ' KB';
  }

  // --- Log manager: list and delete the chat log files -----------------------

  const LOG_KIND_LABELS = {
    local: 'Nearby chat',
    avatars: 'IM logs (people)',
    groups: 'Group and conference logs'
  };

  function openLogManager() {
    const d = document.getElementById('log-manager-dialog') as HTMLDialogElement | null;
    if (!d || typeof d.showModal !== 'function') return;
    void renderLogManager();
    if (!d.open) d.showModal();
  }

  async function deleteLogs(agent, kind, name, what) {
    const ok = await BeeUtils.confirm({
      title: 'Delete log files?',
      message: 'Delete ' + what + '? The text files are removed from this device permanently.',
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    try {
      await BeeBridge.invoke('chat_log_delete', { agent: agent || '', kind: kind, name: name || null });
      BeeUtils.showToast('Deleted.', 'success');
    } catch (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || 'Could not delete the log.', 'error');
    }
    void renderLogManager();
    updateChatLogUsage();
  }

  // Section titles for the log manager: the resolved avatar name when the
  // cache knows it, the raw account id otherwise.
  function accountLabel(agent, me) {
    if (!agent) return 'Older shared logs';
    let label = '';
    if (typeof BeeTransport !== 'undefined' && BeeTransport.getCachedNameInfo) {
      const info = BeeTransport.getCachedNameInfo(agent);
      label = (info && (info.displayName || info.label || info.userName)) || '';
    }
    if (!label && typeof BeeTransport !== 'undefined' && BeeTransport.queueNameResolve && BeeState.gridOnline()) {
      BeeTransport.queueNameResolve(agent); // a names-updated event re-renders
    }
    if (agent === me) return label ? label + ' (this account)' : 'This account';
    return label || agent;
  }

  // Status lines (loading / empty / error) get a padded, muted note instead
  // of bare text flush against the dialog edge.
  function logManagerNote(list, text) {
    list.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'log-manager__empty';
    note.textContent = text;
    list.appendChild(note);
  }

  async function renderLogManager() {
    const list = document.getElementById('log-manager-list');
    if (!list) return;
    logManagerNote(list, 'Loading...');
    let logs = [];
    try {
      const res = await BeeBridge.invoke('chat_log_list');
      logs = (res && res.logs) || [];
    } catch (_e) {
      logManagerNote(list, 'The log list is unavailable.');
      return;
    }
    list.innerHTML = '';
    if (!logs.length) {
      logManagerNote(list, 'No log files on this device.');
      return;
    }
    // One section per account ("" marks files from before logs were split per
    // account): the logged-in account first, the shared leftovers last.
    const me = String((BeeState.get().agent || {}).id || '').toLowerCase();
    const agents = [];
    logs.forEach(function (l) {
      const a = String(l.agent || '');
      if (agents.indexOf(a) === -1) agents.push(a);
    });
    agents.sort(function (a, b) {
      const rank = function (x) { return x === me ? 0 : (x === '' ? 2 : 1); };
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    agents.forEach(function (agent) {
      const mine = logs.filter(function (l) { return String(l.agent || '') === agent; });
      if (agents.length > 1) {
        const acc = document.createElement('div');
        acc.className = 'log-manager__account';
        acc.textContent = accountLabel(agent, me);
        list.appendChild(acc);
      }
      renderLogKinds(list, agent, mine);
    });
  }

  function renderLogKinds(list, agent, logs) {
    Object.keys(LOG_KIND_LABELS).forEach(function (kind) {
      const rows = logs.filter(function (l) { return l.kind === kind; });
      if (!rows.length) return;
      const head = document.createElement('div');
      head.className = 'log-manager__head';
      const title = document.createElement('span');
      title.className = 'log-manager__kind';
      title.textContent = LOG_KIND_LABELS[kind] + ' (' + rows.length + ')';
      head.appendChild(title);
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'btn btn--ghost btn--sm';
      all.textContent = 'Delete all';
      all.addEventListener('click', function () {
        void deleteLogs(agent, kind, null, 'ALL ' + LOG_KIND_LABELS[kind].toLowerCase() + ' files in this section');
      });
      head.appendChild(all);
      list.appendChild(head);
      rows.forEach(function (l) {
        const row = document.createElement('div');
        row.className = 'log-manager__row';
        const name = document.createElement('span');
        name.className = 'log-manager__name';
        // Older avatar logs can carry a bare UUID as their filename (written
        // before the name resolved); show the person instead when the name
        // cache knows them, and ask it to find out when it doesn't yet.
        let display = l.name;
        const isUuidName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(l.name);
        if (isUuidName && typeof BeeTransport !== 'undefined') {
          if (kind === 'avatars') {
            const info = BeeTransport.getCachedNameInfo ? BeeTransport.getCachedNameInfo(l.name) : null;
            const resolved = info && (info.displayName || info.label || info.userName);
            if (resolved) {
              display = resolved;
            } else if (BeeTransport.queueNameResolve && BeeState.gridOnline()) {
              BeeTransport.queueNameResolve(l.name); // a names-updated event re-renders
            }
          } else if (kind === 'groups') {
            const gname = BeeTransport.getGroupName ? BeeTransport.getGroupName(l.name) : '';
            if (gname) {
              display = gname;
            } else if (BeeTransport.queueGroupNameResolve && BeeState.gridOnline()) {
              BeeTransport.queueGroupNameResolve(l.name);
            }
          }
        }
        name.textContent = display;
        name.title = l.name;
        const size = document.createElement('span');
        size.className = 'log-manager__size';
        size.textContent = fmtLogSize(Number(l.bytes) || 0);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn--ghost btn--sm';
        del.textContent = 'Delete';
        del.addEventListener('click', function () {
          void deleteLogs(agent, l.kind, l.name, 'the log for "' + l.name + '"');
        });
        row.appendChild(name);
        row.appendChild(size);
        row.appendChild(del);
        list.appendChild(row);
      });
    });
  }

  // The chat-log figure is fetched fresh on every About open: the files grow
  // while the app runs, so a one-time load would go stale.
  function updateChatLogUsage() {
    const cell = document.getElementById('about-chatlogs');
    if (!cell) return;
    if (typeof BeeTransport === 'undefined' || typeof BeeTransport.chatLogUsage !== 'function') {
      cell.textContent = '-';
      return;
    }
    cell.textContent = 'Checking...';
    BeeTransport.chatLogUsage().then(function (u) {
      if (!u || !u.ok) {
        cell.textContent = '-';
        return;
      }
      const files = Number(u.files) || 0;
      let label = 'No log files';
      if (files) {
        label = fmtLogSize(Number(u.bytes) || 0) + ' in ' + files + (files === 1 ? ' file' : ' files');
      }
      // A link into the log manager, where files can be inspected and deleted.
      cell.innerHTML = '';
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'settings-link';
      link.textContent = label;
      link.title = 'Manage and delete log files';
      link.addEventListener('click', function (e) {
        e.preventDefault();
        openLogManager();
      });
      cell.appendChild(link);
      // The folder path is spelled out (a hover tooltip is useless on touch).
      if (u.path) {
        const p = document.createElement('div');
        p.className = 'about-chatlogs__path';
        p.textContent = String(u.path);
        cell.appendChild(p);
      }
    }).catch(function () {
      cell.textContent = '-';
    });
  }

  function startMemPoll() {
    if (memTimer) return;
    memTimer = window.setInterval(updateMemory, 5000);
  }

  function stopMemPoll() {
    if (memTimer) { window.clearInterval(memTimer); memTimer = null; }
  }

  function linkCell(parent, label, url) {
    if (!parent) return;
    parent.innerHTML = '';
    if (!url) {
      parent.textContent = '-';
      return;
    }
    const link = document.createElement('a');
    link.href = url;
    link.className = 'settings-link';
    link.textContent = label || url;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      openExternal(url);
    });
    parent.appendChild(link);
  }

  function linkToSettingsTab(parent, label, tab) {
    if (!parent) return;
    parent.innerHTML = '';
    const link = document.createElement('a');
    link.href = '#';
    link.className = 'settings-link';
    link.textContent = label;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      setTab(tab);
    });
    parent.appendChild(link);
  }

  function loadAbout() {
    if (loaded.about) return;
    loaded.about = true;
    invoke('app_about').then(function (info) {
      aboutInfo = info || {};
      const data = aboutInfo;
      setText('about-name', data.name || 'Minibee Viewer');
      setText('about-catchphrase', data.catchphrase || '');
      setText('about-version', data.displayVersion || '');
      setText('about-disclaimer', data.disclaimer || '');
      setText('about-dedication', data.dedication || '');
      const contact = document.getElementById('about-contact');
      if (contact) {
        contact.innerHTML = '';
        const person = data.contact || {};
        if (person.agentId) {
          const link = document.createElement('a');
          link.href = '#';
          link.className = 'settings-link';
          link.textContent = person.label || person.agentId;
          link.title = 'Open in-world profile';
          link.addEventListener('click', function (e) {
            e.preventDefault();
            if (typeof BeeProfile !== 'undefined' && BeeProfile.openAvatar) {
              BeeProfile.openAvatar(person.agentId);
            }
          });
          contact.appendChild(link);
        } else {
          contact.textContent = '-';
        }
      }
      const support = data.support || {};
      const supportEl = document.getElementById('about-support');
      if (supportEl) {
        supportEl.innerHTML = '';
        if (support.issues) {
          linkCell(supportEl, 'GitHub Issues', support.issues);
        } else {
          supportEl.textContent = '-';
        }
        if (support.discussions) {
          if (supportEl.childNodes.length) supportEl.appendChild(document.createTextNode(' · '));
          const link = document.createElement('a');
          link.href = support.discussions;
          link.className = 'settings-link';
          link.textContent = 'Discussions';
          link.addEventListener('click', function (e) {
            e.preventDefault();
            openExternal(support.discussions);
          });
          supportEl.appendChild(link);
        }
      }
      linkToSettingsTab(document.getElementById('about-privacy'), 'Privacy policy', 'privacy');
      linkCell(document.getElementById('about-source'), 'Source code', data.sourceUrl || data.homepage);
      const b = data.build || {};
      const updateBtn = document.getElementById('about-check-update');
      if (updateBtn && typeof BeeUpdater !== 'undefined' && BeeUpdater.available) {
        BeeUpdater.available().then(function (canUpdate) {
          updateBtn.hidden = !canUpdate;
        });
      }
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

  // --- Packages tab: what this build was compiled from ------------------------

  let packages = null;

  async function fetchPackages() {
    if (packages) return packages;
    const res = await BeeBridge.invoke('app_packages');
    if (!res || !res.ok) throw new Error('unavailable');
    packages = {
      rust: res.rust || [],
      node: res.node || [],
      templateVersion: res.templateVersion || ''
    };
    return packages;
  }

  function templateCredit() {
    if (!packages) return '';
    return 'Grid messages are read and written with Linden Lab\'s message template' +
      (packages.templateVersion ? ' (version ' + packages.templateVersion + ')' : '') +
      ', bundled verbatim.';
  }

  function packagesText() {
    if (!packages) return '';
    const lines = ['Packages:', templateCredit(), ''];
    lines.push('Rust crates (' + packages.rust.length + '):');
    packages.rust.forEach(function (p) { lines.push('  ' + p.name + ' ' + p.version); });
    lines.push('');
    lines.push('Build tools (' + packages.node.length + '):');
    packages.node.forEach(function (p) { lines.push('  ' + p.name + ' ' + p.version); });
    return lines.join('\n');
  }

  async function loadPackages() {
    const el = document.getElementById('settings-packages');
    if (!el || el.dataset.ready === '1') return;
    try {
      await fetchPackages();
    } catch (_e) {
      el.textContent = 'The package list is unavailable.';
      return;
    }
    el.dataset.ready = '1';
    const note = document.getElementById('settings-packages-note');
    if (note) {
      note.textContent = templateCredit() + ' Everything below went into compiling this build of the viewer.';
    }
    el.innerHTML = '';
    const section = function (title, rows) {
      const head = document.createElement('div');
      head.className = 'packages-list__head';
      head.textContent = title + ' (' + rows.length + ')';
      el.appendChild(head);
      rows.forEach(function (p) {
        const row = document.createElement('div');
        row.className = 'packages-list__row';
        const name = document.createElement('span');
        name.className = 'packages-list__name';
        name.textContent = p.name;
        const ver = document.createElement('span');
        ver.className = 'packages-list__version';
        ver.textContent = p.version;
        row.appendChild(name);
        row.appendChild(ver);
        el.appendChild(row);
      });
    };
    section('Rust crates', packages.rust);
    section('Build tools', packages.node);
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

  async function copyAbout() {
    // The copy carries the full package list too; fetch it if the Packages
    // tab was never opened. A copy without it still beats no copy.
    try { await fetchPackages(); } catch (_e) { /* list stays absent */ }
    const d = aboutInfo || {};
    const b = d.build || {};
    const s = d.system || {};
    const display = d.displayVersion || '';
    const lines = [
      (d.name || 'Minibee Viewer') + (display ? ' ' + display : ''),
      d.channel ? ('Channel: ' + d.channel) : '',
      d.disclaimer || '',
      d.catchphrase || '',
      d.dedication || '',
      'Author: ' + (d.author || ''),
      d.homepage ? 'Homepage: ' + d.homepage : '',
      d.support && d.support.issues ? 'Support: ' + d.support.issues : '',
      'Privacy: bundled (Bee -> Privacy)',
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
    let text = lines.join('\n');
    const pk = packagesText();
    if (pk) text += '\n\n' + pk;
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
    if (target) target.textContent = 'Loading...';
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
    document.querySelectorAll<HTMLElement>('.settings-tab').forEach(function (btn) {
      const on = btn.dataset.settingsTab === activeTab;
      btn.classList.toggle('settings-tab--active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.keys(PANES).forEach(function (key) {
      const pane = document.getElementById(PANES[key]);
      if (pane) pane.hidden = key !== activeTab;
    });
    stopMemPoll();
    if (activeTab === 'about') { loadAbout(); startMemPoll(); updateChatLogUsage(); }
    else if (activeTab === 'packages') void loadPackages();
    else if (activeTab === 'help') loadDoc('help', 'app_help', 'settings-help');
    else if (activeTab === 'privacy') loadDoc('privacy', 'app_privacy', 'settings-privacy');
    else if (activeTab === 'readme') loadDoc('readme', 'app_readme', 'settings-readme');
    else if (activeTab === 'license') loadDoc('license', 'app_license', 'settings-license');
  }

  function activate() {
    // Rebuild the controls every time, in case the schema-backed values changed.
    buildControls();
    setTab(activeTab);
  }

  function init() {
    document.querySelectorAll<HTMLElement>('.settings-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setTab(btn.dataset.settingsTab || DEFAULT_TAB);
      });
    });
    const copyBtn = document.getElementById('about-copy');
    if (copyBtn) copyBtn.addEventListener('click', copyAbout);
    const logClose = document.getElementById('log-manager-close');
    if (logClose) {
      logClose.addEventListener('click', function () {
        const d = document.getElementById('log-manager-dialog') as HTMLDialogElement | null;
        if (d && d.open) BeeUtils.dismissDialog(d);
      });
    }
    // UUID-named log files resolve to people and groups asynchronously.
    if (typeof BeeTransport !== 'undefined' && BeeTransport.on) {
      const rerenderIfOpen = function () {
        const d = document.getElementById('log-manager-dialog') as HTMLDialogElement | null;
        if (d && d.open) void renderLogManager();
      };
      BeeTransport.on('names-updated', rerenderIfOpen);
      BeeTransport.on('group-names', rerenderIfOpen);
    }
    const updateBtn = document.getElementById('about-check-update');
    if (updateBtn) {
      updateBtn.addEventListener('click', function () {
        if (typeof BeeUpdater === 'undefined' || !BeeUpdater.checkManual) return;
        BeeUpdater.checkManual(document.getElementById('about-update-status'));
      });
    }
    buildControls();
    if (typeof BeeSettings !== 'undefined' && typeof BeeSettings.onChange === 'function') {
      BeeSettings.onChange(function (key) {
        syncControl(key);
      });
    }
  }

  return {
    init: init,
    activate: activate
  };
})();
