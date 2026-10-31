import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'
import type { SystemSnapshot } from '@shared/types/system'

import { Panel } from '@/components/ui/Panel'
import { StatusDot } from '@/components/ui/StatusDot'
import { TechLabel } from '@/components/ui/TechLabel'
import { GlowBackground } from '@/components/shell/GlowBackground'
import { SideNavigation } from '@/components/nav/SideNavigation'
import { WindowControls } from '@/components/topbar/WindowControls'
import { StatusIndicator } from '@/components/topbar/StatusIndicator'
import { Clock } from '@/components/topbar/Clock'
import { RadialGauge } from '@/components/monitor/RadialGauge'
import { Sparkline } from '@/components/monitor/Sparkline'
import { SystemMonitorPanel } from '@/components/monitor/SystemMonitorPanel'
import { BootSequence, BOOT_TOTAL_MS } from '@/components/boot/BootSequence'
import { MindeckMark } from '@/components/brand/MindeckMark'
import { useAssistant as staticAssistant } from '@/features/agents/store'
import { useAgents as staticAgents } from '@/features/agents/sessions'
import { HudClock } from '@/features/dashboard/components/HudClock'
import { NAV_ITEMS } from '@/data/navigation'
import { en } from '@/lib/i18n/en'

afterEach(() => {
  vi.useRealTimers()
})

describe('ui primitives', () => {
  it('Panel renders header parts only when given, corners and flush body', () => {
    const { container, rerender } = render(<Panel>body</Panel>)
    expect(container.querySelector('header')).toBeNull()
    expect(container.querySelector('.p-3')).not.toBeNull()

    rerender(
      <Panel title="T" corners flush className="x" bodyClassName="y">
        body
      </Panel>
    )
    expect(screen.getByText('T')).toBeInTheDocument()
    expect(container.querySelector('[aria-hidden]')).not.toBeNull() // HudFrame
    expect(container.querySelector('.p-3')).toBeNull()

    rerender(<Panel headerRight={<b>R</b>}>body</Panel>)
    expect(screen.getByText('R')).toBeInTheDocument()
    expect(container.querySelector('.tech-label')).toBeNull()
  })

  it('StatusDot tones and pulse; TechLabel tags', () => {
    const { container, rerender } = render(<StatusDot />)
    expect(container.querySelector('.bg-cyan.animate-pulse-dot')).not.toBeNull()
    rerender(<StatusDot tone="error" pulse={false} />)
    expect(container.querySelector('.bg-danger')).not.toBeNull()
    expect(container.querySelector('.animate-pulse-dot')).toBeNull()
    rerender(<TechLabel as="h2">L</TechLabel>)
    expect(container.querySelector('h2.tech-label')).toHaveTextContent('L')
  })

  it('StatusIndicator shows label and value', () => {
    render(<StatusIndicator label="Mode" value="LOCAL" />)
    expect(screen.getByText('Mode')).toBeInTheDocument()
    expect(screen.getByText('LOCAL')).toBeInTheDocument()
  })
})

