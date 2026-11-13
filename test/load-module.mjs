// Loads a frontend module for `node --test`.
//
// The frontend files are browser *scripts*, not ES modules: each one ends with
// a single top-level `const BeeThing = (function () { ... })()`. So there is
// nothing to import - we strip the types with esbuild (the very same transform
// the real build performs), evaluate the result in a function scope with
// stubbed browser globals, and hand back the module object.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * @param {string} relPath   Path under src/, e.g. 'js/core/sl-slurl.ts'
 * @param {string} globalName The module's global, e.g. 'BeeSlurl'
 * @param {object} stubs     Globals to inject, keyed by name
 */
export function loadBeeModule(relPath, globalName, stubs = {}) {
  const source = fs.readFileSync(path.join(SRC, relPath), 'utf8');
  const { code } = esbuild.transformSync(source, {
    loader: 'ts',
    target: 'es2024',
  });
  // Every module aliases BeeI18n.t when it loads; a test that does not care
  // about languages gets an English-only stand-in that reads src/lang/en.json,
  // the words the app falls back to.
  if (!('BeeI18n' in stubs) && globalName !== 'BeeI18n') {
    stubs = Object.assign({ BeeI18n: englishOnlyI18n() }, stubs);
  }
  const names = Object.keys(stubs);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${code}\n;return ${globalName};`);
  return factory(...names.map((n) => stubs[n]));
}

/** A BeeI18n that knows only src/lang/en.json, read once from disk. */
export function englishOnlyI18n() {
  let words = null;
  const english = () => {
    if (!words) {
      try {
        words = JSON.parse(fs.readFileSync(path.join(SRC, 'lang', 'en.json'), 'utf8'));
      } catch (_e) {
        words = {};
      }
    }
    return words;
  };
  const rules = new Intl.PluralRules('en');
  const escape = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pick = (entry, params) => {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return null;
    const n = params && params.count != null ? Number(params.count) : NaN;
    const form = Number.isFinite(n) ? rules.select(n) : 'other';
    return typeof entry[form] === 'string' ? entry[form] : (typeof entry.other === 'string' ? entry.other : null);
  };
  const fill = (template, params, esc) => !params ? template
    : template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name) => {
      if (!Object.prototype.hasOwnProperty.call(params, name)) return whole;
      const text = params[name] == null ? '' : String(params[name]);
      return esc ? escape(text) : text;
    });
  const line = (key, params, esc) => {
    const text = pick(english()[key], params);
    return text === null ? null : fill(text, params, esc);
  };
  const t = (key, params) => { const s = line(key, params, false); return s === null ? String(key) : s; };
  const html = (key, params) => { const s = line(key, params, true); return s === null ? String(key) : s; };
  const field = (obj, name) => {
    if (!obj || typeof obj !== 'object') return '';
    const plain = obj[name] == null ? '' : String(obj[name]);
    const key = obj[name + 'Key'];
    if (typeof key !== 'string' || !key) return plain;
    const s = line(key, obj[name + 'Args'] || undefined, false);
    return s === null ? plain : s;
  };
  const fromCore = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') {
      if (v.charCodeAt(0) === 123 && v.indexOf('"key"') !== -1) {
        try { return fromCore(JSON.parse(v)); } catch (_e) { /* a plain string */ }
      }
      return v;
    }
    if (typeof v === 'object') {
      const plain = typeof v.text === 'string' ? v.text : '';
      if (typeof v.key === 'string' && v.key) { const s = line(v.key, v.args || undefined, false); return s === null ? (plain || v.key) : s; }
      return plain;
    }
    return String(v);
  };
  const localize = (payload, depth = 0) => {
    if (!payload || typeof payload !== 'object' || depth > 5) return payload;
    if (Array.isArray(payload)) { payload.forEach((item) => localize(item, depth + 1)); return payload; }
    if (typeof payload.key === 'string' && payload.key && typeof payload.text === 'string' &&
        payload.args && typeof payload.args === 'object') payload.text = fromCore(payload);
    for (const name of Object.keys(payload)) {
      const value = payload[name];
      if (typeof value === 'string') {
        if (typeof payload[name + 'Key'] === 'string' && payload[name + 'Key']) payload[name] = field(payload, name);
      } else if (value && typeof value === 'object') {
        localize(value, depth + 1);
      }
    }
    return payload;
  };
  return {
    DEFAULT: 'en',
    languages: () => [['en', 'English']],
    load: async () => 'en',
    lang: () => 'en',
    t,
    html,
    en: t,
    has: (key) => typeof english()[key] !== 'undefined',
    field,
    textOf: (obj) => field(obj, 'text'),
    fromCore,
    localize,
    apply: () => {},
    formatNumber: (n) => Number(n).toLocaleString('en-US'),
    dateLocale: () => undefined,
    onChange: () => () => {}
  };
}
