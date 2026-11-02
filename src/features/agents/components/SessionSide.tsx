import { lazy, Suspense, useEffect, useState } from 'react'
import { ArrowDownToLine, BookOpen, Check, CircleDot, FileDiff, GitMerge, Loader2, PanelRightClose, RefreshCw, Trash2, X } from 'lucide-react'
import type { AgentSession } from '@shared/types/agents'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useProjects } from '@/features/projects/store'
import { useAgents } from '../sessions'

// Monaco's diff editor — loaded only when a diff is opened.
const DiffView = lazy(() => import('@/features/editor/components/DiffView'))

type Tab = 'changes' | 'plan' | 'memory'

/** Before → after for one file, over the whole module. */
export function DiffModal() {
  const t = useT()
  const diff = useAgents((s) => s.diff)
  if (!diff) return null
  return (
    <div role="dialog" aria-label={t.agents.changesIn(diff.path)} className="fixed inset-0 z-50 flex items-center justify-center bg-void/70 p-6 backdrop-blur-xs">
      <div className="panel flex h-full max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hud/60 px-3">
          <FileDiff size={14} className="text-cyan" />
          <span className="truncate font-mono text-[12px] text-text-primary">{diff.path}</span>
          <span className="font-mono text-[10.5px] text-text-muted">{t.agents.beforeAfter}</span>
          <button type="button" aria-label={t.agents.closeDiff} onClick={() => useAgents.getState().closeDiff()} className="ml-auto text-text-muted hover:text-text-primary">
            <X size={15} />
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          <Suspense fallback={<p className="p-4 font-mono text-[11px] text-text-muted">{t.agents.loadingDiff}</p>}>
            <DiffView path={diff.path} original={diff.original} modified={diff.modified} />
          </Suspense>
        </div>
      </div>
    </div>
  )
}

/** Folds the column beside the chat away (the Agents module remembers it). */
export function HideSideButton({ onHide }: { onHide: () => void }) {
  const t = useT()
  return (
    <button type="button" aria-label={t.agents.hideSide} title={t.agents.hideSide} onClick={onHide} className="ml-auto shrink-0 rounded-sm p-1 text-text-muted hover:bg-elevated hover:text-text-primary">
      <PanelRightClose size={14} />
    </button>
  )
}

/** A home-relative path for display: /Users/me/Mindeck/… → ~/Mindeck/… */
const tilde = (path: string) => path.replace(/^(\/Users|\/home)\/[^/]+(?=\/)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\)/, '~')

/** "Throw it all away?" — discard or keep. */
function ConfirmDiscard({ onDiscard, onKeep }: { onDiscard: () => void; onKeep: () => void }) {
  const t = useT()
  return (
    <div className="space-y-1.5">
      <p className="font-sans text-[11.5px] text-text-secondary">{t.agents.discardConfirm}</p>
      <div className="flex gap-1.5">
        <button type="button" onClick={onDiscard} className="flex-1 rounded-md border border-danger/50 px-2 py-1 font-sans text-[11.5px] text-danger hover:bg-danger/10">
          {t.agents.discard}
        </button>
        <button type="button" onClick={onKeep} className="flex-1 rounded-md border border-hud/60 px-2 py-1 font-sans text-[11.5px] text-text-secondary">
          {t.agents.keep}
        </button>
      </div>
    </div>
  )
}

/**
 * Beside the chat: what the session changed (with diffs; take over or throw
 * away an own working folder — or, once its pull request is merged, update
 * the project and clean up), its plan, and the memory it used.
 */
