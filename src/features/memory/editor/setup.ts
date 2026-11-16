import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Annotation, EditorSelection, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder, type Command } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import type { NoteMeta } from '@shared/types/memory'
import { noteCompletions } from './complete'
import { linkClicks, liveHooks, type LiveHooks } from './livePreview'
import { pictureDrops } from './pictures'
import { ObsidianSyntax } from './syntax'

/** Source mode colors — classes, so the theme tokens in index.css decide (`.cm-md-hl-*`). */
const noteHighlight = HighlightStyle.define([
  { tag: tags.heading, class: 'cm-md-hl-heading' },
  { tag: tags.strong, class: 'cm-md-hl-strong' },
  { tag: tags.emphasis, class: 'cm-md-hl-em' },
  { tag: tags.strikethrough, class: 'cm-md-hl-strike' },
  { tag: [tags.link, tags.url], class: 'cm-md-hl-link' },
  { tag: tags.monospace, class: 'cm-md-hl-code' },
  { tag: tags.quote, class: 'cm-md-hl-quote' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.meta], class: 'cm-md-hl-mark' },
  { tag: tags.labelName, class: 'cm-md-hl-tag' }
])

/** Marks a change that came from the file (an external edit), not from typing. */
export const fromOutside = Annotation.define<boolean>()

/** ⌘B / ⌘I: wrap the selection in `**` / `*` — or unwrap it when it already is. */
export function toggleWrap(marker: string): Command {
  return (view) => {
    const { state } = view
    view.dispatch(
      state.changeByRange((range) => {
        const n = marker.length
        if (state.sliceDoc(Math.max(0, range.from - n), range.from) === marker && state.sliceDoc(range.to, range.to + n) === marker) {
          return {
            changes: [
              { from: range.from - n, to: range.from },
              { from: range.to, to: range.to + n }
            ],
            range: EditorSelection.range(range.from - n, range.to - n)
          }
        }
        return {
          changes: [
            { from: range.from, insert: marker },
            { from: range.to, insert: marker }
          ],
          range: EditorSelection.range(range.from + n, range.to + n)
        }
      })
    )
    return true
  }
}

export interface NoteEditorSetup {
  hooks: LiveHooks
  notes: () => NoteMeta[]
  /** Save a pasted/dropped picture; returns what goes into `![[…]]`. */
  attach: (file: File) => Promise<string | null>
  onChange: (text: string) => void
  placeholder: string
}

/** Everything the note editor is made of, except Live Preview itself (a mode switch). */
export function noteEditorExtensions(s: NoteEditorSetup): Extension[] {
  return [
    history(),
    keymap.of([
      { key: 'Mod-b', run: toggleWrap('**') },
      { key: 'Mod-i', run: toggleWrap('*') },
      ...completionKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab
    ]),
    markdown({ base: markdownLanguage, extensions: [ObsidianSyntax] }),
    syntaxHighlighting(noteHighlight),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'true' }),
    placeholder(s.placeholder),
    autocompletion({ override: [noteCompletions(s.notes)], icons: false }),
    liveHooks.of(s.hooks),
    linkClicks,
    pictureDrops(s.attach),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.every((t) => t.annotation(fromOutside))) s.onChange(u.state.doc.toString())
    })
  ]
}
