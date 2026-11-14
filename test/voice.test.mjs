// Tests for two behaviours of src/js/voice/voice.ts (BeeVoice) that live in
// timing rather than in any one function: an automatic connection attempt
// that fails is made again, further and further apart, until voice is up;
// and a muted microphone is let go after a moment and opened again on unmute.
// The module runs against stand-ins for WebRTC, Web Audio and the core, with
// a clock the test turns by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const coreError = (key) => JSON.stringify({ key, text: key, args: {} });

function boot(options = {}) {
  // --- a clock turned by hand ---
  let now = 0;
  let ids = 0;
  const timers = new Map();
  const later = (fn, ms, every) => { ids += 1; timers.set(ids, { at: now + (ms || 0), fn, every: every || 0 }); return ids; };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, timer] of timers) {
        if (timer.at <= end && (!next || timer.at < next.timer.at)) next = { id, timer };
      }
      if (!next) break;
      now = next.timer.at;
      if (next.timer.every) next.timer.at += next.timer.every;
      else timers.delete(next.id);
      next.timer.fn();
      await flush();
    }
    now = end;
    await flush();
  }

  // --- WebRTC and Web Audio, as far as the module touches them ---
  const peers = [];
  const microphones = [];
  class Track {
    constructor(label) { this.kind = 'audio'; this.label = label; this.enabled = true; this.readyState = 'live'; }
    stop() { this.readyState = 'ended'; }
  }
  class Stream {
    constructor(tracks) { this.tracks = tracks || []; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks; }
  }
  class AudioContext {
    constructor() { this.state = 'running'; }
    createMediaStreamDestination() { return { stream: new Stream([new Track('rendered')]), channelCount: 2 }; }
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  class Sender {
    constructor(track) { this.track = track; }
    replaceTrack(track) { this.track = track; return Promise.resolve(); }
  }
  class Peer {
    constructor() {
      this.iceGatheringState = 'complete';
      this.connectionState = 'new';
      this.localDescription = null;
      this.sender = null;
      peers.push(this);
    }
    createDataChannel(label) {
      this.channel = { label, readyState: 'connecting', send() {}, close() {} };
      return this.channel;
    }
    addTrack(track) { this.sender = new Sender(track); return this.sender; }
    addTransceiver() { this.sender = new Sender(null); return { sender: this.sender }; }
    getTransceivers() { return []; }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription() {}
    addEventListener() {}
    removeEventListener() {}
    getStats() { return Promise.resolve(new Map()); }
    close() { this.connectionState = 'closed'; }
  }

  // --- the core, the state and the settings ---
  const invoked = [];
  const provision = { answer: options.provision || (() => Promise.reject(coreError('err.voiceProvisionFailed'))) };
  const BeeBridge = {
    invoke(cmd) {
      invoked.push(cmd);
      if (cmd === 'sl_voice_stun') return Promise.resolve({ servers: [] });
      if (cmd === 'sl_voice_provision') return provision.answer();
      return Promise.resolve({});
    }
  };
  const bus = () => {
    const handlers = {};
    return {
      on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
      emit(name, payload) { (handlers[name] || []).forEach((fn) => fn(payload)); }
    };
  };
  const stateBus = bus();
  const transport = bus();
  const settings = Object.assign({
    voiceEnabled: true, voiceReleaseMic: true, voiceVolume: 80, voiceMicVolume: 100,
    voiceMicDevice: '', voiceOutputDevice: ''
  }, options.settings || {});
  const settingListeners = [];
  const toasts = [];
  const quietMath = Object.create(Math);
  quietMath.random = () => 0; // the waits are exact, without their random part

  const BeeVoice = loadBeeModule('js/voice/voice.ts', 'BeeVoice', {
    window: { RTCPeerConnection: Peer, AudioContext },
    document: {
      getElementById: () => null, addEventListener() {}, removeEventListener() {},
      createElement: () => ({ play: () => Promise.resolve(), style: {} }), body: { appendChild() {} }
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          const stream = new Stream([new Track('microphone')]);
          microphones.push(stream);
          return stream;
        },
        enumerateDevices: async () => []
      }
    },
    RTCPeerConnection: Peer,
    MediaStream: Stream,
    Math: quietMath,
    setTimeout: (fn, ms) => later(fn, ms, 0),
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => later(fn, ms, ms),
    clearInterval: (id) => { timers.delete(id); },
    BeeState: {
      on: stateBus.on,
      gridOnline: () => true,
      get: () => ({ connected: true, agent: { id: '11111111-1111-1111-1111-111111111111' }, position: { x: 128, y: 128, z: 25 }, region: {} })
    },
    BeeSettings: {
      get: (key) => settings[key],
      set: (key, value) => { settings[key] = value; settingListeners.forEach((fn) => fn(key, value)); },
      onChange: (fn) => { settingListeners.push(fn); }
    },
    BeeTransport: transport,
    BeeBridge,
    BeeUtils: {
      showToast: (text, kind) => { toasts.push([text, kind]); },
      errText: (err) => String((err && err.message) || err || ''),
      storageGet: (_key, fallback) => fallback,
      storageSet() {},
      confirm: async () => false
    },
    BeeDiag: { log() {} },
    console: { error() {}, warn() {}, log() {} }
  });
  BeeVoice.init();

  const attempts = () => invoked.filter((cmd) => cmd === 'sl_voice_provision').length;
  // The login-time join, then (optionally) the session coming up.
  async function login() {
    stateBus.emit('change', { connected: true });
    await flush();
  }
  async function comeUp() {
    const peer = peers[peers.length - 1];
    peer.channel.readyState = 'open';
    peer.channel.onopen();
    await flush();
    return peer;
  }
  return { BeeVoice, advance, attempts, login, comeUp, peers, microphones, provision, transport, settings, toasts,
    setSetting: (key, value) => { settings[key] = value; settingListeners.forEach((fn) => fn(key, value)); } };
}

