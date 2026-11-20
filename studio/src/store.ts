import { create } from 'zustand'
import type { Site } from './types'

// UI state shared across tabs. `draft` is the site as edited in the Map tab;
// App autosaves it shortly after each change, so there is no Save button.
// Every edit is undoable (Ctrl+Z / Ctrl+Shift+Z).

export type Selection = { kind: 'spot'; id: string } | { kind: 'edge'; a: string; b: string } | { kind: 'outline'; index: number } | null

interface Studio {
  siteId: string | null
  floorId: string
  draft: Site | null
  dirty: boolean
  past: Site[]
  future: Site[]
  selection: Selection
  recordSpot: string | null // spot picked in the Record tab
  planOpacity: number // floor plan over the satellite view, 0 = hidden
  setPlanOpacity: (v: number) => void
  setSite: (id: string) => void
  setFloor: (id: string) => void
  setDraft: (s: Site | null) => void
  markSaved: (s: Site) => void
  /** Change the draft. Edits with the same `merge` key in a row (a drag) undo as one. */
  edit: (fn: (s: Site) => void, merge?: string) => void
  undo: () => void
  redo: () => void
  select: (s: Selection) => void
  setRecordSpot: (id: string | null) => void
}

let lastMerge: string | undefined

const savedOpacity = () => { try { return +(localStorage.getItem('planOpacity') ?? 0.75) } catch { return 0.75 } }

export const useStudio = create<Studio>((set, get) => ({
  siteId: null,
  floorId: '0',
  draft: null,
  dirty: false,
  past: [],
  future: [],
  selection: null,
  recordSpot: null,
  planOpacity: savedOpacity(),
  setPlanOpacity: (planOpacity) => { try { localStorage.setItem('planOpacity', String(planOpacity)) } catch { /* private window */ } set({ planOpacity }) },
  setSite: (siteId) => set({ siteId, floorId: '0', draft: null, dirty: false, past: [], future: [], selection: null, recordSpot: null }),
  setFloor: (floorId) => set({ floorId, selection: null }),
  setDraft: (draft) => set({ draft, dirty: false, past: [], future: [] }),
  // Only clear `dirty` if nothing changed while the save was in flight
  markSaved: (saved) => set((st) => (st.draft === saved ? { dirty: false } : {})),
  edit: (fn, merge) => {
    const d = get().draft
    if (!d) return
    const next = structuredClone(d)
    fn(next)
    const keep = merge && merge === lastMerge
    lastMerge = merge
    set((st) => ({ draft: next, dirty: true, future: [], past: keep ? st.past : [...st.past.slice(-99), d] }))
  },
  undo: () => {
    const { past, draft, future } = get()
    if (!past.length || !draft) return
    lastMerge = undefined
    set({ draft: past[past.length - 1], past: past.slice(0, -1), future: [draft, ...future], dirty: true, selection: null })
  },
  redo: () => {
    const { past, draft, future } = get()
    if (!future.length || !draft) return
    lastMerge = undefined
    set({ draft: future[0], future: future.slice(1), past: [...past, draft], dirty: true, selection: null })
  },
  select: (selection) => { lastMerge = undefined; set({ selection }) },
  setRecordSpot: (recordSpot) => set({ recordSpot }),
}))
