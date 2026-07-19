/**
 * Live SL transport via PHP bridge + UDP circuit.
 */
const FSSLTransport = (function () {
  'use strict';

  let bridge = null;
  let circuit = null;
  let circuitSessionId = null;
  let loginData = null;
  let pollTimer = null;
  const nameCache = new Map();
  const IM_TYPING_START = 41;
  const IM_TYPING_STOP = 42;

  function agentFullName() {
    if (!loginData) return '';
    return loginData.agent.first + ' ' + loginData.agent.last;
  }

  function currentRegionId() {
    return (circuit && circuit.regionId) ||
      (loginData && loginData.region && loginData.region.id) ||
      '00000000-0000-0000-0000-000000000000';
  }
  const PF_ALLOW_FLY = 1 << 0;
  const PF_ALLOW_OTHER_SCRIPTS = 1 << 1;
  const PF_ALLOW_TERRAFORM = 1 << 4;
  const PF_ALLOW_DAMAGE = 1 << 5;
  const PF_CREATE_OBJECTS = 1 << 6;
  const PF_USE_ACCESS_GROUP = 1 << 8;
  const PF_USE_ACCESS_LIST = 1 << 9;
  const PF_USE_BAN_LIST = 1 << 10;
  const PF_USE_PASS_LIST = 1 << 11;
  const PF_SHOW_DIRECTORY = 1 << 12;
  const PF_SOUND_LOCAL = 1 << 15;
  const PF_RESTRICT_PUSHOBJECT = 1 << 21;
  const PF_ALLOW_GROUP_SCRIPTS = 1 << 25;
  const PF_CREATE_GROUP_OBJECTS = 1 << 26;
  const PF_ALLOW_VOICE_CHAT = 1 << 29;

  function normAgentId(id) {
    return String(id || '').toLowerCase();
  }

  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
  const recentImIds = new Map();
  const recentImFallback = new Map();
  const IM_DEDUP_TTL_MS = 120000;
  const IM_DEDUP_FALLBACK_MS = 4000;
  const IM_DEDUP_MAX = 600;
  const recentPaymentKeys = new Map();
  const PAYMENT_DEDUP_TTL_MS = 15000;
  const PAYMENT_DEDUP_MAX = 200;

  function pruneImDedup(now) {
    recentImIds.forEach(function (ts, key) {
      if (now - ts > IM_DEDUP_TTL_MS) recentImIds.delete(key);
    });
    recentImFallback.forEach(function (ts, key) {
      if (now - ts > IM_DEDUP_FALLBACK_MS) recentImFallback.delete(key);
    });
    if (recentImIds.size > IM_DEDUP_MAX) {
      const drop = recentImIds.size - IM_DEDUP_MAX;
      let i = 0;
      recentImIds.forEach(function (_ts, key) {
        if (i++ < drop) recentImIds.delete(key);
      });
    }
  }

  function clearImDedup() {
    recentImIds.clear();
    recentImFallback.clear();
  }

  function paymentDedupKey(data) {
    const txId = normAgentId(data.transactionId);
    if (txId && txId !== ZERO_UUID) {
      return 'tx:' + txId;
    }
    const note = String(data.description || '').trim();
    if (!note) return '';
    return 'fb:' + note + '\0' + String(data.balance ?? '') + '\0' + String(data.transactionType || 0);
  }

  function prunePaymentDedup(now) {
    recentPaymentKeys.forEach(function (ts, key) {
      if (now - ts > PAYMENT_DEDUP_TTL_MS) recentPaymentKeys.delete(key);
    });
    if (recentPaymentKeys.size > PAYMENT_DEDUP_MAX) {
      const drop = recentPaymentKeys.size - PAYMENT_DEDUP_MAX;
      let i = 0;
      recentPaymentKeys.forEach(function (_ts, key) {
        if (i++ < drop) recentPaymentKeys.delete(key);
      });
    }
  }

  function isDuplicatePayment(data) {
    const key = paymentDedupKey(data);
    if (!key) return false;
    const now = Date.now();
    prunePaymentDedup(now);
    if (recentPaymentKeys.has(key)) return true;
    recentPaymentKeys.set(key, now);
    return false;
  }

  function clearPaymentDedup() {
    recentPaymentKeys.clear();
  }

  function isDuplicateIm(data) {
    const now = Date.now();
    pruneImDedup(now);
    const imId = normAgentId(data.imId);
    if (imId && imId !== ZERO_UUID) {
      if (recentImIds.has(imId)) return true;
      recentImIds.set(imId, now);
      return false;
    }
    const fromId = normAgentId(data.fromAgentId);
    const text = String(data.text || '');
    if (!fromId || !text) return false;
    const key = fromId + '\0' + String(data.dialog || 0) + '\0' + text;
    const last = recentImFallback.get(key);
    if (last && now - last < IM_DEDUP_FALLBACK_MS) return true;
    recentImFallback.set(key, now);
    return false;
  }

  function cacheNameInfo(id, info) {
    if (!id || !info) return;
    const key = normAgentId(id);
    const existing = nameCache.get(key);
    const displayName = String(info.displayName || (existing && existing.displayName) || '').trim();
    const userName = String(info.userName || (existing && existing.userName) || '').trim();
    const label = String(info.label || displayName || userName || '').trim();
    if (!label) return;
    nameCache.set(key, {
      displayName: displayName,
      userName: userName,
      label: label,
      nameLookupDone: info.nameLookupDone === true || !!(existing && existing.nameLookupDone)
    });
  }

  function cacheName(id, name) {
    if (!id || !name) return;
    const text = String(name).trim();
    if (!text) return;
    const existing = getCachedNameInfo(id);
    cacheNameInfo(id, {
      displayName: existing ? existing.displayName : '',
      userName: text,
      label: existing && existing.displayName ? existing.displayName : text
    });
  }

  function getCachedNameInfo(id) {
    return nameCache.get(normAgentId(id)) || null;
  }

  function getCachedName(id) {
    const info = getCachedNameInfo(id);
    return info ? info.label : '';
  }

  function mergeNameFields(target, info) {
    if (!info) return target;
    const out = Object.assign({}, target);
    out.name = info.label || out.name;
    out.displayName = info.displayName || out.displayName || '';
    out.userName = info.userName || out.userName || '';
    if (!out.userName && out.legacyName) out.userName = out.legacyName;
    if (!out.userName && out.name && out.name !== out.displayName) out.userName = out.name;
    return out;
  }

  function looksUnresolvedName(name, id) {
    if (!name) return true;
    if (name === id) return true;
    if (/^[0-9a-f]{8}\.\.\.$/i.test(name)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name)) return true;
    return false;
  }

  function isNameFullyResolved(id) {
    if (!id) return true;
    const info = getCachedNameInfo(id);
    if (!info || looksUnresolvedName(info.label, id)) return false;
    if (!displayNamesCapUrl) return true;
    return !!info.nameLookupDone;
  }

  let capBootstrapPromise = null;
  let capBootstrapTimer = null;
  let capBootstrapRetryTimer = null;
  let capBootstrapFallbackTimer = null;
  let circuitReady = false;
  let agentPlaced = false;
  let teleportFinishReceived = false;
  let pendingTeleportLoc = null;
  let teleportTimeoutTimer = null;
  let teleportPollTimer = null;
  let teleportRetryTimer = null;
  let teleportStartSeen = false;
  let teleportArrivalUntil = 0;
  let postTeleportCapGraceUntil = 0;
  const TELEPORT_ARRIVAL_GRACE_MS = 6000;
  const POST_TELEPORT_CAP_GRACE_MS = 20000;
  const POST_TELEPORT_CAP_BOOTSTRAP_MS = 2500;
  const unresolvedPacketSeen = new Set();
  const enabledSimulators = new Set();
  let mapBlockWaiters = [];
  const MAP_ITEM_AGENT_LOCATIONS = 6;
  const MAP_AGENT_REFRESH_MS = 30000;
  let mapAgentQueue = [];
  let mapAgentInflight = null;
  const mapAgentRequestedAt = new Map();
  const MAP_SIM_RETURN_NULL_SIMS = 0x00010000;
  let circuitLocalPort = 0;
  let capsReady = false;
  let lastCapError = '';
  let lastCapErrorNote = '';
  let lastSeedHost = '';
  let lastGoodSeedCapability = '';
  let pendingNameIds = new Set();
  let nameResolveTimer = null;
  let displayNamesCapUrl = null;
  let remoteParcelCapUrl = null;
  let regionCaps = {};
  let eventQueueCapUrl = null;
  let eventQueueRecoverPromise = null;
  let eventQueueRestartTimer = null;
  let circuitServicesStarted = false;
  const CIRCUIT_SERVICES_DELAY_MS = 3500;
  const HTTP_PARCEL_MIN_INTERVAL_MS = 15000;
  const PARCEL_REFRESH_MIN_INTERVAL_MS = 60000;
  let udpPacketsReceived = 0;
  let eventQueueWanted = false;
  let udpRecvLogged = false;
  let lastHttpParcelAt = 0;
  let lastParcelRefreshAt = 0;
  let lastParcelEmitSignature = '';
  let parcelRequestCount = 0;
  let parcelPacketCount = 0;
  let refreshParcelRunning = false;
  let refreshParcelQueued = false;
  let landCapsPromise = null;
  let lastParcelDiag = '';
  const pendingParcelInfo = new Map();
  const PARCEL_INFO_TIMEOUT_MS = 12000;
  let nameResolveInFlight = false;
  let nameResolveRetryTimer = null;
  let lateTeleportLoc = null;
  let lateTeleportUntil = 0;
  let sessionLost = false;
  const POSITION_SYNC_INTERVAL_MS = 30000;
  let lastPositionEmittedAt = 0;
  let lastCoarseSelfPos = null;
  let lastCoarseSelfAt = 0;
  let positionSyncTimer = null;
  let radarSettleUntil = 0;
  const RADAR_SETTLE_MS = 8000;

  function simActionsBlocked() {
    return sessionLost || !circuit || !circuit.active;
  }

  function handleSessionLost(reason, source) {
    if (sessionLost || !loginData) return;
    sessionLost = true;
    stopPositionSync();
    if (typeof FSEventQueue.setTeleportActive === 'function') {
      FSEventQueue.setTeleportActive(false);
    }
    FSEventQueue.stop(false, { force: true });
    clearTeleportTimers();
    pendingTeleportLoc = null;
    teleportStartSeen = false;
    if (circuit) {
      circuit.stop();
    }
    const text = String(reason || 'Disconnected from the simulator.').trim() ||
      'Disconnected from the simulator.';
    FSErrors.warn('session', text, true);
    emit('session-lost', { reason: text, source: source || 'sim' });
  }

  function positionsDiffer(a, b, epsilon) {
    if (!a || !b) return true;
    const e = epsilon !== undefined ? epsilon : 0.25;
    return Math.abs(a.x - b.x) > e ||
      Math.abs(a.y - b.y) > e ||
      Math.abs((a.z || 0) - (b.z || 0)) > e;
  }

  function emitAgentPosition(position, source) {
    if (!loginData || !position || sessionLost) return false;
    const pos = {
      x: position.x,
      y: position.y,
      z: position.z !== undefined ? position.z : ((loginData.position && loginData.position.z) || 25)
    };
    if (!positionsDiffer(loginData.position, pos)) return false;
    loginData.position = pos;
    if (circuit) circuit.position = pos;
    lastPositionEmittedAt = Date.now();
    emit('position', {
      position: pos,
      region: loginData.region,
      source: source || 'sync'
    });
    return true;
  }

  function coarseSelfPosition(coarse) {
    if (!coarse || coarse.youIndex < 0) return null;
    const locs = coarse.locations || [];
    if (coarse.youIndex >= locs.length) return null;
    const loc = locs[coarse.youIndex];
    return { x: loc.x, y: loc.y, z: loc.z };
  }

  function applyCoarseSelfPosition(coarse) {
    const pos = coarseSelfPosition(coarse);
    if (!pos) return false;
    lastCoarseSelfPos = pos;
    lastCoarseSelfAt = Date.now();
    return emitAgentPosition(pos, 'coarse');
  }

  function syncAgentPositionIfStale() {
    if (!loginData || sessionLost || !circuit || !circuit.handshakeDone) return;
    if ((Date.now() - lastPositionEmittedAt) < POSITION_SYNC_INTERVAL_MS) return;
    if (lastCoarseSelfPos && (Date.now() - lastCoarseSelfAt) < 120000) {
      emitAgentPosition(lastCoarseSelfPos, 'coarse-refresh');
      return;
    }
    if (circuit.position) {
      emitAgentPosition(circuit.position, 'heartbeat');
    }
  }

  function startPositionSync() {
    stopPositionSync();
    lastPositionEmittedAt = Date.now();
    positionSyncTimer = setInterval(syncAgentPositionIfStale, POSITION_SYNC_INTERVAL_MS);
  }

  function stopPositionSync() {
    if (positionSyncTimer) {
      clearInterval(positionSyncTimer);
      positionSyncTimer = null;
    }
    lastCoarseSelfPos = null;
    lastCoarseSelfAt = 0;
    lastPositionEmittedAt = 0;
  }

  function cleanCapUrl(url) {
    let s = String(url || '').replace(/"/g, '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      s = 'https://' + s.replace(/^\/+/, '');
    }
    return normalizeSeedUrl(s);
  }

  // Fix only slash-corrupted seeds: simhost-123/abc.agni.secondlife.io:port/cap/...
  function normalizeSeedUrl(url) {
    let s = String(url || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      s = 'https://' + s.replace(/^\/+/, '');
    }
    try {
      const u = new URL(s);
      const host = u.hostname;
      const port = u.port ? ':' + u.port : '';
      const path = u.pathname + u.search + u.hash;
      const slashPath = path.match(/^\/([0-9a-f]+)\.agni\.secondlife\.io(:\d+)?(\/cap\/.*)$/i);
      if (/^simhost-\d+$/i.test(host) && slashPath) {
        return 'https://' + host + slashPath[1] + '.agni.secondlife.io' + (slashPath[2] || port) + slashPath[3];
      }
    } catch (_e) { /* keep original */ }
    return s.replace(
      /^https?:\/\/simhost-(\d+)\/([0-9a-f]+)\.agni\.secondlife\.io(:\d+)?(\/.*)?$/i,
      function (_m, hostNum, hex, p, rest) {
        return 'https://simhost-' + hostNum + hex + '.agni.secondlife.io' + (p || '') + (rest || '');
      }
    );
  }

  function systemNote(text) {
    FSErrors.info('system', text, true);
  }

  function clearTeleportTimers() {
    teleportStartSeen = false;
    enabledSimulators.clear();
    if (teleportTimeoutTimer) {
      clearTimeout(teleportTimeoutTimer);
      teleportTimeoutTimer = null;
    }
    if (teleportPollTimer) {
      clearInterval(teleportPollTimer);
      teleportPollTimer = null;
    }
    if (teleportRetryTimer) {
      clearTimeout(teleportRetryTimer);
      teleportRetryTimer = null;
    }
  }

  function endTeleportOutboundPause(resumeMovement) {
    if (!circuit) return;
    circuit._teleportWatch = false;
    circuit._teleportPauseOutbound = false;
    circuit._pendingTeleportSeq = null;
    if (resumeMovement && circuit.handshakeDone) {
      circuit._sendAgentUpdate();
    }
  }

  function stashLateTeleportGrace() {
    if (teleportStartSeen && pendingTeleportLoc) {
      lateTeleportLoc = Object.assign({}, pendingTeleportLoc);
      lateTeleportUntil = Date.now() + 20000;
    }
  }

  function clearLateTeleportGrace() {
    lateTeleportLoc = null;
    lateTeleportUntil = 0;
  }

  function claimPendingTeleportLoc() {
    if (pendingTeleportLoc) {
      return pendingTeleportLoc;
    }
    if (lateTeleportLoc && Date.now() < lateTeleportUntil) {
      pendingTeleportLoc = lateTeleportLoc;
      lateTeleportLoc = null;
      lateTeleportUntil = 0;
      FSErrors.info('teleport', 'Completing late TeleportFinish', false);
      return pendingTeleportLoc;
    }
    return null;
  }

  function clearTeleportPending(resumeMovement, options) {
    const opts = options || {};
    if (opts.stashLateGrace) {
      stashLateTeleportGrace();
    } else if (!opts.keepLateGrace) {
      clearLateTeleportGrace();
    }
    pendingTeleportLoc = null;
    clearTeleportTimers();
    if (typeof FSEventQueue.setTeleportActive === 'function') {
      FSEventQueue.setTeleportActive(false);
    }
    endTeleportOutboundPause(resumeMovement !== false);
  }

  function markTeleportArrived() {
    teleportArrivalUntil = Date.now() + TELEPORT_ARRIVAL_GRACE_MS;
  }

  function assertCanTeleport() {
    if (sessionLost) {
      throw new Error('Session ended - return to the login screen to reconnect');
    }
    if (!circuit || !loginData) {
      throw new Error('Not connected');
    }
    if (!circuit.handshakeDone) {
      throw new Error('Circuit handshake not complete yet - wait a few seconds and retry');
    }
    if (!agentPlaced) {
      throw new Error('Agent not placed in world yet - wait for login to finish');
    }
  }

  function isTeleportInProgress() {
    return !!pendingTeleportLoc;
  }

  function prepareOutboundTeleport(loc) {
    pendingTeleportLoc = loc;
    teleportStartSeen = false;
    enabledSimulators.clear();
    if (typeof FSEventQueue.setTeleportActive === 'function') {
      FSEventQueue.setTeleportActive(true);
    }
    kickEventQueueForTeleport('teleport outbound');
    if (circuit) {
      circuit._teleportWatch = true;
      circuit._teleportPauseOutbound = true;
      circuit._pendingTeleportSeq = null;
    }
    scheduleTeleportTimeout();
    startTeleportPollBurst();
    beginRadarSettle();
    emit('radar-update', []);
    invalidateParcel();
  }

  function failTeleport(reason, source) {
    const text = String(reason || 'Teleport failed').trim() || 'Teleport failed';
    if (isBenignTeleportFailure(text)) {
      completeBenignTeleportFailure(text, source || 'sim');
      return;
    }
    const wasActive = !!pendingTeleportLoc || teleportStartSeen;
    if (wasActive) {
      invalidateRegionCaps('teleport failed');
      clearTeleportPending(true, { stashLateGrace: true });
    }
    FSErrors.warn('teleport', 'TeleportFailed (' + (source || 'sim') + '): ' + text, true);
    emit('teleport-failed', { reason: text, source: source || 'sim' });
    ensureEventQueuePoll('teleport failed');
  }

  function syncHomeFromTeleportFlags(flags, regionHandle, position) {
    if (!loginData || !loginData.home) return;
    if (!((flags >>> 0) & FSTeleport.TELEPORT_FLAGS.SET_HOME_TO_TARGET)) return;
    const grid = regionHandle ? FSSlurl.fromRegionHandle(regionHandle) : null;
    if (grid) {
      loginData.home.globalX = grid.globalX;
      loginData.home.globalY = grid.globalY;
      loginData.home.gridX = grid.gridX;
      loginData.home.gridY = grid.gridY;
    }
    if (pendingTeleportLoc && pendingTeleportLoc.regionName) {
      loginData.home.regionName = pendingTeleportLoc.regionName;
    }
    const pos = position || (pendingTeleportLoc ? {
      x: pendingTeleportLoc.x,
      y: pendingTeleportLoc.y,
      z: pendingTeleportLoc.z
    } : null);
    if (pos && pos.x !== undefined) {
      loginData.home.x = pos.x;
      loginData.home.y = pos.y;
      loginData.home.z = pos.z !== undefined ? pos.z : loginData.home.z;
    }
  }

  async function cancelTeleport() {
    if (!pendingTeleportLoc || !circuit) return false;
    const flags = pendingTeleportLoc.flags || 0;
    if (!FSTeleport.canCancel(flags, pendingTeleportLoc.forced)) {
      throw new Error('This teleport cannot be cancelled');
    }
    FSErrors.info('teleport', 'TeleportCancel sent', false);
    await circuit.teleportCancel();
    clearTeleportPending(true);
    emit('teleport-cancelled', {});
    ensureEventQueuePoll('teleport cancelled');
    return true;
  }

  function scheduleTeleportLandmarkRetry(landmarkId) {
    if (teleportRetryTimer) {
      clearTimeout(teleportRetryTimer);
    }
    teleportRetryTimer = setTimeout(async function () {
      teleportRetryTimer = null;
      if (!pendingTeleportLoc || teleportStartSeen || !circuit) return;
      FSErrors.warn('teleport',
        'No TeleportStart after 8s - resending TeleportLandmarkRequest (close other SL viewers first).',
        true);
      try {
        circuit._teleportPauseOutbound = false;
        circuit._sendAgentUpdate();
        circuit._teleportPauseOutbound = true;
        const retry = await circuit.teleportLandmarkRequest(landmarkId || null);
        if (!retry || !retry.sent) {
          FSErrors.warn('teleport', 'Teleport landmark retry UDP send failed.', true);
        }
        if (circuit.kickPoll) circuit.kickPoll();
      } catch (err) {
        FSErrors.warn('teleport', 'Teleport landmark retry failed: ' + (err.message || String(err)), true);
      }
    }, 8000);
  }

  function shouldBeginSimInitiatedTeleport(flags) {
    if (!FSTeleport.shouldFollowRemoteTeleportStart(flags)) {
      return false;
    }
    if (FSTeleport.isForcedTeleport(flags)) {
      return true;
    }
    if (Date.now() < teleportArrivalUntil) {
      return false;
    }
    return true;
  }

  function isBenignTeleportFailure(reason) {
    const text = String(reason || '').trim().toLowerCase();
    if (!text) return false;
    if (text.indexOf('could not teleport closer') >= 0) return true;
    if (text.indexOf('landmark is missing from the database') >= 0) return true;
    return false;
  }

  function completeBenignTeleportFailure(reason, source) {
    clearTeleportPending();
    markTeleportArrived();
    emit('teleport-finish', { benign: true, reason: reason || '' });
    startEventQueuePollIfReady('teleport benign complete');
  }

  function syncHomeRegionFromArrival(tpLoc) {
    if (!loginData || !loginData.home || !tpLoc || !tpLoc.toHome) return;
    const home = loginData.home;
    const region = loginData.region || {};
    const resolvedName = resolveArrivalRegionName(tpLoc, region);
    if (resolvedName && !isPlaceholderRegionName(resolvedName)) {
      home.regionName = resolvedName;
      region.name = resolvedName;
    }
    if (region.x !== undefined && region.y !== undefined) {
      home.gridX = region.x;
      home.gridY = region.y;
      home.globalX = region.globalX;
      home.globalY = region.globalY;
      home.regionName = resolvedName || region.name || home.regionName;
    }
    const pos = (circuit && circuit.position) || tpLoc;
    if (pos && pos.x !== undefined) {
      home.x = pos.x;
      home.y = pos.y;
      home.z = pos.z !== undefined ? pos.z : home.z;
    }
  }

  function isAlreadyAtHome() {
    const home = loginData && loginData.home;
    const region = loginData && loginData.region;
    if (!home || !region || home.gridX === undefined || home.gridY === undefined) {
      return false;
    }
    if (region.x !== home.gridX || region.y !== home.gridY) {
      return false;
    }
    const pos = (circuit && circuit.position) || loginData.position;
    if (!pos || home.x === undefined || home.y === undefined) {
      return true;
    }
    const dx = pos.x - home.x;
    const dy = pos.y - home.y;
    const dz = (pos.z || 0) - (home.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz) < 8;
  }

  function createSimInitiatedPendingLoc(flags, positionHint) {
    const region = (loginData && loginData.region) || {};
    const pos = positionHint || (circuit && circuit.position) ||
      (loginData && loginData.position) || { x: 128, y: 128, z: 25 };
    return {
      regionName: region.name || 'Region',
      globalX: region.globalX,
      globalY: region.globalY,
      gridX: region.x,
      gridY: region.y,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      simInitiated: true,
      forced: FSTeleport.isForcedTeleport(flags),
      flags: flags >>> 0
    };
  }

  function beginSimInitiatedTeleport(flags, options) {
    if (sessionLost || !loginData || !circuit) return;
    const opts = options || {};
    if (pendingTeleportLoc && teleportStartSeen) return;
    clearLateTeleportGrace();
    if (pendingTeleportLoc && !teleportStartSeen) {
      clearTeleportPending(false);
    }
    const loc = opts.loc || createSimInitiatedPendingLoc(flags, opts.position);
    if (opts.loc) {
      loc.simInitiated = true;
      loc.forced = FSTeleport.isForcedTeleport(flags);
      loc.flags = flags >>> 0;
    } else {
      loc.flags = flags >>> 0;
    }
    prepareOutboundTeleport(loc);
    emit('teleport-started', pendingTeleportLoc);
    if (FSTeleport.isForcedTeleport(flags)) {
      emit('teleport-forced', { flags: flags >>> 0 });
    }
    if (circuit.kickPoll) circuit.kickPoll();
  }

  function enrichPendingFromRegionHandle(tpLoc, regionHandle) {
    if (!tpLoc || regionHandle == null) return tpLoc;
    const grid = FSSlurl.fromRegionHandle(regionHandle);
    tpLoc.globalX = grid.globalX;
    tpLoc.globalY = grid.globalY;
    tpLoc.gridX = grid.gridX;
    tpLoc.gridY = grid.gridY;
    return tpLoc;
  }

  function startTeleportPollBurst() {
    if (teleportPollTimer) {
      clearInterval(teleportPollTimer);
    }
    teleportPollTimer = setInterval(function () {
      if (!pendingTeleportLoc || !circuit) {
        clearInterval(teleportPollTimer);
        teleportPollTimer = null;
        return;
      }
      if (circuit.kickPoll) {
        circuit.kickPoll();
      }
    }, 400);
  }

  function scheduleTeleportRetry(loc, handle, pos, lookAt) {
    if (teleportRetryTimer) {
      clearTimeout(teleportRetryTimer);
    }
    teleportRetryTimer = setTimeout(async function () {
      teleportRetryTimer = null;
      if (!pendingTeleportLoc || teleportStartSeen || !circuit) return;
      FSErrors.warn('teleport',
        'No TeleportStart after 8s - resending TeleportLocationRequest (close other SL viewers first).',
        true);
      try {
        kickEventQueueForTeleport('teleport retry');
        circuit._teleportPauseOutbound = false;
        circuit._sendAgentUpdate();
        circuit._teleportPauseOutbound = true;
        const retry = await circuit.teleportLocationRequest(handle, pos, lookAt, true);
        if (!retry || !retry.sent) {
          FSErrors.warn('teleport', 'Teleport retry UDP send failed - restart bridge and hard-refresh.', true);
        }
        if (circuit.kickPoll) circuit.kickPoll();
        if (circuit.pulseCircuit) {
          circuit.pulseCircuit().catch(function () { /* ignore */ });
        }
      } catch (err) {
        FSErrors.warn('teleport', 'Teleport retry failed: ' + (err.message || String(err)), true);
      }
    }, 8000);
  }

  function teleportDiagnostics() {
    const parts = [];
    if (circuit) {
      parts.push('handshake=' + (circuit.handshakeDone ? 'ok' : 'pending'));
      parts.push('placed=' + (agentPlaced ? 'yes' : 'no'));
      parts.push('target=' + (circuit._simTarget || (loginData ? loginData.simIp + ':' + loginData.simPort : '?')));
      if (circuit._lastLocalPort) parts.push('udp=' + circuit._lastLocalPort);
    }
    if (teleportStartSeen) parts.push('TeleportStart=yes');
    else parts.push('TeleportStart=no');
    return parts.join(', ');
  }

  function scheduleTeleportTimeout(delayMs) {
    if (teleportTimeoutTimer) {
      clearTimeout(teleportTimeoutTimer);
    }
    const ms = delayMs || (teleportStartSeen ? 90000 : 30000);
    teleportTimeoutTimer = setTimeout(function () {
      if (!pendingTeleportLoc) return;
      const reason = 'No TeleportFinish/Failed after ' + Math.round(ms / 1000) +
        's (' + teleportDiagnostics() + ')';
      FSErrors.warn('teleport',
        reason + '. Close other SL viewers, restart bridge, hard-refresh, then retry.',
        true);
      if (teleportStartSeen) {
        handleStalledTeleportTimeout(reason);
        return;
      }
      invalidateRegionCaps('teleport timeout');
      clearTeleportPending(true, { stashLateGrace: true });
      emit('teleport-failed', { reason: reason });
      startEventQueuePollIfReady('teleport timeout');
    }, ms);
  }

  function teleportPositionForRequest(loc) {
    const width = FSSlurl.REGION_WIDTH;
    const local = {
      x: FSUtils.clamp(loc.x, 0, width),
      y: FSUtils.clamp(loc.y, 0, width),
      z: FSUtils.clamp(loc.z, 0, 4096)
    };
    if (!loginData || !loginData.region) {
      return local;
    }
    const curHandle = FSSlurl.toRegionHandle(loginData.region.globalX, loginData.region.globalY);
    const destHandle = FSSlurl.toRegionHandle(loc.globalX, loc.globalY);
    if (curHandle === destHandle) {
      return local;
    }
    const globalX = (loc.globalX || 0) + local.x;
    const globalY = (loc.globalY || 0) + local.y;
    return {
      x: ((globalX % width) + width) % width,
      y: ((globalY % width) + width) % width,
      z: local.z
    };
  }

  function isPlaceholderRegionName(name) {
    const text = String(name || '').trim().toLowerCase();
    return !text || text === 'home' || text === 'region';
  }

  function isViaHomeTeleport(flags, tpLoc) {
    const f = (flags || 0) >>> 0;
    if (f & FSTeleport.TELEPORT_FLAGS.VIA_HOME) return true;
    return !!(tpLoc && tpLoc.toHome);
  }

  function resolveArrivalGrid(evt, tpLoc) {
    const flags = (evt && evt.teleportFlags) || 0;
    const home = loginData && loginData.home;
    if (isViaHomeTeleport(flags, tpLoc) && home &&
        home.gridX !== undefined && home.gridY !== undefined) {
      return {
        globalX: home.globalX,
        globalY: home.globalY,
        gridX: home.gridX,
        gridY: home.gridY
      };
    }
    if (tpLoc && tpLoc.gridX !== undefined && tpLoc.gridY !== undefined) {
      return {
        globalX: tpLoc.globalX,
        globalY: tpLoc.globalY,
        gridX: tpLoc.gridX,
        gridY: tpLoc.gridY
      };
    }
    if (evt && evt.regionHandle) {
      const grid = FSSlurl.fromRegionHandle(evt.regionHandle);
      return {
        globalX: grid.globalX,
        globalY: grid.globalY,
        gridX: grid.gridX,
        gridY: grid.gridY
      };
    }
    return null;
  }

  function resolveArrivalRegionName(tpLoc, regionPayload, flags) {
    const viaHome = isViaHomeTeleport(flags, tpLoc);
    const candidates = viaHome ? [
      tpLoc && tpLoc.regionName,
      loginData && loginData.home && loginData.home.regionName,
      regionPayload && regionPayload.name,
      circuit && circuit.regionName,
      loginData && loginData.region && loginData.region.name
    ] : [
      tpLoc && tpLoc.regionName,
      regionPayload && regionPayload.name,
      circuit && circuit.regionName,
      loginData && loginData.region && loginData.region.name
    ];
    for (let i = 0; i < candidates.length; i++) {
      const name = String(candidates[i] || '').trim();
      if (name && !isPlaceholderRegionName(name)) {
        return name;
      }
    }
    const fallback = String((tpLoc && tpLoc.regionName) || '').trim();
    return fallback || 'Region';
  }

  function postRegionArrivalChat(regionName) {
    const name = resolveArrivalRegionName(
      { regionName: regionName },
      loginData && loginData.region ? { name: loginData.region.name } : null
    );
    postSystemChat('Connected to ' + name + '.');
  }

  function scheduleArrivalGridReconcile(regionName, flags, tpLoc) {
    const name = String(regionName || '').trim();
    if (!loginData || !loginData.region || isPlaceholderRegionName(name)) return;
    resolveRegionNameHttp(name).then(function (lookup) {
      if (!loginData || !lookup || lookup.gridX === undefined || lookup.gridY === undefined) {
        return;
      }
      const region = loginData.region;
      const home = loginData.home;
      const canonical = String(lookup.name || name).trim();
      const sameGrid = region.x === lookup.gridX && region.y === lookup.gridY;
      const sameName = String(region.name || '').toLowerCase() === canonical.toLowerCase();
      if (sameGrid && sameName) return;
      region.name = canonical;
      region.globalX = lookup.globalX;
      region.globalY = lookup.globalY;
      region.x = lookup.gridX;
      region.y = lookup.gridY;
      if (isViaHomeTeleport(flags, tpLoc) && home) {
        home.regionName = canonical;
        home.gridX = lookup.gridX;
        home.gridY = lookup.gridY;
        home.globalX = lookup.globalX;
        home.globalY = lookup.globalY;
      }
      FSErrors.info('map',
        'Region grid reconciled for ' + canonical + ' -> ' + lookup.gridX + ',' + lookup.gridY, false);
      emit('region', {
        name: region.name,
        id: region.id || '',
        globalX: region.globalX,
        globalY: region.globalY,
        x: region.x,
        y: region.y
      });
      emit('position', {
        position: loginData.position,
        region: {
          name: region.name,
          globalX: region.globalX,
          globalY: region.globalY,
          x: region.x,
          y: region.y
        }
      });
    }).catch(function () { /* lookup optional */ });
  }

  function postLoginMotdChat(message) {
    const body = String(message || '').trim();
    if (!body) return;
    emit('chat', {
      id: FSUtils.uuid(),
      fromId: '00000000-0000-0000-0000-000000000000',
      fromName: 'Linden Lab',
      text: body,
      type: 'system',
      source: 'motd',
      kind: 'motd',
      channel: 0,
      timestamp: Date.now()
    });
  }

  function postSystemChat(text) {
    const body = String(text || '').trim();
    if (!body) return;
    emit('chat', {
      id: FSUtils.uuid(),
      fromId: '00000000-0000-0000-0000-000000000000',
      fromName: 'System',
      text: body,
      type: 'system',
      source: 'system',
      channel: 0,
      timestamp: Date.now()
    });
  }

  function postEventMessage(msg) {
    if (!msg) return;
    emit('event', msg);
  }

  function postScriptDialogChat(data) {
    if (!data || !data.objectId) return;
    const name = data.objectName || 'Object';
    const message = String(data.message || '').trim();
    FSErrors.info('script', (data.isTextBox ? 'Script text box' : 'Script dialog') +
      ' from ' + name, false);
    postEventMessage({
      id: FSUtils.uuid(),
      kind: 'script-dialog',
      fromId: data.objectId,
      fromName: name,
      text: message || '(no message)',
      type: 'script',
      source: 'script',
      channel: data.chatChannel || 0,
      timestamp: Date.now(),
      dialog: {
        objectId: data.objectId,
        objectName: name,
        ownerName: data.ownerName || '',
        isGroup: !!data.isGroup,
        message: message,
        chatChannel: data.chatChannel || 0,
        buttons: (data.buttons || []).filter(Boolean),
        isTextBox: !!data.isTextBox,
        resolved: false,
        response: ''
      }
    });
  }

  function replyScriptDialog(objectId, buttonIndex, buttonLabel, chatChannel) {
    // User-initiated only. Never call automatically.
    if (!circuit || !circuit.replyScriptDialog || !objectId) {
      return Promise.resolve({ sent: false });
    }
    return circuit.replyScriptDialog(objectId, buttonIndex, buttonLabel, chatChannel);
  }

  const SCRIPT_PERMISSION_BITS = [
    { bit: 2, label: 'Take Linden dollars (L$) from your account', caution: true },
    { bit: 4, label: 'Act on your control inputs' },
    { bit: 8, label: 'Remap your control inputs' },
    { bit: 16, label: 'Animate your avatar' },
    { bit: 32, label: 'Attach to your avatar' },
    { bit: 64, label: 'Release ownership' },
    { bit: 128, label: 'Link and delink' },
    { bit: 256, label: 'Add and remove joints' },
    { bit: 512, label: 'Change permissions' },
    { bit: 1024, label: 'Track your camera' },
    { bit: 2048, label: 'Control your camera' },
    { bit: 4096, label: 'Teleport your agent' },
    { bit: 8192, label: 'Join an experience' },
    { bit: 16384, label: 'Silently manage estate access' },
    { bit: 32768, label: 'Override your animations' },
    { bit: 65536, label: 'Return objects on your land' },
    { bit: 131072, label: 'Force sit your avatar' },
    { bit: 262144, label: 'Change environment settings' },
    { bit: 524288, label: 'Privileged land access', caution: true }
  ];

  function describeScriptPermissions(mask) {
    const value = mask >>> 0;
    const lines = [];
    let hasCaution = false;
    SCRIPT_PERMISSION_BITS.forEach(function (perm) {
      if (value & perm.bit) {
        lines.push(perm.label);
        if (perm.caution) hasCaution = true;
      }
    });
    if (!lines.length && value) {
      lines.push('Unknown permission flags (0x' + value.toString(16) + ')');
    }
    return { lines: lines, hasCaution: hasCaution };
  }

  function postScriptQuestionChat(data) {
    if (!data || !data.taskId || !data.itemId) return;
    const name = data.objectName || 'Object';
    const owner = data.objectOwner || '';
    const perm = describeScriptPermissions(data.questions || 0);
    FSErrors.info('script', 'ScriptQuestion from ' + name, false);
    postEventMessage({
      id: FSUtils.uuid(),
      kind: 'script-permission',
      fromId: data.taskId,
      fromName: name,
      text: perm.lines.length
        ? ('Permission request: ' + perm.lines.join('; '))
        : 'Permission request',
      type: 'script',
      source: 'script',
      channel: 0,
      timestamp: Date.now(),
      permission: {
        taskId: data.taskId,
        itemId: data.itemId,
        objectName: name,
        objectOwner: owner,
        questions: data.questions || 0,
        lines: perm.lines,
        hasCaution: perm.hasCaution,
        resolved: false,
        response: ''
      }
    });
  }

  function replyScriptPermission(taskId, itemId, questions) {
    // User-initiated only. Pass 0 to deny; original mask to grant.
    if (!circuit || !circuit.replyScriptPermission || !taskId || !itemId) {
      return Promise.resolve({ sent: false });
    }
    return circuit.replyScriptPermission(taskId, itemId, questions).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  }

  function postInteractivePromptChat(data) {
    if (!data || !data.type) return;
    const type = data.type;
    const badge = data.badge || type;
    const fromName = data.fromName || data.objectName || 'Object';
    FSErrors.info('protocol', badge + ' from ' + fromName, false);
    postEventMessage({
      id: FSUtils.uuid(),
      kind: 'interactive-prompt',
      fromId: data.fromId || '',
      fromName: fromName,
      text: data.text || '',
      type: 'script',
      source: 'script',
      channel: 0,
      timestamp: Date.now(),
      prompt: Object.assign({ resolved: false, response: '' }, data.prompt || {}, {
        type: type
      })
    });
  }

  function postPaymentEvent(data) {
    if (!data) return;
    const note = String(data.description || '').trim();
    if (!note) return;
    if (isDuplicatePayment(data)) return;
    postEventMessage({
      id: FSUtils.uuid(),
      kind: 'payment',
      fromId: '00000000-0000-0000-0000-000000000000',
      fromName: 'Economy',
      text: note,
      type: 'system',
      source: 'economy',
      channel: 0,
      timestamp: Date.now(),
      payment: {
        balance: data.balance,
        description: note,
        transactionType: data.transactionType || 0,
        transactionId: data.transactionId || '',
        seen: false
      }
    });
  }

  function postLoadUrlChat(data) {
    if (!data || !data.url) return;
    const ownerId = data.ownerId || '';
    if (ownerId) queueNameResolve([ownerId]);
    const ownerName = ownerId
      ? pickDisplayName(ownerId, getCachedName(ownerId))
      : '';
    const message = String(data.message || '').trim();
    postInteractivePromptChat({
      type: 'load-url',
      badge: 'LoadURL',
      fromId: data.objectId || '',
      fromName: data.objectName || 'Object',
      text: message || ('Open ' + data.url + '?'),
      prompt: {
        objectId: data.objectId || '',
        objectName: data.objectName || 'Object',
        ownerId: ownerId,
        ownerName: ownerName,
        ownerIsGroup: !!data.ownerIsGroup,
        message: message,
        url: data.url || ''
      }
    });
  }

  function postScriptTeleportChat(data) {
    if (!data) return;
    const region = data.regionName || 'Region';
    const pos = data.position || { x: 128, y: 128, z: 25 };
    postInteractivePromptChat({
      type: 'script-teleport',
      badge: 'Map',
      fromId: '',
      fromName: data.objectName || 'Object',
      text: region + ' (' + Math.round(pos.x) + ', ' + Math.round(pos.y) + ', ' +
        Math.round(pos.z).toFixed(1) + ')',
      prompt: {
        objectName: data.objectName || 'Object',
        regionName: region,
        position: { x: pos.x, y: pos.y, z: pos.z },
        lookAt: data.lookAt || null,
        flags: data.flags || 0
      }
    });
  }

  function postCallingCardOfferChat(data) {
    if (!data || !data.transactionId) return;
    const sourceId = data.sourceId || '';
    if (sourceId) queueNameResolve([sourceId]);
    const fromName = sourceId
      ? pickDisplayName(sourceId, getCachedName(sourceId))
      : 'Someone';
    postInteractivePromptChat({
      type: 'calling-card',
      badge: 'Friend',
      fromId: sourceId,
      fromName: fromName,
      text: fromName + ' offered a friendship card.',
      prompt: {
        sourceId: sourceId,
        destId: data.destId || '',
        transactionId: data.transactionId,
        fromName: fromName
      }
    });
  }

  function acceptCallingCard(transactionId) {
    // User-initiated only.
    if (!circuit || !circuit.acceptCallingCard || !transactionId) {
      return Promise.resolve({ sent: false });
    }
    return circuit.acceptCallingCard(transactionId);
  }

  function declineCallingCard(transactionId) {
    // User-initiated only.
    if (!circuit || !circuit.declineCallingCard || !transactionId) {
      return Promise.resolve({ sent: false });
    }
    return circuit.declineCallingCard(transactionId);
  }

  function isBuddy(agentId) {
    if (!agentId) return false;
    const target = normAgentId(agentId);
    const lists = [FSState.get().buddies || []];
    if (loginData && Array.isArray(loginData.buddies)) {
      lists.push(loginData.buddies);
    }
    for (let i = 0; i < lists.length; i++) {
      if (lists[i].some(function (b) {
        return normAgentId(b.id) === target;
      })) {
        return true;
      }
    }
    return false;
  }

  function offerFriendship(destId) {
    // User-initiated only.
    if (!circuit || !circuit.offerCallingCard || !destId) {
      return Promise.resolve({ sent: false });
    }
    if (isBuddy(destId)) {
      return Promise.resolve({ sent: false, alreadyFriend: true });
    }
    return circuit.offerCallingCard(destId, FSUtils.uuid());
  }

  function payResident(destId, amount, description) {
    // User-initiated only.
    if (!circuit || !circuit.payResident || !destId) {
      return Promise.resolve({ sent: false });
    }
    const value = Math.trunc(amount);
    if (!value || value < 1) {
      return Promise.resolve({ sent: false });
    }
    return circuit.payResident(destId, value, description || '');
  }

  async function searchDirectory(kind, query) {
    if (!circuit || !loginData) return [];
    const text = String(query || '').trim();
    if (!text || text.length < (FSSearchApi.MIN_QUERY_LEN || 3)) return [];
    if (kind === 'avatars') {
      const cap = FSCaps.findCap(regionCaps, 'AvatarPickerSearch');
      const displayCap = displayNamesCapUrl || FSCaps.findCap(regionCaps, 'GetDisplayNames');
      return FSSearchApi.searchAvatars(
        circuit,
        bridge,
        cap,
        displayCap,
        loginData.sessionId || '',
        text
      );
    }
    if (kind === 'places') {
      const results = [];
      const seen = new Set();
      const dests = await FSSearchApi.searchDestinations(getBridgeUrl(), text);
      dests.forEach(function (row) {
        const key = (row.slurl || row.name).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        results.push(row);
      });
      const region = await FSSearchApi.searchRegionByName(getBridgeUrl(), text);
      if (region) {
        const key = ('region:' + region.name).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          results.push(region);
        }
      }
      const dir = await FSSearchApi.searchPlaces(circuit, text);
      dir.forEach(function (row) {
        const key = ('parcel:' + row.parcelId).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        results.push(row);
      });
      return results;
    }
    if (kind === 'groups') {
      return FSSearchApi.searchGroups(circuit, text);
    }
    return [];
  }

  function kickRadarPoll() {
    if (!circuit || !circuit.kickPoll) return;
    circuit.kickPoll();
  }

  function beginRadarSettle() {
    radarSettleUntil = Date.now() + RADAR_SETTLE_MS;
    lastCoarseSelfPos = null;
    lastCoarseSelfAt = 0;
  }

  function shouldApplyRadarUpdate(entries) {
    if (entries && entries.length > 0) return true;
    return Date.now() >= radarSettleUntil;
  }

  function buildRadarEntries(coarse) {
    const locs = coarse.locations || [];
    const agents = coarse.agents || [];
    const youIndex = coarse.youIndex;
    let selfPos = lastCoarseSelfPos || (circuit && circuit.position) || { x: 128, y: 128, z: 25 };
    if (youIndex >= 0 && youIndex < locs.length) {
      const youLoc = locs[youIndex];
      selfPos = { x: youLoc.x, y: youLoc.y, z: youLoc.z };
    }
    const entries = [];
    for (let i = 0; i < locs.length; i++) {
      if (i === youIndex) continue;
      const id = agents[i];
      if (!id || id === loginData.agent.id) continue;
      queueNameResolve([id]);
      const loc = locs[i];
      const pos = { x: loc.x, y: loc.y, z: loc.z };
      const range = Math.round(FSUtils.distance3d(selfPos, pos));
      entries.push(mergeNameFields({
        id: id,
        name: pickDisplayName(id, getCachedName(id)),
        pos: pos,
        range: range,
        age: '?',
        status: ''
      }, getCachedNameInfo(id)));
    }
    return entries;
  }

  function settleAfterRegionArrival(regionName) {
    beginRadarSettle();
    kickRadarPoll();
    postRegionArrivalChat(regionName);
  }

  function parcelStub() {
    const agent = loginData && loginData.agent;
    return {
      localId: 0,
      name: 'Current parcel',
      desc: '',
      area: 0,
      primsUsed: 0,
      primsTotal: 0,
      ownerId: agent ? agent.id : '',
      ownerName: agent ? (agent.displayName || (agent.first + ' ' + agent.last)) : '',
      canEdit: false,
      access: 0,
      pushRestricted: false,
      allowBuild: false,
      allowScripts: true,
      musicUrl: '',
      mediaUrl: '',
      stub: true
    };
  }

  function invalidateParcel() {
    if (!loginData) return;
    if (circuit) circuit._agentParcelLocalId = -1;
    lastHttpParcelAt = 0;
    lastParcelRefreshAt = 0;
    lastParcelEmitSignature = '';
    emit('parcel', parcelStub());
  }

  function scheduleParcelRefreshAfterArrival() {
    setTimeout(function () {
      if (!loginData || sessionLost || pendingTeleportLoc) return;
      refreshParcel().catch(function () { /* land tab will retry */ });
    }, POST_TELEPORT_CAP_BOOTSTRAP_MS + 800);
  }

  function applyPostHandoffSeed(url) {
    const next = cleanCapUrl(url);
    if (!next || !loginData) return;
    loginData.deferredSeedCapability = '';
    teleportFinishReceived = true;
    postTeleportCapGraceUntil = Date.now() + POST_TELEPORT_CAP_GRACE_MS;
    noteSeedUrl(next, 'TeleportFinish');
    if (capBootstrapFallbackTimer) {
      clearTimeout(capBootstrapFallbackTimer);
      capBootstrapFallbackTimer = null;
    }
    const sameSeed = cleanCapUrl(loginData.seedCapability) === next;
    const hadRegionCaps = !!(displayNamesCapUrl || remoteParcelCapUrl);
    if (sameSeed && hadRegionCaps && FSCaps.hasRequiredCaps({
      GetDisplayNames: displayNamesCapUrl,
      RemoteParcelRequest: remoteParcelCapUrl
    })) {
      return;
    }
    loginData.seedCapability = next;
    displayNamesCapUrl = null;
    remoteParcelCapUrl = null;
    eventQueueCapUrl = null;
    FSEventQueue.stop(false, { force: true });
    capBootstrapPromise = null;
    capsReady = false;
    scheduleCapBootstrap(true, { postTeleport: true });
    recoverEventQueueCap('post-handoff').then(function (ok) {
      if (ok && !pendingTeleportLoc) {
        ensureEventQueuePoll('post-handoff');
      }
    });
  }

  function publishTeleportFinish(evt, tpLoc, destPos, regionPayload) {
    if (evt.url) {
      FSErrors.info('caps', 'TeleportFinish seed: ' +
        String(evt.url).replace(/^https?:\/\//i, '').slice(0, 80), false);
    } else {
      FSErrors.info('caps', 'TeleportFinish received (no seed URL in packet)', false);
    }
    const resolvedName = resolveArrivalRegionName(tpLoc, regionPayload, evt.teleportFlags || 0);
    if (resolvedName && loginData && loginData.region) {
      loginData.region.name = resolvedName;
    }
    if (regionPayload && resolvedName) {
      regionPayload.name = resolvedName;
    }
    if (regionPayload) {
      emit('region', regionPayload);
    }
    if (destPos) {
      emitAgentPosition(destPos, 'teleport');
    }
    emit('teleport-finish', {
      url: evt.url || '',
      simIp: evt.simIp || '',
      simPort: evt.simPort || 0,
      regionHandle: evt.regionHandle || null,
      position: destPos,
      region: regionPayload,
      regionName: resolvedName
    });
    const arrivalName = resolvedName ||
      (regionPayload && regionPayload.name) ||
      (circuit && circuit.regionName) ||
      (loginData && loginData.region && loginData.region.name) || '';
    settleAfterRegionArrival(arrivalName);
    scheduleArrivalGridReconcile(resolvedName, evt.teleportFlags || 0, tpLoc);
    invalidateParcel();
    scheduleParcelRefreshAfterArrival();
    markTeleportArrived();
    if (typeof FSEventQueue.setTeleportActive === 'function') {
      FSEventQueue.setTeleportActive(false);
    }
    FSEventQueue.stop(false, { force: true });
    eventQueueWanted = false;
  }

  function applyTeleportState(evt, tpLoc) {
    const destPos = tpLoc
      ? { x: tpLoc.x, y: tpLoc.y, z: tpLoc.z }
      : (loginData && loginData.position ? Object.assign({}, loginData.position) : null);
    let regionPayload = null;
    const grid = resolveArrivalGrid(evt, tpLoc);
    if (grid && loginData && loginData.region) {
      loginData.region.globalX = grid.globalX;
      loginData.region.globalY = grid.globalY;
      loginData.region.x = grid.gridX;
      loginData.region.y = grid.gridY;
      if (tpLoc && tpLoc.regionName && !isPlaceholderRegionName(tpLoc.regionName)) {
        loginData.region.name = tpLoc.regionName;
      }
      regionPayload = {
        name: loginData.region.name,
        id: loginData.region.id,
        globalX: grid.globalX,
        globalY: grid.globalY,
        x: grid.gridX,
        y: grid.gridY
      };
    }
    if (destPos && loginData) {
      loginData.position = destPos;
      if (circuit) circuit.position = destPos;
    }
    return { destPos: destPos, regionPayload: regionPayload };
  }

  async function handleRegionHandoff(evt, label) {
    const flags = evt.teleportFlags || 0;
    if (!pendingTeleportLoc && flags > 0 &&
        shouldBeginSimInitiatedTeleport(flags)) {
      beginSimInitiatedTeleport(flags);
      teleportStartSeen = true;
    }
    const tpLoc = claimPendingTeleportLoc();
    if (!tpLoc) {
      return;
    }
    mergePendingTeleportFlags(flags);
    if (FSTeleport.isWithinRegion(flags) && evt.position) {
      return handleTeleportLocal({
        data: {
          position: evt.position,
          lookAt: evt.lookAt,
          teleportFlags: flags
        }
      });
    }
    if (evt.regionHandle && !tpLoc.toHome &&
        (tpLoc.gridX === undefined || tpLoc.gridY === undefined)) {
      enrichPendingFromRegionHandle(tpLoc, evt.regionHandle);
    }
    if (typeof FSEventQueue.setTeleportActive === 'function') {
      FSEventQueue.setTeleportActive(false);
    }
    FSEventQueue.stop(false, { force: true });
    clearLateTeleportGrace();
    teleportFinishReceived = true;
    pendingTeleportLoc = null;
    clearTeleportTimers();
    FSErrors.info('teleport', label + ' -> ' + (evt.simIp || '?') + ':' + (evt.simPort || '?') +
      teleportFlagNote(flags), false);
    const handoffSeed = evt.url ||
      (loginData && loginData.deferredSeedCapability) || '';
    if (evt.position && circuit) {
      circuit.position = evt.position;
      if (evt.lookAt) circuit.lookAt = evt.lookAt;
    }
    if (circuit && evt.simIp && evt.simPort) {
      const sameSim = loginData.simIp === evt.simIp && loginData.simPort === evt.simPort;
      const circuitLive = circuit.useCircuitAcked && circuit.handshakeDone;
      if (!sameSim || !circuitLive) {
        try {
          await circuit.migrateToSim(evt.simIp, evt.simPort, tpLoc ? {
            position: { x: tpLoc.x, y: tpLoc.y, z: tpLoc.z }
          } : (evt.position ? { position: evt.position, lookAt: evt.lookAt } : null));
          loginData.simIp = evt.simIp;
          loginData.simPort = evt.simPort;
          updateBridgeCircuitContext(circuit._lastLocalPort);
          FSErrors.info('teleport', 'Circuit migrated to ' + evt.simIp + ':' + evt.simPort, false);
        } catch (err) {
          FSErrors.warn('teleport', 'Circuit migration failed: ' + (err.message || String(err)), true);
        }
      } else {
        updateBridgeCircuitContext(circuit._lastLocalPort);
      }
      if (circuit.kickPoll) circuit.kickPoll();
    }
    if (handoffSeed) {
      applyPostHandoffSeed(handoffSeed);
    }
    endTeleportOutboundPause(true);
    agentPlaced = true;
    const applied = applyTeleportState(evt, tpLoc);
    if (circuit && circuit.movementComplete && circuit.movementComplete.position) {
      applied.destPos = {
        x: circuit.movementComplete.position.x,
        y: circuit.movementComplete.position.y,
        z: circuit.movementComplete.position.z
      };
      loginData.position = applied.destPos;
      circuit.position = applied.destPos;
    }
    if (applied.regionPayload) {
      const resolvedName = resolveArrivalRegionName(tpLoc, applied.regionPayload, flags);
      if (resolvedName && !isPlaceholderRegionName(resolvedName)) {
        applied.regionPayload.name = resolvedName;
        loginData.region.name = resolvedName;
      } else if (circuit && circuit.regionName &&
          !isPlaceholderRegionName(circuit.regionName)) {
        applied.regionPayload.name = circuit.regionName;
        loginData.region.name = circuit.regionName;
      }
    }
    publishTeleportFinish(evt, tpLoc, applied.destPos, applied.regionPayload);
    syncHomeRegionFromArrival(tpLoc);
    syncHomeFromTeleportFlags(flags, evt.regionHandle, applied.destPos);
  }

  async function handleTeleportFinish(evt) {
    return handleRegionHandoff(evt, 'TeleportFinish');
  }

  async function handleCrossedRegion(evt) {
    if (!pendingTeleportLoc) return;
    return handleRegionHandoff(evt, 'CrossedRegion');
  }

  function teleportFlagNote(flags) {
    const f = flags >>> 0;
    if (!f) return '';
    return ' flags=' + f + ' (' + FSTeleport.describeTeleportFlags(f) + ')';
  }

  function mergePendingTeleportFlags(flags) {
    if (!pendingTeleportLoc) return;
    const next = flags >>> 0;
    if (!next) return;
    pendingTeleportLoc.flags = (pendingTeleportLoc.flags || 0) | next;
  }

  function destinationRegionHandle(tpLoc) {
    if (!tpLoc) return 0n;
    if (tpLoc.globalX !== undefined && tpLoc.globalY !== undefined) {
      return FSSlurl.toRegionHandle(tpLoc.globalX, tpLoc.globalY);
    }
    if (tpLoc.gridX !== undefined && tpLoc.gridY !== undefined) {
      return FSSlurl.gridToRegionHandle(tpLoc.gridX, tpLoc.gridY);
    }
    return 0n;
  }

  function handleEnableSimulator(evt) {
    const data = evt.data;
    if (!circuit || !data || !data.simIp || !data.simPort || !pendingTeleportLoc) {
      return;
    }
    const destHandle = destinationRegionHandle(pendingTeleportLoc);
    const incoming = BigInt(data.regionHandle || 0);
    if (destHandle > 0n && incoming > 0n && incoming !== destHandle) {
      FSErrors.info('teleport',
        'EnableSimulator handle mismatch (got ' + incoming.toString() +
          ', expected ' + destHandle.toString() + ') - still enabling ' +
          data.simIp + ':' + data.simPort,
        false);
    }
    const key = data.simIp + ':' + data.simPort;
    if (enabledSimulators.has(key)) {
      return;
    }
    enabledSimulators.add(key);
    FSErrors.info('teleport', 'EnableSimulator -> ' + key, false);
    circuit.sendUseCircuitCodeTo(data.simIp, data.simPort).then(function () {
      if (circuit.kickPoll) circuit.kickPoll();
      if (circuit.pulseCircuit) {
        return circuit.pulseCircuit().catch(function () { /* ignore */ });
      }
    }).catch(function (err) {
      FSErrors.warn('teleport', 'EnableSimulator UseCircuitCode failed: ' + (err.message || String(err)), false);
    });
    kickEventQueueForTeleport('enable-simulator');
  }

  function handleEstablishAgentCommunication(eac) {
    if (!eac || !loginData) return;
    const destEndpoint = (eac.simIp && eac.simPort)
      ? (eac.simIp + ':' + eac.simPort)
      : (eac.simHost || '?');
    FSErrors.info('teleport', 'EstablishAgentCommunication (EventQueue) -> ' + destEndpoint +
      (eac.url ? ' seed=yes' : ''), false);
    if (eac.url) {
      const seed = cleanCapUrl(eac.url);
      if (pendingTeleportLoc) {
        loginData.deferredSeedCapability = seed;
        noteSeedUrl(seed, 'EstablishAgentCommunication (deferred)');
      } else if (shouldAcceptIdleSeed(seed, 'EstablishAgentCommunication')) {
        onSeedCapability(seed);
      } else {
        FSErrors.info('caps',
          'Ignoring EstablishAgentCommunication seed (session stable)', false);
      }
    }
    if (eac.simIp && eac.simPort && pendingTeleportLoc) {
      handleEnableSimulator({
        type: 'enable-simulator',
        data: {
          simIp: eac.simIp,
          simPort: eac.simPort,
          regionHandle: destinationRegionHandle(pendingTeleportLoc)
        }
      });
    }
  }

  function handleTeleportLocal(evt) {
    const data = evt.data || {};
    const flags = data.teleportFlags || 0;
    if (!pendingTeleportLoc && FSTeleport.shouldFollowRemoteTeleportStart(flags)) {
      beginSimInitiatedTeleport(flags, { position: data.position });
      teleportStartSeen = true;
    }
    const tpLoc = pendingTeleportLoc;
    mergePendingTeleportFlags(flags);
    clearTeleportPending(true);
    FSErrors.info('teleport', 'TeleportLocal @ ' +
      Math.round((data.position && data.position.x) || 0) + ',' +
      Math.round((data.position && data.position.y) || 0) + ',' +
      Math.round((data.position && data.position.z) || 0) +
      teleportFlagNote(flags), false);
    if (data.position && circuit) {
      circuit.position = data.position;
      loginData.position = data.position;
    }
    if (data.lookAt && circuit) {
      circuit.lookAt = data.lookAt;
    }
    agentPlaced = true;
    const handle = tpLoc
      ? destinationRegionHandle(tpLoc)
      : (loginData && loginData.region
        ? FSSlurl.toRegionHandle(loginData.region.globalX, loginData.region.globalY)
        : null);
    syncHomeFromTeleportFlags(flags, handle, data.position);
    const applied = applyTeleportState({ regionHandle: handle }, tpLoc);
    publishTeleportFinish({
      url: loginData ? (loginData.seedCapability || '') : '',
      simIp: loginData ? loginData.simIp : '',
      simPort: loginData ? loginData.simPort : 0,
      regionHandle: handle,
      teleportFlags: flags
    }, tpLoc, applied.destPos, applied.regionPayload);
    if (circuit && circuit.kickPoll) circuit.kickPoll();
  }

  function updateBridgeCircuitContext(localPort) {
    if (!bridge) return;
    const port = localPort || (circuit && circuit._lastLocalPort) || circuitLocalPort || 0;
    const simIp = (loginData && (loginData.simIp || loginData.sim_ip)) || '';
    const agentSessionId = (loginData && loginData.sessionId) || '';
    bridge.setCircuitContext(circuitSessionId, port, simIp, agentSessionId);
  }

  function applyLoginSeedCaps(seedCaps) {
    if (!seedCaps || !seedCaps.ok) return false;
    let caps = null;
    if (seedCaps.caps && typeof seedCaps.caps === 'object') {
      caps = seedCaps.caps;
    } else if (seedCaps.body) {
      caps = FSCaps.parseSeedGrant(seedCaps.body, seedCaps.contentType);
    }
    if (!caps || !Object.keys(caps).length) {
      const hint = (seedCaps.capKeys || []).slice(0, 12).join(', ');
      FSErrors.warn('caps', 'Login seed unreadable' + (hint ? ' (keys: ' + hint + ')' : ''), false);
      return false;
    }
    if (!FSCaps.hasRequiredCaps(caps)) {
      const keys = Object.keys(caps || []);
      FSErrors.warn('caps', 'Login seed partial (' + keys.length + ' caps): ' +
        keys.slice(0, 10).join(', '), false);
      return false;
    }
    applyCapGrant(caps, 'login bridge');
    return true;
  }

  function seedHostHint() {
    const seed = cleanCapUrl(loginData && loginData.seedCapability);
    if (!seed) return '';
    try {
      return new URL(seed).host;
    } catch (_e) {
      return seed.slice(0, 48);
    }
  }

  function rememberGoodSeedCapability() {
    const seed = cleanCapUrl(loginData && loginData.seedCapability);
    if (seed && eventQueueCapUrl) {
      lastGoodSeedCapability = seed;
    }
  }

  function restoreGoodSeedCapability(source) {
    const good = cleanCapUrl(lastGoodSeedCapability);
    const current = cleanCapUrl(loginData && loginData.seedCapability);
    if (!good || good === current || !loginData) return false;
    loginData.seedCapability = good;
    FSErrors.info('caps',
      'Restored last good seed capability (' + (source || 'recovery') + ')', false);
    return true;
  }

  function shouldAcceptIdleSeed(url, source) {
    if (!loginData || pendingTeleportLoc) return true;
    const next = cleanCapUrl(url);
    if (!next) return false;
    const current = cleanCapUrl(loginData.seedCapability);
    if (current && current === next) return false;
    if (!capsReady || !eventQueueCapUrl) return true;
    if (Date.now() < postTeleportCapGraceUntil &&
        (!eventQueueCapUrl || !displayNamesCapUrl)) {
      return true;
    }
    return false;
  }

  async function ensureTeleportHandoffReady(source) {
    if (eventQueueCapUrl) {
      kickEventQueueForTeleport(source);
      return true;
    }
    let ok = await recoverEventQueueCap(source);
    if (ok) {
      kickEventQueueForTeleport(source);
      return true;
    }
    if (!capsReady) {
      try {
        await bootstrapRegionCaps(true);
      } catch (_e) { /* retry below */ }
    }
    if (!eventQueueCapUrl) {
      ok = await recoverEventQueueCap((source || 'teleport') + ' retry');
    }
    if (ok) {
      kickEventQueueForTeleport(source);
      return true;
    }
    FSErrors.warn('eventqueue',
      'EventQueueGet unavailable - teleport handoff may stall until caps recover', true);
    return false;
  }

  function noteCapBootstrapError(err) {
    const msg = err && err.message ? err.message : String(err);
    lastCapError = msg;
    if (msg === lastCapErrorNote) return;
    lastCapErrorNote = msg;
    const port = bridge && bridge.udpListenPort ? bridge.udpListenPort : 0;
    const seed = cleanCapUrl(loginData && loginData.seedCapability);
    let text = 'Capability bootstrap failed: ' + msg;
    if (seed) {
      text += ' (seed: ' + seed.replace(/^https?:\/\//i, '').slice(0, 80) + ')';
    }
    if (!port) text += ' [no UDP listen port yet]';
    if (!agentPlaced) text += ' [agent not placed yet]';
    const postTeleportGrace = Date.now() < postTeleportCapGraceUntil;
    const retryable404 = /404|cap not found/i.test(msg);
    if (retryable404 && restoreGoodSeedCapability('cap bootstrap 404')) {
      FSErrors.info('caps', text + ' (restored last good seed)', false);
      if (!pendingTeleportLoc) {
        scheduleCapBootstrap(true);
      }
      return;
    }
    if (postTeleportGrace && retryable404) {
      FSErrors.info('caps', text + ' (retrying after region handoff)', false);
      return;
    }
    FSErrors.error('caps', text, true);
  }

  function noteSeedUrl(url, source) {
    const next = cleanCapUrl(url);
    if (!next) return;
    let host = '';
    try {
      host = new URL(next).host;
    } catch (_e) {
      host = next.slice(0, 64);
    }
    FSErrors.info('caps', 'Seed URL (' + (source || 'sim') + '): ' + host, false);
    if (source === 'bootstrap' || source === 'login') {
      FSErrors.info('caps', 'Seed endpoint: ' + next.replace(/^https?:\/\//i, '').slice(0, 96), false);
    }
    lastSeedHost = host;
  }

  function noteCapBootstrapStart(seed) {
    const port = bridge && bridge.udpListenPort ? bridge.udpListenPort : 0;
    const host = seedHostHint();
    let text = 'Requesting region caps from ' + (host || 'seed');
    if (port) text += ' (UDP port ' + port + ')';
    else text += ' [no UDP listen port]';
    if (!agentPlaced) text += ' [awaiting agent placement]';
    FSErrors.info('caps', text, false);
  }

  function scheduleCapRetry(delayMs) {
    if (capBootstrapRetryTimer) return;
    capBootstrapRetryTimer = setTimeout(function () {
      capBootstrapRetryTimer = null;
      if (!displayNamesCapUrl) {
        capBootstrapPromise = null;
        capsReady = false;
        scheduleCapBootstrap(true);
      }
      if (!eventQueueCapUrl) {
        recoverEventQueueCap('cap retry').then(function (ok) {
          if (ok && eventQueueWanted && !pendingTeleportLoc) {
            ensureEventQueuePoll('eq recover after cap retry');
          }
        });
      }
    }, delayMs || 8000);
  }

  function scheduleCapBootstrap(force, options) {
    const opts = options || {};
    if (pendingTeleportLoc) return;
    if (capsReady && !force) return;
    if (capBootstrapTimer) {
      clearTimeout(capBootstrapTimer);
      capBootstrapTimer = null;
    }
    const delay = opts.postTeleport
      ? POST_TELEPORT_CAP_BOOTSTRAP_MS
      : (force ? 100 : 500);
    capBootstrapTimer = setTimeout(function () {
      capBootstrapTimer = null;
      updateBridgeCircuitContext();
      if (!bridge || !circuitSessionId) {
        capBootstrapTimer = setTimeout(function () { scheduleCapBootstrap(force); }, 400);
        return;
      }
      if (!circuitReady) {
        capBootstrapTimer = setTimeout(function () { scheduleCapBootstrap(force); }, 400);
        return;
      }
      if (circuit && !circuit.handshakeDone && !force) {
        capBootstrapTimer = setTimeout(function () { scheduleCapBootstrap(force); }, 400);
        return;
      }
      if (circuit && !circuit.useCircuitAcked) {
        capBootstrapTimer = setTimeout(function () { scheduleCapBootstrap(force); }, 400);
        return;
      }
      if (!agentPlaced && !force) {
        capBootstrapTimer = setTimeout(function () { scheduleCapBootstrap(force); }, 400);
        return;
      }
      bootstrapRegionCaps(!!force).then(function (caps) {
        const keys = Object.keys(caps || {});
        const hasPresence = !!displayNamesCapUrl;
        capsReady = hasPresence;
        let note = hasPresence
          ? ('Presence capabilities ready (' + keys.length + ' caps).')
          : ('Partial seed caps only (' + keys.length + '). Retrying...');
        if (!displayNamesCapUrl) note += ' Names via sim lookup.';
        systemNote(note);
        if (!hasPresence) {
          scheduleCapRetry(6000);
        }
      }).catch(function (err) {
        console.warn('Cap bootstrap failed:', err);
        capsReady = false;
        noteCapBootstrapError(err);
        scheduleCapRetry(10000);
      });
    }, delay);
  }

  function applyCapGrant(caps, source) {
    regionCaps = caps || {};
    displayNamesCapUrl = FSCaps.findCap(caps, 'GetDisplayNames');
    remoteParcelCapUrl = FSCaps.findCap(caps, 'RemoteParcelRequest');
    rememberEventQueueCap(caps);
    capsReady = FSCaps.hasPresenceCaps(caps);
    rememberGoodSeedCapability();
    if (pendingTeleportLoc) {
      kickEventQueueForTeleport(source || 'caps during teleport');
    } else {
      ensureEventQueuePoll(source || 'caps');
    }
    if (capsReady) {
      lastCapError = '';
      lastCapErrorNote = '';
      const count = Object.keys(caps || {}).length;
      FSErrors.info('caps', 'Region caps ready (' + count + ')' +
        (source ? ' via ' + source : '') + '.', true);
    }
    return caps;
  }

  function handleEventQueueMessage(ev) {
    const name = String((ev && ev.message) || (ev && ev.Message) || '');
    const body = (ev && ev.body) || {};
    if (!name) return;
    if (pendingTeleportLoc && name !== 'ParcelProperties') {
      FSErrors.info('eventqueue', 'EventQueue during teleport: ' + name, false);
    }

    if (name === 'TeleportFinish') {
      const tf = FSEventQueue.parseTeleportFinish(body);
      FSErrors.info('teleport', 'TeleportFinish (EventQueue) -> ' +
        (tf.simIp || '?') + ':' + (tf.simPort || '?') + teleportFlagNote(tf.teleportFlags || 0), false);
      handleTeleportFinish({
        type: 'teleport-finish',
        url: tf.url,
        simIp: tf.simIp,
        simPort: tf.simPort,
        regionHandle: tf.regionHandle,
        teleportFlags: tf.teleportFlags || 0
      });
      return;
    }
    if (name === 'TeleportFailed') {
      const fail = FSEventQueue.parseTeleportFailed(body);
      if (!pendingTeleportLoc && !teleportStartSeen) {
        FSErrors.warn('teleport', 'TeleportFailed (EventQueue, idle): ' + (fail.reason || 'unknown'), false);
        return;
      }
      failTeleport(fail.reason || 'Teleport failed', 'EventQueue');
      return;
    }
    if (name === 'CrossedRegion') {
      const cr = FSEventQueue.parseCrossedRegion(body);
      FSErrors.info('teleport', 'CrossedRegion (EventQueue) -> ' +
        (cr.simIp || '?') + ':' + (cr.simPort || '?'), false);
      handleCrossedRegion({
        type: 'crossed-region',
        url: cr.url,
        simIp: cr.simIp,
        simPort: cr.simPort,
        regionHandle: cr.regionHandle,
        position: cr.position,
        lookAt: cr.lookAt
      });
      return;
    }
    if (name === 'EnableSimulator') {
      if (!pendingTeleportLoc) {
        return;
      }
      const es = FSEventQueue.parseEnableSimulator(body);
      handleEnableSimulator({
        type: 'enable-simulator',
        data: es
      });
      return;
    }
    if (name === 'EstablishAgentCommunication') {
      handleEstablishAgentCommunication(FSEventQueue.parseEstablishAgentCommunication(body));
      return;
    }
    if (name === 'ParcelProperties') {
      const parcel = FSEventQueue.parseParcelProperties(body);
      if (!parcel) return;
      parcelPacketCount++;
      if (circuit && parcel.localId >= 0) {
        circuit._agentParcelLocalId = parcel.localId;
      }
      emitParcelFromData(parcel, 'eventqueue');
      return;
    }
    if (pendingTeleportLoc) {
      FSErrors.info('eventqueue', 'Unhandled EventQueue during teleport: ' + name, false);
    }
  }

  async function recoverEventQueueCap(source) {
    if (eventQueueCapUrl) return true;
    if (!bridge || !loginData) return false;
    const seed = cleanCapUrl(loginData.seedCapability);
    if (!seed) return false;
    if (eventQueueRecoverPromise) {
      return eventQueueRecoverPromise;
    }
    eventQueueRecoverPromise = (async function () {
      updateBridgeCircuitContext();
      if (capBootstrapPromise) {
        try {
          const caps = await capBootstrapPromise;
          rememberEventQueueCap(caps);
          if (eventQueueCapUrl) return true;
        } catch (_e) { /* full bootstrap will retry */ }
      }
      const attempts = [
        { pinSimIp: true, grantRounds: 2 },
        { pinSimIp: false, grantRounds: 2 },
        { pinSimIp: false, grantRounds: 3 },
        { pinSimIp: true, grantRounds: 3 }
      ];
      for (let i = 0; i < attempts.length; i++) {
        if (circuit && circuit.pulseCircuit) {
          await circuit.pulseCircuit().catch(function () { /* ignore */ });
        }
        updateBridgeCircuitContext();
        try {
          const caps = await FSCaps.fetchCapabilities(
            bridge,
            seed,
            FSCaps.EVENTQUEUE_CAP_NAMES,
            Object.assign({
              agentSessionId: (loginData && loginData.sessionId) || ''
            }, attempts[i])
          );
          rememberEventQueueCap(caps);
          if (eventQueueCapUrl) {
            FSErrors.info('eventqueue',
              'EventQueueGet recovered (' + (source || 'handoff') + ')', false);
            return true;
          }
        } catch (_err) {
          if (i + 1 < attempts.length) {
            await new Promise(function (resolve) {
              setTimeout(resolve, 700 + i * 900);
            });
          }
        }
      }
      return false;
    })().finally(function () {
      eventQueueRecoverPromise = null;
    });
    return eventQueueRecoverPromise;
  }

  function kickEventQueueForTeleport(source) {
    eventQueueWanted = true;
    if (eventQueueCapUrl) {
      return ensureEventQueueHandoffPoll(source);
    }
    recoverEventQueueCap(source).then(function (ok) {
      if (!pendingTeleportLoc) return;
      if (ok) {
        ensureEventQueueHandoffPoll(source);
      } else {
        FSErrors.warn('eventqueue',
          'EventQueueGet unavailable - teleport handoff may stall until caps recover', true);
      }
    });
    return false;
  }

  function rememberEventQueueCap(caps) {
    const url = FSCaps.findCap(caps || {}, 'EventQueueGet');
    if (url) {
      eventQueueCapUrl = url;
    }
  }

  function noteUdpRecv(count) {
    const n = count || 1;
    if (n <= 0) return;
    const wasZero = udpPacketsReceived === 0;
    udpPacketsReceived += n;
    if (wasZero && !udpRecvLogged) {
      udpRecvLogged = true;
      FSErrors.info('circuit', 'UDP receive active (' + n + ' packet(s))', false);
    }
  }

  function scheduleCircuitServicesOnce(source) {
    if (circuitServicesStarted) return;
    circuitServicesStarted = true;
    setTimeout(function () {
      if (circuit && circuit.kickPoll) {
        circuit.kickPoll();
      }
      flushNameResolve();
    }, CIRCUIT_SERVICES_DELAY_MS);
  }

  async function ensureLandCaps() {
    if (remoteParcelCapUrl) return true;
    if (capBootstrapPromise) {
      try {
        await capBootstrapPromise;
      } catch (_e) { /* bootstrap will retry */ }
      if (remoteParcelCapUrl) return true;
    }
    const seed = cleanCapUrl(loginData && loginData.seedCapability);
    if (!seed || !bridge) return false;
    if (landCapsPromise) return landCapsPromise;
    landCapsPromise = (async function () {
      try {
        updateBridgeCircuitContext();
        const caps = await FSCaps.fetchCapabilities(bridge, seed, FSCaps.LAND_CAP_NAMES, {
          grantRounds: 2,
          agentSessionId: (loginData && loginData.sessionId) || ''
        });
        remoteParcelCapUrl = FSCaps.findCap(caps, 'RemoteParcelRequest') || remoteParcelCapUrl;
        if (remoteParcelCapUrl) {
          FSErrors.info('caps', 'Land capabilities ready.', false);
        }
        return !!remoteParcelCapUrl;
      } catch (err) {
        const msg = err.message || String(err);
        const postTeleportGrace = Date.now() < postTeleportCapGraceUntil;
        if (postTeleportGrace && /404|cap not found/i.test(msg)) {
          FSErrors.info('parcel', 'Land cap grant pending after teleport (will retry)', false);
        } else {
          FSErrors.warn('parcel', 'Land cap grant failed: ' + msg, false);
        }
        return false;
      } finally {
        landCapsPromise = null;
      }
    })();
    return landCapsPromise;
  }

  function ensureEventQueueHandoffPoll(source) {
    if (!eventQueueCapUrl || !bridge) return false;
    if (!circuitReady || !circuit || !circuit.handshakeDone) return false;
    eventQueueWanted = true;
    if (typeof FSEventQueue.setTeleportActive === 'function') {
      FSEventQueue.setTeleportActive(true);
    }
    if (!FSEventQueue.isRunning()) {
      FSEventQueue.start(bridge, eventQueueCapUrl, handleEventQueueMessage);
      if (source) {
        FSErrors.info('eventqueue', 'EventQueueGet polling (' + source + ')', false);
      }
      return true;
    }
    if (typeof FSEventQueue.restartForHandoff === 'function') {
      FSEventQueue.restartForHandoff();
    }
    if (source) {
      FSErrors.info('eventqueue', 'EventQueue handoff poll active (' + source + ')', false);
    }
    return true;
  }

  function ensureEventQueuePoll(source) {
    if (!eventQueueCapUrl || !bridge) return false;
    if (!circuitReady || !circuit || !circuit.handshakeDone) return false;
    if (capBootstrapPromise && !pendingTeleportLoc) return false;
    eventQueueWanted = true;
    if (typeof FSEventQueue.setTeleportActive === 'function') {
      FSEventQueue.setTeleportActive(!!pendingTeleportLoc);
    }
    if (FSEventQueue.isRunning()) return true;
    FSEventQueue.stop(false);
    FSEventQueue.start(bridge, eventQueueCapUrl, handleEventQueueMessage);
    if (source) {
      FSErrors.info('eventqueue', 'EventQueueGet polling (' + source + ')', false);
    }
    return true;
  }

  function restartEventQueuePollNow(source) {
    ensureEventQueuePoll(source);
  }

  function scheduleEventQueueRestart(source, delayMs) {
    if (eventQueueRestartTimer) {
      clearTimeout(eventQueueRestartTimer);
      eventQueueRestartTimer = null;
    }
    eventQueueRestartTimer = setTimeout(function () {
      eventQueueRestartTimer = null;
      restartEventQueuePollNow(source);
    }, delayMs !== undefined ? delayMs : 2500);
  }

  function startEventQueuePollIfReady(source) {
    if (!eventQueueCapUrl || !bridge) return;
    if (!circuitReady || !circuit || !circuit.handshakeDone) return;
    if (capBootstrapPromise && !pendingTeleportLoc) return;
    if (FSEventQueue.isRunning()) {
      if (typeof FSEventQueue.setTeleportActive === 'function') {
        FSEventQueue.setTeleportActive(!!pendingTeleportLoc);
      }
      return;
    }
    eventQueueWanted = true;
    scheduleEventQueueRestart(source, 0);
    if (source) {
      FSErrors.info('eventqueue', 'EventQueueGet polling (' + source + ')', false);
    }
  }

  function restartEventQueuePoll(source) {
    scheduleEventQueueRestart(source, 2500);
  }

  async function bootstrapLoginCapsBeforeCircuit() {
    const seed = cleanCapUrl(loginData && loginData.seedCapability);
    if (!seed || !bridge || capsReady) return null;
    bridge.setCircuitContext('', 0, loginData.simIp || '', loginData.sessionId || '');
    noteSeedUrl(seed, 'login');
    FSErrors.info('caps', 'Requesting login seed caps (before UDP circuit)...', false);
    const baseOpts = {
      preCircuit: true,
      agentSessionId: loginData.sessionId || ''
    };
    const attempts = [
      Object.assign({ pinSimIp: false, grantRounds: 3 }, baseOpts),
      Object.assign({ pinSimIp: true, grantRounds: 2 }, baseOpts)
    ];
    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        const caps = await FSCaps.fetchCapabilities(bridge, seed, FSCaps.PRESENCE_CAP_NAMES, attempts[i]);
        return applyCapGrant(caps, 'login seed');
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) {
      FSErrors.warn('caps', 'Pre-circuit seed grant failed: ' + (lastErr.message || String(lastErr)), false);
    }
    return null;
  }

  async function bootstrapRegionCaps(force) {
    const seed = cleanCapUrl(loginData && loginData.seedCapability);
    if (!seed || !bridge) {
      const msg = !seed ? 'No seed capability URL from login' : 'Bridge unavailable for caps';
      lastCapError = msg;
      throw new Error(msg);
    }
    if (pendingTeleportLoc) {
      return {
        GetDisplayNames: displayNamesCapUrl,
        RemoteParcelRequest: remoteParcelCapUrl
      };
    }
    if (!force && displayNamesCapUrl) {
      return { GetDisplayNames: displayNamesCapUrl, RemoteParcelRequest: remoteParcelCapUrl };
    }
    if (capBootstrapPromise) {
      return capBootstrapPromise;
    }
    noteSeedUrl(seed, 'bootstrap');
    noteCapBootstrapStart(seed);
    if (!pendingTeleportLoc) {
      FSEventQueue.stop(false);
    }
    capBootstrapPromise = (async function () {
      let lastErr = null;
      const postTeleport = Date.now() < postTeleportCapGraceUntil;
      const maxAttempts = postTeleport ? 5 : 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (circuit && circuit.pulseCircuit) {
          await circuit.pulseCircuit();
        }
        updateBridgeCircuitContext();
        try {
          return await FSCaps.fetchCapabilities(bridge, seed, FSCaps.PRESENCE_CAP_NAMES, {
            grantRounds: attempt === 0 ? 3 : 2,
            agentSessionId: (loginData && loginData.sessionId) || '',
            pinSimIp: attempt % 2 === 0
          });
        } catch (err) {
          lastErr = err;
          const retryable = /404|cap not found/i.test(err.message || String(err));
          if (attempt + 1 < maxAttempts) {
            const waitMs = retryable
              ? (1000 + attempt * 1500)
              : (400 + attempt * 400);
            await new Promise(function (resolve) {
              setTimeout(resolve, waitMs);
            });
            continue;
          }
          throw err;
        }
      }
      throw lastErr || new Error('Seed capability grant failed');
    })().then(function (caps) {
      return applyCapGrant(caps, 'in-world seed');
    }).catch(function (err) {
      lastCapError = err.message || String(err);
      throw err;
    }).finally(function () {
      capBootstrapPromise = null;
    });
    return capBootstrapPromise;
  }

  function invalidateRegionCaps(source) {
    if (!loginData) return;
    displayNamesCapUrl = null;
    remoteParcelCapUrl = null;
    eventQueueCapUrl = null;
    FSEventQueue.stop(false, { force: true });
    capBootstrapPromise = null;
    capsReady = false;
    if (source) {
      FSErrors.info('caps', 'Region caps invalidated (' + source + ')', false);
    }
    scheduleCapBootstrap(true);
  }

  function handleUnresolvedPacket(evt) {
    if (!evt || !evt.name) return;
    if (/^(Low|Medium|High)_\d+$/.test(evt.name)) return;
    const key = evt.name + ':' + (evt.template || '?');
    if (unresolvedPacketSeen.has(key)) return;
    unresolvedPacketSeen.add(key);
    const label = evt.name + ' (tpl=' + (evt.template || '?') + ')';
    if (evt.teleportWatch || pendingTeleportLoc) {
      FSErrors.warn('teleport', 'Unhandled UDP during teleport: ' + label, false);
      return;
    }
    FSErrors.info('protocol', 'Unhandled UDP: ' + label, false);
  }

  function handleCircuitTimeout(evt) {
    if (sessionLost) return;
    const idleSec = evt && evt.idleMs ? Math.round(evt.idleMs / 1000) : 100;
    const target = (evt && evt.target) ? (' on ' + evt.target) : '';
    handleSessionLost(
      'No simulator activity for ' + idleSec + 's' + target +
        '. The connection may have timed out.',
      'circuit-timeout'
    );
  }

  function handleStalledTeleportTimeout(reason) {
    invalidateRegionCaps('teleport timeout');
    clearTeleportPending(true, { stashLateGrace: true });
    emit('teleport-failed', {
      reason: reason,
      stalled: true,
      source: 'teleport-stall'
    });
    FSEventQueue.stop(false, { force: true });
    eventQueueWanted = false;
    ensureEventQueuePoll('teleport stall recovery');
    FSErrors.warn('teleport',
      'Teleport stalled: the simulator never finished the handoff. You can retry from the map or return to login.',
      true);
  }

  function onSeedCapability(url) {
    const next = cleanCapUrl(url);
    if (!next || !loginData) return;
    if (pendingTeleportLoc) {
      loginData.deferredSeedCapability = next;
      noteSeedUrl(next, 'seed (deferred during teleport)');
      return;
    }
    if (!shouldAcceptIdleSeed(next, 'seed-capability')) {
      FSErrors.info('caps', 'Ignoring idle seed-capability update (session stable)', false);
      return;
    }
    teleportFinishReceived = true;
    noteSeedUrl(next, 'TeleportFinish');
    if (capBootstrapFallbackTimer) {
      clearTimeout(capBootstrapFallbackTimer);
      capBootstrapFallbackTimer = null;
    }
    const sameSeed = cleanCapUrl(loginData.seedCapability) === next;
    const hadRegionCaps = !!(displayNamesCapUrl || remoteParcelCapUrl);
    if (sameSeed && hadRegionCaps && FSCaps.hasRequiredCaps({
      GetDisplayNames: displayNamesCapUrl,
      RemoteParcelRequest: remoteParcelCapUrl
    })) {
      return;
    }
    loginData.seedCapability = next;
    displayNamesCapUrl = null;
    remoteParcelCapUrl = null;
    eventQueueCapUrl = null;
    FSEventQueue.stop(false, { force: true });
    capBootstrapPromise = null;
    capsReady = false;
    scheduleCapBootstrap(true);
  }

  async function ensureDisplayNamesCap() {
    if (displayNamesCapUrl) return displayNamesCapUrl;
    if (!capsReady) {
      await bootstrapRegionCaps(true);
    } else {
      await bootstrapRegionCaps();
    }
    return displayNamesCapUrl || '';
  }

  function pickDisplayName(id, candidate) {
    const cached = getCachedName(id);
    if (cached) return cached;
    if (candidate && !looksUnresolvedName(candidate, id)) return candidate;
    return (id || '').slice(0, 8) + '...';
  }

  function scheduleNameResolveRetry() {
    if (nameResolveRetryTimer) return;
    nameResolveRetryTimer = setTimeout(function () {
      nameResolveRetryTimer = null;
      const radar = FSState.get().radar || [];
      radar.forEach(function (entry) {
        if (entry && entry.id && !isNameFullyResolved(entry.id)) {
          pendingNameIds.add(entry.id);
        }
      });
      if (pendingNameIds.size > 0) {
        flushNameResolve();
        scheduleNameResolveRetry();
      }
    }, 5000);
  }

  async function flushNameResolve() {
    nameResolveTimer = null;
    if (!loginData || pendingNameIds.size === 0 || nameResolveInFlight || pendingTeleportLoc) {
      return;
    }
    const ids = Array.from(pendingNameIds).filter(function (id) {
      return !isNameFullyResolved(id);
    });
    pendingNameIds.clear();
    if (!ids.length) return;

    nameResolveInFlight = true;
    let changed = false;
    try {
      if (displayNamesCapUrl) {
        try {
          const displayCap = await ensureDisplayNamesCap();
          if (displayCap) {
            const resolved = await FSCaps.resolveAgentNames(bridge, displayCap, ids);
            let newlyResolved = 0;
            ids.forEach(function (id) {
              const key = normAgentId(id);
              const record = resolved[key];
              const before = getCachedNameInfo(id);
              if (record) {
                cacheNameInfo(id, {
                  displayName: record.displayName,
                  userName: record.userName,
                  label: record.label,
                  nameLookupDone: true
                });
                if (!before || before.label !== record.label ||
                    before.displayName !== record.displayName) {
                  newlyResolved++;
                }
                changed = true;
              } else if (before && !looksUnresolvedName(before.label, id)) {
                cacheNameInfo(id, Object.assign({}, before, { nameLookupDone: true }));
              }
            });
            if (newlyResolved > 0) {
              FSErrors.info('names', 'GetDisplayNames resolved ' + newlyResolved +
                ' new name(s)', false);
            }
          }
        } catch (httpErr) {
          console.warn('HTTP display name lookup failed:', httpErr);
        }
      }
      const unresolved = ids.filter(function (id) {
        return !isNameFullyResolved(id);
      });
      if (unresolved.length && circuit && circuit.requestUuidNames) {
        await circuit.requestUuidNames(unresolved);
        scheduleNameResolveRetry();
      }
      if (changed) {
        refreshNamedEntities();
      }
    } catch (err) {
      console.warn('Display name lookup failed:', err);
      ids.forEach(function (id) { pendingNameIds.add(id); });
      nameResolveTimer = setTimeout(function () { flushNameResolve(); }, 2000);
    } finally {
      nameResolveInFlight = false;
      if (pendingNameIds.size > 0 && !nameResolveTimer) {
        nameResolveTimer = setTimeout(function () { flushNameResolve(); }, 250);
      }
    }
  }

  function queueNameResolve(ids) {
    (ids || []).forEach(function (id) {
      if (id && !isNameFullyResolved(id)) pendingNameIds.add(id);
    });
    if (!circuitServicesStarted) return;
    if (!nameResolveTimer) {
      nameResolveTimer = setTimeout(function () { flushNameResolve(); }, 250);
    }
  }

  function removeBuddy(agentId) {
    if (!loginData || !Array.isArray(loginData.buddies) || !agentId) return;
    const target = normAgentId(agentId);
    const before = loginData.buddies.length;
    loginData.buddies = loginData.buddies.filter(function (b) {
      return normAgentId(b.id) !== target;
    });
    if (loginData.buddies.length === before) return;
    emit('buddies-updated', loginData.buddies);
  }

  function updateBuddyPresence(agentIds, online) {
    if (!loginData || !Array.isArray(loginData.buddies) || !agentIds || !agentIds.length) {
      return;
    }
    const targets = new Set(agentIds.map(normAgentId));
    let changed = false;
    const buddies = loginData.buddies.map(function (b) {
      if (!targets.has(normAgentId(b.id))) return b;
      if (!!b.online === online) return b;
      changed = true;
      const next = Object.assign({}, b, { online: online });
      if (!online) next.region = '';
      return next;
    });
    if (!changed) return;
    loginData.buddies = buddies;
    emit('buddies-updated', buddies);

    const sessions = FSState.get().imSessions;
    let imChanged = false;
    Object.keys(sessions).forEach(function (sid) {
      const session = sessions[sid];
      if (!session.participant || !session.participant.id) return;
      if (!targets.has(normAgentId(session.participant.id))) return;
      if (!!session.participant.online === online) return;
      const buddy = buddies.find(function (b) {
        return normAgentId(b.id) === normAgentId(session.participant.id);
      });
      session.participant = Object.assign({}, session.participant, {
        online: online,
        region: online ? ((buddy && buddy.region) || session.participant.region || '') : ''
      });
      imChanged = true;
    });
    if (imChanged) {
      FSState.emit('im-sessions-updated');
    }
  }

  function refreshNamedEntities() {
    if (!loginData) return;
    const buddies = loginData.buddies.map(function (b) {
      const info = getCachedNameInfo(b.id);
      if (info) return mergeNameFields(b, info);
      const name = looksUnresolvedName(b.name, b.id) ? pickDisplayName(b.id, b.name) : b.name;
      return mergeNameFields(b, {
        displayName: b.displayName || '',
        userName: b.userName || b.legacyName || name,
        label: name
      });
    });
    loginData.buddies = buddies;
    emit('buddies-updated', buddies);

    const sessions = FSState.get().imSessions;
    let imChanged = false;
    Object.keys(sessions).forEach(function (sid) {
      const session = sessions[sid];
      if (!session.participant || !session.participant.id) return;
      const name = getCachedName(session.participant.id);
      const info = getCachedNameInfo(session.participant.id);
      if (name && name !== session.participant.name) {
        session.participant = mergeNameFields(session.participant, info || {
          displayName: '',
          userName: name,
          label: name
        });
        imChanged = true;
      }
    });
    if (imChanged) {
      FSState.emit('im-sessions-updated');
    }

    const radar = FSState.get().radar;
    if (radar && radar.length) {
      let radarChanged = false;
      const updated = radar.map(function (entry) {
        const info = getCachedNameInfo(entry.id);
        if (info && info.label !== entry.name) {
          radarChanged = true;
          return mergeNameFields(entry, info);
        }
        return entry;
      });
      if (radarChanged) {
        emit('radar-update', updated);
      }
    }

    const parcel = FSState.get().parcel;
    if (parcel && parcel.ownerId) {
      const ownerName = getCachedName(parcel.ownerId);
      const patch = {};
      if (ownerName && ownerName !== parcel.ownerName) patch.ownerName = ownerName;
      if (parcel.groupId) {
        const groupName = getCachedName(parcel.groupId);
        if (groupName && groupName !== parcel.groupName) patch.groupName = groupName;
      }
      if (Object.keys(patch).length) {
        emit('parcel', Object.assign({}, parcel, patch));
      }
    }
  }

  function emit(event, data) {
    FSTransport.emit(event, data);
  }

  function waitForMapBlocks(matchFn, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const entry = {
        match: matchFn,
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          const idx = mapBlockWaiters.indexOf(entry);
          if (idx >= 0) mapBlockWaiters.splice(idx, 1);
          reject(new Error('Map request timed out'));
        }, timeoutMs || 12000)
      };
      mapBlockWaiters.push(entry);
    });
  }

  function deliverMapBlocks(blocks) {
    if (!blocks || !blocks.length) return;
    mapBlockWaiters = mapBlockWaiters.filter(function (waiter) {
      const matched = blocks.filter(waiter.match);
      if (matched.length) {
        clearTimeout(waiter.timer);
        waiter.resolve(matched);
        return false;
      }
      return true;
    });
    emit('map-blocks', blocks);
    queueMapAgentCounts(blocks.map(function (block) {
      return { gridX: block.gridX, gridY: block.gridY, name: block.name, agents: block.agents };
    }));
  }

  function queueMapAgentCounts(tiles) {
    if (!circuit || !circuit.handshakeDone || !tiles || !tiles.length) return;
    const seen = new Set();
    tiles.forEach(function (tile) {
      if (!tile || tile.gridX === undefined || tile.gridY === undefined) return;
      if (!tile.name) return;
      const key = tile.gridX + ',' + tile.gridY;
      if (seen.has(key)) return;
      seen.add(key);
      const last = mapAgentRequestedAt.get(key) || 0;
      if (Date.now() - last < MAP_AGENT_REFRESH_MS) return;
      mapAgentRequestedAt.set(key, Date.now());
      if (tile.agents !== undefined && tile.agents > 0) {
        emit('map-agents', { gridX: tile.gridX, gridY: tile.gridY, agents: tile.agents });
      }
      mapAgentQueue.push({ gridX: tile.gridX, gridY: tile.gridY });
    });
    drainMapAgentQueue();
  }

  function drainMapAgentQueue() {
    if (mapAgentInflight || !mapAgentQueue.length || !circuit || !circuit.requestMapAgentCount) return;
    const next = mapAgentQueue.shift();
    if (!next) return;
    mapAgentInflight = next;
    const handle = FSSlurl.toRegionHandle(next.gridX * 256, next.gridY * 256);
    circuit.requestMapAgentCount(handle).catch(function () {
      mapAgentInflight = null;
      drainMapAgentQueue();
    });
  }

  function handleMapItemReply(evt) {
    if (!evt || evt.itemType !== MAP_ITEM_AGENT_LOCATIONS || !mapAgentInflight) {
      return;
    }
    let count = 0;
    (evt.items || []).forEach(function (item) {
      if (item && item.extra > 0) count += item.extra;
    });
    const region = loginData && loginData.region ? loginData.region : null;
    if (region && region.x === mapAgentInflight.gridX && region.y === mapAgentInflight.gridY) {
      count += 1;
    }
    emit('map-agents', {
      gridX: mapAgentInflight.gridX,
      gridY: mapAgentInflight.gridY,
      agents: count
    });
    mapAgentInflight = null;
    drainMapAgentQueue();
  }

  function requestMapAgentCounts(tiles) {
    queueMapAgentCounts(tiles || []);
    return Promise.resolve();
  }

  function pickRegionBlock(blocks, regionName) {
    const target = String(regionName || '').trim().toLowerCase();
    let exact = null;
    (blocks || []).forEach(function (block) {
      if (!block || !block.name) return;
      if (block.name.toLowerCase() === target) exact = block;
    });
    return exact;
  }

  function regionNameMatches(blockName, query) {
    const a = String(blockName || '').trim().toLowerCase();
    const b = String(query || '').trim().toLowerCase();
    return a !== '' && b !== '' && a === b;
  }

  function unknownRegionError(regionName) {
    return new Error('Unknown region: ' + String(regionName || '').trim());
  }

  async function fetchRegionNameAtGrid(gridX, gridY, options) {
    const opts = options || {};
    const bridgeUrl = String(getBridgeUrl() || '').replace(/\/$/, '');
    if (bridgeUrl) {
      try {
        const resp = await FSBridge.httpFetch(
          bridgeUrl,
          '/map/regions?tiles=' + encodeURIComponent(gridX + ',' + gridY)
        );
        if (resp.ok) {
          const data = await resp.json();
          const regions = data && data.regions ? data.regions : [];
          const row = regions.find(function (r) {
            return r && r.gridX === gridX && r.gridY === gridY;
          });
          if (!row || row.empty || !row.name) return '';
          return String(row.name).trim();
        }
      } catch (_e) { /* fall through to UDP when allowed */ }
      if (opts.httpOnly) return '';
    }
    if (!circuit) return null;
    const blocksPromise = waitForMapBlocks(function (block) {
      return block.gridX === gridX && block.gridY === gridY;
    }, 8000);
    await circuit.requestMapBlock(
      gridX, gridY, gridX, gridY, MAP_SIM_RETURN_NULL_SIMS
    );
    const blocks = await blocksPromise;
    const block = (blocks || []).find(function (b) {
      return b.gridX === gridX && b.gridY === gridY;
    });
    return block && block.name ? String(block.name).trim() : '';
  }

  async function assertRegionNameAtGrid(gridX, gridY, regionName) {
    const expected = String(regionName || '').trim();
    if (!expected) throw unknownRegionError(regionName);
    const actual = await fetchRegionNameAtGrid(gridX, gridY);
    if (!actual) throw unknownRegionError(expected);
    if (!regionNameMatches(actual, expected)) throw unknownRegionError(expected);
    return actual;
  }

  function locationFromGrid(gridX, gridY, local, fallbackName) {
    const grid = FSSlurl.globalToGrid(gridX * FSSlurl.REGION_WIDTH, gridY * FSSlurl.REGION_WIDTH);
    return {
      regionName: fallbackName || ('Region ' + grid.gridX + ',' + grid.gridY),
      globalX: grid.globalX,
      globalY: grid.globalY,
      gridX: grid.gridX,
      gridY: grid.gridY,
      x: local && local.x !== undefined ? local.x : 128,
      y: local && local.y !== undefined ? local.y : 128,
      z: local && local.z !== undefined ? local.z : 25
    };
  }

  function locationFromRegionLookup(regionName, lookup, local) {
    const name = (lookup && lookup.name) ? String(lookup.name).trim() : '';
    if (!name) {
      throw unknownRegionError(regionName);
    }
    deliverMapBlocks([{
      gridX: lookup.gridX,
      gridY: lookup.gridY,
      name: name
    }]);
    return {
      regionName: name,
      globalX: lookup.globalX,
      globalY: lookup.globalY,
      gridX: lookup.gridX,
      gridY: lookup.gridY,
      x: local.x,
      y: local.y,
      z: local.z
    };
  }

  async function resolveRegionNameHttp(regionName) {
    const bridgeUrl = String(getBridgeUrl() || '').replace(/\/$/, '');
    if (!bridgeUrl) return null;
    try {
      const resp = await FSBridge.httpFetch(
        bridgeUrl,
        '/map/region-by-name?name=' + encodeURIComponent(regionName)
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data || data.gridX === undefined || data.gridY === undefined) return null;
      return data;
    } catch (_e) {
      return null;
    }
  }

  async function resolveRegionByName(regionName, local) {
    const results = await Promise.all([
      FSSlurl.fetchRegionByNameCap(regionName, 12000).catch(function () { return null; }),
      resolveRegionNameHttp(regionName)
    ]);
    let lastErr = null;
    for (let i = 0; i < results.length; i++) {
      const lookup = results[i];
      if (!lookup || lookup.gridX === undefined || lookup.gridY === undefined) continue;
      try {
        const canonical = await assertRegionNameAtGrid(lookup.gridX, lookup.gridY, regionName);
        return locationFromRegionLookup(regionName, {
          gridX: lookup.gridX,
          gridY: lookup.gridY,
          globalX: lookup.globalX,
          globalY: lookup.globalY,
          name: canonical
        }, local);
      } catch (err) {
        lastErr = err;
      }
    }

    if (!circuit) {
      throw lastErr || new Error('Not connected');
    }
    const blocksPromise = waitForMapBlocks(function (block) {
      return regionNameMatches(block.name, regionName);
    }, 8000);
    await circuit.requestMapName(regionName);
    let blocks;
    try {
      blocks = await blocksPromise;
    } catch (err) {
      throw lastErr || unknownRegionError(regionName);
    }
    const block = pickRegionBlock(blocks, regionName);
    if (!block || !block.name) {
      throw lastErr || unknownRegionError(regionName);
    }
    const canonical = await assertRegionNameAtGrid(block.gridX, block.gridY, regionName);
    const grid = FSSlurl.globalToGrid(block.gridX * FSSlurl.REGION_WIDTH, block.gridY * FSSlurl.REGION_WIDTH);
    return locationFromRegionLookup(regionName, {
      gridX: block.gridX,
      gridY: block.gridY,
      globalX: grid.globalX,
      globalY: grid.globalY,
      name: canonical
    }, local);
  }

  async function resolveByGrid(gridX, gridY, local, fallbackName) {
    const grid = FSSlurl.globalToGrid(gridX * FSSlurl.REGION_WIDTH, gridY * FSSlurl.REGION_WIDTH);
    const blocksPromise = waitForMapBlocks(function (block) {
      return block.gridX === grid.gridX && block.gridY === grid.gridY;
    });
    await circuit.requestMapBlock(
      grid.gridX, grid.gridY, grid.gridX, grid.gridY, MAP_SIM_RETURN_NULL_SIMS
    );
    const blocks = await blocksPromise;
    const block = (blocks || []).find(function (b) {
      return b.gridX === grid.gridX && b.gridY === grid.gridY;
    });
    return {
      regionName: (block && block.name) || fallbackName || ('Region ' + grid.gridX + ',' + grid.gridY),
      globalX: grid.globalX,
      globalY: grid.globalY,
      gridX: grid.gridX,
      gridY: grid.gridY,
      x: local.x !== undefined ? local.x : 128,
      y: local.y !== undefined ? local.y : 128,
      z: local.z !== undefined ? local.z : 25
    };
  }

  async function resolveLocation(input) {
    const parsed = typeof input === 'object' && input !== null
      ? enrichParsedInput(input)
      : FSSlurl.parse(String(input || '').trim());
    if (!parsed) {
      throw new Error('Could not parse location');
    }
    const local = {
      x: parsed.x !== undefined ? parsed.x : 128,
      y: parsed.y !== undefined ? parsed.y : 128,
      z: parsed.z !== undefined ? parsed.z : 25
    };
    if (parsed.isGlobalCoord || parsed.globalX !== undefined) {
      if (!circuit) throw new Error('Not connected');
      return resolveByGrid(parsed.gridX, parsed.gridY, local, parsed.regionName);
    }
    if (parsed.gridX !== undefined && parsed.gridY !== undefined) {
      const grid = FSSlurl.globalToGrid(
        parsed.gridX * FSSlurl.REGION_WIDTH,
        parsed.gridY * FSSlurl.REGION_WIDTH
      );
      return {
        regionName: parsed.regionName || ('Region ' + parsed.gridX + ',' + parsed.gridY),
        globalX: grid.globalX,
        globalY: grid.globalY,
        gridX: parsed.gridX,
        gridY: parsed.gridY,
        x: local.x,
        y: local.y,
        z: local.z
      };
    }
    if (!parsed.regionName) {
      throw new Error('Region name required');
    }
    const regionName = parsed.regionName;
    return resolveRegionByName(regionName, local);
  }

  function enrichParsedInput(input) {
    if (!input || input.isGlobalCoord || input.globalX !== undefined) return input;
    if (input.regionName) {
      const coord = FSSlurl.parseGlobalCoordRegionName(input.regionName);
      if (coord) {
        return Object.assign({}, input, {
          globalX: coord.globalX,
          globalY: coord.globalY,
          gridX: coord.gridX,
          gridY: coord.gridY,
          isGlobalCoord: true
        });
      }
    }
    return input;
  }

  function getBridgeUrl() {
    return bridge ? bridge.baseUrl : '';
  }

  function getMapServerUrl() {
    const fromLogin = loginData && loginData.mapServerUrl;
    return FSSlurl.normalizeMapServerUrl(fromLogin || FSSlurl.DEFAULT_MAP_SERVER);
  }

  function getMapTileUrl(level, gridX, gridY) {
    const bridgeUrl = bridge ? bridge.baseUrl : '';
    return FSSlurl.tileUrl(getMapServerUrl(), level, gridX, gridY, bridgeUrl);
  }

  async function requestMapArea(minX, minY, maxX, maxY) {
    if (!circuit) return [];
    try {
      await circuit.requestMapBlock(minX, minY, maxX, maxY, 2);
    } catch (_e) { /* ignore */ }
    return [];
  }

  async function teleportTo(input) {
    assertCanTeleport();
    clearLateTeleportGrace();
    if (pendingTeleportLoc) {
      if (teleportStartSeen) {
        throw new Error('Teleport in progress - wait for arrival');
      }
      FSErrors.warn('teleport', 'Cancelling stalled teleport (no TeleportStart yet)', false);
      clearTeleportPending(false);
    }
    let loc;
    if (typeof input === 'object' && input !== null &&
        input.gridX !== undefined && input.gridY !== undefined) {
      loc = locationFromGrid(input.gridX, input.gridY, {
        x: input.x,
        y: input.y,
        z: input.z
      }, input.regionName);
    } else {
      loc = await resolveLocation(input);
    }
    const handle = FSSlurl.toRegionHandle(loc.globalX, loc.globalY);
    const pos = teleportPositionForRequest(loc);
    const lookAt = { x: pos.x + 1, y: pos.y, z: pos.z };
    loc.x = pos.x;
    loc.y = pos.y;
    loc.z = pos.z;
    loc.flags = FSTeleport.TELEPORT_FLAGS.VIA_LOCATION;
    await ensureTeleportHandoffReady('teleport outbound');
    prepareOutboundTeleport(loc);
    const handleStr = FSSlurl.regionHandleToString(handle);
    FSErrors.info('teleport', 'TeleportLocationRequest -> ' + loc.regionName +
      ' grid ' + loc.gridX + ',' + loc.gridY +
      ' origin ' + (loc.globalX !== undefined ? loc.globalX + ',' + loc.globalY : '?') +
      ' handle ' + handleStr +
      ' @ ' + Math.round(pos.x) + ',' + Math.round(pos.y) + ',' + Math.round(pos.z), false);
    const sendResult = await circuit.teleportLocationRequest(handle, pos, lookAt, false);
    if (!sendResult || !sendResult.sent) {
      clearTeleportPending(true);
      throw new Error('UDP send failed for TeleportLocationRequest - restart bridge and hard-refresh.');
    }
    FSErrors.info('teleport', 'TeleportLocationRequest sent (' + (sendResult.bytesSent || 0) + ' bytes)', false);
    scheduleTeleportRetry(loc, handle, pos, lookAt);
    if (circuit && circuit.kickPoll) {
      circuit.kickPoll();
    }
    emit('teleport-started', loc);
    return loc;
  }

  function homeTeleportStub() {
    const home = (loginData && loginData.home) || {};
    return {
      regionName: home.regionName || '',
      globalX: home.globalX,
      globalY: home.globalY,
      gridX: home.gridX,
      gridY: home.gridY,
      x: home.x !== undefined ? home.x : 128,
      y: home.y !== undefined ? home.y : 128,
      z: home.z !== undefined ? home.z : 25,
      toHome: true
    };
  }

  async function teleportHome() {
    assertCanTeleport();
    clearLateTeleportGrace();
    if (pendingTeleportLoc) {
      if (teleportStartSeen) {
        throw new Error('Teleport in progress - wait for arrival');
      }
      if (pendingTeleportLoc.toHome) {
        return pendingTeleportLoc;
      }
      FSErrors.warn('teleport', 'Cancelling stalled teleport (no TeleportStart yet)', false);
      clearTeleportPending(false);
    }
    if (isAlreadyAtHome()) {
      const home = homeTeleportStub();
      FSErrors.info('teleport', 'Already at home - no teleport sent', false);
      emit('teleport-finish', { benign: true, regionName: home.regionName, region: loginData.region });
      return Object.assign({}, home, { alreadyHome: true });
    }
    const loc = homeTeleportStub();
    loc.flags = FSTeleport.TELEPORT_FLAGS.VIA_HOME;
    await ensureTeleportHandoffReady('teleport outbound');
    prepareOutboundTeleport(loc);
    FSErrors.info('teleport', 'TeleportLandmarkRequest -> home', false);
    const sendResult = await circuit.teleportLandmarkRequest(null);
    if (!sendResult || !sendResult.sent) {
      clearTeleportPending(true);
      throw new Error('UDP send failed for TeleportLandmarkRequest - restart bridge and hard-refresh.');
    }
    FSErrors.info('teleport',
      'TeleportLandmarkRequest sent (' + (sendResult.bytesSent || 0) + ' bytes)', false);
    scheduleTeleportLandmarkRetry(null);
    if (circuit && circuit.kickPoll) {
      circuit.kickPoll();
    }
    emit('teleport-started', loc);
    return loc;
  }

  async function teleportToLandmark(landmarkId) {
    assertCanTeleport();
    const id = String(landmarkId || '').trim();
    if (!id || id === '00000000-0000-0000-0000-000000000000') {
      throw new Error('Invalid landmark');
    }
    clearLateTeleportGrace();
    if (pendingTeleportLoc) {
      if (teleportStartSeen) {
        throw new Error('Teleport in progress - wait for arrival');
      }
      FSErrors.warn('teleport', 'Cancelling stalled teleport (no TeleportStart yet)', false);
      clearTeleportPending(false);
    }
    const loc = {
      regionName: 'Landmark',
      x: 128,
      y: 128,
      z: 25,
      landmarkId: id,
      flags: FSTeleport.TELEPORT_FLAGS.VIA_LANDMARK
    };
    await ensureTeleportHandoffReady('teleport outbound');
    prepareOutboundTeleport(loc);
    FSErrors.info('teleport', 'TeleportLandmarkRequest -> ' + id.slice(0, 8) + '...', false);
    const sendResult = await circuit.teleportLandmarkRequest(id);
    if (!sendResult || !sendResult.sent) {
      clearTeleportPending(true);
      throw new Error('UDP send failed for TeleportLandmarkRequest - restart bridge and hard-refresh.');
    }
    FSErrors.info('teleport',
      'TeleportLandmarkRequest sent (' + (sendResult.bytesSent || 0) + ' bytes)', false);
    scheduleTeleportLandmarkRetry(id);
    if (circuit && circuit.kickPoll) {
      circuit.kickPoll();
    }
    emit('teleport-started', loc);
    return loc;
  }

  function chatTypeName(n) {
    if (n === 0) return 'whisper';
    if (n === 2) return 'shout';
    return 'normal';
  }

  function stripChatChannel(text) {
    let out = String(text || '').trim();
    if (!out.startsWith('/')) {
      return { text: out, channel: 0 };
    }
    const channelMatch = out.match(/^\/(-?\d+)(?:\s+([\s\S]+))?$/);
    if (channelMatch) {
      return {
        text: (channelMatch[2] || '').trim(),
        channel: parseInt(channelMatch[1], 10)
      };
    }
    const compact = out.match(/^\/(-?\d+)([\s\S]*)$/);
    if (compact && /^-?\d+$/.test(compact[1])) {
      return {
        text: compact[2].trim(),
        channel: parseInt(compact[1], 10)
      };
    }
    return { text: out, channel: 0 };
  }

  function stripVolumeCommand(text, defaultType) {
    const raw = String(text || '');
    const lower = raw.toLowerCase();
    if (lower.startsWith('/whisper')) {
      let rest = raw.slice(8);
      if (rest.startsWith(' ')) rest = rest.slice(1);
      return { text: rest.trim(), type: 'whisper' };
    }
    if (lower.startsWith('/shout')) {
      let rest = raw.slice(6);
      if (rest.startsWith(' ')) rest = rest.slice(1);
      return { text: rest.trim(), type: 'shout' };
    }
    return { text: raw, type: defaultType || 'normal' };
  }

  function parseNearbyChatInput(text, defaultType) {
    const channelPart = stripChatChannel(text);
    const volumePart = stripVolumeCommand(channelPart.text, defaultType);
    return {
      text: volumePart.text,
      type: volumePart.type,
      channel: channelPart.channel
    };
  }

  function mergeParcelField(incoming, current, fallback) {
    if (incoming !== undefined && incoming !== null) return incoming;
    if (current !== undefined && current !== null) return current;
    return fallback;
  }

  function mergeParcelPrimTotal(incoming, current) {
    if (incoming !== undefined && incoming !== null && incoming > 0) return incoming;
    if (current !== undefined && current !== null && current > 0) return current;
    return mergeParcelField(incoming, current, 0);
  }

  function resolveParcelPrims(p, current, source) {
    let primsUsed = current.primsUsed || 0;
    let primsTotal = mergeParcelPrimTotal(current.primsTotal, undefined);
    const parcelPrimBonus = p.parcelPrimBonus || current.parcelPrimBonus || 1;

    if (source === 'http') {
      if (p.primsTotal > 0) primsTotal = p.primsTotal;
      if (p.primsUsed !== undefined && p.primsUsed !== null && p.primsUsed > 0) {
        primsUsed = p.primsUsed;
      }
    } else {
      if (p.primsUsed !== undefined && p.primsUsed !== null) {
        if (p.primsUsed > 0 || !(current.primsUsed > 0)) {
          primsUsed = p.primsUsed;
        }
      }
      primsTotal = mergeParcelPrimTotal(p.primsTotal, primsTotal);
    }

    const area = p.area || current.area || 0;
    if (!primsTotal && area > 0) {
      primsTotal = FSUtils.estimateParcelPrimCapacity(area, parcelPrimBonus);
    }
    return { primsUsed: primsUsed, primsTotal: primsTotal, parcelPrimBonus: parcelPrimBonus };
  }

  function parcelRichnessScore(parcel) {
    if (!parcel) return 0;
    let score = 0;
    if (parcel.name && parcel.name !== 'Parcel' && parcel.name !== 'Current parcel') score += 4;
    if (parcel.area > 0) score += 4;
    if (parcel.parcelFlags > 0) score += 12;
    if (parcel.primsUsed > 0) score += 8;
    if (parcel.primsTotal > 0) score += 4;
    if (String(parcel.musicUrl || '').trim()) score += 8;
    if (String(parcel.mediaUrl || '').trim()) score += 6;
    if (parcel.parcelId) score += 3;
    if (parcel.groupId) score += 2;
    if (parcel.snapshotId) score += 2;
    if (parcel.dwell > 0) score += 2;
    if (parcel.source === 'udp' || parcel.source === 'eventqueue') score += 6;
    return score;
  }

  function mergeParcelRichField(incoming, current, preferIncoming) {
    if (incoming === undefined || incoming === null) return current;
    if (incoming === '' && current) return current;
    if (!preferIncoming && current) return current;
    return incoming;
  }

  function flagsFromParcelData(parcelFlags) {
    const flags = parcelFlags || 0;
    let access = 0;
    if (flags & PF_USE_ACCESS_LIST) access = 1;
    else if (flags & PF_USE_ACCESS_GROUP) access = 2;
    return {
      access: access,
      pushRestricted: !!(flags & PF_RESTRICT_PUSHOBJECT),
      allowBuild: !!((flags & PF_CREATE_OBJECTS) || (flags & PF_CREATE_GROUP_OBJECTS)),
      allowBuildEveryone: !!(flags & PF_CREATE_OBJECTS),
      allowBuildGroup: !!(flags & PF_CREATE_GROUP_OBJECTS),
      allowScripts: !!((flags & PF_ALLOW_OTHER_SCRIPTS) || (flags & PF_ALLOW_GROUP_SCRIPTS)),
      allowScriptsEveryone: !!(flags & PF_ALLOW_OTHER_SCRIPTS),
      allowScriptsGroup: !!(flags & PF_ALLOW_GROUP_SCRIPTS),
      allowFly: !!(flags & PF_ALLOW_FLY),
      allowTerraform: !!(flags & PF_ALLOW_TERRAFORM),
      safeEnvironment: !(flags & PF_ALLOW_DAMAGE),
      soundLocal: !!(flags & PF_SOUND_LOCAL),
      allowVoice: !!(flags & PF_ALLOW_VOICE_CHAT),
      showInSearch: !!(flags & PF_SHOW_DIRECTORY),
      sellPasses: !!(flags & PF_USE_PASS_LIST)
    };
  }

  function mergeParcelString(incoming, current) {
    const cur = current || '';
    if (incoming === undefined || incoming === null) return cur;
    if (incoming === '' && cur) return cur;
    return incoming;
  }

  function parcelEmitSignature(parcel) {
    if (!parcel) return '';
    const lp = parcel.landingPoint;
    const landing = lp ? (lp.x + ',' + lp.y + ',' + lp.z) : '';
    return [
      parcel.localId || 0,
      parcel.parcelFlags || 0,
      parcel.primsUsed || 0,
      parcel.primsTotal || 0,
      parcel.ownerPrims || 0,
      parcel.groupPrims || 0,
      parcel.otherPrims || 0,
      parcel.dwell !== undefined && parcel.dwell !== null ? Math.round(parcel.dwell) : '',
      parcel.parcelId || '',
      parcel.name || '',
      parcel.musicUrl || '',
      parcel.mediaUrl || '',
      landing
    ].join('|');
  }

  function parcelHasRichData(parcel) {
    return !!(parcel && !parcel.stub &&
      (parcel.parcelFlags || 0) > 0 &&
      (parcel.primsUsed || 0) > 0 &&
      (parcel.name || '').trim());
  }

  function parcelNeedsHttpLookup(parcel) {
    if (!parcel || parcel.stub) return true;
    if (!(parcel.parcelFlags > 0)) return true;
    if (!parcel.parcelId) return true;
    if (parcel.dwell === undefined || parcel.dwell === null) return true;
    return false;
  }

  function logParcelChange(source, payload, reason) {
    const sig = parcelEmitSignature(payload);
    if (sig === lastParcelEmitSignature) return;
    lastParcelEmitSignature = sig;
    const src = source ? (' via ' + source) : '';
    FSErrors.info('parcel', 'Parcel update' + src + ': "' + (payload.name || '?') + '" area=' +
      (payload.area || 0) + ' prims=' + (payload.primsUsed || 0) + '/' + (payload.primsTotal || 0) +
      ' flags=0x' + (payload.parcelFlags || 0).toString(16) +
      (reason ? ' (' + reason + ')' : ''), false);
  }

  function mergeParcelFlags(incoming, current, source) {
    const cur = current || 0;
    if (typeof incoming !== 'number') return cur;
    if (incoming !== 0) return incoming >>> 0;
    if (source === 'info') return cur;
    if (cur > 0) return cur;
    if (source === 'http' || source === 'media') return cur;
    return incoming;
  }

  function emitParcelFromData(p, source) {
    if (!p) return;
    const src = source || p.source || 'udp';
    const stored = FSState.get().parcel;
    const current = (stored && !stored.stub) ? stored : {};
    const incomingScore = parcelRichnessScore(Object.assign({}, current, p, { source: src }));
    const currentScore = parcelRichnessScore(current);
    if (currentScore > incomingScore + 2 && (src === 'info' || src === 'http' || src === 'media')) {
      return;
    }
    const resolvedName = (p.name && String(p.name).trim()) ? p.name : '';
    const agentId = loginData ? loginData.agent.id : '';
    const ownerId = p.ownerId || current.ownerId || agentId;
    const primFields = resolveParcelPrims(p, current, src);
    const parcelFlags = mergeParcelFlags(p.parcelFlags, current.parcelFlags, src);
    const flagFields = flagsFromParcelData(parcelFlags);
    const preferIncoming = incomingScore >= currentScore;

    const payload = {
      localId: p.localId !== undefined ? p.localId : (current.localId || 0),
      name: resolvedName || (current.name && current.name !== 'Current parcel' ? current.name : 'Parcel'),
      desc: p.desc !== undefined ? p.desc : (current.desc || ''),
      area: p.area || current.area || 0,
      primsUsed: primFields.primsUsed,
      primsTotal: primFields.primsTotal,
      parcelPrimBonus: primFields.parcelPrimBonus,
      ownerPrims: p.ownerPrims !== undefined ? p.ownerPrims : current.ownerPrims,
      groupPrims: p.groupPrims !== undefined ? p.groupPrims : current.groupPrims,
      otherPrims: p.otherPrims !== undefined ? p.otherPrims : current.otherPrims,
      simWideMaxPrims: p.simWideMaxPrims !== undefined ? p.simWideMaxPrims : current.simWideMaxPrims,
      simWideTotalPrims: p.simWideTotalPrims !== undefined ? p.simWideTotalPrims : current.simWideTotalPrims,
      ownerId: ownerId,
      ownerName: pickDisplayName(ownerId, getCachedName(ownerId)),
      isGroupOwned: p.isGroupOwned !== undefined ? !!p.isGroupOwned : !!current.isGroupOwned,
      parcelFlags: parcelFlags,
      access: flagFields.access !== undefined ? flagFields.access : current.access,
      pushRestricted: parcelFlags ? flagFields.pushRestricted : !!current.pushRestricted,
      allowBuild: parcelFlags ? flagFields.allowBuild : !!current.allowBuild,
      allowBuildEveryone: parcelFlags ? flagFields.allowBuildEveryone : !!current.allowBuildEveryone,
      allowBuildGroup: parcelFlags ? flagFields.allowBuildGroup : !!current.allowBuildGroup,
      allowScripts: parcelFlags ? flagFields.allowScripts : !!current.allowScripts,
      allowScriptsEveryone: parcelFlags ? flagFields.allowScriptsEveryone : !!current.allowScriptsEveryone,
      allowScriptsGroup: parcelFlags ? flagFields.allowScriptsGroup : !!current.allowScriptsGroup,
      allowFly: parcelFlags ? flagFields.allowFly : !!current.allowFly,
      allowTerraform: parcelFlags ? flagFields.allowTerraform : !!current.allowTerraform,
      safeEnvironment: parcelFlags ? flagFields.safeEnvironment : current.safeEnvironment !== false,
      soundLocal: parcelFlags ? flagFields.soundLocal : !!current.soundLocal,
      allowVoice: parcelFlags ? flagFields.allowVoice : current.allowVoice !== false,
      showInSearch: parcelFlags ? flagFields.showInSearch : !!current.showInSearch,
      sellPasses: parcelFlags ? flagFields.sellPasses : !!current.sellPasses,
      musicUrl: mergeParcelString(p.musicUrl, current.musicUrl),
      mediaUrl: mergeParcelString(p.mediaUrl, current.mediaUrl),
      mediaDesc: mergeParcelString(p.mediaDesc, current.mediaDesc),
      mediaType: mergeParcelString(p.mediaType, current.mediaType),
      parcelId: mergeParcelRichField(p.parcelId, current.parcelId, preferIncoming),
      groupId: mergeParcelRichField(p.groupId, current.groupId, preferIncoming),
      groupName: mergeParcelRichField(p.groupName, current.groupName, preferIncoming),
      snapshotId: mergeParcelRichField(p.snapshotId, current.snapshotId, preferIncoming),
      dwell: p.dwell !== undefined ? p.dwell : current.dwell,
      landingPoint: p.landingPoint || current.landingPoint,
      passPrice: p.passPrice !== undefined ? p.passPrice : current.passPrice,
      passHours: p.passHours !== undefined ? p.passHours : current.passHours,
      salePrice: p.salePrice !== undefined ? p.salePrice : current.salePrice,
      stub: false,
      source: src
    };
    if (payload.groupId && payload.groupId !== ZERO_UUID) {
      queueNameResolve([payload.groupId]);
      if (!payload.groupName) {
        payload.groupName = pickDisplayName(payload.groupId, getCachedName(payload.groupId));
      }
    }
    payload.canEdit = FSUtils.canEditParcel(payload, agentId);
    if (p.parcelId) payload.parcelId = p.parcelId;
    if (payload.snapshotId && payload.snapshotId !== ZERO_UUID) {
      payload.snapshotUrl = textureImageUrl(payload.snapshotId, 256);
    }
    if (p.ownerId) queueNameResolve([p.ownerId]);
    const emitSig = parcelEmitSignature(payload);
    if (emitSig === lastParcelEmitSignature) {
      return;
    }
    logParcelChange(src, payload);
    emit('parcel', payload);
  }

  function textureImageUrl(uuid, size) {
    const id = String(uuid || '').toLowerCase();
    if (!id || id === ZERO_UUID) return '';
    return 'https://secondlife.com/app/image/' + id + '/' + (size || 256);
  }

  function parcelInfoMaturityLabel(flags) {
    const value = flags || 0;
    if (value & 0x2) return 'Adult';
    if (value & 0x1) return 'Mature';
    return 'General';
  }

  function parcelSaleFromInfo(p) {
    const salePrice = Number(p.salePrice) || 0;
    const auctionId = Number(p.auctionId) || 0;
    return {
      salePrice: salePrice,
      auctionId: auctionId,
      auction: auctionId > 0,
      forSale: salePrice > 0 && auctionId <= 0
    };
  }

  function placeInfoFromParcel(p) {
    if (!p) return null;
    const sale = parcelSaleFromInfo(p);
    const regionWidth = FSSlurl.REGION_WIDTH;
    const globalX = Number(p.globalX) || 0;
    const globalY = Number(p.globalY) || 0;
    const globalZ = Number(p.globalZ) || 25;
    const x = ((Math.round(globalX) % regionWidth) + regionWidth) % regionWidth;
    const y = ((Math.round(globalY) % regionWidth) + regionWidth) % regionWidth;
    const z = Math.round(globalZ);
    const simName = String(p.simName || '').trim();
    const slurl = simName ? FSSlurl.buildMapsUrl(simName, { x: x, y: y, z: z }) : '';
    return {
      parcelId: p.parcelId || '',
      name: p.name || '',
      description: p.desc || p.description || '',
      dwell: p.dwell,
      simName: simName,
      globalX: globalX,
      globalY: globalY,
      globalZ: globalZ,
      x: x,
      y: y,
      z: z,
      slurl: slurl,
      location: simName ? (simName + ' (' + x + ', ' + y + ', ' + z + ')') : '',
      image: textureImageUrl(p.snapshotId, 256),
      salePrice: sale.salePrice,
      auctionId: sale.auctionId,
      auction: sale.auction,
      forSale: sale.forSale,
      maturity: parcelInfoMaturityLabel(p.infoFlags),
      kind: 'place'
    };
  }

  function finishParcelInfoRequest(parcelId, payload, err) {
    const key = normAgentId(parcelId);
    const entry = pendingParcelInfo.get(key);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    pendingParcelInfo.delete(key);
    if (err) entry.reject(err);
    else entry.resolve(payload);
    return true;
  }

  async function fetchParcelInfo(parcelId) {
    const id = String(parcelId || '').trim();
    if (!id || id === ZERO_UUID) {
      return Promise.reject(new Error('Invalid parcel id'));
    }
    if (!circuit || !circuit.handshakeDone) {
      return Promise.reject(new Error('Not connected'));
    }
    const key = normAgentId(id);
    const existing = pendingParcelInfo.get(key);
    if (existing) return existing.promise;

    let resolveFn;
    let rejectFn;
    const promise = new Promise(function (resolve, reject) {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const entry = {
      promise: promise,
      resolve: resolveFn,
      reject: rejectFn,
      timer: setTimeout(function () {
        if (!pendingParcelInfo.has(key)) return;
        finishParcelInfoRequest(id, null, new Error('Parcel info timed out'));
      }, PARCEL_INFO_TIMEOUT_MS)
    };
    pendingParcelInfo.set(key, entry);
    try {
      await circuit.requestParcelInfo(id);
    } catch (err) {
      finishParcelInfoRequest(id, null, err);
    }
    return promise;
  }

  function handleCircuitEvent(evt) {
    if (evt.type === 'avatar-picker-reply' ||
        evt.type === 'dir-people-reply' ||
        evt.type === 'dir-places-reply' ||
        evt.type === 'dir-groups-reply') {
      if (typeof FSSearchApi !== 'undefined') {
        FSSearchApi.onPacket(evt);
      }
      return;
    }
    if (evt.type === 'udp-recv') {
      noteUdpRecv(evt.count || 1);
      return;
    }
    if (evt.type === 'session-lost') {
      handleSessionLost(evt.reason, evt.source);
      return;
    }
    if (evt.type === 'circuit-timeout') {
      handleCircuitTimeout(evt);
      return;
    }
    if (evt.type === 'unresolved-packet') {
      handleUnresolvedPacket(evt);
      return;
    }
    if (sessionLost) return;
    if (evt.type === 'buddy-presence' && evt.agentIds && evt.agentIds.length) {
      updateBuddyPresence(evt.agentIds, !!evt.online);
      return;
    }
    if (evt.type === 'chat' && evt.data) {
      const agentId = loginData ? normAgentId(loginData.agent.id) : '';
      const fromId = evt.data.sourceId;
      if (agentId && normAgentId(fromId) === agentId) {
        return;
      }
      cacheName(fromId, evt.data.fromName);
      emit('chat', {
        id: FSUtils.uuid(),
        fromId: fromId,
        fromName: getCachedName(fromId) || evt.data.fromName,
        text: evt.data.text,
        type: chatTypeName(evt.data.chatType),
        source: evt.data.sourceType === 0 ? 'object' : 'agent',
        channel: 0,
        timestamp: Date.now()
      });
      return;
    }
    if (evt.type === 'alert' && evt.data) {
      const text = String(evt.data.message || '').trim();
      if (text) {
        if (pendingTeleportLoc && isBenignTeleportFailure(text)) {
          completeBenignTeleportFailure(text, 'alert');
          return;
        }
        FSErrors.info('alert', text.slice(0, 160), false);
        postSystemChat(text);
        if (evt.data.modal) {
          FSUtils.showToast(text, 'warning', 8000);
        }
      }
      return;
    }
    if (evt.type === 'viewer-frozen' && evt.data) {
      const frozen = !!evt.data.frozen;
      FSErrors.info('session', frozen ? 'Avatar frozen by simulator' : 'Avatar unfrozen', false);
      postSystemChat(frozen ? 'You have been frozen.' : 'You are no longer frozen.');
      return;
    }
    if (evt.type === 'script-question' && evt.data) {
      postScriptQuestionChat(evt.data);
      return;
    }
    if (evt.type === 'script-dialog' && evt.data) {
      postScriptDialogChat(evt.data);
      return;
    }
    if (evt.type === 'feature-disabled' && evt.data) {
      const text = String(evt.data.message || '').trim();
      if (text) {
        FSErrors.warn('protocol', 'Feature disabled: ' + text.slice(0, 160), false);
        postSystemChat(text);
      }
      return;
    }
    if (evt.type === 'load-url' && evt.data) {
      postLoadUrlChat(evt.data);
      return;
    }
    if (evt.type === 'script-teleport-request' && evt.data) {
      postScriptTeleportChat(evt.data);
      return;
    }
    if (evt.type === 'calling-card-offer' && evt.data) {
      postCallingCardOfferChat(evt.data);
      return;
    }
    if (evt.type === 'calling-card-accepted') {
      postSystemChat('Your friendship offer was accepted.');
      return;
    }
    if (evt.type === 'calling-card-declined') {
      postSystemChat('Your friendship offer was declined.');
      return;
    }
    if (evt.type === 'generic-message' && evt.data) {
      const method = String(evt.data.method || '').trim();
      const params = evt.data.params || [];
      if (method) {
        FSErrors.info('protocol', 'GenericMessage: ' + method +
          (params.length ? ' (' + params.length + ' params)' : ''), false);
      }
      return;
    }
    if (evt.type === 'money-balance' && evt.data) {
      if (loginData) {
        loginData.lindenBalance = evt.data.balance;
        loginData.landCredit = evt.data.landCredit;
        loginData.landCommitted = evt.data.landCommitted;
      }
      emit('money-balance', {
        balance: evt.data.balance,
        landCredit: evt.data.landCredit,
        landCommitted: evt.data.landCommitted,
        description: evt.data.description || '',
        transactionType: evt.data.transactionType || 0
      });
      if (evt.data.description || evt.data.transactionType) {
        postPaymentEvent(evt.data);
      }
      return;
    }
    if (evt.type === 'terminate-friendship' && evt.data && evt.data.otherId) {
      removeBuddy(evt.data.otherId);
      FSErrors.info('buddies', 'Friendship ended: ' + evt.data.otherId.slice(0, 8) + '...', false);
      return;
    }
    if (evt.type === 'parcel-media-update' && evt.data) {
      const url = String(evt.data.mediaUrl || '').trim();
      if (url) {
        FSErrors.info('parcel', 'Parcel media: ' + url.slice(0, 120), false);
      }
      const stored = FSState.get().parcel;
      if (stored && !stored.stub) {
        emitParcelFromData({
          mediaUrl: evt.data.mediaUrl || '',
          parcelFlags: stored.parcelFlags
        }, 'media');
      }
      return;
    }
    if (evt.type === 'im' && evt.data) {
      const agentId = normAgentId(loginData.agent.id);
      const fromId = normAgentId(evt.data.fromAgentId);
      const toId = normAgentId(evt.data.toAgentId);
      if (!fromId || fromId === agentId) return;
      if (toId && toId !== agentId &&
          toId !== '00000000-0000-0000-0000-000000000000') {
        return;
      }
      const dialog = evt.data.dialog || 0;
      if (dialog === IM_TYPING_START || dialog === IM_TYPING_STOP) {
        return;
      }
      if (evt.data.fromName) {
        cacheName(fromId, evt.data.fromName);
      }
      queueNameResolve([fromId]);
      const displayName = pickDisplayName(fromId, evt.data.fromName);

      if (FSTeleport.isTeleportDialog(dialog)) {
        FSErrors.info('teleport', 'IM dialog ' + dialog + ' from ' +
          (displayName || fromId).slice(0, 32), false);
      }

      if (dialog === FSTeleport.IM_LURE_DECLINED) {
        emit('teleport-declined', {
          fromId: fromId,
          fromName: displayName
        });
        return;
      }
      if (dialog === FSTeleport.IM_LURE_ACCEPTED) {
        emit('teleport-accepted', {
          fromId: fromId,
          fromName: displayName
        });
        return;
      }
      if (dialog === FSTeleport.IM_LURE_USER) {
        const lure = FSTeleport.parseLureBucket(evt.data.binaryBucket);
        emit('teleport-offer', {
          fromId: fromId,
          fromName: displayName,
          message: FSTeleport.stripSlurl(evt.data.text),
          lureId: evt.data.imId,
          location: lure,
          rawMessage: evt.data.text || ''
        });
        return;
      }
      if (dialog === FSTeleport.IM_TELEPORT_REQUEST) {
        emit('teleport-request', {
          fromId: fromId,
          fromName: displayName,
          message: String(evt.data.text || '').trim(),
          lureId: evt.data.imId
        });
        return;
      }
      if (!String(evt.data.text || '').trim()) {
        return;
      }
      if (isDuplicateIm(evt.data)) {
        return;
      }
      const sessionId = FSUtils.xorSessionId(agentId, fromId);
      const participant = {
        id: fromId,
        name: displayName,
        online: evt.data.offline === 0
      };
      const imId = evt.data.imId || FSUtils.uuid();
      emit('im', {
        sessionId: sessionId,
        participant: participant,
        message: {
          id: imId,
          imId: imId,
          fromId: fromId,
          fromName: displayName,
          text: evt.data.text,
          outgoing: false,
          timestamp: Date.now()
        }
      });
    }
    if (evt.type === 'radar' && evt.data) {
      const coarse = evt.data;
      applyCoarseSelfPosition(coarse);
      const entries = buildRadarEntries(coarse);
      if (!shouldApplyRadarUpdate(entries)) return;
      emit('radar-update', entries);
    }
    if (evt.type === 'movement' && evt.position) {
      if (evt.lookAt && circuit) circuit.lookAt = evt.lookAt;
      emitAgentPosition(evt.position, 'movement');
    }
    if (evt.type === 'circuit-acked') {
      updateBridgeCircuitContext();
      if (!capsReady && !pendingTeleportLoc) scheduleCapBootstrap(true);
    }
    if (evt.type === 'ready') {
      circuitReady = true;
      agentPlaced = true;
      updateBridgeCircuitContext();
      scheduleCircuitServicesOnce('circuit ready');
      ensureEventQueuePoll('circuit ready');
      if (!capsReady) {
        scheduleCapBootstrap(true);
      }
    }
    if (evt.type === 'agent-placed') {
      agentPlaced = true;
      updateBridgeCircuitContext();
      if (!capsReady && !pendingTeleportLoc) {
        scheduleCapBootstrap(true);
      }
    }
    if (evt.type === 'seed-capability' && evt.url) {
      onSeedCapability(evt.url);
    }
    if (evt.type === 'teleport-finish') {
      handleTeleportFinish(evt);
      return;
    }
    if (evt.type === 'crossed-region') {
      handleCrossedRegion(evt);
      return;
    }
    if (evt.type === 'teleport-local') {
      handleTeleportLocal(evt);
      return;
    }
    if (evt.type === 'teleport-start') {
      const flags = evt.flags || 0;
      if (!pendingTeleportLoc) {
        if (!shouldBeginSimInitiatedTeleport(flags)) {
          if (!FSTeleport.shouldFollowRemoteTeleportStart(flags)) {
            FSErrors.info('teleport',
              'Ignoring TeleportStart' + teleportFlagNote(flags), false);
          }
          return;
        }
        beginSimInitiatedTeleport(flags);
      }
      mergePendingTeleportFlags(flags);
      if (!teleportStartSeen) {
        FSErrors.info('teleport', 'TeleportStart' + teleportFlagNote(flags), false);
      }
      teleportStartSeen = true;
      if (typeof FSEventQueue.setTeleportActive === 'function') {
        FSEventQueue.setTeleportActive(true);
      }
      if (teleportRetryTimer) {
        clearTimeout(teleportRetryTimer);
        teleportRetryTimer = null;
      }
      scheduleTeleportTimeout(90000);
      kickEventQueueForTeleport('teleport started');
      return;
    }
    if (evt.type === 'teleport-progress') {
      const progressFlags = evt.flags || 0;
      const progressKey = String(evt.message || '').trim();
      mergePendingTeleportFlags(progressFlags);
      const note = progressKey ? (': ' + progressKey) : '';
      FSErrors.info('teleport', 'TeleportProgress' + note + teleportFlagNote(progressFlags), false);
      if (pendingTeleportLoc) {
        scheduleTeleportTimeout(90000);
        kickEventQueueForTeleport('teleport progress' + (progressKey ? (': ' + progressKey) : ''));
      }
      emit('teleport-progress', { message: progressKey });
      return;
    }
    if (evt.type === 'teleport-debug' && pendingTeleportLoc) {
      const label = (evt.name || 'packet') + (evt.extra ? ' ' + evt.extra : '');
      if (evt.name === 'DisableSimulator') {
        FSErrors.info('teleport',
          'RX DisableSimulator (neighbour/child sim teardown during handoff - expected)', false);
      } else {
        FSErrors.info('teleport', 'RX ' + label, false);
      }
      return;
    }
    if (evt.type === 'enable-simulator' && evt.data) {
      handleEnableSimulator(evt);
      return;
    }
    if (evt.type === 'map-block-reply') {
      const blocks = evt.blocks || [];
      if (blocks.length) {
        FSErrors.info('map', 'MapBlockReply: ' + blocks.length + ' region(s)', false);
      }
      deliverMapBlocks(blocks);
      return;
    }
    if (evt.type === 'map-item-reply') {
      handleMapItemReply(evt);
      return;
    }
    if (evt.type === 'teleport-failed' && evt.data) {
      failTeleport(evt.data.reason || 'Teleport failed', 'UDP');
      return;
    }
    if (evt.type === 'region' && evt.name) {
      if (!isPlaceholderRegionName(evt.name)) {
        loginData.region.name = evt.name;
      }
      if (evt.regionId) loginData.region.id = evt.regionId;
      if (evt.x !== undefined) loginData.region.x = evt.x;
      if (evt.y !== undefined) loginData.region.y = evt.y;
      if (evt.globalX !== undefined) loginData.region.globalX = evt.globalX;
      if (evt.globalY !== undefined) loginData.region.globalY = evt.globalY;
      const payload = {
        name: evt.name,
        id: evt.regionId || loginData.region.id
      };
      if (!evt.handshakeOnly &&
          loginData.region.x !== undefined && loginData.region.y !== undefined) {
        payload.globalX = loginData.region.globalX;
        payload.globalY = loginData.region.globalY;
        payload.x = loginData.region.x;
        payload.y = loginData.region.y;
      }
      if (evt.handshakeOnly) {
        if (!pendingTeleportLoc && !isPlaceholderRegionName(evt.name) &&
            loginData.region.x !== undefined && loginData.region.y !== undefined) {
          emit('region', {
            name: evt.name,
            id: evt.regionId || loginData.region.id,
            globalX: loginData.region.globalX,
            globalY: loginData.region.globalY,
            x: loginData.region.x,
            y: loginData.region.y
          });
        }
      } else {
        emit('region', payload);
      }
    }
    if (evt.type === 'uuid-names' && evt.names) {
      evt.names.forEach(function (row) {
        if (row.id && row.name) cacheName(row.id, row.name);
      });
      refreshNamedEntities();
      return;
    }
    if (evt.type === 'agent-name' && evt.data) {
      cacheName(evt.data.agentId, evt.data.name);
      refreshNamedEntities();
      return;
    }
    if (evt.type === 'parcel' && evt.data) {
      parcelPacketCount++;
      const p = evt.data;
      if (p.source === 'info' && p.parcelId &&
          finishParcelInfoRequest(p.parcelId, placeInfoFromParcel(p), null)) {
        return;
      }
      emitParcelFromData(p, p.source || 'udp');
      return;
    }
    if (evt.type === 'parcel-debug') {
      parcelPacketCount++;
      const d = evt.debug || {};
      const text = 'ParcelProperties received but not parsed (result=' + (d.requestResult !== undefined ? d.requestResult : '?') +
        ' seq=' + (d.sequenceId !== undefined ? d.sequenceId : '?') +
        (d.reason ? ' reason=' + d.reason : '') +
        (d.error ? ' err=' + d.error : '') + ')';
      if (text !== lastParcelDiag) {
        lastParcelDiag = text;
        FSErrors.warn('parcel', text, true);
      }
    }
  }

  async function resolveBuddyNames(buddies) {
    if (!buddies.length) return buddies;
    queueNameResolve(buddies.map(function (b) { return b.id; }));
    return buddies.slice();
  }

  async function login(credentials) {
    sessionLost = false;
    bridge = new FSBridge.Bridge(credentials.bridgeUrl);
    const ok = await bridge.isAvailable();
    if (!ok) {
      throw new Error(
        'Bridge not running. Start it with: start-minibee.bat (requires PHP curl + sockets)'
      );
    }

    loginData = await FSLoginSL.loginInteractive(
      bridge,
      credentials,
      credentials.onChallenge || function () {
        return Promise.reject(new Error('Login requires user interaction (TOS/MFA).'));
      }
    );

    if (loginData.seedCaps) {
      if (loginData.seedCaps.ok) {
        applyLoginSeedCaps(loginData.seedCaps);
      } else if (loginData.seedCaps.error) {
        FSErrors.warn('caps', 'Bridge login seed grant: ' + loginData.seedCaps.error, false);
      }
    }
    if (!capsReady) {
      await bootstrapLoginCapsBeforeCircuit();
    }

    FSEventQueue.stop();

    if (circuitSessionId) {
      await bridge.closeCircuit(circuitSessionId);
      circuitSessionId = null;
      circuit = null;
    }

    const open = await bridge.openCircuit(loginData.simIp, loginData.simPort, {
      circuitCode: loginData.circuitCode,
      sessionId: loginData.sessionId,
      agentId: loginData.agent.id
    });
    circuitSessionId = open.sessionId;
    circuitLocalPort = open.localPort || 0;
    const bootstrap = {
      sessionId: open.sessionId,
      localPort: open.localPort || 0,
      packets: open.packets || [],
      sent: open.sent || 0,
      recv: open.recv || 0,
      bytesSent: open.bytesSent || 0,
      useCircuitSeq: open.useCircuitSeq || 1,
      target: open.sim || (loginData.simIp + ':' + loginData.simPort)
    };
    updateBridgeCircuitContext(circuitLocalPort);

    circuit = new FSSLCircuit.Circuit(bridge, circuitSessionId);
    circuit.on(handleCircuitEvent);
    circuit.setSpawn({ lookAt: loginData.lookAt });
    circuit.setTarget(loginData.simIp, loginData.simPort);

    try {
      await circuit.connect(
        loginData.agent.id,
        loginData.sessionId,
        loginData.circuitCode,
        bootstrap
      );
      circuit.start();
      if (circuit._lastLocalPort) {
        circuitLocalPort = circuit._lastLocalPort;
      }
      updateBridgeCircuitContext(circuitLocalPort);
    } catch (err) {
      circuit.stop();
      circuit = null;
      if (circuitSessionId) {
        await bridge.closeCircuit(circuitSessionId);
        circuitSessionId = null;
      }
      throw err;
    }

    loginData.position = circuit.position;
    if (circuit.regionId) {
      loginData.region.id = circuit.regionId;
    }

    let buddies = loginData.buddies.slice();
    await resolveBuddyNames(buddies);
    if (!cleanCapUrl(loginData.seedCapability)) {
      systemNote('Warning: login returned no seed capability URL. Waiting for sim...');
    } else {
      if (loginData.seedCapabilityRaw) {
        FSErrors.info('caps', 'Seed URL fixed from: ' +
          loginData.seedCapabilityRaw.replace(/^https?:\/\//i, '').slice(0, 72), false);
      }
      noteSeedUrl(loginData.seedCapability, 'login');
    }
    queueNameResolve(buddies.map(function (b) { return b.id; }));

    const parcel = {
      localId: 0,
      name: 'Current parcel',
      desc: '',
      area: 0,
      primsUsed: 0,
      primsTotal: 0,
      ownerId: loginData.agent.id,
      ownerName: loginData.agent.displayName,
      canEdit: true,
      access: 0,
      pushRestricted: false,
      allowBuild: false,
      allowScripts: true,
      musicUrl: '',
      mediaUrl: '',
      stub: true
    };

    const payload = {
      agent: loginData.agent,
      region: loginData.region,
      grid: credentials.grid,
      gridName: (FSLoginSL.GRIDS[credentials.grid] || {}).name || credentials.grid,
      mapServerUrl: getMapServerUrl(),
      buddies: buddies,
      parcel: parcel,
      position: circuit.position
    };

    emit('connected', payload);
    startPositionSync();
    if (!capsReady) {
      scheduleCapBootstrap(false);
    }
    postLoginMotdChat(loginData.message);
    postRegionArrivalChat(loginData.region.name);

    return payload;
  }

  async function logout() {
    sessionLost = false;
    stopPositionSync();
    if (circuit) {
      try {
        await circuit.logout();
      } catch (_e) { /* ignore */ }
      circuit = null;
    }
    if (bridge && circuitSessionId) {
      await bridge.closeCircuit(circuitSessionId);
      circuitSessionId = null;
    }
    landCapsPromise = null;
    loginData = null;
    displayNamesCapUrl = null;
    remoteParcelCapUrl = null;
    eventQueueCapUrl = null;
    if (eventQueueRestartTimer) {
      clearTimeout(eventQueueRestartTimer);
      eventQueueRestartTimer = null;
    }
    FSEventQueue.stop();
    capBootstrapPromise = null;
    capsReady = false;
    lastGoodSeedCapability = '';
    circuitReady = false;
    agentPlaced = false;
    circuitServicesStarted = false;
    udpPacketsReceived = 0;
    udpRecvLogged = false;
    eventQueueWanted = false;
    lastHttpParcelAt = 0;
    eventQueueRecoverPromise = null;
    teleportFinishReceived = false;
    teleportArrivalUntil = 0;
    postTeleportCapGraceUntil = 0;
    unresolvedPacketSeen.clear();
    mapBlockWaiters.forEach(function (waiter) {
      clearTimeout(waiter.timer);
      if (waiter.reject) waiter.reject(new Error('Disconnected'));
    });
    mapBlockWaiters = [];
    mapAgentQueue = [];
    mapAgentInflight = null;
    mapAgentRequestedAt.clear();
    circuitLocalPort = 0;
    lastCapError = '';
    lastCapErrorNote = '';
    lastSeedHost = '';
    if (capBootstrapTimer) {
      clearTimeout(capBootstrapTimer);
      capBootstrapTimer = null;
    }
    if (capBootstrapRetryTimer) {
      clearTimeout(capBootstrapRetryTimer);
      capBootstrapRetryTimer = null;
    }
    if (capBootstrapFallbackTimer) {
      clearTimeout(capBootstrapFallbackTimer);
      capBootstrapFallbackTimer = null;
    }
    parcelRequestCount = 0;
    parcelPacketCount = 0;
    refreshParcelRunning = false;
    refreshParcelQueued = false;
    lastParcelDiag = '';
    nameCache.clear();
    clearImDedup();
    clearPaymentDedup();
    pendingNameIds.clear();
    if (nameResolveTimer) {
      clearTimeout(nameResolveTimer);
      nameResolveTimer = null;
    }
    if (nameResolveRetryTimer) {
      clearTimeout(nameResolveRetryTimer);
      nameResolveRetryTimer = null;
    }
    emit('disconnected');
  }

  function sendChat(text, options) {
    if (simActionsBlocked()) return;
    const parsed = parseNearbyChatInput(text, options && options.type || 'normal');
    if (!parsed.text) return;
    const typeMap = { whisper: 0, normal: 1, shout: 2 };
    const chatType = typeMap[parsed.type] !== undefined ? typeMap[parsed.type] : 1;
    circuit.say(parsed.text, chatType, parsed.channel);
    emit('chat', {
      id: FSUtils.uuid(),
      fromId: loginData.agent.id,
      fromName: loginData.agent.displayName,
      text: parsed.text,
      type: parsed.type,
      source: 'agent',
      channel: parsed.channel,
      timestamp: Date.now(),
      outgoing: true
    });
  }

  function sendIm(sessionId, text) {
    if (simActionsBlocked() || !loginData) return;
    const session = FSState.get().imSessions[sessionId];
    if (!session) return;
    const toId = normAgentId(session.participant.id);
    const fromName = loginData.agent.first + ' ' + loginData.agent.last;
    const regionId = (circuit && circuit.regionId) ||
      (loginData.region && loginData.region.id) ||
      '00000000-0000-0000-0000-000000000000';
    const imId = FSUtils.uuid();
    circuit.sendIm(toId, text, fromName, regionId, { imId: imId });
    emit('im', {
      sessionId: sessionId,
      participant: session.participant,
      message: {
        id: imId,
        imId: imId,
        fromId: loginData.agent.id,
        fromName: loginData.agent.displayName,
        text: text,
        outgoing: true,
        timestamp: Date.now()
      }
    });
  }

  async function updateParcel(data) {
    if (simActionsBlocked() || !loginData) return data;
    const p = FSState.get().parcel || {};
    if (!FSUtils.canEditParcel(p, loginData.agent.id)) {
      throw new Error('You do not have permission to edit this parcel');
    }
    const flags = 0xFFFFFFFF;
    let parcelFlags = p.parcelFlags || 0;
    if (data.pushRestricted) parcelFlags |= PF_RESTRICT_PUSHOBJECT;
    else parcelFlags &= ~PF_RESTRICT_PUSHOBJECT;
    if (data.allowBuild) parcelFlags |= PF_CREATE_OBJECTS;
    else parcelFlags &= ~PF_CREATE_OBJECTS;
    if (data.allowScripts) parcelFlags |= PF_ALLOW_OTHER_SCRIPTS;
    else parcelFlags &= ~PF_ALLOW_OTHER_SCRIPTS;
    await circuit.updateParcel({
      localId: p.localId || 0,
      flags: flags,
      parcelFlags: parcelFlags,
      name: data.name,
      desc: data.desc,
      musicUrl: data.musicUrl,
      mediaUrl: data.mediaUrl
    });
    emit('parcel-updated', data);
    return data;
  }

  async function waitForParcelUdpReply(timeoutMs, baseline) {
    const before = baseline !== undefined ? baseline : parcelPacketCount;
    const deadline = Date.now() + (timeoutMs || 4000);
    return new Promise(function (resolve) {
      function tick() {
        if (parcelPacketCount > before) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        if (circuit && circuit.kickPoll) circuit.kickPoll();
        setTimeout(tick, 350);
      }
      tick();
    });
  }

  async function waitForRichParcelData(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    return new Promise(function (resolve) {
      function tick() {
        const parcel = FSState.get().parcel;
        const score = parcelRichnessScore(parcel);
        if (score >= 28 || Date.now() >= deadline) {
          resolve(score);
          return;
        }
        if (circuit && circuit.kickPoll) circuit.kickPoll();
        setTimeout(tick, 400);
      }
      tick();
    });
  }

  async function refreshParcelNow(options) {
    const opts = options || {};
    const force = !!opts.force;
    if (!loginData || pendingTeleportLoc || sessionLost) return FSState.get().parcel;
    if (!circuit || !circuit.handshakeDone) return FSState.get().parcel;

    const storedBefore = FSState.get().parcel;
    const now = Date.now();
    if (!force && parcelHasRichData(storedBefore) &&
        (now - lastParcelRefreshAt) < PARCEL_REFRESH_MIN_INTERVAL_MS) {
      return storedBefore;
    }
    lastParcelRefreshAt = now;

    ensureEventQueuePoll('parcel refresh');
    const regionId = (circuit && circuit.regionId) || loginData.region.id || '';
    if (regionId) loginData.region.id = regionId;
    const pos = (circuit && circuit.position) || loginData.spawnPosition || loginData.position;

    if (circuit) {
      parcelRequestCount++;
      const pktBaseline = parcelPacketCount;
      await circuit.requestParcel();
      if (pendingTeleportLoc) return FSState.get().parcel;
      if (circuit._agentParcelLocalId >= 0) {
        await circuit.requestParcelByLocalId(circuit._agentParcelLocalId);
      }
      if (pendingTeleportLoc) return FSState.get().parcel;
      await waitForParcelUdpReply(6000, pktBaseline);
      await waitForRichParcelData(5000);
      FSErrors.info('parcel', 'Requested parcel at (' + Math.round(pos.x) + ',' + Math.round(pos.y) +
        ') localId=' + (circuit._agentParcelLocalId >= 0 ? circuit._agentParcelLocalId : '?') +
        ' [req #' + parcelRequestCount + ', pkts ' + parcelPacketCount +
        ', udp ' + udpPacketsReceived + ']', false);
    } else {
      FSErrors.error('parcel', 'No UDP circuit for parcel request', true);
    }

    if (pendingTeleportLoc) return FSState.get().parcel;

    const capsBusy = !!(capBootstrapPromise || capBootstrapTimer || landCapsPromise);
    if (!remoteParcelCapUrl) {
      if (capBootstrapPromise) {
        try {
          await capBootstrapPromise;
        } catch (_e) { /* bootstrap retry handles this */ }
      }
      if (!remoteParcelCapUrl && !capBootstrapPromise && !capsBusy) {
        try {
          const ok = await ensureLandCaps();
          if (pendingTeleportLoc) return FSState.get().parcel;
          if (!ok) {
            const postTeleportGrace = Date.now() < postTeleportCapGraceUntil;
            if (!postTeleportGrace) {
              FSErrors.warn('parcel', 'RemoteParcelRequest cap not granted (UDP only).', true);
            }
          }
        } catch (err) {
          const msg = err.message || String(err);
          const postTeleportGrace = Date.now() < postTeleportCapGraceUntil;
          if (postTeleportGrace && /404|cap not found/i.test(msg)) {
            FSErrors.info('parcel', 'Land cap grant pending after teleport (will retry)', false);
          } else {
            FSErrors.error('parcel', 'Land cap grant for parcel: ' + msg, true);
          }
        }
      }
    }
    if (pendingTeleportLoc) return FSState.get().parcel;
    const storedParcel = FSState.get().parcel;
    const needsHttpParcel = parcelNeedsHttpLookup(storedParcel);
    if (bridge && remoteParcelCapUrl && needsHttpParcel) {
      if ((now - lastHttpParcelAt) < HTTP_PARCEL_MIN_INTERVAL_MS) {
        return FSState.get().parcel;
      }
      lastHttpParcelAt = now;
      try {
        const remote = await FSCaps.fetchRemoteParcel(bridge, remoteParcelCapUrl, {
          position: pos,
          regionId: regionId,
          regionGridX: loginData.region.x,
          regionGridY: loginData.region.y
        });
        if (pendingTeleportLoc) return FSState.get().parcel;
        const parcelHint = remote.parcelId || remote.name ||
          (remote.rawBody ? remote.rawBody.slice(0, 120) : JSON.stringify(remote).slice(0, 80));
        FSErrors.info('parcel', 'HTTP RemoteParcelRequest: ' + parcelHint, false);
        if (remote && remote.parcelId && remote.parcelId !== '00000000-0000-0000-0000-000000000000' && circuit) {
          const infoBaseline = parcelPacketCount;
          await circuit.requestParcelInfo(remote.parcelId);
          if (pendingTeleportLoc) return FSState.get().parcel;
          await waitForParcelUdpReply(3500, infoBaseline);
        }
        if (remote && (remote.name || remote.desc || remote.area)) {
          emitParcelFromData(remote, 'http');
        } else if (remote && remote.parcelId &&
            remote.parcelId !== '00000000-0000-0000-0000-000000000000') {
          FSErrors.info('parcel', 'RemoteParcelRequest parcel_id=' + remote.parcelId +
            ' (awaiting ParcelInfoReply)', false);
        } else if (remote) {
          FSErrors.warn('parcel', 'RemoteParcelRequest returned no parcel_id' +
            (remote.rawBody ? ' body=' + remote.rawBody : ''), true);
        }
      } catch (err) {
        const msg = err.message || String(err);
        if (/404|cap not found/i.test(msg)) {
          remoteParcelCapUrl = null;
          capsReady = false;
        }
        FSErrors.error('parcel', 'Remote parcel lookup failed: ' + msg, true);
      }
    }
    if (!parcelPacketCount && parcelRequestCount >= 3) {
      FSErrors.warn('parcel', 'No ParcelProperties packets received from sim yet (sent ' +
        parcelRequestCount + ' requests). Check Log tab.', true);
    }
    return FSState.get().parcel;
  }

  async function refreshParcel(options) {
    if (!loginData || pendingTeleportLoc) return FSState.get().parcel;
    if (refreshParcelRunning) {
      refreshParcelQueued = true;
      return FSState.get().parcel;
    }
    refreshParcelRunning = true;
    try {
      return await refreshParcelNow(options);
    } finally {
      refreshParcelRunning = false;
      if (refreshParcelQueued) {
        refreshParcelQueued = false;
        const parcel = FSState.get().parcel;
        if (!parcelHasRichData(parcel)) {
          setTimeout(function () {
            refreshParcel();
          }, parcelPacketCount > 0 ? 5000 : 12000);
        }
      }
    }
  }

  function sendTeleportOffer(targetId, message) {
    if (simActionsBlocked() || !loginData || !targetId) return Promise.resolve();
    const regionName = (loginData.region && loginData.region.name) || 'Region';
    const pos = circuit.position || loginData.position || { x: 128, y: 128, z: 25 };
    const slurl = FSTeleport.buildSlurl(regionName, pos);
    const text = (String(message || 'Join me!').trim() || 'Join me!') + '\r\n' + slurl;
    FSErrors.info('teleport', 'StartLure -> ' + normAgentId(targetId).slice(0, 8), false);
    return circuit.startLure([targetId], text);
  }

  function sendTeleportRequest(targetId, message) {
    if (simActionsBlocked() || !loginData || !targetId) return Promise.resolve();
    return circuit.sendIm(
      targetId,
      String(message || '').trim(),
      agentFullName(),
      currentRegionId(),
      {
        dialog: FSTeleport.IM_TELEPORT_REQUEST,
        imId: '00000000-0000-0000-0000-000000000000',
        timestamp: 0,
        binaryBucket: ''
      }
    );
  }

  function acceptTeleportOffer(offer) {
    if (!circuit || !offer || !offer.lureId) return Promise.resolve();
    const lureId = String(offer.lureId);
    if (lureId === '00000000-0000-0000-0000-000000000000') return Promise.resolve();
    let loc = null;
    if (offer.location) {
      loc = locationFromGrid(
        offer.location.gridX,
        offer.location.gridY,
        offer.location.position,
        null
      );
      loc.flags = FSTeleport.TELEPORT_FLAGS.VIA_LURE;
    }
    const lureFlags = FSTeleport.lureAcceptFlags(!!offer.godlike);
    beginSimInitiatedTeleport(FSTeleport.TELEPORT_FLAGS.VIA_LURE, { loc: loc });
    return circuit.acceptLure(lureId, lureFlags);
  }

  function declineTeleportOffer(offer) {
    if (!circuit || !loginData || !offer || !offer.fromId || !offer.lureId) {
      return Promise.resolve();
    }
    return circuit.sendIm(
      offer.fromId,
      '',
      agentFullName(),
      currentRegionId(),
      {
        dialog: FSTeleport.IM_LURE_DECLINED,
        imId: offer.lureId,
        timestamp: 0,
        binaryBucket: ''
      }
    );
  }

  function acceptTeleportRequest(request, message) {
    if (!request || !request.fromId) return Promise.resolve();
    return sendTeleportOffer(request.fromId, message || 'Come on over.');
  }

  function declineTeleportRequest(_request) {
    return Promise.resolve();
  }

  function start() { /* circuit started on login */ }
  function stop() { logout(); }

  return {
    login: login,
    logout: logout,
    sendChat: sendChat,
    replyScriptDialog: replyScriptDialog,
    replyScriptPermission: replyScriptPermission,
    acceptCallingCard: acceptCallingCard,
    declineCallingCard: declineCallingCard,
    isBuddy: isBuddy,
    offerFriendship: offerFriendship,
    payResident: payResident,
    searchDirectory: searchDirectory,
    sendIm: sendIm,
    sendTeleportOffer: sendTeleportOffer,
    sendTeleportRequest: sendTeleportRequest,
    acceptTeleportOffer: acceptTeleportOffer,
    declineTeleportOffer: declineTeleportOffer,
    acceptTeleportRequest: acceptTeleportRequest,
    declineTeleportRequest: declineTeleportRequest,
    resolveLocation: resolveLocation,
    teleportTo: teleportTo,
    teleportHome: teleportHome,
    teleportToLandmark: teleportToLandmark,
    cancelTeleport: cancelTeleport,
    isTeleportInProgress: isTeleportInProgress,
    requestMapArea: requestMapArea,
    requestMapAgentCounts: requestMapAgentCounts,
    getMapServerUrl: getMapServerUrl,
    getMapTileUrl: getMapTileUrl,
    getBridgeUrl: getBridgeUrl,
    updateParcel: updateParcel,
    refreshParcel: refreshParcel,
    fetchParcelInfo: fetchParcelInfo,
    start: start,
    stop: stop
  };
})();
