// Gerbang keselamatan.
//
// Semua pemeriksaan rencana terbang berkumpul di satu tempat supaya tidak ada
// yang lolos diam-diam. Aturannya:
//
//   'bad'  — bisa membuat drone hilang atau file ditolak. Export ditahan
//            sampai pengguna mencentang bahwa dia sadar.
//   'warn' — hasilnya jelek atau misinya tidak efisien. Lewat saja boleh.
//   'info' — konsekuensi yang perlu diketahui, bukan masalah.
//
// Aplikasi tidak pernah diam-diam membetulkan angka pengguna. Kalau ada yang
// dibatasi, itu harus muncul di sini sebagai kalimat, bukan dipotong di
// belakang layar.

import { climbDemand } from './survey.js';

const pct = (v) => `${Math.round(v * 100)}%`;

export function evaluateSafety(plan, profile, o = {}) {
  const out = [];
  const lim = profile.limits;
  const adv = plan.advanced ?? {};

  const add = (level, code, text) => out.push({ level, code, text });

  // ---- Identitas drone & format file ----

  if (profile.waypoint?.supported === false) {
    add(
      'bad',
      'no-waypoint',
      `${profile.name} tidak mendukung waypoint mission di DJI Fly. File-nya bisa dibuat, tapi drone tidak akan menerimanya.`
    );
  }

  // Kode drone sekarang selalu ada isinya, jadi yang dinilai bukan "ada atau
  // tidak" melainkan "dari mana asalnya". Cuma yang benar-benar tidak punya
  // dasar yang menahan export; sisanya cukup diberitahu.
  if (profile.enumConfidence === 'unknown') {
    add(
      'bad',
      'enum-unknown',
      `Tidak ada kode drone untuk ${profile.name}. Bikin satu waypoint mission di DJI Fly, export KMZ-nya, lalu impor di sini — tanpa itu file ini kemungkinan besar ditolak.`
    );
  } else if (profile.enumConfidence === 'observed-family') {
    add(
      'warn',
      'enum-borrowed',
      `Kode drone ${profile.droneEnumValue}/${profile.droneSubEnumValue} yang dipakai untuk ${profile.name} dipinjam dari model lain selini — belum pernah terlihat keluar dari DJI Fly di model ini sendiri. Kemungkinan besar benar, tapi kalau DJI Fly menolak file ini, inilah tersangka pertamanya. Impor satu KMZ asli untuk menguncinya.`
    );
  } else if (profile.enumConfidence === 'observed-model') {
    add(
      'info',
      'enum-observed',
      `Kode drone ${profile.droneEnumValue}/${profile.droneSubEnumValue} diambil dari laporan KMZ buatan DJI Fly di ${profile.name}, bukan dari file drone kamu sendiri. Impor KMZ asli kalau mau benar-benar yakin.`
    );
  }

  // ---- Ketinggian ----

  if (plan.altitude > lim.maxAltitudeM) {
    add(
      'bad',
      'alt-over',
      `Ketinggian ${plan.altitude.toFixed(0)} m melewati batas ${lim.maxAltitudeM} m. Perhalus GSD, atau area ini butuh izin khusus.`
    );
  }

  if (plan.altitude < (lim.takeOffSecurityHeightM ?? 20)) {
    add(
      'warn',
      'alt-low',
      `Ketinggian ${plan.altitude.toFixed(0)} m di bawah ketinggian aman lepas landas (${lim.takeOffSecurityHeightM} m). Pohon, tiang, dan kabel ada di ketinggian ini.`
    );
  }

  // ---- Jarak & VLOS ----

  if (plan.maxDist > 500) {
    add(
      plan.maxDist > 1500 ? 'bad' : 'warn',
      'vlos',
      `Titik terjauh ${(plan.maxDist / 1000).toFixed(2)} km dari titik lepas landas. VLOS jadi sulit — geser penanda H lebih ke tengah lahan, atau bagi lahannya.`
    );
  }

  // ---- Kecepatan: blur dan jeda jepret ----

  const cam = profile.camera;
  if (!plan.stopAtEach && plan.params.recommendedSpeed < 3) {
    add(
      'warn',
      'speed-blur',
      `GSD serapat ini memaksa kecepatan turun ke ${plan.params.recommendedSpeed.toFixed(1)} m/s supaya tidak motion blur — ${
        cam.mechanicalShutter
          ? 'meski kamera ini punya mechanical shutter'
          : `${profile.name} pakai rolling shutter, jadi ini tidak bisa dipaksa`
      }. Pertimbangkan stop & shoot.`
    );
  }

  if (!plan.stopAtEach && plan.speed > plan.params.maxSpeedInterval + 0.05) {
    add(
      'bad',
      'speed-interval',
      `Mode ${profile.mode.label} butuh jeda ${cam.minIntervalSec} detik antar jepretan, jadi kecepatan maksimum cuma ${plan.params.maxSpeedInterval.toFixed(1)} m/s. Di ${plan.speed.toFixed(1)} m/s akan ada foto yang terlewat dan overlap depan bolong.`
    );
  }

  // Tidak ada satu pun contoh file nyata yang memuat tag resolusi foto —
  // baik buatan DJI Fly maupun generator pihak ketiga. Artinya resolusi
  // ditentukan setelan di DJI Fly, bukan oleh file ini. Pilihan MP di sini
  // cuma dipakai untuk hitungan; kalau tidak dicocokkan, ketelitian yang
  // dijanjikan di layar bukan ketelitian yang kamu dapat.
  {
    const mb = plan.grid.photos * (profile.mode.approxPhotoMB ?? 8);
    add(
      'warn',
      'photo-mode-manual',
      `Resolusi foto tidak ikut masuk file — setel sendiri di DJI Fly ke ${profile.mode.label} supaya cocok dengan hitungan di sini. Kalau drone menembak resolusi lain, ketelitian ${plan.params.gsd.toFixed(2)} cm/px di layar tidak berlaku. Perkiraan ruang kartu: ${mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB'} untuk ${plan.grid.photos} foto JPEG; RAW jauh lebih besar.`
    );
  }

  if (profile.mode.binned === true && plan.params.gsd < 1.5) {
    add(
      'info',
      'mp-binned',
      `${profile.mode.label} itu hasil binning — detailnya tidak sehalus angka pikselnya. Untuk GSD serapat ini, mode resolusi penuh lebih jujur, tapi jeda jepretnya lebih lama.`
    );
  }

  // ---- Waypoint & baterai ----

  const wpMax = Math.max(...plan.sorties.map((s) => s.length));
  if (wpMax > lim.maxWaypoints) {
    add(
      'warn',
      'wp-limit',
      `Satu sortie butuh ${wpMax} waypoint, melewati perkiraan batas DJI Fly (${lim.maxWaypoints}). Perkecil area atau pakai mode jalan terus.`
    );
  }

  if (plan.sorties.length > 4) {
    add(
      'warn',
      'many-sorties',
      `Butuh ${plan.sorties.length} baterai. Posisi matahari dan cuaca bisa berubah banyak selama itu — pertimbangkan membagi lahan jadi beberapa hari.`
    );
  }

  // ---- Pola terbang ----

  if (plan.pattern !== 'single') {
    add(
      'info',
      'pattern-cost',
      `Pola ${plan.patternName.toLowerCase()} menerbangkan lahan dua kali: ${plan.grid.photos} foto, ${plan.sorties.length} baterai. Kalau yang kamu butuh cuma peta datar, ini mubazir.`
    );
  }

  if (plan.pattern === 'cross' && plan.gimbalPitch === -90) {
    add(
      'info',
      'pattern-nadir',
      'Jalur menyilang dengan kamera nunduk lurus memperbaiki medan, tapi dinding tegak masih tipis terpotret. Untuk model bangunan, pakai silang + miring.'
    );
  }

  // ---- Terrain following ----

  const t = plan.terrain;
  if (t?.ready) {
    const climb = t.maxHeight - t.minHeight;
    if (climb > 60) {
      add(
        'warn',
        'terrain-climb',
        `Mengikuti kontur berarti drone naik-turun ${climb.toFixed(0)} m sepanjang misi. Boros baterai, dan pastikan tidak ada obstacle di jalur naiknya.`
      );
    }

    // Tuntutan laju naik: inilah kegagalan yang tidak kelihatan di layar.
    const demand = climbDemand(plan.grid.waypoints, plan.speed);
    const capable = lim.climbRateMs ?? 5;
    if (demand.rateMs > capable) {
      add(
        'bad',
        'climb-rate',
        `Lereng di jalur ini menuntut drone naik ${demand.rateMs.toFixed(1)} m/s pada kecepatan ${plan.speed.toFixed(1)} m/s, sementara ${profile.name} cuma sanggup sekitar ${capable} m/s. Drone akan tertinggal dari ketinggian rencananya — makin lama makin dekat ke tanah. Turunkan kecepatan ke sekitar ${((capable / demand.rateMs) * plan.speed).toFixed(1)} m/s, atau matikan ikut kontur.`
      );
    }

    const floorM = lim.takeOffSecurityHeightM ?? 20;
    if (t.minHeight < floorM) {
      add(
        'bad',
        'terrain-floor',
        `Sebagian lahan lebih rendah dari titik lepas landas — perintah ketinggian terendah jadi ${t.minHeight.toFixed(0)} m. Lepas landas dari bagian terendah lahan, bukan dari puncak.`
      );
    }

    if (t.maxHeight > lim.maxAltitudeM) {
      add(
        'bad',
        'terrain-ceiling',
        `Titik tertinggi jadi ${t.maxHeight.toFixed(0)} m di atas titik lepas landas — melewati batas ${lim.maxAltitudeM} m. Lepas landas dari tempat yang lebih tinggi, atau pecah lahannya.`
      );
    }

    add(
      'info',
      'terrain-dem',
      'Data elevasi yang dipakai resolusinya sekitar 90 m. Dia tahu bukit; dia TIDAK tahu pohon, tiang, menara, atau kabel listrik. Tetap lihat medannya dengan mata sendiri.'
    );
  } else if (!t?.on) {
    const r = plan.reliefHint;
    if (r && r.relief > plan.altitude * 0.1) {
      add(
        'warn',
        'relief',
        `Medan di area ini naik-turun ${r.relief.toFixed(0)} m. Tanpa ikuti kontur, GSD bisa meleset sampai ${pct(r.relief / plan.altitude)} antara bagian tinggi dan rendah.`
      );
    }
  }

  // ---- Rintangan dari peta bangunan ----

  if (o.obstacles?.length) {
    const worst = o.obstacles.reduce((a, b) => (a.clearanceM < b.clearanceM ? a : b));
    if (worst.clearanceM < 0) {
      add(
        'bad',
        'obstacle-hit',
        `Ada bangunan setinggi ${worst.heightM.toFixed(0)} m tepat di jalur, sementara drone terbang di ${plan.altitude.toFixed(0)} m. Naikkan ketinggian atau geser areanya.`
      );
    } else if (worst.clearanceM < 15) {
      add(
        'warn',
        'obstacle-near',
        `Jarak vertikal ke bangunan tertinggi di jalur cuma ${worst.clearanceM.toFixed(0)} m. Data bangunan OSM sering kurang tinggi dari aslinya, dan antena di atap tidak terdata sama sekali.`
      );
    }
  }

  // ---- Setelan lanjutan ----

  if (adv.rcLostAction && adv.rcLostAction !== 'goBack') {
    add(
      'bad',
      'rc-lost',
      `Saat sinyal hilang drone diset "${adv.rcLostActionLabel}". Kalau kamu kehilangan kendali di luar jangkauan pandang, satu-satunya yang membawa drone pulang adalah RTH.`
    );
  }

  if (adv.finishAction && adv.finishAction !== 'goHome') {
    add(
      adv.finishAction === 'autoLand' ? 'bad' : 'warn',
      'finish-action',
      adv.finishAction === 'autoLand'
        ? `Setelah selesai drone akan mendarat di tempat, bukan pulang. Dia akan turun di titik terakhir jalur — pastikan kamu tahu persis itu di mana dan ada apa di bawahnya.`
        : `Setelah selesai drone diset "${adv.finishActionLabel}", bukan pulang sendiri. Baterai terus terpakai selama dia menunggu.`
    );
  }

  if (adv.gimbalPitch !== undefined && adv.gimbalPitch > -30) {
    add(
      'warn',
      'gimbal-flat',
      `Gimbal ${adv.gimbalPitch}° hampir mendatar. Untuk fotogrametri, sudut sedatar ini membuat skala foto tidak seragam dan hasil olahannya melenceng.`
    );
  }

  // ---- Buffer ----

  const overhead = plan.gridArea / plan.area - 1;
  if (plan.bufferM > 0 && overhead > 0.6) {
    add(
      'info',
      'buffer-cost',
      `Buffer menambah ${pct(overhead)} luas terbang — di lahan sekecil ini buffernya proporsional besar. Turunkan ke 0.5x kalau tepi lahan tidak kritis.`
    );
  }

  if (plan.bufferM === 0) {
    add(
      'info',
      'buffer-off',
      'Buffer mati — jalur berhenti persis di batas lahan. Pinggiran ortofoto kemungkinan melengkung atau kosong. Aman kalau cuma bagian tengah yang dipakai.'
    );
  }

  // Mode tanpa jeda belum pernah terlihat di file mana pun yang kita punya.
  // Itu bukan berarti salah — cuma belum ada yang membuktikannya, dan
  // pengguna berhak tahu mana jalur yang sudah ada contohnya.
  if (!plan.stopAtEach) {
    add(
      'warn',
      'no-hover-unproven',
      'Mode tanpa jeda belum ada contoh nyatanya: baik file buatan DJI Fly maupun generator pihak ketiga selalu menaruh jeda di tiap titik. Kalau DJI Fly menolak file ini, coba dulu dengan jeda sebelum mengejar sebab lain.'
    );
  }

  if (plan.stopAtEach && plan.grid.photos > 150) {
    add(
      'info',
      'stop-slow',
      `${plan.grid.photos} foto dengan jeda di tiap titik makan waktu lama. Mode tanpa jeda lebih cepat, tapi bentuknya belum terbukti diterima.`
    );
  }

  // ---- Lanjutan misi ----

  if (plan.resume) {
    add(
      'info',
      'resume-transit',
      `Misi lanjutan dimulai dari waypoint #${plan.resume.index + 1}${
        plan.resume.backedOff > 0 ? ', satu jalur mundur dari titik terakhir supaya tidak ada petak yang bolong' : ''
      }. Drone naik dulu ke ketinggian aman, baru menyeberang ke titik itu — bukan terbang rendah melintasi area yang belum tentu kosong.`
    );

    // Titik yang jauh dari jalur biasanya berarti fotonya dari penerbangan
    // lain, atau rencananya sudah diubah sejak terbang. Dua-duanya membuat
    // nomor waypoint tidak lagi berarti apa-apa.
    if (plan.resume.snapDistM > 60) {
      add(
        'bad',
        'resume-far',
        `Titik lanjut ${plan.resume.snapDistM.toFixed(0)} m dari jalur terdekat. Kemungkinan fotonya dari penerbangan lain, atau parameter rencana sudah kamu ubah sejak terbang tadi — kalau begitu, jalurnya sudah bergeser dan "lanjut dari sini" tidak lagi nyambung dengan yang sudah terpotret.`
      );
    }
  }

  const blockers = out.filter((w) => w.level === 'bad');
  return { findings: out, blockers, ok: blockers.length === 0 };
}
