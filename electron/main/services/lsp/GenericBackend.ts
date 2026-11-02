import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  LspSymbol,
  LspTextEdit
} from '@shared/types/lsp'
import { LANGUAGES, languageOf, type LanguageInfo } from '@shared/types/languages'
import { confine } from '../../lib/confine'
import { shellCommand, shellEnv, shellQuote } from '../terminal/TerminalService'
import { shellArgs } from '../../lib/shellArgs'
import { spawnProgram } from '../../lib/executables'
import { CATALOG, type ServerSpec } from '../tools/catalog'
import { LspClient, type RpcProcess } from './LspClient'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

// --- the protocol's shapes (just what the editor uses) ---

type Pos = { line: number; character: number }
type Range = { start: Pos; end: Pos }
type TextEdit = { range: Range; newText: string }
type Location = { uri: string; range: Range } | { targetUri: string; targetRange: Range; targetSelectionRange?: Range }
type Markup = string | { kind: string; value: string } | { language: string; value: string }
type WorkspaceEdit = { changes?: Record<string, TextEdit[]>; documentChanges?: ({ textDocument: { uri: string }; edits: TextEdit[] } | { kind: string })[] }
type DocumentSymbol = { name: string; detail?: string; kind: number; range: Range; selectionRange: Range; children?: DocumentSymbol[] }
type SymbolInformation = { name: string; kind: number; location: { uri: string; range: Range } }
type RawDiagnostic = { range: Range; message: string; severity?: number; code?: number | string; source?: string; tags?: number[] }
type Item = {
  label: string
  kind?: number
  detail?: string
  documentation?: Markup
  sortText?: string
  insertText?: string
  insertTextFormat?: number
  textEdit?: { range: Range; newText: string } | { insert: Range; replace: Range; newText: string }
  additionalTextEdits?: TextEdit[]
}

const toPos = (p: { line: number; offset: number }): Pos => ({ line: p.line - 1, character: p.offset - 1 })
const fromPos = (p: Pos) => ({ line: p.line + 1, offset: p.character + 1 })
const toRange = (r: LspRange): Range => ({ start: toPos(r.start), end: toPos(r.end) })
const fromRange = (r: Range): LspRange => ({ start: fromPos(r.start), end: fromPos(r.end) })
const fromEdit = (e: TextEdit): LspTextEdit => ({ range: fromRange(e.range), newText: e.newText })

/** Hover / documentation content as markdown. */
export function markdown(content: Markup | Markup[] | undefined | null): string {
  if (!content) return ''
  if (Array.isArray(content)) return content.map(markdown).filter(Boolean).join('\n\n')
  if (typeof content === 'string') return content
  if ('language' in content) return `\`\`\`${content.language}\n${content.value}\n\`\`\``
  return content.value
}

/** LSP's CompletionItemKind → the kind names the editor maps to icons. */
const KINDS: Record<number, string> = {
  2: 'method',
  3: 'function',
  4: 'constructor',
  5: 'property',
  6: 'var',
  7: 'class',
  8: 'interface',
  9: 'module',
  10: 'property',
  12: 'string',
  13: 'enum',
  14: 'keyword',
  15: 'snippet',
  17: 'script',
  18: 'alias',
  19: 'directory',
  20: 'enum member',
  21: 'const',
  22: 'class',
  25: 'type parameter'
}
const SEVERITY: Record<number, LspDiagnostic['severity']> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'suggestion' }

/** The languageId a server expects for a file. */
export function documentLanguage(path: string, lang: LanguageInfo): string {
  if (lang.id === 'shell') return 'shellscript'
  if (lang.id !== 'cpp') return lang.id
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  return { '.c': 'c', '.h': 'c', '.m': 'objective-c', '.mm': 'objective-cpp' }[ext] ?? 'cpp'
}

/** The editor's client capabilities — what VS Code announces, minus what Mindeck doesn't do. */
const CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: { configuration: true, workspaceFolders: true, applyEdit: false, didChangeConfiguration: { dynamicRegistration: false } },
  textDocument: {
    synchronization: { didSave: false, willSave: false, dynamicRegistration: false },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        insertReplaceSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] }
      }
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } },
    definition: { linkSupport: true },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    references: {},
    rename: { prepareSupport: false },
    codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] } } },
    publishDiagnostics: { tagSupport: { valueSet: [1, 2] } }
  }
}

/**
 * Start a language server like the user's terminal would (their PATH — node,
 * go, ruby …). Windows: directly, without PowerShell (npm's `.cmd` shims
 * through cmd.exe) — the server's path is known.
 */
