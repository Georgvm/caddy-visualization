import * as THREE from 'three';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import './styles.css';

const SCENE_LIMIT_METERS = 42;
const MAP_CENTER = 110;
const MAP_SCALE = 2.45;
const MAPBOX_ACCESS_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? '';
const ROUTE_START = { latitude: 37.42885, longitude: -122.17315 };
const ROUTE_END = { latitude: 37.42874, longitude: -122.17265 };
const ROUTE_ANIMATION_SECONDS = 12;
const MAPBOX_CAMERA_BEARING_OFFSET = 0;
const CART_MODEL_YAW_OFFSET = 0;
const CART_MODEL_PATH = '/models/Electric_Cart.fbx';
const START_CART_MODEL_TARGET_LENGTH = 3.15;
const DRIVE_CART_MODEL_SCALE = 0.2;
const EGO_OBJECT_CLEAR_RADIUS_METERS = 3.4;
const START_CAMERA_POSITION = new THREE.Vector3(-3.9, 2.65, 4.8);
const START_CAMERA_TARGET = new THREE.Vector3(0, 0.92, 0.18);
const DRIVE_CAMERA_POSITION = new THREE.Vector3(0, 8.5, 13);
const DRIVE_CAMERA_TARGET = new THREE.Vector3(0, 0, 0);
const START_CART_YAW = 0;
const START_TRANSITION_MS = 1800;
const CAMERA_RETURN_POSITION_LERP = 0.16;
const MAP_CAMERA_BASE_ZOOM = 18.7;
const MAP_CAMERA_BASE_PITCH = 58;
const MAP_CAMERA_RETURN_DELAY_MS = 560;
const MAP_CAMERA_RETURN_LERP = 0.12;
const DATA_SOURCES = [
  { type: 'segmentation', path: '/data/segmentation.json' },
  { type: 'sparsedrive', path: '/data/bev_predictions.json' }
];

mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;
if (!MAPBOX_ACCESS_TOKEN) {
  console.warn('Missing VITE_MAPBOX_ACCESS_TOKEN. Add it to .env.local to render the Mapbox scene.');
}

const telemetry = createMapboxRouteTelemetry();
const SOURCE_FRAME_INTERVAL_MS = 1000 / telemetry.frameRateHz;
const REPLAY_SPEED = 1;
const FRAME_INTERVAL_MS = SOURCE_FRAME_INTERVAL_MS / REPLAY_SPEED;
const INTERPOLATION_LOOP_FRAMES = Math.max(1, telemetry.frames.length - 1);

const root = document.getElementById('root');
root.innerHTML = `
  <main class="screen">
    <div class="mapbox-scene" aria-label="Map route visualization"></div>
    <div class="scene-canvas" aria-label="3D autonomy visualization"></div>
    <section class="start-screen" aria-label="Start drive">
      <h1>Hey, Sam!</h1>
      <button class="start-button" type="button">Start</button>
    </section>
    <section class="hud is-hidden" aria-label="Autonomous golf cart dashboard">
      <div class="autonomy-status" aria-label="Self driving status">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5.1 13.4a7 7 0 1 1 13.8 0" />
          <path d="M8.1 13.9a4 4 0 0 1 7.8 0" />
          <path d="M4.6 14.4c2.3 1.7 4.8 2.5 7.4 2.5s5.1-.8 7.4-2.5" />
          <path d="M12 16.9v3.1" />
        </svg>
      </div>
      <div class="speed-readout" aria-label="Speed">
        <span class="speed-number">0</span>
        <span class="speed-unit">mph</span>
      </div>
      <div class="mini-map" aria-label="Campus route map">
        <div class="mini-map-clip">
          <svg viewBox="0 0 220 220" role="img">
            <defs>
              <linearGradient id="mapRouteGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#4a9dff" />
                <stop offset="100%" stop-color="#176fff" />
              </linearGradient>
              <radialGradient id="mapSurfaceGradient" cx="48%" cy="43%" r="62%">
                <stop offset="0%" stop-color="#ffffff" />
                <stop offset="62%" stop-color="#fbfdff" />
                <stop offset="100%" stop-color="#eef4f9" />
              </radialGradient>
            </defs>
            <circle cx="110" cy="110" r="122" fill="url(#mapSurfaceGradient)" />
            <g class="map-roads" stroke-linecap="round" fill="none">
              <path d="M26 52 C74 66 95 40 143 52 C180 61 193 86 202 116" />
              <path d="M33 155 C78 128 113 151 154 135 C181 125 198 101 207 82" />
              <path d="M66 22 C69 76 55 119 77 198" />
              <path d="M132 19 C121 70 136 120 122 201" />
            </g>
            <polyline class="map-route" points="" />
            <circle class="map-cart" cx="75" cy="142" r="8" />
            <g class="map-pin" transform="translate(156 39)">
              <path d="M12 0C5.4 0 0 5.4 0 12c0 8.8 12 22 12 22s12-13.2 12-22C24 5.4 18.6 0 12 0z" />
              <circle cx="12" cy="12" r="5" />
            </g>
          </svg>
        </div>
        <span class="map-fade map-fade-outer" aria-hidden="true"></span>
        <span class="map-fade map-fade-inner" aria-hidden="true"></span>
        <span class="map-stroke map-stroke-soft" aria-hidden="true"></span>
        <span class="map-stroke map-stroke-hard" aria-hidden="true"></span>
      </div>
    </section>
  </main>
`;

const ui = {
  screen: document.querySelector('.screen'),
  mapbox: document.querySelector('.mapbox-scene'),
  startScreen: document.querySelector('.start-screen'),
  startButton: document.querySelector('.start-button'),
  hud: document.querySelector('.hud'),
  speed: document.querySelector('.speed-number'),
  autonomy: document.querySelector('.autonomy-status'),
  route: document.querySelector('.map-route'),
  cart: document.querySelector('.map-cart'),
  pin: document.querySelector('.map-pin')
};

let currentFrame = telemetry.frames[0];
let replayStartMs = performance.now();
let driveStarted = false;
let transitionStartMs = null;
updateHud(currentFrame);

const mapboxMap = initMapboxMap(ui.mapbox);
initScene(document.querySelector('.scene-canvas'), mapboxMap);

