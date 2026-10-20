import { EventEmitter } from 'node:events'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { FrameReader, frame, LspClient, type RpcProcess } from '../../../electron/main/services/lsp/LspClient'
import { documentLanguage, GenericBackend, markdown, spawnServer } from '../../../electron/main/services/lsp/GenericBackend'
import { LspService } from '../../../electron/main/services/lsp/LspService'
import { LANGUAGES, languageOf, isTypeScriptFile } from '@shared/types/languages'
import { shellArgs } from '../../../electron/main/lib/shellArgs'
import { CATALOG, javaDebugJar } from '../../../electron/main/services/tools/catalog'

const FAKE_LSP = join(__dirname, 'fixtures', 'fake-lsp.mjs')

type Msg = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }
type Handler = (params: never, server: FakeServer) => unknown

/** A scripted language server: answers requests by method, records everything the editor sent. */
class FakeServer extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  received: Msg[] = []
  killed = false
  constructor(public handlers: Record<string, Handler> = {}) {
    super()
    const reader = new FrameReader((m) => void this.receive(m as Msg))
    this.stdin.on('data', (d: Buffer) => reader.push(d))
  }
  private async receive(m: Msg) {
    this.received.push(m)
    if (m.id === undefined || m.method === undefined) return
    const handler = this.handlers[m.method] ?? (() => null)
    try {
      this.send({ jsonrpc: '2.0', id: m.id, result: await handler(m.params as never, this) })
    } catch (err) {
      this.send({ jsonrpc: '2.0', id: m.id, error: { code: 1, message: (err as Error).message } })
    }
  }
  send(msg: unknown) {
    this.stdout.write(frame(msg))
  }
  notifications(method: string) {
    return this.received.filter((m) => m.method === method && m.id === undefined).map((m) => m.params)
  }
  kill() {
    this.killed = true
    this.emit('exit')
    return true
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
const pos = (line: number, character: number) => ({ line, character })
const lsRange = (l1: number, c1: number, l2: number, c2: number) => ({ start: pos(l1, c1), end: pos(l2, c2) })
const range = (l1: number, o1: number, l2: number, o2: number) => ({ start: { line: l1, offset: o1 }, end: { line: l2, offset: o2 } })

async function setup(handlers: Record<string, Handler> = {}, opts: { languages?: string[]; trusted?: (id: string) => boolean } = {}) {
  const root = await tempDir('mindeck-ls-')
  await mkdir(join(root, 'src'))
  for (const f of ['src/a.py', 'src/b.py', 'main.go', 'Dockerfile', 'notes.txt']) await writeFile(join(root, f), '')
  const real = await realpath(root)
  const servers: FakeServer[] = []
  const pushed: string[] = []
  const spawned: { command: string; args: string[]; cwd: string }[] = []
  const backend = new GenericBackend({
    resolveRoot: (id) => (id.startsWith('p') ? root : undefined),
    trusted: (id) => opts.trusted?.(id) ?? true,
    tools: { dir: '/tools', locate: async (id) => ((opts.languages ?? ['python', 'dockerfile']).includes(id) ? `/bin/${id}-ls` : undefined) },
    spawn: (command, args, cwd) => {
      spawned.push({ command, args, cwd })
      const s = new FakeServer({ initialize: () => ({ capabilities: { completionProvider: { resolveProvider: true } } }), ...handlers })
      servers.push(s)
      return s as unknown as RpcProcess
    },
    onDiagnostics: ({ projectId }) => pushed.push(projectId),
    timeoutMs: 200
  })
  const uri = (rel: string) => pathToFileURL(join(real, rel)).href
  return { root: real, backend, servers, pushed, spawned, uri }
}

describe('the user’s shell', () => {
  it('runs a command line as a login shell (becoming the command), PowerShell on Windows', () => {
    expect(shellArgs('a b')).toEqual(process.platform === 'win32' ? ['-NoLogo', '-Command', 'a b'] : ['-lc', 'exec a b'])
    expect(shellArgs('a b', 'linux', false)).toEqual(['-lc', 'a b'])
    expect(shellArgs('a b', 'win32')).toEqual(['-NoLogo', '-Command', 'a b'])
  })
})

describe('the language registry', () => {
  it('finds a file’s language by ending or name; TypeScript stays with tsserver', () => {
    expect(languageOf('src/app.PY')?.id).toBe('python')
    expect(languageOf('a/Dockerfile')?.id).toBe('dockerfile')
    expect(languageOf('Gemfile')?.id).toBe('ruby')
    expect(languageOf('.bashrc')).toBeUndefined()
    expect(languageOf('README')).toBeUndefined()
    expect([isTypeScriptFile('a/b.tsx'), isTypeScriptFile('x.MJS'), isTypeScriptFile('a.py'), isTypeScriptFile('.ts')]).toEqual([true, true, false, false])
    expect(new Set(LANGUAGES.map((l) => l.id)).size).toBe(LANGUAGES.length)
  })

  it('servers get the languageId they expect; hovers become markdown', () => {
    const lang = (id: string) => LANGUAGES.find((l) => l.id === id)!
    expect(['a.c', 'a.h', 'a.m', 'a.mm', 'a.cpp'].map((p) => documentLanguage(p, lang('cpp')))).toEqual(['c', 'c', 'objective-c', 'objective-cpp', 'cpp'])
    expect(documentLanguage('a.sh', lang('shell'))).toBe('shellscript')
    expect(documentLanguage('a.py', lang('python'))).toBe('python')
    expect(markdown(null)).toBe('')
    expect(markdown('plain')).toBe('plain')
    expect(markdown({ kind: 'markdown', value: '**b**' })).toBe('**b**')
    expect(markdown({ language: 'go', value: 'func x()' })).toBe('```go\nfunc x()\n```')
    expect(markdown(['a', '', { kind: 'plaintext', value: 'c' }])).toBe('a\n\nc')
  })
})

describe('LspClient', () => {
  it('requests and answers, notifications both ways, the server’s own requests', async () => {
    const server = new FakeServer({ echo: (p) => p, fail: () => Promise.reject(new Error('nope')) })
    const notes: unknown[] = []
    const client = new LspClient(server as unknown as RpcProcess, {
      onNotification: (method, params) => notes.push([method, params]),
      onRequest: (method) => {
        if (method === 'ask') return { ok: true }
        if (method === 'void') return undefined
        throw new Error('unknown')
      }
    })
    expect(await client.request('echo', { a: 1 })).toEqual({ a: 1 })
    await expect(client.request('fail', null)).rejects.toMatchObject({ code: 'lsp', message: 'nope' })
    client.notify('ping', { x: 1 })
    server.send({ jsonrpc: '2.0', method: 'note', params: 7 })
    server.send({ jsonrpc: '2.0', id: 99, result: 'nobody asked' })
    server.send({ jsonrpc: '2.0', id: 'r1', method: 'ask', params: {} })
    server.send({ jsonrpc: '2.0', id: 'r2', method: 'void', params: {} })
    server.send({ jsonrpc: '2.0', id: 'r3', method: 'other', params: {} })
    await tick()
    expect(notes).toEqual([['note', 7]])
    const replies = server.received.filter((m) => m.method === undefined).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    expect(replies).toEqual([
      { jsonrpc: '2.0', id: 'r1', result: { ok: true } },
      { jsonrpc: '2.0', id: 'r2', result: null },
      { jsonrpc: '2.0', id: 'r3', error: { code: -32601, message: 'unknown' } }
    ])
    expect(server.notifications('ping')).toEqual([{ x: 1 }])
  })

  it('without handlers, timeouts, a server that exits, shutting down', async () => {
    const quiet = new FakeServer({ slow: () => new Promise(() => {}) })
    const client = new LspClient(quiet as unknown as RpcProcess, { timeoutMs: 30 })
    quiet.send({ jsonrpc: '2.0', method: 'note' }) // no notification handler
    quiet.send({ jsonrpc: '2.0', id: 1, method: 'ask' }) // no request handler: refused
    await tick()
    expect(quiet.received.find((m) => m.id === 1)).toMatchObject({ error: { code: -32601 } })
    await expect(client.request('slow', null)).rejects.toMatchObject({ code: 'lsp-timeout' })
    await expect(client.request('slow', null, 5)).rejects.toMatchObject({ code: 'lsp-timeout' })

    const pending = client.request('slow', null, 10_000)
    quiet.emit('error', new Error('gone'))
    await expect(pending).rejects.toMatchObject({ code: 'lsp-stopped' })
    expect(client.running).toBe(false)
    await expect(client.request('x', null)).rejects.toMatchObject({ code: 'lsp-stopped' })
    client.notify('x', null) // ignored
    await client.dispose() // already stopped

    let exited = 0
    const server = new FakeServer()
    const graceful = new LspClient(server as unknown as RpcProcess, { onExit: () => (exited += 1) })
    // A reply the server sends after it stopped is not answered any more.
    server.send({ jsonrpc: '2.0', id: 5, method: 'late' })
    await graceful.dispose()
    expect(server.received.map((m) => m.method)).toContain('shutdown')
    expect(server.notifications('exit')).toEqual([null])
    expect(server.killed).toBe(true)
    expect(exited).toBe(1)
    server.emit('exit')
    expect(exited).toBe(1)

    // A server that refuses to shut down is ended all the same.
    const stubborn = new FakeServer({ shutdown: () => Promise.reject(new Error('busy')) })
    await new LspClient(stubborn as unknown as RpcProcess).dispose()
    expect(stubborn.killed).toBe(true)
  })

  it('a reply to a server request after the server stopped is dropped', async () => {
    let release!: (v: unknown) => void
    const server = new FakeServer()
    new LspClient(server as unknown as RpcProcess, { onRequest: () => new Promise((r) => (release = r)) })
    let refuse!: (e: Error) => void
    const failing = new FakeServer()
    new LspClient(failing as unknown as RpcProcess, { onRequest: () => new Promise((_r, reject) => (refuse = reject)) })
    server.send({ jsonrpc: '2.0', id: 1, method: 'slow' })
    failing.send({ jsonrpc: '2.0', id: 1, method: 'slow' })
    await tick()
    failing.received = []
    server.emit('exit')
    failing.emit('exit')
    release('late')
    refuse(new Error('x')) // an error after it stopped: dropped too
    await tick()
    expect(server.received.filter((m) => m.id === 1)).toEqual([])
    expect(failing.received.filter((m) => m.id === 1)).toEqual([])
  })

  it('frames: odd headers are skipped, broken bodies dropped, split chunks joined', () => {
    const got: unknown[] = []
    const reader = new FrameReader((m) => got.push(m))
    const good = frame({ a: 'ü' })
    reader.push(Buffer.from('X-Other: 1\r\n\r\n'))
    reader.push(good.subarray(0, 5))
    reader.push(Buffer.concat([good.subarray(5), Buffer.from('Content-Length: 3\r\n\r\n{x}')]))
    reader.push(Buffer.from('Content-Length: 10\r\n\r\n{"b"'))
    expect(got).toEqual([{ a: 'ü' }])
  })

  it('spawnServer starts the server through the user’s shell', async () => {
    const proc = spawnServer('node', ['-e', 'process.stdout.write("hi")'], await tempDir())
    let out = ''
    proc.stdout!.on('data', (d: Buffer) => (out += d.toString()))
    await new Promise((r) => proc.on('exit', r))
    expect(out).toBe('hi')
    // Windows: directly, no PowerShell in between.
    const direct = spawnServer(process.execPath, ['-e', 'process.stdout.write("direct")'], await tempDir(), 'win32')
    let got = ''
    direct.stdout!.on('data', (d: Buffer) => (got += d.toString()))
    await new Promise((r) => direct.on('exit', r))
    expect(got).toBe('direct')
  }, 20_000)
})

describe('GenericBackend', () => {
  it('starts one server per project and language: handshake, settings, document sync', async () => {
    const { backend, servers, spawned, uri, root } = await setup()
    const [a, b] = await Promise.all([backend.open('p', 'src/a.py', 'x = 1'), backend.open('p', 'src/b.py', 'y')])
    expect([a, b]).toEqual([{ available: true }, { available: true }])
    expect(servers).toHaveLength(1) // both waited for the same start
    expect(spawned[0]).toEqual({ command: '/bin/python-ls', args: ['--stdio'], cwd: root })
    const s = servers[0]
    const init = s.received.find((m) => m.method === 'initialize')!.params as Record<string, unknown>
    expect(init).toMatchObject({ rootUri: pathToFileURL(root).href, rootPath: root, clientInfo: { name: 'Mindeck' } })
    expect(s.notifications('initialized')).toEqual([{}])
    expect(s.notifications('workspace/didChangeConfiguration')[0]).toMatchObject({ settings: { python: { pythonPath: 'python3' } } })
    expect(s.notifications('textDocument/didOpen').map((p) => (p as { textDocument: { uri: string; languageId: string } }).textDocument).sort((x, y) => x.uri.localeCompare(y.uri))).toEqual([
      { uri: uri('src/a.py'), languageId: 'python', version: 1, text: 'x = 1' },
      { uri: uri('src/b.py'), languageId: 'python', version: 1, text: 'y' }
    ])

    await backend.open('p', 'src/a.py', 'x = 2') // already open: a change
    await backend.change('p', 'src/a.py', 'x = 2') // unchanged: nothing sent
    await backend.change('p', 'src/a.py', 'x = 3')
    expect(s.notifications('textDocument/didChange')).toEqual([
      { textDocument: { uri: uri('src/a.py'), version: 2 }, contentChanges: [{ text: 'x = 2' }] },
      { textDocument: { uri: uri('src/a.py'), version: 3 }, contentChanges: [{ text: 'x = 3' }] }
    ])
    await backend.close('p', 'src/a.py')
    await backend.close('p', 'src/a.py') // not open
    await backend.change('p', 'src/a.py', 'again') // closed: opens it again
    expect(s.notifications('textDocument/didClose')).toHaveLength(1)
    expect(s.notifications('textDocument/didOpen')).toHaveLength(3)

    // A Dockerfile (no settings) is its own server; languages without one, files without a language, other projects.
    expect(await backend.open('p', 'Dockerfile', 'FROM x')).toEqual({ available: true })
    expect(servers).toHaveLength(2)
    expect(servers[1].notifications('workspace/didChangeConfiguration')).toEqual([])
    expect(await backend.open('p', 'main.go', '')).toEqual({ available: false })
    expect(await backend.open('p', 'notes.txt', '')).toEqual({ available: false })
    await backend.change('q', 'src/a.py', 'x') // no session there
    await backend.close('p', 'main.go')
    await expect(backend.open('nope', 'src/a.py', '')).rejects.toMatchObject({ code: 'not-found' })
    await expect(backend.hover('p', 'main.go', 1, 1)).rejects.toMatchObject({ code: 'lsp-unavailable' })
  })

  it('a server that fails to start is no server; one that exits is started again', async () => {
    const failing = await setup({ initialize: () => Promise.reject(new Error('bad python')) })
    expect(await failing.backend.open('p', 'src/a.py', '')).toEqual({ available: false })
    expect(failing.servers[0].killed).toBe(true)

    const { backend, servers } = await setup({ initialize: () => ({}) })
    await backend.open('p', 'src/a.py', '')
    servers[0].kill()
    await backend.open('p', 'src/a.py', '')
    expect(servers).toHaveLength(2)
    servers[0].emit('exit') // a stale exit leaves the new one alone
    await backend.open('p', 'src/b.py', '')
    expect(servers).toHaveLength(2)
  })

  it('answers the server’s questions: configuration by section, workspace folders, capabilities', async () => {
    const { backend, servers, root } = await setup()
    await backend.open('p', 'src/a.py', '')
    const s = servers[0]
    s.send({ jsonrpc: '2.0', id: 1, method: 'workspace/configuration', params: { items: [{ section: 'python' }, { section: 'python.analysis' }, { section: 'python.pythonPath' }, { section: 'nope.x' }, {}] } })
    s.send({ jsonrpc: '2.0', id: 2, method: 'workspace/workspaceFolders' })
    s.send({ jsonrpc: '2.0', id: 3, method: 'client/registerCapability', params: {} })
    s.send({ jsonrpc: '2.0', id: 4, method: 'workspace/applyEdit', params: {} })
    await tick()
    const reply = (id: number) => s.received.find((m) => m.id === id && !m.method)
    expect((reply(1)!.result as unknown[]).slice(0, 4)).toEqual([{ pythonPath: 'python3' }, { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly' }, 'python3', null])
    expect((reply(1)!.result as unknown[])[4]).toMatchObject({ python: { pythonPath: 'python3' } })
    expect(reply(2)!.result).toEqual([{ uri: pathToFileURL(root).href, name: root.split('/').pop() }])
    expect(reply(3)!.result).toBeNull()
    expect(reply(4)!.error).toMatchObject({ message: 'Unsupported: workspace/applyEdit' })
  })

  it('diagnostics the server publishes: converted, reported, only for open files', async () => {
    const { backend, servers, pushed, uri } = await setup()
    await backend.open('p', 'src/a.py', '')
    servers[0].send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: uri('src/a.py'),
        diagnostics: [
          { range: lsRange(0, 0, 0, 3), message: 'bad', severity: 1, code: 'reportX', source: 'Pyright' },
          { range: lsRange(1, 0, 1, 1), message: 'unused', severity: 4, tags: [1] },
          { range: lsRange(2, 0, 2, 1), message: 'old', severity: 2, tags: [2] },
          { range: lsRange(3, 0, 3, 1), message: 'info', severity: 3 },
          { range: lsRange(4, 0, 4, 1), message: 'none' },
          { range: lsRange(5, 0, 5, 1), message: 'odd', severity: 9 }
        ]
      }
    })
    servers[0].send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'untitled:1', diagnostics: [] } })
    servers[0].send({ jsonrpc: '2.0', method: 'window/logMessage', params: {} })
    await tick()
    expect(pushed).toEqual(['p'])
    const diags = await backend.diagnostics('p', ['src/a.py', 'src/b.py', 'main.go'])
    expect(Object.keys(diags)).toEqual(['src/a.py'])
    expect(diags['src/a.py'].map((d) => `${d.severity}|${d.code ?? ''}|${d.source}|${d.unnecessary ?? ''}|${d.deprecated ?? ''}`)).toEqual([
      'error|reportX|Pyright||',
      'suggestion||Pyright|true|',
      'warning||Pyright||true',
      'info||Pyright||',
      'error||Pyright||',
      'error||Pyright||'
    ])
    expect(diags['src/a.py'][0].range).toEqual(range(1, 1, 1, 4))
    await backend.open('p', 'src/b.py', '')
    expect((await backend.diagnostics('p', ['src/b.py']))['src/b.py']).toEqual([]) // nothing published yet
    await backend.close('p', 'src/a.py')
    expect(await backend.diagnostics('p', ['src/a.py'])).toEqual({})
  })

  it('hover, completions with details, signatures', async () => {
    let hover: unknown = { contents: { kind: 'markdown', value: '**x**' }, range: lsRange(0, 0, 0, 1) }
    let items: unknown = { items: [{ label: 'one', kind: 3, detail: '() -> int', textEdit: { range: lsRange(0, 0, 0, 2), newText: 'one()' }, insertTextFormat: 2 }] }
    let sig: unknown = { signatures: [{ label: 'f(a, b)', documentation: 'F', parameters: [{ label: [2, 3] }, { label: 'b', documentation: { kind: 'markdown', value: 'B' } }], activeParameter: 1 }] }
    const { backend, servers } = await setup({
      'textDocument/hover': () => hover,
      'textDocument/completion': () => items,
      'completionItem/resolve': (item: { label: string }) => (item.label === 'boom' ? Promise.reject(new Error('x')) : { ...item, documentation: 'Docs', additionalTextEdits: [{ range: lsRange(0, 0, 0, 0), newText: 'import x\n' }] }),
      'textDocument/signatureHelp': () => sig
    })
    await backend.open('p', 'src/a.py', '')
    expect(await backend.hover('p', 'src/a.py', 1, 2)).toEqual({ display: '', documentation: '', markdown: '**x**', range: range(1, 1, 1, 2) })
    expect(servers[0].received.find((m) => m.method === 'textDocument/hover')!.params).toMatchObject({ position: { line: 0, character: 1 } })
    hover = { contents: 'plain' }
    expect((await backend.hover('p', 'src/a.py', 1, 1))?.range).toBeUndefined()
    hover = { contents: [] }
    expect(await backend.hover('p', 'src/a.py', 1, 1)).toBeNull()
    hover = null
    expect(await backend.hover('p', 'src/a.py', 1, 1)).toBeNull()

    const [one] = await backend.completions('p', 'src/a.py', 1, 3, '.')
    expect(one).toMatchObject({ name: 'one', kind: 'function', sortText: 'one', insertText: 'one()', snippet: true, replacement: range(1, 1, 1, 3), detail: '() -> int' })
    expect(servers[0].received.find((m) => m.method === 'textDocument/completion')!.params).toMatchObject({ context: { triggerKind: 2, triggerCharacter: '.' } })
    items = [{ label: 'two', kind: 99, sortText: '0', insertText: 'two', textEdit: { insert: lsRange(0, 1, 0, 2), replace: lsRange(0, 1, 0, 4), newText: 'two' } }, { label: 'plain' }]
    const [two, plain] = await backend.completions('p', 'src/a.py', 1, 3)
    expect(two).toMatchObject({ kind: 'text', sortText: '0', replacement: range(1, 2, 1, 3) })
    expect(plain).toMatchObject({ insertText: undefined, snippet: undefined, replacement: undefined })
    expect(servers[0].received.filter((m) => m.method === 'textDocument/completion')[1].params).toMatchObject({ context: { triggerKind: 1 } })
    items = null
    expect(await backend.completions('p', 'src/a.py', 1, 1)).toEqual([])

    expect(await backend.completionDetails('p', 'src/a.py', one.data)).toEqual({ detail: '() -> int', documentation: 'Docs', edits: [{ range: range(1, 1, 1, 1), newText: 'import x\n' }] })
    expect(await backend.completionDetails('p', 'src/a.py', { label: 'boom', detail: 'd' })).toEqual({ detail: 'd', documentation: '', edits: [] })
    expect(await backend.completionDetails('p', 'src/a.py', undefined)).toBeNull()

    expect(await backend.signature('p', 'src/a.py', 1, 1)).toEqual({ items: [{ label: 'f(a, b)', documentation: 'F', parameters: [{ label: 'a', documentation: '' }, { label: 'b', documentation: 'B' }] }], active: 0, activeParameter: 1 })
    sig = { signatures: [{ label: 'g()' }, { label: 'h()' }], activeSignature: 1, activeParameter: 0 }
    expect(await backend.signature('p', 'src/a.py', 1, 1)).toMatchObject({ active: 1, activeParameter: 0, items: [{ parameters: [] }, { parameters: [] }] })
    sig = { signatures: [{ label: 'k()' }] }
    expect(await backend.signature('p', 'src/a.py', 1, 1)).toMatchObject({ active: 0, activeParameter: 0 })
    sig = { signatures: [] }
    expect(await backend.signature('p', 'src/a.py', 1, 1)).toBeNull()
  })

  it('a server without completion resolving: details come from the item itself', async () => {
    const { backend } = await setup({ initialize: () => ({ capabilities: {} }) })
    await backend.open('p', 'src/a.py', '')
    expect(await backend.completionDetails('p', 'src/a.py', { label: 'x', documentation: { kind: 'markdown', value: 'D' } })).toEqual({ detail: '', documentation: 'D', edits: [] })
    const bare = await setup({ initialize: () => ({}) })
    await bare.backend.open('p', 'src/a.py', '')
    expect(await bare.backend.completionDetails('p', 'src/a.py', { label: 'y' })).toMatchObject({ detail: '' })
  })

  it('definitions, references and renames inside the project; failures', async () => {
    const elsewhere = 'file:///elsewhere/x.py'
    let defs: unknown
    let renameResult: unknown
    const { backend, uri } = await setup({
      'textDocument/definition': () => defs,
      'textDocument/references': () => [{ uri: uri('src/b.py'), range: lsRange(1, 0, 1, 3) }, { uri: elsewhere, range: lsRange(0, 0, 0, 1) }],
      'textDocument/rename': (p: { newName: string }) => (p.newName === 'bad' ? Promise.reject(new Error('Cannot rename')) : renameResult)
    })
    await backend.open('p', 'src/a.py', '')
    defs = { uri: uri('src/b.py'), range: lsRange(0, 4, 0, 9) }
    expect(await backend.definition('p', 'src/a.py', 1, 1)).toEqual([{ path: 'src/b.py', range: range(1, 5, 1, 10) }])
    defs = [{ targetUri: uri('src/b.py'), targetRange: lsRange(0, 0, 2, 0), targetSelectionRange: lsRange(0, 4, 0, 9) }, { targetUri: uri('src/a.py'), targetRange: lsRange(3, 0, 3, 1) }, { uri: 'untitled:1', range: lsRange(0, 0, 0, 0) }]
    expect((await backend.definition('p', 'src/a.py', 1, 1)).map((l) => `${l.path}:${l.range.start.line}:${l.range.start.offset}`)).toEqual(['src/b.py:1:5', 'src/a.py:4:1'])
    defs = null
    expect(await backend.definition('p', 'src/a.py', 1, 1)).toEqual([])
    expect(await backend.references('p', 'src/a.py', 1, 1)).toEqual([{ path: 'src/b.py', range: range(2, 1, 2, 4) }])

    renameResult = {
      changes: { [uri('src/a.py')]: [{ range: lsRange(0, 0, 0, 1), newText: 'z' }], [elsewhere]: [] },
      documentChanges: [{ textDocument: { uri: uri('src/b.py') }, edits: [{ range: lsRange(1, 0, 1, 1), newText: 'z' }] }, { kind: 'create', uri: uri('new.py') }]
    }
    expect(await backend.rename('p', 'src/a.py', 1, 1, 'z')).toEqual({
      files: [
        { path: 'src/a.py', edits: [{ range: range(1, 1, 1, 2), newText: 'z' }] },
        { path: 'src/b.py', edits: [{ range: range(2, 1, 2, 2), newText: 'z' }] }
      ]
    })
    renameResult = {}
    expect(await backend.rename('p', 'src/a.py', 1, 1, 'z')).toEqual({ files: [] })
    renameResult = null
    expect(await backend.rename('p', 'src/a.py', 1, 1, 'z')).toEqual({ error: 'This symbol cannot be renamed', files: [] })
    expect(await backend.rename('p', 'src/a.py', 1, 1, 'bad')).toEqual({ error: 'Cannot rename', files: [] })
  })

  it('quick fixes for the diagnostics in a range; commands and failures give none', async () => {
    let actions: unknown = [
      { title: 'Add import', edit: { changes: {} } },
      { title: 'Run command', command: 'x' },
      { title: 'No edit', edit: undefined }
    ]
    const { backend, servers, uri } = await setup({ 'textDocument/codeAction': () => (actions === 'fail' ? Promise.reject(new Error('x')) : actions) })
    expect(await backend.codeFixes('p', 'src/a.py', range(1, 1, 1, 2))).toEqual([]) // no server yet
    await backend.open('p', 'src/a.py', '')
    servers[0].send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: uri('src/a.py'), diagnostics: [{ range: lsRange(0, 0, 0, 1), message: 'here' }, { range: lsRange(9, 0, 9, 1), message: 'far below' }, { range: lsRange(-5, 0, -4, 0), message: 'far above' }] }
    })
    await tick()
    expect(await backend.codeFixes('p', 'src/a.py', range(1, 1, 1, 2))).toEqual([{ title: 'Add import', files: [] }])
    const sent = servers[0].received.find((m) => m.method === 'textDocument/codeAction')!.params as { context: { diagnostics: { message: string }[] } }
    expect(sent.context.diagnostics.map((d) => d.message)).toEqual(['here'])
    await backend.open('p', 'src/b.py', '')
    actions = 'fail'
    expect(await backend.codeFixes('p', 'src/b.py', range(1, 1, 1, 2))).toEqual([])
    actions = null
    expect(await backend.codeFixes('p', 'src/b.py', range(1, 1, 1, 2))).toEqual([])
  })

  it('symbols: nested (DocumentSymbol) or flat (SymbolInformation); none when the server has none', async () => {
    let answer: unknown = [
      {
        name: 'Server',
        detail: '',
        kind: 5,
        range: lsRange(0, 0, 9, 1),
        selectionRange: lsRange(0, 6, 0, 12),
        children: [{ name: 'run', detail: '() -> None', kind: 6, range: lsRange(1, 2, 3, 0), selectionRange: lsRange(1, 6, 1, 9) }]
      }
    ]
    const { backend, servers, uri } = await setup({ 'textDocument/documentSymbol': () => answer })
    await expect(backend.symbols('p', 'src/a.py')).rejects.toMatchObject({ code: 'lsp-unavailable' }) // no server yet
    await backend.open('p', 'src/a.py', '')
    expect(await backend.symbols('p', 'src/a.py')).toEqual([
      {
        name: 'Server',
        detail: undefined,
        kind: 5,
        range: range(1, 1, 10, 2),
        selection: range(1, 7, 1, 13),
        children: [{ name: 'run', detail: '() -> None', kind: 6, range: range(2, 3, 4, 1), selection: range(2, 7, 2, 10), children: [] }]
      }
    ])
    expect(servers[0].received.find((m) => m.method === 'textDocument/documentSymbol')!.params).toEqual({ textDocument: { uri: uri('src/a.py') } })
    const init = servers[0].received.find((m) => m.method === 'initialize')!.params as { capabilities: { textDocument: Record<string, unknown> } }
    expect(init.capabilities.textDocument.documentSymbol).toEqual({ hierarchicalDocumentSymbolSupport: true })
    answer = [{ name: 'f', kind: 12, location: { uri: uri('src/a.py'), range: lsRange(4, 0, 6, 0) } }]
    expect(await backend.symbols('p', 'src/a.py')).toEqual([{ name: 'f', kind: 12, range: range(5, 1, 7, 1), selection: range(5, 1, 7, 1), children: [] }])
    answer = null
    expect(await backend.symbols('p', 'src/a.py')).toEqual([])
  })

  it('a real server process through the user’s shell: it starts, publishes, shuts down', async () => {
    const root = await tempDir('mindeck-ls-real-')
    await writeFile(join(root, 'a.py'), '')
    const pushed: string[] = []
    const backend = new GenericBackend({ resolveRoot: () => root, trusted: () => true, tools: { dir: '/t', locate: async () => FAKE_LSP }, onDiagnostics: ({ projectId }) => pushed.push(projectId) })
    expect(await backend.open('p', 'a.py', 'x')).toEqual({ available: true })
    for (let i = 0; i < 100 && !pushed.length; i += 1) await tick(20)
    expect((await backend.diagnostics('p', ['a.py']))['a.py']).toEqual([expect.objectContaining({ message: 'fake problem', source: 'Pyright' })])
    await backend.dispose()
  }, 20_000)

  it('a server error for a position is "nothing here"', async () => {
    const { backend } = await setup({ 'textDocument/hover': () => Promise.reject(new Error('content modified')) })
    await backend.open('p', 'src/a.py', '')
    expect(await backend.hover('p', 'src/a.py', 1, 1)).toBeNull()
  })

  it('a server that dies mid-request is an error, not "nothing here"', async () => {
    const { backend } = await setup({ 'textDocument/hover': (_p, server) => void server.kill() })
    await backend.open('p', 'src/a.py', '')
    await expect(backend.hover('p', 'src/a.py', 1, 1)).rejects.toMatchObject({ code: 'lsp-stopped' })
  })

  it('at most six servers (least recently used goes), and dispose shuts them all down', async () => {
    const { backend, servers } = await setup({}, { languages: ['python'] })
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) await backend.open(id, 'src/a.py', '')
    await backend.open('p1', 'src/a.py', 'again') // p1 used recently
    await backend.open('p7', 'src/a.py', '')
    await tick(50)
    expect(servers.map((s) => s.killed)).toEqual([false, true, false, false, false, false, false])
    await backend.dispose()
    expect(servers.every((s) => s.killed)).toBe(true)
  })
})

