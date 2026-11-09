// Service worker: membuat aplikasi dan tile peta tetap bisa dipakai tanpa
// sinyal. Dipasang dari app.js, hanya jalan di konteks aman (https/localhost).

const SHELL = 'wpdji-shell-v30';
const TILES = 'wpdji-tiles-v1';
const DATA = 'wpdji-data-v1';

// Berkas aplikasi. CDN ikut di-cache supaya MapLibre tetap ada saat offline.
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './draw.js',
  './store.js',
  './kmz.js',
  './unzip.js',
  './exif.js',
  './mission-editor.js',
  './zip-browser.js',
  './view3d.js',
  '../src/survey.js',
  '../src/geo.js',
  '../src/wpml.js',
  '../src/zip-core.js',
  '../src/terrain.js',
  '../src/profiles.js',
  '../src/wpml-edit.js',
  '../src/safety.js',
  '../profiles/drones.json',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  // Huruf aplikasi dipasang sendiri, jadi dia juga harus ikut offline —
  // percuma menyimpan seluruh aplikasi kalau hurufnya yang hilang di lahan.
  './vendor/fonts/poppins-400-latin.woff2',
  './vendor/fonts/poppins-400-latin-ext.woff2',
  './vendor/fonts/poppins-500-latin.woff2',
  './vendor/fonts/poppins-500-latin-ext.woff2',
  './vendor/fonts/poppins-600-latin.woff2',
  './vendor/fonts/poppins-600-latin-ext.woff2',
  './vendor/fonts/poppins-700-latin.woff2',
  './vendor/fonts/poppins-700-latin-ext.woff2',
];

const TILE_HOSTS = [
  'server.arcgisonline.com',
  'tile.openstreetmap.org',
  'api.mapbox.com',
  'api.maptiler.com',
  // Tile elevasi untuk medan 3D: ikut di-cache supaya tampilan 3D tetap ada
  // di lapangan, bukan cuma di kantor.
  's3.amazonaws.com',
];

const DATA_HOSTS = ['api.open-meteo.com', 'overpass-api.de'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // addAll gagal total kalau satu berkas gagal; simpan satu per satu
      // supaya CDN yang sedang bermasalah tidak membatalkan pemasangan.
      await Promise.all(
        SHELL_FILES.map((f) => cache.add(f).catch(() => null))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keep = new Set([SHELL, TILES, DATA]);
      for (const k of await caches.keys()) {
        if (!keep.has(k)) await caches.delete(k);
      }
      await self.clients.claim();
    })()
  );
});

/**
 * Batas jumlah entri per cache, dibuang yang paling lama masuk.
 *
 * Perlu sejak pengunduh tile dihapus: dulu ada tombol "Hapus cache" di panel,
 * dan itu satu-satunya cara mengosongkan cache yang tidak punya batas sama
 * sekali. Menghapus tombolnya tanpa memberi batas berarti cache tumbuh terus
 * tanpa ada yang bisa menghentikannya.
 *
 * Cache API mengembalikan kunci dalam urutan masuk, jadi memotong dari depan
 * membuang yang paling lama.
 */
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  const lebih = keys.length - maxEntries;
  for (let i = 0; i < lebih; i++) await cache.delete(keys[i]);
}

// Tile ~15-25 KB: 1500 entri sekitar 30 MB, cukup untuk beberapa lahan.
// Respons elevasi jauh lebih kecil, tapi tetap diberi batas.
const CACHE_LIMIT = { [TILES]: 1500, [DATA]: 500 };

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // Respons opaque (no-cors) tidak bisa diperiksa statusnya; simpan saja,
    // karena menolaknya berarti tile tidak pernah tersimpan sama sekali.
    if (res.ok || res.type === 'opaque') {
      await cache.put(req, res.clone());
      const batas = CACHE_LIMIT[cacheName];
      if (batas) await trimCache(cache, batas);
    }
    return res;
  } catch (err) {
    const stale = await cache.match(req, { ignoreSearch: false });
    if (stale) return stale;
    throw err;
  }
}

async function networkFirstWithFallback(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheFirst(req, TILES));
    return;
  }

  // Elevasi tidak pernah berubah untuk koordinat yang sama, jadi aman
  // disajikan dari cache — dan itu yang membuat terrain following tetap
  // berfungsi di lapangan tanpa sinyal.
  if (DATA_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheFirst(req, DATA));
    return;
  }

  // Berkas aplikasi: utamakan jaringan supaya perubahan kode langsung terlihat
  // saat mengembangkan, tapi tetap ada salinan untuk dipakai offline.
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirstWithFallback(req, SHELL));
  }
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
