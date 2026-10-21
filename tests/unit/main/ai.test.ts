import { createServer, type IncomingMessage, type Server } from 'node:http'
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { tempDir, tick } from './helpers'
import { AnthropicProvider, fromApiContent, toApiMessage } from '../../../electron/main/services/ai/AnthropicProvider'
import { SecretStore } from '../../../electron/main/services/ai/SecretStore'
import { AiService } from '../../../electron/main/services/ai/AiService'
import { ToolRegistry } from '../../../electron/main/services/ai/tools/registry'
import { browserTools } from '../../../electron/main/services/ai/tools/browser'
import { terminalTools } from '../../../electron/main/services/ai/tools/terminal'
import { builtinTools, formatContext, runShell, truncate, type ToolDeps } from '../../../electron/main/services/ai/tools/builtin'
import { confine } from '../../../electron/main/lib/confine'
import { PermissionService } from '../../../electron/main/services/ai/PermissionService'
import { ConversationStore, type StoredConversation } from '../../../electron/main/services/ai/ConversationStore'
import { RunStore } from '../../../electron/main/services/ai/RunStore'
import { ContextBuilder } from '../../../electron/main/services/ai/ContextBuilder'
import { AGENTS, agentById, agentInfo } from '../../../electron/main/services/ai/agents'
import { aiError, type LlmProvider, type LlmRequest, type LlmTurn } from '../../../electron/main/services/ai/llm'
import { EventBus } from '../../../electron/main/services/events/EventBus'
import { EventLog } from '../../../electron/main/services/events/EventLog'
import { SettingsService } from '../../../electron/main/services/settings/SettingsService'
import type { Project } from '@shared/types/project'
import type { ProjectContext } from '@shared/types/context'
import type { AgentRun } from '@shared/types/ai'
import type { MindeckEvent } from '@shared/types/events'

// --- a local Messages API that speaks real SSE ---------------------------------

type Sse = { event: string; data: Record<string, unknown> }
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

async function fakeApi(handler: (req: IncomingMessage, body: Record<string, unknown>) => { status: number; sse?: Sse[]; json?: unknown; hang?: boolean }) {
  const seen: { headers: IncomingMessage['headers']; body: Record<string, unknown>; url: string }[] = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) : {}
    seen.push({ headers: req.headers, body, url: req.url! })
    const out = handler(req, body)
    if (out.hang) return // never answers (abort tests)
    if (out.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const e of out.sse) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
      res.end()
      return
    }
    res.writeHead(out.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out.json ?? {}))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  servers.push(server)
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const client = new Anthropic({ apiKey: 'sk-test', baseURL: url, maxRetries: 0 })
  return { provider: new AnthropicProvider(client), seen, url }
}

const start = (model = 'claude-opus-5-5') => ({
  event: 'message_start',
  data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 } } }
})
const block = (index: number, content_block: Record<string, unknown>) => ({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block } })
const delta = (index: number, d: Record<string, unknown>) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: d } })
const stop = (index: number) => ({ event: 'content_block_stop', data: { type: 'content_block_stop', index } })
const end = (stop_reason: string, output_tokens = 7) => [
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens } } },
  { event: 'message_stop', data: { type: 'message_stop' } }
]
const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: 'claude-opus-5-5',
  effort: 'high',
  system: 'sys',
  messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  webTools: false,
  maxTokens: 1000,
  ...over
})

