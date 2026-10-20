import { useEffect, useRef } from 'react'
import { applyMonacoTheme, languageName, monaco, THEME } from '../monaco/setup'
import { setBufferHost, useEditor, type EditorTab } from '../store'
import { useScm } from '../scm'
import { editorActions, setEditorActions, type EditorActionHost } from '../actions'
import { attachGutter } from '../monaco/gutter'
import { setupLsp } from '../monaco/lsp'
import { attachBreakpoints } from '../monaco/breakpoints'
import { attachConflicts } from '../monaco/conflicts'
import { attachBlame } from '../monaco/blame'
import { setupUserPrefs } from '../monaco/userPrefs'
import { monacoOptions, settingsFor, useEditorPrefs } from '../prefs'
import { addEditorActions, formatModel, replaceText, setupExtras } from '../monaco/extras'
import { fixAll, setupLint } from '../monaco/lint'
import { setupTestMarkers } from '../monaco/testMarkers'
import { addInlineEdit, setupInlineAi } from '../monaco/inlineAi'
import { attachVim } from '../monaco/vim'
import { attachSymbols } from '../monaco/symbols'
import { tidyBlankLines } from '../text'
import { APPEARANCE_ATTRIBUTES } from '@/lib/theme'
import { usePalette } from '@/features/palette/store'

/** An editor action's id without the instance prefix Monaco gives actions added to one editor. */
export const actionId = (id: string) => id.replace(/^vs\.editor\.ICodeEditor:\d+:/, '')

/** Formatting / fixing before a save waits at most this long (Prettier's or ESLint's first run starts a worker). */
const FORMAT_TIMEOUT_MS = 5000

export interface CursorInfo {
  line: number
  col: number
  language: string
}

interface Buffer {
  model: monaco.editor.ITextModel
  /** Tab revision whose disk text the model holds. */
  revision: number
  /** Alternative version id of the text on disk — differs ⇔ unsaved edits. */
  clean: number
}

/** An editor on screen (one per editor group): what it shows, and how to let go of a file. */
interface Viewer {
  editor: monaco.editor.IStandaloneCodeEditor
  /** Its palette actions. */
  actions: EditorActionHost
  shown: () => string | undefined
  /** The file closed: show nothing. */
  forget: () => void
  /** The file was renamed: its text lives in a new model now. */
  moved: (next: string, model: monaco.editor.ITextModel) => void
}

/**
 * Every open file's buffer — one model per file, shared by every group that
 * shows it (edits show everywhere at once, undo and "unsaved" are the file's;
 * scroll position and selection are each editor's own).
 */
const buffers = new Map<string, Buffer>()
const viewers = new Set<Viewer>()

/**
 * The last editor went away: the buffers go with it — unless another editor
 * came in the same render (groups closing and opening, another project's
 * layout), which takes them over.
 */
function release(): void {
  queueMicrotask(() => {
    if (viewers.size) return
    setBufferHost(null)
    setEditorActions(null)
    buffers.forEach((b) => b.model.dispose())
    buffers.clear()
  })
}

/** The editor showing a file (for the formatter that needs one). */
const showing = (id: string) => [...viewers].find((v) => v.shown() === id)?.editor

const OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  model: null,
  theme: THEME,
  automaticLayout: true,
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: true, renderCharacters: false, maxColumn: 80 },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  padding: { top: 10, bottom: 10 },
  bracketPairColorization: { enabled: true },
  guides: { indentation: true, bracketPairs: false },
  stickyScroll: { enabled: true },
  renderWhitespace: 'selection',
  // Breakpoints live in the glyph margin.
  glyphMargin: true,
  // Hovers and suggestions may overflow the panel instead of being clipped.
  fixedOverflowWidgets: true,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
}

/** The URI a project file's model lives at — language services and the editor opener key on it. */
export const fileUri = (projectId: string, path: string): monaco.Uri => monaco.Uri.file(`/${projectId}/${path}`)