ui.startButton.addEventListener('click', () => {
  if (driveStarted) return;
  driveStarted = true;
  transitionStartMs = performance.now();
  replayStartMs = transitionStartMs;
  ui.screen.classList.add('is-driving');
  ui.startScreen.setAttribute('aria-hidden', 'true');
  ui.hud.classList.remove('is-hidden');
});

function updateHud(frame) {
  ui.speed.textContent = frame.speedMph;
  ui.autonomy.classList.toggle('is-active', frame.selfDriving);
  ui.autonomy.classList.toggle('is-inactive', !frame.selfDriving);
  ui.autonomy.setAttribute('aria-label', `Self driving ${frame.selfDriving ? 'active' : 'inactive'}`);
  ui.route.setAttribute('points', frame.route.map((point) => `${point.x},${point.y}`).join(' '));
  ui.cart.setAttribute('cx', frame.position.x);
  ui.cart.setAttribute('cy', frame.position.y);
  ui.pin.setAttribute('transform', `translate(${frame.destination.x - 12} ${frame.destination.y - 28})`);
}

function createMapboxRouteTelemetry() {
  const frameRateHz = 30;
  const frameCount = ROUTE_ANIMATION_SECONDS * frameRateHz;
  const routeCoordinates = interpolatedRouteCoordinates(ROUTE_START, ROUTE_END, 120);
  const routeBearingDegrees = bearingBetweenCoordinates(ROUTE_START, ROUTE_END);
  const routeLengthMeters = distanceBetweenCoordinates(ROUTE_START, ROUTE_END);
  const speedMph = Math.round((routeLengthMeters / ROUTE_ANIMATION_SECONDS) * 2.23694);

  return {
    frameRateHz,
    routeCoordinates,
    routeBearingDegrees,
    frames: Array.from({ length: frameCount }, (_, index) => {
      const progress = index / (frameCount - 1);
      const coordinate = interpolateCoordinate(ROUTE_START, ROUTE_END, progress);
      const remainingCoordinates = [
        coordinate,
        ...routeCoordinates.slice(Math.min(routeCoordinates.length - 1, Math.floor(progress * (routeCoordinates.length - 1)) + 1))
      ];
      const localPath = createRouteLocalPath(progress);
      const route = localPath.map(toMapPoint);

      return {
        frameIdx: index,
        speedMph,
        selfDriving: true,
        position: { x: MAP_CENTER, y: MAP_CENTER },
        destination: route.at(-1) ?? { x: MAP_CENTER, y: 48 },
        route,
        predictedPath: localPath.map(toScenePoint),
        mapElements: [],
        objects: [],
        mapbox: {
          coordinate,
          progress,
          remainingCoordinates,
          bearing: routeBearingDegrees
        }
      };
    })
  };
}

function initMapboxMap(container) {
  const midpoint = interpolateCoordinate(ROUTE_START, ROUTE_END, 0.5);
  const map = new mapboxgl.Map({
    container,
    style: 'mapbox://styles/mapbox/standard',
    center: [midpoint.longitude, midpoint.latitude],
    zoom: 17.2,
    bearing: 0,
    pitch: 45,
    attributionControl: false,
    logoPosition: 'bottom-left',
    interactive: false,
    config: {
      basemap: {
        lightPreset: 'day',
        theme: 'monochrome',
        showPedestrianRoads: false,
        showRoadsAndTransit: false,
        showRoadLabels: false,
        showPlaceLabels: true,
        showPointOfInterestLabels: true,
        showTransitLabels: false,
        show3dObjects: true,
        show3dBuildings: true
      }
    }
  });

  map.on('style.load', () => {
    map.setProjection('globe');
    addMapboxRouteLayers(map);
    updateMapboxRoute(map, currentFrame);
  });

  return map;
}

function addMapboxRouteLayers(map) {
  if (!map.getSource('cart-route')) {
    map.addSource('cart-route', {
      type: 'geojson',
      data: createRouteFeatureCollection(telemetry.routeCoordinates)
    });
  }

  if (!map.getLayer('cart-route-casing')) {
    map.addLayer({
      id: 'cart-route-casing',
      type: 'line',
      source: 'cart-route',
      slot: 'top',
      layout: {
        'line-cap': 'round',
        'line-join': 'round'
      },
      paint: {
        'line-color': '#ffffff',
        'line-width': 12,
        'line-opacity': 0.88
      }
    });
  }

  if (!map.getLayer('cart-route-line')) {
    map.addLayer({
      id: 'cart-route-line',
      type: 'line',
      source: 'cart-route',
      slot: 'top',
      layout: {
        'line-cap': 'round',
        'line-join': 'round'
      },
      paint: {
        'line-color': '#1683ff',
        'line-width': 9,
        'line-opacity': 0.98
      }
    });
  }
}

function updateMapboxRoute(map, frame, cameraGestureState = null) {
  if (!map || !frame.mapbox || !map.getSource('cart-route')) return;

  const { coordinate, bearing } = frame.mapbox;
  const source = map.getSource('cart-route');
  if (source) source.setData(createRouteFeatureCollection(telemetry.routeCoordinates));
  const bearingOffset = cameraGestureState?.bearingOffset ?? 0;
  const pitchOffset = cameraGestureState?.pitchOffset ?? 0;
  const zoomOffset = cameraGestureState?.zoomOffset ?? 0;

  map.jumpTo({
    center: [coordinate.longitude, coordinate.latitude],
    zoom: clamp(MAP_CAMERA_BASE_ZOOM + zoomOffset, 16.9, 20.2),
    bearing: bearing + MAPBOX_CAMERA_BEARING_OFFSET + bearingOffset,
    pitch: clamp(MAP_CAMERA_BASE_PITCH + pitchOffset, 25, 75)
  });
}

function createRouteFeatureCollection(coordinates) {
  const lineCoordinates = coordinates.length >= 2
    ? coordinates
    : [coordinates[0] ?? ROUTE_END, ROUTE_END];

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: lineCoordinates.map((coordinate) => [coordinate.longitude, coordinate.latitude])
        }
      }
    ]
  };
}

function createRouteLocalPath(progress) {
  const routeLengthMeters = distanceBetweenCoordinates(ROUTE_START, ROUTE_END);
  const remainingMeters = routeLengthMeters * (1 - progress);
  const sampleCount = 10;
  return Array.from({ length: sampleCount }, (_, index) => {
    const forward = (remainingMeters * index) / (sampleCount - 1);
    return [0, forward];
  });
}

