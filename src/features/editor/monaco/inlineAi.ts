import { errorMessage, IpcError, ipc, onEvent } from '@shared/ipc/client'
import type { AiStatus } from '@shared/types/ai'
import { getT } from '@/lib/i18n'
import { useAssistant } from '@/features/agents/store'
import { monaco } from './setup'
import { fileOf } from './uri'
import { useEditor } from '../store'

type Editor = monaco.editor.IStandaloneCodeEditor
type Model = monaco.editor.ITextModel

/** What a suggestion sees of the file around the cursor. */
const PREFIX = 12_000
const SUFFIX = 4_000
/** What a ⌘K edit sees around the selection. */
const BEFORE = 200_000
const AFTER = 100_000
/** A pause this long in typing asks for a suggestion. */
const DEBOUNCE_MS = 350
const WIDGET_HEIGHT = 46

let status: AiStatus | undefined
let registered = false

/** Suggestions while typing: switched on in Settings → AI, with the user's own key (never on the account's credit). */
export const suggesting = () => (status?.source === 'env' || status?.source === 'stored') && !!status.settings.inline

const newId = () => crypto.randomUUID()

/** The suggestion at the cursor, as Monaco's ghost text (Tab accepts it). */
export const inlineCompletions: monaco.languages.InlineCompletionsProvider = {
  debounceDelayMs: DEBOUNCE_MS,
  async provideInlineCompletions(model, position, _context, token) {
    const file = fileOf(model.uri)
    if (!file || !suggesting()) return { items: [] }
    const offset = model.getOffsetAt(position)
    const text = model.getValue()
    const requestId = newId()
    const cancelled = token.onCancellationRequested(() => void ipc('ai:inlineCancel', { requestId }).catch(() => {}))
    const insertText = await ipc('ai:inlineComplete', {
      requestId,
      path: file.path,
      language: model.getLanguageId(),
      prefix: text.slice(Math.max(0, offset - PREFIX), offset),
      suffix: text.slice(offset, offset + SUFFIX)
    })
      // No key, offline, rate limited: no suggestion (the assistant's settings say why).
      .catch(() => '')
      .finally(() => cancelled.dispose())
    if (!insertText || token.isCancellationRequested) return { items: [] }
    return {
      items: [
        {
          insertText,
          range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
        }
      ]
    }
  },
  disposeInlineCompletions() {}
}

/** Tab suggestions for every file of a project; they follow the AI settings. */
export function setupInlineAi(): void {
  if (registered) return
  registered = true
  status = useAssistant.getState().status
  if (!status)
    void ipc('ai:status').then(
      (s) => (status ??= s),
      () => {}
    )
  useAssistant.subscribe((s) => {
    if (s.status) status = s.status
  })
  monaco.languages.registerInlineCompletionsProvider({ scheme: 'file' }, inlineCompletions)
}

// --- ⌘K: edit with AI ---

interface Session {
  editor: Editor
  model: Model
  zoneId?: string
  widget: monaco.editor.IOverlayWidget
  dom: {
    root: HTMLDivElement
    input: HTMLInputElement
    note: HTMLSpanElement
    buttons: HTMLDivElement
  }
  /** The text the edit replaces, kept for a rejection. */
  original: string
  target: monaco.editor.IEditorDecorationsCollection
  requestId?: string
  phase: 'ask' | 'writing' | 'review'
}

const sessions = new Map<Editor, Session>()
const pending = new Map<Editor, monaco.editor.IContextKey<boolean>>()

const button = (label: string, onClick: () => void, primary = false) => {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.className = primary
    ? 'rounded-sm border border-cyan/50 bg-cyan/15 px-2 py-0.5 font-sans text-[11.5px] text-cyan hover:bg-cyan/25'
    : 'rounded-sm border border-hud px-2 py-0.5 font-sans text-[11.5px] text-text-secondary hover:text-text-primary'
  b.onmousedown = (e) => e.preventDefault()
  b.onclick = onClick
  return b
}

