/**
 * Avatar and group profile cache, fetch orchestration, and thumbnail IDs.
 */
const FSProfiles = (function () {
  'use strict';

  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
  const THUMB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const PROFILE_TTL_MS = 4 * 60 * 60 * 1000;
  const GROUP_TTL_MS = 24 * 60 * 60 * 1000;
  const GROUP_TITLES_TTL_MS = 15 * 60 * 1000;
  const STORAGE_KEY = 'minibee_profile_cache_v1';
  const CAP_FETCH_GAP_MS = 900;
  const CAP_RATE_RETRY_MS = 2000;
  const CAP_RATE_MAX_RETRIES = 8;
  const THUMB_BATCH_SIZE = 16;
  const THUMB_FLUSH_MS = 0;

  const avatarProfiles = new Map();
  const groupProfiles = new Map();
  const groupNames = new Map();
  const groupTitles = new Map();
  const agentGroups = new Map();
  const pendingGroupTitles = new Map();
  let activeGroupId = '';
  let activeGroupTitle = '';
  const imageIds = new Map();
  const pendingAvatar = new Map();
  const pendingGroup = new Map();
  const pendingThumb = new Set();
  const pickDetails = new Map();
  const classifiedDetails = new Map();
  const pendingPick = new Map();
  const pendingClassified = new Map();
  const listeners = new Set();
  const capFetchActive = new Set();
  const extrasRequested = new Map();

  let hooks = null;
  let thumbTimer = null;
  let thumbInFlight = false;
  let capFetchChain = Promise.resolve();
  let lastCapFetchAt = 0;

  function normId(id) {
    return FSUtils.normUuid(id);
  }

  function isZero(id) {
    const key = normId(id);
    return !key || key === ZERO_UUID;
  }

  function textureImageUrl(uuid, size) {
    const id = normId(uuid);
    if (!isZero(id)) {
      return 'https://secondlife.com/app/image/' + id + '/' + (size || 256);
    }
    return '';
  }

  function loadStorage() {
    const stored = FSUtils.storageGet(STORAGE_KEY, null);
    if (!stored || typeof stored !== 'object') return;
    const now = Date.now();
    (stored.images || []).forEach(function (row) {
      if (!row || !row.id || !row.imageId || isZero(row.imageId)) return;
      if (row.fetchedAt && now - row.fetchedAt > THUMB_TTL_MS) return;
      imageIds.set(normId(row.id), {
        imageId: row.imageId,
        fetchedAt: row.fetchedAt || now
      });
    });
    (stored.groups || []).forEach(function (row) {
      if (!row || !row.id || !row.name) return;
      if (row.fetchedAt && now - row.fetchedAt > GROUP_TTL_MS) return;
      groupNames.set(normId(row.id), {
        name: row.name,
        insigniaId: row.insigniaId || '',
        fetchedAt: row.fetchedAt || now
      });
    });
  }

  function persistStorage() {
    const images = [];
    imageIds.forEach(function (value, id) {
      if (!value || !value.imageId || isZero(value.imageId)) return;
      images.push({ id: id, imageId: value.imageId, fetchedAt: value.fetchedAt || Date.now() });
    });
    const groups = [];
    groupNames.forEach(function (value, id) {
      if (!value || !value.name) return;
      groups.push({
        id: id,
        name: value.name,
        insigniaId: value.insigniaId || '',
        fetchedAt: value.fetchedAt || Date.now()
      });
    });
    FSUtils.storageSet(STORAGE_KEY, { images: images.slice(0, 500), groups: groups.slice(0, 200) });
  }

  function emitChange(kind, id) {
    const payload = { kind: kind, id: normId(id) };
    listeners.forEach(function (fn) {
      try { fn(payload); } catch (_e) { /* ignore */ }
    });
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return function () { listeners.delete(fn); };
  }

  function init(transportHooks) {
    hooks = transportHooks || null;
    loadStorage();
  }

  function clear() {
    avatarProfiles.clear();
    groupProfiles.clear();
    groupNames.clear();
    groupTitles.clear();
    agentGroups.clear();
    pendingGroupTitles.clear();
    activeGroupId = '';
    activeGroupTitle = '';
    imageIds.clear();
    pendingAvatar.clear();
    pendingGroup.clear();
    pendingThumb.clear();
    pickDetails.clear();
    classifiedDetails.clear();
    pendingPick.clear();
    pendingClassified.clear();
    capFetchActive.clear();
    extrasRequested.clear();
    if (thumbTimer) {
      clearTimeout(thumbTimer);
      thumbTimer = null;
    }
    thumbInFlight = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch (_e) { /* ignore */ }
  }

  function cacheImageId(agentId, imageId) {
    const id = normId(agentId);
    const image = normId(imageId);
    if (isZero(id) || isZero(image)) return;
    const prev = imageIds.get(id);
    if (prev && normId(prev.imageId) === image) return;
    imageIds.set(id, { imageId: image, fetchedAt: Date.now() });
    persistStorage();
    emitChange('image', id);
  }

  function getImageId(agentId) {
    const id = normId(agentId);
    const row = imageIds.get(id);
    if (row && row.imageId && !isZero(row.imageId)) {
      if (Date.now() - (row.fetchedAt || 0) > THUMB_TTL_MS) return '';
      return row.imageId;
    }
    const profile = avatarProfiles.get(id);
    if (profile && profile.imageId && !isZero(profile.imageId)) {
      return normId(profile.imageId);
    }
    return '';
  }

  function cacheGroupName(groupId, name, insigniaId) {
    const id = normId(groupId);
    const label = String(name || '').trim();
    if (isZero(id) || !label) return;
    const prev = groupNames.get(id);
    const nextInsignia = insigniaId && !isZero(insigniaId)
      ? normId(insigniaId)
      : ((prev && prev.insigniaId) || '');
    groupNames.set(id, {
      name: label,
      insigniaId: nextInsignia,
      fetchedAt: Date.now()
    });
    persistStorage();
    emitChange('group-name', id);
  }

  function getGroupName(groupId) {
    const row = groupNames.get(normId(groupId));
    return row ? row.name : '';
  }

  function getGroupInsigniaId(groupId) {
    const row = groupNames.get(normId(groupId));
    return row && row.insigniaId ? row.insigniaId : '';
  }

  function preferLongerText(prevText, nextText) {
    const prev = String(prevText || '');
    const next = String(nextText || '');
    if (!next) return prev;
    if (!prev) return next;
    return next.length >= prev.length ? next : prev;
  }

  function emitFetching(agentId) {
    const payload = { kind: 'avatar-fetching', id: normId(agentId) };
    listeners.forEach(function (fn) {
      try { fn(payload); } catch (_e) { /* ignore */ }
    });
  }

  function mergeAvatarProfile(agentId, patch, options) {
    const id = normId(agentId);
    if (isZero(id) || !patch) return null;
    const opts = options || {};
    const prev = avatarProfiles.get(id) || {};
    const nextPatch = Object.assign({}, patch);
    if (Array.isArray(nextPatch.groups)) {
      nextPatch.groups = mergeProfileGroupLists(prev.groups, nextPatch.groups);
    }
    if (nextPatch.source === 'notes-local') {
      // Saved notes from this client always win until the server echoes them back.
    } else if (!nextPatch.notes && prev.notes) delete nextPatch.notes;
    else if (nextPatch.notes && prev.notes &&
        String(prev.notes).length > String(nextPatch.notes).length) {
      delete nextPatch.notes;
    }
    if (nextPatch.about !== undefined) {
      const prevAbout = String(prev.about || '');
      const nextAbout = String(nextPatch.about || '');
      if (prev.source === 'cap' || prevAbout.length > nextAbout.length) {
        delete nextPatch.about;
      }
    }
    if (nextPatch.flAbout !== undefined) {
      const prevFl = String(prev.flAbout || '');
      const nextFl = String(nextPatch.flAbout || '');
      if (prev.source === 'cap' || prevFl.length > nextFl.length) {
        delete nextPatch.flAbout;
      }
    }
    if (prev.source === 'cap' && nextPatch.source && nextPatch.source !== 'cap') {
      if (prev.about) delete nextPatch.about;
      if (prev.flAbout) delete nextPatch.flAbout;
      delete nextPatch.bornOn;
      delete nextPatch.profileUrl;
      delete nextPatch.partnerId;
      if (nextPatch.flags && nextPatch.flags.raw !== undefined &&
          nextPatch.flags.identified === undefined) {
        delete nextPatch.flags;
      }
    } else {
      if (nextPatch.about && prev.about &&
          String(prev.about).length > String(nextPatch.about).length) {
        delete nextPatch.about;
      }
      if (nextPatch.flAbout && prev.flAbout &&
          String(prev.flAbout).length > String(nextPatch.flAbout).length) {
        delete nextPatch.flAbout;
      }
    }
    if (nextPatch.flags || prev.flags) {
      const mergedFlags = Object.assign({}, prev.flags || {}, nextPatch.flags || {});
      if (prev.flags && nextPatch.flags && nextPatch.flags.raw !== undefined &&
          nextPatch.flags.identified === undefined && nextPatch.flags.transacted === undefined) {
        if (prev.flags.identified !== undefined) mergedFlags.identified = prev.flags.identified;
        if (prev.flags.transacted !== undefined) mergedFlags.transacted = prev.flags.transacted;
        if (prev.flags.online !== undefined) mergedFlags.online = prev.flags.online;
        if (prev.flags.allowPublish !== undefined) mergedFlags.allowPublish = prev.flags.allowPublish;
      }
      nextPatch.flags = mergedFlags;
    }
    const next = Object.assign({}, prev, nextPatch, {
      avatarId: id,
      fetchedAt: Date.now()
    });
    next.about = preferLongerText(prev.about, next.about);
    next.flAbout = preferLongerText(prev.flAbout, next.flAbout);
    if (prev.source === 'cap' && next.source !== 'cap') next.source = prev.source;
    if (next.source === 'cap') capFetchActive.delete(id);
    if (patch.imageId) cacheImageId(id, patch.imageId);
    avatarProfiles.set(id, next);
    if (next.groups && next.groups.length && id === getSelfAgentId()) {
      mergeProfileGroupsIntoMembership(id, next.groups);
    }
    if (!opts.silent) emitChange('avatar', id);
    return next;
  }

  function getAvatarProfile(agentId) {
    const row = avatarProfiles.get(normId(agentId));
    if (!row) return null;
    if (Date.now() - (row.fetchedAt || 0) > PROFILE_TTL_MS) return null;
    return row;
  }

  function mergeGroupProfile(groupId, patch, options) {
    const id = normId(groupId);
    if (isZero(id) || !patch) return null;
    const opts = options || {};
    const prev = groupProfiles.get(id) || {};
    const nextPatch = Object.assign({}, patch);
    if (isZero(nextPatch.insigniaId) && prev.insigniaId && !isZero(prev.insigniaId)) {
      delete nextPatch.insigniaId;
    }
    const prevFp = groupProfileFingerprint(prev);
    const next = Object.assign({}, prev, nextPatch, {
      groupId: id,
      fetchedAt: Date.now()
    });
    if (next.name) cacheGroupName(id, next.name, next.insigniaId);
    groupProfiles.set(id, next);
    if (!opts.silent && groupProfileFingerprint(next) !== prevFp) emitChange('group', id);
    return next;
  }

  function getGroupProfile(groupId) {
    const row = groupProfiles.get(normId(groupId));
    if (!row) return null;
    if (Date.now() - (row.fetchedAt || 0) > GROUP_TTL_MS) return null;
    return row;
  }

  function formatBornLabel(bornOn, hideAge) {
    if (!bornOn || hideAge) return hideAge ? 'Age hidden' : '';
    const date = new Date(bornOn);
    if (Number.isNaN(date.getTime())) return String(bornOn);
    const ageDays = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
    let ageLabel = '';
    if (ageDays < 30) ageLabel = ageDays + ' days';
    else if (ageDays < 365) ageLabel = Math.floor(ageDays / 30) + ' months';
    else {
      const years = Math.floor(ageDays / 365);
      ageLabel = years + ' year' + (years === 1 ? '' : 's');
    }
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
      (ageLabel ? ' (' + ageLabel + ')' : '');
  }

  function decodeAvatarFlags(raw) {
    const value = Number(raw) || 0;
    return {
      raw: value,
      allowPublish: (value & 0x1) !== 0,
      online: (value & 0x10) !== 0,
      identified: (value & 0x4) !== 0,
      transacted: (value & 0x8) !== 0
    };
  }

  function capAboutText(data) {
    const candidates = [
      data.sl_about_text,
      data.sl_about,
      data.about_text,
      data.about
    ];
    let best = '';
    candidates.forEach(function (c) {
      const s = String(c || '').trim();
      if (s.length > best.length) best = s;
    });
    return best;
  }

  function capFlAboutText(data) {
    const candidates = [data.fl_about_text, data.fl_about];
    let best = '';
    candidates.forEach(function (c) {
      const s = String(c || '').trim();
      if (s.length > best.length) best = s;
    });
    return best;
  }

  function mapAgentProfileCap(data, requestedAgentId) {
    if (!data || typeof data !== 'object') return null;
    const avatarId = normId(data.id || data.agent_id || requestedAgentId);
    if (isZero(avatarId)) return null;
    const picks = Array.isArray(data.picks) ? data.picks.map(function (p) {
      return { id: normId(p.id), name: String(p.name || '').trim() };
    }).filter(function (p) { return p.id && p.name; }) : [];
    const groups = Array.isArray(data.groups) ? data.groups.map(function (g) {
      const listInProfile = g.list_in_profile;
      return {
        id: normId(g.id),
        name: String(g.name || '').trim(),
        insigniaId: normId(g.image_id || g.imageId || ''),
        title: String(g.title || '').trim(),
        listInProfile: listInProfile === undefined || listInProfile === null
          ? true
          : !!(listInProfile === true || listInProfile === 1 || listInProfile === 'true')
      };
    }).filter(function (g) { return g.id && g.name; }) : [];
    groups.forEach(function (g) { cacheGroupName(g.id, g.name, g.insigniaId); });
    const userName = String(data.username || data.user_name || data.legacy_name || '').trim();
    const displayRaw = String(data.display_name || data.displayName || '').trim();
    const isDefault = data.is_display_name_default === true ||
      data.is_display_name_default === 'true' ||
      data.is_display_name_default === 1;
    const displayName = (!isDefault && displayRaw) ? displayRaw : '';
    return {
      avatarId: avatarId,
      imageId: normId(data.sl_image_id || data.image_id || ''),
      flImageId: normId(data.fl_image_id || ''),
      partnerId: normId(data.partner_id || ''),
      displayName: displayName,
      userName: userName,
      legacyName: userName,
      name: displayName || userName,
      about: capAboutText(data),
      flAbout: capFlAboutText(data),
      bornOn: data.member_since || data.born_on || '',
      hideAge: !!data.hide_age,
      profileUrl: String(data.profile_url || '').trim(),
      notes: String(data.notes || '').trim(),
      customerType: String(data.customer_type || '').trim(),
      charterMember: data.charter_member,
      caption: String(data.caption || '').trim(),
      picks: picks,
      groups: groups,
      flags: {
        online: data.online,
        identified: data.identified === true || data.identified === 1 ||
          data.identified === 'true' || data.identified === '1',
        transacted: data.transacted === true || data.transacted === 1 ||
          data.transacted === 'true' || data.transacted === '1',
        allowPublish: data.allow_publish === true || data.allow_publish === 1 ||
          data.allow_publish === 'true' || data.allow_publish === '1'
      },
      source: 'cap'
    };
  }

  function hasAgentProfileCap() {
    return !!(hooks && hooks.getAgentProfileCap && hooks.getAgentProfileCap());
  }

  function startCapProfileFetch(agentId) {
    const id = normId(agentId);
    return hooks.ensureAgentProfileCap().then(function (capUrl) {
      if (!capUrl || !hooks.fetchAgentProfileCap) {
        if (hasAgentProfileCap()) {
          return Promise.reject(new Error('AgentProfile cap unavailable'));
        }
        return fallbackToUdpProfile(id);
      }
      return fetchCapProfileWithRetry(id, 0);
    }).catch(function (err) {
      if (hasAgentProfileCap()) throw err;
      return fallbackToUdpProfile(id).catch(function () {
        throw err || new Error('Profile fetch unavailable');
      });
    });
  }

  function getSelfAgentId() {
    if (!hooks || typeof hooks.getSelfAgentId !== 'function') return '';
    return normId(hooks.getSelfAgentId());
  }

  function selfProfileGroups() {
    const selfId = getSelfAgentId();
    if (!selfId) return [];
    const profile = avatarProfiles.get(selfId);
    return profile && Array.isArray(profile.groups) ? profile.groups : [];
  }

  function getAgentMembershipGroups() {
    const rows = [];
    agentGroups.forEach(function (g) {
      if (!g || !g.id) return;
      rows.push({
        id: normId(g.id),
        name: g.name || getGroupName(g.id) || '',
        insigniaId: g.insigniaId || '',
        title: g.title || ''
      });
    });
    return rows;
  }

  function mergeProfileGroupLists(prev, incoming) {
    const byId = new Map();
    (prev || []).forEach(function (g) {
      if (!g || !g.id) return;
      byId.set(normId(g.id), Object.assign({}, g, { id: normId(g.id) }));
    });
    (incoming || []).forEach(function (g) {
      if (!g || !g.id) return;
      const id = normId(g.id);
      const row = byId.get(id) || {};
      byId.set(id, Object.assign({}, row, g, { id: id }));
    });
    return Array.from(byId.values());
  }

  function mergeProfileGroupsIntoMembership(avatarId, groups) {
    const selfId = getSelfAgentId();
    if (!selfId || normId(avatarId) !== selfId || !Array.isArray(groups)) return;
    groups.forEach(function (g) {
      if (!g || !g.id) return;
      addAgentGroup(g.id, {
        name: g.name || '',
        insigniaId: g.insigniaId || '',
        title: g.title || '',
        listInProfile: g.listInProfile
      }, { silent: true });
    });
  }

  function buildSelfProfileGroupRow(gid, agentRow, capRow, active) {
    let title = String((capRow && capRow.title) || (agentRow && agentRow.title) || '').trim();
    if (!title && active && active.id === gid) title = String(active.title || '').trim();
    return {
      id: gid,
      name: String((capRow && capRow.name) || (agentRow && agentRow.name) ||
        getGroupName(gid) || 'Group').trim(),
      title: title,
      insigniaId: normId((capRow && capRow.insigniaId) || (agentRow && agentRow.insigniaId)),
      listInProfile: agentRow && agentRow.listInProfile !== undefined
        ? !!agentRow.listInProfile
        : (capRow && capRow.listInProfile !== undefined
          ? !!capRow.listInProfile
          : true)
    };
  }

  function getProfileGroupsForDisplay(avatarId, profile) {
    const id = normId(avatarId);
    const selfId = getSelfAgentId();
    const capRows = profile && Array.isArray(profile.groups) ? profile.groups : [];
    if (!selfId || id !== selfId) {
      return capRows.filter(function (g) {
        return g && g.id && g.listInProfile !== false;
      });
    }
    const byId = new Map();
    capRows.forEach(function (g) {
      if (!g || !g.id) return;
      byId.set(normId(g.id), Object.assign({}, g, { id: normId(g.id) }));
    });
    const active = getActiveGroupInfo();
    const ids = new Set();
    agentGroups.forEach(function (g) {
      if (g && g.id) ids.add(normId(g.id));
    });
    capRows.forEach(function (g) {
      if (g && g.id) ids.add(normId(g.id));
    });
    const merged = [];
    ids.forEach(function (gid) {
      merged.push(buildSelfProfileGroupRow(
        gid,
        agentGroups.get(gid),
        byId.get(gid),
        active
      ));
    });
    merged.sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name));
    });
    return merged;
  }

  function isAgentInGroup(groupId) {
    const id = normId(groupId);
    if (isZero(id)) return false;
    if (agentGroups.has(id)) return true;
    const groups = selfProfileGroups();
    let i;
    for (i = 0; i < groups.length; i++) {
      if (normId(groups[i].id) === id) return true;
    }
    return false;
  }

  function getActiveGroupId() {
    return normId(activeGroupId);
  }

  function getActiveGroupInfo() {
    if (!activeGroupId || isZero(activeGroupId)) return null;
    return {
      id: activeGroupId,
      name: getGroupName(activeGroupId) || '',
      title: activeGroupTitle || ''
    };
  }

  function isActiveGroup(groupId) {
    const id = normId(groupId);
    const active = normId(activeGroupId);
    return !!(id && active && id === active);
  }

  function setActiveGroup(groupId, info) {
    const opts = info || {};
    const nextId = isZero(normId(groupId)) ? '' : normId(groupId);
    const prevId = normId(activeGroupId);
    const idChanged = nextId !== prevId;
    let titleChanged = false;
    if (opts.title !== undefined) {
      const nextTitle = String(opts.title || '').trim();
      titleChanged = nextTitle !== activeGroupTitle;
      if (titleChanged) activeGroupTitle = nextTitle;
    } else if (idChanged) {
      activeGroupTitle = '';
    }
    const nameUpdate = !!(opts.name && opts.name !== getGroupName(nextId));
    const insigniaUpdate = !!(opts.insigniaId && !isZero(opts.insigniaId));
    if (!idChanged && !titleChanged && !nameUpdate && !insigniaUpdate) return;
    activeGroupId = nextId;
    if (nextId && opts.name) {
      cacheGroupName(nextId, opts.name, opts.insigniaId || '');
    } else if (nextId && insigniaUpdate) {
      cacheGroupName(nextId, getGroupName(nextId) || 'Group', opts.insigniaId);
    }
    if (idChanged || titleChanged) emitChange('active-group', nextId || ZERO_UUID);
  }

  function groupProfileFingerprint(row) {
    if (!row) return '';
    return [
      row.name || '',
      row.charter || '',
      row.memberTitle || '',
      row.insigniaId || '',
      row.founderId || '',
      row.memberCount,
      row.openEnrollment ? 1 : 0,
      row.maturePublish ? 1 : 0,
      row.membershipFee,
      row.money,
      row.rolesCount,
      row.powersMask
    ].join('|');
  }

  function hasGroupTitlesCache(groupId) {
    const row = groupTitles.get(normId(groupId));
    if (!row || !row.complete) return false;
    if (Date.now() - (row.fetchedAt || 0) > GROUP_TITLES_TTL_MS) return false;
    return !!(row.titles && row.titles.length);
  }

  function isGroupTitlesFetchSettled(groupId) {
    const row = groupTitles.get(normId(groupId));
    if (!row || !row.complete) return false;
    return Date.now() - (row.fetchedAt || 0) <= GROUP_TITLES_TTL_MS;
  }

  function getGroupTitles(groupId) {
    const row = groupTitles.get(normId(groupId));
    if (!row || !row.titles) return [];
    if (Date.now() - (row.fetchedAt || 0) > GROUP_TITLES_TTL_MS) return [];
    return row.titles;
  }

  function selectedGroupTitle(groupId) {
    const titles = getGroupTitles(groupId);
    let i;
    for (i = 0; i < titles.length; i++) {
      if (titles[i].selected) return titles[i];
    }
    return null;
  }

  function finishGroupTitlesFetch(id, pending, titles, complete) {
    if (pending && pending.timer) clearTimeout(pending.timer);
    if (pending) pendingGroupTitles.delete(id);
    const rows = storeGroupTitles(id, titles, complete);
    if (pending && pending.resolve) pending.resolve(rows);
    return rows;
  }

  function storeGroupTitles(groupId, titles, complete) {
    const id = normId(groupId);
    if (isZero(id) || !Array.isArray(titles)) return [];
    const rows = titles.map(function (row) {
      return {
        title: String(row.title || '').trim(),
        roleId: normId(row.roleId),
        selected: !!row.selected
      };
    }).filter(function (row) { return !!row.title; }); // keep the Everyone role (null UUID)
    const prevRow = groupTitles.get(id);
    const prevJson = prevRow ? JSON.stringify(prevRow.titles || []) : '';
    const nextJson = JSON.stringify(rows);
    groupTitles.set(id, {
      titles: rows,
      fetchedAt: Date.now(),
      complete: complete !== false
    });
    const selected = selectedGroupTitle(id);
    if (selected) {
      mergeGroupProfile(id, { memberTitle: selected.title }, { silent: true });
    }
    if (prevJson !== nextJson) emitChange('group-titles', id);
    return rows;
  }

  function handleGroupTitlesReply(data) {
    if (!data || isZero(data.groupId) || !Array.isArray(data.titles)) return null;
    const selfId = getSelfAgentId();
    if (selfId && data.agentId && normId(data.agentId) !== selfId) return null;
    const id = normId(data.groupId);
    const pending = pendingGroupTitles.get(id);
    if (pending && data.requestId && !isZero(data.requestId) &&
        normId(data.requestId) !== normId(pending.requestId)) {
      return null;
    }
    if (pending) {
      finishGroupTitlesFetch(id, pending, data.titles, true);
    } else {
      storeGroupTitles(id, data.titles, true);
    }
    return getGroupTitles(id);
  }

  function handleGroupRoleDataReply(data) {
    if (!data || isZero(data.groupId) || !Array.isArray(data.roles)) return null;
    return getGroupTitles(normId(data.groupId));
  }

  function fetchGroupTitles(groupId, options) {
    const id = normId(groupId);
    const opts = options || {};
    const isMember = opts.isMember === true || isAgentInGroup(id);
    if (isZero(id) || !isMember) {
      return Promise.resolve([]);
    }
    if (opts.force) {
      const stale = pendingGroupTitles.get(id);
      if (stale) {
        if (stale.timer) clearTimeout(stale.timer);
        pendingGroupTitles.delete(id);
      }
      groupTitles.delete(id);
    }
    if (!opts.force && hasGroupTitlesCache(id)) {
      return Promise.resolve(getGroupTitles(id));
    }
    if (!opts.force && isGroupTitlesFetchSettled(id)) {
      return Promise.resolve(getGroupTitles(id));
    }
    if (pendingGroupTitles.has(id)) return pendingGroupTitles.get(id).promise;
    if (!hooks || typeof hooks.requestGroupTitles !== 'function') {
      return Promise.resolve([]);
    }

    let resolveFn;
    const promise = new Promise(function (resolve) {
      resolveFn = resolve;
    });
    const requestId = FSUtils.uuid();
    const timer = setTimeout(function () {
      if (!pendingGroupTitles.has(id)) return;
      finishGroupTitlesFetch(id, pendingGroupTitles.get(id), getGroupTitles(id), true);
    }, 8000);
    pendingGroupTitles.set(id, {
      promise: promise,
      resolve: resolveFn,
      requestId: requestId,
      timer: timer
    });

    hooks.requestGroupTitles(id, requestId).then(function (result) {
      if (!pendingGroupTitles.has(id)) return;
      if (!result || !result.sent) {
        finishGroupTitlesFetch(id, pendingGroupTitles.get(id), [], true);
      }
    }).catch(function () {
      if (!pendingGroupTitles.has(id)) return;
      finishGroupTitlesFetch(id, pendingGroupTitles.get(id), [], true);
    });

    return promise;
  }

  function saveGroupTitle(groupId, roleId) {
    const id = normId(groupId);
    const role = normId(roleId);
    if (isZero(id) || !isAgentInGroup(id)) {
      return Promise.resolve({ sent: false, notMember: true });
    }
    if (!hooks || typeof hooks.updateGroupTitle !== 'function') {
      return Promise.resolve({ sent: false });
    }
    return hooks.updateGroupTitle(id, role).then(function (result) {
      if (!result || !result.sent) return result || { sent: false };
      const row = groupTitles.get(id);
      if (row && row.titles) {
        row.titles.forEach(function (title) {
          title.selected = normId(title.roleId) === role;
        });
        const selected = row.titles.find(function (title) { return title.selected; });
        mergeGroupProfile(id, { memberTitle: selected ? selected.title : '' }, { silent: true });
        emitChange('group-titles', id);
      }
      return result;
    });
  }

  function addAgentGroup(groupId, info, options) {
    const opts = options || {};
    const id = normId(groupId);
    if (!id || isZero(id)) return;
    const existing = agentGroups.get(id);
    const name = String((info && info.name) || (existing && existing.name) ||
      getGroupName(id) || '').trim();
    const insigniaId = normId((info && info.insigniaId) || (existing && existing.insigniaId));
    const title = String((info && info.title) || (existing && existing.title) || '').trim();
    let listInProfile = existing ? existing.listInProfile !== false : true;
    if (info && info.listInProfile !== undefined && info.listInProfile !== null) {
      listInProfile = !!info.listInProfile;
    }
    const changed = !existing || existing.name !== name || existing.insigniaId !== insigniaId ||
      existing.title !== title || existing.listInProfile !== listInProfile;
    agentGroups.set(id, {
      id: id,
      name: name,
      insigniaId: insigniaId,
      title: title,
      listInProfile: listInProfile
    });
    if (!opts.silent && changed) emitChange('group', id);
  }

  function removeAgentGroup(groupId) {
    const id = normId(groupId);
    if (!id || !agentGroups.has(id)) return;
    agentGroups.delete(id);
    groupTitles.delete(id);
    if (activeGroupId === id) {
      activeGroupId = '';
      emitChange('active-group', ZERO_UUID);
    }
    emitChange('group', id);
  }

  function scheduleAgentProfileCapFetch(agentId) {
    const id = normId(agentId);
    const task = capFetchChain.then(function () {
      const wait = Math.max(0, CAP_FETCH_GAP_MS - (Date.now() - lastCapFetchAt));
      if (!wait) return hooks.fetchAgentProfileCap(id);
      return new Promise(function (resolve) {
        setTimeout(resolve, wait);
      }).then(function () {
        return hooks.fetchAgentProfileCap(id);
      });
    }).then(function (profile) {
      lastCapFetchAt = Date.now();
      return profile;
    });
    capFetchChain = task.catch(function () {});
    return task;
  }

  function isCapRateLimitError(err) {
    const text = String((err && err.message) || err || '');
    return /50[39]/.test(text) || /rate exceeded/i.test(text);
  }

  function looksTruncatedAbout(text) {
    const s = String(text || '');
    if (s.length >= 500 && s.length <= 513) return true;
    try {
      const bytes = new TextEncoder().encode(s).length;
      if (bytes >= 500 && bytes <= 513) return true;
    } catch (_e) { /* ignore */ }
    return false;
  }

  function needsCapProfileFetch(profile) {
    if (!profile) return true;
    if (profile.source !== 'cap') return true;
    if (looksTruncatedAbout(profile.about)) return true;
    return false;
  }

  function isCapFetchActive(agentId) {
    return capFetchActive.has(normId(agentId));
  }

  function shouldDiscardUdpProfileBody(avatarId) {
    const id = normId(avatarId);
    if (capFetchActive.has(id)) return true;
    const pending = pendingAvatar.get(id);
    if (pending && pending.preferCap) return true;
    const prev = avatarProfiles.get(id);
    if (prev && prev.source === 'cap') return true;
    if (prev && String(prev.about || '').length > 513) return true;
    return false;
  }

  function handleAvatarPropertiesReply(data) {
    if (!data || isZero(data.avatarId)) return null;
    const avatarId = normId(data.avatarId);
    if (shouldDiscardUdpProfileBody(avatarId)) {
      if (data.imageId && !isZero(data.imageId)) {
        cacheImageId(avatarId, normId(data.imageId));
      }
      return getAvatarProfile(avatarId);
    }
    const patch = {
      avatarId: avatarId,
      imageId: normId(data.imageId),
      flImageId: normId(data.flImageId),
      partnerId: normId(data.partnerId),
      about: data.about || '',
      flAbout: data.flAbout || '',
      bornOn: data.bornOn || '',
      profileUrl: data.profileUrl || '',
      flags: decodeAvatarFlags(data.flags),
      source: 'udp'
    };
    const pending = pendingAvatar.get(avatarId);
    if (pending && pending.preferCap) {
      if (data.imageId && !isZero(data.imageId)) {
        cacheImageId(avatarId, normId(data.imageId));
      }
      return getAvatarProfile(avatarId);
    }
    if (pending) {
      pendingAvatar.delete(avatarId);
      pending.resolve(mergeAvatarProfile(avatarId, patch));
    }
    return mergeAvatarProfile(avatarId, patch);
  }

  function handleGroupProfileReply(data) {
    if (!data || isZero(data.groupId)) return null;
    const groupId = normId(data.groupId);
    const member = isAgentInGroup(groupId);
    const patch = {
      groupId: groupId,
      name: data.name || '',
      charter: data.charter || '',
      insigniaId: normId(data.insigniaId),
      founderId: normId(data.founderId),
      memberCount: data.memberCount,
      openEnrollment: !!data.openEnrollment,
      maturePublish: !!data.maturePublish,
      membershipFee: data.membershipFee,
      money: data.money,
      memberTitle: member ? (data.memberTitle || '') : '',
      powersMask: member ? data.powersMask : 0,
      showInList: data.showInList,
      allowPublish: data.allowPublish,
      rolesCount: data.rolesCount,
      source: 'udp'
    };
    const pending = pendingGroup.get(patch.groupId);
    if (pending) {
      pendingGroup.delete(patch.groupId);
      pending.resolve(mergeGroupProfile(patch.groupId, patch));
    }
    return mergeGroupProfile(patch.groupId, patch);
  }

  function mapHttpAgentGroupDataUpdate(input) {
    let body = input || {};
    if (body.body && typeof body.body === 'object') body = body.body;
    if (body.body && typeof body.body === 'object') body = body.body;
    const agentRows = body.AgentData || body.agent_data || [];
    const agentRow = Array.isArray(agentRows) ? agentRows[0] : agentRows;
    const agentId = normId((agentRow && (agentRow.AgentID || agentRow.agent_id)) || '');
    const groupRows = body.GroupData || body.group_data || [];
    const newRows = body.NewGroupData || body.new_group_data || [];
    const groups = (Array.isArray(groupRows) ? groupRows : []).map(function (g, i) {
      const listRow = Array.isArray(newRows) ? (newRows[i] || {}) : {};
      const listInProfile = listRow.ListInProfile !== undefined
        ? !!listRow.ListInProfile
        : (listRow.list_in_profile !== undefined ? !!listRow.list_in_profile : true);
      return {
        id: normId(g.GroupID || g.group_id),
        name: String(g.GroupName || g.group_name || '').trim(),
        insigniaId: normId(g.GroupInsigniaID || g.group_insignia_id),
        acceptNotices: g.AcceptNotices !== false && g.accept_notices !== false,
        contribution: g.Contribution || g.contribution || 0,
        listInProfile: listInProfile
      };
    }).filter(function (g) { return g.id && !isZero(g.id) && g.name; });
    return { agentId: agentId, groups: groups };
  }

  function applyAgentGroupRows(groups) {
    if (!Array.isArray(groups)) return false;
    let changed = false;
    groups.forEach(function (g) {
      if (!g || !g.id) return;
      const id = normId(g.id);
      const existing = agentGroups.get(id);
      addAgentGroup(id, {
        name: g.name || (existing && existing.name) || '',
        insigniaId: g.insigniaId || (existing && existing.insigniaId) || '',
        title: g.title || (existing && existing.title) || '',
        listInProfile: g.listInProfile
      }, { silent: true });
      if (g.name) cacheGroupName(id, g.name, g.insigniaId);
      changed = true;
    });
    return changed;
  }

  function handleAgentGroupDataUpdate(data) {
    if (!data || !Array.isArray(data.groups)) return;
    const selfId = getSelfAgentId();
    if (selfId && data.agentId && normId(data.agentId) !== selfId) return;
    if (!applyAgentGroupRows(data.groups)) return;
    emitChange('membership', selfId || ZERO_UUID);
    if (selfId) emitChange('avatar', selfId);
  }

  function handleHttpAgentGroupDataUpdate(body, contentType) {
    if (!body || typeof FSLLSD === 'undefined' || typeof FSLLSD.parse !== 'function') return null;
    try {
      const parsed = FSLLSD.parse(body, contentType);
      handleAgentGroupDataUpdate(mapHttpAgentGroupDataUpdate(parsed));
      return getAgentMembershipGroups();
    } catch (_e) {
      return null;
    }
  }

  function handleAvatarGroupsReply(data) {
    if (!data || isZero(data.avatarId) || !Array.isArray(data.groups)) return null;
    const groups = data.groups.map(function (g) {
      return {
        id: normId(g.id),
        name: g.name || '',
        title: g.title || '',
        insigniaId: normId(g.insigniaId),
        listInProfile: g.listInProfile !== false
      };
    }).filter(function (g) { return g.id && g.name; });
    groups.forEach(function (g) { cacheGroupName(g.id, g.name, g.insigniaId); });
    const prev = getAvatarProfile(data.avatarId);
    const mergedGroups = mergeProfileGroupLists(prev && prev.groups, groups);
    if (normId(data.avatarId) === getSelfAgentId()) {
      mergeProfileGroupsIntoMembership(data.avatarId, mergedGroups);
    }
    return mergeAvatarProfile(data.avatarId, { groups: mergedGroups, source: 'udp-groups' });
  }

  function handleAvatarPicksReply(data) {
    if (!data || isZero(data.avatarId) || !Array.isArray(data.picks)) return null;
    const picks = data.picks.map(function (p) {
      return { id: normId(p.id), name: p.name || '' };
    }).filter(function (p) { return p.id && p.name; });
    return mergeAvatarProfile(data.avatarId, { picks: picks, source: 'udp-picks' });
  }

  function handleAvatarNotesReply(data) {
    if (!data || isZero(data.targetId)) return null;
    return mergeAvatarProfile(data.targetId, { notes: data.notes || '', source: 'udp-notes' });
  }

  function handleAvatarClassifiedReply(data) {
    if (!data || isZero(data.avatarId) || !Array.isArray(data.classifieds)) return null;
    const classifieds = data.classifieds.map(function (c) {
      return { id: normId(c.id), name: c.name || '' };
    }).filter(function (c) { return c.id && c.name; });
    return mergeAvatarProfile(data.avatarId, { classifieds: classifieds, source: 'udp-classifieds' });
  }

  function formatDetailLocationText(detail) {
    if (!detail) return '';
    const parts = [];
    const parcel = String(detail.originalName || detail.parcelName || '').trim();
    const region = String(detail.regionName || detail.simName || '').trim();
    if (parcel) parts.push(parcel);
    if (region && region.toLowerCase() !== parcel.toLowerCase()) parts.push(region);
    let text = parts.join(', ');
    if (detail.x !== undefined && detail.y !== undefined && detail.z !== undefined) {
      text += (text ? ' ' : '') + '(' + detail.x + ', ' + detail.y + ', ' + detail.z + ')';
    }
    return text;
  }

  function detailRegionName(detail) {
    return String((detail && (detail.regionName || detail.simName)) || '').trim();
  }

  function hasValidDetailRegion(detail) {
    const parcel = String(detail.originalName || detail.parcelName || '').trim();
    const region = detailRegionName(detail);
    return !!(region && (!parcel || region.toLowerCase() !== parcel.toLowerCase()));
  }

  function detailLocationNeedsResolve(detail) {
    if (!detail || !detail.posGlobal) return false;
    return !hasValidDetailRegion(detail);
  }

  function applyParcelPlaceInfo(detail, info) {
    if (!detail || !info) return detail;
    const name = String(info.name || '').trim();
    const sim = String(info.simName || '').trim();
    if (name) {
      detail.originalName = name;
      detail.parcelName = name;
    }
    if (sim) {
      detail.simName = sim;
      detail.regionName = sim;
    }
    detail.location = formatDetailLocationText(detail);
    return detail;
  }

  function fetchParcelPlaceInfo(detail) {
    const parcelId = normId(detail && detail.parcelId);
    if (isZero(parcelId) || hasValidDetailRegion(detail)) {
      return Promise.resolve(detail);
    }
    if (!hooks || typeof hooks.fetchParcelInfo !== 'function') {
      return Promise.resolve(detail);
    }
    return hooks.fetchParcelInfo(parcelId).then(function (info) {
      return applyParcelPlaceInfo(detail, info);
    }).catch(function () {
      return detail;
    });
  }

  function resolveDetailGridLocation(detail, grid, localX, localY, localZ) {
    if (hasValidDetailRegion(detail)) {
      detail.location = formatDetailLocationText(detail);
      return Promise.resolve(detail);
    }
    detail.regionName = '';
    detail.location = formatDetailLocationText(detail);
    if (!hooks || typeof hooks.resolveLocation !== 'function') {
      return Promise.resolve(detail);
    }
    return hooks.resolveLocation({
      globalX: grid.globalX,
      globalY: grid.globalY,
      gridX: grid.gridX,
      gridY: grid.gridY,
      x: localX,
      y: localY,
      z: localZ,
      isGlobalCoord: true
    }).then(function (loc) {
      if (loc && loc.regionName) {
        detail.regionName = loc.regionName;
        detail.simName = loc.regionName;
        if (loc.x !== undefined) detail.x = loc.x;
        if (loc.y !== undefined) detail.y = loc.y;
        if (loc.z !== undefined) detail.z = loc.z;
      }
      detail.location = formatDetailLocationText(detail);
      return detail;
    }).catch(function () {
      detail.location = formatDetailLocationText(detail);
      return detail;
    });
  }

  function enrichDetailLocation(detail) {
    if (!detail || !detail.posGlobal) return Promise.resolve(detail);
    const pos = detail.posGlobal;
    const rw = 256;
    const localX = Math.round(((pos.x % rw) + rw) % rw);
    const localY = Math.round(((pos.y % rw) + rw) % rw);
    const localZ = Math.round(pos.z);
    const grid = typeof FSSlurl !== 'undefined' && FSSlurl.globalToGrid
      ? FSSlurl.globalToGrid(pos.x, pos.y)
      : {
        gridX: Math.floor(Number(pos.x) / rw),
        gridY: Math.floor(Number(pos.y) / rw),
        globalX: Math.floor(Number(pos.x) / rw) * rw,
        globalY: Math.floor(Number(pos.y) / rw) * rw
      };
    detail.x = localX;
    detail.y = localY;
    detail.z = localZ;
    detail.gridX = grid.gridX;
    detail.gridY = grid.gridY;
    detail.globalX = grid.globalX;
    detail.globalY = grid.globalY;
    if (detailRegionName(detail) && !detail.regionName) {
      detail.regionName = detailRegionName(detail);
    }
    detail.location = formatDetailLocationText(detail);
    return fetchParcelPlaceInfo(detail).then(function (enriched) {
      return resolveDetailGridLocation(enriched, grid, localX, localY, localZ);
    });
  }

  function finishDetailStore(map, pendingMap, idKey, changeKind, data) {
    const id = normId(data[idKey]);
    if (isZero(id)) return Promise.resolve(null);
    const detail = Object.assign({}, data, {});
    detail[idKey] = id;
    map.set(id, detail);
    const pending = pendingMap.get(id);
    // Resolve immediately with the base detail so the pane paints without
    // waiting on location enrichment (parcel/region lookups can be slow or
    // never reply). Enrich in the background and emit an update to repaint.
    if (pending) {
      pendingMap.delete(id);
      pending.resolve(detail);
    }
    emitChange(changeKind, id);
    return enrichDetailLocation(detail).then(function (enriched) {
      map.set(id, enriched);
      emitChange(changeKind, id);
      return enriched;
    }).catch(function () {
      return detail;
    });
  }

  function storePickDetail(data) {
    if (!data || isZero(data.pickId)) return null;
    finishDetailStore(pickDetails, pendingPick, 'pickId', 'pick-detail', data);
    return pickDetails.get(normId(data.pickId)) || null;
  }

  function storeClassifiedDetail(data) {
    if (!data || isZero(data.classifiedId)) return null;
    finishDetailStore(classifiedDetails, pendingClassified, 'classifiedId', 'classified-detail', data);
    return classifiedDetails.get(normId(data.classifiedId)) || null;
  }

  function handlePickInfoReply(data) {
    return storePickDetail(data);
  }

  function handleClassifiedInfoReply(data) {
    return storeClassifiedDetail(data);
  }

  function getPickDetail(pickId) {
    return pickDetails.get(normId(pickId)) || null;
  }

  function getClassifiedDetail(classifiedId) {
    return classifiedDetails.get(normId(classifiedId)) || null;
  }

  function fetchPickInfo(creatorId, pickId) {
    const ownerId = normId(creatorId);
    const id = normId(pickId);
    if (isZero(id)) return Promise.reject(new Error('Invalid pick id'));
    const cached = getPickDetail(id);
    if (cached && !detailLocationNeedsResolve(cached)) return Promise.resolve(cached);
    if (cached) {
      return enrichDetailLocation(Object.assign({}, cached)).then(function (enriched) {
        pickDetails.set(id, enriched);
        return enriched;
      });
    }
    if (pendingPick.has(id)) return pendingPick.get(id).promise;

    let resolveFn;
    let rejectFn;
    const promise = new Promise(function (resolve, reject) {
      resolveFn = resolve;
      rejectFn = reject;
    });
    pendingPick.set(id, { promise: promise, resolve: resolveFn, reject: rejectFn });
    const timer = setTimeout(function () {
      if (!pendingPick.has(id)) return;
      pendingPick.delete(id);
      rejectFn(new Error('Pick info timed out'));
    }, 12000);

    const send = hooks && hooks.requestPickInfo
      ? hooks.requestPickInfo(ownerId, id)
      : Promise.reject(new Error('Pick info unavailable'));

    send.catch(function (err) {
      clearTimeout(timer);
      pendingPick.delete(id);
      rejectFn(err);
    });

    return promise.finally(function () {
      clearTimeout(timer);
    });
  }

  function fetchClassifiedInfo(classifiedId) {
    const id = normId(classifiedId);
    if (isZero(id)) return Promise.reject(new Error('Invalid classified id'));
    const cached = getClassifiedDetail(id);
    if (cached && !detailLocationNeedsResolve(cached)) return Promise.resolve(cached);
    if (cached) {
      return enrichDetailLocation(Object.assign({}, cached)).then(function (enriched) {
        classifiedDetails.set(id, enriched);
        return enriched;
      });
    }
    if (pendingClassified.has(id)) return pendingClassified.get(id).promise;

    let resolveFn;
    let rejectFn;
    const promise = new Promise(function (resolve, reject) {
      resolveFn = resolve;
      rejectFn = reject;
    });
    pendingClassified.set(id, { promise: promise, resolve: resolveFn, reject: rejectFn });
    const timer = setTimeout(function () {
      if (!pendingClassified.has(id)) return;
      pendingClassified.delete(id);
      rejectFn(new Error('Classified info timed out'));
    }, 12000);

    const send = hooks && hooks.requestClassifiedInfo
      ? hooks.requestClassifiedInfo(id)
      : Promise.reject(new Error('Classified info unavailable'));

    send.catch(function (err) {
      clearTimeout(timer);
      pendingClassified.delete(id);
      rejectFn(err);
    });

    return promise.finally(function () {
      clearTimeout(timer);
    });
  }

  function queueGroupName(groupId) {
    if (!hooks || isZero(groupId)) return;
    if (getGroupName(groupId)) return;
    fetchGroupProfile(groupId, { quiet: true }).catch(function () {});
  }

  function isBuddyAvatar(agentId) {
    if (!hooks || typeof hooks.isBuddy !== 'function') return false;
    return !!hooks.isBuddy(agentId);
  }

  function queueAvatarThumb(agentId) {
    const id = normId(agentId);
    if (isZero(id) || getImageId(id) || !isBuddyAvatar(id)) return;
    pendingThumb.add(id);
    if (thumbInFlight) return;
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = setTimeout(flushThumbQueue, THUMB_FLUSH_MS);
  }

  function flushThumbQueue() {
    thumbTimer = null;
    if (!hooks || thumbInFlight || !pendingThumb.size) return;
    const batch = Array.from(pendingThumb).slice(0, THUMB_BATCH_SIZE);
    batch.forEach(function (id) { pendingThumb.delete(id); });
    thumbInFlight = true;
    Promise.resolve().then(function () {
      const tasks = batch.map(function (id) {
        if (getImageId(id) || !isBuddyAvatar(id)) return Promise.resolve();
        if (hooks.requestAvatarProperties) {
          return hooks.requestAvatarProperties(id);
        }
        return Promise.resolve();
      });
      return Promise.all(tasks);
    }).finally(function () {
      thumbInFlight = false;
      if (pendingThumb.size) {
        thumbTimer = setTimeout(flushThumbQueue, THUMB_FLUSH_MS);
      }
    });
  }

  function requestLegacyAvatarExtras(avatarId, profile) {
    if (!hooks || !hooks.sendAvatarGenericRequest) return;
    const id = normId(avatarId);
    const row = profile || getAvatarProfile(id) || {};
    const capProfile = hasAgentProfileCap() && row.source === 'cap';
    let flags = extrasRequested.get(id) || {};

    if (id === getSelfAgentId()) {
      if (!flags.groups) {
        flags.groups = true;
        hooks.sendAvatarGenericRequest('avatargroupsrequest', avatarId);
      }
    } else if ((!capProfile || !row.groups || !row.groups.length) && !flags.groups) {
      flags.groups = true;
      hooks.sendAvatarGenericRequest('avatargroupsrequest', avatarId);
    }
    if ((!capProfile || !row.picks || !row.picks.length) && !flags.picks) {
      flags.picks = true;
      hooks.sendAvatarGenericRequest('avatarpicksrequest', avatarId);
    }
    if (!flags.classifieds) {
      flags.classifieds = true;
      hooks.sendAvatarGenericRequest('avatarclassifiedsrequest', avatarId);
    }
    if ((!capProfile || !row.notes) && !flags.notes) {
      flags.notes = true;
      hooks.sendAvatarGenericRequest('avatarnotesrequest', avatarId);
    }
    extrasRequested.set(id, flags);
  }

  function fetchCapProfileWithRetry(agentId, attempt) {
    const id = normId(agentId);
    return scheduleAgentProfileCapFetch(id).then(function (profile) {
      if (!profile) throw new Error('Empty profile');
      const merged = mergeAvatarProfile(id, profile);
      if (merged && merged.source === 'cap' && looksTruncatedAbout(merged.about)) {
        throw new Error('AgentProfile cap returned truncated about (503?)');
      }
      return merged;
    }).catch(function (err) {
      if (!isCapRateLimitError(err)) throw err;
      if (attempt >= CAP_RATE_MAX_RETRIES) throw err;
      emitFetching(id);
      return new Promise(function (resolve) {
        setTimeout(resolve, CAP_RATE_RETRY_MS);
      }).then(function () {
        return fetchCapProfileWithRetry(id, attempt + 1);
      });
    });
  }

  function fallbackToUdpProfile(agentId) {
    const id = normId(agentId);
    if (!hooks || !hooks.requestAvatarProperties) {
      return Promise.reject(new Error('Avatar profile unavailable'));
    }
    const pending = pendingAvatar.get(id);
    if (pending) pending.preferCap = false;
    capFetchActive.delete(id);
    return hooks.requestAvatarProperties(id).then(function () {
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          reject(new Error('Avatar profile timed out'));
        }, 12000);
        const unsub = onChange(function (evt) {
          if (evt.kind === 'avatar' && evt.id === id) {
            clearTimeout(timer);
            unsub();
            const row = getAvatarProfile(id);
            if (row) resolve(row);
            else reject(new Error('Avatar profile incomplete'));
          }
        });
        requestLegacyAvatarExtras(id);
      });
    });
  }

  function fetchAvatarProfile(agentId, options) {
    const id = normId(agentId);
    const opts = options || {};
    if (isZero(id)) return Promise.reject(new Error('Invalid avatar id'));
    if (!opts.force) {
      const cached = getAvatarProfile(id);
      if (cached && !needsCapProfileFetch(cached)) {
        return Promise.resolve(cached);
      }
    }
    if (pendingAvatar.has(id)) return pendingAvatar.get(id).promise;

    let resolveFn;
    let rejectFn;
    const promise = new Promise(function (resolve, reject) {
      resolveFn = resolve;
      rejectFn = reject;
    });
    pendingAvatar.set(id, {
      promise: promise,
      resolve: resolveFn,
      reject: rejectFn,
      preferCap: true
    });
    capFetchActive.add(id);

    emitFetching(id);

    const capTask = hooks && hooks.ensureAgentProfileCap
      ? startCapProfileFetch(id)
      : fallbackToUdpProfile(id);

    capTask.then(function (profile) {
      requestLegacyAvatarExtras(id, profile);
      pendingAvatar.delete(id);
      capFetchActive.delete(id);
      resolveFn(profile);
      return profile;
    }).catch(function (err) {
      pendingAvatar.delete(id);
      capFetchActive.delete(id);
      rejectFn(err);
      if (!opts.quiet) throw err;
    });

    return promise;
  }

  function fetchGroupProfile(groupId, options) {
    const id = normId(groupId);
    const opts = options || {};
    if (isZero(id)) return Promise.reject(new Error('Invalid group id'));
    if (!opts.force) {
      const cached = getGroupProfile(id);
      if (cached) return Promise.resolve(cached);
    }
    if (pendingGroup.has(id)) return pendingGroup.get(id).promise;

    let resolveFn;
    let rejectFn;
    const promise = new Promise(function (resolve, reject) {
      resolveFn = resolve;
      rejectFn = reject;
    });
    pendingGroup.set(id, { promise: promise, resolve: resolveFn, reject: rejectFn });

    const send = hooks && hooks.requestGroupProfile
      ? hooks.requestGroupProfile(id)
      : Promise.reject(new Error('Circuit unavailable'));

    send.then(function () {
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          reject(new Error('Group profile timed out'));
        }, 12000);
        const unsub = onChange(function (evt) {
          if (evt.kind === 'group' && evt.id === id) {
            clearTimeout(timer);
            unsub();
            const row = getGroupProfile(id);
            if (row) resolve(row);
            else reject(new Error('Group profile incomplete'));
          }
        });
      });
    }).then(function (profile) {
      pendingGroup.delete(id);
      resolveFn(profile);
      return profile;
    }).catch(function (err) {
      pendingGroup.delete(id);
      rejectFn(err);
      if (!opts.quiet) throw err;
    });

    return promise;
  }

  function invalidateAvatar(agentId) {
    avatarProfiles.delete(normId(agentId));
    imageIds.delete(normId(agentId));
    persistStorage();
    emitChange('image', agentId);
    emitChange('avatar', agentId);
  }

  return {
    init: init,
    clear: clear,
    onChange: onChange,
    normId: normId,
    isZero: isZero,
    textureImageUrl: textureImageUrl,
    cacheImageId: cacheImageId,
    getImageId: getImageId,
    cacheGroupName: cacheGroupName,
    getGroupName: getGroupName,
    getGroupInsigniaId: getGroupInsigniaId,
    getAgentMembershipGroups: getAgentMembershipGroups,
    getProfileGroupsForDisplay: getProfileGroupsForDisplay,
    isAgentInGroup: isAgentInGroup,
    getActiveGroupId: getActiveGroupId,
    getActiveGroupInfo: getActiveGroupInfo,
    isActiveGroup: isActiveGroup,
    setActiveGroup: setActiveGroup,
    hasGroupTitlesCache: hasGroupTitlesCache,
    isGroupTitlesFetchSettled: isGroupTitlesFetchSettled,
    getGroupTitles: getGroupTitles,
    fetchGroupTitles: fetchGroupTitles,
    saveGroupTitle: saveGroupTitle,
    handleGroupTitlesReply: handleGroupTitlesReply,
    handleGroupRoleDataReply: handleGroupRoleDataReply,
    addAgentGroup: addAgentGroup,
    removeAgentGroup: removeAgentGroup,
    needsCapProfileFetch: needsCapProfileFetch,
    hasAgentProfileCap: hasAgentProfileCap,
    isCapFetchActive: isCapFetchActive,
    isCapRateLimitError: isCapRateLimitError,
    queueGroupName: queueGroupName,
    queueAvatarThumb: queueAvatarThumb,
    getAvatarProfile: getAvatarProfile,
    getGroupProfile: getGroupProfile,
    fetchAvatarProfile: fetchAvatarProfile,
    fetchGroupProfile: fetchGroupProfile,
    mapAgentProfileCap: mapAgentProfileCap,
    mergeAvatarProfile: mergeAvatarProfile,
    mergeGroupProfile: mergeGroupProfile,
    handleAvatarPropertiesReply: handleAvatarPropertiesReply,
    handleGroupProfileReply: handleGroupProfileReply,
    handleAgentGroupDataUpdate: handleAgentGroupDataUpdate,
    handleHttpAgentGroupDataUpdate: handleHttpAgentGroupDataUpdate,
    handleAvatarGroupsReply: handleAvatarGroupsReply,
    handleAvatarPicksReply: handleAvatarPicksReply,
    handleAvatarNotesReply: handleAvatarNotesReply,
    handleAvatarClassifiedReply: handleAvatarClassifiedReply,
    handlePickInfoReply: handlePickInfoReply,
    handleClassifiedInfoReply: handleClassifiedInfoReply,
    getPickDetail: getPickDetail,
    getClassifiedDetail: getClassifiedDetail,
    fetchPickInfo: fetchPickInfo,
    fetchClassifiedInfo: fetchClassifiedInfo,
    formatBornLabel: formatBornLabel,
    invalidateAvatar: invalidateAvatar,
    ensureAvatarExtras: requestLegacyAvatarExtras
  };
})();
