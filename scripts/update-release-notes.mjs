#!/usr/bin/env node
/**
 * Patches a GitHub release body: keeps the author's notes, inserts GitHub's auto-generated
 * changelog (no external API key), a per-platform download table (with checksums), then
 * appends the README/LICENSE footer.
 *
 * Usage:
 *   node scripts/update-release-notes.mjs --release-id 12345
 *   node scripts/update-release-notes.mjs --tag 0.0.0 --dry-run
 *
 * SHA-256 cells link to VirusTotal scan results (no API key required).
 * Release uploads run by default in CI (crazy-max/ghaction-virustotal; secret VIRUSTOTAL_API_KEY).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_REPO = 'PanteraPolnocy/Minibee-Viewer';
const DOWNLOAD_BEGIN = '<!-- minibee-downloads:begin -->';
const DOWNLOAD_END = '<!-- minibee-downloads:end -->';
const CHANGELOG_BEGIN = '<!-- minibee-changelog:begin -->';
const CHANGELOG_END = '<!-- minibee-changelog:end -->';
const FOOTER_BEGIN = '<!-- minibee-footer:begin -->';

const PLATFORM_ORDER = ['Windows', 'macOS', 'Linux', 'Android'];
const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=com.pantera.minibee_viewer';
const WINGET_INSTALL = 'winget install Minibee.Viewer';
const VIRUSTOTAL_FILE_GUI = 'https://www.virustotal.com/gui/file/';

const ASSET_RULES = [
  { test: (n) => n.endsWith('_setup.exe'), platform: 'Windows', label: 'Installer (.exe)', recommended: true, sort: 0 },
  { test: (n) => n.startsWith('windows_') && n.endsWith('.msi'), platform: 'Windows', label: 'MSI (enterprise)', sort: 1 },
  { test: (n) => n.endsWith('.dmg'), platform: 'macOS', label: 'Disk image (.dmg)', recommended: true, sort: 0 },
  { test: (n) => n.endsWith('.AppImage'), platform: 'Linux', label: 'AppImage', recommended: true, sort: 0 },
  { test: (n) => n.endsWith('.deb'), platform: 'Linux', label: 'Debian package (.deb)', sort: 1 },
  { test: (n) => n.endsWith('.rpm'), platform: 'Linux', label: 'RPM package (.rpm)', sort: 2 },
  { test: (n) => n.endsWith('.apk'), platform: 'Android', label: 'APK (full app, sideload)', sort: 0 },
  { test: (n) => n.endsWith('.aab'), platform: 'Android', label: 'App Bundle (.aab, Google Play edition - no L$ buying)', sort: 1 },
];

/**
 * @returns {boolean} Google Play is the recommended Android install (stable + Play CI upload).
 */
function googlePlayRowRecommended() {
  if (process.env.MINIBEE_GOOGLE_PLAY_RECOMMENDED === '0') return false;
  // Default true: Minibee is on Google Play; CI sets 0 for prereleases / no Play upload.
  return true;
}

/** Store / package-manager rows that are not GitHub release assets. */
function buildExtraDistributionRows() {
  return [
    {
      platform: 'Windows',
      label: 'WinGet',
      sort: -1,
      downloadText: `\`${WINGET_INSTALL}\``,
    },
    {
      platform: 'Android',
      label: 'Google Play (Play edition - no L$ buying)',
      recommended: googlePlayRowRecommended(),
      sort: -1,
      url: GOOGLE_PLAY_URL,
      downloadLabel: 'Install on Google Play',
    },
  ];
}

