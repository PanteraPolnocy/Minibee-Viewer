// What the interface makes of the core's answer to "where is this region":
// BeeSLBridge.resolveLocation and teleportTo in src/js/core/sl-bridge.ts.
//
// The core tells three things apart - the region (which its map may list as
// down), no such region, and a lookup nobody answered - and each has to reach
// the user as what it is. A lookup that failed must never read "not found",
// and a region once listed as down must not stay out of reach when it is back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

const BeeSlurl = loadBeeModule('js/core/sl-slurl.ts', 'BeeSlurl', { window: {}, document: {} });

// The core's answers, in the shape bridge_region_by_name gives them.
const ANSWERS = {
  'coral reach': { name: 'Coral Reach', globalX: 281600, globalY: 268800, gridX: 1100, gridY: 1050 },
  'sleepy': { name: 'Sleepy', globalX: 230400, globalY: 230400, gridX: 900, gridY: 900, offline: true },
  'silent': {
    name: 'Silent', unavailable: true, error: 'could not look up',
    errorKey: 'map.regionLookupFailed', errorArgs: { region: 'Silent' }
  }
};
const notFound = (name) => ({ name, error: 'region not found', errorKey: 'map.regionNotFound', errorArgs: {} });

function boot(answers = ANSWERS) {
  const asked = [];
  const sent = [];
  const BeeBridge = {
    regionByName(name) {
      asked.push(name);
      return Promise.resolve(answers[String(name).toLowerCase()] || notFound(name));
    },
    invoke(cmd, args) {
      sent.push({ cmd, args });
      return Promise.resolve({ ok: true });
    },
    listen: () => Promise.resolve()
  };
  const bridge = loadBeeModule('js/core/sl-bridge.ts', 'BeeSLBridge', {
    BeeBridge,
    BeeSlurl,
    BeeTransport: { emit() {}, on() {} },
    BeeState: { on() {}, get: () => ({}) }
  });
  const teleports = () => sent.filter((call) => call.cmd === 'sl_teleport_to');
  return { bridge, asked, teleports };
}

const refusal = (promise) => promise.then(
  () => assert.fail('expected a refusal'),
  (err) => err
);

test('a region the map knows is found, spelled the way the grid spells it', async () => {
  const { bridge, asked } = boot();
  const loc = await bridge.resolveLocation('coral reach/10/20/30');
  assert.deepEqual(loc, { regionName: 'Coral Reach', gridX: 1100, gridY: 1050, x: 10, y: 20, z: 30 });
  assert.equal('offline' in loc, false, 'a running region carries no mark');
  assert.deepEqual(asked, ['coral reach']);
});

test('a name nobody could look up is not a missing region', async () => {
  const { bridge } = boot();
  const err = await refusal(bridge.resolveLocation('Silent'));
  assert.equal(err.lookupFailed, true);
  assert.equal(err.message, 'Could not look up Silent: the map did not answer. Try again in a moment.');
  assert.doesNotMatch(err.message, /not found|unknown region/i);
});

test('a region that does not exist is not found, and that is all it is', async () => {
  const { bridge } = boot();
  const err = await refusal(bridge.resolveLocation('Nowhere At All'));
  assert.equal(err.message, 'Region not found: Nowhere At All');
  assert.equal(err.lookupFailed, undefined);
  assert.equal(err.regionOffline, undefined);
});

test('a region the map lists as down is found, and a teleport says it is down instead of trying', async () => {
  const { bridge, teleports } = boot();
  const loc = await bridge.resolveLocation('sleepy');
  assert.equal(loc.offline, true);
  assert.equal(loc.regionName, 'Sleepy');

  for (const destination of ['sleepy', 'secondlife://Sleepy/40/50/60', { regionName: 'Sleepy' }]) {
    const err = await refusal(bridge.teleportTo(destination));
    assert.equal(err.regionOffline, true);
    assert.equal(err.message, 'Sleepy appears to be offline right now.');
    assert.equal(err.lookupFailed, undefined);
  }
  assert.equal(teleports().length, 0, 'nothing was sent');
});

test('the word that a region is down is not kept: a location from an earlier lookup is simply tried', async () => {
  const { bridge, asked, teleports } = boot();
  const kept = await bridge.resolveLocation('sleepy/40/50/60');
  assert.equal(kept.offline, true);
  // Later on - the region may be back by now, and only the sim can tell.
  const went = await bridge.teleportTo(kept);
  assert.equal(asked.length, 1, 'no second lookup: the place is already known');
  assert.equal(teleports().length, 1);
  assert.deepEqual(teleports()[0].args, { gridX: 900, gridY: 900, x: 40, y: 50, z: 60, regionName: 'Sleepy' });
  assert.equal(went, kept);
});

test('a teleport by name goes where the map says, and one that failed to look up goes nowhere', async () => {
  const { bridge, teleports } = boot();
  await bridge.teleportTo('coral reach');
  assert.deepEqual(teleports()[0].args, { gridX: 1100, gridY: 1050, x: 128, y: 128, z: 25, regionName: 'Coral Reach' });

  const failed = await refusal(bridge.teleportTo('silent'));
  assert.equal(failed.lookupFailed, true);
  const missing = await refusal(bridge.teleportTo('Nowhere At All'));
  assert.equal(missing.message, 'Region not found: Nowhere At All');
  assert.equal(teleports().length, 1, 'only the region that was found');
});
