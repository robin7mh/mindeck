import { useEffect, useState } from 'react'
import { ipc, onEvent } from '@shared/ipc/client'
import type { SystemSnapshot } from '@shared/types/system'
import type { Metrics, MetricKind, ProcessRow } from '@/types'

const HISTORY = 40

function seed(): Metrics {
  const kinds: MetricKind[] = ['cpu', 'ram', 'disk', 'network', 'battery']
  return kinds.reduce((acc, k) => {
    acc[k] = { value: 0, history: Array.from({ length: HISTORY }, () => 0) }
    return acc
  }, {} as Metrics)
}

const push = (prev: { value: number; history: number[] }, value: number) => ({
  value,
  history: [...prev.history.slice(1), value]
})

/** First real sample fills the whole history, so sparklines don't rise from a fake 0. */
const fill = (_prev: { value: number; history: number[] }, value: number) => ({
  value,
  history: Array.from({ length: HISTORY }, () => value)
})

export interface SystemView {
  metrics: Metrics
  processes: ProcessRow[]
  uptimeSec: number
  battery: { hasBattery: boolean; charging: boolean }
  live: boolean
  /** The latest raw sample (per-core load, memory in GB, network split, …). */
  snapshot?: SystemSnapshot
}

/**
 * Subscribes to the main-process telemetry stream and maintains a rolling
 * history so the existing Sparkline/Gauge components render unchanged. Values
 * arrive in natural units; network is CPU+RAM-style summed MB/s.
 * Falls back to zeros (live=false) when the bridge is unavailable.
 */
export function useSystemMetrics(active = true): SystemView {
  const [metrics, setMetrics] = useState<Metrics>(seed)
  const [processes, setProcesses] = useState<ProcessRow[]>([])
  const [uptimeSec, setUptimeSec] = useState(0)
  const [battery, setBattery] = useState({ hasBattery: false, charging: false })
  const [live, setLive] = useState(false)
  const [snapshot, setSnapshot] = useState<SystemSnapshot>()

  // Not `active` (off screen): no stream — the last values stay until it is back.
  useEffect(() => {
    if (!active) return
    let mounted = true
    let primed = false

    const apply = (s: SystemSnapshot) => {
      if (!mounted) return
      const step = primed ? push : fill
      primed = true
      setLive(true)
      setMetrics((prev) => ({
        cpu: step(prev.cpu, s.cpu.total),
        ram: step(prev.ram, s.mem.usedPct),
        disk: step(prev.disk, s.disk.usedPct),
        network: step(prev.network, s.net.rxMbps + s.net.txMbps),
        battery: step(prev.battery, s.battery.pct)
      }))
      setSnapshot(s)
      setProcesses(s.processes)
      setUptimeSec(s.uptimeSec)
      setBattery({ hasBattery: s.battery.hasBattery, charging: s.battery.charging })
    }

    // Prime with a one-shot snapshot, then subscribe to the stream.
    ipc('system:snapshot').then(apply).catch(() => setLive(false))
    ipc('system:subscribe').catch(() => {})
    const off = onEvent('system:tick', apply)

    return () => {
      mounted = false
      off()
      ipc('system:unsubscribe').catch(() => {})
    }
  }, [active])

  return { metrics, processes, uptimeSec, battery, live, snapshot }
}
