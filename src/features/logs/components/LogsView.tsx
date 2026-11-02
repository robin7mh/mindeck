import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, Copy, Search } from 'lucide-react'
import { ipc, onEvent } from '@shared/ipc/client'
import type { MindeckEvent } from '@shared/types/events'
import { Panel } from '@/components/ui/Panel'
import { StatusDot } from '@/components/ui/StatusDot'
import { cn } from '@/lib/cn'
import { intlLocale, useT } from '@/lib/i18n'
import { clock, describeEvent } from '@/features/agents/format'

/** What the core keeps to hand over (its most recent), and what this view holds at most. */
const LOAD = 500
const KEEP = 2000

export type LogFilter = 'all' | 'agents' | 'tools' | 'approvals' | 'app'
const FILTERS: LogFilter[] = ['all', 'agents', 'tools', 'approvals', 'app']

/** Where an event belongs. Approvals include a tool the policy blocked. */
export function logKind(e: MindeckEvent): Exclude<LogFilter, 'all'> {
  if (e.type.startsWith('permission.') || e.type === 'tool.denied') return 'approvals'
  if (e.type.startsWith('tool.')) return 'tools'
  if (e.type.startsWith('agent.') || e.type.startsWith('session.')) return 'agents'
  return 'app'
}

/** A step-by-step status line of a running agent: shown in its chat, not kept as a log line. */
const isStep = (e: MindeckEvent) => e.type === 'agent.status.updated'

const dayOf = (iso: string) => new Date(iso).toDateString()