export function SessionSide({ session, onOpenNote, onHide }: { session: AgentSession; onOpenNote: (path: string) => void; onHide: () => void }) {
  const t = useT()
  const changes = useAgents((s) => s.changes[session.id])
  const branch = useAgents((s) => s.branches[session.id])
  const busy = useAgents((s) => s.busy)
  const [tab, setTab] = useState<Tab>('changes')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [pulled, setPulled] = useState<{ sessionId: string; error?: string }>()
  const { showDiff, accept, discard } = useAgents.getState()
  const isolated = !!session.worktree
  const merged = isolated && !!branch?.merged
  const pullResult = pulled?.sessionId === session.id ? pulled : undefined

  const reload = () => {
    const { loadChanges, loadBranch } = useAgents.getState()
    void loadChanges(session.id)
    if (isolated) void loadBranch(session.id)
  }

  // Fresh after every step the agent finishes, when you come back to the window
  // (say, from merging the pull request on GitHub), and once a minute.
  useEffect(() => {
    reload()
    window.addEventListener('focus', reload)
    const timer = window.setInterval(reload, 60_000)
    return () => {
      window.removeEventListener('focus', reload)
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is recreated each render; these say when to load again
  }, [session.id, session.status, isolated])

  // The merged work into the project: `git pull` there, no terminal needed.
  const updateProject = async () => {
    setPulling(true)
    const error = await useProjects.getState().pull(session.projectId)
    setPulling(false)
    setPulled({ sessionId: session.id, error })
  }

  const tabs: [Tab, string, number][] = [
    ['changes', t.agents.changes, changes?.length ?? 0],
    ['plan', t.agents.plan, session.plan.filter((p) => !p.done).length],
    ['memory', t.agents.memory, session.notes.length]
  ]

  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-hud/50 pane-xl:flex">
      <div role="tablist" className="flex h-10 shrink-0 items-center gap-1 border-b border-hud/50 px-2">
        {tabs.map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn('rounded-sm px-2 py-1 font-sans text-[11.5px] font-medium', tab === id ? 'bg-cyan/10 text-cyan' : 'text-text-muted hover:text-text-secondary')}
          >
            {label}
            {count > 0 && <span className="ml-1 font-mono text-[10px]">{count}</span>}
          </button>
        ))}
        <HideSideButton onHide={onHide} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tab === 'changes' && (
          <div className="space-y-1">
            <div className="flex items-center justify-between px-1">
              <TechLabel className="text-text-muted">{session.worktree ? t.agents.inOwnFolder : t.agents.sinceStart}</TechLabel>
              <button type="button" aria-label={t.agents.refreshChanges} onClick={reload} className="text-text-muted hover:text-cyan">
                <RefreshCw size={12} />
              </button>
            </div>
            {session.worktree && (
              <p className="px-1 pb-1 font-sans text-[10.5px] leading-relaxed text-text-muted">
                {t.agents.copyIn} <span className="font-mono text-text-secondary">{tilde(session.worktree)}</span>
                {t.agents.onBranch} <span className="font-mono text-text-secondary">{session.branch}</span>{' '}
                {branch?.pr ? (
                  <a href={branch.pr.url} target="_blank" rel="noreferrer" className="text-cyan hover:underline">
                    {t.agents.pr(branch.pr.number, t.agents.prStates[branch.pr.state])}
                  </a>
                ) : branch?.pushed ? (
                  t.agents.onGithub
                ) : (
                  t.agents.notOnGithub
                )}
              </p>
            )}
            {merged && (
              <div className="mb-1 space-y-2 rounded-md border border-green/40 bg-green/6 p-2">
                <p className="flex items-center gap-1.5 font-sans text-[12px] font-medium text-green">
                  <GitMerge size={13} /> {t.agents.mergedTitle}
                </p>
                <p className="font-sans text-[11px] leading-relaxed text-text-secondary">{t.agents.mergedHint}</p>
                {branch!.uncommitted > 0 && <p className="font-sans text-[11px] text-amber">{t.agents.uncommittedLost(branch!.uncommitted)}</p>}
                {confirmDiscard ? (
                  <ConfirmDiscard onDiscard={() => void discard()} onKeep={() => setConfirmDiscard(false)} />
                ) : (
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={pulling}
                      onClick={() => void updateProject()}
                      className="flex flex-1 items-center justify-center gap-1 rounded-md border border-green/50 bg-green/8 px-2 py-1 font-sans text-[11.5px] text-green hover:bg-green/15 disabled:opacity-40"
                    >
                      {pulling ? <Loader2 size={12} className="animate-spin" /> : <ArrowDownToLine size={12} />} {t.agents.updateProject}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => (branch!.uncommitted > 0 ? setConfirmDiscard(true) : void discard())}
                      className="flex items-center gap-1 rounded-md border border-hud/60 px-2 py-1 font-sans text-[11.5px] text-text-secondary hover:border-danger/50 hover:text-danger disabled:opacity-40"
                    >
                      <Trash2 size={12} /> {t.agents.cleanUp}
                    </button>
                  </div>
                )}
                {pullResult && (
                  <p className={cn('font-sans text-[11px]', pullResult.error ? 'text-danger' : 'text-green')}>{pullResult.error ?? t.agents.projectUpdated}</p>
                )}
              </div>
            )}
            {!changes?.length && <p className="px-1 py-2 font-mono text-[11px] text-text-muted">{t.agents.noChanges}</p>}
            {changes?.map((c) => (
              <button
                key={c.path}
                type="button"
                onClick={() => void showDiff(c.path)}
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-elevated/50"
              >
                <span className={cn('font-mono text-[10px] font-semibold', c.status === 'added' ? 'text-green' : c.status === 'deleted' ? 'text-danger' : 'text-amber')}>
                  {c.status === 'added' ? 'A' : c.status === 'deleted' ? 'D' : 'M'}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-secondary">{c.path}</span>
                <span className="font-mono text-[10px] text-text-muted">
                  +{c.added} −{c.removed}
                </span>
              </button>
            ))}
            {isolated && !merged && !!changes?.length && (
              <div className="mt-3 space-y-1.5 border-t border-hud/50 pt-2">
                {confirmDiscard ? (
                  <ConfirmDiscard onDiscard={() => void discard()} onKeep={() => setConfirmDiscard(false)} />
                ) : (
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void accept()}
                      className="flex flex-1 items-center justify-center gap-1 rounded-md border border-cyan/50 bg-cyan/8 px-2 py-1 font-sans text-[11.5px] text-cyan hover:bg-cyan/15 disabled:opacity-40"
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <GitMerge size={12} />} {t.agents.takeOver}
                    </button>
                    <button
                      type="button"
                      aria-label={t.agents.discardChanges}
                      onClick={() => setConfirmDiscard(true)}
                      className="rounded-md border border-hud/60 px-2 py-1 text-text-muted hover:border-danger/50 hover:text-danger"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
                <p className="font-sans text-[10.5px] leading-relaxed text-text-muted">
                  {t.agents.takeOverHint}
                </p>
              </div>
            )}
          </div>
        )}

        {tab === 'plan' &&
          (session.plan.length ? (
            <ul className="space-y-1">
              {session.plan.map((p) => (
                <li key={p.id} className="flex items-start gap-2 px-1 py-0.5 font-sans text-[12px]">
                  {p.done ? <Check size={13} className="mt-0.5 shrink-0 text-green" /> : <CircleDot size={13} className="mt-0.5 shrink-0 text-text-muted" />}
                  <span className={p.done ? 'text-text-muted line-through' : 'text-text-secondary'}>{p.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-1 py-2 font-mono text-[11px] text-text-muted">{t.agents.noPlan}</p>
          ))}

        {tab === 'memory' && (
          <div className="space-y-1">
            {session.journal && (
              <button type="button" onClick={() => onOpenNote(session.journal!)} className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-elevated/50">
                <BookOpen size={12} className="shrink-0 text-cyan" />
                <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-text-primary">{t.agents.journal}</span>
              </button>
            )}
            {session.notes.map((n) => (
              <button key={n} type="button" onClick={() => onOpenNote(n)} className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-elevated/50">
                <BookOpen size={12} className="shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">{n}</span>
              </button>
            ))}
            {!session.journal && !session.notes.length && (
              <p className="px-1 py-2 font-mono text-[11px] text-text-muted">
                {t.agents.noNotes}
              </p>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