function interpolatedRouteCoordinates(start, end, steps) {
  return Array.from({ length: steps + 1 }, (_, index) => interpolateCoordinate(start, end, index / steps));
}

function interpolateCoordinate(start, end, progress) {
  return {
    latitude: start.latitude + (end.latitude - start.latitude) * progress,
    longitude: start.longitude + (end.longitude - start.longitude) * progress
  };
}

function distanceBetweenCoordinates(start, end) {
  const earthRadiusMeters = 6371000;
  const startLat = degreesToRadians(start.latitude);
  const endLat = degreesToRadians(end.latitude);
  const deltaLat = degreesToRadians(end.latitude - start.latitude);
  const deltaLon = degreesToRadians(end.longitude - start.longitude);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLon / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingBetweenCoordinates(start, end) {
  const startLatitude = degreesToRadians(start.latitude);
  const startLongitude = degreesToRadians(start.longitude);
  const endLatitude = degreesToRadians(end.latitude);
  const endLongitude = degreesToRadians(end.longitude);
  const longitudeDelta = endLongitude - startLongitude;
  const y = Math.sin(longitudeDelta) * Math.cos(endLatitude);
  const x = Math.cos(startLatitude) * Math.sin(endLatitude)
    - Math.sin(startLatitude) * Math.cos(endLatitude) * Math.cos(longitudeDelta);
  return (radiansToDegrees(Math.atan2(y, x)) + 360) % 360;
}

function degreesToRadians(value) {
  return value * Math.PI / 180;
}

function radiansToDegrees(value) {
  return value * 180 / Math.PI;
}

async function loadTelemetryData() {
  for (const source of DATA_SOURCES) {
    try {
      const response = await fetch(source.path, { cache: 'no-store' });
      if (!response.ok) continue;
      return {
        type: source.type,
        path: source.path,
        data: await response.json()
      };
    } catch (error) {
      console.warn(`Unable to load ${source.path}`, error);
    }
  }

  throw new Error('No telemetry data source found. Add public/data/segmentation.json or public/data/bev_predictions.json.');
}

function normalizeTelemetryData(source) {
  if (source.type === 'segmentation') {
    console.info(`Using segmentation data from ${source.path}`);
    return normalizeSegmentationData(source.data);
  }

  console.info(`Using SparseDrive data from ${source.path}`);
  return normalizeSparseDriveData(source.data);
}

function normalizeSegmentationData(data) {
  const frames = Array.isArray(data) ? data : data.frames ?? data.segmentation_frames ?? [];
  const frameRateHz = data.meta?.frame_rate_hz ?? data.frame_rate_hz ?? data.fps ?? 10;
  const pointOrder = data.meta?.point_order ?? data.point_order ?? 'lateral_forward';

  if (frames.length === 0) {
    throw new Error('Segmentation JSON must contain a non-empty frames array.');
  }

  return {
    frameRateHz,
    frames: frames.map((frame, index) => normalizeSegmentationFrame(frame, index, pointOrder, frameRateHz))
  };
}

function normalizeSegmentationFrame(frame, index, pointOrder, frameRateHz) {
  const predictedPath = normalizePointPath(
    pickFirst(frame.predictedPath, frame.predicted_path, frame.trajectory, frame.path, frame.planning?.final_xy),
    pointOrder
  );
  const fallbackPath = predictedPath.length >= 2 ? predictedPath : createDefaultPredictedPath();
  const route = fallbackPath.map(toMapPointFromScene);
  const destination = route.at(-1) ?? { x: MAP_CENTER, y: 48 };

  return {
    frameIdx: frame.frame_idx ?? frame.frameIndex ?? frame.index ?? index,
    speedMph: getFrameSpeedMph(frame, fallbackPath, frameRateHz),
    selfDriving: frame.selfDriving ?? frame.self_driving ?? frame.autonomous ?? true,
    position: { x: MAP_CENTER, y: MAP_CENTER },
    destination,
    route,
    predictedPath: fallbackPath,
    mapElements: collectSegmentationMapElements(frame, pointOrder),
    objects: collectSegmentationObjects(frame, pointOrder)
  };
}

function normalizeSparseDriveData(data) {
  const frameRateHz = data.meta?.frame_rate_hz ?? 2;
  const planStepSeconds = data.meta?.plan_step_seconds ?? 0.5;

  return {
    frameRateHz,
    frames: data.frames.map((frame) => {
      const finalPlan = frame.planning?.final_xy ?? [];
      const firstPlanPoint = finalPlan[0] ?? [0, 0];
      const speedMph = Math.round((Math.hypot(firstPlanPoint[0], firstPlanPoint[1]) / planStepSeconds) * 2.23694);
      const predictedPath = finalPlan.map(toScenePoint);
      const route = finalPlan.length > 0 ? finalPlan.map(toMapPoint) : [{ x: MAP_CENTER, y: MAP_CENTER }];
      const destination = route.at(-1) ?? { x: MAP_CENTER, y: 48 };

      return {
        frameIdx: frame.frame_idx,
        speedMph,
        selfDriving: true,
        position: { x: MAP_CENTER, y: MAP_CENTER },
        destination,
        route,
        predictedPath,
        mapElements: (frame.map_elements ?? [])
          .filter((element) => element.polyline?.length >= 2)
          .map((element) => ({
            type: element.class,
            score: element.score,
            points: element.polyline.map(toScenePoint).filter(isScenePointVisible)
          }))
          .filter((element) => element.points.length >= 2),
        objects: dedupeDetections(frame.detections ?? [])
          .slice(0, 24)
          .map(toSceneObject)
      };
    })
  };
}

function isSupportedDetection(detection) {
  const sceneX = detection.x;
  const sceneZ = -detection.y;

  return detection.score >= 0.25
    && Number.isFinite(detection.x)
    && Number.isFinite(detection.y)
    && Math.abs(detection.x) <= SCENE_LIMIT_METERS
    && Math.abs(detection.y) <= SCENE_LIMIT_METERS
    && Math.hypot(sceneX, sceneZ) > EGO_OBJECT_CLEAR_RADIUS_METERS
    && sceneZ < 12;
}

function dedupeDetections(detections) {
  const sorted = detections
    .filter(isSupportedDetection)
    .sort((a, b) => b.score - a.score);
  const kept = [];

  sorted.forEach((detection) => {
    const duplicate = kept.some((other) => {
      const distance = Math.hypot(detection.x - other.x, detection.y - other.y);
      return detection.class === other.class && distance < 1.6;
    });
    if (!duplicate) kept.push(detection);
  });

  return kept;
}

function toSceneObject(detection) {
  const dimensions = getDetectionDimensions(detection);
  return {
    id: detection.id,
    type: detection.class,
    x: clamp(detection.x, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS),
    z: clamp(-detection.y, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS),
    width: dimensions.width,
    length: dimensions.length,
    height: dimensions.height,
    heading: detection.yaw
  };
}

function getDetectionDimensions(detection) {
  if (detection.class === 'pedestrian') {
    return {
      width: 0.72,
      length: 0.72,
      height: clamp(detection.h, 1.35, 1.9)
    };
  }

  if (detection.class === 'motorcycle' || detection.class === 'bicycle') {
    return { width: 0.86, length: 2.15, height: 0.9 };
  }

  if (detection.class === 'truck' || detection.class === 'bus') {
    return { width: 2.45, length: 6.8, height: 1.55 };
  }

  const hasPlausibleCarSize = detection.w >= 1.25
    && detection.w <= 2.8
    && detection.l >= 2.7
    && detection.l <= 5.8;

  if (hasPlausibleCarSize) {
    return {
      width: detection.w,
      length: detection.l,
      height: clamp(detection.h, 0.9, 1.35)
    };
  }

  return { width: 1.9, length: 4.35, height: 1.08 };
}

function collectSegmentationMapElements(frame, pointOrder) {
  const nonObjectSegments = (items) => (items ?? []).filter((item) => !isObjectSegment(item));
  const elements = [
    ...normalizeSegmentationElementList(frame.lanes ?? frame.laneLines ?? frame.lane_lines, 'divider', pointOrder),
    ...normalizeSegmentationElementList(frame.boundaries ?? frame.road_edges ?? frame.edges, 'boundary', pointOrder),
    ...normalizeSegmentationElementList(frame.dividers, 'divider', pointOrder),
    ...normalizeSegmentationElementList(frame.segmentation?.lanes, 'divider', pointOrder),
    ...normalizeSegmentationElementList(frame.segmentation?.boundaries, 'boundary', pointOrder),
    ...normalizeSegmentationElementList(frame.segmentation?.polylines, 'divider', pointOrder),
    ...normalizeSegmentationElementList(nonObjectSegments(frame.segments), 'boundary', pointOrder),
    ...normalizeSegmentationElementList(nonObjectSegments(frame.segmentations), 'boundary', pointOrder),
    ...normalizeSegmentationElementList(nonObjectSegments(frame.polygons), 'boundary', pointOrder)
  ];

  return elements
    .filter((element) => element.points.length >= 2)
    .slice(0, 64);
}

function normalizeSegmentationElementList(items, fallbackType, pointOrder) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => normalizeSegmentationElement(item, fallbackType, pointOrder))
    .filter(Boolean);
}

