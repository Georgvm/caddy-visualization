# Caddy Visualization

Localhost dashboard for a self-driving Stanford campus golf cart. It renders a white Tesla-style autonomy scene with a centered 3D cart, detected lanes, surrounding objects, a blue predicted path, speed readout, autonomy status, and circular route map.

## Run locally

```bash
npm install
npm run dev
```

Open the URL printed by Vite. The dev server binds to `0.0.0.0`, so it can also be viewed from another device on the same network.

## Replace placeholders

- The ego golf cart is rendered as a clean Three.js model in `src/main.js`.
- Optional future object models can be added under `public/models/`.
- SparseDrive sample telemetry lives in `public/data/bev_predictions.json`.

The current integration point is `src/main.js`: it loads `public/data/bev_predictions.json` and normalizes SparseDrive's BEV format into the dashboard frame format. Replace that `fetch()` with a WebSocket, REST polling, ROS bridge, or filesystem-backed telemetry adapter from the Jetson when live inference is ready.

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
