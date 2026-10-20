import { create } from 'zustand'
import { errorMessage, ipc, onEvent, onResync } from '@shared/ipc/client'
import type {
  AgentInfo,
  AiSettings,
  AiStatus,
  ApprovalDecision,
  ChatMessage,
  ConversationSummary,
  PermissionRequest
} from '@shared/types/ai'
import type { MindeckEvent } from '@shared/types/events'

const ACTIVITY_CAP = 200
/** Chats whose messages stay in memory (the most recently opened); others load again when opened. */
export const CACHED_CHATS = 20

/** Streamed text lands in the message's last text part (a new one after a tool) — same rule as the core. */
export function applyDelta(list: ChatMessage[], messageId: string, text: string): ChatMessage[] {
  const i = list.findIndex((m) => m.id === messageId)
  if (i < 0) return list
  const m = list[i]
  const last = m.parts[m.parts.length - 1]
  const parts = last?.type === 'text' ? [...m.parts.slice(0, -1), { ...last, text: last.text + text }] : [...m.parts, { type: 'text' as const, text }]
  const next = [...list]
  next[i] = { ...m, parts }
  return next
}

export function upsertMessage(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const i = list.findIndex((m) => m.id === message.id)
  if (i < 0) return [...list, message]
  const next = [...list]
  next[i] = message
  return next
}

/**
 * Fetched history merged with what arrived live. Live wins (it saw every
 * change) — unless the push channel had a gap, then the fetched copy does.
 */
function merge(fetched: ChatMessage[], live: ChatMessage[] = [], liveWins = true): ChatMessage[] {
  const byId = new Map(live.map((m) => [m.id, m]))
  const merged = fetched.map((m) => (liveWins && byId.get(m.id)) || m)
  for (const m of live) if (!fetched.some((f) => f.id === m.id)) merged.push(m)
  return merged
}

interface AssistantState {
  status?: AiStatus
  agents: AgentInfo[]
  conversations: ConversationSummary[]
  /** Open conversation; undefined = a new chat. */
  activeId?: string
  /** Agent for the next new chat. */
  agentId: string
  /** Project the next message is scoped to. */
  projectId?: string
  messages: Record<string, ChatMessage[]>
  running: Record<string, boolean>
  pending: PermissionRequest[]
  activity: MindeckEvent[]
  sending: boolean
  loading: boolean
  error?: string

  /** Subscribe to push events + initial load. Returns the unsubscribe. */
  connect: () => () => void
  refresh: () => Promise<void>
  open: (id: string) => Promise<void>
  newChat: (agentId?: string) => void
  setProject: (projectId?: string) => void
  send: (text: string) => Promise<boolean>
  cancel: () => Promise<void>
  /** Stop any running conversation. */
  stop: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  respond: (id: string, decision: ApprovalDecision) => Promise<void>
  setKey: (key: string) => Promise<boolean>
  clearKey: () => Promise<void>
  configure: (patch: Partial<AiSettings>) => Promise<void>
  clearError: () => void
}

let connections = 0
let unsubscribe: (() => void) | null = null
let recentChats: string[] = []

