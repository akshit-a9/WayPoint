// Plan import: a temporary, dev-only tool (plan-import.html).
//
// The old project placed the D-block spots as pixels on two floor-plan images
// (Coordinates.csv). Here each plan is laid over the satellite view and lined
// up from point pairs (a spot on the plan + the same spot on the satellite),
// then every spot on that floor gets its real position in sites/bits-main.
//
// Plan pixel -> site metres is a similarity (scale, rotation, shift). In complex
// numbers: z = a·w + b, with w = u − i·v (image rows run down, north runs up)
// and z = x + i·y in the site's local frame.
import 'leaflet/dist/leaflet.css'
import '../index.css'
import './planImport.css'
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CircleMarker, LayersControl, MapContainer, Polyline, TileLayer, Tooltip, useMap, useMapEvents, ZoomControl } from 'react-leaflet'
import type { LeafletMouseEvent, Map as LeafletMap } from 'leaflet'
import { create } from 'zustand'
import { ConfirmButton, TooltipLayer, typing } from '../components/ui'
import { toLatLng, toLocal } from '../geo'
import type { Site, XY } from '../types'
import plan0 from '../../../sites/bits-main/plans/map_0.png?url'
import plan1 from '../../../sites/bits-main/plans/map_1.png?url'
import coordsCsv from '../../../sites/bits-main/plans/Coordinates.csv?raw'

// ?site=<id> imports into another site (e.g. a copy, for a dry run); the plans are always the D block's
const SITE = new URLSearchParams(location.search).get('site') ?? 'bits-main'
const FLOORS = [
  { id: '0', name: 'Ground floor', src: plan0, image: 'sites/bits-main/plans/map_0.png' },
  { id: '1', name: 'First floor', src: plan1, image: 'sites/bits-main/plans/map_1.png' },
]
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const SAVE_KEY = `planImport.v1.${SITE}`

// ---------------------------------------------------------------------------
// Complex helpers and the fit
// ---------------------------------------------------------------------------
type C = [number, number]
const add = (p: C, q: C): C => [p[0] + q[0], p[1] + q[1]]
const sub = (p: C, q: C): C => [p[0] - q[0], p[1] - q[1]]
const mul = (p: C, q: C): C => [p[0] * q[0] - p[1] * q[1], p[0] * q[1] + p[1] * q[0]]
const div = (p: C, q: C): C => { const d = q[0] ** 2 + q[1] ** 2; return [(p[0] * q[0] + p[1] * q[1]) / d, (p[1] * q[0] - p[0] * q[1]) / d] }
const abs = (p: C) => Math.hypot(p[0], p[1])
const w = ([u, v]: XY): C => [u, -v]

interface Pair { uv: XY; ll: [number, number] }
interface FloorFit { a: C; b: C; pairs: Pair[]; W: number; H: number }

/** Least-squares similarity through the pairs (1 pair: shift only, keeping scale and rotation). */
function fit(f: FloorFit, frame: Site): Pick<FloorFit, 'a' | 'b'> {
  const ws = f.pairs.map((p) => w(p.uv)), zs = f.pairs.map((p) => toLocal(frame, ...p.ll) as C)
  if (!ws.length) return f
  if (ws.length === 1) return { a: f.a, b: sub(zs[0], mul(f.a, ws[0])) }
  const n = ws.length
  const wm: C = [ws.reduce((s, p) => s + p[0], 0) / n, ws.reduce((s, p) => s + p[1], 0) / n]
  const zm: C = [zs.reduce((s, p) => s + p[0], 0) / n, zs.reduce((s, p) => s + p[1], 0) / n]
  let num: C = [0, 0], den = 0
  ws.forEach((p, k) => { const dw = sub(p, wm); num = add(num, mul(sub(zs[k], zm), [dw[0], -dw[1]])); den += dw[0] ** 2 + dw[1] ** 2 })
  const a = div(num, [den, 0])
  return { a, b: sub(zm, mul(a, wm)) }
}