describe('AnthropicProvider', () => {
  it('streams text, tool calls and server tools; sends effort, cached system and the default fallback', async () => {
    const { provider, seen } = await fakeApi(() => ({
      status: 200,
      sse: [
        start('claude-opus-5-5'),
        block(0, { type: 'text', text: '' }),
        delta(0, { type: 'text_delta', text: 'Hel' }),
        delta(0, { type: 'text_delta', text: 'lo' }),
        stop(0),
        block(1, { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} }),
        delta(1, { type: 'input_json_delta', partial_json: '{"query":"mindeck"}' }),
        stop(1),
        block(2, {
          type: 'web_search_tool_result',
          tool_use_id: 'srv_1',
          content: [{ type: 'web_search_result', title: 'Mindeck', url: 'https://w.one', encrypted_content: 'x', page_age: null }]
        }),
        stop(2),
        block(3, { type: 'tool_use', id: 'tu_1', name: 'memory_search', input: {} }),
        delta(3, { type: 'input_json_delta', partial_json: '{"query":"x"}' }),
        stop(3),
        ...end('tool_use')
      ]
    }))
    const texts: string[] = []
    const turn = await provider.stream(
      request({ tools: [{ name: 'memory_search', description: 'd', inputSchema: { type: 'object' } }], webTools: true }),
      (t) => texts.push(t)
    )
    expect(texts.join('')).toBe('Hello')
    expect(turn.stopReason).toBe('tool_use')
    expect(turn.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
    expect(turn.model).toBe('claude-opus-5-5')
    expect(turn.message.blocks.map((b) => b.type)).toEqual(['text', 'opaque', 'opaque', 'tool_call'])
    expect(turn.message.blocks[3]).toMatchObject({ type: 'tool_call', id: 'tu_1', name: 'memory_search', input: { query: 'x' } })
    expect(turn.serverTools).toEqual([{ id: 'srv_1', name: 'web_search', input: { query: 'mindeck' }, output: 'Mindeck — https://w.one' }])

    const body = seen[0].body
    expect(seen[0].headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 1000,
      stream: true,
      fallbacks: 'default',
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]
    })
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(['memory_search', 'web_search', 'web_fetch'])
    expect(body).not.toHaveProperty('thinking') // adaptive by default on the offered models

    // the model's own blocks replay unchanged
    const replay = toApiMessage(turn.message)
    expect(replay.content).toEqual(turn.message.blocks.map((b) => (b as { raw?: unknown; data?: unknown }).raw ?? (b as { data?: unknown }).data))
  })

  it('maps stop reasons and omits tools when there are none', async () => {
    let reason = 'end_turn'
    const { provider, seen } = await fakeApi(() => ({ status: 200, sse: [start(), ...end(reason)] }))
    for (const r of ['end_turn', 'max_tokens', 'refusal', 'pause_turn', 'stop_sequence']) {
      reason = r
      const turn = await provider.stream(request(), () => {})
      expect(turn.stopReason).toBe(r === 'stop_sequence' ? 'other' : r)
    }
    expect(seen[0].body).not.toHaveProperty('tools')
    // Haiku has no server-side fallback: none asked for.
    await provider.stream(request({ model: 'claude-haiku-5-5' }), () => {})
    const haiku = seen[seen.length - 1]
    expect(haiku.body).not.toHaveProperty('fallbacks')
    expect(haiku.headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback')
  })

  it('through Mindeck Cloud: the account’s session (never a key from the environment), what it’s for, no web or fallback; the cloud’s refusals by code', async () => {
    let status = 200
    let error: Record<string, unknown> = {}
    const { url, seen } = await fakeApi(() =>
      status === 200 ? { status, sse: [start('claude-haiku-5-5'), block(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'Hi' }), stop(0), ...end('end_turn')] } : { status, json: { error } }
    )
    const saved = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-users-own-key'
    try {
      const cloud = AnthropicProvider.forCloud(`${url}/ai`, 'ws_session')
      const turn = await cloud.stream(request({ model: 'claude-sonnet-5-5', webTools: true, kind: 'edit' }), () => {})
      expect(turn.message.blocks).toMatchObject([{ type: 'text', text: 'Hi' }])
      const sent = seen[0]
      expect(sent.url).toBe('/ai/v1/messages?beta=true')
      expect(sent.headers.authorization).toBe('Bearer ws_session')
      expect(sent.headers['x-api-key']).toBeUndefined()
      expect(sent.headers['x-mindeck-ai-kind']).toBe('edit')
      expect(sent.headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback')
      expect(sent.body).not.toHaveProperty('fallbacks')
      expect(sent.body).not.toHaveProperty('tools')
      await cloud.stream(request(), () => {})
      expect(seen[1].headers['x-mindeck-ai-kind']).toBe('assistant')

      const refused = async (s: number, e: Record<string, unknown>) => {
        status = s
        error = e
        return cloud.stream(request(), () => {}).catch((err: { code: string; message: string }) => ({ code: err.code, message: err.message }))
      }
      expect(await refused(402, { code: 'ai_credit_exhausted', message: 'Guthaben aufgebraucht.' })).toEqual({ code: 'ai-credit-exhausted', message: 'Guthaben aufgebraucht.' })
      expect(await refused(403, { code: 'license_required', message: 'Lizenz fehlt.' })).toMatchObject({ code: 'license-required' })
      expect(await refused(503, { code: 'ai_unavailable', message: 'Pause.' })).toMatchObject({ code: 'ai-unavailable' })
      expect(await refused(429, { code: 'ai_rate_limited', message: 'Busy.' })).toMatchObject({ code: 'rate-limited' })
      expect(await refused(403, { code: 'ai_blocked', message: 'Switched off.' })).toEqual({ code: 'ai-blocked', message: 'Switched off.' })
      expect(await refused(400, { code: 'ai_unsupported_content', message: 'Document by URL.', details: { path: 'messages.0.content.1' } })).toMatchObject({ code: 'ai-unsupported-content' })
      expect(await refused(401, { code: 'session_invalid', message: 'Session expired or revoked' })).toMatchObject({ code: 'session_expired' })
      expect(await refused(400, { code: 'invalid_input' })).toEqual({ code: 'ai-error', message: 'invalid_input' })
      // Not the cloud's words (a proxy in between): as for Anthropic itself.
      expect(await refused(500, {})).toMatchObject({ code: 'ai-error' })
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved
    }
  })

  it('turns API failures into coded errors', async () => {
    let status = 401
    const { provider } = await fakeApi(() => ({ status, json: { type: 'error', error: { type: 'x', message: 'nope' } } }))
    await expect(provider.stream(request(), () => {})).rejects.toMatchObject({ code: 'bad-key' })
    status = 429
    await expect(provider.stream(request(), () => {})).rejects.toMatchObject({ code: 'rate-limited' })
    status = 500
    await expect(provider.stream(request(), () => {})).rejects.toMatchObject({ code: 'ai-error' })

    const down = new AnthropicProvider(new Anthropic({ apiKey: 'k', baseURL: 'http://127.0.0.1:1', maxRetries: 0 }))
    await expect(down.stream(request(), () => {})).rejects.toMatchObject({ code: 'ai-unavailable' })

    const { provider: slow } = await fakeApi(() => ({ status: 200, hang: true }))
    const ac = new AbortController()
    const pending = slow.stream(request({ signal: ac.signal }), () => {})
    await tick(30)
    ac.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('verifies keys via the models endpoint', async () => {
    let status = 200
    const { provider, seen } = await fakeApi(() => ({ status, json: status === 200 ? { id: 'claude-opus-5-5', type: 'model' } : { error: { message: 'x' } } }))
    await provider.verify('claude-opus-5-5')
    expect(seen[0].url).toContain('/v1/models/claude-opus-5-5')
    for (const [s, code] of [[401, 'bad-key'], [403, 'bad-key'], [500, 'ai-unavailable']] as const) {
      status = s
      await expect(provider.verify('m')).rejects.toMatchObject({ code })
    }
    const down = new AnthropicProvider(new Anthropic({ apiKey: 'k', baseURL: 'http://127.0.0.1:1', maxRetries: 0 }))
    await expect(down.verify('m')).rejects.toMatchObject({ code: 'ai-unavailable' })
    expect(AnthropicProvider.fromKey('sk-x')).toBeInstanceOf(AnthropicProvider)
  })

  it('converts internal messages for the API', () => {
    expect(
      toApiMessage({
        role: 'user',
        blocks: [
          { type: 'text', text: 'a' },
          { type: 'tool_result', callId: 't1', content: 'ok' },
          { type: 'tool_result', callId: 't2', content: 'bad', isError: true }
        ]
      }).content
    ).toEqual([
      { type: 'text', text: 'a' },
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 't2', content: 'bad', is_error: true }
    ])
    expect(toApiMessage({ role: 'assistant', blocks: [{ type: 'tool_call', id: 'x', name: 'n', input: { a: 1 } }] }).content).toEqual([
      { type: 'tool_use', id: 'x', name: 'n', input: { a: 1 } }
    ])
    const fetched = fromApiContent([
      { type: 'server_tool_use', id: 's1', name: 'web_fetch', input: { url: 'u' } } as never,
      { type: 'web_fetch_tool_result', tool_use_id: 's1', content: { type: 'web_fetch_result', url: 'https://x' } } as never,
      { type: 'server_tool_use', id: 's2', name: 'web_fetch', input: {} } as never,
      { type: 'web_fetch_tool_result', tool_use_id: 's2', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_allowed' } } as never,
      { type: 'web_fetch_tool_result', tool_use_id: 'unknown', content: {} } as never,
      { type: 'web_search_tool_result', tool_use_id: 's9', content: [{}] } as never,
      { type: 'server_tool_use', id: 's3', name: 'web_fetch', input: {} } as never,
      { type: 'web_fetch_tool_result', tool_use_id: 's3', content: {} } as never,
      { type: 'server_tool_use', id: 's4', name: 'web_search', input: {} } as never,
      { type: 'web_search_tool_result', tool_use_id: 's4', content: [{}] } as never,
      { type: 'thinking', thinking: 'hm', signature: 'sig' } as never
    ])
    expect(fetched.serverTools.map((s) => s.output)).toEqual(['https://x', 'error: url_not_allowed', 'fetched', ' — '])
    expect(fetched.blocks.at(-1)).toEqual({ type: 'opaque', data: { type: 'thinking', thinking: 'hm', signature: 'sig' } }) // kept for replay
  })
})

// --- key, settings, secrets ------------------------------------------------------

describe('SecretStore', () => {
  it('stores plain (0600) or encrypted values, survives corrupt files and keychain changes', async () => {
    const dir = await tempDir()
    const plain = new SecretStore(join(dir, 'plain.json'))
    expect(await plain.get('k')).toBeUndefined()
    await plain.set('k', 'v')
    expect(await new SecretStore(join(dir, 'plain.json')).get('k')).toBe('v')
    await plain.set('k', null)
    expect(await plain.get('k')).toBeUndefined()

    const cipher = { encrypt: (p: string) => Buffer.from(p).toString('base64'), decrypt: vi.fn((s: string) => Buffer.from(s, 'base64').toString()) }
    const enc = new SecretStore(join(dir, 'enc.json'), cipher)
    await enc.set('k', 'topsecret-value')
    const raw = await readFile(join(dir, 'enc.json'), 'utf8')
    expect(raw).not.toContain('topsecret-value')
    expect(JSON.parse(raw).encrypted).toBe(true)
    expect(await enc.get('k')).toBe('topsecret-value')
    cipher.decrypt.mockImplementation(() => {
      throw new Error('keychain')
    })
    expect(await enc.get('k')).toBeUndefined()

    await writeFile(join(dir, 'bad.json'), '{oops')
    expect(await new SecretStore(join(dir, 'bad.json')).get('k')).toBeUndefined()
    await writeFile(join(dir, 'null.json'), '{"secrets":null}')
    expect(await new SecretStore(join(dir, 'null.json')).get('k')).toBeUndefined()
  })

  it('changes at the same time all land (none builds on a stale copy); a failed one doesn’t stop the next', async () => {
    const dir = await tempDir()
    const file = join(dir, 'secrets.json')
    const store = new SecretStore(file)
    // e.g. the cloud heartbeat saves its certificate while the user saves a Mongo connection and a key
    await Promise.all([store.set('offline', 'cert'), store.set('mongo', 'uri'), store.set('ai', 'sk-1')])
    expect(JSON.parse(await readFile(file, 'utf8')).secrets).toEqual({ offline: 'cert', mongo: 'uri', ai: 'sk-1' })
    await Promise.all([store.set('mongo', null), store.set('remote', 'tok')])
    const again = new SecretStore(file)
    expect(await Promise.all(['offline', 'mongo', 'ai', 'remote'].map((k) => again.get(k)))).toEqual(['cert', undefined, 'sk-1', 'tok'])

    const blocked = new SecretStore(join(dir, 'missing-dir', 'x', 'secrets.json'))
    await writeFile(join(dir, 'missing-dir'), '') // a file where its folder would be: writing fails
    await expect(blocked.set('a', '1')).rejects.toThrow()
    await rm(join(dir, 'missing-dir'))
    await blocked.set('b', '2')
    expect(await blocked.get('b')).toBe('2')
    expect(await blocked.get('a')).toBeUndefined()
  })

  it('values encrypted by a keychain that is gone stay locked: never handed out, never mixed with plain ones', async () => {
    const dir = await tempDir()
    const file = join(dir, 'secrets.json')
    const cipher = { encrypt: (p: string) => `enc:${p}`, decrypt: (s: string) => s.replace(/^enc:/, '') }
    await new SecretStore(file, cipher).set('ai', 'sk-1')
    const before = await readFile(file, 'utf8')
    // e.g. Linux with the keyring locked: no cipher this time
    const locked = new SecretStore(file)
    expect(await locked.get('ai')).toBeUndefined() // not the cipher text as if it were the key
    await expect(locked.set('mongo', 'uri')).rejects.toMatchObject({ code: 'secrets-locked' })
    expect(await readFile(file, 'utf8')).toBe(before)
    // The keychain is back: all there.
    expect(await new SecretStore(file, cipher).get('ai')).toBe('sk-1')
  })

  it('plain values from a start without keychain are read, and encrypted with the next save', async () => {
    const dir = await tempDir()
    const file = join(dir, 'secrets.json')
    const cipher = { encrypt: (p: string) => `enc:${p}`, decrypt: (s: string) => s.replace(/^enc:/, '') }
    await new SecretStore(file).set('ai', 'sk-1')
    const store = new SecretStore(file, cipher)
    expect(await store.get('ai')).toBe('sk-1')
    await store.set('mongo', 'uri')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ encrypted: true, secrets: { ai: 'enc:sk-1', mongo: 'enc:uri' } })
    expect(await new SecretStore(file, cipher).get('ai')).toBe('sk-1')
    // A file from before the flag: encrypted when this machine encrypts.
    await writeFile(join(dir, 'old.json'), JSON.stringify({ secrets: { ai: 'enc:sk-2' } }))
    expect(await new SecretStore(join(dir, 'old.json'), cipher).get('ai')).toBe('sk-2')
    expect(await new SecretStore(join(dir, 'old.json')).get('ai')).toBe('enc:sk-2')
  })

  it.skipIf(process.platform === 'win32')('a file that can’t be read right now: nothing to give, and it is not written over', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = await tempDir()
    const file = join(dir, 'secrets.json')
    await symlink(file, file) // every read fails (ELOOP), like EACCES or EIO would
    const store = new SecretStore(file)
    expect(await store.get('ai')).toBeUndefined()
    await expect(store.set('ai', 'sk-1')).rejects.toMatchObject({ code: 'ELOOP' })
    expect((await lstat(file)).isSymbolicLink()).toBe(true)
  })
})

