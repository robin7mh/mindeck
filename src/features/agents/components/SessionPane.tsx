import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Cpu, FolderGit2, GitBranch, Play, Power, SlidersHorizontal, Square, TerminalSquare, X } from 'lucide-react'
import type { ChatMessage } from '@shared/types/ai'
import type { AgentSession, SessionOption, SessionStatus } from '@shared/types/agents'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { repoLink } from '@/lib/repo'
import { useXterm } from '@/features/terminal/useXterm'
import { useAssistant } from '../store'
import { useAgents } from '../sessions'
import { ChatThread } from './ChatThread'
import { Composer } from './Composer'

export const AGENT_NAMES: Record<AgentSession['kind'], string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }

/** Text color per session status; the words are `t.agents.status[status]`. */
export const STATUS_TONE: Record<SessionStatus, string> = {
  starting: 'text-text-muted',
  working: 'text-cyan',
  approval: 'text-amber',
  waiting: 'text-amber',
  idle: 'text-green',
  ended: 'text-text-muted',
  error: 'text-danger'
}

/** The agent's own terminal — for whatever it only shows there (sign-in, trust prompt, /commands). */
function SessionTerminal({ id, ended }: { id: string; ended: string }) {
  const host = useRef<HTMLDivElement>(null)
  const { termRef, fitRef } = useXterm(host, id, false, {
    onExit: () => `\r\n\x1b[90m[${ended}]\x1b[0m\r\n`
  })
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* not measurable yet */
      }
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [fitRef, termRef])
  return (
    <div className="min-h-0 flex-1 px-3 py-2">
      <div ref={host} className="h-full w-full" />
    </div>
  )
}

/**
 * The session's model and mode, as the agent offers them. Claude Code's
 * model aliases and permission modes read in the UI language; its mode
 * changes from its next start (it is a start option).
 */
function SessionControls({ session }: { session: AgentSession }) {
  const t = useT()
  const configure = useAgents((s) => s.configure)
  const claude = session.kind === 'claude-code'
  const modelLabel = (o: SessionOption) => (claude && o.id === 'default' ? t.agents.defaultModel : o.name)
  const modeLabel = (o: SessionOption) => (claude ? t.agents.claudeModes[o.id] : o.name)
  return (
    <>
      {!!session.models?.length && (
        <Select
          variant="quiet"
          icon={Cpu}
          label={t.agents.model}
          value={session.model ?? ''}
          placeholder={t.agents.defaultModel}
          options={session.models.map((o) => ({ value: o.id, label: modelLabel(o), hint: o.description }))}
          onChange={(model) => void configure({ model })}
        />
      )}
      {!!session.modes?.length && (
        <Select
          variant="quiet"
          icon={SlidersHorizontal}
          label={t.agents.mode}
          value={session.mode ?? ''}
          placeholder={t.agents.defaultMode}
          options={session.modes.map((o) => ({ value: o.id, label: modeLabel(o), hint: claude && session.live ? t.agents.fromNextStart : o.description }))}
          onChange={(mode) => void configure({ mode })}
        />
      )}
    </>
  )
}

/** The session's name: click to edit, Enter or leaving the field saves, Esc cancels. */
function TitleInput({ title, onRename }: { title: string; onRename: (title: string) => void }) {
  const t = useT()
  const [value, setValue] = useState(title)
  const commit = () => (value.trim() && value.trim() !== title ? onRename(value.trim()) : setValue(title))
  return (
    <input
      aria-label={t.agents.sessionName}
      value={value}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setValue(title)
          e.currentTarget.blur()
        }
      }}
      title={t.agents.rename}
      spellCheck={false}
      style={{ width: `${Math.max(value.length, 4) + 2}ch` }}
      className="-mx-1 min-w-0 max-w-[40%] truncate rounded-sm bg-transparent px-1 font-sans text-[13px] font-semibold text-text-primary outline-hidden transition-colors hover:bg-elevated/50 focus:bg-elevated/70 focus:ring-1 focus:ring-cyan/40"
    />
  )
}

/**
 * How long a start may take before its terminal opens by itself: by then the
 * agent most likely asks something there (trusting a new folder). A normal
 * start or resume is ready in about a second.
 */
const START_GRACE_MS = 3000

const iconButton =
  'flex h-7 items-center gap-1 rounded-md border border-hud/60 px-2 font-sans text-[11.5px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'

/**
 * One coding agent session as a chat: the user's messages, the agent's answers
 * and tool cards with approvals inline. Its real terminal is one click away —
 * and opens by itself while the agent waits for input only it can show.
 */