export function spawnServer(command: string, args: string[], cwd: string, platform: NodeJS.Platform = process.platform): RpcProcess {
  if (platform === 'win32') return spawnProgram(command, args, { cwd, env: shellEnv(), stdio: ['pipe', 'pipe', 'ignore'] }, platform)
  const { file } = shellCommand()
  const line = [command, ...args].map(shellQuote).join(' ')
  return spawn(file, shellArgs(line), { cwd, env: shellEnv(), stdio: ['pipe', 'pipe', 'ignore'] })
}

interface Session {
  projectId: string
  lang: LanguageInfo
  spec: ServerSpec
  root: string
  client: LspClient
  /** What the server said it can do. */
  capabilities: { completionProvider?: { resolveProvider?: boolean } }
  open: Map<string, { version: number; text: string }>
  diagnostics: Map<string, LspDiagnostic[]>
  raw: Map<string, RawDiagnostic[]>
  used: number
}

/** Where language servers are (Mindeck's ToolsService). */
export interface ServerTools {
  /** Mindeck's tools folder (some servers keep their index there). */
  dir: string
  /** The installed server of a language (absolute path), undefined when it isn't. */
  locate: (languageId: string, part: 'server') => Promise<string | undefined>
}

export interface GenericOptions {
  resolveRoot: (projectId: string) => string | undefined
  /** Whether the project is trusted (WorkspaceTrust): language servers run only for trusted ones. */
  trusted?: (projectId: string) => boolean
  tools: ServerTools
  spawn?: (command: string, args: string[], cwd: string) => RpcProcess
  /** A server published new diagnostics for this project. */
  onDiagnostics?: (event: { projectId: string }) => void
  timeoutMs?: number
}

/** At most this many language servers run at once (least recently used goes). */
const MAX_SESSIONS = 6
const MAX_COMPLETIONS = 1000
/** Big servers (Java, Rust) take a while to start. */
const INITIALIZE_TIMEOUT_MS = 120_000

/**
 * Every other language through its own language server — Python's Pyright,
 * Go's gopls, rust-analyzer, clangd, … — spoken to with the Language
 * Server Protocol, one server per project and language, started when the
 * first file of that language opens.
 */
export class GenericBackend {
  private readonly sessions = new Map<string, Session>()
  private readonly starting = new Map<string, Promise<Session | undefined>>()
  private clock = 0

  constructor(private readonly opts: GenericOptions) {}

  async open(projectId: string, path: string, text: string): Promise<{ available: boolean }> {
    const lang = languageOf(path)
    const session = lang && (await this.session(projectId, lang))
    if (!session) return { available: false }
    const file = await confine(session.root, path)
    if (session.open.has(file)) await this.change(projectId, path, text)
    else {
      session.open.set(file, { version: 1, text })
      session.client.notify('textDocument/didOpen', { textDocument: { uri: uri(file), languageId: documentLanguage(path, lang), version: 1, text } })
    }
    return { available: true }
  }

  async change(projectId: string, path: string, text: string): Promise<void> {
    const found = await this.find(projectId, path)
    if (!found) return
    const doc = found.session.open.get(found.file)
    if (!doc) return void (await this.open(projectId, path, text))
    if (doc.text === text) return
    doc.version += 1
    doc.text = text
    found.session.client.notify('textDocument/didChange', { textDocument: { uri: uri(found.file), version: doc.version }, contentChanges: [{ text }] })
  }

  async close(projectId: string, path: string): Promise<void> {
    const found = await this.find(projectId, path)
    if (!found?.session.open.delete(found.file)) return
    found.session.diagnostics.delete(found.file)
    found.session.raw.delete(found.file)
    found.session.client.notify('textDocument/didClose', { textDocument: { uri: uri(found.file) } })
  }

  /** What the servers last published for these open files. */
  async diagnostics(projectId: string, paths: string[]): Promise<Record<string, LspDiagnostic[]>> {
    const out: Record<string, LspDiagnostic[]> = {}
    for (const path of paths) {
      const found = await this.find(projectId, path)
      if (found?.session.open.has(found.file)) out[path] = found.session.diagnostics.get(found.file) ?? []
    }
    return out
  }

  async hover(projectId: string, path: string, line: number, offset: number): Promise<LspHover | null> {
    const result = await this.ask<{ contents: Markup | Markup[]; range?: Range }>(projectId, path, 'textDocument/hover', (doc) => position(doc, line, offset))
    const text = markdown(result?.contents)
    if (!text.trim()) return null
    return { display: '', documentation: '', markdown: text, range: result!.range && fromRange(result!.range) }
  }

