import type { LatLngTuple } from 'leaflet'
import polygonClipping from 'polygon-clipping'
import type { Site, XY } from './types'

// Local frame <-> lat/lon. A flat-earth approximation is well under a
// centimetre off across a campus, which is far below WiFi accuracy.
const M_PER_DEG = 111320

export function toLatLng(site: Site, [x, y]: XY): LatLngTuple {
  const { lat, lon, rotation } = site.anchor
  const r = (rotation * Math.PI) / 180
  const e = x * Math.cos(r) + y * Math.sin(r)
  const n = -x * Math.sin(r) + y * Math.cos(r)
  return [lat + n / M_PER_DEG, lon + e / (M_PER_DEG * Math.cos((lat * Math.PI) / 180))]
}

export function toLocal(site: Site, lat: number, lng: number): XY {
  const { lat: lat0, lon, rotation } = site.anchor
  const n = (lat - lat0) * M_PER_DEG
  const e = (lng - lon) * M_PER_DEG * Math.cos((lat0 * Math.PI) / 180)
  const r = (rotation * Math.PI) / 180
  return [round(e * Math.cos(r) - n * Math.sin(r)), round(e * Math.sin(r) + n * Math.cos(r))]
}

export const round = (v: number) => Math.round(v * 100) / 100
export const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Points every `step` metres along a polyline (for auto-placing spots). */
export function along(line: XY[], step: number): XY[] {
  const out: XY[] = [line[0]]
  let carry = 0
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]]
    const L = dist(a, b)
    let t = step - carry
    while (t <= L) {
      out.push([round(a[0] + ((b[0] - a[0]) * t) / L), round(a[1] + ((b[1] - a[1]) * t) / L)])
      t += step
    }
    carry = L - (t - step)
  }
  return out
}

/** For each outline ring, the index of the ring it sits inside (a courtyard), or -1 for a building. */
// A ring is a courtyard only if all its corners are inside the other ring, so
// overlapping buildings stay separate; nested in several, it takes the smallest.
export function ringParents(rings: XY[][]): number[] {
  return rings.map((r, i) => {
    let best = -1
    rings.forEach((o, j) => {
      if (j !== i && o.length > 2 && r.length && ringArea(o) > ringArea(r) && r.every((p) => pointInPoly(p, o))
        && (best === -1 || ringArea(o) < ringArea(rings[best]))) best = j
    })
    return best
  })
}

// ---------------------------------------------------------------------------
// Polygons with holes: [outer ring, ...holes] (walkable areas)
// ---------------------------------------------------------------------------

/** Area of one ring, m² */
export const ringArea = (p: XY[]) => Math.abs(p.reduce((a, q, i) => { const r = p[(i + 1) % p.length]; return a + q[0] * r[1] - r[0] * q[1] }, 0) / 2)

/** Area of a polygon with holes, m² */
export const polyArea = (poly: XY[][]) => poly.reduce((a, r, i) => a + (i ? -1 : 1) * ringArea(r), 0)

/** Inside the outer ring and not in a hole */
export const inPoly = (p: XY, poly: XY[][]) => pointInPoly(p, poly[0]) && !poly.slice(1).some((h) => pointInPoly(p, h))

const closed = (r: XY[]): XY[] => [...r, r[0]]
const opened = (r: XY[]): XY[] => r.slice(0, -1).map(([x, y]) => [round(x), round(y)] as XY)

/** Union of polygons. Several results if some don't overlap. */
export function union(polys: XY[][][]): XY[][][] {
  const [first, ...rest] = polys.map((p) => p.map(closed))
  return polygonClipping.union(first, ...rest).map((poly) => poly.map(opened))
}

/** Do two polygons overlap or share an edge (so they merge into one)? */
export const joins = (a: XY[][], b: XY[][]) => union([a, b]).length === 1

/** Snap to the nearest existing corner within `tol` metres (so shapes meet exactly). */
export function snap(p: XY, rings: XY[][], tol = 0.6): XY {
  let best: XY = p, bd = tol
  for (const r of rings) for (const q of r) { const d = dist(p, q); if (d < bd) { bd = d; best = q } }
  return best
}

export function pointInPoly([x, y]: XY, poly: XY[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
