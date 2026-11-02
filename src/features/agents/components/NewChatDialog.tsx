import { useEffect, useState, type FormEvent } from 'react'
import { Check, Cpu, FolderGit2, GitBranch, Loader2, SlidersHorizontal, Sparkles, TerminalSquare, X } from 'lucide-react'
import type { AgentAvailability, AgentKind } from '@shared/types/agents'
import { CLAUDE_MODELS, CLAUDE_MODES } from '@shared/types/claude'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { Select } from '@/components/ui/Select'
import { useT } from '@/lib/i18n'
import { useProjects } from '@/features/projects/store'
import { useAssistant } from '../store'
import { useAgents } from '../sessions'

type Choice = AgentKind | 'assistant'

function AgentCard({ a, chosen, onPick }: { a: AgentAvailability; chosen: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      disabled={!a.ready}
      aria-pressed={chosen}
      onClick={onPick}
      className={cn(
        'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        chosen ? 'border-cyan/60 bg-cyan/8' : 'border-hud/60 hover:border-cyan/40'
      )}
    >
      <span className="flex items-center gap-1.5 font-sans text-[13px] font-semibold text-text-primary">
        <TerminalSquare size={13} className="text-cyan" /> {a.name}
        {a.ready && <Check size={12} className="text-green" />}
      </span>
      <span className="font-mono text-[10.5px] text-text-muted">
        {a.ready ? [a.account, a.version && `v${a.version}`].filter(Boolean).join(' · ') : a.hint}
      </span>
    </button>
  )
}

/**
 * "New chat": which agent (the user's own coding agents, or the Mindeck
 * Assistant when an API key is set), which project, optionally an own git
 * worktree for parallel work, and the first message. Mounted while open.
 */
