import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useEditor } from '../store'
import { gridSashes, groupOrder, groupRects, type Sash } from '../groups'

/** No group gets narrower or lower than this (CSS px). */
const MIN_PX = 120
/** How far the arrow keys move a sash. */
const STEP = 0.02

const pct = (f: number) => `${f * 100}%`

/** A line between groups: drag it, double-click it for equal sizes, or focus it and use the arrow keys. */
function GridSash({ sash, stage }: { sash: Sash; stage: RefObject<HTMLDivElement> }) {
  const t = useT()
  const [dragging, setDragging] = useState(false)
  const row = sash.orientation === 'row'

  const set = (at: number) => {
    const box = stage.current!.getBoundingClientRect()
    const size = row ? box.width : box.height
    useEditor.getState().resizeGrid(sash, at, size > 0 ? MIN_PX / size : 0)
  }
  const fromPointer = (e: PointerEvent) => {
    const box = stage.current!.getBoundingClientRect()
    const [offset, size] = row ? [e.clientX - box.left, box.width] : [e.clientY - box.top, box.height]
    return size > 0 ? offset / size : sash.at
  }
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setDragging(false)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const keys: Record<string, number> = row ? { ArrowLeft: -STEP, ArrowRight: STEP } : { ArrowUp: -STEP, ArrowDown: STEP }
    if (!(e.key in keys)) return
    e.preventDefault()
    set(sash.at + keys[e.key])
  }

  const style = row
    ? { left: `calc(${pct(sash.at)} - 3px)`, width: 6, top: pct(sash.from), height: pct(sash.to - sash.from) }
    : { top: `calc(${pct(sash.at)} - 3px)`, height: 6, left: pct(sash.from), width: pct(sash.to - sash.from) }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={t.editor.resizeGroups}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(sash.at * 100)}
      title={t.editor.resizeHint}
      style={style}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        setDragging(true)
      }}
      onPointerMove={(e) => dragging && set(fromPointer(e))}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => useEditor.getState().evenGrid(sash.path)}
      onKeyDown={onKeyDown}
      className={cn('group absolute z-20 flex items-center justify-center outline-hidden', row ? 'cursor-col-resize' : 'cursor-row-resize')}
    >
      <span
        className={cn(
          'transition-colors group-hover:bg-cyan/70 group-focus-visible:bg-cyan',
          dragging ? 'bg-cyan' : 'bg-hud/60',
          row ? 'h-full w-px' : 'h-px w-full'
        )}
      />
    </div>
  )
}

/**
 * The editor groups, each placed over its box of the grid. Groups are drawn
 * in a fixed order (by id) and only re-positioned when the grid changes —
 * splitting, closing or resizing never mounts a group's editor again.
 */
export function EditorGrid({ renderGroup }: { renderGroup: (id: string, index: number) => ReactNode }) {
  const grid = useEditor((s) => s.grid)
  const stage = useRef<HTMLDivElement>(null)
  const order = groupOrder(grid)
  const rects = groupRects(grid)

  return (
    <div ref={stage} className="relative min-h-0 flex-1">
      {[...order].sort().map((id) => {
        const r = rects.get(id)!
        return (
          <div key={id} className="absolute flex" style={{ left: pct(r.x0), top: pct(r.y0), width: pct(r.x1 - r.x0), height: pct(r.y1 - r.y0) }}>
            {renderGroup(id, order.indexOf(id))}
          </div>
        )
      })}
      {gridSashes(grid).map((s) => (
        <GridSash key={`${s.path.join('.')}:${s.index}`} sash={s} stage={stage} />
      ))}
    </div>
  )
}
