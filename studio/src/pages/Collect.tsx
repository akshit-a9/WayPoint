import { useEffect, useRef, useState } from 'react'
import { api, useAction, useLive, useRecordings, useTelemetryDevices } from '../api'
import SiteMap from '../components/SiteMap'
import { ConfirmButton, typing } from '../components/ui'
import { dist } from '../geo'
import { useStudio } from '../store'
import type { Spot, XY } from '../types'

// Turn 45° right at each eighth of the take: 8 headings, so the model learns
// the spot whichever way you face. The device shows the same cues.
const TARGET = 2   // takes per spot to call it covered
const DURATIONS = [60, 90, 120]

function beep(n = 1) {
  try {
    const ctx = new AudioContext()
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator()
      o.connect(ctx.destination); o.frequency.value = n > 1 ? 1320 : 880
      o.start(ctx.currentTime + i * 0.25); o.stop(ctx.currentTime + i * 0.25 + 0.15)
    }
  } catch { /* audio blocked: the on-screen cue still shows */ }
}

const color = (n: number) => (n >= TARGET ? '#06d6a0' : n === 1 ? '#ffd166' : '#ef476f')
const label = (s?: Spot) => (s ? s.name || s.id : '')

export default function Collect() {
  const { siteId, floorId, draft: site, recordSpot: spotId, setRecordSpot } = useStudio()
  const { data: live } = useLive(500)
  const { data: tele } = useTelemetryDevices(2000)
  const { data: rec } = useRecordings(siteId)
  const [device, setDevice] = useState<string | null>(null)
  const [seconds, setSeconds] = useState(() => { try { return +(localStorage.getItem('takeSeconds') ?? 90) || 90 } catch { return 90 } })
  const [focus, setFocus] = useState<XY | null>(null)
  const refresh = [['live'], ['recordings', siteId ?? ''], ['sites']]
  const start = useAction(api.startTake, refresh)
  const cancel = useAction(api.cancelTake, refresh)
  const del = useAction((t: string) => api.deleteTake(siteId!, t), refresh)

  // Devices that sent a scan recently (takes record the scans the device sends to /predict)
  const online = (live?.devices ?? []).filter((d) => d.age < 15)
  const dev = online.find((d) => d.id === device) ?? online[0]
  const newFw = tele?.some((t) => t.id === dev?.id)

  const take = live?.take && live.take.site === siteId ? live.take : null
  const running = !!take && !take.done
  const turnEvery = (take?.seconds ?? seconds) / 8
  const turnNo = take ? Math.floor(take.elapsed / turnEvery) : 0
  const turning = running && turnNo >= 1 && turnNo <= 7 && take.elapsed - turnNo * turnEvery < 2.5

  // Beeps: each turn, and a double beep when the take is saved
  const lastTurn = useRef(0)
  const wasRunning = useRef(false)
  useEffect(() => {
    if (running && turnNo > lastTurn.current && turnNo <= 7) beep()
    lastTurn.current = running ? turnNo : 0
    if (wasRunning.current && take?.done) beep(2)
    wasRunning.current = running
  }, [running, turnNo, take?.done])

  const counts = rec?.perSpot ?? {}
  const spots = site?.spots.filter((s) => s.floor === floorId && s.x != null) ?? []
  const spot = site?.spots.find((s) => s.id === spotId)
  const covered = spots.filter((s) => (counts[s.id] ?? 0) >= TARGET).length
  // Next: the nearest spot that still needs takes
  const from = spot?.x != null ? [spot.x, spot.y!] as XY : null
  const next = spots.filter((s) => s.id !== spotId && (counts[s.id] ?? 0) < TARGET)
    .sort((a, b) => (counts[a.id] ?? 0) - (counts[b.id] ?? 0) || (from ? dist(from, [a.x!, a.y!]) - dist(from, [b.x!, b.y!]) : 0))[0]

  const pick = (id: string) => { if (!running) setRecordSpot(id) }
  const goNext = () => { if (next) { setRecordSpot(next.id); setFocus([next.x!, next.y!]) } }
  const begin = () => { if (spot && dev && !running) start.mutate({ site: site!.id, spot: spot.id, device: dev.id, seconds }) }

  const keys = useRef({ begin, goNext, running, cancel: () => cancel.mutate(undefined) })
  keys.current = { begin, goNext, running, cancel: () => cancel.mutate(undefined) }
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey) return
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); keys.current.begin() }
      else if (e.key === 'Escape' && keys.current.running) keys.current.cancel()
      else if (e.key.toLowerCase() === 'n' && !keys.current.running) keys.current.goNext()
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [])

  if (!site) return null
  const spotTakes = rec?.takes.filter((t) => t.spot === spotId).reverse() ?? []

  return (
    <div className="split">
      <div className="mapwrap">
        <SiteMap site={site} floorId={floorId} onSpotClick={pick} selectedSpot={spotId} focus={focus}
          spotColor={(s) => color(counts[s.id] ?? 0)} spotTip={(s) => `${counts[s.id] ?? 0} takes — click to select`} />
        <div className="legend">
          <span><i style={{ background: color(0) }} />none</span><span><i style={{ background: color(1) }} />1 take</span>
          <span><i style={{ background: color(2) }} />{TARGET}+ takes</span>
        </div>
      </div>

      <aside className="side">
        <section className="card">
          <div className="row between">
            <h3>Coverage</h3>
            <span className="small" data-tip={`Spots with ${TARGET} or more takes`}>{covered} / {spots.length} spots</span>
          </div>
          <progress max={spots.length || 1} value={covered} />
          <div className="row between">
            {online.length > 1
              ? <select value={dev?.id} onChange={(e) => setDevice(e.target.value)} data-tip="Device that records">{online.map((d) => <option key={d.id}>{d.id}</option>)}</select>
              : <span className={dev ? 'small' : 'small err'} data-tip={dev ? 'Takes record the scans this device sends' : 'Power the device on and wait for it to join the hotspot'}>
                  {dev ? `● ${dev.id}` : '○ No device sending scans'}</span>}
            <select value={seconds} disabled={running} onChange={(e) => { setSeconds(+e.target.value); try { localStorage.setItem('takeSeconds', e.target.value) } catch { /* */ } }}
              data-tip="Length of one take. 90 s gives ~33 scans with the current firmware">
              {DURATIONS.map((d) => <option key={d} value={d}>{d} s takes</option>)}
            </select>
          </div>
        </section>

        {running && take ? (
          <section className={`card recording ${turning ? 'turning' : ''}`}>
            <h3>Recording · {label(site.spots.find((s) => s.id === take.spot))}</h3>
            <div className="countdown">{Math.max(0, Math.ceil(take.seconds - take.elapsed))}<small> s</small></div>
            <progress max={take.seconds} value={take.elapsed} />
            <p className="cue">{turning ? '↻ TURN 45° RIGHT' : `Hold still, facing heading ${Math.min(8, turnNo + 1)} of 8`}</p>
            <p className="muted small">{take.scans} scans · {newFw ? 'the device screen shows the same cues' : 'old firmware: no cues on the device'}</p>
            <button className="wide" onClick={() => cancel.mutate(undefined)} data-tip="Discard this take (Esc)">Cancel take</button>
          </section>
        ) : spot ? (
          <section className="card">
            <div className="row between">
              <h3>{spot.dest ? '◆' : '●'} {label(spot)}</h3>
              <span className="small" style={{ color: color(counts[spot.id] ?? 0) }}>{counts[spot.id] ?? 0} / {TARGET} takes</span>
            </div>
            {take?.done && take.spot === spot.id && <p className="ok">Saved {take.scans} scans ✓</p>}
            <p className="muted small">Stand at the spot holding the device the way you'll use it. Turn 45° right at each cue (8 headings).</p>
            <button className="primary wide big-btn" disabled={!dev || start.isPending} onClick={begin}
              data-tip={dev ? 'Start recording (Enter)' : 'No device online'}>Record {seconds} s here</button>
            {start.error && <p className="err">{start.error.message}</p>}
            {next && <button className="wide" onClick={goNext} data-tip="Nearest spot that still needs takes (N)">Next: {label(next)} →</button>}
            {spotTakes.length > 0 && (
              <div className="takes">
                {spotTakes.map((t) => (
                  <div key={t.take} className="item">
                    <span className="grow">{fmtTake(t.take)}</span>
                    <span className="muted small" data-tip="Scans and distinct access points in this take">{t.scans} scans · {t.aps} APs</span>
                    <ConfirmButton className="icon" confirm="Delete?" tip="Delete this take" onConfirm={() => del.mutate(t.take)}>🗑</ConfirmButton>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className="card">
            <h3>Pick a spot</h3>
            <p className="muted">Click a spot on the map. Red ones have no recordings yet.</p>
            {next && <button className="primary wide" onClick={goNext}>Start with {label(next)} →</button>}
          </section>
        )}
      </aside>
    </div>
  )
}

/** "20261101-130512_S4" -> "1 Nov, 13:05" */
function fmtTake(id: string) {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/)
  if (!m) return id
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
