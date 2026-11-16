import { getT } from '@/lib/i18n'
import { monaco } from './setup'
import { fileOf } from './uri'
import { conflictSides, nearestConflict, parseConflicts, resolveConflict, useConflicts, type ConflictBlock, type ConflictChoice } from '../conflicts'
import { useScm } from '../scm'

type Model = monaco.editor.ITextModel
type File = { id: string; projectId: string; path: string }

const ACCEPT = 'mindeck.conflict.accept'
const COMPARE = 'mindeck.conflict.compare'
/** Re-mark this long after the last keystroke. */
const PAINT_MS = 150

/** The edit that turns a block into `text` — removing it entirely takes a line break along. */
function editFor(model: Model, b: ConflictBlock, text: string[]): monaco.editor.IIdentifiedSingleEditOperation {
  const end = model.getLineMaxColumn(b.end)
  if (text.length) return { range: new monaco.Range(b.start, 1, b.end, end), text: text.join(model.getEOL()) }
  if (b.end < model.getLineCount()) return { range: new monaco.Range(b.start, 1, b.end + 1, 1), text: '' }
  if (b.start > 1) return { range: new monaco.Range(b.start - 1, model.getLineMaxColumn(b.start - 1), b.end, end), text: '' }
  return { range: new monaco.Range(b.start, 1, b.end, end), text: '' }
}

/** One undoable edit: ⌘Z brings the conflict back. */
function apply(model: Model, edits: monaco.editor.IIdentifiedSingleEditOperation[]): void {
  if (!edits.length) return
  model.pushStackElement()
  model.pushEditOperations([], edits, () => null)
  model.pushStackElement()
}

/** Resolve the block starting at `start` with one side, or both. */
export function acceptConflict(model: Model, start: number, choice: ConflictChoice): void {
  const lines = model.getLinesContent()
  const block = parseConflicts(lines).find((b) => b.start === start)
  if (block) apply(model, [editFor(model, block, resolveConflict(lines, block, choice))])
}

/** Resolve every block of the file the same way. */
export function acceptAllConflicts(model: Model, choice: ConflictChoice): void {
  const lines = model.getLinesContent()
  apply(
    model,
    parseConflicts(lines).map((b) => editFor(model, b, resolveConflict(lines, b, choice)))
  )
}

/** The two sides of a block side by side, in the diff view. */
export function compareConflict(model: Model, start: number): void {
  const lines = model.getLinesContent()
  const block = parseConflicts(lines).find((b) => b.start === start)
  const file = fileOf(model.uri)
  if (!block || !file) return
  const { current, incoming } = conflictSides(lines, block)
  const name = file.path.slice(file.path.lastIndexOf('/') + 1)
  const title = getT().conflicts.compareTitle(name, block.currentLabel || getT().conflicts.current, block.incomingLabel || getT().conflicts.incoming)
  useScm.setState({ diff: { path: file.path, original: current.join('\n'), modified: incoming.join('\n'), title } })
}

let registered = false

/** The CodeLens actions above every conflict ("Accept Current | Accept Incoming | Accept Both | Compare"), once per app. */
export function setupConflicts(): void {
  if (registered) return
  registered = true
  monaco.editor.registerCommand(ACCEPT, (_: unknown, model: Model, start: number, choice: ConflictChoice) => acceptConflict(model, start, choice))
  monaco.editor.registerCommand(COMPARE, (_: unknown, model: Model, start: number) => compareConflict(model, start))
  monaco.languages.registerCodeLensProvider('*', {
    provideCodeLenses: (model) => {
      const t = getT().conflicts
      const lenses = parseConflicts(model.getLinesContent()).flatMap((b) => {
        const range = new monaco.Range(b.start, 1, b.start, 1)
        const lens = (title: string, id: string, ...args: unknown[]) => ({ range, command: { id, title, arguments: [model, b.start, ...args] } })
        return [lens(t.acceptCurrent, ACCEPT, 'current'), lens(t.acceptIncoming, ACCEPT, 'incoming'), lens(t.acceptBoth, ACCEPT, 'both'), lens(t.compare, COMPARE)]
      })
      return { lenses, dispose: () => {} }
    }
  })
}

