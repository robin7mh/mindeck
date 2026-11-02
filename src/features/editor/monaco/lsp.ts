import { ipc, onEvent } from '@shared/ipc/client'
import type { LspDiagnostic, LspFileEdits, LspRange, LspSymbol, LspTextEdit } from '@shared/types/lsp'
import { LANGUAGES as SERVED_LANGUAGES } from '@shared/types/languages'
import { monaco } from './setup'
import { fileOf } from './uri'
import { tabKey, useEditor } from '../store'
import { useProblems } from '../problems'
import { useLanguages } from '../languages'

type File = { projectId: string; path: string }
export { fileOf }
type Model = monaco.editor.ITextModel

/** Monaco languages with a language service: TypeScript / JavaScript (tsserver) and every registry language. */
const LANGUAGES = ['typescript', 'javascript', ...SERVED_LANGUAGES.flatMap((l) => l.monaco)]
const OWNER = 'lsp'
/** Edits reach the server this long after the last keystroke (queries send them at once). */
const SYNC_MS = 250
/** Diagnostics are asked for this long after the last change. */
const DIAGNOSTICS_MS = 500
/** Peeking at references loads at most this many files that are not open. */
const MAX_PEEK_FILES = 30


const uriOf = (f: File) => monaco.Uri.file(`/${f.projectId}/${f.path}`)
const toRange = (r: LspRange) => new monaco.Range(r.start.line, r.start.offset, r.end.line, r.end.offset)
const at = (model: Model, pos: monaco.IPosition) => ({ ...fileOf(model.uri)!, line: pos.lineNumber, offset: pos.column })

/** Which project + Monaco language has its server running (`projectId:languageId`). */
const available = new Map<string, boolean>()
const serverKey = (model: Model, file: File) => `${file.projectId}:${model.getLanguageId()}`
const projectServed = (projectId: string) => [...available].some(([key, on]) => on && key.startsWith(`${projectId}:`))
/** Per model: open it again (after a language server was installed). */
const reopeners = new Map<string, () => void>()
/** Per model: send its pending edit now (before a query). */
const flushers = new Map<string, () => Promise<void>>()

/** A model whose server runs. */
function served(model: Model): File | undefined {
  const file = fileOf(model.uri)
  return file && LANGUAGES.includes(model.getLanguageId()) && available.get(serverKey(model, file)) ? file : undefined
}

/** Make sure the server has the text on screen before asking it anything. */
async function ready(model: Model): Promise<File | undefined> {
  const file = served(model)
  if (file) await flushers.get(model.uri.toString())?.()
  return file
}

// --- documents ---

function track(model: Model): void {
  const file = fileOf(model.uri)
  if (!file || !LANGUAGES.includes(model.getLanguageId())) return
  const key = model.uri.toString()
  const server = serverKey(model, file)
  let timer: number | undefined
  const open = () =>
    ipc('lsp:open', { ...file, text: model.getValue() }).then(
      ({ available: on, language }) => {
        available.set(server, on)
        useLanguages.getState().report(tabKey(file.projectId, file.path), { language, available: on })
        if (on) scheduleDiagnostics(file.projectId)
      },
      () => available.set(server, false)
    )
  let opened: Promise<unknown> = open()
  reopeners.set(key, () => {
    if (!available.get(server)) opened = opened.then(open)
  })
  const send = async () => {
    window.clearTimeout(timer)
    timer = undefined
    await opened
    if (!available.get(server)) return
    await ipc('lsp:change', { ...file, text: model.getValue() }).catch(() => {})
    scheduleDiagnostics(file.projectId)
  }
  flushers.set(key, async () => {
    if (timer !== undefined) await send()
    else await opened
  })
  model.onDidChangeContent(() => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void send(), SYNC_MS)
  })
  model.onWillDispose(() => {
    window.clearTimeout(timer)
    flushers.delete(key)
    reopeners.delete(key)
    useLanguages.getState().forget(tabKey(file.projectId, file.path))
    opened = opened.then(() => ipc('lsp:close', file)).catch(() => {})
    useProblems.getState().forget(file.projectId, file.path)
    scheduleDiagnostics(file.projectId)
  })
}

