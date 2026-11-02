import { RotateCcw } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { useBrowser } from '../store'

const small =
  'flex items-center gap-1 rounded-md border border-hud/60 px-2 py-0.5 font-sans text-[11.5px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'

/** After a crash: the last session's tabs wait here — restore them, or let them go. */
export function RestoreBar() {
  const t = useT()
  const count = useBrowser((s) => s.state.restorable ?? 0)
  const run = useBrowser((s) => s.run)
  if (!count) return null
  return (
    <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-amber/30 bg-amber/6 px-3 py-1.5">
      <RotateCcw size={14} className="shrink-0 text-amber" />
      <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-text-primary">{t.library.crashed(count)}</span>
      <button type="button" onClick={() => void run('browser:restoreSession', { restore: false })} className={small}>
        {t.common.dismiss}
      </button>
      <button type="button" onClick={() => void run('browser:restoreSession', { restore: true })} className={`${small} border-cyan/50 text-cyan`}>
        {t.library.restore}
      </button>
    </div>
  )
}
