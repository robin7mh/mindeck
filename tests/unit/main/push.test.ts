import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir, tick } from './helpers'
import { PUSH_INTERVAL_MS, PushService } from '../../../electron/main/services/cloud/PushService'
import { SettingsService } from '../../../electron/main/services/settings/SettingsService'

async function setup(opts: { token?: string | null; focused?: boolean; status?: number; throws?: boolean } = {}) {
  const settings = new SettingsService(join(await tempDir(), 'settings.json'))
  await settings.init()
  const state = { now: 1_000_000, focused: opts.focused ?? false, token: opts.token === undefined ? 'sess' : opts.token }
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    if (opts.throws) throw new Error('offline')
    return new Response(null, { status: opts.status ?? 202 })
  })
  const push = new PushService({
    baseUrl: 'https://cloud.test',
    token: async () => state.token,
    settings,
    focused: () => state.focused,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => state.now
  })
  const sent = () => fetch.mock.calls.map(([url, init]) => ({ url, headers: init.headers, body: JSON.parse(String(init.body)) }))
  return { push, fetch, settings, state, sent }
}

const notice = { kind: 'approval' as const, title: 'Claude Code · Fix login', body: 'Run command · Waiting for your approval · Demo', sessionId: 's1' }

describe('PushService', () => {
  it('posts to Mindeck Cloud with the core\'s session — once per session in 30 s', async () => {
    const t = await setup()
    t.push.send(notice)
    await tick()
    expect(t.sent()).toEqual([
      { url: 'https://cloud.test/v1/push/notify', headers: { 'content-type': 'application/json', authorization: 'Bearer sess' }, body: notice }
    ])
    t.push.send({ ...notice, kind: 'agent_done' }) // the same session right after: dropped
    await tick()
    expect(t.fetch).toHaveBeenCalledTimes(1)
    t.push.send({ ...notice, sessionId: 's2' }) // another session: goes out
    await tick()
    expect(t.fetch).toHaveBeenCalledTimes(2)
    t.state.now += PUSH_INTERVAL_MS
    t.push.send(notice)
    await tick()
    expect(t.fetch).toHaveBeenCalledTimes(3)
  })

  it('without a session id, the kind is rate-limited; long texts are cut', async () => {
    const t = await setup()
    t.push.send({ kind: 'agent_error', title: 'T'.repeat(200), body: 'B'.repeat(300) })
    t.push.send({ kind: 'agent_error', title: 'again', body: 'x' })
    await tick()
    const [only] = t.sent()
    expect(t.fetch).toHaveBeenCalledTimes(1)
    expect(only.body).toEqual({ kind: 'agent_error', title: `${'T'.repeat(119)}…`, body: `${'B'.repeat(239)}…` })
  })

  it('stays quiet while Mindeck is in front, when switched off, or signed out', async () => {
    const t = await setup({ focused: true })
    t.push.send(notice)
    await tick()
    t.state.focused = false
    expect(await t.push.configure(false)).toEqual({ enabled: false, signedIn: true })
    t.push.send(notice)
    await tick()
    expect(t.fetch).not.toHaveBeenCalled()
    expect(t.settings.get().agents).toEqual({ pushToPhone: false })
    expect(await t.push.configure(true)).toEqual({ enabled: true, signedIn: true })

    const out = await setup({ token: null })
    expect(await out.push.settings()).toEqual({ enabled: true, signedIn: false }) // on by default
    out.push.send(notice)
    await tick()
    expect(out.fetch).not.toHaveBeenCalled()
  })

  it('failures are logged, never thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refused = await setup({ status: 500 })
    refused.push.send(notice)
    await tick()
    expect(warn).toHaveBeenCalledWith('[push] not sent:', 'Mindeck Cloud answered 500')
    const offline = await setup({ throws: true })
    offline.push.send(notice)
    await tick()
    expect(warn).toHaveBeenLastCalledWith('[push] not sent:', 'offline')
  })

  it('uses the global fetch and clock by default', async () => {
    const settings = new SettingsService(join(await tempDir(), 's.json'))
    await settings.init()
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    new PushService({ baseUrl: 'https://c', token: async () => 't', settings, focused: () => false }).send(notice)
    await tick()
    expect(fetch).toHaveBeenCalledWith('https://c/v1/push/notify', expect.objectContaining({ method: 'POST' }))
  })
})
