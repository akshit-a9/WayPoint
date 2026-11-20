import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { pathTo, shortest } from '../graph'
import type { Site, Spot, TelemetryDevice } from '../types'

// Send the device somewhere and watch it guide you: pick a destination, the
// device routes along the spot links and shows a compass arrow. Without
// sensors (a bare board), pretend a position and heading to try it out.

const label = (s: Spot) => s.name || s.id

/** The route the device is following, worked out the same way it does. */
export function deviceRoute(site: Site, dev: TelemetryDevice | undefined): string[] | null {
  const nav = dev?.nav
  if (!nav?.dest || !nav.at) return null
  return pathTo(shortest(site, nav.at), nav.dest)
}

export default function NavPanel({ site, dev }: { site: Site; dev: TelemetryDevice }) {
  const nav = dev.nav
  const dests = site.spots.filter((s) => s.dest && s.x != null)
  // No destinations marked yet: any placed spot will do, so navigation can be tried
  const choices = (dests.length ? dests : site.spots.filter((s) => s.x != null))
    .sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true }))
  const [to, setTo] = useState('')
  const [msg, setMsg] = useState('')
  const send = (cmd: string, arg = '') => api.command(dev.id, cmd, arg).then(() => setMsg(`${cmd} ${arg} sent`), (e) => setMsg(String(e)))
  const byId = new Map(site.spots.map((s) => [s.id, s]))
  const name = (id: string) => (byId.get(id) ? label(byId.get(id)!) : id)
  const reach = useMemo(() => (nav?.at ? shortest(site, nav.at) : null), [site, nav?.at])
  const old = !nav   // firmware without navigation

  return (
    <section className="card navcard">
      <h3>Navigate</h3>
      {old ? <p className="muted small">This device's firmware has no navigation yet.</p> : <>
        {!dests.length && <p className="muted small">No destinations marked on this site yet, so every spot is listed. Mark rooms as destinations in the Map tab.</p>}
        {!site.edges.length && <p className="small warn">No links between spots yet: the device can't route. Add them in the Map tab (Connect, C).</p>}
        <div className="row">
          <select className="grow" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Destination…</option>
            {choices.map((s) => {
              const d = reach?.len.get(s.id)
              return <option key={s.id} value={s.id}>{label(s)}{d != null ? ` · ${d.toFixed(0)} m` : ''}</option>
            })}
          </select>
          <button className="primary" disabled={!to} onClick={() => send('nav', to)} data-tip="The device starts guiding to it">Go</button>
          {nav.dest && <button onClick={() => send('nav', 'stop')}>Stop</button>}
        </div>
        {nav.dest ? (
          <div className="navstate">
            <div className="big">{nav.arrived ? 'Arrived' : !nav.at ? 'Locating…' : !nav.next ? 'No route' : nav.cue || `${nav.dist.toFixed(0)} m`}</div>
            <p className="small">
              to <b>{name(nav.dest)}</b>{nav.at && <> · at {name(nav.at)}</>}{nav.next && !nav.arrived && <> · next {name(nav.next)}</>}
              <br />bearing {nav.brg.toFixed(0)}° · heading {nav.hdg == null ? 'no compass' : `${nav.hdg.toFixed(0)}°`}
            </p>
          </div>
        ) : <p className="muted small">Not navigating. {nav.v ? `Has the map (${nav.n} spots).` : 'Waiting for the map from the server…'}</p>}
        <TestTools site={site} dev={dev} send={send} />
        {msg && <p className="muted small">{msg}</p>}
      </>}
      <DeviceScreen dev={dev} />
    </section>
  )
}

