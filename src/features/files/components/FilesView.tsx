import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Columns3,
  Eye,
  EyeOff,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  List,
  Loader2,
  PanelRight,
  RotateCw,
  Search,
  X
} from 'lucide-react'
import { isDesktop, onEvent } from '@shared/ipc/client'
import { extOf, fileType, type FinderEntry } from '@shared/types/finder'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { isMac } from '@/lib/platform'
import type { ModuleId } from '@/types'
import { useProjects } from '@/features/projects/store'
import { useEditor } from '@/features/editor/store'
import { useBrowser } from '@/features/browser/store'
import { useTerminals } from '@/features/terminal/store'
import { useAgents } from '@/features/agents/sessions'
import { baseName, fileHref, isArchive, pathChain } from '../kinds'
import { useFiles, visibleEntries } from '../store'
import { Sidebar } from './Sidebar'
import { Entries, LIST_TOP, ROW, TILE, type EntryHandlers } from './Entries'
import { PreviewPane } from './PreviewPane'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Columns } from './Columns'
import { ConflictDialog, Jobs, Tabs } from './Panels'
import { revealItem } from './Virtual'

const tool =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text-primary disabled:pointer-events-none disabled:opacity-35'

/** Pages the browser shows: HTML and PDF. */
const browsable = (e: FinderEntry) => e.kind === 'file' && (['html', 'htm', 'xhtml', 'svg'].includes(extOf(e.name)) || fileType(e.name) === 'pdf')

/** "Go to folder" (⌘⇧G): type a path — `~` is Home. */
function PathInput({ path, onDone }: { path: string; onDone: () => void }) {
  const t = useT()
  const home = useFiles((s) => s.places?.home)
  return (
    <input
      autoFocus
      aria-label={t.files.goTo}
      defaultValue={path}
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={onDone}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onDone()
        if (e.key !== 'Enter') return
        const raw = e.currentTarget.value.trim()
        const target = home && (raw === '~' || raw.startsWith('~/')) ? home + raw.slice(1) : raw
        onDone()
        if (target) void useFiles.getState().open(target)
      }}
      className="h-7 min-w-0 flex-1 rounded-md border border-cyan/50 bg-surface px-2 font-mono text-[12px] text-text-primary outline-hidden"
    />
  )
}

