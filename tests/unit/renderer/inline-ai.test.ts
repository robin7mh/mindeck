import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import type { AiStatus } from '@shared/types/ai'

// --- A Monaco stand-in: a text model with offsets, an editor with zones, widgets, decorations and edits ---
const mon = vi.hoisted(() => {
  class Position {
    constructor(
      public lineNumber: number,
      public column: number
    ) {}
  }
  class Range {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number
    ) {}
    getStartPosition() {
      return new Position(this.startLineNumber, this.startColumn)
    }
    getEndPosition() {
      return new Position(this.endLineNumber, this.endColumn)
    }
    isEmpty() {
      return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn
    }
  }
  class Model {
    constructor(
      public value: string,
      public uri = { scheme: 'file', path: '/p/src/a.js' }
    ) {}
    getValue() {
      return this.value
    }
    getLanguageId() {
      return 'javascript'
    }
    getOffsetAt(p: Position) {
      return this.value.split('\n').slice(0, p.lineNumber - 1).reduce((n, l) => n + l.length + 1, 0) + p.column - 1
    }
    getPositionAt(offset: number) {
      const before = this.value.slice(0, offset).split('\n')
      return new Position(before.length, before.at(-1)!.length + 1)
    }
    getLineMaxColumn(line: number) {
      return this.value.split('\n')[line - 1].length + 1
    }
    getValueInRange(r: Range) {
      return this.value.slice(this.getOffsetAt(r.getStartPosition()), this.getOffsetAt(r.getEndPosition()))
    }
  }
  const registered: { selector: unknown; provider: unknown }[] = []
  return {
    Range,
    Model,
    registered,
    monaco: {
      Range,
      KeyMod: { CtrlCmd: 2048 },
      KeyCode: { Enter: 3, Escape: 9, KeyK: 41 },
      languages: { registerInlineCompletionsProvider: (selector: unknown, provider: unknown) => registered.push({ selector, provider }) },
      editor: { TrackedRangeStickiness: { AlwaysGrowsWhenTypingAtEdges: 0 } }
    }
  }
})
vi.mock('@/features/editor/monaco/setup', () => ({ monaco: mon.monaco }))

import { useEditor } from '@/features/editor/store'
import { acceptInlineEdit, addInlineEdit, inlineCompletions, rejectInlineEdit, setupInlineAi, startInlineEdit, suggesting } from '@/features/editor/monaco/inlineAi'
import { useAssistant } from '@/features/agents/store'

type Fn = (...a: never[]) => unknown
type Widget = { getDomNode(): HTMLElement; getPosition(): null; getId(): string }

function fakeEditor(model: InstanceType<typeof mon.Model> | null, selection = new mon.Range(1, 1, 1, 1)) {
  const zones: { afterLineNumber: number; heightInPx: number; onDomNodeTop: (top: number) => void }[] = []
  const commands: { keys: number; run: () => void; when: string }[] = []
  const actions: { id: string; keybindings: number[]; run: (ed: unknown) => void }[] = []
  const modelChange: (() => void)[] = []
  const contextKey = { value: false, set: (v: boolean) => (contextKey.value = v) }
  let decoration: { range: InstanceType<typeof mon.Range>; options: Record<string, unknown> } | undefined
  const editor = {
    overlays: [] as Widget[],
    zones,
    commands,
    actions,
    contextKey,
    focused: 0,
    getModel: () => model,
    getSelection: () => selection,
    getLayoutInfo: () => ({ contentLeft: 60, contentWidth: 900 }),
    addOverlayWidget: (w: Widget) => {
      expect([w.getId(), w.getPosition()]).toEqual(['mindeck.inlineEdit', null])
      editor.overlays.push(w)
      document.body.append(w.getDomNode())
    },
    removeOverlayWidget: (w: Widget) => {
      editor.overlays = editor.overlays.filter((x) => x !== w)
      w.getDomNode().remove()
    },
    changeViewZones: (fn: (a: { addZone: (z: (typeof zones)[number]) => string; removeZone: (id: string) => void }) => void) =>
      fn({ addZone: (z) => (zones.push(z), `z${zones.length}`), removeZone: () => zones.pop() }),
    createDecorationsCollection: (list: { range: InstanceType<typeof mon.Range>; options: Record<string, unknown> }[]) => {
      decoration = list[0]
      return {
        getRange: () => decoration?.range ?? null,
        set: (next: typeof list) => (decoration = next[0]),
        clear: () => (decoration = undefined)
      }
    },
    decoration: () => decoration,
    executeEdits: (_source: string, edits: { range: InstanceType<typeof mon.Range>; text: string }[]) => {
      for (const e of edits) {
        const from = model!.getOffsetAt(e.range.getStartPosition())
        const to = model!.getOffsetAt(e.range.getEndPosition())
        model!.value = model!.value.slice(0, from) + e.text + model!.value.slice(to)
      }
    },
    focus: () => (editor.focused += 1),
    createContextKey: () => contextKey,
    addCommand: (keys: number, run: () => void, when: string) => commands.push({ keys, run, when }),
    addAction: (a: (typeof actions)[number]) => (actions.push(a), { dispose: () => {} }),
    onDidChangeModel: (fn: () => void) => (modelChange.push(fn), { dispose: () => {} }),
    changeModel: () => modelChange.forEach((f) => f())
  }
  return editor
}

