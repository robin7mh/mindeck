import { z } from 'zod'
import type { AgentAction, BrowserTab } from '@shared/types/browser'
import type { AutomationTarget, ConsoleEntry } from '../../browser/types'
import { KEY_NAMES, keyEvents, quadCenter, renderSnapshot, type AxNode, type SnapshotRef } from '../../browser/snapshot'
import type { ToolContent, ToolContext, ToolDefinition } from './types'
import { truncate } from './builtin'

/** Reading tools: they only ever see tabs shared with agents, so they run without asking. */
export const BROWSER_READ_TOOLS = ['browser_tabs', 'browser_snapshot', 'browser_read', 'browser_screenshot', 'browser_console']
/** Every browser tool; opening, navigating, clicking and typing ask the user first. */
export const BROWSER_TOOLS = [...BROWSER_READ_TOOLS, 'browser_open', 'browser_navigate', 'browser_click', 'browser_type', 'browser_press']

/** What the tools need from the browser (BrowserService). */
export interface BrowserAgentApi {
  agentTabs(): BrowserTab[]
  agentTab(id?: string): BrowserTab
  /** The tabs on screen: the one the user works in, then the one beside it in a split view. */
  onScreen(): string[]
  agentOpen(url: string, agent: string): Promise<BrowserTab>
  agentNavigate(id: string, to: { url?: string; action?: 'back' | 'forward' | 'reload' }, agent: string): Promise<BrowserTab>
  automation(id: string): Promise<AutomationTarget>
  noteAgent(id: string, name: string, action: AgentAction, detail?: string): void
  consoleOf(id: string): ConsoleEntry[]
  waitForLoad(id: string, timeoutMs?: number): Promise<void>
}

const reason = z.string().min(1).max(500).describe('One sentence for the user: why this action is needed')
const tab = z.string().max(100).optional().describe('Tab id from browser_tabs (default: the tab the user works in — in a split view the focused side, then the other — else the one you used last)')
const ref = z.string().regex(/^e\d+$/).describe('Element ref from the latest browser_snapshot, e.g. "e12"')

/** Select an input's or editable's content, so typed text replaces it. */
const SELECT_ALL = `function () {
  if (typeof this.select === 'function') { this.select(); return }
  const range = document.createRange(); range.selectNodeContents(this)
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range)
}`

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Page text can't close (or open) the wrapper it travels in: such a tag's `<` reaches the model as `&lt;`. */
export function inert(text: string): string {
  return text.replace(/<\s*(\/?)\s*(untrusted_web_content)/gi, '&lt;$1$2')
}

/** Web content goes to the model as data, never as instructions (architecture §9). */
function untrusted(t: BrowserTab, body: string): string {
  return `<untrusted_web_content origin="${inert(t.url).replace(/"/g, '%22')}">\n${inert(body)}\n</untrusted_web_content>`
}

const who = (ctx: ToolContext) => ctx.agent ?? 'Agent'

/** DOM nodes of password fields: never shown, never typed into. */
async function secretNodes(target: AutomationTarget): Promise<Set<number>> {
  const { root } = await target.cdp<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
  const { nodeIds } = await target.cdp<{ nodeIds: number[] }>('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=password]' })
  const ids = new Set<number>()
  for (const nodeId of nodeIds) {
    const { node } = await target.cdp<{ node: { backendNodeId: number } }>('DOM.describeNode', { nodeId })
    ids.add(node.backendNodeId)
  }
  return ids
}

function formatConsole(entries: ConsoleEntry[]): string {
  return entries.map((e) => `[${e.level}] ${e.message}${e.source ? ` (${e.source}${e.line ? `:${e.line}` : ''})` : ''}`).join('\n')
}

/**
 * The browser for agents (architecture §12.9) — through the ToolRegistry for
 * the assistant and through Mindeck's MCP server for Claude Code, Codex and
 * Gemini. Agents see only tabs shared with them (local dev pages, tabs they
 * opened, tabs the user shared); acting asks the user like any write tool.
 */
