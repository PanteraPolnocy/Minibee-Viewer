/**
 * Viewer preferences persisted in localStorage.
 */
const FSSettings = (function () {
  'use strict';

  const STORAGE_KEY = 'minibee-settings';
  const STORAGE_KEY_LEGACY = 'fs-mobile-settings';
  const CREDENTIALS_KEY = 'minibee-credentials';
  const CREDENTIALS_KEY_LEGACY = 'fs-mobile-credentials';
  const MFA_PREFIX = 'minibee-mfa-';
  const MFA_PREFIX_LEGACY = 'fs-mobile-mfa-';

  const SENSITIVE_KEY_PATTERNS = [
    /^minibee-mfa-/i,
    /^fs-mobile-mfa-/i,
    /password/i,
    /token/i,
    /hash/i,
    /^minibee-mac$/i,
    /^fs-mobile-mac$/i,
    /^minibee-id0$/i,
    /^fs-mobile-id0$/i,
    /^minibee-host-id$/i,
    /^fs-mobile-host-id$/i
  ];

  const SCHEMA = {
    radarRange: { type: 'number', default: 96, min: 16, max: 256, step: 8 },
    radarAlerts: { type: 'boolean', default: true },
    buddiesOnlineOnly: { type: 'boolean', default: false },
    destFeed: { type: 'string', default: 'mobile' },
    logSubtab: { type: 'string', default: 'diagnostics' },
    theme: { type: 'string', default: 'dark' }
  };

  const STATE_MAP = {
    radarRange: 'radarRange',
    radarAlerts: 'radarAlerts'
  };

  let values = {};
  const listeners = new Set();

  function isSensitiveStorageKey(key) {
    return SENSITIVE_KEY_PATTERNS.some(function (pattern) { return pattern.test(key); });
  }

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
    let raw = FSUtils.storageGet(STORAGE_KEY, null);
    if (!raw) {
      raw = FSUtils.storageGet(STORAGE_KEY_LEGACY, null);
      if (raw) {
        FSUtils.storageSet(STORAGE_KEY, raw);
        try { localStorage.removeItem(STORAGE_KEY_LEGACY); } catch (_e) { /* ignore */ }
      }
    }
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
    listeners.forEach(function (fn) { fn(key, values[key]); });
  }

  function onChange(fn) {
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }

  function gridLabel(grid) {
    const map = { agni: 'Second Life (Agni)', aditi: 'Second Life (Aditi)', local: 'OpenSim (local)' };
    return map[grid] || grid;
  }

  function feedLabel(feedId) {
    const map = {
      mobile: 'Mobile',
      popular: 'Popular',
      new: 'New',
      editor: 'Editor',
      events: 'Events'
    };
    return map[feedId] || feedId;
  }

  function readCredentials() {
    let saved = FSUtils.storageGet(CREDENTIALS_KEY, null);
    if (!saved) {
      saved = FSUtils.storageGet(CREDENTIALS_KEY_LEGACY, null);
    }
    return saved && typeof saved === 'object' ? saved : null;
  }

  function mfaRememberedRows() {
    const rows = [];
    const seen = new Set();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        let suffix = '';
        if (key.indexOf(MFA_PREFIX) === 0) suffix = key.slice(MFA_PREFIX.length);
        else if (key.indexOf(MFA_PREFIX_LEGACY) === 0) suffix = key.slice(MFA_PREFIX_LEGACY.length);
        else continue;
        if (!suffix || seen.has(suffix)) continue;
        seen.add(suffix);
        rows.push({
          label: 'MFA remembered',
          value: suffix.replace(/-/g, ' / ') + ' (stored, value hidden)'
        });
      }
    } catch (_e) { /* ignore */ }
    return rows;
  }

  function getDisplaySections() {
    const sections = [];

    sections.push({
      title: 'Radar',
      items: [
        { label: 'Range', value: String(get('radarRange')) + ' m' },
        { label: 'Alerts', value: get('radarAlerts') ? 'On' : 'Off' }
      ]
    });

    sections.push({
      title: 'Buddies',
      items: [
        { label: 'Online only filter', value: get('buddiesOnlineOnly') ? 'On' : 'Off' }
      ]
    });

    sections.push({
      title: 'Destination Guide',
      items: [
        { label: 'Last feed', value: feedLabel(get('destFeed')) }
      ]
    });

    sections.push({
      title: 'Appearance',
      items: [
        { label: 'Theme', value: get('theme') === 'light' ? 'Light' : 'Dark (default)' }
      ]
    });

    sections.push({
      title: 'Log',
      items: [
        { label: 'Default subtab', value: get('logSubtab') === 'settings' ? 'Settings' : 'Diagnostics' }
      ]
    });

    const creds = readCredentials();
    const loginItems = [
      { label: 'Remember credentials', value: creds && creds.remember ? 'Yes' : 'No' }
    ];
    if (creds && creds.remember) {
      if (creds.username) loginItems.push({ label: 'Saved username', value: creds.username });
      if (creds.grid) loginItems.push({ label: 'Saved grid', value: gridLabel(creds.grid) });
    }
    loginItems.push.apply(loginItems, mfaRememberedRows());
    sections.push({ title: 'Login', items: loginItems });

    sections.push({
      title: 'Storage',
      items: storageSummaryRows()
    });

    return sections;
  }

  function storageSummaryRows() {
    let total = 0;
    let hidden = 0;
    const visible = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        total += 1;
        if (isSensitiveStorageKey(key)) {
          hidden += 1;
        } else {
          visible.push(key);
        }
      }
    } catch (_e) { /* ignore */ }
    visible.sort();
    const rows = [
      { label: 'Settings key', value: STORAGE_KEY },
      { label: 'Total localStorage keys', value: String(total) },
      {
        label: 'Listed here',
        value: visible.length ? visible.join(', ') : 'none'
      }
    ];
    if (hidden > 0) {
      rows.push({
        label: 'Hidden from this panel',
        value: hidden + ' (device ID, MAC, MFA token — values not shown)'
      });
    }
    return rows;
  }

  function listSafeStorageKeys() {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || isSensitiveStorageKey(key)) continue;
        keys.push(key);
      }
    } catch (_e) { /* ignore */ }
    keys.sort();
    return keys;
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
    getDisplaySections: getDisplaySections,
    listSafeStorageKeys: listSafeStorageKeys,
    isSensitiveStorageKey: isSensitiveStorageKey,
    SCHEMA: SCHEMA
  };
})();
