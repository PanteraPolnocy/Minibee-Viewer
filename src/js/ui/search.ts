/**
 * Search panel for avatars, places, and groups.
 */
const BeeSearch = (function () {
  'use strict';

  const t = BeeI18n.t;

  let activeKind = 'avatars';
  let searchToken = 0;
  let bound = false;
  let searching = false;
  let searchUnlockTimer = null;

  const SEARCH_LOCK_MS = 10000;

  // What one kind of search last showed. The status line is kept as a
  // function of the language, so a switch can paint it again; `reply` is
  // the core's last answer, for its own status line and its note about the
  // ratings left out (both arrive with their keys beside them).
  type Cached = {
    query: string;
    rows: any[];
    status: (() => string) | null;
    hasMore: boolean;
    nextStart: number;
    reply: any;
  };
  function emptyCache(): Cached {
    return { query: '', rows: [], status: null, hasMore: false, nextStart: 0, reply: null };
  }
  const resultCache: Record<string, Cached> = {
    avatars: emptyCache(),
    groups: emptyCache(),
    places: emptyCache()
  };

  // Callers that need a form control ask for it: el<HTMLInputElement>('...').
  function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  // `line` is the status text, or a function returning it (see Cached).
  function setStatus(line) {
    const fn = typeof line === 'function' ? line : function () { return line || ''; };
    const node = el('search-status');
    if (node) node.textContent = fn();
    if (resultCache[activeKind]) {
      resultCache[activeKind].status = fn;
    }
  }

  function placeholderFor(kind) {
    if (kind === 'places') return t('search.placesPlaceholder');
    if (kind === 'groups') return t('search.groupsPlaceholder');
    return t('search.peoplePlaceholder');
  }

  function paintRunButton() {
    const runBtn = el<HTMLButtonElement>('search-run');
    if (!runBtn) return;
    runBtn.disabled = searching;
    runBtn.textContent = searching ? t('land.searching') : t('common.search');
  }

  function setSearching(active) {
    searching = active;
    const input = el<HTMLInputElement>('search-input');
    const panel = el('panel-search');
    if (panel) panel.classList.toggle('panel-search--busy', active);
    if (input) input.disabled = active;
    document.querySelectorAll<HTMLButtonElement>('.search-kind').forEach(function (btn) {
      btn.disabled = active;
    });
    paintRunButton();
    if (searchUnlockTimer) {
      clearTimeout(searchUnlockTimer);
      searchUnlockTimer = null;
    }
    if (active) {
      searchUnlockTimer = setTimeout(function () {
        if (!searching) return;
        setSearching(false);
        setStatus(function () { return t('search.timedOut'); });
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
    return t('search.traffic', { value: Math.round(row.dwell) });
  }

  function placeSaleLabel(row) {
    if (!row || (row.kind || 'place') !== 'place' || !row.detailLoaded) return '';
    if (row.auction) return t('search.auction');
    if (row.forSale) return t('interact.forSale');
    return '';
  }

  function placeSubtitle(row) {
    const kind = row.kind || 'place';
    if (kind === 'destination') {
      return row.description ? row.description.slice(0, 80) : t('dest.destination');
    }
    if (kind === 'region') return t('chat.region');
    const parts = [];
    const traffic = trafficLabel(row);
    if (traffic) parts.push(traffic);
    const sale = placeSaleLabel(row);
    if (sale) parts.push(sale);
    return parts.join(' · ') || t('land.parcel');
  }

  // The core rates a parcel General, Moderate or Adult, in those words;
  // anything else is shown as it came.
  function ratingLabel(value) {
    const v = String(value || '');
    if (v === 'General') return t('land.ratingGeneral');
    if (v === 'Moderate') return t('land.ratingModerate');
    if (v === 'Adult') return t('land.ratingAdult');
    return v;
  }

  function refreshPlaceSubtitle(li, row) {
    if (!li || !row) return;
    const sub = li.querySelector('.entity-item__sub');
    if (sub) sub.textContent = placeSubtitle(row);
  }

  function startImAvatar(row) {
    if (!row || !row.id) return;
    // online/region are only known for a resident the search says is present.
    const participant: {
      id: any; name: string; userName: string; displayName: string;
      online?: boolean; region?: any;
    } = {
      id: row.id,
      name: row.name || row.displayName || row.userName || t('profile.resident'),
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

  function metaLine(text) {
    return '<p class="search-result__meta">' + BeeUtils.escapeHtml(text) + '</p>';
  }

  function renderPlaceDetail(detail, row, kind) {
    let textHtml = '';
    if (row.description) {
      textHtml += '<p class="search-result__desc">' + BeeUtils.escapeHtml(row.description) + '</p>';
    }
    if (kind === 'region' && row.gridX !== undefined) {
      textHtml += metaLine(t('search.gridMeta', { x: row.gridX, y: row.gridY }));
    } else if (kind === 'place' && row.location) {
      textHtml += metaLine(row.location);
      if (row.dwell !== undefined && row.dwell !== null) {
        textHtml += metaLine(t('search.trafficMeta', { value: Math.round(row.dwell) }));
      }
      if (row.maturity) {
        textHtml += metaLine(t('search.ratingMeta', { rating: ratingLabel(row.maturity) }));
      }
      if (row.auction) {
        textHtml += metaLine(t('search.auction'));
      } else if (row.forSale) {
        textHtml += metaLine(t('interact.forSale'));
      }
    } else if (kind === 'destination' && row.maturity) {
      textHtml += metaLine(t('search.ratingMeta', { rating: ratingLabel(row.maturity) }));
    }
    if (row.slurl) {
      textHtml += '<p class="search-result__slurl">' + BeeUtils.escapeHtml(row.slurl) + '</p>';
    }
    textHtml += '<div class="search-result__detail-actions">' +
      '<button type="button" class="btn btn--primary btn--sm" data-action="detail-map">' +
        BeeUtils.escapeHtml(t('map.showOnMap')) + '</button>' +
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
    const name = row.name || row.displayName || row.userName || t('profile.resident');
    const profileLabel = BeeUtils.escapeHtml(t('common.profile'));
    const imLabel = BeeUtils.escapeHtml(t('search.startConversation'));
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
        '<button type="button" class="icon-btn" data-action="profile" title="' + profileLabel +
          '" aria-label="' + profileLabel + '">' + iconProfile() + '</button>' +
        '<button type="button" class="icon-btn" data-action="im" title="' + imLabel +
          '" aria-label="' + imLabel + '">' + iconIm() + '</button>' +
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
    const name = row.name || t('groups.group');
    // Feeds the shared context menu's "Copy name" / "Copy UUID".
    if (row.id) li.dataset.groupId = row.id;
    li.dataset.label = name;
    const members = row.members !== undefined
      ? t('im.memberCount', { count: row.members })
      : '';
    const profileLabel = BeeUtils.escapeHtml(t('im.groupProfile'));
    li.innerHTML =
      '<div class="entity-item__avatar entity-item__avatar--group" data-agent-id="' +
        BeeUtils.escapeHtml(row.id || '') + '" data-kind="group" data-resolve-image="0" data-label="' +
        BeeUtils.escapeHtml(name) + '">' + BeeUtils.escapeHtml(t('thumb.groupGlyph')) + '</div>' +
      '<div class="entity-item__body">' +
        '<div class="entity-item__name">' + BeeUtils.escapeHtml(name) + '</div>' +
        (members ? '<div class="entity-item__sub">' + BeeUtils.escapeHtml(members) + '</div>' : '') +
      '</div>' +
      '<div class="entity-item__actions">' +
        '<button type="button" class="icon-btn" data-action="profile" title="' + profileLabel +
          '" aria-label="' + profileLabel + '">' + iconProfile() + '</button>' +
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
    const title = row.name || t('landmarks.place');
    const subtitle = placeSubtitle(row);
    const mapLabel = BeeUtils.escapeHtml(t('map.showOnMap'));

    const showMapBtn = kind === 'destination' || kind === 'region' || kind === 'place';

    li.innerHTML =
      '<button type="button" class="search-result__toggle" aria-expanded="false">' +
        '<div class="entity-item__avatar entity-item__avatar--place">' +
          BeeUtils.escapeHtml(t('thumb.placeGlyph')) + '</div>' +
        '<div class="entity-item__body">' +
          '<div class="entity-item__name">' + BeeUtils.escapeHtml(title) + '</div>' +
          '<div class="entity-item__sub">' + BeeUtils.escapeHtml(subtitle) + '</div>' +
        '</div>' +
      '</button>' +
      '<div class="entity-item__actions">' +
        (showMapBtn
          ? '<button type="button" class="icon-btn" data-action="map" title="' + mapLabel +
            '" aria-label="' + mapLabel + '">' + iconMap() + '</button>'
          : '') +
      '</div>' +
      '<div class="search-result__detail" hidden></div>';

    const toggle = li.querySelector('.search-result__toggle');
    const detail = li.querySelector<HTMLElement>('.search-result__detail');
    const mapBtn = li.querySelector<HTMLButtonElement>('[data-action="map"]');
    if (mapBtn) {
      mapBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (kind === 'place' && row.parcelId && !row.detailLoaded) {
          mapBtn.disabled = true;
          ensurePlaceDetails(row).then(function (enriched) {
            showPlaceOnMap(enriched);
          }).catch(function (err) {
            BeeUtils.showToast(BeeUtils.errText(err) ||
              t('search.placeLocationFailed'), 'error');
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
        detail.innerHTML = '<p class="search-result__loading">' +
          BeeUtils.escapeHtml(t('search.loadingDetails')) + '</p>';
        const load = (kind === 'place' && row.parcelId && !row.detailLoaded)
          ? ensurePlaceDetails(row)
          : Promise.resolve(row);
        load.then(function (enriched) {
          renderPlaceDetail(detail, enriched, kind);
          refreshPlaceSubtitle(li, enriched);
        }).catch(function (err) {
          detail.innerHTML = '<p class="search-result__desc">' +
            BeeUtils.escapeHtml(BeeUtils.errText(err) ||
              t('search.placeDetailsFailed')) + '</p>';
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
    btn.textContent = t('search.loadMore');
    btn.addEventListener('click', function () {
      if (searching) return;
      li.remove();
      runSearch(true);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }

  // The status for a page of results: the count, with "+" while another
  // page waits, or for an empty page the sim's reason (else "No results."),
  // then the core's line about the maturity bands left out (see the Search
  // setting), so an empty page explains itself.
  function resultStatus(cached) {
    const n = cached.rows.length;
    let text;
    if (n) {
      text = cached.hasMore
        ? t('search.resultCountMore', { count: n })
        : t('search.resultCount', { count: n });
    } else {
      text = BeeI18n.field(cached.reply, 'statusText') || t('search.noResults');
    }
    const note = BeeI18n.field(cached.reply, 'note');
    return note ? text + ' ' + note : text;
  }

  function renderResults(rows, statusOverride?) {
    const list = el('search-results');
    if (!list) return;
    list.innerHTML = '';
    if (!rows.length) {
      setStatus(statusOverride || function () { return t('search.noResults'); });
      return;
    }
    const cached = resultCache[activeKind];
    setStatus(function () { return resultStatus(cached); });
    appendRows(list, rows);
    renderLoadMore(list);
  }

  const MIN_SEARCH_LEN = 3;

  // `loadMore` re-runs the cached query at the next page offset and appends;
  // otherwise this is a fresh page-0 search of whatever is in the input.
  async function runSearch(loadMore?) {
    if (searching) return;
    const cached = resultCache[activeKind];
    const input = el<HTMLInputElement>('search-input');
    const query = loadMore ? (cached && cached.query) || '' : (input ? input.value.trim() : '');
    const start = loadMore ? (cached && cached.nextStart) || 0 : 0;
    const searchQuery = query;
    if (!searchQuery) {
      setStatus(function () { return t('search.enterTerm'); });
      return;
    }
    if (searchQuery.length < MIN_SEARCH_LEN) {
      setStatus(function () {
        return t('search.minLength', { count: MIN_SEARCH_LEN });
      });
      return;
    }
    // Reject symbol-only queries like "////" - the sim just answers those with a
    // placeholder "Resident" row. Require at least one letter or digit in any
    // script so unicode place and group names still search.
    if (!/[\p{L}\p{N}]/u.test(searchQuery)) {
      setStatus(function () { return t('search.lettersOrNumbers'); });
      return;
    }
    if (!BeeState.gridOnline()) {
      setStatus(function () { return t('search.logIn'); });
      return;
    }
    const token = ++searchToken;
    setSearching(true);
    setStatus(function () {
      return loadMore ? t('search.loadingMore') : t('land.searching');
    });
    try {
      const res = await BeeTransport.searchDirectory(activeKind, searchQuery, start);
      if (token !== searchToken) return;
      const page = (res && res.rows) || [];
      const rows = loadMore ? ((cached && cached.rows) || []).concat(page) : page;
      const entry: Cached = {
        query: query,
        rows: rows,
        status: null,
        hasMore: !!(res && res.hasMore),
        nextStart: (res && res.nextStart) || 0,
        reply: res || null
      };
      resultCache[activeKind] = entry;
      renderResults(rows, function () { return resultStatus(entry); });
    } catch (err) {
      if (token !== searchToken) return;
      const reason = BeeUtils.errText(err);
      setStatus(function () {
        return reason
          ? t('search.failedWith', { error: reason })
          : t('search.failed');
      });
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
    const input = el<HTMLInputElement>('search-input');
    if (input) {
      input.placeholder = placeholderFor(activeKind);
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

  // A language switch: the placeholder, the button, the rows and the status
  // line are painted again in the new words; a search in flight finishes
  // on its own.
  function repaint() {
    const input = el<HTMLInputElement>('search-input');
    if (input) input.placeholder = placeholderFor(activeKind);
    paintRunButton();
    const cached = resultCache[activeKind];
    const status = cached.status;
    if (cached.rows.length) renderResults(cached.rows);
    if (status) setStatus(status);
  }

  function bindOnce() {
    if (bound) return;
    bound = true;
    const input = el<HTMLInputElement>('search-input');
    const runBtn = el<HTMLButtonElement>('search-run');
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
    BeeI18n.onChange(repaint);
  }

  return { init: init, activate: activate, runSearch: runSearch };
})();
