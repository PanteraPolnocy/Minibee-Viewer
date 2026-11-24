// Where a parcel's music stream may come from: BeeParcelMusic in
// src/js/audio/parcel-music.ts.
//
// A parcel picks its stream URL and the webview fetches whatever the player
// is given, so the core is asked first (bridge_check_stream_url) and the
// player only ever gets an address the core allowed. These tests hold the
// order of things: nothing is fetched before the answer, a refusal or no
// answer leaves the player empty, and an answer that comes late is not
// applied to a stream it was not about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function boot(options = {}) {
  // Every player the module makes, with each address it was ever given.
  const players = [];
  class FakeAudio {
    constructor() {
      this.address = '';
      this.given = [];
      this.plays = 0;
      this.volume = 1;
      this.error = null;
      this.listeners = {};
      players.push(this);
    }
    get src() { return this.address; }
    set src(value) { this.address = String(value); this.given.push(this.address); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeAttribute(name) { if (name === 'src') this.address = ''; }
    load() {}
    pause() { this.fire('pause'); }
    play() { this.plays += 1; return Promise.resolve(); }
    fire(type) { (this.listeners[type] || []).forEach((fn) => fn()); }
  }

  const elements = {};
  const element = (id) => {
    if (!elements[id]) {
      elements[id] = {
        hidden: false, title: '', textContent: '', value: '', dataset: {},
        setAttribute() {}, toggleAttribute() {}, addEventListener() {}
      };
    }
    return elements[id];
  };

  // The core, answering when the test says so.
  const asked = [];
  const BeeBridge = {
    invoke(cmd, args) {
      return new Promise((resolve, reject) => {
        asked.push({ cmd, url: args && args.url, resolve, reject });
      });
    }
  };

  const settings = { parcelMusicEnabled: options.enabled !== false, parcelMusicVolume: 50 };
  const stateHandlers = {};
  const problems = [];
  const stubs = {
    Audio: FakeAudio,
    document: { getElementById: element },
    location: { protocol: options.protocol || 'tauri:' },
    BeeSettings: {
      get: (key) => settings[key],
      set: (key, value) => { settings[key] = value; },
      onChange() {}
    },
    BeeState: {
      on(event, fn) { (stateHandlers[event] = stateHandlers[event] || []).push(fn); },
      get: () => ({})
    },
    BeeErrors: { warn: (source, message) => problems.push(message) }
  };
  if (!options.noBackend) stubs.BeeBridge = BeeBridge;

  const music = loadBeeModule('js/audio/parcel-music.ts', 'BeeParcelMusic', stubs);
  music.init();

  return {
    music, players, asked, problems,
    line: () => element('parcel-music-now').textContent,
    root: () => element('parcel-music'),
    // The avatar walks onto a parcel that advertises this stream.
    parcel(url) {
      (stateHandlers.change || []).forEach((fn) => fn({ parcel: { musicUrl: url } }));
    }
  };
}

const allow = (url) => ({ allowed: true, url });
const refuse = (reason) => ({ allowed: false, reason });

test('with music off nothing is asked and nothing is fetched', async () => {
  const { players, asked, line, parcel } = boot({ enabled: false });
  parcel('http://radio.example:8000/live');
  await flush();
  assert.equal(asked.length, 0, 'no address check, so no lookup of a host nobody listens to');
  assert.equal(players.length, 0);
  assert.equal(line(), 'Parcel music available: http://radio.example:8000/live');
});

test('a stream is given to the player only after the core allows it, as the core read it', async () => {
  const { players, asked, line, parcel } = boot();
  parcel('HTTP://Radio.Example:80/live');
  await flush();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].cmd, 'bridge_check_stream_url');
  assert.equal(asked[0].url, 'HTTP://Radio.Example:80/live', 'the address about to be played is the one checked');
  assert.equal(players.length, 0, 'nothing to fetch with before the answer');

  asked[0].resolve(allow('http://radio.example/live'));
  await flush();
  assert.equal(players.length, 1);
  assert.deepEqual(players[0].given, ['http://radio.example/live']);
  assert.equal(players[0].plays, 1);
  assert.equal(line(), 'Playing: HTTP://Radio.Example:80/live');
});

test('a refused stream never reaches the player, and its address stays on show', async () => {
  const { players, asked, problems, line, root, parcel } = boot();
  parcel('http://192.168.0.5/a');
  await flush();
  asked[0].resolve(refuse('target is a private/loopback address: 192.168.0.5'));
  await flush();
  assert.equal(players.length, 0, 'no player was even made');
  assert.equal(line(), 'Stream unavailable (network error): http://192.168.0.5/a');
  assert.equal(root().dataset.copy, 'http://192.168.0.5/a', 'the address can still be copied');
  assert.equal(root().hidden, false);
  assert.ok(problems.some((p) => p.includes('stream refused: target is a private/loopback address')), 'the log says why');
  assert.equal(asked.length, 1, 'a refusal is not retried');
});

