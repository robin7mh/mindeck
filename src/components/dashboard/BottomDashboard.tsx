import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronUp, LayoutGrid, ShieldAlert, Square } from 'lucide-react'
import { TechLabel } from '@/components/ui/TechLabel'
import { StatusDot } from '@/components/ui/StatusDot'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useAssistant } from '@/features/agents/store'
import { useAgents } from '@/features/agents/sessions'
import { STATUS_TONE } from '@/features/agents/components/SessionPane'
import { ActivityTimeline } from '@/features/agents/components/ActivityTimeline'

const STORAGE_KEY = 'mindeck.commandDeck.open'

/** Per-viewer UI preference; storage can be unavailable, so never throw. */
function readOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, open ? '1' : '0')
  } catch {
    /* preference just won't persist */
  }
}

/**
 * Collapsible Command Deck (P9): which agents are running (with stop), what
 * waits for approval, and the live activity stream. Collapsed by default so
 * the bottom of the shell stays calm; the header still shows live counts.
 * Open, it floats over the workspace — the panes underneath keep their size.
 */
export function BottomDashboard({
  onOpenConversation,
  onOpenSession
}: {
  onOpenConversation?: (id: string) => void
  onOpenSession?: (id: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(readOpen)
  const sessions = useAgents((s) => s.sessions)
  const live = sessions.filter((s) => s.live)
  const needYou = live.filter((s) => s.status === 'approval' || s.status === 'waiting').length
  const conversations = useAssistant((s) => s.conversations)
  const runningMap = useAssistant((s) => s.running)
  const pending = useAssistant((s) => s.pending)
  const allActivity = useAssistant((s) => s.activity)
  // The deck shows outcomes; step-by-step status stays in the Agents view.
  const activity = allActivity.filter((e) => e.type !== 'agent.status.updated')
  const running = conversations.filter((c) => runningMap[c.id])

  const toggle = () => {
    const next = !open
    setOpen(next)
    writeOpen(next)
  }

  return (
    <section className="relative flex shrink-0 flex-col border-t border-hud/70 bg-surface/40 backdrop-blur-xs">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group flex h-8 items-center gap-2 px-3 text-left"
      >
        <LayoutGrid size={13} className="text-cyan" />
        <TechLabel className="text-text-secondary group-hover:text-text-primary">{t.deck.title}</TechLabel>
        {running.length + live.length > 0 && (
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-cyan">
            <StatusDot tone="cyan" /> {t.deck.running(running.length + live.length)}
          </span>
        )}
        {needYou > 0 && <span className="font-mono text-[10px] text-amber">{t.deck.needYou(needYou)}</span>}
        {pending.length > 0 && (
          <span className="flex items-center gap-1 font-mono text-[10px] text-amber">
            <ShieldAlert size={11} /> {t.deck.waiting(pending.length)}
          </span>
        )}
        <ChevronUp
          size={14}
          className={cn(
            'ml-auto text-text-muted transition-transform group-hover:text-cyan',
            !open && 'rotate-180'
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          // A dialog to the workspace: over the browser's page, the page shows as a still picture.
          <motion.div
            role="dialog"
            aria-label={t.deck.title}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-x-2.5 bottom-full z-40 rounded-t-lg border border-b-0 border-hud/70 bg-panel/95 shadow-2xl shadow-black/50 backdrop-blur-md"
          >
            <div className="grid h-40 grid-cols-1 gap-2 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <div className="min-h-0 overflow-y-auto rounded-md border border-hud/50 bg-surface/40 p-2">
                <TechLabel className="text-text-muted">{t.deck.agents}</TechLabel>
                {running.length + live.length === 0 ? (
                  <p className="mt-2 font-mono text-[11px] text-text-muted">{t.deck.noneRunning}</p>
                ) : (
                  <ul className="mt-1.5 space-y-1">
                    {live.map((s) => (
                      <li key={s.id} className="flex items-center gap-2">
                        <StatusDot tone={s.status === 'approval' || s.status === 'waiting' ? 'warn' : 'cyan'} />
                        <button
                          type="button"
                          onClick={() => onOpenSession?.(s.id)}
                          className="min-w-0 flex-1 truncate text-left font-sans text-[12px] text-text-primary hover:text-cyan"
                        >
                          {s.title} <span className={cn('font-mono text-[10px]', STATUS_TONE[s.status])}>· {t.agents.status[s.status]}</span>
                        </button>
                        <button
                          type="button"
                          aria-label={t.deck.end(s.title)}
                          onClick={() => void useAgents.getState().stop(s.id)}
                          className="text-amber hover:text-danger"
                        >
                          <Square size={11} fill="currentColor" />
                        </button>
                      </li>
                    ))}
                    {running.map((c) => (
                      <li key={c.id} className="flex items-center gap-2">
                        <StatusDot tone="cyan" />
                        <button
                          type="button"
                          onClick={() => onOpenConversation?.(c.id)}
                          className="min-w-0 flex-1 truncate text-left font-sans text-[12px] text-text-primary hover:text-cyan"
                        >
                          {c.title}
                        </button>
                        <button
                          type="button"
                          aria-label={t.deck.stop(c.title)}
                          onClick={() => void useAssistant.getState().stop(c.id)}
                          className="text-amber hover:text-danger"
                        >
                          <Square size={11} fill="currentColor" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {pending.length > 0 && (
                  <p className="mt-2 font-mono text-[11px] text-amber">{t.deck.actionsWait(pending.length)}</p>
                )}
              </div>
              <div className="min-h-0 overflow-y-auto rounded-md border border-hud/50 bg-surface/40 p-1.5">
                <ActivityTimeline events={activity} compact max={30} empty={t.deck.noActivity} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
