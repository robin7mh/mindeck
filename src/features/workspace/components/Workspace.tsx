import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { isDesktop } from '@shared/ipc/client'
import type { ModuleId } from '@/types'
import { cn } from '@/lib/cn'
import { useCoverWatch, useOverlay } from '@/lib/overlay'
import { relayout } from '@/lib/relayout'
import { perform, rememberFocus } from '../actions'
import { isCloseKey, macKeys, matchWorkspaceKey } from '../keys'
import { MODULES, dividers, fitSizes, focusedPane, slotRects, visiblePanes, type Pane, type Rect } from '../layout'
import { PaneContext, type PaneInfo } from '../pane'
import { paneSteps } from '../steps'
import { useWorkspace } from '../store'
import { DividerHandle, GAP } from './DividerHandle'
import { DropZones } from './DropZones'
import { PaneHeader } from './PaneHeader'

/** Height of a pane's head, in CSS px. */
export const HEADER = 30

const FULL: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 }
const FOCUSED: PaneInfo = { focused: true }
const UNFOCUSED: PaneInfo = { focused: false }

/** A pane's place as CSS: fractions of the workspace, half a gap off every inner edge; `head` px taken off the top. */
export function boxStyle(r: Rect, head = 0): CSSProperties {
  const half = GAP / 2
  const left = r.x0 > 0 ? half : 0
  const right = r.x1 < 1 ? half : 0
  const top = (r.y0 > 0 ? half : 0) + head
  const bottom = r.y1 < 1 ? half : 0
  return {
    left: `calc(${r.x0 * 100}% + ${left}px)`,
    top: `calc(${r.y0 * 100}% + ${top}px)`,
    width: `calc(${(r.x1 - r.x0) * 100}% - ${left + right}px)`,
    height: `calc(${(r.y1 - r.y0) * 100}% - ${top + bottom}px)`
  }
}

/** One module, drawn once: moving its pane or dragging a divider re-renders nothing inside. */
const ModuleSlot = memo(function ModuleSlot({ id, visible, render }: { id: ModuleId; visible: boolean; render: WorkspaceProps['render'] }) {
  return <>{render(id, visible)}</>
})

/** The workspace's keys (keys.ts), ahead of the modules — except where the module in focus keeps its own. */
function useWorkspaceKeys(): void {
  useEffect(() => {
    const mac = macKeys()
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const action = matchWorkspaceKey(e, mac)
      if (!action) return
      const target = e.target instanceof Element ? e.target : null
      // The editor splits itself on ⌘\ (as VS Code does); Ctrl+\ in a terminal is SIGQUIT.
      if (action.type === 'split' && (focusedPane(useWorkspace.getState().layout).module === 'editor' || (!mac && target?.closest('.xterm')))) return
      // ⇧⌘↵ in a code editor inserts a line above.
      if (action.type === 'maximize' && target?.closest('.monaco-editor')) return
      e.preventDefault()
      e.stopPropagation()
      perform(action)
    }
    // ⌘W after every module had its say (a module that closes its own tab prevents the default): else the pane.
    const onClose = (e: KeyboardEvent) => {
      if (e.isComposing || !isCloseKey(e, mac)) return
      setTimeout(() => !e.defaultPrevented && perform({ type: 'close' }))
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keydown', onClose)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keydown', onClose)
    }
  }, [])
}

export interface WorkspaceProps {
  /** Draws a module; `visible`: its pane is on screen. */
  render: (id: ModuleId, visible: boolean) => ReactNode
  /** Modules that stay mounted (hidden) once shown — running shells, open files, the browser's tabs. */
  keep: ModuleId[]
}

/**
 * The panes (architecture: one module per pane, up to four): each module is
 * drawn in its own host, placed over its pane — so moving a module to another
 * pane, or a pane to another size, never mounts it again. Hosts of modules in
 * `keep` stay mounted while hidden.
 */