/** Pretend a position and heading, for a board without sensors or away from the building. */
function TestTools({ site, dev, send }: { site: Site; dev: TelemetryDevice; send: (c: string, a?: string) => void }) {
  const nav = dev.nav!
  const [hdg, setHdg] = useState(nav.fakeHdg ?? 0)
  const spots = site.spots.filter((s) => s.x != null).sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true }))
  const timer = useRef<number | undefined>(undefined)
  const sendHdg = (v: number) => { setHdg(v); clearTimeout(timer.current); timer.current = window.setTimeout(() => send('hdg', String(v)), 250) }
  return (
    <details className="across" open={!!(nav.fakeAt || nav.fakeHdg != null || nav.knobOff)}>
      <summary className="muted small">Test without sensors…{(nav.fakeAt || nav.fakeHdg != null) && ' (pretending)'}</summary>
      <label className="small" data-tip="With no encoder wired its pins float and the menus scroll by themselves">
        <input type="checkbox" checked={!!nav.knobOff} onChange={(e) => send('knob', e.target.checked ? 'off' : 'on')} /> No knob wired: ignore it
      </label>
      <div className="row small">
        <span className="muted">Knob:</span>
        <button onClick={() => send('knob', '-1')} data-tip="Turn one step back">◀</button>
        <button onClick={() => send('knob', '1')} data-tip="Turn one step on">▶</button>
        <button onClick={() => send('knob', 'click')}>Click</button>
        <button onClick={() => send('knob', 'hold')}>Hold</button>
      </div>
      <label className="block small">Pretend it is at
        <div className="row">
          <select className="grow" value={nav.fakeAt} onChange={(e) => send('at', e.target.value || 'off')}>
            <option value="">— use WiFi position —</option>
            {spots.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}
          </select>
        </div>
      </label>
      <label className="block small">Pretend it faces {nav.fakeHdg == null ? '(compass)' : `${hdg}°`}
        <div className="row">
          <input type="range" className="grow" min={0} max={359} step={1} value={hdg} onChange={(e) => sendHdg(+e.target.value)} />
          {nav.fakeHdg != null && <button onClick={() => send('hdg', 'off')}>Use compass</button>}
        </div>
      </label>
    </details>
  )
}

/**
 * The device's screen, as it draws it. TFT: 128x160 colour, sent as [count, RGB332]
 * runs. Old OLED: its odd rows are dead, so the firmware lays out 128x32 and each
 * row shows twice as tall: drawn the same here.
 */
function DeviceScreen({ dev }: { dev: TelemetryDevice }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  // Ask the device to send its screen with each batch while this is open
  useEffect(() => {
    const ask = () => { api.command(dev.id, 'screen', '30').catch(() => null) }
    ask()
    const t = setInterval(ask, 25000)
    return () => clearInterval(t)
  }, [dev.id])
  const scr = dev.screen
  const tft = scr?.format === 'rle332'
  const w = tft ? scr.w : 128, h = tft ? scr.h : 64
  useEffect(() => {
    const c = canvas.current?.getContext('2d')
    if (!c || !scr?.data) return
    const b = Uint8Array.from(atob(scr.data), (ch) => ch.charCodeAt(0))
    const img = c.createImageData(w, h)
    if (tft) {
      let p = 0
      for (let i = 0; i + 1 < b.length; i += 2) {
        const v = b[i + 1], rgb = [((v >> 5) & 7) * 255 / 7, ((v >> 2) & 7) * 255 / 7, (v & 3) * 255 / 3, 255]
        for (let k = 0; k < b[i] && p < w * h; k++, p++) img.data.set(rgb, p * 4)
      }
    } else {
      for (let y = 0; y < 32; y++) for (let x = 0; x < 128; x++) {
        const on = (b[(y >> 3) * 128 + x] >> (y & 7)) & 1
        for (const r of [2 * y, 2 * y + 1]) img.data.set(on ? [150, 210, 255, 255] : [8, 10, 14, 255], (r * 128 + x) * 4)
      }
    }
    c.putImageData(img, 0, 0)
  }, [scr?.data, tft, w, h])
  return (
    <div className="screen">
      <canvas ref={canvas} width={w} height={h} style={{ width: w * 2, height: h * 2 }} />
      <span className="muted small">{dev.screen ? (dev.screen.age < 5 ? 'device screen, live' : `device screen, ${dev.screen.age.toFixed(0)} s old`) : 'waiting for the device screen…'}</span>
      {tft && (
        <div className="row small">
          <button onClick={() => api.command(dev.id, 'theme', 'dark')} data-tip="Dark colours (saved on the device)">Dark</button>
          <button onClick={() => api.command(dev.id, 'theme', 'light')} data-tip="Light colours (saved on the device)">Light</button>
          <button onClick={() => api.command(dev.id, 'flip', 'on')} data-tip="Picture upside down (saved)">Flip</button>
          <button onClick={() => api.command(dev.id, 'flip', 'off')}>Unflip</button>
        </div>
      )}
      {tft && (
        <div className="row small" data-tip="WiFi current spikes can flicker the screen (not saved: a reboot restores the build's defaults)">
          <span className="muted">Radio</span>
          <button onClick={() => api.command(dev.id, 'radio', 'sleep on')}>Sleep on</button>
          <button onClick={() => api.command(dev.id, 'radio', 'sleep off')}>Sleep off</button>
          <select defaultValue="" onChange={(e) => e.target.value && api.command(dev.id, 'radio', `tx ${e.target.value}`)}>
            <option value="">TX power…</option>
            {[20, 17, 15, 13, 11, 8, 5, 2].map((d) => <option key={d} value={d}>{d} dBm</option>)}
          </select>
        </div>
      )}
    </div>
  )
}
