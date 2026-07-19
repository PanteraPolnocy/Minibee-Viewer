/**
 * SL grid login via bridge XML-RPC proxy, with MFA/TOS challenge handling.
 */
const FSLoginSL = (function () {
  'use strict';

  const GRIDS = {
    agni: { name: 'Second Life', url: 'https://login.agni.lindenlab.com/cgi-bin/login.cgi' },
    aditi: { name: 'Second Life Beta', url: 'https://login.aditi.lindenlab.com/cgi-bin/login.cgi' },
    local: { name: 'OpenSim Local', url: 'http://127.0.0.1:9000/' }
  };

  const LOGIN_OPTIONS = [
    'inventory-root',
    'inventory-skeleton',
    'inventory-lib-root',
    'inventory-lib-owner',
    'inventory-skel-lib',
    'initial-outfit',
    'gestures',
    'display_names',
    'event_categories',
    'event_notifications',
    'classified_categories',
    'adult_compliant',
    'buddy-list',
    'newuser-config',
    'ui-config',
    'advanced-mode',
    'login-flags',
    'map-server-url',
    'global-textures',
    'max-agent-groups',
    'voice-config',
    'tutorial_setting'
  ];

  const MFA_STORAGE_PREFIX = 'minibee-mfa-';
  const MFA_STORAGE_PREFIX_LEGACY = 'fs-mobile-mfa-';
  const MAC_STORAGE_KEY = 'minibee-mac';
  const MAC_STORAGE_KEY_LEGACY = 'fs-mobile-mac';
  const ID0_STORAGE_KEY = 'minibee-id0';
  const ID0_STORAGE_KEY_LEGACY = 'fs-mobile-id0';
  const HOST_STORAGE_KEY = 'minibee-host-id';
  const HOST_STORAGE_KEY_LEGACY = 'fs-mobile-host-id';

  function viewerVersion() {
    if (typeof MinibeeVersion !== 'undefined' && MinibeeVersion.isLoaded()) {
      return MinibeeVersion.getVersionString();
    }
    return '0.0.0';
  }

  function viewerChannel() {
    if (typeof MinibeeVersion !== 'undefined') {
      return MinibeeVersion.getChannel();
    }
    return 'Minibee-Viewer';
  }

  function migrateStorageKey(currentKey, legacyKey) {
    let value = FSUtils.storageGet(currentKey, '');
    if (value) return value;
    value = FSUtils.storageGet(legacyKey, '');
    if (!value) return '';
    FSUtils.storageSet(currentKey, value);
    try { localStorage.removeItem(legacyKey); } catch (_e) { /* ignore */ }
    return value;
  }

  function isLindenGrid(grid) {
    return grid === 'agni' || grid === 'aditi';
  }

  function parseUsername(raw, grid) {
    let trimmed = String(raw || '').trim();
    const at = trimmed.indexOf('@');
    if (at > 0) {
      trimmed = trimmed.slice(0, at);
    }

    if (!isLindenGrid(grid) && trimmed.indexOf(' ') < 0 && trimmed.indexOf('.') < 0 && trimmed.indexOf('_') < 0) {
      return { type: 'account', accountName: trimmed, first: '', last: '' };
    }

    const sep = trimmed.search(/[ ._]/);
    if (sep > 0) {
      const first = trimmed.slice(0, sep);
      const last = trimmed.slice(sep + 1).replace(/^[ ._]+/, '').trim();
      return { type: 'agent', first: first, last: last || 'Resident' };
    }

    return { type: 'agent', first: trimmed, last: 'Resident' };
  }

  function mfaStorageKey(credentials) {
    const user = parseUsername(credentials.username, credentials.grid);
    const label = user.type === 'account'
      ? user.accountName
      : (user.first + '.' + user.last);
    return MFA_STORAGE_PREFIX + (credentials.grid || 'agni') + '-' + label.toLowerCase();
  }

  function stableMachineId(key, legacyKey) {
    let id = migrateStorageKey(key, legacyKey || '');
    if (id && /^[a-f0-9]{32}$/i.test(id)) {
      return id;
    }
    id = (FSUtils.uuid() + FSUtils.uuid()).replace(/-/g, '').slice(0, 32);
    FSUtils.storageSet(key, id);
    return id;
  }

  function machineMac() {
    return stableMachineId(MAC_STORAGE_KEY, MAC_STORAGE_KEY_LEGACY);
  }

  function machineId0() {
    return stableMachineId(ID0_STORAGE_KEY, ID0_STORAGE_KEY_LEGACY);
  }

  function hostId() {
    let id = migrateStorageKey(HOST_STORAGE_KEY, HOST_STORAGE_KEY_LEGACY);
    if (!id) {
      id = FSUtils.uuid();
      FSUtils.storageSet(HOST_STORAGE_KEY, id);
    }
    return id;
  }

  function buildLoginPayload(credentials, session) {
    const user = parseUsername(credentials.username, credentials.grid);
    const password = String(credentials.password || '').trim().slice(0, 16);
    const payload = {
      url: credentials.loginUrl,
      first: user.first,
      last: user.last,
      passwd: '',
      start: credentials.start || 'last',
      channel: viewerChannel(),
      version: viewerVersion(),
      platform: 'Win',
      mac: machineMac(),
      id0: machineId0(),
      host_id: hostId(),
      address_size: 64,
      platform_version: '10.0',
      platform_string: 'Windows 10',
      extended_errors: true,
      last_exec_event: 0,
      last_exec_duration: 0,
      agree_to_tos: !!session.agreeToTos,
      read_critical: !!session.readCritical,
      token: session.token || '',
      mfa_hash: session.mfaHash || '',
      options: LOGIN_OPTIONS
    };

    payload.passwd = password;
    payload.auth_type = user.type === 'account' ? 'account' : 'agent';
    if (user.type === 'account') {
      payload.username = user.accountName;
    }

    return payload;
  }

  function isLoginSuccess(login) {
    return login && (login.login === true || login.login === 'true');
  }

  function classifyLogin(login) {
    if (isLoginSuccess(login)) {
      return { ok: true };
    }
    const reason = String(login.reason || login.status || '').toLowerCase();
    const message = String(login.message || login.message_id || 'Login failed.');
    let type = 'error';
    if (reason === 'tos') type = 'tos';
    else if (reason === 'critical') type = 'critical';
    else if (reason === 'mfa_challenge') type = 'mfa';
    else if (
      login.mfa_hash ||
      /multifactor|authenticator|two[- ]factor|mfa/i.test(message)
    ) {
      type = 'mfa';
    }
    return {
      ok: false,
      type: type,
      reason: reason,
      message: message,
      mfaHash: login.mfa_hash || ''
    };
  }

  function parseBuddies(list) {
    if (!Array.isArray(list)) return [];
    return list.map(function (b) {
      const id = cleanUuid(b.buddy_id || b.id);
      const rightsHas = parseInt(b.buddy_rights_has, 10) || 0;
      const rightsGiven = parseInt(b.buddy_rights_given, 10) || 0;
      return {
        id: id,
        name: id,
        displayName: '',
        userName: '',
        online: b.online === true || b.online === 'Y' || b.online === 'true',
        region: b.online_location || b.location || '',
        rightsHas: rightsHas,
        rightsGiven: rightsGiven,
        notes: ''
      };
    });
  }

  function parseSLVector(raw) {
    const str = String(raw || '');
    const m = str.match(/\[r\s*([-\d.]+)\s*,\s*r\s*([-\d.]+)\s*,\s*r\s*([-\d.]+)\s*\]/i);
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) };
  }

  function cleanUuid(value) {
    return String(value || '').replace(/"/g, '').trim();
  }

  function normalizeSimIp(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const n = raw >>> 0;
      return ((n >>> 24) & 255) + '.' + ((n >>> 16) & 255) + '.' +
        ((n >>> 8) & 255) + '.' + (n & 255);
    }
    const s = String(raw || '').replace(/"/g, '').trim();
    if (/^\d+$/.test(s) && s.indexOf('.') < 0) {
      const n = parseInt(s, 10) >>> 0;
      return ((n >>> 24) & 255) + '.' + ((n >>> 16) & 255) + '.' +
        ((n >>> 8) & 255) + '.' + (n & 255);
    }
    return s;
  }

  function cleanUrl(value) {
    let s = String(value || '').replace(/"/g, '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      s = 'https://' + s.replace(/^\/+/, '');
    }
    return normalizeSeedUrl(s);
  }

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

  function normalizeLogin(login) {
    const first = String(login.first_name || '').replace(/"/g, '');
    const last = String(login.last_name || '').replace(/"/g, '');
    const home = login.home_info || {};
    const lookAt = parseSLVector(login.look_at) || parseSLVector(home.look_at) || { x: 0, y: 1, z: 0 };
    const spawn = parseSLVector(home.position) || { x: 128, y: 128, z: 25 };
    const homeGlobalX = parseInt(home.global_x || home.GlobalX || 0, 10) || 0;
    const homeGlobalY = parseInt(home.global_y || home.GlobalY || 0, 10) || 0;
    const homeGrid = (homeGlobalX || homeGlobalY)
      ? FSSlurl.globalToGrid(homeGlobalX, homeGlobalY)
      : null;
    const homePosition = parseSLVector(home.position) || parseSLVector(home.Position) || spawn;
    return {
      agent: {
        id: cleanUuid(login.agent_id),
        first: first,
        last: last,
        displayName: first + ' ' + last
      },
      sessionId: cleanUuid(login.session_id),
      secureSessionId: cleanUuid(login.secure_session_id),
      circuitCode: parseInt(login.circuit_code, 10) || 0,
      simIp: normalizeSimIp(login.sim_ip),
      simPort: parseInt(login.sim_port, 10),
      region: (function () {
        const globalX = parseInt(login.region_x, 10) || 0;
        const globalY = parseInt(login.region_y, 10) || 0;
        const grid = FSSlurl.globalToGrid(globalX, globalY);
        return {
          name: login.sim_name || ('Region ' + globalX + ',' + globalY),
          globalX: grid.globalX,
          globalY: grid.globalY,
          x: grid.gridX,
          y: grid.gridY,
          id: ''
        };
      })(),
      seedCapability: cleanUrl(login.seed_capability),
      seedCapabilityRaw: login.seed_capability_raw ? String(login.seed_capability_raw) : '',
      mapServerUrl: cleanUrl(login['map-server-url'] || login.map_server_url || ''),
      buddies: parseBuddies(login['buddy-list']),
      lookAt: lookAt,
      spawnPosition: spawn,
      home: {
        regionName: String(home.region_name || home.sim_name || home.SimName || '').trim(),
        globalX: homeGrid ? homeGrid.globalX : undefined,
        globalY: homeGrid ? homeGrid.globalY : undefined,
        gridX: homeGrid ? homeGrid.gridX : undefined,
        gridY: homeGrid ? homeGrid.gridY : undefined,
        x: homePosition.x,
        y: homePosition.y,
        z: homePosition.z
      },
      mfaHash: login.mfa_hash || '',
      message: login.message || ''
    };
  }

  function saveMfaHash(credentials, hash, remember) {
    const key = mfaStorageKey(credentials);
    if (remember && hash) {
      FSUtils.storageSet(key, hash);
    } else {
      try { localStorage.removeItem(key); } catch (_e) { /* ignore */ }
    }
  }

  function loadMfaHash(credentials) {
    const key = mfaStorageKey(credentials);
    const legacyKey = key.replace(MFA_STORAGE_PREFIX, MFA_STORAGE_PREFIX_LEGACY);
    let hash = migrateStorageKey(key, legacyKey);
    if (!hash) return '';
    try {
      hash = decodeURIComponent(hash);
    } catch (_e) { /* keep stored value */ }
    return hash;
  }

  /**
   * onChallenge(challenge) -> Promise<{ action, token?, rememberMfa? }>
   * action: 'accept' | 'decline' | 'submit'
   */
  async function loginInteractive(bridge, credentials, onChallenge) {
    const session = {
      agreeToTos: false,
      readCritical: false,
      token: '',
      mfaHash: loadMfaHash(credentials)
    };

    const grid = GRIDS[credentials.grid] || GRIDS.agni;
    const loginUrl = credentials.loginUrl || grid.url;
    const creds = Object.assign({}, credentials, { loginUrl: loginUrl });

    if (typeof MinibeeVersion !== 'undefined') {
      await MinibeeVersion.load();
    }

    for (let attempt = 0; attempt < 12; attempt++) {
      const payload = buildLoginPayload(creds, session);
      const resp = await bridge.login(payload);
      const login = resp.login;
      const classified = classifyLogin(login);

      if (classified.ok) {
        if (login.mfa_hash && credentials.remember) {
          saveMfaHash(creds, login.mfa_hash, true);
        }
        return Object.assign(normalizeLogin(login), {
          circuitBootstrap: resp.circuit || null,
          seedCaps: resp.seedCaps || null
        });
      }

      if (classified.type === 'error') {
        const hadMfaToken = !!session.token;
        if (classified.reason === 'key' || hadMfaToken) {
          session.token = '';
          session.mfaHash = '';
          try { localStorage.removeItem(mfaStorageKey(creds)); } catch (_e) { /* ignore */ }
        }
        if (hadMfaToken) {
          throw new Error(
            'Authenticator code rejected. Generate a new code and try again. ' +
            '(Stored MFA device data was cleared.)'
          );
        }
        throw new Error(classified.message);
      }

      const answer = await onChallenge({
        type: classified.type,
        message: classified.message,
        attempt: attempt
      });

      if (!answer || answer.action === 'decline') {
        throw new Error('Login cancelled.');
      }

      if (classified.type === 'tos') {
        session.agreeToTos = true;
        if (session.token) {
          session.token = '';
        }
        continue;
      }

      if (classified.type === 'critical') {
        session.readCritical = true;
        if (session.token) {
          session.token = '';
        }
        continue;
      }

      if (classified.type === 'mfa') {
        const token = String(answer.token || '').replace(/\s/g, '');
        if (!token) {
          throw new Error('Authenticator code required.');
        }
        session.token = token;
        if (classified.mfaHash) {
          session.mfaHash = classified.mfaHash;
        }
        continue;
      }

      throw new Error(classified.message);
    }

    throw new Error('Login failed after multiple attempts.');
  }

  async function login(bridge, credentials, onChallenge) {
    if (onChallenge) {
      return loginInteractive(bridge, credentials, onChallenge);
    }
    return loginInteractive(bridge, credentials, function () {
      return Promise.reject(new Error('Login requires user interaction (TOS/MFA).'));
    });
  }

  return {
    GRIDS: GRIDS,
    login: login,
    loginInteractive: loginInteractive,
    parseUsername: parseUsername,
    classifyLogin: classifyLogin,
    getViewerVersion: viewerVersion,
    getViewerChannel: viewerChannel,
    getViewerLabel: function () {
      if (typeof MinibeeVersion !== 'undefined' && MinibeeVersion.isLoaded()) {
        return MinibeeVersion.getLabel();
      }
      return viewerChannel();
    }
  };
})();
