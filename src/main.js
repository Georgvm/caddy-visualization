import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import './styles.css';

const SCENE_LIMIT_METERS = 42;
const MAP_CENTER = 110;
const MAP_SCALE = 2.45;
const CART_MODEL_YAW_OFFSET = 0;
const CART_MODEL_PATH = '/models/Electric_Cart.fbx';
const CART_MODEL_TARGET_LENGTH = 3.15;
const EGO_OBJECT_CLEAR_RADIUS_METERS = 3.4;

const sparseDriveData = await fetch('/data/bev_predictions.json').then((response) => response.json());
const telemetry = normalizeSparseDriveData(sparseDriveData);
const SOURCE_FRAME_INTERVAL_MS = 1000 / telemetry.frameRateHz;
const REPLAY_SPEED = 0.75;
const FRAME_INTERVAL_MS = SOURCE_FRAME_INTERVAL_MS / REPLAY_SPEED;
const INTERPOLATION_LOOP_FRAMES = Math.max(1, telemetry.frames.length - 1);

const root = document.getElementById('root');
root.innerHTML = `
  <main class="screen">
    <div class="scene-canvas" aria-label="3D autonomy visualization"></div>
    <section class="hud" aria-label="Autonomous golf cart dashboard">
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
  speed: document.querySelector('.speed-number'),
  autonomy: document.querySelector('.autonomy-status'),
  route: document.querySelector('.map-route'),
  cart: document.querySelector('.map-cart'),
  pin: document.querySelector('.map-pin')
};

let currentFrame = telemetry.frames[0];
let replayStartMs = performance.now();
updateHud(currentFrame);

initScene(document.querySelector('.scene-canvas'));

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
    objects: interpolateObjects(frameA.objects, frameB.objects, alpha)
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

function initScene(mount) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 0.1, 120);
  camera.position.set(0, 8.5, 13);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xdde4ea, 2.4));

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
  keyLight.position.set(-5, 8, 8);
  keyLight.castShadow = true;
  scene.add(keyLight);

  scene.add(createGround());

  const prediction = createPredictionPath();
  scene.add(prediction);

  const cart = new THREE.Group();
  scene.add(cart);

  const mapLayer = new THREE.Group();
  scene.add(mapLayer);

  const objectLayer = new THREE.Group();
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
    currentFrame = getInterpolatedFrame(performance.now());
    updateHud(currentFrame);
    replaceMapElements(mapLayer, currentFrame.mapElements);
    replaceSceneObjects(objectLayer, currentFrame.objects);
    updatePredictionPath(prediction, currentFrame.predictedPath);
    cart.rotation.y = getPathHeading(currentFrame.predictedPath) + CART_MODEL_YAW_OFFSET;

    cart.position.y = Math.sin(elapsed * 1.4) * 0.025;
    renderer.render(scene, camera);
    window.requestAnimationFrame(animate);
  };
  animate();
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
    const scale = CART_MODEL_TARGET_LENGTH / horizontalLength;
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
