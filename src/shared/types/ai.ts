// The assistant and its agents (architecture §6–§9): models, conversations,
// tool calls and permission requests as every client sees them.
// Pure module (no DOM/Node/Electron) so it compiles under every tsconfig.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface ModelOption {
  id: string
  label: string
  note: string
}

/** Models the assistant offers. The first one is the default. */
export const MODELS: readonly ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Most capable · default' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Faster · lower cost' }
]

/** Models for suggestions while typing (Tab) — the first one is the default; the faster ones answer sooner. */
export const INLINE_MODELS: readonly ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Best suggestions · default' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Faster · lower cost' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest · lowest cost' }
]

/** Models Mindeck Cloud offers (the first one is the default); the cloud may offer fewer. */
export const CLOUD_MODELS: readonly ModelOption[] = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fast · light on credit · default' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Stronger · about 20× the credit' }
]

export interface AiSettings {
  /** The model with the user's own API key. */
  model: string
  /** The model through Mindeck Cloud (no key of one's own). */
  cloudModel: string
  effort: Effort
  /** Suggestions while typing, accepted with Tab (they cost tokens on every pause, so they're opt-in). */
  inline: boolean
  /** The model behind them. */
  inlineModel: string
}

export const DEFAULT_AI_SETTINGS: AiSettings = { model: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5', effort: 'high', inline: false, inlineModel: 'claude-opus-5-5' }

/** A suggestion at the cursor: the file around it. */
export interface InlineCompleteRequest {
  requestId: string
  /** Project-relative, for the model's orientation. */
  path: string
  language: string
  prefix: string
  suffix: string
}

/** ⌘K: rewrite the selection (or write at the cursor) as asked. */
export interface InlineEditRequest {
  requestId: string
  path: string
  language: string
  before: string
  selection: string
  after: string
  instruction: string
}

/** Text of a ⌘K edit as it is written. */
export interface InlineDelta {
  requestId: string
  text: string
  /** The paired device that asked: only it hears the edit (none: the desktop's, for no device). */
  device?: string
}

/** The AI credit through Mindeck Cloud (euro cents). */
export interface AiCredit {
  /** Lifetime license: per calendar month; trial: once. */
  period: 'month' | 'trial'
  allowanceCents: number
  usedCents: number
  remainingCents: number
  renewsAt: string | null
}

export interface AiStatus {
  /** The assistant can be used: an API key of one's own, or Mindeck Cloud. */
  configured: boolean
  /** Where it comes from: the environment wins over the stored key, either over the cloud. */
  source: 'env' | 'stored' | 'cloud' | null
  /** Last four characters of one's own key, for recognition only. */
  keyHint?: string
  /** The model in use right now. */
  model: string
  /**
   * Mindeck Cloud's AI (signed in): credit and models; null when signed out or
   * the cloud offers none. `blocked`: an admin switched it off for this account.
   */
  cloud: { credit: AiCredit; models: { id: string; label: string; costFactor: number }[]; blocked?: true } | null
  settings: AiSettings
}

// --- tools & permissions ------------------------------------------------------

/** read: no side effects · write: changes data · execute: runs commands. */
export type ToolRisk = 'read' | 'write' | 'execute'

export interface ToolInfo {
  name: string
  title: string
  description: string
  risk: ToolRisk
}

export interface AgentInfo {
  id: string
  name: string
  description: string
  /** Tool names this agent may call (allowlist). */
  tools: string[]
  /** Uses Anthropic-hosted web search/fetch. */
  web: boolean
}

export type ToolCallStatus = 'pending' | 'awaiting-approval' | 'running' | 'done' | 'error' | 'denied'

export interface ToolCallPart {
  type: 'tool'
  id: string
  name: string
  title: string
  risk: ToolRisk
  input: unknown
  status: ToolCallStatus
  /** Result text (truncated for display). */
  output?: string
  /** Pending approval, if any. */
  requestId?: string
  /** Executed on Anthropic's servers (web search/fetch). */
  server?: boolean
}

export type ChatPart = { type: 'text'; text: string } | ToolCallPart

export type ChatRole = 'user' | 'assistant'
export type ChatStatus = 'streaming' | 'done' | 'error' | 'cancelled'

/** What a user message carried besides its text (agent sessions): shown as chips. */
export interface MessageAttachment {
  kind: 'file' | 'folder' | 'note' | 'tab' | 'image'
  label: string
}

export interface ChatMessage {
  id: string
  role: ChatRole
  parts: ChatPart[]
  createdAt: string
  status: ChatStatus
  attachments?: MessageAttachment[]
  error?: string
  /** Why it failed, for the app to say in its own words (`ai-credit-exhausted`, `license-required` …). */
  errorCode?: string
  model?: string
  usage?: { inputTokens: number; outputTokens: number }
}

export interface ConversationSummary {
  id: string
  title: string
  agentId: string
  projectId?: string
  createdAt: string
  updatedAt: string
  /** A run is in progress. */
  running: boolean
}

export interface Conversation extends ConversationSummary {
  messages: ChatMessage[]
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout'

export interface AgentRun {
  id: string
  agentId: string
  conversationId: string
  goal: string
  projectId?: string
  model: string
  status: RunStatus
  startedAt: string
  endedAt?: string
  iterations: number
  inputTokens: number
  outputTokens: number
  error?: string
}

export type ApprovalDecision = 'once' | 'always' | 'deny'

export interface PermissionRequest {
  id: string
  runId: string
  conversationId: string
  agentId: string
  agentName: string
  toolName: string
  toolTitle: string
  risk: ToolRisk
  /** What exactly will happen, in plain words. */
  summary: string
  /** Why the agent wants it (from the agent). */
  reason: string
  input: unknown
  /** "Always allow" is offered for write tools only, never for execute (and never to a paired device). */
  allowAlways: boolean
  /** The project the tool acts in — an "Always allow" holds there only. */
  projectId?: string
  createdAt: string
}

/** A grant's `projectId` for every project: grants kept from before grants were per project. */
export const ALL_PROJECTS = '*'

/**
 * "Always allow": one agent, one tool, one project. `toolName` is the tool's
 * stable key — its name, or a tool kind (`edit`, `read` …) for agents whose
 * tool titles change with every call. Without `projectId` it holds in chats
 * outside any project; `ALL_PROJECTS` everywhere.
 */
export interface PermissionGrant {
  agentId: string
  toolName: string
  projectId?: string
  createdAt: string
}

/** Streaming text for the message currently being written. */
export interface AiDelta {
  conversationId: string
  messageId: string
  text: string
}

/** A message changed structurally (new part, tool status, finished). */
export interface AiMessageUpdate {
  conversationId: string
  message: ChatMessage
  running: boolean
}

export interface SendRequest {
  conversationId?: string
  agentId?: string
  projectId?: string
  text: string
}
