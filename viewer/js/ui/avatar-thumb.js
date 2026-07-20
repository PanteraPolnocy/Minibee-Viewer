/**
 * Shared profile image element for list surfaces.
 */
const FSAvatarThumb = (function () {
  'use strict';

  const GROUP_GLYPH = 'G';

  function fallbackLabel(agentId, options) {
    const opts = options || {};
    if (opts.label) return FSUtils.initials(opts.label);
    if (opts.kind === 'group') return GROUP_GLYPH;
    if (opts.kind === 'place') return 'P';
    return '?';
  }

  function applyClasses(el, options) {
    const opts = options || {};
    el.classList.add('avatar-thumb');
    if (opts.size) el.classList.add('avatar-thumb--' + opts.size);
    if (opts.online) el.classList.add('avatar-thumb--online');
    if (opts.kind === 'group') el.classList.add('avatar-thumb--group');
    if (opts.kind === 'session') el.classList.add('avatar-thumb--session');
  }

  function setInitials(el, text) {
    el.innerHTML = '';
    el.classList.remove('avatar-thumb--image');
    const span = document.createElement('span');
    span.className = 'avatar-thumb__initials';
    span.textContent = text || '?';
    el.appendChild(span);
  }

  function setImage(el, url, agentId, options) {
    el.innerHTML = '';
    el.classList.add('avatar-thumb--image');
    const img = document.createElement('img');
    img.className = 'avatar-thumb__img';
    img.alt = '';
    img.loading = 'eager';
    img.decoding = 'async';
    img.src = url;
    img.addEventListener('error', function () {
      setInitials(el, fallbackLabel(agentId, options));
    });
    el.appendChild(img);
  }

  function shouldResolveImage(el) {
    return el.dataset.resolveImage === '1';
  }

  function refreshElement(el) {
    if (!el || !el.dataset) return;
    const agentId = el.dataset.agentId || '';
    const kind = el.dataset.kind || 'avatar';
    const label = el.dataset.label || '';
    const online = el.dataset.online === '1';
    const resolve = shouldResolveImage(el);
    if (kind === 'group') {
      const insigniaId = el.dataset.imageId || FSProfiles.getGroupInsigniaId(agentId);
      const url = insigniaId && !FSProfiles.isZero(insigniaId)
        ? FSProfiles.textureImageUrl(insigniaId, 64)
        : '';
      if (url) setImage(el, url, agentId, { kind: 'group', label: label });
      else setInitials(el, GROUP_GLYPH);
      return;
    }
    const imageId = FSProfiles.getImageId(agentId);
    const url = imageId ? FSProfiles.textureImageUrl(imageId, 64) : '';
    if (url) {
      setImage(el, url, agentId, { label: label, online: online });
    } else {
      setInitials(el, fallbackLabel(agentId, { label: label }));
      if (agentId && resolve) FSProfiles.queueAvatarThumb(agentId);
    }
  }

  function create(agentId, options) {
    const opts = options || {};
    const el = document.createElement('div');
    el.dataset.agentId = agentId || '';
    el.dataset.kind = opts.kind || 'avatar';
    if (opts.label) el.dataset.label = opts.label;
    if (opts.online) el.dataset.online = '1';
    if (opts.imageId && !FSProfiles.isZero(opts.imageId)) el.dataset.imageId = FSProfiles.normId(opts.imageId);
    else delete el.dataset.imageId;
    if (opts.resolveImage) el.dataset.resolveImage = '1';
    else delete el.dataset.resolveImage;
    applyClasses(el, opts);
    if (opts.className) {
      opts.className.split(/\s+/).forEach(function (name) {
        if (name) el.classList.add(name);
      });
    }
    refreshElement(el);
    return el;
  }

  function apply(target, agentId, options) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return null;
    const opts = options || {};
    el.dataset.agentId = agentId || '';
    el.dataset.kind = opts.kind || 'avatar';
    if (opts.label) el.dataset.label = opts.label;
    else delete el.dataset.label;
    if (opts.online) el.dataset.online = '1';
    else delete el.dataset.online;
    if (opts.imageId && !FSProfiles.isZero(opts.imageId)) el.dataset.imageId = FSProfiles.normId(opts.imageId);
    else delete el.dataset.imageId;
    if (opts.resolveImage) el.dataset.resolveImage = '1';
    else delete el.dataset.resolveImage;
    el.className = el.className.replace(/\bavatar-thumb[^\s]*/g, '').trim();
    applyClasses(el, opts);
    if (opts.className) {
      opts.className.split(/\s+/).forEach(function (name) {
        if (name) el.classList.add(name);
      });
    }
    refreshElement(el);
    return el;
  }

  function mountIn(container, agentId, options) {
    if (!container) return null;
    const node = create(agentId, options);
    container.innerHTML = '';
    container.appendChild(node);
    return node;
  }

  function refreshAll(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-agent-id].avatar-thumb, .entity-item__avatar[data-agent-id]').forEach(function (el) {
      refreshElement(el);
    });
  }

  function init() {
    FSProfiles.onChange(function (evt) {
      if (evt && evt.kind && evt.kind !== 'image' && evt.kind !== 'avatar' &&
          evt.kind !== 'group-name') {
        return;
      }
      refreshAll(document);
    });
  }

  return {
    init: init,
    create: create,
    apply: apply,
    mountIn: mountIn,
    refresh: refreshElement,
    refreshAll: refreshAll
  };
})();
