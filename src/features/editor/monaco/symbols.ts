import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices.js'
import { ICommandService } from 'monaco-editor/platform/commands/common/commands.js'
import { monaco } from './setup'
import { fileOf } from './uri'
import { tabKey } from '../store'
import { sortSymbols, useOutline, type OutlineSymbol, type SymbolRange } from '../outline'

/** Symbols are asked for this long after the last keystroke. */
const SYMBOLS_MS = 300

const range = (r: monaco.IRange): SymbolRange => ({ startLine: r.startLineNumber, startColumn: r.startColumn, endLine: r.endLineNumber, endColumn: r.endColumn })

function toOutline(s: monaco.languages.DocumentSymbol): OutlineSymbol {
  return { name: s.name, detail: s.detail || undefined, kind: s.kind, range: range(s.range), selection: range(s.selectionRange), children: (s.children ?? []).map(toOutline) }
}

/**
 * A model's symbols from every provider Monaco knows for its language — the
 * built-in TypeScript, CSS, HTML and JSON services and the language servers
 * (monaco/lsp.ts) — through the command behind ⇧⌘O. Empty when there are none.
 */
export async function documentSymbols(model: monaco.editor.ITextModel): Promise<OutlineSymbol[]> {
  try {
    const commands = StandaloneServices.get<{ executeCommand<T>(id: string, ...args: unknown[]): Promise<T> }>(ICommandService)
    const found = await commands.executeCommand<monaco.languages.DocumentSymbol[] | undefined>('_executeDocumentSymbolProvider', model.uri)
    return sortSymbols((found ?? []).map(toOutline))
  } catch {
    return []
  }
}

/** The model version each file's symbols were read at — editors showing the same file ask once. */
const known = new Map<string, number>()
const watched = new WeakSet<monaco.editor.ITextModel>()

const idOf = (model: monaco.editor.ITextModel) => {
  const file = fileOf(model.uri)
  return file && tabKey(file.projectId, file.path)
}

/**
 * Keep the outline store in step with the file an editor shows: its symbols
 * now, after a switch and a while after each edit. Returns the detach.
 */
export function attachSymbols(editor: monaco.editor.IStandaloneCodeEditor): () => void {
  let timer: number | undefined
  let attached = true
  const read = async () => {
    const model = editor.getModel()
    const id = model && idOf(model)
    if (!model || !id || known.get(id) === model.getVersionId()) return
    known.set(id, model.getVersionId())
    if (!watched.has(model)) {
      watched.add(model)
      model.onWillDispose(() => {
        known.delete(id)
        useOutline.getState().forget(id)
      })
    }
    const symbols = await documentSymbols(model)
    // None (yet — a language server may still be starting): the next occasion asks again.
    if (!symbols.length) known.delete(id)
    if (attached && !model.isDisposed()) useOutline.getState().setSymbols(id, symbols)
  }
  const later = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void read(), SYMBOLS_MS)
  }
  const subs = [
    editor.onDidChangeModel(() => void read()),
    editor.onDidChangeModelContent(later),
    // A language server that just came up reports diagnostics: by then it has symbols, too.
    monaco.editor.onDidChangeMarkers((uris) => {
      const model = editor.getModel()
      const id = model && idOf(model)
      if (id && !known.has(id) && uris.some((u) => u.toString() === model!.uri.toString())) later()
    })
  ]
  void read()
  return () => {
    attached = false
    window.clearTimeout(timer)
    subs.forEach((s) => s.dispose())
  }
}
