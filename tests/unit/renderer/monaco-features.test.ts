import { act } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge } from './bridge'

// --- A Monaco stand-in rich enough for providers, markers and decorations ---
const mon = vi.hoisted(() => {
  type Fn = (...a: never[]) => unknown
  class Emitter {
    fns = new Set<Fn>()
    event = (fn: Fn) => {
      this.fns.add(fn)
      return { dispose: () => this.fns.delete(fn) }
    }
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
  class Uri {
    constructor(
      public scheme: string,
      public path: string
    ) {}
    toString() {
      return `${this.scheme}://${this.path}`
    }
    static file(path: string) {
      return new Uri('file', path)
    }
  }
  const language = (path: string) =>
    /\.tsx?$/.test(path) ? 'typescript' : /\.jsx?$/.test(path) ? 'javascript' : /\.py$/.test(path) ? 'python' : /\.go$/.test(path) ? 'go' : 'plaintext'
  class Model {
    change = new Emitter()
    willDispose = new Emitter()
    disposed = false
    constructor(
      public value: string,
      public uri: Uri
    ) {}
    getValue() {
      return this.value
    }
    getLanguageId() {
      return language(this.uri.path)
    }
    onDidChangeContent(fn: Fn) {
      return this.change.event(fn)
    }
    onWillDispose(fn: Fn) {
      return this.willDispose.event(fn)
    }
    getWordUntilPosition(pos: { column: number }) {
      return { startColumn: pos.column - 2, endColumn: pos.column }
    }
    type(text: string) {
      this.value += text
      this.change.fire()
    }
    dispose() {
      this.willDispose.fire()
      this.disposed = true
    }
  }
  class Editor {
    model: Model | null = null
    modelChange = new Emitter()
    content = new Emitter()
    mouse = new Emitter()
    collections: { items: unknown[]; set: (d: unknown[]) => void; clear: () => void }[] = []
    getModel() {
      return this.model
    }
    setModel(m: Model | null) {
      this.model = m
      this.modelChange.fire()
    }
    onDidChangeModel(fn: Fn) {
      return this.modelChange.event(fn)
    }
    onDidChangeModelContent(fn: Fn) {
      return this.content.event(fn)
    }
    onMouseDown(fn: Fn) {
      return this.mouse.event(fn)
    }
    createDecorationsCollection() {
      const c = {
        items: [] as unknown[],
        set: (d: unknown[]) => void (c.items = d),
        clear: () => void (c.items = [])
      }
      this.collections.push(c)
      return c
    }
  }
  const created = new Emitter()
  const state = {
    models: [] as Model[],
    providers: {} as Record<string, Record<string, Record<string, (...a: never[]) => unknown>>>,
    markers: new Map<string, unknown[]>(),
    opener: null as null | { openCodeEditor: (src: unknown, uri: Uri, sel?: unknown) => boolean }
  }
  const register = (kind: string) => (lang: string, provider: Record<string, (...a: never[]) => unknown>) => {
    state.providers[lang] = { ...state.providers[lang], [kind]: provider }
    return { dispose() {} }
  }
  const monaco = {
    Range,
    Uri,
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    MarkerTag: { Unnecessary: 1, Deprecated: 2 },
    editor: {
      getModel: (uri: Uri) => state.models.find((m) => !m.disposed && m.uri.toString() === uri.toString()) ?? null,
      getModels: () => state.models.filter((m) => !m.disposed),
      createModel: (value: string, _lang: unknown, uri: Uri) => {
        const m = new Model(value, uri)
        state.models.push(m)
        created.fire(m)
        return m
      },
      onDidCreateModel: (fn: Fn) => created.event(fn),
      setModelMarkers: (model: Model, owner: string, markers: unknown[]) => state.markers.set(`${owner}:${model.uri.path}`, markers),
      registerEditorOpener: (o: typeof state.opener) => void (state.opener = o),
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2, GUTTER_LINE_DECORATIONS: 4, CONTENT_TEXT: 6 },
      OverviewRulerLane: { Left: 1 },
      MinimapPosition: { Gutter: 2 },
      TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 }
    },
    languages: {
      CompletionItemKind: { Text: 18, Function: 1, Variable: 4, Module: 8, Snippet: 27 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerHoverProvider: register('hover'),
      registerCompletionItemProvider: register('completion'),
      registerDefinitionProvider: register('definition'),
      registerReferenceProvider: register('references'),
      registerRenameProvider: register('rename'),
      registerSignatureHelpProvider: register('signature'),
      registerCodeActionProvider: register('codeActions'),
      registerDocumentSymbolProvider: register('symbols')
    }
  }
  return { state, monaco, Model, Editor, Uri }
})
vi.mock('@/features/editor/monaco/setup', () => ({ monaco: mon.monaco }))

import { diffLines, lineChanges } from '@/features/editor/gutter'
import { attachGutter } from '@/features/editor/monaco/gutter'
import { attachBreakpoints } from '@/features/editor/monaco/breakpoints'
import { applyEdits, fileOf, refreshDiagnostics, setupLsp } from '@/features/editor/monaco/lsp'
import { tabKey, useEditor, type EditorTab } from '@/features/editor/store'
import { useScm } from '@/features/editor/scm'
import { useDebug } from '@/features/editor/debug'
import { useProblems } from '@/features/editor/problems'
import { useLanguages } from '@/features/editor/languages'