export function NewChatDialog({ prompt: initialPrompt = '', onOpenSettings }: { prompt?: string; onOpenSettings: () => void }) {
  const t = useT()
  const { availability, detecting, busy, error, closeDialog, create, sessions } = useAgents()
  const assistantReady = !!useAssistant((s) => s.status?.configured)
  const projects = useProjects((s) => s.projects)
  const [choice, setChoice] = useState<Choice>()
  const [projectId, setProjectId] = useState(() => useProjects.getState().selectedId ?? projects[0]?.id ?? '')
  const [isolated, setIsolated] = useState(false)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [model, setModel] = useState('default')
  const [mode, setMode] = useState('default')

  // Default to the first agent that is ready (else the assistant).
  useEffect(() => {
    if (choice) return
    const ready = availability.find((a) => a.ready)
    if (ready) setChoice(ready.kind)
    else if (assistantReady && !detecting) setChoice('assistant')
  }, [availability, assistantReady, detecting, choice])

  // Another agent already works in this project: suggest an own working folder.
  const busyProject = sessions.some((s) => s.projectId === projectId && s.live && !s.isolated)
  useEffect(() => setIsolated(busyProject), [busyProject])

  const isAgent = choice !== undefined && choice !== 'assistant'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (choice === 'assistant') {
      closeDialog()
      useAgents.getState().showAssistant()
      const a = useAssistant.getState()
      a.newChat('assistant')
      a.setProject(projectId || undefined)
      if (prompt.trim()) await a.send(prompt)
      return
    }
    if (!choice || !projectId) return
    const claude = choice === 'claude-code' ? { model, mode } : {}
    await create({ kind: choice, projectId, isolated, prompt: prompt.trim() || undefined, ...claude })
  }

  return (
    <div role="dialog" aria-label={t.agents.newChat} className="fixed inset-0 z-50 flex items-center justify-center bg-void/70 p-4 backdrop-blur-xs" onKeyDown={(e) => e.key === 'Escape' && closeDialog()}>
      <form onSubmit={(e) => void submit(e)} className="panel flex w-full max-w-xl flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <TechLabel className="text-text-secondary">{t.agents.newChat}</TechLabel>
          <button type="button" aria-label={t.common.close} onClick={closeDialog} className="text-text-muted hover:text-text-primary">
            <X size={15} />
          </button>
        </div>

        <div className="space-y-1.5">
          <TechLabel className="text-text-muted">{t.agents.agent}</TechLabel>
          {detecting && !availability.length ? (
            <p className="flex items-center gap-2 font-mono text-[11px] text-text-muted">
              <Loader2 size={12} className="animate-spin" /> {t.agents.looking}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {availability.map((a) => (
                <AgentCard key={a.kind} a={a} chosen={choice === a.kind} onPick={() => setChoice(a.kind)} />
              ))}
              <button
                type="button"
                disabled={!assistantReady}
                aria-pressed={choice === 'assistant'}
                onClick={() => setChoice('assistant')}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  choice === 'assistant' ? 'border-cyan/60 bg-cyan/8' : 'border-hud/60 hover:border-cyan/40'
                )}
              >
                <span className="flex items-center gap-1.5 font-sans text-[13px] font-semibold text-text-primary">
                  <Sparkles size={13} className="text-cyan" /> {t.agents.assistant}
                </span>
                <span className="font-mono text-[10.5px] text-text-muted">{assistantReady ? t.agents.apiKey : t.agents.needsKey}</span>
              </button>
            </div>
          )}
          {!assistantReady && (
            <button type="button" onClick={onOpenSettings} className="font-sans text-[11.5px] text-cyan hover:underline">
              {t.agents.keysInSettings}
            </button>
          )}
        </div>

        <div className="space-y-1.5">
          <TechLabel className="text-text-muted">{t.agents.project}</TechLabel>
          <Select
            label={t.agents.project}
            icon={FolderGit2}
            value={projectId}
            onChange={setProjectId}
            options={[...(choice === 'assistant' ? [{ value: '', label: t.agents.noProject }] : []), ...projects.map((p) => ({ value: p.id, label: p.name, hint: p.path }))]}
          />
          {!projects.length && <span className="block font-sans text-[11.5px] text-text-muted">{t.agents.addProjectFirst}</span>}
        </div>

        {isAgent && (
          <label className="flex items-start gap-2">
            <input type="checkbox" aria-label={t.agents.ownFolder} checked={isolated} onChange={(e) => setIsolated(e.target.checked)} className="mt-0.5 accent-cyan" />
            <span>
              <span className="flex items-center gap-1.5 font-sans text-[12.5px] text-text-primary">
                <GitBranch size={12} /> {t.agents.ownFolder}
              </span>
              <span className="block font-sans text-[11.5px] text-text-muted">
                {t.agents.ownFolderHint(busyProject)}
              </span>
            </span>
          </label>
        )}

        {choice === 'claude-code' && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <TechLabel className="text-text-muted">{t.agents.model}</TechLabel>
              <Select
                label={t.agents.model}
                icon={Cpu}
                value={model}
                onChange={setModel}
                options={CLAUDE_MODELS.map((o) => ({ value: o.id, label: o.id === 'default' ? t.agents.defaultModel : o.name }))}
              />
            </div>
            <div className="space-y-1.5">
              <TechLabel className="text-text-muted">{t.agents.mode}</TechLabel>
              <Select
                label={t.agents.mode}
                icon={SlidersHorizontal}
                value={mode}
                onChange={setMode}
                options={CLAUDE_MODES.map((o) => ({ value: o.id, label: t.agents.claudeModes[o.id], hint: t.agents.claudeModeHints[o.id] }))}
              />
            </div>
          </div>
        )}

        <textarea
          aria-label={t.agents.firstMessage}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder={t.agents.whatToDo}
          className="w-full resize-none rounded-md border border-hud/60 bg-surface/50 px-2.5 py-2 font-sans text-[13px] text-text-primary outline-hidden placeholder:text-text-muted/70 focus:border-cyan/50"
        />

        {error && <p className="font-mono text-[11px] text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={closeDialog} className="rounded-md border border-hud/60 px-3 py-1.5 font-sans text-[12px] text-text-secondary hover:text-text-primary">
            {t.common.cancel}
          </button>
          <button
            type="submit"
            disabled={!choice || busy || (isAgent && !projectId)}
            className="flex items-center gap-1.5 rounded-md border border-cyan/50 bg-cyan/[0.1] px-3 py-1.5 font-sans text-[12px] font-medium text-cyan hover:bg-cyan/16 disabled:opacity-40"
          >
            {busy && <Loader2 size={13} className="animate-spin" />} {t.agents.start}
          </button>
        </div>
      </form>
    </div>
  )
}