describe('server commands and initialization options', () => {
  it('runs a server’s own command (starting the server first); none installed says so', async () => {
    const { backend, servers } = await setup({ 'workspace/executeCommand': (p: { command: string; arguments: unknown[] }) => ({ ran: p.command, with: p.arguments }) }, { languages: ['python'] })
    expect(await backend.executeCommand('p', 'python', 'pyright.organizeimports', ['x'])).toEqual({ ran: 'pyright.organizeimports', with: ['x'] })
    expect(servers).toHaveLength(1)
    await expect(backend.executeCommand('p', 'go', 'gopls.tidy', [])).rejects.toMatchObject({ code: 'server-missing', message: 'No Go language server installed — Settings → Languages' })
  })

  it('jdtls gets the Java debug plugin as a bundle once it is installed', async () => {
    const tools = await tempDir('mindeck-tools-')
    expect(CATALOG.java.server.initializationOptions!({ root: '/r', tools })).toEqual({ bundles: [] })
    expect(javaDebugJar(tools)).toBeUndefined()
    const server = join(tools, 'java-debug', 'extension', 'server')
    await mkdir(server, { recursive: true })
    await writeFile(join(server, 'readme.txt'), '')
    expect(javaDebugJar(tools)).toBeUndefined()
    await writeFile(join(server, 'com.microsoft.java.debug.plugin-0.53.2.jar'), '')
    expect(CATALOG.java.server.initializationOptions!({ root: '/r', tools })).toEqual({ bundles: [join(server, 'com.microsoft.java.debug.plugin-0.53.2.jar')] })

    const { backend, servers } = await setup({}, { languages: ['java'] })
    await backend.executeCommand('p', 'java', 'noop', [])
    const init = servers[0].received.find((m) => m.method === 'initialize')!.params as { initializationOptions: unknown }
    expect(init.initializationOptions).toEqual({ bundles: [] })
    const py = await setup({}, { languages: ['python'] })
    await py.backend.open('p', 'src/a.py', '')
    expect((py.servers[0].received.find((m) => m.method === 'initialize')!.params as Record<string, unknown>).initializationOptions).toBeUndefined()
  })
})

