import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'

/**
 * Custom frameless-window controls. All calls go through the guarded
 * `window.mindeck` bridge, so in a plain browser (verification) they simply no-op.
 */
export function WindowControls() {
  const t = useT()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    window.mindeck?.isMaximized().then(setMaximized)
    return window.mindeck?.onMaximizedChange(setMaximized)
  }, [])

  const btn =
    'no-drag flex h-7 w-9 items-center justify-center rounded-sm text-text-muted transition-colors hover:text-text-primary'

  return (
    <div className="no-drag flex items-center gap-0.5">
      <button
        type="button"
        aria-label={t.topbar.minimize}
        className={cn(btn, 'hover:bg-elevated')}
        onClick={() => window.mindeck?.minimize()}
      >
        <Minus size={15} strokeWidth={2} />
      </button>
      <button
        type="button"
        aria-label={maximized ? t.topbar.restore : t.topbar.maximize}
        className={cn(btn, 'hover:bg-elevated')}
        onClick={() => window.mindeck?.toggleMaximize()}
      >
        {maximized ? <Copy size={12} strokeWidth={2} /> : <Square size={12} strokeWidth={2} />}
      </button>
      <button
        type="button"
        aria-label={t.common.close}
        className={cn(btn, 'hover:bg-danger/90 hover:text-white')}
        onClick={() => window.mindeck?.close()}
      >
        <X size={16} strokeWidth={2} />
      </button>
    </div>
  )
}