function normalizeSegmentationElement(item, fallbackType, pointOrder) {
  if (!item) return null;
  const rawType = getItemClass(item);
  const type = getMapElementType(rawType, fallbackType);
  const rawPoints = Array.isArray(item)
    ? item
    : item.points ?? item.polyline ?? item.centerline ?? item.polygon ?? item.vertices;
  let points = normalizePointPath(rawPoints, item.point_order ?? pointOrder);

  if ((item.polygon || item.vertices) && points.length >= 3) {
    points = [...points, points[0]];
  }

  if (points.length < 2) return null;
  return {
    type,
    score: item.score ?? item.confidence ?? item.probability ?? 1,
    points: points.filter(isScenePointVisible)
  };
}

function getMapElementType(rawType, fallbackType) {
  const label = String(rawType ?? fallbackType).toLowerCase();
  if (label.includes('lane') || label.includes('divider') || label.includes('line') || label.includes('center')) return 'divider';
  return 'boundary';
}

function collectSegmentationObjects(frame, pointOrder) {
  const candidates = [
    ...(frame.objects ?? []),
    ...(frame.detections ?? []),
    ...(frame.segmentation?.objects ?? []),
    ...(frame.segments ?? []).filter(isObjectSegment),
    ...(frame.segmentations ?? []).filter(isObjectSegment),
    ...(frame.polygons ?? []).filter(isObjectSegment)
  ];

  return candidates
    .map((item) => normalizeSegmentationObject(item, pointOrder))
    .filter(Boolean)
    .slice(0, 32);
}

function normalizeSegmentationObject(item, pointOrder) {
  if (!item) return null;
  const type = getObjectType(getItemClass(item));
  const point = normalizeObjectCenter(item, pointOrder);
  if (!point) return null;

  const polygonPoints = normalizePointPath(item.polygon ?? item.vertices, item.point_order ?? pointOrder);
  const bounds = polygonPoints.length > 0 ? getSceneBounds(polygonPoints) : null;
  const width = Number(item.width ?? item.w ?? bounds?.width);
  const length = Number(item.length ?? item.l ?? bounds?.length);
  const height = Number(item.height ?? item.h);
  const dimensions = getSegmentationObjectDimensions(type, width, length, height);

  return {
    id: item.id,
    type,
    x: clamp(point.x, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS),
    z: clamp(point.z, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS),
    width: dimensions.width,
    length: dimensions.length,
    height: dimensions.height,
    heading: item.heading ?? item.yaw ?? item.rotation ?? 0
  };
}

function normalizeObjectCenter(item, pointOrder) {
  const center = item.center ?? item.centroid ?? item.position ?? item.location;
  if (center) return normalizePoint(center, item.point_order ?? pointOrder);
  if (Number.isFinite(item.x) && Number.isFinite(item.z)) return { x: item.x, z: item.z };
  if (Number.isFinite(item.x) && Number.isFinite(item.y)) return normalizePoint([item.x, item.y], item.point_order ?? pointOrder);

  const polygonPoints = normalizePointPath(item.polygon ?? item.vertices, item.point_order ?? pointOrder);
  if (polygonPoints.length === 0) return null;
  return getPathCenter(polygonPoints);
}

