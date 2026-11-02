import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Columns2, Copy, Rows2, X, XCircle, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { isMac } from '@/lib/platform'
import { useEditor, type EditorTab } from '../store'
import { useT } from '@/lib/i18n'
import { fileIcon } from './FileTree'
import { shortcutLabel } from '@/lib/shortcuts'

/** What a dragged tab carries: its file and the group it leaves. */
export const TAB_MIME = 'application/x-mindeck-editor-tab'

export interface DraggedTab {
  id: string
  group: string
}

/** The tab being dragged, if the drag is one (other drags — files, text — are not). */
export function draggedTab(e: Pick<DragEvent, 'dataTransfer'>): DraggedTab | undefined {
  try {
    const raw = JSON.parse(e.dataTransfer.getData(TAB_MIME)) as Partial<DraggedTab>
    return typeof raw.id === 'string' && typeof raw.group === 'string' ? { id: raw.id, group: raw.group } : undefined
  } catch {
    return undefined
  }
}

/** A tab drag is over: ⌥ (Ctrl elsewhere) copies instead of moving, like VS Code. */
export const isTabDrag = (e: Pick<DragEvent, 'dataTransfer'>) => Array.from(e.dataTransfer.types).includes(TAB_MIME)
export const copyDrag = (e: Pick<DragEvent, 'altKey' | 'ctrlKey'>) => (isMac ? e.altKey : e.ctrlKey)

/**
 * Same-named tabs (two `index.ts`) get their folder as a hint, like VS Code —
 * or the project's name for files at a project root.
 */
function hints(tabs: EditorTab[], projectNames: Map<string, string>): Map<string, string> {
  const count = new Map<string, number>()
  for (const t of tabs) count.set(t.name, (count.get(t.name) ?? 0) + 1)
  return new Map(
    tabs
      .filter((t) => count.get(t.name)! > 1)
      .map((t) => [t.id, t.path.split('/').slice(-2, -1)[0] ?? projectNames.get(t.projectId) ?? ''])
  )
}

const iconButton = 'flex h-6 w-6 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-elevated/60 hover:text-text-primary'

interface Menu {
  id: string
  x: number
  y: number
}

/** A tab's context menu: close, split, copy the path. */
function TabMenu({ menu, group, onClose }: { menu: Menu; group: string; onClose: () => void }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const several = useEditor((s) => s.groups.length > 1)
  const path = useEditor((s) => s.tabs.find((x) => x.id === menu.id)?.path)

  useEffect(() => {
    const outside = (e: MouseEvent) => !ref.current!.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', outside)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', outside)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  const editor = () => useEditor.getState()
  const split = (side: 'right' | 'down') => () => {
    editor().focusGroup(group)
    editor().split(side, menu.id)
  }
  const items: { label: string; icon: LucideIcon; hint?: string; action: () => void; hidden?: boolean }[] = [
    { label: t.editor.close, icon: X, action: () => editor().requestClose(menu.id, group) },
    { label: t.editor.closeOthers, icon: XCircle, action: () => editor().closeOthers(menu.id, group) },
    { label: t.editor.splitRight, icon: Columns2, hint: shortcutLabel('editor.split', isMac), action: split('right') },
    { label: t.editor.splitDown, icon: Rows2, hint: shortcutLabel('editor.splitDown', isMac), action: split('down') },
    { label: t.editor.closeGroup, icon: X, action: () => editor().closeGroup(group), hidden: !several },
    { label: t.explorer.copyPath, icon: Copy, action: () => void navigator.clipboard?.writeText(path!), hidden: !path }
  ]

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t.editor.tabActions}
      style={{ left: menu.x, top: menu.y }}
      className="fixed z-70 min-w-[200px] rounded-md border border-hud/70 bg-panel/95 p-1 shadow-xl shadow-black/40 backdrop-blur-md"
    >
      {items
        .filter((i) => !i.hidden)
        .map(({ label, icon: Icon, hint, action }) => (
          <button
            key={label}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose()
              action()
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-sans text-[12.5px] text-text-primary hover:bg-elevated/70"
          >
            <Icon size={13} className="shrink-0 opacity-80" />
            <span className="flex-1">{label}</span>
            {hint && <span className="font-mono text-[10.5px] text-text-muted">{hint}</span>}
          </button>
        ))}
    </div>
  )
}

/**
 * A group's open files. A dot marks unsaved edits (it turns into × on hover);
 * middle-click closes, like in VS Code. Tabs drag to another place, another
 * group's tabs or an editor's edge (a new group); the right-click menu splits.
 */
