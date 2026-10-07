// Engine perencanaan survei: hitungan fotogrametri + generator jalur grid.
// Murni JavaScript, tanpa dependency — jalan di Node maupun di browser.

// ---------- Proyeksi lokal ----------
// Untuk area beberapa kilometer, proyeksi equirectangular lokal sudah cukup
// akurat (error < 0.1%) dan jauh lebih sederhana daripada UTM.

const M_PER_DEG_LAT = 111320;

export function makeProjector(lat0, lng0) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return {
    toXY: ([lng, lat]) => [(lng - lng0) * mPerDegLng, (lat - lat0) * M_PER_DEG_LAT],
    toLL: ([x, y]) => [lng0 + x / mPerDegLng, lat0 + y / M_PER_DEG_LAT],
  };
}

/** Luas poligon (meter persegi) dari titik-titik XY, pakai rumus shoelace. */
export function polygonArea(xy) {
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function centroid(coords) {
  const n = coords.length;
  return [
    coords.reduce((s, c) => s + c[0], 0) / n,
    coords.reduce((s, c) => s + c[1], 0) / n,
  ];
}

// ---------- Fotogrametri ----------

/** Ground Sample Distance dalam cm/piksel pada ketinggian tertentu. */
export function gsdFromAltitude(cam, altM) {
  return (cam.sensorWidthMm * altM * 100) / (cam.focalLengthMm * cam.imageWidthPx);
}

/** Ketinggian terbang (m) yang dibutuhkan untuk mencapai GSD tertentu. */
export function altitudeFromGsd(cam, gsdCm) {
  return (gsdCm * cam.focalLengthMm * cam.imageWidthPx) / (cam.sensorWidthMm * 100);
}

/** Cakupan tanah satu foto, dalam meter. w = melintang jalur, h = searah jalur. */
export function footprint(cam, altM) {
  return {
    w: (cam.sensorWidthMm * altM) / cam.focalLengthMm,
    h: (cam.sensorHeightMm * altM) / cam.focalLengthMm,
  };
}

/**
 * Batas kecepatan supaya motion blur tidak melebihi toleransi.
 * Mini 5 Pro pakai rolling shutter, jadi ini bukan sekadar saran.
 */
export function maxSpeedForBlur(gsdCm, shutterSec, blurPx = 1) {
  return ((gsdCm / 100) * blurPx) / shutterSec;
}

/** Batas kecepatan supaya kamera sempat menjepret tiap frontSpacing meter. */
export function maxSpeedForInterval(frontSpacingM, minIntervalSec = 2) {
  return frontSpacingM / minIntervalSec;
}

/**
 * Hitung seluruh parameter survei dari input user.
 * Salah satu dari `gsdCm` atau `altitudeM` wajib diisi; yang lain diturunkan.
 */
export function computeSurveyParams(cam, input) {
  const {
    gsdCm,
    altitudeM,
    frontOverlap = 0.8,
    sideOverlap = 0.7,
    shutterSec = 1 / 500,
    blurPx = 1,
    minIntervalSec = 2,
  } = input;

  const altitude = altitudeM ?? altitudeFromGsd(cam, gsdCm);
  const gsd = gsdCm ?? gsdFromAltitude(cam, altitude);
  const fp = footprint(cam, altitude);

  const sideSpacing = fp.w * (1 - sideOverlap);
  const frontSpacing = fp.h * (1 - frontOverlap);

  const vBlur = maxSpeedForBlur(gsd, shutterSec, blurPx);
  const vInterval = maxSpeedForInterval(frontSpacing, minIntervalSec);

  return {
    altitude,
    gsd,
    footprint: fp,
    sideSpacing,
    frontSpacing,
    maxSpeedBlur: vBlur,
    maxSpeedInterval: vInterval,
    recommendedSpeed: Math.min(vBlur, vInterval),
  };
}

// ---------- Buffer area ----------

/**
 * Melebarkan poligon keluar sejauh `dist` meter (offset mitered).
 *
 * Kenapa perlu: foto di tepi jalur hanya tertutup dari satu sisi, jadi tidak
 * punya pasangan stereo yang cukup. Pinggiran ortofoto jadi melengkung atau
 * kosong. Dengan terbang sedikit melewati batas, tepi area yang sebenarnya
 * ikut terpotret dari dua sisi.
 *
 * Tiap titik sudut digeser sepanjang garis bagi sudutnya. `miterLimit` menahan
 * sudut lancip supaya tidak memanjang jadi duri.
 */
export function offsetPolygon(xy, dist, miterLimit = 3) {
  if (!dist || xy.length < 3) return xy.map((p) => [p[0], p[1]]);

  // Arah putaran menentukan mana sisi "luar".
  let signed = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    signed += x1 * y2 - x2 * y1;
  }
  const ccw = signed > 0;

  const outwardNormal = (a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return ccw ? [dy / len, -dx / len] : [-dy / len, dx / len];
  };

  const n = xy.length;
  return xy.map((v, i) => {
    const prev = xy[(i - 1 + n) % n];
    const next = xy[(i + 1) % n];
    const nA = outwardNormal(prev, v);
    const nB = outwardNormal(v, next);

    let bx = nA[0] + nB[0];
    let by = nA[1] + nB[1];
    const blen = Math.hypot(bx, by);

    // Sudut balik ~180°: garis bagi tidak terdefinisi, pakai normal satu sisi.
    if (blen < 1e-9) return [v[0] + nA[0] * dist, v[1] + nA[1] * dist];

    bx /= blen;
    by /= blen;
    const cosHalf = bx * nA[0] + by * nA[1];
    const reach = Math.min(dist / Math.max(cosHalf, 1e-6), dist * miterLimit);
    return [v[0] + bx * reach, v[1] + by * reach];
  });
}

