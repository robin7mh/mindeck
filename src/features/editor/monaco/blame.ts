import { ipc } from '@shared/ipc/client'
import { UNCOMMITTED, type ScmBlame } from '@shared/types/scm'
import { monaco } from './setup'
import { BLAME_BLANK, blameHover, gutterLabel, inlineLabel, useBlame } from '../blame'
import { useEditorPrefs } from '../prefs'
import { useScm } from '../scm'

type File = { id: string; projectId: string; path: string }

/** Blame again this long after the last keystroke (the buffer's lines move). */
const BLAME_MS = 800

/**
 * Git blame in the editor: who last changed the cursor's line, dimmed after
 * it (on unless switched off in the settings), and — per file, on demand — a
 * blame column in front of every line (commit, author, date; a click shows
 * the commit in the graph). Blames the buffer, so unsaved lines are "not
 * committed yet" and the numbers always match.
 */
export function attachBlame(editor: monaco.editor.IStandaloneCodeEditor, current: () => File | undefined): () => void {
  const inline = editor.createDecorationsCollection()
  const column = editor.createDecorationsCollection()
  let blame: ScmBlame | null = null
  let timer: number | undefined
  let seq = 0

  const inlineOn = () => useEditorPrefs.getState().settings.inlineBlame !== false
  const columnOn = (file: File) => !!useBlame.getState().shown[file.id]
  const commitAt = (line: number) => blame!.commits[blame!.lines[line - 1]]

  const paintInline = () => {
    const pos = editor.getPosition()
    const label = blame && pos && inlineOn() ? inlineLabel(commitAt(pos.lineNumber)) : ''
    if (!label) return inline.clear()
    const col = editor.getModel()!.getLineMaxColumn(pos!.lineNumber)
    inline.set([{ range: new monaco.Range(pos!.lineNumber, col, pos!.lineNumber, col), options: { after: { content: `   ${label}`, inlineClassName: 'mindeck-blame-inline' } } }])
  }

  const paintColumn = () => {
    const file = current()
    const model = editor.getModel()
    if (!blame || !file || !model || !columnOn(file)) return column.clear()
    const lines = blame.lines
    column.set(
      Array.from({ length: model.getLineCount() }, (_, i) => {
        const first = i === 0 || lines[i] !== lines[i - 1]
        const commit = commitAt(i + 1)
        return {
          range: new monaco.Range(i + 1, 1, i + 1, 1),
          options: {
            before: { content: first ? gutterLabel(commit) : BLAME_BLANK, inlineClassName: first && i > 0 ? 'mindeck-blame-hunk' : 'mindeck-blame-line', cursorStops: monaco.editor.InjectedTextCursorStops.None },
            ...(first && commit ? { hoverMessage: { value: blameHover(commit) } } : {})
          }
        }
      })
    )
  }

  const paint = () => {
    paintInline()
    paintColumn()
  }

  const load = async () => {
    const file = current()
    const model = editor.getModel()
    const n = (seq += 1)
    if (!file || !model || !useScm.getState().status?.repo || !(inlineOn() || columnOn(file))) {
      blame = null
      return paint()
    }
    const result = await ipc('scm:blame', { projectId: file.projectId, path: file.path, text: model.getValue() }).catch(() => null)
    // Another file, or a newer blame, by now.
    if (n !== seq) return
    blame = result
    paint()
  }

  const subs = [
    editor.onDidChangeModel(() => {
      blame = null
      paint()
      // The view records which tab it shows right after switching models.
      void Promise.resolve().then(load)
    }),
    editor.onDidChangeModelContent(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void load(), BLAME_MS)
    }),
    editor.onDidChangeCursorPosition(paintInline),
    editor.onMouseDown((e) => {
      const line = e.target.position?.lineNumber
      const injected = e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT && !!(e.target.detail as { injectedText?: unknown } | undefined)?.injectedText
      const hash = blame && line && injected ? blame.lines[line - 1] : undefined
      if (!hash || hash === UNCOMMITTED) return
      const scm = useScm.getState()
      scm.closeDiff()
      void scm.select(hash)
      scm.setPane('graph')
    })
  ]
  const unsubscribe = [
    // A commit (or checkout) changes who wrote what.
    useScm.subscribe((s, prev) => {
      if (s.status?.head !== prev.status?.head || s.status?.repo !== prev.status?.repo) void load()
    }),
    useEditorPrefs.subscribe((s, prev) => {
      if (s.settings.inlineBlame !== prev.settings.inlineBlame) void load()
    }),
    useBlame.subscribe((s, prev) => {
      if (s.shown !== prev.shown) void load()
    })
  ]
  void load()

  return () => {
    window.clearTimeout(timer)
    seq += 1
    unsubscribe.forEach((u) => u())
    subs.forEach((s) => s.dispose())
    inline.clear()
    column.clear()
  }
}
