import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Ban, BookOpen, BookText, ChevronRight, FileText, Folder, Globe, Image, Loader2, PencilLine, TerminalSquare, User, Wrench, type LucideIcon } from 'lucide-react'
import type { ApprovalDecision, ChatMessage, MessageAttachment, PermissionRequest, ToolCallPart } from '@shared/types/ai'
import { Markdown } from '@/components/ui/Markdown'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useAssistant } from '../store'
import { ApprovalCard } from './ApprovalCard'

/** While an answer streams, its Markdown renders at most this often (each render parses all of it). */
export const STREAM_RENDER_MS = 100

/** `value`, but while `on` at most every STREAM_RENDER_MS — the last value always comes through. */
function useThrottled(value: string, on: boolean): string {
  const [shown, setShown] = useState(value)
  const at = useRef(0)
  useEffect(() => {
    if (!on) return
    const show = () => {
      at.current = Date.now()
      setShown(value)
    }
    const wait = at.current + STREAM_RENDER_MS - Date.now()
    if (wait <= 0) return show()
    const timer = window.setTimeout(show, wait)
    return () => window.clearTimeout(timer)
  }, [value, on])
  return on ? shown : value
}

function Prose({ text, streaming }: { text: string; streaming: boolean }) {
  return <Markdown text={useThrottled(text, streaming)} className="chat-prose" />
}

/** What changes as an answer grows — cheap to compute on every render (no JSON of tool outputs). */
const partSize = (part: ChatMessage['parts'][number] | undefined) => (!part ? '' : part.type === 'text' ? part.text.length : `${part.status}:${part.output?.length ?? 0}`)

const ATTACHMENT_ICON: Record<MessageAttachment['kind'], LucideIcon> = { file: FileText, folder: Folder, note: BookText, tab: Globe, image: Image }

const STATUS_TONE: Record<ToolCallPart['status'], string> = {
  pending: 'text-text-muted',
  'awaiting-approval': 'text-amber',
  running: 'text-cyan',
  done: 'text-green',
  error: 'text-danger',
  denied: 'text-amber'
}

function toolIcon(part: ToolCallPart) {
  if (part.server) return Globe
  if (part.risk === 'execute') return TerminalSquare
  if (part.risk === 'write') return PencilLine
  return /^(memory|mcp__mindeck__)/.test(part.name) ? BookOpen : Wrench
}

/** A failure the app can explain in its own words (the trial's credit doesn't renew, a license's does). */
function aiError(t: ReturnType<typeof useT>, message: ChatMessage, trial: boolean): string | undefined {
  const code = message.errorCode === 'ai-credit-exhausted' && trial ? 'ai-credit-exhausted-trial' : message.errorCode
  return code ? t.agents.aiErrors[code as keyof typeof t.agents.aiErrors] : undefined
}

/** Short one-line view of the tool input (the full JSON is one click away). */
export function inputPreview(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const key = ['command', 'file_path', 'notebook_path', 'query', 'pattern', 'path', 'title', 'url', 'dir', 'folder', 'description', 'projectId'].find((k) => typeof o[k] === 'string')
  return key ? String(o[key]) : ''
}

