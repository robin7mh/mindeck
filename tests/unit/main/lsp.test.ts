import { EventEmitter } from 'node:events'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { bundledTsserver, findTsserver, LspService } from '../../../electron/main/services/lsp/LspService'
import { TsServer, type TsProcess } from '../../../electron/main/services/lsp/TsServer'

const A = `export interface User {\n  /** The display name. */\n  name: string\n}\n\n/**\n * Says hello.\n * @param user who to greet\n */\nexport function greet(user: User, loud = false): string {\n  return loud ? user.name.toUpperCase() : user.name\n}\n`
const B = `import { greet } from './a'\n\nconst who = { name: 'Ada' }\ngreet(who, )\nconst n: number = greet(who)\n`

async function project() {
  const root = await tempDir('mindeck-lsp-')
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.ts'), A)
  await writeFile(join(root, 'src/b.ts'), B)
  await writeFile(join(root, 'src/c.ts'), `export const later = 1\n`)
  return root
}

const services: LspService[] = []
const make = (root: string | undefined, opts: Partial<ConstructorParameters<typeof LspService>[0]> = {}) => {
  const s = new LspService({ resolveRoot: () => root, ...opts })
  services.push(s)
  return s
}
afterAll(() => services.forEach((s) => s.dispose()))

describe('LspService (real tsserver)', () => {
  it('finds the project’s TypeScript in its root — never in a parent folder — else Mindeck’s own', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'node_modules/typescript/lib'), { recursive: true })
    await writeFile(join(root, 'node_modules/typescript/lib/tsserver.js'), '')
    await mkdir(join(root, 'packages/app'), { recursive: true })
    expect(findTsserver(root)).toBe(join(root, 'node_modules/typescript/lib/tsserver.js'))
    // A node_modules above the project (~/Downloads/node_modules) isn't the project's.
    expect(findTsserver(join(root, 'packages/app'))).toBeUndefined()
    expect(findTsserver('/')).toBeUndefined()
    expect(bundledTsserver()).toMatch(/typescript[/\\]lib[/\\]tsserver\.js$/)
    // Packaged: Node can't run a file inside the asar archive — the unpacked copy is used.
    expect(bundledTsserver(() => '/App/Resources/app.asar/node_modules/typescript/lib/tsserver.js')).toBe('/App/Resources/app.asar.unpacked/node_modules/typescript/lib/tsserver.js')
    expect(
      bundledTsserver(() => {
        throw new Error('not shipped')
      })
    ).toBeUndefined()
  })

  it('a project that isn’t trusted gets Mindeck’s TypeScript, never its own tsserver.js; trusting it switches, open files kept', async () => {
    const root = await project()
    // The attack: a repository that brings its own "TypeScript".
    await mkdir(join(root, 'node_modules/typescript/lib'), { recursive: true })
    const planted = join(root, 'node_modules/typescript/lib/tsserver.js')
    await writeFile(planted, 'require("fs").writeFileSync("pwned", "")')
    let trusted = false
    const started: { tsserver: string; proc: FakeProc }[] = []
    const lsp = make(root, {
      trusted: () => trusted,
      start: (tsserver, _cwd, onExit) => {
        const proc = new FakeProc()
        started.push({ tsserver, proc })
        return new TsServer(proc as unknown as TsProcess, onExit)
      }
    })
    await lsp.retrust('p') // no server yet: nothing to switch
    expect(await lsp.open('p', 'src/a.ts', A)).toMatchObject({ available: true })
    expect(started.map((s) => s.tsserver)).toEqual([bundledTsserver()])
    await lsp.retrust('p') // still restricted: the same server
    expect(started).toHaveLength(1)

    trusted = true
    await lsp.retrust('p')
    expect(started.map((s) => s.tsserver)).toEqual([bundledTsserver(), planted])
    expect(started[0].proc.killed).toBe(true)
    const reopened = started[1].proc.sent.find((r) => r.command === 'updateOpen')!.arguments as { openFiles: { file: string; fileContent: string }[] }
    expect(reopened.openFiles).toEqual([expect.objectContaining({ file: join(await realpath(root), 'src/a.ts'), fileContent: A })])

    // A server that can't start for the other kind: the project has none until a file opens again.
    trusted = false
    const none = make(root, { trusted: () => trusted, locate: (_r, t) => (t ? undefined : bundledTsserver()) })
    expect(await none.open('p', 'src/a.ts', A)).toMatchObject({ available: true })
    trusted = true
    await none.retrust('p')
    await expect(none.hover('p', 'src/a.ts', 1, 1)).rejects.toMatchObject({ code: 'lsp-unavailable' })

    // The folder is gone by then: no server, and no error either (the next open says so).
    const gone = await project()
    trusted = false
    const lost = make(gone, { trusted: () => trusted, start: () => new TsServer(new FakeProc() as unknown as TsProcess) })
    expect(await lost.open('p', 'src/a.ts', A)).toMatchObject({ available: true })
    await rm(gone, { recursive: true, force: true })
    trusted = true
    await expect(lost.retrust('p')).resolves.toBeUndefined()
  })

  it('answers hovers, completions (with auto-imports), definitions, references, signatures, renames and fixes', { timeout: 60_000 }, async () => {
    const root = await project()
    const lsp = make(root)
    expect(await lsp.open('p', 'src/b.ts', B)).toEqual({ available: true, language: 'typescript' })
    expect(await lsp.open('p', 'src/a.ts', A)).toMatchObject({ available: true })

    const hover = await lsp.hover('p', 'src/b.ts', 4, 2)
    expect(hover?.display).toContain('greet(user: User, loud?: boolean): string')
    expect(hover?.documentation).toContain('Says hello.')
    expect(hover?.documentation).toContain('*@param* — `user` who to greet')
    expect(await lsp.hover('p', 'src/b.ts', 2, 1)).toBeNull() // empty line

    const members = await lsp.completions('p', 'src/b.ts', 4, 11)
    expect(members.map((c) => c.name)).toContain('who')
    // An export of another file, with the import it would add.
    await lsp.change('p', 'src/b.ts', `${B}late`)
    const global = await lsp.completions('p', 'src/b.ts', 6, 5)
    const later = global.find((c) => c.name === 'later')!
    expect(later.source).toMatch(/c$/)
    const details = await lsp.completionDetails('p', 'src/b.ts', 6, 5, 'later', later.source, later.data)
    expect(details?.detail).toContain('const later: 1')
    expect(details?.edits[0].newText).toContain("import { later } from './c'")
    expect((await lsp.completionDetails('p', 'src/b.ts', 4, 11, 'who'))?.detail).toContain('who')
    expect(await lsp.completionDetails('p', 'src/b.ts', 4, 11, 'nothing-like-this')).toBeNull()
    await lsp.change('p', 'src/b.ts', B)
    await lsp.change('p', 'src/b.ts', B) // unchanged: nothing sent

    expect(await lsp.definition('p', 'src/b.ts', 4, 2)).toEqual([{ path: 'src/a.ts', range: { start: { line: 10, offset: 17 }, end: { line: 10, offset: 22 } } }])
    const refs = await lsp.references('p', 'src/a.ts', 10, 18)
    expect(refs.map((r) => `${r.path}:${r.range.start.line}`).sort()).toEqual(['src/a.ts:10', 'src/b.ts:1', 'src/b.ts:4', 'src/b.ts:5'])

    const sig = await lsp.signature('p', 'src/b.ts', 4, 12)
    expect(sig).toMatchObject({ active: 0, activeParameter: 1 })
    expect(sig!.items[0].label).toBe('greet(user: User, loud?: boolean): string')
    expect(sig!.items[0].parameters.map((p) => p.label)).toEqual(['user: User', 'loud?: boolean'])
    expect(sig!.items[0].parameters[0].documentation).toBe('who to greet')
    expect(await lsp.signature('p', 'src/b.ts', 3, 1)).toBeNull()

    const rename = await lsp.rename('p', 'src/a.ts', 10, 18, 'welcome')
    expect(rename.files.map((f) => `${f.path}×${f.edits.length}`).sort()).toEqual(['src/a.ts×1', 'src/b.ts×3'])
    expect(rename.files.find((f) => f.path === 'src/a.ts')!.edits[0].newText).toBe('welcome')
    expect((await lsp.rename('p', 'src/b.ts', 2, 1, 'x')).error).toBeTruthy()

    const diags = await lsp.diagnostics('p', ['src/b.ts', 'src/a.ts', 'src/c.ts'])
    expect(Object.keys(diags).sort()).toEqual(['src/a.ts', 'src/b.ts']) // c.ts is not open
    expect(diags['src/a.ts']).toEqual([])
    const typeError = diags['src/b.ts'].find((d) => d.code === 2322)!
    expect(typeError).toMatchObject({ severity: 'error', range: { start: { line: 5, offset: 7 } } })

    // Fix: a missing import.
    await lsp.change('p', 'src/b.ts', `${B}later\n`)
    const missing = (await lsp.diagnostics('p', ['src/b.ts']))['src/b.ts'].find((d) => d.code === 2304)!
    const fixes = await lsp.codeFixes('p', 'src/b.ts', missing.range, [2304])
    expect(fixes[0].title).toBe('Add import from "./c"')
    expect(fixes[0].files[0]).toMatchObject({ path: 'src/b.ts' })
    expect(await lsp.codeFixes('p', 'src/b.ts', missing.range, [])).toEqual([])
    // a file tsserver doesn't know: no fixes, no error
    expect(await lsp.codeFixes('p', 'src/nope.ts', missing.range, [2304])).toEqual([])
    expect(await make(root).codeFixes('p', 'src/b.ts', missing.range, [2304])).toEqual([]) // no server yet

    await lsp.close('p', 'src/b.ts')
    await lsp.close('p', 'src/b.ts') // not open anymore
    expect(await lsp.diagnostics('p', ['src/b.ts'])).toEqual({})
    // Opening an open file again just updates it.
    expect(await lsp.open('p', 'src/a.ts', `${A}\n`)).toMatchObject({ available: true })
  })

  it('without TypeScript, before any open, for unknown projects', async () => {
    const root = await project()
    const none = make(root, { locate: () => undefined })
    expect(await none.open('p', 'src/a.ts', A)).toEqual({ available: false, language: 'typescript' })
    await none.change('p', 'src/a.ts', A)
    await none.close('p', 'src/a.ts')
    expect(await none.diagnostics('p', ['src/a.ts'])).toEqual({})
    await expect(none.hover('p', 'src/a.ts', 1, 1)).rejects.toMatchObject({ code: 'lsp-unavailable' })
    await expect(none.completionDetails('p', 'src/a.ts', 1, 1, 'x')).rejects.toMatchObject({ code: 'lsp-unavailable' })
    await expect(none.rename('p', 'src/a.ts', 1, 1, 'x')).rejects.toMatchObject({ code: 'lsp-unavailable' })
    await expect(make(undefined).open('p', 'a.ts', '')).rejects.toMatchObject({ code: 'not-found' })
  })
})

