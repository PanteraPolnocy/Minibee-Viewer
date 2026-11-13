// The language files against the sources.
//
//   npm run lang:check                fail when a key the code uses is not in
//                                     src/lang/en.json, when en.json holds a key
//                                     nothing uses, when a line's placeholders
//                                     and the call's arguments disagree, or
//                                     when a translation is off
//   node scripts/sync-lang.mjs --missing pl
//                                     print what pl.json lacks, as JSON to fill in
//   node scripts/sync-lang.mjs --unused
//                                     print the en.json keys nothing uses
//
// Where keys come from (see src/js/i18n.ts):
//   - TypeScript: t('key', { name: value }) and th(...) inside the modules, or
//     BeeI18n.t / BeeI18n.html spelled out. The key must be a literal; when
//     the arguments are an object literal, its names are checked against the
//     line's {placeholders}.
//   - index.html: data-i18n="key" (the element's own text), data-i18n-html
//     (its inner markup) and data-i18n-title / -placeholder / -aria-label /
//     -alt / -value (that attribute). The markup itself carries no words
//     there: the text of such an element, and that attribute, must be absent.
//   - Rust: ui_err("key", json!({ ... })), ui_text(...), UiText::new(...).
// The words live only in src/lang/en.json (a string, or an object of plural
// forms with exactly `one` and `other`); the translations mirror its keys.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LANG_DIR = path.join(ROOT, 'src', 'lang');
export const EN_FILE = path.join(LANG_DIR, 'en.json');

const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HTML_ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'value'];
const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;

function walk(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out.sort();
}

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

// --- blanking: comments and string bodies become spaces, offsets stay ------

// A slash starts a regex literal, not a division, after an operator, an
// opening bracket, a comma or a keyword that takes an expression.
function regexAllowedAfter(prev) {
  if (prev === '') return true;
  if (prev === 'literal') return false;
  if (/^[A-Za-z0-9_$]+$/.test(prev)) {
    return /^(return|typeof|case|in|of|void|delete|new|throw|instanceof|yield|await|do|else)$/.test(prev);
  }
  return prev !== ')' && prev !== ']';
}

// JavaScript / TypeScript: comments, string and template bodies and regex
// literals become spaces, so a quote inside a regex (or a `t(` inside a
// string) never throws the scan off.
function blankJs(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (src[k] !== '\n') out[k] = ' '; };
  let i = 0;
  let prev = '';
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const s = i;
      while (i < n && src[i] !== '\n') i++;
      blank(s, i);
    } else if (c === '/' && d === '*') {
      const s = i;
      const e = src.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      blank(s, i);
    } else if (c === '\'' || c === '"' || c === '`') {
      const s = i;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++;
        i++;
      }
      blank(s + 1, i);
      i++;
      prev = 'literal';
    } else if (c === '/' && regexAllowedAfter(prev)) {
      const s = i;
      i++;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }
        if (inClass) {
          if (ch === ']') inClass = false;
        } else if (ch === '[') {
          inClass = true;
        } else if (ch === '/') {
          break;
        }
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(src[i])) i++;
      blank(s, i);
      prev = 'literal';
    } else if (/[A-Za-z0-9_$]/.test(c)) {
      const s = i;
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++;
      prev = src.slice(s, i);
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out.join('');
}

