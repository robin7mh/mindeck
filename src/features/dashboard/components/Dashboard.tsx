import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowUp, ArrowUpRight, BrainCircuit, Cpu, FolderGit2, GitBranch, Sparkles } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import type { Project } from '@shared/types/project'
import type { NoteMeta } from '@shared/types/memory'
import type { ModuleId } from '@/types'
import { NAV_ITEMS } from '@/data/navigation'
import { cn } from '@/lib/cn'
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

/**
 * Core: the personal HUD. Greeting, date and a calm clock, plus three tiles
 * with real data only — projects (live git state), the brain (vault), and a
 * one-line system verdict. Everything links into its module.
 */
export function Dashboard({ onNavigate }: { onNavigate: (id: ModuleId) => void }) {
  const t = useT()
  const now = useClock()
  const [firstName, setFirstName] = useState<string>()

  useEffect(() => {
    ipc('system:user')
      .then((u) => setFirstName(u.firstName))
      .catch(() => {})
  }, [])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto rounded-lg">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-7 px-6 py-10 pane-md:px-10">
        <header className="flex flex-col gap-1.5">
          <p className="font-sans text-[13px] text-text-muted">
            {longDate(now)}
            <span className="mx-2">·</span>
            {t.dashboard.week} {isoWeek(now)}
          </p>
          <h1 className="font-sans text-[32px] font-semibold leading-[1.15] tracking-[-0.025em] text-text-primary">
            {greeting(now, t)}
            {firstName && <span>, {firstName}</span>}
          </h1>
        </header>

        <div className="flex flex-col gap-3">
          <AskBar onNavigate={onNavigate} />
          <QuickLinks onNavigate={onNavigate} />
        </div>

        <div className="grid w-full grid-cols-1 gap-4 pane-md:grid-cols-3">
          <ProjectsTile onNavigate={onNavigate} />
          <BrainTile onNavigate={onNavigate} />
          <SystemTile />
        </div>
      </div>
    </div>
  )
}

/** Shortcuts into the modules used most, as quiet chips under the composer. */
function QuickLinks({ onNavigate }: { onNavigate: (id: ModuleId) => void }) {
  const t = useT()
  const links = (['projects', 'editor', 'terminal', 'memory'] as const).map((id) => NAV_ITEMS.find((i) => i.id === id)!)
  return (
    <div className="flex flex-wrap gap-2">
      {links.map(({ id, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onNavigate(id)}
          className="flex h-8 items-center gap-2 rounded-full border border-hud/45 px-3 font-sans text-[13px] text-text-secondary transition-colors hover:bg-elevated hover:text-text-primary"
        >
          <Icon size={14} strokeWidth={1.75} className="text-text-muted" />
          {t.nav[id]}
        </button>
      ))}
    </div>
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
      className="rounded-xl border border-hud/60 bg-panel px-4 pb-2.5 pt-3.5 shadow-panel transition-colors focus-within:border-hud-strong/80"
    >
      <input
        aria-label={t.dashboard.askLabel}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t.dashboard.ask}
        className="w-full bg-transparent px-0.5 font-sans text-[15px] leading-[1.55] text-text-primary outline-hidden placeholder:text-text-muted"
      />
      <div className="mt-3 flex items-center gap-2">
        <span className="flex items-center gap-1.5 font-sans text-[12.5px] text-text-muted">
          <Sparkles size={14} strokeWidth={1.75} />
          Mindeck Assistant
        </span>
        <span className="flex-1" />
        <span className="hidden font-sans text-[12px] text-text-muted sm:inline">↵</span>
        <button
          type="submit"
          aria-label={t.dashboard.askSubmit}
          disabled={!text.trim()}
          className="flex h-[34px] w-[34px] items-center justify-center rounded-md bg-cyan text-void transition-opacity disabled:opacity-30"
        >
          <ArrowUp size={16} strokeWidth={2.2} />
        </button>
      </div>
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
    <section className="group flex min-h-[170px] flex-col rounded-lg border border-hud/45 bg-panel p-5">
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

function ProjectsTile({ onNavigate }: { onNavigate: (id: ModuleId) => void }) {
  const t = useT()
  const [projects, setProjects] = useState<Project[]>()

  // Cached list first, then a live git refresh (git state is never trusted from cache).
  useEffect(() => {
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
  }, [])

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

function BrainTile({ onNavigate }: { onNavigate: (id: ModuleId) => void }) {
  const t = useT()
  const [state, setState] = useState<{ exists: boolean; notes: NoteMeta[]; links: number }>()

  useEffect(() => {
    let alive = true
    Promise.all([ipc('memory:status'), ipc('memory:list'), ipc('memory:graph')])
      .then(([status, notes, graph]) => {
        if (alive) setState({ exists: status.exists, notes, links: graph.edges.length })
      })
      .catch(() => alive && setState({ exists: false, notes: [], links: 0 }))
    return () => {
      alive = false
    }
  }, [])

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

function SystemTile() {
  const t = useT()
  const { metrics: m, battery, live } = useSystemMetrics()

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
    <Tile icon={Cpu} title={t.dashboard.system}>
      {!live ? (
        <p className="font-sans text-[13px] text-text-muted">{t.dashboard.loading}</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <StatusDot tone={warnings.length ? 'warn' : 'ok'} pulse={warnings.length > 0} />
            <span className="font-sans text-[14px] font-medium text-text-primary">{warnings[0] ?? t.dashboard.allGood}</span>
          </div>
          {warnings.length > 1 && (
            <p className="mt-1 font-sans text-[12px] text-amber">{warnings.slice(1).join(' · ')}</p>
          )}
          <div className="mt-auto flex flex-col gap-3 pt-4">
            {stats.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-sans text-[12.5px] text-text-secondary">
                    {label}
                    {label === t.dashboard.battery && battery.charging ? ' ⚡' : ''}
                  </span>
                  <span className="font-mono text-[12px] text-text-primary tabular-nums">{Math.round(value)} %</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-elevated">
                  <div
                    className={cn('h-full rounded-full', value > 85 ? 'bg-amber' : 'bg-cyan')}
                    style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Tile>
  )
}
