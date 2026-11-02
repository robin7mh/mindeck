import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_SETTINGS, type AiSettings, type InlineDelta } from '@shared/types/ai'
import { InlineService, tidyCompletion, unfence } from '../../../electron/main/services/ai/InlineService'
import { aiError, type LlmProvider, type LlmRequest, type StopReason } from '../../../electron/main/services/ai/llm'
import type { AiService } from '../../../electron/main/services/ai/AiService'

/** A provider that answers with the given chunks (streamed) or waits until aborted. */
function harness(settings: Partial<AiSettings> & { ownKey?: boolean; ready?: Promise<unknown> } = {}, answer: (req: LlmRequest) => { chunks: string[]; stop?: StopReason } | 'hang' | Error = () => ({ chunks: ['x'] })) {
  const requests: LlmRequest[] = []
  const deltas: InlineDelta[] = []
  const provider: LlmProvider = {
    stream: async (req, onText) => {
      requests.push(req)
      const a = answer(req)
      if (a instanceof Error) throw a
      if (a === 'hang') {
        await new Promise((_, reject) => req.signal!.addEventListener('abort', () => reject(aiError('cancelled', 'Cancelled'))))
      }
      const { chunks, stop = 'end_turn' } = a as { chunks: string[]; stop?: StopReason }
      chunks.forEach(onText)
      return { message: { role: 'assistant', blocks: [{ type: 'opaque', data: {} }, { type: 'text', text: chunks.join('') }] }, stopReason: stop, model: req.model, usage: { inputTokens: 1, outputTokens: 1 }, serverTools: [] }
    }
  }
  const all = { ...DEFAULT_AI_SETTINGS, inline: true, ...settings }
  const ai = {
    settings: () => all,
    provider: async () => (await settings.ready, provider),
    ownKey: async () => settings.ownKey ?? true,
    model: async () => ((settings.ownKey ?? true) ? all.model : all.cloudModel)
  } as unknown as AiService
  return { service: new InlineService({ ai, publish: (d) => deltas.push(d) }), requests, deltas }
}

const complete = (over: Record<string, string> = {}) => ({ requestId: 'r1', path: 'src/a.ts', language: 'typescript', prefix: 'const sum = ', suffix: '\n', ...over })
const edit = { requestId: 'e1', path: 'a.js', language: 'javascript', before: 'top\n', selection: 'var x = 1', after: '\nend', instruction: 'use const' }

describe('suggestions and edits as the editor needs them', () => {
  it('unfences a reply wrapped in Markdown, leaves other text alone', () => {
    expect(unfence('```ts\nconst a = 1\n```')).toBe('const a = 1')
    expect(unfence('  ```\nx\n```  ')).toBe('x')
    expect(unfence('plain ``` text')).toBe('plain ``` text')
  })

  it('drops what the line already has before and after the cursor', () => {
    expect(tidyCompletion('a + b', 'const sum = ', ';')).toBe('a + b')
    // The model repeated the start of the line.
    expect(tidyCompletion('const sum = a + b', 'x\n  const sum = ', '')).toBe('a + b')
    expect(tidyCompletion('  const sum = a + b', 'const sum = ', '')).toBe('a + b')
    // …and what follows the cursor on this line.
    expect(tidyCompletion('a, b)', 'mul(', ')\nnext')).toBe('a, b')
    expect(tidyCompletion('```js\nreturn 1\n```', '  ', '')).toBe('return 1')
    expect(tidyCompletion('   ', '', '')).toBe('')
  })
})