export function EditorTabs({ group, projectNames }: { group: string; projectNames: Map<string, string> }) {
  const tr = useT()
  const ids = useEditor((s) => s.groups.find((g) => g.id === group)?.tabs)
  const activeId = useEditor((s) => s.groups.find((g) => g.id === group)?.activeId)
  const several = useEditor((s) => s.groups.length > 1)
  const focused = useEditor((s) => s.activeGroup === group) && several
  const all = useEditor((s) => s.tabs)
  const tabs = (ids ?? []).flatMap((id) => all.filter((t) => t.id === id))
  const hint = hints(tabs, projectNames)
  const { setActive, requestClose, moveTab } = useEditor.getState()
  const [menu, setMenu] = useState<Menu>()
  /** Where a dragged tab would land (before the tab at this index). */
  const [dropAt, setDropAt] = useState<number>()

  const over = (e: DragEvent, index: number) => {
    if (!isTabDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = copyDrag(e) ? 'copy' : 'move'
    setDropAt(index)
  }
  const drop = (e: DragEvent, index: number) => {
    const dragged = draggedTab(e)
    setDropAt(undefined)
    if (!dragged) return
    e.preventDefault()
    e.stopPropagation()
    moveTab(dragged.id, dragged.group, group, { index, copy: copyDrag(e) })
  }

  return (
    <div className={cn('flex h-9 shrink-0 border-b', focused ? 'border-cyan/30' : 'border-hud/60')}>
      <div
        role="tablist"
        aria-label={tr.editor.openFiles}
        onDragOver={(e) => over(e, tabs.length)}
        onDragLeave={() => setDropAt(undefined)}
        onDrop={(e) => drop(e, tabs.length)}
        className="flex min-w-0 flex-1 overflow-x-auto"
      >
        {tabs.map((t, i) => {
          const active = t.id === activeId
          const { Icon, tint } = fileIcon(t.name)
          // Over a tab's right half, the drop goes after it.
          const side = (e: DragEvent<HTMLDivElement>) => {
            const box = e.currentTarget.getBoundingClientRect()
            return box.width && e.clientX > box.left + box.width / 2 ? i + 1 : i
          }
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              draggable
              title={`${projectNames.get(t.projectId) ?? t.projectId} · ${t.path}`}
              onClick={() => setActive(t.id, group)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  requestClose(t.id, group)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ id: t.id, x: e.clientX, y: e.clientY })
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_MIME, JSON.stringify({ id: t.id, group } satisfies DraggedTab))
                e.dataTransfer.effectAllowed = 'copyMove'
              }}
              onDragOver={(e) => over(e, side(e))}
              onDrop={(e) => drop(e, side(e))}
              className={cn(
                'group relative flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-hud/40 pl-3 pr-1.5 font-sans text-[12.5px] transition-colors',
                active ? 'bg-elevated/50 text-text-primary' : 'text-text-muted hover:bg-elevated/30 hover:text-text-secondary'
              )}
            >
              {active && <span className={cn('absolute inset-x-0 top-0 h-px', focused || !several ? 'bg-cyan' : 'bg-text-muted')} />}
              {dropAt === i && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-sm bg-cyan" />}
              {dropAt === i + 1 && i === tabs.length - 1 && <span aria-hidden className="absolute inset-y-1 right-0 w-0.5 rounded-sm bg-cyan" />}
              <Icon size={13} className={cn('shrink-0', tint)} />
              <span className={cn(t.deleted && 'line-through')}>{t.name}</span>
              {hint.has(t.id) && <span className="font-mono text-[10px] text-text-muted">{hint.get(t.id)}</span>}
              <button
                type="button"
                aria-label={tr.editor.closeFile(t.name)}
                onClick={(e) => {
                  e.stopPropagation()
                  requestClose(t.id, group)
                }}
                className="relative ml-0.5 flex h-5 w-5 items-center justify-center rounded-sm text-text-muted hover:bg-elevated hover:text-text-primary"
              >
                {t.dirty && <span aria-label={tr.editor.unsaved} className="h-2 w-2 rounded-full bg-text-secondary group-hover:hidden" />}
                <X size={12} className={cn(t.dirty ? 'hidden group-hover:block' : active ? '' : 'opacity-0 group-hover:opacity-100')} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 px-1">
        <button
          type="button"
          aria-label={tr.editor.splitRight}
          title={`${tr.editor.splitRight} (${shortcutLabel('editor.split', isMac)})`}
          onClick={() => {
            useEditor.getState().focusGroup(group)
            useEditor.getState().split('right')
          }}
          className={iconButton}
        >
          <Columns2 size={13} />
        </button>
        {several && (
          <button type="button" aria-label={tr.editor.closeGroup} title={tr.editor.closeGroup} onClick={() => useEditor.getState().closeGroup(group)} className={iconButton}>
            <X size={13} />
          </button>
        )}
      </div>
      {menu && <TabMenu menu={menu} group={group} onClose={() => setMenu(undefined)} />}
    </div>
  )
}
