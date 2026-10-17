import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'
import type {
  LspCodeFix,
  LspCompletion,
  LspCompletionDetails,
  LspDiagnostic,
  LspFileEdits,
  LspHover,
  LspLocation,
  LspRange,
  LspRename,
  LspSignature,
  LspTextEdit
} from '@shared/types/lsp'
import { confine } from '../../lib/confine'
import type { NodeLauncher } from '../../lib/nodeProcess'
import { TsServer, type TsDiagnostic } from './TsServer'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** tsserver's display parts and JSDoc tags, flattened to text. */
type Parts = { text: string }[] | string | undefined
const text = (parts: Parts): string => (typeof parts === 'string' ? parts : (parts ?? []).map((p) => p.text).join(''))
type Tag = { name: string; text?: Parts }
const tags = (list: Tag[] = []): string =>
  list.map((tag) => `*@${tag.name}*${tag.text ? ` — ${text(tag.text).replace(/^(\w+)\s/, '`$1` ')}` : ''}`).join('\n\n')
const docs = (documentation: Parts, list?: Tag[]) => [text(documentation), tags(list)].filter(Boolean).join('\n\n')

type Span = { start: { line: number; offset: number }; end: { line: number; offset: number } }
const range = (s: Span): LspRange => ({ start: s.start, end: s.end })

/** At most this many projects keep a tsserver (each holds its whole program in memory). */
const MAX_SERVERS = 3
const MAX_COMPLETIONS = 1000

/**
 * Where a project's own TypeScript lives (VS Code's "workspace version"): in
 * its root's node_modules — never a parent folder's (a `node_modules` in
 * ~/Downloads isn't the project's).
 */
export function findTsserver(root: string): string | undefined {
  const candidate = join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js')
  return existsSync(candidate) ? candidate : undefined
}

