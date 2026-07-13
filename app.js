(function () {
  'use strict';

  const NAME_KEY = 'benageber_nombre';
  const PENDING_COLOR = '#94a3b8';
  const DONE_COLOR = '#16a34a';
  const PARTIAL_COLOR = '#f59e0b';

  const state = new Map(); // calle_id -> { nombre, completada, completada_por, completada_en, notas }
  const layerById = new Map(); // calle_id -> leaflet layer

  let map, sb, channel, geoLayer;
  let watchId = null;
  let trackPolyline = null;
  let meMarker = null;
  let accuracyCircle = null;
  let zones = [];
  let lastPos = null; // {lat, lon} del último fix GPS conocido
  let nearMeMode = false;
  let pendingConfirmId = null;

  const IGN_PNOA_URL = 'https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&layer=OI.OrthoimageCoverage&style=default&tilematrixset=GoogleMapsCompatible&tilematrix={z}&tilerow={y}&tilecol={x}&format=image/jpeg';

  // ---------- Mapa ----------
  function initMap(geojson) {
    map = L.map('map', {
      zoomControl: false,
      minZoom: 12,
      maxZoom: 20,
      attributionControl: false,
      doubleClickZoom: false,
    });
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    L.control.attribution({ prefix: false }).addAttribution(
      'Calles: © colaboradores de OpenStreetMap · Satélite: © Instituto Geográfico Nacional (PNOA)'
    ).addTo(map);

    const esquematico = L.layerGroup();
    const satelite = L.tileLayer(IGN_PNOA_URL, {
      maxZoom: 20,
      maxNativeZoom: 19,
      attribution: 'PNOA © Instituto Geográfico Nacional de España',
    });
    esquematico.addTo(map);
    L.control.layers({ 'Esquemático': esquematico, 'Satélite': satelite }, null, { position: 'bottomleft', collapsed: true }).addTo(map);

    const b = geojson.bbox; // [minLon,minLat,maxLon,maxLat]
    map.fitBounds([
      [b[1], b[0]],
      [b[3], b[2]],
    ], { padding: [20, 20] });

    renderZones();

    geoLayer = L.geoJSON(geojson, {
      style: () => ({ color: PENDING_COLOR, weight: 4, opacity: 0.9, lineCap: 'round' }),
      onEachFeature: (feature, layer) => {
        const id = feature.properties.id;
        layerById.set(id, layer);
        layer.bindTooltip(feature.properties.name, {
          className: 'street-tooltip', direction: 'center', permanent: false, sticky: true,
        });
        layer.on('click', () => openStreetPopup(id, layer));
      },
    }).addTo(map);

    map.on('zoomend', updateLabelVisibility);
    updateLabelVisibility();
  }

  function renderZones() {
    const legend = document.getElementById('legend');
    legend.innerHTML = '';
    zones.forEach((z) => {
      L.circle([z.anchor[1], z.anchor[0]], {
        radius: z.radiusMeters,
        color: z.color,
        weight: 1,
        opacity: 0.55,
        fillColor: z.color,
        fillOpacity: 0.22,
        interactive: false,
      }).addTo(map);

      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = `<span class="sw" style="background:${z.color}"></span><span>${escapeHtml(z.nombre)}</span>`;
      item.addEventListener('click', () => {
        map.setView([z.anchor[1], z.anchor[0]], 16);
      });
      legend.appendChild(item);

      const opt = document.createElement('option');
      opt.value = z.id;
      opt.textContent = z.nombre;
      document.getElementById('zoneFilter').appendChild(opt);
    });
  }

  function updateLabelVisibility() {
    const show = map.getZoom() >= 16;
    layerById.forEach((layer) => {
      const tooltip = layer.getTooltip();
      if (!tooltip) return;
      if (show) layer.openTooltip(); else layer.closeTooltip();
    });
  }

  function styleForState(s) {
    if (s && s.completada && s.notas) return { color: PARTIAL_COLOR, weight: 5, opacity: 0.95, dashArray: '6,4' };
    if (s && s.completada) return { color: DONE_COLOR, weight: 5, opacity: 0.95 };
    return { color: PENDING_COLOR, weight: 4, opacity: 0.9 };
  }

  function applyLayerStyle(id) {
    const layer = layerById.get(id);
    if (layer) layer.setStyle(styleForState(state.get(id)));
  }

  function openStreetPopup(id, layer) {
    const s = state.get(id) || {};
    const done = !!s.completada;
    let meta;
    if (done && s.notas) {
      meta = `Completada por <b>${escapeHtml(s.completada_por || '—')}</b> · ${s.completada_en ? new Date(s.completada_en).toLocaleString('es-ES') : ''}<br><b>⚠️ Faltan:</b> ${escapeHtml(s.notas)}`;
    } else if (done) {
      meta = `Completada por <b>${escapeHtml(s.completada_por || '—')}</b><br>${s.completada_en ? new Date(s.completada_en).toLocaleString('es-ES') : ''}`;
    } else {
      meta = `${s.segmentos || ''} tramo(s) sin repartir`;
    }
    const html = `
      <div class="street-popup">
        <h3>${escapeHtml(s.nombre || '')}</h3>
        <div class="meta">${meta}</div>
        <button class="${done ? 'undo' : ''}" data-action="${done ? 'undo' : 'confirm'}" data-id="${id}">${done ? 'Desmarcar' : 'Marcar como completada'}</button>
      </div>`;
    layer.bindPopup(html, { className: 'street-popup', maxWidth: 260 }).openPopup();
    setTimeout(() => {
      const btn = document.querySelector(`.street-popup button[data-id="${CSS.escape(id)}"]`);
      if (!btn) return;
      btn.addEventListener('click', () => {
        map.closePopup();
        if (btn.dataset.action === 'undo') {
          setStreetState(id, { completada: false, notas: null });
        } else {
          openCompletionConfirm(id);
        }
      });
    }, 0);
  }

  // ---------- Confirmación de calle completada (estilo "app") ----------
  function openCompletionConfirm(id) {
    const s = state.get(id) || {};
    pendingConfirmId = id;
    document.getElementById('confirmTitle').textContent = `¿"${s.nombre}" repartida entera?`;
    document.getElementById('confirmSubtitle').textContent = 'Confirma antes de marcarla, para que el resto del equipo sepa si queda algo pendiente.';
    document.getElementById('confirmMissingWrap').classList.add('hidden');
    document.getElementById('confirmMissingInput').value = '';
    document.getElementById('btnConfirmPartial').textContent = '⚠️ Faltan algunos números';
    document.getElementById('btnConfirmPartial').dataset.stage = 'ask';
    document.getElementById('confirmModal').classList.remove('hidden');
  }

  function closeConfirmModal() {
    document.getElementById('confirmModal').classList.add('hidden');
    pendingConfirmId = null;
  }

  async function setStreetState(id, { completada, notas }) {
    const s = state.get(id) || {};
    const nombre = getName();
    const patch = {
      completada,
      completada_por: completada ? nombre : null,
      completada_en: completada ? new Date().toISOString() : null,
      notas: completada ? (notas || null) : null,
    };
    // Optimista: pintar ya
    state.set(id, { ...s, ...patch });
    applyLayerStyle(id);
    refreshListItem(id);
    updateProgress();

    const { error } = await sb.from('calles_estado').update(patch).eq('calle_id', id);

    if (error) {
      showToast('No se pudo guardar. Revisa tu conexión.');
      state.set(id, s);
      applyLayerStyle(id);
      refreshListItem(id);
      updateProgress();
    } else if (completada && notas) {
      showToast(`⚠️ "${s.nombre}" marcada — faltan: ${notas}`);
    } else if (completada) {
      showToast(`✅ ¡"${s.nombre}" repartida entera!`);
    } else {
      showToast(`"${s.nombre}" desmarcada`);
    }
  }

  // ---------- Supabase ----------
  async function initSupabase(geojson) {
    sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

    const { data, error } = await sb.from('calles_estado').select('*');
    if (error) {
      showToast('Sin conexión al servidor compartido. Podrás ver el mapa pero no sincronizar.');
    }
    const segCount = {}, zoneById = {};
    geojson.features.forEach((f) => {
      segCount[f.properties.id] = f.properties.segments;
      zoneById[f.properties.id] = f.properties.zone;
    });

    (data || []).forEach((row) => {
      state.set(row.calle_id, {
        nombre: row.nombre,
        completada: row.completada,
        completada_por: row.completada_por,
        completada_en: row.completada_en,
        notas: row.notas,
        segmentos: segCount[row.calle_id],
        zone: zoneById[row.calle_id],
      });
    });

    layerById.forEach((_, id) => applyLayerStyle(id));
    updateProgress();
    buildStreetList();

    channel = sb.channel('calles_estado_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calles_estado' }, (payload) => {
        const row = payload.new;
        if (!row) return;
        const prev = state.get(row.calle_id) || {};
        state.set(row.calle_id, {
          nombre: row.nombre,
          completada: row.completada,
          completada_por: row.completada_por,
          completada_en: row.completada_en,
          notas: row.notas,
          segmentos: prev.segmentos,
          zone: prev.zone,
        });
        applyLayerStyle(row.calle_id);
        refreshListItem(row.calle_id);
        updateProgress();
      })
      .subscribe();
  }

  // ---------- Progreso ----------
  function updateProgress() {
    const total = state.size;
    const all = Array.from(state.values());
    const done = all.filter((s) => s.completada).length;
    const partial = all.filter((s) => s.completada && s.notas).length;
    document.getElementById('progressText').textContent = partial
      ? `${done} / ${total} calles (${partial} con números pendientes)`
      : `${done} / ${total} calles`;
    document.getElementById('progressFill').style.width = total ? `${(done / total) * 100}%` : '0%';
  }

  // ---------- Panel lateral ----------
  function buildStreetList() {
    const ul = document.getElementById('streetList');
    ul.innerHTML = '';
    let entries = Array.from(state.entries());
    let distances = null;
    if (nearMeMode && lastPos) {
      distances = new Map();
      entries.forEach(([id]) => {
        const layer = layerById.get(id);
        distances.set(id, layer ? distanceMetersToLayer(layer, lastPos) : Infinity);
      });
      entries.sort((a, b) => distances.get(a[0]) - distances.get(b[0]));
    } else {
      entries.sort((a, b) => a[1].nombre.localeCompare(b[1].nombre, 'es'));
    }
    entries.forEach(([id, s]) => {
      const li = document.createElement('li');
      li.dataset.id = id;
      li.dataset.zone = s.zone || '';
      li.className = classForState(s);
      const distHtml = distances ? `<span class="dist">${formatDistance(distances.get(id))}</span>` : `<span class="segs">${s.segmentos || ''}</span>`;
      li.innerHTML = `<span class="dot"></span><span class="name">${escapeHtml(s.nombre)}</span>${distHtml}`;
      li.addEventListener('click', () => {
        const layer = layerById.get(id);
        if (layer) {
          map.fitBounds(layer.getBounds(), { maxZoom: 18, padding: [40, 40] });
          openStreetPopup(id, layer);
        }
        closePanel();
      });
      ul.appendChild(li);
    });
    applyFilters();
  }

  function formatDistance(m) {
    if (!isFinite(m)) return '';
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }

  function distanceMetersToLayer(layer, pos) {
    let min = Infinity;
    const latlngs = layer.getLatLngs();
    const walk = (arr) => {
      if (Array.isArray(arr[0])) { arr.forEach(walk); return; }
      arr.forEach((ll) => {
        const d = haversineMeters(pos.lat, pos.lon, ll.lat, ll.lng);
        if (d < min) min = d;
      });
    };
    walk(latlngs);
    return min;
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function classForState(s) {
    if (s.completada && s.notas) return 'partial';
    if (s.completada) return 'done';
    return '';
  }

  function refreshListItem(id) {
    const li = document.querySelector(`#streetList li[data-id="${CSS.escape(id)}"]`);
    if (!li) return;
    const s = state.get(id);
    li.className = classForState(s);
  }

  function applyFilters() {
    const q = document.getElementById('search').value.trim().toLowerCase();
    const filtro = document.querySelector('input[name="filtro"]:checked').value;
    const zona = document.getElementById('zoneFilter').value;
    document.querySelectorAll('#streetList li').forEach((li) => {
      const id = li.dataset.id;
      const s = state.get(id);
      const matchesText = !q || s.nombre.toLowerCase().includes(q);
      const matchesFilter = filtro === 'todas' || (filtro === 'hechas' && s.completada) || (filtro === 'pendientes' && !s.completada);
      const matchesZone = !zona || li.dataset.zone === zona;
      li.style.display = matchesText && matchesFilter && matchesZone ? '' : 'none';
    });
  }

  function openPanel() {
    document.getElementById('panel').classList.add('open');
    document.getElementById('panelOverlay').classList.add('show');
  }
  function closePanel() {
    document.getElementById('panel').classList.remove('open');
    document.getElementById('panelOverlay').classList.remove('show');
  }

  // ---------- Geolocalización + recorrido ----------
  function toggleTracking() {
    const btn = document.getElementById('btnLocate');
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      btn.classList.remove('active');
      showToast('Seguimiento de ubicación detenido');
      return;
    }
    if (!navigator.geolocation) {
      showToast('Este dispositivo no soporta geolocalización');
      return;
    }
    btn.classList.add('active');
    let first = true;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const latlng = [latitude, longitude];
        lastPos = { lat: latitude, lon: longitude };
        if (nearMeMode) buildStreetList();

        if (!meMarker) {
          meMarker = L.marker(latlng, {
            icon: L.divIcon({ className: 'me-pulse', iconSize: [16, 16] }),
          }).addTo(map);
        } else {
          meMarker.setLatLng(latlng);
        }

        if (!accuracyCircle) {
          accuracyCircle = L.circle(latlng, { radius: accuracy, color: '#2563eb', weight: 1, fillOpacity: 0.08 }).addTo(map);
        } else {
          accuracyCircle.setLatLng(latlng).setRadius(accuracy);
        }

        if (!trackPolyline) {
          trackPolyline = L.polyline([latlng], { color: '#ef4444', weight: 3, opacity: 0.8, dashArray: '1,8', lineCap: 'round' }).addTo(map);
        } else {
          trackPolyline.addLatLng(latlng);
        }

        if (first) {
          map.setView(latlng, 18);
          first = false;
        }
      },
      (err) => {
        showToast('No se pudo acceder al GPS: ' + err.message);
        btn.classList.remove('active');
        watchId = null;
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  }

  // ---------- Nombre de usuario ----------
  function getName() {
    return localStorage.getItem(NAME_KEY) || 'Alguien';
  }
  function ensureName() {
    const modal = document.getElementById('nameModal');
    const current = localStorage.getItem(NAME_KEY);
    if (!current) {
      modal.classList.remove('hidden');
      document.getElementById('nameInput').focus();
    }
  }
  function saveName() {
    const val = document.getElementById('nameInput').value.trim();
    if (!val) return;
    localStorage.setItem(NAME_KEY, val);
    document.getElementById('nameModal').classList.add('hidden');
  }

  // ---------- Utilidades ----------
  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Eventos UI ----------
  function wireUi() {
    document.getElementById('btnMenu').addEventListener('click', openPanel);
    document.getElementById('btnSearch').addEventListener('click', () => {
      openPanel();
      setTimeout(() => document.getElementById('search').focus(), 250);
    });
    document.getElementById('btnClosePanel').addEventListener('click', closePanel);
    document.getElementById('panelOverlay').addEventListener('click', closePanel);
    document.getElementById('search').addEventListener('input', applyFilters);
    document.getElementById('zoneFilter').addEventListener('change', applyFilters);
    document.querySelectorAll('input[name="filtro"]').forEach((r) => r.addEventListener('change', applyFilters));
    document.getElementById('btnLocate').addEventListener('click', toggleTracking);
    document.getElementById('btnUser').addEventListener('click', () => {
      document.getElementById('nameInput').value = getName() === 'Alguien' ? '' : getName();
      document.getElementById('nameModal').classList.remove('hidden');
    });
    document.getElementById('btnSaveName').addEventListener('click', saveName);
    document.getElementById('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });

    document.getElementById('btnNearMe').addEventListener('click', toggleNearMe);

    document.getElementById('btnConfirmAll').addEventListener('click', () => {
      const id = pendingConfirmId;
      closeConfirmModal();
      if (id) setStreetState(id, { completada: true, notas: null });
    });
    document.getElementById('btnConfirmPartial').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.stage !== 'submit') {
        document.getElementById('confirmMissingWrap').classList.remove('hidden');
        document.getElementById('confirmMissingInput').focus();
        btn.dataset.stage = 'submit';
        btn.textContent = '💾 Guardar y marcar';
        return;
      }
      const notas = document.getElementById('confirmMissingInput').value.trim();
      const id = pendingConfirmId;
      closeConfirmModal();
      if (id) setStreetState(id, { completada: true, notas: notas || 'algunos números' });
    });
    document.getElementById('btnConfirmCancel').addEventListener('click', closeConfirmModal);
  }

  function toggleNearMe() {
    const btn = document.getElementById('btnNearMe');
    if (nearMeMode) {
      nearMeMode = false;
      btn.classList.remove('active');
      btn.textContent = '📍 Ordenar por cercanía a mí';
      buildStreetList();
      return;
    }
    if (lastPos) {
      nearMeMode = true;
      btn.classList.add('active');
      btn.textContent = '📍 Ordenando por cercanía…';
      buildStreetList();
      return;
    }
    showToast('Obteniendo tu ubicación…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lastPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        nearMeMode = true;
        btn.classList.add('active');
        btn.textContent = '📍 Ordenando por cercanía…';
        buildStreetList();
      },
      (err) => showToast('No se pudo obtener tu ubicación: ' + err.message),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  // ---------- Arranque ----------
  async function main() {
    wireUi();
    ensureName();
    const [geojson, zonesData] = await Promise.all([
      fetch('streets.geojson').then((r) => r.json()),
      fetch('zones.json').then((r) => r.json()).catch(() => []),
    ]);
    zones = zonesData;
    initMap(geojson);
    await initSupabase(geojson);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  main();
})();