function Crumbs({ path, onEdit }: { path: string; onEdit: () => void }) {
  const t = useT()
  const home = useFiles((s) => s.places?.home)
  // Inside Home: start at Home ("~"), like the terminal does.
  const all = pathChain(path, home)
  // Deep paths: the start and the last three — the middle folds into "…".
  const shown = all.length > 5 ? [all[0], { name: '…', path: '' }, ...all.slice(-3)] : all
  return (
    <div className="flex min-w-0 flex-1 cursor-text items-center gap-0.5 overflow-hidden" title={t.files.goTo} onDoubleClick={(e) => e.target === e.currentTarget && onEdit()}>
      {shown.map((c, i) => (
        <span key={c.path || '…'} className="flex min-w-0 shrink items-center gap-0.5">
          {i > 0 && <ChevronRight size={12} className="shrink-0 text-text-muted" />}
          {!c.path ? (
            <span title={path} className="px-1 font-sans text-[12.5px] text-text-muted">
              …
            </span>
          ) : (
            <button
              type="button"
              title={c.path}
              onClick={() => void useFiles.getState().open(c.path)}
              className={cn(
                'truncate rounded-sm px-1.5 py-0.5 font-sans text-[12.5px] transition-colors hover:bg-elevated/60',
                i === shown.length - 1 ? 'font-medium text-text-primary' : 'text-text-secondary'
              )}
            >
              {c.name}
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

/**
 * The Files module: the machine's files like Finder — places, folders as a
 * list or icons, search, previews of pictures, videos, audio, text and PDFs,
 * and the everyday changes. Files of a project open in the Editor, pages in
 * the Browser, everything else with its own app.
 */
export function FilesView({ onNavigate }: { onNavigate: (module: ModuleId) => void }) {
  const t = useT()
  const s = useFiles()
  const projects = useProjects((st) => st.projects)
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: FinderEntry } | null>(null)
  const [goTo, setGoTo] = useState(false)
  const [query, setQuery] = useState('')
  const main = useRef<HTMLDivElement>(null)
  const entries = visibleEntries(s)
  const selectedEntries = entries.filter((e) => s.selected.includes(e.path))

  useEffect(() => {
    void useFiles.getState().init()
    return onEvent('finder:progress', (p) => useFiles.getState().onProgress(p))
  }, [])

  // Typing in the search field searches after a short pause.
  useEffect(() => {
    if (query === s.query) return
    const timer = setTimeout(() => void useFiles.getState().search(query), 250)
    return () => clearTimeout(timer)
  }, [query, s.query])

  // A notice fades after a few seconds.
  useEffect(() => {
    if (!s.notice) return
    const timer = setTimeout(() => useFiles.getState().setNotice(undefined), 3500)
    return () => clearTimeout(timer)
  }, [s.notice])

  // Windows paths come with backslashes.
  const projectOf = (path: string) => projects.find((p) => path === p.path || path.startsWith(`${p.path}/`) || path.startsWith(`${p.path}\\`))
  const editable = (e: FinderEntry) => e.kind === 'file' && fileType(e.name) === 'text' && !!projectOf(e.path)

  const openInEditor = async (path: string) => {
    const project = projectOf(path)!
    const editor = useEditor.getState()
    await editor.selectProject(project.id)
    onNavigate('editor')
    await useEditor.getState().open(path.slice(project.path.length + 1).replace(/\\/g, '/'))
  }
  const openInBrowser = (path: string) => void useBrowser.getState().show(fileHref(path))
  const openEntry = (e: FinderEntry) => {
    if (e.kind === 'dir' && !e.bundle) return void s.open(e.path)
    if (editable(e)) return void openInEditor(e.path)
    if (browsable(e)) return openInBrowser(e.path)
    void s.openWithApp(e.path)
  }
  const terminalHere = (dir: string) => {
    void useTerminals.getState().openFolder(dir)
    onNavigate('terminal')
  }
  const askAgent = (path: string) => {
    useAgents.getState().openDialog(t.files.agentPrompt(path))
    onNavigate('agents')
  }
  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(path)
    s.setNotice({ key: 'copied' })
  }

  const handlers: EntryHandlers = {
    open: openEntry,
    menu: (entry, e) => setMenu({ x: e.clientX, y: e.clientY, entry })
  }

  // Menus only open while a folder is shown (search hits come from one too).
  const menuItems = (entry?: FinderEntry): MenuItem[] => {
    const dir = s.listing!.path
    const canPaste = !!s.clipboard
    if (!entry) {
      return [
        { label: t.files.newFolder, run: () => s.startCreate() },
        { label: t.files.paste, run: () => void s.paste(dir), disabled: !canPaste },
        { label: t.files.newTab, run: () => void s.newTab(dir) },
        { label: t.files.terminal, run: () => terminalHere(dir) },
        { label: t.files.reveal(isMac), run: () => void s.reveal(dir) },
        'separator',
        { label: t.files.refresh, run: () => void s.reload() }
      ]
    }
    const many = s.selected.length > 1
    const folder = entry.kind === 'dir' && !entry.bundle
    const pinned = s.favorites.includes(entry.path)
    return [
      { label: t.files.open, run: () => openEntry(entry), disabled: many },
      ...(folder ? [{ label: t.files.openInNewTab, run: () => void s.newTab(entry.path), disabled: many }] : []),
      ...(editable(entry) ? [{ label: t.files.openInEditor, run: () => void openInEditor(entry.path) }] : []),
      ...(browsable(entry) ? [{ label: t.files.openInBrowser, run: () => openInBrowser(entry.path) }] : []),
      ...(!folder ? [{ label: t.files.openWithApp, run: () => void s.openWithApp(entry.path) }] : []),
      { label: t.files.reveal(isMac), run: () => void s.reveal(entry.path) },
      ...(folder ? [{ label: t.files.terminal, run: () => terminalHere(entry.path) }] : []),
      'separator',
      { label: t.files.copy, run: () => void s.copy() },
      { label: t.files.cut, run: () => void s.cut() },
      ...(folder && canPaste ? [{ label: t.files.pasteInto(entry.name), run: () => void s.paste(entry.path), disabled: many }] : []),
      { label: t.files.duplicate, run: () => void s.move(s.selected, dir, true) },
      { label: t.files.compress(s.selected.length), run: () => void s.compress() },
      ...(!folder && isArchive(entry.name) ? [{ label: t.files.extract, run: () => void s.extract(entry.path), disabled: many }] : []),
      ...(folder ? [{ label: pinned ? t.files.removeFromSidebar : t.files.addToSidebar, run: () => s.toggleFavorite(entry.path), disabled: many }] : []),
      'separator',
      { label: t.files.askAgent, run: () => askAgent(entry.path) },
      { label: t.files.copyPath, run: () => copyPath(entry.path) },
      'separator',
      { label: t.files.rename, run: () => s.startRename(entry.path), disabled: many },
      { label: t.files.trash, run: () => void s.trash(), danger: true }
    ]
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (s.renaming || s.creating) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()
    const index = entries.findIndex((x) => x.path === s.selected[s.selected.length - 1])
    // In the icon grid ↑/↓ move a whole row: as many tiles as fit across.
    const grid = s.view === 'grid'
    const step = grid ? Math.max(1, Math.floor(main.current!.clientWidth / TILE.width)) : 1
    const pick = (i: number) => {
      const at = Math.max(0, Math.min(entries.length - 1, i))
      const target = entries[at]
      if (!target) return
      s.select(target.path, e.shiftKey ? 'range' : 'single')
      // Long folders are windowed: bring the row into view.
      if (s.view !== 'columns') revealItem(main.current!, at, grid ? TILE.height : ROW, step, grid ? 8 : LIST_TOP)
    }
    if (mod && e.key === 'ArrowUp') void s.goUp()
    else if (mod && e.key === 'ArrowDown' && selectedEntries[0]) openEntry(selectedEntries[0])
    else if (mod && e.key === '[') void s.goBack()
    else if (mod && e.key === ']') void s.goForward()
    else if (mod && e.key === 'Backspace') void s.trash()
    else if (mod && key === 'a') s.selectAll()
    else if (mod && e.shiftKey && key === 'n') s.startCreate()
    else if (mod && e.shiftKey && key === 'g') setGoTo(true)
    else if (mod && key === 'c') void s.copy()
    else if (mod && key === 'x') void s.cut()
    else if (mod && key === 'v') void s.paste()
    else if (mod && key === 'z') void s.undoLast()
    else if (mod && key === 't') void s.newTab()
    else if (mod && key === 'w' && s.tabs.length > 1) void s.closeTab(s.activeTab)
    else if (e.key === 'ArrowDown') pick(index < 0 ? 0 : index + step)
    else if (e.key === 'ArrowUp') pick(index < 0 ? 0 : index - step)
    else if (grid && e.key === 'ArrowRight') pick(index + 1)
    else if (grid && e.key === 'ArrowLeft') pick(index - 1)
    else if (e.key === 'Enter' && selectedEntries.length === 1) openEntry(selectedEntries[0])
    else if (e.key === 'F2' && selectedEntries.length === 1) s.startRename(selectedEntries[0].path)
    else if (e.key === ' ') s.togglePreview()
    else return
    e.preventDefault()
  }

  if (!isDesktop()) {
    return (
      <section className="panel flex min-h-0 flex-1 items-center justify-center">
        <div className="max-w-sm p-6 text-center">
          <FolderOpen size={28} className="mx-auto text-text-muted" />
          <p className="mt-3 font-sans text-[14px] font-semibold text-text-primary">{t.files.unavailable}</p>
          <p className="mt-1.5 font-sans text-[12.5px] text-text-secondary">{t.files.unavailableHint}</p>
        </div>
      </section>
    )
  }

  const searching = s.results !== undefined || s.searching
  const name = s.listing ? baseName(s.listing.path) : ''
  const notice = !s.notice
    ? null
    : s.notice.key === 'copied'
      ? t.files.copied
      : s.notice.key === 'trashed'
        ? t.files.trashed(s.notice.count) + (s.notice.noUndo ? ` · ${t.files.noUndo(s.notice.noUndo)}` : '')
        : s.notice.key === 'clipboard'
          ? t.files.onClipboard(s.notice.count, s.notice.cut)
          : s.notice.key === 'undone'
            ? t.files.undone
            : t.files.stopped
  const columns = s.view === 'columns' && !searching && !!s.listing

  return (
    <section
      className="panel flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-label={t.files.title}
      // An OS drag of our own that ended outside Mindeck: the mouse moves again without a button.
      onPointerMove={(e) => e.buttons === 0 && s.dragging && s.endDrag()}
    >
      <Tabs />
      <div className="flex shrink-0 items-center gap-1 border-b border-hud/50 bg-surface/30 px-2 py-1.5">
        <button type="button" aria-label={t.files.back} title={`${t.files.back} (⌘[)`} disabled={!s.back.length} onClick={() => void s.goBack()} className={tool}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" aria-label={t.files.forward} title={`${t.files.forward} (⌘])`} disabled={!s.forward.length} onClick={() => void s.goForward()} className={tool}>
          <ArrowRight size={15} />
        </button>
        <button type="button" aria-label={t.files.up} title={`${t.files.up} (⌘↑)`} disabled={!s.listing?.parent} onClick={() => void s.goUp()} className={tool}>
          <ArrowUp size={15} />
        </button>
        <div className="mx-1 flex min-w-0 flex-1 items-center">
          {s.listing && (goTo ? <PathInput path={s.listing.path} onDone={() => setGoTo(false)} /> : <Crumbs path={s.listing.path} onEdit={() => setGoTo(true)} />)}
        </div>
        <label className="flex h-7 w-56 shrink-0 items-center gap-1.5 rounded-md border border-hud/60 bg-surface/50 px-2 focus-within:border-cyan/50">
          {s.searching ? <Loader2 size={13} className="shrink-0 animate-spin text-cyan" /> : <Search size={13} className="shrink-0 text-text-muted" />}
          <input
            aria-label={t.files.search(name)}
            placeholder={t.files.search(name)}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                s.clearSearch()
              }
            }}
            className="min-w-0 flex-1 bg-transparent font-sans text-[12px] text-text-primary outline-hidden placeholder:text-text-muted"
          />
          {query && (
            <button
              type="button"
              aria-label={t.files.clearSearch}
              onClick={() => {
                setQuery('')
                s.clearSearch()
              }}
              className="text-text-muted hover:text-text-primary"
            >
              <X size={12} />
            </button>
          )}
        </label>
        <div className="ml-1 flex shrink-0 rounded-md border border-hud/60 bg-surface/50 p-0.5">
          {(['list', 'grid', 'columns'] as const).map((v) => {
            const Icon = v === 'list' ? List : v === 'grid' ? LayoutGrid : Columns3
            return (
              <button
                key={v}
                type="button"
                aria-label={t.files[v]}
                aria-pressed={s.view === v}
                title={t.files[v]}
                onClick={() => s.setView(v)}
                className={cn('flex h-6 w-7 items-center justify-center rounded-sm transition-colors', s.view === v ? 'bg-cyan/10 text-cyan' : 'text-text-muted hover:text-text-secondary')}
              >
                <Icon size={13} />
              </button>
            )
          })}
        </div>
        <button type="button" aria-label={t.files.hidden} aria-pressed={s.hidden} title={t.files.hidden} onClick={() => void s.toggleHidden()} className={cn(tool, s.hidden && 'text-cyan')}>
          {s.hidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <button type="button" aria-label={t.files.preview} aria-pressed={s.showPreview} title={`${t.files.preview} (␣)`} onClick={() => s.togglePreview()} className={cn(tool, s.showPreview && 'text-cyan')}>
          <PanelRight size={14} />
        </button>
        <button type="button" aria-label={t.files.newFolder} title={`${t.files.newFolder} (⌘⇧N)`} disabled={searching || !s.listing} onClick={() => s.startCreate()} className={tool}>
          <FolderPlus size={14} />
        </button>
        <button type="button" aria-label={t.files.refresh} title={t.files.refresh} onClick={() => void s.reload()} className={tool}>
          <RotateCw size={13} className={cn(s.loading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div
          ref={main}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onClick={(e) => e.target === e.currentTarget && s.clearSelection()}
          onContextMenu={(e: MouseEvent) => {
            e.preventDefault()
            if (!searching && s.listing) setMenu({ x: e.clientX, y: e.clientY })
          }}
          // Files from Finder / Explorer dropped on the folder (not on a subfolder) are copied into it.
          onDragOver={(e) => {
            if (!s.listing || searching || !e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = s.dragging && !e.altKey ? 'move' : 'copy'
          }}
          onDrop={(e) => {
            if (!s.listing || searching || !e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            void s.dropFiles([...e.dataTransfer.files], s.listing.path, e.altKey)
          }}
          className={cn('min-h-0 min-w-0 flex-1 outline-hidden', columns ? 'overflow-hidden' : 'overflow-y-auto')}
        >
          {s.error && (
            <div role="alert" className="m-2 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/6 px-2.5 py-2">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
              <span className="min-w-0 flex-1 font-mono text-[11px] text-text-secondary">
                {s.errorCode === 'trash-gone'
                  ? t.files.trashGone(s.error)
                  : s.errorCode === 'full-disk-access'
                    ? t.files.fullDiskAccess
                    : /no-access|EPERM|EACCES/.test(s.error)
                      ? t.files.noAccess
                      : s.error}
                {s.errorCode === 'full-disk-access' && (
                  <button type="button" onClick={() => void s.privacySettings()} className="ml-1.5 font-sans text-cyan hover:underline">
                    {t.files.openPrivacySettings}
                  </button>
                )}
              </span>
              <button type="button" aria-label={t.common.dismiss} onClick={() => s.clearError()} className="text-text-muted hover:text-text-primary">
                <X size={12} />
              </button>
            </div>
          )}
          {columns ? (
            <Columns handlers={handlers} />
          ) : entries.length > 0 || s.creating ? (
            <Entries entries={entries} handlers={handlers} scroller={main} />
          ) : (
            !s.loading &&
            !s.searching && (
              <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center">
                <FolderOpen size={26} className="text-text-muted" />
                <p className="font-sans text-[12.5px] text-text-muted">{searching ? t.files.noResults : t.files.empty}</p>
              </div>
            )
          )}
        </div>
        {s.showPreview && (
          <PreviewPane
            editable={selectedEntries.length === 1 && editable(selectedEntries[0])}
            browsable={selectedEntries.length === 1 && browsable(selectedEntries[0])}
            actions={{ open: (path) => openEntry(selectedEntries.find((e) => e.path === path)!), openInEditor: (p) => void openInEditor(p), openInBrowser }}
          />
        )}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-hud/50 px-3 font-mono text-[10.5px] text-text-muted">
        <span>{searching ? (s.results ? t.files.results(s.results.length) : t.files.searching) : t.files.items(s.listing?.total ?? entries.length)}</span>
        {s.selected.length > 0 && <span>{t.files.selected(s.selected.length, entries.length)}</span>}
        {s.listing && !searching && s.listing.entries.length < s.listing.total && (
          <span className="text-amber">{t.files.loadingMore(s.listing.entries.length, s.listing.total)}</span>
        )}
        <Jobs />
        {notice && <span className="ml-auto text-cyan">{notice}</span>}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} label={t.files.actions} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}
      <ConflictDialog />
    </section>
  )
}