// --- diagnostics ---

const diagnosticTimers = new Map<string, number>()

function scheduleDiagnostics(projectId: string): void {
  window.clearTimeout(diagnosticTimers.get(projectId))
  diagnosticTimers.set(projectId, window.setTimeout(() => void refreshDiagnostics(projectId), DIAGNOSTICS_MS))
}

const SEVERITY: Record<LspDiagnostic['severity'], monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  suggestion: monaco.MarkerSeverity.Hint,
  info: monaco.MarkerSeverity.Info
}

/** Errors of every open file of the project — a change in one file can break another. */
export async function refreshDiagnostics(projectId: string): Promise<void> {
  if (!projectServed(projectId)) return
  const paths = useEditor
    .getState()
    .tabs.filter((t) => t.projectId === projectId)
    .map((t) => t.path)
    .filter((path) => {
      const model = monaco.editor.getModel(uriOf({ projectId, path }))
      return !!model && LANGUAGES.includes(model.getLanguageId())
    })
  if (!paths.length) return
  const result = await ipc('lsp:diagnostics', { projectId, paths }).catch(() => null)
  if (!result) return
  for (const [path, diagnostics] of Object.entries(result)) {
    const model = monaco.editor.getModel(uriOf({ projectId, path }))
    if (!model) continue
    monaco.editor.setModelMarkers(
      model,
      OWNER,
      diagnostics.map((d) => ({
        startLineNumber: d.range.start.line,
        startColumn: d.range.start.offset,
        endLineNumber: d.range.end.line,
        endColumn: d.range.end.offset,
        message: d.message,
        severity: SEVERITY[d.severity],
        code: d.code === undefined ? undefined : String(d.code),
        source: d.source ?? 'ts',
        tags: [...(d.unnecessary ? [monaco.MarkerTag.Unnecessary] : []), ...(d.deprecated ? [monaco.MarkerTag.Deprecated] : [])]
      }))
    )
  }
  useProblems.getState().report(projectId, result)
}

// --- edits across files ---

/** Monaco edits for files that have a model; the rest is written to disk directly. */
async function workspaceEdit(projectId: string, files: LspFileEdits[]): Promise<monaco.languages.WorkspaceEdit> {
  const edits: monaco.languages.IWorkspaceTextEdit[] = []
  for (const f of files) {
    const resource = uriOf({ projectId, path: f.path })
    if (monaco.editor.getModel(resource)) {
      for (const e of f.edits) edits.push({ resource, versionId: undefined, textEdit: { range: toRange(e.range), text: e.newText } })
      continue
    }
    const file = await ipc('files:read', { projectId, path: f.path }).catch(() => null)
    if (file?.content === undefined) continue
    await ipc('files:write', { projectId, path: f.path, content: applyEdits(file.content, f.edits), expectedMtime: file.mtimeMs }).catch(() => {})
  }
  return { edits }
}

/** Apply 1-based line/offset edits to a text (last first, so earlier positions stay valid). */
export function applyEdits(text: string, edits: LspTextEdit[]): string {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1)
  const index = (p: { line: number; offset: number }) => (starts[p.line - 1] ?? text.length) + p.offset - 1
  return [...edits]
    .sort((a, b) => index(b.range.start) - index(a.range.start))
    .reduce((out, e) => out.slice(0, index(e.range.start)) + e.newText + out.slice(index(e.range.end)), text)
}

/** Peek views need a model for each file they show: load the ones not open yet. */
async function ensureModels(projectId: string, paths: string[]): Promise<void> {
  const missing = [...new Set(paths)].filter((path) => !monaco.editor.getModel(uriOf({ projectId, path }))).slice(0, MAX_PEEK_FILES)
  await Promise.all(
    missing.map(async (path) => {
      const file = await ipc('files:read', { projectId, path }).catch(() => null)
      const uri = uriOf({ projectId, path })
      if (file?.content !== undefined && !monaco.editor.getModel(uri)) monaco.editor.createModel(file.content, undefined, uri)
    })
  )
}

// --- providers ---

