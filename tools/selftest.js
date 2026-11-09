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
  peakSpeedOverLeg,
  medianLegM,
  resumeIndexFor,
  PATTERNS,
  surfaceGsd,
  slantRange,
  tiltFromNadirDeg,
  generateOrbit,
  ORBIT_DEFAULTS,
  missionDuration,
  climbDemand,
  makeProjector,
  splitByBattery,
} from '../src/survey.js';
import { evaluateSafety, JARINGAN_LISTRIK } from '../src/safety.js';
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

// ------------------------------------------------------- 3D bangunan

console.log('\nPola 3D bangunan (nadir + miring dalam satu file)');
{
  const b3d = generatePattern(square, { ...gridOpts, pattern: 'building3d' });

  ok(b3d.passes.length === 3, 'tiga lintasan');
  ok(
    b3d.passes.map((p) => p.gimbalPitch).join(',') === '-90,-45,-45',
    'lintasan 1 nadir, lintasan 2 & 3 miring',
    b3d.passes.map((p) => `${p.angleDeg}°@${p.gimbalPitch}`).join(' ')
  );
  ok(
    b3d.passes[1].angleDeg === 0 && b3d.passes[2].angleDeg === 90,
    'dua lintasan miring menyilang 90°'
  );

  // Inilah yang hilang di crossOblique, dan alasan pola ini ada.
  ok(
    b3d.waypoints.some((w) => w.gimbalPitch === -90),
    'ADA foto nadir — yang tidak dimiliki silang + miring'
  );
  ok(
    b3d.waypoints.some((w) => w.gimbalPitch === -45),
    'dan ada foto miring di file yang sama'
  );
  ok(b3d.mixedGimbal === true, 'ditandai mencampur sudut gimbal');
  ok(
    b3d.gimbalPitches.join(',') === '-90,-45',
    'sudut yang dipakai dilaporkan apa adanya',
    b3d.gimbalPitches.join(' + ')
  );

  // Pola bersudut seragam TIDAK boleh menulis sudut di titik: kalau diisi,
  // slider gimbal manual di UI jadi tidak berefek tanpa ada yang bilang.
  ok(
    oblique.waypoints.every((w) => w.gimbalPitch === undefined),
    'pola seragam membiarkan sudutnya kosong, supaya slider manual tetap berlaku'
  );
  ok(oblique.mixedGimbal === false, 'silang + miring tidak dianggap mencampur');

  ok(
    near(b3d.photos / oblique.photos, 1.5, 0.02),
    'nadir menambah sekitar 50% foto',
    `${oblique.photos} -> ${b3d.photos}`
  );

  let tolak = false;
  try {
    generatePattern(square, { ...gridOpts, pattern: 'orbit' });
  } catch {
    tolak = true;
  }
  ok(tolak, 'orbit tetap ditolak generatePattern');
}

// ------------------------------------------------- GSD kamera miring

console.log('\nKetelitian kamera miring');
{
  const p5 = resolveProfile(registry, { droneId: 'mini5pro' });
  const cam = p5.camera;
  const H = 80;
  const nadirGsd = gsdFromAltitude(cam, H);

  ok(tiltFromNadirDeg(-90) === 0, 'gimbal -90 = 0° dari nadir');
  ok(tiltFromNadirDeg(-45) === 45, 'gimbal -45 = 45° dari nadir');
  ok(near(slantRange(H, -90), H, 1e-9), 'nadir: jarak ke permukaan = ketinggian');
  ok(
    near(slantRange(H, -45), H * Math.SQRT2, 1e-6),
    'gimbal -45: jarak miring = ketinggian x akar 2',
    `${slantRange(H, -45).toFixed(1)} m`
  );

  const nadir = surfaceGsd(cam, H, -90);
  const obl45 = surfaceGsd(cam, H, -45);
  const obl30 = surfaceGsd(cam, H, -30);

  ok(near(nadir.centerCm, nadirGsd, 1e-9), 'pola nadir: GSD permukaan = GSD nadir');
  ok(near(obl45.vsNadir, Math.SQRT2, 1e-6), 'gimbal -45 meleset 41% dari angka nadir', `${obl45.centerCm.toFixed(2)} vs ${nadirGsd.toFixed(2)} cm/px`);
  ok(near(obl30.vsNadir, 2, 1e-6), 'gimbal -30 meleset 100%', `${obl30.centerCm.toFixed(2)} cm/px`);
  ok(obl45.farCm > obl45.nearCm * 3, 'dalam satu foto miring, tepi jauh jauh lebih kasar', `${obl45.nearCm.toFixed(2)} -> ${obl45.farCm.toFixed(2)} cm/px`);
  ok(obl45.farM > obl45.nearM * 5, 'tepi jauh frame mendarat ratusan meter di depan drone', `${obl45.nearM.toFixed(0)} -> ${obl45.farM.toFixed(0)} m`);

  // Tanpa pembatas, gimbal mendatar bikin jarak miring jadi tak hingga dan
  // angka tak hingga akan tampil di layar seolah-olah sah.
  ok(Number.isFinite(surfaceGsd(cam, H, 0).centerCm), 'gimbal mendatar tidak menghasilkan angka tak hingga');

  // params harus membawa dua-duanya: nadir untuk jarak jalur, permukaan untuk layar.
  const par = computeSurveyParams(cam, { altitudeM: H, gimbalPitchDeg: -45 });
  ok(near(par.gsd, nadirGsd, 1e-9), 'params.gsd tetap angka nadir — dasar jarak jalur');
  ok(near(par.surfaceGsd, obl45.centerCm, 1e-9), 'params.surfaceGsd angka yang mendarat di dinding');
  ok(par.oblique === true, 'params menandai polanya miring');
  ok(computeSurveyParams(cam, { altitudeM: H }).oblique === false, 'tanpa sudut, dianggap nadir');
  ok(
    near(computeSurveyParams(cam, { altitudeM: H }).surfaceGsd, nadirGsd, 1e-9),
    'dan GSD permukaannya sama dengan GSD nadir'
  );
}

