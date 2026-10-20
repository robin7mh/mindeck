import { lazy, Suspense, useState, type DragEvent, type ReactNode } from 'react'
import { AlertTriangle, BookOpen, Code2, FileWarning, RefreshCw } from 'lucide-react'
import { isMac } from '@/lib/platform'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useEditor, type EditorTab } from '../store'
import type { Side } from '../groups'
import { EditorTabs, copyDrag, draggedTab, isTabDrag } from './EditorTabs'
import { ConflictBar } from './ConflictBar'
import { Breadcrumbs } from './Breadcrumbs'
import type { CursorInfo } from './CodeEditor'

// Monaco is a few MB — it loads the first time the Editor module opens.
const CodeEditor = lazy(() => import('./CodeEditor'))
const NotebookView = lazy(() => import('./NotebookView'))

const isNotebook = (tab?: { path: string }) => !!tab?.path.toLowerCase().endsWith('.ipynb')

const button = 'flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-sans text-[12px] font-medium transition-colors'
export const primary = cn(button, 'border-cyan/40 bg-cyan/6 text-cyan hover:bg-cyan/12')
export const quiet = cn(button, 'border-hud/60 text-text-secondary hover:border-hud-strong hover:text-text-primary')

export function Banner({ tone, children }: { tone: 'warn' | 'info'; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 font-sans text-[12.5px]',
        tone === 'warn' ? 'border-amber/30 bg-amber/[0.07] text-text-primary' : 'border-hud/60 bg-elevated/40 text-text-secondary'
      )}
    >
      {children}
    </div>
  )
}

export function Centered({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
      {icon}
      <p className="font-sans text-[14px] font-semibold text-text-primary">{title}</p>
      {children}
    </div>
  )
}

export const Starting = () => {
  const t = useT()
  return <Centered icon={<RefreshCw size={22} className="animate-spin text-text-muted" />} title={t.editor.starting} />
}

/** What the editor area shows when the active tab has no text to edit. */
function Placeholder({ tab }: { tab?: EditorTab }) {
  const t = useT()
  const key = isMac ? '⌘' : 'Ctrl+'
  if (!tab) {
    return (
      <Centered icon={<Code2 size={28} className="text-text-muted" />} title={t.editor.openFromExplorer}>
        <p className="font-mono text-[11px] text-text-muted">{t.editor.shortcuts(key)}</p>
      </Centered>
    )
  }
  if (tab.loading) return <Centered icon={<RefreshCw size={22} className="animate-spin text-text-muted" />} title={t.common.loading} />
  if (tab.unsupported) {
    return (
      <Centered icon={<FileWarning size={28} className="text-text-muted" />} title={tab.unsupported === 'binary' ? t.editor.binary : t.editor.tooLarge}>
        <p className="font-sans text-[13px] text-text-secondary">{t.editor.textOnly}</p>
      </Centered>
    )
  }
  return (
    <Centered icon={<AlertTriangle size={26} className="text-danger" />} title={t.editor.cantOpen}>
      <p className="font-sans text-[13px] text-text-secondary">{tab.error}</p>
      <button type="button" onClick={() => void useEditor.getState().reload(tab.id)} className={quiet}>
        <RefreshCw size={13} /> {t.editor.tryAgain}
      </button>
    </Centered>
  )
}

/** Tabs showing their notebook as JSON (the text editor underneath). */
const rawNotebooks = new Set<string>()

/** A notebook over its file's text editor — or the JSON, with the way back. */
function NotebookLayer({ tab, readOnly }: { tab: EditorTab; readOnly: boolean }) {
  const t = useT()
  const [raw, setRaw] = useState(rawNotebooks.has(tab.id))
  const toggle = () => {
    if (raw) rawNotebooks.delete(tab.id)
    else rawNotebooks.add(tab.id)
    setRaw(!raw)
  }
  if (raw)
    return (
      <button type="button" onClick={toggle} className="absolute right-6 top-2 z-10 flex items-center gap-1 rounded-sm border border-cyan/40 bg-elevated/95 px-2 py-1 font-sans text-[11.5px] text-cyan hover:bg-elevated">
        <BookOpen size={12} /> {t.notebook.notebook}
      </button>
    )
  return (
    <div className="absolute inset-0 z-5">
      <Suspense fallback={null}>
        <NotebookView key={tab.id} tab={tab} readOnly={readOnly} onRaw={toggle} />
      </Suspense>
    </div>
  )
}

/** Where a tab dragged over an editor lands: its middle (this group), or an edge (a new group there). */
export function dropZone(e: Pick<DragEvent, 'clientX' | 'clientY'>, box: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): Side | 'center' {
  if (!box.width || !box.height) return 'center'
  const x = (e.clientX - box.left) / box.width
  const y = (e.clientY - box.top) / box.height
  const [side, distance] = ([['left', x], ['right', 1 - x], ['up', y], ['down', 1 - y]] as [Side, number][]).sort((a, b) => a[1] - b[1])[0]
  return distance < 0.25 ? side : 'center'
}

