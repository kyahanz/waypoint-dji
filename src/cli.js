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
import { resolveProfile } from './profiles.js';
import { makeProjector, generateOrbit, missionDuration, ORBIT_DEFAULTS } from './survey.js';
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

Mode orbit (objek tegak: tugu, menara, patung):
  --orbit              Nyalakan mode orbit. --lat/--lng jadi sumbu objek.
  --objheight <m>      Tinggi objek dari dasar (wajib di mode orbit)
  --radius <m>         Jarak mendatar drone ke sumbu objek (default 18)
  --rings <n>          Jumlah cincin ketinggian (default ${ORBIT_DEFAULTS.rings})
  --step <derajat>     Langkah sudut antar foto (default ${ORBIT_DEFAULTS.maxAngleStepDeg})
  --maxpitch <derajat> Kemiringan gimbal di cincin teratas (default ${ORBIT_DEFAULTS.maxPitchDeg})
  --no-cap             Jangan tambahkan petak nadir di atas objek
  --poi                Pakai towardPOI, bukan sudut hadap per titik
  --finish <aksi>      goHome | autoLand | noAction | gotoFirstWaypoint (default goHome)
  --name <nama>        Nama file output (default test-mission)
  --drone <id>         Drone dari profiles/drones.json (default mini5pro)
  --lens <id>          Lensa drone itu (default lensa pertama)
  --mp <id>            Mode foto lensa itu (default mode pertama)
  --drones             Tampilkan daftar drone yang tersedia lalu keluar
  --profile <file>     Profil tunggal lama (menimpa --drone)
  --out <dir>          Folder output (default out/)
  --help               Tampilkan bantuan ini
`;

const loadRegistry = () =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', 'drones.json'), 'utf8'));

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.drones) {
    for (const d of loadRegistry().drones) {
      const lenses = d.lenses
        .map((l) => `${l.id} (${l.modes.map((m) => m.id).join('/')})`)
        .join(', ');
      console.log(
        `${d.id.padEnd(14)} ${d.name.padEnd(22)} ${d.enums?.verified ? 'kode OK' : 'kode ?  '}  ${lenses}`
      );
    }
    process.exit(0);
  }

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

  // Profil tunggal lama masih didukung supaya file profil buatan sendiri
  // tidak mendadak tidak kepakai; selain itu, sumbernya registry.
  const profile = args.profile
    ? JSON.parse(fs.readFileSync(path.resolve(args.profile), 'utf8'))
    : resolveProfile(loadRegistry(), {
        droneId: args.drone ?? 'mini5pro',
        lensId: args.lens,
        modeId: args.mp,
      });

  if (!args.profile) {
    console.log(
      `Drone  : ${profile.name} — ${profile.lens.name}, ${profile.mode.label}` +
        (profile.enumVerified ? '' : '  [kode drone BELUM terverifikasi]')
    );
  }

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

  let orbit = null;
  let waypoints;

  if (args.orbit) {
    // ---- Mode orbit: mengelilingi objek tegak ----
    //
    // Bedanya dengan pola grid bukan cuma bentuk jalurnya. Di sini --lat/--lng
    // bukan tengah lahan melainkan SUMBU objek, --alt tidak dipakai (tiap
    // cincin punya ketinggiannya sendiri, dihitung dari sudut bidiknya), dan
    // --gimbal juga tidak dipakai (tiap cincin punya pitch-nya sendiri).
    const objectHeightM = Number(args.objheight);
    if (!Number.isFinite(objectHeightM) || objectHeightM <= 0) {
      console.error('Mode orbit butuh --objheight <m>: tinggi objek dari dasar.');
      process.exit(1);
    }

    orbit = generateOrbit(profile.camera, [0, 0], {
      radiusM: Number(args.radius ?? 18),
      objectHeightM,
      rings: Number(args.rings ?? ORBIT_DEFAULTS.rings),
      maxAngleStepDeg: Number(args.step ?? ORBIT_DEFAULTS.maxAngleStepDeg),
      maxPitchDeg: Number(args.maxpitch ?? ORBIT_DEFAULTS.maxPitchDeg),
      cap: !args['no-cap'],
    });

    const topRing = orbit.rings[orbit.rings.length - 1];
    if (topRing.heightM > profile.limits.maxAltitudeM) {
      console.error(
        `Cincin teratas jatuh di ${topRing.heightM.toFixed(0)} m, melewati batas ` +
          `${profile.limits.maxAltitudeM} m. Kecilkan --maxpitch atau --radius. Dibatalkan.`
      );
      process.exit(1);
    }

    const proj = makeProjector(lat, lng);
    // Jeda di tiap titik adalah bawaan orbit, bukan pilihan: pada jarak sekitar
    // 3 m antar foto, melintas terus berarti kamera tidak sempat menjepret.
    const hoverTime = args.hover !== undefined ? Number(args.hover) : 2;

    waypoints = orbit.waypoints.map((w) => {
      const [wlng, wlat] = proj.toLL(w.xy);
      return {
        lat: wlat,
        lng: wlng,
        height: w.height,
        speed,
        heading: w.heading,
        takePhoto: true,
        hoverTime,
        gimbalPitch: w.gimbalPitch,
      };
    });
  } else {
    // Sebar waypoint melingkar di sekitar titik tengah — pola paling aman buat test.
    waypoints = [];
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
  }

  const mission = {
    ...MISSION_DEFAULTS,
    height: orbit ? orbit.rings[orbit.rings.length - 1].heightM : alt,
    speed,
    finishAction: args.finish ?? MISSION_DEFAULTS.finishAction,
    // Orbit butuh arah hadap sendiri di tiap titik; followWayline justru
    // membuat kamera menyorot tangensial dan melewatkan objeknya.
    headingMode: orbit
      ? args.poi
        ? 'towardPOI'
        : 'smoothTransition'
      : MISSION_DEFAULTS.headingMode,
    poi: orbit ? { lat, lng, height: orbit.objectHeightM / 2 } : null,
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

  if (orbit) {
    const hoverPerPhotoSec = args.hover !== undefined ? Number(args.hover) : 2;
    const dur = missionDuration(orbit.waypoints, {
      speed,
      stopAtEach: true,
      hoverPerPhotoSec,
    });
    const rows = orbit.rings
      .map(
        (r) =>
          `    ${String(r.index + 1).padStart(2)}  ${r.heightM.toFixed(1).padStart(7)}` +
          `${r.aimHeightM.toFixed(1).padStart(8)}${String(r.pitchDeg).padStart(8)}` +
          `${r.slantM.toFixed(1).padStart(8)}${r.gsdCm.toFixed(2).padStart(7)}` +
          `${String(r.photos).padStart(7)}${r.angleStepDeg.toFixed(1).padStart(8)}`
      )
      .join('\n');

    console.log(`
  Orbit ter-generate
  ------------------
  Sumbu objek   : ${lat}, ${lng}
  Tinggi objek  : ${orbit.objectHeightM} m
  Radius orbit  : ${orbit.radiusM} m
  Arah hadap    : ${mission.headingMode}${args.poi ? '' : ' (sudut dihitung per titik)'}

  Cincin   tinggi   bidik   pitch  miring    GSD   foto   sudut
