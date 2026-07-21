/**
 * SLURL / maps URL parsing, region handles, and chat linkification.
 */
const FSSlurl = (function () {
  'use strict';

  const REGION_WIDTH = 256;
  // Region indices on the world map are well below this; global origins are much larger (metres).
  const GRID_INDEX_MAX = 4096;
  const DEFAULT_MAP_SERVER = 'https://map.secondlife.com/';
  const CAP_REGION_NAME_TO_COORDS =
    'https://cap.secondlife.com/cap/0/d661249b-2b5a-4436-966a-3d3b8d7a574f';
  const SLURL_PATTERN = /(?:https?:\/\/maps\.secondlife\.com\/secondlife\/[^\s<]+|secondlife:\/\/[^\s<]+)/gi;

  function normalizeMapServerUrl(url) {
    let s = String(url || '').trim();
    if (!s) return DEFAULT_MAP_SERVER;
    if (!/\/$/.test(s)) s += '/';
    return s;
  }

  function toRegionHandle(globalX, globalY) {
    const gx = Math.floor(globalX / REGION_WIDTH) * REGION_WIDTH;
    const gy = Math.floor(globalY / REGION_WIDTH) * REGION_WIDTH;
    const hi = BigInt(gx >>> 0);
    const lo = BigInt(gy >>> 0);
    return (hi << 32n) | lo;
  }

  function fromRegionHandle(handle) {
    const h = BigInt(handle || 0);
    const globalX = Number(h >> 32n);
    const globalY = Number(h & 0xFFFFFFFFn);
    return {
      globalX: globalX,
      globalY: globalY,
      gridX: Math.floor(globalX / REGION_WIDTH),
      gridY: Math.floor(globalY / REGION_WIDTH)
    };
  }

  function gridToRegionHandle(gridX, gridY) {
    return toRegionHandle(gridX * REGION_WIDTH, gridY * REGION_WIDTH);
  }

  function globalToGrid(globalX, globalY) {
    const gx = Math.floor(Number(globalX) / REGION_WIDTH) * REGION_WIDTH;
    const gy = Math.floor(Number(globalY) / REGION_WIDTH) * REGION_WIDTH;
    return {
      globalX: gx,
      globalY: gy,
      gridX: Math.floor(gx / REGION_WIDTH),
      gridY: Math.floor(gy / REGION_WIDTH)
    };
  }

  // Linden name-to-coords cap returns map grid indices, not global metres.
  function capCoordsToGrid(x, y) {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
    if (nx < GRID_INDEX_MAX && ny < GRID_INDEX_MAX) {
      const gridX = Math.floor(nx);
      const gridY = Math.floor(ny);
      return {
        globalX: gridX * REGION_WIDTH,
        globalY: gridY * REGION_WIDTH,
        gridX: gridX,
        gridY: gridY
      };
    }
    return globalToGrid(nx, ny);
  }

  function parseGlobalCoordRegionName(name) {
    const m = String(name || '').trim().match(/^Region\s+(\d+)\s*[,.\s]+\s*(\d+)$/i);
    if (!m) return null;
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    if (a < GRID_INDEX_MAX && b < GRID_INDEX_MAX) {
      return {
        globalX: a * REGION_WIDTH,
        globalY: b * REGION_WIDTH,
        gridX: a,
        gridY: b,
        isGridIndex: true
      };
    }
    return globalToGrid(a, b);
  }

  function enrichParsed(parsed) {
    if (!parsed) return null;
    const coord = parseGlobalCoordRegionName(parsed.regionName);
    if (coord) {
      parsed.globalX = coord.globalX;
      parsed.globalY = coord.globalY;
      parsed.gridX = coord.gridX;
      parsed.gridY = coord.gridY;
      parsed.isGlobalCoord = true;
    }
    return parsed;
  }

  function regionHandleToString(handle) {
    const h = BigInt(handle || 0);
    return h.toString();
  }

  function decodeRegionPath(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    if (!parts.length) return null;

    let idx = 0;
    if (parts[0].toLowerCase() === 'secondlife') idx = 1;
    if (parts[idx] && parts[idx].toLowerCase() === 'app') idx += 1;
    if (parts[idx] && parts[idx].toLowerCase() === 'secondlife') idx += 1;
    if (!parts[idx]) return null;

    const regionName = decodeURIComponent(parts[idx].replace(/\+/g, ' '));
    const nums = parts.slice(idx + 1).map(function (p) { return parseInt(p, 10); });
    const out = { regionName: regionName, raw: path };
    if (nums.length >= 2 && !Number.isNaN(nums[0]) && !Number.isNaN(nums[1])) {
      out.x = nums[0];
      out.y = nums[1];
      out.z = (nums.length >= 3 && !Number.isNaN(nums[2])) ? nums[2] : 25;
    }
    return out;
  }

  function parse(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    let m = raw.match(/^https?:\/\/maps\.secondlife\.com\/secondlife\/(.+)$/i);
    if (m) {
      const decoded = decodeRegionPath(m[1]);
      if (decoded) return enrichParsed(Object.assign({ type: 'maps', url: raw }, decoded));
    }

    m = raw.match(/^secondlife:\/\/(.+)$/i);
    if (m) {
      const decoded = decodeRegionPath(m[1]);
      if (decoded) return enrichParsed(Object.assign({ type: 'slurl', url: raw }, decoded));
    }

    m = raw.match(/^([^/]+)\/(\d+)\/(\d+)(?:\/(\d+))?$/);
    if (m) {
      return enrichParsed({
        type: 'region-path',
        regionName: decodeURIComponent(m[1].replace(/\+/g, ' ')),
        x: parseInt(m[2], 10),
        y: parseInt(m[3], 10),
        z: m[4] ? parseInt(m[4], 10) : 25,
        raw: raw
      });
    }

    if (/^[\w .,'-]+$/i.test(raw) && raw.indexOf('://') < 0) {
      return enrichParsed({ type: 'region', regionName: raw, raw: raw });
    }

    return null;
  }

  function buildMapsUrl(regionName, position) {
    const name = String(regionName || 'Region').trim().replace(/\s+/g, '%20');
    const pos = position || { x: 128, y: 128, z: 25 };
    return 'http://maps.secondlife.com/secondlife/' + name + '/' +
      Math.round(pos.x) + '/' + Math.round(pos.y) + '/' + Math.round(pos.z);
  }

  function tileUrl(mapServer, level, gridX, gridY, bridgeBase) {
    const gx = Math.floor(Number(gridX) || 0);
    const gy = Math.floor(Number(gridY) || 0);
    if (bridgeBase) {
      const bridge = String(bridgeBase).replace(/\/$/, '');
      return bridge + '/map/tile?level=' + level + '&x=' + gx + '&y=' + gy +
        '&server=' + encodeURIComponent(normalizeMapServerUrl(mapServer));
    }
    const base = normalizeMapServerUrl(mapServer);
    return base + 'map-' + level + '-' + gx + '-' + gy + '-objects.jpg';
  }

  function formatLocation(loc) {
    if (!loc) return '';
    const name = loc.regionName || ('Region ' + loc.gridX + ',' + loc.gridY);
    const x = Math.round(loc.x !== undefined ? loc.x : 128);
    const y = Math.round(loc.y !== undefined ? loc.y : 128);
    const z = Math.round(loc.z !== undefined ? loc.z : 25);
    return name + ' (' + x + ', ' + y + ', ' + z + ')';
  }

  function linkify(text, escapeFn) {
    const esc = escapeFn || function (s) { return String(s); };
    const src = String(text || '');
    if (!src) return '';

    let html = '';
    let last = 0;
    const re = new RegExp(SLURL_PATTERN.source, 'gi');
    let match;
    while ((match = re.exec(src)) !== null) {
      html += esc(src.slice(last, match.index));
      const url = match[0];
      const parsed = parse(url);
      const label = parsed && parsed.regionName
        ? esc(parsed.regionName + (parsed.x !== undefined ? ' ' + parsed.x + '/' + parsed.y + '/' + parsed.z : ''))
        : esc(url);
      html += '<a href="#" class="slurl-link" data-slurl="' +
        esc(url).replace(/"/g, '&quot;') + '">' + label + '</a>';
      last = match.index + url.length;
    }
    html += esc(src.slice(last));
    return html;
  }

  function findSlurls(text) {
    const out = [];
    const re = new RegExp(SLURL_PATTERN.source, 'gi');
    let match;
    while ((match = re.exec(String(text || ''))) !== null) {
      out.push(match[0]);
    }
    return out;
  }

  function fetchRegionByNameCap(regionName, timeoutMs) {
    const name = String(regionName || '').trim();
    if (!name) {
      return Promise.reject(new Error('Region name required'));
    }
    if (typeof document === 'undefined' || !document.head) {
      return Promise.reject(new Error('Region lookup unavailable'));
    }
    return new Promise(function (resolve, reject) {
      const varName = 'mbCap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const script = document.createElement('script');
      let settled = false;
      const limit = timeoutMs || 12000;
      const timer = setTimeout(function () {
        finish(new Error('Region lookup timed out'));
      }, limit);
      function finish(err, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { delete window[varName]; } catch (_e) { window[varName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
        if (err) reject(err);
        else resolve(result);
      }
      function verifyAtGrid(grid) {
        FSBridge.mapRegions(grid.gridX + ',' + grid.gridY).then(function (data) {
          if (!data) {
            finish(new Error('Region not found: ' + name));
            return;
          }
          const regions = data && data.regions ? data.regions : [];
          const row = regions.find(function (r) {
            return r && r.gridX === grid.gridX && r.gridY === grid.gridY;
          });
          const actual = row && !row.empty && row.name ? String(row.name).trim() : '';
          if (!actual || actual.toLowerCase() !== name.toLowerCase()) {
            finish(new Error('Region not found: ' + name));
            return;
          }
          finish(null, {
            name: actual,
            globalX: grid.globalX,
            globalY: grid.globalY,
            gridX: grid.gridX,
            gridY: grid.gridY
          });
        }).catch(function () {
          finish(new Error('Region not found: ' + name));
        });
      }
      script.onerror = function () {
        finish(new Error('Region lookup failed'));
      };
      script.onload = function () {
        const result = window[varName];
        if (!result || result.error) {
          finish(new Error('Region not found: ' + name));
          return;
        }
        const grid = capCoordsToGrid(result.x, result.y);
        if (!grid) {
          finish(new Error('Region not found: ' + name));
          return;
        }
        verifyAtGrid(grid);
      };
      script.src = CAP_REGION_NAME_TO_COORDS + '?var=' + encodeURIComponent(varName) +
        '&sim_name=' + encodeURIComponent(name);
      document.head.appendChild(script);
    });
  }

  return {
    REGION_WIDTH: REGION_WIDTH,
    GRID_INDEX_MAX: GRID_INDEX_MAX,
    DEFAULT_MAP_SERVER: DEFAULT_MAP_SERVER,
    normalizeMapServerUrl: normalizeMapServerUrl,
    toRegionHandle: toRegionHandle,
    fromRegionHandle: fromRegionHandle,
    gridToRegionHandle: gridToRegionHandle,
    globalToGrid: globalToGrid,
    capCoordsToGrid: capCoordsToGrid,
    parseGlobalCoordRegionName: parseGlobalCoordRegionName,
    regionHandleToString: regionHandleToString,
    parse: parse,
    buildMapsUrl: buildMapsUrl,
    tileUrl: tileUrl,
    formatLocation: formatLocation,
    linkify: linkify,
    findSlurls: findSlurls,
    fetchRegionByNameCap: fetchRegionByNameCap
  };
})();