// ------------------------------------------------------------------- orbit

console.log('\nOrbit objek tegak');
{
  const p5 = resolveProfile(registry, { droneId: 'mini5pro' });
  const orb = generateOrbit(p5.camera, [0, 0], {
    radiusM: 18,
    objectHeightM: 20,
    rings: 4,
  });

  ok(orb.rings.length === 4, 'empat cincin terbentuk');
  ok(
    orb.photos === orb.rings.reduce((a, r) => a + r.photos, 0) + orb.cap.photos,
    'jumlah foto = semua cincin + petak nadir',
    `${orb.photos} foto`
  );

  // Kamera harus MENGHADAP PUSAT di tiap titik. Ini inti orbit: kalau salah,
  // drone tetap mengelilingi tugu dengan rapi tapi tidak satu pun foto
  // memuat tugunya di tengah frame.
  let worstHeading = 0;
  let worstRadius = 0;
  for (const w of orb.waypoints) {
    if (!w.poi) continue;
    const want = ((Math.atan2(-w.xy[0], -w.xy[1]) * 180) / Math.PI + 360) % 360;
    worstHeading = Math.max(worstHeading, Math.abs(((w.heading - want + 540) % 360) - 180));
    worstRadius = Math.max(worstRadius, Math.abs(Math.hypot(w.xy[0], w.xy[1]) - 18));
  }
  ok(worstHeading < 1e-9, 'tiap titik menghadap tepat ke sumbu objek');
  ok(worstRadius < 1e-9, 'tiap titik berjarak tepat satu radius dari sumbu');

  // Geometri terkunci: tinggi = bidik + radius * tan(pitch). Kalau ini lepas,
  // cincin curam akan membidik langit di atas puncak atau tanah di depan kaki.
  let worstGeom = 0;
  for (const r of orb.rings) {
    const want = r.aimHeightM + 18 * Math.tan((Math.abs(r.pitchDeg) * Math.PI) / 180);
    worstGeom = Math.max(worstGeom, Math.abs(r.heightM - want));
  }
  ok(worstGeom < 0.05, 'tinggi tiap cincin terkunci ke sudut bidiknya');

  const low = orb.rings[0];
  const high = orb.rings[orb.rings.length - 1];
  ok(high.heightM > low.heightM, 'cincin naik dari bawah ke atas', `${low.heightM.toFixed(1)} -> ${high.heightM.toFixed(1)} m`);
  ok(high.aimHeightM > low.aimHeightM, 'titik bidik naik menyusuri objek');
  ok(high.pitchDeg < low.pitchDeg, 'cincin atas lebih curam');

  // Lantai ketinggian: drone yang naik, titik bidiknya TIDAK. Kalau titik
  // bidik ikut naik, pita terbawah objek tidak terpotret cincin mana pun.
  ok(low.heightM >= ORBIT_DEFAULTS.minRingHeightM - 1e-9, 'cincin terbawah tidak jatuh di bawah lantai ketinggian', `${low.heightM.toFixed(1)} m`);
  ok(low.raisedToFloor && low.aimHeightM === 20 * 0.15, 'yang dinaikkan drone-nya, bukan titik bidiknya', `bidik tetap ${low.aimHeightM.toFixed(1)} m`);
  {
    const tinggi = generateOrbit(p5.camera, [0, 0], { radiusM: 18, objectHeightM: 60 });
    ok(!tinggi.rings[0].raisedToFloor, 'objek tinggi tidak perlu dinaikkan', `cincin bawah ${tinggi.rings[0].heightM.toFixed(1)} m`);
  }

  // Cincin curam duduk lebih jauh dari dinding, jadi GSD-nya WAJIB lebih
  // kasar. Kalau terbalik, berarti GSD dihitung dari ketinggian terbang —
  // bukan dari jarak miring ke dinding.
  ok(high.gsdCm > low.gsdCm, 'cincin atas lebih kasar karena duduk lebih jauh', `${low.gsdCm.toFixed(2)} -> ${high.gsdCm.toFixed(2)} cm/px`);
  ok(high.slantM > low.slantM, 'jarak miring cincin atas lebih jauh dari radiusnya');

  // Langkah sudut yang mengikat, bukan overlap frame: di objek sempit, frame
  // jauh lebih lebar dari objeknya, jadi overlap frame selalu terlihat sehat.
  const worstStep = Math.max(...orb.rings.map((r) => r.angleStepDeg));
  ok(worstStep <= ORBIT_DEFAULTS.maxAngleStepDeg + 1e-9, 'langkah sudut tidak melebihi batas', `${worstStep.toFixed(1)}°`);
  ok(orb.rings.every((r) => r.limitedBy === 'sudut'), 'pada radius 18 m, sudut yang mengikat — bukan overlap');

  // Petak nadir menatap lurus ke bawah; cincin tidak pernah begitu.
  ok(orb.cap.photos > 0 && orb.waypoints.some((w) => w.gimbalPitch === -90), 'petak nadir menunduk lurus');
  ok(
    generateOrbit(p5.camera, [0, 0], { radiusM: 18, objectHeightM: 20, cap: false }).cap === null,
    'petak nadir bisa dimatikan'
  );

  // Arah hadap berubah di tiap titik orbit, tapi itu bukan belokan. Tanpa
  // penanda arc, estimasi waktunya kena denda belokan di setiap titik.
  const arcS = missionDuration(orb.waypoints, { speed: 5, stopAtEach: false });
  const asTurns = missionDuration(
    orb.waypoints.map((w) => ({ ...w, arc: false })),
    { speed: 5, stopAtEach: false }
  );
  ok(asTurns > arcS * 2, 'jalur melingkar tidak kena denda belokan tiap titik', `${arcS.toFixed(0)}s vs ${asTurns.toFixed(0)}s kalau dihitung belokan`);

  // generatePattern tidak boleh diam-diam melayani orbit dengan pola grid.
  let tolak = false;
  try {
    generatePattern(square, { ...gridOpts, pattern: 'orbit' });
  } catch {
    tolak = true;
  }
  ok(tolak, 'generatePattern menolak pola orbit, tidak diam-diam jadi grid');

  // Radius kecil -> GSD halus, radius besar -> GSD kasar. Hubungan lurus.
  const dekat = generateOrbit(p5.camera, [0, 0], { radiusM: 12, objectHeightM: 20 });
  const jauh = generateOrbit(p5.camera, [0, 0], { radiusM: 36, objectHeightM: 20 });
  ok(dekat.gsdBestCm < jauh.gsdBestCm, 'radius lebih rapat berarti GSD lebih halus', `${dekat.gsdBestCm.toFixed(2)} vs ${jauh.gsdBestCm.toFixed(2)} cm/px`);
}

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
      { lat: -6.25, lng: 107.12, height: 80, speed: 8, heading: 90, headingMode: 'followWayline', gimbalPitch: -45, takePhoto: true, hoverTime: 1 },
      { lat: -6.251, lng: 107.121, height: 85, speed: 8, heading: 90, headingMode: 'followWayline', gimbalPitch: -45, takePhoto: true, hoverTime: 1 },
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
  for (const tag of ['payloadInfo', 'templateType', 'globalHeight']) {
    ok(!kml.includes(`wpml:${tag}`) && !wpml.includes(`wpml:${tag}`), `tanpa ${tag}`);
  }
  ok(!kml.includes('<Placemark>'), 'template.kml tanpa Placemark, seperti file asli');
  ok(kml.includes('<wpml:author>fly</wpml:author>'), 'author fly');
  ok(kml.includes('<wpml:takeOffSecurityHeight>'), 'takeOffSecurityHeight ditulis');
  ok(kml.includes('<wpml:globalRTHHeight>'), 'globalRTHHeight ditulis');
  ok(!/<wpml:distance>0<\/wpml:distance>/.test(wpml), 'distance dihitung, bukan nol');

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
    ['gimbal diputar tiap titik', '<wpml:actionActuatorFunc>gimbalEvenlyRotate</wpml:actionActuatorFunc>'],
    ['belok lewat, bukan berhenti', 'toPointAndPassWithContinuityCurvature'],
    ['action group berurutan', '<wpml:actionGroupMode>sequence</wpml:actionGroupMode>'],
    ['fileSuffix ikut ditulis', '<wpml:fileSuffix>'],
    ['useStraightLine 0', '<wpml:useStraightLine>0</wpml:useStraightLine>'],
    ['poi index ikut ditulis', '<wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>'],
    ['arah hadap followWayline', '<wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>'],
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