type Model = InstanceType<typeof mon.Model>
type Editor = InstanceType<typeof mon.Editor>
type Provider = Record<string, (...a: unknown[]) => Promise<unknown>>
const uri = (projectId: string, path: string) => mon.Uri.file(`/${projectId}/${path}`)
const make = (projectId: string, path: string, text = '') => mon.monaco.editor.createModel(text, undefined, uri(projectId, path)) as unknown as Model
const provider = (kind: string, lang = 'typescript') => mon.state.providers[lang][kind] as unknown as Provider
const tab = (projectId: string, path: string): EditorTab => ({
  id: tabKey(projectId, path),
  projectId,
  path,
  name: path,
  loading: false,
  content: '',
  revision: 1,
  dirty: false,
  saving: false,
  conflict: false,
  deleted: false
})
const flush = () => act(() => vi.advanceTimersByTimeAsync(600))
const range = (l1: number, o1: number, l2: number, o2: number) => ({ start: { line: l1, offset: o1 }, end: { line: l2, offset: o2 } })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('gutter: line changes', () => {
  it('marks added, modified and deleted lines against the staged text', () => {
    expect(lineChanges('a\nb\nc', 'a\nb\nc')).toEqual([])
    expect(lineChanges('a\nc', 'a\nb\nc')).toEqual([{ kind: 'added', start: 2, end: 2 }])
    expect(lineChanges('a\nb\nc', 'a\nB\nc')).toEqual([{ kind: 'modified', start: 2, end: 2 }])
    expect(lineChanges('a\nb\nc', 'a\nc')).toEqual([{ kind: 'deleted', start: 1, end: 1 }])
    expect(lineChanges('a\nb', 'b')).toEqual([{ kind: 'deleted', start: 0, end: 0 }]) // removed at the very top
    expect(lineChanges('', 'x\ny')).toEqual([{ kind: 'added', start: 1, end: 2 }])
    expect(lineChanges('a\r\nb\r\n', 'a\nb\n')).toEqual([]) // line endings don't count
    expect(lineChanges('1\n2\n3\n4\n5', '1\nX\n3\n5\nY')).toEqual([
      { kind: 'modified', start: 2, end: 2 },
      { kind: 'deleted', start: 3, end: 3 },
      { kind: 'added', start: 5, end: 5 }
    ])
  })

  it('gives up on huge differences', () => {
    const a = Array.from({ length: 30 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 30 }, (_, i) => `b${i}`)
    expect(diffLines(a, b, 10)).toBeNull()
    expect(diffLines(['x'], ['x'], 10)).toEqual(['='])
    expect(lineChanges(Array(1200).fill('a').join('\n'), Array(1200).fill('b').join('\n'))).toBeNull()
  })
})

