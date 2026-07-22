/**
 * Native backend client over Tauri IPC (`window.__TAURI__.core.invoke`).
 */
const FSBridge = (function () {
  'use strict';

  function tauri() {
    return (typeof window !== 'undefined' && window.__TAURI__) ? window.__TAURI__ : null;
  }

  function isTauri() {
    const t = tauri();
    return !!(t && t.core && typeof t.core.invoke === 'function');
  }

  function invoke(cmd, args) {
    const t = tauri();
    if (!t || !t.core || typeof t.core.invoke !== 'function') {
      return Promise.reject(new Error('Minibee backend unavailable — run the Minibee app (Tauri), not a browser.'));
    }
    return t.core.invoke(cmd, args || {});
  }

  /** Subscribe to a backend event. Returns a Promise of an unlisten function. */
  function listen(event, handler) {
    const t = tauri();
    if (!t || !t.event || typeof t.event.listen !== 'function') {
      return Promise.resolve(function () {});
    }
    return t.event.listen(event, function (e) { handler(e.payload); });
  }

  function Bridge() {
    this.circuitSessionId = '';
    this.udpListenPort = 0;
    this.simIp = '';
    this.agentSessionId = '';
    this.baseUrl = '';
  }

  Bridge.prototype.setCircuitContext = function (sessionId, localPort, simIp, agentSessionId) {
    this.circuitSessionId = sessionId || '';
    this.udpListenPort = localPort || 0;
    this.simIp = simIp || this.simIp || '';
    this.agentSessionId = agentSessionId || this.agentSessionId || '';
  };

  Bridge.prototype._proxyContext = function (options) {
    const ctx = {};
    const opts = options || {};
    if (opts.sessionId) ctx.sessionId = opts.sessionId;
    else if (this.circuitSessionId) ctx.sessionId = this.circuitSessionId;
    if (!opts.preCircuit) {
      if (opts.udpListenPort) ctx.udpListenPort = opts.udpListenPort;
      else if (this.udpListenPort) ctx.udpListenPort = this.udpListenPort;
    }
    if (opts.simIp) ctx.simIp = opts.simIp;
    else if (this.simIp) ctx.simIp = this.simIp;
    if (opts.pinSimIp === false) ctx.pinSimIp = false;
    if (opts.agentSessionId) ctx.agentSessionId = opts.agentSessionId;
    else if (this.agentSessionId) ctx.agentSessionId = this.agentSessionId;
    if (opts.preCircuit) ctx.preCircuit = true;
    return ctx;
  };

  Bridge.prototype.health = function () {
    return invoke('bridge_health');
  };

  Bridge.prototype.login = function (payload) {
    return invoke('bridge_login', { payload: payload });
  };

  function proxyParams(self, url, body, contentType, options, method) {
    const ctx = self._proxyContext(options || {});
    const params = Object.assign({
      method: method || 'POST',
      url: url,
      contentType: contentType || 'application/llsd+xml'
    }, ctx);
    if (method !== 'GET') params.body = body || '';
    const opts = options || {};
    if (opts.timeoutMs) params.timeoutSec = Math.ceil(opts.timeoutMs / 1000);
    if (opts.parseLlsd) params.parseLlsd = true;
    return params;
  }

  Bridge.prototype.proxy = function (url, body, contentType, options) {
    return invoke('bridge_proxy', { params: proxyParams(this, url, body, contentType, options, 'POST') });
  };

  // Same backend path; kept distinct so latency-sensitive callers read clearly.
  Bridge.prototype.proxyPriority = function (url, body, contentType, options) {
    return invoke('bridge_proxy', { params: proxyParams(this, url, body, contentType, options, 'POST') });
  };

  Bridge.prototype.proxyGet = function (url, options) {
    return invoke('bridge_proxy', { params: proxyParams(this, url, '', '', options, 'GET') });
  };

  Bridge.prototype.openCircuit = function (simIp, simPort) {
    return invoke('sl_open_circuit', { simIp: simIp, simPort: Number(simPort) || 0 });
  };

  Bridge.prototype.closeCircuit = function (sessionId) {
    return invoke('sl_close_circuit', { sessionId: sessionId || '' });
  };

  Bridge.prototype.retargetCircuit = function (sessionId, simIp, simPort) {
    return invoke('sl_retarget', { sessionId: sessionId, simIp: simIp, simPort: Number(simPort) || 0 });
  };

  /** Encode (from the message template) and send a message on the circuit. */
  Bridge.prototype.slSend = function (sessionId, name, blocks, reliable) {
    return invoke('sl_send', {
      sessionId: sessionId,
      name: name,
      blocks: blocks || {},
      reliable: !!reliable
    });
  };

  /** Send an already-framed packet (base64). Optional per-send sim target. */
  Bridge.prototype.slSendRaw = function (sessionId, packetB64, simIp, simPort) {
    const args = { sessionId: sessionId, packet: packetB64 };
    if (simIp) args.simIp = simIp;
    if (simPort) args.simPort = Number(simPort) || 0;
    return invoke('sl_send_raw', args);
  };

  Bridge.prototype.isAvailable = async function () {
    try {
      const h = await invoke('bridge_health');
      return !!(h && h.ok);
    } catch (_e) {
      return false;
    }
  };

  // --- Map / Destination Guide helpers ---

  function mapTile(level, gridX, gridY, server) {
    return invoke('bridge_map_tile', { level: Number(level) || 1, x: Number(gridX) || 0, y: Number(gridY) || 0, server: server || undefined });
  }
  function mapRegions(tiles) {
    return invoke('bridge_map_regions', { tiles: String(tiles || '') });
  }
  function mapRegion(gridX, gridY) {
    return invoke('bridge_map_region', { x: Number(gridX) || 0, y: Number(gridY) || 0 });
  }
  function regionByName(name) {
    return invoke('bridge_region_by_name', { name: String(name || '') });
  }
  function destinations(feed) {
    return invoke('bridge_destinations', { feed: String(feed || 'mobile') });
  }
  function version() {
    return invoke('bridge_version');
  }

  return {
    Bridge: Bridge,
    isTauri: isTauri,
    invoke: invoke,
    listen: listen,
    mapTile: mapTile,
    mapRegions: mapRegions,
    mapRegion: mapRegion,
    regionByName: regionByName,
    destinations: destinations,
    version: version
  };
})();
