import { EditorView } from '@codemirror/view'

/** Pictures in a paste or a drop. */
function pictures(files?: FileList | null): File[] {
  return [...(files ?? [])].filter((f) => f.type.startsWith('image/'))
}

/**
 * Pasting or dropping pictures into a note: each is saved into the vault by
 * `save` (which returns what goes into `![[…]]`, or null when it failed) and
 * embedded where it was pasted or dropped.
 */
export function pictureDrops(save: (file: File) => Promise<string | null>) {
  const embed = async (view: EditorView, files: File[], from: number, to: number) => {
    const links: string[] = []
    for (const f of files) {
      const link = await save(f)
      if (link) links.push(`![[${link}]]`)
    }
    if (!links.length) return
    // The note may have changed while saving.
    const end = view.state.doc.length
    const insert = links.join('\n')
    view.dispatch({ changes: { from: Math.min(from, end), to: Math.min(to, end), insert }, selection: { anchor: Math.min(from, end) + insert.length } })
  }
  return EditorView.domEventHandlers({
    paste(e, view) {
      const files = pictures(e.clipboardData?.files)
      if (!files.length) return false
      e.preventDefault()
      const { from, to } = view.state.selection.main
      void embed(view, files, from, to)
      return true
    },
    drop(e, view) {
      const files = pictures(e.dataTransfer?.files)
      if (!files.length) return false
      e.preventDefault()
      const at = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head
      void embed(view, files, at, at)
      return true
    }
  })
}
