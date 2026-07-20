/**
 * Capability discovery, display names, and remote parcel lookup.
 */
const FSCaps = (function () {
  'use strict';

  const displayNamesInflight = new Map();

  function normId(id) {
    return String(id || '').toLowerCase();
  }

  function agentDisplayName(row) {
    return agentNameRecord(row).label;
  }

  function legacyUserName(first, last) {
    const f = String(first || '').trim();
    const l = String(last || '').trim();
    if (f && l) return l === 'Resident' ? f : (f + ' ' + l);
    return f || l || '';
  }

  function agentNameRecord(row) {
    const first = row.legacy_first_name || row.legacyFirstName || '';
    const last = row.legacy_last_name || row.legacyLastName || '';
    let userName = String(row.username || row.user_name || '').trim();
    if (!userName) userName = legacyUserName(first, last);
    const isDefault = row.is_display_name_default === true ||
      row.is_display_name_default === 'true' ||
      row.is_display_name_default === 1;
    const displayRaw = String(row.display_name || row.displayName || '').trim();
    const displayName = (!isDefault && displayRaw) ? displayRaw : '';
    let label = displayName || userName;
    if (!label && row.sl_id) label = String(row.sl_id).replace(/\./g, ' ');
    if (!label) label = row.id || 'Unknown';
    return {
      displayName: displayName,
      userName: userName,
      label: label
    };
  }

  function capUrl(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return String(value);
    if (value.url) return String(value.url);
    if (value.URI) return String(value.URI);
    if (value.uri) return String(value.uri);
    if (value.value && (value.type === 'uri' || value.type === 'URI')) return String(value.value);
    if (value['@uri']) return String(value['@uri']);
    if (value.href) return String(value.href);
    return '';
  }

  function findCap(caps, name) {
    if (!caps || typeof caps !== 'object') return '';
    if (caps[name]) return capUrl(caps[name]);
    const target = String(name || '').toLowerCase();
    const keys = Object.keys(caps);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === target) {
        return capUrl(caps[keys[i]]);
      }
    }
    return '';
  }

  function unwrapCaps(data) {
    if (!data || typeof data !== 'object') return {};
    if (data.error) {
      throw new Error(String(data.error));
    }
    if (Array.isArray(data)) {
      const out = {};
      data.forEach(function (row) {
        if (!row || typeof row !== 'object') return;
        const name = row.name || row.capability || row.cap_name;
        const url = capUrl(row.url || row.URI || row.uri);
        if (name && url) out[name] = url;
      });
      return out;
    }
    if (data.GetDisplayNames || data.EventQueueGet || data.RemoteParcelRequest) return data;
    if (findCap(data, 'GetDisplayNames') || findCap(data, 'EventQueueGet') ||
        findCap(data, 'RemoteParcelRequest')) {
      return data;
    }
    if (data.capabilities && typeof data.capabilities === 'object') return unwrapCaps(data.capabilities);
    if (data.Capabilities && typeof data.Capabilities === 'object') return unwrapCaps(data.Capabilities);
    if (data.caps && typeof data.caps === 'object' && !Array.isArray(data.caps)) return unwrapCaps(data.caps);
    if (data.map && typeof data.map === 'object') return data.map;
    return data;
  }

  function hasRequiredCaps(caps) {
    return !!(findCap(caps, 'GetDisplayNames') || findCap(caps, 'RemoteParcelRequest') ||
      findCap(caps, 'EventQueueGet'));
  }

  function hasPresenceCaps(caps) {
    return !!findCap(caps, 'GetDisplayNames');
  }

  function capGrantSummary(caps) {
    const keys = Object.keys(caps || {});
    const preview = keys.slice(0, 10).join(', ');
    if (!keys.length) return 'empty';
    if (hasRequiredCaps(caps)) return preview + ' (' + keys.length + ' caps)';
    return preview + ' (' + keys.length + ' total, no region caps)';
  }

  function parseSeedGrant(body, contentType) {
    return unwrapCaps(parseCapBody({ body: body || '', contentType: contentType || '' }));
  }

  function parseCapBody(resp) {
    return FSLLSD.parse(resp.body || '', resp.contentType || '');
  }

  async function proxyRequest(bridge, url, options) {
    const opts = options || {};
    const proxyOpts = {};
    if (opts.pinSimIp === false) proxyOpts.pinSimIp = false;
    if (opts.preCircuit) proxyOpts.preCircuit = true;
    if (opts.agentSessionId) proxyOpts.agentSessionId = opts.agentSessionId;
    let resp;
    if (opts.method === 'GET') {
      resp = await bridge.proxyGet(url, proxyOpts);
    } else {
      resp = await bridge.proxy(url, opts.body || '', opts.contentType, proxyOpts);
    }
    if (!resp) {
      throw new Error('Capability request failed (no response)');
    }
    if (resp.status < 200 || resp.status >= 300) {
      const snippet = String(resp.body || '').slice(0, 160);
      throw new Error('Capability request failed (' + resp.status + '): ' + snippet);
    }
    return resp;
  }

  const BOOTSTRAP_CAP_NAMES = [
    'EventQueueGet',
    'GetDisplayNames',
    'AgentPreferences',
    'ChatSessionRequest'
  ];

  const PRESENCE_CAP_NAMES = [
    'GetDisplayNames',
    'ChatSessionRequest',
    'AgentPreferences',
    'EventQueueGet'
  ];

  const LAND_CAP_NAMES = [
    'RemoteParcelRequest',
    'LandResources',
    'ParcelPropertiesUpdate'
  ];

  const EVENTQUEUE_CAP_NAMES = [
    'EventQueueGet'
  ];

  const REGION_CAP_NAMES = [
    'AbuseCategories', 'AcceptFriendship', 'AcceptGroupInvite', 'AgentPreferences', 'AgentProfile',
    'AgentState', 'AttachmentResources', 'AvatarPickerSearch', 'AvatarRenderInfo', 'CharacterProperties',
    'ChatSessionRequest', 'CopyInventoryFromNotecard', 'CreateInventoryCategory', 'DeclineFriendship',
    'DeclineGroupInvite', 'DispatchRegionInfo', 'DirectDelivery', 'EnvironmentSettings', 'EstateAccess',
    'EstateChangeInfo', 'EventQueueGet', 'ExtEnvironment', 'FetchLib2', 'FetchLibDescendents2',
    'FetchInventory2', 'FetchInventoryDescendents2', 'IncrementCOFVersion', 'RequestTaskInventory',
    'InterestList', 'InventoryThumbnailUpload', 'GetDisplayNames', 'GetExperiences', 'AgentExperiences',
    'FindExperienceByName', 'GetExperienceInfo', 'GetAdminExperiences', 'GetCreatorExperiences',
    'ExperiencePreferences', 'GroupExperiences', 'UpdateExperience', 'IsExperienceAdmin',
    'IsExperienceContributor', 'RegionExperiences', 'ExperienceQuery', 'GetMesh', 'GetMesh2',
    'GetMetadata', 'GetObjectCost', 'GetObjectPhysicsData', 'GetTexture', 'GroupAPIv1',
    'GroupMemberData', 'GroupProposalBallot', 'HomeLocation', 'LandResources', 'LSLSyntax', 'MapLayer',
    'MapLayerGod', 'MeshUploadFlag', 'ModifyMaterialParams', 'ModifyRegion', 'NavMeshGenerationStatus',
    'NewFileAgentInventory', 'ObjectAnimation', 'ObjectMedia', 'ObjectMediaNavigate',
    'ObjectNavMeshProperties', 'ParcelPropertiesUpdate', 'ParcelVoiceInfoRequest', 'ProductInfoRequest',
    'ProvisionVoiceAccountRequest', 'VoiceSignalingRequest', 'ReadOfflineMsgs', 'RegionObjects',
    'RegionSchedule', 'RemoteParcelRequest', 'RenderMaterials', 'RequestTextureDownload',
    'ResourceCostSelected', 'RetrieveNavMeshSrc', 'SearchStatRequest', 'SearchStatTracking',
    'SendPostcard', 'SendUserReport', 'SendUserReportWithScreenshot', 'ServerReleaseNotes',
    'SetDisplayName', 'SimConsoleAsync', 'SimulatorFeatures', 'SpatialVoiceModerationRequest',
    'StartGroupProposal', 'TerrainNavMeshProperties', 'TextureStats', 'UntrustedSimulatorMessage',
    'UpdateAgentInformation', 'UpdateAgentLanguage', 'UpdateAvatarAppearance',
    'UpdateGestureAgentInventory', 'UpdateGestureTaskInventory', 'UpdateNotecardAgentInventory',
    'UpdateNotecardTaskInventory', 'UpdateScriptAgent', 'UpdateScriptTask', 'UpdateSettingsAgentInventory',
    'UpdateSettingsTaskInventory', 'UploadAgentProfileImage', 'UpdateMaterialAgentInventory',
    'UpdateMaterialTaskInventory', 'UploadBakedTexture', 'UserInfo', 'ViewerAsset', 'ViewerBenefits',
    'ViewerMetrics', 'ViewerStartAuction', 'ViewerStats'
  ];

  function buildDisplayNamesUrl(base, agentIds) {
    const ids = (agentIds || []).filter(Boolean);
    if (!base || !ids.length) return '';
    let url = normalizeCapEndpoint(base);
    const joiner = url.indexOf('?') >= 0 ? '&' : '?';
    return url + joiner + 'ids=' + ids.map(encodeURIComponent).join('&ids=');
  }

  function normalizeCapEndpoint(url) {
    let out = String(url || '').trim();
    if (!out) return '';
    if (out.charAt(out.length - 1) !== '/') out += '/';
    return out;
  }

  const EMPTY_CAP_ARRAY_XML = '<llsd><array /></llsd>\n';

  async function postSeedGrantOnce(bridge, seedUrl, list, options) {
    const opts = options || {};
    const minimal = ['GetDisplayNames', 'RemoteParcelRequest', 'EventQueueGet'];
    const attempts = [
      { body: FSLLSD.arrayXmlCompact(minimal) + '\n', contentType: 'application/llsd+xml' },
      { body: FSLLSD.arrayXmlCompact(list) + '\n', contentType: 'application/llsd+xml' },
      { body: EMPTY_CAP_ARRAY_XML, contentType: 'application/llsd+xml' },
      { body: FSLLSD.arrayXml(minimal), contentType: 'application/llsd+xml' },
      { body: FSLLSD.arrayJson(list), contentType: 'application/llsd+json' }
    ];
    let lastErr = null;
    let lastPartial = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        const resp = await proxyRequest(bridge, seedUrl, Object.assign({}, attempts[i], opts));
        const caps = unwrapCaps(parseCapBody(resp));
        if (!caps || typeof caps !== 'object' || Object.keys(caps).length === 0) continue;
        if (hasRequiredCaps(caps)) {
          return { caps: caps, resp: resp };
        }
        if (!lastPartial || Object.keys(caps).length > Object.keys(lastPartial.caps).length) {
          lastPartial = { caps: caps, resp: resp };
        }
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastPartial) return lastPartial;
    throw lastErr || new Error('Seed capability POST failed');
  }

  function proxyDiagSuffix(resp) {
    if (!resp) return '';
    let hint = '';
    if (resp.status) hint += ' status=' + resp.status;
    if (resp.responseBytes) hint += ' respBytes=' + resp.responseBytes;
    if (resp.udpListenPort) hint += ' udpPort=' + resp.udpListenPort;
    if (resp.simPinnedIp) hint += ' simIp=' + resp.simPinnedIp;
    if (resp.effectiveUrl) {
      const short = String(resp.effectiveUrl).replace(/^https?:\/\//i, '').slice(0, 72);
      if (short) hint += ' url=' + short;
    }
    if (resp.redirectCount) hint += ' redirects=' + resp.redirectCount;
    return hint;
  }

  async function postSeedCapabilities(bridge, seedUrl, names, options) {
    const opts = options || {};
    const fullList = names || REGION_CAP_NAMES;
    const rounds = opts.grantRounds || 3;
    let merged = {};
    let url = seedUrl;
    let lastSummary = '';
    let lastUdpPort = 0;
    let redirectHint = '';
    let requestBytes = 0;

    let lastResp = null;
    for (let round = 0; round < rounds; round++) {
      const list = round === 0 ? BOOTSTRAP_CAP_NAMES : fullList;
      const result = await postSeedGrantOnce(bridge, url, list, opts);
      lastResp = result.resp;
      if (typeof result.resp.udpListenPort === 'number') {
        lastUdpPort = result.resp.udpListenPort;
      }
      if (result.resp.redirectCount) {
        redirectHint = ' redirects=' + result.resp.redirectCount;
      }
      if (result.resp.requestBytes) {
        requestBytes = result.resp.requestBytes;
      }
      merged = Object.assign({}, merged, result.caps);
      if (hasRequiredCaps(merged)) {
        return merged;
      }
      lastSummary = capGrantSummary(merged);
      const nextSeed = findCap(merged, 'Seed');
      if (nextSeed && nextSeed !== url) {
        url = nextSeed;
        continue;
      }
      if (round + 1 < rounds) {
        await new Promise(function (resolve) {
          setTimeout(resolve, 400);
        });
      }
    }

    const udpHint = (opts.preCircuit || lastUdpPort) ? '' : ' [missing X-SecondLife-UDP-Listen-Port]';
    const bytesHint = requestBytes ? (' reqBytes=' + requestBytes) : '';
    if (hasRequiredCaps(merged)) {
      return merged;
    }
    throw new Error(
      'Seed grant missing region caps (got: ' + (lastSummary || 'empty') + ')' +
      redirectHint + udpHint + bytesHint + ' rounds=' + rounds +
      proxyDiagSuffix(lastResp || { effectiveUrl: url })
    );
  }

  async function fetchCapabilities(bridge, seedUrl, names, options) {
    return postSeedCapabilities(bridge, seedUrl, names || REGION_CAP_NAMES, options);
  }

  function extractAgents(data) {
    if (!data) return [];
    if (Array.isArray(data.agents)) return data.agents;
    if (data.agents && typeof data.agents === 'object') {
      if (Array.isArray(data.agents.array)) return data.agents.array;
      if (Array.isArray(data.agents._array)) return data.agents._array;
      const rows = [];
      Object.keys(data.agents).forEach(function (key) {
        if (key === 'array' || key === '_array') return;
        const row = data.agents[key];
        if (row && typeof row === 'object') rows.push(row);
      });
      if (rows.length) return rows;
    }
    if (Array.isArray(data)) return data;
    return [];
  }

  async function resolveDisplayNames(bridge, capUrl, agentIds) {
    const records = await resolveAgentNames(bridge, capUrl, agentIds);
    const names = {};
    Object.keys(records).forEach(function (id) {
      names[id] = records[id].label;
    });
    return names;
  }

  function xmlText(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function chatSessionBodyXml(payload) {
    const p = payload || {};
    let inner = '<key>method</key><string>' + xmlText(p.method) + '</string>';
    if (p.sessionId) {
      inner += '<key>session-id</key><uuid>' + xmlText(p.sessionId) + '</uuid>';
    }
    if (Array.isArray(p.params)) {
      let arr = '';
      p.params.forEach(function (id) {
        if (id) arr += '<uuid>' + xmlText(id) + '</uuid>';
      });
      inner += '<key>params</key><array>' + arr + '</array>';
    } else if (p.muteParams && typeof p.muteParams === 'object') {
      const mp = p.muteParams;
      const mi = mp.mute_info || {};
      let info = '';
      Object.keys(mi).forEach(function (key) {
        info += '<key>' + xmlText(key) + '</key><boolean>' +
          (mi[key] ? '1' : '0') + '</boolean>';
      });
      inner += '<key>params</key><map>' +
        '<key>agent_id</key><uuid>' + xmlText(mp.agent_id) + '</uuid>' +
        '<key>mute_info</key><map>' + info + '</map>' +
        '</map>';
    }
    if (p.altParams && typeof p.altParams === 'object') {
      let alt = '';
      Object.keys(p.altParams).forEach(function (key) {
        alt += '<key>' + xmlText(key) + '</key><string>' +
          xmlText(p.altParams[key]) + '</string>';
      });
      inner += '<key>alt_params</key><map>' + alt + '</map>';
    }
    return '<?xml version="1.0"?><llsd><map>' + inner + '</map></llsd>';
  }

  async function chatSessionRequest(bridge, capUrl, payload, sessionAuthId) {
    const base = normalizeCapEndpoint(capUrl);
    if (!base) throw new Error('ChatSessionRequest capability unavailable');
    const proxyOpts = {
      body: chatSessionBodyXml(payload),
      contentType: 'application/llsd+xml'
    };
    if (sessionAuthId) proxyOpts.agentSessionId = sessionAuthId;
    const resp = await proxyRequest(bridge, base, proxyOpts);
    return parseCapBody(resp);
  }

  function chatSessionAccept(bridge, capUrl, sessionId, sessionAuthId) {
    return chatSessionRequest(bridge, capUrl,
      { method: 'accept invitation', sessionId: sessionId }, sessionAuthId);
  }

  function chatSessionDecline(bridge, capUrl, sessionId, sessionAuthId) {
    return chatSessionRequest(bridge, capUrl,
      { method: 'decline invitation', sessionId: sessionId }, sessionAuthId);
  }

  function chatSessionStartConference(bridge, capUrl, tempSessionId, agentIds, sessionAuthId) {
    return chatSessionRequest(bridge, capUrl, {
      method: 'start conference',
      sessionId: tempSessionId,
      params: (agentIds || []).filter(Boolean)
    }, sessionAuthId);
  }

  function chatSessionInvite(bridge, capUrl, sessionId, agentIds, sessionAuthId) {
    return chatSessionRequest(bridge, capUrl, {
      method: 'invite',
      sessionId: sessionId,
      params: (agentIds || []).filter(Boolean)
    }, sessionAuthId);
  }

  function chatSessionModerate(bridge, capUrl, sessionId, agentId, muteText, sessionAuthId) {
    return chatSessionRequest(bridge, capUrl, {
      method: 'mute update',
      sessionId: sessionId,
      muteParams: { agent_id: agentId, mute_info: { text: !!muteText } }
    }, sessionAuthId);
  }

  async function resolveAgentNames(bridge, capUrl, agentIds, sessionId) {
    const ids = (agentIds || []).filter(Boolean);
    const base = normalizeCapEndpoint(capUrl);
    if (!base || !ids.length) return {};

    const dedupeKey = base + '|' + ids.map(normId).sort().join(',');
    if (displayNamesInflight.has(dedupeKey)) {
      return displayNamesInflight.get(dedupeKey);
    }

    const task = (async function () {
      const names = {};
      const chunks = [];
      for (let i = 0; i < ids.length; i += 40) {
        chunks.push(ids.slice(i, i + 40));
      }

      const proxyOpts = { method: 'GET' };
      if (sessionId) proxyOpts.agentSessionId = sessionId;

      for (let c = 0; c < chunks.length; c++) {
        const url = buildDisplayNamesUrl(base, chunks[c]);
        const resp = await proxyRequest(bridge, url, proxyOpts);
        const data = parseCapBody(resp);
        extractAgents(data).forEach(function (row) {
          const id = row.id || row.agent_id || row.sl_id;
          if (id) {
            names[normId(id)] = agentNameRecord(row);
          }
        });
      }
      return names;
    })();

    displayNamesInflight.set(dedupeKey, task);
    try {
      return await task;
    } finally {
      if (displayNamesInflight.get(dedupeKey) === task) {
        displayNamesInflight.delete(dedupeKey);
      }
    }
  }

  const REGION_WIDTH_METERS = 256;

  function globalPositionFromRegion(gridX, gridY, localPos) {
    const local = localPos || { x: 128, y: 128, z: 25 };
    const gx = parseInt(gridX, 10) || 0;
    const gy = parseInt(gridY, 10) || 0;
    return {
      x: gx * REGION_WIDTH_METERS + (local.x || 0),
      y: gy * REGION_WIDTH_METERS + (local.y || 0),
      z: local.z || 0
    };
  }

  function toRegionHandleFromGlobal(globalPos) {
    let gx = Math.floor(globalPos.x || 0);
    let gy = Math.floor(globalPos.y || 0);
    gx -= gx % REGION_WIDTH_METERS;
    gy -= gy % REGION_WIDTH_METERS;
    return (BigInt(gx) << 32n) | BigInt(gy);
  }

  function regionHandleU64(x, y) {
    return toRegionHandleFromGlobal({ x: x, y: y, z: 0 });
  }

  function buildRemoteParcelBody(options) {
    const opts = options || {};
    const local = opts.position || { x: 128, y: 128, z: 25 };
    const body = {
      location: [local.x, local.y, local.z]
    };
    if (opts.regionId) body.region_id = opts.regionId;
    const gridX = opts.regionGridX !== undefined ? opts.regionGridX : opts.regionX;
    const gridY = opts.regionGridY !== undefined ? opts.regionGridY : opts.regionY;
    if (gridX !== undefined && gridY !== undefined) {
      const globalPos = globalPositionFromRegion(gridX, gridY, local);
      if (globalPos.x || globalPos.y) {
        body.region_handle = toRegionHandleFromGlobal(globalPos);
      }
    }
    return body;
  }

  function parcelIdFromRawBody(rawBody) {
    const text = String(rawBody || '');
    const match = text.match(/<key>\s*parcel_id\s*<\/key>\s*<uuid>([^<]+)<\/uuid>/i);
    return match ? match[1].trim() : '';
  }

  function parseRemoteParcelResponse(data, rawBody) {
    const parcelId = data.parcel_id || data.parcelId || data.ParcelID ||
      parcelIdFromRawBody(rawBody) || '';
    const name = data.name || data.Name || '';
    const desc = data.desc || data.Desc || data.description || '';
    const area = data.actual_area || data.ActualArea || data.billable_area ||
      data.BillableArea || data.area || 0;
    const flags = data.flags || data.Flags || data.parcel_flags || data.ParcelFlags || 0;
    const out = {
      parcelId: parcelId,
      name: name,
      desc: desc,
      area: area,
      ownerId: data.owner_id || data.OwnerID || data.ownerId || ''
    };
    const parsedFlags = FSLLSD.uint32FromValue(flags, 0);
    if (parsedFlags) out.parcelFlags = parsedFlags;
    const musicUrl = data.music_url || data.musicUrl || data.MusicURL;
    const mediaUrl = data.media_url || data.mediaUrl || data.MediaURL;
    if (musicUrl) out.musicUrl = musicUrl;
    if (mediaUrl) out.mediaUrl = mediaUrl;
    const primsUsed = data.total_prims ?? data.TotalPrims ?? data.prims_used;
    const primsTotal = data.max_prims ?? data.MaxPrims ?? data.prims_total;
    if (primsUsed !== undefined && primsUsed !== null && primsUsed > 0) out.primsUsed = primsUsed;
    if (primsTotal !== undefined && primsTotal !== null && primsTotal > 0) out.primsTotal = primsTotal;
    out.rawBody = rawBody || '';
    return out;
  }

  async function postRemoteParcel(bridge, capUrl, options) {
    const url = normalizeCapEndpoint(capUrl);
    const body = buildRemoteParcelBody(options);
    const payload = JSON.stringify(body, function (_key, value) {
      return typeof value === 'bigint' ? value.toString() : value;
    });
    const attempts = [
      { body: FSLLSD.mapXml(body), contentType: 'application/llsd+xml' },
      { body: payload, contentType: 'application/llsd+json' },
      { body: payload, contentType: 'application/json' }
    ];
    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        const resp = await proxyRequest(bridge, url, attempts[i]);
        const rawBody = String(resp.body || '');
        return parseRemoteParcelResponse(parseCapBody(resp), rawBody);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Remote parcel request failed');
  }

  async function fetchRemoteParcel(bridge, capUrl, options) {
    const opts = options || {};
    const attempts = [
      opts,
      Object.assign({}, opts, { regionId: null })
    ];
    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        return await postRemoteParcel(bridge, capUrl, attempts[i]);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Remote parcel request failed');
  }

  async function enrichBuddies(bridge, seedUrl, buddies) {
    if (!buddies.length || !seedUrl) return buddies.slice();
    try {
      const caps = await fetchCapabilities(bridge, seedUrl);
      const displayNamesCap = findCap(caps, 'GetDisplayNames');
      if (!displayNamesCap) {
        const keys = Object.keys(caps).slice(0, 8).join(', ');
        throw new Error('GetDisplayNames capability missing' + (keys ? ' (got: ' + keys + ')' : ''));
      }
      const ids = buddies.map(function (b) { return b.id; });
      const resolved = await resolveAgentNames(bridge, displayNamesCap, ids);
      return buddies.map(function (b) {
        const record = resolved[normId(b.id)];
        if (!record) return b;
        return Object.assign({}, b, {
          name: record.label,
          displayName: record.displayName,
          userName: record.userName,
          legacyName: record.userName
        });
      });
    } catch (err) {
      console.warn('Display name lookup failed:', err);
      return buddies.slice();
    }
  }

  return {
    fetchCapabilities: fetchCapabilities,
    resolveDisplayNames: resolveDisplayNames,
    resolveAgentNames: resolveAgentNames,
    chatSessionRequest: chatSessionRequest,
    chatSessionAccept: chatSessionAccept,
    chatSessionDecline: chatSessionDecline,
    chatSessionStartConference: chatSessionStartConference,
    chatSessionInvite: chatSessionInvite,
    chatSessionModerate: chatSessionModerate,
    agentNameRecord: agentNameRecord,
    enrichBuddies: enrichBuddies,
    fetchRemoteParcel: fetchRemoteParcel,
    agentDisplayName: agentDisplayName,
    capUrl: capUrl,
    findCap: findCap,
    hasRequiredCaps: hasRequiredCaps,
    hasPresenceCaps: hasPresenceCaps,
    parseSeedGrant: parseSeedGrant,
    normalizeCapEndpoint: normalizeCapEndpoint,
    REGION_CAP_NAMES: REGION_CAP_NAMES,
    BOOTSTRAP_CAP_NAMES: BOOTSTRAP_CAP_NAMES,
    PRESENCE_CAP_NAMES: PRESENCE_CAP_NAMES,
    LAND_CAP_NAMES: LAND_CAP_NAMES,
    EVENTQUEUE_CAP_NAMES: EVENTQUEUE_CAP_NAMES,
    extractAgents: extractAgents,
    parseCapBody: parseCapBody,
    proxyRequest: proxyRequest
  };
})();
