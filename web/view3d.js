// Tampilan 3D: medan timbul dan bangunan.
//
// Dua lapis, dua tujuan yang berbeda:
//
//   Medan (DEM)  — supaya jalur yang mengikuti kontur bisa DILIHAT, bukan
//                  cuma dipercaya. Sumbernya Terrain Tiles di AWS Open Data
//                  (encoding terrarium): gratis, tanpa kunci.
//
//   Bangunan     — kotak-kotak dari OpenStreetMap lewat Overpass. Jelek, dan
//                  memang bukan untuk cantik-cantikan: ini supaya bisa dijawab
//                  "jalur di 50 m itu lewat atas apa?". OSM sering kurang
//                  tinggi dari aslinya dan tidak tahu antena di atap, jadi
//                  hasilnya batas bawah, bukan kebenaran.

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
// Overpass itu layanan sukarela dan sering kelebihan beban — balasan "502
// Gateway" dalam bentuk halaman teks, bukan JSON, adalah kejadian biasa.
// Jadi: beberapa cermin, batas waktu, dan kegagalan yang dijelaskan apa
// adanya ketimbang berputar selamanya.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const REQUEST_TIMEOUT_MS = 25000;

const EMPTY = { type: 'FeatureCollection', features: [] };

export function installTerrainSources(map) {
  if (!map.getSource('dem')) {
    map.addSource('dem', {
      type: 'raster-dem',
      tiles: [DEM_URL],
      tileSize: 256,
      encoding: 'terrarium',
      maxzoom: 14,
      attribution: 'Elevasi: Terrain Tiles (AWS Open Data), Copernicus DEM',
    });
  }

  if (!map.getLayer('hillshade')) {
    map.addLayer(
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem',
        layout: { visibility: 'none' },
        paint: { 'hillshade-exaggeration': 0.45 },
      },
      map.getStyle().layers.find((l) => l.id !== 'base')?.id
    );
  }

  if (!map.getSource('buildings')) {
    map.addSource('buildings', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: 'buildings',
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': [
          'case',
          ['get', 'estimated'],
          '#6b7684',
          '#8e9bb0',
        ],
        'fill-extrusion-height': ['get', 'heightM'],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.85,
      },
    });
  }
}

/**
 * @param {'2d'|'3d'|'3dobj'} mode
 */
export function applyViewMode(map, mode) {
  const on3d = mode !== '2d';

  try {
    map.setTerrain(on3d ? { source: 'dem', exaggeration: 1 } : null);
  } catch {
    // Beberapa browser/driver tidak sanggup terrain. Peta 2D tetap jalan,
    // dan itu lebih baik daripada layar kosong.
    return false;
  }

  if (map.getLayer('hillshade')) {
    map.setLayoutProperty('hillshade', 'visibility', on3d ? 'visible' : 'none');
  }
  if (map.getLayer('buildings-3d')) {
    map.setLayoutProperty('buildings-3d', 'visibility', mode === '3dobj' ? 'visible' : 'none');
  }

  map.easeTo({ pitch: on3d ? 60 : 0, duration: 600 });
  return true;
}

/** Tinggi bangunan dari tag OSM. Null kalau tidak ada dasarnya sama sekali. */
function heightFromTags(tags = {}) {
  const h = parseFloat(tags.height ?? tags['building:height']);
  if (Number.isFinite(h)) return { heightM: h, estimated: false };

  const levels = parseFloat(tags['building:levels']);
  if (Number.isFinite(levels)) return { heightM: levels * 3.2, estimated: true };

  return null;
}

/**
 * Ambil bangunan di dalam bbox dari OpenStreetMap.
 * @returns {Promise<{geojson: object, count: number, unknown: number}>}
 */
export async function fetchBuildings(bbox, { signal } = {}) {
  const { south, west, north, east } = bbox;
  const q = `[out:json][timeout:25];way["building"](${south},${west},${north},${east});out geom;`;

  const problems = [];
  let data = null;

  for (const url of OVERPASS_MIRRORS) {
    const timer = new AbortController();
    const stop = setTimeout(() => timer.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: signal ?? timer.signal,
      });

      // Server yang kewalahan membalas halaman teks dengan status 200, jadi
      // status saja tidak cukup — isinya yang menentukan.
      const text = await res.text();
      if (!res.ok || !text.trimStart().startsWith('{')) {
        problems.push(`${new URL(url).host}: ${res.status} ${text.slice(0, 60).replace(/\s+/g, ' ')}`);
        continue;
      }

      data = JSON.parse(text);
      break;
    } catch (err) {
      problems.push(`${new URL(url).host}: ${err.name === 'AbortError' ? 'tidak membalas' : err.message}`);
    } finally {
      clearTimeout(stop);
    }
  }

  if (!data) {
    throw new Error(`Semua server Overpass sedang tidak bisa dipakai (${problems.join('; ')}).`);
  }

  const features = [];
  let unknown = 0;

  for (const el of data.elements ?? []) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) continue;

    const h = heightFromTags(el.tags);
    if (!h) {
      unknown++;
      continue; // Tanpa dasar tinggi, menggambar kotak setinggi tebakan justru menyesatkan.
    }

    const ring = el.geometry.map((p) => [p.lon, p.lat]);
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
      ring.push(ring[0]);
    }

    features.push({
      type: 'Feature',
      properties: {
        heightM: h.heightM,
        estimated: h.estimated,
        name: el.tags?.name ?? null,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }

  return {
    geojson: { type: 'FeatureCollection', features },
    count: features.length,
    unknown,
  };
}

export function setBuildings(map, geojson) {
  map.getSource('buildings')?.setData(geojson ?? EMPTY);
}

/** Jarak titik ke ruas garis, dalam meter, pakai proyektor lokal. */
function pointToSegment(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  return Math.hypot(wx - vx * t, wy - vy * t);
}

/**
 * Bangunan mana yang berada di bawah atau di dekat jalur, dan berapa jarak
 * vertikalnya dari ketinggian terbang.
 *
 * `clearanceM` negatif artinya jalur lebih rendah dari atap bangunan.
 *
 * @param {object} o.proj proyektor lokal (toXY)
 * @param {Array<[number,number]>} o.pathLL jalur dalam lng/lat
 * @param {number} o.altitudeM ketinggian terbang di atas permukaan
 * @param {number} o.radiusM seberapa jauh dari jalur masih dianggap relevan
 */
export function obstaclesNearPath(geojson, { proj, pathLL, altitudeM, radiusM = 30 }) {
  if (!geojson?.features?.length || pathLL.length < 2) return [];

  const path = pathLL.map(proj.toXY);
  const out = [];

  for (const f of geojson.features) {
    const ring = f.geometry.coordinates[0];
    let best = Infinity;

    for (const ll of ring) {
      const p = proj.toXY(ll);
      for (let i = 1; i < path.length; i++) {
        const d = pointToSegment(p, path[i - 1], path[i]);
        if (d < best) best = d;
        if (best === 0) break;
      }
    }

    if (best <= radiusM) {
      out.push({
        heightM: f.properties.heightM,
        estimated: f.properties.estimated,
        name: f.properties.name,
        distM: best,
        clearanceM: altitudeM - f.properties.heightM,
      });
    }
  }

  return out.sort((a, b) => a.clearanceM - b.clearanceM);
}
