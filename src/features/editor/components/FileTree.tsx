import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ChevronRight,
  Columns2,
  ChevronsDownUp,
  Copy,
  File,
  FileCode2,
  FileImage,
  FileJson,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Radio,
  Upload,
  Download,
  Trash2,
  X,
  type LucideIcon
} from 'lucide-react'
import type { FileEntry } from '@shared/types/files'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { isMac } from '@/lib/platform'
import { tabKey, useEditor } from '../store'
import { useLive } from '../live'
import { useSftp } from '../sftp'

/** A project path as the server sees it: relative to the SFTP context. */
const remotePath = (path: string, context: string) => (context ? path.slice(context.length + 1) : path)
/** Only what lies inside the target's local folder goes to / comes from its server. */
const inContext = (path: string, context: string) => !context || path === context || path.startsWith(`${context}/`)

const CODE = /\.(tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|zsh|vue|svelte|css|scss|less|html?|sql|ya?ml|toml)$/i
const ICONS: [RegExp, LucideIcon, string][] = [
  [/\.(json|jsonc)$/i, FileJson, 'text-amber/80'],
  [/\.(md|mdx|txt)$/i, FileText, 'text-green/80'],
  [/\.(png|jpe?g|gif|svg|webp|ico|avif)$/i, FileImage, 'text-purple/80'],
  [CODE, FileCode2, 'text-blue/80']
]

/** Icon + tint for a file name (a few families, VS Code-like but calm). */
export function fileIcon(name: string): { Icon: LucideIcon; tint: string } {
  const hit = ICONS.find(([re]) => re.test(name))
  return hit ? { Icon: hit[1], tint: hit[2] } : { Icon: File, tint: 'text-text-muted' }
}

const row =
  'flex w-full items-center gap-1.5 rounded-sm py-[3px] pr-2 text-left font-sans text-[12.5px] transition-colors hover:bg-elevated/60'

type Target = { path: string; kind: FileEntry['kind'] }
type Menu = { x: number; y: number; target?: Target }

/** The inline name field (VS Code-style): Enter applies, Escape cancels, leaving it applies a typed name. */
function NameInput({ depth, kind, initial }: { depth: number; kind: FileEntry['kind']; initial: string }) {
  const t = useT()
  const error = useEditor((s) => s.naming?.error)
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    const input = ref.current!
    input.focus()
    // Select the name without its extension, like VS Code.
    const dot = initial.lastIndexOf('.')
    input.setSelectionRange(0, kind === 'file' && dot > 0 ? dot : initial.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus and select once, when the field appears
  }, [])

  const submit = async () => {
    if (done.current) return
    done.current = true
    if (!value.trim()) return useEditor.getState().cancelNaming()
    await useEditor.getState().submitName(value)
    // A refused name keeps the field open for another try.
    done.current = !useEditor.getState().naming?.error
  }
  const { Icon, tint } = kind === 'dir' ? { Icon: Folder, tint: 'text-cyan/70' } : fileIcon(value)

  return (
    <div style={{ paddingLeft: 6 + depth * 12 + (kind === 'dir' ? 0 : 14) }} className="py-[2px] pr-2">
      <div className="flex items-center gap-1.5">
        {kind === 'dir' && <ChevronRight size={12} className="shrink-0 text-text-muted" />}
        <Icon size={13} className={cn('shrink-0', tint)} />
        <input
          ref={ref}
          aria-label={t.explorer.name}
          aria-invalid={!!error}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (useEditor.getState().naming?.error) useEditor.setState((s) => ({ naming: s.naming && { ...s.naming, error: undefined } }))
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') void submit()
            else if (e.key === 'Escape') {
              done.current = true
              useEditor.getState().cancelNaming()
            }
          }}
          onBlur={() => {
            if (!useEditor.getState().naming?.error) void submit()
          }}
          className={cn(
            'min-w-0 flex-1 rounded-xs border bg-surface/80 px-1 py-px font-sans text-[12.5px] text-text-primary outline-hidden',
            error ? 'border-danger/70' : 'border-cyan/50'
          )}
        />
      </div>
      {error && (
        <p role="alert" className="mt-0.5 rounded-xs bg-danger/10 px-1.5 py-0.5 font-sans text-[11px] text-danger">
          {error === 'invalid-name' ? t.explorer.invalidName : error}
        </p>
      )}
    </div>
  )
}

