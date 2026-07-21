/**
 * HTTP client for the Minibee bridge daemons.
 *
 * Caps bridge (8794): UI, login, proxy, map.
 * Poll bridge (8795): UDP circuit only - never shares a process with long proxy calls.
 *
 * Circuit poll/exchange/send use the poll URL on a priority lane (immediate fetch).
 */
const FSBridge = (function () {
  'use strict';

  const DEFAULT_CAPS_URL = 'http://127.0.0.1:8794';
  const DEFAULT_POLL_URL = 'http://127.0.0.1:8795';

  function derivePollUrl(capsUrl) {
    try {
      const u = new URL(capsUrl || DEFAULT_CAPS_URL);
      const port = parseInt(u.port || '8794', 10);
      u.port = String(port + 1);
      return u.origin;
    } catch (_e) {
      return DEFAULT_POLL_URL;
    }
  }

  function Bridge(capsUrl, pollUrl) {
    if (capsUrl && typeof capsUrl === 'object' && !pollUrl) {
      const opts = capsUrl;
      capsUrl = opts.capsUrl || opts.baseUrl || opts.bridgeUrl;
      pollUrl = opts.pollUrl;
    }
    this.capsUrl = String(capsUrl || DEFAULT_CAPS_URL).replace(/\/$/, '');
    this.pollUrl = String(pollUrl || derivePollUrl(this.capsUrl)).replace(/\/$/, '');
    this.baseUrl = this.capsUrl;
    this.circuitSessionId = '';
    this.udpListenPort = 0;
    this.simIp = '';
    this.agentSessionId = '';
    this._bgQueue = Promise.resolve();
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

  /** Background lane on caps bridge: proxy, login, map. */
  Bridge.prototype._fetchCaps = function (path, options) {
    const self = this;
    const run = function () {
      return self._fetchDirect(self.capsUrl, path, options);
    };
    const next = this._bgQueue.then(run, run);
    this._bgQueue = next.then(function () {}, function () {});
    return next;
  };

  /** Priority lane on poll bridge: circuit poll/exchange/send/open. */
  Bridge.prototype._fetchPoll = function (path, options) {
    return this._fetchDirect(this.pollUrl, path, options);
  };

  Bridge.prototype._fetchDirect = async function (baseUrl, path, options) {
    const opts = Object.assign({}, options || {});
    if (opts.body) {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    }
    const timeoutMs = opts.timeoutMs || 45000;
    const externalSignal = opts.signal;
    delete opts.timeoutMs;
    delete opts.signal;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    if (controller) {
      opts.signal = controller.signal;
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort();
        } else {
          externalSignal.addEventListener('abort', function () {
            controller.abort();
          }, { once: true });
        }
      }
      timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    }
    try {
      const resp = await fetch(String(baseUrl).replace(/\/$/, '') + path, opts);
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || ('Bridge error ' + resp.status));
      }
      return data;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('Bridge request timed out after ' + timeoutMs + 'ms');
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  Bridge.prototype.health = function (options) {
    const opts = Object.assign({ method: 'GET', timeoutMs: 5000 }, options || {});
    return this._fetchCaps('/health', opts);
  };

  Bridge.prototype.pollHealth = function (options) {
    const opts = Object.assign({ method: 'GET', timeoutMs: 3000 }, options || {});
    return this._fetchPoll('/health', opts);
  };

  Bridge.prototype.fetchCaBundle = function (options) {
    const opts = Object.assign({ method: 'POST', body: '{}', timeoutMs: 120000 }, options || {});
    return this._fetchCaps('/ca-bundle/fetch', opts);
  };

  Bridge.prototype.login = function (payload) {
    return this._fetchCaps('/login', { method: 'POST', body: JSON.stringify(payload) });
  };

  Bridge.prototype.proxy = function (url, body, contentType, options) {
    const opts = options || {};
    const payload = Object.assign({
      url: url,
      body: body,
      contentType: contentType || 'application/llsd+xml'
    }, this._proxyContext(opts));
    if (opts.timeoutMs) {
      payload.timeoutSec = Math.ceil(opts.timeoutMs / 1000);
    }
    const proxyOpts = {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: opts.timeoutMs || 45000
    };
    if (opts.signal) {
      proxyOpts.signal = opts.signal;
    }
    return this._fetchCaps('/proxy', proxyOpts);
  };

  /** EventQueueGet and other latency-sensitive caps - bypass the background queue. */
  Bridge.prototype.proxyPriority = function (url, body, contentType, options) {
    const opts = options || {};
    const payload = Object.assign({
      url: url,
      body: body,
      contentType: contentType || 'application/llsd+xml'
    }, this._proxyContext(opts));
    if (opts.timeoutMs) {
      payload.timeoutSec = Math.ceil(opts.timeoutMs / 1000);
    }
    const proxyOpts = {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: opts.timeoutMs || 45000
    };
    if (opts.signal) {
      proxyOpts.signal = opts.signal;
    }
    return this._fetchDirect(this.capsUrl, '/proxy', proxyOpts);
  };

  Bridge.prototype.proxyGet = function (url, options) {
    const ctx = this._proxyContext(options);
    let q = 'url=' + encodeURIComponent(url);
    if (ctx.sessionId) q += '&sessionId=' + encodeURIComponent(ctx.sessionId);
    if (ctx.udpListenPort) q += '&udpListenPort=' + encodeURIComponent(String(ctx.udpListenPort));
    if (ctx.simIp) q += '&simIp=' + encodeURIComponent(ctx.simIp);
    if (ctx.agentSessionId) q += '&agentSessionId=' + encodeURIComponent(ctx.agentSessionId);
    if (ctx.pinSimIp === false) q += '&pinSimIp=0';
    if (ctx.preCircuit) q += '&preCircuit=1';
    return this._fetchCaps('/proxy?' + q, { method: 'GET' });
  };

  Bridge.prototype.openCircuit = function (simIp, simPort, handshake) {
    const body = {
      sim_ip: simIp,
      sim_port: simPort
    };
    const hs = handshake || {};
    if (hs.circuitCode) body.circuit_code = hs.circuitCode;
    if (hs.sessionId) body.session_id = hs.sessionId;
    if (hs.agentId) body.agent_id = hs.agentId;
    return this._fetchPoll('/circuit/open', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  };

  Bridge.prototype.closeCircuit = function (sessionId) {
    return this._fetchPoll('/circuit/close', {
      method: 'POST',
      body: JSON.stringify({ sessionId: sessionId })
    });
  };

  Bridge.prototype.retargetCircuit = function (sessionId, simIp, simPort) {
    return this._fetchPoll('/circuit/retarget', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: sessionId,
        sim_ip: simIp,
        sim_port: simPort
      })
    });
  };

  Bridge.prototype.send = function (sessionId, packet, target) {
    let binary = '';
    const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    const body = { sessionId: sessionId, packet: b64 };
    if (target && target.simIp) body.sim_ip = target.simIp;
    if (target && target.simPort) body.sim_port = target.simPort;
    return this._fetchPoll('/circuit/send', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  };

  Bridge.prototype.poll = function (sessionId, timeout) {
    const q = 'sessionId=' + encodeURIComponent(sessionId) + '&timeout=' + (timeout || 25);
    return this._fetchPoll('/circuit/poll?' + q, { method: 'GET' });
  };

  Bridge.prototype.exchange = function (sessionId, packets, timeout) {
    return this._fetchPoll('/circuit/exchange', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: sessionId,
        packets: packets || [],
        timeout: timeout || 5
      })
    });
  };

  Bridge.prototype.isAvailable = async function () {
    try {
      const h = await this.health();
      if (!h || !h.ok) return false;
      if (h.poll && h.poll.ok === false) return false;
      if (h.poll && h.poll.ok === true) return true;
      const poll = await this.pollHealth();
      return !!(poll && poll.ok);
    } catch (_e) {
      return false;
    }
  };

  function httpFetch(baseUrl, path, options) {
    const base = String(baseUrl || DEFAULT_CAPS_URL).replace(/\/$/, '');
    return fetch(base + path, options || {});
  }

  function defaultPollUrl(capsUrl) {
    return derivePollUrl(capsUrl);
  }

  return {
    Bridge: Bridge,
    DEFAULT_URL: DEFAULT_CAPS_URL,
    DEFAULT_CAPS_URL: DEFAULT_CAPS_URL,
    DEFAULT_POLL_URL: DEFAULT_POLL_URL,
    defaultPollUrl: defaultPollUrl,
    httpFetch: httpFetch
  };
})();
