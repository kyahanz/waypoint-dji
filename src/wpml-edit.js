// Mengubah file WPML yang sudah ada, tanpa menulis ulang dari nol.
//
// Ini keputusan desain yang penting, bukan cuma cara implementasi.
//
// File buatan DJI Fly adalah satu-satunya bentuk yang terbukti diterima
// drone, dan masih ada bagian di dalamnya yang belum kita pahami sepenuhnya.
// Kalau file dibongkar lalu ditulis ulang oleh generator kita, semua bagian
// yang belum dipahami itu hilang atau berubah — dan file yang tadinya pasti
// diterima jadi belum tentu.
//
// Jadi di sini file diperlakukan sebagai TEKS. Yang disentuh hanya angka yang
// benar-benar diubah pengguna; sisanya — termasuk tag yang tidak kita kenal —
// tetap berada di tempatnya, huruf per huruf.
//
// Konsekuensinya: tidak ada parser XML, dan itu disengaja. Parser akan
// menormalkan spasi, urutan atribut, dan penulisan angka, lalu mengembalikan
// dokumen yang "setara" tapi tidak identik. Untuk tujuan di sini, identik itu
// yang berharga.

/** Ganti isi satu tag wpml di dalam sepotong teks. Hanya kemunculan pertama. */
export function setTag(xml, tag, value) {
  const re = new RegExp(`(<wpml:${tag}>)([^<]*)(</wpml:${tag}>)`);
  return re.test(xml) ? xml.replace(re, `$1${value}$3`) : xml;
}

/** Ganti semua kemunculan satu tag wpml. */
export function setTagAll(xml, tag, value) {
  const re = new RegExp(`(<wpml:${tag}>)([^<]*)(</wpml:${tag}>)`, 'g');
  return xml.replace(re, `$1${value}$3`);
}

