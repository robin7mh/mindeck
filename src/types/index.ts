import type { LucideIcon } from 'lucide-react'

export type ModuleId =
  | 'core'
  | 'editor'
  | 'terminal'
  | 'browser'
  | 'files'
  | 'projects'
  | 'memory'
  | 'agents'
  | 'system'
  | 'logs'
  | 'settings'
  | 'account'

export interface NavItem {
  /** Its label is `t.nav[id]`. */
  id: Exclude<ModuleId, 'account'>
  icon: LucideIcon
}

export interface ProcessRow {
  pid: number
  name: string
  cpu: number
  mem: number
}

export type MetricKind = 'cpu' | 'ram' | 'disk' | 'network' | 'battery'

export interface MetricSample {
  /** current value, 0..100 (percent) or absolute for network */
  value: number
  /** rolling history for the sparkline */
  history: number[]
}

export type Metrics = Record<MetricKind, MetricSample>