/** Mindeck's own TypeScript (shipped with the app, unpacked from the asar archive so Node can run it). */
export function bundledTsserver(resolve: (id: string) => string = createRequire(__filename).resolve): string | undefined {
  try {
    return resolve('typescript/lib/tsserver.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  } catch {
    return undefined
  }
}

interface Session {
  root: string
  /** Started for a trusted project (with its own TypeScript). */
  trusted: boolean
  server: TsServer
  /** Open files (absolute) → their current text. */
  open: Map<string, string>
  used: number
}

export interface TsOptions {
  resolveRoot: (projectId: string) => string | undefined
  /** Whether the project is trusted (WorkspaceTrust); restricted when not, or without this. */
  trusted?: (projectId: string) => boolean
  /** tsserver.js for a project root; default: a trusted project's own, else Mindeck's. */
  locate?: (root: string, trusted: boolean) => string | undefined
  start?: (tsserver: string, root: string, onExit: () => void) => TsServer
  /** How tsserver runs as a Node program (Platform.node). */
  node?: NodeLauncher
}

/**
 * TypeScript / JavaScript intelligence for the editor — completions, hovers,
 * definitions, references, renames, signature help, quick fixes and
 * project-wide diagnostics — from a tsserver per project, started on the
 * first open file. Unsaved buffers are mirrored into it, so answers follow
 * what is on screen.
 */
export class TsBackend {
  private readonly sessions = new Map<string, Session>()
  private clock = 0

  constructor(private readonly opts: TsOptions) {}

  async open(projectId: string, path: string, content: string): Promise<{ available: boolean }> {
    const session = await this.session(projectId)
    if (!session) return { available: false }
    const file = await this.abs(session, path)
    if (session.open.has(file)) await this.change(projectId, path, content)
    else {
      session.open.set(file, content)
      await session.server.request('updateOpen', { openFiles: [{ file, fileContent: content, projectRootPath: session.root }] })
    }
    return { available: true }
  }

  /** The buffer's full new text (replaces what tsserver has). */
  async change(projectId: string, path: string, content: string): Promise<void> {
    const session = this.sessions.get(projectId)
    if (!session) return
    const file = await this.abs(session, path)
    const before = session.open.get(file)
    if (before === undefined) return void (await this.open(projectId, path, content))
    if (before === content) return
    session.open.set(file, content)
    const lines = before.split('\n')
    const end = { line: lines.length, offset: lines[lines.length - 1].length + 1 }
    await session.server.request('updateOpen', { changedFiles: [{ fileName: file, textChanges: [{ start: { line: 1, offset: 1 }, end, newText: content }] }] })
  }

  async close(projectId: string, path: string): Promise<void> {
    const session = this.sessions.get(projectId)
    if (!session) return
    const file = await this.abs(session, path)
    if (!session.open.delete(file)) return
    await session.server.request('updateOpen', { closedFiles: [file] })
  }

  /** Diagnostics per path for these open files — checked against the whole program. */
  async diagnostics(projectId: string, paths: string[]): Promise<Record<string, LspDiagnostic[]>> {
    const session = this.sessions.get(projectId)
    if (!session) return {}
    const files = (await Promise.all(paths.map((p) => this.abs(session, p)))).filter((f) => session.open.has(f))
    const found = await session.server.diagnostics(files)
    const out: Record<string, LspDiagnostic[]> = {}
    for (const file of files) {
      out[this.rel(session, file)] = (found.get(file) ?? []).map((d: TsDiagnostic) => ({
        range: range(d),
        message: d.text,
        severity: d.category === 'error' ? 'error' : d.category === 'warning' ? 'warning' : d.category === 'suggestion' ? 'suggestion' : 'info',
        code: d.code,
        unnecessary: d.reportsUnnecessary || undefined,
        deprecated: d.reportsDeprecated || undefined
      }))
    }
    return out
  }

  async hover(projectId: string, path: string, line: number, offset: number): Promise<LspHover | null> {
    const body = await this.ask<{ displayString: string; documentation: Parts; tags?: Tag[] } & Span>(projectId, path, 'quickinfo', { line, offset })
    if (!body?.displayString) return null
    return { display: body.displayString, documentation: docs(body.documentation, body.tags), range: range(body) }
  }

  async completions(projectId: string, path: string, line: number, offset: number, trigger?: string): Promise<LspCompletion[]> {
    const body = await this.ask<{
      entries: { name: string; kind: string; sortText: string; insertText?: string; isSnippet?: true; replacementSpan?: Span; source?: string; data?: unknown }[]
    }>(projectId, path, 'completionInfo', { line, offset, triggerCharacter: trigger, includeExternalModuleExports: true, includeInsertTextCompletions: true })
    return (body?.entries ?? []).slice(0, MAX_COMPLETIONS).map((e) => ({
      name: e.name,
      kind: e.kind,
      sortText: e.sortText,
      insertText: e.insertText,
      snippet: e.isSnippet,
      replacement: e.replacementSpan && range(e.replacementSpan),
      source: e.source,
      data: e.data
    }))
  }

  async completionDetails(projectId: string, path: string, line: number, offset: number, name: string, source?: string, data?: unknown): Promise<LspCompletionDetails | null> {
    const session = await this.required(projectId)
    const file = await this.abs(session, path)
    const [details] = await session.server.request<
      { displayParts: Parts; documentation: Parts; tags?: Tag[]; codeActions?: { changes: { fileName: string; textChanges: (Span & { newText: string })[] }[] }[] }[]
    >('completionEntryDetails', { file, line, offset, entryNames: [source || data ? { name, source, data } : name] })
    if (!details) return null
    const edits: LspTextEdit[] = (details.codeActions ?? []).flatMap((a) =>
      a.changes.filter((c) => c.fileName === file).flatMap((c) => c.textChanges.map((t) => ({ range: range(t), newText: t.newText })))
    )
    return { detail: text(details.displayParts), documentation: docs(details.documentation, details.tags), edits }
  }

  async definition(projectId: string, path: string, line: number, offset: number): Promise<LspLocation[]> {
    const body = await this.ask<{ definitions: ({ file: string } & Span)[] }>(projectId, path, 'definitionAndBoundSpan', { line, offset })
    return this.locations(projectId, body?.definitions ?? [])
  }

  async references(projectId: string, path: string, line: number, offset: number): Promise<LspLocation[]> {
    const body = await this.ask<{ refs: ({ file: string } & Span)[] }>(projectId, path, 'references', { line, offset })
    return this.locations(projectId, body?.refs ?? [])
  }

  async rename(projectId: string, path: string, line: number, offset: number, newName: string): Promise<LspRename> {
    const session = await this.required(projectId)
    const body = await this.ask<{
      info: { canRename: boolean; localizedErrorMessage?: string }
      locs: { file: string; locs: (Span & { prefixText?: string; suffixText?: string })[] }[]
    }>(projectId, path, 'rename', { line, offset, findInStrings: false, findInComments: false })
    if (!body?.info.canRename) return { error: body?.info.localizedErrorMessage ?? 'This symbol cannot be renamed', files: [] }
    return {
      files: this.inside(session, body.locs, (group) => group.file).map((group) => ({
        path: this.rel(session, group.file),
        edits: group.locs.map((l) => ({ range: range(l), newText: `${l.prefixText ?? ''}${newName}${l.suffixText ?? ''}` }))
      }))
    }
  }

  async signature(projectId: string, path: string, line: number, offset: number): Promise<LspSignature | null> {
    const body = await this.ask<{
      items: { prefixDisplayParts: Parts; suffixDisplayParts: Parts; separatorDisplayParts: Parts; parameters: { displayParts: Parts; documentation: Parts }[]; documentation: Parts; tags?: Tag[] }[]
      selectedItemIndex: number
      argumentIndex: number
    }>(projectId, path, 'signatureHelp', { line, offset })
    if (!body?.items.length) return null
    return {
      items: body.items.map((item) => ({
        label: `${text(item.prefixDisplayParts)}${item.parameters.map((p) => text(p.displayParts)).join(text(item.separatorDisplayParts))}${text(item.suffixDisplayParts)}`,
        documentation: docs(item.documentation, item.tags),
        parameters: item.parameters.map((p) => ({ label: text(p.displayParts), documentation: text(p.documentation) }))
      })),
      active: body.selectedItemIndex,
      activeParameter: body.argumentIndex
    }
  }

  /** Fixes TypeScript offers for these error codes in a range (add a missing import, …). */
  async codeFixes(projectId: string, path: string, at: LspRange, errorCodes: number[]): Promise<LspCodeFix[]> {
    const session = this.sessions.get(projectId)
    if (!session || !errorCodes.length) return []
    const file = await this.abs(session, path)
    const fixes = await session.server
      .request<{ description: string; changes: { fileName: string; textChanges: (Span & { newText: string })[] }[] }[]>('getCodeFixes', {
        file,
        startLine: at.start.line,
        startOffset: at.start.offset,
        endLine: at.end.line,
        endOffset: at.end.offset,
        errorCodes
      })
      .catch(() => [])
    return fixes.map((fix) => ({ title: fix.description, files: this.edits(session, fix.changes) }))
  }

  /** The project's trust changed: a server of the other kind takes over, with the open files. */
  async retrust(projectId: string): Promise<void> {
    const old = this.sessions.get(projectId)
    if (!old || old.trusted === this.trusts(projectId)) return
    this.sessions.delete(projectId)
    old.server.dispose()
    const session = await this.session(projectId)
    if (!session) return
    for (const [file, content] of old.open) {
      session.open.set(file, content)
      await session.server.request('updateOpen', { openFiles: [{ file, fileContent: content, projectRootPath: session.root }] })
    }
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.server.dispose()
    this.sessions.clear()
  }

  // --- helpers ---

  private trusts(projectId: string): boolean {
    return this.opts.trusted?.(projectId) ?? false
  }

  private async session(projectId: string): Promise<Session | undefined> {
    const existing = this.sessions.get(projectId)
    if (existing?.server.running) {
      existing.used = ++this.clock
      return existing
    }
    const root = this.opts.resolveRoot(projectId)
    if (!root) throw coded('not-found', `Unknown project: ${projectId}`)
    // Restricted: Mindeck's own TypeScript — a project's tsserver.js (and the
    // tsconfig plugins it loads from node_modules) is the project's code.
    const trusted = this.trusts(projectId)
    const tsserver = (this.opts.locate ?? ((r: string, t: boolean) => (t ? findTsserver(r) : undefined) ?? bundledTsserver()))(root, trusted)
    if (!tsserver) return undefined
    // Over the limit: the project used longest ago gives its server up.
    if (this.sessions.size >= MAX_SERVERS) {
      const [oldest] = [...this.sessions.entries()].sort((a, b) => a[1].used - b[1].used)[0]
      this.sessions.get(oldest)!.server.dispose()
      this.sessions.delete(oldest)
    }
    const start = this.opts.start ?? ((ts, cwd, onExit) => TsServer.start(ts, cwd, onExit, this.opts.node))
    const server = start(tsserver, root, () => {
      if (this.sessions.get(projectId)?.server === server) this.sessions.delete(projectId)
    })
    // Paths go to tsserver resolved (confine follows symlinks); answers are made relative to the same root.
    const session: Session = { root: await realpath(root), trusted, server, open: new Map(), used: ++this.clock }
    this.sessions.set(projectId, session)
    await server.request('configure', {
      preferences: {
        includeCompletionsForModuleExports: true,
        includeCompletionsWithInsertText: true,
        includeCompletionsWithSnippetText: true,
        includeAutomaticOptionalChainCompletions: true,
        quotePreference: 'auto',
        importModuleSpecifierPreference: 'shortest'
      }
    })
    // Loose JS / TS files outside any tsconfig still get sensible checks.
    await server.request('compilerOptionsForInferredProjects', {
      options: { allowJs: true, checkJs: false, jsx: 'preserve', module: 'esnext', moduleResolution: 'bundler', target: 'es2022', allowSyntheticDefaultImports: true, allowNonTsExtensions: true }
    })
    return session
  }

  private async required(projectId: string): Promise<Session> {
    const session = this.sessions.get(projectId)
    if (!session) throw coded('lsp-unavailable', 'No TypeScript server for this project')
    return session
  }

  /** A position query against an open file; tsserver's "nothing here" answers become null. */
  private async ask<T>(projectId: string, path: string, command: string, args: object): Promise<T | null> {
    const session = await this.required(projectId)
    const file = await this.abs(session, path)
    return session.server.request<T>(command, { file, ...args }).catch((err: { code?: string }) => {
      if (err.code === 'lsp') return null
      throw err
    })
  }

  private async abs(session: Session, path: string): Promise<string> {
    return confine(session.root, path)
  }

  private rel(session: Session, file: string): string {
    return relative(session.root, file).split(sep).join('/')
  }

  /** Only what lies inside the project — the editor opens nothing else. */
  private inside<T>(session: Session, items: T[], file: (item: T) => string): T[] {
    return items.filter((item) => {
      const rel = relative(session.root, file(item))
      return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
    })
  }

  private locations(projectId: string, spans: ({ file: string } & Span)[]): LspLocation[] {
    const session = this.sessions.get(projectId)!
    return this.inside(session, spans, (s) => s.file).map((s) => ({ path: this.rel(session, s.file), range: range(s) }))
  }

  private edits(session: Session, changes: { fileName: string; textChanges: (Span & { newText: string })[] }[]): LspFileEdits[] {
    return this.inside(session, changes, (c) => c.fileName).map((c) => ({ path: this.rel(session, c.fileName), edits: c.textChanges.map((t) => ({ range: range(t), newText: t.newText })) }))
  }
}
