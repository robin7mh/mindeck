import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'

// --- electron double -------------------------------------------------------
const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, req: unknown) => unknown>()
  const rendererListeners = new Map<string, Set<(...a: unknown[]) => void>>()
  return {
    handlers,
    rendererListeners,
    userData: '/tmp/mindeck-userdata',
    ipcMain: { handle: vi.fn((ch: string, fn: (e: unknown, r: unknown) => unknown) => handlers.set(ch, fn)) },
    app: { getPath: vi.fn(() => electron.userData) },
    exposed: {} as Record<string, unknown>,
    contextBridge: {
      exposeInMainWorld: vi.fn((key: string, api: unknown) => {
        electron.exposed[key] = api
      })
    },
    ipcRenderer: {
      send: vi.fn(),
      invoke: vi.fn(async (...a: unknown[]) => ({ invoked: a })),
      on: vi.fn((ch: string, fn: (...a: unknown[]) => void) => {
        if (!rendererListeners.has(ch)) rendererListeners.set(ch, new Set())
        rendererListeners.get(ch)!.add(fn)
      }),
      removeListener: vi.fn((ch: string, fn: (...a: unknown[]) => void) => rendererListeners.get(ch)?.delete(fn))
    }
  }
})
vi.mock('electron', () => ({
  ipcMain: electron.ipcMain,
  app: electron.app,
  contextBridge: electron.contextBridge,
  ipcRenderer: electron.ipcRenderer,
  webUtils: { getPathForFile: (f: { name: string }) => `/dropped/${f.name}` }
}))

import { bindIpc } from '../../../electron/ipc/registry'
import { Router } from '../../../electron/ipc/router'
import { CHANNEL_ACCESS, IPC_CHANNELS } from '../../../src/shared/ipc/contract'
import { registerContextIpc } from '../../../electron/ipc/context.ipc'
import { registerProjectIpc } from '../../../electron/ipc/projects.ipc'
import { registerSystemIpc } from '../../../electron/ipc/system.ipc'
import { registerMemoryIpc } from '../../../electron/ipc/memory.ipc'
import { registerTerminalIpc } from '../../../electron/ipc/terminal.ipc'
import { registerFilesIpc } from '../../../electron/ipc/files.ipc'
import { registerScmIpc } from '../../../electron/ipc/scm.ipc'
import { registerSearchIpc } from '../../../electron/ipc/search.ipc'
import { registerLspIpc } from '../../../electron/ipc/lsp.ipc'
import { registerDebugIpc } from '../../../electron/ipc/debug.ipc'
import { registerToolsIpc } from '../../../electron/ipc/tools.ipc'
import { registerMigrateIpc } from '../../../electron/ipc/migrate.ipc'
import { registerLiveIpc } from '../../../electron/ipc/live.ipc'
import { registerSftpIpc } from '../../../electron/ipc/sftp.ipc'
import { registerTestsIpc } from '../../../electron/ipc/tests.ipc'
import { registerNotebookIpc } from '../../../electron/ipc/notebook.ipc'
import { registerGitHubIpc } from '../../../electron/ipc/github.ipc'
import { registerMongoIpc } from '../../../electron/ipc/mongo.ipc'
import { registerRemoteIpc } from '../../../electron/ipc/remote.ipc'
import { registerLintIpc } from '../../../electron/ipc/lint.ipc'
import { registerAgentsIpc } from '../../../electron/ipc/agents.ipc'
import { migrateLegacyData, mindeckPaths } from '../../../electron/main/lib/paths'

const call = (channel: string, req?: unknown) => electron.handlers.get(channel)!({}, req)

