import { useState, type CSSProperties, type DragEvent } from 'react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { endModuleDrag, useModuleDrag } from '../drag'
import { dropSides, type Pane, type Rect, type Side } from '../layout'
import { useWorkspace } from '../store'
import { boxStyle } from './Workspace'

/** Where a module can land on a pane: in it, or in a new pane on one of its edges. */
type Zone = Side | 'center'

/** The part of a pane that takes a drop on each edge (the middle takes the rest). */
const EDGE: Record<Side, string> = {
  left: 'inset-y-0 left-0 w-1/3',
  right: 'inset-y-0 right-0 w-1/3',
  top: 'top-0 h-1/3',
  bottom: 'bottom-0 h-1/3'
}

/** What lights up while the pointer is over a zone: the room the module would take. */
const PREVIEW: Record<Zone, CSSProperties> = {
  center: { inset: 4 },
  left: { left: 4, top: 4, bottom: 4, width: 'calc(50% - 6px)' },
  right: { right: 4, top: 4, bottom: 4, width: 'calc(50% - 6px)' },
  top: { left: 4, right: 4, top: 4, height: 'calc(50% - 6px)' },
  bottom: { left: 4, right: 4, bottom: 4, height: 'calc(50% - 6px)' }
}

/**
 * While a module is dragged from the side navigation: each pane shows where
 * it can go — into the pane, or into a new pane on an edge where the layouts
 * allow one (`dropSides`). A module already on screen can only swap places.
 */
export function DropZones({ panes, rectOf }: { panes: Pane[]; rectOf: (pane: Pane) => Rect }) {
  const t = useT()
  const module = useModuleDrag((s) => s.module)
  const layout = useWorkspace((s) => s.layout)
  const [hover, setHover] = useState<string>()
  // A page of the browser would take the drag: it steps back while one lasts.
  useOverlay(!!module)
  if (!module) return null
  const onScreen = layout.panes.some((p) => p.module === module)

  const zone = (pane: Pane, z: Zone, className: string) => {
    const key = `${pane.id}:${z}`
    const over = (e: DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setHover(key)
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      const ws = useWorkspace.getState()
      if (z === 'center') ws.place(pane.id, module)
      else ws.dropBeside(pane.id, z, module)
      setHover(undefined)
      endModuleDrag()
    }
    return (
      <div
        key={z}
        data-testid={`drop-${pane.module}-${z}`}
        aria-label={z === 'center' ? t.workspace.dropHere(t.nav[module]) : t.workspace.dropSide[z]}
        onDragEnter={over}
        onDragOver={over}
        onDragLeave={() => setHover((h) => (h === key ? undefined : h))}
        onDrop={drop}
        className={cn('absolute', className)}
      />
    )
  }

  return (
    <>
      {panes.map((pane) => {
        const sides = onScreen ? [] : dropSides(layout, pane.id)
        const across = sides.includes('left')
        const lit = hover?.startsWith(`${pane.id}:`) ? (hover.slice(pane.id.length + 1) as Zone) : undefined
        return (
          <div key={pane.id} data-testid={`drop-${pane.module}`} style={boxStyle(rectOf(pane))} className="absolute z-40 rounded-lg border border-dashed border-cyan/40 bg-void/30">
            {lit && (
              <div style={PREVIEW[lit]} className="pointer-events-none absolute flex items-center justify-center rounded-md border border-cyan/70 bg-cyan/[0.14] shadow-[0_0_24px_rgb(var(--accent-cyan)/0.25)]">
                <span className="rounded-sm bg-panel/90 px-2 py-1 font-sans text-[12px] font-medium text-cyan">
                  {lit === 'center' ? t.workspace.dropHere(t.nav[module]) : t.workspace.dropSide[lit]}
                </span>
              </div>
            )}
            {zone(pane, 'center', 'inset-0')}
            {sides.map((side) => zone(pane, side, cn(EDGE[side], (side === 'top' || side === 'bottom') && (across ? 'inset-x-1/3' : 'inset-x-0'))))}
          </div>
        )
      })}
    </>
  )
}
