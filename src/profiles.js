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
/**
 * Seberapa jauh kode drone bisa dipercaya. Urut dari paling kuat:
 *
 *   verified        — dibaca dari KMZ asli yang dibuat drone kamu sendiri.
 *   observed-model  — pernah terlihat keluar dari DJI Fly di model itu juga,
 *                     tapi dari laporan orang lain, bukan file kamu.
 *   observed-family — dipinjam dari model lain selini, karena belum ada bukti
 *                     lini consumer memakai nilai berbeda per model.
 *   unknown         — tidak ada dasarnya sama sekali.
 *
 * Pembedaan ini ada supaya "ada isinya" tidak otomatis berarti "sudah benar".
 */
export const ENUM_CONFIDENCE = {
  verified: {
    rank: 3,
    label: 'Terkunci dari file asli',
    short: 'terkunci',
    tone: 'ok',
  },
  manual: {
    rank: 2.5,
    label: 'Diisi sendiri',
    short: 'manual',
    tone: 'ok',
  },
  'observed-model': {
    rank: 2,
    label: 'Teramati di model ini',
    short: 'teramati',
    tone: 'ok',
  },
  'observed-family': {
    rank: 1,
    label: 'Dipinjam dari model selini',
    short: 'dipinjam',
    tone: 'warn',
  },
  unknown: {
    rank: 0,
    label: 'Belum ada dasarnya',
    short: 'kosong',
    tone: 'bad',
  },
};

export const confidenceOf = (enums) => {
  if (!enums) return 'unknown';
  // `confidence` yang eksplisit menang, supaya nilai yang diketik sendiri
  // tidak mengaku "dibaca dari file asli".
  if (enums.confidence && ENUM_CONFIDENCE[enums.confidence]) return enums.confidence;
  return enums.verified ? 'verified' : 'unknown';
};

export function resolveProfile(registry, { droneId, lensId, modeId, enumOverride } = {}) {
  const drone = findDrone(registry, droneId);
  const lens = findLens(drone, lensId);
  const mode = findMode(lens, modeId);
  const enums = enumOverride ?? drone.enums;
  const confidence = confidenceOf(enums);

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

    droneEnumValue: enums?.droneEnumValue ?? 0,
    droneSubEnumValue: enums?.droneSubEnumValue ?? 0,
    payloadEnumValue: enums?.payloadEnumValue ?? 0,
    payloadSubEnumValue: enums?.payloadSubEnumValue ?? 0,

    enumConfidence: confidence,
    enumConfidenceInfo: ENUM_CONFIDENCE[confidence],
    // Diisi sendiri diperlakukan setara hasil impor: dua-duanya keputusan
    // sadar pengguna, bukan tebakan aplikasi.
    enumVerified: confidence === 'verified' || confidence === 'manual',
    enumKnown: confidence !== 'unknown',
    enumNote: enums?.note ?? null,
    enumSource: enumOverride ? 'impor' : enums ? 'bawaan' : null,

    /**
     * Namespace WPML. DJI Fly consumer memakai uav.com/wpmz/1.0.2; angka
     * 1.0.6 di dokumentasi Cloud API itu untuk lini Enterprise. Kemungkinan
     * besar ini lebih menentukan diterima-tidaknya file daripada nilai enum.
     */
    wpmlNamespace:
      enumOverride?.namespace ?? drone.wpml?.namespace ?? 'http://www.uav.com/wpmz/1.0.2',
    namespaceSource: enumOverride?.namespace ? 'impor' : 'bawaan',

    /**
     * Dialek file. 'djifly' mengikuti bentuk yang benar-benar ditulis DJI Fly
     * (dibongkar dari file asli); 'enterprise' bentuk lama sesuai dokumentasi
     * DJI Pilot 2. Semua drone di registry ini consumer, jadi djifly.
     */
    dialect: drone.wpml?.dialect ?? 'djifly',
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
