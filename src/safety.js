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

import { climbDemand, selfIntersects } from './survey.js';

const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * Tinggi jaringan listrik di Indonesia.
 *
 * KENAPA ANGKA, BUKAN DETEKSI. Pernah dipertimbangkan menarik posisi kabel dan
 * tiang dari OpenStreetMap, seperti yang sudah dilakukan untuk bangunan. Itu
 * dibatalkan, dan bukan karena susah: cakupan OSM untuk jaringan DISTRIBUSI di
 * Indonesia — kabel di pinggir jalan kampung dan perumahan, yang justru paling
 * sering menjatuhkan drone — nyaris nol. Peta yang kosong karena datanya tidak
 * ada akan terbaca sebagai "aman", dan itu lebih berbahaya daripada tidak ada
 * peta sama sekali.
 *
 * Yang dipakai sebagai gantinya: angka yang memang sudah diketahui, plus
 * perintah melihat sendiri. Drone tidak bisa melihat kabel; manusia bisa.
 *
 * SEBERAPA PASTI ANGKA INI. Tidak terlalu, dan itu disengaja ditulis. Sumber
 * yang ada tidak seragam:
 *
 *   JTR (tegangan rendah, ke rumah)   tiang 9 m, tinggi di atas tanah ~7.5 m.
 *                                     Satu sumber menyebut tiang TR ~7.5 m.
 *   JTM (tegangan menengah 20 kV)     tiang 11-13 m (~9.2-11 m di atas tanah);
 *                                     sumber lain menyebut tiang baja 12-15 m.
 *   Tiang trafo (GTT)                 13 m — yang tertinggi di jaringan
 *                                     distribusi.
 *
 * Jurnal teknik mengutip SPLN 1997 untuk panjang tiang 9/11/13 m. Produsen
 * tiang menyebut angka yang berbeda-beda untuk peruntukan yang sama. Jadi 15 m
 * dipakai sebagai batas praktis "sudah lewat seluruh jaringan distribusi",
 * dengan margin di atas angka tertinggi yang pernah disebut sumber mana pun.
 *
 * SUTT/SUTET ADALAH KATEGORI LAIN, dan di situ saran "terbang di atasnya"
 * TIDAK berlaku. Menaranya puluhan meter, dan yang diatur justru ruang
 * bebasnya: untuk SUTET 500 kV, 22 m mendatar dari tapak menara untuk sirkit
 * tunggal dan 17 m untuk sirkit ganda. Aturan yang dirujuk pun berbeda antar
 * sumber — sebagian masih Permen ESDM 18/2015, sementara PLN menyebut Permen
 * ESDM 13/2021 — jadi angkanya disebut sebagai rujukan kasar, bukan kepastian
 * hukum. Yang benar di sana: hindari koridornya, jangan dilewati dari atas.
 */
export const JARINGAN_LISTRIK = {
  // Batas praktis: di atas ini, seluruh jaringan distribusi sudah terlewati.
  distribusiMaksM: 15,
  // Di bawah ini, drone berada tepat di ketinggian kabel dan tiang.
  tiangTertinggiM: 13,
  // Ruang bebas mendatar dari tapak menara SUTET 500 kV.
  sutetBebasM: { sirkitTunggal: 22, sirkitGanda: 17 },
};

