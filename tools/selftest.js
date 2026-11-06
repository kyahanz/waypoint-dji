#!/usr/bin/env node
// Uji cepat bagian yang tidak bisa diperiksa lewat layar: hitungan kamera per
// drone, pola terbang, tuntutan laju naik, gerbang keselamatan, dan isi file
// WPML yang benar-benar ditulis.
//
// Jalankan: node tools/selftest.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProfile, PRESETS } from '../src/profiles.js';
import {
  computeSurveyParams,
  altitudeFromGsd,
  gsdFromAltitude,
  generatePattern,
  climbDemand,
  makeProjector,
  splitByBattery,
} from '../src/survey.js';
import { evaluateSafety } from '../src/safety.js';
import { buildTemplateKml, buildWaylinesWpml, MISSION_DEFAULTS } from '../src/wpml.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', 'drones.json'), 'utf8'));

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ok   ${label}${detail ? ' — ' + detail : ''}`);
  else {
    failed++;
    console.log(`  GAGAL ${label}${detail ? ' — ' + detail : ''}`);
  }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- kamera

console.log('\nGSD per drone (ketinggian 100 m, lensa & mode bawaan)');
for (const d of registry.drones) {
  const p = resolveProfile(registry, { droneId: d.id });
  const gsd = gsdFromAltitude(p.camera, 100);

  // GSD harus identik dengan rumus ekuivalen 35mm: 3600 * tinggi / (eq35 * px).
  const expected = (3600 * 100) / (p.lens.eq35mm * p.mode.imageWidthPx);
  ok(
    near(gsd, expected, 1e-9),
    `${d.name} (${p.lens.name}, ${p.mode.label})`,
    `${gsd.toFixed(2)} cm/px`
  );

  // Bolak-balik harus kembali ke angka yang sama.
  ok(near(altitudeFromGsd(p.camera, gsd), 100, 1e-6), `  bolak-balik ketinggian ${d.id}`);
}

// Angka yang sudah diketahui dari profil lama Mini 5 Pro: sensor 13.2 mm,
// fokal 8.8 mm, 8192 px -> 1.83 cm/px di 100 m. Registry baru tidak boleh
// mengubah hasil ini.
{
  const p = resolveProfile(registry, { droneId: 'mini5pro', modeId: '50mp' });
  ok(near(gsdFromAltitude(p.camera, 100), 1.831, 0.002), 'Mini 5 Pro 50 MP cocok dengan profil lama', `${gsdFromAltitude(p.camera, 100).toFixed(3)} cm/px`);
}

// ---------------------------------------------------------------- preset

console.log('\nPreset menjaga ketelitian, bukan ketinggian');
for (const preset of PRESETS) {
  const alts = ['mini5pro', 'mavic3pro', 'air3'].map((id) => {
    const p = resolveProfile(registry, { droneId: id });
    return { id, alt: altitudeFromGsd(p.camera, preset.gsdCm), gsd: preset.gsdCm };
  });
  const sameGsd = alts.every((a) => {
    const p = resolveProfile(registry, { droneId: a.id });
    return near(gsdFromAltitude(p.camera, a.alt), preset.gsdCm, 1e-9);
  });
  ok(sameGsd, `preset ${preset.name}`, alts.map((a) => `${a.id} ${a.alt.toFixed(0)} m`).join(', '));
}

// ---------------------------------------------------------------- pola

console.log('\nPola terbang');
const square = [
  [-200, -200],
  [200, -200],
  [200, 200],
  [-200, 200],
];
const prof = resolveProfile(registry, { droneId: 'mini5pro' });
const params = computeSurveyParams(prof.camera, {
  altitudeM: 80,
  frontOverlap: 0.8,
  sideOverlap: 0.7,
  minIntervalSec: prof.camera.minIntervalSec,
});
const gridOpts = {
  angleDeg: 0,
  sideSpacing: params.sideSpacing,
  frontSpacing: params.frontSpacing,
  mode: 'continuous',
  overshoot: 0,
};

const single = generatePattern(square, { ...gridOpts, pattern: 'single' });
const cross = generatePattern(square, { ...gridOpts, pattern: 'cross' });
const oblique = generatePattern(square, { ...gridOpts, pattern: 'crossOblique' });

ok(single.passes.length === 1, 'peta datar = 1 lintasan');
ok(cross.passes.length === 2, 'silang = 2 lintasan');
ok(cross.passes[1].angleDeg === 90, 'lintasan kedua menyilang 90°', `${cross.passes[0].angleDeg}° lalu ${cross.passes[1].angleDeg}°`);
ok(cross.photos > single.photos * 1.8, 'silang hampir melipatgandakan foto', `${single.photos} -> ${cross.photos}`);
ok(oblique.gimbalPitch === -45, 'silang + miring memiringkan gimbal ke -45°');
ok(single.gimbalPitch === -90, 'peta datar tetap nunduk lurus');

// ---------------------------------------------------------------- laju naik

console.log('\nTuntutan laju naik (terrain following)');
{
  // Lereng 20%: naik 20 m setiap 100 m mendatar.
  const wps = [
    { xy: [0, 0], height: 80 },
    { xy: [100, 0], height: 100 },
    { xy: [200, 0], height: 120 },
  ];
  const slow = climbDemand(wps, 5);
  const fast = climbDemand(wps, 10);
  ok(near(slow.rateMs, 1, 1e-9), 'di 5 m/s butuh naik 1.0 m/s', `${slow.rateMs.toFixed(2)} m/s`);
  ok(near(fast.rateMs, 2, 1e-9), 'di 10 m/s butuh naik 2.0 m/s', `${fast.rateMs.toFixed(2)} m/s`);
  ok(climbDemand([{ xy: [0, 0] }, { xy: [100, 0] }], 10).rateMs === 0, 'tanpa data tinggi, tuntutannya nol');
}

// ---------------------------------------------------------------- keselamatan

console.log('\nGerbang keselamatan');
function fakePlan(over = {}) {
  const proj = makeProjector(-6.25, 107.12);
  const wps = single.waypoints.map((w) => ({ ...w }));
  const sorties = splitByBattery(wps, {
    speed: 8,
    usableFlightMin: 22,
    accel: 2.5,
  });
  return {
    proj,
    altitude: 80,
    area: 160000,
    gridArea: 160000,
    bufferM: 10,
    params,
    speed: 8,
    stopAtEach: false,
    maxDist: 300,
    pattern: 'single',
    patternName: 'Peta datar',
    gimbalPitch: -90,
    grid: single,
    sorties,
    terrain: { on: false },
    reliefHint: null,
    advanced: {
      rcLostAction: 'goBack',
      finishAction: 'goHome',
      gimbalPitch: -90,
      safeHeightM: 20,
      rcLostActionLabel: 'RTH',
      finishActionLabel: 'RTH',
    },
    ...over,
  };
}

{
  const verified = resolveProfile(registry, {
    droneId: 'mini5pro',
    enumOverride: { droneEnumValue: 1, droneSubEnumValue: 0, payloadEnumValue: 1, payloadSubEnumValue: 0, verified: true },
  });

  const clean = evaluateSafety(fakePlan(), verified);
  ok(clean.ok, 'rencana wajar + kode terverifikasi = tidak ada penghalang', clean.blockers.map((b) => b.code).join(','));

  // Kode yang dipinjam dari model selini memberi peringatan, tapi TIDAK
  // menahan export: nilainya punya dasar, cuma bukan dari drone ini sendiri.
  const borrowed = evaluateSafety(fakePlan(), prof);
  ok(
    borrowed.ok && borrowed.findings.some((f) => f.code === 'enum-borrowed'),
    'kode pinjaman memperingatkan tanpa menahan export',
    prof.enumConfidence
  );

  // Tanpa dasar sama sekali, barulah ditahan.
  const noEnum = resolveProfile(
    { drones: [{ ...registry.drones[0], enums: null }] },
    { droneId: registry.drones[0].id }
  );
  const blank = evaluateSafety(fakePlan(), noEnum);
  ok(blank.blockers.some((b) => b.code === 'enum-unknown'), 'kode drone kosong menahan export');

  ok(
    resolveProfile(registry, { droneId: 'mini4pro' }).enumConfidence === 'observed-model',
    'Mini 4 Pro ditandai teramati langsung, bukan dipinjam'
  );

  const tooHigh = evaluateSafety(fakePlan({ altitude: 150 }), verified);
  ok(tooHigh.blockers.some((b) => b.code === 'alt-over'), 'ketinggian di atas batas tertahan');

  const rcLost = evaluateSafety(
    fakePlan({ advanced: { ...fakePlan().advanced, rcLostAction: 'hover', rcLostActionLabel: 'Diam di tempat' } }),
    verified
  );
  ok(rcLost.blockers.some((b) => b.code === 'rc-lost'), 'sinyal hilang selain RTH tertahan');

  const land = evaluateSafety(
    fakePlan({ advanced: { ...fakePlan().advanced, finishAction: 'autoLand', finishActionLabel: 'Mendarat' } }),
    verified
  );
  ok(land.blockers.some((b) => b.code === 'finish-action'), 'mendarat di tempat setelah selesai tertahan');

  // Lereng curam + kecepatan tinggi: drone tidak sanggup naik secepat itu.
  const steep = single.waypoints.map((w, i) => ({ ...w, height: 80 + i * 25 }));
  const climb = evaluateSafety(
    fakePlan({
      speed: 12,
      grid: { ...single, waypoints: steep },
      terrain: { on: true, ready: true, relief: { relief: 100 }, maxHeight: 180, minHeight: 80 },
    }),
    verified
  );
  ok(climb.blockers.some((b) => b.code === 'climb-rate'), 'lereng yang melampaui laju naik drone tertahan');

  const obstacle = evaluateSafety(fakePlan(), verified, {
    obstacles: [{ heightM: 95, clearanceM: -15, distM: 5 }],
  });
  ok(obstacle.blockers.some((b) => b.code === 'obstacle-hit'), 'bangunan lebih tinggi dari jalur tertahan');
}

// ---------------------------------------------------------------- WPML

console.log('\nIsi file WPML');
{
  const mission = {
    ...MISSION_DEFAULTS,
    waypoints: [
      { lat: -6.25, lng: 107.12, height: 80, speed: 8, heading: 90, headingMode: 'smoothTransition', gimbalPitch: -45, takePhoto: false, hoverTime: 0 },
      { lat: -6.251, lng: 107.121, height: 85, speed: 8, heading: 90, headingMode: 'smoothTransition', gimbalPitch: -45, takePhoto: false, hoverTime: 0 },
    ],
    height: 80,
    speed: 8,
    finishAction: 'goHome',
    exitOnRCLost: 'executeLostAction',
    executeRCLostAction: 'goBack',
    takeOffSecurityHeight: 45,
    flyToWaylineMode: 'safely',
    intervalShooting: { mode: 'distance', value: 12.5 },
  };

  const p = resolveProfile(registry, {
    droneId: 'mini5pro',
    enumOverride: { droneEnumValue: 77, droneSubEnumValue: 1, payloadEnumValue: 66, payloadSubEnumValue: 2, verified: true },
  });

  const kml = buildTemplateKml(mission, p);
  const wpml = buildWaylinesWpml(mission, p);

  // Tag khas Enterprise TIDAK boleh muncul di dialek DJI Fly: file asli
  // tidak memuatnya, dan tag asing ke parser yang menolak tanpa pesan error
  // adalah cara tercepat bikin impor gagal tanpa ketahuan sebabnya.
  for (const tag of ['payloadInfo', 'takeOffSecurityHeight', 'templateType', 'globalHeight']) {
    ok(!kml.includes(`wpml:${tag}`) && !wpml.includes(`wpml:${tag}`), `tanpa ${tag}`);
  }
  ok(!kml.includes('<Placemark>'), 'template.kml tanpa Placemark, seperti file asli');
  ok(kml.includes('<wpml:author>fly</wpml:author>'), 'author fly');
  ok(wpml.includes('<wpml:distance>0</wpml:distance>'), 'distance 0, dihitung drone sendiri');

  // Sejak template.kml jadi minimal, tiap tag harus diperiksa di berkas yang
  // memang memuatnya — bukan di dua-duanya.
  for (const [label, want] of [
    ['finishAction goHome', '<wpml:finishAction>goHome</wpml:finishAction>'],
    ['executeRCLostAction goBack', '<wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>'],
    ['enum drone hasil impor', '<wpml:droneEnumValue>77</wpml:droneEnumValue>'],
    ['namespace DJI Fly', 'xmlns:wpml="http://www.uav.com/wpmz/1.0.2"'],
  ]) {
    ok(kml.includes(want) && wpml.includes(want), label);
  }

  for (const [label, want] of [
    ['gimbal -45', '<wpml:gimbalPitchRotateAngle>-45</wpml:gimbalPitchRotateAngle>'],
    ['gimbal dikunci tiap titik', '<wpml:waypointGimbalPitchAngle>-45</wpml:waypointGimbalPitchAngle>'],
    ['belok mulus seperti DJI Fly', 'toPointAndStopWithContinuityCurvature'],
    ['action group paralel', '<wpml:actionGroupMode>parallel</wpml:actionGroupMode>'],
    ['useStraightLine 0', '<wpml:useStraightLine>0</wpml:useStraightLine>'],
    ['poi index ikut ditulis', '<wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>'],
    ['jepret per jarak', '<wpml:actionTriggerType>multipleDistance</wpml:actionTriggerType>'],
  ]) {
    ok(wpml.includes(want), label);
  }
}

// ---------------------------------------------------------------- EXIF

console.log('\nBaca posisi dari foto');
{
  const { makeExifJpeg } = await import('./make-exif-fixture.js');
  const { readPhotoLocation, readLastPhoto } = await import('../web/exif.js');

  const jpeg = (o) => new File([makeExifJpeg(o)], o.name ?? 'DJI_0001.JPG');

  {
    const r = await readPhotoLocation(
      jpeg({ lat: -6.2549, lng: 107.1199, altitudeM: 97, takenAt: '2026:11:05 09:12:33' })
    );
    ok(near(r.lngLat[1], -6.2549, 1e-6), 'lintang selatan terbaca negatif', `${r.lngLat[1]}`);
    ok(near(r.lngLat[0], 107.1199, 1e-6), 'bujur timur terbaca', `${r.lngLat[0]}`);
    ok(near(r.altitudeM, 97, 0.01), 'ketinggian terbaca', `${r.altitudeM} m`);
    ok(r.takenAt instanceof Date && r.takenAt.getHours() === 9, 'waktu pengambilan terbaca');
    ok(r.model === 'FC8482', 'model kamera terbaca', r.model ?? '-');
  }

  {
    // Belahan barat & utara: tanda harus ikut berbalik.
    const r = await readPhotoLocation(jpeg({ lat: 40.7128, lng: -74.006 }));
    ok(near(r.lngLat[0], -74.006, 1e-5) && near(r.lngLat[1], 40.7128, 1e-5), 'lintang utara / bujur barat');
  }

  {
    // Yang dipilih harus foto dengan waktu TERAKHIR, bukan terakhir di daftar.
    const files = [
      jpeg({ lat: -6.2, lng: 107.1, takenAt: '2026:11:05 09:30:00', name: 'DJI_0003.JPG' }),
      jpeg({ lat: -6.3, lng: 107.2, takenAt: '2026:11:05 09:45:00', name: 'DJI_0004.JPG' }),
      jpeg({ lat: -6.1, lng: 107.0, takenAt: '2026:11:05 09:05:00', name: 'DJI_0001.JPG' }),
    ];
    const { last, read } = await readLastPhoto(files);
    ok(read === 3 && last.name === 'DJI_0004.JPG', 'foto terakhir dipilih dari waktu, bukan urutan', last.name);
  }

  {
    // File tanpa EXIF sama sekali (mis. hasil kirim lewat chat).
    const plain = new File([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], 'kiriman-wa.jpg');
    let msg = '';
    try {
      await readPhotoLocation(plain);
    } catch (e) {
      msg = e.message;
    }
    ok(msg.includes('EXIF'), 'foto tanpa EXIF ditolak dengan penjelasan', msg);

    const mixed = await readLastPhoto([plain, jpeg({ lat: -6.25, lng: 107.12 })]);
    ok(mixed.read === 1 && mixed.skipped.length === 1, 'file rusak dilewati, sisanya tetap dipakai');
  }
}

console.log(failed ? `\n${failed} pemeriksaan GAGAL\n` : '\nSemua pemeriksaan lolos\n');
process.exit(failed ? 1 : 0);
