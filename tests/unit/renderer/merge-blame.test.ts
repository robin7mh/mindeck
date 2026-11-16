import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge } from './bridge'
import type { BlameCommit, ScmBlame, ScmStatus } from '@shared/types/scm'
import { UNCOMMITTED } from '@shared/types/scm'

// --- A Monaco stand-in: models that really apply edits, editors with actions, decorations and events ---
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
  class Model {
    stack = 0
    eol = '\n'
    constructor(
      public value: string,
      public uri: { scheme: string; path: string }
    ) {}
    getValue() {
      return this.value
    }
    getLinesContent() {
      return this.value.split('\n')
    }
    getLineCount() {
      return this.getLinesContent().length
    }
    getLineMaxColumn(line: number) {
      return this.getLinesContent()[line - 1].length + 1
    }
    getEOL() {
      return this.eol
    }
    pushStackElement() {
      this.stack += 1
    }
    offset(line: number, col: number) {
      return this.getLinesContent()
        .slice(0, line - 1)
        .reduce((n, l) => n + l.length + 1, col - 1)
    }
    pushEditOperations(_sel: unknown, edits: { range: Range; text: string }[], cursor?: (inverse: unknown[]) => unknown) {
      const spans = edits.map((e) => ({ from: this.offset(e.range.startLineNumber, e.range.startColumn), to: this.offset(e.range.endLineNumber, e.range.endColumn), text: e.text }))
      for (const s of spans.sort((a, b) => b.from - a.from)) this.value = this.value.slice(0, s.from) + s.text + this.value.slice(s.to)
      return cursor?.([]) ?? null // like Monaco: the cursor afterwards comes from the caller
    }
  }
  class Editor {
    model: Model | null = null
    position: { lineNumber: number; column: number } | null = { lineNumber: 1, column: 1 }
    modelChange = new Emitter()
    content = new Emitter()
    cursor = new Emitter()
    mouse = new Emitter()
    actions: { id: string; label: string; run: () => void; disposed: boolean }[] = []
    collections: { items: { range: Range; options: Record<string, unknown> }[]; cleared: number }[] = []
    revealLineInCenter = vi.fn()
    getModel() {
      return this.model
    }
    setModel(m: Model | null) {
      this.model = m
      this.modelChange.fire()
    }
    getPosition() {
      return this.model ? this.position : null
    }
    setPosition(p: { lineNumber: number; column: number }) {
      this.position = p
      this.cursor.fire()
    }
    addAction(a: { id: string; label: string; run: () => void }) {
      const action = { ...a, disposed: false }
      this.actions.push(action)
      return { dispose: () => void (action.disposed = true) }
    }
    run(id: string) {
      this.actions.find((a) => a.id === id)!.run()
    }
    onDidChangeModel(fn: Fn) {
      return this.modelChange.event(fn)
    }
    onDidChangeModelContent(fn: Fn) {
      return this.content.event(fn)
    }
    onDidChangeCursorPosition(fn: Fn) {
      return this.cursor.event(fn)
    }
    onMouseDown(fn: Fn) {
      return this.mouse.event(fn)
    }
    createDecorationsCollection() {
      const c = {
        items: [] as { range: Range; options: Record<string, unknown> }[],
        cleared: 0,
        set: (d: { range: Range; options: Record<string, unknown> }[]) => void (c.items = d),
        clear: () => {
          c.items = []
          c.cleared += 1
        }
      }
      this.collections.push(c)
      return c
    }
  }
  const state = {
    commands: new Map<string, (...a: unknown[]) => unknown>(),
    lenses: [] as { provideCodeLenses: (m: Model) => { lenses: { range: Range; command: { id: string; title: string; arguments: unknown[] } }[]; dispose: () => void } }[]
  }
  const monaco = {
    Range,
    editor: {
      registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => state.commands.set(id, fn),
      OverviewRulerLane: { Full: 7 },
      MouseTargetType: { CONTENT_TEXT: 6, GUTTER_LINE_NUMBERS: 3 },
      InjectedTextCursorStops: { None: 0 }
    },
    languages: {
      registerCodeLensProvider: (_lang: string, p: (typeof state.lenses)[number]) => {
        state.lenses.push(p)
        return { dispose() {} }
      }
    }
  }
  return { monaco, state, Model, Editor }
})
vi.mock('@/features/editor/monaco/setup', () => ({ monaco: mon.monaco }))

