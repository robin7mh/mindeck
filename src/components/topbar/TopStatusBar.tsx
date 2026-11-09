import { useEffect, useState } from 'react'
import { LogOut } from 'lucide-react'
import { Clock } from './Clock'
import { StatusIndicator } from './StatusIndicator'
import { UpdateChip } from '@/features/update/components/UpdateChip'
import { OfflineChip } from '@/features/cloud/components/OfflineChip'
import { WindowControls } from './WindowControls'
import { MindeckMark } from '@/components/brand/MindeckMark'
import { formatUptime } from '@/lib/format'
import { cn } from '@/lib/cn'
import { isMac, useFullScreen } from '@/lib/platform'
import { isDesktop } from '@shared/ipc/client'
import { useSession } from '@/features/session/store'
import { useT } from '@/lib/i18n'
import { WorkspaceMenu } from '@/features/workspace/components/WorkspaceMenu'
import { SplitButton } from '@/features/workspace/components/SplitButton'
import { PaletteButton } from '@/features/palette/components/PaletteButton'

/** Session uptime since `since` (epoch ms); ticks on its own so only this re-renders. */
function Uptime({ since }: { since?: number }) {
  const t = useT()
  const [, tick] = useState(0)
  useEffect(() => {
    if (since === undefined) return
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [since])
  const secs = since === undefined ? 0 : Math.max(0, Math.floor((Date.now() - since) / 1000))
  return <StatusIndicator label={t.topbar.uptime} value={formatUptime(secs)} tone="ok" pulse={false} />
}

export function TopStatusBar({ since, showClock = true }: { since?: number; showClock?: boolean }) {
  const t = useT()
  const fullScreen = useFullScreen()
  const desktop = isDesktop()
  const link = useSession((s) => s.link)
  const info = useSession((s) => s.info)
  const logout = useSession((s) => s.logout)
  const linkView =
    link === 'online'
      ? ({ value: 'OK', tone: 'ok' } as const)
      : link === 'connecting'
        ? ({ value: 'SYNC', tone: 'warn' } as const)
        : ({ value: 'DOWN', tone: 'error' } as const)

  return (
    <header
      className={cn(
        'drag-region relative z-20 flex h-[52px] shrink-0 items-center gap-3 border-b border-hud/40 bg-surface px-3 pl-4',
        isMac && !fullScreen && 'pl-[88px]' // clear the native traffic lights (hidden in fullscreen)
      )}
    >
      {/* Brand */}
      <div className="flex shrink-0 items-center gap-2.5 lg:w-[200px]">
        <MindeckMark size={32} className="rounded-[9px]" />
        <span className="font-sans text-[14px] font-semibold tracking-[-0.01em] text-text-primary">Mindeck</span>
        <span className="hidden rounded-full border border-hud/45 px-2 py-0.5 font-mono text-[11px] text-text-muted md:inline">v{info?.version ?? '0.1.0'}</span>
      </div>

      {/* Center: search / command palette */}
      <div className="flex min-w-0 flex-1 justify-center">
        <div className="w-full max-w-[520px]">
          <PaletteButton />
        </div>
      </div>

      {/* Right cluster */}
      <div className="flex shrink-0 items-center gap-1.5">
        <OfflineChip />
        <UpdateChip />
        <SplitButton />
        <WorkspaceMenu />
        <div className="hidden items-center gap-1.5 xl:flex">
          <StatusIndicator
            label={t.topbar.mode}
            value={desktop ? t.topbar.local : t.topbar.remote(info?.hostname ?? 'core')}
            tone="cyan"
            pulse={false}
          />
          <Uptime since={since} />
        </div>
        <div className="hidden items-center sm:flex">
          <StatusIndicator label={t.topbar.link} value={linkView.value} tone={linkView.tone} pulse={link !== 'online'} />
        </div>
        {showClock && (
          <div className="hidden px-1.5 lg:flex">
            <Clock />
          </div>
        )}

        {!desktop && (
          <button
            type="button"
            aria-label={t.topbar.disconnect}
            title={t.topbar.disconnectTitle}
            onClick={() => void logout()}
            className="no-drag flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-danger/10 hover:text-danger"
          >
            <LogOut size={16} strokeWidth={1.75} />
          </button>
        )}

        {desktop && !isMac && (
          <>
            <div className="mx-1 h-5 w-px bg-hud/50" />
            <WindowControls />
          </>
        )}
      </div>
    </header>
  )
}
