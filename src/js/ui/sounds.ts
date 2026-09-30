/**
 * Message sounds: a short ding for a new IM the user is not looking at.
 *
 * Synthesised through Web Audio (no asset to ship, same in every shell).
 * Which messages deserve a sound at all is one rule, wantsSound(), that the
 * Android bridge shares: it counts those for the shell's message notification,
 * the one alert that still reaches a phone with the screen off, where a
 * WebView sound may not. The ding itself stays quiet while that conversation
 * is on screen in a focused window, and - under the Android shell - while the
 * page is hidden, since the notification takes over there (both at once would
 * alert twice).
 *
 * Settings: imSound (private threads), imSoundGroups (group and conference
 * chats), both read live so a change in the Settings tab applies at once.
 */
const BeeSounds = (function () {
  'use strict';

  // A burst of messages (a group waking up) is one ding, not a carillon.
  const DING_INTERVAL_MS = 1500;

  let ctx = null;
  let armed = false;
  let lastDing = 0;

  function context() {
    if (ctx) return ctx;
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    return ctx;
  }

  // Autoplay policy can hold a context in 'suspended' until a gesture lands
  // somewhere on the page (see voice.ts): ask now, and again on the first
  // pointer or key. Re-armed after each gesture in case the engine suspends
  // the context again later.
  function unlock(c) {
    if (c.state !== 'suspended') return;
    try { c.resume().catch(function () {}); } catch (_e) { /* no promise on this engine */ }
    if (armed) return;
    armed = true;
    const resume = function () {
      document.removeEventListener('pointerdown', resume);
      document.removeEventListener('keydown', resume);
      armed = false;
      if (ctx && ctx.state === 'suspended') {
        try { ctx.resume().catch(function () {}); } catch (_e) { /* as above */ }
      }
    };
    document.addEventListener('pointerdown', resume, { once: true });
    document.addEventListener('keydown', resume, { once: true });
  }

  // One note: a sine at `freq` from `at` for `dur` seconds, with a quick
  // attack and an exponential tail so it rings instead of clicking.
  function note(c, freq, at, dur) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(0.12, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
    osc.onended = function () {
      try { osc.disconnect(); gain.disconnect(); } catch (_e) { /* already gone */ }
    };
  }

  // The ding: B5 then E6, about a quarter of a second in all. Everything is
  // best-effort - no audio device, a blocked context, a missing API - the
  // message still shows.
  function playImDing() {
    try {
      const now = Date.now();
      if (now - lastDing < DING_INTERVAL_MS) return;
      lastDing = now;
      const c = context();
      if (!c) return;
      unlock(c);
      const t0 = c.currentTime;
      note(c, 988, t0, 0.09);
      note(c, 1319, t0 + 0.09, 0.14);
    } catch (_e) { /* silent */ }
  }

  // Whether a message deserves a sound at all, regardless of what is on
  // screen: incoming, live (not a history line), non-empty, in an unmuted
  // conversation whose kind the settings allow. A group or conference chat
  // follows imSoundGroups, a private thread imSound.
  function wantsSound(sessionId, msg) {
    try {
      if (!msg || msg.outgoing || msg.history) return false;
      if (!String(msg.text || '').trim()) return false;
      const session = ((BeeState.get() || {}).imSessions || {})[sessionId];
      if (!session || session.muted) return false;
      const isGroup = session.type === 'group' || session.type === 'conference';
      return !!BeeSettings.get(isGroup ? 'imSoundGroups' : 'imSound');
    } catch (_e) {
      return false;
    }
  }

  // The conversation is in front of the user right now: the IM tab, that
  // thread, the page visible, the window focused.
  function onScreen(sessionId) {
    const s = BeeState.get();
    return s.activeTab === 'im' && s.activeImSession === sessionId &&
      document.visibilityState === 'visible' && document.hasFocus();
  }

  function init() {
    BeeState.on('im', function (data) {
      if (!data || !wantsSound(data.sessionId, data.message)) return;
      if (onScreen(data.sessionId)) return;
      // Hidden page under the Android shell: ConnectionService alerts through
      // its message notification instead (android-bridge.ts counts the alert).
      if (window.MinibeeAndroid && document.visibilityState !== 'visible') return;
      playImDing();
    });
  }

  return { init: init, playImDing: playImDing, wantsSound: wantsSound };
})();

window.BeeSounds = BeeSounds;
