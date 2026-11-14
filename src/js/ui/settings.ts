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

  const t = BeeI18n.t;

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
  // steps come from BeeSettings.SCHEMA, so this list stays in sync with the
  // schema. The table exists before the dictionary is loaded, so its wording
  // sits in functions that translate as the controls are built.
  const GROUPS = [
    { section: function () { return t('settings.sectionAppearance'); }, items: [
      // The language names stay in their own language (BeeI18n.languages),
      // so this one list is a plain array.
      { key: 'language', label: function () { return t('settings.language'); }, kind: 'select',
        options: BeeI18n.languages() },
      { key: 'theme', label: function () { return t('settings.theme'); }, kind: 'select',
        options: function () {
          return [['dark', t('settings.themeDark')], ['light', t('settings.themeLight')],
            ['system', t('settings.themeSystem')]];
        } }
    ] },
    { section: function () { return t('settings.sectionConnection'); }, items: [
      { key: 'autoReconnect', kind: 'toggle',
        label: function () { return t('settings.autoReconnect'); } },
      { key: 'dataSaver', kind: 'toggle',
        label: function () { return t('settings.dataSaver'); } }
    ] },
    { section: function () { return t('settings.sectionNotifications'); }, items: [
      { key: 'imSound', kind: 'toggle',
        label: function () { return t('settings.imSound'); } },
      { key: 'imSoundGroups', kind: 'toggle',
        label: function () { return t('settings.imSoundGroups'); } }
    ] },
    { section: function () { return t('settings.sectionNearbyChat'); }, items: [
      { key: 'chatRadarPanel', kind: 'toggle',
        label: function () { return t('settings.chatRadarPanel'); } }
    ] },
    { section: function () { return t('settings.sectionAvatar'); }, items: [
      { key: 'autoSitAfterLogin', kind: 'toggle',
        label: function () { return t('settings.autoSitAfterLogin'); } }
    ] },
    { section: function () { return t('settings.sectionRadar'); }, items: [
      { key: 'radarRange', label: function () { return t('radar.range'); }, kind: 'range', unit: 'm' },
      { key: 'radarAlerts', label: function () { return t('settings.radarAlerts'); }, kind: 'toggle' }
    ] },
    { section: function () { return t('settings.sectionBuddies'); }, items: [
      { key: 'buddiesOnlineOnly', kind: 'toggle',
        label: function () { return t('settings.buddiesOnlineOnly'); } }
    ] },
    { section: function () { return t('settings.sectionSearch'); }, items: [
      { key: 'maturity', kind: 'select',
        label: function () { return t('settings.maturity'); },
        options: function () {
          return [['general', t('settings.maturityGeneral')],
            ['moderate', t('settings.maturityModerate')],
            ['adult', t('settings.maturityAdult')]];
        } }
    ] },
    { section: function () { return t('settings.sectionDestinations'); }, items: [
      { key: 'destFeed', label: function () { return t('settings.destFeed'); }, kind: 'select',
        options: function () {
          return [['mobile', t('settings.feedMobile')], ['popular', t('settings.feedPopular')],
            ['new', t('settings.feedNew')], ['editor', t('settings.feedEditor')],
            ['events', t('settings.feedEvents')]];
        } }
    ] },
    { section: function () { return t('settings.sectionVoice'); }, items: [
      { key: 'voiceEnabled', kind: 'toggle',
        label: function () { return t('settings.voiceEnabled'); } },
      { key: 'voiceVolume', label: function () { return t('settings.volume'); }, kind: 'range', unit: '%' },
      { key: 'voiceMicVolume', kind: 'range', unit: '%',
        label: function () { return t('settings.voiceMicVolume'); } },
      { key: 'voiceReleaseMic', kind: 'toggle',
        label: function () { return t('settings.voiceReleaseMic'); } },
      { key: 'voiceMicDevice', label: function () { return t('settings.voiceMicDevice'); }, kind: 'select',
        missingLabel: function () { return t('settings.savedMicUnavailable'); },
        optionsFn: function () {
          return (typeof window.BeeVoice !== 'undefined' && window.BeeVoice)
            ? window.BeeVoice.listDevices('audioinput')
            : Promise.resolve([['', t('voice.systemDefault')]]);
        } },
      { key: 'voiceOutputDevice', kind: 'select',
        label: function () { return t('settings.voiceOutputDevice'); },
        missingLabel: function () { return t('settings.savedOutputUnavailable'); },
        optionsFn: function () {
          return (typeof window.BeeVoice !== 'undefined' && window.BeeVoice)
            ? window.BeeVoice.listDevices('audiooutput')
            : Promise.resolve([['', t('voice.systemDefault')]]);
        } }
    ] },
    { section: function () { return t('settings.sectionChatLogs'); }, items: [
      { key: 'chatLogsAvatars', kind: 'toggle',
        label: function () { return t('settings.chatLogsAvatars'); } },
      { key: 'chatLogsGroups', kind: 'toggle',
        label: function () { return t('settings.chatLogsGroups'); } },
      { key: 'chatLogsLocal', kind: 'toggle',
        label: function () { return t('settings.chatLogsLocal'); } }
    ] },
    { section: function () { return t('settings.sectionParcelMusic'); }, items: [
      { key: 'parcelMusicEnabled', kind: 'toggle',
        label: function () { return t('settings.parcelMusicEnabled'); } },
      { key: 'parcelMusicVolume', label: function () { return t('settings.volume'); }, kind: 'range', unit: '%' }
    ] },
    { section: function () { return t('settings.sectionInteract'); }, items: [
      { key: 'objectsRange', kind: 'select',
        label: function () { return t('settings.objectsRange'); },
        options: function () {
          return ['16', '32', '48', '64', '96', '128', '256', '384'].map(function (v) {
            return [v, t('units.metres', { value: v })];
          });
        } },
      { key: 'objectsIncludeAttachments', kind: 'toggle',
        label: function () { return t('interact.includeAttachments'); } },
      { key: 'objectsIncludePhysical', kind: 'toggle',
        label: function () { return t('interact.includePhysical'); } }
    ] }
  ];

  let activeTab = DEFAULT_TAB;
  const loaded = { about: false, help: false, license: false, readme: false, privacy: false };
  const rendered = {}; // per-control state, keyed by setting: { item, input, valueEl }
  let aboutInfo = null; // cached app_about payload, kept around for the Copy-all button
  let memTimer = null;  // refreshes the memory figure every 5s while About is open

  function invoke(cmd) {
    if (typeof BeeBridge === 'undefined' || typeof BeeBridge.invoke !== 'function') {
      return Promise.reject(new Error(t('updater.bridgeUnavailable')));
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
    if (item.unit === '%') return t('units.percent', { value: value });
    if (item.unit === 'm') return t('units.metres', { value: value });
    return String(value) + ' ' + item.unit;
  }

  function buildRow(item) {
    const row = document.createElement('div');
    row.className = 'settings-control';
    const id = 'set-' + item.key;
    const label = document.createElement('label');
    label.className = 'settings-control__label';
    label.textContent = item.label();
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
          o.textContent = item.missingLabel
            ? item.missingLabel()
            : t('settings.savedChoiceUnavailable');
          select.appendChild(o);
        }
        select.value = String(current);
      };
      if (item.optionsFn) {
        fill([['', t('common.loading')]]);
        Promise.resolve(item.optionsFn()).then(fill).catch(function () {
          fill([['', t('voice.systemDefault')]]);
        });
      } else {
        // A list of translated labels is a function; the language list is
        // the plain array it always was.
        fill(typeof item.options === 'function' ? item.options() : item.options);
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
      title.textContent = group.section();
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
    try { return new Date(n * 1000).toLocaleString(BeeI18n.dateLocale()); } catch (_e) { return ''; }
  }

  // "release (debug) · opt 3": the profile, then the flags that matter.
  function buildSummary(b) {
    const parts = [b.profile || t('about.profileUnknown')];
    if (b.debugAssertions) parts.push(t('about.debugAssertions'));
    if (b.optLevel) parts.push('· ' + t('about.optLevel', { level: b.optLevel }));
    return parts.join(' ');
  }

  // A byte count as a figure and its unit: GB from a gigabyte up, MB below.
  // Null when there is nothing usable.
  function bytesParts(n) {
    const b = Number(n);
    if (!Number.isFinite(b) || b <= 0) return null;
    const gb = b / (1024 * 1024 * 1024);
    if (gb >= 1) return { value: gb.toFixed(1), unit: 'GB' };
    return { value: (b / (1024 * 1024)).toFixed(0), unit: 'MB' };
  }

  function fmtBytes(n) {
    const p = bytesParts(n);
    if (!p) return '-';
    return p.unit === 'GB'
      ? t('units.gb', { value: p.value })
      : t('units.mb', { value: p.value });
  }

  function memText(used, total) {
    return t('about.memoryUsed', { used: fmtBytes(used), total: fmtBytes(total) });
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
      ? t('units.mb', { value: (b / (1024 * 1024)).toFixed(1) })
      : t('units.kb', { value: Math.max(1, Math.round(b / 1024)) });
  }

  // --- Log manager: list and delete the chat log files -----------------------

  // The kinds of log file, in the order the manager lists them.
  const LOG_KINDS = [
    { kind: 'local', label: function () { return t('logs.kindLocal'); } },
    { kind: 'avatars', label: function () { return t('logs.kindAvatars'); } },
    { kind: 'groups', label: function () { return t('logs.kindGroups'); } }
  ];

  function openLogManager() {
    const d = document.getElementById('log-manager-dialog') as HTMLDialogElement | null;
    if (!d || typeof d.showModal !== 'function') return;
    void renderLogManager();
    if (!d.open) d.showModal();
  }

  async function deleteLogs(agent, kind, name, what) {
    const ok = await BeeUtils.confirm({
      title: t('logs.deleteTitle'),
      message: t('logs.deleteMessage', { what: what }),
      confirmLabel: t('logs.delete'),
      danger: true
    });
    if (!ok) return;
    try {
      await BeeBridge.invoke('chat_log_delete', { agent: agent || '', kind: kind, name: name || null });
      BeeUtils.showToast(t('logs.deleted'), 'success');
    } catch (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || t('logs.deleteFailed'), 'error');
    }
    void renderLogManager();
    updateChatLogUsage();
  }

  // Section titles for the log manager: the resolved avatar name when the
  // cache knows it, the raw account id otherwise.
  function accountLabel(agent, me) {
    if (!agent) return t('logs.olderShared');
    let label = '';
    if (typeof BeeTransport !== 'undefined' && BeeTransport.getCachedNameInfo) {
      const info = BeeTransport.getCachedNameInfo(agent);
      label = (info && (info.displayName || info.label || info.userName)) || '';
    }
    if (!label && typeof BeeTransport !== 'undefined' && BeeTransport.queueNameResolve && BeeState.gridOnline()) {
      BeeTransport.queueNameResolve(agent); // a names-updated event re-renders
    }
    if (agent === me) {
      return label
        ? t('logs.namedThisAccount', { name: label })
        : t('logs.thisAccount');
    }
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
    logManagerNote(list, t('common.loading'));
    let logs = [];
    try {
      const res = await BeeBridge.invoke('chat_log_list');
      logs = (res && res.logs) || [];
    } catch (_e) {
      logManagerNote(list, t('logs.listUnavailable'));
      return;
    }
    list.innerHTML = '';
    if (!logs.length) {
      logManagerNote(list, t('logs.noneOnDevice'));
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
    LOG_KINDS.forEach(function (entry) {
      const kind = entry.kind;
      const rows = logs.filter(function (l) { return l.kind === kind; });
      if (!rows.length) return;
      const kindLabel = entry.label();
      const head = document.createElement('div');
      head.className = 'log-manager__head';
      const title = document.createElement('span');
      title.className = 'log-manager__kind';
      title.textContent = t('logs.kindCount', { kind: kindLabel, count: rows.length });
      head.appendChild(title);
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'btn btn--ghost btn--sm';
      all.textContent = t('logs.deleteAll');
      all.addEventListener('click', function () {
        // The section's own label, as written: lowercasing it would mangle
        // "IM" and words in other languages.
        void deleteLogs(agent, kind, null, t('logs.allInSection', { kind: kindLabel }));
      });
      head.appendChild(all);
      list.appendChild(head);
      rows.forEach(function (l) {
        const row = document.createElement('div');
        row.className = 'log-manager__row';
        const name = document.createElement('span');
        name.className = 'log-manager__name';
        // An avatar log can carry a bare UUID as its filename (written before
        // the name resolved); show the username instead when the name cache
        // knows it - files are by username, so the list reads the same way -
        // and ask it to find out when it doesn't yet.
        // The nearby-chat file has one fixed name on disk in every language;
        // it reads as the section does.
        let display = kind === 'local' ? t('logs.nearbyChatFile') : l.name;
        const isUuidName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(l.name);
        if (isUuidName && typeof BeeTransport !== 'undefined') {
          if (kind === 'avatars') {
            const info = BeeTransport.getCachedNameInfo ? BeeTransport.getCachedNameInfo(l.name) : null;
            const resolved = info && (info.userName || info.label || info.displayName);
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
        del.textContent = t('logs.delete');
        del.addEventListener('click', function () {
          void deleteLogs(agent, l.kind, l.name, t('logs.theLogFor', { name: l.name }));
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
    cell.textContent = t('updater.checking');
    BeeTransport.chatLogUsage().then(function (u) {
      if (!u || !u.ok) {
        cell.textContent = '-';
        return;
      }
      const files = Number(u.files) || 0;
      let label = t('logs.noFiles');
      if (files) {
        label = t('logs.usage', { size: fmtLogSize(Number(u.bytes) || 0), count: files });
      }
      // A link into the log manager, where files can be inspected and deleted.
      cell.innerHTML = '';
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'settings-link';
      link.textContent = label;
      link.title = t('logs.manageTitle');
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
      renderAbout(aboutInfo);
    }).catch(function () {
      loaded.about = false; // clear the flag so a later open can retry
      setText('about-catchphrase', t('about.loadFailed'));
    });
  }

  // Paint the About pane from the core's payload. The lines the core wrote
  // (edition, catchphrase, disclaimer, dedication) arrive with their keys, so
  // they follow the UI language like everything else here.
  function renderAbout(data) {
    setText('about-name', data.name || t('about.appName'));
    // The Google Play build announces itself under the name (the core
    // knows which binary this is).
    const nameEl = document.getElementById('about-name');
    const edition = BeeI18n.field(data, 'edition');
    if (nameEl && edition) {
      const span = document.createElement('span');
      span.className = 'about-name__edition';
      span.textContent = edition;
      nameEl.appendChild(span);
    }
    setText('about-catchphrase', BeeI18n.field(data, 'catchphrase'));
    setText('about-version', data.displayVersion || '');
    setText('about-disclaimer', BeeI18n.field(data, 'disclaimer'));
    setText('about-dedication', BeeI18n.field(data, 'dedication'));
    const contact = document.getElementById('about-contact');
    if (contact) {
      contact.innerHTML = '';
      const person = data.contact || {};
      if (person.agentId) {
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'settings-link';
        link.textContent = person.label || person.agentId;
        link.title = t('about.openProfile');
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
        linkCell(supportEl, t('about.githubIssues'), support.issues);
      } else {
        supportEl.textContent = '-';
      }
      if (support.discussions) {
        if (supportEl.childNodes.length) supportEl.appendChild(document.createTextNode(' · '));
        const link = document.createElement('a');
        link.href = support.discussions;
        link.className = 'settings-link';
        link.textContent = t('about.discussions');
        link.addEventListener('click', function (e) {
          e.preventDefault();
          openExternal(support.discussions);
        });
        supportEl.appendChild(link);
      }
    }
    linkToSettingsTab(document.getElementById('about-privacy'), t('about.privacyPolicy'), 'privacy');
    linkCell(document.getElementById('about-source'), t('about.sourceCode'), data.sourceUrl || data.homepage);
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
      metaRow(buildDl, t('about.build'), buildSummary(b));
      metaRow(buildDl, t('about.lto'), b.lto ? t('about.enabled') : t('about.disabled'));
      metaRow(buildDl, t('about.built'), fmtBuildDate(b.buildEpoch));
      metaRow(buildDl, t('about.compiler'), b.rustc);
      metaRow(buildDl, t('about.target'), b.target);
      if (b.host && b.host !== b.target) metaRow(buildDl, t('about.buildHost'), b.host);
    }
    const s = data.system || {};
    const sysDl = document.getElementById('about-system');
    if (sysDl) {
      sysDl.innerHTML = '';
      metaRow(sysDl, t('about.os'), s.osVersion || s.os);
      metaRow(sysDl, t('about.architecture'), s.arch);
      if (s.cpus) metaRow(sysDl, t('about.logicalCpus'), s.cpus);
      // Memory rows get stable ids so the 5s poll can update just the values in place.
      const dt = document.createElement('dt');
      dt.textContent = t('about.memory');
      const dd = document.createElement('dd');
      dd.id = 'about-mem';
      dd.textContent = memText(s.memUsed, s.memTotal);
      sysDl.appendChild(dt);
      sysDl.appendChild(dd);
      const dtp = document.createElement('dt');
      dtp.textContent = t('about.minibeeMemory');
      const ddp = document.createElement('dd');
      ddp.id = 'about-mem-proc';
      ddp.textContent = fmtBytes(s.memProcess);
      sysDl.appendChild(dtp);
      sysDl.appendChild(ddp);
    }
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
    return packages.templateVersion
      ? t('packages.templateCreditVersion', { version: packages.templateVersion })
      : t('packages.templateCredit');
  }

  // "Label: value" and "Heading:" lines of the Copy all text.
  function copyLine(label, value) {
    return t('about.copyLine', { label: label, value: value });
  }

  function copyHeading(title) {
    return t('about.copyHeading', { title: title });
  }

  function packagesText() {
    if (!packages) return '';
    const section = function (title, rows) {
      const out = [copyHeading(t('packages.sectionCount', { title: title, count: rows.length }))];
      rows.forEach(function (p) { out.push('  ' + p.name + ' ' + p.version); });
      return out;
    };
    return [copyHeading(t('settings.packages')), templateCredit(), '']
      .concat(section(t('packages.rustCrates'), packages.rust))
      .concat([''])
      .concat(section(t('packages.buildTools'), packages.node))
      .join('\n');
  }

  async function loadPackages() {
    const el = document.getElementById('settings-packages');
    if (!el || el.dataset.ready === '1') return;
    try {
      await fetchPackages();
    } catch (_e) {
      el.textContent = t('packages.unavailable');
      return;
    }
    el.dataset.ready = '1';
    renderPackages(el);
  }

  function renderPackages(el) {
    const note = document.getElementById('settings-packages-note');
    if (note) {
      note.textContent = templateCredit() + ' ' +
        t('packages.note');
    }
    el.innerHTML = '';
    const section = function (title, rows) {
      const head = document.createElement('div');
      head.className = 'packages-list__head';
      head.textContent = t('packages.sectionCount', { title: title, count: rows.length });
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
    section(t('packages.rustCrates'), packages.rust);
    section(t('packages.buildTools'), packages.node);
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

  // The clipboard gets what the About tab shows, in the same words, plus the
  // package list: the details a bug report needs.
  async function copyAbout() {
    // The copy carries the full package list too; fetch it if the Packages
    // tab was never opened. A copy without it still beats no copy.
    try { await fetchPackages(); } catch (_e) { /* list stays absent */ }
    const d = aboutInfo || {};
    const b = d.build || {};
    const s = d.system || {};
    const display = d.displayVersion || '';
    const edition = BeeI18n.field(d, 'edition');
    const lines = [
      (d.name || t('about.appName')) + (display ? ' ' + display : '') +
        (edition ? ' (' + edition + ')' : ''),
      d.channel ? copyLine(t('about.channel'), d.channel) : '',
      BeeI18n.field(d, 'disclaimer'),
      BeeI18n.field(d, 'catchphrase'),
      BeeI18n.field(d, 'dedication'),
      copyLine(t('about.author'), d.author || ''),
      d.homepage ? copyLine(t('about.homepage'), d.homepage) : '',
      d.support && d.support.issues ? copyLine(t('about.support'), d.support.issues) : '',
      copyLine(t('settings.privacy'), t('about.privacyBundled')),
      '',
      copyLine(t('about.build'), buildSummary(b)),
      copyLine(t('about.lto'), b.lto ? t('about.enabled') : t('about.disabled')),
      copyLine(t('about.built'), fmtBuildDate(b.buildEpoch)),
      copyLine(t('about.compiler'), b.rustc || ''),
      copyLine(t('about.target'), b.target || ''),
      (b.host && b.host !== b.target) ? copyLine(t('about.buildHost'), b.host) : '',
      '',
      copyLine(t('about.os'), (s.osVersion || s.os || '') + ' (' + (s.arch || '') + ')'),
      s.cpus ? copyLine(t('about.logicalCpus'), s.cpus) : '',
      (s.memTotal ? copyLine(t('about.memory'), memText(s.memUsed, s.memTotal)) : ''),
      (s.memProcess ? copyLine(t('about.minibeeMemory'), fmtBytes(s.memProcess)) : '')
    ].filter(function (l) { return l !== ''; });
    let text = lines.join('\n');
    const pk = packagesText();
    if (pk) text += '\n\n' + pk;
    const done = function (ok) {
      setText('about-copy-status', ok ? t('about.copied') : t('profile.copyFailed'));
      window.setTimeout(function () { setText('about-copy-status', ''); }, 2500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); })
        .catch(function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  // The tab's name for a document the core serves, for the failure line.
  function docLabel(name) {
    if (name === 'help') return t('settings.help');
    if (name === 'privacy') return t('settings.privacy');
    if (name === 'license') return t('settings.license');
    return 'README';
  }

  function loadDoc(name, cmd, targetId) {
    if (loaded[name]) return;
    loaded[name] = true;
    const target = document.getElementById(targetId);
    if (target) target.textContent = t('common.loading');
    invoke(cmd).then(function (result) {
      const text = result && typeof result.text === 'string' ? result.text : '';
      if (target) target.textContent = text || t('settings.noContent');
    }).catch(function () {
      loaded[name] = false; // clear the flag so the next open retries
      if (target) target.textContent = t('settings.docLoadFailed', { name: docLabel(name) });
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
    // A language switch: the controls are rebuilt in the new words, and the
    // panes painted once from data already fetched (About, Packages, the log
    // manager when it is open) are painted again from that data.
    BeeI18n.onChange(function () {
      buildControls();
      if (aboutInfo) renderAbout(aboutInfo);
      if (activeTab === 'about') updateChatLogUsage();
      const pk = document.getElementById('settings-packages');
      if (pk && pk.dataset.ready === '1' && packages) renderPackages(pk);
      const d = document.getElementById('log-manager-dialog') as HTMLDialogElement | null;
      if (d && d.open) void renderLogManager();
    });
  }

  return {
    init: init,
    activate: activate
  };
})();
