import { describe, expect, it, vi } from 'vitest'
import { RemoteScope } from '../../../electron/main/server/RemoteScope'
import type { PermissionRequest } from '@shared/types/ai'
import type { FinderEntry, FinderListing } from '@shared/types/finder'

/** Projects `shared` and `private` (off-limits); session s1 works in `private`, s2 in `shared`; conversation c1 belongs to `private`. */
function scope() {
  let now = 0
  const project = vi.fn(async (id: string) => {
    if (id === 'private') throw Object.assign(new Error('The project private is off-limits for paired devices'), { code: 'remote-forbidden' })
  })
  const check = vi.fn(async () => {})
  const sessions: Record<string, string> = { s1: 'private', s2: 'shared' }
  const conversations: Record<string, string> = { c1: 'private', c2: 'shared' }
  const pending: PermissionRequest[] = [
    { id: 'r1', conversationId: 's1', projectId: undefined } as unknown as PermissionRequest,
    { id: 'r2', conversationId: 'c9', projectId: 'shared' } as unknown as PermissionRequest
  ]
  const s = new RemoteScope({
    access: { project, check, denied: (path: string) => (/(^|\/)id_rsa$/.test(path) ? 'id_rsa' : undefined), shows: async (path: string) => !path.includes('/Library/') },
    sessionProject: (id) => sessions[id],
    conversationProject: async (id) => conversations[id],
    pending: () => pending,
    now: () => now
  })
  return { s, project, check, tick: (ms: number) => (now += ms) }
}

describe('RemoteScope · calls', () => {
  it('refuses sessions, conversations and approvals of projects a device may not use', async () => {
    const { s, check } = scope()
    await s.guard('agents:get', { id: 's2' })
    expect(check).toHaveBeenCalledWith('agents:get', { id: 's2' })
    for (const [channel, payload] of [
      ['agents:get', { id: 's1' }],
      ['agents:diff', { id: 's1', path: 'a.ts' }],
      ['agents:send', { id: 's1', text: 'x' }],
      ['ai:conversation', { id: 'c1' }],
      ['ai:deleteConversation', { id: 'c1' }],
      ['ai:send', { conversationId: 'c1', text: 'x' }],
      ['ai:send', { conversationId: 's1', text: 'x' }],
      ['ai:cancel', { conversationId: 'c1' }],
      ['permission:respond', { id: 'r1', decision: 'deny' }]
    ] as const) {
      await expect(s.guard(channel, payload), channel).rejects.toMatchObject({ code: 'remote-forbidden' })
    }
    // Shared projects, nothing named, no project, unknown ids (the handler says "not found"): through.
    for (const [channel, payload] of [
      ['agents:list', undefined],
      ['agents:get', { id: 'unknown' }],
      ['agents:changes', {}],
      ['ai:conversation', { id: 'c2' }],
      ['ai:conversation', {}],
      ['ai:send', { text: 'x' }],
      ['permission:respond', { id: 'r2', decision: 'deny' }],
      ['permission:respond', { id: 'gone', decision: 'deny' }],
      ['permission:respond', {}],
      ['files:read', { projectId: 'shared', path: 'a' }]
    ] as const) {
      await s.guard(channel, payload)
    }
  })

  it('trims lists to the projects a device may use', async () => {
    const { s } = scope()
    expect(await s.result('agents:list', [{ id: 's1', projectId: 'private' }, { id: 's2', projectId: 'shared' }])).toEqual([{ id: 's2', projectId: 'shared' }])
    expect(await s.result('ai:conversations', [{ id: 'c1', projectId: 'private' }, { id: 'c3' }])).toEqual([{ id: 'c3' }])
    expect(await s.result('ai:runs', [{ id: 'r', projectId: 'private' }, { id: 'q', projectId: 'shared' }])).toEqual([{ id: 'q', projectId: 'shared' }])
    expect(await s.result('permission:pending', [{ id: 'r1', conversationId: 's1' }, { id: 'r3', conversationId: 'c2' }])).toEqual([{ id: 'r3', conversationId: 'c2' }])
    expect(
      await s.result('permission:grants', [
        { agentId: 'a', toolName: 't', projectId: 'private' },
        { agentId: 'a', toolName: 't', projectId: '*' },
        { agentId: 'a', toolName: 't' }
      ])
    ).toEqual([
      { agentId: 'a', toolName: 't', projectId: '*' },
      { agentId: 'a', toolName: 't' }
    ])
    expect(
      await s.result('events:recent', [
        { id: 'e1', projectId: 'private' },
        { id: 'e2', conversationId: 'c1' },
        { id: 'e3', conversationId: 'c2' },
        { id: 'e4' },
        // What devices did is the desktop's audit, not for other devices.
        { id: 'e5', type: 'device.files', payload: { device: 'iPhone', action: 'download', path: '/home/ada/bank.pdf' } },
        { id: 'e6', type: 'device.files', payload: { device: 'iPhone', action: 'download', path: '/home/ada/a.txt' } }
      ])
    ).toEqual([
      { id: 'e3', conversationId: 'c2' },
      { id: 'e4' }
    ])
    // Running Live Servers name their project and folder: only the device's own (BE-SEC-07).
    expect(await s.result('liveServer:status', [{ projectId: 'private', root: 'site' }, { projectId: 'shared', root: '' }])).toEqual([{ projectId: 'shared', root: '' }])
    const other = [{ id: 'p', path: '/x' }]
    expect(await s.result('projects:list', other)).toBe(other)
  })
})

