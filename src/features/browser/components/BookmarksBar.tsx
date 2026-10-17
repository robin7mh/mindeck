import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronsRight, Folder } from 'lucide-react'
import { isFolder, type BookmarkFolder, type BookmarkNode } from '@shared/types/browserData'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { nodeName } from '../library'
import { useBrowser } from '../store'
import { initial } from '../url'

export const BOOKMARK_DRAG = 'application/x-mindeck-bookmark'

/** A bookmark's link: the tab on screen goes there; ⌘/Ctrl or the middle button open it in a tab behind. */
export function openBookmark(url: string, e: { metaKey: boolean; ctrlKey: boolean; button: number }): void {
  const store = useBrowser.getState()
  if (e.metaKey || e.ctrlKey || e.button === 1) void store.run('browser:open', { url, background: true })
  else void store.go(url)
}

/** A small menu at a point (a folder's contents, a bookmark's actions) that closes on a click elsewhere or Escape. */
function Popover({ at, onClose, label, children }: { at: { x: number; y: number }; onClose(): void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useOverlay(true)
  useEffect(() => {
    const down = (e: globalThis.MouseEvent) => !ref.current!.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [onClose])
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: at.x, top: at.y }}
      className="fixed z-60 max-h-[70vh] w-64 overflow-y-auto rounded-lg border border-hud/70 bg-panel/95 p-1 shadow-xl shadow-black/40 backdrop-blur-md"
    >
      {children}
    </div>
  )
}

const row = 'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-sans text-[12px] text-text-primary transition-colors hover:bg-cyan/10'

function NodeIcon({ node }: { node: BookmarkNode }) {
  if (isFolder(node)) return <Folder size={13} className="shrink-0 text-text-muted" />
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-xs bg-elevated font-sans text-[9px] font-semibold text-cyan" aria-hidden>
      {initial(node.url, node.title)}
    </span>
  )
}

/** A folder's contents as a menu; subfolders open in place, with a way back. */
function FolderMenu({ folder, at, onClose }: { folder: BookmarkFolder; at: { x: number; y: number }; onClose(): void }) {
  const t = useT()
  const [path, setPath] = useState<BookmarkFolder[]>([folder])
  const current = path[path.length - 1]
  return (
    <Popover at={at} onClose={onClose} label={current.title}>
      {path.length > 1 && (
        <button type="button" role="menuitem" onClick={() => setPath(path.slice(0, -1))} className={cn(row, 'text-text-secondary')}>
          <ChevronLeft size={13} /> {t.library.up}
        </button>
      )}
      {!current.children.length && <p className="px-2 py-1 font-sans text-[12px] text-text-muted">{t.library.empty}</p>}
      {current.children.map((node) => (
        <button
          key={node.id}
          type="button"
          role="menuitem"
          title={isFolder(node) ? node.title : node.url}
          onClick={(e) => {
            if (isFolder(node)) return setPath([...path, node])
            openBookmark(node.url, e)
            onClose()
          }}
          onAuxClick={(e) => {
            if (isFolder(node) || e.button !== 1) return
            openBookmark(node.url, e)
            onClose()
          }}
          className={row}
        >
          <NodeIcon node={node} />
          <span className="min-w-0 flex-1 truncate">{nodeName(node)}</span>
        </button>
      ))}
    </Popover>
  )
}

/** Right-click on a bookmark: open it in a tab, edit, delete. */
function ItemMenu({ node, at, onClose }: { node: BookmarkNode; at: { x: number; y: number }; onClose(): void }) {
  const t = useT()
  const store = useBrowser.getState()
  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }
  return (
    <Popover at={at} onClose={onClose} label={node.title}>
      {!isFolder(node) && (
        <button type="button" role="menuitem" onClick={act(() => void store.run('browser:open', { url: node.url, background: true }))} className={row}>
          {t.library.openInTab}
        </button>
      )}
      <button type="button" role="menuitem" onClick={act(() => store.edit(node.id))} className={row}>
        {t.library.edit}
      </button>
      <button type="button" role="menuitem" onClick={act(() => void store.run('browser:bookmarkRemove', { ids: [node.id] }))} className={cn(row, 'text-danger')}>
        {t.library.delete}
      </button>
    </Popover>
  )
}