function isObjectSegment(item) {
  const label = String(getItemClass(item)).toLowerCase();
  return ['car', 'truck', 'bus', 'vehicle', 'pedestrian', 'person', 'cyclist', 'bicycle', 'motorcycle', 'object']
    .some((name) => label.includes(name));
}

function getObjectType(rawType) {
  const label = String(rawType ?? 'object').toLowerCase();
  if (label.includes('pedestrian') || label.includes('person')) return 'pedestrian';
  if (label.includes('bicycle') || label.includes('cyclist')) return 'bicycle';
  if (label.includes('motorcycle')) return 'motorcycle';
  if (label.includes('truck')) return 'truck';
  if (label.includes('bus')) return 'bus';
  return 'car';
}

function getSegmentationObjectDimensions(type, width, length, height) {
  if (type === 'pedestrian') {
    return {
      width: Number.isFinite(width) ? clamp(width, 0.45, 0.9) : 0.72,
      length: Number.isFinite(length) ? clamp(length, 0.45, 0.9) : 0.72,
      height: Number.isFinite(height) ? clamp(height, 1.35, 1.9) : 1.72
    };
  }

  if (type === 'motorcycle' || type === 'bicycle') {
    return {
      width: Number.isFinite(width) ? clamp(width, 0.55, 1.2) : 0.86,
      length: Number.isFinite(length) ? clamp(length, 1.3, 2.6) : 2.15,
      height: Number.isFinite(height) ? clamp(height, 0.7, 1.35) : 0.9
    };
  }

  if (type === 'truck' || type === 'bus') {
    return {
      width: Number.isFinite(width) ? clamp(width, 2.1, 2.8) : 2.45,
      length: Number.isFinite(length) ? clamp(length, 5.2, 8.5) : 6.8,
      height: Number.isFinite(height) ? clamp(height, 1.3, 2.2) : 1.55
    };
  }

  return {
    width: Number.isFinite(width) ? clamp(width, 1.5, 2.4) : 1.9,
    length: Number.isFinite(length) ? clamp(length, 3.4, 5.2) : 4.35,
    height: Number.isFinite(height) ? clamp(height, 0.9, 1.45) : 1.08
  };
}

function normalizePointPath(points, pointOrder) {
  if (!Array.isArray(points)) return [];
  return points
    .map((point) => normalizePoint(point, pointOrder))
    .filter(Boolean)
    .filter(isScenePointVisible);
}

function normalizePoint(point, pointOrder = 'lateral_forward') {
  if (Array.isArray(point)) {
    const first = Number(point[0]);
    const second = Number(point[1]);
    if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
    return isForwardLateralPointOrder(pointOrder)
      ? { x: clamp(second, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS), z: clamp(-first, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS) }
      : { x: clamp(first, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS), z: clamp(-second, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS) };
  }

  if (!point || typeof point !== 'object') return null;
  if (Number.isFinite(point.x) && Number.isFinite(point.z)) {
    return {
      x: clamp(point.x, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS),
      z: clamp(point.z, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS)
    };
  }

  const isForwardFirst = isForwardLateralPointOrder(pointOrder);
  const lateral = Number(pickFirst(point.lateral, point.lateral_m, point.y_lat, point.left, isForwardFirst ? point.y : point.x));
  const forward = Number(pickFirst(point.forward, point.forward_m, point.x_fwd, point.distance, isForwardFirst ? point.x : point.y));
  if (!Number.isFinite(lateral) || !Number.isFinite(forward)) return null;

  return {
    x: clamp(lateral, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS),
    z: clamp(-forward, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS)
  };
}

function isForwardLateralPointOrder(pointOrder) {
  return pointOrder === 'forward_lateral' || pointOrder === 'x_forward_y_left';
}

function createDefaultPredictedPath() {
  return [0, 3, 6, 9, 12, 15].map((forward) => ({ x: 0, z: -forward }));
}

function getFrameSpeedMph(frame, path, frameRateHz) {
  if (Number.isFinite(frame.speedMph)) return Math.round(frame.speedMph);
  if (Number.isFinite(frame.speed_mph)) return Math.round(frame.speed_mph);
  if (Number.isFinite(frame.speed_mps)) return Math.round(frame.speed_mps * 2.23694);
  if (Number.isFinite(frame.speed)) return Math.round(frame.speed);

  const start = path[0] ?? { x: 0, z: 0 };
  const next = path[1] ?? start;
  return Math.round(Math.hypot(next.x - start.x, next.z - start.z) * frameRateHz * 2.23694);
}

function getSceneBounds(points) {
  const xs = points.map((point) => point.x);
  const zs = points.map((point) => point.z);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    length: Math.max(...zs) - Math.min(...zs)
  };
}