export function SessionPane({ session, messages }: { session: AgentSession; messages: ChatMessage[] }) {
  const t = useT()
  const pending = useAssistant((s) => s.pending)
  const respond = useAssistant((s) => s.respond)
  const error = useAgents((s) => s.error)
  const [terminal, setTerminal] = useState(false)
  // ACP agents (Codex, Gemini) have no terminal: theirs is a shell in the session's folder.
  const [shell, setShell] = useState<{ sessionId: string; terminalId: string }>()
  const name = AGENT_NAMES[session.kind]
  const running = session.live
  const busy = session.status === 'working' || session.status === 'approval'
  // Claude Code runs in a PTY the user can watch; its prompts there open it by themselves.
  const agentTerminal = session.terminalId
  const shellId = shell?.sessionId === session.id ? shell.terminalId : undefined
  // A start opens it only once it takes longer than usual — so a resume doesn't flash up an empty terminal.
  const [slowStart, setSlowStart] = useState<string>()
  useEffect(() => {
    if (!agentTerminal || session.status !== 'starting') return
    const timer = window.setTimeout(() => setSlowStart(agentTerminal), START_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [agentTerminal, session.status])
  const needsTerminal = !!agentTerminal && (session.status === 'waiting' || (session.status === 'starting' && slowStart === agentTerminal))
  const shownId = agentTerminal ? (terminal || needsTerminal ? agentTerminal : undefined) : terminal ? shellId : undefined
  const showTerminal = !!shownId
  const repo = session.repoUrl ? repoLink(session.repoUrl) : undefined
  const { send, interrupt, stop, resume, clearError, rename, openShell } = useAgents.getState()

  const toggleTerminal = async () => {
    if (showTerminal) return setTerminal(false)
    if (!agentTerminal) {
      const terminalId = await openShell(session.id)
      if (!terminalId) return
      setShell({ sessionId: session.id, terminalId })
    }
    setTerminal(true)
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hud/50 px-4">
        <TerminalSquare size={14} className="shrink-0 text-cyan" />
        <TitleInput key={`${session.id}:${session.title}`} title={session.title} onRename={(title) => void rename(session.id, title)} />
        <span className="hidden items-center gap-1 font-mono text-[10.5px] text-text-muted lg:flex">
          <FolderGit2 size={11} /> {session.projectName}
          {session.branch && (
            <>
              <GitBranch size={11} className="ml-1" /> {session.branch}
            </>
          )}
        </span>
        <span className={cn('font-mono text-[10.5px]', STATUS_TONE[session.status])}>· {t.agents.status[session.status]}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {repo && (
            <a href={session.repoUrl} target="_blank" rel="noreferrer" className={iconButton} title={t.agents.openUrl(session.repoUrl!)}>
              <repo.Icon size={12} /> {repo.label}
            </a>
          )}
          <button
            type="button"
            className={iconButton}
            aria-label={showTerminal ? t.agents.hideTerminal : t.agents.showTerminal}
            title={agentTerminal ? t.agents.agentTerminal(name) : t.agents.sessionShell}
            onClick={() => void toggleTerminal()}
          >
            {showTerminal ? <ChevronDown size={12} /> : <ChevronUp size={12} />} {t.agents.terminal}
          </button>
          {running && busy && (
            <button type="button" className={iconButton} aria-label={t.agents.interrupt} title={t.agents.interruptTitle} onClick={() => void interrupt()}>
              <Square size={11} /> {t.agents.interrupt}
            </button>
          )}
          {running ? (
            <button type="button" className={iconButton} aria-label={t.agents.endSession} onClick={() => void stop(session.id)}>
              <Power size={12} /> {t.agents.end}
            </button>
          ) : (
            <button type="button" className={iconButton} aria-label={t.agents.resume} onClick={() => void resume(session.id)}>
              <Play size={12} /> {t.agents.resume}
            </button>
          )}
        </div>
      </div>

      {session.status === 'starting' && (
        <p className="border-b border-hud/50 bg-elevated/40 px-4 py-1.5 font-sans text-[12px] text-text-secondary">
          {t.agents.isStarting(name, !!agentTerminal)}
        </p>
      )}
      {(session.error || error) && (
        <div className="flex items-start gap-2 border-b border-danger/30 bg-danger/6 px-3 py-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 font-mono text-[11px] text-text-secondary">{error ?? session.error}</span>
          {error && (
            <button type="button" aria-label={t.common.dismiss} onClick={clearError} className="text-text-muted hover:text-text-primary">
              <X size={12} />
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <TerminalSquare size={26} className="text-cyan/70" />
            <p className="font-sans text-[14px] font-semibold text-text-primary">
              {name} · {session.projectName}
            </p>
            <p className="max-w-md font-sans text-[12.5px] text-text-secondary">
              {t.agents.ownSignIn(name)}
            </p>
          </div>
        ) : (
          <ChatThread
            messages={messages}
            pending={pending.filter((p) => p.conversationId === session.id)}
            conversationId={session.id}
            onRespond={(id, d) => void respond(id, d)}
          />
        )}
      </div>

      {shownId && (
        <div className="flex h-[42%] min-h-[160px] shrink-0 flex-col border-t border-hud/60 bg-void/40">
          <SessionTerminal key={shownId} id={shownId} ended={shownId === agentTerminal ? t.agents.agentEnded : t.agents.shellEnded} />
        </div>
      )}

      <Composer
        key={session.id}
        running={running && busy}
        sending={false}
        disabled={!running}
        placeholder={running ? t.agents.messageTo(name) : t.agents.resumeToContinue}
        agent={{ sessionId: session.id, projectId: session.projectId, commands: session.commands ?? [], images: !!session.images }}
        toolbar={<SessionControls session={session} />}
        onSend={send}
        onStop={() => void interrupt()}
      />
    </section>
  )
}