const FOOTER_MESSAGES = [
  (readme, license) =>
    `*Forgot how this magic works?* Check out the [README](${readme})! *(And remember to respect the [LICENSE](${license}) so no dragons get involved!)*`,
  (readme, license) =>
    `*RTFM time!* Dive into the [README](${readme}) before things explode, and peek at the [LICENSE](${license}) to keep the legal team sleeping soundly.`,
  (readme, license) =>
    `*Lost in the source code wilderness?* Here is your survival map: [README](${readme}). Playground rules apply: see [LICENSE](${license}).`,
  (readme, license) =>
    `*Pro tip:* Reading the [README](${readme}) grants +10 code stability. Terms & conditions apply ([LICENSE](${license})).`,
  (readme, license) =>
    `*Before you smash that run button:* Get the full lore in the [README](${readme}) and inspect the fine print in the [LICENSE](${license}).`,
  (readme, license) =>
    `*This is not a drill.* Well, it might be. Either way, the [README](${readme}) explains what buttons do what, and the [LICENSE](${license}) explains what lawyers do what.`,
  (readme, license) =>
    `*Congratulations, you found the download section.* Gold star. Now earn the platinum star: read the [README](${readme}) and nod solemnly at the [LICENSE](${license}).`,
  (readme, license) =>
    `*Minibee is experimental software.* So is this sentence. For slightly less experimental guidance, see the [README](${readme}). For the binding kind of experimental, see the [LICENSE](${license}).`,
  (readme, license) =>
    `*Plot twist:* the real treasure was the documentation we made along the way. Start with the [README](${readme}), then the [LICENSE](${license}) - no side quests required.`,
  (readme, license) =>
    `*You wouldn't download a car.* You would, however, download a bee. While it installs, skim the [README](${readme}) and respect the [LICENSE](${license}) like a responsible digital citizen.`,
  (readme, license) =>
    `*Have you tried turning it off and on again?* If that fails, try the [README](${readme}). If *that* fails, at least you read the [LICENSE](${license}) and can say you did your part.`,
  (readme, license) =>
    `*Warning:* side effects of Minibee may include chatting, teleporting, and sudden urges to read the [README](${readme}). Consult the [LICENSE](${license}) if symptoms persist beyond four hours.`,
  (readme, license) =>
    `*In a world full of 3D viewers,* be the one who reads the [README](${readme}). Then be the one who respects the [LICENSE](${license}). Be legendary. Be mildly compliant.`,
  (readme, license) =>
    `*Fun fact:* every time someone skips the [README](${readme}), a developer sighs audibly. Do your bit for developer morale. Glance at the [LICENSE](${license}) too - we can hear you not reading it.`,
  (readme, license) =>
    `*Press F to pay respects* to the [README](${readme}) authors. Press L to acknowledge the [LICENSE](${license}). (Those are not real keybinds. Read the README to find out what the real ones are.)`,
  (readme, license) =>
    `*Achievement unlocked: Downloaded Minibee.* Next achievement: *Read the Manual* - open the [README](${readme}). Secret achievement: *Lawful Good* - also open the [LICENSE](${license}).`,
  (readme, license) =>
    `*Somewhere, a Linden is smiling.* Probably not at your install choices, but still. Make better choices: start with the [README](${readme}) and the [LICENSE](${license}).`,
  (readme, license) =>
    `*This footer was randomly selected from a pool of twenty.* So were your odds of reading the [README](${readme}). Beat the odds. Peek at the [LICENSE](${license}) while you are feeling lucky.`,
  (readme, license) =>
    `*Minibee does not render the 3D world.* It does, however, render helpful text in the [README](${readme}) and legally binding text in the [LICENSE](${license}). Priorities.`,
  (readme, license) =>
    `*Dear future you:* when something breaks, future you will wish present you had read the [README](${readme}). Future you will also thank present you for respecting the [LICENSE](${license}). Be kind to future you.`,
];

