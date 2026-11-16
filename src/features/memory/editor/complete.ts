import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { NoteMeta } from '@shared/types/memory'
import { allTags, linkText } from '../links'

/** Inserts `text]]` — or only `text` when the `]]` is already there — and puts the cursor after it. */
function insertLink(text: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const closed = view.state.sliceDoc(to, to + 2) === ']]'
    const insert = closed ? text : `${text}]]`
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (closed ? 2 : 0) } })
  }
}

/**
 * Obsidian's completions: `[[` suggests notes (name, folder as detail),
 * `#` suggests the vault's tags. `notes` is read on every keystroke, so the
 * list is always current.
 */
export function noteCompletions(notes: () => NoteMeta[]): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const link = ctx.matchBefore(/\[\[[^\]\n|#^]*$/)
    if (link) {
      const all = notes()
      return {
        from: link.from + 2,
        options: all.map((n) => ({ label: n.title, detail: n.folder || undefined, type: 'text', apply: insertLink(linkText(n, all)) })),
        validFor: /^[^\]\n|#^]*$/
      }
    }
    const tag = ctx.matchBefore(/(?:^|[\s(,])#[\p{L}\p{N}_\-/]*$/u)
    if (!tag) return null
    const hash = tag.from + tag.text.lastIndexOf('#')
    // A lone "#" may start a heading — suggest once something follows it (or on Ctrl-Space).
    if (hash + 1 === tag.to && !ctx.explicit) return null
    return {
      from: hash + 1,
      options: allTags(notes()).map((t) => ({ label: t, type: 'keyword' })),
      validFor: /^[\p{L}\p{N}_\-/]*$/u
    }
  }
}