describe('AiService', () => {
  const CLOUD = { credit: { period: 'trial' as const, allowanceCents: 30, usedCents: 1, remainingCents: 29, renewsAt: null }, models: [{ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', costFactor: 1 }] }
  const setup = async (env: NodeJS.ProcessEnv = {}, cloud?: { token: string | null; info: typeof CLOUD | null | Error }) => {
    const dir = await tempDir()
    const settings = new SettingsService(join(dir, 'settings.json'))
    await settings.init()
    const verify = vi.fn(async () => {})
    const factory = {
      create: vi.fn((key: string) => ({ key, verify, stream: vi.fn() }) as never),
      cloud: vi.fn((baseUrl: string, token: string) => ({ baseUrl, token, stream: vi.fn() }) as never)
    }
    const cloudAi = cloud && {
      baseUrl: 'https://api.mindeck.test/ai',
      token: async () => cloud.token,
      info: async () => {
        if (cloud.info instanceof Error) throw cloud.info
        return cloud.info
      }
    }
    return { ai: new AiService({ settings, secrets: new SecretStore(join(dir, 's.json')), env, factory, cloud: cloudAi }), verify, factory, settings }
  }

  it('reports, verifies, stores and clears the key; env wins', async () => {
    const { ai, verify, factory } = await setup()
    expect(await ai.status()).toEqual({
      configured: false,
      source: null,
      model: 'claude-opus-5-5',
      cloud: null,
      settings: { model: 'claude-opus-5-5', cloudModel: 'claude-haiku-5-5', effort: 'high', inline: false, inlineModel: 'claude-opus-5-5' }
    })
    await expect(ai.provider()).rejects.toMatchObject({ code: 'no-key' })
    await expect(ai.setKey('short')).rejects.toMatchObject({ code: 'bad-key' })
    verify.mockRejectedValueOnce(aiError('bad-key', 'rejected'))
    await expect(ai.setKey('sk-ant-xxxxxxxxxxxxxxxxxxxx')).rejects.toThrow('rejected')
    expect(await ai.setKey('  sk-ant-xxxxxxxxxxxxxxxxABCD  ')).toMatchObject({ configured: true, source: 'stored', keyHint: 'ABCD' })
    const p1 = await ai.provider()
    expect(await ai.provider()).toBe(p1) // cached per key
    expect(factory.create).toHaveBeenLastCalledWith('sk-ant-xxxxxxxxxxxxxxxxABCD')
    expect(await ai.clearKey()).toMatchObject({ configured: false })

    const { ai: envAi } = await setup({ ANTHROPIC_API_KEY: ' sk-env-1234 ' })
    expect(await envAi.status()).toMatchObject({ configured: true, source: 'env', keyHint: '1234' })
  })

  it('without a key of one’s own: Mindeck Cloud with the account (its model, its credit); a key of one’s own wins', async () => {
    const { ai, factory } = await setup({}, { token: 'ws_session', info: CLOUD })
    expect(await ai.status()).toMatchObject({ configured: true, source: 'cloud', model: 'claude-haiku-5-5', cloud: CLOUD })
    expect(await ai.ownKey()).toBe(false)
    expect(await ai.model()).toBe('claude-haiku-5-5')
    const p1 = await ai.provider()
    expect(await ai.provider()).toBe(p1) // cached per session
    expect(factory.cloud).toHaveBeenCalledWith('https://api.mindeck.test/ai', 'ws_session')
    // A key of one's own: the assistant uses it; the credit is still shown.
    await ai.setKey('sk-ant-xxxxxxxxxxxxxxxxWXYZ')
    expect(await ai.status()).toMatchObject({ configured: true, source: 'stored', keyHint: 'WXYZ', model: 'claude-opus-5-5', cloud: CLOUD })
    expect(await ai.model()).toBe('claude-opus-5-5')
    expect(await ai.provider()).not.toBe(p1)

    // Signed in, but the cloud offers no AI (or can't be reached): not configured — yet the session still asks it (the cloud says why).
    const offline = await setup({}, { token: 'ws_session', info: new Error('offline') })
    expect(await offline.ai.status()).toMatchObject({ configured: false, source: null, cloud: null })
    expect(await offline.ai.provider()).toBeTruthy()
    // Signed out: setup.
    const out = await setup({}, { token: null, info: null })
    await expect(out.ai.provider()).rejects.toMatchObject({ code: 'no-key', message: expect.stringContaining('Sign in') })
  })

  it('validates model and effort; defaults to the Anthropic provider', async () => {
    const { ai, settings } = await setup()
    expect(await ai.configure({ model: 'claude-sonnet-5-5', effort: 'low' })).toMatchObject({ settings: { model: 'claude-sonnet-5-5', effort: 'low' } })
    expect(settings.get().ai).toEqual({ model: 'claude-sonnet-5-5', cloudModel: 'claude-haiku-5-5', effort: 'low', inline: false, inlineModel: 'claude-opus-5-5' })
    expect(await ai.configure({ cloudModel: 'claude-sonnet-5-5' })).toMatchObject({ settings: { cloudModel: 'claude-sonnet-5-5' } })
    await expect(ai.configure({ cloudModel: 'claude-opus-5-5' })).rejects.toMatchObject({ code: 'bad-model' })
    expect(await ai.configure({ inline: true, inlineModel: 'claude-haiku-5-5' })).toMatchObject({ settings: { inline: true, inlineModel: 'claude-haiku-5-5' } })
    await expect(ai.configure({ model: 'gpt-5' })).rejects.toMatchObject({ code: 'bad-model' })
    // Haiku suggests while typing; it isn't one of the assistant's models.
    await expect(ai.configure({ model: 'claude-haiku-5-5' })).rejects.toMatchObject({ code: 'bad-model' })
    await expect(ai.configure({ inlineModel: 'gpt-5' })).rejects.toMatchObject({ code: 'bad-model' })
    await expect(ai.configure({ effort: 'extreme' as never })).rejects.toMatchObject({ code: 'bad-effort' })

    const dir = await tempDir()
    const s2 = new SettingsService(join(dir, 'x.json'))
    await s2.init()
    const real = new AiService({ settings: s2, secrets: new SecretStore(join(dir, 'y.json')), env: { ANTHROPIC_API_KEY: 'sk-real-key' } })
    expect(await real.provider()).toBeInstanceOf(AnthropicProvider)
    const viaCloud = new AiService({ settings: s2, secrets: new SecretStore(join(dir, 'w.json')), env: {}, cloud: { baseUrl: 'http://127.0.0.1:1/ai', token: async () => 'ws_x', info: async () => null } })
    expect(await viaCloud.provider()).toBeInstanceOf(AnthropicProvider)
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      expect((await new AiService({ settings: s2, secrets: new SecretStore(join(dir, 'z.json')) }).status()).configured).toBe(false)
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
    }
  })
})

// --- tools ------------------------------------------------------------------------

const proj = (over: Partial<Project> = {}): Project => ({ id: 'p1', name: 'demo', path: '/nope', addedAt: '', lastSeenAt: '', ...over })
const ctxOf = (over: Partial<ProjectContext> = {}): ProjectContext => ({
  projectId: 'p1',
  indexedAt: '2026-10-01T00:00:00.000Z',
  fileCount: 3,
  dirCount: 1,
  truncated: false,
  tree: [{ path: 'src', type: 'dir' }, { path: 'a.ts', type: 'file' }],
  languages: ['TypeScript'],
  frameworks: ['React'],
  dependencies: [{ name: 'react', version: '18', dev: false }, { name: 'vitest', version: '3', dev: true }],
  configFiles: [{ name: 'tsconfig.json', kind: 'TypeScript' }],
  todos: [{ file: 'a.ts', line: 1, kind: 'TODO', text: 'fix' }],
  readme: { title: 'Demo', sections: ['Intro'] },
  packageJson: { scripts: ['dev', 'test'] },
  ...over
})

function toolDeps(over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    vault: {
      search: vi.fn(async (q: string) => (q === 'none' ? [] : [{ path: 'A.md', title: 'A', snippet: 'snip' }])),
      read: vi.fn(async (path: string) => ({
        path,
        title: 'A',
        folder: '',
        tags: path === 'T.md' ? ['x'] : [],
        modifiedAt: '',
        linkCount: 0,
        raw: '',
        body: path === 'Empty.md' ? '' : 'Body text\n\n',
        frontmatter: {},
        backlinks: path === 'T.md' ? [{ title: 'B' }] : [],
        links: {}
      })) as never,
      list: vi.fn(async () => [
        { path: 'A.md', title: 'A', folder: '', tags: ['t'], modifiedAt: '', linkCount: 0 },
        { path: 'Projekte/B.md', title: 'B', folder: 'Projekte', tags: [], modifiedAt: '', linkCount: 0 }
      ]),
      create: vi.fn(async (title: string, folder?: string) => ({ path: `${folder ? `${folder}/` : ''}${title}.md`, title, folder: '', tags: [], modifiedAt: '', linkCount: 0 })),
      writeBody: vi.fn(async (path: string) => ({ path }) as never)
    },
    projects: { list: () => [proj()] },
    context: { get: vi.fn(async () => null), reindex: vi.fn(async () => ctxOf()) },
    system: {
      snapshot: vi.fn(async () => ({
        cpu: { total: 12.4, cores: [1, 2] },
        mem: { usedPct: 50, usedGb: 8, totalGb: 16 },
        disk: { usedPct: 70, mount: '/' },
        net: { rxMbps: 0, txMbps: 0 },
        battery: { pct: 80, charging: true, hasBattery: true },
        uptimeSec: 7200,
        processes: [{ pid: 1, name: 'node', cpu: 3.21, mem: 120.4 }],
        ts: 0
      }))
    },
    ...over
  }
}

const signal = new AbortController().signal
const run = (tools: ReturnType<typeof builtinTools>, name: string, input: unknown, projectId?: string) => {
  const t = tools.find((x) => x.name === name)!
  return t.run(input as never, { projectId, signal })
}
const summary = (tools: ReturnType<typeof builtinTools>, name: string, input: unknown) => tools.find((x) => x.name === name)!.summarize(input as never)

describe('built-in tools', () => {
  it('memory tools search, read, list, create and append', async () => {
    const deps = toolDeps()
    const t = builtinTools(deps)
    expect(await run(t, 'memory_search', { query: 'x' })).toBe('- A.md (A): snip')
    expect(await run(t, 'memory_search', { query: 'none' })).toBe('No matching notes.')
    expect(await run(t, 'memory_read', { path: 'A.md' })).toBe('# A\n\nBody text\n\n')
    expect(await run(t, 'memory_read', { path: 'T.md' })).toContain('tags: x\nlinked from: B')
    expect(await run(t, 'memory_list', {})).toBe('- A.md [t]\n- Projekte/B.md')
    expect(await run(t, 'memory_list', { folder: 'Projekte/' })).toBe('- Projekte/B.md')
    expect(await run(t, 'memory_list', { folder: 'Nothing' })).toBe('No notes.')
    expect(await run(t, 'memory_create_note', { title: 'N', folder: 'F', body: 'b', reason: 'r' })).toBe('Created F/N.md')
    expect(deps.vault.writeBody).toHaveBeenLastCalledWith('F/N.md', 'b')
    expect(await run(t, 'memory_append', { path: 'A.md', text: 'more', reason: 'r' })).toBe('Appended to A.md')
    expect(deps.vault.writeBody).toHaveBeenLastCalledWith('A.md', 'Body text\n\nmore\n')
    await run(t, 'memory_append', { path: 'Empty.md', text: 'first', reason: 'r' })
    expect(deps.vault.writeBody).toHaveBeenLastCalledWith('Empty.md', 'first\n')
    expect(summary(t, 'memory_search', { query: 'q' })).toBe('Search the memory vault for "q"')
    expect(summary(t, 'memory_read', { path: 'A.md' })).toBe('Read the note A.md')
    expect(summary(t, 'memory_list', {})).toBe('List the notes in the vault')
    expect(summary(t, 'memory_list', { folder: 'F' })).toBe('List the notes in F')
    expect(summary(t, 'memory_create_note', { title: 'N' })).toBe('Create the note "N"')
    expect(summary(t, 'memory_create_note', { title: 'N', folder: 'F' })).toBe('Create the note "N" in F')
    expect(summary(t, 'memory_append', { path: 'A.md' })).toBe('Append text to the note A.md')

    const many = toolDeps({
      vault: { ...deps.vault, list: vi.fn(async () => Array.from({ length: 305 }, (_, i) => ({ path: `${i}.md`, title: '', folder: '', tags: [], modifiedAt: '', linkCount: 0 }))) }
    })
    expect(await run(builtinTools(many), 'memory_list', {})).toContain('… and 5 more')
    const empty = toolDeps({ vault: { ...deps.vault, list: vi.fn(async () => []) } })
    expect(await run(builtinTools(empty), 'memory_list', {})).toBe('No notes.')
  })

  it('project tools: list, overview, files — confined to the project', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'src', 'a.ts'), 'export {}')
    await writeFile(join(root, 'README.md'), '# hi')
    await writeFile(join(root, 'bin.dat'), Buffer.from([1, 0, 2]))
    await writeFile(join(root, 'big.txt'), 'x'.repeat(101 * 1024))
    const outside = await tempDir()
    await symlink(outside, join(root, 'escape'))
    const p = proj({
      path: root,
      git: { isRepo: true, branch: 'main', dirty: true },
      stack: { languages: ['TypeScript'], frameworks: ['React'], hasReadme: true }
    })
    const deps = toolDeps({ projects: { list: () => [p, proj({ id: 'p2', name: 'other', path: outside })] } })
    const t = builtinTools(deps)

    expect(await run(t, 'projects_list', {})).toBe(`- demo (id p1) ${root} · main (uncommitted changes) · TypeScript, React\n- other (id p2) ${outside}`)
    expect(await run(builtinTools(toolDeps({ projects: { list: () => [proj({ git: { isRepo: true } })] } })), 'projects_list', {})).toContain('· detached')
    expect(await run(builtinTools(toolDeps({ projects: { list: () => [] } })), 'projects_list', {})).toBe('No projects registered.')

    expect(await run(t, 'project_context', {}, 'p1')).toContain('Project demo')
    expect(deps.context.reindex).toHaveBeenCalledWith('p1')
    vi.mocked(deps.context.get).mockResolvedValueOnce(ctxOf({ truncated: true }))
    expect(await run(t, 'project_context', { projectId: 'demo' })).toContain('(scan truncated)')
    await expect(run(t, 'project_context', {})).rejects.toMatchObject({ code: 'no-project' })
    await expect(run(t, 'project_context', { projectId: 'zzz' })).rejects.toThrow('Unknown project: zzz')
    // An agent (MCP) is pinned to its session's project: another one — by id or name — is unknown to it (BE-SEC-28).
    const pinned = (input: unknown) => t.find((x) => x.name === 'project_context')!.run(input as never, { projectId: 'p1', onlyProject: true, signal })
    expect(await pinned({})).toContain('Project demo')
    expect(await pinned({ projectId: 'demo' })).toContain('Project demo')
    await expect(pinned({ projectId: 'p2' })).rejects.toThrow('Unknown project: p2')
    await expect(pinned({ projectId: 'other' })).rejects.toThrow('Unknown project: other')
    expect(deps.context.get).not.toHaveBeenCalledWith('p2')

    expect(await run(t, 'project_list_files', {}, 'p1')).toBe('src/\nbig.txt\nbin.dat\nescape\nREADME.md')
    expect(await run(t, 'project_list_files', { dir: 'src' }, 'p1')).toBe('a.ts')
    await mkdir(join(root, 'emptydir'))
    expect(await run(t, 'project_list_files', { dir: 'emptydir' }, 'p1')).toBe('(empty)')
    expect(await run(t, 'project_read_file', { path: 'src/a.ts' }, 'p1')).toBe('export {}')
    await expect(run(t, 'project_read_file', { path: 'src' }, 'p1')).rejects.toMatchObject({ code: 'not-a-file' })
    await expect(run(t, 'project_read_file', { path: 'bin.dat' }, 'p1')).rejects.toMatchObject({ code: 'binary' })
    await expect(run(t, 'project_read_file', { path: 'big.txt' }, 'p1')).rejects.toMatchObject({ code: 'too-large' })
    await expect(run(t, 'project_read_file', { path: '../../etc/passwd' }, 'p1')).rejects.toMatchObject({ code: 'outside-project' })
    await expect(run(t, 'project_read_file', { path: 'escape/x' }, 'p1')).rejects.toMatchObject({ code: 'outside-project' })
    await expect(run(t, 'project_read_file', { path: '/etc/passwd' }, 'p1')).rejects.toMatchObject({ code: 'outside-project' })

    expect(await run(t, 'project_write_file', { path: 'new/dir/b.ts', content: 'hello', reason: 'r' }, 'p1')).toBe(`Wrote ${join('new', 'dir', 'b.ts')} (5 characters)`)
    expect(await readFile(join(root, 'new', 'dir', 'b.ts'), 'utf8')).toBe('hello')
    expect(await run(t, 'project_write_file', { path: '.', content: '', reason: 'r' }, 'p1').catch((e) => e.code)).toBeDefined()
    // A dangling link in the project never writes outside it (BE-SEC-02).
    const elsewhere = await tempDir()
    await symlink(join(elsewhere, 'autostart.desktop'), join(root, 'setup.md'))
    await expect(run(t, 'project_write_file', { path: 'setup.md', content: 'x', reason: 'r' }, 'p1')).rejects.toMatchObject({ code: 'outside-project' })
    expect(await readdir(elsewhere)).toEqual([])
    expect(summary(t, 'project_write_file', { path: 'a', content: 'xyz' })).toBe('Write 3 characters to a')
    expect(summary(t, 'project_read_file', { path: 'a' })).toBe('Read the file a')
    expect(summary(t, 'project_list_files', {})).toBe('List the files in the project root')
    expect(summary(t, 'project_list_files', { dir: 'src' })).toBe('List the files in src')
    expect(summary(t, 'project_context', {})).toBe('Read the structure of project (current)')
    expect(summary(t, 'projects_list', {})).toBe('List the registered projects')
    expect(await confine(root, '.')).toBe(await (await import('node:fs/promises')).realpath(root))
  })

  it('shell_run runs in the project, reports exit codes, honours timeouts', async () => {
    const root = await tempDir()
    const t = builtinTools(toolDeps({ projects: { list: () => [proj({ path: root })] } }))
    const out = await run(t, 'shell_run', { command: 'echo hi && pwd', reason: 'r' }, 'p1')
    expect(out).toContain('exit code: 0')
    expect(out).toContain('hi')
    expect(await run(t, 'shell_run', { command: 'echo err >&2; exit 3', reason: 'r' }, 'p1')).toMatch(/exit code: 3[\s\S]*err/)
    expect(await runShell('sleep 2', root, signal, 50)).toContain('killed')
    expect(await runShell('true', join(root, 'missing'), signal)).toContain('ENOENT')
    expect(summary(t, 'shell_run', { command: 'ls' })).toBe('Run: ls')
    const savedShell = process.env.SHELL
    delete process.env.SHELL
    try {
      expect(await runShell('echo sh', root, signal)).toContain('sh')
    } finally {
      process.env.SHELL = savedShell
    }
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      expect(await runShell('Get-Date', root, signal)).toContain('exit code')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform })
    }
  })

  it('system_snapshot summarizes telemetry', async () => {
    const deps = toolDeps()
    const t = builtinTools(deps)
    const out = await run(t, 'system_snapshot', {})
    expect(out).toContain('CPU 12% (2 cores)')
    expect(out).toContain('Battery 80% (charging)')
    expect(out).toContain('Top processes: node (cpu 3.2%, 120 MB)')
    vi.mocked(deps.system.snapshot).mockResolvedValueOnce({
      cpu: { total: 1, cores: [] },
      mem: { usedPct: 1, usedGb: 1, totalGb: 1 },
      disk: { usedPct: 1, mount: '/' },
      net: { rxMbps: 0, txMbps: 0 },
      battery: { pct: 0, charging: false, hasBattery: false },
      uptimeSec: 1,
      processes: [],
      ts: 0
    })
    const bare = await run(t, 'system_snapshot', {})
    expect(bare).toContain('No battery')
    expect(bare).not.toContain('Top processes')
    vi.mocked(deps.system.snapshot).mockResolvedValueOnce({
      ...(await deps.system.snapshot()),
      battery: { pct: 50, charging: false, hasBattery: true }
    })
    expect(await run(t, 'system_snapshot', {})).toContain('Battery 50%\n')
    expect(summary(t, 'system_snapshot', {})).toBe('Read the current system status')
  })

  it('formats contexts, truncates long output', () => {
    const minimal = formatContext(proj(), ctxOf({ languages: [], frameworks: [], dependencies: [], configFiles: [], todos: [], tree: [], readme: undefined, packageJson: undefined }))
    expect(minimal.split('\n')).toHaveLength(2)
    expect(formatContext(proj(), ctxOf({ readme: { sections: ['S'] } }))).toContain('README: S')
    expect(truncate('abcdef', 3)).toBe('abc\n… [truncated 3 characters]')
    expect(truncate('ab', 3)).toBe('ab')
  })
})

