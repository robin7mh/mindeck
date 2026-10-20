import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeftRight, BrainCircuit, CalendarDays, ChevronDown, FileText, FolderOpen, Network, Plus, Sparkles, X } from 'lucide-react'
import { isDesktop, onEvent } from '@shared/ipc/client'
import { DEFAULT_GRAPH_STYLE, TEMPLATES_FOLDER, type NoteMeta } from '@shared/types/memory'
import { Panel } from '@/components/ui/Panel'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { folderColors, useMemory } from '../store'
import { GraphView } from './GraphView'
import { GraphStyleControl } from './GraphStyleControl'
import { NoteList } from './NoteList'
import { NoteEditor } from './NoteEditor'
import { FolderPicker } from '@/components/ui/FolderPicker'
import { usePaneFocused } from '@/features/workspace/pane'
import { DailySettings } from './DailySettings'

/**
 * The Memory module: an Obsidian-compatible vault with a note list, a
 * read/edit view with backlinks, and the force-directed graph. Files on disk
 * are the source of truth — this view follows them live via `memory:changed`.
 */
export function MemoryView() {
  const t = useT()
  const m = useMemory()
  const style = m.status?.graphStyle ?? DEFAULT_GRAPH_STYLE
  const folderSlots = useMemo(() => folderColors(m.notes), [m.notes])
  const templates = useMemo(() => m.notes.filter((n) => n.path.startsWith(`${TEMPLATES_FOLDER}/`)), [m.notes])
  const [browsing, setBrowsing] = useState(false)
  const desktop = isDesktop()
  // Desktop: native dialog. Browser: browse folders on the core's machine.
  const pick = () => (desktop ? void m.pickVault() : setBrowsing(true))

  useEffect(() => {
    void useMemory.getState().init()
    return onEvent('memory:changed', (change) => void useMemory.getState().onChanged(change))
  }, [])

  // Flush pending edits when leaving the module.
  useEffect(() => () => void useMemory.getState().save(), [])

  // ⌘⇧D: today's daily note — while Memory's pane has the focus.
  const focused = usePaneFocused()
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        void useMemory.getState().openDaily()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused])

  const seg = 'flex items-center gap-1.5 rounded-sm px-2 py-1 font-sans text-[11px] font-medium transition-colors'

  const header = m.status?.exists ? (
    <div className="flex items-center gap-3">
      {m.view === 'graph' && <GraphStyleControl style={style} onChange={(s) => void m.setGraphStyle(s)} />}
      <div className="flex rounded-md border border-hud/60 bg-surface/50 p-0.5">
        <button
          type="button"
          onClick={() => m.setView('graph')}
          className={cn(seg, m.view === 'graph' ? 'bg-cyan/10 text-cyan' : 'text-text-muted hover:text-text-secondary')}
        >
          <Network size={12} /> {t.memory.graph}
        </button>
        <button
          type="button"
          onClick={() => m.setView('note')}
          className={cn(seg, m.view === 'note' ? 'bg-cyan/10 text-cyan' : 'text-text-muted hover:text-text-secondary')}
        >
          <FileText size={12} /> {t.memory.note}
        </button>
      </div>
      <button
        type="button"
        title={t.memory.todayTitle}
        onClick={() => void m.openDaily()}
        className="flex items-center gap-1.5 rounded-md border border-hud/60 bg-surface/50 px-2.5 py-1 font-sans text-[12px] font-medium text-text-secondary transition-colors hover:border-cyan/40 hover:text-cyan"
      >
        <CalendarDays size={13} />
        {t.memory.today}
      </button>
      <div className="flex">
        <button
          type="button"
          onClick={() => m.startCreate('note', '')}
          className={cn(
            'flex items-center gap-1.5 border border-cyan/40 bg-cyan/6 px-2.5 py-1 font-sans text-[12px] font-medium text-cyan transition-colors hover:bg-cyan/12',
            templates.length ? 'rounded-l-md' : 'rounded-md'
          )}
        >
          <Plus size={14} strokeWidth={2} />
          {t.memory.newNote}
        </button>
        {templates.length > 0 && <NewFromTemplate templates={templates} onPick={(path) => m.startCreate('note', '', path)} />}
      </div>
    </div>
  ) : undefined

  return (
    <Panel title={t.memory.title} corners flush className="min-h-0 flex-1" headerRight={header} bodyClassName="flex min-h-0 flex-col">
      {m.error && (
        <div className="flex items-start gap-2 border-b border-danger/30 bg-danger/6 px-3 py-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 font-mono text-[11px] text-text-secondary">{m.error}</span>
          <button type="button" aria-label={t.common.dismiss} onClick={m.clearError} className="text-text-muted hover:text-text-primary">
            <X size={12} />
          </button>
        </div>
      )}

      {!m.status ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="font-mono text-[12px] text-text-muted">{m.loading ? t.memory.loading : ''}</p>
        </div>
      ) : !m.status.exists ? (
        <VaultSetup
          missing={m.status.isDefault ? undefined : m.status.root}
          defaultRoot={m.status.defaultRoot}
          onCreate={() => void m.createVault()}
          onPick={pick}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-64 shrink-0 flex-col border-r border-hud/50">
            <div className="flex items-center gap-2 border-b border-hud/50 px-3 py-2">
              <BrainCircuit size={14} className="shrink-0 text-cyan" />
              <span className="min-w-0 flex-1" title={m.status.root}>
                <span className="block truncate font-sans text-[12.5px] font-semibold text-text-primary">
                  {m.status.name}
                </span>
                <span className="block truncate font-mono text-[10px] text-text-muted">
                  {m.status.root.replace(/^\/Users\/[^/]+|^[A-Z]:\\Users\\[^\\]+/i, '~')}
                </span>
              </span>
              {desktop && (
                <button
                  type="button"
                  onClick={() => void m.reveal()}
                  title={t.memory.showInFinder}
                  aria-label={t.memory.showVault}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated/60 hover:text-cyan"
                >
                  <FolderOpen size={14} />
                </button>
              )}
              <DailySettings
                daily={m.status.dailyNotes}
                folders={m.folders}
                templates={templates}
                onChange={(daily) => void m.setDailyNotes(daily)}
              />
              <button
                type="button"
                onClick={pick}
                title={t.memory.openAnother}
                aria-label={t.memory.openAnotherLabel}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated/60 hover:text-cyan"
              >
                <ArrowLeftRight size={13} />
              </button>
            </div>
            <NoteList
              notes={m.notes}
              folders={m.folders}
              hits={m.hits}
              query={m.query}
              activePath={m.note?.path}
              folderSlots={folderSlots}
              style={style}
              creating={m.creating}
              onSearch={m.search}
              onOpen={(p) => void m.open(p)}
              onStartCreate={m.startCreate}
              onCancelCreate={m.cancelCreate}
              onSubmitCreate={(name) => void m.submitCreate(name)}
              onMoveNote={(path, folder) => void m.moveNote(path, folder)}
              onMoveFolder={(folder, into) => void m.moveFolder(folder, into)}
            />
          </aside>

          <div className="min-w-0 flex-1">
            {m.view === 'graph' && m.graph ? (
              <GraphView
                graph={m.graph}
                style={style}
                folderSlots={folderSlots}
                activeId={m.note?.path}
                onOpen={(p) => void m.open(p)}
                onOpenGhost={(title) => void m.openOrCreate(title)}
              />
            ) : m.note ? (
              <NoteEditor
                note={m.note}
                notes={m.notes}
                templates={templates}
                draft={m.draft}
                mode={m.mode}
                source={m.source}
                saving={m.saving}
                onDraft={m.setDraft}
                onMode={m.setMode}
                onSource={m.setSource}
                onInsertTemplate={m.renderTemplate}
                onAttach={m.attach}
                loadImage={m.loadImage}
                onSave={() => void m.save()}
                onRename={(title) => void m.rename(title)}
                onOpen={(p) => void m.open(p)}
                onOpenOrCreate={(t) => void m.openOrCreate(t)}
                onLink={(to) => void m.link(to)}
                onUnlink={(from, to) => void m.unlink(from, to)}
                onTrash={() => void m.trash(m.note!.path)}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <p className="font-mono text-[12px] text-text-muted">{t.memory.selectNote}</p>
              </div>
            )}
          </div>
        </div>
      )}
      {browsing && (
        <FolderPicker
          title={t.settings.chooseVault}
          confirmLabel={t.settings.useAsVault}
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            setBrowsing(false)
            void m.setVault(path)
          }}
        />
      )}
    </Panel>
  )
}

