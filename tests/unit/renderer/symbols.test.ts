import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Monaco's command service (behind ⇧⌘O) and its marker events — stand-ins.
const mon = vi.hoisted(() => {
  type Fn = (...a: never[]) => void
  const markers = new Set<Fn>()
  const state = { result: undefined as unknown, error: null as Error | null, calls: [] as unknown[], pending: null as null | ((v: unknown) => void) }
  return { markers, state }
})
vi.mock('monaco-editor/editor/standalone/browser/standaloneServices.js', () => ({
  StandaloneServices: {
    get: (id: unknown) => {
      if (id !== 'commands') throw new Error('unknown service')
      return {
        executeCommand: (command: string, uri: unknown) => {
          mon.state.calls.push([command, uri])
          if (mon.state.error) return Promise.reject(mon.state.error)
          if (mon.state.pending === null && mon.state.result === 'wait') return new Promise((r) => (mon.state.pending = r))
          return Promise.resolve(mon.state.result)
        }
      }
    }
  }
}))
vi.mock('monaco-editor/platform/commands/common/commands.js', () => ({ ICommandService: 'commands' }))
vi.mock('@/features/editor/monaco/setup', () => ({
  monaco: {
    editor: {
      onDidChangeMarkers: (fn: (uris: { toString(): string }[]) => void) => {
        mon.markers.add(fn as never)
        return { dispose: () => mon.markers.delete(fn as never) }
      }
    }
  }
}))

import { attachSymbols, documentSymbols } from '@/features/editor/monaco/symbols'
import { useOutline } from '@/features/editor/outline'

type Fn = () => void
const range = (a: number, b: number, c: number, d: number) => ({ startLineNumber: a, startColumn: b, endLineNumber: c, endColumn: d })
const raw = (name: string, line: number, children?: unknown[]) => ({ name, detail: '', kind: 11, range: range(line, 1, line + 1, 1), selectionRange: range(line, 10, line, 12), children })

class Model {
  version = 1
  disposed = false
  disposers: Fn[] = []
  constructor(public uri: { scheme: string; path: string; toString(): string }) {}
  getVersionId() {
    return this.version
  }
  isDisposed() {
    return this.disposed
  }
  onWillDispose(fn: Fn) {
    this.disposers.push(fn)
  }
  dispose() {
    this.disposed = true
    this.disposers.forEach((f) => f())
  }
}
const model = (path: string, scheme = 'file') => new Model({ scheme, path, toString: () => `${scheme}://${path}` })

class Editor {
  model: Model | null = null
  modelFns = new Set<Fn>()
  contentFns = new Set<Fn>()
  getModel() {
    return this.model
  }
  onDidChangeModel(fn: Fn) {
    this.modelFns.add(fn)
    return { dispose: () => this.modelFns.delete(fn) }
  }
  onDidChangeModelContent(fn: Fn) {
    this.contentFns.add(fn)
    return { dispose: () => this.contentFns.delete(fn) }
  }
  show(m: Model | null) {
    this.model = m
    this.modelFns.forEach((f) => f())
  }
  type() {
    this.model!.version += 1
    this.contentFns.forEach((f) => f())
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))
const markersChanged = (...uris: Model[]) => mon.markers.forEach((f) => f(uris.map((m) => m.uri) as never))

beforeEach(() => {
  Object.assign(mon.state, { result: undefined, error: null, calls: [], pending: null })
  useOutline.setState({ symbols: {}, cursors: {} })
})
afterEach(() => vi.useRealTimers())

