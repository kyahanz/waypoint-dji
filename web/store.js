// Penyimpanan project di browser (localStorage).
// Cukup untuk prototipe; di Fase 2 ini pindah ke Supabase + PostGIS supaya
// project bisa dibuka dari perangkat lain.

const KEY = 'waypoint-dji.projects.v1';

// Versi skema project yang ditulis aplikasi sekarang.
//
//   1 — prototipe awal: satu drone (Mini 5 Pro), parameter berbasis GSD.
//   2 — pilihan drone/lensa/mode foto, ketinggian jadi input utama,
//       pola terbang, setelan lanjutan.
//
// Project lama tidak boleh jadi tidak terbaca cuma karena aplikasinya maju.
// Tiap project dinaikkan versinya saat dibuka, bukan saat disimpan, supaya
// file yang belum pernah disentuh tetap utuh.
export const SCHEMA_VERSION = 2;

/**
 * Naikkan satu project ke skema terbaru.
 *
 * v1 menyimpan `gsd` dan tidak menyimpan ketinggian sama sekali — ketinggian
 * dulu selalu diturunkan dari GSD memakai kamera Mini 5 Pro. Jadi di sini
 * GSD-nya dipertahankan apa adanya dan drone-nya dikunci ke Mini 5 Pro;
 * aplikasi yang akan menghitung ulang ketinggiannya. Menebak ketinggian di
 * sini justru akan mengubah arti rencana yang sudah tersimpan.
 */
export function migrateProject(p) {
  if (!p || p.schemaVersion === SCHEMA_VERSION) return p;

  const out = { ...p };

  if (!out.schemaVersion || out.schemaVersion < 2) {
    out.droneId = out.droneId ?? 'mini5pro';
    out.lensId = out.lensId ?? 'wide';
    out.modeId = out.modeId ?? '12mp';
    out.pattern = out.pattern ?? 'single';
    out.speedAuto = out.speedAuto ?? true;
    out.gsdTarget = out.gsdTarget ?? out.gsd ?? null;

    // Arah jalur v1 adalah angka eksplisit 0–179, di mana 0 berarti
    // timur-barat. Di v2 nilai 0 berarti "otomatis", jadi 0 yang lama
    // dipindahkan ke 180 — arah yang sama persis, tapi tidak tertukar makna.
    out.advanced = out.advanced ?? {
      angleDeg: out.angle === 0 ? 180 : (out.angle ?? 0),
    };
    out.migratedFrom = out.schemaVersion ?? 1;
  }

  out.schemaVersion = SCHEMA_VERSION;
  return out;
}

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return []; // localStorage bisa diblokir (mode penyamaran, dll) — jangan sampai UI mati
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function listProjects() {
  return readAll().sort((a, b) => b.savedAt - a.savedAt);
}

export function saveProject(project) {
  const list = readAll();
  const id = project.id || `p_${Date.now().toString(36)}`;
  const record = { ...project, id, schemaVersion: SCHEMA_VERSION, savedAt: Date.now() };
  const i = list.findIndex((p) => p.id === id);
  if (i >= 0) list[i] = record;
  else list.push(record);
  return writeAll(list) ? record : null;
}

export function loadProject(id) {
  const found = readAll().find((p) => p.id === id);
  return found ? migrateProject(found) : null;
}

// ---------- Kode drone hasil impor ----------
//
// Nilai enum yang dibaca dari KMZ asli DJI Fly disimpan per drone dan
// bertahan antar sesi. Ini satu-satunya cara memperbaiki data yang tidak
// dipublikasikan DJI, jadi sekali dikunci jangan sampai hilang.

const ENUM_KEY = 'waypoint-dji.droneEnums.v1';

export function getEnumOverrides() {
  try {
    return JSON.parse(localStorage.getItem(ENUM_KEY)) ?? {};
  } catch {
    return {};
  }
}

export function setEnumOverride(droneId, enums) {
  const all = getEnumOverrides();
  if (enums) all[droneId] = enums;
  else delete all[droneId];
  try {
    localStorage.setItem(ENUM_KEY, JSON.stringify(all));
  } catch {
    // Penyimpanan diblokir — kode tetap berlaku untuk sesi ini saja.
  }
  return all;
}

export function deleteProject(id) {
  return writeAll(readAll().filter((p) => p.id !== id));
}

/** Cari lokasi lewat Nominatim (OpenStreetMap). */
export async function geocode(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '5');
  url.searchParams.set('countrycodes', 'id');

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Pencarian gagal (${res.status})`);
  const data = await res.json();
  return data.map((d) => ({
    name: d.display_name,
    lng: Number(d.lon),
    lat: Number(d.lat),
  }));
}

/** Koordinat langsung, misal "-6.2549, 107.1199" yang disalin dari Google Maps. */
export function parseCoords(text) {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, name: `${lat}, ${lng}` };
}

// ---------- Pengaturan tampilan ----------

const SETTINGS_KEY = 'waypoint-dji.settings.v1';

export function getSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    return {};
  }
}

export function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Penyimpanan diblokir — pengaturan tetap berlaku untuk sesi ini saja.
  }
  return next;
}