test('a failed automatic attempt is made again, further and further apart', async () => {
  const v = boot();
  await v.login();
  assert.equal(v.attempts(), 1, 'the login-time join');
  // Each wait runs from the failure before it: 2.5 s, 4 s, 6 s, 8 s, then 10 s.
  const waits = [2500, 4000, 6000, 8000, 10000, 10000];
  for (let i = 0; i < waits.length; i++) {
    await v.advance(waits[i] - 100);
    assert.equal(v.attempts(), i + 1, `not before ${waits[i]} ms have passed`);
    await v.advance(100);
    assert.equal(v.attempts(), i + 2, `attempt ${i + 2} after ${waits[i]} ms`);
  }
  assert.equal(v.BeeVoice.isConnected(), false);
  assert.deepEqual(v.toasts, [], 'nothing is said while it keeps trying');
});

test('a server that stays down is asked less and less often, but never given up on', async () => {
  const v = boot();
  await v.login();
  await v.advance(10 * 60 * 1000);
  const afterTenMinutes = v.attempts();
  assert.ok(afterTenMinutes >= 20 && afterTenMinutes <= 40, `${afterTenMinutes} attempts in ten minutes`);
  await v.advance(10 * 60 * 1000);
  const laterOn = v.attempts() - afterTenMinutes;
  assert.ok(laterOn >= 9 && laterOn <= 11, `about one a minute from then on (${laterOn} in ten minutes)`);
});

test('a place without voice is not asked again until the place changes', async () => {
  for (const key of ['err.regionHasNoVoice', 'err.voiceNotAllowedOnParcel']) {
    const v = boot({ provision: () => Promise.reject(coreError(key)) });
    await v.login();
    await v.advance(5 * 60 * 1000);
    assert.equal(v.attempts(), 1, key);
    // A teleport is a new place: one fresh try.
    v.transport.emit('teleport-finish', {});
    await v.advance(2500);
    assert.equal(v.attempts(), 2, key + ' after a teleport');
  }
});

test('a deliberate tap is told why it failed, and is not repeated', async () => {
  const v = boot();
  v.BeeVoice.join();
  await flush();
  assert.equal(v.attempts(), 1);
  assert.equal(v.toasts.length, 1);
  assert.equal(v.toasts[0][1], 'error');
  await v.advance(5 * 60 * 1000);
  assert.equal(v.attempts(), 1);
});

