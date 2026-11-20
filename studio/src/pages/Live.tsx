import { useState } from 'react'
import { CircleMarker, Polyline, Tooltip } from 'react-leaflet'
import { useLive, useTelemetryDevices } from '../api'
import NavPanel, { deviceRoute } from '../components/NavPanel'
import SiteMap from '../components/SiteMap'
import { toLatLng } from '../geo'
import { useStudio } from '../store'
import type { XY } from '../types'

export default function Live() {
  const { floorId, draft: site } = useStudio()
  const { data: live } = useLive(1000)
  const { data: tele } = useTelemetryDevices(1000)
  const [sel, setSel] = useState<string | null>(null)

  if (!site) return <p className="pad">Loading…</p>
  const devices = live?.devices ?? []
  const dev = devices.find((d) => d.id === sel) ?? devices.find((d) => d.age < 15) ?? devices[0]
  const top = new Map(dev?.result.top?.map((t) => [t.spot, t.p]) ?? [])
  const shade = (id: string) => {
    const p = top.get(id) ?? 0
    return p > 0 ? `rgba(255, ${Math.round(220 - p * 180)}, 0, ${0.4 + p * 0.6})` : '#444'
  }
  const trail = (dev?.history ?? []).map((h) => h.xy).filter((p): p is XY => !!p)
  const other = live?.active !== site.id
  // The device navigating: telemetry knows it by the same id as its scans
  const navDev = tele?.find((d) => d.id === dev?.id && d.age != null && d.age < 15)
    ?? tele?.filter((d) => d.age != null && d.age < 15).sort((a, b) => a.age! - b.age!)[0]
  // Firmware with step tracking sends a smoothed position: draw that as the device's place
  const track = navDev?.track
  const tracked = !!(navDev && track && track.x != null && navDev.trail)

  return (
    <div className="split">
      <div className="mapwrap">
        <SiteMap site={site} floorId={floorId} spotColor={(s) => shade(s.id)} route={deviceRoute(site, navDev)}
          spotTip={(s) => `${((top.get(s.id) ?? 0) * 100).toFixed(0)}% likely`}>
          {/* Raw WiFi fixes: faint when the device's smoothed track is drawn over them */}
          {trail.length > 1 && <Polyline positions={trail.map((p) => toLatLng(site, p))}
            pathOptions={tracked ? { color: '#8d99ae', weight: 1.5, opacity: 0.5, dashArray: '3 4' } : { color: '#4361ee', weight: 3, opacity: 0.6 }} />}
          {tracked && navDev.trail.length > 1 && <Polyline positions={navDev.trail.map((p) => toLatLng(site, p))} pathOptions={{ color: '#4361ee', weight: 3, opacity: 0.8 }} />}
          {dev?.result.xy && (tracked
            ? <CircleMarker center={toLatLng(site, dev.result.xy)} radius={5} pathOptions={{ color: '#8d99ae', weight: 2, fillOpacity: 0 }}>
                <Tooltip direction="right">WiFi: {dev.result.location}</Tooltip>
              </CircleMarker>
            : <CircleMarker center={toLatLng(site, dev.result.xy)} radius={10} pathOptions={{ color: '#fff', weight: 3, fillColor: '#4361ee', fillOpacity: 1 }}>
                <Tooltip permanent direction="right">{dev.result.location}</Tooltip>
              </CircleMarker>)}
          {tracked && (
            <CircleMarker center={toLatLng(site, [track.x!, track.y!])} radius={10} pathOptions={{ color: '#fff', weight: 3, fillColor: '#4361ee', fillOpacity: 1 }}>
              <Tooltip permanent direction="right">{track.moving ? 'walking' : 'still'} · ±{(track.s ?? 0).toFixed(0)} m</Tooltip>
            </CircleMarker>
          )}
        </SiteMap>
      </div>
      <aside className="side">
        {other && <p className="card warn">The server is localizing for <b>{live?.active}</b>, not this site. It switches automatically in a moment.</p>}
        {navDev && <NavPanel site={site} dev={navDev} />}
        <section className="card">
          <h3>Devices</h3>
          {devices.length === 0 && <p className="muted">No device has sent a scan since the server started.</p>}
          {devices.map((d) => (
            <button key={d.id} className={`item wide ${d.id === dev?.id ? 'on' : ''}`} onClick={() => setSel(d.id)}>
              <b>{d.id}</b> <span className="muted">{d.scans} scans · {d.age < 15 ? `${d.age.toFixed(0)} s ago` : 'offline'}</span>
            </button>
          ))}
        </section>
        {dev && (
          <>
            <section className="card">
              <h3>Prediction</h3>
              <div className="big">{dev.result.location}</div>
              <p>{(dev.result.confidence * 100).toFixed(0)}% · {dev.result.known_aps}/{dev.result.total_aps} known APs heard</p>
              {dev.result.known_aps === 0 && <p className="warn">No known access point heard: the answer is a guess (outside the mapped area?).</p>}
              {track && <p className="muted small">{track.steps} steps counted · {track.moving ? 'walking' : 'standing still'}{tracked ? ' · map shows the smoothed position, WiFi fixes in grey' : ''}</p>}
              {dev.result.top?.map((t) => (
                <div key={t.spot} className="barrow"><span>{t.spot}</span><i style={{ width: `${t.p * 100}%` }} /><span>{(t.p * 100).toFixed(0)}%</span></div>
              ))}
            </section>
            <section className="card">
              <h3>Last scan ({dev.scan.length} APs)</h3>
              <table>
                <thead><tr><th>BSSID</th><th>RSSI</th></tr></thead>
                <tbody>{dev.scan.map(([b, r]) => (
                  <tr key={b}><td className="mono">{b}</td><td><div className="rssi" style={{ width: `${Math.max(4, (r + 100) * 1.6)}px` }} />{r}</td></tr>
                ))}</tbody>
              </table>
            </section>
          </>
        )}
      </aside>
    </div>
  )
}