describe('ipc router', () => {
  const ipcCtx = { transport: 'ipc' as const }
  const remoteCtx = { transport: 'remote' as const, deviceId: 'd1' }

  it('wraps results as { ok: true, data } and passes the call context', async () => {
    const router = new Router()
    const seen = vi.fn(() => [])
    router.register('projects:list', seen)
    expect(router.has('projects:list')).toBe(true)
    expect(router.has('nope')).toBe(false)
    expect(await router.dispatch('projects:list', undefined, ipcCtx)).toEqual({ ok: true, data: [] })
    expect(seen).toHaveBeenCalledWith(undefined, ipcCtx)
  })

  it('turns thrown errors into { ok: false } with code and message', async () => {
    const router = new Router()
    router.register('projects:list', () => {
      throw Object.assign(new Error('nope'), { code: 'not-found' })
    })
    expect(await router.dispatch('projects:list', undefined, ipcCtx)).toEqual({ ok: false, error: { code: 'not-found', message: 'nope' } })
  })

  it('falls back to a generic code and String(err) for odd throwables', async () => {
    const router = new Router()
    router.register('projects:list', () => {
      throw 'plain string'
    })
    expect(await router.dispatch('projects:list', undefined, ipcCtx)).toEqual({ ok: false, error: { code: 'error', message: 'plain string' } })
    router.register('projects:list', () => {
      throw null
    })
    expect(await router.dispatch('projects:list', undefined, ipcCtx)).toEqual({ ok: false, error: { code: 'error', message: 'null' } })
  })

  it('rejects unknown channels and invalid payloads before the handler runs', async () => {
    const router = new Router()
    const handler = vi.fn()
    router.register('memory:read', handler)
    expect(await router.dispatch('evil:channel', {}, ipcCtx)).toMatchObject({ ok: false, error: { code: 'unknown-channel' } })
    const bad = await router.dispatch('memory:read', { path: 42 }, ipcCtx)
    expect(bad).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect((bad as { error: { message: string } }).error.message).toContain('path:')
    expect(await router.dispatch('memory:read', null, ipcCtx)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('applies the access rules to remote callers only', async () => {
    let terminal = false
    const router = new Router({ remoteTerminal: () => terminal })
    router.register('projects:pickFolder', () => null)
    router.register('terminal:list', () => [])
    expect(await router.dispatch('projects:pickFolder', undefined, ipcCtx)).toEqual({ ok: true, data: null })
    expect(await router.dispatch('projects:pickFolder', undefined, remoteCtx)).toMatchObject({ ok: false, error: { code: 'desktop-only' } })
    expect(await router.dispatch('terminal:list', undefined, remoteCtx)).toMatchObject({ ok: false, error: { code: 'remote-terminal-disabled' } })
    terminal = true
    expect(await router.dispatch('terminal:list', undefined, remoteCtx)).toEqual({ ok: true, data: [] })
    expect(await new Router().dispatch('terminal:list', undefined, remoteCtx)).toMatchObject({ ok: false, error: { code: 'unknown-channel' } })
    const defaults = new Router()
    defaults.register('terminal:list', () => [])
    expect(await defaults.dispatch('terminal:list', undefined, remoteCtx)).toMatchObject({ error: { code: 'remote-terminal-disabled' } })
  })

  it('admin channels need the admin role remotely; the guard checks remote payloads only', async () => {
    const guard = vi.fn((channel: string, payload: unknown) => {
      if ((payload as { path?: string })?.path === '/etc') throw Object.assign(new Error('off-limits'), { code: 'remote-forbidden' })
    })
    const router = new Router({ remoteTerminal: () => false, guard })
    router.register('server:createPairingCode', () => ({ code: 'X' }) as never)
    router.register('projects:add', ({ path }) => ({ path }) as never)
    expect(await router.dispatch('server:createPairingCode', undefined, ipcCtx)).toMatchObject({ ok: true })
    expect(await router.dispatch('server:createPairingCode', undefined, remoteCtx)).toMatchObject({ ok: false, error: { code: 'admin-only' } })
    expect(await router.dispatch('server:createPairingCode', undefined, { ...remoteCtx, role: 'member' })).toMatchObject({ error: { code: 'admin-only' } })
    expect(await router.dispatch('server:createPairingCode', {}, { ...remoteCtx, role: 'admin' })).toEqual({ ok: true, data: { code: 'X' } })
    expect(await router.dispatch('projects:add', { path: '/etc' }, ipcCtx)).toEqual({ ok: true, data: { path: '/etc' } })
    expect(await router.dispatch('projects:add', { path: '/etc' }, remoteCtx)).toEqual({ ok: false, error: { code: 'remote-forbidden', message: 'off-limits' } })
    expect(await router.dispatch('projects:add', { path: '/srv/x' }, remoteCtx)).toMatchObject({ ok: true })
    expect(guard).toHaveBeenCalledWith('projects:add', { path: '/srv/x' }, remoteCtx)
    expect(guard).toHaveBeenCalledTimes(3) // the admin call too, never the desktop's
  })

  it('trusted channels (data beyond the shared folders) need the admin role or remote shells (BE-SEC-08)', async () => {
    let terminal = false
    const router = new Router({ remoteTerminal: () => terminal })
    router.register('mongo:connections', () => [])
    expect(await router.dispatch('mongo:connections', undefined, ipcCtx)).toEqual({ ok: true, data: [] })
    expect(await router.dispatch('mongo:connections', undefined, { ...remoteCtx, role: 'member' })).toMatchObject({ ok: false, error: { code: 'remote-terminal-disabled' } })
    expect(await router.dispatch('mongo:connections', undefined, { ...remoteCtx, role: 'admin' })).toEqual({ ok: true, data: [] })
    terminal = true
    expect(await router.dispatch('mongo:connections', undefined, { ...remoteCtx, role: 'member' })).toEqual({ ok: true, data: [] })
  })

  it('a member device leaves the desktop’s global settings alone (BE-SEC-05, BE-SEC-18)', () => {
    for (const channel of ['memory:setVault', 'memory:setDailyNotes', 'ai:configure', 'agents:setPushSettings', 'cloud:forgotPassword', 'cloud:syncPush', 'cloud:syncPull'] as const) {
      expect(CHANNEL_ACCESS[channel], channel).toBe('admin')
    }
    for (const channel of ['ai:inlineComplete', 'ai:inlineEdit'] as const) expect(CHANNEL_ACCESS[channel], channel).toBe('terminal')
    for (const channel of ['mongo:connections', 'mongo:databases', 'mongo:collections', 'mongo:find', 'mongo:indexes'] as const) expect(CHANNEL_ACCESS[channel], channel).toBe('trusted')
  })

  it('the OS’s own errors reach a device as a reference, the details go to the log (BE-SEC-19)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const router = new Router({ remoteTerminal: () => false })
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/robin/secret/x'"), { code: 'ENOENT', syscall: 'open' })
    const thrown: unknown[] = [enoent, Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }), 'a string', null]
    router.register('memory:status', () => {
      throw thrown.shift()
    })
    expect(await router.dispatch('memory:status', undefined, ipcCtx)).toEqual({ ok: false, error: { code: 'ENOENT', message: enoent.message } }) // the desktop sees it all
    const generic = expect.stringMatching(/^Something went wrong on the Mindeck core \(ref [0-9a-f]{8}\)$/)
    expect(await router.dispatch('memory:status', undefined, remoteCtx)).toEqual({ ok: false, error: { code: 'EACCES', message: generic } })
    expect(await router.dispatch('memory:status', undefined, remoteCtx)).toEqual({ ok: false, error: { code: 'error', message: generic } })
    expect(await router.dispatch('memory:status', undefined, remoteCtx)).toEqual({ ok: false, error: { code: 'error', message: generic } })
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[router\] memory:status failed \(ref [0-9a-f]{8}\):$/), 'a string')
    // Mindeck's own errors are written for people: they reach the device as they are.
    router.register('memory:list', () => {
      throw Object.assign(new Error('Note not found: a.md'), { code: 'not-found' })
    })
    router.register('memory:graph', () => {
      throw new Error('The vault is busy')
    })
    expect(await router.dispatch('memory:list', undefined, remoteCtx)).toEqual({ ok: false, error: { code: 'not-found', message: 'Note not found: a.md' } })
    expect(await router.dispatch('memory:graph', undefined, remoteCtx)).toEqual({ ok: false, error: { code: 'error', message: 'The vault is busy' } })
    error.mockRestore()
  })

  it('a remote call’s answer is shaped for the device (lists trimmed); the desktop’s never', async () => {
    const shape = vi.fn(async (_channel: string, data: unknown) => (data as { id: string }[]).filter((s) => s.id !== 'private'))
    const router = new Router({ remoteTerminal: () => false, shape })
    router.register('agents:list', () => [{ id: 'private' }, { id: 'shared' }] as never)
    expect(await router.dispatch('agents:list', undefined, ipcCtx)).toEqual({ ok: true, data: [{ id: 'private' }, { id: 'shared' }] })
    expect(await router.dispatch('agents:list', undefined, remoteCtx)).toEqual({ ok: true, data: [{ id: 'shared' }] })
    expect(shape).toHaveBeenCalledTimes(1)
  })

  it('paired devices list only the projects they may use, and add projects as remote ones', async () => {
    const router = new Router({ remoteTerminal: () => false })
    const service = { list: () => [{ id: 'a' }, { id: 'b' }], add: vi.fn(async (path: string) => ({ path })) }
    const visible = vi.fn(async (list: { id: string }[]) => list.filter((p) => p.id === 'a'))
    registerProjectIpc(router, service as never, { visible } as never)
    expect(await router.dispatch('projects:list', undefined, ipcCtx)).toEqual({ ok: true, data: [{ id: 'a' }, { id: 'b' }] })
    expect(await router.dispatch('projects:list', undefined, remoteCtx)).toEqual({ ok: true, data: [{ id: 'a' }] })
    await router.dispatch('projects:add', { path: '/srv/x' }, remoteCtx)
    expect(service.add).toHaveBeenCalledWith('/srv/x', true)
    const plain = new Router({ remoteTerminal: () => false })
    registerProjectIpc(plain, service as never)
    expect(await plain.dispatch('projects:list', undefined, remoteCtx)).toEqual({ ok: true, data: [{ id: 'a' }, { id: 'b' }] })
  })

  it('binds every contract channel to the window IPC through the router', async () => {
    electron.handlers.clear()
    const router = new Router()
    router.register('projects:list', () => ['p'] as never)
    bindIpc(router)
    expect([...electron.handlers.keys()].sort()).toEqual([...IPC_CHANNELS].sort())
    expect(await call('projects:list')).toEqual({ ok: true, data: ['p'] })
  })

  it('answers Mindeck’s own page only — a web page in a frame gets nothing', async () => {
    electron.handlers.clear()
    const router = new Router()
    router.register('projects:list', () => ['p'] as never)
    bindIpc(router, (url) => url.startsWith('file:///app/'))
    const handle = electron.handlers.get('projects:list')!
    expect(await handle({ senderFrame: { url: 'file:///app/index.html' } }, undefined)).toEqual({ ok: true, data: ['p'] })
    const forbidden = { ok: false, error: { code: 'forbidden', message: 'Only the Mindeck window may call the core' } }
    expect(await handle({ senderFrame: { url: 'https://evil.example/' } }, undefined)).toEqual(forbidden)
    expect(await handle({ senderFrame: null }, undefined)).toEqual(forbidden)
  })
})

