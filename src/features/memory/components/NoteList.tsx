import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, CopyMinus, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, Search, X } from 'lucide-react'
import type { GraphStyle, NoteMeta, SearchHit } from '@shared/types/memory'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import type { Creating } from '../store'
import { slotColor } from './GraphView'

interface Props {
  notes: NoteMeta[]
  folders: string[]
  hits: SearchHit[]
  query: string
  activePath?: string
  folderSlots: Map<string, number>
  style: GraphStyle
  creating: Creating | null
  /** The folders open (the rest are closed — all of them after a start). */
  openFolders: string[]
  onToggleFolder: (dir: string) => void
  onCollapseAll: () => void
  /** The vault in the Finder (the desktop only). */
  onShowInFinder?: () => void
  onSearch: (q: string) => void
  onOpen: (path: string) => void
  onStartCreate: (kind: Creating['kind'], parent: string) => void
  onCancelCreate: () => void
  onSubmitCreate: (name: string) => void
  onMoveNote: (path: string, folder: string) => void
  onMoveFolder: (folder: string, into: string) => void
}

const NOTE_MIME = 'application/x-mindeck-note'
const FOLDER_MIME = 'application/x-mindeck-folder'
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/**
 * Vault sidebar: a row of tools (search, the vault in the Finder, new note,
 * new folder, collapse all) — the magnifier turns it into the search field —
 * then notes grouped by folder (root first). Notes and folders can be dragged
 * onto a folder — or onto the empty space below, which is the vault root. New
 * notes/folders get their name in an inline input.
 */
