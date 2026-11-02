import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { NoteMeta } from '@shared/types/memory'
import { livePreview, refreshLive } from '../editor/livePreview'
import { fromOutside, noteEditorExtensions } from '../editor/setup'
import { findNote } from '../links'

export interface MarkdownEditorHandle {
  /** Put text at the cursor (replacing the selection), e.g. a filled template. */
  insert(text: string): void
}

interface Props {
  value: string
  /** Live Preview (Obsidian's default) or plain Markdown source. */
  live: boolean
  notes: NoteMeta[]
  placeholder: string
  onChange: (text: string) => void
  onOpenNote: (target: string) => void
  onOpenUrl: (url: string) => void
  onAttach: (file: File) => Promise<string | null>
  loadImage: (target: string) => Promise<string | null>
}

/**
 * The note text in CodeMirror 6 — the editor Obsidian is built on: Live
 * Preview or source, `[[` / `#` completion, links that follow on click,
 * pictures by paste or drop. Mounted once per note (keyed by path); the
 * callbacks are read through a ref, so they may change on every render.
 */
export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(p, ref) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>()
  const props = useRef(p)
  props.current = p
  const mode = useRef(new Compartment())

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.current.value,
        extensions: [
          noteEditorExtensions({
            hooks: {
              resolves: (target) => !!findNote(target, props.current.notes),
              image: (target) => props.current.loadImage(target),
              openNote: (target) => props.current.onOpenNote(target),
              openUrl: (url) => props.current.onOpenUrl(url)
            },
            notes: () => props.current.notes,
            attach: (file) => props.current.onAttach(file),
            onChange: (text) => props.current.onChange(text),
            placeholder: props.current.placeholder
          }),
          mode.current.of(props.current.live ? livePreview : [])
        ]
      })
    })
    view.current = v
    v.focus()
    return () => v.destroy()
  }, [])

  // The file changed underneath (an external edit, a link rewritten by a rename): follow it.
  useEffect(() => {
    const v = view.current!
    if (v.state.doc.toString() === p.value) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: p.value }, annotations: fromOutside.of(true) })
  }, [p.value])

  useEffect(() => {
    view.current!.dispatch({ effects: mode.current.reconfigure(p.live ? livePreview : []) })
  }, [p.live])

  // Notes appeared or went: links may (no longer) resolve.
  useEffect(() => {
    view.current!.dispatch({ effects: refreshLive.of(null) })
  }, [p.notes])

  useImperativeHandle(ref, () => ({
    insert(text) {
      const v = view.current!
      const { from, to } = v.state.selection.main
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
      v.focus()
    }
  }))

  return <div ref={host} className="note-editor h-full min-h-[300px]" />
})