describe('language servers and workspace trust', () => {
  it('a project that isn’t trusted starts no server (they run its code); restricted again, its servers stop', async () => {
    let trusted = false
    const t = await setup({}, { trusted: () => trusted })
    expect(await t.backend.open('p1', 'src/a.py', 'x')).toEqual({ available: false })
    expect(t.spawned).toHaveLength(0)
    await expect(t.backend.executeCommand('p1', 'python', 'x', [])).rejects.toMatchObject({ code: 'untrusted' })

    trusted = true
    expect(await t.backend.open('p1', 'src/a.py', 'x')).toEqual({ available: true })
    expect(await t.backend.open('p2', 'src/a.py', 'x')).toEqual({ available: true })
    expect(t.spawned).toHaveLength(2)
    trusted = false
    await t.backend.forget('p1')
    expect(t.servers[0].killed).toBe(true)
    expect(t.servers[1].killed).toBe(false)
    expect(await t.backend.open('p1', 'src/a.py', 'x')).toEqual({ available: false })
    await t.backend.dispose()
    // Without a trust check at all: restricted, nothing starts.
    const root = await tempDir()
    const unchecked = new GenericBackend({ resolveRoot: () => root, tools: { dir: '/t', locate: async () => FAKE_LSP } })
    expect(await unchecked.open('p1', 'src/a.py', 'x')).toEqual({ available: false })
  })
})

