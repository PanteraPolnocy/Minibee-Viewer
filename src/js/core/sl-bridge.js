/**
 * Native-engine transport adapter.
 *
 * Implements the FSTransport interface by talking straight to the Rust core:
 * inbound Tauri events (`minibee-viewer://<event>`) get re-emitted on the
 * FSTransport bus the UI is already listening to, and every method here fires a
 * Rust command. The real login parsing (XML-RPC, classify, normalize, buddies,
 * payload) all lives in Rust (`bridge_login`); this file only drives the
 * MFA/TOS challenge loop. The circuit and protocol engine live in Rust too
 * (src-tauri/src/bridge/{circuit,session,eventqueue,caps}.rs,
 * src-tauri/src/{codec,bridge/login}.rs).
 */
const FSSLBridge = (function () {
  'use strict';

  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

  let started = false;
  let agentId = '';
  let lastGrid = '';             // non-secret, so auto-reconnect can reuse it
  const names = new Map();       // id -> { label, displayName, userName }
  const buddies = new Set();     // lowercased buddy ids
  const buddyOnline = new Map(); // id -> bool
  let buddyRoster = [];          // keep the full buddy objects so a presence change can re-emit the list
  const groupNames = new Map();  // id -> name
  const searchWaiters = new Map(); // queryId -> resolve (directory search)
  const groupActionWaiters = new Map(); // "action:groupId" -> [resolve,...] (join/leave replies)
  const parcelInfoWaiters = new Map(); // parcelId -> [resolve, ...] (concurrent lookups)

  function normId(id) {
    return String(id || '').toLowerCase();
  }

  // These events are forwarded to the FSTransport bus untouched.
  const PASSTHROUGH = [
    'connected', 'disconnected', 'session-lost', 'caps-status', 'region', 'position', 'parcel',
    'chat', 'event', 'im', 'im-typing', 'im-roster', 'im-session-force-close', 'im-session-remap',
    'money-balance', 'radar-update', 'map-blocks', 'map-agents', 'stats',
    'teleport-started', 'teleport-progress', 'teleport-finish', 'teleport-failed',
    'teleport-offer', 'teleport-request', 'teleport-accepted', 'teleport-declined',
    'close-requested'
  ];

  // Registers every backend listener. The returned Promise doesn't resolve
  // until all of them are actually live, so the caller can await it before
  // starting the session - otherwise early `connected`/`region`/`position`
  // events can fire into the void before Tauri has wired up the handlers.
  function bindEvents() {
    const pending = [];

    PASSTHROUGH.forEach(function (name) {
      pending.push(FSBridge.listen('minibee-viewer://' + name, function (payload) {
        if (name === 'connected') seedFromConnected(payload);
        FSTransport.emit(name, payload);
      }));
    });

    pending.push(FSBridge.listen('minibee-viewer://names-updated', function (data) {
      (data && data.names || []).forEach(function (n) {
        if (n && n.id) names.set(normId(n.id), {
          label: n.name || n.userName || '',
          displayName: n.displayName || '',
          userName: n.userName || n.name || ''
        });
      });
      FSTransport.emit('names-updated', data);
    }));

    pending.push(FSBridge.listen('minibee-viewer://group-membership', function (data) {
      (data && data.groups || []).forEach(function (g) {
        if (g && g.id && g.name) groupNames.set(normId(g.id), g.name);
      });
    }));

    // Join/leave replies come back asynchronously as group-action: resolve the
    // pending joinGroup/leaveGroup promise and forward it to the bus for the UI.
    pending.push(FSBridge.listen('minibee-viewer://group-action', function (data) {
      FSTransport.emit('group-action', data);
      const key = (data && data.action) + ':' + normId(data && data.groupId);
      const list = groupActionWaiters.get(key);
      if (list) { groupActionWaiters.delete(key); list.forEach(function (r) { r(data); }); }
    }));

    pending.push(FSBridge.listen('minibee-viewer://buddy-online', function (data) {
      applyPresence(data && data.ids, true);
    }));
    pending.push(FSBridge.listen('minibee-viewer://buddy-offline', function (data) {
      applyPresence(data && data.ids, false);
    }));

    // Directory search: hand the result to the waiting searchDirectory() promise.
    ['dir-people-reply', 'dir-places-reply', 'dir-groups-reply'].forEach(function (name) {
      pending.push(FSBridge.listen('minibee-viewer://' + name, function (data) {
        const q = data && data.queryId;
        const waiter = q && searchWaiters.get(q);
        if (waiter) {
          searchWaiters.delete(q);
          waiter(data);
        }
      }));
    });

    // Parcel-info lookup (about-land): resolve every pending fetchParcelInfo()
    // for this parcel, so concurrent lookups of the same id each get the reply.
    pending.push(FSBridge.listen('minibee-viewer://parcel-info', function (data) {
      const key = normId(data && data.parcelId);
      const waiters = key && parcelInfoWaiters.get(key);
      if (waiters) { parcelInfoWaiters.delete(key); waiters.forEach(function (r) { r(data); }); }
      // Also surface it on the bus so the Land tab can merge in the extras
      // (UUID, dwell) for the parcel the agent is standing on.
      FSTransport.emit('parcel-info', data);
    }));

    return Promise.all(pending);
  }

  function seedFromConnected(payload) {
    if (!payload) return;
    if (payload.agent && payload.agent.id) {
      agentId = payload.agent.id;
      if (payload.agent.displayName) {
        names.set(normId(agentId), {
          label: payload.agent.displayName, displayName: payload.agent.displayName, userName: ''
        });
      }
    }
    buddyRoster = (payload.buddies || []).slice();
    buddyRoster.forEach(function (b) {
      if (b && b.id) {
        buddies.add(normId(b.id));
        buddyOnline.set(normId(b.id), !!b.online);
      }
    });
  }

  // Apply a presence change from OnlineNotification/OfflineNotification and push
  // the whole roster back out. The UI's buddies-updated handler replaces the
  // list wholesale, so sending a partial payload would wipe out everyone else.
  function applyPresence(ids, online) {
    let changed = false;
    (ids || []).forEach(function (id) {
      const key = normId(id);
      if (buddyOnline.get(key) !== online) { buddyOnline.set(key, online); changed = true; }
    });
    if (!changed) return;
    buddyRoster.forEach(function (b) {
      if (b && b.id && buddyOnline.has(normId(b.id))) b.online = buddyOnline.get(normId(b.id));
    });
    FSTransport.emit('buddies-updated', buddyRoster.slice());
  }

  function invoke(cmd, args) {
    return FSBridge.invoke(cmd, args || {});
  }

  function findCap(caps, name) {
    if (!caps) return '';
    return caps[name] || caps[name.toLowerCase()] || '';
  }

  // --- login (Rust owns the parsing/orchestration; this is just the challenge loop) ---

  function mfaKey(credentials) {
    return 'minibee-mfa-' + (credentials.grid || 'agni') + '-' + String(credentials.username || '').trim().toLowerCase();
  }
  function loadMfaHash(credentials) {
    try { return localStorage.getItem(mfaKey(credentials)) || ''; } catch (_e) { return ''; }
  }
  function saveMfaHash(credentials, hash, remember) {
    try {
      if (remember && hash) localStorage.setItem(mfaKey(credentials), hash);
      else localStorage.removeItem(mfaKey(credentials));
    } catch (_e) { /* storage is optional */ }
  }

  const GRID_NAMES = { agni: 'Second Life', aditi: 'Second Life Beta', local: 'OpenSim Local' };

  async function login(credentials) {
    try {
      const h = await invoke('bridge_health');
      if (!h || !h.ok) throw new Error('unavailable');
    } catch (_e) {
      throw new Error('Minibee backend unavailable. Run the Minibee app (npm run tauri dev), not a plain browser.');
    }
    if (!started) { await bindEvents(); started = true; }

    const session = {
      token: '', agreeToTos: false, readCritical: false,
      mfaHash: loadMfaHash(credentials), rememberMfa: undefined
    };
    let resp = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      resp = await invoke('bridge_login', { payload: {
        loginUrl: credentials.loginUrl || '', username: credentials.username, password: credentials.password,
        grid: credentials.grid || 'agni', start: credentials.start || 'last',
        token: session.token, mfaHash: session.mfaHash,
        agreeToTos: session.agreeToTos, readCritical: session.readCritical
      } });
      const c = resp.classified || {};
      if (c.ok) {
        const rawMfa = resp.login && resp.login.mfa_hash;
        if (rawMfa) {
          const remember = session.rememberMfa !== undefined ? session.rememberMfa : !!session.mfaHash;
          saveMfaHash(credentials, rawMfa, remember);
        }
        break;
      }
      if (c.type === 'update') {
        // The server wants a newer viewer, so surface its message (it carries
        // the version / update guidance) instead of routing to the TOS/MFA UI.
        throw new Error(c.message || 'This viewer is out of date and must be updated to log in.');
      }
      if (c.type === 'error') {
        const hadToken = !!session.token;
        if (c.reason === 'key' || hadToken) { session.token = ''; session.mfaHash = ''; saveMfaHash(credentials, '', false); }
        if (hadToken) throw new Error('Authenticator code rejected. Generate a new code and try again.');
        throw new Error(c.message || 'Login failed.');
      }
      const onChallenge = credentials.onChallenge;
      if (!onChallenge) throw new Error('Login requires user interaction (TOS/MFA).');
      const answer = await onChallenge({ type: c.type, message: c.message, attempt: attempt });
      if (!answer || answer.action === 'decline') throw new Error('Login cancelled.');
      if (c.type === 'tos') { session.agreeToTos = true; session.token = ''; continue; }
      if (c.type === 'critical') { session.readCritical = true; session.token = ''; continue; }
      if (c.type === 'mfa') {
        const token = String(answer.token || '').replace(/\s/g, '');
        if (!token) throw new Error('Authenticator code required.');
        session.token = token;
        session.rememberMfa = answer.rememberMfa !== false;
        if (c.mfaHash) session.mfaHash = c.mfaHash;
        continue;
      }
      throw new Error(c.message || 'Login failed.');
    }
    if (!resp || !resp.classified || !resp.classified.ok || !resp.parsed) {
      throw new Error('Login failed after multiple attempts.');
    }
    lastGrid = credentials.grid || 'agni';
    return finishSession(resp, lastGrid);
  }

  // Spin up the UDP session + EventQueue from a login/relogin response and hand
  // back the `connected` payload. Shared by both initial login and auto-reconnect.
  async function finishSession(resp, grid) {
    const data = resp.parsed;
    const caps = (resp.seedCaps && resp.seedCaps.ok && resp.seedCaps.caps) || {};
    const parcel = {
      localId: 0, name: 'Current parcel', desc: '', area: 0, primsUsed: 0, primsTotal: 0,
      ownerId: data.agent.id, ownerName: data.agent.displayName, canEdit: true, access: 0,
      pushRestricted: false, allowBuild: false, allowScripts: true, musicUrl: '', mediaUrl: '', stub: true
    };
    const connected = {
      agent: data.agent,
      region: data.region,
      grid: grid,
      gridName: GRID_NAMES[grid] || grid,
      mapServerUrl: getMapServerUrl(),
      buddies: data.buddies || [],
      parcel: parcel,
      position: data.spawnPosition || { x: 128, y: 128, z: 25 },
      motd: (resp.login && resp.login.message) || ''
    };

    await invoke('sl_start_session', {
      params: {
        agentId: data.agent.id,
        sessionId: data.sessionId,
        circuitCode: data.circuitCode,
        simIp: data.simIp,
        simPort: data.simPort,
        caps: caps,
        eventQueueCapUrl: findCap(caps, 'EventQueueGet'),
        connected: connected
      }
    });

    // Resolve buddy display names through the cap (Rust falls back to UDP).
    const ids = (data.buddies || []).map(function (b) { return b.id; }).filter(Boolean);
    if (ids.length) invoke('sl_resolve_display_names', { ids: ids }).catch(function () {});

    return connected;
  }

  // Auto-reconnect: the Rust core replays the cached login (bridge_relogin),
  // then we run the same session-start path as a fresh login. The password is
  // never held on the JS side - only the core keeps it, obfuscated.
  async function reconnect() {
    if (!started) { await bindEvents(); started = true; }
    const resp = await invoke('bridge_relogin');
    if (!resp || !resp.classified || !resp.classified.ok || !resp.parsed) {
      throw new Error('Reconnect failed.');
    }
    return finishSession(resp, lastGrid || 'agni');
  }

  function logout() {
    return invoke('sl_logout').catch(function () {});
  }

  function start() { /* Rust already starts the circuit + EventQueue in sl_start_session. */ }
  function stop() { /* circuit teardown happens on logout / session-lost anyway. */ }

  // --- chat / IM ---

  // ChatType on the wire is numeric (llchat.h EChatType): whisper 0, normal 1,
  // shout 2. The UI hands us the volume as a string, so we map it here - a raw
  // string would fail serde's i64 deserialize and silently drop the whole send.
  const CHAT_TYPES = { whisper: 0, normal: 1, shout: 2 };
  function sendChat(text, options) {
    const opts = options || {};
    let chatType = opts.type;
    if (typeof chatType === 'string') chatType = CHAT_TYPES[chatType];
    if (typeof chatType !== 'number') chatType = 1; // normal
    return invoke('sl_chat_send', { message: text, channel: opts.channel || 0, chatType: chatType });
  }

  function imTarget(sessionId) {
    const session = (typeof FSState !== 'undefined' && FSState.get().imSessions) ? FSState.get().imSessions[sessionId] : null;
    if (session && session.type && session.type !== 'p2p') {
      return { toId: ZERO_UUID, imId: sessionId, dialog: 17, fromGroup: session.type === 'group' };
    }
    // P2P: the session id is agentId XOR otherId, so XOR it back to recover the peer.
    return { toId: FSUtils.xorSessionId(agentId, sessionId), imId: '', dialog: 0, fromGroup: false };
  }

  function sendIm(sessionId, text) {
    const t = imTarget(sessionId);
    return invoke('sl_im_send', { toId: t.toId, imId: t.imId, dialog: t.dialog, text: text, fromGroup: t.fromGroup });
  }

  // Rust action commands come back as { ok: true }, but the UI checks { sent: true }.
  function sent(cmd, args) {
    return invoke(cmd, args || {}).then(function () { return { sent: true }; });
  }

  function sendTypingState(sessionId, typing) {
    // Typing is a P2P-only IM (dialog 41/42); a group/conference sessionId is a
    // real session UUID, not a P2P XOR bucket, so only fire this for real P2P.
    const t = imTarget(sessionId);
    if (t.dialog !== 0) return Promise.resolve();
    return invoke('sl_send_typing', { toId: t.toId, typing: !!typing });
  }

  // --- groups ---

  // Join/leave are async: the sim answers with JoinGroupReply/LeaveGroupReply
  // (Rust 'group-action'). Resolve with { success } so the profile UI can react,
  // instead of the fire-and-forget send ack.
  function waitGroupAction(action, groupId) {
    const key = action + ':' + normId(groupId);
    return new Promise(function (resolve) {
      const list = groupActionWaiters.get(key) || [];
      list.push(resolve);
      groupActionWaiters.set(key, list);
      setTimeout(function () {
        const cur = groupActionWaiters.get(key);
        if (!cur) return;
        const i = cur.indexOf(resolve);
        if (i === -1) return;
        cur.splice(i, 1);
        if (!cur.length) groupActionWaiters.delete(key);
        resolve({ success: false, timedOut: true });
      }, 15000);
    });
  }
  function joinGroup(groupId) {
    return invoke('sl_group_join', { groupId: groupId }).then(function () { return waitGroupAction('join', groupId); });
  }
  function leaveGroup(groupId) {
    return invoke('sl_group_leave', { groupId: groupId }).then(function () { return waitGroupAction('leave', groupId); });
  }
  function activateGroup(groupId) { return sent('sl_group_activate', { groupId: groupId || '' }); }
  function saveGroupTitle(groupId, roleId) { return sent('sl_group_save_title', { groupId: groupId, roleId: roleId }); }

  // --- friendship / calling cards ---

  function offerFriendship(destId, message) {
    // The sim never sends an "already friends" reply, but we know our own
    // roster, so short-circuit locally to satisfy the UI's alreadyFriend branch.
    if (isBuddy(destId)) return Promise.resolve({ sent: false, alreadyFriend: true });
    return sent('sl_offer_friendship', { toId: destId, message: message || '' });
  }
  function removeFriendship(destId) {
    return sent('sl_remove_friendship', { otherId: destId }).then(function (r) {
      // The sim won't echo the roster for our own removal, so drop them locally.
      const key = normId(destId);
      buddies.delete(key);
      buddyOnline.delete(key);
      const before = buddyRoster.length;
      buddyRoster = buddyRoster.filter(function (b) { return b && normId(b.id) !== key; });
      if (buddyRoster.length !== before) FSTransport.emit('buddies-updated', buddyRoster.slice());
      return r;
    });
  }
  function acceptCallingCard(transactionId) { return sent('sl_accept_calling_card', { transactionId: transactionId }); }
  function declineCallingCard(transactionId) { return sent('sl_decline_calling_card', { transactionId: transactionId }); }
  function acceptFriendship(transactionId) { return sent('sl_accept_friendship', { transactionId: transactionId }); }
  function declineFriendship(transactionId) { return sent('sl_decline_friendship', { transactionId: transactionId }); }

  // --- money ---

  function payResident(destId, amount, description) {
    return sent('sl_pay', { destId: destId, amount: Math.trunc(amount), description: description || '' });
  }

  // --- chat sessions (conference / group) ---

  function openGroupChat(groupId, groupName) {
    // IM dialog 15 (IM_SESSION_GROUP_START) starts the group session, and its id
    // IS the group id. Emit im-session-open so the UI shows the tab right away.
    invoke('sl_im_send', { toId: groupId, imId: groupId, dialog: 15, text: '', fromGroup: true }).catch(function () {});
    FSTransport.emit('im-session-open', { sessionId: groupId, type: 'group', title: groupName || '' });
    return { sessionId: groupId, type: 'group', title: groupName || '' };
  }
  function startConference(agentIds, title) {
    const tempId = FSUtils.uuid();
    // Open the tab SYNCHRONOUSLY (before the cap POST) so it already exists when
    // the sim's ChatterBoxSessionStartReply arrives to remap temp->real id.
    // Otherwise the remap runs first, no-ops, and the roster spawns a 2nd tab.
    FSTransport.emit('im-session-open', { sessionId: tempId, type: 'conference', title: title || 'Conference' });
    invoke('sl_chat_session_start_conference', { tempSessionId: tempId, agentIds: agentIds || [] })
      .catch(function () { /* the start reply / force-close will surface any failure */ });
    return { sessionId: tempId, type: 'conference', title: title || 'Conference' };
  }
  function inviteToSession(sessionId, agentIds) {
    return invoke('sl_chat_session_invite', { sessionId: sessionId, agentIds: agentIds || [] }).then(function () { return { sent: true }; });
  }
  function moderateSessionText(sessionId, agentId, muteText) {
    return invoke('sl_chat_session_moderate', { sessionId: sessionId, agentId: agentId, muteText: !!muteText }).then(function () { return { sent: true }; });
  }
  function leaveImSession(sessionId) {
    const session = (typeof FSState !== 'undefined' && FSState.get().imSessions) ? FSState.get().imSessions[sessionId] : null;
    if (!session || session.type === 'p2p') return; // P2P has no server-side session, so there's nothing to leave
    invoke('sl_chat_session_decline', { sessionId: sessionId }).catch(function () {});
  }

  // --- parcel ---

  function updateParcel(data) {
    FSTransport.emit('parcel-updated', data); // optimistic echo so the land tab updates right away
    return invoke('sl_update_parcel', { parcel: data });
  }
  function refreshParcel() {
    const pos = (typeof FSState !== 'undefined' && FSState.get().position) || { x: 128, y: 128 };
    return invoke('sl_request_parcel', { x: pos.x || 128, y: pos.y || 128 });
  }
  // RemoteParcelRequest: map (region grid, local pos) -> parcel UUID, then fire
  // a ParcelInfoRequest (a `parcel-info` event follows). The Land tab uses this
  // for the parcel UUID + dwell (Traffic), which ParcelProperties doesn't carry.
  function remoteParcel(gridX, gridY, x, y, z) {
    return invoke('sl_remote_parcel', {
      gridX: gridX || 0, gridY: gridY || 0,
      x: x != null ? x : 128, y: y != null ? y : 128, z: z != null ? z : 25
    }).catch(function () { return null; });
  }

  // --- scripts ---

  function replyScriptDialog(objectId, buttonIndex, buttonLabel, chatChannel) {
    return invoke('sl_reply_script_dialog', {
      objectId: objectId, buttonIndex: buttonIndex, buttonLabel: buttonLabel || '', chatChannel: chatChannel || 0
    }).then(function () { return { sent: true }; });
  }
  function replyScriptPermission(taskId, itemId, questions) {
    return invoke('sl_reply_script_permission', { taskId: taskId, itemId: itemId, questions: questions || 0 })
      .then(function () { return { sent: true }; });
  }

  // --- avatar notes / search ---

  function saveAvatarNotes(targetId, notes) {
    return invoke('sl_save_notes', { targetId: targetId, notes: notes || '' }).then(function () { return { sent: true }; });
  }

  function searchDirectory(kind, query) {
    const cmd = kind === 'places' ? 'sl_search_places' : (kind === 'groups' ? 'sl_search_groups' : 'sl_search_people');
    return invoke(cmd, { query: query }).then(function (res) {
      const qid = res && res.queryId;
      if (!qid) return [];
      return new Promise(function (resolve) {
        searchWaiters.set(qid, function (data) { resolve((data && (data.people || data.places || data.groups)) || []); });
        setTimeout(function () {
          if (searchWaiters.get(qid)) { searchWaiters.delete(qid); resolve([]); }
        }, 8000);
      });
    });
  }

  function fetchParcelInfo(parcelId) {
    const key = normId(parcelId);
    if (!key) return Promise.reject(new Error('No parcel id'));
    return invoke('sl_request_parcel_info', { parcelId: key }).then(function () {
      return new Promise(function (resolve) {
        const list = parcelInfoWaiters.get(key) || [];
        list.push(resolve);
        parcelInfoWaiters.set(key, list);
        setTimeout(function () {
          const current = parcelInfoWaiters.get(key);
          if (!current) return;
          const i = current.indexOf(resolve);
          if (i === -1) return;
          current.splice(i, 1);
          if (current.length === 0) parcelInfoWaiters.delete(key);
          resolve(null);
        }, 12000);
      });
    });
  }

  // --- teleport ---

  async function teleportTo(loc) {
    if (!loc) throw new Error('No destination');
    let target = loc;
    // Resolve to grid coords first, so we never aim at grid (0,0) - the void:
    //  - a string (SLURL / "Region/x/y/z" / bare name), e.g. one from the
    //    destination guide (which used to send grid 0,0 and fail);
    //  - a region-name-only object (e.g. a script teleport).
    if (typeof loc === 'string') {
      target = await resolveLocation(loc);
    } else if (loc.gridX == null && loc.gridY == null && loc.regionName) {
      const x = loc.x != null ? loc.x : 128, y = loc.y != null ? loc.y : 128, z = loc.z != null ? loc.z : 25;
      target = await resolveLocation(loc.regionName + '/' + x + '/' + y + '/' + z);
    }
    await invoke('sl_teleport_to', {
      gridX: target.gridX || 0, gridY: target.gridY || 0,
      x: target.x != null ? target.x : 128, y: target.y != null ? target.y : 128, z: target.z != null ? target.z : 25
    });
    // Return the resolved location (regionName + coords) so callers (e.g. the
    // map selection) get real data back, not just the bare {ok:true} ack.
    return target;
  }
  function teleportHome() { return invoke('sl_teleport_home'); }
  function sendTeleportOffer(targetId, message) { return invoke('sl_send_teleport_offer', { toId: targetId, message: message || '' }); }
  function sendTeleportRequest(targetId, message) { return invoke('sl_send_teleport_request', { toId: targetId, message: message || '' }); }
  function acceptTeleportOffer(offer) { return invoke('sl_accept_teleport_offer', { lureId: (offer && offer.lureId) || '' }); }
  function declineTeleportOffer(offer) {
    return invoke('sl_decline_teleport_offer', { toId: (offer && offer.fromId) || '', lureId: (offer && offer.lureId) || '' });
  }
  // A teleport *request* ("please TP me to you") is answered by offering a lure.
  function acceptTeleportRequest(request, message) {
    return invoke('sl_send_teleport_offer', { toId: (request && request.fromId) || '', message: message || 'Join me' });
  }
  function declineTeleportRequest(request) {
    // A decline goes back to the requester as an IM (dialog 24).
    return invoke('sl_decline_teleport_offer', { toId: (request && request.fromId) || '', lureId: (request && request.lureId) || '' });
  }
  function cancelTeleport() {
    // The sim gives us no reliable confirmation for a cancel, so tell the UI to
    // tear down its progress dialogs as soon as the request goes out.
    return invoke('sl_teleport_cancel').then(function () {
      FSTransport.emit('teleport-cancelled', {});
      return true;
    }).catch(function () { return false; });
  }

  async function resolveLocation(input) {
    // Accept a bare "Region", "Region/x/y/z", a secondlife:// SLURL, OR a web
    // map URL (maps.secondlife.com/slurl.com/secondlife/Region/x/y/z). We hand
    // off to the shared SLURL parser - the old naive split used to turn a pasted
    // "http://maps.secondlife.com/..." into a region name of "http:".
    let regionName = '';
    let local = { x: 128, y: 128, z: 25 };
    // Accept a pre-parsed location OBJECT (e.g. from FSMap.showLocation) as well
    // as a string - otherwise String(object) would just become "[object Object]".
    const parsed = (input && typeof input === 'object')
      ? input
      : ((typeof FSSlurl !== 'undefined' && FSSlurl.parse) ? FSSlurl.parse(String(input || '').trim()) : null);
    // A pre-resolved location that already carries grid coords (e.g. a pick, whose
    // SimName can be empty) teleports straight there - no region-name lookup and
    // no name needed. This has to come before the regionName check, since a pick's
    // regionName is often blank (otherwise String(object) => "[object Object]").
    if (parsed && typeof parsed === 'object' && parsed.gridX != null && parsed.gridY != null) {
      return {
        regionName: parsed.regionName || '',
        gridX: parsed.gridX,
        gridY: parsed.gridY,
        x: parsed.x != null ? parsed.x : 128,
        y: parsed.y != null ? parsed.y : 128,
        z: parsed.z != null ? parsed.z : 25
      };
    }
    if (parsed && parsed.regionName) {
      regionName = parsed.regionName;
      local = {
        x: parsed.x != null ? parsed.x : 128,
        y: parsed.y != null ? parsed.y : 128,
        z: parsed.z != null ? parsed.z : 25
      };
      // Already has grid coords (e.g. a resolved selection), so skip the lookup.
      if (parsed.gridX != null && parsed.gridY != null) {
        return { regionName: regionName, gridX: parsed.gridX, gridY: parsed.gridY, x: local.x, y: local.y, z: local.z };
      }
    } else {
      // Fallback path for anything the parser doesn't recognise.
      const s = String(input || '').trim().replace(/^secondlife:\/\//i, '').replace(/^\/+/, '');
      const parts = s.split('/').filter(function (p) { return p !== ''; });
      regionName = decodeURIComponent(parts[0] || '').trim();
      const num = function (i, dflt) { const n = parseFloat(parts[i]); return Number.isFinite(n) ? n : dflt; };
      local = { x: num(1, 128), y: num(2, 128), z: num(3, 25) };
    }
    if (!regionName) throw new Error('Enter a region name or SLURL');
    const info = await FSBridge.regionByName(regionName);
    if (!info || (info.x == null && info.gridX == null)) throw new Error('Region not found: ' + regionName);
    const gridX = info.gridX != null ? info.gridX : info.x;
    const gridY = info.gridY != null ? info.gridY : info.y;
    return { regionName: regionName, gridX: gridX, gridY: gridY, x: local.x, y: local.y, z: local.z };
  }

  // --- map ---

  function requestMapArea(minX, minY, maxX, maxY) {
    // Results come back through the 'map-blocks' event the UI already listens to.
    return invoke('sl_request_map_area', { minX: minX, minY: minY, maxX: maxX, maxY: maxY }).then(function () { return []; });
  }
  function requestMapAgentCounts(tiles) {
    (tiles || []).forEach(function (t) {
      invoke('sl_request_map_agents', { gridX: t.gridX, gridY: t.gridY }).catch(function () {});
    });
    return Promise.resolve();
  }
  function getMapServerUrl() { return FSSlurl.DEFAULT_MAP_SERVER; }
  function getMapTileUrl(level, gridX, gridY) { return FSSlurl.tileUrl(FSSlurl.DEFAULT_MAP_SERVER, level, gridX, gridY); }

  // --- synchronous accessors (backed by the mirror) ---

  function getCachedName(id) { const e = names.get(normId(id)); return e ? e.label : ''; }
  function getCachedNameInfo(id) { return names.get(normId(id)) || null; }
  function getGroupName(id) { return groupNames.get(normId(id)) || ''; }
  function queueNameResolve(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (list.length) invoke('sl_resolve_display_names', { ids: list }).catch(function () {});
  }
  function isBuddy(id) { return buddies.has(normId(id)); }
  function isAgentOnline(id, hints) {
    const key = normId(id);
    if (buddyOnline.has(key)) return buddyOnline.get(key);
    if (hints && hints.online !== undefined) return !!hints.online;
    return true;
  }

  return {
    login: login, logout: logout, reconnect: reconnect, start: start, stop: stop,
    sendChat: sendChat, sendIm: sendIm, sendTypingState: sendTypingState,
    joinGroup: joinGroup, leaveGroup: leaveGroup, activateGroup: activateGroup, saveGroupTitle: saveGroupTitle,
    offerFriendship: offerFriendship, removeFriendship: removeFriendship,
    acceptCallingCard: acceptCallingCard, declineCallingCard: declineCallingCard,
    acceptFriendship: acceptFriendship, declineFriendship: declineFriendship,
    openGroupChat: openGroupChat, startConference: startConference, inviteToSession: inviteToSession,
    moderateSessionText: moderateSessionText, leaveImSession: leaveImSession,
    payResident: payResident, updateParcel: updateParcel, refreshParcel: refreshParcel,
    fetchParcelInfo: fetchParcelInfo, remoteParcel: remoteParcel,
    replyScriptDialog: replyScriptDialog, replyScriptPermission: replyScriptPermission,
    saveAvatarNotes: saveAvatarNotes, searchDirectory: searchDirectory,
    teleportTo: teleportTo, teleportHome: teleportHome,
    sendTeleportOffer: sendTeleportOffer, sendTeleportRequest: sendTeleportRequest,
    acceptTeleportOffer: acceptTeleportOffer, declineTeleportOffer: declineTeleportOffer,
    acceptTeleportRequest: acceptTeleportRequest, declineTeleportRequest: declineTeleportRequest,
    cancelTeleport: cancelTeleport,
    resolveLocation: resolveLocation,
    requestMapArea: requestMapArea, requestMapAgentCounts: requestMapAgentCounts,
    getMapServerUrl: getMapServerUrl, getMapTileUrl: getMapTileUrl,
    getCachedName: getCachedName, getCachedNameInfo: getCachedNameInfo, getGroupName: getGroupName,
    queueNameResolve: queueNameResolve, isBuddy: isBuddy, isAgentOnline: isAgentOnline
  };
})();