// ---------------------------------------------------------------- edit KMZ

console.log('\nEdit file WPML di tempat');
{
  const E = await import('../src/wpml-edit.js');
  const { buildWaylinesWpml, MISSION_DEFAULTS } = await import('../src/wpml.js');

  const prof2 = resolveProfile(registry, { droneId: 'mini5pro' });
  const wps = [0, 1, 2].map((i) => ({
    lat: -6.25 - i * 0.001,
    lng: 107.1 + i * 0.001,
    height: 50,
    speed: 2.5,
    heading: 0,
    headingMode: 'followWayline',
    gimbalPitch: -90,
    takePhoto: true,
    hoverTime: 2,
  }));
  const xml = buildWaylinesWpml(
    { ...MISSION_DEFAULTS, waypoints: wps, height: 50, speed: 2.5 },
    prof2
  );

  const doc = E.parseWaylines(xml);
  ok(doc.waypoints.length === 3, 'tiga titik terbaca');

  // Syarat paling keras: tanpa diedit, berkas keluar identik huruf per huruf.
  ok(E.serializeWaylines(doc) === xml, 'tanpa perubahan, berkas keluar identik');

  const naik = {
    ...doc,
    placemarks: doc.placemarks.map((m) => E.writeWaypoint(m, { height: 73, speed: 6 })),
  };
  const naikXml = E.serializeWaylines(naik);
  const d2 = E.parseWaylines(naikXml);
  ok(
    d2.waypoints.every((w) => w.height === 73 && w.speed === 6),
    'ketinggian & kecepatan semua titik terubah'
  );

  // Hanya baris yang memang diubah yang boleh beda — inilah seluruh alasan
  // pendekatan edit-di-tempat dipilih.
  const a = xml.split('\n');
  const b = naikXml.split('\n');
  const beda = a.filter((line, i) => line !== b[i]).length;
  ok(beda === 6, 'cuma 6 baris berubah, 2 per titik', beda + ' baris');

  const w = E.readWaypoint(E.writeWaypoint(doc.placemarks[0], { lng: 107.5, lat: -6.5 }));
  ok(w.lng === 107.5 && w.lat === -6.5, 'koordinat tergeser');

  const kurang = E.renumber(doc.placemarks.slice(1));
  const kurangXml = E.serializeWaylines({ ...doc, placemarks: kurang });
  ok(
    E.parseWaylines(kurangXml).waypoints.map((x) => x.index).join(',') === '0,1',
    'penomoran rapat lagi setelah titik dihapus'
  );

  const cfg = E.readMissionConfig(xml);
  ok(cfg.finishAction === 'goHome' && cfg.droneEnumValue === 68, 'setelan misi terbaca');
  ok(
    E.getTag(E.writeMissionConfig(xml, { finishAction: 'hover' }), 'finishAction') === 'hover',
    'setelan misi bisa diubah'
  );
}