function parseArgs(argv) {
  let releaseId = process.env.RELEASE_ID || '';
  let tag = process.env.RELEASE_TAG || '';
  let repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  let dryRun = false;
  let skipChangelog = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-changelog' || arg === '--no-ai') {
      skipChangelog = true;
    } else if (arg === '--release-id') {
      releaseId = argv[++i] ?? '';
    } else if (arg === '--tag') {
      tag = argv[++i] ?? '';
    } else if (arg === '--repo') {
      repo = argv[++i] ?? repo;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/update-release-notes.mjs [options]

Options:
  --release-id <id>   GitHub release id (preferred in CI)
  --tag <name>        Release tag (alternative lookup)
  --repo <owner/name> GitHub repository (default: ${DEFAULT_REPO})
  --dry-run           Print patched body to stdout; do not write
  --no-changelog      Skip the GitHub-generated changelog section
`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (!releaseId && !tag) {
    console.error('Provide --release-id or --tag');
    process.exit(1);
  }

  // Everything below ends up interpolated into GitHub API URLs; refuse inputs
  // that could point the request anywhere else.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(repo)) {
    console.error(`Not an owner/name repository: ${repo}`);
    process.exit(1);
  }
  if (releaseId && !/^\d+$/.test(String(releaseId))) {
    console.error(`Release id must be numeric: ${releaseId}`);
    process.exit(1);
  }

  return { releaseId, tag, repo, dryRun, skipChangelog };
}

function apiHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'minibee-viewer-release-notes',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

/**
 * @param {string} repo
 * @param {{ releaseId: string; tag: string }} lookup
 */
async function fetchRelease(repo, lookup) {
  const url = lookup.releaseId
    ? `https://api.github.com/repos/${repo}/releases/${lookup.releaseId}`
    : `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(lookup.tag)}`;

  const response = await fetch(url, { headers: apiHeaders() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url}: ${body}`);
  }
  return response.json();
}

/**
 * @param {string} url
 */
async function githubGet(url) {
  const response = await fetch(url, { headers: apiHeaders() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url}: ${body}`);
  }
  return response.json();
}

/**
 * @param {string} url
 * @param {Record<string, unknown>} body
 */
async function githubPost(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url}: ${text}`);
  }
  return response.json();
}

/**
 * @param {string} repo
 */
async function listReleases(repo) {
  return githubGet(`https://api.github.com/repos/${repo}/releases?per_page=100`);
}

/**
 * @param {string} tag
 */
function normalizeTag(tag) {
  return String(tag).replace(/^v/i, '').toLowerCase();
}

/**
 * @param {Array<{ tag_name: string; draft: boolean; published_at: string }>} releases
 * @param {string} currentTag
 */
function findPreviousRelease(releases, currentTag) {
  const current = normalizeTag(currentTag);
  const sorted = releases
    .filter((release) => !release.draft && release.published_at)
    .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
  const index = sorted.findIndex((release) => normalizeTag(release.tag_name) === current);
  if (index === -1) return null;
  return sorted[index + 1] ?? null;
}

/**
 * @param {string} repo
 * @param {string} tagName
 * @param {string | undefined} previousTagName
 */
async function generateGithubReleaseNotes(repo, tagName, previousTagName) {
  /** @type {{ tag_name: string; previous_tag_name?: string }} */
  const payload = { tag_name: tagName };
  if (previousTagName) {
    payload.previous_tag_name = previousTagName;
  }
  return githubPost(`https://api.github.com/repos/${repo}/releases/generate-notes`, payload);
}

/**
 * @param {string} markdown
 * @param {string | undefined} fromTag
 * @param {string} repo
 */
function wrapChangelog(markdown, fromTag, repo) {
  const attribution = fromTag
    ? `_Changes since [${fromTag}](https://github.com/${repo}/releases/tag/${encodeURIComponent(fromTag)}); generated by GitHub._`
    : '_Generated by GitHub from repository changes._';

  return [
    CHANGELOG_BEGIN,
    '',
    markdown,
    '',
    attribution,
    '',
    CHANGELOG_END,
  ].join('\n');
}

/**
 * @param {Awaited<ReturnType<typeof fetchRelease>>} release
 * @param {string} repo
 * @param {boolean} skipChangelog
 */
async function buildChangelogBlock(release, repo, skipChangelog) {
  if (skipChangelog) return '';

  const releases = await listReleases(repo);
  const previous = findPreviousRelease(releases, release.tag_name);

  let generated;
  try {
    generated = await generateGithubReleaseNotes(
      repo,
      release.tag_name,
      previous?.tag_name,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`GitHub changelog skipped: ${message}`);
    return '';
  }

  const markdown = generated.body?.trim();
  if (!markdown) {
    console.warn('GitHub changelog skipped: empty body from generate-notes.');
    return '';
  }

  return wrapChangelog(markdown, previous?.tag_name, repo);
}

