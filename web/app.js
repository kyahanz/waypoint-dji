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
  generateOrbit,
  ORBIT_DEFAULTS,
  maxSpeedForBlur,
  PATTERNS,
  offsetPolygon,
  pathLengthXY,
  missionDuration,
  peakSpeedOverLeg,
  medianLegM,
  resumeIndexFor,
  splitByRole,
  sortieSummary,
  maxDistanceFrom,
  altitudeFromGsd,
  gsdFromAltitude,
  surfaceGsd,
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
import { createMissionEditor } from './mission-editor.js';
import { readLastPhoto } from './exif.js';
import {
  installTerrainSources,
  applyViewMode,
  fetchBuildings,
  setBuildings,
  obstaclesNearPath,
} from './view3d.js';
import { buildKmz, downloadBlob } from './kmz.js';
import { fetchElevations, cachedElevation, missingCoords, reliefOf } from '../src/terrain.js';
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
  // Ketinggian pulang otomatis. Dulu ikut safeHeightM, dan itu menurunkan RTH
  // jadi 20 m tanpa ada yang meminta — lihat catatan di updateDerived.
  rthHeightM: 100,
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
  // Setelan pola orbit. Dipisah dari `advanced` karena ini bukan setelan
  // lanjutan yang jarang disentuh — di mode orbit, inilah rencananya.
  orbit: {
    objectHeightM: 20,
    radiusM: 18,
    rings: ORBIT_DEFAULTS.rings,
    stepDeg: ORBIT_DEFAULTS.maxAngleStepDeg,
    maxPitchDeg: ORBIT_DEFAULTS.maxPitchDeg,
    cap: true,
    headingMode: 'smoothTransition',
  },
  advanced: { ...SAFE_ADVANCED },
  gateAck: false,
  // File KMZ yang sedang DISEMBUNYIKAN dari peta. Disimpan sebagai "yang
  // disembunyikan", bukan "yang tampil", supaya keadaan normal — semua tampil —
  // adalah himpunan kosong, bukan daftar yang harus diisi ulang tiap rencana
  // berubah. Isinya cuma tampilan: tidak masuk file, tidak masuk link, dan
  // tidak mengubah apa pun yang diexport.
  fileHidden: new Set(),
  fileCount: 0,
  resume: null, // { index, lngLat }
  resumePicking: false,
  viewMode: '2d',
  buildings: null,
  buildingsLoading: false,
  buildingsError: null,
  polygon: [],
  home: null, // [lng, lat]
  mode: 'stopAndShoot',
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

// ---------- Tema ----------
//
// Bawaannya ikut sistem, dan sistem di HP biasanya terang di siang hari —
// yang memang keadaan alat ini dipakai. Pilihan manual tetap ada karena
// orang punya alasan sendiri, dan pilihannya diingat antar sesi.

const THEMES = [
  { id: 'auto', label: 'Tema: ikut sistem' },
  { id: 'light', label: 'Tema: terang' },
  { id: 'dark', label: 'Tema: gelap' },
];

function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];

  if (theme.id === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme.id;

  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = theme.label;
  return theme.id;
}

// Dipasang sebelum apa pun digambar, supaya tidak ada kedipan putih-ke-gelap.
let themeId = applyTheme(settings.theme ?? 'auto');

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
let missionEditor = null;

// Penanda titik mulai dan selesai tiap file KMZ. Dibuat sebagai elemen DOM,
// bukan layer teks MapLibre, karena style peta ini berbasis raster dan tidak
// punya glyphs — layer `symbol` dengan `text-field` tidak akan menggambar
// apa-apa di atasnya. Jumlahnya paling banyak dua kali jumlah file, jadi
// marker DOM masih jauh lebih murah daripada memasang sumber glyph sendiri.
let fileEndMarkers = [];

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

  missionEditor = createMissionEditor({
    map,
    toast,
    $,
    // Saat misi dibuka, perencana area disembunyikan: dua mode yang bekerja
    // di peta yang sama akan saling menimpa kalau dibiarkan hidup bersama.
    onModeChange: (editing) => {
      if (editing) {
        editor.clear();
        state.resume = null;
        state.resumePicking = false;
      }
      render();
    },
  });

  // Pegangan untuk inspeksi dari konsol saat mengembangkan prototipe.
  window.__wp = { map, editor, state, missionEditor };
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
  gsdObliqueNote: $('gsd-oblique-note'),
  speed: $('speed'),
  speedOut: $('speed-out'),
  speedAuto: $('speed-auto'),
  speedNote: $('speed-note'),
  patternSeg: $('pattern-seg'),
  patternHint: $('pattern-hint'),
  orbitFields: $('orbit-fields'),
  objHeight: $('obj-height'),
  objHeightOut: $('obj-height-out'),
  orbitRadius: $('orbit-radius'),
  orbitRadiusOut: $('orbit-radius-out'),
  orbitRings: $('orbit-rings'),
  orbitRingsOut: $('orbit-rings-out'),
  orbitStep: $('orbit-step'),
  orbitStepOut: $('orbit-step-out'),
  orbitMaxPitch: $('orbit-maxpitch'),
  orbitMaxPitchOut: $('orbit-maxpitch-out'),
  orbitCap: $('orbit-cap'),
  orbitPoi: $('orbit-poi'),
  orbitRingsTable: $('orbit-rings-table'),
  orbitGsd: $('orbit-gsd'),
  fieldAlt: $('field-alt'),
  fieldOverlap: $('field-overlap'),
  fieldBuffer: $('field-buffer'),
  fieldMode: $('field-mode'),
  patternCost: $('pattern-cost'),
  patternCostVal: $('pattern-cost-val'),
  gimbal: $('gimbal'),
  gimbalOut: $('gimbal-out'),
  gimbalNote: $('gimbal-note'),
  rcLost: $('rc-lost'),
  finish: $('finish'),
  safeHeight: $('safe-height'),
  rthHeight: $('rth-height'),
  rthHeightOut: $('rth-height-out'),
  safeHeightOut: $('safe-height-out'),
  resetAdv: $('btn-reset-adv'),
  gate: $('gate'),
  gateTitle: $('gate-title'),
  gateAck: $('gate-ack'),
  resumePick: $('btn-resume-pick'),
  resumePhoto: $('resume-photo'),
  resumePhotoLabel: $('resume-photo-label'),
  resumePhotoNote: $('resume-photo-note'),
  resumePhotoText: $('resume-photo-text'),
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
  offlineBadge: $('offline-badge'),
  bufferOut: $('buffer-out'),
  bufferM: $('buffer-m'),
  frontOut: $('front-out'),
  sideOut: $('side-out'),
  angleOut: $('angle-out'),
  angleAuto: $('angle-auto'),
  angleNote: $('angle-note'),
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
els.autoAngle.onclick = applyLongestEdgeAngle;
els.save.onclick = onSave;
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
$('btn-theme').onclick = () => {
  const next = THEMES[(THEMES.findIndex((t) => t.id === themeId) + 1) % THEMES.length];
  themeId = applyTheme(next.id);
  settings = setSettings({ theme: themeId });
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

function wireOrbitInputs() {
  const bind = (el, key, parse = Number) => {
    el.oninput = () => {
      state.orbit[key] = parse(el.value);
      render();
    };
  };
  bind(els.objHeight, 'objectHeightM');
  bind(els.orbitRadius, 'radiusM');
  bind(els.orbitRings, 'rings');
  bind(els.orbitStep, 'stepDeg');
  bind(els.orbitMaxPitch, 'maxPitchDeg');
  els.orbitCap.onchange = () => {
    state.orbit.cap = els.orbitCap.checked;
    render();
  };
  // Saklar, bukan dua tombol setara: yang satu bawaan dan yang satu jalan
  // keluar. Nilai yang disimpan tetap nama mode-nya, supaya project dan link
  // lama tidak perlu dimigrasi.
  els.orbitPoi.onchange = () => {
    state.orbit.headingMode = els.orbitPoi.checked ? 'towardPOI' : 'smoothTransition';
    render();
  };
}
wireOrbitInputs();

/** Kembalikan kontrol orbit ke isi state — dipakai saat memuat project/link. */
function syncOrbitInputs() {
  const o = state.orbit;
  els.objHeight.value = String(o.objectHeightM);
  els.orbitRadius.value = String(o.radiusM);
  els.orbitRings.value = String(o.rings);
  els.orbitStep.value = String(o.stepDeg);
  els.orbitMaxPitch.value = String(o.maxPitchDeg);
  els.orbitCap.checked = !!o.cap;
  els.orbitPoi.checked = o.headingMode === 'towardPOI';
  syncPatternFields();
}

// Akhiran nama file per pola. Dulu semua yang bukan peta datar disebut
// '-silang', dan 3D bangunan ikut kebawa — nama file yang menyebut pola yang
// salah bikin susah waktu ada beberapa KMZ di satu folder HP.
const PATTERN_SUFFIX = {
  single: '',
  cross: '-silang',
  crossOblique: '-miring',
  building3d: '-3d',
  orbit: '-orbit',
};

/**
 * Pola yang tidak lagi ditawarkan di layar, tapi masih dipahami engine.
 *
 * Kenapa dicabut dari pilihan: peringatan keselamatannya sendiri menyuruh
 * pengguna pindah. 'cross' disuruh ke silang + miring untuk bangunan, dan
 * 'crossOblique' disuruh ke 3D bangunan karena kehilangan lintasan nadirnya.
 * Menu dengan dua item yang peringatannya menunjuk item lain bukan pilihan —
 * itu jebakan yang diberi label pilihan.
 *
 * Kenapa TIDAK dihapus dari PATTERNS: project tersimpan dan link rencana yang
 * sudah dibagikan menyimpan nama pola sebagai teks. Menghapusnya membuat
 * PATTERNS[pattern].name dan .gimbalPitch jadi undefined, dan rencana lama
 * gagal terbuka — bukan sekadar berubah. Jadi engine tetap paham lima, layar
 * cuma menawarkan tiga, dan rencana lama tetap jalan apa adanya.
 */
const PATTERN_RETIRED = {
  cross: {
    label: 'Silang',
    saran: '3D bangunan',
    alasan:
      'dua lintasan nadir memperbaiki medan, tapi dinding tegak tetap tipis terpotret',
  },
  crossOblique: {
    label: 'Miring saja',
    saran: '3D bangunan',
    alasan:
      'semua fotonya -45°, jadi atap dan skala tanah tidak pernah tertangkap — dan menerbangkan nadirnya sebagai rencana terpisah menyerahkan titik lepas landas yang sama ke ingatan',
  },
};

/**
 * Setel tombol pola ke isi state, dan kalau polanya sudah tidak ditawarkan,
 * munculkan tombolnya sendiri supaya yang aktif tetap kelihatan.
 *
 * Dulu blok penyetelan ini disalin di tiga tempat (tombol, muat project, muat
 * link) dan gampang lupa disamakan. Sekarang satu pintu.
 */
function syncPatternButtons() {
  const seg = els.patternSeg;

  // Tombol pola lama hanya ada selama pola itu yang sedang dipakai.
  seg.querySelector('[data-retired]')?.remove();

  if (PATTERN_RETIRED[state.pattern] && !seg.querySelector(`[data-pattern="${state.pattern}"]`)) {
    const btn = document.createElement('button');
    btn.className = 'seg-btn';
    btn.dataset.pattern = state.pattern;
    btn.dataset.retired = '1';
    btn.textContent = `${PATTERN_RETIRED[state.pattern].label} (lama)`;
    btn.onclick = () => {};
    seg.appendChild(btn);
  }

  seg.querySelectorAll('[data-pattern]').forEach((b) => {
    b.classList.toggle('active', b.dataset.pattern === state.pattern);
  });

  els.patternHint.textContent = PATTERN_HINT[state.pattern] ?? '';
  syncPatternFields();
}

/** Beri tahu sekali kalau rencana yang dibuka memakai pola yang sudah dicabut. */
function noticeRetiredPattern() {
  const r = PATTERN_RETIRED[state.pattern];
  if (!r) return;
  toast(
    `Rencana ini memakai pola "${r.label}", yang sudah tidak ditawarkan lagi — ${r.alasan}. Rencananya tetap jalan apa adanya. Kalau mau dibuat ulang, pakai ${r.saran}.`,
    'info',
    9000
  );
}

const PATTERN_HINT = {
  single: 'Satu arah, kamera nunduk lurus. Untuk ortofoto dan ukur luas.',
  cross:
    'Dua arah menyilang 90°. Objek tegak terpotret dari dua sisi, jadi model 3D-nya tidak bolong. Foto dan waktu jadi dua kali lipat.',
  crossOblique:
    'Hanya lintasan miring -45°, tanpa nadir. Dipakai kalau foto nadirnya sudah kamu punya dari misi lain — kalau belum, pakai 3D bangunan supaya titik lepas landasnya dijamin sama.',
  building3d:
    'Satu lintasan nadir -90° untuk atap dan skala tanah, plus dua lintasan miring -45° menyilang untuk fasad. Satu rencana, tapi di-export jadi satu file per lintasan: tiap file muat satu baterai dan bisa diterbangkan ulang sendiri kalau gagal. Semua fotonya diolah bersama dalam satu project.',
  orbit:
    'Mengelilingi satu objek tegak di beberapa tingkat ketinggian, kamera selalu menghadap ke dalam. Untuk tugu, menara, patung — benda yang sempit tapi tinggi, yang isinya ada di dinding, bukan di tanah.',
};

/**
 * Field mana yang berlaku untuk pola mana.
 *
 * Orbit tidak punya ketinggian tunggal (tiap cincin punya sendiri), tidak
 * punya overlap jalur (yang mengikat langkah sudut), dan tidak punya tepi
 * lahan (jadi buffer tidak berarti apa-apa). Menyembunyikannya lebih jujur
 * daripada membiarkan slider yang tidak terpakai tetap terlihat berfungsi.
 */
function syncPatternFields() {
  const orbit = state.pattern === 'orbit';
  els.orbitFields.hidden = !orbit;
  els.fieldAlt.hidden = orbit;
  els.fieldOverlap.hidden = orbit;
  els.fieldBuffer.hidden = orbit;
  // Orbit memaksa berhenti sejenak di buildOrbitPlan — pada jarak sekitar 3 m
  // antar foto, melintas terus berarti kamera tidak sempat menjepret. Tombol
  // modenya tetap bisa diklik tapi tidak mengubah apa pun, jadi disembunyikan.
  els.fieldMode.hidden = orbit;
}

els.patternSeg.querySelectorAll('[data-pattern]').forEach((btn) => {
  btn.onclick = () => {
    els.patternSeg.querySelectorAll('[data-pattern]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.pattern = btn.dataset.pattern;
    syncPatternButtons();

    // Pola yang mencampur sudut gimbal TIDAK boleh ikut satu angka: tiap
    // lintasan (atau tiap cincin, di orbit) punya pitch-nya sendiri. Memasang
    // satu nilai di sini akan menimpa semuanya — orbit jadi lingkaran datar
    // yang menyorot satu arah, dan 3D bangunan kehilangan lintasan nadirnya.
    if (state.pattern !== 'orbit' && !PATTERNS[state.pattern]?.mixedGimbal) {
      // Gimbal mengikuti pola, karena itulah yang membedakan silang biasa dari
      // silang yang benar-benar berguna untuk 3D. Tetap bisa diubah manual.
      state.advanced.gimbalPitch = PATTERNS[state.pattern]?.gimbalPitch ?? -90;
      els.gimbal.value = String(state.advanced.gimbalPitch);
    }
    render();
  };
});

// ---------- Pengaturan lanjutan ----------

els.angle.addEventListener('input', () => {
  state.advanced.angleDeg = Number(els.angle.value) || 0;
  // Mengetik sudut berarti tidak otomatis lagi. Tanpa ini, saklar bilang
  // "otomatis" sementara angka yang diketik yang dipakai.
  if (state.advanced.angleDeg) els.angleAuto.checked = false;
  render();
});

els.angleAuto.addEventListener('change', () => {
  if (els.angleAuto.checked) {
    state.advanced.angleDeg = 0;
    els.angle.value = '0';
  } else if (!state.advanced.angleDeg) {
    // Dilepas dari otomatis tanpa angka: isi dengan arah yang sedang dipakai,
    // supaya titik awalnya jelas alih-alih melompat ke 0.
    // 0 tidak bisa disimpan sebagai arah manual (0 berarti otomatis), tapi 180
    // menghasilkan jalur yang sama persis — cuma arah mulainya terbalik. Jadi
    // arah yang sedang dipakai tetap dipertahankan, bukan melompat ke angka
    // lain. Trik yang sama sudah dipakai applyLongestEdgeAngle().
    const dipakai = state.plan?.advanced?.angleDeg ?? 0;
    state.advanced.angleDeg = dipakai || 180;
    els.angle.value = String(state.advanced.angleDeg);
  }
  render();
});

els.gimbal.addEventListener('input', () => {
  state.advanced.gimbalPitch = Number(els.gimbal.value);
  render();
});

/**
 * Memilih file mana yang jalurnya tampil di peta.
 *
 * Dua cara, karena ada dua pertanyaan yang berbeda. "File ini jalurnya yang
 * mana?" dijawab dengan mengklik nama filenya: file itu tampil sendiri, klik
 * lagi semuanya kembali. "Dua file ini tumpang tindih tidak?" dijawab dengan
 * centang: matikan yang tidak perlu, sisanya dibandingkan berdampingan.
 *
 * Keduanya cuma mengubah apa yang digambar. Tidak ada file yang dikeluarkan
 * dari export karena tidak dicentang — itu akan membuat orang tanpa sadar
 * menerbangkan lahan yang bolong, dan diam-diam mengubah isi unduhan adalah
 * hal terakhir yang boleh dilakukan panel ini.
 */
els.sorties.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-file]');
  if (!cb) return;
  const i = Number(cb.dataset.file);
  const next = new Set(state.fileHidden);
  if (cb.checked) next.delete(i);
  else next.add(i);
  setFileHidden(next);
});