// ------------------------------------------------- orbit: file WPML & gerbang

console.log('\nOrbit: isi file dan gerbang keselamatan');
{
  const p5 = resolveProfile(registry, { droneId: 'mini5pro' });
  const orb = generateOrbit(p5.camera, [0, 0], { radiusM: 18, objectHeightM: 20, rings: 3 });
  const proj = makeProjector(-6.25, 107.12);

  const mission = {
    ...MISSION_DEFAULTS,
    headingMode: 'smoothTransition',
    poi: { lat: -6.25, lng: 107.12, height: 10 },
    waypoints: orb.waypoints.map((w) => {
      const [lng, lat] = proj.toLL(w.xy);
      return {
        lat,
        lng,
        height: w.height,
        heading: w.heading,
        gimbalPitch: w.gimbalPitch,
        takePhoto: true,
        hoverTime: 2,
      };
    }),
  };

  const xml = buildWaylinesWpml(mission, p5);

  const sudut = [...xml.matchAll(/<wpml:waypointHeadingAngle>([^<]+)</g)].map((m) => m[1]);
  ok(new Set(sudut).size > 10, 'sudut hadap berbeda-beda di tiap titik', `${new Set(sudut).size} nilai berbeda`);
  ok(
    xml.includes('<wpml:waypointHeadingAngleEnable>1<'),
    'sudut hadap diaktifkan — kalau 0, angkanya diabaikan drone'
  );
  ok(
    xml.includes('<wpml:waypointPoiPoint>-6.25,107.12,10<'),
    'titik pusat ikut tertulis, bukan 0,0,0'
  );

  const pitch = new Set(
    [...xml.matchAll(/<wpml:gimbalPitchRotateAngle>([^<]+)</g)].map((m) => m[1])
  );
  ok(pitch.size === 4, 'tiga cincin + petak nadir = empat sudut gimbal', [...pitch].join(', '));
  ok(pitch.has('-90'), 'petak nadir menunduk lurus di file');

  // Misi grid tidak boleh ikut berubah: poiPoint-nya tetap 0,0,0 seperti
  // file acuan yang terbukti diterima.
  const polos = buildWaylinesWpml(
    { ...MISSION_DEFAULTS, waypoints: [{ lat: -6.25, lng: 107.12, height: 50, takePhoto: true }] },
    p5
  );
  ok(
    polos.includes('<wpml:waypointPoiPoint>0.000000,0.000000,0.000000<') &&
      polos.includes('<wpml:waypointHeadingMode>followWayline<'),
    'misi grid tidak ikut berubah bentuknya'
  );

  // Gerbang keselamatan khusus orbit.
  const orbitPlan = (over = {}, orbOver = {}) => {
    const g = generateOrbit(p5.camera, [0, 0], {
      radiusM: 18,
      objectHeightM: 20,
      rings: 3,
      ...orbOver,
    });
    return {
      proj,
      altitude: Math.max(...g.rings.map((r) => r.heightM)),
      area: 2000,
      gridArea: 2000,
      bufferM: 0,
      params: {
        gsd: g.gsdWorstCm,
        recommendedSpeed: 5,
        maxSpeedInterval: 5,
        sideSpacing: 5,
        frontSpacing: 3,
      },
      speed: 4,
      stopAtEach: true,
      maxDist: 40,
      pattern: 'orbit',
      patternName: 'Orbit objek',
      gimbalPitch: g.rings[0].pitchDeg,
      grid: g,
      orbit: g,
      orbitHeadingMode: 'smoothTransition',
      sorties: [g.waypoints],
      terrain: { on: false },
      reliefHint: null,
      advanced: {
        rcLostAction: 'goBack',
        finishAction: 'goHome',
        gimbalPitch: -45,
        safeHeightM: 20,
        rcLostActionLabel: 'RTH',
        finishActionLabel: 'RTH',
      },
      ...over,
    };
  };

  const codes = (plan) => evaluateSafety(plan, p5).findings.map((f) => f.code);

  ok(
    codes(orbitPlan()).includes('orbit-heading-unproven'),
    'arah hadap per titik ditandai belum terbukti'
  );
  ok(
    codes(orbitPlan()).includes('orbit-base-gap'),
    'kaki objek yang tidak terjangkau drone disebut'
  );
  ok(
    !evaluateSafety(orbitPlan(), p5).blockers.length,
    'setelan bawaan orbit tidak menahan export'
  );
  ok(
    codes(orbitPlan()).includes('orbit-ring-raised'),
    'cincin yang dinaikkan ke lantai dijelaskan'
  );
  ok(
    codes(orbitPlan({}, { radiusM: 8 })).includes('orbit-too-close'),
    'radius 8 m ditahan sebagai terlalu dekat'
  );
  ok(
    evaluateSafety(orbitPlan({}, { radiusM: 8 }), p5).blockers.some((b) => b.code === 'orbit-too-close'),
    'dan itu menahan export, bukan cuma peringatan'
  );
  ok(
    codes(orbitPlan({}, { radiusM: 40, maxAngleStepDeg: 25 })).includes('orbit-angle-step'),
    'loncatan sudut 25° diperingatkan'
  );
  ok(
    !codes(orbitPlan()).includes('pattern-cost') && !codes(orbitPlan()).includes('buffer-off'),
    'pesan khusus grid tidak ikut muncul di orbit'
  );
  ok(
    codes(orbitPlan({ terrainRequested: true })).includes('orbit-terrain-na'),
    'ikut kontur yang dinyalakan tapi tidak dipakai, dibilang'
  );
}


