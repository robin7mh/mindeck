import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowUp, ArrowUpRight, BrainCircuit, Cpu, FolderGit2, GitBranch, Sparkles } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import type { Project } from '@shared/types/project'
import type { NoteMeta } from '@shared/types/memory'
import type { ModuleId } from '@/types'
import { Panel } from '@/components/ui/Panel'
import { StatusDot } from '@/components/ui/StatusDot'
import { useClock } from '@/hooks/useClock'
import { useProjects } from '@/features/projects/store'
import { useSystemMetrics } from '@/features/system/useSystemMetrics'
import { useAssistant } from '@/features/agents/store'
import { useAgents } from '@/features/agents/sessions'
import { folderColors } from '@/features/memory/store'
import { slotColor } from '@/features/memory/components/GraphView'
import { useT } from '@/lib/i18n'
import { greeting, isoWeek, longDate } from '../i18n'
import { HudClock } from './HudClock'

/** The user's first name, once known: the greeting has it from its first frame on. */
let knownName: string | undefined

/**
 * Core: the personal HUD. Greeting, date and a calm clock, plus three tiles
 * with real data only — projects (live git state), the brain (vault), and a
 * one-line system verdict. Everything links into its module. It stays mounted
 * off screen (`active` false): the clock and the system stream rest, and the
 * tiles bring themselves up to date in place when it is back — nothing loads
 * or moves again.
 */
export function Dashboard({ onNavigate, active = true }: { onNavigate: (id: ModuleId) => void; active?: boolean }) {
  const t = useT()
  const now = useClock(active)
  const [firstName, setFirstName] = useState(knownName)

  useEffect(() => {
    ipc('system:user')
      .then((u) => setFirstName((knownName = u.firstName)))
      .catch(() => {})
  }, [])

  return (
    <Panel title={t.dashboard.panel} className="min-h-0 flex-1" bodyClassName="flex min-h-0 flex-col overflow-y-auto">
      <div className="flex min-h-full flex-col items-center justify-between gap-8 px-6 py-8">
        <header className="text-center">
          <h1 className="font-sans text-[34px] font-semibold leading-[1.15] tracking-[-0.025em] text-text-primary">
            {greeting(now, t)}
            {firstName && <span className="text-cyan">, {firstName}</span>}
          </h1>
          <p className="mt-2 font-sans text-[14px] text-text-secondary">
            {longDate(now)}
            <span className="mx-2 text-text-muted">·</span>
            <span className="text-text-muted">
              {t.dashboard.week} {isoWeek(now)}
            </span>
          </p>
        </header>

        <div>
          <HudClock now={now} />
        </div>

        <div className="w-full max-w-2xl">
          <AskBar onNavigate={onNavigate} />
        </div>

        <div className="grid w-full max-w-5xl grid-cols-1 gap-4 pane-md:grid-cols-3">
          <ProjectsTile onNavigate={onNavigate} active={active} />
          <BrainTile onNavigate={onNavigate} active={active} />
          <SystemTile onNavigate={onNavigate} active={active} />
        </div>
      </div>
    </Panel>
  )
}

/** One line to the assistant: starts a new chat and opens the Agents module. */
function AskBar({ onNavigate }: { onNavigate: (id: ModuleId) => void }) {
  const t = useT()
  const [text, setText] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const question = text.trim()
    if (!question) return
    const a = useAssistant.getState()
    setText('')
    onNavigate('agents')
    // With an API key the Mindeck Assistant answers right away; otherwise pick an agent (e.g. Claude Code).
    if (!a.status?.configured) return useAgents.getState().openDialog(question)
    useAgents.getState().showAssistant()
    a.newChat('assistant')
    void a.send(question)
  }
  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-3 rounded-xl border border-hud/60 bg-surface py-2 pl-4 pr-2 shadow-panel transition-colors focus-within:border-hud-strong/80"
    >
      <Sparkles size={16} strokeWidth={1.75} className="shrink-0 text-text-muted" />
      <input
        aria-label={t.dashboard.askLabel}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t.dashboard.ask}
        className="min-w-0 flex-1 bg-transparent font-sans text-[15px] text-text-primary outline-hidden placeholder:text-text-muted"
      />
      <button
        type="submit"
        aria-label={t.dashboard.askSubmit}
        disabled={!text.trim()}
        className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md bg-cyan text-void transition-opacity disabled:opacity-30"
      >
        <ArrowUp size={16} strokeWidth={2.2} />
      </button>
    </form>
  )
}

