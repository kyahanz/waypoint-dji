// Prototipe perencana survei — UI peta + perhitungan jalur + export KMZ.
// Semua hitungan memakai modul yang sama dengan CLI (src/survey.js, src/wpml.js),
// jadi apa yang terlihat di layar = apa yang masuk ke file.
import {
  makeProjector,
  polygonArea,
  centroid,
  computeSurveyParams,
  generateGrid,
  offsetPolygon,
  pathLengthXY,
  missionDuration,
  splitByBattery,
  sortieSummary,
  maxDistanceFrom,
} from '../src/survey.js';
import { buildKmz, downloadBlob } from './kmz.js';
import { fetchElevations, cachedElevation, missingCoords, reliefOf } from '../src/terrain.js';
import {
  tileUrls,
  countTiles,
  downloadTiles,
  cacheStatus,
  clearTiles,
  offlineSupported,
} from './offline.js';
import { createPolygonEditor } from './draw.js';
import {
  listProjects,
  saveProject,
  loadProject,
  deleteProject,
  geocode,
  parseCoords,
  getSettings,
  setSettings,
} from './store.js';

const CENTER = [107.11993938381485, -6.2549323363466];
const BATTERY_COLORS = ['#4da3ff', '#55c57a', '#f0b429', '#f27272', '#b98cf5', '#52d3d8'];
const EMPTY = { type: 'FeatureCollection', features: [] };

const state = {
  profile: null,
  polygon: [],
  home: null, // [lng, lat]
  mode: 'continuous',
  plan: null,
  currentProjectId: null,
  showLabels: false,
  homePinned: false, // true setelah pengguna menggeser penanda H sendiri
  terrain: false,
  terrainLoading: false,
  terrainError: null,
};

// ---------- Peta ----------

// Registry sumber citra. `maxzoom` penting: kalau dilewati, penyedia
// mengembalikan tile kosong bertuliskan "Map data not yet available" alih-alih
// gambar. Dengan batas yang benar, MapLibre memperbesar tile terakhir yang ada.
const IMAGERY = {
  esri: {
    label: 'Esri World Imagery',
    note: 'Tanpa kunci. Mentok di zoom 19 untuk sebagian besar Indonesia.',
    maxzoom: 19,
    tiles: () => [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: 'Citra: Esri, Maxar, Earthstar Geographics',
  },
  mapbox: {
    label: 'Mapbox Satellite',
    note: 'Sampai zoom 22, citra sering lebih baru. Perlu token gratis dari mapbox.com.',
    keyLabel: 'Token Mapbox (pk.…)',
    maxzoom: 22,
    tiles: (k) => [
      `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${encodeURIComponent(k)}`,
    ],
    attribution: '© Mapbox © Maxar',
  },
  maptiler: {
    label: 'MapTiler Satellite',
    note: 'Sampai zoom 20. Perlu API key gratis dari maptiler.com.',
    keyLabel: 'API key MapTiler',
    maxzoom: 20,
    tiles: (k) => [
      `https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${encodeURIComponent(k)}`,
    ],
    attribution: '© MapTiler © Maxar',
  },
};

const STREET = {
  maxzoom: 19,
  tiles: () => ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  attribution: '© Kontributor OpenStreetMap',
};

const LABELS = {
  maxzoom: 19,
  tiles: () => [
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  ],
  attribution: 'Label: Esri',
};

let settings = getSettings();
let baseKind = 'sat'; // 'sat' | 'street'

const activeImagery = () => (IMAGERY[settings.imagery] ? settings.imagery : 'esri');

const map = new maplibregl.Map({
  container: 'map',
  center: CENTER,
  zoom: 16.5,
  maxZoom: 22,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      // maxzoom dibatasi 19 karena di atas itu Esri/OSM mengembalikan tile
      // "Map data not yet available" untuk sebagian besar wilayah. Dengan
      // batas ini MapLibre memperbesar tile z19 — buram sedikit, tapi tetap
      // ada gambarnya saat kita perlu menaruh titik dengan presisi.
      base: {
        type: 'raster',
        tileSize: 256,
        maxzoom: IMAGERY.esri.maxzoom,
        tiles: IMAGERY.esri.tiles(),
        attribution: IMAGERY.esri.attribution,
      },
      labels: {
        type: 'raster',
        tileSize: 256,
        maxzoom: LABELS.maxzoom,
        tiles: LABELS.tiles(),
        attribution: LABELS.attribution,
      },
    },
    layers: [
      { id: 'base', type: 'raster', source: 'base' },
      {
        id: 'labels',
        type: 'raster',
        source: 'labels',
        layout: { visibility: 'none' },
      },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
map.doubleClickZoom.disable();

let editor = null;
let homeMarker = null;

// Peta siap dipasangi sumber dan layer begitu style-nya termuat. Sengaja
// tidak menunggu event 'load', karena 'load' baru menyala setelah render
// pertama — dan render tidak pernah terjadi di tab latar atau pane yang
// tersembunyi, sehingga aplikasi macet di keadaan "memuat" tanpa sebab jelas.
let mapInit = false;
const initMap = () => {
  if (mapInit) return;
  mapInit = true;

  map.addSource('aoi', { type: 'geojson', data: EMPTY });
  map.addSource('buffer', { type: 'geojson', data: EMPTY });
  map.addSource('route', { type: 'geojson', data: EMPTY });
  map.addSource('wp', { type: 'geojson', data: EMPTY });

  map.addLayer({
    id: 'aoi-fill',
    type: 'fill',
    source: 'aoi',
    paint: { 'fill-color': '#4da3ff', 'fill-opacity': 0.1 },
  });
  map.addLayer({
    id: 'aoi-line',
    type: 'line',
    source: 'aoi',
    paint: { 'line-color': '#4da3ff', 'line-width': 2, 'line-dasharray': [2, 1.5] },
  });
  map.addLayer({
    id: 'buffer-line',
    type: 'line',
    source: 'buffer',
    paint: {
      'line-color': '#8b98a8',
      'line-width': 1.2,
      'line-dasharray': [4, 3],
      'line-opacity': 0.75,
    },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.95 },
  });
  map.addLayer({
    id: 'wp-dot',
    type: 'circle',
    source: 'wp',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 1.8, 18, 3.5],
      'circle-color': '#ffffff',
      'circle-opacity': 0.9,
    },
  });

  // Editor memasang layer titik sudutnya sendiri, di atas layer jalur.
  editor = createPolygonEditor(map, {
    onChange: (poly, { drawing }) => {
      state.polygon = poly;
      syncDrawUi(drawing);
      render();
    },
  });
  editor.install();
  els.draw.disabled = false;
  els.demo.disabled = false;
  els.draw.textContent = DRAW_LABEL;
  els.drawHint.textContent =
    'Klik di peta untuk menaruh titik sudut lahan. Minimal 3 titik.';

  createHomeMarker();

  // Style awal selalu dibangun dengan Esri; kalau pengguna pernah memilih
  // penyedia lain, pasang di sini setelah layer lain siap.
  if (activeImagery() !== 'esri') applyBasemap();

  loadProfile();
  refreshProjectList();

  // Pegangan untuk inspeksi dari konsol saat mengembangkan prototipe.
  window.__wp = { map, editor, state };
};

map.on('style.load', initMap);
map.on('load', initMap);