describe('gutter in the editor', () => {
  const setup = (original: () => unknown) => {
    const bridge = installBridge({ 'scm:original': original })
    const editor = new mon.Editor() as unknown as Editor
    let file: { projectId: string; path: string } | undefined
    const detach = attachGutter(editor as never, () => file)
    return { bridge, editor, detach, set: (f?: typeof file) => (file = f), items: () => editor.collections[0].items as { range: { startLineNumber: number; endLineNumber: number }; options: { linesDecorationsClassName: string } }[] }
  }

  it('marks the shown file once git’s text is in, re-marks while typing, follows git and model switches', async () => {
    let staged = 'a\nb\nc'
    const g = setup(() => staged)
    await flush()
    expect(g.items()).toEqual([]) // nothing on screen
    const m = make('g1', 'x.ts', 'a\nB\nc\nd')
    g.set({ projectId: 'g1', path: 'x.ts' })
    act(() => g.editor.setModel(m))
    await flush()
    expect(g.bridge.invoke).toHaveBeenCalledWith('scm:original', { projectId: 'g1', path: 'x.ts' })
    expect(g.items().map((d) => `${d.options.linesDecorationsClassName}@${d.range.startLineNumber}-${d.range.endLineNumber}`)).toEqual(['mindeck-gutter-modified@2-2', 'mindeck-gutter-added@4-4'])

    m.value = 'b\nc'
    act(() => g.editor.content.fire())
    expect(g.items()).toHaveLength(2) // not yet: waits for a pause in typing
    await flush()
    expect(g.items().map((d) => d.options.linesDecorationsClassName)).toEqual(['mindeck-gutter-deleted-top'])

    // A rewrite too big to diff: no markers rather than wrong ones.
    m.value = Array.from({ length: 1200 }, (_, i) => `n${i}`).join('\n')
    staged = Array.from({ length: 1200 }, (_, i) => `o${i}`).join('\n')
    act(() => useScm.setState({ status: { repo: true, ahead: 1, behind: 0, merging: false, files: [] } }))
    await flush()
    expect(g.items()).toEqual([])
    m.value = 'b\nc'
    staged = 'b\nc'
    act(() => useScm.setState({ status: { repo: true, ahead: 0, behind: 0, merging: false, files: [] } }))
    await flush()
    expect(g.items()).toEqual([])
    act(() => useScm.setState({ message: 'unrelated' }))
    await flush()
    expect(g.bridge.invoke.mock.calls.filter(([c]) => c === 'scm:original')).toHaveLength(3)
    g.detach()
    expect(g.items()).toEqual([])
  })

  it('untracked or failing: no markers; a slow answer for a file no longer shown is dropped', async () => {
    let answer: (v: string) => void = () => {}
    const g = setup(() => new Promise((r) => (answer = r)))
    const m = make('g2', 'x.ts', 'new')
    g.set({ projectId: 'g2', path: 'x.ts' })
    act(() => g.editor.setModel(m))
    await act(() => vi.advanceTimersByTimeAsync(0))
    g.set({ projectId: 'g2', path: 'other.ts' })
    answer('old')
    await flush()
    expect(g.items()).toEqual([])
    g.set(undefined)
    act(() => g.editor.setModel(null))
    await flush()
    expect(g.items()).toEqual([])
    g.detach()

    const failing = setup(() => Promise.reject(new Error('no git')))
    failing.set({ projectId: 'g2', path: 'x.ts' })
    act(() => failing.editor.setModel(m))
    await flush()
    expect(failing.items()).toEqual([])
    failing.detach()
  })

  it('a click on a marker opens the file’s diff; other clicks do nothing', async () => {
    const g = setup(() => 'a')
    const openDiff = vi.spyOn(useScm.getState(), 'openDiff').mockResolvedValue()
    const m = make('g3', 'src/x.ts', 'a\nb')
    g.set({ projectId: 'g3', path: 'src/x.ts' })
    act(() => g.editor.setModel(m))
    await flush()
    const click = (type: number, line?: number) => g.editor.mouse.fire({ target: { type, position: line ? { lineNumber: line } : null } })
    click(6, 2) // the text, not the gutter
    click(4) // no line
    click(4, 1) // a line without a change
    expect(openDiff).not.toHaveBeenCalled()
    click(4, 2)
    expect(openDiff).toHaveBeenCalledWith({ path: 'src/x.ts' }, { kind: 'unstaged' }, 'x.ts (Working Tree)')
    g.set(undefined)
    click(4, 2)
    expect(openDiff).toHaveBeenCalledTimes(1)
    g.detach()
  })
})

describe('breakpoints in the editor', () => {
  it('shows the file’s breakpoints and where execution stopped; a glyph click toggles one', async () => {
    useDebug.setState({ breakpoints: { b1: [{ path: 'a.js', line: 2 }, { path: 'other.js', line: 1 }] }, session: null, frame: 0 })
    const editor = new mon.Editor() as unknown as Editor
    let file: { projectId: string; path: string } | undefined
    const detach = attachBreakpoints(editor as never, () => file)
    const items = () => editor.collections[0].items as { range: { startLineNumber: number }; options: { glyphMarginClassName: string } }[]
    expect(items()).toEqual([]) // nothing on screen

    file = { projectId: 'b1', path: 'a.js' }
    act(() => editor.setModel(make('b1', 'a.js', 'x')))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(items().map((d) => `${d.options.glyphMarginClassName}@${d.range.startLineNumber}`)).toEqual(['mindeck-bp@2'])

    const frame = (path: string | undefined, line: number) => ({ id: 'f', name: 'f', path, url: '', line, column: 1, scopes: [] })
    act(() => useDebug.setState({ session: { id: 's', projectId: 'b1', program: 'a.js', status: 'paused', frames: [frame('a.js', 3), frame('a.js', 7)] } }))
    expect(items().map((d) => d.options.glyphMarginClassName)).toEqual(['mindeck-bp', 'mindeck-debug-arrow'])
    act(() => useDebug.setState({ frame: 1 }))
    expect(items()[1].range.startLineNumber).toBe(7)
    act(() => useDebug.setState({ session: { id: 's', projectId: 'b1', program: 'a.js', status: 'paused', frames: [frame('other.js', 1)] }, frame: 0 }))
    expect(items()).toHaveLength(1)
    act(() => useDebug.setState({ session: { id: 's', projectId: 'zz', program: 'a.js', status: 'paused', frames: [frame('a.js', 1)] } }))
    expect(items()).toHaveLength(1)
    act(() => useDebug.setState({ session: { id: 's', projectId: 'b1', program: 'a.js', status: 'running', frames: [] } }))
    act(() => useDebug.setState({ console: [] })) // unrelated: no repaint needed
    expect(items()).toHaveLength(1)

    const click = (type: number, line?: number) => act(() => editor.mouse.fire({ target: { type, position: line ? { lineNumber: line } : null } }))
    click(2, 5)
    expect(useDebug.getState().breakpoints.b1).toContainEqual({ path: 'a.js', line: 5 })
    click(2, 5)
    expect(useDebug.getState().breakpoints.b1).not.toContainEqual({ path: 'a.js', line: 5 })
    click(6, 5) // not the glyph margin
    click(2) // no line
    expect(useDebug.getState().breakpoints.b1).toHaveLength(2)

    file = { projectId: 'none-yet', path: 'a.js' } // a project without breakpoints
    act(() => useDebug.setState({ frame: 0 }))
    act(() => useDebug.setState({ breakpoints: { ...useDebug.getState().breakpoints } }))
    expect(items()).toEqual([])
    file = undefined
    click(2, 5)
    act(() => useDebug.setState({ breakpoints: { b1: [] } }))
    expect(items()).toEqual([])
    file = { projectId: 'b1', path: 'a.js' }
    act(() => editor.setModel(null))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(items()).toEqual([])
    detach()
  })
})