  async completions(projectId: string, path: string, line: number, offset: number, trigger?: string): Promise<LspCompletion[]> {
    const result = await this.ask<Item[] | { items: Item[] }>(projectId, path, 'textDocument/completion', (doc) => ({
      ...position(doc, line, offset),
      context: trigger ? { triggerKind: 2, triggerCharacter: trigger } : { triggerKind: 1 }
    }))
    const items = Array.isArray(result) ? result : (result?.items ?? [])
    return items.slice(0, MAX_COMPLETIONS).map((item) => {
      const edit = item.textEdit
      return {
        name: item.label,
        kind: KINDS[item.kind ?? 0] ?? 'text',
        sortText: item.sortText ?? item.label,
        insertText: edit?.newText ?? item.insertText,
        snippet: item.insertTextFormat === 2 || undefined,
        replacement: edit && fromRange('range' in edit ? edit.range : edit.insert),
        detail: item.detail,
        data: item
      }
    })
  }

  /** The rest of a completion (documentation, an import it adds), resolved by the server if it can. */
  async completionDetails(projectId: string, path: string, data: unknown): Promise<LspCompletionDetails | null> {
    const { session } = await this.required(projectId, path)
    const item = data as Item | undefined
    if (!item) return null
    const full = session.capabilities.completionProvider?.resolveProvider
      ? await session.client.request<Item>('completionItem/resolve', item).catch(() => item)
      : item
    return { detail: full.detail ?? '', documentation: markdown(full.documentation), edits: (full.additionalTextEdits ?? []).map(fromEdit) }
  }

  async definition(projectId: string, path: string, line: number, offset: number): Promise<LspLocation[]> {
    const result = await this.ask<Location | Location[]>(projectId, path, 'textDocument/definition', (doc) => position(doc, line, offset))
    return this.locations(projectId, path, result)
  }

  async references(projectId: string, path: string, line: number, offset: number): Promise<LspLocation[]> {
    const result = await this.ask<Location[]>(projectId, path, 'textDocument/references', (doc) => ({ ...position(doc, line, offset), context: { includeDeclaration: true } }))
    return this.locations(projectId, path, result)
  }

  async rename(projectId: string, path: string, line: number, offset: number, newName: string): Promise<LspRename> {
    const { session, file } = await this.required(projectId, path)
    try {
      const edit = await session.client.request<WorkspaceEdit | null>('textDocument/rename', { ...position(uri(file), line, offset), newName })
      if (!edit) return { error: 'This symbol cannot be renamed', files: [] }
      return { files: this.workspaceEdit(session, edit) }
    } catch (err) {
      return { error: (err as Error).message, files: [] }
    }
  }

  async signature(projectId: string, path: string, line: number, offset: number): Promise<LspSignature | null> {
    const result = await this.ask<{
      signatures: { label: string; documentation?: Markup; parameters?: { label: string | [number, number]; documentation?: Markup }[]; activeParameter?: number }[]
      activeSignature?: number
      activeParameter?: number
    }>(projectId, path, 'textDocument/signatureHelp', (doc) => position(doc, line, offset))
    if (!result?.signatures?.length) return null
    const active = result.activeSignature ?? 0
    return {
      items: result.signatures.map((s) => ({
        label: s.label,
        documentation: markdown(s.documentation),
        parameters: (s.parameters ?? []).map((p) => ({ label: typeof p.label === 'string' ? p.label : s.label.slice(p.label[0], p.label[1]), documentation: markdown(p.documentation) }))
      })),
      active,
      activeParameter: result.signatures[active]?.activeParameter ?? result.activeParameter ?? 0
    }
  }

  /** The file's symbols — nested (DocumentSymbol), or flat as older servers send them (SymbolInformation). */
  async symbols(projectId: string, path: string): Promise<LspSymbol[]> {
    const result = await this.ask<(DocumentSymbol | SymbolInformation)[]>(projectId, path, 'textDocument/documentSymbol', (doc) => ({ textDocument: { uri: doc } }))
    const convert = (s: DocumentSymbol | SymbolInformation): LspSymbol =>
      'location' in s
        ? { name: s.name, kind: s.kind, range: fromRange(s.location.range), selection: fromRange(s.location.range), children: [] }
        : { name: s.name, detail: s.detail || undefined, kind: s.kind, range: fromRange(s.range), selection: fromRange(s.selectionRange), children: (s.children ?? []).map(convert) }
    return (result ?? []).map(convert)
  }

