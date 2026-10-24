import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, settle } from './bridge'
import type { MindeckEvent } from '@shared/types/events'
import { LogsView, logKind } from '@/features/logs/components/LogsView'

const now = Date.now()
const at = (msAgo: number) => new Date(now - msAgo).toISOString()
const ev = (id: string, type: MindeckEvent['type'], msAgo: number, payload: Record<string, unknown> = {}, extra: Partial<MindeckEvent> = {}): MindeckEvent => ({
  id,
  type,
  ts: at(msAgo),
  actor: { kind: 'system' },
  payload,
  ...extra
})

const recent = [
  ev('e1', 'permission.granted', 1000, { tool: 'mcp__mindeck__terminal_run', decision: 'once' }, { actor: { kind: 'user' }, projectId: 'p1' }),
  ev('e2', 'tool.completed', 2000, { summary: 'Run: npm test' }),
  ev('e3', 'agent.status.updated', 3000, { text: 'thinking' }), // a step: not a log line
  ev('e4', 'agent.started', 4000, { agent: 'Coding', goal: 'Fix the build' }),
  ev('e5', 'app.started', 3 * 86_400_000, { version: '0.1.0' })
]

afterEach(() => vi.restoreAllMocks())

describe('LogsView', () => {
  it('everything recorded, newest first by day, live; filter, search, details, copy', async () => {
    const bridge = installBridge({ 'events:recent': (q: { limit: number }) => (q.limit === 500 ? recent : []) })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<LogsView />)
    await act(settle)

    const lines = () => screen.queryAllByRole('button', { expanded: false }).concat(screen.queryAllByRole('button', { expanded: true }))
    expect(lines()).toHaveLength(4) // the step is left out
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.queryByText('Yesterday')).toBeNull()
    expect(screen.getByText('4 entries')).toBeInTheDocument()
    expect(screen.getByText('Coding started: Fix the build')).toBeInTheDocument()

    // live: a new event on top, once
    const live = ev('e6', 'session.ended', 0, { code: 0 })
    act(() => bridge.emit('events:event', live))
    act(() => bridge.emit('events:event', live))
    act(() => bridge.emit('events:event', ev('e7', 'agent.status.updated', 0, { text: 'step' })))
    expect(screen.getByText('5 entries')).toBeInTheDocument()

    // filters, with their counts
    const filters = screen.getByRole('tablist', { name: 'Show' })
    expect(
      within(filters)
        .getAllByRole('tab')
        .map((t) => t.textContent)
    ).toEqual(['All5', 'Agents2', 'Tools1', 'Approvals1', 'App1'])
    fireEvent.click(within(filters).getByRole('tab', { name: /Approvals/ }))
    expect(screen.getByText('1 entry')).toBeInTheDocument()
    fireEvent.click(within(filters).getByRole('tab', { name: /All/ }))

    // search: text, type, project
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the logs' }), { target: { value: 'npm test' } })
    expect(screen.getByText('1 entry')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the logs' }), { target: { value: 'p1' } })
    expect(screen.getByText('1 entry')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the logs' }), { target: { value: 'nothing like it' } })
    expect(screen.getByText('No entry matches.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copy/ })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the logs' }), { target: { value: '' } })

    // a line opens for its details
    const granted = screen.getByText(/Approved/).closest('button')!
    fireEvent.click(granted)
    expect(granted).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('permission.granted')).toBeInTheDocument()
    expect(screen.getByText('user')).toBeInTheDocument()
    expect(screen.getByText(/"decision": "once"/)).toBeInTheDocument()
    fireEvent.click(granted)
    expect(granted).toHaveAttribute('aria-expanded', 'false')

    // copy what is shown, one line each
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }))
    expect(writeText).toHaveBeenCalledOnce()
    const text = (writeText.mock.calls[0] as unknown as [string])[0].split('\n')
    expect(text).toHaveLength(5)
    expect(text[0]).toMatch(/^\d{4}-\d{2}-\d{2} .+ {2}session\.ended {2}/)
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })

  it('nothing yet, or the core can’t say', async () => {
    installBridge({ 'events:recent': () => [] })
    const { unmount } = render(<LogsView />)
    await act(settle)
    expect(screen.getByText('Nothing recorded yet.')).toBeInTheDocument()
    unmount()

    const bridge = installBridge({ 'events:recent': () => fail('offline') })
    render(<LogsView />)
    act(() => bridge.emit('events:event', ev('x', 'app.started', 0))) // while loading: kept
    await act(settle)
    expect(screen.getByText('offline')).toBeInTheDocument()
    expect(screen.getByText('1 entry')).toBeInTheDocument()
  })

  it('sorts each event into its kind', () => {
    expect(['permission.requested', 'tool.denied', 'tool.started', 'agent.failed', 'session.started', 'app.started'].map((type) => logKind(ev('k', type as never, 0)))).toEqual([
      'approvals',
      'approvals',
      'tools',
      'agents',
      'agents',
      'app'
    ])
  })
})
