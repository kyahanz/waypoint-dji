// Data elevasi untuk terrain following.
//
// Modul ini khusus browser — memakai fetch, jadi tidak diimpor oleh CLI.
//
// Sumber: Open-Meteo Elevation API — gratis, tanpa kunci, CORS terbuka,
// 100 titik per permintaan. Datanya Copernicus DEM GLO-90 (resolusi ~90 m).
//
// Resolusi 90 m itu kasar untuk skala lahan: lembah sempit atau tanggul
// setinggi beberapa meter tidak akan terlihat. Cukup untuk mengikuti lereng
// bukit, tidak cukup untuk mengikuti kontur detail. Jangan pakai ini sebagai
// pengganti melihat medan dengan mata sendiri.

const ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
const BATCH = 100;

// Dibulatkan ~11 m supaya geseran slider tidak memicu permintaan baru.
const keyOf = ([lng, lat]) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

const cache = new Map();

export function cachedElevation(coord) {
  return cache.get(keyOf(coord));
}

export function missingCoords(coords) {
  const seen = new Set();
  const out = [];
  for (const c of coords) {
    const k = keyOf(c);
    if (cache.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/**
 * Ambil elevasi untuk titik-titik yang belum ada di cache.
 * @param {Array<[number,number]>} coords [lng, lat]
 * @returns {Promise<number>} jumlah titik baru yang berhasil diambil
 */
export async function fetchElevations(coords, { signal } = {}) {
  const todo = missingCoords(coords);
  if (!todo.length) return 0;

  let got = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const url = new URL(ENDPOINT);
    url.searchParams.set('latitude', chunk.map((c) => c[1].toFixed(5)).join(','));
    url.searchParams.set('longitude', chunk.map((c) => c[0].toFixed(5)).join(','));

    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Data elevasi gagal dimuat (${res.status})`);

    const data = await res.json();
    const list = data?.elevation;
    if (!Array.isArray(list) || list.length !== chunk.length) {
      throw new Error('Balasan data elevasi tidak sesuai');
    }

    chunk.forEach((c, j) => {
      const v = list[j];
      if (typeof v === 'number' && Number.isFinite(v)) {
        cache.set(keyOf(c), v);
        got++;
      }
    });
  }
  return got;
}

/** Ringkasan naik-turun medan: terendah, tertinggi, dan bedanya. */
export function reliefOf(elevations) {
  const vals = elevations.filter((v) => typeof v === 'number');
  if (!vals.length) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return { min, max, relief: max - min };
}
