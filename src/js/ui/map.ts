/**
 * The world map panel: renders tiles, lets you click to pick a spot, and
 * handles manual teleports.
 */
const BeeMap = (function () {
  'use strict';

  const TILE_PX_MIN = 80;
  const TILE_PX_MAX = 256;
  const MAP_LEVEL = 1;
  const VIEW_TILES = 3;
  const SIM_ACCESS_PG = 13;
  const SIM_ACCESS_MATURE = 21;
  const SIM_ACCESS_ADULT = 42;
  const AGENT_REFRESH_MS = 30000;

  let mapServerUrl = BeeSlurl.DEFAULT_MAP_SERVER;
  let centerGridX = 1000;
  let centerGridY = 1000;
  // Once the user pans, we stop auto-following the agent's position so the
  // view isn't yanked back on every movement tick. Reset on tab open or teleport.
  let userPanned = false;
  let selection = null;
  let regionInfo = new Map();
  let fetchedBlocks = new Set();
  const agentRefreshAt = new Map();
  const httpNamePending = new Set();
  let httpNameBatchQueue = [];
  let httpNameBatchRunning = false;
  const tileImageCache = new Map();
  let renderToken = 0;
  let tilePx = 128;
  // The last renderTiles() geometry, so overlay-only refreshes can redraw
  // markers without refetching tiles.
  let lastLayout = null;
  const TELEPORT_BTN_LABEL = 'Teleport Here';
  let mapTeleportBusy = false;
  let mapTeleportPct = 0;

  function formatMapProgress(message, fallbackShort) {
    if (typeof BeeTeleportUI !== 'undefined' && BeeTeleportUI.formatProgressLabel) {
      return BeeTeleportUI.formatProgressLabel(message, mapTeleportPct, fallbackShort);
    }
    const text = String(message || fallbackShort || 'Teleporting');
    return { text: text, pct: mapTeleportPct || 50, short: fallbackShort || 'Teleporting' };
  }

  function applyMapTeleportProgress(message, fallbackShort) {
    const out = formatMapProgress(message, fallbackShort);
    mapTeleportPct = out.pct;
    setTeleportButtonState(true, out.text);
  }

  // Callers that need a form control ask for it: el<HTMLInputElement>('...').
  function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  function normalizeRegion(region) {
    const r = Object.assign({}, region || {});
    if (r.globalX === undefined && r.x !== undefined && r.y !== undefined &&
        (r.x > 4096 || r.y > 4096)) {
      const grid = BeeSlurl.globalToGrid(r.x, r.y);
      r.globalX = grid.globalX;
      r.globalY = grid.globalY;
      r.x = grid.gridX;
      r.y = grid.gridY;
    } else if (r.globalX !== undefined && (r.x === undefined || r.x <= 4096)) {
      const grid = BeeSlurl.globalToGrid(r.globalX, r.globalY);
      r.x = grid.gridX;
      r.y = grid.gridY;
    }
    return r;
  }

  function currentAgentMarker() {
    const s = BeeState.get();
    const region = normalizeRegion(s.region || {});
    const pos = s.position || circuitPosition();
    if (region.x === undefined || region.y === undefined || !pos) return null;
    return {
      gridX: region.x,
      gridY: region.y,
      x: pos.x,
      y: pos.y,
      z: pos.z !== undefined ? pos.z : 25,
      regionName: region.name || ''
    };
  }

  function circuitPosition() {
    return BeeState.get().position || null;
  }

  function setSelection(loc) {
    selection = loc ? Object.assign({}, loc) : null;
    updateInfo();
    renderTiles();
  }

  function updateInfo() {
    const info = el('map-info');
    if (!info) return;
    if (!selection) {
      info.textContent = 'Tap the map to pick coordinates, or paste a SLURL / region name.';
      return;
    }
    info.textContent = BeeSlurl.formatLocation(selection);
  }

  function tileKey(gridX, gridY) {
    return gridX + ',' + gridY;
  }

  function getRegionInfo(gridX, gridY) {
    return regionInfo.get(tileKey(gridX, gridY)) || null;
  }

  function getRegionName(gridX, gridY) {
    const info = getRegionInfo(gridX, gridY);
    if (info && info.empty) return '';
    return (info && info.name) || '';
  }

  function markRegionEmpty(gridX, gridY) {
    regionInfo.set(tileKey(gridX, gridY), { name: '', empty: true });
    const canvas = el('map-canvas');
    if (canvas && BeeState.get().activeTab === 'map') {
      refreshTileLabels(canvas);
    }
  }

  function isRegionResolved(gridX, gridY) {
    const info = getRegionInfo(gridX, gridY);
    return !!(info && (info.name || info.empty));
  }

  function accessRatingLetter(access) {
    if (access === SIM_ACCESS_ADULT) return 'A';
    if (access === SIM_ACCESS_MATURE) return 'M';
    return 'G';
  }

  function accessRatingClass(letter) {
    if (letter === 'A') return 'map-tile-label__rating--a';
    if (letter === 'M') return 'map-tile-label__rating--m';
    return 'map-tile-label__rating--g';
  }

  function formatTileLabel(gridX, gridY) {
    const marker = currentAgentMarker();
    if (marker && marker.gridX === gridX && marker.gridY === gridY &&
        marker.regionName && !isPlaceholderRegionName(marker.regionName)) {
      const info = getRegionInfo(gridX, gridY) || {};
      return {
        name: marker.regionName,
        rating: accessRatingLetter(info.access),
        agents: info.agents,
        hidden: false
      };
    }
    const info = getRegionInfo(gridX, gridY);
    if (info && info.empty) {
      return { name: '', rating: '', hidden: true };
    }
    if (info && info.name) {
      return {
        name: info.name,
        rating: accessRatingLetter(info.access),
        agents: info.agents,
        hidden: false
      };
    }
    return { name: '', rating: '', hidden: true };
  }

  function setTileLabelContent(labelEl, gridX, gridY, tileSize, tileBtn) {
    if (!labelEl) return;
    const parts = formatTileLabel(gridX, gridY);
    if (parts.hidden) {
      labelEl.textContent = '';
      labelEl.hidden = true;
      if (tileBtn) tileBtn.classList.toggle('map-tile--empty', !!(getRegionInfo(gridX, gridY) && getRegionInfo(gridX, gridY).empty));
      return;
    }
    labelEl.hidden = false;
    if (tileBtn) tileBtn.classList.remove('map-tile--empty');
    labelEl.style.fontSize = Math.max(8, Math.floor(tileSize * 0.072)) + 'px';
    if (parts.rating) {
      let html = '<span class="map-tile-label__rating ' +
        accessRatingClass(parts.rating) + '">(' + parts.rating + ')</span> ';
      if (parts.agents !== undefined && parts.agents !== null && parts.agents > 0) {
        html += '<span class="map-tile-label__agents">' + parts.agents + '</span> ';
      }
      html += BeeUtils.escapeHtml(parts.name);
      labelEl.innerHTML = html;
    } else {
      labelEl.textContent = parts.name;
    }
  }

  function tileImageKey(gridX, gridY) {
    return MAP_LEVEL + ':' + tileKey(gridX, gridY);
  }

  function clearTileCache() {
    tileImageCache.forEach(function (entry) {
      if (entry && entry.revokeBlob && entry.blobUrl) {
        URL.revokeObjectURL(entry.blobUrl);
      }
    });
    tileImageCache.clear();
    fetchedBlocks.clear();
    httpNamePending.clear();
    httpNameBatchQueue = [];
    httpNameBatchRunning = false;
    regionInfo.clear();
    agentRefreshAt.clear();
  }

  function applyRegionAgents(gridX, gridY, agents) {
    const key = tileKey(gridX, gridY);
    const existing = regionInfo.get(key);
    if (!existing || !existing.name || existing.empty) return;
    regionInfo.set(key, Object.assign({}, existing, {
      agents: agents,
      agentsAt: Date.now()
    }));
    const canvas = el('map-canvas');
    if (canvas && BeeState.get().activeTab === 'map') {
      refreshTileLabels(canvas);
    }
  }

  function isPlaceholderRegionName(name) {
    const text = String(name || '').trim().toLowerCase();
    return !text || text === 'home' || text === 'region';
  }

  function applyRegionInfo(gridX, gridY, name, access, source, agents?) {
    if (!name || isPlaceholderRegionName(name)) return false;
    const key = tileKey(gridX, gridY);
    const existing = regionInfo.get(key) || {};
    if ((source === 'udp' || source === 'http') &&
        (existing.httpTrusted || existing.stateTrusted) &&
        existing.name && existing.name !== name) {
      return false;
    }
    regionInfo.set(key, {
      name: name,
      empty: false,
      access: access !== undefined ? access : existing.access,
      agents: agents !== undefined ? agents : existing.agents,
      agentsAt: agents !== undefined ? Date.now() : existing.agentsAt,
      httpTrusted: source === 'http' ? true : !!existing.httpTrusted,
      stateTrusted: source === 'state' ? true : !!existing.stateTrusted
    });
    if (selection && selection.gridX === gridX && selection.gridY === gridY) {
      const current = String(selection.regionName || '');
      if (!current || /^Region\s+\d+/i.test(current) || current === name) {
        selection.regionName = name;
        updateInfo();
        const input = el<HTMLInputElement>('map-location-input');
        if (input) {
          input.value = BeeSlurl.buildMapsUrl(name, selection);
        }
      }
    }
    const canvas = el('map-canvas');
    if (canvas && BeeState.get().activeTab === 'map') {
      refreshTileLabels(canvas);
    }
    return true;
  }

  function seedKnownRegions() {
    const s = BeeState.get();
    const region = normalizeRegion(s.region || {});
    if (region.name && region.x !== undefined && region.y !== undefined) {
      applyRegionInfo(region.x, region.y, region.name, region.access, 'state');
    }
  }

  function queueRegionNameFetch(gridX, gridY) {
    const key = tileKey(gridX, gridY);
    if (isRegionResolved(gridX, gridY)) return;
    if (httpNamePending.has(key)) return;
    if (gridX < 0 || gridY < 0) {
      markRegionEmpty(gridX, gridY);
      return;
    }
    httpNamePending.add(key);
    httpNameBatchQueue.push({ gridX: gridX, gridY: gridY, key: key });
    scheduleRegionNameBatch();
  }

  function scheduleRegionNameBatch() {
    if (httpNameBatchRunning || !httpNameBatchQueue.length) return;
    httpNameBatchRunning = true;
    const batch = httpNameBatchQueue.splice(0, 25);
    const tiles = batch.map(function (item) {
      return item.gridX + ',' + item.gridY;
    }).join(';');
    BeeBridge.mapRegions(tiles).then(function (data) {
      const regions = data && data.regions ? data.regions : [];
      regions.forEach(function (row) {
        if (!row) return;
        const gx = row.gridX;
        const gy = row.gridY;
        if (gx === undefined || gy === undefined) return;
        if (row.name) {
          applyRegionInfo(gx, gy, row.name, undefined, 'http');
        } else if (row.empty) {
          markRegionEmpty(gx, gy);
        }
      });
      batch.forEach(function (item) {
        if (!isRegionResolved(item.gridX, item.gridY)) {
          markRegionEmpty(item.gridX, item.gridY);
        }
      });
    }).catch(function () {
      /* best effort - ignore failures */
    }).finally(function () {
      batch.forEach(function (item) {
        httpNamePending.delete(item.key);
      });
      httpNameBatchRunning = false;
      scheduleRegionNameBatch();
    });
  }

  function fetchRegionNameHttp(gridX, gridY) {
    queueRegionNameFetch(gridX, gridY);
  }

  function rememberBlocks(blocks) {
    (blocks || []).forEach(function (block) {
      if (!block) return;
      const key = tileKey(block.gridX, block.gridY);
      fetchedBlocks.add(key);
      const existing = regionInfo.get(key) || {};
      const access = block.access !== undefined ? block.access : existing.access;
      if (block.name) {
        applyRegionInfo(block.gridX, block.gridY, block.name, access, 'udp', block.agents);
      } else {
        if (!existing.httpTrusted) {
          markRegionEmpty(block.gridX, block.gridY);
        }
      }
    });
    const canvas = el('map-canvas');
    if (canvas && BeeState.get().activeTab === 'map') {
      refreshTileLabels(canvas);
    }
  }

  function refreshTileLabels(canvas) {
    if (!canvas) return;
    canvas.querySelectorAll('.map-tile').forEach(function (tileBtn) {
      const gx = parseInt(tileBtn.dataset.gridX, 10);
      const gy = parseInt(tileBtn.dataset.gridY, 10);
      const label = tileBtn.querySelector('.map-tile-label');
      const info = getRegionInfo(gx, gy);
      if (info && info.name) {
        tileBtn.title = info.name;
      }
      setTileLabelContent(label, gx, gy, tilePx, tileBtn);
    });
  }

  function requestNamesIfNeeded(startX, startY, endX, endY) {
    if (!BeeState.gridOnline()) return;
    let needUdp = false;
    for (let x = startX; x <= endX; x++) {
      for (let y = startY; y <= endY; y++) {
        const info = getRegionInfo(x, y);
        if (!info || !info.name) {
          queueRegionNameFetch(x, y);
        }
        if (!fetchedBlocks.has(tileKey(x, y))) {
          needUdp = true;
        }
      }
    }
    if (needUdp) {
      BeeTransport.requestMapArea(startX, startY, endX, endY);
    }
    requestAgentCountsIfNeeded(startX, startY, endX, endY);
  }

  function requestAgentCountsIfNeeded(startX, startY, endX, endY) {
    if (!BeeState.gridOnline() || !BeeTransport.requestMapAgentCounts) return;
    const tiles = [];
    for (let x = startX; x <= endX; x++) {
      for (let y = startY; y <= endY; y++) {
        const info = getRegionInfo(x, y);
        if (!info || !info.name || info.empty) continue;
        const key = tileKey(x, y);
        const last = agentRefreshAt.get(key) || info.agentsAt || 0;
        if (Date.now() - last < AGENT_REFRESH_MS) continue;
        agentRefreshAt.set(key, Date.now());
        tiles.push({ gridX: x, gridY: y, name: info.name });
      }
    }
    if (tiles.length) {
      BeeTransport.requestMapAgentCounts(tiles);
    }
  }

  function syncAvatarOnMap(data) {
    const region = data && data.region
      ? normalizeRegion(data.region)
      : normalizeRegion(BeeState.get().region || {});
    const pos = (data && data.position) || BeeState.get().position;
    if (data && data.region && region.name &&
        region.x !== undefined && region.y !== undefined) {
      applyRegionInfo(region.x, region.y, region.name, region.access, 'state');
    }
    if (region.x !== undefined && region.y !== undefined && pos) {
      BeeState.patch({
        region: Object.assign({}, BeeState.get().region, region),
        position: pos
      });
    }
    if (BeeState.get().activeTab === 'map') {
      if (!userPanned && region.x !== undefined && region.y !== undefined) {
        centerGridX = region.x;
        centerGridY = region.y;
      }
      renderTiles();
    }
  }

  function applyTileImage(imgEl, tileBtn, entry, token) {
    if (token !== renderToken) return;
    if (!entry) return;
    if (entry.state === 'ok' && entry.blobUrl) {
      imgEl.src = entry.blobUrl;
      tileBtn.classList.remove('map-tile--missing');
      return;
    }
    if (entry.state === 'missing') {
      tileBtn.classList.add('map-tile--missing');
    }
  }

  function loadTileImage(gridX, gridY, imgEl, tileBtn, token) {
    const key = tileImageKey(gridX, gridY);
    const existing = tileImageCache.get(key);
    if (existing) {
      if (existing.state === 'pending') {
        existing.waiters.push(function () {
          applyTileImage(imgEl, tileBtn, tileImageCache.get(key), token);
        });
        return;
      }
      if (existing.state === 'ok') {
        applyTileImage(imgEl, tileBtn, existing, token);
        return;
      }
      if (existing.state === 'missing') {
        tileImageCache.delete(key);
      }
    }

    const directUrl = BeeSlurl.tileUrl(mapServerUrl, MAP_LEVEL, gridX, gridY, '');

    const entry = { state: 'pending', waiters: [], revokeBlob: false, blobUrl: '', loadToken: token };
    tileImageCache.set(key, entry);

    function finish(state, url?) {
      entry.state = state;
      if (url) {
        entry.blobUrl = url;
      }
      const waiters = entry.waiters.splice(0);
      if (token === renderToken) {
        applyTileImage(imgEl, tileBtn, entry, token);
        if (state === 'missing' && !isRegionResolved(gridX, gridY)) {
          markRegionEmpty(gridX, gridY);
        }
      }
      waiters.forEach(function (fn) { fn(); });
    }

    // Fallback path: pull the tile bytes through the native core (which sidesteps
    // any cross-origin restriction on the map server) and wrap them in a blob URL.
    function loadViaBackend() {
      BeeBridge.mapTile(MAP_LEVEL, gridX, gridY, mapServerUrl).then(function (data) {
        if (!data || !data.b64) throw new Error('no tile');
        const bin = atob(data.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: data.contentType || 'image/jpeg' });
        entry.revokeBlob = true;
        finish('ok', URL.createObjectURL(blob));
      }).catch(function () {
        finish('missing');
      });
    }

    const probe = new Image();
    probe.onload = function () {
      probe.onload = null;
      probe.onerror = null;
      finish('ok', directUrl);
    };
    probe.onerror = function () {
      probe.onload = null;
      probe.onerror = null;
      loadViaBackend();
    };
    probe.src = directUrl;
  }

  function screenDy(gridY, startY) {
    return (VIEW_TILES - 1) - (gridY - startY);
  }

  function localYToScreen(localY, tileSize) {
    return ((256 - BeeUtils.clamp(localY, 0, 256)) / 256) * tileSize;
  }

  function measureTileSize(viewport) {
    if (!viewport) return 128;
    const rect = viewport.getBoundingClientRect();
    const size = Math.floor(Math.min(rect.width, rect.height) / VIEW_TILES);
    return BeeUtils.clamp(size, TILE_PX_MIN, TILE_PX_MAX);
  }

  function renderTiles() {
    const viewport = el('map-viewport');
    const canvas = el('map-canvas');
    if (!viewport || !canvas) return;

    tilePx = measureTileSize(viewport);
    const token = ++renderToken;
    const half = Math.floor(VIEW_TILES / 2);
    const startX = centerGridX - half;
    const startY = centerGridY - half;
    const width = VIEW_TILES * tilePx;
    const height = VIEW_TILES * tilePx;

    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.innerHTML = '';

    for (let row = 0; row < VIEW_TILES; row++) {
      for (let col = 0; col < VIEW_TILES; col++) {
        const gridX = startX + col;
        const gridY = startY + (VIEW_TILES - 1 - row);
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'map-tile';
        tile.style.width = tilePx + 'px';
        tile.style.height = tilePx + 'px';
        tile.style.left = (col * tilePx) + 'px';
        tile.style.top = (row * tilePx) + 'px';
        tile.dataset.gridX = String(gridX);
        tile.dataset.gridY = String(gridY);
        tile.title = getRegionName(gridX, gridY);

        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.draggable = false;
        tile.appendChild(img);

        const label = document.createElement('span');
        label.className = 'map-tile-label';
        setTileLabelContent(label, gridX, gridY, tilePx, tile);
        tile.appendChild(label);

        canvas.appendChild(tile);
        loadTileImage(gridX, gridY, img, tile, token);
      }
    }

    lastLayout = { startX: startX, startY: startY, size: tilePx };
    drawOverlays(canvas, startX, startY, tilePx);

    refreshTileLabels(canvas);
    requestNamesIfNeeded(startX, startY, startX + VIEW_TILES - 1, startY + VIEW_TILES - 1);
  }

  // Markers, chat rings, and radar dots, drawn over the tiles.
  function drawOverlays(canvas, startX, startY, size) {
    const marker = currentAgentMarker();
    if (marker &&
        marker.gridX >= startX && marker.gridX < startX + VIEW_TILES &&
        marker.gridY >= startY && marker.gridY < startY + VIEW_TILES) {
      addChatRings(canvas, marker, startX, startY, size);
      addMarker(canvas, 'map-marker map-marker--self', marker, startX, startY, size);
    }
    addRadarDots(canvas, marker, startX, startY, size);
    if (selection &&
        selection.gridX >= startX && selection.gridX < startX + VIEW_TILES &&
        selection.gridY >= startY && selection.gridY < startY + VIEW_TILES) {
      addMarker(canvas, 'map-marker map-marker--target', selection, startX, startY, size);
    }
  }

  // Redraw only the overlay layer (radar moved, we moved), leaving the tile
  // images alone - a full renderTiles refetch for a dot move would be waste.
  function refreshOverlays() {
    const canvas = el('map-canvas');
    if (!canvas || !lastLayout || !canvas.offsetParent) return;
    canvas.querySelectorAll<HTMLElement>('.map-ring, .map-marker').forEach(function (n) { n.remove(); });
    drawOverlays(canvas, lastLayout.startX, lastLayout.startY, lastLayout.size);
  }

  // Chat ranges (SL defaults): whisper 10m, say 20m, shout 100m.
  const CHAT_RINGS = [
    { meters: 10, cls: 'map-ring--whisper' },
    { meters: 20, cls: 'map-ring--say' },
    { meters: 100, cls: 'map-ring--shout' }
  ];

  // Rings around our own marker showing how far chat carries. Same
  // metres-to-pixels rule as the markers: one region = 256m = one tile.
  function addChatRings(canvas, marker, startX, startY, size) {
    const localX = BeeUtils.clamp(marker.x !== undefined ? marker.x : 128, 0, 256);
    const localY = BeeUtils.clamp(marker.y !== undefined ? marker.y : 128, 0, 256);
    const col = marker.gridX - startX;
    const row = screenDy(marker.gridY, startY);
    const cx = (col * size) + (localX / 256) * size;
    const cy = (row * size) + localYToScreen(localY, size);
    CHAT_RINGS.forEach(function (ring) {
      const radius = (ring.meters / 256) * size;
      const span = document.createElement('span');
      span.className = 'map-ring ' + ring.cls;
      span.style.left = (cx - radius) + 'px';
      span.style.top = (cy - radius) + 'px';
      span.style.width = (radius * 2) + 'px';
      span.style.height = (radius * 2) + 'px';
      canvas.appendChild(span);
    });
  }

  // Nearby residents from the radar (CoarseLocationUpdate), as dots. Those
  // positions are region-local to OUR region, so they only plot there.
  function addRadarDots(canvas, marker, startX, startY, size) {
    const region = BeeState.get().region;
    const gridX = marker ? marker.gridX : (region && region.x);
    const gridY = marker ? marker.gridY : (region && region.y);
    if (gridX === undefined || gridY === undefined) return;
    if (gridX < startX || gridX >= startX + VIEW_TILES ||
        gridY < startY || gridY >= startY + VIEW_TILES) return;
    const radar = BeeState.get().radar || [];
    radar.forEach(function (entry) {
      if (!entry || !entry.pos) return;
      const dot = document.createElement('span');
      dot.className = 'map-marker map-marker--avatar';
      dot.title = entry.name || '';
      const localX = BeeUtils.clamp(entry.pos.x !== undefined ? entry.pos.x : 128, 0, 256);
      const localY = BeeUtils.clamp(entry.pos.y !== undefined ? entry.pos.y : 128, 0, 256);
      const col = gridX - startX;
      const row = screenDy(gridY, startY);
      dot.style.left = ((col * size) + (localX / 256) * size) + 'px';
      dot.style.top = ((row * size) + localYToScreen(localY, size)) + 'px';
      canvas.appendChild(dot);
    });
  }

  function addMarker(canvas, className, loc, startX, startY, size) {
    const dot = document.createElement('span');
    dot.className = className;
    const localX = BeeUtils.clamp(loc.x !== undefined ? loc.x : 128, 0, 256);
    const localY = BeeUtils.clamp(loc.y !== undefined ? loc.y : 128, 0, 256);
    const col = loc.gridX - startX;
    const row = screenDy(loc.gridY, startY);
    dot.style.left = ((col * size) + (localX / 256) * size) + 'px';
    dot.style.top = ((row * size) + localYToScreen(localY, size)) + 'px';
    canvas.appendChild(dot);
  }

  function centerOn(gridX, gridY) {
    centerGridX = gridX;
    centerGridY = gridY;
    userPanned = false; // an explicit recenter resumes following the agent
  }

  function handleMapClick(e) {
    const tile = e.target.closest('.map-tile');
    if (!tile || !el('map-canvas')) return;
    const rect = tile.getBoundingClientRect();
    const localX = BeeUtils.clamp(((e.clientX - rect.left) / rect.width) * 256, 0, 255.9);
    const localY = BeeUtils.clamp((1 - ((e.clientY - rect.top) / rect.height)) * 256, 0, 255.9);
    const gridX = parseInt(tile.dataset.gridX, 10);
    const gridY = parseInt(tile.dataset.gridY, 10);
    const regionName = getRegionName(gridX, gridY) || ('Region ' + gridX + ',' + gridY);
    const z = selection && selection.z !== undefined ? selection.z : 25;
    setSelection({
      regionName: regionName,
      gridX: gridX,
      gridY: gridY,
      x: localX,
      y: localY,
      z: z
    });
    const input = el<HTMLInputElement>('map-location-input');
    if (input) {
      input.value = BeeSlurl.buildMapsUrl(regionName, { x: localX, y: localY, z: z });
    }
  }

  function regionErrorMessage(err, regionName) {
    const name = String(regionName || '').trim();
    const msg = err && err.message ? String(err.message) : '';
    if (/unknown region|region not found/i.test(msg)) return msg;
    if (name && (/not found|timed out|could not resolve|parse/i.test(msg) || !msg)) {
      return 'Unknown region: ' + name;
    }
    return msg || (name ? 'Unknown region: ' + name : 'Could not resolve location');
  }

  async function goToInput() {
    const input = el<HTMLInputElement>('map-location-input');
    const text = input ? input.value.trim() : '';
    if (!text) return;
    const parsed = BeeSlurl.parse(text);
    const needsLookup = parsed && parsed.regionName &&
      parsed.gridX === undefined && parsed.globalX === undefined && !parsed.isGlobalCoord;
    const info = el('map-info');
    const infoPrev = info ? info.textContent : '';
    if (needsLookup && info) {
      info.textContent = 'Looking up region...';
    }
    try {
      const loc = await BeeTransport.resolveLocation(text);
      centerOn(loc.gridX, loc.gridY);
      setSelection(loc);
      if (input) {
        input.value = BeeSlurl.buildMapsUrl(loc.regionName, loc);
      }
    } catch (err) {
      const badName = parsed && parsed.regionName ? parsed.regionName : text;
      if (needsLookup && info) {
        info.textContent = infoPrev || 'Unknown region.';
      }
      if (selection && needsLookup && parsed && parsed.regionName &&
          selection.regionName &&
          selection.regionName.toLowerCase() === String(parsed.regionName).toLowerCase()) {
        setSelection(null);
      }
      BeeUtils.showToast(regionErrorMessage(err, badName), 'error');
    }
  }

  function setTeleportButtonState(busy, label) {
    const tpBtn = el<HTMLButtonElement>('map-teleport');
    const homeBtn = el<HTMLButtonElement>('map-teleport-home');
    if (tpBtn) {
      tpBtn.disabled = !!busy;
      tpBtn.textContent = busy ? (label || 'Teleporting...') : (label || TELEPORT_BTN_LABEL);
      tpBtn.classList.toggle('map-teleport--busy', !!busy);
      tpBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    if (homeBtn) {
      homeBtn.disabled = !!busy;
      homeBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  }

  function resetTeleportButton() {
    mapTeleportBusy = false;
    mapTeleportPct = 0;
    setTeleportButtonState(false, TELEPORT_BTN_LABEL);
  }

  function beginMapTeleport(message) {
    mapTeleportBusy = true;
    applyMapTeleportProgress(message || 'requesting', 'Requesting');
  }

  async function teleportSelection() {
    if (mapTeleportBusy) return;
    const input = el<HTMLInputElement>('map-location-input');
    const text = input ? input.value.trim() : '';
    let target = selection;
    if (!target && !text) {
      BeeUtils.showToast('Select a destination on the map first', 'warning');
      return;
    }
    beginMapTeleport('requesting');
    if (text && BeeState.gridOnline()) {
      const parsed = BeeSlurl.parse(text);
      try {
        target = await BeeTransport.resolveLocation(text);
        setSelection(target);
        centerOn(target.gridX, target.gridY);
        if (input) {
          input.value = BeeSlurl.buildMapsUrl(target.regionName, target);
        }
      } catch (err) {
        resetTeleportButton();
        const badName = parsed && parsed.regionName ? parsed.regionName : text;
        BeeUtils.showToast(regionErrorMessage(err, badName), 'error');
        return;
      }
    } else if (!target) {
      resetTeleportButton();
      BeeUtils.showToast('Select a destination on the map first', 'warning');
      return;
    }
    try {
      const loc = await BeeTransport.teleportTo(target);
      setSelection(loc);
      applyMapTeleportProgress('starting', 'Starting');
    } catch (err) {
      resetTeleportButton();
      BeeUtils.showToast(err.message || 'Teleport failed', 'error');
    }
  }

  async function teleportHome() {
    if (mapTeleportBusy) return;
    beginMapTeleport('requesting');
    try {
      // The command only acks the request; being already home surfaces as the
      // benign "could not teleport closer" teleport-finish, not a return field.
      await BeeTransport.teleportHome();
      applyMapTeleportProgress('starting', 'Starting');
    } catch (err) {
      resetTeleportButton();
      BeeUtils.showToast(err.message || 'Teleport home failed', 'error');
    }
  }

  function openDestinationGuide() {
    if (typeof BeeNavigation !== 'undefined' && BeeNavigation.switchTab) {
      BeeNavigation.switchTab('destinations');
    }
  }

  function showLocation(input) {
    const parsed = typeof input === 'object' && input !== null
      ? input
      : BeeSlurl.parse(String(input || '').trim());
    if (!parsed) {
      BeeUtils.showToast('Could not parse SLURL', 'error');
      return;
    }
    BeeNavigation.switchTab('map');
    const hasGrid = parsed.gridX !== undefined && parsed.gridY !== undefined;
    const regionName = String(parsed.regionName || '').trim();
    // Grid coords alone are enough to center; the region name is optional (a pick
    // may not carry one). Requesting the tile area will resolve the name anyway.
    if (hasGrid) {
      centerOn(parsed.gridX, parsed.gridY);
      setSelection(parsed);
      const field = el<HTMLInputElement>('map-location-input');
      if (field && regionName) field.value = BeeSlurl.buildMapsUrl(regionName, parsed);
      if (BeeState.gridOnline() && typeof BeeTransport.requestMapArea === 'function') {
        BeeTransport.requestMapArea(parsed.gridX, parsed.gridY, parsed.gridX, parsed.gridY)
          .catch(function () { /* tile refresh is optional - ignore errors */ });
      }
      return;
    }
    if (!BeeState.gridOnline()) {
      if (hasGrid) {
        centerOn(parsed.gridX, parsed.gridY);
        setSelection(parsed);
      }
      return;
    }
    BeeTransport.resolveLocation(parsed).then(function (loc) {
      centerOn(loc.gridX, loc.gridY);
      setSelection(loc);
      const field = el<HTMLInputElement>('map-location-input');
      if (field) field.value = BeeSlurl.buildMapsUrl(loc.regionName, loc);
    }).catch(function (err) {
      const badName = parsed.regionName ||
        (typeof input === 'string' ? input : '');
      BeeUtils.showToast(regionErrorMessage(err, badName), 'error');
    });
  }

  function onConnected(payload) {
    mapServerUrl = BeeSlurl.normalizeMapServerUrl(
      (payload && payload.mapServerUrl) || BeeTransport.getMapServerUrl()
    );
    const region = normalizeRegion((payload && payload.region) || BeeState.get().region || {});
    if (region.x !== undefined && region.y !== undefined) {
      centerGridX = region.x;
      centerGridY = region.y;
    }
    const marker = currentAgentMarker();
    if (marker) {
      setSelection({
        regionName: marker.regionName || region.name || '',
        gridX: marker.gridX,
        gridY: marker.gridY,
        x: marker.x,
        y: marker.y,
        z: marker.z || 25
      });
    }
  }

  function activate() {
    seedKnownRegions();
    requestAnimationFrame(function () {
      renderTiles();
    });
  }

  function init() {
    const canvas = el('map-canvas');
    const form = el('map-form');
    const tpBtn = el<HTMLButtonElement>('map-teleport');
    const homeBtn = el<HTMLButtonElement>('map-teleport-home');
    const guideBtn = el('map-open-guide');
    const centerBtn = el('map-center-self');
    const panN = el('map-pan-n');
    const panS = el('map-pan-s');
    const panE = el('map-pan-e');
    const panW = el('map-pan-w');

    if (canvas) {
      canvas.addEventListener('click', handleMapClick);
    }
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        goToInput();
      });
      const locationField = el<HTMLInputElement>('map-location-input');
      if (locationField) {
        locationField.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            goToInput();
          }
        });
      }
    }
    if (tpBtn) {
      tpBtn.addEventListener('click', teleportSelection);
    }
    if (homeBtn) {
      homeBtn.addEventListener('click', teleportHome);
    }
    if (guideBtn) {
      guideBtn.addEventListener('click', openDestinationGuide);
    }
    if (centerBtn) {
      centerBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const marker = currentAgentMarker();
        if (!marker) return;
        centerOn(marker.gridX, marker.gridY);
        setSelection({
          regionName: marker.regionName || (BeeState.get().region && BeeState.get().region.name) || '',
          gridX: marker.gridX,
          gridY: marker.gridY,
          x: marker.x,
          y: marker.y,
          z: marker.z || 25
        });
      });
    }
    if (panN) {
      panN.addEventListener('click', function (e) {
        e.stopPropagation();
        userPanned = true;
        centerGridY += 1;
        renderTiles();
      });
    }
    if (panS) {
      panS.addEventListener('click', function (e) {
        e.stopPropagation();
        userPanned = true;
        centerGridY -= 1;
        renderTiles();
      });
    }
    if (panE) {
      panE.addEventListener('click', function (e) {
        e.stopPropagation();
        userPanned = true;
        centerGridX += 1;
        renderTiles();
      });
    }
    if (panW) {
      panW.addEventListener('click', function (e) {
        e.stopPropagation();
        userPanned = true;
        centerGridX -= 1;
        renderTiles();
      });
    }

    let resizeTimer = null;
    window.addEventListener('resize', function () {
      if (BeeState.get().activeTab !== 'map') return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderTiles, 150);
    });

    BeeTransport.on('map-blocks', rememberBlocks);
    BeeTransport.on('map-agents', function (data) {
      if (!data || data.gridX === undefined || data.gridY === undefined) return;
      applyRegionAgents(data.gridX, data.gridY, data.agents);
    });
    BeeTransport.on('teleport-started', function (loc) {
      if (!loc || loc.gridX === undefined || loc.gridY === undefined) return;
      if (mapTeleportBusy) {
        applyMapTeleportProgress('starting', 'Starting');
      }
      if (loc.regionName && !isPlaceholderRegionName(loc.regionName)) {
        applyRegionInfo(loc.gridX, loc.gridY, loc.regionName, undefined, 'state');
      } else if (!loc.regionName) {
        // Teleports started elsewhere (lure, landmark) carry no name; keep the
        // one the selection already has for these coords instead of wiping it.
        loc.regionName = (selection && selection.gridX === loc.gridX &&
            selection.gridY === loc.gridY && selection.regionName)
          ? selection.regionName
          : getRegionName(loc.gridX, loc.gridY);
      }
      centerOn(loc.gridX, loc.gridY);
      setSelection(loc);
    });
    BeeTransport.on('teleport-progress', function (data) {
      if (!mapTeleportBusy) return;
      applyMapTeleportProgress(data && data.message, 'Teleporting');
    });
    BeeTransport.on('region', function (data) {
      if (!data || !data.name || data.handshakeOnly) return;
      if (data.x === undefined || data.y === undefined) return;
      const region = normalizeRegion(data);
      if (region.x !== undefined && region.y !== undefined) {
        applyRegionInfo(region.x, region.y, region.name, region.access, 'state');
      }
    });
    BeeState.on('reset', function () {
      selection = null;
      clearTileCache();
      resetTeleportButton();
      updateInfo();
    });
    BeeTransport.on('position', function (data) {
      syncAvatarOnMap(data);
    });
    // Nearby residents moved: repaint the dots (cheap, overlay-only).
    BeeState.on('radar-update', BeeUtils.debounce(function () {
      refreshOverlays();
    }, 400));
    BeeTransport.on('teleport-failed', function () {
      resetTeleportButton();
    });
    BeeTransport.on('teleport-cancelled', function () {
      resetTeleportButton();
    });
    BeeTransport.on('teleport-finish', function (data) {
      if (mapTeleportBusy) {
        applyMapTeleportProgress('arriving', 'Arriving');
        window.setTimeout(resetTeleportButton, 400);
      } else {
        resetTeleportButton();
      }
      userPanned = false; // arriving somewhere new resumes following the agent
      syncAvatarOnMap(data);
      if (data && data.gridX != null && data.gridY != null) {
        // Recenter on the destination region - the grid coords come decoded from
        // the teleport's RegionHandle. Without this the map lingers on the old region.
        centerOn(data.gridX, data.gridY);
        setSelection({
          regionName: data.regionName || getRegionName(data.gridX, data.gridY) ||
            ('Region ' + data.gridX + ', ' + data.gridY),
          gridX: data.gridX, gridY: data.gridY
        });
      } else if (data && data.region) {
        const region = normalizeRegion(data.region);
        if (region.x !== undefined && region.y !== undefined) {
          centerGridX = region.x;
          centerGridY = region.y;
        }
      }
      if (data && data.position && data.region) {
        const region = normalizeRegion(data.region);
        if (region.x !== undefined && region.y !== undefined) {
          const selName = !isPlaceholderRegionName(data.regionName)
            ? data.regionName
            : (!isPlaceholderRegionName(region.name)
              ? region.name
              : getRegionName(region.x, region.y));
          if (selName && !isPlaceholderRegionName(selName)) {
            applyRegionInfo(region.x, region.y, selName, region.access, 'state');
          }
          setSelection({
            regionName: selName,
            gridX: region.x,
            gridY: region.y,
            x: data.position.x,
            y: data.position.y,
            z: data.position.z !== undefined ? data.position.z : 25
          });
          renderTiles();
        }
      }
    });

    updateInfo();
  }

  return {
    init: init,
    onConnected: onConnected,
    activate: activate,
    showLocation: showLocation,
    centerOn: centerOn,
    setSelection: setSelection,
    renderTiles: renderTiles,
    beginMapTeleport: beginMapTeleport,
    resetTeleportButton: resetTeleportButton
  };
})();

window.BeeMap = BeeMap;