describe('ToolRegistry', () => {
  it('exposes info, model schemas and validation', () => {
    const reg = new ToolRegistry(builtinTools(toolDeps()))
    expect(reg.info().find((t) => t.name === 'shell_run')).toMatchObject({ risk: 'execute', title: 'Run command' })
    const [search] = reg.forModel(['memory_search', 'nope'])
    expect(search).toMatchObject({ name: 'memory_search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } })
    expect(search.inputSchema).not.toHaveProperty('$schema')
    const custom = new ToolRegistry([{ ...builtinTools(toolDeps())[0], inputSchema: { type: 'object', $schema: 'x', custom: true } }])
    expect(custom.forModel(['memory_search'])[0].inputSchema).toEqual({ type: 'object', custom: true })
    const tool = reg.get('memory_search')!
    expect(reg.parse(tool, { query: 'x' })).toEqual({ ok: true, data: { query: 'x' } })
    expect(reg.parse(tool, { query: 5 })).toMatchObject({ ok: false, message: expect.stringContaining('query') })
    expect(reg.parse(reg.get('projects_list')!, 'x')).toMatchObject({ ok: false, message: expect.stringContaining('input') })
    expect(reg.get('nope')).toBeUndefined()
  })
})

describe('agents', () => {
  it('are data with allowlists that exist; unknown ids fall back to the assistant', () => {
    const tools = new Set([...builtinTools(toolDeps()), ...browserTools({} as never), ...terminalTools({} as never)].map((t) => t.name))
    for (const a of AGENTS) for (const name of a.tools) expect(tools.has(name)).toBe(true)
    expect(agentById('coding').name).toBe('Coding')
    expect(agentById('nope').id).toBe('assistant')
    expect(agentById(undefined).id).toBe('assistant')
    expect(agentInfo(AGENTS[2])).toEqual({ id: 'research', name: 'Research', description: AGENTS[2].description, tools: AGENTS[2].tools, web: true })
  })
})

// --- permissions -------------------------------------------------------------------

describe('PermissionService', () => {
  const setup = async (timeoutMs?: number) => {
    const dir = await tempDir()
    const events: MindeckEvent[] = []
    const bus = new EventBus({ sink: { persist: () => {} } })
    bus.subscribe('*', (e) => events.push(e))
    const requests: unknown[] = []
    const resolved: unknown[] = []
    const perms = new PermissionService({
      file: join(dir, 'grants.json'),
      events: bus,
      onRequest: (r) => requests.push(r),
      onResolved: (r) => resolved.push(r),
      timeoutMs
    })
    return { perms, events, requests, resolved, file: join(dir, 'grants.json') }
  }
  const input = (over: Record<string, unknown> = {}) =>
    ({
      runId: 'r',
      conversationId: 'c',
      agentId: 'assistant',
      agentName: 'Assistant',
      toolName: 'memory_create_note',
      toolTitle: 'Create note',
      risk: 'write',
      summary: 'Create',
      reason: 'because',
      input: {},
      allowAlways: true,
      ...over
    }) as never

  it('asks, records decisions, persists "always" grants per agent + tool', async () => {
    const { perms, events, requests, resolved, file } = await setup()
    const a = perms.ask(input(), new AbortController().signal)
    expect(perms.list()).toHaveLength(1)
    expect(requests).toHaveLength(1)
    await perms.respond(a.id, 'once', { deviceId: 'dev1', shells: true })
    expect(await a.decision).toBe('once')
    expect(resolved).toEqual([{ id: a.id, decision: 'once' }])
    expect(events.map((e) => e.type)).toEqual(['permission.requested', 'permission.granted'])
    expect(events[1].actor).toEqual({ kind: 'user', id: 'dev1' })

    const b = perms.ask(input(), new AbortController().signal)
    await perms.respond(b.id, 'always')
    expect(await b.decision).toBe('always')
    expect(await perms.isGranted('assistant', 'memory_create_note')).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8')).grants).toHaveLength(1)
    const c = perms.ask(input(), new AbortController().signal)
    await perms.respond(c.id, 'always') // already granted: no duplicate
    expect(await perms.grants()).toHaveLength(1)

    const d = perms.ask(input({ allowAlways: false, toolName: 'shell_run', risk: 'execute' }), new AbortController().signal)
    await perms.respond(d.id, 'always') // not offered → once
    expect(await d.decision).toBe('once')
    expect(await perms.isGranted('assistant', 'shell_run')).toBe(false)

    const e = perms.ask(input(), new AbortController().signal)
    await perms.respond(e.id, 'deny')
    expect(await e.decision).toBe('deny')
    expect(events.at(-1)).toMatchObject({ type: 'permission.denied', actor: { kind: 'user' } })
    await expect(perms.respond(e.id, 'once')).rejects.toMatchObject({ code: 'not-pending' })

    await perms.revoke('assistant', 'memory_create_note')
    expect(await perms.grants()).toEqual([])
    // what the user allowed which agent to do is theirs alone
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('denies on timeout and on abort (also when already aborted)', async () => {
    const { perms } = await setup(20)
    expect(await perms.ask(input(), new AbortController().signal).decision).toBe('deny')
    const ac = new AbortController()
    const p = perms.ask(input(), ac.signal)
    ac.abort()
    expect(await p.decision).toBe('deny')
    const done = new AbortController()
    done.abort()
    expect(await perms.ask(input(), done.signal).decision).toBe('deny')
    expect(perms.list()).toEqual([])
  })

  it('treats a corrupt grants file as empty', async () => {
    const { perms, file } = await setup()
    await writeFile(file, 'nope')
    expect(await perms.grants()).toEqual([])
    const { perms: p2, file: f2 } = await setup()
    await writeFile(f2, '{"grants":5}')
    expect(await p2.grants()).toEqual([])
    const { perms: p3, file: f3 } = await setup()
    await writeFile(f3, JSON.stringify({ grants: [{ agentId: 'a', toolName: 't', createdAt: '' }] }))
    expect(await p3.isGranted('a', 't')).toBe(true)
  })
})

// --- stores -------------------------------------------------------------------------

const conv = (id: string, over: Partial<StoredConversation> = {}): StoredConversation => ({
  id,
  title: id,
  agentId: 'assistant',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  messages: [],
  transcript: [],
  ...over
})

describe('ConversationStore', () => {
  it('saves, lists newest first, loads, deletes; rejects odd ids; skips junk files', async () => {
    const dir = await tempDir()
    const store = new ConversationStore(dir)
    expect(await store.list()).toEqual([])
    await store.save(conv('a'))
    await store.save(conv('b', { updatedAt: '2026-10-02T00:00:00.000Z', projectId: 'p' }))
    expect((await store.list()).map((c) => c.id)).toEqual(['b', 'a'])
    expect(await store.get('b')).toMatchObject({ projectId: 'p', transcript: [] })
    // Whose project, from the index (what paired devices may see is decided by it).
    expect([await store.projectOf('b'), await store.projectOf('a'), await store.projectOf('missing')]).toEqual(['p', undefined, undefined])
    expect(await store.get('../etc')).toBeNull()
    expect(await store.get('missing')).toBeNull()
    await expect(store.save(conv('../x'))).rejects.toMatchObject({ code: 'bad-id' })

    await writeFile(join(dir, 'conversations', 'junk.json'), '{bad')
    await writeFile(join(dir, 'conversations', 'notes.txt'), '')
    const fresh = new ConversationStore(dir)
    expect((await fresh.list()).map((c) => c.id)).toEqual(['b', 'a'])
    await fresh.delete('a')
    await fresh.delete('../x')
    expect((await fresh.list()).map((c) => c.id)).toEqual(['b'])
    expect((await readdir(join(dir, 'conversations'))).sort()).toEqual(['b.json', 'junk.json', 'notes.txt'])
    expect((await stat(join(dir, 'conversations', 'b.json'))).mode & 0o777).toBe(0o600)
  })
})

describe('EventLog', () => {
  const ev = (id: string, conversationId?: string): MindeckEvent => ({
    id,
    type: 'tool.completed',
    ts: new Date(Date.UTC(2026, 9, 1, 0, 0, Number(id.slice(1)))).toISOString(),
    actor: { kind: 'agent', id: 'assistant' },
    subject: { kind: 'agent_run', id: 'r' },
    projectId: 'p',
    conversationId,
    payload: { n: id }
  })

  it('keeps a bounded ring; without a file it is memory only', async () => {
    const log = new EventLog(undefined, 3)
    await log.load()
    for (const id of ['e1', 'e2', 'e3', 'e4']) log.persist(ev(id, id === 'e4' ? 'c' : undefined), 'activity')
    await log.flush()
    expect((await log.recent()).map((e) => e.id)).toEqual(['e4', 'e3', 'e2'])
    expect((await log.recent({ limit: 1 })).map((e) => e.id)).toEqual(['e4'])
    expect((await log.recent({ conversationId: 'c' })).map((e) => e.id)).toEqual(['e4'])
    expect((await log.recent({ limit: 0 })).length).toBe(1)
  })

  it('a file in the data folder keeps the history across restarts; it is compacted, damaged lines are skipped', async () => {
    const file = join(await tempDir(), 'events.jsonl')
    const log = new EventLog(file, 2)
    await log.load() // no file yet
    for (const id of ['e1', 'e2', 'e3', 'e4']) log.persist(ev(id), 'activity')
    await log.flush()
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(4)
    log.persist(ev('e5', 'c'), 'audit') // past twice the capacity: rewritten with the newest
    await log.flush()
    expect((await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l).id)).toEqual(['e4', 'e5'])

    await writeFile(file, `${await readFile(file, 'utf8')}not json\n\n`)
    const again = new EventLog(file, 2)
    await again.load()
    expect((await again.recent()).map((e) => e.id)).toEqual(['e5', 'e4'])
    expect(await again.recent({ conversationId: 'c' })).toEqual([ev('e5', 'c')])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = new EventLog(join(file, 'not-a-folder', 'events.jsonl'))
    broken.persist(ev('e6'), 'activity')
    await broken.flush()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not store tool.completed'))
    expect((await broken.recent()).map((e) => e.id)).toEqual(['e6']) // memory still has it
    warn.mockRestore()
  })
})

describe('RunStore', () => {
  const runOf = (id: string, over: Partial<AgentRun> = {}): AgentRun => ({
    id,
    agentId: 'assistant',
    conversationId: 'c',
    goal: 'g',
    model: 'claude-opus-5-5',
    status: 'running',
    startedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, Number(id.slice(1)))).toISOString(),
    iterations: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...over
  })

  it('keeps recent runs in memory; without a file nothing is written', async () => {
    const mem = new RunStore(undefined, 2)
    await mem.load()
    await mem.save(runOf('r1'))
    await mem.save(runOf('r2'))
    await mem.save(runOf('r1', { status: 'completed' })) // update moves to newest
    await mem.save(runOf('r3'))
    expect((await mem.list()).map((r) => `${r.id}:${r.status}`)).toEqual(['r3:running', 'r1:completed'])
    expect(await mem.list(0)).toHaveLength(1)
  })

  it('a file in the data folder keeps them across restarts; damaged or unwritable files never break a run', async () => {
    const dir = await tempDir()
    const file = join(dir, 'runs.json')
    const store = new RunStore(file)
    await store.load() // no file yet
    const failed = runOf('r1', { status: 'failed', endedAt: '2026-10-01T00:05:00.000Z', error: 'boom', iterations: 2, inputTokens: 5, outputTokens: 6, projectId: 'p' })
    await store.save(runOf('r1', { projectId: 'p' }))
    await store.save(failed)
    await store.save(runOf('r2'))
    const again = new RunStore(file)
    await again.load()
    expect(await again.list()).toEqual([runOf('r2'), failed])

    await writeFile(file, '{"version":1}')
    const empty = new RunStore(file)
    await empty.load()
    expect(await empty.list()).toEqual([])
    await writeFile(file, 'not json')
    await empty.load()
    expect(await empty.list()).toEqual([])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = new RunStore(join(file, 'not-a-folder', 'runs.json'))
    await broken.save(runOf('r9'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not store run r9'))
    expect((await broken.list()).map((r) => r.id)).toEqual(['r9'])
    warn.mockRestore()
  })
})

// --- context engine ---------------------------------------------------------------

describe('ContextBuilder', () => {
  const vaultStatus = (exists: boolean) => ({ root: '/v', defaultRoot: '/v', name: 'Mindeck', isDefault: true, exists, noteCount: 4, graphStyle: { mode: 'colorful' as const, color: 'cyan' as const }, dailyNotes: { folder: 'Daily', template: '' } })
  const builder = (over: Partial<ConstructorParameters<typeof ContextBuilder>[0]> = {}) =>
    new ContextBuilder({
      user: async () => ({ name: 'Ada' }),
      projects: () => [
        proj({ git: { isRepo: true, branch: 'main', dirty: true, lastCommit: { hash: 'h', subject: 'init', author: 'a', date: '' } }, stack: { languages: ['TS'], frameworks: [], hasReadme: false } }),
        proj({ id: 'p2', name: 'plain' })
      ],
      projectContext: async (id) => (id === 'p1' ? ctxOf() : null),
      vaultStatus: async () => vaultStatus(true),
      search: async (q) => (q === 'nothing' ? [] : [{ path: 'A.md', title: 'A', snippet: 'about x' }]),
      now: () => new Date('2026-10-02T08:00:00.000Z'),
      ...over
    })

  it('assembles time, user, project and matching notes in a <context> block', async () => {
    const text = await builder().build('x', 'p1')
    expect(text.startsWith('<context>\nNow: 2026-10-02T08:00:00.000Z')).toBe(true)
    expect(text).toContain('User: Ada')
    expect(text).toContain('Active project: demo (id p1) at /nope — git main, uncommitted changes, last commit "init"; stack: TS')
    expect(text).toContain('Indexed 3 files; 1 TODO markers; README "Demo"')
    expect(text).toContain('Scripts: dev, test')
    expect(text).toContain('- A.md: about x')
    expect(text.endsWith('</context>')).toBe(true)

    const other = await builder().build('nothing', 'p2')
    expect(other).toContain('— no git')
    expect(other).toContain('Not indexed yet')
    expect(other).toContain('no note matches this message')
    expect(await builder().build('x', 'unknown')).not.toContain('Active project')
    expect(await builder({ projects: () => [proj({ git: { isRepo: true } })] }).build('x', 'p1')).toContain('detached')
    expect(await builder({ projectContext: async () => ctxOf({ readme: undefined, packageJson: undefined }) }).build('x', 'p1')).not.toContain('Scripts')
  })

  it('degrades gracefully and respects the budget', async () => {
    const text = await builder({
      user: async () => Promise.reject(new Error('x')),
      vaultStatus: async () => Promise.reject(new Error('x')),
      projectContext: async () => Promise.reject(new Error('x'))
    }).build('x', 'p1')
    expect(text).not.toContain('User:')
    expect(text).toContain('Memory vault: not set up yet.')
    expect(text).toContain('Not indexed yet')
    expect(await builder({ vaultStatus: async () => vaultStatus(false) }).build('x')).toContain('not set up yet')
    expect(await builder({ search: async () => Promise.reject(new Error('x')) }).build('x')).toContain('no note matches')
    const huge = await builder({ search: async () => Array.from({ length: 6 }, (_, i) => ({ path: `${i}.md`, title: '', snippet: 'y'.repeat(5000) })) }).build('x')
    expect(huge).toContain('… [context truncated]')
    expect(await new ContextBuilder({ ...builder()['deps'], now: undefined }).build('x')).toContain('Now: ')
  })
})

// keep chmod imported for platforms where symlinks need it
void chmod
export type { LlmProvider, LlmTurn }
