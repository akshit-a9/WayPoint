import { useEffect, useMemo, useRef, useState } from 'react'
import { api, useTelemetryDevices } from '../api'
import Orientation from '../components/Orientation'
import { useLiveSensors } from '../live'
import type { TelemetryBatch, TelemetryDevice } from '../types'

const KEEP = 600   // ~10 min of batches

/** Debug view of a device's telemetry: everything it would have printed on serial, and more. */
export default function Debug() {
  const { data: devices } = useTelemetryDevices(2000)
  const [sel, setSel] = useState<string | null>(null)
  const dev = devices?.find((d) => d.id === sel) ?? devices?.find((d) => (d.age ?? 99) < 10) ?? devices?.[0]
  const batches = useBatches(dev?.id)

  return (
    <div className="debug">
      <aside className="side">
        <section className="card">
          <h3>Devices</h3>
          {!devices?.length && <p className="muted">No telemetry yet. Is the device powered and on the hotspot?</p>}
          {devices?.map((d) => (
            <button key={d.id} className={`item wide ${d.id === dev?.id ? 'on' : ''}`} onClick={() => setSel(d.id)}>
              <b className="mono">{d.id}</b> <span className="muted">{d.fw} · {online(d) ? `${d.age} s ago` : 'offline'}</span>
            </button>
          ))}
        </section>
        {dev && <Health dev={dev} />}
        {dev && <Commands id={dev.id} />}
      </aside>
      <div className="debugmain">
        {dev ? <><Orientation device={dev.id} batches={batches} /><Panels device={dev.id} batches={batches} /></> : <p className="pad muted">Waiting for a device.</p>}
      </div>
    </div>
  )
}

const online = (d: TelemetryDevice) => d.age != null && d.age < 10

