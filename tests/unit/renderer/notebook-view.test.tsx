import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { choose, installBridge, settle } from './bridge'
import type { NotebookDocument } from '@shared/types/notebook'

// --- A Monaco stand-in: the notebook file's model, and one small editor per cell ---
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
    constructor(
      public value: string,
      public uri: { toString(): string },
      public language = ''
    ) {}
    getValue() {
      return this.value
    }
    setValue(v: string) {
      this.value = v
      this.change.fire({})
    }
    isDisposed() {
      return this.disposed
    }
    dispose() {
      this.disposed = true
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
      this.change.fire({})
    }
  }
  interface FakeEditor {
    model: InstanceType<typeof Model>
    options: Record<string, unknown>
    commands: Map<string, () => void>
    focused: number
    disposed: boolean
  }
  const editors: FakeEditor[] = []
  const files = new Map<string, InstanceType<typeof Model>>()
  const created = new Emitter()
  return {
    Model,
    files,
    created,
    editors,
    monaco: {
      Range,
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
      KeyMod: { Shift: 1024, CtrlCmd: 2048, Alt: 512 },
      KeyCode: { Enter: 3, Escape: 9 },
      editor: {
        getModel: (uri: { toString(): string }) => files.get(uri.toString()) ?? null,
        onDidCreateModel: (fn: Fn) => created.event(fn),
        createModel: (value: string, language: string) => new Model(value, { toString: () => 'inmemory://cell' }, language),
        create: (_host: HTMLElement, options: { model: InstanceType<typeof Model> } & Record<string, unknown>) => {
          const e: FakeEditor = { model: options.model, options, commands: new Map(), focused: 0, disposed: false }
          editors.push(e)
          return {
            getModel: () => e.model,
            getContentHeight: () => 44,
            onDidContentSizeChange: () => ({ dispose: () => {} }),
            addCommand: (keys: number, run: () => void, when?: string) => void e.commands.set(`${keys}${when ? `:${when}` : ''}`, run),
            focus: () => (e.focused += 1),
            updateOptions: (o: Record<string, unknown>) => Object.assign(e.options, o),
            dispose: () => (e.disposed = true)
          }
        }
      }
    }
  }
})
vi.mock('@/features/editor/monaco/setup', () => ({ monaco: mon.monaco, THEME: 'mindeck' }))
vi.mock('@/features/editor/components/CodeEditor', () => ({ fileUri: (projectId: string, path: string) => ({ toString: () => `file:///${projectId}/${path}` }) }))

import NotebookView from '@/features/editor/components/NotebookView'
import { tabKey, type EditorTab } from '@/features/editor/store'

const NB: NotebookDocument = {
  cells: [
    { id: 'm1', cell_type: 'markdown', source: ['# Title\n', 'Some **bold**'], metadata: {} },
    {
      id: 'c1',
      cell_type: 'code',
      source: 'print(1)',
      metadata: {},
      execution_count: 1,
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['out\n'] },
        { output_type: 'stream', name: 'stderr', text: '\u001b[31mwarn\u001b[0m\n' },
        { output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['\u001b[31m---\u001b[0m', 'Cell In[1]'] },
        { output_type: 'error', ename: 'KeyboardInterrupt', evalue: '', traceback: [] }
      ]
    },
    {
      id: 'c2',
      cell_type: 'code',
      source: ['show()'],
      metadata: {},
      execution_count: 2,
      outputs: [
        { output_type: 'execute_result', execution_count: 2, data: { 'image/png': 'iVBO\nRw0=', 'text/plain': '<Figure>' }, metadata: {} },
        { output_type: 'display_data', data: { 'image/jpeg': ['/9j/', '4AAQ'] }, metadata: {} },
        { output_type: 'display_data', data: { 'image/svg+xml': '<svg/>' }, metadata: {} },
        { output_type: 'display_data', data: { 'text/html': ['<table><tr><td>1</td></tr></table>'] }, metadata: {} },
        { output_type: 'display_data', data: { 'text/markdown': '**md out**' }, metadata: {} },
        { output_type: 'display_data', data: { 'application/json': { a: 1 } }, metadata: {} },
        { output_type: 'display_data', data: { 'text/plain': ['plain ', 'text'] }, metadata: {} },
        { output_type: 'display_data', data: {}, metadata: {} }
      ]
    },
    { id: 'r1', cell_type: 'raw', source: 'raw text', metadata: {} },
    { id: 'm2', cell_type: 'markdown', source: '', metadata: {} }
  ],
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
  nbformat: 4,
  nbformat_minor: 5
}
const KERNELS = { python: 'python3', venv: true, ready: true, specs: [{ name: 'python3', displayName: 'Python 3', language: 'python' }, { name: 'ir', displayName: 'R', language: 'R' }] }

