import { create } from 'zustand'
import { errorMessage, ipc } from '@shared/ipc/client'
import type { FileDiff } from '@shared/types/agents'
import type { ScmBranch, ScmCommit, ScmCommitDetail, ScmCommitFile, ScmDiffTarget, ScmFile, ScmStash, ScmStatus } from '@shared/types/scm'
import { useEditor } from './store'

/** A repository with no `origin` to push to: it goes to GitHub first ("Publish to GitHub"). */
export const needsPublish = (status?: ScmStatus): boolean => !!status?.repo && !status.upstream && !!status.remotes && !status.remotes.includes('origin')

/** The editor's sidebar views — VS Code's activity bar. */
export type EditorPane = 'files' | 'outline' | 'search' | 'scm' | 'graph' | 'debug' | 'remote' | 'prs' | 'mongo' | 'tests'

/** A git operation in flight (one at a time — git locks the repo anyway). */
export type ScmOp = 'stage' | 'unstage' | 'discard' | 'commit' | 'fetch' | 'pull' | 'push' | 'sync' | 'checkout' | 'branch' | 'init' | 'abort' | 'continue' | 'stash'

export interface OpenDiff extends FileDiff {
  /** Shown above the diff, e.g. "a.ts (Working Tree)". */
  title: string
}

interface ScmState {
  pane: EditorPane
  status?: ScmStatus
  branches: ScmBranch[]
  busy?: ScmOp
  error?: string
  /** The commit message being written. */
  message: string
  amend: boolean
  diff?: OpenDiff
  log: ScmCommit[]
  selected?: string
  detail?: ScmCommitDetail
  quickOpen: boolean
  /** What quick open starts with: '' files, '>' commands, ':' go to line. */
  quickQuery: string
  /** A list to choose from instead (branches, …) — quick open shows it until closed. */
  pick?: QuickPick
  /** Every file of the current project (for quick open), loaded when it opens. */
  files: string[]
  stashes: ScmStash[]
  /** The files of stashes opened in the list, by stash hash. */
  stashFiles: Record<string, ScmCommitFile[]>

  setPane: (pane: EditorPane) => void
  /** Status and branches of the editor's project. */
  refresh: () => Promise<void>
  stage: (paths: string[]) => Promise<void>
  unstage: (paths: string[]) => Promise<void>
  discard: (paths: string[]) => Promise<void>
  setMessage: (message: string) => void
  setAmend: (amend: boolean) => void
  /** Commit what is staged — or, with nothing staged, every change (VS Code's "smart commit"). */
  commit: () => Promise<void>
  fetch: () => Promise<void>
  pull: () => Promise<void>
  push: () => Promise<void>
  /** Pull, then push. */
  sync: () => Promise<void>
  checkout: (name: string) => Promise<void>
  createBranch: (name: string) => Promise<void>
  init: () => Promise<void>
  openDiff: (file: ScmFile | { path: string; from?: string }, target: ScmDiffTarget, title: string) => Promise<void>
  closeDiff: () => void
  loadLog: () => Promise<void>
  select: (hash: string) => Promise<void>
  setQuickOpen: (open: boolean, query?: string) => void
  /** Ask the user to choose (or, with `onText`, to type) — in the quick open box. */
  openPick: (pick: QuickPick) => void
  /** Give up the merge / rebase / cherry-pick / revert in progress. */
  abortOperation: () => Promise<void>
  /** Go on with it (commit the merge, rebase the next commit). */
  continueOperation: () => Promise<void>
  /** Stash the changes (`untracked`: new files too); resolves true when stashed. */
  stash: (message: string, untracked: boolean) => Promise<boolean>
  /** Apply a stash; `pop` drops it afterwards. */
  applyStash: (hash: string, pop: boolean) => Promise<void>
  dropStash: (hash: string) => Promise<void>
  /** Open or close a stash's file list in the panel. */
  toggleStash: (hash: string) => Promise<void>
  clearError: () => void
}

export interface PickItem {
  id: string
  label: string
  /** Shown dimmed after the label (a path, a branch's upstream, …). */
  detail?: string
  /** A shortcut hint, right-aligned. */
  keys?: string
  run: () => unknown
}

export interface QuickPick {
  placeholder: string
  items: PickItem[]
  /** Free text instead of a choice: Enter hands over what was typed (a new branch name, …). */
  onText?: (text: string) => unknown
}

/**
 * Source control (stashes, merges and rebases too) and quick open for the editor's project. Every git
 * operation reloads the status afterwards, so the panel always shows what git
 * sees — also after an agent or a terminal changed something.
 */