const K = monaco.languages.CompletionItemKind
const KINDS: Record<string, monaco.languages.CompletionItemKind> = {
  keyword: K.Keyword,
  script: K.File,
  module: K.Module,
  'external module name': K.Module,
  class: K.Class,
  'local class': K.Class,
  interface: K.Interface,
  type: K.Interface,
  enum: K.Enum,
  'enum member': K.EnumMember,
  var: K.Variable,
  'local var': K.Variable,
  let: K.Variable,
  parameter: K.Variable,
  const: K.Constant,
  function: K.Function,
  'local function': K.Function,
  method: K.Method,
  constructor: K.Constructor,
  getter: K.Property,
  setter: K.Property,
  property: K.Property,
  'type parameter': K.TypeParameter,
  alias: K.Reference,
  string: K.Value,
  directory: K.Folder,
  snippet: K.Snippet
}

/** A language server's symbol for Monaco (whose kinds count from 0, LSP's from 1). */
function documentSymbol(s: LspSymbol): monaco.languages.DocumentSymbol {
  return { name: s.name, detail: s.detail ?? '', kind: s.kind - 1, tags: [], range: toRange(s.range), selectionRange: toRange(s.selection), children: s.children.map(documentSymbol) }
}

/** What resolving a completion needs back (kept per suggestion object). */
const completionData = new WeakMap<monaco.languages.CompletionItem, { file: File; line: number; offset: number; name: string; source?: string; data?: unknown }>()

let registered = false

/**
 * Wire Monaco to the project's tsserver: document sync, diagnostics, and the
 * language features VS Code gets from it. Runs once; models opened later are
 * picked up as they appear.
 */