const toZ = (f: Pick<FloorFit, 'a' | 'b'>, uv: XY) => add(mul(f.a, w(uv)), f.b)
const toUV = (f: Pick<FloorFit, 'a' | 'b'>, z: XY): XY => { const q = div(sub(z as C, f.b), f.a); return [q[0], -q[1]] }
/** Bearing the plan's "up" points to, degrees clockwise from north */
const upBearing = (a: C) => ((Math.atan2(-a[1], a[0]) * 180) / Math.PI + 360) % 360
const residual = (f: FloorFit, frame: Site, p: Pair) => abs(sub(toZ(f, p.uv), toLocal(frame, ...p.ll) as C))

// ---------------------------------------------------------------------------
// Spots from Coordinates.csv
// ---------------------------------------------------------------------------
interface Row { label: string; uv: XY; floor: string }
const ROWS: Row[] = coordsCsv.trim().split(/\r?\n/).slice(1).map((line) => {
  const cells = line.match(/("[^"]*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''))
  return { label: cells[1], uv: [+cells[2], +cells[3]] as XY, floor: cells[4] }
})
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

// ---------------------------------------------------------------------------
// State (zustand, so the assistant can read and drive it from the console)
// ---------------------------------------------------------------------------
type Mode = 'idle' | 'plan' | 'sat'
interface State {
  frame: Site | null            // the site as loaded; its anchor is the working frame for the session
  floor: string
  fits: Record<string, FloorFit>
  mode: Mode
  pending: XY | null            // plan pixel picked, waiting for its satellite point
  opacity: number
  names: boolean
  set: (p: Partial<State>) => void
  setFit: (floor: string, f: Partial<FloorFit>) => void
  addPair: (floor: string, p: Pair) => void
  removePair: (floor: string, i: number) => void
  adjust: (move: C, scaleBy: number, turnDeg: number) => void
}

/**
 * What hand adjustments may change: with no pairs, everything; with one pair,
 * scale and turn about that pair's point (moving would break it); with two or
 * more, nothing (the pairs decide).
 */
const freedom = (f: FloorFit) => (f.pairs.length === 0 ? 'all' : f.pairs.length === 1 ? 'turn' : 'none')

function loadSaved(): Partial<State> {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}') } catch { return {} }
}

const useTool = create<State>((set, get) => ({
  frame: null, floor: '0', fits: {}, mode: 'idle', pending: null, opacity: 0.7, names: false,
  ...loadSaved(),
  set: (p) => set(p),
  setFit: (floor, f) => set({ fits: { ...get().fits, [floor]: { ...get().fits[floor], ...f } } }),
  addPair: (floor, p) => {
    const f = get().fits[floor], next = { ...f, pairs: [...f.pairs, p] }
    set({ fits: { ...get().fits, [floor]: { ...next, ...fit(next, get().frame!) } } })
  },
  removePair: (floor, i) => {
    const f = get().fits[floor], next = { ...f, pairs: f.pairs.filter((_, j) => j !== i) }
    set({ fits: { ...get().fits, [floor]: { ...next, ...fit(next, get().frame!) } } })
  },
  // Move (metres), scale and turn (degrees clockwise) the current floor's plan by hand
  adjust: (move, scaleBy, turnDeg) => {
    const { floor, fits } = get(), f = fits[floor]
    if (!f || freedom(f) === 'none') return
    const pivot: XY = f.pairs.length ? f.pairs[0].uv : [f.W / 2, f.H / 2]
    const zp = add(toZ(f, pivot), freedom(f) === 'all' ? move : [0, 0])
    const r = (-turnDeg * Math.PI) / 180, a = mul(f.a, [scaleBy * Math.cos(r), scaleBy * Math.sin(r)])
    get().setFit(floor, { a, b: sub(zp, mul(a, w(pivot))) })
  },
}))
useTool.subscribe((s) => {
  // The frame is saved with the fits: they are only valid in it
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ frame: s.frame, floor: s.floor, fits: s.fits, opacity: s.opacity, names: s.names })) } catch { /* private window */ }
})

