// Pembungkus KMZ untuk browser.
// Memakai generator WPML yang sama persis dengan CLI, hanya penulisan ZIP-nya
// yang memakai mode "store" (tanpa kompresi) karena browser tidak punya
// zlib sinkron. Hasilnya tetap ZIP yang valid — file WPML cuma puluhan KB.
import { createZip } from '../src/zip-core.js';
import { buildTemplateKml, buildWaylinesWpml, MISSION_DEFAULTS } from '../src/wpml.js';

/**
 * @param {object} mission bagian mission yang ingin ditimpa (wajib: waypoints)
 * @param {object} profile isi profiles/*.json
 * @returns {Uint8Array}
 */
export function buildKmz(mission, profile) {
  const full = { ...MISSION_DEFAULTS, ...mission };
  return createZip([
    { name: 'wpmz/', dir: true },
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