const below = (e: MouseEvent) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return { x: r.left, y: r.bottom + 2 }
}

/**
 * The bookmarks bar (⌘⇧B) under the toolbar: links go to the tab on screen,
 * folders open as menus, right-click edits, dragging reorders — or drops a
 * bookmark into a folder.
 */
export function BookmarksBar() {
  const t = useT()
  const show = useBrowser((s) => s.settings.bookmarksBar)
  const [bar, other] = useBrowser((s) => s.bookmarks)
  const [open, setOpen] = useState<{ folder: BookmarkFolder; at: { x: number; y: number } } | null>(null)
  const [menu, setMenu] = useState<{ node: BookmarkNode; at: { x: number; y: number } } | null>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)
  if (!show) return null

  const run = useBrowser.getState().run
  const dragOver = (e: DragEvent, id: string) => {
    if (!e.dataTransfer.types.includes(BOOKMARK_DRAG)) return
    e.preventDefault()
    e.stopPropagation()
    setDropAt(id)
  }
  /** Onto a folder: into it. Onto a link: before it. Onto the bar's free space: at its end. */
  const drop = (e: DragEvent, target?: BookmarkNode) => {
    e.preventDefault()
    e.stopPropagation()
    setDropAt(null)
    const id = e.dataTransfer.getData(BOOKMARK_DRAG)
    if (!id || id === target?.id) return
    if (target && isFolder(target)) void run('browser:bookmarkMove', { id, parentId: target.id, index: 100_000 })
    else void run('browser:bookmarkMove', { id, parentId: 'bar', index: target ? bar.children.indexOf(target) : bar.children.length })
  }

  return (
    <div
      role="toolbar"
      aria-label={t.library.bar}
      className="flex h-7 shrink-0 items-center gap-0.5 overflow-hidden border-b border-hud/50 bg-surface/20 px-2"
      onDragOver={(e) => dragOver(e, 'bar')}
      onDrop={(e) => drop(e)}
    >
      {!bar.children.length && (
        <span className="truncate font-sans text-[11.5px] text-text-muted">
          {t.library.barEmpty}{' '}
          <button type="button" onClick={() => useBrowser.getState().setImport(true)} className="text-cyan hover:underline">
            {t.library.importLink}
          </button>
        </span>
      )}
      {bar.children.map((node) => (
        <button
          key={node.id}
          type="button"
          draggable
          title={isFolder(node) ? node.title : `${node.title}\n${node.url}`}
          onDragStart={(e) => e.dataTransfer.setData(BOOKMARK_DRAG, node.id)}
          onDragOver={(e) => dragOver(e, node.id)}
          onDragLeave={() => setDropAt((d) => (d === node.id ? null : d))}
          onDrop={(e) => drop(e, node)}
          onClick={(e) => (isFolder(node) ? setOpen({ folder: node, at: below(e) }) : openBookmark(node.url, e))}
          onAuxClick={(e) => !isFolder(node) && e.button === 1 && openBookmark(node.url, e)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ node, at: { x: e.clientX, y: e.clientY } })
          }}
          className={cn(
            'flex h-6 min-w-0 max-w-[180px] shrink-0 items-center gap-1.5 rounded-md border border-transparent px-2 font-sans text-[11.5px] text-text-secondary transition-colors hover:bg-elevated/60 hover:text-text-primary',
            dropAt === node.id && 'border-cyan/60'
          )}
        >
          <NodeIcon node={node} />
          <span className="truncate">{nodeName(node)}</span>
        </button>
      ))}
      {other.children.length > 0 && (
        <button
          type="button"
          aria-label={t.library.other}
          title={t.library.other}
          onClick={(e) => setOpen({ folder: { ...other, title: t.library.other }, at: below(e) })}
          className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md px-2 font-sans text-[11.5px] text-text-secondary hover:bg-elevated/60 hover:text-text-primary"
        >
          <ChevronsRight size={12} /> {t.library.other}
        </button>
      )}
      {open && <FolderMenu folder={open.folder} at={open.at} onClose={() => setOpen(null)} />}
      {menu && <ItemMenu node={menu.node} at={menu.at} onClose={() => setMenu(null)} />}
    </div>
  )
}
