import { useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { clampFraction, MIN_HEIGHT, MIN_WIDTH, type Divider } from '../layout'
import { useWorkspace } from '../store'

/** Space between panes, in CSS px; a divider's handle fills it. */
export const GAP = 8
/** How far the arrow keys move a divider. */
const STEP = 0.02

/**
 * A divider between panes: drag it (no pane gets smaller than its minimum),
 * double-click it for equal sizes, or focus it and use the arrow keys.
 */
export function DividerHandle({
  divider,
  stage,
  onDrag
}: {
  divider: Divider
  stage: RefObject<HTMLDivElement>
  /** A drag starts (with the size it moves) or ends (null). */
  onDrag: (key: Divider['key'] | null) => void
}) {
  const t = useT()
  const [dragging, setDragging] = useState(false)
  const vertical = divider.key === 'x'

  const set = (value: number) => {
    const box = stage.current!.getBoundingClientRect()
    const total = vertical ? box.width : box.height
    useWorkspace.getState().resize(divider.key, clampFraction(value, total, vertical ? MIN_WIDTH : MIN_HEIGHT))
  }
  const fromPointer = (e: PointerEvent) => {
    const box = stage.current!.getBoundingClientRect()
    const [offset, total] = vertical ? [e.clientX - box.left, box.width] : [e.clientY - box.top, box.height]
    return total > 0 ? offset / total : divider.at
  }
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setDragging(false)
    onDrag(null)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const keys: Record<string, number> = vertical ? { ArrowLeft: -STEP, ArrowRight: STEP } : { ArrowUp: -STEP, ArrowDown: STEP }
    if (e.key in keys) set(divider.at + keys[e.key])
    else if (e.key === 'Enter') set(0.5)
    else return
    e.preventDefault()
  }

  const style = vertical
    ? { left: `calc(${divider.at * 100}% - ${GAP / 2}px)`, width: GAP, top: `${divider.from * 100}%`, height: `${(divider.to - divider.from) * 100}%` }
    : { top: `calc(${divider.at * 100}% - ${GAP / 2}px)`, height: GAP, left: `${divider.from * 100}%`, width: `${(divider.to - divider.from) * 100}%` }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={vertical ? t.workspace.dividerColumns : t.workspace.dividerRows}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(divider.at * 100)}
      title={t.workspace.dividerHint}
      style={style}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        setDragging(true)
        onDrag(divider.key)
      }}
      onPointerMove={(e) => dragging && set(fromPointer(e))}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => set(0.5)}
      onKeyDown={onKeyDown}
      className={cn('group absolute z-20 flex items-center justify-center outline-hidden', vertical ? 'cursor-col-resize' : 'cursor-row-resize')}
    >
      <span
        className={cn(
          'rounded-full transition-colors group-hover:bg-cyan/70 group-focus-visible:bg-cyan',
          dragging ? 'bg-cyan' : 'bg-hud/80',
          vertical ? 'h-10 w-0.5' : 'h-0.5 w-10'
        )}
      />
    </div>
  )
}
