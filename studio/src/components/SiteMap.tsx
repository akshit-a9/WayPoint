import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AttributionControl, CircleMarker, LayersControl, MapContainer, Pane, Polygon, Polyline, ScaleControl, TileLayer, Tooltip, useMap, useMapEvents, ZoomControl } from 'react-leaflet'
import { ringParents, snap, toLatLng, toLocal } from '../geo'
import { other } from '../graph'
import { useStudio } from '../store'
import type { Floor, Site, Spot, XY } from '../types'

// Satellite imagery: Esri World Imagery (free with attribution, no key).
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

export const DEST_COLOR = '#f77f00'
export const SPOT_COLOR = '#4cc9f0'
export const LINK_COLOR = '#06d6a0'
export const ROUTE_COLOR = '#ff4d6d'

interface Props {
  site: Site
  floorId: string
  onClick?: (xy: XY) => void
  onMove?: (xy: XY) => void
  /** Fill colour per spot (default: destinations orange, spots blue) */
  spotColor?: (s: Spot) => string
  /** Extra tooltip line per spot */
  spotTip?: (s: Spot) => string
  onSpotClick?: (id: string) => void
  onSpotDrag?: (id: string, xy: XY) => void   // drag the selected spot
  onEdgeClick?: (a: string, b: string) => void
  onOutlineClick?: (index: number) => void
  selectedSpot?: string | null
  selectedEdge?: [string, string] | null
  selectedOutline?: number | null
  linkFrom?: string | null   // Connect tool: the spot the next link starts from
  route?: string[] | null    // spot ids of a route to draw
  editRings?: EditRings | null   // corner handles for the selected outline
  focus?: XY | null          // pan here when it changes
  crosshair?: boolean
  children?: ReactNode
}

function Events({ site, onClick, onMove, drag }: Pick<Props, 'site' | 'onClick' | 'onMove'> & { drag: React.RefObject<((xy: XY) => void) | null> }) {
  const dragged = useRef(false)   // the click that ends a drag is not a map click
  const map = useMapEvents({
    click: (e) => { if (!dragged.current) onClick?.(toLocal(site, e.latlng.lat, e.latlng.lng)) },
    mousemove: (e) => {
      const xy = toLocal(site, e.latlng.lat, e.latlng.lng)
      onMove?.(xy)
      drag.current?.(xy)
    },
    mouseup: () => {
      if (!drag.current) return
      drag.current = null
      map.dragging.enable()
      dragged.current = true
      setTimeout(() => { dragged.current = false })
    },
  })
  return null
}

/** Frame the site once when it first loads. */
function FitOnce({ site }: { site: Site }) {
  const map = useMap()
  useEffect(() => {
    const pts = site.floors.flatMap((f) => f.outline.flat()).concat(site.spots.filter((s) => s.x != null).map((s) => [s.x!, s.y!] as XY))
    if (pts.length) map.fitBounds(pts.map((p) => toLatLng(site, p)), { padding: [30, 30], maxZoom: 20 })
    else map.setView([site.anchor.lat, site.anchor.lon], 18)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id])
  return null
}

