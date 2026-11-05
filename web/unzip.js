// Pembaca ZIP untuk browser — dipakai saat mengimpor KMZ asli dari DJI Fly
// untuk mengambil kode drone yang sebenarnya.
//
// Dekompresi memakai DecompressionStream('deflate-raw') yang sudah ada di
// browser modern, jadi tidak ada pustaka tambahan. Entri yang tersimpan tanpa
// kompresi (method 0) dibaca apa adanya.

const u16 = (v, p) => v.getUint16(p, true);
const u32 = (v, p) => v.getUint32(p, true);

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Browser ini tidak bisa membuka file terkompresi (DecompressionStream absen).');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<Record<string, Uint8Array>>}
 */
export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // End Of Central Directory dicari dari belakang.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Bukan file ZIP/KMZ yang valid.');

  const count = u16(view, eocd + 10);
  let p = u32(view, eocd + 16);
  const out = {};
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (u32(view, p) !== 0x02014b50) throw new Error('Isi file rusak (central directory).');

    const method = u16(view, p + 10);
    const csize = u32(view, p + 20);
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const cmtLen = u16(view, p + 32);
    const lho = u32(view, p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    const lNameLen = u16(view, lho + 26);
    const lExtraLen = u16(view, lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const body = bytes.subarray(start, start + csize);

    if (!name.endsWith('/')) {
      out[name] = method === 8 ? await inflateRaw(body) : body.slice();
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<wpml:${name}>([^<]*)</wpml:${name}>`));
  return m ? m[1].trim() : null;
};

/**
 * Ambil kode drone & payload dari KMZ asli DJI Fly.
 * Inilah satu-satunya cara jujur mendapatkan angka ini untuk lini consumer:
 * DJI tidak mempublikasikannya.
 */
export async function readEnumsFromKmz(fileOrBuffer) {
  const buf =
    fileOrBuffer instanceof Blob ? await fileOrBuffer.arrayBuffer() : fileOrBuffer;

  let xml;
  // File .kml/.wpml telanjang juga diterima — kadang orang mengirim isinya saja.
  const head = new Uint8Array(buf.slice ? buf.slice(0, 2) : buf.subarray(0, 2));
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const files = await readZip(buf);
    const key =
      Object.keys(files).find((k) => k.endsWith('waylines.wpml')) ??
      Object.keys(files).find((k) => k.endsWith('template.kml'));
    if (!key) throw new Error('Tidak ada wpmz/template.kml atau waylines.wpml di dalam file.');
    xml = new TextDecoder().decode(files[key]);
  } else {
    xml = new TextDecoder().decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  }

  const drone = tag(xml, 'droneEnumValue');
  if (drone === null) {
    throw new Error('File ini tidak memuat droneEnumValue — kemungkinan bukan KMZ waypoint DJI.');
  }

  return {
    droneEnumValue: Number(drone),
    droneSubEnumValue: Number(tag(xml, 'droneSubEnumValue') ?? 0),
    payloadEnumValue: Number(tag(xml, 'payloadEnumValue') ?? drone),
    payloadSubEnumValue: Number(tag(xml, 'payloadSubEnumValue') ?? 0),
    verified: true,
    confidence: 'verified',
    note: 'Dibaca dari file asli DJI Fly.',
    namespace: (xml.match(/xmlns:wpml="([^"]+)"/) ?? [])[1] ?? null,
  };
}
