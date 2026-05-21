# Caddy Visualization

Localhost dashboard for a self-driving Stanford campus golf cart. It renders a white Tesla-style autonomy scene with a centered 3D cart, detected lanes, surrounding objects, a blue predicted path, speed readout, autonomy status, and circular route map.

## Run locally

```bash
npm install
npm run dev
```

Open the URL printed by Vite. The dev server binds to `0.0.0.0`, so it can also be viewed from another device on the same network.

## Replace placeholders

- The ego golf cart loads from `public/models/Electric_Cart.fbx`.
- Optional future object models can be added under `public/models/`.
- The app first tries to load segmentation data from `public/data/segmentation.json`.
- If `segmentation.json` is not present, it falls back to the SparseDrive sample at `public/data/bev_predictions.json`.

The current integration point is `src/main.js`: it normalizes either segmentation JSON or SparseDrive BEV JSON into one dashboard frame format. Replace the JSON fetch with a WebSocket, REST polling, ROS bridge, or filesystem-backed telemetry adapter from the Jetson when live inference is ready.

## Segmentation JSON

Drop the real segmentation file at:

```text
public/data/segmentation.json
```

A working example lives at `public/data/segmentation.example.json`. The recommended shape is:

```json
{
  "meta": {
    "frame_rate_hz": 10,
    "point_order": "lateral_forward"
  },
  "frames": [
    {
      "frame_idx": 0,
      "speed_mph": 8,
      "self_driving": true,
      "predicted_path": [[0, 0], [0.1, 3], [0.2, 6]],
      "lanes": [
        { "class": "lane_left", "points": [[-1.4, 0], [-1.3, 6], [-1.1, 12]] }
      ],
      "boundaries": [
        { "class": "road_edge", "points": [[3.2, 0], [3.0, 6], [2.8, 12]] }
      ],
      "objects": [
        { "class": "car", "center": [4.6, 10.2], "width": 1.9, "length": 4.3, "heading": 0.05 }
      ]
    }
  ]
}
```

`point_order` may be:

- `lateral_forward`: `[left/right meters, forward meters]`
- `forward_lateral`: `[forward meters, left/right meters]`
- `x_forward_y_left`: equivalent to `forward_lateral`

The adapter also accepts common alternate keys such as `laneLines`, `lane_lines`, `trajectory`, `path`, `road_edges`, `detections`, `segments`, `segmentations`, and polygon `vertices`.

## Convert George Results

The `drive-by-segmentation` repo's `george-results/segmentation.json` is raw RLE semantic segmentation in camera pixels. Convert it into the dashboard format with:

```bash
node scripts/convert-george-results.js \
  /path/to/drive-by-segmentation/george-results/segmentation.json \
  public/data/segmentation.json
```

The converter extracts the road mask into left/right road edges and a center trajectory, and maps Cityscapes object classes such as `person`, `car`, `bus`, `motorcycle`, and `bicycle` into the 3D scene.

## Telemetry shape

The SparseDrive JSON uses ego/LiDAR coordinates:

- `x` is forward in meters
- `y` is left in meters
- `z` is up in meters

The dashboard converts those into Three.js scene coordinates with forward rendered along negative `z`.

The normalized dashboard frame contains:

```json
{
  "speedMph": 8,
  "selfDriving": true,
  "position": { "x": 75, "y": 142 },
  "destination": { "x": 168, "y": 67 },
  "route": [{ "x": 75, "y": 142 }],
  "predictedPath": [{ "x": 0, "z": 1.1 }],
  "objects": [{ "type": "car", "x": -4.4, "z": -7.4, "heading": 0.04 }]
}
```

The 3D scene uses cart-relative coordinates: `z` is forward and `x` is left/right.
