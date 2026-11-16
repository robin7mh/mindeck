import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, settle } from './bridge'

// --- A Monaco stand-in with versions, offsets and edits ---
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
  class Uri {
    constructor(public path: string) {}
    scheme = 'file'
    toString() {
      return `file://${this.path}`
    }
  }
  class Model {
    change = new Emitter()
    gone = new Emitter()
    version = 1
    disposed = false
    edits: unknown[] = []
    constructor(
      public value: string,
      public uri: Uri
    ) {}
    getValue() {
      return this.value
    }
    getVersionId() {
      return this.version
    }
    isDisposed() {
      return this.disposed
    }
    getLanguageId() {
      return /\.py$/.test(this.uri.path) ? 'python' : 'typescript'
    }
    getLineContent(line: number) {
      return this.value.split('\n')[line - 1]
    }
    getPositionAt(offset: number) {
      const before = this.value.slice(0, offset).split('\n')
      return { lineNumber: before.length, column: before.at(-1)!.length + 1 }
    }
    offsetAt(line: number, column: number) {
      return this.value.split('\n').slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1
    }
    pushEditOperations(_s: unknown, ops: { range: Range; text: string }[], cursor?: (inverse: unknown[]) => unknown) {
      for (const { range, text } of ops) {
        this.edits.push({ range, text })
        this.value = this.value.slice(0, this.offsetAt(range.startLineNumber, range.startColumn)) + text + this.value.slice(this.offsetAt(range.endLineNumber, range.endColumn))
      }
      this.version += 1
      this.change.fire()
      return cursor?.([]) ?? null // like Monaco: the cursor afterwards comes from the caller
    }
    type(text: string) {
      this.value += text
      this.version += 1
      this.change.fire()
    }
    onDidChangeContent(fn: Fn) {
      return this.change.event(fn)
    }
    onWillDispose(fn: Fn) {
      return this.gone.event(fn)
    }
    dispose() {
      this.gone.fire()
      this.disposed = true
    }
  }
  const created = new Emitter()
  const state = {
    models: [] as Model[],
    markers: new Map<string, { message: string; source: string; code?: string; startLineNumber: number; startColumn: number }[]>(),
    providers: [] as { lang: string; provider: { provideCodeActions: (...a: unknown[]) => { actions: unknown[]; dispose(): void } } }[],
    commands: new Map<string, () => void>(),
    editors: [] as { hasTextFocus: () => boolean; hasWidgetFocus: () => boolean; getModel: () => Model | null }[]
  }
  const monaco = {
    Range,
    KeyMod: { Shift: 1024, Alt: 512 },
    KeyCode: { KeyF: 36 },
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    editor: {
      getModels: () => state.models.filter((m) => !m.disposed),
      onDidCreateModel: (fn: Fn) => created.event(fn),
      setModelMarkers: (model: Model, owner: string, markers: never[]) => state.markers.set(`${owner}:${model.uri.path}`, markers),
      registerCommand: (id: string, fn: () => void) => state.commands.set(id, fn),
      getEditors: () => state.editors
    },
    languages: { registerCodeActionProvider: (lang: string, provider: never) => state.providers.push({ lang, provider }) }
  }
  const make = (path: string, text: string) => {
    const m = new Model(text, new Uri(path))
    state.models.push(m)
    created.fire(m)
    return m
  }
  return { monaco, state, make, Model }
})
vi.mock('@/features/editor/monaco/setup', () => ({ monaco: mon.monaco }))

import { applyText, fixAll, formatWithPrettier, lintActions, lintModel, restartLint, setupLint } from '@/features/editor/monaco/lint'
import { formatModel, addEditorActions } from '@/features/editor/monaco/extras'
import { useLintStatus } from '@/features/editor/lintStatus'
import { useProblems } from '@/features/editor/problems'
import { useEditorPrefs } from '@/features/editor/prefs'

