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

/**
 * Apakah batas poligonnya memotong dirinya sendiri?
 *
 * Ini bukan kerewelan geometri, melainkan satu-satunya penjelasan untuk angka
 * yang pernah muncul di layar tanpa sebab: lahan "dasi kupu-kupu" — urutan
 * titiknya menyilang — membuat shoelace MENIADAKAN kedua lobusnya, jadi
 * luasnya dilaporkan NOL sementara jalur terbangnya tetap terbentuk belasan
 * titik. Semua angka per hektar sesudah itu ikut ngawur, dan tidak ada satu
 * pun peringatan yang menyala.
 *
 * Di layar sentuh ini gampang terjadi tanpa sadar: cukup satu ketukan titik
 * sudut yang urutannya kebalik.
 *
 * O(n²) dan itu tidak jadi soal — lahan digambar dengan beberapa belas titik,
 * bukan beberapa ribu.
 */
export function selfIntersects(xy) {
  const n = xy?.length ?? 0;
  if (n < 4) return false;

  // Orientasi tiga titik: >0 belok kiri, <0 belok kanan, 0 segaris.
  const arah = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

  const potong = (p1, p2, p3, p4) => {
    const d1 = arah(p3, p4, p1);
    const d2 = arah(p3, p4, p2);
    const d3 = arah(p1, p2, p3);
    const d4 = arah(p1, p2, p4);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };

  for (let i = 0; i < n; i++) {
    const a1 = xy[i];
    const a2 = xy[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Ruas yang bersebelahan memang berbagi satu titik ujung, dan ruas
      // pertama dengan ruas terakhir juga. Itu bukan persilangan.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (potong(a1, a2, xy[j], xy[(j + 1) % n])) return true;
    }
  }
  return false;
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

// ---------- Kamera miring ----------
//
// Semua hitungan di atas mengandaikan kamera menunduk LURUS. Untuk pola
// miring itu tidak berlaku, dan bedanya besar: pada gimbal -45° di 80 m,
// jarak ke tengah frame bukan 80 m melainkan 113 m — jadi GSD-nya 41% lebih
// kasar dari angka nadir. Di -30° melesetnya 100%.
//
// Yang lebih halus: di pola miring tidak ada SATU PUN foto yang menunduk
// lurus, jadi angka GSD nadir tidak mewakili satu piksel pun di dataset.
// Itulah kenapa fungsi-fungsi ini ada, dan kenapa yang ditampilkan ke layar
// harus yang keluar dari sini.

const RAD = Math.PI / 180;

/**
 * Sudut pandang dari arah nadir, dari sudut pitch gimbal.
 * -90 (nunduk lurus) -> 0°; -45 -> 45°; -30 -> 60°.
 */
export function tiltFromNadirDeg(gimbalPitchDeg) {
  return 90 - Math.abs(gimbalPitchDeg);
}

/** Jarak miring dari kamera ke tengah frame, dalam meter. */
export function slantRange(altM, gimbalPitchDeg) {
  const tilt = tiltFromNadirDeg(gimbalPitchDeg);
  // Di atas 85° dari nadir kamera praktis menatap cakrawala; jarak miringnya
  // meledak dan angkanya berhenti berarti. Dibatasi supaya tidak ada Infinity
  // yang menyelinap ke layar sebagai angka yang kelihatan sah.
  return altM / Math.cos(Math.min(tilt, 85) * RAD);
}

/**
 * GSD yang benar-benar mendarat di permukaan yang dipotret, untuk kamera
 * pada sudut tertentu — di tengah frame, dan di kedua tepinya.
 *
 * Tepi jauh itu yang sering mengejutkan: pada -45° dengan FOV vertikal 59°,
 * tepi jauh frame mendarat 286 m di depan drone dengan GSD 11 cm/px, sementara
 * tepi dekatnya 22 m dengan 3.1 cm/px. Satu foto, selisih ketelitian 3.5 kali.
 * Yang berguna untuk rekonstruksi cuma bagian dekat-tengah.
 */
export function surfaceGsd(cam, altM, gimbalPitchDeg = -90) {
  const tilt = tiltFromNadirDeg(gimbalPitchDeg);
  const halfVDeg = (Math.atan(cam.sensorHeightMm / (2 * cam.focalLengthMm)) / RAD);

  const at = (deg) => gsdFromAltitude(cam, altM / Math.cos(Math.min(Math.max(deg, 0), 85) * RAD));
  const groundAt = (deg) => altM * Math.tan(Math.min(Math.max(deg, 0), 85) * RAD);

  return {
    tiltDeg: tilt,
    halfVDeg,
    slantM: slantRange(altM, gimbalPitchDeg),
    centerCm: at(tilt),
    nearCm: at(tilt - halfVDeg),
    farCm: at(tilt + halfVDeg),
    nearM: groundAt(tilt - halfVDeg),
    farM: groundAt(tilt + halfVDeg),
    // Berapa kali lebih kasar dari angka nadir yang selama ini ditampilkan.
    vsNadir: at(tilt) / gsdFromAltitude(cam, altM),
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
    // Sudut gimbal pola ini. Tidak mengubah jarak jalur maupun jarak foto —
    // itu sengaja, lihat catatan di bawah — tapi menentukan GSD yang
    // dilaporkan, yang sebelumnya selalu angka nadir meski kameranya miring.
    gimbalPitchDeg = -90,
  } = input;

  const altitude = altitudeM ?? altitudeFromGsd(cam, gsdCm);
  const gsd = gsdCm ?? gsdFromAltitude(cam, altitude);
  const fp = footprint(cam, altitude);

  const sideSpacing = fp.w * (1 - sideOverlap);
  const frontSpacing = fp.h * (1 - frontOverlap);

  const vBlur = maxSpeedForBlur(gsd, shutterSec, blurPx);
  const vInterval = maxSpeedForInterval(frontSpacing, minIntervalSec);

  // Jarak jalur dan jarak foto SENGAJA tetap memakai geometri nadir, meski
  // kameranya miring. Bukan kelalaian:
  //
  // Frame miring itu trapesium sedalam ratusan meter, dan sebagian besar
  // kedalamannya terlalu kasar untuk dipakai (tepi jauh 11 cm/px). Kalau
  // jaraknya dilebarkan sampai overlap "pas 80%" dari trapesium penuh, yang
  // dijarangkan justru bagian dekat-tengah — satu-satunya bagian yang
  // berguna. Memakai footprint nadir menghasilkan overlap efektif yang lebih
  // tinggi dari yang diminta (79% samping / 93% depan pada -45°), dan itu
  // memang yang dipakai perencana komersial.
  //
  // Yang TIDAK boleh ikut nadir adalah angka yang dibaca orang. Itu di bawah.
  const surface = surfaceGsd(cam, altitude, gimbalPitchDeg);

  return {
    altitude,
    // GSD nadir. Inilah dasar jarak jalur dan jarak foto, dan inilah angka
    // yang dulu ditampilkan ke layar meski polanya miring.
    gsd,
    // GSD yang benar-benar mendarat di permukaan. Untuk pola nadir dua-duanya
    // sama; untuk pola miring, INI yang harus ditampilkan.
    surfaceGsd: surface.centerCm,
    surface,
    gimbalPitchDeg,
    oblique: Math.abs(gimbalPitchDeg) < 85,
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

    // Satu waypoint per foto, untuk kedua mode.
    //
    // Dulu mode "jalan terus" cuma menaruh dua waypoint per jalur dan
    // menyerahkan pemotretan ke perintah jepret-per-jarak. File seperti itu
    // ditolak DJI Fly, dan tidak ada satu pun contoh nyata — baik file buatan
    // DJI Fly sendiri maupun generator pihak ketiga — yang memakai perintah
    // interval. Yang dipakai keduanya: aksi ambil foto di setiap titik.
    //
    // Bedanya dua mode sekarang bukan jumlah waypoint, melainkan apakah drone
    // berhenti sejenak di tiap titik (hoverTime) atau melintas terus.
    for (let i = 0; i < shotsOnLine; i++) {
      const t = i / (shotsOnLine - 1);
      waypoints.push({
        xy: unrot([a[0] + (b[0] - a[0]) * t, seg.y]),
        heading,
        takePhoto: true,
        photos: 1,
      });
    }
  }

  return { lines, waypoints, photos };
}

/**
 * Pola terbang di atas satu poligon.
 *
 *   single        — satu arah. Cukup untuk ortofoto / peta datar.
 *   cross         — ditambah jalur menyilang 90°. Objek tegak terpotret dari
 *                   dua arah, jadi model 3D-nya tidak bolong di sisi yang
 *                   tidak pernah menghadap kamera.
 *   crossOblique  — cross, tapi kamera dimiringkan. Ini yang menangkap dinding
 *                   tegak; cross saja dengan kamera nunduk lurus masih tipis.
 *                   Tapi dia kehilangan nadirnya — lihat building3d.
 *   building3d    — nadir + dua lintasan miring menyilang dalam SATU misi.
 *                   Masih dipahami engine, tapi tidak lagi ditawarkan di layar.
 *
 * Soal nadir, dan kenapa akhirnya dipisah. Di crossOblique tidak ada satu pun
 * foto yang menunduk lurus: atap cuma kena dari serong, dan tidak ada frame
 * yang mengikat skala tanah. Jawaban pertamanya building3d — nadir dan miring
 * digabung jadi tiga lintasan dalam satu misi.
 *
 * Pernah dicoba memecahnya jadi dua POLA terpisah, dengan alasan baterai:
 * tiga lintasan berarti 408 foto dan 42 menit di lahan 3.49 ha. Itu keliru
 * tempat. Yang berat bukan rencananya — yang berat filenya, karena dipotong
 * di titik ke-200 yang kebetulan, bukan di batas lintasan.
 *
 * Dua pola terpisah juga menyerahkan hal yang tidak boleh diserahkan: pengguna
 * harus mengingat sendiri bahwa misi keduanya memakai area, ketinggian,
 * overlap, dan TITIK LEPAS LANDAS yang sama. Ketinggian WPML relatif terhadap
 * titik lepas landas, jadi berdiri di tempat lain membuat kedua set foto tidak
 * nyambung. Satu rencana menjamin semuanya identik; dua rencana memindahkan
 * jaminan itu ke ingatan orang.
 *
 * Jadi yang dipecah sekarang bukan polanya, melainkan FILE-nya: satu file per
 * lintasan (lihat splitByPass). Satu rencana, tiga file, masing-masing satu
 * baterai, masing-masing bisa diterbangkan ulang sendiri kalau gagal. Foto
 * nadir dan foto miring tetap digabung di software olah, bukan di file misi.
 *
 * `passSpecs` menggantikan pasangan (passes, gimbalPitch) yang lama: tiap
 * lintasan membawa pergeseran arahnya sendiri DAN sudut gimbalnya sendiri.
 * Tanpa itu, satu angka gimbal dipasang ke semua titik dan nadir tidak mungkin
 * dicampur dengan miring dalam satu misi.
 *
 * Ongkosnya nyata: tiap lintasan tambahan melipatkan foto, waktu, dan jumlah
 * baterai. Pemanggil wajib menampilkan itu sebelum berangkat.
 */
export const PATTERNS = {
  single: {
    id: 'single',
    name: 'Peta datar',
    passes: 1,
    gimbalPitch: -90,
    passSpecs: [{ angleOffset: 0, gimbalPitch: -90 }],
  },
  cross: {
    id: 'cross',
    name: 'Silang',
    passes: 2,
    gimbalPitch: -90,
    passSpecs: [
      { angleOffset: 0, gimbalPitch: -90 },
      { angleOffset: 90, gimbalPitch: -90 },
    ],
  },
  crossOblique: {
    id: 'crossOblique',
    name: 'Miring saja',
    passes: 2,
    gimbalPitch: -45,
    passSpecs: [
      { angleOffset: 0, gimbalPitch: -45 },
      { angleOffset: 90, gimbalPitch: -45 },
    ],
  },
  building3d: {
    id: 'building3d',
    name: '3D bangunan',
    passes: 3,
    // Angka wakil untuk ditampilkan; yang benar-benar dipakai ada di passSpecs,
    // dan karena itulah pola ini mengunci slider gimbal manual.
    gimbalPitch: -45,
    mixedGimbal: true,
    passSpecs: [
      { angleOffset: 0, gimbalPitch: -90, role: 'nadir' },
      { angleOffset: 0, gimbalPitch: -45, role: 'miring' },
      { angleOffset: 90, gimbalPitch: -45, role: 'miring' },
    ],
  },
  // Orbit tidak punya "lintasan" dan tidak punya satu sudut gimbal: tiap
  // cincin punya pitch-nya sendiri. Dia ada di daftar ini supaya UI bisa
  // menamainya seperti pola lain, tapi jalurnya dibuat generateOrbit —
  // yang butuh profil kamera dan titik pusat, dua hal yang tidak dimiliki
  // generatePattern.
  orbit: { id: 'orbit', name: 'Orbit objek', passes: 0, gimbalPitch: -45, object: true },
};

export function generatePattern(polyXY, o) {
  const { pattern = 'single', angleDeg = 0, ...rest } = o;
  if (PATTERNS[pattern]?.object) {
    throw new Error(
      `Pola "${pattern}" mengelilingi objek, bukan melintasi lahan — pakai generateOrbit(cam, centerXY, ...), bukan generatePattern().`
    );
  }
  const spec = PATTERNS[pattern] ?? PATTERNS.single;
  const specs = spec.passSpecs ?? [{ angleOffset: 0, gimbalPitch: spec.gimbalPitch }];

  // Hanya pola yang BENAR-BENAR mencampur sudut gimbal yang menuliskannya
  // per titik. Untuk pola bersudut seragam, titiknya sengaja dibiarkan kosong
  // supaya slider gimbal manual di UI tetap berlaku — kalau diisi di sini,
  // setelan pengguna akan ditimpa diam-diam.
  const mixed = new Set(specs.map((x) => x.gimbalPitch)).size > 1;

  const lines = [];
  const waypoints = [];
  const passes = [];
  let photos = 0;

  specs.forEach((ps, i) => {
    const ang = angleDeg + ps.angleOffset;
    const g = generateGrid(polyXY, { ...rest, angleDeg: ang });
    for (const w of g.waypoints) {
      w.pass = i;
      if (mixed) w.gimbalPitch = ps.gimbalPitch;
    }
    lines.push(...g.lines);
    waypoints.push(...g.waypoints);
    photos += g.photos;
    passes.push({
      index: i,
      angleDeg: ((ang % 360) + 360) % 360,
      gimbalPitch: ps.gimbalPitch,
      role: ps.role ?? null,
      photos: g.photos,
      waypoints: g.waypoints.length,
      lines: g.lines,
    });
  });

  return {
    lines,
    waypoints,
    photos,
    passes,
    pattern: spec.id,
    gimbalPitch: spec.gimbalPitch,
    mixedGimbal: mixed,
    // Sudut gimbal unik yang benar-benar dipakai, untuk ditampilkan dan
    // dipakai gerbang keselamatan.
    gimbalPitches: [...new Set(specs.map((x) => x.gimbalPitch))],
  };
}

/**
 * Dari waypoint terdekat ke titik terakhir yang diketahui, mundur ke titik
 * mulai yang aman.
 *
 * Kenapa harus mundur: titik terakhir yang diketahui — entah dari EXIF foto
 * atau dari ketukan di peta — jatuh di suatu tempat SETELAH jepretan terakhir
 * yang berhasil. Kalau jalur dipotong tepat di waypoint terdekat, ada
 * kemungkinan satu petak tidak pernah terpotret dan juga tidak diulang. Lubang
 * itu baru ketahuan waktu olah data di rumah, saat drone sudah dikemas.
 * Mengulang satu foto itu murah; lubang di ortofoto tidak.
 *
 * SEJARAH, karena ini sumber bug yang nyata. Dulu fungsi ini bercabang: mode
 * "jalan terus" cuma menaruh DUA waypoint per jalur (pangkal dan ujung) dan
 * menyerahkan pemotretan ke perintah jepret-per-jarak, jadi mundurnya dihitung
 * dengan paritas — ganjil berarti ujung jalur, mundur ke pangkalnya.
 *
 * Perintah jepret-per-jarak sudah dibuang: file yang memakainya ditolak DJI
 * Fly, dan sekarang KEDUA mode menaruh satu waypoint per foto (lihat catatan
 * di generateGrid). Tapi cabang paritasnya tidak ikut dibuang. Akibatnya di
 * mode tanpa jeda, mundurnya jadi 0 atau 1 waypoint tergantung ganjil-genap
 * nomor urut — angka yang tidak lagi berarti apa-apa, dan tidak ketahuan
 * karena fungsi ini hidup di web/app.js, di luar jangkauan npm test.
 *
 * Sekarang: satu waypoint = satu foto di kedua mode, jadi mundurnya satu
 * waypoint di kedua mode. Tidak ada lagi yang perlu dibedakan.
 */
export function resumeIndexFor(waypoints, nearest) {
  if (nearest <= 0) return 0;
  return nearest - 1;
}

/**
 * Laju naik-turun yang dituntut jalur, dalam m/s.
 *
 * Kenapa ini penting: saat mengikuti kontur, ketinggian perintah berubah tiap
 * waypoint. Kalau lerengnya curam dan kecepatan jelajahnya tinggi, drone
 * diminta naik lebih cepat dari kemampuan vertikalnya. Dia tidak akan menolak
 * — dia cuma tertinggal, dan makin lama makin rendah dari rencana. Itu
 * kegagalan yang tidak kelihatan di layar sampai drone menyentuh sesuatu.
 */
export function climbDemand(waypoints, speed) {
  let max = 0;
  let maxAt = -1;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    if (a.height === undefined || b.height === undefined) continue;
    const dist = Math.hypot(b.xy[0] - a.xy[0], b.xy[1] - a.xy[1]);
    if (dist < 1) continue;
    const rate = (Math.abs(b.height - a.height) / dist) * speed;
    if (rate > max) {
      max = rate;
      maxAt = i;
    }
  }
  return { rateMs: max, atIndex: maxAt };
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

/**
 * Kecepatan tertinggi yang BENAR-BENAR tercapai di satu ruas, kalau drone
 * berhenti di kedua ujungnya.
 *
 * Drone mempercepat sampai setengah jalan lalu langsung mengerem, jadi
 * puncaknya v = akar(a x d) — bukan kecepatan jelajah yang diperintahkan.
 * Pada ruas 15 m dengan percepatan 2.5 m/s2, puncaknya 6.1 m/s: memerintahkan
 * 15 m/s tidak mengubah apa pun.
 *
 * Ini bukan detail akademis. Selama ini layar menampilkan 15.0 m/s sebagai
 * "Kecepatan" untuk misi stop-and-shoot, tepat di bawah catatan yang menyebut
 * batas blur 12.5 dan batas jeda jepret 7.6 — tiga angka yang saling
 * bertentangan, dan tidak satu pun menggambarkan yang sebenarnya terjadi.
 */
export function peakSpeedOverLeg(distM, vmax, accel = 2.5) {
  if (distM <= 0) return 0;
  return Math.min(vmax, Math.sqrt(accel * distM));
}

/**
 * Panjang ruas yang mewakili jalur ini (median).
 *
 * Median, bukan rata-rata: jalur survei punya beberapa ruas panjang di ujung
 * jalur dan antar lintasan, dan rata-rata ikut tertarik olehnya. Yang ingin
 * diketahui adalah ruas yang dialami drone sebagian besar waktu.
 */
export function medianLegM(waypoints) {
  if (!waypoints || waypoints.length < 2) return 0;
  const d = [];
  for (let i = 1; i < waypoints.length; i++) {
    d.push(Math.hypot(
      waypoints[i].xy[0] - waypoints[i - 1].xy[0],
      waypoints[i].xy[1] - waypoints[i - 1].xy[1]
    ));
  }
  d.sort((a, b) => a - b);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
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
    // `arc` menandai titik di jalur melingkar: arah hadapnya memang berubah
    // terus, tapi drone tidak pernah berhenti dan berbelok — dia memutar mulus
    // sambil melaju. Tanpa pengecualian ini, orbit kena denda belokan di tiap
    // titik dan estimasi waktunya jadi berlipat-lipat dari kenyataan.
    const isTurn = !stopAtEach && !b.arc && a.heading !== b.heading;
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
    // Batas jumlah waypoint per misi. Sejak tiap foto butuh waypoint-nya
    // sendiri, inilah yang lebih dulu kena di lahan luas — bukan baterai.
    // Melewatinya berarti file ditolak, jadi pembagiannya ikut memotong di
    // sini, bukan cuma memperingatkan setelah terlanjur.
    maxWaypoints = Infinity,
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
      const isTurn = !stopAtEach && !wp.arc && prev.heading !== wp.heading;
      cost += legTime(d, speed, accel, stopAtEach || isTurn);
      if (isTurn) cost += turnPenalty(speed, accel);
    }
    if (wp.takePhoto) cost += hoverPerPhotoSec;

    if (current.length && (elapsed + cost > budget || current.length >= maxWaypoints)) {
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

/** Bagi daftar jadi n potongan sama besar, selisih maksimal satu elemen. */
function bagiRata(arr, n) {
  const out = [];
  const dasar = Math.floor(arr.length / n);
  const sisa = arr.length % n;
  let i = 0;
  for (let j = 0; j < n; j++) {
    const ukuran = dasar + (j < sisa ? 1 : 0);
    out.push(arr.slice(i, i + ukuran));
    i += ukuran;
  }
  return out;
}

/**
 * Pecah jalur jadi beberapa file: per PERAN dulu, baru per baterai.
 *
 * Peran, bukan lintasan. Bedanya nyata, dan ini sudah salah dua kali.
 *
 * Percobaan pertama memakai splitByBattery apa adanya: rakus, memotong di mana
 * pun jatah waktu atau batas 200 waypoint habis. Di pola banyak lintasan
 * potongan itu jatuh di tengah lintasan — lahan 6.15 ha jadi 198/195/194/43,
 * satu file mencampur gimbal -90 dan -45, dan file terakhir berisi 43 foto.
 *
 * Percobaan kedua memotong per LINTASAN. Campurannya hilang, tapi karena tiap
 * lintasan 210 titik sementara batasnya 200, tiap lintasan pecah jadi 105+105:
 * enam file, dan tiap penerbangan cuma memakai 48% baterai. Enam kali lepas
 * landas untuk pekerjaan yang muat empat. Itu lebih buruk, cuma buruknya di
 * dimensi lain.
 *
 * Sekarang per PERAN. Dua lintasan miring punya setelan kamera yang sama —
 * cuma arah lintasannya menyilang — jadi tidak ada gunanya memisahkan
 * keduanya. Yang berguna dipisahkan cuma nadir dari miring, karena itu memang
 * dua hal yang berbeda bagi orang yang menerbangkannya. Lahan 6.15 ha jadi:
 *
 *   nadir    105 + 105
 *   miring   140 + 140 + 140
 *
 * Lima file, baterai kepakai 66%, dan lahan kecil (di bawah ~2.5 ha) jadi
 * tepat dua file: satu nadir, satu miring. Minimum mutlaknya empat file
 * (630 foto / batas 200), jadi pemisahan peran ini berongkos satu file.
 *
 * Pola yang TIDAK punya peran — peta datar, miring saja, orbit — tidak
 * dikelompokkan sama sekali: satu kelompok, dibagi rata. Mengelompokkan orbit
 * per sudut gimbal akan memecah tiap cincin jadi filenya sendiri, dan itu
 * jelas bukan yang diinginkan.
 *
 * @returns {{sorties: Array<Array<object>>, meta: Array<{role:string|null, part:number, parts:number}>}}
 */
export function splitByRole(waypoints, o) {
  // Kelompokkan menurut peran, menjaga urutan terbang. Peran yang sama dan
  // BERURUTAN menyatu dengan sendirinya karena kelompok baru hanya dimulai
  // saat perannya berganti — jadi dua lintasan miring yang bersebelahan jadi
  // satu kelompok, sementara urutan nadir-lalu-miring tetap terjaga.
  const peranDari = (w) => o.roleOfPass?.[w.pass] ?? null;
  const adaPeran = waypoints.some((w) => peranDari(w) !== null);

  const groups = [];
  for (const w of waypoints) {
    const key = adaPeran ? peranDari(w) : null;
    let g = groups[groups.length - 1];
    if (!g || g.role !== key) {
      g = { role: key, waypoints: [] };
      groups.push(g);
    }
    g.waypoints.push(w);
  }

  const sorties = [];
  const meta = [];
  for (const g of groups) {
    // splitByBattery itu rakus: dia mengisi sampai jatah waktu atau batas
    // waypoint habis, baru memulai file berikutnya. Untuk batas BATERAI itu
    // memang yang benar — kamu ingin memakai baterainya sampai habis.
    //
    // Untuk batas WAYPOINT tidak. Lintasan 215 titik dengan batas 200 jadi
    // 200 + 15: file kedua berisi lima belas foto, satu siklus baterai penuh
    // untuk terbang ke lokasi, menjepret lima belas kali, lalu pulang. Dan di
    // pola tiga lintasan itu terjadi TIGA KALI.
    //
    // Jadi begitu sebuah lintasan ternyata butuh lebih dari satu file, isinya
    // dibagi rata: 215 jadi 108 + 107. Aman terhadap jatah baterai karena tiap
    // bagian rata selalu <= bagian pertama hasil pembagian rakus, dan bagian
    // itu sudah muat.
    const rakus = splitByBattery(g.waypoints, o);
    const parts = rakus.length > 1 ? bagiRata(g.waypoints, rakus.length) : rakus;
    parts.forEach((part, i) => {
      sorties.push(part);
      meta.push({ role: g.role, part: i, parts: parts.length });
    });
  }
  return { sorties, meta };
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

// ---------- Orbit: objek tegak ----------
//
// Pola grid di atas hanya cocok untuk permukaan yang terhampar: dia terbang
// MELINTAS di atas lahan dengan kamera menunduk. Tugu, menara, patung, cerobong
// — objek yang sempit tapi tinggi — informasinya ada di dinding vertikal, dan
// dinding itu nyaris tidak pernah menghadap kamera yang menunduk dari atas.
//
// Yang dibutuhkan objek begitu adalah MENGELILINGI: drone memutari satu sumbu,
// kamera selalu menghadap ke dalam, diulang di beberapa tingkat ketinggian.
// Tiap cincin membidik pita ketinggian yang berbeda di objek, dari dekat kaki
// sampai dekat puncak.
//
// Dua hal yang berubah mendasar dibanding grid, dan keduanya sumber kesalahan
// kalau diabaikan:
//
//   1. GSD tidak lagi ditentukan ketinggian terbang, melainkan JARAK MIRING
//      dari kamera ke permukaan objek. Cincin yang tinggi dan curam duduk
//      lebih jauh dari dinding daripada angka radiusnya, jadi GSD-nya lebih
//      kasar meski radius orbitnya sama.
//
//   2. Arah hadap drone tidak bisa followWayline. Di grid, menghadap arah
//      jalur itu persis yang benar. Di orbit, menghadap arah jalur berarti
//      kamera menyorot tangensial — objeknya lewat di pinggir frame, bukan di
//      tengah. Tiap titik butuh sudut hadapnya sendiri.

const DEG = Math.PI / 180;

export const ORBIT_DEFAULTS = {
  rings: 4,
  overlap: 0.8,
  // Langkah sudut: inilah yang sebenarnya menentukan kerapatan di orbit.
  // 10 derajat = 36 foto per cincin, angka yang lazim dipakai orang memindai
  // patung dan menara.
  maxAngleStepDeg: 10,
  aimLowFrac: 0.15,
  aimHighFrac: 0.9,
  minPitchDeg: 5,
  maxPitchDeg: 45,
  // Lantai ketinggian cincin. Pada objek pendek, sudut bidik yang hampir
  // mendatar menaruh cincin terbawah di 4-5 m — ketinggian pohon, tiang
  // lampu, dan kabel, tempat sensor rintangan paling tidak bisa diandalkan.
  minRingHeightM: 8,
  minPhotosPerRing: 12,
  maxPhotosPerRing: 90,
  cap: true,
  capOverlap: 0.8,
};

/**
 * Geometri satu cincin orbit.
 *
 * Drone duduk di ketinggian `height`, kamera dimiringkan `pitchDeg`, dan garis
 * bidiknya memotong sumbu objek di ketinggian `aimHeightM`. Ketiganya saling
 * terkunci — begitu pitch dan titik bidik dipilih, ketinggian drone tidak lagi
 * bebas:
 *
 *     height = aimHeight + radius * tan(|pitch|)
 *
 * Tanpa kunci ini, cincin yang curam akan membidik langit di atas puncak tugu
 * atau tanah di depan kakinya, dan tidak ada yang memberitahu di layar.
 */
export function orbitRing(cam, { radiusM, aimHeightM, pitchDeg, overlap = 0.8, minHeightM = 0 }) {
  let rise = radiusM * Math.tan(Math.abs(pitchDeg) * DEG);
  let height = aimHeightM + rise;
  let pitch = pitchDeg;

  // Lantai ketinggian. Yang dinaikkan drone-nya, BUKAN titik bidiknya: kalau
  // titik bidik ikut naik, pita terbawah objek tidak pernah terpotret oleh
  // cincin mana pun. Jadi drone naik dan kameranya menunduk lebih curam,
  // tetap menatap pita yang sama.
  if (height < minHeightM) {
    height = minHeightM;
    rise = height - aimHeightM;
    pitch = -(Math.atan2(rise, radiusM) / DEG);
  }

  const slantM = Math.hypot(radiusM, rise);

  const gsdCm = gsdFromAltitude(cam, slantM);
  const fp = footprint(cam, slantM);

  // Lebar frame menyapu mendatar sepanjang keliling, jadi yang menentukan
  // jarak antar jepretan adalah sisi lebar foto — bukan sisi tingginya.
  const stepM = fp.w * (1 - overlap);

  return {
    radiusM,
    aimHeightM,
    pitchDeg: pitch,
    raisedToFloor: pitch !== pitchDeg,
    rise,
    height,
    slantM,
    gsdCm,
    footprint: fp,
    stepM,
  };
}

/**
 * Jalur orbit bertingkat mengelilingi satu titik.
 *
 * @param {object} cam profil kamera (lihat cameraOf)
 * @param {[number,number]} centerXY sumbu objek dalam meter
 * @param {object} o
 * @param {number} o.radiusM jarak mendatar drone ke sumbu objek
 * @param {number} o.objectHeightM tinggi objek dari dasar
 * @param {number} o.rings jumlah cincin
 * @param {number} o.overlap overlap antar foto berurutan dalam satu cincin
 * @param {boolean} o.cap tambahkan petak nadir di atas untuk puncak dan tanah
 */
export function generateOrbit(cam, centerXY, o) {
  const {
    radiusM,
    objectHeightM,
    rings = ORBIT_DEFAULTS.rings,
    overlap = ORBIT_DEFAULTS.overlap,
    aimLowFrac = ORBIT_DEFAULTS.aimLowFrac,
    aimHighFrac = ORBIT_DEFAULTS.aimHighFrac,
    minPitchDeg = ORBIT_DEFAULTS.minPitchDeg,
    maxPitchDeg = ORBIT_DEFAULTS.maxPitchDeg,
    minRingHeightM = ORBIT_DEFAULTS.minRingHeightM,
    maxAngleStepDeg = ORBIT_DEFAULTS.maxAngleStepDeg,
    minPhotosPerRing = ORBIT_DEFAULTS.minPhotosPerRing,
    maxPhotosPerRing = ORBIT_DEFAULTS.maxPhotosPerRing,
    cap = ORBIT_DEFAULTS.cap,
    capOverlap = ORBIT_DEFAULTS.capOverlap,
  } = o;

  const waypoints = [];
  const ringInfo = [];
  const circles = [];
  let photos = 0;

  for (let i = 0; i < rings; i++) {
    const t = rings === 1 ? 0.5 : i / (rings - 1);
    const aimHeightM = objectHeightM * (aimLowFrac + (aimHighFrac - aimLowFrac) * t);
    const pitchDeg = -(minPitchDeg + (maxPitchDeg - minPitchDeg) * t);

    const g = orbitRing(cam, {
      radiusM,
      aimHeightM,
      pitchDeg,
      overlap,
      minHeightM: minRingHeightM,
    });

    const circumference = 2 * Math.PI * radiusM;

    // Dua batas, dan yang mengikat hampir selalu yang kedua.
    //
    // Pertama, overlap frame: foto berikutnya harus masih bertampalan dengan
    // yang sebelumnya. Ini batas yang sama seperti di grid.
    //
    // Kedua — dan ini yang sering terlewat — SUDUT PANDANG. Begitu drone
    // bergeser sejauh s di keliling, sudut dia memandang objek berubah s/R
    // radian. Kalau perubahan sudut itu terlalu besar, dinding yang sama
    // terlihat terlalu berbeda di dua foto berurutan dan software tidak bisa
    // mencocokkannya, berapa pun overlap frame-nya.
    //
    // Di objek sempit, frame jauh lebih lebar daripada objeknya: pada radius
    // 18 m frame-nya 27 m sementara tugunya cuma 5 m. Overlap frame 80% di
    // situ cuma menghasilkan 21 foto per cincin dengan loncatan sudut 17
    // derajat — angka di layar kelihatan sehat, hasilnya tetap gagal
    // menyambung. Jadi batas sudutlah yang dipegang.
    const byOverlap = Math.ceil(circumference / g.stepM);
    const byAngle = Math.ceil(360 / maxAngleStepDeg);
    const count = Math.min(
      maxPhotosPerRing,
      Math.max(minPhotosPerRing, byOverlap, byAngle)
    );

    const ringPts = [];
    for (let k = 0; k < count; k++) {
      const ang = (2 * Math.PI * k) / count; // 0 = utara dari pusat
      const xy = [
        centerXY[0] + radiusM * Math.sin(ang),
        centerXY[1] + radiusM * Math.cos(ang),
      ];
      // Menghadap ke dalam: kebalikan dari arah pusat ke drone.
      const heading = (ang / DEG + 180) % 360;

      ringPts.push(xy);
      waypoints.push({
        xy,
        heading,
        height: g.height,
        gimbalPitch: Number(g.pitchDeg.toFixed(1)),
        takePhoto: true,
        photos: 1,
        ring: i,
        // Dipakai estimasi waktu: di orbit arah hadap berubah di SETIAP titik,
        // dan itu bukan belokan — drone memutar mulus sambil melaju. Tanpa
        // penanda ini, tiap titik kena denda belokan dan estimasinya meledak.
        arc: true,
        poi: true,
      });
    }

    photos += count;
    circles.push(ringPts);
    ringInfo.push({
      index: i,
      photos: count,
      heightM: g.height,
      aimHeightM: g.aimHeightM,
      pitchDeg: Number(g.pitchDeg.toFixed(1)),
      raisedToFloor: g.raisedToFloor,
      slantM: g.slantM,
      gsdCm: g.gsdCm,
      stepM: g.stepM,
      spacingM: circumference / count,
      angleStepDeg: 360 / count,
      overlapActual: 1 - circumference / count / g.footprint.w,
      limitedBy: byAngle >= byOverlap ? 'sudut' : 'overlap',
    });
  }

  // Petak nadir di atas: puncak objek dan tanah di sekelilingnya. Dua-duanya
  // tidak pernah tertangkap cincin yang membidik mendatar, dan tanah itulah
  // yang mengikat skala seluruh model.
  let capInfo = null;
  if (cap) {
    const capHeight = objectHeightM + radiusM;
    const capGsd = gsdFromAltitude(cam, capHeight);
    const fp = footprint(cam, capHeight);
    const half = radiusM;
    const square = [
      [centerXY[0] - half, centerXY[1] - half],
      [centerXY[0] + half, centerXY[1] - half],
      [centerXY[0] + half, centerXY[1] + half],
      [centerXY[0] - half, centerXY[1] + half],
    ];

    const grid = generateGrid(square, {
      angleDeg: 0,
      sideSpacing: fp.w * (1 - capOverlap),
      frontSpacing: fp.h * (1 - capOverlap),
      mode: 'stopAndShoot',
    });

    for (const w of grid.waypoints) {
      w.height = capHeight;
      w.gimbalPitch = -90;
      w.ring = 'cap';
    }

    waypoints.push(...grid.waypoints);
    photos += grid.photos;
    capInfo = {
      heightM: capHeight,
      gsdCm: capGsd,
      photos: grid.photos,
      sideM: 2 * half,
      lines: grid.lines,
    };
  }

  const gsds = ringInfo.map((r) => r.gsdCm);

  return {
    waypoints,
    photos,
    rings: ringInfo,
    circles,
    cap: capInfo,
    centerXY,
    radiusM,
    objectHeightM,
    gsdBestCm: Math.min(...gsds),
    gsdWorstCm: Math.max(...gsds),
    // Bentuknya disamakan dengan generatePattern supaya pemanggil (plan,
    // safety, export) tidak perlu bercabang di mana-mana.
    lines: circles.map((c) => [...c, c[0]]),
    pattern: 'orbit',
    passes: ringInfo.map((r) => ({
      index: r.index,
      angleDeg: 0,
      photos: r.photos,
      waypoints: r.photos,
      lines: [],
    })),
    gimbalPitch: ringInfo.length ? ringInfo[0].pitchDeg : -45,
  };
}

/**
 * Radius orbit yang dibutuhkan untuk mencapai GSD tertentu di dinding objek.
 *
 * Dipakai terbalik dari grid: di sana pengguna memilih GSD lalu kami hitung
 * ketinggian; di sini pengguna memilih GSD lalu kami hitung jarak. Yang
 * dihitung jarak MIRING, lalu diproyeksikan balik jadi radius mendatar pada
 * sudut pitch tertentu.
 */
export function orbitRadiusForGsd(cam, gsdCm, pitchDeg = 20) {
  const slant = altitudeFromGsd(cam, gsdCm);
  return slant * Math.cos(Math.abs(pitchDeg) * DEG);
}
