// Site pack, as stored in sites/<id>/site.json. Positions are metres in the
// site's local frame: x east, y north, origin at anchor, turned by anchor.rotation.
export type XY = [number, number]

export interface Floor {
  id: string
  name: string
  level: number
  height: number
  outline: XY[][] // building footprints and courtyards (a ring inside another is a courtyard)
  // Floor plan image over the satellite view. Plan pixel (u, v) lands at
  // (x, y) + scale·R(rotation)·(u, -v): `rotation` is the compass bearing of the image's top.
  overlay: null | { image: string; x: number; y: number; scale: number; rotation: number }
}

// You can walk straight from spot a to spot b. Routes follow these links.
// `via` marks a link between floors (stairs, lift or ramp).
export type Via = 'stairs' | 'lift' | 'ramp'
export interface Edge {
  a: string
  b: string
  via?: Via
}

// A spot is a place where WiFi is recorded for localization. A destination is
// a spot you can also navigate to: same record, with `dest` set.
export interface Spot {
  id: string
  name: string
  floor: string
  x: number | null
  y: number | null
  dest?: { category: string } | null
}

// Derived from spots with `dest` on save, for the firmware (navigation menu)
export interface Destination {
  id: string
  name: string
  floor: string
  x: number
  y: number
  category: string
}

export interface Site {
  schema: number
  id: string
  name: string
  note?: string
  anchor: { lat: number; lon: number; rotation: number }
  floors: Floor[]
  spots: Spot[]
  destinations: Destination[]
  edges: Edge[]
  activeModel: string | null
  aligned?: boolean // the user confirmed the outline sits on the satellite view
}

export interface SiteSummary {
  id: string
  name: string
  private: boolean
  spots: number
  takes: number
  activeModel: string | null
}

export interface Prediction {
  location: string
  confidence: number
  known_aps: number
  total_aps: number
  spot?: string
  floor?: string
  xy?: XY | null
  top?: { spot: string; p: number }[]
}

export interface Device {
  id: string
  site: string
  scans: number
  age: number
  scan: [string, number][]
  result: Prediction
  history: { t: number; xy: XY | null; spot: string | null }[]
}

export interface Take {
  id: string
  site: string
  spot: string
  device: string
  seconds: number
  elapsed: number
  scans: number
  done: boolean
}

// Device debug telemetry (firmware net.cpp -> api-server telemetry.py)
export interface TelemetryHealth {
  uptime: number; heap: number; minHeap: number; rssi: number; ch: number; fps: number
  scans: number; scanMs: number; i2cErr: number; mag: boolean; mpu: boolean; oled: boolean
  reset: string; sent: number; failed: number; level: number
}

export interface TelemetryDevice {
  id: string
  boot: number
  age: number | null
  fw: string | null
  health: TelemetryHealth | null
  ui: { screen: string; sel: number } | null
  nav: NavState | null
  // The device's screen, base64: "1bpp" = OLED buffer (128x32, U8g2 pages), "rle332" = TFT, [count, RGB332] pairs
  screen: { data: string; age: number; format: '1bpp' | 'rle332'; w: number; h: number } | null
  // Smoothed position: steps from the accelerometer + WiFi fixes (firmware track.cpp)
  track: { x?: number; y?: number; s?: number; f?: number; steps: number; moving: boolean } | null
  trail: XY[] // recent smoothed positions, oldest first
  session: string | null
}

// What the device's navigation is doing (firmware nav.cpp, in each telemetry batch)
export interface NavState {
  v: string // nav pack version it has ('' = none yet)
  n: number // spots in the pack
  dest: string // destination spot id, '' when not navigating
  at: string // spot it thinks it is at
  next: string // next spot on the route
  dist: number // metres left along the route
  brg: number // compass bearing to the next spot
  hdg: number | null // compass heading of the device, null without a compass
  arrived: boolean
  cue: string // floor change, e.g. "STAIRS UP"
  fakeAt: string // test overrides from the Studio
  fakeHdg: number | null
  knobOff: boolean // the real knob is ignored (none wired)
}

export interface TelemetryBatch {
  n: number
  rx: number // server time, s
  t: number // device millis
  boot: number
  health?: TelemetryHealth
  scan?: { ms: number; aps: [string, number, number, string][] } // bssid, rssi, channel, ssid
  pred?: { ok: boolean; location: string; spot: string; conf: number; known: number; total: number; ms: number; xy?: XY; error?: string }
  log?: [number, string][]
  events?: [number, string, number, string | null][]
  sensors?: [number, number, number, number, number, number, number][] // t, mx, my, mz, ax, ay, az
}

// How a device is held and its compass calibration (data/devices/<mac>.json)
export interface Orientation {
  magOffset: [number, number, number] // hard iron: centre of the min/max box
  magScale: [number, number, number] // soft iron: per-axis scale to a sphere
  magVertical: number // magnetometer axis that points up (0 x, 1 y, 2 z): least change while spinning flat
  mirror: boolean // flip if the compass turns the wrong way
  headingOffset: number // degrees added so 0 = facing north with the device's front
  accAhead: number // accelerometer axis pointing to the device's front (0 x, 1 y, 2 z)
  accAheadSign: number // +1 / -1
  accSideSign: number // +1 / -1 for the remaining horizontal axis (positive = right)
  calibratedAt: string | null
}

export interface ModelMetrics {
  version: string
  trainedAt: string
  scans: number
  takes: number
  spots: number
  accessPoints: number
  validation: string
  accuracy: number | null
  meanError: number | null
  p90Error: number | null
  perSpot: { spot: string; scans: number; takes: number; accuracy: number | null; meanError: number | null; confusedWith: string | null }[]
}