describe('document symbols from Monaco', () => {
  it('every provider’s symbols, in the outline’s shape and order; none on errors', async () => {
    mon.state.result = [raw('b', 5), { ...raw('a', 1, [raw('inner', 2)]), detail: 'class' }]
    const m = model('/p/a.ts')
    const found = await documentSymbols(m as never)
    expect(mon.state.calls).toEqual([['_executeDocumentSymbolProvider', m.uri]])
    expect(found).toEqual([
      {
        name: 'a',
        detail: 'class',
        kind: 11,
        range: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 },
        selection: { startLine: 1, startColumn: 10, endLine: 1, endColumn: 12 },
        children: [expect.objectContaining({ name: 'inner', detail: undefined, children: [] })]
      },
      expect.objectContaining({ name: 'b', children: [] })
    ])
    mon.state.result = undefined
    expect(await documentSymbols(m as never)).toEqual([])
    mon.state.error = new Error('model gone')
    expect(await documentSymbols(m as never)).toEqual([])
  })
})

describe('the outline follows an editor', () => {
  it('reads the shown file’s symbols: at once, after a switch, a while after edits — once per version, editors sharing it', async () => {
    vi.useFakeTimers()
    mon.state.result = [raw('f', 1)]
    const a = model('/p/a.ts')
    const editor = new Editor()
    editor.model = a
    const detach = attachSymbols(editor as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOutline.getState().symbols['p:a.ts']).toEqual([expect.objectContaining({ name: 'f' })])
    // A second editor on the same file and version: no second read.
    const other = new Editor()
    other.model = a
    const detachOther = attachSymbols(other as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(mon.state.calls).toHaveLength(1)

    mon.state.result = [raw('g', 2)]
    editor.type()
    editor.type()
    await vi.advanceTimersByTimeAsync(299)
    expect(mon.state.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mon.state.calls).toHaveLength(2) // once, after the last keystroke
    expect(useOutline.getState().symbols['p:a.ts']).toEqual([expect.objectContaining({ name: 'g' })])

    // Nothing to read: no model, a model that isn't a project file.
    editor.show(null)
    editor.show(model('/x', 'inmemory'))
    await vi.advanceTimersByTimeAsync(0)
    expect(mon.state.calls).toHaveLength(2)

    // The file closes: its symbols go.
    a.dispose()
    expect(useOutline.getState().symbols['p:a.ts']).toBeUndefined()
    detach()
    detachOther()
    expect(mon.markers.size).toBe(0)
  })

  it('no symbols yet (a language server starting): asked again when its diagnostics arrive', async () => {
    vi.useFakeTimers()
    mon.state.result = []
    const py = model('/p/app.py')
    const editor = new Editor()
    editor.model = py
    const detach = attachSymbols(editor as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(useOutline.getState().symbols['p:app.py']).toEqual([])
    markersChanged(model('/p/other.py')) // another file's markers
    await vi.advanceTimersByTimeAsync(300)
    expect(mon.state.calls).toHaveLength(1)
    mon.state.result = [raw('main', 1)]
    markersChanged(py)
    await vi.advanceTimersByTimeAsync(300)
    expect(useOutline.getState().symbols['p:app.py']).toEqual([expect.objectContaining({ name: 'main' })])
    markersChanged(py) // known now: no new read
    await vi.advanceTimersByTimeAsync(300)
    expect(mon.state.calls).toHaveLength(2)
    editor.show(null)
    markersChanged(py) // nothing shown
    editor.show(model('/y', 'inmemory'))
    markersChanged(py)
    await vi.advanceTimersByTimeAsync(300)
    expect(mon.state.calls).toHaveLength(2)
    detach()
  })

  it('an answer that comes after the editor went (or the file closed) is dropped', async () => {
    mon.state.result = 'wait'
    const a = model('/p/late.ts')
    const editor = new Editor()
    editor.model = a
    const detach = attachSymbols(editor as never)
    detach()
    mon.state.pending!([raw('x', 1)])
    await flush()
    expect(useOutline.getState().symbols['p:late.ts']).toBeUndefined()

    Object.assign(mon.state, { result: 'wait', pending: null })
    const b = model('/p/gone.ts')
    editor.model = b
    const again = attachSymbols(editor as never)
    b.disposed = true
    mon.state.pending!([raw('x', 1)])
    await flush()
    expect(useOutline.getState().symbols['p:gone.ts']).toBeUndefined()
    again()
  })
})
