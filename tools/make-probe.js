#!/usr/bin/env node
// Bikin satu set KMZ uji untuk mengetahui apa yang sebenarnya diterima
// DJI Fly soal pemotretan.
//
// Kenapa satu set, bukan satu file: kalau cuma satu file dan dia ditolak,
// kita tidak tahu apa yang salah. Dengan tiga file yang HANYA berbeda di
// bagian pemotretan, hasilnya langsung menunjuk penyebabnya:
//
//   A-kontrol      tanpa aksi foto sama sekali. Ini pembanding. Kalau A
//                  ditolak juga, masalahnya bukan di aksi foto — berarti ada
//                  yang salah di struktur dasar, dan B/C tidak perlu diuji.
//   B-stopshoot    aksi takePhoto di tiap waypoint
//   C-interval     satu perintah jepret tiap sekian meter sepanjang jalur
//
// Semua memakai setelan yang sudah terbukti dari file asli: ketinggian 50 m,
// kecepatan 2.5 m/s, gimbal nunduk lurus, RTH saat selesai dan saat sinyal
// hilang. Jalurnya kecil — tiga titik, sisi sekitar 60 m.
//
//   node tools/make-probe.js <lat> <lng> [folder]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../src/zip.js';
import { buildTemplateKml, buildWaylinesWpml, MISSION_DEFAULTS } from '../src/wpml.js';
import { resolveProfile } from '../src/profiles.js';
import { destination } from '../src/geo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const [latArg, lngArg, outArg = 'out/uji'] = process.argv.slice(2);
if (!latArg || !lngArg) {
  console.error('Pakai: node tools/make-probe.js <lat> <lng> [folder]');
  process.exit(1);
}

const lat = Number(latArg);
const lng = Number(lngArg);
const outDir = path.resolve(ROOT, outArg);

const ALT = 50; // meter — sama dengan misi asli yang terbukti
const SPEED = 2.5; // m/s — sama
const SIDE = 60; // meter antar titik
const GIMBAL = -90;

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', 'drones.json'), 'utf8'));
const profile = resolveProfile(registry, { droneId: 'mini5pro' });

// Segitiga kecil mengelilingi titik tengah: cukup untuk melihat drone
// bergerak dan berbelok, tanpa pergi jauh dari pilot.
const points = [0, 120, 240].map((bearing) => destination(lat, lng, bearing, SIDE));

const waypoint = (p, extra) => ({
  lat: p.lat,
  lng: p.lng,
  height: ALT,
  speed: SPEED,
  heading: 0,
  headingMode: 'followWayline',
  gimbalPitch: GIMBAL,
  takePhoto: false,
  hoverTime: 0,
  ...extra,
});

const build = (name, waypoints, extra = {}) => {
  const mission = {
    ...MISSION_DEFAULTS,
    waypoints,
    height: ALT,
    speed: SPEED,
    flyToWaylineMode: 'safely',
    finishAction: 'goHome',
    exitOnRCLost: 'executeLostAction',
    executeRCLostAction: 'goBack',
    ...extra,
  };

  const bytes = createZip([
    { name: 'wpmz/', dir: true },
    { name: 'wpmz/template.kml', data: buildTemplateKml(mission, profile) },
    { name: 'wpmz/waylines.wpml', data: buildWaylinesWpml(mission, profile) },
  ]);

  const file = path.join(outDir, `${name}.kmz`);
  fs.writeFileSync(file, bytes);
  console.log(`  ${name}.kmz  (${bytes.length} byte)`);
  return file;
};

fs.mkdirSync(outDir, { recursive: true });
console.log(`\nTitik tengah ${lat}, ${lng} — segitiga sisi ${SIDE} m, ${ALT} m, ${SPEED} m/s\n`);

build('A-kontrol-tanpa-foto', points.map((p) => waypoint(p)));

build(
  'B-stopshoot-foto-per-titik',
  points.map((p) => waypoint(p, { takePhoto: true, hoverTime: 2 }))
);

build('C-interval-jepret-per-20m', points.map((p) => waypoint(p)), {
  intervalShooting: { mode: 'distance', value: 20 },
});

console.log(`\nTersimpan di ${outDir}\n`);