export function NoteList(p: Props) {
  const t = useT()
  const [input, setInput] = useState(p.query)
  const [searching, setSearching] = useState(!!p.query)
  const [dropTarget, setDropTarget] = useState<string | null>(null) // '' = root

  const { onSearch } = p
  useEffect(() => {
    const id = window.setTimeout(() => onSearch(input), 150)
    return () => window.clearTimeout(id)
  }, [input, onSearch])

  const groups = useMemo(() => {
    const map = new Map<string, NoteMeta[]>([['', []]])
    for (const f of p.folders) map.set(f, [])
    for (const n of p.notes) map.set(dirOf(n.path), [...(map.get(dirOf(n.path)) ?? []), n])
    // The root ('') was inserted first, so it stays on top; folders sort by name.
    const [root, ...folders] = [...map.entries()]
    return [root, ...folders.sort(([a], [b]) => a.localeCompare(b))].map(
      ([dir, items]) => [dir, items.sort((x, y) => x.title.localeCompare(y.title))] as const
    )
  }, [p.notes, p.folders])

  const dot = (folder: string) =>
    p.style.mode === 'colorful' ? slotColor(p.folderSlots.get(folder) ?? 0) : `rgb(var(--graph-${p.style.color}))`

  // "Collapse all": nothing to do when no folder is open.
  const anyOpen = groups.some(([dir]) => dir && p.openFolders.includes(dir))
  // Closing the search empties it and brings the tools back.
  const closeSearch = () => {
    setInput('')
    p.onSearch('')
    setSearching(false)
  }

  // --- drag & drop ---------------------------------------------------------
  const dropProps = (folder: string) => ({
    onDragOver: (e: React.DragEvent) => {
      const types = e.dataTransfer.types
      if (!types.includes(NOTE_MIME) && !types.includes(FOLDER_MIME)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (dropTarget !== folder) setDropTarget(folder)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget((d) => (d === folder ? null : d))
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(null)
      const note = e.dataTransfer.getData(NOTE_MIME)
      const dir = e.dataTransfer.getData(FOLDER_MIME)
      if (note && dirOf(note) !== folder) p.onMoveNote(note, folder)
      if (dir && dir !== folder && !folder.startsWith(`${dir}/`) && dirOf(dir) !== folder) p.onMoveFolder(dir, folder)
    }
  })
  const dragNote = (path: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData(NOTE_MIME, path)
    e.dataTransfer.effectAllowed = 'move'
  }
  const dragFolder = (dir: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData(FOLDER_MIME, dir)
    e.dataTransfer.effectAllowed = 'move'
  }

  const createRow = (parent: string) =>
    p.creating && p.creating.parent === parent ? (
      <CreateInput
        kind={p.creating.kind}
        indent={parent !== ''}
        onSubmit={p.onSubmitCreate}
        onCancel={p.onCancelCreate}
      />
    ) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 px-2">
        {searching ? (
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-hud/60 bg-surface/50 px-2.5 py-1.5 focus-within:border-cyan/50">
            <Search size={13} className="shrink-0 text-text-muted" />
            <input
              autoFocus
              aria-label={t.memory.search}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && closeSearch()}
              placeholder={t.memory.search}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent font-sans text-[12px] text-text-primary outline-hidden placeholder:text-text-muted/70"
            />
            <button type="button" title={t.memory.closeSearch} aria-label={t.memory.closeSearch} onClick={closeSearch}>
              <X size={13} className="text-text-muted hover:text-text-primary" />
            </button>
          </label>
        ) : (
          <>
            <Tool label={t.memory.search} onClick={() => setSearching(true)}>
              <Search size={15} />
            </Tool>
            {p.onShowInFinder && (
              <Tool label={t.memory.showInFinder} aria={t.memory.showVault} onClick={p.onShowInFinder}>
                <FolderOpen size={15} />
              </Tool>
            )}
            <Tool label={t.memory.newNote} onClick={() => p.onStartCreate('note', '')}>
              <FilePlus2 size={15} />
            </Tool>
            <Tool label={t.memory.newFolder} onClick={() => p.onStartCreate('folder', '')}>
              <FolderPlus size={15} />
            </Tool>
            <Tool label={t.memory.collapseAll} onClick={p.onCollapseAll} disabled={!anyOpen}>
              <CopyMinus size={15} />
            </Tool>
          </>
        )}
      </div>

      {/* The whole scroll area is the vault-root drop zone; folders override it. */}
      <div
        {...dropProps('')}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-2 pb-3 transition-colors',
          dropTarget === '' && 'bg-cyan/4 outline-dashed outline-1 -outline-offset-4 outline-cyan/40'
        )}
      >
        {p.query.trim() ? (
          <div className="space-y-1">
            <TechLabel className="block px-1.5 py-1 text-text-muted">{t.memory.results(p.hits.length)}</TechLabel>
            {p.hits.map((h) => (
              <button
                key={h.path}
                type="button"
                onClick={() => p.onOpen(h.path)}
                className={cn(
                  'w-full rounded-md border px-2.5 py-2 text-left transition-colors',
                  h.path === p.activePath ? 'border-cyan/40 bg-cyan/6' : 'border-transparent hover:bg-elevated/50'
                )}
              >
                <span className="block truncate font-sans text-[12.5px] font-medium text-text-primary">
                  <Marked text={h.title} ranges={h.titleMatches} />
                </span>
                {h.snippet && (
                  <span className="mt-0.5 line-clamp-3 font-sans text-[11px] text-text-muted">
                    <Marked text={h.snippet} ranges={h.matches} />
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          groups.map(([dir, items]) => {
            const top = dir.split('/')[0]
            // The root's notes always show; a folder only while open.
            const isCollapsed = !!dir && !p.openFolders.includes(dir)
            return (
              <div key={dir || '.'} className="mb-1" {...(dir ? dropProps(dir) : {})}>
                {dir && (
                  <div
                    draggable
                    onDragStart={dragFolder(dir)}
                    className={cn(
                      'group flex items-center gap-1.5 rounded-sm px-1.5 py-1 transition-colors',
                      dropTarget === dir && 'bg-cyan/8 ring-1 ring-cyan/40'
                    )}
                  >
                    <button type="button" onClick={() => p.onToggleFolder(dir)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                      <ChevronDown
                        size={12}
                        className={cn('shrink-0 text-text-muted transition-transform', isCollapsed && '-rotate-90')}
                      />
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dot(top) }} />
                      <span className="truncate font-sans text-[12px] font-medium text-text-secondary">{dir}</span>
                      <span className="font-mono text-[11px] text-text-muted">{items.length}</span>
                    </button>
                    <button
                      type="button"
                      title={t.memory.newNoteIn(dir)}
                      onClick={() => p.onStartCreate('note', dir)}
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <FilePlus2 size={13} className="text-text-muted hover:text-text-primary" />
                    </button>
                    <button
                      type="button"
                      title={t.memory.newFolderIn(dir)}
                      onClick={() => p.onStartCreate('folder', dir)}
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <FolderPlus size={13} className="text-text-muted hover:text-text-primary" />
                    </button>
                  </div>
                )}
                {!isCollapsed && createRow(dir)}
                {!isCollapsed &&
                  items.map((n) => (
                    <button
                      key={n.path}
                      type="button"
                      draggable
                      onDragStart={dragNote(n.path)}
                      onClick={() => p.onOpen(n.path)}
                      className={cn(
                        'relative flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors',
                        dir ? 'pl-7' : 'pl-2',
                        n.path === p.activePath
                          ? 'bg-cyan/8 text-text-primary'
                          : 'text-text-secondary hover:bg-elevated/50 hover:text-text-primary'
                      )}
                    >
                      {n.path === p.activePath && (
                        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-cyan" />
                      )}
                      <FileText size={13} className="shrink-0 text-text-muted" />
                      <span className="min-w-0 flex-1 truncate font-sans text-[12.5px]">{n.title}</span>
                      {n.linkCount > 0 && <span className="font-mono text-[11px] text-text-muted">{n.linkCount}</span>}
                    </button>
                  ))}
                {dir && !isCollapsed && items.length === 0 && !(p.creating?.parent === dir) && (
                  <p className="py-1 pl-7 font-sans text-[11px] text-text-muted/70">{t.memory.emptyFolder}</p>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** Text with the search matches marked. */
function Marked({ text, ranges = [] }: { text: string; ranges?: [number, number][] }) {
  const parts: React.ReactNode[] = []
  let at = 0
  for (const [from, to] of ranges) {
    if (from > at) parts.push(text.slice(at, from))
    parts.push(
      <mark key={from} className="rounded-xs bg-amber/20 px-px text-text-primary">
        {text.slice(from, to)}
      </mark>
    )
    at = to
  }
  parts.push(text.slice(at))
  return <>{parts}</>
}

/** Inline name input for a new note or folder; Enter creates, Esc/blur cancels. */
function CreateInput({
  kind,
  indent,
  onSubmit,
  onCancel
}: {
  kind: Creating['kind']
  indent: boolean
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const t = useT()
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const Icon = kind === 'note' ? FileText : Folder
  return (
    <div className={cn('flex items-center gap-2 rounded-md border border-cyan/40 bg-cyan/5 py-1 pr-2', indent ? 'pl-7' : 'pl-2')}>
      <Icon size={13} className="shrink-0 text-cyan" />
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit(value)
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => (value.trim() ? onSubmit(value) : onCancel())}
        placeholder={kind === 'note' ? t.memory.noteTitle : t.memory.folderName}
        aria-label={kind === 'note' ? t.memory.noteTitle : t.memory.folderName}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent font-sans text-[12.5px] text-text-primary outline-hidden placeholder:text-text-muted/70"
      />
    </div>
  )
}

/** One of the tools in the row over the notes. */
function Tool({ label, aria, onClick, disabled, children }: { label: string; aria?: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={aria ?? label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors enabled:hover:bg-elevated/60 enabled:hover:text-text-primary disabled:opacity-40"
    >
      {children}
    </button>
  )
}