function Focus({ site, focus }: { site: Site; focus?: XY | null }) {
  const map = useMap()
  useEffect(() => { if (focus) map.panTo(toLatLng(site, focus), { animate: true }) }, [focus]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

/**
 * The floor's plan image (from the plan import) under the shapes and markers.
 * A CSS matrix maps image pixels onto the map, so it follows zoom exactly.
 */
function FloorPlan({ site, floor, opacity }: { site: Site; floor: Floor; opacity: number }) {
  const map = useMap()
  const img = useRef<HTMLImageElement | null>(null)
  const o = floor.overlay
  const src = o ? `/api/sites/${site.id}/floors/${floor.id}/overlay?v=${encodeURIComponent(o.image)}` : ''
  useEffect(() => {
    const pane = map.getPane('plan') ?? map.createPane('plan')
    pane.style.zIndex = '350'   // above tiles, below shapes and markers
    pane.style.pointerEvents = 'none'
    const el = document.createElement('img')
    el.className = 'plan-img leaflet-zoom-hide'
    pane.appendChild(el)
    img.current = el
    return () => el.remove()
  }, [map])
  useEffect(() => {
    const el = img.current
    if (!el) return
    if (!o || !opacity) { el.style.display = 'none'; return }
    const r = (-o.rotation * Math.PI) / 180, a0 = o.scale * Math.cos(r), a1 = o.scale * Math.sin(r)
    // plan pixel (u, v) -> site metres: (a0 + i·a1)(u − i·v) + (x + i·y)
    const pt = (u: number, v: number) => map.latLngToLayerPoint(toLatLng(site, [a0 * u + a1 * v + o.x, a1 * u - a0 * v + o.y]))
    const place = () => {
      const W = el.naturalWidth, H = el.naturalHeight
      if (!W) return
      const p0 = pt(0, 0), pW = pt(W, 0), pH = pt(0, H)
      el.style.width = `${W}px`
      el.style.height = `${H}px`
      el.style.transform = `matrix(${(pW.x - p0.x) / W}, ${(pW.y - p0.y) / W}, ${(pH.x - p0.x) / H}, ${(pH.y - p0.y) / H}, ${p0.x}, ${p0.y})`
    }
    el.style.display = ''
    el.style.opacity = String(opacity)
    el.onload = place
    if (el.getAttribute('src') !== src) el.src = src
    else place()
    map.on('zoomend viewreset', place)
    return () => { map.off('zoomend viewreset', place) }
  }, [map, site, o, src, opacity])
  return null
}

/** Show/hide and fade the floor plan; a Leaflet control so it sits with the zoom buttons. */
function PlanControl() {
  const map = useMap()
  const { planOpacity, setPlanOpacity } = useStudio()
  const last = useRef(planOpacity || 0.75)
  const [el] = useState(() => {
    const d = L.DomUtil.create('div', 'leaflet-bar plan-ctl')
    L.DomEvent.disableClickPropagation(d)
    L.DomEvent.disableScrollPropagation(d)
    return d
  })
  useEffect(() => {
    const c = new (L.Control.extend({ onAdd: () => el }))({ position: 'bottomright' })
    c.addTo(map)
    return () => { c.remove() }
  }, [map, el])
  if (planOpacity) last.current = planOpacity
  return createPortal(
    <>
      <label data-tip="Show the floor plan over the satellite view" data-tip-pos="left">
        <input type="checkbox" checked={planOpacity > 0} onChange={(e) => setPlanOpacity(e.target.checked ? last.current : 0)} /> Plan
      </label>
      {planOpacity > 0 && <input type="range" min={0.15} max={1} step={0.05} value={planOpacity} onChange={(e) => setPlanOpacity(+e.target.value)} aria-label="Plan opacity" />}
    </>, el)
}

function Spots({ site, floorId, spotColor, spotTip, onSpotClick, onSpotDrag, selectedSpot, linkFrom, drag }:
  Props & { drag: React.RefObject<((xy: XY) => void) | null> }) {
  const map = useMap()
  const ll = (p: XY) => toLatLng(site, p)
  const spots = site.spots.filter((s) => s.floor === floorId && s.x != null)
  const byId = new Map(site.spots.map((s) => [s.id, s]))
  const floorName = (id: string) => site.floors.find((f) => f.id === id)?.name ?? `floor ${id}`
  // Links to other floors, shown as a dashed ring and in the tooltip
  const across = (s: Spot) => site.edges.flatMap((e) => {
    if (e.a !== s.id && e.b !== s.id) return []
    const o = byId.get(other(e, s.id))
    return o && o.floor !== s.floor ? [`${e.via ?? 'link'} to ${floorName(o.floor)}: ${o.name || o.id}`] : []
  })
  // Destinations on top, selected last so it is never hidden
  spots.sort((a, b) => (+!!a.dest - +!!b.dest) || (+(a.id === selectedSpot) - +(b.id === selectedSpot)))
  return spots.map((s) => {
    const sel = s.id === selectedSpot || s.id === linkFrom
    const fill = spotColor?.(s) ?? (s.dest ? DEST_COLOR : SPOT_COLOR)
    const up = across(s)
    const r = s.dest ? (sel ? 10 : 8) : (sel ? 8 : 5)
    return [
      up.length > 0 && <CircleMarker key={`x${s.id}`} center={ll([s.x!, s.y!])} radius={r + 5} interactive={false}
        pathOptions={{ color: '#fff', weight: 2, dashArray: '3 3', fill: false }} />,
      <CircleMarker key={s.id} center={ll([s.x!, s.y!])} radius={r}
        bubblingMouseEvents={!onSpotClick}
        eventHandlers={{
          click: () => onSpotClick?.(s.id),
          mousedown: () => {
            if (s.id !== selectedSpot || !onSpotDrag) return
            map.dragging.disable()
            drag.current = (xy) => onSpotDrag(s.id, xy)
          },
        }}
        pathOptions={{ color: sel ? '#fff' : s.dest ? '#fff' : '#0b1a1a', weight: sel ? 3 : 2, fillColor: s.id === linkFrom ? LINK_COLOR : fill, fillOpacity: 1, className: s.id === selectedSpot && onSpotDrag ? 'grab' : '' }}>
        <Tooltip direction="top" offset={[0, -6]} permanent={!!s.dest} className={s.dest ? 'destlabel' : ''}>
          {/* Destination labels are always on: name only, to keep the map clean */}
          {s.name || s.id}{up.length > 0 && <> ↕</>}
          {spotTip && !s.dest ? <><br /><span className="tipline">{spotTip(s)}</span></> : null}
          {!s.dest && up.map((t) => <span key={t}><br /><span className="tipline">↕ {t}</span></span>)}
        </Tooltip>
      </CircleMarker>,
    ]
  })
}

/** Links between spots on this floor, and the route if there is one. */
function Links({ site, floorId, onEdgeClick, selectedEdge, route }: Props) {
  const ll = (p: XY) => toLatLng(site, p)
  const byId = new Map(site.spots.map((s) => [s.id, s]))
  const here = (id: string) => { const s = byId.get(id); return s && s.floor === floorId && s.x != null ? s : null }
  const isSel = (a: string, b: string) => !!selectedEdge && ((selectedEdge[0] === a && selectedEdge[1] === b) || (selectedEdge[0] === b && selectedEdge[1] === a))
  const legs = (route ?? []).slice(1).flatMap((id, i) => { const a = here(route![i]), b = here(id); return a && b ? [[a, b]] : [] })
  return (
    <>
      {site.edges.map((e) => {
        const a = here(e.a), b = here(e.b)
        if (!a || !b) return null
        const sel = isSel(e.a, e.b)
        return (
          <Polyline key={`${e.a}-${e.b}-${!!onEdgeClick}`} positions={[ll([a.x!, a.y!]), ll([b.x!, b.y!])]}
            interactive={!!onEdgeClick} bubblingMouseEvents={false}
            eventHandlers={onEdgeClick ? { click: () => onEdgeClick(e.a, e.b) } : undefined}
            pathOptions={{ color: sel ? '#fff' : LINK_COLOR, weight: sel ? 5 : 3, opacity: route ? 0.45 : 0.9 }} />
        )
      })}
      {legs.map(([a, b], i) => (
        <Polyline key={`r${i}`} positions={[ll([a.x!, a.y!]), ll([b.x!, b.y!])]} interactive={false}
          pathOptions={{ color: ROUTE_COLOR, weight: 6, opacity: 0.95, lineCap: 'round' }} />
      ))}
    </>
  )
}

/** Rings of the selected shape, and how to write a changed ring back. `key` groups one drag into one undo step. */
export interface EditRings {
  rings: XY[][]
  onChange: (ring: number, pts: XY[], key: string) => void
  snapTo?: XY[][]   // other shapes' corners to snap onto
}

let dragSeq = 0

/**
 * Corner handles: drag a corner to move it, drag (or click) the small dot in
 * the middle of an edge to add a corner there, double-click a corner to remove it.
 * No tooltips: handles are re-created mid-drag and Leaflet throws on a tooltip
 * opening for a removed layer. The hint bar explains them instead.
 */
function Handles({ site, edit, drag }: { site: Site; edit: EditRings; drag: React.RefObject<((xy: XY) => void) | null> }) {
  const map = useMap()
  const ll = (p: XY) => toLatLng(site, p)
  const start = (move: (xy: XY) => void) => { map.dragging.disable(); drag.current = move }
  const put = (xy: XY): XY => (edit.snapTo ? snap(xy, edit.snapTo, 0.4) : xy)
  return edit.rings.flatMap((ring, r) => ring.flatMap((p, i) => {
    const q = ring[(i + 1) % ring.length]
    const mid: XY = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
    return [
      <CircleMarker key={`m${r}-${i}`} center={ll(mid)} radius={5} bubblingMouseEvents={false}
        pathOptions={{ color: '#fff', weight: 1, fillColor: '#fff', fillOpacity: 0.35, className: 'handle-mid' }}
        eventHandlers={{
          mousedown: () => {
            const key = `ring-${++dragSeq}`
            const add = (xy: XY) => { const n = ring.slice(); n.splice(i + 1, 0, put(xy)); edit.onChange(r, n, key) }
            add(mid)
            start(add)
          },
        }} />,
      <CircleMarker key={`v${r}-${i}`} center={ll(p)} radius={7} bubblingMouseEvents={false}
        pathOptions={{ color: '#111', weight: 1.5, fillColor: '#fff', fillOpacity: 1, className: 'handle' }}
        eventHandlers={{
          mousedown: () => {
            const key = `ring-${++dragSeq}`
            start((xy) => { const n = ring.slice(); n[i] = put(xy); edit.onChange(r, n, key) })
          },
          dblclick: () => { if (ring.length > 3) edit.onChange(r, ring.filter((_, j) => j !== i), `ring-${++dragSeq}`) },
        }} />,
    ]
  }))
}

export default function SiteMap(props: Props) {
  const { site, floorId, onClick, onMove, onOutlineClick, selectedOutline, focus, crosshair, children } = props
  const floor = site.floors.find((f) => f.id === floorId) ?? site.floors[0]
  const planOpacity = useStudio((s) => s.planOpacity)
  const ll = (p: XY) => toLatLng(site, p)
  const drag = useRef<((xy: XY) => void) | null>(null)
  return (
    <MapContainer className={`map ${crosshair ? 'crosshair' : ''}`} center={[site.anchor.lat, site.anchor.lon]} zoom={18} maxZoom={22}
      doubleClickZoom={false} zoomControl={false} attributionControl={false}>
      <ZoomControl position="bottomright" />
      <LayersControl position="bottomright">
        <LayersControl.BaseLayer checked name="Satellite">
          {/* Esri has no z19 imagery over the campus ("Map data not yet available"), so upscale z18 */}
          <TileLayer url={ESRI} maxNativeZoom={18} maxZoom={22} attribution="Imagery © Esri, Maxar, Earthstar Geographics" />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Streets">
          <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxNativeZoom={19} maxZoom={22} attribution="© OpenStreetMap contributors" />
        </LayersControl.BaseLayer>
      </LayersControl>
      {site.floors.some((f) => f.overlay) && <PlanControl />}
      <ScaleControl position="bottomright" imperial={false} maxWidth={140} />
      <AttributionControl position="bottomright" prefix={false} />
      <FitOnce site={site} />
      <Focus site={site} focus={focus} />
      <Events site={site} onClick={onClick} onMove={onMove} drag={drag} />
      {floor && <FloorPlan site={site} floor={floor} opacity={planOpacity} />}
      {/* Buildings: each outer ring with its courtyards as holes. Courtyards also
          get their own (nearly invisible) shape so they can be clicked. */}
      {floor && (() => {
        const parents = ringParents(floor.outline)
        // Leaflet reads `interactive` only when a layer is created, so it is part of the key
        const k = (i: number, r: XY[]) => `o${i}-${r.length}-${!!onOutlineClick}`
        // Over a floor plan the outline is only a thin guide
        const fill = floor.overlay && planOpacity ? 0 : 0.08
        const style = (i: number, f: number) => ({ color: i === selectedOutline ? '#fff' : '#ffd166', weight: i === selectedOutline ? 3 : 2, fillOpacity: f })
        return floor.outline.map((ring, i) => parents[i] === -1 ? (
          <Polygon key={k(i, ring)} positions={[ring.map(ll), ...floor.outline.filter((_, j) => parents[j] === i).map((h) => h.map(ll))]}
            interactive={!!onOutlineClick} bubblingMouseEvents={false} pathOptions={style(i, fill)}
            eventHandlers={onOutlineClick ? { click: () => onOutlineClick(i) } : undefined}>
            {onOutlineClick && <Tooltip sticky>Building outline</Tooltip>}
          </Polygon>
        ) : (
          <Polygon key={k(i, ring)} positions={ring.map(ll)} interactive={!!onOutlineClick} bubblingMouseEvents={false}
            pathOptions={{ ...style(i, 0.01), dashArray: '5 4' }} eventHandlers={onOutlineClick ? { click: () => onOutlineClick(i) } : undefined}>
            {onOutlineClick && <Tooltip sticky>Courtyard</Tooltip>}
          </Polygon>
        ))
      })()}
      {/* Fixed stacking: outlines (overlay pane, 400) < links < spots and handles. Without panes,
          a layer re-created on a tool change lands on top of everything drawn before it. */}
      {floor && <Pane name="links" style={{ zIndex: 450 }}><Links {...props} floorId={floor.id} /></Pane>}
      <Pane name="spots" style={{ zIndex: 500 }}>
        {floor && <Spots {...props} floorId={floor.id} drag={drag} />}
        {props.editRings && <Handles site={site} edit={props.editRings} drag={drag} />}
      </Pane>
      {children}
    </MapContainer>
  )
}
