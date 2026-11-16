import { useClock } from '@/hooks/useClock'
import { formatDate, formatTime } from '@/lib/format'

export function Clock() {
  const now = useClock()
  return (
    <div className="flex items-baseline gap-2" title={formatDate(now)}>
      <span className="font-mono text-[12.5px] font-medium leading-none text-text-secondary tabular-nums">{formatTime(now)}</span>
    </div>
  )
}
