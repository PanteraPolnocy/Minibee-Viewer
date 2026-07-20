/**
 * Transport abstraction for future real SL protocol integration.
 *
 * Real implementation would need:
 * - XML-RPC login (login.cgi)
 * - UDP circuit + message_template.msg codec
 * - HTTP capability discovery (seed_capability)
 * - EventQueueGet long-poll
 */
const FSTransport = (function () {
  'use strict';

  let adapter = null;
  const handlers = new Map();

  function use(impl) {
    adapter = impl;
  }

  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
  }

  function emit(event, data) {
    const set = handlers.get(event);
    if (set) set.forEach(function (fn) { fn(data); });
  }

  async function login(credentials) {
    if (!adapter) throw new Error('No transport adapter configured');
    return adapter.login(credentials);
  }

  async function logout() {
    if (adapter && adapter.logout) await adapter.logout();
    emit('disconnected');
  }

  function sendChat(text, options) {
    if (!adapter) return;
    adapter.sendChat(text, options);
  }

  function sendIm(sessionId, text) {
    if (!adapter) return;
    adapter.sendIm(sessionId, text);
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

  function isBuddy(agentId) {
    if (!adapter || !adapter.isBuddy) return false;
    return adapter.isBuddy(agentId);
  }

  function offerFriendship(destId) {
    if (!adapter || !adapter.offerFriendship) {
      return Promise.resolve({ sent: false });
    }
    return adapter.offerFriendship(destId);
  }

  function payResident(destId, amount, description) {
    if (!adapter || !adapter.payResident) {
      return Promise.resolve({ sent: false });
    }
    return adapter.payResident(destId, amount, description);
  }

  function searchDirectory(kind, query) {
    if (!adapter || !adapter.searchDirectory) {
      return Promise.resolve([]);
    }
    return adapter.searchDirectory(kind, query);
  }

  function updateParcel(data) {
    if (!adapter) return;
    return adapter.updateParcel(data);
  }

  function refreshParcel(options) {
    if (!adapter) return;
    return adapter.refreshParcel(options);
  }

  function fetchParcelInfo(parcelId) {
    if (!adapter || !adapter.fetchParcelInfo) {
      return Promise.reject(new Error('Parcel info unavailable'));
    }
    return adapter.fetchParcelInfo(parcelId);
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

  function teleportToLandmark(landmarkId) {
    if (!adapter || !adapter.teleportToLandmark) {
      return Promise.reject(new Error('Landmark teleport not available'));
    }
    return adapter.teleportToLandmark(landmarkId);
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
    if (!adapter || !adapter.getMapServerUrl) return FSSlurl.DEFAULT_MAP_SERVER;
    return adapter.getMapServerUrl();
  }

  function getMapTileUrl(level, gridX, gridY) {
    if (!adapter || !adapter.getMapTileUrl) {
      return FSSlurl.tileUrl(FSSlurl.DEFAULT_MAP_SERVER, level, gridX, gridY);
    }
    return adapter.getMapTileUrl(level, gridX, gridY);
  }

  function getBridgeUrl() {
    if (!adapter || !adapter.getBridgeUrl) return 'http://127.0.0.1:8794';
    return adapter.getBridgeUrl();
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
    sendChat: sendChat,
    sendIm: sendIm,
    replyScriptDialog: replyScriptDialog,
    replyScriptPermission: replyScriptPermission,
    acceptCallingCard: acceptCallingCard,
    declineCallingCard: declineCallingCard,
    isBuddy: isBuddy,
    offerFriendship: offerFriendship,
    payResident: payResident,
    searchDirectory: searchDirectory,
    updateParcel: updateParcel,
    refreshParcel: refreshParcel,
    fetchParcelInfo: fetchParcelInfo,
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
    cancelTeleport: cancelTeleport,
    isTeleportInProgress: isTeleportInProgress,
    requestMapArea: requestMapArea,
    requestMapAgentCounts: requestMapAgentCounts,
    getMapServerUrl: getMapServerUrl,
    getMapTileUrl: getMapTileUrl,
    getBridgeUrl: getBridgeUrl,
    start: start,
    stop: stop
  };
})();
