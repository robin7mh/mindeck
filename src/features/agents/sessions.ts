import { create } from 'zustand'
import { errorMessage, ipc, onEvent, onResync } from '@shared/ipc/client'
import type { ChatMessage } from '@shared/types/ai'
import type { AgentAvailability, AgentInput, AgentSession, CreateSessionRequest, FileChange, FileDiff, SessionBranch, SessionConfigure } from '@shared/types/agents'
import { CACHED_CHATS, merge, upsertMessage } from './store'
import { saveDraft } from './composerPrefs'

/** What the center of the Agents module shows. */
export type AgentsView = 'empty' | 'session' | 'assistant'

interface AgentsState {
  availability: AgentAvailability[]
  detecting: boolean
  sessions: AgentSession[]
  view: AgentsView
  activeId?: string
  messages: Record<string, ChatMessage[]>
  changes: Record<string, FileChange[]>
  /** Own working folders: their branch on GitHub (pushed, pull request, merged). */
  branches: Record<string, SessionBranch | null>
  diff?: FileDiff
  /** "New chat" dialog — optionally with a first message (e.g. from the dashboard). */
  dialog?: { prompt?: string }
  busy: boolean
  error?: string

  /** Subscribe to session pushes (ref-counted); returns the unsubscribe. */
  connect: () => () => void
  refresh: () => Promise<void>
  detect: () => Promise<void>
  openDialog: (prompt?: string) => void
  closeDialog: () => void
  create: (req: CreateSessionRequest) => Promise<boolean>
  open: (id: string) => Promise<void>
  showAssistant: () => void
  send: (text: string, extra?: Omit<AgentInput, 'text'>) => Promise<boolean>
  /** Switch the active session's model or mode. */
  configure: (patch: SessionConfigure) => Promise<void>
  interrupt: () => Promise<void>
  stop: (id?: string) => Promise<void>
  resume: (id?: string) => Promise<void>
  remove: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  /** A shell in the session's folder (ACP agents have no terminal of their own). */
  openShell: (id: string) => Promise<string | undefined>
  loadChanges: (id?: string) => Promise<void>
  loadBranch: (id?: string) => Promise<void>
  showDiff: (path: string) => Promise<void>
  closeDiff: () => void
  accept: () => Promise<void>
  discard: () => Promise<void>
  clearError: () => void
}

let connections = 0
let unsubscribe: (() => void) | undefined
let recentSessions: string[] = []
/** How often each session's changes were asked for: an answer that a newer question has overtaken is dropped. */
const changesAsked = new Map<string, number>()