test('voice coming up ends the run of failures', async () => {
  const v = boot();
  await v.login();
  await v.advance(2500);
  await v.advance(4000);
  assert.equal(v.attempts(), 3, 'three failures so far');
  // The server is back: the next attempt (6 s later) succeeds.
  v.provision.answer = () => Promise.resolve({ viewerSession: 'vs', sdp: 'v=0', parcelLocalId: null });
  await v.advance(6000);
  assert.equal(v.attempts(), 4);
  const peer = await v.comeUp();
  assert.equal(v.BeeVoice.isConnected(), true);

  // It drops again: said once, and the first retry is the quick one again.
  v.provision.answer = () => Promise.reject(coreError('err.voiceProvisionFailed'));
  peer.connectionState = 'failed';
  peer.onconnectionstatechange();
  await flush();
  assert.equal(v.BeeVoice.isConnected(), false);
  assert.equal(v.toasts.length, 1, 'the drop is announced');
  await v.advance(2400);
  assert.equal(v.attempts(), 4);
  await v.advance(100);
  assert.equal(v.attempts(), 5, 'back to the short wait');
  await v.advance(4000);
  assert.equal(v.attempts(), 6);
  assert.equal(v.toasts.length, 1, 'and the retries after it stay quiet');
});

test('turning voice off stops the retries', async () => {
  const v = boot();
  await v.login();
  await v.advance(2500);
  assert.equal(v.attempts(), 2);
  v.BeeVoice.leave();
  await v.advance(5 * 60 * 1000);
  assert.equal(v.attempts(), 2);
});

async function connected(options) {
  const v = boot(Object.assign({ provision: () => Promise.resolve({ viewerSession: 'vs', sdp: 'v=0', parcelLocalId: null }) }, options));
  await v.login();
  const peer = await v.comeUp();
  assert.equal(v.BeeVoice.isConnected(), true);
  return { v, peer, placeholder: peer.sender.track };
}

test('a muted microphone is let go after a moment and opened again on unmute', async () => {
  const { v, peer, placeholder } = await connected();
  assert.equal(v.microphones.length, 0, 'listening needs no microphone');
  assert.equal(placeholder.label, 'rendered', 'the uplink starts on the silent placeholder');

  v.BeeVoice.toggleMute(); // live
  await flush();
  assert.equal(v.microphones.length, 1);
  const mic = v.microphones[0].getTracks()[0];
  const live = peer.sender.track;
  assert.notEqual(live, placeholder, 'the sender carries the microphone chain');

  v.BeeVoice.toggleMute(); // muted
  await flush();
  assert.equal(live.enabled, false, 'silenced at once');
  await v.advance(900);
  assert.equal(mic.readyState, 'live', 'not let go within the moment');
  await v.advance(200);
  assert.equal(mic.readyState, 'ended', 'the microphone itself is closed');
  assert.equal(peer.sender.track, placeholder, 'and the uplink is back on the placeholder');

  v.BeeVoice.toggleMute(); // live again
  await flush();
  assert.equal(v.microphones.length, 2, 'opened anew');
  assert.equal(v.microphones[1].getTracks()[0].readyState, 'live');
  assert.notEqual(peer.sender.track, placeholder);
  assert.equal(peer.sender.track.enabled, true);
});

test('unmuting within the moment keeps the microphone', async () => {
  const { v, peer } = await connected();
  v.BeeVoice.toggleMute();
  await flush();
  const live = peer.sender.track;
  v.BeeVoice.toggleMute();
  await v.advance(500);
  v.BeeVoice.toggleMute();
  await flush();
  await v.advance(5000);
  assert.equal(v.microphones.length, 1, 'never reopened');
  assert.equal(v.microphones[0].getTracks()[0].readyState, 'live');
  assert.equal(peer.sender.track, live);
  assert.equal(live.enabled, true);
});

test('the setting keeps a muted microphone open, and lets it go when switched on', async () => {
  const { v, peer, placeholder } = await connected({ settings: { voiceReleaseMic: false } });
  v.BeeVoice.toggleMute();
  await flush();
  v.BeeVoice.toggleMute();
  await v.advance(60 * 1000);
  const mic = v.microphones[0].getTracks()[0];
  assert.equal(mic.readyState, 'live', 'off: open for the whole session, as before');
  assert.notEqual(peer.sender.track, placeholder);
  v.setSetting('voiceReleaseMic', true);
  await v.advance(1000);
  assert.equal(mic.readyState, 'ended');
  assert.equal(peer.sender.track, placeholder);
});