// ---------- Generator grid ----------

function rotate([x, y], rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [x * c - y * s, x * s + y * c];
}

/**
 * Jalur lawnmower di dalam poligon.
 *
 * @param {Array<[number,number]>} polyXY poligon dalam meter
 * @param {object} o
 * @param {number} o.angleDeg arah jalur, 0 = timur-barat, 90 = utara-selatan
 * @param {number} o.sideSpacing jarak antar jalur (m)
 * @param {number} o.frontSpacing jarak antar foto sepanjang jalur (m)
 * @param {'continuous'|'stopAndShoot'} o.mode
 * @param {number} o.overshoot perpanjangan tiap ujung jalur untuk ruang belok (m)
 * @returns {{lines: Array<Array<[number,number]>>, waypoints: Array<object>, photos: number}}
 */
export function generateGrid(polyXY, o) {
  const {
    angleDeg = 0,
    sideSpacing,
    frontSpacing,
    mode = 'continuous',
    overshoot = 0,
  } = o;

  const rad = (-angleDeg * Math.PI) / 180;
  const P = polyXY.map((p) => rotate(p, rad));
  const ys = P.map((p) => p[1]);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  // Scanline: potong poligon dengan garis horizontal tiap sideSpacing.
  const segments = [];
  const start = minY + sideSpacing / 2;
  for (let y = start; y <= maxY; y += sideSpacing) {
    const xs = [];
    for (let i = 0; i < P.length; i++) {
      const [x1, y1] = P[i];
      const [x2, y2] = P[(i + 1) % P.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      segments.push({ y, x0: xs[i], x1: xs[i + 1] });
    }
  }

  // Poligon lebih tipis dari satu jarak jalur: tetap beri satu jalur di tengah.
  if (!segments.length && maxY > minY) {
    const y = (minY + maxY) / 2;
    const xs = [];
    for (let i = 0; i < P.length; i++) {
      const [x1, y1] = P[i];
      const [x2, y2] = P[(i + 1) % P.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    if (xs.length >= 2) segments.push({ y, x0: xs[0], x1: xs[xs.length - 1] });
  }

  const unrot = (p) => rotate(p, -rad);
  const lines = [];
  const waypoints = [];
  let photos = 0;
  let flip = false;

  for (const seg of segments) {
    let a = [seg.x0 - overshoot, seg.y];
    let b = [seg.x1 + overshoot, seg.y];
    if (flip) [a, b] = [b, a]; // serpentine: bolak-balik biar tidak buang jarak
    flip = !flip;

    lines.push([unrot(a), unrot(b)]);

    const len = Math.abs(b[0] - a[0]);
    const shotsOnLine = Math.max(2, Math.floor(len / frontSpacing) + 1);
    photos += shotsOnLine;

    // Arah hadap drone sepanjang jalur ini (bearing kompas).
    const dir = unrot([b[0] - a[0], 0]);
    const heading = (((Math.atan2(dir[0], dir[1]) * 180) / Math.PI) + 360) % 360;

    if (mode === 'stopAndShoot') {
      // Satu waypoint per foto — presisi, tapi lambat dan boros waypoint.
      for (let i = 0; i < shotsOnLine; i++) {
        const t = i / (shotsOnLine - 1);
        waypoints.push({
          xy: unrot([a[0] + (b[0] - a[0]) * t, seg.y]),
          heading,
          takePhoto: true,
          photos: 1,
        });
      }
    } else {
      // Dua waypoint per jalur — pemotretan dipicu per jarak oleh drone.
      // Jatah foto dibebankan ke titik akhir jalur, supaya jumlah foto per
      // sortie tetap bisa dihitung setelah jalur dipecah per baterai.
      waypoints.push({ xy: unrot(a), heading, takePhoto: false, photos: 0 });
      waypoints.push({ xy: unrot(b), heading, takePhoto: false, photos: shotsOnLine });
    }
  }

  return { lines, waypoints, photos };
}

/**
 * Waktu tempuh satu ruas, dengan memperhitungkan akselerasi.
 *
 * Penting untuk mode stop-and-shoot: pada ruas sependek 20 m, drone tidak
 * pernah sempat mencapai kecepatan jelajah — ia akselerasi sampai setengah
 * jalan lalu langsung mengerem. Mengabaikan ini membuat estimasi waktu meleset
 * dua kali lipat lebih.
 */
export function legTime(distM, vmax, accel = 2.5, stopAtEnds = false) {
  if (distM <= 0) return 0;
  if (!stopAtEnds) return distM / vmax;

  const dAccel = (vmax * vmax) / (2 * accel); // jarak untuk mencapai vmax
  if (distM <= 2 * dAccel) return 2 * Math.sqrt(distM / accel); // profil segitiga
  return (2 * vmax) / accel + (distM - 2 * dAccel) / vmax; // profil trapesium
}

/** Waktu yang hilang untuk satu belokan di ujung jalur (melambat, putar, ngebut lagi). */
export function turnPenalty(vmax, accel = 2.5) {
  return (2 * vmax) / accel + 2;
}

/** Total panjang jalur (meter) melewati titik-titik XY berurutan. */
export function pathLengthXY(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    total += Math.hypot(dx, dy);
  }
  return total;
}

/** Estimasi durasi misi (detik), sudah memperhitungkan akselerasi dan belokan. */
export function missionDuration(waypoints, o) {
  const { speed, accel = 2.5, hoverPerPhotoSec = 0, stopAtEach = false } = o;
  let t = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    const d = Math.hypot(b.xy[0] - a.xy[0], b.xy[1] - a.xy[1]);
    const isTurn = !stopAtEach && a.heading !== b.heading;
    t += legTime(d, speed, accel, stopAtEach || isTurn);
    if (isTurn) t += turnPenalty(speed, accel);
  }
  return t + waypoints.filter((w) => w.takePhoto).length * hoverPerPhotoSec;
}

/**
 * Pecah jalur jadi beberapa sortie sesuai daya tahan baterai.
 * Tiap sortie menyisakan waktu untuk naik, transit ke titik lanjut, dan pulang.
 */
export function splitByBattery(waypoints, o) {
  const {
    speed,
    usableFlightMin,
    hoverPerPhotoSec = 0,
    transitReserveSec = 120,
    accel = 2.5,
    stopAtEach = false,
  } = o;

  const budget = usableFlightMin * 60 - transitReserveSec;
  const sorties = [];
  let current = [];
  let elapsed = 0;

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    let cost = 0;
    if (current.length) {
      const prev = current[current.length - 1];
      const d = Math.hypot(wp.xy[0] - prev.xy[0], wp.xy[1] - prev.xy[1]);
      // Pergantian arah hadap menandakan ujung jalur — di situ drone berbelok.
      const isTurn = !stopAtEach && prev.heading !== wp.heading;
      cost += legTime(d, speed, accel, stopAtEach || isTurn);
      if (isTurn) cost += turnPenalty(speed, accel);
    }
    if (wp.takePhoto) cost += hoverPerPhotoSec;

    if (current.length && elapsed + cost > budget) {
      sorties.push(current);
      current = [];
      elapsed = 0;
      cost = wp.takePhoto ? hoverPerPhotoSec : 0;
    }
    current.push(wp);
    elapsed += cost;
  }
  if (current.length) sorties.push(current);
  return sorties;
}