  /** Quick fixes the server offers for the diagnostics in a range. */
  async codeFixes(projectId: string, path: string, at: LspRange): Promise<LspCodeFix[]> {
    const found = await this.find(projectId, path)
    if (!found) return []
    const range = toRange(at)
    const overlaps = (r: Range) => !(r.end.line < range.start.line || r.start.line > range.end.line)
    const diagnostics = (found.session.raw.get(found.file) ?? []).filter((d) => overlaps(d.range))
    const actions = await found.session.client
      .request<({ title: string; edit?: WorkspaceEdit } | { title: string; command: string })[] | null>('textDocument/codeAction', {
        textDocument: { uri: uri(found.file) },
        range,
        context: { diagnostics, only: ['quickfix'] }
      })
      .catch(() => null)
    return (actions ?? []).flatMap((a) => ('edit' in a && a.edit ? [{ title: a.title, files: this.workspaceEdit(found.session, a.edit) }] : []))
  }

  /** A server command (`workspace/executeCommand`) — jdtls starts Java debug sessions this way. Starts the server if needed. */
  async executeCommand(projectId: string, languageId: string, command: string, args: unknown[]): Promise<unknown> {
    const lang = LANGUAGES.find((l) => l.id === languageId)!
    const session = await this.session(projectId, lang)
    if (!session && !this.trusts(projectId)) throw coded('untrusted', 'Language servers run only in projects you trust')
    if (!session) throw coded('server-missing', `No ${lang.name} language server installed — Settings → Languages`)
    return session.client.request('workspace/executeCommand', { command, arguments: args }, INITIALIZE_TIMEOUT_MS)
  }

