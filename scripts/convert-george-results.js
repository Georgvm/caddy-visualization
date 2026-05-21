import fs from 'node:fs';
import path from 'node:path';

const inputPath = process.argv[2] ?? '/tmp/drive-by-segmentation/george-results/segmentation.json';
const outputPath = process.argv[3] ?? 'public/data/segmentation.json';

const ROAD_CLASS = 0;
const OBJECT_CLASSES = new Map([
  [11, 'pedestrian'],
  [12, 'pedestrian'],
  [13, 'car'],
  [14, 'truck'],
  [15, 'bus'],
  [17, 'motorcycle'],
  [18, 'bicycle']
]);

const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const { width, height, video_fps: fps } = raw.metadata;
const frameRateHz = fps ?? 30;

const converted = {
  meta: {
    source: 'drive-by-segmentation/george-results',
    source_model: raw.metadata.model,
    frame_rate_hz: frameRateHz,
    point_order: 'lateral_forward',
    conversion: 'RLE semantic segmentation projected heuristically into ego-local ground coordinates'
  },
  frames: raw.frames.map((runs, index) => convertFrame(runs, index))
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(converted)}\n`);
console.log(`Wrote ${converted.frames.length} frames to ${outputPath}`);

function convertFrame(runs, index) {
  const decoded = decodeRleFrame(runs);
  const roadRows = extractRoadRows(decoded);
  const leftBoundary = roadRows.map((row) => pixelToGround(row.left, row.y));
  const rightBoundary = roadRows.map((row) => pixelToGround(row.right, row.y));
  const centerline = smoothPath(roadRows.map((row) => pixelToGround((row.left + row.right) / 2, row.y)), 2);
  const speedMph = estimateSpeedMph(centerline);

  return {
    frame_idx: index,
    speed_mph: speedMph,
    self_driving: true,
    predicted_path: centerline,
    lanes: [
      { class: 'road_center', points: centerline }
    ],
    boundaries: [
      { class: 'road_edge_left', points: smoothPath(leftBoundary, 1) },
      { class: 'road_edge_right', points: smoothPath(rightBoundary, 1) }
    ],
    objects: extractObjects(decoded)
  };
}

function decodeRleFrame(runs) {
  const pixels = new Uint8Array(width * height);
  let offset = 0;

  for (const [classId, count] of runs) {
    pixels.fill(classId, offset, offset + count);
    offset += count;
  }

  return pixels;
}

function extractRoadRows(pixels) {
  const horizonY = Math.round(height * 0.53);
  const rows = [];

  for (let y = height - 8; y >= horizonY; y -= 12) {
    const spans = findRoadSpans(pixels, y);
    const centerSpan = pickCenterRoadSpan(spans);
    if (!centerSpan) continue;

    const minWidth = y > height * 0.78 ? 28 : 14;
    if (centerSpan.right - centerSpan.left < minWidth) continue;

    rows.push({
      y,
      left: centerSpan.left,
      right: centerSpan.right
    });
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .filter((row, index, allRows) => {
      if (index === 0 || index === allRows.length - 1) return true;
      const prev = allRows[index - 1];
      return Math.abs(((row.left + row.right) / 2) - ((prev.left + prev.right) / 2)) < width * 0.22;
    });
}

function findRoadSpans(pixels, y) {
  const spans = [];
  const rowStart = y * width;
  let x = 0;

  while (x < width) {
    while (x < width && pixels[rowStart + x] !== ROAD_CLASS) x += 1;
    if (x >= width) break;
    const left = x;
    while (x < width && pixels[rowStart + x] === ROAD_CLASS) x += 1;
    spans.push({ left, right: x - 1 });
  }

  return spans;
}

function pickCenterRoadSpan(spans) {
  if (spans.length === 0) return null;
  const centerX = width / 2;
  const containingCenter = spans.find((span) => span.left <= centerX && span.right >= centerX);
  if (containingCenter) return containingCenter;

  return spans
    .map((span) => ({
      span,
      distance: Math.min(Math.abs(centerX - span.left), Math.abs(centerX - span.right)),
      width: span.right - span.left
    }))
    .filter((entry) => entry.width > 8)
    .sort((a, b) => a.distance - b.distance)[0]?.span ?? null;
}

function pixelToGround(x, y) {
  const horizonY = height * 0.53;
  const nearY = height - 1;
  const t = clamp((nearY - y) / (nearY - horizonY), 0, 1);
  const forward = 1.2 + (t ** 1.85) * 32;
  const lateralRange = 2.2 + forward * 0.34;
  const lateral = ((x - width / 2) / (width / 2)) * lateralRange;

  return [
    round(lateral),
    round(forward)
  ];
}

function extractObjects(pixels) {
  const boxes = new Map();

  for (let y = 0; y < height; y += 2) {
    const rowStart = y * width;
    for (let x = 0; x < width; x += 2) {
      const classId = pixels[rowStart + x];
      const label = OBJECT_CLASSES.get(classId);
      if (!label) continue;

      const box = boxes.get(classId) ?? {
        class: label,
        minX: x,
        minY: y,
        maxX: x,
        maxY: y,
        count: 0
      };

      box.minX = Math.min(box.minX, x);
      box.minY = Math.min(box.minY, y);
      box.maxX = Math.max(box.maxX, x);
      box.maxY = Math.max(box.maxY, y);
      box.count += 1;
      boxes.set(classId, box);
    }
  }

  return [...boxes.values()]
    .filter((box) => box.count >= 10)
    .map((box) => {
      const ground = pixelToGround((box.minX + box.maxX) / 2, box.maxY);
      const dimensions = getObjectDimensions(box.class);
      return {
        class: box.class,
        center: ground,
        width: dimensions.width,
        length: dimensions.length,
        height: dimensions.height,
        heading: 0
      };
    });
}

function getObjectDimensions(label) {
  if (label === 'pedestrian') return { width: 0.72, length: 0.72, height: 1.72 };
  if (label === 'bicycle' || label === 'motorcycle') return { width: 0.86, length: 2.15, height: 0.9 };
  if (label === 'truck' || label === 'bus') return { width: 2.45, length: 6.8, height: 1.55 };
  return { width: 1.9, length: 4.35, height: 1.08 };
}

function estimateSpeedMph(centerline) {
  if (centerline.length < 2) return 8;
  const near = centerline[0];
  const far = centerline[Math.min(centerline.length - 1, 5)];
  const lateralShift = Math.abs(far[0] - near[0]);
  return Math.max(5, Math.min(14, Math.round(10 - lateralShift * 0.35)));
}

function smoothPath(points, passes) {
  let output = points;
  for (let pass = 0; pass < passes; pass += 1) {
    output = output.map((point, index) => {
      if (index === 0 || index === output.length - 1) return point;
      return [
        round((output[index - 1][0] + point[0] * 2 + output[index + 1][0]) / 4),
        round((output[index - 1][1] + point[1] * 2 + output[index + 1][1]) / 4)
      ];
    });
  }
  return output;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
