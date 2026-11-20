import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { useLiveSensors, type Sample } from '../live'
import type { Orientation as Cfg, TelemetryBatch } from '../types'

// Which way the device faces, from its raw magnetometer and accelerometer
// samples: the live stream (25 Hz, ~0.1 s behind) while it flows, otherwise
// the 10 Hz samples that arrive once a second with each telemetry batch.
//
// Compass: spin the device a full circle or two while holding it the way you
// will carry it. The min/max of each magnetometer axis gives the hard-iron
// offset (centre) and soft-iron scale (make the circle round); the axis that
// barely changes is the one pointing up. Heading = angle in the other two.
// The software can't know which side of the board is the "front", so you tell
// it: turn the model by 90° steps, or face a known direction and press it.

// Defaults match the current build: breadboard flat, both sensor boards
// standing upright along it, "ahead" = across the breadboard away from you.
// The MPU stands upright and reads +1 g on X (X up), so Z points ahead/back
// and Y runs along the board. The GY-271 lies flat like the OLED: Z is up and
// heading comes from X/Y (its raw Z is ~20° of the field: Goa's dip angle).
const DEFAULTS: Cfg = {
  magOffset: [0, 0, 0], magScale: [1, 1, 1], magVertical: 2, mirror: false, headingOffset: 0, calibratedAt: null,
  accAhead: 2, accAheadSign: 1, accSideSign: 1,
}
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const AXES = ['X', 'Y', 'Z']

const wrap = (d: number) => ((d % 360) + 360) % 360
const w180 = (d: number) => { d = wrap(d); return d > 180 ? d - 360 : d }

/** Mean of the last few samples: steadies the needle at 25 Hz for ~50 ms of delay. */
function mean(samples: Sample[], n: number): Sample {
  const tail = samples.slice(-n)
  return tail[tail.length - 1].map((_, k) => (k ? tail.reduce((a, s) => a + s[k], 0) / tail.length : tail[tail.length - 1][0])) as Sample
}

/** An angle that keeps counting past 360 (359° → 361°), so CSS eases across north instead of spinning back. */
function useUnwrapped(deg: number) {
  const r = useRef(deg)
  r.current += w180(deg - r.current)
  return r.current
}
const cardinal = (d: number) => DIRS[Math.round(wrap(d) / 45) % 8]
const horiz = (v: number) => [0, 1, 2].filter((i) => i !== v)

/** Compass heading (deg clockwise from north) of the device's front, before the user's offset. */
function rawHeading(s: Sample, c: Cfg) {
  const m = [s[1], s[2], s[3]].map((v, i) => (v - c.magOffset[i]) * c.magScale[i])
  const [a, b] = horiz(c.magVertical)
  const h = (Math.atan2(m[b], m[a]) * 180) / Math.PI
  return c.mirror ? -h : h
}
const heading = (s: Sample, c: Cfg) => wrap(rawHeading(s, c) + c.headingOffset)

/** Tilt from gravity: the axis carrying most of 1 g is "up"; the front and side axes give pitch and roll. */
function tilt(s: Sample, c: Cfg) {
  const g = [s[4], s[5], s[6]]
  const up = g.map(Math.abs).indexOf(Math.max(...g.map(Math.abs)))
  const f = c.accAhead !== up ? c.accAhead : horiz(up)[0]
  const r = [0, 1, 2].find((i) => i !== up && i !== f)!
  const gu = g[up]
  return {
    up, sign: Math.sign(gu) || 1,
    pitch: (Math.atan2(g[f] * c.accAheadSign, Math.abs(gu)) * 180) / Math.PI,   // + = front edge up
    roll: (Math.atan2(g[r] * c.accSideSign, Math.abs(gu)) * 180) / Math.PI,     // + = right edge up
    total: (Math.acos(Math.min(1, Math.abs(gu) / Math.hypot(...g))) * 180) / Math.PI,
  }
}

function calibrate(samples: Sample[], prev: Cfg): Cfg {
  const lo = [0, 1, 2].map((i) => Math.min(...samples.map((s) => s[i + 1])))
  const hi = [0, 1, 2].map((i) => Math.max(...samples.map((s) => s[i + 1])))
  const r = hi.map((h, i) => (h - lo[i]) / 2)
  const vertical = r.indexOf(Math.min(...r))
  const [a, b] = horiz(vertical)
  const avg = (r[a] + r[b]) / 2
  const scale: [number, number, number] = [1, 1, 1]
  scale[a] = avg / (r[a] || 1)
  scale[b] = avg / (r[b] || 1)
  return {
    ...prev, magVertical: vertical, magScale: scale, calibratedAt: new Date().toISOString(),
    magOffset: [0, 1, 2].map((i) => Math.round((hi[i] + lo[i]) / 2)) as [number, number, number],
  }
}

