// Prototipe perencana survei — UI peta + perhitungan jalur + export KMZ.
// Semua hitungan memakai modul yang sama dengan CLI (src/survey.js, src/wpml.js),
// jadi apa yang terlihat di layar = apa yang masuk ke file.
import {
  makeProjector,
  polygonArea,
  centroid,
  computeSurveyParams,
  generateGrid,
  generatePattern,
  PATTERNS,
  offsetPolygon,
  pathLengthXY,
  missionDuration,
  splitByBattery,
  sortieSummary,
  maxDistanceFrom,
  altitudeFromGsd,
  gsdFromAltitude,
} from '../src/survey.js';
import {
  resolveProfile,
  cameraOf,
  findDrone,
  findLens,
  findMode,
  PRESETS,
  findPreset,
  matchPreset,
} from '../src/profiles.js';
import { evaluateSafety } from '../src/safety.js';
import { readEnumsFromKmz } from './unzip.js';
import {
  installTerrainSources,
  applyViewMode,
  fetchBuildings,
  setBuildings,
  obstaclesNearPath,
} from './view3d.js';
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
  getEnumOverrides,
  setEnumOverride,
  SCHEMA_VERSION,
} from './store.js';

const CENTER = [107.11993938381485, -6.2549323363466];
const BATTERY_COLORS = ['#4da3ff', '#55c57a', '#f0b429', '#f27272', '#b98cf5', '#52d3d8'];
const EMPTY = { type: 'FeatureCollection', features: [] };

// Setelan lanjutan yang aman. Ini bukan sekadar nilai awal — tombol
// "kembalikan ke setelan aman" memulihkan persis isi objek ini, dan dua yang
// pertama adalah satu-satunya yang membawa drone pulang kalau ada yang salah.
const SAFE_ADVANCED = {
  rcLostAction: 'goBack',
  finishAction: 'goHome',
  gimbalPitch: -90,
  safeHeightM: 20,
  angleDeg: 0, // 0 = otomatis, ikut sisi terpanjang
};

const state = {
  registry: null,
  profile: null,
  droneId: 'mini5pro',
  lensId: 'wide',
  modeId: '12mp',
  enumOverrides: {},
  presetId: 'standar',
  altitudeM: 80,
  speedMs: 10,
  speedAuto: true,
  pattern: 'single',
  advanced: { ...SAFE_ADVANCED },
  gateAck: false,
  resume: null, // { index, lngLat }
  resumePicking: false,
  viewMode: '2d',
  buildings: null,
  buildingsLoading: false,
  buildingsError: null,
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
  try {
    initMapInner();
  } catch (err) {
    // Kegagalan di sini membuat seluruh panel mati tanpa sebab yang kelihatan.
    // Lebih baik muncul sebagai pesan daripada aplikasi yang diam saja.
    console.error('[init]', err);
    els.drawHint.textContent = `Gagal menyiapkan peta: ${err.message}`;
    els.draw.textContent = 'Gagal memuat';
  }
};

const initMapInner = () => {

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

  installTerrainSources(map);

  map.addSource('resume', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'resume-dot',
    type: 'circle',
    source: 'resume',
    paint: {
      'circle-radius': 7,
      'circle-color': '#f0b429',
      'circle-stroke-color': '#1b1f27',
      'circle-stroke-width': 2,
    },
  });

  // Dipasang setelah editor supaya tidak mengganggu penggambaran area: saat
  // mode pilih-titik aktif, editor sedang tidak menggambar.
  map.on('click', (e) => {
    if (!state.resumePicking) return;
    setResumePoint([e.lngLat.lng, e.lngLat.lat]);
  });

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
  const res = await fetch('../profiles/drones.json', { cache: 'no-store' });
  state.registry = await res.json();
  state.enumOverrides = getEnumOverrides();

  const saved = settings.droneId;
  if (saved && state.registry.drones.some((d) => d.id === saved)) state.droneId = saved;

  syncProfile();
  buildDronePickers();
  buildPresetChips();
  applyPreset(state.presetId, { silent: true });

  // Rencana yang datang lewat URL dipulihkan dulu; kalau tidak ada, render biasa.
  if (!applyStateFromUrl()) render();
}