export function browserTools(browser: BrowserAgentApi): ToolDefinition<never>[] {
  /** The latest snapshot's refs, per tab. */
  const snapshots = new Map<string, Map<string, SnapshotRef>>()

  const element = (t: BrowserTab, r: string): SnapshotRef => {
    const found = snapshots.get(t.id)?.get(r)
    if (!found) throw coded('unknown-ref', `Unknown ref ${r} — take a browser_snapshot of this tab first.`)
    return found
  }

  /** After an action: give the page a moment to react (and finish a navigation it started). */
  const settle = async (id: string) => {
    await new Promise((r) => setTimeout(r, 250))
    await browser.waitForLoad(id, 10_000)
  }

  const screenshot = async (id: string | undefined, ctx: ToolContext): Promise<ToolContent[]> => {
    const t = browser.agentTab(id)
    const shot = await (await browser.automation(t.id)).capture()
    browser.noteAgent(t.id, who(ctx), 'screenshot')
    return [
      { type: 'text', text: `${inert(t.title) || '(untitled)'} — ${inert(t.url)} (${shot.width}×${shot.height})` },
      { type: 'image', data: shot.png, mimeType: 'image/png' }
    ]
  }

  const after = (t: BrowserTab) => {
    const now = browser.agentTabs().find((x) => x.id === t.id) ?? t
    return `Page now: ${inert(now.title) || '(untitled)'} — ${inert(now.url)}${now.error ? ` (failed to load: ${now.error.description})` : ''}`
  }

  const tools = [
    {
      name: 'browser_tabs',
      title: 'List browser tabs',
      description:
        "List the Mindeck browser tabs shared with you: the user's local dev pages (localhost), tabs you opened, and tabs the user shared. Other tabs stay private.",
      risk: 'read',
      schema: z.object({}),
      summarize: () => 'List the shared browser tabs',
      async run() {
        const tabs = browser.agentTabs()
        if (!tabs.length) {
          return 'No tabs are shared with agents. Open a page with browser_open, or ask the user to share a tab (the eye icon in the Mindeck browser).'
        }
        const [focused, beside] = browser.onScreen()
        const where = (id: string) => (id === focused ? ' · on screen, the user works here' : id === beside ? ' · on screen beside it (split view)' : '')
        return tabs
          .map((t) => `- [${t.id}] ${inert(t.title) || '(untitled)'} — ${inert(t.url)}${t.loading ? ' (loading)' : ''}${t.openedBy ? ` · opened by ${t.openedBy}` : ''}${where(t.id)}`)
          .join('\n')
      }
    } satisfies ToolDefinition<Record<string, never>>,
    {
      name: 'browser_open',
      title: 'Open a page',
      description: 'Open an http(s) address in a new tab of the Mindeck browser (in the background) and wait for it to load. Use browser_snapshot next to see it.',
      risk: 'write',
      schema: z.object({ url: z.string().url().max(4096), reason }),
      summarize: ({ url }) => `Open ${url} in the Mindeck browser`,
      async run({ url }, ctx) {
        const t = await browser.agentOpen(url, who(ctx))
        return `Opened tab [${t.id}]. ${after(t)}`
      }
    } satisfies ToolDefinition<{ url: string; reason: string }>,
    {
      name: 'browser_navigate',
      title: 'Navigate a tab',
      description: 'Load another address in a shared tab, or go back, forward or reload it — then wait for the page.',
      risk: 'write',
      schema: z.object({ tab, url: z.string().url().max(4096).optional(), action: z.enum(['back', 'forward', 'reload']).optional(), reason }),
      summarize: ({ url, action }) => (url ? `Load ${url} in a browser tab` : `${action ?? 'reload'} a browser tab`),
      async run({ tab: id, url, action }, ctx) {
        const t = browser.agentTab(id)
        await browser.agentNavigate(t.id, { url, action }, who(ctx))
        return after(t)
      }
    } satisfies ToolDefinition<{ tab?: string; url?: string; action?: 'back' | 'forward' | 'reload'; reason: string }>,
    {
      name: 'browser_snapshot',
      title: 'Read the page structure',
      description:
        'The page as an accessibility tree: headings, text, links, buttons, inputs — each element you can act on has a ref (e.g. [e12]) for browser_click / browser_type. Cheaper and more exact than a screenshot.',
      risk: 'read',
      schema: z.object({ tab }),
      summarize: () => 'Read the structure of a browser tab',
      async run({ tab: id }, ctx) {
        const t = browser.agentTab(id)
        const target = await browser.automation(t.id)
        const { nodes } = await target.cdp<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', {})
        const snap = renderSnapshot(nodes, { secret: await secretNodes(target) })
        snapshots.set(t.id, snap.refs)
        browser.noteAgent(t.id, who(ctx), 'snapshot')
        return untrusted(t, `# ${t.title || '(untitled)'} — ${t.url}\n${snap.text}`)
      }
    } satisfies ToolDefinition<{ tab?: string }>,
    {
      name: 'browser_read',
      title: 'Read the page text',
      description: "The page's visible text (title, address, body text) — for reading content. Use browser_snapshot to act on the page.",
      risk: 'read',
      schema: z.object({ tab, maxChars: z.number().int().min(500).max(100_000).optional() }),
      summarize: () => 'Read the text of a browser tab',
      async run({ tab: id, maxChars }, ctx) {
        const t = browser.agentTab(id)
        const target = await browser.automation(t.id)
        const { result } = await target.cdp<{ result: { value?: { title?: string; url?: string; text?: string } } }>('Runtime.evaluate', {
          expression: '({ title: document.title, url: location.href, text: document.body ? document.body.innerText : "" })',
          returnByValue: true
        })
        const page = result.value ?? {}
        browser.noteAgent(t.id, who(ctx), 'read')
        return untrusted(t, truncate(`# ${page.title || '(untitled)'} — ${page.url ?? t.url}\n\n${page.text ?? ''}`, maxChars ?? 30_000))
      }
    } satisfies ToolDefinition<{ tab?: string; maxChars?: number }>,
    {
      name: 'browser_screenshot',
      title: 'Screenshot the page',
      description: 'A picture of what the tab shows right now — for visual checks (layout, colors). Prefer browser_snapshot for content.',
      risk: 'read',
      schema: z.object({ tab }),
      summarize: () => 'Take a screenshot of a browser tab',
      async run(input, ctx) {
        const content = await screenshot(input.tab, ctx)
        return content.map((c) => (c.type === 'text' ? c.text : `[image ${c.mimeType}]`)).join('\n')
      },
      runContent: (input, ctx) => screenshot(input.tab, ctx)
    } satisfies ToolDefinition<{ tab?: string }>,
    {
      name: 'browser_console',
      title: 'Read the console',
      description: "The tab's console messages since it loaded (errors, warnings, logs) — check it after changes to find runtime errors.",
      risk: 'read',
      schema: z.object({ tab, level: z.enum(['error', 'warning', 'all']).optional(), limit: z.number().int().min(1).max(300).optional() }),
      summarize: () => 'Read the console of a browser tab',
      async run({ tab: id, level = 'all', limit = 100 }, ctx) {
        const t = browser.agentTab(id)
        const wanted = level === 'error' ? ['error'] : level === 'warning' ? ['error', 'warning'] : ['debug', 'info', 'warning', 'error']
        const entries = browser.consoleOf(t.id).filter((e) => wanted.includes(e.level)).slice(-limit)
        browser.noteAgent(t.id, who(ctx), 'console')
        if (!entries.length) return `No ${level === 'all' ? '' : `${level} `}console messages in ${t.url}.`
        return untrusted(t, truncate(formatConsole(entries)))
      }
    } satisfies ToolDefinition<{ tab?: string; level?: 'error' | 'warning' | 'all'; limit?: number }>,
    {
      name: 'browser_click',
      title: 'Click in the page',
      description: 'Click an element by its ref from the latest browser_snapshot (a real mouse click in the middle of it).',
      risk: 'write',
      schema: z.object({ tab, ref, reason }),
      summarize: ({ ref: r }) => `Click ${r} in a browser tab`,
      async run({ tab: id, ref: r }, ctx) {
        const t = browser.agentTab(id)
        const el = element(t, r)
        const target = await browser.automation(t.id)
        let center: { x: number; y: number }
        try {
          await target.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId: el.node })
          const { model } = await target.cdp<{ model: { content: number[] } }>('DOM.getBoxModel', { backendNodeId: el.node })
          center = quadCenter(model.content)
        } catch {
          throw coded('stale-ref', `${r} (${el.label}) is gone or hidden — take a new browser_snapshot.`)
        }
        browser.noteAgent(t.id, who(ctx), 'click', el.label)
        await target.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...center })
        await target.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...center, button: 'left', clickCount: 1 })
        await target.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...center, button: 'left', clickCount: 1 })
        await settle(t.id)
        return `Clicked ${r} (${el.label}). ${after(t)}`
      }
    } satisfies ToolDefinition<{ tab?: string; ref: string; reason: string }>,
    {
      name: 'browser_type',
      title: 'Type into the page',
      description: 'Type text into an input by its ref from the latest browser_snapshot (replacing what it holds unless clear is false). submit presses Enter afterwards. Never for password fields.',
      risk: 'write',
      schema: z.object({ tab, ref, text: z.string().max(20_000), clear: z.boolean().optional(), submit: z.boolean().optional(), reason }),
      summarize: ({ ref: r, text }) => `Type "${text.length > 60 ? `${text.slice(0, 60)}…` : text}" into ${r} in a browser tab`,
      async run({ tab: id, ref: r, text, clear = true, submit = false }, ctx) {
        const t = browser.agentTab(id)
        const el = element(t, r)
        const target = await browser.automation(t.id)
        if ((await secretNodes(target)).has(el.node)) throw coded('secret-field', 'Agents never type into password fields — ask the user to do it.')
        try {
          await target.cdp('DOM.focus', { backendNodeId: el.node })
        } catch {
          throw coded('stale-ref', `${r} (${el.label}) is gone or cannot take input — take a new browser_snapshot.`)
        }
        browser.noteAgent(t.id, who(ctx), 'type', el.label)
        if (clear) {
          const { object } = await target.cdp<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: el.node })
          await target.cdp('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: SELECT_ALL })
        }
        await target.cdp('Input.insertText', { text })
        if (submit) for (const event of keyEvents('Enter')) await target.cdp('Input.dispatchKeyEvent', event)
        await settle(t.id)
        return `Typed into ${r} (${el.label})${submit ? ' and pressed Enter' : ''}. ${after(t)}`
      }
    } satisfies ToolDefinition<{ tab?: string; ref: string; text: string; clear?: boolean; submit?: boolean; reason: string }>,
    {
      name: 'browser_press',
      title: 'Press a key',
      description: `Press a key in the page (where the focus is): ${KEY_NAMES.join(', ')}.`,
      risk: 'write',
      schema: z.object({ tab, key: z.enum(KEY_NAMES as [string, ...string[]]), reason }),
      summarize: ({ key }) => `Press ${key} in a browser tab`,
      async run({ tab: id, key }, ctx) {
        const t = browser.agentTab(id)
        const target = await browser.automation(t.id)
        browser.noteAgent(t.id, who(ctx), 'press', key)
        for (const event of keyEvents(key)) await target.cdp('Input.dispatchKeyEvent', event)
        await settle(t.id)
        return `Pressed ${key}. ${after(t)}`
      }
    } satisfies ToolDefinition<{ tab?: string; key: string; reason: string }>
  ]
  return tools as unknown as ToolDefinition<never>[]
}