/** One log line as text: for copying. */
function lineOf(e: MindeckEvent): string {
  const d = new Date(e.ts)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${date} ${clock(e.ts)}  ${e.type}  ${describeEvent(e).text}`
}

/**
 * The Logs module: everything Mindeck recorded — the app starting, agents and
 * their runs, tools, approvals — newest first, by day, live. Filter by kind,
 * search, open a line for its details, copy what is shown.
 */
export function LogsView() {
  const t = useT()
  const l = t.logs
  const [events, setEvents] = useState<MindeckEvent[]>([])
  const [error, setError] = useState<string>()
  const [filter, setFilter] = useState<LogFilter>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string>()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live: MindeckEvent[] = []
    let loaded = false
    const add = (e: MindeckEvent) => {
      if (isStep(e)) return
      if (!loaded) live = [e, ...live]
      else setEvents((list) => (list.some((x) => x.id === e.id) ? list : [e, ...list].slice(0, KEEP)))
    }
    const off = onEvent('events:event', add)
    ipc('events:recent', { limit: LOAD }).then(
      (recent) => {
        loaded = true
        // What arrived while loading goes on top of it, once.
        const seen = new Set(recent.map((e) => e.id))
        setEvents([...live.filter((e) => !seen.has(e.id)), ...recent.filter((e) => !isStep(e))].slice(0, KEEP))
      },
      (err: Error) => {
        loaded = true
        setEvents(live)
        setError(err.message)
      }
    )
    return off
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return events.filter((e) => {
      if (filter !== 'all' && logKind(e) !== filter) return false
      if (!q) return true
      return `${e.type} ${describeEvent(e).text} ${e.actor.id ?? ''} ${e.projectId ?? ''}`.toLowerCase().includes(q)
    })
  }, [events, filter, query])

  const counts = useMemo(() => {
    const c: Record<LogFilter, number> = { all: events.length, agents: 0, tools: 0, approvals: 0, app: 0 }
    for (const e of events) c[logKind(e)] += 1
    return c
  }, [events])

  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86_400_000).toDateString()
  const dayLabel = (iso: string) => {
    const day = dayOf(iso)
    if (day === today) return l.today
    if (day === yesterday) return l.yesterday
    return new Date(iso).toLocaleDateString(intlLocale(), { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
  }

  const copy = () => {
    void navigator.clipboard?.writeText(shown.map(lineOf).join('\n'))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Panel
      title={t.nav.logs}
      corners
      flush
      className="min-h-0 flex-1"
      bodyClassName="flex min-h-0 flex-col"
      headerRight={
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] text-text-muted">{l.count(shown.length)}</span>
          <StatusDot tone="ok" pulse />
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{l.live}</span>
        </span>
      }
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hud/50 px-3 py-2">
        <div role="tablist" aria-label={l.filter} className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-sm px-2 py-1 font-sans text-[11.5px] font-medium transition-colors',
                filter === f ? 'bg-cyan/10 text-cyan' : 'text-text-muted hover:text-text-secondary'
              )}
            >
              {l.filters[f]}
              <span className="ml-1 font-mono text-[10px]">{counts[f]}</span>
            </button>
          ))}
        </div>
        <label className="ml-auto flex min-w-[180px] items-center gap-1.5 rounded-md border border-hud/60 bg-surface/50 px-2 py-1 focus-within:border-cyan/50">
          <Search size={12} className="shrink-0 text-text-muted" />
          <input
            aria-label={l.search}
            placeholder={l.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent font-sans text-[12px] text-text-primary outline-hidden placeholder:text-text-muted"
          />
        </label>
        <button
          type="button"
          onClick={copy}
          disabled={!shown.length}
          className="flex items-center gap-1.5 rounded-md border border-hud/60 px-2 py-1 font-sans text-[11.5px] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
        >
          {copied ? <Check size={12} className="text-green" /> : <Copy size={12} />} {copied ? l.copied : l.copy}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {error && <p className="px-2 py-2 font-mono text-[11px] text-danger">{error}</p>}
        {!shown.length ? (
          <p className="px-2 py-3 font-mono text-[11px] text-text-muted">{events.length ? l.noMatch : l.empty}</p>
        ) : (
          <ol className="text-[12px]">
            {shown.map((e, i) => {
              const { text, tone } = describeEvent(e)
              const expanded = open === e.id
              const newDay = i === 0 || dayOf(shown[i - 1].ts) !== dayOf(e.ts)
              return (
                <li key={e.id}>
                  {newDay && <p className="sticky top-0 z-10 bg-panel/95 px-2 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">{dayLabel(e.ts)}</p>}
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? undefined : e.id)}
                    className={cn('flex w-full items-start gap-2 rounded-sm px-2 py-1 text-left hover:bg-elevated/40', expanded && 'bg-elevated/40')}
                  >
                    <ChevronRight size={12} className={cn('mt-[3px] shrink-0 text-text-muted transition-transform', expanded && 'rotate-90')} />
                    <span className="mt-[5px]">
                      <StatusDot tone={tone} pulse={false} />
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-text-muted">{clock(e.ts)}</span>
                    <span className="w-20 shrink-0 truncate font-mono text-[10.5px] uppercase leading-[18px] text-text-muted">{l.filters[logKind(e)]}</span>
                    <span className="min-w-0 flex-1 font-sans text-text-secondary">{text}</span>
                  </button>
                  {expanded && (
                    <dl className="mb-1.5 ml-8 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-md border border-hud/50 bg-surface/40 px-3 py-2 font-mono text-[11px]">
                      <dt className="text-text-muted">{l.type}</dt>
                      <dd className="text-text-secondary">{e.type}</dd>
                      <dt className="text-text-muted">{l.time}</dt>
                      <dd className="text-text-secondary">{new Date(e.ts).toLocaleString(intlLocale())}</dd>
                      <dt className="text-text-muted">{l.actor}</dt>
                      <dd className="text-text-secondary">{e.actor.id ? `${e.actor.kind} · ${e.actor.id}` : e.actor.kind}</dd>
                      {e.projectId && (
                        <>
                          <dt className="text-text-muted">{l.project}</dt>
                          <dd className="truncate text-text-secondary">{e.projectId}</dd>
                        </>
                      )}
                      <dt className="text-text-muted">{l.details}</dt>
                      <dd>
                        <pre className="whitespace-pre-wrap break-all text-text-secondary">{JSON.stringify(e.payload ?? {}, null, 2)}</pre>
                      </dd>
                    </dl>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </Panel>
  )
}
