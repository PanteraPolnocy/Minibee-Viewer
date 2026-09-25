import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDigest } from '../scripts/update-release-notes.mjs';

test('formatDigest links full sha256 to VirusTotal', () => {
  const hex = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const out = formatDigest(`sha256:${hex}`);
  assert.equal(
    out,
    '`abcdef012345...ef0123456789`<br>[VirusTotal scan](https://www.virustotal.com/gui/file/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789)',
  );
});

test('formatDigest returns dash when digest missing', () => {
  assert.equal(formatDigest(undefined), '-');
  assert.equal(formatDigest('not-a-hash'), '-');
});