describe('ipc handler modules bind every channel to its service', () => {
  /** A service double whose every method records its call and echoes args. */
  const spyService = () =>
    new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
      get: (target, key: string) => (target[key] ??= vi.fn((...args: unknown[]) => ({ method: key, args })))
    })

  it.each([
    ['context', registerContextIpc, [['context:get', { projectId: 'p' }, 'get', ['p']], ['context:reindex', { projectId: 'p' }, 'reindex', ['p']]]],
    [
      'projects',
      registerProjectIpc,
      [
        ['projects:list', undefined, 'list', []],
        ['projects:pickFolder', undefined, 'pickFolder', []],
        ['projects:add', { path: '/x' }, 'add', ['/x', false]],
        ['projects:remove', { id: 'i' }, 'remove', ['i']],
        ['projects:refresh', { id: 'i' }, 'refresh', ['i']],
        ['projects:pull', { id: 'i' }, 'pull', ['i']],
        ['projects:openInEditor', { id: 'i' }, 'openInEditor', ['i']],
        ['projects:githubDesktop', undefined, 'githubDesktop', []],
        ['projects:openInGitHubDesktop', { id: 'i' }, 'openInGitHubDesktop', ['i']],
        ['projects:openFile', { id: 'i', file: 'f', line: 3 }, 'openFile', ['i', 'f', 3]]
      ]
    ],
    [
      'system',
      registerSystemIpc,
      [
        ['system:subscribe', undefined, 'subscribe', []],
        ['system:unsubscribe', undefined, 'unsubscribe', []],
        ['system:snapshot', undefined, 'snapshot', []],
        ['system:user', undefined, 'user', []]
      ]
    ],
    [
      'memory',
      registerMemoryIpc,
      [
        ['memory:status', undefined, 'status', []],
        ['memory:createVault', undefined, 'createVault', []],
        ['memory:pickVault', undefined, 'pickVault', []],
        ['memory:list', undefined, 'list', []],
        ['memory:read', { path: 'a.md' }, 'read', ['a.md']],
        ['memory:write', { path: 'a.md', raw: 'r' }, 'write', ['a.md', 'r']],
        ['memory:create', { title: 't', folder: 'f' }, 'create', ['t', 'f', undefined, undefined]],
        ['memory:create', { title: 't', template: 'T/x.md', now: '2026-10-15T09:00' }, 'create', ['t', undefined, 'T/x.md', '2026-10-15T09:00']],
        ['memory:trash', { path: 'a.md' }, 'trash', ['a.md']],
        ['memory:graph', undefined, 'graph', []],
        ['memory:search', { query: 'q' }, 'search', ['q']],
        ['memory:setGraphStyle', { mode: 'single', color: 'pink' }, 'setGraphStyle', [{ mode: 'single', color: 'pink' }]],
        ['memory:reveal', undefined, 'reveal', []],
        ['memory:folders', undefined, 'folders', []],
        ['memory:writeBody', { path: 'a.md', body: 'b' }, 'writeBody', ['a.md', 'b']],
        ['memory:createFolder', { parent: 'p', name: 'n' }, 'createFolder', ['p', 'n']],
        ['memory:rename', { path: 'a.md', title: 't' }, 'rename', ['a.md', 't']],
        ['memory:move', { path: 'a.md', folder: 'f' }, 'move', ['a.md', 'f']],
        ['memory:moveFolder', { folder: 'f', into: 'g' }, 'moveFolder', ['f', 'g']],
        ['memory:link', { from: 'a.md', to: 'b.md' }, 'link', ['a.md', 'b.md']],
        ['memory:unlink', { from: 'a.md', to: 'b.md' }, 'unlink', ['a.md', 'b.md']],
        ['memory:setVault', { path: '/v' }, 'setVault', ['/v']],
        ['memory:daily', { now: '2026-10-15' }, 'daily', ['2026-10-15']],
        ['memory:daily', undefined, 'daily', [undefined]],
        ['memory:setDailyNotes', { folder: 'Daily', template: '' }, 'setDailyNotes', [{ folder: 'Daily', template: '' }]],
        ['memory:renderTemplate', { path: 'T/x.md', title: 't', now: '2026-10-15T09:00:00' }, 'renderTemplate', ['T/x.md', 't', '2026-10-15T09:00:00']],
        ['memory:attach', { name: ' a.png ', data: 'AAAA' }, 'attach', ['a.png', 'AAAA']],
        ['memory:attachment', { target: 'a.png', from: 'n.md' }, 'attachment', ['a.png', 'n.md']]
      ]
    ],
    [
      'terminal',
      registerTerminalIpc,
      [
        ['terminal:create', { projectId: 'p' }, 'create', [{ projectId: 'p' }]],
        ['terminal:create', undefined, 'create', [{}]],
        ['terminal:create', { cols: 80, rows: 24 }, 'create', [{ cols: 80, rows: 24 }]],
        ['terminal:list', undefined, 'list', []],
        ['terminal:attach', { id: 'i' }, 'attach', ['i']],
        ['terminal:write', { id: 'i', data: 'ls' }, 'write', ['i', 'ls']],
        ['terminal:resize', { id: 'i', cols: 80, rows: 24 }, 'resize', ['i', 80, 24]],
        ['terminal:kill', { id: 'i' }, 'kill', ['i']],
        ['terminal:create', { profileId: 'zsh' }, 'create', [{ profileId: 'zsh' }]],
        ['terminal:shells', undefined, 'shells', []],
        ['terminal:settings', undefined, 'settings', []],
        ['terminal:configure', { fontSize: 14, profiles: [] }, 'configure', [{ fontSize: 14, profiles: [] }]],
        [
          'terminal:persist',
          { layout: 'single', active: 0, tabs: [{ title: '~', cwd: '/h', scrollback: '' }], savedAt: 'now' },
          'persist',
          [{ layout: 'single', active: 0, tabs: [{ title: '~', cwd: '/h', scrollback: '' }], savedAt: 'now' }]
        ],
        ['terminal:restore', undefined, 'restore', []]
      ]
    ],
    [
      'files',
      registerFilesIpc,
      [
        ['files:list', { projectId: 'p' }, 'list', ['p', undefined]],
        ['files:list', { projectId: 'p', dir: 'src' }, 'list', ['p', 'src']],
        ['files:read', { projectId: 'p', path: 'a.ts' }, 'read', ['p', 'a.ts']],
        ['files:stat', { projectId: 'p', paths: ['a.ts'] }, 'stat', ['p', ['a.ts']]],
        ['files:write', { projectId: 'p', path: 'a.ts', content: 'x' }, 'write', ['p', 'a.ts', 'x', undefined]],
        ['files:write', { projectId: 'p', path: 'a.ts', content: 'x', expectedMtime: 5 }, 'write', ['p', 'a.ts', 'x', 5]],
        ['files:create', { projectId: 'p', path: 'a', kind: 'dir' }, 'create', ['p', 'a', 'dir']],
        ['files:rename', { projectId: 'p', from: 'a', to: 'b' }, 'rename', ['p', 'a', 'b']],
        ['files:delete', { projectId: 'p', path: 'a' }, 'remove', ['p', 'a']]
      ]
    ],
    [
      'scm',
      registerScmIpc,
      [
        ['scm:status', { projectId: 'p' }, 'status', ['p']],
        ['scm:init', { projectId: 'p' }, 'init', ['p']],
        ['scm:stage', { projectId: 'p', paths: ['a'] }, 'stage', ['p', ['a']]],
        ['scm:unstage', { projectId: 'p', paths: ['a'] }, 'unstage', ['p', ['a']]],
        ['scm:discard', { projectId: 'p', paths: ['a'] }, 'discard', ['p', ['a']]],
        ['scm:commit', { projectId: 'p', message: 'm', amend: true, all: false }, 'commit', ['p', 'm', { amend: true, all: false }]],
        ['scm:fetch', { projectId: 'p' }, 'fetch', ['p']],
        ['scm:pull', { projectId: 'p' }, 'pull', ['p']],
        ['scm:push', { projectId: 'p' }, 'push', ['p']],
        ['scm:branches', { projectId: 'p' }, 'branches', ['p']],
        ['scm:checkout', { projectId: 'p', name: 'main' }, 'checkout', ['p', 'main']],
        ['scm:createBranch', { projectId: 'p', name: 'x' }, 'createBranch', ['p', 'x']],
        ['scm:log', { projectId: 'p', limit: 5 }, 'log', ['p', 5]],
        ['scm:show', { projectId: 'p', hash: 'abcd' }, 'show', ['p', 'abcd']],
        ['scm:diff', { projectId: 'p', path: 'a', target: { kind: 'staged' } }, 'diff', ['p', 'a', { kind: 'staged' }]],
        ['scm:original', { projectId: 'p', path: 'a' }, 'original', ['p', 'a']],
        ['scm:files', { projectId: 'p' }, 'files', ['p']],
        ['scm:abort', { projectId: 'p' }, 'abort', ['p']],
        ['scm:continue', { projectId: 'p' }, 'continue', ['p']],
        ['scm:stashes', { projectId: 'p' }, 'stashes', ['p']],
        ['scm:stash', { projectId: 'p', message: 'm', untracked: true }, 'stash', ['p', { message: 'm', untracked: true }]],
        ['scm:applyStash', { projectId: 'p', hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pop: true }, 'applyStash', ['p', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true]],
        ['scm:dropStash', { projectId: 'p', hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'dropStash', ['p', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']],
        ['scm:stashFiles', { projectId: 'p', hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'stashFiles', ['p', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']],
        ['scm:blame', { projectId: 'p', path: 'a', text: 't' }, 'blame', ['p', 'a', 't']]
      ]
    ],
    [
      'search',
      registerSearchIpc,
      [
        ['search:start', { id: 'i', projectId: 'p', query: { pattern: 'x', include: ['src'] } }, 'start', ['i', 'p', { pattern: 'x', include: ['src'] }, undefined]],
        ['search:cancel', { id: 'i' }, 'cancel', ['i', undefined]]
      ]
    ],
    [
      'lsp',
      registerLspIpc,
      [
        ['lsp:open', { projectId: 'p', path: 'a.ts', text: 'x' }, 'open', ['p', 'a.ts', 'x']],
        ['lsp:change', { projectId: 'p', path: 'a.ts', text: 'x' }, 'change', ['p', 'a.ts', 'x']],
        ['lsp:close', { projectId: 'p', path: 'a.ts' }, 'close', ['p', 'a.ts']],
        ['lsp:diagnostics', { projectId: 'p', paths: ['a.ts'] }, 'diagnostics', ['p', ['a.ts']]],
        ['lsp:hover', { projectId: 'p', path: 'a.ts', line: 1, offset: 2 }, 'hover', ['p', 'a.ts', 1, 2]],
        ['lsp:completions', { projectId: 'p', path: 'a.ts', line: 1, offset: 2, trigger: '.' }, 'completions', ['p', 'a.ts', 1, 2, '.']],
        ['lsp:completionDetails', { projectId: 'p', path: 'a.ts', line: 1, offset: 2, name: 'n', source: 's', data: { d: 1 } }, 'completionDetails', ['p', 'a.ts', 1, 2, 'n', 's', { d: 1 }]],
        ['lsp:definition', { projectId: 'p', path: 'a.ts', line: 1, offset: 2 }, 'definition', ['p', 'a.ts', 1, 2]],
        ['lsp:references', { projectId: 'p', path: 'a.ts', line: 1, offset: 2 }, 'references', ['p', 'a.ts', 1, 2]],
        ['lsp:rename', { projectId: 'p', path: 'a.ts', line: 1, offset: 2, newName: 'b' }, 'rename', ['p', 'a.ts', 1, 2, 'b']],
        ['lsp:signature', { projectId: 'p', path: 'a.ts', line: 1, offset: 2 }, 'signature', ['p', 'a.ts', 1, 2]],
        [
          'lsp:codeFixes',
          { projectId: 'p', path: 'a.ts', range: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 2 } }, errorCodes: [2304] },
          'codeFixes',
          ['p', 'a.ts', { start: { line: 1, offset: 1 }, end: { line: 1, offset: 2 } }, [2304]]
        ],
        ['lsp:symbols', { projectId: 'p', path: 'a.py' }, 'symbols', ['p', 'a.py']]
      ]
    ],
    [
      'tools',
      registerToolsIpc,
      [
        ['tools:status', undefined, 'status', []],
        ['tools:install', { id: 'python', part: 'server' }, 'install', ['python', 'server']],
        ['tools:runtimes', undefined, 'runtimes', []]
      ]
    ],
    [
      'migrate',
      registerMigrateIpc,
      [
        ['migrate:scan', undefined, 'scan', []],
        ['migrate:apply', { app: 'Code' }, 'apply', ['Code']],
        ['editor:settings', undefined, 'editor', []],
        ['editor:update', { prettier: true }, 'updateEditor', [{ prettier: true }]]
      ]
    ],
    [
      'live',
      (router: Router, svc: never) => registerLiveIpc(router, svc, svc),
      [
        ['liveServer:status', undefined, 'status', []],
        ['liveServer:start', { projectId: 'p', page: 'index.html' }, 'start', ['p', 'index.html']],
        ['liveServer:stop', { projectId: 'p' }, 'stop', ['p']],
        ['sass:compile', { projectId: 'p', path: 'a.scss' }, 'compile', ['p', 'a.scss']],
        ['sass:compileAll', { projectId: 'p' }, 'compileAll', ['p']]
      ]
    ],
    [
      'sftp',
      registerSftpIpc,
      [
        ['sftp:targets', { projectId: 'p' }, 'targets', ['p']],
        ['sftp:list', { projectId: 'p', target: 'T', dir: 'css' }, 'list', ['p', 'T', 'css']],
        ['sftp:upload', { projectId: 'p', target: 'T', paths: ['a'] }, 'upload', ['p', 'T', ['a']]],
        ['sftp:download', { projectId: 'p', target: 'T', paths: ['a'] }, 'download', ['p', 'T', ['a']]],
        ['sftp:sync', { projectId: 'p', target: 'T', direction: 'up' }, 'sync', ['p', 'T', 'up']]
      ]
    ],
    [
      'github',
      registerGitHubIpc,
      [
        ['github:status', { projectId: 'p' }, 'status', ['p']],
        ['github:list', { projectId: 'p', filter: 'mine', state: 'all' }, 'list', ['p', 'mine', 'all']],
        ['github:view', { projectId: 'p', number: 8 }, 'view', ['p', 8]],
        ['github:fileDiff', { projectId: 'p', number: 8, path: 'a.ts' }, 'fileDiff', ['p', 8, 'a.ts']],
        ['github:checkout', { projectId: 'p', number: 8 }, 'checkout', ['p', 8]],
        ['github:create', { projectId: 'p', title: 'T', body: 'B', base: 'main', draft: true }, 'create', ['p', { title: 'T', body: 'B', base: 'main', draft: true }]],
        ['github:merge', { projectId: 'p', number: 8, method: 'squash', deleteBranch: true }, 'merge', ['p', 8, 'squash', true]],
        ['github:comment', { projectId: 'p', number: 8, body: 'hi' }, 'comment', ['p', 8, 'hi']],
        ['github:review', { projectId: 'p', number: 8, action: 'approve', body: '' }, 'review', ['p', 8, 'approve', '']]
      ]
    ],
    [
      'mongo',
      registerMongoIpc,
      [
        ['mongo:connections', undefined, 'connections', []],
        ['mongo:add', { name: 'N', uri: 'mongodb://localhost' }, 'add', ['N', 'mongodb://localhost']],
        ['mongo:remove', { id: 'c' }, 'remove', ['c']],
        ['mongo:databases', { id: 'c' }, 'databases', ['c']],
        ['mongo:collections', { id: 'c', db: 'd' }, 'collections', ['c', 'd']],
        ['mongo:createCollection', { id: 'c', db: 'd', name: 'n' }, 'createCollection', ['c', 'd', 'n']],
        ['mongo:dropCollection', { id: 'c', db: 'd', name: 'n' }, 'dropCollection', ['c', 'd', 'n']],
        ['mongo:find', { id: 'c', db: 'd', collection: 'u', query: { limit: 5 } }, 'find', ['c', 'd', 'u', { limit: 5 }]],
        ['mongo:insert', { id: 'c', db: 'd', collection: 'u', document: '{}' }, 'insert', ['c', 'd', 'u', '{}']],
        ['mongo:replace', { id: 'c', db: 'd', collection: 'u', docId: '1', document: '{}' }, 'replace', ['c', 'd', 'u', '1', '{}']],
        ['mongo:delete', { id: 'c', db: 'd', collection: 'u', docId: '1' }, 'delete', ['c', 'd', 'u', '1']],
        ['mongo:aggregate', { id: 'c', db: 'd', collection: 'u', pipeline: '[]' }, 'aggregate', ['c', 'd', 'u', '[]']],
        ['mongo:indexes', { id: 'c', db: 'd', collection: 'u' }, 'indexes', ['c', 'd', 'u']]
      ]
    ],
    [
      'lint',
      registerLintIpc,
      [
        ['lint:file', { projectId: 'p', path: 'a.js', text: 'x' }, 'lint', ['p', 'a.js', 'x']],
        ['lint:fix', { projectId: 'p', path: 'a.js', text: 'x' }, 'fix', ['p', 'a.js', 'x']],
        ['lint:restart', undefined, 'restart', []],
        ['format:document', { projectId: 'p', path: 'a.js', text: 'x', prettier: true, options: { semi: false } }, 'format', ['p', 'a.js', 'x', { prettier: true, options: { semi: false } }]]
      ]
    ],
    [
      'notebook',
      registerNotebookIpc,
      [
        ['notebook:kernels', { projectId: 'p' }, 'kernels', ['p']],
        ['notebook:setup', { projectId: 'p' }, 'setup', ['p']],
        ['notebook:start', { projectId: 'p', path: 'a.ipynb', kernel: 'python3' }, 'start', ['p', 'a.ipynb', 'python3']],
        ['notebook:execute', { projectId: 'p', path: 'a.ipynb', cell: 'c1', code: 'x' }, 'execute', ['p', 'a.ipynb', 'c1', 'x']],
        ['notebook:interrupt', { projectId: 'p', path: 'a.ipynb' }, 'interrupt', ['p', 'a.ipynb']],
        ['notebook:restart', { projectId: 'p', path: 'a.ipynb' }, 'restart', ['p', 'a.ipynb']],
        ['notebook:shutdown', { projectId: 'p', path: 'a.ipynb' }, 'shutdown', ['p', 'a.ipynb']]
      ]
    ],
    [
      'tests',
      registerTestsIpc,
      [
        ['tests:discover', { projectId: 'p' }, 'discover', ['p']],
        ['tests:state', { projectId: 'p' }, 'state', ['p']],
        ['tests:run', { projectId: 'p', id: 'a.test.ts' }, 'run', ['p', 'a.test.ts']],
        ['tests:cancel', { projectId: 'p' }, 'cancel', ['p']],
        ['tests:debug', { projectId: 'p', id: 'a.test.ts', breakpoints: [] }, 'debug', ['p', 'a.test.ts', []]]
      ]
    ],
    [
      'remote',
      (router: Router, svc: never) => registerRemoteIpc(router, svc, (id) => (id === 'p' ? '/p' : undefined)),
      [
        ['remote:hosts', undefined, 'hosts', []],
        ['remote:list', undefined, 'list', []],
        ['remote:ssh', { target: 'robin@box:2222' }, 'ssh', ['robin@box:2222']],
        ['remote:container', { projectId: 'p' }, 'container', ['/p']],
        ['remote:hasContainer', { projectId: 'p' }, 'hasContainer', ['/p']],
        ['remote:disconnect', { id: 'ssh:box' }, 'disconnect', ['ssh:box']]
      ]
    ],
    [
      'debug',
      registerDebugIpc,
      [
        ['debug:start', { projectId: 'p', program: 'a.js', breakpoints: [] }, 'start', [{ projectId: 'p', program: 'a.js', breakpoints: [] }]],
        ['debug:stop', undefined, 'stop', []],
        ['debug:session', undefined, 'session', []],
        ['debug:control', { action: 'stepOver' }, 'control', ['stepOver']],
        ['debug:setBreakpoints', { projectId: 'p', breakpoints: [{ path: 'a.js', line: 2 }] }, 'setBreakpoints', ['p', [{ path: 'a.js', line: 2 }]]],
        ['debug:variables', { objectId: 'o' }, 'variables', ['o']],
        ['debug:evaluate', { expression: 'x', frameId: 'f' }, 'evaluate', ['x', 'f']]
      ]
    ],
    [
      'agents',
      registerAgentsIpc,
      [
        ['agents:detect', undefined, 'detect', []],
        ['agents:list', undefined, 'list', []],
        ['agents:get', { id: 'i' }, 'get', ['i']],
        ['agents:create', { kind: 'claude-code', projectId: 'p', isolated: true }, 'create', [{ kind: 'claude-code', projectId: 'p', isolated: true }]],
        ['agents:send', { id: 'i', text: 'hi' }, 'send', ['i', 'hi', {}]],
        ['agents:send', { id: 'i', text: '', refs: [{ kind: 'file', path: 'a.ts' }] }, 'send', ['i', '', { refs: [{ kind: 'file', path: 'a.ts' }] }]],
        ['agents:configure', { id: 'i', model: 'opus' }, 'configure', ['i', { model: 'opus' }]],
        ['agents:pushSettings', undefined, 'settings', []],
        ['agents:setPushSettings', { enabled: false }, 'configure', [false]],
        ['agents:interrupt', { id: 'i' }, 'interrupt', ['i']],
        ['agents:stop', { id: 'i' }, 'stop', ['i']],
        ['agents:resume', { id: 'i' }, 'resume', ['i']],
        ['agents:remove', { id: 'i' }, 'remove', ['i']],
        ['agents:changes', { id: 'i' }, 'changes', ['i']],
        ['agents:branch', { id: 'i' }, 'branch', ['i']],
        ['agents:diff', { id: 'i', path: 'a.ts' }, 'diff', ['i', 'a.ts']],
        ['agents:accept', { id: 'i' }, 'accept', ['i']],
        ['agents:discard', { id: 'i' }, 'discard', ['i']],
        ['agents:rename', { id: 'i', title: 'Fix login' }, 'rename', ['i', 'Fix login']],
        ['agents:shell', { id: 'i' }, 'shell', ['i']],
        ['agents:openInEditor', { id: 'i' }, 'openInEditor', ['i']]
      ]
    ]
  ] as const)('%s', async (_name, register, cases) => {
    const service = spyService()
    const router = new Router()
    // Registrations with a second service (the agents' pushes) get the same spy.
    ;(register as (r: Router, s: unknown, s2: unknown) => void)(router, service, service)
    for (const [channel, req, method, args] of cases) {
      expect(await router.dispatch(channel, req, { transport: 'ipc' })).toEqual({ ok: true, data: { method, args } })
    }
  })
})

describe('paths', () => {
  it('puts everything under ~/Mindeck unless MINDECK_HOME overrides it; a former ~/W-ONE stays in use until ~/Mindeck exists', async () => {
    const saved = process.env.MINDECK_HOME
    const home = await tempDir()
    try {
      delete process.env.MINDECK_HOME
      expect(mindeckPaths(home)).toEqual({
        homeDir: join(home, 'Mindeck'),
        dataDir: join(home, 'Mindeck', 'data'),
        settingsFile: join(home, 'Mindeck', 'data', 'settings.json'),
        defaultVaultRoot: join(home, 'Mindeck', 'vault'),
        devicesFile: join(home, 'Mindeck', 'data', 'devices.json'),
        tlsDir: join(home, 'Mindeck', 'data', 'tls'),
        secretsFile: join(home, 'Mindeck', 'data', 'secrets.json'),
        cloudFile: join(home, 'Mindeck', 'data', 'cloud.json'),
        grantsFile: join(home, 'Mindeck', 'data', 'grants.json'),
        eventsFile: join(home, 'Mindeck', 'data', 'events.jsonl'),
        runsFile: join(home, 'Mindeck', 'data', 'runs.json'),
        agentsDir: join(home, 'Mindeck', 'data', 'agents'),
        worktreesDir: join(home, 'Mindeck', 'worktrees'),
        logsDir: join(home, 'Mindeck', 'logs')
      })
      // Data from before the rename: used where it is.
      await mkdir(join(home, 'W-ONE'))
      expect(mindeckPaths(home).homeDir).toBe(join(home, 'W-ONE'))
      // Moved over (or both there): ~/Mindeck.
      await mkdir(join(home, 'Mindeck'))
      expect(mindeckPaths(home).homeDir).toBe(join(home, 'Mindeck'))
      expect(mindeckPaths().homeDir.startsWith(homedir())).toBe(true)
      process.env.MINDECK_HOME = '/custom'
      expect(mindeckPaths().dataDir).toBe(join('/custom', 'data'))
    } finally {
      if (saved === undefined) delete process.env.MINDECK_HOME
      else process.env.MINDECK_HOME = saved
    }
  })

  it('copies the legacy data folder once and leaves a note in the original', async () => {
    const dir = await tempDir()
    const legacy = join(dir, 'userData', 'mindeck')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'projects.json'), '{"projects":[]}')
    const paths = { ...mindeckPaths(), homeDir: join(dir, 'Mindeck'), dataDir: join(dir, 'Mindeck', 'data') }

    expect(migrateLegacyData(paths, legacy)).toBe(true)
    expect(await readFile(join(paths.dataDir, 'projects.json'), 'utf8')).toBe('{"projects":[]}')
    expect(existsSync(join(legacy, 'MOVED-TO-Mindeck-DATA.txt'))).toBe(true)
    expect(existsSync(join(legacy, 'projects.json'))).toBe(true) // original untouched

    expect(migrateLegacyData(paths, legacy)).toBe(false) // already migrated
    expect(migrateLegacyData({ ...paths, dataDir: join(dir, 'other') }, join(dir, 'missing'))).toBe(false)
  })
})