export default function Orientation({ device, batches }: { device: string; batches: TelemetryBatch[] }) {
  const qc = useQueryClient()
  const { data: saved } = useQuery({ queryKey: ['orientation', device], queryFn: () => api.getOrientation(device) })
  const cfg: Cfg = { ...DEFAULTS, ...saved }
  const save = (c: Cfg) => { qc.setQueryData(['orientation', device], c); api.putOrientation(device, c) }
  const [cal, setCal] = useState<number | null>(null)   // device ms when calibration started

  const live = useLiveSensors(device)
  const slow = useMemo(() => batches.flatMap((b) => b.sensors ?? []), [batches])
  const samples = live.live ? live.samples : slow
  const last = samples.length ? mean(samples, live.live ? 3 : 1) : undefined
  // Both sources stamp samples with the device clock, so a switch mid-calibration is fine
  const calSamples = useMemo(() => cal == null ? [] : samples.filter((s) => s[0] > cal), [samples, cal])

  // Coverage of the circle while calibrating, in 30° sectors around the provisional centre
  const coverage = useMemo(() => {
    if (calSamples.length < 5) return 0
    const c = calibrate(calSamples, cfg)
    return new Set(calSamples.map((s) => Math.floor(wrap(rawHeading(s, { ...c, mirror: false, headingOffset: 0 })) / 30))).size / 12
  }, [calSamples]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setCal(null) }, [device])

  const h = last ? heading(last, cfg) : 0
  const t = last ? tilt(last, cfg) : { up: 0, sign: 1, pitch: 0, roll: 0, total: 0 }
  const shown = useUnwrapped(h)   // hooks before the early return
  if (!last) return <section className="card"><h3>Orientation</h3><p className="muted small">Waiting for sensor samples (telemetry level Full).</p></section>
  const [a, b] = horiz(cfg.magVertical)
  const ease = live.live ? 'transform 90ms linear' : undefined   // undefined: the slow default for 1 s steps

  return (
    <section className="card orient">
      <div className="row between">
        <h3>Orientation <span className={`badge ${live.live ? 'ok' : ''}`}
          data-tip={live.live ? 'Live: 25 samples a second, about 0.1 s behind. WiFi scans are paused while this tab is open.'
            : 'Live stream not flowing yet; showing the once-a-second telemetry (about 1 s behind)'}>{live.live ? '● live' : '○ 1 s'}</span></h3>
        <span className="muted small">
          {cfg.calibratedAt ? `compass calibrated ${new Date(cfg.calibratedAt).toLocaleDateString()}` : 'compass not calibrated'}</span>
      </div>
      <div className="orient-grid">
        <Model heading={shown} pitch={t.pitch} roll={t.roll} ease={ease} />
        <div className="orient-side">
          <Dial heading={shown} ease={ease} />
          <div className="big center">{cardinal(h)} {h.toFixed(0)}°</div>
          <p className="muted small center">{Number.isFinite(t.total)
            ? <>tilt {t.total.toFixed(0)}° · up = accel {t.sign > 0 ? '+' : '−'}{AXES[t.up]}</>
            : 'no accelerometer reading'}</p>
        </div>
      </div>

      {cal != null ? (
        <div className="calbox">
          <b>Calibrating: turn around slowly, two full circles</b>
          <p className="muted small">Hold the device the way you will carry it, level, away from laptops and metal.</p>
          <progress max={1} value={coverage} />
          <div className="row between">
            <span className="small">{calSamples.length} samples · {(coverage * 100).toFixed(0)}% of the circle</span>
            <div className="row">
              <button onClick={() => setCal(null)}>Cancel</button>
              <button className="primary" disabled={coverage < 0.75 || calSamples.length < 60}
                data-tip={coverage < 0.75 ? 'Keep turning until most of the circle is covered' : 'Use these samples'}
                onClick={() => { save(calibrate(calSamples, cfg)); setCal(null) }}>Done</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="row">
            <button className={cfg.calibratedAt ? '' : 'primary'} onClick={() => setCal(samples.at(-1)?.[0] ?? 0)}
              data-tip="Removes the board's own magnetic bias; do it once per mounting">Calibrate compass</button>
            <span className="muted small">uses magnetometer {AXES[a]}/{AXES[b]}, {AXES[cfg.magVertical]} points up</span>
          </div>
          <h4>Which way is the front?</h4>
          <p className="muted small">Point the device's front at a known direction (use the satellite map or a phone compass) and press it. Or turn the model in 90° steps until it matches.</p>
          <div className="row">
            {['N', 'E', 'S', 'W'].map((d, i) => (
              <button key={d} onClick={() => save({ ...cfg, headingOffset: wrap(i * 90 - rawHeading(last, cfg)) })}
                data-tip={`I'm pointing the front ${['north', 'east', 'south', 'west'][i]} now`}>Facing {d}</button>
            ))}
          </div>
          <div className="row">
            <button onClick={() => save({ ...cfg, headingOffset: wrap(cfg.headingOffset - 90) })} data-tip="Front is 90° to the left of what the model shows">⟲ 90°</button>
            <button onClick={() => save({ ...cfg, headingOffset: wrap(cfg.headingOffset + 180) })} data-tip="Front and back are swapped">180°</button>
            <button onClick={() => save({ ...cfg, headingOffset: wrap(cfg.headingOffset + 90) })} data-tip="Front is 90° to the right of what the model shows">⟳ 90°</button>
            <button className={cfg.mirror ? 'on' : ''} onClick={() => save({ ...cfg, mirror: !cfg.mirror, headingOffset: wrap(cfg.headingOffset + 2 * rawHeading(last, cfg)) })}
              data-tip="Turn right (clockwise): the heading should go up. If it goes down, press this.">Mirror</button>
            <label className="grow" data-tip="Fine adjustment">
              <input type="range" min={0} max={359} value={Math.round(cfg.headingOffset)} onChange={(e) => save({ ...cfg, headingOffset: +e.target.value })} />
            </label>
            <span className="small mono">{cfg.headingOffset.toFixed(0)}°</span>
          </div>
          <h4>Tilt</h4>
          <p className="muted small">Lift the front edge: the model's front should rise. Lift the right end: its right end should rise.</p>
          <div className="row">
            <button onClick={() => save({ ...cfg, accAheadSign: -cfg.accAheadSign })} data-tip="Front and back tilt the wrong way">Flip front/back tilt</button>
            <button onClick={() => save({ ...cfg, accSideSign: -cfg.accSideSign })} data-tip="Left and right tilt the wrong way">Flip left/right tilt</button>
            <span className="muted small">front = accel {cfg.accAheadSign > 0 ? '+' : '−'}{AXES[cfg.accAhead]}</span>
          </div>
        </>
      )}
    </section>
  )
}