let n = 0
/** A fresh notebook tab (its own session) with the file's model there. */
function open(nb: object | string = NB) {
  const path = `n${(n += 1)}.ipynb`
  const tab = { id: tabKey('p', path), projectId: 'p', path, name: path } as EditorTab
  const model = new mon.Model(typeof nb === 'string' ? nb : `${JSON.stringify(nb, null, 1)}\n`, { toString: () => `file:///p/${path}` })
  mon.files.set(`file:///p/${path}`, model)
  return { tab, model, file: () => JSON.parse(model.value) as NotebookDocument }
}

let routes: Record<string, (p: never) => unknown>
let b: ReturnType<typeof installBridge>
beforeEach(() => {
  mon.editors.length = 0
  routes = {
    'notebook:kernels': () => KERNELS,
    'notebook:start': () => undefined,
    'notebook:execute': () => undefined,
    'notebook:interrupt': () => undefined,
    'notebook:restart': () => undefined,
    'notebook:shutdown': () => undefined,
    'notebook:setup': () => 'ok'
  }
  b = installBridge(routes)
})

const cell = (i: number) => screen.getAllByRole('region').filter((r) => /^Cell \d+$/.test(r.getAttribute('aria-label')!))[i]
const editorOf = (source: string) => mon.editors.filter((e) => !e.disposed).find((e) => e.model.getValue() === source)!
const emit = (path: string, e: Record<string, unknown>) => act(() => b.emit('notebook:event', { projectId: 'p', path, ...e }))

