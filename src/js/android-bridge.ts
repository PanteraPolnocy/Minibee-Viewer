/**
 * Feeds the Android keep-alive notification. The Android shell injects a
 * MinibeeAndroid object into this WebView (see MainActivity); the viewer
 * pushes a small state summary into it whenever something the notification
 * shows changes - parcel music, voice, unread IMs - and the notification's
 * buttons come back in through action() (evaluateJavascript from the
 * connection service). Everywhere else MinibeeAndroid does not exist and this
 * module stays inert.
 *
 * It also answers the Android Back button: MainActivity evaluates
 * window.MinibeeAndroidBack() before deciding what to do with the activity
 * (see back()).
 */
const BeeAndroidBridge = (function () {
  'use strict';

  let timer = null;
  let lastSent = '';
  const voice = { connected: false, muted: true };
  let lastMessage = '';

  function native() {
    const n = window.MinibeeAndroid;
    return n && typeof n.updateState === 'function' ? n : null;
  }

  function snapshot() {
    const music = (typeof BeeParcelMusic !== 'undefined' && BeeParcelMusic.state)
      ? BeeParcelMusic.state()
      : { url: '', playing: false };
    const unread = Number((BeeState.get() || {}).unreadIm) || 0;
    return {
      musicAvailable: !!music.url,
      musicPlaying: !!music.playing,
      voiceConnected: voice.connected,
      voiceMuted: voice.muted,
      unreadIms: unread,
      // A read conversation is not news; the preview only rides along while
      // something is actually waiting.
      lastMessage: unread > 0 ? lastMessage : ''
    };
  }

  function push() {
    const n = native();
    if (!n) return;
    const json = JSON.stringify(snapshot());
    if (json === lastSent) return;
    lastSent = json;
    try { n.updateState(json); } catch (_e) { /* notification is best-effort */ }
  }

  // State changes arrive in bursts (an IM bumps unread and lastMessage in one
  // beat); one delayed push folds them together.
  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; push(); }, 250);
  }

  // A notification button was tapped; the service calls in through here.
  function action(what) {
    if (what === 'music' && typeof BeeParcelMusic !== 'undefined') {
      BeeParcelMusic.toggle();
    } else if (what === 'voice' && typeof BeeVoice !== 'undefined') {
      BeeVoice.toggleMute();
    }
    schedule();
  }

  function isShown(el) {
    return !!el && el.getClientRects().length > 0;
  }

  // The Back button. Closes the innermost open thing and reports 'handled';
  // with nothing to close, 'background' while a session is live (the shell
  // then moves the task behind, the foreground service keeps the connection)
  // and 'exit' otherwise (the shell finishes the activity). Only reaches what
  // the UI itself exposes: dialogs go through BeeUtils.dismissDialog, the
  // narrow-screen IM thread and the script/notecard editors through their own
  // visible back buttons, so the modules keep their state in step.
  function back() {
    try {
      const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
      if (dialogs.length) {
        // The most recently opened modal is normally the last one; either
        // way the next press closes the other. Back behaves like Escape: the
        // dialog's own `cancel` handler runs first, so a pending confirm or
        // prompt resolves as cancelled instead of being left hanging (which
        // would block every later confirm behind it); a dialog without such a
        // handler is simply dismissed.
        const top = dialogs[dialogs.length - 1];
        top.dispatchEvent(new Event('cancel', { cancelable: true }));
        if (top.open) BeeUtils.dismissDialog(top);
        return 'handled';
      }
      const editorBacks = ['script-back', 'notecard-back'];
      for (let i = 0; i < editorBacks.length; i++) {
        const btn = document.getElementById(editorBacks[i]);
        if (isShown(btn)) {
          btn.click();
          return 'handled';
        }
      }
      if (BeeState.get().activeImSession) {
        const imBack = document.getElementById('im-back');
        if (isShown(imBack)) {
          imBack.click();
          return 'handled';
        }
      }
    } catch (_e) { /* fall through to the session verdict */ }
    return BeeState.get().connected ? 'background' : 'exit';
  }

  function trackIm(payload) {
    const msg = payload && payload.message;
    if (!msg || msg.outgoing || !msg.text) return;
    const session = (BeeState.get().imSessions || {})[payload.sessionId];
    if (!session || session.muted) return;
    const who = String(msg.fromName || 'Someone');
    lastMessage = (who + ': ' + String(msg.text)).slice(0, 120);
    schedule();
  }

  function init() {
    // The interface is injected during WebView creation, before the page
    // loads; the short retry only covers the object arriving a beat late.
    let attempts = 0;
    (function detect() {
      if (native()) {
        start();
      } else if (attempts++ < 10) {
        setTimeout(detect, 500);
      }
    })();
  }

  function start() {
    BeeState.on('change', function (partial) {
      if (!partial) return;
      if ('unreadIm' in partial || partial.connected !== undefined ||
          partial.sessionLost !== undefined) {
        schedule();
      }
    });
    BeeState.on('im', trackIm);
    BeeState.on('reset', function () {
      lastMessage = '';
      voice.connected = false;
      voice.muted = true;
      schedule();
    });
    if (typeof BeeParcelMusic !== 'undefined' && BeeParcelMusic.onChange) {
      BeeParcelMusic.onChange(schedule);
    }
    BeeTransport.on('voice-state', function (data) {
      const inCall = typeof BeeVoice !== 'undefined' && typeof BeeVoice.inCall === 'function'
        ? !!BeeVoice.inCall()
        : false;
      voice.connected = !!(data && data.state === 'on') || inCall;
      voice.muted = !(data && data.muted === false);
      schedule();
    });
    push();
  }

  return { init: init, action: action, back: back };
})();

window.BeeAndroidBridge = BeeAndroidBridge;
// Read by MainActivity's back handler (evaluateJavascript); the cast keeps
// this shell-only hook out of the shared Window declarations.
(window as any).MinibeeAndroidBack = BeeAndroidBridge.back;
