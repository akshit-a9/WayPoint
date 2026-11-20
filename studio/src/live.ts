import { useCallback, useSyncExternalStore } from 'react'
import type { TelemetryBatch } from './types'

// Live sensor stream (server-sent events, ~25 Hz) for the Debug tab. Opening
// it is what puts the device in live mode: the server tells the device to
// stream over UDP and pause its WiFi scans while anyone is watching.

export type Sample = NonNullable<TelemetryBatch['sensors']>[number] // [device ms, mx, my, mz, ax, ay, az]

const KEEP = 25 * 120 // 2 min
const NOTIFY_MS = 40 // re-render at most ~25 times a second
const STALE_MS = 1200 // no packet for this long = not live

interface Stream {
  es: EventSource
  samples: Sample[]
  at: number // performance.now() of the last packet
  live: boolean
  snap: { samples: Sample[]; live: boolean }
  subs: Set<() => void>
  timer: number | null
  watch: number
  closeTimer: number | null
}

const streams = new Map<string, Stream>()
const EMPTY = { samples: [] as Sample[], live: false }

function notify(s: Stream) {
  s.snap = { samples: s.samples, live: s.live }
  s.subs.forEach((f) => f())
}

function open(device: string): Stream {
  const es = new EventSource(`/api/telemetry/${encodeURIComponent(device)}/live`)
  const s: Stream = { es, samples: [], at: 0, live: false, snap: EMPTY, subs: new Set(), timer: null, watch: 0, closeTimer: null }
  es.onmessage = (e) => {
    const fresh = JSON.parse(e.data) as Sample[]
    // A reboot restarts the device clock; drop the old run so time stays monotonic
    if (fresh.length && s.samples.length && fresh[0][0] < s.samples[s.samples.length - 1][0]) s.samples = []
    s.samples = s.samples.concat(fresh).slice(-KEEP)
    s.at = performance.now()
    s.live = true
    if (s.timer == null) s.timer = window.setTimeout(() => { s.timer = null; notify(s) }, NOTIFY_MS)
  }
  // Notice when packets stop (device off, scans resumed, ...)
  s.watch = window.setInterval(() => {
    const live = performance.now() - s.at < STALE_MS
    if (live !== s.live) { s.live = live; notify(s) }
  }, 500)
  streams.set(device, s)
  return s
}

function close(device: string) {
  const s = streams.get(device)
  if (!s) return
  s.es.close()
  clearInterval(s.watch)
  if (s.timer != null) clearTimeout(s.timer)
  streams.delete(device)
}

/** The device's live samples (newest last) and whether they are flowing. Shared by every caller. */
export function useLiveSensors(device: string | undefined) {
  const subscribe = useCallback((cb: () => void) => {
    if (!device) return () => {}
    const s = streams.get(device) ?? open(device)
    if (s.closeTimer != null) { clearTimeout(s.closeTimer); s.closeTimer = null }
    s.subs.add(cb)
    return () => {
      s.subs.delete(cb)
      // Close a moment after the last viewer leaves (a quick remount reuses it)
      if (!s.subs.size) s.closeTimer = window.setTimeout(() => { if (!s.subs.size) close(device) }, 1000)
    }
  }, [device])
  return useSyncExternalStore(subscribe, () => (device ? streams.get(device)?.snap ?? EMPTY : EMPTY))
}
