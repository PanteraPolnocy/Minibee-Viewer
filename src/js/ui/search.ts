// @ts-nocheck - not yet migrated to checked types. Remove this line, then fix
// what npm run typecheck reports for this file.
/**
 * Search panel for avatars, places, and groups.
 */
const BeeSearch = (function () {
  'use strict';

  let activeKind = 'avatars';
  let searchToken = 0;
  let bound = false;
  let searching = false;
  let searchUnlockTimer = null;

  const SEARCH_LOCK_MS = 10000;
  const resultCache = {
    avatars: { query: '', rows: [], status: '', hasMore: false, nextStart: 0 },
    groups: { query: '', rows: [], status: '', hasMore: false, nextStart: 0 },
    places: { query: '', rows: [], status: '', hasMore: false, nextStart: 0 }
  };

  function el(id) {
    return document.getElementById(id);
  }

  function setStatus(text) {
    const node = el('search-status');
    if (node) node.textContent = text || '';
    if (resultCache[activeKind]) {
      resultCache[activeKind].status = text || '';
    }
  }

  function setSearching(active) {
    searching = active;
    const input = el('search-input');
    const runBtn = el('search-run');
    const panel = el('panel-search');
    if (panel) panel.classList.toggle('panel-search--busy', active);
    if (input) input.disabled = active;
    document.querySelectorAll<HTMLElement>('.search-kind').forEach(function (btn) {
      btn.disabled = active;
    });
    if (runBtn) {
      runBtn.disabled = active;
      runBtn.textContent = active ? 'Searching...' : 'Search';
    }
    if (searchUnlockTimer) {
      clearTimeout(searchUnlockTimer);
      searchUnlockTimer = null;
    }
    if (active) {
      searchUnlockTimer = setTimeout(function () {
        if (!searching) return;
        setSearching(false);
        setStatus('Search timed out. Try again.');
      }, SEARCH_LOCK_MS);
    }
  }

  function iconIm() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6l8 5 8-5v12z"/></svg>';
  }

  function iconProfile() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
  }

  function iconMap() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"/></svg>';
  }

  function trafficLabel(row) {
    if (row.dwell === undefined || row.dwell === null) return '';
    return 'Traffic ' + Math.round(row.dwell);
  }

  function placeSaleLabel(row) {
    if (!row || (row.kind || 'place') !== 'place' || !row.detailLoaded) return '';
    if (row.auction) return 'Auction';
    if (row.forSale) return 'For sale';
    return '';
  }

  function placeSubtitle(row) {
    const kind = row.kind || 'place';
    if (kind === 'destination') {
      return row.description ? row.description.slice(0, 80) : 'Destination';
    }
    if (kind === 'region') return 'Region';
    const parts = [];
    const traffic = trafficLabel(row);
    if (traffic) parts.push(traffic);
    const sale = placeSaleLabel(row);
    if (sale) parts.push(sale);
    return parts.join(' · ') || 'Parcel';
  }

  function refreshPlaceSubtitle(li, row) {
    if (!li || !row) return;
    const sub = li.querySelector('.entity-item__sub');
    if (sub) sub.textContent = placeSubtitle(row);
  }

  function startImAvatar(row) {
    if (!row || !row.id) return;
    const participant = {
      id: row.id,
      name: row.name || row.displayName || row.userName || 'Resident',
      userName: row.userName || '',
      displayName: row.displayName || ''
    };
    if (row.online === true) {
      participant.online = true;
      if (row.region) participant.region = row.region;
    }
    BeeIm.startImWith(participant);
  }

  async function ensurePlaceDetails(row) {
    // `kind` only exists as a local at render time - it's never stored on the
    // row, so gating on row.kind here always failed and details never loaded.
    // Callers already guarantee this is a place with a parcelId.
    if (!row || !row.parcelId || row.detailLoaded) return row;
    if (typeof BeeTransport.fetchParcelInfo !== 'function') return row;
    const info = await BeeTransport.fetchParcelInfo(row.parcelId);
    if (!info) return row;
    Object.assign(row, info, { detailLoaded: true });
    return row;
  }

  function showPlaceOnMap(row) {
    if (!row) return;
    // Grid coords come straight from the enriched parcel info (computed in the
    // Rust core), so they center the map directly - no region-name lookup needed.
    if ((row.gridX || row.gridY) && typeof BeeMap !== 'undefined' && BeeMap.showLocation) {
      BeeMap.showLocation({
        regionName: row.simName || row.name || '',
        gridX: row.gridX,
        gridY: row.gridY,
        x: row.x != null ? row.x : 128,
        y: row.y != null ? row.y : 128,
        z: row.z != null ? row.z : 25
      });
      return;
    }
    if (row.slurl && typeof BeeMap !== 'undefined' && BeeMap.showLocation) {
      BeeMap.showLocation(row.slurl);
      return;
    }
    if (row.simName && typeof BeeMap !== 'undefined' && BeeMap.showLocation) {
      BeeMap.showLocation({
        regionName: row.simName,
        x: row.x !== undefined ? row.x : 128,
        y: row.y !== undefined ? row.y : 128,
        z: row.z !== undefined ? row.z : 25
      });
      return;
    }
    if (row.kind === 'region' && row.name && typeof BeeMap !== 'undefined' && BeeMap.showLocation) {
      BeeMap.showLocation({
        regionName: row.name,
        gridX: row.gridX,
        gridY: row.gridY,
        x: 128,
        y: 128,
        z: 25
      });
      return;
    }
    if (row.kind === 'destination' && row.slurl && typeof BeeMap !== 'undefined' && BeeMap.showLocation) {
      BeeMap.showLocation(row.slurl);
    }
  }

  function renderPlaceDetail(detail, row, kind) {
    let textHtml = '';
    if (row.description) {
      textHtml += '<p class="search-result__desc">' + BeeUtils.escapeHtml(row.description) + '</p>';
    }
    if (kind === 'region' && row.gridX !== undefined) {
      textHtml += '<p class="search-result__meta">Grid: ' +
        BeeUtils.escapeHtml(String(row.gridX) + ', ' + String(row.gridY)) + '</p>';
    } else if (kind === 'place' && row.location) {
      textHtml += '<p class="search-result__meta">' + BeeUtils.escapeHtml(row.location) + '</p>';
      if (row.dwell !== undefined && row.dwell !== null) {
        textHtml += '<p class="search-result__meta">Traffic: ' + Math.round(row.dwell) + '</p>';
      }
      if (row.maturity) {
        textHtml += '<p class="search-result__meta">Rating: ' + BeeUtils.escapeHtml(row.maturity) + '</p>';
      }
      if (row.auction) {
        textHtml += '<p class="search-result__meta">Auction</p>';
      } else if (row.forSale) {
        textHtml += '<p class="search-result__meta">For sale</p>';
      }
    } else if (kind === 'destination' && row.maturity) {
      textHtml += '<p class="search-result__meta">Rating: ' + BeeUtils.escapeHtml(String(row.maturity)) + '</p>';
    }
    if (row.slurl) {
      textHtml += '<p class="search-result__slurl">' + BeeUtils.escapeHtml(row.slurl) + '</p>';
    }
    textHtml += '<div class="search-result__detail-actions">' +
      '<button type="button" class="btn btn--primary btn--sm" data-action="detail-map">Show on map</button>' +
      '</div>';

    let html = '<div class="search-result__detail-body">';
    if (row.image) {
      html += '<img class="search-result__image" src="' + BeeUtils.escapeHtml(row.image) +
        '" alt="" loading="lazy" decoding="async">';
    }
    html += '<div class="search-result__detail-text">' + textHtml + '</div></div>';
    detail.innerHTML = html;
    const detailMap = detail.querySelector('[data-action="detail-map"]');
    if (detailMap) {
      detailMap.addEventListener('click', function () {
        showPlaceOnMap(row);
      });
    }
  }

  function renderAvatarRow(row) {
    const li = document.createElement('li');
    li.className = 'entity-item search-result';
    const name = row.name || row.displayName || row.userName || 'Resident';
    // Feeds the shared context menu's "Copy name" / "Copy UUID".
    if (row.id) li.dataset.agentId = row.id;
    li.dataset.label = name;
    li.innerHTML =
      '<div class="entity-item__avatar" data-agent-id="' + BeeUtils.escapeHtml(row.id || '') +
        '" data-resolve-image="0" data-label="' + BeeUtils.escapeHtml(name) + '"></div>' +
      '<div class="entity-item__body">' +
        '<div class="entity-item__name">' + BeeUtils.escapeHtml(name) + '</div>' +
        (row.userName && row.userName !== name
          ? '<div class="entity-item__legacy">' + BeeUtils.escapeHtml(row.userName) + '</div>'
          : '') +
      '</div>' +
      '<div class="entity-item__actions">' +
        '<button type="button" class="icon-btn" data-action="profile" title="Profile" aria-label="Profile">' +
          iconProfile() + '</button>' +
        '<button type="button" class="icon-btn" data-action="im" title="Start conversation" aria-label="Start conversation">' +
          iconIm() + '</button>' +
      '</div>';
    li.querySelector('[data-action="im"]').addEventListener('click', function (e) {
      e.stopPropagation();
      startImAvatar(row);
    });
    li.querySelector('[data-action="profile"]').addEventListener('click', function (e) {
      e.stopPropagation();
      if (row.id) BeeProfile.openAvatar(row.id, { agent: row });
    });
    // Clicking the row (like a radar entry) opens the profile; the action buttons
    // call stopPropagation so they still do their own thing.
    const body = li.querySelector('.entity-item__body');
    if (body && row.id) {
      body.classList.add('entity-item__body--clickable');
      body.addEventListener('click', function () { BeeProfile.openAvatar(row.id, { agent: row }); });
    }
    const thumb = li.querySelector('.entity-item__avatar[data-agent-id]');
    if (thumb) BeeAvatarThumb.refresh(thumb);
    return li;
  }

  function renderGroupRow(row) {
    const li = document.createElement('li');
    li.className = 'entity-item search-result';
    // Feeds the shared context menu's "Copy name" / "Copy UUID".
    if (row.id) li.dataset.groupId = row.id;
    li.dataset.label = row.name || 'Group';
    const members = row.members !== undefined ? (row.members + ' members') : '';
    li.innerHTML =
      '<div class="entity-item__avatar entity-item__avatar--group" data-agent-id="' +
        BeeUtils.escapeHtml(row.id || '') + '" data-kind="group" data-resolve-image="0" data-label="' +
        BeeUtils.escapeHtml(row.name || 'Group') + '">G</div>' +
      '<div class="entity-item__body">' +
        '<div class="entity-item__name">' + BeeUtils.escapeHtml(row.name || 'Group') + '</div>' +
        (members ? '<div class="entity-item__sub">' + BeeUtils.escapeHtml(members) + '</div>' : '') +
      '</div>' +
      '<div class="entity-item__actions">' +
        '<button type="button" class="icon-btn" data-action="profile" title="Group profile" aria-label="Group profile">' +
          iconProfile() + '</button>' +
      '</div>';
    li.querySelector('[data-action="profile"]').addEventListener('click', function (e) {
      e.stopPropagation();
      if (row.id) BeeProfile.openGroup(row.id, { group: row });
    });
    // Clicking the row opens the group profile.
    const groupBody = li.querySelector('.entity-item__body');
    if (groupBody && row.id) {
      groupBody.classList.add('entity-item__body--clickable');
      groupBody.addEventListener('click', function () { BeeProfile.openGroup(row.id, { group: row }); });
    }
    const groupThumb = li.querySelector('.entity-item__avatar[data-agent-id]');
    if (groupThumb) BeeAvatarThumb.refresh(groupThumb);
    return li;
  }

  function renderPlaceRow(row) {
    const li = document.createElement('li');
    li.className = 'entity-item search-result search-result--place';
    const kind = row.kind || 'place';
    const title = row.name || 'Place';
    const subtitle = placeSubtitle(row);

    const showMapBtn = kind === 'destination' || kind === 'region' || kind === 'place';

    li.innerHTML =
      '<button type="button" class="search-result__toggle" aria-expanded="false">' +
        '<div class="entity-item__avatar entity-item__avatar--place">P</div>' +
        '<div class="entity-item__body">' +
          '<div class="entity-item__name">' + BeeUtils.escapeHtml(title) + '</div>' +
          '<div class="entity-item__sub">' + BeeUtils.escapeHtml(subtitle) + '</div>' +
        '</div>' +
      '</button>' +
      '<div class="entity-item__actions">' +
        (showMapBtn
          ? '<button type="button" class="icon-btn" data-action="map" title="Show on map" aria-label="Show on map">' +
            iconMap() + '</button>'
          : '') +
      '</div>' +
      '<div class="search-result__detail" hidden></div>';

    const toggle = li.querySelector('.search-result__toggle');
    const detail = li.querySelector('.search-result__detail');
    const mapBtn = li.querySelector('[data-action="map"]');
    if (mapBtn) {
      mapBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (kind === 'place' && row.parcelId && !row.detailLoaded) {
          mapBtn.disabled = true;
          ensurePlaceDetails(row).then(function (enriched) {
            showPlaceOnMap(enriched);
          }).catch(function (err) {
            BeeUtils.showToast(err.message || 'Could not load place location', 'error');
          }).finally(function () {
            mapBtn.disabled = false;
          });
          return;
        }
        showPlaceOnMap(row);
      });
    }
    toggle.addEventListener('click', function () {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      li.classList.toggle('search-result--open', !open);
      if (!open) {
        detail.hidden = false;
        detail.innerHTML = '<p class="search-result__loading">Loading details...</p>';
        const load = (kind === 'place' && row.parcelId && !row.detailLoaded)
          ? ensurePlaceDetails(row)
          : Promise.resolve(row);
        load.then(function (enriched) {
          renderPlaceDetail(detail, enriched, kind);
          refreshPlaceSubtitle(li, enriched);
        }).catch(function (err) {
          detail.innerHTML = '<p class="search-result__desc">' +
            BeeUtils.escapeHtml(err.message || 'Could not load place details') + '</p>';
        });
      } else {
        detail.hidden = true;
      }
    });
    return li;
  }

  function appendRows(list, rows) {
    rows.forEach(function (row) {
      if (activeKind === 'avatars') {
        list.appendChild(renderAvatarRow(row));
      } else if (activeKind === 'groups') {
        list.appendChild(renderGroupRow(row));
      } else {
        list.appendChild(renderPlaceRow(row));
      }
    });
  }

  function renderLoadMore(list) {
    const cached = resultCache[activeKind];
    if (!cached || !cached.hasMore) return;
    const li = document.createElement('li');
    li.className = 'search-load-more';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--sm search-load-more__btn';
    btn.textContent = 'Load more results';
    btn.addEventListener('click', function () {
      if (searching) return;
      li.remove();
      runSearch(true);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }

  function renderResults(rows, statusOverride) {
    const list = el('search-results');
    if (!list) return;
    list.innerHTML = '';
    if (!rows.length) {
      setStatus(statusOverride || 'No results.');
      return;
    }
    const cached = resultCache[activeKind];
    setStatus(rows.length + (cached && cached.hasMore ? '+' : '') +
      ' result' + (rows.length === 1 ? '' : 's'));
    appendRows(list, rows);
    renderLoadMore(list);
  }

  const MIN_SEARCH_LEN = 3;

  // `loadMore` re-runs the cached query at the next page offset and appends;
  // otherwise this is a fresh page-0 search of whatever is in the input.
  async function runSearch(loadMore) {
    if (searching) return;
    const cached = resultCache[activeKind];
    const input = el('search-input');
    const query = loadMore ? (cached && cached.query) || '' : (input ? input.value.trim() : '');
    const start = loadMore ? (cached && cached.nextStart) || 0 : 0;
    const searchQuery = query;
    if (!searchQuery) {
      setStatus('Enter a search term.');
      return;
    }
    if (searchQuery.length < MIN_SEARCH_LEN) {
      setStatus('Enter at least ' + MIN_SEARCH_LEN + ' characters.');
      return;
    }
    // Reject symbol-only queries like "////" - the sim just answers those with a
    // placeholder "Resident" row. Require at least one letter or digit in any
    // script so unicode place and group names still search.
    if (!/[\p{L}\p{N}]/u.test(searchQuery)) {
      setStatus('Enter letters or numbers to search.');
      return;
    }
    if (!BeeState.gridOnline()) {
      setStatus('Log in to search.');
      return;
    }
    const token = ++searchToken;
    setSearching(true);
    setStatus(loadMore ? 'Loading more...' : 'Searching...');
    try {
      const res = await BeeTransport.searchDirectory(activeKind, searchQuery, start);
      if (token !== searchToken) return;
      const page = (res && res.rows) || [];
      const rows = loadMore ? ((cached && cached.rows) || []).concat(page) : page;
      const statusText = rows.length
        ? (rows.length + (res && res.hasMore ? '+' : '') + ' result' + (rows.length === 1 ? '' : 's'))
        : ((res && res.statusText) || 'No results.');
      resultCache[activeKind] = {
        query: query,
        rows: rows,
        status: statusText,
        hasMore: !!(res && res.hasMore),
        nextStart: (res && res.nextStart) || 0
      };
      renderResults(rows, statusText);
    } catch (err) {
      if (token !== searchToken) return;
      setStatus('Search failed: ' + (err.message || String(err)));
    } finally {
      if (token === searchToken) setSearching(false);
    }
  }

  function switchKind(kind, restoreOnly) {
    activeKind = kind === 'places' || kind === 'groups' ? kind : 'avatars';
    document.querySelectorAll<HTMLElement>('.search-kind').forEach(function (btn) {
      const active = btn.dataset.kind === activeKind;
      btn.classList.toggle('search-kind--active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const input = el('search-input');
    if (input) {
      const placeholders = {
        avatars: 'Search people by username...',
        places: 'Search places and regions...',
        groups: 'Search groups...'
      };
      input.placeholder = placeholders[activeKind] || 'Search...';
      if (restoreOnly) {
        const cached = resultCache[activeKind];
        if (cached && cached.query) input.value = cached.query;
      }
    }
    const cached = resultCache[activeKind];
    if (cached && cached.rows && cached.rows.length) {
      renderResults(cached.rows);
      setStatus(cached.status || '');
    } else {
      setStatus(cached ? cached.status || '' : '');
      renderResults(cached ? cached.rows || [] : []);
    }
  }

  function bindOnce() {
    if (bound) return;
    bound = true;
    const input = el('search-input');
    const runBtn = el('search-run');
    if (input) {
      input.minLength = MIN_SEARCH_LEN;
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !searching) {
          e.preventDefault();
          runSearch();
        }
      });
    }
    if (runBtn) {
      runBtn.addEventListener('click', function () { runSearch(); });
    }
    document.querySelectorAll<HTMLElement>('.search-kind').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (searching) return;
        switchKind(btn.dataset.kind, true);
      });
    });
  }

  function activate() {
    bindOnce();
    switchKind(activeKind, true);
  }

  function init() {
    bindOnce();
  }

  return { init: init, activate: activate, runSearch: runSearch };
})();
