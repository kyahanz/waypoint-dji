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
//   actionGroupMode    parallel, bukan sequence; actionId mulai dari 1
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
  const s = Number(v).toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
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

  const takeOff = djifly
    ? ''
    : `
      <wpml:takeOffSecurityHeight>${num(m.takeOffSecurityHeight, 1)}</wpml:takeOffSecurityHeight>`;

  return `    <wpml:missionConfig>
      <wpml:flyToWaylineMode>${m.flyToWaylineMode}</wpml:flyToWaylineMode>
      <wpml:finishAction>${m.finishAction}</wpml:finishAction>
      <wpml:exitOnRCLost>${m.exitOnRCLost}</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>${m.executeRCLostAction}</wpml:executeRCLostAction>${takeOff}
      <wpml:globalTransitionalSpeed>${num(m.transitionalSpeed, 1)}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${p.droneEnumValue}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${p.droneSubEnumValue}</wpml:droneSubEnumValue>
      </wpml:droneInfo>${payload}
    </wpml:missionConfig>`;
}

/**
 * Satu action group. DJI Fly memakai mode `parallel` dan menomori actionId
 * mulai dari 1; kami ikut, karena satu-satunya contoh yang terbukti diterima
 * drone berbentuk begitu.
 */
function actionGroup({ id, startIndex, endIndex, actions }) {
  if (!actions.length) return '';

  return `
        <wpml:actionGroup>
          <wpml:actionGroupId>${id}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${startIndex}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${endIndex}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>parallel</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
          </wpml:actionTrigger>
${actions.join('\n')}
        </wpml:actionGroup>`;
}

function gimbalRotateAction(id, pitch) {
  return `          <wpml:action>
            <wpml:actionId>${id}</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:gimbalHeadingYawBase>aircraft</wpml:gimbalHeadingYawBase>
              <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
              <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
              <wpml:gimbalPitchRotateAngle>${num(pitch, 1)}</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateEnable>1</wpml:gimbalRollRotateEnable>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>
              <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
              <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
              <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
}

function takePhotoAction(id, index) {
  return `          <wpml:action>
            <wpml:actionId>${id}</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
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
 */
function headingParam(wp, m, i = 0) {
  const mode = wp.headingMode ?? m.headingMode;
  const angle = wp.heading ?? 0;
  const enable =
    mode === 'followWayline' ? (i === 0 ? 1 : 0) : mode === 'smoothTransition' ? 1 : 0;

  return `        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>${mode}</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>${num(angle, 1)}</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
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
  const groups = [];
  let groupId = 1;

  // Gimbal dipasang sekali di titik pertama, lalu dikunci lewat
  // waypointGimbalHeadingParam di tiap titik — persis pola file asli.
  if (i === 0 && wp.gimbalPitch !== undefined && wp.gimbalPitch !== null) {
    groups.push(
      actionGroup({
        id: groupId++,
        startIndex: 0,
        endIndex: 0,
        actions: [gimbalRotateAction(1, wp.gimbalPitch)],
      })
    );
  }

  const perPoint = [];
  let actionId = 1;
  if (wp.hoverTime) perPoint.push(hoverAction(actionId++, wp.hoverTime));
  if (wp.takePhoto) perPoint.push(takePhotoAction(actionId++, i));

  if (perPoint.length) {
    groups.push(
      actionGroup({ id: groupId++, startIndex: i, endIndex: i, actions: perPoint })
    );
  }

  if (i === 0) groups.push(intervalActionGroup(m, total - 1, 900));

  const gimbalHeading =
    wp.gimbalPitch === undefined || wp.gimbalPitch === null
      ? ''
      : `
        <wpml:waypointGimbalHeadingParam>
          <wpml:waypointGimbalPitchAngle>${num(wp.gimbalPitch, 1)}</wpml:waypointGimbalPitchAngle>
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

export function buildWaylinesWpml(mission, profile) {
  const djifly = dialectOf(profile) === 'djifly';
  const total = mission.waypoints.length;

  // DJI Fly menulis 0 untuk keduanya dan menghitung sendiri saat memuat.
  // Angka hasil hitungan kita dulu ditulis di sini; kalau ternyata dipakai
  // mentah-mentah oleh drone, angka yang meleset lebih berbahaya daripada
  // nol yang jujur.
  let distance = 0;
  let duration = 0;

  if (!djifly) {
    const pts = mission.waypoints.map((w) => ({ lat: w.lat, lng: w.lng }));
    distance = pathLength(pts);
    const hover = mission.waypoints.reduce((s, w) => s + (w.hoverTime || 0), 0);
    const shots = mission.waypoints.filter((w) => w.takePhoto).length * 2;
    duration = distance / mission.speed + hover + shots;
  }

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
  takeOffSecurityHeight: 20, // hanya dipakai dialek enterprise
  transitionalSpeed: 2.5, // m/s menuju waypoint pertama
  headingMode: 'followWayline', // followWayline | manually | fixed | smoothTransition
  turnMode: 'toPointAndStopWithContinuityCurvature',
  turnDampingDist: 0,
  useStraightLine: 0,
};
