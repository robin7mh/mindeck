import type {
  LspCodeFix,
  LspCompletion,
  LspCompletionDetails,
  LspDiagnostic,
  LspHover,
  LspLocation,
  LspRange,
  LspRename,
  LspSignature,
  LspSymbol
} from '@shared/types/lsp'
import { isTypeScriptFile, languageOf } from '@shared/types/languages'
import { TsBackend, type TsOptions } from './TsBackend'
import { GenericBackend, type GenericOptions } from './GenericBackend'

export { bundledTsserver, findTsserver } from './TsBackend'

/** Without a ToolsService: no language servers besides tsserver. */
const NO_SERVERS = { dir: '', locate: async () => undefined }

export interface LspOptions extends TsOptions {
  /** Language servers for everything that isn't TypeScript / JavaScript; none when absent. */
  servers?: Omit<GenericOptions, 'resolveRoot'>
}

/**
 * Language intelligence for every file the editor opens: TypeScript and
 * JavaScript from the project's tsserver, every other language from its
 * own language server. Callers don't care which — each call goes to the
 * backend of its file.
 */
export class LspService {
  private readonly ts: TsBackend
  private readonly generic: GenericBackend

  constructor(opts: LspOptions) {
    this.ts = new TsBackend(opts)
    this.generic = new GenericBackend({ resolveRoot: opts.resolveRoot, trusted: opts.trusted, tools: NO_SERVERS, ...opts.servers })
  }

  async open(projectId: string, path: string, text: string): Promise<{ available: boolean; language?: string }> {
    if (isTypeScriptFile(path)) return { ...(await this.ts.open(projectId, path, text)), language: 'typescript' }
    return { ...(await this.generic.open(projectId, path, text)), language: languageOf(path)?.id }
  }

  change(projectId: string, path: string, text: string): Promise<void> {
    return isTypeScriptFile(path) ? this.ts.change(projectId, path, text) : this.generic.change(projectId, path, text)
  }

  close(projectId: string, path: string): Promise<void> {
    return isTypeScriptFile(path) ? this.ts.close(projectId, path) : this.generic.close(projectId, path)
  }

  /** A language server's own command (jdtls: start a Java debug session …). */
  executeCommand(projectId: string, languageId: string, command: string, args: unknown[]): Promise<unknown> {
    return this.generic.executeCommand(projectId, languageId, command, args)
  }

  async diagnostics(projectId: string, paths: string[]): Promise<Record<string, LspDiagnostic[]>> {
    const [ts, other] = await Promise.all([
      this.ts.diagnostics(projectId, paths.filter(isTypeScriptFile)),
      this.generic.diagnostics(projectId, paths.filter((p) => !isTypeScriptFile(p)))
    ])
    return { ...ts, ...other }
  }

  hover(projectId: string, path: string, line: number, offset: number): Promise<LspHover | null> {
    return isTypeScriptFile(path) ? this.ts.hover(projectId, path, line, offset) : this.generic.hover(projectId, path, line, offset)
  }

  completions(projectId: string, path: string, line: number, offset: number, trigger?: string): Promise<LspCompletion[]> {
    return isTypeScriptFile(path) ? this.ts.completions(projectId, path, line, offset, trigger) : this.generic.completions(projectId, path, line, offset, trigger)
  }

  completionDetails(projectId: string, path: string, line: number, offset: number, name: string, source?: string, data?: unknown): Promise<LspCompletionDetails | null> {
    return isTypeScriptFile(path) ? this.ts.completionDetails(projectId, path, line, offset, name, source, data) : this.generic.completionDetails(projectId, path, data)
  }

  definition(projectId: string, path: string, line: number, offset: number): Promise<LspLocation[]> {
    return isTypeScriptFile(path) ? this.ts.definition(projectId, path, line, offset) : this.generic.definition(projectId, path, line, offset)
  }

  references(projectId: string, path: string, line: number, offset: number): Promise<LspLocation[]> {
    return isTypeScriptFile(path) ? this.ts.references(projectId, path, line, offset) : this.generic.references(projectId, path, line, offset)
  }

  rename(projectId: string, path: string, line: number, offset: number, newName: string): Promise<LspRename> {
    return isTypeScriptFile(path) ? this.ts.rename(projectId, path, line, offset, newName) : this.generic.rename(projectId, path, line, offset, newName)
  }

  signature(projectId: string, path: string, line: number, offset: number): Promise<LspSignature | null> {
    return isTypeScriptFile(path) ? this.ts.signature(projectId, path, line, offset) : this.generic.signature(projectId, path, line, offset)
  }

  /** Quick fixes: TypeScript's for these error codes, a language server's for the diagnostics in the range. */
  codeFixes(projectId: string, path: string, at: LspRange, errorCodes: number[]): Promise<LspCodeFix[]> {
    return isTypeScriptFile(path) ? this.ts.codeFixes(projectId, path, at, errorCodes) : this.generic.codeFixes(projectId, path, at)
  }

  /** A file's symbols (the outline) — TypeScript's come from Monaco's own service in the editor. */
  async symbols(projectId: string, path: string): Promise<LspSymbol[]> {
    return isTypeScriptFile(path) ? [] : this.generic.symbols(projectId, path)
  }

  /** A project's trust changed: TypeScript switches servers (keeping the open files); other servers stop until files open again. */
  async retrust(projectId: string): Promise<void> {
    // A server that can't start now (the folder is gone) starts with the next file opened.
    await Promise.all([this.ts.retrust(projectId).catch(() => {}), this.generic.forget(projectId)])
  }

  dispose(): void {
    this.ts.dispose()
    void this.generic.dispose()
  }
}