/**
 * @param {number} bytes
 */
function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex <= 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

/**
 * @param {string | undefined} digest
 */
function normalizeSha256Hex(digest) {
  if (!digest) return '';
  const hex = digest.startsWith('sha256:') ? digest.slice(7) : digest;
  return /^[a-f0-9]{64}$/i.test(hex) ? hex.toLowerCase() : '';
}

/**
 * @param {string | undefined} digest
 */
export function formatDigest(digest) {
  const hex = normalizeSha256Hex(digest);
  if (!hex) return '-';
  const formatted = hex.length <= 24 ? hex : `${hex.slice(0, 12)}...${hex.slice(-12)}`;
  const vtUrl = `${VIRUSTOTAL_FILE_GUI}${hex}`;
  return `\`${formatted}\`<br>[VirusTotal scan](${vtUrl})`;
}

/**
 * @param {{ name: string }} asset
 */
function classifyAsset(asset) {
  const name = asset.name;
  if (name.endsWith('.sig') || name === 'latest.json') return null;
  if (name.includes('.app.tar.gz')) return null;

  for (const rule of ASSET_RULES) {
    if (rule.test(name)) {
      return {
        platform: rule.platform,
        label: rule.label,
        recommended: rule.recommended ?? false,
        sort: rule.sort,
      };
    }
  }
  return null;
}

/**
 * @param {string} text
 * @param {string} begin
 * @param {string} end
 */
function stripBetween(text, begin, end) {
  let result = text;
  for (;;) {
    const start = result.indexOf(begin);
    if (start === -1) break;
    const stop = result.indexOf(end, start);
    if (stop === -1) break;
    result = `${result.slice(0, start)}${result.slice(stop + end.length)}`;
  }
  return result;
}

/**
 * @param {string | null | undefined} body
 */
export function stripAutoSections(body) {
  let text = (body ?? '').replace(/\r\n/g, '\n').trimEnd();
  text = stripBetween(text, CHANGELOG_BEGIN, CHANGELOG_END).trimEnd();
  text = stripBetween(text, DOWNLOAD_BEGIN, DOWNLOAD_END).trimEnd();
  const footerIdx = text.indexOf(FOOTER_BEGIN);
  if (footerIdx !== -1) {
    text = text.slice(0, footerIdx).trimEnd();
  }
  text = stripLegacyFooter(text);
  return text;
}

/**
 * @param {string} text
 */
function stripLegacyFooter(text) {
  const divider = text.lastIndexOf('\n---\n');
  if (divider === -1) return text;
  const tail = text.slice(divider);
  if (tail.includes('/README.md') && tail.includes('/LICENSE')) {
    return text.slice(0, divider).trimEnd();
  }
  return text;
}

/**
 * @param {Awaited<ReturnType<typeof fetchRelease>>} release
 */
