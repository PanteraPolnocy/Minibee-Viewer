/**
 * Destination Guide panel - shows Linden Lab's curated destinations feed.
 */
const BeeDestinations = (function () {
  'use strict';

  const t = BeeI18n.t;

  // The feed bar. The labels are ours (the feed's own category names come
  // with the items), so they translate when the bar renders.
  const FEEDS = [
    { id: 'mobile', label: function () { return t('dest.feedMobile'); } },
    { id: 'popular', label: function () { return t('dest.feedPopular'); } },
    { id: 'new', label: function () { return t('dest.feedNew'); } },
    { id: 'editor', label: function () { return t('dest.feedEditor'); } },
    { id: 'events', label: function () { return t('nav.events'); } }
  ];

  const FEED_MARKERS = {
    mobile: true,
    popular: true,
    new: true,
    editor: true,
    events: true
  };

  // Filled in init(): settings aren't loaded yet at script parse time.
  let activeFeed = 'mobile';
  const cache = new Map();
  // Per feed, the core's line about ratings it left out (Settings ->
  // Search), with its key; shown above the cards, kept with the cached items.
  const notes = new Map();
  let loadToken = 0;
  let bound = false;
  let destTeleportBusy = false;
  let destTeleportPct = 0;
  let teleportEventsBound = false;

  function el(id) {
    return document.getElementById(id);
  }

  function isFeedMarker(name) {
    const key = String(name || '').toLowerCase();
    if (!key) return true;
    if (FEED_MARKERS[key]) return true;
    return key.indexOf('portal_') === 0;
  }

  // The feed's category name, as it gives it; only the fallback for an item
  // with none is ours.
  function formatCategoryName(cat) {
    const raw = cat ? String(cat.parent_name || cat.simple_name || '') : '';
    if (!raw) return t('land.categoryOther');
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
    if (c === 'G') return t('land.ratingGeneral');
    if (c === 'M') return t('land.ratingModerate');
    if (c === 'A') return t('land.ratingAdult');
    return c || t('common.unknown');
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

  // The note's fields out of a feed reply, for BeeI18n.field; null when
  // the reply carries none.
  function noteOf(data) {
    return data && typeof data.note === 'string'
      ? { note: data.note, noteKey: data.noteKey, noteArgs: data.noteArgs }
      : null;
  }

  function noteHtml(note) {
    const text = BeeI18n.field(note, 'note');
    return text ? '<p class="dest-note">' + BeeUtils.escapeHtml(text) + '</p>' : '';
  }

  function renderFeedBar() {
    const bar = el('dest-feedbar');
    if (!bar) return;
    bar.innerHTML = FEEDS.map(function (feed) {
      const active = feed.id === activeFeed;
      return '<button type="button" class="dest-feedbar__item' +
        (active ? ' dest-feedbar__item--active' : '') +
        '" role="tab" aria-selected="' + (active ? 'true' : 'false') +
        '" data-feed="' + BeeUtils.escapeHtml(feed.id) + '">' +
        BeeUtils.escapeHtml(feed.label()) + '</button>';
    }).join('');
  }

  function renderCard(item) {
    const name = String(item.name || t('dest.destination')).trim();
    const desc = String(item.description || '').trim();
    let slurl = '';
    if (typeof item.slurl === 'string') {
      slurl = item.slurl.trim();
    } else if (item.slurl && typeof item.slurl === 'object') {
      // A few feed items hand us slurl as an object instead of a string, and
      // `String()` on it produced "[object Object]", which then broke teleport.
      // So we log its shape (diag) and best-effort build a secondlife:// SLURL.
      const o = item.slurl;
      if (typeof BeeDiag !== 'undefined' && BeeDiag.log) {
        BeeDiag.log('destinations', 'slurl is an object, keys: ' + Object.keys(o).join(','));
      }
      const rn = o.region_name || o.regionName || o.sim_name || o.region || o.name || '';
      if (rn) {
        const x = o.x != null ? o.x : (o.global_x != null ? o.global_x : 128);
        const y = o.y != null ? o.y : (o.global_y != null ? o.global_y : 128);
        const z = o.z != null ? o.z : 22;
        slurl = 'secondlife://' + String(rn).trim().replace(/\s+/g, '%20') + '/' + x + '/' + y + '/' + z;
      }
    }
    const image = assetFullsize(item);
    const mat = String(item.maturity || '').toUpperCase();
    const pop = item.population && Number.isFinite(Number(item.population.current))
      ? Number(item.population.current)
      : null;

    return '<article class="dest-card">' +
      (image
        ? '<div class="dest-card__media"><img src="' + BeeUtils.escapeHtml(image) +
          '" alt="" loading="lazy" decoding="async"></div>'
        : '') +
      '<div class="dest-card__body">' +
        '<div class="dest-card__head">' +
          '<h4 class="dest-card__title">' +
            (slurl
              ? '<button type="button" class="dest-card__link dest-action" data-action="map" data-slurl="' +
                BeeUtils.escapeHtml(slurl) + '">' + BeeUtils.escapeHtml(name) + '</button>'
              : BeeUtils.escapeHtml(name)) +
          '</h4>' +
          '<span class="dest-maturity ' + maturityClass(mat) + '" title="' +
            BeeUtils.escapeHtml(t('dest.maturityRating')) + '">' +
            BeeUtils.escapeHtml(maturityLabel(mat)) +
          '</span>' +
        '</div>' +
        (desc
          ? '<p class="dest-card__desc">' + BeeUtils.escapeHtml(desc) + '</p>'
          : '') +
        (slurl
          ? '<p class="dest-card__slurl">' +
            '<button type="button" class="dest-slurl-link dest-action" data-action="map" data-slurl="' +
            BeeUtils.escapeHtml(slurl) + '">' + BeeUtils.escapeHtml(slurl) + '</button></p>'
          : '') +
        '<div class="dest-card__meta">' +
          (pop !== null && pop > 0
            ? '<span class="badge">' +
              BeeUtils.escapeHtml(t('dest.hereCount', { count: pop })) +
              '</span>'
            : '') +
        '</div>' +
        '<div class="dest-card__actions">' +
          (slurl
            ? '<button type="button" class="btn btn--ghost btn--sm dest-action" data-action="map" data-slurl="' +
              BeeUtils.escapeHtml(slurl) + '">' + BeeUtils.escapeHtml(t('dest.openInMap')) + '</button>' +
              '<button type="button" class="btn btn--primary btn--sm dest-action" data-action="tp" data-slurl="' +
              BeeUtils.escapeHtml(slurl) + '">' + BeeUtils.escapeHtml(t('teleport.teleport')) + '</button>'
            : '') +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function renderGroups(groups) {
    if (!groups.length) {
      setContent('<p class="dest-empty">' + BeeUtils.escapeHtml(t('dest.empty')) + '</p>');
      return;
    }
    const html = groups.map(function (group) {
      const title = formatCategoryName(group.category);
      const cards = group.items.map(renderCard).join('');
      return '<section class="dest-section">' +
        '<h3 class="dest-section__title">' + BeeUtils.escapeHtml(title) +
        ' <span class="dest-section__count">' + group.items.length + '</span></h3>' +
        '<div class="dest-section__list">' + cards + '</div>' +
      '</section>';
    }).join('');
    setContent(html);
    if (destTeleportBusy) {
      setDestTeleportBusy(true);
    }
  }

  async function loadFeed(feedId, force) {
    const feed = feedId || activeFeed;
    activeFeed = feed;
    if (typeof BeeSettings !== 'undefined') {
      BeeSettings.set('destFeed', feed);
    }
    renderFeedBar();

    if (!force && cache.has(feed)) {
      renderGroups(groupByCategory(cache.get(feed)));
      setStatus(noteHtml(notes.get(feed)));
      return;
    }

    const token = ++loadToken;
    setStatus('<p class="dest-loading">' + BeeUtils.escapeHtml(t('dest.loading')) + '</p>');
    setContent('');

    try {
      const data = await BeeBridge.destinations(feed).catch(function () { return null; });
      if (token !== loadToken) return;
      if (!data || !data.ok || !Array.isArray(data.items)) {
        const detail = data ? (BeeI18n.field(data, 'detail') || BeeI18n.field(data, 'error')) : '';
        throw new Error(detail || t('dest.loadFailed'));
      }
      cache.set(feed, data.items);
      notes.set(feed, noteOf(data));
      setStatus(noteHtml(notes.get(feed)));
      renderGroups(groupByCategory(data.items));
    } catch (err) {
      if (token !== loadToken) return;
      setStatus('');
      setContent(
        '<p class="dest-error">' +
        BeeUtils.escapeHtml(BeeUtils.errText(err) || t('dest.loadFailed')) +
        '</p><button type="button" class="btn btn--ghost btn--sm" id="dest-retry">' +
        BeeUtils.escapeHtml(t('common.retry')) + '</button>'
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
    const short = fallbackShort || t('teleport.stageTeleporting');
    let out = {
      text: t('teleport.stagePercent', { stage: short, pct: 50 }),
      pct: destTeleportPct || 50,
      short: short
    };
    if (typeof BeeTeleportUI !== 'undefined' && BeeTeleportUI.formatProgressLabel) {
      out = BeeTeleportUI.formatProgressLabel(message, destTeleportPct, fallbackShort);
    }
    destTeleportPct = out.pct;
    setDestTeleportBusy(true, out.text);
  }

  function setDestTeleportBusy(busy, label?) {
    destTeleportBusy = !!busy;
    if (!busy) destTeleportPct = 0;
    const content = el('dest-content');
    if (!content) return;
    const text = label || t('teleport.teleporting');
    content.querySelectorAll<HTMLButtonElement>('.dest-action[data-action="tp"]').forEach(function (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? text : t('teleport.teleport');
      btn.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
  }

  function bindTeleportEvents() {
    if (teleportEventsBound) return;
    teleportEventsBound = true;

    BeeTransport.on('teleport-progress', function (data) {
      if (!destTeleportBusy) return;
      applyDestTeleportProgress(data && data.message, t('teleport.stageTeleporting'));
      if (typeof BeeMap !== 'undefined' && BeeMap.beginMapTeleport) {
        BeeMap.beginMapTeleport(data && data.message);
      }
    });

    BeeTransport.on('teleport-started', function () {
      if (!destTeleportBusy) return;
      applyDestTeleportProgress('starting', t('teleport.stageStarting'));
    });

    BeeTransport.on('teleport-finish', function () {
      setDestTeleportBusy(false);
    });

    BeeTransport.on('teleport-failed', function () {
      setDestTeleportBusy(false);
    });

    BeeTransport.on('teleport-cancelled', function () {
      setDestTeleportBusy(false);
    });

    BeeState.on('reset', function () {
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
      if (typeof BeeMap !== 'undefined' && BeeMap.showLocation) {
        BeeMap.showLocation(slurl);
      }
      return;
    }

    if (action === 'tp') {
      if (!BeeState.gridOnline()) {
        BeeUtils.showToast(t('session.notConnected'), 'warning');
        return;
      }
      if (destTeleportBusy) return;

      applyDestTeleportProgress('requesting', t('teleport.stageRequesting'));
      if (typeof BeeMap !== 'undefined') {
        if (BeeMap.showLocation) BeeMap.showLocation(slurl);
        if (BeeMap.beginMapTeleport) BeeMap.beginMapTeleport('requesting');
      }

      BeeTransport.teleportTo(slurl).then(function () {
        applyDestTeleportProgress('starting', t('teleport.stageStarting'));
        if (typeof BeeMap !== 'undefined' && BeeMap.beginMapTeleport) {
          BeeMap.beginMapTeleport('starting');
        }
      }).catch(function (err) {
        setDestTeleportBusy(false);
        if (typeof BeeMap !== 'undefined' && BeeMap.resetTeleportButton) {
          BeeMap.resetTeleportButton();
        }
        BeeUtils.showToast(BeeUtils.errText(err) || t('teleport.failed'), 'error');
      });
    }
  }

  function bindEvents() {
    if (bound) return;
    bound = true;

    const feedbar = el('dest-feedbar');
    if (feedbar) {
      feedbar.addEventListener('click', function (e) {
        const btn = (e.target as HTMLElement).closest('[data-feed]') as HTMLElement | null;
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
    activeFeed = (typeof BeeSettings !== 'undefined' ? BeeSettings.get('destFeed') : null) || 'mobile';
    bindEvents();
    bindTeleportEvents();
    renderFeedBar();
    // The ratings setting changed: the cached feeds were filtered under the
    // old one, so they are dropped, and the open guide is fetched again.
    if (typeof BeeSettings !== 'undefined' && BeeSettings.onChange) {
      BeeSettings.onChange(function (key) {
        if (key !== 'maturity') return;
        cache.clear();
        notes.clear();
        if (BeeState.get().activeTab === 'destinations') void loadFeed(activeFeed, true);
      });
    }
    // A language switch: the feed bar, and the open feed's cards and note
    // from the cache, are painted again in the new words. A feed still
    // loading, or one that failed, is painted when its load ends.
    BeeI18n.onChange(function () {
      renderFeedBar();
      if (!cache.has(activeFeed)) return;
      renderGroups(groupByCategory(cache.get(activeFeed)));
      setStatus(noteHtml(notes.get(activeFeed)));
    });
    // Right-click anywhere on a destination card: the same map/teleport
    // choices as its buttons, plus the SLURL as text.
    if (typeof BeeContextMenu !== 'undefined' && BeeContextMenu.register) {
      BeeContextMenu.register('.dest-card', function (host) {
        const anyAction = host.querySelector('.dest-action[data-slurl]');
        const slurl = anyAction ? anyAction.dataset.slurl || '' : '';
        if (!slurl) return [];
        const clickAction = function (action) {
          return function () {
            const btn = host.querySelector('.dest-action[data-action="' + action + '"]');
            if (btn) btn.click();
          };
        };
        return [
          { label: t('dest.openInMap'), action: clickAction('map') },
          { label: t('teleport.teleport'), action: clickAction('tp'), disabled: !BeeState.gridOnline() },
          {
            label: t('menu.copySlurl'),
            action: function () {
              if (navigator.clipboard) {
                navigator.clipboard.writeText(slurl).then(function () {
                  BeeUtils.showToast(t('common.copiedWhat', { what: 'SLURL' }), 'success');
                }).catch(function () {});
              }
            }
          }
        ];
      });
    }
  }

  return { init: init, loadFeed: loadFeed };
})();
