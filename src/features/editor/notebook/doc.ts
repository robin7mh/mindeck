import type { MultiLine, NotebookCell, NotebookDocument, NotebookOutput } from '@shared/types/notebook'
import { randomId } from '@/lib/id'

/** A cell with the key Mindeck knows it by (its nbformat id, or one made up for older files). */
export type Cell = NotebookCell & { key: string }
export type Doc = Omit<NotebookDocument, 'cells'> & { cells: Cell[] }

const newKey = () => randomId().slice(0, 8)

export const joinSource = (source: MultiLine | undefined): string => (Array.isArray(source) ? source.join('') : (source ?? ''))

/** Text as nbformat stores it: lines, each but the last ending in a newline. */
export function splitSource(text: string): string[] {
  return text ? (text.match(/[^\n]*\n|[^\n]+$/g) as string[]) : []
}

const isMultiLine = (value: unknown) => value === undefined || typeof value === 'string' || Array.isArray(value)

/** An output the view can draw: a file may say anything (a cloned repository, an agent writing it). */
function isOutput(value: unknown): boolean {
  const output = value as Record<string, unknown> | null
  if (!output || typeof output !== 'object') return false
  if (output.output_type === 'stream') return isMultiLine(output.text)
  if (output.output_type === 'error') return Array.isArray(output.traceback)
  return !!output.data && typeof output.data === 'object'
}

function isCell(value: unknown): boolean {
  const cell = value as Record<string, unknown> | null
  return !!cell && isMultiLine(cell.source) && (cell.outputs === undefined || (Array.isArray(cell.outputs) && cell.outputs.every(isOutput)))
}

/** A .ipynb file's text → the notebook (throws when it isn't one). */
export function parseNotebook(text: string): Doc {
  const raw = (text.trim() ? JSON.parse(text) : { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }) as NotebookDocument
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cells) || typeof raw.nbformat !== 'number') throw new Error('Not a Jupyter notebook (nbformat 4)')
  if (raw.nbformat < 4) throw new Error(`nbformat ${raw.nbformat} notebooks aren't supported — save it as nbformat 4 in Jupyter first`)
  const broken = raw.cells.findIndex((c) => !isCell(c))
  if (broken >= 0) throw new Error(`Cell ${broken + 1} doesn't follow the notebook format`)
  return { ...raw, metadata: raw.metadata ?? {}, cells: raw.cells.map((c) => ({ ...c, metadata: c.metadata ?? {}, key: c.id ?? newKey() })) }
}

/** The notebook as Jupyter writes it (one-space indent, final newline); ids only where the format has them. */
export function serializeNotebook(doc: Doc): string {
  const withIds = doc.nbformat > 4 || doc.nbformat_minor >= 5
  const cells = doc.cells.map(({ key, ...cell }) => {
    const out: NotebookCell = withIds ? { ...cell, id: cell.id ?? key } : cell
    if (!withIds) delete out.id
    return out
  })
  return `${JSON.stringify({ ...doc, cells }, null, 1)}\n`
}

/** A fresh cell (code cells start without outputs or a run). */
export function newCell(type: 'code' | 'markdown', source = ''): Cell {
  const key = newKey()
  const base = { id: key, key, source: splitSource(source), metadata: {} }
  return type === 'code' ? { ...base, cell_type: 'code', execution_count: null, outputs: [] } : { ...base, cell_type: 'markdown' }
}

/** A cell's outputs with one more: text on the same stream joins the one before (as Jupyter shows it). */
export function addOutput(outputs: NotebookOutput[], output: NotebookOutput): NotebookOutput[] {
  const last = outputs[outputs.length - 1]
  if (output.output_type === 'stream' && last?.output_type === 'stream' && last.name === output.name) {
    return [...outputs.slice(0, -1), { ...last, text: splitSource(joinSource(last.text) + joinSource(output.text)) }]
  }
  return [...outputs, output.output_type === 'stream' ? { ...output, text: splitSource(joinSource(output.text)) } : output]
}

/** The cell with these changes (others unchanged). */
export const updateCell = (doc: Doc, key: string, change: (cell: Cell) => Cell): Doc => ({ ...doc, cells: doc.cells.map((c) => (c.key === key ? change(c) : c)) })

/** The language of the notebook's code (Monaco id). */
export const notebookLanguage = (doc: Doc): string => (doc.metadata.kernelspec?.language ?? doc.metadata.language_info?.name ?? 'python').toLowerCase()

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[\d;]*[A-Za-z]/g
/** Terminal colours out of tracebacks and output. */
export const stripAnsi = (text: string): string => text.replace(ANSI, '')
