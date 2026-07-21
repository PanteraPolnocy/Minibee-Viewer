/**
 * Directory and avatar search helpers.
 */
const FSSearchApi = (function () {
  'use strict';

  const DFQ_PEOPLE = 1;
  const DFQ_GROUPS = 16;
  const DFQ_DWELL_SORT = 1024;
  const DFQ_INC_PG = 16777216;
  const DFQ_INC_MATURE = 33554432;
  const DFQ_INC_ADULT = 67108864;
  const PEOPLE_FLAGS = DFQ_PEOPLE | DFQ_INC_PG | DFQ_INC_MATURE | DFQ_INC_ADULT;
  const PLACES_FLAGS = DFQ_DWELL_SORT | DFQ_INC_PG | DFQ_INC_MATURE | DFQ_INC_ADULT;
  const GROUPS_FLAGS = DFQ_GROUPS | DFQ_INC_PG | DFQ_INC_MATURE | DFQ_INC_ADULT;
  const SEARCH_TIMEOUT_MS = 10000;
  const MIN_QUERY_LEN = 3;
  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

  const pending = new Map();

  function normalizePeopleQuery(query) {
    return String(query || '').trim().replace(/\./g, ' ');
  }

  function formatAvatarName(row) {
    const first = String(row.firstName || row.first_name || '').trim();
    const last = String(row.lastName || row.last_name || '').trim();
    if (first && last) {
      return last === 'Resident' ? first : (first + ' ' + last);
    }
    return first || last || '';
  }

  function normQueryId(id) {
    return String(id || '').toLowerCase();
  }

  function displayAvatarLabel(row) {
    const name = String(row.name || row.displayName || row.userName || '').trim();
    if (!name || name === 'Unknown') return '';
    if (name === 'Resident') return '';
    if (/^[0-9a-f-]{36}$/i.test(name)) return '';
    return name;
  }

  function isUsableAvatar(row) {
    if (!row || !row.id || row.id === ZERO_UUID) return false;
    return !!displayAvatarLabel(row);
  }

  function mergeAvatarResults(primary, secondary) {
    const out = [];
    const seen = new Set();
    (primary || []).concat(secondary || []).forEach(function (row) {
      if (!row || !row.id || row.id === ZERO_UUID || seen.has(row.id)) return;
      seen.add(row.id);
      out.push(row);
    });
    return out;
  }

  async function enrichAvatarNames(bridge, displayNamesCap, sessionId, rows) {
    if (!rows.length) return rows;
    const ids = rows.map(function (row) { return row.id; }).filter(Boolean);
    if (!ids.length || !bridge || !displayNamesCap) return rows;

    let records = {};
    try {
      records = await FSCaps.resolveAgentNames(bridge, displayNamesCap, ids, sessionId);
    } catch (_e) {
      return rows;
    }

    return rows.map(function (row) {
      const rec = records[String(row.id || '').toLowerCase()];
      if (!rec) return row;
      return {
        id: row.id,
        name: rec.label || row.name,
        userName: rec.userName || row.userName,
        displayName: rec.displayName || row.displayName,
        online: row.online === true,
        region: row.region || ''
      };
    });
  }

  function finishPending(queryId, payload) {
    const entry = pending.get(normQueryId(queryId));
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(normQueryId(queryId));
    entry.resolve(payload);
  }

  function waitForQuery(queryId, type) {
    const key = normQueryId(queryId);
    return new Promise(function (resolve) {
      const entry = {
        type: type,
        results: [],
        statuses: [],
        resolve: resolve
      };
      pending.set(key, entry);
      entry.timer = setTimeout(function () {
        if (pending.get(key) !== entry) return;
        finishPending(queryId, {
          results: entry.results.slice(),
          statuses: entry.statuses.slice(),
          timedOut: true
        });
      }, SEARCH_TIMEOUT_MS);
    });
  }

  function onPacket(evt) {
    if (!evt || !evt.data) return;
    const data = evt.data;
    const queryId = normQueryId(data.queryId);
    if (!queryId || !pending.has(queryId)) return;
    const entry = pending.get(queryId);

    if (evt.type === 'dir-people-reply' && entry.type === 'avatars') {
      (data.people || []).forEach(function (row) {
        const userName = formatAvatarName(row);
        entry.results.push({
          id: row.id,
          name: userName,
          userName: userName,
          displayName: userName,
          online: row.online === true
        });
      });
      if (entry.debounce) clearTimeout(entry.debounce);
      entry.debounce = setTimeout(function () {
        finishPending(queryId, {
          results: entry.results.slice(),
          statuses: entry.statuses.slice(),
          timedOut: false
        });
      }, 450);
      return;
    }

    if (evt.type === 'avatar-picker-reply' && entry.type === 'avatars') {
      (data.avatars || []).forEach(function (row) {
        const userName = formatAvatarName(row);
        entry.results.push({
          id: row.id,
          name: userName,
          userName: userName,
          displayName: userName
        });
      });
      finishPending(queryId, { results: entry.results.slice(), statuses: [], timedOut: false });
      return;
    }

    if (evt.type === 'dir-places-reply' && entry.type === 'places') {
      (data.places || []).forEach(function (place) {
        entry.results.push({
          kind: 'place',
          parcelId: place.parcelId,
          name: place.name,
          dwell: place.dwell
        });
      });
      (data.statuses || []).forEach(function (s) { entry.statuses.push(s); });
      if (entry.debounce) clearTimeout(entry.debounce);
      entry.debounce = setTimeout(function () {
        finishPending(queryId, {
          results: entry.results.slice(),
          statuses: entry.statuses.slice(),
          timedOut: false
        });
      }, 450);
      return;
    }

    if (evt.type === 'dir-groups-reply' && entry.type === 'groups') {
      (data.groups || []).forEach(function (group) {
        entry.results.push({
          kind: 'group',
          id: group.id,
          name: group.name,
          members: group.members
        });
      });
      (data.statuses || []).forEach(function (s) { entry.statuses.push(s); });
      if (entry.debounce) clearTimeout(entry.debounce);
      entry.debounce = setTimeout(function () {
        finishPending(queryId, {
          results: entry.results.slice(),
          statuses: entry.statuses.slice(),
          timedOut: false
        });
      }, 450);
    }
  }

  function searchLocalResidents(query) {
    const text = normalizePeopleQuery(query).toLowerCase();
    if (!text || text.length < MIN_QUERY_LEN || typeof FSState === 'undefined') return [];
    const out = [];
    const seen = new Set();
    function addRow(id, name, userName, displayName, online, region) {
      if (!id || id === ZERO_UUID || seen.has(id)) return;
      const label = String(name || displayName || userName || '').trim();
      const hay = (label + ' ' + String(userName || '') + ' ' + String(displayName || '')).toLowerCase();
      if (hay.indexOf(text) === -1) return;
      seen.add(id);
      const row = {
        id: id,
        name: label || userName || displayName,
        userName: userName || label,
        displayName: displayName || ''
      };
      if (online === true) {
        row.online = true;
        if (region) row.region = region;
      }
      out.push(row);
    }
    (FSState.get().buddies || []).forEach(function (b) {
      addRow(b.id, b.name, b.userName, b.displayName, b.online, b.region);
    });
    (FSState.get().radar || []).forEach(function (r) {
      addRow(r.id, r.name, r.userName, r.displayName, true, r.region);
    });
    return out.filter(isUsableAvatar);
  }

  async function searchAvatarsCap(bridge, capUrl, query, sessionId) {
    if (!bridge || !capUrl || !query) return [];
    let url = String(capUrl);
    if (url.charAt(url.length - 1) !== '/') url += '/';
    const text = normalizePeopleQuery(query);
    url += '?page_size=50&names=' + encodeURIComponent(text);
    const resp = await FSCaps.proxyRequest(bridge, url, {
      method: 'GET',
      agentSessionId: sessionId
    });
    const body = FSCaps.parseCapBody(resp);
    const agents = FSCaps.extractAgents(body);
    if (!agents.length) return [];
    const out = [];
    for (let i = 0; i < agents.length; i++) {
      const row = agents[i];
      if (!row) continue;
      const id = row.id || row.sl_id || row.agent_id;
      if (!id || String(id) === ZERO_UUID) continue;
      const displayName = String(row.display_name || row.displayName || '').trim();
      const userName = String(row.username || row.user_name || '').trim();
      const rec = FSCaps.agentNameRecord(row);
      out.push({
        id: String(id),
        name: displayName || rec.label || userName,
        userName: userName || rec.userName,
        displayName: displayName || rec.displayName
      });
    }
    return out;
  }

  async function searchPeopleUdp(circuit, query) {
    if (!circuit || !circuit.searchPeopleUdp) return [];
    const queryId = FSUtils.uuid();
    const wait = waitForQuery(queryId, 'avatars');
    const sent = await circuit.searchPeopleUdp(queryId, query, PEOPLE_FLAGS);
    if (!sent || !sent.sent) return [];
    const result = await wait;
    return result.results || [];
  }

  async function searchAvatarsUdp(circuit, query) {
    if (!circuit || !circuit.searchAvatarsUdp) return [];
    const queryId = FSUtils.uuid();
    const wait = waitForQuery(queryId, 'avatars');
    const sent = await circuit.searchAvatarsUdp(queryId, query);
    if (!sent || !sent.sent) return [];
    const result = await wait;
    return result.results || [];
  }

  async function searchAvatars(circuit, bridge, capUrl, displayNamesCap, sessionId, query) {
    const text = normalizePeopleQuery(query);
    if (!text || text.length < MIN_QUERY_LEN) return [];

    let peopleResults = [];
    if (circuit) {
      peopleResults = await searchPeopleUdp(circuit, text);
    }

    let capResults = [];
    if (!peopleResults.length && capUrl && bridge) {
      try {
        capResults = await searchAvatarsCap(bridge, capUrl, text, sessionId);
      } catch (err) {
        if (typeof FSErrors !== 'undefined') {
          FSErrors.info('search', 'Avatar cap search failed: ' + (err.message || err), false);
        }
      }
    }

    let pickerResults = [];
    if (!peopleResults.length && circuit) {
      pickerResults = await searchAvatarsUdp(circuit, text);
    }

    let results = mergeAvatarResults(peopleResults, mergeAvatarResults(capResults, pickerResults));
    if (!results.length) {
      results = searchLocalResidents(text);
    }
    results = await enrichAvatarNames(bridge, displayNamesCap, sessionId, results);
    return results.filter(isUsableAvatar);
  }

  async function searchPlaces(circuit, query) {
    const text = String(query || '').trim();
    if (!text || text.length < MIN_QUERY_LEN || !circuit || !circuit.searchPlacesUdp) return [];
    const queryId = FSUtils.uuid();
    const wait = waitForQuery(queryId, 'places');
    const sent = await circuit.searchPlacesUdp(queryId, text, PLACES_FLAGS);
    if (!sent || !sent.sent) return [];
    const result = await wait;
    return result.results || [];
  }

  async function searchGroups(circuit, query) {
    const text = String(query || '').trim();
    if (!text || text.length < MIN_QUERY_LEN || !circuit || !circuit.searchGroupsUdp) return [];
    const queryId = FSUtils.uuid();
    const wait = waitForQuery(queryId, 'groups');
    const sent = await circuit.searchGroupsUdp(queryId, text, GROUPS_FLAGS);
    if (!sent || !sent.sent) return [];
    const result = await wait;
    return result.results || [];
  }

  async function searchRegionByName(_bridgeUrl, query) {
    const text = String(query || '').trim();
    if (!text) return null;
    const data = await FSBridge.regionByName(text);
    if (!data || !data.name) return null;
    return {
      kind: 'region',
      name: data.name,
      globalX: data.globalX,
      globalY: data.globalY,
      gridX: data.gridX,
      gridY: data.gridY
    };
  }

  async function searchDestinations(_bridgeUrl, query) {
    const text = String(query || '').trim().toLowerCase();
    if (!text || text.length < MIN_QUERY_LEN) return [];
    const feeds = ['mobile', 'popular', 'new'];
    const matches = [];
    const seen = new Set();
    for (let f = 0; f < feeds.length; f++) {
      try {
        const data = await FSBridge.destinations(feeds[f]);
        const items = (data && data.items) || [];
        items.forEach(function (item) {
          const name = String(item.name || '').trim();
          const desc = String(item.description || '').trim();
          const key = String(item.slurl || name).toLowerCase();
          if (!name || seen.has(key)) return;
          if (name.toLowerCase().indexOf(text) === -1 &&
              desc.toLowerCase().indexOf(text) === -1) return;
          seen.add(key);
          let image = '';
          const assets = item.assets || [];
          for (let i = 0; i < assets.length; i++) {
            if (assets[i] && assets[i].data) {
              image = String(assets[i].data);
              if (assets[i].type === 'fullsize') break;
            }
          }
          matches.push({
            kind: 'destination',
            name: name,
            description: desc,
            slurl: String(item.slurl || '').trim(),
            image: image,
            maturity: item.maturity || '',
            population: item.population && item.population.current
          });
        });
      } catch (_e) { /* ignore feed errors */ }
    }
    return matches;
  }

  return {
    onPacket: onPacket,
    normalizePeopleQuery: normalizePeopleQuery,
    searchAvatars: searchAvatars,
    searchPlaces: searchPlaces,
    searchGroups: searchGroups,
    searchRegionByName: searchRegionByName,
    searchDestinations: searchDestinations,
    MIN_QUERY_LEN: MIN_QUERY_LEN
  };
})();
