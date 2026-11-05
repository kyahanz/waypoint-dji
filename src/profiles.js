// Registry drone: memilih drone, lensa, dan mode foto, lalu menyusunnya jadi
// bentuk "profil" yang dipakai generator WPML dan engine survei.
//
// Pemisahan yang penting di sini:
//   - spek kamera  -> menentukan hitungan (GSD, footprint, kecepatan)
//   - enum DJI     -> menentukan apakah file diterima drone
// Keduanya punya tingkat kepercayaan yang berbeda, jadi jangan pernah
// digabung jadi satu "profil terverifikasi".

/**
 * Ukuran sensor fisik tidak perlu ditebak. Yang dibutuhkan hitungan GSD dan
 * footprint cuma perbandingan lebar sensor terhadap panjang fokal, dan
 * perbandingan itu sudah terkandung penuh dalam ekuivalen 35 mm:
 *
 *   lebarSensor / fokal = 36 / eq35
 *
 * Jadi kita pasang fokal sembarang (10 mm) lalu turunkan lebar sensornya.
 * Hasil GSD dan footprint-nya identik dengan memakai angka asli pabrik —
 * tanpa satu pun angka tebakan.
 */
export function cameraOf(lens, mode) {
  const focalLengthMm = lens.focalLengthMm ?? 10;
  const sensorWidthMm = lens.sensorWidthMm ?? (focalLengthMm * 36) / lens.eq35mm;
  const sensorHeightMm =
    lens.sensorHeightMm ?? sensorWidthMm * (mode.imageHeightPx / mode.imageWidthPx);

  return {
    sensorWidthMm,
    sensorHeightMm,
    focalLengthMm,
    focalLength35mmEq: lens.eq35mm,
    imageWidthPx: mode.imageWidthPx,
    imageHeightPx: mode.imageHeightPx,
    mechanicalShutter: !!lens.mechanicalShutter,
    minIntervalSec: mode.minIntervalSec ?? 2,
  };
}

export function findDrone(registry, id) {
  return registry.drones.find((d) => d.id === id) ?? registry.drones[0];
}

export function findLens(drone, lensId) {
  return drone.lenses.find((l) => l.id === lensId) ?? drone.lenses[0];
}

export function findMode(lens, modeId) {
  return lens.modes.find((m) => m.id === modeId) ?? lens.modes[0];
}

/**
 * Susun profil siap pakai. Bentuknya sengaja dibuat sama dengan profil lama
 * (camera + limits + enum di akar) supaya generator WPML tidak perlu tahu
 * soal registry sama sekali.
 *
 * @param {object} o.enumOverride enum hasil impor KMZ asli, kalau ada
 */
export function resolveProfile(registry, { droneId, lensId, modeId, enumOverride } = {}) {
  const drone = findDrone(registry, droneId);
  const lens = findLens(drone, lensId);
  const mode = findMode(lens, modeId);
  const enums = enumOverride ?? drone.enums;

  return {
    id: drone.id,
    name: drone.name,
    series: drone.series,
    waypoint: drone.waypoint ?? { supported: true },
    lens,
    mode,
    lenses: drone.lenses,
    camera: cameraOf(lens, mode),
    limits: drone.limits,

    // Enum belum terverifikasi tetap dikirim sebagai 0 supaya file tetap
    // terbentuk dan bisa diuji — tapi `enumVerified` false adalah bendera
    // yang menahan export di gerbang keselamatan.
    droneEnumValue: enums?.droneEnumValue ?? 0,
    droneSubEnumValue: enums?.droneSubEnumValue ?? 0,
    payloadEnumValue: enums?.payloadEnumValue ?? 0,
    payloadSubEnumValue: enums?.payloadSubEnumValue ?? 0,
    enumVerified: !!enums?.verified,
    enumKnown: !!enums,
    enumNote: enums?.note ?? null,
    enumSource: enumOverride ? 'impor' : enums ? 'bawaan' : null,
  };
}

/**
 * Preset menyimpan NIAT (ketelitian + overlap), bukan ketinggian mati.
 * Ketinggian diturunkan per drone dan per lensa, jadi "Detail" tetap berarti
 * detail waktu drone-nya diganti — bukan tiba-tiba jadi kasar karena lensanya
 * lebih lebar.
 */
export const PRESETS = [
  {
    id: 'cepat',
    name: 'Cepat',
    gsdCm: 3.5,
    frontOverlap: 0.75,
    sideOverlap: 0.65,
    note: 'Survei luas, hasil cukup untuk ukur dan lihat kondisi lahan.',
  },
  {
    id: 'standar',
    name: 'Standar',
    gsdCm: 2.5,
    frontOverlap: 0.8,
    sideOverlap: 0.7,
    note: 'Setelan harian. Aman untuk ortofoto dan hitung luas.',
  },
  {
    id: 'detail',
    name: 'Detail',
    gsdCm: 1.5,
    frontOverlap: 0.85,
    sideOverlap: 0.75,
    note: 'Objek kecil terbaca. Jauh lebih lama dan boros baterai.',
  },
];

export const findPreset = (id) => PRESETS.find((p) => p.id === id) ?? null;

/** Preset yang cocok dengan setelan sekarang, atau null kalau sudah custom. */
export function matchPreset({ gsdCm, frontOverlap, sideOverlap }) {
  return (
    PRESETS.find(
      (p) =>
        Math.abs(p.gsdCm - gsdCm) < 0.05 &&
        Math.abs(p.frontOverlap - frontOverlap) < 0.01 &&
        Math.abs(p.sideOverlap - sideOverlap) < 0.01
    ) ?? null
  );
}
