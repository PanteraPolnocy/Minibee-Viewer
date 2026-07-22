/**
 * SLURL / maps URL parsing, region handles, and chat linkification.
 */
const FSSlurl = (function () {
  'use strict';

  const REGION_WIDTH = 256;
  // Region indices on the world map are well below this; global origins are much larger (metres).
  const GRID_INDEX_MAX = 4096;
  const DEFAULT_MAP_SERVER = 'https://map.secondlife.com/';
  const SLURL_PATTERN = /(?:https?:\/\/maps\.secondlife\.com\/secondlife\/[^\s<]+|secondlife:\/\/[^\s<]+)/gi;

  // Canonical grammar lives in urlmatch.rs (`bridge_linkify`); kept here for sync render.
  const TRUSTED_SUFFIXES = [
    'secondlife.com', 'secondlife.io', 'secondlife.net', 'lindenlab.com',
    'tilia-inc.com', 'phoenixviewer.com', 'firestormviewer.org'
  ];
  const LINK_BRACKET = /\[\s*((?:secondlife:\/\/|https?:\/\/)[^\s\]]+)[ \t]+([^\]]*?)\s*\]/gi;
  const LINK_SLURL = /(?:secondlife:\/\/[^\s<>\]"]+|https?:\/\/maps\.secondlife\.com\/secondlife\/[^\s<>\]"]+)/gi;
  const LINK_HTTP = /https?:\/\/[^\s<>\]"]+/gi;
  const LINK_EMAIL = /\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b/gi;

  function hostOf(url) {
    const afterScheme = url.indexOf('://') >= 0 ? url.slice(url.indexOf('://') + 3) : url;
    let host = afterScheme.split(/[/?#]/)[0] || '';
    const at = host.lastIndexOf('@');
    if (at >= 0) host = host.slice(at + 1);
    host = host.split(':')[0];
    return host.toLowerCase();
  }

  function hostTrusted(host) {
    if (!host) return false;
    return TRUSTED_SUFFIXES.some(function (s) {
      return host === s || host.endsWith('.' + s);
    });
  }

  // Drop sentence punctuation a URL should not swallow; keep a closing paren
  // only when it balances an opening one inside the URL.
  function trimTrailingUrl(url) {
    let end = url.length;
    while (end > 0) {
      const c = url[end - 1];
      let drop = false;
      if ('.,;:!?\'">'.indexOf(c) >= 0 || c === ']') drop = true;
      else if (c === ')') drop = url.slice(0, end).indexOf('(') < 0;
      if (drop) end -= 1; else break;
    }
    return url.slice(0, end);
  }

  function slurlLabel(url) {
    const parsed = parse(url);
    if (parsed && parsed.type === 'app-agent') return 'Resident profile';
    if (parsed && parsed.type === 'app-group') return 'Group profile';
    if (parsed && parsed.regionName) {
      if (parsed.x !== undefined && parsed.y !== undefined) {
        const z = parsed.z !== undefined ? parsed.z : 25;
        return parsed.regionName + ' (' + parsed.x + ', ' + parsed.y + ', ' + z + ')';
      }
      return parsed.regionName;
    }
    return url;
  }

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

    // App SLURLs (profile links in chat/notices) are not map locations.
    m = raw.match(/^secondlife:\/\/\/?app\/(agent|group)\/([0-9a-f-]{32,36})/i);
    if (m) {
      return { type: 'app-' + m[1].toLowerCase(), id: m[2].toLowerCase(), url: raw };
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

  // Split text into link segments (same grammar as urlmatch::linkify).
  function scanLinks(text) {
    const src = String(text || '');
    const raws = [];
    let m;
    const bracket = new RegExp(LINK_BRACKET.source, 'gi');
    while ((m = bracket.exec(src)) !== null) {
      const url = trimTrailingUrl(m[1]);
      const label = (m[2] || '').trim();
      const isSlurl = /^secondlife:\/\//i.test(url) || /maps\.secondlife\.com\/secondlife\//i.test(url);
      raws.push({ start: m.index, end: m.index + m[0].length, url: url,
        label: label || null, kind: isSlurl ? 'slurl' : 'http', bracketed: true, priority: 0 });
    }
    const slurl = new RegExp(LINK_SLURL.source, 'gi');
    while ((m = slurl.exec(src)) !== null) {
      const trimmed = trimTrailingUrl(m[0]);
      raws.push({ start: m.index, end: m.index + trimmed.length, url: trimmed,
        label: null, kind: 'slurl', bracketed: false, priority: 1 });
    }
    const http = new RegExp(LINK_HTTP.source, 'gi');
    while ((m = http.exec(src)) !== null) {
      const trimmed = trimTrailingUrl(m[0]);
      raws.push({ start: m.index, end: m.index + trimmed.length, url: trimmed,
        label: null, kind: 'http', bracketed: false, priority: 2 });
    }
    const email = new RegExp(LINK_EMAIL.source, 'gi');
    while ((m = email.exec(src)) !== null) {
      raws.push({ start: m.index, end: m.index + m[0].length, url: 'mailto:' + m[0],
        label: m[0], kind: 'email', bracketed: false, priority: 3 });
    }
    raws.sort(function (a, b) { return a.start - b.start || a.priority - b.priority; });

    const segments = [];
    let cursor = 0;
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i];
      if (raw.start < cursor || raw.end <= raw.start) continue;
      if (raw.start > cursor) segments.push({ type: 'text', text: src.slice(cursor, raw.start) });
      let trusted;
      if (raw.kind === 'slurl') {
        trusted = /^secondlife:\/\//i.test(raw.url) || hostTrusted(hostOf(raw.url));
      } else if (raw.kind === 'http') {
        trusted = hostTrusted(hostOf(raw.url));
      } else {
        trusted = false;
      }
      const label = raw.label || (raw.kind === 'slurl' ? slurlLabel(raw.url) : raw.url);
      segments.push({ type: 'link', url: raw.url, label: label, trusted: trusted,
        kind: raw.kind, bracketed: raw.bracketed });
      cursor = raw.end;
    }
    if (cursor < src.length) segments.push({ type: 'text', text: src.slice(cursor) });
    return segments;
  }

  function linkify(text, escapeFn) {
    const esc = escapeFn || function (s) { return String(s); };
    const segments = scanLinks(text);
    let html = '';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.type === 'text') {
        html += esc(seg.text);
        continue;
      }
      const attr = function (v) { return esc(String(v)).replace(/"/g, '&quot;'); };
      if (seg.kind === 'slurl') {
        html += '<a href="#" class="slurl-link" title="' + attr(seg.url) +
          '" data-slurl="' + attr(seg.url) + '">' + esc(seg.label) + '</a>';
      } else {
        html += '<a href="#" class="chat-link chat-link--' + (seg.trusted ? 'trusted' : 'external') +
          '" title="' + attr(seg.url) + '" data-url="' + attr(seg.url) +
          '" data-trusted="' + (seg.trusted ? '1' : '0') + '">' + esc(seg.label) + '</a>';
      }
    }
    return html;
  }

  function openExternalUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return;
    try {
      if (window.__TAURI__ && window.__TAURI__.opener &&
          typeof window.__TAURI__.opener.openUrl === 'function') {
        window.__TAURI__.opener.openUrl(raw);
        return;
      }
    } catch (_e) { /* fall through to window.open */ }
    window.open(raw, '_blank', 'noopener,noreferrer');
  }

  // Bind click handlers for links produced by linkify(): SLURLs show on the map;
  // external URLs open in the OS browser (untrusted ones behind a confirm).
  function bindLinks(container) {
    if (!container || !container.querySelectorAll) return;
    container.querySelectorAll('.slurl-link').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        const target = link.dataset.slurl || link.textContent;
        const parsed = parse(target);
        if (parsed && parsed.type === 'app-agent' && typeof FSProfile !== 'undefined') {
          FSProfile.openAvatar(parsed.id);
        } else if (parsed && parsed.type === 'app-group' && typeof FSProfile !== 'undefined') {
          FSProfile.openGroup(parsed.id);
        } else if (typeof FSMap !== 'undefined' && FSMap.showLocation) {
          FSMap.showLocation(target);
        }
      });
    });
    container.querySelectorAll('.chat-link').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        const url = link.dataset.url || '';
        if (!url) return;
        const trusted = link.dataset.trusted === '1';
        if (trusted) {
          openExternalUrl(url);
          return;
        }
        const ask = (typeof FSUtils !== 'undefined' && FSUtils.confirm)
          ? FSUtils.confirm({
              title: 'Open external link?',
              message: 'This link leaves Second Life and opens in your browser:\n' + url,
              confirmLabel: 'Open',
              cancelLabel: 'Cancel'
            })
          : Promise.resolve(window.confirm('Open external link?\n' + url));
        ask.then(function (ok) { if (ok) openExternalUrl(url); });
      });
    });
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

  // Region-name lookup uses the native core only (`FSBridge.regionByName`).

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
    scanLinks: scanLinks,
    bindLinks: bindLinks,
    openExternalUrl: openExternalUrl,
    findSlurls: findSlurls
  };
})();
