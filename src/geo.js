// Helper geodesi sederhana (spherical earth, cukup akurat untuk jarak < beberapa km).
const R = 6371008.8; // mean earth radius, meter
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Titik tujuan dari (lat,lng) dengan bearing (derajat, 0=utara) sejauh distM meter. */
export function destination(lat, lng, bearingDeg, distM) {
  const d = distM / R;
  const br = toRad(bearingDeg);
  const f1 = toRad(lat);
  const l1 = toRad(lng);
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(br));
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(f1),
      Math.cos(d) - Math.sin(f1) * Math.sin(f2)
    );
  return { lat: toDeg(f2), lng: ((toDeg(l2) + 540) % 360) - 180 };
}

/** Jarak haversine antara dua titik, dalam meter. */
export function distance(a, b) {
  const df = toRad(b.lat - a.lat);
  const dl = toRad(b.lng - a.lng);
  const f1 = toRad(a.lat);
  const f2 = toRad(b.lat);
  const h =
    Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Total panjang jalur melewati daftar titik, dalam meter. */
export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}
