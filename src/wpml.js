// Generator file WPML (DJI Waypoint Mission) -> isi dari .kmz
//
// Struktur .kmz:
//   wpmz/
//     template.kml    <- definisi mission level "template" (yang diedit user di app)
//     waylines.wpml   <- jalur terbang terkompilasi (yang benar-benar dieksekusi drone)
//
// CATATAN PENTING: spec WPML dipublikasikan DJI untuk produk Enterprise.
// Implementasi di DJI Fly (consumer, termasuk Mini 5 Pro) BELUM terkonfirmasi
// identik. Field yang ditandai [?] di profiles/*.json adalah tebakan yang perlu
// divalidasi dengan membandingkan file asli hasil export DJI Fly
// (pakai `npm run inspect -- <file.kmz>`).
import { pathLength } from './geo.js';

const NS = 'http://www.dji.com/wpmz/1.0.6';

const esc = (s) =>
  String(s).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]
  );

const num = (v, digits = 6) => {
  const s = Number(v).toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
};

/** Blok <wpml:missionConfig>, dipakai di template.kml maupun waylines.wpml. */
function missionConfig(m, p) {
  return `    <wpml:missionConfig>
      <wpml:flyToWaylineMode>${m.flyToWaylineMode}</wpml:flyToWaylineMode>
      <wpml:finishAction>${m.finishAction}</wpml:finishAction>
      <wpml:exitOnRCLost>${m.exitOnRCLost}</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>${m.executeRCLostAction}</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>${num(m.takeOffSecurityHeight, 1)}</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${num(m.transitionalSpeed, 1)}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${p.droneEnumValue}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${p.droneSubEnumValue}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
      <wpml:payloadInfo>
        <wpml:payloadEnumValue>${p.payloadEnumValue}</wpml:payloadEnumValue>
        <wpml:payloadSubEnumValue>${p.payloadSubEnumValue}</wpml:payloadSubEnumValue>
        <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
      </wpml:payloadInfo>
    </wpml:missionConfig>`;
}

/** Action group per waypoint: atur gimbal, hover, ambil foto. */
function actionGroup(wp, index) {
  const actions = [];
  let id = 0;

  if (wp.gimbalPitch !== undefined && wp.gimbalPitch !== null) {
    actions.push(`        <wpml:action>
          <wpml:actionId>${id++}</wpml:actionId>
          <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            <wpml:gimbalHeadingYawBase>aircraft</wpml:gimbalHeadingYawBase>
            <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
            <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
            <wpml:gimbalPitchRotateAngle>${num(wp.gimbalPitch, 1)}</wpml:gimbalPitchRotateAngle>
            <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>
            <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
            <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>
            <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
            <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
            <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);
  }

  if (wp.hoverTime) {
    actions.push(`        <wpml:action>
          <wpml:actionId>${id++}</wpml:actionId>
          <wpml:actionActuatorFunc>hover</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:hoverTime>${num(wp.hoverTime, 1)}</wpml:hoverTime>
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);
  }

  if (wp.takePhoto) {
    actions.push(`        <wpml:action>
          <wpml:actionId>${id++}</wpml:actionId>
          <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            <wpml:fileSuffix>wp${index}</wpml:fileSuffix>
            <wpml:useGlobalPayloadLensIndex>1</wpml:useGlobalPayloadLensIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>`);
  }

  if (!actions.length) return '';

  return `
      <wpml:actionGroup>
        <wpml:actionGroupId>${index}</wpml:actionGroupId>
        <wpml:actionGroupStartIndex>${index}</wpml:actionGroupStartIndex>
        <wpml:actionGroupEndIndex>${index}</wpml:actionGroupEndIndex>
        <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
        <wpml:actionTrigger>
          <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
        </wpml:actionTrigger>
${actions.join('\n')}
      </wpml:actionGroup>`;
}

/**
 * Action group tingkat jalur: memotret berulang sepanjang wayline.
 * Dipakai untuk mode mapping "continuous" — drone tidak berhenti di tiap foto,
 * tapi menjepret tiap N meter (atau tiap N detik). Jauh lebih cepat daripada
 * stop-and-shoot, dan jumlah waypoint-nya jauh lebih sedikit.
 */
function intervalActionGroup(m, lastIndex) {
  const iv = m.intervalShooting;
  if (!iv) return '';
  const triggerType = iv.mode === 'time' ? 'multipleTiming' : 'multipleDistance';
  return `
      <wpml:actionGroup>
        <wpml:actionGroupId>900</wpml:actionGroupId>
        <wpml:actionGroupStartIndex>0</wpml:actionGroupStartIndex>
        <wpml:actionGroupEndIndex>${lastIndex}</wpml:actionGroupEndIndex>
        <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
        <wpml:actionTrigger>
          <wpml:actionTriggerType>${triggerType}</wpml:actionTriggerType>
          <wpml:actionTriggerParam>${num(iv.value, 2)}</wpml:actionTriggerParam>
        </wpml:actionTrigger>
        <wpml:action>
          <wpml:actionId>0</wpml:actionId>
          <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
          <wpml:actionActuatorFuncParam>
            <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            <wpml:fileSuffix>seq</wpml:fileSuffix>
            <wpml:useGlobalPayloadLensIndex>1</wpml:useGlobalPayloadLensIndex>
          </wpml:actionActuatorFuncParam>
        </wpml:action>
      </wpml:actionGroup>`;
}

