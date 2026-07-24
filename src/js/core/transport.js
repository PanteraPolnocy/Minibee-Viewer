/**
 * The in-app event bus and method facade the UI talks to. The actual Second Life
 * protocol - XML-RPC login, the UDP circuit and message_template.msg codec,
 * capability discovery, and the EventQueueGet long-poll - all lives in the Rust
 * core now. This layer just relays the core's events onto a bus the UI can
 * subscribe to, and forwards UI actions to whichever adapter is wired up
 * (sl-bridge.js, which turns them into invoke() calls).
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
    if (!set) return;
    // Keep each subscriber isolated: one handler that throws must not block
    // delivery to the other subscribers of the same event (mirrors FSState.emit).
    set.forEach(function (fn) {
      try { fn(data); } catch (e) {
        if (typeof console !== 'undefined') console.error('FSTransport handler for "' + event + '" threw', e);
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

  function remoteParcel(gridX, gridY, x, y, z) {
    if (!adapter || !adapter.remoteParcel) return Promise.resolve(null);
    return adapter.remoteParcel(gridX, gridY, x, y, z);
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
    start: start,
    stop: stop
  };
})();
