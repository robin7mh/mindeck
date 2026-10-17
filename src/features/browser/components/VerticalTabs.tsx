import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, Plus, Search, X } from 'lucide-react'
import { VERTICAL_TABS_WIDTH, type BrowserTab, type BrowserTabGroup } from '@shared/types/browser'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { tabLabel } from '../library'
import { splitOf, useBrowser } from '../store'
import { dropAtEnd, dropOnGroup, dropOnTab, GROUP_STYLES, tabItems } from '../tabs'
import { Favicon, ProfileMark, TabStatus, useTabDrag } from './TabParts'

/** The sidebar folded to its icons. */
export const FOLDED_WIDTH = 48
/** How far the arrow keys move the sidebar's edge. */
const STEP = 16

const icon =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text-primary'

const clampWidth = (w: number) => Math.round(Math.max(VERTICAL_TABS_WIDTH.min, Math.min(VERTICAL_TABS_WIDTH.max, w)))

/** The sidebar's right edge: drag it (or use the arrow keys) for another width, double-click for the default. */
function Resizer({ width, onWidth }: { width: number; onWidth: (w: number | null) => void }) {
  const t = useT()
  const start = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // The page is a native view: while dragging over it, its picture stands in (it would take the pointer).
  useOverlay(dragging)
  const commit = (w: number) => void useBrowser.getState().configure({ verticalTabsWidth: clampWidth(w) })
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    const w = clampWidth(start.current.width + e.clientX - start.current.x)
    start.current = null
    setDragging(false)
    onWidth(null)
    commit(w)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -STEP, ArrowRight: STEP }
    if (!(e.key in step)) return
    e.preventDefault()
    commit(width + step[e.key])
  }
  return (
    <>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t.browserTabs.resizeSidebar}
        aria-valuemin={VERTICAL_TABS_WIDTH.min}
        aria-valuemax={VERTICAL_TABS_WIDTH.max}
        aria-valuenow={width}
        title={t.browserTabs.resizeSidebar}
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture?.(e.pointerId)
          start.current = { x: e.clientX, width }
          setDragging(true)
        }}
        onPointerMove={(e) => start.current && onWidth(clampWidth(start.current.width + e.clientX - start.current.x))}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => commit(VERTICAL_TABS_WIDTH.default)}
        onKeyDown={onKeyDown}
        className="group absolute inset-y-0 -right-1 z-20 flex w-2 cursor-col-resize justify-center outline-hidden"
      >
        <span className={cn('h-full w-px transition-colors group-hover:bg-cyan/70 group-focus-visible:bg-cyan', dragging ? 'bg-cyan' : 'bg-transparent')} />
      </div>
      {/* While dragging, nothing else takes the pointer. */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" data-testid="sidebar-drag-shield" />}
    </>
  )
}

/**
 * Vertical tabs (Edge, Arc): the tabs in a sidebar on the left of the
 * browser — pinned tabs on top as icons, then the tabs and groups with their
 * full titles. It folds to its icons, its width is dragged and remembered;
 * tabs are reordered and moved into groups by dragging, as in the strip.
 */
