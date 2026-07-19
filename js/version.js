/**
 * Minibee Viewer version (loaded from js/version.json).
 */
const MinibeeVersion = (function () {
  'use strict';

  const VERSION_JSON = 'js/version.json';

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

  function versionJsonUrl() {
    try {
      if (document.location && document.location.href) {
        return new URL(VERSION_JSON, document.location.href).href;
      }
    } catch (_e) { /* ignore */ }
    return VERSION_JSON;
  }

  function load() {
    if (!loadPromise) {
      loadPromise = fetch(versionJsonUrl(), { cache: 'no-cache' }).then(function (resp) {
        if (!resp.ok) throw new Error('version.json request failed');
        return resp.json();
      }).then(function (data) {
        if (!apply(data)) throw new Error('invalid version.json');
        return state;
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
