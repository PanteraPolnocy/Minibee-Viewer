/**
 * Prompts for handling incoming teleport offers and requests.
 */
const BeeTeleportUI = (function () {
  'use strict';

  const t = BeeI18n.t;

  let pending = null;
  let resolvePrompt = null;
  // Offers and requests can arrive back-to-back. With only one dialog and one
  // resolver slot, the second would overwrite the first (leaking its promise)
  // and throw on showModal(), so we queue them and show one at a time.
  const promptQueue = [];

  function dialogEl() {
    return document.getElementById('teleport-prompt') as HTMLDialogElement | null;
  }

  function showPrompt(kind, payload) {
    if (!dialogEl()) return Promise.resolve('decline');
    return new Promise(function (resolve) {
      promptQueue.push({ kind: kind, payload: payload, resolve: resolve });
      if (!pending) showNext();
    });
  }

  function showNext() {
    const dialog = dialogEl();
    const next = promptQueue.shift();
    if (!dialog || !next) return;
    pending = { kind: next.kind, payload: next.payload };
    resolvePrompt = next.resolve;

    const title = document.getElementById('teleport-title');
    const body = document.getElementById('teleport-body');
    const note = document.getElementById('teleport-note');
    const replyWrap = document.getElementById('teleport-reply-wrap');
    const reply = document.getElementById('teleport-reply') as HTMLInputElement | null;
    const acceptBtn = document.getElementById('teleport-accept');

    const payload = next.payload;
    const fromName = payload.fromName || t('teleport.someone');
    if (next.kind === 'offer') {
      title.textContent = t('teleport.offer');
      acceptBtn.textContent = t('teleport.acceptButton');
      replyWrap.hidden = true;
    } else {
      title.textContent = t('teleport.request');
      acceptBtn.textContent = t('teleport.offerTeleport');
      replyWrap.hidden = false;
      reply.value = t('teleport.defaultReply');
    }

    const text = payload.message || '';
    if (next.kind === 'offer' && payload.location) {
      const loc = payload.location;
      // The access rating is the core's word for the region's maturity.
      const access = BeeI18n.field(loc, 'regionAccess');
      note.textContent = t('teleport.offerLocation', {
        gridX: loc.gridX, gridY: loc.gridY,
        x: Math.round(loc.position.x), y: Math.round(loc.position.y)
      }) + (access ? ' (' + access + ')' : '');
      note.hidden = false;
    } else {
      note.hidden = true;
      note.textContent = '';
    }

    body.textContent = text
      ? fromName + ': ' + text
      : t('teleport.wantsYou', { name: fromName });
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) {
        try { dialog.showModal(); } catch (_e) { dialog.setAttribute('open', ''); }
      }
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function closePrompt() {
    const dialog = dialogEl();
    if (!dialog) return;
    BeeUtils.dismissDialog(dialog);
    dialog.removeAttribute('open');
  }

  function finish(action) {
    const current = pending;
    const done = resolvePrompt;
    pending = null;
    resolvePrompt = null;
    closePrompt();
    if (done) done(action);
    // Wait for this dialog to fully close, then bring up the next queued prompt.
    if (promptQueue.length) setTimeout(showNext, 0);
    return current;
  }

  // On session loss or logout, decline whatever is on screen or still queued so
  // the awaiting handlers can unwind instead of leaking their promises.
  function reset() {
    const queued = promptQueue.splice(0);
    const done = resolvePrompt;
    pending = null;
    resolvePrompt = null;
    closePrompt();
    if (done) done('decline');
    queued.forEach(function (item) { if (item.resolve) item.resolve('decline'); });
  }

  async function handleOffer(payload) {
    const action = await showPrompt('offer', payload);
    if (action === 'accept') {
      await BeeTransport.acceptTeleportOffer(payload);
      BeeUtils.showToast(t('teleport.teleporting'), 'success');
    } else {
      await BeeTransport.declineTeleportOffer(payload);
    }
  }

  async function handleRequest(payload) {
    const action = await showPrompt('request', payload);
    if (action === 'accept') {
      const reply = document.getElementById('teleport-reply') as HTMLInputElement | null;
      const message = reply ? reply.value.trim() : '';
      await BeeTransport.acceptTeleportRequest(payload, message);
      BeeUtils.showToast(t('teleport.offerSent'), 'success');
    } else {
      await BeeTransport.declineTeleportRequest(payload);
    }
  }

  function defaultOfferMessage() {
    return t('teleport.defaultOffer');
  }

  async function promptOutgoing(kind, targetName) {
    const fallback = kind === 'offer' ? defaultOfferMessage() : t('teleport.defaultRequest');
    const message = await BeeUtils.prompt({
      title: kind === 'offer' ? t('teleport.offerTeleport') : t('teleport.requestTeleport'),
      message: t('teleport.messageTo', { name: targetName || t('common.resident') }),
      confirmLabel: t('common.send'),
      value: fallback
    });
    if (message === null) return null;
    return String(message).trim();
  }

  function offlineToast(agentName) {
    BeeUtils.showToast(t('teleport.isOffline', { name: agentName || t('teleport.thatResident') }), 'warning');
  }

  async function offerTo(agentId, agentName, hints) {
    if (typeof BeeTransport.isAgentOnline === 'function' &&
        !BeeTransport.isAgentOnline(agentId, hints)) {
      offlineToast(agentName);
      return;
    }
    const message = await promptOutgoing('offer', agentName);
    if (message === null) return;
    await BeeTransport.sendTeleportOffer(agentId, message || defaultOfferMessage());
    BeeUtils.showToast(t('teleport.offerSentTo', { name: agentName || t('common.resident') }), 'success');
  }

  async function requestFrom(agentId, agentName, hints) {
    if (typeof BeeTransport.isAgentOnline === 'function' &&
        !BeeTransport.isAgentOnline(agentId, hints)) {
      offlineToast(agentName);
      return;
    }
    const message = await promptOutgoing('request', agentName);
    if (message === null) return;
    await BeeTransport.sendTeleportRequest(agentId, message);
    BeeUtils.showToast(t('teleport.requestSentTo', { name: agentName || t('common.resident') }), 'success');
  }

  // The stage words are looked up when a label renders, never while the
  // script loads (the dictionary is not in yet).
  function stageRequesting() { return t('teleport.stageRequesting'); }
  function stageTeleporting() { return t('teleport.stageTeleporting'); }

  const PROGRESS_STAGES = [
    { re: /pending/, pct: 12, short: function () { return t('teleport.stagePending'); } },
    { re: /request/, pct: 15, short: stageRequesting },
    { re: /resolv/, pct: 35, short: function () { return t('teleport.stageResolving'); } },
    { re: /redirect/, pct: 45, short: function () { return t('teleport.stageRedirecting'); } },
    { re: /relay/, pct: 50, short: function () { return t('teleport.stageRelaying'); } },
    { re: /send/, pct: 55, short: function () { return t('teleport.stageSending'); } },
    { re: /complet/, pct: 70, short: function () { return t('teleport.stageCompleting'); } },
    { re: /contact/, pct: 80, short: function () { return t('teleport.stageContacting'); } },
    { re: /arriv/, pct: 92, short: function () { return t('teleport.stageArriving'); } }
  ];

  const PROGRESS_PRESETS = {
    requesting: { pct: 15, short: stageRequesting },
    starting: { pct: 25, short: function () { return t('teleport.stageStarting'); } },
    teleporting: { pct: 50, short: stageTeleporting }
  };

  function formatProgressLabel(message, lastPct, fallbackShort) {
    const raw = String(message || '').trim();
    const lower = raw.toLowerCase();
    let pct = 50;
    let short = fallbackShort || stageTeleporting();

    if (PROGRESS_PRESETS[lower]) {
      pct = PROGRESS_PRESETS[lower].pct;
      short = PROGRESS_PRESETS[lower].short();
    } else if (raw) {
      for (let i = 0; i < PROGRESS_STAGES.length; i++) {
        const stage = PROGRESS_STAGES[i];
        if (stage.re.test(lower)) {
          pct = stage.pct;
          short = stage.short();
          break;
        }
      }
    }

    if (typeof lastPct === 'number' && Number.isFinite(lastPct)) {
      pct = Math.max(pct, lastPct);
    }

    return {
      text: t('teleport.stagePercent', { stage: short, pct: pct }),
      pct: pct,
      short: short
    };
  }

  function init() {
    const form = document.getElementById('teleport-prompt-form');
    const decline = document.getElementById('teleport-decline');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      finish('accept');
    });
    decline.addEventListener('click', function () {
      finish('decline');
    });
    dialogEl().addEventListener('cancel', function (e) {
      e.preventDefault();
      finish('decline');
    });

    // Make sure a pending offer isn't left stranded when the session drops.
    if (typeof BeeState !== 'undefined' && BeeState.on) {
      BeeState.on('reset', reset);
      BeeState.on('change', function (partial) {
        if (partial && partial.sessionLost === true) reset();
      });
    }

    BeeTransport.on('teleport-offer', handleOffer);
    BeeTransport.on('teleport-request', handleRequest);
    BeeTransport.on('teleport-declined', function (data) {
      BeeUtils.showToast(t('teleport.declined', { name: data.fromName || t('teleport.resident') }), 'warning');
    });
    BeeTransport.on('teleport-accepted', function (data) {
      BeeUtils.showToast(t('teleport.accepted', { name: data.fromName || t('teleport.resident') }), 'success');
    });
    BeeTransport.on('teleport-failed', function (data) {
      // The core's own reasons come with a key; the sim's words pass through.
      BeeUtils.showToast(BeeI18n.field(data, 'reason') || t('teleport.failed'), 'error', 5000);
    });
    BeeTransport.on('teleport-cancelled', function () {
      BeeUtils.showToast(t('teleport.cancelled'), 'warning');
    });
    BeeTransport.on('teleport-finish', function () {
      BeeUtils.showToast(t('teleport.arrived'), 'success');
    });
  }

  return {
    init: init,
    offerTo: offerTo,
    requestFrom: requestFrom,
    formatProgressLabel: formatProgressLabel,
    reset: reset
  };
})();
