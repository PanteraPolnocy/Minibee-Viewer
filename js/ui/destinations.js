/**
 * Destination Guide panel - Linden Lab curated destinations feed.
 */
const FSDestinations = (function () {
  'use strict';

  const FEEDS = [
    { id: 'mobile', label: 'Mobile' },
    { id: 'popular', label: 'Popular' },
    { id: 'new', label: 'New' },
    { id: 'editor', label: 'Editor' },
    { id: 'events', label: 'Events' }
  ];

  const FEED_MARKERS = {
    mobile: true,
    popular: true,
    new: true,
    editor: true,
    events: true
  };

  let activeFeed = (typeof FSSettings !== 'undefined' ? FSSettings.get('destFeed') : null) || 'mobile';
  const cache = new Map();
  let loadToken = 0;
  let bound = false;
  let destTeleportBusy = false;
  let destTeleportPct = 0;
  let teleportEventsBound = false;

  function el(id) {
    return document.getElementById(id);
  }

  function bridgeUrl() {
    if (typeof FSTransport !== 'undefined' && FSTransport.getBridgeUrl) {
      return String(FSTransport.getBridgeUrl() || '').replace(/\/$/, '');
    }
    return 'http://127.0.0.1:8765';
  }

  function isFeedMarker(name) {
    const key = String(name || '').toLowerCase();
    if (!key) return true;
    if (FEED_MARKERS[key]) return true;
    return key.indexOf('portal_') === 0;
  }

  function formatCategoryName(cat) {
    if (!cat) return 'Other';
    const raw = String(cat.parent_name || cat.simple_name || 'other');
    return raw.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function primaryCategory(item) {
    const cats = (item && item.categories) || [];
    let best = null;
    let bestOrder = -1;
    cats.forEach(function (cat) {
      if (!cat || isFeedMarker(cat.simple_name)) return;
      const order = Number(cat.order);
      const ord = Number.isFinite(order) ? order : 0;
      if (!best || ord > bestOrder) {
        best = cat;
        bestOrder = ord;
      }
    });
    return best;
  }

  function assetFullsize(item) {
    const assets = (item && item.assets) || [];
    for (let i = 0; i < assets.length; i++) {
      if (assets[i] && assets[i].type === 'fullsize' && assets[i].data) {
        return String(assets[i].data);
      }
    }
    if (assets[0] && assets[0].data) {
      return String(assets[0].data);
    }
    return '';
  }

  function maturityLabel(code) {
    const c = String(code || '').toUpperCase();
    if (c === 'G') return 'General';
    if (c === 'M') return 'Moderate';
    if (c === 'A') return 'Adult';
    return c || 'Unknown';
  }

  function maturityClass(code) {
    const c = String(code || '').toUpperCase();
    if (c === 'G') return 'dest-maturity--g';
    if (c === 'M') return 'dest-maturity--m';
    if (c === 'A') return 'dest-maturity--a';
    return 'dest-maturity--unknown';
  }

  function groupByCategory(items) {
    const groups = new Map();
    (items || []).forEach(function (item) {
      const cat = primaryCategory(item);
      const key = cat ? String(cat.simple_name || cat.id) : 'other';
      if (!groups.has(key)) {
        groups.set(key, { category: cat, items: [] });
      }
      groups.get(key).items.push(item);
    });
    const out = Array.from(groups.values());
    out.sort(function (a, b) {
      const ao = a.category && Number.isFinite(Number(a.category.order)) ? Number(a.category.order) : 0;
      const bo = b.category && Number.isFinite(Number(b.category.order)) ? Number(b.category.order) : 0;
      if (bo !== ao) return bo - ao;
      return formatCategoryName(a.category).localeCompare(formatCategoryName(b.category));
    });
    return out;
  }

  function setStatus(html) {
    const node = el('dest-status');
    if (node) node.innerHTML = html || '';
  }

  function setContent(html) {
    const node = el('dest-content');
    if (node) node.innerHTML = html || '';
  }

  function renderFeedBar() {
    const bar = el('dest-feedbar');
    if (!bar) return;
    bar.innerHTML = FEEDS.map(function (feed) {
      const active = feed.id === activeFeed;
      return '<button type="button" class="dest-feedbar__item' +
        (active ? ' dest-feedbar__item--active' : '') +
        '" role="tab" aria-selected="' + (active ? 'true' : 'false') +
        '" data-feed="' + FSUtils.escapeHtml(feed.id) + '">' +
        FSUtils.escapeHtml(feed.label) + '</button>';
    }).join('');
  }

  function renderCard(item) {
    const name = String(item.name || 'Destination').trim();
    const desc = String(item.description || '').trim();
    const slurl = String(item.slurl || '').trim();
    const image = assetFullsize(item);
    const mat = String(item.maturity || '').toUpperCase();
    const pop = item.population && Number.isFinite(Number(item.population.current))
      ? Number(item.population.current)
      : null;

    return '<article class="dest-card">' +
      (image
        ? '<div class="dest-card__media"><img src="' + FSUtils.escapeHtml(image) +
          '" alt="" loading="lazy" decoding="async"></div>'
        : '') +
      '<div class="dest-card__body">' +
        '<div class="dest-card__head">' +
          '<h4 class="dest-card__title">' +
            (slurl
              ? '<button type="button" class="dest-card__link dest-action" data-action="map" data-slurl="' +
                FSUtils.escapeHtml(slurl) + '">' + FSUtils.escapeHtml(name) + '</button>'
              : FSUtils.escapeHtml(name)) +
          '</h4>' +
          '<span class="dest-maturity ' + maturityClass(mat) + '" title="Maturity rating">' +
            FSUtils.escapeHtml(maturityLabel(mat)) +
          '</span>' +
        '</div>' +
        (desc
          ? '<p class="dest-card__desc">' + FSUtils.escapeHtml(desc) + '</p>'
          : '') +
        (slurl
          ? '<p class="dest-card__slurl">' +
            '<button type="button" class="dest-slurl-link dest-action" data-action="map" data-slurl="' +
            FSUtils.escapeHtml(slurl) + '">' + FSUtils.escapeHtml(slurl) + '</button></p>'
          : '') +
        '<div class="dest-card__meta">' +
          (pop !== null && pop > 0
            ? '<span class="badge">' + FSUtils.escapeHtml(String(pop)) + ' here</span>'
            : '') +
        '</div>' +
        '<div class="dest-card__actions">' +
          (slurl
            ? '<button type="button" class="btn btn--ghost btn--sm dest-action" data-action="map" data-slurl="' +
              FSUtils.escapeHtml(slurl) + '">Open in Map</button>' +
              '<button type="button" class="btn btn--primary btn--sm dest-action" data-action="tp" data-slurl="' +
              FSUtils.escapeHtml(slurl) + '">Teleport</button>'
            : '') +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function renderGroups(groups) {
    if (!groups.length) {
      setContent('<p class="dest-empty">No destinations in this feed.</p>');
      return;
    }
    const html = groups.map(function (group) {
      const title = formatCategoryName(group.category);
      const cards = group.items.map(renderCard).join('');
      return '<section class="dest-section">' +
        '<h3 class="dest-section__title">' + FSUtils.escapeHtml(title) +
        ' <span class="dest-section__count">' + group.items.length + '</span></h3>' +
        '<div class="dest-section__list">' + cards + '</div>' +
      '</section>';
    }).join('');
    setContent(html);
    if (destTeleportBusy) {
      setDestTeleportBusy(true, 'Teleporting...');
    }
  }

  async function loadFeed(feedId, force) {
    const feed = feedId || activeFeed;
    activeFeed = feed;
    if (typeof FSSettings !== 'undefined') {
      FSSettings.set('destFeed', feed);
    }
    renderFeedBar();

    if (!force && cache.has(feed)) {
      renderGroups(groupByCategory(cache.get(feed)));
      setStatus('');
      return;
    }

    const token = ++loadToken;
    setStatus('<p class="dest-loading">Loading destinations...</p>');
    setContent('');

    try {
      const resp = await FSBridge.httpFetch(
        bridgeUrl(),
        '/destinations?feed=' + encodeURIComponent(feed)
      );
      const data = await resp.json().catch(function () { return null; });
      if (token !== loadToken) return;
      if (!resp.ok || !data || !data.ok || !Array.isArray(data.items)) {
        const detail = data && (data.detail || data.error) ? String(data.detail || data.error) : resp.statusText;
        throw new Error(detail || 'Failed to load destinations');
      }
      cache.set(feed, data.items);
      setStatus('');
      renderGroups(groupByCategory(data.items));
    } catch (err) {
      if (token !== loadToken) return;
      setStatus('');
      setContent(
        '<p class="dest-error">' + FSUtils.escapeHtml(err.message || 'Could not load destinations') +
        '</p><button type="button" class="btn btn--ghost btn--sm" id="dest-retry">Retry</button>'
      );
      const retry = el('dest-retry');
      if (retry) {
        retry.addEventListener('click', function () {
          loadFeed(feed, true);
        });
      }
    }
  }

  function applyDestTeleportProgress(message, fallbackShort) {
    let out = {
      text: (fallbackShort || 'Teleporting') + ' 50%',
      pct: destTeleportPct || 50,
      short: fallbackShort || 'Teleporting'
    };
    if (typeof FSTeleportUI !== 'undefined' && FSTeleportUI.formatProgressLabel) {
      out = FSTeleportUI.formatProgressLabel(message, destTeleportPct, fallbackShort);
    }
    destTeleportPct = out.pct;
    setDestTeleportBusy(true, out.text);
  }

  function setDestTeleportBusy(busy, label) {
    destTeleportBusy = !!busy;
    if (!busy) destTeleportPct = 0;
    const content = el('dest-content');
    if (!content) return;
    const text = label || 'Teleporting...';
    content.querySelectorAll('.dest-action[data-action="tp"]').forEach(function (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? text : 'Teleport';
      btn.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
  }

  function bindTeleportEvents() {
    if (teleportEventsBound) return;
    teleportEventsBound = true;

    FSTransport.on('teleport-progress', function (data) {
      if (!destTeleportBusy) return;
      applyDestTeleportProgress(data && data.message, 'Teleporting');
      if (typeof FSMap !== 'undefined' && FSMap.beginMapTeleport) {
        FSMap.beginMapTeleport(data && data.message);
      }
    });

    FSTransport.on('teleport-started', function () {
      if (!destTeleportBusy) return;
      applyDestTeleportProgress('starting', 'Starting');
    });

    FSTransport.on('teleport-finish', function () {
      setDestTeleportBusy(false);
    });

    FSTransport.on('teleport-failed', function () {
      setDestTeleportBusy(false);
    });

    FSTransport.on('teleport-cancelled', function () {
      setDestTeleportBusy(false);
    });

    FSState.on('reset', function () {
      setDestTeleportBusy(false);
    });
  }

  function handleAction(e) {
    const btn = e.target.closest('.dest-action');
    if (!btn) return;
    const slurl = btn.dataset.slurl || '';
    if (!slurl) return;
    const action = btn.dataset.action || 'map';

    if (action === 'map') {
      if (typeof FSMap !== 'undefined' && FSMap.showLocation) {
        FSMap.showLocation(slurl);
      }
      return;
    }

    if (action === 'tp') {
      if (!FSState.gridOnline()) {
        FSUtils.showToast('Not connected to the grid', 'warning');
        return;
      }
      if (destTeleportBusy) return;

      applyDestTeleportProgress('requesting', 'Requesting');
      if (typeof FSMap !== 'undefined') {
        if (FSMap.showLocation) FSMap.showLocation(slurl);
        if (FSMap.beginMapTeleport) FSMap.beginMapTeleport('requesting');
      }

      FSTransport.teleportTo(slurl).then(function () {
        applyDestTeleportProgress('starting', 'Starting');
        if (typeof FSMap !== 'undefined' && FSMap.beginMapTeleport) {
          FSMap.beginMapTeleport('starting');
        }
      }).catch(function (err) {
        setDestTeleportBusy(false);
        if (typeof FSMap !== 'undefined' && FSMap.resetTeleportButton) {
          FSMap.resetTeleportButton();
        }
        FSUtils.showToast(err.message || 'Teleport failed', 'error');
      });
    }
  }

  function bindEvents() {
    if (bound) return;
    bound = true;

    const feedbar = el('dest-feedbar');
    if (feedbar) {
      feedbar.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-feed]');
        if (!btn) return;
        const feed = btn.dataset.feed;
        if (!feed || feed === activeFeed) return;
        loadFeed(feed, false);
      });
    }

    const content = el('dest-content');
    if (content) {
      content.addEventListener('click', handleAction);
    }
  }

  function init() {
    bindEvents();
    bindTeleportEvents();
    renderFeedBar();
  }

  return { init: init, loadFeed: loadFeed };
})();
