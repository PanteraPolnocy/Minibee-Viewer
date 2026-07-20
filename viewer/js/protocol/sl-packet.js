/**
 * SL packet encode/decode and circuit manager.
 */
const FSSLCircuit = (function () {
  'use strict';

  const B = FSSLBinary;
  const M = B.Message;
  const PF = B.PacketFlags;
  const MF = B.MsgFlags;

  const PING_INTERVAL_MS = 5000;
  const CIRCUIT_TIMEOUT_MS = 100000;
  const WATCHDOG_INTERVAL_MS = 10000;
  const POLL_TIMEOUT_ACTIVE_SEC = 3;
  const POLL_TIMEOUT_IDLE_SEC = 10;
  const POLL_IDLE_AFTER_MS = 8000;
  const POLL_BACKOFF_ACTIVE_MS = 200;
  const POLL_BACKOFF_IDLE_MS = 800;

  function u32le(buf, pos, v) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 4);
    dv.setUint32(0, v >>> 0, true);
    return pos + 4;
  }
  function u32be(buf, pos, v) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 4);
    dv.setUint32(0, v >>> 0, false);
    return pos + 4;
  }
  function u16le(buf, pos, v) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 2);
    dv.setUint16(0, v, true);
    return pos + 2;
  }
  function i32le(buf, pos, v) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 4);
    dv.setInt32(0, v, true);
    return pos + 4;
  }
  function f32le(buf, pos, v) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 4);
    dv.setFloat32(0, v, true);
    return pos + 4;
  }
  function u8(buf, pos, v) { buf[pos] = v & 0xFF; return pos + 1; }

  function u64le(buf, pos, value) {
    const h = BigInt(value || 0);
    pos = u32le(buf, pos, Number(h & 0xFFFFFFFFn));
    return u32le(buf, pos, Number(h >> 32n));
  }

  function readI32le(buf, pos) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 4);
    return { value: dv.getInt32(0, true), pos: pos + 4 };
  }

  function readU32le(buf, pos) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 4);
    return { value: dv.getUint32(0, true), pos: pos + 4 };
  }

  function readVector3d(buf, pos) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 24);
    return {
      x: dv.getFloat64(0, true),
      y: dv.getFloat64(8, true),
      z: dv.getFloat64(16, true),
      pos: pos + 24
    };
  }

  function formatProfileLocation(simName, pos) {
    if (!pos) return String(simName || '').trim();
    const rw = 256;
    const x = Math.round(((pos.x % rw) + rw) % rw);
    const y = Math.round(((pos.y % rw) + rw) % rw);
    const z = Math.round(pos.z);
    const name = String(simName || '').trim();
    if (name) return name + ' (' + x + ', ' + y + ', ' + z + ')';
    const gridX = Math.floor(Number(pos.x) / rw);
    const gridY = Math.floor(Number(pos.y) / rw);
    return 'Region ' + gridX + ',' + gridY + ' (' + x + ', ' + y + ', ' + z + ')';
  }

  function readU64le(buf, pos) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 8);
    const lo = BigInt(dv.getUint32(0, true));
    const hi = BigInt(dv.getUint32(4, true));
    return { value: (hi << 32n) | lo, pos: pos + 8 };
  }

  function readIpAddr(buf, pos) {
    const ip = buf[pos] + '.' + buf[pos + 1] + '.' + buf[pos + 2] + '.' + buf[pos + 3];
    return { ip: ip, pos: pos + 4 };
  }

  const MSG_META = {};
  MSG_META[M.UseCircuitCode] = { name: 'UseCircuitCode', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.CompleteAgentMovement] = { name: 'CompleteAgentMovement', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.RegionHandshakeReply] = { name: 'RegionHandshakeReply', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.AgentDataUpdateRequest] = { name: 'AgentDataUpdateRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.LogoutRequest] = { name: 'LogoutRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.ChatFromViewer] = { name: 'ChatFromViewer', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.ImprovedInstantMessage] = { name: 'ImprovedInstantMessage', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.ParcelPropertiesUpdate] = { name: 'ParcelPropertiesUpdate', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.ParcelPropertiesRequest] = { name: 'ParcelPropertiesRequest', freq: MF.FrequencyMedium, zero: true };
  MSG_META[M.ParcelPropertiesRequestByID] = { name: 'ParcelPropertiesRequestByID', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.PacketAck] = { name: 'PacketAck', freq: MF.FrequencyFixed, zero: false };
  MSG_META[M.StartPingCheck] = { name: 'StartPingCheck', freq: MF.FrequencyHigh, zero: false };
  MSG_META[M.CompletePingCheck] = { name: 'CompletePingCheck', freq: MF.FrequencyHigh, zero: false };
  MSG_META[M.AgentUpdate] = { name: 'AgentUpdate', freq: MF.FrequencyHigh, zero: true };
  MSG_META[M.ParcelProperties] = { name: 'ParcelProperties', freq: MF.FrequencyHigh, zero: true };
  MSG_META[M.ParcelInfoRequest] = { name: 'ParcelInfoRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.ParcelInfoReply] = { name: 'ParcelInfoReply', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.AgentDataUpdate] = { name: 'AgentDataUpdate', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.ChatFromSimulator] = { name: 'ChatFromSimulator', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.CoarseLocationUpdate] = { name: 'CoarseLocationUpdate', freq: MF.FrequencyMedium, zero: false };
  MSG_META[M.CrossedRegion] = { name: 'CrossedRegion', freq: MF.FrequencyMedium, zero: false };
  MSG_META[M.RegionHandshake] = { name: 'RegionHandshake', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.TeleportLocal] = { name: 'TeleportLocal', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.TeleportProgress] = { name: 'TeleportProgress', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.TeleportFinish] = { name: 'TeleportFinish', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.TeleportStart] = { name: 'TeleportStart', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.StartLure] = { name: 'StartLure', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.TeleportLureRequest] = { name: 'TeleportLureRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.TeleportFailed] = { name: 'TeleportFailed', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.AgentMovementComplete] = { name: 'AgentMovementComplete', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.UUIDNameRequest] = { name: 'UUIDNameRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.UUIDNameReply] = { name: 'UUIDNameReply', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.TeleportLocationRequest] = { name: 'TeleportLocationRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.TeleportLandmarkRequest] = { name: 'TeleportLandmarkRequest', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.EnableSimulator] = { name: 'EnableSimulator', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.MapBlockRequest] = { name: 'MapBlockRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.MapNameRequest] = { name: 'MapNameRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.MapBlockReply] = { name: 'MapBlockReply', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.MapItemRequest] = { name: 'MapItemRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.MapItemReply] = { name: 'MapItemReply', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.LogoutReply] = { name: 'LogoutReply', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.KickUser] = { name: 'KickUser', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.SystemKickUser] = { name: 'SystemKickUser', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.KillChildAgents] = { name: 'KillChildAgents', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.OnlineNotification] = { name: 'OnlineNotification', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.OfflineNotification] = { name: 'OfflineNotification', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.DataHomeLocationRequest] = { name: 'DataHomeLocationRequest', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.DataHomeLocationReply] = { name: 'DataHomeLocationReply', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.AlertMessage] = { name: 'AlertMessage', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.AgentAlertMessage] = { name: 'AgentAlertMessage', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.MeanCollisionAlert] = { name: 'MeanCollisionAlert', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.ViewerFrozenMessage] = { name: 'ViewerFrozenMessage', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.HealthMessage] = { name: 'HealthMessage', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.SimulatorViewerTimeMessage] = { name: 'SimulatorViewerTimeMessage', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.DisableSimulator] = { name: 'DisableSimulator', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.ScriptQuestion] = { name: 'ScriptQuestion', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.ScriptControlChange] = { name: 'ScriptControlChange', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.ScriptDialog] = { name: 'ScriptDialog', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.ScriptDialogReply] = { name: 'ScriptDialogReply', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.ScriptAnswerYes] = { name: 'ScriptAnswerYes', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.FeatureDisabled] = { name: 'FeatureDisabled', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.LoadURL] = { name: 'LoadURL', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.ScriptTeleportRequest] = { name: 'ScriptTeleportRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.GenericMessage] = { name: 'GenericMessage', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.AvatarPropertiesRequest] = { name: 'AvatarPropertiesRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.GroupProfileRequest] = { name: 'GroupProfileRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.ActivateGroup] = { name: 'ActivateGroup', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.GroupRoleDataRequest] = { name: 'GroupRoleDataRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.GroupTitlesRequest] = { name: 'GroupTitlesRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.GroupTitleUpdate] = { name: 'GroupTitleUpdate', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.JoinGroupRequest] = { name: 'JoinGroupRequest', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.LeaveGroupRequest] = { name: 'LeaveGroupRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.JoinGroupReply] = { name: 'JoinGroupReply', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.LeaveGroupReply] = { name: 'LeaveGroupReply', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.ClassifiedInfoRequest] = { name: 'ClassifiedInfoRequest', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.MoneyBalanceReply] = { name: 'MoneyBalanceReply', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.AgentGroupDataUpdate] = { name: 'AgentGroupDataUpdate', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.MapLayerReply] = { name: 'MapLayerReply', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.ConfirmEnableSimulator] = { name: 'ConfirmEnableSimulator', freq: MF.FrequencyMedium, zero: false };
  MSG_META[M.TeleportCancel] = { name: 'TeleportCancel', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.EconomyDataRequest] = { name: 'EconomyDataRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.MoneyBalanceRequest] = { name: 'MoneyBalanceRequest', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.AcceptCallingCard] = { name: 'AcceptCallingCard', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.DeclineCallingCard] = { name: 'DeclineCallingCard', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.OfferCallingCard] = { name: 'OfferCallingCard', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.AvatarNotesUpdate] = { name: 'AvatarNotesUpdate', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.TerminateFriendship] = { name: 'TerminateFriendship', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.AvatarPickerRequest] = { name: 'AvatarPickerRequest', freq: MF.FrequencyLow, zero: false };
  MSG_META[M.DirFindQuery] = { name: 'DirFindQuery', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.DirPlacesQuery] = { name: 'DirPlacesQuery', freq: MF.FrequencyLow, zero: true };
  MSG_META[M.MoneyTransferRequest] = { name: 'MoneyTransferRequest', freq: MF.FrequencyLow, zero: true };

  const LOW_MSG_BASE = 4294901760;

  function lowMsgId(templateNum) {
    return LOW_MSG_BASE + (templateNum >>> 0);
  }

  function mediumMsgId(templateNum) {
    return (0xFF00 | (templateNum & 0xFF)) >>> 0;
  }

  function highMsgId(templateNum) {
    return templateNum & 0xFF;
  }

  function registerInboundMeta(msgId, name, freq, zero) {
    if (MSG_META[msgId]) return;
    MSG_META[msgId] = {
      name: name,
      freq: freq,
      zero: !!zero
    };
  }

  function ensureMsgMeta(msgId) {
    if (MSG_META[msgId]) return MSG_META[msgId];
    const id = msgId >>> 0;
    let meta = null;
    if (id >= 0xFFFF0000) {
      meta = {
        name: 'Low_' + (id & 0xFFFF),
        freq: MF.FrequencyLow,
        zero: false
      };
    } else if (id >= 0xFF00 && id < 0xFFFF0000) {
      meta = {
        name: 'Medium_' + (id & 0xFF),
        freq: MF.FrequencyMedium,
        zero: false
      };
    } else if (id > 0 && id < 0x100) {
      meta = {
        name: 'High_' + id,
        freq: MF.FrequencyHigh,
        zero: false
      };
    }
    if (meta) MSG_META[msgId] = meta;
    return meta;
  }

  function initInboundMeta() {
    function H(n, name, z) {
      registerInboundMeta(highMsgId(n), name, MF.FrequencyHigh, !!z);
    }
    function M(n, name, z) {
      registerInboundMeta(mediumMsgId(n), name, MF.FrequencyMedium, !!z);
    }
    function L(n, name, z) {
      registerInboundMeta(lowMsgId(n), name, MF.FrequencyLow, !!z);
    }

    // High-frequency sim -> viewer (llstartup.cpp + world stream)
    H(3, 'NeighborList', false);
    H(5, 'AgentAnimation', false);
    H(9, 'ImageData', false);
    H(10, 'ImagePacket', false);
    H(11, 'LayerData', false);
    H(12, 'ObjectUpdate', true);
    H(13, 'ObjectUpdateCompressed', false);
    H(14, 'ObjectUpdateCached', false);
    H(15, 'ImprovedTerseObjectUpdate', false);
    H(16, 'KillObject', false);
    H(20, 'AvatarAnimation', false);
    H(21, 'AvatarSitResponse', true);
    H(22, 'CameraConstraint', true);
    H(23, 'ParcelProperties', true);
    H(29, 'SoundTrigger', false);
    H(30, 'ObjectAnimation', false);
    H(31, 'GenericStreamingMessage', false);

    // Medium frequency
    M(2, 'MultipleObjectUpdate', true);
    M(6, 'CoarseLocationUpdate', false);
    M(7, 'CrossedRegion', false);
    M(9, 'ObjectProperties', true);
    M(10, 'ObjectPropertiesFamily', true);
    M(13, 'AttachedSound', false);
    M(14, 'AttachedSoundGainChange', false);
    M(15, 'PreloadSound', false);
    M(17, 'ViewerEffect', true);

    // Low frequency - all llstartup.cpp inbound handlers
    L(19, 'FeatureDisabled', false);
    L(25, 'EconomyData', true);
    L(28, 'AvatarPickerReply', false);
    L(30, 'PlacesReply', true);
    L(35, 'DirPlacesReply', true);
    L(36, 'DirPeopleReply', true);
    L(37, 'DirEventsReply', true);
    L(38, 'DirGroupsReply', true);
    L(41, 'DirClassifiedReply', true);
    L(42, 'AvatarClassifiedReply', false);
    L(44, 'ClassifiedInfoReply', false);
    L(50, 'DirLandReply', true);
    L(57, 'ParcelObjectOwnersReply', true);
    L(59, 'GroupNoticesListReply', false);
    L(86, 'ImageNotInDatabase', false);
    L(87, 'RebakeAvatarTextures', false);
    L(104, 'DerezContainer', true);
    L(140, 'SimStats', false);
    L(142, 'RegionInfo', true);
    L(158, 'AvatarAppearance', true);
    L(159, 'SetFollowCamProperties', false);
    L(160, 'ClearFollowCamProperties', false);
    L(171, 'AvatarPropertiesReply', true);
    L(172, 'AvatarInterestsReply', true);
    L(173, 'AvatarGroupsReply', true);
    L(176, 'AvatarNotesReply', false);
    L(177, 'AvatarNotesUpdate', false);
    L(178, 'AvatarPicksReply', false);
    L(180, 'EventInfoReply', false);
    L(184, 'PickInfoReply', false);
    L(194, 'LoadURL', false);
    L(195, 'ScriptTeleportRequest', false);
    L(196, 'ParcelOverlay', true);
    L(204, 'EstateCovenantReply', false);
    L(205, 'ForceObjectSelect', false);
    L(216, 'ParcelAccessListReply', true);
    L(219, 'ParcelDwellReply', false);
    L(244, 'ScriptRunningReply', false);
    L(250, 'AgentMovementComplete', false);
    L(258, 'GrantGodlikePowers', false);
    L(261, 'GenericMessage', true);
    L(290, 'ReplyTaskInventory', true);
    L(292, 'DeRezAck', false);
    L(301, 'OfferCallingCard', false);
    L(302, 'AcceptCallingCard', false);
    L(303, 'DeclineCallingCard', false);
    L(329, 'NameValuePair', false);
    L(330, 'RemoveNameValuePair', false);
    L(340, 'CreateGroupReply', false);
    L(344, 'JoinGroupReply', false);
    L(346, 'EjectGroupMemberReply', false);
    L(348, 'LeaveGroupReply', false);
    L(352, 'GroupProfileReply', true);
    L(354, 'GroupAccountSummaryReply', true);
    L(356, 'GroupAccountDetailsReply', true);
    L(358, 'GroupAccountTransactionsReply', true);
    L(367, 'GroupMembersReply', true);
    L(372, 'GroupRoleDataReply', false);
    L(374, 'GroupRoleMembersReply', false);
    L(376, 'GroupTitlesReply', true);
    L(382, 'AgentWearablesUpdate', true);
    L(385, 'AgentCachedTextureResponse', false);
    L(390, 'AgentDropGroup', true);
    L(400, 'UserInfoReply', false);
    L(403, 'InitiateDownload', false);
    L(422, 'LandStatReply', false);
    L(430, 'LargeGenericMessage', false);
    L(10, 'TelehubInfo', false);
    L(162, 'PayPriceReply', false);
    L(256, 'FindAgent', false);
    L(267, 'UpdateCreateInventoryItem', true);
    L(268, 'MoveInventoryItem', true);
    L(270, 'RemoveInventoryItem', false);
    L(272, 'SaveAssetIntoInventory', false);
    L(276, 'RemoveInventoryFolder', false);
    L(278, 'InventoryDescendents', true);
    L(280, 'FetchInventoryReply', true);
    L(281, 'BulkUpdateInventory', true);
    L(284, 'RemoveInventoryObjects', false);
    L(300, 'TerminateFriendship', false);
    L(321, 'ChangeUserRights', false);
    L(419, 'ParcelMediaCommandMessage', false);
    L(420, 'ParcelMediaUpdate', false);
  }

  initInboundMeta();

  function peekPacketHeader(buf) {
    if (!buf || buf.length < 6) return null;
    return {
      seq: new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0, false),
      reliable: (buf[0] & PF.Reliable) !== 0
    };
  }

  function isConsumedInbound(msg) {
    return !!(msg && msg.id && MSG_META[msg.id]);
  }

  function writeVar1(buf, pos, text) {
    const bytes = B.utf8(text || '');
    pos = u8(buf, pos, bytes.length + 1);
    if (bytes.length) {
      buf.set(bytes, pos);
      pos += bytes.length;
    }
    return u8(buf, pos, 0);
  }

  function writeVar2(buf, pos, text) {
    const bytes = B.utf8(text || '');
    pos = u16le(buf, pos, bytes.length + 1);
    if (bytes.length) {
      buf.set(bytes, pos);
      pos += bytes.length;
    }
    return u8(buf, pos, 0);
  }

  function readVar1(buf, pos) {
    const wireLen = buf[pos++];
    let dataLen = wireLen;
    if (dataLen > 0 && buf[pos + dataLen - 1] === 0) dataLen--;
    const text = B.fromUtf8(buf, pos, dataLen);
    return { text: text, pos: pos + wireLen };
  }

  function readVar2(buf, pos) {
    const wireLen = buf[pos] | (buf[pos + 1] << 8);
    pos += 2;
    let dataLen = wireLen;
    if (dataLen > 0 && buf[pos + dataLen - 1] === 0) dataLen--;
    const text = B.fromUtf8(buf, pos, dataLen);
    return { text: text, pos: pos + wireLen, len: wireLen };
  }

  function readVar2Bytes(buf, pos) {
    if (pos + 2 > buf.length) return { text: '', pos: pos };
    const wireLen = buf[pos] | (buf[pos + 1] << 8);
    pos += 2;
    if (pos + wireLen > buf.length) return { text: '', pos: pos + 2 };
    let dataLen = wireLen;
    if (dataLen > 0 && buf[pos + dataLen - 1] === 0) dataLen--;
    const text = B.fromUtf8(buf, pos, dataLen);
    return { text: text, pos: pos + wireLen, len: wireLen };
  }

  function skipVar2(buf, pos) {
    if (pos + 2 > buf.length) return pos;
    const wireLen = buf[pos] | (buf[pos + 1] << 8);
    return pos + 2 + wireLen;
  }

  function readVar1At(buf, pos) {
    if (pos >= buf.length) return { text: '', pos: pos };
    return readVar1(buf, pos);
  }

  function looksLikeParcelName(text) {
    const s = String(text || '').trim();
    if (!s || s.length > 63) return false;
    if (/^[\x00-\x08\x0e-\x1f]/.test(s)) return false;
    return /^[\x20-\x7e\u00a0-\ufffd]+$/.test(s);
  }

  function scoreParcelAttempt(attempt) {
    const p = attempt && attempt.parcel;
    if (!p) return -1;
    let score = 0;
    if (looksLikeParcelName(p.name)) score += 10;
    if (p.area > 0 && p.area <= 262144) score += 20;
    if (p.primsTotal > 0) score += 15;
    if (p.parcelFlags > 0) score += 8;
    if (p.musicUrl && String(p.musicUrl).trim()) score += 6;
    if (p.mediaUrl && String(p.mediaUrl).trim()) score += 4;
    if (p.primsUsed > 0) score += 10;
    if (p.groupId && p.groupId !== '00000000-0000-0000-0000-000000000000') score += 4;
    if (p.snapshotId && p.snapshotId !== '00000000-0000-0000-0000-000000000000') score += 3;
    if (p.primsTotal > 0 && p.area > 0 && typeof FSUtils !== 'undefined' &&
        FSUtils.estimateParcelPrimCapacity) {
      const est = FSUtils.estimateParcelPrimCapacity(p.area, p.parcelPrimBonus);
      if (est > 0 && Math.abs(p.primsTotal - est) <= Math.max(10, est * 0.2)) score += 10;
    }
    return score;
  }

  function looksLikeUrl(text) {
    const s = String(text || '').trim();
    return /^https?:\/\//i.test(s);
  }

  function parseParcelTailFields(buf, pos, parcel) {
    if (!parcel || pos >= buf.length) return parcel;
    try {
      if (pos + 17 > buf.length) return parcel;
      pos += 1; // MediaAutoScale
      const mediaId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      if (pos + 16 > buf.length) return parcel;
      const groupId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      if (pos + 8 > buf.length) return parcel;
      const dvAt = function (p) {
        return new DataView(buf.buffer, buf.byteOffset + p, 4);
      };
      const passPrice = dvAt(pos).getInt32(0, true);
      pos += 4;
      const passHours = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true);
      pos += 4;
      if (pos >= buf.length) return parcel;
      const category = buf[pos++];
      if (pos + 16 > buf.length) return parcel;
      pos += 16; // AuthBuyerID
      if (pos + 16 > buf.length) return parcel;
      const snapshotId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      if (pos + 12 <= buf.length) {
        parcel.landingPoint = {
          x: Math.round(dvAt(pos).getFloat32(0, true)),
          y: Math.round(dvAt(pos + 4).getFloat32(0, true)),
          z: Math.round(dvAt(pos + 8).getFloat32(0, true))
        };
        pos += 12;
      }
      if (pos + 12 <= buf.length) pos += 12; // UserLookAt
      if (pos < buf.length) parcel.landingType = buf[pos++];
      if (mediaId !== '00000000-0000-0000-0000-000000000000') parcel.mediaId = mediaId;
      if (groupId !== '00000000-0000-0000-0000-000000000000') parcel.groupId = groupId;
      if (snapshotId !== '00000000-0000-0000-0000-000000000000') parcel.snapshotId = snapshotId;
      if (passPrice > 0) parcel.passPrice = passPrice;
      if (passHours > 0) parcel.passHours = passHours;
      if (category) parcel.category = category;
    } catch (_e) { /* optional tail fields */ }
    return parcel;
  }

  function refineParcelFromAnchors(buf, start, parcel, hintName) {
    const nameHint = String(hintName || parcel && parcel.name || '').trim();
    const scanFrom = Math.max(start, 60);
    let best = null;
    let bestScore = -1;
    for (let p = scanFrom; p + 4 < buf.length; p++) {
      const wireLen = buf[p];
      if (wireLen < 2 || wireLen > 200 || p + 1 + wireLen > buf.length) continue;
      const nameTry = readVar1At(buf, p);
      if (!looksLikeParcelName(nameTry.text)) continue;
      if (nameHint && nameTry.text !== nameHint) continue;
      if (p < 12) continue;
      const dv = new DataView(buf.buffer, buf.byteOffset + p - 8, 4);
      const parcelFlags = dv.getUint32(0, true);
      const desc = readVar1At(buf, nameTry.pos);
      const music = readVar1At(buf, desc.pos);
      const media = readVar1At(buf, music.pos);
      let score = 0;
      if (parcelFlags > 0) score += 20;
      if (looksLikeUrl(music.text)) score += 18;
      if (looksLikeUrl(media.text)) score += 12;
      if (looksLikeParcelName(nameTry.text)) score += 10;
      if (String(desc.text || '').length > 4) score += 4;
      if (score > bestScore) {
        bestScore = score;
        best = {
          name: nameTry.text,
          desc: desc.text,
          musicUrl: music.text,
          mediaUrl: media.text,
          parcelFlags: parcelFlags
        };
      }
    }
    if (!best && !nameHint) {
      for (let p = scanFrom; p + 8 < buf.length; p++) {
        if (buf[p] !== 0x68 || buf[p + 1] !== 0x74 || buf[p + 2] !== 0x74 || buf[p + 3] !== 0x70) {
          continue;
        }
        let q = p - 1;
        while (q > scanFrom && buf[q - 1] >= 0x20 && buf[q - 1] <= 0x7e) q--;
        const wireLen = buf[q];
        if (wireLen < 8 || wireLen > 200 || q + 1 + wireLen > buf.length) continue;
        const urlTry = readVar1At(buf, q);
        if (!looksLikeUrl(urlTry.text)) continue;
        if (/\.(mp3|ogg|wav|m3u|pls)(\?|$)/i.test(urlTry.text) ||
            /radio|music|stream/i.test(urlTry.text)) {
          if (!best) best = {};
          if (!best.musicUrl) best.musicUrl = urlTry.text;
        } else if (!best || !best.mediaUrl) {
          if (!best) best = {};
          best.mediaUrl = urlTry.text;
        }
      }
    }
    return best;
  }

  function parseParcelPropertiesAt(buf, pos, opts) {
    const out = {};
    const start = pos;
    const bitmapAfterAabb = opts && opts.bitmapAfterAabb !== undefined ? opts.bitmapAfterAabb : 'skip';
    const optionalSkip = opts && opts.optionalSkip ? opts.optionalSkip : 0;
    const seeAvsSkip = opts && opts.seeAvsSkip ? opts.seeAvsSkip : 0;
    try {
      if (buf.length - pos < 80) return out;
      const dvAt = function (p) {
        return new DataView(buf.buffer, buf.byteOffset + p, 4);
      };
      const requestResult = dvAt(pos).getInt32(0, true);
      pos += 4;
      if (requestResult === -1) {
        out.debug = { requestResult: requestResult, reason: 'no_data' };
        return out;
      }
      const sequenceId = dvAt(pos).getInt32(0, true);
      pos += 4;
      pos += 1; // snapSelection
      pos += 12; // self/other/public counts
      const localId = dvAt(pos).getInt32(0, true);
      pos += 4;
      const ownerId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const isGroupOwned = buf[pos++] !== 0;
      pos += 4; // auctionId
      pos += 12; // claim date/price/rent
      pos += 24; // AABB min/max
      if (bitmapAfterAabb === 'skip') {
        pos = skipVar2(buf, pos);
      } else if (bitmapAfterAabb === 'none') {
        // FS reads area immediately after AABB on current sims.
      } else if (typeof bitmapAfterAabb === 'number') {
        pos += bitmapAfterAabb;
      }
      if (pos + 48 > buf.length) return out;
      const area = dvAt(pos).getInt32(0, true);
      pos += 4;
      pos += 1; // status
      const simWideMaxPrims = dvAt(pos).getInt32(0, true);
      pos += 4;
      const simWideTotalPrims = dvAt(pos).getInt32(0, true);
      pos += 4;
      const maxPrims = dvAt(pos).getInt32(0, true);
      pos += 4;
      const totalPrims = dvAt(pos).getInt32(0, true);
      pos += 4;
      const ownerPrims = dvAt(pos).getInt32(0, true);
      pos += 4;
      const groupPrims = dvAt(pos).getInt32(0, true);
      pos += 4;
      const otherPrims = dvAt(pos).getInt32(0, true);
      pos += 4;
      const selectedPrims = dvAt(pos).getInt32(0, true);
      pos += 4;
      const parcelPrimBonus = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true);
      pos += 4;
      const primUsed = ownerPrims + groupPrims + otherPrims + selectedPrims;
      const primBonus = parcelPrimBonus > 0 ? parcelPrimBonus : 1;
      const primCapacity = Math.round(maxPrims * primBonus);
      pos += 4; // regionPushOverride, regionDenyAnonymous, regionDenyIdentified, regionDenyTransacted
      pos += optionalSkip;
      if (pos + 12 > buf.length) return out;
      const otherCleanTime = dvAt(pos).getInt32(0, true);
      pos += 4;
      const parcelFlags = dvAt(pos).getUint32(0, true);
      pos += 4;
      const salePrice = dvAt(pos).getInt32(0, true);
      pos += 4;
      const name = readVar1At(buf, pos);
      pos = name.pos;
      const desc = readVar1At(buf, pos);
      pos = desc.pos;
      const music = readVar1At(buf, pos);
      pos = music.pos;
      const media = readVar1At(buf, pos);
      pos = media.pos;
      pos += seeAvsSkip;
      const parcel = {
        localId: localId,
        ownerId: ownerId,
        isGroupOwned: isGroupOwned,
        area: area,
        parcelFlags: parcelFlags,
        salePrice: salePrice,
        otherCleanTime: otherCleanTime,
        name: name.text,
        desc: desc.text,
        musicUrl: music.text,
        mediaUrl: media.text,
        primsTotal: primCapacity || maxPrims || simWideMaxPrims,
        primsUsed: primUsed > 0 ? primUsed : (totalPrims || simWideTotalPrims || 0),
        parcelPrimBonus: primBonus,
        simWideMaxPrims: simWideMaxPrims,
        simWideTotalPrims: simWideTotalPrims,
        ownerPrims: ownerPrims,
        groupPrims: groupPrims,
        otherPrims: otherPrims,
        sequenceId: sequenceId
      };
      parseParcelTailFields(buf, pos, parcel);
      out.parcel = parcel;
      out.debug = {
        requestResult: requestResult,
        sequenceId: sequenceId,
        bitmapAfterAabb: bitmapAfterAabb,
        optionalSkip: optionalSkip,
        seeAvsSkip: seeAvsSkip,
        bodyBytes: buf.length - start
      };
    } catch (e) {
      out.debug = {
        error: e.message || String(e),
        bitmapAfterAabb: bitmapAfterAabb,
        optionalSkip: optionalSkip,
        seeAvsSkip: seeAvsSkip
      };
    }
    return out;
  }

  function parcelParseAttempts(buf, pos) {
    const attempts = [];
    const bitmapModes = ['skip', 'none'];
    if (pos + 84 <= buf.length) {
      const wireLen = buf[pos + 82] | (buf[pos + 83] << 8);
      if (wireLen >= 0 && wireLen < 4096) {
        bitmapModes.push(2 + wireLen);
      }
    }
    bitmapModes.push(514, 2, 0);
    const optionalSkips = [0, 1, 2, 5, 6, 11];
    const seeAvsSkips = [0, 3];
    for (let b = 0; b < bitmapModes.length; b++) {
      for (let o = 0; o < optionalSkips.length; o++) {
        for (let s = 0; s < seeAvsSkips.length; s++) {
          attempts.push({
            bitmapAfterAabb: bitmapModes[b],
            optionalSkip: optionalSkips[o],
            seeAvsSkip: seeAvsSkips[s]
          });
        }
      }
    }
    return attempts;
  }

  function scoreParcelParseAttempt(attempt) {
    const p = attempt && attempt.parcel;
    if (!p) return -1;
    let score = scoreParcelAttempt(attempt);
    if (p.parcelFlags > 0) score += 14;
    if (p.musicUrl && String(p.musicUrl).trim().length > 4) score += 12;
    if (p.mediaUrl && String(p.mediaUrl).trim().length > 4) score += 6;
    if (p.primsUsed > 0) score += 8;
    if (p.groupId && p.groupId !== '00000000-0000-0000-0000-000000000000') score += 4;
    return score;
  }

  function parseParcelProperties(buf, pos) {
    const attempts = parcelParseAttempts(buf, pos);
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < attempts.length; i++) {
      const attempt = parseParcelPropertiesAt(buf, pos, attempts[i]);
      const score = scoreParcelParseAttempt(attempt);
      if (score > bestScore) {
        best = attempt;
        bestScore = score;
      }
      if (score >= 55) break;
    }

    const needsScan = !best || !best.parcel ||
      !(best.parcel.parcelFlags > 0) ||
      !String(best.parcel.musicUrl || '').trim() ||
      !(best.parcel.primsUsed > 0);
    if (needsScan) {
      for (let skip = 0; skip <= 16; skip++) {
        const attempt = parseParcelPropertiesAt(buf, pos, {
          bitmapAfterAabb: 'skip',
          optionalSkip: skip,
          seeAvsSkip: 3
        });
        if (!attempt.parcel || !looksLikeParcelName(attempt.parcel.name)) continue;
        const score = scoreParcelParseAttempt(attempt);
        if (score > bestScore) {
          best = attempt;
          bestScore = score;
        }
      }
    }

    if (best && best.parcel) {
      const refined = refineParcelFromAnchors(buf, pos, best.parcel, best.parcel.name);
      if (refined) {
        if (refined.parcelFlags > 0) best.parcel.parcelFlags = refined.parcelFlags;
        if (refined.name) best.parcel.name = refined.name;
        if (refined.desc !== undefined) best.parcel.desc = refined.desc;
        if (refined.musicUrl) best.parcel.musicUrl = refined.musicUrl;
        if (refined.mediaUrl) best.parcel.mediaUrl = refined.mediaUrl;
      }
      return best;
    }
    return parseParcelPropertiesAt(buf, pos, { bitmapAfterAabb: 'skip', optionalSkip: 0, seeAvsSkip: 0 });
  }

  function buildBody(msgId, data) {
    const buf = new Uint8Array(2048);
    let pos = 0;
    const agent = data.agentId;
    const session = data.sessionId;

    switch (msgId) {
      case M.UseCircuitCode:
        pos = u32le(buf, pos, data.circuitCode);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(agent).write(buf, pos);
        break;
      case M.CompleteAgentMovement:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = u32le(buf, pos, data.circuitCode);
        break;
      case M.RegionHandshakeReply:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = u32le(buf, pos, data.flags || 5);
        break;
      case M.AgentDataUpdateRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        break;
      case M.ChatFromViewer: {
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = writeVar2(buf, pos, data.text || '');
        pos = u8(buf, pos, data.chatType !== undefined ? data.chatType : 1);
        pos = i32le(buf, pos, data.channel !== undefined ? data.channel : 0);
        break;
      }
      case M.ImprovedInstantMessage: {
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = u8(buf, pos, data.fromGroup ? 1 : 0);
        pos = new B.UUID(data.toAgentId).write(buf, pos);
        pos = u32le(buf, pos, data.parentEstateId || 0);
        pos = new B.UUID(data.regionId || B.UUID.zero()).write(buf, pos);
        pos = B.writeVec3(buf, pos, data.position || { x: 0, y: 0, z: 0 });
        pos = u8(buf, pos, data.offline !== undefined ? data.offline : 0);
        pos = u8(buf, pos, data.dialog !== undefined ? data.dialog : 0);
        pos = new B.UUID(data.imId || B.UUID.zero()).write(buf, pos);
        pos = u32le(buf, pos, data.timestamp !== undefined ? data.timestamp : 0);
        pos = writeVar1(buf, pos, data.fromName || '');
        pos = writeVar2(buf, pos, data.text || '');
        pos = writeVar2(buf, pos, data.binaryBucket || '');
        break;
      }
      case M.StartLure: {
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = u8(buf, pos, data.lureType || 0);
        pos = writeVar1(buf, pos, data.message || '');
        const targets = data.targetIds || [];
        pos = u8(buf, pos, targets.length);
        for (let i = 0; i < targets.length; i++) {
          pos = new B.UUID(targets[i]).write(buf, pos);
        }
        break;
      }
      case M.TeleportLureRequest: {
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.lureId).write(buf, pos);
        pos = u32le(buf, pos, data.teleportFlags !== undefined ? data.teleportFlags : 4);
        break;
      }
      case M.TeleportLocationRequest: {
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = u64le(buf, pos, data.regionHandle || 0);
        pos = B.writeVec3(buf, pos, data.position || { x: 128, y: 128, z: 25 });
        pos = B.writeVec3(buf, pos, data.lookAt || { x: 129, y: 128, z: 25 });
        break;
      }
      case M.TeleportLandmarkRequest: {
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.landmarkId || B.UUID.zero()).write(buf, pos);
        break;
      }
      case M.TeleportCancel:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        break;
      case M.EconomyDataRequest:
        break;
      case M.MoneyBalanceRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.transactionId || B.UUID.zero()).write(buf, pos);
        break;
      case M.MapNameRequest: {
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = u32le(buf, pos, data.flags !== undefined ? data.flags : 2);
        pos = u32le(buf, pos, 0);
        pos = u8(buf, pos, data.godlike ? 1 : 0);
        pos = writeVar1(buf, pos, data.regionName || '');
        break;
      }
      case M.MapBlockRequest: {
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = u32le(buf, pos, data.flags !== undefined ? data.flags : 2);
        pos = u32le(buf, pos, 0);
        pos = u8(buf, pos, data.godlike ? 1 : 0);
        pos = u16le(buf, pos, data.minX || 0);
        pos = u16le(buf, pos, data.minY || 0);
        pos = u16le(buf, pos, data.maxX || 0);
        pos = u16le(buf, pos, data.maxY || 0);
        break;
      }
      case M.MapItemRequest: {
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = u32le(buf, pos, data.flags !== undefined ? data.flags : 2);
        pos = u32le(buf, pos, 0);
        pos = u8(buf, pos, data.godlike ? 1 : 0);
        pos = u32le(buf, pos, data.itemType || 0);
        pos = u64le(buf, pos, data.regionHandle || 0);
        break;
      }
      case M.LogoutRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        break;
      case M.ParcelPropertiesUpdate: {
        const p = data.parcel;
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = i32le(buf, pos, p.localId);
        pos = u32le(buf, pos, p.flags || 0xFFFFFFFF);
        pos = u32le(buf, pos, p.parcelFlags || 0);
        pos = i32le(buf, pos, 0);
        pos = writeVar1(buf, pos, p.name || '');
        pos = writeVar1(buf, pos, p.desc || '');
        pos = writeVar1(buf, pos, p.musicUrl || '');
        pos = writeVar1(buf, pos, p.mediaUrl || '');
        pos = new B.UUID(B.UUID.zero()).write(buf, pos);
        pos = u8(buf, pos, 0);
        pos = new B.UUID(B.UUID.zero()).write(buf, pos);
        pos = i32le(buf, pos, 0);
        pos = f32le(buf, pos, 0);
        pos = u8(buf, pos, 0);
        pos = new B.UUID(B.UUID.zero()).write(buf, pos);
        pos = new B.UUID(B.UUID.zero()).write(buf, pos);
        pos = B.writeVec3(buf, pos, { x: 0, y: 0, z: 0 });
        pos = B.writeVec3(buf, pos, { x: 0, y: 0, z: 0 });
        pos = u8(buf, pos, 0);
        break;
      }
      case M.ParcelPropertiesRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = i32le(buf, pos, data.sequenceId !== undefined ? data.sequenceId : -50000);
        pos = f32le(buf, pos, data.west || 0);
        pos = f32le(buf, pos, data.south || 0);
        pos = f32le(buf, pos, data.east || 256);
        pos = f32le(buf, pos, data.north || 256);
        pos = u8(buf, pos, data.snapSelection ? 1 : 0);
        break;
      case M.ParcelPropertiesRequestByID:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = i32le(buf, pos, data.sequenceId !== undefined ? data.sequenceId : -50000);
        pos = i32le(buf, pos, data.localId || 0);
        break;
      case M.ParcelInfoRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.parcelId).write(buf, pos);
        break;
      case M.UUIDNameRequest: {
        const ids = data.ids || [];
        pos = u8(buf, pos, ids.length);
        ids.forEach(function (id) {
          pos = new B.UUID(id).write(buf, pos);
        });
        break;
      }
      case M.ScriptDialogReply: {
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.objectId).write(buf, pos);
        pos = i32le(buf, pos, data.chatChannel !== undefined ? data.chatChannel : 0);
        pos = i32le(buf, pos, data.buttonIndex !== undefined ? data.buttonIndex : 0);
        pos = writeVar1(buf, pos, data.buttonLabel || '');
        break;
      }
      case M.ScriptAnswerYes:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.taskId).write(buf, pos);
        pos = new B.UUID(data.itemId).write(buf, pos);
        pos = i32le(buf, pos, data.questions !== undefined ? data.questions : 0);
        break;
      case M.AcceptCallingCard:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.transactionId).write(buf, pos);
        pos = u8(buf, pos, 1);
        pos = new B.UUID(data.folderId || B.UUID.zero()).write(buf, pos);
        break;
      case M.DeclineCallingCard:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.transactionId).write(buf, pos);
        break;
      case M.OfferCallingCard:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.destId).write(buf, pos);
        pos = new B.UUID(data.transactionId).write(buf, pos);
        break;
      case M.AvatarPickerRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.queryId).write(buf, pos);
        pos = writeVar1(buf, pos, data.name || '');
        break;
      case M.AvatarPropertiesRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.avatarId).write(buf, pos);
        break;
      case M.GroupProfileRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.groupId).write(buf, pos);
        break;
      case M.ActivateGroup:
      case M.JoinGroupRequest:
      case M.LeaveGroupRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.groupId).write(buf, pos);
        break;
      case M.GroupRoleDataRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.groupId).write(buf, pos);
        pos = new B.UUID(data.requestId).write(buf, pos);
        break;
      case M.GroupTitlesRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.groupId).write(buf, pos);
        pos = new B.UUID(data.requestId).write(buf, pos);
        break;
      case M.GroupTitleUpdate:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.groupId).write(buf, pos);
        pos = new B.UUID(data.titleRoleId || B.UUID.zero().toString()).write(buf, pos);
        break;
      case M.ClassifiedInfoRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.classifiedId).write(buf, pos);
        break;
      case M.AvatarNotesUpdate:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.targetId).write(buf, pos);
        pos = writeVar2(buf, pos, data.notes || '');
        break;
      case M.TerminateFriendship:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.otherId).write(buf, pos);
        break;
      case M.GenericMessage: {
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.transactionId || B.UUID.zero()).write(buf, pos);
        pos = writeVar1(buf, pos, data.method || '');
        pos = new B.UUID(data.invoice || B.UUID.zero()).write(buf, pos);
        const params = data.params || [];
        pos = u8(buf, pos, params.length);
        params.forEach(function (param) {
          pos = writeVar1(buf, pos, param || '');
        });
        break;
      }
      case M.DirFindQuery:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.queryId).write(buf, pos);
        pos = writeVar1(buf, pos, data.queryText || '');
        pos = u32le(buf, pos, data.queryFlags !== undefined ? data.queryFlags : 0);
        pos = i32le(buf, pos, data.queryStart !== undefined ? data.queryStart : 0);
        break;
      case M.DirPlacesQuery:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.queryId).write(buf, pos);
        pos = writeVar1(buf, pos, data.queryText || '');
        pos = u32le(buf, pos, data.queryFlags !== undefined ? data.queryFlags : 0);
        buf[pos++] = data.category !== undefined ? (data.category & 0xFF) : 0xFF;
        pos = writeVar1(buf, pos, data.simName || '');
        pos = i32le(buf, pos, data.queryStart !== undefined ? data.queryStart : 0);
        break;
      case M.MoneyTransferRequest:
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = new B.UUID(data.sourceId || agent).write(buf, pos);
        pos = new B.UUID(data.destId).write(buf, pos);
        pos = u8(buf, pos, data.flags !== undefined ? data.flags : 0);
        pos = i32le(buf, pos, data.amount !== undefined ? data.amount : 0);
        pos = u8(buf, pos, 0);
        pos = u8(buf, pos, 0);
        pos = i32le(buf, pos, data.transactionType !== undefined ? data.transactionType : 5001);
        pos = writeVar1(buf, pos, data.description || '');
        break;
      case M.PacketAck: {
        const acks = data.ackIds || (data.ackId !== undefined ? [data.ackId] : []);
        pos = u8(buf, pos, acks.length);
        for (let i = 0; i < acks.length; i++) {
          pos = u32le(buf, pos, acks[i]);
        }
        break;
      }
      case M.StartPingCheck:
        pos = u8(buf, pos, data.pingId & 0xFF);
        pos = u32le(buf, pos, data.oldestUnacked || 0);
        break;
      case M.CompletePingCheck:
        pos = u8(buf, pos, data.pingId & 0xFF);
        break;
      case M.AgentUpdate: {
        const cam = data.camera || B.cameraAxes(data.lookAt);
        pos = new B.UUID(agent).write(buf, pos);
        pos = new B.UUID(session).write(buf, pos);
        pos = B.writeQuat(buf, pos, data.bodyRotation);
        pos = B.writeQuat(buf, pos, data.headRotation);
        pos = u8(buf, pos, data.state || 0);
        pos = B.writeVec3(buf, pos, data.cameraCenter || data.position || { x: 128, y: 128, z: 25 });
        pos = B.writeVec3(buf, pos, cam.at);
        pos = B.writeVec3(buf, pos, cam.left);
        pos = B.writeVec3(buf, pos, cam.up);
        pos = f32le(buf, pos, data.drawDistance || 128);
        pos = u32le(buf, pos, data.controlFlags || 0);
        pos = u8(buf, pos, data.flags || 0);
        break;
      }
      default:
        return new Uint8Array(0);
    }
    return buf.subarray(0, pos);
  }

  function readIpPort(buf, pos) {
    const port = (buf[pos] << 8) | buf[pos + 1];
    return { port: port, pos: pos + 2 };
  }

  function parseTeleportFinish(buf, pos) {
    try {
      pos += 16; // AgentID
      pos += 4; // LocationID
      const simIp = readIpAddr(buf, pos);
      pos = simIp.pos;
      const simPort = readIpPort(buf, pos);
      pos = simPort.pos;
      const handle = readU64le(buf, pos);
      pos = handle.pos;
      const seed = readVar2(buf, pos);
      pos = seed.pos;
      if (pos < buf.length) pos += 1; // SimAccess
      let teleportFlags = 0;
      if (pos + 4 <= buf.length) {
        teleportFlags = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
        pos += 4;
      }
      return {
        seedCapability: seed.text,
        simIp: simIp.ip,
        simPort: simPort.port,
        regionHandle: handle.value,
        teleportFlags: teleportFlags
      };
    } catch (_e) {
      return { seedCapability: '' };
    }
  }

  function parseTeleportLocal(buf, pos) {
    try {
      pos += 16; // AgentID
      pos += 4; // LocationID
      const p = B.readVec3(buf, pos);
      pos = p.pos;
      const look = B.readVec3(buf, pos);
      pos = look.pos;
      let teleportFlags = 0;
      if (pos + 4 <= buf.length) {
        teleportFlags = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
      }
      return {
        position: { x: p.x, y: p.y, z: p.z },
        lookAt: { x: look.x, y: look.y, z: look.z },
        teleportFlags: teleportFlags
      };
    } catch (_e) {
      return null;
    }
  }

  function parseTeleportStart(buf, pos) {
    try {
      const teleportFlags = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
      return { teleportFlags: teleportFlags };
    } catch (_e) {
      return { teleportFlags: 0 };
    }
  }

  function messageTemplateNum(msgId) {
    const id = msgId >>> 0;
    if (id >= 0xFFFF0000) return id & 0xFFFF;
    if ((id & 0xFF00) === 0xFF00) return id & 0xFF;
    return id;
  }

  const TELEPORT_DEBUG_IDS = new Set([7, 64, 66, 67, 68, 69, 73, 74, 151]);

  const TELEPORT_DEBUG_SKIP_NAMES = new Set([
    'CoarseLocationUpdate',
    'StartPingCheck',
    'CompletePingCheck',
    'PacketAck',
    'AgentDataUpdate',
    'AgentUpdate',
    'ParcelProperties',
    'ObjectUpdate',
    'ObjectUpdateCompressed',
    'ObjectUpdateCached',
    'ImprovedTerseObjectUpdate',
    'KillObject',
    'ImageData',
    'ImagePacket',
    'LayerData',
    'AvatarAnimation',
    'ObjectAnimation',
    'SoundTrigger',
    'SimStats',
    'EconomyData',
    'AttachedSound',
    'PreloadSound',
    'CameraConstraint',
    'SimulatorViewerTimeMessage',
    'MapItemReply',
    'AvatarAppearance',
    'AgentMovementComplete',
    'ConfirmEnableSimulator',
    'ObjectProperties',
    'ObjectPropertiesFamily',
    'AttachedSound',
    'AttachedSoundGainChange',
    'ViewerEffect',
    'NameValuePair',
    'RemoveNameValuePair',
    'ParcelOverlay',
    'ReplyTaskInventory',
    'ScriptRunningReply',
    'AgentWearablesUpdate',
    'RegionInfo'
  ]);

  const SILENT_PACKET_NAMES = new Set([
    'CompletePingCheck',
    'PacketAck',
    'AgentUpdate',
    'SimulatorViewerTimeMessage',
    'DisableSimulator',
    'DataHomeLocationRequest',
    'DataHomeLocationReply',
    'ConfirmEnableSimulator',
    'ScriptControlChange',
    'MeanCollisionAlert',
    'HealthMessage',
    'MapLayerReply',
    'AgentGroupDataUpdate',
    'MoneyBalanceReply',
    'NeighborList',
    'AgentAnimation',
    'ImageData',
    'ImagePacket',
    'LayerData',
    'ObjectUpdate',
    'ObjectUpdateCompressed',
    'ObjectUpdateCached',
    'ImprovedTerseObjectUpdate',
    'KillObject',
    'AvatarAnimation',
    'SoundTrigger',
    'ObjectAnimation',
    'MultipleObjectUpdate',
    'PreloadSound',
    'EconomyData',
    'ImageNotInDatabase',
    'RebakeAvatarTextures',
    'SimStats',
    'AvatarAppearance',
    'ObjectProperties',
    'ObjectPropertiesFamily',
    'AttachedSound',
    'AttachedSoundGainChange',
    'ViewerEffect',
    'NameValuePair',
    'RemoveNameValuePair',
    'ParcelOverlay',
    'ReplyTaskInventory',
    'ScriptRunningReply',
    'AgentWearablesUpdate',
    'RegionInfo',
    'TelehubInfo',
    'PayPriceReply',
    'FindAgent',
    'UpdateCreateInventoryItem',
    'MoveInventoryItem',
    'RemoveInventoryItem',
    'SaveAssetIntoInventory',
    'RemoveInventoryFolder',
    'InventoryDescendents',
    'FetchInventoryReply',
    'BulkUpdateInventory',
    'RemoveInventoryObjects',
    'TerminateFriendship',
    'ChangeUserRights',
    'ParcelMediaCommandMessage',
    'ParcelMediaUpdate',
    'GenericStreamingMessage',
    'LargeGenericMessage',
    'AvatarSitResponse',
    'ForceObjectSelect',
    'DerezContainer',
    'DeRezAck',
    'GrantGodlikePowers',
    'EstateCovenantReply',
    'ParcelAccessListReply',
    'ParcelDwellReply',
    'AgentCachedTextureResponse',
    'AgentDropGroup',
    'InitiateDownload',
    'LandStatReply',
    'AcceptCallingCard',
    'DeclineCallingCard'
  ]);

  function isSilentInboundName(name) {
    if (!name) return false;
    if (SILENT_PACKET_NAMES.has(name)) return true;
    if (/^(Low|Medium|High)_\d+$/.test(name)) return true;
    return false;
  }

  function isTeleportDebugInteresting(msgId, name) {
    if (name && TELEPORT_DEBUG_SKIP_NAMES.has(name)) {
      return false;
    }
    if (name && /^(Low|Medium|High)_\d+$/.test(name)) {
      return false;
    }
    if (name && name !== 'Unknown' && name !== 'decode-fail' && name !== 'decode-fail-short') {
      return true;
    }
    return TELEPORT_DEBUG_IDS.has(messageTemplateNum(msgId));
  }

  function parseCrossedRegion(buf, pos) {
    try {
      pos += 16; // AgentID
      pos += 16; // SessionID
      const simIp = readIpAddr(buf, pos);
      pos = simIp.pos;
      const simPort = readIpPort(buf, pos);
      pos = simPort.pos;
      const handle = readU64le(buf, pos);
      pos = handle.pos;
      const seed = readVar2(buf, pos);
      pos = seed.pos;
      const p = B.readVec3(buf, pos);
      pos = p.pos;
      const look = B.readVec3(buf, pos);
      return {
        seedCapability: seed.text,
        simIp: simIp.ip,
        simPort: simPort.port,
        regionHandle: handle.value,
        position: { x: p.x, y: p.y, z: p.z },
        lookAt: { x: look.x, y: look.y, z: look.z }
      };
    } catch (_e) {
      return null;
    }
  }

  function parseEnableSimulator(buf, pos) {
    try {
      const handle = readU64le(buf, pos);
      pos = handle.pos;
      const simIp = readIpAddr(buf, pos);
      pos = simIp.pos;
      const simPort = readIpPort(buf, pos);
      return {
        regionHandle: handle.value,
        simIp: simIp.ip,
        simPort: simPort.port
      };
    } catch (_e) {
      return null;
    }
  }

  function sniffMessageId(buf) {
    if (!buf || buf.length < 7) return 0;
    try {
      const extra = buf[5] || 0;
      const bodyPos = 6 + extra;
      if (bodyPos + 2 > buf.length) return 0;
      const mid = B.readMessageId(buf, bodyPos);
      return mid.id || 0;
    } catch (_e) {
      return 0;
    }
  }

  function parseTeleportProgress(buf, pos) {
    try {
      pos += 16; // AgentID
      const teleportFlags = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
      pos += 4;
      const message = readVar1(buf, pos);
      return { teleportFlags: teleportFlags, message: message.text || '' };
    } catch (_e) {
      return { teleportFlags: 0, message: '' };
    }
  }

  function parseMapBlockReply(buf, pos) {
    const blocks = [];
    try {
      pos += 16; // AgentID
      pos += 4; // Flags
      if (pos >= buf.length) return blocks;
      const count = buf[pos++];
      for (let i = 0; i < count && pos < buf.length; i++) {
        if (pos + 4 > buf.length) break;
        const gridX = buf[pos] | (buf[pos + 1] << 8);
        pos += 2;
        const gridY = buf[pos] | (buf[pos + 1] << 8);
        pos += 2;
        const name = readVar1(buf, pos);
        pos = name.pos;
        if (pos + 23 > buf.length) break;
        const access = buf[pos++];
        const regionFlags = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
        pos += 4;
        pos += 1; // water height
        const agents = buf[pos++];
        pos += 16; // map image id
        blocks.push({
          gridX: gridX,
          gridY: gridY,
          name: name.text,
          access: access,
          regionFlags: regionFlags,
          agents: agents
        });
      }
      if (pos < buf.length) {
        const sizeCount = buf[pos++];
        for (let s = 0; s < sizeCount && pos + 4 <= buf.length; s++) {
          pos += 4; // SizeX + SizeY
        }
      }
    } catch (_e) { /* partial ok */ }
    return blocks;
  }

  function parseMapItemReply(buf, pos) {
    const items = [];
    let itemType = 0;
    try {
      pos += 16; // AgentID
      pos += 4; // Flags
      if (pos + 4 > buf.length) return { itemType: 0, items: [] };
      itemType = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
      pos += 4;
      if (pos >= buf.length) return { itemType: itemType, items: [] };
      const count = buf[pos++];
      for (let i = 0; i < count && pos < buf.length; i++) {
        if (pos + 36 > buf.length) break;
        const x = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
        pos += 4;
        const y = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
        pos += 4;
        const id = new B.UUID(buf.subarray(pos, pos + 16)).toString();
        pos += 16;
        const extra = new DataView(buf.buffer, buf.byteOffset + pos, 4).getInt32(0, true);
        pos += 4;
        const extra2 = new DataView(buf.buffer, buf.byteOffset + pos, 4).getInt32(0, true);
        pos += 4;
        const name = readVar1(buf, pos);
        pos = name.pos;
        items.push({ x: x, y: y, id: id, extra: extra, extra2: extra2, name: name.text });
      }
    } catch (_e) { /* partial ok */ }
    return { itemType: itemType, items: items };
  }

  function parseAlertMessage(buf, pos) {
    try {
      const message = readVar1(buf, pos);
      return { message: message.text || '' };
    } catch (_e) {
      return { message: '' };
    }
  }

  function parseAgentAlertMessage(buf, pos) {
    try {
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const modal = buf[pos++] !== 0;
      const message = readVar1(buf, pos);
      return { agentId: agentId, modal: modal, message: message.text || '' };
    } catch (_e) {
      return null;
    }
  }

  function parseViewerFrozenMessage(buf, pos) {
    try {
      return { frozen: buf[pos] !== 0 };
    } catch (_e) {
      return { frozen: false };
    }
  }

  function parseScriptQuestion(buf, pos) {
    try {
      const taskId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const itemId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const objectName = readVar1(buf, pos);
      pos = objectName.pos;
      const objectOwner = readVar1(buf, pos);
      pos = objectOwner.pos;
      const questions = new DataView(buf.buffer, buf.byteOffset + pos, 4).getInt32(0, true);
      return {
        taskId: taskId,
        itemId: itemId,
        objectName: objectName.text || '',
        objectOwner: objectOwner.text || '',
        questions: questions
      };
    } catch (_e) {
      return null;
    }
  }

  const TEXTBOX_MAGIC = '!!llTextBox!!';

  function parseScriptDialog(buf, pos) {
    try {
      const objectId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const firstName = readVar1(buf, pos);
      pos = firstName.pos;
      const lastName = readVar1(buf, pos);
      pos = lastName.pos;
      const objectName = readVar1(buf, pos);
      pos = objectName.pos;
      const message = readVar2(buf, pos);
      pos = message.pos;
      const chatChannel = new DataView(buf.buffer, buf.byteOffset + pos, 4).getInt32(0, true);
      pos += 4;
      pos += 16; // ImageID
      const rawButtons = [];
      if (pos < buf.length) {
        const count = buf[pos++];
        for (let i = 0; i < count && pos < buf.length; i++) {
          const label = readVar1(buf, pos);
          pos = label.pos;
          if (label.text) rawButtons.push(label.text);
        }
      }
      const isTextBox = rawButtons.indexOf(TEXTBOX_MAGIC) >= 0;
      const buttons = rawButtons.filter(function (label) {
        return label !== TEXTBOX_MAGIC;
      });
      const ownerFirst = firstName.text || '';
      const ownerLast = lastName.text || '';
      return {
        objectId: objectId,
        objectName: objectName.text || '',
        ownerName: ownerFirst ? (ownerFirst + ' ' + ownerLast).trim() : ownerLast,
        isGroup: !ownerFirst && !!ownerLast,
        message: message.text || '',
        chatChannel: chatChannel,
        buttons: buttons,
        isTextBox: isTextBox
      };
    } catch (_e) {
      return null;
    }
  }

  function parseRegionHandshake(buf, pos) {
    pos += 4; // RegionFlags
    pos += 1; // SimAccess
    const simName = readVar1(buf, pos);
    pos = simName.pos;
    pos += 16; // SimOwner
    pos += 1; // IsEstateManager
    pos += 8; // WaterHeight, BillableFactor
    pos += 16; // CacheID
    pos += 64; // TerrainBase0-3
    pos += 64; // TerrainDetail0-3
    pos += 16; // TerrainStartHeights
    pos += 16; // TerrainHeightRanges
    const regionId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
    return { regionName: simName.text, regionId: regionId };
  }

  function parseFeatureDisabled(buf, pos) {
    try {
      const text = readVar1(buf, pos);
      return { message: text.text || '' };
    } catch (_e) {
      return { message: '' };
    }
  }

  function parseLoadURL(buf, pos) {
    try {
      const objectName = readVar1(buf, pos);
      pos = objectName.pos;
      if (pos + 33 > buf.length) return null;
      const objectId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const ownerId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const ownerIsGroup = buf[pos++] !== 0;
      const message = readVar1(buf, pos);
      pos = message.pos;
      const url = readVar1(buf, pos);
      return {
        objectName: objectName.text || '',
        objectId: objectId,
        ownerId: ownerId,
        ownerIsGroup: ownerIsGroup,
        message: message.text || '',
        url: url.text || ''
      };
    } catch (_e) {
      return null;
    }
  }

  function parseScriptTeleportRequest(buf, pos) {
    try {
      const objectName = readVar1(buf, pos);
      pos = objectName.pos;
      const simName = readVar1(buf, pos);
      pos = simName.pos;
      const position = B.readVec3(buf, pos);
      pos = position.pos;
      const lookAt = B.readVec3(buf, pos);
      pos = lookAt.pos;
      let flags = 0;
      if (pos < buf.length) {
        const count = buf[pos++];
        if (count > 0 && pos + 4 <= buf.length) {
          flags = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
        }
      }
      return {
        objectName: objectName.text || '',
        regionName: simName.text || '',
        position: { x: position.x, y: position.y, z: position.z },
        lookAt: { x: lookAt.x, y: lookAt.y, z: lookAt.z },
        flags: flags
      };
    } catch (_e) {
      return null;
    }
  }

  function parseOfferCallingCard(buf, pos) {
    try {
      if (pos + 64 > buf.length) return null;
      const sourceId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 32; // AgentID + SessionID
      const destId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const transactionId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      return { sourceId: sourceId, destId: destId, transactionId: transactionId };
    } catch (_e) {
      return null;
    }
  }

  function parseAvatarPickerReply(buf, pos) {
    try {
      if (pos + 32 > buf.length) return null;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const queryId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const avatars = [];
      if (pos < buf.length) {
        const count = buf[pos++];
        for (let i = 0; i < count && pos + 16 <= buf.length; i++) {
          const avatarId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
          const first = readVar1(buf, pos);
          pos = first.pos;
          const last = readVar1(buf, pos);
          pos = last.pos;
          avatars.push({
            id: avatarId,
            firstName: first.text || '',
            lastName: last.text || ''
          });
        }
      }
      return { agentId: agentId, queryId: queryId, avatars: avatars };
    } catch (_e) {
      return null;
    }
  }

  function parseDirPeopleReply(buf, pos) {
    try {
      if (pos + 32 > buf.length) return null;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const queryId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const people = [];
      if (pos < buf.length) {
        const count = buf[pos++];
        for (let i = 0; i < count && pos + 16 <= buf.length; i++) {
          const personId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
          const first = readVar1(buf, pos);
          pos = first.pos;
          const last = readVar1(buf, pos);
          pos = last.pos;
          const group = readVar1(buf, pos);
          pos = group.pos;
          if (pos + 5 > buf.length) break;
          const online = buf[pos++] !== 0;
          const reputation = new DataView(buf.buffer, buf.byteOffset + pos, 4).getInt32(0, true);
          pos += 4;
          people.push({
            id: personId,
            firstName: first.text || '',
            lastName: last.text || '',
            group: group.text || '',
            online: online,
            reputation: reputation
          });
        }
      }
      return { agentId: agentId, queryId: queryId, people: people };
    } catch (_e) {
      return null;
    }
  }

  function parseDirPlacesReply(buf, pos) {
    try {
      if (pos + 16 > buf.length) return null;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      let queryId = '';
      if (pos < buf.length) {
        const qCount = buf[pos++];
        if (qCount > 0 && pos + 16 <= buf.length) {
          queryId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
        }
      }
      const places = [];
      if (pos < buf.length) {
        const count = buf[pos++];
        for (let i = 0; i < count && pos + 18 <= buf.length; i++) {
          const parcelId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
          const name = readVar1(buf, pos);
          pos = name.pos;
          if (pos + 6 > buf.length) break;
          const forSale = buf[pos++] === 1;
          const auction = buf[pos++] === 1;
          const dwell = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true);
          pos += 4;
          places.push({
            parcelId: parcelId,
            name: name.text || '',
            forSale: forSale,
            auction: auction,
            dwell: dwell
          });
        }
      }
      const statuses = [];
      if (pos < buf.length) {
        const sCount = buf[pos++];
        for (let i = 0; i < sCount && pos + 4 <= buf.length; i++) {
          statuses.push(new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true));
          pos += 4;
        }
      }
      return { agentId: agentId, queryId: queryId, places: places, statuses: statuses };
    } catch (_e) {
      return null;
    }
  }

  function parseDirGroupsReply(buf, pos) {
    try {
      if (pos + 32 > buf.length) return null;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const queryId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const groups = [];
      if (pos < buf.length) {
        const count = buf[pos++];
        for (let i = 0; i < count && pos + 20 <= buf.length; i++) {
          const groupId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
          const name = readVar1(buf, pos);
          pos = name.pos;
          if (pos + 8 > buf.length) break;
          const members = new DataView(buf.buffer, buf.byteOffset + pos, 4).getInt32(0, true);
          pos += 4;
          const searchOrder = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true);
          pos += 4;
          groups.push({
            id: groupId,
            name: name.text || '',
            members: members,
            searchOrder: searchOrder
          });
        }
      }
      const statuses = [];
      if (pos < buf.length) {
        const sCount = buf[pos++];
        for (let i = 0; i < sCount && pos + 4 <= buf.length; i++) {
          statuses.push(new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true));
          pos += 4;
        }
      }
      return { agentId: agentId, queryId: queryId, groups: groups, statuses: statuses };
    } catch (_e) {
      return null;
    }
  }

  function parseGenericMessage(buf, pos) {
    try {
      if (pos + 32 > buf.length) return null;
      pos += 32; // AgentID + SessionID + TransactionID
      const method = readVar1(buf, pos);
      pos = method.pos;
      pos += 16; // Invoice UUID
      const params = [];
      if (pos < buf.length) {
        const count = buf[pos++];
        for (let i = 0; i < count && pos < buf.length; i++) {
          const p = readVar1(buf, pos);
          pos = p.pos;
          params.push(p.text || '');
        }
      }
      return { method: method.text || '', params: params };
    } catch (_e) {
      return null;
    }
  }

  function parseAvatarPropertiesReply(buf, pos) {
    try {
      if (pos + 32 > buf.length) return null;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const avatarId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      if (pos + 48 > buf.length) return null;
      const imageId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const flImageId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const partnerId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const about = readVar2(buf, pos);
      pos = about.pos;
      const flAbout = readVar1(buf, pos);
      pos = flAbout.pos;
      const bornOn = readVar1(buf, pos);
      pos = bornOn.pos;
      const profileUrl = readVar1(buf, pos);
      pos = profileUrl.pos;
      const charterMember = readVar1(buf, pos);
      pos = charterMember.pos;
      let flags = 0;
      if (pos + 4 <= buf.length) {
        flags = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
      }
      return {
        agentId: agentId,
        avatarId: avatarId,
        imageId: imageId,
        flImageId: flImageId,
        partnerId: partnerId,
        about: about.text || '',
        flAbout: flAbout.text || '',
        bornOn: bornOn.text || '',
        profileUrl: profileUrl.text || '',
        charterMember: charterMember.text || '',
        flags: flags
      };
    } catch (_e) {
      return null;
    }
  }

  function parseGroupProfileReply(buf, pos) {
    try {
      if (pos + 16 > buf.length) return null;
      pos += 16; // AgentID
      if (pos + 16 > buf.length) return null;
      const groupId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const name = readVar1(buf, pos);
      pos = name.pos;
      const charter = readVar2(buf, pos);
      pos = charter.pos;
      if (pos >= buf.length) return null;
      const showInList = buf[pos++] !== 0;
      const memberTitle = readVar1(buf, pos);
      pos = memberTitle.pos;
      const powers = readU64le(buf, pos);
      pos = powers.pos;
      if (pos + 16 > buf.length) return null;
      const insigniaId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const founderId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const dv = function (p) {
        return new DataView(buf.buffer, buf.byteOffset + p, 4);
      };
      if (pos + 20 > buf.length) return null;
      const membershipFee = dv(pos).getInt32(0, true);
      pos += 4;
      const openEnrollment = buf[pos++] !== 0;
      const money = dv(pos).getInt32(0, true);
      pos += 4;
      const memberCount = dv(pos).getInt32(0, true);
      pos += 4;
      const rolesCount = dv(pos).getInt32(0, true);
      pos += 4;
      if (pos + 2 > buf.length) return null;
      const allowPublish = buf[pos++] !== 0;
      const maturePublish = buf[pos++] !== 0;
      let ownerRole = '';
      if (pos + 16 <= buf.length) {
        ownerRole = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      }
      return {
        groupId: groupId,
        name: name.text || '',
        charter: charter.text || '',
        showInList: showInList,
        memberTitle: memberTitle.text || '',
        powersMask: powers.value,
        insigniaId: insigniaId,
        founderId: founderId,
        membershipFee: membershipFee,
        openEnrollment: openEnrollment,
        money: money,
        memberCount: memberCount,
        rolesCount: rolesCount,
        allowPublish: allowPublish,
        maturePublish: maturePublish,
        ownerRole: ownerRole
      };
    } catch (_e) {
      return null;
    }
  }

  function parseAgentGroupDataUpdate(buf, pos) {
    try {
      if (pos + 16 > buf.length) return null;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const groups = [];
      if (pos < buf.length) {
        const count = buf[pos++];
        for (let i = 0; i < count && pos + 16 <= buf.length; i++) {
          const groupId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
          const powers = readU64le(buf, pos);
          pos = powers.pos;
          if (pos >= buf.length) break;
          const acceptNotices = buf[pos++] !== 0;
          if (pos + 16 > buf.length) break;
          const insigniaId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
          if (pos + 4 > buf.length) break;
          const contribution = new DataView(buf.buffer, buf.byteOffset + pos, 4).getInt32(0, true);
          pos += 4;
          const groupName = readVar1(buf, pos);
          pos = groupName.pos;
          groups.push({
            id: groupId,
            name: groupName.text || '',
            insigniaId: insigniaId,
            powers: powers.value,
            acceptNotices: acceptNotices,
            contribution: contribution
          });
        }
      }
      return { agentId: agentId, groups: groups };
    } catch (_e) {
      return null;
    }
  }

  function parseGroupMembershipReply(buf, pos) {
    try {
      if (pos + 16 > buf.length) return null;
      pos += 16; // AgentData.AgentID
      if (pos + 16 > buf.length) return null;
      const groupId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      if (pos >= buf.length) return { groupId: groupId, success: false };
      const success = buf[pos++] !== 0;
      return { groupId: groupId, success: success };
    } catch (_e) {
      return null;
    }
  }

  function parseAvatarGroupsReply(buf, pos) {
    try {
      if (pos + 32 > buf.length) return null;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const avatarId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const groups = [];
      if (pos < buf.length) {
        const count = buf[pos++];
        for (let i = 0; i < count && pos + 8 <= buf.length; i++) {
          const powers = readU64le(buf, pos);
          pos = powers.pos;
          if (pos >= buf.length) break;
          const acceptNotices = buf[pos++] !== 0;
          const groupTitle = readVar1(buf, pos);
          pos = groupTitle.pos;
          if (pos + 16 > buf.length) break;
          const groupId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
          const groupName = readVar1(buf, pos);
          pos = groupName.pos;
          if (pos + 16 > buf.length) break;
          const insigniaId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
          groups.push({
            id: groupId,
            name: groupName.text || '',
            title: groupTitle.text || '',
            insigniaId: insigniaId,
            powers: powers.value,
            acceptNotices: acceptNotices
          });
        }
        for (let i = 0; i < groups.length && pos < buf.length; i++) {
          groups[i].listInProfile = buf[pos++] !== 0;
        }
      }
      return { agentId: agentId, avatarId: avatarId, groups: groups };
    } catch (_e) {
      return null;
    }
  }

  function parseAvatarPicksReply(buf, pos) {
    try {
      if (pos + 32 > buf.length) return null;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const avatarId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const picks = [];
      if (pos < buf.length) {
        const count = buf[pos++];
        for (let i = 0; i < count && pos + 16 <= buf.length; i++) {
          const pickId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
          const pickName = readVar1(buf, pos);
          pos = pickName.pos;
          picks.push({ id: pickId, name: pickName.text || '' });
        }
      }
      return { agentId: agentId, avatarId: avatarId, picks: picks };
    } catch (_e) {
      return null;
    }
  }

  function parseAvatarNotesReply(buf, pos) {
    try {
      if (pos + 16 > buf.length) return null;
      pos += 16; // AgentID
      if (pos + 16 > buf.length) return null;
      const targetId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const notes = readVar2(buf, pos);
      return { targetId: targetId, notes: notes.text || '' };
    } catch (_e) {
      return null;
    }
  }

  function parseAvatarClassifiedReply(buf, pos) {
    try {
      if (pos + 32 > buf.length) return null;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const avatarId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const classifieds = [];
      if (pos < buf.length) {
        const count = buf[pos++];
        for (let i = 0; i < count && pos + 16 <= buf.length; i++) {
          const classifiedId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
          const classifiedName = readVar1(buf, pos);
          pos = classifiedName.pos;
          classifieds.push({ id: classifiedId, name: classifiedName.text || '' });
        }
      }
      return { agentId: agentId, avatarId: avatarId, classifieds: classifieds };
    } catch (_e) {
      return null;
    }
  }

  function parsePickInfoReply(buf, pos) {
    try {
      if (pos + 16 > buf.length) return null;
      pos += 16; // AgentID
      if (pos + 16 > buf.length) return null;
      const pickId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      if (pos + 16 > buf.length) return null;
      const creatorId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const topPick = pos < buf.length ? buf[pos++] !== 0 : false;
      if (pos + 16 > buf.length) return null;
      const parcelId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const name = readVar1(buf, pos);
      pos = name.pos;
      const desc = readVar2(buf, pos);
      pos = desc.pos;
      if (pos + 16 > buf.length) return null;
      const snapshotId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const user = readVar1(buf, pos);
      pos = user.pos;
      const originalName = readVar1(buf, pos);
      pos = originalName.pos;
      const simName = readVar1(buf, pos);
      pos = simName.pos;
      const posGlobal = readVector3d(buf, pos);
      pos = posGlobal.pos;
      const sortOrder = readI32le(buf, pos);
      pos = sortOrder.pos;
      const enabled = pos < buf.length ? buf[pos++] !== 0 : true;
      return {
        pickId: pickId,
        creatorId: creatorId,
        topPick: topPick,
        parcelId: parcelId,
        name: name.text || '',
        description: desc.text || '',
        snapshotId: snapshotId,
        userName: user.text || '',
        originalName: originalName.text || '',
        simName: simName.text || '',
        posGlobal: { x: posGlobal.x, y: posGlobal.y, z: posGlobal.z },
        sortOrder: sortOrder.value,
        enabled: enabled,
        location: formatProfileLocation(simName.text || '', posGlobal)
      };
    } catch (_e) {
      return null;
    }
  }

  function parseClassifiedInfoReply(buf, pos) {
    try {
      if (pos + 16 > buf.length) return null;
      pos += 16; // AgentID
      if (pos + 16 > buf.length) return null;
      const classifiedId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      if (pos + 16 > buf.length) return null;
      const creatorId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const creationDate = readU32le(buf, pos);
      pos = creationDate.pos;
      const expirationDate = readU32le(buf, pos);
      pos = expirationDate.pos;
      const category = readU32le(buf, pos);
      pos = category.pos;
      const name = readVar1(buf, pos);
      pos = name.pos;
      const desc = readVar2(buf, pos);
      pos = desc.pos;
      if (pos + 16 > buf.length) return null;
      const parcelId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const parentEstate = readU32le(buf, pos);
      pos = parentEstate.pos;
      if (pos + 16 > buf.length) return null;
      const snapshotId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const simName = readVar1(buf, pos);
      pos = simName.pos;
      const posGlobal = readVector3d(buf, pos);
      pos = posGlobal.pos;
      const parcelName = readVar1(buf, pos);
      pos = parcelName.pos;
      const flags = pos < buf.length ? buf[pos++] : 0;
      const price = readI32le(buf, pos);
      return {
        classifiedId: classifiedId,
        creatorId: creatorId,
        creationDate: creationDate.value,
        expirationDate: expirationDate.value,
        category: category.value,
        name: name.text || '',
        description: desc.text || '',
        parcelId: parcelId,
        parentEstate: parentEstate.value,
        snapshotId: snapshotId,
        simName: simName.text || '',
        posGlobal: { x: posGlobal.x, y: posGlobal.y, z: posGlobal.z },
        parcelName: parcelName.text || '',
        flags: flags,
        priceForListing: price.value,
        location: formatProfileLocation(simName.text || '', posGlobal)
      };
    } catch (_e) {
      return null;
    }
  }

  function parseMoneyBalanceReply(buf, pos) {
    try {
      if (pos + 45 > buf.length) return null;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const transactionId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const success = buf[pos++] !== 0;
      const balance = new DataView(buf.buffer, buf.byteOffset + pos, 4).getInt32(0, true);
      pos += 4;
      const credit = new DataView(buf.buffer, buf.byteOffset + pos, 4).getInt32(0, true);
      pos += 4;
      const committed = new DataView(buf.buffer, buf.byteOffset + pos, 4).getInt32(0, true);
      pos += 4;
      const desc = readVar1(buf, pos);
      pos = desc.pos;
      const out = {
        agentId: agentId,
        transactionId: transactionId,
        success: success,
        balance: balance,
        landCredit: credit,
        landCommitted: committed,
        description: desc.text || ''
      };
      if (pos + 4 <= buf.length) {
        out.transactionType = new DataView(buf.buffer, buf.byteOffset + pos, 4).getInt32(0, true);
      }
      return out;
    } catch (_e) {
      return null;
    }
  }

  function parseTerminateFriendship(buf, pos) {
    try {
      if (pos + 48 > buf.length) return null;
      pos += 32;
      const otherId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      return { otherId: otherId };
    } catch (_e) {
      return null;
    }
  }

  function parseParcelMediaUpdate(buf, pos) {
    try {
      const mediaUrl = readVar1(buf, pos);
      pos = mediaUrl.pos;
      if (pos + 17 > buf.length) return null;
      const mediaId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const autoScale = buf[pos++] !== 0;
      const out = {
        mediaUrl: mediaUrl.text || '',
        mediaId: mediaId,
        autoScale: autoScale
      };
      if (pos < buf.length) {
        const mediaType = readVar1(buf, pos);
        pos = mediaType.pos;
        const mediaDesc = readVar1(buf, pos);
        out.mediaType = mediaType.text || '';
        out.mediaDesc = mediaDesc.text || '';
      }
      return out;
    } catch (_e) {
      return null;
    }
  }

  function parseParcelInfoReply(buf, pos) {
    const out = {};
    try {
      if (buf.length - pos < 16) return out;
      pos += 16; // AgentID
      if (buf.length - pos < 32) return out;
      const parcelId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const ownerId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const name = readVar1(buf, pos);
      pos = name.pos;
      const desc = readVar1(buf, pos);
      pos = desc.pos;
      const dvAt = function (p) {
        return new DataView(buf.buffer, buf.byteOffset + p, 4);
      };
      if (buf.length - pos < 9) return out;
      const actualArea = dvAt(pos).getInt32(0, true);
      pos += 4;
      const billableArea = dvAt(pos).getInt32(0, true);
      pos += 4;
      const flags = buf[pos++];
      out.parcel = {
        parcelId: parcelId,
        ownerId: ownerId,
        name: name.text,
        desc: desc.text,
        area: actualArea || billableArea,
        infoFlags: flags,
        source: 'info'
      };
      if (buf.length - pos >= 12) {
        out.parcel.globalX = dvAt(pos).getFloat32(0, true);
        pos += 4;
        out.parcel.globalY = dvAt(pos).getFloat32(0, true);
        pos += 4;
        out.parcel.globalZ = dvAt(pos).getFloat32(0, true);
        pos += 4;
      }
      if (pos < buf.length) {
        const simName = readVar1(buf, pos);
        pos = simName.pos;
        if (simName.text) out.parcel.simName = simName.text;
      }
      if (pos + 16 <= buf.length) {
        const snapshotId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
        pos += 16;
        if (snapshotId !== '00000000-0000-0000-0000-000000000000') {
          out.parcel.snapshotId = snapshotId;
        }
      }
      if (pos + 4 <= buf.length) {
        out.parcel.dwell = dvAt(pos).getFloat32(0, true);
        pos += 4;
      }
      if (pos + 8 <= buf.length) {
        out.parcel.salePrice = dvAt(pos).getInt32(0, true);
        pos += 4;
        out.parcel.auctionId = dvAt(pos).getInt32(0, true);
        pos += 4;
      }
    } catch (_e) { /* partial parcel ok */ }
    return out;
  }

  function parseAgentDataUpdate(buf, pos) {
    try {
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const first = readVar1(buf, pos);
      pos = first.pos;
      const last = readVar1(buf, pos);
      pos = last.pos;
      const name = last.text === 'Resident' ? first.text : (first.text + ' ' + last.text);
      const update = { agentId: agentId, name: name.trim() };
      if (pos >= buf.length) return update;
      const groupTitle = readVar1(buf, pos);
      pos = groupTitle.pos;
      if (pos + 16 > buf.length) return update;
      const activeGroupId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      update.groupTitle = groupTitle.text || '';
      update.activeGroupId = activeGroupId;
      if (pos + 8 > buf.length) return update;
      const powers = readU64le(buf, pos);
      pos = powers.pos;
      update.groupPowers = powers.value;
      const groupName = readVar1(buf, pos);
      update.groupName = groupName.text || '';
      return update;
    } catch (_e) {
      return null;
    }
  }

  function parseGroupTitlesReply(buf, pos) {
    try {
      if (pos + 48 > buf.length) return null;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const groupId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const requestId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const titles = [];
      if (pos < buf.length) {
        const count = buf[pos++];
        for (let i = 0; i < count && pos + 17 <= buf.length; i++) {
          const title = readVar1(buf, pos);
          pos = title.pos;
          const roleId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
          if (pos >= buf.length) break;
          const selected = buf[pos++] !== 0;
          const label = String(title.text || '').trim();
          if (!label) continue;
          titles.push({
            title: label,
            roleId: roleId,
            selected: selected
          });
        }
      }
      return {
        agentId: agentId,
        groupId: groupId,
        requestId: requestId,
        titles: titles
      };
    } catch (_e) {
      return null;
    }
  }

  function parseGroupRoleDataReply(buf, pos) {
    try {
      if (pos + 16 > buf.length) return null;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      if (pos + 36 > buf.length) return null;
      const groupId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const requestId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const roleCount = new DataView(buf.buffer, buf.byteOffset + pos, 4).getInt32(0, true);
      pos += 4;
      const roles = [];
      if (pos < buf.length) {
        let blockCount = roleCount;
        if (buf[pos] === roleCount && roleCount > 0 && roleCount < 128) {
          blockCount = buf[pos++];
        }
        for (let i = 0; i < blockCount && pos + 16 <= buf.length; i++) {
          const roleId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
          pos += 16;
          const roleName = readVar1(buf, pos);
          pos = roleName.pos;
          const roleTitle = readVar1(buf, pos);
          pos = roleTitle.pos;
          const roleDesc = readVar2(buf, pos);
          pos = roleDesc.pos;
          if (pos + 12 > buf.length) break;
          const powers = readU64le(buf, pos);
          pos = powers.pos;
          const members = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
          pos += 4;
          roles.push({
            id: roleId,
            name: roleName.text || '',
            title: roleTitle.text || '',
            description: roleDesc.text || '',
            powers: powers.value,
            members: members
          });
        }
      }
      return {
        agentId: agentId,
        groupId: groupId,
        requestId: requestId,
        roleCount: roleCount,
        roles: roles
      };
    } catch (_e) {
      return null;
    }
  }

  function parseKickUser(buf, pos) {
    try {
      pos += 4;
      pos += 2;
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      pos += 16;
      const reason = readVar2(buf, pos);
      return { agentId: agentId, reason: reason.text || '' };
    } catch (_e) {
      return null;
    }
  }

  function parseKillChildAgents(buf, pos) {
    try {
      return { agentId: new B.UUID(buf.subarray(pos, pos + 16)).toString() };
    } catch (_e) {
      return null;
    }
  }

  function parseSystemKickUser(buf, pos) {
    const ids = [];
    try {
      while (pos + 16 <= buf.length) {
        ids.push(new B.UUID(buf.subarray(pos, pos + 16)).toString());
        pos += 16;
      }
    } catch (_e) { /* partial ok */ }
    return ids;
  }

  function parseAgentPresenceNotification(buf, pos) {
    const ids = [];
    try {
      if (pos >= buf.length) return ids;
      const count = buf[pos++];
      if (count > 0 && pos + (count * 16) <= buf.length) {
        for (let i = 0; i < count; i++) {
          ids.push(new B.UUID(buf.subarray(pos, pos + 16)).toString());
          pos += 16;
        }
        return ids;
      }
      pos -= 1;
      while (pos + 16 <= buf.length) {
        ids.push(new B.UUID(buf.subarray(pos, pos + 16)).toString());
        pos += 16;
      }
    } catch (_e) { /* partial ok */ }
    return ids;
  }

  function parseTeleportFailed(buf, pos) {
    try {
      const agentId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
      pos += 16;
      const reason = readVar1(buf, pos);
      return { agentId: agentId, reason: reason.text || 'Teleport failed' };
    } catch (_e) {
      return { reason: 'Teleport failed' };
    }
  }

  function parseImprovedInstantMessage(buf, pos) {
    const fromAgent = new B.UUID(buf.subarray(pos, pos + 16)).toString();
    pos += 16;
    pos += 16; // AgentData.SessionID - sender circuit session
    const fromGroup = buf[pos++] !== 0; // MessageBlock.FromGroup
    const toAgent = new B.UUID(buf.subarray(pos, pos + 16)).toString();
    pos += 16;
    pos += 4; // ParentEstateID
    pos += 16; // RegionID
    pos += 12; // Position
    const offline = buf[pos++];
    const dialog = buf[pos++];
    // MessageBlock.ID - the IM/session UUID (group or conference id for session dialogs)
    const imId = new B.UUID(buf.subarray(pos, pos + 16)).toString();
    pos += 16;
    const timestamp = readU32le(buf, pos);
    pos = timestamp.pos;
    const fromName = readVar1(buf, pos);
    pos = fromName.pos;
    const message = readVar2(buf, pos);
    pos = message.pos;
    const bucket = readVar2Bytes(buf, pos);
    return {
      fromAgentId: fromAgent,
      toAgentId: toAgent,
      fromGroup: fromGroup,
      fromName: fromName.text,
      text: message.text,
      dialog: dialog,
      offline: offline,
      imId: imId,
      timestamp: timestamp.value,
      binaryBucket: bucket.text || ''
    };
  }

  function parseUuidNameReply(buf, pos) {
    const names = [];
    try {
      if (pos >= buf.length) return names;
      const count = buf[pos++];
      for (let i = 0; i < count; i++) {
        if (pos + 16 > buf.length) break;
        const id = new B.UUID(buf.subarray(pos, pos + 16)).toString();
        pos += 16;
        const first = readVar1(buf, pos);
        pos = first.pos;
        const last = readVar1(buf, pos);
        pos = last.pos;
        const name = last.text === 'Resident' ? first.text : (first.text + ' ' + last.text);
        names.push({ id: id, name: name.trim() });
      }
    } catch (_e) { /* partial ok */ }
    return names;
  }

  function parseBody(msgId, buf, pos) {
    ensureMsgMeta(msgId);
    const out = { id: msgId, name: (MSG_META[msgId] || {}).name || 'Unknown' };
    try {
      switch (msgId) {
        case M.ChatFromSimulator: {
          const fromName = readVar1(buf, pos);
          pos = fromName.pos;
          const sourceId = new B.UUID(buf.subarray(pos, pos + 16)).toString(); pos += 16;
          pos += 16;
          const sourceType = buf[pos++];
          const chatType = buf[pos++];
          const audible = buf[pos++];
          const pos3 = B.readVec3(buf, pos); pos = pos3.pos;
          const message = readVar2(buf, pos);
          out.chat = {
            fromName: fromName.text,
            sourceId: sourceId,
            text: message.text,
            chatType: chatType,
            sourceType: sourceType,
            audible: audible
          };
          break;
        }
        case M.ImprovedInstantMessage: {
          out.im = parseImprovedInstantMessage(buf, pos);
          break;
        }
        case M.CoarseLocationUpdate: {
          const locCount = buf[pos++];
          const locations = [];
          for (let i = 0; i < locCount; i++) {
            locations.push({ x: buf[pos++], y: buf[pos++], z: buf[pos++] * 4 });
          }
          const dvIdx = new DataView(buf.buffer, buf.byteOffset + pos, 4);
          const youIndex = dvIdx.getInt16(0, true);
          const preyIndex = dvIdx.getInt16(2, true);
          pos += 4;
          const agentCount = buf[pos++];
          const agents = [];
          for (let j = 0; j < agentCount; j++) {
            agents.push(new B.UUID(buf.subarray(pos, pos + 16)).toString());
            pos += 16;
          }
          out.coarse = {
            locations: locations,
            agents: agents,
            youIndex: youIndex,
            preyIndex: preyIndex
          };
          break;
        }
        case M.RegionHandshake: {
          const region = parseRegionHandshake(buf, pos);
          out.regionName = region.regionName;
          out.regionId = region.regionId;
          break;
        }
        case M.CrossedRegion: {
          const crossed = parseCrossedRegion(buf, pos);
          if (crossed) out.crossedRegion = crossed;
          break;
        }
        case M.EnableSimulator: {
          const sim = parseEnableSimulator(buf, pos);
          if (sim) out.enableSimulator = sim;
          break;
        }
        case M.TeleportLocal: {
          const local = parseTeleportLocal(buf, pos);
          if (local) out.teleportLocal = local;
          break;
        }
        case M.TeleportProgress: {
          out.teleportProgress = parseTeleportProgress(buf, pos);
          break;
        }
        case M.TeleportStart: {
          out.teleportStart = parseTeleportStart(buf, pos);
          break;
        }
        case M.TeleportFinish: {
          const teleport = parseTeleportFinish(buf, pos);
          out.seedCapability = teleport.seedCapability;
          out.teleportFinish = teleport;
          break;
        }
        case M.MapBlockReply: {
          out.mapBlocks = parseMapBlockReply(buf, pos);
          break;
        }
        case M.MapItemReply: {
          out.mapItemReply = parseMapItemReply(buf, pos);
          break;
        }
        case M.TeleportFailed: {
          out.teleportFailed = parseTeleportFailed(buf, pos);
          break;
        }
        case M.KickUser: {
          out.kickUser = parseKickUser(buf, pos);
          break;
        }
        case M.KillChildAgents: {
          out.killChildAgents = parseKillChildAgents(buf, pos);
          break;
        }
        case M.SystemKickUser: {
          out.systemKickAgents = parseSystemKickUser(buf, pos);
          break;
        }
        case M.OnlineNotification:
        case M.OfflineNotification: {
          out.agentIds = parseAgentPresenceNotification(buf, pos);
          break;
        }
        case M.LogoutReply: {
          out.logoutReply = true;
          break;
        }
        case M.AgentMovementComplete: {
          pos += 32;
          const p = B.readVec3(buf, pos);
          pos = p.pos;
          const look = B.readVec3(buf, pos);
          out.position = { x: p.x, y: p.y, z: p.z };
          out.lookAt = { x: look.x, y: look.y, z: look.z };
          break;
        }
        case M.ParcelProperties: {
          const parcel = parseParcelProperties(buf, pos);
          if (parcel.parcel) out.parcel = parcel.parcel;
          if (parcel.debug) out.parcelDebug = parcel.debug;
          break;
        }
        case M.ParcelInfoReply: {
          const parcel = parseParcelInfoReply(buf, pos);
          if (parcel.parcel) out.parcel = parcel.parcel;
          break;
        }
        case M.AgentDataUpdate: {
          const agent = parseAgentDataUpdate(buf, pos);
          if (agent) out.agentUpdate = agent;
          break;
        }
        case M.UUIDNameReply: {
          out.uuidNames = parseUuidNameReply(buf, pos);
          break;
        }
        case M.AlertMessage: {
          out.alert = parseAlertMessage(buf, pos);
          break;
        }
        case M.AgentAlertMessage: {
          out.agentAlert = parseAgentAlertMessage(buf, pos);
          break;
        }
        case M.ViewerFrozenMessage: {
          out.viewerFrozen = parseViewerFrozenMessage(buf, pos);
          break;
        }
        case M.ScriptQuestion: {
          out.scriptQuestion = parseScriptQuestion(buf, pos);
          break;
        }
        case M.ScriptDialog: {
          out.scriptDialog = parseScriptDialog(buf, pos);
          break;
        }
        case M.FeatureDisabled: {
          out.featureDisabled = parseFeatureDisabled(buf, pos);
          break;
        }
        case M.LoadURL: {
          out.loadUrl = parseLoadURL(buf, pos);
          break;
        }
        case M.ScriptTeleportRequest: {
          out.scriptTeleportRequest = parseScriptTeleportRequest(buf, pos);
          break;
        }
        case M.GenericMessage: {
          out.genericMessage = parseGenericMessage(buf, pos);
          break;
        }
        case M.MoneyBalanceReply: {
          out.moneyBalance = parseMoneyBalanceReply(buf, pos);
          break;
        }
        case M.TerminateFriendship: {
          out.terminateFriendship = parseTerminateFriendship(buf, pos);
          break;
        }
        case M.ParcelMediaUpdate: {
          out.parcelMediaUpdate = parseParcelMediaUpdate(buf, pos);
          break;
        }
        case M.OfferCallingCard: {
          out.offerCallingCard = parseOfferCallingCard(buf, pos);
          break;
        }
        case M.AvatarPickerReply: {
          out.avatarPickerReply = parseAvatarPickerReply(buf, pos);
          break;
        }
        case M.AvatarPropertiesReply: {
          out.avatarPropertiesReply = parseAvatarPropertiesReply(buf, pos);
          break;
        }
        case M.GroupProfileReply: {
          out.groupProfileReply = parseGroupProfileReply(buf, pos);
          break;
        }
        case M.GroupTitlesReply: {
          out.groupTitlesReply = parseGroupTitlesReply(buf, pos);
          break;
        }
        case M.GroupRoleDataReply: {
          out.groupRoleDataReply = parseGroupRoleDataReply(buf, pos);
          break;
        }
        case M.JoinGroupReply: {
          out.joinGroupReply = parseGroupMembershipReply(buf, pos);
          break;
        }
        case M.LeaveGroupReply: {
          out.leaveGroupReply = parseGroupMembershipReply(buf, pos);
          break;
        }
        case M.AgentGroupDataUpdate: {
          out.agentGroupDataUpdate = parseAgentGroupDataUpdate(buf, pos);
          break;
        }
        case M.AvatarGroupsReply: {
          out.avatarGroupsReply = parseAvatarGroupsReply(buf, pos);
          break;
        }
        case M.AvatarPicksReply: {
          out.avatarPicksReply = parseAvatarPicksReply(buf, pos);
          break;
        }
        case M.AvatarNotesReply: {
          out.avatarNotesReply = parseAvatarNotesReply(buf, pos);
          break;
        }
        case M.AvatarClassifiedReply: {
          out.avatarClassifiedReply = parseAvatarClassifiedReply(buf, pos);
          break;
        }
        case M.PickInfoReply: {
          out.pickInfoReply = parsePickInfoReply(buf, pos);
          break;
        }
        case M.ClassifiedInfoReply: {
          out.classifiedInfoReply = parseClassifiedInfoReply(buf, pos);
          break;
        }
        case M.DirPlacesReply: {
          out.dirPlacesReply = parseDirPlacesReply(buf, pos);
          break;
        }
        case M.DirPeopleReply: {
          out.dirPeopleReply = parseDirPeopleReply(buf, pos);
          break;
        }
        case M.DirGroupsReply: {
          out.dirGroupsReply = parseDirGroupsReply(buf, pos);
          break;
        }
        case M.DisableSimulator:
        case M.DataHomeLocationRequest:
        case M.DataHomeLocationReply:
        case M.SimulatorViewerTimeMessage:
        case M.ConfirmEnableSimulator:
        case M.ScriptControlChange:
        case M.MeanCollisionAlert:
        case M.HealthMessage:
        case M.MapLayerReply:
          break;
        case M.StartPingCheck:
          out.pingId = buf[pos];
          break;
        default:
          break;
      }
    } catch (_e) { /* partial parse ok */ }
    return out;
  }

  function encodePacket(msgId, data, seq, flags) {
    const meta = MSG_META[msgId];
    if (!meta) return null;
    const body = buildBody(msgId, data);
    let zerocoded = meta.zero;
    if (zerocoded) flags |= PF.Zerocoded;

    const headerSize = 6;
    const idSize = meta.freq === MF.FrequencyHigh ? 1 : meta.freq === MF.FrequencyMedium ? 2 : 4;
    let buf = new Uint8Array(headerSize + idSize + body.length + 64);
    let pos = 0;
    buf[pos++] = flags;
    pos = u32be(buf, pos, seq);
    buf[pos++] = 0;
    const bodyStart = pos + idSize;
    pos = B.writeMessageId(buf, pos, msgId, meta.freq);
    buf.set(body, pos);
    pos += body.length;

    if (zerocoded) {
      buf = B.zerocodeEncode(buf, bodyStart - idSize, pos - 1);
      buf[0] = flags | PF.Zerocoded;
    } else {
      buf = buf.subarray(0, pos);
    }
    return buf;
  }

  function decodePacket(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (buf.length < 6) return null;

    let receiveSize = buf.length;
    const flags = buf[0];
    const seq = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0, false);

    const appendedAcks = [];
    if (flags & PF.Ack) {
      const ackCount = buf[receiveSize - 1];
      receiveSize -= 1;
      if (ackCount > 0 && receiveSize >= ackCount * 4) {
        receiveSize -= ackCount * 4;
        for (let i = 0; i < ackCount; i++) {
          const off = receiveSize + (i * 4);
          appendedAcks.push(new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, false));
        }
      }
    }

    let pos = 1;
    pos += 4;
    const extra = buf[pos++];
    pos += extra;

    const bodyPos = pos;
    let payload = buf;
    if (flags & PF.Zerocoded) {
      payload = B.zerocodeDecode(buf, pos, receiveSize - 1, 0);
    } else {
      payload = buf.subarray(0, receiveSize);
    }

    const mid = B.readMessageId(payload, bodyPos);
    let msgPos = mid.pos;

    if (mid.id === M.PacketAck) {
      const count = payload[msgPos++];
      const acks = [];
      for (let i = 0; i < count; i++) {
        acks.push(new DataView(payload.buffer, payload.byteOffset + msgPos, 4).getUint32(0, true));
        msgPos += 4;
      }
      if (appendedAcks.length) {
        appendedAcks.forEach(function (a) { acks.push(a); });
      }
      return { seq: seq, flags: flags, acks: acks };
    }

    const parsed = parseBody(mid.id, payload, msgPos);
    parsed.seq = seq;
    parsed.flags = flags;
    if (flags & PF.Reliable) parsed.needsAck = true;
    if (appendedAcks.length) parsed.acks = appendedAcks;
    return parsed;
  }

  function Circuit(bridge, sessionId) {
    this.bridge = bridge;
    this.sessionId = sessionId;
    this.seq = 1;
    this.active = false;
    this.awaitingAck = new Map();
    this.handlers = [];
    this.pollAbort = null;
    this.pingTimer = null;
    this.pingId = 0;
    this.agentId = null;
    this.sessionUUID = null;
    this.circuitCode = 0;
    this.position = { x: 128, y: 128, z: 25 };
    this.regionName = '';
    this.nameCache = new Map();
    this.pendingAcks = new Set();
    this.handshakeDone = false;
    this.agentTimer = null;
    this.lookAt = { x: 0, y: 1, z: 0 };
    this.drawDistance = 128;
    this.movementComplete = null;
    this.regionHandshakeReceived = false;
    this.regionHandshakeReplySent = false;
    this.useCircuitAcked = false;
    this._pollStarted = false;
    this._pollBackoffMs = 0;
    this._handshakeMode = false;
    this._outbox = [];
    this._exSent = 0;
    this._exRecv = 0;
    this._simTarget = '';
    this._lastBytesSent = 0;
    this._lastLocalPort = 0;
    this._lastSendError = 0;
    this._lastRecvError = 0;
    this._useCircuitSeq = null;
    this._lastUseCircuitSend = 0;
    this._useCircuitRetries = 0;
    this._parcelPollTimer = null;
    this._agentParcelLocalId = -1;
    this._pollBusy = false;
    this._pollKickQueued = false;
    this._teleportWatch = false;
    this._teleportPauseOutbound = false;
    this._pendingTeleportSeq = null;
    this._lastRecvAt = 0;
    this.watchdogTimer = null;
    this._watchdogTripped = false;
  }

  Circuit.prototype.setSpawn = function (spawn) {
    if (!spawn) return;
    if (spawn.position) this.position = spawn.position;
    if (spawn.lookAt) this.lookAt = spawn.lookAt;
  };

  Circuit.prototype.setTarget = function (ip, port) {
    this._simTarget = String(ip) + ':' + String(port);
  };

  Circuit.prototype.on = function (fn) { this.handlers.push(fn); };
  Circuit.prototype.emit = function (evt) { this.handlers.forEach(function (f) { f(evt); }); };

  Circuit.prototype.start = function () {
    this.active = true;
    if (!this.pingTimer) {
      this.pingTimer = setInterval(this._ping.bind(this), PING_INTERVAL_MS);
    }
    if (!this.watchdogTimer) {
      this.watchdogTimer = setInterval(this._checkCircuitWatchdog.bind(this), WATCHDOG_INTERVAL_MS);
    }
  };

  Circuit.prototype._checkCircuitWatchdog = function () {
    if (!this.active || !this.handshakeDone || !this._lastRecvAt || this._watchdogTripped) return;
    const idleMs = Date.now() - this._lastRecvAt;
    if (idleMs < CIRCUIT_TIMEOUT_MS) return;
    this._watchdogTripped = true;
    this.emit({
      type: 'circuit-timeout',
      idleMs: idleMs,
      target: this._simTarget || ''
    });
  };

  Circuit.prototype._isPollIdle = function () {
    if (!this._lastRecvAt) return false;
    return (Date.now() - this._lastRecvAt) >= POLL_IDLE_AFTER_MS;
  };

  Circuit.prototype._pollTimeoutSec = function () {
    if (this._teleportWatch) return 1;
    if (!this.handshakeDone) return POLL_TIMEOUT_ACTIVE_SEC;
    return this._isPollIdle() ? POLL_TIMEOUT_IDLE_SEC : POLL_TIMEOUT_ACTIVE_SEC;
  };

  Circuit.prototype._pollScheduleDelayMs = function () {
    if (!this.handshakeDone) return 400;
    return this._isPollIdle() ? POLL_BACKOFF_IDLE_MS : POLL_BACKOFF_ACTIVE_MS;
  };

  Circuit.prototype._ensurePoll = function () {
    if (!this.active || this._pollStarted) return;
    this._pollStarted = true;
    this._poll();
  };

  Circuit.prototype.stop = function () {
    this.active = false;
    this.handshakeDone = false;
    this._handshakeMode = false;
    this._outbox = [];
    this._pollStarted = false;
    this._pollBackoffMs = 0;
    if (this.agentTimer) clearInterval(this.agentTimer);
    this.agentTimer = null;
    if (this._parcelPollTimer) clearInterval(this._parcelPollTimer);
    this._parcelPollTimer = null;
    if (this.pollAbort) this.pollAbort.aborted = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  };

  Circuit.prototype.logout = function () {
    const self = this;
    if (!this.active || !this.agentId) {
      this.stop();
      return Promise.resolve();
    }
    return this.send(M.LogoutRequest, {}, true).then(function () {
      return new Promise(function (resolve) { setTimeout(resolve, 500); });
    }).catch(function () {
      return null;
    }).then(function () {
      self.stop();
    });
  };

  Circuit.prototype._processHttpMessages = function (messages) {
    const self = this;
    (messages || []).forEach(function (msg) {
      if (!msg || !msg.name) return;
      self.emit({
        type: 'trusted-message',
        name: msg.name,
        body: msg.body || '',
        contentType: msg.contentType || 'application/llsd+xml'
      });
    });
  };

  Circuit.prototype._processRecvPayload = function (resp) {
    const self = this;
    const packets = (resp && resp.packets) || [];
    return self._processPackets(packets).then(function () {
      self._processHttpMessages(resp && resp.httpMessages);
      return resp;
    });
  };

  Circuit.prototype._packetB64 = function (packet) {
    let binary = '';
    const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  Circuit.prototype._exchangeRound = function (timeoutSec) {
    const self = this;
    if (!self._handshakeMode) {
      return Promise.resolve({ packets: [] });
    }

    function round(b64s) {
      return self.bridge.exchange(self.sessionId, b64s, timeoutSec).then(function (resp) {
        self._exSent += resp.sent || 0;
        self._exRecv += resp.recv || (resp.packets ? resp.packets.length : 0);
        if (resp.target) self._simTarget = resp.target;
        if (typeof resp.bytesSent === 'number' && resp.bytesSent > 0) {
          self._totalBytesSent += resp.bytesSent;
          self._lastBytesSent = resp.bytesSent;
        }
        if (typeof resp.localPort === 'number') self._lastLocalPort = resp.localPort;
        if (typeof resp.sendError === 'number') self._lastSendError = resp.sendError;
        if (typeof resp.recvError === 'number') self._lastRecvError = resp.recvError;
        return self._processRecvPayload(resp).then(function () {
          if (self._outbox.length > 0) {
            const more = self._outbox.splice(0).map(function (p) { return self._packetB64(p); });
            return round(more);
          }
          return resp;
        });
      });
    }

    const initial = self._outbox.splice(0).map(function (p) { return self._packetB64(p); });
    if (initial.length === 0 && timeoutSec <= 0) {
      return Promise.resolve({ packets: [] });
    }
    return round(initial);
  };

  Circuit.prototype._handshakeWait = function (predicate, timeoutMs, label) {
    const self = this;
    const deadline = Date.now() + timeoutMs;
    return new Promise(function (resolve, reject) {
      function step() {
        if (predicate()) {
          resolve(true);
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reject(new Error(
            'Circuit handshake timeout (' + label + '). Target ' + (self._simTarget || '?') +
            ', sent ' + (self._totalBytesSent || 0) + ' bytes on local UDP ' + (self._lastLocalPort || '?') +
            ', recv ' + self._exRecv +
            (self._lastSendError ? (', sendErr ' + self._lastSendError) : '') +
            (self._lastRecvError ? (', recvErr ' + self._lastRecvError) : '') +
            '. Close other SL viewers; allow php.exe UDP in Windows Firewall.'
          ));
          return;
        }
        const waitSec = Math.min(8, remaining / 1000);
        self._maybeRetryUseCircuitCode(label);
        self._maybeRetryCompleteAgentMovement(label);
        self._exchangeRound(waitSec).then(step).catch(reject);
      }
      if (predicate()) {
        resolve(true);
        return;
      }
      step();
    });
  };

  Circuit.prototype._noteCircuitAcks = function (acks) {
    if (this._useCircuitSeq == null) return;
    const self = this;
    (acks || []).forEach(function (a) {
      if (a === self._useCircuitSeq || (self._useCircuitSeq === 1 && a === 0)) {
        if (!self.useCircuitAcked) {
          self.useCircuitAcked = true;
          self.emit({ type: 'circuit-acked' });
        }
      }
    });
  };

  Circuit.prototype._sendUseCircuitCode = function (resent) {
    if (this._useCircuitSeq == null) {
      this._useCircuitSeq = 1;
    }
    const flags = PF.Reliable | (resent ? PF.Resent : 0);
    const packet = encodePacket(M.UseCircuitCode, this._base(), this._useCircuitSeq, flags);
    if (!packet) return Promise.resolve();
    this.awaitingAck.set(this._useCircuitSeq, Date.now());
    this._lastUseCircuitSend = Date.now();
    return this._rawSend(packet);
  };

  Circuit.prototype.migrateToSim = function (simIp, simPort, spawn) {
    const self = this;
    if (!this.active) {
      return Promise.reject(new Error('Circuit not active'));
    }
    if (!simIp || !simPort) {
      return Promise.reject(new Error('Invalid teleport sim endpoint'));
    }
    if (spawn && spawn.position) {
      this.position = spawn.position;
    }
    if (spawn && spawn.lookAt) {
      this.lookAt = spawn.lookAt;
    }
    this.setTarget(simIp, simPort);
    this.useCircuitAcked = false;
    this._useCircuitSeq = null;
    this._useCircuitRetries = 0;
    this.movementComplete = null;
    this._completeAgentMovementSent = false;
    this._completeAgentMovementRetries = 0;
    this.regionHandshakeReceived = false;
    this.regionHandshakeReplySent = false;
    this._agentParcelLocalId = -1;

    return this.bridge.retargetCircuit(this.sessionId, simIp, simPort).then(function (meta) {
      if (meta && meta.localPort) {
        self._lastLocalPort = meta.localPort;
      }
      return self._sendUseCircuitCode(false);
    }).then(function () {
      return self._waitFor(function () {
        return self.useCircuitAcked;
      }, 25000, 'TeleportUseCircuitCodeAck');
    }).then(function () {
      self._completeAgentMovementSent = true;
      self._lastCompleteAgentMovementSend = Date.now();
      return self.send(M.CompleteAgentMovement, {}, true);
    }).then(function () {
      return self._waitFor(function () {
        return self.movementComplete;
      }, 30000, 'TeleportAgentMovementComplete');
    }).then(function () {
      self.requestParcel();
      self.emit({ type: 'agent-placed' });
      return true;
    });
  };

  Circuit.prototype._queueUseCircuitCode = function (resent) {
    if (this._useCircuitSeq == null) {
      this._useCircuitSeq = this.seq++;
    }
    const flags = PF.Reliable | (resent ? PF.Resent : 0);
    const packet = encodePacket(M.UseCircuitCode, this._base(), this._useCircuitSeq, flags);
    if (packet) {
      this._outbox.push(packet);
      this.awaitingAck.set(this._useCircuitSeq, Date.now());
      this._lastUseCircuitSend = Date.now();
    }
  };

  Circuit.prototype._maybeRetryCompleteAgentMovement = function (label) {
    if (label !== 'AgentMovementComplete' || !this._completeAgentMovementSent || this.movementComplete) {
      return;
    }
    if (this._completeAgentMovementRetries >= 3) {
      return;
    }
    if (Date.now() - this._lastCompleteAgentMovementSend < 4500) {
      return;
    }
    this._completeAgentMovementRetries++;
    this._lastCompleteAgentMovementSend = Date.now();
    this.send(M.CompleteAgentMovement, {}, true);
  };

  Circuit.prototype._maybeRetryUseCircuitCode = function (label) {
    if (label !== 'UseCircuitCodeAck' || this._useCircuitSeq == null || this.useCircuitAcked) {
      return;
    }
    if (this._useCircuitRetries >= 3) {
      return;
    }
    if (Date.now() - this._lastUseCircuitSend < 4500) {
      return;
    }
    this._useCircuitRetries++;
    this._queueUseCircuitCode(true);
  };

  Circuit.prototype._exchangeUntil = function (predicate, timeoutMs, label) {
    return this._handshakeWait(predicate, timeoutMs, label);
  };

  Circuit.prototype._onRegionHandshake = function (name, regionId) {
    if (name) this.regionName = name;
    if (regionId) this.regionId = regionId;
    this.regionHandshakeReceived = true;
    this.emit({
      type: 'region',
      name: this.regionName || 'Region',
      regionId: this.regionId || '',
      handshakeOnly: true
    });
    if (!this.regionHandshakeReplySent) {
      this.regionHandshakeReplySent = true;
      this.send(M.RegionHandshakeReply, { flags: 5 }, true);
    }
  };

  Circuit.prototype._base = function () {
    return { agentId: this.agentId, sessionId: this.sessionUUID, circuitCode: this.circuitCode };
  };

  Circuit.prototype._rawSend = function (packet, target) {
    return this.bridge.send(this.sessionId, packet, target || null);
  };

  Circuit.prototype.sendUseCircuitCodeTo = function (simIp, simPort) {
    if (!this.active || !simIp || !simPort) {
      return Promise.resolve();
    }
    const packet = encodePacket(M.UseCircuitCode, this._base(), this.seq++, PF.Reliable);
    if (!packet) return Promise.resolve();
    return this._rawSend(packet, { simIp: simIp, simPort: simPort });
  };

  Circuit.prototype._queueAck = function (seq) {
    this.pendingAcks.add(seq);
  };

  Circuit.prototype._flushAcks = function () {
    if (this.pendingAcks.size === 0) return Promise.resolve();
    const ackIds = Array.from(this.pendingAcks);
    this.pendingAcks.clear();
    const packet = encodePacket(M.PacketAck, { ackIds: ackIds }, this.seq++, 0);
    if (!packet) return Promise.resolve();
    if (this._handshakeMode) {
      this._outbox.push(packet);
      return Promise.resolve();
    }
    return this._rawSend(packet);
  };

  Circuit.prototype.kickPoll = function () {
    if (!this.active || !this._pollStarted) return;
    this._pollKickQueued = true;
    if (this.pollAbort) {
      this.pollAbort.aborted = true;
    }
    if (!this._pollBusy) {
      this._pollBackoffMs = 0;
      this._poll();
    }
  };

  Circuit.prototype._processPackets = function (packets) {
    const self = this;
    const batch = packets || [];
    if (batch.length > 0) {
      this._lastRecvAt = Date.now();
      this.emit({ type: 'udp-recv', count: batch.length });
    }
    batch.forEach(function (p) {
      self._handleIncoming(p);
    });
    return self._flushAcks();
  };

  Circuit.prototype.send = function (msgId, extra, reliable) {
    if (!this.active) return Promise.resolve();
    const flags = reliable ? PF.Reliable : 0;
    const data = Object.assign({}, this._base(), extra || {});
    const packet = encodePacket(msgId, data, this.seq++, flags);
    const seqNum = this.seq - 1;
    if (!packet) return Promise.resolve(seqNum);
    if (reliable) {
      this.awaitingAck.set(seqNum, Date.now());
    }
    if (this._handshakeMode) {
      this._outbox.push(packet);
      return Promise.resolve(seqNum);
    }
    const self = this;
    return this._rawSend(packet).then(function () {
      return seqNum;
    });
  };

  Circuit.prototype._applyAcks = function (acks) {
    const self = this;
    (acks || []).forEach(function (a) { self.awaitingAck.delete(a); });
  };

  Circuit.prototype._waitFor = function (predicate, timeoutMs, label) {
    const self = this;
    return new Promise(function (resolve, reject) {
      const deadline = Date.now() + timeoutMs;
      function tick() {
        const value = predicate();
        if (value !== null && value !== undefined && value !== false) {
          resolve(value);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('Circuit handshake timeout' + (label ? ' (' + label + ')' : '')));
          return;
        }
        setTimeout(tick, 50);
      }
      tick();
    });
  };

  Circuit.prototype._handleIncoming = function (b64) {
    const bin = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
    const msg = decodePacket(bin);
    if (!msg) {
      const peek = peekPacketHeader(bin);
      if (peek && peek.reliable) {
        this._queueAck(peek.seq);
      }
      if (this._teleportWatch) {
        const sniff = sniffMessageId(bin);
        this.emit({
          type: 'teleport-debug',
          id: sniff,
          name: sniff ? 'decode-fail' : 'decode-fail-short',
          extra: sniff ? ('low=' + (sniff & 0xFFFF)) : ''
        });
      }
      return;
    }

    if (msg.acks) {
      this._noteCircuitAcks(msg.acks);
      this._applyAcks(msg.acks);
      if (!msg.id && !msg.name) return;
    }
    if (msg.needsAck) this._queueAck(msg.seq);

    if (this._teleportWatch && msg.id && isTeleportDebugInteresting(msg.id, msg.name)) {
      this.emit({
        type: 'teleport-debug',
        id: msg.id,
        name: msg.name || 'Unknown',
        extra: 'tpl=' + messageTemplateNum(msg.id)
      });
    }

    if (msg.id === M.StartPingCheck) {
      this.send(M.CompletePingCheck, { pingId: msg.pingId }, false);
      return;
    }
    if (msg.id === M.CompletePingCheck) {
      return;
    }
    if (msg.id === M.RegionHandshake) {
      this._onRegionHandshake(msg.regionName || '', msg.regionId || '');
      return;
    }
    if (msg.id === M.EnableSimulator && msg.enableSimulator) {
      this.emit({ type: 'enable-simulator', data: msg.enableSimulator });
      return;
    }
    if (msg.id === M.DisableSimulator) {
      if (this._teleportWatch) {
        this.emit({
          type: 'teleport-debug',
          id: msg.id,
          name: 'DisableSimulator',
          extra: 'tpl=' + messageTemplateNum(msg.id)
        });
      }
      return;
    }
    if (msg.id === M.CrossedRegion && msg.crossedRegion) {
      const cr = msg.crossedRegion;
      if (cr.seedCapability) {
        this.emit({ type: 'seed-capability', url: cr.seedCapability });
      }
      this.emit({
        type: 'crossed-region',
        url: cr.seedCapability || '',
        simIp: cr.simIp || '',
        simPort: cr.simPort || 0,
        regionHandle: cr.regionHandle || null,
        position: cr.position || null,
        lookAt: cr.lookAt || null
      });
      return;
    }
    if (msg.id === M.TeleportStart) {
      this.emit({
        type: 'teleport-start',
        flags: (msg.teleportStart && msg.teleportStart.teleportFlags) || 0
      });
      return;
    }
    if (msg.id === M.TeleportProgress && msg.teleportProgress) {
      const progress = msg.teleportProgress;
      if (this._teleportWatch) {
        const key = String(progress.message || '').trim();
        this.emit({
          type: 'teleport-debug',
          id: msg.id,
          name: 'TeleportProgress',
          extra: 'tpl=' + messageTemplateNum(msg.id) + (key ? (' ' + key) : '')
        });
      }
      this.emit({
        type: 'teleport-progress',
        flags: progress.teleportFlags || 0,
        message: progress.message || ''
      });
      return;
    }
    if (msg.id === M.TeleportLocal && msg.teleportLocal) {
      this.emit({ type: 'teleport-local', data: msg.teleportLocal });
      return;
    }
    if (msg.id === M.TeleportFinish) {
      const tf = msg.teleportFinish || {};
      if (msg.seedCapability || tf.seedCapability) {
        this.emit({ type: 'seed-capability', url: msg.seedCapability || tf.seedCapability });
      }
      this.emit({
        type: 'teleport-finish',
        url: msg.seedCapability || tf.seedCapability || '',
        simIp: tf.simIp || '',
        simPort: tf.simPort || 0,
        regionHandle: tf.regionHandle || null,
        teleportFlags: tf.teleportFlags || 0
      });
      return;
    }
    if (msg.id === M.MapBlockReply) {
      this.emit({ type: 'map-block-reply', blocks: msg.mapBlocks || [] });
      return;
    }
    if (msg.id === M.MapItemReply) {
      const reply = msg.mapItemReply || { itemType: 0, items: [] };
      this.emit({
        type: 'map-item-reply',
        itemType: reply.itemType || 0,
        items: reply.items || []
      });
      return;
    }
    if (msg.id === M.TeleportFailed) {
      const fail = msg.teleportFailed || { reason: 'Teleport failed' };
      this.emit({ type: 'teleport-failed', data: fail });
      return;
    }
    if (msg.id === M.LogoutReply) {
      this.emit({
        type: 'session-lost',
        reason: 'You have been logged out of the simulator.',
        source: 'logout-reply'
      });
      return;
    }
    if (msg.id === M.KickUser && msg.kickUser) {
      const kick = msg.kickUser;
      if (!this.agentId || kick.agentId === this.agentId || kick.agentId === '00000000-0000-0000-0000-000000000000') {
        const text = (kick.reason || '').trim();
        this.emit({
          type: 'session-lost',
          reason: text || 'You have been disconnected from the simulator.',
          source: 'kick-user'
        });
      }
      return;
    }
    if (msg.id === M.KillChildAgents && msg.killChildAgents) {
      if (!this.agentId || msg.killChildAgents.agentId === this.agentId) {
        this.emit({
          type: 'session-lost',
          reason: 'Your account logged in from another viewer or location.',
          source: 'kill-child-agents'
        });
      }
      return;
    }
    if (msg.id === M.SystemKickUser && msg.systemKickAgents && msg.systemKickAgents.length) {
      const selfId = this.agentId;
      if (selfId && msg.systemKickAgents.indexOf(selfId) >= 0) {
        this.emit({
          type: 'session-lost',
          reason: 'You have been disconnected by the simulator.',
          source: 'system-kick'
        });
      }
      return;
    }
    if (msg.id === M.ChatFromSimulator && msg.chat) {
      this.nameCache.set(msg.chat.sourceId, msg.chat.fromName);
      this.emit({ type: 'chat', data: msg.chat });
      return;
    }
    if (msg.id === M.ImprovedInstantMessage && msg.im) {
      if (msg.im.fromAgentId && msg.im.fromName) {
        this.nameCache.set(msg.im.fromAgentId, msg.im.fromName);
      }
      this.emit({ type: 'im', data: msg.im });
      return;
    }
    if (msg.id === M.OnlineNotification && msg.agentIds && msg.agentIds.length) {
      this.emit({ type: 'buddy-presence', online: true, agentIds: msg.agentIds });
      return;
    }
    if (msg.id === M.OfflineNotification && msg.agentIds && msg.agentIds.length) {
      this.emit({ type: 'buddy-presence', online: false, agentIds: msg.agentIds });
      return;
    }
    if (msg.id === M.CoarseLocationUpdate && msg.coarse) {
      let selfPos = this.position;
      const coarse = msg.coarse;
      if (coarse.youIndex >= 0 && coarse.locations && coarse.locations[coarse.youIndex]) {
        const loc = coarse.locations[coarse.youIndex];
        selfPos = { x: loc.x, y: loc.y, z: loc.z };
        this.position = selfPos;
      }
      this.emit({ type: 'radar', data: coarse, selfPos: selfPos });
      return;
    }
    if (msg.id === M.AgentMovementComplete) {
      if (msg.position) {
        this.position = msg.position;
        if (msg.lookAt) this.lookAt = msg.lookAt;
      }
      this.movementComplete = {
        position: msg.position || this.position,
        lookAt: msg.lookAt || this.lookAt
      };
      this.emit({
        type: 'movement',
        position: this.movementComplete.position,
        lookAt: this.movementComplete.lookAt
      });
      if (this.handshakeDone) {
        this.requestParcel();
      }
      return;
    }
    if (msg.id === M.ParcelProperties) {
      if (msg.parcel) {
        if (msg.parcel.localId >= 0) {
          this._agentParcelLocalId = msg.parcel.localId;
        }
        msg.parcel.source = 'udp';
        this.emit({ type: 'parcel', data: msg.parcel });
      } else {
        this.emit({
          type: 'parcel-debug',
          debug: msg.parcelDebug || {},
          bodyBytes: msg.parcelDebug && msg.parcelDebug.bodyBytes
        });
      }
      return;
    }
    if (msg.id === M.ParcelInfoReply && msg.parcel) {
      this.emit({ type: 'parcel', data: msg.parcel });
      return;
    }
    if (msg.id === M.AgentDataUpdate && msg.agentUpdate) {
      this.nameCache.set(msg.agentUpdate.agentId, msg.agentUpdate.name);
      this.emit({ type: 'agent-name', data: msg.agentUpdate });
      return;
    }
    if (msg.id === M.UUIDNameReply && msg.uuidNames && msg.uuidNames.length) {
      this.emit({ type: 'uuid-names', names: msg.uuidNames });
      return;
    }
    if (msg.id === M.AlertMessage && msg.alert) {
      this.emit({ type: 'alert', data: msg.alert });
      return;
    }
    if (msg.id === M.AgentAlertMessage && msg.agentAlert) {
      const alert = msg.agentAlert;
      const selfId = this.agentId;
      if (!selfId || alert.agentId === selfId ||
          alert.agentId === '00000000-0000-0000-0000-000000000000') {
        this.emit({ type: 'alert', data: { message: alert.message, modal: alert.modal } });
      }
      return;
    }
    if (msg.id === M.ViewerFrozenMessage && msg.viewerFrozen) {
      this.emit({ type: 'viewer-frozen', data: msg.viewerFrozen });
      return;
    }
    if (msg.id === M.ScriptQuestion && msg.scriptQuestion) {
      this.emit({ type: 'script-question', data: msg.scriptQuestion });
      return;
    }
    if (msg.id === M.ScriptDialog && msg.scriptDialog) {
      this.emit({ type: 'script-dialog', data: msg.scriptDialog });
      return;
    }
    if (msg.id === M.FeatureDisabled && msg.featureDisabled) {
      this.emit({ type: 'feature-disabled', data: msg.featureDisabled });
      return;
    }
    if (msg.id === M.LoadURL && msg.loadUrl) {
      this.emit({ type: 'load-url', data: msg.loadUrl });
      return;
    }
    if (msg.id === M.ScriptTeleportRequest && msg.scriptTeleportRequest) {
      this.emit({ type: 'script-teleport-request', data: msg.scriptTeleportRequest });
      return;
    }
    if (msg.id === M.OfferCallingCard && msg.offerCallingCard) {
      this.emit({ type: 'calling-card-offer', data: msg.offerCallingCard });
      return;
    }
    if (msg.id === M.AcceptCallingCard) {
      this.emit({ type: 'calling-card-accepted', data: {} });
      return;
    }
    if (msg.id === M.DeclineCallingCard) {
      this.emit({ type: 'calling-card-declined', data: {} });
      return;
    }
    if (msg.id === M.AvatarPickerReply && msg.avatarPickerReply) {
      this.emit({ type: 'avatar-picker-reply', data: msg.avatarPickerReply });
      return;
    }
    if (msg.id === M.DirPlacesReply && msg.dirPlacesReply) {
      this.emit({ type: 'dir-places-reply', data: msg.dirPlacesReply });
      return;
    }
    if (msg.id === M.DirPeopleReply && msg.dirPeopleReply) {
      this.emit({ type: 'dir-people-reply', data: msg.dirPeopleReply });
      return;
    }
    if (msg.id === M.DirGroupsReply && msg.dirGroupsReply) {
      this.emit({ type: 'dir-groups-reply', data: msg.dirGroupsReply });
      return;
    }
    if (msg.id === M.GenericMessage && msg.genericMessage) {
      this.emit({ type: 'generic-message', data: msg.genericMessage });
      return;
    }
    if (msg.id === M.MoneyBalanceReply && msg.moneyBalance) {
      this.emit({ type: 'money-balance', data: msg.moneyBalance });
      return;
    }
    if (msg.id === M.TerminateFriendship && msg.terminateFriendship) {
      this.emit({ type: 'terminate-friendship', data: msg.terminateFriendship });
      return;
    }
    if (msg.id === M.ParcelMediaUpdate && msg.parcelMediaUpdate) {
      this.emit({ type: 'parcel-media-update', data: msg.parcelMediaUpdate });
      return;
    }
    if (msg.id === M.AvatarPropertiesReply && msg.avatarPropertiesReply) {
      this.emit({ type: 'avatar-properties-reply', data: msg.avatarPropertiesReply });
      return;
    }
    if (msg.id === M.GroupProfileReply && msg.groupProfileReply) {
      this.emit({ type: 'group-profile-reply', data: msg.groupProfileReply });
      return;
    }
    if (msg.id === M.GroupTitlesReply && msg.groupTitlesReply) {
      this.emit({ type: 'group-titles-reply', data: msg.groupTitlesReply });
      return;
    }
    if (msg.id === M.GroupRoleDataReply && msg.groupRoleDataReply) {
      this.emit({ type: 'group-role-data-reply', data: msg.groupRoleDataReply });
      return;
    }
    if (msg.id === M.JoinGroupReply && msg.joinGroupReply) {
      this.emit({ type: 'join-group-reply', data: msg.joinGroupReply });
      return;
    }
    if (msg.id === M.LeaveGroupReply && msg.leaveGroupReply) {
      this.emit({ type: 'leave-group-reply', data: msg.leaveGroupReply });
      return;
    }
    if (msg.id === M.AgentGroupDataUpdate && msg.agentGroupDataUpdate) {
      this.emit({ type: 'agent-group-data-update', data: msg.agentGroupDataUpdate });
      return;
    }
    if (msg.id === M.AvatarGroupsReply && msg.avatarGroupsReply) {
      this.emit({ type: 'avatar-groups-reply', data: msg.avatarGroupsReply });
      return;
    }
    if (msg.id === M.AvatarPicksReply && msg.avatarPicksReply) {
      this.emit({ type: 'avatar-picks-reply', data: msg.avatarPicksReply });
      return;
    }
    if (msg.id === M.AvatarNotesReply && msg.avatarNotesReply) {
      this.emit({ type: 'avatar-notes-reply', data: msg.avatarNotesReply });
      return;
    }
    if (msg.id === M.AvatarClassifiedReply && msg.avatarClassifiedReply) {
      this.emit({ type: 'avatar-classified-reply', data: msg.avatarClassifiedReply });
      return;
    }
    if (msg.id === M.PickInfoReply && msg.pickInfoReply) {
      this.emit({ type: 'pick-info-reply', data: msg.pickInfoReply });
      return;
    }
    if (msg.id === M.ClassifiedInfoReply && msg.classifiedInfoReply) {
      this.emit({ type: 'classified-info-reply', data: msg.classifiedInfoReply });
      return;
    }
    ensureMsgMeta(msg.id);
    if (isConsumedInbound(msg)) {
      return;
    }
    if (!isSilentInboundName(msg.name || '')) {
      this.emit({
        type: 'unresolved-packet',
        id: msg.id,
        name: msg.name || 'Unknown',
        template: messageTemplateNum(msg.id),
        teleportWatch: !!this._teleportWatch
      });
    }
  };

  Circuit.prototype._sendAgentUpdate = function () {
    if (!this.active || !this.handshakeDone) return;
    if (this._teleportPauseOutbound) return;
    this.send(M.AgentUpdate, {
      position: this.position,
      lookAt: this.lookAt,
      drawDistance: this.drawDistance,
      controlFlags: 0,
      state: 0,
      flags: 0
    }, false);
  };

  Circuit.prototype._startAgentUpdates = function () {
    const self = this;
    if (this.agentTimer) clearInterval(this.agentTimer);
    if (this._parcelPollTimer) clearInterval(this._parcelPollTimer);
    this._sendAgentUpdate();
    this.requestParcel();
    this.agentTimer = setInterval(function () { self._sendAgentUpdate(); }, 1000);
    this._parcelPollTimer = setInterval(function () {
      if (!self.handshakeDone) return;
      self.requestParcel();
      if (self._agentParcelLocalId >= 0) {
        self.requestParcelByLocalId(self._agentParcelLocalId);
      }
    }, 15000);
  };

  Circuit.prototype._poll = function () {
    if (!this.active || this._pollBusy) return;
    const self = this;
    const token = { aborted: false };
    this.pollAbort = token;
    const timeout = this._pollTimeoutSec();
    const delay = this._pollBackoffMs;
    this._pollBackoffMs = 0;
    this._pollBusy = true;

    function scheduleNext(immediate) {
      self._pollBusy = false;
      if (!self.active) return;
      if (self._pollKickQueued) {
        self._pollKickQueued = false;
        self._pollBackoffMs = 0;
        self._poll();
        return;
      }
      if (immediate) {
        self._pollBackoffMs = 0;
        self._poll();
        return;
      }
      setTimeout(function () { self._poll(); }, self._pollScheduleDelayMs());
    }

    function runPoll() {
      if (!self.active) {
        self._pollBusy = false;
        return;
      }
      self.bridge.poll(self.sessionId, timeout).then(function (resp) {
        if (!self.active) {
          self._pollBusy = false;
          return;
        }
        const packets = resp.packets || [];
        return self._processRecvPayload(resp).then(function () {
          if (!self.active) {
            self._pollBusy = false;
            return;
          }
          const hadPackets = packets.length > 0 ||
            (resp.httpMessages && resp.httpMessages.length > 0);
          const kicked = token.aborted;
          if (hadPackets || kicked) {
            scheduleNext(true);
          } else {
            scheduleNext(false);
          }
        });
      }).catch(function (err) {
        if (!self.active) {
          self._pollBusy = false;
          return;
        }
        const msg = err && err.message ? String(err.message) : '';
        if (/Unknown session|\b404\b/i.test(msg)) {
          self.emit({
            type: 'session-lost',
            reason: 'The simulator closed your connection.',
            source: 'bridge'
          });
          self.stop();
          self._pollBusy = false;
          return;
        }
        self._pollBackoffMs = 1000;
        self._pollBusy = false;
        setTimeout(function () { self._poll(); }, self._pollBackoffMs);
      });
    }

    if (delay > 0) {
      setTimeout(runPoll, delay);
    } else {
      runPoll();
    }
  };

  Circuit.prototype._ping = function () {
    if (!this.active || !this.handshakeDone) return;
    this.pingId = (this.pingId + 1) & 0xFF;
    this.send(M.StartPingCheck, { pingId: this.pingId, oldestUnacked: 0 }, true);
  };

  Circuit.prototype.connect = function (agentId, sessionId, circuitCode, bootstrap) {
    const boot = bootstrap || null;
    this.agentId = agentId;
    this.sessionUUID = sessionId;
    this.circuitCode = circuitCode;
    this.movementComplete = null;
    this.regionHandshakeReceived = false;
    this.regionHandshakeReplySent = false;
    this.useCircuitAcked = false;
    this._handshakeMode = true;
    this._outbox = [];
    this._exSent = boot ? (boot.sent || 0) : 0;
    this._exRecv = boot ? (boot.recv || 0) : 0;
    this._useCircuitSeq = 1;
    this.seq = 2;
    this._lastUseCircuitSend = 0;
    this._useCircuitRetries = 0;
    this._completeAgentMovementSent = false;
    this._completeAgentMovementRetries = 0;
    this._lastCompleteAgentMovementSend = 0;
    this._totalBytesSent = boot ? (boot.bytesSent || 0) : 0;
    this._watchdogTripped = false;
    this.active = true;

    if (boot) {
      if (typeof boot.bytesSent === 'number') {
        this._lastBytesSent = boot.bytesSent;
        this._totalBytesSent = boot.bytesSent;
      }
      if (typeof boot.localPort === 'number') this._lastLocalPort = boot.localPort;
      if (boot.target) this._simTarget = boot.target;
    }

    if (!circuitCode) {
      return Promise.reject(new Error('Login returned invalid circuit code'));
    }

    const self = this;

    const initialPackets = (boot && boot.packets) ? boot.packets.slice() : [];
    return self._processPackets(initialPackets).then(function () {
      if (!self.useCircuitAcked) {
        self._queueUseCircuitCode(!!(boot && boot.sent));
      }
      return self._exchangeUntil(function () {
        return self.useCircuitAcked ? true : null;
      }, 25, 'UseCircuitCodeAck');
    }).then(function () {
      self._completeAgentMovementSent = true;
      self._lastCompleteAgentMovementSend = Date.now();
      return self.send(M.CompleteAgentMovement, {}, true);
    }).then(function () {
      return self._exchangeRound(2);
    }).then(function () {
      return self._exchangeUntil(function () {
        return self.movementComplete ? true : null;
      }, 25, 'AgentMovementComplete');
    }).then(function () {
      return self.send(M.AgentDataUpdateRequest, {}, true);
    }).then(function () {
      return self.send(M.MoneyBalanceRequest, { transactionId: B.UUID.zero().toString() }, true);
    }).then(function () {
      return self._exchangeRound(2);
    }).then(function () {
      self._handshakeMode = false;
      self.handshakeDone = true;
      self._startAgentUpdates();
      self.requestParcel();
      self._ensurePoll();
      self.emit({ type: 'agent-placed' });
      self.emit({ type: 'ready' });
    });
  };

  Circuit.prototype.say = function (text, chatType, channel) {
    return this.send(M.ChatFromViewer, {
      text: text,
      chatType: chatType !== undefined ? chatType : 1,
      channel: channel !== undefined ? channel : 0
    }, true);
  };

  Circuit.prototype.sendIm = function (toAgentId, text, fromName, regionId, options) {
    const opts = options || {};
    return this.send(M.ImprovedInstantMessage, {
      toAgentId: toAgentId,
      text: text,
      fromName: fromName,
      regionId: regionId || B.UUID.zero().toString(),
      position: this.position,
      dialog: opts.dialog !== undefined ? opts.dialog : 0,
      imId: opts.imId || FSUtils.uuid(),
      offline: opts.offline !== undefined ? opts.offline : 0,
      timestamp: opts.timestamp !== undefined ? opts.timestamp : 0,
      binaryBucket: opts.binaryBucket || ''
    }, true);
  };

  Circuit.prototype.startLure = function (targetIds, message) {
    const ids = (targetIds || []).filter(Boolean);
    if (!ids.length) return Promise.resolve();
    return this.send(M.StartLure, {
      lureType: 0,
      message: message || '',
      targetIds: ids
    }, true);
  };

  Circuit.prototype.acceptLure = function (lureId, teleportFlags) {
    const id = String(lureId || '');
    if (!id || id === '00000000-0000-0000-0000-000000000000') return Promise.resolve();
    const flags = teleportFlags !== undefined ? teleportFlags : 4;
    return this.send(M.TeleportLureRequest, {
      lureId: id,
      teleportFlags: flags
    }, true);
  };

  Circuit.prototype.teleportLandmarkRequest = function (landmarkId) {
    if (!this.active) return Promise.resolve({ sent: false, bytesSent: 0 });
    const id = landmarkId || '00000000-0000-0000-0000-000000000000';
    const data = Object.assign({}, this._base(), { landmarkId: id });
    const seqNum = this.seq++;
    const packet = encodePacket(M.TeleportLandmarkRequest, data, seqNum, PF.Reliable);
    if (!packet) return Promise.resolve({ sent: false, bytesSent: 0 });
    this.awaitingAck.set(seqNum, Date.now());
    if (this._handshakeMode) {
      this._outbox.push(packet);
      return Promise.resolve({ sent: true, bytesSent: packet.length, queued: true, seq: seqNum });
    }
    return this._rawSend(packet).then(function (resp) {
      return {
        sent: !!(resp && resp.sent),
        bytesSent: resp && resp.bytesSent ? resp.bytesSent : 0,
        seq: seqNum
      };
    });
  };

  Circuit.prototype.teleportLocationRequest = function (regionHandle, position, lookAt, resent) {
    if (!this.active) return Promise.resolve({ sent: false, bytesSent: 0 });
    const pos = position || { x: 128, y: 128, z: 25 };
    const look = lookAt || { x: pos.x + 1, y: pos.y, z: pos.z };
    const data = Object.assign({}, this._base(), {
      regionHandle: regionHandle,
      position: pos,
      lookAt: look
    });
    let seqNum;
    if (resent && this._pendingTeleportSeq != null) {
      seqNum = this._pendingTeleportSeq;
    } else {
      seqNum = this.seq++;
      this._pendingTeleportSeq = seqNum;
    }
    const flags = PF.Reliable | (resent ? PF.Resent : 0);
    const packet = encodePacket(M.TeleportLocationRequest, data, seqNum, flags);
    if (!packet) return Promise.resolve({ sent: false, bytesSent: 0 });
    this.awaitingAck.set(seqNum, Date.now());
    if (this._handshakeMode) {
      this._outbox.push(packet);
      return Promise.resolve({ sent: true, bytesSent: packet.length, queued: true });
    }
    const self = this;
    return this._rawSend(packet).then(function (resp) {
      return {
        sent: !!(resp && resp.sent),
        bytesSent: resp && resp.bytesSent ? resp.bytesSent : 0,
        seq: seqNum
      };
    });
  };

  Circuit.prototype.requestMapName = function (regionName) {
    return this.send(M.MapNameRequest, {
      regionName: regionName,
      flags: 2,
      godlike: false
    }, true);
  };

  Circuit.prototype.requestMapBlock = function (minX, minY, maxX, maxY, flags) {
    return this.send(M.MapBlockRequest, {
      minX: minX,
      minY: minY,
      maxX: maxX,
      maxY: maxY,
      flags: flags !== undefined ? flags : 2,
      godlike: false
    }, true);
  };

  Circuit.prototype.requestMapAgentCount = function (regionHandle) {
    return this.send(M.MapItemRequest, {
      flags: 2,
      itemType: 6,
      regionHandle: regionHandle || 0,
      godlike: false
    }, true);
  };

  Circuit.prototype.requestParcel = function () {
    if (this._teleportPauseOutbound) return Promise.resolve();
    const p = this.position || { x: 128, y: 128, z: 25 };
    const step = 4;
    const west = step * Math.floor(p.x / step);
    const south = step * Math.floor(p.y / step);
    return this.send(M.ParcelPropertiesRequest, {
      sequenceId: -50000,
      west: west,
      south: south,
      east: west + step,
      north: south + step,
      snapSelection: false
    }, true);
  };

  Circuit.prototype.requestParcelByLocalId = function (localId) {
    if (this._teleportPauseOutbound) return Promise.resolve();
    if (localId === undefined || localId === null || localId < 0) return Promise.resolve();
    return this.send(M.ParcelPropertiesRequestByID, {
      sequenceId: -50000,
      localId: localId
    }, true);
  };

  Circuit.prototype.requestParcelInfo = function (parcelId) {
    if (!parcelId) return Promise.resolve();
    return this.send(M.ParcelInfoRequest, { parcelId: parcelId }, true);
  };

  Circuit.prototype.replyScriptDialog = function (objectId, buttonIndex, buttonLabel, chatChannel) {
    // Only call from explicit user action (chat dialog button / submit).
    if (!this.active) return Promise.resolve({ sent: false, bytesSent: 0 });
    const data = Object.assign({}, this._base(), {
      objectId: objectId,
      buttonIndex: buttonIndex !== undefined ? buttonIndex : 0,
      buttonLabel: buttonLabel || '',
      chatChannel: chatChannel !== undefined ? chatChannel : 0
    });
    const seqNum = this.seq++;
    const packet = encodePacket(M.ScriptDialogReply, data, seqNum, PF.Reliable);
    if (!packet) return Promise.resolve({ sent: false, bytesSent: 0 });
    this.awaitingAck.set(seqNum, Date.now());
    return this._rawSend(packet).then(function (resp) {
      return {
        sent: !!(resp && resp.sent),
        bytesSent: resp && resp.bytesSent ? resp.bytesSent : 0,
        seq: seqNum
      };
    });
  };

  Circuit.prototype.replyScriptPermission = function (taskId, itemId, questions) {
    // Only call from explicit user action (permission Yes/No).
    if (!this.active || !taskId || !itemId) {
      return Promise.resolve({ sent: false, bytesSent: 0 });
    }
    return this.send(M.ScriptAnswerYes, {
      taskId: taskId,
      itemId: itemId,
      questions: questions !== undefined ? questions : 0
    }, true);
  };

  Circuit.prototype.acceptCallingCard = function (transactionId, folderId) {
    // Only call from explicit user action (friendship offer Accept).
    if (!this.active || !transactionId) {
      return Promise.resolve({ sent: false, bytesSent: 0 });
    }
    return this.send(M.AcceptCallingCard, {
      transactionId: transactionId,
      folderId: folderId || B.UUID.zero().toString()
    }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.declineCallingCard = function (transactionId) {
    // Only call from explicit user action (friendship offer Decline).
    if (!this.active || !transactionId) {
      return Promise.resolve({ sent: false, bytesSent: 0 });
    }
    return this.send(M.DeclineCallingCard, {
      transactionId: transactionId
    }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.offerCallingCard = function (destId, transactionId) {
    if (!this.active || !destId) {
      return Promise.resolve({ sent: false, bytesSent: 0 });
    }
    return this.send(M.OfferCallingCard, {
      destId: destId,
      transactionId: transactionId
    }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.payResident = function (destId, amount, description) {
    if (!this.active || !destId || !amount) {
      return Promise.resolve({ sent: false, bytesSent: 0 });
    }
    return this.send(M.MoneyTransferRequest, {
      destId: destId,
      amount: Math.abs(Math.trunc(amount)),
      description: description || '',
      transactionType: 5001,
      flags: 0
    }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.searchPeopleUdp = function (queryId, queryText, queryFlags) {
    if (!this.active || !queryId) {
      return Promise.resolve({ sent: false });
    }
    return this.send(M.DirFindQuery, {
      queryId: queryId,
      queryText: queryText || '',
      queryFlags: queryFlags !== undefined ? queryFlags : 0,
      queryStart: 0
    }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.searchAvatarsUdp = function (queryId, name) {
    if (!this.active || !queryId || !name) {
      return Promise.resolve({ sent: false });
    }
    return this.send(M.AvatarPickerRequest, { queryId: queryId, name: name }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.searchPlacesUdp = function (queryId, queryText, queryFlags) {
    if (!this.active || !queryId) {
      return Promise.resolve({ sent: false });
    }
    return this.send(M.DirPlacesQuery, {
      queryId: queryId,
      queryText: queryText || '',
      queryFlags: queryFlags !== undefined ? queryFlags : 0,
      category: -1,
      simName: '',
      queryStart: 0
    }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.searchGroupsUdp = function (queryId, queryText, queryFlags) {
    if (!this.active || !queryId) {
      return Promise.resolve({ sent: false });
    }
    return this.send(M.DirFindQuery, {
      queryId: queryId,
      queryText: queryText || '',
      queryFlags: queryFlags !== undefined ? queryFlags : 0,
      queryStart: 0
    }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.requestUuidNames = function (ids) {
    const list = (ids || []).filter(Boolean).slice(0, 40);
    if (!list.length || !this.handshakeDone) return Promise.resolve();
    return this.send(M.UUIDNameRequest, { ids: list }, true);
  };

  Circuit.prototype.teleportCancel = function () {
    if (!this.handshakeDone) return Promise.resolve();
    return this.send(M.TeleportCancel, {}, true);
  };

  Circuit.prototype.requestMoneyBalance = function (transactionId) {
    if (!this.handshakeDone) return Promise.resolve();
    return this.send(M.MoneyBalanceRequest, {
      transactionId: transactionId || B.UUID.zero().toString()
    }, true);
  };

  Circuit.prototype.pulseCircuit = function () {
    if (!this.circuitCode || !this.active) return Promise.resolve();
    this._queueUseCircuitCode(true);
    return this._exchangeRound(1);
  };

  Circuit.prototype.updateParcel = function (parcel) {
    return this.send(M.ParcelPropertiesUpdate, { parcel: parcel }, true);
  };

  Circuit.prototype.requestAvatarProperties = function (avatarId) {
    if (!this.handshakeDone || !avatarId) return Promise.resolve();
    return this.send(M.AvatarPropertiesRequest, { avatarId: avatarId }, true);
  };

  Circuit.prototype.requestGroupProfile = function (groupId) {
    if (!this.handshakeDone || !groupId) return Promise.resolve();
    return this.send(M.GroupProfileRequest, { groupId: groupId }, true);
  };

  Circuit.prototype.activateGroup = function (groupId) {
    if (!this.handshakeDone) return Promise.resolve({ sent: false });
    const id = groupId || B.UUID.zero().toString();
    return this.send(M.ActivateGroup, { groupId: id }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.requestGroupRoleData = function (groupId, requestId) {
    if (!this.handshakeDone || !groupId || !requestId) return Promise.resolve({ sent: false });
    return this.send(M.GroupRoleDataRequest, {
      groupId: groupId,
      requestId: requestId
    }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.requestGroupTitles = function (groupId, requestId) {
    if (!this.handshakeDone || !groupId || !requestId) return Promise.resolve({ sent: false });
    return this.send(M.GroupTitlesRequest, {
      groupId: groupId,
      requestId: requestId
    }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.updateGroupTitle = function (groupId, titleRoleId) {
    if (!this.handshakeDone || !groupId) return Promise.resolve({ sent: false });
    return this.send(M.GroupTitleUpdate, {
      groupId: groupId,
      titleRoleId: titleRoleId || B.UUID.zero().toString()
    }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.sendAvatarGenericRequest = function (method, avatarId) {
    if (!this.handshakeDone || !avatarId || !method) return Promise.resolve();
    return this.send(M.GenericMessage, {
      method: method,
      params: [avatarId],
      invoice: B.UUID.zero().toString()
    }, true);
  };

  Circuit.prototype.sendPickInfoRequest = function (creatorId, pickId) {
    if (!this.handshakeDone || !creatorId || !pickId) return Promise.resolve();
    return this.send(M.GenericMessage, {
      method: 'pickinforequest',
      params: [creatorId, pickId],
      invoice: B.UUID.zero().toString()
    }, true);
  };

  Circuit.prototype.requestClassifiedInfo = function (classifiedId) {
    if (!this.handshakeDone || !classifiedId) return Promise.resolve();
    return this.send(M.ClassifiedInfoRequest, { classifiedId: classifiedId }, true);
  };

  Circuit.prototype.updateAvatarNotes = function (targetId, notes) {
    if (!this.handshakeDone || !targetId) return Promise.resolve({ sent: false });
    return this.send(M.AvatarNotesUpdate, {
      targetId: targetId,
      notes: notes || ''
    }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.terminateFriendship = function (otherId) {
    if (!this.handshakeDone || !otherId) return Promise.resolve({ sent: false });
    return this.send(M.TerminateFriendship, { otherId: otherId }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.joinGroup = function (groupId) {
    if (!this.handshakeDone || !groupId) return Promise.resolve({ sent: false });
    return this.send(M.JoinGroupRequest, { groupId: groupId }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  Circuit.prototype.leaveGroup = function (groupId) {
    if (!this.handshakeDone || !groupId) return Promise.resolve({ sent: false });
    return this.send(M.LeaveGroupRequest, { groupId: groupId }, true).then(function (seq) {
      return { sent: seq !== undefined && seq !== null };
    });
  };

  return { Circuit: Circuit, decodePacket: decodePacket, encodePacket: encodePacket, Message: M };
})();
