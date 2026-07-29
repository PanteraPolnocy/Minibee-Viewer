/**
 * Our own right-click menu.
 */
const BeeContextMenu = (function () {
  'use strict';

  let menu = null;

  function isTextField(node) {
    if (!node || !node.tagName) return false;
    if (node.disabled || node.readOnly) return false;
    if (node.tagName === 'TEXTAREA') return true;
    if (node.tagName !== 'INPUT') return false;
    const type = String(node.type || 'text').toLowerCase();
    return ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].indexOf(type) !== -1;
  }

  function isEditable(node) {
    return isTextField(node) || !!(node && node.isContentEditable);
  }

  function pageSelection() {
    try {
      return String(window.getSelection ? window.getSelection() : '');
    } catch (_e) {
      return '';
    }
  }

  // What's selected inside a field, which is what Cut and Copy should act on.
  function fieldSelection(node) {
    if (!node || typeof node.selectionStart !== 'number') return '';
    return String(node.value || '').slice(node.selectionStart, node.selectionEnd);
  }

  function linkFor(node) {
    let el = node;
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.url) return el.dataset.url;
      if (el.tagName === 'A' && el.getAttribute('href') &&
          el.getAttribute('href').indexOf('#') !== 0) {
        return el.getAttribute('href');
      }
      el = el.parentElement;
    }
    return '';
  }

  // Context-aware copy entries gathered from the element under the pointer.
  // Two conventions feed this:
  //  - data-copy="<value>" (+ optional data-copy-label="Copy stream URL")
  //    on anything whose "copy" has one obvious meaning;
  //  - the id conventions the lists already use (data-agent-id /
  //    data-avatar-id / data-profile-id / data-group-id / data-object-id),
  //    which yield "Copy name" and "Copy UUID".
  function copyEntriesFor(node) {
    const entries = [];
    const seen = new Set();
    let el = node;
    while (el && el !== document.body) {
      const d = el.dataset || {};
      if (d.copy && !seen.has('copy')) {
        seen.add('copy');
        entries.push({ label: d.copyLabel || 'Copy', value: d.copy });
      }
      const agentId = d.agentId || d.avatarId || d.profileId;
      const anyId = agentId || d.groupId || d.objectId || d.id;
      // data-id is only trusted when it looks like a UUID - lists reuse it
      // for all sorts of keys.
      const idish = anyId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(anyId)
        ? anyId : (agentId || d.groupId || d.objectId || '');
      if (idish && !seen.has('uuid')) {
        seen.add('uuid');
        const nameNode = el.querySelector
          ? el.querySelector('.entity-item__name, .im-roster__name, #profile-title')
          : null;
        const label = (d.label || (nameNode ? nameNode.textContent : '') || '').trim();
        if (label) entries.push({ label: 'Copy name', value: label });
        entries.push({ label: 'Copy UUID', value: idish });
      }
      el = el.parentElement;
    }
    return entries;
  }

  function hide() {
    if (!menu) return;
    menu.hidden = true;
    menu.innerHTML = '';
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { execCopy(); });
      return;
    }
    execCopy();
  }

  function execCopy() {
    try { document.execCommand('copy'); } catch (_e) { /* nothing else to try */ }
  }

  function insertText(node, text) {
    if (node.isContentEditable) {
      try { document.execCommand('insertText', false, text); } catch (_e) { /* ignore */ }
      return;
    }
    const start = typeof node.selectionStart === 'number' ? node.selectionStart : String(node.value || '').length;
    const end = typeof node.selectionEnd === 'number' ? node.selectionEnd : start;
    const value = String(node.value || '');
    node.value = value.slice(0, start) + text + value.slice(end);
    const caret = start + text.length;
    if (node.setSelectionRange) node.setSelectionRange(caret, caret);
    // Let anything listening (search-as-you-type, filters) notice the change.
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function paste(node) {
    if (!node) return;
    node.focus();
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (text) {
        if (text) insertText(node, text);
      }).catch(function () {
        try { document.execCommand('paste'); } catch (_e) { /* often blocked */ }
      });
      return;
    }
    try { document.execCommand('paste'); } catch (_e) { /* often blocked */ }
  }

  function cut(node) {
    const text = fieldSelection(node);
    if (!text) return;
    copyText(text);
    insertText(node, '');
  }

  function addItem(label, enabled, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    if (!enabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', function () {
        hide();
        onClick();
      });
    }
    menu.appendChild(btn);
  }

  function show(x, y) {
    menu.hidden = false;
    // Keep the menu on screen when it's opened near an edge.
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, Math.max(0, window.innerWidth - rect.width - 8));
    const top = Math.min(y, Math.max(0, window.innerHeight - rect.height - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function build(target) {
    menu.innerHTML = '';
    const editable = isEditable(target);
    const inField = isTextField(target);
    const selection = inField ? fieldSelection(target) : pageSelection();
    const link = linkFor(target);

    const contextual = editable ? [] : copyEntriesFor(target);

    if (editable) {
      addItem('Cut', !!selection && inField, function () { cut(target); });
      addItem('Copy', !!selection, function () { copyText(selection); });
      addItem('Paste', true, function () { paste(target); });
      addItem('Select all', true, function () {
        target.focus();
        if (target.select) target.select();
      });
    } else if (contextual.length) {
      // Something under the pointer knows what "copy" should mean here; a bare
      // disabled "Copy" would be noise next to it.
      if (selection) addItem('Copy selection', true, function () { copyText(selection); });
      contextual.forEach(function (entry) {
        addItem(entry.label, true, function () {
          copyText(entry.value);
          if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) BeeUtils.showToast('Copied', 'success');
        });
      });
    } else {
      addItem('Copy', !!selection, function () { copyText(selection); });
    }

    if (link) {
      addItem('Copy link address', true, function () { copyText(link); });
      addItem('Open link in browser', true, function () {
        if (typeof BeeSlurl !== 'undefined' && BeeSlurl.openExternalUrl) BeeSlurl.openExternalUrl(link);
        else window.open(link, '_blank', 'noopener,noreferrer');
      });
    }

    return menu.childElementCount > 0;
  }

  function init() {
    menu = document.getElementById('edit-context-menu');
    if (!menu) return;

    window.addEventListener('contextmenu', function (e) {
      // Something closer to the click already handled it - radar rows, for
      // instance, open their own entity menu - so stay out of the way.
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (!build(e.target)) {
        hide();
        return;
      }
      show(e.clientX, e.clientY);
    });

    // Any click, scroll, Escape, or tab change dismisses the menu.
    document.addEventListener('click', function (e) {
      if (menu.hidden) return;
      if (!menu.contains(e.target)) hide();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hide();
    });
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    document.addEventListener('scroll', hide, true);
  }

  return { init: init, hide: hide };
})();

window.BeeContextMenu = BeeContextMenu;
