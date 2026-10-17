import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, BookOpen, Check, Code2, FileStack, Link2, Loader2, PencilLine, Plus, Search, Trash2, X } from 'lucide-react'
import type { Note, NoteMeta } from '@shared/types/memory'
import { TechLabel } from '@/components/ui/TechLabel'
import { cn } from '@/lib/cn'
import { intlLocale, useT } from '@/lib/i18n'
import { openExternal } from '@/lib/links'
import { renderMarkdown } from '../markdown'
import { usePaneFocused } from '@/features/workspace/pane'
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor'

interface Props {
  note: Note
  notes: NoteMeta[]
  /** Notes in the templates folder. */
  templates: NoteMeta[]
  draft: string
  mode: 'edit' | 'preview'
  /** Editing shows plain Markdown instead of Live Preview. */
  source: boolean
  saving: boolean
  onDraft: (body: string) => void
  onMode: (mode: 'edit' | 'preview') => void
  onSource: (source: boolean) => void
  onInsertTemplate: (path: string) => Promise<string | null>
  onAttach: (file: File) => Promise<string | null>
  loadImage: (target: string) => Promise<string | null>
  onSave: () => void
  onRename: (title: string) => void
  onOpen: (path: string) => void
  onOpenOrCreate: (title: string) => void
  onLink: (to: string) => void
  onUnlink: (from: string, to: string) => void
  onTrash: () => void
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s)
  } catch {
    return s
  }
}

/** Shown elsewhere in the header (type badge, tag chips) or internal (id). */
const HIDDEN_PROPS = new Set(['id', 'type', 'tags', 'tag'])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

function formatValue(v: unknown): string {
  if (v instanceof Date) return v.toLocaleString(intlLocale())
  if (typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v))) {
    return new Date(v).toLocaleString(intlLocale())
  }
  if (Array.isArray(v)) return v.join(', ')
  if (v && typeof v === 'object') return JSON.stringify(v)
  return String(v ?? '')
}

/**
 * One note: Live Preview, source or read (the text only — the frontmatter
 * stays hidden and untouched), an editable title (renaming keeps links
 * intact), and the connections in both directions with link / unlink
 * controls.
 */
