/**
 * Land / parcel management panel - the Land tab's view and edit logic.
 */
const FSLand = (function () {
  'use strict';

  const PANEL_ID = 'panel-land';
  const LOADING_MESSAGE = 'Loading land data, please wait...';

  const EDITABLE_IDS = [
    'land-name', 'land-desc', 'land-push',
    'land-build-everyone', 'land-build-group',
    'land-scripts-everyone', 'land-scripts-group',
    'land-fly', 'land-safe', 'land-search',
    'land-sound-local', 'land-voice', 'land-sell-passes',
    'land-music', 'land-media'
  ];
  // 'land-access' is left off this list on purpose - it stays display-only. Its
  // dropdown isn't wired to the access-list PF bits yet, and writing back a
  // guess could lock people out.

  let activateToken = 0;
  let activeLandTab = 'general';

  function parcelNeedsLoad(parcel) {
    return !parcel || parcel.stub === true;
  }

  function setLandPending(pending) {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.toggle('panel-land--pending', pending);
  }

  function showLoading(message) {
    setLandPending(true);
    if (typeof FSPanelBusy !== 'undefined') {
      FSPanelBusy.show(PANEL_ID, message || LOADING_MESSAGE);
    }
  }

  function hideLoading() {
    setLandPending(false);
    if (typeof FSPanelBusy !== 'undefined') {
      FSPanelBusy.hide(PANEL_ID);
    }
  }

  function setFieldValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') {
      el.checked = !!value;
      return;
    }
    el.value = value !== undefined && value !== null ? String(value) : '';
  }

  function clearDisplay() {
    const form = document.getElementById('land-form');
    if (form) form.reset();
    const snapshot = document.getElementById('land-snapshot');
    if (snapshot) {
      snapshot.hidden = true;
      snapshot.removeAttribute('src');
    }
    const summary = document.getElementById('land-summary');
    if (summary) summary.innerHTML = '';
    setFormEditable(false);
  }

  function parcelCanEdit(parcel) {
    // canEdit comes from the Rust parcel handler: true if you own the parcel, or
    // belong to the owning group on group land (the Governor doesn't count).
    return !!(parcel && !parcel.stub && parcel.canEdit);
  }

  function readOnlyNote(parcel) {
    if (parcel.isGroupOwned) {
      return 'View only - group land requires officer powers to edit';
    }
    return 'View only - you do not own this parcel';
  }

  function setFormEditable(canEdit) {
    const form = document.getElementById('land-form');
    if (!form) return;
    EDITABLE_IDS.forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox' || el.tagName === 'SELECT') {
        el.readOnly = false;
        el.disabled = !canEdit;
        return;
      }
      el.disabled = false;
      el.readOnly = !canEdit;
    });
    [
      'land-area', 'land-traffic', 'land-uuid', 'land-owner', 'land-group',
      'land-prims', 'land-region-prims', 'land-prims-owner', 'land-prims-group',
      'land-prims-other', 'land-landing', 'land-media-type', 'land-media-desc',
      'land-pass-price', 'land-pass-hours'
    ].forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = false;
      el.readOnly = true;
    });
    // The access dropdown is display-only - its mapping to the access-list PF
    // bits isn't wired, and a wrong guess could lock people out - so we keep it
    // disabled always, not only when the parcel is read-only.
    const access = document.getElementById('land-access');
    if (access) access.disabled = true;
    const submit = document.getElementById('land-apply') || form.querySelector('[type="submit"]');
    if (submit) submit.disabled = !canEdit;
    form.classList.toggle('land-form--readonly', !canEdit);
  }

  function formatPrimLine(used, total) {
  if (total > 0) return used + ' / ' + total;
    if (used > 0) return String(used);
    return '';
  }

  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

  function updateGroupChatButton(parcel) {
    const btn = document.getElementById('land-group-chat');
    if (!btn) return;
    const groupId = parcel && parcel.groupId;
    const hasGroup = !!groupId && groupId !== ZERO_UUID;
    btn.hidden = !hasGroup;
    if (hasGroup) {
      btn.dataset.groupId = groupId;
      btn.dataset.groupName = parcel.groupName || '';
    }
  }

  // On group-owned land the parcel "owner" is really the group, so OwnerID holds
  // the group's UUID. This field therefore has to resolve a group name and open
  // the group profile, rather than a resident profile showing a bare UUID.
  function ownerFieldInfo(parcel) {
    const groupOwned = !!parcel.isGroupOwned;
    const id = parcel.ownerId || '';
    if (groupOwned) {
      const label = parcel.groupName ||
        (typeof FSTransport.getGroupName === 'function' ? FSTransport.getGroupName(id) : '') ||
        (typeof FSProfiles !== 'undefined' && FSProfiles.getGroupName ? FSProfiles.getGroupName(id) : '') ||
        'Group-owned';
      return { id: id, label: label, type: 'group', isGroup: true };
    }
    const label = parcel.ownerName ||
      (typeof FSTransport.getCachedName === 'function' ? FSTransport.getCachedName(id) : '') ||
      (id ? 'Resident (resolving…)' : '');
    return { id: id, label: label, type: 'avatar', isGroup: false };
  }

  function setProfileField(id, label, entityId, entityType) {
    const field = document.getElementById(id);
    if (!field) return;
    const text = label || entityId || '';
    field.value = text;
    field.classList.toggle('land-field--profile', !!(entityId && text));
    field.dataset.profileId = entityId || '';
    field.dataset.profileType = entityType || '';
    field.title = entityId ? ('Open ' + (entityType === 'group' ? 'group' : 'avatar') + ' profile') : '';
  }

  function bindProfileFields() {
    ['land-owner', 'land-group'].forEach(function (id) {
      const field = document.getElementById(id);
      if (!field || field.dataset.profileBound) return;
      field.dataset.profileBound = '1';
      field.addEventListener('click', function () {
        const entityId = field.dataset.profileId;
        const entityType = field.dataset.profileType;
        if (!entityId) return;
        if (entityType === 'group') FSProfile.openGroup(entityId);
        else FSProfile.openAvatar(entityId);
      });
    });
  }

  function populateForm(parcel) {
    if (!parcel || parcel.stub) return;

    const canEdit = parcelCanEdit(parcel);
    const primsUsed = parcel.primsUsed !== undefined && parcel.primsUsed !== null ? parcel.primsUsed : 0;
    const primsTotal = parcel.primsTotal || 0; // comes from the Rust parcel handler

    setFieldValue('land-name', parcel.name || '');
    setFieldValue('land-desc', parcel.desc || '');
    setFieldValue('land-uuid', parcel.parcelId || '');
    setFieldValue('land-area', parcel.area ? parcel.area + ' m\u00B2' : '');
    setFieldValue('land-traffic', parcel.dwell !== undefined && parcel.dwell !== null
      ? Math.round(parcel.dwell)
      : '');
    const owner = ownerFieldInfo(parcel);
    const ownerLabel = owner.label;
    const groupLabel = parcel.groupName ||
      (typeof FSTransport.getGroupName === 'function' ? FSTransport.getGroupName(parcel.groupId) : '') ||
      parcel.groupId || '';
    setProfileField('land-owner', ownerLabel, owner.id, owner.type);
    setProfileField('land-group', groupLabel, parcel.groupId, 'group');
    // Kick off the right kind of name lookup so the field never shows a bare UUID.
    if (owner.isGroup && owner.id && owner.id !== ZERO_UUID && !parcel.groupName &&
        FSProfiles.queueGroupName) {
      FSProfiles.queueGroupName(owner.id);
    } else if (!owner.isGroup && owner.id && owner.id !== ZERO_UUID && !parcel.ownerName &&
        typeof FSTransport.queueNameResolve === 'function') {
      FSTransport.queueNameResolve([owner.id]);
    }
    if (parcel.groupId && parcel.groupId !== ZERO_UUID && !parcel.groupName) {
      FSProfiles.queueGroupName(parcel.groupId);
    }
    updateGroupChatButton(parcel);
    setFieldValue('land-prims', formatPrimLine(primsUsed, primsTotal));
    setFieldValue('land-region-prims', formatPrimLine(
      parcel.simWideTotalPrims || 0,
      parcel.simWideMaxPrims || 0
    ));
    setFieldValue('land-prims-owner', parcel.ownerPrims || 0);
    setFieldValue('land-prims-group', parcel.groupPrims || 0);
    setFieldValue('land-prims-other', parcel.otherPrims || 0);
    setFieldValue('land-access', String(parcel.access || 0));
    setFieldValue('land-push', parcel.pushRestricted);
    setFieldValue('land-fly', parcel.allowFly);
    setFieldValue('land-build-everyone', parcel.allowBuildEveryone);
    setFieldValue('land-build-group', parcel.allowBuildGroup);
    setFieldValue('land-scripts-everyone', parcel.allowScriptsEveryone);
    setFieldValue('land-scripts-group', parcel.allowScriptsGroup);
    setFieldValue('land-safe', parcel.safeEnvironment !== false);
    setFieldValue('land-search', parcel.showInSearch);
    setFieldValue('land-sound-local', parcel.soundLocal);
    setFieldValue('land-voice', parcel.allowVoice !== false);
    setFieldValue('land-sell-passes', parcel.sellPasses);
    setFieldValue('land-music', parcel.musicUrl || '');
    setFieldValue('land-media', parcel.mediaUrl || '');
    setFieldValue('land-media-type', parcel.mediaType || '');
    setFieldValue('land-media-desc', parcel.mediaDesc || '');
    setFieldValue('land-pass-price', parcel.passPrice || '');
    setFieldValue('land-pass-hours', parcel.passHours || '');

    if (parcel.landingPoint) {
      const lp = parcel.landingPoint;
      setFieldValue('land-landing', lp.x + ', ' + lp.y + ', ' + lp.z);
    } else {
      setFieldValue('land-landing', '');
    }

    const snapshot = document.getElementById('land-snapshot');
    if (snapshot) {
      if (parcel.snapshotUrl) {
        snapshot.src = parcel.snapshotUrl;
        snapshot.hidden = false;
      } else {
        snapshot.hidden = true;
        snapshot.removeAttribute('src');
      }
    }

    setFormEditable(canEdit);
    renderSummary(parcel);
  }

  // Renders the summary line ("Standing on … Owner: … Group: …"). It lives on its
  // own so we can re-render it once the owner/group name resolves after the form
  // first paints - otherwise it stays stuck showing the UUID.
  function renderSummary(parcel) {
    const summary = document.getElementById('land-summary');
    if (!summary || !parcel || parcel.stub) return;
    const canEdit = parcelCanEdit(parcel);
    const owner = ownerFieldInfo(parcel);
    const ownerLabel = owner.label;
    const groupLabel = parcel.groupName ||
      (typeof FSTransport.getGroupName === 'function' ? FSTransport.getGroupName(parcel.groupId) : '') ||
      (FSProfiles.getGroupName ? FSProfiles.getGroupName(parcel.groupId) : '') ||
      parcel.groupId || '';
    const ownerLink = owner.id
      ? '<button type="button" class="profile-inline-link" data-profile-type="' + owner.type +
        '" data-profile-id="' + FSUtils.escapeHtml(owner.id) + '">' +
        FSUtils.escapeHtml(ownerLabel) + '</button>'
      : FSUtils.escapeHtml(ownerLabel || 'Unknown');
    const groupLink = parcel.groupId && parcel.groupId !== ZERO_UUID
      ? '<button type="button" class="profile-inline-link" data-profile-type="group" data-profile-id="' +
        FSUtils.escapeHtml(parcel.groupId) + '">' + FSUtils.escapeHtml(groupLabel) + '</button>'
      : '';
    let html =
      'Standing on <strong>' + FSUtils.escapeHtml(parcel.name) + '</strong><br>' +
      'Owner: ' + ownerLink +
      (groupLink ? ' &middot; Group: ' + groupLink : '');
    if (!canEdit) {
      html += '<br><span class="land-summary__note">' +
        FSUtils.escapeHtml(readOnlyNote(parcel)) + '</span>';
    }
    summary.innerHTML = html;
    summary.querySelectorAll('.profile-inline-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const entityId = btn.getAttribute('data-profile-id');
        const entityType = btn.getAttribute('data-profile-type');
        if (!entityId) return;
        if (entityType === 'group') FSProfile.openGroup(entityId);
        else FSProfile.openAvatar(entityId);
      });
    });
  }

  function collectForm() {
    // Collect every editable control, keeping everyone vs group distinct, so the
    // update can carry them all; the transport folds each into its own PF_ bit.
    const checked = function (id) {
      const el = document.getElementById(id);
      return el ? el.checked : undefined;
    };
    return {
      name: document.getElementById('land-name').value.trim(),
      desc: document.getElementById('land-desc').value.trim(),
      pushRestricted: checked('land-push'),
      allowBuildEveryone: checked('land-build-everyone'),
      allowBuildGroup: checked('land-build-group'),
      allowScriptsEveryone: checked('land-scripts-everyone'),
      allowScriptsGroup: checked('land-scripts-group'),
      allowFly: checked('land-fly'),
      safeEnvironment: checked('land-safe'),
      showInSearch: checked('land-search'),
      soundLocal: checked('land-sound-local'),
      allowVoice: checked('land-voice'),
      sellPasses: checked('land-sell-passes'),
      musicUrl: document.getElementById('land-music').value.trim(),
      mediaUrl: document.getElementById('land-media').value.trim()
    };
  }

  function setLandTab(tab) {
    activeLandTab = tab || 'general';
    document.querySelectorAll('.land-tab').forEach(function (btn) {
      const active = btn.getAttribute('data-land-tab') === activeLandTab;
      btn.classList.toggle('land-tab--active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.land-pane').forEach(function (pane) {
      const active = pane.getAttribute('data-land-pane') === activeLandTab;
      pane.classList.toggle('land-pane--active', active);
      pane.hidden = !active;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!FSState.gridOnline()) {
      FSUtils.showToast('Not connected to the grid', 'warning');
      return;
    }
    const parcel = FSState.get().parcel;
    if (!parcelCanEdit(parcel)) {
      FSUtils.showToast('You cannot edit this parcel', 'error');
      return;
    }
    // Send the FULL current parcel with the edits layered on top. The core needs
    // localId, the baseline parcelFlags (to fold the checkboxes onto), groupId,
    // snapshotId, the landing point, and so on - collectForm() alone drops them,
    // which would zero those fields on the sim and lose data.
    const data = Object.assign({}, parcel, collectForm());
    const btn = document.getElementById('land-apply') || e.target.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Applying...';

    try {
      await FSTransport.updateParcel(data);
      FSUtils.showToast('Parcel updated', 'success');
      // Re-fetch the authoritative parcel data so the form and the next save's
      // baseline reflect what the sim actually stored.
      if (typeof FSTransport.refreshParcel === 'function') {
        FSTransport.refreshParcel({ force: true })
          .then(function () { applyParcel(FSState.get().parcel); })
          .catch(function () { /* leave the optimistic values in place */ });
      }
    } catch (err) {
      FSUtils.showToast(err.message || 'Update failed', 'error');
    } finally {
      btn.disabled = !parcelCanEdit(FSState.get().parcel);
      btn.textContent = 'Apply Changes';
    }
  }

  function applyParcel(parcel) {
    if (parcelNeedsLoad(parcel)) return;
    populateForm(parcel);
    hideLoading();
  }

  // ParcelProperties carries neither the parcel UUID nor dwell (Traffic), so we
  // fetch them via RemoteParcelRequest for the parcel the agent is standing on.
  // The matching parcel-info event (correlated by id below) merges them back in.
  let expectedParcelInfoId = '';
  function requestParcelExtras() {
    if (typeof FSTransport.remoteParcel !== 'function') return;
    const region = FSState.get().region || {};
    const pos = FSState.get().position || {};
    const gx = region.x != null ? region.x : region.gridX;
    const gy = region.y != null ? region.y : region.gridY;
    if (gx == null || gy == null) return;
    FSTransport.remoteParcel(gx, gy,
      pos.x != null ? pos.x : 128, pos.y != null ? pos.y : 128, pos.z != null ? pos.z : 25
    ).then(function (res) {
      if (res && res.parcelId) expectedParcelInfoId = FSUtils.normUuid(res.parcelId);
    });
  }

  function mergeParcelExtras(info) {
    if (!info || !info.parcelId) return;
    // Accept only the parcel we're standing on - its id came back from our own
    // request - never a place-search detail's parcel-info.
    if (FSUtils.normUuid(info.parcelId) !== expectedParcelInfoId) return;
    const parcel = FSState.get().parcel;
    if (!parcel || parcel.stub) return;
    FSState.patch({ parcel: Object.assign({}, parcel, {
      parcelId: info.parcelId,
      dwell: info.dwell
    }) });
    if (FSNavigation.isTabActive('land')) {
      setFieldValue('land-uuid', info.parcelId);
      if (info.dwell != null) setFieldValue('land-traffic', Math.round(info.dwell));
    }
  }

  function parcelIsRich(parcel) {
    return !!(parcel && !parcel.stub &&
      (parcel.parcelFlags || 0) > 0 &&
      (parcel.primsUsed || 0) > 0 &&
      (parcel.name || '').trim());
  }

  async function activate() {
    const token = ++activateToken;
    const parcel = FSState.get().parcel;
    const pending = parcelNeedsLoad(parcel);
    requestParcelExtras(); // fetch the parcel UUID + Traffic, which ParcelProperties omits

    if (pending) {
      clearDisplay();
      showLoading();
    } else {
      populateForm(parcel);
    }

    if (!FSState.get().sessionLost && typeof FSTransport.refreshParcel === 'function') {
      const shouldRefresh = pending || !parcelIsRich(FSState.get().parcel);
      if (shouldRefresh) {
        try {
          await FSTransport.refreshParcel();
          if (token !== activateToken || !FSNavigation.isTabActive('land')) return;
          applyParcel(FSState.get().parcel);
          if (parcelNeedsLoad(FSState.get().parcel)) {
            clearDisplay();
          }
        } finally {
          if (token === activateToken) hideLoading();
        }
      } else if (token === activateToken && pending) {
        hideLoading();
      }
    } else if (token === activateToken && pending) {
      hideLoading();
    }
  }

  function init() {
    bindProfileFields();
    document.getElementById('land-form').addEventListener('submit', handleSubmit);
    document.getElementById('land-refresh').addEventListener('click', async function () {
      showLoading('Refreshing land data...');
      try {
        await FSTransport.refreshParcel({ force: true });
        applyParcel(FSState.get().parcel);
      } finally {
        hideLoading();
      }
    });

    document.querySelectorAll('.land-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setLandTab(btn.getAttribute('data-land-tab'));
      });
    });

    const groupChatBtn = document.getElementById('land-group-chat');
    if (groupChatBtn && typeof FSIm !== 'undefined' && FSIm.openGroupChat) {
      groupChatBtn.addEventListener('click', function () {
        const groupId = groupChatBtn.dataset.groupId;
        if (groupId) FSIm.openGroupChat(groupId, groupChatBtn.dataset.groupName || '');
      });
    }

    FSState.on('change', function (partial) {
      if (partial.parcel && FSNavigation.isTabActive('land')) {
        const parcel = partial.parcel;
        if (parcel.groupName) {
          setProfileField('land-group', parcel.groupName, parcel.groupId, 'group');
        }
        if (parcel.ownerName || parcel.isGroupOwned) {
          const owner = ownerFieldInfo(parcel);
          setProfileField('land-owner', owner.label, owner.id, owner.type);
        }
      }
      if (!partial.parcel || !FSNavigation.isTabActive('land')) return;
      if (parcelNeedsLoad(partial.parcel)) {
        clearDisplay();
        showLoading();
        return;
      }
      applyParcel(partial.parcel);
    });

    // Re-resolve the owner + group display fields from the caches. Group names
    // arrive asynchronously (AgentGroupDataUpdate / GroupProfileReply), and the
    // owner (on Linden/avatar-owned parcels) via names-updated - all of it AFTER
    // the form first paints. Without this the fields stay stuck on the UUID or
    // "(resolving…)".
    function refreshOwnerGroupFields() {
      const parcel = FSState.get().parcel;
      if (!parcel || parcel.stub) return;
      const owner = ownerFieldInfo(parcel);
      setProfileField('land-owner', owner.label, owner.id, owner.type);
      const groupLabel = parcel.groupName ||
        (typeof FSTransport.getGroupName === 'function' ? FSTransport.getGroupName(parcel.groupId) : '') ||
        (FSProfiles.getGroupName ? FSProfiles.getGroupName(parcel.groupId) : '') ||
        parcel.groupId || '';
      setProfileField('land-group', groupLabel, parcel.groupId, 'group');
      // Re-render the summary line as well, since it shows the owner/group name too.
      renderSummary(parcel);
    }

    if (typeof FSProfiles !== 'undefined') {
      FSProfiles.onChange(function (evt) {
        if (!FSNavigation.isTabActive('land')) return;
        // The group name resolves via 'group' (GroupProfileReply) or 'membership'
        // (AgentGroupDataUpdate). Older code watched for a 'group-name' kind that
        // is never emitted, so the field never refreshed.
        if (evt && (evt.kind === 'group' || evt.kind === 'membership' || evt.kind === 'group-name')) {
          refreshOwnerGroupFields();
        }
      });
    }
    if (typeof FSTransport !== 'undefined' && FSTransport.on) {
      FSTransport.on('names-updated', function () {
        if (FSNavigation.isTabActive('land')) refreshOwnerGroupFields();
      });
      // Parcel UUID + Traffic (dwell) come in via RemoteParcelRequest -> parcel-info.
      FSTransport.on('parcel-info', mergeParcelExtras);
    }

    if (typeof FSTransport !== 'undefined') {
      FSTransport.on('teleport-finish', function () {
        clearDisplay();
        showLoading();
        if (typeof FSTransport.refreshParcel === 'function') {
          FSTransport.refreshParcel().then(function () {
            applyParcel(FSState.get().parcel);
          }).finally(function () {
            hideLoading();
          });
        } else {
          hideLoading();
        }
      });
    }

    FSState.on('reset', function () {
      clearDisplay();
      hideLoading();
    });

    setLandTab('general');
  }

  return { init: init, populateForm: populateForm, applyParcel: applyParcel, activate: activate };
})();
