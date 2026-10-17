import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowDown, ArrowUp, Braces, Check, Eraser, Loader2, Play, Plus, RotateCcw, Square, Trash2, Wrench, X } from 'lucide-react'
import type { NotebookOutput } from '@shared/types/notebook'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { interceptLinks } from '@/lib/links'
import { sanitizeFrameHtml } from '@/lib/sanitize'
import { Markdown } from '@/components/ui/Markdown'
import { renderMarkdown } from '@/features/memory/markdown'
import { Select } from '@/components/ui/Select'
import { monaco, THEME } from '../monaco/setup'
import { joinSource, notebookLanguage, splitSource, stripAnsi, updateCell, type Cell } from '../notebook/doc'
import { notebookSession } from '../notebook/session'
import { fileUri } from './CodeEditor'
import type { EditorTab } from '../store'

const tool = 'flex h-7 items-center gap-1 rounded-sm px-2 font-sans text-[12px] text-text-secondary transition-colors hover:bg-elevated hover:text-text-primary disabled:pointer-events-none disabled:opacity-40'
const icon = 'flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-elevated hover:text-text-primary disabled:opacity-40'
type Run = 'stay' | 'next' | 'insert'

/** One cell's code, in its own small Monaco editor that grows with its text. */
function CellEditor({ value, language, readOnly, focus, onChange, onRun, onEscape }: { value: string; language: string; readOnly: boolean; focus?: boolean; onChange: (text: string) => void; onRun: (how: Run) => void; onEscape?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor>()
  const handlers = useRef({ onChange, onRun, onEscape })
  handlers.current = { onChange, onRun, onEscape }

  useEffect(() => {
    const model = monaco.editor.createModel(value, language)
    const editor = monaco.editor.create(host.current!, {
      model,
      theme: THEME,
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      lineNumbers: 'off',
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 8,
      renderLineHighlight: 'none',
      overviewRulerLanes: 0,
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 20,
      padding: { top: 6, bottom: 6 },
      fixedOverflowWidgets: true,
      scrollbar: { vertical: 'hidden', horizontalScrollbarSize: 6, alwaysConsumeMouseWheel: false }
    })
    editorRef.current = editor
    const fit = () => {
      host.current!.style.height = `${Math.max(32, editor.getContentHeight())}px`
    }
    fit()
    const subs = [editor.onDidContentSizeChange(fit), model.onDidChangeContent(() => handlers.current.onChange(model.getValue()))]
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => handlers.current.onRun('next'))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => handlers.current.onRun('stay'))
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => handlers.current.onRun('insert'))
    editor.addCommand(monaco.KeyCode.Escape, () => handlers.current.onEscape?.(), '!suggestWidgetVisible')
    if (focus) editor.focus()
    return () => {
      subs.forEach((s) => s.dispose())
      editor.dispose()
      model.dispose()
    }
    // The editor lives as long as the cell; text from outside comes in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [])

  // The file changed under the cell (undo in the JSON, a reload from disk): show it.
  useEffect(() => {
    const model = editorRef.current!.getModel()!
    if (model.getValue() !== value) model.setValue(value)
  }, [value])

  useEffect(() => {
    editorRef.current!.updateOptions({ readOnly })
  }, [readOnly])

  return <div ref={host} className="min-h-8 w-full" />
}

/**
 * HTML from a kernel (pandas tables, rich reprs): sanitized, in a frame of its
 * own. `allow-same-origin` (to measure the height) must never meet
 * `allow-scripts`: together they would hand the frame the app itself.
 */
