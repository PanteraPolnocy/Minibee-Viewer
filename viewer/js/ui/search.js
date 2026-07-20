/**
 * Search panel - avatars, places, and groups.
 */
const FSSearch = (function () {
  'use strict';

  let activeKind = 'avatars';
  let searchToken = 0;
  let bound = false;
  let searching = false;
  let searchUnlockTimer = null;

  const SEARCH_LOCK_MS = 10000;
  const resultCache = {
    avatars: { query: '', rows: [], status: '' },
    groups: { query: '', rows: [], status: '' },
    places: { query: '', rows: [], status: '' }
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
    document.querySelectorAll('.search-kind').forEach(function (btn) {
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
    if (!row || row.kind !== 'place' || !row.detailLoaded) return '';
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
    FSIm.startImWith(participant);
  }

  async function ensurePlaceDetails(row) {
    if (!row || row.kind !== 'place' || !row.parcelId || row.detailLoaded) return row;
    if (typeof FSTransport.fetchParcelInfo !== 'function') return row;
    const info = await FSTransport.fetchParcelInfo(row.parcelId);
    if (!info) return row;
    Object.assign(row, info, { detailLoaded: true });
    return row;
  }

  function showPlaceOnMap(row) {
    if (!row) return;
    if (row.slurl && typeof FSMap !== 'undefined' && FSMap.showLocation) {
      FSMap.showLocation(row.slurl);
      return;
    }
    if (row.simName && typeof FSMap !== 'undefined' && FSMap.showLocation) {
      FSMap.showLocation({
        regionName: row.simName,
        x: row.x !== undefined ? row.x : 128,
        y: row.y !== undefined ? row.y : 128,
        z: row.z !== undefined ? row.z : 25
      });
      return;
    }
    if (row.kind === 'region' && row.name && typeof FSMap !== 'undefined' && FSMap.showLocation) {
      FSMap.showLocation({
        regionName: row.name,
        gridX: row.gridX,
        gridY: row.gridY,
        x: 128,
        y: 128,
        z: 25
      });
      return;
    }
    if (row.kind === 'destination' && row.slurl && typeof FSMap !== 'undefined' && FSMap.showLocation) {
      FSMap.showLocation(row.slurl);
    }
  }

  function renderPlaceDetail(detail, row, kind) {
    let textHtml = '';
    if (row.description) {
      textHtml += '<p class="search-result__desc">' + FSUtils.escapeHtml(row.description) + '</p>';
    }
    if (kind === 'region' && row.gridX !== undefined) {
      textHtml += '<p class="search-result__meta">Grid: ' +
        FSUtils.escapeHtml(String(row.gridX) + ', ' + String(row.gridY)) + '</p>';
    } else if (kind === 'place' && row.location) {
      textHtml += '<p class="search-result__meta">' + FSUtils.escapeHtml(row.location) + '</p>';
      if (row.maturity) {
        textHtml += '<p class="search-result__meta">Rating: ' + FSUtils.escapeHtml(row.maturity) + '</p>';
      }
      if (row.auction) {
        textHtml += '<p class="search-result__meta">Auction</p>';
      } else if (row.forSale) {
        textHtml += '<p class="search-result__meta">For sale</p>';
      }
    } else if (kind === 'destination' && row.maturity) {
      textHtml += '<p class="search-result__meta">Rating: ' + FSUtils.escapeHtml(String(row.maturity)) + '</p>';
    }
    if (row.slurl) {
      textHtml += '<p class="search-result__slurl">' + FSUtils.escapeHtml(row.slurl) + '</p>';
    }
    textHtml += '<div class="search-result__detail-actions">' +
      '<button type="button" class="btn btn--primary btn--sm" data-action="detail-map">Show on map</button>' +
      '</div>';

    let html = '<div class="search-result__detail-body">';
    if (row.image) {
      html += '<img class="search-result__image" src="' + FSUtils.escapeHtml(row.image) +
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
    li.innerHTML =
      '<div class="entity-item__avatar" data-agent-id="' + FSUtils.escapeHtml(row.id || '') +
        '" data-resolve-image="0" data-label="' + FSUtils.escapeHtml(name) + '"></div>' +
      '<div class="entity-item__body">' +
        '<div class="entity-item__name">' + FSUtils.escapeHtml(name) + '</div>' +
        (row.userName && row.userName !== name
          ? '<div class="entity-item__legacy">' + FSUtils.escapeHtml(row.userName) + '</div>'
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
      if (row.id) FSProfile.openAvatar(row.id, { agent: row });
    });
    const thumb = li.querySelector('.entity-item__avatar[data-agent-id]');
    if (thumb) FSAvatarThumb.refresh(thumb);
    return li;
  }

  function renderGroupRow(row) {
    const li = document.createElement('li');
    li.className = 'entity-item search-result';
    const members = row.members !== undefined ? (row.members + ' members') : '';
    li.innerHTML =
      '<div class="entity-item__avatar entity-item__avatar--group" data-agent-id="' +
        FSUtils.escapeHtml(row.id || '') + '" data-kind="group" data-resolve-image="0" data-label="' +
        FSUtils.escapeHtml(row.name || 'Group') + '">G</div>' +
      '<div class="entity-item__body">' +
        '<div class="entity-item__name">' + FSUtils.escapeHtml(row.name || 'Group') + '</div>' +
        (members ? '<div class="entity-item__sub">' + FSUtils.escapeHtml(members) + '</div>' : '') +
      '</div>' +
      '<div class="entity-item__actions">' +
        '<button type="button" class="icon-btn" data-action="profile" title="Group profile" aria-label="Group profile">' +
          iconProfile() + '</button>' +
      '</div>';
    li.querySelector('[data-action="profile"]').addEventListener('click', function (e) {
      e.stopPropagation();
      if (row.id) FSProfile.openGroup(row.id);
    });
    const groupThumb = li.querySelector('.entity-item__avatar[data-agent-id]');
    if (groupThumb) FSAvatarThumb.refresh(groupThumb);
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
          '<div class="entity-item__name">' + FSUtils.escapeHtml(title) + '</div>' +
          '<div class="entity-item__sub">' + FSUtils.escapeHtml(subtitle) + '</div>' +
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
            FSUtils.showToast(err.message || 'Could not load place location', 'error');
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
            FSUtils.escapeHtml(err.message || 'Could not load place details') + '</p>';
        });
      } else {
        detail.hidden = true;
      }
    });
    return li;
  }

  function renderResults(rows) {
    const list = el('search-results');
    if (!list) return;
    list.innerHTML = '';
    if (!rows.length) {
      setStatus('No results.');
      return;
    }
    setStatus(rows.length + ' result' + (rows.length === 1 ? '' : 's'));
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

  const MIN_SEARCH_LEN = (typeof FSSearchApi !== 'undefined' && FSSearchApi.MIN_QUERY_LEN) || 3;

  async function runSearch() {
    if (searching) return;
    const input = el('search-input');
    const query = input ? input.value.trim() : '';
    const searchQuery = (activeKind === 'avatars' && typeof FSSearchApi !== 'undefined' &&
      FSSearchApi.normalizePeopleQuery)
      ? FSSearchApi.normalizePeopleQuery(query)
      : query;
    if (!searchQuery) {
      setStatus('Enter a search term.');
      return;
    }
    if (searchQuery.length < MIN_SEARCH_LEN) {
      setStatus('Enter at least ' + MIN_SEARCH_LEN + ' characters.');
      return;
    }
    if (!FSState.gridOnline()) {
      setStatus('Log in to search.');
      return;
    }
    const token = ++searchToken;
    setSearching(true);
    setStatus('Searching...');
    try {
      const rows = await FSTransport.searchDirectory(activeKind, searchQuery);
      if (token !== searchToken) return;
      const list = rows || [];
      resultCache[activeKind] = {
        query: query,
        rows: list,
        status: list.length
          ? (list.length + ' result' + (list.length === 1 ? '' : 's'))
          : 'No results.'
      };
      renderResults(list);
    } catch (err) {
      if (token !== searchToken) return;
      setStatus('Search failed: ' + (err.message || String(err)));
    } finally {
      if (token === searchToken) setSearching(false);
    }
  }

  function switchKind(kind, restoreOnly) {
    activeKind = kind === 'places' || kind === 'groups' ? kind : 'avatars';
    document.querySelectorAll('.search-kind').forEach(function (btn) {
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
    } else if (!restoreOnly) {
      setStatus('');
      renderResults([]);
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
      runBtn.addEventListener('click', runSearch);
    }
    document.querySelectorAll('.search-kind').forEach(function (btn) {
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
