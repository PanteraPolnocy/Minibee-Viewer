/**
 * Profile / group cache (a mirror of UI state).
 *
 * All the parsing happens in Rust; this module just caches the structured
 * profile/group/name data the native engine emits (avatar-profile, group-*,
 * names-updated, ...) and hands it to the UI synchronously. Fetches are thin
 * `invoke` calls, and the cache fills in once the matching event arrives.
 */
const BeeProfiles = (function () {
  'use strict';

  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

  const profiles = new Map();       // id -> avatar profile
  const groupProfiles = new Map();  // id -> group profile
  const groupNames = new Map();     // id -> { name, insigniaId }
  const groupTitlesMap = new Map(); // id -> { titles, complete }
  const membership = new Map();      // self group id -> { id, name, insigniaId }
  const pickDetails = new Map();     // pick id -> detail
  const classifiedDetails = new Map(); // classified id -> detail
  const listeners = new Set<(change: { kind: string; id: string }) => void>();
  const waiters = new Map();         // key -> [resolve...]
  const pendingThumbs = new Set();   // avatar ids with an in-flight properties request
  const pendingGroups = new Set();   // group ids with an in-flight profile request
  let active = { id: '', name: '', title: '' };
  let attached = false;

  function normId(id) { return BeeUtils.normUuid(id); }
  function isZero(id) { const k = normId(id); return !k || k === ZERO_UUID; }

  function textureImageUrl(uuid, size) {
    const id = normId(uuid);
    return isZero(id) ? '' : 'https://secondlife.com/app/image/' + id + '/' + (size || 256);
  }

  function resolveWebProfileUrl(profile) {
    if (!profile) return '';
    const direct = String(profile.profileUrl || '').trim();
    if (direct) return direct;
    const user = String(profile.userName || profile.legacyName || '').trim();
    if (!user || /\s/.test(user)) return '';
    return 'https://my.secondlife.com/' + encodeURIComponent(user.toLowerCase());
  }

  function formatAvatarInterests(interests) {
    const i = interests || {};
    const wantTo = Array.isArray(i.wantTo) ? i.wantTo : [];
    const skills = Array.isArray(i.skills) ? i.skills : [];
    const wantToText = String(i.wantToText || '').trim();
    const skillsText = String(i.skillsText || '').trim();
    const languagesText = String(i.languagesText || '').trim();
    return {
      hasContent: !!(wantTo.length || skills.length || wantToText || skillsText || languagesText),
      wantTo: wantTo, skills: skills,
      wantToText: wantToText, skillsText: skillsText, languagesText: languagesText
    };
  }

  function formatBornLabel(bornOn, hideAge) {
    if (!bornOn || hideAge) return hideAge ? 'Age hidden' : '';
    const date = new Date(bornOn);
    if (Number.isNaN(date.getTime())) return String(bornOn);
    const ageDays = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
    let ageLabel;
    if (ageDays < 30) ageLabel = ageDays + ' days';
    else if (ageDays < 365) ageLabel = Math.floor(ageDays / 30) + ' months';
    else { const y = Math.floor(ageDays / 365); ageLabel = y + ' year' + (y === 1 ? '' : 's'); }
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
      (ageLabel ? ' (' + ageLabel + ')' : '');
  }

  function emitChange(kind, id) {
    const payload = { kind: kind, id: normId(id) };
    listeners.forEach(function (fn) { try { fn(payload); } catch (_e) { /* a broken listener shouldn't take the rest down */ } });
  }
  function onChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return function () { listeners.delete(fn); };
  }

  function resolveWaiters(key, value) {
    const list = waiters.get(key);
    if (!list) return;
    waiters.delete(key);
    list.forEach(function (r) { r(value); });
  }
  function waitFor(key, timeoutMs, fallback) {
    return new Promise(function (resolve) {
      if (!waiters.has(key)) waiters.set(key, []);
      waiters.get(key).push(resolve);
      setTimeout(function () {
        const list = waiters.get(key);
        if (list && list.indexOf(resolve) >= 0) {
          list.splice(list.indexOf(resolve), 1);
          resolve(typeof fallback === 'function' ? fallback() : fallback);
        }
      }, timeoutMs || 12000);
    });
  }

  // --- ingesting events (the structured data coming from Rust) ---

  function attach() {
    if (attached || typeof BeeBridge === 'undefined' || !BeeBridge.listen) return;
    attached = true;

    BeeBridge.listen('minibee-viewer://avatar-profile', function (p) {
      if (!p || isZero(p.avatarId)) return;
      const id = normId(p.avatarId);
      pendingThumbs.delete(id);
      const cur = profiles.get(id) || {};
      // The AgentProfile cap carries the FULL about text plus account status,
      // while the UDP reply's about is truncated (~512 chars). Both fire when a
      // profile opens, in either order, so never let a UDP reply clobber cap
      // fields - when cap data is already present, keep it over an incoming udp one.
      const merged = (p.source === 'udp' && cur.source === 'cap')
        ? Object.assign({}, p, cur)
        : Object.assign({}, cur, p);
      profiles.set(id, merged);
      emitChange('avatar', id);
      resolveWaiters('profile:' + id, profiles.get(id));
    });
    BeeBridge.listen('minibee-viewer://avatar-interests', function (p) {
      if (!p || isZero(p.avatarId)) return;
      const id = normId(p.avatarId);
      const cur = profiles.get(id) || { avatarId: id };
      cur.interests = p;
      profiles.set(id, cur);
      emitChange('avatar', id);
    });
    BeeBridge.listen('minibee-viewer://avatar-groups', function (p) {
      if (!p || isZero(p.avatarId)) return;
      const id = normId(p.avatarId);
      const cur = profiles.get(id) || { avatarId: id };
      // Two sources describe someone's groups: the UDP AvatarGroupsReply (only
      // the ones they show in their profile) and the AgentProfile cap (the fuller
      // list). They arrive in either order, so keep the union rather than letting
      // whichever lands last win - that's how groups kept going missing.
      const byId = new Map();
      (Array.isArray(cur.groups) ? cur.groups : []).forEach(function (g) {
        if (g && g.id) byId.set(normId(g.id), g);
      });
      (p.groups || []).forEach(function (g) {
        if (!g || !g.id) return;
        const key = normId(g.id);
        byId.set(key, Object.assign({}, byId.get(key), g));
      });
      cur.groups = Array.from(byId.values());
      profiles.set(id, cur);
      (p.groups || []).forEach(function (g) { if (g.id && g.name) groupNames.set(normId(g.id), { name: g.name, insigniaId: g.insigniaId || '' }); });
      emitChange('avatar', id);
    });
    BeeBridge.listen('minibee-viewer://avatar-notes', function (p) {
      if (!p || isZero(p.targetId)) return;
      const id = normId(p.targetId);
      const cur = profiles.get(id) || { avatarId: id };
      cur.notes = p.notes || '';
      profiles.set(id, cur);
      emitChange('avatar', id);
    });
    BeeBridge.listen('minibee-viewer://avatar-picks', function (p) {
      if (!p || isZero(p.avatarId)) return;
      const id = normId(p.avatarId);
      const cur = profiles.get(id) || { avatarId: id };
      cur.picks = p.picks || [];
      profiles.set(id, cur);
      emitChange('avatar', id);
    });
    BeeBridge.listen('minibee-viewer://avatar-classifieds', function (p) {
      if (!p || isZero(p.avatarId)) return;
      const id = normId(p.avatarId);
      const cur = profiles.get(id) || { avatarId: id };
      cur.classifieds = p.classifieds || [];
      profiles.set(id, cur);
      emitChange('avatar', id);
    });
    BeeBridge.listen('minibee-viewer://pick-info', function (p) {
      if (!p || isZero(p.pickId)) return;
      pickDetails.set(normId(p.pickId), p);
      emitChange('pick-detail', p.pickId);
      resolveWaiters('pick:' + normId(p.pickId), p);
    });
    BeeBridge.listen('minibee-viewer://classified-info', function (p) {
      if (!p || isZero(p.classifiedId)) return;
      classifiedDetails.set(normId(p.classifiedId), p);
      emitChange('classified-detail', p.classifiedId);
      resolveWaiters('classified:' + normId(p.classifiedId), p);
    });
    BeeBridge.listen('minibee-viewer://group-profile', function (p) {
      if (!p || isZero(p.groupId)) return;
      const id = normId(p.groupId);
      pendingGroups.delete(id);
      groupProfiles.set(id, p);
      if (p.name) groupNames.set(id, { name: p.name, insigniaId: p.insigniaId || '' });
      emitChange('group', id);
      resolveWaiters('group:' + id, p);
    });
    BeeBridge.listen('minibee-viewer://group-titles', function (p) {
      if (!p || isZero(p.groupId)) return;
      const id = normId(p.groupId);
      groupTitlesMap.set(id, { titles: p.titles || [], complete: true });
      emitChange('group-titles', id);
      resolveWaiters('titles:' + id, groupTitlesMap.get(id));
    });
    BeeBridge.listen('minibee-viewer://group-membership', function (p) {
      membership.clear();
      (p && p.groups || []).forEach(function (g) {
        if (g.id) { membership.set(normId(g.id), g); if (g.name) groupNames.set(normId(g.id), { name: g.name, insigniaId: g.insigniaId || '' }); }
      });
      emitChange('membership', '');
    });
    BeeBridge.listen('minibee-viewer://active-group', function (p) {
      active = { id: normId((p && p.id) || ''), name: (p && p.name) || '', title: (p && p.title) || '' };
      if (p && p.id && p.name) groupNames.set(normId(p.id), { name: p.name, insigniaId: '' });
      emitChange('active-group', active.id);
    });
    BeeBridge.listen('minibee-viewer://names-updated', function (data) {
      // Group names can show up here too; avatar names live in the transport mirror.
      (data && data.names || []).forEach(function (n) { /* the transport mirror handles names */ });
    });
  }

  function init() { attach(); }

  // --- getters ---

  function getAvatarProfile(id) { return profiles.get(normId(id)) || null; }
  function getGroupProfile(id) { return groupProfiles.get(normId(id)) || null; }
  function getGroupName(id) { const g = groupNames.get(normId(id)); return g ? g.name : ''; }
  function getGroupInsigniaId(id) { const g = groupNames.get(normId(id)); return g ? (g.insigniaId || '') : ''; }
  function getGroupTitles(id) { return groupTitlesMap.get(normId(id)) || null; }
  function hasGroupTitlesCache(id) { return groupTitlesMap.has(normId(id)); }
  function isGroupTitlesFetchSettled(id) { const t = groupTitlesMap.get(normId(id)); return !!(t && t.complete); }
  function getImageId(agentId) { const p = profiles.get(normId(agentId)); return (p && p.imageId) || ''; }
  function getPickDetail(id) { return pickDetails.get(normId(id)) || null; }
  function getClassifiedDetail(id) { return classifiedDetails.get(normId(id)) || null; }
  function getActiveGroupId() { return active.id; }
  function getActiveGroupInfo() { return active.id ? { id: active.id, name: active.name || getGroupName(active.id), title: active.title } : null; }
  function isActiveGroup(id) { return !!active.id && active.id === normId(id); }
  function isAgentInGroup(id) { return membership.has(normId(id)); }
  /// Every group we belong to, as the raw membership rows (id, name, powers...).
  function getAgentGroups() { return Array.from(membership.values()); }
  function hasAgentProfileCap() { return true; }    // yes, we rely on the AgentProfile HTTP cap
  function isCapFetchActive(_id?) { return false; }
  // An avatar in a list gets cached from its thumbnail with UDP data only
  // (source 'udp'), but we still need the AgentProfile cap for the full 1st/2nd-life
  // text + account status. So the cap fetch is needed unless we already have cap data.
  function needsCapProfileFetch(profile) { return !profile || profile.source !== 'cap'; }

  function isSelfAvatarId(id) {
    try {
      const me = (typeof BeeState !== 'undefined' && BeeState.get && BeeState.get().agent)
        ? BeeState.get().agent.id : '';
      return !!me && normId(me) === normId(id);
    } catch (_e) { return false; }
  }

  function getProfileGroupsForDisplay(avatarId, profile) {
    const p = profile || getAvatarProfile(avatarId) || {};
    const self = isSelfAvatarId(avatarId || p.avatarId);
    const byId = new Map();
    (Array.isArray(p.groups) ? p.groups : []).forEach(function (g) {
      if (g && g.id) byId.set(normId(g.id), g);
    });
    // On your own profile, fold in the complete membership list (from
    // AgentGroupDataUpdate): it includes groups hidden from search and any the
    // profile cap omits - otherwise the list briefly shows in full, then collapses
    // to the short cap set once the caps arrive.
    if (self) {
      membership.forEach(function (g, gid) { if (!byId.has(gid)) byId.set(gid, g); });
    }
    const out = Array.from(byId.values()).filter(function (g) {
      if (!g || !g.id || !g.name) return false;
      // On your own profile show them all; for everyone else, honour "show in profile".
      return self ? true : g.listInProfile !== false;
    });
    // Sort alphabetically by name, ignoring case.
    out.sort(function (a, b) {
      return String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase());
    });
    return out;
  }

  function mergeAvatarProfile(id, patch) {
    const key = normId(id);
    profiles.set(key, Object.assign({}, profiles.get(key), patch || {}));
    emitChange('avatar', key);
    return profiles.get(key);
  }

  // --- fetches (a thin invoke; the cache fills in from the reply event) ---

  function invoke(cmd: string, args?: Record<string, unknown>) { return BeeBridge.invoke(cmd, args || {}).catch(function () {}); }

  // Several callers pass an options object (force/quiet). Nothing here reads
  // it - a fetch always re-requests - so it is accepted and ignored rather
  // than silently dropped at the call sites.
  function fetchAvatarProfile(id, _options?) {
    const key = normId(id);
    if (isZero(key)) return Promise.resolve(null);
    invoke('sl_request_avatar_properties', { avatarId: key }); // over UDP: properties + interests + groups
    invoke('sl_fetch_agent_profile', { avatarId: key });       // the richer HTTP cap (source 'cap'), when available
    invoke('sl_request_avatar_notes', { avatarId: key });
    return waitFor('profile:' + key, 12000, function () { return getAvatarProfile(key); });
  }
  function ensureAvatarExtras(id, _profile?) {
    const key = normId(id);
    if (isZero(key)) return Promise.resolve();
    invoke('sl_request_avatar_notes', { avatarId: key });
    invoke('sl_request_avatar_picks', { avatarId: key });
    invoke('sl_request_avatar_classifieds', { avatarId: key });
    return Promise.resolve();
  }
  function fetchGroupProfile(id, _options?) {
    const key = normId(id);
    if (isZero(key)) return Promise.resolve(null);
    invoke('sl_request_group_profile', { groupId: key });
    return waitFor('group:' + key, 12000, function () { return getGroupProfile(key); });
  }
  function fetchGroupTitles(id, _options?) {
    const key = normId(id);
    if (isZero(key)) return Promise.resolve(null);
    invoke('sl_group_request_titles', { groupId: key });
    return waitFor('titles:' + key, 12000, function () { return getGroupTitles(key); });
  }
  function fetchPickInfo(avatarId, pickId) {
    const pk = normId(pickId || avatarId);
    if (isZero(pk)) return Promise.resolve(null);
    invoke('sl_request_pick_info', { avatarId: normId(avatarId), pickId: pk });
    return waitFor('pick:' + pk, 12000, function () { return getPickDetail(pk); });
  }
  function fetchClassifiedInfo(classifiedId) {
    const cid = normId(classifiedId);
    if (isZero(cid)) return Promise.resolve(null);
    invoke('sl_request_classified_info', { classifiedId: cid });
    return waitFor('classified:' + cid, 12000, function () { return getClassifiedDetail(cid); });
  }
  // In-flight guard: until the reply arrives, `profiles.has(key)` is still
  // false, so without `pendingThumbs` every re-render would re-fire the request -
  // the O(N²) storm we hit when the buddy list opened. The pending flag clears on
  // the avatar-profile reply, or after a timeout so a dropped reply can be retried.
  function queueAvatarThumb(agentId) {
    const key = normId(agentId);
    if (isZero(key) || profiles.has(key) || pendingThumbs.has(key)) return;
    pendingThumbs.add(key);
    invoke('sl_request_avatar_properties', { avatarId: key });
    setTimeout(function () { pendingThumbs.delete(key); }, 30000);
  }
  function queueGroupName(ids) {
    (Array.isArray(ids) ? ids : [ids]).forEach(function (id) {
      const key = normId(id);
      if (isZero(key) || groupNames.has(key) || pendingGroups.has(key)) return;
      pendingGroups.add(key);
      invoke('sl_request_group_profile', { groupId: key });
      setTimeout(function () { pendingGroups.delete(key); }, 30000);
    });
  }

  attach();

  return {
    init: init, onChange: onChange, normId: normId, isZero: isZero,
    textureImageUrl: textureImageUrl, resolveWebProfileUrl: resolveWebProfileUrl,
    formatAvatarInterests: formatAvatarInterests, formatBornLabel: formatBornLabel,
    getAvatarProfile: getAvatarProfile, getGroupProfile: getGroupProfile,
    getGroupName: getGroupName, getGroupInsigniaId: getGroupInsigniaId,
    getGroupTitles: getGroupTitles, hasGroupTitlesCache: hasGroupTitlesCache,
    isGroupTitlesFetchSettled: isGroupTitlesFetchSettled, getImageId: getImageId,
    getPickDetail: getPickDetail, getClassifiedDetail: getClassifiedDetail,
    getActiveGroupId: getActiveGroupId, getActiveGroupInfo: getActiveGroupInfo,
    isActiveGroup: isActiveGroup, isAgentInGroup: isAgentInGroup,
    getAgentGroups: getAgentGroups,
    hasAgentProfileCap: hasAgentProfileCap, isCapFetchActive: isCapFetchActive,
    needsCapProfileFetch: needsCapProfileFetch,
    getProfileGroupsForDisplay: getProfileGroupsForDisplay, mergeAvatarProfile: mergeAvatarProfile,
    fetchAvatarProfile: fetchAvatarProfile, ensureAvatarExtras: ensureAvatarExtras,
    fetchGroupProfile: fetchGroupProfile, fetchGroupTitles: fetchGroupTitles,
    fetchPickInfo: fetchPickInfo, fetchClassifiedInfo: fetchClassifiedInfo,
    queueAvatarThumb: queueAvatarThumb, queueGroupName: queueGroupName
  };
})();
