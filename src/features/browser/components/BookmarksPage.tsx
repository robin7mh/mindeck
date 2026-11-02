import { useRef, useState, type DragEvent } from 'react'
import { Download, Folder, FolderPlus, Import, Pencil, Search, Star, Trash2, Upload } from 'lucide-react'
import { isFolder, type BookmarkFolder, type BookmarkNode } from '@shared/types/browserData'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { findNode, nodeName, searchBookmarks } from '../library'
import { useBrowser } from '../store'
import { displayUrl, initial } from '../url'
import { useRootName } from './BookmarkEditor'
import { BOOKMARK_DRAG, openBookmark } from './BookmarksBar'

const small =
  'flex items-center gap-1.5 rounded-md border border-hud/60 px-2.5 py-1 font-sans text-[12px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'

/** Lets a drop through when it carries a bookmark. */
function accept(e: DragEvent): boolean {
  if (!e.dataTransfer.types.includes(BOOKMARK_DRAG)) return false
  e.preventDefault()
  return true
}

/** The folders as a tree; a click shows one, a dropped bookmark moves into it. */
function FolderTree({ folders, selected, onSelect, depth = 0 }: { folders: BookmarkFolder[]; selected: string; onSelect(id: string): void; depth?: number }) {
  const rootName = useRootName()
  const run = useBrowser((s) => s.run)
  const [over, setOver] = useState<string | null>(null)
  return (
    <ul role={depth ? 'group' : 'tree'}>
      {folders.map((f) => {
        const sub = f.children.filter(isFolder)
        return (
          <li key={f.id} role="treeitem" aria-selected={f.id === selected}>
            <button
              type="button"
              onClick={() => onSelect(f.id)}
              onDragOver={(e) => accept(e) && setOver(f.id)}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault()
                setOver(null)
                const id = e.dataTransfer.getData(BOOKMARK_DRAG)
                if (id && id !== f.id) void run('browser:bookmarkMove', { id, parentId: f.id, index: 100_000 })
              }}
              style={{ paddingLeft: 8 + depth * 14 }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md border border-transparent py-1 pr-2 text-left font-sans text-[12.5px] transition-colors',
                f.id === selected ? 'bg-cyan/10 text-cyan' : 'text-text-secondary hover:bg-elevated/50 hover:text-text-primary',
                over === f.id && 'border-cyan/60'
              )}
            >
              <Folder size={13} className="shrink-0" />
              <span className="truncate">{depth ? f.title : rootName(f.id)}</span>
            </button>
            {sub.length > 0 && <FolderTree folders={sub} selected={selected} onSelect={onSelect} depth={depth + 1} />}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The bookmark manager (mindeck://bookmarks): the folders on the left, the
 * open folder on the right — search everything, rename, move by dragging,
 * delete, new folders; import and export bookmark files, or import from
 * another browser.
 */
export function BookmarksPage() {
  const t = useT()
  const tree = useBrowser((s) => s.bookmarks)
  const run = useBrowser((s) => s.run)
  const [folderId, setFolderId] = useState('bar')
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const [over, setOver] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const found = findNode(tree, folderId)?.node
  const folder = found && isFolder(found) ? found : tree[0]
  const hits = query.trim() ? searchBookmarks(tree, query) : null
  const list: (BookmarkNode & { path?: string[] })[] = hits ?? folder.children

  const newFolder = async () => {
    const node = await run('browser:bookmarkAdd', { parentId: folder.id, title: t.library.newFolder })
    if (node) useBrowser.getState().edit(node.id)
  }
  const exportFile = async () => {
    const html = await run('browser:bookmarksExport')
    if (html === undefined) return
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'bookmarks.html'
    a.click()
    URL.revokeObjectURL(url)
  }
  const importFile = async (f: File | undefined) => {
    if (!f) return
    const n = await run('browser:bookmarksImport', { html: await f.text() })
    if (n !== undefined) setNotice(t.library.imported(n))
  }
  /** Dropped on a row of the open folder: the bookmark goes before it. */
  const dropBefore = (e: DragEvent, target: BookmarkNode) => {
    e.preventDefault()
    setOver(null)
    const id = e.dataTransfer.getData(BOOKMARK_DRAG)
    if (id && id !== target.id) void run('browser:bookmarkMove', { id, parentId: folder.id, index: folder.children.indexOf(target) })
  }

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label={t.library.pages.bookmarks} className="w-60 shrink-0 overflow-y-auto border-r border-hud/50 p-2">
        <FolderTree
          folders={tree}
          selected={hits ? '' : folder.id}
          onSelect={(id) => {
            setQuery('')
            setFolderId(id)
          }}
        />
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hud/50 px-4 py-2.5">
          <Star size={16} className="text-cyan" />
          <h1 className="mr-2 font-sans text-[15px] font-semibold text-text-primary">{t.library.pages.bookmarks}</h1>
          <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-md border border-hud/60 bg-surface/60 px-2.5 py-1 focus-within:border-cyan/50">
            <Search size={13} className="text-text-muted" />
            <input
              aria-label={t.library.bookmarksSearch}
              placeholder={t.library.bookmarksSearch}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1 bg-transparent font-sans text-[12.5px] text-text-primary outline-hidden placeholder:text-text-muted"
            />
          </label>
          <button type="button" onClick={() => void newFolder()} className={small}>
            <FolderPlus size={12} /> {t.library.newFolder}
          </button>
          <button type="button" onClick={() => useBrowser.getState().setImport(true)} className={small}>
            <Import size={12} /> {t.library.importBrowser}
          </button>
          <button type="button" onClick={() => file.current!.click()} className={small}>
            <Upload size={12} /> {t.library.importFile}
          </button>
          <input
            ref={file}
            type="file"
            accept=".html,.htm,text/html"
            aria-label={t.library.importFile}
            className="hidden"
            onChange={(e) => {
              void importFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <button type="button" onClick={() => void exportFile()} className={small}>
            <Download size={12} /> {t.library.exportFile}
          </button>
        </div>
        {notice && (
          <p role="status" className="border-b border-green/30 bg-green/6 px-4 py-1.5 font-sans text-[12px] text-text-secondary">
            {notice}
          </p>
        )}
        <ul aria-label={hits ? t.library.bookmarksSearch : folder.title} className="min-h-0 flex-1 overflow-y-auto p-3">
          {!list.length && <li className="py-10 text-center font-sans text-[13px] text-text-muted">{hits ? t.library.noBookmarkHits : t.library.folderEmpty}</li>}
          {list.map((node) => (
            <li
              key={node.id}
              draggable
              onDragStart={(e) => e.dataTransfer.setData(BOOKMARK_DRAG, node.id)}
              onDragOver={(e) => !hits && accept(e) && setOver(node.id)}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => !hits && dropBefore(e, node)}
              className={cn('group flex items-center gap-3 rounded-md border border-transparent px-2.5 py-1.5 hover:bg-elevated/40', over === node.id && 'border-t-cyan/70')}
            >
              <button
                type="button"
                title={isFolder(node) ? node.title : node.url}
                onClick={(e) => (isFolder(node) ? (setQuery(''), setFolderId(node.id)) : openBookmark(node.url, e))}
                onAuxClick={(e) => !isFolder(node) && e.button === 1 && openBookmark(node.url, e)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                {isFolder(node) ? (
                  <Folder size={16} className="shrink-0 text-text-muted" />
                ) : (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-hud/60 bg-elevated/60 font-sans text-[10px] font-semibold text-cyan">{initial(node.url, node.title)}</span>
                )}
                <span className="min-w-0 truncate font-sans text-[12.5px] text-text-primary">{nodeName(node, displayUrl)}</span>
                {!isFolder(node) && <span className="min-w-0 shrink truncate font-mono text-[11px] text-text-muted">{displayUrl(node.url)}</span>}
                {node.path && node.path.length > 0 && <span className="shrink-0 truncate font-sans text-[11px] text-text-muted">· {node.path.join(' › ')}</span>}
              </button>
              <button type="button" aria-label={`${t.library.edit} ${node.title}`} onClick={() => useBrowser.getState().edit(node.id)} className="rounded-sm p-1 text-text-muted opacity-0 hover:bg-elevated hover:text-cyan focus:opacity-100 group-hover:opacity-100">
                <Pencil size={12} />
              </button>
              <button
                type="button"
                aria-label={`${t.library.delete} ${node.title}`}
                onClick={() => void run('browser:bookmarkRemove', { ids: [node.id] })}
                className="rounded-sm p-1 text-text-muted opacity-0 hover:bg-elevated hover:text-danger focus:opacity-100 group-hover:opacity-100"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