/** A scripted stand-in for the tsserver process. */
class FakeProc extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  killed = false
  sent: { seq: number; command: string; arguments: unknown }[] = []
  constructor(private readonly answer: (req: { seq: number; command: string; arguments: unknown }, proc: FakeProc) => void = (req, p) => p.reply(req.seq, {})) {
    super()
    this.stdin.on('data', (d: Buffer) =>
      d
        .toString()
        .split('\n')
        .filter(Boolean)
        .forEach((line) => {
          const req = JSON.parse(line)
          this.sent.push(req)
          this.answer(req, this)
        })
    )
  }
  frame(msg: unknown) {
    const body = Buffer.from(JSON.stringify(msg))
    this.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
  }
  reply(seq: number, body: unknown, success = true) {
    this.frame({ type: 'response', request_seq: seq, success, body, message: success ? undefined : 'nope' })
  }
  kill() {
    this.killed = true
    this.emit('exit')
    return true
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('TsServer protocol', () => {
  it('frames: split chunks, several per chunk, odd headers, broken JSON, unknown answers and events', async () => {
    const proc = new FakeProc(() => {})
    const server = new TsServer(proc as unknown as TsProcess)
    const answer = server.request('quickinfo', {})
    const body = Buffer.from(JSON.stringify({ type: 'response', request_seq: 1, success: true, body: { ok: 'ü' } }))
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
    proc.stdout.write(Buffer.from('X-Odd: 1\r\n\r\n'))
    proc.stdout.write(frame.subarray(0, 10))
    await tick()
    proc.stdout.write(frame.subarray(10, frame.length - 3))
    await tick()
    const broken = Buffer.from('{oops')
    proc.stdout.write(Buffer.concat([frame.subarray(frame.length - 3), Buffer.from(`Content-Length: ${broken.length}\r\n\r\n`), broken]))
    proc.frame({ type: 'response', request_seq: 99, success: true }) // nobody asked
    proc.frame({ type: 'event', event: 'projectLoadingStart' })
    proc.frame({ type: 'other' })
    expect(await answer).toEqual({ ok: 'ü' })
    server.notify('open', {})
    expect(proc.sent.map((s) => s.command)).toEqual(['quickinfo', 'open'])
  })

  it('failures, timeouts, diagnostics runs, and a server that exits', async () => {
    const proc = new FakeProc(() => {})
    let exits = 0
    const server = new TsServer(proc as unknown as TsProcess, () => (exits += 1), 50)
    const failed = server.request('x', {})
    proc.reply(1, null, false)
    await expect(failed).rejects.toMatchObject({ code: 'lsp', message: 'nope' })
    proc.frame({ type: 'response', request_seq: 2, success: false }) // seq 2 is not asked yet
    await expect(server.request('slow', {})).rejects.toMatchObject({ code: 'lsp-timeout' })

    expect(await server.diagnostics([])).toEqual(new Map())
    const diags = server.diagnostics(['/a.ts'])
    const d = { start: { line: 1, offset: 1 }, end: { line: 1, offset: 2 }, text: 'bad', category: 'error' }
    proc.frame({ type: 'event', event: 'syntaxDiag', body: { file: '/a.ts', diagnostics: [d] } })
    proc.frame({ type: 'event', event: 'semanticDiag', body: { file: '/a.ts', diagnostics: [d] } })
    proc.frame({ type: 'event', event: 'requestCompleted', body: { request_seq: 4 } })
    expect((await diags).get('/a.ts')).toHaveLength(2)
    expect(await server.diagnostics(['/b.ts'])).toEqual(new Map()) // never completed: times out empty
    proc.frame({ type: 'event', event: 'requestCompleted', body: { request_seq: 77 } })

    const pending = server.request('hang', {})
    const run = server.diagnostics(['/a.ts'])
    proc.emit('error', new Error('boom'))
    await expect(pending).rejects.toMatchObject({ code: 'lsp-stopped' })
    expect(await run).toEqual(new Map())
    expect(server.running).toBe(false)
    expect(exits).toBe(1)
    proc.emit('exit')
    server.dispose()
    expect(exits).toBe(1)
    await expect(server.request('x', {})).rejects.toMatchObject({ code: 'lsp-stopped' })
    server.notify('x', {})
    expect(await server.diagnostics(['/a.ts'])).toEqual(new Map())
  })

  it('dispose kills the process', () => {
    const proc = new FakeProc()
    const server = new TsServer(proc as unknown as TsProcess)
    server.dispose()
    expect(proc.killed).toBe(true)
  })

  it('the service keeps at most three servers (least recently used goes) and restarts a crashed one', async () => {
    const procs: FakeProc[] = []
    const roots = await Promise.all([1, 2, 3, 4].map(() => tempDir()))
    for (const r of roots) await writeFile(join(r, 'a.ts'), '')
    const lsp = make(undefined, {
      resolveRoot: (id) => roots[Number(id)],
      locate: () => '/ts.js',
      start: (_ts, _root, onExit) => {
        const proc = new FakeProc()
        procs.push(proc)
        return new TsServer(proc as unknown as TsProcess, onExit)
      }
    })
    for (const id of ['0', '1', '2']) await lsp.open(id, 'a.ts', '')
    await lsp.open('0', 'a.ts', 'x') // project 0 used again
    await lsp.open('3', 'a.ts', '')
    expect(procs.map((p) => p.killed)).toEqual([false, true, false, false]) // project 1 went
    procs[0].kill() // crashes
    expect(await lsp.diagnostics('0', ['a.ts'])).toEqual({})
    await lsp.open('0', 'a.ts', '')
    expect(procs).toHaveLength(5)
    expect(procs[4].sent.map((s) => s.command)).toEqual(['configure', 'compilerOptionsForInferredProjects', 'updateOpen'])
    // A stale exit of a replaced server leaves the new one alone.
    procs[1].emit('exit')
    await lsp.change('3', 'a.ts', 'y')
    await lsp.change('3', 'b.ts', 'z') // not open yet: opens it
    expect(procs[3].sent.filter((s) => s.command === 'updateOpen')).toHaveLength(3)
  })


  it('odd answers: string docs, tags without text, empty bodies, unknown categories, failures that are not "nothing here"', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'a.ts'), '')
    const answers: Record<string, (req: { seq: number }, p: FakeProc) => void> = {}
    const lsp = make(root, {
      locate: () => '/ts.js',
      start: (_ts, _root, onExit) => {
        const proc = new FakeProc((req, p) => (answers[req.command] ? answers[req.command](req, p) : p.reply(req.seq, {})))
        return new TsServer(proc as unknown as TsProcess, onExit)
      }
    })
    await lsp.open('p', 'a.ts', '')
    const span = { start: { line: 1, offset: 1 }, end: { line: 1, offset: 2 } }
    answers.quickinfo = (req, p) => p.reply(req.seq, { displayString: 'x', documentation: 'plain', tags: [{ name: 'deprecated' }], ...span })
    expect(await lsp.hover('p', 'a.ts', 1, 1)).toMatchObject({ documentation: 'plain\n\n*@deprecated*' })
    answers.quickinfo = (req, p) => p.reply(req.seq, { displayString: 'y', ...span })
    expect((await lsp.hover('p', 'a.ts', 1, 1))?.documentation).toBe('')
    answers.quickinfo = (req, p) => p.frame({ type: 'response', request_seq: req.seq, success: false }) // no message
    expect(await lsp.hover('p', 'a.ts', 1, 1)).toBeNull()

    answers.completionInfo = (req, p) => p.reply(req.seq, undefined)
    expect(await lsp.completions('p', 'a.ts', 1, 1)).toEqual([])
    answers.completionInfo = (req, p) => p.reply(req.seq, { entries: [{ name: 'n', kind: 'var', sortText: '1', replacementSpan: span }] })
    expect((await lsp.completions('p', 'a.ts', 1, 1))[0].replacement).toEqual(span)
    for (const command of ['definitionAndBoundSpan', 'references', 'rename', 'signatureHelp']) answers[command] = (req, p) => p.reply(req.seq, undefined)
    expect(await lsp.definition('p', 'a.ts', 1, 1)).toEqual([])
    expect(await lsp.references('p', 'a.ts', 1, 1)).toEqual([])
    expect(await lsp.rename('p', 'a.ts', 1, 1, 'x')).toEqual({ error: 'This symbol cannot be renamed', files: [] })
    expect(await lsp.signature('p', 'a.ts', 1, 1)).toBeNull()
    answers.rename = (req, p) => p.reply(req.seq, { info: { canRename: true }, locs: [{ file: '/elsewhere/x.ts', locs: [span] }] })
    expect(await lsp.rename('p', 'a.ts', 1, 1, 'x')).toEqual({ files: [] }) // outside the project: not ours to edit

    const abs = join(await realpath(root), 'a.ts')
    answers.geterr = (req, p) => {
      p.frame({ type: 'event', event: 'suggestionDiag', body: { file: abs, diagnostics: [{ ...span, text: 'w', category: 'warning' }, { ...span, text: 's', category: 'suggestion' }, { ...span, text: 'm', category: 'message' }] } })
      p.frame({ type: 'event', event: 'requestCompleted', body: { request_seq: req.seq } })
    }
    expect((await lsp.diagnostics('p', ['a.ts']))['a.ts'].map((d) => d.severity)).toEqual(['warning', 'suggestion', 'info'])
    answers.geterr = (req, p) => p.frame({ type: 'event', event: 'requestCompleted', body: { request_seq: req.seq } })
    expect(await lsp.diagnostics('p', ['a.ts'])).toEqual({ 'a.ts': [] }) // checked, nothing found

    answers.quickinfo = (req, p) => {
      p.kill() // the server dies mid-request: that is an error, not "nothing here"
    }
    await expect(lsp.hover('p', 'a.ts', 1, 1)).rejects.toMatchObject({ code: 'lsp-stopped' })
  })
})