/** Susun ulang profil aktif setiap kali drone, lensa, atau mode foto berubah. */
function syncProfile() {
  const drone = findDrone(state.registry, state.droneId);
  state.droneId = drone.id;

  const lens = findLens(drone, state.lensId);
  state.lensId = lens.id;

  const mode = findMode(lens, state.modeId);
  state.modeId = mode.id;

  state.profile = resolveProfile(state.registry, {
    droneId: state.droneId,
    lensId: state.lensId,
    modeId: state.modeId,
    enumOverride: state.enumOverrides[state.droneId],
  });

  // Batas ketinggian ikut drone, dan nilai yang sudah melewatinya dipotong —
  // tapi dengan diberitahu, bukan diam-diam.
  const max = state.profile.limits.maxAltitudeM;
  els.alt.max = String(max);
  if (state.altitudeM > max) {
    state.altitudeM = max;
    toast(`Ketinggian dipotong ke batas ${max} m untuk ${state.profile.name}.`, 'info');
  }

  els.speed.max = String(state.profile.limits.maxSpeedMs);
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
  drone: $('drone'),
  lens: $('lens'),
  photoMode: $('photo-mode'),
  droneInfoBtn: $('btn-drone-info'),
  enumBadge: $('enum-badge'),
  presets: $('presets'),
  presetNote: $('preset-note'),
  alt: $('alt'),
  altOut: $('alt-out'),
  gsdDerived: $('gsd-derived'),
  speed: $('speed'),
  speedOut: $('speed-out'),
  speedAuto: $('speed-auto'),
  speedNote: $('speed-note'),
  patternSeg: $('pattern-seg'),
  patternHint: $('pattern-hint'),
  patternCost: $('pattern-cost'),
  patternCostVal: $('pattern-cost-val'),
  gimbal: $('gimbal'),
  gimbalOut: $('gimbal-out'),
  rcLost: $('rc-lost'),
  finish: $('finish'),
  safeHeight: $('safe-height'),
  safeHeightOut: $('safe-height-out'),
  resetAdv: $('btn-reset-adv'),
  gate: $('gate'),
  gateTitle: $('gate-title'),
  gateAck: $('gate-ack'),
  resumePick: $('btn-resume-pick'),
  resumeGps: $('btn-resume-gps'),
  resumeClear: $('btn-resume-clear'),
  resumeReadout: $('resume-readout'),
  resumeStatus: $('resume-status'),
  resumeVal: $('resume-val'),
  viewSwitch: $('view-switch'),
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
  frontOut: $('front-out'),
  sideOut: $('side-out'),
  angleOut: $('angle-out'),
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

for (const el of [els.front, els.side, els.angle, els.buffer]) {
  el.addEventListener('input', () => {
    if (el === els.front || el === els.side) markCustomPreset();
    render();
  });
}

// ---------- Drone, lensa, mode foto ----------

function buildDronePickers() {
  const bySeries = new Map();
  for (const d of state.registry.drones) {
    if (!bySeries.has(d.series)) bySeries.set(d.series, []);
    bySeries.get(d.series).push(d);
  }

  els.drone.innerHTML = [...bySeries.entries()]
    .map(
      ([series, list]) =>
        `<optgroup label="${esc(series)}">${list
          .map(
            (d) =>
              `<option value="${d.id}"${d.id === state.droneId ? ' selected' : ''}>${esc(d.name)}</option>`
          )
          .join('')}</optgroup>`
    )
    .join('');

  buildLensPickers();
}

function buildLensPickers() {
  const drone = findDrone(state.registry, state.droneId);
  const lens = findLens(drone, state.lensId);

  els.lens.innerHTML = drone.lenses
    .map(
      (l) =>
        `<option value="${l.id}"${l.id === lens.id ? ' selected' : ''}>${esc(l.name)} · ${esc(l.sensor)}</option>`
    )
    .join('');
  els.lens.disabled = drone.lenses.length < 2;

  els.photoMode.innerHTML = lens.modes
    .map(
      (m) =>
        `<option value="${m.id}"${m.id === state.modeId ? ' selected' : ''}>${esc(m.label)}${m.binned ? ' (binning)' : ''}</option>`
    )
    .join('');
  els.photoMode.disabled = lens.modes.length < 2;
}

els.drone.onchange = () => {
  state.droneId = els.drone.value;
  // Lensa dan mode foto milik drone sebelumnya belum tentu ada di drone baru;
  // kosongkan supaya findLens/findMode jatuh ke pilihan pertama yang sah.
  state.lensId = '';
  state.modeId = '';
  settings = setSettings({ droneId: state.droneId });
  syncProfile();
  buildLensPickers();
  reapplyPresetForDrone();
  render();
};

els.lens.onchange = () => {
  state.lensId = els.lens.value;
  state.modeId = '';
  syncProfile();
  buildLensPickers();
  reapplyPresetForDrone();
  render();
};

els.photoMode.onchange = () => {
  state.modeId = els.photoMode.value;
  syncProfile();
  reapplyPresetForDrone();
  render();
};

/**
 * Ganti drone atau lensa mengubah arti ketinggian yang sama.
 *
 * Kalau pengguna sedang memakai preset, yang dipertahankan adalah KETELITIAN
 * yang dituju — ketinggiannya dihitung ulang. Kalau dia sudah mengatur sendiri
 * (custom), ketinggiannya yang dipertahankan dan GSD-nya yang berubah, karena
 * di situ angka yang dia pilih sendiri adalah ketinggian.
 */
function reapplyPresetForDrone() {
  if (state.presetId) applyPreset(state.presetId, { silent: true });
}

// ---------- Preset ----------

function buildPresetChips() {
  els.presets.innerHTML =
    PRESETS.map(
      (p) =>
        `<button class="preset" data-preset="${p.id}"><span class="pn">${esc(p.name)}</span><span class="pd" data-sub="${p.id}">—</span></button>`
    ).join('') + '<button class="preset" data-preset="custom"><span class="pn">Custom</span><span class="pd">atur sendiri</span></button>';

  els.presets.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.preset === 'custom') {
        markCustomPreset();
        render();
        return;
      }
      applyPreset(btn.dataset.preset);
      render();
    };
  });
}

