(() => {
  'use strict';

  const DEFAULT_CENTER = [55.751244, 37.618423];
  const DEFAULT_ZOOM = 7;
  const REFRESH_MS = 5000;
  const MAX_TRACK_POINTS = 500;
  const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);

  const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const markers = new Map();
  const aircraftByHex = new Map();
  const tracks = new Map();
  let selectedHex = null;
  let selectedTrackLine = null;
  let loading = false;
  let refreshTimer = null;
  let toastTimer = null;

  const $ = (id) => document.getElementById(id);
  const ui = {
    count: $('aircraftCount'), lastUpdate: $('lastUpdate'), details: $('details'), closeDetails: $('closeDetails'),
    detailHex: $('detailHex'), detailFlight: $('detailFlight'), detailModel: $('detailModel'), detailReg: $('detailReg'),
    detailOperator: $('detailOperator'), detailAlt: $('detailAlt'), detailSpeed: $('detailSpeed'), detailTrack: $('detailTrack'),
    detailVRate: $('detailVRate'), detailSquawk: $('detailSquawk'), detailSource: $('detailSource'), emergencyBadge: $('emergencyBadge'),
    searchForm: $('searchForm'), searchInput: $('searchInput'), refreshBtn: $('refreshBtn'), locateBtn: $('locateBtn'), toast: $('toast'),
    airborneOnly: $('airborneOnly'), militaryOnly: $('militaryOnly'), emergencyOnly: $('emergencyOnly'), minAltitude: $('minAltitude'), minAltLabel: $('minAltLabel')
  };

  function showToast(message, ms = 2800) {
    ui.toast.textContent = message;
    ui.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), ms);
  }

  function safeText(value, fallback = '—') {
    if (value === null || value === undefined || value === '') return fallback;
    return String(value).trim() || fallback;
  }

  function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function altitudeValue(ac) {
    if (ac.alt_baro === 'ground') return 0;
    return num(ac.alt_baro) ?? num(ac.alt_geom) ?? 0;
  }

  function isEmergency(ac) {
    const sq = safeText(ac.squawk, '');
    const em = safeText(ac.emergency, '').toLowerCase();
    return EMERGENCY_SQUAWKS.has(sq) || (em && em !== 'none' && em !== 'no emergency');
  }

  function isMilitary(ac) {
    // readsb/tar1090 databases commonly expose military as bit 0 of dbFlags.
    return Number.isFinite(Number(ac.dbFlags)) && (Number(ac.dbFlags) & 1) === 1;
  }

  function isAirborne(ac) {
    return ac.alt_baro !== 'ground' && altitudeValue(ac) > 0;
  }

  function matchesFilters(ac) {
    if (ui.airborneOnly.checked && !isAirborne(ac)) return false;
    if (ui.militaryOnly.checked && !isMilitary(ac)) return false;
    if (ui.emergencyOnly.checked && !isEmergency(ac)) return false;
    if (altitudeValue(ac) < Number(ui.minAltitude.value)) return false;
    return true;
  }

  function markerSvg(track, selected, emergency) {
    const rotation = Number.isFinite(Number(track)) ? Number(track) : 0;
    const state = emergency ? 'emergency' : (selected ? 'selected' : '');
    return `
      <div class="plane-wrap ${state}">
        <svg viewBox="0 0 32 32" style="transform:rotate(${rotation}deg)" aria-hidden="true">
          <path class="plane-body" d="M16 2.2c1.1 0 1.9.9 2 2l.7 8 8.8 5.3v2l-8.5-2.4.6 8 3.1 2v1.7L16 27.2l-6.7 1.6v-1.7l3.1-2 .6-8-8.5 2.4v-2l8.8-5.3.7-8c.1-1.1.9-2 2-2z"/>
        </svg>
      </div>`;
  }

  function aircraftKey(ac) {
    return safeText(ac.hex, '').toLowerCase();
  }

  function labelFor(ac) {
    const flight = safeText(ac.flight, '').trim();
    const reg = safeText(ac.r, '').trim();
    return flight || reg || safeText(ac.hex, 'unknown').toUpperCase();
  }

  function makeIcon(ac, selected = false) {
    const emergency = isEmergency(ac);
    const label = labelFor(ac);
    const html = markerSvg(ac.track, selected, emergency).replace('</div>', `<span class="plane-label">${escapeHtml(label)}</span></div>`);
    return L.divIcon({ className: 'plane-marker', html, iconSize: [34, 34], iconAnchor: [17, 17] });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }

  function addTrackPoint(ac) {
    const hex = aircraftKey(ac);
    const lat = num(ac.lat), lon = num(ac.lon);
    if (!hex || lat === null || lon === null) return;
    const list = tracks.get(hex) || [];
    const last = list[list.length - 1];
    if (!last || Math.abs(last[0] - lat) > 1e-5 || Math.abs(last[1] - lon) > 1e-5) {
      list.push([lat, lon]);
      if (list.length > MAX_TRACK_POINTS) list.splice(0, list.length - MAX_TRACK_POINTS);
      tracks.set(hex, list);
    }
  }

  function drawSelectedTrack() {
    if (selectedTrackLine) {
      map.removeLayer(selectedTrackLine);
      selectedTrackLine = null;
    }
    if (!selectedHex) return;
    const points = tracks.get(selectedHex) || [];
    if (points.length >= 2) {
      selectedTrackLine = L.polyline(points, { weight: 3, opacity: 0.82, className: 'track-line' }).addTo(map);
      selectedTrackLine.bringToBack();
    }
  }

  function updateMarkers(items) {
    const visibleHex = new Set();
    aircraftByHex.clear();

    for (const ac of items) {
      const hex = aircraftKey(ac);
      const lat = num(ac.lat), lon = num(ac.lon);
      if (!hex || lat === null || lon === null) continue;
      aircraftByHex.set(hex, ac);
      addTrackPoint(ac);
      if (!matchesFilters(ac)) continue;
      visibleHex.add(hex);

      let marker = markers.get(hex);
      if (!marker) {
        marker = L.marker([lat, lon], { icon: makeIcon(ac, hex === selectedHex), riseOnHover: true });
        marker.on('click', () => selectAircraft(hex, true));
        marker.addTo(map);
        markers.set(hex, marker);
      } else {
        marker.setLatLng([lat, lon]);
        marker.setIcon(makeIcon(ac, hex === selectedHex));
      }
    }

    for (const [hex, marker] of markers.entries()) {
      if (!visibleHex.has(hex)) {
        map.removeLayer(marker);
        markers.delete(hex);
      }
    }

    ui.count.textContent = String(visibleHex.size);
    drawSelectedTrack();
    if (selectedHex && aircraftByHex.has(selectedHex)) fillDetails(aircraftByHex.get(selectedHex));
  }

  function fillDetails(ac) {
    ui.detailHex.textContent = `ICAO ${safeText(ac.hex).toUpperCase()}`;
    ui.detailFlight.textContent = labelFor(ac);
    const modelBits = [safeText(ac.t, ''), safeText(ac.desc, '')].filter(Boolean);
    ui.detailModel.textContent = modelBits.join(' · ') || 'Тип самолёта не передан';
    ui.detailReg.textContent = safeText(ac.r);
    ui.detailOperator.textContent = safeText(ac.ownOp);

    if (ac.alt_baro === 'ground') ui.detailAlt.textContent = 'на земле';
    else ui.detailAlt.textContent = num(ac.alt_baro) !== null ? `${Math.round(ac.alt_baro).toLocaleString('ru-RU')} ft` : safeText(ac.alt_geom);

    ui.detailSpeed.textContent = num(ac.gs) !== null ? `${Math.round(ac.gs)} kt · ${Math.round(ac.gs * 1.852)} км/ч` : '—';
    ui.detailTrack.textContent = num(ac.track) !== null ? `${Math.round(ac.track)}°` : '—';
    ui.detailVRate.textContent = num(ac.baro_rate) !== null ? `${Math.round(ac.baro_rate)} ft/min` : '—';
    ui.detailSquawk.textContent = safeText(ac.squawk);
    const src = Array.isArray(ac.mlat) && ac.mlat.length ? 'MLAT / mixed' : (Array.isArray(ac.tisb) && ac.tisb.length ? 'TIS-B / mixed' : 'ADS-B / Mode-S');
    ui.detailSource.textContent = src;
    ui.emergencyBadge.classList.toggle('hidden', !isEmergency(ac));
  }

  async function selectAircraft(hex, pan = false) {
    selectedHex = String(hex || '').toLowerCase();
    const ac = aircraftByHex.get(selectedHex);
    if (ac) {
      fillDetails(ac);
      ui.details.classList.remove('hidden');
      if (pan && num(ac.lat) !== null && num(ac.lon) !== null) map.panTo([ac.lat, ac.lon]);
    }
    for (const [key, marker] of markers.entries()) {
      const item = aircraftByHex.get(key);
      if (item) marker.setIcon(makeIcon(item, key === selectedHex));
    }
    drawSelectedTrack();
  }

  function radiusForMap() {
    const center = map.getCenter();
    const bounds = map.getBounds();
    const northEast = bounds.getNorthEast();
    const meters = map.distance(center, northEast);
    return Math.max(10, Math.min(250, Math.ceil((meters / 1852) * 1.08)));
  }

  async function fetchAircraft({force = false} = {}) {
    if (loading && !force) return;
    loading = true;
    try {
      const center = map.getCenter();
      const radius = radiusForMap();
      const url = `/api/aircraft?lat=${center.lat.toFixed(5)}&lon=${center.lng.toFixed(5)}&radius=${radius}`;
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const items = Array.isArray(data.ac) ? data.ac : (Array.isArray(data.aircraft) ? data.aircraft : []);
      updateMarkers(items);
      ui.lastUpdate.textContent = `обновлено ${new Date().toLocaleTimeString('ru-RU')} · радиус ${radius} NM`;
    } catch (err) {
      ui.lastUpdate.textContent = 'ошибка получения данных';
      showToast(`Не удалось получить ADS-B данные: ${err.message}`, 4200);
    } finally {
      loading = false;
    }
  }

  async function searchAircraft(query) {
    const q = query.trim();
    if (!q) return;
    ui.searchInput.disabled = true;
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const items = Array.isArray(data.ac) ? data.ac : [];
      if (!items.length) {
        showToast(`По запросу «${q}» активный борт не найден.`);
        return;
      }
      const ac = items.find(x => num(x.lat) !== null && num(x.lon) !== null) || items[0];
      const hex = aircraftKey(ac);
      if (hex) aircraftByHex.set(hex, ac);
      if (num(ac.lat) !== null && num(ac.lon) !== null) {
        map.setView([ac.lat, ac.lon], Math.max(map.getZoom(), 8));
        await fetchAircraft({ force: true });
      }
      if (hex) await selectAircraft(hex, true);
      if (items.length > 1) showToast(`Найдено ${items.length} совпадений; показан первый активный борт.`);
    } catch (err) {
      showToast(`Ошибка поиска: ${err.message}`);
    } finally {
      ui.searchInput.disabled = false;
      ui.searchInput.focus();
    }
  }

  ui.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    searchAircraft(ui.searchInput.value);
  });

  ui.refreshBtn.addEventListener('click', () => fetchAircraft({ force: true }));
  ui.closeDetails.addEventListener('click', () => {
    selectedHex = null;
    ui.details.classList.add('hidden');
    for (const [key, marker] of markers.entries()) {
      const item = aircraftByHex.get(key);
      if (item) marker.setIcon(makeIcon(item, false));
    }
    drawSelectedTrack();
  });

  ui.locateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) return showToast('Геолокация не поддерживается браузером.');
    navigator.geolocation.getCurrentPosition(
      pos => map.setView([pos.coords.latitude, pos.coords.longitude], 8),
      () => showToast('Браузер не дал доступ к геопозиции.')
    );
  });

  for (const el of [ui.airborneOnly, ui.militaryOnly, ui.emergencyOnly]) {
    el.addEventListener('change', () => updateMarkers([...aircraftByHex.values()]));
  }
  ui.minAltitude.addEventListener('input', () => {
    ui.minAltLabel.textContent = Number(ui.minAltitude.value).toLocaleString('ru-RU');
    updateMarkers([...aircraftByHex.values()]);
  });

  let moveDebounce = null;
  map.on('moveend zoomend', () => {
    clearTimeout(moveDebounce);
    moveDebounce = setTimeout(() => fetchAircraft({ force: true }), 280);
  });

  function startRefreshLoop() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(fetchAircraft, REFRESH_MS);
  }

  fetchAircraft({ force: true });
  startRefreshLoop();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    } else {
      fetchAircraft({ force: true });
      startRefreshLoop();
    }
  });

  window.addEventListener('beforeunload', () => clearInterval(refreshTimer));
})();