els.sorties.addEventListener('click', (e) => {
  if (e.target.closest('[data-file-all]')) {
    setFileHidden(new Set());
    return;
  }

  const solo = e.target.closest('[data-solo]');
  if (!solo) return;
  const i = Number(solo.dataset.solo);
  const n = state.plan?.sorties.length ?? 0;
  const sudahSendiri = !state.fileHidden.has(i) && state.fileHidden.size === n - 1;
  setFileHidden(
    sudahSendiri ? new Set() : new Set([...Array(n).keys()].filter((k) => k !== i))
  );
});

els.projName.addEventListener('input', () => {
  // Nama proyek masuk ke nama file, dan daftar file menampilkan nama itu apa
  // adanya. Tanpa ini daftarnya memajang nama lama sampai ada hal lain yang
  // berubah — persis kebohongan yang dicegah namaFileKmz.
  if (state.plan) renderSorties(state.plan);
});

els.safeHeight.addEventListener('input', () => {
  state.advanced.safeHeightM = Number(els.safeHeight.value);
  render();
});

els.rthHeight.addEventListener('input', () => {
  state.advanced.rthHeightM = Number(els.rthHeight.value);
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
  state.advanced = {
    ...SAFE_ADVANCED,
    gimbalPitch: PATTERNS[state.pattern]?.gimbalPitch ?? SAFE_ADVANCED.gimbalPitch,
  };
  syncAdvancedInputs();
  render();
  toast('Setelan lanjutan dikembalikan: RTH saat sinyal hilang, RTH setelah selesai.', 'ok');
};

function syncAdvancedInputs() {
  const a = state.advanced;
  els.angle.value = String(a.angleDeg);
  els.gimbal.value = String(a.gimbalPitch);
  els.safeHeight.value = String(a.safeHeightM);
  els.rthHeight.value = String(a.rthHeightM ?? SAFE_ADVANCED.rthHeightM);
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

/**
 * Dua mode ini dulu soal CARA memotret: jepret per jarak vs berhenti tiap
 * titik. Sejak perintah jepret-per-jarak dibuang — tidak ada satu pun contoh
 * nyata yang memakainya, dan file yang memakainya ditolak DJI Fly — keduanya
 * sama-sama menjepret di setiap titik.
 *
 * Yang tersisa sebagai pembeda cuma jedanya. Dan itu tetap pilihan yang nyata,
 * jadi tidak dihapus: jeda menukar waktu dengan ketajaman.
 */
const HOVER_SEC = 1; // sama dengan contoh file yang terbukti bentuknya

const MODE_HINT = {
  stopAndShoot:
    'Drone berhenti sebentar di tiap titik sebelum menjepret. Foto paling tajam, dan ini satu-satunya bentuk yang cocok dengan contoh file yang kita punya.',
  continuous:
    'Drone melintas tanpa berhenti, menjepret sambil jalan. Belum ada contoh nyata yang bentuknya begini, jadi belum tentu diterima DJI Fly.',
};

/**
 * Keterangan mode jeda, dengan ongkos mode satunya dalam angka.
 *
 * "Lebih cepat" itu benar tapi tidak bisa dipakai memutuskan — apalagi karena
 * yang ditukar adalah bentuk file yang belum terbukti diterima. Ternyata
 * selisihnya besar: 43-59% tergantung luas lahan. Angka sebesar itu pantas
 * muncul di sebelah tombolnya, bukan disimpulkan sendiri oleh pengguna.
 */
function modeHintText(plan) {
  const dasar = MODE_HINT[state.mode];
  const alt = plan?.modeAlt;
  if (!alt || !alt.currentS) return dasar;

  // Penghematan selalu dihitung terhadap yang LEBIH LAMBAT, supaya angkanya
  // sama persis dari mode mana pun dilihat. Dihitung terbalik, 551 detik jadi
  // 272 detik terbaca "hemat 102%" — angka yang mustahil dan langsung
  // menghilangkan kepercayaan pada seluruh panel.
  const cepat = Math.min(alt.currentS, alt.durationS);
  const lambat = Math.max(alt.currentS, alt.durationS);
  const hemat = 1 - cepat / lambat;

  // Di bawah 5% tidak ada yang perlu ditimbang; menyebutnya malah jadi derau.
  if (hemat < 0.05) return `${dasar} Mode satunya praktis sama cepatnya di lahan ini.`;

  const persen = Math.round(hemat * 100);

  // Sengaja TIDAK menyebut durasi mutlak mode satunya. Angka pembanding ini
  // diukur tanpa transit supaya selisihnya murni soal mode, sementara "Total
  // waktu" di ringkasan termasuk transit — menuliskannya di sini membuat dua
  // angka yang tidak cocok waktu pengguna benar-benar pindah mode.
  if (state.mode === 'stopAndShoot') {
    return `${dasar} Tanpa jeda memangkas sekitar ${persen}% waktu terbang, tapi bentuk filenya belum pernah terbukti diterima.`;
  }
  return `${dasar} Imbalannya sekitar ${persen}% waktu terbang dibanding berhenti sejenak, yang bentuknya sudah terbukti.`;
}

modeSegButtons().forEach((btn) => {
  btn.onclick = () => {
    modeSegButtons().forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
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
  const tone = p.enumConfidenceInfo.tone;
  $('di-body').innerHTML = `
    <div class="note ${tone}">
      <span class="ic">${tone === 'ok' ? '✓' : '!'}</span>
      <span><b>${esc(p.enumConfidenceInfo.label)}.</b>
        Kode drone ${p.droneEnumValue}/${p.droneSubEnumValue}.
        ${esc(p.enumNote ?? '')}</span>
    </div>
    <div class="note ${p.namespaceSource === 'impor' ? 'ok' : 'info'}">
      <span class="ic">i</span>
      <span>Namespace <code>${esc(p.wpmlNamespace)}</code>${
        p.namespaceSource === 'impor' ? ' — dari file asli.' : '.'
      }
      DJI Fly consumer memakai uav.com/wpmz/1.0.2; angka 1.0.6 yang beredar di
      dokumentasi DJI itu untuk lini Enterprise. Kalau file ditolak tanpa pesan
      jelas, bagian ini tersangka yang sama kuatnya dengan kode drone.</span>
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

  // Kolom manual diisi nilai yang berlaku sekarang, supaya mengubah satu
  // angka tidak diam-diam mengosongkan tiga lainnya.
  $('di-drone-enum').value = p.droneEnumValue;
  $('di-drone-sub').value = p.droneSubEnumValue;
  $('di-namespace').value = p.wpmlNamespace;

  $('btn-di-forget').hidden = !state.enumOverrides[state.droneId];
  $('di-import').hidden = true;
  elDroneInfo.hidden = false;
}

$('btn-di-save').onclick = () => {
  const num = (id) => Number($(id).value);
  const values = [num('di-drone-enum'), num('di-drone-sub')];

  if (values.some((v) => !Number.isInteger(v) || v < 0)) {
    toast('Kedua kode harus bilangan bulat tidak negatif.', 'err');
    return;
  }

  state.enumOverrides = setEnumOverride(state.droneId, {
    droneEnumValue: values[0],
    droneSubEnumValue: values[1],
    namespace: $('di-namespace').value,
    verified: true,
    confidence: 'manual',
    note: 'Diisi sendiri lewat panel drone, bukan dibaca dari file.',
  });

  syncProfile();
  render();
  openDroneInfo();
  toast(`Kode ${state.profile.name} diatur manual: ${values[0]}/${values[1]}.`, 'ok', 6000);
};

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
    text.textContent = `Terkunci: kode drone ${enums.droneEnumValue}/${enums.droneSubEnumValue}${enums.namespace ? ` · namespace ${enums.namespace}` : ''}. Dipakai untuk semua export ${state.profile.name} mulai sekarang.`;
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

/**
 * Bbox area terbang, dilebarkan sedikit supaya tepi layar tidak kosong.
 *
 * Dulu tinggal bersama kode pengunduh tile dan ikut terhapus bersamanya,
 * padahal pemakai sebenarnya ada dua — dan yang satunya, pengambilan data
 * bangunan di bawah ini, tetap hidup.
 */
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

/**
 * Rencana orbit mengelilingi satu objek tegak.
 *
 * Bentuk yang dikembalikan sengaja dibuat sama persis dengan buildPlan()
 * supaya seluruh sisa aplikasi — penggambaran peta, ringkasan, pembagian
 * baterai, gerbang keselamatan, export — tidak perlu tahu bedanya. Yang
 * berbeda cuma dari mana waypoint-nya datang dan apa arti angkanya.
 *
 * Pusat orbit diambil dari titik tengah poligon yang digambar. Jadi pengguna
 * tidak perlu alat gambar baru: cukup kotak kecil mengelilingi tugunya.
 */
function buildOrbitPlan() {
  const { profile, polygon, home } = state;
  const o = state.orbit;

  const [lng0, lat0] = centroid(polygon);
  const proj = makeProjector(lat0, lng0);
  const polyXY = polygon.map(proj.toXY);
  const homeXY = proj.toXY(home ?? polygon[0]);
  const area = polygonArea(polyXY);
  const lim = profile.limits;

  // Titik tengah poligon jadi titik asal proyeksi, jadi sumbu objeknya [0,0].
  const centerXY = [0, 0];

  const grid = generateOrbit(profile.camera, centerXY, {
    radiusM: o.radiusM,
    objectHeightM: o.objectHeightM,
    rings: o.rings,
    maxAngleStepDeg: o.stepDeg,
    maxPitchDeg: o.maxPitchDeg,
    cap: o.cap,
  });
  if (!grid.waypoints.length) return null;

  // Orbit selalu berhenti di tiap titik. Pada jarak sekitar 3 m antar foto,
  // melintas terus berarti kamera tidak sempat menjepret — dan ini bukan
  // pilihan yang masuk akal untuk ditawarkan, jadi tidak ditawarkan.
  const stopAtEach = true;
  const accel = lim.accelMs2 ?? 2.5;
  const topHeight = Math.max(...grid.rings.map((r) => r.heightM));
  const minSpacing = Math.min(...grid.rings.map((r) => r.spacingM));
  const ringGapM =
    grid.rings.length > 1 ? grid.rings[1].aimHeightM - grid.rings[0].aimHeightM : 0;

  const vBlur = maxSpeedForBlur(grid.gsdBestCm, 1 / 500, 1);
  const vInterval = minSpacing / profile.camera.minIntervalSec;

  // Bentuk params disamakan dengan computeSurveyParams supaya gerbang
  // keselamatan membaca field yang sama — tapi isinya diturunkan dari
  // geometri orbit, bukan dari ketinggian terbang.
  const params = {
    altitude: topHeight,
    gsd: grid.gsdWorstCm,
    footprint: { w: 0, h: 0 },
    sideSpacing: ringGapM,
    frontSpacing: minSpacing,
    maxSpeedBlur: vBlur,
    maxSpeedInterval: vInterval,
    recommendedSpeed: Math.min(vBlur, vInterval),
  };

  // Dekat struktur, kecepatan jelajah penuh tidak pernah terpakai (jarak antar
  // titik cuma beberapa meter) tapi tetap menaikkan risiko kalau drone
  // terlanjur melaju saat ada yang salah. Jadi batas atasnya sendiri.
  const ORBIT_CRUISE_MAX = 5;
  const autoSpeed = Math.min(ORBIT_CRUISE_MAX, lim.maxSpeedMs);
  const speed = state.speedAuto ? autoSpeed : Math.min(state.speedMs, lim.maxSpeedMs);

  const hoverPerPhoto = HOVER_SEC;
  const maxDist = maxDistanceFrom(homeXY, grid.waypoints);
  const transitReserveSec = (2 * maxDist) / speed + 60;

  const { sorties, meta: sortieMeta } = splitByRole(grid.waypoints, {
    speed,
    accel,
    stopAtEach,
    usableFlightMin: lim.usableFlightMin,
    hoverPerPhotoSec: hoverPerPhoto,
    transitReserveSec,
    maxWaypoints: lim.maxWaypoints,
  });

  const summaries = sorties.map((s) =>
    sortieSummary(s, homeXY, { speed, accel, hoverPerPhotoSec: hoverPerPhoto, stopAtEach })
  );

  return {
    proj,
    polyXY,
    gridPoly: polyXY,
    gridArea: area,
    bufferM: 0,
    bufferCost: null,
    // Ikut kontur tidak berlaku di orbit: ketinggian tiap cincin diturunkan
    // dari sudut bidik ke objek, bukan dari permukaan di bawah drone.
    terrain: { on: false, ready: false, relief: null, missing: 0 },
    terrainRequested: state.terrain,
    reliefHint: null,
    homeXY,
    area,
    params,
    grid,
    orbit: grid,
    orbitHeadingMode: o.headingMode,
    mode: 'stopAndShoot',
    pattern: 'orbit',
    patternName: PATTERNS.orbit.name,
    // Satu angka gimbal tidak mewakili orbit — tiap cincin punya sendiri.
    // Yang ditampilkan rentangnya.
    gimbalPitch: grid.rings[0].pitchDeg,
    gimbalRange: [
      grid.rings[0].pitchDeg,
      grid.rings[grid.rings.length - 1].pitchDeg,
    ],
    advanced: {
      ...state.advanced,
      angleDeg: 0,
      autoAngle: false,
      rcLostActionLabel: labelOf(els.rcLost),
      finishActionLabel: labelOf(els.finish),
    },
    // Lanjutkan-misi memotong jalur berdasar nomor waypoint, dan di orbit
    // nomor itu tidak menandai petak mana yang sudah selesai. Dimatikan,
    // bukan dibiarkan memberi hasil yang kelihatan benar.
    resume: null,
    autoSpeed,
    stopAtEach,
    speed,
    legMedianM: medianLegM(grid.waypoints),
    peakSpeedMs: peakSpeedOverLeg(medianLegM(grid.waypoints), speed, accel),
    accel,
    maxDist,
    distance: pathLengthXY(grid.waypoints.map((w) => w.xy)),
    duration: summaries.reduce((acc, x) => acc + x.durationS, 0),
    sorties,
    sortieMeta,
    resumeBlocked: null,
    summaries,
    altitude: topHeight,
  };
}

function buildPlan() {
  const { profile, polygon, home } = state;
  if (!profile || polygon.length < 3) return null;

  if (state.pattern === 'orbit') return buildOrbitPlan();

  const [lng0, lat0] = centroid(polygon);
  const proj = makeProjector(lat0, lng0);
  const polyXY = polygon.map(proj.toXY);
  const homeXY = proj.toXY(home ?? polygon[0]);
  const area = polygonArea(polyXY);

  const lim = profile.limits;

  // Sudut gimbal mana yang dipakai untuk melaporkan ketelitian. Yang dipilih
  // adalah yang PALING MIRING dari nadir di antara yang benar-benar dipakai,
  // karena itulah yang GSD-nya paling kasar — dan angka terburuk yang jujur
  // lebih berguna daripada angka terbaik yang menyenangkan.
  const usedPitches = PATTERNS[state.pattern]?.mixedGimbal
    ? PATTERNS[state.pattern].passSpecs.map((x) => x.gimbalPitch)
    : [state.advanced.gimbalPitch];
  const worstPitch = usedPitches.reduce((a, b) => (Math.abs(a) < Math.abs(b) ? a : b));

  const params = computeSurveyParams(profile.camera, {
    altitudeM: state.altitudeM,
    gimbalPitchDeg: worstPitch,
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
  //
  // TIDAK BERLAKU untuk pola banyak lintasan. Di sana export sudah dipecah
  // satu file per lintasan, jadi "lanjut dari titik terakhir" tidak punya
  // jawaban tunggal: lanjut di file yang mana? Dan memotong daftar waypoint
  // global akan mengiris lintasan-lintasan berikutnya juga, yang belum tentu
  // sudah diterbangkan sama sekali. Kalau satu lintasan gagal di tengah,
  // terbangkan ulang file lintasan itu saja — itu memang gunanya dipecah.
  const multiPass = (grid.passes?.length ?? 1) > 1;
  let resume = null;
  let resumeBlocked = state.resume && multiPass ? 'multiPass' : null;

  if (state.resume && !multiPass) {
    const target = proj.toXY(state.resume.lngLat);
    let nearest = 0;
    let bestD = Infinity;
    grid.waypoints.forEach((w, i) => {
      const d = Math.hypot(w.xy[0] - target[0], w.xy[1] - target[1]);
      if (d < bestD) {
        bestD = d;
        nearest = i;
      }
    });

    const best = resumeIndexFor(grid.waypoints, nearest);
    const skipped = grid.waypoints.slice(0, best);
    grid.waypoints = grid.waypoints.slice(best);
    grid.photos = grid.waypoints.reduce((n, w) => n + (w.photos || 0), 0);

    resume = {
      index: best,
      backedOff: nearest - best,
      snapDistM: bestD,
      source: state.resume.source ?? 'peta',
      photo: state.resume.photo ?? null,
      skippedWaypoints: skipped.length,
      skippedPhotos: skipped.reduce((n, w) => n + (w.photos || 0), 0),
      lngLat: proj.toLL(grid.waypoints[0]?.xy ?? target),
      pickedLngLat: state.resume.lngLat,
    };

    if (!grid.waypoints.length) return null;
  }

  const hoverPerPhoto = stopAtEach ? HOVER_SEC : 0;

  // Berapa sebenarnya ongkos atau untungnya mode satunya.
  //
  // "Lebih cepat" di keterangan mode itu benar tapi tidak bisa dipakai
  // memutuskan — apalagi karena mode tanpa jeda menukar kecepatan dengan
  // bentuk file yang belum terbukti diterima. Tukar-tambah tanpa angka bukan
  // tukar-tambah, cuma firasat. Jadi durasi mode satunya ikut dihitung,
  // persis seperti bufferCost menghitung versi tanpa buffer sebagai pembanding.
  //
  // Dipakai waypoint yang sama untuk keduanya: sejak perintah jepret-per-jarak
  // dibuang, bedanya dua mode memang cuma ada-tidaknya hoverTime dan batas
  // kecepatannya — bukan jumlah titiknya.
  const modeAltSpeed = stopAtEach
    ? Math.min(params.recommendedSpeed, lim.maxSpeedMs)
    : Math.min(lim.maxSpeedMs, lim.maxSpeedMs);
  const modeAlt = {
    mode: stopAtEach ? 'continuous' : 'stopAndShoot',
    speed: modeAltSpeed,
    durationS: missionDuration(grid.waypoints, {
      speed: modeAltSpeed,
      accel,
      stopAtEach: !stopAtEach,
      hoverPerPhotoSec: stopAtEach ? 0 : HOVER_SEC,
    }),
    // Mode yang sedang dipakai, diukur dengan cara yang sama persis — tanpa
    // transit — supaya selisihnya murni soal modenya, bukan soal jarak ke
    // titik awal.
    currentS: missionDuration(grid.waypoints, {
      speed,
      accel,
      stopAtEach,
      hoverPerPhotoSec: hoverPerPhoto,
    }),
  };

  // Kecepatan yang BENAR-BENAR tercapai. Di mode berhenti sejenak, ruas antar
  // titik terlalu pendek untuk mencapai kecepatan jelajah — drone mempercepat
  // sampai setengah jalan lalu mengerem. Tanpa angka ini, layar menampilkan
  // kecepatan jelajah sebagai kenyataan.
  const legMedianM = medianLegM(grid.waypoints);
  const peakSpeedMs = peakSpeedOverLeg(legMedianM, speed, accel);

  const maxDist = maxDistanceFrom(homeXY, grid.waypoints);

  // Cadangan baterai harus menutup transit pergi-pulang ke titik terjauh,
  // bukan angka tetap: di lahan besar, transit saja bisa beberapa menit.
  const transitReserveSec = (2 * maxDist) / speed + 60;

  // Peran tiap lintasan ikut dibawa supaya nama file bisa menyebut isinya,
  // bukan cuma nomor urutnya.
  const roleOfPass = Object.fromEntries(
    (grid.passes ?? []).map((x) => [x.index, x.role ?? null])
  );

  const { sorties, meta: sortieMeta } = splitByRole(grid.waypoints, {
    speed,
    accel,
    stopAtEach,
    usableFlightMin: profile.limits.usableFlightMin,
    hoverPerPhotoSec: hoverPerPhoto,
    transitReserveSec,
    maxWaypoints: lim.maxWaypoints,
    roleOfPass,
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
    patternName: PATTERNS[state.pattern]?.name ?? state.pattern,
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
    modeAlt,
    legMedianM,
    peakSpeedMs,
    accel,
    maxDist,
    distance: pathLengthXY(grid.waypoints.map((w) => w.xy)),
    duration: summaries.reduce((s, x) => s + x.durationS, 0),
    sorties,
    sortieMeta,
    resumeBlocked,
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
    syncFileEndMarkers(null, null);
    els.area.hidden = true;
    els.flown.hidden = true;
    renderTerrainStatus(null);

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

  // Jumlah file berubah berarti nomor file yang disembunyikan sudah menunjuk
  // ke file lain — atau ke file yang tidak ada lagi. Disetel ulang, bukan
  // dipetakan ulang: "file #3" sebelum dan sesudah luas lahan berubah bukan
  // isi yang sama, jadi mempertahankannya cuma akan menyembunyikan jalur yang
  // tidak pernah dipilih siapa pun.
  if (state.fileCount !== plan.sorties.length) {
    state.fileCount = plan.sorties.length;
    state.fileHidden.clear();
  }

  syncRouteSources(plan);

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
  renderOrbitRings(plan);
  renderResume(plan);

  els.sheetSummary.textContent =
    `${fmtArea(plan.area)} · ${plan.altitude.toFixed(0)} m · ${fmtDur(plan.duration)} · ` +
    `${plan.sorties.length} file`;

  syncUrl();
}

function updateDerived(plan) {
  els.frontOut.textContent = `${els.front.value}%`;
  els.sideOut.textContent = `${els.side.value}%`;
  els.modeHint.textContent = modeHintText(plan);

  const arahOtomatis = !state.advanced.angleDeg;
  els.angleAuto.checked = arahOtomatis;
  els.angle.disabled = arahOtomatis;
  els.angleOut.textContent = state.advanced.angleDeg
    ? `${state.advanced.angleDeg}°`
    : plan
      ? `otomatis · ${plan.advanced.angleDeg}°`
      : 'otomatis';
  els.angleNote.textContent = arahOtomatis
    ? 'Mengikuti sisi terpanjang lahan, jadi jalurnya paling sedikit. Ikut berubah kalau lahannya digambar ulang.'
    : `Diatur manual di ${state.advanced.angleDeg}°. Arah 0° dan 180° menghasilkan jalur yang sama, cuma arah mulainya terbalik.`;
  // Pola yang mencampur sudut gimbal memegang nilainya sendiri per lintasan.
  // Slider-nya dimatikan, bukan dibiarkan terlihat berfungsi padahal angkanya
  // tidak pernah sampai ke file.
  const mixedGimbal = !!PATTERNS[state.pattern]?.mixedGimbal || state.pattern === 'orbit';
  els.gimbal.disabled = mixedGimbal;
  els.gimbalOut.textContent = mixedGimbal
    ? state.pattern === 'orbit'
      ? 'per cincin'
      : 'per lintasan'
    : `${state.advanced.gimbalPitch}°`;
  // Kontrol abu-abu tanpa keterangan terbaca sebagai rusak. Keterangannya
  // ditaruh di tempat kontrolnya, bukan cuma di angka di sebelahnya.
  els.gimbalNote.textContent = mixedGimbal
    ? state.pattern === 'orbit'
      ? 'Tidak berlaku untuk orbit: tiap cincin punya sudutnya sendiri, dihitung dari titik bidiknya di objek.'
      : 'Tidak berlaku untuk 3D bangunan: lintasan nadir -90° dan dua lintasan miring -45° masing-masing membawa sudutnya sendiri.'
    : 'Untuk peta datar, -90° (nunduk lurus) yang benar. Memiringkannya mengubah pola ini jadi satu lintasan miring — bukan peta datar lagi.';

  // Dulu kontrol ini dimatikan untuk DJI Fly, dengan alasan takeOffSecurityHeight
  // tidak pernah ditulis. Alasan itu BENAR waktu ditulis, dan berhenti benar di
  // commit "Ikuti generator pihak ketiga yang memang dipakai orang memetakan":
  // sejak itu tag-nya ditulis untuk dialek DJI Fly juga. Penjaganya tidak ikut
  // diperbarui, jadi selama ini angkanya masuk ke file sementara pengguna tidak
  // bisa mengubahnya dan diberi tahu kontrolnya tidak berfungsi.
  //
  // Lebih buruk lagi: nilai yang sama juga dipakai sebagai globalRTHHeight,
  // jadi ketinggian pulang otomatis terkunci di 20 m — padahal bawaan
  // MISSION_DEFAULTS 100 m. Export dari web diam-diam MENURUNKAN RTH ke angka
  // yang bisa lebih rendah dari pohon dan bangunan di jalur pulang. Sekarang
  // keduanya kontrol sendiri-sendiri, karena memang dua hal yang berbeda.
  els.safeHeight.disabled = false;
  els.safeHeightOut.textContent = `${state.advanced.safeHeightM} m`;
  els.rthHeightOut.textContent = `${state.advanced.rthHeightM ?? SAFE_ADVANCED.rthHeightM} m`;

  const mult = Number(els.buffer.value);
  els.bufferOut.textContent = mult === 0 ? 'mati' : `${mult.toFixed(1)}× jarak jalur`;

  const o = state.orbit;
  els.objHeightOut.textContent = `${o.objectHeightM} m`;
  els.orbitRadiusOut.textContent = `${o.radiusM} m`;
  els.orbitRingsOut.textContent = String(o.rings);
  els.orbitStepOut.textContent = `${o.stepDeg}°`;
  els.orbitMaxPitchOut.textContent = `${o.maxPitchDeg}°`;

  if (!state.profile) return;

  // Ketinggian adalah input utama; GSD-nya yang diturunkan. Ini kebalikan dari
  // versi sebelumnya, dan sengaja: di lapangan orang berpikir dalam meter.
  els.alt.value = String(state.altitudeM);
  els.altOut.textContent = `${state.altitudeM} m`;

  const gsd = gsdFromAltitude(state.profile.camera, state.altitudeM);

  // Angka nadir itu dasar hitungan jarak jalur, tapi untuk pola miring dia
  // BUKAN ketelitian yang didapat — dan dulu cuma angka inilah yang tampil.
  const pitchForGsd = PATTERNS[state.pattern]?.mixedGimbal
    ? PATTERNS[state.pattern].passSpecs
        .map((x) => x.gimbalPitch)
        .reduce((a, b) => (Math.abs(a) < Math.abs(b) ? a : b))
    : state.advanced.gimbalPitch;

  const sg = surfaceGsd(state.profile.camera, state.altitudeM, pitchForGsd);
  const isOblique = state.pattern !== 'orbit' && sg.tiltDeg > 5;

  // Pola yang BENAR-BENAR membawa dua sudut kamera (3D bangunan: nadir plus
  // dua lintasan miring) punya dua ketelitian, dan sejak file dipecah per
  // peran, dua angka itu mendarat di dua FILE yang berbeda. Menampilkan satu
  // angka memaksa orang menebak angka itu milik file yang mana — dan karena
  // yang tampil adalah angka miring (yang paling kasar), tebakan yang wajar
  // justru salah untuk separuh fotonya.
  //
  // Pola yang miring SAJA tetap satu angka: di situ tidak ada file nadir, dan
  // angka nadir cuma setara-setaraan yang tidak mewakili satu foto pun.
  const duaSudut = !!PATTERNS[state.pattern]?.mixedGimbal;
  els.gsdDerived.textContent = !isOblique
    ? `${gsd.toFixed(2)} cm/px`
    : duaSudut
      ? `nadir ${gsd.toFixed(2)} · miring ${sg.centerCm.toFixed(2)} cm/px`
      : `${sg.centerCm.toFixed(2)} cm/px`;

  els.gsdObliqueNote.hidden = !isOblique;
  if (isOblique && duaSudut) {
    els.gsdObliqueNote.textContent =
      `Pola ini terbang dua sudut kamera, dan tiap sudut jadi filenya sendiri — jadi ketelitiannya juga dua, bukan satu. ` +
      `File nadir (kamera nunduk 90°, jarak ${state.altitudeM} m): ${gsd.toFixed(2)} cm/px, dan inilah yang jadi skala serta ukuran petanya. ` +
      `File miring (gimbal ${pitchForGsd}°, jarak ke permukaan ${sg.slantM.toFixed(0)} m — bukan ${state.altitudeM} m): ${sg.centerCm.toFixed(2)} cm/px di tengah frame, ` +
      `${sg.nearCm.toFixed(2)} di tepi dekat, ${sg.farCm.toFixed(2)} di tepi jauh. Yang berguna buat olah cuma bagian dekat-tengah.`;
  } else if (isOblique) {
    els.gsdObliqueNote.textContent =
      `Kamera miring ${pitchForGsd}°, jadi jarak ke permukaan ${sg.slantM.toFixed(0)} m — bukan ${state.altitudeM} m. ` +
      `Nadir setara ${gsd.toFixed(2)} cm/px, tapi pola ini tidak punya satu pun foto nadir: yang mendarat di dinding ${sg.centerCm.toFixed(2)} cm/px di tengah frame ` +
      `(${sg.nearCm.toFixed(2)} di tepi dekat, ${sg.farCm.toFixed(2)} di tepi jauh). Yang berguna buat olah cuma bagian dekat-tengah.`;
  }

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
  // Di mode berhenti sejenak, SATU angka di sini selalu menyesatkan: yang
  // ditulis ke file adalah kecepatan jelajah, tapi pada ruas sependek jarak
  // antar foto drone tidak pernah sampai ke sana. Dan karena otomatis memilih
  // kecepatan tertinggi drone, yang terbaca orang adalah "15.0 m/s" di misi
  // yang titiknya berjarak sepuluh meter — persis di sebelah catatan yang
  // bilang angka itu tidak pernah tercapai. Dua angka berdampingan menutup
  // pertentangan itu di tempat angkanya muncul, bukan di catatan di bawahnya.
  const tercapai = plan?.stopAtEach ? plan.peakSpeedMs : undefined;
  els.speedOut.textContent =
    tercapai !== undefined && tercapai < shown - 0.05
      ? `${shown.toFixed(1)} m/s · tercapai ${tercapai.toFixed(1)}`
      : `${shown.toFixed(1)} m/s`;
  // Catatan ini dulu menyebut batas blur dan batas jeda jepret tanpa peduli
  // mode — padahal di mode berhenti sejenak KEDUANYA tidak berlaku, karena
  // drone berhenti sebelum menjepret. Akibatnya layar menampilkan tiga angka
  // yang saling bertentangan: batas 12.5, batas 7.6, dan kecepatan 15.0.
  if (plan?.stopAtEach ?? state.mode === 'stopAndShoot') {
    const puncak = plan
      ? ` Pada ruas antar titik ${plan.legMedianM.toFixed(0)} m, drone cuma sempat mencapai ${plan.peakSpeedMs.toFixed(1)} m/s sebelum harus mengerem.`
      : '';
    // Kenapa otomatis justru mentok ke kanan, padahal catatannya bilang angka
    // itu tidak pernah tercapai: karena di mode ini kecepatan jelajah memang
    // cuma berlaku di ruas panjang. Di ruas antar foto, kecepatan berapa pun
    // yang dipilih tidak mengubah apa-apa — drone tetap mempercepat lalu
    // mengerem di jarak yang sama. Jadi yang paling masuk akal adalah angka
    // tertinggi: menurunkannya cuma memperlambat transit dan pindah lintasan,
    // tanpa menghemat atau mengamankan apa pun di atas lahan.
    const kenapaOtomatis = state.speedAuto
      ? ' Otomatis memilih angka tertinggi drone justru karena itu: di ruas antar foto angka ini tidak berpengaruh, sementara di transit dan pindah lintasan dia benar-benar kepakai.'
      : '';
    els.speedNote.textContent =
      `Berhenti sejenak di tiap titik, jadi batas blur dan jeda jepret tidak berlaku — drone berhenti dulu baru menjepret.${puncak} Angka ini kepakai di ruas panjang: transit ke titik awal dan pindah antar lintasan.${kenapaOtomatis}`;
  } else {
    els.speedNote.textContent = state.speedAuto
      ? `Batas blur ${p.maxSpeedBlur.toFixed(1)} m/s · batas jeda jepret ${p.maxSpeedInterval.toFixed(1)} m/s (${state.profile.mode.label}). Yang mengikat: ${p.maxSpeedBlur < p.maxSpeedInterval ? 'blur' : 'jeda jepret'}.`
      : `Diatur manual. Batas amannya ${Math.min(p.maxSpeedBlur, p.maxSpeedInterval).toFixed(1)} m/s.`;
  }

  const meters = mult === 0 ? 'tepat di batas' : `${(mult * p.sideSpacing).toFixed(0)} m`;

  // Kelipatan saja tidak terbaca tanpa tahu jarak jalurnya berapa — dan jarak
  // jalur ikut berubah tiap kali ketinggian atau overlap digeser.
  if (mult !== 0) els.bufferOut.textContent = `${mult.toFixed(1)}× jarak jalur · ${meters}`;
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
  const info = p.enumConfidenceInfo;

  els.enumBadge.hidden = false;
  els.enumBadge.className = `enum-badge ${info.tone}`;
  els.enumBadge.textContent =
    p.enumConfidence === 'unknown'
      ? 'Kode drone belum ada — ketuk i untuk mengisinya'
      : `Kode drone ${p.droneEnumValue}/${p.droneSubEnumValue} · ${info.label.toLowerCase()}`;
}

/**
 * Ringkasan orbit.
 *
 * Tiga angka di ringkasan grid tidak punya arti di sini dan karena itu
 * diganti, bukan dibiarkan menampilkan angka yang kebetulan ada:
 *
 *   "Ketinggian"              -> rentang cincin, karena tidak ada satu angka
 *   "Jarak antar jalur/foto"  -> langkah sudut, karena itu yang mengikat
 *   "Ketelitian" satu angka   -> rentang, karena cincin atas lebih kasar
 */
function renderOrbitStats(plan) {
  const orb = plan.orbit;
  const low = orb.rings[0];
  const high = orb.rings[orb.rings.length - 1];
  const step = Math.max(...orb.rings.map((r) => r.angleStepDeg));

  els.stats.className = 'stats';
  els.stats.innerHTML = `
    <div class="stat hero">
      <span class="k">Total waktu</span>
      <span class="v">${fmtDur(plan.duration)}</span>
    </div>
    <div class="stat hero">
      <span class="k">File KMZ</span>
      <span class="v">${plan.sorties.length}<small>×</small></span>
    </div>
    <div class="stat">
      <span class="k">Radius orbit</span>
      <span class="v">${orb.radiusM.toFixed(0)}<small>m</small></span>
    </div>
    <div class="stat">
      <span class="k">Ketelitian di dinding</span>
      <span class="v">${orb.gsdBestCm.toFixed(2)}–${orb.gsdWorstCm.toFixed(2)}<small>cm/px</small></span>
    </div>
    <div class="stat">
      <span class="k">Jumlah foto</span>
      <span class="v">${orb.photos}</span>
    </div>
    <div class="stat">
      <span class="k">Ruang kartu</span>
      <span class="v">${fmtSize(orb.photos * (state.profile.mode.approxPhotoMB ?? 8))}</span>
    </div>
    ${speedStat(plan)}
    <div class="stat">
      <span class="k">Waypoint</span>
      <span class="v">${plan.grid.waypoints.length}</span>
    </div>
    <div class="stat">
      <span class="k">Cincin</span>
      <span class="v">${low.heightM.toFixed(0)}–${high.heightM.toFixed(0)}<small>m</small></span>
    </div>
    <div class="stat">
      <span class="k">Titik terjauh</span>
      <span class="v">${plan.maxDist.toFixed(0)}<small>m</small></span>
    </div>
    <div class="stat full">
      <span class="k">Langkah sudut · kemiringan gimbal</span>
      <span class="v">${step.toFixed(0)}<small>°</small> · ${low.pitchDeg}<small>°</small> → ${high.pitchDeg}<small>°</small></span>
    </div>
    <div class="stat full">
      <span class="k">Drone · lensa · pola</span>
      <span class="v sm">${esc(state.profile.name)} · ${esc(state.profile.lens.name)} ${esc(state.profile.mode.label)} · ${esc(plan.patternName)}, ${orb.rings.length} cincin${orb.cap ? ' + petak nadir' : ''}</span>
    </div>`;
}

/** Tabel rencana tiap cincin, di panel setelan orbit. */
function renderOrbitRings(plan) {
  if (!plan || plan.pattern !== 'orbit') return;
  const orb = plan.orbit;

  els.orbitGsd.textContent = `${orb.gsdBestCm.toFixed(2)}–${orb.gsdWorstCm.toFixed(2)} cm/px`;

  const rows = orb.rings
    .map(
      (r) => `<tr>
        <td>${r.index + 1}</td>
        <td>${r.heightM.toFixed(1)} m</td>
        <td>${r.aimHeightM.toFixed(1)} m</td>
        <td>${r.pitchDeg}°</td>
        <td>${r.gsdCm.toFixed(2)}</td>
        <td>${r.photos}</td>
      </tr>`
    )
    .join('');

  els.orbitRingsTable.innerHTML = `
    <table class="ring-table">
      <thead>
        <tr><th>#</th><th>Tinggi</th><th>Bidik</th><th>Pitch</th><th>GSD</th><th>Foto</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${
      orb.cap
        ? `<p class="sub">Petak nadir: ${orb.cap.photos} foto di ${orb.cap.heightM.toFixed(0)} m, GSD ${orb.cap.gsdCm.toFixed(2)} cm/px.</p>`
        : '<p class="sub">Petak nadir mati — puncak objek tidak akan terpotret.</p>'
    }
    <p class="sub">Kaki objek 0–${orb.rings[0].aimHeightM.toFixed(1)} m tidak terjangkau drone. Keliling bagian itu dengan kamera tangan, lalu gabungkan di software olah yang sama.</p>`;
}

/**
 * Sudut gimbal yang benar-benar dipakai rencana ini.
 *
 * Satu angka tidak lagi cukup sejak ada pola yang mencampur nadir dan miring:
 * menampilkan "-45°" untuk 3D bangunan menyembunyikan justru lintasan yang
 * membuat pola itu ada.
 */
/**
 * Baris kecepatan di ringkasan.
 *
 * Satu angka menyesatkan di mode berhenti sejenak: yang ditulis ke file adalah
 * kecepatan jelajah, tapi pada ruas sependek jarak antar foto drone tidak
 * pernah sampai ke sana. Dua angka berdampingan menjawab pertanyaan yang
 * memang timbul waktu melihat "15.0 m/s" di misi yang titiknya berjarak 15 m.
 */
function speedStat(plan) {
  const nyata = plan.peakSpeedMs;
  if (!plan.stopAtEach || nyata === undefined || nyata >= plan.speed - 0.05) {
    return `<div class="stat">
      <span class="k">Kecepatan</span>
      <span class="v">${plan.speed.toFixed(1)}<small>m/s</small></span>
    </div>`;
  }
  return `<div class="stat full">
      <span class="k">Kecepatan jelajah · tertinggi tercapai</span>
      <span class="v">${plan.speed.toFixed(1)}<small>m/s</small> · ${nyata.toFixed(1)}<small>m/s</small></span>
    </div>`;
}

function gimbalLabel(plan) {
  const list = plan.grid?.gimbalPitches;
  if (!list || list.length <= 1) return `${plan.gimbalPitch}°`;
  return list.map((v) => `${v}°`).join(' + ');
}

function renderStats(plan) {
  if (plan.pattern === 'orbit') return renderOrbitStats(plan);
  els.stats.className = 'stats';
  // Urutannya mengikuti keputusan di lapangan, bukan urutan hitungannya:
  // yang pertama ditanya orang sebelum berangkat adalah "berapa lama" dan
  // "cukup berapa baterai". Sisanya pendukung.
  els.stats.innerHTML = `
    <div class="stat hero">
      <span class="k">Total waktu</span>
      <span class="v">${fmtDur(plan.duration)}</span>
    </div>
    <div class="stat hero">
      <span class="k">File KMZ</span>
      <span class="v">${plan.sorties.length}<small>×</small></span>
    </div>
    <div class="stat">
      <span class="k">Ketinggian</span>
      <span class="v">${plan.altitude.toFixed(0)}<small>m</small></span>
    </div>
    <div class="stat">
      <span class="k">Ketelitian</span>
      <span class="v">${plan.params.surfaceGsd.toFixed(2)}<small>cm/px</small></span>
    </div>
    <div class="stat">
      <span class="k">Jumlah foto</span>
      <span class="v">${plan.grid.photos}</span>
    </div>
    <div class="stat">
      <span class="k">Ruang kartu</span>
      <span class="v">${fmtSize(plan.grid.photos * (state.profile.mode.approxPhotoMB ?? 8))}</span>
    </div>
    ${speedStat(plan)}
    <div class="stat">
      <span class="k">Waypoint</span>
      <span class="v">${plan.grid.waypoints.length}</span>
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
      <span class="v sm">${esc(state.profile.name)} · ${esc(state.profile.lens.name)} ${esc(state.profile.mode.label)} · ${esc(plan.patternName)} ${esc(gimbalLabel(plan))}</span>
    </div>`;
}

/**
 * Nama file KMZ untuk sortie ke-i.
 *
 * Satu fungsi, dipakai dua tempat: panel "file yang akan terunduh" dan export
 * yang sebenarnya. Kalau keduanya menyusun namanya sendiri-sendiri, panel
 * cepat atau lambat akan berbohong soal nama yang muncul di folder HP.
 */
function namaFileKmz(plan, i) {
  const base =
    (els.projName.value.trim() || 'survei').replace(/[^\w\-]+/g, '-') +
    (plan.resume ? '-lanjut' : '') +
    PATTERN_SUFFIX[plan.pattern];
  const stamp = new Date().toISOString().slice(0, 10);
  // Nomor urut di depan karena itu URUTAN TERBANG, peran ditempel di belakang
  // supaya di folder HP kelihatan mana nadir mana miring tanpa dibuka.
  const peran = plan.sortieMeta?.[i]?.role;
  const label = peran ? `-${peran}` : '';
  return plan.sorties.length > 1
    ? `${base}-${stamp}_${i + 1}dari${plan.sorties.length}${label}.kmz`
    : `${base}-${stamp}${label}.kmz`;
}

/**
 * Apa gunanya tiap peran lintasan, dalam bahasa orang yang menerbangkannya.
 *
 * Nama "nadir" dan "miring" sudah cukup untuk nama file, tapi di panel yang
 * ditanya orang bukan namanya melainkan BUAT APA. Tanpa jawaban itu, lima file
 * cuma terlihat seperti lima kali kerja tanpa alasan — dan orang yang tidak
 * tahu alasannya akan melewatkan salah satunya.
 */
const PERAN_INFO = {
  nadir: {
    label: 'Nadir · kamera menunduk 90°',
    desc: 'Bahan peta datar: ortofoto, luas, jarak, ketinggian permukaan. Ini yang dipakai kalau hasilnya mau dicetak jadi peta atau diukur.',
  },
  miring: {
    label: 'Miring · kamera 45°, dua arah menyilang',
    desc: 'Bahan model 3D: dinding bangunan, sisi tebing, apa pun yang tegak dan tidak kelihatan dari atas. Tanpa file ini model 3D-nya meleleh seperti lilin.',
  },
};

const PERAN_POLOS = {
  label: 'Satu pola, dibagi jadi beberapa penerbangan',
  desc: 'Isinya sama persis jenisnya, cuma dipotong supaya tiap file muat di batas DJI dan di satu baterai. Potongannya menyambung — tidak ada petak yang terlewat selama semua file diterbangkan.',
};

/**
 * Arah lintasan yang benar-benar ada di dalam satu file.
 *
 * Ini pertanyaan yang timbul sendiri begitu file dikelompokkan per peran:
 * pola 3D bangunan dibangun dari dua lintasan miring yang MENYILANG, tapi
 * keduanya punya peran yang sama sehingga jatuh di kelompok yang sama. Dari
 * luar, "1 file · miring" jadi terbaca seperti satu arah saja — padahal
 * silangnya justru yang membuat pola itu ada.
 *
 * Jadi arahnya dibaca balik dari titik-titiknya, bukan dari nama polanya:
 * tiap titik membawa nomor lintasan asalnya, dan tiap lintasan tahu arahnya
 * sendiri. Kalau satu file memuat lebih dari satu arah, itu dikatakan.
 *
 * Orbit tidak punya lintasan sama sekali — titiknya tidak membawa `pass` — dan
 * untuk pola begitu fungsi ini mengembalikan null, bukan angka karangan.
 */
function arahJalurFile(plan, i) {
  const passes = plan.grid?.passes;
  const sortie = plan.sorties?.[i];
  if (!passes || !sortie) return null;

  const dipakai = [...new Set(sortie.map((w) => w.pass))].filter((k) => passes[k]);
  if (!dipakai.length) return null;

  // Dua lintasan dengan arah sama (nadir dan miring di pola 3D) tidak perlu
  // disebut dua kali.
  const sudut = [...new Set(dipakai.map((k) => Math.round(passes[k].angleDeg) % 180))].sort(
    (a, b) => a - b
  );
  return {
    label: sudut.map((v) => `${v}°`).join(' + '),
    menyilang: sudut.length > 1,
  };
}

/**
 * Jalur dan titik di peta, mengikuti file mana yang sedang ditampilkan.
 *
 * Dipisah dari render() karena mencentang file bukan perubahan rencana: tidak
 * ada yang perlu dihitung ulang, cuma dua sumber peta yang perlu diisi ulang.
 * Menjalankan render() penuh untuk itu berarti membangun ulang seluruh grid
 * tiap kali orang ingin melihat satu file — mahal, dan terasa berat di lahan.
 */
function syncRouteSources(plan) {
  const tampil = plan.sorties
    .map((sortie, i) => ({ sortie, i }))
    .filter(({ i }) => !state.fileHidden.has(i));

  map.getSource('route')?.setData({
    type: 'FeatureCollection',
    features: tampil.map(({ sortie, i }) => ({
      type: 'Feature',
      properties: { color: BATTERY_COLORS[i % BATTERY_COLORS.length] },
      geometry: {
        type: 'LineString',
        coordinates: sortie.map((w) => plan.proj.toLL(w.xy)),
      },
    })),
  });

  // Titiknya ikut disaring, bukan cuma garisnya. Kalau titik semua file tetap
  // tampil, menyembunyikan garis tidak menjawab apa pun — yang ingin dilihat
  // orang justru titik mana yang dijepret file ini.
  map.getSource('wp')?.setData({
    type: 'FeatureCollection',
    features: tampil.flatMap(({ sortie }) =>
      sortie.map((w) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: plan.proj.toLL(w.xy) },
      }))
    ),
  });

  syncFileEndMarkers(plan, tampil);
}

/**
 * Di mana tiap file mulai dan selesai.
 *
 * Garis berwarna sudah memberi tahu file mana yang mana, tapi tidak memberi
 * tahu dari UJUNG YANG MANA dia mulai — dan itu yang dibutuhkan orang yang
 * berdiri di lahan sambil memilih tempat lepas landas. Dua label per file:
 * titik 1 dan titik terakhir.
 *
 * Nomornya dihitung dari 1 DI DALAM FILE ITU SENDIRI, bukan nomor urut di
 * seluruh rencana. Alasannya bukan selera: tiap file KMZ adalah misi yang
 * berdiri sendiri, dan DJI Fly menomori titiknya dari 1 lagi setiap kali satu
 * file dibuka. Nomor global akan jadi angka yang tidak pernah muncul di layar
 * RC — persis jenis angka yang membuat orang mengira rencananya salah.
 */
function syncFileEndMarkers(plan, tampil) {
  for (const m of fileEndMarkers) m.remove();
  fileEndMarkers = [];
  if (!plan || !tampil) return;

  // File yang berbeda sering mulai di SUDUT PETAK YANG SAMA — pola 3D bangunan
  // memulai lintasan nadir dan lintasan miringnya di titik yang persis sama.
  // Tanpa penanganan, labelnya bertumpuk tepat dan yang di bawah hilang sama
  // sekali: satu-satunya file yang kelihatan justru yang digambar terakhir.
  // Jadi label yang jatuh di koordinat yang sudah terpakai digeser ke atas,
  // menumpuk seperti tangga. Digeser hanya kalau memang bertabrakan, bukan
  // selalu — label yang tidak bertabrakan tetap duduk di titiknya sendiri.
  const terpakai = new Map();

  for (const { sortie, i } of tampil) {
    const warna = BATTERY_COLORS[i % BATTERY_COLORS.length];
    const pasang = (w, jenis, nomor, judul) => {
      const ll = plan.proj.toLL(w.xy);
      const kunci = `${ll[0].toFixed(6)},${ll[1].toFixed(6)}`;
      const tumpuk = terpakai.get(kunci) ?? 0;
      terpakai.set(kunci, tumpuk + 1);

      const el = document.createElement('div');
      el.className = `wp-end ${jenis}`;
      el.style.background = warna;
      el.textContent = `#${i + 1} ${jenis === 'mulai' ? '▸' : '▪'}${nomor}`;
      el.title = judul;
      fileEndMarkers.push(
        new maplibregl.Marker({
          element: el,
          anchor: 'bottom',
          offset: [0, -3 - tumpuk * 17],
        })
          .setLngLat(ll)
          .addTo(map)
      );
    };

    pasang(sortie[0], 'mulai', 1, `File #${i + 1} mulai di titik 1 — dari sini drone menjepret`);
    pasang(
      sortie[sortie.length - 1],
      'selesai',
      sortie.length,
      `File #${i + 1} selesai di titik ${sortie.length}, lalu drone pulang sendiri`
    );
  }
}

/** Ganti file mana yang tampil di peta, lalu gambar ulang peta dan panelnya. */
function setFileHidden(next) {
  state.fileHidden = next;
  if (state.plan) {
    syncRouteSources(state.plan);
    renderSorties(state.plan);
    renderLegend(state.plan);
  }
}

/**
 * Daftar file yang akan terunduh.
 *
 * Ini bagian yang paling sering bikin orang berhenti memakai: mereka menekan
 * Export, dapat lima file, dan tidak tahu apakah itu lima pilihan, lima versi,
 * atau lima pekerjaan. Jadi yang ditulis di sini bukan cuma jumlahnya,
 * melainkan tiga hal sekaligus — berapa, kenapa segitu, dan tiap file isinya
 * apa serta makan berapa foto, waypoint, dan baterai.
 */
function renderSorties(plan) {
  const lim = state.profile?.limits ?? {};
  const jatahS = (lim.usableFlightMin ?? 0) * 60;
  const persenBaterai = (s) =>
    jatahS > 0 ? Math.min(100, Math.round((s.durationS / jatahS) * 100)) : null;

  const baris = (s, i) => {
    const p = persenBaterai(s);
    const arah = arahJalurFile(plan, i);
    const tampil = !state.fileHidden.has(i);
    return `
      <div class="file${tampil ? '' : ' off'}">
        <label class="fpick" title="${tampil ? 'Sembunyikan jalur file ini dari peta' : 'Tampilkan jalur file ini di peta'}">
          <input type="checkbox" data-file="${i}" ${tampil ? 'checked' : ''} />
          <span class="swatch" style="background:${BATTERY_COLORS[i % BATTERY_COLORS.length]}"></span>
        </label>
        <div class="fbody">
          <button type="button" class="fname" data-solo="${i}" title="Lihat jalur file ini saja di peta">
            <b>#${i + 1}</b><span>${esc(namaFileKmz(plan, i))}</span>
          </button>
          <div class="fmeta">
            <span><b>${s.photos}</b> foto</span>
            <span><b>${s.waypoints}</b> waypoint</span>
            <span><b>${fmtDur(s.durationS)}</b> <span class="dim">(${fmtDur(s.surveyS)} survei + ${fmtDur(s.transitS)} pergi-pulang)</span></span>
            ${
              arah
                ? `<span>arah jalur <b>${arah.label}</b>${arah.menyilang ? ' <span class="dim">(menyilang)</span>' : ''}</span>`
                : ''
            }
          </div>
          ${
            p == null
              ? ''
              : `<div class="fbat${p >= 90 ? ' tight' : ''}" title="Perkiraan pemakaian satu baterai, sudah termasuk terbang ke lokasi dan pulang">
                   <span class="track"><i style="width:${p}%"></i></span>
                   <span class="pct">${p}% baterai${p >= 90 ? ' — mepet' : ''}</span>
                 </div>`
          }
        </div>
      </div>`;
  };

  const s0 = plan.summaries[0];
  if (!s0) {
    els.sorties.innerHTML = '';
    return;
  }

  if (plan.summaries.length <= 1) {
    els.sorties.innerHTML = `
      <div class="files">
        <div class="files-head">
          <span class="fcount">1</span>
          <span class="ftitle">file KMZ<small>Seluruh area muat dalam satu penerbangan, satu baterai.</small></span>
        </div>
        ${baris(s0, 0)}
      </div>`;
    return;
  }

  // Kelompokkan file menurut peran, mengikuti urutan terbang.
  const grup = [];
  plan.summaries.forEach((s, i) => {
    const role = plan.sortieMeta?.[i]?.role ?? null;
    let g = grup[grup.length - 1];
    if (!g || g.role !== role) {
      g = { role, items: [] };
      grup.push(g);
    }
    g.items.push({ s, i });
  });

  // Kenapa segini banyak. Tiga sebab, dan yang berlaku bisa lebih dari satu.
  const totalWp = plan.grid.waypoints.length;
  const maxWp = lim.maxWaypoints ?? Infinity;
  const alasan = [];
  if (grup.length > 1 && grup.some((g) => g.role)) {
    alasan.push(
      `Nadir dan miring <b>tidak dicampur</b> dalam satu file — sudut kameranya beda, dan di lapangan itu dua pekerjaan yang berbeda.`
    );
  }
  if (totalWp > maxWp) {
    alasan.push(
      `Rencana ini butuh <b>${totalWp} waypoint</b>, sementara DJI cuma menerima <b>${maxWp} per file</b>. Tiap foto butuh satu waypoint, jadi batas inilah yang biasanya kena duluan.`
    );
  }
  if (jatahS > 0 && plan.duration > jatahS) {
    alasan.push(
      `Totalnya <b>${fmtDur(plan.duration)}</b> terbang, sementara satu baterai aman dipakai <b>${lim.usableFlightMin} menit</b>.`
    );
  }

  const mb = state.profile?.mode?.approxPhotoMB ?? 8;

  els.sorties.innerHTML = `
    <div class="files">
      <div class="files-head">
        <span class="fcount">${plan.summaries.length}</span>
        <span class="ftitle">file KMZ<small>Semuanya terunduh sekaligus saat kamu menekan Export.</small></span>
      </div>

      <div class="files-rule">
        <b>1 file = 1 penerbangan = 1 baterai.</b>
        Terbangkan berurutan mulai dari #1. Begitu satu file selesai, drone
        pulang sendiri — ganti baterai, buka file berikutnya di DJI Fly.
        Tidak ada yang perlu disambung manual.
      </div>

      ${
        alasan.length
          ? `<details class="files-why">
               <summary>Kenapa dipecah jadi ${plan.summaries.length} file?</summary>
               <ul>${alasan.map((a) => `<li>${a}</li>`).join('')}</ul>
             </details>`
          : ''
      }

      <div class="files-pick">
        <span>Klik nama file untuk melihat jalurnya sendiri di peta, atau pakai
        centangnya untuk membandingkan beberapa file sekaligus.</span>
        ${
          state.fileHidden.size
            ? `<button type="button" class="btn link" data-file-all>Tampilkan semua ${plan.summaries.length} file</button>`
            : ''
        }
      </div>

      ${grup
        .map((g) => {
          const info = (g.role && PERAN_INFO[g.role]) || PERAN_POLOS;
          const foto = g.items.reduce((n, x) => n + x.s.photos, 0);
          return `
            <div class="fgroup">
              <div class="fgroup-head">
                <span class="fgl">${esc(info.label)}</span>
                <span class="fgn">${g.items.length} file · ${foto} foto</span>
              </div>
              <p class="fgroup-desc">${info.desc}</p>
              ${g.items.map(({ s, i }) => baris(s, i)).join('')}
            </div>`;
        })
        .join('')}

      <div class="files-foot">
        Semua file digabung: <b>${plan.grid.photos} foto</b> ·
        <b>${fmtDur(plan.duration)}</b> terbang ·
        <b>${fmtSize(plan.grid.photos * mb)}</b> di kartu memori.
      </div>
    </div>`;
}

function renderLegend(plan) {
  if (plan.summaries.length <= 1) {
    els.legend.hidden = true;
    return;
  }
  els.legend.hidden = false;
  // File yang sedang disembunyikan tetap disebut di legenda, cuma diredupkan.
  // Menghapusnya dari daftar membuat peta terlihat seperti rencana yang memang
  // cuma punya dua file — dan itu kebohongan yang paling mudah terjadi di sini.
  els.legend.innerHTML = plan.summaries
    .map(
      (s, i) =>
        `<div class="lg${state.fileHidden.has(i) ? ' off' : ''}"><span class="swatch" style="background:${BATTERY_COLORS[i % BATTERY_COLORS.length]}"></span>File ${i + 1} · ${fmtDur(s.durationS)}</div>`
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
  els.patternCostVal.textContent = `${plan.grid.photos} foto · ${fmtDur(plan.duration)} · ${plan.sorties.length} file`;
}

// ---------- Lanjutkan misi ----------

function renderResume(plan) {
  const r = plan.resume;

  // Kalau titiknya sudah dipilih tapi polanya banyak lintasan, titik itu
  // diabaikan — dan itu harus dikatakan, bukan dibiarkan terlihat terpasang.
  if (plan.resumeBlocked === 'multiPass') {
    els.resumeReadout.hidden = false;
    els.resumeClear.hidden = false;
    els.resumePick.classList.remove('active');
    els.resumePick.textContent = 'Pilih di peta';
    els.resumeStatus.textContent = 'Tidak dipakai untuk pola banyak lintasan';
    els.resumeVal.textContent = 'file sudah dipecah per lintasan';
    return;
  }

  els.resumeReadout.hidden = !r;
  els.resumeClear.hidden = !r;
  els.resumePick.classList.toggle('active', state.resumePicking);
  els.resumePick.textContent = state.resumePicking
    ? 'Ketuk titik terakhir di peta…'
    : r
      ? 'Pilih ulang di peta'
      : 'Pilih di peta';

  if (!r) return;
  els.resumeStatus.textContent =
    r.source === 'foto'
      ? `Lanjut dari waypoint #${r.index + 1} (dari foto)`
      : `Lanjut dari waypoint #${r.index + 1}`;

  // Mundurnya jalur bukan detail teknis — itu foto yang sengaja diulang,
  // dan pengguna berhak tahu dia membayarnya.
  const backed = r.backedOff > 0 ? ' · mundur 1 foto biar tidak bolong' : '';
  els.resumeVal.textContent = `${r.skippedPhotos} foto dilewati · geser ${r.snapDistM.toFixed(0)} m${backed}`;
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

function setResumePoint(lngLat, extra = {}) {
  state.resume = { lngLat, source: 'peta', ...extra };
  state.resumePicking = false;
  map.getCanvas().style.cursor = '';
  render();
}

// ---------- Lanjut dari foto terakhir ----------
//
// Ini sumber paling jujur untuk "sampai mana yang sudah terpotret", karena
// yang dibaca adalah posisi foto itu sendiri — bukan posisi drone saat
// berbalik, yang bisa jauh setelahnya.

els.resumePhoto.onchange = async (e) => {
  const files = [...(e.target.files ?? [])];
  e.target.value = ''; // supaya memilih file yang sama lagi tetap memicu onchange
  if (!files.length) return;

  if (!state.plan) {
    toast('Gambar areanya dulu, baru pilih fotonya.', 'err');
    return;
  }

  const label = els.resumePhotoLabel.textContent;
  els.resumePhotoLabel.textContent = `Membaca ${files.length} foto…`;
  els.resumePhotoNote.hidden = true;

  try {
    const { last, read, skipped, hasTime } = await readLastPhoto(files);

    setResumePoint(last.lngLat, {
      source: 'foto',
      photo: {
        name: last.name,
        takenAt: last.takenAt ? last.takenAt.toLocaleString('id-ID') : null,
        altitudeM: last.altitudeM,
        model: last.model,
        read,
      },
    });

    const r = state.plan?.resume;
    const far = r && r.snapDistM > 60;

    els.resumePhotoNote.hidden = false;
    els.resumePhotoNote.className = `note ${far ? 'warn' : 'ok'}`;
    els.resumePhotoText.textContent = [
      `${read} foto terbaca.`,
      hasTime
        ? `Yang terakhir ${last.name} (${last.takenAt.toLocaleString('id-ID')}).`
        : `Tidak ada waktu di EXIF, jadi dipakai foto terakhir dalam urutan pilihan: ${last.name}.`,
      last.altitudeM != null ? `Ketinggian saat itu ${last.altitudeM.toFixed(0)} m dpl.` : '',
      far
        ? `Tapi titiknya ${r.snapDistM.toFixed(0)} m dari jalur terdekat — periksa dulu, bisa jadi fotonya dari penerbangan atau lahan lain.`
        : '',
      skipped.length ? `${skipped.length} file dilewati (${skipped[0]}).` : '',
    ]
      .filter(Boolean)
      .join(' ');

    toast(
      far
        ? 'Foto terbaca, tapi letaknya jauh dari jalur — cek titiknya di peta.'
        : 'Titik lanjut diambil dari foto terakhir.',
      far ? 'err' : 'ok',
      7000
    );
  } catch (err) {
    els.resumePhotoNote.hidden = false;
    els.resumePhotoNote.className = 'note bad';
    els.resumePhotoText.textContent = err.message;
  } finally {
    els.resumePhotoLabel.textContent = label;
  }
};

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

/** Perkiraan ruang kartu. Kasar, dan memang cuma untuk ancang-ancang. */
function fmtSize(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}<small>GB</small>` : `${Math.round(mb)}<small>MB</small>`;
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
    orbit: { ...state.orbit },
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
  // Project lama tidak punya setelan orbit sama sekali — bawaan yang dipakai,
  // bukan undefined yang bikin generator meledak.
  state.orbit = { ...state.orbit, ...(p.orbit ?? {}) };
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
  syncPatternButtons();
  noticeRetiredPattern();
  syncOrbitInputs();

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
  const orbit = plan.pattern === 'orbit';
  return sortie.map((w) => {
    const [lng, lat] = plan.proj.toLL(w.xy);
    return {
      lat,
      lng,
      height: w.height ?? plan.altitude,
      speed: plan.speed,
      heading: w.heading,
      // followWayline: arah hadap mengikuti jalur dengan sendirinya. Ini yang
      // dipakai file asli DJI Fly, dan untuk jalur bolak-balik memang itu
      // yang benar.
      //
      // Orbit membalik keduanya. Arah hadap di sana justru HARUS dilawan dari
      // arah jalur — kalau tidak, kamera menyorot tangensial dan objeknya
      // lewat di pinggir frame. Dan gimbal tidak boleh satu angka untuk semua
      // titik: tiap cincin punya pitch-nya sendiri, dan di petak nadir di atas
      // kameranya nunduk lurus.
      headingMode: orbit ? (w.poi ? plan.orbitHeadingMode : 'followWayline') : 'followWayline',
      // Titik yang membawa sudutnya sendiri menang: itu dipasang generator
      // untuk pola yang mencampur nadir dan miring. Yang tidak membawa apa-apa
      // ikut sudut misi, yang masih bisa digeser manual di panel lanjutan.
      gimbalPitch: w.gimbalPitch ?? plan.gimbalPitch,
      takePhoto: true,
      // Jeda sejenak hanya di mode stop & shoot. Di mode jalan terus drone
      // melintas sambil menjepret, dan itulah bedanya sekarang — bukan lagi
      // soal berapa waypoint yang ditulis.
      hoverTime: plan.stopAtEach ? HOVER_SEC : 0,
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
    // buildKmz sekarang asinkron karena kompresinya memakai CompressionStream.
    const files = await Promise.all(plan.sorties.map(async (sortie, i) => {
      const bytes = await buildKmz(
        {
          waypoints: planWaypointsToMission(plan, sortie),
          height: plan.altitude,
          speed: plan.speed,

          // Titik pusat orbit. Dipakai mode towardPOI, dan tetap ditulis di
          // mode satunya supaya file-nya tetap menyimpan ke mana sebenarnya
          // misi ini menghadap.
          poi:
            plan.pattern === 'orbit'
              ? (() => {
                  const [lng, lat] = plan.proj.toLL(plan.orbit.centerXY);
                  return { lat, lng, height: plan.orbit.objectHeightM / 2 };
                })()
              : null,

          // Setelan lanjutan ikut masuk file, bukan cuma jadi tampilan.
          finishAction: plan.advanced.finishAction,
          exitOnRCLost: 'executeLostAction',
          executeRCLostAction: plan.advanced.rcLostAction,

          // Naik dulu ke ketinggian aman sebelum menyeberang ke titik mulai.
          // Untuk sortie kedua dan misi lanjutan, inilah yang mencegah drone
          // melintas rendah di atas area yang belum tentu kosong.
          takeOffSecurityHeight: plan.advanced.safeHeightM,
          flyToWaylineMode: 'safely',

          rthHeight: plan.advanced.rthHeightM ?? SAFE_ADVANCED.rthHeightM,

          // Tidak ada perintah jepret-per-jarak: tidak ada satu pun contoh
          // nyata yang memakainya, dan file yang memakainya ditolak DJI Fly.
          // Setiap titik membawa aksi ambil fotonya sendiri.
          intervalShooting: null,
        },
        state.profile
      );
      // Namanya disusun namaFileKmz, fungsi yang sama yang dipakai panel
      // "file yang akan terunduh" — supaya yang dijanjikan di layar persis
      // yang muncul di folder HP.
      return { bytes, name: namaFileKmz(plan, i) };
    }));

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
        ? `${plan.sorties.length} file KMZ terunduh. Pindahkan SEMUANYA ke folder DJI Fly di HP, lalu terbangkan berurutan dari #1 — satu file, satu baterai.`
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
    ob: state.pattern === 'orbit' ? state.orbit : null,
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
    state.orbit = { ...state.orbit, ...(d.ob ?? {}) };
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
    syncPatternButtons();
    noticeRetiredPattern();
    syncOrbitInputs();
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
  } catch (err) {
    console.error('Gagal memulihkan rencana dari link:', err);
    toast('Link rencana tidak terbaca.', 'err');
    return false;
  }
}

// ---------- Offline ----------
//
// Yang DIHAPUS dari sini: pengunduh tile massal ("Unduh area", hitungan tile,
// status cache, tombol hapus cache). Setelah sekian lama dipakai, tile
// tersimpan tetap 0 — fiturnya memakan satu bagian panel penuh tanpa pernah
// dipakai, dan penyedia tile gratis memang melarang unduhan massal.
//
// Yang TETAP: service worker-nya sendiri. Dia menyimpan tile sambil peta
// digeser biasa, bukan cuma saat tombol unduh ditekan, dan menyimpan data
// elevasi yang membuat ikuti-kontur tetap jalan tanpa sinyal. Itu bagian yang
// berguna, dan gratis — tidak ada yang perlu ditekan.

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('sw.js').catch(() => {
    // Gagal mendaftar bukan kegagalan yang perlu ditunjukkan: aplikasinya tetap
    // jalan penuh, cuma tidak punya salinan offline.
  });
}

function syncOnlineBadge() {
  els.offlineBadge.hidden = navigator.onLine;
}

window.addEventListener('online', syncOnlineBadge);
window.addEventListener('offline', syncOnlineBadge);
syncOnlineBadge();
registerServiceWorker();
