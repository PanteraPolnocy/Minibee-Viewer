/**
 * Spatial voice (experimental). The WebView's own WebRTC stack carries the
 * audio: one RTCPeerConnection per region session, microphone via
 * getUserMedia, and the "SLData" data channel for join/position/participant
 * metadata. All authenticated signalling (provision, ICE trickle, logout)
 * goes through the Rust core.
 *
 * The grid's voice server mixes and spatialises server-side from the
 * positions we report, so the incoming stereo track is played as-is.
 *
 * Lifecycle: with the voice preference on (the default), login joins the
 * current region's voice LISTEN-ONLY - the offer carries a trackless audio
 * transceiver, so no microphone permission is asked until the first unmute.
 * The mic button then toggles the microphone; its menu leaves voice. A
 * teleport or region crossing reconnects to the new region while voice is
 * wanted.
 */
const BeeVoice = (function () {
  'use strict';

  const POSITION_INTERVAL_MS = 2000;
  const ICE_FLUSH_MS = 300;
  const RECONNECT_DELAY_MS = 2500;
  // A session that hasn't opened its data channel by now is stuck, not slow.
  const CONNECT_TIMEOUT_MS = 20000;

  let desired = false;     // the user wants voice on (survives region hops)
  let state = 'off';       // off | connecting | on
  let micMuted = true;
  let connectSeq = 0;

  let pc = null;           // RTCPeerConnection
  let dc = null;           // the SLData channel
  let micStream = null;    // acquired lazily, on the first unmute
  let micSender = null;    // the audio sender (carries silence until unmute)
  let micCtx = null;       // mic gain chain: source -> gain -> destination
  let micGain = null;
  let sentTrack = null;    // the processed track the sender actually carries
  let silentCtx = null;    // AudioContext behind the placeholder track
  let audioEl = null;      // remote audio sink
  let viewerSession = '';
  let parcelChannelId = null; // the parcel channel this session is on (null = estate)
  let joinedChannel = null;   // the channel the join went out on, against repeats
  let dataLogged = 0;      // first few data-channel messages go to the log

  let pendingIce = [];
  let iceDone = false;          // gathering finished; the marker still owed
  let iceDoneSent = false;
  let iceTimer = null;
  let posTimer = null;
  let reconnectTimer = null;
  let connectTimer = null;

  // agent id -> { speaking, level }; server messages key by agent UUID.
  const participants = new Map();

  // Per-person voice preferences (volume 0-200%, mute), persisted across
  // sessions and re-applied whenever that person joins a channel - the same
  // dance the standard client does with its speaker volume storage.
  const PEER_PREFS_KEY = 'minibee-voice-peers';
  let peerPrefs = null;

  function loadPeerPrefs() {
    if (!peerPrefs) {
      const raw = BeeUtils.storageGet(PEER_PREFS_KEY, null);
      peerPrefs = raw && typeof raw === 'object' ? raw : {};
    }
    return peerPrefs;
  }

  function peerPref(id) {
    const p = loadPeerPrefs()[String(id).toLowerCase()];
    return { volume: p && Number.isFinite(p.volume) ? p.volume : 100, muted: !!(p && p.muted) };
  }

  function savePeerPref(id, pref) {
    const prefs = loadPeerPrefs();
    const key = String(id).toLowerCase();
    if (pref.volume === 100 && !pref.muted) delete prefs[key];
    else prefs[key] = pref;
    BeeUtils.storageSet(PEER_PREFS_KEY, prefs);
  }

  // The wire scale: a 0-200% volume rides as gain 0-400 (percent x 2, the
  // standard client's volume x 200), mute as a plain boolean.
  function setUserVolume(id, percent) {
    const vol = Math.max(0, Math.min(200, Math.round(Number(percent) || 0)));
    const pref = peerPref(id);
    pref.volume = vol;
    savePeerPref(id, pref);
    const ug = {};
    ug[String(id).toLowerCase()] = vol * 2;
    sendDataAll({ ug: ug });
    emitParticipants();
  }

  function setUserMute(id, muted) {
    const pref = peerPref(id);
    pref.muted = !!muted;
    savePeerPref(id, pref);
    const m = {};
    m[String(id).toLowerCase()] = !!muted;
    sendDataAll({ m: m });
    emitParticipants();
  }

  function emitParticipants() {
    BeeTransport.emit('voice-participants', {
      participants: Array.from(participants, function (pair) {
        const pref = peerPref(pair[0]);
        return { id: pair[0], speaking: pair[1].speaking, level: pair[1].level, muted: pref.muted, volume: pref.volume };
      })
    });
  }

  // What the UI wants to know about one person, cheaply.
  function participantInfo(id) {
    const p = participants.get(String(id).toLowerCase());
    if (!p) return null;
    const pref = peerPref(id);
    return { speaking: p.speaking, level: p.level, muted: pref.muted, volume: pref.volume };
  }

  function el(id) { return document.getElementById(id); }

  // Every leg of the handshake logs here; with --enablelogfiles the "voice:"
  // lines say exactly where a connection died.
  function vlog(message) {
    if (typeof BeeDiag !== 'undefined' && BeeDiag.log) BeeDiag.log('voice', message);
  }

  function available() {
    return typeof BeeSettings !== 'undefined' && !!BeeSettings.get('voiceEnabled') &&
      BeeState.gridOnline() && !!window.RTCPeerConnection;
  }

  function emitState() {
    BeeTransport.emit('voice-state', { state: state, muted: micMuted, desired: desired });
    render();
  }

  // --- audio plumbing ---

  function ensureAudioSink() {
    if (audioEl) return audioEl;
    audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.hidden = true;
    document.body.appendChild(audioEl);
    applyVolume();
    applySink(audioEl);
    return audioEl;
  }

  // Route playback to the chosen output device, where the platform allows
  // picking one (setSinkId is Chromium-only; elsewhere the default plays).
  function applySink(el2) {
    const want = typeof BeeSettings !== 'undefined' ? String(BeeSettings.get('voiceOutputDevice') || '') : '';
    if (!el2 || typeof el2.setSinkId !== 'function') return;
    el2.setSinkId(want).catch(function (err) {
      vlog('output device rejected, using default: ' + err);
    });
  }

  // The device lists for the settings pickers. Labels only exist once the
  // microphone permission has been granted; numbered stand-ins otherwise.
  async function listDevices(kind) {
    const out = [['', 'System default']];
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return out;
      const devs = await navigator.mediaDevices.enumerateDevices();
      let n = 0;
      devs.forEach(function (d) {
        if (d.kind !== kind || !d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') return;
        n++;
        out.push([d.deviceId, d.label || ((kind === 'audioinput' ? 'Microphone ' : 'Output ') + n)]);
      });
    } catch (_e) { /* the default entry stands */ }
    return out;
  }

  // Drop the current microphone chain so the next unmute (or the immediate
  // re-acquire below, when the mic is live) picks up the newly chosen device.
  async function reacquireMic() {
    if (!micStream) return;
    const wasLive = !micMuted;
    if (micSender) { try { await micSender.replaceTrack(null); } catch (_e) {} }
    neighbourSessions.forEach(function (ns) {
      if (ns.sender) ns.sender.replaceTrack(null).catch(function () {});
    });
    if (callSession && callSession.sender) {
      callSession.sender.replaceTrack(null).catch(function () {});
    }
    if (micCtx) { try { micCtx.close(); } catch (_e) {} micCtx = null; }
    micGain = null;
    sentTrack = null;
    stopTracks();
    micMuted = true;
    emitState();
    if (wasLive && state === 'on') void setMicLive(true);
  }

  function voiceVolume() {
    const v = typeof BeeSettings !== 'undefined' ? Number(BeeSettings.get('voiceVolume')) : 80;
    return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 80));
  }

  function applyVolume() {
    if (audioEl) audioEl.volume = voiceVolume() / 100;
    neighbourSessions.forEach(function (ns) {
      if (ns.audioEl) ns.audioEl.volume = voiceVolume() / 100;
    });
    if (callSession && callSession.audioEl) callSession.audioEl.volume = voiceVolume() / 100;
    const slider = el('voice-volume') as HTMLInputElement | null;
    if (slider && slider.value !== String(voiceVolume())) slider.value = String(voiceVolume());
  }

  function applyMicMute() {
    if (sentTrack) sentTrack.enabled = !micMuted;
  }

  function micVolume() {
    const v = typeof BeeSettings !== 'undefined' ? Number(BeeSettings.get('voiceMicVolume')) : 100;
    return Math.max(0, Math.min(200, Number.isFinite(v) ? v : 100));
  }

  function applyMicVolume() {
    if (micGain) micGain.gain.value = micVolume() / 100;
  }

  // Post-unmute evidence for the log: is the microphone actually capturing
  // (media-source audioLevel) and is RTP actually leaving (outbound bytes)?
  function logSendStats(afterMs) {
    const seq = connectSeq;
    setTimeout(function () {
      if (seq !== connectSeq || !pc) return;
      pc.getStats().then(function (stats) {
        stats.forEach(function (r) {
          if (r.type === 'media-source' && r.kind === 'audio') {
            vlog('stats: mic capture level ' + (r.audioLevel != null ? Number(r.audioLevel).toFixed(4) : 'unknown'));
          } else if (r.type === 'outbound-rtp' && r.kind === 'audio') {
            const codec = r.codecId ? stats.get(r.codecId) : null;
            vlog('stats: audio out ' + r.packetsSent + ' packets, ' + r.bytesSent + ' bytes' +
              (r.targetBitrate ? ', target ' + r.targetBitrate + 'bps' : '') +
              (codec ? ', codec ' + codec.mimeType + '/' + codec.clockRate + ' ch' + (codec.channels || 1) +
                (codec.sdpFmtpLine ? ' [' + codec.sdpFmtpLine + ']' : '') : ''));
          }
        });
      }).catch(function () {});
    }, afterMs);
  }

  // Keep the offer's codec surface identical to the standard client's: plain
  // opus, no stereo request. Asking for stereo backfires - the server mirrors
  // the fmtp into its answer, which makes the browser ENCODE stereo uplink,
  // and the voice server's mic pipeline expects mono (spatial stereo downlink
  // arrives regardless; opus packets are self-describing).
  function preferOpusOnly(transceiver) {
    try {
      if (!transceiver || !transceiver.setCodecPreferences || !window.RTCRtpSender || !RTCRtpSender.getCapabilities) return;
      const caps = RTCRtpSender.getCapabilities('audio');
      if (!caps || !caps.codecs) return;
      const opus = caps.codecs.filter(function (c) {
        return /audio\/opus/i.test(c.mimeType);
      });
      if (opus.length) transceiver.setCodecPreferences(opus);
    } catch (e) {
      vlog('codec preference not applied: ' + e);
    }
  }

  // A permission-free stand-in for the microphone: a track rendering pure
  // silence, shared by every session's sender. The voice server expects
  // uplink RTP from a participant the way the standard client always provides
  // it (its mic track exists from the start); a trackless sender ships no
  // packets at all.
  let silentTrack = null;
  function silentPlaceholderTrack() {
    if (silentTrack && silentTrack.readyState === 'live') return silentTrack;
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    silentCtx = new Ctx();
    const dst = silentCtx.createMediaStreamDestination();
    // Nothing is connected to the destination, so it renders silence.
    if (silentCtx.state === 'suspended') {
      const resume = function () { if (silentCtx) silentCtx.resume().catch(function () {}); };
      resume();
      // Autoplay policy can hold the context until a gesture lands somewhere.
      document.addEventListener('pointerdown', resume, { once: true });
    }
    silentTrack = dst.stream.getAudioTracks()[0] || null;
    return silentTrack;
  }

  // --- signalling ---

  function queueIce(candidate) {
    if (candidate && candidate.candidate) {
      // Browsers obfuscate host candidates as mDNS names (xxxx.local). The
      // voice service cannot resolve a peer's mDNS - the standard client's
      // WebRTC build never sends such candidates - so they are dead weight at
      // best and indigestible at worst. STUN reflexive candidates carry the
      // real reachable address.
      if (candidate.candidate.indexOf('.local') !== -1) {
        vlog('ice: skipping mDNS candidate');
        return;
      }
      pendingIce.push({
        sdpMid: candidate.sdpMid || '',
        sdpMLineIndex: candidate.sdpMLineIndex || 0,
        candidate: candidate.candidate
      });
    } else {
      // A null candidate marks the end of gathering. The flag persists until
      // actually delivered - gathering usually finishes before provisioning
      // has handed us the session id to deliver it under.
      iceDone = true;
    }
    scheduleIceFlush();
  }

  function scheduleIceFlush() {
    const seq = connectSeq;
    if (iceTimer) clearTimeout(iceTimer);
    iceTimer = setTimeout(function () {
      iceTimer = null;
      if (seq !== connectSeq) return;
      if (!viewerSession) return; // provisioning re-schedules once it has one
      const batch = pendingIce;
      pendingIce = [];
      // Candidates and the completed marker ride SEPARATE requests - the
      // standard client never combines them, and the sim has been seen to
      // never answer a request carrying both.
      if (batch.length) {
        vlog('ice: sending ' + batch.length + ' candidate(s)');
        BeeBridge.invoke('sl_voice_ice', {
          viewerSession: viewerSession,
          candidates: batch,
          completed: false
        }).then(function () {
          if (seq === connectSeq && iceDone && !iceDoneSent) scheduleIceFlush();
        }).catch(function (err) {
          vlog('ice: send failed: ' + (BeeUtils.errText(err) || err));
        });
        return;
      }
      if (iceDone && !iceDoneSent) {
        iceDoneSent = true;
        vlog('ice: sending completed marker');
        BeeBridge.invoke('sl_voice_ice', {
          viewerSession: viewerSession,
          candidates: [],
          completed: true
        }).catch(function (err) {
          vlog('ice: completed-marker send failed: ' + (BeeUtils.errText(err) || err));
        });
      }
    }, iceDone ? 0 : ICE_FLUSH_MS);
  }

  // Vanilla (non-trickle) ICE: with gathering already finished, the offer SDP
  // itself carries every candidate, and the flaky signalling cap is not
  // needed at all. Gathering against the STUN pool takes a few hundred ms.
  function waitForIceGathering(conn, timeoutMs) {
    if (conn.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(function (resolve) {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        conn.removeEventListener('icegatheringstatechange', check);
        resolve(undefined);
      }
      function check() {
        if (conn.iceGatheringState === 'complete') done();
      }
      conn.addEventListener('icegatheringstatechange', check);
    });
  }

  // --- data channel ---

  function sendData(obj) {
    if (dc && dc.readyState === 'open') {
      try { dc.send(JSON.stringify(obj)); } catch (_e) { /* channel died; state machine handles it */ }
    }
  }

  // Positions and per-person settings go to every connected voice server -
  // the primary region's and each neighbour's - like the standard client's
  // per-session broadcast.
  function sendDataAll(obj) {
    const text = JSON.stringify(obj);
    if (dc && dc.readyState === 'open') {
      try { dc.send(text); } catch (_e) {}
    }
    neighbourSessions.forEach(function (ns) {
      if (ns.dc && ns.dc.readyState === 'open') {
        try { ns.dc.send(text); } catch (_e) {}
      }
    });
    if (callSession && callSession.dc && callSession.dc.readyState === 'open') {
      try { callSession.dc.send(text); } catch (_e) {}
    }
  }

  async function sendPosition() {
    try {
      const res = await BeeBridge.invoke('sl_voice_position');
      if (!res || !res.ok || !res.position) return;
      const p = res.position;
      // Integers of centimeters; the heading stays identity - Minibee has no
      // camera, so the avatar simply faces "forward".
      const v = { x: Math.round(p[0] * 100), y: Math.round(p[1] * 100), z: Math.round(p[2] * 100) };
      // The avatar's body rotation, so the server pans by facing too.
      const r = res.rotation || [0, 0, 0, 1];
      const h = {
        x: Math.round(r[0] * 100), y: Math.round(r[1] * 100),
        z: Math.round(r[2] * 100), w: Math.round(r[3] * 100)
      };
      sendDataAll({ sp: v, sh: h, lp: v, lh: h });
    } catch (_e) { /* between regions; the next tick retries */ }
    manageNeighbours();
  }

  function handleData(text, anyJoin?: boolean) {
    let doc;
    try { doc = JSON.parse(text); } catch (_e) { return; }
    if (!doc || typeof doc !== 'object') return;
    let changed = false;
    // Stored per-person prefs get pushed back to the server as people join,
    // the way the standard client re-applies its mutes and speaker volumes.
    const muteOut = {};
    const gainOut = {};
    let outAny = false;
    Object.keys(doc).forEach(function (id) {
      const entry = doc[id];
      if (!entry || typeof entry !== 'object' || !/^[0-9a-f-]{36}$/i.test(id)) return;
      const key = id.toLowerCase();
      if (entry.l === true) {
        changed = participants.delete(key) || changed;
        return;
      }
      if (typeof entry.V === 'string') {
        // The server acknowledges our join by answering with its version.
        vlog('join acknowledged; server version ' + entry.V);
      }
      let p = participants.get(key);
      // Only a join flagged primary announces a person for real - the same
      // person shows up on neighbouring servers too, without the flag. Calls
      // (ad-hoc channels) accept every join instead.
      if (!p && entry.j && (anyJoin || entry.j.p === true)) {
        p = { speaking: false, level: 0 };
        participants.set(key, p);
        changed = true;
        const pref = peerPref(key);
        if (pref.muted) {
          muteOut[key] = true;
          outAny = true;
        }
        if (pref.volume !== 100) {
          gainOut[key] = pref.volume * 2;
          outAny = true;
        }
      }
      if (!p) return;
      if (typeof entry.p === 'number') {
        p.level = entry.p / 128;
      }
      if (typeof entry.v === 'boolean' && p.speaking !== entry.v) {
        p.speaking = entry.v;
        changed = true;
      }
    });
    if (outAny) {
      const out: any = {};
      if (Object.keys(muteOut).length) out.m = muteOut;
      if (Object.keys(gainOut).length) out.ug = gainOut;
      sendDataAll(out);
    }
    if (changed) emitParticipants();
  }

  // --- lifecycle ---

  async function connect(auto?: boolean) {
    // One channel at a time: no spatial voice while a call runs.
    if (state !== 'off' || inCall() || !available()) return;
    const seq = ++connectSeq;
    state = 'connecting';
    pendingIce = [];
    iceDone = false;
    iceDoneSent = false;
    emitState();
    vlog('connect: starting (' + (auto ? 'auto' : 'manual') + ')');
    connectTimer = setTimeout(function () {
      connectTimer = null;
      if (seq !== connectSeq || state !== 'connecting') return;
      vlog('connect: timed out waiting for the data channel');
      scheduleReconnect(auto ? '' : 'Voice took too long to connect.');
    }, CONNECT_TIMEOUT_MS);
    try {
      const stun = await BeeBridge.invoke('sl_voice_stun');
      if (seq !== connectSeq) return;
      const servers = (stun && stun.servers) || [];
      vlog('connect: ' + servers.length + ' STUN server(s)');
      pc = new RTCPeerConnection(servers.length ? { iceServers: [{ urls: servers }] } : undefined);

      function channelUp() {
        if (seq !== connectSeq || joinedChannel === dc) return;
        joinedChannel = dc;
        vlog('data channel up ("' + (dc ? dc.label : '?') + '"); joining');
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        // Join the way the standard client does: announce arrival first, then
        // claim primary for the region we stand in - two messages, in order.
        sendData({ j: {} });
        sendData({ j: { p: true } });
        void sendPosition();
        if (posTimer) clearInterval(posTimer);
        posTimer = setInterval(function () { void sendPosition(); }, POSITION_INTERVAL_MS);
        // Baseline send stats while the placeholder is still the track.
        logSendStats(8000);
        if (state !== 'on') {
          state = 'on';
          emitState();
        }
        // With the primary session up, border listening can come online.
        refreshNeighbourList();
      }

      function bindDataChannel(ch) {
        dc = ch;
        ch.onopen = channelUp;
        ch.onmessage = function (e) {
          if (seq !== connectSeq || typeof e.data !== 'string') return;
          if (dataLogged < 3) {
            dataLogged++;
            vlog('data: ' + e.data.slice(0, 200));
          }
          handleData(e.data);
        };
        if (ch.readyState === 'open') channelUp();
      }

      // Our channel negotiates the SCTP transport; if the server announces
      // its own channel, adopt it - the standard client swaps the same way,
      // and the voice server talks on the channel it opened.
      bindDataChannel(pc.createDataChannel('SLData', { ordered: true }));
      pc.ondatachannel = function (e) {
        if (seq !== connectSeq) return;
        vlog('server opened data channel "' + e.channel.label + '"; adopting it');
        bindDataChannel(e.channel);
      };
      // Listen-only join that still transmits: a silent placeholder track
      // keeps uplink RTP flowing the way the standard client's always-present
      // mic track does, without touching the microphone until the first
      // unmute (which swaps the real track in via replaceTrack).
      micMuted = true;
      const silent = silentPlaceholderTrack();
      if (silent) {
        micSender = pc.addTrack(silent, new MediaStream([silent]));
      } else {
        micSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      }
      pc.getTransceivers().forEach(function (t) {
        if (t.sender === micSender) preferOpusOnly(t);
      });
      pc.ontrack = function (e) {
        if (seq !== connectSeq) return;
        vlog('remote audio track arrived');
        const sink = ensureAudioSink();
        sink.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
        applyVolume();
        const p = sink.play();
        if (p && p.catch) p.catch(function (err) { vlog('audio play refused: ' + err); });
      };
      pc.onicecandidate = function (e) {
        if (seq === connectSeq) queueIce(e.candidate);
      };
      pc.onconnectionstatechange = function () {
        if (seq !== connectSeq || !pc) return;
        vlog('peer connection state: ' + pc.connectionState);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          scheduleReconnect('The voice connection dropped.');
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Let gathering finish so the offer carries the candidates inline;
      // anything late still trickles through the signalling cap.
      await waitForIceGathering(pc, 3000);
      if (seq !== connectSeq) return;
      const localSdp = (pc.localDescription && pc.localDescription.sdp) || offer.sdp || '';
      if (pc.iceGatheringState === 'complete') {
        // Everything is in the SDP, end-of-candidates included; nothing left
        // for the signalling cap to carry.
        pendingIce = [];
        iceDone = true;
        iceDoneSent = true;
      }
      vlog('offer ready (' + localSdp.length + ' bytes, gathering ' + pc.iceGatheringState + '); provisioning');
      const res = await BeeBridge.invoke('sl_voice_provision', { offer: localSdp });
      if (seq !== connectSeq) return;
      viewerSession = String(res.viewerSession || '');
      parcelChannelId = res.parcelLocalId != null ? Number(res.parcelLocalId) : null;
      vlog('provisioned; viewer session ' + viewerSession.slice(0, 13) + '..., channel ' +
        (parcelChannelId === null ? 'estate' : 'parcel ' + parcelChannelId) + ', applying answer');
      await pc.setRemoteDescription({ type: 'answer', sdp: String(res.sdp || '') });
      // Candidates gathered before the session id existed can go out now.
      scheduleIceFlush();
    } catch (err) {
      if (seq !== connectSeq) return;
      vlog('connect failed: ' + (BeeUtils.errText(err) || err));
      teardown();
      emitState();
      // The automatic login-time join stays quiet when a region simply has no
      // voice; a deliberate tap deserves the reason.
      if (!auto) {
        desired = false;
        BeeUtils.showToast(BeeUtils.errText(err) || 'Voice could not connect.', 'error');
      }
    }
  }

  function stopTracks() {
    if (micStream) {
      micStream.getTracks().forEach(function (t) { t.stop(); });
      micStream = null;
    }
  }

  function teardown() {
    connectSeq++;
    if (iceTimer) { clearTimeout(iceTimer); iceTimer = null; }
    if (posTimer) { clearInterval(posTimer); posTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    pendingIce = [];
    iceDone = false;
    iceDoneSent = false;
    if (viewerSession) {
      const vs = viewerSession;
      viewerSession = '';
      if (BeeState.gridOnline()) {
        BeeBridge.invoke('sl_voice_logout', { viewerSession: vs }).catch(function () {});
      }
    }
    if (dc) { try { dc.close(); } catch (_e) {} dc = null; }
    if (pc) { try { pc.close(); } catch (_e) {} pc = null; }
    closeAllNeighbours();
    micSender = null;
    if (silentCtx) { try { silentCtx.close(); } catch (_e) {} silentCtx = null; }
    silentTrack = null;
    if (micCtx) { try { micCtx.close(); } catch (_e) {} micCtx = null; }
    micGain = null;
    sentTrack = null;
    stopTracks();
    micMuted = true;
    dataLogged = 0;
    parcelChannelId = null;
    joinedChannel = null;
    if (audioEl) audioEl.srcObject = null;
    if (participants.size) {
      participants.clear();
      emitParticipants();
    }
    state = 'off';
  }

  // A region hop (or a dropped connection) restarts voice against the new
  // region, as long as the user still wants it on.
  function scheduleReconnect(reason) {
    teardown();
    emitState();
    if (!desired) return;
    if (reason) BeeUtils.showToast(reason + ' Reconnecting voice...', 'warning');
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (desired && state === 'off' && available()) void connect(true);
    }, RECONNECT_DELAY_MS);
  }

  // --- neighbour regions -----------------------------------------------------
  // Spatial voice continues across region borders: each voice-capable
  // neighbour gets its own peer connection (to ITS voice server, estate
  // channel) while the avatar stands within earshot of that edge. Join at
  // 50m from the border, leave at 60m - the gap stops flapping on the line.

  const NEIGHBOUR_JOIN_M = 50;
  const NEIGHBOUR_LEAVE_M = 60;

  const neighbourSessions = new Map(); // key -> { key, gen, pc, dc, viewerSession, sender, audioEl, joined }
  let availableNeighbours = [];        // { key, gridX, gridY } from the core
  const neighbourCooldown = new Map(); // key -> earliest retry time after a failure

  function neighbourWanted(n, margin) {
    const region = BeeState.get().region;
    const pos = BeeState.get().position;
    if (!region || !pos || !Number.isFinite(Number(region.gridX))) return false;
    const dx = Number(n.gridX) - Number(region.gridX);
    const dy = Number(n.gridY) - Number(region.gridY);
    if ((dx === 0 && dy === 0) || Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
    const nearX = dx === -1 ? pos.x <= margin : dx === 1 ? pos.x >= 256 - margin : true;
    const nearY = dy === -1 ? pos.y <= margin : dy === 1 ? pos.y >= 256 - margin : true;
    return nearX && nearY;
  }

  function manageNeighbours() {
    if (state !== 'on') return;
    availableNeighbours.forEach(function (n) {
      const existing = neighbourSessions.get(n.key);
      if (!existing && neighbourWanted(n, NEIGHBOUR_JOIN_M)) {
        const until = neighbourCooldown.get(n.key) || 0;
        if (Date.now() >= until) void openNeighbour(n);
      } else if (existing && !neighbourWanted(n, NEIGHBOUR_LEAVE_M)) {
        vlog('neighbour ' + n.key + ': out of earshot, leaving');
        closeNeighbour(n.key);
      }
    });
    // A neighbour that vanished from the list (region change churn) closes too.
    neighbourSessions.forEach(function (_ns, key) {
      if (!availableNeighbours.some(function (n) { return n.key === key; })) closeNeighbour(key);
    });
  }

  async function openNeighbour(n) {
    const ns: any = { key: n.key, gen: ++connectSeq, pc: null, dc: null, viewerSession: '', sender: null, audioEl: null, joined: null };
    neighbourSessions.set(n.key, ns);
    vlog('neighbour ' + n.key + ': connecting');
    try {
      const stun = await BeeBridge.invoke('sl_voice_stun');
      if (neighbourSessions.get(n.key) !== ns) return;
      const servers = (stun && stun.servers) || [];
      const pc2 = new RTCPeerConnection(servers.length ? { iceServers: [{ urls: servers }] } : undefined);
      ns.pc = pc2;

      function nsChannelUp() {
        if (neighbourSessions.get(n.key) !== ns || ns.joined === ns.dc) return;
        ns.joined = ns.dc;
        // Never primary: this is a listening post on someone else's region.
        try { ns.dc.send(JSON.stringify({ j: {} })); } catch (_e) {}
        vlog('neighbour ' + n.key + ': data channel up');
      }
      function nsBind(ch) {
        ns.dc = ch;
        ch.onopen = nsChannelUp;
        ch.onmessage = function (e) {
          if (neighbourSessions.get(n.key) === ns && typeof e.data === 'string') handleData(e.data);
        };
        if (ch.readyState === 'open') nsChannelUp();
      }
      nsBind(pc2.createDataChannel('SLData', { ordered: true }));
      pc2.ondatachannel = function (e) {
        if (neighbourSessions.get(n.key) === ns) nsBind(e.channel);
      };

      const track = sentTrack || silentPlaceholderTrack();
      if (track) ns.sender = pc2.addTrack(track, new MediaStream([track]));
      else ns.sender = pc2.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      pc2.getTransceivers().forEach(function (t) {
        if (t.sender === ns.sender) preferOpusOnly(t);
      });
      pc2.ontrack = function (e) {
        if (neighbourSessions.get(n.key) !== ns) return;
        if (!ns.audioEl) {
          ns.audioEl = document.createElement('audio');
          ns.audioEl.autoplay = true;
          ns.audioEl.hidden = true;
          document.body.appendChild(ns.audioEl);
        }
        ns.audioEl.volume = voiceVolume() / 100;
        applySink(ns.audioEl);
        ns.audioEl.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
        const p = ns.audioEl.play();
        if (p && p.catch) p.catch(function () {});
      };
      pc2.onconnectionstatechange = function () {
        if (neighbourSessions.get(n.key) !== ns || !ns.pc) return;
        if (ns.pc.connectionState === 'failed' || ns.pc.connectionState === 'closed') {
          vlog('neighbour ' + n.key + ': connection ' + ns.pc.connectionState);
          neighbourCooldown.set(n.key, Date.now() + 15000);
          closeNeighbour(n.key);
        }
      };

      const offer = await pc2.createOffer();
      await pc2.setLocalDescription(offer);
      await waitForIceGathering(pc2, 3000);
      if (neighbourSessions.get(n.key) !== ns) return;
      if (pc2.iceGatheringState !== 'complete') {
        vlog('neighbour ' + n.key + ': gathering incomplete, proceeding anyway');
      }
      const localSdp = (pc2.localDescription && pc2.localDescription.sdp) || offer.sdp || '';
      const res = await BeeBridge.invoke('sl_voice_provision', { offer: localSdp, neighbour: n.key });
      if (neighbourSessions.get(n.key) !== ns) return;
      ns.viewerSession = String(res.viewerSession || '');
      await pc2.setRemoteDescription({ type: 'answer', sdp: String(res.sdp || '') });
      vlog('neighbour ' + n.key + ': provisioned');
    } catch (err) {
      vlog('neighbour ' + n.key + ': failed: ' + (BeeUtils.errText(err) || err));
      neighbourCooldown.set(n.key, Date.now() + 30000);
      closeNeighbour(n.key);
    }
  }

  function closeNeighbour(key) {
    const ns = neighbourSessions.get(key);
    if (!ns) return;
    neighbourSessions.delete(key);
    if (ns.viewerSession && BeeState.gridOnline()) {
      BeeBridge.invoke('sl_voice_logout', { viewerSession: ns.viewerSession, neighbour: key }).catch(function () {});
    }
    if (ns.dc) { try { ns.dc.close(); } catch (_e) {} }
    if (ns.pc) { try { ns.pc.close(); } catch (_e) {} }
    if (ns.audioEl) {
      ns.audioEl.srcObject = null;
      ns.audioEl.remove();
    }
  }

  function closeAllNeighbours() {
    Array.from(neighbourSessions.keys()).forEach(closeNeighbour);
    neighbourCooldown.clear();
  }

  function refreshNeighbourList() {
    BeeBridge.invoke('sl_voice_neighbours').then(function (res) {
      availableNeighbours = (res && res.neighbours) || [];
      manageNeighbours();
    }).catch(function () {});
  }

  // --- calls (P2P / conference / group) ---------------------------------------
  // A call is an ad-hoc ("multiagent") channel keyed by the chat session:
  // groups and conferences call their own session; a P2P call rides a
  // conference containing just the two of you (how the standard client does
  // WebRTC P2P). While a call runs, spatial voice is suspended - one channel
  // at a time, like the standard client.

  let callSession = null; // { sessionId, title, gen, pc, dc, viewerSession, sender, audioEl, joined }
  let spatialWasDesired = false;

  function inCall() {
    return !!callSession;
  }

  function emitCallState() {
    BeeTransport.emit('voice-call', callSession
      ? { active: true, sessionId: callSession.sessionId, title: callSession.title, connected: callSession.up === true }
      : { active: false });
    render();
  }

  // `origin` names the thread the user acted on when it differs from the
  // call's own session - a P2P call rides a fresh conference session, but the
  // IM tab it belongs to is the person's. `p2p` turns on call semantics for
  // two people: ring timeout and hang-up when the other side leaves.
  async function startCall(sessionId, title, origin?, p2p?) {
    if (callSession) {
      BeeUtils.showToast('Already in a voice call.', 'warning');
      return;
    }
    if (!BeeState.gridOnline() || !window.RTCPeerConnection) return;
    try {
      let res;
      try {
        res = await BeeBridge.invoke('sl_voice_call_request', { sessionId: sessionId });
      } catch (first) {
        // A session confirmed a moment ago can still be settling sim-side;
        // one retry covers that window before giving up.
        vlog('call: request failed once (' + (BeeUtils.errText(first) || first) + '); retrying');
        await new Promise(function (r) { setTimeout(r, 1500); });
        res = await BeeBridge.invoke('sl_voice_call_request', { sessionId: sessionId });
      }
      await joinCallChannel(sessionId, title, String(res.channelUri || ''), String(res.credentials || ''), origin, p2p);
    } catch (err) {
      BeeUtils.showToast(BeeUtils.errText(err) || 'The call could not be started.', 'error');
    }
  }

  // A person-to-person call: "start p2p voice" on the existing IM session id
  // (no conference is created - the IM tab stays exactly what it was). The
  // channel arrives asynchronously as a voice-call-ready event.
  let pendingP2P = null; // { sessionId, title, timer }

  async function startP2PCall(sessionId, peerId, title) {
    if (callSession) {
      BeeUtils.showToast('Already in a voice call.', 'warning');
      return;
    }
    if (!BeeState.gridOnline() || !window.RTCPeerConnection) return;
    if (pendingP2P) {
      clearTimeout(pendingP2P.timer);
      pendingP2P = null;
    }
    const key = String(sessionId).toLowerCase();
    pendingP2P = {
      sessionId: key,
      title: title,
      timer: setTimeout(function () {
        if (pendingP2P && pendingP2P.sessionId === key) {
          pendingP2P = null;
          vlog('call: p2p setup timed out');
          BeeUtils.showToast('The call could not be set up in time.', 'error');
        }
      }, 20000)
    };
    try {
      await BeeBridge.invoke('sl_voice_call_p2p', { sessionId: sessionId, peerId: peerId });
      BeeUtils.showToast('Calling ' + (title || '...') + '...', 'info');
    } catch (err) {
      if (pendingP2P && pendingP2P.sessionId === key) {
        clearTimeout(pendingP2P.timer);
        pendingP2P = null;
      }
      BeeUtils.showToast(BeeUtils.errText(err) || 'The call could not be started.', 'error');
    }
  }

  async function answerCall(invite) {
    if (callSession) {
      BeeUtils.showToast('Already in a voice call.', 'warning');
      return;
    }
    // invitation_type 2 marks a person-to-person call on the wire.
    const p2p = Number(invite.invitationType) === 2;
    await joinCallChannel(
      String(invite.sessionId || ''),
      String(invite.sessionName || invite.fromName || 'Voice call'),
      String(invite.channelUri || ''),
      String(invite.credentials || ''),
      '',
      p2p
    );
  }

  async function joinCallChannel(sessionId, title, channelUri, credentials, origin?, p2p?) {
    if (!channelUri) {
      BeeUtils.showToast('The call carried no voice channel.', 'error');
      return;
    }
    // One channel at a time: spatial voice pauses for the call.
    spatialWasDesired = desired;
    desired = false;
    teardown();
    const cs: any = { sessionId: sessionId, title: title, origin: origin || '', p2p: !!p2p, peerJoined: false, noAnswerTimer: null, gen: ++connectSeq, pc: null, dc: null, viewerSession: '', sender: null, audioEl: null, joined: null, up: false };
    callSession = cs;
    emitCallState();
    vlog('call: connecting to ' + channelUri);
    try {
      const stun = await BeeBridge.invoke('sl_voice_stun');
      if (callSession !== cs) return;
      const servers = (stun && stun.servers) || [];
      const pc2 = new RTCPeerConnection(servers.length ? { iceServers: [{ urls: servers }] } : undefined);
      cs.pc = pc2;

      function csChannelUp() {
        if (callSession !== cs || cs.joined === cs.dc) return;
        cs.joined = cs.dc;
        try { cs.dc.send(JSON.stringify({ j: { p: true } })); } catch (_e) {}
        cs.up = true;
        vlog('call: data channel up');
        void sendPosition();
        if (posTimer) clearInterval(posTimer);
        posTimer = setInterval(function () { void sendPosition(); }, POSITION_INTERVAL_MS);
        emitCallState();
        if (cs.p2p) {
          // We're in the channel; the other side hasn't picked up yet.
          BeeUtils.showToast('Ringing...', 'info');
          cs.noAnswerTimer = setTimeout(function () {
            if (callSession === cs && !cs.peerJoined) endCall('No answer.');
          }, 45000);
        } else {
          BeeUtils.showToast('Voice call connected.', 'success');
        }
      }
      // P2P call semantics from the participant roster: "connected" once the
      // other side actually joins, hang up once everyone else has left.
      function csWatchParticipants() {
        if (callSession !== cs || !cs.p2p) return;
        const self = String((BeeState.get().agent || {}).id || '').toLowerCase();
        let others = 0;
        participants.forEach(function (_v, id) {
          if (id !== self) others++;
        });
        if (others > 0 && !cs.peerJoined) {
          cs.peerJoined = true;
          if (cs.noAnswerTimer) { clearTimeout(cs.noAnswerTimer); cs.noAnswerTimer = null; }
          vlog('call: peer joined');
          BeeUtils.showToast('Call connected.', 'success');
        } else if (others === 0 && cs.peerJoined) {
          endCall('The call ended.');
        }
      }
      function csBind(ch) {
        cs.dc = ch;
        ch.onopen = csChannelUp;
        ch.onmessage = function (e) {
          // Calls accept every join: participants in an ad-hoc channel have
          // no "primary server" distinction.
          if (callSession === cs && typeof e.data === 'string') {
            handleData(e.data, true);
            csWatchParticipants();
          }
        };
        if (ch.readyState === 'open') csChannelUp();
      }
      csBind(pc2.createDataChannel('SLData', { ordered: true }));
      pc2.ondatachannel = function (e) {
        if (callSession === cs) csBind(e.channel);
      };

      const track = sentTrack || silentPlaceholderTrack();
      if (track) cs.sender = pc2.addTrack(track, new MediaStream([track]));
      else cs.sender = pc2.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      pc2.getTransceivers().forEach(function (t) {
        if (t.sender === cs.sender) preferOpusOnly(t);
      });
      pc2.ontrack = function (e) {
        if (callSession !== cs) return;
        if (!cs.audioEl) {
          cs.audioEl = document.createElement('audio');
          cs.audioEl.autoplay = true;
          cs.audioEl.hidden = true;
          document.body.appendChild(cs.audioEl);
        }
        cs.audioEl.volume = voiceVolume() / 100;
        applySink(cs.audioEl);
        cs.audioEl.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
        const p = cs.audioEl.play();
        if (p && p.catch) p.catch(function () {});
      };
      pc2.onconnectionstatechange = function () {
        if (callSession !== cs || !cs.pc) return;
        vlog('call: peer connection state ' + cs.pc.connectionState);
        if (cs.pc.connectionState === 'failed' || cs.pc.connectionState === 'closed') {
          endCall('The call dropped.');
        }
      };

      const offer = await pc2.createOffer();
      await pc2.setLocalDescription(offer);
      await waitForIceGathering(pc2, 3000);
      if (callSession !== cs) return;
      const localSdp = (pc2.localDescription && pc2.localDescription.sdp) || offer.sdp || '';
      const res = await BeeBridge.invoke('sl_voice_call_provision', {
        offer: localSdp, channel: channelUri, credentials: credentials
      });
      if (callSession !== cs) return;
      cs.viewerSession = String(res.viewerSession || '');
      await pc2.setRemoteDescription({ type: 'answer', sdp: String(res.sdp || '') });
      vlog('call: provisioned; viewer session ' + cs.viewerSession.slice(0, 13) + '...');
    } catch (err) {
      if (callSession !== cs) return;
      vlog('call: failed: ' + (BeeUtils.errText(err) || err));
      endCall('');
      BeeUtils.showToast(BeeUtils.errText(err) || 'The call could not connect.', 'error');
    }
  }

  function endCall(reason) {
    const cs = callSession;
    if (!cs) return;
    callSession = null;
    if (cs.noAnswerTimer) { clearTimeout(cs.noAnswerTimer); cs.noAnswerTimer = null; }
    if (posTimer) { clearInterval(posTimer); posTimer = null; }
    if (cs.viewerSession && BeeState.gridOnline()) {
      BeeBridge.invoke('sl_voice_logout', { viewerSession: cs.viewerSession, neighbour: null }).catch(function () {});
    }
    if (cs.dc) { try { cs.dc.close(); } catch (_e) {} }
    if (cs.pc) { try { cs.pc.close(); } catch (_e) {} }
    if (cs.audioEl) {
      cs.audioEl.srcObject = null;
      cs.audioEl.remove();
    }
    if (participants.size) {
      participants.clear();
      emitParticipants();
    }
    // A call that rode a throwaway conference (an incoming ad-hoc invite)
    // leaves an empty shell tab behind - close it when nothing was typed.
    // P2P calls live on the person's own IM session, which always stays.
    if (cs.p2p && cs.sessionId) {
      const shell = BeeState.get().imSessions[cs.sessionId];
      if (shell && shell.type === 'conference' && (!shell.messages || !shell.messages.length)) {
        if (typeof BeeTransport.leaveImSession === 'function') BeeTransport.leaveImSession(cs.sessionId);
        BeeState.closeImSession(cs.sessionId);
      }
    }
    vlog('call: ended' + (reason ? ' (' + reason + ')' : ''));
    if (reason) BeeUtils.showToast(reason, 'warning');
    emitCallState();
    // Nearby voice comes back after the call - both when it was on before,
    // and whenever the preference is on (the same rule the login auto-join
    // follows), so a call can never leave voice silently dead.
    const wantSpatial = spatialWasDesired ||
      (typeof BeeSettings !== 'undefined' && !!BeeSettings.get('voiceEnabled'));
    spatialWasDesired = false;
    if (wantSpatial) {
      desired = true;
      vlog('call: resuming nearby voice');
      if (available()) void connect(true);
    }
  }

  function join() {
    desired = true;
    void connect(false);
  }

  // Login-time join, quiet on regions without voice. Runs only while the
  // preference is on and the user hasn't left voice this session.
  function maybeAutoJoin() {
    if (!available() || desired || state !== 'off') return;
    desired = true;
    void connect(true);
  }

  function leave() {
    desired = false;
    teardown();
    emitState();
  }

  // Unmuting for the first time is what actually asks for the microphone;
  // until then the session is listen-only and permission-free.
  async function setMicLive(live) {
    if (state !== 'on' && !inCall()) return;
    if (!live) {
      micMuted = true;
      applyMicMute();
      emitState();
      BeeUtils.showToast('Microphone muted.', 'warning');
      return;
    }
    if (!micStream) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        BeeUtils.showToast('This platform offers no microphone access.', 'error');
        return;
      }
      try {
        const wantDevice = typeof BeeSettings !== 'undefined' ? String(BeeSettings.get('voiceMicDevice') || '') : '';
        const audio: any = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        if (wantDevice) audio.deviceId = { exact: wantDevice };
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: audio });
        } catch (err) {
          // The chosen device may be gone (unplugged headset); the default
          // beats a dead mic.
          if (!wantDevice) throw err;
          vlog('chosen microphone unavailable, falling back to default');
          delete audio.deviceId;
          micStream = await navigator.mediaDevices.getUserMedia({ audio: audio });
        }
        const track = micStream.getAudioTracks()[0];
        if ((state !== 'on' && !inCall()) || !track) {
          stopTracks();
          return;
        }
        // Mic -> gain -> sender: the gain node is the Microphone volume
        // setting; the unmute click is the user gesture that lets the
        // context run.
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        micCtx = new Ctx();
        if (micCtx.state === 'suspended') micCtx.resume().catch(function () {});
        const src = micCtx.createMediaStreamSource(micStream);
        micGain = micCtx.createGain();
        applyMicVolume();
        const dst = micCtx.createMediaStreamDestination();
        // Mono, like every microphone track the voice server normally sees.
        try {
          dst.channelCount = 1;
          dst.channelCountMode = 'explicit';
        } catch (_e) { /* stereo destination still works */ }
        src.connect(micGain);
        micGain.connect(dst);
        sentTrack = dst.stream.getAudioTracks()[0];
        // Every connected session speaks with the same microphone.
        if (micSender) await micSender.replaceTrack(sentTrack);
        neighbourSessions.forEach(function (ns) {
          if (ns.sender) ns.sender.replaceTrack(sentTrack).catch(function () {});
        });
        if (callSession && callSession.sender) {
          await callSession.sender.replaceTrack(sentTrack);
        }
        vlog('microphone attached (gain ' + micVolume() + '%)');
        logSendStats(5000);
      } catch (err) {
        stopTracks();
        const name = err && err.name;
        BeeUtils.showToast(
          name === 'NotAllowedError' ? 'Microphone access was denied.'
            : name === 'NotFoundError' ? 'No microphone found.'
              : BeeUtils.errText(err) || 'The microphone could not be opened.',
          'error'
        );
        return;
      }
    }
    micMuted = false;
    applyMicMute();
    emitState();
    BeeUtils.showToast('Microphone live.', 'success');
  }

  function toggleMute() {
    void setMicLive(micMuted);
  }

  // --- UI: the top-bar mic button ---

  function render() {
    const btn = el('btn-voice');
    if (!btn) return;
    const show = typeof BeeSettings !== 'undefined' && !!BeeSettings.get('voiceEnabled') && BeeState.gridOnline();
    const bar = el('voice-bar');
    if (bar) bar.hidden = !show;
    // The slider only means something while connected.
    const slider = el('voice-volume');
    if (slider) slider.hidden = state !== 'on';
    const connected = state === 'on' || inCall();
    btn.classList.toggle('top-bar__voice--connecting', state === 'connecting' || (inCall() && callSession && !callSession.up));
    btn.classList.toggle('top-bar__voice--on', connected && micMuted);
    btn.classList.toggle('top-bar__voice--live', connected && !micMuted);
    // toggleAttribute, not .hidden: these are SVG elements, and the `hidden`
    // property only exists on HTML elements - assigning it to an SVG sets a
    // plain JS field and changes nothing on screen.
    const live = connected && !micMuted;
    const off = el('voice-icon-off');
    const on = el('voice-icon-on');
    if (off) off.toggleAttribute('hidden', live);
    if (on) on.toggleAttribute('hidden', !live);
    btn.title = inCall() ? ('In a call: ' + (callSession.title || 'voice call') +
        (micMuted ? ' - tap to unmute (right-click to hang up)' : ' - tap to mute (right-click to hang up)'))
      : state === 'off' ? 'Join voice (nearby chat)'
        : state === 'connecting' ? 'Voice connecting...'
          : micMuted ? 'Voice on, listening - tap to unmute the microphone (right-click to leave)'
            : 'Microphone live - tap to mute (right-click to leave)';
    btn.setAttribute('aria-label', btn.title);
  }

  function bindButton() {
    const btn = el('btn-voice');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (inCall()) toggleMute();
      else if (state === 'off') join();
      else if (state === 'on') toggleMute();
      // while connecting, the tap is ignored rather than queueing surprises
    });
    // The whole voice pill - mic button AND volume slider - offers the same
    // contextual actions.
    if (typeof BeeContextMenu !== 'undefined' && BeeContextMenu.register) {
      BeeContextMenu.register('#voice-bar', function () {
        const items = [];
        const connected = state === 'on' || inCall();
        if (connected) {
          items.push({ label: micMuted ? 'Unmute microphone' : 'Mute microphone', action: toggleMute });
          items.push({
            label: inCall() ? 'Hang up' : 'Leave voice',
            action: function () {
              if (inCall()) endCall('');
              else leave();
            }
          });
        } else if (state === 'off') {
          items.push({ label: 'Join voice', action: join, disabled: !available() });
        }
        items.push({
          label: 'Voice settings',
          action: function () {
            if (typeof BeeNavigation !== 'undefined') BeeNavigation.switchTab('settings');
          }
        });
        return items;
      });
    }
  }

  function init() {
    bindButton();
    const slider = el('voice-volume') as HTMLInputElement | null;
    if (slider) {
      slider.addEventListener('input', function () {
        if (typeof BeeSettings !== 'undefined') BeeSettings.set('voiceVolume', slider.value);
        applyVolume();
      });
    }
    applyVolume();
    // A teleport lands on (possibly) another region and voice server; the
    // old session is dead either way, so rebuild while the user wants voice.
    BeeTransport.on('teleport-finish', function () {
      if (desired) scheduleReconnect('');
    });
    BeeTransport.on('region', function () {
      if (desired && state !== 'off') scheduleReconnect('');
    });
    // The sim answered our "start p2p voice" with the ad-hoc channel.
    BeeTransport.on('voice-call-ready', function (data) {
      if (!data || !data.sessionId || !pendingP2P) return;
      if (pendingP2P.sessionId !== String(data.sessionId).toLowerCase()) return;
      const p = pendingP2P;
      clearTimeout(p.timer);
      pendingP2P = null;
      void joinCallChannel(
        data.sessionId, p.title,
        String(data.channelUri || ''), String(data.credentials || ''),
        data.sessionId, true
      );
    });
    // The core learned a neighbour region's voice endpoints (or the set changed).
    BeeTransport.on('voice-neighbours', function (payload) {
      availableNeighbours = (payload && payload.neighbours) || [];
      manageNeighbours();
    });
    // A parcel boundary can change the voice channel: parcels either share
    // the estate-wide channel or run their own, and some forbid voice.
    BeeTransport.on('parcel', function (p) {
      if (!desired || !p) return;
      const flags = Number(p.parcelFlags) || 0;
      const allowVoice = (flags & (1 << 29)) !== 0;
      const useEstate = (flags & (1 << 30)) !== 0;
      if (!allowVoice) {
        if (state !== 'off') {
          vlog('parcel forbids voice; disconnecting');
          teardown();
          emitState();
        }
        return;
      }
      if (state === 'off') {
        // Voice is allowed again (or for the first time on a quiet login).
        void connect(true);
        return;
      }
      const want = useEstate ? null : (Number(p.localId) || null);
      if (want !== parcelChannelId && state === 'on') {
        vlog('parcel voice channel changed (' +
          (parcelChannelId === null ? 'estate' : parcelChannelId) + ' -> ' +
          (want === null ? 'estate' : want) + '); reconnecting');
        scheduleReconnect('');
      }
    });
    BeeTransport.on('session-lost', function () { endCall(''); leave(); });
    BeeTransport.on('disconnected', function () { endCall(''); leave(); });
    BeeState.on('reset', function () { endCall(''); leave(); });
    BeeState.on('change', function (partial) {
      if (partial.connected === true) maybeAutoJoin();
      if (partial.connected !== undefined || partial.sessionLost !== undefined) render();
    });
    if (typeof BeeSettings !== 'undefined' && BeeSettings.onChange) {
      BeeSettings.onChange(function (key) {
        if (key === 'voiceVolume') {
          applyVolume();
          return;
        }
        if (key === 'voiceMicVolume') {
          applyMicVolume();
          return;
        }
        if (key === 'voiceMicDevice') {
          void reacquireMic();
          return;
        }
        if (key === 'voiceOutputDevice') {
          applySink(audioEl);
          neighbourSessions.forEach(function (ns) { applySink(ns.audioEl); });
          if (callSession) applySink(callSession.audioEl);
          return;
        }
        if (key !== 'voiceEnabled') return;
        if (!BeeSettings.get('voiceEnabled')) leave();
        else maybeAutoJoin();
        render();
      });
    }
    render();
  }

  return {
    init: init,
    join: join,
    leave: leave,
    toggleMute: toggleMute,
    isConnected: function () { return state === 'on'; },
    participants: function () { return participants; },
    participantInfo: participantInfo,
    setUserMute: setUserMute,
    setUserVolume: setUserVolume,
    listDevices: listDevices,
    startCall: startCall,
    startP2PCall: startP2PCall,
    answerCall: answerCall,
    endCall: function () { endCall(''); },
    inCall: inCall,
    callInfo: function () {
      return callSession
        ? { sessionId: callSession.sessionId, title: callSession.title, origin: callSession.origin, connected: callSession.up === true }
        : null;
    }
  };
})();

window.BeeVoice = BeeVoice;