export function evaluateSafety(plan, profile, o = {}) {
  const out = [];
  const lim = profile.limits;
  const adv = plan.advanced ?? {};

  const add = (level, code, text) => out.push({ level, code, text });

  // ---- Bentuk lahannya sendiri ----
  //
  // Didahulukan dari semua pemeriksaan lain karena kalau yang ini menyala,
  // angka-angka di bawahnya dihitung dari luas yang tidak berarti apa-apa.
  if (selfIntersects(plan.polyXY)) {
    add(
      'bad',
      'aoi-menyilang',
      'Garis batas lahannya menyilang sendiri, jadi luasnya tidak bisa dihitung — yang tampil di layar 0 m², dan semua angka per hektar ikut ngawur. Jalurnya tetap terbentuk, tapi entah menutupi apa. Geser titik sudutnya supaya batasnya tidak saling memotong.'
    );
  }

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
      `Ketinggian ${plan.altitude.toFixed(0)} m di bawah ketinggian aman lepas landas (${lim.takeOffSecurityHeightM} m). Pohon dan atap ada di ketinggian ini.`
    );
  }

  // ---- Kabel dan tiang ----
  //
  // Satu-satunya rintangan yang benar-benar mematikan dan TIDAK terlihat
  // sensor drone. Tidak ada data yang bisa dipercaya untuk ini di Indonesia
  // (lihat catatan di JARINGAN_LISTRIK), jadi yang diberikan angka dan
  // perintah melihat — bukan peta yang menenangkan.
  {
    // Titik terendah yang BENAR-BENAR diperintahkan, bukan angka di slider:
    // dengan ikut kontur, bagian lahan yang lebih tinggi membuat drone turun
    // relatif terhadap tanah di bawahnya, dan di orbit tiap cincin punya
    // ketinggiannya sendiri.
    let terendah = plan.altitude;
    if (plan.orbit?.rings?.length) {
      terendah = Math.min(...plan.orbit.rings.map((r) => r.heightM));
    } else if (plan.terrain?.ready && plan.terrain.minHeight !== undefined) {
      terendah = Math.min(terendah, plan.terrain.minHeight);
    }

    const J = JARINGAN_LISTRIK;

    if (terendah <= J.tiangTertinggiM) {
      add(
        'warn',
        'kabel-setinggi-tiang',
        `Titik terendah misi ini ${terendah.toFixed(0)} m — itu persis ketinggian kabel dan tiang listrik. Tiang trafo mencapai 13 m, tiang tegangan menengah 11-13 m, dan kabel ke rumah menggantung sekitar 7-9 m. Sensor rintangan drone tidak melihat kabel. Jalan kaki dulu menyusuri jalurnya dan lihat sendiri ke atas sebelum terbang.`
      );
    } else if (terendah < J.distribusiMaksM) {
      add(
        'warn',
        'kabel-dekat-tiang',
        `Titik terendah misi ini ${terendah.toFixed(0)} m, cuma sedikit di atas tiang listrik tertinggi (13 m). Margin setipis ini habis oleh hanyutan GPS dan angin. Kalau ketelitian masih cukup, naikkan ke ${J.distribusiMaksM} m.`
      );
    }

    // Selalu muncul, apa pun ketinggiannya. Ini pengganti deteksi kabel yang
    // sengaja tidak dibuat, jadi dia tidak boleh hilang justru waktu
    // rencananya terlihat aman.
    add(
      'info',
      'kabel-lihat-sendiri',
      `Sebelum berangkat: berdiri di titik lepas landas dan lihat ke atas sepanjang jalur. Kabel listrik tidak terlihat sensor drone, tidak ada di peta, dan tidak ada di data elevasi. Di atas ${J.distribusiMaksM} m seluruh jaringan distribusi sudah terlewati — tiang tertinggi (penyangga trafo) 13 m. Yang BUKAN urusan ketinggian: SUTT dan SUTET. Menaranya puluhan meter dan yang diatur ruang bebasnya, bukan tinggi lewatnya — untuk SUTET 500 kV sekitar ${J.sutetBebasM.sirkitGanda}-${J.sutetBebasM.sirkitTunggal} m mendatar dari tapak menara. Kalau ada menara transmisi di sekitar lahan, hindari koridornya; jangan dilewati dari atas.`
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

  // Kecepatan jelajah yang tidak pernah tercapai.
  //
  // Di mode berhenti sejenak, ruas antar titik terlalu pendek untuk mencapai
  // kecepatan jelajah: drone mempercepat sampai setengah jalan lalu mengerem.
  // Angka 15.0 m/s di layar untuk misi yang titiknya berjarak 15 m itu benar
  // sebagai isi file, tapi tidak menggambarkan apa pun yang terjadi — dan
  // pernah membuat pemiliknya sendiri curiga rencananya salah.
  if (
    plan.stopAtEach &&
    plan.peakSpeedMs !== undefined &&
    plan.peakSpeedMs < plan.speed - 0.05
  ) {
    const butuh = (plan.speed * plan.speed) / (plan.accel ?? 2.5);
    add(
      'info',
      'speed-unreached',
      `Kecepatan jelajah ${plan.speed.toFixed(1)} m/s tidak pernah tercapai di misi ini. Ruas antar titik median ${plan.legMedianM.toFixed(0)} m, dan di jarak sependek itu drone cuma sempat ${plan.peakSpeedMs.toFixed(1)} m/s sebelum harus mengerem — butuh ruas ${butuh.toFixed(0)} m untuk benar-benar sampai ${plan.speed.toFixed(1)}. Angkanya tetap ditulis ke file dan memang kepakai di ruas panjang: transit ke titik awal dan pindah antar lintasan. Batas blur dan jeda jepret juga tidak berlaku di mode ini, karena drone berhenti sebelum menjepret.`
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
      `Resolusi foto tidak ikut masuk file — setel sendiri di DJI Fly ke ${profile.mode.label} supaya cocok dengan hitungan di sini. Kalau drone menembak resolusi lain, ketelitian ${(plan.params.surfaceGsd ?? plan.params.gsd).toFixed(2)} cm/px di layar tidak berlaku. Perkiraan ruang kartu: ${mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB'} untuk ${plan.grid.photos} foto JPEG; RAW jauh lebih besar.`
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
      `Satu file butuh ${wpMax} waypoint, melewati perkiraan batas DJI Fly (${lim.maxWaypoints}). Perkecil area atau pakai mode jalan terus.`
    );
  }

  if (plan.sorties.length > 4) {
    add(
      'warn',
      'many-sorties',
      `Butuh ${plan.sorties.length} file, berarti ${plan.sorties.length} penerbangan dan ${plan.sorties.length} baterai. Posisi matahari dan cuaca bisa berubah banyak selama itu — pertimbangkan membagi lahan jadi beberapa hari.`
    );
  }

  // ---- Pola terbang ----

  if (plan.pattern !== 'single' && plan.pattern !== 'orbit') {
    add(
      'info',
      'pattern-cost',
      `Pola ${plan.patternName} menerbangkan lahan ${plan.grid.passes?.length ?? 2} kali: ${plan.grid.photos} foto, ${plan.sorties.length} baterai. Kalau yang kamu butuh cuma peta datar, ini mubazir.`
    );
  }

  // ---- Ketinggian vs ukuran lahan ----
  //
  // Pemeriksaan ini lahir dari satu pertanyaan yang wajar: "lahan 1950 m²,
  // ketinggian 70 m, pola 3D — kok cuma 52 foto, 5 menit?" Angkanya benar.
  // Yang salah ketinggiannya: pada 70 m satu frame menutupi 105 x 79 m,
  // sementara lahannya 44 x 44 m. Satu jepretan saja sudah memuat seluruh
  // lahan, jadi tidak ada yang bisa dilakukan foto ke-52 selain mengulang
  // yang sama dari posisi yang nyaris sama.
  //
  // Ini bukan soal efisiensi, melainkan soal hasil: model 3D dibangun dari
  // PERBEDAAN sudut pandang antar foto. Kalau semua foto memuat seluruh
  // lahan dari ketinggian yang sama, perbedaannya tipis dan rekonstruksinya
  // ikut tipis — sementara layar tetap melaporkan "52 foto" seolah cukup.
  {
    const fp = plan.params.footprint;
    const sisi = Math.sqrt(plan.area ?? 0);
    if (fp?.w > 0 && sisi > 0 && plan.pattern !== 'orbit' && fp.w >= sisi) {
      // Jejak foto lurus sebanding dengan ketinggian, jadi ketinggian yang
      // membuat lebar jejak jadi separuh lebar lahan tinggal dihitung lurus.
      const saran = Math.max(20, Math.round(((plan.altitude * (sisi / 2)) / fp.w) / 5) * 5);
      add(
        'warn',
        'terlalu-tinggi-untuk-lahan',
        `Di ${plan.altitude.toFixed(0)} m, satu foto sudah menutupi ${fp.w.toFixed(0)} x ${fp.h.toFixed(0)} m — sementara lahannya cuma sekitar ${sisi.toFixed(0)} x ${sisi.toFixed(0)} m. Jadi tiap jepretan memuat seluruh lahan, dan foto berikutnya nyaris mengulang yang sebelumnya. Jumlah fotonya memang jadi sedikit, dan itu bukan kabar baik: model 3D dibangun dari beda sudut pandang antar foto, bukan dari banyaknya piksel. Untuk lahan sesempit ini coba turun ke sekitar ${saran} m.`
      );
    }
  }

  // ---- Buffer tepi yang ongkosnya melebihi lahannya ----
  //
  // Buffer diukur dalam KELIPATAN JARAK JALUR, dan jarak jalur tidak tahu
  // lahannya seberapa. Di sawah 10 ha, satu jarak jalur itu pinggiran tipis;
  // di petak 1950 m², satu jarak jalur (31 m) hampir selebar lahannya sendiri
  // — jadi default 1.0x bisa melipatgandakan yang diterbangkan. Angkanya
  // sudah tampil di layar, tapi tampil bukan berarti terbaca.
  if (plan.bufferM > 0 && plan.area > 0 && plan.gridArea / plan.area >= 1.8) {
    const lipat = plan.gridArea / plan.area;
    add(
      'warn',
      'buffer-kemahalan',
      `Buffer tepi membuat yang diterbangkan jadi ${lipat.toFixed(1)}x luas lahannya (${(plan.gridArea / 10000).toFixed(2)} ha dari ${(plan.area / 10000).toFixed(2)} ha)${plan.bufferCost?.photos ? `, berarti +${plan.bufferCost.photos} foto` : ''}. Di lahan kecil satu jarak jalur hampir selebar lahannya sendiri. Turunkan buffer ke 0.5x kalau tepi lahan tidak harus benar-benar tertutup.`
    );
  }

  if (plan.pattern === 'cross' && plan.gimbalPitch === -90) {
    add(
      'info',
      'pattern-nadir',
      'Jalur menyilang dengan kamera nunduk lurus memperbaiki medan, tapi dinding tegak masih tipis terpotret. Untuk model bangunan, pakai silang + miring.'
    );
  }

  // ---- Kamera miring: ketelitian yang tidak seragam dalam satu foto ----
  //
  // Ini bagian yang paling lama salah di aplikasi ini. Selama GSD dihitung
  // dari ketinggian terbang, angka di layar bukan angka yang didapat — dan
  // pengguna memilih ketinggian berdasarkan angka itu.
  const surf = plan.params.surface;
  if (surf && surf.tiltDeg > 5 && plan.pattern !== 'orbit') {
    add(
      'info',
      'oblique-gsd',
      `Kamera miring ${plan.params.gimbalPitchDeg}°, jadi jarak ke permukaan ${surf.slantM.toFixed(0)} m — bukan ${plan.altitude.toFixed(0)} m. Ketelitiannya ${surf.centerCm.toFixed(2)} cm/px di tengah frame, ${surf.nearCm.toFixed(2)} di tepi dekat, ${surf.farCm.toFixed(2)} di tepi jauh. Jarak jalur dan jarak foto tetap dihitung dari geometri nadir, dan itu disengaja: bagian frame yang berguna cuma yang dekat-tengah, jadi overlap efektifnya lebih tinggi dari yang kamu minta.`
    );

    // Gimbal yang terlalu datar: tepi jauh frame jadi tidak berguna sama
    // sekali, dan separuh foto terbuang.
    if (surf.farCm > surf.nearCm * 5) {
      add(
        'warn',
        'oblique-spread',
        `Dalam satu foto, ketelitian membentang ${surf.nearCm.toFixed(2)} sampai ${surf.farCm.toFixed(2)} cm/px — ${(surf.farCm / surf.nearCm).toFixed(1)} kali. Sudut sedatar ini membuat sebagian besar frame terlalu kasar untuk dipakai. Curamkan gimbal ke -45° atau lebih.`
      );
    }
  }

  // Pola miring tanpa nadir: atap cuma kena dari serong, dan tidak ada frame
  // yang mengikat skala tanah. Kebalikan dari pesan 'pattern-nadir' di atas,
  // dan selama ini tidak pernah dikatakan.
  if (plan.resumeBlocked === 'multiPass') {
    add(
      'info',
      'resume-multipass',
      'Titik lanjut diabaikan untuk pola banyak lintasan: filenya sudah dipecah per lintasan, jadi tidak ada satu jawaban untuk "lanjut dari mana". Kalau satu lintasan gagal di tengah, terbangkan ulang file lintasan itu saja.'
    );
  }

  if (plan.pattern === 'crossOblique') {
    add(
      'warn',
      'oblique-needs-nadir',
      `Pola ini fasad saja: semua fotonya -45°, tidak ada satu pun yang nunduk lurus. Atap dan skala tanah belum tertangkap. Terbangkan Peta datar di lahan yang sama sebagai misi kedua — titik lepas landas yang sama — lalu masukkan KEDUA set foto ke software olah dalam satu project. Tanpa itu, modelnya berdiri tapi atapnya meleleh dan ukurannya mengambang.`
    );
  }

  if (plan.pattern === 'building3d') {
    const nadir = plan.grid.passes?.find((p) => p.role === 'nadir');
    const oblique = plan.grid.passes?.filter((p) => p.role === 'miring') ?? [];
    add(
      'info',
      'building3d-shape',
      `Tiga lintasan dalam satu file: ${nadir?.photos ?? 0} foto nadir -90° untuk atap dan skala tanah, lalu ${oblique.reduce((a, p) => a + p.photos, 0)} foto miring -45° dari dua arah menyilang untuk fasad. Sudut gimbal ditulis per titik, jadi slider gimbal manual tidak berlaku untuk pola ini.`
    );

    {
      const nadir = plan.sortieMeta?.filter((m) => m.role === 'nadir').length ?? 0;
      const miring = plan.sortieMeta?.filter((m) => m.role === 'miring').length ?? 0;
      add(
        'info',
        'building3d-split',
        `Export jadi ${plan.sorties.length} file: ${nadir} berisi nadir saja, ${miring} berisi miring saja. Dipotong di batas peran, bukan di titik ke-${lim.maxWaypoints} yang kebetulan — jadi tidak ada file yang mencampur dua sudut gimbal, dan namanya menyebutkan yang mana. Terbangkan berurutan dengan titik lepas landas yang SAMA, lalu masukkan semua fotonya ke satu project waktu mengolah.`
      );
    }

    if (plan.sorties.length > 2) {
      add(
        'warn',
        'building3d-sun',
        `${plan.sorties.length} file berarti ${plan.sorties.length} siklus baterai, dan matahari bergeser di antaranya. Bayangan yang berubah antara lintasan nadir dan lintasan miring membuat tekstur modelnya belang. Terbangkan ketiganya berturut-turut, atau pilih langit mendung.`
      );
    }
  }

  // ---- Orbit: objek tegak ----
  //
  // Orbit memakai hampir semua pemeriksaan di atas, tapi punya cara gagalnya
  // sendiri — dan hampir semuanya tidak kelihatan di angka ringkasan.
  const orb = plan.orbit;
  if (plan.pattern === 'orbit' && orb) {
    const low = orb.rings[0];
    const high = orb.rings[orb.rings.length - 1];

    // Arah hadap per titik: inti dari orbit, dan justru bagian yang paling
    // tidak punya contoh nyata. Pengguna berhak tahu ini jalur yang belum
    // terbukti, bukan menemukannya sendiri di lapangan.
    add(
      'warn',
      'orbit-heading-unproven',
      `Orbit butuh arah hadap sendiri di tiap titik (${plan.orbitHeadingMode === 'towardPOI' ? 'towardPOI' : 'smoothTransition'}), dan bentuk itu belum pernah terlihat di file yang terbukti diterima DJI Fly — semua contoh yang kita punya memakai followWayline. Kalau drone mengelilingi tugu tapi kameranya tidak menghadap ke dalam, inilah tersangkanya; coba mode satunya sebelum mengejar sebab lain.`
    );

    // Cincin terbawah sengaja rendah — di situlah dinding bawah tugu. Tapi
    // "sengaja" bukan berarti aman.
    const floorM = lim.takeOffSecurityHeightM ?? 20;
    if (low.heightM < 8) {
      add(
        'bad',
        'orbit-ring-too-low',
        `Cincin terbawah cuma ${low.heightM.toFixed(1)} m — drone mengelilingi tugu di ketinggian pohon, tiang lampu, dan kabel. Sensor rintangan tidak bisa diandalkan untuk benda tipis seperti kabel atau ranting. Naikkan sudut terkecil, atau terbangkan cincin ini manual sambil dilihat.`
      );
    } else if (low.heightM < floorM) {
      add(
        'warn',
        'orbit-ring-low',
        `Cincin terbawah ${low.heightM.toFixed(1)} m, di bawah ketinggian aman lepas landas (${floorM} m). Pastikan lingkaran selebar ${(2 * orb.radiusM).toFixed(0)} m di sekeliling tugu benar-benar kosong di ketinggian itu, termasuk pohon.`
      );
    }

    // Cincin yang dinaikkan ke lantai ketinggian. Pitch-nya jadi lebih curam
    // dari yang diminta, dan pengguna harus tahu kenapa — kalau tidak, angka
    // di tabel terlihat seperti setelannya tidak dipakai.
    const raised = orb.rings.filter((r) => r.raisedToFloor);
    if (raised.length) {
      add(
        'info',
        'orbit-ring-raised',
        `${raised.length === 1 ? 'Cincin terbawah' : `${raised.length} cincin terbawah`} dinaikkan ke lantai ketinggian supaya tidak mengelilingi objek di ketinggian pohon dan kabel. Titik bidiknya tidak digeser — drone naik dan kameranya menunduk lebih curam (${raised.map((r) => r.pitchDeg + '°').join(', ')}), jadi pita bawah objek tetap terpotret.`
      );
    }

    // Jarak ke objek. Sensor rintangan DJI mengukur ke benda besar dan
    // bertekstur; tugu yang ramping di latar langit sering tidak terbaca.
    if (orb.radiusM < 10) {
      add(
        'bad',
        'orbit-too-close',
        `Radius orbit ${orb.radiusM.toFixed(0)} m terlalu dekat. Di jarak ini kesalahan GPS beberapa meter saja sudah cukup untuk menabrak, dan sensor rintangan sering tidak melihat struktur ramping dengan langit di belakangnya. Minimal 12-15 m untuk tugu.`
      );
    } else if (orb.radiusM < 15) {
      add(
        'warn',
        'orbit-close',
        `Radius ${orb.radiusM.toFixed(0)} m cukup dekat. GSD-nya bagus, tapi sisakan ruang untuk hanyutan GPS dan angin — dan jangan terbangkan ini kalau anginnya kencang.`
      );
    }

    // Kaki tugu: bagian yang drone memang tidak bisa ambil dengan benar.
    const gapM = low.aimHeightM;
    if (gapM > 1) {
      add(
        'info',
        'orbit-base-gap',
        `Cincin terbawah membidik ketinggian ${gapM.toFixed(1)} m di tugu, jadi bagian 0-${gapM.toFixed(1)} m — kaki dan alasnya — cuma kena serempet. Itu memang batas drone, bukan salah setelan: keliling dengan kamera tangan atau HP untuk bagian itu, 40-60 foto, lalu gabungkan di software yang sama.`
      );
    }

    // Loncatan sudut: alasan model orbit gagal menyambung meski overlap
    // frame-nya kelihatan sehat.
    const worstStep = Math.max(...orb.rings.map((r) => r.angleStepDeg));
    if (worstStep > 15) {
      add(
        'warn',
        'orbit-angle-step',
        `Antara dua foto berurutan, sudut pandang ke tugu meloncat ${worstStep.toFixed(0)}°. Di atas 15° software sering gagal mencocokkan dinding yang sama, berapa pun overlap frame-nya. Rapatkan langkah sudut.`
      );
    }

    // GSD tidak seragam: cincin atas duduk lebih jauh dari dinding.
    if (high.gsdCm > low.gsdCm * 1.6) {
      add(
        'warn',
        'orbit-gsd-spread',
        `Ketelitian tidak seragam: ${low.gsdCm.toFixed(2)} cm/px di cincin bawah tapi ${high.gsdCm.toFixed(2)} cm/px di cincin atas, karena cincin yang curam duduk lebih jauh dari dinding. Puncak tugu akan terlihat lebih kasar dari kakinya. Turunkan sudut terbesar, atau rapatkan radius.`
      );
    }

    if (!orb.cap) {
      add(
        'info',
        'orbit-no-cap',
        'Petak nadir di atas dimatikan. Puncak tugu dan tanah di sekelilingnya tidak akan terpotret — dan tanah itulah yang biasanya mengikat skala seluruh model.'
      );
    }

    // Ikut kontur dinyalakan tapi tidak berlaku di orbit. Mematikannya
    // diam-diam sama saja menyembunyikan bahwa centangan itu tidak berefek.
    if (plan.terrainRequested) {
      add(
        'info',
        'orbit-terrain-na',
        'Ikut kontur tanah tidak dipakai di orbit: ketinggian tiap cincin diturunkan dari sudut bidik ke objek, bukan dari permukaan di bawah drone. Centangannya diabaikan untuk pola ini.'
      );
    }

    add(
      'info',
      'orbit-ground-truth',
      'Ukur satu jarak nyata di lapangan — lebar sisi alas, misalnya — lalu pakai sebagai acuan skala waktu mengolah. Tanpa itu model 3D-nya benar bentuknya tapi ukurannya mengambang.'
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

  // ---- Ketinggian pulang otomatis ----
  //
  // Angka paling penting di seluruh file, dan yang paling lama salah di sini:
  // sampai commit ini, web memakai satu slider untuk ketinggian transit DAN
  // ketinggian pulang, jadi RTH terkunci di 20 m — lebih rendah dari bawaan
  // MISSION_DEFAULTS (100 m), dan lebih rendah dari banyak pohon.
  //
  // Yang membuat ini mematikan: jalur pulang otomatis adalah GARIS LURUS ke
  // titik home. Drone naik ke ketinggian RTH, lalu menyeberang tanpa
  // menghindar apa pun. Kalau ada yang lebih tinggi di antaranya, dia menabrak
  // — dan itu terjadi justru saat pengguna sudah kehilangan kendali atau
  // baterainya kritis.
  if (adv.rthHeightM !== undefined) {
    const rth = adv.rthHeightM;

    const tertinggi = o.obstacles?.length
      ? o.obstacles.reduce((a, b) => (a.heightM > b.heightM ? a : b))
      : null;

    if (tertinggi && tertinggi.heightM >= rth) {
      add(
        'bad',
        'rth-below-obstacle',
        `Ketinggian pulang ${rth} m, sementara ada bangunan setinggi ${tertinggi.heightM.toFixed(0)} m di jalur. Pulang otomatis itu garis lurus tanpa menghindar — naikkan ke setidaknya ${Math.ceil((tertinggi.heightM + 25) / 10) * 10} m. Data tinggi bangunan OSM juga sering kurang dari aslinya, dan antena di atap tidak terdata sama sekali.`
      );
    }

    if (rth < plan.altitude) {
      add(
        'warn',
        'rth-below-mission',
        `Ketinggian pulang ${rth} m lebih rendah dari ketinggian terbang ${plan.altitude.toFixed(0)} m. Artinya saat pulang otomatis drone TURUN dulu, baru menyeberang di atas area yang tadi dia lewati dari lebih tinggi. Kalau ketinggian terbangnya dipilih karena ada yang tinggi di lahan ini, pulangnya jadi lebih berbahaya daripada terbangnya.`
      );
    }

    if (rth < adv.safeHeightM) {
      add(
        'warn',
        'rth-below-transit',
        `Ketinggian pulang ${rth} m lebih rendah dari ketinggian transit ${adv.safeHeightM} m. Tidak konsisten: drone naik ${adv.safeHeightM} m untuk menyeberang ke titik awal, tapi cuma ${rth} m untuk pulang — padahal jalur pulang justru yang dilewati tanpa pengawasan.`
      );
    }

    add(
      'info',
      'rth-height',
      `Pulang otomatis di ${rth} m, lurus ke titik lepas landas tanpa menghindar. Pastikan tidak ada pohon, menara, atau bangunan yang lebih tinggi dari itu di garis antara lahan dan titik pulang.`
    );
  }

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

  // Pola yang mencampur sudut memegang nilainya sendiri per lintasan, jadi
  // angka di slider tidak pernah sampai ke file — memperingatkannya cuma
  // bikin bingung.
  const mixedGimbal = plan.grid?.mixedGimbal || plan.pattern === 'orbit';
  if (!mixedGimbal && adv.gimbalPitch !== undefined && adv.gimbalPitch > -30) {
    add(
      'warn',
      'gimbal-flat',
      `Gimbal ${adv.gimbalPitch}° hampir mendatar. Untuk fotogrametri, sudut sedatar ini membuat skala foto tidak seragam dan hasil olahannya melenceng.`
    );
  }

  // ---- Buffer ----

  const overhead = plan.gridArea / plan.area - 1;
  if (plan.pattern === 'orbit') {
    // Buffer itu konsep tepi lahan; orbit tidak punya tepi lahan.
  } else if (plan.bufferM > 0 && overhead > 0.6) {
    add(
      'info',
      'buffer-cost',
      `Buffer menambah ${pct(overhead)} luas terbang — di lahan sekecil ini buffernya proporsional besar. Turunkan ke 0.5x kalau tepi lahan tidak kritis.`
    );
  }

  if (plan.bufferM === 0 && plan.pattern !== 'orbit') {
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
        plan.resume.backedOff > 0 ? ', mundur satu foto dari titik terakhir supaya tidak ada petak yang bolong' : ''
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