function headingParam(wp, m) {
  const mode = wp.headingMode ?? m.headingMode;
  const angle = wp.heading ?? 0;
  const enable = mode === 'smoothTransition' ? 1 : 0;
  return `      <wpml:waypointHeadingParam>
        <wpml:waypointHeadingMode>${mode}</wpml:waypointHeadingMode>
        <wpml:waypointHeadingAngle>${num(angle, 1)}</wpml:waypointHeadingAngle>
        <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
        <wpml:waypointHeadingAngleEnable>${enable}</wpml:waypointHeadingAngleEnable>
        <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
      </wpml:waypointHeadingParam>`;
}

function turnParam(m) {
  return `      <wpml:waypointTurnParam>
        <wpml:waypointTurnMode>${m.turnMode}</wpml:waypointTurnMode>
        <wpml:waypointTurnDampingDist>${num(m.turnDampingDist, 1)}</wpml:waypointTurnDampingDist>
      </wpml:waypointTurnParam>`;
}

/** Placemark untuk template.kml (level "apa yang user rencanakan"). */
function templatePlacemark(wp, i, m, total) {
  return `      <Placemark>
        <Point>
          <coordinates>${num(wp.lng, 10)},${num(wp.lat, 10)}</coordinates>
        </Point>
        <wpml:index>${i}</wpml:index>
        <wpml:ellipsoidHeight>${num(wp.height, 2)}</wpml:ellipsoidHeight>
        <wpml:height>${num(wp.height, 2)}</wpml:height>
        <wpml:useGlobalHeight>0</wpml:useGlobalHeight>
        <wpml:useGlobalSpeed>0</wpml:useGlobalSpeed>
        <wpml:waypointSpeed>${num(wp.speed ?? m.speed, 1)}</wpml:waypointSpeed>
        <wpml:useGlobalHeadingParam>0</wpml:useGlobalHeadingParam>
${headingParam(wp, m)}
        <wpml:useGlobalTurnParam>0</wpml:useGlobalTurnParam>
${turnParam(m)}
        <wpml:useStraightLine>1</wpml:useStraightLine>${actionGroup(wp, i)}${i === 0 ? intervalActionGroup(m, total - 1) : ''}
      </Placemark>`;
}

/** Placemark untuk waylines.wpml (level "apa yang drone eksekusi"). */
function waylinePlacemark(wp, i, m, total) {
  return `      <Placemark>
        <Point>
          <coordinates>${num(wp.lng, 10)},${num(wp.lat, 10)}</coordinates>
        </Point>
        <wpml:index>${i}</wpml:index>
        <wpml:executeHeight>${num(wp.height, 2)}</wpml:executeHeight>
        <wpml:waypointSpeed>${num(wp.speed ?? m.speed, 1)}</wpml:waypointSpeed>
${headingParam(wp, m)}
${turnParam(m)}
        <wpml:useStraightLine>1</wpml:useStraightLine>${actionGroup(wp, i)}${i === 0 ? intervalActionGroup(m, total - 1) : ''}
      </Placemark>`;
}

export function buildTemplateKml(mission, profile) {
  const now = Date.now();
  const wps = mission.waypoints.map((wp, i) => templatePlacemark(wp, i, mission, mission.waypoints.length)).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${NS}">
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
      <wpml:caliFlightEnable>0</wpml:caliFlightEnable>
      <wpml:gimbalPitchMode>usePointSetting</wpml:gimbalPitchMode>
      <wpml:globalWaypointHeadingParam>
        <wpml:waypointHeadingMode>${mission.headingMode}</wpml:waypointHeadingMode>
        <wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle>
        <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
        <wpml:waypointHeadingAngleEnable>0</wpml:waypointHeadingAngleEnable>
        <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
      </wpml:globalWaypointHeadingParam>
      <wpml:globalWaypointTurnMode>${mission.turnMode}</wpml:globalWaypointTurnMode>
      <wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>
${wps}
    </Folder>
  </Document>
</kml>
`;
}

export function buildWaylinesWpml(mission, profile) {
  const pts = mission.waypoints.map((w) => ({ lat: w.lat, lng: w.lng }));
  const dist = pathLength(pts);
  // Estimasi kasar: jarak / kecepatan + total hover + ~2 detik per jepretan.
  const hover = mission.waypoints.reduce((s, w) => s + (w.hoverTime || 0), 0);
  const shots = mission.waypoints.filter((w) => w.takePhoto).length * 2;
  const duration = dist / mission.speed + hover + shots;

  const wps = mission.waypoints.map((wp, i) => waylinePlacemark(wp, i, mission, mission.waypoints.length)).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${NS}">
  <Document>
${missionConfig(mission, profile)}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>${mission.heightMode}</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>${num(dist, 2)}</wpml:distance>
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

/** Nilai default mission — bisa ditimpa lewat CLI. */
export const MISSION_DEFAULTS = {
  author: 'waypoint-dji',
  speed: 5, // m/s kecepatan jelajah
  height: 30, // meter, relatif terhadap titik take-off
  heightMode: 'relativeToStartPoint', // relativeToStartPoint | EGM96 | realTimeFollowSurface
  flyToWaylineMode: 'safely', // safely | pointToPoint
  finishAction: 'goHome', // goHome | noAction | autoLand | gotoFirstWaypoint
  exitOnRCLost: 'executeLostAction', // goContinue | executeLostAction
  executeRCLostAction: 'goBack', // goBack | landing | hover
  takeOffSecurityHeight: 20, // meter
  transitionalSpeed: 6, // m/s menuju waypoint pertama
  headingMode: 'followWayline', // followWayline | manually | fixed | smoothTransition
  turnMode: 'toPointAndStopWithDiscontinuityCurvature',
  turnDampingDist: 0,
};