// Console handle for the assistant: read the fit, add pairs, check residuals
declare global { interface Window { planImport: unknown } }
window.planImport = {
  get: () => useTool.getState(),
  addPair: (floor: string, uv: XY, ll: [number, number]) => useTool.getState().addPair(floor, { uv, ll }),
  summary: () => {
    const s = useTool.getState()
    return Object.fromEntries(Object.entries(s.fits).map(([id, f]) => [id, {
      metresPerPixel: +abs(f.a).toFixed(4), upBearing: +upBearing(f.a).toFixed(1), pairs: f.pairs.length,
      residuals: f.pairs.map((p) => +residual(f, s.frame!, p).toFixed(2)),
    }]))
  },
}

// ---------------------------------------------------------------------------
// Map pieces
// ---------------------------------------------------------------------------

/** The plan image, drawn under the markers with a CSS matrix that follows the fit. */
function PlanImage({ src, f, frame, opacity }: { src: string; f: FloorFit; frame: Site; opacity: number }) {
  const map = useMap()
  const img = useRef<HTMLImageElement | null>(null)
  useEffect(() => {
    const pane = map.getPane('plan') ?? map.createPane('plan')
    pane.style.zIndex = '350'   // above tiles, below shapes and markers
    const el = document.createElement('img')
    el.className = 'plan-img leaflet-zoom-hide'
    pane.appendChild(el)
    img.current = el
    return () => el.remove()
  }, [map])
  useEffect(() => {
    const el = img.current
    if (!el) return
    const place = () => {
      const pt = (uv: XY) => map.latLngToLayerPoint(toLatLng(frame, toZ(f, uv)))
      const p0 = pt([0, 0]), pW = pt([f.W, 0]), pH = pt([0, f.H])
      el.src = src
      el.style.width = `${f.W}px`
      el.style.height = `${f.H}px`
      el.style.opacity = String(opacity)
      el.style.transform = `matrix(${(pW.x - p0.x) / f.W}, ${(pW.y - p0.y) / f.W}, ${(pH.x - p0.x) / f.H}, ${(pH.y - p0.y) / f.H}, ${p0.x}, ${p0.y})`
    }
    place()
    map.on('zoomend viewreset', place)
    return () => { map.off('zoomend viewreset', place) }
  }, [map, src, f, frame, opacity])
  return null
}

let theMap: LeafletMap | null = null   // for "Bring plan here"

/**
 * Hand placement: drag the plan to move it (the map pans when you drag outside
 * it), arrows nudge, Q/E turn, −/= scale, Shift+scroll scales, Alt+scroll turns.
 * Shift makes keys 10× bigger steps.
 */