/** A tab's model. One already there (a definition peeked at before the file was opened) takes the text. */
function createBufferModel(text: string, file: { projectId: string; path: string }): monaco.editor.ITextModel {
  const uri = fileUri(file.projectId, file.path)
  const existing = monaco.editor.getModel(uri)
  if (!existing) return monaco.editor.createModel(text, undefined, uri)
  existing.setValue(text)
  return existing
}

/** Keep the tab's dirty flag in step with the model (undoing back to the saved text is clean). */
function watchDirty(id: string, buf: Buffer): void {
  buf.model.onDidChangeContent(() => useEditor.getState().setDirty(id, buf.model.getAlternativeVersionId() !== buf.clean))
}

/** A tab's buffer: created on first sight, or brought up to a newer disk read (as one undoable edit). */
function ensureBuffer(tab: EditorTab, text: string): Buffer {
  const buf = buffers.get(tab.id)
  if (!buf) {
    const model = createBufferModel(text, tab)
    const created: Buffer = { model, revision: tab.revision, clean: model.getAlternativeVersionId() }
    watchDirty(tab.id, created)
    buffers.set(tab.id, created)
    return created
  }
  if (buf.revision !== tab.revision) {
    // Re-read from disk: one undoable edit, so the old text is a ⌘Z away.
    buf.model.pushEditOperations([], [{ range: buf.model.getFullModelRange(), text }], () => null)
    buf.revision = tab.revision
    buf.clean = buf.model.getAlternativeVersionId()
    useEditor.getState().setDirty(tab.id, false)
  }
  return buf
}

/** The buffers' side of saving, closing and renaming — one host, whichever editors show them. */
function registerBufferHost(): void {
  setBufferHost({
    // Before a save: tidy blank lines, format the document — as the user's settings for the language say.
    prepare: async (id) => {
      const b = buffers.get(id)
      // A notebook's JSON is written as Jupyter writes it: no formatter touches it.
      if (!b || b.model.uri.path.toLowerCase().endsWith('.ipynb')) return
      const prefs = settingsFor(useEditorPrefs.getState().settings, b.model.getLanguageId())
      if (prefs.blankLines?.onSave) replaceText(b.model, tidyBlankLines(b.model.getValue(), prefs.blankLines.keepOne))
      const limit = (work: Promise<unknown>) => Promise.race([work, new Promise((r) => setTimeout(r, FORMAT_TIMEOUT_MS))]).catch(() => {})
      if (prefs.formatOnSave) await limit(formatModel(b.model, prefs, showing(id)))
      if (prefs.eslintFixOnSave) await limit(fixAll(b.model))
    },
    snapshot: (id) => {
      const b = buffers.get(id)
      return b && { text: b.model.getValue(), version: b.model.getAlternativeVersionId() }
    },
    markClean: (id, version) => {
      const b = buffers.get(id)
      if (!b) return
      b.clean = version
      useEditor.getState().setDirty(id, b.model.getAlternativeVersionId() !== version)
    },
    drop: (id) => {
      const b = buffers.get(id)
      if (!b) return
      viewers.forEach((v) => v.shown() === id && v.forget())
      b.model.dispose()
      buffers.delete(id)
    },
    rekey: (id, next) => {
      const b = buffers.get(id)
      if (!b) return
      // A model's URI is fixed: the text moves into a new one (the undo history stays behind).
      const dirty = b.model.getAlternativeVersionId() !== b.clean
      const model = createBufferModel(b.model.getValue(), next)
      const moved: Buffer = { model, revision: b.revision, clean: dirty ? -1 : model.getAlternativeVersionId() }
      watchDirty(next.id, moved)
      buffers.set(next.id, moved)
      buffers.delete(id)
      viewers.forEach((v) => v.shown() === id && v.moved(next.id, model))
      b.model.dispose()
    },
    // Only called for a buffer that exists (editBuffer asks for its snapshot first).
    edit: (id, edits) => {
      const b = buffers.get(id)!
      // Its own undo step: ⌘Z takes back the replace, nothing else.
      b.model.pushStackElement()
      b.model.pushEditOperations(
        [],
        edits.map((e) => ({ range: new monaco.Range(e.line, e.column + 1, e.line, e.column + 1 + e.length), text: e.text })),
        () => null
      )
      b.model.pushStackElement()
    }
  })
}

