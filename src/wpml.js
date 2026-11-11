// Generator file WPML (DJI Waypoint Mission) -> isi dari .kmz
//
// Struktur .kmz:
//   wpmz/
//     template.kml    <- ringkasan misi
//     waylines.wpml   <- jalur terbang yang benar-benar dieksekusi drone
//
// PENTING — dua dialek, dan bedanya besar.
//
// Dokumentasi WPML yang dipublikasikan DJI itu untuk lini Enterprise (DJI
// Pilot 2, Cloud API, namespace dji.com/wpmz/1.0.6). DJI Fly — yang dipakai
// lini consumer — menulis bentuk yang BERBEDA, dan bedanya bukan kosmetik.
// Isi berkas ini mengikuti file asli buatan DJI Fly yang dibongkar dengan
// `npm run inspect`, bukan mengikuti dokumentasi.
//
// Yang berbeda, dan itulah kenapa file bergaya Enterprise kemungkinan besar
// ditolak DJI Fly:
//
//   namespace          uav.com/wpmz/1.0.2, bukan dji.com/wpmz/1.0.6
//   template.kml       hanya author + waktu + missionConfig. TANPA <Folder>,
//                      tanpa templateType, tanpa satu pun Placemark. Semua
//                      waypoint cuma hidup di waylines.wpml.
//   payloadInfo        tidak ditulis sama sekali — jadi payloadEnumValue
//                      yang selama ini kita ributkan ternyata tidak dipakai
//                      DJI Fly
//   takeOffSecurityHeight  tidak ada. Naik-aman sebelum transit diurus
//                      flyToWaylineMode=safely, bukan oleh angka ini.
//   waypointTurnMode   ...WithContinuityCurvature, bukan ...Discontinuity...
//   useStraightLine    0, bukan 1
//   actionGroupMode    file DJI Fly sendiri memakai parallel, TAPI yang kita
//                      tulis sequence — lihat catatan di actionGroup()
//   actionId           mulai dari 1
//   distance/duration  ditulis 0 — DJI Fly menghitungnya sendiri
//
// Dua tag yang dulu tidak kita tulis sama sekali dan ada di file asli:
// waypointHeadingPoiIndex dan waypointGimbalHeadingParam.
import { pathLength } from './geo.js';

const NS_DJIFLY = 'http://www.uav.com/wpmz/1.0.2';
const NS_ENTERPRISE = 'http://www.dji.com/wpmz/1.0.6';

const nsOf = (profile) =>
  profile?.wpmlNamespace ?? (profile?.dialect === 'enterprise' ? NS_ENTERPRISE : NS_DJIFLY);

const dialectOf = (profile) => profile?.dialect ?? 'djifly';

const esc = (s) =>
  String(s).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]
  );

const num = (v, digits = 6) => {
  const n = Number(v);
  // Angka yang tidak terhingga TIDAK boleh diam-diam jadi teks "NaN" di dalam
  // file. DJI Fly tetap mau mengimpor file seperti itu — daftar misinya muncul,
  // waypoint-nya tergambar — lalu penerbangannya gagal di lapangan dengan pesan
  // yang tidak menyebut satu pun nama tag. Lebih baik export-nya batal di meja.
  if (!Number.isFinite(n)) {
    throw new Error(
      `Nilai bukan angka masuk ke file misi (${v}). Export dibatalkan — file seperti ini diimpor DJI Fly tapi gagal saat diterbangkan.`
    );
  }
  const s = n.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
};

/**
 * Sudut kompas 0..360 -> sudut WPML -180..180.
 *
 * WPML menyatakan arah hadap dalam rentang [-180, 180]: 90 itu timur, -90 itu
 * BARAT. Jalur bolak-balik menghasilkan arah 270 untuk lintasan baliknya, dan
 * 270 bukan sekadar "cara lain menulis -90" — dia di luar rentang yang
 * dinyatakan DJI, dan tidak pernah muncul di satu pun file yang terbukti
 * diterbangkan.
 */
