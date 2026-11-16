import type { z } from 'zod'
import type { ToolRisk } from '@shared/types/ai'

/** What a tool may use — injected, so tools never reach for fs/child_process themselves. */
export interface ToolContext {
  /** Project the conversation is scoped to, if any. */
  projectId?: string
  /** Only `projectId` may be named (an agent through MCP: its session's project, never another one). */
  onlyProject?: boolean
  signal: AbortSignal
  /** Who calls (an agent's name, e.g. "Claude Code") — shown where the tool acts, like a browser tab. */
  agent?: string
  /** The folder the agent works in (its session's: a worktree when isolated) — where its commands start. */
  cwd?: string
  /** The conversation calling (an agent session's id): whose terminal commands it may read and stop. */
  conversationId?: string
}

/** A result block for clients that take more than text (MCP: screenshots as images). */
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/**
 * A tool the agents can call (architecture §8). Tools call existing services
 * — every capability exists exactly once. Write/execute tools carry a
 * required `reason` the user sees in the approval prompt.
 */
export interface ToolDefinition<I = unknown> {
  name: string
  title: string
  description: string
  risk: ToolRisk
  /** Shows what a terminal printed: a paired device needs remote shells for it, as for `terminal:data`. */
  shell?: boolean
  schema: z.ZodType<I>
  /** JSON Schema sent to the model (generated from `schema`). */
  inputSchema?: Record<string, unknown>
  /** Plain-words summary for the approval prompt and the activity log. */
  summarize(input: I): string
  run(input: I, ctx: ToolContext): Promise<string>
  /** Text and images, where the client takes them (MCP). Without it, `run`'s text is the result. */
  runContent?(input: I, ctx: ToolContext): Promise<ToolContent[]>
}