test('no answer is a refusal: a failed call, a half answer, no backend', async () => {
  const failed = boot();
  failed.parcel('http://radio.example/live');
  await flush();
  failed.asked[0].reject(new Error('ipc down'));
  await flush();
  assert.equal(failed.players.length, 0);
  assert.equal(failed.line(), 'Stream unavailable (network error): http://radio.example/live');

  for (const answer of [null, {}, { allowed: true }, { allowed: true, url: '' }, { allowed: 'yes', url: 'http://radio.example/live' }]) {
    const half = boot();
    half.parcel('http://radio.example/live');
    await flush();
    half.asked[0].resolve(answer);
    await flush();
    assert.equal(half.players.length, 0, JSON.stringify(answer));
    assert.equal(half.line(), 'Stream unavailable (network error): http://radio.example/live');
  }

  const alone = boot({ noBackend: true });
  alone.parcel('http://radio.example/live');
  await flush();
  assert.equal(alone.players.length, 0);
  assert.equal(alone.line(), 'Stream unavailable (network error): http://radio.example/live');
});

test('an answer about an older stream is not applied to a newer one', async () => {
  const { players, asked, line, parcel } = boot();
  parcel('http://first.example/live');
  await flush();
  parcel('http://10.0.0.1/second');
  await flush();
  assert.equal(asked.length, 2);
  assert.equal(asked[1].url, 'http://10.0.0.1/second');

  // The first stream's "yes" comes back while the second is still being checked.
  asked[0].resolve(allow('http://first.example/live'));
  await flush();
  assert.equal(players.length, 0, 'the old yes starts nothing');

  asked[1].resolve(refuse('target is a private/loopback address: 10.0.0.1'));
  await flush();
  assert.equal(players.length, 0);
  assert.equal(line(), 'Stream unavailable (network error): http://10.0.0.1/second');
});

test('answers that arrive in the other order still play only the newest stream', async () => {
  const { players, asked, line, parcel } = boot();
  parcel('http://first.example/live');
  await flush();
  parcel('http://second.example/live');
  await flush();
  asked[1].resolve(allow('http://second.example/live'));
  await flush();
  asked[0].resolve(allow('http://first.example/live'));
  await flush();
  assert.equal(players.length, 1);
  assert.deepEqual(players[0].given, ['http://second.example/live']);
  assert.equal(line(), 'Playing: http://second.example/live');
});

test('an answer that arrives after the music was stopped starts nothing', async () => {
  const { music, players, asked, line, parcel } = boot();
  parcel('http://radio.example/live');
  await flush();
  music.setEnabled(false);
  asked[0].resolve(allow('http://radio.example/live'));
  await flush();
  assert.equal(players.length, 0);
  assert.equal(line(), 'Parcel music available: http://radio.example/live');

  // Leaving the parcel while the check is out is the same.
  const walked = boot();
  walked.parcel('http://radio.example/live');
  await flush();
  walked.parcel('');
  walked.asked[0].resolve(allow('http://radio.example/live'));
  await flush();
  assert.equal(walked.players.length, 0);
  assert.equal(walked.line(), '');
});

test('the https form tried after a failed http stream is checked like any other', async () => {
  const { players, asked, line, parcel } = boot({ protocol: 'https:' });
  parcel('http://radio.example/live');
  await flush();
  asked[0].resolve(allow('http://radio.example/live'));
  await flush();
  assert.deepEqual(players[0].given, ['http://radio.example/live']);

  // The http stream fails on the https page: the https form gets one try.
  players[0].error = { code: 4 };
  players[0].fire('error');
  await flush();
  assert.equal(asked.length, 2);
  assert.equal(asked[1].url, 'https://radio.example/live');
  assert.deepEqual(players[0].given, ['http://radio.example/live'], 'not played before it is allowed');

  asked[1].resolve(allow('https://radio.example/live'));
  await flush();
  assert.deepEqual(players[0].given, ['http://radio.example/live', 'https://radio.example/live']);
  assert.equal(line(), 'Playing: http://radio.example/live');
});

test('a refused https form ends the retry and empties the player', async () => {
  const { players, asked, line, parcel } = boot({ protocol: 'https:' });
  parcel('http://radio.example/live');
  await flush();
  asked[0].resolve(allow('http://radio.example/live'));
  await flush();
  players[0].error = { code: 4 };
  players[0].fire('error');
  await flush();
  asked[1].resolve(refuse('target resolves to a private/loopback address: 10.0.0.9'));
  await flush();
  assert.deepEqual(players[0].given, ['http://radio.example/live'], 'the https form was never given');
  assert.equal(players[0].src, '', 'and the failed address is not left in the player');
  assert.equal(line(), 'Stream unavailable (network error): http://radio.example/live');
  assert.equal(asked.length, 2, 'no further tries');
});