describe('preload bridge', () => {
  it('exposes window controls, the allowlisted invoke/on, and the platform', async () => {
    await import('../../../electron/preload')
    const api = electron.exposed.mindeck as Record<string, (...a: unknown[]) => unknown>
    expect(api.platform).toBe(process.platform)

    api.minimize()
    api.toggleMaximize()
    api.close()
    api.toggleFullScreen()
    expect(electron.ipcRenderer.send.mock.calls.map((c) => c[0])).toEqual(['window:minimize', 'window:toggle-maximize', 'window:close', 'window:toggle-fullscreen'])
    api.startDrag(['/a', '/b'])
    expect(electron.ipcRenderer.send).toHaveBeenLastCalledWith('files:start-drag', ['/a', '/b'])
    expect(api.pathForFile({ name: 'x.png' })).toBe('/dropped/x.png')

    await api.isMaximized()
    await api.isFullScreen()
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('window:is-maximized')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('window:is-fullscreen')

    expect(await api.invoke('projects:list', { x: 1 })).toEqual({ invoked: ['projects:list', { x: 1 }] })
    await expect(api.invoke('evil:channel')).rejects.toThrow('Blocked IPC channel: evil:channel')
    expect(() => api.on('evil:event', () => {})).toThrow('Blocked IPC event: evil:event')
  })

  it('forwards push events without the IPC event object and unsubscribes cleanly', async () => {
    await import('../../../electron/preload')
    const api = electron.exposed.mindeck as Record<string, (...a: unknown[]) => unknown>
    const emit = (ch: string, ...args: unknown[]) => [...(electron.rendererListeners.get(ch) ?? [])].forEach((l) => l({}, ...args))

    for (const [method, channel] of [
      ['onMaximizedChange', 'window:maximized-changed'],
      ['onFullScreenChange', 'window:fullscreen-changed'],
      ['on', 'system:tick']
    ] as const) {
      const cb = vi.fn()
      const off = (method === 'on' ? api.on(channel, cb) : api[method](cb)) as () => void
      emit(channel, true)
      expect(cb).toHaveBeenCalledWith(true)
      off()
      emit(channel, false)
      expect(cb).toHaveBeenCalledTimes(1)
    }
  })
})