function setButtons(s: Session, ...buttons: HTMLButtonElement[]): void {
  s.dom.buttons.replaceChildren(...buttons)
}

/** The edit's range as it stands now (it moves with typing elsewhere). */
const rangeOf = (s: Session) => s.target.getRange(0)!

function close(s: Session): void {
  if (s.requestId) void ipc('ai:inlineCancel', { requestId: s.requestId }).catch(() => {})
  s.target.clear()
  s.editor.changeViewZones((zones) => s.zoneId && zones.removeZone(s.zoneId))
  s.editor.removeOverlayWidget(s.widget)
  sessions.delete(s.editor)
  pending.get(s.editor)?.set(false)
  s.editor.focus()
}

/** Keep what the AI wrote. */
export function acceptInlineEdit(editor: Editor): void {
  const s = sessions.get(editor)
  if (s?.phase === 'review') close(s)
}

/** Put back what was there (one undoable edit). */
export function rejectInlineEdit(editor: Editor): void {
  const s = sessions.get(editor)
  if (!s) return
  if (s.phase === 'review') editor.executeEdits('mindeck.inlineEdit', [{ range: rangeOf(s), text: s.original }])
  close(s)
}

async function write(s: Session): Promise<void> {
  const t = getT().inlineAi
  const instruction = s.dom.input.value.trim()
  const file = fileOf(s.model.uri)
  if (!instruction || !file) return
  const range = rangeOf(s)
  const text = s.model.getValue()
  const start = s.model.getOffsetAt(range.getStartPosition())
  const end = s.model.getOffsetAt(range.getEndPosition())
  const requestId = newId()
  s.requestId = requestId
  s.phase = 'writing'
  s.dom.input.disabled = true
  let written = ''
  s.dom.note.textContent = t.writing(0)
  setButtons(
    s,
    button(t.stop, () => close(s))
  )
  const off = onEvent('ai:inlineDelta', (d) => {
    if (d.requestId !== requestId) return
    written += d.text
    s.dom.note.textContent = t.writing(written.split('\n').length)
  })
  try {
    const result = await ipc('ai:inlineEdit', {
      requestId,
      path: file.path,
      language: s.model.getLanguageId(),
      before: text.slice(Math.max(0, start - BEFORE), start),
      selection: text.slice(start, end),
      after: text.slice(end, end + AFTER),
      instruction
    })
    if (sessions.get(s.editor) !== s) return
    s.requestId = undefined
    const at = rangeOf(s)
    s.editor.executeEdits('mindeck.inlineEdit', [{ range: at, text: result, forceMoveMarkers: true }])
    const from = s.model.getOffsetAt(at.getStartPosition())
    const startPos = s.model.getPositionAt(from)
    const endPos = s.model.getPositionAt(from + result.length)
    s.target.set([
      {
        range: new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
        options: {
          className: 'mindeck-ai-added',
          isWholeLine: true,
          linesDecorationsClassName: 'mindeck-ai-added-gutter',
          stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges
        }
      }
    ])
    s.phase = 'review'
    s.dom.note.textContent = ''
    setButtons(
      s,
      button(t.accept, () => acceptInlineEdit(s.editor), true),
      button(t.reject, () => rejectInlineEdit(s.editor))
    )
    pending.get(s.editor)?.set(true)
    s.editor.focus()
  } catch (err) {
    if (sessions.get(s.editor) !== s) return
    s.requestId = undefined
    s.phase = 'ask'
    s.dom.input.disabled = false
    s.dom.note.textContent = err instanceof IpcError && err.code === 'no-key' ? t.noKey : t.failed(errorMessage(err))
    setButtons(s)
    s.dom.input.focus()
  } finally {
    off()
  }
}