function applyPreset(id, { silent = false } = {}) {
  const preset = findPreset(id);
  if (!preset) return;

  state.presetId = preset.id;
  state.altitudeM = clampAltitude(altitudeFromGsd(state.profile.camera, preset.gsdCm));
  els.front.value = String(Math.round(preset.frontOverlap * 100));
  els.side.value = String(Math.round(preset.sideOverlap * 100));

  if (!silent) toast(`Preset ${preset.name}: ${preset.note}`, 'ok', 5000);
}

function markCustomPreset() {
  state.presetId = null;
}

function clampAltitude(m) {
  const max = state.profile.limits.maxAltitudeM;
  return Math.max(Number(els.alt.min), Math.min(max, Math.round(m)));
}

// ---------- Ketinggian & kecepatan ----------

els.alt.addEventListener('input', () => {
  state.altitudeM = Number(els.alt.value);
  markCustomPreset();
  render();
});

els.speed.addEventListener('input', () => {
  state.speedMs = Number(els.speed.value);
  if (state.speedAuto) {
    state.speedAuto = false;
    els.speedAuto.checked = false;
  }
  render();
});

els.speedAuto.onchange = () => {
  state.speedAuto = els.speedAuto.checked;
  render();
};

// ---------- Pola terbang ----------

const PATTERN_HINT = {
  single: 'Satu arah, kamera nunduk lurus. Untuk ortofoto dan ukur luas.',
  cross:
    'Dua arah menyilang 90°. Objek tegak terpotret dari dua sisi, jadi model 3D-nya tidak bolong. Foto dan waktu jadi dua kali lipat.',
  crossOblique:
    'Dua arah menyilang, kamera dimiringkan. Ini yang menangkap dinding tegak — untuk model bangunan. Dua kali lipat juga.',
};

