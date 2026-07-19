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

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
    // Matches Linden parcel capacity: sim_object_limit * area / region_area (256m region).
    return Math.max(0, Math.round((a * 15 / 64) * primBonus));
  }

  function canEditParcel(parcel, agentId) {
    if (!parcel || !agentId) return false;
    const owner = normUuid(parcel.ownerId);
    const agent = normUuid(agentId);
    if (!owner || !agent) return false;
    if (owner === GOVERNOR_LINDEN_ID) return false;
    if (parcel.isGroupOwned && owner !== agent) return false;
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

  return {
    uuid: uuid,
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