const upsertSession = (list: AgentSession[], s: AgentSession) => [s, ...list.filter((x) => x.id !== s.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

/**
 * The agent cockpit's renderer side: the user's coding agent sessions
 * (Claude Code & co.), their chats, changes and diffs. Mindeck Assistant chats
 * (API key) stay in `useAssistant`; the view switches between both.
 */
export const useAgents = create<AgentsState>((set, get) => {
  const fail = (err: unknown) => set({ error: errorMessage(err), busy: false })
  /** Run an IPC action on the active (or given) session, reporting failures. */
  const act = async (fn: (id: string) => Promise<unknown>, id = get().activeId) => {
    if (!id) return
    try {
      await fn(id)
    } catch (err) {
      fail(err)
    }
  }

  /** A session with its messages from the core, merged with what arrived live (the most recently opened stay in memory). */
  const load = async (id: string, liveWins = true) => {
    const { messages, ...session } = await ipc('agents:get', { id })
    recentSessions = [id, ...recentSessions.filter((x) => x !== id)].slice(0, CACHED_CHATS)
    set((s) => ({
      sessions: upsertSession(s.sessions, session),
      messages: Object.fromEntries(Object.entries({ ...s.messages, [id]: merge(messages, s.messages[id], liveWins) }).filter(([key]) => key === s.activeId || recentSessions.includes(key)))
    }))
  }

  /** A removed session leaves nothing behind. */
  const forget = (s: AgentsState, id: string) => {
    changesAsked.delete(id)
    const { [id]: _messages, ...messages } = s.messages
    const { [id]: _changes, ...changes } = s.changes
    const { [id]: _branch, ...branches } = s.branches
    return { messages, changes, branches }
  }

  return {
    availability: [],
    detecting: false,
    sessions: [],
    view: 'empty',
    messages: {},
    changes: {},
    branches: {},
    busy: false,

    connect: () => {
      connections += 1
      if (connections === 1) {
        const offs = [
          onEvent('agents:changed', ({ session, removed }) => {
            if (session) set((s) => ({ sessions: upsertSession(s.sessions, session) }))
            if (removed) {
              set((s) => ({
                ...forget(s, removed),
                sessions: s.sessions.filter((x) => x.id !== removed),
                ...(s.activeId === removed ? { activeId: undefined, view: 'empty' as const } : {})
              }))
            }
          }),
          onEvent('agents:message', ({ sessionId, message }) => {
            const list = get().messages[sessionId]
            // The open session may still be loading: `load` merges what came meanwhile.
            if (list || get().activeId === sessionId) set((s) => ({ messages: { ...s.messages, [sessionId]: upsertMessage(list ?? [], message) } }))
          }),
          // Back after an outage of the push channel: statuses and messages from the gap are missing.
          onResync(() => {
            void get().refresh()
            const id = get().activeId
            // Sessions not on screen missed the gap too: they come fresh when opened again, not as they were left.
            set((s) => ({ messages: id && s.messages[id] ? { [id]: s.messages[id] } : {} }))
            if (id) void load(id, false).catch(fail)
          })
        ]
        unsubscribe = () => offs.forEach((off) => off())
        void get().refresh()
      }
      return () => {
        connections -= 1
        if (connections === 0) unsubscribe?.()
      }
    },

    refresh: async () => {
      try {
        set({ sessions: await ipc('agents:list') })
      } catch (err) {
        fail(err)
      }
    },

    detect: async () => {
      set({ detecting: true })
      try {
        set({ availability: await ipc('agents:detect'), detecting: false })
      } catch (err) {
        set({ detecting: false })
        fail(err)
      }
    },

    openDialog: (prompt) => {
      set({ dialog: { prompt } })
      void get().detect()
    },
    closeDialog: () => set({ dialog: undefined }),

    create: async (req) => {
      set({ busy: true, error: undefined })
      try {
        const session = await ipc('agents:create', req)
        set((s) => ({
          sessions: upsertSession(s.sessions, session),
          activeId: session.id,
          view: 'session',
          messages: { ...s.messages, [session.id]: [] },
          dialog: undefined,
          busy: false
        }))
        return true
      } catch (err) {
        fail(err)
        return false
      }
    },

    open: async (id) => {
      set({ activeId: id, view: 'session', error: undefined })
      try {
        await load(id)
      } catch (err) {
        fail(err)
      }
    },

    showAssistant: () => set({ view: 'assistant', activeId: undefined }),

    send: async (text, extra = {}) => {
      const id = get().activeId
      if (!id) return false
      try {
        await ipc('agents:send', { id, text, ...extra })
        return true
      } catch (err) {
        fail(err)
        return false
      }
    },

    configure: (patch) =>
      act(async (id) => {
        const session = await ipc('agents:configure', { id, ...patch })
        set((s) => ({ sessions: upsertSession(s.sessions, session) }))
      }),

    interrupt: () => act((id) => ipc('agents:interrupt', { id })),
    stop: (id) => act((x) => ipc('agents:stop', { id: x }), id),
    resume: (id) => act((x) => ipc('agents:resume', { id: x }), id),

    remove: (id) =>
      act(async (x) => {
        await ipc('agents:remove', { id: x })
        saveDraft(x, { text: '', refs: [] })
        set((s) => ({
          ...forget(s, x),
          sessions: s.sessions.filter((v) => v.id !== x),
          ...(s.activeId === x ? { activeId: undefined, view: 'empty' as const } : {})
        }))
      }, id),

    rename: (id, title) =>
      act(async (x) => {
        const session = await ipc('agents:rename', { id: x, title })
        set((s) => ({ sessions: upsertSession(s.sessions, session) }))
      }, id),

    openShell: async (id) => {
      try {
        return (await ipc('agents:shell', { id })).terminalId
      } catch (err) {
        fail(err)
        return undefined
      }
    },


    loadChanges: (id) =>
      act(async (x) => {
        const asked = (changesAsked.get(x) ?? 0) + 1
        changesAsked.set(x, asked)
        const changes = await ipc('agents:changes', { id: x })
        if (changesAsked.get(x) === asked) set((s) => ({ changes: { ...s.changes, [x]: changes } }))
      }, id),

    loadBranch: (id) =>
      act(async (x) => {
        const branch = await ipc('agents:branch', { id: x })
        set((s) => ({ branches: { ...s.branches, [x]: branch } }))
      }, id),

    showDiff: (path) => act(async (id) => set({ diff: await ipc('agents:diff', { id, path }) })),
    closeDiff: () => set({ diff: undefined }),

    accept: () =>
      act(async (id) => {
        set({ busy: true })
        await ipc('agents:accept', { id })
        set((s) => ({ busy: false, changes: { ...s.changes, [id]: [] } }))
      }),

    discard: () =>
      act(async (id) => {
        set({ busy: true })
        await ipc('agents:discard', { id })
        set((s) => ({ busy: false, changes: { ...s.changes, [id]: [] } }))
      }),

    clearError: () => set({ error: undefined })
  }
})

/** The active session and its messages (stable empty list while loading). */
const NONE: ChatMessage[] = []
export function useActiveSession(): { session?: AgentSession; messages: ChatMessage[] } {
  const session = useAgents((s) => s.sessions.find((x) => x.id === s.activeId))
  const messages = useAgents((s) => (s.activeId ? s.messages[s.activeId] : undefined)) ?? NONE
  return { session, messages }
}