function Tile({
  icon: Icon,
  title,
  onOpen,
  children
}: {
  icon: typeof Cpu
  title: string
  onOpen?: () => void
  children: React.ReactNode
}) {
  const t = useT()
  return (
    // As tall as a tile with its data (three projects) while it loads: the row doesn't grow when the data comes.
    <section className="group flex min-h-[243px] flex-col rounded-lg border border-hud/45 bg-surface p-5">
      <header className="mb-4 flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-elevated text-text-secondary">
          <Icon size={15} strokeWidth={1.75} />
        </span>
        <h2 className="font-sans text-[14px] font-semibold text-text-primary">{title}</h2>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={t.dashboard.open(title)}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-elevated hover:text-text-primary"
          >
            <ArrowUpRight size={15} strokeWidth={1.75} />
          </button>
        )}
      </header>
      {children}
    </section>
  )
}

function BigNumber({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-sans text-[28px] font-semibold leading-none tracking-[-0.02em] text-text-primary tabular-nums">{value}</span>
      <span className="font-sans text-[13px] text-text-secondary">{label}</span>
    </div>
  )
}

function ProjectsTile({ onNavigate, active }: { onNavigate: (id: ModuleId) => void; active: boolean }) {
  const t = useT()
  const [projects, setProjects] = useState<Project[]>()

  // Cached list first, then a live git refresh (git state is never trusted from cache) — again each time Core is back.
  useEffect(() => {
    if (!active) return
    let alive = true
    ipc('projects:list')
      .then(async (list) => {
        if (!alive) return
        setProjects(list)
        const fresh = await Promise.all(list.map((p) => ipc('projects:refresh', { id: p.id }).catch(() => p)))
        if (alive) setProjects(fresh)
      })
      .catch(() => alive && setProjects([]))
    return () => {
      alive = false
    }
  }, [active])

  const open = (id?: string) => {
    if (id) useProjects.getState().select(id)
    onNavigate('projects')
  }

  const dirty = projects?.filter((p) => p.git?.dirty).length ?? 0

  return (
    <Tile icon={FolderGit2} title={t.dashboard.projects} onOpen={() => open()}>
      {!projects ? (
        <p className="font-sans text-[13px] text-text-muted">{t.dashboard.loading}</p>
      ) : projects.length === 0 ? (
        <button type="button" onClick={() => open()} className="text-left font-sans text-[13px] text-text-secondary hover:text-text-primary">
          {t.dashboard.noProjects} — {t.dashboard.addProject} →
        </button>
      ) : (
        <>
          <BigNumber value={projects.length} label={dirty ? `${dirty} ${t.dashboard.changed}` : t.dashboard.allClean} />
          <ul className="mt-4 flex flex-col">
            {projects.slice(0, 3).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => open(p.id)}
                  className="-mx-2 flex w-[calc(100%+16px)] items-center gap-2.5 rounded-sm border-t border-hud/35 px-2 py-2 text-left transition-colors hover:bg-elevated/60"
                >
                  <StatusDot tone={!p.git?.isRepo ? 'muted' : p.git.dirty ? 'warn' : 'ok'} pulse={false} />
                  <span className="min-w-0 flex-1 truncate font-sans text-[13.5px] font-medium text-text-primary">{p.name}</span>
                  {p.git?.branch && (
                    <span className="flex items-center gap-1 font-mono text-[11.5px] text-text-muted">
                      <GitBranch size={12} strokeWidth={1.75} />
                      {p.git.branch}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Tile>
  )
}

function BrainTile({ onNavigate, active }: { onNavigate: (id: ModuleId) => void; active: boolean }) {
  const t = useT()
  const [state, setState] = useState<{ exists: boolean; notes: NoteMeta[]; links: number }>()

  // Again each time Core is back (notes written meanwhile).
  useEffect(() => {
    if (!active) return
    let alive = true
    Promise.all([ipc('memory:status'), ipc('memory:list'), ipc('memory:graph')])
      .then(([status, notes, graph]) => {
        if (alive) setState({ exists: status.exists, notes, links: graph.edges.length })
      })
      .catch(() => alive && setState({ exists: false, notes: [], links: 0 }))
    return () => {
      alive = false
    }
  }, [active])

  const slots = useMemo(() => folderColors(state?.notes ?? []), [state])
  const folders = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of state?.notes ?? []) if (n.folder) counts.set(n.folder, (counts.get(n.folder) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  }, [state])

  return (
    <Tile icon={BrainCircuit} title={t.dashboard.brain} onOpen={() => onNavigate('memory')}>
      {!state ? (
        <p className="font-sans text-[13px] text-text-muted">{t.dashboard.loading}</p>
      ) : !state.exists ? (
        <button type="button" onClick={() => onNavigate('memory')} className="text-left font-sans text-[13px] text-text-secondary hover:text-text-primary">
          {t.dashboard.noVault} — {t.dashboard.setUp} →
        </button>
      ) : (
        <>
          <BigNumber value={state.notes.length} label={`${t.dashboard.notes} · ${state.links} ${t.dashboard.links}`} />
          <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2">
            {folders.map(([folder, count]) => (
              <span key={folder} className="flex items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: slotColor(slots.get(folder)!) }} />
                <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-text-secondary">{folder}</span>
                <span className="font-sans text-[12px] text-text-muted tabular-nums">{count}</span>
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onNavigate('memory')}
            className="mt-auto self-start pt-4 font-sans text-[13px] text-text-secondary transition-colors hover:text-text-primary"
          >
            {t.dashboard.openGraph} →
          </button>
        </>
      )}
    </Tile>
  )
}

function SystemTile({ onNavigate, active }: { onNavigate: (id: ModuleId) => void; active: boolean }) {
  const t = useT()
  const { metrics: m, battery, live } = useSystemMetrics(active)

  const warnings = [
    m.cpu.value > 85 && t.dashboard.cpuHigh,
    m.ram.value > 90 && t.dashboard.ramHigh,
    m.disk.value > 90 && t.dashboard.diskHigh,
    battery.hasBattery && !battery.charging && m.battery.value < 20 && t.dashboard.batteryLow
  ].filter(Boolean) as string[]

  const stats: [string, number][] = [
    ['CPU', m.cpu.value],
    ['RAM', m.ram.value],
    [t.dashboard.disk, m.disk.value],
    ...(battery.hasBattery ? [[t.dashboard.battery, m.battery.value] as [string, number]] : [])
  ]

  return (
    <Tile icon={Cpu} title={t.dashboard.system} onOpen={() => onNavigate('system')}>
      {!live ? (
        <p className="font-sans text-[13px] text-text-muted">{t.dashboard.loading}</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <StatusDot tone="cyan" pulse={warnings.length > 0} />
            <span className="font-sans text-[14px] font-medium text-text-primary">{warnings[0] ?? t.dashboard.allGood}</span>
          </div>
          {warnings.length > 1 && (
            <p className="mt-1 font-sans text-[12px] text-cyan">{warnings.slice(1).join(' · ')}</p>
          )}
          <div className="mt-auto grid grid-cols-2 gap-x-6 gap-y-4 pt-5">
            {stats.map(([label, value]) => {
              const isBattery = label === t.dashboard.battery
              return (
                <div key={label} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-sans text-[12.5px] text-text-secondary">
                      {label}
                      {isBattery && battery.charging ? ' ⚡' : ''}
                    </span>
                    <span className="font-sans text-[15px] font-semibold tracking-[-0.01em] text-text-primary tabular-nums">
                      {Math.round(value)}
                      <span className="ml-0.5 text-[11.5px] font-normal text-text-muted">%</span>
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-elevated">
                    <div
                      className="h-full rounded-full bg-cyan transition-[width] duration-500"
                      style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </Tile>
  )
}
