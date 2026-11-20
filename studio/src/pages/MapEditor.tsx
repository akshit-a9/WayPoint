import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleMarker, Polygon, Polyline } from 'react-leaflet'
import { api, useAction, useRecordings } from '../api'
import SiteMap, { DEST_COLOR, LINK_COLOR, ROUTE_COLOR, SPOT_COLOR, type EditRings } from '../components/SiteMap'
import { ConfirmButton, typing } from '../components/ui'
import { along, dist, joins, ringArea, ringParents, round, snap, toLatLng, union } from '../geo'
import { edgeLength, groups, other, pathTo, sameEdge, shortest } from '../graph'
import { useStudio } from '../store'
import type { Floor, Site, Spot, Via, XY } from '../types'

type Tool = 'select' | 'spot' | 'dest' | 'path' | 'link' | 'outline' | 'measure' | 'place'

// [id, icon, label, key, what it does]
const TOOLS: [Tool, string, string, string, string][] = [
  ['select', '⬚', 'Select', 'V', 'Select and drag spots, destinations, links and outlines'],
  ['dest', '◆', 'Destination', 'D', 'Click to add a place people can navigate to (room, stairs, exit…). It is also a recording spot.'],
  ['spot', '●', 'Spot', 'S', 'Click to add a recording spot (helps localization; not in the navigation menu)'],
  ['path', '⋯', 'Spots along path', 'L', 'Click along a corridor, then place spots every few metres'],
  ['link', '⟋', 'Connect spots', 'C', 'Click spots one after another to link the ones you can walk straight between. Routes follow these links.'],
  ['outline', '⬠', 'Building outline', 'O', 'Trace a building\'s walls on the satellite view; Enter to finish. Draw one inside another for a courtyard.'],
  ['measure', '↔', 'Measure', 'M', 'Click points to measure distances'],
]
const HINTS: Record<Tool, string> = {
  select: 'Click a marker, link or outline to edit it · drag the selected marker to move it · arrows nudge · Del deletes',
  outline: 'Click along the building\'s walls · click the first corner or Enter to close · Backspace removes the last corner · draw inside a building for a courtyard',
  spot: 'Click to add spots · click an existing marker to select it · Esc when done',
  dest: 'Click to add a destination, type its name, Enter · Esc when done',
  path: 'Click along the corridor · then choose the spacing',
  link: 'Click a spot, then the next one you can walk straight to · keep clicking to chain · click an existing link\'s ends to remove it · Esc or empty map to stop',
  measure: 'Click points to measure · Esc clears',
  place: 'Click where the building\'s centre is on the satellite view',
}
const VIAS: Via[] = ['stairs', 'lift', 'ramp']
const CATEGORIES = ['room', 'washroom', 'stairs', 'lift', 'exit', 'common', 'mess', 'office']

const nextId = (ids: string[]) => {
  let n = 1
  while (ids.includes(`S${n}`)) n++
  return `S${n}`
}
const label = (s: Spot) => s.name || s.id
const SHAPE_HINT = 'Drag a corner to move it · drag a small dot to add a corner · double-click a corner to remove it · Del deletes'

/** Each building as [outer, ...courtyards], with the outline ring indices it came from. */
function buildings(outline: XY[][]) {
  const parents = ringParents(outline)
  return outline.flatMap((r, i) => parents[i] === -1 ? [{ rings: [i, ...parents.flatMap((p, j) => (p === i ? [j] : []))], poly: [r, ...outline.filter((_, j) => parents[j] === i)] }] : [])
}

/** Add the link a–b, or remove it if it is there. */
function toggleLink(s: Site, a: string, b: string, via?: Via) {
  const i = s.edges.findIndex((e) => sameEdge(e, a, b))
  if (i >= 0) s.edges.splice(i, 1)
  else s.edges.push(via ? { a, b, via } : { a, b })
}

/** Delete a spot and its links. */
function removeSpot(s: Site, id: string) {
  s.spots = s.spots.filter((p) => p.id !== id)
  s.edges = s.edges.filter((e) => e.a !== id && e.b !== id)
}