function PlanControls() {
  const map = useMap()
  const drag = useRef<{ z0: XY; b0: C } | null>(null)
  const over = useRef(false)
  theMap = map
  const zOf = (e: LeafletMouseEvent) => toLocal(useTool.getState().frame!, e.latlng.lat, e.latlng.lng)
  const setOver = (v: boolean) => {
    if (v === over.current) return
    over.current = v
    if (v) map.dragging.disable(); else map.dragging.enable()
    map.getContainer().classList.toggle('plan-grab', v)
  }
  useMapEvents({
    mousemove: (e) => {
      const s = useTool.getState(), f = s.fits[s.floor], z = zOf(e)
      if (drag.current) { s.setFit(s.floor, { b: add(drag.current.b0, sub(z as C, drag.current.z0 as C)) }); return }
      const uv = f && toUV(f, z)
      setOver(!!f && s.mode === 'idle' && freedom(f) === 'all' && uv[0] >= 0 && uv[1] >= 0 && uv[0] <= f.W && uv[1] <= f.H)
    },
    mousedown: (e) => {
      if (!over.current) return
      const s = useTool.getState()
      drag.current = { z0: zOf(e), b0: s.fits[s.floor].b }
      map.getContainer().classList.add('plan-dragging')
    },
    mouseup: () => { drag.current = null; map.getContainer().classList.remove('plan-dragging') },
    mouseout: () => { if (!drag.current) setOver(false) },
  })
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.shiftKey ? 10 : 1, m = 0.25 * k, adjust = useTool.getState().adjust
      const moves: Record<string, C> = { ArrowUp: [0, m], ArrowDown: [0, -m], ArrowLeft: [-m, 0], ArrowRight: [m, 0] }
      // Match the key or its position, so Shift (which changes e.key, e.g. = to +) still works
      const is = (keys: string[], codes: string[]) => keys.includes(e.key.toLowerCase()) || codes.includes(e.code)
      if (moves[e.key]) adjust(moves[e.key], 1, 0)
      else if (is(['q'], ['KeyQ'])) adjust([0, 0], 1, -0.25 * k)
      else if (is(['e'], ['KeyE'])) adjust([0, 0], 1, 0.25 * k)
      else if (is(['=', '+'], ['Equal', 'NumpadAdd'])) adjust([0, 0], 1 + 0.005 * k, 0)
      else if (is(['-', '_'], ['Minus', 'NumpadSubtract'])) adjust([0, 0], 1 / (1 + 0.005 * k), 0)
      else return
      e.preventDefault()
    }
    // Capture on the map's parent so Leaflet's scroll-zoom never sees a Shift/Alt scroll
    const wheel = (e: WheelEvent) => {
      if (!e.shiftKey && !e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      const dir = Math.sign(e.deltaY || e.deltaX)   // Shift+scroll arrives as deltaX on Windows
      if (e.altKey) useTool.getState().adjust([0, 0], 1, dir * 0.5)
      else useTool.getState().adjust([0, 0], dir > 0 ? 1 / 1.01 : 1.01, 0)
    }
    const root = map.getContainer().parentElement!
    addEventListener('keydown', key)
    root.addEventListener('wheel', wheel, { capture: true, passive: false })
    return () => { removeEventListener('keydown', key); root.removeEventListener('wheel', wheel, { capture: true }) }
  }, [map])
  return null
}

function Clicks({ onClick, onMove }: { onClick: (z: XY) => void; onMove: (z: XY) => void }) {
  const frame = useTool((s) => s.frame)!
  useMapEvents({
    click: (e) => onClick(toLocal(frame, e.latlng.lat, e.latlng.lng)),
    mousemove: (e) => onMove(toLocal(frame, e.latlng.lat, e.latlng.lng)),
  })
  return null
}