describe('TypeScript through tsserver', () => {
  let bridge: ReturnType<typeof installBridge>
  /** setupLsp subscribes to events once — on the bridge of the first test. */
  let first: ReturnType<typeof installBridge> | undefined
  const routes: Record<string, (p: never) => unknown> = {}
  beforeAll(() => {
    // Models from before the setup are picked up too.
    make('pre', 'early.ts', 'x')
  })
  beforeEach(() => {
    for (const k of Object.keys(routes)) delete routes[k]
    Object.assign(routes, {
      'lsp:open': ({ projectId }: { projectId: string }) => ({ available: !projectId.startsWith('off') }),
      'lsp:change': () => undefined,
      'lsp:close': () => undefined,
      'lsp:diagnostics': () => ({})
    })
    bridge = installBridge(routes)
    first ??= bridge
    setupLsp()
    setupLsp() // once is enough
    useEditor.setState({ tabs: [], projectId: 'p' })
  })
  const calls = (channel: string) => bridge.invoke.mock.calls.filter(([c]) => c === channel).map(([, p]) => p)

  it('finds the project file behind a model', () => {
    expect(fileOf(uri('p', 'src/a.ts') as never)).toEqual({ projectId: 'p', path: 'src/a.ts' })
    expect(fileOf(new mon.Uri('inmemory', '/p/a.ts') as never)).toBeUndefined()
    expect(fileOf(mon.Uri.file('/loose') as never)).toBeUndefined()
  })

  it('mirrors buffers: open, edits (debounced, or at once before a query), close', async () => {
    const m = make('s1', 'a.ts', 'one')
    make('s1', 'notes.md', 'skip')
    mon.monaco.editor.createModel('skip', undefined, new mon.Uri('inmemory', '/s1/b.ts'))
    await flush()
    expect(calls('lsp:open')).toEqual([{ projectId: 's1', path: 'a.ts', text: 'one' }])

    m.type('!')
    expect(calls('lsp:change')).toEqual([])
    await flush()
    expect(calls('lsp:change')).toEqual([{ projectId: 's1', path: 'a.ts', text: 'one!' }])

    // A query sends a pending edit first.
    routes['lsp:hover'] = () => null
    m.type('?')
    await provider('hover').provideHover(m, { lineNumber: 1, column: 1 })
    expect(calls('lsp:change')).toHaveLength(2)
    await provider('hover').provideHover(m, { lineNumber: 1, column: 1 }) // nothing pending
    expect(calls('lsp:change')).toHaveLength(2)

    routes['lsp:change'] = () => Promise.reject(new Error('gone'))
    m.type('x')
    await flush() // a failed sync is not fatal

    m.type('y')
    routes['lsp:close'] = () => Promise.reject(new Error('gone')) // closing a server that went: fine
    m.dispose()
    await flush()
    expect(calls('lsp:close')).toEqual([{ projectId: 's1', path: 'a.ts' }])
    expect(calls('lsp:change')).toHaveLength(3) // the edit before closing never went out
  })

  it('projects without tsserver (or a failed start) get nothing from these providers', async () => {
    const off = make('off1', 'a.ts', 'x')
    routes['lsp:open'] = () => Promise.reject(new Error('down'))
    const failed = make('down1', 'a.ts', 'x')
    await flush()
    off.type('!')
    await flush()
    expect(calls('lsp:change')).toEqual([])
    const pos = { lineNumber: 1, column: 1 }
    for (const m of [off, failed]) {
      expect(await provider('hover').provideHover(m, pos)).toBeNull()
      expect(await provider('completion').provideCompletionItems(m, pos, {})).toEqual({ suggestions: [] })
      expect(await provider('definition').provideDefinition(m, pos)).toBeNull()
      expect(await provider('references').provideReferences(m, pos)).toBeNull()
      expect(await provider('rename').provideRenameEdits(m, pos, 'x')).toBeNull()
      expect(await provider('signature').provideSignatureHelp(m, pos)).toBeNull()
      expect(await provider('codeActions').provideCodeActions(m, null, { markers: [{ source: 'ts', code: '1' }] })).toMatchObject({ actions: [] })
    }
    await refreshDiagnostics('off1') // no server: nothing to ask
    expect(calls('lsp:diagnostics')).toEqual([])
  })

  it('diagnostics of every open file become markers and problems', async () => {
    useEditor.setState({ tabs: [tab('d1', 'a.ts'), tab('d1', 'b.ts'), tab('d1', 'gone.ts'), tab('d1', 'readme.md'), tab('d2', 'x.ts')] })
    routes['lsp:diagnostics'] = () => ({
      'a.ts': [
        { range: range(1, 1, 1, 4), message: 'bad', severity: 'error', code: 2322 },
        { range: range(2, 1, 2, 2), message: 'unused', severity: 'suggestion', unnecessary: true },
        { range: range(3, 1, 3, 2), message: 'old', severity: 'warning', deprecated: true },
        { range: range(4, 1, 4, 2), message: 'fyi', severity: 'info' }
      ],
      'b.ts': [],
      'gone.ts': [{ range: range(1, 1, 1, 2), message: 'x', severity: 'error' }]
    })
    make('d1', 'a.ts', 'a')
    make('d1', 'b.ts', 'b')
    make('d1', 'readme.md', 'r')
    await flush()
    expect(calls('lsp:diagnostics')).toEqual([{ projectId: 'd1', paths: ['a.ts', 'b.ts'] }])
    expect(mon.state.markers.get('lsp:/d1/a.ts')).toEqual([
      { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4, message: 'bad', severity: 8, code: '2322', source: 'ts', tags: [] },
      { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2, message: 'unused', severity: 1, code: undefined, source: 'ts', tags: [1] },
      { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 2, message: 'old', severity: 4, code: undefined, source: 'ts', tags: [2] },
      { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 2, message: 'fyi', severity: 2, code: undefined, source: 'ts', tags: [] }
    ])
    expect(useProblems.getState().byFile['d1:a.ts'].map((p) => p.message)).toEqual(['bad', 'old'])

    routes['lsp:diagnostics'] = () => Promise.reject(new Error('busy'))
    await act(() => refreshDiagnostics('d1'))
    useEditor.setState({ tabs: [] })
    await act(() => refreshDiagnostics('d1')) // no open files
    expect(calls('lsp:diagnostics')).toHaveLength(2)
  })

  it('hover, completions (with auto-import details), signatures', async () => {
    const m = make('h1', 'a.ts', 'abc')
    await flush()
    const pos = { lineNumber: 3, column: 5 }
    routes['lsp:hover'] = () => ({ display: 'const a: 1', documentation: 'Docs', range: range(3, 1, 3, 2) })
    expect(await provider('hover').provideHover(m, pos)).toEqual({
      range: new mon.monaco.Range(3, 1, 3, 2),
      contents: [{ value: '```typescript\nconst a: 1\n```' }, { value: 'Docs' }]
    })
    expect(calls('lsp:hover')).toEqual([{ projectId: 'h1', path: 'a.ts', line: 3, offset: 5 }])
    routes['lsp:hover'] = () => ({ display: 'x', documentation: '', range: range(1, 1, 1, 1) })
    expect(((await provider('hover').provideHover(m, pos)) as { contents: unknown[] }).contents).toHaveLength(1)
    routes['lsp:hover'] = () => Promise.reject(new Error('x'))
    expect(await provider('hover').provideHover(m, pos)).toBeNull()

    routes['lsp:completions'] = () => [
      { name: 'later', kind: 'const', sortText: '16', source: './c', data: { d: 1 } },
      { name: 'fn', kind: 'function', sortText: '11', insertText: 'fn($1)', snippet: true, replacement: range(3, 2, 3, 5) },
      { name: 'odd', kind: 'mystery', sortText: '11' }
    ]
    const list = (await provider('completion').provideCompletionItems(m, pos, { triggerCharacter: '.' })) as { suggestions: Record<string, unknown>[] }
    expect(calls('lsp:completions')).toEqual([{ projectId: 'h1', path: 'a.ts', line: 3, offset: 5, trigger: '.' }])
    expect(list.suggestions).toEqual([
      { label: { label: 'later', description: './c' }, kind: 18, sortText: '16', insertText: 'later', insertTextRules: undefined, range: new mon.monaco.Range(3, 3, 3, 5) },
      { label: 'fn', kind: 1, sortText: '11', insertText: 'fn($1)', insertTextRules: 4, range: new mon.monaco.Range(3, 2, 3, 5) },
      { label: 'odd', kind: 18, sortText: '11', insertText: 'odd', insertTextRules: undefined, range: new mon.monaco.Range(3, 3, 3, 5) }
    ])
    routes['lsp:completionDetails'] = () => ({ detail: 'const later: 1', documentation: 'Later.', edits: [{ range: range(1, 1, 1, 1), newText: "import { later } from './c'\n" }] })
    const resolve = provider('completion').resolveCompletionItem
    expect(await resolve(list.suggestions[0])).toMatchObject({
      detail: 'const later: 1',
      documentation: { value: 'Later.' },
      additionalTextEdits: [{ range: new mon.monaco.Range(1, 1, 1, 1), text: "import { later } from './c'\n" }]
    })
    expect(calls('lsp:completionDetails')[0]).toEqual({ projectId: 'h1', path: 'a.ts', line: 3, offset: 5, name: 'later', source: './c', data: { d: 1 } })
    routes['lsp:completionDetails'] = () => ({ detail: 'fn', documentation: '', edits: [] })
    expect(((await resolve(list.suggestions[1])) as { documentation?: unknown }).documentation).toBeUndefined()
    routes['lsp:completionDetails'] = () => null
    expect(await resolve(list.suggestions[2])).toBe(list.suggestions[2])
    const foreign = { label: 'x' }
    expect(await resolve(foreign)).toBe(foreign)
    routes['lsp:completions'] = () => Promise.reject(new Error('x'))
    expect(await provider('completion').provideCompletionItems(m, pos, {})).toEqual({ suggestions: [] })
    routes['lsp:completionDetails'] = () => Promise.reject(new Error('x'))
    expect(await resolve(list.suggestions[0])).toBe(list.suggestions[0])

    routes['lsp:signature'] = () => ({
      items: [{ label: 'f(a: number)', documentation: 'F.', parameters: [{ label: 'a: number', documentation: '' }, { label: 'b', documentation: 'B' }] }],
      active: 0,
      activeParameter: 1
    })
    const sig = (await provider('signature').provideSignatureHelp(m, pos)) as { value: unknown; dispose: () => void }
    sig.dispose()
    expect(sig.value).toEqual({
      signatures: [{ label: 'f(a: number)', documentation: { value: 'F.' }, parameters: [{ label: 'a: number', documentation: undefined }, { label: 'b', documentation: 'B' }] }],
      activeSignature: 0,
      activeParameter: 1
    })
    routes['lsp:signature'] = () => ({ items: [{ label: 'g()', documentation: '', parameters: [] }], active: 0, activeParameter: 0 })
    expect(((await provider('signature').provideSignatureHelp(m, pos)) as { value: { signatures: { documentation?: unknown }[] } }).value.signatures[0].documentation).toBeUndefined()
    routes['lsp:signature'] = () => Promise.reject(new Error('x'))
    expect(await provider('signature').provideSignatureHelp(m, pos)).toBeNull()
    // JavaScript gets the same providers.
    expect(provider('hover', 'javascript')).toBeDefined()
  })

  it('definitions and references: files not open yet load for the peek view', async () => {
    const m = make('r1', 'a.ts', 'a')
    make('r1', 'open.ts', 'already')
    await flush()
    routes['files:read'] = ({ path }: { path: string }) => (path === 'fail.ts' ? Promise.reject(new Error('x')) : path === 'bin.ts' ? { path, mtimeMs: 1, size: 1 } : { path, mtimeMs: 1, size: 1, content: `<${path}>` })
    routes['lsp:definition'] = () => [
      { path: 'lib.ts', range: range(1, 1, 1, 2) },
      { path: 'lib.ts', range: range(5, 1, 5, 2) },
      { path: 'open.ts', range: range(2, 1, 2, 2) },
      { path: 'fail.ts', range: range(1, 1, 1, 1) },
      { path: 'bin.ts', range: range(1, 1, 1, 1) }
    ]
    const defs = (await provider('definition').provideDefinition(m, { lineNumber: 1, column: 1 })) as { uri: { path: string } }[]
    expect(defs.map((d) => d.uri.path)).toEqual(['/r1/lib.ts', '/r1/lib.ts', '/r1/open.ts', '/r1/fail.ts', '/r1/bin.ts'])
    expect(calls('files:read').map((p) => (p as { path: string }).path)).toEqual(['lib.ts', 'fail.ts', 'bin.ts'])
    expect(mon.monaco.editor.getModel(uri('r1', 'lib.ts'))?.getValue()).toBe('<lib.ts>')
    expect(mon.monaco.editor.getModel(uri('r1', 'bin.ts'))).toBeNull()

    routes['lsp:references'] = () => [{ path: 'lib.ts', range: range(1, 1, 1, 2) }]
    expect(await provider('references').provideReferences(m, { lineNumber: 1, column: 1 })).toHaveLength(1)
    routes['lsp:references'] = () => Promise.reject(new Error('x'))
    expect(await provider('references').provideReferences(m, { lineNumber: 1, column: 1 })).toEqual([])
    routes['lsp:definition'] = () => Promise.reject(new Error('x'))
    expect(await provider('definition').provideDefinition(m, { lineNumber: 1, column: 1 })).toEqual([])
  })

  it('rename: open files get editor edits, the rest is written to disk; refusals explain themselves', async () => {
    const m = make('n1', 'a.ts', 'greet()')
    await flush()
    routes['files:read'] = ({ path }: { path: string }) => (path === 'gone.ts' ? Promise.reject(new Error('x')) : { path, mtimeMs: 4, size: 1, content: 'import { greet } from "./a"\ngreet()\n' })
    routes['files:write'] = () => ({ mtimeMs: 5, size: 1 })
    routes['lsp:rename'] = () => ({
      files: [
        { path: 'a.ts', edits: [{ range: range(1, 1, 1, 6), newText: 'hello' }] },
        { path: 'b.ts', edits: [{ range: range(1, 10, 1, 15), newText: 'hello' }, { range: range(2, 1, 2, 6), newText: 'hello' }] },
        { path: 'gone.ts', edits: [] }
      ]
    })
    const edit = (await provider('rename').provideRenameEdits(m, { lineNumber: 1, column: 2 }, 'hello')) as { edits: { resource: { path: string }; textEdit: { text: string } }[] }
    expect(calls('lsp:rename')).toEqual([{ projectId: 'n1', path: 'a.ts', line: 1, offset: 2, newName: 'hello' }])
    expect(edit.edits.map((e) => `${e.resource.path}:${e.textEdit.text}`)).toEqual(['/n1/a.ts:hello'])
    expect(calls('files:write')).toEqual([{ projectId: 'n1', path: 'b.ts', content: 'import { hello } from "./a"\nhello()\n', expectedMtime: 4 }])

    routes['lsp:rename'] = () => ({ error: 'You cannot rename this element.', files: [] })
    expect(await provider('rename').provideRenameEdits(m, { lineNumber: 1, column: 2 }, 'x')).toEqual({ edits: [], rejectReason: 'You cannot rename this element.' })
    routes['lsp:rename'] = () => Promise.reject(new Error('server stopped'))
    expect(await provider('rename').provideRenameEdits(m, { lineNumber: 1, column: 2 }, 'x')).toEqual({ edits: [], rejectReason: 'server stopped' })
    routes['files:read'] = ({ path }: { path: string }) => ({ path, mtimeMs: 1, size: 1 })
    routes['lsp:rename'] = () => ({ files: [{ path: 'binary.ts', edits: [] }] })
    expect(await provider('rename').provideRenameEdits(m, { lineNumber: 1, column: 2 }, 'x')).toEqual({ edits: [] })
    routes['files:read'] = ({ path }: { path: string }) => ({ path, mtimeMs: 1, size: 1, content: 'x' })
    routes['files:write'] = () => Promise.reject(new Error('conflict'))
    routes['lsp:rename'] = () => ({ files: [{ path: 'c.ts', edits: [] }] })
    expect(await provider('rename').provideRenameEdits(m, { lineNumber: 1, column: 2 }, 'x')).toEqual({ edits: [] })
  })

  it('quick fixes for TypeScript’s errors, each once, the first preferred', async () => {
    const m = make('q1', 'a.ts', 'later')
    await flush()
    const marker = (code: string, line = 1) => ({ source: 'ts', code, startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 6 })
    routes['lsp:codeFixes'] = ({ errorCodes }: { errorCodes: number[] }) =>
      errorCodes[0] === 9 ? Promise.reject(new Error('x')) : [{ title: 'Add import from "./c"', files: [{ path: 'a.ts', edits: [{ range: range(1, 1, 1, 1), newText: 'import' }] }] }]
    // Every marker of a language service (it has a source); TypeScript's by error number, others by range.
    const res = (await provider('codeActions').provideCodeActions(m, null, { markers: [marker('2304'), marker('2304', 2), { source: 'Pyright', code: 'reportX' }, { source: 'ts' }, { code: '5' }, marker('9')] })) as {
      actions: { title: string; kind: string; isPreferred: boolean; edit: { edits: unknown[] } }[]
      dispose: () => void
    }
    res.dispose()
    expect(calls('lsp:codeFixes')).toHaveLength(5)
    expect(calls('lsp:codeFixes')[0]).toEqual({ projectId: 'q1', path: 'a.ts', range: range(1, 1, 1, 6), errorCodes: [2304] })
    expect((calls('lsp:codeFixes')[2] as { errorCodes: number[] }).errorCodes).toEqual([])
    expect(res.actions).toHaveLength(1)
    expect(res.actions[0]).toMatchObject({ title: 'Add import from "./c"', kind: 'quickfix', isPreferred: true })
    expect(res.actions[0].edit.edits).toHaveLength(1)
    const none = (await provider('codeActions').provideCodeActions(m, null, { markers: [] })) as { actions: unknown[]; dispose: () => void }
    none.dispose()
    expect(none.actions).toEqual([])
  })

  it('language servers: markdown hovers, details beside completions, availability per language', async () => {
    routes['lsp:open'] = ({ path }: { path: string }) => (path.endsWith('.py') ? { available: true, language: 'python' } : { available: false, language: 'typescript' })
    const py = make('l1', 'app.py', 'x')
    const ts = make('l1', 'a.ts', 'y')
    await flush()
    expect(useLanguages.getState().files['l1:app.py']).toEqual({ language: 'python', available: true })
    expect(useLanguages.getState().files['l1:a.ts']).toEqual({ language: 'typescript', available: false })
    routes['lsp:hover'] = () => ({ display: '', documentation: '', markdown: '**def** f()' })
    expect(await provider('hover', 'python').provideHover(py, { lineNumber: 1, column: 1 })).toEqual({ range: undefined, contents: [{ value: '**def** f()' }] })
    expect(await provider('hover').provideHover(ts, { lineNumber: 1, column: 1 })).toBeNull() // its server isn't there
    routes['lsp:completions'] = () => [{ name: 'f', kind: 'snippet', sortText: '1', detail: '() -> int' }]
    const list = (await provider('completion', 'python').provideCompletionItems(py, { lineNumber: 1, column: 3 }, {})) as { suggestions: { label: unknown; kind: number }[] }
    expect(list.suggestions[0]).toMatchObject({ label: { label: 'f', description: '() -> int' }, kind: 27 })
    routes['lsp:diagnostics'] = () => ({ 'app.py': [{ range: range(1, 1, 1, 2), message: 'm', severity: 'error', code: 'reportX', source: 'Pyright' }] })
    useEditor.setState({ tabs: [tab('l1', 'app.py')] })
    await act(() => refreshDiagnostics('l1'))
    expect(mon.state.markers.get('lsp:/l1/app.py')).toEqual([expect.objectContaining({ code: 'reportX', source: 'Pyright' })])
    // Symbols (outline, breadcrumbs): LSP's kinds count from 1, Monaco's from 0; TypeScript keeps Monaco's own provider.
    routes['lsp:symbols'] = () => [
      { name: 'C', kind: 5, range: range(1, 1, 3, 1), selection: range(1, 7, 1, 8), children: [{ name: 'm', detail: '()', kind: 6, range: range(2, 1, 2, 9), selection: range(2, 5, 2, 6), children: [] }] }
    ]
    const symbols = (await provider('symbols', 'python').provideDocumentSymbols(py)) as { name: string; detail: string; kind: number; selectionRange: unknown; children: unknown[] }[]
    expect(symbols).toMatchObject([{ name: 'C', detail: '', kind: 4, tags: [], selectionRange: { startLineNumber: 1, startColumn: 7 }, children: [{ name: 'm', detail: '()', kind: 5 }] }])
    expect(calls('lsp:symbols')).toContainEqual({ projectId: 'l1', path: 'app.py' })
    routes['lsp:symbols'] = () => {
      throw new Error('server gone')
    }
    expect(await provider('symbols', 'python').provideDocumentSymbols(py)).toEqual([])
    expect(mon.state.providers.typescript.symbols).toBeUndefined()
    const go = make('l1', 'main.go', 'package main') // its server isn't there
    await flush()
    expect(await provider('symbols', 'go').provideDocumentSymbols(go)).toEqual([])
    py.dispose()
    expect(useLanguages.getState().files['l1:app.py']).toBeUndefined()
  })

  it('a server published diagnostics: the editor asks again; one was installed: open files try again', async () => {
    let available = false
    routes['lsp:open'] = () => ({ available, language: 'go' })
    const g = make('e1', 'main.go', 'package main')
    make('e1', 'ok.go', 'package main')
    const opens = () => calls('lsp:open').filter((p) => (p as { projectId: string }).projectId === 'e1')
    await flush()
    expect(opens()).toHaveLength(2)
    available = true
    act(() => useLanguages.getState().toolsChanged())
    await flush()
    expect(opens()).toHaveLength(4)
    expect(useLanguages.getState().files['e1:main.go']).toEqual({ language: 'go', available: true })
    act(() => useLanguages.getState().toolsChanged()) // all have their server now: nothing to retry
    act(() => useLanguages.setState({ files: { ...useLanguages.getState().files } })) // unrelated change
    await flush()
    expect(opens()).toHaveLength(4)

    useEditor.setState({ tabs: [tab('e1', 'main.go')] })
    act(() => first!.emit('lsp:diagnostics', { projectId: 'e1' }))
    await flush()
    expect(calls('lsp:diagnostics')).toContainEqual({ projectId: 'e1', paths: ['main.go'] })
    g.dispose()
  })

  it('“go to definition” in another file opens it as a tab', () => {
    const openAt = vi.spyOn(useEditor.getState(), 'openAt').mockResolvedValue()
    const opener = mon.state.opener!
    expect(opener.openCodeEditor(null, uri('p', 'lib.ts'), { startLineNumber: 7, startColumn: 1 })).toBe(true)
    expect(openAt).toHaveBeenLastCalledWith('lib.ts', 7)
    opener.openCodeEditor(null, uri('p', 'lib.ts'), { lineNumber: 3, column: 1 })
    expect(openAt).toHaveBeenLastCalledWith('lib.ts', 3)
    opener.openCodeEditor(null, uri('p', 'lib.ts'))
    expect(openAt).toHaveBeenLastCalledWith('lib.ts', 1)
    expect(opener.openCodeEditor(null, uri('other', 'lib.ts'))).toBe(false)
    expect(opener.openCodeEditor(null, new mon.Uri('inmemory', '/x'))).toBe(false)
  })

  it('applies tsserver edits to text (last first; past the end appends)', () => {
    expect(applyEdits('ab\ncd', [{ range: range(1, 1, 1, 2), newText: 'X' }, { range: range(2, 2, 2, 3), newText: 'Y' }])).toBe('Xb\ncY')
    expect(applyEdits('ab', [{ range: range(5, 1, 5, 1), newText: '!' }])).toBe('ab!')
  })
})