export function NoteEditor(p: Props) {
  const t = useT()
  const { note } = p
  const [confirmTrash, setConfirmTrash] = useState(false)
  const editor = useRef<MarkdownEditorHandle>(null)
  const preview = useRef<HTMLDivElement>(null)
  const { mode, onMode, onSave } = p
  const dirty = p.draft !== note.body
  const html = useMemo(() => renderMarkdown(note.body, note.links), [note.body, note.links])
  const props = Object.entries(note.frontmatter).filter(([k]) => !HIDDEN_PROPS.has(k))
  const byPath = useMemo(() => new Map(p.notes.map((n) => [n.path, n])), [p.notes])

  const outgoing = useMemo(
    () =>
      [...new Set(Object.values(note.links).filter((x): x is string => !!x && x !== note.path))]
        .map((path) => byPath.get(path))
        .filter((n): n is NoteMeta => !!n)
        .sort((a, b) => a.title.localeCompare(b.title)),
    [note.links, note.path, byPath]
  )

  useEffect(() => setConfirmTrash(false), [note.path])

  // Read mode: pictures come from the vault, never from where the note says.
  const { loadImage } = p
  useEffect(() => {
    if (mode !== 'preview') return
    let alive = true
    preview.current?.querySelectorAll<HTMLImageElement>('img[data-embed]').forEach((img) => {
      void loadImage(img.dataset.embed!).then((url) => {
        if (!alive) return
        if (url) img.src = url
        else img.classList.add('missing')
      })
    })
    return () => {
      alive = false
    }
  }, [html, mode, loadImage])

  // Obsidian shortcuts: ⌘/Ctrl+E toggles read/edit, ⌘/Ctrl+S saves now.
  // Only while Memory's pane has the focus — next to the editor, ⌘S is the editor's.
  const focused = usePaneFocused()
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key === 'e') {
        e.preventDefault()
        onMode(mode === 'edit' ? 'preview' : 'edit')
      } else if (key === 's') {
        e.preventDefault()
        onSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, onMode, onSave, focused])

  /** A Markdown link: web addresses leave the app (main routes them to a browser), `.md` paths open notes. */
  const followHref = (href: string) => {
    if (openExternal(href)) return
    const target = safeDecode(href.split('#')[0])
    const path = note.links[target]
    if (path) p.onOpen(path)
    else if (/\.md$/i.test(target)) p.onOpenOrCreate(target)
  }

  const onPreviewClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    if (a.classList.contains('wikilink')) {
      const target = a.dataset.target ?? ''
      const path = note.links[target]
      if (path) p.onOpen(path)
      else p.onOpenOrCreate(target)
      return
    }
    followHref(a.getAttribute('href') ?? '')
  }

  const seg = 'flex items-center gap-1.5 rounded-sm px-2 py-1 font-sans text-[11px] font-medium transition-colors'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* note header */}
      <div className="flex items-start gap-3 border-b border-hud/50 px-5 py-3">
        <div className="min-w-0 flex-1">
          {note.folder && (
            <TechLabel className="mb-1 block truncate text-text-muted">
              {note.path.slice(0, note.path.lastIndexOf('/')).replace(/\//g, ' / ')}
            </TechLabel>
          )}
          <TitleInput key={note.path} title={note.title} onRename={p.onRename} />
          {(note.type || note.tags.length > 0) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {note.type && (
                <span className="rounded-sm border border-cyan/30 bg-cyan/6 px-1.5 py-px font-mono text-[10px] text-cyan">
                  {note.type}
                </span>
              )}
              {note.tags.map((tag) => (
                <span key={tag} className="rounded-sm border border-hud/60 bg-elevated/50 px-1.5 py-px font-mono text-[10px] text-purple">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="flex items-center gap-1 font-mono text-[10px] text-text-muted">
            {p.saving ? (
              <>
                <Loader2 size={11} className="animate-spin" /> {t.memory.saving}
              </>
            ) : dirty ? (
              t.memory.unsaved
            ) : (
              <>
                <Check size={11} /> {t.memory.saved}
              </>
            )}
          </span>
          {mode === 'edit' && p.templates.length > 0 && (
            <TemplatePicker templates={p.templates} onPick={(path) => void p.onInsertTemplate(path).then((text) => text && editor.current?.insert(text))} />
          )}
          <div className="flex rounded-md border border-hud/60 bg-surface/50 p-0.5">
            <button
              type="button"
              title={t.memory.liveTitle}
              aria-pressed={mode === 'edit' && !p.source}
              onClick={() => p.onSource(false)}
              className={cn(seg, mode === 'edit' && !p.source ? 'bg-cyan/10 text-cyan' : 'text-text-muted hover:text-text-secondary')}
            >
              <PencilLine size={12} /> {t.memory.live}
            </button>
            <button
              type="button"
              title={t.memory.sourceTitle}
              aria-pressed={mode === 'edit' && p.source}
              onClick={() => p.onSource(true)}
              className={cn(seg, mode === 'edit' && p.source ? 'bg-cyan/10 text-cyan' : 'text-text-muted hover:text-text-secondary')}
            >
              <Code2 size={12} /> {t.memory.source}
            </button>
            <button
              type="button"
              title={t.memory.readTitle}
              aria-pressed={mode === 'preview'}
              onClick={() => onMode('preview')}
              className={cn(seg, mode === 'preview' ? 'bg-cyan/10 text-cyan' : 'text-text-muted hover:text-text-secondary')}
            >
              <BookOpen size={12} /> {t.memory.read}
            </button>
          </div>
          {confirmTrash ? (
            <button
              type="button"
              onClick={p.onTrash}
              onBlur={() => setConfirmTrash(false)}
              autoFocus
              className="rounded-md border border-danger/50 bg-danger/10 px-2 py-1 font-sans text-[11px] font-medium text-danger"
            >
              {t.memory.trashConfirm}
            </button>
          ) : (
            <button
              type="button"
              title={t.memory.trash}
              onClick={() => setConfirmTrash(true)}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-hud/60 text-text-muted transition-colors hover:border-danger/50 hover:text-danger"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === 'edit' ? (
          <MarkdownEditor
            key={note.path}
            ref={editor}
            value={p.draft}
            live={!p.source}
            notes={p.notes}
            placeholder={t.memory.writeHint}
            onChange={p.onDraft}
            onOpenNote={p.onOpenOrCreate}
            onOpenUrl={followHref}
            onAttach={p.onAttach}
            loadImage={p.loadImage}
          />
        ) : (
          <div className="mx-auto max-w-3xl px-5 py-4">
            {props.length > 0 && (
              <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-hud/50 bg-surface/40 px-3 py-2">
                {props.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="font-mono text-[11px] text-text-muted">{k}</dt>
                    <dd className="truncate font-mono text-[11px] text-text-secondary">{formatValue(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {note.body.trim() ? (
              <div ref={preview} className="md-prose" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <button type="button" onClick={() => onMode('edit')} className="font-sans text-[13px] text-text-muted hover:text-cyan">
                {t.memory.emptyNote}
              </button>
            )}
          </div>
        )}
      </div>

      {/* connections, both directions — only the chips scroll, so the
          "Connect" menu (opening upward) is never clipped */}
      <div className="shrink-0 border-t border-hud/50 px-5 py-2.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          <Link2 size={12} className="text-text-muted" />
          <TechLabel className="text-text-secondary">{t.memory.connections}</TechLabel>
          <span className="font-mono text-[10px] text-text-muted">{outgoing.length + note.backlinks.length}</span>
          <ConnectPicker
            notes={p.notes.filter((n) => n.path !== note.path && !outgoing.some((o) => o.path === n.path))}
            onPick={p.onLink}
          />
        </div>
        {outgoing.length === 0 && note.backlinks.length === 0 ? (
          <p className="font-sans text-[12px] text-text-muted">{t.memory.notConnected}</p>
        ) : (
          <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
            {outgoing.map((n) => (
              <ConnectionChip
                key={`out-${n.path}`}
                title={n.title}
                direction="out"
                onOpen={() => p.onOpen(n.path)}
                onRemove={() => p.onUnlink(note.path, n.path)}
              />
            ))}
            {note.backlinks
              .filter((b) => !outgoing.some((o) => o.path === b.path))
              .map((b) => (
                <ConnectionChip
                  key={`in-${b.path}`}
                  title={b.title}
                  direction="in"
                  onOpen={() => p.onOpen(b.path)}
                  onRemove={() => p.onUnlink(b.path, note.path)}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** The note title as an input: Enter or leaving the field renames the file. */
function TitleInput({ title, onRename }: { title: string; onRename: (title: string) => void }) {
  const t = useT()
  const [value, setValue] = useState(title)
  const commit = () => (value.trim() && value.trim() !== title ? onRename(value) : setValue(title))
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setValue(title)
          e.currentTarget.blur()
        }
      }}
      title={t.memory.renameHint}
      spellCheck={false}
      className="-mx-1 w-full truncate rounded-sm bg-transparent px-1 font-sans text-[18px] font-semibold text-text-primary outline-hidden transition-colors hover:bg-elevated/40 focus:bg-elevated/60 focus:ring-1 focus:ring-cyan/40"
    />
  )
}

function ConnectionChip({
  title,
  direction,
  onOpen,
  onRemove
}: {
  title: string
  direction: 'out' | 'in'
  onOpen: () => void
  onRemove: () => void
}) {
  const t = useT()
  const Icon = direction === 'out' ? ArrowUpRight : ArrowDownLeft
  return (
    <span className="group flex items-center rounded-md border border-hud/60 bg-surface/50 text-text-secondary transition-colors hover:border-cyan/40">
      <button
        type="button"
        onClick={onOpen}
        title={direction === 'out' ? t.memory.linksTo : t.memory.linkedFrom}
        className="flex items-center gap-1 py-1 pl-2 pr-1 font-sans text-[12px] hover:text-cyan"
      >
        <Icon size={11} className="text-text-muted" />
        {title}
      </button>
      <button
        type="button"
        onClick={onRemove}
        title={t.memory.disconnectHint}
        aria-label={t.memory.disconnect(title)}
        className="mr-1 rounded-sm p-0.5 text-text-muted opacity-0 transition-opacity hover:bg-elevated hover:text-danger group-hover:opacity-100"
      >
        <X size={11} />
      </button>
    </span>
  )
}

/** "+ Connect": search any note and link to it. */
function ConnectPicker({ notes, onPick }: { notes: NoteMeta[]; onPick: (path: string) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Exact title first, then "starts with", then "contains" — so Enter picks
  // "Mindeck" over "Ideen für Mindeck".
  const needle = q.trim().toLowerCase()
  const rank = (title: string) => {
    const lower = title.toLowerCase()
    return lower === needle ? 0 : lower.startsWith(needle) ? 1 : 2
  }
  const matches = notes
    .filter((n) => n.title.toLowerCase().includes(needle))
    .sort((a, b) => rank(a.title) - rank(b.title) || a.title.localeCompare(b.title))
    .slice(0, 30)

  return (
    <div ref={ref} className="relative ml-auto">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o)
          setQ('')
        }}
        className="flex items-center gap-1 rounded-md border border-cyan/40 bg-cyan/6 px-2 py-0.5 font-sans text-[11px] font-medium text-cyan transition-colors hover:bg-cyan/12"
      >
        <Plus size={12} /> {t.memory.connect}
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1 w-72 rounded-md border border-hud/60 bg-panel shadow-lg">
          <label className="flex items-center gap-2 border-b border-hud/50 px-2.5 py-2">
            <Search size={12} className="text-text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false)
                if (e.key === 'Enter' && matches[0]) {
                  onPick(matches[0].path)
                  setOpen(false)
                }
              }}
              placeholder={t.memory.connectTo}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent font-sans text-[12px] text-text-primary outline-hidden placeholder:text-text-muted/70"
            />
          </label>
          <div className="max-h-56 overflow-y-auto py-1">
            {matches.length === 0 && <p className="px-3 py-2 font-sans text-[12px] text-text-muted">{t.memory.noMatch}</p>}
            {matches.map((n) => (
              <button
                key={n.path}
                type="button"
                onClick={() => {
                  onPick(n.path)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-elevated/60"
              >
                <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-text-secondary">{n.title}</span>
                {n.folder && <span className="font-mono text-[10px] text-text-muted">{n.folder}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** "Insert template": a note from the templates folder, filled in at the cursor. */
function TemplatePicker({ templates, onPick }: { templates: NoteMeta[]; onPick: (path: string) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={t.memory.insertTemplate}
        aria-label={t.memory.insertTemplate}
        aria-expanded={open}
        // Keep the editor's cursor where it is.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-hud/60 text-text-muted transition-colors hover:border-cyan/40 hover:text-cyan"
      >
        <FileStack size={13} />
      </button>
      {open && (
        <div role="menu" aria-label={t.memory.insertTemplate} className="absolute right-0 top-full z-30 mt-1 w-60 rounded-md border border-hud/60 bg-panel py-1 shadow-lg">
          {templates.map((n) => (
            <button
              key={n.path}
              type="button"
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false)
                onPick(n.path)
              }}
              className="flex w-full items-center px-3 py-1.5 text-left font-sans text-[12.5px] text-text-secondary transition-colors hover:bg-elevated/60 hover:text-text-primary"
            >
              <span className="truncate">{n.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
