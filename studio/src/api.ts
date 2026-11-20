import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Device, ModelMetrics, Orientation, Site, SiteSummary, Take, TelemetryBatch, TelemetryDevice } from './types'

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? r.statusText)
  return r.json()
}

/** Older site.json files keep destinations in their own list; fold them into spots. */
export function normalize(site: Site): Site {
  const s = structuredClone(site) as Site & { connectors?: unknown }
  // Walkable areas and the unused connector list are gone: routes follow the links between spots
  for (const f of s.floors) delete (f as { walkable?: unknown }).walkable
  delete s.connectors
  s.edges ??= []
  for (const d of s.destinations ?? []) {
    if (!s.spots.some((p) => p.id === d.id)) s.spots.push({ id: d.id, name: d.name, floor: d.floor, x: d.x, y: d.y, dest: { category: d.category } })
  }
  return s
}

/** What goes to disk: spots plus the derived destination list the firmware reads. */
export function forDisk(site: Site): Site {
  return {
    ...site,
    destinations: site.spots.filter((p) => p.dest && p.x != null)
      .map((p) => ({ id: p.id, name: p.name || p.id, floor: p.floor, x: p.x!, y: p.y!, category: p.dest!.category })),
  }
}

export const useSites = () =>
  useQuery({ queryKey: ['sites'], queryFn: () => call<{ active: string; sites: SiteSummary[] }>('GET', '/api/sites') })

export const useSite = (id: string | null) =>
  useQuery({ queryKey: ['site', id], queryFn: () => call<Site>('GET', `/api/sites/${id}`).then(normalize), enabled: !!id })

export const useLive = (ms = 1000) =>
  useQuery({
    queryKey: ['live'],
    queryFn: () => call<{ active: string; devices: Device[]; take: Take | null }>('GET', '/api/live'),
    refetchInterval: ms,
  })

export type TakeRow = { take: string; spot: string; device: string; scans: number; aps: number }

export const useRecordings = (id: string | null) =>
  useQuery({
    queryKey: ['recordings', id],
    queryFn: () => call<{ takes: TakeRow[]; perSpot: Record<string, number> }>('GET', `/api/sites/${id}/recordings`),
    enabled: !!id,
  })

export const useModels = (id: string | null) =>
  useQuery({
    queryKey: ['models', id],
    queryFn: () => call<{ active: string | null; models: ModelMetrics[] }>('GET', `/api/sites/${id}/models`),
    enabled: !!id,
  })

export const useTelemetryDevices = (ms = 2000) =>
  useQuery({ queryKey: ['telemetry'], queryFn: () => api.telemetryDevices(), refetchInterval: ms })

/** Mutation that refreshes the given queries when it succeeds. */
export function useAction<A>(fn: (a: A) => Promise<unknown>, refresh: string[][]) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => refresh.forEach((k) => qc.invalidateQueries({ queryKey: k })),
  })
}

export const api = {
  saveSite: (s: Site) => call('PUT', `/api/sites/${s.id}`, forDisk(s)),
  newSite: (s: { id: string; name: string; private: boolean; lat: number; lon: number }) => call<Site>('POST', '/api/sites', s),
  deleteSite: (id: string) => call('DELETE', `/api/sites/${id}`),
  setActive: (id: string) => call('PUT', '/api/active', { id }),
  startTake: (t: { site: string; spot: string; device: string; seconds: number }) => call<Take>('POST', '/api/take', t),
  cancelTake: () => call('DELETE', '/api/take'),
  deleteTake: (site: string, take: string) => call('DELETE', `/api/sites/${site}/recordings/${take}`),
  train: (site: string) => call<ModelMetrics>('POST', `/api/sites/${site}/train`),
  activateModel: (site: string, id: string) => call('PUT', `/api/sites/${site}/models/active`, { id }),
  deleteModel: (site: string, id: string) => call('DELETE', `/api/sites/${site}/models/${id}`),
  telemetryDevices: () => call<{ devices: TelemetryDevice[] }>('GET', '/api/telemetry').then((r) => r.devices),
  telemetry: (device: string, since: number) =>
    call<{ batches: TelemetryBatch[] }>('GET', `/api/telemetry/${encodeURIComponent(device)}?since=${since}`).then((r) => r.batches),
  command: (device: string, cmd: string, arg = '') =>
    call('POST', `/api/telemetry/${encodeURIComponent(device)}/command`, { cmd, arg }),
  getOrientation: (device: string) => call<Partial<Orientation>>('GET', `/api/devices/${encodeURIComponent(device)}/orientation`),
  putOrientation: (device: string, o: Orientation) => call('PUT', `/api/devices/${encodeURIComponent(device)}/orientation`, o),
}