function Level({ projectId, dir, entries, depth, onMenu }: { projectId: string; dir: string; entries: FileEntry[]; depth: number; onMenu: (e: ReactMouseEvent, target: Target) => void }) {
  const tree = useEditor((s) => s.tree)
  const expanded = useEditor((s) => s.expanded)
  const activeId = useEditor((s) => s.activeId)
  const selection = useEditor((s) => s.selection)
  const naming = useEditor((s) => s.naming)
  const pad = { paddingLeft: 6 + depth * 12 }
  const creating = naming && naming.mode !== 'rename' && naming.dir === dir ? naming.mode : undefined

  return (
    <>
      {creating && <NameInput depth={depth} kind={creating} initial="" />}
      {entries.map((e) => {
        if (naming?.mode === 'rename' && naming.path === e.path) return <NameInput key={e.path} depth={depth} kind={e.kind} initial={e.name} />
        const selected = selection?.path === e.path
        const target = { path: e.path, kind: e.kind }
        if (e.kind === 'dir') {
          const key = tabKey(projectId, e.path)
          const open = !!expanded[key]
          const children = tree[key]
          return (
            <div key={e.path}>
              <button
                type="button"
                role="treeitem"
                aria-expanded={open}
                aria-selected={selected}
                style={pad}
                onClick={() => {
                  useEditor.getState().select(e.path, 'dir')
                  void useEditor.getState().toggleDir(e.path)
                }}
                onContextMenu={(ev) => onMenu(ev, target)}
                className={cn(row, 'text-text-secondary', selected && 'bg-elevated/70', e.ignored && 'opacity-50')}
              >
                <ChevronRight size={12} className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-90')} />
                {open ? <FolderOpen size={13} className="shrink-0 text-cyan/70" /> : <Folder size={13} className="shrink-0 text-cyan/70" />}
                <span className="truncate">{e.name}</span>
              </button>
              {open && children && <Level projectId={projectId} dir={e.path} entries={children} depth={depth + 1} onMenu={onMenu} />}
            </div>
          )
        }
        const { Icon, tint } = fileIcon(e.name)
        const active = activeId === tabKey(projectId, e.path)
        return (
          <button
            key={e.path}
            type="button"
            role="treeitem"
            aria-selected={active || selected}
            title={e.path}
            style={{ paddingLeft: pad.paddingLeft + 14 }}
            onClick={() => {
              useEditor.getState().select(e.path, 'file')
              void useEditor.getState().open(e.path)
            }}
            onContextMenu={(ev) => onMenu(ev, target)}
            className={cn(
              row,
              active ? 'bg-cyan/10 text-text-primary' : selected ? 'bg-elevated/70 text-text-primary' : 'text-text-secondary hover:text-text-primary',
              e.ignored && 'opacity-50'
            )}
          >
            <Icon size={13} className={cn('shrink-0', tint)} />
            <span className="truncate">{e.name}</span>
          </button>
        )
      })}
    </>
  )
}

/** Right-click menu of the explorer: new file / folder, rename, delete, copy path. */
function ContextMenu({ menu, onClose, readOnly }: { menu: Menu; onClose: () => void; readOnly: boolean }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const { target } = menu

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

  // SFTP (a .vscode/sftp.json): send to / fetch from the selected server.
  const sftpTarget = useSftp((s) => s.targets.find((x) => x.name === s.target))
  const noSftp = readOnly || !target || !sftpTarget || !inContext(target.path, sftpTarget.context)
  const run = (fn: () => unknown) => () => {
    onClose()
    void fn()
  }
  const items: { label: string; icon: LucideIcon; hint?: string; action: () => void; hidden?: boolean; danger?: boolean }[] = [
    { label: t.explorer.newFile, icon: FilePlus2, action: run(() => useEditor.getState().startNaming('file', target)), hidden: readOnly },
    { label: t.explorer.newFolder, icon: FolderPlus, action: run(() => useEditor.getState().startNaming('dir', target)), hidden: readOnly },
    { label: t.explorer.rename, icon: Pencil, hint: 'F2', action: run(() => useEditor.getState().startNaming('rename', target)), hidden: readOnly || !target },
    { label: t.explorer.copyPath, icon: Copy, action: run(() => navigator.clipboard?.writeText(target!.path)), hidden: !target },
    { label: t.sftp.uploadTo(sftpTarget?.host ?? ''), icon: Upload, action: run(() => useSftp.getState().upload([target!.path])), hidden: noSftp },
    {
      label: t.sftp.downloadFrom(sftpTarget?.host ?? ''),
      icon: Download,
      action: run(() => useSftp.getState().download([remotePath(target!.path, sftpTarget!.context)])),
      hidden: noSftp
    },
    { label: t.editor.openToSide, icon: Columns2, action: run(() => useEditor.getState().openToSide(target!.path)), hidden: !target || target.kind !== 'file' },
    { label: t.live.openWithLiveServer, icon: Radio, action: run(() => useLive.getState().start(target!.path)), hidden: readOnly || !target || !/\.html?$/i.test(target.path) },
    { label: t.explorer.delete, icon: Trash2, hint: isMac ? '⌘⌫' : 'Entf', action: run(() => useEditor.getState().requestDelete(target!.path)), hidden: readOnly || !target, danger: true }
  ]

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t.explorer.actions}
      style={{ left: menu.x, top: menu.y }}
      className="fixed z-70 min-w-[200px] rounded-md border border-hud/70 bg-panel/95 p-1 shadow-xl shadow-black/40 backdrop-blur-md"
    >
      {items
        .filter((i) => !i.hidden)
        .map(({ label, icon: Icon, hint, action, danger }) => (
          <button
            key={label}
            type="button"
            role="menuitem"
            onClick={action}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-sans text-[12.5px] hover:bg-elevated/70',
              danger ? 'text-danger' : 'text-text-primary'
            )}
          >
            <Icon size={13} className="shrink-0 opacity-80" />
            <span className="flex-1">{label}</span>
            {hint && <span className="font-mono text-[10.5px] text-text-muted">{hint}</span>}
          </button>
        ))}
    </div>
  )
}