export function buildDownloadBlock(release) {
  const version = String(release.tag_name).replace(/^v/, '');

  /** @type {Array<{ platform: string; label: string; recommended: boolean; sort: number; url?: string; downloadLabel?: string; downloadText?: string; size?: number; digest?: string }>} */
  const playRecommended = googlePlayRowRecommended();
  const rows = buildExtraDistributionRows().map((row) => ({
    ...row,
    recommended: row.recommended ?? false,
  }));

  for (const asset of release.assets ?? []) {
    const info = classifyAsset(asset);
    if (!info) continue;
    const recommended =
      asset.name.endsWith('.apk')
        ? !playRecommended
        : (info.recommended ?? false);
    rows.push({
      ...info,
      recommended,
      url: asset.browser_download_url,
      size: asset.size,
      digest: asset.digest,
    });
  }

  rows.sort((a, b) => {
    const platformDelta = PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform);
    if (platformDelta !== 0) return platformDelta;
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    return a.sort - b.sort;
  });

  if (rows.length === 0) {
    throw new Error(`No user-facing release assets found on ${release.tag_name}`);
  }

  const lines = [
    DOWNLOAD_BEGIN,
    '',
    '### Downloads',
    '',
    '| Platform | Package | Download | Size | SHA-256 |',
    '|----------|---------|----------|------|---------|',
  ];

  for (const row of rows) {
    const packageLabel = row.recommended ? `**${row.label}** *(recommended)*` : row.label;
    const downloadCell = row.downloadText
      ? row.downloadText
      : `[${row.downloadLabel ?? row.url?.split('/').pop() ?? row.label}](${row.url})`;
    lines.push(
      `| ${row.platform} | ${packageLabel} | ${downloadCell} | ${formatSize(row.size ?? NaN)} | ${formatDigest(row.digest)} |`,
    );
  }

  lines.push(
    '',
    `_Built for Minibee Viewer ${version}. On Windows, \`${WINGET_INSTALL}\` is available via WinGet; direct builds are unsigned and will stay that way (SmartScreen may warn - use **More info -> Run anyway**). On Android, install from **Google Play** when possible; the APK is for sideloading (full app with L$ buying). The \`.aab\` is the Play edition bundle: to comply with Play's virtual-currency billing policy it cannot buy L$ in-app (spending your balance works normally)._`,
    '',
    '<details>',
    '<summary>How to verify a download</summary>',
    '',
    'Compare the SHA-256 above with a local hash of the file you downloaded:',
    '',
    '```bat',
    'certutil -hashfile path\\to\\installer SHA256',
    '```',
    '',
    '```bash',
    'sha256sum path/to/installer',
    '```',
    '',
    'On macOS, `shasum -a 256 path/to/installer` works too. Abbreviated checksums are middle-truncated; use **VirusTotal scan** for multi-engine results (analysis appears after the file is indexed on [VirusTotal](https://www.virustotal.com/)).',
    '',
    '</details>',
    '',
    DOWNLOAD_END,
  );

  return lines.join('\n');
}

/**
 * @param {string} repo
 * @param {string} tag
 */
function buildFooter(repo, tag) {
  const readmeUrl = `https://github.com/${repo}/blob/${tag}/README.md`;
  const licenseUrl = `https://github.com/${repo}/blob/${tag}/LICENSE`;
  const message = FOOTER_MESSAGES[Math.floor(Math.random() * FOOTER_MESSAGES.length)](readmeUrl, licenseUrl);
  return `${FOOTER_BEGIN}\n---\n${message}`;
}

/**
 * @param {Awaited<ReturnType<typeof fetchRelease>>} release
 * @param {string} repo
 * @param {{ skipChangelog?: boolean }} [options]
 */
export async function composeReleaseBody(release, repo, options = {}) {
  const userNotes = stripAutoSections(release.body);
  const changelog = await buildChangelogBlock(release, repo, options.skipChangelog ?? false);
  const downloads = buildDownloadBlock(release);
  const footer = buildFooter(repo, release.tag_name);
  const parts = [userNotes, changelog, downloads, footer].filter((part) => part.length > 0);
  return parts.join('\n\n');
}

/**
 * @param {string} repo
 * @param {string} releaseId
 * @param {string} body
 */
async function patchRelease(repo, releaseId, body) {
  const url = `https://api.github.com/repos/${repo}/releases/${releaseId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: apiHeaders(),
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status} patching release: ${text}`);
  }
  return response.json();
}

async function main() {
  const { releaseId, tag, repo, dryRun, skipChangelog } = parseArgs(process.argv);
  const release = await fetchRelease(repo, { releaseId, tag });
  const body = await composeReleaseBody(release, repo, { skipChangelog });

  if (dryRun) {
    process.stdout.write(`${body}\n`);
    return;
  }

  const id = releaseId || String(release.id);
  await patchRelease(repo, id, body);
  console.log(`Updated release notes for ${release.tag_name}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
