import { create } from 'zustand'
import ignore from 'ignore'
import { errorMessage, ipc, onEvent } from '@shared/ipc/client'
import {
  applyReplacements,
  expandGlobs,
  matchText,
  replacementsFor,
  searchRegExp,
  splitGlobs,
  type FileMatches,
  type SearchEngine,
  type TextMatch,
  type TextSearchQuery
} from '@shared/types/search'
import { getT } from '@/lib/i18n'
import { bufferText, editBuffer, tabKey, useEditor } from './store'
import { useScm } from './scm'

/** What the user typed into the search view. */
export interface SearchFields {
  pattern: string
  replace: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  /** Comma-separated globs. */
  include: string
  exclude: string
  /** The replace field is open (⇧⌘H). */
  showReplace: boolean
  /** The include / exclude fields are open. */
  showDetails: boolean
}

/** A file the last replace wrote to disk, with its text before — "Undo" puts it back. */
interface Written {
  path: string
  before: string
  mtimeMs: number
}

interface SearchState extends SearchFields {
  /** Results by file, in the order they came in. */
  results: FileMatches[]
  searching: boolean
  /** The match limit cut the search short. */
  truncated: boolean
  engine?: SearchEngine
  error?: string
  /** Files folded in the result list. */
  collapsed: Record<string, boolean>
  replacing: boolean
  /** The last replace's disk writes (open files are undone in the editor instead). */
  undo?: { projectId: string; files: Written[] }

  set: (patch: Partial<SearchFields>) => void
  /** Search with the fields as they are (an empty pattern clears the results). */
  run: () => Promise<void>
  /** Follow the core's result batches; returns the unsubscribe. */
  connect: () => () => void
  toggle: (path: string) => void
  /** Open a match in the editor, selected. */
  open: (path: string, match: TextMatch) => Promise<void>
  /** Take a match (or a file's matches) off the list. */
  dismiss: (path: string, match?: TextMatch) => void
  /** The file as it would be after replacing, as a diff. */
  preview: (path: string) => Promise<void>
  replaceMatch: (path: string, match: TextMatch) => Promise<void>
  replaceFile: (path: string) => Promise<void>
  replaceAll: () => Promise<void>
  undoReplace: () => Promise<void>
  clearError: () => void
}

const FIELDS: SearchFields = { pattern: '', replace: '', regex: false, caseSensitive: false, wholeWord: false, include: '', exclude: '', showReplace: false, showDetails: false }
/** An open file with unsaved edits is searched here — at most this many matches each. */
const BUFFER_MATCHES = 5000

/** The search running now (results of older ones are ignored). Made here, so batches can't overtake the answer. */
let current: string | undefined
/** The query that produced the results — replacing uses it, whatever the fields say by now. */
let searched: TextSearchQuery | undefined

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** Whether a path passes the include / exclude globs (the core applies the same to the disk). */
function pathFilter(q: TextSearchQuery): (path: string) => boolean {
  const include = q.include?.length ? ignore().add(expandGlobs(q.include)) : null
  const exclude = ignore().add(expandGlobs(q.exclude))
  return (path) => (!include || include.ignores(path)) && !exclude.ignores(path)
}

const without = (results: FileMatches[], path: string, gone: (m: TextMatch) => boolean) =>
  results.flatMap((f) => {
    if (f.path !== path) return [f]
    const matches = f.matches.filter((m) => !gone(m))
    return matches.length ? [{ ...f, matches }] : []
  })

/**
 * VS Code's search view (⇧⌘F, ⇧⌘H): results stream in from the core
 * (ripgrep, or its own engine), grouped by file. Open files with unsaved
 * edits are searched here, in their buffers. Replacing edits open files in
 * their buffers (one undo step each, saving stays the user's call) and writes
 * the others to disk — refusing a file that changed since it was read; those
 * writes can be undone from the view.
 */
