import { CalendarClock } from 'lucide-react'
import { offlineDaysLeft } from '@shared/types/cloud'
import { useT } from '@/lib/i18n'
import { showModule } from '@/features/palette/reveal'
import { useCloud } from '../store'

const chip =
  'flex h-7 items-center gap-1.5 rounded-full bg-amber/12 px-2.5 font-sans text-[12px] font-medium text-amber transition-colors hover:bg-amber/20'

/**
 * Top bar: the lifetime license's offline certificate runs out within
 * OFFLINE_WARN_DAYS (this core hasn't reached Mindeck Cloud for most of a
 * year, or holds a certificate from before key ids). Opens the profile, which
 * says what to do.
 */
export function OfflineChip() {
  const t = useT()
  const status = useCloud((s) => s.status)
  const days = status ? offlineDaysLeft(status) : null
  if (days === null) return null
  return (
    <button type="button" onClick={() => showModule('account')} className={chip}>
      <CalendarClock size={13} />
      {t.cloud.offlineChip(days)}
    </button>
  )
}
