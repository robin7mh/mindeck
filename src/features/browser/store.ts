import { create } from 'zustand'
import { errorMessage, ipc, isDesktop, onEvent } from '@shared/ipc/client'
import type { IpcChannel, IpcChannels } from '@shared/ipc/contract'
import {
  DEFAULT_BROWSER_SETTINGS,
  type BrowserCommand,
  type BrowserFind,
  type BrowserSettings,
  type BrowserSplit,
  type BrowserState,
  type BrowserTab,
  type WorkspaceKey
} from '@shared/types/browser'
import type { BookmarkFolder } from '@shared/types/browserData'
import { findByUrl } from './library'

const EMPTY: BrowserState = { available: false, tabs: [], closed: 0, downloads: [], permissions: [], devServers: [], groups: [], splits: [] }
const NO_BOOKMARKS: BookmarkFolder[] = [
  { id: 'bar', title: '', children: [], added: 0 },
  { id: 'other', title: '', children: [], added: 0 }
]

/** What the browser asks of the rest of the app (the shell decides where to go). */
export interface BrowserHandlers {
  /** Show the browser module. */
  reveal(): void
  /** "Send to agent": the tab is shared now — start a chat about it. */
  sendToAgent(tab: BrowserTab): void
  /** Open the browser settings. */
  settings(): void
  /** A page took the keyboard focus (the user clicked into it). */
  focused?(): void
  /** A workspace key pressed while a page had the keyboard. */
  workspaceKey?(key: WorkspaceKey): void
  /** ⇧⌘P while a page has the keyboard: Mindeck's command palette. */
  palette?(): void
}

let handlers: BrowserHandlers | null = null

interface BrowserStore {
  state: BrowserState
  find?: BrowserFind
  findOpen: boolean
  /** Bumped to put the keyboard focus into the address bar. */
  focusTick: number
  downloadsOpen: boolean
  extensionsOpen: boolean
  /** The bookmarks: the bar's folder, then Other bookmarks. */
  bookmarks: BookmarkFolder[]
  settings: BrowserSettings
  /** ⌘⇧A: the search over tabs, history and bookmarks. */
  tabSearchOpen: boolean
  /** The bookmark (or folder) in the editor; `added`: ⌘D just saved it. */
  editing?: { id: string; added?: boolean }
  importOpen: boolean
  /** The tab being dragged (the page area offers its edges for a split view). */
  dragging?: string
  /** The group whose name and color are being edited — at the point it was asked from, if any. */
  groupEditor?: { id: string; at?: { x: number; y: number } }
  error?: string
  /** Push events → this store; `handlers` take the browser's requests to the rest of the app. */
  connect(next: BrowserHandlers): () => void
  refresh(): Promise<void>
  /** Call a browser channel; a failure shows as `error` instead of throwing. */
  run<K extends IpcChannel>(channel: K, ...args: IpcChannels[K]['request'] extends void ? [] : [IpcChannels[K]['request']]): Promise<IpcChannels[K]['response'] | undefined>
  /** From anywhere in Mindeck: open `url` in a tab and bring the browser up. */
  show(url: string): Promise<void>
  /** A new tab with the new-tab page, the address bar ready (`private`: a private tab). */
  newTab(opts?: { private?: boolean }): Promise<void>
  /** Load what was typed (an address or search words) in the tab on screen. */
  go(input: string): Promise<void>
  /** Share the tab on screen with agents and start a chat about it. */
  sendToAgent(): Promise<void>
  setFindOpen(open: boolean): void
  toggleDownloads(): void
  /** The extension manager beside the page (it takes the downloads' place). */
  toggleExtensions(): void
  clearError(): void
  /** Change browser settings (the bookmarks bar, suggestions, …). */
  configure(patch: Partial<BrowserSettings>): Promise<void>
  /** ⌘D: bookmark the page on screen on the bar — or edit its bookmark if it has one. */
  bookmarkActive(): Promise<void>
  /** Open the editor for a bookmark or folder; none closes it. */
  edit(id?: string): void
  setTabSearch(open: boolean): void
  setImport(open: boolean): void
  setDragging(id?: string): void
  /** Open the group editor (none closes it). */
  editGroup(id?: string, at?: { x: number; y: number }): void
}