els.patternSeg.querySelectorAll('[data-pattern]').forEach((btn) => {
  btn.onclick = () => {
    els.patternSeg.querySelectorAll('[data-pattern]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.pattern = btn.dataset.pattern;
    els.patternHint.textContent = PATTERN_HINT[state.pattern];

    // Gimbal mengikuti pola, karena itulah yang membedakan silang biasa dari
    // silang yang benar-benar berguna untuk 3D. Tetap bisa diubah manual.
    state.advanced.gimbalPitch = PATTERNS[state.pattern].gimbalPitch;
    els.gimbal.value = String(state.advanced.gimbalPitch);
    render();
  };
});

// ---------- Pengaturan lanjutan ----------

els.angle.addEventListener('input', () => {
  state.advanced.angleDeg = Number(els.angle.value) || 0;
  render();
});

els.gimbal.addEventListener('input', () => {
  state.advanced.gimbalPitch = Number(els.gimbal.value);
  render();
});

els.safeHeight.addEventListener('input', () => {
  state.advanced.safeHeightM = Number(els.safeHeight.value);
  render();
});

els.rcLost.onchange = () => {
  state.advanced.rcLostAction = els.rcLost.value;
  render();
};

els.finish.onchange = () => {
  state.advanced.finishAction = els.finish.value;
  render();
};

els.resetAdv.onclick = () => {
  state.advanced = { ...SAFE_ADVANCED, gimbalPitch: PATTERNS[state.pattern].gimbalPitch };
  syncAdvancedInputs();
  render();
  toast('Setelan lanjutan dikembalikan: RTH saat sinyal hilang, RTH setelah selesai.', 'ok');
};

function syncAdvancedInputs() {
  const a = state.advanced;
  els.angle.value = String(a.angleDeg);
  els.gimbal.value = String(a.gimbalPitch);
  els.safeHeight.value = String(a.safeHeightM);
  els.rcLost.value = a.rcLostAction;
  els.finish.value = a.finishAction;
}

els.gateAck.onchange = () => {
  state.gateAck = els.gateAck.checked;
  render();
};

els.terrain.onchange = () => {
  state.terrain = els.terrain.checked;
  state.terrainError = null;
  render();
};

/**
 * Tombol mode pemotretan saja.
 *
 * Dulu ini `document.querySelectorAll('.seg-btn')`, dan begitu tombol pola
 * terbang memakai kelas yang sama, handler mode ikut terpasang di sana dan
 * menimpa handler pola — pilihan pola jadi tidak pernah berubah. Dibatasi ke
 * wadahnya supaya dua kontrol dengan gaya yang sama tidak saling injak.
 */
const modeSegButtons = () => $('mode-seg').querySelectorAll('.seg-btn');

modeSegButtons().forEach((btn) => {
  btn.onclick = () => {
    modeSegButtons().forEach((b) => b.classList.remove('active'));
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

// ---------- Info profil drone & impor kode asli ----------

const elDroneInfo = $('drone-info');
els.droneInfoBtn.onclick = openDroneInfo;
$('btn-close-di').onclick = () => (elDroneInfo.hidden = true);
elDroneInfo.onclick = (e) => {
  if (e.target === elDroneInfo) elDroneInfo.hidden = true;
};

function openDroneInfo() {
  const p = state.profile;
  const drone = findDrone(state.registry, state.droneId);

  $('di-name').textContent = p.name;
  $('di-body').innerHTML = `
    <div class="note ${p.enumVerified ? 'ok' : 'bad'}">
      <span class="ic">${p.enumVerified ? '✓' : '!'}</span>
      <span>${
        p.enumVerified
          ? `Kode drone ${p.droneEnumValue}/${p.droneSubEnumValue}, payload ${p.payloadEnumValue}/${p.payloadSubEnumValue} — dibaca dari file asli DJI Fly.`
          : p.enumKnown
            ? `Kode drone yang dipakai sekarang (${p.droneEnumValue}) masih tebakan. ${esc(p.enumNote ?? '')}`
            : 'Belum ada kode drone untuk model ini. File tetap bisa dibuat, tapi besar kemungkinan ditolak DJI Fly.'
      }</span>
    </div>
    <div class="note info">
      <span class="ic">i</span>
      <span>Spek kamera (${esc(p.lens.name)}, ekuivalen ${p.lens.eq35mm} mm, ${esc(p.mode.label)}) diambil dari spec sheet dan dipakai untuk hitung GSD. Itu bagian yang bisa dipercaya.</span>
    </div>
    ${
      drone.waypoint?.note
        ? `<div class="note warn"><span class="ic">!</span><span>${esc(drone.waypoint.note)}</span></div>`
        : ''
    }
    ${
      drone.limits._status
        ? `<div class="note warn"><span class="ic">!</span><span>${esc(drone.limits._status)}</span></div>`
        : ''
    }
    ${
      p.lens._eq35Status
        ? `<div class="note warn"><span class="ic">!</span><span>${esc(p.lens._eq35Status)}</span></div>`
        : ''
    }`;

  $('btn-di-forget').hidden = !state.enumOverrides[state.droneId];
  $('di-import').hidden = true;
  elDroneInfo.hidden = false;
}

$('di-file').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const box = $('di-import');
  const text = $('di-import-text');
  box.hidden = false;
  box.className = 'note info';
  text.textContent = 'Membaca file…';

  try {
    const enums = await readEnumsFromKmz(file);
    state.enumOverrides = setEnumOverride(state.droneId, enums);
    syncProfile();
    render();

    box.className = 'note ok';
    text.textContent = `Terkunci: drone ${enums.droneEnumValue}/${enums.droneSubEnumValue}, payload ${enums.payloadEnumValue}/${enums.payloadSubEnumValue}${
      enums.namespace ? ` · namespace ${enums.namespace}` : ''
    }. Dipakai untuk semua export ${state.profile.name} mulai sekarang.`;
    $('btn-di-forget').hidden = false;
    toast(`Kode drone ${state.profile.name} terkunci dari file asli.`, 'ok', 6000);
  } catch (err) {
    box.className = 'note bad';
    text.textContent = err.message;
  } finally {
    e.target.value = '';
  }
};

$('btn-di-forget').onclick = () => {
  state.enumOverrides = setEnumOverride(state.droneId, null);
  syncProfile();
  render();
  openDroneInfo();
  toast('Kode impor dilupakan — kembali ke nilai bawaan.', 'ok');
};

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

// ---------- Tampilan 2D / 3D ----------

els.viewSwitch.querySelectorAll('[data-view]').forEach((chip) => {
  chip.onclick = async () => {
    const mode = chip.dataset.view;
    els.viewSwitch.querySelectorAll('[data-view]').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.viewMode = mode;

    if (!applyViewMode(map, mode)) {
      toast('Perangkat ini tidak sanggup menampilkan medan 3D. Tetap di 2D.', 'err', 6000);
      els.viewSwitch.querySelector('[data-view="2d"]').classList.add('active');
      chip.classList.remove('active');
      state.viewMode = '2d';
      return;
    }

    if (mode === '3dobj') await loadBuildingsForPlan();
    else if (mode !== '3dobj') render();
  };
});

/**
 * Bangunan diambil sekali per area, bukan tiap render: Overpass itu layanan
 * sukarela dan membanjirinya dengan permintaan tiap geseran slider adalah cara
 * paling cepat untuk diblokir.
 */
async function loadBuildingsForPlan() {
  const plan = state.plan;
  if (!plan) return toast('Gambar areanya dulu.', 'err');
  if (state.buildingsLoading) return;

  state.buildingsLoading = true;
  state.buildingsError = null;
  toast('Mengambil data bangunan dari OpenStreetMap…', 'info');

  try {
    const { geojson, count, unknown } = await fetchBuildings(planBounds(plan));
    state.buildings = geojson;
    setBuildings(map, geojson);
    toast(
      count
        ? `${count} bangunan dimuat${unknown ? `, ${unknown} dilewati karena tingginya tidak terdata` : ''}. Tinggi dari OSM sering kurang dari aslinya, dan antena di atap tidak terdata sama sekali.`
        : 'Tidak ada data bangunan di area ini. Itu bukan berarti areanya kosong — OSM cuma belum memetakannya.',
      count ? 'ok' : 'info',
      8000
    );
  } catch (err) {
    state.buildingsError = err.message;
    toast(`Gagal mengambil data bangunan: ${err.message}`, 'err', 6000);
  } finally {
    state.buildingsLoading = false;
    render();
  }
}

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

/** Arah sisi terpanjang poligon (derajat, 0–179). Jalur sejajar ini paling sedikit. */
function longestEdgeAngle(xy) {
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
  return Math.round(((best % 180) + 180) % 180);
}

function applyLongestEdgeAngle() {
  if (state.polygon.length < 3) return;
  const [lng0, lat0] = centroid(state.polygon);
  const proj = makeProjector(lat0, lng0);

  // Dipasang sebagai angka eksplisit, bukan dibiarkan 0/otomatis, supaya
  // pengguna melihat arah yang sebenarnya dipakai.
  const deg = longestEdgeAngle(state.polygon.map(proj.toXY)) || 180;
  state.advanced.angleDeg = deg;
  els.angle.value = String(deg);
  render();
}

const labelOf = (select) => select.options[select.selectedIndex]?.textContent.trim() ?? '';

// ---------- Perencanaan ----------

function buildPlan() {
  const { profile, polygon, home } = state;
  if (!profile || polygon.length < 3) return null;

  const [lng0, lat0] = centroid(polygon);
  const proj = makeProjector(lat0, lng0);
  const polyXY = polygon.map(proj.toXY);
  const homeXY = proj.toXY(home ?? polygon[0]);
  const area = polygonArea(polyXY);

  const lim = profile.limits;
  const params = computeSurveyParams(profile.camera, {
    altitudeM: state.altitudeM,
    frontOverlap: Number(els.front.value) / 100,
    sideOverlap: Number(els.side.value) / 100,
    // Jeda jepret ikut mode foto: 48 MP tidak bisa dijepret secepat 12 MP,
    // dan itu langsung membatasi kecepatan terbang.
    minIntervalSec: profile.camera.minIntervalSec,
  });

  const mode = state.mode;
  const stopAtEach = mode === 'stopAndShoot';
  const accel = lim.accelMs2 ?? 2.5;

  const autoSpeed = Math.min(
    stopAtEach ? lim.maxSpeedMs : params.recommendedSpeed,
    lim.maxSpeedMs
  );
  // Kecepatan manual tidak dipaksa turun ke batas aman di sini — kalau
  // melewatinya, gerbang keselamatan yang bilang, bukan kode yang diam-diam
  // membetulkan.
  const speed = state.speedAuto ? autoSpeed : Math.min(state.speedMs, lim.maxSpeedMs);

  // Arah 0 berarti otomatis: ikuti sisi terpanjang supaya jalurnya paling sedikit.
  const angleDeg = state.advanced.angleDeg || longestEdgeAngle(polyXY);

  // Buffer dinyatakan dalam kelipatan jarak antar jalur, jadi nilainya ikut
  // menyesuaikan sendiri saat ketinggian atau overlap diubah.
  const bufferM = Number(els.buffer.value) * params.sideSpacing;
  const gridPoly = offsetPolygon(polyXY, bufferM);

  const gridOpts = {
    angleDeg,
    sideSpacing: params.sideSpacing,
    frontSpacing: params.frontSpacing,
    mode,
    // Poligon yang sudah dibuffer sudah memberi ruang ancang-ancang; overshoot
    // hanya dipakai kalau buffer dimatikan, supaya jalur tidak dobel memanjang.
    overshoot: bufferM > 0 ? 0 : mode === 'continuous' ? params.frontSpacing : 0,
  };

  const grid = generatePattern(gridPoly, { ...gridOpts, pattern: state.pattern });
  if (!grid.waypoints.length) return null;

  // ---- Lanjutan misi ----
  //
  // Titik yang dipilih di peta dipetakan ke waypoint terdekat, lalu jalur
  // dipotong dari situ. Yang sudah terpotret tidak diterbangkan lagi.
  let resume = null;
  if (state.resume) {
    const target = proj.toXY(state.resume.lngLat);
    let best = 0;
    let bestD = Infinity;
    grid.waypoints.forEach((w, i) => {
      const d = Math.hypot(w.xy[0] - target[0], w.xy[1] - target[1]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });

    const skipped = grid.waypoints.slice(0, best);
    grid.waypoints = grid.waypoints.slice(best);
    grid.photos = grid.waypoints.reduce((n, w) => n + (w.photos || 0), 0);

    resume = {
      index: best,
      snapDistM: bestD,
      skippedWaypoints: skipped.length,
      skippedPhotos: skipped.reduce((n, w) => n + (w.photos || 0), 0),
      lngLat: proj.toLL(grid.waypoints[0]?.xy ?? target),
    };

    if (!grid.waypoints.length) return null;
  }

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
    const bare = generatePattern(polyXY, {
      ...gridOpts,
      pattern: state.pattern,
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
    pattern: state.pattern,
    patternName: PATTERNS[state.pattern].name,
    gimbalPitch: state.advanced.gimbalPitch,
    advanced: {
      ...state.advanced,
      angleDeg,
      autoAngle: !state.advanced.angleDeg,
      rcLostActionLabel: labelOf(els.rcLost),
      finishActionLabel: labelOf(els.finish),
    },
    resume,
    autoSpeed,
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
  // Semua pemeriksaan tinggal di src/safety.js supaya tidak ada yang lolos
  // diam-diam, dan supaya CLI bisa memakai pemeriksaan yang sama persis.
  const result = evaluateSafety(plan, state.profile, { obstacles: plan.obstacles });
  state.safety = result;
  return result.findings;
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
    els.gate.hidden = true;
    els.patternCost.hidden = true;
    els.resumeReadout.hidden = true;
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

  map.getSource('resume')?.setData(
    plan.resume
      ? { type: 'Feature', geometry: { type: 'Point', coordinates: plan.resume.lngLat } }
      : EMPTY
  );

  els.area.hidden = false;
  els.areaVal.textContent = fmtArea(plan.area);

  // Sejak ada buffer, yang diterbangi lebih luas dari lahan yang digambar —
  // dan itulah yang menentukan waktu dan jumlah foto.
  els.flown.hidden = plan.bufferM <= 0;
  els.flownVal.textContent = `${fmtArea(plan.gridArea)} (+${Math.round((plan.gridArea / plan.area - 1) * 100)}%)`;

  renderTerrainStatus(plan);
  ensureTerrain(plan);
  updateTileEstimate(plan);

  // Rintangan dihitung sebelum pemeriksaan keselamatan, karena salah satu
  // pemeriksaannya memang tentang itu.
  plan.obstacles = state.buildings
    ? obstaclesNearPath(state.buildings, {
        proj: plan.proj,
        pathLL: plan.grid.waypoints.map((w) => plan.proj.toLL(w.xy)),
        altitudeM: plan.altitude,
      })
    : null;

  updateDerived(plan);
  renderStats(plan);
  renderSorties(plan);
  renderLegend(plan);
  renderWarnings(checkWarnings(plan));
  renderGate();
  renderPatternCost(plan);
  renderResume(plan);

  els.sheetSummary.textContent =
    `${fmtArea(plan.area)} · ${plan.altitude.toFixed(0)} m · ${fmtDur(plan.duration)} · ` +
    `${plan.sorties.length} baterai`;

  syncUrl();
}

function updateDerived(plan) {
  els.frontOut.textContent = `${els.front.value}%`;
  els.sideOut.textContent = `${els.side.value}%`;
  els.angleOut.textContent = state.advanced.angleDeg
    ? `${state.advanced.angleDeg}°`
    : plan
      ? `otomatis · ${plan.advanced.angleDeg}°`
      : 'otomatis';
  els.gimbalOut.textContent = `${state.advanced.gimbalPitch}°`;
  els.safeHeightOut.textContent = `${state.advanced.safeHeightM} m`;

  const mult = Number(els.buffer.value);
  els.bufferOut.textContent = mult === 0 ? 'mati' : `${mult.toFixed(1)}× jalur`;

  if (!state.profile) return;

  // Ketinggian adalah input utama; GSD-nya yang diturunkan. Ini kebalikan dari
  // versi sebelumnya, dan sengaja: di lapangan orang berpikir dalam meter.
  els.alt.value = String(state.altitudeM);
  els.altOut.textContent = `${state.altitudeM} m`;

  const gsd = gsdFromAltitude(state.profile.camera, state.altitudeM);
  els.gsdDerived.textContent = `${gsd.toFixed(2)} cm/px`;

  const p = computeSurveyParams(state.profile.camera, {
    altitudeM: state.altitudeM,
    frontOverlap: Number(els.front.value) / 100,
    sideOverlap: Number(els.side.value) / 100,
    minIntervalSec: state.profile.camera.minIntervalSec,
  });

  const shown = plan ? plan.speed : Math.min(p.recommendedSpeed, state.profile.limits.maxSpeedMs);
  if (state.speedAuto) {
    state.speedMs = shown;
    els.speed.value = String(shown.toFixed(1));
  }
  els.speedOut.textContent = `${shown.toFixed(1)} m/s`;
  els.speedNote.textContent = state.speedAuto
    ? `Batas blur ${p.maxSpeedBlur.toFixed(1)} m/s · batas jeda jepret ${p.maxSpeedInterval.toFixed(1)} m/s (${state.profile.mode.label}).`
    : `Diatur manual. Batas amannya ${Math.min(p.maxSpeedBlur, p.maxSpeedInterval).toFixed(1)} m/s.`;

  const meters = mult === 0 ? 'tepat di batas' : `${(mult * p.sideSpacing).toFixed(0)} m`;
  const cost = plan?.bufferCost;
  els.bufferM.textContent =
    cost && cost.photos > 0
      ? `${meters} — biayanya +${cost.photos} foto, +${fmtDur(cost.seconds)}`
      : meters;

  renderPresets();
  renderEnumBadge();
}

/** Tiap preset menampilkan ketinggian yang DIA hasilkan di drone yang aktif. */
function renderPresets() {
  const active = matchPreset({
    gsdCm: gsdFromAltitude(state.profile.camera, state.altitudeM),
    frontOverlap: Number(els.front.value) / 100,
    sideOverlap: Number(els.side.value) / 100,
  });
  state.presetId = active?.id ?? null;

  for (const p of PRESETS) {
    const sub = els.presets.querySelector(`[data-sub="${p.id}"]`);
    if (!sub) continue;
    const alt = altitudeFromGsd(state.profile.camera, p.gsdCm);
    sub.textContent = `${alt.toFixed(0)} m · ${Math.round(p.frontOverlap * 100)}/${Math.round(p.sideOverlap * 100)}`;
  }

  els.presets.querySelectorAll('[data-preset]').forEach((b) => {
    const isCustom = b.dataset.preset === 'custom';
    b.classList.toggle('active', isCustom ? !state.presetId : b.dataset.preset === state.presetId);
  });

  const preset = state.presetId ? findPreset(state.presetId) : null;
  els.presetNote.textContent = preset
    ? preset.note
    : 'Diatur sendiri. Preset menyimpan ketelitian yang dituju, jadi artinya tetap sama waktu drone diganti.';
}

function renderEnumBadge() {
  const p = state.profile;
  els.enumBadge.hidden = false;
  els.enumBadge.className = `enum-badge ${p.enumVerified ? 'ok' : 'warn'}`;
  els.enumBadge.textContent = p.enumVerified
    ? `Kode drone terkunci dari file asli (${p.droneEnumValue})`
    : p.enumKnown
      ? 'Kode drone masih tebakan — ketuk i untuk menguncinya'
      : 'Kode drone belum ada — ketuk i untuk menguncinya';
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
      <span class="k">GSD</span>
      <span class="v">${plan.params.gsd.toFixed(2)}<small>cm/px</small></span>
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
    </div>
    <div class="stat full">
      <span class="k">Drone · lensa · pola</span>
      <span class="v sm">${esc(state.profile.name)} · ${esc(state.profile.lens.name)} ${esc(state.profile.mode.label)} · ${esc(plan.patternName)} ${plan.gimbalPitch}°</span>
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

/**
 * Gerbang keselamatan: satu pintu yang harus dilewati semua rencana.
 *
 * Temuan merah tidak membatalkan apa pun sendiri — pengguna tetap boleh
 * lanjut, tapi harus mencentang bahwa dia sudah membacanya. Yang dilarang di
 * sini bukan keputusan pengguna, melainkan export yang terjadi tanpa dia tahu.
 */
function renderGate() {
  const s = state.safety;
  const blocked = !!s?.blockers.length;

  els.gate.hidden = !blocked;
  if (blocked) {
    els.gateTitle.textContent =
      s.blockers.length === 1
        ? '1 masalah keselamatan di rencana ini'
        : `${s.blockers.length} masalah keselamatan di rencana ini`;
    els.gateAck.checked = state.gateAck;
  } else {
    state.gateAck = false;
    els.gateAck.checked = false;
  }

  els.export.disabled = blocked && !state.gateAck;
  els.export.textContent = blocked && state.gateAck ? 'Export KMZ (dengan risiko)' : 'Export KMZ';
}

function renderPatternCost(plan) {
  if (plan.pattern === 'single') {
    els.patternCost.hidden = true;
    return;
  }
  els.patternCost.hidden = false;
  els.patternCostVal.textContent = `${plan.grid.photos} foto · ${fmtDur(plan.duration)} · ${plan.sorties.length} baterai`;
}

// ---------- Lanjutkan misi ----------

function renderResume(plan) {
  const r = plan.resume;
  els.resumeReadout.hidden = !r;
  els.resumeClear.hidden = !r;
  els.resumePick.classList.toggle('active', state.resumePicking);
  els.resumePick.textContent = state.resumePicking
    ? 'Ketuk titik terakhir di peta…'
    : r
      ? 'Pilih ulang di peta'
      : 'Pilih di peta';

  if (!r) return;
  els.resumeStatus.textContent = `Lanjut dari waypoint #${r.index + 1}`;
  els.resumeVal.textContent = `${r.skippedPhotos} foto dilewati · geser ${r.snapDistM.toFixed(0)} m`;
}

els.resumePick.onclick = () => {
  if (!state.plan) return toast('Gambar areanya dulu.', 'err');
  state.resumePicking = !state.resumePicking;
  map.getCanvas().style.cursor = state.resumePicking ? 'crosshair' : '';
  render();
};

els.resumeClear.onclick = () => {
  state.resume = null;
  state.resumePicking = false;
  map.getCanvas().style.cursor = '';
  render();
};

els.resumeGps.onclick = () => {
  if (!navigator.geolocation) return toast('Browser ini tidak punya GPS.', 'err');
  if (!state.plan) return toast('Gambar areanya dulu.', 'err');

  els.resumeGps.classList.add('busy');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      els.resumeGps.classList.remove('busy');
      // Lokasi KAMU, bukan lokasi drone. Berguna karena biasanya kamu berdiri
      // dekat tempat drone berhenti — tapi itu tetap perkiraan, dan titiknya
      // di-snap ke waypoint terdekat, jadi hasilnya tetap koordinat rencana.
      setResumePoint([pos.coords.longitude, pos.coords.latitude]);
      toast(
        `Dipakai lokasi kamu (akurasi ±${pos.coords.accuracy.toFixed(0)} m). Cek titiknya di peta — itu posisi kamu, bukan posisi drone.`,
        'info',
        7000
      );
    },
    () => {
      els.resumeGps.classList.remove('busy');
      toast('Tidak bisa membaca lokasi.', 'err');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

function setResumePoint(lngLat) {
  state.resume = { lngLat };
  state.resumePicking = false;
  map.getCanvas().style.cursor = '';
  render();
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
    droneId: state.droneId,
    lensId: state.lensId,
    modeId: state.modeId,
    altitudeM: state.altitudeM,
    speedMs: state.speedMs,
    speedAuto: state.speedAuto,
    pattern: state.pattern,
    advanced: { ...state.advanced },
    terrain: state.terrain,
    front: Number(els.front.value),
    side: Number(els.side.value),
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
  els.front.value = p.front;
  els.side.value = p.side;
  els.buffer.value = p.buffer ?? 1;

  // Project lama (skema 1) tidak menyimpan ketinggian sama sekali — dulu
  // selalu diturunkan dari GSD. Jadi di sini GSD-nya yang dipakai untuk
  // menghitung ulang ketinggian, memakai kamera drone yang tersimpan.
  state.droneId = p.droneId ?? 'mini5pro';
  state.lensId = p.lensId ?? '';
  state.modeId = p.modeId ?? '';
  state.pattern = p.pattern ?? 'single';
  state.speedAuto = p.speedAuto ?? true;
  state.advanced = { ...SAFE_ADVANCED, ...(p.advanced ?? {}) };
  syncProfile();
  buildDronePickers();

  state.altitudeM = p.altitudeM ?? clampAltitude(altitudeFromGsd(state.profile.camera, p.gsdTarget ?? p.gsd ?? 2));
  state.speedMs = p.speedMs ?? state.speedMs;
  state.terrain = !!p.terrain;
  els.terrain.checked = state.terrain;
  state.resume = null;

  syncAdvancedInputs();
  els.speedAuto.checked = state.speedAuto;
  els.patternSeg.querySelectorAll('[data-pattern]').forEach((b) => {
    b.classList.toggle('active', b.dataset.pattern === state.pattern);
  });
  els.patternHint.textContent = PATTERN_HINT[state.pattern];

  if (p.migratedFrom) {
    toast(
      `Project ini dibuat versi lama (skema ${p.migratedFrom}). Ketinggiannya dihitung ulang dari ketelitian yang tersimpan — cek dulu sebelum terbang.`,
      'info',
      8000
    );
  }

  modeSegButtons().forEach((b) => {
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
      gimbalPitch: plan.gimbalPitch,
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

  // Pengaman kedua, selain tombol yang dinonaktifkan: export lewat jalur lain
  // (keyboard, skrip) tidak boleh menembus gerbang keselamatan.
  if (state.safety && !state.safety.ok && !state.gateAck) {
    toast('Masih ada masalah keselamatan yang belum dibaca. Centang dulu di atas tombol.', 'err', 6000);
    return;
  }

  els.export.disabled = true;
  const original = els.export.textContent;
  els.export.textContent = 'Membuat file…';

  try {
    const base =
      (els.projName.value.trim() || 'survei').replace(/[^\w\-]+/g, '-') +
      (plan.resume ? '-lanjut' : '') +
      (plan.pattern === 'single' ? '' : '-silang');
    const stamp = new Date().toISOString().slice(0, 10);

    const files = plan.sorties.map((sortie, i) => {
      const bytes = buildKmz(
        {
          waypoints: planWaypointsToMission(plan, sortie),
          height: plan.altitude,
          speed: plan.speed,

          // Setelan lanjutan ikut masuk file, bukan cuma jadi tampilan.
          finishAction: plan.advanced.finishAction,
          exitOnRCLost: 'executeLostAction',
          executeRCLostAction: plan.advanced.rcLostAction,

          // Naik dulu ke ketinggian aman sebelum menyeberang ke titik mulai.
          // Untuk sortie kedua dan misi lanjutan, inilah yang mencegah drone
          // melintas rendah di atas area yang belum tentu kosong.
          takeOffSecurityHeight: plan.advanced.safeHeightM,
          flyToWaylineMode: 'safely',

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
    alt: state.altitudeM,
    f: Number(els.front.value),
    s: Number(els.side.value),
    b: Number(els.buffer.value),
    m: state.mode === 'stopAndShoot' ? 1 : 0,
    d: state.droneId,
    l: state.lensId,
    pm: state.modeId,
    pt: state.pattern,
    sp: state.speedAuto ? null : state.speedMs,
    tf: state.terrain ? 1 : 0,
    adv: state.advanced,
    v: SCHEMA_VERSION,
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

    els.front.value = d.f;
    els.side.value = d.s;
    els.buffer.value = d.b ?? 1;
    state.mode = d.m ? 'stopAndShoot' : 'continuous';

    // Link lama (skema 1) membawa `g` = GSD dan tidak membawa drone sama
    // sekali. Diperlakukan sebagai Mini 5 Pro, lalu ketinggiannya dihitung
    // ulang — sama seperti project lama.
    state.droneId = d.d ?? 'mini5pro';
    state.lensId = d.l ?? '';
    state.modeId = d.pm ?? '';
    state.pattern = d.pt ?? 'single';
    state.terrain = !!d.tf;
    els.terrain.checked = state.terrain;
    state.advanced = { ...SAFE_ADVANCED, ...(d.adv ?? {}) };
    syncProfile();
    buildDronePickers();
    syncAdvancedInputs();

    state.altitudeM = d.alt ?? clampAltitude(altitudeFromGsd(state.profile.camera, d.g ?? 2));
    state.speedAuto = d.sp == null;
    state.speedMs = d.sp ?? state.speedMs;
    els.speedAuto.checked = state.speedAuto;
    els.patternSeg.querySelectorAll('[data-pattern]').forEach((b) => {
      b.classList.toggle('active', b.dataset.pattern === state.pattern);
    });
    els.patternHint.textContent = PATTERN_HINT[state.pattern];
    modeSegButtons().forEach((b) => {
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
