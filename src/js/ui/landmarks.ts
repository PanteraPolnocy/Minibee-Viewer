/**
 * Landmarks in the map sidebar: the inventory list, a filter, and the
 * teleport confirmation for a picked one.
 */
const BeeLandmarks = (function () {
  'use strict';

  let rows = [];
  let loaded = false;
  let loading = false;
  let loadError = '';
  // Bumped whenever the dialog opens or closes, so a slow destination lookup
  // from an earlier pick can't write into a later one.
  let openSeq = 0;
  let current = null;

  function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  function dialog() {
    return el<HTMLDialogElement>('landmark-dialog');
  }

  function byName(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  }

  function render() {
    const list = el('map-landmarks');
    const status = el('map-landmarks-status');
    if (!list) return;
    const filter = el<HTMLInputElement>('map-landmarks-filter');
    const q = filter ? filter.value.trim().toLowerCase() : '';
    const shown = rows.filter(function (r) {
      return !q || String(r.name || '').toLowerCase().indexOf(q) !== -1;
    });
    list.innerHTML = '';
    shown.forEach(function (r) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'map-landmark';
      btn.dataset.assetId = r.assetId;
      btn.textContent = r.name || 'Unnamed landmark';
      btn.title = btn.textContent;
      // Right-click: the shared menu offers this copy alongside "Open".
      btn.dataset.copy = btn.textContent;
      btn.dataset.copyLabel = 'Copy landmark name';
      li.appendChild(btn);
      list.appendChild(li);
    });

    let text = '';
    if (loading) text = 'Loading landmarks...';
    else if (loadError) text = loadError;
    else if (loaded && !rows.length) text = 'No landmarks yet.';
    else if (loaded && !shown.length) text = 'No landmarks match.';
    else if (!loaded && !BeeState.gridOnline()) text = 'Log in to see your landmarks.';
    if (status) {
      status.textContent = text;
      status.hidden = !text;
    }
  }

  async function load(force?: boolean) {
    if (loading || (loaded && !force)) return;
    if (!BeeState.gridOnline()) return;
    loading = true;
    loadError = '';
    render();
    try {
      const fetched = await BeeTransport.listLandmarks();
      rows = (fetched || []).slice().sort(byName);
      loaded = true;
    } catch (err) {
      loadError = BeeUtils.errText(err) || 'Could not load landmarks.';
    } finally {
      loading = false;
      render();
    }
  }

  function reset() {
    rows = [];
    loaded = false;
    loading = false;
    loadError = '';
    close();
    render();
  }

  function close() {
    openSeq++;
    current = null;
    const d = dialog();
    if (d) BeeUtils.dismissDialog(d);
  }

  function setDetails(place, slurl) {
    const placeEl = el('landmark-place');
    const slurlEl = el('landmark-slurl');
    if (placeEl) placeEl.textContent = place || '—';
    if (slurlEl) slurlEl.textContent = slurl || '—';
  }

  // Where the landmark points: its asset gives region id + position, the
  // parcel lookup turns that into a region name, grid position and place name.
  async function resolve(row, seq) {
    const info = await BeeTransport.landmarkInfo(row.assetId);
    if (seq !== openSeq) return;
    const pos = { x: info.x, y: info.y, z: info.z };
    let gridX = info.gridX;
    let gridY = info.gridY;
    let regionName = '';
    let placeName = '';
    const parcel = await BeeTransport.remoteParcel(gridX || 0, gridY || 0, pos.x, pos.y, pos.z, info.regionId || '');
    if (seq !== openSeq) return;
    if (parcel && parcel.ok && parcel.parcelId) {
      const details = await BeeTransport.fetchParcelInfo(parcel.parcelId);
      if (seq !== openSeq) return;
      if (details) {
        regionName = details.simName || '';
        placeName = details.name || '';
        if (details.gridX) gridX = details.gridX;
        if (details.gridY) gridY = details.gridY;
      }
    }
    if (gridX && gridY) {
      current.target = { gridX: gridX, gridY: gridY, x: pos.x, y: pos.y, z: pos.z, regionName: regionName };
    }
    const slurl = regionName
      ? BeeSlurl.buildMapsUrl(regionName, pos)
      : (gridX && gridY
        ? BeeSlurl.formatLocation({ gridX: gridX, gridY: gridY, x: pos.x, y: pos.y, z: pos.z })
        : 'Destination not known until you arrive.');
    setDetails(placeName || (regionName ? regionName : ''), slurl);
  }

  function open(row) {
    const d = dialog();
    if (!d || !row) return;
    const seq = ++openSeq;
    current = { row: row, target: null };
    const name = el('landmark-name');
    if (name) name.textContent = row.name || 'Unnamed landmark';
    setDetails('', 'Looking up destination...');
    if (!d.open) {
      try { d.showModal(); } catch (_e) { d.setAttribute('open', ''); }
    }
    resolve(row, seq).catch(function (err) {
      if (seq !== openSeq) return;
      setDetails('', BeeUtils.errText(err) || 'Destination details unavailable.');
    });
  }

  async function teleport() {
    if (!current) return;
    const row = current.row;
    const target = current.target;
    close();
    if (typeof BeeMap !== 'undefined') {
      BeeMap.beginMapTeleport('requesting');
      BeeMap.setToolsOpen(false);
    }
    try {
      await BeeTransport.teleportToLandmark(row.assetId, target);
      BeeUtils.showToast('Teleporting to ' + (row.name || 'landmark') + '...', 'success');
    } catch (err) {
      if (typeof BeeMap !== 'undefined') BeeMap.resetTeleportButton();
      BeeUtils.showToast(BeeUtils.errText(err) || 'Teleport failed', 'error');
    }
  }

  function activate() {
    load(false);
  }

  function init() {
    const list = el('map-landmarks');
    const filter = el<HTMLInputElement>('map-landmarks-filter');
    const refresh = el('map-landmarks-refresh');
    const form = el('landmark-form');
    const cancel = el('landmark-cancel');
    const d = dialog();

    if (list) {
      list.addEventListener('click', function (e) {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('.map-landmark');
        if (!btn) return;
        const row = rows.find(function (r) { return r.assetId === btn.dataset.assetId; });
        if (row) open(row);
      });
      if (typeof BeeContextMenu !== 'undefined' && BeeContextMenu.register) {
        BeeContextMenu.register('.map-landmark', function (host) {
          const row = rows.find(function (r) { return r.assetId === host.dataset.assetId; });
          if (!row) return [];
          return [{ label: 'Open landmark', action: function () { open(row); } }];
        });
      }
    }
    if (filter) filter.addEventListener('input', render);
    if (refresh) refresh.addEventListener('click', function () { load(true); });
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        teleport();
      });
    }
    if (cancel) cancel.addEventListener('click', close);
    if (d) {
      d.addEventListener('cancel', function (e) {
        e.preventDefault();
        close();
      });
    }

    BeeState.on('reset', reset);
    BeeState.on('change', function (partial) {
      if (partial && partial.sessionLost === true) close();
    });
    // Logging in with the map already open: fetch now rather than on the
    // next tab switch.
    BeeTransport.on('connected', function () {
      if (BeeState.get().activeTab === 'map') load(false);
      else render();
    });
    render();
  }

  return {
    init: init,
    activate: activate,
    reload: function () { return load(true); },
    reset: reset
  };
})();

window.BeeLandmarks = BeeLandmarks;
