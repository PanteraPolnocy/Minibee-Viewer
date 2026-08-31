/**
 * The in-app event bus and method facade the UI talks to. The actual Second Life
 * protocol - XML-RPC login, the UDP circuit and message_template.msg codec,
 * capability discovery, and the EventQueueGet long-poll - all lives in the Rust
 * core now. This layer just relays the core's events onto a bus the UI can
 * subscribe to, and forwards UI actions to whichever adapter is wired up
 * (sl-bridge.js, which turns them into invoke() calls).
 */
const BeeTransport = (function () {
  'use strict';

  let adapter = null;
  const handlers = new Map();

  function use(impl) {
    adapter = impl;
  }

  // Subscribing to an event whose payload the core describes with a Rust struct
  // hands the callback that exact type (see types/events-map.d.ts); every other
  // event still takes an `any` payload, so nothing had to change to adopt this.
  function on<K extends BeeTypedEvent>(event: K, fn: (data: BeeEventMap[K]) => void): void;
  function on(event: string, fn: (data: any) => void): void;
  function on(event: string, fn: (data: any) => void): void {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
  }

  function emit(event: string, data?: any) {
    const set = handlers.get(event);
    if (!set) return;
    // Keep each subscriber isolated: one handler that throws must not block
    // delivery to the other subscribers of the same event (mirrors BeeState.emit).
    set.forEach(function (fn) {
      try { fn(data); } catch (e) {
        if (typeof console !== 'undefined') console.error('BeeTransport handler for "' + event + '" threw', e);
      }
    });
  }

  async function login(credentials) {
    if (!adapter) throw new Error('No transport adapter configured');
    return adapter.login(credentials);
  }

  async function logout() {
    if (adapter && adapter.logout) await adapter.logout();
    emit('disconnected');
  }

  function reconnect() {
    if (!adapter || !adapter.reconnect) {
      return Promise.reject(new Error('Reconnect not supported'));
    }
    return adapter.reconnect();
  }

  function sendChat(text, options) {
    if (!adapter) return;
    adapter.sendChat(text, options);
  }

  function sendIm(sessionId, text) {
    if (!adapter) return;
    adapter.sendIm(sessionId, text);
  }

  function sendTypingState(sessionId, typing) {
    if (!adapter || !adapter.sendTypingState) return;
    adapter.sendTypingState(sessionId, typing);
  }

  function openGroupChat(groupId, groupName) {
    if (!adapter || !adapter.openGroupChat) return null;
    return adapter.openGroupChat(groupId, groupName);
  }

  function startConference(agentIds, title) {
    if (!adapter || !adapter.startConference) {
      return Promise.reject(new Error('Conference chat unavailable'));
    }
    return adapter.startConference(agentIds, title);
  }

  function leaveImSession(sessionId) {
    if (!adapter || !adapter.leaveImSession) return;
    adapter.leaveImSession(sessionId);
  }

  function inviteToSession(sessionId, agentIds) {
    if (!adapter || !adapter.inviteToSession) {
      return Promise.reject(new Error('Invite unavailable'));
    }
    return adapter.inviteToSession(sessionId, agentIds);
  }

  function moderateSessionText(sessionId, agentId, muteText) {
    if (!adapter || !adapter.moderateSessionText) {
      return Promise.reject(new Error('Moderation unavailable'));
    }
    return adapter.moderateSessionText(sessionId, agentId, muteText);
  }

  function replyScriptDialog(objectId, buttonIndex, buttonLabel, chatChannel) {
    if (!adapter || !adapter.replyScriptDialog) {
      return Promise.resolve({ sent: false });
    }
    return adapter.replyScriptDialog(objectId, buttonIndex, buttonLabel, chatChannel);
  }

  function replyScriptPermission(taskId, itemId, questions) {
    if (!adapter || !adapter.replyScriptPermission) {
      return Promise.resolve({ sent: false });
    }
    return adapter.replyScriptPermission(taskId, itemId, questions);
  }

  function acceptCallingCard(transactionId) {
    if (!adapter || !adapter.acceptCallingCard) {
      return Promise.resolve({ sent: false });
    }
    return adapter.acceptCallingCard(transactionId);
  }

  function declineCallingCard(transactionId) {
    if (!adapter || !adapter.declineCallingCard) {
      return Promise.resolve({ sent: false });
    }
    return adapter.declineCallingCard(transactionId);
  }

  function acceptFriendship(transactionId) {
    if (!adapter || !adapter.acceptFriendship) {
      return Promise.resolve({ sent: false });
    }
    return adapter.acceptFriendship(transactionId);
  }

  function declineFriendship(transactionId) {
    if (!adapter || !adapter.declineFriendship) {
      return Promise.resolve({ sent: false });
    }
    return adapter.declineFriendship(transactionId);
  }

  function isBuddy(agentId) {
    if (!adapter || !adapter.isBuddy) return false;
    return adapter.isBuddy(agentId);
  }

  function isAgentOnline(agentId, hints) {
    if (!adapter || !adapter.isAgentOnline) return true;
    return adapter.isAgentOnline(agentId, hints);
  }

  function offerFriendship(destId) {
    if (!adapter || !adapter.offerFriendship) {
      return Promise.resolve({ sent: false });
    }
    return adapter.offerFriendship(destId);
  }

  function removeFriendship(destId) {
    if (!adapter || !adapter.removeFriendship) {
      return Promise.resolve({ sent: false });
    }
    return adapter.removeFriendship(destId);
  }

  function joinGroup(groupId) {
    if (!adapter || !adapter.joinGroup) {
      return Promise.resolve({ sent: false });
    }
    return adapter.joinGroup(groupId);
  }

  function leaveGroup(groupId) {
    if (!adapter || !adapter.leaveGroup) {
      return Promise.resolve({ sent: false });
    }
    return adapter.leaveGroup(groupId);
  }

  function activateGroup(groupId) {
    if (!adapter || !adapter.activateGroup) {
      return Promise.resolve({ sent: false });
    }
    return adapter.activateGroup(groupId);
  }

  function saveGroupTitle(groupId, roleId) {
    if (!adapter || !adapter.saveGroupTitle) {
      return Promise.resolve({ sent: false });
    }
    return adapter.saveGroupTitle(groupId, roleId);
  }

  function saveAvatarNotes(targetId, notes) {
    if (!adapter || !adapter.saveAvatarNotes) {
      return Promise.resolve({ sent: false });
    }
    return adapter.saveAvatarNotes(targetId, notes);
  }

  function payResident(destId, amount, description) {
    if (!adapter || !adapter.payResident) {
      return Promise.resolve({ sent: false });
    }
    return adapter.payResident(destId, amount, description);
  }

  function searchDirectory(kind, query, start) {
    if (!adapter || !adapter.searchDirectory) {
      return Promise.resolve({ rows: [], hasMore: false, nextStart: 0, statusText: '' });
    }
    return adapter.searchDirectory(kind, query, start);
  }

  function updateParcel(data) {
    if (!adapter) return;
    return adapter.updateParcel(data);
  }

  // About Land passthroughs. Every guard lives in the Rust core; these only
  // forward, and reject cleanly when no adapter is attached.
  function landCall(name, args) {
    if (!adapter || typeof adapter[name] !== 'function') {
      return Promise.reject(new Error('Not connected'));
    }
    return adapter[name].apply(adapter, args);
  }
  function requestCovenant() { return landCall('requestCovenant', []); }
  function fetchCovenantText() { return landCall('fetchCovenantText', []); }
  function requestParcelAccess(localId, flags) { return landCall('requestParcelAccess', [localId, flags]); }
  function updateParcelAccess(localId, flags, entries) { return landCall('updateParcelAccess', [localId, flags, entries]); }
  function requestParcelObjectOwners(localId) { return landCall('requestParcelObjectOwners', [localId]); }
  function parcelReturnObjects(localId, returnType, ownerIds) { return landCall('parcelReturnObjects', [localId, returnType, ownerIds]); }
  function parcelSetAutoreturn(localId, minutes) { return landCall('parcelSetAutoreturn', [localId, minutes]); }
  function parcelBuy(localId) { return landCall('parcelBuy', [localId]); }
  function parcelRelease(localId) { return landCall('parcelRelease', [localId]); }
  function parcelBuyPass(localId) { return landCall('parcelBuyPass', [localId]); }
  function parcelDeedToGroup(localId, groupId) { return landCall('parcelDeedToGroup', [localId, groupId]); }
  function parcelEnvironment(localId) { return landCall('parcelEnvironment', [localId]); }
  function experienceNames(ids) { return landCall('experienceNames', [ids]); }
  function accessListFlags() {
    return {
      access: (adapter && adapter.AL_ACCESS) || 0x1,
      ban: (adapter && adapter.AL_BAN) || 0x2,
      allowExperience: (adapter && adapter.AL_ALLOW_EXPERIENCE) || 0x8,
      blockExperience: (adapter && adapter.AL_BLOCK_EXPERIENCE) || 0x10
    };
  }

  function refreshParcel(options?) {
    if (!adapter) return;
    return adapter.refreshParcel(options);
  }

  function fetchParcelInfo(parcelId) {
    if (!adapter || !adapter.fetchParcelInfo) {
      return Promise.reject(new Error('Parcel info unavailable'));
    }
    return adapter.fetchParcelInfo(parcelId);
  }

  function remoteParcel(gridX, gridY, x, y, z, regionId?) {
    if (!adapter || !adapter.remoteParcel) return Promise.resolve(null);
    return adapter.remoteParcel(gridX, gridY, x, y, z, regionId);
  }

  function sendTeleportOffer(targetId, message) {
    if (!adapter || !adapter.sendTeleportOffer) return Promise.resolve();
    return adapter.sendTeleportOffer(targetId, message);
  }

  function sendTeleportRequest(targetId, message) {
    if (!adapter || !adapter.sendTeleportRequest) return Promise.resolve();
    return adapter.sendTeleportRequest(targetId, message);
  }

  function acceptTeleportOffer(offer) {
    if (!adapter || !adapter.acceptTeleportOffer) return Promise.resolve();
    return adapter.acceptTeleportOffer(offer);
  }

  function declineTeleportOffer(offer) {
    if (!adapter || !adapter.declineTeleportOffer) return Promise.resolve();
    return adapter.declineTeleportOffer(offer);
  }

  function acceptTeleportRequest(request, message) {
    if (!adapter || !adapter.acceptTeleportRequest) return Promise.resolve();
    return adapter.acceptTeleportRequest(request, message);
  }

  function declineTeleportRequest(request) {
    if (!adapter || !adapter.declineTeleportRequest) return Promise.resolve();
    return adapter.declineTeleportRequest(request);
  }

  function resolveLocation(input) {
    if (!adapter || !adapter.resolveLocation) {
      return Promise.reject(new Error('Map not available'));
    }
    return adapter.resolveLocation(input);
  }

  function teleportTo(input) {
    if (!adapter || !adapter.teleportTo) {
      return Promise.reject(new Error('Teleport not available'));
    }
    return adapter.teleportTo(input);
  }

  function teleportHome() {
    if (!adapter || !adapter.teleportHome) {
      return Promise.reject(new Error('Teleport home not available'));
    }
    return adapter.teleportHome();
  }

  function teleportToLandmark(assetId, target?) {
    if (!adapter || !adapter.teleportToLandmark) {
      return Promise.reject(new Error('Landmark teleport not available'));
    }
    return adapter.teleportToLandmark(assetId, target);
  }

  function listLandmarks() {
    if (!adapter || !adapter.listLandmarks) return Promise.reject(new Error('Landmarks not available'));
    return adapter.listLandmarks();
  }

  function landmarkInfo(assetId) {
    if (!adapter || !adapter.landmarkInfo) return Promise.reject(new Error('Landmarks not available'));
    return adapter.landmarkInfo(assetId);
  }

  function listScripts() {
    if (!adapter || !adapter.listScripts) return Promise.reject(new Error('Scripts not available'));
    return adapter.listScripts();
  }

  function requestScriptSource(itemId, assetId) {
    if (!adapter || !adapter.requestScriptSource) return Promise.reject(new Error('Scripts not available'));
    return adapter.requestScriptSource(itemId, assetId);
  }

  function saveScript(itemId, text, target) {
    if (!adapter || !adapter.saveScript) return Promise.reject(new Error('Scripts not available'));
    return adapter.saveScript(itemId, text, target);
  }

  function createScript(name) {
    if (!adapter || !adapter.createScript) return Promise.reject(new Error('Scripts not available'));
    return adapter.createScript(name);
  }

  function renameScript(itemId, name) {
    if (!adapter || !adapter.renameScript) return Promise.reject(new Error('Scripts not available'));
    return adapter.renameScript(itemId, name);
  }

  function lslLanguage() {
    if (!adapter || !adapter.lslLanguage) return Promise.reject(new Error('Scripts not available'));
    return adapter.lslLanguage();
  }

  function cancelTeleport() {
    if (!adapter || !adapter.cancelTeleport) {
      return Promise.resolve(false);
    }
    return adapter.cancelTeleport();
  }

  function isTeleportInProgress() {
    if (!adapter || !adapter.isTeleportInProgress) return false;
    return adapter.isTeleportInProgress();
  }

  function requestMapArea(minX, minY, maxX, maxY) {
    if (!adapter || !adapter.requestMapArea) return Promise.resolve([]);
    return adapter.requestMapArea(minX, minY, maxX, maxY);
  }

  function requestMapAgentCounts(tiles) {
    if (!adapter || !adapter.requestMapAgentCounts) return Promise.resolve();
    return adapter.requestMapAgentCounts(tiles);
  }

  function getMapServerUrl() {
    if (!adapter || !adapter.getMapServerUrl) return BeeSlurl.DEFAULT_MAP_SERVER;
    return adapter.getMapServerUrl();
  }

  function getMapTileUrl(level, gridX, gridY) {
    if (!adapter || !adapter.getMapTileUrl) {
      return BeeSlurl.tileUrl(BeeSlurl.DEFAULT_MAP_SERVER, level, gridX, gridY);
    }
    return adapter.getMapTileUrl(level, gridX, gridY);
  }

  function getBridgeUrl() {
    if (!adapter || !adapter.getBridgeUrl) return '';
    return adapter.getBridgeUrl();
  }

  function getCachedName(id) {
    if (!adapter || !adapter.getCachedName) return '';
    return adapter.getCachedName(id);
  }

  function getCachedNameInfo(id) {
    if (!adapter || !adapter.getCachedNameInfo) return null;
    return adapter.getCachedNameInfo(id);
  }

  function getGroupName(id) {
    if (!adapter || !adapter.getGroupName) return '';
    return adapter.getGroupName(id);
  }

  function queueNameResolve(ids) {
    if (!adapter || !adapter.queueNameResolve) return;
    adapter.queueNameResolve(ids);
  }

  function queueGroupNameResolve(ids) {
    if (!adapter || !adapter.queueGroupNameResolve) return;
    adapter.queueGroupNameResolve(ids);
  }

  function start() {
    if (adapter && adapter.start) adapter.start();
  }

  function stop() {
    if (adapter && adapter.stop) adapter.stop();
  }

  return {
    use: use,
    on: on,
    emit: emit,
    login: login,
    logout: logout,
    reconnect: reconnect,
    sendChat: sendChat,
    sendIm: sendIm,
    sendTypingState: sendTypingState,
    openGroupChat: openGroupChat,
    startConference: startConference,
    leaveImSession: leaveImSession,
    inviteToSession: inviteToSession,
    moderateSessionText: moderateSessionText,
    replyScriptDialog: replyScriptDialog,
    replyScriptPermission: replyScriptPermission,
    acceptCallingCard: acceptCallingCard,
    declineCallingCard: declineCallingCard,
    acceptFriendship: acceptFriendship,
    declineFriendship: declineFriendship,
    isBuddy: isBuddy,
    isAgentOnline: isAgentOnline,
    offerFriendship: offerFriendship,
    removeFriendship: removeFriendship,
    joinGroup: joinGroup,
    leaveGroup: leaveGroup,
    activateGroup: activateGroup,
    saveGroupTitle: saveGroupTitle,
    saveAvatarNotes: saveAvatarNotes,
    payResident: payResident,
    searchDirectory: searchDirectory,
    updateParcel: updateParcel,
    refreshParcel: refreshParcel,
    requestCovenant: requestCovenant, fetchCovenantText: fetchCovenantText,
    requestParcelAccess: requestParcelAccess, updateParcelAccess: updateParcelAccess,
    requestParcelObjectOwners: requestParcelObjectOwners,
    parcelReturnObjects: parcelReturnObjects, parcelSetAutoreturn: parcelSetAutoreturn,
    parcelBuy: parcelBuy, parcelRelease: parcelRelease, parcelBuyPass: parcelBuyPass,
    parcelDeedToGroup: parcelDeedToGroup, parcelEnvironment: parcelEnvironment,
    experienceNames: experienceNames, accessListFlags: accessListFlags,
    fetchParcelInfo: fetchParcelInfo,
    remoteParcel: remoteParcel,
    sendTeleportOffer: sendTeleportOffer,
    sendTeleportRequest: sendTeleportRequest,
    acceptTeleportOffer: acceptTeleportOffer,
    declineTeleportOffer: declineTeleportOffer,
    acceptTeleportRequest: acceptTeleportRequest,
    declineTeleportRequest: declineTeleportRequest,
    resolveLocation: resolveLocation,
    teleportTo: teleportTo,
    teleportHome: teleportHome,
    teleportToLandmark: teleportToLandmark,
    listLandmarks: listLandmarks,
    landmarkInfo: landmarkInfo,
    listScripts: listScripts,
    requestScriptSource: requestScriptSource,
    saveScript: saveScript,
    createScript: createScript,
    renameScript: renameScript,
    lslLanguage: lslLanguage,
    cancelTeleport: cancelTeleport,
    isTeleportInProgress: isTeleportInProgress,
    requestMapArea: requestMapArea,
    requestMapAgentCounts: requestMapAgentCounts,
    getMapServerUrl: getMapServerUrl,
    getMapTileUrl: getMapTileUrl,
    getBridgeUrl: getBridgeUrl,
    getCachedName: getCachedName,
    getCachedNameInfo: getCachedNameInfo,
    getGroupName: getGroupName,
    queueNameResolve: queueNameResolve,
    queueGroupNameResolve: queueGroupNameResolve,
    start: start,
    stop: stop
  };
})();