// ------------------------------------- gerbang: pola miring & 3D bangunan

console.log('\nGerbang keselamatan: pola miring & 3D bangunan');
{
  const p5 = resolveProfile(registry, { droneId: 'mini5pro' });

  const planFor = (pattern, pitch) => {
    const grid = generatePattern(square, { ...gridOpts, pattern });
    const par = computeSurveyParams(p5.camera, {
      altitudeM: 80,
      gimbalPitchDeg: pitch,
      frontOverlap: 0.8,
      sideOverlap: 0.7,
    });
    return {
      ...fakePlan(),
      pattern,
      patternName: PATTERNS[pattern].name,
      gimbalPitch: PATTERNS[pattern].gimbalPitch,
      grid,
      params: par,
      altitude: 80,
      sorties: splitByBattery(grid.waypoints, {
        speed: 8,
        usableFlightMin: 22,
        accel: 2.5,
        maxWaypoints: p5.limits.maxWaypoints,
      }),
      advanced: { ...fakePlan().advanced, gimbalPitch: pitch },
    };
  };

  const codes = (plan) => evaluateSafety(plan, p5).findings.map((f) => f.code);
  const textOf = (plan, code) =>
    evaluateSafety(plan, p5).findings.find((f) => f.code === code)?.text ?? '';

  const datar = planFor('single', -90);
  const miring = planFor('crossOblique', -45);
  const b3d = planFor('building3d', -45);

  ok(!codes(datar).includes('oblique-gsd'), 'peta datar tidak kena pesan kamera miring');
  ok(codes(miring).includes('oblique-gsd'), 'pola miring: ketelitian permukaan dijelaskan');
  ok(
    codes(miring).includes('oblique-needs-nadir'),
    'pola miring diberi tahu dia fasad saja'
  );
  ok(
    evaluateSafety(miring, p5).findings.find((f) => f.code === 'oblique-needs-nadir').level === 'warn',
    'dan itu peringatan, bukan sekadar catatan — tanpa nadir modelnya cacat'
  );
  ok(
    textOf(miring, 'oblique-needs-nadir').includes('Peta datar'),
    'pasangannya disebut namanya: Peta datar di lahan yang sama'
  );
  ok(
    textOf(miring, 'oblique-needs-nadir').includes('satu project'),
    'dan dikatakan kedua set foto diolah bersama, bukan terpisah'
  );
  ok(
    !codes(b3d).includes('oblique-needs-nadir'),
    'pola nadir+miring sekaligus tidak kena pesan itu, karena nadirnya ada'
  );

  // Ongkos yang membuat pemisahan itu perlu: tiga lintasan = tiga kali foto.
  ok(
    b3d.grid.photos === miring.grid.photos * 1.5,
    'nadir+miring sekaligus 1.5x foto dibanding miring saja',
    `${miring.grid.photos} -> ${b3d.grid.photos}`
  );
  ok(codes(b3d).includes('building3d-shape'), '3D bangunan menjelaskan tiga lintasannya');
  ok(
    textOf(b3d, 'building3d-shape').includes('nadir'),
    'dan menyebut berapa foto nadirnya'
  );
  ok(
    textOf(b3d, 'pattern-cost').includes('3 kali'),
    'biaya pola menyebut 3 lintasan, bukan "dua kali"',
    textOf(b3d, 'pattern-cost').slice(0, 60)
  );
  ok(
    textOf(miring, 'pattern-cost').includes('2 kali'),
    'dan pola miring tetap menyebut 2'
  );

  // Gimbal mendatar: peringatan harus muncul untuk pola seragam...
  const datarGimbal = planFor('crossOblique', -20);
  ok(codes(datarGimbal).includes('gimbal-flat'), 'gimbal -20° pada pola seragam diperingatkan');
  ok(codes(datarGimbal).includes('oblique-spread'), 'dan sebaran ketelitiannya disebut');
  // ...tapi TIDAK untuk pola yang memegang sudutnya sendiri per lintasan.
  ok(
    !codes(b3d).includes('gimbal-flat'),
    '3D bangunan tidak diperingatkan soal slider gimbal yang tidak berlaku untuknya'
  );

  ok(
    textOf(miring, 'photo-mode-manual').includes(miring.params.surfaceGsd.toFixed(2)),
    'perkiraan ruang kartu menyebut GSD permukaan, bukan GSD nadir'
  );
}


