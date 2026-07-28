/**
 * Displays viewer version on the login screen from Rust (`bridge_version` / `displayVersion`).
 * The native OS window title is set in Rust (`lib.rs`); this module does not touch it.
 */
const MinibeeVersion = (function () {
  'use strict';

  let displayVersion = '';
  let loaded = false;
  let loadPromise = null;

  const VERSION_ELEMENT_IDS = ['login-version'];

  function refreshDom() {
    if (!displayVersion) return;
    VERSION_ELEMENT_IDS.forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.textContent = displayVersion;
    });
  }

  function apply(data) {
    if (!data || typeof data !== 'object') return false;
    const label = data.displayVersion ? String(data.displayVersion) : '';
    if (!label) return false;
    displayVersion = label;
    loaded = true;
    refreshDom();
    return true;
  }

  function load() {
    if (loaded) return Promise.resolve({ displayVersion: displayVersion });
    if (!loadPromise) {
      loadPromise = BeeBridge.version().then(function (data) {
        if (!apply(data)) throw new Error('invalid version payload');
        return { displayVersion: displayVersion };
      }).catch(function (err) {
        loadPromise = null;
        throw err;
      });
    }
    return loadPromise;
  }

  return {
    load: load,
    apply: apply,
    refreshDom: refreshDom,
    isLoaded: function () { return loaded; },
    getDisplayString: function () { return displayVersion; },
    getLabel: function () { return displayVersion; }
  };
})();
