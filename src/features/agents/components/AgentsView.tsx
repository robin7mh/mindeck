import { useEffect, useMemo, useState } from 'react'
import { PanelRightOpen, Plus, TerminalSquare, Trash2 } from 'lucide-react'
import type { AgentSession } from '@shared/types/agents'
import { Panel } from '@/components/ui/Panel'
import { TechLabel } from '@/components/ui/TechLabel'
import { StatusDot } from '@/components/ui/StatusDot'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useProjects } from '@/features/projects/store'
import { useAssistant } from '../store'
import { useActiveSession, useAgents } from '../sessions'
import { relativeTime } from '../format'
import { ActivityTimeline } from './ActivityTimeline'
import { AssistantPane, iconFor } from './AssistantPane'
import { NewChatDialog } from './NewChatDialog'
import { AGENT_NAMES, SessionPane } from './SessionPane'
import { DiffModal, HideSideButton, SessionSide } from './SessionSide'

type Entry =
  | { kind: 'session'; id: string; title: string; sub: string; updatedAt: string; session: AgentSession }
  | { kind: 'chat'; id: string; title: string; sub: string; updatedAt: string; agentId: string; running: boolean }

const DOT: Record<AgentSession['status'], { tone: 'cyan' | 'warn' | 'ok' | 'muted' | 'error'; pulse: boolean }> = {
  starting: { tone: 'muted', pulse: true },
  working: { tone: 'cyan', pulse: true },
  approval: { tone: 'warn', pulse: true },
  waiting: { tone: 'warn', pulse: false },
  idle: { tone: 'ok', pulse: false },
  ended: { tone: 'muted', pulse: false },
  error: { tone: 'error', pulse: false }
}

const SIDE_KEY = 'mindeck.agents.side'

/** Whether the column beside the chat shows — a per-device choice; storage can be unavailable, so never throw. */
function readSide(): boolean {
  try {
    return localStorage.getItem(SIDE_KEY) !== '0'
  } catch {
    return true
  }
}

function writeSide(open: boolean): void {
  try {
    localStorage.setItem(SIDE_KEY, open ? '1' : '0')
  } catch {
    /* the choice just won't be remembered */
  }
}

/**
 * The Agents module — a cockpit for the coding agents the user already has
 * (Claude Code runs on their own plan) next to Mindeck's own assistant: one
 * list of chats, the open one in the middle, its changes, plan and memory
 * (or the activity) beside it — a column that folds away. Everything starts
 * with "New chat".
 */