export const useBrowser = create<BrowserStore>((set, get) => {
  const command = (c: BrowserCommand, opts: { key?: WorkspaceKey; id?: string } = {}) => {
    if (c === 'focusOmnibox') set((s) => ({ focusTick: s.focusTick + 1 }))
    else if (c === 'verticalTabs') void get().configure({ verticalTabs: !get().settings.verticalTabs })
    else if (c === 'editGroup') set({ groupEditor: opts.id ? { id: opts.id } : undefined })
    else if (c === 'find') set({ findOpen: true })
    else if (c === 'settings') handlers?.settings()
    else if (c === 'focused') handlers?.focused?.()
    else if (c === 'workspaceKey') handlers?.workspaceKey?.(opts.key!)
    else if (c === 'tabSearch') set({ tabSearchOpen: true })
    else if (c === 'bookmark') void get().bookmarkActive()
    else if (c === 'bookmarksBar') void get().configure({ bookmarksBar: !get().settings.bookmarksBar })
    else if (c === 'import') set({ importOpen: true })
    else if (c === 'palette') handlers?.palette?.()
    else {
      const tab = activeTab(get().state)
      if (tab) handlers?.sendToAgent(tab)
    }
  }

  return {
    state: EMPTY,
    findOpen: false,
    focusTick: 0,
    downloadsOpen: false,
    extensionsOpen: false,
    bookmarks: NO_BOOKMARKS,
    settings: DEFAULT_BROWSER_SETTINGS,
    tabSearchOpen: false,
    importOpen: false,

    connect: (next) => {
      handlers = next
      void get().refresh()
      const offs = [
        onEvent('browser:state', (state) => set({ state })),
        onEvent('browser:find', (find) => set({ find })),
        onEvent('browser:command', ({ command: c, key, id }) => command(c, { key, id })),
        onEvent('browser:reveal', () => handlers?.reveal()),
        onEvent('browser:bookmarks', (bookmarks) => set({ bookmarks }))
      ]
      return () => {
        offs.forEach((off) => off())
        if (handlers === next) handlers = null
      }
    },

    refresh: async () => {
      if (!isDesktop()) return
      const [state, bookmarks, settings] = await Promise.all([get().run('browser:state'), get().run('browser:bookmarks'), get().run('browser:settings')])
      set({ ...(state ? { state } : {}), ...(bookmarks ? { bookmarks } : {}), ...(settings ? { settings } : {}) })
    },

    run: async (channel, ...args) => {
      try {
        return await ipc(channel, ...args)
      } catch (err) {
        set({ error: errorMessage(err) })
        return undefined
      }
    },

    show: async (url) => {
      const tab = await get().run('browser:open', { url })
      if (tab) handlers?.reveal()
    },

    newTab: async (opts = {}) => {
      await get().run('browser:open', opts.private ? { private: true } : {})
      set((s) => ({ focusTick: s.focusTick + 1 }))
    },

    go: async (input) => {
      const tab = activeTab(get().state)
      if (tab) await get().run('browser:navigate', { id: tab.id, input })
      else await get().run('browser:open', { url: input })
    },

    sendToAgent: async () => {
      const tab = activeTab(get().state)
      if (!tab?.url) return
      await get().run('browser:update', { id: tab.id, shared: true })
      handlers?.sendToAgent(tab)
    },

    setFindOpen: (open) => {
      set({ findOpen: open, ...(open ? {} : { find: undefined }) })
      const tab = activeTab(get().state)
      if (!open && tab) void get().run('browser:findStop', { id: tab.id })
    },

    toggleDownloads: () => set((s) => ({ downloadsOpen: !s.downloadsOpen })),
    toggleExtensions: () => set((s) => ({ extensionsOpen: !s.extensionsOpen, downloadsOpen: false })),
    clearError: () => set({ error: undefined }),

    configure: async (patch) => {
      const settings = await get().run('browser:configure', patch)
      if (settings) set({ settings })
    },

    bookmarkActive: async () => {
      const tab = activeTab(get().state)
      // A private tab leaves no bookmarks behind.
      if (!tab || tab.profile === 'private' || !/^(https?|file):/i.test(tab.url)) return
      const saved = findByUrl(get().bookmarks, tab.url)
      if (saved) return set({ editing: { id: saved.id } })
      const node = await get().run('browser:bookmarkAdd', { parentId: 'bar', title: tab.title || tab.url, url: tab.url })
      if (node) set({ editing: { id: node.id, added: true } })
    },

    edit: (id) => set({ editing: id ? { id } : undefined }),
    setTabSearch: (open) => set({ tabSearchOpen: open }),
    setImport: (open) => set({ importOpen: open }),
    setDragging: (id) => set({ dragging: id }),
    editGroup: (id, at) => set({ groupEditor: id ? { id, ...(at ? { at } : {}) } : undefined })
  }
})

export function activeTab(state: BrowserState): BrowserTab | undefined {
  return state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0]
}

/** The tab on screen. */
export function useActiveTab(): BrowserTab | undefined {
  return useBrowser((s) => activeTab(s.state))
}

/** The split view a tab is in. */
export function splitOf(state: BrowserState, tabId: string | undefined): BrowserSplit | undefined {
  return state.splits.find((s) => s.tabs.includes(tabId as string))
}

/** The split view on screen: the active tab's. */
export function useActiveSplit(): BrowserSplit | undefined {
  return useBrowser((s) => splitOf(s.state, activeTab(s.state)?.id))
}
