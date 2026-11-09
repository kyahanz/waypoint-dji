#!/usr/bin/env node
// Server statis untuk pengembangan.
//
// Dibuat sendiri, bukan `python -m http.server`, karena satu alasan praktis:
// server bawaan Python tidak mengirim header cache sama sekali, sehingga
// browser menyimpan modul ES lama dan perubahan kode tidak kelihatan sampai
// hard reload manual. Di sini semuanya dikirim dengan no-store, jadi apa yang
// ada di disk itu yang dieksekusi.
//
// Ini TIDAK untuk produksi: tidak ada kompresi, tidak ada caching, dan
// semua berkas di bawah root ikut tersaji.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] ?? 5180);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.kmz': 'application/vnd.google-earth.kmz',
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);

    // Jaga supaya '..' di URL tidak bisa keluar dari root.
    const target = path.join(ROOT, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let file = target;
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + url);
      return;
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + url);
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store, must-revalidate',
      });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`waypoint-dji dev server: http://localhost:${PORT}/web/`);
  });