/**
 * The breadboard on a compass rose, in CSS 3D, laid out like the real build
 * (left to right: power module, MPU-6050 upright, GY-271 flat, ESP32, encoder, OLED).
 * The long edge away from you is the front. Turns with the heading, leans with the tilt.
 */
function Model({ heading, pitch, roll, ease }: { heading: number; pitch: number; roll: number; ease?: string }) {
  return (
    <div className="scene" data-tip="The device as the sensors see it. The arrow is the front (ahead).">
      <div className="ground">
        {DIRS.map((d, i) => <span key={d} className={`rose ${i % 2 ? 'minor' : ''}`} style={{ transform: `rotate(${i * 45}deg) translateY(-126px) rotate(${-i * 45}deg)` }}>{d}</span>)}
        <div className="ring" />
        <div className="board" style={{ transform: `rotateZ(${heading}deg) rotateX(${-pitch}deg) rotateY(${-roll}deg)`, transition: ease }}>
          <div className="face top">
            <div className="rail" /><div className="rail bottom" />
            <div className="pm"><i /></div>
            <div className="upright mpu" /><div className="mag" />
            <div className="esp"><i /></div>
            <div className="knob" />
            <div className="oled" />
          </div>
          <div className="front-arrow">▲ AHEAD</div>
          <div className="face side s1" /><div className="face side s2" /><div className="face side s3" /><div className="face side s4" />
        </div>
      </div>
    </div>
  )
}

function Dial({ heading, ease }: { heading: number; ease?: string }) {
  return (
    <svg viewBox="-60 -60 120 120" className="dial" aria-label={`Heading ${wrap(heading).toFixed(0)} degrees`}>
      <circle r="56" className="dial-ring" />
      {Array.from({ length: 36 }, (_, i) => (
        <line key={i} x1="0" y1={i % 9 === 0 ? -56 : -56} x2="0" y2={i % 9 === 0 ? -46 : -51} transform={`rotate(${i * 10})`} className="dial-tick" />
      ))}
      {['N', 'E', 'S', 'W'].map((d, i) => <text key={d} transform={`rotate(${i * 90}) translate(0 -36) rotate(${-i * 90})`} className={`dial-txt ${d === 'N' ? 'n' : ''}`}>{d}</text>)}
      <g style={{ transform: `rotate(${heading}deg)`, transition: ease ?? 'transform 0.4s' }}>
        <path d="M0 -44 L7 4 L0 0 L-7 4 Z" className="needle" />
      </g>
      <circle r="3" className="dial-hub" />
    </svg>
  )
}
