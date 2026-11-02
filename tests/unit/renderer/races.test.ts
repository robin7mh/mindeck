import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import { randomId } from '@/lib/id'
import { useScm } from '@/features/editor/scm'
import { useEditor } from '@/features/editor/store'
import { useMemory } from '@/features/memory/store'
import { useTerminals } from '@/features/terminal/store'

/** A promise to resolve by hand — answers arriving in any order. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const initialScm = useScm.getState()
const initialEditor = useEditor.getState()
const initialMemory = useMemory.getState()
const initialTerminals = useTerminals.getState()

beforeEach(() => {
  useScm.setState(initialScm, true)
  useEditor.setState(initialEditor, true)
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
  it('search: an older, slower result never replaces the newer one', async () => {
    const slow = deferred<unknown>()
    const fast = deferred<unknown>()
    installBridge({ 'scm:search': (p: { query: string }) => (p.query === 'a' ? slow.promise : fast.promise) })
    useEditor.setState({ projectId: 'p' })
    useScm.getState().setSearch({ query: 'a' })
    const first = useScm.getState().runSearch()
    useScm.getState().setSearch({ query: 'ab' })
    const second = useScm.getState().runSearch()
    fast.resolve({ files: [{ path: 'new.ts' }] })
    await second
    slow.resolve({ files: [{ path: 'old.ts' }] })
    await first
    expect(useScm.getState().search.result).toEqual({ files: [{ path: 'new.ts' }] })
    expect(useScm.getState().search.searching).toBe(false)
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
})
