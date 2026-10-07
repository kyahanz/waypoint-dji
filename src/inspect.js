#!/usr/bin/env node
// Bongkar file .kmz (punya DJI Fly maupun punya kita) dan tampilkan isinya.
// Ini tool paling penting di Fase 0: dipakai buat ambil "ground truth" format
// asli dari DJI Fly, lalu dibandingkan dengan hasil generator kita.
//
// Contoh:
//   npm run inspect -- "C:/Users/me/Downloads/mission-dari-hp.kmz"
//   npm run inspect -- file.kmz --dump out/asli
import fs from 'node:fs';
import path from 'node:path';
import { readZip } from './zip.js';

function parseArgs(argv) {
  const files = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
    } else {
      files.push(a);
    }
  }
  return { files, opts };
}

/** Tarik semua tag wpml:* beserta nilainya (hanya leaf node). */
function extractFields(xml) {
  const found = new Map();
  const re = /<wpml:([A-Za-z0-9_]+)>([^<]*)<\/wpml:\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const [, tag, value] = m;
    if (!found.has(tag)) found.set(tag, []);
    found.get(tag).push(value);
  }
  return found;
}

function summarize(label, xml) {
  console.log(`\n=== ${label} (${xml.length} byte) ===`);

  const ns = xml.match(/xmlns:wpml="([^"]+)"/);
  if (ns) console.log(`  namespace WPML : ${ns[1]}`);

  const placemarks = (xml.match(/<Placemark>/g) || []).length;
  console.log(`  jumlah Placemark: ${placemarks}`);

  const coords = [...xml.matchAll(/<coordinates>([^<]+)<\/coordinates>/g)].map((m) =>
    m[1].trim()
  );
  if (coords.length) {
    console.log(`  koordinat       : ${coords.length} titik`);
    coords.slice(0, 5).forEach((c, i) => console.log(`     [${i}] ${c}`));
    if (coords.length > 5) console.log(`     ... (+${coords.length - 5} lagi)`);
  }

  const fields = extractFields(xml);
  console.log(`  tag wpml unik   : ${fields.size}`);
  const width = Math.max(...[...fields.keys()].map((k) => k.length));
  for (const [tag, values] of fields) {
    const uniq = [...new Set(values)];
    const shown = uniq.slice(0, 3).join(' | ');
    const more = uniq.length > 3 ? ` ... (+${uniq.length - 3} nilai lain)` : '';
    const count = values.length > 1 ? ` x${values.length}` : '';
    console.log(`     ${tag.padEnd(width)} = ${shown}${more}${count}`);
  }
}

function main() {
  const { files, opts } = parseArgs(process.argv.slice(2));

  if (!files.length) {
    console.log(`
Pemakaian:
  npm run inspect -- <file.kmz> [--dump <folder>]

  --dump <folder>   Simpan isi kmz ke folder, biar bisa di-diff manual
`);
    process.exit(1);
  }

  for (const f of files) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) {
      console.error(`File tidak ketemu: ${abs}`);
      process.exitCode = 1;
      continue;
    }

    console.log(`\n########## ${abs} ##########`);
    let entries;
    try {
      entries = readZip(fs.readFileSync(abs));
    } catch (err) {
      console.error(`  Gagal membongkar: ${err.message}`);
      process.exitCode = 1;
      continue;
    }

    console.log(`\nIsi arsip:`);
    for (const name of Object.keys(entries)) {
      console.log(`  - ${name} (${entries[name].length} byte)`);
    }

    for (const [name, buf] of Object.entries(entries)) {
      if (/\.(kml|wpml|xml|json)$/i.test(name)) summarize(name, buf.toString('utf8'));
    }

    if (opts.dump) {
      const dir = path.resolve(String(opts.dump));
      for (const [name, buf] of Object.entries(entries)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
      }
      console.log(`\nIsi arsip disimpan ke: ${dir}`);
    }
  }
}

main();