function HtmlOutput({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  // The app's light or dark: without the same colour scheme the frame paints itself white.
  const root = getComputedStyle(document.documentElement)
  const scheme = root.colorScheme || 'normal'
  const color = getComputedStyle(document.body).color
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:${scheme}}body{margin:0;font:12.5px ui-sans-serif,system-ui,sans-serif;color:${color};background:transparent;overflow:auto}table{border-collapse:collapse}th,td{border:1px solid rgba(140,160,190,.3);padding:2px 8px;text-align:right}th{background:rgba(140,160,190,.12)}a{color:#38d6e8}</style></head><body>${sanitizeFrameHtml(html)}</body></html>`
  const fit = () => {
    const el = frame.current!
    el.style.height = `${Math.min(600, el.contentDocument!.body.scrollHeight + 4)}px`
  }
  return <iframe ref={frame} title="output" sandbox="allow-same-origin" srcDoc={doc} onLoad={fit} className="h-8 w-full rounded-sm border-0 bg-transparent" />
}

const text = (value: unknown) => (Array.isArray(value) ? value.join('') : String(value ?? ''))

/** One output, in the richest form the kernel gave and Mindeck shows. */
function Output({ output }: { output: NotebookOutput }) {
  const pre = 'max-h-[420px] overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-[12px] leading-normal'
  if (output.output_type === 'stream') return <pre className={cn(pre, output.name === 'stderr' ? 'text-danger/90' : 'text-text-secondary')}>{stripAnsi(joinSource(output.text))}</pre>
  if (output.output_type === 'error')
    return (
      <pre role="alert" className={cn(pre, 'rounded-sm border border-danger/30 bg-danger/6 px-2 py-1 text-text-secondary')}>
        <span className="text-danger">{`${output.ename}: ${output.evalue}`}</span>
        {output.traceback.length > 1 && `\n${stripAnsi(output.traceback.join('\n'))}`}
      </pre>
    )
  const data = output.data
  if (data['image/png'] || data['image/jpeg']) {
    const type = data['image/png'] ? 'image/png' : 'image/jpeg'
    return <img alt="" src={`data:${type};base64,${text(data[type]).replace(/\s/g, '')}`} className="max-w-full rounded-sm bg-white/90" />
  }
  if (data['image/svg+xml']) return <img alt="" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text(data['image/svg+xml']))}`} className="max-w-full rounded-sm bg-white/90" />
  if (data['text/html']) return <HtmlOutput html={text(data['text/html'])} />
  if (data['text/markdown']) return <Markdown text={text(data['text/markdown'])} />
  if (data['application/json'] !== undefined) return <pre className={cn(pre, 'text-text-secondary')}>{JSON.stringify(data['application/json'], null, 2)}</pre>
  return <pre className={cn(pre, 'text-text-primary')}>{stripAnsi(text(data['text/plain']))}</pre>
}

interface CellProps {
  cell: Cell
  index: number
  count: number
  language: string
  readOnly: boolean
  running: boolean
  queued: boolean
  focus: boolean
  onChange: (key: string, source: string) => void
  onRun: (key: string, how: Run) => void
  onDelete: (key: string) => void
  onMove: (key: string, by: -1 | 1) => void
  onType: (key: string, type: 'code' | 'markdown') => void
}

function CellView({ cell, index, count, language, readOnly, running, queued, focus, onChange, onRun, onDelete, onMove, onType }: CellProps) {
  const t = useT().notebook
  const source = joinSource(cell.source)
  const [editing, setEditing] = useState(cell.cell_type !== 'markdown' || !source || focus)
  const markdown = cell.cell_type === 'markdown'
  const html = useMemo(() => (markdown && !editing ? renderMarkdown(source) : ''), [markdown, editing, source])
  const run = (how: Run) => {
    if (markdown) setEditing(false)
    onRun(cell.key, how)
  }
  const label = cell.cell_type === 'code' ? (running ? '[*]' : queued ? '[-]' : `[${cell.execution_count ?? ' '}]`) : ''

  return (
    <section aria-label={t.cell(index + 1)} className="group relative flex gap-2 rounded-md border border-transparent px-1 py-1 hover:border-hud/50 focus-within:border-cyan/40">
      <div className="flex w-12 shrink-0 flex-col items-end gap-1 pt-1">
        {cell.cell_type === 'code' && !readOnly && (
          <button type="button" aria-label={t.run} title={t.run} onClick={() => onRun(cell.key, 'stay')} className={cn(icon, running && 'text-cyan')}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={12} />}
          </button>
        )}
        <span className="font-mono text-[10.5px] text-text-muted">{label}</span>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {markdown && !editing ? (
          <div
            role="article"
            onDoubleClick={() => !readOnly && setEditing(true)}
            onClick={interceptLinks}
            className="md-prose min-h-6 cursor-text px-1"
            dangerouslySetInnerHTML={{ __html: html || `<p class="text-text-muted">${t.emptyMarkdown}</p>` }}
          />
        ) : (
          <div className={cn('overflow-hidden rounded-sm border border-hud/50', cell.cell_type === 'code' ? 'bg-void/40' : 'bg-surface/40')}>
            <CellEditor value={source} language={markdown ? 'markdown' : cell.cell_type === 'raw' ? 'plaintext' : language} readOnly={readOnly} focus={focus} onChange={(s) => onChange(cell.key, s)} onRun={run} onEscape={markdown ? () => setEditing(false) : undefined} />
          </div>
        )}
        {!!cell.outputs?.length && (
          <div aria-label={t.outputs} className="space-y-1.5 px-1">
            {cell.outputs.map((o, i) => (
              <Output key={i} output={o} />
            ))}
          </div>
        )}
      </div>
      {!readOnly && (
        <div className="absolute right-1 top-1 hidden items-center gap-0.5 rounded-sm bg-elevated/90 group-hover:flex group-focus-within:flex">
          {markdown && editing && (
            <button type="button" aria-label={t.done} title={t.done} onClick={() => setEditing(false)} className={icon}>
              <Check size={12} />
            </button>
          )}
          <button type="button" aria-label={markdown ? t.toCode : t.toMarkdown} title={markdown ? t.toCode : t.toMarkdown} onClick={() => onType(cell.key, markdown ? 'code' : 'markdown')} className={cn(icon, 'w-auto px-1 font-mono text-[10px]')}>
            {markdown ? '{ }' : 'M↓'}
          </button>
          <button type="button" aria-label={t.moveUp} title={t.moveUp} disabled={index === 0} onClick={() => onMove(cell.key, -1)} className={icon}>
            <ArrowUp size={12} />
          </button>
          <button type="button" aria-label={t.moveDown} title={t.moveDown} disabled={index === count - 1} onClick={() => onMove(cell.key, 1)} className={icon}>
            <ArrowDown size={12} />
          </button>
          <button type="button" aria-label={t.delete} title={t.delete} onClick={() => onDelete(cell.key)} className={cn(icon, 'hover:text-danger')}>
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </section>
  )
}

interface Props {
  tab: EditorTab
  /** No kernels here (a remote window without shells): view and edit only. */
  readOnly: boolean
  /** Show the file as JSON (the text editor underneath). */
  onRaw: () => void
}

/**
 * A Jupyter notebook in the editor: cells with their own small editors,
 * Markdown rendered, outputs as the kernel gave them. The notebook is the
 * file's buffer underneath — saving, unsaved changes, undo of the file and
 * reloads from disk work as for any file; cells run in a Jupyter kernel
 * that keeps running while the tab is open.
 */
export default function NotebookView({ tab, readOnly, onRaw }: Props) {
  const t = useT().notebook
  const session = useMemo(() => notebookSession(tab, fileUri(tab.projectId, tab.path)), [tab])
  const { doc, invalid, info, state, error, settingUp, running, focus } = useSyncExternalStore(session.subscribe, session.get)

  useEffect(() => {
    if (!readOnly) void session.loadKernels()
  }, [session, readOnly])

  if (invalid)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-panel p-6 text-center">
        <p role="alert" className="max-w-md font-sans text-[13px] text-text-secondary">
          {t.invalid(invalid)}
        </p>
        <button type="button" onClick={onRaw} className={cn(tool, 'border border-hud')}>
          <Braces size={13} /> {t.raw}
        </button>
      </div>
    )
  if (!doc) return <div className="h-full bg-panel" />

  const language = notebookLanguage(doc)
  const kernel = session.kernel()
  const specs = info?.specs ?? []
  const busy = running.length > 0
  const onRun = (key: string, how: Run) => {
    const index = doc.cells.findIndex((c) => c.key === key)
    void session.run([key])
    if (how === 'insert' || (how === 'next' && index === doc.cells.length - 1)) session.insert(index + 1, 'code')
    else if (how === 'next') session.focus(doc.cells[index + 1].key)
  }

  return (
    <div className="flex h-full flex-col bg-panel">
      <div role="toolbar" aria-label={t.toolbar} className="flex shrink-0 flex-wrap items-center gap-1 border-b border-hud/60 px-2 py-1">
        <button type="button" disabled={readOnly} onClick={() => void session.run(doc.cells.map((c) => c.key))} className={tool}>
          <Play size={12} /> {t.runAll}
        </button>
        <button type="button" disabled={readOnly || !busy} onClick={() => session.interrupt()} className={tool}>
          <Square size={11} /> {t.interrupt}
        </button>
        <button type="button" disabled={readOnly || state === 'off' || state === 'dead'} onClick={() => session.restart()} className={tool}>
          <RotateCcw size={12} /> {t.restart}
        </button>
        <button type="button" disabled={readOnly} onClick={() => session.commit((d) => ({ ...d, cells: d.cells.map((c) => (c.cell_type === 'code' ? { ...c, outputs: [], execution_count: null } : c)) }))} className={tool}>
          <Eraser size={12} /> {t.clearOutputs}
        </button>
        <span className="mx-1 h-4 w-px bg-hud/60" />
        <button type="button" disabled={readOnly} onClick={() => session.insert(doc.cells.length, 'code')} className={tool}>
          <Plus size={12} /> {t.addCode}
        </button>
        <button type="button" disabled={readOnly} onClick={() => session.insert(doc.cells.length, 'markdown')} className={tool}>
          <Plus size={12} /> {t.addMarkdown}
        </button>
        <div className="ml-auto flex items-center gap-2">
          {!readOnly && info && !info.ready ? (
            <button type="button" title={t.setupHint(info.venv)} disabled={settingUp} onClick={() => void session.setup()} className={cn(tool, 'border border-cyan/40 text-cyan')}>
              {settingUp ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />} {settingUp ? t.settingUp : t.setup}
            </button>
          ) : (
            !readOnly &&
            specs.length > 0 && (
              <div className="w-48">
                <Select label={t.kernel} value={kernel!.name} onChange={(name) => session.chooseKernel(name)} options={specs.map((s) => ({ value: s.name, label: s.displayName }))} />
              </div>
            )
          )}
          <span role="status" className="flex items-center gap-1.5 font-mono text-[10.5px] text-text-muted">
            <span className={cn('h-1.5 w-1.5 rounded-full', state === 'idle' ? 'bg-green' : state === 'off' || state === 'dead' ? 'bg-text-muted/50' : 'bg-amber')} />
            {readOnly ? t.readOnly : t.states[state]}
          </span>
          <button type="button" aria-label={t.raw} title={t.raw} onClick={onRaw} className={icon}>
            <Braces size={13} />
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="flex shrink-0 items-start gap-2 border-b border-danger/30 bg-danger/6 px-3 py-1.5 font-sans text-[12px] text-danger">
          <span className="flex-1 whitespace-pre-wrap">{error}</span>
          <button type="button" aria-label={t.dismiss} onClick={() => session.clearError()}>
            <X size={12} />
          </button>
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="mx-auto max-w-5xl space-y-1">
          {doc.cells.map((cell, i) => (
            <CellView
              key={cell.key}
              cell={cell}
              index={i}
              count={doc.cells.length}
              language={language}
              readOnly={readOnly}
              running={running[0] === cell.key}
              queued={running.includes(cell.key) && running[0] !== cell.key}
              focus={focus === cell.key}
              onChange={(key, source) => session.commit((d) => updateCell(d, key, (c) => ({ ...c, source: splitSource(source) })))}
              onRun={onRun}
              onDelete={(key) => session.commit((d) => ({ ...d, cells: d.cells.filter((c) => c.key !== key) }))}
              onMove={(key, by) =>
                session.commit((d) => {
                  const cells = [...d.cells]
                  const from = cells.findIndex((c) => c.key === key)
                  cells.splice(from + by, 0, ...cells.splice(from, 1))
                  return { ...d, cells }
                })
              }
              onType={(key, type) =>
                session.commit((d) =>
                  updateCell(d, key, (c) => {
                    const { outputs: _o, execution_count: _n, ...rest } = c
                    return type === 'code' ? { ...rest, cell_type: 'code', outputs: [], execution_count: null } : { ...rest, cell_type: 'markdown' }
                  })
                )
              }
            />
          ))}
          {!readOnly && (
            <div className="flex justify-center gap-2 pt-2 opacity-60 hover:opacity-100">
              <button type="button" onClick={() => session.insert(doc.cells.length, 'code')} className={cn(tool, 'border border-dashed border-hud')}>
                <Plus size={12} /> {t.addCode}
              </button>
              <button type="button" onClick={() => session.insert(doc.cells.length, 'markdown')} className={cn(tool, 'border border-dashed border-hud')}>
                <Plus size={12} /> {t.addMarkdown}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
