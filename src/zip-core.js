// Penulis ZIP murni — tanpa dependency, tanpa API khusus Node.
// Jalan di Node maupun di browser. Kompresi opsional: kalau `deflate` tidak
// diberikan, entri disimpan apa adanya (method 0 "store"), yang tetap ZIP valid.
//
// Dipakai bersama oleh src/zip.js (Node, pakai zlib) dan web/kmz.js (browser).

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(d) {
  return {
    time:
      ((d.getHours() & 0x1f) << 11) |
      ((d.getMinutes() & 0x3f) << 5) |
      (Math.floor(d.getSeconds() / 2) & 0x1f),
    date:
      (((d.getFullYear() - 1980) & 0x7f) << 9) |
      (((d.getMonth() + 1) & 0x0f) << 5) |
      (d.getDate() & 0x1f),
  };
}

const enc = new TextEncoder();
const toBytes = (v) => (typeof v === 'string' ? enc.encode(v) : v ?? new Uint8Array(0));

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/**
 * @param {Array<{name: string, data?: Uint8Array|string, dir?: boolean}>} entries
 * @param {{date?: Date, deflate?: (b: Uint8Array) => Uint8Array}} [opts]
 * @returns {Uint8Array}
 */
export function createZip(entries, opts = {}) {
  const { date = new Date(), deflate } = opts;
  const { time: dosTime, date: dosDate } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const isDir = !!e.dir;
    const name = isDir && !e.name.endsWith('/') ? e.name + '/' : e.name;
    const nameBytes = enc.encode(name);
    const raw = isDir ? new Uint8Array(0) : toBytes(e.data);
    const useDeflate = !isDir && typeof deflate === 'function';
    const body = useDeflate ? deflate(raw) : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const lh = new Uint8Array(30);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flag: nama file UTF-8
    lv.setUint16(8, method, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra len
    locals.push(lh, nameBytes, body);

    const ch = new Uint8Array(46);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra len
    cv.setUint16(32, 0, true); // comment len
    cv.setUint16(34, 0, true); // disk start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, isDir ? 0x41ff0010 : 0x81a40000, true); // external attrs
    cv.setUint32(42, offset, true);
    centrals.push(ch, nameBytes);

    offset += lh.length + nameBytes.length + body.length;
  }

  const cd = concat(centrals);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, offset, true);

  return concat([...locals, cd, eocd]);
}
