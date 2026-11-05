#!/usr/bin/env node
// Bikin JPEG kecil ber-EXIF GPS untuk menguji pembaca foto.
//
// Kenapa dibuat sendiri, bukan pakai foto drone asli: foto 50 MP terlalu besar
// untuk masuk repo, dan foto asli membawa koordinat tempat sungguhan milik
// seseorang. Yang diuji di sini struktur EXIF-nya, dan itu bisa dibuat persis.
//
//   node tools/make-exif-fixture.js <lat> <lng> [nama.jpg] [waktu]
import fs from 'node:fs';
import path from 'node:path';

/** Derajat desimal -> [derajat, menit, detik] sebagai pecahan EXIF. */
function toDms(deg) {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const mFloat = (abs - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return [
    [d, 1],
    [m, 1],
    [Math.round(s * 10000), 10000],
  ];
}

const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };

/**
 * Tulis satu IFD beserta data yang tidak muat di slot 4 byte.
 * @returns {{ifd: Buffer, data: Buffer, dataStart: number}}
 */
function buildIfd(entries, ifdOffset, nextIfd = 0) {
  const ifdSize = 2 + entries.length * 12 + 4;
  const dataStart = ifdOffset + ifdSize;

  const ifd = Buffer.alloc(ifdSize);
  const chunks = [];
  let dataPos = dataStart;

  ifd.writeUInt16LE(entries.length, 0);

  entries.forEach((e, i) => {
    const at = 2 + i * 12;
    // ASCII dihitung per karakter (termasuk penutup \0), bukan per nilai.
    const count =
      e.count ??
      (e.type === T.ASCII ? e.value.length : Array.isArray(e.value) ? e.value.length : 1);
    const bytes = SIZE[e.type] * count;

    ifd.writeUInt16LE(e.tag, at);
    ifd.writeUInt16LE(e.type, at + 2);
    ifd.writeUInt32LE(count, at + 4);

    const payload = Buffer.alloc(Math.max(bytes, 4));
    if (e.type === T.ASCII) {
      payload.write(e.value, 0, 'latin1');
    } else if (e.type === T.RATIONAL) {
      e.value.forEach(([n, d], k) => {
        payload.writeUInt32LE(n, k * 8);
        payload.writeUInt32LE(d, k * 8 + 4);
      });
    } else if (e.type === T.BYTE) {
      payload.writeUInt8(e.value, 0);
    } else if (e.type === T.LONG) {
      payload.writeUInt32LE(e.value, 0);
    } else if (e.type === T.SHORT) {
      payload.writeUInt16LE(e.value, 0);
    }

    if (bytes <= 4) {
      payload.copy(ifd, at + 8, 0, 4);
    } else {
      ifd.writeUInt32LE(dataPos, at + 8);
      const slice = payload.subarray(0, bytes);
      chunks.push(slice);
      dataPos += bytes;
      // IFD harus mulai di batas genap; jaga supaya offset berikutnya rapi.
      if (bytes % 2) {
        chunks.push(Buffer.alloc(1));
        dataPos += 1;
      }
    }
  });

  ifd.writeUInt32LE(nextIfd, ifdSize - 4);
  return { ifd, data: Buffer.concat(chunks), end: dataPos };
}

export function makeExifJpeg({ lat, lng, altitudeM = 100, takenAt = '2026:11:05 09:12:33', model = 'FC8482' }) {
  // Tata letak dihitung dulu supaya penunjuk antar-IFD benar.
  const ifd0Off = 8;
  const ifd0Entries = [
    { tag: 0x010f, type: T.ASCII, value: 'DJI\0' },
    { tag: 0x0110, type: T.ASCII, value: model + '\0' },
    { tag: 0x8769, type: T.LONG, value: 0 }, // diisi ulang
    { tag: 0x8825, type: T.LONG, value: 0 }, // diisi ulang
  ];

  const probe = buildIfd(ifd0Entries, ifd0Off);
  const exifOff = probe.end;

  const exifEntries = [{ tag: 0x9003, type: T.ASCII, value: takenAt + '\0' }];
  const exifProbe = buildIfd(exifEntries, exifOff);
  const gpsOff = exifProbe.end;

  const gpsEntries = [
    { tag: 1, type: T.ASCII, value: (lat >= 0 ? 'N' : 'S') + '\0' },
    { tag: 2, type: T.RATIONAL, value: toDms(lat) },
    { tag: 3, type: T.ASCII, value: (lng >= 0 ? 'E' : 'W') + '\0' },
    { tag: 4, type: T.RATIONAL, value: toDms(lng) },
    { tag: 5, type: T.BYTE, value: altitudeM >= 0 ? 0 : 1 },
    { tag: 6, type: T.RATIONAL, value: [[Math.round(Math.abs(altitudeM) * 100), 100]] },
  ];

  ifd0Entries[2].value = exifOff;
  ifd0Entries[3].value = gpsOff;

  const ifd0 = buildIfd(ifd0Entries, ifd0Off);
  const exif = buildIfd(exifEntries, exifOff);
  const gps = buildIfd(gpsEntries, gpsOff);

  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(0x002a, 2);
  header.writeUInt32LE(ifd0Off, 4);

  const tiff = Buffer.concat([header, ifd0.ifd, ifd0.data, exif.ifd, exif.data, gps.ifd, gps.data]);

  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(app1Body.length + 2, 2);

  // Piksel tidak dibaca sama sekali oleh pembaca EXIF, jadi cukup penanda
  // awal dan akhir file yang sah.
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    app1Body,
    Buffer.from([0xff, 0xd9]),
  ]);
}

// Dipanggil langsung dari terminal.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [lat, lng, out = 'out/foto-uji.jpg', takenAt] = process.argv.slice(2);
  if (!lat || !lng) {
    console.error('Pakai: node tools/make-exif-fixture.js <lat> <lng> [keluar.jpg] [YYYY:MM:DD HH:MM:SS]');
    process.exit(1);
  }
  const bytes = makeExifJpeg({
    lat: Number(lat),
    lng: Number(lng),
    ...(takenAt ? { takenAt } : {}),
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log(`${out} — ${bytes.length} byte, ${lat}, ${lng}`);
}
