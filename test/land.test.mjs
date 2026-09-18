// Tests for the Land form's edit protection in src/js/ui/land.ts (BeeLand).
//
// Parcel patches keep arriving while the form is open - the RemoteParcelRequest
// reply on every tab activation, name resolutions, staged landing points, the
// sim's own ParcelProperties - and each used to rewrite every control, wiping
// whatever the user had typed. The module is loaded as an IIFE with a fake
// document whose elements are created on demand, like the other frontend tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBeeModule } from './load-module.mjs';

const CHECKBOXES = new Set([
  'land-push', 'land-build-everyone', 'land-build-group', 'land-scripts-everyone',
  'land-scripts-group', 'land-fly', 'land-safe', 'land-search', 'land-sound-local',
  'land-av-sounds-all', 'land-av-sounds-group', 'land-voice', 'land-voice-estate',
  'land-sell-passes', 'land-mature', 'land-see-avs', 'land-terraform', 'land-entry-all',
  'land-entry-group', 'land-deed-allow', 'land-access-public', 'land-access-group',
  'land-deny-anon', 'land-deny-unverified'
]);
const SELECTS = new Set(['land-category', 'land-landing-type']);

// Just enough of an element for setFieldValue / readEditable / setProfileField
// and the permission toggles to run against.
function makeElement(id) {
  return {
    id,
    type: CHECKBOXES.has(id) ? 'checkbox' : 'text',
    tagName: SELECTS.has(id) ? 'SELECT' : (id === 'land-desc' ? 'TEXTAREA' : 'INPUT'),
    value: '', checked: false, disabled: false, readOnly: false, hidden: false,
    title: '', innerHTML: '', textContent: '', src: '',
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, removeAttribute() {}, reset() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
}

function makeDocument() {
  const els = new Map();
  return {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeElement(id));
      return els.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
}

const BeeUtils = loadBeeModule('js/utils.ts', 'BeeUtils', {
  window: {},
  document: { createElement: () => ({}) },
  navigator: {},
  localStorage: {}
});

function load() {
  const document = makeDocument();
  const state = { parcel: null, region: {}, agent: { id: 'me' }, position: { x: 1, y: 2, z: 3 } };
  const BeeLand = loadBeeModule('js/ui/land.ts', 'BeeLand', {
    document,
    BeeUtils,
    BeeState: {
      get: () => state,
      gridOnline: () => true,
      patch: (p) => Object.assign(state, p),
      on() {}
    },
    BeeTransport: { on() {}, accessListFlags: () => ({}) },
    BeeProfiles: { getGroupName: () => '', queueGroupName() {}, isZero: () => false, onChange() {} },
    BeeProfile: {},
    BeeNavigation: { isTabActive: () => false }
  });
  const field = (id) => document.getElementById(id);
  return { BeeLand, field, state };
}

const PARCEL_A = {
  localId: 7, name: 'Beach', desc: 'Sand', area: 512, dwell: 10,
  primsUsed: 12, primsTotal: 117, canEdit: true,
  ownerId: '11111111-1111-1111-1111-111111111111', ownerName: 'Ann Owner',
  allowFly: true, allowBuildEveryone: false, showInSearch: false
};

test('an untouched form follows every parcel patch', () => {
  const { BeeLand, field } = load();
  BeeLand.populateForm(PARCEL_A);
  assert.equal(field('land-name').value, 'Beach');
  assert.equal(field('land-fly').checked, true);
  BeeLand.applyParcel(Object.assign({}, PARCEL_A, { name: 'Renamed', allowFly: false, dwell: 99 }));
  assert.equal(field('land-name').value, 'Renamed');
  assert.equal(field('land-fly').checked, false);
  assert.equal(field('land-traffic').value, '99');
});

test('an unsaved edit survives a patch for the same parcel; read-only fields still update', () => {
  const { BeeLand, field } = load();
  BeeLand.populateForm(PARCEL_A);
  // The user types a new name, edits the description and flips two boxes.
  field('land-name').value = 'Beach 2';
  field('land-desc').value = 'Sand and sun';
  field('land-fly').checked = false;
  field('land-search').checked = true;
  // The RemoteParcelRequest reply merges the parcel UUID and traffic back in,
  // and the sim reports a different prim count.
  BeeLand.applyParcel(Object.assign({}, PARCEL_A, {
    parcelId: 'aaaaaaaa-0000-0000-0000-000000000000', dwell: 1234, primsUsed: 40
  }));
  assert.equal(field('land-name').value, 'Beach 2', 'the typed name stays');
  assert.equal(field('land-desc').value, 'Sand and sun', 'the typed description stays');
  assert.equal(field('land-fly').checked, false, 'the flipped checkbox stays');
  assert.equal(field('land-search').checked, true, 'the flipped checkbox stays');
  assert.equal(field('land-uuid').value, 'aaaaaaaa-0000-0000-0000-000000000000', 'derived: parcel UUID');
  assert.equal(field('land-traffic').value, '1234', 'derived: traffic');
  assert.equal(field('land-prims').value, '40 / 117', 'derived: prims');
  assert.equal(field('land-owner').value, 'Ann Owner', 'derived: owner');
});

test('a different parcel replaces the edit', () => {
  const { BeeLand, field } = load();
  BeeLand.populateForm(PARCEL_A);
  field('land-name').value = 'Beach 2';
  field('land-fly').checked = false;
  BeeLand.applyParcel({ localId: 8, name: 'Hills', allowFly: true, canEdit: true, primsTotal: 1 });
  assert.equal(field('land-name').value, 'Hills');
  assert.equal(field('land-fly').checked, true);
  // ...and the new parcel is what the form is now clean against.
  BeeLand.applyParcel({ localId: 8, name: 'Hills renamed', allowFly: true, canEdit: true, primsTotal: 1 });
  assert.equal(field('land-name').value, 'Hills renamed');
});

test('an explicit refresh may rewrite an edit; a plain patch afterwards follows the sim again', () => {
  const { BeeLand, field } = load();
  BeeLand.populateForm(PARCEL_A);
  field('land-name').value = 'Beach 2';
  BeeLand.applyParcel(Object.assign({}, PARCEL_A, { name: 'From sim' }), true);
  assert.equal(field('land-name').value, 'From sim');
  BeeLand.applyParcel(Object.assign({}, PARCEL_A, { name: 'From sim again' }));
  assert.equal(field('land-name').value, 'From sim again', 'the forced fill left the form clean');
});

test('an edit reverted by hand no longer counts as an edit', () => {
  const { BeeLand, field } = load();
  BeeLand.populateForm(PARCEL_A);
  field('land-name').value = 'Beach 2';
  field('land-name').value = 'Beach';
  BeeLand.applyParcel(Object.assign({}, PARCEL_A, { name: 'Renamed' }));
  assert.equal(field('land-name').value, 'Renamed');
});

test('a stub parcel is ignored rather than clearing the edit', () => {
  const { BeeLand, field } = load();
  BeeLand.populateForm(PARCEL_A);
  field('land-name').value = 'Beach 2';
  BeeLand.applyParcel({ stub: true });
  BeeLand.populateForm(null);
  assert.equal(field('land-name').value, 'Beach 2');
});