// --------------------------------------------- gerbang: kabel dan tiang

console.log('\nGerbang keselamatan: kabel dan tiang listrik');
{
  const p5 = resolveProfile(registry, { droneId: 'mini5pro' });
  const at = (over) => evaluateSafety({ ...fakePlan(), ...over }, p5).findings.map((f) => f.code);

  // Pengganti deteksi kabel yang sengaja tidak dibuat. Kalau dia hilang justru
  // waktu rencananya terlihat aman, fitur ini kehilangan seluruh gunanya.
  ok(at({ altitude: 80 }).includes('kabel-lihat-sendiri'), 'perintah melihat sendiri muncul meski terbang tinggi');
  ok(at({ altitude: 10 }).includes('kabel-lihat-sendiri'), 'dan tetap muncul waktu terbang rendah');

  ok(
    at({ altitude: 12 }).includes('kabel-setinggi-tiang'),
    'terbang 12 m diperingatkan: itu ketinggian tiang'
  );
  ok(
    at({ altitude: 14 }).includes('kabel-dekat-tiang'),
    'terbang 14 m diperingatkan: marginnya terlalu tipis'
  );
  ok(
    !at({ altitude: 20 }).includes('kabel-setinggi-tiang') &&
      !at({ altitude: 20 }).includes('kabel-dekat-tiang'),
    'di 20 m tidak ada peringatan tiang lagi'
  );
  ok(
    JARINGAN_LISTRIK.distribusiMaksM > JARINGAN_LISTRIK.tiangTertinggiM,
    'batas praktis ada di atas tiang tertinggi, bukan sama dengan'
  );

  // Yang dinilai harus titik TERENDAH yang diperintahkan, bukan angka slider.
  // Ikut kontur menurunkan drone relatif terhadap tanah di bagian lahan yang
  // lebih tinggi, dan di orbit tiap cincin punya ketinggiannya sendiri.
  ok(
    at({
      altitude: 60,
      terrain: { on: true, ready: true, minHeight: 11, maxHeight: 60 },
    }).includes('kabel-setinggi-tiang'),
    'ikut kontur: yang dinilai titik terendah, bukan ketinggian rencana'
  );

  const orb = generateOrbit(p5.camera, [0, 0], { radiusM: 18, objectHeightM: 20 });
  ok(
    at({ altitude: 36, orbit: orb, grid: orb, pattern: 'orbit' }).includes('kabel-setinggi-tiang'),
    'orbit: yang dinilai cincin terendah, bukan cincin tertinggi',
    `cincin bawah ${orb.rings[0].heightM.toFixed(1)} m`
  );

  // SUTT/SUTET bukan soal ketinggian lewat, dan itu harus terbaca jelas.
  const teks = evaluateSafety(fakePlan(), p5).findings.find((f) => f.code === 'kabel-lihat-sendiri').text;
  ok(teks.includes('SUTET'), 'menara transmisi disebut sebagai kasus yang berbeda');
  ok(teks.includes('mendatar'), 'dan solusinya jarak mendatar, bukan terbang di atasnya');
}