const tool = 'flex h-6 w-6 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-elevated hover:text-text-primary'

/**
 * The explorer: one project's folders, listed lazily as they are opened.
 * Git-ignored entries are dimmed; `.git` itself never shows. Files and
 * folders are created, renamed and deleted (into the trash) right here.
 */
export function FileTree({ projectId, readOnly = false }: { projectId: string; readOnly?: boolean }) {
  const t = useT()
  const root = useEditor((s) => s.tree[tabKey(projectId, '')])
  const error = useEditor((s) => s.treeError)
  const deleting = useEditor((s) => s.deleting)
  const fileError = useEditor((s) => s.fileError)
  const naming = useEditor((s) => s.naming)
  const [menu, setMenu] = useState<Menu>()

  const openMenu = (e: ReactMouseEvent, target?: Target) => {
    e.preventDefault()
    e.stopPropagation()
    if (target) useEditor.getState().select(target.path, target.kind)
    setMenu({ x: e.clientX, y: e.clientY, target })
  }

  const onKey = (e: ReactKeyboardEvent) => {
    if (readOnly || !useEditor.getState().selection) return
    if (e.key === 'F2') void useEditor.getState().startNaming('rename')
    else if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) useEditor.getState().requestDelete()
    else return
    e.preventDefault()
  }

  const header = (
    <div className="flex items-center gap-0.5 px-2 pb-1">
      <span className="mr-auto font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{t.explorer.title}</span>
      {!readOnly && (
        <>
          <button type="button" aria-label={t.explorer.newFile} title={t.explorer.newFile} className={tool} onClick={() => void useEditor.getState().startNaming('file')}>
            <FilePlus2 size={13} />
          </button>
          <button type="button" aria-label={t.explorer.newFolder} title={t.explorer.newFolder} className={tool} onClick={() => void useEditor.getState().startNaming('dir')}>
            <FolderPlus size={13} />
          </button>
        </>
      )}
      <button type="button" aria-label={t.explorer.collapseAll} title={t.explorer.collapseAll} className={tool} onClick={() => useEditor.getState().collapseAll()}>
        <ChevronsDownUp size={13} />
      </button>
    </div>
  )

  if (error) return <p className="px-3 py-2 font-sans text-[12px] text-danger">{error}</p>
  if (!root) return <p className="px-3 py-2 font-sans text-[12px] text-text-muted">{t.common.loading}</p>
  const name = deleting?.slice(deleting.lastIndexOf('/') + 1)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {fileError && (
        <p role="alert" className="mx-2 mb-1 flex items-start gap-1 rounded-sm bg-danger/10 px-2 py-1 font-sans text-[11.5px] text-danger">
          <span className="flex-1">{fileError}</span>
          <button type="button" aria-label={t.common.dismiss} onClick={() => useEditor.getState().clearFileError()}>
            <X size={12} />
          </button>
        </p>
      )}
      <div
        role="tree"
        aria-label={t.editor.files}
        tabIndex={-1}
        onKeyDown={onKey}
        onContextMenu={(e) => !readOnly && openMenu(e)}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 outline-hidden"
      >
        {!root.length && !naming && <p className="px-1.5 py-1 font-sans text-[12px] text-text-muted">{t.editor.emptyFolder}</p>}
        <Level projectId={projectId} dir="" entries={root} depth={0} onMenu={openMenu} />
      </div>
      {deleting && (
        <div role="alertdialog" aria-label={t.explorer.delete} className="m-2 space-y-2 rounded-md border border-danger/40 bg-danger/6 p-2">
          <p className="font-sans text-[12px] text-text-primary">{t.explorer.confirmDelete(name!)}</p>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => void useEditor.getState().confirmDelete()} className="rounded-sm border border-danger/50 px-2 py-0.5 font-sans text-[12px] text-danger hover:bg-danger/10">
              {t.explorer.moveToTrash}
            </button>
            <button type="button" onClick={() => useEditor.getState().cancelDelete()} className="rounded-sm border border-hud/60 px-2 py-0.5 font-sans text-[12px] text-text-secondary hover:text-text-primary">
              {t.common.cancel}
            </button>
          </div>
        </div>
      )}
      {menu && <ContextMenu menu={menu} readOnly={readOnly} onClose={() => setMenu(undefined)} />}
    </div>
  )
}