import { conflictSides, nearestConflict, parseConflicts, resolveConflict, useConflicts } from '@/features/editor/conflicts'
import { acceptAllConflicts, attachConflicts } from '@/features/editor/monaco/conflicts'
import { BLAME_BLANK, BLAME_WIDTH, blameHover, gutterLabel, inlineLabel, useBlame } from '@/features/editor/blame'
import { attachBlame } from '@/features/editor/monaco/blame'
import { useScm } from '@/features/editor/scm'
import { useEditorPrefs } from '@/features/editor/prefs'

type Model = InstanceType<typeof mon.Model>
type Editor = InstanceType<typeof mon.Editor>
const model = (text: string, path = 'src/a.ts', scheme = 'file') => new mon.Model(text, { scheme, path: `/p/${path}` })
const editorWith = (m: Model | null) => {
  const e = new mon.Editor()
  e.model = m
  return e
}
const asEditor = (e: Editor) => e as never
const file = (path = 'src/a.ts') => ({ id: `p:${path}`, projectId: 'p', path })

const CONFLICT = ['top', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature', 'middle', '<<<<<<< HEAD', 'a', '||||||| base', 'b', '=======', 'c', '>>>>>>> other', 'end'].join('\n')

beforeEach(() => {
  useConflicts.setState({ counts: {} })
  useBlame.setState({ shown: {} })
  useScm.setState({ status: undefined, diff: undefined })
  useEditorPrefs.setState({ settings: {} })
})
afterEach(() => vi.useRealTimers())

describe('conflict blocks', () => {
  it('parses blocks (with a diff3 base), CRLF, labels; skips stray and unfinished markers', () => {
    expect(parseConflicts(CONFLICT.split('\n'))).toEqual([
      { start: 2, separator: 4, end: 6, currentLabel: 'HEAD', incomingLabel: 'feature' },
      { start: 8, base: 10, separator: 12, end: 14, currentLabel: 'HEAD', incomingLabel: 'other' }
    ])
    expect(parseConflicts(['<<<<<<<\r', 'x\r', '=======\r', '>>>>>>>\r'])).toEqual([{ start: 1, separator: 3, end: 4, currentLabel: '', incomingLabel: '' }])
    const stray = ['>>>>>>> lonely', '=======', '<<<<<<<< eight', '<<<<<<< a', '=======', 'x', '======= not a separator', '=======', '|||||||', '>>>>>>> b', '<<<<<<< never closed', '=======']
    expect(parseConflicts(stray)).toEqual([{ start: 4, separator: 5, end: 10, currentLabel: 'a', incomingLabel: 'b' }])
    expect(parseConflicts(['<<<<<<< a', '>>>>>>> b'])).toEqual([]) // no separator yet
  })

  it('sides, resolutions and navigation (wrapping around)', () => {
    const lines = CONFLICT.split('\n')
    const [one, two] = parseConflicts(lines)
    expect(conflictSides(lines, one)).toEqual({ current: ['ours'], incoming: ['theirs'] })
    expect(conflictSides(lines, two)).toEqual({ current: ['a'], base: ['b'], incoming: ['c'] })
    expect(resolveConflict(lines, two, 'current')).toEqual(['a'])
    expect(resolveConflict(lines, two, 'incoming')).toEqual(['c'])
    expect(resolveConflict(lines, two, 'both')).toEqual(['a', 'c'])
    expect(nearestConflict([one, two], 1)).toBe(one)
    expect(nearestConflict([one, two], 3)).toBe(two)
    expect(nearestConflict([one, two], 9)).toBe(one) // wraps
    expect(nearestConflict([one, two], 15, true)).toBe(two)
    expect(nearestConflict([one, two], 9, true)).toBe(one)
    expect(nearestConflict([one, two], 3, true)).toBe(two) // wraps
  })

  it('counts per tab change only when they change', () => {
    useConflicts.getState().setCount('t', 2)
    const before = useConflicts.getState().counts
    useConflicts.getState().setCount('t', 2)
    expect(useConflicts.getState().counts).toBe(before)
    useConflicts.getState().setCount('t', 0)
    expect(useConflicts.getState().counts).toEqual({ t: 0 })
  })
})

describe('the merge conflict editor (Monaco)', () => {
  it('tints blocks, counts them for the tab, and follows edits and model switches', async () => {
    vi.useFakeTimers()
    const m = model(CONFLICT)
    const editor = editorWith(m)
    const detach = attachConflicts(asEditor(editor), () => file())
    const [decorations] = editor.collections
    expect(decorations.items.map((d) => `${d.range.startLineNumber}-${d.range.endLineNumber}:${(d.options.className as string | undefined) ?? 'ruler'}`)).toEqual([
      '2-2:mindeck-conflict-current-marker',
      '3-3:mindeck-conflict-current',
      '4-4:mindeck-conflict-separator',
      '5-5:mindeck-conflict-incoming',
      '6-6:mindeck-conflict-incoming-marker',
      '2-6:ruler',
      '8-8:mindeck-conflict-current-marker',
      '9-9:mindeck-conflict-current',
      '10-11:mindeck-conflict-base',
      '12-12:mindeck-conflict-separator',
      '13-13:mindeck-conflict-incoming',
      '14-14:mindeck-conflict-incoming-marker',
      '8-14:ruler'
    ])
    expect(useConflicts.getState().counts).toEqual({ 'p:src/a.ts': 2 })

    // Empty sides get no tint of their own.
    m.value = ['<<<<<<< a', '=======', '>>>>>>> b'].join('\n')
    editor.content.fire()
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(decorations.items.map((d) => d.options.className ?? 'ruler')).toEqual(['mindeck-conflict-current-marker', 'mindeck-conflict-separator', 'mindeck-conflict-incoming-marker', 'ruler'])
    expect(useConflicts.getState().counts['p:src/a.ts']).toBe(1)

    editor.setModel(null)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(decorations.items).toEqual([])

    detach()
    expect(decorations.cleared).toBe(1)
    expect(editor.actions.every((a) => a.disposed)).toBe(true)
  })

  it('CodeLens actions: accept current / incoming / both, compare — each one undoable edit', () => {
    const m = model(CONFLICT)
    attachConflicts(asEditor(editorWith(m)), () => undefined)
    attachConflicts(asEditor(editorWith(null)), () => undefined) // registered once for the app
    expect(mon.state.lenses).toHaveLength(1)
    const lenses = mon.state.lenses[0].provideCodeLenses(m as never)
    expect(lenses.lenses.map((l) => `${l.range.startLineNumber}:${l.command.title}`)).toEqual([
      '2:Accept Current Change',
      '2:Accept Incoming Change',
      '2:Accept Both Changes',
      '2:Compare Changes',
      '8:Accept Current Change',
      '8:Accept Incoming Change',
      '8:Accept Both Changes',
      '8:Compare Changes'
    ])
    lenses.dispose()
    const run = (i: number) => {
      const { id, arguments: args } = lenses.lenses[i].command
      mon.state.commands.get(id)!(null, ...args)
    }

    run(3) // compare the first block
    expect(useScm.getState().diff).toEqual({ path: 'src/a.ts', original: 'ours', modified: 'theirs', title: 'a.ts: HEAD ↔ feature' })
    run(5) // the second block: take the incoming side
    expect(m.value).toBe(['top', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature', 'middle', 'c', 'end'].join('\n'))
    expect(m.stack).toBe(2)
    run(6) // that block is gone: nothing happens
    run(7)
    expect(m.stack).toBe(2)
    run(2) // both sides of the first
    expect(m.value).toBe(['top', 'ours', 'theirs', 'middle', 'c', 'end'].join('\n'))

    // Unnamed sides compare as "Current" / "Incoming"; a model that isn't a project file can't.
    const bare = model(['<<<<<<<', 'x', '=======', 'y', '>>>>>>>'].join('\n'))
    mon.state.commands.get('mindeck.conflict.compare')!(null, bare, 1)
    expect(useScm.getState().diff?.title).toBe('a.ts: Current ↔ Incoming')
    useScm.setState({ diff: undefined })
    mon.state.commands.get('mindeck.conflict.compare')!(null, model(CONFLICT, 'x.ts', 'inmemory'), 2)
    expect(useScm.getState().diff).toBeUndefined()
  })

  it('an empty side removes the whole block — wherever it sits in the file', () => {
    const accept = (text: string, start: number) => {
      const m = model(text)
      mon.state.commands.get('mindeck.conflict.accept')!(null, m, start, 'current')
      return m.value
    }
    const block = ['<<<<<<< a', '=======', 'theirs', '>>>>>>> b']
    expect(accept(['x', ...block, 'y'].join('\n'), 2)).toBe('x\ny') // middle
    expect(accept(['x', ...block].join('\n'), 2)).toBe('x') // at the end
    expect(accept(block.join('\n'), 1)).toBe('') // the whole file
  })

  it('editor actions: next / previous conflict, accept all — and nothing to do without conflicts', () => {
    const m = model(CONFLICT)
    const editor = editorWith(m)
    attachConflicts(asEditor(editor), () => file())
    editor.run('mindeck.conflict.next')
    expect(editor.position).toEqual({ lineNumber: 2, column: 1 })
    expect(editor.revealLineInCenter).toHaveBeenLastCalledWith(2)
    editor.run('mindeck.conflict.next')
    expect(editor.position!.lineNumber).toBe(8)
    editor.run('mindeck.conflict.previous')
    expect(editor.position!.lineNumber).toBe(2)
    editor.run('mindeck.conflict.previous') // wraps around to the last one
    expect(editor.position!.lineNumber).toBe(8)
    editor.position = { lineNumber: 15, column: 1 }
    editor.run('mindeck.conflict.previous')
    expect(editor.position.lineNumber).toBe(8)

    editor.run('mindeck.conflict.acceptAllBoth')
    expect(m.value).toBe(['top', 'ours', 'theirs', 'middle', 'a', 'c', 'end'].join('\n'))
    m.value = CONFLICT
    editor.run('mindeck.conflict.acceptAllCurrent')
    expect(m.value).toBe(['top', 'ours', 'middle', 'a', 'end'].join('\n'))
    m.value = CONFLICT
    editor.run('mindeck.conflict.acceptAllIncoming')
    expect(m.value).toBe(['top', 'theirs', 'middle', 'c', 'end'].join('\n'))
    const stack = m.stack
    acceptAllConflicts(m as never, 'current') // nothing left: no edit
    expect(m.stack).toBe(stack)

    editor.position = { lineNumber: 3, column: 1 }
    editor.run('mindeck.conflict.next') // no conflicts: stays
    expect(editor.position.lineNumber).toBe(3)
    editor.model = null
    editor.run('mindeck.conflict.next')
    editor.run('mindeck.conflict.acceptAllCurrent')
  })
})

const commit = (hash: string, over: Partial<BlameCommit> = {}): BlameCommit => ({ hash, author: 'Ada Lovelace', email: 'ada@x', date: Date.UTC(2026, 0, 2, 12), summary: `summary ${hash.slice(0, 2)}`, ...over })
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('blame labels', () => {
  it('inline, column, hover', () => {
    const now = Date.UTC(2026, 0, 2, 14)
    expect(inlineLabel(undefined)).toBe('')
    expect(inlineLabel(commit(UNCOMMITTED))).toBe('You • Not committed yet')
    expect(inlineLabel(commit(A), now)).toMatch(/^Ada Lovelace, .+ • summary aa$/)
    expect(gutterLabel(undefined)).toBe(BLAME_BLANK)
    expect(BLAME_BLANK).toHaveLength(BLAME_WIDTH)
    expect(gutterLabel(commit(UNCOMMITTED))).toBe(`Not committed yet${' '.repeat(BLAME_WIDTH - 17)}`)
    expect(gutterLabel(commit(A))).toBe(`aaaaaaa Ada Lovelace   2026-01-02${' '.repeat(BLAME_WIDTH - 33)}`)
    expect(gutterLabel(commit(A, { author: 'Someone With A Long Name' }))).toContain('Someone With …')
    expect(gutterLabel(commit(A, { hash: A, author: 'A'.repeat(BLAME_WIDTH) })).length).toBe(BLAME_WIDTH)
    expect(blameHover(commit(UNCOMMITTED))).toBe('You • Not committed yet')
    expect(blameHover(commit(A))).toMatch(/^\*\*summary aa\*\*\n\nAda Lovelace <ada@x> · .+\n\n`aaaaaaaaaa`$/)
    useBlame.getState().toggle('t')
    expect(useBlame.getState().shown).toEqual({ t: true })
    useBlame.getState().toggle('t')
    expect(useBlame.getState().shown).toEqual({})
  })
})

describe('blame in the editor (Monaco)', () => {
  const repo = (over: Partial<ScmStatus> = {}): ScmStatus => ({ repo: true, head: 'h1', ahead: 0, behind: 0, merging: false, files: [], ...over })
  const blameOf = (lines: string[]): ScmBlame => ({ commits: { [A]: commit(A), [B]: commit(B), [UNCOMMITTED]: commit(UNCOMMITTED) }, lines })
  const flush = () => act(() => vi.advanceTimersByTimeAsync(0))

  function setup(text = 'one\ntwo\nthree\nfour', lines = [A, A, B, UNCOMMITTED]) {
    vi.useFakeTimers()
    const calls: { path: string; text?: string }[] = []
    let answer: ScmBlame | Error = blameOf(lines)
    installBridge({
      'scm:blame': (req: { path: string; text?: string }) => {
        calls.push(req)
        if (answer instanceof Error) throw answer
        return answer
      }
    })
    useScm.setState({ status: repo() })
    const m = model(text)
    const editor = editorWith(m)
    let shown: ReturnType<typeof file> | undefined = file()
    const detach = attachBlame(asEditor(editor), () => shown)
    const [inline, column] = editor.collections
    return {
      m,
      editor,
      inline,
      column,
      calls,
      detach,
      answer: (a: ScmBlame | Error) => void (answer = a),
      show: (f: typeof shown) => void (shown = f)
    }
  }

  it('inline: who changed the cursor’s line, after it; follows the cursor; off in the settings', async () => {
    const { editor, inline, calls, detach } = setup()
    await flush()
    expect(calls).toEqual([{ projectId: 'p', path: 'src/a.ts', text: 'one\ntwo\nthree\nfour' }])
    expect(inline.items).toHaveLength(1)
    expect(inline.items[0].range).toMatchObject({ startLineNumber: 1, startColumn: 4 })
    expect((inline.items[0].options.after as { content: string }).content).toMatch(/^ {3}Ada Lovelace, .+ • summary aa$/)
    editor.setPosition({ lineNumber: 4, column: 1 })
    expect((inline.items[0].options.after as { content: string }).content).toBe('   You • Not committed yet')
    editor.setPosition({ lineNumber: 9, column: 1 }) // past the blame: nothing
    expect(inline.items).toEqual([])

    act(() => useEditorPrefs.setState({ settings: { inlineBlame: false } }))
    await flush()
    expect(inline.items).toEqual([])
    expect(calls).toHaveLength(1) // nothing wants blame now
    act(() => useEditorPrefs.setState({ settings: { inlineBlame: false, fontSize: 14 } })) // another setting: no reload
    await flush()
    expect(calls).toHaveLength(1)
    detach()
  })

  it('the blame column: a label per hunk, blanks below, a hover; a click on it shows the commit', async () => {
    const { editor, column, detach, calls } = setup('one\ntwo\nthree\nfour\nfive')
    act(() => useEditorPrefs.setState({ settings: { inlineBlame: false } }))
    await flush()
    expect(column.items).toEqual([])
    act(() => useBlame.getState().toggle('p:src/a.ts'))
    await flush()
    const before = column.items.map((d) => d.options.before as { content: string; inlineClassName: string })
    expect(before.map((b) => b.inlineClassName)).toEqual(['mindeck-blame-line', 'mindeck-blame-line', 'mindeck-blame-hunk', 'mindeck-blame-hunk', 'mindeck-blame-hunk'])
    expect(before[0].content).toBe(gutterLabel(commit(A)))
    expect(before[1].content).toBe(BLAME_BLANK)
    expect(before[3].content).toBe(gutterLabel(commit(UNCOMMITTED)))
    expect(before[4].content).toBe(BLAME_BLANK) // a line blame doesn't know (yet)
    // the store changing without the toggles: nothing reloads
    const loads = calls.length
    act(() => useBlame.setState({}))
    await flush()
    expect(calls).toHaveLength(loads)
    expect(column.items.map((d) => !!d.options.hoverMessage)).toEqual([true, false, true, true, false])

    const scm = useScm.getState()
    const select = vi.spyOn(scm, 'select').mockResolvedValue()
    const setPane = vi.spyOn(scm, 'setPane').mockImplementation(() => {})
    const closeDiff = vi.spyOn(scm, 'closeDiff')
    const click = (line: number | undefined, injected: boolean, type = 6) =>
      editor.mouse.fire({ target: { type, position: line ? { lineNumber: line, column: 1 } : null, detail: injected ? { injectedText: {} } : undefined } })
    click(3, true)
    expect(select).toHaveBeenCalledWith(B)
    expect(setPane).toHaveBeenCalledWith('graph')
    expect(closeDiff).toHaveBeenCalled()
    click(4, true) // not committed: no commit to show
    click(1, false) // the code itself
    click(1, true, 3) // the line numbers
    click(undefined, true)
    click(9, true) // past the blame
    expect(select).toHaveBeenCalledTimes(1)

    act(() => useBlame.getState().toggle('p:src/a.ts'))
    await flush()
    expect(column.items).toEqual([])
    detach()
  })

  it('reloads on edits (debounced), on a new HEAD, on another file; ignores stale answers and failures', async () => {
    const { m, editor, inline, calls, answer, show, detach } = setup()
    await flush()
    expect(calls).toHaveLength(1)

    m.value = 'one!\ntwo\nthree\nfour'
    editor.content.fire()
    editor.content.fire()
    await act(() => vi.advanceTimersByTimeAsync(900))
    expect(calls).toHaveLength(2)
    expect(calls[1].text).toBe('one!\ntwo\nthree\nfour')

    act(() => useScm.setState({ status: repo() })) // same HEAD: nothing to do
    await flush()
    expect(calls).toHaveLength(2)
    act(() => useScm.setState({ status: repo({ head: 'h2' }) })) // a commit
    await flush()
    expect(calls).toHaveLength(3)

    answer(new Error('no such path'))
    editor.setModel(model('x', 'new.ts'))
    expect(inline.items).toEqual([]) // forgotten at once
    show(file('new.ts'))
    await flush()
    expect(calls.at(-1)?.path).toBe('new.ts')
    expect(inline.items).toEqual([]) // untracked: no blame

    // Two loads in flight: only the newer answer counts.
    answer(blameOf([A]))
    act(() => useScm.setState({ status: repo({ head: 'h3' }) }))
    answer(blameOf([B]))
    act(() => useScm.setState({ status: repo({ head: 'h4' }) }))
    await flush()
    expect((inline.items[0].options.after as { content: string }).content).toContain('summary bb')

    // Not a repository, no file, no model: no blame.
    act(() => useScm.setState({ status: repo({ repo: false }) }))
    await flush()
    expect(inline.items).toEqual([])
    const n = calls.length
    show(undefined)
    act(() => useScm.setState({ status: repo({ head: 'h5' }) }))
    await flush()
    show(file())
    editor.model = null
    act(() => useScm.setState({ status: repo({ head: 'h6' }) }))
    await flush()
    expect(calls).toHaveLength(n)
    detach()
    expect(vi.getTimerCount()).toBe(0)
  })
})
