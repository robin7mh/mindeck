import { Shrink } from 'lucide-react'
import { isDesktop } from '@shared/ipc/client'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { isMac, useFullScreen } from '@/lib/platform'
import { TechLabel } from '@/components/ui/TechLabel'
import { WindowControls } from '@/components/topbar/WindowControls'
import { keyLabel } from '../keys'
import { useWorkspace } from '../store'

/**
 * What zen mode keeps of the window chrome: a slim strip to drag the window
 * by, with the window controls (macOS: room for the traffic lights) and the
 * way out. In full screen nothing is left — only the panes.
 */
export function ZenBar() {
  const t = useT()
  const fullScreen = useFullScreen()
  if (fullScreen) return null
  return (
    <div className={cn('drag-region relative z-20 flex h-9 shrink-0 items-center gap-2 border-b border-hud/50 bg-surface/50 px-2', isMac && 'pl-[88px]')}>
      <TechLabel className="text-text-muted">Mindeck · {t.workspace.zen}</TechLabel>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => useWorkspace.getState().setZen(false)}
        title={`${t.workspace.exitZen} (${keyLabel('zen')})`}
        className="no-drag flex items-center gap-1.5 rounded-sm px-2 py-1 font-sans text-[12px] text-text-muted transition-colors hover:bg-elevated hover:text-text-primary"
      >
        <Shrink size={13} /> {t.workspace.exitZen}
      </button>
      {isDesktop() && !isMac && <WindowControls />}
    </div>
  )
}
