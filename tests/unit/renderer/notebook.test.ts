import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import type { NotebookDocument } from '@shared/types/notebook'

// --- A Monaco stand-in: text models at file URIs, minimal edits ---
const mon = vi.hoisted(() => {
  type Fn = (...a: never[]) => unknown
  class Emitter {
    fns = new Set<Fn>()
    event = (fn: Fn) => (this.fns.add(fn), { dispose: () => this.fns.delete(fn) })
    fire(...a: unknown[]) {
      this.fns.forEach((f) => (f as (...x: unknown[]) => unknown)(...a))
    }
  }
  class Range {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number
    ) {}
  }
  class Model {
    change = new Emitter()
    disposed = false
    edits = 0
    constructor(
      public value: string,
      public uri: { toString(): string }
    ) {}
    getValue() {
      return this.value
    }
    isDisposed() {
      return this.disposed
    }
    onDidChangeContent(fn: Fn) {
      return this.change.event(fn)
    }
    getPositionAt(offset: number) {
      const before = this.value.slice(0, offset).split('\n')
      return { lineNumber: before.length, column: before.at(-1)!.length + 1 }
    }
    offsetAt(line: number, column: number) {
      return this.value.split('\n').slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1
    }
    pushEditOperations(_s: unknown, edits: { range: Range; text: string }[]) {
      for (const e of edits) {
        const from = this.offsetAt(e.range.startLineNumber, e.range.startColumn)
        const to = this.offsetAt(e.range.endLineNumber, e.range.endColumn)
        this.value = this.value.slice(0, from) + e.text + this.value.slice(to)
      }
      this.edits += 1
      this.change.fire({})
    }
    /** An edit from elsewhere (undo, a reload from disk). */
    set(value: string) {
      this.value = value
      this.change.fire({})
    }
  }
  const models = new Map<string, InstanceType<typeof Model>>()
  const created = new Emitter()
  return {
    Model,
    models,
    created,
    add(uri: string, value: string) {
      const m = new Model(value, { toString: () => uri })
      models.set(uri, m)
      created.fire(m)
      return m
    },
    monaco: {
      Range,
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
      editor: {
        getModel: (uri: { toString(): string }) => models.get(uri.toString()) ?? null,
        onDidCreateModel: (fn: Fn) => created.event(fn)
      }
    }
  }
})
vi.mock('@/features/editor/monaco/setup', () => ({ monaco: mon.monaco }))

import { addOutput, joinSource, newCell, notebookLanguage, parseNotebook, serializeNotebook, splitSource, stripAnsi, updateCell } from '@/features/editor/notebook/doc'
import { NotebookSession, notebookSession } from '@/features/editor/notebook/session'
import { tabKey, useEditor, type EditorTab } from '@/features/editor/store'

const NB: NotebookDocument = {
  cells: [
    { id: 'm1', cell_type: 'markdown', source: ['# Title\n', 'text'], metadata: {} },
    { id: 'c1', cell_type: 'code', source: 'print(1)', metadata: {}, execution_count: 3, outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }] },
    { id: 'c2', cell_type: 'code', source: ['1/0'], metadata: {}, execution_count: null, outputs: [] }
  ],
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
  nbformat: 4,
  nbformat_minor: 5
}
const text = (nb: object = NB) => `${JSON.stringify(nb, null, 1)}\n`
const uri = (path: string) => `file:///p/${path}`
const fakeUri = (path: string) => ({ toString: () => uri(path) }) as never