describe('shell pieces', () => {
  it('GlowBackground: the plain background color, nothing on top', () => {
    const { container } = render(<GlowBackground />)
    expect(container.firstElementChild).toHaveClass('bg-void')
    expect(container.firstElementChild!.children).toHaveLength(0)
  })

  it('SideNavigation marks the active item and selects', () => {
    const onSelect = vi.fn()
    render(<SideNavigation active="terminal" onSelect={onSelect} />)
    expect(screen.getAllByRole('button')).toHaveLength(NAV_ITEMS.length + 2) // + fold, profile
    expect(screen.getByTitle('Terminal').className).toContain('text-text-primary')
    expect(screen.getByTitle('Core').className).toContain('text-text-muted')
    fireEvent.click(screen.getByTitle('Memory'))
    expect(onSelect).toHaveBeenCalledWith('memory')
  })

  it('SideNavigation ends in the profile tab', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<SideNavigation active="core" onSelect={onSelect} />)
    const profile = screen.getByLabelText('Profile')
    expect(profile.className).toContain('border-hud/50')
    expect(screen.getByText('Not signed in')).toBeInTheDocument()
    fireEvent.click(profile)
    expect(onSelect).toHaveBeenCalledWith('account')
    rerender(<SideNavigation active="account" onSelect={onSelect} />)
    expect(screen.getByLabelText('Profile').className).toContain('border-cyan/40')
  })

  it('SideNavigation folds to icons and back, remembers it, and the panes measure their place again', async () => {
    const { onRelayout } = await import('@/lib/relayout')
    const moved = vi.fn()
    const off = onRelayout(moved)
    const first = render(<SideNavigation active="core" open={['core', 'browser']} onSelect={vi.fn()} />)
    expect(moved).not.toHaveBeenCalled() // the first look moves nothing
    expect(screen.getByText('Modules')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the modules' }))
    expect(moved).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('mindeck.nav.collapsed')).toBe('1')
    expect(screen.queryByText('Modules')).toBeNull()
    expect(screen.queryByText('Memory')).toBeNull() // icons only, the name in the tooltip
    expect(screen.getByTitle('Memory')).toBeInTheDocument()
    expect(screen.queryByText('Not signed in')).toBeNull()
    expect(screen.getByTestId('open-browser')).toHaveClass('absolute') // the dot sits on the icon
    first.unmount()

    // remembered on the next start; unfolds again
    render(<SideNavigation active="core" onSelect={vi.fn()} />)
    const unfold = screen.getByRole('button', { name: 'Expand the modules' })
    expect(unfold).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(unfold)
    expect(screen.getByText('Memory')).toBeInTheDocument()
    expect(localStorage.getItem('mindeck.nav.collapsed')).toBe('0')
    off()
  })

  it('SideNavigation without storage: unfolded, and folding still works', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<SideNavigation active="core" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the modules' }))
    expect(screen.getByRole('button', { name: 'Expand the modules' })).toBeInTheDocument()
    get.mockRestore()
    set.mockRestore()
  })

  it('WindowControls drive the bridge and follow the maximized state', async () => {
    const bridge = installBridge({}, 'win32')
    render(<WindowControls />)
    await act(settle)
    fireEvent.click(screen.getByLabelText('Minimize'))
    fireEvent.click(screen.getByLabelText('Maximize'))
    fireEvent.click(screen.getByLabelText('Close'))
    expect(bridge.minimize).toHaveBeenCalled()
    expect(bridge.toggleMaximize).toHaveBeenCalled()
    expect(bridge.close).toHaveBeenCalled()
    act(() => bridge.setMaximized(true))
    expect(screen.getByLabelText('Restore')).toBeInTheDocument()
  })

  it('WindowControls no-op without a bridge', () => {
    render(<WindowControls />)
    fireEvent.click(screen.getByLabelText('Minimize'))
    fireEvent.click(screen.getByLabelText('Maximize'))
    fireEvent.click(screen.getByLabelText('Close'))
    expect(screen.getByLabelText('Maximize')).toBeInTheDocument()
  })

  it('Clock and HudClock show the time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 2, 7, 8, 9))
    render(<Clock />)
    expect(screen.getByText('07:08:09')).toBeInTheDocument()
    render(<HudClock now={new Date(2026, 0, 2, 7, 8, 9)} />)
    expect(screen.getByLabelText('07:08:09')).toHaveTextContent('07:0809')
  })
})

describe('TopStatusBar', () => {
  const load = async (platform?: string) => {
    if (platform) installBridge({}, platform)
    vi.resetModules()
    return (await import('@/components/topbar/TopStatusBar')).TopStatusBar
  }

  it('on macOS leaves room for the traffic lights and has no custom controls', async () => {
    const TopStatusBar = await load('darwin')
    const { container } = render(<TopStatusBar since={Date.now() - 61_000} />)
    await act(settle)
    expect(container.querySelector('header')!.className).toContain('pl-[88px]')
    expect(screen.queryByLabelText('Close')).toBeNull()
    expect(screen.getByText('00:01:01')).toBeInTheDocument()
  })

  it('elsewhere shows window controls; hides the clock on request', async () => {
    const TopStatusBar = await load('linux')
    const { container } = render(<TopStatusBar showClock={false} />)
    expect(screen.getByText('00:00:00')).toBeInTheDocument() // not booted yet
    expect(container.querySelector('header')!.className).not.toContain('pl-[88px]')
    expect(screen.getByLabelText('Close')).toBeInTheDocument()
  })
})