const diag = (line: number, col: number, message: string, fix?: { start: number; end: number; text: string }, rule: string | null = 'no-var') => ({
  range: { start: { line, offset: col }, end: { line, offset: col + 3 } },
  message,
  severity: 'error' as const,
  code: rule ?? undefined,
  source: 'eslint',
  ...(fix ? { fix } : {})
})
const routes = (over: Record<string, (p: never) => unknown> = {}) =>
  installBridge({
    'lint:file': ({ text }: { text: string }) => ({ available: true, diagnostics: text.startsWith('var') ? [diag(1, 1, 'Unexpected var', { start: 0, end: 3, text: 'let' }), diag(2, 3, 'Nope', undefined, null)] : [] }),
    'lint:fix': ({ text }: { text: string }) => text.replace(/var /g, 'const '),
    'lint:restart': () => undefined,
    'format:document': ({ text, prettier }: { text: string; prettier?: boolean }) => (prettier ? text.toUpperCase() : null),
    ...over
  })

let setUp = false
beforeEach(() => {
  useProblems.setState({ byFile: {} })
  useLintStatus.setState({ errors: {} })
  if (!setUp) {
    setupLint()
    setupLint() // once
    setUp = true
  }
})
afterEach(() => {
  mon.state.models.forEach((m) => !m.disposed && m.dispose())
})