function getItemClass(item) {
  return item?.class ?? item?.label ?? item?.type ?? item?.category ?? item?.name;
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function toScenePoint([lateral, forward]) {
  return {
    x: clamp(lateral, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS),
    z: clamp(-forward, -SCENE_LIMIT_METERS, SCENE_LIMIT_METERS)
  };
}

function toMapPoint([lateral, forward]) {
  return {
    x: clamp(MAP_CENTER + lateral * MAP_SCALE, 18, 202),
    y: clamp(MAP_CENTER - forward * MAP_SCALE, 18, 202)
  };
}

function toMapPointFromScene(point) {
  return {
    x: clamp(MAP_CENTER + point.x * MAP_SCALE, 18, 202),
    y: clamp(MAP_CENTER + point.z * MAP_SCALE, 18, 202)
  };
}

function isScenePointVisible(point) {
  return Math.abs(point.x) < SCENE_LIMIT_METERS && Math.abs(point.z) < SCENE_LIMIT_METERS;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getInterpolatedFrame(nowMs) {
  const replayFrame = ((nowMs - replayStartMs) / FRAME_INTERVAL_MS) % INTERPOLATION_LOOP_FRAMES;
  const frameAIndex = Math.floor(replayFrame);
  const frameBIndex = (frameAIndex + 1) % telemetry.frames.length;
  const alpha = smoothstep(replayFrame - frameAIndex);

  return interpolateFrames(telemetry.frames[frameAIndex], telemetry.frames[frameBIndex], alpha);
}

function interpolateFrames(frameA, frameB, alpha) {
  return {
    frameIdx: frameA.frameIdx,
    speedMph: Math.round(lerp(frameA.speedMph, frameB.speedMph, alpha)),
    selfDriving: alpha < 0.5 ? frameA.selfDriving : frameB.selfDriving,
    position: lerpPoint2(frameA.position, frameB.position, alpha),
    destination: lerpPoint2(frameA.destination, frameB.destination, alpha),
    route: interpolatePointPath(frameA.route, frameB.route, alpha),
    predictedPath: interpolatePointPath(frameA.predictedPath, frameB.predictedPath, alpha),
    mapElements: interpolateMapElements(frameA.mapElements, frameB.mapElements, alpha),
    objects: interpolateObjects(frameA.objects, frameB.objects, alpha),
    mapbox: interpolateMapboxFrame(frameA.mapbox, frameB.mapbox, alpha)
  };
}

function interpolateMapboxFrame(mapboxA, mapboxB, alpha) {
  if (!mapboxA || !mapboxB) return mapboxA ?? mapboxB;
  const progress = lerp(mapboxA.progress, mapboxB.progress, alpha);

  return {
    progress,
    coordinate: interpolateCoordinate(ROUTE_START, ROUTE_END, progress),
    remainingCoordinates: mapboxA.remainingCoordinates,
    bearing: lerp(mapboxA.bearing, mapboxB.bearing, alpha)
  };
}

function interpolateMapElements(elementsA, elementsB, alpha) {
  const usedB = new Set();
  const result = [];

  elementsA.forEach((elementA) => {
    const matchIndex = findNearestMapElementIndex(elementA, elementsB, usedB);
    if (matchIndex === -1) {
      result.push(elementA);
      return;
    }

    usedB.add(matchIndex);
    const elementB = elementsB[matchIndex];
    result.push({
      type: alpha < 0.5 ? elementA.type : elementB.type,
      score: lerp(elementA.score ?? 1, elementB.score ?? 1, alpha),
      points: interpolatePointPath(elementA.points, elementB.points, alpha)
    });
  });

  elementsB.forEach((elementB, index) => {
    if (!usedB.has(index) && alpha > 0.7) result.push(elementB);
  });

  return result;
}

function findNearestMapElementIndex(element, candidates, used) {
  const center = getPathCenter(element.points);
  let bestIndex = -1;
  let bestDistance = Infinity;

  candidates.forEach((candidate, index) => {
    if (used.has(index) || candidate.type !== element.type) return;
    const candidateCenter = getPathCenter(candidate.points);
    const distance = Math.hypot(center.x - candidateCenter.x, center.z - candidateCenter.z);
    if (distance < bestDistance && distance < 4.8) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function interpolateObjects(objectsA, objectsB, alpha) {
  const usedB = new Set();
  const result = [];

  objectsA.forEach((objectA) => {
    const matchIndex = findNearestObjectIndex(objectA, objectsB, usedB);
    if (matchIndex === -1) {
      result.push(objectA);
      return;
    }

    usedB.add(matchIndex);
    const objectB = objectsB[matchIndex];
    result.push({
      id: objectA.id,
      type: alpha < 0.5 ? objectA.type : objectB.type,
      x: lerp(objectA.x, objectB.x, alpha),
      z: lerp(objectA.z, objectB.z, alpha),
      width: lerp(objectA.width, objectB.width, alpha),
      length: lerp(objectA.length, objectB.length, alpha),
      height: lerp(objectA.height, objectB.height, alpha),
      heading: lerpAngle(objectA.heading ?? 0, objectB.heading ?? 0, alpha)
    });
  });

  objectsB.forEach((objectB, index) => {
    if (!usedB.has(index) && alpha > 0.65) result.push(objectB);
  });

  return result;
}

function findNearestObjectIndex(object, candidates, used) {
  let bestIndex = -1;
  let bestDistance = Infinity;

  candidates.forEach((candidate, index) => {
    if (used.has(index) || candidate.type !== object.type) return;
    const distance = Math.hypot(object.x - candidate.x, object.z - candidate.z);
    if (distance < bestDistance && distance < 5) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function interpolatePointPath(pathA, pathB, alpha) {
  const count = Math.max(pathA.length, pathB.length);
  if (count === 0) return [];
  if (pathA.length === 0) return pathB;
  if (pathB.length === 0) return pathA;

  return Array.from({ length: count }, (_, index) => {
    const pointA = samplePath(pathA, count, index);
    const pointB = samplePath(pathB, count, index);
    if ('y' in pointA || 'y' in pointB) return lerpPoint2(pointA, pointB, alpha);
    return lerpPoint3(pointA, pointB, alpha);
  });
}

function samplePath(path, targetCount, index) {
  if (path.length === 1 || targetCount === 1) return path[0];
  const sourceIndex = (index / (targetCount - 1)) * (path.length - 1);
  const lowerIndex = Math.floor(sourceIndex);
  const upperIndex = Math.min(path.length - 1, lowerIndex + 1);
  const alpha = sourceIndex - lowerIndex;
  const lower = path[lowerIndex];
  const upper = path[upperIndex];
  if ('y' in lower || 'y' in upper) return lerpPoint2(lower, upper, alpha);
  return lerpPoint3(lower, upper, alpha);
}

function getPathCenter(path) {
  const total = path.reduce((sum, point) => ({
    x: sum.x + point.x,
    z: sum.z + point.z
  }), { x: 0, z: 0 });

  return {
    x: total.x / path.length,
    z: total.z / path.length
  };
}

function lerp(start, end, alpha) {
  return start + (end - start) * alpha;
}

function lerpAngle(start, end, alpha) {
  const delta = Math.atan2(Math.sin(end - start), Math.cos(end - start));
  return start + delta * alpha;
}

function lerpPoint2(pointA, pointB, alpha) {
  return {
    x: lerp(pointA.x, pointB.x, alpha),
    y: lerp(pointA.y, pointB.y, alpha)
  };
}

function lerpPoint3(pointA, pointB, alpha) {
  return {
    x: lerp(pointA.x, pointB.x, alpha),
    z: lerp(pointA.z, pointB.z, alpha)
  };
}

function smoothstep(alpha) {
  return alpha * alpha * (3 - 2 * alpha);
}

function easeInOutCubic(alpha) {
  return alpha < 0.5
    ? 4 * alpha * alpha * alpha
    : 1 - ((-2 * alpha + 2) ** 3) / 2;
}

function initScene(mount, mapboxMap) {
  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 0.1, 120);
  camera.position.copy(START_CAMERA_POSITION);
  camera.lookAt(START_CAMERA_TARGET);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0xffffff, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.appendChild(renderer.domElement);

  const mapCameraGestureState = createMapCameraGestureState(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xdde4ea, 2.4));

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
  keyLight.position.set(-5, 8, 8);
  keyLight.castShadow = true;
  scene.add(keyLight);

  scene.add(createGround());

  const prediction = createPredictionPath();
  prediction.visible = false;
  scene.add(prediction);

  const cart = new THREE.Group();
  scene.add(cart);

  const mapLayer = new THREE.Group();
  mapLayer.visible = false;
  scene.add(mapLayer);

  const objectLayer = new THREE.Group();
  objectLayer.visible = false;
  scene.add(objectLayer);

  const fbxLoader = new FBXLoader();
  loadModelIfAvailable(fbxLoader, CART_MODEL_PATH, (model) => {
    disposeChildren(cart);
    cart.clear();
    cart.add(normalizeCartModel(model));
  });

  const onResize = () => {
    const width = mount.clientWidth;
    const height = mount.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  };
  window.addEventListener('resize', onResize);

  const clock = new THREE.Clock();
  const animate = () => {
    const elapsed = clock.getElapsedTime();
    const nowMs = performance.now();
    const transitionProgress = getStartTransitionProgress(nowMs);
    const cameraProgress = easeInOutCubic(transitionProgress);
    currentFrame = getInterpolatedFrame(performance.now());
    updateHud(currentFrame);
    updateMapCameraGestureState(mapCameraGestureState, transitionProgress, nowMs);
    updateMapboxRoute(mapboxMap, currentFrame, mapCameraGestureState);
    replaceMapElements(mapLayer, currentFrame.mapElements);
    replaceSceneObjects(objectLayer, currentFrame.objects);
    updatePredictionPath(prediction, currentFrame.predictedPath);
    updateSceneMode({
      camera,
      cart,
      prediction,
      mapLayer,
      objectLayer,
      mapCameraGestureState,
      transitionProgress,
      cameraProgress
    });

    cart.position.y = Math.sin(elapsed * 1.4) * 0.025;
    renderer.render(scene, camera);
    window.requestAnimationFrame(animate);
  };
  animate();
}

function getStartTransitionProgress(nowMs) {
  if (!driveStarted) return 0;
  return clamp((nowMs - transitionStartMs) / START_TRANSITION_MS, 0, 1);
}

function createMapCameraGestureState(element) {
  const state = {
    isDragging: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    lastInteractionMs: 0,
    bearingOffset: 0,
    pitchOffset: 0,
    zoomOffset: 0
  };

  const canInteract = () => driveStarted && getStartTransitionProgress(performance.now()) >= 1;

  element.addEventListener('pointerdown', (event) => {
    if (!canInteract()) return;
    state.isDragging = true;
    state.pointerId = event.pointerId;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.lastInteractionMs = performance.now();
    element.setPointerCapture(event.pointerId);
  });

  element.addEventListener('pointermove', (event) => {
    if (!state.isDragging || event.pointerId !== state.pointerId) return;
    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    state.bearingOffset += dx * 0.18;
    state.pitchOffset = clamp(state.pitchOffset - dy * 0.08, -28, 18);
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.lastInteractionMs = performance.now();
  });

  const endDrag = (event) => {
    if (event.pointerId !== state.pointerId) return;
    state.isDragging = false;
    state.pointerId = null;
    state.lastInteractionMs = performance.now();
  };

  element.addEventListener('pointerup', endDrag);
  element.addEventListener('pointercancel', endDrag);

  element.addEventListener('wheel', (event) => {
    if (!canInteract()) return;
    event.preventDefault();
    state.zoomOffset = clamp(state.zoomOffset - event.deltaY * 0.002, -1.4, 1.5);
    state.lastInteractionMs = performance.now();
  }, { passive: false });

  return state;
}

function updateMapCameraGestureState(state, transitionProgress, nowMs) {
  if (transitionProgress < 1) {
    state.isDragging = false;
    state.pointerId = null;
    state.bearingOffset = 0;
    state.pitchOffset = 0;
    state.zoomOffset = 0;
    return;
  }

  const shouldReturn = !state.isDragging && nowMs - state.lastInteractionMs > MAP_CAMERA_RETURN_DELAY_MS;
  if (!shouldReturn) return;

  state.bearingOffset = lerp(state.bearingOffset, 0, MAP_CAMERA_RETURN_LERP);
  state.pitchOffset = lerp(state.pitchOffset, 0, MAP_CAMERA_RETURN_LERP);
  state.zoomOffset = lerp(state.zoomOffset, 0, MAP_CAMERA_RETURN_LERP);
}

function updateSceneMode({
  camera,
  cart,
  prediction,
  mapLayer,
  objectLayer,
  mapCameraGestureState,
  transitionProgress,
  cameraProgress
}) {
  const mapBearingYaw = degreesToRadians(mapCameraGestureState?.bearingOffset ?? 0);
  const driveCartYaw = getPathHeading(currentFrame.predictedPath) + CART_MODEL_YAW_OFFSET + mapBearingYaw;
  const mapZoomScale = 2 ** (mapCameraGestureState?.zoomOffset ?? 0);
  cart.rotation.y = lerpAngle(START_CART_YAW, driveCartYaw, cameraProgress);
  cart.scale.setScalar(lerp(1, DRIVE_CART_MODEL_SCALE * mapZoomScale, cameraProgress));

  if (transitionProgress < 1) {
    camera.position.lerpVectors(START_CAMERA_POSITION, DRIVE_CAMERA_POSITION, cameraProgress);
    camera.lookAt(new THREE.Vector3().lerpVectors(START_CAMERA_TARGET, DRIVE_CAMERA_TARGET, cameraProgress));
  } else {
    camera.position.lerp(DRIVE_CAMERA_POSITION, CAMERA_RETURN_POSITION_LERP);
    camera.lookAt(DRIVE_CAMERA_TARGET);
  }

  prediction.visible = false;
  mapLayer.visible = false;
  objectLayer.visible = false;
  prediction.material.opacity = 0;
}

function createGround() {
  const geometry = new THREE.PlaneGeometry(80, 120);
  const material = new THREE.ShadowMaterial({ color: 0x9ca7b3, opacity: 0.12 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.03;
  mesh.receiveShadow = true;
  return mesh;
}

function createPredictionPath() {
  return new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({
      color: 0x2489ff,
      transparent: true,
      opacity: 0.78,
      roughness: 0.5,
      metalness: 0
    })
  );
}

function updatePredictionPath(mesh, path) {
  const width = 1.15;
  const vertices = [];
  const indices = [];

  path.forEach((point, index) => {
    vertices.push(point.x - width / 2, 0.04, point.z);
    vertices.push(point.x + width / 2, 0.04, point.z);
    if (index < path.length - 1) {
      const base = index * 2;
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  });

  mesh.geometry.dispose();
  mesh.geometry = new THREE.BufferGeometry();
  mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  mesh.geometry.setIndex(indices);
  mesh.geometry.computeVertexNormals();
}

function getPathHeading(path) {
  if (path.length < 2) return Math.PI;

  const start = path[0];
  const lookahead = path.find((point) => Math.hypot(point.x - start.x, point.z - start.z) > 0.25) ?? path[1];
  return Math.atan2(lookahead.x - start.x, lookahead.z - start.z);
}

function replaceMapElements(layer, mapElements) {
  disposeChildren(layer);
  layer.clear();

  mapElements.forEach((element) => {
    const line = createMapPolyline(element);
    if (line) layer.add(line);
  });
}

function createMapPolyline(element) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: element.type === 'divider' ? 0xbac2ca : 0xcfd5db,
    transparent: true,
    opacity: element.type === 'boundary' ? 0.68 : 0.82,
    roughness: 0.8,
    metalness: 0
  });
  const thickness = element.type === 'divider' ? 0.24 : 0.34;

  for (let index = 0; index < element.points.length - 1; index += 1) {
    const start = element.points[index];
    const end = element.points[index + 1];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.05) continue;

    const segment = new THREE.Mesh(new THREE.BoxGeometry(thickness, 0.045, length), material);
    segment.position.set((start.x + end.x) / 2, 0.024, (start.z + end.z) / 2);
    segment.rotation.y = Math.atan2(dx, dz);
    segment.receiveShadow = true;
    group.add(segment);
  }

  return group.children.length > 0 ? group : null;
}

function replaceSceneObjects(layer, objects) {
  disposeChildren(layer);
  layer.clear();
  objects.forEach((object) => {
    const mesh = createObjectPlaceholder(object);
    mesh.position.set(object.x, 0, object.z);
    mesh.rotation.y = object.heading ?? 0;
    layer.add(mesh);
  });
}

function createObjectPlaceholder(object) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: object.type === 'pedestrian' ? 0x89919a : 0xa5acb3,
    roughness: 0.78
  });

  if (object.type === 'pedestrian') {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(object.width * 0.18, object.height * 0.58, 6, 16), material);
    body.position.y = object.height * 0.42;
    body.castShadow = true;
    group.add(body);
  } else {
    group.add(createVehiclePlaceholder(object, material));
  }
  return group;
}

