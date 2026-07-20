/**
 * Land / parcel management panel.
 */
const FSLand = (function () {
  'use strict';

  const PANEL_ID = 'panel-land';
  const LOADING_MESSAGE = 'Loading land data, please wait...';

  const EDITABLE_IDS = [
    'land-name', 'land-desc', 'land-access', 'land-push',
    'land-build-everyone', 'land-build-group',
    'land-scripts-everyone', 'land-scripts-group',
    'land-fly', 'land-safe', 'land-search',
    'land-sound-local', 'land-voice', 'land-sell-passes',
    'land-music', 'land-media'
  ];

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
    if (!parcel || parcel.stub) return false;
    if (parcel.canEdit !== undefined) return !!parcel.canEdit;
    const agentId = FSState.get().agent && FSState.get().agent.id;
    return FSUtils.canEditParcel(parcel, agentId);
  }

  function readOnlyNote(parcel) {
    if (parcel.isGroupOwned) {
      return 'View only — group land requires officer powers to edit';
    }
    return 'View only — you do not own this parcel';
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

  function populateForm(parcel) {
    if (!parcel || parcel.stub) return;

    const canEdit = parcelCanEdit(parcel);
    const primsUsed = parcel.primsUsed !== undefined && parcel.primsUsed !== null ? parcel.primsUsed : 0;
    let primsTotal = parcel.primsTotal || 0;
    if (!primsTotal && parcel.area > 0 && typeof FSUtils.estimateParcelPrimCapacity === 'function') {
      primsTotal = FSUtils.estimateParcelPrimCapacity(parcel.area, parcel.parcelPrimBonus);
    }

    setFieldValue('land-name', parcel.name || '');
    setFieldValue('land-desc', parcel.desc || '');
    setFieldValue('land-uuid', parcel.parcelId || '');
    setFieldValue('land-area', parcel.area ? parcel.area + ' m\u00B2' : '');
    setFieldValue('land-traffic', parcel.dwell !== undefined && parcel.dwell !== null
      ? Math.round(parcel.dwell)
      : '');
    setFieldValue('land-owner', parcel.ownerName || parcel.ownerId || '');
    setFieldValue('land-group', parcel.groupName || parcel.groupId || '');
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

    const summary = document.getElementById('land-summary');
    if (summary) {
      let html =
        'Standing on <strong>' + FSUtils.escapeHtml(parcel.name) + '</strong><br>' +
        'Owner: ' + FSUtils.escapeHtml(parcel.ownerName || 'Unknown') +
        (parcel.groupName ? ' &middot; Group: ' + FSUtils.escapeHtml(parcel.groupName) : '');
      if (!canEdit) {
        html += '<br><span class="land-summary__note">' +
          FSUtils.escapeHtml(readOnlyNote(parcel)) + '</span>';
      }
      summary.innerHTML = html;
    }
  }

  function collectForm() {
    return {
      name: document.getElementById('land-name').value.trim(),
      desc: document.getElementById('land-desc').value.trim(),
      access: parseInt(document.getElementById('land-access').value, 10),
      pushRestricted: document.getElementById('land-push').checked,
      allowBuild: document.getElementById('land-build-everyone').checked ||
        document.getElementById('land-build-group').checked,
      allowScripts: document.getElementById('land-scripts-everyone').checked ||
        document.getElementById('land-scripts-group').checked,
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
    const data = collectForm();
    const btn = document.getElementById('land-apply') || e.target.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Applying...';

    try {
      await FSTransport.updateParcel(data);
      FSUtils.showToast('Parcel updated', 'success');
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
      if (partial.parcel && partial.parcel.groupName && FSNavigation.isTabActive('land')) {
        setFieldValue('land-group', partial.parcel.groupName);
      }
      if (!partial.parcel || !FSNavigation.isTabActive('land')) return;
      if (parcelNeedsLoad(partial.parcel)) {
        clearDisplay();
        showLoading();
        return;
      }
      applyParcel(partial.parcel);
    });

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