// Rust: comments, "strings", r"raw" / r#"raw"# strings and 'c' char literals
// (a lifetime 'a has no closing quote and is left alone).
function blankRust(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blankRange = (from, to) => { for (let k = from; k < to; k++) if (src[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(start, i);
    } else if (c === '/' && d === '*') {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; } else if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      blankRange(start, i);
    } else if (c === 'r' && (d === '"' || (d === '#' && /^r#+"/.test(src.slice(i, i + 8))))) {
      let j = i + 1;
      let hashes = 0;
      while (src[j] === '#') { hashes++; j++; }
      if (src[j] !== '"') { i++; continue; }
      const close = '"' + '#'.repeat(hashes);
      const end = src.indexOf(close, j + 1);
      blankRange(j + 1, end === -1 ? n : end);
      i = end === -1 ? n : end + close.length;
    } else if (c === '"') {
      const start = i + 1;
      i++;
      while (i < n && src[i] !== '"') { if (src[i] === '\\') i++; i++; }
      blankRange(start, i);
      i++;
    } else if (c === '\'') {
      if (src[i + 1] === '\\' && src[i + 3] === '\'') { blankRange(i + 1, i + 3); i += 4; } else if (src[i + 1] !== '\\' && src[i + 2] === '\'') { blankRange(i + 1, i + 2); i += 3; } else i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

// --- literal parsing (on the original source, from a known offset) ----------

function skipWs(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

// A JS string literal at `i` ('...', "..." or a `...` without ${}). Returns
// { value, end } or null.
function jsString(src, i) {
  const q = src[i];
  if (q !== '\'' && q !== '"' && q !== '`') return null;
  let j = i + 1;
  let value = '';
  while (j < src.length && src[j] !== q) {
    const c = src[j];
    if (c === '\\') {
      const e = src[j + 1];
      j += 2;
      if (e === 'n') value += '\n';
      else if (e === 't') value += '\t';
      else if (e === 'r') value += '\r';
      else if (e === '0') value += '\0';
      else if (e === 'x') { value += String.fromCharCode(parseInt(src.substr(j, 2), 16)); j += 2; } else if (e === 'u') {
        if (src[j] === '{') {
          const close = src.indexOf('}', j);
          value += String.fromCodePoint(parseInt(src.slice(j + 1, close), 16));
          j = close + 1;
        } else {
          value += String.fromCharCode(parseInt(src.substr(j, 4), 16));
          j += 4;
        }
      } else if (e === '\n') { /* line continuation */ } else value += e;
      continue;
    }
    if (q === '`' && c === '$' && src[j + 1] === '{') return null;
    if (c === '\n' && q !== '`') return null;
    value += c;
    j++;
  }
  if (j >= src.length) return null;
  return { value, end: j + 1 };
}

// Rust "..." (escapes decoded) or r"..." / r#"..."#. Returns { value, end } or null.
function rustString(src, i) {
  let pos = i;
  if (src[pos] === 'r') {
    let j = pos + 1;
    let hashes = 0;
    while (src[j] === '#') { hashes++; j++; }
    if (src[j] !== '"') return null;
    const close = '"' + '#'.repeat(hashes);
    const end = src.indexOf(close, j + 1);
    if (end === -1) return null;
    return { value: src.slice(j + 1, end), end: end + close.length };
  }
  if (src[pos] !== '"') return null;
  let j = pos + 1;
  let value = '';
  while (j < src.length && src[j] !== '"') {
    const c = src[j];
    if (c === '\\') {
      const e = src[j + 1];
      j += 2;
      if (e === 'n') value += '\n';
      else if (e === 't') value += '\t';
      else if (e === 'r') value += '\r';
      else if (e === '0') value += '\0';
      else if (e === 'x') { value += String.fromCharCode(parseInt(src.substr(j, 2), 16)); j += 2; } else if (e === 'u' && src[j] === '{') {
        const close = src.indexOf('}', j);
        value += String.fromCodePoint(parseInt(src.slice(j + 1, close), 16));
        j = close + 1;
      } else if (e === '\n') {
        while (j < src.length && /[ \t\r\n]/.test(src[j])) j++;
      } else value += e;
      continue;
    }
    value += c;
    j++;
  }
  if (j >= src.length) return null;
  return { value, end: j + 1 };
}

// Skip one expression inside an object literal: up to a `,` or `}` at depth
// 0, over nested brackets and strings. Returns the offset of that delimiter.
function skipValue(src, i, isRust) {
  let depth = 0;
  let pos = i;
  while (pos < src.length) {
    const c = src[pos];
    if (c === '\'' || c === '"' || c === '`') {
      const lit = isRust ? (c === '"' ? rustString(src, pos) : null) : jsString(src, pos);
      if (lit) { pos = lit.end; continue; }
      pos++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return pos;
      depth--;
    } else if (c === ',' && depth === 0) return pos;
    pos++;
  }
  return pos;
}

// The names of an object literal at `i` ({ a: x, 'b': y, c, ...spread }),
// JS or (inside json!) Rust. Returns { names, end } or null when `i` is not
// a literal we can read; `names` is null when a spread makes them unknowable.
function objectNames(src, i, isRust) {
  let pos = skipWs(src, i);
  if (src[pos] !== '{') return null;
  pos++;
  const names = [];
  let unknowable = false;
  for (;;) {
    pos = skipWs(src, pos);
    if (src[pos] === '}') return { names: unknowable ? null : names, end: pos + 1 };
    if (pos >= src.length) return null;
    if (src.startsWith('...', pos)) {
      unknowable = true;
      pos = skipValue(src, pos + 3, isRust);
    } else {
      let name = null;
      const quoted = isRust ? rustString(src, pos) : jsString(src, pos);
      if (quoted) {
        name = quoted.value;
        pos = quoted.end;
      } else {
        const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(pos));
        if (!m) return null;
        name = m[0];
        pos += name.length;
      }
      pos = skipWs(src, pos);
      if (src[pos] === ':') {
        pos = skipValue(src, pos + 1, isRust);
      } else if (src[pos] === '(') {
        // a method shorthand: skip its parameters and body
        pos = skipValue(src, pos, isRust);
      }
      names.push(name);
    }
    pos = skipWs(src, pos);
    if (src[pos] === ',') pos++;
    else if (src[pos] !== '}') return null;
  }
}

// --- sources ----------------------------------------------------------------

const TS_CALL = /(?:\bBeeI18n\s*\.\s*(?:t|html|en)|(?<![\w$.])(?:t|th))\s*\(/g;

function scanTypeScript(file, use, problems) {
  const src = fs.readFileSync(file, 'utf8');
  const code = blankJs(src);
  const where = (offset) => `${rel(file)}:${lineOf(src, offset)}`;
  let m;
  TS_CALL.lastIndex = 0;
  while ((m = TS_CALL.exec(code)) !== null) {
    const open = m.index + m[0].length;
    let pos = skipWs(src, open);
    const key = jsString(src, pos);
    if (!key) continue; // a dynamic key, or the alias being defined
    pos = skipWs(src, key.end);
    let params = null;
    if (src[pos] === ',') {
      pos = skipWs(src, pos + 1);
      if (jsString(src, pos)) {
        problems.push(`${where(m.index)}: '${key.value}' carries words in the code; the wording belongs in src/lang/en.json`);
        continue;
      }
      const obj = objectNames(src, pos, false);
      if (obj) params = obj.names;
    }
    use(key.value, { source: where(m.index), params });
  }
}

const RUST_CALL = /\b(?:ui_text|ui_err|UiText\s*::\s*new)\s*\(/g;

function scanRust(file, use, problems) {
  if (path.basename(file) === 'uitext.rs') return; // the helpers' own module
  const src = fs.readFileSync(file, 'utf8');
  const code = blankRust(src);
  const where = (offset) => `${rel(file)}:${lineOf(src, offset)}`;
  let m;
  RUST_CALL.lastIndex = 0;
  while ((m = RUST_CALL.exec(code)) !== null) {
    if (/\bfn\s+$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
    const open = m.index + m[0].length;
    let pos = skipWs(src, open);
    const key = rustString(src, pos);
    if (!key) {
      problems.push(`${where(m.index)}: the key must be a string literal`);
      continue;
    }
    pos = skipWs(src, key.end);
    let params = null;
    if (src[pos] === ',') {
      pos = skipWs(src, pos + 1);
      if (rustString(src, pos)) {
        problems.push(`${where(m.index)}: "${key.value}" carries words in the code; the wording belongs in src/lang/en.json`);
        continue;
      }
      const macro = /^json!\s*\(/.exec(src.slice(pos));
      if (macro) {
        const obj = objectNames(src, pos + macro[0].length, true);
        if (obj) params = obj.names;
      }
    }
    use(key.value, { source: where(m.index), params });
  }
}

const TAG_RE = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(text) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(text)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
  }
  return attrs;
}

// From just after a start tag: whether the element has text of its own
// (at depth 0) and its inner markup up to the matching close tag.
function elementContent(html, from) {
  // Its own regex: the caller is mid-scan with TAG_RE, and moving that one's
  // position here would skip everything inside this element.
  const tagRe = new RegExp(TAG_RE.source, 'g');
  let pos = from;
  let depth = 0;
  let ownText = false;
  for (;;) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) return { ownText, inner: html.slice(from) };
    if (depth === 0 && /\S/.test(html.slice(pos, lt))) ownText = true;
    if (html[lt + 1] === '/') {
      const gt = html.indexOf('>', lt);
      if (depth === 0) return { ownText, inner: html.slice(from, lt) };
      depth--;
      pos = gt + 1;
      continue;
    }
    tagRe.lastIndex = lt;
    const m = tagRe.exec(html);
    if (!m || m.index !== lt) {
      pos = lt + 1;
      continue;
    }
    if (!m[3] && !VOID_ELEMENTS.has(m[1].toLowerCase())) depth++;
    pos = lt + m[0].length;
  }
}

function scanHtml(file, use, problems) {
  const raw = fs.readFileSync(file, 'utf8');
  const html = raw.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const where = (offset) => `${rel(file)}:${lineOf(raw, offset)}`;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html)) !== null) {
    if (m[2].indexOf('data-i18n') === -1) continue;
    const attrs = parseAttrs(m[2]);
    const tagName = m[1].toLowerCase();
    const after = m.index + m[0].length;
    const selfClosing = !!m[3] || VOID_ELEMENTS.has(tagName);
    const wantsContent = 'data-i18n' in attrs || 'data-i18n-html' in attrs;
    const content = selfClosing || !wantsContent ? null : elementContent(html, after);
    if ('data-i18n' in attrs) {
      const key = attrs['data-i18n'];
      if (!key) problems.push(`${where(m.index)}: empty data-i18n`);
      else {
        if (content && content.ownText) problems.push(`${where(m.index)}: data-i18n="${key}" but the element still carries words; they belong in src/lang/en.json`);
        use(key, { source: where(m.index), params: [] });
      }
    }
    if ('data-i18n-html' in attrs) {
      const key = attrs['data-i18n-html'];
      if (!key) problems.push(`${where(m.index)}: empty data-i18n-html`);
      else {
        if (content && /\S/.test(content.inner)) problems.push(`${where(m.index)}: data-i18n-html="${key}" but the element still carries markup; it belongs in src/lang/en.json`);
        use(key, { source: where(m.index), params: [] });
      }
    }
    for (const attr of HTML_ATTRS) {
      const marker = 'data-i18n-' + attr;
      if (!(marker in attrs)) continue;
      const key = attrs[marker];
      if (!key) problems.push(`${where(m.index)}: empty ${marker}`);
      else {
        if (attr in attrs) problems.push(`${where(m.index)}: ${marker}="${key}" but the element still has a ${attr}; the words belong in src/lang/en.json`);
        use(key, { source: where(m.index), params: [] });
      }
    }
    const unknown = Object.keys(attrs).filter((a) => a.startsWith('data-i18n') &&
      a !== 'data-i18n' && a !== 'data-i18n-html' && !HTML_ATTRS.includes(a.slice('data-i18n-'.length)));
    for (const a of unknown) problems.push(`${where(m.index)}: ${a} is not a marker apply() knows`);
  }
}

// --- collection and validation ----------------------------------------------

function placeholders(wording) {
  const set = new Set();
  const texts = typeof wording === 'string' ? [wording] : Object.values(wording || {});
  for (const text of texts) {
    const re = /\{([A-Za-z0-9_]+)\}/g;
    let m;
    while ((m = re.exec(String(text))) !== null) set.add(m[1]);
  }
  return Array.from(set).sort();
}

/**
 * Every key the sources use and where, with the argument names when the
 * call spells them out.
 * @returns {{ uses: Map<string, Array<{ source: string, params: string[]|null }>>, problems: string[], files: number }}
 */
export function collectUsage(root = ROOT) {
  const uses = new Map();
  const problems = [];
  const use = (key, at) => {
    if (!KEY_RE.test(key)) {
      problems.push(`${at.source}: key "${key}" is not of the form module.name`);
      return;
    }
    if (!uses.has(key)) uses.set(key, []);
    uses.get(key).push(at);
  };
  const ts = walk(path.join(root, 'src', 'js'), '.ts');
  const html = walk(path.join(root, 'src'), '.html');
  const rust = walk(path.join(root, 'src-tauri', 'src'), '.rs');
  for (const file of ts) scanTypeScript(file, use, problems);
  for (const file of html) scanHtml(file, use, problems);
  for (const file of rust) scanRust(file, use, problems);
  return { uses, problems, files: ts.length + html.length + rust.length };
}

/** The shape of en.json itself: strings, or plural objects with exactly one/other. */
export function validateEnglishShape(en) {
  const problems = [];
  if (!en || typeof en !== 'object' || Array.isArray(en)) return ['en: not an object of key -> wording'];
  const keys = Object.keys(en);
  const sorted = keys.slice().sort();
  if (keys.join('\n') !== sorted.join('\n')) problems.push('en: keys are not in sorted order');
  for (const key of keys) {
    const value = en[key];
    if (!KEY_RE.test(key)) problems.push(`en: key "${key}" is not of the form module.name`);
    if (typeof value === 'string') {
      if (!value.trim()) problems.push(`en: "${key}" is empty`);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const forms = Object.keys(value).sort();
      if (forms.join() !== 'one,other') problems.push(`en: "${key}" needs exactly the plural forms one, other (has ${forms.join(', ') || 'none'})`);
      if (forms.some((f) => typeof value[f] !== 'string' || !value[f].trim())) problems.push(`en: "${key}" has an empty plural form`);
    } else {
      problems.push(`en: "${key}" should be a string or an object of plural forms`);
    }
  }
  return problems;
}

/**
 * en.json against the sources: keys used but absent, keys present but
 * unused, and placeholders that disagree with the arguments a call names.
 */
export function validateEnglish(en, uses) {
  const problems = validateEnglishShape(en);
  for (const [key, sites] of uses) {
    if (!(key in en)) {
      problems.push(`${sites[0].source}: "${key}" is not in src/lang/en.json`);
      continue;
    }
    const wanted = placeholders(en[key]);
    const plural = en[key] && typeof en[key] === 'object';
    for (const site of sites) {
      if (!site.params) continue;
      const given = site.params.slice().sort();
      const missing = wanted.filter((p) => !given.includes(p));
      const extra = given.filter((p) => !wanted.includes(p) && !(plural && p === 'count'));
      if (missing.length) problems.push(`${site.source}: "${key}" needs {${missing.join('}, {')}} but the call does not pass it`);
      if (extra.length) problems.push(`${site.source}: "${key}" has no {${extra.join('}, {')}} placeholder for the argument passed`);
    }
  }
  for (const key of Object.keys(en)) {
    if (!uses.has(key)) problems.push(`en: "${key}" is used nowhere (remove it, or use it)`);
  }
  return problems;
}

/** The plural categories a language uses, in CLDR order. */
export function pluralCategories(code) {
  try {
    const cats = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    return PLURAL_FORMS.filter((f) => cats.includes(f));
  } catch (_e) {
    return ['one', 'other'];
  }
}

/**
 * Problems with a translation: keys it lacks or invents, wrong shapes,
 * missing plural forms, placeholders that differ from the English.
 */
export function validateTranslation(en, other, code) {
  const problems = [];
  if (!other || typeof other !== 'object' || Array.isArray(other)) return [`${code}: not an object of key -> wording`];
  const cats = pluralCategories(code);
  const keys = Object.keys(other);
  const sorted = keys.slice().sort();
  if (keys.join('\n') !== sorted.join('\n')) problems.push(`${code}: keys are not in sorted order`);
  for (const key of keys) {
    if (!(key in en)) problems.push(`${code}: "${key}" is not a key en.json has`);
  }
  for (const key of Object.keys(en)) {
    const expected = en[key];
    const got = other[key];
    if (got === undefined) {
      problems.push(`${code}: "${key}" is missing`);
      continue;
    }
    if (typeof expected === 'string') {
      if (typeof got !== 'string') problems.push(`${code}: "${key}" should be a string`);
      else if (!got.trim()) problems.push(`${code}: "${key}" is empty`);
    } else if (!got || typeof got !== 'object' || Array.isArray(got)) {
      problems.push(`${code}: "${key}" should be an object of plural forms (${cats.join(', ')})`);
    } else {
      const forms = Object.keys(got).sort();
      const want = cats.slice().sort();
      if (forms.join() !== want.join()) problems.push(`${code}: "${key}" needs exactly the plural forms ${want.join(', ')} (has ${forms.join(', ') || 'none'})`);
      if (forms.some((f) => typeof got[f] !== 'string' || !got[f].trim())) problems.push(`${code}: "${key}" has an empty plural form`);
    }
    if (typeof got === 'string' || (got && typeof got === 'object')) {
      const a = placeholders(expected).join(',');
      const b = placeholders(got).join(',');
      if (a !== b) problems.push(`${code}: "${key}" placeholders differ: English has {${a}}, ${code} has {${b}}`);
    }
  }
  return problems;
}

/** The keys `other` lacks, with the English wording, as a JSON-ready object. */
export function missingKeys(en, other) {
  const out = {};
  for (const key of Object.keys(en)) if (!(key in (other || {}))) out[key] = en[key];
  return out;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function translationFiles() {
  if (!fs.existsSync(LANG_DIR)) return [];
  return fs.readdirSync(LANG_DIR).filter((f) => f.endsWith('.json') && f !== 'en.json').sort()
    .map((f) => ({ code: f.slice(0, -5), file: path.join(LANG_DIR, f) }));
}

// --- command line --------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const en = fs.existsSync(EN_FILE) ? readJson(EN_FILE) : {};
  const { uses, problems, files } = collectUsage();
  let failed = false;

  if (args[0] === '--missing') {
    const code = args[1];
    if (!code) {
      console.error('[lang] --missing needs a language code');
      process.exit(2);
    }
    const file = path.join(LANG_DIR, `${code}.json`);
    const other = fs.existsSync(file) ? readJson(file) : {};
    process.stdout.write(JSON.stringify(missingKeys(en, other), null, 2) + '\n');
    process.exit(0);
  }
  if (args[0] === '--unused') {
    const unused = Object.keys(en).filter((k) => !uses.has(k));
    process.stdout.write(unused.join('\n') + (unused.length ? '\n' : ''));
    process.exit(0);
  }

  for (const p of problems) console.error(`[lang] ${p}`);
  if (problems.length) failed = true;
  const english = validateEnglish(en, uses);
  for (const p of english) console.error(`[lang] ${p}`);
  if (english.length) failed = true;
  console.log(`[lang] ${uses.size} keys used across ${files} files; en.json has ${Object.keys(en).length}`);

  for (const { code, file } of translationFiles()) {
    let other;
    try {
      other = readJson(file);
    } catch (err) {
      console.error(`[lang] ${code}: ${err.message}`);
      failed = true;
      continue;
    }
    const issues = validateTranslation(en, other, code);
    for (const p of issues) console.error(`[lang] ${p}`);
    if (issues.length) failed = true;
    else console.log(`[lang] ${code}: complete (${Object.keys(other).length} keys)`);
  }
  process.exit(failed ? 1 : 0);
}
