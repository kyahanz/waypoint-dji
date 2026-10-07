#!/usr/bin/env node
// CLI generator mission test — Fase 0 spike.
//
// Contoh:
//   npm run gen -- --lat -6.2549323 --lng 107.1199394
//   npm run gen -- --lat -6.2549323 --lng 107.1199394 --alt 50 --radius 60 --points 5 --photo
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip.js';
import { destination } from './geo.js';
import {
  buildTemplateKml,
  buildWaylinesWpml,
  missionStats,
  MISSION_DEFAULTS,
} from './wpml.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const HELP = `
waypoint-dji — generator KMZ test (Fase 0)

Wajib:
  --lat <angka>        Latitude titik tengah area test
  --lng <angka>        Longitude titik tengah area test

Opsional:
  --alt <m>            Ketinggian relatif dari titik take-off (default 30)
  --radius <m>         Jarak waypoint dari titik tengah (default 40)
  --points <n>         Jumlah waypoint, disebar melingkar (default 3)
  --speed <m/s>        Kecepatan jelajah (default 5)
  --photo              Ambil foto di tiap waypoint
  --hover <detik>      Hover sekian detik di tiap waypoint (stop-and-shoot)
  --gimbal <derajat>   Sudut pitch gimbal, -90 = nadir/lurus ke bawah
  --finish <aksi>      goHome | autoLand | noAction | gotoFirstWaypoint (default goHome)
  --name <nama>        Nama file output (default test-mission)
  --profile <file>     Profil drone (default profiles/mini5pro.json)
  --out <dir>          Folder output (default out/)
  --help               Tampilkan bantuan ini
`;

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.lat && !args.lng)) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const lat = Number(args.lat);
  const lng = Number(args.lng);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    console.error(`Latitude tidak valid: ${args.lat}`);
    process.exit(1);
  }
  if (!Number.isFinite(lng) || Math.abs(lng) > 180) {
    console.error(`Longitude tidak valid: ${args.lng}`);
    process.exit(1);
  }

  const profilePath = args.profile
    ? path.resolve(args.profile)
    : path.join(ROOT, 'profiles', 'mini5pro.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

  const alt = Number(args.alt ?? MISSION_DEFAULTS.height);
  const radius = Number(args.radius ?? 40);
  const count = Math.max(2, Number(args.points ?? 3));
  const speed = Number(args.speed ?? MISSION_DEFAULTS.speed);

  if (alt > profile.limits.maxAltitudeM) {
    console.error(
      `Ketinggian ${alt}m melebihi batas ${profile.limits.maxAltitudeM}m. Dibatalkan.`
    );
    process.exit(1);
  }

  // Sebar waypoint melingkar di sekitar titik tengah — pola paling aman buat test.
  const waypoints = [];
  for (let i = 0; i < count; i++) {
    const bearing = (360 / count) * i;
    const p = destination(lat, lng, bearing, radius);
    waypoints.push({
      lat: p.lat,
      lng: p.lng,
      height: alt,
      speed,
      takePhoto: !!args.photo,
      hoverTime: args.hover ? Number(args.hover) : 0,
      gimbalPitch: args.gimbal !== undefined ? Number(args.gimbal) : undefined,
    });
  }

  const mission = {
    ...MISSION_DEFAULTS,
    height: alt,
    speed,
    finishAction: args.finish ?? MISSION_DEFAULTS.finishAction,
    waypoints,
  };

  const templateKml = buildTemplateKml(mission, profile);
  const waylines = buildWaylinesWpml(mission, profile);

  const kmz = createZip([
    { name: 'wpmz/', dir: true },
    { name: 'wpmz/template.kml', data: templateKml },
    { name: 'wpmz/waylines.wpml', data: waylines },
  ]);

  const outDir = path.resolve(args.out ?? path.join(ROOT, 'out'));
  fs.mkdirSync(outDir, { recursive: true });
  const base = String(args.name ?? 'test-mission');
  const kmzPath = path.join(outDir, `${base}.kmz`);
  fs.writeFileSync(kmzPath, kmz);

  // Simpan juga versi mentahnya biar gampang di-diff sama file asli DJI Fly.
  const rawDir = path.join(outDir, `${base}.unpacked`, 'wpmz');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'template.kml'), templateKml);
  fs.writeFileSync(path.join(rawDir, 'waylines.wpml'), waylines);

  const s = missionStats(mission);
  const mins = Math.floor(s.durationS / 60);
  const secs = Math.round(s.durationS % 60);

  console.log(`
  Mission ter-generate
  --------------------
  Titik tengah  : ${lat}, ${lng}
  Waypoint      : ${s.waypoints} titik, radius ${radius} m
  Ketinggian    : ${alt} m (relatif titik take-off)
  Kecepatan     : ${speed} m/s
  Jarak jalur   : ${s.distanceM.toFixed(1)} m
  Foto          : ${s.photos}
  Estimasi      : ${mins}m ${secs}s
  Selesai       : ${mission.finishAction}

  File:
    ${kmzPath}
    ${path.join(outDir, base + '.unpacked')}${path.sep}  (versi mentah buat dibandingkan)

  Lanjut: ikuti TEST-CHECKLIST.md untuk transfer ke HP dan uji import.
`);
}

main();