const toSigned180 = (deg) => {
  const d = ((Number(deg) % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
};

/**
 * Blok <wpml:missionConfig>.
 *
 * payloadInfo sengaja TIDAK ditulis untuk dialek DJI Fly: file asli tidak
 * memuatnya, dan mengirim tag yang tidak dikenal ke parser yang menolak tanpa
 * pesan error adalah cara tercepat bikin impor gagal tanpa tahu sebabnya.
 */
function missionConfig(m, p) {
  const djifly = dialectOf(p) === 'djifly';

  const payload = djifly
    ? ''
    : `
      <wpml:payloadInfo>
        <wpml:payloadEnumValue>${p.payloadEnumValue}</wpml:payloadEnumValue>
        <wpml:payloadSubEnumValue>${p.payloadSubEnumValue}</wpml:payloadSubEnumValue>
        <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
      </wpml:payloadInfo>`;

  // Dikembalikan setelah terlihat di file buatan generator pihak ketiga yang
  // dipakai orang untuk Mini 5 Pro: DJI Fly menerima keduanya, meski file
  // buatan DJI Fly sendiri tidak menulisnya. Dan keduanya setelan keselamatan
  // yang nyata — ketinggian naik sebelum transit, dan ketinggian RTH.
  const takeOff = `
      <wpml:takeOffSecurityHeight>${num(m.takeOffSecurityHeight, 1)}</wpml:takeOffSecurityHeight>`;

  const rthHeight =
    m.rthHeight == null
      ? ''
      : `
      <wpml:globalRTHHeight>${num(m.rthHeight, 1)}</wpml:globalRTHHeight>`;

  return `    <wpml:missionConfig>
      <wpml:flyToWaylineMode>${m.flyToWaylineMode}</wpml:flyToWaylineMode>
      <wpml:finishAction>${m.finishAction}</wpml:finishAction>
      <wpml:exitOnRCLost>${m.exitOnRCLost}</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>${m.executeRCLostAction}</wpml:executeRCLostAction>${takeOff}
      <wpml:globalTransitionalSpeed>${num(m.transitionalSpeed ?? m.speed, 1)}</wpml:globalTransitionalSpeed>${rthHeight}
      <wpml:droneInfo>
        <wpml:droneEnumValue>${p.droneEnumValue}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${p.droneSubEnumValue}</wpml:droneSubEnumValue>
      </wpml:droneInfo>${payload}
    </wpml:missionConfig>`;
}

/**
 * Satu action group — aksi foto di satu titik.
 *
 * JANGAN diganti ke `parallel` meski file DJI Fly sendiri memakai parallel.
 * Ini satu-satunya tempat di berkas ini yang SENGAJA menyimpang dari file
 * asli, dan alasannya mahal: file asli DJI Fly yang kita bongkar TIDAK memuat
 * satu pun aksi foto, jadi dia bukan contoh untuk bagian ini. Versi kita yang
 * dulu memakai parallel sudah diuji di perangkat dan DITOLAK.
 *
 * Yang dicontoh di sini adalah generator pihak ketiga yang filenya memang
 * dipakai orang memetakan dengan Mini 5 Pro — satu-satunya referensi yang
 * punya aksi foto DAN terbukti terimpor. Dia memakai `sequence`.
 *
 * actionId mulai dari 1, dan itu ada di kedua referensi.
 */
function actionGroup({ id = 1, startIndex, endIndex, actions }) {
  if (!actions.length) return '';

  return `
        <wpml:actionGroup>
          <wpml:actionGroupId>${id}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${startIndex}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${endIndex}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
          </wpml:actionTrigger>
${actions.join('\n')}
        </wpml:actionGroup>`;
}

/**
 * Putar gimbal ke sudut tetap.
 *
 * Bentuk pendek `gimbalEvenlyRotate` dipakai, bukan `gimbalRotate` yang
 * panjang. Dua-duanya muncul di file asli DJI Fly, tapi generator pihak
 * ketiga yang dipakai orang untuk Mini 5 Pro memakai yang pendek di SETIAP
 * titik — dan itu contoh yang lebih dekat dengan apa yang kita butuhkan,
 * karena dia memang untuk pemetaan.
 */
function gimbalAction(id, pitch) {
  return `          <wpml:action>
            <wpml:actionId>${id}</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalEvenlyRotate</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:gimbalPitchRotateAngle>${num(pitch, 1)}</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
}

function takePhotoAction(id, index) {
  return `          <wpml:action>
            <wpml:actionId>${id}</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:fileSuffix>${index + 1}</wpml:fileSuffix>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
}

function hoverAction(id, seconds) {
  return `          <wpml:action>
            <wpml:actionId>${id}</wpml:actionId>
            <wpml:actionActuatorFunc>hover</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:hoverTime>${num(seconds, 1)}</wpml:hoverTime>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
}

/**
 * Pemotretan berulang sepanjang jalur, tiap N meter atau N detik.
 *
 * CATATAN: ini satu-satunya bagian yang TIDAK bisa dicocokkan dengan file
 * asli, karena misi contoh yang kita punya tidak memakai aksi foto sama
 * sekali. Jadi bentuknya mengikuti dokumentasi Enterprise, dibungkus dengan
 * gaya DJI Fly. Kalau nanti drone terbang rapi tapi tidak menjepret, inilah
 * tersangkanya — dan jalan keluarnya mode stop & shoot.
 */
function intervalActionGroup(m, lastIndex, id) {
  const iv = m.intervalShooting;
  if (!iv) return '';

  const triggerType = iv.mode === 'time' ? 'multipleTiming' : 'multipleDistance';

  return `
        <wpml:actionGroup>
          <wpml:actionGroupId>${id}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>0</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${lastIndex}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>parallel</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>${triggerType}</wpml:actionTriggerType>
            <wpml:actionTriggerParam>${num(iv.value, 2)}</wpml:actionTriggerParam>
          </wpml:actionTrigger>
          <wpml:action>
            <wpml:actionId>1</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
        </wpml:actionGroup>`;
}

/**
 * Arah hadap drone.
 *
 * File asli DJI Fly memakai `followWayline` — drone menghadap ke arah
 * jalurnya sendiri — dengan waypointHeadingAngleEnable 1 di titik pertama
 * dan 0 setelahnya. Kami dulu menulis `smoothTransition` dengan sudut
 * eksplisit tiap titik, gaya Enterprise, dan nilai itu tidak pernah muncul di
 * file yang terbukti diterima.
 *
 * Untuk jalur bolak-balik, followWayline juga memang yang benar: arah hadap
 * mengikuti jalur dengan sendirinya, tidak perlu disuapi sudut per titik.
 *
 * ORBIT MEMBALIK ITU. Mengelilingi tugu dengan followWayline berarti kamera
 * menyorot tangensial — objeknya lewat di pinggir frame, bukan di tengah.
 * Tiap titik harus punya sudut hadapnya sendiri, dan ada dua cara menuliskan
 * itu. Keduanya BELUM pernah terlihat di file yang terbukti diterima DJI Fly,
 * jadi dua-duanya disediakan dan pengguna diberi tahu:
 *
 *   smoothTransition  Sudut mutlak ditulis per titik, dihitung sendiri di
 *                     sini. Drone tinggal memutar ke angka itu — tidak perlu
 *                     paham konsep POI sama sekali. Ini bawaan untuk orbit,
 *                     karena yang diminta ke drone paling sederhana.
 *   towardPOI         Satu titik pusat ditulis di waypointPoiPoint dan drone
 *                     yang menghitung sendiri arah hadapnya. Lebih rapi, tapi
 *                     bergantung pada DJI Fly benar-benar membaca tag itu.
 *
 * waypointPoiPoint selama ini selalu ditulis 0,0,0 karena memang tidak ada
 * yang memakainya. Sekarang diisi kalau misinya punya pusat.
 */
function headingParam(wp, m, i = 0) {
  const mode = wp.headingMode ?? m.headingMode;
  // File buatan DJI Fly memasang 1 di titik pertama, tapi generator pihak
  // ketiga memasang 0 di semua titik — dan file kita yang meniru DJI Fly
  // justru ditolak. Jadi yang diikuti contoh yang dipakai orang memetakan.
  //
  // Pengecualiannya orbit: di sana sudut per titik BUKAN hiasan, dia
  // satu-satunya yang membuat kamera menghadap objek. Kalau enable 0, sudut
  // yang susah payah dihitung itu diabaikan drone.
  const enable = mode === 'smoothTransition' ? 1 : 0;

  // Sudut hanya ditulis kalau memang dipakai.
  //
  // Ini sumber kegagalan yang mahal, dan dia tidak kelihatan dari struktur
  // file sama sekali: di followWayline drone menghitung sendiri arah hadapnya
  // dari jalur, jadi angka di sini TIDAK dipakai — tapi tetap dibaca dan tetap
  // divalidasi. Jalur bolak-balik menulis 90 di lintasan berangkat dan 270 di
  // lintasan balik, dan 270 di luar rentang [-180, 180]. File-nya terimpor
  // dengan mulus, waypoint-nya tergambar benar, lalu penerbangannya gagal.
  //
  // Dua-duanya file acuan — buatan DJI Fly sendiri dan buatan generator pihak
  // ketiga yang memang dipakai orang memetakan — menulis 0 di SETIAP titik.
  // Jadi itu yang ditulis di sini juga, dan sudut sungguhan cuma ditulis untuk
  // mode yang benar-benar memakainya (orbit), sesudah dibawa ke rentang yang
  // sah.
  const angle = enable ? toSigned180(wp.heading ?? 0) : 0;

  const poi = wp.poiPoint ?? m.poi;
  const poiPoint = poi
    ? `${num(poi.lat, 6)},${num(poi.lng, 6)},${num(poi.height ?? 0, 6)}`
    : '0.000000,0.000000,0.000000';

  return `        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>${mode}</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>${num(angle, 1)}</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>${poiPoint}</wpml:waypointPoiPoint>
          <wpml:waypointHeadingAngleEnable>${enable}</wpml:waypointHeadingAngleEnable>
          <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
          <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
        </wpml:waypointHeadingParam>`;
}

function turnParam(m) {
  return `        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>${m.turnMode}</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>${num(m.turnDampingDist, 1)}</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>`;
}

/** Placemark untuk waylines.wpml — satu-satunya tempat waypoint hidup. */
function waylinePlacemark(wp, i, m, total) {
  // Satu action group per titik, berisi gimbal lalu hover lalu foto — urutan
  // dan susunan ini menyalin generator pihak ketiga yang memang dipakai orang
  // untuk memetakan dengan Mini 5 Pro. Sebelumnya gimbal cuma dipasang sekali
  // di titik pertama dan pemotretan diserahkan ke perintah interval; file
  // seperti itu ditolak DJI Fly.
  const actions = [];
  let actionId = 1;

  if (wp.gimbalPitch !== undefined && wp.gimbalPitch !== null) {
    actions.push(gimbalAction(actionId++, wp.gimbalPitch));
  }
  if (wp.hoverTime) actions.push(hoverAction(actionId++, wp.hoverTime));
  if (wp.takePhoto) actions.push(takePhotoAction(actionId++, i));

  const groups = [actionGroup({ id: 1, startIndex: i, endIndex: i, actions })];

  // Perintah jepret-per-jarak hanya ditulis kalau diminta secara eksplisit.
  // Tidak ada satu pun contoh nyata yang memakainya, jadi ini jalur yang
  // belum terbukti — bukan bawaan.
  if (i === 0 && m.intervalShooting) groups.push(intervalActionGroup(m, total - 1, 900));

  // Sudut di sini ditulis 0 mengikuti contoh yang ada: yang benar-benar
  // menggerakkan gimbal adalah aksi di atas, dan nilai di sini rupanya
  // diperlakukan sebagai offset, bukan sudut mutlak.
  const gimbalHeading = `
        <wpml:waypointGimbalHeadingParam>
          <wpml:waypointGimbalPitchAngle>0</wpml:waypointGimbalPitchAngle>
          <wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle>
        </wpml:waypointGimbalHeadingParam>`;

  return `      <Placemark>
        <Point>
          <coordinates>${num(wp.lng, 10)},${num(wp.lat, 10)}</coordinates>
        </Point>
        <wpml:index>${i}</wpml:index>
        <wpml:executeHeight>${num(wp.height, 2)}</wpml:executeHeight>
        <wpml:waypointSpeed>${num(wp.speed ?? m.speed, 1)}</wpml:waypointSpeed>
${headingParam(wp, m, i)}
${turnParam(m)}
        <wpml:useStraightLine>${m.useStraightLine}</wpml:useStraightLine>${groups.join('')}${gimbalHeading}
      </Placemark>`;
}

/**
 * template.kml.
 *
 * Bentuknya minimal dan itu disengaja: file asli DJI Fly tidak memuat satu
 * pun Placemark di sini. Dulu kami menulis seluruh misi dua kali — di
 * template dan di waylines — dan itu bukan cuma mubazir, tapi menyimpang
 * dari satu-satunya contoh yang terbukti diterima drone.
 */
export function buildTemplateKml(mission, profile) {
  const now = Date.now();

  if (dialectOf(profile) !== 'djifly') {
    return buildTemplateKmlEnterprise(mission, profile, now);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${nsOf(profile)}">
  <Document>
    <wpml:author>${esc(mission.author)}</wpml:author>
    <wpml:createTime>${now}</wpml:createTime>
    <wpml:updateTime>${now}</wpml:updateTime>
${missionConfig(mission, profile)}
  </Document>
</kml>
`;
}

/** Bentuk lama bergaya Enterprise — dipertahankan untuk DJI Pilot 2. */
function buildTemplateKmlEnterprise(mission, profile, now) {
  const wps = mission.waypoints
    .map(
      (wp, i) => `      <Placemark>
        <Point>
          <coordinates>${num(wp.lng, 10)},${num(wp.lat, 10)}</coordinates>
        </Point>
        <wpml:index>${i}</wpml:index>
        <wpml:ellipsoidHeight>${num(wp.height, 2)}</wpml:ellipsoidHeight>
        <wpml:height>${num(wp.height, 2)}</wpml:height>
        <wpml:useGlobalHeight>0</wpml:useGlobalHeight>
        <wpml:useGlobalSpeed>0</wpml:useGlobalSpeed>
        <wpml:waypointSpeed>${num(wp.speed ?? mission.speed, 1)}</wpml:waypointSpeed>
      </Placemark>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${nsOf(profile)}">
  <Document>
    <wpml:author>${esc(mission.author)}</wpml:author>
    <wpml:createTime>${now}</wpml:createTime>
    <wpml:updateTime>${now}</wpml:updateTime>
${missionConfig(mission, profile)}
    <Folder>
      <wpml:templateType>waypoint</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>${mission.heightMode}</wpml:heightMode>
        <wpml:positioningType>GPS</wpml:positioningType>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>${num(mission.speed, 1)}</wpml:autoFlightSpeed>
      <wpml:globalHeight>${num(mission.height, 2)}</wpml:globalHeight>
${wps}
    </Folder>
  </Document>
</kml>
`;
}

/**
 * Rentang nilai yang dinyatakan WPML, dan satu jarak minimum antar titik.
 *
 * Kenapa ini ada sebagai pemeriksaan tersendiri, bukan sekadar hati-hati saat
 * menulis: pelanggaran rentang TIDAK terlihat waktu impor. DJI Fly menerima
 * filenya, menggambar jalurnya di peta, dan baru gagal saat tombol terbang
 * ditekan — dengan pesan yang tidak menyebut tag mana pun. Perjalanan ke lahan
 * sudah terlanjur dibayar.
 *
 * Alat banding (`npm run compare`) tidak bisa menangkapnya: dia sengaja
 * mengabaikan nilai yang memang beda tiap misi — kecepatan, ketinggian, sudut
 * hadap — justru tempat pelanggaran rentang bersembunyi.
 */
const RANGES = {
  speed: [1, 15],
  heading: [-180, 180],
  gimbalPitch: [-120, 45],
  takeOffSecurityHeight: [1.5, 1500],
  rthHeight: [20, 1500],
};

// DJI menolak dua titik yang nyaris berimpit. Jarak di bawah ini biasanya
// bukan kesengajaan, melainkan jalur yang terlalu rapat atau titik kembar di
// sambungan antar lintasan.
const MIN_WAYPOINT_GAP_M = 0.5;

const between = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;

/**
 * @param {object} mission mission yang sudah lengkap (hasil gabung dengan MISSION_DEFAULTS)
 * @returns {string[]} daftar pelanggaran; kosong berarti aman
 */
export function wpmlRangeProblems(mission) {
  const bad = [];
  const maxSpeed = RANGES.speed;

  if (!between(Number(mission.speed), maxSpeed)) {
    bad.push(
      `Kecepatan misi ${mission.speed} m/s di luar rentang ${maxSpeed[0]}-${maxSpeed[1]} m/s.`
    );
  }
  const transit = mission.transitionalSpeed ?? mission.speed;
  if (!between(Number(transit), maxSpeed)) {
    bad.push(`Kecepatan transit ${transit} m/s di luar rentang ${maxSpeed[0]}-${maxSpeed[1]} m/s.`);
  }
  if (!between(Number(mission.takeOffSecurityHeight), RANGES.takeOffSecurityHeight)) {
    bad.push(
      `Ketinggian naik-aman ${mission.takeOffSecurityHeight} m di luar rentang ${RANGES.takeOffSecurityHeight.join('-')} m.`
    );
  }
  if (mission.rthHeight != null && !between(Number(mission.rthHeight), RANGES.rthHeight)) {
    bad.push(
      `Ketinggian pulang otomatis ${mission.rthHeight} m di luar rentang ${RANGES.rthHeight.join('-')} m.`
    );
  }

  mission.waypoints.forEach((wp, i) => {
    if (!Number.isFinite(Number(wp.lat)) || !Number.isFinite(Number(wp.lng))) {
      bad.push(`Titik ${i + 1}: koordinat bukan angka.`);
    }
    if (!Number.isFinite(Number(wp.height))) {
      bad.push(`Titik ${i + 1}: ketinggian bukan angka.`);
    }
    const sp = wp.speed ?? mission.speed;
    if (!between(Number(sp), maxSpeed)) {
      bad.push(`Titik ${i + 1}: kecepatan ${sp} m/s di luar rentang ${maxSpeed.join('-')} m/s.`);
    }
    const mode = wp.headingMode ?? mission.headingMode;
    if (mode === 'smoothTransition' && !between(toSigned180(wp.heading ?? 0), RANGES.heading)) {
      bad.push(`Titik ${i + 1}: sudut hadap ${wp.heading}° tidak bisa dibawa ke -180..180.`);
    }
    if (wp.gimbalPitch != null && !between(Number(wp.gimbalPitch), RANGES.gimbalPitch)) {
      bad.push(
        `Titik ${i + 1}: sudut gimbal ${wp.gimbalPitch}° di luar rentang ${RANGES.gimbalPitch.join('-')}°.`
      );
    }
    if (wp.hoverTime != null && Number(wp.hoverTime) < 0) {
      bad.push(`Titik ${i + 1}: lama jeda ${wp.hoverTime} detik negatif.`);
    }
  });

  // Titik berimpit. Dihitung dengan perkiraan bidang datar — pada jarak
  // setengah meter, kelengkungan bumi tidak ikut bicara.
  for (let i = 1; i < mission.waypoints.length; i++) {
    const a = mission.waypoints[i - 1];
    const b = mission.waypoints[i];
    const dLat = (Number(b.lat) - Number(a.lat)) * 111320;
    const dLng =
      (Number(b.lng) - Number(a.lng)) * 111320 * Math.cos((Number(a.lat) * Math.PI) / 180);
    const dz = Number(b.height ?? 0) - Number(a.height ?? 0);
    const d = Math.hypot(dLat, dLng, dz);
    if (Number.isFinite(d) && d < MIN_WAYPOINT_GAP_M) {
      bad.push(
        `Titik ${i} dan ${i + 1} cuma berjarak ${d.toFixed(2)} m — di bawah batas ${MIN_WAYPOINT_GAP_M} m.`
      );
    }
  }

  return bad;
}

export function buildWaylinesWpml(mission, profile) {
  const problems = wpmlRangeProblems(mission);
  if (problems.length) {
    throw new Error(
      `File misi batal dibuat — ${problems.length} nilai di luar yang diterima DJI Fly:` +
        problems.map((t) => `
- ${t}`).join('')
    );
  }

  const total = mission.waypoints.length;

  // DJI Fly menulis 0 untuk keduanya dan menghitung sendiri saat memuat.
  // Angka hasil hitungan kita dulu ditulis di sini; kalau ternyata dipakai
  // mentah-mentah oleh drone, angka yang meleset lebih berbahaya daripada
  // nol yang jujur.
  // DJI Fly sendiri menulis 0 di sini, tapi generator pihak ketiga yang
  // dipakai orang menulis angka hasil hitungan — dan itu yang kita ikuti,
  // karena angka yang benar lebih berguna daripada nol kalau ternyata dibaca.
  const pts = mission.waypoints.map((w) => ({ lat: w.lat, lng: w.lng }));
  const distance = pathLength(pts);
  const hover = mission.waypoints.reduce((s, w) => s + (w.hoverTime || 0), 0);
  const duration = distance / mission.speed + hover;

  const wps = mission.waypoints
    .map((wp, i) => waylinePlacemark(wp, i, mission, total))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${nsOf(profile)}">
  <Document>
${missionConfig(mission, profile)}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>${mission.heightMode}</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>${num(distance, 2)}</wpml:distance>
      <wpml:duration>${num(duration, 2)}</wpml:duration>
      <wpml:autoFlightSpeed>${num(mission.speed, 1)}</wpml:autoFlightSpeed>
${wps}
    </Folder>
  </Document>
</kml>
`;
}

/** Statistik mission untuk ditampilkan ke user. */
export function missionStats(mission) {
  const pts = mission.waypoints.map((w) => ({ lat: w.lat, lng: w.lng }));
  const dist = pathLength(pts);
  const hover = mission.waypoints.reduce((s, w) => s + (w.hoverTime || 0), 0);
  const photos = mission.waypoints.filter((w) => w.takePhoto).length;
  return {
    waypoints: mission.waypoints.length,
    distanceM: dist,
    photos,
    durationS: dist / mission.speed + hover + photos * 2,
  };
}

/**
 * Nilai default mission.
 *
 * Yang berubah setelah membandingkan dengan file asli DJI Fly:
 *   turnMode        ...ContinuityCurvature (dulu ...Discontinuity...)
 *   useStraightLine 0 (dulu 1)
 *   author          'fly' — sama persis dengan yang ditulis DJI Fly
 *   headingMode     followWayline, yang dipakai file asli
 */
export const MISSION_DEFAULTS = {
  author: 'fly',
  speed: 5, // m/s kecepatan jelajah
  height: 30, // meter, relatif terhadap titik take-off
  heightMode: 'relativeToStartPoint', // relativeToStartPoint | EGM96 | realTimeFollowSurface
  flyToWaylineMode: 'safely', // naik ke ketinggian aman dulu sebelum menuju titik awal
  finishAction: 'goHome', // goHome | noAction | autoLand | gotoFirstWaypoint
  exitOnRCLost: 'executeLostAction', // goContinue | executeLostAction
  executeRCLostAction: 'goBack', // goBack | landing | hover
  takeOffSecurityHeight: 20, // naik ke sini dulu sebelum menuju titik awal
  rthHeight: 100, // ketinggian pulang otomatis
  // Kecepatan menuju waypoint pertama. Dibiarkan kosong supaya mengikuti
  // kecepatan misi: kedua file acuan — buatan DJI Fly dan buatan generator
  // pihak ketiga — selalu menyamakan keduanya. Sebelumnya angka ini terpaku
  // 2.5 sementara kecepatan rencana bisa 7.6, dan itulah yang terbaca
  // sebagai "kecepatan tidak kepakai" di lapangan.
  transitionalSpeed: null,
  headingMode: 'followWayline', // followWayline | manually | fixed | smoothTransition | towardPOI
  // Titik pusat untuk misi orbit: { lat, lng, height }. Dibiarkan kosong untuk
  // misi grid, dan waypointPoiPoint tetap ditulis 0,0,0 seperti file acuan.
  poi: null,
  turnMode: 'toPointAndPassWithContinuityCurvature',
  turnDampingDist: 0,
  useStraightLine: 0,
};
