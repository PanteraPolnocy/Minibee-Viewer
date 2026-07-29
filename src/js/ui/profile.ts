/**
 * The floater that shows avatar and group profiles.
 */
const BeeProfile = (function () {
  'use strict';

  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
  const PROFILE_STALE_MS = 15 * 60 * 1000;
  const AVATAR_TABS = [
    { id: 'resident', label: 'Resident' },
    { id: 'web', label: 'Web' },
    { id: 'interests', label: 'Interests' },
    { id: 'places', label: 'Picks' },
    { id: 'classifieds', label: 'Classifieds' },
    { id: 'more', label: 'More' },
    { id: 'notes', label: 'Notes' }
  ];

  const NOTES_FEEDBACK_MS = 2800;
  const NOTES_SAVE_TIMEOUT_MS = 5000;

  let dialog = null;
  let imageDialog = null;
  let current = null;
  let notesSaveToken = 0;
  let groupRefreshTimer = null;
  let lastGroupViewKey = '';

  // Callers that need a form control ask for it: el<HTMLInputElement>('...').
  function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  function sanitizeProfileHtml(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const allowed = /^(b|i|u|br|a|p|div|span|ul|ol|li|strong|em)$/i;
    const template = document.createElement('template');
    template.innerHTML = raw.replace(/\n/g, '<br>');
    template.content.querySelectorAll<HTMLElement>('*').forEach(function (node) {
      if (!allowed.test(node.tagName)) {
        const textNode = document.createTextNode(node.textContent || '');
        node.replaceWith(textNode);
        return;
      }
      Array.from(node.attributes).forEach(function (attr) {
        if (node.tagName.toLowerCase() === 'a' && attr.name === 'href') return;
        node.removeAttribute(attr.name);
      });
      if (node.tagName.toLowerCase() === 'a') {
        const href = node.getAttribute('href') || '';
        if (!/^https?:\/\//i.test(href) && !/^secondlife:/i.test(href)) {
          node.removeAttribute('href');
        } else {
          node.setAttribute('rel', 'noopener noreferrer');
          node.setAttribute('target', '_blank');
        }
      }
    });
    return template.innerHTML;
  }

  function setLoading(loading) {
    const loadingEl = el('profile-loading');
    const contentEl = el('profile-content');
    if (loadingEl) loadingEl.hidden = !loading;
    if (contentEl) contentEl.hidden = loading;
  }

  function clearActions() {
    const actions = el('profile-actions');
    if (!actions) return;
    actions.innerHTML = '';
    actions.hidden = true;
  }

  function addAction(label, handler, options?) {
    const actions = el('profile-actions');
    if (!actions) return;
    actions.hidden = false;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--secondary profile-dialog__action';
    if (options && options.primary) btn.classList.add('btn--primary');
    btn.textContent = label;
    btn.addEventListener('click', handler);
    if (options && options.disabled) {
      btn.disabled = true;
      if (options.title) btn.title = options.title;
    }
    actions.appendChild(btn);
  }

  function closeDialog() {
    current = null;
    BeeUtils.dismissDialog(dialog);
  }

  function teleportFromProfileDetail(loc) {
    if (!loc) return;
    if (!BeeState.gridOnline()) {
      BeeUtils.showToast('Not connected to the grid', 'warning');
      return;
    }
    if (typeof BeeMap !== 'undefined') {
      if (BeeMap.showLocation) BeeMap.showLocation(loc);
      if (BeeMap.beginMapTeleport) BeeMap.beginMapTeleport('requesting');
    }
    closeDialog();
    if (typeof BeeTransport.teleportTo !== 'function') return;
    BeeTransport.teleportTo(loc).then(function () {
      if (typeof BeeMap !== 'undefined' && BeeMap.beginMapTeleport) {
        BeeMap.beginMapTeleport('starting');
      }
    }).catch(function (err) {
      if (typeof BeeMap !== 'undefined' && BeeMap.resetTeleportButton) {
        BeeMap.resetTeleportButton();
      }
      BeeUtils.showToast(err.message || 'Teleport failed', 'error');
    });
  }

  function shortUuid(id) {
    const text = String(id || '');
    return text ? text.slice(0, 8) + '...' : '';
  }

  function profileTitleText(profile) {
    const clean = function (v) { const s = String(v || '').trim(); return BeeUtils.isUuid(s) ? '' : s; };
    const displayName = clean(profile.displayName);
    const userName = clean(profile.userName || profile.legacyName);
    const fallback = clean(profile.name);
    if (displayName && userName && displayName.toLowerCase() !== userName.toLowerCase()) {
      return displayName + ' (' + userName + ')';
    }
    if (displayName) return displayName;
    if (userName) return userName;
    if (fallback && fallback !== '?') return fallback;
    if (typeof BeeTransport.getCachedName === 'function') {
      const cached = BeeTransport.getCachedName(profile.avatarId);
      if (cached) return cached;
    }
    return shortUuid(profile.avatarId) || 'Resident';
  }

  const CUSTOMER_TYPE_LABELS = {
    secondlifetime_premium_plus: 'Premium Plus lifetime',
    secondlifetime_premium: 'Premium lifetime',
    lifetime: 'Lifetime',
    beta_lifetime: 'Beta lifetime',
    plus_monthly: 'Premium Plus monthly',
    premium_monthly: 'Premium monthly',
    premium_plus_monthly: 'Premium Plus monthly',
    annual: 'Annual',
    premium_annual: 'Premium annual',
    premium_plus_annual: 'Premium Plus annual'
  };

  function formatCustomerTypeLabel(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) return '';
    if (CUSTOMER_TYPE_LABELS[key]) return CUSTOMER_TYPE_LABELS[key];
    return key.split(/[_\s]+/).filter(Boolean).map(function (word) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(' ');
  }

  function profileSubtitleText(profile) {
    const parts = [];
    if (profile.flags && profile.flags.online === true) parts.push('Online');
    else if (profile.flags && profile.flags.online === false) parts.push('Offline');
    const level = formatCustomerTypeLabel(profile.customerType);
    if (level) parts.push('Account level: ' + level);
    return parts.join(' \u00b7 ');
  }

  function formatGroupJoinFee(profile) {
    const fee = Number(profile && profile.membershipFee) || 0;
    if (fee > 0) return 'L$ ' + fee.toLocaleString('en-US');
    return 'Free';
  }

  function groupSubtitleHtml(profile) {
    const parts = [];
    if (profile.memberCount !== undefined && profile.memberCount !== null) {
      parts.push('<strong class="profile-subtitle__emphasis">' +
        BeeUtils.escapeHtml(String(profile.memberCount.toLocaleString('en-US'))) + ' members</strong>');
    }
    parts.push(BeeUtils.escapeHtml(profile.openEnrollment ? 'Open enrollment' : 'Closed enrollment'));
    parts.push(BeeUtils.escapeHtml(profile.maturePublish ? 'Mature' : 'General'));
    return parts.join(' \u00b7 ');
  }

  function updateGroupHeader(profile) {
    const titleEl = el('profile-title');
    const subtitleEl = el('profile-subtitle');
    if (titleEl) titleEl.textContent = profile.name || 'Group';
    if (subtitleEl) subtitleEl.innerHTML = groupSubtitleHtml(profile);
  }

  function formatAccountInfo(profile) {
    const parts = ['Resident'];
    // The account caption (UDP `CharterMember` / cap `caption`) is already the
    // label text itself (e.g. "Charter Member", "Linden"), so show it verbatim
    // rather than forcing a hardcoded "Charter member" for any non-empty value.
    const caption = String(profile.caption || profile.charterMember || '').trim();
    if (caption && caption.toLowerCase() !== 'resident') parts.push(caption);
    return parts.join(' \u00b7 ');
  }

  function formatPaymentInfo(profile) {
    const flags = profile.flags || {};
    if (flags.transacted) return 'Payment info in use';
    if (flags.identified) return 'Payment info on file';
    return 'No payment info on file';
  }

  function paymentInfoClass(profile) {
    const flags = profile.flags || {};
    if (flags.transacted) return ' profile-payment--active';
    if (flags.identified) return ' profile-payment--on-file';
    return ' profile-payment--none';
  }

  function renderResidentKeyMeta(profile) {
    return '<div class="profile-desc-meta profile-desc-meta--key">' +
      '<div class="profile-meta-item">' +
      '<span class="profile-meta-item__label">Key</span>' +
      '<span class="profile-meta-item__value"><code class="profile-uuid">' +
      BeeUtils.escapeHtml(profile.avatarId) + '</code></span></div></div>';
  }

  function renderResidentSideMeta(profile) {
    let html = '';
    const born = BeeProfiles.formatBornLabel(profile.bornOn, profile.hideAge);
    if (born) {
      html += '<div class="profile-field"><span class="profile-field__label">Born</span><span>' +
        BeeUtils.escapeHtml(born) + '</span></div>';
    }
    if (profile.partnerId && profile.partnerId !== ZERO_UUID) {
      const partnerLabel = profile.partnerName || 'View profile';
      html += '<div class="profile-field"><span class="profile-field__label">Partner</span>' +
        '<span><button type="button" class="profile-link" data-avatar-id="' +
        BeeUtils.escapeHtml(profile.partnerId) + '">' + BeeUtils.escapeHtml(partnerLabel) +
        '</button></span></div>';
    }
    return html;
  }

  function findKnownAgent(agentId) {
    const id = BeeProfiles.normId(agentId);
    if (BeeProfiles.isZero(id)) return null;
    const buddies = BeeState.get().buddies || [];
    let i;
    for (i = 0; i < buddies.length; i++) {
      if (BeeProfiles.normId(buddies[i].id) === id) return buddies[i];
    }
    const radar = BeeState.get().radar || [];
    for (i = 0; i < radar.length; i++) {
      if (BeeProfiles.normId(radar[i].id) === id) return radar[i];
    }
    const sessions = BeeState.get().imSessions || {};
    const keys = Object.keys(sessions);
    for (i = 0; i < keys.length; i++) {
      const session = sessions[keys[i]];
      if (session && session.participant &&
          BeeProfiles.normId(session.participant.id) === id) {
        return session.participant;
      }
    }
    return null;
  }

  function applyNameHint(profile, hint) {
    if (!profile || !hint) return profile;
    // A hint that came from a buddy/radar object keeps the UUID in `name` until
    // GetDisplayNames resolves it. Never let a UUID slip into a name field
    const clean = function (v) { const s = String(v || '').trim(); return BeeUtils.isUuid(s) ? '' : s; };
    const hintName = clean(hint.name);
    profile.displayName = clean(hint.displayName) || clean(profile.displayName) || '';
    if (!profile.displayName && hintName) profile.displayName = hintName;
    profile.userName = clean(hint.userName || hint.legacyName) || clean(profile.userName) || '';
    if (!profile.userName && hintName && hintName.toLowerCase() !== profile.displayName.toLowerCase()) {
      profile.userName = hintName;
    }
    if (!profile.name) profile.name = hintName || profile.displayName || profile.userName || '';
    return profile;
  }

  function updateProfileHeader(profile) {
    const titleEl = el('profile-title');
    const subtitleEl = el('profile-subtitle');
    if (titleEl) titleEl.textContent = profileTitleText(profile);
    if (subtitleEl) subtitleEl.textContent = profileSubtitleText(profile);
  }

  function queueProfileNames(profile) {
    if (!profile || typeof BeeTransport.queueNameResolve !== 'function') return;
    const ids = [];
    if (profile.avatarId) ids.push(profile.avatarId);
    if (profile.partnerId && profile.partnerId !== ZERO_UUID) ids.push(profile.partnerId);
    if (ids.length) BeeTransport.queueNameResolve(ids);
  }

  function ensureProfileExtras(profile) {
    if (!profile || !profile.avatarId || typeof BeeProfiles.ensureAvatarExtras !== 'function') return;
    BeeProfiles.ensureAvatarExtras(profile.avatarId, profile);
  }

  function openImagePreview(imageId, label) {
    const id = BeeProfiles.normId(imageId);
    if (BeeProfiles.isZero(id) || !imageDialog) return;
    const img = el<HTMLImageElement>('profile-image-full');
    if (!img) return;
    img.alt = label || 'Profile image';
    img.src = BeeProfiles.textureImageUrl(id, 512);
    if (typeof imageDialog.showModal === 'function') imageDialog.showModal();
  }

  function renderAboutBlock(html, emptyText) {
    if (html === null) {
      return '<div class="profile-scroll profile-about profile-about--loading">Fetching...</div>';
    }
    if (!html) {
      return '<div class="profile-scroll profile-about profile-about--empty">' +
        BeeUtils.escapeHtml(emptyText || 'No profile text.') + '</div>';
    }
    return '<div class="profile-scroll profile-about" tabindex="0">' + html + '</div>';
  }

  function profileCapAboutReady(profile) {
    if (!profile || profile.source !== 'cap') return false;
    if (typeof BeeProfiles.needsCapProfileFetch === 'function') {
      return !BeeProfiles.needsCapProfileFetch(profile);
    }
    return String(profile.about || '').length > 0;
  }

  function profileAboutPending(profile) {
    if (!profile) return true;
    if (profileCapAboutReady(profile)) return false;
    if (typeof BeeProfiles.isCapFetchActive === 'function' &&
        BeeProfiles.isCapFetchActive()) {
      return true;
    }
    return false;
  }

  function profileAboutForDisplay(profile) {
    if (!profile) return '';
    if (profileAboutPending(profile)) return null;
    return profile.about || '';
  }

  function renderGroupsList(groups, activeGroupId, showClearActive) {
    let html = '';
    if (showClearActive) {
      html += '<button type="button" class="profile-link profile-groups-list__clear" data-clear-active-group>' +
        '[ Set active group to none ]</button>';
    }
    if (!groups || !groups.length) {
      return html + '<p class="profile-section__empty">No groups listed</p>';
    }
    const activeId = BeeProfiles.normId(activeGroupId || '');
    html += '<div class="profile-groups-list">' + groups.map(function (g) {
      const hidden = g.listInProfile === false;
      const baseLabel = g.name || 'Group';
      const label = BeeUtils.escapeHtml(baseLabel);
      const isActive = activeId && BeeProfiles.normId(g.id) === activeId;
      const cls = 'profile-link profile-groups-list__item' +
        (isActive ? ' profile-groups-list__item--active' : '') +
        (hidden ? ' profile-groups-list__item--hidden' : '');
      return '<button type="button" class="' + cls + '" data-group-id="' +
        BeeUtils.escapeHtml(g.id) + '">' + label + '</button>';
    }).join('') + '</div>';
    return html;
  }

  function patchSelfGroupsSection(profile) {
    const section = document.querySelector('.profile-section--groups');
    if (!section || !profile || !isSelfProfile(profile)) return false;
    const h3 = section.querySelector('.profile-section__title');
    const titleHtml = h3 ? h3.outerHTML : '<h3 class="profile-section__title">Groups</h3>';
    section.innerHTML = titleHtml + renderGroupsList(
      typeof BeeProfiles.getProfileGroupsForDisplay === 'function'
        ? BeeProfiles.getProfileGroupsForDisplay(profile.avatarId, profile)
        : (profile.groups || []),
      BeeProfiles.getActiveGroupId(),
      true
    );
    bindAvatarContent(profile, el('profile-content'));
    return true;
  }

  function highlightActiveGroupInList() {
    const activeId = typeof BeeProfiles.getActiveGroupId === 'function'
      ? BeeProfiles.normId(BeeProfiles.getActiveGroupId())
      : '';
    document.querySelectorAll<HTMLElement>('.profile-groups-list__item').forEach(function (btn) {
      const id = BeeProfiles.normId(btn.getAttribute('data-group-id') || '');
      btn.classList.toggle('profile-groups-list__item--active', !!(activeId && id === activeId));
    });
  }

  function renderSplitList(rows, emptyText, itemClass, layout) {
    if (!rows || !rows.length) {
      return '<p class="profile-section__empty">' + BeeUtils.escapeHtml(emptyText || 'None') + '</p>';
    }
    const list = rows.map(function (row, index) {
      const label = BeeUtils.escapeHtml(row.name || row.title || 'Item');
      return '<button type="button" class="profile-split__item ' + (itemClass || '') + '" data-item-index="' +
        index + '">' + label + '</button>';
    }).join('');
    const splitClass = layout === 'stack'
      ? 'profile-split profile-split--stack'
      : 'profile-split profile-split--row';
    return '<div class="' + splitClass + '">' +
      '<div class="profile-split__list">' + list + '</div>' +
      '<div class="profile-split__detail">' +
      '<p class="profile-section__empty">Select an item</p></div></div>';
  }

  function isSelfProfile(profile) {
    const selfId = BeeProfiles.normId((BeeState.get().agent || {}).id);
    return !!(profile && profile.avatarId && BeeProfiles.normId(profile.avatarId) === selfId);
  }

  function profileDetailLocation(detail) {
    if (!detail) return null;
    let regionName = String(detail.regionName || detail.simName || '').trim();
    const parcel = String(detail.resolvedParcelName || detail.parcelName || '').trim();
    // If the region name just echoes the parcel name, it isn't a real sim name.
    if (parcel && regionName.toLowerCase() === parcel.toLowerCase()) regionName = '';
    if (detail.x !== undefined && detail.y !== undefined && detail.z !== undefined &&
        (detail.gridX || detail.gridY)) {
      return {
        regionName: regionName,
        gridX: detail.gridX,
        gridY: detail.gridY,
        globalX: detail.globalX,
        globalY: detail.globalY,
        x: detail.x,
        y: detail.y,
        z: detail.z
      };
    }
    // Picks and classifieds carry PosGlobal even when SimName is empty, so we
    // derive the location from the global coords instead. A missing name
    // shouldn't hide the location row or buttons.
    if (!detail.posGlobal) return null;
    const pos = detail.posGlobal;
    if (!pos || (!pos.x && !pos.y)) return null; // this pick has no location set
    const rw = 256;
    const grid = typeof BeeSlurl !== 'undefined' && BeeSlurl.globalToGrid
      ? BeeSlurl.globalToGrid(pos.x, pos.y)
      : null;
    return {
      regionName: regionName,
      gridX: grid ? grid.gridX : detail.gridX,
      gridY: grid ? grid.gridY : detail.gridY,
      globalX: grid ? grid.globalX : detail.globalX,
      globalY: grid ? grid.globalY : detail.globalY,
      x: Math.round(((pos.x % rw) + rw) % rw),
      y: Math.round(((pos.y % rw) + rw) % rw),
      z: Math.round(pos.z)
    };
  }

  function renderItemDetail(detail, kind) {
    const name = detail.name || 'Item';
    const descHtml = sanitizeProfileHtml(detail.description || '');
    let snap = '';
    if (detail.snapshotId && !BeeProfiles.isZero(detail.snapshotId)) {
      snap = '<button type="button" class="profile-detail__snapshot-btn" data-image-id="' +
        BeeUtils.escapeHtml(detail.snapshotId) + '"><img class="profile-detail__snapshot" src="' +
        BeeProfiles.textureImageUrl(detail.snapshotId, 256) + '" alt=""></button>';
    }
    let html = snap + '<h4 class="profile-split__title">' + BeeUtils.escapeHtml(name) + '</h4>';
    if (descHtml) {
      html += '<div class="profile-detail__desc">' + descHtml + '</div>';
    }
    const loc = profileDetailLocation(detail);
    if (loc) {
      // Format: "Parcel name (x, y, z) - Region name", with each part shown only when known.
      const coords = loc.x + ', ' + loc.y + ', ' + loc.z;
      const parcelName = detail.resolvedParcelName || detail.parcelName || '';
      let locText = (parcelName ? parcelName + ' ' : '') + '(' + coords + ')';
      if (loc.regionName) locText += ' - ' + loc.regionName;
      html += '<div class="profile-field"><span class="profile-field__label">Location</span><span>' +
        BeeUtils.escapeHtml(locText) + '</span></div>';
    }
    if (kind === 'classified' && detail.priceForListing) {
      html += '<div class="profile-field"><span class="profile-field__label">Listing price</span><span>L$ ' +
        Number(detail.priceForListing).toLocaleString('en-US') + '</span></div>';
    }
    if (loc) {
      html += '<div class="profile-detail__actions">' +
        '<button type="button" class="btn btn--secondary profile-detail__action" data-detail-action="map">Show on map</button>' +
        '<button type="button" class="btn btn--primary profile-detail__action" data-detail-action="teleport">Teleport</button>' +
        '</div>';
    }
    return html;
  }

  function bindDetailActions(detailEl, detail) {
    if (!detailEl || !detail) return;
    const loc = profileDetailLocation(detail);
    if (!loc) return;
    detailEl.querySelectorAll('[data-detail-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const action = btn.getAttribute('data-detail-action');
        if (action === 'map') {
          if (typeof BeeMap !== 'undefined' && BeeMap.showLocation) {
            BeeMap.showLocation(loc);
          }
          return;
        }
        if (action === 'teleport') {
          teleportFromProfileDetail(loc);
        }
      });
    });
  }

  function bindDetailSnapshot(detailEl) {
    if (!detailEl) return;
    detailEl.querySelectorAll('[data-image-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openImagePreview(btn.getAttribute('data-image-id'), 'Profile image');
      });
    });
  }

  function paintItemDetail(detailEl, detail, kind) {
    if (!detailEl || !detail) return;
    detailEl.innerHTML = renderItemDetail(detail, kind);
    bindDetailSnapshot(detailEl);
    bindDetailActions(detailEl, detail);
  }

  // Resolved parcel info (region + parcel name), keyed by parcel id and cached
  // for the session so re-opening a pick is instant and we never re-ask the sim.
  const parcelInfoCache = new Map();

  function applyResolvedParcel(detailEl, item, kind, rowId, info) {
    if (!current || current.type !== 'avatar') return;
    const selId = kind === 'pick' ? current.selectedPickId : current.selectedClassifiedId;
    if (selId !== rowId) return;
    paintItemDetail(detailEl, Object.assign({}, item, {
      simName: info.simName || item.simName,
      regionName: info.simName || item.regionName,
      resolvedParcelName: info.name || item.resolvedParcelName || ''
    }), kind);
  }

  // A pick or classified carries a parcelId but often an empty SimName, so the
  // location line shows only coordinates. Fill the region name in from the parcel
  // info and repaint (cached after the first lookup). This is best-effort; the
  // pick's own PosGlobal stays the teleport target.
  function enrichItemLocation(detailEl, item, kind, rowId) {
    if (!item || !item.parcelId || item.simName || item.regionName) return;
    if (BeeProfiles.isZero && BeeProfiles.isZero(item.parcelId)) return;
    const key = BeeProfiles.normId(item.parcelId);
    const cached = parcelInfoCache.get(key);
    if (cached) { applyResolvedParcel(detailEl, item, kind, rowId, cached); return; }
    if (typeof BeeTransport.fetchParcelInfo !== 'function') return;
    BeeTransport.fetchParcelInfo(item.parcelId).then(function (info) {
      if (!info || (!info.simName && !info.name)) return;
      parcelInfoCache.set(key, info);
      applyResolvedParcel(detailEl, item, kind, rowId, info);
    }).catch(function () {});
  }

  function findDetailPane(tabId) {
    const content = el('profile-content');
    if (!content) return null;
    const panel = content.querySelector('[data-profile-panel="' + tabId + '"] .profile-split__detail');
    return panel || null;
  }

  function profileWebUrl(profile) {
    if (typeof BeeProfiles.resolveWebProfileUrl === 'function') {
      return BeeProfiles.resolveWebProfileUrl(profile);
    }
    return String(profile && profile.profileUrl || '').trim();
  }

  function avatarTabsFor(profile) {
    const self = isSelfProfile(profile);
    return AVATAR_TABS.filter(function (tab) {
      if (tab.id === 'web') return !!profileWebUrl(profile);
      if (tab.id === 'more') return !!(profile.flAbout || (profile.flImageId && profile.flImageId !== ZERO_UUID));
      return true;
    });
  }

  function renderResidentTab(profile) {
    const aboutText = profileAboutForDisplay(profile);
    const aboutHtml = aboutText === null ? null : sanitizeProfileHtml(aboutText);
    const paymentText = formatPaymentInfo(profile);
    return '<div class="profile-pane profile-pane--resident">' +
      '<div class="profile-resident__columns">' +
      '<div class="profile-resident__side">' +
      '<button type="button" class="profile-avatar-btn" id="profile-avatar-btn" title="View larger image" aria-label="View larger profile image">' +
      '<span id="profile-avatar-slot" class="profile-avatar-btn__slot"></span></button>' +
      '<div class="profile-field"><span class="profile-field__label">Account</span><span>' +
        BeeUtils.escapeHtml(formatAccountInfo(profile)) + '</span></div>' +
      '<div class="profile-field profile-field--payment"><span class="profile-field__label">Payment</span>' +
      '<span class="profile-payment' + paymentInfoClass(profile) + '">' +
        BeeUtils.escapeHtml(paymentText) + '</span></div>' +
      renderResidentSideMeta(profile) +
      '</div>' +
      '<div class="profile-resident__about">' +
      renderResidentKeyMeta(profile) +
      renderAboutBlock(aboutHtml, 'No profile text.') +
      '</div></div>' +
      '<section class="profile-section profile-section--groups">' +
      '<h3 class="profile-section__title">Groups</h3>' +
      renderGroupsList(
        typeof BeeProfiles.getProfileGroupsForDisplay === 'function'
          ? BeeProfiles.getProfileGroupsForDisplay(profile.avatarId, profile)
          : (profile.groups || []),
        isSelfProfile(profile) ? BeeProfiles.getActiveGroupId() : '',
        isSelfProfile(profile)
      ) +
      '</section></div>';
  }

  function renderInterestTags(labels) {
    if (!labels || !labels.length) {
      return '<p class="profile-section__empty">None selected.</p>';
    }
    return '<ul class="profile-interests__tags">' + labels.map(function (label) {
      return '<li class="profile-interests__tag">' + BeeUtils.escapeHtml(label) + '</li>';
    }).join('') + '</ul>';
  }

  function renderInterestText(label, text) {
    const value = String(text || '').trim();
    if (!value) return '';
    return '<div class="profile-field profile-field--interests">' +
      '<span class="profile-field__label">' + BeeUtils.escapeHtml(label) + '</span>' +
      '<p class="profile-interests__text">' + BeeUtils.escapeHtml(value) + '</p></div>';
  }

  function renderInterestsTab(profile) {
    if (!profile.interestsLoaded && !profile.interests) {
      if (typeof BeeState !== 'undefined' && !BeeState.gridOnline()) {
        return '<div class="profile-pane profile-pane--interests">' +
          '<p class="profile-section__empty">Interests are not available offline.</p></div>';
      }
      return '<div class="profile-pane profile-pane--interests">' +
        '<p class="profile-section__empty">Loading...</p></div>';
    }
    const row = typeof BeeProfiles.formatAvatarInterests === 'function'
      ? BeeProfiles.formatAvatarInterests(profile.interests)
      : { hasContent: false, wantTo: [], skills: [], wantToText: '', skillsText: '', languagesText: '' };
    if (!row.hasContent) {
      return '<div class="profile-pane profile-pane--interests">' +
        '<p class="profile-section__empty">No interests listed.</p></div>';
    }
    return '<div class="profile-pane profile-pane--interests">' +
      '<section class="profile-section profile-section--interests">' +
      '<h3 class="profile-section__title">I want to</h3>' +
      renderInterestTags(row.wantTo) +
      renderInterestText('More', row.wantToText) +
      '</section>' +
      '<section class="profile-section profile-section--interests">' +
      '<h3 class="profile-section__title">Skills</h3>' +
      renderInterestTags(row.skills) +
      renderInterestText('More', row.skillsText) +
      '</section>' +
      (row.languagesText
        ? '<section class="profile-section profile-section--interests">' +
          '<h3 class="profile-section__title">Languages</h3>' +
          '<p class="profile-interests__text">' + BeeUtils.escapeHtml(row.languagesText) + '</p>' +
          '</section>'
        : '') +
      '</div>';
  }

  function renderWebTab(profile) {
    const url = profileWebUrl(profile);
    if (!url) {
      return '<div class="profile-pane"><p class="profile-section__empty">No web profile URL.</p></div>';
    }
    const safeUrl = BeeUtils.escapeHtml(url);
    return '<div class="profile-pane"><div class="profile-field">' +
      '<span class="profile-field__label">Profile URL</span>' +
      '<a class="profile-inline-link" href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">' +
      safeUrl + '</a></div></div>';
  }

  function renderPlacesTab(profile) {
    return '<div class="profile-pane">' +
      renderSplitList(profile.picks || [], 'No picks', 'profile-pick', 'row') + '</div>';
  }

  function renderClassifiedsTab(profile) {
    return '<div class="profile-pane">' +
      renderSplitList(profile.classifieds || [], 'No classifieds', 'profile-classified', 'stack') + '</div>';
  }

  function renderMoreTab(profile) {
    const flAboutHtml = sanitizeProfileHtml(profile.flAbout || '');
    const hasFlImage = profile.flImageId && profile.flImageId !== ZERO_UUID;
    return '<div class="profile-pane profile-pane--more">' +
      (hasFlImage
        ? '<button type="button" class="profile-fl-image-btn" id="profile-fl-image-btn" title="View larger image">' +
          '<img class="profile-fl-image-btn__img" id="profile-fl-image-preview" alt="Profile image"></button>'
        : '') +
      renderAboutBlock(flAboutHtml, 'No extended profile text.') +
      '</div>';
  }

  function renderNotesTab(profile) {
    // Only allow editing and saving once the notes have actually been fetched
    // (AvatarNotesReply sets a string, even an empty one). Saving before that
    // reply arrives would overwrite the real notes with a blank field - data loss.
    const loaded = typeof profile.notes === 'string';
    const notes = String(profile.notes || '');
    return '<div class="profile-pane profile-pane--notes">' +
      '<p class="profile-notes-hint">Your private notes about this person. Only you can see them.</p>' +
      // Whose notes these are. The draft-preserving rebuild in renderAvatar
      // reads this back: text typed about one resident must never be carried
      // into another resident's field, where a Save would file it against them.
      '<textarea id="profile-notes-input" class="profile-notes-input" rows="10" maxlength="65530" ' +
        'data-avatar-id="' + BeeUtils.escapeHtml(String(profile.avatarId || '')) + '" ' +
        (loaded ? '' : 'readonly ') +
        'placeholder="' + (loaded ? 'Add private notes...' : 'Loading notes...') + '">' +
        BeeUtils.escapeHtml(notes) + '</textarea>' +
      '<div class="profile-notes-actions">' +
      '<button type="button" class="btn btn--primary" id="profile-notes-save"' +
        (loaded ? '' : ' disabled') + '>Save notes</button>' +
      '</div>' +
      '<div id="profile-notes-status" class="profile-notes-status" role="status" aria-live="polite"></div>' +
      '</div>';
  }

  function renderAvatarTabs(profile) {
    const tabs = avatarTabsFor(profile);
    const activeTab = current && current.tab && tabs.some(function (t) { return t.id === current.tab; })
      ? current.tab
      : tabs[0].id;
    if (current) current.tab = activeTab;

    const nav = tabs.map(function (tab) {
      const active = tab.id === activeTab ? ' profile-tab--active' : '';
      return '<button type="button" class="profile-tab' + active + '" data-profile-tab="' +
        tab.id + '">' + BeeUtils.escapeHtml(tab.label) + '</button>';
    }).join('');

    const panes = {
      resident: renderResidentTab(profile),
      web: renderWebTab(profile),
      interests: renderInterestsTab(profile),
      places: renderPlacesTab(profile),
      classifieds: renderClassifiedsTab(profile),
      more: renderMoreTab(profile),
      notes: renderNotesTab(profile)
    };

    const body = tabs.map(function (tab) {
      const active = tab.id === activeTab ? ' profile-tab-panel--active' : '';
      return '<div class="profile-tab-panel' + active + '" data-profile-panel="' + tab.id + '">' +
        panes[tab.id] + '</div>';
    }).join('');

    return '<nav class="profile-tabs" aria-label="Profile sections">' + nav + '</nav>' +
      '<div class="profile-tab-panels">' + body + '</div>';
  }

  function bindSplitList(container, rows, kind, profile) {
    if (!container || !rows || !rows.length || !profile) return;
    const split = container.querySelector('.profile-split');
    if (!split) return;
    const detail = split.querySelector('.profile-split__detail');

    function showRow(row) {
      if (!detail || !row || !row.id) return;
      const cached = kind === 'pick'
        ? BeeProfiles.getPickDetail(row.id)
        : BeeProfiles.getClassifiedDetail(row.id);
      if (cached) {
        paintItemDetail(detail, cached, kind);
        enrichItemLocation(detail, cached, kind, row.id);
      } else {
        detail.innerHTML = '<p class="profile-section__empty">Loading...</p>';
      }
      const task = kind === 'pick'
        ? BeeProfiles.fetchPickInfo(profile.avatarId, row.id)
        : BeeProfiles.fetchClassifiedInfo(row.id);
      task.then(function (loaded) {
        if (!current || current.type !== 'avatar') return;
        const selectedId = kind === 'pick' ? current.selectedPickId : current.selectedClassifiedId;
        if (selectedId !== row.id) return;
        paintItemDetail(detail, loaded, kind);
        enrichItemLocation(detail, loaded, kind, row.id);
      }).catch(function () {
        if (!detail || cached) return;
        detail.innerHTML = '<h4 class="profile-split__title">' + BeeUtils.escapeHtml(row.name || 'Item') + '</h4>' +
          '<p class="profile-section__empty">Could not load details.</p>';
      });
    }

    split.querySelectorAll('[data-item-index]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        split.querySelectorAll('[data-item-index]').forEach(function (node) {
          node.classList.remove('profile-split__item--active');
        });
        btn.classList.add('profile-split__item--active');
        const index = Number(btn.getAttribute('data-item-index'));
        const row = rows[index];
        if (!row) return;
        if (kind === 'pick') current.selectedPickId = row.id;
        else current.selectedClassifiedId = row.id;
        showRow(row);
      });
    });

    const selectedId = kind === 'pick' ? current.selectedPickId : current.selectedClassifiedId;
    let restored = false;
    if (selectedId) {
      split.querySelectorAll('[data-item-index]').forEach(function (btn) {
        const index = Number(btn.getAttribute('data-item-index'));
        const row = rows[index];
        if (!row || row.id !== selectedId) return;
        btn.classList.add('profile-split__item--active');
        showRow(row);
        restored = true;
      });
    }
    if (!restored && rows.length) {
      const first = split.querySelector('[data-item-index]');
      if (first) first.click();
    }
  }

  function bindNotesSave(profile, root) {
    const notesInput = root.querySelector('#profile-notes-input');
    const notesSave = root.querySelector('#profile-notes-save');
    const notesStatus = root.querySelector('#profile-notes-status');
    if (!notesInput || !notesSave || !profile.avatarId) return;

    // Mark the field the moment it is actually typed in, so renderAvatar knows not
    // to replace unsaved text with the server's copy. Inferring this by comparing
    // the two cannot work: they also differ while the notes are still in flight,
    // which made an untouched empty field look like an edit and blanked the notes
    // as they arrived.
    //
    // Bound once per element, not per render: renderAvatar carries this same node
    // across its rebuilds, so an unguarded listener would stack up on it.
    const notesEl = notesInput as HTMLTextAreaElement;
    if (notesEl.dataset.dirtyBound !== '1') {
      notesEl.dataset.dirtyBound = '1';
      notesEl.addEventListener('input', function () { notesEl.dataset.dirty = '1'; });
    }

    let feedbackTimer = null;
    let timeoutTimer = null;

    function clearNotesTimers() {
      if (feedbackTimer) {
        clearTimeout(feedbackTimer);
        feedbackTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    }

    function setNotesStatus(message, kind) {
      if (!notesStatus) return;
      notesStatus.textContent = message || '';
      notesStatus.className = 'profile-notes-status' +
        (kind ? ' profile-notes-status--' + kind : '');
    }

    function releaseNotesSave(message, kind) {
      setNotesStatus(message, kind);
      feedbackTimer = setTimeout(function () {
        setNotesStatus('', '');
        notesSave.disabled = false;
        feedbackTimer = null;
      }, NOTES_FEEDBACK_MS);
    }

    notesSave.addEventListener('click', function () {
      if (notesSave.disabled) return;
      // Never file notes against a resident the field does not belong to. The
      // pane is rebuilt on every async reply, so this asserts that what is on
      // screen is still about the person this handler was bound for.
      if (notesInput.dataset.avatarId !== String(profile.avatarId || '')) {
        setNotesStatus('Notes belong to a different resident - reopen the profile.', 'error');
        return;
      }
      const text = notesInput.value || '';
      if (typeof BeeTransport.saveAvatarNotes !== 'function') return;
      const token = ++notesSaveToken;
      clearNotesTimers();
      notesSave.disabled = true;
      setNotesStatus('Saving...', 'pending');
      timeoutTimer = setTimeout(function () {
        if (token !== notesSaveToken) return;
        timeoutTimer = null;
        releaseNotesSave('Save timed out. Try again.', 'error');
      }, NOTES_SAVE_TIMEOUT_MS);
      BeeTransport.saveAvatarNotes(profile.avatarId, text).then(function (result) {
        if (token !== notesSaveToken) return;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (result && result.sent) {
          // NOTE: this used to pass { silent: true } as a third argument, but
          // mergeAvatarProfile only takes two - the flag was never read, so the
          // merge has always emitted its change event. Dropped rather than
          // implemented, to keep behaviour exactly as shipped.
          BeeProfiles.mergeAvatarProfile(profile.avatarId, {
            notes: text,
            source: 'notes-local'
          });
          // Saved, so there is no longer a draft to protect from the rebuilds.
          delete (notesInput as HTMLTextAreaElement).dataset.dirty;
          releaseNotesSave('Notes saved.', 'success');
          return;
        }
        releaseNotesSave('Could not save notes.', 'error');
      }).catch(function (err) {
        if (token !== notesSaveToken) return;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        releaseNotesSave(err.message || 'Could not save notes.', 'error');
      });
    });
  }

  function bindAvatarContent(profile, root) {
    if (!root) return;

    const title = profileTitleText(profile);
    BeeAvatarThumb.mountIn(root.querySelector('#profile-avatar-slot'), profile.avatarId, {
      label: title,
      className: 'profile-avatar-btn__thumb avatar-thumb--profile',
      resolveImage: !(profile.imageId && !BeeProfiles.isZero(profile.imageId))
    });

    const avatarBtn = root.querySelector('#profile-avatar-btn');
    if (avatarBtn) {
      avatarBtn.addEventListener('click', function () {
        const imageId = profile.imageId || BeeProfiles.getImageId(profile.avatarId);
        openImagePreview(imageId, title);
      });
    }

    const flBtn = root.querySelector('#profile-fl-image-btn');
    if (flBtn && profile.flImageId && profile.flImageId !== ZERO_UUID) {
      const preview = root.querySelector('#profile-fl-image-preview');
      if (preview) preview.src = BeeProfiles.textureImageUrl(profile.flImageId, 256);
      flBtn.addEventListener('click', function () {
        openImagePreview(profile.flImageId, title + ' profile image');
      });
    }

    root.querySelectorAll('[data-avatar-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openAvatarFromLink(btn, profile);
      });
    });
    bindGroupLinks(root, profile);
    const clearActiveBtn = root.querySelector('[data-clear-active-group]');
    if (clearActiveBtn && isSelfProfile(profile)) {
      clearActiveBtn.addEventListener('click', function () {
        if (typeof BeeTransport.activateGroup !== 'function') return;
        BeeTransport.activateGroup(ZERO_UUID).then(function (result) {
          if (result && result.sent) {
            BeeUtils.showToast('Active group cleared.', 'success');
            highlightActiveGroupInList();
            return;
          }
          BeeUtils.showToast('Could not clear active group.', 'warning');
        });
      });
    }
    bindNotesSave(profile, root);

    root.querySelectorAll('.profile-tab').forEach(function (tabBtn) {
      tabBtn.addEventListener('click', function () {
        const tabId = tabBtn.getAttribute('data-profile-tab');
        if (!tabId || !current) return;
        current.tab = tabId;
        root.querySelectorAll('.profile-tab').forEach(function (node) {
          node.classList.toggle('profile-tab--active', node.getAttribute('data-profile-tab') === tabId);
        });
        root.querySelectorAll('.profile-tab-panel').forEach(function (panel) {
          panel.classList.toggle('profile-tab-panel--active',
            panel.getAttribute('data-profile-panel') === tabId);
        });
      });
    });

    bindSplitList(root.querySelector('[data-profile-panel="places"]'), profile.picks || [], 'pick', profile);
    bindSplitList(root.querySelector('[data-profile-panel="classifieds"]'), profile.classifieds || [], 'classified', profile);
  }

  function renderAvatarActions(profile) {
    clearActions();
    const agentId = profile.avatarId;
    if (!agentId || agentId === ZERO_UUID) return;
    const isSelf = isSelfProfile(profile);
    const isFriend = typeof BeeTransport.isBuddy === 'function' && BeeTransport.isBuddy(agentId);
    const tpOnline = typeof BeeTransport.isAgentOnline === 'function'
      ? BeeTransport.isAgentOnline(agentId, profile)
      : true;
    const tpDisabled = { disabled: true, title: 'Resident is offline' };

    addAction('IM', function () {
      closeDialog();
      BeeIm.startImWith({
        id: agentId,
        name: profile.displayName || profile.userName || profile.name || 'Resident',
        displayName: profile.displayName || '',
        userName: profile.userName || ''
      });
    }, { primary: true });

    if (!isSelf) {
      addAction('Pay', function () {
        const payDialog = el<HTMLDialogElement>('pay-dialog');
        const nameEl = el('pay-target-name');
        if (!payDialog) return;
        if (nameEl) nameEl.textContent = 'Pay ' + profileTitleText(profile);
        payDialog.dataset.targetId = agentId;
        if (typeof payDialog.showModal === 'function') payDialog.showModal();
      });
      addAction('Offer teleport', function () {
        BeeTeleportUI.offerTo(agentId, profile.displayName || profile.userName || profile.name, profile);
      }, tpOnline ? undefined : tpDisabled);
      addAction('Request teleport', function () {
        BeeTeleportUI.requestFrom(agentId, profile.displayName || profile.userName || profile.name, profile);
      }, tpOnline ? undefined : tpDisabled);
      const invitable = groupsICanInviteTo();
      if (invitable.length) {
        addAction('Invite to group', function () {
          openGroupInviteDialog(agentId, profileTitleText(profile), invitable);
        });
      }
      addAction(isFriend ? 'Remove friend' : 'Add friend', async function () {
        const name = profileTitleText(profile) || 'this resident';
        if (isFriend) {
          const ok = await BeeUtils.confirm({
            title: 'Remove friend?',
            message: 'Remove ' + name + ' from your friends list?',
            confirmLabel: 'Remove',
            danger: true
          });
          if (!ok) return;
          BeeTransport.removeFriendship(agentId).then(function (result) {
            if (result && result.sent) {
              BeeUtils.showToast('Friend removed.', 'success');
              renderAvatarActions(enrichAvatarProfile(Object.assign({}, profile)));
            } else if (result && result.notFriend) {
              BeeUtils.showToast('Not on your friends list.', 'warning');
              renderAvatarActions(enrichAvatarProfile(Object.assign({}, profile)));
            } else {
              BeeUtils.showToast('Could not remove friend.', 'warning');
            }
          }).catch(function () {
            BeeUtils.showToast('Could not remove friend.', 'warning');
          });
          return;
        }
        const ok = await BeeUtils.confirm({
          title: 'Offer friendship?',
          message: 'Send a friendship offer to ' + name + '?',
          confirmLabel: 'Send offer'
        });
        if (!ok) return;
        BeeTransport.offerFriendship(agentId).then(function (result) {
          if (result && result.sent) {
            BeeUtils.showToast('Friendship offer sent.', 'success');
          } else if (result && result.alreadyFriend) {
            BeeUtils.showToast('You are already friends.', 'warning');
          } else {
            BeeUtils.showToast('Could not send friendship offer.', 'warning');
          }
        }).catch(function () {
          BeeUtils.showToast('Could not send friendship offer.', 'warning');
        });
      });

      const blockedNow = typeof BeeBuddies !== 'undefined' && BeeBuddies.isBlocked
        ? BeeBuddies.isBlocked(agentId)
        : false;
      addAction(blockedNow ? 'Unblock' : 'Block', async function () {
        const name = profileTitleText(profile) || 'this resident';
        if (blockedNow) {
          await BeeBuddies.unblock(agentId, name);
          renderAvatarActions(enrichAvatarProfile(Object.assign({}, profile)));
          return;
        }
        const ok = await BeeUtils.confirm({
          title: 'Block this resident?',
          message: 'Block ' + name + '? You will stop seeing their chat and messages, ' +
            'on this and any other viewer you use.',
          confirmLabel: 'Block',
          danger: true
        });
        if (!ok) return;
        await BeeBuddies.block(agentId, name);
        renderAvatarActions(enrichAvatarProfile(Object.assign({}, profile)));
      });
    }
  }

  // Groups where we hold GP_MEMBER_INVITE (bit 1). Powers is a 64-bit mask
  // serialized as a string, so compare through BigInt - a plain & would
  // truncate to 32 bits.
  function groupsICanInviteTo() {
    const GP_MEMBER_INVITE = 2n;
    const groups = (typeof BeeProfiles.getAgentGroups === 'function')
      ? BeeProfiles.getAgentGroups() : [];
    return groups.filter(function (g) {
      if (!g || !g.id) return false;
      try {
        return (BigInt(g.powers || 0) & GP_MEMBER_INVITE) !== 0n;
      } catch (_e) {
        return false;
      }
    }).sort(function (a, b) {
      return String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase());
    });
  }

  let groupInviteBound = false;

  function openGroupInviteDialog(agentId, displayName, groups) {
    const dlg = el<HTMLDialogElement>('group-invite-dialog');
    const select = el<HTMLSelectElement>('group-invite-select');
    const target = el('group-invite-target');
    if (!dlg || !select) return;
    if (!groupInviteBound) {
      groupInviteBound = true;
      const cancel = el<HTMLButtonElement>('group-invite-cancel');
      if (cancel) cancel.addEventListener('click', function () { BeeUtils.dismissDialog(dlg); });
      const form = el<HTMLFormElement>('group-invite-form');
      if (form) {
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          const groupId = select.value;
          const inviteeId = dlg.dataset.inviteeId;
          if (!groupId || !inviteeId) return;
          BeeBridge.invoke('sl_group_invite', { groupId: groupId, inviteeIds: [inviteeId], roleId: null })
            .then(function () {
              BeeUtils.showToast('Group invitation sent.', 'success');
              BeeUtils.dismissDialog(dlg);
            })
            .catch(function (err) {
              BeeUtils.showToast('Could not send the invitation: ' + (err.message || err), 'warning');
            });
        });
      }
    }
    select.innerHTML = '';
    groups.forEach(function (g) {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.name || g.id;
      select.appendChild(opt);
    });
    if (target) target.textContent = 'Invite ' + (displayName || 'this resident');
    dlg.dataset.inviteeId = agentId;
    if (typeof dlg.showModal === 'function') dlg.showModal();
  }

  function profileShowsAsMember(profile) {
    if (!profile || !profile.groupId) return false;
    if (typeof BeeProfiles.isAgentInGroup === 'function' &&
        BeeProfiles.isAgentInGroup(profile.groupId)) {
      return true;
    }
    return !!(current && current.type === 'group' &&
      BeeProfiles.normId(current.id) === BeeProfiles.normId(profile.groupId) &&
      current.isMemberHint);
  }

  function enrichGroupProfile(profile) {
    if (!profile) return profile;
    const next = Object.assign({}, profile);
    next.isMember = profileShowsAsMember(next);
    if (!next.isMember) next.memberTitle = '';
    next.isActive = typeof BeeProfiles.isActiveGroup === 'function' && BeeProfiles.isActiveGroup(next.groupId);
    // getGroupTitles returns { titles, complete } or null - never a bare array.
    // Handing that straight to .find() used to crash group profiles with
    // "Cannot read properties of null (reading 'find')".
    const gt = typeof BeeProfiles.getGroupTitles === 'function'
      ? BeeProfiles.getGroupTitles(next.groupId)
      : null;
    next.titles = gt && Array.isArray(gt.titles) ? gt.titles : (Array.isArray(gt) ? gt : []);
    const selectedTitle = next.titles.find(function (row) { return row.selected; });
    next.selectedTitleRoleId = selectedTitle ? selectedTitle.roleId : '';
    if (selectedTitle && selectedTitle.title) next.memberTitle = selectedTitle.title;
    if (current && current.nameHint) {
      const hintName = String(current.nameHint.name || '').trim();
      if (hintName && !next.name) next.name = hintName;
    }
    if (next.founderId && next.founderId !== ZERO_UUID) {
      if (typeof BeeTransport.getCachedNameInfo === 'function') {
        const info = BeeTransport.getCachedNameInfo(next.founderId);
        if (info) next.founderName = info.displayName || info.label || '';
      }
      if (!next.founderName && typeof BeeTransport.getCachedName === 'function') {
        next.founderName = BeeTransport.getCachedName(next.founderId) || '';
      }
    }
    return next;
  }

  function queueGroupNames(profile) {
    if (!profile || typeof BeeTransport.queueNameResolve !== 'function') return;
    if (profile.founderId && profile.founderId !== ZERO_UUID) {
      BeeTransport.queueNameResolve([profile.founderId]);
    }
  }

  function renderGroupKeyMeta(profile) {
    return '<div class="profile-desc-meta profile-desc-meta--key">' +
      '<div class="profile-meta-item">' +
      '<span class="profile-meta-item__label">Key</span>' +
      '<span class="profile-meta-item__value"><code class="profile-uuid">' +
      BeeUtils.escapeHtml(profile.groupId) + '</code></span></div></div>';
  }

  function renderGroupFounderField(profile) {
    if (!profile.founderId || profile.founderId === ZERO_UUID) return '';
    const label = profile.founderName || 'View profile';
    return '<div class="profile-field"><span class="profile-field__label">Founder</span>' +
      '<span><button type="button" class="profile-link" data-avatar-id="' +
      BeeUtils.escapeHtml(profile.founderId) + '">' + BeeUtils.escapeHtml(label) + '</button></span></div>';
  }

  function renderGroupTitleSection(profile) {
    if (!profile.isMember) return '';
    const titles = profile.titles || [];
    const settled = typeof BeeProfiles.isGroupTitlesFetchSettled === 'function' &&
      BeeProfiles.isGroupTitlesFetchSettled(profile.groupId);
    const wrap = function (body) {
      return '<section class="profile-section profile-section--title">' +
        '<h3 class="profile-section__title">Active title</h3>' +
        '<p class="profile-group-title-hint">The title shown next to your name in this group.</p>' +
        body + '</section>';
    };
    // No titles yet - just show the current one (or a loading/empty note), no picker.
    if (!titles.length) {
      const fallback = String(profile.memberTitle || '').trim();
      if (settled && fallback) {
        return wrap('<div class="profile-field"><span>' + BeeUtils.escapeHtml(fallback) + '</span></div>');
      }
      return wrap('<p class="profile-section__empty">' +
        (settled ? 'No titles available for this group.' : 'Loading titles...') + '</p>');
    }
    const selectedId = profile.selectedTitleRoleId || '';
    const options = titles.map(function (row) {
      const selected = row.roleId === selectedId ? ' selected' : '';
      // A group's default/Everyone title can be blank, so show a placeholder to
      // keep it selectable rather than an empty, invisible option.
      const label = row.title && row.title.trim() ? row.title : '(no title)';
      return '<option value="' + BeeUtils.escapeHtml(row.roleId) + '"' + selected + '>' +
        BeeUtils.escapeHtml(label) + '</option>';
    }).join('');
    const disabled = titles.length <= 1 ? ' disabled' : '';
    // Title dropdown plus Save, with the current title preselected.
    return wrap(
      '<div class="profile-group-title-row">' +
      '<select id="profile-group-title-select" class="profile-group-title-select"' + disabled + '>' +
      options + '</select>' +
      '<button type="button" class="btn btn--primary" id="profile-group-title-save"' + disabled + '>Save</button>' +
      '</div>' +
      '<div id="profile-group-title-status" class="profile-notes-status" role="status" aria-live="polite"></div>'
    );
  }

  function renderGroupSideMeta(profile) {
    let html = '<div class="profile-field"><span class="profile-field__label">Join fee</span><span>' +
      BeeUtils.escapeHtml(formatGroupJoinFee(profile)) + '</span></div>';
    if (profile.money !== undefined && profile.money !== null) {
      html += '<div class="profile-field"><span class="profile-field__label">Treasury</span><span>L$ ' +
        Number(profile.money).toLocaleString('en-US') + '</span></div>';
    }
    if (profile.rolesCount !== undefined && profile.rolesCount !== null) {
      // The reply's count leaves out the implicit Everyone role.
      html += '<div class="profile-field"><span class="profile-field__label">Roles</span><span>' +
        BeeUtils.escapeHtml(String(Number(profile.rolesCount) + 1)) + '</span></div>';
    }
    if (profile.showInList !== undefined) {
      html += '<div class="profile-field"><span class="profile-field__label">Search</span><span>' +
        BeeUtils.escapeHtml(profile.showInList ? 'Visible in search' : 'Hidden from search') + '</span></div>';
    }
    return html;
  }

  function renderGroupTab(profile) {
    const charterHtml = sanitizeProfileHtml(profile.charter || '');
    return '<div class="profile-pane profile-pane--group">' +
      '<div class="profile-resident__columns">' +
      '<div class="profile-resident__side profile-group__side">' +
      '<button type="button" class="profile-avatar-btn profile-group-insignia-btn" id="profile-group-insignia-btn" ' +
        'title="View larger image" aria-label="View larger group insignia">' +
      '<span id="profile-group-insignia-slot" class="profile-avatar-btn__slot"></span></button>' +
      '<div class="profile-field"><span class="profile-field__label">Enrollment</span><span>' +
        BeeUtils.escapeHtml(profile.openEnrollment ? 'Open enrollment' : 'Closed enrollment') + '</span></div>' +
      '<div class="profile-field"><span class="profile-field__label">Content</span><span>' +
        BeeUtils.escapeHtml(profile.maturePublish ? 'Mature' : 'General') + '</span></div>' +
      renderGroupSideMeta(profile) +
      renderGroupFounderField(profile) +
      '</div>' +
      '<div class="profile-resident__about profile-group__about">' +
      renderGroupKeyMeta(profile) +
      renderAboutBlock(charterHtml, 'No charter text.') +
      // The active-title picker sits under the description in the right column;
      // the Activate control lives in the actions bar (renderGroupActions).
      renderGroupTitleSection(profile) +
      '</div></div>' +
      '</div>';
  }

  function bindGroupContent(profile, root) {
    if (!root) return;
    const title = profile.name || 'Group';
    const insigniaId = profile.insigniaId || BeeProfiles.getGroupInsigniaId(profile.groupId);
    BeeAvatarThumb.mountIn(root.querySelector('#profile-group-insignia-slot'), profile.groupId, {
      kind: 'group',
      label: title,
      imageId: insigniaId,
      className: 'profile-avatar-btn__thumb avatar-thumb--profile',
      resolveImage: true
    });
    const insigniaBtn = root.querySelector('#profile-group-insignia-btn');
    if (insigniaBtn) {
      insigniaBtn.addEventListener('click', function () {
        const imageId = profile.insigniaId || BeeProfiles.getGroupInsigniaId(profile.groupId);
        if (imageId && !BeeProfiles.isZero(imageId)) openImagePreview(imageId, title + ' insignia');
      });
    }
    root.querySelectorAll('[data-avatar-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openAvatarFromLink(btn, profile);
      });
    });
    bindGroupTitleSave(profile, root);
  }

  function bindGroupTitleSave(profile, root) {
    const select = root.querySelector('#profile-group-title-select');
    const saveBtn = root.querySelector('#profile-group-title-save');
    const statusEl = root.querySelector('#profile-group-title-status');
    if (!select || !saveBtn || !profile.isMember || !profile.groupId) return;

    const savedRoleId = profile.selectedTitleRoleId || '';
    const titles = profile.titles || [];

    function setStatus(message, kind) {
      if (!statusEl) return;
      statusEl.textContent = message || '';
      statusEl.className = 'profile-notes-status' +
        (kind ? ' profile-notes-status--' + kind : '');
    }

    function updateSaveState() {
      if (titles.length <= 1) {
        saveBtn.disabled = true;
        return;
      }
      saveBtn.disabled = select.value === savedRoleId;
    }

    select.addEventListener('change', updateSaveState);
    updateSaveState();

    saveBtn.addEventListener('click', function () {
      if (saveBtn.disabled) return;
      if (typeof BeeProfiles.isAgentInGroup === 'function' &&
          !BeeProfiles.isAgentInGroup(profile.groupId)) {
        setStatus('You are not a member of this group.', 'error');
        return;
      }
      const roleId = select.value;
      if (!roleId) return;
      saveBtn.disabled = true;
      setStatus('Saving...', 'pending');
      const save = typeof BeeTransport.saveGroupTitle === 'function'
        ? BeeTransport.saveGroupTitle(profile.groupId, roleId)
        : Promise.resolve({ sent: false });
      save.then(function (result) {
        if (!current || current.type !== 'group' || current.id !== profile.groupId) return;
        if (result && result.sent) {
          setStatus('Title saved.', 'success');
          const cached = BeeProfiles.getGroupProfile(profile.groupId);
          renderGroup(enrichGroupProfile(Object.assign({}, cached || profile)));
          return;
        }
        setStatus('Could not save title.', 'error');
        updateSaveState();
      }).catch(function (err) {
        setStatus(err.message || 'Could not save title.', 'error');
        updateSaveState();
      });
    });
  }

  function renderGroupActions(profile) {
    clearActions();
    const groupId = profile.groupId;
    const groupName = profile.name || 'this group';
    if (!groupId || groupId === ZERO_UUID) return;
    if (profile.isMember) {
      addAction('Open group chat', function () {
        closeDialog();
        BeeIm.openGroupChat(groupId, profile.name || '');
      }, { primary: true });
      if (profile.isActive) {
        addAction('Active group', function () {}, {
          disabled: true,
          title: 'This is your active group'
        });
      } else {
        addAction('Activate', function () {
          if (typeof BeeTransport.activateGroup !== 'function') return;
          BeeTransport.activateGroup(groupId).then(function (result) {
            if (result && result.sent) {
              BeeUtils.showToast('Active group updated.', 'success');
              renderGroup(enrichGroupProfile(Object.assign({}, profile, { isActive: true })));
              return;
            }
            BeeUtils.showToast('Could not activate group.', 'warning');
          }).catch(function () {
            // The command itself failed (e.g. not connected).
            BeeUtils.showToast('Could not activate group.', 'warning');
          });
        });
      }
      addAction('Leave group', async function () {
        const ok = await BeeUtils.confirm({
          title: 'Leave group?',
          message: 'Leave ' + groupName + '?',
          confirmLabel: 'Leave',
          danger: true
        });
        if (!ok) return;
        BeeTransport.leaveGroup(groupId).then(function (result) {
          if (result && result.success) {
            BeeUtils.showToast('Left ' + groupName + '.', 'success');
            const next = enrichGroupProfile(Object.assign({}, profile, { isMember: false }));
            renderGroup(next);
            return;
          }
          BeeUtils.showToast(result && result.timedOut
            ? 'The group server did not answer - try again.'
            : 'Could not leave group.', 'warning');
        }).catch(function () {
          BeeUtils.showToast('Could not leave group.', 'warning');
        });
      }, { danger: true });
      return;
    }
    if (profile.openEnrollment) {
      const fee = Number(profile.membershipFee) || 0;
      const label = fee > 0 ? 'Join (L$ ' + fee.toLocaleString('en-US') + ')' : 'Join';
      addAction(label, async function () {
        const feeMsg = fee > 0
          ? 'Join ' + groupName + ' for L$ ' + fee.toLocaleString('en-US') + '?'
          : 'Join ' + groupName + '?';
        const ok = await BeeUtils.confirm({
          title: 'Join group?',
          message: feeMsg,
          confirmLabel: 'Join'
        });
        if (!ok) return;
        // Being a member already never reaches the wire: short-circuit locally.
        if (typeof BeeProfiles.isAgentInGroup === 'function' && BeeProfiles.isAgentInGroup(groupId)) {
          BeeUtils.showToast('You are already a member.', 'warning');
          renderGroup(enrichGroupProfile(Object.assign({}, profile, { isMember: true })));
          return;
        }
        BeeTransport.joinGroup(groupId).then(function (result) {
          if (result && result.success) {
            BeeUtils.showToast('Joined ' + groupName + '.', 'success');
            const next = enrichGroupProfile(Object.assign({}, profile, { isMember: true }));
            renderGroup(next);
            return;
          }
          BeeUtils.showToast(result && result.timedOut
            ? 'The group server did not answer - try again.'
            : 'Could not join group.', 'warning');
        }).catch(function () {
          BeeUtils.showToast('Could not join group.', 'warning');
        });
      });
    }
  }

  function bindGroupLinks(root, profile) {
    if (!root) return;
    const fromSelf = profile && profile.avatarId && isSelfProfile(profile);
    root.querySelectorAll('[data-group-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const groupId = btn.getAttribute('data-group-id');
        const opts: { group?: { name: string }; isMember?: boolean } = {};
        const label = String(btn.textContent || '').trim();
        if (label) opts.group = { name: label };
        if (fromSelf) opts.isMember = true;
        openGroup(groupId, opts);
      });
    });
  }

  function renderAvatar(profile) {
    if (dialog) {
      dialog.classList.add('profile-dialog--avatar');
      dialog.classList.remove('profile-dialog--group');
    }
    updateProfileHeader(profile);

    const content = el('profile-content');
    if (!content) return;
    // Profile data arrives as a stream of separate replies - properties,
    // interests, groups, notes, picks, classifieds, the cap fetch, name
    // resolution - and every one of them lands here and rebuilds this pane. That
    // destroys each live widget inside it several times while the profile is
    // merely open.
    //
    // A persistent-panel design avoids this entirely: build the notes editor once
    // when the profile opens and let a notes reply set its value in place, so
    // nothing is destroyed and nothing has to be reconstructed. This pane is not
    // built that way yet, so it has to survive the rebuild instead.
    //
    // So carry the real element across the rebuild instead of trying to work out
    // afterwards what it held. Text, selection, scroll position and listeners
    // all survive because it is the same node; the only things taken from the
    // fresh markup are whether the notes have loaded yet and, unless the user
    // has unsaved typing, their text.
    //
    // The id check keeps this to the SAME resident: the container is reused when
    // another profile opens, and carrying the node over would put one person's
    // notes in another's field, where a save would file them against the wrong
    // resident.
    const liveNotes = content.querySelector<HTMLTextAreaElement>('#profile-notes-input');
    const keepNotes = liveNotes &&
      liveNotes.dataset.avatarId === String(profile.avatarId || '') ? liveNotes : null;
    const notesFocused = !!keepNotes && document.activeElement === keepNotes;
    const notesStart = keepNotes ? keepNotes.selectionStart : 0;
    const notesEnd = keepNotes ? keepNotes.selectionEnd : 0;

    content.innerHTML = renderAvatarTabs(profile);

    if (keepNotes) {
      const fresh = content.querySelector<HTMLTextAreaElement>('#profile-notes-input');
      if (fresh) {
        if (!BeeUtils.shouldPreserveDraft(
              keepNotes.dataset.avatarId, profile.avatarId, keepNotes.dataset.dirty)) {
          keepNotes.value = fresh.value;
        }
        keepNotes.readOnly = fresh.readOnly;
        keepNotes.placeholder = fresh.placeholder;
        fresh.replaceWith(keepNotes);
      }
    }

    // After the swap, so the handlers bind to the element that is actually in
    // the tree rather than the one just discarded.
    bindAvatarContent(profile, content);

    if (keepNotes && notesFocused) {
      keepNotes.focus();
      try { keepNotes.setSelectionRange(notesStart, notesEnd); } catch (_e) { /* ok */ }
    }
    renderAvatarActions(profile);
    setLoading(false);
  }

  function queueGroupTitles(profile) {
    if (!profile || !profile.groupId || !profileShowsAsMember(profile)) return;
    if (typeof BeeProfiles.fetchGroupTitles !== 'function') return;
    const groupId = profile.groupId;
    const settled = typeof BeeProfiles.isGroupTitlesFetchSettled === 'function' &&
      BeeProfiles.isGroupTitlesFetchSettled(groupId);
    const hasTitles = typeof BeeProfiles.hasGroupTitlesCache === 'function' &&
      BeeProfiles.hasGroupTitlesCache(groupId);
    if (current && current.titlesRequested === groupId && (hasTitles || settled)) {
      return;
    }
    if (current) current.titlesRequested = groupId;
    const opts: { isMember: boolean; force?: boolean } = { isMember: true };
    if (settled && !hasTitles) opts.force = true;
    BeeProfiles.fetchGroupTitles(groupId, opts).then(function (titles) {
      if (!current || current.type !== 'group' || current.id !== BeeProfiles.normId(groupId)) return;
      if (titles && titles.length) {
        const cached = BeeProfiles.getGroupProfile(groupId);
        if (cached) patchGroupTitles(cached);
      }
    }).catch(function () {});
  }

  function groupViewKey(profile) {
    const enriched = enrichGroupProfile(profile);
    const titles = (enriched.titles || []).map(function (row) {
      return row.roleId + ':' + (row.selected ? '1' : '0') + ':' + row.title;
    }).join('|');
    return [
      enriched.groupId,
      enriched.name,
      enriched.charter,
      enriched.isMember ? 1 : 0,
      enriched.isActive ? 1 : 0,
      enriched.memberTitle,
      enriched.founderId,
      enriched.founderName,
      enriched.insigniaId,
      titles
    ].join('\n');
  }

  function patchGroupTitles(profile) {
    const enriched = enrichGroupProfile(Object.assign({}, profile));
    const titles = enriched.titles || [];
    const settled = typeof BeeProfiles.isGroupTitlesFetchSettled === 'function' &&
      BeeProfiles.isGroupTitlesFetchSettled(enriched.groupId);
    if (!titles.length && !settled) return false;
    const content = el('profile-content');
    if (!content) return false;
    const panel = content.querySelector('.profile-main-panel');
    if (!panel) return false;
    const html = renderGroupTitleSection(enriched);
    if (!html) return false;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const next = wrap.firstElementChild;
    if (!next) return false;
    const existing = panel.querySelector('.profile-section--title');
    if (existing) existing.replaceWith(next);
    else panel.appendChild(next);
    bindGroupTitleSave(enriched, content);
    renderGroupActions(enriched);
    lastGroupViewKey = groupViewKey(enriched);
    return true;
  }

  function updateGroupFounderLabel(profile) {
    if (!profile || !profile.founderId || profile.founderId === ZERO_UUID) return;
    const content = el('profile-content');
    if (!content) return;
    const btn = content.querySelector('[data-avatar-id="' + profile.founderId + '"]');
    if (!btn) return;
    const label = profile.founderName || 'View profile';
    if (btn.textContent !== label) btn.textContent = label;
  }

  function scheduleGroupRefresh() {
    if (groupRefreshTimer) clearTimeout(groupRefreshTimer);
    groupRefreshTimer = setTimeout(function () {
      groupRefreshTimer = null;
      if (!current || current.type !== 'group' || !dialog || !dialog.open) return;
      const profile = BeeProfiles.getGroupProfile(current.id);
      if (profile) renderGroup(Object.assign({}, profile));
    }, 100);
  }

  function refreshGroupLabels(profile) {
    const enriched = enrichGroupProfile(Object.assign({}, profile));
    updateGroupHeader(enriched);
    updateGroupFounderLabel(enriched);
  }

  function renderGroup(profile) {
    if (dialog) {
      dialog.classList.remove('profile-dialog--avatar');
      dialog.classList.add('profile-dialog--group');
    }
    const enriched = enrichGroupProfile(profile);
    const viewKey = groupViewKey(enriched);
    const content = el('profile-content');
    if (!content) return;
    if (viewKey === lastGroupViewKey && content.querySelector('.profile-main-panel')) {
      updateGroupHeader(enriched);
      updateGroupFounderLabel(enriched);
      renderGroupActions(enriched);
      setLoading(false);
      return;
    }
    lastGroupViewKey = viewKey;
    updateGroupHeader(enriched);
    queueGroupNames(enriched);
    queueGroupTitles(enriched);
    content.innerHTML = '<div class="profile-main-panel">' + renderGroupTab(enriched) + '</div>';
    bindGroupContent(enriched, content);
    renderGroupActions(enriched);
    setLoading(false);
  }

  function enrichAvatarProfile(profile) {
    const id = profile.avatarId;
    const hint = (current && current.nameHint) || findKnownAgent(id);
    applyNameHint(profile, hint);
    const nameInfo = typeof BeeTransport.getCachedNameInfo === 'function'
      ? BeeTransport.getCachedNameInfo(id)
      : null;
    if (nameInfo) {
      profile.displayName = nameInfo.displayName || profile.displayName || '';
      profile.userName = nameInfo.userName || profile.userName || '';
      profile.name = nameInfo.label || profile.name || '';
    } else if (typeof BeeTransport.getCachedName === 'function') {
      const cached = BeeTransport.getCachedName(id);
      if (cached) profile.name = profile.name || cached;
    }
    if (profile.partnerId && profile.partnerId !== ZERO_UUID) {
      const partnerInfo = typeof BeeTransport.getCachedNameInfo === 'function'
        ? BeeTransport.getCachedNameInfo(profile.partnerId)
        : null;
      profile.partnerName = partnerInfo
        ? (partnerInfo.displayName || partnerInfo.label || '')
        : (typeof BeeTransport.getCachedName === 'function' ? BeeTransport.getCachedName(profile.partnerId) : '');
    }
    return profile;
  }

  function finishAvatarProfile(profile) {
    if (!current || current.type !== 'avatar' || !profile) return;
    const id = profile.avatarId || current.id;
    const capActive = typeof BeeProfiles.isCapFetchActive === 'function' &&
      BeeProfiles.isCapFetchActive(id);
    const capReady = profileCapAboutReady(profile);
    current.capFetchPending = capActive;
    const next = enrichAvatarProfile(Object.assign({}, profile));
    next.aboutFetching = capActive && !capReady;
    if (next.aboutFetching) next.about = '';
    queueProfileNames(next);
    renderAvatar(next);
  }

  function scheduleCapProfileRetry(id, attempt) {
    if (attempt >= 12) {
      if (!current || current.id !== id || current.type !== 'avatar') return;
      const row = BeeProfiles.getAvatarProfile(id) || { avatarId: id };
      finishAvatarProfile(enrichAvatarProfile(Object.assign({}, row)));
      return;
    }
    setTimeout(function () {
      if (!current || current.id !== id || current.type !== 'avatar') return;
      BeeProfiles.fetchAvatarProfile(id, { force: true, quiet: true })
        .then(function (fresh) { finishAvatarProfile(fresh); })
        .catch(function () { scheduleCapProfileRetry(id, attempt + 1); });
    }, 2000);
  }

  function looksLikeUuidLabel(text) {
    const value = String(text || '').trim().toLowerCase();
    if (!value) return false;
    if (value.endsWith('...') && value.length === 11) {
      return /^[0-9a-f]+$/.test(value.slice(0, 8));
    }
    return value.length >= 13 && value.charAt(8) === '-' && value.charAt(13) === '-' &&
      /^[0-9a-f-]+$/.test(value);
  }

  function openAvatarFromLink(btn, context) {
    if (!btn) return;
    const avatarId = btn.getAttribute('data-avatar-id');
    if (!avatarId) return;
    const opts: { agent?: any } = {};
    let hint = null;
    if (context && context.founderId &&
        BeeProfiles.normId(context.founderId) === BeeProfiles.normId(avatarId)) {
      const founderName = String(context.founderName || '').trim();
      if (founderName && founderName !== 'View profile' && !looksLikeUuidLabel(founderName)) {
        hint = { id: avatarId, name: founderName, displayName: founderName };
      }
    }
    if (!hint) {
      const label = String(btn.textContent || '').trim();
      if (label && label !== 'View profile' && !looksLikeUuidLabel(label)) {
        hint = { id: avatarId, name: label, displayName: label };
      }
    }
    if (!hint) hint = findKnownAgent(avatarId);
    if (hint) opts.agent = hint;
    openAvatar(avatarId, opts);
  }

  function openAvatar(agentId, options?) {
    const id = BeeProfiles.normId(agentId);
    if (BeeProfiles.isZero(id)) return;
    if (!dialog) return;
    const keepTab = current && current.type === 'avatar' && current.id === id ? current.tab : 'resident';
    const nameHint = (options && options.agent) || findKnownAgent(id);
    current = {
      type: 'avatar',
      id: id,
      tab: keepTab,
      selectedPickId: '',
      selectedClassifiedId: '',
      nameHint: nameHint || null,
      capFetchPending: true
    };
    setLoading(true);
    clearActions();
    // Right-click anywhere in the dialog offers "Copy UUID"/"Copy name" via
    // the shared context menu.
    dialog.dataset.agentId = id;
    delete dialog.dataset.groupId;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    if (nameHint) {
      updateProfileHeader(enrichAvatarProfile({ avatarId: id }));
    }
    queueProfileNames({ avatarId: id });

    const cached = BeeProfiles.getAvatarProfile(id);
    const needsCap = typeof BeeProfiles.needsCapProfileFetch === 'function'
      ? BeeProfiles.needsCapProfileFetch(cached)
      : true;
    const mustFetch = needsCap || !cached || !!(options && options.force);
    current.capFetchPending = mustFetch;

    const profile = cached
      ? enrichAvatarProfile(Object.assign({}, cached))
      : enrichAvatarProfile({ avatarId: id });
    queueProfileNames(profile);
    // Fetch picks/classifieds/notes on every open, not just when cached -
    // otherwise the first time a profile is opened they never load and the user
    // has to reopen it. The reply re-renders through the BeeProfiles onChange.
    ensureProfileExtras({ avatarId: id });
    renderAvatar(profile);

    if (!mustFetch) return;

    BeeProfiles.fetchAvatarProfile(id, { force: true, quiet: true }).then(function (fresh) {
      if (!current || current.id !== id || current.type !== 'avatar') return;
      finishAvatarProfile(fresh);
      if (typeof BeeTransport.getCachedNameInfo === 'function') {
        const info = BeeTransport.getCachedNameInfo(id);
        if (info && info.label) updateProfileHeader(enrichAvatarProfile(Object.assign({}, fresh)));
      }
      if (typeof BeeProfiles.needsCapProfileFetch === 'function' &&
          BeeProfiles.needsCapProfileFetch(fresh) &&
          typeof BeeProfiles.hasAgentProfileCap === 'function' &&
          BeeProfiles.hasAgentProfileCap()) {
        scheduleCapProfileRetry(id, 0);
      }
    }).catch(function (err) {
      if (!current || current.id !== id || current.type !== 'avatar') return;
      if (typeof BeeProfiles.hasAgentProfileCap === 'function' && BeeProfiles.hasAgentProfileCap()) {
        scheduleCapProfileRetry(id, 0);
        return;
      }
      const fallback = enrichAvatarProfile(Object.assign({}, BeeProfiles.getAvatarProfile(id) || cached || { avatarId: id }));
      finishAvatarProfile(fallback);
    });
  }

  function openGroup(groupId, options?) {
    const id = BeeProfiles.normId(groupId);
    if (BeeProfiles.isZero(id)) return;
    if (!dialog) return;
    const nameHint = (options && options.group) || null;
    current = {
      type: 'group',
      id: id,
      nameHint: nameHint,
      isMemberHint: !!(options && options.isMember),
      titlesRequested: ''
    };
    lastGroupViewKey = '';
    setLoading(true);
    clearActions();
    dialog.dataset.groupId = id;
    delete dialog.dataset.agentId;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    if (nameHint && nameHint.name) {
      updateGroupHeader(enrichGroupProfile({ groupId: id, name: nameHint.name }));
    }

    const cached = BeeProfiles.getGroupProfile(id);
    if (cached && !(options && options.force)) {
      renderGroup(Object.assign({}, cached));
      return;
    }

    BeeProfiles.fetchGroupProfile(id, options).then(function (profile) {
      if (!current || current.id !== id || current.type !== 'group') return;
      renderGroup(Object.assign({}, profile));
    }).catch(function (err) {
      if (!current || current.id !== id) return;
      const content = el('profile-content');
      if (content) {
        content.hidden = false;
        content.innerHTML = '<p class="profile-section__empty">' +
          BeeUtils.escapeHtml(err.message || 'Could not load group profile') + '</p>';
      }
      setLoading(false);
    });
  }

  function refreshCurrentProfile() {
    if (!current || !dialog || !dialog.open) return;
    if (current.type === 'avatar') {
      const profile = BeeProfiles.getAvatarProfile(current.id);
      if (!profile) return;
      finishAvatarProfile(profile);
      return;
    }
    if (current.type === 'group') {
      const profile = BeeProfiles.getGroupProfile(current.id);
      if (profile) renderGroup(Object.assign({}, profile));
    }
  }

  function init() {
    dialog = el<HTMLDialogElement>('profile-dialog');
    imageDialog = el<HTMLDialogElement>('profile-image-dialog');
    const closeBtn = el<HTMLButtonElement>('profile-close');
    const imageCloseBtn = el<HTMLButtonElement>('profile-image-close');
    if (closeBtn && dialog) {
      closeBtn.addEventListener('click', function () { closeDialog(); });
    }
    if (imageCloseBtn && imageDialog) {
      imageCloseBtn.addEventListener('click', function () { BeeUtils.dismissDialog(imageDialog); });
    }
    if (dialog) {
      dialog.addEventListener('close', function () { current = null; });
      dialog.addEventListener('cancel', function () { current = null; });
    }
    if (imageDialog) {
      imageDialog.addEventListener('click', function (evt) {
        if (evt.target === imageDialog) BeeUtils.dismissDialog(imageDialog);
      });
    }
    BeeProfiles.onChange(function (evt) {
      if (!current || !dialog || !dialog.open) return;
      if (current.type === 'avatar' && evt.id === current.id &&
          (evt.kind === 'avatar' || evt.kind === 'avatar-fetching')) {
        if (evt.kind === 'avatar-fetching') {
          const base = BeeProfiles.getAvatarProfile(current.id) || { avatarId: current.id };
          const profile = enrichAvatarProfile(Object.assign({}, base));
          if (typeof BeeProfiles.isCapFetchActive === 'function' &&
              BeeProfiles.isCapFetchActive(current.id) &&
              !profileCapAboutReady(profile)) {
            profile.aboutFetching = true;
            profile.about = '';
          }
          renderAvatar(profile);
          return;
        }
        refreshCurrentProfile();
        return;
      }
      if (current.type === 'group' && evt.kind === 'group' && evt.id === current.id) {
        const profile = BeeProfiles.getGroupProfile(current.id);
        if (!profile) return;
        if (patchGroupTitles(profile)) return;
        scheduleGroupRefresh();
        return;
      }
      if (current.type === 'group' && evt.kind === 'group-titles' && evt.id === current.id) {
        const profile = BeeProfiles.getGroupProfile(current.id);
        if (profile && patchGroupTitles(profile)) return;
        return;
      }
      if (current.type === 'group' && evt.kind === 'active-group') {
        const profile = BeeProfiles.getGroupProfile(current.id);
        if (!profile) return;
        renderGroupActions(enrichGroupProfile(Object.assign({}, profile)));
        return;
      }
      if (current.type === 'group' && evt.kind === 'membership') {
        lastGroupViewKey = '';
        if (current.id) {
          const openProfile = BeeProfiles.getGroupProfile(current.id);
          if (openProfile) {
            queueGroupTitles(enrichGroupProfile(Object.assign({}, openProfile)));
          }
        }
        scheduleGroupRefresh();
        return;
      }
      if (current.type === 'avatar' && evt.kind === 'membership' &&
          isSelfProfile({ avatarId: current.id })) {
        const profile = BeeProfiles.getAvatarProfile(current.id);
        if (profile && !patchSelfGroupsSection(profile)) refreshCurrentProfile();
        return;
      }
      if (current.type === 'avatar' && evt.kind === 'active-group' && isSelfProfile({ avatarId: current.id })) {
        const profile = BeeProfiles.getAvatarProfile(current.id);
        if (profile && !patchSelfGroupsSection(profile)) highlightActiveGroupInList();
        else highlightActiveGroupInList();
        return;
      }
      if (current.type !== 'avatar') return;
      if (evt.kind === 'pick-detail' && current.selectedPickId === evt.id) {
        const detailEl = findDetailPane('places');
        const detail = BeeProfiles.getPickDetail(evt.id);
        if (detailEl && detail) {
          paintItemDetail(detailEl, detail, 'pick');
        }
        return;
      }
      if (evt.kind === 'classified-detail' && current.selectedClassifiedId === evt.id) {
        const detailEl = findDetailPane('classifieds');
        const detail = BeeProfiles.getClassifiedDetail(evt.id);
        if (detailEl && detail) {
          paintItemDetail(detailEl, detail, 'classified');
        }
      }
    });
    if (typeof BeeTransport.on === 'function') {
      BeeTransport.on('names-updated', function () {
        if (!current || !dialog || !dialog.open) return;
        if (current.type === 'avatar') {
          const profile = BeeProfiles.getAvatarProfile(current.id);
          if (profile) updateProfileHeader(enrichAvatarProfile(Object.assign({}, profile)));
          return;
        }
        if (current.type === 'group') {
          const profile = BeeProfiles.getGroupProfile(current.id);
          if (profile) refreshGroupLabels(profile);
        }
      });
      BeeTransport.on('buddies-updated', function () {
        if (!current || current.type !== 'avatar' || !dialog || !dialog.open) return;
        const profile = BeeProfiles.getAvatarProfile(current.id);
        if (!profile) return;
        const enriched = enrichAvatarProfile(Object.assign({}, profile));
        updateProfileHeader(enriched);
        renderAvatarActions(enriched);
      });
    }
  }

  return {
    init: init,
    openAvatar: openAvatar,
    openGroup: openGroup,
    close: closeDialog
  };
})();
