import type { DeviceActivity, MindeckEvent } from '@shared/types/events'
import { getT, intlLocale } from '@/lib/i18n'

/** "just now", "5 min ago", "3 h ago", else a short date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = getT().common
  const diff = Math.max(0, now - Date.parse(iso))
  if (diff < 45_000) return t.justNow
  if (diff < 3_600_000) return t.minAgo(Math.round(diff / 60_000))
  if (diff < 86_400_000) return t.hAgo(Math.round(diff / 3_600_000))
  return new Date(iso).toLocaleDateString(intlLocale(), { day: '2-digit', month: 'short' })
}

export type Tone = 'cyan' | 'ok' | 'warn' | 'error' | 'muted'

interface P {
  agent?: string
  goal?: string
  tool?: string
  summary?: string
  error?: string
  status?: string
  text?: string
  decision?: string
  reason?: string
  iterations?: number
  outputTokens?: number
  title?: string
  code?: number
}

/** One line per event for the activity timeline — what happened, in plain words. */
export function describeEvent(e: MindeckEvent): { text: string; tone: Tone } {
  const p = (e.payload ?? {}) as P
  const t = getT().agents.ev
  switch (e.type) {
    case 'agent.started':
      return { text: t.started(p.agent ?? t.agent, p.goal ?? ''), tone: 'cyan' }
    case 'agent.status.updated':
      return { text: p.text ?? t.working, tone: 'muted' }
    case 'agent.completed':
      return { text: t.completed(p.iterations ?? 0, p.outputTokens ?? 0), tone: 'ok' }
    case 'agent.failed':
      return { text: t.failed(p.status === 'timeout', p.error ?? ''), tone: 'error' }
    case 'agent.cancelled':
      return { text: t.cancelled, tone: 'warn' }
    case 'tool.started':
      return { text: p.summary ?? t.tool(String(p.tool)), tone: 'cyan' }
    case 'tool.completed':
      return { text: t.done(String(p.summary ?? p.tool)), tone: 'ok' }
    case 'tool.failed':
      return { text: t.toolFailed(String(p.summary ?? p.tool), p.error ?? ''), tone: 'error' }
    case 'tool.denied':
      return { text: t.blocked(String(p.summary ?? p.tool), p.reason && p.reason !== 'user' ? p.reason : ''), tone: 'warn' }
    case 'permission.requested':
      return { text: t.requested(String(p.summary ?? p.tool)), tone: 'warn' }
    case 'permission.granted':
      return { text: t.granted(p.decision === 'always', String(p.tool)), tone: 'ok' }
    case 'permission.denied':
      return { text: t.denied(String(p.tool)), tone: 'error' }
    case 'session.started':
      return { text: t.started(p.agent ?? t.agent, p.title ?? ''), tone: 'cyan' }
    case 'session.ended':
      return { text: t.ended(p.code), tone: p.code ? 'warn' : 'muted' }
    case 'device.files':
      return describeDevice(e.payload as DeviceActivity, e.type === 'device.files' && (e.payload as DeviceActivity).action === 'trash')
    default:
      return { text: e.type, tone: 'muted' }
  }
}

/** What a paired device did with the files: "iPhone moved 3 items → ~/Archive". */
function describeDevice(d: DeviceActivity, warn: boolean): { text: string; tone: Tone } {
  const t = getT().agents.ev
  const did = t.device[d.action as keyof typeof t.device] as ((device: string, what: string) => string) | undefined
  const items = d.paths?.length ? (d.count && d.count > 1 ? t.items(d.count) : d.paths[0]) : d.path
  const base = items ?? ''
  const what = d.dest ? `${base} → ${d.dest}` : base
  return { text: did ? did(d.device, what) : t.device.other(d.device, d.action), tone: warn ? 'warn' : 'cyan' }
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
