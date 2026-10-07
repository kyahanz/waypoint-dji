// Pengunduhan tile peta untuk dipakai tanpa sinyal.
//
// Service worker (sw.js) yang menyimpan dan menyajikan tile-nya. Modul ini
// cuma menghitung tile apa saja yang dibutuhkan, lalu mengambilnya sekali —
// permintaan itu lewat service worker, jadi otomatis masuk cache.

export const TILE_CACHE = 'wpdji-tiles-v1';

/** Nomor tile XYZ untuk satu koordinat pada zoom tertentu. */
export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return [
    Math.floor(((lng + 180) / 360) * n),
    Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    ),
  ];
}

/**
 * Daftar URL tile yang menutupi sebuah bbox, dari zMin sampai zMax.
 * @param {{west:number,south:number,east:number,north:number}} bbox
 * @param {string} template URL dengan {z}/{x}/{y}
 */
export function tileUrls(bbox, zMin, zMax, template) {
  const urls = [];
  for (let z = zMin; z <= zMax; z++) {
    const [x0, y0] = lngLatToTile(bbox.west, bbox.north, z);
    const [x1, y1] = lngLatToTile(bbox.east, bbox.south, z);
    const n = 2 ** z;
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        urls.push(
          template.replace('{z}', z).replace('{x}', x).replace('{y}', y)
        );
      }
    }
  }
  return urls;
}

/** Perkiraan jumlah tile tanpa membangun seluruh daftarnya. */
export function countTiles(bbox, zMin, zMax) {
  let total = 0;
  for (let z = zMin; z <= zMax; z++) {
    const [x0, y0] = lngLatToTile(bbox.west, bbox.north, z);
    const [x1, y1] = lngLatToTile(bbox.east, bbox.south, z);
    total += (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1);
  }
  return total;
}

/**
 * Ambil semua tile. Sengaja dibatasi beberapa permintaan sekaligus: penyedia
 * tile gratis melarang pengunduhan massal, dan membanjiri mereka bisa membuat
 * alamat IP diblokir.
 */
export async function downloadTiles(urls, { onProgress, concurrency = 4, signal } = {}) {
  let done = 0;
  let failed = 0;
  let i = 0;

  async function worker() {
    while (i < urls.length) {
      if (signal?.aborted) return;
      const url = urls[i++];
      try {
        const res = await fetch(url, { mode: 'cors', signal });
        if (!res.ok) failed++;
      } catch {
        failed++;
      }
      done++;
      onProgress?.(done, urls.length, failed);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, worker)
  );
  return { done, failed };
}

/** Berapa tile yang sudah tersimpan, dan perkiraan ruang terpakai. */
export async function cacheStatus() {
  if (!('caches' in window)) return null;
  let tiles = 0;
  try {
    const cache = await caches.open(TILE_CACHE);
    tiles = (await cache.keys()).length;
  } catch {
    return null;
  }
  let bytes = null;
  try {
    bytes = (await navigator.storage?.estimate?.())?.usage ?? null;
  } catch {
    // Beberapa browser menolak estimate di konteks tertentu.
  }
  return { tiles, bytes };
}

export async function clearTiles() {
  if (!('caches' in window)) return false;
  return caches.delete(TILE_CACHE);
}

/** Service worker hanya jalan di konteks aman: https atau localhost. */
export function offlineSupported() {
  return 'serviceWorker' in navigator && window.isSecureContext;
}
