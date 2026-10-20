import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Ellipsis, Folder } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import type { FileEntry } from '@shared/types/files'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useEditor, type EditorTab } from '../store'
import { revealOf, symbolPath, useOutline, type OutlineSymbol } from '../outline'
import { fileIcon } from './FileTree'
import { symbolIcon } from './symbolIcon'

/** What a breadcrumb opens: a folder's entries, or the symbols next to one. */
type Picking = { at: number; dir: string } | { at: number; symbols: OutlineSymbol[] }

interface Item {
  key: string
  label: string
  icon: ReactNode
  run: () => void
}

/** The list under a breadcrumb: type to filter, Enter or a click picks. */
function Picker({ label, items, onClose }: { label: string; items: Item[]; onClose: () => void }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const shown = items.filter((i) => i.label.toLowerCase().includes(query.trim().toLowerCase()))

  useEffect(() => {
    const outside = (e: MouseEvent) => !ref.current!.contains(e.target as Node) && onClose()
    window.addEventListener('mousedown', outside)
    return () => window.removeEventListener('mousedown', outside)
  }, [onClose])

  const pick = (item: Item) => {
    onClose()
    item.run()
  }
  return (
    <div ref={ref} role="dialog" aria-label={label} className="absolute left-0 top-full z-30 mt-0.5 w-72 rounded-md border border-hud/70 bg-panel/95 p-1 shadow-xl shadow-black/40 backdrop-blur-md">
      <input
        autoFocus
        aria-label={t.editor.outlineFilter}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'Enter' && shown[0]) pick(shown[0])
        }}
        className="mb-1 w-full rounded-sm border border-hud/60 bg-transparent px-2 py-1 font-sans text-[12px] text-text-primary outline-hidden focus:border-cyan/50"
      />
      <ul role="listbox" aria-label={label} className="max-h-72 overflow-y-auto">
        {shown.map((item) => (
          <li key={item.key} role="option" aria-selected={false} onClick={() => pick(item)} className="flex cursor-pointer items-center gap-1.5 truncate rounded-sm px-2 py-1 font-sans text-[12px] text-text-primary hover:bg-elevated/70">
            {item.icon}
            <span className="truncate">{item.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A folder's entries as picker items: files open in the group, folders open further. */
function useFolderItems(projectId: string, dir: string | undefined, onDir: (dir: string) => void, group: string): Item[] {
  const [entries, setEntries] = useState<FileEntry[]>([])
  useEffect(() => {
    if (dir === undefined) return
    let current = true
    void ipc('files:list', { projectId, dir })
      .catch(() => [])
      .then((list) => current && setEntries(list))
    return () => {
      current = false
    }
  }, [projectId, dir])
  if (dir === undefined) return []
  return entries.map((e) => {
    const { Icon, tint } = fileIcon(e.name)
    return {
      key: e.path,
      label: e.name,
      icon: e.kind === 'dir' ? <Folder size={13} className="shrink-0 text-text-muted" /> : <Icon size={13} className={cn('shrink-0', tint)} />,
      run: () => (e.kind === 'dir' ? onDir(e.path) : void useEditor.getState().open(e.path, { group }))
    }
  })
}

/**
 * The path of the file above its editor, then the symbols around the cursor
 * (from the language services, like VS Code). Each crumb opens a list of its
 * neighbours: the other files of a folder, the other symbols of a level.
 */
export function Breadcrumbs({ tab, group }: { tab: EditorTab; group: string }) {
  const t = useT()
  const symbols = useOutline((s) => s.symbols[tab.id])
  const cursor = useOutline((s) => s.cursors[group])
  const trail = symbols && cursor ? symbolPath(symbols, cursor) : []
  const [picking, setPicking] = useState<Picking>()
  const parts = tab.path.split('/')
  const pickDir = picking && 'dir' in picking ? picking.dir : undefined
  const folderItems = useFolderItems(tab.projectId, pickDir, (dir) => setPicking({ at: picking!.at, dir }), group)
  useEffect(() => setPicking(undefined), [tab.id])

  const symbolItems = (list: OutlineSymbol[]): Item[] =>
    list.map((s, i) => {
      const { Icon, tint } = symbolIcon(s.kind)
      return {
        key: `${i}:${s.name}`,
        label: s.name,
        icon: <Icon size={13} className={cn('shrink-0', tint)} />,
        run: () => useEditor.setState({ reveal: { id: tab.id, ...revealOf(s), group } })
      }
    })

  const crumb = (at: number, label: string, icon: ReactNode, open: Picking, named = true) => (
    <span className="relative flex min-w-0 shrink items-center">
      <button
        type="button"
        aria-label={named ? undefined : label}
        aria-expanded={picking?.at === at}
        onClick={() => setPicking(picking?.at === at ? undefined : open)}
        className={cn('flex min-w-0 items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-elevated/60 hover:text-text-primary', picking?.at === at && 'bg-elevated/60 text-text-primary')}
      >
        {icon}
        {named && <span className="truncate">{label}</span>}
      </button>
      {picking?.at === at && (
        <Picker label={t.editor.breadcrumbItems(label)} items={'dir' in picking ? folderItems : symbolItems(picking.symbols)} onClose={() => setPicking(undefined)} />
      )}
    </span>
  )

  const { Icon: FileIcon, tint } = fileIcon(tab.name)
  const crumbs = [
    ...parts.slice(0, -1).map((part, i) => crumb(i, part, null, { at: i, dir: parts.slice(0, i).join('/') })),
    crumb(parts.length - 1, tab.name, <FileIcon size={12} className={cn('shrink-0', tint)} />, { at: parts.length - 1, dir: parts.slice(0, -1).join('/') }),
    ...trail.map((s, i) => {
      const { Icon, tint: symbolTint } = symbolIcon(s.kind)
      return crumb(parts.length + i, s.name, <Icon size={12} className={cn('shrink-0', symbolTint)} />, { at: parts.length + i, symbols: i ? trail[i - 1].children : symbols! })
    })
  ]
  // Outside every symbol: the file's top-level ones are one click away.
  const more = !trail.length && !!symbols?.length

  return (
    <nav aria-label={t.editor.breadcrumbs} className="flex h-6 shrink-0 items-center gap-0.5 border-b border-hud/40 px-2 font-sans text-[11.5px] text-text-muted">
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <ChevronRight size={11} className="shrink-0 opacity-60" />}
          {c}
        </Fragment>
      ))}
      {more && (
        <>
          <ChevronRight size={11} className="shrink-0 opacity-60" />
          {crumb(-1, t.scm.panes.outline, <Ellipsis size={12} />, { at: -1, symbols: symbols! }, false)}
        </>
      )}
    </nav>
  )
}