describe('NotebookView', () => {
  it('shows cells: Markdown rendered, code in editors, outputs in their richest form', async () => {
    const { tab } = open()
    render(<NotebookView tab={tab} readOnly={false} onRaw={vi.fn()} />)
    await act(settle)
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument()
    expect(within(cell(0)).getByText('bold').tagName).toBe('STRONG')
    expect(mon.editors.map((e) => [e.model.getValue(), e.model.language])).toEqual([
      ['print(1)', 'python'],
      ['show()', 'python'],
      ['raw text', 'plaintext'],
      ['', 'markdown'] // an empty Markdown cell starts in its editor
    ])
    expect(within(cell(1)).getByText('[1]')).toBeInTheDocument()
    const outputs = within(cell(1)).getByLabelText('Outputs')
    expect(within(outputs).getByText('out')).toHaveClass('text-text-secondary')
    expect(within(outputs).getByText('warn')).toHaveClass('text-danger/90')
    const [error, interrupt] = within(outputs).getAllByRole('alert')
    expect(error).toHaveTextContent('ZeroDivisionError: division by zero --- Cell In[1]')
    expect(interrupt.textContent).toBe('KeyboardInterrupt: ')
    const rich = within(cell(2)).getByLabelText('Outputs')
    const images = rich.querySelectorAll('img')
    expect([...images].map((i) => i.getAttribute('src'))).toEqual(['data:image/png;base64,iVBORw0=', 'data:image/jpeg;base64,/9j/4AAQ', 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E'])
    const frame = rich.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(frame.getAttribute('srcdoc')).toContain('<table><tbody><tr><td>1</td></tr></tbody></table>')
    fireEvent.load(frame)
    expect(frame.style.height).toBe('4px')
    expect(within(rich).getByText('md out').tagName).toBe('STRONG')
    expect(within(rich).getByText(/"a": 1/)).toBeInTheDocument()
    expect(within(rich).getByText('plain text')).toBeInTheDocument()
    // An empty Markdown cell, done editing: a hint where it is.
    fireEvent.click(within(cell(4)).getByRole('button', { name: 'Show rendered (⇧⏎)' }))
    expect(within(cell(4)).getByText('Empty Markdown cell — double-click to write')).toBeInTheDocument()
  })

  it('a foreign notebook cannot restyle the app or leave it: one sanitizer, links open outside', async () => {
    const open_ = vi.spyOn(window, 'open').mockReturnValue(null)
    const evil = '<style>*{display:none}</style><form action="https://evil.example"><input type="password"></form><img src="https://track.example/p.png">\n\n[web](https://example.com) [rel](index.html?x)'
    const { tab } = open({
      ...NB,
      cells: [
        { id: 'e1', cell_type: 'markdown', source: evil, metadata: {} },
        { id: 'e2', cell_type: 'code', source: 'x', metadata: {}, execution_count: 1, outputs: [
          { output_type: 'display_data', data: { 'text/markdown': evil }, metadata: {} },
          { output_type: 'display_data', data: { 'text/html': '<iframe src="https://evil.example"></iframe><script>parent.mindeck</script><b>ok</b>' }, metadata: {} }
        ] }
      ]
    })
    const { container } = render(<NotebookView tab={tab} readOnly={false} onRaw={vi.fn()} />)
    await act(settle)
    expect(container.querySelector('style, form, input[type=password]')).toBeNull()
    // Pictures never load from where the notebook says (as everywhere else).
    expect(container.querySelector('img[src^="https://"]')).toBeNull()
    const srcdoc = container.querySelector('iframe')!.getAttribute('srcdoc')!
    expect(srcdoc).toContain('<b>ok</b>')
    expect(srcdoc).not.toMatch(/<iframe|<script|evil/)
    // Never `allow-scripts` next to `allow-same-origin`.
    expect(container.querySelector('iframe')!.getAttribute('sandbox')).not.toMatch(/allow-scripts/)
    for (const [i, el] of screen.getAllByText('rel').entries()) {
      expect(fireEvent.click(el)).toBe(false)
      fireEvent.click(screen.getAllByText('web')[i])
    }
    expect(open_.mock.calls).toEqual([
      ['https://example.com', '_blank', 'noopener,noreferrer'],
      ['https://example.com', '_blank', 'noopener,noreferrer']
    ])
  })

  it('edits cells into the file; Markdown switches between rendered and editing', async () => {
    const { tab, model, file } = open()
    const onRaw = vi.fn()
    render(<NotebookView tab={tab} readOnly={false} onRaw={onRaw} />)
    await act(settle)
    act(() => editorOf('print(1)').model.setValue('print(2)\nx'))
    expect(file().cells[1].source).toEqual(['print(2)\n', 'x'])
    // Double-click to edit; ✓, Esc or running it shows it rendered again.
    fireEvent.doubleClick(screen.getByRole('heading', { name: 'Title' }))
    expect(editorOf('# Title\nSome **bold**').model.language).toBe('markdown')
    fireEvent.click(within(cell(0)).getByRole('button', { name: 'Show rendered (⇧⏎)' }))
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument()
    fireEvent.doubleClick(screen.getByRole('heading', { name: 'Title' }))
    act(() => editorOf('# Title\nSome **bold**').commands.get('9:!suggestWidgetVisible')!())
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument()
    fireEvent.doubleClick(screen.getByRole('heading', { name: 'Title' }))
    act(() => editorOf('# Title\nSome **bold**').commands.get('2051')!())
    await act(settle)
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument()
    // Esc in a code cell does nothing special.
    editorOf('print(2)\nx').commands.get('9:!suggestWidgetVisible')!()

    // The file changed elsewhere (undo, disk): the cells follow.
    const next = file()
    next.cells[1].source = ['changed']
    act(() => model.setValue(`${JSON.stringify(next, null, 1)}\n`))
    expect(mon.editors.some((e) => !e.disposed && e.model.getValue() === 'changed')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Show as JSON' }))
    expect(onRaw).toHaveBeenCalled()
  })

  it('runs cells (button, ⌘⏎, ⇧⏎ moves on or adds one, ⌥⏎ adds one); the kernel’s outputs show as they come', async () => {
    const { tab, file } = open()
    render(<NotebookView tab={tab} readOnly={false} onRaw={vi.fn()} />)
    await act(settle)
    fireEvent.click(within(cell(1)).getByRole('button', { name: /^Run cell/ }))
    await act(settle)
    expect(b.invoke).toHaveBeenCalledWith('notebook:start', { projectId: 'p', path: tab.path, kernel: 'python3' })
    expect(b.invoke).toHaveBeenCalledWith('notebook:execute', { projectId: 'p', path: tab.path, cell: 'c1', code: 'print(1)' })
    expect(within(cell(1)).getByText('[*]')).toBeInTheDocument()
    expect(within(cell(1)).queryByLabelText('Outputs')).toBeNull()
    emit(tab.path, { type: 'status', state: 'busy' })
    expect(screen.getByRole('status')).toHaveTextContent('kernel busy')
    expect(screen.getByRole('button', { name: /Interrupt/ })).toBeEnabled()
    emit(tab.path, { type: 'output', cell: 'c1', output: { output_type: 'stream', name: 'stdout', text: 'hello\n' } })
    expect(within(cell(1)).getByText('hello')).toBeInTheDocument()
    emit(tab.path, { type: 'count', cell: 'c1', count: 7 })
    emit(tab.path, { type: 'done', cell: 'c1' })
    emit(tab.path, { type: 'status', state: 'idle' })
    expect(within(cell(1)).getByText('[7]')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('kernel idle')

    // Keys in a cell.
    const editor = editorOf('print(1)')
    act(() => editor.commands.get('2051')!()) // ⌘⏎: run, stay
    act(() => editor.commands.get('1027')!()) // ⇧⏎: run, on to the next
    await act(settle)
    expect(editorOf('show()').focused).toBe(0) // focus comes with the next render of a fresh editor only
    act(() => editorOf('show()').commands.get('515')!()) // ⌥⏎: run, add a cell below
    await act(settle)
    expect(file().cells.map((c) => c.cell_type)).toEqual(['markdown', 'code', 'code', 'code', 'raw', 'markdown'])
    const fresh = mon.editors.filter((e) => !e.disposed && e.model.getValue() === '' && e.model.language === 'python')
    expect(fresh[0].focused).toBe(1)
    // ⇧⏎ in the last cell adds one.
    act(() => editorOf('').commands.get('1027')!())
    await act(settle)
    expect(file().cells).toHaveLength(7)
    // Two queued: one runs, the other waits.
    emit(tab.path, { type: 'status', state: 'busy' })
    fireEvent.click(within(cell(1)).getByRole('button', { name: /^Run cell/ }))
    fireEvent.click(within(cell(2)).getByRole('button', { name: /^Run cell/ }))
    await act(settle)
    expect(within(cell(2)).getByText('[-]')).toBeInTheDocument()
  })

  it('the toolbar: run all, interrupt, restart, clear, add cells, kernels, setting up; errors show and go', async () => {
    const { tab, file } = open()
    render(<NotebookView tab={tab} readOnly={false} onRaw={vi.fn()} />)
    await act(settle)
    const bar = screen.getByRole('toolbar', { name: 'Notebook' })
    expect(within(bar).getByRole('button', { name: /Interrupt/ })).toBeDisabled()
    expect(within(bar).getByRole('button', { name: /Restart/ })).toBeDisabled()
    fireEvent.click(within(bar).getByRole('button', { name: /Run all/ }))
    await act(settle)
    expect(b.invoke.mock.calls.filter(([c]) => c === 'notebook:execute').map(([, p]) => (p as { cell: string }).cell)).toEqual(['c1', 'c2'])
    emit(tab.path, { type: 'status', state: 'busy' })
    fireEvent.click(within(bar).getByRole('button', { name: /Interrupt/ }))
    fireEvent.click(within(bar).getByRole('button', { name: /Restart/ }))
    await act(settle)
    expect(b.invoke).toHaveBeenCalledWith('notebook:interrupt', { projectId: 'p', path: tab.path })
    expect(b.invoke).toHaveBeenCalledWith('notebook:restart', { projectId: 'p', path: tab.path })
    emit(tab.path, { type: 'status', state: 'starting' })
    expect(screen.getByRole('status')).toHaveTextContent('kernel starting…')
    emit(tab.path, { type: 'status', state: 'dead' })
    expect(screen.getByRole('status')).toHaveTextContent('kernel stopped')

    fireEvent.click(within(bar).getByRole('button', { name: /Clear outputs/ }))
    expect(file().cells.filter((c) => c.cell_type === 'code').map((c) => [c.outputs, c.execution_count])).toEqual([
      [[], null],
      [[], null]
    ])
    fireEvent.click(within(bar).getByRole('button', { name: /^Code$/ }))
    fireEvent.click(within(bar).getByRole('button', { name: /^Markdown$/ }))
    const [addCode, addMarkdown] = screen.getAllByRole('button', { name: /^(Code|Markdown)$/ }).slice(2)
    fireEvent.click(addCode)
    fireEvent.click(addMarkdown)
    expect(file().cells.slice(5).map((c) => c.cell_type)).toEqual(['code', 'markdown', 'code', 'markdown'])

    choose('Kernel', 'R')
    await act(settle)
    expect(file().metadata.kernelspec).toEqual({ name: 'ir', display_name: 'R', language: 'R' })
    expect(b.invoke).toHaveBeenCalledWith('notebook:shutdown', { projectId: 'p', path: tab.path })

    routes['notebook:execute'] = () => {
      throw new Error('kernel gone')
    }
    fireEvent.click(within(bar).getByRole('button', { name: /Run all/ }))
    await act(settle)
    expect(screen.getByRole('alert')).toHaveTextContent('kernel gone')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('kernel gone')).toBeNull()
  })

  it('a project without Jupyter offers to set it up', async () => {
    routes['notebook:kernels'] = () => ({ python: 'python3', venv: false, ready: false, specs: [] })
    let finish!: () => void
    routes['notebook:setup'] = () => new Promise<void>((r) => (finish = r))
    const { tab } = open()
    render(<NotebookView tab={tab} readOnly={false} onRaw={vi.fn()} />)
    await act(settle)
    const setup = screen.getByRole('button', { name: /Set up Jupyter/ })
    expect(setup).toHaveAttribute('title', 'Creates .venv in the project and installs ipykernel into it.')
    expect(screen.queryByRole('combobox', { name: 'Kernel' })).toBeNull()
    fireEvent.click(setup)
    await act(settle)
    expect(screen.getByRole('button', { name: /Setting up…/ })).toBeDisabled()
    routes['notebook:kernels'] = () => KERNELS
    await act(async () => {
      finish()
      await settle()
    })
    expect(screen.getByRole('combobox', { name: 'Kernel' })).toBeInTheDocument()
  })

  it('cells move, go and change kind', async () => {
    const { tab, file } = open()
    render(<NotebookView tab={tab} readOnly={false} onRaw={vi.fn()} />)
    await act(settle)
    expect(within(cell(0)).getByRole('button', { name: 'Move up' })).toBeDisabled()
    expect(within(cell(4)).getByRole('button', { name: 'Move down' })).toBeDisabled()
    fireEvent.click(within(cell(0)).getByRole('button', { name: 'Move down' }))
    expect(file().cells.map((c) => c.id)).toEqual(['c1', 'm1', 'c2', 'r1', 'm2'])
    fireEvent.click(within(cell(1)).getByRole('button', { name: 'Move up' }))
    expect(file().cells.map((c) => c.id)).toEqual(['m1', 'c1', 'c2', 'r1', 'm2'])
    fireEvent.click(within(cell(1)).getByRole('button', { name: 'Make it a Markdown cell' }))
    expect(file().cells[1]).not.toHaveProperty('outputs')
    expect(file().cells[1].cell_type).toBe('markdown')
    fireEvent.click(within(cell(0)).getByRole('button', { name: 'Make it a code cell' }))
    expect(file().cells[0]).toMatchObject({ cell_type: 'code', outputs: [], execution_count: null })
    fireEvent.click(within(cell(4)).getByRole('button', { name: 'Delete cell' }))
    expect(file().cells).toHaveLength(4)
  })

  it('read-only: no running, no changes; a broken file offers the JSON; no buffer yet: nothing', async () => {
    const { tab } = open()
    const { rerender } = render(<NotebookView tab={tab} readOnly onRaw={vi.fn()} />)
    await act(settle)
    expect(screen.queryByRole('button', { name: /^Run cell/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete cell' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('read-only here')
    expect(b.invoke).not.toHaveBeenCalledWith('notebook:kernels', expect.anything())
    expect(mon.editors.every((e) => e.options.readOnly === true)).toBe(true)
    fireEvent.doubleClick(screen.getByRole('heading', { name: 'Title' }))
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument()
    rerender(<NotebookView tab={tab} readOnly={false} onRaw={vi.fn()} />)
    expect(mon.editors.every((e) => e.options.readOnly === false)).toBe(true)

    const broken = open('{ nope')
    const onRaw = vi.fn()
    rerender(<NotebookView tab={broken.tab} readOnly={false} onRaw={onRaw} />)
    expect(screen.getByRole('alert')).toHaveTextContent('This file can’t be shown as a notebook')
    fireEvent.click(screen.getByRole('button', { name: /Show as JSON/ }))
    expect(onRaw).toHaveBeenCalled()

    const missing = { id: tabKey('p', 'missing.ipynb'), projectId: 'p', path: 'missing.ipynb', name: 'missing.ipynb' } as EditorTab
    const { container } = render(<NotebookView tab={missing} readOnly={false} onRaw={vi.fn()} />)
    expect(container.textContent).toBe('')
  })
})
