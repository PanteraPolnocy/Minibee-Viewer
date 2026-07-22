/**
 * Parcel music streaming via HTMLAudioElement.
 *
 * Most SL parcel streams are plain Shoutcast/Icecast/MP3. Parcel-wide only (no
 * positional audio). Autoplay is opt-in; mixed http/https may be blocked.
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
    if (els.toggle) {
      els.toggle.setAttribute('aria-pressed', playing ? 'true' : 'false');
      els.toggle.title = playing ? 'Pause parcel music' : 'Play parcel music';
    }
    if (els.iconOn) els.iconOn.hidden = !playing;
    if (els.iconOff) els.iconOff.hidden = playing;
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
        // Autoplay blocked or mixed content refused.
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
      try { audio.removeAttribute('src'); audio.load(); } catch (_e) { /* ignore */ }
    }
    playing = false;
    updateToggleUI();
  }

  // Called when the parcel's music URL changes. The top-bar control is only
  // visible when the current parcel actually streams music, so it never implies
  // the user can edit someone else's land.
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

  // Top-bar speaker click: enable + play, or disable + stop. Because the click
  // is a user gesture, play() succeeds even when autoplay would be blocked.
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

    // React to parcel changes (music must follow the agent, not the Land tab).
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
      // Logout / disconnect clears the session via reset() (which does not emit
      // a 'change'); stop the stream so music never outlives the session.
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