describe('TopStatusBar in a browser', () => {
  it('shows the remote core, the live link state and a disconnect button', async () => {
    vi.resetModules()
    const { TopStatusBar } = await import('@/components/topbar/TopStatusBar')
    const { useSession } = await import('@/features/session/store')
    const logout = vi.fn(async () => {})
    useSession.setState({ link: 'online', info: { mode: 'server', version: '2.0.0', platform: 'linux', hostname: 'nas', remoteTerminal: false }, logout })
    render(<TopStatusBar />)
    expect(screen.queryByLabelText('Close')).toBeNull()
    expect(screen.getByText('REMOTE · nas')).toBeInTheDocument()
    expect(screen.getByText('v2.0.0')).toBeInTheDocument()
    expect(screen.getByText('OK')).toBeInTheDocument()
    act(() => useSession.setState({ link: 'connecting', info: undefined }))
    expect(screen.getByText('SYNC')).toBeInTheDocument()
    expect(screen.getByText('REMOTE · core')).toBeInTheDocument()
    act(() => useSession.setState({ link: 'offline' }))
    expect(screen.getByText('DOWN')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Disconnect this browser'))
    expect(logout).toHaveBeenCalled()
  })
})

describe('monitor', () => {
  it('RadialGauge clamps and labels', () => {
    const { container, rerender } = render(<RadialGauge value={150} label="CPU" />)
    expect(screen.getByText('150')).toBeInTheDocument()
    expect(screen.getByText('CPU')).toBeInTheDocument()
    rerender(<RadialGauge value={-3} />)
    expect(container.querySelectorAll('circle')[1].getAttribute('stroke-dasharray')).toMatch(/^0 /)
  })

  it('Sparkline needs two points', () => {
    const { container, rerender } = render(<Sparkline data={[1]} />)
    expect(container.querySelector('path')).toBeNull()
    rerender(<Sparkline data={[0, 50, 200]} />)
    expect(container.querySelectorAll('path')).toHaveLength(2)
  })

  const snap = (over: Partial<SystemSnapshot> = {}): SystemSnapshot => ({
    cpu: { total: 12, cores: [] },
    mem: { usedPct: 40, usedGb: 4, totalGb: 8 },
    disk: { usedPct: 70, mount: '/' },
    net: { rxMbps: 1.25, txMbps: 0.5 },
    battery: { pct: 80, charging: false, hasBattery: true },
    uptimeSec: 90061,
    processes: [{ pid: 7, name: 'node', cpu: 3.21, mem: 120 }],
    ts: 1,
    ...over
  })

  it('SystemMonitorPanel: offline without a bridge', () => {
    render(<SystemMonitorPanel />)
    expect(screen.getByText('OFFLINE')).toBeInTheDocument()
    expect(screen.getByText('no data')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('N/A')).toBeInTheDocument()
  })

  it('SystemMonitorPanel: live data, uptime formats, battery states', async () => {
    const bridge = installBridge({ 'system:snapshot': () => snap() })
    render(<SystemMonitorPanel />)
    await act(settle)
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    expect(screen.getByText('1d 1h')).toBeInTheDocument()
    expect(screen.getByText('1.8')).toBeInTheDocument() // network MB/s
    expect(screen.getByText('Battery')).toBeInTheDocument()
    expect(screen.getByText('node')).toBeInTheDocument()
    expect(screen.getByText('3.2')).toBeInTheDocument()

    act(() => bridge.emit('system:tick', snap({ uptimeSec: 3720, battery: { pct: 50, charging: true, hasBattery: true } })))
    expect(screen.getByText('1h 2m')).toBeInTheDocument()
    expect(screen.getByText('Battery ⚡')).toBeInTheDocument()

    act(() => bridge.emit('system:tick', snap({ uptimeSec: 120, processes: [] })))
    expect(screen.getByText('2m')).toBeInTheDocument()
    expect(screen.getByText('sampling…')).toBeInTheDocument()
  })
})

describe('BootSequence', () => {
  it('reveals lines over time, then completes; click skips', () => {
    vi.useFakeTimers()
    const onSkip = vi.fn()
    const { container } = render(<BootSequence onSkip={onSkip} />)
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(BOOT_TOTAL_MS)
    })
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText(en.boot.lines[0])).toBeInTheDocument()
    expect(container.querySelector('.animate-pulse')).toBeNull()
    fireEvent.click(screen.getByText('click to skip'))
    expect(onSkip).toHaveBeenCalled()
  })
})