/** Polls /api/telemetry/{id}?since=n and keeps the last KEEP batches. */
function useBatches(id: string | undefined) {
  const [batches, setBatches] = useState<TelemetryBatch[]>([])
  const since = useRef(0)
  useEffect(() => {
    setBatches([])
    since.current = 0
    if (!id) return
    let stop = false
    const tick = async () => {
      try {
        const fresh = await api.telemetry(id, since.current)
        if (fresh.length && !stop) {
          since.current = fresh[fresh.length - 1].n
          setBatches((b) => [...b, ...fresh].slice(-KEEP))
        }
      } catch { /* server restarting; try again */ }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => { stop = true; clearInterval(t) }
  }, [id])
  return batches
}

function Health({ dev }: { dev: TelemetryDevice }) {
  const h = dev.health
  if (!h) return null
  const rows: [string, string | number, boolean?][] = [
    ['Uptime', fmtTime(h.uptime)],
    ['Last reset', h.reset, h.reset !== 'power-on' && h.reset !== 'software'],
    ['WiFi', `${h.rssi} dBm, ch ${h.ch}`, h.rssi < -80],
    ['Free heap', `${(h.heap / 1024).toFixed(0)} k (min ${(h.minHeap / 1024).toFixed(0)} k)`, h.minHeap < 40000],
    ['Frame rate', `${h.fps.toFixed(0)} fps`, h.fps < 15],
    ['Scans', `${h.scans} (last ${h.scanMs} ms)`],
    ['Magnetometer', h.mag ? 'ok' : 'missing', !h.mag],
    ['MPU-6050', h.mpu ? 'ok' : 'missing', !h.mpu],
    ['OLED', h.oled ? 'ok' : 'no ack', !h.oled],
    ['I2C errors', h.i2cErr, h.i2cErr > 0],
    ['Telemetry', `${['off', 'basic', 'full'][h.level]}, ${h.sent} sent, ${h.failed} failed`],
    ['Screen', `${dev.ui?.screen ?? '?'} (row ${dev.ui?.sel ?? 0})`],
  ]
  return (
    <section className="card">
      <h3>Health</h3>
      <table><tbody>{rows.map(([k, v, bad]) => <tr key={k}><td className="muted">{k}</td><td className={bad ? 'err' : ''}>{v}</td></tr>)}</tbody></table>
      {dev.session && <p className="muted small">Logging to data/sessions/{dev.session}</p>}
    </section>
  )
}

function Commands({ id }: { id: string }) {
  const [msg, setMsg] = useState('')
  const [sent, setSent] = useState('')
  const send = (cmd: string, arg = '') => api.command(id, cmd, arg).then(() => setSent(`${cmd} queued`), (e) => setSent(String(e)))
  return (
    <section className="card">
      <h3>Commands</h3>
      <p className="muted small">Delivered with the device's next batch (dev builds only).</p>
      <div className="row wrap">
        <button onClick={() => send('i2cscan')}>Rescan I2C</button>
        {[0, 1, 2].map((l) => <button key={l} onClick={() => send('level', String(l))}>Level {['off', 'basic', 'full'][l]}</button>)}
        <button className="danger" onClick={() => send('reboot')}>Reboot</button>
      </div>
      <div className="row">
        <input placeholder="Message for the screen" maxLength={21} value={msg} onChange={(e) => setMsg(e.target.value)} />
        <button disabled={!msg} onClick={() => send('toast', msg)}>Show</button>
      </div>
      {sent && <p className="muted small">{sent}</p>}
    </section>
  )
}

function Panels({ device, batches }: { device: string; batches: TelemetryBatch[] }) {
  const t0 = batches.at(-1)?.rx ?? 0
  const series = (pick: (b: TelemetryBatch) => number | undefined) =>
    batches.flatMap((b) => { const v = pick(b); return v == null ? [] : [[b.rx - t0, v] as [number, number]] })
  return (
    <>
      <div className="charts">
        <Chart title="WiFi signal (dBm)" lines={[{ pts: series((b) => b.health?.rssi), color: '#4361ee' }]} />
        <Chart title="/predict latency (ms)" lines={[{ pts: series((b) => b.pred?.ms), color: '#f77f00' }]} />
        <Chart title="Frame rate (fps)" lines={[{ pts: series((b) => b.health?.fps), color: '#2a9d8f' }]} />
        <Chart title="Free heap (kB)" lines={[{ pts: series((b) => b.health && b.health.heap / 1024), color: '#9b5de5' }]} />
        <SensorCharts device={device} batches={batches} />
      </div>
      <Tables batches={batches} />
    </>
  )
}

/** Raw sensor charts: the live stream (last 30 s, 25 Hz) while it flows, else the telemetry samples. Re-renders on its own. */
function SensorCharts({ device, batches }: { device: string; batches: TelemetryBatch[] }) {
  const live = useLiveSensors(device)
  const slow = useMemo(() => batches.flatMap((b) => b.sensors ?? []), [batches])
  const mag = live.live ? live.samples : slow
  const t1 = mag.at(-1)?.[0] ?? 0
  const recent = live.live ? mag.filter((s) => s[0] > t1 - 30000) : mag
  const magSeries = (k: number) => recent.map((s) => [(s[0] - t1) / 1000, s[k]] as [number, number])
  const rate = live.live ? 'live, 25 Hz' : '10 Hz'
  return (
    <>
      <Chart title={`Magnetometer raw, ${rate}`} wide lines={[
        { pts: magSeries(1), color: AXIS_COLORS[0], name: 'X' }, { pts: magSeries(2), color: AXIS_COLORS[1], name: 'Y' },
        { pts: magSeries(3), color: AXIS_COLORS[2], name: 'Z (up)' }]} />
      <Chart title={`Accelerometer raw (16384 = 1 g), ${rate}`} wide lines={[
        { pts: magSeries(4), color: AXIS_COLORS[0], name: 'X (up)' }, { pts: magSeries(5), color: AXIS_COLORS[1], name: 'Y (along)' },
        { pts: magSeries(6), color: AXIS_COLORS[2], name: 'Z (ahead)' }]} />
    </>
  )
}

function Tables({ batches }: { batches: TelemetryBatch[] }) {
  const t0 = batches.at(-1)?.rx ?? 0
  const lastScan = [...batches].reverse().find((b) => b.scan)?.scan
  const log = batches.flatMap((b) => (b.log ?? []).map(([t, text]) => ({ t, text, kind: 'log' })))
    .concat(batches.flatMap((b) => (b.events ?? []).map(([t, type, value, text]) => ({ t, text: `${type} ${value}${text ? ' ' + text : ''}`, kind: 'event' }))))
    .sort((a, b) => b.t - a.t).slice(0, 200)
  const preds = batches.filter((b) => b.pred).slice(-12).reverse()

  return (
    <>
      <div className="row top gap">
        <section className="card grow">
          <h3>Predictions</h3>
          <table>
            <thead><tr><th>Ago</th><th>Location</th><th>Conf</th><th>Known</th><th>ms</th></tr></thead>
            <tbody>{preds.map((b) => (
              <tr key={b.n}><td>{(t0 - b.rx).toFixed(0)} s</td>
                <td className={b.pred!.ok ? '' : 'err'}>{b.pred!.ok ? b.pred!.location : b.pred!.error}</td>
                <td>{(b.pred!.conf * 100).toFixed(0)}%</td><td>{b.pred!.known}/{b.pred!.total}</td><td>{b.pred!.ms}</td></tr>
            ))}</tbody>
          </table>
        </section>
        <section className="card grow">
          <h3>Last scan {lastScan && `(${lastScan.aps.length} APs, ${lastScan.ms} ms)`}</h3>
          <div className="scroll">
            <table>
              <tbody>{lastScan?.aps.map(([bssid, rssi, ch, ssid]) => (
                <tr key={bssid}><td>{ssid || <i className="muted">hidden</i>}</td><td className="mono muted">{bssid}</td><td>ch {ch}</td>
                  <td><div className="rssi" style={{ width: `${Math.max(4, (rssi + 100) * 1.6)}px` }} />{rssi}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      </div>
      <section className="card">
        <h3>Log and events (newest first)</h3>
        <div className="scroll log mono">
          {log.map((l, i) => <div key={i} className={l.kind}><span className="muted">{(l.t / 1000).toFixed(1)}</span> {l.text}</div>)}
        </div>
      </section>
    </>
  )
}

// The usual axis colours: X red, Y green, Z blue
const AXIS_COLORS = ['#ef4444', '#22c55e', '#3b82f6']

type Line = { pts: [number, number][]; color: string; name?: string }

/** Minimal SVG line chart: x = seconds before now, y auto-scaled. */
function Chart({ title, lines, wide }: { title: string; lines: Line[]; wide?: boolean }) {
  const W = wide ? 640 : 300, H = 110, P = 4
  const all = lines.flatMap((l) => l.pts)
  const last = lines.map((l) => l.pts.at(-1)?.[1])
  if (!all.length) return <section className={`card chart ${wide ? 'wide' : ''}`}><h4>{title}</h4><p className="muted small">no data</p></section>
  const xmin = Math.min(...all.map((p) => p[0])), xmax = Math.max(0, ...all.map((p) => p[0]))
  let ymin = Math.min(...all.map((p) => p[1])), ymax = Math.max(...all.map((p) => p[1]))
  if (ymax - ymin < 1e-6) { ymin -= 1; ymax += 1 }
  const x = (v: number) => P + ((v - xmin) / (xmax - xmin || 1)) * (W - 2 * P)
  const y = (v: number) => H - P - ((v - ymin) / (ymax - ymin)) * (H - 2 * P)
  return (
    <section className={`card chart ${wide ? 'wide' : ''}`}>
      <h4>{title} {lines.length === 1 && last[0] != null && <span className="muted">{+last[0].toFixed(1)}</span>}</h4>
      {lines.length > 1 && (
        <div className="chartlegend">
          {lines.map((l, i) => <span key={i}><i style={{ background: l.color }} />{l.name} <b className="mono">{last[i] == null ? '–' : Math.round(last[i]!)}</b></span>)}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {lines.map((l, i) => <polyline key={i} fill="none" stroke={l.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke"
          points={l.pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')} />)}
      </svg>
      <div className="axis muted small"><span>{ymax.toFixed(0)} / {ymin.toFixed(0)}</span><span>{Math.round(-xmin)} s</span></div>
    </section>
  )
}

const fmtTime = (s: number) => (s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`)
