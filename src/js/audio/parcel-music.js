/**
 * Parcel music streaming, built on a plain HTMLAudioElement.
 *
 * Most SL parcel streams are ordinary Shoutcast/Icecast/MP3, so this stays
 * parcel-wide with no positional audio. Autoplay is opt-in, and mixing http
 * with https may get the stream blocked.
 */
const FSParcelMusic = (function () {
  'use strict';

  let audio = null;
  let currentUrl = '';
  let enabled = false;
  let volume = 0.5;
  let playing = false;
  const els = {};

  function setNow(text) {
    const t = text || '';
    if (els.now) els.now.textContent = t;
    if (els.root) els.root.title = t || 'Parcel music';
  }

  function showRoot(show) {
    if (els.root) els.root.hidden = !show;
  }

  function updateToggleUI() {
    // Track the on/off intent (enabled) here, not the transient `playing` state:
    // a stream can be enabled while 'playing' hasn't fired yet (buffering or
    // blocked), which otherwise left the slashed "off" note showing the whole time.
    if (els.toggle) {
      els.toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      els.toggle.title = enabled ? 'Stop parcel music' : 'Play parcel music';
    }
    // An <svg> is an SVGElement, which has no `.hidden` IDL property, so setting
    // it does nothing. Toggle the real attribute instead, since that's what the
    // CSS (svg[hidden]) reacts to.
    if (els.iconOn) els.iconOn.toggleAttribute('hidden', !enabled);
    if (els.iconOff) els.iconOff.toggleAttribute('hidden', enabled);
  }

  function ensureAudio() {
    if (!audio) {
      audio = new Audio();
      audio.preload = 'none';
      audio.volume = volume;
      audio.addEventListener('playing', function () { playing = true; updateToggleUI(); });
      audio.addEventListener('pause', function () { playing = false; updateToggleUI(); });
      audio.addEventListener('error', function () {
        playing = false;
        updateToggleUI();
        if (currentUrl) setNow('Stream unavailable: ' + currentUrl);
      });
    }
    return audio;
  }

  function play() {
    if (!currentUrl) return;
    const a = ensureAudio();
    if (a.src !== currentUrl) a.src = currentUrl;
    a.volume = volume;
    const p = a.play();
    if (p && typeof p.then === 'function') {
      p.then(function () {
        playing = true;
        updateToggleUI();
        setNow('Playing: ' + currentUrl);
      }).catch(function () {
        // Autoplay was blocked, or mixed content was refused.
        playing = false;
        updateToggleUI();
        setNow('Click Play to start: ' + currentUrl);
      });
    } else {
      playing = true;
      updateToggleUI();
      setNow('Playing: ' + currentUrl);
    }
  }

  function stop() {
    if (audio) {
      audio.pause();
      try { audio.removeAttribute('src'); audio.load(); } catch (_e) { /* safe to ignore */ }
    }
    playing = false;
    updateToggleUI();
  }

  // Runs whenever the parcel's music URL changes. The top-bar control only shows
  // when the current parcel actually streams music, so it never suggests the user
  // can edit someone else's land.
  function applyUrl(url) {
    const next = String(url || '').trim();
    if (next === currentUrl) {
      showRoot(!!next);
      return;
    }
    stop();
    currentUrl = next;
    showRoot(!!next);
    updateToggleUI();
    if (!next) {
      setNow('');
      return;
    }
    if (enabled) {
      play();
    } else {
      setNow('Parcel music available: ' + next);
    }
  }

  function setEnabled(on) {
    enabled = !!on;
    if (typeof FSSettings !== 'undefined') FSSettings.set('parcelMusicEnabled', enabled);
    if (enabled) {
      if (currentUrl) play();
    } else {
      stop();
      if (currentUrl) setNow('Parcel music available: ' + currentUrl);
    }
  }

  // Handles the top-bar speaker click: enable and play, or disable and stop.
  // Since the click counts as a user gesture, play() succeeds even where autoplay
  // would normally be blocked.
  function toggle() {
    if (playing) {
      setEnabled(false);
    } else {
      setEnabled(true);
    }
  }

  function setVolume(pct) {
    let v = parseInt(pct, 10);
    if (!Number.isFinite(v)) v = 50;
    v = Math.max(0, Math.min(100, v));
    volume = v / 100;
    if (audio) audio.volume = volume;
    if (els.volume) els.volume.value = String(v);
    if (typeof FSSettings !== 'undefined') FSSettings.set('parcelMusicVolume', v);
  }

  function init() {
    els.root = document.getElementById('parcel-music');
    els.toggle = document.getElementById('parcel-music-toggle');
    els.iconOn = document.getElementById('parcel-music-icon-on');
    els.iconOff = document.getElementById('parcel-music-icon-off');
    els.volume = document.getElementById('parcel-music-volume');
    els.now = document.getElementById('parcel-music-now');

    if (typeof FSSettings !== 'undefined') {
      enabled = !!FSSettings.get('parcelMusicEnabled');
      volume = Math.max(0, Math.min(100, Number(FSSettings.get('parcelMusicVolume')) || 50)) / 100;
    }
    if (els.volume) {
      els.volume.value = String(Math.round(volume * 100));
      els.volume.addEventListener('input', function () { setVolume(els.volume.value); });
    }
    if (els.toggle) {
      els.toggle.addEventListener('click', toggle);
    }
    showRoot(false);
    updateToggleUI();

    // Pick up enable/volume changes made over in the Settings tab. The guard
    // keeps our own writes from looping back through FSSettings.set.
    if (typeof FSSettings !== 'undefined' && FSSettings.onChange) {
      FSSettings.onChange(function (key, value) {
        if (key === 'parcelMusicEnabled') {
          const on = !!value;
          if (on === enabled) return;
          enabled = on;
          updateToggleUI();
          if (enabled) { if (currentUrl) play(); }
          else { stop(); if (currentUrl) setNow('Parcel music available: ' + currentUrl); }
        } else if (key === 'parcelMusicVolume') {
          const v = Math.max(0, Math.min(100, Number(value) || 0));
          if (Math.round(volume * 100) === v) return;
          volume = v / 100;
          if (audio) audio.volume = volume;
          if (els.volume) els.volume.value = String(v);
        }
      });
    }

    // React to parcel changes - music should follow the agent, not the Land tab.
    if (typeof FSState !== 'undefined' && FSState.on) {
      FSState.on('change', function (partial) {
        if (partial && Object.prototype.hasOwnProperty.call(partial, 'parcel')) {
          const parcel = partial.parcel || {};
          applyUrl(parcel.musicUrl || '');
        }
        if (partial && (partial.connected === false || partial.sessionLost === true)) {
          applyUrl('');
        }
      });
      // Logout or disconnect clears the session through reset(), which doesn't
      // emit a 'change', so stop the stream here - music should never outlive
      // the session.
      FSState.on('reset', function () { applyUrl(''); });
      const parcel = (FSState.get() || {}).parcel;
      if (parcel && parcel.musicUrl) applyUrl(parcel.musicUrl);
    }
  }

  return {
    init: init,
    applyUrl: applyUrl,
    setEnabled: setEnabled,
    setVolume: setVolume,
    toggle: toggle,
    stop: stop,
    nowPlaying: function () { return playing ? currentUrl : ''; }
  };
})();
