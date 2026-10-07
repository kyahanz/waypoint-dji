// Penyuntingan poligon di atas peta: tambah titik, geser titik, sisipkan titik
// di tengah sisi, hapus titik — plus riwayat undo/redo.
//
// Modul ini hanya mengurus interaksi dan sumber data GeoJSON-nya. Semua
// perhitungan survei ada di src/survey.js.

const EMPTY = { type: 'FeatureCollection', features: [] };
const MAX_HISTORY = 100;

const clone = (poly) => poly.map((c) => [c[0], c[1]]);

export function createPolygonEditor(map, { onChange }) {
  let polygon = []; // [lng, lat][]
  let drawing = false;
  let dragIndex = null;
  let hoverIndex = null;

  // Riwayat berisi snapshot poligon tiap kali perubahan selesai (bukan tiap
  // piksel saat menggeser), supaya satu kali undo membatalkan satu aksi utuh.
  let history = [[]];
  let hIndex = 0;
  let restoring = false;

  function emit(committed = false) {
    if (committed && !restoring) pushHistory();
    onChange(polygon, { drawing, committed });
    refresh();
  }

  function pushHistory() {
    const snap = clone(polygon);
    const top = history[hIndex];
    if (top && JSON.stringify(top) === JSON.stringify(snap)) return; // tidak ada perubahan

    history = history.slice(0, hIndex + 1);
    history.push(snap);
    if (history.length > MAX_HISTORY) history.shift();
    hIndex = history.length - 1;
  }

  function restore(index) {
    restoring = true;
    hIndex = index;
    polygon = clone(history[index]);
    emit(false);
    restoring = false;
  }

  // ---------- Sumber & layer ----------

  function install() {
    map.addSource('verts', { type: 'geojson', data: EMPTY });
    map.addSource('mids', { type: 'geojson', data: EMPTY });

    map.addLayer({
      id: 'mid-dot',
      type: 'circle',
      source: 'mids',
      paint: {
        'circle-radius': 4.5,
        'circle-color': '#0d1117',
        'circle-opacity': 0.75,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#4da3ff',
      },
    });

    map.addLayer({
      id: 'vert-dot',
      type: 'circle',
      source: 'verts',
      paint: {
        'circle-radius': ['case', ['boolean', ['feature-state', 'hover'], false], 8, 6],
        'circle-color': '#4da3ff',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#0d1117',
      },
    });

    wireEvents();
  }

  function refresh() {
    map.getSource('verts')?.setData({
      type: 'FeatureCollection',
      features: polygon.map((c, i) => ({
        type: 'Feature',
        id: i,
        properties: { i },
        geometry: { type: 'Point', coordinates: c },
      })),
    });

    // Pegangan tengah sisi hanya muncul kalau poligon sudah tertutup dan
    // tidak sedang digambar — biar tidak bentrok dengan klik menambah titik.
    const mids =
      !drawing && polygon.length >= 3
        ? polygon.map((c, i) => {
            const n = polygon[(i + 1) % polygon.length];
            return {
              type: 'Feature',
              properties: { after: i },
              geometry: {
                type: 'Point',
                coordinates: [(c[0] + n[0]) / 2, (c[1] + n[1]) / 2],
              },
            };
          })
        : [];
    map.getSource('mids')?.setData({ type: 'FeatureCollection', features: mids });
  }

  // ---------- Interaksi ----------

  function setHover(i) {
    if (hoverIndex !== null) {
      map.setFeatureState({ source: 'verts', id: hoverIndex }, { hover: false });
    }
    hoverIndex = i;
    if (i !== null) map.setFeatureState({ source: 'verts', id: i }, { hover: true });
  }

  function removeVertex(index) {
    if (polygon.length <= 3) return; // poligon minimal tetap segitiga
    polygon.splice(index, 1);
    setHover(null);
    emit(true);
  }

  function startDrag(index) {
    dragIndex = index;
    map.dragPan.disable();
    map.getCanvas().style.cursor = 'grabbing';
  }

  function moveTo(lngLat) {
    if (dragIndex === null) return;
    polygon[dragIndex] = [lngLat.lng, lngLat.lat];
    emit(); // belum committed: geseran hanya jadi satu entri riwayat saat dilepas
  }

  function endDrag() {
    if (dragIndex === null) return;
    dragIndex = null;
    map.dragPan.enable();
    map.getCanvas().style.cursor = '';
    emit(true);
  }

  function wireEvents() {
    // Menambah titik saat mode gambar.
    map.on('click', (e) => {
      if (!drawing || dragIndex !== null) return;
      polygon.push([e.lngLat.lng, e.lngLat.lat]);
      emit(true);
    });

    map.on('dblclick', (e) => {
      if (!drawing) return;
      e.preventDefault();
      finish();
    });

    // Geser titik sudut — atau hapus kalau Shift ditahan.
    for (const ev of ['mousedown', 'touchstart']) {
      map.on(ev, 'vert-dot', (e) => {
        if (drawing) return;
        e.preventDefault();
        const i = e.features[0].properties.i;
        if (e.originalEvent?.shiftKey) return removeVertex(i);
        startDrag(i);
      });
    }

    // Sisipkan titik baru dari pegangan tengah sisi, langsung ikut digeser.
    for (const ev of ['mousedown', 'touchstart']) {
      map.on(ev, 'mid-dot', (e) => {
        if (drawing) return;
        e.preventDefault();
        const after = e.features[0].properties.after;
        polygon.splice(after + 1, 0, [e.lngLat.lng, e.lngLat.lat]);
        refresh();
        startDrag(after + 1);
      });
    }

    map.on('mousemove', (e) => moveTo(e.lngLat));
    map.on('touchmove', (e) => {
      if (dragIndex === null) return;
      e.preventDefault();
      moveTo(e.lngLat);
    });
    map.on('mouseup', endDrag);
    map.on('touchend', endDrag);

    // Hapus titik dengan klik kanan.
    //
    // Sengaja memakai listener DOM, bukan map.on('contextmenu'): MapLibre
    // menunda event itu sampai mouseup untuk membedakannya dari drag-rotate,
    // sehingga tidak selalu terpicu. Event DOM-nya selalu terpicu.
    map.getCanvas().addEventListener('contextmenu', (ev) => {
      if (drawing) return;
      const rect = map.getCanvas().getBoundingClientRect();
      const point = [ev.clientX - rect.left, ev.clientY - rect.top];
      const hits = map.queryRenderedFeatures(point, { layers: ['vert-dot'] });
      if (!hits.length) return;
      ev.preventDefault(); // tahan menu browser hanya kalau memang kena titik
      removeVertex(hits[0].properties.i);
    });

    map.on('mouseenter', 'vert-dot', (e) => {
      if (drawing) return;
      map.getCanvas().style.cursor = 'grab';
      setHover(e.features[0].properties.i);
    });
    map.on('mouseleave', 'vert-dot', () => {
      if (dragIndex === null) map.getCanvas().style.cursor = drawing ? 'crosshair' : '';
      setHover(null);
    });
    map.on('mouseenter', 'mid-dot', () => {
      if (!drawing) map.getCanvas().style.cursor = 'copy';
    });
    map.on('mouseleave', 'mid-dot', () => {
      if (dragIndex === null) map.getCanvas().style.cursor = drawing ? 'crosshair' : '';
    });
  }

  // ---------- API ----------

  function start() {
    drawing = true;
    polygon = [];
    map.getCanvas().style.cursor = 'crosshair';
    emit(true);
  }

  function finish() {
    drawing = false;
    map.getCanvas().style.cursor = '';
    emit(true);
  }

  return {
    install,
    start,
    finish,
    isDrawing: () => drawing,
    get: () => clone(polygon),

    set(coords, { resetHistory = true } = {}) {
      polygon = coords.map((c) => [c[0], c[1]]);
      drawing = false;
      if (resetHistory) {
        history = [clone(polygon)];
        hIndex = 0;
        emit(false);
      } else {
        emit(true);
      }
    },

    clear() {
      polygon = [];
      drawing = false;
      map.getCanvas().style.cursor = '';
      emit(true);
    },

    undo() {
      if (hIndex > 0) restore(hIndex - 1);
    },
    redo() {
      if (hIndex < history.length - 1) restore(hIndex + 1);
    },
    canUndo: () => hIndex > 0,
    canRedo: () => hIndex < history.length - 1,
  };
}