describe('MindeckMark', () => {
  it('draws the bolder one-layer mark below 40 px and the full deck from 40 px, each with its own gradient', () => {
    const { container } = render(
      <>
        <MindeckMark size={20} />
        <MindeckMark size={64} />
      </>
    )
    const [small, full] = Array.from(container.querySelectorAll('svg'))
    expect(small.querySelectorAll('path')).toHaveLength(2)
    expect(full.querySelectorAll('path')).toHaveLength(3)
    expect(full.getAttribute('height')).toBe('64')
    const gradients = [small, full].map((svg) => svg.querySelector('linearGradient')!.id)
    expect(gradients[0]).not.toBe(gradients[1])
    expect(gradients[0]).toMatch(/^[\w-]+$/)
    expect(full.querySelector('path:last-child')!.getAttribute('fill')).toBe(`url(#${gradients[1]})`)
  })
})

describe('AppShell', () => {
  it('boots, switches modules, keeps terminal and editor mounted and counts uptime', async () => {
    vi.doMock('@/features/terminal/components/TerminalView', () => ({ TerminalView: () => <div>TERMINAL</div> }))
    vi.doMock('@/features/editor/components/EditorView', () => ({
      EditorView: ({ active, onNavigate }: { active: boolean; onNavigate: (id: string) => void }) => (
        <button onClick={() => onNavigate('projects')}>{active ? 'EDITOR ON' : 'EDITOR OFF'}</button>
      )
    }))
    vi.doMock('@/features/dashboard/components/Dashboard', () => ({
      Dashboard: ({ onNavigate }: { onNavigate: (id: string) => void }) => (
        <button onClick={() => onNavigate('projects')}>DASHBOARD</button>
      )
    }))
    vi.doMock('@/features/projects/components/ProjectsView', () => ({ ProjectsView: () => <div>PROJECTS</div> }))
    vi.doMock('@/features/memory/components/MemoryView', () => ({ MemoryView: () => <div>MEMORY</div> }))
    vi.doMock('@/components/monitor/SystemMonitorPanel', () => ({ SystemMonitorPanel: () => <div>MONITOR</div> }))
    vi.doMock('@/features/agents/components/AgentsView', () => ({
      AgentsView: ({ onOpenNote, onOpenSettings }: { onOpenNote: (p: string) => void; onOpenSettings: () => void }) => (
        <div>
          AGENTS
          <button onClick={() => onOpenNote('Agents/x.md')}>OPEN NOTE</button>
          <button onClick={onOpenSettings}>OPEN SETTINGS</button>
        </div>
      )
    }))
    vi.doMock('@/features/settings/components/SettingsView', () => ({ SettingsView: () => <div>SETTINGS</div> }))
    vi.doMock('@/features/system/components/SystemView', () => ({ SystemView: () => <div>SYSTEM</div> }))
    vi.doMock('@/features/account/components/AccountView', () => ({ AccountView: () => <div>ACCOUNT</div> }))
    vi.doMock('@/features/logs/components/LogsView', () => ({ LogsView: () => <div>LOGS</div> }))
    vi.resetModules()
    const { AppShell } = await import('@/components/shell/AppShell')
    const { useAssistant } = await import('@/features/agents/store')
    const { useAgents } = await import('@/features/agents/sessions')
    const { useMemory } = await import('@/features/memory/store')
    const connect = vi.fn(() => () => {})
    const open = vi.fn(async () => {})
    const agentsConnect = vi.fn(() => () => {})
    const openSession = vi.fn(async () => {})
    const openNote = vi.fn(async () => {})
    useAgents.setState({ connect: agentsConnect, open: openSession })
    useMemory.setState({ open: openNote })
    useAssistant.setState({ connect, open })

    vi.useFakeTimers()
    render(<AppShell />)
    expect(screen.getByText('click to skip')).toBeInTheDocument()
    fireEvent.click(screen.getByText('click to skip'))
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText('00:00:02')).toBeInTheDocument() // uptime

    expect(screen.getByText('MONITOR')).toBeInTheDocument() // the rail is Core's
    fireEvent.click(screen.getByText('DASHBOARD'))
    expect(screen.getByText('PROJECTS')).toBeInTheDocument()
    expect(screen.queryByText('MONITOR')).toBeNull()

    expect(screen.queryByText('TERMINAL')).toBeNull()
    fireEvent.click(screen.getByTitle('Terminal'))
    expect(screen.getByText('TERMINAL').parentElement!).not.toHaveClass('hidden')
    expect(screen.queryByText('MONITOR')).toBeNull()

    expect(screen.queryByText(/EDITOR/)).toBeNull()
    fireEvent.click(screen.getByTitle('Editor'))
    expect(screen.getByText('EDITOR ON').parentElement!).not.toHaveClass('hidden')
    expect(screen.queryByText('MONITOR')).toBeNull()
    expect(screen.getByText('TERMINAL').parentElement!.className).toBe('hidden')
    fireEvent.click(screen.getByTitle('Terminal')) // second visit: both stay mounted
    expect(screen.getByText('EDITOR OFF').parentElement!.className).toBe('hidden')
    fireEvent.click(screen.getByTitle('Editor'))
    fireEvent.click(screen.getByText('EDITOR ON')) // the editor can send you elsewhere
    expect(screen.getByText('PROJECTS')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('Memory'))
    expect(screen.getByText('MEMORY')).toBeInTheDocument()
    expect(screen.queryByText('MONITOR')).toBeNull()
    expect(screen.getByText('TERMINAL').parentElement!.className).toBe('hidden')

    fireEvent.click(screen.getByTitle('Agents'))
    expect(screen.getByText('AGENTS')).toBeInTheDocument()
    expect(connect).toHaveBeenCalled()
    expect(agentsConnect).toHaveBeenCalled()
    fireEvent.click(screen.getByText('OPEN NOTE')) // a session's note → Memory
    expect(screen.getByText('MEMORY')).toBeInTheDocument()
    expect(openNote).toHaveBeenCalledWith('Agents/x.md')
    fireEvent.click(screen.getByTitle('Agents'))
    fireEvent.click(screen.getByText('OPEN SETTINGS'))
    expect(screen.getByText('SETTINGS')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('System'))
    expect(screen.getByText('SYSTEM')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Logs'))
    expect(screen.getByText('LOGS')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Settings'))
    expect(screen.getByText('SETTINGS')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Profile'))
    expect(screen.getByText('ACCOUNT')).toBeInTheDocument()

    // approvals float above modules; the chat open in Agents shows its own inline
    fireEvent.click(screen.getByTitle('Core'))
    act(() =>
      useAssistant.setState({
        pending: [{ id: 'p1', conversationId: 'c1', agentName: 'Assistant', toolTitle: 'Create note', risk: 'write', summary: 'Create X', reason: '', allowAlways: true } as never],
        conversations: [{ id: 'c1', title: 'Chat one', agentId: 'assistant', createdAt: '', updatedAt: '', running: true }],
        running: { c1: true },
        activeId: 'c1'
      })
    )
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Agents'))
    act(() => useAgents.getState().showAssistant())
    expect(screen.getByText('AGENTS')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull() // the open chat shows it inline
    act(() => useAssistant.setState({ pending: [], conversations: [], running: {}, activeId: undefined }))

    // …and a coding agent session
    act(() =>
      useAgents.setState({
        sessions: [{ id: 's1', title: 'Fix login', status: 'working', live: true, terminalId: 't', projectId: 'p', projectName: 'P', kind: 'claude-code', cwd: '/', isolated: false, plan: [], notes: [], createdAt: '', updatedAt: '' }]
      })
    )
    // its approval shows inline in the open session, not as a toast
    act(() =>
      useAssistant.setState({
        pending: [{ id: 'p2', conversationId: 's1', agentName: 'Claude Code', toolTitle: 'Run command', risk: 'execute', summary: 'npm test', reason: '', allowAlways: false } as never]
      })
    )
    expect(screen.getByRole('alertdialog')).toBeInTheDocument() // the session isn't the open one yet
    act(() => useAgents.setState({ view: 'session', activeId: 's1' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    act(() => useAssistant.setState({ pending: [] }))
    act(() => useAgents.setState({ sessions: [] }))

    vi.doUnmock('@/features/agents/components/AgentsView')
    vi.doUnmock('@/features/settings/components/SettingsView')
    vi.doUnmock('@/features/system/components/SystemView')
    vi.doUnmock('@/features/account/components/AccountView')
    vi.doUnmock('@/features/logs/components/LogsView')
    vi.doUnmock('@/features/terminal/components/TerminalView')
    vi.doUnmock('@/features/editor/components/EditorView')
    vi.doUnmock('@/features/dashboard/components/Dashboard')
    vi.doUnmock('@/features/projects/components/ProjectsView')
    vi.doUnmock('@/features/memory/components/MemoryView')
    vi.doUnmock('@/components/monitor/SystemMonitorPanel')
  })
})

describe('AppShell in a browser without remote shells', () => {
  it('explains instead of opening a terminal', async () => {
    vi.doMock('@/features/terminal/components/TerminalView', () => ({ TerminalView: () => <div>TERMINAL</div> }))
    vi.doMock('@/features/dashboard/components/Dashboard', () => ({ Dashboard: () => <div>DASHBOARD</div> }))
    vi.doMock('@/components/monitor/SystemMonitorPanel', () => ({ SystemMonitorPanel: () => <div>MONITOR</div> }))
    vi.resetModules()
    const { AppShell } = await import('@/components/shell/AppShell')
    const { useSession } = await import('@/features/session/store')
    const { useAssistant } = await import('@/features/agents/store')
    useAssistant.setState({ connect: () => () => {} })
    useSession.setState({ info: { mode: 'server', version: '1', platform: 'linux', hostname: 'nas', remoteTerminal: false } })
    render(<AppShell />)
    fireEvent.click(screen.getByTitle('Terminal'))
    expect(screen.getByText('Remote shells are off')).toBeInTheDocument()
    expect(screen.queryByText('TERMINAL')).toBeNull()
    useSession.setState({ info: undefined })
    vi.doUnmock('@/features/terminal/components/TerminalView')
    vi.doUnmock('@/features/dashboard/components/Dashboard')
    vi.doUnmock('@/components/monitor/SystemMonitorPanel')
  })
})

describe('AppShell with the Browser and Files', () => {
  it('keeps the browser mounted, follows what it asks for, shows Files — and lets the page show approvals itself', async () => {
    vi.doMock('@/features/browser/components/BrowserView', () => ({ BrowserView: ({ active }: { active: boolean }) => <div>{active ? 'BROWSER ON' : 'BROWSER OFF'}</div> }))
    vi.doMock('@/features/files/components/FilesView', () => ({
      FilesView: ({ onNavigate }: { onNavigate: (id: string) => void }) => <button onClick={() => onNavigate('terminal')}>FILES</button>
    }))
    vi.doMock('@/features/terminal/components/TerminalView', () => ({ TerminalView: () => <div>TERMINAL</div> }))
    vi.doMock('@/features/dashboard/components/Dashboard', () => ({ Dashboard: () => <div>DASHBOARD</div> }))
    vi.doMock('@/components/monitor/SystemMonitorPanel', () => ({ SystemMonitorPanel: () => <div>MONITOR</div> }))
    vi.doMock('@/components/topbar/TopStatusBar', () => ({ TopStatusBar: () => null }))
    vi.doMock('@/features/agents/components/AgentsView', () => ({ AgentsView: () => <div>AGENTS</div> }))
    vi.doMock('@/features/settings/components/SettingsView', () => ({ SettingsView: () => <div>SETTINGS</div> }))
    vi.resetModules()
    const bridge = installBridge() // the desktop app: the page covers toasts
    const { AppShell } = await import('@/components/shell/AppShell')
    const { useAssistant } = await import('@/features/agents/store')
    const { useAgents } = await import('@/features/agents/sessions')
    const { useBrowser } = await import('@/features/browser/store')
    const { tab } = await import('./browserFixtures')
    let handlers!: Parameters<ReturnType<typeof useBrowser.getState>['connect']>[0]
    const disconnect = vi.fn()
    useBrowser.setState({
      connect: (h) => {
        handlers = h
        return disconnect
      }
    })
    useAssistant.setState({ connect: () => () => {} })
    const openDialog = vi.fn()
    useAgents.setState({ connect: () => () => {}, openDialog })

    vi.useFakeTimers()
    const view = render(<AppShell />)
    fireEvent.click(screen.getByText('click to skip'))
    act(() => {
      vi.advanceTimersByTime(BOOT_TOTAL_MS)
    })
    vi.useRealTimers()

    fireEvent.click(screen.getByTitle('Files'))
    fireEvent.click(screen.getByText('FILES')) // Files sends you on (a terminal in a folder, …)
    expect(screen.getByText('TERMINAL').parentElement!).not.toHaveClass('hidden')

    expect(screen.queryByText(/BROWSER/)).toBeNull()
    act(() => handlers.reveal()) // a link opened somewhere: show the browser
    expect(screen.getByText('BROWSER ON').parentElement!).not.toHaveClass('hidden')
    act(() =>
      useAssistant.setState({
        pending: [{ id: 'p1', conversationId: 'c1', agentName: 'Assistant', toolTitle: 'Create note', risk: 'write', summary: 'Create X', reason: '', allowAlways: true } as never]
      })
    )
    expect(screen.queryByRole('alertdialog')).toBeNull() // the browser shows approvals over the page itself

    act(() => handlers.sendToAgent(tab('a', 'https://a.dev/')))
    expect(screen.getByText('AGENTS')).toBeInTheDocument()
    expect(openDialog).toHaveBeenCalledWith(en.browser.agentPrompt('https://a.dev/', 'https://a.dev/'))
    expect(screen.getByText('BROWSER OFF').parentElement!.className).toBe('hidden') // still mounted
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    act(() => handlers.sendToAgent(tab('b', 'https://b.dev/', { title: 'Docs' })))
    expect(openDialog).toHaveBeenLastCalledWith(en.browser.agentPrompt('Docs', 'https://b.dev/'))
    act(() => handlers.settings())
    expect(screen.getByText('SETTINGS')).toBeInTheDocument()
    // An agent started a command in a terminal: that terminal's tab, and the Terminal on screen.
    const { useTerminals } = await import('@/features/terminal/store')
    const reveal = vi.fn(async () => {})
    useTerminals.setState({ reveal })
    const info = { id: 't9', title: 'demo', cwd: '/w', cwdLabel: 'w', shell: 'zsh', createdAt: '2026-10-29T00:00:00Z' }
    act(() => bridge.emit('terminal:reveal', { info, by: 'Claude Code' }))
    expect(reveal).toHaveBeenCalledWith(info)
    expect(screen.getByText('TERMINAL').parentElement!).not.toHaveClass('hidden')
    act(() => useAssistant.setState({ pending: [] }))
    view.unmount()
    expect(disconnect).toHaveBeenCalled()

    for (const m of [
      '@/features/browser/components/BrowserView',
      '@/features/files/components/FilesView',
      '@/features/terminal/components/TerminalView',
      '@/features/dashboard/components/Dashboard',
      '@/components/monitor/SystemMonitorPanel',
      '@/components/topbar/TopStatusBar',
      '@/features/agents/components/AgentsView',
      '@/features/settings/components/SettingsView'
    ])
      vi.doUnmock(m)
    Reflect.deleteProperty(window, 'mindeck')
  })
})

describe('AppShell with panes', () => {
  it('shows modules side by side, follows the page’s focus, and hides the chrome in zen mode', async () => {
    vi.doMock('@/features/browser/components/BrowserView', () => ({ BrowserView: ({ active }: { active: boolean }) => <div>{active ? 'BROWSER ON' : 'BROWSER OFF'}</div> }))
    vi.doMock('@/features/agents/components/AgentsView', () => ({ AgentsView: () => <div>AGENTS</div> }))
    vi.doMock('@/features/terminal/components/TerminalView', () => ({ TerminalView: () => <div>TERMINAL</div> }))
    vi.doMock('@/features/dashboard/components/Dashboard', () => ({ Dashboard: () => <div>DASHBOARD</div> }))
    vi.doMock('@/components/monitor/SystemMonitorPanel', () => ({ SystemMonitorPanel: () => <div>MONITOR</div> }))
    vi.doMock('@/components/topbar/TopStatusBar', () => ({ TopStatusBar: ({ showClock }: { showClock: boolean }) => <div>{showClock ? 'TOPBAR CLOCK' : 'TOPBAR'}</div> }))
    vi.resetModules()
    installBridge({}, 'linux')
    const { AppShell } = await import('@/components/shell/AppShell')
    const { useAssistant } = await import('@/features/agents/store')
    const { useAgents } = await import('@/features/agents/sessions')
    const { useBrowser } = await import('@/features/browser/store')
    const { useWorkspace } = await import('@/features/workspace/store')
    const { makeLayout } = await import('@/features/workspace/layout')
    let handlers!: Parameters<ReturnType<typeof useBrowser.getState>['connect']>[0]
    useBrowser.setState({
      connect: (h) => {
        handlers = h
        return () => {}
      }
    })
    useAssistant.setState({ connect: () => () => {} })
    useAgents.setState({ connect: () => () => {} })
    useWorkspace.setState({ layout: makeLayout('columns', ['agents', 'browser']) })

    vi.useFakeTimers()
    render(<AppShell />)
    expect(screen.getByText('BROWSER OFF')).toBeInTheDocument() // not over the boot screen
    fireEvent.click(screen.getByText('click to skip'))
    act(() => {
      vi.advanceTimersByTime(BOOT_TOTAL_MS)
    })
    vi.useRealTimers()

    expect(screen.getByText('AGENTS')).toBeInTheDocument()
    expect(screen.getByText('BROWSER ON')).toBeInTheDocument()
    expect(screen.getByText('TOPBAR CLOCK')).toBeInTheDocument()
    expect(screen.getByTestId('open-browser')).toBeInTheDocument() // on screen in the other pane
    expect(screen.queryByTestId('open-agents')).toBeNull() // the focused one is marked in full

    act(() => handlers.focused!()) // a click into the page
    expect(useWorkspace.getState().layout.focus).toBe('p2')
    // a workspace key pressed in the page: the focus moves to the pane on the left
    const { macKeys } = await import('@/features/workspace/keys')
    const mac = macKeys()
    const paneKey = (key: string) => ({ key, code: key, metaKey: mac, ctrlKey: !mac, altKey: true, shiftKey: false })
    act(() => handlers.workspaceKey!(paneKey('PageUp'))) // not one of the workspace's
    expect(useWorkspace.getState().layout.focus).toBe('p2')
    act(() => handlers.workspaceKey!(paneKey('ArrowLeft')))
    expect(useWorkspace.getState().layout.focus).toBe('p1')
    act(() => handlers.focused!())
    const { usePalette } = await import('@/features/palette/store')
    act(() => handlers.palette!()) // ⇧⌘P while the page has the keyboard: the palette, over everything
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    act(() => handlers.palette!()) // …and the same key closes it
    expect(usePalette.getState().view).toBeUndefined()
    fireEvent.click(screen.getByTitle('Core')) // the side navigation fills the focused pane
    expect(useWorkspace.getState().layout.panes.map((p) => p.module)).toEqual(['agents', 'core'])
    expect(screen.getByText('DASHBOARD')).toBeInTheDocument()
    expect(screen.getByText('MONITOR')).toBeInTheDocument()
    expect(screen.getByText('TOPBAR')).toBeInTheDocument()
    expect(screen.getByText('BROWSER OFF')).toBeInTheDocument() // kept, hidden

    act(() => useWorkspace.getState().setZen(true))
    expect(screen.queryByText('TOPBAR')).toBeNull()
    expect(screen.queryByTitle('Terminal')).toBeNull()
    expect(screen.getAllByRole('button', { name: /Leave zen mode/ }).length).toBeGreaterThan(0)
    act(() => useWorkspace.getState().setZen(false))
    expect(screen.getByText('TOPBAR')).toBeInTheDocument()

    for (const m of [
      '@/features/browser/components/BrowserView',
      '@/features/agents/components/AgentsView',
      '@/features/terminal/components/TerminalView',
      '@/features/dashboard/components/Dashboard',
      '@/components/monitor/SystemMonitorPanel',
      '@/components/topbar/TopStatusBar'
    ])
      vi.doUnmock(m)
  })
})
