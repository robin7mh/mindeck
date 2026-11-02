import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from '../../lib/writeAtomic'
import type { ChatMessage, ConversationSummary } from '@shared/types/ai'
import type { LlmMessage } from './llm'

/** One conversation on disk: what the user sees and what the model gets. */
export interface StoredConversation {
  id: string
  title: string
  agentId: string
  projectId?: string
  createdAt: string
  updatedAt: string
  /** Display messages (one assistant message per run). */
  messages: ChatMessage[]
  /** Provider transcript — append-only, replayed to the model each turn. */
  transcript: LlmMessage[]
}

const SAFE_ID = /^[a-zA-Z0-9-]{1,64}$/

/**
 * Conversations as JSON files under ~/Mindeck/data/conversations — the
 * assistant works with or without the database container, and a conversation
 * is backed up by copying one folder.
 */
export class ConversationStore {
  private readonly dir: string
  private index?: Map<string, ConversationSummary>

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'conversations')
  }

  async list(): Promise<Omit<ConversationSummary, 'running'>[]> {
    return [...(await this.loadIndex()).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** The project a conversation belongs to (undefined: none, or no such conversation) — from the index, no file read. */
  async projectOf(id: string): Promise<string | undefined> {
    return (await this.loadIndex()).get(id)?.projectId
  }

  async get(id: string): Promise<StoredConversation | null> {
    if (!SAFE_ID.test(id)) return null
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as StoredConversation
    } catch {
      return null
    }
  }

  async save(c: StoredConversation): Promise<void> {
    if (!SAFE_ID.test(c.id)) throw Object.assign(new Error('Invalid conversation id'), { code: 'bad-id' })
    // Prompts, file contents and tool output: for the user's eyes only.
    await writeAtomic(this.file(c.id), JSON.stringify(c), 0o600)
    const { messages: _m, transcript: _t, ...summary } = c
    ;(await this.loadIndex()).set(c.id, { ...summary, running: false })
  }

  async delete(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) return
    await rm(this.file(id), { force: true })
    ;(await this.loadIndex()).delete(id)
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  private async loadIndex(): Promise<Map<string, ConversationSummary>> {
    if (this.index) return this.index
    const index = new Map<string, ConversationSummary>()
    const names = await readdir(this.dir).catch(() => [] as string[])
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const c = await this.get(name.slice(0, -5))
      if (c) index.set(c.id, { id: c.id, title: c.title, agentId: c.agentId, projectId: c.projectId, createdAt: c.createdAt, updatedAt: c.updatedAt, running: false })
    }
    this.index = index
    return index
  }
}
