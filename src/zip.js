// Binding Node untuk ZIP: pakai zip-core buat nulis (dengan kompresi zlib),
// plus pembaca ZIP yang dipakai src/inspect.js.
import zlib from 'node:zlib';
import { createZip as createZipCore } from './zip-core.js';

/**
 * @param {Array<{name: string, data?: Uint8Array|string, dir?: boolean}>} entries
 * @returns {Buffer}
 */
export function createZip(entries, opts = {}) {
  const bytes = createZipCore(entries, {
    ...opts,
    deflate: (b) => zlib.deflateRawSync(b, { level: 9 }),
  });
  return Buffer.from(bytes);
}

/**
 * Bongkar zip → { 'path/di/zip': Buffer }
 * @param {Buffer} buf
 */
export function readZip(buf) {
  // Cari End Of Central Directory dari belakang.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Bukan file ZIP/KMZ yang valid (EOCD tidak ketemu)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Central directory rusak');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(dataStart, dataStart + csize);

    if (!name.endsWith('/')) {
      out[name] = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}
