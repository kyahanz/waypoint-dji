#!/usr/bin/env node
// Menyusun folder dist/ yang bisa disajikan hosting statis mana pun.
//
// Saat pengembangan, web/ mengimpor modul lewat ../src/ supaya CLI dan web
// benar-benar memakai berkas yang sama — tidak ada salinan yang bisa melenceng.
// Tapi path itu keluar dari satu root, jadi tidak bisa dihosting apa adanya.
// Build ini memindahkannya ke dalam satu pohon dan menulis ulang impornya.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

const WEB_FILES = [
  'index.html',
  'style.css',
  'app.js',
  'draw.js',
  'store.js',
  'kmz.js',
  'unzip.js',
  'exif.js',
  'mission-editor.js',
  'zip-browser.js',
  'view3d.js',  'sw.js',
  'manifest.webmanifest',
  'icon.svg',
];

const SRC_FILES = [
  'survey.js',
  'geo.js',
  'wpml.js',
  'zip-core.js',
  'terrain.js',
  'profiles.js',
  'wpml-edit.js',
  'safety.js',
];

const PROFILE_FILES = ['drones.json', 'mini5pro.json'];

// CSS MapLibre disalin ke dalam proyek, bukan diambil dari CDN: artifact
// viewer memblokir stylesheet lintas situs, dan satu dependensi eksternal
// lebih sedikit juga berarti offline lebih tahan banting.
const VENDOR_FILES = ['maplibre-gl.css'];

// Huruf aplikasi, dipasang sendiri dengan alasan yang sama: alat ini dipakai
// di lahan. Latin + latin-ext, empat berat, 60 KB seluruhnya.
const FONT_FILES = [
  'poppins-400-latin.woff2',
  'poppins-400-latin-ext.woff2',
  'poppins-500-latin.woff2',
  'poppins-500-latin-ext.woff2',
  'poppins-600-latin.woff2',
  'poppins-600-latin-ext.woff2',
  'poppins-700-latin.woff2',
  'poppins-700-latin-ext.woff2',
];

/** ../src/x -> ./src/x dan ../profiles/x -> ./profiles/x */
// replaceAll belum ada di Node 14, jadi pakai regex global.
const rewrite = (text) =>
  text.replace(/\.\.\/src\//g, './src/').replace(/\.\.\/profiles\//g, './profiles/');

// Simpan tautan proyek Vercel: dist/ dihapus total tiap build, dan tanpa ini
// setiap build memutus tautannya sehingga deploy berikutnya bikin proyek baru.
const VERCEL_LINK = path.join(DIST, '.vercel');
const keptLink = fs.existsSync(VERCEL_LINK)
  ? fs.readFileSync(path.join(VERCEL_LINK, 'project.json'), 'utf8')
  : null;

fs.rmSync(DIST, { recursive: true, force: true });

if (keptLink) {
  fs.mkdirSync(VERCEL_LINK, { recursive: true });
  fs.writeFileSync(path.join(VERCEL_LINK, 'project.json'), keptLink);
}
fs.mkdirSync(path.join(DIST, 'src'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'profiles'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'vendor', 'fonts'), { recursive: true });

let rewritten = 0;
for (const f of WEB_FILES) {
  const from = path.join(ROOT, 'web', f);
  const raw = fs.readFileSync(from, 'utf8');
  const out = rewrite(raw);
  if (out !== raw) rewritten++;
  fs.writeFileSync(path.join(DIST, f), out);
}

for (const f of SRC_FILES) {
  fs.copyFileSync(path.join(ROOT, 'src', f), path.join(DIST, 'src', f));
}

for (const f of VENDOR_FILES) {
  fs.copyFileSync(path.join(ROOT, 'web', 'vendor', f), path.join(DIST, 'vendor', f));
}

for (const f of FONT_FILES) {
  fs.copyFileSync(
    path.join(ROOT, 'web', 'vendor', 'fonts', f),
    path.join(DIST, 'vendor', 'fonts', f)
  );
}

for (const f of PROFILE_FILES) {
  fs.copyFileSync(path.join(ROOT, 'profiles', f), path.join(DIST, 'profiles', f));
}

// Jaring pengaman: kalau masih ada ../ yang tersisa, hosting akan 404 diam-diam.
const leftovers = [];
for (const f of [...WEB_FILES]) {
  const text = fs.readFileSync(path.join(DIST, f), 'utf8');
  for (const m of text.matchAll(/['"`](\.\.\/[^'"`]+)['"`]/g)) leftovers.push(`${f}: ${m[1]}`);
}
if (leftovers.length) {
  console.error('Masih ada path yang keluar dari root:');
  leftovers.forEach((l) => console.error('  ' + l));
  process.exit(1);
}

// Vercel CLI menaruh .env.local berisi token OIDC di folder yang ditautkan.
// Itu kredensial, bukan aset situs — pastikan tidak pernah ikut terunggah.
fs.writeFileSync(
  path.join(DIST, '.vercelignore'),
  ['.env*', '.vercel', ''].join('\n')
);

console.log(
  `dist/ siap — ${
    WEB_FILES.length +
    SRC_FILES.length +
    PROFILE_FILES.length +
    VENDOR_FILES.length +
    FONT_FILES.length
  } berkas, ${rewritten} ditulis ulang`
);
