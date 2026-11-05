// Pembaca EXIF seperlunya: koordinat GPS dan waktu pengambilan dari foto JPEG.
//
// Dipakai untuk menjawab satu pertanyaan di lapangan: "sampai mana yang sudah
// terpotret?" Itu sengaja bukan pertanyaan "di mana drone berbalik" — drone
// bisa berbalik jauh setelah jepretan terakhir, dan kalau jalur dipotong di
// titik balik, ada lubang di ortofoto yang baru ketahuan waktu olah data.
//
// Ditulis sendiri, tanpa pustaka: yang dibutuhkan cuma segelintir tag, dan
// satu dependensi lagi berarti satu hal lagi yang bisa gagal tanpa sinyal.
//
// Hanya segmen APP1 di awal file yang dibaca, jadi foto 50 MP pun tidak perlu
// dimuat seluruhnya ke memori.

const HEAD_BYTES = 256 * 1024; // Cukup untuk APP1; EXIF selalu di awal file.

const TAG = {
  EXIF_IFD: 0x8769,
  GPS_IFD: 0x8825,
  DATETIME_ORIGINAL: 0x9003,
  DATETIME: 0x0132,
  MAKE: 0x010f,
  MODEL: 0x0110,
};

const GPS = {
  LAT_REF: 1,
  LAT: 2,
  LNG_REF: 3,
  LNG: 4,
  ALT_REF: 5,
  ALT: 6,
};

// Ukuran tiap tipe nilai EXIF, dalam byte.
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** Cari segmen APP1 yang memuat "Exif\0\0", kembalikan posisi awal header TIFF. */
function findTiffStart(view, length) {
  if (view.getUint16(0) !== 0xffd8) throw new Error('Bukan file JPEG.');

  let p = 2;
  while (p + 4 < length) {
    if (view.getUint8(p) !== 0xff) break;

    const marker = view.getUint8(p + 1);
    const size = view.getUint16(p + 2);

    // SOS: data gambar dimulai, tidak ada metadata lagi setelah ini.
    if (marker === 0xda) break;

    if (marker === 0xe1 && p + 10 < length) {
      const tag = String.fromCharCode(
        view.getUint8(p + 4),
        view.getUint8(p + 5),
        view.getUint8(p + 6),
        view.getUint8(p + 7)
      );
      if (tag === 'Exif') return p + 10;
    }

    p += 2 + size;
  }
  return -1;
}

function readEntries(view, tiff, ifdOffset, little) {
  const base = tiff + ifdOffset;
  const count = view.getUint16(base, little);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    const entry = base + 2 + i * 12;
    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const num = view.getUint32(entry + 4, little);
    const bytes = (TYPE_SIZE[type] ?? 1) * num;

    // Nilai 4 byte atau kurang disimpan langsung di slot offset.
    const at = bytes <= 4 ? entry + 8 : tiff + view.getUint32(entry + 8, little);
    out.set(tag, { type, num, at });
  }
  return out;
}

function readValue(view, e, little) {
  const vals = [];
  for (let i = 0; i < e.num; i++) {
    switch (e.type) {
      case 1:
      case 7:
        vals.push(view.getUint8(e.at + i));
        break;
      case 2:
        vals.push(String.fromCharCode(view.getUint8(e.at + i)));
        break;
      case 3:
        vals.push(view.getUint16(e.at + i * 2, little));
        break;
      case 4:
        vals.push(view.getUint32(e.at + i * 4, little));
        break;
      case 5: {
        const n = view.getUint32(e.at + i * 8, little);
        const d = view.getUint32(e.at + i * 8 + 4, little);
        vals.push(d ? n / d : 0);
        break;
      }
      case 9:
        vals.push(view.getInt32(e.at + i * 4, little));
        break;
      case 10: {
        const n = view.getInt32(e.at + i * 8, little);
        const d = view.getInt32(e.at + i * 8 + 4, little);
        vals.push(d ? n / d : 0);
        break;
      }
      default:
        vals.push(0);
    }
  }
  if (e.type === 2) return vals.join('').replace(/\0+$/, '');
  return vals;
}

/** Derajat-menit-detik -> derajat desimal. */
const dmsToDeg = (dms, ref) => {
  const [d = 0, m = 0, s = 0] = dms;
  const deg = d + m / 60 + s / 3600;
  return ref === 'S' || ref === 'W' ? -deg : deg;
};