/** The arrow next to "New note": start one from a template. */
function NewFromTemplate({ templates, onPick }: { templates: NoteMeta[]; onPick: (path: string) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="relative">
      <button
        type="button"
        title={t.memory.fromTemplate}
        aria-label={t.memory.fromTemplate}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-full items-center rounded-r-md border border-l-0 border-cyan/40 bg-cyan/6 px-1.5 text-cyan transition-colors hover:bg-cyan/12"
      >
        <ChevronDown size={13} />
      </button>
      {open && (
        <div role="menu" aria-label={t.memory.fromTemplate} className="absolute right-0 top-full z-30 mt-1 w-56 rounded-md border border-hud/60 bg-panel py-1 shadow-lg">
          {templates.map((n) => (
            <button
              key={n.path}
              type="button"
              role="menuitem"
              // Picks before the window's mousedown closes the menu.
              onMouseDown={(e) => {
                e.stopPropagation()
                setOpen(false)
                onPick(n.path)
              }}
              className="flex w-full px-3 py-1.5 text-left font-sans text-[12.5px] text-text-secondary transition-colors hover:bg-elevated/60 hover:text-text-primary"
            >
              <span className="truncate">{n.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function VaultSetup({
  missing,
  defaultRoot,
  onCreate,
  onPick
}: {
  /** A configured vault folder that no longer exists (moved, unmounted drive). */
  missing?: string
  defaultRoot: string
  onCreate: () => void
  onPick: () => void
}) {
  const t = useT()
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-xl border border-cyan/30 bg-cyan/5 text-cyan">
          <BrainCircuit size={28} strokeWidth={1.6} />
        </span>
        <div>
          <h2 className="font-sans text-lg font-semibold text-text-primary">{t.memory.setupTitle}</h2>
          <p className="mt-2 font-sans text-[13px] leading-relaxed text-text-muted">
            {t.memory.setupBefore} <code className="font-mono text-cyan">[[wikilinks]]</code>
            {t.memory.setupAfter}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={onCreate}
            className="flex items-center gap-2 rounded-md border border-cyan/40 bg-cyan/8 px-3.5 py-2 font-sans text-[13px] font-medium text-cyan transition-colors hover:bg-cyan/[0.14]"
          >
            <Sparkles size={14} />
            {t.memory.createVault}
          </button>
          <button
            type="button"
            onClick={onPick}
            className="flex items-center gap-2 rounded-md border border-hud/60 bg-surface/50 px-3.5 py-2 font-sans text-[13px] font-medium text-text-secondary transition-colors hover:border-cyan/40 hover:text-text-primary"
          >
            <FolderOpen size={14} />
            {t.memory.openExisting}
          </button>
        </div>
        {missing && (
          <p className="flex items-start gap-1.5 font-mono text-[11px] text-amber">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="break-all">{t.memory.notFound(missing)}</span>
          </p>
        )}
        <p className="break-all font-mono text-[11px] text-text-muted">{t.memory.newVaultAt(defaultRoot)}</p>
      </div>
    </div>
  )
}
