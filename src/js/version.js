/**
 * Holds the version metadata that `bridge_version` reports, which in turn comes from Cargo.toml.
 */
const MinibeeVersion = (function () {
  'use strict';

  const state = {
    channel: '',
    major: null,
    minor: null,
    patch: null,
    build: null,
    loaded: false
  };

  let loadPromise = null;

  function versionString() {
    if (!state.loaded) return '';
    const base = state.major + '.' + state.minor + '.' + state.patch;
    return state.build ? base + '.' + state.build : base;
  }

  function label() {
    if (!state.loaded) return '';
    return state.channel + ' ' + versionString();
  }

  function apply(data) {
    if (!data || typeof data !== 'object') return false;
    if (data.channel) state.channel = String(data.channel);
    if (data.major !== undefined) state.major = Number(data.major);
    if (data.minor !== undefined) state.minor = Number(data.minor);
    if (data.patch !== undefined) state.patch = Number(data.patch);
    if (data.build !== undefined) state.build = Number(data.build);
    state.loaded = Number.isFinite(state.major)
      && Number.isFinite(state.minor)
      && Number.isFinite(state.patch);
    return state.loaded;
  }

  function load() {
    if (state.loaded) return Promise.resolve(state);
    if (!loadPromise) {
      loadPromise = FSBridge.version().then(function (data) {
        if (!apply(data)) throw new Error('invalid version payload');
        return state;
      }).catch(function (err) {
        // Deliberately don't cache the failure here, otherwise a single transient
        // error would block version loading for the whole session (and could even
        // throw during login).
        loadPromise = null;
        throw err;
      });
    }
    return loadPromise;
  }

  return {
    load: load,
    apply: apply,
    isLoaded: function () { return state.loaded; },
    getChannel: function () { return state.channel; },
    getVersionString: versionString,
    getLabel: label
  };
})();