// ------------------------- kecepatan yang benar-benar tercapai

console.log('\nKecepatan: jelajah vs yang tercapai');
{
  // Drone mempercepat sampai setengah jalan lalu mengerem, jadi puncaknya
  // akar(a x d) — bukan kecepatan jelajah yang diperintahkan.
  ok(near(peakSpeedOverLeg(15, 15, 2.5), Math.sqrt(2.5 * 15), 1e-9), 'puncak di ruas 15 m = akar(a x d)', `${peakSpeedOverLeg(15, 15, 2.5).toFixed(1)} m/s`);
  ok(
    peakSpeedOverLeg(15, 15, 2.5) < 7,
    'jadi memerintahkan 15 m/s di ruas 15 m tidak mengubah apa-apa',
    `cuma ${peakSpeedOverLeg(15, 15, 2.5).toFixed(1)} m/s yang tercapai`
  );
  ok(near(peakSpeedOverLeg(90, 15, 2.5), 15, 1e-9), 'baru di ruas 90 m kecepatan jelajah tercapai');
  ok(peakSpeedOverLeg(200, 15, 2.5) === 15, 'dan tidak pernah melebihi kecepatan jelajah');
  ok(peakSpeedOverLeg(0, 15, 2.5) === 0, 'ruas nol tidak menghasilkan kecepatan');

  // Median, bukan rata-rata: ruas panjang di ujung jalur tidak boleh menarik
  // angka yang mestinya mewakili ruas yang dialami drone sebagian besar waktu.
  const wps = [
    { xy: [0, 0] },
    { xy: [10, 0] },
    { xy: [20, 0] },
    { xy: [30, 0] },
    { xy: [230, 0] },
  ];
  ok(near(medianLegM(wps), 10, 1e-9), 'ruas median tidak tertarik oleh satu ruas 200 m', `${medianLegM(wps).toFixed(0)} m`);
  ok(medianLegM([{ xy: [0, 0] }]) === 0, 'satu titik tidak punya ruas');

  // Gerbangnya.
  const p5 = resolveProfile(registry, { droneId: 'mini5pro' });
  const codes = (over) =>
    evaluateSafety({ ...fakePlan(), ...over }, p5).findings.map((f) => f.code);

  const stop = { stopAtEach: true, speed: 15, legMedianM: 15, peakSpeedMs: 6.1, accel: 2.5 };
  ok(codes(stop).includes('speed-unreached'), 'kecepatan jelajah yang tidak tercapai dijelaskan');
  ok(
    !codes(stop).includes('speed-blur') && !codes(stop).includes('speed-interval'),
    'dan batas blur / jeda jepret tidak ikut muncul di mode berhenti sejenak'
  );
  ok(
    !codes({ ...stop, legMedianM: 120, peakSpeedMs: 15 }).includes('speed-unreached'),
    'di ruas panjang, tidak ada yang perlu dijelaskan'
  );
  ok(
    !codes({ stopAtEach: false, speed: 8, legMedianM: 15, peakSpeedMs: 6.1 }).includes('speed-unreached'),
    'mode tanpa jeda tidak kena pesan ini: di sana drone memang melaju terus'
  );

  const teks = evaluateSafety({ ...fakePlan(), ...stop }, p5).findings.find(
    (f) => f.code === 'speed-unreached'
  ).text;
  ok(teks.includes('90 m'), 'disebut butuh ruas berapa meter supaya tercapai', '15^2/2.5 = 90 m');
}


// ----------------------------- gerbang: ketinggian pulang otomatis