/** ⌘K: a prompt above the selection (whole lines) or the cursor; the answer replaces it, to accept or reject. */
export function startInlineEdit(editor: Editor): void {
  const model = editor.getModel()
  const selection = editor.getSelection()
  if (!model || !selection || !fileOf(model.uri)) return
  const open = sessions.get(editor)
  if (open) {
    if (open.phase === 'ask') open.dom.input.focus()
    return
  }
  const t = getT().inlineAi
  const empty = selection.isEmpty()
  // Whole lines; a selection that ends at the start of a line leaves that line out (as VS Code does).
  const last = !empty && selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber
  const range = empty ? selection : new monaco.Range(selection.startLineNumber, 1, last, model.getLineMaxColumn(last))

  const root = document.createElement('div')
  root.className = 'flex items-center gap-2 rounded-md border border-cyan/40 bg-elevated px-2 py-1.5 shadow-lg'
  root.style.height = `${WIDGET_HEIGHT - 8}px`
  const input = document.createElement('input')
  input.className = 'min-w-0 flex-1 bg-transparent font-sans text-[12.5px] text-text-primary outline-hidden placeholder:text-text-muted'
  input.placeholder = empty ? t.placeholderInsert : t.placeholder
  input.setAttribute('aria-label', t.label)
  const note = document.createElement('span')
  note.className = 'shrink-0 font-mono text-[10.5px] text-text-muted'
  note.setAttribute('role', 'status')
  const buttons = document.createElement('div')
  buttons.className = 'flex shrink-0 gap-1'
  root.append(input, note, buttons)

  const layout = editor.getLayoutInfo()
  root.style.position = 'absolute'
  root.style.left = `${layout.contentLeft}px`
  root.style.width = `${Math.max(240, Math.min(720, layout.contentWidth - 40))}px`
  const widget: monaco.editor.IOverlayWidget = {
    getId: () => 'mindeck.inlineEdit',
    getDomNode: () => root,
    getPosition: () => null
  }

  const s: Session = {
    editor,
    model,
    widget,
    dom: { root, input, note, buttons },
    original: model.getValueInRange(range),
    target: editor.createDecorationsCollection([
      {
        range,
        options: {
          className: empty ? undefined : 'mindeck-ai-target',
          isWholeLine: !empty,
          stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges
        }
      }
    ]),
    phase: 'ask'
  }
  sessions.set(editor, s)
  editor.addOverlayWidget(widget)
  editor.changeViewZones((zones) => {
    s.zoneId = zones.addZone({
      afterLineNumber: range.startLineNumber - 1,
      heightInPx: WIDGET_HEIGHT,
      domNode: document.createElement('div'),
      onDomNodeTop: (top) => (root.style.top = `${top + 4}px`)
    })
  })
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    // ⌘K starts VS Code's ⌘K ⌘\ too: that second key, before anything was typed, splits the editor down instead.
    if ((e.metaKey || e.ctrlKey) && e.key === '\\' && !input.value && s.phase === 'ask') {
      e.preventDefault()
      close(s)
      useEditor.getState().split('down')
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      void write(s)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close(s)
    }
  })
  input.focus()
}

/** ⌘K in an editor, and its keys while an edit waits to be accepted (⌘⏎) or rejected (Esc). */
export function addInlineEdit(editor: Editor): monaco.IDisposable[] {
  const key = editor.createContextKey('mindeckInlineEditPending', false)
  pending.set(editor, key)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => acceptInlineEdit(editor), 'mindeckInlineEditPending')
  editor.addCommand(monaco.KeyCode.Escape, () => rejectInlineEdit(editor), 'mindeckInlineEditPending')
  return [
    // Another file in this editor: the edit stays as it is.
    editor.onDidChangeModel(() => {
      const s = sessions.get(editor)
      if (s) close(s)
    }),
    editor.addAction({
      id: 'mindeck.inlineEdit',
      label: getT().inlineAi.palette,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
      contextMenuGroupId: '1_modification',
      run: (ed) => startInlineEdit(ed as Editor)
    }),
    {
      dispose: () => {
        const s = sessions.get(editor)
        if (s) close(s)
        pending.delete(editor)
      }
    }
  ]
}