/** Centre the map on the plan once per floor. */
function FitView({ f, frame, floor }: { f: FloorFit; frame: Site; floor: string }) {
  const map = useMap()
  useEffect(() => {
    map.fitBounds([[0, 0], [f.W, 0], [f.W, f.H], [0, f.H]].map((uv) => toLatLng(frame, toZ(f, uv as XY))), { padding: [40, 40] })
  }, [floor]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------
const HINTS: Record<Mode, string> = {
  idle: 'Drag the plan onto the building · arrows nudge · Q/E turn · −/= scale · then add point pairs (P)',
  plan: '1/2 · Click a sharp feature on the plan (a building corner, end of a garden strip) · Esc cancels',
  sat: '2/2 · Now click the same feature on the satellite (the plan is faded) · H shows the plan · Esc cancels',
}

function Tool() {
  const s = useTool()
  const [cursor, setCursor] = useState<XY | null>(null)
  const [peek, setPeek] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const floor = FLOORS.find((x) => x.id === s.floor)!
  const f = s.fits[s.floor]
  const frame = s.frame

  // Load the site once; its anchor is the working frame. A saved session keeps its own frame.
  useEffect(() => {
    if (!frame) fetch(`/api/sites/${SITE}`).then((r) => r.json()).then((site: Site) => s.set({ frame: site }))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // First visit to a floor: read the image size and start from the other floor's fit, or a guess
  useEffect(() => {
    if (!frame || f) return
    const im = new Image()
    im.onload = () => {
      const other = Object.values(useTool.getState().fits)[0]
      const a: C = other ? other.a : [0.08, 0]   // ~0.08 m per pixel is a fair first guess for a 1536 px plan of the D block
      const centre = w([im.width / 2, im.height / 2])
      const at: C = other ? toZ(other, [other.W / 2, other.H / 2]) as C : [0, 0]
      s.setFit(s.floor, { a, b: sub(at, mul(a, centre)), pairs: [], W: im.width, H: im.height })
    }
    im.src = floor.src
  }, [frame, f, s.floor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keys: P add pair, H peek at the plan, Esc cancel
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Escape') useTool.getState().set({ mode: 'idle', pending: null })
      if (e.key.toLowerCase() === 'p') useTool.getState().set({ mode: 'plan', pending: null })
      if (e.key.toLowerCase() === 'h') setPeek(true)
    }
    const up = (e: KeyboardEvent) => { if (e.key.toLowerCase() === 'h') setPeek(false) }
    addEventListener('keydown', down)
    addEventListener('keyup', up)
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up) }
  }, [])

  const rows = useMemo(() => ROWS.filter((r) => r.floor === s.floor), [s.floor])
  if (!frame || !f) return <div className="pad muted">Loading {SITE}…</div>

  const ll = (z: XY) => toLatLng(frame, z)
  const opacity = s.mode === 'sat' && !peek ? 0.15 : s.mode === 'plan' ? Math.max(s.opacity, 0.75) : s.opacity
  const pivot: XY = f.pairs.length === 1 ? f.pairs[0].uv : [f.W / 2, f.H / 2]

  const click = (z: XY) => {
    if (s.mode === 'plan') {
      const uv = toUV(f, z)
      if (uv[0] < 0 || uv[1] < 0 || uv[0] > f.W || uv[1] > f.H) { setStatus('That point is outside the plan'); return }
      s.set({ mode: 'sat', pending: [Math.round(uv[0]), Math.round(uv[1])] })
      setStatus(null)
    }
    if (s.mode === 'sat' && s.pending) {
      const [lat, lng] = ll(z)
      s.addPair(s.floor, { uv: s.pending, ll: [lat, lng] })
      s.set({ mode: 'idle', pending: null })
    }
  }
  // Scale and rotation sliders turn the plan about its middle (or about the one pair's point)
  const setAR = (scale: number, bearing: number) => {
    const r = (-bearing * Math.PI) / 180, a: C = [scale * Math.cos(r), scale * Math.sin(r)]
    const zp = toZ(f, pivot)
    s.setFit(s.floor, { a, b: sub(zp as C, mul(a, w(pivot))) })
  }
  // Put the plan's middle at the middle of the view (when it has drifted off screen)
  const bringHere = () => {
    if (!theMap) return
    const c = theMap.getCenter(), z = toLocal(frame, c.lat, c.lng) as C
    s.setFit(s.floor, { b: sub(z, mul(f.a, w([f.W / 2, f.H / 2]))) })
  }
  const free = freedom(f)
  const scale = abs(f.a), bearing = upBearing(f.a)
  const res = f.pairs.map((p) => residual(f, frame, p))
  const rms = res.length > 2 ? Math.sqrt(res.reduce((t, r) => t + r * r, 0) / res.length) : null

  return (
    <div className="tool">
      <MapContainer className="map" center={ll(toZ(f, [f.W / 2, f.H / 2]) as XY)} zoom={18} maxZoom={22}
        doubleClickZoom={false} zoomControl={false} attributionControl={false} keyboard={false}>
        <ZoomControl position="bottomright" />
        <LayersControl position="bottomright">
          <LayersControl.BaseLayer checked name="Satellite">
            <TileLayer url={ESRI} maxNativeZoom={18} maxZoom={22} />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Streets">
            <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxNativeZoom={19} maxZoom={22} />
          </LayersControl.BaseLayer>
        </LayersControl>
        <FitView f={f} frame={frame} floor={s.floor} />
        <PlanImage src={floor.src} f={f} frame={frame} opacity={opacity} />
        <Clicks onClick={click} onMove={setCursor} />
        <PlanControls />
        {rows.map((r) => (
          <CircleMarker key={r.label} center={ll(toZ(f, r.uv) as XY)} radius={5} interactive={s.mode === 'idle'}
            pathOptions={{ color: '#0b1a1a', weight: 2, fillColor: '#4cc9f0', fillOpacity: 1 }}>
            <Tooltip key={String(s.names)} direction="top" offset={[0, -5]} permanent={s.names} className="spotname">{r.label}</Tooltip>
          </CircleMarker>
        ))}
        {f.pairs.map((p, i) => {
          const a = ll(toZ(f, p.uv) as XY)
          return [
            <Polyline key={`l${i}`} positions={[a, p.ll]} interactive={false} pathOptions={{ color: '#ff4d6d', weight: 2 }} />,
            <CircleMarker key={`s${i}`} center={p.ll} radius={7} interactive={false} pathOptions={{ color: '#fff', weight: 2, fillColor: '#ff4d6d', fillOpacity: 1 }} />,
            <CircleMarker key={`p${i}`} center={a} radius={4} interactive={false} pathOptions={{ color: '#111', weight: 1, fillColor: '#ffd166', fillOpacity: 1 }}>
              <Tooltip permanent direction="right" offset={[6, 0]} className="pairlabel">{i + 1}</Tooltip>
            </CircleMarker>,
          ]
        })}
        {s.pending && <CircleMarker center={ll(toZ(f, s.pending) as XY)} radius={7} interactive={false}
          pathOptions={{ color: '#ffd166', weight: 3, fillOpacity: 0 }} />}
      </MapContainer>

      <div className="hintbar"><span>{HINTS[s.mode]}</span>
        {s.mode !== 'idle' && <button onClick={() => s.set({ mode: 'idle', pending: null })}>Cancel</button>}
      </div>
      {cursor && <div className="coords">x {cursor[0].toFixed(1)} · y {cursor[1].toFixed(1)} m</div>}

      <aside className="side">
        <section className="card">
          <h3>Plan import · {frame.name}</h3>
          <p className="muted small">Temporary tool. Line each floor plan up on the satellite view, then place that floor's spots.
            Keep the Studio off this site while importing, or its autosave may overwrite the result.</p>
          <div className="seg wide">
            {FLOORS.map((x) => <button key={x.id} className={x.id === s.floor ? 'on' : ''}
              onClick={() => { s.set({ floor: x.id, mode: 'idle', pending: null }); setStatus(null) }}>{x.name}</button>)}
          </div>
        </section>

        <section className="card">
          <h3>1 · Rough placement</h3>
          {free === 'all' && <div className="keys">
            <span><kbd>drag</kbd> move</span>
            <span><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> nudge 0.25 m</span>
            <span><kbd>Q</kbd><kbd>E</kbd> turn 0.25°</span>
            <span><kbd>−</kbd><kbd>=</kbd> scale 0.5%</span>
            <span><kbd>Shift</kbd> + key: 10× step</span>
            <span><kbd>Shift</kbd> + scroll: scale · <kbd>Alt</kbd> + scroll: turn</span>
          </div>}
          {free === 'turn' && <p className="muted small">The pair pins the plan: Q/E, −/= and the sliders now turn and scale it about that point.</p>}
          {free === 'none' && <p className="muted small">Scale and turn now come from the point pairs.</p>}
          {free === 'all' && <button className="wide" onClick={bringHere} data-tip="Put the plan in the middle of the view, if it has drifted off screen">Bring plan to the middle of the view</button>}
          <label className="block" data-tip="Metres per plan pixel">Scale · {scale.toFixed(4)} m/px · plan is {(f.W * scale).toFixed(0)} × {(f.H * scale).toFixed(0)} m
            <input type="range" min={0.02} max={0.25} step={0.0005} value={scale} disabled={free === 'none'}
              onChange={(e) => setAR(+e.target.value, bearing)} />
          </label>
          <label className="block" data-tip="Compass direction the top of the plan faces">Plan's top faces · {bearing.toFixed(1)}°
            <input type="range" min={0} max={360} step={0.5} value={bearing} disabled={free === 'none'}
              onChange={(e) => setAR(scale, +e.target.value)} />
          </label>
          <label className="block">Plan opacity · {Math.round(s.opacity * 100)}%
            <input type="range" min={0} max={1} step={0.05} value={s.opacity} onChange={(e) => s.set({ opacity: +e.target.value })} />
          </label>
        </section>

        <section className="card">
          <div className="row between">
            <h3>2 · Point pairs</h3>
            <button className="primary" onClick={() => s.set({ mode: 'plan', pending: null })} data-tip="P">Add pair</button>
          </div>
          <p className="muted small">
            {f.pairs.length === 0 && 'Pick sharp features far apart: building corners, the ends of garden strips.'}
            {f.pairs.length === 1 && 'One pair moves the plan. Add a second, far from the first, to set scale and turn.'}
            {f.pairs.length === 2 && 'Two pairs fit exactly. Add a third to check the fit.'}
            {rms != null && <>Fit error <b className={rms > 2 ? 'warn' : ''}>{rms.toFixed(2)} m</b> (RMS). Under ~1.5 m is as good as the imagery allows.</>}
          </p>
          <div className="pairs">
            {f.pairs.map((p, i) => (
              <div key={i} className="pair">
                <span className="n">{i + 1}</span>
                <span className="grow muted small">plan {p.uv[0]}, {p.uv[1]}</span>
                {f.pairs.length > 2 && <span className={`small ${res[i] > 2 ? 'warn' : ''}`} data-tip="Distance between the plan point and its satellite point after the fit">{res[i].toFixed(2)} m</span>}
                <button className="icon" onClick={() => s.removePair(s.floor, i)} data-tip="Remove pair">✕</button>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h3>3 · Place spots</h3>
          <label className="row small"><input type="checkbox" checked={s.names} onChange={(e) => s.set({ names: e.target.checked })} /> Show spot names</label>
          <p className="muted small">{rows.length} spots on the {floor.name.toLowerCase()} (blue dots).</p>
          <ConfirmButton className="primary wide" disabled={f.pairs.length < 2}
            tip={f.pairs.length < 2 ? 'Add at least 2 point pairs first' : `Write positions for ${rows.length} spots into ${SITE}`}
            confirm={`Place ${rows.length} spots in ${SITE}?`}
            onConfirm={async () => setStatus(await importFloor(s.floor, f, frame, rows))}>
            Place {rows.length} spots
          </ConfirmButton>
          {status && <p className="small">{status}</p>}
        </section>
      </aside>
      <TooltipLayer />
    </div>
  )
}

/** Write this floor's spot positions (and the plan's placement) into the site. */
async function importFloor(floorId: string, f: FloorFit, frame: Site, rows: Row[]): Promise<string> {
  const site: Site = await fetch(`/api/sites/${SITE}`).then((r) => r.json())
  const latlng = (uv: XY) => toLatLng(frame, toZ(f, uv))
  // A site with nothing placed yet gets its origin moved to the middle of this plan
  const empty = !site.spots.some((p) => p.x != null) && site.floors.every((x) => !x.outline.length)
  if (empty) { const [lat, lon] = latlng([f.W / 2, f.H / 2]); site.anchor = { ...site.anchor, lat, lon } }
  const local = (uv: XY) => { const [lat, lng] = latlng(uv); return toLocal(site, lat, lng) }
  const byId = new Map(site.spots.map((p) => [norm(p.id), p]))
  let placed = 0
  const missing: string[] = []
  for (const r of rows) {
    const spot = byId.get(norm(r.label))
    if (!spot) { missing.push(r.label); continue }
    ;[spot.x, spot.y] = local(r.uv)
    spot.floor = floorId
    placed++
  }
  const fl = site.floors.find((x) => x.id === floorId)!
  // overlay: where plan pixel (0,0) lands, metres per pixel, and the bearing the plan's top faces
  const [ox, oy] = local([0, 0])
  fl.overlay = { image: FLOORS.find((x) => x.id === floorId)!.image, x: ox, y: oy, scale: +abs(f.a).toFixed(5), rotation: +upBearing(f.a).toFixed(2) }
  const r = await fetch(`/api/sites/${SITE}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(site) })
  if (!r.ok) return `Save failed: ${r.status} ${r.statusText}`
  return `Placed ${placed} spots on the ${fl.name.toLowerCase()}${empty ? ' and moved the site origin to the building' : ''}.` +
    (missing.length ? ` Not found in the site: ${missing.join(', ')}.` : '')
}

createRoot(document.getElementById('root')!).render(<StrictMode><Tool /></StrictMode>)
