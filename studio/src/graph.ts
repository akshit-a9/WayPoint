// Routing over the links between spots, as the firmware does it: one
// Dijkstra from where you stand gives every destination's distance at once
// (for the menu), then the path to the chosen one.
import { dist } from './geo'
import type { Edge, Site, Spot, XY } from './types'

export const sameEdge = (e: Edge, a: string, b: string) => (e.a === a && e.b === b) || (e.a === b && e.b === a)
export const other = (e: Edge, id: string) => (e.a === id ? e.b : e.a)

const w360 = (a: number) => ((a % 360) + 360) % 360
export const w180 = (a: number) => { a = w360(a); return a > 180 ? a - 360 : a }
/** Bearing from a to b in the site frame, degrees clockwise from the frame's north (y). Add anchor.rotation for the compass. */
export const bearing = (a: XY, b: XY) => w360((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI)

/** Height of a floor above the ground floor, m */
export function elevation(site: Site, floorId: string) {
  const f = site.floors.find((x) => x.id === floorId)
  return f ? site.floors.filter((x) => x.level < f.level).reduce((a, x) => a + x.height, 0) : 0
}

const xy = (s: Spot): XY => [s.x!, s.y!]

/** Walking length of a link: straight line, plus the climb for stairs and ramps. */
export function edgeLength(site: Site, e: Edge) {
  const a = site.spots.find((s) => s.id === e.a), b = site.spots.find((s) => s.id === e.b)
  if (a?.x == null || b?.x == null) return Infinity
  const climb = Math.abs(elevation(site, a.floor) - elevation(site, b.floor))
  return dist(xy(a), xy(b)) + (e.via === 'lift' ? 0 : climb)
}

export interface Field { from: string; len: Map<string, number>; prev: Map<string, string> }

export function shortest(site: Site, from: string): Field {
  const adj = new Map<string, [string, number][]>()
  for (const e of site.edges) {
    const L = edgeLength(site, e)
    if (!Number.isFinite(L)) continue
    adj.set(e.a, [...(adj.get(e.a) ?? []), [e.b, L]])
    adj.set(e.b, [...(adj.get(e.b) ?? []), [e.a, L]])
  }
  // A few hundred spots at most: a plain scan for the nearest open node is fine
  const len = new Map([[from, 0]]), prev = new Map<string, string>(), done = new Set<string>()
  for (;;) {
    let u: string | null = null
    for (const [k, v] of len) if (!done.has(k) && (u === null || v < len.get(u)!)) u = k
    if (u === null) break
    done.add(u)
    for (const [v, L] of adj.get(u) ?? []) {
      const n = len.get(u)! + L
      if (n < (len.get(v) ?? Infinity)) { len.set(v, n); prev.set(v, u) }
    }
  }
  return { from, len, prev }
}

/** Spot ids from the field's start to `to`, or null if it can't be reached. */
export function pathTo(F: Field, to: string): string[] | null {
  if (!F.len.has(to)) return null
  const out = [to]
  while (out[0] !== F.from) out.unshift(F.prev.get(out[0])!)
  return out
}

/** Placed spots grouped by which ones can reach each other (one group = fully connected). */
export function groups(site: Site): string[][] {
  const ids = site.spots.filter((s) => s.x != null).map((s) => s.id), seen = new Set<string>(), out: string[][] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const g = [...shortest(site, id).len.keys()]
    g.forEach((k) => seen.add(k))
    out.push(g)
  }
  return out.sort((a, b) => b.length - a.length)
}