${rows}

  ${
    orbit.cap
      ? `Petak nadir   : ${orbit.cap.photos} foto @ ${orbit.cap.heightM.toFixed(1)} m, GSD ${orbit.cap.gsdCm.toFixed(2)} cm/px`
      : 'Petak nadir   : mati — puncak objek tidak akan terpotret'
  }
  Waypoint      : ${s.waypoints} titik
  Foto          : ${s.photos}
  Ketelitian    : ${orbit.gsdBestCm.toFixed(2)} - ${orbit.gsdWorstCm.toFixed(2)} cm/px di dinding
  Kecepatan     : ${speed} m/s, jeda ${hoverPerPhotoSec}s di tiap titik
  Jarak jalur   : ${s.distanceM.toFixed(1)} m
  Estimasi      : ${Math.floor(dur / 60)}m ${Math.round(dur % 60)}s
  Selesai       : ${mission.finishAction}

  Kaki objek 0-${orbit.rings[0].aimHeightM.toFixed(1)} m tidak terjangkau drone —
  keliling dengan kamera tangan untuk bagian itu, lalu gabungkan di software
  olah yang sama.

  Arah hadap per titik belum pernah terlihat di file yang terbukti diterima
  DJI Fly. Kalau drone mengelilingi objek tapi kameranya tidak menghadap ke
  dalam, coba ${args.poi ? 'tanpa --poi' : '--poi'}.

  File:
    ${kmzPath}
    ${path.join(outDir, base + '.unpacked')}${path.sep}  (versi mentah buat dibandingkan)

  Lanjut: ikuti TEST-CHECKLIST.md untuk transfer ke HP dan uji import.
`);
  } else {
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
}

main();
