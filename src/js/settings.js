/**
 * Viewer preferences, kept in localStorage between sessions.
 */
const FSSettings = (function () {
  'use strict';

  const STORAGE_KEY = 'minibee-settings';

  const SCHEMA = {
    radarRange: { type: 'number', default: 96, min: 16, max: 256, step: 8 },
    radarAlerts: { type: 'boolean', default: true },
    buddiesOnlineOnly: { type: 'boolean', default: false },
    destFeed: { type: 'string', default: 'mobile' },
    // Reconnect on an unexpected disconnect (off by default). The Rust core
    // keeps the credentials (obfuscated) and replays the login when asked.
    autoReconnect: { type: 'boolean', default: false },
    // When off (the default), info/warn diagnostics aren't kept in the in-memory
    // log - hard errors still are. (File logging lives separately, in Rust.)
    debugLogDiagnostics: { type: 'boolean', default: false },
    // Parcel music streaming. Off by default because of autoplay policy; volume 0-100.
    parcelMusicEnabled: { type: 'boolean', default: false },
    parcelMusicVolume: { type: 'number', default: 50, min: 0, max: 100, step: 1 },
    theme: { type: 'string', default: 'dark' }
  };

  const STATE_MAP = {
    radarRange: 'radarRange',
    radarAlerts: 'radarAlerts'
  };

  let values = {};
  const listeners = new Set();

  function coerce(key, raw) {
    const spec = SCHEMA[key];
    if (!spec) return undefined;
    if (spec.type === 'boolean') return !!raw;
    if (spec.type === 'number') {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return spec.default;
      let v = n;
      if (spec.min !== undefined) v = Math.max(spec.min, v);
      if (spec.max !== undefined) v = Math.min(spec.max, v);
      if (spec.step) v = Math.round(v / spec.step) * spec.step;
      return v;
    }
    const s = String(raw == null ? '' : raw).trim();
    return s || spec.default;
  }

  function defaults() {
    const out = {};
    Object.keys(SCHEMA).forEach(function (key) {
      out[key] = SCHEMA[key].default;
    });
    return out;
  }

  function loadRaw() {
    const raw = FSUtils.storageGet(STORAGE_KEY, null);
    return raw && typeof raw === 'object' ? raw : {};
  }

  function save() {
    FSUtils.storageSet(STORAGE_KEY, values);
  }

  function applyStatePatch() {
    const patch = {};
    Object.keys(STATE_MAP).forEach(function (key) {
      patch[STATE_MAP[key]] = values[key];
    });
    if (Object.keys(patch).length) FSState.patch(patch);
  }

  function applyTheme(theme) {
    const value = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', value);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', value === 'light' ? '#faf7f2' : '#16120c');
    const sun = document.getElementById('theme-icon-sun');
    const moon = document.getElementById('theme-icon-moon');
    const btn = document.getElementById('btn-theme');
    if (sun) sun.hidden = value !== 'light';
    if (moon) moon.hidden = value === 'light';
    if (btn) {
      btn.title = value === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function init() {
    const stored = loadRaw();
    values = defaults();
    Object.keys(SCHEMA).forEach(function (key) {
      if (stored[key] !== undefined) values[key] = coerce(key, stored[key]);
    });
    save();
    applyStatePatch();
    applyTheme(values.theme);
  }

  function get(key) {
    if (values[key] === undefined) return SCHEMA[key] ? SCHEMA[key].default : undefined;
    return values[key];
  }

  function set(key, value) {
    if (!SCHEMA[key]) return;
    values[key] = coerce(key, value);
    save();
    if (key === 'theme') applyTheme(values[key]);
    if (STATE_MAP[key]) {
      FSState.patch({ [STATE_MAP[key]]: values[key] });
    }
    listeners.forEach(function (fn) {
      try {
        fn(key, values[key]);
      } catch (err) {
        if (typeof console !== 'undefined') console.error('settings listener error (' + key + '):', err);
      }
    });
  }

  function onChange(fn) {
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }

  return {
    init: init,
    get: get,
    set: set,
    onChange: onChange,
    applyTheme: applyTheme,
    toggleTheme: function () {
      set('theme', get('theme') === 'light' ? 'dark' : 'light');
    },
    SCHEMA: SCHEMA
  };
})();
