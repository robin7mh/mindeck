import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { PermissionService } from '../../../electron/main/services/ai/PermissionService'
import { EventBus } from '../../../electron/main/services/events/EventBus'
import { ALL_PROJECTS, type PermissionRequest } from '@shared/types/ai'
import type { MindeckEvent } from '@shared/types/events'

const setup = async () => {
  const dir = await tempDir()
  const events: MindeckEvent[] = []
  const bus = new EventBus({ sink: { persist: () => {} } })
  bus.subscribe('*', (e) => events.push(e))
  const file = join(dir, 'grants.json')
  const perms = new PermissionService({ file, events: bus, onRequest: () => {}, onResolved: () => {} })
  return { perms, file, events }
}

const input = (over: Partial<PermissionRequest> = {}): Omit<PermissionRequest, 'id' | 'createdAt'> => ({
  runId: 'r',
  conversationId: 'c',
  agentId: 'claude-code',
  agentName: 'Claude Code',
  toolName: 'Write',
  toolTitle: 'Write file',
  risk: 'write',
  summary: 'Write a.ts',
  reason: '',
  input: {},
  allowAlways: true,
  ...over
})

describe('PermissionService · grants per project', () => {
  it('keeps "always" to the project it was given in', async () => {
    const { perms, file } = await setup()
    const a = perms.ask(input({ projectId: 'p1' }), new AbortController().signal)
    await perms.respond(a.id, 'always')
    expect(await perms.isGranted('claude-code', 'Write', 'p1')).toBe(true)
    expect(await perms.isGranted('claude-code', 'Write', 'p2')).toBe(false)
    expect(await perms.isGranted('claude-code', 'Write')).toBe(false)
    // Outside projects is a scope of its own.
    const b = perms.ask(input(), new AbortController().signal)
    await perms.respond(b.id, 'always')
    expect(await perms.isGranted('claude-code', 'Write')).toBe(true)
    expect(await perms.grants()).toEqual([
      { agentId: 'claude-code', toolName: 'Write', projectId: 'p1', createdAt: expect.any(String) },
      { agentId: 'claude-code', toolName: 'Write', createdAt: expect.any(String) }
    ])
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.version).toBe(2)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)

    await perms.revoke('claude-code', 'Write', 'p2') // no such grant: nothing changes
    expect(await perms.grants()).toHaveLength(2)
    await perms.revoke('claude-code', 'Write', 'p1')
    expect(await perms.grants()).toEqual([expect.objectContaining({ toolName: 'Write' })])
    expect(await perms.isGranted('claude-code', 'Write', 'p1')).toBe(false)
  })

  it('two quick "always" answers both land', async () => {
    const { perms } = await setup()
    const a = perms.ask(input({ projectId: 'p1', toolName: 'Edit' }), new AbortController().signal)
    const b = perms.ask(input({ projectId: 'p1', toolName: 'Write' }), new AbortController().signal)
    await Promise.all([perms.respond(a.id, 'always'), perms.respond(b.id, 'always')])
    expect((await perms.grants()).map((g) => g.toolName).sort()).toEqual(['Edit', 'Write'])
  })

  it('a grant that can\'t be saved fails its answer, not the ones after it', async () => {
    const { perms, file } = await setup()
    await mkdir(file) // the file can't be replaced by a folder's name
    const a = perms.ask(input({ projectId: 'p1', toolName: 'Edit' }), new AbortController().signal)
    await expect(perms.respond(a.id, 'always')).rejects.toThrow()
    await rm(file, { recursive: true })
    const b = perms.ask(input({ projectId: 'p1', toolName: 'Write' }), new AbortController().signal)
    await perms.respond(b.id, 'always')
    expect((await perms.grants()).map((g) => g.toolName)).toEqual(['Write'])
  })

  it('migrates global grants: kept for every project, title-keyed ACP ones dropped', async () => {
    const { perms, file } = await setup()
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        grants: [
          { agentId: 'claude-code', toolName: 'Edit', createdAt: '2026-01-01' },
          { agentId: 'codex', toolName: 'Edit src/app.ts', createdAt: '2026-01-01' },
          { agentId: 'gemini', toolName: 'WriteFile foo', createdAt: '2026-01-01' }
        ]
      })
    )
    expect(await perms.isGranted('claude-code', 'Edit', 'any-project')).toBe(true)
    expect(await perms.isGranted('claude-code', 'Edit')).toBe(true)
    expect(await perms.grants()).toEqual([{ agentId: 'claude-code', toolName: 'Edit', createdAt: '2026-01-01', projectId: ALL_PROJECTS }])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, grants: await perms.grants() })
    // A per-project "always" next to a global grant adds nothing.
    const a = perms.ask(input({ toolName: 'Edit', projectId: 'p1' }), new AbortController().signal)
    await perms.respond(a.id, 'always')
    expect(await perms.grants()).toHaveLength(1)
    await perms.revoke('claude-code', 'Edit', ALL_PROJECTS)
    expect(await perms.grants()).toEqual([])
  })

  it('a version 2 file loads as it is; JSON null counts as empty; a failed migration write is retried next start', async () => {
    const { perms, file } = await setup()
    const grants = [{ agentId: 'codex', toolName: 'edit', projectId: 'p', createdAt: '' }]
    await writeFile(file, JSON.stringify({ version: 2, grants }))
    expect(await perms.grants()).toEqual(grants)

    const empty = await setup()
    await writeFile(empty.file, 'null')
    expect(await empty.perms.grants()).toEqual([])

    const stuck = await setup()
    await writeFile(stuck.file, JSON.stringify({ grants: [{ agentId: 'assistant', toolName: 't', createdAt: '' }] }))
    const writes = await import('../../../electron/main/lib/writeAtomic')
    const spy = vi.spyOn(writes, 'writeAtomic').mockRejectedValueOnce(new Error('read-only'))
    expect(await stuck.perms.isGranted('assistant', 't', 'p')).toBe(true)
    spy.mockRestore()
  })
})

