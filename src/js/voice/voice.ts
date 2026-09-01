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
    return audioEl;
  }

  function voiceVolume() {
    const v = typeof BeeSettings !== 'undefined' ? Number(BeeSettings.get('voiceVolume')) : 80;
    return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 80));
  }

  function applyVolume() {
    if (audioEl) audioEl.volume = voiceVolume() / 100;
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
  // silence. The voice server expects uplink RTP from a participant the way
  // the standard client always provides it (its mic track exists from the
  // start); a trackless sender ships no packets at all.
  function silentPlaceholderTrack() {
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
    return dst.stream.getAudioTracks()[0] || null;
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

  async function sendPosition() {
    try {
      const res = await BeeBridge.invoke('sl_voice_position');
      if (!res || !res.ok || !res.position) return;
      const p = res.position;
      // Integers of centimeters; the heading stays identity - Minibee has no
      // camera, so the avatar simply faces "forward".
      const v = { x: Math.round(p[0] * 100), y: Math.round(p[1] * 100), z: Math.round(p[2] * 100) };
      const h = { x: 0, y: 0, z: 0, w: 100 };
      sendData({ sp: v, sh: h, lp: v, lh: h });
    } catch (_e) { /* between regions; the next tick retries */ }
  }

  function handleData(text) {
    let doc;
    try { doc = JSON.parse(text); } catch (_e) { return; }
    if (!doc || typeof doc !== 'object') return;
    let changed = false;
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
      if (!p && entry.j) {
        p = { speaking: false, level: 0 };
        participants.set(key, p);
        changed = true;
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
    if (changed) {
      BeeTransport.emit('voice-participants', {
        participants: Array.from(participants, function (pair) {
          return { id: pair[0], speaking: pair[1].speaking, level: pair[1].level };
        })
      });
    }
  }

  // --- lifecycle ---

  async function connect(auto?: boolean) {
    if (state !== 'off' || !available()) return;
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
    micSender = null;
    if (silentCtx) { try { silentCtx.close(); } catch (_e) {} silentCtx = null; }
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
      BeeTransport.emit('voice-participants', { participants: [] });
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
    if (state !== 'on') return;
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
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        const track = micStream.getAudioTracks()[0];
        if (state !== 'on' || !micSender || !track) {
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
        await micSender.replaceTrack(sentTrack);
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
    btn.classList.toggle('top-bar__voice--connecting', state === 'connecting');
    btn.classList.toggle('top-bar__voice--on', state === 'on' && micMuted);
    btn.classList.toggle('top-bar__voice--live', state === 'on' && !micMuted);
    // toggleAttribute, not .hidden: these are SVG elements, and the `hidden`
    // property only exists on HTML elements - assigning it to an SVG sets a
    // plain JS field and changes nothing on screen.
    const live = state === 'on' && !micMuted;
    const off = el('voice-icon-off');
    const on = el('voice-icon-on');
    if (off) off.toggleAttribute('hidden', live);
    if (on) on.toggleAttribute('hidden', !live);
    btn.title = state === 'off' ? 'Join voice (nearby chat)'
      : state === 'connecting' ? 'Voice connecting...'
        : micMuted ? 'Voice on, listening - tap to unmute the microphone (right-click to leave)'
          : 'Microphone live - tap to mute (right-click to leave)';
    btn.setAttribute('aria-label', btn.title);
  }

  function bindButton() {
    const btn = el('btn-voice');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (state === 'off') join();
      else if (state === 'on') toggleMute();
      // while connecting, the tap is ignored rather than queueing surprises
    });
    btn.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (state === 'off') return;
      const menu = el('context-menu');
      if (!menu) return;
      menu.innerHTML = '';
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = 'Leave voice';
      item.addEventListener('click', function () {
        menu.hidden = true;
        leave();
      });
      menu.appendChild(item);
      menu.hidden = false;
      const rect = btn.getBoundingClientRect();
      const mrect = menu.getBoundingClientRect();
      menu.style.left = Math.max(0, Math.min(rect.left, window.innerWidth - mrect.width - 8)) + 'px';
      menu.style.top = Math.max(0, Math.min(rect.bottom + 4, window.innerHeight - mrect.height - 8)) + 'px';
    });
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
    BeeTransport.on('session-lost', function () { leave(); });
    BeeTransport.on('disconnected', function () { leave(); });
    BeeState.on('reset', function () { leave(); });
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
    participants: function () { return participants; }
  };
})();

window.BeeVoice = BeeVoice;