  async dispose(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map((s) => s.client.dispose()))
  }

  /** The project is no longer trusted: its servers stop. */
  async forget(projectId: string): Promise<void> {
    const gone = [...this.sessions].filter(([, s]) => s.projectId === projectId)
    for (const [key] of gone) this.sessions.delete(key)
    await Promise.all(gone.map(([, s]) => s.client.dispose()))
  }

  private trusts(projectId: string): boolean {
    return this.opts.trusted?.(projectId) ?? false
  }

  // --- sessions ---

  private key(projectId: string, lang: LanguageInfo): string {
    return `${projectId}:${lang.id}`
  }

  private async session(projectId: string, lang: LanguageInfo): Promise<Session | undefined> {
    // Restricted: no language server — they run the project's code (rust-analyzer
    // its build scripts, jdtls its Gradle wrapper, Pyright the project's Python).
    if (!this.trusts(projectId)) return undefined
    const key = this.key(projectId, lang)
    const existing = this.sessions.get(key)
    if (existing?.client.running) {
      existing.used = ++this.clock
      return existing
    }
    if (!this.starting.has(key)) this.starting.set(key, this.start(projectId, lang).finally(() => this.starting.delete(key)))
    return this.starting.get(key)
  }

  private async start(projectId: string, lang: LanguageInfo): Promise<Session | undefined> {
    const configured = this.opts.resolveRoot(projectId)
    if (!configured) throw coded('not-found', `Unknown project: ${projectId}`)
    const spec = CATALOG[lang.id].server
    const command = await this.opts.tools.locate(lang.id, 'server')
    if (!command) return undefined
    const root = await realpath(configured)
    if (this.sessions.size >= MAX_SESSIONS) {
      const [oldest, old] = [...this.sessions.entries()].sort((a, b) => a[1].used - b[1].used)[0]
      this.sessions.delete(oldest)
      void old.client.dispose()
    }
    const key = this.key(projectId, lang)
    const settings = spec.settings?.(root) ?? {}
    let session!: Session
    const client = new LspClient((this.opts.spawn ?? spawnServer)(command, spec.args({ root, tools: this.opts.tools.dir }), root), {
      timeoutMs: this.opts.timeoutMs,
      onExit: () => {
        if (this.sessions.get(key) === session) this.sessions.delete(key)
      },
      onNotification: (method, params) => {
        if (method !== 'textDocument/publishDiagnostics') return
        const { uri: docUri, diagnostics } = params as { uri: string; diagnostics: RawDiagnostic[] }
        const file = pathOf(docUri)
        if (!file) return
        session.raw.set(file, diagnostics)
        session.diagnostics.set(
          file,
          diagnostics.map((d) => ({
            range: fromRange(d.range),
            message: d.message,
            severity: SEVERITY[d.severity ?? 1] ?? 'error',
            code: d.code,
            source: d.source ?? spec.name,
            unnecessary: d.tags?.includes(1) || undefined,
            deprecated: d.tags?.includes(2) || undefined
          }))
        )
        this.opts.onDiagnostics?.({ projectId })
      },
      onRequest: (method, params) => {
        if (method === 'workspace/configuration') {
          return (params as { items: { section?: string }[] }).items.map((item) => (item.section ? (settings[item.section] ?? lookup(settings, item.section)) : settings) ?? null)
        }
        if (method === 'workspace/workspaceFolders') return [{ uri: uri(root), name: basename(root) }]
        if (['client/registerCapability', 'client/unregisterCapability', 'window/workDoneProgress/create', 'window/showMessageRequest'].includes(method)) return null
        throw new Error(`Unsupported: ${method}`)
      }
    })
    session = { projectId, lang, spec, root, client, capabilities: {}, open: new Map(), diagnostics: new Map(), raw: new Map(), used: ++this.clock }
    try {
      const init = await client.request<{ capabilities: Session['capabilities'] }>(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'Mindeck' },
          rootUri: uri(root),
          rootPath: root,
          workspaceFolders: [{ uri: uri(root), name: basename(root) }],
          capabilities: CAPABILITIES,
          initializationOptions: spec.initializationOptions?.({ root, tools: this.opts.tools.dir })
        },
        INITIALIZE_TIMEOUT_MS
      )
      session.capabilities = init.capabilities ?? {}
    } catch {
      void client.dispose()
      return undefined
    }
    client.notify('initialized', {})
    if (spec.settings) client.notify('workspace/didChangeConfiguration', { settings })
    this.sessions.set(key, session)
    return session
  }

  private async find(projectId: string, path: string): Promise<{ session: Session; file: string } | undefined> {
    const lang = languageOf(path)
    const session = lang && this.sessions.get(this.key(projectId, lang))
    if (!session) return undefined
    return { session, file: await confine(session.root, path) }
  }

  private async required(projectId: string, path: string): Promise<{ session: Session; file: string }> {
    const found = await this.find(projectId, path)
    if (!found) throw coded('lsp-unavailable', 'No language server for this file')
    return found
  }

  /** A request about an open file; the server's "nothing here" errors become null. */
  private async ask<T>(projectId: string, path: string, method: string, params: (doc: string) => object): Promise<T | null> {
    const { session, file } = await this.required(projectId, path)
    return session.client.request<T>(method, params(uri(file))).catch((err: { code?: string }) => {
      if (err.code === 'lsp') return null
      throw err
    })
  }

  private rel(session: Session, file: string): string | undefined {
    const rel = relative(session.root, file)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : undefined
  }

  private async locations(projectId: string, path: string, result: Location | Location[] | null): Promise<LspLocation[]> {
    const { session } = await this.required(projectId, path)
    const list = !result ? [] : Array.isArray(result) ? result : [result]
    return list.flatMap((l) => {
      const [target, range] = 'targetUri' in l ? [l.targetUri, l.targetSelectionRange ?? l.targetRange] : [l.uri, l.range]
      const file = pathOf(target)
      const rel = file && this.rel(session, file)
      return rel ? [{ path: rel, range: fromRange(range) }] : []
    })
  }

  private workspaceEdit(session: Session, edit: WorkspaceEdit): LspFileEdits[] {
    const groups: [string, TextEdit[]][] = [
      ...Object.entries(edit.changes ?? {}),
      ...(edit.documentChanges ?? []).flatMap((c) => ('textDocument' in c ? [[c.textDocument.uri, c.edits] as [string, TextEdit[]]] : []))
    ]
    return groups.flatMap(([docUri, edits]) => {
      const file = pathOf(docUri)
      const rel = file && this.rel(session, file)
      return rel ? [{ path: rel, edits: edits.map(fromEdit) }] : []
    })
  }
}

const uri = (file: string) => pathToFileURL(file).href

function pathOf(docUri: string): string | undefined {
  return docUri.startsWith('file:') ? fileURLToPath(docUri) : undefined
}

const position = (doc: string, line: number, offset: number) => ({ textDocument: { uri: doc }, position: toPos({ line, offset }) })

/** `a.b.c` in nested settings objects. */
function lookup(settings: Record<string, unknown>, section: string): unknown {
  return section.split('.').reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), settings)
}