export function VerticalTabs() {
  const t = useT()
  const state = useBrowser((s) => s.state)
  const settings = useBrowser((s) => s.settings)
  const run = useBrowser((s) => s.run)
  const drag = useTabDrag()
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const folded = settings.verticalTabsCollapsed
  const width = folded ? FOLDED_WIDTH : (dragWidth ?? clampWidth(settings.verticalTabsWidth))
  const beside = splitOf(state, state.activeId)?.tabs.find((id) => id !== state.activeId)
  const pinned = state.tabs.filter((tab) => tab.pinned)

  const select = (tab: BrowserTab) => tab.id !== state.activeId && void run('browser:activate', { id: tab.id })
  const common = (tab: BrowserTab) => ({
    role: 'tab',
    'aria-selected': tab.id === state.activeId,
    ...drag.source(tab),
    ...drag.target(tab.id, (id: string) => dropOnTab(useBrowser.getState().state, id, tab)),
    onClick: () => select(tab),
    onAuxClick: (e: MouseEvent) => e.button === 1 && void run('browser:close', { id: tab.id }),
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault()
      void run('browser:tool', { id: tab.id, tool: 'tabMenu' })
    }
  })
  const look = (tab: BrowserTab) =>
    cn(
      tab.id === state.activeId ? 'bg-elevated text-text-primary' : tab.id === beside ? 'bg-elevated/50 text-text-primary' : 'text-text-secondary hover:bg-elevated/40',
      drag.over === tab.id && 'shadow-[inset_0_2px_0_0_rgb(var(--accent-cyan))]',
      tab.profile === 'private' && 'bg-purple/8'
    )

  const row = (tab: BrowserTab, group?: BrowserTabGroup) => {
    const title = tabLabel(tab, t.library.pages) || t.browser.untitled
    return (
      <div
        key={tab.id}
        {...common(tab)}
        title={tab.openedBy ? `${title} — ${t.browser.agentTab(tab.openedBy)}` : title}
        className={cn(
          'group relative flex h-8 shrink-0 cursor-default items-center gap-2 rounded-md transition-colors',
          folded ? 'mx-auto w-8 justify-center' : 'pl-2 pr-1',
          group && !folded && 'ml-2.5',
          look(tab)
        )}
      >
        {group && <span className={cn('absolute inset-y-1.5 w-0.5 rounded-full', folded ? '-left-1' : '-left-2', GROUP_STYLES[group.color].dot)} aria-hidden />}
        <Favicon tab={tab} />
        {!folded && (
          <>
            <ProfileMark tab={tab} />
            <span className="min-w-0 flex-1 truncate font-sans text-[12.5px]">{title}</span>
            <TabStatus tab={tab} split={!!splitOf(state, tab.id)} />
            <button
              type="button"
              aria-label={t.browser.closeTab(title)}
              onClick={(e) => {
                e.stopPropagation()
                void run('browser:close', { id: tab.id })
              }}
              className={cn(
                'shrink-0 rounded-sm p-0.5 text-text-muted transition-opacity hover:bg-elevated hover:text-text-primary',
                tab.id === state.activeId ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
            >
              <X size={12} />
            </button>
          </>
        )}
      </div>
    )
  }

  const groupHead = (group: BrowserTabGroup, count: number) => {
    const name = group.title || t.browserTabs.unnamedGroup
    const style = GROUP_STYLES[group.color]
    const edit = (e: MouseEvent) => {
      e.preventDefault()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      useBrowser.getState().editGroup(group.id, { x: r.left, y: r.bottom })
    }
    return (
      <button
        type="button"
        aria-expanded={!group.collapsed}
        aria-label={group.collapsed ? t.browserTabs.expandGroup(name) : t.browserTabs.collapseGroup(name)}
        title={`${name} — ${t.browserTabs.groupTabs(count)} · ${t.browserTabs.groupHint}`}
        onClick={() => void run('browser:groupUpdate', { id: group.id, collapsed: !group.collapsed })}
        onContextMenu={edit}
        onDoubleClick={edit}
        {...drag.target(`g:${group.id}`, (id) => dropOnGroup(useBrowser.getState().state, id, group))}
        className={cn(
          'flex h-7 shrink-0 items-center gap-1.5 rounded-md border font-sans text-[11.5px] font-semibold transition-colors',
          folded ? 'mx-auto w-8 justify-center' : 'px-1.5',
          style.text,
          drag.over === `g:${group.id}` ? cn(style.border, style.soft) : 'border-transparent hover:bg-elevated/40'
        )}
      >
        {!folded && (group.collapsed ? <ChevronRight size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />)}
        <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', style.dot)} aria-hidden />
        {!folded && <span className="min-w-0 flex-1 truncate text-left">{name}</span>}
        {!folded && <span className="font-mono text-[10px] font-normal text-text-muted">{count}</span>}
      </button>
    )
  }

  return (
    <aside aria-label={t.browserTabs.tabs} style={{ width }} className="relative flex shrink-0 flex-col border-r border-hud/50 bg-surface/20">
      <div className={cn('flex shrink-0 items-center gap-1 border-b border-hud/50 px-2 py-1.5', folded && 'flex-col')}>
        <button
          type="button"
          aria-label={folded ? t.browserTabs.expandSidebar : t.browserTabs.collapseSidebar}
          title={folded ? t.browserTabs.expandSidebar : t.browserTabs.collapseSidebar}
          onClick={() => void useBrowser.getState().configure({ verticalTabsCollapsed: !folded })}
          className={icon}
        >
          {folded ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
        {!folded && <span className="flex-1" />}
        <button type="button" aria-label={t.browserTabs.searchTabs} title={t.browserTabs.searchTabs} onClick={() => useBrowser.getState().setTabSearch(true)} className={icon}>
          <Search size={14} />
        </button>
      </div>
      <div role="tablist" aria-orientation="vertical" aria-label={t.browser.title} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden p-1.5">
        {pinned.length > 0 && (
          <div role="group" aria-label={t.browserTabs.pinned} className={cn('mb-1 grid gap-1 border-b border-hud/40 pb-1.5', folded ? 'grid-cols-1' : 'grid-cols-[repeat(auto-fill,minmax(36px,1fr))]')}>
            {pinned.map((tab) => (
              <div
                key={tab.id}
                {...common(tab)}
                title={tabLabel(tab, t.library.pages) || t.browser.untitled}
                className={cn('flex h-9 cursor-default items-center justify-center rounded-md border border-hud/40 transition-colors', look(tab))}
              >
                <Favicon tab={tab} />
              </div>
            ))}
          </div>
        )}
        {tabItems(state).map((item) =>
          item.kind === 'tab' ? (
            row(item.tab)
          ) : (
            <div key={item.group.id} role="group" aria-label={item.group.title || t.browserTabs.unnamedGroup} className="flex flex-col gap-0.5">
              {groupHead(item.group, item.tabs.length)}
              {!item.group.collapsed && item.tabs.map((tab) => row(tab, item.group))}
            </div>
          )
        )}
        <button
          type="button"
          aria-label={t.browser.newTab}
          title={`${t.browser.newTab} (⌘T)`}
          onClick={() => void useBrowser.getState().newTab()}
          {...drag.target('end', (id) => dropAtEnd(useBrowser.getState().state, id))}
          className={cn(
            'flex h-8 shrink-0 items-center gap-2 rounded-md font-sans text-[12.5px] text-text-muted transition-colors hover:bg-elevated/40 hover:text-cyan',
            folded ? 'mx-auto w-8 justify-center' : 'px-2',
            drag.over === 'end' && 'shadow-[inset_0_2px_0_0_rgb(var(--accent-cyan))]'
          )}
        >
          <Plus size={14} className="shrink-0" />
          {!folded && t.browser.newTab}
        </button>
        {/* The empty rest of the list: a double-click opens a tab, a tab dropped here goes last. */}
        <div className="min-h-6 flex-1" onDoubleClick={() => void useBrowser.getState().newTab()} {...drag.target('end', (id) => dropAtEnd(useBrowser.getState().state, id))} />
      </div>
      {!folded && <Resizer width={width} onWidth={setDragWidth} />}
    </aside>
  )
}