export const useScm = create<ScmState>((set, get) => {
  const project = () => useEditor.getState().projectId
  /** One git operation: busy while it runs, then a fresh status; failures show as the error. */
  const run = async (op: ScmOp, fn: (projectId: string) => Promise<unknown>) => {
    const projectId = project()
    if (!projectId || get().busy) return false
    set({ busy: op, error: undefined })
    const ok = await fn(projectId).then(
      () => true,
      (err: unknown) => {
        set({ error: errorMessage(err) })
        return false
      }
    )
    set({ busy: undefined })
    await get().refresh()
    return ok
  }

  return {
    pane: 'files',
    branches: [],
    message: '',
    amend: false,
    log: [],
    quickOpen: false,
    quickQuery: '',
    files: [],
    stashes: [],
    stashFiles: {},

    setPane: (pane) => {
      set({ pane })
      if (pane === 'graph') void get().loadLog()
      else if (pane === 'scm') void get().refresh()
    },

    refresh: async () => {
      const projectId = project()
      if (!projectId) return
      try {
        const status = await ipc('scm:status', { projectId })
        const [branches, stashes] = status.repo ? await Promise.all([ipc('scm:branches', { projectId }), ipc('scm:stashes', { projectId })]) : [[], []]
        set({ status, branches, stashes })
      } catch (err) {
        set({ error: errorMessage(err) })
      }
    },

    stage: async (paths) => void (await run('stage', (projectId) => ipc('scm:stage', { projectId, paths }))),
    unstage: async (paths) => void (await run('unstage', (projectId) => ipc('scm:unstage', { projectId, paths }))),
    discard: async (paths) => void (await run('discard', (projectId) => ipc('scm:discard', { projectId, paths }))),

    setMessage: (message) => set({ message }),
    setAmend: (amend) => set({ amend }),

    commit: async () => {
      const { message, amend, status } = get()
      const all = !status?.files.some((f) => f.staged)
      const done = await run('commit', (projectId) => ipc('scm:commit', { projectId, message, amend, all }))
      if (done) set({ message: '', amend: false })
    },

    fetch: async () => void (await run('fetch', (projectId) => ipc('scm:fetch', { projectId }))),
    pull: async () => void (await run('pull', (projectId) => ipc('scm:pull', { projectId }))),
    push: async () => void (await run('push', (projectId) => ipc('scm:push', { projectId }))),
    sync: async () =>
      void (await run('sync', async (projectId) => {
        await ipc('scm:pull', { projectId })
        await ipc('scm:push', { projectId })
      })),

    checkout: async (name) => void (await run('checkout', (projectId) => ipc('scm:checkout', { projectId, name }))),
    createBranch: async (name) => void (await run('branch', (projectId) => ipc('scm:createBranch', { projectId, name }))),
    init: async () => void (await run('init', (projectId) => ipc('scm:init', { projectId }))),

    openDiff: async (file, target, title) => {
      const projectId = project()
      if (!projectId) return
      try {
        const diff = await ipc('scm:diff', { projectId, path: file.path, target: target.kind === 'commit' && file.from ? { ...target, from: file.from } : target })
        set({ diff: { ...diff, title } })
      } catch (err) {
        set({ error: errorMessage(err) })
      }
    },
    closeDiff: () => set({ diff: undefined }),

    loadLog: async () => {
      const projectId = project()
      if (!projectId) return
      try {
        const log = await ipc('scm:log', { projectId })
        set({ log })
        if (!get().selected && log[0]) await get().select(log[0].hash)
      } catch (err) {
        set({ error: errorMessage(err) })
      }
    },

    select: async (hash) => {
      const projectId = project()
      if (!projectId) return
      set({ selected: hash })
      try {
        const detail = await ipc('scm:show', { projectId, hash })
        set({ detail })
      } catch (err) {
        set({ error: errorMessage(err) })
      }
    },

    setQuickOpen: (open, query = '') => {
      set({ quickOpen: open, quickQuery: query, pick: undefined })
      const projectId = project()
      if (!open || !projectId) return
      ipc('scm:files', { projectId }).then(
        (files) => set({ files }),
        (err: unknown) => set({ error: errorMessage(err) })
      )
    },

    openPick: (pick) => set({ quickOpen: true, quickQuery: '', pick }),

    abortOperation: async () => void (await run('abort', (projectId) => ipc('scm:abort', { projectId }))),
    continueOperation: async () => void (await run('continue', (projectId) => ipc('scm:continue', { projectId }))),

    stash: (message, untracked) => run('stash', (projectId) => ipc('scm:stash', { projectId, message, untracked })),
    applyStash: async (hash, pop) => void (await run('stash', (projectId) => ipc('scm:applyStash', { projectId, hash, pop }))),
    dropStash: async (hash) => void (await run('stash', (projectId) => ipc('scm:dropStash', { projectId, hash }))),

    toggleStash: async (hash) => {
      const projectId = project()
      if (!projectId) return
      if (get().stashFiles[hash]) {
        const { [hash]: _closed, ...open } = get().stashFiles
        return set({ stashFiles: open })
      }
      try {
        const files = await ipc('scm:stashFiles', { projectId, hash })
        set((s) => ({ stashFiles: { ...s.stashFiles, [hash]: files } }))
      } catch (err) {
        set({ error: errorMessage(err) })
      }
    },

    clearError: () => set({ error: undefined })
  }
})

/** Everything about the project resets when the editor switches projects. */
useEditor.subscribe((s, prev) => {
  if (s.projectId === prev.projectId) return
  useScm.setState({ status: undefined, branches: [], diff: undefined, log: [], selected: undefined, detail: undefined, files: [], stashes: [], stashFiles: {}, error: undefined })
  void useScm.getState().refresh()
})