function createVehiclePlaceholder(object, material) {
  const group = new THREE.Group();
  const height = Math.min(object.height, 1.18);
  const body = new THREE.Mesh(createVehicleBodyGeometry(object), material);
  body.position.y = height * 0.5;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x7c858e, roughness: 0.82 });
  const wheelRadius = clamp(object.width * 0.13, 0.12, 0.2);
  const wheelDepth = clamp(object.length * 0.06, 0.18, 0.28);
  const wheelX = object.width * 0.53;
  const wheelZ = object.length * 0.31;

  [
    [-wheelX, -wheelZ],
    [wheelX, -wheelZ],
    [-wheelX, wheelZ],
    [wheelX, wheelZ]
  ].forEach(([x, z]) => {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelDepth, 18), wheelMaterial);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, wheelRadius, z);
    wheel.castShadow = true;
    group.add(wheel);
  });

  return group;
}

function createVehicleBodyGeometry(object) {
  const width = object.width;
  const length = object.length;
  const height = Math.min(object.height, 1.18);
  const radius = Math.min(width * 0.18, length * 0.08, 0.24);
  return new RoundedBoxGeometry(width, height, length, 5, radius);
}

function loadModelIfAvailable(loader, path, onLoad) {
  loader.load(
    path,
    (asset) => onLoad(asset.scene ?? asset),
    undefined,
    (error) => {
      console.error(`Unable to load model at ${path}`, error);
    }
  );
}

