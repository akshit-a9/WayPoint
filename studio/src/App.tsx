import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, useAction, useLive, useSite, useSites, useTelemetryDevices } from './api'
import { ConfirmButton, InlineEdit, Popover, TooltipLayer, typing } from './components/ui'
import Collect from './pages/Collect'
import Debug from './pages/Debug'
import Live from './pages/Live'
import MapEditor from './pages/MapEditor'
import Train from './pages/Train'
import { useStudio } from './store'

const TABS = {
  map: ['Map', MapEditor, 'Draw the building: spots, destinations and the links routes follow'],
  record: ['Record', Collect, 'Record WiFi at each spot with the device'],
  train: ['Train', Train, 'Build a model from the recordings and see how accurate it is'],
  live: ['Live', Live, 'Watch where the device thinks it is, and send it somewhere'],
  device: ['Device', Debug, 'Device health, orientation, compass and debug log'],
} as const
type TabId = keyof typeof TABS

const stored = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const store = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }

export default function App() {
  const [tab, setTab] = useState<TabId>(() => (stored('tab') ?? '') in TABS ? stored('tab') as TabId : 'map')
  const { siteId, floorId, draft, setSite, setFloor, setDraft } = useStudio()
  const { data: sites } = useSites()
  const { data: site } = useSite(siteId)

  useEffect(() => store('tab', tab), [tab])
  // First load: last site used, else the one the device is localizing
  useEffect(() => {
    if (sites && !siteId) {
      const last = stored('site')
      setSite(last && sites.sites.some((s) => s.id === last) ? last : sites.active)
    }
  }, [sites, siteId, setSite])
  useEffect(() => { if (siteId) store('site', siteId) }, [siteId])
  // The draft is what every tab shows; it starts as the server's copy
  useEffect(() => { if (site && (!draft || draft.id !== site.id)) setDraft(site) }, [site, draft, setDraft])
  useAutosave()
  useUndoKeys()

  const Page = TABS[tab][1]
  return (
    <div className="app">
      <header className="top">
        <b className="brand">WayPoint Studio</b>
        <SitePicker />
        {draft && draft.floors.length > 1 && (
          <select value={floorId} onChange={(e) => setFloor(e.target.value)} data-tip="Floor">
            {draft.floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
        <nav className="tabs">
          {(Object.keys(TABS) as TabId[]).map((t) => (
            <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)} data-tip={TABS[t][2]}>{TABS[t][0]}</button>
          ))}
        </nav>
        <SaveStatus />
        <DevicePill onClick={() => setTab('device')} />
      </header>
      <main>{draft ? <Page goTo={(t: TabId) => setTab(t)} /> : <p className="pad muted">Loading sites…</p>}</main>
      <TooltipLayer />
    </div>
  )
}

/** Saves the draft ~0.6 s after the last change; keeps the query cache in step. */
function useAutosave() {
  const { draft, dirty, markSaved } = useStudio()
  const qc = useQueryClient()
  useEffect(() => {
    if (!draft || !dirty) return
    const t = setTimeout(() => {
      api.saveSite(draft).then(() => {
        qc.setQueryData(['site', draft.id], draft)
        qc.invalidateQueries({ queryKey: ['sites'] })
        markSaved(draft)
      }, () => { /* stays dirty; SaveStatus shows it and the next edit retries */ })
    }, 600)
    return () => clearTimeout(t)
  }, [draft, dirty, markSaved, qc])
}

function useUndoKeys() {
  const { undo, redo } = useStudio()
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e) || !(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo() }
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [undo, redo])
}

function SaveStatus() {
  const { dirty, past, future, undo, redo } = useStudio()
  return (
    <div className="savestatus">
      <button className="icon" disabled={!past.length} onClick={undo} data-tip="Undo (Ctrl+Z)">↶</button>
      <button className="icon" disabled={!future.length} onClick={redo} data-tip="Redo (Ctrl+Shift+Z)">↷</button>
      <span className="muted small" data-tip="Changes save automatically">{dirty ? 'Saving…' : 'Saved'}</span>
    </div>
  )
}

