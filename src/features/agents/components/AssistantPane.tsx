import { AlertTriangle, Bot, Code2, Globe, MessageSquare, Sparkles, X } from 'lucide-react'
import type { AgentInfo } from '@shared/types/ai'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useProjects } from '@/features/projects/store'
import { useActiveMessages, useAssistant } from '../store'
import { ChatThread } from './ChatThread'
import { Composer } from './Composer'

const AGENT_ICON: Record<string, typeof Bot> = { assistant: Sparkles, coding: Code2, research: Globe, chat: MessageSquare }
export const iconFor = (id: string) => AGENT_ICON[id] ?? Bot

/** A built-in persona in the UI language (the core sends English). */
export function persona(a: AgentInfo, t: ReturnType<typeof useT>): { name: string; description: string } {
  return t.agents.personas[a.id] ?? a
}

function AgentPicker({ agents, value, onPick }: { agents: AgentInfo[]; value: string; onPick: (id: string) => void }) {
  const t = useT()
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {agents.map((a) => {
        const Icon = iconFor(a.id)
        return (
          <button
            key={a.id}
            type="button"
            title={persona(a, t).description}
            aria-pressed={a.id === value}
            onClick={() => onPick(a.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left font-sans text-[12px] transition-colors',
              a.id === value ? 'border-cyan/50 bg-cyan/8 text-cyan' : 'border-hud/60 text-text-secondary hover:border-cyan/40 hover:text-text-primary'
            )}
          >
            <Icon size={13} className="shrink-0" />
            <span className="truncate">{persona(a, t).name}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * A Mindeck Assistant chat (Mindeck's own agent runtime on the user's API key):
 * built-in personas, tool calls inline, approvals where they happen.
 */
export function AssistantPane({ onOpenSettings }: { onOpenSettings: () => void }) {
  const t = useT()
  const a = useAssistant()
  const messages = useActiveMessages()
  const projects = useProjects((s) => s.projects)
  const active = a.conversations.find((c) => c.id === a.activeId)
  const agentId = active?.agentId ?? a.agentId
  const found = a.agents.find((x) => x.id === agentId)
  const agent = found && persona(found, t)
  const running = !!(a.activeId && a.running[a.activeId])
  const Icon = iconFor(agentId)

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hud/50 px-4">
        <Icon size={14} className="shrink-0 text-cyan" />
        <span className="truncate font-sans text-[13px] font-semibold text-text-primary">{active ? active.title : t.agents.newChatWith(agent?.name ?? t.agents.assistantName)}</span>
        {a.status?.model && (
          <span className="ml-auto hidden font-mono text-[10px] text-text-muted md:inline">
            {t.agents.assistant} · {a.status.model} · {a.status.settings.effort}
          </span>
        )}
      </div>

      {a.error && (
        <div className="flex items-start gap-2 border-b border-danger/30 bg-danger/6 px-3 py-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 font-mono text-[11px] text-text-secondary">{a.error}</span>
          <button type="button" aria-label={t.common.dismiss} onClick={a.clearError} className="text-text-muted hover:text-text-primary">
            <X size={12} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
            <Icon size={28} className="text-cyan/70" />
            <p className="font-sans text-[15px] font-semibold text-text-primary">{agent?.name ?? t.agents.assistantName}</p>
            <p className="font-sans text-[13px] text-text-secondary">{agent?.description}</p>
            {!active && a.agents.length > 1 && <AgentPicker agents={a.agents} value={a.agentId} onPick={(id) => a.newChat(id)} />}
            {a.status && !a.status.configured && (
              <button type="button" onClick={onOpenSettings} className="font-sans text-[12px] text-cyan hover:underline">
                {t.agents.addKey}
              </button>
            )}
          </div>
        ) : (
          <ChatThread messages={messages} pending={a.pending} onRespond={(id, d) => void a.respond(id, d)} />
        )}
      </div>
      <Composer
        running={running}
        sending={a.sending}
        disabled={!a.status?.configured}
        projects={projects}
        projectId={a.projectId}
        placeholder={t.agents.messageTo(agent?.name ?? t.agents.theAssistant)}
        onProject={a.setProject}
        onSend={a.send}
        onStop={() => void a.cancel()}
      />
    </section>
  )
}
