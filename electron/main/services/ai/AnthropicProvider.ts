import Anthropic from '@anthropic-ai/sdk'
import type { LlmBlock, LlmMessage, LlmProvider, LlmRequest, LlmTurn, ServerToolCall, StopReason } from './llm'
import { aiError } from './llm'

type Client = Pick<Anthropic, 'beta' | 'models'>
type Block = Anthropic.Beta.BetaContentBlock
type BlockParam = Anthropic.Beta.BetaContentBlockParam

const STOP_REASONS: readonly StopReason[] = ['end_turn', 'tool_use', 'max_tokens', 'refusal', 'pause_turn']
/** Mindeck Cloud's refusals → the codes the app branches on. */
const CLOUD_CODES: Record<string, string> = {
  ai_credit_exhausted: 'ai-credit-exhausted',
  license_required: 'license-required',
  ai_unavailable: 'ai-unavailable',
  ai_rate_limited: 'rate-limited',
  // An admin switched the cloud AI off for this account; a document by URL / Files API id the cloud can't price.
  ai_blocked: 'ai-blocked',
  ai_unsupported_content: 'ai-unsupported-content',
  session_invalid: 'session_expired',
  unauthorized: 'session_expired'
}

/** Models the API reroutes on a refusal (server-side fallback); Haiku has none. */
const FALLBACK_MODELS = /^claude-(opus|sonnet|fable)-/

/** Internal message → Messages API param. Blocks the model produced replay byte-for-byte. */
export function toApiMessage(m: LlmMessage): Anthropic.Beta.BetaMessageParam {
  const content = m.blocks.map((b): BlockParam => {
    if (b.type === 'opaque') return b.data as BlockParam
    if (b.type === 'tool_result') {
      return { type: 'tool_result', tool_use_id: b.callId, content: b.content, ...(b.isError ? { is_error: true } : {}) }
    }
    if (b.raw) return b.raw as BlockParam
    if (b.type === 'text') return { type: 'text', text: b.text }
    return { type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> }
  })
  return { role: m.role, content }
}

/** Response content → internal blocks, keeping each original block for replay. */
export function fromApiContent(content: Block[]): { blocks: LlmBlock[]; serverTools: ServerToolCall[] } {
  const blocks: LlmBlock[] = []
  const serverTools: ServerToolCall[] = []
  for (const block of content) {
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text, raw: block })
    else if (block.type === 'tool_use') blocks.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input, raw: block })
    else {
      blocks.push({ type: 'opaque', data: block })
      if (block.type === 'server_tool_use') serverTools.push({ id: block.id, name: block.name, input: block.input })
      else if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
        const call = serverTools.find((s) => s.id === block.tool_use_id)
        if (call) call.output = summarizeServerResult(block)
      }
    }
  }
  return { blocks, serverTools }
}

function summarizeServerResult(block: Anthropic.Beta.BetaWebSearchToolResultBlock | Anthropic.Beta.BetaWebFetchToolResultBlock): string {
  const c = block.content as unknown
  if (Array.isArray(c)) {
    return c.map((r: { title?: string; url?: string }) => `${r.title ?? ''} — ${r.url ?? ''}`).join('\n')
  }
  const obj = c as { error_code?: string; url?: string }
  return obj.error_code ? `error: ${obj.error_code}` : String(obj.url ?? 'fetched')
}

/**
 * Anthropic adapter: one streamed Messages API turn per call, adaptive
 * thinking (the default on the offered models), effort from the settings,
 * and the server-side refusal fallback so a declined request is retried on
 * the recommended model instead of failing.
 */
export class AnthropicProvider implements LlmProvider {
  constructor(
    private readonly client: Client,
    /** Through Mindeck Cloud: it adds the fallback itself and offers no server tools. */
    private readonly cloud = false
  ) {}

  static fromKey(apiKey: string): AnthropicProvider {
    return new AnthropicProvider(new Anthropic({ apiKey }))
  }

  /** Mindeck Cloud speaks the Messages API below `baseUrl`, signed in with the account's session — never with a key from the environment. */
  static forCloud(baseUrl: string, token: string): AnthropicProvider {
    return new AnthropicProvider(new Anthropic({ apiKey: null, authToken: token, baseURL: baseUrl }), true)
  }

  /** Cheap key check (no tokens spent): look up the model. */
  async verify(model: string): Promise<void> {
    try {
      await this.client.models.retrieve(model)
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw aiError('bad-key', 'The API key was rejected by Anthropic')
      if (err instanceof Anthropic.PermissionDeniedError) throw aiError('bad-key', 'This API key may not use the model')
      throw aiError('ai-unavailable', `Anthropic API unavailable: ${(err as Error).message}`)
    }
  }

  async stream(req: LlmRequest, onText: (text: string) => void): Promise<LlmTurn> {
    const tools: Anthropic.Beta.BetaToolUnion[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema
    }))
    if (req.webTools && !this.cloud) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 })
      tools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 })
    }

    try {
      const stream = this.client.beta.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          // Stable persona first and cached; volatile context rides in the user turn.
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: req.messages.map(toApiMessage),
          ...(tools.length ? { tools } : {}),
          output_config: { effort: req.effort },
          ...(FALLBACK_MODELS.test(req.model) && !this.cloud ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
        },
        { signal: req.signal, ...(this.cloud ? { headers: { 'x-mindeck-ai-kind': req.kind ?? 'assistant' } } : {}) }
      )
      stream.on('text', (delta) => onText(delta))
      const message = await stream.finalMessage()
      const { blocks, serverTools } = fromApiContent(message.content)
      const reason = message.stop_reason as StopReason
      return {
        message: { role: 'assistant', blocks },
        stopReason: STOP_REASONS.includes(reason) ? reason : 'other',
        model: message.model,
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
        serverTools
      }
    } catch (err) {
      if (req.signal?.aborted || err instanceof Anthropic.APIUserAbortError) throw aiError('cancelled', 'Cancelled')
      // Mindeck Cloud says why in its own words: { error: { code, message } }.
      const cloudError = this.cloud && err instanceof Anthropic.APIError ? (err.error as { error?: { code?: string; message?: string } } | undefined)?.error : undefined
      if (cloudError?.code) throw aiError(CLOUD_CODES[cloudError.code] ?? 'ai-error', cloudError.message ?? cloudError.code)
      if (err instanceof Anthropic.AuthenticationError) throw aiError('bad-key', 'The API key was rejected by Anthropic')
      if (err instanceof Anthropic.RateLimitError) throw aiError('rate-limited', 'Rate limited by Anthropic — try again shortly')
      if (err instanceof Anthropic.APIConnectionError) throw aiError('ai-unavailable', `Anthropic API unreachable: ${err.message}`)
      throw aiError('ai-error', `Anthropic API error: ${(err as Error).message}`)
    }
  }
}
