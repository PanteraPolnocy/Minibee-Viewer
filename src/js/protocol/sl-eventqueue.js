/**
 * EventQueueGet long-poll (TeleportFinish, CrossedRegion, EnableSimulator, etc.).
 */
const FSEventQueue = (function () {
  'use strict';

  let bridge = null;
  let pollUrl = '';
  let running = false;
  let stopRequested = false;
  let loopPromise = null;
  let lastAck = null;
  let onMessage = null;
  let pollAbort = null;
  let lastPollRawBody = '';
  const EQ_POLL_MS = 95000;
  const EQ_POLL_MS_IDLE = 65000;
  const EQ_POLL_MIN_HOLD_MS = 10000;
  const EQ_POLL_ERROR_RETRY_MS = 1000;
  const EQ_POLL_ERROR_RETRY_INC_MS = 3000;
  const EQ_POLL_MAX_ERRORS = 15;
  let teleportActive = false;
  let pendingStop = false;
  let pendingStopResetAck = true;
  let pollInFlight = false;
  let handoffErrorCount = 0;
  let steadyErrorCount = 0;
  let onFatal = null;

  function doStop(resetAck) {
    stopRequested = true;
    running = false;
    pollInFlight = false;
    handoffErrorCount = 0;
    steadyErrorCount = 0;
    if (pollAbort) {
      try { pollAbort.abort(); } catch (_e) { /* ignore */ }
      pollAbort = null;
    }
    if (resetAck !== false) {
      lastAck = null;
    }
    onMessage = null;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function firstRow(block) {
    if (!block) return null;
    if (Array.isArray(block)) return block[0] || null;
    if (typeof block === 'object') return block;
    return null;
  }

  function bytesFromValue(value) {
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) {
      return new Uint8Array(value.map(function (n) { return Number(n) & 0xFF; }));
    }
    if (typeof value === 'string') {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
        const parts = value.split('.').map(function (p) { return parseInt(p, 10); });
        return new Uint8Array(parts);
      }
      try {
        const bin = atob(value);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      } catch (_e) {
        return new Uint8Array(0);
      }
    }
    return new Uint8Array(0);
  }

  function decodeIp(value) {
    if (typeof value === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(value)) {
      return value;
    }
    const bytes = bytesFromValue(value);
    if (bytes.length >= 4) {
      return bytes[0] + '.' + bytes[1] + '.' + bytes[2] + '.' + bytes[3];
    }
    if (typeof value === 'number' && value > 0) {
      const n = value >>> 0;
      return ((n >>> 24) & 0xFF) + '.' + ((n >>> 16) & 0xFF) + '.' +
        ((n >>> 8) & 0xFF) + '.' + (n & 0xFF);
    }
    return '';
  }

  function decodeU64(value) {
    const bytes = bytesFromValue(value);
    if (bytes.length >= 8) {
      let hi = 0n;
      let lo = 0n;
      for (let i = 0; i < 4; i++) hi = (hi << 8n) | BigInt(bytes[i]);
      for (let j = 4; j < 8; j++) lo = (lo << 8n) | BigInt(bytes[j]);
      return (hi << 32n) | lo;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return BigInt(Math.trunc(value));
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      return BigInt(value);
    }
    return 0n;
  }

  function parseTeleportFinish(body) {
    const info = firstRow(body && body.Info) ||
      firstRow(body && body.info) ||
      firstRow(body) || body || {};
    return {
      url: String(info.SeedCapability || info.seed_capability || info.SeedCap || info.seedCap || ''),
      simIp: decodeIp(info.SimIP || info.sim_ip || info.SimIp),
      simPort: parseInt(info.SimPort || info.sim_port || 0, 10) || 0,
      regionHandle: decodeU64(info.RegionHandle || info.region_handle || info.handle),
      teleportFlags: parseInt(info.TeleportFlags || info.teleport_flags || 0, 10) || 0
    };
  }

  function parseCrossedRegion(body) {
    // EventQueue delivers the message's blocks directly on the body (RegionData,
    // Info) — there is no CrossedRegion wrapper.
    const b = body || {};
    const region = firstRow(b.RegionData) || {};
    const info = firstRow(b.Info) || {};
    const pos = info.Position || info.position;
    const look = info.LookAt || info.look_at;
    return {
      url: String(region.SeedCapability || region.seed_capability || ''),
      simIp: decodeIp(region.SimIP || region.sim_ip),
      simPort: parseInt(region.SimPort || region.sim_port || 0, 10) || 0,
      regionHandle: decodeU64(region.RegionHandle || region.region_handle),
      position: Array.isArray(pos) ? { x: pos[0], y: pos[1], z: pos[2] } : null,
      lookAt: Array.isArray(look) ? { x: look[0], y: look[1], z: look[2] } : null
    };
  }

  function parseEnableSimulator(body) {
    const info = firstRow(body && body.SimulatorInfo) ||
      firstRow(body && body.simulator_info) ||
      firstRow(body && body.Info) ||
      firstRow(body) || body || {};
    const simIp = decodeIp(info.IP || info.Ip || info.SimIP || info.sim_ip || info.ip);
    const simPort = parseInt(info.Port || info.SimPort || info.sim_port || info.port || 0, 10) || 0;
    const regionHandle = decodeU64(info.Handle || info.RegionHandle || info.region_handle || info.handle);
    return { simIp: simIp, simPort: simPort, regionHandle: regionHandle };
  }

  function parseEstablishAgentCommunication(body) {
    const row = firstRow(body) || body || {};
    const simHost = String(pickValue(row, [
      'sim-ip-and-port', 'sim_ip_and_port', 'SimIpAndPort', 'sim-ip', 'sim_ip'
    ]) || '');
    const url = String(pickValue(row, [
      'seed-capability', 'seed_capability', 'SeedCapability', 'seedCap'
    ]) || '');
    let simIp = decodeIp(pickValue(row, ['sim-ip', 'sim_ip', 'SimIP', 'SimIp', 'IP', 'Ip']));
    let simPort = parseInt(pickValue(row, ['sim-port', 'sim_port', 'SimPort', 'Port', 'port']) || 0, 10) || 0;
    if (!simIp && simHost) {
      const slash = simHost.lastIndexOf(':');
      if (slash > 0) {
        simIp = simHost.slice(0, slash);
        simPort = parseInt(simHost.slice(slash + 1), 10) || simPort;
      } else {
        simIp = simHost;
      }
    }
    return { url: url, simIp: simIp, simPort: simPort, simHost: simHost };
  }

  function parseTeleportFailed(body) {
    const info = firstRow(body && body.Info) || body || {};
    return {
      reason: String(info.Reason || info.reason || 'Teleport failed')
    };
  }

  function pickValue(row, names) {
    if (!row || typeof row !== 'object') return undefined;
    for (let i = 0; i < names.length; i++) {
      const key = names[i];
      if (row[key] !== undefined && row[key] !== null) return row[key];
    }
    const lower = names.map(function (n) { return String(n).toLowerCase(); });
    const keys = Object.keys(row);
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j];
      if (lower.indexOf(key.toLowerCase()) >= 0) {
        return row[key];
      }
    }
    return undefined;
  }

  function uint32Value(value, fallback) {
    return FSLLSD.uint32FromValue(value, fallback);
  }

  function intValue(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback || 0;
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    const text = String(value).trim();
    const n = parseInt(text, 10);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function normalizeBlockRows(block) {
    if (!block) return [];
    if (Array.isArray(block)) return block;
    if (typeof block === 'object') {
      const numeric = Object.keys(block).filter(function (k) { return /^\d+$/.test(k); })
        .sort(function (a, b) { return Number(a) - Number(b); });
      if (numeric.length) return numeric.map(function (k) { return block[k]; });
      return [block];
    }
    return [];
  }

  function scanParcelFlags(node, depth) {
    if (!node || depth > 8) return 0;
    if (typeof node !== 'object') return 0;
    if (node instanceof Uint8Array) {
      return uint32Value(node, 0);
    }
    if (Array.isArray(node)) {
      let found = 0;
      for (let i = 0; i < node.length; i++) {
        found = scanParcelFlags(node[i], depth + 1) || found;
      }
      return found;
    }
    let found = 0;
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (/^(parcelflags?|parcel_flags)$/i.test(key)) {
        const v = uint32Value(node[key]);
        if (v) found = v;
      }
      const nested = scanParcelFlags(node[key], depth + 1);
      if (nested) found = nested;
    }
    return found;
  }

  function extractParcelFlags(body, row) {
    let parcelFlags = uint32Value(pickValue(row, ['ParcelFlags', 'parcel_flags']), 0);
    if (!parcelFlags) {
      const rows = normalizeBlockRows(body && body.ParcelData);
      for (let i = 0; i < rows.length; i++) {
        parcelFlags = uint32Value(pickValue(rows[i], ['ParcelFlags', 'parcel_flags']), 0);
        if (parcelFlags) break;
      }
    }
    if (!parcelFlags) {
      const extRows = normalizeBlockRows(body && body.ParcelExtendedFlags);
      for (let j = 0; j < extRows.length; j++) {
        parcelFlags = uint32Value(pickValue(extRows[j], ['Flags', 'flags']), 0);
        if (parcelFlags) break;
      }
    }
    if (!parcelFlags) {
      parcelFlags = scanParcelFlags(body, 0);
    }
    if (!parcelFlags && lastPollRawBody) {
      parcelFlags = FSLLSD.uint32FromParcelFlagsXml(lastPollRawBody);
    }
    return parcelFlags;
  }

  function floatValue(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback || 0;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function uuidValue(value) {
    const text = String(value || '').trim();
    if (!text || text === '00000000-0000-0000-0000-000000000000') return '';
    return text;
  }

  function stringValue(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function vec3Point(value) {
    if (!value) return null;
    if (Array.isArray(value) && value.length >= 3) {
      return {
        x: Math.round(floatValue(value[0], 0)),
        y: Math.round(floatValue(value[1], 0)),
        z: Math.round(floatValue(value[2], 0))
      };
    }
    if (typeof value === 'object') {
      return {
        x: Math.round(floatValue(value.x || value.X, 0)),
        y: Math.round(floatValue(value.y || value.Y, 0)),
        z: Math.round(floatValue(value.z || value.Z, 0))
      };
    }
    return null;
  }

  function parseParcelProperties(body) {
    const row = firstRow(body && body.ParcelData) || body.ParcelData || body || {};
    const requestResult = intValue(pickValue(row, ['RequestResult', 'request_result']), 0);
    if (requestResult === -1) return null;

    const ownerPrims = intValue(pickValue(row, ['OwnerPrims', 'owner_prims']), 0);
    const groupPrims = intValue(pickValue(row, ['GroupPrims', 'group_prims']), 0);
    const otherPrims = intValue(pickValue(row, ['OtherPrims', 'other_prims']), 0);
    const selectedPrims = intValue(pickValue(row, ['SelectedPrims', 'selected_prims']), 0);
    const maxPrims = intValue(pickValue(row, ['MaxPrims', 'max_prims']), 0);
    const totalPrims = intValue(pickValue(row, ['TotalPrims', 'total_prims']), 0);
    const parcelPrimBonus = floatValue(pickValue(row, ['ParcelPrimBonus', 'parcel_prim_bonus']), 1);
    const primUsed = ownerPrims + groupPrims + otherPrims + selectedPrims;
    const primBonus = parcelPrimBonus > 0 ? parcelPrimBonus : 1;
    const primCapacity = Math.round(maxPrims * primBonus);

    const mediaData = firstRow(body && body.MediaData) || {};
    const parcelFlags = extractParcelFlags(body, row);
    if (!parcelFlags && typeof window !== 'undefined') {
      window.__parcelFlagsDebug = {
        rowKeys: Object.keys(row || {}),
        bodyKeys: Object.keys(body || {}),
        hasParcelFlagsKey: Object.prototype.hasOwnProperty.call(row || {}, 'ParcelFlags') ||
          Object.prototype.hasOwnProperty.call(row || {}, 'parcel_flags'),
        parcelFlagsType: typeof pickValue(row, ['ParcelFlags', 'parcel_flags']),
        parcelFlagsRaw: pickValue(row, ['ParcelFlags', 'parcel_flags'])
      };
    }

    const parcel = {
      localId: intValue(pickValue(row, ['LocalID', 'local_id']), -1),
      sequenceId: intValue(pickValue(row, ['SequenceID', 'sequence_id']), 0),
      ownerId: uuidValue(pickValue(row, ['OwnerID', 'owner_id'])),
      isGroupOwned: !!pickValue(row, ['IsGroupOwned', 'is_group_owned']),
      area: intValue(pickValue(row, ['Area', 'area']), 0),
      parcelFlags: parcelFlags,
      salePrice: intValue(pickValue(row, ['SalePrice', 'sale_price']), 0),
      name: stringValue(pickValue(row, ['Name', 'name'])),
      desc: stringValue(pickValue(row, ['Desc', 'description', 'desc'])),
      musicUrl: stringValue(pickValue(row, ['MusicURL', 'music_url'])),
      mediaUrl: stringValue(pickValue(row, ['MediaURL', 'media_url'])),
      mediaDesc: stringValue(pickValue(mediaData, ['MediaDesc', 'media_desc']) ||
        pickValue(row, ['MediaDesc', 'media_desc'])),
      mediaType: stringValue(pickValue(mediaData, ['MediaType', 'media_type']) ||
        pickValue(row, ['MediaType', 'media_type'])),
      groupId: uuidValue(pickValue(row, ['GroupID', 'group_id'])),
      snapshotId: uuidValue(pickValue(row, ['SnapshotID', 'snapshot_id'])),
      passPrice: intValue(pickValue(row, ['PassPrice', 'pass_price']), 0),
      passHours: floatValue(pickValue(row, ['PassHours', 'pass_hours']), 0),
      ownerPrims: ownerPrims,
      groupPrims: groupPrims,
      otherPrims: otherPrims,
      simWideMaxPrims: intValue(pickValue(row, ['SimWideMaxPrims', 'sim_wide_max_prims']), 0),
      simWideTotalPrims: intValue(pickValue(row, ['SimWideTotalPrims', 'sim_wide_total_prims']), 0),
      parcelPrimBonus: primBonus,
      primsUsed: primUsed > 0 ? primUsed : totalPrims,
      primsTotal: primCapacity || maxPrims,
      landingPoint: vec3Point(pickValue(row, ['UserLocation', 'user_location'])),
      landingType: intValue(pickValue(row, ['LandingType', 'landing_type']), 0),
      userLookAt: vec3Point(pickValue(row, ['UserLookAt', 'user_look_at'])),
      mediaId: uuidValue(pickValue(row, ['MediaID', 'media_id'])),
      mediaAutoScale: intValue(pickValue(mediaData, ['MediaAutoScale', 'media_auto_scale']) ||
        pickValue(row, ['MediaAutoScale', 'media_auto_scale']), 0),
      category: intValue(pickValue(row, ['Category', 'category']), 0),
      authBuyerId: uuidValue(pickValue(row, ['AuthBuyerID', 'auth_buyer_id']))
    };
    return parcel;
  }

  function handoffRetryDelayMs() {
    return EQ_POLL_ERROR_RETRY_MS +
      handoffErrorCount * EQ_POLL_ERROR_RETRY_INC_MS;
  }

  function noteHandoffPollIssue(label, elapsedMs, httpStatus) {
    handoffErrorCount = Math.min(handoffErrorCount + 1, EQ_POLL_MAX_ERRORS);
    if (typeof FSErrors === 'undefined') return;
    const sec = ((elapsedMs || 0) / 1000).toFixed(1);
    const statusNote = httpStatus ? (' HTTP ' + httpStatus) : '';
    FSErrors.info('eventqueue',
      'Handoff poll issue (' + sec + 's' + statusNote + '): ' + label +
      ' - retry in ' + (handoffRetryDelayMs() / 1000).toFixed(1) + 's', false);
  }

  async function pollOnce() {
    const startedAt = Date.now();
    pollInFlight = true;
    pollAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    try {
      const payload = { done: false };
      if (lastAck !== null && lastAck !== undefined) {
        payload.ack = lastAck;
      }
      const proxyOpts = { timeoutMs: teleportActive ? EQ_POLL_MS : EQ_POLL_MS_IDLE, parseLlsd: true };
      if (pollAbort) {
        proxyOpts.signal = pollAbort.signal;
      }
      const proxyFn = (bridge && typeof bridge.proxyPriority === 'function')
        ? bridge.proxyPriority.bind(bridge)
        : bridge.proxy.bind(bridge);
      const resp = await proxyFn(
        pollUrl,
        FSLLSD.mapXml(payload),
        'application/xml',
        proxyOpts
      );
      if (!resp) {
        throw new Error('EventQueue poll returned no response');
      }
      if (resp.status === 404) {
        return { stop: true, events: [], early: false, elapsedMs: Date.now() - startedAt };
      }
      if (resp.status === 499 || resp.status === 502 || resp.status >= 500) {
        const elapsedMs = Date.now() - startedAt;
        const early = teleportActive && elapsedMs < EQ_POLL_MIN_HOLD_MS;
        if (teleportActive && early) {
          noteHandoffPollIssue('empty response', elapsedMs, resp.status);
        } else if (teleportActive && typeof FSErrors !== 'undefined') {
          FSErrors.info('eventqueue', 'Handoff poll empty HTTP ' + resp.status, false);
        }
        return {
          events: [],
          early: early,
          elapsedMs: elapsedMs,
          handoffRetry: early,
          // A full-hold 5xx/499 is the sim's normal "no events" signal on a quiet
          // region — only treat an EARLY empty response as a real error, matching
          // lleventpoll.cpp (>= MIN_SECONDS_PASSED resets the error counter).
          steadyError: !teleportActive && elapsedMs < EQ_POLL_MIN_HOLD_MS
        };
      }
      if (resp.status < 200 || resp.status >= 300) {
        const snippet = String(resp.body || '').slice(0, 120);
        throw new Error('EventQueue poll HTTP ' + resp.status + (snippet ? (': ' + snippet) : ''));
      }
      lastPollRawBody = String(resp.body || '');
      // Prefer the LLSD already parsed in the native core; fall back to JS.
      const data = (resp.parsed !== undefined && resp.parsed !== null)
        ? resp.parsed
        : FSLLSD.parse(lastPollRawBody, resp.contentType || '');
      const ackId = data && (data.id !== undefined && data.id !== null ? data.id : data.ID);
      if (ackId !== undefined && ackId !== null) {
        lastAck = ackId;
      }
      const rawEvents = data && (data.events || data.Events);
      const events = Array.isArray(rawEvents) ? rawEvents : [];
      const elapsedMs = Date.now() - startedAt;
      const early = teleportActive && events.length === 0 && elapsedMs < EQ_POLL_MIN_HOLD_MS;
      if (teleportActive && events.length > 0) {
        handoffErrorCount = 0;
      } else if (early) {
        noteHandoffPollIssue('0 events', elapsedMs, resp.status);
      } else if (teleportActive) {
        handoffErrorCount = 0;
      }
      const missingId = events.length > 0 && (ackId === undefined || ackId === null);
      return {
        events: events,
        early: early,
        elapsedMs: elapsedMs,
        handoffRetry: early,
        missingId: missingId,
        // A fast empty poll in steady state is treated as an error to back off on.
        steadyError: !teleportActive && events.length === 0 && elapsedMs < EQ_POLL_MIN_HOLD_MS
      };
    } finally {
      pollAbort = null;
      pollInFlight = false;
    }
  }

  async function runLoop() {
    while (running && !stopRequested) {
      try {
        const result = await pollOnce();
        if (result.stop) {
          running = false;
          break;
        }
        // A batch with no id ack can't be acknowledged; the sim will resend it,
        // so dispatching would double-process. Drop it (as Firestorm does).
        if (result.missingId) {
          if (typeof FSErrors !== 'undefined') {
            FSErrors.warn('eventqueue', 'EventQueue batch had no id ack; dropped', false);
          }
        } else {
          (result.events || []).forEach(function (ev) {
            if (onMessage && ev) onMessage(ev);
          });
        }
        if (teleportActive && typeof FSErrors !== 'undefined') {
          const n = (result.events || []).length;
          if (n > 0) {
            FSErrors.info('eventqueue', 'Handoff poll returned ' + n + ' event(s)', false);
          }
        }
        if (result.handoffRetry) {
          if (handoffErrorCount >= EQ_POLL_MAX_ERRORS) {
            if (typeof FSErrors !== 'undefined') {
              FSErrors.warn('eventqueue',
                'EventQueue handoff poll stalled after ' + EQ_POLL_MAX_ERRORS + ' early responses', true);
            }
            await sleep(5000);
          } else {
            await sleep(handoffRetryDelayMs());
          }
          continue;
        }
        if (teleportActive) {
          handoffErrorCount = 0;
        } else if (result.steadyError) {
          // Back off instead of hammering; give up after too many so a dead
          // main-region poll doesn't spin forever.
          steadyErrorCount += 1;
          if (steadyErrorCount >= EQ_POLL_MAX_ERRORS) {
            if (typeof FSErrors !== 'undefined') {
              FSErrors.error('eventqueue',
                'EventQueue poll failed ' + steadyErrorCount + ' times; stopping.', false);
            }
            if (onFatal) { try { onFatal(); } catch (_e) { /* ignore */ } }
            running = false;
            break;
          }
          await sleep(EQ_POLL_ERROR_RETRY_MS + steadyErrorCount * EQ_POLL_ERROR_RETRY_INC_MS);
          continue;
        } else {
          steadyErrorCount = 0;
        }
      } catch (err) {
        pollAbort = null;
        pollInFlight = false;
        if (!running || stopRequested) break;
        const msg = err.message || String(err);
        const isTimeout = /timed out/i.test(msg);
        const isAborted = /abort/i.test(msg);
        const isProxyStale = /proxy/i.test(msg) || /\b502\b/.test(msg);
        if (teleportActive) {
          handoffErrorCount = Math.min(handoffErrorCount + 1, EQ_POLL_MAX_ERRORS);
          if (isTimeout) {
            if (typeof FSErrors !== 'undefined') {
              FSErrors.info('eventqueue', 'Handoff poll timed out - retrying', false);
            }
            await sleep(200);
          } else if (!isAborted && !isProxyStale) {
            if (typeof FSErrors !== 'undefined') {
              FSErrors.warn('eventqueue', 'Handoff poll error: ' + msg, false);
            }
            await sleep(handoffRetryDelayMs());
          } else {
            await sleep(2500);
          }
        } else if (isTimeout || isAborted) {
          // Expected for a long-poll; not an error.
          await sleep(200);
        } else {
          steadyErrorCount += 1;
          if (typeof FSErrors !== 'undefined') {
            FSErrors.warn('eventqueue', 'Poll error: ' + msg, false);
          }
          if (steadyErrorCount >= EQ_POLL_MAX_ERRORS) {
            if (typeof FSErrors !== 'undefined') {
              FSErrors.error('eventqueue',
                'EventQueue poll failed ' + steadyErrorCount + ' times; stopping.', false);
            }
            if (onFatal) { try { onFatal(); } catch (_e) { /* ignore */ } }
            running = false;
            break;
          }
          await sleep(EQ_POLL_ERROR_RETRY_MS + steadyErrorCount * EQ_POLL_ERROR_RETRY_INC_MS);
        }
      }
    }
    pollInFlight = false;
    loopPromise = null;
  }

  function start(bridgeRef, url, handler, fatalHandler) {
    if (!bridgeRef || !url) return false;
    const nextUrl = String(url).trim();
    if (running && pollUrl === nextUrl) return true;
    forceStop(false);
    bridge = bridgeRef;
    pollUrl = nextUrl;
    onMessage = handler || null;
    onFatal = fatalHandler || null;
    lastAck = null;
    steadyErrorCount = 0;
    running = true;
    stopRequested = false;
    if (typeof FSErrors !== 'undefined') {
      try {
        const host = new URL(pollUrl).host;
        FSErrors.info('eventqueue', 'EventQueueGet polling ' + host, false);
      } catch (_e) {
        FSErrors.info('eventqueue', 'EventQueueGet polling started', false);
      }
    }
    loopPromise = runLoop();
    return true;
  }

  function stop(resetAck, options) {
    const opts = options || {};
    if (teleportActive && !opts.force) {
      pendingStop = true;
      pendingStopResetAck = resetAck !== false;
      return;
    }
    pendingStop = false;
    doStop(resetAck);
  }

  function forceStop(resetAck) {
    pendingStop = false;
    teleportActive = false;
    doStop(resetAck);
  }

  function flushPendingStop() {
    if (!pendingStop) return;
    pendingStop = false;
    doStop(pendingStopResetAck);
  }

  function isRunning() {
    return running;
  }

  function setTeleportActive(active) {
    teleportActive = !!active;
    if (!teleportActive) {
      flushPendingStop();
    }
  }

  function restartForHandoff() {
    teleportActive = true;
    pendingStop = false;
    handoffErrorCount = 0;
    if (!bridge || !pollUrl) return false;
    if (!running || !onMessage) {
      running = true;
      stopRequested = false;
      loopPromise = runLoop();
      return true;
    }
    // Keep the in-flight long poll alive. Aborting starts a duplicate EQ request and
    // the sim may deliver TeleportFinish on the abandoned connection.
    return true;
  }

  function kickPoll() {
    if (teleportActive || !running || stopRequested || !pollAbort) return;
    try { pollAbort.abort(); } catch (_e) { /* ignore */ }
  }

  return {
    start: start,
    stop: stop,
    isRunning: isRunning,
    setTeleportActive: setTeleportActive,
    restartForHandoff: restartForHandoff,
    kickPoll: kickPoll,
    parseTeleportFinish: parseTeleportFinish,
    parseCrossedRegion: parseCrossedRegion,
    parseEnableSimulator: parseEnableSimulator,
    parseEstablishAgentCommunication: parseEstablishAgentCommunication,
    parseTeleportFailed: parseTeleportFailed,
    parseParcelProperties: parseParcelProperties
  };
})();