/** Jarak terjauh dari titik home ke salah satu waypoint (meter). */
export function maxDistanceFrom(homeXY, waypoints) {
  let max = 0;
  for (const w of waypoints) {
    max = Math.max(max, Math.hypot(w.xy[0] - homeXY[0], w.xy[1] - homeXY[1]));
  }
  return max;
}

/**
 * Ringkasan satu sortie: termasuk transit pergi-pulang dari titik home,
 * yang sering dilupakan padahal bisa makan beberapa menit di lahan besar.
 */
export function sortieSummary(sortie, homeXY, o) {
  const { speed, accel = 2.5, hoverPerPhotoSec = 0, stopAtEach = false } = o;
  const first = sortie[0].xy;
  const last = sortie[sortie.length - 1].xy;
  const outM = Math.hypot(first[0] - homeXY[0], first[1] - homeXY[1]);
  const backM = Math.hypot(last[0] - homeXY[0], last[1] - homeXY[1]);
  const transit = (outM + backM) / speed;

  return {
    waypoints: sortie.length,
    photos: sortie.reduce((n, w) => n + (w.photos || 0), 0),
    distanceM: pathLengthXY(sortie.map((w) => w.xy)) + outM + backM,
    surveyS: missionDuration(sortie, { speed, accel, hoverPerPhotoSec, stopAtEach }),
    transitS: transit,
    get durationS() {
      return this.surveyS + this.transitS;
    },
  };
}
