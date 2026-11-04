import { errorMessage, ipc, onEvent } from '@shared/ipc/client'
import type { KernelInfo, KernelSpec, KernelState, NotebookEvent } from '@shared/types/notebook'
import { getT } from '@/lib/i18n'
import { monaco } from '../monaco/setup'
import { applyText } from '../monaco/lint'
import { useEditor, type EditorTab } from '../store'
import { addOutput, joinSource, newCell, notebookLanguage, parseNotebook, serializeNotebook, updateCell, type Doc } from './doc'

/** Outputs stream in fast: they reach the file at most this often. */
const OUTPUT_FLUSH_MS = 60

export interface NotebookSnapshot {
  doc?: Doc
  /** The file isn't a notebook Mindeck can show (why). */
  invalid?: string
  info?: KernelInfo
  state: KernelState | 'off'
  error?: string
  settingUp: boolean
  /** Cells waiting for the kernel, the running one first. */
  running: string[]
  /** A cell just added: its editor takes the focus. */
  focus?: string
}

const isNotebook = (path: string) => path.toLowerCase().endsWith('.ipynb')

/**
 * An open notebook (as long as its tab is open, whether shown or not): the
 * cells as read from the file's buffer and written back to it, the kernel
 * that runs them and what it reports.
 */
export class NotebookSession {
  private snapshot: NotebookSnapshot = { state: 'off', settingUp: false, running: [] }
  private listeners = new Set<() => void>()
  private model?: monaco.editor.ITextModel
  private written?: string
  private flushTimer?: ReturnType<typeof setTimeout>
  private started?: string
  private pendingClear = new Set<string>()
  private subs: { dispose(): void }[] = []
  private offEvents: () => void
  private loaded = false