/** Site switcher with create, rename and delete in one place. */
function SitePicker() {
  const { siteId, draft, dirty, setSite, edit } = useStudio()
  const { data: sites } = useSites()
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const activate = useAction(api.setActive, [['sites'], ['live']])
  const remove = useAction(api.deleteSite, [['sites']])
  const qc = useQueryClient()

  // The device localizes for whichever site you are working on
  useEffect(() => {
    if (sites && siteId && sites.active !== siteId && !activate.isPending) activate.mutate(siteId)
  }, [sites, siteId]) // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async (id: string) => {
    if (dirty && draft) await api.saveSite(draft).catch(() => null)   // flush, then switch
    setSite(id)
    setOpen(false)
  }
  const rename = async (id: string, name: string) => {
    if (id === siteId) edit((s) => { s.name = name })
    else {
      const s = await qc.fetchQuery({ queryKey: ['site', id], queryFn: () => fetch(`/api/sites/${id}`).then((r) => r.json()) })
      await api.saveSite({ ...s, name })
      qc.invalidateQueries({ queryKey: ['sites'] })
      qc.invalidateQueries({ queryKey: ['site', id] })
    }
  }

  return (
    <Popover open={open} setOpen={setOpen} trigger={
      <button className="sitebtn" onClick={() => setOpen(!open)} data-tip="Switch, add, rename or delete sites">
        {draft?.name ?? 'Site'} <span className="muted">▾</span>
      </button>}>
      <div className="sitelist">
        {sites?.sites.map((s) => (
          <div key={s.id} className={`siterow ${s.id === siteId ? 'on' : ''}`} onClick={() => choose(s.id)}>
            <div className="grow">
              <InlineEdit value={s.id === siteId && draft ? draft.name : s.name} onSave={(n) => rename(s.id, n)} penOnly />
              <div className="muted small">{s.spots} spots · {s.takes} takes{s.private ? ' · private (not in git)' : ''}{s.id === sites.active ? ' · device uses this' : ''}</div>
            </div>
            <ConfirmButton className="icon" tip="Delete site (moved to the trash folder, recoverable)"
              confirm="Delete?" disabled={s.id === siteId}
              onConfirm={() => remove.mutate(s.id)}>🗑</ConfirmButton>
          </div>
        ))}
      </div>
      {adding ? <NewSite onDone={(id) => { setAdding(false); if (id) choose(id) }} />
        : <button className="wide" onClick={() => setAdding(true)}>+ New site</button>}
    </Popover>
  )
}

function NewSite({ onDone }: { onDone: (id?: string) => void }) {
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [priv, setPriv] = useState(true)
  const add = useAction(api.newSite, [['sites']])
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const sid = idTouched ? id : slug(name)
  return (
    <form className="newsite" onSubmit={(e) => { e.preventDefault(); add.mutate({ id: sid, name, private: priv, lat: 15.3925, lon: 73.88 }, { onSuccess: () => onDone(sid) }) }}>
      <input ref={ref} placeholder="Name, e.g. DH-5 hostel" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="id" value={sid} onChange={(e) => { setIdTouched(true); setId(slug(e.target.value)) }} data-tip="Folder name; letters, digits and dashes" />
      <label data-tip="Private sites live in private/sites/, which git ignores"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> keep out of git</label>
      <div className="row">
        <button className="primary" disabled={!sid || !name.trim() || add.isPending}>Create</button>
        <button type="button" onClick={() => onDone()}>Cancel</button>
      </div>
      {add.error && <span className="err">{add.error.message}</span>}
    </form>
  )
}

/** Is a device talking to the server? Visible from every tab. */
function DevicePill({ onClick }: { onClick: () => void }) {
  const { data: tele } = useTelemetryDevices(2000)
  const { data: live } = useLive(2000)
  const dev = tele?.filter((d) => d.age != null && d.age < 10).sort((a, b) => a.age! - b.age!)[0]
  const scanning = live?.devices.find((d) => d.age < 15)
  if (!dev && !scanning) return <button className="pill bad" onClick={onClick} data-tip="No device has reported in the last 10 s. Is it powered and on the hotspot?">○ No device</button>
  const id = dev?.id ?? scanning!.id
  const tip = dev?.health ? `${id} · fw ${dev.fw} · WiFi ${dev.health.rssi} dBm · ${dev.ui?.screen}` : `${id} (old firmware: scans only)`
  return <button className="pill on" onClick={onClick} data-tip={tip}>● {id.slice(-5)}{dev?.health ? ` · ${dev.health.rssi} dBm` : ''}</button>
}
