import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import { randomId } from '@/lib/id'
import { useGitHub } from '@/features/editor/github'
import { useMongo } from '@/features/editor/mongo'
import { useScm } from '@/features/editor/scm'
import { useEditor } from '@/features/editor/store'
import { useMemory } from '@/features/memory/store'
import { useTerminals } from '@/features/terminal/store'

/** A promise to settle by hand — answers arriving in any order. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The project the editor switches to has no repository (its refresh stays quiet). */
const NO_REPO = () => ({ repo: false, files: [] })

const initialScm = useScm.getState()
const initialEditor = useEditor.getState()
const initialGitHub = useGitHub.getState()
const initialMongo = useMongo.getState()
const initialMemory = useMemory.getState()
const initialTerminals = useTerminals.getState()

beforeEach(() => {
  useScm.setState(initialScm, true)
  useEditor.setState(initialEditor, true)
  useGitHub.setState(initialGitHub, true)
  useMongo.setState(initialMongo, true)
  useMemory.setState(initialMemory, true)
  useTerminals.setState(initialTerminals, true)
})

describe('randomId', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('works without crypto.randomUUID (plain-http web UI is not a secure context)', () => {
    vi.stubGlobal('crypto', { getRandomValues: (b: Uint8Array) => b.fill(0xab) })
    expect(randomId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('answers arriving out of order', () => {
  it('commit log: the previous project’s history never shows in the new one, nor selects a commit', async () => {
    const old = deferred<unknown>()
    const show = vi.fn(() => ({ hash: 'a1', files: [] }))
    installBridge({ 'scm:log': () => old.promise, 'scm:show': show, 'scm:status': NO_REPO })
    useEditor.setState({ projectId: 'a' })
    const pending = useScm.getState().loadLog()
    useEditor.setState({ projectId: 'b' })
    await settle()
    old.resolve([{ hash: 'a1', subject: 'from a' }])
    await pending
    expect(useScm.getState().log).toEqual([])
    expect(useScm.getState().selected).toBeUndefined()
    expect(show).not.toHaveBeenCalled()
  })

  it('git status of the previous project never shows in the new one', async () => {
    const old = deferred<unknown>()
    installBridge({
      'scm:status': (p: { projectId: string }) => (p.projectId === 'a' ? old.promise : { repo: true, branch: 'from-b', files: [] }),
      'scm:branches': () => []
    })
    useEditor.setState({ projectId: 'a' })
    const pending = useScm.getState().refresh()
    useEditor.setState({ projectId: 'b' }) // the switch refreshes for b
    await settle()
    old.resolve({ repo: true, branch: 'from-a', files: [] })
    await pending
    expect(useScm.getState().status?.branch).toBe('from-b')
  })

  it('a diff of the previous project never shows in the new one', async () => {
    const old = deferred<unknown>()
    installBridge({ 'scm:diff': () => old.promise, 'scm:status': NO_REPO })
    useEditor.setState({ projectId: 'a' })
    const pending = useScm.getState().openDiff({ path: 'a.ts' } as never, { kind: 'unstaged' }, 'a.ts')
    useEditor.setState({ projectId: 'b' })
    await settle()
    old.resolve({ original: 'from a', modified: 'from a' })
    await pending
    expect(useScm.getState().diff).toBeUndefined()
    expect(useScm.getState().error).toBeUndefined()
  })

  it('commit details: the commit still selected shows, in the project still open', async () => {
    const answers: Record<string, ReturnType<typeof deferred<unknown>>> = { a1: deferred(), b2: deferred(), c3: deferred() }
    installBridge({ 'scm:show': (p: { hash: string }) => answers[p.hash].promise, 'scm:status': NO_REPO })
    useEditor.setState({ projectId: 'a' })
    const first = useScm.getState().select('a1')
    const second = useScm.getState().select('b2')
    answers.b2.resolve({ hash: 'b2', files: [] })
    await second
    answers.a1.resolve({ hash: 'a1', files: [] }) // clicks outran this answer
    await first
    expect(useScm.getState().detail).toEqual({ hash: 'b2', files: [] })

    const third = useScm.getState().select('c3')
    useEditor.setState({ projectId: 'b' })
    await settle()
    useScm.setState({ selected: 'c3' }) // the same hash in the new project: still the other project's answer
    answers.c3.resolve({ hash: 'c3', files: [] })
    await third
    expect(useScm.getState().detail).toBeUndefined()
  })

  it('pull requests: only the latest list shows, and only its end stops the spinner', async () => {
    const answers = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>(), deferred<unknown>()]
    let asked = 0
    installBridge({ 'github:list': () => answers[asked++].promise, 'scm:status': NO_REPO })
    useEditor.setState({ projectId: 'a' })
    const gh = () => useGitHub.getState()

    const older = gh().list()
    const newer = gh().list()
    answers[0].resolve([{ number: 1 }]) // the filter switched meanwhile
    await older
    expect(gh().pulls).toEqual([])
    expect(gh().loading).toBe(true)
    answers[1].resolve([{ number: 2 }])
    await newer
    expect(gh().pulls).toEqual([{ number: 2 }])
    expect(gh().loading).toBe(false)

    // An older list failing says nothing about the one being asked for.
    const failing = gh().list()
    const latest = gh().list()
    answers[2].reject(new Error('gh timed out'))
    await failing
    expect(gh().error).toBeUndefined()
    expect(gh().loading).toBe(true)
    answers[3].resolve([{ number: 3 }])
    await latest
    expect(gh().pulls).toEqual([{ number: 3 }])
    expect(gh().error).toBeUndefined()
    expect(gh().loading).toBe(false)
  })

  it('a pull request: the one opened last wins, whatever comes of the one before', async () => {
    const answers: Record<number, ReturnType<typeof deferred<unknown>>> = { 1: deferred(), 2: deferred(), 3: deferred(), 4: deferred() }
    installBridge({ 'github:view': (p: { number: number }) => answers[p.number].promise, 'scm:status': NO_REPO })
    useEditor.setState({ projectId: 'a' })
    const gh = () => useGitHub.getState()

    const first = gh().open(1)
    const second = gh().open(2)
    answers[1].resolve({ number: 1 })
    await first
    expect(gh().detail).toBeUndefined()
    expect(gh().opening).toBe(2)
    answers[2].resolve({ number: 2 })
    await second
    expect(gh().detail).toEqual({ number: 2 })
    expect(gh().opening).toBeUndefined()

    const failing = gh().open(3)
    const latest = gh().open(4)
    answers[3].reject(new Error('gh timed out'))
    await failing
    expect(gh().error).toBeUndefined()
    expect(gh().opening).toBe(4)
    answers[4].resolve({ number: 4 })
    await latest
    expect(gh().detail).toEqual({ number: 4 })
    expect(gh().opening).toBeUndefined()
  })

  it('mongo: the indexes of the collection left behind never show in the next', async () => {
    const old = deferred<unknown>()
    installBridge({ 'mongo:indexes': () => old.promise, 'mongo:find': () => ({ documents: [], total: 0 }) })
    useMongo.setState({ open: { id: 'c1', db: 'shop', collection: 'users' } as never })
    useMongo.getState().setMode('indexes')
    await useMongo.getState().openCollection({ id: 'c1', db: 'shop', collection: 'orders' } as never)
    old.resolve([{ name: 'email_1', key: '{"email":1}', unique: true }])
    await settle()
    expect(useMongo.getState().indexes).toEqual([])
    expect(useMongo.getState().error).toBeUndefined()
  })

  it('memory: of overlapping reloads (a burst of vault changes), an older index never replaces a newer one', async () => {
    const lists = [deferred<unknown>(), deferred<unknown>()]
    let asked = 0
    installBridge({ 'memory:status': () => ({}), 'memory:list': () => lists[asked++].promise, 'memory:graph': () => ({ nodes: [], edges: [] }), 'memory:folders': () => [] })
    const older = useMemory.getState().onChanged({} as never)
    const newer = useMemory.getState().onChanged({} as never)
    lists[1].resolve([{ path: 'new.md' }])
    await newer
    expect(useMemory.getState().notes).toEqual([{ path: 'new.md' }])
    lists[0].resolve([{ path: 'old.md' }])
    await older
    expect(useMemory.getState().notes).toEqual([{ path: 'new.md' }])
  })

  it('memory: the note clicked last stays open', async () => {
    const a = deferred<unknown>()
    installBridge({ 'memory:read': (p: { path: string }) => (p.path === 'A.md' ? a.promise : { path: 'B.md', body: 'b' }) })
    const first = useMemory.getState().open('A.md')
    await useMemory.getState().open('B.md')
    a.resolve({ path: 'A.md', body: 'a' })
    await first
    expect(useMemory.getState().note?.path).toBe('B.md')
    expect(useMemory.getState().draft).toBe('b')
  })

  it('memory: a save finishing after another note opened keeps that note and its text', async () => {
    const written = deferred<unknown>()
    installBridge({
      'memory:writeBody': () => written.promise,
      'memory:read': (p: { path: string }) => ({ path: p.path, body: p.path === 'A.md' ? 'a2' : 'b' })
    })
    useMemory.setState({ note: { path: 'A.md', body: 'a' } as never, draft: 'a2' })
    const saving = useMemory.getState().save()
    // Another note opened while the write is still in flight.
    useMemory.setState({ note: { path: 'B.md', body: 'b' } as never, draft: 'b' })
    written.resolve(undefined)
    await saving
    expect(useMemory.getState().note?.path).toBe('B.md')
    expect(useMemory.getState().draft).toBe('b')
    expect(useMemory.getState().saving).toBe(false)
  })
})

describe('terminal restart', () => {
  it('Enter pressed twice after exit starts one shell, not two', async () => {
    const create = vi.fn(async () => ({ id: 'new', title: '~', cwdLabel: '~', shell: 'zsh', createdAt: '2026-01-01' }))
    installBridge({ 'terminal:create': create })
    useTerminals.setState({ tabs: [{ id: 'old', title: '~', cwdLabel: '~', shell: 'zsh', createdAt: '2026-01-01', exitCode: 0 } as never], activeId: 'old' })
    await Promise.all([useTerminals.getState().restart('old'), useTerminals.getState().restart('old')])
    expect(create).toHaveBeenCalledTimes(1)
    expect(useTerminals.getState().tabs.map((t) => t.id)).toEqual(['new'])
  })

  it('a tab closed while its shell restarts: the new shell is ended, not left running unseen', async () => {
    const started = deferred<unknown>()
    const kill = vi.fn(() => undefined)
    installBridge({ 'terminal:create': () => started.promise, 'terminal:kill': kill })
    useTerminals.setState({ tabs: [{ id: 'old', title: '~', cwdLabel: '~', shell: 'zsh', createdAt: '2026-01-01', exitCode: 0 } as never], activeId: 'old' })
    const restarting = useTerminals.getState().restart('old')
    await useTerminals.getState().close('old')
    started.resolve({ id: 'new', title: '~', cwdLabel: '~', shell: 'zsh', createdAt: '2026-01-01' })
    await restarting
    await settle()
    expect(kill).toHaveBeenCalledWith({ id: 'new' })
    expect(useTerminals.getState().tabs).toEqual([])
  })

  it('... and ending it failing (already gone) is nothing to tell the user about', async () => {
    const started = deferred<unknown>()
    const kill = vi.fn(() => {
      throw new Error('no such terminal')
    })
    installBridge({ 'terminal:create': () => started.promise, 'terminal:kill': kill })
    useTerminals.setState({ tabs: [{ id: 'old', title: '~', cwdLabel: '~', shell: 'zsh', createdAt: '2026-01-01', exitCode: 0 } as never], activeId: 'old' })
    const restarting = useTerminals.getState().restart('old')
    await useTerminals.getState().close('old')
    started.resolve({ id: 'new', title: '~', cwdLabel: '~', shell: 'zsh', createdAt: '2026-01-01' })
    await restarting
    expect(kill).toHaveBeenCalledWith({ id: 'new' })
    expect(useTerminals.getState().tabs).toEqual([])
    expect(useTerminals.getState().error).toBeUndefined()
  })
})
