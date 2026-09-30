/**
 * Radar - the nearby-avatar list, built from CoarseLocationUpdate.
 */
const BeeRadar = (function () {
  'use strict';

  let filter = '';
  let renderScheduled = false;
  let sidebarRenderScheduled = false;

  // The optional "nearby people" strip beside the Nearby chat transcript
  // (setting chatRadarPanel). Wide screens only: this is the same breakpoint
  // app.css uses to hide .chat-radar and its composer toggle.
  const SIDEBAR_QUERY = '(min-width: 900px)';

  // CoarseLocationUpdate gives us only an id per nearby avatar; the names
  // resolve asynchronously (names-updated), so prefer a resolved name when
  // one is cached.
  function nameLines(agent) {
    const info = agent && agent.id && typeof BeeTransport.getCachedNameInfo === 'function'
      ? BeeTransport.getCachedNameInfo(agent.id)
      : null;
    if (info && (info.userName || info.label || info.displayName)) {
      return BeeUtils.agentNameLines({
        displayName: info.displayName || '',
        userName: info.userName || info.label || '',
        name: info.label || (agent && agent.name) || ''
      });
    }
    return BeeUtils.agentNameLines(agent);
  }

  // Turn a born-on date into a compact account age, e.g. "12d", "5mo", "3y".
  function compactAge(bornOn) {
    if (!bornOn) return '';
    const d = bornOn instanceof Date ? bornOn : new Date(bornOn);
    if (Number.isNaN(d.getTime())) return '';
    const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
    if (days < 60) return days + 'd';
    if (days < 730) return Math.floor(days / 30) + 'mo';
    return Math.floor(days / 365) + 'y';
  }

  // Age comes from each avatar's basic properties (born-on), which we fetch
  // lazily and dedupe (queueAvatarThumb -> sl_request_avatar_properties).
  // Deliberately not the extended AgentProfile cap - that stays profile-open only.
  function ageFor(entry) {
    const p = (typeof BeeProfiles !== 'undefined' && BeeProfiles.getAvatarProfile)
      ? BeeProfiles.getAvatarProfile(entry.id) : null;
    if (p && p.bornOn) return compactAge(p.bornOn);
    if (typeof BeeProfiles !== 'undefined' && BeeProfiles.queueAvatarThumb && entry.id) {
      BeeProfiles.queueAvatarThumb(entry.id); // deduped; bornOn will be ready for the next render
    }
    return (entry.age && entry.age !== '?') ? entry.age : '';
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(function () {
      renderScheduled = false;
      render();
    });
  }

  function openIm(entry) {
    const region = BeeState.get().region;
    BeeIm.startImWith({
      id: entry.id,
      name: entry.name,
      online: true,
      region: region ? region.name : ''
    });
  }

  function isAlertCandidate(entry) {
    // Coarse-location radar carries no account age, so the old age check never
    // fired; a name match is the only signal we actually have to go on here.
    const name = String(entry.name || '').toLowerCase();
    return name.indexOf('visitor') !== -1;
  }

  function iconProfile() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
  }

  // A small mic glyph for people in the voice channel: green while they
  // speak, struck out when muted for us. Null for anyone not in voice.
  function voiceGlyph(entry) {
    const voice = (typeof BeeVoice !== 'undefined' && BeeVoice.participantInfo)
      ? BeeVoice.participantInfo(entry.id) : null;
    if (!voice) return null;
    const mic = document.createElement('span');
    mic.className = 'entity-item__voice' +
      (voice.muted ? ' entity-item__voice--muted' : voice.speaking ? ' entity-item__voice--speaking' : '');
    mic.title = voice.muted ? 'Voice muted for you' : voice.speaking ? 'Speaking' : 'In voice';
    mic.textContent = voice.muted ? '\u{1F507}' : '\u{1F3A4}';
    return mic;
  }

  function renderItem(entry, options) {
    const opts = options || {};
    const names = nameLines(entry);
    const outOfRange = !!opts.outOfRange;
    const highlightAlert = !!opts.highlightAlert && !outOfRange;

    const li = document.createElement('li');
    let className = 'entity-item';
    if (highlightAlert) className += ' entity-item--alert';
    if (outOfRange) className += ' entity-item--out-of-range';
    li.className = className;
    li.dataset.id = entry.id;
    const status = entry.status ? ' [' + entry.status + ']' : '';
    const age = ageFor(entry);
    const ageText = age ? ('Age: ' + age) : 'Age: ...';

    const avatar = document.createElement('div');
    avatar.className = 'entity-item__avatar';
    avatar.dataset.agentId = String(entry.id);
    avatar.dataset.resolveImage = '0';
    avatar.dataset.label = String(names.title || '');

    const body = document.createElement('div');
    body.className = 'entity-item__body';

    const nameEl = document.createElement('div');
    nameEl.className = 'entity-item__name';
    nameEl.textContent = String(names.title || '');
    body.appendChild(nameEl);

    if (names.subtitle) {
      const legacy = document.createElement('div');
      legacy.className = 'entity-item__legacy';
      legacy.textContent = String(names.subtitle);
      body.appendChild(legacy);
    }

    const sub = document.createElement('div');
    sub.className = 'entity-item__sub';
    sub.textContent = ageText + ' · ' + String(entry.range) + 'm' + status;
    body.appendChild(sub);

    const mic = voiceGlyph(entry);
    if (mic) nameEl.appendChild(mic);

    const actions = document.createElement('div');
    actions.className = 'entity-item__actions';

    const profileBtn = document.createElement('button');
    profileBtn.type = 'button';
    profileBtn.className = 'icon-btn';
    profileBtn.dataset.action = 'profile';
    profileBtn.title = 'Profile';
    profileBtn.setAttribute('aria-label', 'Profile');
    const profileTpl = document.createElement('template');
    profileTpl.innerHTML = iconProfile();
    if (profileTpl.content.firstChild) profileBtn.appendChild(profileTpl.content.firstChild);

    const imBtn = document.createElement('button');
    imBtn.type = 'button';
    imBtn.className = 'icon-btn';
    imBtn.dataset.action = 'im';
    imBtn.title = 'Send IM';
    imBtn.setAttribute('aria-label', 'Send IM');
    const imSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    imSvg.setAttribute('viewBox', '0 0 24 24');
    imSvg.setAttribute('width', '18');
    imSvg.setAttribute('height', '18');
    const imPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    imPath.setAttribute('fill', 'currentColor');
    imPath.setAttribute('d', 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6l8 5 8-5v12z');
    imSvg.appendChild(imPath);
    imBtn.appendChild(imSvg);

    actions.appendChild(profileBtn);
    actions.appendChild(imBtn);

    const range = document.createElement('span');
    range.className = 'entity-item__range';
    range.textContent = String(entry.range) + 'm';

    li.appendChild(avatar);
    li.appendChild(body);
    li.appendChild(actions);
    li.appendChild(range);

    li.addEventListener('click', function (e) {
      if ((e.target as HTMLElement).closest('[data-action="profile"]')) {
        e.stopPropagation();
        BeeProfile.openAvatar(entry.id, { agent: entry });
        return;
      }
      if ((e.target as HTMLElement).closest('[data-action="im"]')) {
        e.stopPropagation();
        openIm(entry);
        return;
      }
      // Poking the row raises the action menu - on a touch screen there is
      // no right-click to reach it, and IM stays one tap away as both the
      // envelope button and the menu's first entry. Stop the bubble so the
      // document-level "click outside closes the menu" listener doesn't
      // immediately swallow what we just opened.
      e.stopPropagation();
      showContextMenu(e, entry);
    });

    li.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      showContextMenu(e, entry);
    });

    return li;
  }

  // The Rust core aims the teleport from its own coarse-position table, so
  // the menu entry only needs to know whether a position exists at all.
  function canTeleportTo(entry) {
    return !!(entry && entry.pos && BeeState.gridOnline());
  }

  function teleportToEntry(entry) {
    const names = nameLines(entry);
    BeeBridge.invoke('sl_teleport_to_agent', { agentId: entry.id }).then(function () {
      BeeUtils.showToast('Teleporting to ' + (names.title || 'resident') + '...', 'info');
    }).catch(function (err) {
      BeeUtils.showToast(err && err.message ? err.message : String(err || 'Teleport failed.'), 'warning');
    });
  }

  function copyToClipboard(text, what) {
    if (!text || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () {
      BeeUtils.showToast(what + ' copied', 'success');
    }).catch(function () {});
  }

  function showContextMenu(e, entry) {
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    menu.hidden = false;

    const names = nameLines(entry);
    const actions = [
      { label: 'Send IM', fn: function () { openIm(entry); } },
      { label: 'Profile', fn: function () { BeeProfile.openAvatar(entry.id, { agent: entry }); } },
      { label: 'Teleport to', fn: function () { teleportToEntry(entry); },
        disabled: !canTeleportTo(entry) },
      { label: 'Copy name', fn: function () { copyToClipboard(names.title || entry.name || '', 'Name'); } },
      { label: 'Copy UUID', fn: function () { copyToClipboard(entry.id, 'UUID'); } }
    ];

    // Per-person voice controls, for people currently in the voice channel.
    const voice = (typeof BeeVoice !== 'undefined' && BeeVoice.participantInfo)
      ? BeeVoice.participantInfo(entry.id) : null;
    if (voice) {
      actions.push({
        label: voice.muted ? 'Unmute voice (for me)' : 'Mute voice (for me)',
        fn: function () { BeeVoice.setUserMute(entry.id, !voice.muted); }
      });
      actions.push({
        label: 'Voice volume... (' + voice.volume + '%)',
        fn: function () {
          BeeUtils.prompt({
            title: 'Voice volume',
            message: 'Volume for ' + (names.title || 'this resident') + ' (0-200%):',
            confirmLabel: 'Set',
            value: String(voice.volume)
          }).then(function (v) {
            if (v === null) return;
            const n = parseInt(String(v), 10);
            if (Number.isFinite(n)) BeeVoice.setUserVolume(entry.id, n);
            else BeeUtils.showToast('Enter a number between 0 and 200.', 'warning');
          });
        }
      });
    }

    actions.forEach(function (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      if (action.disabled) {
        btn.disabled = true;
        btn.title = 'Position not known yet';
      } else {
        btn.addEventListener('click', function () {
          menu.hidden = true;
          action.fn();
        });
      }
      menu.appendChild(btn);
    });

    // Measure the real menu, then clamp it fully on-screen: as the primary
    // tap action it often opens near the bottom edge on a phone.
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(e.clientX, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(0, Math.min(e.clientY, window.innerHeight - rect.height - 8)) + 'px';
  }

  // "3 nearby", or "3 / 5 nearby" when part of the region sits beyond the
  // range setting. Shared by the Radar tab header and the chat sidebar.
  function countLabel(s) {
    const totalInRegion = s.radar.length;
    const nearby = s.radar.filter(function (e) { return e.range <= s.radarRange; }).length;
    if (totalInRegion > nearby) return nearby + ' / ' + totalInRegion + ' nearby';
    return nearby === 1 ? '1 nearby' : nearby + ' nearby';
  }

  function render() {
    const list = document.getElementById('radar-list');
    const countEl = document.getElementById('radar-count');
    const regionEl = document.getElementById('radar-region');
    if (!list) return;

    const s = BeeState.get();
    let entries = s.radar.slice();
    const totalInRegion = entries.length;

    if (filter) {
      const q = filter.toLowerCase();
      entries = entries.filter(function (e) {
        const names = nameLines(e);
        return names.title.toLowerCase().indexOf(q) !== -1 ||
          (names.subtitle && names.subtitle.toLowerCase().indexOf(q) !== -1) ||
          e.id.toLowerCase().indexOf(q) !== -1;
      });
    }

    entries.sort(function (a, b) { return a.range - b.range; });

    list.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('li');
      empty.className = 'entity-item';
      empty.style.cursor = 'default';
      let msg = 'No other avatars detected in this region.';
      if (totalInRegion && filter) {
        msg = 'No avatars match your search.';
      }
      empty.innerHTML = '<div class="entity-item__sub">' + BeeUtils.escapeHtml(msg) + '</div>';
      list.appendChild(empty);
    } else {
      entries.forEach(function (entry) {
        const outOfRange = entry.range > s.radarRange;
        const highlightAlert = s.radarAlerts && isAlertCandidate(entry);
        list.appendChild(renderItem(entry, { outOfRange: outOfRange, highlightAlert: highlightAlert }));
      });
      list.querySelectorAll<HTMLElement>('.entity-item__avatar[data-agent-id]').forEach(function (node) {
        BeeAvatarThumb.refresh(node);
      });
    }

    if (countEl) countEl.textContent = countLabel(s);
    if (regionEl) regionEl.textContent = s.region ? s.region.name : '';
  }

  // --- Nearby chat sidebar --------------------------------------------------
  // A slim, tap-for-menu version of the list above, shown beside the chat
  // transcript while the chatRadarPanel setting is on and the window is wide
  // enough (SIDEBAR_QUERY). Hidden, it costs nothing: every repaint trigger
  // goes through sidebarChanged() first.

  function sidebarMediaQuery() {
    try {
      return (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
        ? window.matchMedia(SIDEBAR_QUERY) : null;
    } catch (_e) { return null; }
  }

  // Setting on, and the window is wide enough. Without matchMedia the CSS
  // breakpoint alone decides, so the setting stands on its own.
  function sidebarWanted() {
    if (typeof BeeSettings === 'undefined' || !BeeSettings.get('chatRadarPanel')) return false;
    const mq = sidebarMediaQuery();
    return mq ? !!mq.matches : true;
  }

  function sidebarVisible() {
    const aside = document.getElementById('chat-radar');
    return !!(aside && !aside.hidden);
  }

  function scheduleSidebarRender() {
    if (sidebarRenderScheduled) return;
    sidebarRenderScheduled = true;
    requestAnimationFrame(function () {
      sidebarRenderScheduled = false;
      renderSidebar();
    });
  }

  // Something the sidebar shows has changed; repaint only while it is on
  // screen (chat tab active and the strip not hidden).
  function sidebarChanged() {
    if (BeeNavigation.isTabActive('chat') && sidebarVisible()) scheduleSidebarRender();
  }

  // Show or hide the strip to match the setting and the window width, and
  // mirror that on the composer's toggle button.
  function applySidebar() {
    const aside = document.getElementById('chat-radar');
    const toggle = document.getElementById('chat-radar-toggle');
    const wanted = sidebarWanted();
    if (toggle) toggle.setAttribute('aria-pressed', wanted ? 'true' : 'false');
    if (!aside) return;
    aside.hidden = !wanted;
    if (wanted) renderSidebar();
  }

  // Keyboard activation (Enter/Space on the row button) carries no pointer
  // position; anchor the menu to the row instead of the top-left corner.
  function menuPoint(e, row) {
    if (e.clientX || e.clientY) return e;
    const r = row.getBoundingClientRect();
    return { clientX: r.left + 12, clientY: r.bottom };
  }

  function renderSidebarItem(entry, s) {
    const names = nameLines(entry);
    const far = entry.range > s.radarRange;
    // Same rule as renderItem(): no alert highlight beyond the range setting.
    const alert = !!s.radarAlerts && !far && isAlertCandidate(entry);

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'chat-radar__item' +
      (far ? ' chat-radar__item--far' : '') +
      (alert ? ' chat-radar__item--alert' : '');
    row.dataset.id = entry.id;
    row.title = String(names.title || '') +
      (names.subtitle ? ' (' + names.subtitle + ')' : '') +
      (entry.status ? ' [' + entry.status + ']' : '');

    const nameEl = document.createElement('span');
    nameEl.className = 'chat-radar__name';
    nameEl.textContent = String(names.title || '');
    row.appendChild(nameEl);

    const mic = voiceGlyph(entry);
    if (mic) row.appendChild(mic);

    const range = document.createElement('span');
    range.className = 'chat-radar__range';
    range.textContent = Math.round(entry.range) + 'm';
    row.appendChild(range);

    // Tap or right-click: the same action menu the Radar tab uses. Stop the
    // bubble so the document-level "click outside closes the menu" listener
    // doesn't swallow what we just opened.
    row.addEventListener('click', function (e) {
      e.stopPropagation();
      showContextMenu(menuPoint(e, row), entry);
    });
    row.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(menuPoint(e, row), entry);
    });
    return row;
  }

  function renderSidebar() {
    const list = document.getElementById('chat-radar-list');
    const countEl = document.getElementById('chat-radar-count');
    if (!list) return;

    const s = BeeState.get();
    const entries = s.radar.slice();
    entries.sort(function (a, b) { return a.range - b.range; });

    list.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-radar__empty';
      empty.textContent = 'Nobody nearby';
      list.appendChild(empty);
    } else {
      entries.forEach(function (entry) {
        list.appendChild(renderSidebarItem(entry, s));
      });
    }
    // The strip's heading already says "Nearby", so the pill is the bare
    // figure: "3", or "3 / 5" with part of the region beyond the range setting.
    if (countEl) countEl.textContent = countLabel(s).replace(/ nearby$/, '');
  }

  function init() {
    // Speaking state rides the voice engine's participant events.
    if (typeof BeeTransport !== 'undefined') {
      BeeTransport.on('voice-participants', function () {
        if (BeeState.get().activeTab === 'radar') scheduleRender();
        sidebarChanged();
      });
    }
    const rangeInput = document.getElementById('radar-range') as HTMLInputElement | null;
    const rangeLabel = document.getElementById('radar-range-label');
    const alertInput = document.getElementById('radar-alert') as HTMLInputElement | null;

    if (typeof BeeSettings !== 'undefined') {
      const savedRange = BeeSettings.get('radarRange');
      const savedAlerts = BeeSettings.get('radarAlerts');
      if (rangeInput) rangeInput.value = String(savedRange);
      if (rangeLabel) rangeLabel.textContent = savedRange + 'm';
      if (alertInput) alertInput.checked = !!savedAlerts;
    }

    rangeInput.addEventListener('input', function () {
      const val = parseInt(rangeInput.value, 10);
      rangeLabel.textContent = val + 'm';
      if (typeof BeeSettings !== 'undefined') {
        BeeSettings.set('radarRange', val);
      } else {
        BeeState.patch({ radarRange: val });
      }
      render();
      if (typeof BeeNavigation.noteRadarUpdate === 'function') {
        BeeNavigation.noteRadarUpdate(BeeState.get().radar);
      }
      BeeNavigation.updateBadges();
    });

    document.getElementById('radar-search').addEventListener('input', BeeUtils.debounce(function (e) {
      filter = e.target.value.trim();
      render();
    }, 200));

    alertInput.addEventListener('change', function (e) {
      if (typeof BeeSettings !== 'undefined') {
        BeeSettings.set('radarAlerts', (e.target as HTMLInputElement).checked);
      } else {
        BeeState.patch({ radarAlerts: (e.target as HTMLInputElement).checked });
      }
      render();
    });

    document.addEventListener('click', function (e) {
      const menu = document.getElementById('context-menu');
      if (!menu.hidden && !menu.contains(e.target as Node)) menu.hidden = true;
    });

    BeeState.on('change', function (partial) {
      if (partial.radar && BeeNavigation.isTabActive('radar')) scheduleRender();
      // The sidebar also catches up when the chat tab comes back on screen.
      if (partial.radar || partial.activeTab === 'chat') sidebarChanged();
    });

    BeeState.on('radar-update', function () {
      if (BeeNavigation.isTabActive('radar')) scheduleRender();
      sidebarChanged();
    });

    // Repaint once names resolve, so entries show the real name rather than the UUID/"?".
    BeeTransport.on('names-updated', function () {
      if (BeeNavigation.isTabActive('radar')) scheduleRender();
      sidebarChanged();
    });
    // Repaint when the avatar properties (age/born-on) come in.
    if (typeof BeeProfiles !== 'undefined' && BeeProfiles.onChange) {
      BeeProfiles.onChange(function (evt) {
        if (evt && evt.kind === 'avatar' && BeeNavigation.isTabActive('radar')) scheduleRender();
      });
    }

    // When range or alerts are changed elsewhere (e.g. the Settings tab), mirror
    // those changes back into the radar controls and list.
    if (typeof BeeSettings !== 'undefined' && BeeSettings.onChange) {
      BeeSettings.onChange(function (key, value) {
        if (key === 'radarRange') {
          if (rangeInput) rangeInput.value = String(value);
          if (rangeLabel) rangeLabel.textContent = value + 'm';
          if (BeeNavigation.isTabActive('radar')) scheduleRender();
          sidebarChanged();
        } else if (key === 'radarAlerts') {
          if (alertInput) alertInput.checked = !!value;
          if (BeeNavigation.isTabActive('radar')) scheduleRender();
          sidebarChanged();
        } else if (key === 'chatRadarPanel') {
          applySidebar();
        }
      });
    }

    // The composer's people button flips the chat sidebar setting; the strip
    // itself follows the setting and the window width from there.
    const sidebarToggle = document.getElementById('chat-radar-toggle');
    if (sidebarToggle && typeof BeeSettings !== 'undefined') {
      sidebarToggle.addEventListener('click', function () {
        BeeSettings.set('chatRadarPanel', !BeeSettings.get('chatRadarPanel'));
      });
    }
    const sidebarMq = sidebarMediaQuery();
    if (sidebarMq) {
      const onWidthChange = function () { applySidebar(); };
      if (typeof sidebarMq.addEventListener === 'function') sidebarMq.addEventListener('change', onWidthChange);
      else if (typeof sidebarMq.addListener === 'function') sidebarMq.addListener(onWidthChange);
    }
    applySidebar();
  }

  return { init: init, render: render, renderSidebar: renderSidebar };
})();