export function Workspace({ render, keep }: WorkspaceProps) {
  const layout = useWorkspace((s) => s.layout)
  const zen = useWorkspace((s) => s.zen)
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [dragging, setDragging] = useState<'x' | 'y' | null>(null)
  const [kept, setKept] = useState<ModuleId[]>([])
  useWorkspaceKeys()

  const visible = visiblePanes(layout)
  const shown = new Map(visible.map((p) => [p.module, p]))
  const rects = slotRects(layout.preset, fitSizes(layout.sizes, size.w, size.h))
  const rectOf = (p: Pane) => (layout.maximized ? FULL : rects[layout.panes.indexOf(p)])
  const chrome = layout.panes.length > 1 || zen
  const head = chrome ? HEADER : 0
  const browserShown = shown.has('browser') && isDesktop()

  // The workspace's size: dividers stop at the panes' minimum, panes tell modules their width.
  useEffect(() => {
    const el = stage.current!
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])

  // Kept modules stay mounted from their first time on screen.
  const onScreen = visible.map((p) => p.module).join(' ')
  useEffect(() => {
    const ids = onScreen.split(' ')
    setKept((prev) => {
      const add = keep.filter((id) => ids.includes(id) && !prev.includes(id))
      return add.length ? [...prev, ...add] : prev
    })
  }, [keep, onScreen])

  // Native views (the browser's page) follow every move; dialogs over them, and a divider being dragged across, freeze them.
  useLayoutEffect(() => relayout())
  useOverlay(!!dragging)
  useCoverWatch(browserShown)

  const mounted = MODULES.filter((id) => shown.has(id) || kept.includes(id))

  return (
    <div ref={stage} className="relative min-h-0 min-w-0 flex-1" data-testid="workspace">
      {chrome &&
        visible.map((p) => (
          <PaneHeader
            key={p.id}
            pane={p}
            style={{ ...boxStyle(rectOf(p)), height: HEADER }}
            focused={p.id === layout.focus}
            count={layout.panes.length}
            maximized={layout.maximized === p.id}
            zen={zen}
            elsewhere={new Set(layout.panes.filter((o) => o !== p).map((o) => o.module))}
          />
        ))}

      {mounted.map((id) => {
        const pane = shown.get(id)
        if (!pane) {
          return (
            <div key={id} className="hidden">
              <PaneContext.Provider value={UNFOCUSED}>
                <ModuleSlot id={id} visible={false} render={render} />
              </PaneContext.Provider>
            </div>
          )
        }
        const r = rectOf(pane)
        const focused = pane.id === layout.focus
        return (
          <div
            key={id}
            data-pane-id={pane.id}
            data-pane={paneSteps((r.x1 - r.x0) * size.w)}
            tabIndex={-1}
            style={boxStyle(r, head)}
            onPointerDownCapture={() => useWorkspace.getState().focus(pane.id)}
            onFocusCapture={(e) => {
              rememberFocus(pane.id, e.target as HTMLElement)
              useWorkspace.getState().focus(pane.id)
            }}
            className={cn('absolute flex min-h-0 min-w-0 flex-col outline-hidden', chrome && '*:rounded-t-none')}
          >
            <PaneContext.Provider value={focused ? FOCUSED : UNFOCUSED}>
              <ModuleSlot id={id} visible render={render} />
            </PaneContext.Provider>
          </div>
        )
      })}

      {/* The focused pane's frame (over its module's own border). */}
      {chrome && visible.length > 1 && (
        <div className="pointer-events-none absolute z-10 rounded-b-lg ring-1 ring-cyan/40" style={boxStyle(rectOf(focusedPane(layout)), head)} aria-hidden />
      )}

      {!layout.maximized &&
        dividers(layout.preset, fitSizes(layout.sizes, size.w, size.h)).map((d) => (
          <DividerHandle key={d.key} divider={d} stage={stage} onDrag={setDragging} />
        ))}
      {/* A module dragged from the side navigation: where it can go. */}
      <DropZones panes={visible} rectOf={rectOf} />
      {/* While dragging, nothing below takes the pointer (an editor would select text, a page would scroll). */}
      {dragging && <div className={cn('absolute inset-0 z-30', dragging === 'x' ? 'cursor-col-resize' : 'cursor-row-resize')} data-testid="drag-shield" />}
    </div>
  )
}
