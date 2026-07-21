/**
 * Shared utilities for Minibee Viewer.
 */
const FSUtils = (function () {
  'use strict';

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function formatTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatRelative(date) {
    const d = date instanceof Date ? date : new Date(date);
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return 'now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
    return formatTime(d);
  }

  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Escapes for both element text and quoted attributes. The old textContent
  // trick left " and ' intact, so any value dropped into a double-quoted
  // attribute could break out of it.
  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function distance3d(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function xorSessionId(agentId, otherId) {
    const strip = (id) => id.replace(/-/g, '');
    const a = BigInt('0x' + strip(agentId));
    const b = BigInt('0x' + strip(otherId));
    const x = a ^ b;
    const hex = x.toString(16).padStart(32, '0');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32)
    ].join('-');
  }

  function showToast(message, type, duration) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast--' + type : '');
    el.textContent = message;
    container.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, duration || 3200);
  }

  function storageGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_e) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_e) {
      /* quota or private mode */
    }
  }

  const GOVERNOR_LINDEN_ID = '69bf667e-4de9-f25e-7644-99505a7c4aae';

  function normUuid(id) {
    return String(id || '').toLowerCase().replace(/[{}]/g, '').trim();
  }

  function estimateParcelPrimCapacity(area, bonus) {
    const a = Number(area) || 0;
    if (a <= 0) return 0;
    const b = Number(bonus);
    const primBonus = b > 0 ? b : 1;
    // Fallback estimate only (used when the sim didn't send prim counts):
    // Linden default 15000 prims per 65536 m2 region.
    return Math.max(0, Math.round((a * 15000 / 65536) * primBonus));
  }

  function canEditParcel(parcel, agentId) {
    if (!parcel || !agentId) return false;
    const owner = normUuid(parcel.ownerId);
    const agent = normUuid(agentId);
    if (!owner || !agent) return false;
    if (owner === GOVERNOR_LINDEN_ID) return false;
    if (parcel.isGroupOwned) {
      // Group land: editable if the agent belongs to the owning group. The sim
      // still enforces the actual land powers, and our update round-trips the
      // current parcel data, so a rejected attempt changes nothing.
      if (typeof FSProfiles !== 'undefined' && FSProfiles.isAgentInGroup) {
        return FSProfiles.isAgentInGroup(owner);
      }
      return false;
    }
    return owner === agent;
  }

  function formatSltTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(d);
    return time + ' SLT';
  }

  function formatLindenBalance(amount) {
    if (amount === null || amount === undefined || Number.isNaN(amount)) {
      return 'L$ —';
    }
    const n = Math.trunc(amount);
    const sign = n < 0 ? '-' : '';
    return 'L$ ' + sign + Math.abs(n).toLocaleString('en-US');
  }

  function agentNameLines(agent) {
    const displayName = String((agent && agent.displayName) || '').trim();
    const userName = String((agent && (agent.userName || agent.legacyName)) || '').trim();
    const fallback = String((agent && agent.name) || '').trim();
    const title = displayName || userName || fallback || '?';
    let subtitle = '';
    if (displayName && userName && displayName.toLowerCase() !== userName.toLowerCase()) {
      subtitle = userName;
    }
    return { title: title, subtitle: subtitle };
  }

  // Close a modal <dialog> reliably. WebView2 can leave a modal dialog painted
  // until the next input event when closed programmatically; drop focus out of
  // it and force a reflow so it disappears on the first click.
  function dismissDialog(dialog) {
    if (!dialog) return;
    try { if (dialog.open) dialog.close(); } catch (_e) { /* ignore */ }
    if (dialog.open) dialog.open = false;
    if (document.activeElement && dialog.contains(document.activeElement)) {
      try { document.activeElement.blur(); } catch (_e) { /* ignore */ }
    }
    const prevDisplay = dialog.style.display;
    dialog.style.display = 'none';
    void dialog.offsetHeight;
    dialog.style.display = prevDisplay;
  }

  // Styled modal confirmation. Returns a Promise<boolean>. Falls back to the
  // native confirm only if the dialog element is unavailable.
  function confirmDialog(options) {
    const o = options || {};
    return new Promise(function (resolve) {
      const dialog = document.getElementById('confirm-dialog');
      if (!dialog || typeof dialog.showModal !== 'function') {
        resolve(typeof window !== 'undefined' && window.confirm
          ? window.confirm(o.message || 'Are you sure?') : true);
        return;
      }
      const titleEl = document.getElementById('confirm-title');
      const msgEl = document.getElementById('confirm-message');
      const okBtn = document.getElementById('confirm-ok');
      const cancelBtn = document.getElementById('confirm-cancel');
      if (titleEl) titleEl.textContent = o.title || 'Please confirm';
      if (msgEl) msgEl.textContent = o.message || 'Are you sure?';
      if (okBtn) {
        okBtn.textContent = o.confirmLabel || 'Confirm';
        okBtn.classList.toggle('btn--danger', !!o.danger);
      }
      if (cancelBtn) cancelBtn.textContent = o.cancelLabel || 'Cancel';

      let settled = false;
      function done(result) {
        if (settled) return;
        settled = true;
        if (okBtn) okBtn.removeEventListener('click', onOk);
        if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
        dialog.removeEventListener('cancel', onDialogCancel);
        dismissDialog(dialog);
        resolve(result);
      }
      function onOk() { done(true); }
      function onCancel() { done(false); }
      function onDialogCancel(e) { e.preventDefault(); done(false); }
      if (okBtn) okBtn.addEventListener('click', onOk);
      if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
      dialog.addEventListener('cancel', onDialogCancel);
      dialog.showModal();
      if (okBtn) okBtn.focus();
    });
  }

  return {
    uuid: uuid,
    dismissDialog: dismissDialog,
    confirm: confirmDialog,
    formatTime: formatTime,
    formatSltTime: formatSltTime,
    formatLindenBalance: formatLindenBalance,
    formatRelative: formatRelative,
    initials: initials,
    agentNameLines: agentNameLines,
    normUuid: normUuid,
    canEditParcel: canEditParcel,
    estimateParcelPrimCapacity: estimateParcelPrimCapacity,
    escapeHtml: escapeHtml,
    debounce: debounce,
    clamp: clamp,
    distance3d: distance3d,
    xorSessionId: xorSessionId,
    showToast: showToast,
    storageGet: storageGet,
    storageSet: storageSet
  };
})();
