# WayPoint Studio

A web app for mapping a building, recording WiFi fingerprints, training a model
for that building, and watching and steering the device live. It is built with
React, TypeScript and Vite, and uses Leaflet for the maps.

## Run it

Start the API server first (see [../api-server/README.md](../api-server/README.md)).

- **Use it:** `npm install` and `npm run build` once (again after pulling
  Studio changes). The server then serves it at
  `http://<laptop>:8000/studio/`, so a phone on the hotspot can open it too
  (handy on the Record tab).
- **Develop it:** `npm run dev`, then open `http://localhost:5173/studio/`.
  API calls are proxied to `:8000`, and edits show up immediately.

Needs Node 20.19+ (Vite 8).

## Sites

Each building is a **site pack**:

- `../sites/<id>/` is tracked in git (the D block: `sites/bits-main/`).
- `../private/sites/<id>/` is git-ignored ("keep out of git" when you create
  a site).

```
site.json        floors (outline, plan image), spots, destinations, links, active model
recordings/      one CSV per 90 s take: take, device, spot, scan, t, bssid, rssi
models/vN.joblib trained models
plans/           floor-plan images a floor's overlay points at (bits-main)
```

All positions are in **metres**. The x axis points east and the y axis points
north. The origin is `anchor` (latitude/longitude), and the frame is turned by
`anchor.rotation`. The header's floor picker switches floors.

`edges` are the links between spots you can walk straight between; routes
(in the Studio and on the device) follow them. A link between floors has a
`via` (stairs, lift or ramp). A floor's `overlay` places a plan image over the
satellite view; the API serves it from the site folder (or `private/`).

The site picked in the header is the one the device localizes in: `/predict`
answers for it, and the device gets its spots and links as the nav pack.

## Tabs

| Tab | What it does |
|---|---|
| Map | Align the building on satellite imagery (place, nudge, rotate), with the floor plan on top. Add spots, one at a time or every N m along a line. Mark destinations. Connect spots (C: click one spot after another); link stairs and lifts across floors from a spot's panel. Try a route. Measure distances. A health check lists unlinked spots and separate groups. |
| Record | Pick a device and a spot, then press Start. The device's next 90 s of scans are saved as a take of that spot. A beep (and the device's screen) tells you to turn 45° right every eighth of the take, so the spot is learnt facing every way. It suggests the nearest spot that still needs takes. |
| Train | Trains a Random Forest from the site's takes. The score holds out whole takes, so it measures how well new visits are recognised. Results are reported in metres and include a map of which spots get mixed up. Models are versioned, and you choose the active one. |
| Live | Each device's predicted spot, smoothed track and trail, top 5 candidates, known APs and raw scan. **Navigate** sends the device to a destination and shows its route, its state and a live mirror of its screen, with Dark/Light, Flip and radio controls under it. For a board without sensors you can pretend a position and heading. |
| Device | The device's health (signal, latency, frame rate, heap), raw magnetometer and accelerometer (live at 25 Hz while this tab is open; WiFi scans pause meanwhile), the 3-D orientation view and **compass calibration**, its log and events, and commands (rescan I2C, telemetry level, reboot, message on screen). |

## Code

| File | Role |
|---|---|
| `src/App.tsx` | Header (site and floor pickers), tabs |
| `src/api.ts` | Typed calls to the API, React Query hooks |
| `src/store.ts` | The site being edited (zustand); every edit is undoable (Ctrl+Z / Ctrl+Shift+Z) and saved automatically |
| `src/types.ts` | Site, spot, take, telemetry types (mirror `site.json` and the API) |
| `src/geo.ts` | Site metres ↔ latitude/longitude |
| `src/graph.ts` | Routing over the links (the device's nav pack uses the same lengths) |
| `src/live.ts` | The live sensor stream (SSE) |
| `src/device/compass.ts` | Heading from the magnetometer and its calibration (the firmware does the same in `nav.cpp`) |
| `src/components/SiteMap.tsx` | The Leaflet map: satellite, plan overlay, outlines, links, spots |
| `src/components/NavPanel.tsx` | Live → Navigate, and the device's screen mirror |
| `src/components/Orientation.tsx` | 3-D orientation and compass calibration |
| `src/pages/*` | One file per tab (`Collect.tsx` is the Record tab, `Debug.tsx` the Device tab) |
| `plan-import.html`, `src/tools/planImport.tsx` | Dev-only tool that placed the D block's plans and spots from `sites/bits-main/plans/Coordinates.csv`. Not in the build; open `http://localhost:5173/studio/plan-import.html` under `npm run dev`. |
