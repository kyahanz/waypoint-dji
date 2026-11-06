#!/usr/bin/env node
// Bandingkan dua file .kmz tag per tag DAN nilai per nilai.
//
// `npm run inspect` cuma menampilkan isi satu file. Yang dibutuhkan saat
// mengejar "kenapa DJI Fly menolak file kita" adalah selisihnya terhadap file
// yang pasti diterima — termasuk selisih NILAI, bukan cuma tag. Tag yang sama
// dengan nilai yang tidak pernah muncul di file asli adalah tersangka yang
// sama kuatnya dengan tag yang hilang.
//
//   node tools/compare.js <asli-dji-fly.kmz> <bikinan-kita.kmz>
import fs from 'node:fs';
import path from 'node:path';
import { readZip } from '../src/zip.js';

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error('Pakai: node tools/compare.js <asli.kmz> <kita.kmz>');
  process.exit(1);
}

/** Nilai tiap tag wpml, dikelompokkan per berkas di dalam arsip. */
function readTags(file) {
  const zip = readZip(fs.readFileSync(file));
  const out = {};

  for (const [name, buf] of Object.entries(zip)) {
    if (!/\.(kml|wpml)$/.test(name)) continue;
    const xml = buf.toString('utf8');
    const short = path.basename(name);
    const map = new Map();

    for (const m of xml.matchAll(/<wpml:([A-Za-z0-9_]+)>([^<]*)<\/wpml:\1>/g)) {
      const [, tag, value] = m;
      if (!map.has(tag)) map.set(tag, new Set());
      map.get(tag).add(value.trim());
    }

    out[short] = {
      tags: map,
      namespace: (xml.match(/xmlns:wpml="([^"]+)"/) ?? [])[1] ?? null,
      placemarks: (xml.match(/<Placemark>/g) ?? []).length,
    };
  }
  return out;
}

// Tag yang nilainya memang harus beda tiap misi — membandingkannya cuma
// menghasilkan bising, bukan temuan.
const BEBAS = new Set([
  'author',
  'createTime',
  'updateTime',
  'index',
  'actionId',
  'actionGroupId',
  'actionGroupStartIndex',
  'actionGroupEndIndex',
  'executeHeight',
  'waypointSpeed',
  'autoFlightSpeed',
  'globalTransitionalSpeed',
  'waypointHeadingAngle',
  'distance',
  'duration',
  'hoverTime',
  'actionTriggerParam',
  'fileSuffix',
  'gimbalPitchRotateAngle',
  'waypointGimbalPitchAngle',
  'droneEnumValue',
  'droneSubEnumValue',
]);

const A = readTags(aPath);
const B = readTags(bPath);

console.log(`\nA (acuan) : ${aPath}`);
console.log(`B (uji)   : ${bPath}\n`);

let masalah = 0;
const files = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();

for (const f of files) {
  const a = A[f];
  const b = B[f];
  console.log(`=== ${f} ===`);

  if (!a || !b) {
    console.log(`  !! hanya ada di ${a ? 'A' : 'B'}`);
    masalah++;
    continue;
  }

  if (a.namespace !== b.namespace) {
    console.log(`  !! namespace beda: A=${a.namespace}  B=${b.namespace}`);
    masalah++;
  }

  if ((a.placemarks === 0) !== (b.placemarks === 0)) {
    console.log(`  !! jumlah Placemark: A=${a.placemarks}  B=${b.placemarks}`);
    masalah++;
  }

  const hilang = [...a.tags.keys()].filter((t) => !b.tags.has(t));
  const tambahan = [...b.tags.keys()].filter((t) => !a.tags.has(t));

  if (hilang.length) {
    console.log(`  !! ada di A, tidak di B : ${hilang.join(', ')}`);
    masalah += hilang.length;
  }
  if (tambahan.length) {
    console.log(`  !! ada di B, tidak di A : ${tambahan.join(', ')}`);
    masalah += tambahan.length;
  }

  for (const [tag, bVals] of b.tags) {
    if (BEBAS.has(tag) || !a.tags.has(tag)) continue;
    const aVals = a.tags.get(tag);
    const asing = [...bVals].filter((v) => !aVals.has(v));
    if (asing.length) {
      console.log(
        `  ?  ${tag}: B memakai ${asing.map((v) => `"${v}"`).join(', ')} — A cuma ${[...aVals].map((v) => `"${v}"`).join(', ')}`
      );
      masalah++;
    }
  }

  if (!hilang.length && !tambahan.length) console.log('  tag: cocok');
}

console.log(
  masalah
    ? `\n${masalah} selisih. Yang bertanda !! kemungkinan bikin file ditolak; yang ? perlu dipastikan.\n`
    : '\nTidak ada selisih.\n'
);
process.exit(masalah ? 1 : 0);