/** "2026:11:05 09:12:33" -> Date (waktu lokal kamera, tanpa zona). */
function parseExifDate(text) {
  const m = String(text).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s);
}

/**
 * Baca posisi dan waktu satu foto.
 * @returns {Promise<{lngLat: [number, number], takenAt: Date|null, altitudeM: number|null, model: string|null}>}
 */
export async function readPhotoLocation(file) {
  const buf = await file.slice(0, HEAD_BYTES).arrayBuffer();
  const view = new DataView(buf);

  const tiff = findTiffStart(view, buf.byteLength);
  if (tiff < 0) throw new Error('Foto ini tidak punya data EXIF.');

  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error('Header EXIF tidak dikenali.');
  const little = order === 0x4949;

  const ifd0 = readEntries(view, tiff, view.getUint32(tiff + 4, little), little);

  const gpsPtr = ifd0.get(TAG.GPS_IFD);
  if (!gpsPtr) {
    throw new Error(
      'Foto ini tidak menyimpan koordinat. Pastikan foto diambil drone, bukan hasil kirim lewat WhatsApp — pengiriman chat membuang data GPS.'
    );
  }

  const gps = readEntries(view, tiff, readValue(view, gpsPtr, little)[0], little);
  const lat = gps.get(GPS.LAT);
  const lng = gps.get(GPS.LNG);
  if (!lat || !lng) throw new Error('Data GPS di foto ini tidak lengkap.');

  const latRef = gps.get(GPS.LAT_REF) ? readValue(view, gps.get(GPS.LAT_REF), little) : 'N';
  const lngRef = gps.get(GPS.LNG_REF) ? readValue(view, gps.get(GPS.LNG_REF), little) : 'E';

  const coords = [
    dmsToDeg(readValue(view, lng, little), lngRef),
    dmsToDeg(readValue(view, lat, little), latRef),
  ];

  if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
    throw new Error('Koordinat di foto ini tidak terbaca.');
  }

  // Waktu pengambilan ada di Exif IFD; kalau tidak ada, pakai waktu file IFD0.
  let takenAt = null;
  const exifPtr = ifd0.get(TAG.EXIF_IFD);
  if (exifPtr) {
    const exif = readEntries(view, tiff, readValue(view, exifPtr, little)[0], little);
    const dt = exif.get(TAG.DATETIME_ORIGINAL);
    if (dt) takenAt = parseExifDate(readValue(view, dt, little));
  }
  if (!takenAt && ifd0.get(TAG.DATETIME)) {
    takenAt = parseExifDate(readValue(view, ifd0.get(TAG.DATETIME), little));
  }

  let altitudeM = null;
  const alt = gps.get(GPS.ALT);
  if (alt) {
    const v = readValue(view, alt, little)[0];
    const belowSea = gps.get(GPS.ALT_REF)
      ? readValue(view, gps.get(GPS.ALT_REF), little)[0] === 1
      : false;
    altitudeM = belowSea ? -v : v;
  }

  const model = ifd0.get(TAG.MODEL) ? readValue(view, ifd0.get(TAG.MODEL), little) : null;

  return { lngLat: coords, takenAt, altitudeM, model, name: file.name };
}

/**
 * Dari sekumpulan foto, ambil yang paling akhir diambil.
 *
 * Diurutkan berdasarkan waktu EXIF, bukan nama file: penomoran DJI berputar
 * kembali ke 0001 dan bisa bertabrakan antar penerbangan, sedangkan nama file
 * hasil salin dari HP sering tidak urut sama sekali.
 */
export async function readLastPhoto(files) {
  const good = [];
  const bad = [];

  for (const file of files) {
    try {
      good.push(await readPhotoLocation(file));
    } catch (err) {
      bad.push(`${file.name}: ${err.message}`);
    }
  }

  if (!good.length) {
    throw new Error(bad.length === 1 ? bad[0] : `Tidak ada foto yang bisa dibaca. ${bad[0]}`);
  }

  const withTime = good.filter((p) => p.takenAt);
  const last = withTime.length
    ? withTime.reduce((a, b) => (a.takenAt > b.takenAt ? a : b))
    : good[good.length - 1];

  return { last, read: good.length, skipped: bad, hasTime: !!last.takenAt };
}
