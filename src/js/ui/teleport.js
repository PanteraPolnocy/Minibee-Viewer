/**
 * Prompts for handling incoming teleport offers and requests.
 */
const FSTeleportUI = (function () {
  'use strict';

  let pending = null;
  let resolvePrompt = null;
  // Offers and requests can arrive back-to-back. With only one dialog and one
  // resolver slot, the second would overwrite the first (leaking its promise)
  // and throw on showModal(), so we queue them and show one at a time.
  const promptQueue = [];

  function dialogEl() {
    return document.getElementById('teleport-prompt');
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
    const reply = document.getElementById('teleport-reply');
    const acceptBtn = document.getElementById('teleport-accept');

    const payload = next.payload;
    const fromName = payload.fromName || 'Someone';
    if (next.kind === 'offer') {
      title.textContent = 'Teleport offer';
      acceptBtn.textContent = 'Teleport';
      replyWrap.hidden = true;
    } else {
      title.textContent = 'Teleport request';
      acceptBtn.textContent = 'Offer teleport';
      replyWrap.hidden = false;
      reply.value = 'Come on over.';
    }

    const text = payload.message || '';
    if (next.kind === 'offer' && payload.location) {
      const loc = payload.location;
      note.textContent = 'Region grid ' + loc.gridX + ',' + loc.gridY +
        ' at ' + Math.round(loc.position.x) + ',' + Math.round(loc.position.y) +
        (loc.regionAccess ? ' (' + loc.regionAccess + ')' : '');
      note.hidden = false;
    } else {
      note.hidden = true;
      note.textContent = '';
    }

    body.textContent = fromName + (text ? ': ' + text : ' wants you to teleport.');
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
    FSUtils.dismissDialog(dialog);
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
      await FSTransport.acceptTeleportOffer(payload);
      FSUtils.showToast('Teleporting...', 'success');
    } else {
      await FSTransport.declineTeleportOffer(payload);
    }
  }

  async function handleRequest(payload) {
    const action = await showPrompt('request', payload);
    if (action === 'accept') {
      const reply = document.getElementById('teleport-reply');
      const message = reply ? reply.value.trim() : '';
      await FSTransport.acceptTeleportRequest(payload, message);
      FSUtils.showToast('Teleport offer sent', 'success');
    } else {
      await FSTransport.declineTeleportRequest(payload);
    }
  }

  function promptOutgoing(kind, targetName) {
    const label = kind === 'offer' ? 'Teleport offer message' : 'Teleport request message';
    const fallback = kind === 'offer' ? 'Join me!' : 'Can I teleport to you?';
    const message = window.prompt(label + ' to ' + (targetName || 'resident') + ':', fallback);
    if (message === null) return null;
    return String(message).trim();
  }

  async function offerTo(agentId, agentName, hints) {
    if (typeof FSTransport.isAgentOnline === 'function' &&
        !FSTransport.isAgentOnline(agentId, hints)) {
      FSUtils.showToast((agentName || 'That resident') + ' is offline.', 'warning');
      return;
    }
    const message = promptOutgoing('offer', agentName);
    if (message === null) return;
    await FSTransport.sendTeleportOffer(agentId, message || 'Join me!');
    FSUtils.showToast('Teleport offer sent to ' + (agentName || 'resident'), 'success');
  }

  async function requestFrom(agentId, agentName, hints) {
    if (typeof FSTransport.isAgentOnline === 'function' &&
        !FSTransport.isAgentOnline(agentId, hints)) {
      FSUtils.showToast((agentName || 'That resident') + ' is offline.', 'warning');
      return;
    }
    const message = promptOutgoing('request', agentName);
    if (message === null) return;
    await FSTransport.sendTeleportRequest(agentId, message);
    FSUtils.showToast('Teleport request sent to ' + (agentName || 'resident'), 'success');
  }

  const PROGRESS_STAGES = [
    { re: /pending/, pct: 12, short: 'Pending' },
    { re: /request/, pct: 15, short: 'Requesting' },
    { re: /resolv/, pct: 35, short: 'Resolving' },
    { re: /redirect/, pct: 45, short: 'Redirecting' },
    { re: /relay/, pct: 50, short: 'Relaying' },
    { re: /send/, pct: 55, short: 'Sending' },
    { re: /complet/, pct: 70, short: 'Completing' },
    { re: /contact/, pct: 80, short: 'Contacting' },
    { re: /arriv/, pct: 92, short: 'Arriving' }
  ];

  const PROGRESS_PRESETS = {
    requesting: { pct: 15, short: 'Requesting' },
    starting: { pct: 25, short: 'Starting' },
    teleporting: { pct: 50, short: 'Teleporting' }
  };

  function formatProgressLabel(message, lastPct, fallbackShort) {
    const raw = String(message || '').trim();
    const lower = raw.toLowerCase();
    let pct = 50;
    let short = fallbackShort || 'Teleporting';

    if (PROGRESS_PRESETS[lower]) {
      pct = PROGRESS_PRESETS[lower].pct;
      short = PROGRESS_PRESETS[lower].short;
    } else if (raw) {
      for (let i = 0; i < PROGRESS_STAGES.length; i++) {
        const stage = PROGRESS_STAGES[i];
        if (stage.re.test(lower)) {
          pct = stage.pct;
          short = stage.short;
          break;
        }
      }
    }

    if (typeof lastPct === 'number' && Number.isFinite(lastPct)) {
      pct = Math.max(pct, lastPct);
    }

    return {
      text: short + ' ' + pct + '%',
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
    if (typeof FSState !== 'undefined' && FSState.on) {
      FSState.on('reset', reset);
      FSState.on('change', function (partial) {
        if (partial && partial.sessionLost === true) reset();
      });
    }

    FSTransport.on('teleport-offer', handleOffer);
    FSTransport.on('teleport-request', handleRequest);
    FSTransport.on('teleport-declined', function (data) {
      FSUtils.showToast((data.fromName || 'Resident') + ' declined your teleport', 'warning');
    });
    FSTransport.on('teleport-accepted', function (data) {
      FSUtils.showToast((data.fromName || 'Resident') + ' accepted your teleport offer', 'success');
    });
    FSTransport.on('teleport-failed', function (data) {
      FSUtils.showToast(data.reason || 'Teleport failed', 'error', 5000);
    });
    FSTransport.on('teleport-cancelled', function () {
      FSUtils.showToast('Teleport cancelled', 'warning');
    });
    FSTransport.on('teleport-finish', function () {
      FSUtils.showToast('Arrived in region', 'success');
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
