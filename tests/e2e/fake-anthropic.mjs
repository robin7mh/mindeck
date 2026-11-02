// A tiny stand-in for the Anthropic Messages API (SSE streaming + models),
// so the assistant can be driven end to end without a key or network.
// The Mindeck core points the official SDK at it via ANTHROPIC_BASE_URL.
//
//   node tests/e2e/fake-anthropic.mjs 7799     # manual runs
//
// Script: "note"/"merk" in the message → a memory_create_note tool call
// (needs approval), then a confirmation; anything else → a Markdown answer.
// `hold()` keeps the next answers back until the returned function releases
// them (`waiting` counts the requests held) — for what happens meanwhile.
import { createServer } from 'node:http'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === 'user') return messages[i]
  return { content: [] }
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  return (async () => {
    for (const [event, data] of events) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      await sleep(15)
    }
    res.end()
  })()
}

function textEvents(index, text) {
  const chunks = text.match(/[\s\S]{1,12}/g) ?? []
  return [
    ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }],
    ...chunks.map((c) => ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: c } }]),
    ['content_block_stop', { type: 'content_block_stop', index }]
  ]
}

function message(model, blocks, stopReason) {
  return [
    ['message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1 } } }],
    ...blocks,
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42 } }],
    ['message_stop', { type: 'message_stop' }]
  ]
}

export function startFakeAnthropic(port = 0) {
  const requests = []
  let gate = null
  let waiting = 0
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    if (gate && req.method === 'POST') {
      waiting += 1
      await gate
      waiting -= 1
    }
    const body = raw ? JSON.parse(raw) : {}
    requests.push({ url: req.url, body })
    if (req.method === 'GET' && req.url.startsWith('/v1/models/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: req.url.split('/').pop(), type: 'model', display_name: 'Fake' }))
    }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'nope' } }))
    }
    const user = lastUser(body.messages ?? [])
    const blocks = Array.isArray(user.content) ? user.content : [{ type: 'text', text: String(user.content) }]
    const result = blocks.find((b) => b.type === 'tool_result')
    const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text)
    const said = texts[texts.length - 1] ?? ''
    const model = body.model ?? 'claude-opus-5-5'

    if (result) {
      const ok = !result.is_error
      return sse(res, message(model, textEvents(0, ok ? 'Saved — the note **E2E Plan** is in your vault.' : `That did not work: ${result.content}`), 'end_turn'))
    }
    if (/note|merk/i.test(said)) {
      const input = { title: 'E2E Plan', body: '- step one\n- step two', reason: 'You asked me to remember this plan' }
      return sse(
        res,
        message(model, [
          ...textEvents(0, 'I will save that as a note. '),
          ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: 'memory_create_note', input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
          ['content_block_stop', { type: 'content_block_stop', index: 1 }]
        ], 'tool_use')
      )
    }
    const context = (texts[0] ?? '').includes('<context>') ? 'I can see your Mindeck context.' : 'No context was attached.'
    return sse(res, message(model, textEvents(0, `## Hello from the assistant\n\nYou said: *${said.slice(0, 80)}*.\n\n- ${context}\n- Streaming works.`), 'end_turn'))
  })
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        hold: () => {
          let release
          gate = new Promise((r) => (release = r))
          return () => {
            gate = null
            release()
          }
        },
        waiting: () => waiting,
        close: () => new Promise((r) => server.close(() => r()))
      })
    )
  )
}

if (process.argv[1]?.endsWith('fake-anthropic.mjs')) {
  startFakeAnthropic(Number(process.argv[2] ?? 7799)).then((f) => console.log(`fake Anthropic API on ${f.url}`))
}