function normalizeCartModel(model) {
  const wrapper = new THREE.Group();
  wrapper.add(model);

  model.traverse((child) => {
    if (!child.isMesh) return;

    child.castShadow = true;
    child.receiveShadow = true;
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        material.side = THREE.FrontSide;
        material.needsUpdate = true;
        if (material.map) {
          material.map.colorSpace = THREE.SRGBColorSpace;
          material.map.needsUpdate = true;
        }
      });
    }
  });

  fitModelToCartEnvelope(model);
  return wrapper;
}

function fitModelToCartEnvelope(model) {
  model.updateWorldMatrix(true, true);
  const initialBox = new THREE.Box3().setFromObject(model);
  const initialSize = initialBox.getSize(new THREE.Vector3());
  const horizontalLength = Math.max(initialSize.x, initialSize.z);

  if (horizontalLength > 0) {
    const scale = START_CART_MODEL_TARGET_LENGTH / horizontalLength;
    model.scale.multiplyScalar(scale);
  }

  model.updateWorldMatrix(true, true);
  const fittedBox = new THREE.Box3().setFromObject(model);
  const fittedCenter = fittedBox.getCenter(new THREE.Vector3());
  model.position.x -= fittedCenter.x;
  model.position.y -= fittedBox.min.y;
  model.position.z -= fittedCenter.z;
}

function disposeChildren(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach((material) => material.dispose());
      } else {
        child.material.dispose();
      }
    }
  });
}
