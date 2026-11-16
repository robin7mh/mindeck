import { CLOUD_MODELS, DEFAULT_AI_SETTINGS, EFFORTS, INLINE_MODELS, MODELS, type AiSettings, type AiStatus } from '@shared/types/ai'
import type { SettingsService } from '../settings/SettingsService'
import type { SecretStore } from './SecretStore'
import { AnthropicProvider } from './AnthropicProvider'
import { aiError, type LlmProvider } from './llm'

const KEY = 'anthropic_api_key'

export interface ProviderFactory {
  create(apiKey: string): LlmProvider & { verify(model: string): Promise<void> }
  /** The AI through Mindeck Cloud: its address and the account's session. */
  cloud?(baseUrl: string, token: string): LlmProvider
}

const anthropic: ProviderFactory = {
  create: (key) => AnthropicProvider.fromKey(key),
  cloud: (baseUrl, token) => AnthropicProvider.forCloud(baseUrl, token)
}

/** A released app: the stored key goes to Anthropic, whatever the environment says. */
export const releasedAnthropic: ProviderFactory = { ...anthropic, create: (key) => AnthropicProvider.fromKey(key, 'https://api.anthropic.com') }

/** What the assistant needs from the Mindeck account. */
export interface CloudAi {
  /** The cloud's AI endpoint (the Messages API lives below it). */
  baseUrl: string
  /** The account's session token — null when signed out. */
  token(): Promise<string | null>
  /** The account's AI credit and models — null when signed out, offline or the cloud offers none. */
  info(): Promise<AiStatus['cloud']>
}

/**
 * The assistant's configuration and where its AI comes from: an API key of
 * the user's own (environment first, else the secret store) — or, without
 * one, Mindeck Cloud with the account's credit. Model and effort per source.
 * Keys never leave the core.
 */
export class AiService {
  private cached?: { key: string; provider: LlmProvider }

  constructor(
    private readonly deps: {
      settings: SettingsService
      secrets: SecretStore
      env?: NodeJS.ProcessEnv
      factory?: ProviderFactory
      cloud?: CloudAi
    }
  ) {}

  settings(): AiSettings {
    return { ...DEFAULT_AI_SETTINGS, ...this.deps.settings.get().ai }
  }

  async status(): Promise<AiStatus> {
    const { key, source } = await this.key()
    const settings = this.settings()
    if (key) return { configured: true, source, keyHint: key.slice(-4), model: settings.model, cloud: await this.cloudInfo(), settings }
    const cloud = await this.cloudInfo()
    return { configured: !!cloud, source: cloud ? 'cloud' : null, model: cloud ? settings.cloudModel : settings.model, cloud, settings }
  }

  /** Verifies the key with Anthropic (no tokens spent), then stores it. */
  async setKey(key: string): Promise<AiStatus> {
    const trimmed = key.trim()
    if (!/^\S{20,}$/.test(trimmed)) throw aiError('bad-key', 'That does not look like an API key')
    await this.factory().create(trimmed).verify(this.settings().model)
    await this.deps.secrets.set(KEY, trimmed)
    return this.status()
  }

  async clearKey(): Promise<AiStatus> {
    await this.deps.secrets.set(KEY, null)
    return this.status()
  }

  async configure(patch: Partial<AiSettings>): Promise<AiStatus> {
    const next = { ...this.settings(), ...patch }
    if (!MODELS.some((m) => m.id === next.model)) throw aiError('bad-model', `Unknown model: ${next.model}`)
    if (!CLOUD_MODELS.some((m) => m.id === next.cloudModel)) throw aiError('bad-model', `Unknown model: ${next.cloudModel}`)
    if (!EFFORTS.includes(next.effort)) throw aiError('bad-effort', `Unknown effort: ${next.effort}`)
    if (!INLINE_MODELS.some((m) => m.id === next.inlineModel)) throw aiError('bad-model', `Unknown model: ${next.inlineModel}`)
    await this.deps.settings.update({ ai: next })
    return this.status()
  }

  /** The user's own key is in use (no credit, everything allowed). */
  async ownKey(): Promise<boolean> {
    return !!(await this.key()).key
  }

  /** The model for the AI in use: one's own key's, else the cloud's. */
  async model(): Promise<string> {
    const settings = this.settings()
    return (await this.ownKey()) ? settings.model : settings.cloudModel
  }

  /** A provider: one's own key, else Mindeck Cloud with the account — else a `no-key` error the UI turns into setup. */
  async provider(): Promise<LlmProvider> {
    const { key } = await this.key()
    if (key) {
      if (this.cached?.key !== key) this.cached = { key, provider: this.factory().create(key) }
      return this.cached.provider
    }
    const token = await this.deps.cloud?.token()
    const cloud = this.factory().cloud
    if (!token || !cloud) throw aiError('no-key', 'Sign in to your Mindeck account (or add your own API key in Settings → AI) to use the assistant')
    const id = `cloud:${token}`
    if (this.cached?.key !== id) this.cached = { key: id, provider: cloud(this.deps.cloud!.baseUrl, token) }
    return this.cached.provider
  }

  private async cloudInfo(): Promise<AiStatus['cloud']> {
    return (await this.deps.cloud?.info().catch(() => null)) ?? null
  }

  private factory(): ProviderFactory {
    return this.deps.factory ?? anthropic
  }

  private async key(): Promise<{ key?: string; source: 'env' | 'stored' | null }> {
    const fromEnv = (this.deps.env ?? process.env).ANTHROPIC_API_KEY?.trim()
    if (fromEnv) return { key: fromEnv, source: 'env' }
    const stored = await this.deps.secrets.get(KEY)
    return stored ? { key: stored, source: 'stored' } : { source: null }
  }
}