describe('RemoteScope · events', () => {
  it('drops or trims what belongs to projects a device may not use; the rest goes out as it is', async () => {
    const { s } = scope()
    const drop = async (channel: Parameters<RemoteScope['event']>[0], payload: unknown) => expect(await s.event(channel, payload), channel).toBeNull()
    const pass = async (channel: Parameters<RemoteScope['event']>[0], payload: unknown) => expect(await s.event(channel, payload), channel).toBe(payload)
    for (const channel of ['context:progress', 'lsp:diagnostics', 'sftp:progress', 'tests:changed'] as const) {
      await drop(channel, { projectId: 'private' })
      await pass(channel, { projectId: 'shared' })
    }
    expect(await s.event('liveServer:changed', [{ projectId: 'private' }, { projectId: 'shared' }])).toEqual([{ projectId: 'shared' }])
    await drop('agents:changed', { session: { id: 's1', projectId: 'private' } })
    await pass('agents:changed', { session: { id: 's2', projectId: 'shared' } })
    await pass('agents:changed', { removed: 's1' })
    await drop('agents:message', { sessionId: 's1', message: {} })
    await pass('agents:message', { sessionId: 's2', message: {} })
    await drop('ai:delta', { conversationId: 'c1', messageId: 'm', text: 'secret' })
    await drop('ai:message', { conversationId: 'c1' })
    await pass('ai:message', { conversationId: 'c-none' }) // a chat outside projects
    await drop('ai:conversationsChanged', { reason: 'updated', id: 'c1' })
    await pass('ai:conversationsChanged', { reason: 'deleted', id: 'gone' })
    await drop('permission:request', { id: 'r', conversationId: 's1' })
    await drop('permission:request', { id: 'r', conversationId: 'x', projectId: 'private' })
    await pass('permission:request', { id: 'r', conversationId: 'c2' })
    await drop('events:event', { id: 'e', projectId: 'private' })
    await drop('events:event', { id: 'e', conversationId: 's1' })
    await pass('events:event', { id: 'e' })
    await drop('events:event', { id: 'e', type: 'device.files', payload: { device: 'iPhone', action: 'mkdir', path: '/home/ada/A' } })
    await drop('events:event', { id: 'e', type: 'device.files', payload: { device: 'iPhone', action: 'trash' } })
    await pass('memory:changed', { paths: ['a.md'] })
  })

  it('reuses a project’s verdict for a moment — a stream of deltas asks once', async () => {
    const { s, project, tick } = scope()
    expect(await s.allows('shared')).toBe(true)
    expect(await s.allows('shared')).toBe(true)
    expect(await s.allows(undefined)).toBe(true)
    expect(project).toHaveBeenCalledTimes(1)
    tick(2500)
    expect(await s.allows('shared')).toBe(true)
    expect(project).toHaveBeenCalledTimes(2)
    // Many projects at once: the memo starts over instead of growing.
    for (let i = 0; i < 502; i += 1) await s.allows(`p${i}`)
    expect(await s.allows('private')).toBe(false)
  })

  it('the clock defaults to Date.now', async () => {
    const s = new RemoteScope({ access: { project: async () => {}, check: async () => {}, denied: () => undefined, shows: async () => true }, sessionProject: () => undefined, conversationProject: async () => undefined, pending: () => [] })
    expect(await s.allows('p')).toBe(true)
  })
})

describe('RemoteScope · Files', () => {
  it('lists files without hidden ones, keys and credentials', async () => {
    const { s } = scope()
    const entry = (name: string, hidden = false) => ({ name, path: `/home/ada/${name}`, kind: 'file', size: 1, mtimeMs: 0, hidden }) as FinderEntry
    const listing: FinderListing = { path: '/home/ada', parent: '/home', entries: [entry('a.txt'), entry('id_rsa'), entry('.env', true)], total: 1003, offset: 0 }
    const shown = (await s.result('finder:list', listing)) as FinderListing
    expect(shown.entries.map((e) => e.name)).toEqual(['a.txt'])
    expect(shown.total).toBe(1001)
    expect(((await s.result('finder:search', [entry('a.txt'), entry('id_rsa')])) as FinderEntry[]).map((e) => e.name)).toEqual(['a.txt'])
  })

  it('search hits are judged like paths a device names (Spotlight reaches into ~/Library); progress names no file', async () => {
    const { s } = scope()
    const hit = (path: string) => ({ name: path.split('/').pop()!, path, kind: 'file', size: 1, mtimeMs: 0, hidden: false }) as FinderEntry
    const found = (await s.result('finder:search', [hit('/home/ada/devices.txt'), hit('/home/ada/Library/Application Support/Mindeck/devices.json')])) as FinderEntry[]
    expect(found.map((e) => e.path)).toEqual(['/home/ada/devices.txt'])
    expect(await s.event('finder:progress', { id: 'j1', kind: 'copy', done: 1, total: 2, file: '/home/ada/.ssh/id_rsa' })).toEqual({ id: 'j1', kind: 'copy', done: 1, total: 2 })
  })
})