export default function MapEditor({ goTo }: { goTo: (t: 'record') => void }) {
  const { siteId, floorId, draft, edit, selection, select, setRecordSpot } = useStudio()
  const { data: rec } = useRecordings(siteId)
  const [tool, setTool] = useState<Tool>('select')
  const [pts, setPts] = useState<XY[]>([])
  const [cursor, setCursor] = useState<XY | null>(null)
  const [step, setStep] = useState(3)
  const [focus, setFocus] = useState<XY | null>(null)
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  const [route, setRoute] = useState<string[] | null>(null)
  const takes = rec?.perSpot ?? {}

  const site = draft!
  const floor = site.floors.find((f) => f.id === floorId) ?? site.floors[0]
  const ll = (p: XY) => toLatLng(site, p)
  const selSpot = selection?.kind === 'spot' ? site.spots.find((s) => s.id === selection.id) : undefined
  const selEdge = selection?.kind === 'edge' ? site.edges.find((e) => sameEdge(e, selection.a, selection.b)) : undefined
  const editFloor = (fn: (f: Floor) => void, merge?: string) => edit((s) => fn(s.floors.find((f) => f.id === floor.id)!), merge)
  const linkSpot = linkFrom ? site.spots.find((s) => s.id === linkFrom && s.floor === floor.id) : undefined
  const pickTool = (t: Tool) => { setTool(t); setPts([]); setLinkFrom(null) }

  // Connect tool: each click links the previous spot to this one and carries on from here
  const linkClick = (id: string) => {
    if (linkFrom && linkFrom !== id) edit((s) => toggleLink(s, linkFrom, id))
    setLinkFrom(linkFrom === id ? null : id)
  }

  const finishOutline = () => {
    if (pts.length < 3) return
    editFloor((f) => { f.outline.push(pts) })
    select({ kind: 'outline', index: floor.outline.length })
    setPts([])
  }
  const placePath = () => {
    if (pts.length < 2) return
    edit((s) => along(pts, step).forEach((p) => s.spots.push({ id: nextId(s.spots.map((x) => x.id)), name: '', floor: floor.id, x: round(p[0]), y: round(p[1]) })))
    setPts([])
  }
  const deleteSelected = () => {
    if (selEdge) { edit((s) => toggleLink(s, selEdge.a, selEdge.b)); select(null) }
    if (selection?.kind === 'outline') { editFloor((f) => { f.outline.splice(selection.index, 1) }); select(null) }
    if (selSpot && !(takes[selSpot.id] > 0)) { edit((s) => removeSpot(s, selSpot.id)); select(null) }
  }

  // Keyboard: tool keys, Esc, Enter, Delete, arrows to nudge
  const keyState = useRef({ tool, pts, selSpot, linkFrom, deleteSelected, finishOutline, placePath })
  keyState.current = { tool, pts, selSpot, linkFrom, deleteSelected, finishOutline, placePath }
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return
      const st = keyState.current
      const t = TOOLS.find((x) => x[3].toLowerCase() === e.key.toLowerCase())
      if (t) { setTool(t[0]); setPts([]); setLinkFrom(null); return }
      if (e.key === 'Escape') {
        if (st.pts.length) setPts([])
        else if (st.linkFrom) setLinkFrom(null)
        else if (st.tool !== 'select') setTool('select')
        else select(null)
      } else if (e.key === 'Enter') {
        if (st.tool === 'outline') st.finishOutline()
        if (st.tool === 'path') st.placePath()
      } else if (e.key === 'Backspace' && st.pts.length) {
        setPts(st.pts.slice(0, -1))
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        st.deleteSelected()
      } else if (st.selSpot && e.key.startsWith('Arrow')) {
        e.preventDefault()
        const d = e.shiftKey ? 1 : 0.25
        const [dx, dy] = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key]!
        const id = st.selSpot.id
        edit((s) => { const p = s.spots.find((x) => x.id === id)!; p.x = round(p.x! + dx); p.y = round(p.y! + dy) }, `nudge-${id}`)
      }
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [edit, select])

  const click = (xy: XY) => {
    const p: XY = [round(xy[0]), round(xy[1])]
    if (tool === 'select') select(null)
    else if (tool === 'link') setLinkFrom(null)
    else if (tool === 'spot' || tool === 'dest') {
      const id = nextId(site.spots.map((x) => x.id))
      edit((s) => { s.spots.push({ id, name: '', floor: floor.id, x: p[0], y: p[1], dest: tool === 'dest' ? { category: 'room' } : null }) })
      select({ kind: 'spot', id })
    } else if (tool === 'place') {
      // Move the anchor so the outline's centre lands on the clicked point
      const ring = floor.outline[0] ?? [[0, 0] as XY]
      const c: XY = [ring.reduce((a, q) => a + q[0], 0) / ring.length, ring.reduce((a, q) => a + q[1], 0) / ring.length]
      const [lat, lon] = toLatLng(site, xy)
      const [clat, clon] = toLatLng(site, c)
      edit((s) => { s.anchor.lat += lat - clat; s.anchor.lon += lon - clon })
      setTool('select')
    } else if (tool === 'outline') {
      // Snap onto existing corners so shapes meet exactly; clicking the first corner closes the shape
      const q = snap(p, [...floor.outline, pts])
      if (pts.length >= 3 && q === pts[0]) finishOutline()
      else setPts([...pts, q])
    } else setPts([...pts, p])
  }

  // Corner handles for the selected outline
  const editRings: EditRings | null = tool !== 'select' ? null
    : selection?.kind === 'outline' && floor.outline[selection.index] ? {
      rings: [floor.outline[selection.index]],
      snapTo: floor.outline.filter((r) => r !== floor.outline[selection.index]),
      onChange: (_, ring, key) => editFloor((f) => { f.outline[selection.index] = ring }, key),
    }
    : null

  const length = pts.reduce((a, p, i) => (i ? a + dist(pts[i - 1], p) : 0), 0)
  const live = cursor ? [...pts, cursor] : pts

  return (
    <div className="split">
      <div className="mapwrap">
        <SiteMap site={site} floorId={floor.id} onClick={click} onMove={setCursor} focus={focus}
          crosshair={tool !== 'select'}
          onSpotClick={tool === 'link' ? linkClick : tool === 'select' || tool === 'spot' || tool === 'dest' ? (id) => select({ kind: 'spot', id }) : undefined}
          onSpotDrag={tool === 'select' ? (id, xy) => edit((s) => { const p = s.spots.find((x) => x.id === id)!; p.x = round(xy[0]); p.y = round(xy[1]) }, `drag-${id}`) : undefined}
          onEdgeClick={tool === 'select' ? (a, b) => select({ kind: 'edge', a, b }) : undefined}
          onOutlineClick={tool === 'select' ? (index) => select({ kind: 'outline', index }) : undefined}
          selectedSpot={selSpot?.id} selectedEdge={selEdge ? [selEdge.a, selEdge.b] : null} linkFrom={linkSpot?.id} route={route}
          selectedOutline={selection?.kind === 'outline' ? selection.index : null} editRings={editRings}
          spotTip={(s) => `${s.dest ? s.dest.category : 'recording spot'} · ${takes[s.id] ?? 0} takes`}>
          {linkSpot && cursor && <Polyline positions={[ll([linkSpot.x!, linkSpot.y!]), ll(cursor)]} interactive={false}
            pathOptions={{ color: LINK_COLOR, weight: 2, dashArray: '5 5' }} />}
          {pts.length > 0 && (tool === 'outline'
            ? <Polygon positions={live.map(ll)} pathOptions={{ color: '#ffd166', dashArray: '4 4' }} interactive={false} />
            : <Polyline positions={live.map(ll)} pathOptions={{ color: tool === 'measure' ? '#ff4d6d' : '#06d6a0', dashArray: '4 4' }} interactive={false} />)}
          {tool === 'path' && pts.length > 1 && along(pts, step).map((p, i) => (
            <CircleMarker key={i} center={ll(p)} radius={4} interactive={false} pathOptions={{ color: '#06d6a0', fillOpacity: 0.5 }} />
          ))}
        </SiteMap>

        <div className="toolbar">
          {TOOLS.map(([t, icon, name, key, tip]) => (
            <button key={t} className={tool === t ? 'on' : ''} onClick={() => pickTool(t)} data-tip={`${name} (${key}) — ${tip}`} data-tip-pos="right" aria-label={name}>
              <span className="ti">{icon}</span><span className="tk">{key}</span>
            </button>
          ))}
        </div>

        <div className="hintbar">
          <span>{editRings ? SHAPE_HINT : tool === 'link' && linkSpot ? `Linking from ${label(linkSpot)} · click the next spot · Esc to stop` : HINTS[tool]}</span>
          {tool === 'outline' && pts.length >= 3 && <button className="primary" onClick={finishOutline}>Finish outline</button>}
          {tool === 'path' && pts.length >= 2 && (
            <>
              <label data-tip="Distance between the new spots">every <input type="number" min={1} max={20} step={0.5} value={step} onChange={(e) => setStep(+e.target.value)} /> m</label>
              <button className="primary" onClick={placePath}>Place {along(pts, step).length} spots</button>
            </>
          )}
          {tool === 'measure' && pts.length > 1 && <b>{length.toFixed(2)} m</b>}
        </div>

        {cursor && <div className="coords">x {cursor[0].toFixed(1)} · y {cursor[1].toFixed(1)} m{(tool === 'measure' || tool === 'path' || tool === 'outline') && pts.length ? ` · ${(length + dist(pts[pts.length - 1], cursor)).toFixed(2)} m`
          : linkSpot ? ` · ${dist([linkSpot.x!, linkSpot.y!], cursor).toFixed(1)} m from ${label(linkSpot)}` : ''}</div>}
      </div>

      <aside className="side">
        {selSpot ? <SpotPanel spot={selSpot} takes={takes[selSpot.id] ?? 0} onRecord={() => { setRecordSpot(selSpot.id); goTo('record') }} />
          : selEdge ? <EdgePanel site={site} a={selEdge.a} b={selEdge.b} />
          : selection?.kind === 'outline' && floor.outline[selection.index] ? <OutlinePanel floor={floor} index={selection.index} />
          : <Overview site={site} floor={floor} takes={takes} setTool={pickTool} route={route} setRoute={setRoute}
              onPick={(s) => { select({ kind: 'spot', id: s.id }); setFocus([s.x!, s.y!]) }} />}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
function SpotPanel({ spot, takes, onRecord }: { spot: Spot; takes: number; onRecord: () => void }) {
  const { edit, select, siteId } = useStudio()
  const { data: rec } = useRecordings(siteId)
  const delTake = useAction((t: string) => api.deleteTake(siteId!, t), [['recordings', siteId ?? ''], ['sites']])
  const name = useRef<HTMLInputElement>(null)
  const set = (fn: (s: Spot) => void, merge?: string) => edit((s) => fn(s.spots.find((p) => p.id === spot.id)!), merge)
  // New destination: jump straight to its name
  useEffect(() => { if (spot.dest && !spot.name) name.current?.focus() }, [spot.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async () => {
    for (const t of rec?.takes.filter((t) => t.spot === spot.id) ?? []) await delTake.mutateAsync(t.take)
    edit((s) => removeSpot(s, spot.id))
    select(null)
  }

  return (
    <section className="card inspector">
      <div className="row between">
        <span className="kind" style={{ color: spot.dest ? DEST_COLOR : SPOT_COLOR }}>{spot.dest ? '◆ Destination' : '● Recording spot'} <span className="muted">{spot.id}</span></span>
        <button className="icon" onClick={() => select(null)} data-tip="Close (Esc)">✕</button>
      </div>

      <label className="block">Name
        <input ref={name} value={spot.name} placeholder={spot.dest ? 'e.g. Room 104 (shown on the device)' : 'optional, e.g. Corridor by stairs'}
          className={spot.dest && !spot.name ? 'needs' : ''}
          onChange={(e) => set((s) => { s.name = e.target.value }, `name-${spot.id}`)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur() }} />
      </label>

      <div className="seg" role="radiogroup">
        <button className={!spot.dest ? 'on' : ''} onClick={() => set((s) => { s.dest = null })}
          data-tip="Only used to tell where you are; not in the device's navigation menu">Recording spot</button>
        <button className={spot.dest ? 'on' : ''} onClick={() => set((s) => { s.dest = { category: s.dest?.category ?? 'room' } })}
          data-tip="Also listed on the device as a place to navigate to">Destination</button>
      </div>

      {spot.dest && (
        <div className="chips">
          {CATEGORIES.map((c) => <button key={c} className={spot.dest!.category === c ? 'on' : ''} onClick={() => set((s) => { s.dest!.category = c })}>{c}</button>)}
        </div>
      )}

      <div className="row">
        <label data-tip="Metres east of the site origin">x <input type="number" step={0.25} value={spot.x ?? ''} onChange={(e) => set((s) => { s.x = +e.target.value }, `x-${spot.id}`)} /></label>
        <label data-tip="Metres north of the site origin">y <input type="number" step={0.25} value={spot.y ?? ''} onChange={(e) => set((s) => { s.y = +e.target.value }, `y-${spot.id}`)} /></label>
        <span className="muted small">drag on the map or use the arrow keys</span>
      </div>

      <SpotLinks key={spot.id} spot={spot} />

      <div className="row between">
        <span data-tip="Aim for 2 or more takes per spot, ideally at different times of day">
          {takes === 0 ? <span className="warn">No recordings yet</span> : `${takes} take${takes > 1 ? 's' : ''} recorded`}
        </span>
        <button className="primary" onClick={onRecord} data-tip="Open the Record tab with this spot selected">Record here →</button>
      </div>

      <ConfirmButton className="danger wide" onConfirm={remove}
        confirm={takes ? `Delete spot and its ${takes} take${takes > 1 ? 's' : ''}?` : 'Click again to delete'}
        tip={takes ? 'Its recordings are deleted too' : 'Delete (Del)'}>Delete {spot.dest ? 'destination' : 'spot'}</ConfirmButton>
    </section>
  )
}

/**
 * A spot's links: the ones on this floor (made with the Connect tool), and
 * the rare link to another floor (stairs, lift), tucked away until needed.
 */
function SpotLinks({ spot }: { spot: Spot }) {
  const { draft, edit, select } = useStudio()
  const site = draft!
  const byId = new Map(site.spots.map((s) => [s.id, s]))
  const links = site.edges.filter((e) => e.a === spot.id || e.b === spot.id)
    .map((e) => ({ e, o: byId.get(other(e, spot.id))! })).filter((l) => l.o)
  const floorName = (id: string) => site.floors.find((f) => f.id === id)?.name ?? id
  const others = site.floors.filter((f) => f.id !== spot.floor)
  const [toFloor, setToFloor] = useState(others[0]?.id ?? '')
  const [via, setVia] = useState<Via>(spot.dest?.category === 'lift' ? 'lift' : 'stairs')
  // Candidates on the other floor, nearest first (stairs and lifts sit above each other)
  const cands = site.spots.filter((s) => s.floor === toFloor && s.x != null && spot.x != null)
    .map((s) => ({ s, d: dist([s.x!, s.y!], [spot.x!, spot.y!]) })).sort((a, b) => a.d - b.d)
  const [to, setTo] = useState('')
  const target = cands.find((c) => c.s.id === to) ?? cands[0]
  const crossing = links.filter((l) => l.o.floor !== spot.floor)

  return (
    <div className="links">
      <div className="row between">
        <b className="small">Links</b>
        <span className="muted small">{links.length ? `${links.length} · routes follow these` : 'none yet: use Connect (C)'}</span>
      </div>
      {links.map(({ e, o }) => (
        <div key={o.id} className="linkrow">
          <span style={{ color: o.floor !== spot.floor ? '#fff' : LINK_COLOR }}>{o.floor !== spot.floor ? '↕' : '—'}</span>
          <button className="grow plain" onClick={() => select({ kind: 'spot', id: o.id })} data-tip="Select this spot">
            {label(o)}{o.floor !== spot.floor && <span className="muted"> · {e.via ?? 'link'} to {floorName(o.floor)}</span>}
          </button>
          <span className="muted small">{edgeLength(site, e).toFixed(1)} m</span>
          <button className="icon" onClick={() => edit((s) => toggleLink(s, e.a, e.b))} data-tip="Remove this link">✕</button>
        </div>
      ))}
      {others.length > 0 && (
        <details className="across" open={false}>
          <summary className="muted small">{crossing.length ? 'Link to another floor…' : 'Stairs or lift here? Link to another floor…'}</summary>
          <div className="row">
            <select value={toFloor} onChange={(e) => { setToFloor(e.target.value); setTo('') }}>
              {others.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <select className="grow" value={target?.s.id ?? ''} onChange={(e) => setTo(e.target.value)} disabled={!cands.length}>
              {cands.map(({ s, d }) => <option key={s.id} value={s.id}>{label(s)} · {d.toFixed(1)} m across</option>)}
            </select>
          </div>
          <div className="row">
            <div className="seg small">
              {VIAS.map((v) => <button key={v} className={via === v ? 'on' : ''} onClick={() => setVia(v)}>{v}</button>)}
            </div>
            <button className="primary" disabled={!target || links.some((l) => l.o.id === target.s.id)}
              onClick={() => edit((s) => toggleLink(s, spot.id, target!.s.id, via))}
              data-tip="Routes can change floor here">Link</button>
          </div>
          {!cands.length && <p className="muted small">No placed spots on {floorName(toFloor)} yet.</p>}
        </details>
      )}
    </div>
  )
}

function EdgePanel({ site, a, b }: { site: Site; a: string; b: string }) {
  const { edit, select } = useStudio()
  const A = site.spots.find((s) => s.id === a)!, B = site.spots.find((s) => s.id === b)!
  const e = site.edges.find((x) => sameEdge(x, a, b))!
  const across = A.floor !== B.floor
  return (
    <section className="card inspector">
      <div className="row between">
        <span className="kind" style={{ color: LINK_COLOR }}>{across ? '↕ Link between floors' : '— Link'}</span>
        <button className="icon" onClick={() => select(null)} data-tip="Close (Esc)">✕</button>
      </div>
      <p>
        <button className="plain" onClick={() => select({ kind: 'spot', id: A.id })}>{label(A)}</button> ↔ <button className="plain" onClick={() => select({ kind: 'spot', id: B.id })}>{label(B)}</button>
        <br /><span className="muted">{edgeLength(site, e).toFixed(1)} m walk</span>
      </p>
      {across && (
        <div className="seg small">
          {VIAS.map((v) => <button key={v} className={e.via === v ? 'on' : ''} onClick={() => edit((s) => { s.edges.find((x) => sameEdge(x, a, b))!.via = v })}>{v}</button>)}
        </div>
      )}
      <p className="muted small">You can walk straight between these two spots. The device's routes follow links.</p>
      <ConfirmButton className="danger wide" onConfirm={() => { edit((s) => toggleLink(s, a, b)); select(null) }} tip="Delete (Del)">Delete link</ConfirmButton>
    </section>
  )
}

function OutlinePanel({ floor, index }: { floor: Floor; index: number }) {
  const { edit, select } = useStudio()
  const ring = floor.outline[index]
  const parents = ringParents(floor.outline)
  const courtyard = parents[index] !== -1
  const courtyards = parents.filter((p) => p === index).length
  const perimeter = ring.reduce((a, p, i) => a + dist(p, ring[(i + 1) % ring.length]), 0)
  // Buildings that overlap this one: join them into one shape (e.g. an L drawn as two rectangles)
  const near = useMemo(() => {
    const bs = buildings(floor.outline), me = bs.find((b) => b.rings[0] === index)
    return me ? bs.filter((b) => b !== me && joins(me.poly, b.poly)) : []
  }, [floor.outline, index])
  const join = () => {
    edit((s) => {
      const f = s.floors.find((x) => x.id === floor.id)!
      const bs = buildings(f.outline).filter((b) => b.rings[0] === index || near.some((n) => n.rings[0] === b.rings[0]))
      const drop = bs.flatMap((b) => b.rings)
      f.outline = [...f.outline.filter((_, j) => !drop.includes(j)), ...union(bs.map((b) => b.poly)).flat()]
    })
    select(null)
  }
  return (
    <section className="card inspector">
      <div className="row between">
        <span className="kind" style={{ color: '#ffd166' }}>⬠ {courtyard ? 'Courtyard' : 'Building outline'}</span>
        <button className="icon" onClick={() => select(null)} data-tip="Close (Esc)">✕</button>
      </div>
      <p>{ringArea(ring).toFixed(0)} m² · {perimeter.toFixed(0)} m around · {ring.length} corners{courtyards ? ` · ${courtyards} courtyard${courtyards > 1 ? 's' : ''}` : ''}</p>
      {near.length > 0 && <button className="primary wide" onClick={join} data-tip="Combine the overlapping outlines into one building shape">Join with {near.length} overlapping building{near.length > 1 ? 's' : ''}</button>}
      <p className="muted small">{courtyard ? 'An open space inside a building.'
        : 'Shown for reference while you draw; routes follow the links between spots. For a courtyard, draw an outline (O) inside this one; for another building, draw it anywhere.'} Drag the corners to reshape it.</p>
      <ConfirmButton className="danger wide" onConfirm={() => { edit((s) => { s.floors.find((f) => f.id === floor.id)!.outline.splice(index, 1) }); select(null) }}
        tip="Delete (Del)">Delete {courtyard ? 'courtyard' : 'outline'}</ConfirmButton>
    </section>
  )
}

function Overview({ site, floor, takes, setTool, onPick, route, setRoute }:
  { site: Site; floor: Floor; takes: Record<string, number>; setTool: (t: Tool) => void; onPick: (s: Spot) => void
    route: string[] | null; setRoute: (r: string[] | null) => void }) {
  const { edit } = useStudio()
  const [filter, setFilter] = useState<'all' | 'dest' | 'spot'>('all')
  const [q, setQ] = useState('')
  const spots = site.spots.filter((s) => s.floor === floor.id)
  const dests = spots.filter((s) => s.dest)
  const placed = spots.filter((s) => s.x != null)
  const hasOutline = floor.outline.length > 0
  const steps: [boolean, string, string, () => void][] = [
    hasOutline
      ? [!!site.aligned, 'Line up the building', 'Make the outline sit on the satellite view', () => document.getElementById('align')?.setAttribute('open', '')]
      : [false, 'Trace the building outline', 'Click around its walls on the satellite view (O)', () => setTool('outline')],
    [placed.length - dests.length > 0, 'Add recording spots', 'Points along the corridors, every 3–5 m', () => setTool('path')],
    [dests.length > 0, 'Mark destinations', 'Rooms, stairs, exits: what the device can navigate to. Select a spot and make it a destination, or press D', () => setTool('dest')],
    [site.edges.length > 0, 'Connect the spots', 'Link spots you can walk straight between, so the device can route (C)', () => setTool('link')],
  ]
  const shown = useMemo(() => spots
    .filter((s) => filter === 'all' || (filter === 'dest') === !!s.dest)
    .filter((s) => !q || `${s.name} ${s.id} ${s.dest?.category ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (+!!b.dest - +!!a.dest) || label(a).localeCompare(label(b), undefined, { numeric: true })), [spots, filter, q])
  const unplaced = spots.length - placed.length

  return (
    <>
      {steps.some((s) => !s[0]) && (
        <section className="card">
          <h3>Set up {site.name}</h3>
          {steps.map(([done, title, sub, go], i) => (
            <button key={i} className={`step ${done ? 'done' : ''}`} onClick={go} data-tip={done ? 'Done' : 'Start this step'}>
              <span className="tick">{done ? '✓' : i + 1}</span><span><b>{title}</b><br /><span className="muted small">{sub}</span></span>
            </button>
          ))}
        </section>
      )}

      <section className="card">
        <div className="row between">
          <h3>Places</h3>
          <div className="seg small">
            <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All {spots.length}</button>
            <button className={filter === 'dest' ? 'on' : ''} onClick={() => setFilter('dest')} data-tip="Places the device can navigate to">◆ {dests.length}</button>
            <button className={filter === 'spot' ? 'on' : ''} onClick={() => setFilter('spot')} data-tip="Recording-only spots">● {spots.length - dests.length}</button>
          </div>
        </div>
        <input className="wide" placeholder="Search by name, id or category" value={q} onChange={(e) => setQ(e.target.value)} />
        {unplaced > 0 && <p className="muted small" data-tip="From the old phone-collected data: they have names but no position on this map yet">{unplaced} spots have no position yet (select one and set x, y).</p>}
        <div className="places">
          {shown.map((s) => (
            <button key={s.id} className="place" onClick={() => s.x != null && onPick(s)} disabled={s.x == null}
              data-tip={s.x == null ? 'No position yet' : 'Select and show on the map'}>
              <span style={{ color: s.dest ? DEST_COLOR : SPOT_COLOR }}>{s.dest ? '◆' : '●'}</span>
              <span className="grow">{label(s)}{s.name && <span className="muted"> {s.id}</span>}</span>
              <span className="muted small">{s.dest?.category ?? ''}</span>
              <span className={`small ${takes[s.id] ? '' : 'warn'}`} data-tip="Takes recorded">{takes[s.id] ?? 0}</span>
            </button>
          ))}
          {!shown.length && <p className="muted small">{spots.length ? 'Nothing matches.' : 'No places yet: press D to add a destination or S for a spot.'}</p>}
        </div>
      </section>

      <Connections site={site} floor={floor} setTool={setTool} onPick={onPick} />
      <RouteCheck site={site} route={route} setRoute={setRoute} />

      <details className="card" id="align" open={!site.aligned}>
        <summary><h3 className="inline">Building position</h3> {site.aligned && <span className="muted small">lined up ✓</span>}</summary>
        <p className="muted small">Make the yellow outline sit on the building in the satellite view, so distances and directions are real.</p>
        <button className="wide" onClick={() => setTool('place')} data-tip="Then click the building's centre on the map">Move building to a point…</button>
        <div className="nudge">
          <span />
          <button onClick={() => edit((s) => nudge(s, 0, 0.5), 'nudge')} data-tip="0.5 m north">↑</button><span />
          <button onClick={() => edit((s) => nudge(s, -0.5, 0), 'nudge')} data-tip="0.5 m west">←</button>
          <span className="muted small">0.5 m</span>
          <button onClick={() => edit((s) => nudge(s, 0.5, 0), 'nudge')} data-tip="0.5 m east">→</button><span />
          <button onClick={() => edit((s) => nudge(s, 0, -0.5), 'nudge')} data-tip="0.5 m south">↓</button><span />
        </div>
        <label className="block" data-tip="Turn the whole plan around its origin">Rotation
          <div className="row">
            <input type="range" min={-180} max={180} step={0.5} value={site.anchor.rotation} className="grow" onChange={(e) => edit((s) => { s.anchor.rotation = +e.target.value }, 'rotate')} />
            <input type="number" step={0.5} value={site.anchor.rotation} onChange={(e) => edit((s) => { s.anchor.rotation = +e.target.value }, 'rotate')} />°
          </div>
        </label>
        <button className={site.aligned ? '' : 'primary'} onClick={() => edit((s) => { s.aligned = !s.aligned })}>
          {site.aligned ? 'Mark as not lined up' : 'Looks right'}</button>
      </details>
    </>
  )
}

/** How well the spots are linked: unlinked spots and separate groups mean some routes can't be found. */
function Connections({ site, floor, setTool, onPick }: { site: Site; floor: Floor; setTool: (t: Tool) => void; onPick: (s: Spot) => void }) {
  const byId = new Map(site.spots.map((s) => [s.id, s]))
  const here = site.edges.filter((e) => byId.get(e.a)?.floor === floor.id && byId.get(e.b)?.floor === floor.id)
  const across = site.edges.filter((e) => byId.get(e.a)?.floor !== byId.get(e.b)?.floor)
  const linked = new Set(site.edges.flatMap((e) => [e.a, e.b]))
  const lonely = site.spots.filter((s) => s.floor === floor.id && s.x != null && !linked.has(s.id))
  const gs = useMemo(() => groups(site).filter((g) => g.length > 1), [site])
  const total = here.reduce((a, e) => a + edgeLength(site, e), 0)
  return (
    <section className="card">
      <div className="row between">
        <h3>Links</h3>
        <button onClick={() => setTool('link')} data-tip="Click spots one after another to link them">⟋ Connect (C)</button>
      </div>
      <p className="muted small">
        {here.length ? `${here.length} on this floor · ${total.toFixed(0)} m of corridor` : 'None on this floor yet.'}
        {across.length > 0 && ` · ${across.length} between floors`}
      </p>
      {lonely.length > 0 && (
        <p className="small"><span className="warn">{lonely.length} spot{lonely.length > 1 ? 's' : ''} not linked</span>{' '}
          <button className="plain" onClick={() => onPick(lonely[0])}>show {label(lonely[0])}</button></p>
      )}
      {gs.length > 1 && (
        <p className="small" data-tip="Spots in different groups can't reach each other: link the groups together">
          <span className="warn">{gs.length} separate groups</span> of {gs.map((g) => g.length).join(', ')} spots{' '}
          <button className="plain" onClick={() => { const s = byId.get(gs[1].find((id) => byId.get(id)?.floor === floor.id) ?? gs[1][0]); if (s) onPick(s) }}>show the 2nd</button>
        </p>
      )}
    </section>
  )
}

/** Pick two places and see the route the device would take. */
function RouteCheck({ site, route, setRoute }: { site: Site; route: string[] | null; setRoute: (r: string[] | null) => void }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const placed = site.spots.filter((s) => s.x != null)
    .sort((a, b) => (+!!b.dest - +!!a.dest) || label(a).localeCompare(label(b), undefined, { numeric: true }))
  const floorName = (id: string) => site.floors.find((f) => f.id === id)?.name ?? id
  const res = useMemo(() => {
    if (!from || !to) return null
    const F = shortest(site, from), p = pathTo(F, to)
    return p ? { path: p, len: F.len.get(to)! } : 'none'
  }, [site, from, to])
  const path = res && res !== 'none' ? res.path : null
  useEffect(() => { setRoute(path) }, [path?.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setRoute(null), [setRoute])
  // Floor changes along the way, e.g. "stairs to First floor at S12"
  const changes = path ? path.slice(1).flatMap((id, i) => {
    const a = site.spots.find((s) => s.id === path[i])!, b = site.spots.find((s) => s.id === id)!
    const e = site.edges.find((x) => sameEdge(x, a.id, b.id))
    return a.floor !== b.floor ? [`${e?.via ?? 'link'} to ${floorName(b.floor)} at ${label(a)}`] : []
  }) : []
  const opt = (s: Spot) => <option key={s.id} value={s.id}>{s.dest ? '◆ ' : ''}{label(s)}{site.floors.length > 1 ? ` (${floorName(s.floor)})` : ''}</option>
  return (
    <details className="card" open={!!route}>
      <summary><h3 className="inline">Try a route</h3>{res && res !== 'none' && <span className="muted small">{res.len.toFixed(0)} m</span>}</summary>
      <div className="routepick">
        <select value={from} onChange={(e) => setFrom(e.target.value)}><option value="">From…</option>{placed.map(opt)}</select>
        <button className="icon" onClick={() => { setFrom(to); setTo(from) }} data-tip="Swap">⇅</button>
        <select value={to} onChange={(e) => setTo(e.target.value)}><option value="">To…</option>{placed.map(opt)}</select>
      </div>
      {res === 'none' && <p className="small warn">No route: these two aren't linked together yet.</p>}
      {path && (
        <p className="small">
          <b style={{ color: ROUTE_COLOR }}>{res !== 'none' && res!.len.toFixed(1)} m</b> through {path.length - 2} spot{path.length === 3 ? '' : 's'}
          {changes.map((c) => <span key={c}><br />↕ {c}</span>)}
        </p>
      )}
    </details>
  )
}

function nudge(s: Site, dx: number, dy: number) {
  s.anchor.lat += dy / 111320
  s.anchor.lon += dx / (111320 * Math.cos((s.anchor.lat * Math.PI) / 180))
}