/** Whole-line tints of a block: current (ours) green, incoming (theirs) blue, the common base muted. */
function decorationsFor(b: ConflictBlock): monaco.editor.IModelDeltaDecoration[] {
  const line = (from: number, to: number, className: string) => ({ range: new monaco.Range(from, 1, to, 1), options: { isWholeLine: true, className } })
  const currentEnd = (b.base ?? b.separator) - 1
  const out = [line(b.start, b.start, 'mindeck-conflict-current-marker')]
  if (currentEnd > b.start) out.push(line(b.start + 1, currentEnd, 'mindeck-conflict-current'))
  if (b.base !== undefined) out.push(line(b.base, b.separator - 1, 'mindeck-conflict-base'))
  out.push(line(b.separator, b.separator, 'mindeck-conflict-separator'))
  if (b.end - 1 > b.separator) out.push(line(b.separator + 1, b.end - 1, 'mindeck-conflict-incoming'))
  out.push(line(b.end, b.end, 'mindeck-conflict-incoming-marker'))
  const tint = `rgb(${getComputedStyle(document.documentElement).getPropertyValue('--accent-amber').trim()})`
  return [...out, { range: new monaco.Range(b.start, 1, b.end, 1), options: { overviewRuler: { color: tint, position: monaco.editor.OverviewRulerLane.Full } } }]
}

/**
 * VS Code's merge conflict editor: conflict blocks are tinted (current,
 * base, incoming), each gets CodeLens actions, and the editor gets actions to
 * go to the next / previous conflict and to accept a side for all of them —
 * every resolution is one undoable edit. The conflict bar reads the counts.
 */
export function attachConflicts(editor: monaco.editor.IStandaloneCodeEditor, current: () => File | undefined): () => void {
  setupConflicts()
  const decorations = editor.createDecorationsCollection()
  let timer: number | undefined

  const blocks = () => {
    const model = editor.getModel()
    return model ? parseConflicts(model.getLinesContent()) : []
  }
  const paint = () => {
    const found = blocks()
    decorations.set(found.flatMap(decorationsFor))
    const file = current()
    if (file) useConflicts.getState().setCount(file.id, found.length)
  }
  const go = (back: boolean) => {
    const found = blocks()
    if (!found.length) return
    const target = nearestConflict(found, editor.getPosition()!.lineNumber, back)!
    editor.setPosition({ lineNumber: target.start, column: 1 })
    editor.revealLineInCenter(target.start)
  }
  const all = (choice: ConflictChoice) => {
    const model = editor.getModel()
    if (model) acceptAllConflicts(model, choice)
  }

  const t = getT().conflicts
  const actions = [
    editor.addAction({ id: 'mindeck.conflict.next', label: t.next, run: () => go(false) }),
    editor.addAction({ id: 'mindeck.conflict.previous', label: t.previous, run: () => go(true) }),
    editor.addAction({ id: 'mindeck.conflict.acceptAllCurrent', label: t.acceptAllCurrent, run: () => all('current') }),
    editor.addAction({ id: 'mindeck.conflict.acceptAllIncoming', label: t.acceptAllIncoming, run: () => all('incoming') }),
    editor.addAction({ id: 'mindeck.conflict.acceptAllBoth', label: t.acceptAllBoth, run: () => all('both') })
  ]
  const subs = [
    // The view records which tab it shows right after switching models.
    editor.onDidChangeModel(() => void Promise.resolve().then(paint)),
    editor.onDidChangeModelContent(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(paint, PAINT_MS)
    })
  ]
  paint()

  return () => {
    window.clearTimeout(timer)
    actions.forEach((a) => a.dispose())
    subs.forEach((s) => s.dispose())
    decorations.clear()
  }
}
