import { useState, type KeyboardEvent } from 'react'
import { Star, X } from 'lucide-react'
import { isFolder, type BookmarkFolder, type BookmarkNode } from '@shared/types/browserData'
import { Select } from '@/components/ui/Select'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { findNode, folderChoices } from '../library'
import { useBrowser } from '../store'

export const field =
  'w-full rounded-md border border-hud/60 bg-surface/50 px-2.5 py-1.5 font-sans text-[12.5px] text-text-primary outline-hidden focus:border-cyan/60'
export const dialogButton = 'rounded-md border border-hud/60 px-3 py-1.5 font-sans text-[12px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'

/** The two root folders by their names in the UI language. */
export function useRootName(): (id: string) => string {
  const t = useT()
  return (id) => (id === 'bar' ? t.library.bar : t.library.other)
}

/** A list of folders to pick from, indented by depth. */
export function FolderSelect({ value, onChange, except }: { value: string; onChange: (id: string) => void; except?: string }) {
  const t = useT()
  const tree = useBrowser((s) => s.bookmarks)
  const rootName = useRootName()
  const options = folderChoices(tree, rootName, except).map((f) => ({ value: f.id, label: `${'   '.repeat(f.depth)}${f.label}` }))
  return <Select label={t.library.folder} value={value} options={options} onChange={onChange} />
}

function Editor({ node, parent, added }: { node: BookmarkNode; parent: BookmarkFolder; added?: boolean }) {
  const t = useT()
  useOverlay(true)
  const [title, setTitle] = useState(node.title)
  const [url, setUrl] = useState(isFolder(node) ? '' : node.url)
  const [folder, setFolder] = useState(parent.id)
  const close = () => useBrowser.getState().edit()
  const run = useBrowser.getState().run

  const done = async () => {
    const patch = { ...(title !== node.title ? { title } : {}), ...(!isFolder(node) && url.trim() && url.trim() !== node.url ? { url: url.trim() } : {}) }
    if (Object.keys(patch).length) await run('browser:bookmarkUpdate', { id: node.id, ...patch })
    // Into another folder: at its end.
    if (folder !== parent.id) await run('browser:bookmarkMove', { id: node.id, parentId: folder, index: 100_000 })
    close()
  }
  const remove = async () => {
    await run('browser:bookmarkRemove', { ids: [node.id] })
    close()
  }
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Enter') void done()
    else if (e.key === 'Escape') close()
  }
  const heading = added ? t.library.added : isFolder(node) ? t.library.folderTitle : t.library.editTitle

  return (
    <div role="dialog" aria-label={heading} className="fixed inset-0 z-60 flex justify-center bg-void/40 pt-[12vh]" onMouseDown={close}>
      <div className="h-fit w-[min(420px,90vw)] rounded-lg border border-hud/70 bg-panel/95 p-4 shadow-2xl shadow-black/50 backdrop-blur-md" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          {!isFolder(node) && <Star size={15} className="fill-current text-amber" />}
          <h2 className="flex-1 font-sans text-[14px] font-semibold text-text-primary">{heading}</h2>
          <button type="button" aria-label={t.common.close} onClick={close} className="rounded-sm p-1 text-text-muted hover:bg-elevated hover:text-text-primary">
            <X size={14} />
          </button>
        </div>
        <label className="mb-2 block">
          <span className="mb-1 block font-sans text-[12px] text-text-secondary">{t.library.name}</span>
          <input autoFocus aria-label={t.library.name} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={keys} onFocus={(e) => e.target.select()} className={field} />
        </label>
        {!isFolder(node) && (
          <label className="mb-2 block">
            <span className="mb-1 block font-sans text-[12px] text-text-secondary">{t.library.url}</span>
            <input aria-label={t.library.url} value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} onKeyDown={keys} className={`${field} font-mono`} />
          </label>
        )}
        <div className="mb-4 block">
          <span className="mb-1 block font-sans text-[12px] text-text-secondary">{t.library.folder}</span>
          <FolderSelect value={folder} onChange={setFolder} except={isFolder(node) ? node.id : undefined} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => void remove()} className={`${dialogButton} hover:border-danger/50 hover:text-danger`}>
            {t.library.remove}
          </button>
          <button type="button" onClick={() => void done()} className={`${dialogButton} border-cyan/50 text-cyan`}>
            {t.library.done}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The bookmark editor (⌘D, the star, "Edit…"): name, address and folder —
 * or remove it. A freshly added bookmark opens here, as in Chrome.
 */
export function BookmarkEditor() {
  const editing = useBrowser((s) => s.editing)
  const tree = useBrowser((s) => s.bookmarks)
  const hit = editing ? findNode(tree, editing.id) : undefined
  // Not there (yet): the tree push follows the add a moment later. A root folder has nothing to edit.
  if (!editing || !hit?.parent) return null
  return <Editor key={editing.id} node={hit.node} parent={hit.parent} added={editing.added} />
}