describe('ESLint in the editor', () => {
  it('lints JS / TS files as they open and change: markers and problems of their own', async () => {
    routes()
    const model = mon.make('/p/src/a.ts', 'var a = 1\n  bad\n')
    mon.make('/p/notes.md', 'var x') // not JS / TS: never linted
    await settle()
    expect(mon.state.markers.get('eslint:/p/src/a.ts')).toMatchObject([{ message: 'Unexpected var', source: 'eslint', code: 'no-var', severity: 8 }, { message: 'Nope', code: undefined }])
    expect(mon.state.markers.has('eslint:/p/notes.md')).toBe(false)
    expect(useProblems.getState().byFile['p:src/a.ts'].map((p) => `${p.owner}:${p.message}`)).toEqual(['eslint:Unexpected var', 'eslint:Nope'])
    // Typing lints again after a pause.
    model.value = 'let a = 1\n'
    model.type('')
    await new Promise((r) => setTimeout(r, 450))
    await settle()
    expect(mon.state.markers.get('eslint:/p/src/a.ts')).toEqual([])
    model.dispose()
  })

  it('a stale answer is dropped; a refusing core is asked no more; other failures show in the status bar until a restart', async () => {
    let answer!: (v: unknown) => void
    routes({ 'lint:file': () => new Promise((r) => (answer = r)) })
    const model = mon.make('/p/b.ts', 'var x')
    await settle()
    model.type('!')
    answer({ available: true, diagnostics: [diag(1, 1, 'old')] })
    await settle()
    expect(mon.state.markers.has('eslint:/p/b.ts')).toBe(false)
    model.dispose()

    const broken = routes({ 'lint:file': () => fail("Cannot find package 'eslint-plugin-x'") })
    const m2 = mon.make('/q/c.ts', 'x')
    await settle()
    expect(useLintStatus.getState().errors).toEqual({ q: "Cannot find package 'eslint-plugin-x'" })
    await lintModel(m2 as never)
    expect(broken.invoke.mock.calls.filter((c) => c[0] === 'lint:file')).toHaveLength(2) // asked again
    m2.dispose()

    const refusing = routes({ 'lint:file': () => fail('Remote shells are disabled on this Mindeck core', 'remote-terminal-disabled') })
    const m3 = mon.make('/r/d.ts', 'x')
    await settle()
    await lintModel(m3 as never)
    expect(await fixAll(m3 as never)).toBe(false)
    expect(await formatWithPrettier(m3 as never, { prettier: true })).toBe(false)
    expect(refusing.invoke.mock.calls.filter((c) => c[0] === 'lint:file')).toHaveLength(1)
    expect(useLintStatus.getState().errors.r).toBeUndefined()
    // A restart forgets refusals and errors and lints every open file again.
    const after = routes()
    await useLintStatus.getState().restart()
    expect(after.invoke).toHaveBeenCalledWith('lint:restart', undefined)
    expect(after.invoke).toHaveBeenCalledWith('lint:file', expect.objectContaining({ projectId: 'r', path: 'd.ts' }))
    expect(useLintStatus.getState().errors).toEqual({})
    m3.dispose()
    // A model gone before the answer came: nothing to mark.
    let late!: (v: unknown) => void
    routes({ 'lint:file': () => new Promise((r) => (late = r)) })
    const m4 = mon.make('/p/e.ts', 'x')
    await settle()
    m4.dispose()
    late({ available: true, diagnostics: [diag(1, 1, 'late')] })
    await settle()
    expect(mon.state.markers.has('eslint:/p/e.ts')).toBe(false)
    await restartLint()
  })

  it('quick fixes: the rule’s fix, silencing it for the line, all fixes — only while the text is what ESLint saw', async () => {
    routes()
    const model = mon.make('/p/f.ts', 'var a = 1\n  bad\n')
    await settle()
    expect(mon.state.providers.map((p) => p.lang)).toEqual(['javascript', 'typescript'])
    const markers = mon.state.markers.get('eslint:/p/f.ts')!
    const ask = (ms = markers) => lintActions.provideCodeActions(model as never, {} as never, { markers: ms } as never, {} as never) as { actions: { title: string; kind: string; edit?: { edits: { textEdit: { range: unknown; text: string } }[] }; command?: { id: string } }[]; dispose(): void }
    const res = ask()
    res.dispose()
    expect(res.actions.map((a) => `${a.kind}|${a.title}`)).toEqual([
      'quickfix|Fix: no-var (ESLint)',
      'quickfix|Disable no-var for this line',
      'source.fixAll.eslint|Fix all auto-fixable ESLint problems'
    ])
    expect(res.actions[0].edit!.edits[0].textEdit).toEqual({ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, text: 'let' })
    expect(res.actions[1].edit!.edits[0].textEdit.text).toBe('// eslint-disable-next-line no-var\n')
    const indented = ask([{ ...markers[0], startLineNumber: 2, startColumn: 3, message: 'Nope', code: 'x' } as never])
    expect(indented.actions.map((a) => a.title)).toEqual(['Disable x for this line', 'Fix all auto-fixable ESLint problems'])
    expect(indented.actions[0].edit!.edits[0].textEdit.text).toBe('  // eslint-disable-next-line x\n')
    // Not ESLint's markers, or the text moved on: nothing.
    const none = ask([{ ...markers[0], source: 'ts' } as never])
    none.dispose()
    expect(none.actions).toEqual([])
    model.type(' ')
    expect(ask().actions).toEqual([])
    expect(lintActions.provideCodeActions({ ...model, uri: { toString: () => 'file:///unknown' } } as never, {} as never, { markers } as never, {} as never)).toMatchObject({ actions: [] })
    // "Fix all" runs on the focused editor's file.
    model.value = 'var a = 1\n'
    mon.state.editors.splice(0, mon.state.editors.length, { hasTextFocus: () => false, hasWidgetFocus: () => true, getModel: () => model })
    mon.state.commands.get('mindeck.eslintFixAll')!()
    await settle()
    expect(model.value).toBe('const a = 1\n')
    mon.state.editors.splice(0, 1)
    mon.state.commands.get('mindeck.eslintFixAll')!() // no editor focused
    model.dispose()
  })

  it('fixing all and formatting: one minimal edit; nothing when ESLint / Prettier aren’t responsible or the text moved on', async () => {
    routes()
    const model = mon.make('/p/g.ts', 'var a = 1\nvar b = 2\n')
    await settle()
    expect(await fixAll(model as never)).toBe(true)
    expect(model.value).toBe('const a = 1\nconst b = 2\n')
    expect(model.edits.at(-1)).toMatchObject({ text: 'const a = 1\nconst' })
    expect(await formatWithPrettier(model as never, {})).toBe(false) // the core says: not Prettier's
    expect(await formatWithPrettier(model as never, { prettier: true, prettierOptions: { semi: false } })).toBe(true)
    expect(model.value).toBe('CONST A = 1\nCONST B = 2\n')
    const py = mon.make('/p/x.py', 'x')
    expect(await fixAll(py as never)).toBe(false) // not JS / TS
    expect(await fixAll({ uri: { scheme: 'inmemory', path: '/x' } } as never)).toBe(false)
    expect(await formatWithPrettier({ uri: { scheme: 'inmemory', path: '/x' } } as never, {})).toBe(false)
    let answer!: (v: unknown) => void
    routes({ 'lint:fix': () => new Promise((r) => (answer = r)), 'format:document': () => null })
    const pending = fixAll(model as never)
    await settle()
    model.type('!')
    answer('changed')
    expect(await pending).toBe(false)
    routes({ 'lint:fix': () => fail('boom'), 'format:document': () => fail('prettier crashed') })
    expect(await fixAll(model as never)).toBe(false)
    expect(await formatWithPrettier(model as never, { prettier: true })).toBe(false) // the editor's formatter then
    // ESLint that can't be restarted still lints the open files again
    routes({ 'lint:restart': () => fail('busy') })
    await expect(restartLint()).resolves.toBeUndefined()
    model.dispose()
  })

  it('a fix without a rule name; the status store before the editor loaded', async () => {
    routes({ 'lint:file': () => ({ available: true, diagnostics: [diag(1, 1, 'Anonymous', { start: 0, end: 1, text: 'y' }, null)] }) })
    const model = mon.make('/p/j.ts', 'x')
    await settle()
    const res = lintActions.provideCodeActions(model as never, {} as never, { markers: mon.state.markers.get('eslint:/p/j.ts') } as never, {} as never) as unknown as { actions: { title: string }[] }
    expect(res.actions[0].title).toBe('Fix: eslint (ESLint)')
    model.dispose()
    // nothing ESLint can fix: no "fix all"
    routes({ 'lint:file': () => ({ available: true, diagnostics: [diag(1, 1, 'Nope', undefined, 'no-x')] }) })
    const plain = mon.make('/p/k.ts', 'x')
    await settle()
    const only = lintActions.provideCodeActions(plain as never, {} as never, { markers: mon.state.markers.get('eslint:/p/k.ts') } as never, {} as never) as unknown as { actions: { title: string }[] }
    expect(only.actions.map((a) => a.title)).toEqual(['Disable no-x for this line'])
    plain.dispose()
    vi.resetModules()
    const fresh = await import('@/features/editor/lintStatus')
    await expect(fresh.useLintStatus.getState().restart()).resolves.toBeUndefined()
  })

  it('applies only what changed', () => {
    const model = mon.make('/p/h.txt', 'abc\ndef\n')
    applyText(model as never, 'abc\ndef\n')
    expect(model.edits).toEqual([])
    applyText(model as never, 'abX\ndef\n')
    expect(model.edits).toEqual([{ range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 4 }, text: 'X' }])
    applyText(model as never, 'abX\ndef\nmore\n')
    expect(model.value).toBe('abX\ndef\nmore\n')
    applyText(model as never, '')
    expect(model.value).toBe('')
    model.dispose()
  })
})