console.log('\nGerbang keselamatan: ketinggian pulang otomatis');
{
  const p5 = resolveProfile(registry, { droneId: 'mini5pro' });
  const planRth = (rthHeightM, over = {}) => ({
    ...fakePlan(),
    altitude: 80,
    ...over,
    advanced: { ...fakePlan().advanced, safeHeightM: 20, rthHeightM, ...(over.advanced ?? {}) },
  });
  const codes = (plan, opts) => evaluateSafety(plan, p5, opts).findings.map((f) => f.code);
  const blockers = (plan, opts) => evaluateSafety(plan, p5, opts).blockers.map((f) => f.code);

  ok(codes(planRth(100)).includes('rth-height'), 'ketinggian pulang selalu disebutkan');

  // Yang paling penting: jalur pulang itu garis lurus tanpa menghindar.
  const gedung = { obstacles: [{ heightM: 45, clearanceM: 35, distM: 10, estimated: false, name: null }] };
  ok(
    blockers(planRth(30), gedung).includes('rth-below-obstacle'),
    'pulang 30 m dengan bangunan 45 m di jalur MENAHAN export'
  );
  ok(
    !codes(planRth(100), gedung).includes('rth-below-obstacle'),
    'pulang 100 m di atas bangunan yang sama tidak ditahan'
  );
  ok(
    evaluateSafety(planRth(30), p5, gedung)
      .findings.find((f) => f.code === 'rth-below-obstacle')
      .text.includes('70 m'),
    'dan disarankan angka yang sudah dibulatkan ke atas',
    '45 + 25 -> 70 m'
  );

  ok(
    codes(planRth(40)).includes('rth-below-mission'),
    'pulang 40 m di bawah ketinggian terbang 80 m diperingatkan'
  );
  ok(
    !codes(planRth(100)).includes('rth-below-mission'),
    'pulang di atas ketinggian terbang tidak diperingatkan'
  );
  ok(
    codes(planRth(15)).includes('rth-below-transit'),
    'pulang lebih rendah dari ketinggian transit diperingatkan sebagai tidak konsisten'
  );

  // Bawaan yang sekarang dipakai web harus lolos bersih.
  ok(
    !blockers(planRth(100)).includes('rth-below-obstacle') &&
      !codes(planRth(100)).includes('rth-below-mission') &&
      !codes(planRth(100)).includes('rth-below-transit'),
    'bawaan 100 m tidak memicu satu pun peringatan RTH'
  );

  // Rencana lama tanpa rthHeightM sama sekali tidak boleh bikin gerbang meledak.
  const lama = { ...fakePlan(), advanced: { ...fakePlan().advanced } };
  delete lama.advanced.rthHeightM;
  ok(
    !codes(lama).includes('rth-height'),
    'rencana tanpa setelan RTH dilewati, bukan error'
  );
}


// ------------------------------------------- lanjutkan misi: titik mulai

console.log('\nLanjutkan misi: dari waypoint mana jalur dipotong');
{
  // Fungsi ini dulu hidup di web/app.js, di luar jangkauan npm test — dan di
  // situlah cabang paritasnya selamat jauh setelah asumsinya tidak berlaku.
  const wps = Array.from({ length: 10 }, (_, i) => ({ xy: [i * 10, 0], pass: i < 5 ? 0 : 1 }));

  ok(resumeIndexFor(wps, 0) === 0, 'titik pertama tidak bisa mundur lagi');
  ok(resumeIndexFor(wps, -3) === 0, 'nomor negatif tidak menghasilkan indeks negatif');
  ok(resumeIndexFor(wps, 1) === 0, 'dari titik kedua, mundur ke titik pertama');
  ok(resumeIndexFor(wps, 7) === 6, 'selalu mundur tepat satu foto', '7 -> 6');

  // Inti perbaikannya: hasilnya tidak lagi bergantung ganjil-genap nomor urut,
  // dan tidak lagi berbeda antar mode — karena kedua mode memang sudah menaruh
  // satu waypoint per foto.
  const selisih = [];
  for (let i = 1; i < wps.length; i++) selisih.push(i - resumeIndexFor(wps, i));
  ok(
    new Set(selisih).size === 1 && selisih[0] === 1,
    'mundurnya seragam di semua titik, bukan selang-seling 0 dan 1',
    `selisih: ${[...new Set(selisih)].join(',')}`
  );

  // Dan tidak peduli lagi pada batas lintasan, yang dulu dipakai menghitung
  // paritas per-pass.
  ok(
    resumeIndexFor(wps, 5) === 4,
    'titik pertama lintasan kedua tetap mundur satu, bukan melompat ke pangkal lintasan'
  );

  // Mundur satu foto harus benar-benar menghasilkan satu foto diulang.
  const nearest = 6;
  const best = resumeIndexFor(wps, nearest);
  ok(wps.slice(best).length - wps.slice(nearest).length === 1, 'tepat satu foto diulang');
}


console.log(failed ? `\n${failed} pemeriksaan GAGAL\n` : '\nSemua pemeriksaan lolos\n');
process.exit(failed ? 1 : 0);
