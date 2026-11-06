// Penulis ZIP untuk browser, dengan kompresi.
//
// Ini bukan soal hemat ruang. Arsip buatan DJI Fly dan buatan generator pihak
// ketiga sama-sama memakai entri terkompresi (method 8). Export dari web dulu
// menyimpan mentah (method 0) — ZIP yang sah, tapi berbeda dari satu-satunya
// dua contoh yang kita punya, dan 60x lebih besar.
//
// Pembaca ZIP buatan sendiri — dan DJI Fly kemungkinan begitu — tidak selalu
// menangani kedua method. Jadi perbedaan ini bukan kosmetik.
//
// Node memakai zlib lewat src/zip.js; di browser dipakai CompressionStream,
// yang sudah ada di semua browser modern.
import { createZip } from '../src/zip-core.js';

const enc = new TextEncoder();
const toBytes = (v) => (typeof v === 'string' ? enc.encode(v) : v);

export const canDeflate = () => typeof CompressionStream !== 'undefined';

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {Array<{name: string, data?: Uint8Array|string, dir?: boolean}>} entries
 * @returns {Promise<Uint8Array>}
 */
export async function createZipAsync(entries) {
  if (!canDeflate()) {
    // Tanpa CompressionStream, entri disimpan mentah. Tetap ZIP yang sah,
    // cuma besar — dan itu lebih baik daripada gagal membuat file sama sekali.
    return createZip(entries);
  }

  // Data diubah jadi byte LEBIH DULU, dan peta hasil kompresi dikunci pada
  // instance byte itu juga. Penulis ZIP memanggil deflate() dengan byte hasil
  // konversinya sendiri; kalau kuncinya string, pencarian selalu meleset —
  // dan meleset berarti data mentah ditulis dengan penanda "terkompresi",
  // alias arsip rusak tanpa ada error.
  const prepared = entries.map((e) =>
    e.dir || e.data == null ? e : { ...e, data: toBytes(e.data) }
  );

  const table = new Map();
  for (const e of prepared) {
    if (e.dir || e.data == null) continue;
    table.set(e.data, await deflateRaw(e.data));
  }

  return createZip(prepared, {
    deflate: (bytes) => {
      const hit = table.get(bytes);
      if (!hit) throw new Error('Kompresi meleset — file tidak jadi dibuat.');
      return hit;
    },
  });
}