const ZONES: Record<Side | 'center', string> = {
  center: 'inset-0',
  left: 'inset-y-0 left-0 w-1/2',
  right: 'inset-y-0 right-0 w-1/2',
  up: 'inset-x-0 top-0 h-1/2',
  down: 'inset-x-0 bottom-0 h-1/2'
}

interface GroupProps {
  id: string
  /** Its place in the grid (0-based). */
  index: number
  projectNames: Map<string, string>
  readOnly: boolean
  /** A view that takes the group's place for now (a diff, the git graph, a pull request, a collection). */
  overlay?: ReactNode
  onCursor: (group: string, info: CursorInfo) => void
}

/**
 * One editor group: its tabs, the banners of its file, breadcrumbs and an
 * editor. Tabs dropped on the editor join the group — on an edge, they open
 * a new group on that side.
 */
export function EditorGroup({ id, index, projectNames, readOnly, overlay, onCursor }: GroupProps) {
  const t = useT()
  const activeId = useEditor((s) => s.groups.find((g) => g.id === id)?.activeId)
  const tab = useEditor((s) => s.tabs.find((x) => x.id === activeId))
  // "Save before closing?" shows in the group it was asked in — the focused one, else one that has the file.
  const closing = useEditor((s) => {
    const shownIn = s.groups.filter((g) => g.tabs.includes(s.closing!))
    const where = shownIn.some((g) => g.id === s.activeGroup) ? s.activeGroup : (shownIn[0]?.id ?? s.activeGroup)
    return where === id ? s.tabs.find((x) => x.id === s.closing) : undefined
  })
  const [zone, setZone] = useState<Side | 'center'>()
  const hasText = tab?.content !== undefined

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!isTabDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = copyDrag(e) ? 'copy' : 'move'
    setZone(dropZone(e, e.currentTarget.getBoundingClientRect()))
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const dragged = draggedTab(e)
    const where = dropZone(e, e.currentTarget.getBoundingClientRect())
    setZone(undefined)
    if (!dragged) return
    e.preventDefault()
    const editor = useEditor.getState()
    if (where === 'center') editor.moveTab(dragged.id, dragged.group, id, { copy: copyDrag(e) })
    else editor.dropTab(dragged.id, dragged.group, id, where, { copy: copyDrag(e) })
  }

  return (
    <section
      aria-label={t.editor.group(index + 1)}
      onMouseDown={() => useEditor.getState().focusGroup(id)}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {overlay !== undefined && <div className="flex min-h-0 flex-1 flex-col">{overlay}</div>}
      <div className={cn('flex min-h-0 flex-1 flex-col', overlay !== undefined && 'hidden')}>
        <EditorTabs group={id} projectNames={projectNames} />

        {closing ? (
          <Banner tone="warn">
            <span className="mr-auto">{t.editor.saveBeforeClose(closing.name)}</span>
            <button type="button" onClick={() => void useEditor.getState().saveAndClose(closing.id)} className={primary} disabled={readOnly}>
              {t.common.save}
            </button>
            <button type="button" onClick={() => useEditor.getState().close(closing.id)} className={quiet}>
              {t.editor.dontSave}
            </button>
            <button type="button" onClick={() => useEditor.getState().cancelClose()} className={quiet}>
              {t.common.cancel}
            </button>
          </Banner>
        ) : tab?.conflict ? (
          <Banner tone="warn">
            <span className="mr-auto">{t.editor.changedOnDisk(tab.name)}</span>
            <button type="button" onClick={() => void useEditor.getState().reload(tab.id)} className={quiet}>
              {t.editor.loadDisk}
            </button>
            <button type="button" onClick={() => void useEditor.getState().save(tab.id, { force: true })} className={primary} disabled={readOnly}>
              {t.editor.keepMine}
            </button>
          </Banner>
        ) : tab?.deleted ? (
          <Banner tone="info">{t.editor.deletedOnDisk(tab.name)}</Banner>
        ) : tab?.error && hasText ? (
          <Banner tone="warn">
            <AlertTriangle size={13} className="text-danger" /> {tab.error}
          </Banner>
        ) : null}
        {hasText && <ConflictBar tab={tab} readOnly={readOnly} />}
        {hasText && <Breadcrumbs tab={tab} group={id} />}

        <div className="relative min-h-0 flex-1" onDragOver={onDragOver} onDragLeave={() => setZone(undefined)} onDrop={onDrop}>
          <Suspense fallback={<Starting />}>
            <CodeEditor group={id} tab={tab} readOnly={readOnly} onCursor={(info) => onCursor(id, info)} />
          </Suspense>
          {hasText && isNotebook(tab) && <NotebookLayer key={tab.id} tab={tab} readOnly={readOnly} />}
          {!hasText && (
            <div className="absolute inset-0 bg-panel/80">
              <Placeholder tab={tab} />
            </div>
          )}
          {zone && <div aria-hidden data-zone={zone} className={cn('pointer-events-none absolute z-30 rounded-xs border border-cyan/50 bg-cyan/8', ZONES[zone])} />}
        </div>
      </div>
    </section>
  )
}

