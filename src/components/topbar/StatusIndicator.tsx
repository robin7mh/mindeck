import { StatusDot } from '@/components/ui/StatusDot'
import { cn } from '@/lib/cn'

type Tone = 'cyan' | 'ok' | 'warn' | 'error' | 'muted'

/** Compact label + value pill with a status dot. */
export function StatusIndicator({
  label,
  value,
  tone = 'ok',
  pulse = true,
  className
}: {
  label: string
  value: string
  tone?: Tone
  pulse?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex h-7 items-center gap-2 rounded-full border border-hud/45 px-2.5', className)}>
      <StatusDot tone={tone} pulse={pulse} />
      <span className="font-sans text-[12px] text-text-muted">{label}</span>
      <span className="font-mono text-[11.5px] font-medium text-text-secondary">{value}</span>
    </div>
  )
}
