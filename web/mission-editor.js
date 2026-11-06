// Editor misi: buka KMZ yang sudah ada, ubah seperlunya, simpan lagi.
//
// Berbeda dari perencana survei. Perencana menghitung jalur dari lahan yang
// kamu gambar; editor ini tidak menghitung apa-apa — dia menyentuh file yang
// sudah ada dan membiarkan sisanya utuh.
//
// Sengaja tidak ada hitungan GSD, overlap, atau pembagian baterai di sini.
// Titik-titik dalam file sembarang tidak punya pola jalur, jadi angka-angka
// itu tidak punya arti dan menampilkannya cuma akan menyesatkan.

import { readZip } from './unzip.js';
import { createZipAsync } from './zip-browser.js';
import {
  parseWaylines,
  serializeWaylines,
  writeWaypoint,
  readWaypoint,
  renumber,
  cloneWaypoint,
  readMissionConfig,
  writeMissionConfig,
} from '../src/wpml-edit.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

export function createMissionEditor({ map, toast, $, onModeChange }) {
  const state = {
    open: false,
    name: null,
    files: null, // isi arsip lain yang tidak kita sentuh
    template: null,
    original: null, // { template, waylines }
    doc: null, // hasil parseWaylines
    config: null,
    selected: null,
    markers: [],
  };

  const els = {
    section: $('step-edit'),
    openSection: $('step-open'),
    file: $('mission-file'),
    openNote: $('mission-open-note'),
    openText: $('mission-open-text'),
    name: $('edit-name'),
    count: $('edit-count'),
    origin: $('edit-origin'),
    alt: $('edit-alt'),
    altOut: $('edit-alt-out'),
    speed: $('edit-speed'),
    speedOut: $('edit-speed-out'),
    gimbal: $('edit-gimbal'),
    gimbalOut: $('edit-gimbal-out'),
    finish: $('edit-finish'),
    rc: $('edit-rc'),
    selReadout: $('edit-sel-readout'),
    selLabel: $('edit-sel-label'),
    selVal: $('edit-sel-val'),
    insert: $('btn-edit-insert'),
    del: $('btn-edit-delete'),
    save: $('btn-edit-save'),
    reset: $('btn-edit-reset'),
    close: $('btn-edit-close'),
    warnings: $('edit-warnings'),
  };

  // ---------- Peta ----------

  function installLayers() {
    if (map.getSource('mission-line')) return;

    map.addSource('mission-line', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'mission-line',
      type: 'line',
      source: 'mission-line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#f0b429', 'line-width': 3, 'line-opacity': 0.95 },
    });
  }

  function clearMarkers() {
    for (const m of state.markers) m.remove();
    state.markers = [];
  }

  function drawMission() {
    installLayers();
    clearMarkers();

    const wps = state.doc.waypoints;

    map.getSource('mission-line')?.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: wps.map((w) => [w.lng, w.lat]) },
    });

    wps.forEach((w, i) => {
      const el = document.createElement('div');
      el.className = 'mwp' + (i === state.selected ? ' sel' : '');
      el.textContent = String(i + 1);
      el.title = `Titik ${i + 1} — ${w.height} m, ${w.speed} m/s`;

      const marker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'center' })
        .setLngLat([w.lng, w.lat])
        .addTo(map);

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        select(i);
      });

      marker.on('dragend', () => {
        const { lng, lat } = marker.getLngLat();
        state.doc.placemarks[i] = writeWaypoint(state.doc.placemarks[i], { lng, lat });
        refreshWaypoints();
        select(i);
      });

      state.markers.push(marker);
    });
  }

  function refreshWaypoints() {
    state.doc.waypoints = state.doc.placemarks.map(readWaypoint);
  }

  function select(i) {
    state.selected = i;
    render();
  }

  // ---------- Membuka berkas ----------

  els.file.onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await openFile(file);
  };

  async function openFile(file) {
    els.openNote.hidden = true;

    try {
      const files = await readZip(await file.arrayBuffer());
      const dec = new TextDecoder();

      const wayKey = Object.keys(files).find((k) => k.endsWith('waylines.wpml'));
      const tplKey = Object.keys(files).find((k) => k.endsWith('template.kml'));
      if (!wayKey) throw new Error('Tidak ada wpmz/waylines.wpml di dalam file ini.');

      const waylines = dec.decode(files[wayKey]);
      const template = tplKey ? dec.decode(files[tplKey]) : null;

      const doc = parseWaylines(waylines);
      if (!doc.waypoints.length) throw new Error('File ini tidak memuat satu pun waypoint.');

      state.open = true;
      state.name = file.name;
      state.files = files;
      state.keys = { wayKey, tplKey };
      state.original = { waylines, template };
      state.template = template;
      state.doc = doc;
      state.config = readMissionConfig(waylines);
      state.selected = null;

      // Nilai awal kontrol diambil dari isi file, bukan dari angka bawaan
      // aplikasi — yang ditampilkan harus apa yang memang ada di file.
      const alts = doc.waypoints.map((w) => w.height).filter((v) => v != null);
      const spds = doc.waypoints.map((w) => w.speed).filter((v) => v != null);
      const gims = doc.waypoints.map((w) => w.gimbalPitch).filter((v) => v != null);

      els.alt.value = String(Math.round(alts[0] ?? 50));
      els.speed.value = String(spds[0] ?? 2.5);
      els.gimbal.value = String(gims[0] ?? -90);
      els.finish.value = state.config.finishAction ?? 'goHome';
      els.rc.value = state.config.executeRCLostAction ?? 'goBack';

      setMode(true);
      fitToMission();
      drawMission();
      render();

      toast(`${doc.waypoints.length} titik dimuat dari ${file.name}.`, 'ok', 5000);
    } catch (err) {
      els.openNote.hidden = false;
      els.openText.textContent = err.message;
    }
  }

  function fitToMission() {
    const lngs = state.doc.waypoints.map((w) => w.lng);
    const lats = state.doc.waypoints.map((w) => w.lat);
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 80, duration: 700, maxZoom: 18 }
    );
  }

  function setMode(editing) {
    els.section.hidden = !editing;
    els.openSection.hidden = editing;
    document.body.classList.toggle('editing-mission', editing);
    onModeChange?.(editing);
  }

  // ---------- Perubahan ----------

  const applyAll = (patch) => {
    state.doc.placemarks = state.doc.placemarks.map((p) => writeWaypoint(p, patch));
    refreshWaypoints();
    drawMission();
    render();
  };

  els.alt.addEventListener('input', () => applyAll({ height: Number(els.alt.value) }));
  els.speed.addEventListener('input', () => applyAll({ speed: Number(els.speed.value) }));
  els.gimbal.addEventListener('input', () => applyAll({ gimbalPitch: Number(els.gimbal.value) }));

  els.finish.onchange = render;
  els.rc.onchange = render;

  els.insert.onclick = () => {
    const i = state.selected;
    if (i == null) return;

    const wps = state.doc.waypoints;
    const next = wps[i + 1] ?? wps[i - 1];
    if (!next) return;

    // Titik baru ditaruh di tengah ruas, dan strukturnya meniru tetangganya
    // supaya tag yang ditulis DJI Fly ikut terbawa apa adanya.
    const lng = (wps[i].lng + next.lng) / 2;
    const lat = (wps[i].lat + next.lat) / 2;

    state.doc.placemarks.splice(i + 1, 0, cloneWaypoint(state.doc.placemarks[i], { lng, lat }));
    state.doc.placemarks = renumber(state.doc.placemarks);
    refreshWaypoints();
    state.selected = i + 1;
    drawMission();
    render();
  };

  els.del.onclick = () => {
    const i = state.selected;
    if (i == null) return;

    if (state.doc.placemarks.length <= 2) {
      toast('Misi harus punya minimal 2 titik.', 'err');
      return;
    }

    state.doc.placemarks.splice(i, 1);
    state.doc.placemarks = renumber(state.doc.placemarks);
    refreshWaypoints();
    state.selected = Math.min(i, state.doc.placemarks.length - 1);
    drawMission();
    render();
  };

  els.reset.onclick = () => {
    state.doc = parseWaylines(state.original.waylines);
    state.template = state.original.template;
    state.config = readMissionConfig(state.original.waylines);
    state.selected = null;

    els.alt.value = String(Math.round(state.doc.waypoints[0].height ?? 50));
    els.speed.value = String(state.doc.waypoints[0].speed ?? 2.5);
    els.gimbal.value = String(state.doc.waypoints[0].gimbalPitch ?? -90);
    els.finish.value = state.config.finishAction ?? 'goHome';
    els.rc.value = state.config.executeRCLostAction ?? 'goBack';

    drawMission();
    render();
    toast('Kembali ke isi file aslinya.', 'ok');
  };

  els.close.onclick = () => {
    state.open = false;
    clearMarkers();
    map.getSource('mission-line')?.setData(EMPTY);
    setMode(false);
  };

  // ---------- Simpan ----------

  els.save.onclick = async () => {
    const label = els.save.textContent;
    els.save.disabled = true;
    els.save.textContent = 'Membuat file…';

    try {
      const patch = {
        finishAction: els.finish.value,
        executeRCLostAction: els.rc.value,
        autoFlightSpeed: Number(els.speed.value),
      };

      const waylines = writeMissionConfig(serializeWaylines(state.doc), patch);
      const template = state.template ? writeMissionConfig(state.template, patch) : null;

      // Berkas lain di dalam arsip — apa pun itu — ikut disalin apa adanya.
      // Daftar entri meniru arsip aslinya, termasuk tidak adanya entri folder.
      const entries = [];
      for (const [name, bytes] of Object.entries(state.files)) {
        if (name === state.keys.wayKey) entries.push({ name, data: waylines });
        else if (name === state.keys.tplKey && template) entries.push({ name, data: template });
        else entries.push({ name, data: bytes });
      }

      const bytes = await createZipAsync(entries);

      const base = state.name.replace(/\.kmz$/i, '');
      downloadBlob(bytes, `${base}-diedit.kmz`);
      toast('File tersimpan. Pindahkan ke folder waypoint di RC.', 'ok', 6000);
    } catch (err) {
      toast(`Gagal menyimpan: ${err.message}`, 'err', 7000);
    } finally {
      els.save.disabled = false;
      els.save.textContent = label;
    }
  };

  function downloadBlob(bytes, filename) {
    const url = URL.createObjectURL(
      new Blob([bytes], { type: 'application/vnd.google-earth.kmz' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- Tampilan ----------

  function render() {
    if (!state.open) return;

    const wps = state.doc.waypoints;
    els.name.textContent = state.name;
    els.count.textContent = `${wps.length} titik`;

    const ns = state.config.namespace ?? '—';
    els.origin.textContent =
      `Kode drone ${state.config.droneEnumValue ?? '—'}/${state.config.droneSubEnumValue ?? '—'} · ` +
      `${ns.includes('uav.com') ? 'format DJI Fly' : 'format Enterprise'} · ` +
      'bagian yang tidak kamu ubah tetap seperti aslinya.';

    els.altOut.textContent = `${els.alt.value} m`;
    els.speedOut.textContent = `${els.speed.value} m/s`;
    els.gimbalOut.textContent = `${els.gimbal.value}°`;

    const i = state.selected;
    els.selReadout.hidden = i == null;
    els.insert.disabled = i == null;
    els.del.disabled = i == null;

    if (i != null) {
      const w = wps[i];
      els.selLabel.textContent = `Titik ${i + 1} dari ${wps.length}`;
      els.selVal.textContent = `${w.lat.toFixed(6)}, ${w.lng.toFixed(6)}`;
    }

    const notes = [];
    if (els.rc.value !== 'goBack') {
      notes.push([
        'bad',
        'Saat sinyal hilang drone tidak pulang sendiri. Kalau kendali hilang di luar jangkauan pandang, hanya RTH yang membawanya kembali.',
      ]);
    }
    if (els.finish.value === 'autoLand') {
      notes.push([
        'bad',
        'Setelah selesai drone mendarat di titik terakhir jalur, bukan pulang. Pastikan kamu tahu persis itu di mana dan ada apa di bawahnya.',
      ]);
    }
    if (wps.some((w) => w.hasPhoto)) {
      notes.push([
        'info',
        'File ini memuat aksi ambil foto — bentuknya ikut tersimpan apa adanya, tidak kami ubah.',
      ]);
    }
    notes.push([
      'info',
      'Editor ini tidak menghitung GSD, overlap, atau jumlah baterai: titik dalam file sembarang tidak punya pola jalur, jadi angka itu tidak ada artinya di sini.',
    ]);

    els.warnings.innerHTML = notes
      .map(
        ([level, text]) =>
          `<div class="note ${level}"><span class="ic">${level === 'bad' ? '!' : 'i'}</span><span>${text}</span></div>`
      )
      .join('');
  }

  return { openFile, isOpen: () => state.open };
}