export function setupLsp(): void {
  if (registered) return
  registered = true
  monaco.editor.getModels().forEach(track)
  monaco.editor.onDidCreateModel(track)
  // A language server published diagnostics; one was installed (Settings) — open files try again.
  onEvent('lsp:diagnostics', ({ projectId }) => scheduleDiagnostics(projectId))
  useLanguages.subscribe((s, prev) => {
    if (s.toolsVersion !== prev.toolsVersion) reopeners.forEach((reopen) => reopen())
  })

  // "Go to definition" into another file opens it as a tab.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selection) {
      const file = fileOf(resource)
      if (!file || file.projectId !== useEditor.getState().projectId) return false
      const line = !selection ? 1 : 'startLineNumber' in selection ? selection.startLineNumber : selection.lineNumber
      void useEditor.getState().openAt(file.path, line)
      return true
    }
  })

  // Symbols (outline, breadcrumbs, ⇧⌘O) from the language servers — TypeScript's built-in service has its own.
  for (const language of SERVED_LANGUAGES.flatMap((l) => l.monaco)) {
    monaco.languages.registerDocumentSymbolProvider(language, {
      async provideDocumentSymbols(model) {
        const file = await ready(model)
        if (!file) return []
        const found = await ipc('lsp:symbols', file).catch(() => [])
        return found.map(documentSymbol)
      }
    })
  }

  for (const language of LANGUAGES) {
    monaco.languages.registerHoverProvider(language, {
      async provideHover(model, position) {
        if (!(await ready(model))) return null
        const hover = await ipc('lsp:hover', at(model, position)).catch(() => null)
        if (!hover) return null
        return {
          range: hover.range && toRange(hover.range),
          contents: hover.markdown
            ? [{ value: hover.markdown }]
            : [{ value: `\`\`\`typescript\n${hover.display}\n\`\`\`` }, ...(hover.documentation ? [{ value: hover.documentation }] : [])]
        }
      }
    })

    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.', '"', "'", '`', '/', '@', '<', '#'],
      async provideCompletionItems(model, position, context) {
        const file = await ready(model)
        if (!file) return { suggestions: [] }
        const where = at(model, position)
        const entries = await ipc('lsp:completions', { ...where, trigger: context.triggerCharacter }).catch(() => [])
        const word = model.getWordUntilPosition(position)
        const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
        return {
          suggestions: entries.map((e) => {
            const item: monaco.languages.CompletionItem = {
              label: e.source || e.detail ? { label: e.name, description: e.source ?? e.detail } : e.name,
              kind: KINDS[e.kind] ?? K.Text,
              sortText: e.sortText,
              insertText: e.insertText ?? e.name,
              insertTextRules: e.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              range: e.replacement ? toRange(e.replacement) : fallback
            }
            completionData.set(item, { file, line: where.line, offset: where.offset, name: e.name, source: e.source, data: e.data })
            return item
          })
        }
      },
      async resolveCompletionItem(item) {
        const d = completionData.get(item)
        if (!d) return item
        const details = await ipc('lsp:completionDetails', { ...d.file, line: d.line, offset: d.offset, name: d.name, source: d.source, data: d.data }).catch(() => null)
        if (!details) return item
        return {
          ...item,
          detail: details.detail,
          documentation: details.documentation ? { value: details.documentation } : undefined,
          additionalTextEdits: details.edits.map((e) => ({ range: toRange(e.range), text: e.newText }))
        }
      }
    })

    monaco.languages.registerDefinitionProvider(language, {
      async provideDefinition(model, position) {
        const file = await ready(model)
        if (!file) return null
        const found = await ipc('lsp:definition', at(model, position)).catch(() => [])
        await ensureModels(file.projectId, found.map((l) => l.path))
        return found.map((l) => ({ uri: uriOf({ projectId: file.projectId, path: l.path }), range: toRange(l.range) }))
      }
    })

    monaco.languages.registerReferenceProvider(language, {
      async provideReferences(model, position) {
        const file = await ready(model)
        if (!file) return null
        const found = await ipc('lsp:references', at(model, position)).catch(() => [])
        await ensureModels(file.projectId, found.map((l) => l.path))
        return found.map((l) => ({ uri: uriOf({ projectId: file.projectId, path: l.path }), range: toRange(l.range) }))
      }
    })

    monaco.languages.registerRenameProvider(language, {
      async provideRenameEdits(model, position, newName) {
        const file = await ready(model)
        if (!file) return null
        const result = await ipc('lsp:rename', { ...at(model, position), newName }).catch((err: Error) => ({ error: err.message, files: [] }))
        if (result.error) return { edits: [], rejectReason: result.error }
        return workspaceEdit(file.projectId, result.files)
      }
    })

    monaco.languages.registerSignatureHelpProvider(language, {
      signatureHelpTriggerCharacters: ['(', ',', '<'],
      signatureHelpRetriggerCharacters: [')'],
      async provideSignatureHelp(model, position) {
        if (!(await ready(model))) return null
        const help = await ipc('lsp:signature', at(model, position)).catch(() => null)
        if (!help) return null
        return {
          value: {
            signatures: help.items.map((s) => ({
              label: s.label,
              documentation: s.documentation ? { value: s.documentation } : undefined,
              parameters: s.parameters.map((p) => ({ label: p.label, documentation: p.documentation || undefined }))
            })),
            activeSignature: help.active,
            activeParameter: help.activeParameter
          },
          dispose() {}
        }
      }
    })

    monaco.languages.registerCodeActionProvider(language, {
      async provideCodeActions(model, _range, context) {
        const file = await ready(model)
        const markers = context.markers.filter((m) => m.source)
        if (!file || !markers.length) return { actions: [], dispose() {} }
        const actions: monaco.languages.CodeAction[] = []
        for (const marker of markers) {
          const range = { start: { line: marker.startLineNumber, offset: marker.startColumn }, end: { line: marker.endLineNumber, offset: marker.endColumn } }
          // TypeScript fixes per error number; language servers fix whatever they reported in the range.
          const code = Number(marker.code)
          const fixes = await ipc('lsp:codeFixes', { ...file, range, errorCodes: Number.isInteger(code) ? [code] : [] }).catch(() => [])
          for (const fix of fixes) {
            if (actions.some((a) => a.title === fix.title)) continue
            actions.push({ title: fix.title, kind: 'quickfix', diagnostics: [marker], edit: await workspaceEdit(file.projectId, fix.files), isPreferred: actions.length === 0 })
          }
        }
        return { actions, dispose() {} }
      }
    })
  }
}