export const useSearch = create<SearchState>((set, get) => {
  const project = () => useEditor.getState().projectId

  /** Replace some matches of one file: in its buffer when open, else on disk. Returns what was written to disk. */
  const replaceIn = async (projectId: string, path: string, matches: TextMatch[]): Promise<Written | undefined> => {
    const q = searched!
    const re = searchRegExp(q)
    const id = tabKey(projectId, path)
    const open = bufferText(id)
    if (open !== undefined && editBuffer(id, replacementsFor(open, matches, re, get().replace, !!q.regex))) return undefined
    const file = await ipc('files:read', { projectId, path })
    const reps = file.content === undefined ? [] : replacementsFor(file.content, matches, re, get().replace, !!q.regex)
    if (!reps.length) return undefined
    const saved = await ipc('files:write', { projectId, path, content: applyReplacements(file.content!, reps), expectedMtime: file.mtimeMs })
    return { path, before: file.content!, mtimeMs: saved.mtimeMs }
  }

  /** Replace per file; matches leave the list, failures are reported, disk writes become undoable. */
  const replace = async (targets: FileMatches[]) => {
    const projectId = project()
    if (!projectId || !searched || get().replacing || !targets.length) return
    set({ replacing: true, error: undefined })
    const written: Written[] = []
    const failed: string[] = []
    for (const target of targets) {
      try {
        const w = await replaceIn(projectId, target.path, target.matches)
        if (w) written.push(w)
        set((s) => ({ results: without(s.results, target.path, (m) => target.matches.includes(m)) }))
      } catch (err) {
        failed.push(`${target.path}: ${errorMessage(err)}`)
      }
    }
    set({ replacing: false, ...(written.length ? { undo: { projectId, files: written } } : {}), ...(failed.length ? { error: getT().search.replaceFailed(failed.join('\n')) } : {}) })
  }

  return {
    ...FIELDS,
    results: [],
    searching: false,
    truncated: false,
    collapsed: {},
    replacing: false,

    set: (patch) => set(patch),

    run: async () => {
      if (current) void ipc('search:cancel', { id: current }).catch(() => {})
      current = undefined
      const projectId = project()
      const s = get()
      const query: TextSearchQuery = {
        pattern: s.pattern,
        regex: s.regex,
        caseSensitive: s.caseSensitive,
        wholeWord: s.wholeWord,
        include: splitGlobs(s.include),
        exclude: splitGlobs(s.exclude)
      }
      if (!projectId || !s.pattern) return set({ results: [], searching: false, truncated: false, engine: undefined, error: undefined })
      let re: RegExp
      try {
        re = searchRegExp(query)
      } catch (err) {
        return set({ results: [], searching: false, truncated: false, error: errorMessage(err) })
      }
      // Open files with unsaved edits: their buffers are searched here, their disk copies skipped.
      const dirty = useEditor.getState().tabs.filter((t) => t.projectId === projectId && t.dirty && t.content !== undefined)
      const passes = pathFilter(query)
      const local: FileMatches[] = []
      for (const t of dirty) {
        const text = bufferText(t.id)
        const matches = text !== undefined && passes(t.path) ? matchText(re, text, BUFFER_MATCHES) : []
        if (matches.length) local.push({ path: t.path, matches })
      }
      const id = newId()
      current = id
      searched = query
      set({ results: local, searching: true, truncated: false, engine: undefined, error: undefined, collapsed: {} })
      try {
        const { engine } = await ipc('search:start', { id, projectId, query: { ...query, skip: dirty.map((t) => t.path) } })
        if (current === id) set({ engine })
      } catch (err) {
        if (current !== id) return
        current = undefined
        set({ searching: false, error: errorMessage(err) })
      }
    },

    connect: () =>
      onEvent('search:progress', (p) => {
        if (p.id !== current) return
        if (p.files.length) set((s) => ({ results: [...s.results, ...p.files] }))
        if (!p.done) return
        current = undefined
        set({ searching: false, truncated: !!p.truncated, error: p.error })
      }),

    toggle: (path) =>
      set((s) => {
        const { [path]: folded, ...rest } = s.collapsed
        return { collapsed: folded ? rest : { ...rest, [path]: true } }
      }),

    open: async (path, match) => {
      useScm.getState().closeDiff()
      await useEditor.getState().openAt(path, match.line, { column: match.column, length: match.length })
    },

    dismiss: (path, match) => set((s) => ({ results: without(s.results, path, (m) => !match || m === match) })),

    preview: async (path) => {
      const projectId = project()
      const file = get().results.find((f) => f.path === path)
      if (!projectId || !file || !searched) return
      try {
        const open = bufferText(tabKey(projectId, path))
        const original = open ?? (await ipc('files:read', { projectId, path })).content ?? ''
        const modified = applyReplacements(original, replacementsFor(original, file.matches, searchRegExp(searched), get().replace, !!searched.regex))
        const name = path.slice(path.lastIndexOf('/') + 1)
        useScm.setState({ diff: { path, original, modified, title: getT().search.previewTitle(name) } })
      } catch (err) {
        set({ error: errorMessage(err) })
      }
    },

    replaceMatch: (path, match) => replace([{ path, matches: [match] }]),
    replaceFile: (path) => replace(get().results.filter((f) => f.path === path)),
    replaceAll: () => replace(get().results),

    undoReplace: async () => {
      const undo = get().undo
      if (!undo) return
      set({ undo: undefined })
      const failed: string[] = []
      for (const f of undo.files) {
        await ipc('files:write', { projectId: undo.projectId, path: f.path, content: f.before, expectedMtime: f.mtimeMs }).catch((err: unknown) => failed.push(`${f.path}: ${errorMessage(err)}`))
      }
      await get().run()
      if (failed.length) set({ error: getT().search.undoFailed(failed.join('\n')) })
    },

    clearError: () => set({ error: undefined })
  }
})

/** Another project: the results (and the search running) go. */
useEditor.subscribe((s, prev) => {
  if (s.projectId === prev.projectId) return
  if (current) void ipc('search:cancel', { id: current }).catch(() => {})
  current = undefined
  searched = undefined
  useSearch.setState({ results: [], searching: false, truncated: false, engine: undefined, error: undefined, undo: undefined, collapsed: {} })
})
