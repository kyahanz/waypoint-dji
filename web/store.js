// Penyimpanan project di browser (localStorage).
// Cukup untuk prototipe; di Fase 2 ini pindah ke Supabase + PostGIS supaya
// project bisa dibuka dari perangkat lain.

const KEY = 'waypoint-dji.projects.v1';

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
  const record = { ...project, id, savedAt: Date.now() };
  const i = list.findIndex((p) => p.id === id);
  if (i >= 0) list[i] = record;
  else list.push(record);
  return writeAll(list) ? record : null;
}

export function loadProject(id) {
  return readAll().find((p) => p.id === id) ?? null;
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
