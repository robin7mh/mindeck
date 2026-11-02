import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, Columns2, Maximize2, Minimize2, Shrink, UserRound, X, type LucideIcon } from 'lucide-react'
import { NAV_ITEMS } from '@/data/navigation'
import type { ModuleId } from '@/types'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { keyLabel } from '../keys'
import { SLOTS, type Pane } from '../layout'
import { useWorkspace } from '../store'

export const MODULE_ICONS: Record<ModuleId, LucideIcon> = {
  ...(Object.fromEntries(NAV_ITEMS.map((i) => [i.id, i.icon])) as Record<Exclude<ModuleId, 'account'>, LucideIcon>),
  account: UserRound
}

const tool =
  'no-drag flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-elevated hover:text-text-primary'

/** The module in a pane, and the menu to show another one there. */
function ModuleSwitcher({ pane, elsewhere }: { pane: Pane; elsewhere: Set<ModuleId> }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOverlay(open)
  const Icon = MODULE_ICONS[pane.module]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current!.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (id: ModuleId) => {
    setOpen(false)
    useWorkspace.getState().place(pane.id, id)
  }

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.workspace.switchModule(t.nav[pane.module])}
        title={t.workspace.switchModule(t.nav[pane.module])}
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-elevated hover:text-text-primary"
      >
        <Icon size={13} className="shrink-0" />
        <span className="truncate font-sans text-[12px] font-medium">{t.nav[pane.module]}</span>
        <ChevronDown size={12} className="shrink-0 text-text-muted" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t.workspace.modules}
          className="absolute left-0 top-full z-40 mt-1 min-w-[220px] rounded-lg border border-hud/70 bg-panel/95 p-1 shadow-xl shadow-black/40 backdrop-blur-md"
        >
          {NAV_ITEMS.map((item) => {
            const ItemIcon = item.icon
            const current = item.id === pane.module
            return (
              <button
                key={item.id}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                onClick={() => pick(item.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-sans text-[12.5px] transition-colors hover:bg-elevated',
                  current ? 'text-cyan' : 'text-text-secondary hover:text-text-primary'
                )}
              >
                <ItemIcon size={14} className="shrink-0" />
                <span className="flex-1 truncate">{t.nav[item.id]}</span>
                {elsewhere.has(item.id) && <span className="font-mono text-[10px] text-text-muted">{t.workspace.inOtherPane}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * The narrow head of a pane: which module (and the menu to switch it), split,
 * maximize / restore, close. Pressing anywhere on it focuses the pane.
 */
export function PaneHeader({
  pane,
  style,
  focused,
  count,
  maximized,
  zen,
  elsewhere
}: {
  pane: Pane
  style: CSSProperties
  focused: boolean
  /** How many panes the workspace has. */
  count: number
  maximized: boolean
  zen: boolean
  /** Modules shown in the other panes. */
  elsewhere: Set<ModuleId>
}) {
  const t = useT()
  const ws = useWorkspace.getState
  return (
    <div
      style={style}
      onPointerDown={() => ws().focus(pane.id)}
      data-testid={`pane-head-${pane.module}`}
      className={cn(
        'absolute z-20 flex items-center gap-0.5 rounded-t-lg border border-b-0 px-1 backdrop-blur-xs',
        focused ? 'border-cyan/50 bg-cyan/[0.07]' : 'border-hud/60 bg-surface/50'
      )}
    >
      {focused && <span className="mr-0.5 h-3 w-0.5 shrink-0 rounded-full bg-cyan" aria-hidden />}
      <ModuleSwitcher pane={pane} elsewhere={elsewhere} />
      <span className="min-w-0 flex-1" />
      {count < SLOTS.grid && !maximized && (
        <button
          type="button"
          aria-label={t.workspace.split}
          title={`${t.workspace.split} (${keyLabel('split')})`}
          onClick={() => {
            ws().focus(pane.id)
            ws().split()
          }}
          className={tool}
        >
          <Columns2 size={13} />
        </button>
      )}
      {count > 1 && (
        <button
          type="button"
          aria-label={maximized ? t.workspace.restore : t.workspace.maximize}
          title={`${maximized ? t.workspace.restore : t.workspace.maximize} (${keyLabel('maximize')})`}
          onClick={() => ws().toggleMaximize(pane.id)}
          className={cn(tool, maximized && 'text-cyan')}
        >
          {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      )}
      {zen && (
        <button type="button" aria-label={t.workspace.exitZen} title={`${t.workspace.exitZen} (${keyLabel('zen')})`} onClick={() => ws().setZen(false)} className={tool}>
          <Shrink size={13} />
        </button>
      )}
      {count > 1 && (
        <button
          type="button"
          aria-label={t.workspace.closePane}
          title={`${t.workspace.closePane} (${keyLabel('close')})`}
          onClick={() => ws().close(pane.id)}
          className={cn(tool, 'hover:text-danger')}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}
