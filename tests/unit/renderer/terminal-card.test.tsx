import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { choose, fail, installBridge, installRemote, settle } from './bridge'
import { DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from '@shared/types/terminal'
import { TerminalCard } from '@/features/settings/components/TerminalCard'
import { useTerminalSettings } from '@/features/terminal/settings'

const initial = useTerminalSettings.getState()
beforeEach(() => useTerminalSettings.setState(initial, true))

/** A core that keeps what it is told (like the real settings file). */
function core(start: Partial<TerminalSettings> = {}) {
  let settings: TerminalSettings = { ...DEFAULT_TERMINAL_SETTINGS, ...start }
  const configure = vi.fn((patch: Partial<TerminalSettings>) => (settings = { ...settings, ...patch }))
  const bridge = installBridge({
    'terminal:settings': () => settings,
    'terminal:shells': () => [{ id: 'zsh', name: 'zsh', file: '/bin/zsh', args: ['-l'] }],
    'terminal:configure': configure
  })
  return { configure, bridge, get: () => settings }
}

const server = { id: 'custom-s', name: 'Server', command: 'ssh', args: ['host'], env: { A: '1' } }

describe('Settings → Terminal', () => {
  it('font, size, line height, cursor, scrollback and the switches', async () => {
    const { configure } = core()
    render(<TerminalCard />)
    await act(settle)
    const font = screen.getByLabelText('Font')
    fireEvent.change(font, { target: { value: ' Fira Code ' } })
    fireEvent.keyDown(font, { key: 'Enter' })
    expect(configure).toHaveBeenLastCalledWith({ fontFamily: 'Fira Code' })
    await act(settle)
    fireEvent.change(font, { target: { value: '  ' } })
    fireEvent.blur(font)
    expect(font).toHaveValue('Fira Code') // empty: back to what it was
    fireEvent.keyDown(font, { key: 'a' })

    const size = screen.getByLabelText('Size')
    fireEvent.change(size, { target: { value: '40' } })
    fireEvent.keyDown(size, { key: 'Enter' })
    expect(configure).toHaveBeenLastCalledWith({ fontSize: 32 })
    await act(settle)
    fireEvent.change(size, { target: { value: '' } })
    fireEvent.blur(size)
    expect(size).toHaveValue(32)
    fireEvent.change(size, { target: { value: '32' } })
    fireEvent.blur(size) // unchanged: nothing saved
    fireEvent.keyDown(size, { key: 'a' })
    const line = screen.getByLabelText('Line height')
    fireEvent.change(line, { target: { value: '1.33' } })
    fireEvent.blur(line)
    expect(configure).toHaveBeenLastCalledWith({ lineHeight: 1.33 })
    fireEvent.change(screen.getByLabelText('Scrollback (lines)'), { target: { value: '20000.4' } })
    fireEvent.blur(screen.getByLabelText('Scrollback (lines)'))
    expect(configure).toHaveBeenLastCalledWith({ scrollback: 20000 })
    fireEvent.change(screen.getByLabelText('Kept for reattaching (KB)'), { target: { value: '1' } })
    fireEvent.blur(screen.getByLabelText('Kept for reattaching (KB)'))
    expect(configure).toHaveBeenLastCalledWith({ bufferKb: 64 })

    choose('Cursor', 'Block')
    expect(configure).toHaveBeenLastCalledWith({ cursorStyle: 'block' })
    for (const [name, key, value] of [
      ['Blinking cursor', 'cursorBlink', false],
      ['Copy on select', 'copyOnSelect', true],
      ['GPU rendering', 'gpu', false],
      ['Restore terminals', 'restoreTabs', true],
      ['Shell integration', 'shellIntegration', false]
    ] as const) {
      fireEvent.click(screen.getByRole('switch', { name }))
      expect(configure).toHaveBeenLastCalledWith({ [key]: value })
    }
    choose('Default profile', /^zsh/)
    expect(configure).toHaveBeenLastCalledWith({ defaultProfile: 'zsh' })
  })

  it('profiles: add, edit, remove (the default goes with it)', async () => {
    const { configure, get } = core({ profiles: [server], defaultProfile: 'custom-s' })
    render(<TerminalCard />)
    await act(settle)
    expect(screen.getByText('ssh host')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Add profile'))
    const save = () => screen.getByRole('button', { name: 'Save' })
    expect(save()).toBeDisabled()
    expect(screen.getByText('Add profile').closest('button')).toBeDisabled() // one at a time
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Node ' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } })
    fireEvent.change(screen.getByLabelText('Start folder (absolute, optional)'), { target: { value: 'rel' } })
    expect(screen.getByLabelText('Start folder (absolute, optional)')).toHaveAttribute('aria-invalid', 'true')
    expect(save()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Start folder (absolute, optional)'), { target: { value: '/srv' } })
    fireEvent.change(screen.getByLabelText('Arguments (one per line)'), { target: { value: '--inspect\n\n-i' } })
    fireEvent.change(screen.getByLabelText('Environment (NAME=value, one per line)'), { target: { value: 'NODE_ENV=dev\nbad line\n=x\n1X=y\nB=a=b' } })
    fireEvent.click(save())
    await act(settle)
    const added = get().profiles[1]
    expect(added).toMatchObject({ name: 'Node', command: 'node', args: ['--inspect', '-i'], env: { NODE_ENV: 'dev', B: 'a=b' }, cwd: '/srv' })
    expect(added.id).toMatch(/^custom-/)

    fireEvent.click(screen.getByLabelText('Edit Server'))
    expect(screen.getByLabelText('Environment (NAME=value, one per line)')).toHaveValue('A=1')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Prod' } })
    fireEvent.click(save())
    await act(settle)
    expect(get().profiles.map((p) => p.name)).toEqual(['Prod', 'Node'])
    expect(get().profiles[0]).not.toHaveProperty('cwd')

    fireEvent.click(screen.getByText('Add profile'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Name')).toBeNull()

    fireEvent.click(screen.getByLabelText('Remove Node'))
    expect(configure).toHaveBeenLastCalledWith({ profiles: [expect.objectContaining({ name: 'Prod' })] })
    await act(settle)
    fireEvent.click(screen.getByLabelText('Remove Prod'))
    expect(configure).toHaveBeenLastCalledWith({ profiles: [], defaultProfile: '' })
  })

  it('no more than the limit of profiles; errors show; the web UI has no such card', async () => {
    core({ profiles: Array.from({ length: 20 }, (_, i) => ({ ...server, id: `custom-${i}`, name: `P${i}` })) })
    const { unmount } = render(<TerminalCard />)
    await act(settle)
    expect(screen.getByText('Add profile').closest('button')).toBeDisabled()
    unmount()

    installBridge({ 'terminal:configure': () => fail('denied') })
    render(<TerminalCard />)
    await act(settle)
    fireEvent.click(screen.getByRole('switch', { name: 'GPU rendering' }))
    await act(settle)
    expect(screen.getByText('denied')).toBeInTheDocument()
  })

  it('in a browser (web UI) it isn’t shown', async () => {
    installRemote()
    const { container } = render(<TerminalCard />)
    await act(settle)
    expect(container).toBeEmptyDOMElement()
  })
})