describe('PermissionService · paired devices', () => {
  it('may deny anything and allow reads, but changes and commands only with remote shells — never "always"', async () => {
    const { perms, events } = await setup()
    const phone = { deviceId: 'phone', shells: false }
    const write = perms.ask(input({ projectId: 'p1' }), new AbortController().signal)
    await expect(perms.respond(write.id, 'once', phone)).rejects.toMatchObject({ code: 'remote-terminal-disabled' })
    await expect(perms.respond(write.id, 'always', phone)).rejects.toMatchObject({ code: 'remote-terminal-disabled' })
    const cmd = perms.ask(input({ toolName: 'Bash', risk: 'execute', allowAlways: false }), new AbortController().signal)
    await expect(perms.respond(cmd.id, 'once', phone)).rejects.toMatchObject({ code: 'remote-terminal-disabled' })
    await perms.respond(cmd.id, 'deny', phone)
    expect(await cmd.decision).toBe('deny')
    expect(events.at(-1)).toMatchObject({ type: 'permission.denied', actor: { kind: 'user', id: 'phone' } })

    const read = perms.ask(input({ toolName: 'Read', risk: 'read' }), new AbortController().signal)
    await perms.respond(read.id, 'always', phone)
    expect(await read.decision).toBe('once')

    // With remote shells: allowed, still only once.
    await perms.respond(write.id, 'always', { shells: true })
    expect(await write.decision).toBe('once')
    expect(events.at(-1)).toMatchObject({ type: 'permission.granted', actor: { kind: 'user' } })
    expect(await perms.grants()).toEqual([])
  })
})

describe('PermissionService · approvals agents asked for themselves', () => {
  it('each answer counts once, in its conversation, for a minute', async () => {
    const { perms } = await setup()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const a = perms.ask(input({ toolName: 'mcp__mindeck__memory_append' }), new AbortController().signal)
    await perms.respond(a.id, 'once')
    const denied = perms.ask(input({ toolName: 'other' }), new AbortController().signal)
    await perms.respond(denied.id, 'deny')
    const match = (r: PermissionRequest) => r.toolName.endsWith('memory_append')
    expect(perms.takeApproval('elsewhere', match)).toBe(false)
    expect(perms.takeApproval('c', () => false)).toBe(false)
    expect(perms.takeApproval('c', (r) => r.toolName === 'other')).toBe(false) // denials never count
    expect(perms.takeApproval('c', match)).toBe(true)
    expect(perms.takeApproval('c', match)).toBe(false)

    const b = perms.ask(input({ toolName: 'mcp__mindeck__memory_append' }), new AbortController().signal)
    await perms.respond(b.id, 'once')
    now.mockReturnValue(1_000_000 + 60_000)
    expect(perms.takeApproval('c', match)).toBe(false)
    now.mockRestore()
  })
})