describe('InlineService', () => {
  it('suggests with the inline model at low effort, the file around the cursor', async () => {
    const h = harness({ inlineModel: 'claude-haiku-5-5' }, () => ({ chunks: ['a + ', 'b'] }))
    expect(await h.service.complete(complete())).toBe('a + b')
    expect(h.requests[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low', maxTokens: 4096, tools: [], webTools: false })
    expect(h.requests[0].system).toContain('<CURSOR/>')
    expect(h.requests[0].messages[0].blocks[0]).toEqual({ type: 'text', text: '<file path="src/a.ts" language="typescript">\nconst sum = <CURSOR/>\n\n</file>' })
    // Suggestions only stream to the caller, never as events.
    expect(h.deltas).toEqual([])
  })

  it('nothing when suggestions are off; a newer suggestion stops the one still pending; cancel by id', async () => {
    const off = harness({ inline: false })
    expect(await off.service.complete(complete())).toBe('')
    expect(off.requests).toEqual([])
    // Through Mindeck Cloud (no key of one's own): never on the account's credit.
    const cloud = harness({ ownKey: false })
    expect(await cloud.service.complete(complete())).toBe('')
    expect(cloud.requests).toEqual([])

    const h = harness({}, (req) => ((req.messages[0].blocks[0] as { text: string }).text.includes('first') ? 'hang' : { chunks: ['2'] }))
    const first = h.service.complete(complete({ requestId: 'a', prefix: 'first ' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(await h.service.complete(complete({ requestId: 'b' }))).toBe('2')
    expect(await first).toBe('')
    const third = h.service.complete(complete({ requestId: 'c', prefix: 'first ' }))
    await new Promise((r) => setTimeout(r, 0))
    h.service.cancel('c')
    h.service.cancel('unknown')
    expect(await third).toBe('')
  })

  it('a failed suggestion says why (no key, rate limit)', async () => {
    const h = harness({}, () => aiError('rate-limited', 'slow down'))
    await expect(h.service.complete(complete())).rejects.toMatchObject({ code: 'rate-limited' })
  })

  it('edits with the assistant’s model: the file with the selection marked, the instruction, text as it comes', async () => {
    const h = harness({ model: 'claude-sonnet-5-5' }, () => ({ chunks: ['```js\n', 'const x = 1', '\n```'] }))
    expect(await h.service.edit(edit)).toBe('const x = 1')
    expect(h.requests[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium', maxTokens: 32_000, kind: 'edit' })
    expect((h.requests[0].messages[0].blocks[0] as { text: string }).text).toBe(
      '<file path="a.js" language="javascript">\ntop\n<SELECTION>var x = 1</SELECTION>\nend\n</file>\n\n<instruction>\nuse const\n</instruction>'
    )
    expect(h.deltas.map((d) => d.text)).toEqual(['```js\n', 'const x = 1', '\n```'])
    expect(h.deltas.every((d) => d.requestId === 'e1')).toBe(true)
    expect(h.deltas.some((d) => 'device' in d)).toBe(false) // the desktop's: for no paired device
  })

  it('an edit a paired device asked for is addressed to that device only', async () => {
    const h = harness({}, () => ({ chunks: ['a', 'b'] }))
    await h.service.edit(edit, { transport: 'remote', deviceId: 'phone' })
    await h.service.edit(edit, { transport: 'remote' })
    await h.service.edit(edit, { transport: 'ipc' })
    expect(h.deltas.map((d) => d.device)).toEqual(['phone', 'phone', '', '', undefined, undefined])
  })

  it('through Mindeck Cloud an edit uses the cloud’s model', async () => {
    const h = harness({ ownKey: false, cloudModel: 'claude-haiku-5-5' }, () => ({ chunks: ['x'] }))
    await h.service.edit(edit)
    expect(h.requests[0]).toMatchObject({ model: 'claude-haiku-5-5', kind: 'edit' })
  })

  it('a declined or cancelled edit fails', async () => {
    const refused = harness({}, () => ({ chunks: [''], stop: 'refusal' }))
    await expect(refused.service.edit(edit)).rejects.toMatchObject({ code: 'refused' })
    const h = harness({}, () => 'hang')
    const pending = h.service.edit(edit)
    await new Promise((r) => setTimeout(r, 0))
    h.service.cancel('e1')
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('a cancel or a newer suggestion while the provider is still resolving stops the request before it is sent', async () => {
    let release!: () => void
    const h = harness({ ready: new Promise<void>((r) => (release = r)) })
    const pending = h.service.edit(edit)
    const first = h.service.complete(complete({ requestId: 'a' }))
    await new Promise((r) => setTimeout(r, 0))
    h.service.cancel('e1')
    const second = h.service.complete(complete({ requestId: 'b' })) // overtakes 'a'
    await new Promise((r) => setTimeout(r, 0))
    release()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(await first).toBe('')
    expect(await second).toBe('x')
    expect(h.requests).toHaveLength(1) // only the newest suggestion reached the model
  })
})