export const useAssistant = create<AssistantState>((set, get) => {
  const fail = (err: unknown) => set({ error: errorMessage(err) })

  const loadConversations = async () => {
    const conversations = await ipc('ai:conversations')
    set((s) => ({
      conversations,
      running: { ...s.running, ...Object.fromEntries(conversations.map((c) => [c.id, c.running])) }
    }))
  }

  /** One conversation from the core, into the cache. */
  const load = async (id: string, liveWins = true) => {
    const conv = await ipc('ai:conversation', { id })
    recentChats = [id, ...recentChats.filter((x) => x !== id)].slice(0, CACHED_CHATS)
    set((s) => ({
      messages: Object.fromEntries(
        Object.entries({ ...s.messages, [id]: merge(conv.messages, s.messages[id], liveWins) }).filter(([key]) => key === s.activeId || recentChats.includes(key))
      ),
      running: { ...s.running, [id]: conv.running },
      // A late answer for a chat that is no longer open must not scope the next message to its project.
      ...(s.activeId === id ? { projectId: conv.projectId } : {})
    }))
  }

  /**
   * The push channel was down: approvals, statuses and streamed text from the
   * gap are missing. Reload them; cached chats other than the open one are
   * dropped and come fresh when opened again.
   */
  const resync = async () => {
    const id = get().activeId
    set((s) => ({ messages: id && s.messages[id] ? { [id]: s.messages[id] } : {} }))
    await get().refresh()
    if (id) await load(id, false).catch(fail)
  }

  const subscribe = () => {
    const offs = [
      onResync(() => void resync()),
      onEvent('ai:delta', ({ conversationId, messageId, text }) =>
        set((s) => {
          const list = s.messages[conversationId]
          return list ? { messages: { ...s.messages, [conversationId]: applyDelta(list, messageId, text) } } : {}
        })
      ),
      onEvent('ai:message', ({ conversationId, message, running }) => {
        set((s) => ({
          messages: { ...s.messages, [conversationId]: upsertMessage(s.messages[conversationId] ?? [], message) },
          running: { ...s.running, [conversationId]: running }
        }))
        // An answer finished: the credit through Mindeck Cloud changed.
        if (!running && get().status?.source === 'cloud') void ipc('ai:status').then((status) => set({ status }), () => {})
      }),
      onEvent('ai:conversationsChanged', ({ reason, id }) => {
        if (reason === 'deleted' && get().activeId === id) set({ activeId: undefined })
        void loadConversations().catch(fail)
      }),
      onEvent('permission:request', (req) => set((s) => ({ pending: [...s.pending.filter((p) => p.id !== req.id), req] }))),
      onEvent('permission:resolved', ({ id }) => set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }))),
      onEvent('events:event', (event) => set((s) => ({ activity: [event, ...s.activity].slice(0, ACTIVITY_CAP) })))
    ]
    return () => offs.forEach((off) => off())
  }

  return {
    agents: [],
    conversations: [],
    agentId: 'assistant',
    messages: {},
    running: {},
    pending: [],
    activity: [],
    sending: false,
    loading: false,

    connect: () => {
      connections += 1
      if (connections === 1) {
        unsubscribe = subscribe()
        void get().refresh()
      }
      return () => {
        connections -= 1
        if (connections === 0) {
          unsubscribe?.()
          unsubscribe = null
        }
      }
    },

    refresh: async () => {
      set({ loading: true })
      try {
        const [status, agents, , pending, activity] = await Promise.all([
          ipc('ai:status'),
          ipc('ai:agents'),
          loadConversations(),
          ipc('permission:pending'),
          ipc('events:recent', { limit: 100 })
        ])
        set({ status, agents, pending, activity, loading: false })
      } catch (err) {
        set({ loading: false })
        fail(err)
      }
    },

    open: async (id) => {
      set({ activeId: id, error: undefined })
      try {
        await load(id)
      } catch (err) {
        fail(err)
      }
    },

    newChat: (agentId) => set((s) => ({ activeId: undefined, agentId: agentId ?? s.agentId, error: undefined })),

    setProject: (projectId) => set({ projectId }),

    send: async (text) => {
      const s = get()
      if (!text.trim() || s.sending) return false
      set({ sending: true, error: undefined })
      try {
        const res = await ipc('ai:send', {
          text,
          ...(s.activeId ? { conversationId: s.activeId } : { agentId: s.agentId }),
          ...(s.projectId ? { projectId: s.projectId } : {})
        })
        set({ sending: false })
        if (get().activeId !== res.conversationId) await get().open(res.conversationId)
        return true
      } catch (err) {
        set({ sending: false })
        fail(err)
        return false
      }
    },

    cancel: async () => {
      const id = get().activeId
      if (id) await get().stop(id)
    },

    stop: async (id) => {
      await ipc('ai:cancel', { conversationId: id }).catch(fail)
    },

    remove: async (id) => {
      try {
        await ipc('ai:deleteConversation', { id })
        set((s) => {
          const { [id]: _gone, ...messages } = s.messages
          return { messages, ...(s.activeId === id ? { activeId: undefined } : {}) }
        })
        await loadConversations()
      } catch (err) {
        fail(err)
      }
    },

    respond: async (id, decision) => {
      try {
        await ipc('permission:respond', { id, decision })
        set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }))
      } catch (err) {
        set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }))
        fail(err)
      }
    },

    setKey: async (key) => {
      set({ error: undefined })
      try {
        set({ status: await ipc('ai:setKey', { key }) })
        return true
      } catch (err) {
        fail(err)
        return false
      }
    },

    clearKey: async () => {
      try {
        set({ status: await ipc('ai:clearKey') })
      } catch (err) {
        fail(err)
      }
    },

    configure: async (patch) => {
      try {
        set({ status: await ipc('ai:configure', patch) })
      } catch (err) {
        fail(err)
      }
    },

    clearError: () => set({ error: undefined })
  }
})

/** Messages of the open conversation (stable empty array). */
const EMPTY: ChatMessage[] = []
export function useActiveMessages(): ChatMessage[] {
  return useAssistant((s) => (s.activeId ? (s.messages[s.activeId] ?? EMPTY) : EMPTY))
}
