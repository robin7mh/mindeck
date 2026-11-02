import { useEffect, useRef, type MouseEvent } from 'react'
import { Plus, X } from 'lucide-react'
import type { BrowserTab, BrowserTabGroup } from '@shared/types/browser'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { tabLabel } from '../library'
import { splitOf, useBrowser } from '../store'
import { dropAtEnd, dropOnGroup, dropOnTab, GROUP_STYLES, tabItems } from '../tabs'
import { Favicon, ProfileMark, TabStatus, useTabDrag } from './TabParts'

type Drag = ReturnType<typeof useTabDrag>

/** Right-click on a tab: its native menu. */
const tabMenu = (id: string) => void useBrowser.getState().run('browser:tool', { id, tool: 'tabMenu' })

/** A group's chip: its color and name; click folds it, right-click (or double-click) edits it, a tab dropped on it joins. */
export function GroupChip({ group, count, drag, className }: { group: BrowserTabGroup; count: number; drag: Drag; className?: string }) {
  const t = useT()
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
      onClick={() => void useBrowser.getState().run('browser:groupUpdate', { id: group.id, collapsed: !group.collapsed })}
      onContextMenu={edit}
      onDoubleClick={edit}
      {...drag.target(`g:${group.id}`, (id) => dropOnGroup(useBrowser.getState().state, id, group))}
      className={cn(
        'flex h-6 max-w-[160px] shrink-0 items-center gap-1.5 rounded-md border px-2 font-sans text-[11.5px] font-semibold transition-colors',
        style.soft,
        style.text,
        drag.over === `g:${group.id}` ? style.border : 'border-transparent',
        className
      )}
    >
      <span className={cn('h-2 w-2 shrink-0 rounded-full', style.dot)} aria-hidden />
      {group.title && <span className="truncate">{group.title}</span>}
      {group.collapsed && <span className="font-mono text-[10px] font-normal opacity-80">{count}</span>}
    </button>
  )
}

/**
 * The tabs: favicon, title, sound, the agent's mark — groups as colored
 * chips with their tabs underlined, tabs in a split view marked. Click shows
 * a tab, middle-click or × closes it, right-click opens its native menu,
 * dragging reorders (onto a group's chip or among its tabs: into the group;
 * onto the page: beside it) — pinned tabs stay small and first.
 */
export function TabStrip() {
  const t = useT()
  const state = useBrowser((s) => s.state)
  const run = useBrowser((s) => s.run)
  const drag = useTabDrag()
  const beside = splitOf(state, state.activeId)?.tabs.find((id) => id !== state.activeId)
  // The shown tab stays in sight: a new one at the end scrolls the strip to it.
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current!.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [state.activeId])

  const renderTab = (tab: BrowserTab, group?: BrowserTabGroup) => {
    const active = tab.id === state.activeId
    const title = tabLabel(tab, t.library.pages) || t.browser.untitled
    const agentic = !!tab.openedBy
    return (
      <div
        key={tab.id}
        role="tab"
        aria-selected={active}
        title={agentic ? `${title} — ${t.browser.agentTab(tab.openedBy!)}` : title}
        {...drag.source(tab)}
        {...drag.target(tab.id, (id) => dropOnTab(useBrowser.getState().state, id, tab))}
        onClick={() => !active && void run('browser:activate', { id: tab.id })}
        onAuxClick={(e) => e.button === 1 && void run('browser:close', { id: tab.id })}
        onContextMenu={(e) => {
          e.preventDefault()
          tabMenu(tab.id)
        }}
        className={cn(
          'group relative flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 transition-colors',
          tab.pinned ? 'w-9 justify-center px-0' : 'w-[clamp(120px,14vw,220px)] pl-2.5 pr-1',
          active ? 'border-hud/70 bg-surface text-text-primary' : tab.id === beside ? 'border-hud/40 bg-surface/50 text-text-primary' : 'border-transparent text-text-secondary hover:bg-elevated/40',
          drag.over === tab.id && 'border-cyan/60',
          group && GROUP_STYLES[group.color].line,
          agentic && !group && 'shadow-[inset_0_2px_0_0_rgb(var(--accent-purple)/0.8)]',
          tab.profile === 'private' && 'bg-purple/8'
        )}
      >
        <Favicon tab={tab} />
        <ProfileMark tab={tab} />
        {!tab.pinned && <span className="min-w-0 flex-1 truncate font-sans text-[12px]">{title}</span>}
        {!tab.pinned && <TabStatus tab={tab} split={!!splitOf(state, tab.id)} />}
        {!tab.pinned && (
          <button
            type="button"
            aria-label={t.browser.closeTab(title)}
            onClick={(e) => {
              e.stopPropagation()
              void run('browser:close', { id: tab.id })
            }}
            className={cn(
              'shrink-0 rounded-sm p-0.5 text-text-muted transition-opacity hover:bg-elevated hover:text-text-primary',
              active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <X size={12} />
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className="flex h-9 shrink-0 items-end gap-1 border-b border-hud/50 px-2 pt-1.5"
      onDoubleClick={(e) => e.target === e.currentTarget && void useBrowser.getState().newTab()}
      {...drag.target('end', (id) => dropAtEnd(useBrowser.getState().state, id))}
    >
      <div ref={list} role="tablist" aria-label={t.browser.title} className="flex min-w-0 items-end gap-1 overflow-x-auto">
        {state.tabs.filter((tab) => tab.pinned).map((tab) => renderTab(tab))}
        {tabItems(state).map((item) =>
          item.kind === 'tab' ? (
            renderTab(item.tab)
          ) : (
            <div key={item.group.id} role="group" aria-label={item.group.title || t.browserTabs.unnamedGroup} className="flex shrink-0 items-end gap-1">
              <GroupChip group={item.group} count={item.tabs.length} drag={drag} className="mb-0.5" />
              {!item.group.collapsed && item.tabs.map((tab) => renderTab(tab, item.group))}
            </div>
          )
        )}
      </div>
      <button
        type="button"
        aria-label={t.browser.newTab}
        title={`${t.browser.newTab} (⌘T)`}
        onClick={() => void useBrowser.getState().newTab()}
        className="mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-cyan"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