function createHomeMarker() {
  const el = document.createElement('div');
  el.className = 'home-marker';
  el.textContent = 'H';
  el.title = 'Titik lepas landas — geser untuk memindahkan';

  homeMarker = new maplibregl.Marker({
    element: el,
    draggable: true,
    anchor: 'center',
  }).setLngLat(CENTER);

  if (!settings.hideHome) homeMarker.addTo(map);

  homeMarker.on('dragend', () => {
    const { lng, lat } = homeMarker.getLngLat();
    state.home = [lng, lat];
    state.homePinned = true; // mulai sekarang jangan diikutkan ke lahan lagi
    render();
  });

  state.home = CENTER.slice();
}

// ---------- Profil drone ----------

async function loadProfile() {
  // no-store: saat mengembangkan, profil sering diubah dan cache browser
  // membuat perubahannya tidak kelihatan sampai hard reload.
  const res = await fetch('../profiles/mini5pro.json', { cache: 'no-store' });
  state.profile = await res.json();
  // Rencana yang datang lewat URL dipulihkan dulu; kalau tidak ada, render biasa.
  if (!applyStateFromUrl()) render();
}

// ---------- Elemen ----------

const $ = (id) => document.getElementById(id);
const els = {
  draw: $('btn-draw'),
  undo: $('btn-undo'),
  clear: $('btn-clear'),
  demo: $('btn-demo'),
  export: $('btn-export'),
  geojson: $('btn-geojson'),
  handoff: $('btn-handoff'),
  redo: $('btn-redo'),
  autoAngle: $('btn-auto-angle'),
  gsd: $('gsd'),
  front: $('front'),
  side: $('side'),
  angle: $('angle'),
  buffer: $('buffer'),
  terrain: $('terrain'),
  terrainReadout: $('terrain-readout'),
  terrainStatus: $('terrain-status'),
  terrainRelief: $('terrain-relief'),
  flown: $('flown-readout'),
  flownVal: $('flown-val'),
  offlineBody: $('offline-body'),
  offlineUnsupported: $('offline-unsupported'),
  offlineWhy: $('offline-why'),
  offlineBadge: $('offline-badge'),
  tileCount: $('tile-count'),
  tileCached: $('tile-cached'),
  dlProgress: $('dl-progress'),
  dlBar: $('dl-bar'),
  download: $('btn-download'),
  clearTiles: $('btn-clear-tiles'),
  bufferOut: $('buffer-out'),
  bufferM: $('buffer-m'),
  gsdOut: $('gsd-out'),
  frontOut: $('front-out'),
  sideOut: $('side-out'),
  angleOut: $('angle-out'),
  altDerived: $('alt-derived'),
  area: $('area-readout'),
  areaVal: $('area-val'),
  homeReadout: $('home-readout'),
  homeVal: $('home-val'),
  resetHome: $('btn-reset-home'),
  toggleHome: $('btn-toggle-home'),
  helpHome: $('help-home'),
  stats: $('stats'),
  sorties: $('sorties'),
  warnings: $('warnings'),
  legend: $('legend'),
  badge: $('map-badge'),
  badgeText: $('badge-text'),
  drawHint: $('draw-hint'),
  modeHint: $('mode-hint'),
  search: $('search'),
  searchResults: $('search-results'),
  locate: $('btn-locate'),
  projName: $('proj-name'),
  save: $('btn-save'),
  projList: $('proj-list'),
  sheet: $('panel'),
  sheetHandle: $('sheet-handle'),
  sheetSummary: $('sheet-summary'),
  toasts: $('toasts'),
  modal: $('handoff'),
  qr: $('qr'),
  handoffUrl: $('handoff-url'),
  handoffNote: $('handoff-note'),
};

// ---------- Toast ----------

