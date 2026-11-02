import { cn } from '@/lib/cn'

type Tone = 'cyan' | 'ok' | 'warn' | 'error' | 'muted'

const TONE_CLASS: Record<Tone, string> = {
  cyan: 'bg-cyan',
  ok: 'bg-green',
  warn: 'bg-amber',
  error: 'bg-danger',
  muted: 'bg-text-muted'
}

/** A small pulsing status dot. Pulse can be disabled for static rows. */
export function StatusDot({
  tone = 'cyan',
  pulse = true,
  className
}: {
  tone?: Tone
  pulse?: boolean
  className?: string
}) {
  return (
    <span className={cn('relative inline-flex h-2 w-2', className)}>
      {pulse && <span className={cn('absolute inset-0 rounded-full animate-pulse-dot', TONE_CLASS[tone])} />}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', TONE_CLASS[tone])} />
    </span>
  )
}