export function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<wpml:${tag}>([^<]*)</wpml:${tag}>`));
  return m ? m[1].trim() : null;
}

const numOrNull = (v) => (v === null || v === '' ? null : Number(v));

/**
 * Pecah waylines.wpml jadi bagian yang bisa diutak-atik.
 *
 * Dokumen disimpan apa adanya dalam tiga potong: teks sebelum Placemark
 * pertama, daftar Placemark mentah, dan teks setelah Placemark terakhir.
 * Menyatukannya kembali tanpa mengubah apa pun menghasilkan berkas yang
 * identik byte-per-byte dengan aslinya.
 */
export function parseWaylines(xml) {
  const marks = [...xml.matchAll(/<Placemark>[\s\S]*?<\/Placemark>/g)];
  if (!marks.length) {
    return { prefix: xml, placemarks: [], suffix: '', waypoints: [] };
  }

  const first = marks[0];
  const last = marks[marks.length - 1];

  // Indentasi di depan Placemark pertama ikut dipotong supaya penggabungan
  // kembali tidak menggandakan spasi.
  const startAt = first.index;
  const endAt = last.index + last[0].length;

  const placemarks = marks.map((m) => m[0]);

  return {
    prefix: xml.slice(0, startAt),
    placemarks,
    suffix: xml.slice(endAt),
    joiner: inferJoiner(xml, marks),
    waypoints: placemarks.map(readWaypoint),
  };
}

/** Teks pemisah antar Placemark (biasanya newline + indentasi). */
function inferJoiner(xml, marks) {
  if (marks.length < 2) return '\n      ';
  const a = marks[0].index + marks[0][0].length;
  const b = marks[1].index;
  return xml.slice(a, b);
}

export function readWaypoint(raw) {
  const coord = raw.match(/<coordinates>\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)/);

  return {
    lng: coord ? Number(coord[1]) : null,
    lat: coord ? Number(coord[2]) : null,
    index: numOrNull(getTag(raw, 'index')),
    height: numOrNull(getTag(raw, 'executeHeight')),
    speed: numOrNull(getTag(raw, 'waypointSpeed')),

    // Sudut gimbal muncul di dua tempat pada file DJI Fly: sebagai aksi
    // gimbalRotate di titik pertama, dan sebagai waypointGimbalPitchAngle di
    // tiap titik. Yang kedua yang berlaku per titik.
    gimbalPitch:
      numOrNull(getTag(raw, 'waypointGimbalPitchAngle')) ??
      numOrNull(getTag(raw, 'gimbalPitchRotateAngle')),

    hasPhoto: /<wpml:actionActuatorFunc>takePhoto<\/wpml:actionActuatorFunc>/.test(raw),
    hasHover: /<wpml:actionActuatorFunc>hover<\/wpml:actionActuatorFunc>/.test(raw),
  };
}

/** Tulis ulang satu Placemark dengan nilai baru. Yang null dibiarkan. */
export function writeWaypoint(raw, patch) {
  let out = raw;

  if (patch.lng != null && patch.lat != null) {
    out = out.replace(
      /(<coordinates>)([\s\S]*?)(<\/coordinates>)/,
      (_, a, inner, b) => {
        // Pertahankan gaya penulisan aslinya: DJI menaruh koordinat di baris
        // sendiri dengan indentasi, dan itu dibiarkan apa adanya.
        const padded = /\n/.test(inner);
        const value = `${trimNum(patch.lng)},${trimNum(patch.lat)}`;
        if (!padded) return `${a}${value}${b}`;
        const indent = inner.match(/\n(\s*)/)?.[1] ?? '';
        const close = inner.match(/\n(\s*)$/)?.[1] ?? '';
        return `${a}\n${indent}${value}\n${close}${b}`;
      }
    );
  }

  if (patch.height != null) out = setTag(out, 'executeHeight', trimNum(patch.height));
  if (patch.speed != null) out = setTag(out, 'waypointSpeed', trimNum(patch.speed));

  if (patch.gimbalPitch != null) {
    const v = trimNum(patch.gimbalPitch);
    out = setTagAll(out, 'waypointGimbalPitchAngle', v);
    out = setTagAll(out, 'gimbalPitchRotateAngle', v);
  }

  return out;
}

const trimNum = (v) => {
  const s = Number(v).toFixed(10);
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
};

/**
 * Perbaiki penomoran setelah titik ditambah atau dihapus.
 *
 * Selain <wpml:index>, action group menyimpan rentang titik yang dia
 * pengaruhi. Group yang menempel pada satu titik (start == end) ikut digeser;
 * group yang membentang sampai titik terakhir — misalnya perintah jepret
 * sepanjang jalur — ujungnya ditarik ke titik terakhir yang baru.
 */
export function renumber(placemarks) {
  const total = placemarks.length;

  // Jumlah titik SEBELUM diubah, dibaca dari penomoran lama. Dipakai untuk
  // mengenali group yang memang membentang sampai titik terakhir, supaya
  // ujungnya ikut ditarik dan bukan dibiarkan menunjuk titik yang sudah
  // tidak ada.
  const oldTotal =
    Math.max(...placemarks.map((p) => numOrNull(getTag(p, 'index')) ?? 0)) + 1;

  return placemarks.map((raw, i) => {
    const old = numOrNull(getTag(raw, 'index'));
    let out = setTag(raw, 'index', String(i));

    out = out.replace(
      /(<wpml:actionGroupStartIndex>)(\d+)(<\/wpml:actionGroupStartIndex>)([\s\S]*?)(<wpml:actionGroupEndIndex>)(\d+)(<\/wpml:actionGroupEndIndex>)/g,
      (_, a, startStr, b, mid, c, endStr, d) => {
        const start = Number(startStr);
        const end = Number(endStr);

        const last = Math.max(0, total - 1);

        // Menempel di titik ini.
        if (start === end && start === old) return `${a}${i}${b}${mid}${c}${i}${d}`;

        // Membentang dari titik pertama sampai titik terakhir — misalnya
        // perintah jepret sepanjang jalur.
        if (start === 0 && end === oldTotal - 1) return `${a}0${b}${mid}${c}${last}${d}`;

        // Membentang ke titik berikutnya. DJI memakai ini untuk memutar
        // gimbal mulus di antara dua titik berurutan, jadi ujungnya harus
        // ikut bergeser — bukan dibiarkan menunjuk nomor lama.
        if (start === old && end === old + 1) {
          return `${a}${i}${b}${mid}${c}${Math.min(i + 1, last)}${d}`;
        }

        return `${a}${start}${b}${mid}${c}${end}${d}`;
      }
    );

    return out;
  });
}

/** Satukan kembali jadi satu berkas XML. */
export function serializeWaylines(doc) {
  if (!doc.placemarks.length) return doc.prefix + doc.suffix;
  return doc.prefix + doc.placemarks.join(doc.joiner ?? '\n      ') + doc.suffix;
}

/**
 * Setelan tingkat misi yang ada di template.kml maupun waylines.wpml.
 * Keduanya harus diubah bersamaan supaya file tidak bertentangan dengan
 * dirinya sendiri.
 */
export const MISSION_FIELDS = [
  'finishAction',
  'exitOnRCLost',
  'executeRCLostAction',
  'flyToWaylineMode',
  'globalTransitionalSpeed',
];

export function readMissionConfig(xml) {
  const out = {};
  for (const f of MISSION_FIELDS) out[f] = getTag(xml, f);
  out.autoFlightSpeed = numOrNull(getTag(xml, 'autoFlightSpeed'));
  out.executeHeightMode = getTag(xml, 'executeHeightMode');
  out.droneEnumValue = numOrNull(getTag(xml, 'droneEnumValue'));
  out.droneSubEnumValue = numOrNull(getTag(xml, 'droneSubEnumValue'));
  out.namespace = (xml.match(/xmlns:wpml="([^"]+)"/) ?? [])[1] ?? null;
  return out;
}

export function writeMissionConfig(xml, patch) {
  let out = xml;
  for (const f of MISSION_FIELDS) {
    if (patch[f] != null) out = setTag(out, f, patch[f]);
  }
  if (patch.autoFlightSpeed != null) {
    out = setTag(out, 'autoFlightSpeed', trimNum(patch.autoFlightSpeed));
  }
  return out;
}

/**
 * Sisipkan titik baru dengan meniru struktur titik di sebelahnya.
 *
 * Meniru, bukan membangun dari template sendiri: dengan begitu semua tag yang
 * ditulis DJI Fly — termasuk yang belum kita pahami — ikut terbawa ke titik
 * baru, persis seperti milik tetangganya.
 */
export function cloneWaypoint(raw, { lng, lat }) {
  return writeWaypoint(raw, { lng, lat });
}