describe('the notebook format', () => {
  it('reads nbformat 4; refuses what isn’t a notebook; an empty file is an empty notebook', () => {
    const doc = parseNotebook(text())
    expect(doc.cells.map((c) => c.key)).toEqual(['m1', 'c1', 'c2'])
    expect(parseNotebook('')).toMatchObject({ cells: [], nbformat: 4, nbformat_minor: 5 })
    expect(() => parseNotebook('{"cells": 1}')).toThrow('Not a Jupyter notebook')
    expect(() => parseNotebook('null')).toThrow('Not a Jupyter notebook')
    expect(() => parseNotebook(JSON.stringify({ cells: [], nbformat: 3 }))).toThrow('nbformat 3')
    expect(() => parseNotebook('{ nope')).toThrow()
    // Older files: cells without ids or metadata get keys of their own.
    const old = parseNotebook(JSON.stringify({ cells: [{ cell_type: 'code', source: 'x' }], nbformat: 4, nbformat_minor: 2 }))
    expect(old.cells[0]).toMatchObject({ metadata: {}, key: expect.stringMatching(/^[0-9a-f]{8}$/) })
    expect(old.metadata).toEqual({})
  })

  it('writes as Jupyter does; ids only from nbformat 4.5 on', () => {
    expect(serializeNotebook(parseNotebook(text()))).toBe(text())
    const old = parseNotebook(JSON.stringify({ cells: [{ id: 'x', cell_type: 'code', source: 'x', metadata: {} }], metadata: {}, nbformat: 4, nbformat_minor: 4 }))
    expect(JSON.parse(serializeNotebook(old)).cells[0]).toEqual({ cell_type: 'code', source: 'x', metadata: {} })
    const fresh = parseNotebook(JSON.stringify({ cells: [{ cell_type: 'markdown', source: 'x' }], metadata: {}, nbformat: 5, nbformat_minor: 0 }))
    expect(JSON.parse(serializeNotebook(fresh)).cells[0].id).toBe(fresh.cells[0].key)
  })

  it('cells, sources, outputs, language, colours', () => {
    expect(newCell('code', 'a\nb')).toMatchObject({ cell_type: 'code', source: ['a\n', 'b'], outputs: [], execution_count: null, metadata: {} })
    expect(newCell('markdown')).toMatchObject({ cell_type: 'markdown', source: [] })
    expect(newCell('markdown')).not.toHaveProperty('outputs')
    expect([joinSource(['a\n', 'b']), joinSource('c'), joinSource(undefined)]).toEqual(['a\nb', 'c', ''])
    expect([splitSource(''), splitSource('a\n\nb\n')]).toEqual([[], ['a\n', '\n', 'b\n']])
    // Text on the same stream joins; other outputs line up.
    let outs = addOutput([], { output_type: 'stream', name: 'stdout', text: 'a' })
    outs = addOutput(outs, { output_type: 'stream', name: 'stdout', text: ['b\n', 'c'] })
    outs = addOutput(outs, { output_type: 'stream', name: 'stderr', text: 'warn\n' })
    outs = addOutput(outs, { output_type: 'display_data', data: { 'text/plain': 'x' }, metadata: {} })
    expect(outs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['ab\n', 'c'] },
      { output_type: 'stream', name: 'stderr', text: ['warn\n'] },
      { output_type: 'display_data', data: { 'text/plain': 'x' }, metadata: {} }
    ])
    const doc = parseNotebook(text())
    expect(updateCell(doc, 'c2', (c) => ({ ...c, execution_count: 9 })).cells.map((c) => c.execution_count)).toEqual([undefined, 3, 9])
    expect(notebookLanguage(doc)).toBe('python')
    expect(notebookLanguage({ ...doc, metadata: { language_info: { name: 'R' } } })).toBe('r')
    expect(notebookLanguage({ ...doc, metadata: {} })).toBe('python')
    expect(stripAnsi('\u001b[0;31mZeroDivisionError\u001b[0m')).toBe('ZeroDivisionError')
  })
})

