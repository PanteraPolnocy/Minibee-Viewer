/**
 * Teleport offer/request helpers (IM dialog types + lure bucket).
 */
const FSTeleport = (function () {
  'use strict';

  const IM_LURE_USER = 22;
  const IM_LURE_ACCEPTED = 23;
  const IM_LURE_DECLINED = 24;
  const IM_TELEPORT_REQUEST = 26;

  const TELEPORT_FLAGS = {
    SET_HOME_TO_TARGET: 1 << 0,
    SET_LAST_TO_TARGET: 1 << 1,
    VIA_LURE: 1 << 2,
    VIA_LANDMARK: 1 << 3,
    VIA_LOCATION: 1 << 4,
    VIA_HOME: 1 << 5,
    VIA_TELEHUB: 1 << 6,
    VIA_LOGIN: 1 << 7,
    VIA_GODLIKE_LURE: 1 << 8,
    GODLIKE: 1 << 9,
    TELEPORT_911: 1 << 10,
    DISABLE_CANCEL: 1 << 11,
    VIA_REGION_ID: 1 << 12,
    IS_FLYING: 1 << 13,
    SHOW_RESET_HOME: 1 << 14,
    FORCE_REDIRECT: 1 << 15,
    VIA_GLOBAL_COORDS: 1 << 16,
    WITHIN_REGION: 1 << 17
  };

  const FLAG_LABELS = [
    ['SET_HOME_TO_TARGET', TELEPORT_FLAGS.SET_HOME_TO_TARGET],
    ['SET_LAST_TO_TARGET', TELEPORT_FLAGS.SET_LAST_TO_TARGET],
    ['VIA_LURE', TELEPORT_FLAGS.VIA_LURE],
    ['VIA_LANDMARK', TELEPORT_FLAGS.VIA_LANDMARK],
    ['VIA_LOCATION', TELEPORT_FLAGS.VIA_LOCATION],
    ['VIA_HOME', TELEPORT_FLAGS.VIA_HOME],
    ['VIA_TELEHUB', TELEPORT_FLAGS.VIA_TELEHUB],
    ['VIA_LOGIN', TELEPORT_FLAGS.VIA_LOGIN],
    ['VIA_GODLIKE_LURE', TELEPORT_FLAGS.VIA_GODLIKE_LURE],
    ['GODLIKE', TELEPORT_FLAGS.GODLIKE],
    ['TELEPORT_911', TELEPORT_FLAGS.TELEPORT_911],
    ['DISABLE_CANCEL', TELEPORT_FLAGS.DISABLE_CANCEL],
    ['VIA_REGION_ID', TELEPORT_FLAGS.VIA_REGION_ID],
    ['IS_FLYING', TELEPORT_FLAGS.IS_FLYING],
    ['SHOW_RESET_HOME', TELEPORT_FLAGS.SHOW_RESET_HOME],
    ['FORCE_REDIRECT', TELEPORT_FLAGS.FORCE_REDIRECT],
    ['VIA_GLOBAL_COORDS', TELEPORT_FLAGS.VIA_GLOBAL_COORDS],
    ['WITHIN_REGION', TELEPORT_FLAGS.WITHIN_REGION]
  ];

  const FORCED_FLAG_MASK =
    TELEPORT_FLAGS.VIA_GODLIKE_LURE |
    TELEPORT_FLAGS.GODLIKE |
    TELEPORT_FLAGS.TELEPORT_911 |
    TELEPORT_FLAGS.FORCE_REDIRECT;

  const VIA_MASK =
    TELEPORT_FLAGS.VIA_LURE |
    TELEPORT_FLAGS.VIA_LANDMARK |
    TELEPORT_FLAGS.VIA_LOCATION |
    TELEPORT_FLAGS.VIA_HOME |
    TELEPORT_FLAGS.VIA_TELEHUB |
    TELEPORT_FLAGS.VIA_LOGIN |
    TELEPORT_FLAGS.VIA_REGION_ID;

  function describeTeleportFlags(flags) {
    const f = flags >>> 0;
    if (!f) return 'none';
    const parts = [];
    FLAG_LABELS.forEach(function (pair) {
      if (f & pair[1]) parts.push(pair[0]);
    });
    return parts.length ? parts.join('|') : ('0x' + f.toString(16));
  }

  function shouldFollowRemoteTeleportStart(flags) {
    const f = flags >>> 0;
    if (!(f & TELEPORT_FLAGS.VIA_LURE)) return true;
    return !!(f & FORCED_FLAG_MASK);
  }

  function isForcedTeleport(flags) {
    const f = flags >>> 0;
    if (!shouldFollowRemoteTeleportStart(f)) return false;
    return !!(f & FORCED_FLAG_MASK) ||
      ((f & TELEPORT_FLAGS.DISABLE_CANCEL) && !(f & TELEPORT_FLAGS.VIA_LURE));
  }

  function isWithinRegion(flags) {
    return !!((flags >>> 0) & TELEPORT_FLAGS.WITHIN_REGION);
  }

  function lureAcceptFlags(godlike) {
    let flags = TELEPORT_FLAGS.VIA_LURE;
    if (godlike) {
      flags |= TELEPORT_FLAGS.VIA_GODLIKE_LURE;
      flags |= TELEPORT_FLAGS.DISABLE_CANCEL;
    }
    return flags >>> 0;
  }

  function canCancel(flags, forced) {
    if (forced) return false;
    const f = flags >>> 0;
    if (f & TELEPORT_FLAGS.DISABLE_CANCEL) return false;
    if (f & FORCED_FLAG_MASK) return false;
    return true;
  }

  function parseLureBucket(text) {
    const parts = String(text || '').split('|');
    if (parts.length < 8) return null;
    const nums = parts.slice(0, 8).map(function (p) { return parseInt(p, 10); });
    if (nums.some(function (n) { return Number.isNaN(n); })) return null;
    const accessToken = (parts[8] || '').trim();
    let regionAccess = 'PG';
    if (accessToken === 'A') regionAccess = 'Adult';
    else if (accessToken === 'M') regionAccess = 'Mature';
    return {
      gridX: nums[0],
      gridY: nums[1],
      position: { x: nums[2], y: nums[3], z: nums[4] },
      lookAt: { x: nums[5], y: nums[6], z: nums[7] },
      regionAccess: regionAccess
    };
  }

  function buildSlurl(regionName, position) {
    const name = String(regionName || 'Region').trim().replace(/\s+/g, '%20');
    const pos = position || { x: 128, y: 128, z: 25 };
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    const z = Math.round(pos.z);
    return 'http://maps.secondlife.com/secondlife/' + name + '/' + x + '/' + y + '/' + z;
  }

  function stripSlurl(text) {
    return String(text || '').replace(/\r?\nhttp:\/\/maps\.secondlife\.com\/[^\s]+/gi, '').trim();
  }

  function isTeleportDialog(dialog) {
    return dialog === IM_LURE_USER ||
      dialog === IM_TELEPORT_REQUEST ||
      dialog === IM_LURE_DECLINED ||
      dialog === IM_LURE_ACCEPTED;
  }

  function dialogLabel(dialog) {
    if (dialog === IM_LURE_USER) return 'Teleport offer';
    if (dialog === IM_TELEPORT_REQUEST) return 'Teleport request';
    if (dialog === IM_LURE_DECLINED) return 'Teleport declined';
    if (dialog === IM_LURE_ACCEPTED) return 'Teleport accepted';
    return 'Teleport';
  }

  return {
    IM_LURE_USER: IM_LURE_USER,
    IM_LURE_ACCEPTED: IM_LURE_ACCEPTED,
    IM_LURE_DECLINED: IM_LURE_DECLINED,
    IM_TELEPORT_REQUEST: IM_TELEPORT_REQUEST,
    TELEPORT_FLAGS: TELEPORT_FLAGS,
    VIA_MASK: VIA_MASK,
    describeTeleportFlags: describeTeleportFlags,
    shouldFollowRemoteTeleportStart: shouldFollowRemoteTeleportStart,
    isForcedTeleport: isForcedTeleport,
    isWithinRegion: isWithinRegion,
    lureAcceptFlags: lureAcceptFlags,
    canCancel: canCancel,
    parseLureBucket: parseLureBucket,
    buildSlurl: buildSlurl,
    stripSlurl: stripSlurl,
    isTeleportDialog: isTeleportDialog,
    dialogLabel: dialogLabel
  };
})();
