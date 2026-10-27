import { create } from 'zustand'
import { errorMessage, ipc } from '@shared/ipc/client'
import type { GitHubStatus, MergeMethod, PublishRepo, PullCreate, PullDetail, PullFilter, PullListState, PullSummary, ReviewAction } from '@shared/types/github'
import { useEditor } from './store'
import { useScm } from './scm'

/** Something done to a pull request (one at a time). */
export type PullOp = 'checkout' | 'create' | 'merge' | 'comment' | 'review' | 'publish'

interface GitHubState {
  status?: GitHubStatus
  filter: PullFilter
  state: PullListState
  pulls: PullSummary[]
  loading: boolean
  /** The pull request shown in the editor area. */
  detail?: PullDetail
  opening?: number
  busy?: PullOp
  error?: string
  /** The "create pull request" form is open. */
  creating: boolean
  /** The "publish to GitHub" form is open (Source Control). */
  publishing: boolean

  /** gh's state and the project's pull requests. */
  load: () => Promise<void>
  list: () => Promise<void>
  setFilter: (filter: PullFilter) => void
  setState: (state: PullListState) => void
  open: (number: number) => Promise<void>
  close: () => void
  /** A changed file, as a diff (merge base vs. head). */
  openFile: (path: string) => Promise<void>
  checkout: () => Promise<void>
  merge: (method: MergeMethod, deleteBranch: boolean) => Promise<void>
  comment: (body: string) => Promise<boolean>
  review: (action: ReviewAction, body: string) => Promise<boolean>
  setCreating: (on: boolean) => void
  setPublishing: (on: boolean) => void
  /** Pushes the branch when GitHub doesn't have it yet, then opens the pull request. */
  create: (pr: PullCreate) => Promise<void>
  /**
   * A local repository → a new GitHub repository; the new one when it worked.
   * Before the first commit, `first` commits every file — after writing
   * `readme` as README.md, for an empty folder.
   */
  publish: (repo: PublishRepo, first?: { message: string; readme?: string }) => Promise<{ nameWithOwner: string; url: string } | undefined>
  clearError: () => void
}

/** GitHub pull requests for the editor's project — the GitHub Pull Requests extension. */
export const useGitHub = create<GitHubState>((set, get) => {
  const project = () => useEditor.getState().projectId
  /** One action at a time; true when it worked. */
  const act = async (op: PullOp, fn: (projectId: string) => Promise<unknown>) => {
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
    return ok
  }
  /** After an action: the pull request and the list as GitHub has them now. */
  const reload = (number: number) => Promise.all([get().open(number), get().list()])

  return {
    filter: 'all',
    state: 'open',
    pulls: [],
    loading: false,
    creating: false,
    publishing: false,

    load: async () => {
      const projectId = project()
      set({ status: undefined, pulls: [], detail: undefined, error: undefined })
      if (!projectId) return
      try {
        const status = await ipc('github:status', { projectId })
        if (project() !== projectId) return
        set({ status })
        if (status.repo) await get().list()
      } catch (err) {
        set({ error: errorMessage(err) })
      }
    },

    list: async () => {
      const projectId = project()
      if (!projectId) return
      set({ loading: true })
      try {
        const pulls = await ipc('github:list', { projectId, filter: get().filter, state: get().state })
        if (project() === projectId) set({ pulls })
      } catch (err) {
        set({ error: errorMessage(err) })
      } finally {
        set({ loading: false })
      }
    },

    setFilter: (filter) => {
      set({ filter })
      void get().list()
    },
    setState: (state) => {
      set({ state })
      void get().list()
    },

    open: async (number) => {
      const projectId = project()
      if (!projectId) return
      set({ opening: number, creating: false })
      try {
        const detail = await ipc('github:view', { projectId, number })
        set({ detail })
        useScm.getState().closeDiff()
      } catch (err) {
        set({ error: errorMessage(err) })
      } finally {
        set({ opening: undefined })
      }
    },

    close: () => set({ detail: undefined }),

    openFile: async (path) => {
      const projectId = project()
      const number = get().detail?.number
      if (!projectId || !number) return
      try {
        const diff = await ipc('github:fileDiff', { projectId, number, path })
        useScm.setState({ diff: { ...diff, title: `${path} (#${number})` } })
      } catch (err) {
        set({ error: errorMessage(err) })
      }
    },

    checkout: async () => {
      const number = get().detail?.number
      if (!number) return
      if (await act('checkout', (projectId) => ipc('github:checkout', { projectId, number }))) {
        await Promise.all([useScm.getState().refresh(), useEditor.getState().refreshTree()])
      }
    },

    merge: async (method, deleteBranch) => {
      const number = get().detail?.number
      if (!number) return
      if (await act('merge', (projectId) => ipc('github:merge', { projectId, number, method, deleteBranch }))) {
        await Promise.all([reload(number), useScm.getState().refresh()])
      }
    },

    comment: async (body) => {
      const number = get().detail?.number
      if (!number) return false
      const ok = await act('comment', (projectId) => ipc('github:comment', { projectId, number, body }))
      if (ok) await reload(number)
      return ok
    },

    review: async (action, body) => {
      const number = get().detail?.number
      if (!number) return false
      const ok = await act('review', (projectId) => ipc('github:review', { projectId, number, action, body }))
      if (ok) await reload(number)
      return ok
    },

    setCreating: (creating) => set({ creating }),
    setPublishing: (publishing) => set({ publishing }),

    create: async (pr) => {
      let created: { number: number } | undefined
      const ok = await act('create', async (projectId) => {
        const status = useScm.getState().status
        // GitHub needs the branch: publish it, or push what it doesn't have yet.
        if (!status?.upstream || status.ahead > 0) await ipc('scm:push', { projectId })
        created = await ipc('github:create', { projectId, ...pr })
      })
      if (!ok) return
      set({ creating: false })
      await Promise.all([useScm.getState().refresh(), get().list()])
      await get().open(created!.number)
    },

    publish: async (repo, first) => {
      let made: { nameWithOwner: string; url: string } | undefined
      const ok = await act('publish', async (projectId) => {
        if (first?.readme !== undefined) await ipc('files:write', { projectId, path: 'README.md', content: first.readme })
        if (first) await ipc('scm:commit', { projectId, message: first.message, all: true })
        made = await ipc('github:publish', { projectId, ...repo })
      })
      // A first commit may have landed even when publishing failed.
      await Promise.all([useScm.getState().refresh(), useEditor.getState().refreshTree()])
      if (!ok) return undefined
      if (get().status) void get().load()
      return made
    },

    clearError: () => set({ error: undefined })
  }
})

/** A new project: its pull requests (once the pane has loaded them). */
useEditor.subscribe((s, prev) => {
  if (s.projectId === prev.projectId) return
  useGitHub.setState({ creating: false, publishing: false, detail: undefined })
  if (useGitHub.getState().status) void useGitHub.getState().load()
})