type FakeEditor = ReturnType<typeof fakeEditor>
const ed = (e: FakeEditor) => e as never
const STATUS = (over: Partial<AiStatus['settings']> = {}, configured = true, source: AiStatus['source'] = configured ? 'stored' : null): AiStatus => ({
  configured,
  source,
  model: 'claude-opus-5-5',
  cloud: null,
  settings: { model: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5', effort: 'high', inline: true, inlineModel: 'claude-opus-5-5', ...over }
})

const input = () => document.querySelector<HTMLInputElement>('input[aria-label="What should the AI change?"]')
const note = () => document.querySelector('[role=status]')!.textContent
const buttons = () => [...document.querySelectorAll('button')].map((b) => b.textContent)
const click = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label)!.click()
const press = (key: string, over: KeyboardEventInit = {}) => input()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...over }))

afterEach(() => document.body.replaceChildren())

describe('suggestions while typing', () => {
  const token = () => {
    const t = { isCancellationRequested: false, fns: [] as (() => void)[], onCancellationRequested: (fn: () => void) => (t.fns.push(fn), { dispose: () => (t.fns = []) }) }
    return t
  }
  const provide = (model: InstanceType<typeof mon.Model>, t = token(), line = 1, col = 7) =>
    (inlineCompletions.provideInlineCompletions as Fn)(model as never, { lineNumber: line, column: col } as never, {} as never, t as never) as Promise<{ items: { insertText: string; range: unknown }[] }>

  it('register once for project files; follow the AI settings (asked for when nobody has yet)', async () => {
    installBridge({ 'ai:status': () => STATUS() })
    useAssistant.setState({ status: undefined })
    setupInlineAi()
    setupInlineAi()
    expect(mon.registered).toEqual([{ selector: { scheme: 'file' }, provider: inlineCompletions }])
    await settle()
    expect(suggesting()).toBe(true)
    useAssistant.setState({ status: STATUS({ inline: false }) })
    expect(suggesting()).toBe(false)
    useAssistant.setState({ status: undefined })
    expect(suggesting()).toBe(false)
    useAssistant.setState({ status: STATUS({}, false) })
    expect(suggesting()).toBe(false)
    // Through Mindeck Cloud: not on the account's credit.
    useAssistant.setState({ status: STATUS({}, true, 'cloud') })
    expect(suggesting()).toBe(false)
    useAssistant.setState({ status: STATUS({}, true, 'env') })
    expect(suggesting()).toBe(true)
    inlineCompletions.disposeInlineCompletions({ items: [] }, 'lostRace' as never)
  })

  it('the file around the cursor goes out; the answer comes back as ghost text at the cursor', async () => {
    const calls: unknown[] = []
    let answer: unknown = 'a, b)'
    // a cancel that fails is no error: the answer is ignored anyway
    const b = installBridge({ 'ai:inlineComplete': (p: unknown) => (calls.push(p), typeof answer === 'function' ? (answer as Fn)() : answer), 'ai:inlineCancel': () => Promise.reject(new Error('gone')) })
    useAssistant.setState({ status: STATUS() })
    const model = new mon.Model('mul(a, \nrest')
    const got = await provide(model)
    expect(calls[0]).toMatchObject({ path: 'src/a.js', language: 'javascript', prefix: 'mul(a,', suffix: ' \nrest' })
    expect((calls[0] as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(got.items).toEqual([{ insertText: 'a, b)', range: new mon.Range(1, 7, 1, 7) }])

    // Nothing to say, an error, or the user typed on: no ghost text.
    answer = ''
    expect((await provide(model)).items).toEqual([])
    answer = () => {
      throw Object.assign(new Error('no key'), { code: 'no-key' })
    }
    expect((await provide(model)).items).toEqual([])
    answer = 'x'
    const t = token()
    const pending = provide(model, t)
    t.isCancellationRequested = true
    t.fns.forEach((f) => f())
    expect((await pending).items).toEqual([])
    await settle()
    expect(b.invoke).toHaveBeenCalledWith('ai:inlineCancel', { requestId: (calls.at(-1) as { requestId: string }).requestId })

    // Suggestions off, or not a project file: nobody is asked.
    calls.length = 0
    useAssistant.setState({ status: STATUS({ inline: false }) })
    expect((await provide(model)).items).toEqual([])
    useAssistant.setState({ status: STATUS() })
    expect((await provide(new mon.Model('x', { scheme: 'inmemory', path: 'x' }))).items).toEqual([])
    expect(calls).toEqual([])
  })

  it('takes the status the assistant already has; a status that can\'t be read is no suggestions', async () => {
    vi.resetModules()
    const loaded = await import('@/features/editor/monaco/inlineAi')
    const bridge = installBridge({ 'ai:status': () => STATUS() })
    ;(await import('@/features/agents/store')).useAssistant.setState({ status: STATUS() })
    loaded.setupInlineAi()
    expect(loaded.suggesting()).toBe(true)
    expect(bridge.invoke).not.toHaveBeenCalledWith('ai:status', undefined)

    vi.resetModules()
    const offline = await import('@/features/editor/monaco/inlineAi')
    ;(await import('@/features/agents/store')).useAssistant.setState({ status: undefined })
    installBridge({ 'ai:status': () => Promise.reject(new Error('offline')) })
    offline.setupInlineAi()
    await settle()
    expect(offline.suggesting()).toBe(false)
  })
})

describe('⌘K: edit with AI', () => {
  let editRoute: (p: { requestId: string; instruction: string; selection: string; before: string; after: string }) => unknown
  let b: ReturnType<typeof installBridge>
  beforeEach(() => {
    editRoute = () => 'const x = 1'
    b = installBridge({ 'ai:inlineEdit': (p: never) => editRoute(p), 'ai:inlineCancel': () => undefined })
  })

  it('⌘K is an editor action; its keys while an edit waits; a model switch or dispose closes the prompt', () => {
    const model = new mon.Model('var x = 1\n')
    const e = fakeEditor(model)
    const disposables = addInlineEdit(ed(e))
    expect(e.actions[0]).toMatchObject({ id: 'mindeck.inlineEdit', keybindings: [2048 | 41] })
    expect(e.commands.map((c) => [c.keys, c.when])).toEqual([
      [2048 | 3, 'mindeckInlineEditPending'],
      [9, 'mindeckInlineEditPending']
    ])
    e.actions[0].run(e)
    expect(input()).not.toBeNull()
    e.changeModel()
    expect(input()).toBeNull()
    e.changeModel()
    startInlineEdit(ed(e))
    disposables.forEach((d) => d.dispose())
    expect(input()).toBeNull()
    disposables.forEach((d) => d.dispose())
  })

  it('a prompt above the selection (whole lines; a selection ending at a line start leaves that line out)', () => {
    const model = new mon.Model('var x = 1\nvar y = 2\nlog(x)\n')
    const e = fakeEditor(model, new mon.Range(1, 3, 3, 1))
    addInlineEdit(ed(e))
    startInlineEdit(ed(e))
    expect(e.zones[0]).toMatchObject({ afterLineNumber: 0, heightInPx: 46 })
    expect(e.decoration()!.range).toEqual(new mon.Range(1, 1, 2, 10))
    expect(e.decoration()!.options).toMatchObject({ className: 'mindeck-ai-target', isWholeLine: true })
    expect(input()!.placeholder).toMatch(/^Edit with AI/)
    expect(document.activeElement).toBe(input())
    const root = input()!.parentElement!
    expect([root.style.left, root.style.width]).toEqual(['60px', '720px'])
    e.zones[0].onDomNodeTop(100)
    expect(root.style.top).toBe('104px')
    // ⌘K again: back to the prompt.
    input()!.blur()
    startInlineEdit(ed(e))
    expect(document.activeElement).toBe(input())
    // Esc closes; nothing changed.
    press('Escape')
    expect(input()).toBeNull()
    expect(model.value).toBe('var x = 1\nvar y = 2\nlog(x)\n')
    expect(e.zones).toEqual([])
    // ⌘K ⌘\ is VS Code's “split down”: as the prompt's first key it closes the prompt and splits.
    const split = vi.spyOn(useEditor.getState(), 'split').mockImplementation(() => {})
    startInlineEdit(ed(e))
    press('\\') // without ⌘: a character
    input()!.value = 'make it \\'
    press('\\', { metaKey: true }) // something typed already: part of the prompt
    expect(split).not.toHaveBeenCalled()
    input()!.value = ''
    press('\\', { ctrlKey: true })
    expect(input()).toBeNull()
    expect(split).toHaveBeenCalledWith('down')
    startInlineEdit(ed(e))
    press('\\', { metaKey: true })
    expect(split).toHaveBeenCalledTimes(2)
  })

  it('writes as asked (progress shows), then accept or reject; the edit is one step', async () => {
    const model = new mon.Model('top\nvar x = 1\nend')
    const e = fakeEditor(model, new mon.Range(2, 1, 2, 4))
    addInlineEdit(ed(e))
    let finish!: (text: string) => void
    editRoute = (p) => {
      b.emit('ai:inlineDelta', { requestId: 'other', text: 'x\ny\nz' })
      b.emit('ai:inlineDelta', { requestId: p.requestId, text: 'const x\n' })
      return new Promise((r) => (finish = r))
    }
    startInlineEdit(ed(e))
    press('Enter')
    expect(b.invoke).not.toHaveBeenCalled() // nothing asked yet
    input()!.value = 'use const'
    press('Enter', { isComposing: true })
    expect(b.invoke).not.toHaveBeenCalled()
    press('Enter')
    await settle()
    expect(b.invoke).toHaveBeenCalledWith('ai:inlineEdit', expect.objectContaining({ path: 'src/a.js', language: 'javascript', before: 'top\n', selection: 'var x = 1', after: '\nend', instruction: 'use const' }))
    expect(input()!.disabled).toBe(true)
    expect(note()).toBe('writing… 2 lines')
    expect(buttons()).toEqual(['Stop'])
    // ⌘K while it writes: nothing new.
    startInlineEdit(ed(e))
    finish('const x = 1\nconst y = 2')
    await settle()
    expect(model.value).toBe('top\nconst x = 1\nconst y = 2\nend')
    expect(e.decoration()).toMatchObject({ range: new mon.Range(2, 1, 3, 12), options: { className: 'mindeck-ai-added', isWholeLine: true } })
    expect(buttons()).toEqual(['Accept ⌘⏎', 'Reject Esc'])
    expect(e.contextKey.value).toBe(true)
    // A button's mouse down keeps the editor's focus.
    const down = new MouseEvent('mousedown', { cancelable: true })
    document.querySelector('button')!.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    acceptInlineEdit(ed(e))
    expect(input()).toBeNull()
    expect(model.value).toBe('top\nconst x = 1\nconst y = 2\nend')
    expect(e.contextKey.value).toBe(false)

    // Again, rejected (Esc in the editor): what was there comes back.
    editRoute = () => 'let x = 1'
    startInlineEdit(ed(e))
    input()!.value = 'let'
    press('Enter')
    await settle()
    expect(model.value).toBe('top\nlet x = 1\nconst y = 2\nend')
    e.commands[1].run()
    expect(model.value).toBe('top\nconst x = 1\nconst y = 2\nend')

    // …and accepted with the button / ⌘⏎.
    startInlineEdit(ed(e))
    input()!.value = 'let'
    press('Enter')
    await settle()
    click('Accept ⌘⏎')
    expect(model.value).toBe('top\nlet x = 1\nconst y = 2\nend')
    startInlineEdit(ed(e))
    input()!.value = 'let'
    press('Enter')
    await settle()
    click('Reject Esc')
    expect(model.value).toBe('top\nlet x = 1\nconst y = 2\nend')
    startInlineEdit(ed(e))
    input()!.value = 'let'
    press('Enter')
    await settle()
    e.commands[0].run()
    expect(input()).toBeNull()
  })

  it('nothing selected: writes at the cursor; Stop cancels and a late answer changes nothing', async () => {
    const model = new mon.Model('a\n\nb')
    const e = fakeEditor(model, new mon.Range(2, 1, 2, 1))
    addInlineEdit(ed(e))
    let finish!: (text: string) => void
    editRoute = () => new Promise((r) => (finish = r))
    startInlineEdit(ed(e))
    expect(input()!.placeholder).toMatch(/^Write with AI/)
    expect(e.decoration()!.options).toMatchObject({ className: undefined, isWholeLine: false })
    input()!.value = 'a function'
    press('Enter')
    await settle()
    const requestId = (b.invoke.mock.calls.find(([c]) => c === 'ai:inlineEdit')![1] as { requestId: string }).requestId
    b.invoke.mockImplementationOnce(() => Promise.reject(new Error('gone'))) // a cancel that fails changes nothing
    click('Stop')
    expect(b.invoke).toHaveBeenCalledWith('ai:inlineCancel', { requestId })
    finish('function f() {}')
    await settle()
    expect(model.value).toBe('a\n\nb')
    expect(input()).toBeNull()
    // Accept / reject with nothing open do nothing.
    acceptInlineEdit(ed(e))
    rejectInlineEdit(ed(e))
  })

  it('a failed edit says why and lets you try again; a failure after closing is dropped', async () => {
    const model = new mon.Model('x')
    const e = fakeEditor(model, new mon.Range(1, 1, 1, 2))
    addInlineEdit(ed(e))
    editRoute = () => {
      throw Object.assign(new Error('No key'), { code: 'no-key' })
    }
    startInlineEdit(ed(e))
    input()!.value = 'go'
    press('Enter')
    await settle()
    expect(note()).toBe('No API key — add one in Settings → AI')
    expect(input()!.disabled).toBe(false)
    editRoute = () => {
      throw Object.assign(new Error('rate limited'), { code: 'rate-limited' })
    }
    press('Enter')
    await settle()
    expect(note()).toBe('Failed: rate limited')
    expect(buttons()).toEqual([])
    // Reject while asking just closes.
    rejectInlineEdit(ed(e))
    expect(input()).toBeNull()
    expect(model.value).toBe('x')

    let fail!: (err: Error) => void
    editRoute = () => new Promise((_, reject) => (fail = reject))
    startInlineEdit(ed(e))
    input()!.value = 'go'
    press('Enter')
    await settle()
    click('Stop')
    fail(new Error('late'))
    await settle()
    expect(input()).toBeNull()
  })

  it('no file, no selection: no prompt; other keys type into the prompt', () => {
    startInlineEdit(ed(fakeEditor(null)))
    const unsaved = fakeEditor(new mon.Model('x', { scheme: 'inmemory', path: 'x' }))
    startInlineEdit(ed(unsaved))
    expect(input()).toBeNull()
    const noSelection = fakeEditor(new mon.Model('x'))
    noSelection.getSelection = () => null as never
    startInlineEdit(ed(noSelection))
    expect(input()).toBeNull()
    const e = fakeEditor(new mon.Model('x'))
    startInlineEdit(ed(e))
    const typed = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    input()!.dispatchEvent(typed)
    expect(typed.defaultPrevented).toBe(false)
    press('Escape')
  })
})