export function AgentsView({ onOpenNote, onOpenSettings }: { onOpenNote: (path: string) => void; onOpenSettings: () => void }) {
  const t = useT()
  const ag = useAgents()
  const a = useAssistant()
  const { session, messages } = useActiveSession()
  const loadProjects = useProjects((s) => s.load)
  const [confirm, setConfirm] = useState<string>()
  const [side, setSide] = useState(readSide)
  const toggleSide = () => {
    writeSide(!side)
    setSide(!side)
  }

  useEffect(() => {
    void loadProjects()
    return useAgents.getState().connect()
  }, [loadProjects])

  const entries = useMemo<Entry[]>(
    () =>
      [
        ...ag.sessions.map((s): Entry => {
          // Renamed: the agent goes into the second line, so it stays recognisable.
          const sub = s.title === AGENT_NAMES[s.kind] ? s.projectName : `${AGENT_NAMES[s.kind]} · ${s.projectName}`
          return { kind: 'session', id: s.id, title: s.title, sub, updatedAt: s.updatedAt, session: s }
        }),
        ...a.conversations.map(
          (c): Entry => ({ kind: 'chat', id: c.id, title: c.title, sub: t.agents.assistant, updatedAt: c.updatedAt, agentId: c.agentId, running: !!a.running[c.id] })
        )
      ].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)),
    [ag.sessions, a.conversations, a.running, t]
  )
  const activity = useMemo(() => (a.activeId ? a.activity.filter((e) => e.conversationId === a.activeId) : a.activity), [a.activity, a.activeId])
  const isActive = (e: Entry) => (e.kind === 'session' ? ag.view === 'session' && ag.activeId === e.id : ag.view === 'assistant' && a.activeId === e.id)

  const openEntry = (e: Entry) => {
    if (e.kind === 'session') return void ag.open(e.id)
    ag.showAssistant()
    void a.open(e.id)
  }
  const removeEntry = (e: Entry) => {
    setConfirm(undefined)
    if (e.kind === 'session') void ag.remove(e.id)
    else void a.remove(e.id)
  }

  return (
    <Panel title={t.agents.title} corners flush className="min-h-0 flex-1" bodyClassName="flex min-h-0">
      {/* left: every chat */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-hud/50">
        <div className="border-b border-hud/50 p-2.5">
          <button
            type="button"
            onClick={() => ag.openDialog()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-cyan/40 bg-cyan/6 px-2.5 py-1.5 font-sans text-[12px] font-medium text-cyan hover:bg-cyan/12"
          >
            <Plus size={14} /> {t.agents.newChat}
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
          {entries.length === 0 && <p className="px-2 py-3 font-mono text-[11px] text-text-muted">{t.agents.noChats}</p>}
          {entries.map((e) => {
            const Icon = e.kind === 'session' ? TerminalSquare : iconFor(e.agentId)
            const active = isActive(e)
            const dot = e.kind === 'session' ? DOT[e.session.status] : e.running ? DOT.working : undefined
            return (
              <div key={`${e.kind}:${e.id}`} className={cn('group flex items-center gap-2 rounded-md px-2 py-1.5', active ? 'bg-cyan/8' : 'hover:bg-elevated/50')}>
                <button type="button" onClick={() => openEntry(e)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <Icon size={13} className={cn('shrink-0', active ? 'text-cyan' : 'text-text-muted')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-sans text-[12.5px] text-text-primary">{e.title}</span>
                    <span className="block truncate font-mono text-[10px] text-text-muted">
                      {e.sub} · {relativeTime(e.updatedAt)}
                    </span>
                  </span>
                  {dot && <StatusDot tone={dot.tone} pulse={dot.pulse} />}
                </button>
                {confirm === e.id ? (
                  <button type="button" onClick={() => removeEntry(e)} className="shrink-0 rounded-sm border border-danger/50 px-1.5 font-sans text-[10.5px] text-danger">
                    {t.agents.delete}
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={t.agents.deleteItem(e.title)}
                    title={e.kind === 'session' && e.session.worktree ? t.agents.deletesFolder : undefined}
                    onClick={() => setConfirm(e.id)}
                    className="shrink-0 text-text-muted opacity-0 hover:text-danger group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </aside>

      {/* center */}
      {ag.view === 'session' && session ? (
        <SessionPane session={session} messages={messages} />
      ) : ag.view === 'assistant' ? (
        <AssistantPane onOpenSettings={onOpenSettings} />
      ) : (
        <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <TerminalSquare size={30} className="text-cyan/70" />
          <p className="font-sans text-[15px] font-semibold text-text-primary">{t.agents.emptyTitle}</p>
          <p className="max-w-md font-sans text-[13px] text-text-secondary">
            {t.agents.emptyText}
          </p>
          <button
            type="button"
            onClick={() => ag.openDialog()}
            className="flex items-center gap-1.5 rounded-md border border-cyan/50 bg-cyan/[0.1] px-3 py-1.5 font-sans text-[12px] font-medium text-cyan hover:bg-cyan/16"
          >
            <Plus size={14} /> {t.agents.newChat}
          </button>
        </section>
      )}

      {/* right: folded away, a narrow strip to bring it back */}
      {!side ? (
        <aside className="hidden w-10 shrink-0 flex-col items-center border-l border-hud/50 pt-2 pane-xl:flex">
          <button
            type="button"
            aria-label={t.agents.showSide}
            title={t.agents.showSide}
            onClick={toggleSide}
            className="rounded-sm p-1.5 text-text-muted hover:bg-elevated hover:text-text-primary"
          >
            <PanelRightOpen size={15} />
          </button>
        </aside>
      ) : ag.view === 'session' && session ? (
        <SessionSide session={session} onOpenNote={onOpenNote} onHide={toggleSide} />
      ) : (
        <aside className="hidden w-72 shrink-0 flex-col border-l border-hud/50 pane-xl:flex">
          <div className="flex h-10 items-center border-b border-hud/50 pl-3 pr-2">
            <TechLabel className="text-text-secondary">{ag.view === 'assistant' && a.activeId ? t.agents.runActivity : t.agents.allActivity}</TechLabel>
            <HideSideButton onHide={toggleSide} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            <ActivityTimeline events={ag.view === 'assistant' ? activity : a.activity} empty={t.agents.nothingYet} />
          </div>
        </aside>
      )}

      {ag.dialog && <NewChatDialog prompt={ag.dialog.prompt} onOpenSettings={onOpenSettings} />}
      <DiffModal />
    </Panel>
  )
}
