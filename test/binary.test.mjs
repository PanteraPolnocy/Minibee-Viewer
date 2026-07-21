// Unit tests for src/js/protocol/sl-binary.js — SL UDP wire primitives (UUID,
// zerocoding, message-id framing, little-endian vectors). Loaded the same way
// as the other frontend IIFE modules (see slurl.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'js', 'protocol', 'sl-binary.js'), 'utf8');
// eslint-disable-next-line no-new-func
const B = new Function('window', 'document', src + '\n;return FSSLBinary;')({}, undefined);

const arr = (n) => new Uint8Array(new ArrayBuffer(n));

test('UUID: parse ↔ toString round-trip', () => {
  const s = '00112233-4455-6677-8899-aabbccddeeff';
  assert.equal(new B.UUID(s).toString(), s);
  assert.equal(B.UUID.zero().toString(), '00000000-0000-0000-0000-000000000000');
});

test('UUID: write places 16 bytes and advances', () => {
  const buf = arr(20);
  const end = new B.UUID('00112233-4455-6677-8899-aabbccddeeff').write(buf, 2);
  assert.equal(end, 18);
  assert.equal(buf[2], 0x00);
  assert.equal(buf[3], 0x11);
  assert.equal(buf[17], 0xff);
});

test('zerocode: encode → decode round-trips (RLE of zero runs)', () => {
  const original = Uint8Array.from([1, 0, 0, 0, 0, 0, 2, 0, 3]);
  const encoded = B.zerocodeEncode(original, 0, original.length - 1);
  const decoded = B.zerocodeDecode(encoded, 0, encoded.length - 1, 0);
  assert.deepEqual(Array.from(decoded), Array.from(original));
});

test('zerocode: long run (>255) splits into multiple markers', () => {
  const original = arr(300); // all zeros
  original[0] = 7;
  const encoded = B.zerocodeEncode(original, 0, original.length - 1);
  const decoded = B.zerocodeDecode(encoded, 0, encoded.length - 1, 0);
  assert.deepEqual(Array.from(decoded), Array.from(original));
});

test('message id: High frequency is one byte', () => {
  const buf = arr(8);
  const after = B.writeMessageId(buf, 0, B.Message.AgentUpdate, B.MsgFlags.FrequencyHigh);
  assert.equal(after, 1);
  const r = B.readMessageId(buf, 0);
  assert.equal(r.id, B.Message.AgentUpdate);
  assert.equal(r.pos, 1);
});

test('message id: Medium frequency round-trips (0xFF + byte)', () => {
  const buf = arr(8);
  const after = B.writeMessageId(buf, 0, B.Message.CoarseLocationUpdate, B.MsgFlags.FrequencyMedium);
  assert.equal(after, 2);
  assert.equal(B.readMessageId(buf, 0).id, B.Message.CoarseLocationUpdate);
});

test('message id: Low frequency round-trips (0xFFFF + u16 BE)', () => {
  const buf = arr(8);
  const after = B.writeMessageId(buf, 0, B.Message.ChatFromViewer, B.MsgFlags.FrequencyLow);
  assert.equal(after, 4);
  assert.equal(B.readMessageId(buf, 0).id, B.Message.ChatFromViewer);
});

test('message id: Fixed frequency round-trips (u32 BE)', () => {
  const buf = arr(8);
  const after = B.writeMessageId(buf, 0, B.Message.PacketAck, B.MsgFlags.FrequencyFixed);
  assert.equal(after, 4);
  assert.equal(B.readMessageId(buf, 0).id, B.Message.PacketAck);
});

test('vec3: write ↔ read little-endian round-trip', () => {
  const buf = arr(12);
  B.writeVec3(buf, 0, { x: 128.5, y: -64.25, z: 25 });
  const v = B.readVec3(buf, 0);
  assert.ok(Math.abs(v.x - 128.5) < 1e-4);
  assert.ok(Math.abs(v.y + 64.25) < 1e-4);
  assert.ok(Math.abs(v.z - 25) < 1e-4);
});

test('cameraAxes: returns an orthonormal basis', () => {
  const { at, left, up } = B.cameraAxes({ x: 1, y: 0, z: 0 });
  const len = (v) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  assert.ok(Math.abs(len(at) - 1) < 1e-4);
  assert.ok(Math.abs(len(left) - 1) < 1e-4);
  assert.ok(Math.abs(len(up) - 1) < 1e-4);
  // at · left ≈ 0
  assert.ok(Math.abs(at.x * left.x + at.y * left.y + at.z * left.z) < 1e-4);
});