describe('a notebook session', () => {
  const KERNELS = { python: 'python3', venv: true, ready: true, specs: [{ name: 'python3', displayName: 'Python 3', language: 'python' }, { name: 'ir', displayName: 'R', language: 'R' }] }
  let b: ReturnType<typeof installBridge>
  let routes: Record<string, (p: never) => unknown>
  beforeEach(() => {
    mon.models.clear()
    routes = {
      'notebook:kernels': () => KERNELS,
      'notebook:start': () => undefined,
      'notebook:execute': () => undefined,
      'notebook:interrupt': () => undefined,
      'notebook:restart': () => undefined,
      'notebook:shutdown': () => undefined,
      'notebook:setup': () => 'ok'
    }
    b = installBridge(new Proxy(routes, {}))
  })
  afterEach(() => vi.useRealTimers())

  const doc = (s: NotebookSession) => s.get().doc!
  const emit = (e: Record<string, unknown>) => b.emit('notebook:event', { projectId: 'p', path: 'a.ipynb', ...e })

  it('reads the buffer (also one made later), writes changes back as small edits, follows changes from elsewhere', async () => {
    const late = new NotebookSession('p', 'late.ipynb', fakeUri('late.ipynb'))
    expect(late.get().doc).toBeUndefined()
    mon.add(uri('other.ipynb'), text())
    mon.add(uri('late.ipynb'), text())
    expect(late.get().doc!.cells).toHaveLength(3)

    const model = mon.add(uri('a.ipynb'), text())
    const s = new NotebookSession('p', 'a.ipynb', fakeUri('a.ipynb'))
    const seen = vi.fn()
    const off = s.subscribe(seen)
    s.commit((d) => updateCell(d, 'c2', (c) => ({ ...c, source: ['2/1'] })))
    expect(JSON.parse(model.value).cells[2].source).toEqual(['2/1'])
    expect(seen).toHaveBeenCalled()
    // What Mindeck wrote isn't read back.
    const before = s.get().doc
    model.change.fire({})
    expect(s.get().doc).toBe(before)
    // Undo or a reload from disk: read again; a broken file says why.
    model.set(text({ ...NB, cells: [] }))
    expect(doc(s).cells).toEqual([])
    model.set('{ broken')
    expect(s.get().invalid).toBeTruthy()
    model.set(text())
    expect(s.get().invalid).toBeUndefined()
    off()

    // Outputs stream in: shown at once, in the buffer a moment later.
    vi.useFakeTimers()
    const edits = model.edits
    s.commit((d) => updateCell(d, 'c1', (c) => ({ ...c, execution_count: 4 })), true)
    s.commit((d) => updateCell(d, 'c1', (c) => ({ ...c, execution_count: 5 })), true)
    expect(doc(s).cells[1].execution_count).toBe(5)
    expect(model.edits).toBe(edits)
    vi.advanceTimersByTime(60)
    expect(model.edits).toBe(edits + 1)
    expect(JSON.parse(model.value).cells[1].execution_count).toBe(5)

    // Nothing to write without a buffer or notebook.
    model.disposed = true
    s.flush()
    new NotebookSession('p', 'none.ipynb', fakeUri('none.ipynb')).commit((d) => d)
  })

  it('adds cells (the new one takes the focus); kernels: once, again on demand; which one runs', async () => {
    mon.add(uri('a.ipynb'), text())
    const s = new NotebookSession('p', 'a.ipynb', fakeUri('a.ipynb'))
    s.insert(1, 'code')
    expect(doc(s).cells.map((c) => c.cell_type)).toEqual(['markdown', 'code', 'code', 'code'])
    expect(s.get().focus).toBe(doc(s).cells[1].key)
    s.focus('c1')
    expect(s.get().focus).toBe('c1')

    expect(s.kernel()).toBeUndefined()
    await s.loadKernels()
    await s.loadKernels()
    expect(b.invoke.mock.calls.filter(([c]) => c === 'notebook:kernels')).toHaveLength(1)
    expect(s.kernel()?.name).toBe('python3')
    // The notebook asks for another kernel; one for its language; any.
    s.commit((d) => ({ ...d, metadata: { kernelspec: { name: 'ir' } } }))
    expect(s.kernel()?.name).toBe('ir')
    s.commit((d) => ({ ...d, metadata: { language_info: { name: 'R' } } }))
    expect(s.kernel()?.name).toBe('ir')
    s.commit((d) => ({ ...d, metadata: { kernelspec: { name: 'julia', language: 'julia' } } }))
    expect(s.kernel()?.name).toBe('python3')
    routes['notebook:kernels'] = () => {
      throw new Error('no python')
    }
    await s.loadKernels(true)
    expect(s.get().error).toBe('no python')
    s.clearError()
    expect(s.get().error).toBeUndefined()
    // No notebook yet: Python.
    const empty = new NotebookSession('p', 'x.ipynb', fakeUri('x.ipynb'))
    expect(empty.kernel()).toBeUndefined()
  })

  it('runs code cells in order with the notebook’s kernel; outputs, counts and clears from the kernel', async () => {
    const model = mon.add(uri('a.ipynb'), text({ ...NB, metadata: {} }))
    const s = new NotebookSession('p', 'a.ipynb', fakeUri('a.ipynb'))
    await s.loadKernels()
    await s.run(['m1', 'c1', 'c2', 'gone'])
    expect(b.invoke).toHaveBeenCalledWith('notebook:start', { projectId: 'p', path: 'a.ipynb', kernel: 'python3' })
    expect(b.invoke.mock.calls.filter(([c]) => c === 'notebook:execute').map(([, p]) => (p as { cell: string }).cell)).toEqual(['c1', 'c2'])
    // The kernel it started with is noted in the notebook; old outputs went.
    expect(doc(s).metadata.kernelspec).toEqual({ name: 'python3', display_name: 'Python 3', language: 'python' })
    expect(doc(s).cells[1]).toMatchObject({ outputs: [], execution_count: null })
    expect(s.get().running).toEqual(['c1', 'c2'])

    emit({ type: 'status', state: 'busy' })
    emit({ type: 'count', cell: 'c1', count: 1 })
    emit({ type: 'output', cell: 'c1', output: { output_type: 'stream', name: 'stdout', text: 'a' } })
    emit({ type: 'output', cell: 'c1', output: { output_type: 'stream', name: 'stdout', text: 'b' } })
    // Clear (now) and clear-on-next-output.
    emit({ type: 'clear', cell: 'c2', wait: false })
    emit({ type: 'clear', cell: 'c1', wait: true })
    expect(doc(s).cells[1].outputs).toHaveLength(1)
    emit({ type: 'output', cell: 'c1', output: { output_type: 'stream', name: 'stdout', text: 'c' } })
    expect(doc(s).cells[1]).toMatchObject({ execution_count: 1, outputs: [{ text: ['c'] }] })
    // A cell that had no outputs field yet (older files).
    s.commit((d) => updateCell(d, 'c2', ({ outputs: _o, ...c }) => c))
    emit({ type: 'output', cell: 'c2', output: { output_type: 'stream', name: 'stdout', text: 'x' } })
    expect(doc(s).cells[2].outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: ['x'] }])
    emit({ type: 'done', cell: 'c1' })
    expect(s.get()).toMatchObject({ state: 'busy', running: ['c2'] })
    // Another notebook's kernel: not ours.
    b.emit('notebook:event', { projectId: 'p', path: 'b.ipynb', type: 'done', cell: 'c2' })
    expect(s.get().running).toEqual(['c2'])
    emit({ type: 'status', state: 'restarting' })
    expect(s.get().running).toEqual([])
    emit({ type: 'status', state: 'idle' })

    // Started already: the next run goes straight on; a cell already waiting isn't queued twice.
    await s.run(['c1'])
    await s.run(['c1'])
    expect(b.invoke.mock.calls.filter(([c]) => c === 'notebook:start')).toHaveLength(1)
    expect(s.get().running).toEqual(['c1'])
    // A kernel that died starts again on the next run.
    emit({ type: 'status', state: 'dead' })
    expect(s.get()).toMatchObject({ state: 'dead', running: [] })
    await s.run(['c1'])
    expect(b.invoke.mock.calls.filter(([c]) => c === 'notebook:start')).toHaveLength(2)

    // a kernel that's gone already: interrupting, restarting and stopping it fail quietly
    for (const ch of ['notebook:interrupt', 'notebook:restart', 'notebook:shutdown']) routes[ch] = () => Promise.reject(new Error('no kernel'))
    s.interrupt()
    s.restart()
    await settle()
    expect(b.invoke).toHaveBeenCalledWith('notebook:interrupt', { projectId: 'p', path: 'a.ipynb' })
    expect(b.invoke).toHaveBeenCalledWith('notebook:restart', { projectId: 'p', path: 'a.ipynb' })

    // Another kernel: the running one stops; the next run starts it.
    s.chooseKernel('ir')
    expect(doc(s).metadata.kernelspec).toEqual({ name: 'ir', display_name: 'R', language: 'R' })
    expect(s.get().state).toBe('off')
    await s.run(['c1'])
    expect(b.invoke).toHaveBeenLastCalledWith('notebook:execute', expect.objectContaining({ cell: 'c1' }))
    expect(b.invoke).toHaveBeenCalledWith('notebook:start', { projectId: 'p', path: 'a.ipynb', kernel: 'ir' })

    // The tab closes: the buffer gets the last outputs, the kernel stops, events reach it no more.
    s.dispose()
    await settle()
    expect(b.invoke).toHaveBeenLastCalledWith('notebook:shutdown', { projectId: 'p', path: 'a.ipynb' })
    emit({ type: 'status', state: 'busy' })
    expect(s.get().state).not.toBe('busy')
    expect(model.value).toContain('"name": "ir"')
  })

  it('a kernel that can’t run says why; setting up the project', async () => {
    mon.add(uri('a.ipynb'), text())
    const s = new NotebookSession('p', 'a.ipynb', fakeUri('a.ipynb'))
    // No kernels known yet: none to start.
    await s.run(['c1'])
    expect(s.get().error).toBe('No Jupyter kernel is installed for this project’s Python.')
    routes['notebook:kernels'] = () => ({ ...KERNELS, ready: false, specs: [] })
    await s.loadKernels()
    await s.run(['c1'])
    expect(s.get().error).toBe('Jupyter isn’t installed for this project’s Python — set it up first.')
    // Only Markdown: nothing to run, nothing asked.
    await s.run(['m1'])

    routes['notebook:setup'] = () => {
      throw new Error('pip failed')
    }
    await s.setup()
    expect(s.get()).toMatchObject({ settingUp: false, error: 'pip failed' })
    routes['notebook:setup'] = () => 'installed'
    routes['notebook:kernels'] = () => KERNELS
    await s.setup()
    expect(s.get()).toMatchObject({ settingUp: false, error: undefined, info: KERNELS })

    routes['notebook:start'] = () => {
      throw Object.assign(new Error('Jupyter is not installed'), { code: 'kernel-missing' })
    }
    await s.run(['c1'])
    expect(s.get().error).toBe('Jupyter is not installed')
    routes['notebook:start'] = () => undefined
    routes['notebook:execute'] = () => {
      throw new Error('not started')
    }
    await s.run(['c1'])
    expect(s.get()).toMatchObject({ error: 'not started', running: [] })
  })

  it('one session per notebook tab; it ends when the tab closes', async () => {
    mon.add(uri('a.ipynb'), text())
    const tab = (path: string) => ({ id: tabKey('p', path), projectId: 'p', path }) as EditorTab
    const s = notebookSession(tab('a.ipynb'), fakeUri('a.ipynb'))
    expect(notebookSession(tab('a.ipynb'), fakeUri('a.ipynb'))).toBe(s)
    useEditor.setState({ tabs: [tab('a.ipynb'), tab('b.ts'), tab('c.ipynb')] })
    useEditor.setState({ tabs: [tab('a.ipynb'), tab('c.ipynb')] })
    useEditor.setState({ activeId: 'x' })
    expect(b.invoke).not.toHaveBeenCalledWith('notebook:shutdown', expect.anything())
    useEditor.setState({ tabs: [] })
    await settle()
    expect(b.invoke).toHaveBeenCalledWith('notebook:shutdown', { projectId: 'p', path: 'a.ipynb' })
    expect(notebookSession(tab('a.ipynb'), fakeUri('a.ipynb'))).not.toBe(s)
  })
})