interface Props {
  /** The tab to show — one without loaded text shows no buffer. */
  tab?: EditorTab
  readOnly: boolean
  onCursor: (info: CursorInfo) => void
  /** The editor group it is the editor of. */
  group: string
}

/**
 * A Monaco editor — one per editor group; every open file is a model (its own
 * text and undo history, a scroll position per editor) that is swapped in when
 * its tab becomes active. Edits stay in the model — the store only learns
 * "dirty or not" (from Monaco's version ids, so undoing back to the saved text
 * is clean again) and asks for the text when it saves. All groups' editors
 * share the models.
 */
export default function CodeEditor({ tab, readOnly, onCursor, group }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const vimRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  /** Scroll position and selection per file, in this editor. */
  const views = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>()).current
  const shown = useRef<string>()
  const cursorRef = useRef(onCursor)
  cursorRef.current = onCursor

  useEffect(() => {
    applyMonacoTheme()
    const editor = monaco.editor.create(hostRef.current!, OPTIONS)
    editorRef.current = editor

    const report = () => {
      const model = editor.getModel()
      const pos = editor.getPosition()
      if (model && pos) cursorRef.current({ line: pos.lineNumber, col: pos.column, language: languageName(model.getLanguageId()) })
    }
    const subs = [editor.onDidChangeCursorPosition(report), editor.onDidChangeModel(report)]

    // Mindeck's palette replaces Monaco's own (F1), and ⌃G goes through quick open, too.
    editor.addCommand(monaco.KeyCode.F1, () => usePalette.getState().show())
    editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyG, () => useScm.getState().setQuickOpen(true, ':'))
    setupLsp()
    setupUserPrefs()
    setupExtras()
    setupLint()
    setupTestMarkers()
    setupInlineAi()
    const actions = [...addEditorActions(editor), ...addInlineEdit(editor)]
    // The user's editor settings (moved over from VS Code / Cursor) for the file's language — now, on a switch, on a change.
    const applyPrefs = () => editor.updateOptions(monacoOptions(settingsFor(useEditorPrefs.getState().settings, editor.getModel()?.getLanguageId())))
    applyPrefs()
    subs.push(editor.onDidChangeModel(applyPrefs))
    const unsubscribePrefs = useEditorPrefs.subscribe((s, prev) => {
      if (s.settings !== prev.settings) applyPrefs()
    })
    const shownTab = () => useEditor.getState().tabs.find((t) => t.id === shown.current)
    const detachGutter = attachGutter(editor, shownTab)
    const detachBreakpoints = attachBreakpoints(editor, shownTab)
    const detachConflicts = attachConflicts(editor, shownTab)
    const detachBlame = attachBlame(editor, shownTab)
    const detachVim = attachVim(editor, vimRef.current!)
    const detachSymbols = attachSymbols(editor)
    const actionHost: EditorActionHost = {
      // Actions added to this editor carry an instance prefix ("vs.editor.ICodeEditor:4:mindeck.…"): the palette knows them by their own id.
      list: () => (editor.getModel() ? editor.getSupportedActions().map((a) => ({ id: actionId(a.id), label: a.label })) : []),
      run: (id) => {
        editor.focus()
        void editor
          .getSupportedActions()
          .find((a) => actionId(a.id) === id)
          ?.run()
      }
    }
    if (!viewers.size) registerBufferHost()
    // The focused group's editor gets the palette's editor commands; opening files and saving go to its group.
    subs.push(
      editor.onDidFocusEditorText(() => {
        setEditorActions(actionHost)
        useEditor.getState().focusGroup(group)
        report()
      })
    )
    const activate = () => {
      setEditorActions(actionHost)
      if (!editor.hasTextFocus()) editor.focus()
    }
    if (useEditor.getState().activeGroup === group || !editorActions()) setEditorActions(actionHost)
    // Focused from outside (⌘1…⌘9, a click on its tabs): its editor takes the keyboard.
    const unsubscribeGroup = useEditor.subscribe((s, prev) => {
      if (s.activeGroup !== prev.activeGroup && s.activeGroup === group) activate()
    })
    const viewer: Viewer = {
      editor,
      actions: actionHost,
      shown: () => shown.current,
      forget: () => {
        editor.setModel(null)
        shown.current = undefined
      },
      moved: (next, model) => {
        const view = editor.saveViewState()
        editor.setModel(model)
        editor.restoreViewState(view)
        views.set(next, view)
        shown.current = next
      }
    }
    viewers.add(viewer)

    // Follow the appearance settings (theme, accent, background).
    const theme = new MutationObserver(applyMonacoTheme)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: APPEARANCE_ATTRIBUTES })
    // Monaco measures glyph widths once; measure again when the bundled font is in.
    void document.fonts?.ready.then(() => monaco.editor.remeasureFonts())

    return () => {
      viewers.delete(viewer)
      // Its palette actions were in charge: another group's editor takes over.
      if (editorActions() === actionHost) setEditorActions([...viewers][0]?.actions ?? null)
      if (!viewers.size) release()
      unsubscribeGroup()
      actions.forEach((a) => a.dispose())
      detachGutter()
      detachBreakpoints()
      detachConflicts()
      detachBlame()
      detachVim()
      detachSymbols()
      unsubscribePrefs()
      theme.disconnect()
      subs.forEach((s) => s.dispose())
      editor.dispose()
      views.clear()
      shown.current = undefined
      editorRef.current = null
    }
  }, [views, group])

  useEffect(() => {
    editorRef.current!.updateOptions({ readOnly })
  }, [readOnly])

  // Show the tab: create its model on first sight, apply disk reloads.
  const text = tab?.content
  useEffect(() => {
    const editor = editorRef.current!
    if (shown.current && buffers.has(shown.current)) views.set(shown.current, editor.saveViewState())
    if (!tab || text === undefined) {
      editor.setModel(null)
      shown.current = undefined
      return
    }
    const buf = ensureBuffer(tab, text)
    const switched = shown.current !== tab.id
    if (switched) {
      editor.setModel(buf.model)
      shown.current = tab.id
    }
    const view = views.get(tab.id)
    if (view) editor.restoreViewState(view)
    // Only the focused group's editor takes the keyboard (a restored layout switches them all).
    if (switched && useEditor.getState().activeGroup === group) editor.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new tab, revision or text arriving; not every keystroke (the buffer has it)
  }, [views, tab?.id, tab?.revision, text === undefined])

  // A search result or a symbol asked for a line: scroll there once its tab is on screen (in its group).
  const reveal = useEditor((s) => s.reveal)
  useEffect(() => {
    if (!reveal || reveal.id !== shown.current || (reveal.group ?? useEditor.getState().activeGroup) !== group) return
    const editor = editorRef.current!
    editor.revealLineInCenter(reveal.line)
    const { match } = reveal
    if (!match) editor.setPosition({ lineNumber: reveal.line, column: 1 })
    else editor.setSelection(new monaco.Range(reveal.line, match.column + 1, reveal.line, match.column + 1 + match.length))
    editor.focus()
    useEditor.setState({ reveal: undefined })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the asked-for tab is on screen; group is fixed per editor
  }, [reveal, tab?.id, text === undefined])

  return (
    <>
      <div ref={hostRef} className="absolute inset-0" />
      {/* Vim's mode, pending keys and `:` command line. */}
      <div ref={vimRef} aria-label="Vim" className="absolute bottom-1 left-14 z-10 rounded-sm bg-elevated/90 px-2 py-0.5 font-mono text-[11px] text-text-secondary [&_input]:bg-transparent [&_input]:text-text-primary [&_input]:outline-hidden" />
    </>
  )
}
