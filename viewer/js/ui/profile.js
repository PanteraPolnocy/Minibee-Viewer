/**
 * Avatar and group profile floater.
 */
const FSProfile = (function () {
  'use strict';

  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
  const PROFILE_STALE_MS = 15 * 60 * 1000;
  const AVATAR_TABS = [
    { id: 'resident', label: 'Resident' },
    { id: 'web', label: 'Web' },
    { id: 'places', label: 'Places' },
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

  function el(id) {
    return document.getElementById(id);
  }

  function sanitizeProfileHtml(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const allowed = /^(b|i|u|br|a|p|div|span|ul|ol|li|strong|em)$/i;
    const template = document.createElement('template');
    template.innerHTML = raw.replace(/\n/g, '<br>');
    template.content.querySelectorAll('*').forEach(function (node) {
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

  function addAction(label, handler, options) {
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
    if (dialog && dialog.open) dialog.close();
    current = null;
  }

  function teleportFromProfileDetail(loc) {
    if (!loc) return;
    if (!FSState.gridOnline()) {
      FSUtils.showToast('Not connected to the grid', 'warning');
      return;
    }
    if (typeof FSMap !== 'undefined') {
      if (FSMap.showLocation) FSMap.showLocation(loc);
      if (FSMap.beginMapTeleport) FSMap.beginMapTeleport('requesting');
    }
    closeDialog();
    if (typeof FSTransport.teleportTo !== 'function') return;
    FSTransport.teleportTo(loc).then(function () {
      if (typeof FSMap !== 'undefined' && FSMap.beginMapTeleport) {
        FSMap.beginMapTeleport('starting');
      }
    }).catch(function (err) {
      if (typeof FSMap !== 'undefined' && FSMap.resetTeleportButton) {
        FSMap.resetTeleportButton();
      }
      FSUtils.showToast(err.message || 'Teleport failed', 'error');
    });
  }

  function shortUuid(id) {
    const text = String(id || '');
    return text ? text.slice(0, 8) + '...' : '';
  }

  function profileTitleText(profile) {
    const displayName = String(profile.displayName || '').trim();
    const userName = String(profile.userName || profile.legacyName || '').trim();
    const fallback = String(profile.name || '').trim();
    if (displayName && userName && displayName.toLowerCase() !== userName.toLowerCase()) {
      return displayName + ' (' + userName + ')';
    }
    if (displayName) return displayName;
    if (userName) return userName;
    if (fallback && fallback !== '?') return fallback;
    if (typeof FSTransport.getCachedName === 'function') {
      const cached = FSTransport.getCachedName(profile.avatarId);
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
        FSUtils.escapeHtml(String(profile.memberCount.toLocaleString('en-US'))) + ' members</strong>');
    }
    parts.push(FSUtils.escapeHtml(profile.openEnrollment ? 'Open enrollment' : 'Closed enrollment'));
    parts.push(FSUtils.escapeHtml(profile.maturePublish ? 'Mature' : 'General'));
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
    if (profile.charterMember) parts.push('Charter member');
    if (profile.caption) parts.push(profile.caption);
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
      FSUtils.escapeHtml(profile.avatarId) + '</code></span></div></div>';
  }

  function renderResidentSideMeta(profile) {
    let html = '';
    const born = FSProfiles.formatBornLabel(profile.bornOn, profile.hideAge);
    if (born) {
      html += '<div class="profile-field"><span class="profile-field__label">Born</span><span>' +
        FSUtils.escapeHtml(born) + '</span></div>';
    }
    if (profile.partnerId && profile.partnerId !== ZERO_UUID) {
      const partnerLabel = profile.partnerName || 'View profile';
      html += '<div class="profile-field"><span class="profile-field__label">Partner</span>' +
        '<span><button type="button" class="profile-link" data-avatar-id="' +
        FSUtils.escapeHtml(profile.partnerId) + '">' + FSUtils.escapeHtml(partnerLabel) +
        '</button></span></div>';
    }
    return html;
  }

  function findKnownAgent(agentId) {
    const id = FSProfiles.normId(agentId);
    if (FSProfiles.isZero(id)) return null;
    const buddies = FSState.get().buddies || [];
    let i;
    for (i = 0; i < buddies.length; i++) {
      if (FSProfiles.normId(buddies[i].id) === id) return buddies[i];
    }
    const radar = FSState.get().radar || [];
    for (i = 0; i < radar.length; i++) {
      if (FSProfiles.normId(radar[i].id) === id) return radar[i];
    }
    const sessions = FSState.get().imSessions || {};
    const keys = Object.keys(sessions);
    for (i = 0; i < keys.length; i++) {
      const session = sessions[keys[i]];
      if (session && session.participant &&
          FSProfiles.normId(session.participant.id) === id) {
        return session.participant;
      }
    }
    return null;
  }

  function applyNameHint(profile, hint) {
    if (!profile || !hint) return profile;
    const hintName = String(hint.name || '').trim();
    profile.displayName = String(hint.displayName || '').trim() || profile.displayName || '';
    if (!profile.displayName && hintName) profile.displayName = hintName;
    profile.userName = String(hint.userName || hint.legacyName || '').trim() || profile.userName || '';
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
    if (!profile || typeof FSTransport.queueNameResolve !== 'function') return;
    const ids = [];
    if (profile.avatarId) ids.push(profile.avatarId);
    if (profile.partnerId && profile.partnerId !== ZERO_UUID) ids.push(profile.partnerId);
    if (ids.length) FSTransport.queueNameResolve(ids);
  }

  function ensureProfileExtras(profile) {
    if (!profile || !profile.avatarId || typeof FSProfiles.ensureAvatarExtras !== 'function') return;
    FSProfiles.ensureAvatarExtras(profile.avatarId, profile);
  }

  function openImagePreview(imageId, label) {
    const id = FSProfiles.normId(imageId);
    if (FSProfiles.isZero(id) || !imageDialog) return;
    const img = el('profile-image-full');
    if (!img) return;
    img.alt = label || 'Profile image';
    img.src = FSProfiles.textureImageUrl(id, 512);
    if (typeof imageDialog.showModal === 'function') imageDialog.showModal();
  }

  function renderAboutBlock(html, emptyText) {
    if (html === null) {
      return '<div class="profile-scroll profile-about profile-about--loading">Fetching...</div>';
    }
    if (!html) {
      return '<div class="profile-scroll profile-about profile-about--empty">' +
        FSUtils.escapeHtml(emptyText || 'No profile text.') + '</div>';
    }
    return '<div class="profile-scroll profile-about" tabindex="0">' + html + '</div>';
  }

  function profileCapAboutReady(profile) {
    if (!profile || profile.source !== 'cap') return false;
    if (typeof FSProfiles.needsCapProfileFetch === 'function') {
      return !FSProfiles.needsCapProfileFetch(profile);
    }
    return String(profile.about || '').length > 0;
  }

  function profileAboutPending(profile) {
    if (!profile) return true;
    if (profileCapAboutReady(profile)) return false;
    if (typeof FSProfiles.isCapFetchActive === 'function' &&
        FSProfiles.isCapFetchActive(profile.avatarId)) {
      return true;
    }
    return false;
  }

  function profileAboutForDisplay(profile) {
    if (!profile) return '';
    if (profileAboutPending(profile)) return null;
    return profile.about || '';
  }

  function renderGroupsList(groups) {
    if (!groups || !groups.length) {
      return '<p class="profile-section__empty">No groups listed</p>';
    }
    return '<div class="profile-groups-list">' + groups.map(function (g) {
      const label = FSUtils.escapeHtml(g.title ? (g.name + ' - ' + g.title) : g.name);
      return '<button type="button" class="profile-link profile-groups-list__item" data-group-id="' +
        FSUtils.escapeHtml(g.id) + '">' + label + '</button>';
    }).join('') + '</div>';
  }

  function renderSplitList(rows, emptyText, itemClass, layout) {
    if (!rows || !rows.length) {
      return '<p class="profile-section__empty">' + FSUtils.escapeHtml(emptyText || 'None') + '</p>';
    }
    const list = rows.map(function (row, index) {
      const label = FSUtils.escapeHtml(row.name || row.title || 'Item');
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
    const selfId = String((FSState.get().agent || {}).id || '').toLowerCase();
    return !!(profile && profile.avatarId && profile.avatarId === selfId);
  }

  function profileDetailLocation(detail) {
    if (!detail) return null;
    const regionName = String(detail.regionName || detail.simName || '').trim();
    const parcel = String(detail.originalName || detail.parcelName || '').trim();
    if (!regionName || (parcel && regionName.toLowerCase() === parcel.toLowerCase())) return null;
    if (detail.x !== undefined && detail.y !== undefined && detail.z !== undefined) {
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
    if (!detail.posGlobal) return null;
    const pos = detail.posGlobal;
    const rw = 256;
    const grid = typeof FSSlurl !== 'undefined' && FSSlurl.globalToGrid
      ? FSSlurl.globalToGrid(pos.x, pos.y)
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
    if (detail.snapshotId && !FSProfiles.isZero(detail.snapshotId)) {
      snap = '<button type="button" class="profile-detail__snapshot-btn" data-image-id="' +
        FSUtils.escapeHtml(detail.snapshotId) + '"><img class="profile-detail__snapshot" src="' +
        FSProfiles.textureImageUrl(detail.snapshotId, 256) + '" alt=""></button>';
    }
    let html = snap + '<h4 class="profile-split__title">' + FSUtils.escapeHtml(name) + '</h4>';
    if (descHtml) {
      html += '<div class="profile-detail__desc">' + descHtml + '</div>';
    }
    if (detail.location) {
      html += '<div class="profile-field"><span class="profile-field__label">Location</span><span>' +
        FSUtils.escapeHtml(detail.location) + '</span></div>';
    }
    if (kind === 'classified' && detail.priceForListing) {
      html += '<div class="profile-field"><span class="profile-field__label">Listing price</span><span>L$ ' +
        Number(detail.priceForListing).toLocaleString('en-US') + '</span></div>';
    }
    if (profileDetailLocation(detail)) {
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
          if (typeof FSMap !== 'undefined' && FSMap.showLocation) {
            FSMap.showLocation(loc);
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

  function findDetailPane(tabId) {
    const content = el('profile-content');
    if (!content) return null;
    const panel = content.querySelector('[data-profile-panel="' + tabId + '"] .profile-split__detail');
    return panel || null;
  }

  function avatarTabsFor(profile) {
    const self = isSelfProfile(profile);
    return AVATAR_TABS.filter(function (tab) {
      if (tab.id === 'web') return !!profile.profileUrl;
      if (tab.id === 'more') return !!(profile.flAbout || (profile.flImageId && profile.flImageId !== ZERO_UUID));
      if (tab.id === 'notes') return !self;
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
        FSUtils.escapeHtml(formatAccountInfo(profile)) + '</span></div>' +
      '<div class="profile-field profile-field--payment"><span class="profile-field__label">Payment</span>' +
      '<span class="profile-payment' + paymentInfoClass(profile) + '">' +
        FSUtils.escapeHtml(paymentText) + '</span></div>' +
      renderResidentSideMeta(profile) +
      '</div>' +
      '<div class="profile-resident__about">' +
      renderResidentKeyMeta(profile) +
      renderAboutBlock(aboutHtml, 'No profile text.') +
      '</div></div>' +
      '<section class="profile-section profile-section--groups">' +
      '<h3 class="profile-section__title">Groups</h3>' +
      renderGroupsList(profile.groups || []) +
      '</section></div>';
  }

  function renderWebTab(profile) {
    const url = String(profile.profileUrl || '').trim();
    if (!url) {
      return '<div class="profile-pane"><p class="profile-section__empty">No web profile URL.</p></div>';
    }
    const safeUrl = FSUtils.escapeHtml(url);
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
    const notes = String(profile.notes || '');
    return '<div class="profile-pane profile-pane--notes">' +
      '<p class="profile-notes-hint">Your private notes about this person. Only you can see them.</p>' +
      '<textarea id="profile-notes-input" class="profile-notes-input" rows="10" maxlength="65535" ' +
        'placeholder="Add private notes...">' + FSUtils.escapeHtml(notes) + '</textarea>' +
      '<div class="profile-notes-actions">' +
      '<button type="button" class="btn btn--primary" id="profile-notes-save">Save notes</button>' +
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
        tab.id + '">' + FSUtils.escapeHtml(tab.label) + '</button>';
    }).join('');

    const panes = {
      resident: renderResidentTab(profile),
      web: renderWebTab(profile),
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
        ? FSProfiles.getPickDetail(row.id)
        : FSProfiles.getClassifiedDetail(row.id);
      if (cached) {
        paintItemDetail(detail, cached, kind);
      } else {
        detail.innerHTML = '<p class="profile-section__empty">Loading...</p>';
      }
      const task = kind === 'pick'
        ? FSProfiles.fetchPickInfo(profile.avatarId, row.id)
        : FSProfiles.fetchClassifiedInfo(row.id);
      task.then(function (loaded) {
        if (!current || current.type !== 'avatar') return;
        const selectedId = kind === 'pick' ? current.selectedPickId : current.selectedClassifiedId;
        if (selectedId !== row.id) return;
        paintItemDetail(detail, loaded, kind);
      }).catch(function () {
        if (!detail || cached) return;
        detail.innerHTML = '<h4 class="profile-split__title">' + FSUtils.escapeHtml(row.name || 'Item') + '</h4>' +
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
    if (!notesInput || !notesSave || !profile.avatarId || isSelfProfile(profile)) return;

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
      const text = notesInput.value || '';
      if (typeof FSTransport.saveAvatarNotes !== 'function') return;
      const token = ++notesSaveToken;
      clearNotesTimers();
      notesSave.disabled = true;
      setNotesStatus('Saving...', 'pending');
      timeoutTimer = setTimeout(function () {
        if (token !== notesSaveToken) return;
        timeoutTimer = null;
        releaseNotesSave('Save timed out. Try again.', 'error');
      }, NOTES_SAVE_TIMEOUT_MS);
      FSTransport.saveAvatarNotes(profile.avatarId, text).then(function (result) {
        if (token !== notesSaveToken) return;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (result && result.sent) {
          FSProfiles.mergeAvatarProfile(profile.avatarId, {
            notes: text,
            source: 'notes-local'
          }, { silent: true });
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
    FSAvatarThumb.mountIn(root.querySelector('#profile-avatar-slot'), profile.avatarId, {
      label: title,
      className: 'profile-avatar-btn__thumb avatar-thumb--profile',
      resolveImage: !(profile.imageId && !FSProfiles.isZero(profile.imageId))
    });

    const avatarBtn = root.querySelector('#profile-avatar-btn');
    if (avatarBtn) {
      avatarBtn.addEventListener('click', function () {
        const imageId = profile.imageId || FSProfiles.getImageId(profile.avatarId);
        openImagePreview(imageId, title);
      });
    }

    const flBtn = root.querySelector('#profile-fl-image-btn');
    if (flBtn && profile.flImageId && profile.flImageId !== ZERO_UUID) {
      const preview = root.querySelector('#profile-fl-image-preview');
      if (preview) preview.src = FSProfiles.textureImageUrl(profile.flImageId, 256);
      flBtn.addEventListener('click', function () {
        openImagePreview(profile.flImageId, title + ' profile image');
      });
    }

    root.querySelectorAll('[data-avatar-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openAvatar(btn.getAttribute('data-avatar-id'));
      });
    });
    bindGroupLinks(root);
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
    const isFriend = typeof FSTransport.isBuddy === 'function' && FSTransport.isBuddy(agentId);
    const tpOnline = typeof FSTransport.isAgentOnline === 'function'
      ? FSTransport.isAgentOnline(agentId, profile)
      : true;
    const tpDisabled = { disabled: true, title: 'Resident is offline' };

    addAction('IM', function () {
      closeDialog();
      FSIm.startImWith({
        id: agentId,
        name: profile.displayName || profile.userName || profile.name || 'Resident',
        displayName: profile.displayName || '',
        userName: profile.userName || ''
      });
    }, { primary: true });

    if (!isSelf) {
      addAction('Pay', function () {
        const payDialog = el('pay-dialog');
        const nameEl = el('pay-target-name');
        if (!payDialog) return;
        if (nameEl) nameEl.textContent = 'Pay ' + profileTitleText(profile);
        payDialog.dataset.targetId = agentId;
        if (typeof payDialog.showModal === 'function') payDialog.showModal();
      });
      addAction('Offer teleport', function () {
        FSTeleportUI.offerTo(agentId, profile.displayName || profile.userName || profile.name, profile);
      }, tpOnline ? undefined : tpDisabled);
      addAction('Request teleport', function () {
        FSTeleportUI.requestFrom(agentId, profile.displayName || profile.userName || profile.name, profile);
      }, tpOnline ? undefined : tpDisabled);
      addAction(isFriend ? 'Remove friend' : 'Add friend', function () {
        const name = profileTitleText(profile) || 'this resident';
        if (isFriend) {
          if (!window.confirm('Remove ' + name + ' from your friends list?')) return;
          FSTransport.removeFriendship(agentId).then(function (result) {
            if (result && result.sent) {
              FSUtils.showToast('Friend removed.', 'success');
              renderAvatarActions(enrichAvatarProfile(Object.assign({}, profile)));
            }
          });
          return;
        }
        if (!window.confirm('Send a friendship offer to ' + name + '?')) return;
        FSTransport.offerFriendship(agentId).then(function (result) {
          if (result && result.sent) FSUtils.showToast('Friendship offer sent.', 'success');
        });
      });
    }
  }

  function isGroupMember(profile) {
    if (!profile || !profile.groupId) return false;
    return typeof FSProfiles.isAgentInGroup === 'function' && FSProfiles.isAgentInGroup(profile.groupId);
  }

  function enrichGroupProfile(profile) {
    if (!profile) return profile;
    const next = Object.assign({}, profile);
    next.isMember = isGroupMember(next);
    if (!next.isMember) next.memberTitle = '';
    if (current && current.nameHint) {
      const hintName = String(current.nameHint.name || '').trim();
      if (hintName && !next.name) next.name = hintName;
    }
    if (next.founderId && next.founderId !== ZERO_UUID) {
      if (typeof FSTransport.getCachedNameInfo === 'function') {
        const info = FSTransport.getCachedNameInfo(next.founderId);
        if (info) next.founderName = info.displayName || info.label || '';
      }
      if (!next.founderName && typeof FSTransport.getCachedName === 'function') {
        next.founderName = FSTransport.getCachedName(next.founderId) || '';
      }
    }
    return next;
  }

  function queueGroupNames(profile) {
    if (!profile || typeof FSTransport.queueNameResolve !== 'function') return;
    if (profile.founderId && profile.founderId !== ZERO_UUID) {
      FSTransport.queueNameResolve([profile.founderId]);
    }
  }

  function renderGroupKeyMeta(profile) {
    return '<div class="profile-desc-meta profile-desc-meta--key">' +
      '<div class="profile-meta-item">' +
      '<span class="profile-meta-item__label">Key</span>' +
      '<span class="profile-meta-item__value"><code class="profile-uuid">' +
      FSUtils.escapeHtml(profile.groupId) + '</code></span></div></div>';
  }

  function renderGroupFounderField(profile) {
    if (!profile.founderId || profile.founderId === ZERO_UUID) return '';
    const label = profile.founderName || 'View profile';
    return '<div class="profile-field"><span class="profile-field__label">Founder</span>' +
      '<span><button type="button" class="profile-link" data-avatar-id="' +
      FSUtils.escapeHtml(profile.founderId) + '">' + FSUtils.escapeHtml(label) + '</button></span></div>';
  }

  function renderGroupMemberField(profile) {
    if (!profile.isMember) return '';
    const title = String(profile.memberTitle || '').trim();
    return '<div class="profile-field"><span class="profile-field__label">Your title</span><span>' +
      FSUtils.escapeHtml(title || 'Member') + '</span></div>';
  }

  function renderGroupSideMeta(profile) {
    let html = '<div class="profile-field"><span class="profile-field__label">Join fee</span><span>' +
      FSUtils.escapeHtml(formatGroupJoinFee(profile)) + '</span></div>';
    if (profile.money !== undefined && profile.money !== null) {
      html += '<div class="profile-field"><span class="profile-field__label">Treasury</span><span>L$ ' +
        Number(profile.money).toLocaleString('en-US') + '</span></div>';
    }
    if (profile.rolesCount !== undefined && profile.rolesCount !== null) {
      html += '<div class="profile-field"><span class="profile-field__label">Roles</span><span>' +
        FSUtils.escapeHtml(String(profile.rolesCount)) + '</span></div>';
    }
    if (profile.showInList !== undefined) {
      html += '<div class="profile-field"><span class="profile-field__label">Search</span><span>' +
        FSUtils.escapeHtml(profile.showInList ? 'Visible in search' : 'Hidden from search') + '</span></div>';
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
        FSUtils.escapeHtml(profile.openEnrollment ? 'Open enrollment' : 'Closed enrollment') + '</span></div>' +
      '<div class="profile-field"><span class="profile-field__label">Content</span><span>' +
        FSUtils.escapeHtml(profile.maturePublish ? 'Mature' : 'General') + '</span></div>' +
      renderGroupSideMeta(profile) +
      renderGroupFounderField(profile) +
      renderGroupMemberField(profile) +
      '</div>' +
      '<div class="profile-resident__about profile-group__about">' +
      renderGroupKeyMeta(profile) +
      renderAboutBlock(charterHtml, 'No charter text.') +
      '</div></div></div>';
  }

  function bindGroupContent(profile, root) {
    if (!root) return;
    const title = profile.name || 'Group';
    FSAvatarThumb.mountIn(root.querySelector('#profile-group-insignia-slot'), profile.groupId, {
      kind: 'group',
      label: title,
      className: 'profile-avatar-btn__thumb avatar-thumb--profile',
      resolveImage: true
    });
    const insigniaBtn = root.querySelector('#profile-group-insignia-btn');
    if (insigniaBtn) {
      insigniaBtn.addEventListener('click', function () {
        const imageId = profile.insigniaId || FSProfiles.getGroupInsigniaId(profile.groupId);
        if (imageId && !FSProfiles.isZero(imageId)) openImagePreview(imageId, title + ' insignia');
      });
    }
    root.querySelectorAll('[data-avatar-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openAvatar(btn.getAttribute('data-avatar-id'));
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
        FSIm.openGroupChat(groupId, profile.name || '');
      }, { primary: true });
      addAction('Leave group', function () {
        if (!window.confirm('Leave ' + groupName + '?')) return;
        FSTransport.leaveGroup(groupId).then(function (result) {
          if (result && result.success) {
            FSUtils.showToast('Left ' + groupName + '.', 'success');
            const next = enrichGroupProfile(Object.assign({}, profile, { isMember: false }));
            renderGroup(next);
            return;
          }
          if (result && result.notMember) {
            FSUtils.showToast('You are not a member of this group.', 'warning');
            const next = enrichGroupProfile(Object.assign({}, profile, { isMember: false }));
            renderGroup(next);
            return;
          }
          FSUtils.showToast('Could not leave group.', 'warning');
        });
      }, { danger: true });
      return;
    }
    if (profile.openEnrollment) {
      const fee = Number(profile.membershipFee) || 0;
      const label = fee > 0 ? 'Join (L$ ' + fee.toLocaleString('en-US') + ')' : 'Join';
      addAction(label, function () {
        const feeMsg = fee > 0
          ? 'Join ' + groupName + ' for L$ ' + fee.toLocaleString('en-US') + '?'
          : 'Join ' + groupName + '?';
        if (!window.confirm(feeMsg)) return;
        FSTransport.joinGroup(groupId).then(function (result) {
          if (result && result.success) {
            FSUtils.showToast('Joined ' + groupName + '.', 'success');
            const next = enrichGroupProfile(Object.assign({}, profile, { isMember: true }));
            renderGroup(next);
            return;
          }
          if (result && result.alreadyMember) {
            FSUtils.showToast('You are already a member.', 'warning');
            const next = enrichGroupProfile(Object.assign({}, profile, { isMember: true }));
            renderGroup(next);
            return;
          }
          FSUtils.showToast('Could not join group.', 'warning');
        });
      });
    }
  }

  function bindGroupLinks(root) {
    if (!root) return;
    root.querySelectorAll('[data-group-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openGroup(btn.getAttribute('data-group-id'));
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
    content.innerHTML = renderAvatarTabs(profile);
    bindAvatarContent(profile, content);
    renderAvatarActions(profile);
    setLoading(false);
  }

  function renderGroup(profile) {
    if (dialog) {
      dialog.classList.remove('profile-dialog--avatar');
      dialog.classList.add('profile-dialog--group');
    }
    const enriched = enrichGroupProfile(profile);
    updateGroupHeader(enriched);
    queueGroupNames(enriched);

    const content = el('profile-content');
    if (!content) return;
    content.innerHTML = '<div class="profile-main-panel">' + renderGroupTab(enriched) + '</div>';
    bindGroupContent(enriched, content);
    renderGroupActions(enriched);
    setLoading(false);
  }

  function enrichAvatarProfile(profile) {
    const id = profile.avatarId;
    const hint = (current && current.nameHint) || findKnownAgent(id);
    applyNameHint(profile, hint);
    const nameInfo = typeof FSTransport.getCachedNameInfo === 'function'
      ? FSTransport.getCachedNameInfo(id)
      : null;
    if (nameInfo) {
      profile.displayName = nameInfo.displayName || profile.displayName || '';
      profile.userName = nameInfo.userName || profile.userName || '';
      profile.name = nameInfo.label || profile.name || '';
    } else if (typeof FSTransport.getCachedName === 'function') {
      const cached = FSTransport.getCachedName(id);
      if (cached) profile.name = profile.name || cached;
    }
    if (profile.partnerId && profile.partnerId !== ZERO_UUID) {
      const partnerInfo = typeof FSTransport.getCachedNameInfo === 'function'
        ? FSTransport.getCachedNameInfo(profile.partnerId)
        : null;
      profile.partnerName = partnerInfo
        ? (partnerInfo.displayName || partnerInfo.label || '')
        : (typeof FSTransport.getCachedName === 'function' ? FSTransport.getCachedName(profile.partnerId) : '');
    }
    return profile;
  }

  function finishAvatarProfile(profile) {
    if (!current || current.type !== 'avatar' || !profile) return;
    const id = profile.avatarId || current.id;
    const capActive = typeof FSProfiles.isCapFetchActive === 'function' &&
      FSProfiles.isCapFetchActive(id);
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
      const row = FSProfiles.getAvatarProfile(id) || { avatarId: id };
      finishAvatarProfile(enrichAvatarProfile(Object.assign({}, row)));
      return;
    }
    setTimeout(function () {
      if (!current || current.id !== id || current.type !== 'avatar') return;
      FSProfiles.fetchAvatarProfile(id, { force: true, quiet: true })
        .then(function (fresh) { finishAvatarProfile(fresh); })
        .catch(function () { scheduleCapProfileRetry(id, attempt + 1); });
    }, 2000);
  }

  function openAvatar(agentId, options) {
    const id = FSProfiles.normId(agentId);
    if (FSProfiles.isZero(id)) return;
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
    if (typeof dialog.showModal === 'function') dialog.showModal();
    if (nameHint) {
      updateProfileHeader(enrichAvatarProfile({ avatarId: id }));
    }
    queueProfileNames({ avatarId: id });

    const cached = FSProfiles.getAvatarProfile(id);
    const needsCap = typeof FSProfiles.needsCapProfileFetch === 'function'
      ? FSProfiles.needsCapProfileFetch(cached)
      : true;
    const mustFetch = needsCap || !cached || !!(options && options.force);
    current.capFetchPending = mustFetch;

    const profile = cached
      ? enrichAvatarProfile(Object.assign({}, cached))
      : enrichAvatarProfile({ avatarId: id });
    queueProfileNames(profile);
    if (cached) ensureProfileExtras(profile);
    renderAvatar(profile);

    if (!mustFetch) return;

    FSProfiles.fetchAvatarProfile(id, { force: true, quiet: true }).then(function (fresh) {
      if (!current || current.id !== id || current.type !== 'avatar') return;
      finishAvatarProfile(fresh);
      if (typeof FSProfiles.needsCapProfileFetch === 'function' &&
          FSProfiles.needsCapProfileFetch(fresh) &&
          typeof FSProfiles.hasAgentProfileCap === 'function' &&
          FSProfiles.hasAgentProfileCap()) {
        scheduleCapProfileRetry(id, 0);
      }
    }).catch(function (err) {
      if (!current || current.id !== id || current.type !== 'avatar') return;
      if (typeof FSProfiles.hasAgentProfileCap === 'function' && FSProfiles.hasAgentProfileCap()) {
        scheduleCapProfileRetry(id, 0);
        return;
      }
      const fallback = enrichAvatarProfile(Object.assign({}, FSProfiles.getAvatarProfile(id) || cached || { avatarId: id }));
      finishAvatarProfile(fallback);
    });
  }

  function openGroup(groupId, options) {
    const id = FSProfiles.normId(groupId);
    if (FSProfiles.isZero(id)) return;
    if (!dialog) return;
    const nameHint = (options && options.group) || null;
    current = { type: 'group', id: id, nameHint: nameHint };
    setLoading(true);
    clearActions();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    if (nameHint && nameHint.name) {
      updateGroupHeader(enrichGroupProfile({ groupId: id, name: nameHint.name }));
    }

    const cached = FSProfiles.getGroupProfile(id);
    if (cached && !(options && options.force)) {
      renderGroup(Object.assign({}, cached));
      return;
    }

    FSProfiles.fetchGroupProfile(id, options).then(function (profile) {
      if (!current || current.id !== id || current.type !== 'group') return;
      renderGroup(Object.assign({}, profile));
    }).catch(function (err) {
      if (!current || current.id !== id) return;
      const content = el('profile-content');
      if (content) {
        content.hidden = false;
        content.innerHTML = '<p class="profile-section__empty">' +
          FSUtils.escapeHtml(err.message || 'Could not load group profile') + '</p>';
      }
      setLoading(false);
    });
  }

  function refreshCurrentProfile() {
    if (!current || !dialog || !dialog.open) return;
    if (current.type === 'avatar') {
      const profile = FSProfiles.getAvatarProfile(current.id);
      if (!profile) return;
      finishAvatarProfile(profile);
      return;
    }
    if (current.type === 'group') {
      const profile = FSProfiles.getGroupProfile(current.id);
      if (profile) renderGroup(Object.assign({}, profile));
    }
  }

  function init() {
    dialog = el('profile-dialog');
    imageDialog = el('profile-image-dialog');
    const closeBtn = el('profile-close');
    const imageCloseBtn = el('profile-image-close');
    if (closeBtn && dialog) {
      closeBtn.addEventListener('click', function () { dialog.close(); });
    }
    if (imageCloseBtn && imageDialog) {
      imageCloseBtn.addEventListener('click', function () { imageDialog.close(); });
    }
    if (dialog) {
      dialog.addEventListener('close', function () { current = null; });
      dialog.addEventListener('cancel', function () { current = null; });
    }
    if (imageDialog) {
      imageDialog.addEventListener('click', function (evt) {
        if (evt.target === imageDialog) imageDialog.close();
      });
    }
    FSProfiles.onChange(function (evt) {
      if (!current || !dialog || !dialog.open) return;
      if (current.type === 'avatar' && evt.id === current.id &&
          (evt.kind === 'avatar' || evt.kind === 'avatar-fetching')) {
        if (evt.kind === 'avatar-fetching') {
          const base = FSProfiles.getAvatarProfile(current.id) || { avatarId: current.id };
          const profile = enrichAvatarProfile(Object.assign({}, base));
          if (typeof FSProfiles.isCapFetchActive === 'function' &&
              FSProfiles.isCapFetchActive(current.id) &&
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
        refreshCurrentProfile();
        return;
      }
      if (current.type !== 'avatar') return;
      if (evt.kind === 'pick-detail' && current.selectedPickId === evt.id) {
        const detailEl = findDetailPane('places');
        const detail = FSProfiles.getPickDetail(evt.id);
        if (detailEl && detail) {
          paintItemDetail(detailEl, detail, 'pick');
        }
        return;
      }
      if (evt.kind === 'classified-detail' && current.selectedClassifiedId === evt.id) {
        const detailEl = findDetailPane('classifieds');
        const detail = FSProfiles.getClassifiedDetail(evt.id);
        if (detailEl && detail) {
          paintItemDetail(detailEl, detail, 'classified');
        }
      }
    });
    if (typeof FSTransport.on === 'function') {
      FSTransport.on('names-updated', function () {
        if (!current || !dialog || !dialog.open) return;
        if (current.type === 'avatar') {
          const profile = FSProfiles.getAvatarProfile(current.id);
          if (profile) updateProfileHeader(enrichAvatarProfile(Object.assign({}, profile)));
          return;
        }
        if (current.type === 'group') {
          const profile = FSProfiles.getGroupProfile(current.id);
          if (profile) renderGroup(Object.assign({}, profile));
        }
      });
      FSTransport.on('buddies-updated', function () {
        if (!current || current.type !== 'avatar' || !dialog || !dialog.open) return;
        const profile = FSProfiles.getAvatarProfile(current.id);
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
