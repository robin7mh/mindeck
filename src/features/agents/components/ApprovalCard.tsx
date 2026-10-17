import { Fragment, useState } from 'react'
import { ShieldAlert, TerminalSquare, PencilLine, Check, CheckCheck, X, AlertTriangle } from 'lucide-react'
import type { ApprovalDecision, PermissionRequest } from '@shared/types/ai'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'

/**
 * Characters that change what a command looks like without being seen: C0/C1
 * controls (but tab and newline), bidi overrides and isolates, zero-width
 * characters, line separators, soft hyphens, Unicode tag characters.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/gu

/** How many such characters a text holds. */
export const countInvisible = (text: string): number => text.match(INVISIBLE)?.length ?? 0

/** The text with every invisible character as a visible `⟨U+202E⟩` mark. */
export function revealInvisible(text: string) {
  const parts = text.split(new RegExp(`(${INVISIBLE.source})`, 'u'))
  return parts.map((part, i) =>
    i % 2 ? (
      <mark key={i} className="rounded-xs bg-amber/25 px-px text-amber">{`⟨U+${part.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`}</mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  )
}

/** Toasts and the browser dock show a short version — never silently: it says how much more there is. */
const PREVIEW_LINES = 2
const PREVIEW_CHARS = 160
function preview(text: string): string | null {
  const head = text.split('\n').slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS)
  return head.length < text.length ? head : null
}

/**
 * The permission prompt (architecture §9): which agent, which tool, exactly
 * what will happen and why. Commands never get "Always allow".
 */
export function ApprovalCard({
  request,
  onRespond,
  compact = false
}: {
  request: PermissionRequest
  onRespond: (decision: ApprovalDecision) => void
  compact?: boolean
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const execute = request.risk === 'execute'
  const Icon = execute ? TerminalSquare : PencilLine
  const short = compact && !expanded ? preview(request.summary) : null
  const invisible = countInvisible(request.summary)
  const toggle = 'mt-1 font-sans text-[11px] text-cyan hover:underline'
  const btn = 'flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-sans text-[12px] font-medium transition-colors'
  return (
    <div
      role="alertdialog"
      aria-label={t.agents.approve(request.toolTitle)}
      className={cn(
        'rounded-md border bg-surface/90 p-3 backdrop-blur-sm',
        execute ? 'border-amber/60' : 'border-cyan/50'
      )}
    >
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} className="shrink-0 text-amber" />
        <TechLabel className="text-text-secondary">
          {t.agents.wantsTo(request.agentName, execute)}
        </TechLabel>
      </div>
      <div className="mt-2 flex items-start gap-2">
        <Icon size={14} className="mt-0.5 shrink-0 text-cyan" />
        <div className="min-w-0">
          {/* The whole text, line breaks and runs of spaces as they are: what is approved is what is seen. */}
          <p className="max-h-60 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-[12px] text-text-primary">
            {revealInvisible(short ?? request.summary)}
            {short !== null && '…'}
          </p>
          {short !== null && (
            <button type="button" onClick={() => setExpanded(true)} className={toggle}>
              {t.agents.showWhole(execute, request.summary.length - short.length)}
            </button>
          )}
          {compact && expanded && (
            <button type="button" onClick={() => setExpanded(false)} className={toggle}>
              {t.agents.showLess}
            </button>
          )}
          {invisible > 0 && (
            <p role="note" className="mt-1 flex items-center gap-1 font-sans text-[11px] text-amber">
              <AlertTriangle size={11} className="shrink-0" /> {t.agents.invisibleChars(invisible)}
            </p>
          )}
          {request.reason && <p className="mt-1 font-sans text-[12px] text-text-secondary">{t.agents.why(request.reason)}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => onRespond('once')} className={cn(btn, 'border-cyan/50 bg-cyan/[0.10] text-cyan hover:bg-cyan/16')}>
          <Check size={13} /> {t.agents.allowOnce}
        </button>
        {request.allowAlways && (
          <button type="button" onClick={() => onRespond('always')} className={cn(btn, 'border-hud/60 text-text-secondary hover:border-cyan/50 hover:text-cyan')}>
            <CheckCheck size={13} /> {t.agents.allowAlways}
          </button>
        )}
        <button type="button" onClick={() => onRespond('deny')} className={cn(btn, 'border-hud/60 text-text-secondary hover:border-danger/50 hover:text-danger')}>
          <X size={13} /> {t.agents.deny}
        </button>
      </div>
    </div>
  )
}