function ToolCard({ part, request, onRespond }: { part: ToolCallPart; request?: PermissionRequest; onRespond: (id: string, d: ApprovalDecision) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const Icon = toolIcon(part)
  const preview = inputPreview(part.input)
  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md border border-hud/60 bg-elevated/30 px-2.5 py-1.5 text-left hover:border-cyan/40"
      >
        <ChevronRight size={12} className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-90')} />
        <Icon size={13} className="shrink-0 text-cyan" />
        <span className="shrink-0 font-sans text-[12px] font-medium text-text-primary">{part.title}</span>
        {preview && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-muted">{preview}</span>}
        <span className={cn('ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wider', STATUS_TONE[part.status])}>
          {part.status === 'running' && <Loader2 size={10} className="animate-spin" />}
          {t.agents.toolStatus[part.status]}
        </span>
      </button>
      {open && (
        <div className="mt-1 space-y-1.5 rounded-md border border-hud/40 bg-surface/60 p-2">
          <TechLabel className="text-text-muted">{t.agents.input}</TechLabel>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-[11px] text-text-secondary">
            {JSON.stringify(part.input, null, 2)}
          </pre>
          {part.output !== undefined && (
            <>
              <TechLabel className="text-text-muted">{t.agents.result}</TechLabel>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-[11px] text-text-secondary">{part.output}</pre>
            </>
          )}
        </div>
      )}
      {part.status === 'awaiting-approval' && request && (
        <div className="mt-1.5">
          <ApprovalCard request={request} onRespond={(d) => onRespond(request.id, d)} />
        </div>
      )}
    </div>
  )
}

function Message({
  message,
  pending,
  onRespond
}: {
  message: ChatMessage
  pending: PermissionRequest[]
  onRespond: (id: string, d: ApprovalDecision) => void
}) {
  const t = useT()
  const trial = useAssistant((st) => st.status?.cloud?.credit.period === 'trial')
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg border border-cyan/30 bg-cyan/[0.07] px-3 py-2">
          <div className="mb-0.5 flex items-center gap-1.5">
            <User size={11} className="text-cyan" />
            <TechLabel className="text-text-muted">{t.agents.you}</TechLabel>
          </div>
          {text && <p className="whitespace-pre-wrap wrap-break-word font-sans text-[13px] text-text-primary">{text}</p>}
          {message.attachments && (
            <ul aria-label={t.agents.attached} className="mt-1 flex flex-wrap gap-1">
              {message.attachments.map((a, i) => {
                const Icon = ATTACHMENT_ICON[a.kind]
                return (
                  <li key={i} className="flex max-w-[220px] items-center gap-1 rounded-sm border border-cyan/25 px-1.5 py-0.5 font-mono text-[10.5px] text-text-secondary">
                    <Icon size={10} className="shrink-0 text-cyan" />
                    <span className="truncate">{a.label}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    )
  }
  const empty = message.parts.length === 0
  return (
    // aria-busy: a screen reader reads the answer once it is complete, not every streamed piece.
    <div className="max-w-full" aria-busy={message.status === 'streaming'}>
      {message.parts.map((part, i) =>
        part.type === 'text' ? (
          <Prose key={i} text={part.text} streaming={message.status === 'streaming' && i === message.parts.length - 1} />
        ) : (
          <ToolCard key={part.id} part={part} request={pending.find((p) => p.id === part.requestId)} onRespond={onRespond} />
        )
      )}
      {message.status === 'streaming' && empty && (
        <p className="flex items-center gap-2 font-mono text-[11px] text-text-muted">
          <Loader2 size={12} className="animate-spin text-cyan" /> {t.agents.thinking}
        </p>
      )}
      {message.status === 'streaming' && !empty && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-cyan/70 align-middle" />}
      {message.status === 'error' && (
        <p className="mt-1 flex items-start gap-1.5 font-mono text-[11px] text-danger">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {aiError(t, message, trial) || message.error || t.agents.runFailed}
        </p>
      )}
      {message.status === 'cancelled' && (
        <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-amber">
          <Ban size={12} /> {t.agents.stopped}
        </p>
      )}
      {message.status !== 'streaming' && message.model && (
        <p className="mt-1 font-mono text-[10px] text-text-muted">
          {message.model}
          {message.usage ? t.agents.tokens(message.usage.inputTokens, message.usage.outputTokens) : ''}
        </p>
      )}
    </div>
  )
}

export function ChatThread({
  messages,
  pending,
  onRespond,
  conversationId
}: {
  messages: ChatMessage[]
  pending: PermissionRequest[]
  onRespond: (id: string, d: ApprovalDecision) => void
  /** Show this conversation's approvals that belong to no tool card (a Mindeck tool's own gate) at the end. */
  conversationId?: string
}) {
  const end = useRef<HTMLDivElement>(null)
  const attached = new Set(messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'tool' && p.requestId ? [p.requestId] : []))))
  const loose = conversationId ? pending.filter((p) => p.conversationId === conversationId && !attached.has(p.id)) : []
  const last = messages[messages.length - 1]
  const signature = `${messages.length}:${last?.parts.length ?? 0}:${last?.status ?? ''}:${partSize(last?.parts.at(-1))}`
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [signature])

  return (
    // A log: new answers are announced (politely) to screen readers.
    <div role="log" aria-live="polite" className="space-y-4 px-4 py-4">
      {messages.map((m) => (
        <Message key={m.id} message={m} pending={pending} onRespond={onRespond} />
      ))}
      {loose.map((req) => (
        <ApprovalCard key={req.id} request={req} onRespond={(d) => onRespond(req.id, d)} />
      ))}
      <div ref={end} />
    </div>
  )
}