function toast(text, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="ic">${kind === 'ok' ? '✓' : kind === 'err' ? '!' : 'i'}</span><span></span>`;
  el.lastElementChild.textContent = text;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

// Kontrol area bergantung pada editor, yang baru ada setelah peta selesai
// dimuat. Tanpa dijaga, klik cepat pada muat dingin melempar TypeError diam-diam.
//
// Tapi tombol mati tanpa penjelasan juga terasa seperti aplikasi rusak, jadi
// keadaan memuat dibuat kelihatan — bukan sekadar tidak bisa diklik.
const DRAW_LABEL = els.draw.textContent;
els.draw.disabled = true;
els.demo.disabled = true;
els.draw.textContent = 'Memuat peta…';
els.drawHint.textContent = 'Menyiapkan peta…';

els.draw.onclick = () => (editor.isDrawing() ? editor.finish() : editor.start());
els.undo.onclick = () => editor.undo();
els.redo.onclick = () => editor.redo();
els.clear.onclick = () => {
  editor.clear();
  state.currentProjectId = null;
};
els.demo.onclick = loadDemoArea;
els.export.onclick = exportKmz;
els.geojson.onclick = exportGeoJson;
els.autoAngle.onclick = applyLongestEdgeAngle;
els.save.onclick = onSave;
els.handoff.onclick = openHandoff;
els.resetHome.onclick = () => {
  state.homePinned = false;
  render();
  toast('Titik lepas landas mengikuti tengah lahan lagi.', 'ok');
};

// Penanda H tidak ikut ke dalam file KMZ — dia cuma asumsi untuk menghitung
// transit, cadangan baterai, dan jarak VLOS. Jadi menyembunyikannya aman:
// perhitungan tetap jalan memakai tengah lahan.
els.toggleHome.onclick = () => {
  const hide = !settings.hideHome;
  settings = setSettings({ hideHome: hide });
  if (hide) {
    homeMarker.remove();
    state.homePinned = false; // sembunyi berarti kembali ke mode otomatis
  } else {
    homeMarker.addTo(map);
  }
  render();
  toast(
    hide
      ? 'Penanda disembunyikan. Hitungan tetap memakai tengah lahan.'
      : 'Penanda ditampilkan lagi.',
    'ok'
  );
};
$('btn-close-handoff').onclick = () => (els.modal.hidden = true);
els.modal.onclick = (e) => {
  if (e.target === els.modal) els.modal.hidden = true;
};
$('btn-copy-url').onclick = async () => {
  try {
    await navigator.clipboard.writeText(els.handoffUrl.value);
    toast('Link disalin.', 'ok');
  } catch {
    els.handoffUrl.select();
    toast('Tidak bisa menyalin otomatis — tekan Ctrl+C.', 'err');
  }
};
els.sheetHandle.onclick = () => {
  const collapsed = els.sheet.classList.toggle('collapsed');
  els.sheetHandle.setAttribute('aria-expanded', String(!collapsed));
};

for (const el of [els.gsd, els.front, els.side, els.angle, els.buffer]) {
  el.addEventListener('input', render);
}

els.terrain.onchange = () => {
  state.terrain = els.terrain.checked;
  state.terrainError = null;
  render();
};

document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    els.modeHint.textContent =
      state.mode === 'continuous'
        ? 'Drone menjepret tiap sekian meter tanpa berhenti. Lebih cepat.'
        : 'Drone berhenti di tiap titik foto. Lebih tajam, tapi jauh lebih lama dan boros baterai.';
    render();
  };
});

// Basemap
document.querySelectorAll('[data-base]').forEach((chip) => {
  chip.onclick = () => {
    document.querySelectorAll('[data-base]').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    baseKind = chip.dataset.base;
    applyBasemap();
  };
});

/**
 * Mengganti sumber tile lapisan dasar. Sumbernya dibuat ulang, bukan sekadar
 * setTiles(), karena `maxzoom` berbeda tiap penyedia dan itu tidak bisa diubah
 * pada sumber yang sudah terpasang.
 */
function applyBasemap() {
  const spec = baseKind === 'street' ? STREET : IMAGERY[activeImagery()];
  const key = baseKind === 'street' ? '' : (settings.keys?.[activeImagery()] ?? '');

  const after = map.getStyle().layers.find((l) => l.id !== 'base')?.id;
  if (map.getLayer('base')) map.removeLayer('base');
  if (map.getSource('base')) map.removeSource('base');

  map.addSource('base', {
    type: 'raster',
    tileSize: 256,
    maxzoom: spec.maxzoom,
    tiles: spec.tiles(key),
    attribution: spec.attribution,
  });
  map.addLayer({ id: 'base', type: 'raster', source: 'base' }, after);
}

// ---------- Pemilih sumber citra ----------

const elImagery = $('imagery');
$('chip-imagery').onclick = openImagery;
$('btn-close-imagery').onclick = () => (elImagery.hidden = true);
elImagery.onclick = (e) => {
  if (e.target === elImagery) elImagery.hidden = true;
};

function openImagery() {
  const current = activeImagery();
  const list = $('imagery-list');

  list.innerHTML = Object.entries(IMAGERY)
    .map(
      ([id, src]) => `
      <label class="imagery${id === current ? ' current' : ''}">
        <input type="radio" name="imagery" value="${id}"${id === current ? ' checked' : ''} />
        <span class="im-body">
          <span class="im-name">${src.label}</span>
          <span class="im-note">${src.note}</span>
          ${
            src.keyLabel
              ? `<input class="im-key" data-key="${id}" type="text" placeholder="${esc(src.keyLabel)}" value="${esc(settings.keys?.[id] ?? '')}" />`
              : ''
          }
        </span>
      </label>`
    )
    .join('');

  list.querySelectorAll('input[name="imagery"]').forEach((radio) => {
    radio.onchange = () => chooseImagery(radio.value);
  });

  list.querySelectorAll('.im-key').forEach((input) => {
    input.onclick = (e) => e.preventDefault(); // klik di kolom kunci jangan memilih radio
    input.onchange = () => {
      settings = setSettings({
        keys: { ...(settings.keys ?? {}), [input.dataset.key]: input.value.trim() },
      });
      if (activeImagery() === input.dataset.key) applyBasemap();
    };
  });

  elImagery.hidden = false;
}

function chooseImagery(id) {
  const src = IMAGERY[id];
  if (src.keyLabel && !(settings.keys?.[id] ?? '')) {
    toast(`${src.label} butuh kunci — isi dulu di kolom bawahnya.`, 'err', 6000);
    openImagery(); // kembalikan radio ke pilihan yang masih berlaku
    return;
  }
  settings = setSettings({ imagery: id });
  baseKind = 'sat';
  document.querySelectorAll('[data-base]').forEach((c) => {
    c.classList.toggle('active', c.dataset.base === 'sat');
  });
  applyBasemap();
  toast(`Citra: ${src.label}.`, 'ok');
}

// Kunci salah atau kuota habis membuat semua tile gagal sekaligus — cukup
// beri tahu sekali, jangan membanjiri layar dengan satu toast per tile.
let tileErrorAt = 0;
map.on('error', (e) => {
  const status = e?.error?.status;
  // Error tanpa status HTTP (masalah style, sumber, atau runtime peta) dulu
  // ditelan diam-diam di sini. Itu menyembunyikan kegagalan nyata, jadi
  // sekarang tetap dicatat meski tidak ditampilkan sebagai toast.
  if (!status) {
    console.error('[map]', e?.error ?? e);
    return;
  }
  if (status < 400 || Date.now() - tileErrorAt < 10000) return;
  tileErrorAt = Date.now();
  toast(
    status === 401 || status === 403
      ? 'Citra ditolak (kunci salah atau kuota habis). Balik ke Esri lewat tombol ⚙.'
      : `Tile gagal dimuat (${status}).`,
    'err',
    7000
  );
});

$('chip-labels').onclick = () => {
  state.showLabels = !state.showLabels;
  $('chip-labels').classList.toggle('active', state.showLabels);
  map.setLayoutProperty('labels', 'visibility', state.showLabels ? 'visible' : 'none');
};

// Keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'Escape' && editor?.isDrawing()) editor.finish();
  if (e.key === 'Enter' && editor?.isDrawing()) editor.finish();
  if (e.key === 'Escape' && !els.modal.hidden) els.modal.hidden = true;
  if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (e.shiftKey) editor?.redo();
    else editor?.undo();
  }
});

function syncDrawUi(drawing) {
  const n = state.polygon.length;
  els.draw.textContent = drawing ? 'Selesai' : n >= 3 ? 'Gambar ulang' : 'Mulai gambar';
  els.draw.classList.toggle('active', drawing);
  els.badge.classList.toggle('drawing', drawing);
  els.badgeText.textContent = drawing
    ? 'Klik untuk menaruh titik · klik dua kali atau Enter untuk selesai'
    : 'Mode lihat';
  els.drawHint.textContent = drawing
    ? 'Klik tiap sudut lahan. Klik dua kali di titik terakhir, atau tekan Enter.'
    : 'Klik di peta untuk menaruh titik sudut lahan. Minimal 3 titik.';
}

// ---------- Pencarian lokasi ----------

let searchTimer = null;

els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = els.search.value.trim();
  if (q.length < 3) return hideResults();

  const coords = parseCoords(q);
  if (coords) return showResults([coords]);

  searchTimer = setTimeout(async () => {
    try {
      showResults(await geocode(q));
    } catch (err) {
      showResults([], err.message);
    }
  }, 500);
});

els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideResults();
});

function showResults(items, error) {
  if (error) {
    els.searchResults.innerHTML = `<p class="placeholder small">${error}</p>`;
  } else if (!items.length) {
    els.searchResults.innerHTML = '<p class="placeholder small">Tidak ada hasil.</p>';
  } else {
    els.searchResults.innerHTML = items
      .map(
        (r, i) =>
          `<button class="result" data-i="${i}" title="${esc(r.name)}">${esc(r.name)}</button>`
      )
      .join('');
    els.searchResults.querySelectorAll('.result').forEach((btn) => {
      btn.onclick = () => {
        const r = items[Number(btn.dataset.i)];
        map.flyTo({ center: [r.lng, r.lat], zoom: 17, duration: 900 });
        hideResults();
        els.search.value = '';
      };
    });
  }
  els.searchResults.hidden = false;
}

function hideResults() {
  els.searchResults.hidden = true;
}

els.locate.onclick = () => {
  if (!navigator.geolocation) return;
  els.locate.classList.add('busy');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      els.locate.classList.remove('busy');
      map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 17 });
    },
    () => els.locate.classList.remove('busy'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

// ---------- Area ----------

function loadDemoArea() {
  const [lng0, lat0] = CENTER;
  const proj = makeProjector(lat0, lng0);
  editor.set(
    [
      [-150, -110],
      [160, -80],
      [130, 115],
      [-170, 95],
    ].map((p) => proj.toLL(p))
  );
  state.homePinned = false;
  map.fitBounds(bounds(state.polygon), { padding: 70, duration: 600 });
  render();
}

function bounds(coords) {
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}

function applyLongestEdgeAngle() {
  if (state.polygon.length < 3) return;
  const [lng0, lat0] = centroid(state.polygon);
  const proj = makeProjector(lat0, lng0);
  const xy = state.polygon.map(proj.toXY);

  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < xy.length; i++) {
    const a = xy[i];
    const b = xy[(i + 1) % xy.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > bestLen) {
      bestLen = len;
      best = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    }
  }
  els.angle.value = Math.round(((best % 180) + 180) % 180);
  render();
}

// ---------- Perencanaan ----------

function buildPlan() {
  const { profile, polygon, home } = state;
  if (!profile || polygon.length < 3) return null;

  const [lng0, lat0] = centroid(polygon);
  const proj = makeProjector(lat0, lng0);
  const polyXY = polygon.map(proj.toXY);
  const homeXY = proj.toXY(home ?? polygon[0]);
  const area = polygonArea(polyXY);

  const params = computeSurveyParams(profile.camera, {
    gsdCm: Number(els.gsd.value),
    frontOverlap: Number(els.front.value) / 100,
    sideOverlap: Number(els.side.value) / 100,
  });

  const mode = state.mode;
  const stopAtEach = mode === 'stopAndShoot';
  const accel = profile.limits.accelMs2 ?? 2.5;
  const speed = Math.min(
    stopAtEach ? profile.limits.maxSpeedMs : params.recommendedSpeed,
    profile.limits.maxSpeedMs
  );

  // Buffer dinyatakan dalam kelipatan jarak antar jalur, jadi nilainya ikut
  // menyesuaikan sendiri saat GSD atau overlap diubah.
  const bufferM = Number(els.buffer.value) * params.sideSpacing;
  const gridPoly = offsetPolygon(polyXY, bufferM);

  const grid = generateGrid(gridPoly, {
    angleDeg: Number(els.angle.value),
    sideSpacing: params.sideSpacing,
    frontSpacing: params.frontSpacing,
    mode,
    // Poligon yang sudah dibuffer sudah memberi ruang ancang-ancang; overshoot
    // hanya dipakai kalau buffer dimatikan, supaya jalur tidak dobel memanjang.
    overshoot: bufferM > 0 ? 0 : mode === 'continuous' ? params.frontSpacing : 0,
  });

  if (!grid.waypoints.length) return null;

  const hoverPerPhoto = stopAtEach ? 2.5 : 0;
  const maxDist = maxDistanceFrom(homeXY, grid.waypoints);

  // Cadangan baterai harus menutup transit pergi-pulang ke titik terjauh,
  // bukan angka tetap: di lahan besar, transit saja bisa beberapa menit.
  const transitReserveSec = (2 * maxDist) / speed + 60;

  const sorties = splitByBattery(grid.waypoints, {
    speed,
    accel,
    stopAtEach,
    usableFlightMin: profile.limits.usableFlightMin,
    hoverPerPhotoSec: hoverPerPhoto,
    transitReserveSec,
  });

  // ---- Terrain following ----
  //
  // Ketinggian di WPML diukur dari titik lepas landas (relativeToStartPoint),
  // bukan dari permukaan di bawah drone. Jadi untuk menjaga AGL tetap sama,
  // perintah ketinggian tiap titik = AGL + (elevasi titik itu - elevasi home).
  const terrain = { on: state.terrain, ready: false, relief: null, missing: 0 };

  if (state.terrain) {
    const homeElev = cachedElevation(state.home ?? polygon[0]);
    const elevs = grid.waypoints.map((w) => cachedElevation(proj.toLL(w.xy)));
    terrain.missing = elevs.filter((v) => v === undefined).length;

    if (homeElev !== undefined && terrain.missing === 0) {
      terrain.ready = true;
      terrain.relief = reliefOf(elevs);
      grid.waypoints.forEach((w, i) => {
        w.height = params.altitude + (elevs[i] - homeElev);
      });
      terrain.maxHeight = Math.max(...grid.waypoints.map((w) => w.height));
      terrain.minHeight = Math.min(...grid.waypoints.map((w) => w.height));
    } else {
      grid.waypoints.forEach((w) => delete w.height);
    }
  } else {
    grid.waypoints.forEach((w) => delete w.height);
  }

  // Kalau data elevasi kebetulan sudah ada di cache (pernah dinyalakan), pakai
  // untuk memperingatkan soal medan meski terrain following sedang mati.
  const known = grid.waypoints
    .map((w) => cachedElevation(proj.toLL(w.xy)))
    .filter((v) => v !== undefined);
  const reliefHint =
    known.length >= grid.waypoints.length * 0.8 ? reliefOf(known) : null;

  const summaries = sorties.map((s) =>
    sortieSummary(s, homeXY, { speed, accel, hoverPerPhotoSec: hoverPerPhoto, stopAtEach })
  );

  // Berapa mahal buffer ini sebenarnya? Hitung versi tanpa buffer sebagai
  // pembanding, supaya angkanya jadi keputusan sadar, bukan biaya siluman.
  let bufferCost = null;
  if (bufferM > 0) {
    const bare = generateGrid(polyXY, {
      angleDeg: Number(els.angle.value),
      sideSpacing: params.sideSpacing,
      frontSpacing: params.frontSpacing,
      mode,
      overshoot: mode === 'continuous' ? params.frontSpacing : 0,
    });
    if (bare.waypoints.length) {
      const bareDur = missionDuration(bare.waypoints, {
        speed,
        accel,
        hoverPerPhotoSec: hoverPerPhoto,
        stopAtEach,
      });
      bufferCost = {
        photos: grid.photos - bare.photos,
        seconds:
          missionDuration(grid.waypoints, {
            speed,
            accel,
            hoverPerPhotoSec: hoverPerPhoto,
            stopAtEach,
          }) - bareDur,
      };
    }
  }

  return {
    proj,
    polyXY,
    gridPoly,
    gridArea: polygonArea(gridPoly),
    bufferM,
    bufferCost,
    terrain,
    reliefHint,
    homeXY,
    area,
    params,
    grid,
    mode,
    stopAtEach,
    speed,
    maxDist,
    distance: pathLengthXY(grid.waypoints.map((w) => w.xy)),
    duration: summaries.reduce((s, x) => s + x.durationS, 0),
    sorties,
    summaries,
    altitude: params.altitude,
  };
}

function checkWarnings(plan) {
  const out = [];
  const lim = state.profile.limits;

  if (plan.altitude > lim.maxAltitudeM) {
    out.push({
      level: 'bad',
      text: `Ketinggian ${plan.altitude.toFixed(0)} m melewati batas regulasi ${lim.maxAltitudeM} m. Perhalus GSD, atau area ini butuh izin khusus.`,
    });
  }

  if (plan.maxDist > 500) {
    out.push({
      level: plan.maxDist > 1500 ? 'bad' : 'warn',
      text: `Titik terjauh ${(plan.maxDist / 1000).toFixed(2)} km dari titik lepas landas. VLOS jadi sulit — pindahkan penanda H lebih ke tengah lahan, atau bagi lahannya.`,
    });
  }

  if (!plan.stopAtEach && plan.params.recommendedSpeed < 3) {
    out.push({
      level: 'warn',
      text: `GSD serapat ini memaksa kecepatan turun ke ${plan.params.recommendedSpeed.toFixed(1)} m/s supaya tidak motion blur — rolling shutter Mini 5 Pro tidak bisa dipaksa. Pertimbangkan stop & shoot.`,
    });
  }

  const wpMax = Math.max(...plan.sorties.map((s) => s.length));
  if (wpMax > lim.maxWaypoints) {
    out.push({
      level: 'warn',
      text: `Satu sortie butuh ${wpMax} waypoint, melebihi perkiraan batas DJI Fly (${lim.maxWaypoints}). Perkecil area atau pakai mode jalan terus.`,
    });
  }

  if (plan.sorties.length > 4) {
    out.push({
      level: 'warn',
      text: `Butuh ${plan.sorties.length} baterai. Posisi matahari dan cuaca bisa berubah banyak selama itu — pertimbangkan membagi lahan jadi beberapa hari.`,
    });
  }

  const t = plan.terrain;
  if (t.ready) {
    const climb = t.maxHeight - t.minHeight;
    if (climb > 60) {
      out.push({
        level: 'warn',
        text: `Mengikuti kontur berarti drone naik-turun ${climb.toFixed(0)} m sepanjang misi. Boros baterai, dan pastikan tidak ada obstacle di jalur naiknya.`,
      });
    }
    // Ketinggian diukur dari titik lepas landas, jadi medan yang lebih rendah
    // dari titik itu menghasilkan perintah negatif — drone diminta turun ke
    // bawah posisi start. DJI Fly kemungkinan menolak, dan kalaupun diterima
    // itu berbahaya.
    // Fallback eksplisit: tanpa ini, profil lama tanpa field tersebut membuat
    // perbandingan jadi `x < undefined` yang selalu false — pemeriksaan mati
    // diam-diam tanpa ada tanda apa pun.
    const floorM = lim.takeOffSecurityHeightM ?? 20;
    if (t.minHeight < floorM) {
      out.push({
        level: 'bad',
        text: `Sebagian lahan lebih rendah dari titik lepas landas — perintah ketinggian terendah jadi ${t.minHeight.toFixed(0)} m. Lepas landas dari bagian terendah lahan, bukan dari puncak.`,
      });
    }

    if (t.maxHeight > lim.maxAltitudeM) {
      out.push({
        level: 'bad',
        text: `Titik tertinggi jadi ${t.maxHeight.toFixed(0)} m di atas titik lepas landas — melewati batas ${lim.maxAltitudeM} m. Lepas landas dari tempat yang lebih tinggi, atau pecah lahannya.`,
      });
    }
  } else if (!plan.terrain.on) {
    const r = plan.reliefHint;
    if (r && r.relief > plan.altitude * 0.1) {
      out.push({
        level: 'warn',
        text: `Medan di area ini naik-turun ${r.relief.toFixed(0)} m. Tanpa ikuti kontur, GSD bisa meleset sampai ${((r.relief / plan.altitude) * 100).toFixed(0)}% antara bagian tinggi dan rendah.`,
      });
    }
  }

  // Pada lahan kecil, buffer bisa hampir melipatgandakan area terbang.
  const overhead = plan.gridArea / plan.area - 1;
  if (plan.bufferM > 0 && overhead > 0.6) {
    out.push({
      level: 'info',
      text: `Buffer menambah ${Math.round(overhead * 100)}% luas terbang — di lahan sekecil ini buffernya proporsional besar. Turunkan ke 0.5× kalau tepi lahan tidak kritis.`,
    });
  }

  if (plan.bufferM === 0) {
    out.push({
      level: 'info',
      text: 'Buffer mati — jalur berhenti persis di batas lahan. Pinggiran ortofoto kemungkinan melengkung atau kosong. Aman kalau cuma bagian tengah yang dipakai.',
    });
  }

  if (plan.stopAtEach && plan.grid.photos > 150) {
    out.push({
      level: 'info',
      text: `Stop & shoot untuk ${plan.grid.photos} foto makan waktu lama. Mode jalan terus jauh lebih cepat, dan biasanya masih cukup tajam.`,
    });
  }

  return out;
}

// ---------- Data elevasi ----------
//
// Permintaan jaringan tidak boleh ikut tiap geseran slider, jadi render tetap
// sinkron memakai cache, dan pengambilan data berjalan di belakang lalu
// memicu render ulang begitu datanya masuk.

let terrainTimer = null;

function ensureTerrain(plan) {
  if (!plan || !state.terrain || state.terrainLoading) return;

  const coords = [state.home, ...plan.grid.waypoints.map((w) => plan.proj.toLL(w.xy))];
  if (!missingCoords(coords).length) return;

  clearTimeout(terrainTimer);
  terrainTimer = setTimeout(async () => {
    state.terrainLoading = true;
    state.terrainError = null;
    renderTerrainStatus(state.plan);
    try {
      await fetchElevations(coords);
    } catch (err) {
      state.terrainError = err.message;
      toast(err.message, 'err', 6000);
    } finally {
      state.terrainLoading = false;
      render();
    }
  }, 600);
}

function renderTerrainStatus(plan) {
  els.terrainReadout.hidden = !state.terrain;
  if (!state.terrain) return;

  els.terrainReadout.classList.toggle('busy', state.terrainLoading);

  if (state.terrainLoading) {
    els.terrainStatus.textContent = 'Mengambil data elevasi…';
    els.terrainRelief.textContent = '…';
    return;
  }
  if (state.terrainError) {
    els.terrainStatus.textContent = 'Gagal — pakai ketinggian datar';
    els.terrainRelief.textContent = '—';
    return;
  }
  const t = plan?.terrain;
  if (!t?.ready) {
    els.terrainStatus.textContent = 'Menunggu data';
    els.terrainRelief.textContent = '—';
    return;
  }
  els.terrainStatus.textContent = 'Beda tinggi medan';
  els.terrainRelief.textContent = `${t.relief.relief.toFixed(0)} m`;
}

// ---------- Render ----------

function render() {
  const n = state.polygon.length;
  els.undo.disabled = !editor?.canUndo();
  els.redo.disabled = !editor?.canRedo();
  els.clear.disabled = n === 0;

  const ring = n >= 3 ? [[...state.polygon, state.polygon[0]]] : null;
  map.getSource('aoi')?.setData(
    ring
      ? { type: 'Feature', geometry: { type: 'Polygon', coordinates: ring } }
      : n === 2
        ? { type: 'Feature', geometry: { type: 'LineString', coordinates: state.polygon } }
        : EMPTY
  );

  $('num-1').classList.toggle('done', n >= 3);

  // Selama pengguna belum menggeser penanda H sendiri, titik lepas landas
  // mengikuti tengah lahan. Tanpa ini, H tertinggal di lokasi lama saat area
  // digambar di tempat berbeda — dan seluruh hitungan transit jadi ngawur.
  if (!state.homePinned && n >= 3) {
    const c = centroid(state.polygon);
    state.home = c;
    homeMarker?.setLngLat(c);
  }

  els.homeReadout.hidden = n < 3;
  els.toggleHome.hidden = n < 3;
  els.toggleHome.textContent = settings.hideHome
    ? 'Tampilkan penanda'
    : 'Sembunyikan penanda';
  els.resetHome.hidden = !state.homePinned || n < 3 || settings.hideHome;
  els.helpHome.hidden = !!settings.hideHome;
  els.homeVal.textContent = settings.hideHome
    ? 'Tengah lahan'
    : state.homePinned
      ? 'Diatur manual'
      : 'Tengah lahan (otomatis)';

  const plan = buildPlan();
  state.plan = plan;

  if (!plan) {
    map.getSource('route')?.setData(EMPTY);
    map.getSource('wp')?.setData(EMPTY);
    map.getSource('buffer')?.setData(EMPTY);
    els.area.hidden = true;
    els.flown.hidden = true;
    renderTerrainStatus(null);
    updateTileEstimate(null);
    els.stats.className = 'stats empty';
    els.stats.innerHTML =
      '<p class="placeholder">Gambar area dulu untuk melihat rencana terbang.</p>';
    els.sorties.innerHTML = '';
    els.warnings.innerHTML = '';
    els.legend.hidden = true;
    els.export.disabled = true;
    els.geojson.disabled = true;
    els.handoff.disabled = true;
    els.save.disabled = true;
    els.sheetSummary.textContent = n >= 3 ? 'Menghitung…' : 'Gambar area survei';
    syncUrl();
    $('num-2').classList.remove('done');
    $('num-3').classList.remove('done');
    updateDerived();
    return;
  }

  $('num-2').classList.add('done');
  $('num-3').classList.add('done');
  els.export.disabled = false;
  els.geojson.disabled = false;
  els.handoff.disabled = false;
  els.save.disabled = false;

  // Garis putus-putus abu: batas area yang benar-benar diterbangi.
  map.getSource('buffer')?.setData(
    plan.bufferM > 0
      ? {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [...plan.gridPoly, plan.gridPoly[0]].map((p) => plan.proj.toLL(p)),
            ],
          },
        }
      : EMPTY
  );

  map.getSource('route')?.setData({
    type: 'FeatureCollection',
    features: plan.sorties.map((sortie, i) => ({
      type: 'Feature',
      properties: { color: BATTERY_COLORS[i % BATTERY_COLORS.length] },
      geometry: {
        type: 'LineString',
        coordinates: sortie.map((w) => plan.proj.toLL(w.xy)),
      },
    })),
  });

  map.getSource('wp')?.setData({
    type: 'FeatureCollection',
    features: plan.grid.waypoints.map((w) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: plan.proj.toLL(w.xy) },
    })),
  });

  els.area.hidden = false;
  els.areaVal.textContent = fmtArea(plan.area);

  // Sejak ada buffer, yang diterbangi lebih luas dari lahan yang digambar —
  // dan itulah yang menentukan waktu dan jumlah foto.
  els.flown.hidden = plan.bufferM <= 0;
  els.flownVal.textContent = `${fmtArea(plan.gridArea)} (+${Math.round((plan.gridArea / plan.area - 1) * 100)}%)`;

  renderTerrainStatus(plan);
  ensureTerrain(plan);
  updateTileEstimate(plan);

  updateDerived(plan);
  renderStats(plan);
  renderSorties(plan);
  renderLegend(plan);
  renderWarnings(checkWarnings(plan));

  els.sheetSummary.textContent =
    `${fmtArea(plan.area)} · ${plan.altitude.toFixed(0)} m · ${fmtDur(plan.duration)} · ` +
    `${plan.sorties.length} baterai`;

  syncUrl();
}

function updateDerived(plan) {
  els.gsdOut.textContent = `${Number(els.gsd.value).toFixed(1)} cm/px`;
  els.frontOut.textContent = `${els.front.value}%`;
  els.sideOut.textContent = `${els.side.value}%`;
  els.angleOut.textContent = `${els.angle.value}°`;

  const mult = Number(els.buffer.value);
  els.bufferOut.textContent = mult === 0 ? 'mati' : `${mult.toFixed(1)}× jalur`;

  if (state.profile) {
    const p = computeSurveyParams(state.profile.camera, {
      gsdCm: Number(els.gsd.value),
      frontOverlap: Number(els.front.value) / 100,
      sideOverlap: Number(els.side.value) / 100,
    });
    els.altDerived.textContent = `${p.altitude.toFixed(0)} m`;
    const meters = mult === 0 ? 'tepat di batas' : `${(mult * p.sideSpacing).toFixed(0)} m`;
    const cost = plan?.bufferCost;
    els.bufferM.textContent =
      cost && cost.photos > 0
        ? `${meters} — biayanya +${cost.photos} foto, +${fmtDur(cost.seconds)}`
        : meters;
  }
}

function renderStats(plan) {
  els.stats.className = 'stats';
  els.stats.innerHTML = `
    <div class="stat">
      <span class="k">Ketinggian</span>
      <span class="v">${plan.altitude.toFixed(0)}<small>m</small></span>
    </div>
    <div class="stat">
      <span class="k">Kecepatan</span>
      <span class="v">${plan.speed.toFixed(1)}<small>m/s</small></span>
    </div>
    <div class="stat">
      <span class="k">Jumlah foto</span>
      <span class="v">${plan.grid.photos}</span>
    </div>
    <div class="stat">
      <span class="k">Waypoint</span>
      <span class="v">${plan.grid.waypoints.length}</span>
    </div>
    <div class="stat">
      <span class="k">Total waktu</span>
      <span class="v">${fmtDur(plan.duration)}</span>
    </div>
    <div class="stat">
      <span class="k">Titik terjauh</span>
      <span class="v">${plan.maxDist.toFixed(0)}<small>m</small></span>
    </div>
    <div class="stat full">
      <span class="k">Jarak antar jalur · jarak antar foto</span>
      <span class="v">${plan.params.sideSpacing.toFixed(0)}<small>m</small> · ${plan.params.frontSpacing.toFixed(0)}<small>m</small></span>
    </div>`;
}

function renderSorties(plan) {
  if (plan.summaries.length <= 1) {
    const s = plan.summaries[0];
    els.sorties.innerHTML = `<div class="note info"><span class="ic">i</span><span>Muat dalam 1 baterai — ${fmtDur(s.surveyS)} survei + ${fmtDur(s.transitS)} transit.</span></div>`;
    return;
  }

  els.sorties.innerHTML = `
    <div class="sortie-head">${plan.summaries.length} baterai</div>
    <div class="sortie-list">
      ${plan.summaries
        .map(
          (s, i) => `
        <div class="sortie">
          <span class="swatch" style="background:${BATTERY_COLORS[i % BATTERY_COLORS.length]}"></span>
          <span class="sn">#${i + 1}</span>
          <span class="sd">${fmtDur(s.durationS)}</span>
          <span class="sp">${s.photos} foto</span>
        </div>`
        )
        .join('')}
    </div>`;
}

function renderLegend(plan) {
  if (plan.summaries.length <= 1) {
    els.legend.hidden = true;
    return;
  }
  els.legend.hidden = false;
  els.legend.innerHTML = plan.summaries
    .map(
      (s, i) =>
        `<div class="lg"><span class="swatch" style="background:${BATTERY_COLORS[i % BATTERY_COLORS.length]}"></span>Baterai ${i + 1} · ${fmtDur(s.durationS)}</div>`
    )
    .join('');
}

function renderWarnings(list) {
  const icon = { bad: '!', warn: '!', info: 'i' };
  els.warnings.innerHTML = list
    .map(
      (w) =>
        `<div class="note ${w.level}"><span class="ic">${icon[w.level]}</span><span>${w.text}</span></div>`
    )
    .join('');
}

const esc = (s) =>
  String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

function fmtArea(m2) {
  const ha = m2 / 10000;
  return ha >= 1 ? `${ha.toFixed(2)} ha` : `${m2.toFixed(0)} m²`;
}

function fmtDur(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m >= 60
    ? `${Math.floor(m / 60)}j ${m % 60}m`
    : m > 0
      ? `${m}m ${String(s).padStart(2, '0')}s`
      : `${s}s`;
}

// ---------- Project ----------

function onSave() {
  const name = els.projName.value.trim() || `Project ${new Date().toLocaleDateString('id-ID')}`;
  const rec = saveProject({
    id: state.currentProjectId,
    name,
    polygon: state.polygon,
    home: state.home,
    homePinned: state.homePinned,
    mode: state.mode,
    gsd: Number(els.gsd.value),
    front: Number(els.front.value),
    side: Number(els.side.value),
    angle: Number(els.angle.value),
    buffer: Number(els.buffer.value),
  });

  if (!rec) {
    toast('Gagal menyimpan — penyimpanan browser diblokir.', 'err');
    return;
  }
  state.currentProjectId = rec.id;
  els.projName.value = rec.name;
  refreshProjectList();
  toast(`Project "${rec.name}" tersimpan.`, 'ok');
}

function refreshProjectList() {
  const list = listProjects();
  if (!list.length) {
    els.projList.innerHTML = '<p class="placeholder small">Belum ada project tersimpan.</p>';
    return;
  }
  els.projList.innerHTML = list
    .map(
      (p) => `
      <div class="proj ${p.id === state.currentProjectId ? 'current' : ''}">
        <button class="proj-open" data-id="${p.id}">
          <span class="pn">${esc(p.name)}</span>
          <span class="pd">${new Date(p.savedAt).toLocaleDateString('id-ID')}</span>
        </button>
        <button class="proj-del" data-del="${p.id}" title="Hapus">×</button>
      </div>`
    )
    .join('');

  els.projList.querySelectorAll('.proj-open').forEach((b) => {
    b.onclick = () => openProject(b.dataset.id);
  });
  els.projList.querySelectorAll('.proj-del').forEach((b) => {
    b.onclick = () => {
      deleteProject(b.dataset.del);
      if (state.currentProjectId === b.dataset.del) state.currentProjectId = null;
      refreshProjectList();
    };
  });
}

function openProject(id) {
  const p = loadProject(id);
  if (!p) return;

  state.currentProjectId = p.id;
  els.projName.value = p.name;
  els.gsd.value = p.gsd;
  els.front.value = p.front;
  els.side.value = p.side;
  els.angle.value = p.angle;
  els.buffer.value = p.buffer ?? 1;

  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === p.mode);
  });
  state.mode = p.mode;

  state.homePinned = !!p.homePinned;
  if (p.home && state.homePinned) {
    homeMarker.setLngLat(p.home);
    state.home = p.home;
  }

  editor.set(p.polygon);
  if (p.polygon.length >= 3) {
    map.fitBounds(bounds(p.polygon), { padding: 70, duration: 600 });
  }
  refreshProjectList();
  render();
}

// ---------- Export ----------

function planWaypointsToMission(plan, sortie) {
  return sortie.map((w) => {
    const [lng, lat] = plan.proj.toLL(w.xy);
    return {
      lat,
      lng,
      height: w.height ?? plan.altitude,
      speed: plan.speed,
      heading: w.heading,
      headingMode: 'smoothTransition',
      gimbalPitch: -90,
      takePhoto: plan.stopAtEach,
      hoverTime: plan.stopAtEach ? 2 : 0,
    };
  });
}

/**
 * Di perangkat sentuh, share sheet jauh lebih berguna daripada unduhan: file
 * bisa langsung dilempar ke app Files atau ke DJI Fly tanpa mampir ke folder
 * Download. Di desktop, unduhan biasa tetap yang paling masuk akal.
 */
function canShareFiles() {
  if (!navigator.canShare || !navigator.share) return false;
  if (!window.matchMedia('(pointer: coarse)').matches) return false;
  try {
    return navigator.canShare({ files: [new File([new Uint8Array(1)], 'uji.kmz')] });
  } catch {
    return false;
  }
}

async function exportKmz() {
  const plan = state.plan;
  if (!plan) return;

  els.export.disabled = true;
  const original = els.export.textContent;
  els.export.textContent = 'Membuat file…';

  try {
    const base = (els.projName.value.trim() || 'survei').replace(/[^\w\-]+/g, '-');
    const stamp = new Date().toISOString().slice(0, 10);

    const files = plan.sorties.map((sortie, i) => {
      const bytes = buildKmz(
        {
          waypoints: planWaypointsToMission(plan, sortie),
          height: plan.altitude,
          speed: plan.speed,
          intervalShooting: plan.stopAtEach
            ? null
            : { mode: 'distance', value: plan.params.frontSpacing },
        },
        state.profile
      );
      const name =
        plan.sorties.length > 1
          ? `${base}-${stamp}_${i + 1}dari${plan.sorties.length}.kmz`
          : `${base}-${stamp}.kmz`;
      return { bytes, name };
    });

    if (canShareFiles()) {
      try {
        await navigator.share({
          title: 'Mission waypoint',
          files: files.map(
            (f) =>
              new File([f.bytes], f.name, {
                type: 'application/vnd.google-earth.kmz',
              })
          ),
        });
        toast('Terkirim. Simpan ke folder DJI Fly.', 'ok', 6000);
        return;
      } catch (err) {
        // Pengguna membatalkan share sheet: jangan diperlakukan sebagai error,
        // dan jangan diam-diam mengunduh di belakang mereka.
        if (err?.name === 'AbortError') return;
        // Selain itu, turun ke unduhan biasa.
      }
    }

    for (const f of files) {
      downloadBlob(f.bytes, f.name);
      await new Promise((r) => setTimeout(r, 300)); // jeda antar unduhan
    }

    toast(
      plan.sorties.length > 1
        ? `${plan.sorties.length} file KMZ terunduh. Pindahkan ke folder DJI Fly di HP.`
        : 'KMZ terunduh. Pindahkan ke folder DJI Fly di HP.',
      'ok',
      6000
    );
  } catch (err) {
    toast(`Gagal membuat file: ${err.message}`, 'err', 7000);
  } finally {
    els.export.textContent = original;
    els.export.disabled = false;
  }
}

function exportGeoJson() {
  const plan = state.plan;
  if (!plan) return;

  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { kind: 'aoi', areaHa: plan.area / 10000 },
        geometry: {
          type: 'Polygon',
          coordinates: [[...state.polygon, state.polygon[0]]],
        },
      },
      {
        type: 'Feature',
        properties: { kind: 'home' },
        geometry: { type: 'Point', coordinates: state.home },
      },
      ...plan.sorties.map((s, i) => ({
        type: 'Feature',
        properties: {
          kind: 'route',
          sortie: i + 1,
          altitudeM: plan.altitude,
          speedMs: plan.speed,
        },
        geometry: {
          type: 'LineString',
          coordinates: s.map((w) => plan.proj.toLL(w.xy)),
        },
      })),
    ],
  };

  const name = (els.projName.value.trim() || 'survei').replace(/[^\w\-]+/g, '-');
  downloadBlob(new TextEncoder().encode(JSON.stringify(fc, null, 2)), `${name}.geojson`);
}


// ---------- Berbagi rencana lewat URL ----------
//
// Seluruh rencana muat di hash URL, jadi tidak butuh server untuk membagikannya
// antar perangkat. Ini sekaligus membuat refresh halaman tidak menghilangkan
// pekerjaan yang belum disimpan.

function encodeState() {
  const payload = {
    p: state.polygon.map((c) => [round6(c[0]), round6(c[1])]),
    h: state.homePinned && state.home
      ? [round6(state.home[0]), round6(state.home[1])]
      : null,
    g: Number(els.gsd.value),
    f: Number(els.front.value),
    s: Number(els.side.value),
    a: Number(els.angle.value),
    b: Number(els.buffer.value),
    m: state.mode === 'stopAndShoot' ? 1 : 0,
  };
  const json = JSON.stringify(payload);
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeState(token) {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

let urlTimer = null;
function syncUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const hash = state.polygon.length >= 3 ? `#r=${encodeState()}` : '';
    history.replaceState(null, '', location.pathname + location.search + hash);
  }, 400);
}

