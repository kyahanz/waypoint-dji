// Pembungkus KMZ untuk browser.
//
// Memakai generator WPML yang sama persis dengan CLI. Dulu penulisan ZIP-nya
// memakai mode "store" tanpa kompresi, dengan alasan browser tidak punya zlib
// sinkron — dan alasan itu sudah tidak berlaku sejak ada CompressionStream.
//
// Akibatnya bukan sekadar file besar (60x), tapi arsip yang berbeda bentuk
// dari satu-satunya dua contoh yang kita punya: file buatan DJI Fly dan file
// generator pihak ketiga, dua-duanya terkompresi.
import { createZipAsync } from './zip-browser.js';
import { buildTemplateKml, buildWaylinesWpml, MISSION_DEFAULTS } from '../src/wpml.js';

/**
 * @param {object} mission bagian mission yang ingin ditimpa (wajib: waypoints)
 * @param {object} profile isi profiles/*.json
 * @returns {Promise<Uint8Array>}
 */
export function buildKmz(mission, profile) {
  const full = { ...MISSION_DEFAULTS, ...mission };
  // Tanpa entri folder 'wpmz/': arsip buatan DJI Fly tidak memuatnya.
  return createZipAsync([
    { name: 'wpmz/template.kml', data: buildTemplateKml(full, profile) },
    { name: 'wpmz/waylines.wpml', data: buildWaylinesWpml(full, profile) },
  ]);
}

export function downloadBlob(bytes, filename, type) {
  const guessed = filename.endsWith('.geojson')
    ? 'application/geo+json'
    : 'application/vnd.google-earth.kmz';
  const blob = new Blob([bytes], { type: type ?? guessed });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