describe('format and ESLint actions', () => {
  it('Prettier first, else the editor’s formatter (only for the file on screen); fix all; restart', async () => {
    routes({ 'format:document': ({ text, prettier }: { text: string; prettier?: boolean }) => (prettier ? `P:${text}` : null) })
    const model = mon.make('/p/i.ts', 'var x\n')
    await settle()
    const builtIn = vi.fn(async () => {})
    const editor = { getModel: () => model, getAction: (id: string) => (id === 'editor.action.formatDocument' ? { run: builtIn } : null) }
    await formatModel(model as never, {}, editor as never)
    expect(builtIn).toHaveBeenCalledTimes(1)
    await formatModel(model as never, {}) // not on screen: no built-in formatter to run
    await formatModel(model as never, {}, { ...editor, getAction: () => null } as never)
    expect(builtIn).toHaveBeenCalledTimes(1)
    await formatModel(model as never, { prettier: true }, editor as never)
    expect(model.value).toBe('P:var x\n')
    expect(builtIn).toHaveBeenCalledTimes(1)

    const actions: { id: string; label: string; keybindings?: number[]; run: (ed: unknown) => unknown }[] = []
    addEditorActions({ addAction: (a: (typeof actions)[number]) => (actions.push(a), { dispose() {} }), getModel: () => model } as never)
    expect(actions.map((a) => a.id)).toEqual(['mindeck.formatDocument', 'mindeck.eslint.fixAll', 'mindeck.eslint.restart', 'mindeck.tidyBlankLines'])
    useEditorPrefs.setState({ settings: { prettier: true } })
    model.value = 'x'
    await actions[0].run({ ...editor, getModel: () => model })
    expect(model.value).toBe('P:x')
    await actions[0].run({ getModel: () => null })
    model.value = 'var y\n'
    await actions[1].run({ getModel: () => model })
    expect(model.value).toBe('const y\n')
    await actions[1].run({ getModel: () => null })
    const bridge = routes()
    await actions[2].run({})
    expect(bridge.invoke).toHaveBeenCalledWith('lint:restart', undefined)
    useEditorPrefs.setState({ settings: {} })
    model.dispose()
  })
})
