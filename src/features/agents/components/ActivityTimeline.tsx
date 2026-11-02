import type { MindeckEvent } from '@shared/types/events'
import { StatusDot } from '@/components/ui/StatusDot'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { clock, describeEvent } from '../format'

/**
 * Calm, technical timeline of what agents did (architecture §10) — curated
 * event lines, never raw logs or model reasoning.
 */
export function ActivityTimeline({
  events,
  empty,
  compact = false,
  max = 60
}: {
  events: MindeckEvent[]
  empty?: string
  compact?: boolean
  max?: number
}) {
  const t = useT()
  if (!events.length) return <p className="px-2 py-3 font-mono text-[11px] text-text-muted">{empty ?? t.agents.noActivity}</p>
  return (
    <ol className={cn('space-y-1', compact ? 'text-[11px]' : 'text-[11.5px]')}>
      {events.slice(0, max).map((e) => {
        const { text, tone } = describeEvent(e)
        return (
          <li key={e.id} className="flex items-start gap-2 rounded-sm px-1.5 py-0.5 hover:bg-elevated/40">
            <span className="mt-[5px]">
              <StatusDot tone={tone} pulse={false} />
            </span>
            <span className="shrink-0 font-mono text-text-muted">{clock(e.ts)}</span>
            <span className={cn('min-w-0 flex-1 font-sans text-text-secondary', compact && 'truncate')} title={text}>
              {text}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