describe('LspService routes each file to its backend', () => {
  it('TypeScript to tsserver, the rest to language servers; diagnostics merged', async () => {
    const { root } = await setup()
    const servers: FakeServer[] = []
    const lsp = new LspService({
      resolveRoot: () => root,
      trusted: () => true,
      locate: () => undefined, // no tsserver
      servers: {
        tools: { dir: '/t', locate: async () => '/bin/ls-x' },
        spawn: () => {
          const s = new FakeServer({
            initialize: () => ({ capabilities: {} }),
            'textDocument/hover': () => ({ contents: 'py' }),
            'textDocument/completion': () => [{ label: 'c' }],
            'textDocument/definition': () => [],
            'textDocument/references': () => [],
            'textDocument/rename': () => null,
            'textDocument/signatureHelp': () => null,
            'textDocument/codeAction': () => [],
            'textDocument/documentSymbol': () => []
          })
          servers.push(s)
          return s as unknown as RpcProcess
        }
      }
    })
    expect(await lsp.open('p', 'src/a.py', 'x')).toEqual({ available: true, language: 'python' })
    expect(await lsp.open('p', 'notes.txt', '')).toEqual({ available: false, language: undefined })
    expect(await lsp.open('p', 'a.ts', '')).toEqual({ available: false, language: 'typescript' })
    await lsp.change('p', 'src/a.py', 'y')
    await lsp.change('p', 'a.ts', 'y')
    expect(await lsp.diagnostics('p', ['src/a.py', 'a.ts'])).toEqual({ 'src/a.py': [] })
    expect(await lsp.hover('p', 'src/a.py', 1, 1)).toMatchObject({ markdown: 'py' })
    expect(await lsp.completions('p', 'src/a.py', 1, 1)).toHaveLength(1)
    expect(await lsp.completionDetails('p', 'src/a.py', 1, 1, 'c', undefined, { label: 'c' })).toMatchObject({ detail: '' })
    expect(await lsp.definition('p', 'src/a.py', 1, 1)).toEqual([])
    expect(await lsp.references('p', 'src/a.py', 1, 1)).toEqual([])
    expect(await lsp.rename('p', 'src/a.py', 1, 1, 'z')).toMatchObject({ error: expect.any(String) })
    expect(await lsp.signature('p', 'src/a.py', 1, 1)).toBeNull()
    expect(await lsp.codeFixes('p', 'src/a.py', range(1, 1, 1, 1), [])).toEqual([])
    expect(await lsp.codeFixes('p', 'a.ts', range(1, 1, 1, 1), [1])).toEqual([])
    expect(await lsp.symbols('p', 'src/a.py')).toEqual([])
    expect(await lsp.symbols('p', 'a.ts')).toEqual([]) // TypeScript's come from Monaco
    expect(await lsp.executeCommand('p', 'python', 'x', [])).toBeNull()
    await lsp.close('p', 'src/a.py')
    await lsp.close('p', 'a.ts')
    lsp.dispose()
    await tick(50)
    expect(servers[0].killed).toBe(true)

    // Without a ToolsService there are no language servers.
    const bare = new LspService({ resolveRoot: () => root, trusted: () => true, locate: () => undefined })
    expect(await bare.open('p', 'src/a.py', '')).toEqual({ available: false, language: 'python' })
    bare.dispose()
  })
})
