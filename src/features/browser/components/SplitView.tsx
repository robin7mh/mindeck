import { useState, type DragEvent, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { ArrowLeftRight, Columns2, Rows2, X } from 'lucide-react'
import type { BrowserSplit } from '@shared/types/browser'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { useActiveSplit, useBrowser } from '../store'
import { TAB_DRAG } from '../tabs'

/** Space between the two pages (CSS px); the divider's handle fills it. */
export const DIVIDER = 6
/** Neither page gets narrower (or lower) than this while the divider is dragged. */
export const MIN_PANE = 200
const STEP = 0.02

/** The first page's share for a divider at `offset` px of `total` — each page at least MIN_PANE px (half and half when both can't be). */
export function splitRatio(offset: number, total: number): number {
  const room = total - DIVIDER
  if (room < MIN_PANE * 2) return 0.5
  return Math.max(MIN_PANE, Math.min(room - MIN_PANE, offset - DIVIDER / 2)) / room
}

/** The divider between the two pages: drag it, double-click it for half and half, or focus it and use the arrow keys. */
export function SplitDivider({ split, area, onRatio }: { split: BrowserSplit; area: RefObject<HTMLDivElement>; onRatio: (ratio: number | null) => void }) {
  const t = useT()
  const [dragging, setDragging] = useState(false)
  // The pages are native views: while dragging over them, their pictures stand in.
  useOverlay(dragging)
  const vertical = !!split.vertical
  const commit = (ratio: number) => void useBrowser.getState().run('browser:splitUpdate', { id: split.id, ratio })
  const fromPointer = (e: PointerEvent) => {
    const box = area.current!.getBoundingClientRect()
    return vertical ? splitRatio(e.clientY - box.top, box.height) : splitRatio(e.clientX - box.left, box.width)
  }
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setDragging(false)
    onRatio(null)
    commit(fromPointer(e))
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const keys: Record<string, number> = vertical ? { ArrowUp: -STEP, ArrowDown: STEP } : { ArrowLeft: -STEP, ArrowRight: STEP }
    if (e.key in keys) commit(split.ratio + keys[e.key])
    else if (e.key === 'Enter') commit(0.5)
    else return
    e.preventDefault()
  }
  return (
    <>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation={vertical ? 'horizontal' : 'vertical'}
        aria-label={t.browserTabs.divider}
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={Math.round(split.ratio * 100)}
        title={t.browserTabs.divider}
        style={vertical ? { height: DIVIDER } : { width: DIVIDER }}
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture?.(e.pointerId)
          setDragging(true)
        }}
        onPointerMove={(e) => dragging && onRatio(fromPointer(e))}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => commit(0.5)}
        onKeyDown={onKeyDown}
        className={cn('group flex shrink-0 items-center justify-center outline-hidden', vertical ? 'cursor-row-resize' : 'cursor-col-resize')}
      >
        <span className={cn('rounded-full transition-colors group-hover:bg-cyan/70 group-focus-visible:bg-cyan', dragging ? 'bg-cyan' : 'bg-hud/80', vertical ? 'h-0.5 w-10' : 'h-10 w-0.5')} />
      </div>
      {dragging && <div className={cn('fixed inset-0 z-50', vertical ? 'cursor-row-resize' : 'cursor-col-resize')} data-testid="split-drag-shield" />}
    </>
  )
}

type Side = 'left' | 'right' | 'top' | 'bottom'

/** Where each drop zone sits, and the half of the page it previews. */
const ZONES: Record<Side, { zone: string; preview: string }> = {
  left: { zone: 'inset-y-0 left-0 w-1/4', preview: 'inset-y-0 left-0 w-1/2' },
  right: { zone: 'inset-y-0 right-0 w-1/4', preview: 'inset-y-0 right-0 w-1/2' },
  top: { zone: 'left-1/4 right-1/4 top-0 h-1/3', preview: 'inset-x-0 top-0 h-1/2' },
  bottom: { zone: 'left-1/4 right-1/4 bottom-0 h-1/3', preview: 'inset-x-0 bottom-0 h-1/2' }
}

/**
 * While a tab is dragged over the page area: its edges. Dropped on one, the
 * tab opens on that side of the tab on screen — a split view (left/right, or
 * top/bottom).
 */
export function DropZones({ dragged, active }: { dragged: string; active: string }) {
  const t = useT()
  const [over, setOver] = useState<Side | null>(null)
  // The page's picture stands in for it: a native view would take the drag.
  useOverlay(true)
  const drop = (side: Side, e: DragEvent) => {
    e.preventDefault()
    setOver(null)
    const [first, second] = side === 'left' || side === 'top' ? [dragged, active] : [active, dragged]
    void useBrowser.getState().run('browser:split', { id: first, with: second, ...(side === 'top' || side === 'bottom' ? { vertical: true } : {}) })
  }
  return (
    <div className="absolute inset-0 z-20" aria-label={t.browserTabs.dropHint}>
      {over && <div className={cn('pointer-events-none absolute rounded-md border-2 border-cyan/70 bg-cyan/10', ZONES[over].preview)} />}
      {(Object.keys(ZONES) as Side[]).map((side) => (
        <div
          key={side}
          data-testid={`split-drop-${side}`}
          title={t.browserTabs.dropSides[side]}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(TAB_DRAG)) return
            e.preventDefault()
            setOver(side)
          }}
          onDragLeave={() => setOver((o) => (o === side ? null : o))}
          onDrop={(e) => drop(side, e)}
          className={cn('absolute', ZONES[side].zone)}
        />
      ))}
      <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center font-sans text-[12.5px] text-text-secondary">{t.browserTabs.dropHint}</p>
    </div>
  )
}

const tool =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text-primary disabled:pointer-events-none disabled:opacity-35'

/** The toolbar's split buttons: split with a new tab — or, in a split, swap the sides, stack them, or end the split. */
export function SplitTools({ tabId }: { tabId: string }) {
  const t = useT()
  const split = useActiveSplit()
  const run = useBrowser((s) => s.run)
  if (!split) {
    return (
      <button type="button" aria-label={t.browserTabs.splitNew} title={t.browserTabs.splitNew} disabled={!tabId} onClick={() => void run('browser:split', { id: tabId })} className={tool}>
        <Columns2 size={15} />
      </button>
    )
  }
  return (
    <div role="group" aria-label={t.browserTabs.splitView} className="flex shrink-0 items-center rounded-md border border-cyan/30 bg-cyan/5">
      <button type="button" aria-label={t.browserTabs.swapSides} title={t.browserTabs.swapSides} onClick={() => void run('browser:splitUpdate', { id: split.id, swap: true })} className={tool}>
        <ArrowLeftRight size={14} className={split.vertical ? 'rotate-90' : ''} />
      </button>
      <button
        type="button"
        aria-label={split.vertical ? t.browserTabs.sideBySide : t.browserTabs.stack}
        title={split.vertical ? t.browserTabs.sideBySide : t.browserTabs.stack}
        onClick={() => void run('browser:splitUpdate', { id: split.id, vertical: !split.vertical })}
        className={tool}
      >
        {split.vertical ? <Columns2 size={15} /> : <Rows2 size={15} />}
      </button>
      <button type="button" aria-label={t.browserTabs.closeSplit} title={t.browserTabs.closeSplit} onClick={() => void run('browser:unsplit', { id: split.id })} className={tool}>
        <X size={15} />
      </button>
    </div>
  )
}
