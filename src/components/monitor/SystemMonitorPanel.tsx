import { Cpu, MemoryStick, HardDrive, Activity, BatteryMedium, Clock3 } from 'lucide-react'
import { Panel } from '@/components/ui/Panel'
import { SystemMetricCard } from './SystemMetricCard'
import { RadialGauge } from './RadialGauge'
import { StatusDot } from '@/components/ui/StatusDot'
import { TechLabel } from '@/components/ui/TechLabel'
import { useSystemMetrics } from '@/features/system/useSystemMetrics'
import { useT } from '@/lib/i18n'

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

/**
 * Right rail: live system telemetry from the main process (systeminformation
 * over IPC). Same Sparkline/Gauge components as before — only the data source
 * changed. `live` reflects whether the telemetry stream is connected.
 */
export function SystemMonitorPanel() {
  const t = useT()
  const { metrics: m, processes, uptimeSec, battery, live } = useSystemMetrics()
  const netMax = Math.max(1, ...m.network.history)

  return (
    <Panel
      title={t.monitor.title}
      corners
      className="w-full"
      headerRight={
        <span className="flex items-center gap-1.5">
          <StatusDot tone={live ? 'ok' : 'muted'} pulse={live} />
          <span className="font-mono text-[11px] text-text-muted">{live ? t.monitor.live : t.monitor.offline}</span>
        </span>
      }
      bodyClassName="flex flex-col gap-3 overflow-y-auto"
    >
      {/* headline gauges */}
      <div className="flex items-center justify-around rounded-md border border-hud/50 bg-surface/40 py-3">
        <RadialGauge value={m.cpu.value} accent="var(--accent-cyan)" label="CPU" />
        <RadialGauge value={m.ram.value} accent="var(--accent-blue)" label="RAM" />
      </div>

      {/* system uptime */}
      <div className="flex items-center justify-between rounded-md border border-hud/50 bg-surface/40 px-2.5 py-1.5">
        <span className="flex items-center gap-2">
          <Clock3 size={13} className="text-text-muted" />
          <TechLabel className="text-text-secondary">{t.monitor.uptime}</TechLabel>
        </span>
        <span className="font-mono text-[12px] text-text-primary tabular-nums">
          {uptimeSec > 0 ? fmtUptime(uptimeSec) : '—'}
        </span>
      </div>

      {/* metric sparklines */}
      <SystemMetricCard label={t.monitor.cpu} icon={Cpu} sample={m.cpu} accent="var(--accent-cyan)" />
      <SystemMetricCard label={t.monitor.memory} icon={MemoryStick} sample={m.ram} accent="var(--accent-blue)" />
      <SystemMetricCard label={t.monitor.disk} icon={HardDrive} sample={m.disk} accent="var(--accent-purple)" />
      <SystemMetricCard
        label={t.monitor.network}
        icon={Activity}
        sample={m.network}
        accent="var(--accent-cyan)"
        unit="MB/s"
        max={netMax}
        format={(v) => v.toFixed(1)}
      />
      {battery.hasBattery ? (
        <SystemMetricCard
          label={battery.charging ? `${t.monitor.battery} ⚡` : t.monitor.battery}
          icon={BatteryMedium}
          sample={m.battery}
          accent="var(--accent-amber)"
        />
      ) : (
        <div className="flex items-center justify-between rounded-md border border-hud/50 bg-surface/40 p-2.5">
          <span className="flex items-center gap-2">
            <BatteryMedium size={14} className="text-text-muted" />
            <TechLabel className="text-text-secondary">{t.monitor.battery}</TechLabel>
          </span>
          <span className="font-mono text-[11px] text-text-muted">{t.monitor.na}</span>
        </div>
      )}

      {/* processes preview */}
      <div className="rounded-md border border-hud/50 bg-surface/40 p-2.5">
        <div className="mb-2 flex items-center justify-between">
          <TechLabel className="text-text-secondary">{t.monitor.processes}</TechLabel>
          <TechLabel className="text-text-muted">{t.monitor.cpuMem}</TechLabel>
        </div>
        <ul className="space-y-1.5">
          {processes.length === 0 && (
            <li className="py-1 font-mono text-[11px] text-text-muted">
              {live ? t.monitor.sampling : t.monitor.noData}
            </li>
          )}
          {processes.map((p) => (
            <li key={p.pid} className="flex items-center gap-2 font-mono text-[11px]">
              <span className="w-12 shrink-0 text-text-muted">{p.pid}</span>
              <span className="flex-1 truncate text-text-secondary">{p.name}</span>
              <span className="w-10 text-right text-cyan tabular-nums">{p.cpu.toFixed(1)}</span>
              <span className="w-12 text-right text-text-muted tabular-nums">{p.mem}m</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  )
}