function applyStateFromUrl() {
  const m = location.hash.match(/[#&]r=([A-Za-z0-9_-]+)/);
  if (!m) return false;

  try {
    const d = decodeState(m[1]);
    if (!Array.isArray(d.p) || d.p.length < 3) return false;

    els.gsd.value = d.g;
    els.front.value = d.f;
    els.side.value = d.s;
    els.angle.value = d.a;
    els.buffer.value = d.b ?? 1;
    state.mode = d.m ? 'stopAndShoot' : 'continuous';
    document.querySelectorAll('.seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === state.mode);
    });

    state.homePinned = !!d.h;
    if (d.h) {
      homeMarker.setLngLat(d.h);
      state.home = d.h;
    }
    editor.set(d.p);
    map.fitBounds(bounds(d.p), { padding: 70, duration: 0 });
    render();
    return true;
  } catch {
    toast('Link rencana tidak terbaca.', 'err');
    return false;
  }
}

function openHandoff() {
  if (!state.plan) return;

  const url = `${location.origin}${location.pathname}#r=${encodeState()}`;
  els.handoffUrl.value = url;
  els.qr.innerHTML = '';

  if (typeof QRCode === 'undefined') {
    els.qr.innerHTML = '<p class="placeholder small">Pustaka QR gagal dimuat — salin link di bawah.</p>';
  } else {
    new QRCode(els.qr, {
      text: url,
      width: 220,
      height: 220,
      correctLevel: QRCode.CorrectLevel.L, // rencana besar bikin URL panjang
    });
  }

  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  els.handoffNote.textContent = local
    ? 'Alamatnya masih localhost, jadi HP tidak bisa membukanya. Jalankan server dengan alamat LAN komputer ini (lihat README), lalu buka ulang dialog ini.'
    : 'Pastikan HP terhubung ke jaringan yang sama dengan komputer ini.';

  els.modal.hidden = false;
}


// ---------- Peta offline ----------

const ZOOM_MIN = 13;
const ZOOM_MAX = 19;
const TILE_LIMIT = 3000;

let downloading = false;

function initOffline() {
  if (!offlineSupported()) {
    els.offlineUnsupported.hidden = false;
    // Urutan penting: di origin tidak aman, navigator.serviceWorker memang
    // tidak ada sama sekali — kalau itu diperiksa duluan, pesannya jadi
    // menyalahkan browser padahal penyebabnya alamat halaman.
    els.offlineWhy.textContent = !window.isSecureContext
      ? `Peta offline butuh koneksi aman. Halaman ini dibuka lewat ${location.protocol}//${location.hostname}, sementara browser hanya mengizinkan service worker di https atau localhost. Buka lewat localhost, atau deploy ke hosting ber-https.`
      : 'Browser ini tidak mendukung service worker, jadi peta offline tidak bisa dipakai.';
    return;
  }

  els.offlineBody.hidden = false;
  navigator.serviceWorker.register('sw.js').catch((err) => {
    els.offlineBody.hidden = true;
    els.offlineUnsupported.hidden = false;
    els.offlineWhy.textContent = `Service worker gagal dipasang: ${err.message}`;
  });

  els.download.onclick = startDownload;
  els.clearTiles.onclick = async () => {
    await clearTiles();
    toast('Cache tile dihapus.', 'ok');
    refreshCacheStatus();
  };

  refreshCacheStatus();
}

async function refreshCacheStatus() {
  const st = await cacheStatus();
  if (!st) return;
  const mb = st.bytes != null ? ` · ${(st.bytes / 1048576).toFixed(1)} MB` : '';
  els.tileCached.textContent = `${st.tiles} tile${mb}`;
}

/** Bbox area terbang, dilebarkan sedikit supaya tepi layar tidak kosong. */
function planBounds(plan) {
  const lls = plan.gridPoly.map((p) => plan.proj.toLL(p));
  if (state.home) lls.push(state.home);
  const lngs = lls.map((c) => c[0]);
  const lats = lls.map((c) => c[1]);
  const padLng = (Math.max(...lngs) - Math.min(...lngs)) * 0.15 + 0.001;
  const padLat = (Math.max(...lats) - Math.min(...lats)) * 0.15 + 0.001;
  return {
    west: Math.min(...lngs) - padLng,
    east: Math.max(...lngs) + padLng,
    south: Math.min(...lats) - padLat,
    north: Math.max(...lats) + padLat,
  };
}

function updateTileEstimate(plan) {
  if (els.offlineBody.hidden) return;

  if (!plan) {
    els.tileCount.textContent = '—';
    els.download.disabled = true;
    return;
  }

  const n = countTiles(planBounds(plan), ZOOM_MIN, ZOOM_MAX);
  const tooMany = n > TILE_LIMIT;
  els.tileCount.textContent = tooMany
    ? `${n} tile — terlalu banyak`
    : `${n} tile (~${((n * 25) / 1024).toFixed(1)} MB)`;
  els.download.disabled = downloading || tooMany;
}

async function startDownload() {
  const plan = state.plan;
  if (!plan || downloading) return;

  const spec = baseKind === 'street' ? STREET : IMAGERY[activeImagery()];
  const key = baseKind === 'street' ? '' : (settings.keys?.[activeImagery()] ?? '');
  const template = spec.tiles(key)[0];

  const urls = tileUrls(planBounds(plan), ZOOM_MIN, Math.min(ZOOM_MAX, spec.maxzoom), template);
  if (!urls.length) return;

  downloading = true;
  els.download.disabled = true;
  els.dlProgress.hidden = false;
  const label = els.download.textContent;

  try {
    const { failed } = await downloadTiles(urls, {
      onProgress: (done, total) => {
        els.dlBar.style.width = `${(done / total) * 100}%`;
        els.download.textContent = `${done}/${total}`;
      },
    });
    toast(
      failed
        ? `${urls.length - failed} tile tersimpan, ${failed} gagal.`
        : `${urls.length} tile tersimpan. Area ini siap dipakai tanpa sinyal.`,
      failed ? 'err' : 'ok',
      6000
    );
  } catch (err) {
    toast(`Unduhan terhenti: ${err.message}`, 'err');
  } finally {
    downloading = false;
    els.download.textContent = label;
    els.dlProgress.hidden = true;
    els.dlBar.style.width = '0';
    updateTileEstimate(state.plan);
    refreshCacheStatus();
  }
}

function syncOnlineBadge() {
  els.offlineBadge.hidden = navigator.onLine;
}

window.addEventListener('online', syncOnlineBadge);
window.addEventListener('offline', syncOnlineBadge);
syncOnlineBadge();
initOffline();
