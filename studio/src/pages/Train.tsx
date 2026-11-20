import { Polyline } from 'react-leaflet'
import { api, useAction, useModels, useRecordings } from '../api'
import SiteMap from '../components/SiteMap'
import { ConfirmButton } from '../components/ui'
import { toLatLng } from '../geo'
import { useStudio } from '../store'
import type { XY } from '../types'

const errColor = (e: number | null) => e == null ? '#888' : e < 2 ? '#06d6a0' : e < 5 ? '#ffd166' : '#ef476f'

export default function Train({ goTo }: { goTo: (t: 'record') => void }) {
  const { siteId, floorId, draft: site, setRecordSpot } = useStudio()
  const { data: models } = useModels(siteId)
  const { data: rec } = useRecordings(siteId)
  const refresh = [['models', siteId ?? ''], ['site', siteId ?? ''], ['sites']]
  const train = useAction(() => api.train(siteId!), refresh)
  const activate = useAction((v: string) => api.activateModel(siteId!, v), refresh)
  const remove = useAction((v: string) => api.deleteModel(siteId!, v), refresh)

  if (!site) return null
  const shown = models?.models.find((m) => m.version === models.active) ?? models?.models.at(-1)
  const per = new Map(shown?.perSpot.map((p) => [p.spot, p]) ?? [])
  const pos = new Map(site.spots.filter((s) => s.x != null).map((s) => [s.id, [s.x!, s.y!] as XY]))
  const name = (id: string) => { const s = site.spots.find((p) => p.id === id); return s?.name || id }
  const counts = rec?.perSpot ?? {}
  const recorded = Object.keys(counts).length
  const thin = site.spots.filter((s) => s.x != null && (counts[s.id] ?? 0) < 2)

  return (
    <div className="split">
      <div className="mapwrap">
        <SiteMap site={site} floorId={floorId} spotColor={(s) => errColor(per.get(s.id)?.meanError ?? null)}
          spotTip={(s) => { const p = per.get(s.id); return p ? `mean error ${p.meanError ?? '–'} m${p.confusedWith ? ` · mixed up with ${name(p.confusedWith)}` : ''}` : 'not in this model' }}>
          {/* Lines from each spot to the spot it is most often mistaken for */}
          {shown?.perSpot.filter((p) => p.confusedWith && pos.has(p.spot) && pos.has(p.confusedWith)).map((p) => (
            <Polyline key={p.spot} positions={[toLatLng(site, pos.get(p.spot)!), toLatLng(site, pos.get(p.confusedWith!)!)]}
              pathOptions={{ color: '#ef476f', weight: 2, dashArray: '3 5' }} />
          ))}
        </SiteMap>
        {shown && <div className="legend">
          <span><i style={{ background: errColor(1) }} />&lt; 2 m</span><span><i style={{ background: errColor(3) }} />&lt; 5 m</span>
          <span><i style={{ background: errColor(9) }} />≥ 5 m</span><span><i className="dash" />mixed up</span>
        </div>}
      </div>
      <aside className="side">
        <section className="card">
          <h3>Train</h3>
          <p className="muted small">Uses every take for {site.name}: {rec?.takes.length ?? 0} takes over {recorded} spots. Scores hold out whole takes, so they show how well a new visit is recognised.</p>
          {thin.length > 0 && <p className="warn small">{thin.length} spots have fewer than 2 takes; they will score poorly. <button className="link" onClick={() => { setRecordSpot(thin[0].id); goTo('record') }}>Record them →</button></p>}
          <button className="primary wide" disabled={train.isPending || recorded < 2} onClick={() => train.mutate(undefined)}
            data-tip={recorded < 2 ? 'Record at least two spots first' : 'Train a new model version and make it active'}>
            {train.isPending ? 'Training…' : 'Train new model'}</button>
          {train.error && <p className="err">{train.error.message}</p>}
        </section>
        {shown && (
          <section className="card">
            <h3>{shown.version} {shown.version === models?.active ? '· active' : ''}</h3>
            <dl className="stats">
              <div data-tip="Share of held-out scans placed at the right spot"><dt>Accuracy</dt><dd>{shown.accuracy == null ? '–' : `${(shown.accuracy * 100).toFixed(0)}%`}</dd></div>
              <div data-tip="Average distance between the true and predicted spot"><dt>Mean error</dt><dd>{shown.meanError ?? '–'} m</dd></div>
              <div data-tip="9 in 10 predictions are at least this close"><dt>90% within</dt><dd>{shown.p90Error ?? '–'} m</dd></div>
              <div><dt>Spots / takes</dt><dd>{shown.spots} / {shown.takes}</dd></div>
              <div><dt>Scans</dt><dd>{shown.scans}</dd></div>
              <div data-tip="Distinct WiFi access points the model knows"><dt>APs</dt><dd>{shown.accessPoints}</dd></div>
            </dl>
            <table>
              <thead><tr><th>Spot</th><th data-tip="Takes">T</th><th>Acc.</th><th>Err.</th><th>Mixed with</th></tr></thead>
              <tbody>{shown.perSpot.slice().sort((a, b) => (b.meanError ?? 0) - (a.meanError ?? 0)).map((p) => (
                <tr key={p.spot}><td>{name(p.spot)}</td><td>{p.takes}</td><td>{p.accuracy == null ? '–' : `${(p.accuracy * 100).toFixed(0)}%`}</td>
                  <td style={{ color: errColor(p.meanError) }}>{p.meanError ?? '–'}</td><td>{p.confusedWith ? name(p.confusedWith) : ''}</td></tr>
              ))}</tbody>
            </table>
          </section>
        )}
        <section className="card">
          <h3>Model versions</h3>
          {site.activeModel === 'legacy' && <p className="muted small">Active: the original phone-trained model from Indoor-Localization.</p>}
          {!models?.models.length && <p className="muted small">None yet.</p>}
          {models?.models.slice().reverse().map((m) => (
            <div key={m.version} className="item">
              <b>{m.version}</b> <span className="muted small grow">{m.trainedAt} · {m.meanError ?? '–'} m · {m.takes} takes</span>
              {m.version === models.active ? <span className="pill on" data-tip="The device is using this model">active</span>
                : <button onClick={() => activate.mutate(m.version)} data-tip="Make the device use this model">Use</button>}
              <ConfirmButton className="icon" confirm="Delete?" tip="Delete this model file" onConfirm={() => remove.mutate(m.version)}>🗑</ConfirmButton>
            </div>
          ))}
        </section>
      </aside>
    </div>
  )
}
