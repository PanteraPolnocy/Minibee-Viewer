import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDownloadBlock, formatDigest } from '../scripts/update-release-notes.mjs';

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

// A release as the GitHub API describes it, with one asset per platform row.
function release() {
  const asset = (name) => ({
    name,
    browser_download_url: `https://github.com/PanteraPolnocy/Minibee-Viewer/releases/download/0.14.0/${name}`,
    size: 1024 * 1024,
    digest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  });
  return {
    tag_name: '0.14.0',
    assets: [
      asset('android_Minibee-Viewer_0.14.0_universal.apk'),
      asset('android_Minibee-Viewer_0.14.0_universal.aab'),
      asset('windows_Minibee-Viewer_0.14.0_x64.msi'),
      asset('windows_Minibee-Viewer_0.14.0_x64_setup.exe'),
      asset('linux_Minibee-Viewer_0.14.0_amd64.deb'),
      asset('linux_Minibee-Viewer_0.14.0_x86_64.rpm'),
      asset('linux_Minibee-Viewer_0.14.0_amd64.AppImage'),
      asset('macos_Minibee-Viewer_0.14.0_universal.dmg'),
    ],
  };
}

// The table rows, in order: [platform, package cell].
function tableRows(block) {
  return block
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Platform') && !line.startsWith('|--'))
    .map((line) => line.split('|').map((c) => c.trim()).filter(Boolean))
    .map((cells) => [cells[0], cells[1]]);
}

// Runs `fn` with MINIBEE_GOOGLE_PLAY_RECOMMENDED set to `value` (unset when
// undefined), restoring whatever was there before.
function withPlayRecommended(value, fn) {
  const before = process.env.MINIBEE_GOOGLE_PLAY_RECOMMENDED;
  if (value === undefined) delete process.env.MINIBEE_GOOGLE_PLAY_RECOMMENDED;
  else process.env.MINIBEE_GOOGLE_PLAY_RECOMMENDED = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.MINIBEE_GOOGLE_PLAY_RECOMMENDED;
    else process.env.MINIBEE_GOOGLE_PLAY_RECOMMENDED = before;
  }
}

// CI sets MINIBEE_GOOGLE_PLAY_RECOMMENDED=1 for a stable release that the
// workflow uploaded to Play (build-android's `play` step: service-account
// secret present and not a prerelease). Google Play is then the recommended
// Android install, listed first and in bold, and the APK is a plain row.
test('a Play-uploaded stable release recommends Google Play for Android', () => {
  withPlayRecommended('1', () => {
    const rows = tableRows(buildDownloadBlock(release()));
    const android = rows.filter(([platform]) => platform === 'Android');
    assert.deepEqual(android.map(([, pkg]) => pkg), [
      '**Google Play (Play edition - no L$ buying)** *(recommended)*',
      'APK (full app, sideload)',
      'App Bundle (.aab, Google Play edition - no L$ buying)',
    ]);
    assert.match(buildDownloadBlock(release()), /install from \*\*Google Play\*\* when possible/);
  });
});

// A prerelease, or a run without the Play secret, sets 0: the release is not
// on Play, so the sideload APK is the recommended row and the Play row is
// demoted to a plain pointer.
test('a release that never reached Play recommends the APK instead', () => {
  withPlayRecommended('0', () => {
    const block = buildDownloadBlock(release());
    const android = tableRows(block).filter(([platform]) => platform === 'Android');
    assert.deepEqual(android.map(([, pkg]) => pkg), [
      '**APK (full app, sideload)** *(recommended)*',
      'Google Play (Play edition - no L$ buying)',
      'App Bundle (.aab, Google Play edition - no L$ buying)',
    ]);
    assert.match(block, /this release is not on Google Play: sideload the APK/);
    assert.doesNotMatch(block, /install from \*\*Google Play\*\* when possible/);
  });
});

// Outside CI (a local --dry-run) the variable is unset: Minibee is on Google
// Play, so that is the default recommendation.
test('without the CI variable Google Play stays the default recommendation', () => {
  withPlayRecommended(undefined, () => {
    const android = tableRows(buildDownloadBlock(release())).filter(([p]) => p === 'Android');
    assert.equal(android[0][1], '**Google Play (Play edition - no L$ buying)** *(recommended)*');
  });
});

// Desktop rows are untouched by the Android switch: the installer, disk image
// and AppImage are recommended and listed first; WinGet is a plain row after
// the recommended installer; the MSI trails.
test('desktop recommendations do not depend on the Play switch', () => {
  for (const value of ['1', '0']) {
    withPlayRecommended(value, () => {
      const rows = tableRows(buildDownloadBlock(release()));
      assert.deepEqual(rows.filter(([p]) => p === 'Windows').map(([, pkg]) => pkg), [
        '**Installer (.exe)** *(recommended)*',
        'WinGet',
        'MSI (enterprise)',
      ]);
      assert.deepEqual(rows.filter(([p]) => p === 'macOS').map(([, pkg]) => pkg), [
        '**Disk image (.dmg)** *(recommended)*',
      ]);
      assert.deepEqual(rows.filter(([p]) => p === 'Linux').map(([, pkg]) => pkg), [
        '**AppImage** *(recommended)*',
        'Debian package (.deb)',
        'RPM package (.rpm)',
      ]);
      // Platform order is fixed: Windows, macOS, Linux, Android.
      const order = rows.map(([p]) => p).filter((p, i, all) => all.indexOf(p) === i);
      assert.deepEqual(order, ['Windows', 'macOS', 'Linux', 'Android']);
    });
  }
});
