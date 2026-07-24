/**
 * A single profile image element shared across the list surfaces.
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
    // Skip redundant work here: resolving one avatar fires several profile events,
    // and any list re-render comes back through this function too. If we're already
    // showing this exact image, leave the <img> alone instead of tearing it down
    // and re-assigning src - that forces a fresh fetch/decode every time, which is
    // what made refreshes needlessly expensive.
    const current = el.firstElementChild;
    if (el.classList.contains('avatar-thumb--image') && current &&
        current.tagName === 'IMG' && current.getAttribute('src') === url) {
      return;
    }
    el.innerHTML = '';
    el.classList.add('avatar-thumb--image');
    const img = document.createElement('img');
    img.className = 'avatar-thumb__img';
    img.alt = '';
    // Load lazily so off-screen rows in a long list (buddies/radar/search) hold off
    // on fetching their thumbnail until they're scrolled into view.
    img.loading = 'lazy';
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

  // Refresh just the thumbnails belonging to a single id. We match on the
  // normalized id, so a case difference between the DOM attribute and the event id
  // still lines up.
  function refreshFor(id) {
    const key = FSProfiles.normId(id || '');
    if (!key) return;
    document.querySelectorAll('[data-agent-id].avatar-thumb, .entity-item__avatar[data-agent-id]').forEach(function (el) {
      if (FSProfiles.normId(el.dataset.agentId) === key) refreshElement(el);
    });
  }

  function init() {
    FSProfiles.onChange(function (evt) {
      if (!evt) return;
      // Only two kinds can change a thumbnail: an avatar image or a group insignia.
      // ('group' used to be refreshed only as a side effect of refreshAll running on
      // avatar events; now that refresh is targeted, we have to handle it explicitly.)
      if (evt.kind && evt.kind !== 'image' && evt.kind !== 'avatar' &&
          evt.kind !== 'group' && evt.kind !== 'group-name') {
        return;
      }
      // Refresh only the thumbs for the id that changed, NOT every thumb in the
      // document. The old refreshAll(document)-on-every-event approach turned
      // opening the buddy list into an O(N²) re-render + re-request cascade: a single
      // avatar resolving re-scanned all N rows and re-queued a properties fetch for
      // every still-unresolved friend (see queueAvatarThumb's in-flight guard).
      if (evt.id) refreshFor(evt.id);
      else refreshAll(document);
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
