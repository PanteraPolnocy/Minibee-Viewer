/**
 * Land / parcel management panel - the Land tab's view and edit logic.
 */
const BeeLand = (function () {
  'use strict';

  const t = BeeI18n.t;
  const th = BeeI18n.html;

  const PANEL_ID = 'panel-land';

  function loadingMessage() {
    return t('land.loading');
  }

  const EDITABLE_IDS = [
    'land-name', 'land-desc', 'land-push',
    'land-build-everyone', 'land-build-group',
    'land-scripts-everyone', 'land-scripts-group',
    'land-fly', 'land-safe', 'land-search',
    'land-sound-local', 'land-av-sounds-all', 'land-av-sounds-group',
    'land-voice', 'land-voice-estate', 'land-sell-passes',
    'land-mature', 'land-see-avs', 'land-category',
    'land-music', 'land-media',
    'land-terraform', 'land-entry-all', 'land-entry-group', 'land-deed-allow',
    'land-landing-type', 'land-autoreturn',
    'land-access-public', 'land-access-group', 'land-deny-anon', 'land-deny-unverified',
    'land-pass-price', 'land-pass-hours'
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

  function showLoading(message?) {
    setLandPending(true);
    if (typeof BeePanelBusy !== 'undefined') {
      BeePanelBusy.show(PANEL_ID, message || loadingMessage());
    }
  }

  function hideLoading() {
    setLandPending(false);
    if (typeof BeePanelBusy !== 'undefined') {
      BeePanelBusy.hide(PANEL_ID);
    }
  }

  function setFieldValue(id, value) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    if (el.type === 'checkbox') {
      el.checked = !!value;
      return;
    }
    el.value = value !== undefined && value !== null ? String(value) : '';
  }

  function clearDisplay() {
    formBaseline = null;
    const form = document.getElementById('land-form') as HTMLFormElement | null;
    if (form) form.reset();
    const snapshot = document.getElementById('land-snapshot') as HTMLImageElement | null;
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
      return t('land.viewOnlyGroup');
    }
    return t('land.viewOnlyNotOwner');
  }

  function setFormEditable(canEdit) {
    const form = document.getElementById('land-form') as HTMLFormElement | null;
    if (!form) return;
    EDITABLE_IDS.forEach(function (id) {
      const el = document.getElementById(id) as HTMLInputElement | null;
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
      'land-region-type', 'land-region-rating', 'land-claim-date', 'land-sale-state',
      'land-estate-name', 'land-estate-owner', 'land-covenant-date', 'land-estate-rules',
      'land-covenant-text'
    ].forEach(function (id) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el) return;
      el.disabled = false;
      el.readOnly = true;
    });
    // List editors and the landing-point buttons follow the same permission.
    [
      'land-allow-add-id', 'land-allow-add', 'land-ban-add-id', 'land-ban-hours',
      'land-ban-add', 'land-landing-set', 'land-landing-clear'
    ].forEach(function (id) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.disabled = !canEdit;
    });
    // The avatar visibility/sound trio can only travel in the capability body.
    // Where the region offers no capability the save falls back to UDP, which
    // cannot carry them - so show them, but don't invite an edit that would
    // quietly do nothing.
    const parcel = BeeState.get().parcel;
    const capFields = !parcel || parcel.canEditCapFields !== false;
    ['land-see-avs', 'land-av-sounds-all', 'land-av-sounds-group'].forEach(function (id) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el) return;
      el.disabled = !canEdit || !capFields;
      el.title = capFields ? '' : t('land.capFieldUnsupported');
    });
    const submit = document.getElementById('land-apply') as HTMLButtonElement | null || form.querySelector('[type="submit"]');
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
    const btn = document.getElementById('land-group-chat') as HTMLButtonElement | null;
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
        (typeof BeeTransport.getGroupName === 'function' ? BeeTransport.getGroupName(id) : '') ||
        (typeof BeeProfiles !== 'undefined' && BeeProfiles.getGroupName ? BeeProfiles.getGroupName(id) : '') ||
        t('land.groupOwned');
      return { id: id, label: label, type: 'group', isGroup: true };
    }
    const label = parcel.ownerName ||
      (typeof BeeTransport.getCachedName === 'function' ? BeeTransport.getCachedName(id) : '') ||
      (id ? t('land.residentResolving') : '');
    return { id: id, label: label, type: 'avatar', isGroup: false };
  }

  function setProfileField(id, label, entityId, entityType) {
    const field = document.getElementById(id) as HTMLInputElement | null;
    if (!field) return;
    const text = label || entityId || '';
    field.value = text;
    field.classList.toggle('land-field--profile', !!(entityId && text));
    field.dataset.profileId = entityId || '';
    field.dataset.profileType = entityType || '';
    field.title = !entityId ? ''
      : entityType === 'group' ? t('land.openGroupProfile')
        : t('land.openAvatarProfile');
  }

  function bindProfileFields() {
    ['land-owner', 'land-group'].forEach(function (id) {
      const field = document.getElementById(id) as HTMLInputElement | null;
      if (!field || field.dataset.profileBound) return;
      field.dataset.profileBound = '1';
      field.addEventListener('click', function () {
        const entityId = field.dataset.profileId;
        const entityType = field.dataset.profileType;
        if (!entityId) return;
        if (entityType === 'group') BeeProfile.openGroup(entityId);
        else BeeProfile.openAvatar(entityId);
      });
    });
  }

  // What the editable controls held right after the form was last filled from
  // a parcel, keyed by control id, plus which parcel that was. A control that
  // no longer matches has been edited by the user. Parcel patches keep arriving
  // while the form is open (the RemoteParcelRequest reply on every tab
  // activation, name resolutions, a staged landing point, the sim's own
  // ParcelProperties) and each used to rewrite every control, wiping the edit.
  let formBaseline = null; // { key, values }

  function parcelKey(parcel) {
    if (!parcel) return '';
    return parcel.localId ? 'local:' + parcel.localId : 'id:' + BeeUtils.normUuid(parcel.parcelId || '');
  }

  function readEditable(id) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return undefined;
    return el.type === 'checkbox' ? el.checked : el.value;
  }

  // Snapshot from the DOM rather than from the parcel: a <select> given a value
  // it has no option for reads back as '', and that is what an untouched
  // control will compare equal to.
  function captureBaseline(parcel) {
    const values = {};
    EDITABLE_IDS.forEach(function (id) { values[id] = readEditable(id); });
    formBaseline = { key: parcelKey(parcel), values: values };
  }

  function formIsDirty() {
    if (!formBaseline) return false;
    return EDITABLE_IDS.some(function (id) { return readEditable(id) !== formBaseline.values[id]; });
  }

  // Fill the form from a parcel without trampling an edit in progress. The
  // editable controls are rewritten for a different parcel, on an explicit
  // refresh, or while nothing has been touched; the read-only and derived
  // fields (owner, group, area, traffic, prims, permissions) follow every patch.
  function refreshForm(parcel, force?) {
    if (!parcel || parcel.stub) return;
    const sameParcel = !!formBaseline && formBaseline.key === parcelKey(parcel);
    if (force || !sameParcel || !formIsDirty()) {
      populateForm(parcel);
      return;
    }
    populateDerivedFields(parcel);
  }

  function populateForm(parcel) {
    if (!parcel || parcel.stub) return;
    populateEditableFields(parcel);
    populateDerivedFields(parcel);
    captureBaseline(parcel);
  }

  function populateEditableFields(parcel) {
    setFieldValue('land-name', parcel.name || '');
    setFieldValue('land-desc', parcel.desc || '');
    setFieldValue('land-push', parcel.pushRestricted);
    setFieldValue('land-fly', parcel.allowFly);
    setFieldValue('land-build-everyone', parcel.allowBuildEveryone);
    setFieldValue('land-build-group', parcel.allowBuildGroup);
    setFieldValue('land-scripts-everyone', parcel.allowScriptsEveryone);
    setFieldValue('land-scripts-group', parcel.allowScriptsGroup);
    setFieldValue('land-safe', parcel.safeEnvironment !== false);
    setFieldValue('land-search', parcel.showInSearch);
    setFieldValue('land-sound-local', parcel.soundLocal);
    // Absent means allowed, the same legacy default the core applies.
    setFieldValue('land-av-sounds-all', parcel.anyAvSounds !== false);
    setFieldValue('land-av-sounds-group', parcel.groupAvSounds !== false);
    setFieldValue('land-see-avs', parcel.seeAvs !== false);
    setFieldValue('land-voice', parcel.allowVoice !== false);
    setFieldValue('land-voice-estate', parcel.voiceUseEstate);
    setFieldValue('land-mature', parcel.maturePublish);
    setFieldValue('land-category', parcel.category || 0);
    setFieldValue('land-sell-passes', parcel.sellPasses);
    setFieldValue('land-music', parcel.musicUrl || '');
    setFieldValue('land-media', parcel.mediaUrl || '');
    setFieldValue('land-pass-price', parcel.passPrice || 0);
    setFieldValue('land-pass-hours', parcel.passHours || 0);
    // Options / Access / Objects extras.
    setFieldValue('land-terraform', parcel.allowTerraform);
    setFieldValue('land-entry-all', parcel.allowObjectEntryAll);
    setFieldValue('land-entry-group', parcel.allowObjectEntryGroup);
    setFieldValue('land-deed-allow', parcel.allowDeedToGroup);
    setFieldValue('land-landing-type', String(parcel.landingType || 0));
    setFieldValue('land-autoreturn', parcel.otherCleanTime || 0);
    // "Public access" is the inverse of the access-list flag; there is no
    // separate public bit in the protocol.
    setFieldValue('land-access-public', !parcel.useAccessList);
    setFieldValue('land-access-group', parcel.useAccessGroup);
    setFieldValue('land-deny-anon', parcel.denyAnonymous);
    setFieldValue('land-deny-unverified', parcel.denyAgeUnverified);
  }

  // Everything the user cannot type into: identity, ownership, counts, the
  // permission state of the controls and the summary line.
  function populateDerivedFields(parcel) {
    const canEdit = parcelCanEdit(parcel);
    const primsUsed = parcel.primsUsed !== undefined && parcel.primsUsed !== null ? parcel.primsUsed : 0;
    const primsTotal = parcel.primsTotal || 0; // comes from the Rust parcel handler

    setFieldValue('land-uuid', parcel.parcelId || '');
    setFieldValue('land-area', parcel.area ? t('land.areaSqm', { value: parcel.area }) : '');
    setFieldValue('land-traffic', parcel.dwell !== undefined && parcel.dwell !== null
      ? Math.round(parcel.dwell)
      : '');
    const owner = ownerFieldInfo(parcel);
    const ownerLabel = owner.label;
    const groupLabel = parcel.groupName ||
      (typeof BeeTransport.getGroupName === 'function' ? BeeTransport.getGroupName(parcel.groupId) : '') ||
      parcel.groupId || '';
    setProfileField('land-owner', ownerLabel, owner.id, owner.type);
    setProfileField('land-group', groupLabel, parcel.groupId, 'group');
    // Kick off the right kind of name lookup so the field never shows a bare UUID.
    if (owner.isGroup && owner.id && owner.id !== ZERO_UUID && !parcel.groupName &&
        BeeProfiles.queueGroupName) {
      BeeProfiles.queueGroupName(owner.id);
    } else if (!owner.isGroup && owner.id && owner.id !== ZERO_UUID && !parcel.ownerName &&
        typeof BeeTransport.queueNameResolve === 'function') {
      BeeTransport.queueNameResolve([owner.id]);
    }
    if (parcel.groupId && parcel.groupId !== ZERO_UUID && !parcel.groupName) {
      BeeProfiles.queueGroupName(parcel.groupId);
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
    setFieldValue('land-media-type', parcel.mediaType || '');
    setFieldValue('land-media-desc', parcel.mediaDesc || '');
    renderGeneralExtras(parcel);
    updateMoneyActions(parcel);

    if (parcel.landingPoint) {
      const lp = parcel.landingPoint;
      setFieldValue('land-landing', lp.x + ', ' + lp.y + ', ' + lp.z);
    } else {
      setFieldValue('land-landing', '');
    }

    const snapshot = document.getElementById('land-snapshot') as HTMLImageElement | null;
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

  // Renders the summary line ("Standing on ... Owner: ... Group: ..."). It lives on its
  // own so we can re-render it once the owner/group name resolves after the form
  // first paints - otherwise it stays stuck showing the UUID.
  function renderSummary(parcel) {
    const summary = document.getElementById('land-summary');
    if (!summary || !parcel || parcel.stub) return;
    const canEdit = parcelCanEdit(parcel);
    const owner = ownerFieldInfo(parcel);
    const ownerLabel = owner.label;
    const groupLabel = parcel.groupName ||
      (typeof BeeTransport.getGroupName === 'function' ? BeeTransport.getGroupName(parcel.groupId) : '') ||
      (BeeProfiles.getGroupName ? BeeProfiles.getGroupName(parcel.groupId) : '') ||
      parcel.groupId || '';
    const ownerLink = owner.id
      ? '<button type="button" class="profile-inline-link" data-profile-type="' + owner.type +
        '" data-profile-id="' + BeeUtils.escapeHtml(owner.id) + '">' +
        BeeUtils.escapeHtml(ownerLabel) + '</button>'
      : BeeUtils.escapeHtml(ownerLabel || t('common.unknown'));
    const groupLink = parcel.groupId && parcel.groupId !== ZERO_UUID
      ? '<button type="button" class="profile-inline-link" data-profile-type="group" data-profile-id="' +
        BeeUtils.escapeHtml(parcel.groupId) + '">' + BeeUtils.escapeHtml(groupLabel) + '</button>'
      : '';
    // The owner and group are links, so their labels sit outside the lines.
    let html =
      th('land.summaryStanding', { name: parcel.name }) + '<br>' +
      BeeUtils.escapeHtml(t('land.summaryOwner')) + ' ' + ownerLink +
      (groupLink ? ' &middot; ' + BeeUtils.escapeHtml(t('land.summaryGroup')) + ' ' + groupLink : '');
    if (!canEdit) {
      html += '<br><span class="land-summary__note">' +
        BeeUtils.escapeHtml(readOnlyNote(parcel)) + '</span>';
    }
    summary.innerHTML = html;
    summary.querySelectorAll<HTMLElement>('.profile-inline-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const entityId = btn.getAttribute('data-profile-id');
        const entityType = btn.getAttribute('data-profile-type');
        if (!entityId) return;
        if (entityType === 'group') BeeProfile.openGroup(entityId);
        else BeeProfile.openAvatar(entityId);
      });
    });
  }

  // --- General tab extras -----------------------------------------------

  // The region's rating by its access code (13 / 21 / 42).
  function ratingName(access) {
    const code = Number(access);
    if (code === 13) return t('land.ratingGeneral');
    if (code === 21) return t('land.ratingModerate');
    if (code === 42) return t('land.ratingAdult');
    return '';
  }

  function renderGeneralExtras(parcel) {
    const region = BeeState.get().region || {};
    setFieldValue('land-region-type', region.productName || '');
    setFieldValue('land-region-rating', ratingName(region.access));
    // Claim date only means something on leased land (status 0 = leased).
    const claim = parcel.claimDate && parcel.status === 0
      ? new Date(parcel.claimDate * 1000).toLocaleString(BeeI18n.dateLocale())
      : '';
    setFieldValue('land-claim-date', claim);
    let sale = t('land.notForSale');
    if (parcel.auctionId) {
      sale = t('land.auction', { id: parcel.auctionId });
    } else if (parcel.forSale) {
      const price = Number(parcel.salePrice) || 0;
      const each = parcel.area > 0 ? (price / parcel.area).toFixed(1) : '0';
      const args = { price: BeeI18n.formatNumber(price), each: each };
      sale = parcel.sellWithObjects
        ? t('land.salePriceWithObjects', args)
        : t('land.salePrice', args);
    }
    setFieldValue('land-sale-state', sale);
  }

  function isSelfOwner(parcel) {
    const me = (BeeState.get().agent || {}).id || '';
    return !!me && !parcel.isGroupOwned &&
      String(parcel.ownerId || '').toLowerCase() === String(me).toLowerCase();
  }

  function updateMoneyActions(parcel) {
    const show = function (id, on) {
      const btn = document.getElementById(id) as HTMLButtonElement | null;
      if (btn) btn.hidden = !on;
    };
    const online = BeeState.gridOnline();
    const mine = isSelfOwner(parcel);
    show('land-buy', online && !!parcel.forSale && !mine);
    show('land-buy-pass', online && !!parcel.sellPasses && !mine);
    show('land-deed', online && mine && !!parcel.allowDeedToGroup);
    show('land-abandon', online && mine);
  }

  // A control that isn't in the DOM must not contribute a key at all.
  // Object.assign happily copies an undefined over the sim's real value, and
  // JSON.stringify then drops the key on the way to the core - so the core
  // falls back to a default and a missing checkbox becomes a silent settings
  // change. Dropping the key here keeps the baseline value instead.
  function omitUndefined(o) {
    const out = {};
    Object.keys(o).forEach(function (k) {
      if (o[k] !== undefined) out[k] = o[k];
    });
    return out;
  }

  function collectForm() {
    // Collect every editable control, keeping everyone vs group distinct, so the
    // update can carry them all; the transport folds each into its own PF_ bit.
    const checked = function (id) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      return el ? el.checked : undefined;
    };
    // Same rule for numbers: absent control -> no key, never a fabricated 0.
    const num = function (id) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el) return undefined;
      const n = Number(el.value);
      return Number.isFinite(n) ? n : undefined;
    };
    return omitUndefined({
      // Verbatim, no trim: a parcel named "Beach " must round-trip untouched
      // when the user only toggled a checkbox - silently altering the name on
      // an unrelated save is a wrong save.
      name: (document.getElementById('land-name') as HTMLInputElement).value,
      desc: (document.getElementById('land-desc') as HTMLTextAreaElement).value,
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
      // Only the capability save can carry these three; the UDP fallback
      // leaves them as the sim already has them.
      anyAvSounds: checked('land-av-sounds-all'),
      groupAvSounds: checked('land-av-sounds-group'),
      seeAvs: checked('land-see-avs'),
      voiceUseEstate: checked('land-voice-estate'),
      maturePublish: checked('land-mature'),
      category: num('land-category'),
      sellPasses: checked('land-sell-passes'),
      musicUrl: (document.getElementById('land-music') as HTMLInputElement).value.trim(),
      mediaUrl: (document.getElementById('land-media') as HTMLInputElement).value.trim(),
      allowTerraform: checked('land-terraform'),
      allowObjectEntryAll: checked('land-entry-all'),
      // Entry for everyone implies entry for the group, the way building does.
      allowObjectEntryGroup: checked('land-entry-group') || checked('land-entry-all'),
      allowDeedToGroup: checked('land-deed-allow'),
      denyAnonymous: checked('land-deny-anon'),
      denyAgeUnverified: checked('land-deny-unverified'),
      // "Public access" is stored inverted as PF_USE_ACCESS_LIST.
      useAccessList: !checked('land-access-public'),
      useAccessGroup: checked('land-access-group'),
      landingType: num('land-landing-type'),
      passPrice: num('land-pass-price'),
      passHours: num('land-pass-hours')
    });
  }

  function numberValue(id, fallback) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return fallback;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : fallback;
  }

  // --- Access / ban lists -------------------------------------------------
  // Each list is a wholesale replace on the wire, so the UI keeps the current
  // set and sends it entire after every add/remove. The core chunks it.

  const lists = { access: [], ban: [], allowExp: [], blockExp: [] };
  let ownersLoaded = false;
  let covenantLoaded = false;
  let envLoaded = false;

  function flagsOf() { return BeeTransport.accessListFlags(); }

  function listFor(flags) {
    const f = flagsOf();
    if (flags === f.access) return 'access';
    if (flags === f.ban) return 'ban';
    if (flags === f.allowExperience) return 'allowExp';
    if (flags === f.blockExperience) return 'blockExp';
    return '';
  }

  function nameFor(id) {
    const cached = BeeTransport.getCachedName ? BeeTransport.getCachedName(id) : '';
    return cached || id;
  }

  function renderEntryList(listId, entries, onRemove, labelFn?) {
    const ul = document.getElementById(listId);
    if (!ul) return;
    ul.innerHTML = '';
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'land-owners-list__empty';
      li.textContent = t('land.nobodyListed');
      ul.appendChild(li);
      return;
    }
    const parcel = BeeState.get().parcel;
    const canEdit = parcelCanEdit(parcel);
    entries.forEach(function (entry) {
      const li = document.createElement('li');
      li.className = 'land-owners-list__row';
      // The shared context menu turns the id into profile/copy entries.
      if (entry.id) {
        li.dataset.agentId = entry.id;
        li.dataset.label = nameFor(entry.id);
      }
      const label = document.createElement('span');
      label.textContent = labelFn ? labelFn(entry) : nameFor(entry.id);
      li.appendChild(label);
      if (onRemove && canEdit) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--ghost btn--sm';
        btn.textContent = t('common.remove');
        btn.addEventListener('click', function () { onRemove(entry); });
        li.appendChild(btn);
      }
      ul.appendChild(li);
    });
  }

  function banLabel(entry) {
    const who = nameFor(entry.id);
    if (!entry.time) return who;
    return t('land.banUntil', { who: who, date: new Date(entry.time * 1000).toLocaleString(BeeI18n.dateLocale()) });
  }

  function renderAccessLists() {
    renderEntryList('land-allow-list', lists.access, function (entry) {
      saveList('access', lists.access.filter(function (e) { return e.id !== entry.id; }));
    });
    renderEntryList('land-ban-list', lists.ban, function (entry) {
      saveList('ban', lists.ban.filter(function (e) { return e.id !== entry.id; }));
    }, banLabel);
  }

  function saveList(which, entries) {
    const parcel = BeeState.get().parcel;
    if (!parcel || !parcelCanEdit(parcel)) return;
    const f = flagsOf();
    const flags = which === 'access' ? f.access : f.ban;
    lists[which] = entries;
    renderAccessLists();
    BeeTransport.updateParcelAccess(parcel.localId, flags, entries).then(function () {
      BeeUtils.showToast(which === 'ban' ? t('land.banListSaved')
        : t('land.allowListSaved'), 'success');
      // Pull the list back from the sim: it holds the authoritative ban
      // expiry times (the core computes those, not this file).
      requestAccessLists();
    }).catch(function (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || t('land.listSaveFailed'), 'error');
    });
  }

  function addToList(which, inputId, hoursId?) {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (!input) return;
    const id = BeeUtils.normUuid(input.value.trim());
    if (!id || BeeProfiles.isZero(id)) {
      BeeUtils.showToast(t('land.enterUuid'), 'warning');
      return;
    }
    const current = lists[which].slice();
    if (current.some(function (e) { return e.id === id; })) {
      BeeUtils.showToast(t('land.alreadyListed'), 'warning');
      return;
    }
    // The Rust core turns hours into an absolute expiry with its own clock.
    const entry: { id: string; time: number; hours?: number } = { id: id, time: 0 };
    if (hoursId) {
      const hours = numberValue(hoursId, 0);
      if (hours > 0) entry.hours = hours;
    }
    current.push(entry);
    // Allowing someone un-bans them and vice versa, so the opposite list is
    // saved too when it actually changes.
    const other = which === 'access' ? 'ban' : 'access';
    const pruned = lists[other].filter(function (e) { return e.id !== id; });
    input.value = '';
    saveList(which, current);
    if (pruned.length !== lists[other].length) saveList(other, pruned);
    if (BeeTransport.queueNameResolve) BeeTransport.queueNameResolve([id]);
  }

  function requestAccessLists() {
    const parcel = BeeState.get().parcel;
    if (!parcel || parcel.stub || !parcel.localId) return;
    const f = flagsOf();
    BeeTransport.requestParcelAccess(parcel.localId,
      f.access | f.ban | f.allowExperience | f.blockExperience).catch(function () {});
  }

  // --- Objects tab: owner census -----------------------------------------

  function renderOwners(owners) {
    const ul = document.getElementById('land-owners-list');
    const status = document.getElementById('land-owners-status');
    if (!ul) return;
    ul.innerHTML = '';
    if (status) status.textContent = owners.length ? '' : t('land.noOtherObjects');
    const parcel = BeeState.get().parcel;
    const canEdit = parcelCanEdit(parcel);
    owners.forEach(function (owner) {
      const li = document.createElement('li');
      li.className = 'land-owners-list__row';
      const label = document.createElement('span');
      const who = owner.isGroup ? (BeeProfiles.getGroupName(owner.id) || owner.id) : nameFor(owner.id);
      // Profile and copy entries via the shared context menu.
      if (owner.id) {
        if (owner.isGroup) li.dataset.groupId = owner.id;
        else li.dataset.agentId = owner.id;
        li.dataset.label = who;
      }
      const args = { who: who, count: owner.count };
      label.textContent = owner.isGroup
        ? t('land.ownerPrimsGroup', args)
        : t('land.ownerPrims', args);
      li.appendChild(label);
      if (canEdit) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--ghost btn--sm';
        btn.textContent = t('land.return');
        btn.addEventListener('click', function () { returnOwnerObjects(owner, who); });
        li.appendChild(btn);
      }
      ul.appendChild(li);
    });
  }

  async function returnOwnerObjects(owner, who) {
    const parcel = BeeState.get().parcel;
    if (!parcel) return;
    const args = { who: who, count: owner.count };
    const ok = await BeeUtils.confirm({
      title: t('land.returnTitle'),
      message: owner.isGroup
        ? t('land.returnMessageGroup', args)
        : t('land.returnMessage', args),
      confirmLabel: t('land.return'),
      danger: true
    });
    if (!ok) return;
    const RT_LIST = 16;
    BeeTransport.parcelReturnObjects(parcel.localId, RT_LIST, [owner.id]).then(function () {
      BeeUtils.showToast(t('land.objectsReturned'), 'success');
      requestObjectOwners(true);
      BeeTransport.refreshParcel({ force: true });
    }).catch(function (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || t('land.returnFailed'), 'error');
    });
  }

  function requestObjectOwners(force) {
    const parcel = BeeState.get().parcel;
    if (!parcel || parcel.stub || !parcel.localId) return;
    if (ownersLoaded && !force) return;
    ownersLoaded = true;
    const status = document.getElementById('land-owners-status');
    if (status) status.textContent = t('land.searching');
    BeeTransport.requestParcelObjectOwners(parcel.localId).catch(function () {
      if (status) status.textContent = t('land.ownersFailed');
    });
  }

  // --- Covenant / environment / experiences -------------------------------

  function requestCovenant(force) {
    if (covenantLoaded && !force) return;
    covenantLoaded = true;
    BeeTransport.requestCovenant().catch(function () {});
    BeeTransport.fetchCovenantText().catch(function () {});
  }

  // What the panes last drew from the sim, kept so a language switch can
  // redraw them without asking again: the covenant reply and the covenant
  // text, the environment summary, and whether the access lists and the
  // owner census have been drawn from real data yet (a redraw before that
  // would show an empty list as "nobody").
  let lastCovenant = null;
  let lastCovenantText = null;
  let lastEnv = null;
  let accessPainted = false;
  let ownersPainted = false;

  function renderCovenant(data) {
    setFieldValue('land-estate-name', data.estateName || '');
    const ownerName = nameFor(data.estateOwnerId || '');
    setFieldValue('land-estate-owner', ownerName);
    setFieldValue('land-covenant-date', data.timestamp
      ? new Date(data.timestamp * 1000).toLocaleDateString(BeeI18n.dateLocale()) : t('common.never'));
    const region = BeeState.get().region || {};
    const rules = [];
    rules.push(region.blockLandResell ? t('land.noResale') : t('land.resaleAllowed'));
    rules.push(region.allowParcelChanges
      ? t('land.joinAllowed') : t('land.noJoin'));
    setFieldValue('land-estate-rules', rules.join(' · '));
    if (BeeProfiles.isZero(data.covenantId)) {
      setFieldValue('land-covenant-text', t('land.noCovenant'));
    }
  }

  // The covenant text is the estate's own; only a failure is a line of ours.
  function renderCovenantText(data) {
    setFieldValue('land-covenant-text', data && data.ok
      ? (data.text || '')
      : (BeeI18n.field(data, 'error') || t('land.covenantFailed')));
  }

  function minutesLabel(seconds) {
    return t('land.envMinutes', { value: Math.round(seconds / 60) });
  }

  function renderEnvironment(env) {
    const box = document.getElementById('land-env-summary');
    if (!box) return;
    const rows = [];
    rows.push([t('land.envSource'),
      env.isDefault ? t('land.envRegionDefault') : t('land.envParcelSetting')]);
    if (env.dayName) rows.push([t('land.envDayCycle'), env.dayName]);
    if (env.dayLength > 0) rows.push([t('land.envDayLength'), minutesLabel(env.dayLength)]);
    if (env.dayOffset > 0) rows.push([t('land.envDayOffset'), minutesLabel(env.dayOffset)]);
    const alts = Array.isArray(env.trackAltitudes) ? env.trackAltitudes : [];
    if (alts.length) {
      rows.push([t('land.envSkyAltitudes'), alts.map(function (a) {
        return t('units.m', { value: Math.round(a) });
      }).join(', ')]);
    }
    box.innerHTML = rows.map(function (r) {
      return '<div class="profile-field"><span class="profile-field__label">' +
        BeeUtils.escapeHtml(r[0]) + '</span><span>' + BeeUtils.escapeHtml(String(r[1])) + '</span></div>';
    }).join('');
  }

  function requestEnvironment(force) {
    if (envLoaded && !force) return;
    envLoaded = true;
    const box = document.getElementById('land-env-summary');
    const parcel = BeeState.get().parcel;
    if (!box || !parcel || parcel.stub) return;
    lastEnv = null;
    box.innerHTML = '<p class="field-hint">' + BeeUtils.escapeHtml(t('land.envLoading')) + '</p>';
    BeeTransport.parcelEnvironment(parcel.localId || 0).then(function (env) {
      if (!env || !env.ok) throw new Error(t('land.envNoData'));
      lastEnv = env;
      renderEnvironment(env);
    }).catch(function (err) {
      box.innerHTML = '<p class="field-hint">' +
        BeeUtils.escapeHtml(BeeUtils.errText(err) || t('land.envUnavailable')) +
        '</p>';
    });
  }

  function renderExperiences() {
    const note = document.getElementById('land-exp-note');
    const label = function (entry) { return expNames[entry.id] || entry.id; };
    renderEntryList('land-exp-allow-list', lists.allowExp, null, label);
    renderEntryList('land-exp-block-list', lists.blockExp, null, label);
    if (note) {
      note.textContent = (lists.allowExp.length || lists.blockExp.length)
        ? '' : t('land.noExperiences');
    }
    const ids = lists.allowExp.concat(lists.blockExp)
      .map(function (e) { return e.id; })
      .filter(function (id) { return !expNames[id]; });
    if (ids.length && BeeTransport.experienceNames) {
      BeeTransport.experienceNames(ids).then(function (res) {
        if (!res || !res.names) return;
        let added = false;
        Object.keys(res.names).forEach(function (id) { expNames[id] = res.names[id]; added = true; });
        if (added) renderExperiences();
      }).catch(function () {});
    }
  }
  const expNames = {};

  function setLandTab(tab) {
    activeLandTab = tab || 'general';
    // Panes fetch their data the first time they're opened.
    if (activeLandTab === 'covenant') requestCovenant(false);
    if (activeLandTab === 'environment') requestEnvironment(false);
    if (activeLandTab === 'objects') requestObjectOwners(false);
    if (activeLandTab === 'access' || activeLandTab === 'experiences') requestAccessLists();
    if (activeLandTab === 'experiences') renderExperiences();
    document.querySelectorAll<HTMLElement>('.land-tab').forEach(function (btn) {
      const active = btn.getAttribute('data-land-tab') === activeLandTab;
      btn.classList.toggle('land-tab--active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll<HTMLElement>('.land-pane').forEach(function (pane) {
      const active = pane.getAttribute('data-land-pane') === activeLandTab;
      pane.classList.toggle('land-pane--active', active);
      pane.hidden = !active;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!BeeState.gridOnline()) {
      BeeUtils.showToast(t('session.notConnected'), 'warning');
      return;
    }
    const parcel = BeeState.get().parcel;
    if (!parcelCanEdit(parcel)) {
      BeeUtils.showToast(t('land.cannotEdit'), 'error');
      return;
    }
    // Send the FULL current parcel with the edits layered on top. The core needs
    // localId, the baseline parcelFlags (to fold the checkboxes onto), groupId,
    // snapshotId, the landing point, and so on - collectForm() alone drops them,
    // which would zero those fields on the sim and lose data.
    const form = collectForm();
    const data = Object.assign({}, parcel, form);
    // Which save the core should use. The capability replaces the parcel
    // wholesale, so a field Linden Lab adds later - one this build knows
    // nothing about and therefore cannot echo back - would be reset to its
    // default by every capability save. The ordinary message only carries the
    // fields it defines, leaving anything newer untouched. So ask for the
    // capability only when the change genuinely needs it: these three settings
    // exist nowhere else on the wire.
    const CAP_ONLY = ['seeAvs', 'anyAvSounds', 'groupAvSounds'];
    data.useCapSave = CAP_ONLY.some(function (k) {
      // Both sides default to "allowed" when the sim never said otherwise.
      return form[k] !== undefined && !!form[k] !== (parcel[k] !== false);
    });
    const btn = document.getElementById('land-apply') as HTMLButtonElement | null || e.target.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = t('land.applying');

    try {
      await BeeTransport.updateParcel(data);
      // What is on screen is now what the sim holds, so the form is clean: the
      // refreshed parcel below may fill every control again.
      captureBaseline(parcel);
      BeeUtils.showToast(t('land.updated'), 'success');
      // Re-fetch the authoritative parcel data so the form and the next save's
      // baseline reflect what the sim actually stored.
      if (typeof BeeTransport.refreshParcel === 'function') {
        BeeTransport.refreshParcel({ force: true })
          .then(function () { applyParcel(BeeState.get().parcel); })
          .catch(function () { /* leave the optimistic values in place */ });
      }
    } catch (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || t('land.updateFailed'), 'error');
    } finally {
      btn.disabled = !parcelCanEdit(BeeState.get().parcel);
      btn.textContent = t('land.applyChanges');
    }
  }

  let lastLocalId = 0;

  // `force` rewrites the editable controls even over an unsaved edit - only
  // the explicit Refresh button asks for that.
  function applyParcel(parcel, force?) {
    if (parcelNeedsLoad(parcel)) return;
    // A different parcel invalidates the pane caches (lists, owners, env).
    if (parcel.localId && parcel.localId !== lastLocalId) {
      lastLocalId = parcel.localId;
      resetPaneCaches();
      if (BeeNavigation.isTabActive('land')) {
        if (activeLandTab === 'access' || activeLandTab === 'experiences') requestAccessLists();
        if (activeLandTab === 'objects') requestObjectOwners(true);
        if (activeLandTab === 'environment') requestEnvironment(true);
      }
    }
    refreshForm(parcel, force);
    hideLoading();
  }

  // ParcelProperties carries neither the parcel UUID nor dwell (Traffic), so we
  // fetch them via RemoteParcelRequest for the parcel the agent is standing on.
  // The matching parcel-info event (correlated by id below) merges them back in.
  let expectedParcelInfoId = '';
  function requestParcelExtras() {
    if (typeof BeeTransport.remoteParcel !== 'function') return;
    const region = BeeState.get().region || {};
    const pos: { x?: number; y?: number; z?: number } = BeeState.get().position || {};
    const gx = region.x != null ? region.x : region.gridX;
    const gy = region.y != null ? region.y : region.gridY;
    if (gx == null || gy == null) return;
    BeeTransport.remoteParcel(gx, gy,
      pos.x != null ? pos.x : 128, pos.y != null ? pos.y : 128, pos.z != null ? pos.z : 25
    ).then(function (res) {
      if (res && res.parcelId) expectedParcelInfoId = BeeUtils.normUuid(res.parcelId);
    });
  }

  function mergeParcelExtras(info) {
    if (!info || !info.parcelId) return;
    // Accept only the parcel we're standing on - its id came back from our own
    // request - never a place-search detail's parcel-info.
    if (BeeUtils.normUuid(info.parcelId) !== expectedParcelInfoId) return;
    const parcel = BeeState.get().parcel;
    if (!parcel || parcel.stub) return;
    BeeState.patch({ parcel: Object.assign({}, parcel, {
      parcelId: info.parcelId,
      dwell: info.dwell
    }) });
    if (BeeNavigation.isTabActive('land')) {
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
    const parcel = BeeState.get().parcel;
    const pending = parcelNeedsLoad(parcel);
    requestParcelExtras(); // fetch the parcel UUID + Traffic, which ParcelProperties omits

    if (pending) {
      clearDisplay();
      showLoading();
    } else {
      // Coming back to the tab must not discard what was typed before leaving.
      refreshForm(parcel);
    }

    if (!BeeState.get().sessionLost && typeof BeeTransport.refreshParcel === 'function') {
      const shouldRefresh = pending || !parcelIsRich(BeeState.get().parcel);
      if (shouldRefresh) {
        try {
          await BeeTransport.refreshParcel();
          if (token !== activateToken || !BeeNavigation.isTabActive('land')) return;
          applyParcel(BeeState.get().parcel);
          if (parcelNeedsLoad(BeeState.get().parcel)) {
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

  // Money buttons: the Rust core re-checks everything against its own gated
  // parcel snapshot, so a stale click can never buy the wrong thing - these
  // handlers only confirm intent and report the outcome.
  function bindMoneyActions() {
    const parcelNow = function () { return BeeState.get().parcel || {}; };
    const bind = function (id, fn) {
      const btn = document.getElementById(id) as HTMLButtonElement | null;
      if (btn) btn.addEventListener('click', fn);
    };
    bind('land-buy', async function () {
      const p = parcelNow();
      const price = Number(p.salePrice) || 0;
      const ok = await BeeUtils.confirm({
        title: t('land.buyTitle'),
        message: t('land.buyMessage', {
          name: p.name || t('land.thisParcel'),
          area: p.area || 0,
          price: BeeI18n.formatNumber(price)
        }),
        confirmLabel: t('land.buy')
      });
      if (!ok) return;
      BeeTransport.parcelBuy(p.localId).then(function () {
        BeeUtils.showToast(t('land.purchaseSent'), 'success');
        BeeTransport.refreshParcel({ force: true });
      }).catch(function (err) {
        BeeUtils.showToast(BeeUtils.errText(err) || t('land.purchaseFailed'), 'error');
      });
    });
    bind('land-buy-pass', async function () {
      const p = parcelNow();
      const ok = await BeeUtils.confirm({
        title: t('land.buyPassTitle'),
        message: t('land.buyPassMessage', {
          price: BeeI18n.formatNumber(Number(p.passPrice) || 0),
          name: p.name || t('land.thisParcel'),
          count: p.passHours || 0
        }),
        confirmLabel: t('land.buyPass')
      });
      if (!ok) return;
      BeeTransport.parcelBuyPass(p.localId).then(function () {
        BeeUtils.showToast(t('land.passPurchaseSent'), 'success');
      }).catch(function (err) {
        BeeUtils.showToast(BeeUtils.errText(err) || t('land.passPurchaseFailed'), 'error');
      });
    });
    bind('land-abandon', async function () {
      const p = parcelNow();
      const ok = await BeeUtils.confirm({
        title: t('land.abandonTitle'),
        message: t('land.abandonMessage', { area: p.area || 0 }),
        confirmLabel: t('land.abandon'),
        danger: true
      });
      if (!ok) return;
      BeeTransport.parcelRelease(p.localId).then(function () {
        BeeUtils.showToast(t('land.released'), 'success');
        BeeTransport.refreshParcel({ force: true });
      }).catch(function (err) {
        BeeUtils.showToast(BeeUtils.errText(err) || t('land.releaseFailed'), 'error');
      });
    });
    bind('land-deed', async function () {
      const p = parcelNow();
      const groupId = p.groupId;
      if (!groupId || groupId === ZERO_UUID) {
        BeeUtils.showToast(t('land.setGroupFirst'), 'warning');
        return;
      }
      const groupName = p.groupName || BeeTransport.getGroupName(groupId) || t('land.theParcelGroup');
      const ok = await BeeUtils.confirm({
        title: t('land.deedTitle'),
        message: t('land.deedMessage', { area: p.area || 0, group: groupName }),
        confirmLabel: t('land.deed'),
        danger: true
      });
      if (!ok) return;
      BeeTransport.parcelDeedToGroup(p.localId, groupId).then(function () {
        BeeUtils.showToast(t('land.deedSent'), 'success');
        BeeTransport.refreshParcel({ force: true });
      }).catch(function (err) {
        BeeUtils.showToast(BeeUtils.errText(err) || t('land.deedFailed'), 'error');
      });
    });
  }

  function bindLandExtras() {
    const ownersRefresh = document.getElementById('land-owners-refresh') as HTMLButtonElement | null;
    if (ownersRefresh) ownersRefresh.addEventListener('click', function () { requestObjectOwners(true); });

    const allowAdd = document.getElementById('land-allow-add') as HTMLButtonElement | null;
    if (allowAdd) allowAdd.addEventListener('click', function () { addToList('access', 'land-allow-add-id'); });
    const banAdd = document.getElementById('land-ban-add') as HTMLButtonElement | null;
    if (banAdd) banAdd.addEventListener('click', function () { addToList('ban', 'land-ban-add-id', 'land-ban-hours'); });

    // Autoreturn has its own message; save on change with a changed-value guard.
    const autoreturn = document.getElementById('land-autoreturn');
    if (autoreturn) {
      autoreturn.addEventListener('change', function () {
        const parcel = BeeState.get().parcel;
        if (!parcel || !parcelCanEdit(parcel)) return;
        const minutes = Math.max(0, numberValue('land-autoreturn', 0));
        if (minutes === (parcel.otherCleanTime || 0)) return;
        BeeTransport.parcelSetAutoreturn(parcel.localId, minutes).then(function () {
          BeeUtils.showToast(t('land.autoreturnSaved'), 'success');
          // Saved on its own, so this control no longer counts as an edit.
          if (formBaseline) formBaseline.values['land-autoreturn'] = readEditable('land-autoreturn');
          BeeState.patch({ parcel: Object.assign({}, parcel, { otherCleanTime: minutes }) });
        }).catch(function (err) {
          BeeUtils.showToast(BeeUtils.errText(err) || t('land.autoreturnFailed'), 'error');
        });
      });
    }

    // Landing point staging: the values ride the normal Apply Changes save.
    const landingSet = document.getElementById('land-landing-set');
    if (landingSet) {
      landingSet.addEventListener('click', function () {
        const parcel = BeeState.get().parcel;
        const pos = BeeState.get().position;
        if (!parcel || !pos || !parcelCanEdit(parcel)) return;
        const next = Object.assign({}, parcel, {
          userLocation: { x: pos.x, y: pos.y, z: pos.z },
          userLookAt: { x: 1, y: 0, z: 0 },
          landingPoint: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
          landingType: 1
        });
        BeeState.patch({ parcel: next });
        setFieldValue('land-landing-type', '1');
        BeeUtils.showToast(t('land.landingStaged'), 'info');
      });
    }
    const landingClear = document.getElementById('land-landing-clear');
    if (landingClear) {
      landingClear.addEventListener('click', function () {
        const parcel = BeeState.get().parcel;
        if (!parcel || !parcelCanEdit(parcel)) return;
        const next = Object.assign({}, parcel, {
          userLocation: { x: 0, y: 0, z: 0 },
          userLookAt: { x: 0, y: 0, z: 0 },
          landingPoint: null
        });
        BeeState.patch({ parcel: next });
        BeeUtils.showToast(t('land.landingCleared'), 'info');
      });
    }

    const envRefresh = document.getElementById('land-env-refresh');
    if (envRefresh) envRefresh.addEventListener('click', function () { requestEnvironment(true); });

    // Backend events feeding the panes.
    BeeTransport.on('parcel-access', function (data) {
      if (!data) return;
      const parcel = BeeState.get().parcel;
      if (!parcel || data.localId !== parcel.localId) return;
      const key = listFor(data.flags);
      if (!key) return;
      lists[key] = (data.entries || []).slice();
      if (key === 'access' || key === 'ban') {
        accessPainted = true;
        renderAccessLists();
      } else {
        renderExperiences();
      }
    });
    BeeTransport.on('parcel-object-owners', function (data) {
      lastOwners = (data && data.owners) || [];
      ownersPainted = true;
      renderOwners(lastOwners);
    });
    BeeTransport.on('covenant', function (data) {
      if (!data) return;
      lastCovenant = data;
      renderCovenant(data);
    });
    BeeTransport.on('covenant-text', function (data) {
      lastCovenantText = data || null;
      renderCovenantText(data);
    });
    // Names resolving repaints whatever list is visible.
    BeeTransport.on('names-updated', function () {
      if (!BeeNavigation.isTabActive('land')) return;
      if (activeLandTab === 'access') renderAccessLists();
      if (activeLandTab === 'objects') renderOwners(lastOwners);
    });
  }
  let lastOwners = [];

  // A new parcel under our feet invalidates every cached pane.
  function resetPaneCaches() {
    ownersLoaded = false;
    ownersPainted = false;
    accessPainted = false;
    covenantLoaded = false;
    envLoaded = false;
    lastEnv = null;
    lists.access = []; lists.ban = []; lists.allowExp = []; lists.blockExp = [];
  }

  function init() {
    bindProfileFields();
    bindMoneyActions();
    bindLandExtras();
    (document.getElementById('land-form') as HTMLFormElement).addEventListener('submit', handleSubmit);
    document.getElementById('land-refresh').addEventListener('click', async function () {
      showLoading(t('land.refreshing'));
      try {
        await BeeTransport.refreshParcel({ force: true });
        applyParcel(BeeState.get().parcel, true);
      } finally {
        hideLoading();
      }
    });

    document.querySelectorAll<HTMLElement>('.land-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setLandTab(btn.getAttribute('data-land-tab'));
      });
    });

    const groupChatBtn = document.getElementById('land-group-chat') as HTMLButtonElement | null;
    if (groupChatBtn && typeof BeeIm !== 'undefined' && BeeIm.openGroupChat) {
      groupChatBtn.addEventListener('click', function () {
        const groupId = groupChatBtn.dataset.groupId;
        if (groupId) BeeIm.openGroupChat(groupId, groupChatBtn.dataset.groupName || '');
      });
    }

    BeeState.on('change', function (partial) {
      if (partial.parcel && BeeNavigation.isTabActive('land')) {
        const parcel = partial.parcel;
        if (parcel.groupName) {
          setProfileField('land-group', parcel.groupName, parcel.groupId, 'group');
        }
        if (parcel.ownerName || parcel.isGroupOwned) {
          const owner = ownerFieldInfo(parcel);
          setProfileField('land-owner', owner.label, owner.id, owner.type);
        }
      }
      if (!partial.parcel || !BeeNavigation.isTabActive('land')) return;
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
    // "(resolving...)".
    function refreshOwnerGroupFields() {
      const parcel = BeeState.get().parcel;
      if (!parcel || parcel.stub) return;
      const owner = ownerFieldInfo(parcel);
      setProfileField('land-owner', owner.label, owner.id, owner.type);
      const groupLabel = parcel.groupName ||
        (typeof BeeTransport.getGroupName === 'function' ? BeeTransport.getGroupName(parcel.groupId) : '') ||
        (BeeProfiles.getGroupName ? BeeProfiles.getGroupName(parcel.groupId) : '') ||
        parcel.groupId || '';
      setProfileField('land-group', groupLabel, parcel.groupId, 'group');
      // Re-render the summary line as well, since it shows the owner/group name too.
      renderSummary(parcel);
    }

    if (typeof BeeProfiles !== 'undefined') {
      BeeProfiles.onChange(function (evt) {
        if (!BeeNavigation.isTabActive('land')) return;
        // The group name resolves via 'group' (GroupProfileReply) or 'membership'
        // (AgentGroupDataUpdate). Older code watched for a 'group-name' kind that
        // is never emitted, so the field never refreshed.
        if (evt && (evt.kind === 'group' || evt.kind === 'membership' || evt.kind === 'group-name')) {
          refreshOwnerGroupFields();
        }
      });
    }
    if (typeof BeeTransport !== 'undefined' && BeeTransport.on) {
      BeeTransport.on('names-updated', function () {
        if (BeeNavigation.isTabActive('land')) refreshOwnerGroupFields();
      });
      // Parcel UUID + Traffic (dwell) come in via RemoteParcelRequest -> parcel-info.
      BeeTransport.on('parcel-info', mergeParcelExtras);
    }

    if (typeof BeeTransport !== 'undefined') {
      BeeTransport.on('teleport-finish', function () {
        clearDisplay();
        showLoading();
        if (typeof BeeTransport.refreshParcel === 'function') {
          BeeTransport.refreshParcel().then(function () {
            applyParcel(BeeState.get().parcel);
          }).finally(function () {
            hideLoading();
          });
        } else {
          hideLoading();
        }
      });
    }

    BeeState.on('reset', function () {
      clearDisplay();
      hideLoading();
    });

    // A language switch redraws what this module painted in its own words;
    // the panes keep the data they fetched.
    BeeI18n.onChange(function () {
      const parcel = BeeState.get().parcel;
      if (parcelNeedsLoad(parcel)) return;
      populateDerivedFields(parcel);
      if (accessPainted) renderAccessLists();
      if (ownersPainted) renderOwners(lastOwners);
      renderExperiences();
      if (lastEnv) renderEnvironment(lastEnv);
      if (lastCovenant) renderCovenant(lastCovenant);
      if (lastCovenantText && !lastCovenantText.ok) renderCovenantText(lastCovenantText);
    });

    setLandTab('general');
  }

  return { init: init, populateForm: populateForm, applyParcel: applyParcel, activate: activate };
})();
