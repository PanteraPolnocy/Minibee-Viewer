/**
 * Binary helpers, UUID, zerocode - SL UDP protocol primitives.
 */
const FSSLBinary = (function () {
  'use strict';

  const te = new TextEncoder();
  const td = new TextDecoder();

  const Message = {
    StartPingCheck: 1,
    CompletePingCheck: 2,
    AgentUpdate: 4,
    ParcelProperties: 23,
    CoarseLocationUpdate: 65286,
    CrossedRegion: 65287,
    ParcelPropertiesRequest: 65291,
    PacketAck: 4294967291,
    UseCircuitCode: 4294901763,
    ChatFromViewer: 4294901840,
    RegionHandshake: 4294901908,
    RegionHandshakeReply: 4294901909,
    ChatFromSimulator: 4294901899,
    ParcelPropertiesUpdate: 4294901958,
    CompleteAgentMovement: 4294902009,
    AgentMovementComplete: 4294902010,
    ImprovedInstantMessage: 4294902014,
    TeleportLocal: 4294901824,
    TeleportProgress: 4294901826,
    TeleportFinish: 4294901829,
    StartLure: 4294901830,
    TeleportLureRequest: 4294901831,
    TeleportStart: 4294901833,
    TeleportFailed: 4294901834,
    AgentDataUpdateRequest: 4294902146,
    AgentDataUpdate: 4294902147,
    ParcelInfoRequest: 4294901814,
    ParcelInfoReply: 4294901815,
    ParcelPropertiesRequestByID: 4294901957,
    LogoutRequest: 4294902012,
    LogoutReply: 4294902013,
    KickUser: 4294901923,
    SystemKickUser: 4294901926,
    KillChildAgents: 4294902002,
    UUIDNameRequest: 4294901995,
    UUIDNameReply: 4294901996,
    TeleportLocationRequest: 4294901823,
    TeleportLandmarkRequest: 4294901825,
    TeleportCancel: 4294901832,
    EnableSimulator: 4294901911,
    MapBlockRequest: 4294902167,
    MapNameRequest: 4294902168,
    MapBlockReply: 4294902169,
    MapItemRequest: 4294902170,
    MapItemReply: 4294902171,
    DataHomeLocationRequest: 4294901827,
    DataHomeLocationReply: 4294901828,
    AlertMessage: 4294901894,
    AgentAlertMessage: 4294901895,
    MeanCollisionAlert: 4294901896,
    ViewerFrozenMessage: 4294901897,
    HealthMessage: 4294901898,
    SimulatorViewerTimeMessage: 4294901910,
    DisableSimulator: 4294901912,
    ScriptQuestion: 4294901948,
    ScriptControlChange: 4294901949,
    ScriptDialog: 4294901950,
    MoneyBalanceReply: 4294902074,
    AgentGroupDataUpdate: 4294902149,
    MapLayerReply: 4294902166,
    ConfirmEnableSimulator: 65288,
    NeighborList: 3,
    AgentAnimation: 5,
    ImageData: 9,
    ImagePacket: 10,
    LayerData: 11,
    ObjectUpdate: 12,
    ObjectUpdateCompressed: 13,
    ObjectUpdateCached: 14,
    ImprovedTerseObjectUpdate: 15,
    KillObject: 16,
    AvatarAnimation: 20,
    SoundTrigger: 29,
    ObjectAnimation: 30,
    MultipleObjectUpdate: 65282,
    ObjectProperties: 65289,
    ObjectPropertiesFamily: 65290,
    AttachedSound: 65293,
    AttachedSoundGainChange: 65294,
    PreloadSound: 65295,
    ViewerEffect: 65297,
    EconomyDataRequest: 4294901784,
    EconomyData: 4294901785,
    ImageNotInDatabase: 4294901846,
    RebakeAvatarTextures: 4294901847,
    SimStats: 4294901900,
    AvatarAppearance: 4294901918,
    FeatureDisabled: 4294901779,
    LoadURL: 4294901954,
    ScriptTeleportRequest: 4294901955,
    ScriptDialogReply: 4294901951,
    ScriptAnswerYes: 4294901892,
    GenericMessage: 4294902021,
    LargeGenericMessage: 4294902190,
    GenericStreamingMessage: 31,
    AvatarSitResponse: 21,
    CameraConstraint: 22,
    ForceObjectSelect: 4294901965,
    DerezContainer: 4294901864,
    DeRezAck: 4294902052,
    MoneyBalanceRequest: 4294902073,
    ParcelAccessListReply: 4294901976,
    ParcelDwellReply: 4294901979,
    EstateCovenantReply: 4294901964,
    GrantGodlikePowers: 4294902018,
    RegionInfo: 4294901902,
    ParcelOverlay: 4294901956,
    ScriptRunningReply: 4294902004,
    ReplyTaskInventory: 4294902050,
    NameValuePair: 4294902089,
    RemoveNameValuePair: 4294902090,
    AgentWearablesUpdate: 4294902142,
    OnlineNotification: 4294902082,
    OfflineNotification: 4294902083,
    TelehubInfo: 4294901770,
    PayPriceReply: 4294901922,
    TerminateFriendship: 4294902060,
    OfferCallingCard: 4294902061,
    AcceptCallingCard: 4294902062,
    DeclineCallingCard: 4294902063,
    AvatarPickerRequest: 4294901786,
    AvatarPickerReply: 4294901788,
    DirFindQuery: 4294901791,
    DirPlacesQuery: 4294901793,
    DirPlacesReply: 4294901795,
    DirPeopleReply: 4294901796,
    DirGroupsReply: 4294901798,
    MoneyTransferRequest: 4294902071,
    ParcelMediaUpdate: 4294902180,
    AvatarClassifiedReply: 4294901802,
    AvatarPropertiesRequest: 4294901929,
    AvatarPropertiesReply: 4294901931,
    AvatarGroupsReply: 4294901933,
    AvatarNotesReply: 4294901936,
    AvatarPicksReply: 4294901938,
    GroupProfileRequest: 4294902111,
    GroupProfileReply: 4294902112,
    ClassifiedInfoRequest: 4294901803,
    ClassifiedInfoReply: 4294901804,
    PickInfoReply: 4294901944
  };

  const PacketFlags = { Ack: 0x10, Resent: 0x20, Reliable: 0x40, Zerocoded: 0x80 };
  const MsgFlags = { FrequencyHigh: 1, FrequencyMedium: 2, FrequencyLow: 4, FrequencyFixed: 8, Zerocoded: 16 };

  class UUID {
    constructor(bytes) {
      if (bytes instanceof UUID) {
        this.bytes = new Uint8Array(bytes.bytes);
      } else if (typeof bytes === 'string') {
        this.bytes = UUID.parse(bytes);
      } else {
        this.bytes = new Uint8Array(bytes);
      }
    }
    static zero() { return new UUID(new Uint8Array(16)); }
    static parse(str) {
      const hex = String(str).replace(/-/g, '');
      const out = new Uint8Array(16);
      for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return out;
    }
    toString() {
      const h = Array.from(this.bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' +
        h.slice(16, 20) + '-' + h.slice(20);
    }
    write(buf, pos) {
      buf.set(this.bytes, pos);
      return pos + 16;
    }
  }

  function utf8(s) { return te.encode(String(s)); }
  function fromUtf8(buf, start, len) { return td.decode(buf.subarray(start, start + len)); }

  function zerocodeEncode(buf, start, end) {
    let outLen = start;
    let zero = 0;
    for (let i = start; i <= end; i++) {
      if (buf[i] === 0) { zero++; continue; }
      if (zero > 0) { outLen += 2 * Math.ceil(zero / 255); zero = 0; }
      outLen++;
    }
    if (zero > 0) outLen += 2 * Math.ceil(zero / 255);
    const out = new Uint8Array(outLen);
    out.set(buf.subarray(0, start));
    let oi = start;
    zero = 0;
    for (let i = start; i <= end; i++) {
      if (buf[i] === 0) { zero++; continue; }
      while (zero > 0) { const run = zero > 255 ? 255 : zero; out[oi++] = 0; out[oi++] = run; zero -= run; }
      out[oi++] = buf[i];
    }
    while (zero > 0) { const run = zero > 255 ? 255 : zero; out[oi++] = 0; out[oi++] = run; zero -= run; }
    return out;
  }

  function zerocodeDecode(buf, start, end, tail) {
    let extra = 0;
    let zero = false;
    for (let i = start; i <= end; i++) {
      if (zero) { extra += buf[i] - 2; zero = false; }
      else if (buf[i] === 0 && i <= end - tail) zero = true;
    }
    const out = new Uint8Array(end + 1 + extra);
    out.set(buf.subarray(0, start));
    let oi = start;
    zero = false;
    for (let i = start; i <= end; i++) {
      if (zero) {
        zero = false;
        const n = buf[i];
        for (let z = 0; z < n; z++) out[oi++] = 0;
      } else if (buf[i] === 0 && i <= end - tail) {
        zero = true;
      } else {
        out[oi++] = buf[i];
      }
    }
    return out;
  }

  function writeMessageId(buf, pos, id, freq) {
    if (freq === MsgFlags.FrequencyHigh) {
      buf[pos++] = id & 0xFF;
      return pos;
    }
    if (freq === MsgFlags.FrequencyMedium) {
      buf[pos++] = 0xFF;
      buf[pos++] = id & 0xFF;
      return pos;
    }
    if (freq === MsgFlags.FrequencyLow) {
      buf[pos++] = 0xFF;
      buf[pos++] = 0xFF;
      const n = id & 0xFFFF;
      buf[pos++] = (n >> 8) & 0xFF;
      buf[pos++] = n & 0xFF;
      return pos;
    }
    const v = new DataView(buf.buffer, buf.byteOffset + pos, 4);
    v.setUint32(0, id, false);
    return pos + 4;
  }

  function readMessageId(buf, pos) {
    const first = buf[pos];
    if (first === 0xFF) {
      const second = buf[pos + 1];
      if (second === 0xFF) {
        const v = new DataView(buf.buffer, buf.byteOffset + pos, 4);
        return { id: v.getUint32(0, false), pos: pos + 4 };
      }
      return { id: (0xFF00 | second), pos: pos + 2 };
    }
    return { id: first, pos: pos + 1 };
  }

  function readVec3(buf, pos) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 12);
    return { x: dv.getFloat32(0, true), y: dv.getFloat32(4, true), z: dv.getFloat32(8, true), pos: pos + 12 };
  }

  function writeVec3(buf, pos, v) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 12);
    dv.setFloat32(0, v.x, true);
    dv.setFloat32(4, v.y, true);
    dv.setFloat32(8, v.z, true);
    return pos + 12;
  }

  function writeQuat(buf, pos, q) {
    return writeVec3(buf, pos, q || { x: 0, y: 0, z: 0 });
  }

  function normalize3(v) {
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  }

  function cross(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    };
  }

  function cameraAxes(lookAt) {
    const at = normalize3(lookAt || { x: 0, y: 1, z: 0 });
    const up = { x: 0, y: 0, z: 1 };
    let left = cross(up, at);
    if (Math.abs(left.x) + Math.abs(left.y) + Math.abs(left.z) < 0.001) {
      left = { x: 1, y: 0, z: 0 };
    } else {
      left = normalize3(left);
    }
    const camUp = normalize3(cross(at, left));
    return { at: at, left: left, up: camUp };
  }

  return {
    Message: Message,
    PacketFlags: PacketFlags,
    MsgFlags: MsgFlags,
    UUID: UUID,
    utf8: utf8,
    fromUtf8: fromUtf8,
    zerocodeEncode: zerocodeEncode,
    zerocodeDecode: zerocodeDecode,
    writeMessageId: writeMessageId,
    readMessageId: readMessageId,
    readVec3: readVec3,
    writeVec3: writeVec3,
    writeQuat: writeQuat,
    cameraAxes: cameraAxes
  };
})();
