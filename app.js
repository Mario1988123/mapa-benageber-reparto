(function () {
  'use strict';

  const NAME_KEY = 'benageber_nombre';
  const PENDING_COLOR = '#94a3b8';
  const DONE_COLOR = '#2563eb';

  const state = new Map(); // calle_id -> { nombre, completada, completada_por, completada_en }
  const layerById = new Map(); // calle_id -> leaflet layer

  let map, sb, channel, geoLayer;
  let watchId = null;
  let trackPolyline = null;
  let meMarker = null;
  let accuracyCircle = null;

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
      'Calles: © colaboradores de OpenStreetMap'
    ).addTo(map);

    const b = geojson.bbox; // [minLon,minLat,maxLon,maxLat]
    map.fitBounds([
      [b[1], b[0]],
      [b[3], b[2]],
    ], { padding: [20, 20] });

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

  function updateLabelVisibility() {
    const show = map.getZoom() >= 16;
    layerById.forEach((layer) => {
      const tooltip = layer.getTooltip();
      if (!tooltip) return;
      if (show) layer.openTooltip(); else layer.closeTooltip();
    });
  }

  function styleForState(s) {
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
    const meta = done
      ? `Completada por <b>${escapeHtml(s.completada_por || '—')}</b><br>${s.completada_en ? new Date(s.completada_en).toLocaleString('es-ES') : ''}`
      : `${s.segmentos || ''} tramo(s) sin repartir`;
    const html = `
      <div class="street-popup">
        <h3>${escapeHtml(s.nombre || '')}</h3>
        <div class="meta">${meta}</div>
        <button class="${done ? 'undo' : ''}" data-id="${id}">${done ? 'Desmarcar' : 'Marcar como completada'}</button>
      </div>`;
    layer.bindPopup(html, { className: 'street-popup', maxWidth: 260 }).openPopup();
    setTimeout(() => {
      const btn = document.querySelector(`.street-popup button[data-id="${CSS.escape(id)}"]`);
      if (btn) btn.addEventListener('click', () => toggleStreet(id));
    }, 0);
  }

  async function toggleStreet(id) {
    const s = state.get(id) || {};
    const newDone = !s.completada;
    const nombre = getName();
    // Optimista: pintar ya
    state.set(id, { ...s, completada: newDone, completada_por: newDone ? nombre : null, completada_en: newDone ? new Date().toISOString() : null });
    applyLayerStyle(id);
    refreshListItem(id);
    updateProgress();
    map.closePopup();

    const { error } = await sb.from('calles_estado').update({
      completada: newDone,
      completada_por: newDone ? nombre : null,
      completada_en: newDone ? new Date().toISOString() : null,
    }).eq('calle_id', id);

    if (error) {
      showToast('No se pudo guardar. Revisa tu conexión.');
      // revertir
      state.set(id, s);
      applyLayerStyle(id);
      refreshListItem(id);
      updateProgress();
    } else {
      showToast(newDone ? '✔ Calle marcada' : 'Calle desmarcada');
    }
  }

  // ---------- Supabase ----------
  async function initSupabase(geojson) {
    sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

    const { data, error } = await sb.from('calles_estado').select('*');
    if (error) {
      showToast('Sin conexión al servidor compartido. Podrás ver el mapa pero no sincronizar.');
    }
    const segCount = {};
    geojson.features.forEach((f) => { segCount[f.properties.id] = f.properties.segments; });

    (data || []).forEach((row) => {
      state.set(row.calle_id, {
        nombre: row.nombre,
        completada: row.completada,
        completada_por: row.completada_por,
        completada_en: row.completada_en,
        segmentos: segCount[row.calle_id],
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
          segmentos: prev.segmentos,
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
    const done = Array.from(state.values()).filter((s) => s.completada).length;
    document.getElementById('progressText').textContent = `${done} / ${total} calles`;
    document.getElementById('progressFill').style.width = total ? `${(done / total) * 100}%` : '0%';
  }

  // ---------- Panel lateral ----------
  function buildStreetList() {
    const ul = document.getElementById('streetList');
    ul.innerHTML = '';
    const names = Array.from(state.entries()).sort((a, b) => a[1].nombre.localeCompare(b[1].nombre, 'es'));
    names.forEach(([id, s]) => {
      const li = document.createElement('li');
      li.dataset.id = id;
      li.className = s.completada ? 'done' : '';
      li.innerHTML = `<span class="dot"></span><span class="name">${escapeHtml(s.nombre)}</span><span class="segs">${s.segmentos || ''}</span>`;
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

  function refreshListItem(id) {
    const li = document.querySelector(`#streetList li[data-id="${CSS.escape(id)}"]`);
    if (!li) return;
    const s = state.get(id);
    li.className = s.completada ? 'done' : '';
  }

  function applyFilters() {
    const q = document.getElementById('search').value.trim().toLowerCase();
    const filtro = document.querySelector('input[name="filtro"]:checked').value;
    document.querySelectorAll('#streetList li').forEach((li) => {
      const id = li.dataset.id;
      const s = state.get(id);
      const matchesText = !q || s.nombre.toLowerCase().includes(q);
      const matchesFilter = filtro === 'todas' || (filtro === 'hechas' && s.completada) || (filtro === 'pendientes' && !s.completada);
      li.style.display = matchesText && matchesFilter ? '' : 'none';
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
    document.getElementById('btnClosePanel').addEventListener('click', closePanel);
    document.getElementById('panelOverlay').addEventListener('click', closePanel);
    document.getElementById('search').addEventListener('input', applyFilters);
    document.querySelectorAll('input[name="filtro"]').forEach((r) => r.addEventListener('change', applyFilters));
    document.getElementById('btnLocate').addEventListener('click', toggleTracking);
    document.getElementById('btnUser').addEventListener('click', () => {
      document.getElementById('nameInput').value = getName() === 'Alguien' ? '' : getName();
      document.getElementById('nameModal').classList.remove('hidden');
    });
    document.getElementById('btnSaveName').addEventListener('click', saveName);
    document.getElementById('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });
  }

  // ---------- Arranque ----------
  async function main() {
    wireUi();
    ensureName();
    const res = await fetch('streets.geojson');
    const geojson = await res.json();
    initMap(geojson);
    await initSupabase(geojson);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  main();
})();