  constructor(
    readonly projectId: string,
    readonly path: string,
    uri: monaco.Uri
  ) {
    const model = monaco.editor.getModel(uri)
    if (model) this.attach(model)
    else this.subs.push(monaco.editor.onDidCreateModel((m) => m.uri.toString() === uri.toString() && this.attach(m)))
    this.offEvents = onEvent('notebook:event', (e) => e.projectId === projectId && e.path === path && this.onKernel(e))
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  get = () => this.snapshot

  private set(patch: Partial<NotebookSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((l) => l())
  }

  // --- the file ---

  private attach(model: monaco.editor.ITextModel): void {
    this.model = model
    this.read()
    this.subs.push(model.onDidChangeContent(() => this.read()))
  }

  /** The buffer changed: what Mindeck wrote itself is already shown. */
  private read(): void {
    const text = this.model!.getValue()
    if (text === this.written) return
    try {
      this.set({ doc: parseNotebook(text), invalid: undefined })
    } catch (err) {
      this.set({ invalid: errorMessage(err) })
    }
  }

  /** The notebook changed: shown now, in the buffer now (streaming outputs: soon). */
  commit(change: (doc: Doc) => Doc, soon = false): void {
    if (!this.snapshot.doc) return
    this.set({ doc: change(this.snapshot.doc) })
    if (!soon) this.flush()
    else this.flushTimer ??= setTimeout(() => this.flush(), OUTPUT_FLUSH_MS)
  }

  flush(): void {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    if (!this.model || this.model.isDisposed() || !this.snapshot.doc) return
    this.written = serializeNotebook(this.snapshot.doc)
    // Only what changed: the buffer's undo keeps edits small.
    applyText(this.model, this.written)
  }

  insert(at: number, type: 'code' | 'markdown'): void {
    const cell = newCell(type)
    this.commit((d) => ({ ...d, cells: [...d.cells.slice(0, at), cell, ...d.cells.slice(at)] }))
    this.set({ focus: cell.key })
  }

  focus(key: string): void {
    this.set({ focus: key })
  }

  // --- the kernel ---

  /** The kernels the project's Python offers (once; again after setting up). */
  async loadKernels(force = false): Promise<void> {
    if (this.loaded && !force) return
    this.loaded = true
    try {
      this.set({ info: await ipc('notebook:kernels', { projectId: this.projectId }) })
    } catch (err) {
      this.set({ error: errorMessage(err) })
    }
  }

  /** The kernel the notebook asks for, else one for its language, else any. */
  kernel(): KernelSpec | undefined {
    const specs = this.snapshot.info?.specs ?? []
    const doc = this.snapshot.doc
    const chosen = doc?.metadata.kernelspec?.name
    const language = doc ? notebookLanguage(doc) : 'python'
    return specs.find((s) => s.name === chosen) ?? specs.find((s) => s.language.toLowerCase() === language) ?? specs[0]
  }

  private async ensureKernel(): Promise<boolean> {
    const kernel = this.kernel()
    const t = getT().notebook
    if (!kernel) {
      this.set({ error: this.snapshot.info && !this.snapshot.info.ready ? t.notReady : t.noKernel })
      return false
    }
    if (this.started === kernel.name) return true
    this.set({ error: undefined })
    try {
      await ipc('notebook:start', { projectId: this.projectId, path: this.path, kernel: kernel.name })
      this.started = kernel.name
      if (this.snapshot.doc?.metadata.kernelspec?.name !== kernel.name) this.useKernel(kernel)
      return true
    } catch (err) {
      this.set({ error: errorMessage(err) })
      return false
    }
  }

  private useKernel(spec: KernelSpec): void {
    this.commit((d) => ({ ...d, metadata: { ...d.metadata, kernelspec: { name: spec.name, display_name: spec.displayName, language: spec.language } } }))
  }

  /** Another kernel for the notebook: the running one stops, the next run starts the new one. */
  chooseKernel(name: string): void {
    const spec = this.snapshot.info!.specs.find((s) => s.name === name)!
    this.useKernel(spec)
    this.started = undefined
    this.set({ state: 'off', running: [] })
    void ipc('notebook:shutdown', { projectId: this.projectId, path: this.path }).catch(() => {})
  }

  /** Run code cells in order (Markdown is skipped); outputs replace the old ones. */
  async run(keys: string[]): Promise<void> {
    const cells = keys.flatMap((k) => this.snapshot.doc!.cells.filter((c) => c.key === k && c.cell_type === 'code'))
    if (!cells.length || !(await this.ensureKernel())) return
    this.set({ running: [...this.snapshot.running, ...cells.map((c) => c.key).filter((k) => !this.snapshot.running.includes(k))] })
    for (const cell of cells) {
      this.pendingClear.delete(cell.key)
      this.commit((d) => updateCell(d, cell.key, (c) => ({ ...c, outputs: [], execution_count: null })))
      try {
        await ipc('notebook:execute', { projectId: this.projectId, path: this.path, cell: cell.key, code: joinSource(cell.source) })
      } catch (err) {
        this.set({ error: errorMessage(err), running: this.snapshot.running.filter((k) => k !== cell.key) })
      }
    }
  }

  interrupt(): void {
    void ipc('notebook:interrupt', { projectId: this.projectId, path: this.path }).catch(() => {})
  }

  restart(): void {
    void ipc('notebook:restart', { projectId: this.projectId, path: this.path }).catch(() => {})
  }

  /** Make the project's Python ready for notebooks (ipykernel; a .venv when it has none). */
  async setup(): Promise<void> {
    this.set({ settingUp: true, error: undefined })
    try {
      await ipc('notebook:setup', { projectId: this.projectId })
      await this.loadKernels(true)
    } catch (err) {
      this.set({ error: errorMessage(err) })
    } finally {
      this.set({ settingUp: false })
    }
  }

  clearError(): void {
    this.set({ error: undefined })
  }

  private onKernel(e: NotebookEvent): void {
    if (e.type === 'status') {
      if (e.state === 'dead') this.started = undefined
      return this.set({ state: e.state, ...(e.state === 'dead' || e.state === 'restarting' ? { running: [] } : {}) })
    }
    if (e.type === 'done') return this.set({ running: this.snapshot.running.filter((k) => k !== e.cell) })
    if (e.type === 'clear') {
      if (e.wait) this.pendingClear.add(e.cell)
      else this.commit((d) => updateCell(d, e.cell, (c) => ({ ...c, outputs: [] })), true)
      return
    }
    if (e.type === 'count') return this.commit((d) => updateCell(d, e.cell, (c) => ({ ...c, execution_count: e.count })), true)
    const clear = this.pendingClear.delete(e.cell)
    this.commit((d) => updateCell(d, e.cell, (c) => ({ ...c, outputs: addOutput(clear ? [] : (c.outputs ?? []), e.output, getT().notebook.outputCut) })), true)
  }

  /** The tab closed: the last outputs go into the buffer, the kernel stops. */
  dispose(): void {
    this.flush()
    this.subs.forEach((s) => s.dispose())
    this.offEvents()
    void ipc('notebook:shutdown', { projectId: this.projectId, path: this.path }).catch(() => {})
  }
}

const sessions = new Map<string, NotebookSession>()

/** The session of a notebook tab (made on first sight). */
export function notebookSession(tab: EditorTab, uri: monaco.Uri): NotebookSession {
  let session = sessions.get(tab.id)
  if (!session) {
    session = new NotebookSession(tab.projectId, tab.path, uri)
    sessions.set(tab.id, session)
  }
  return session
}

/** A notebook's tab closed (or moved on with a rename): its session ends. */
useEditor.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return
  for (const tab of prev.tabs) {
    if (!isNotebook(tab.path) || s.tabs.some((t) => t.id === tab.id)) continue
    sessions.get(tab.id)?.dispose()
    sessions.delete(tab.id)
  }
})
