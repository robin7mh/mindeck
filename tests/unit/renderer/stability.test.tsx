import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ErrorInfo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle, choose } from './bridge'
import { AppBoundary, installErrorReporting, ModuleBoundary, reportError } from '@/components/shell/ErrorBoundary'
import { DesktopCard } from '@/features/settings/components/DesktopCard'
import { useLocale } from '@/lib/i18n'
import type { DesktopStatus } from '@shared/types/desktop'

let healthy = false
function Fragile({ what = new Error('x is undefined') }: { what?: unknown }) {
  if (!healthy) throw what
  return <p>module content</p>
}

const writeText = vi.fn(async (_text: string) => {})
beforeEach(() => {
  healthy = false
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  // React logs every caught render error; the tests look at what Mindeck does with it.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  useLocale.getState().setLocale('en')
})
afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
})

const reports = (bridge: ReturnType<typeof installBridge>) =>
  bridge.invoke.mock.calls.filter(([channel]) => channel === 'desktop:reportError').map(([, payload]) => payload as Record<string, string>)

describe('ModuleBoundary', () => {
  it('a crashing module shows a panel — the rest keeps running — reports to the log, copies its details and reloads', async () => {
    const bridge = installBridge()
    render(
      <>
        <ModuleBoundary id="agents" name="Agents">
          <Fragile />
        </ModuleBoundary>
        <p>the rest of Mindeck</p>
      </>
    )
    expect(screen.getByRole('alert')).toHaveTextContent('This module crashed')
    expect(screen.getByText(/Something went wrong in Agents/)).toBeInTheDocument()
    expect(screen.getByText('the rest of Mindeck')).toBeInTheDocument()
    expect(screen.getByText('The error was written to the log.')).toBeInTheDocument()
    await settle()
    expect(reports(bridge)).toEqual([
      expect.objectContaining({ kind: 'module', module: 'agents', message: 'x is undefined', stack: expect.stringContaining('x is undefined'), componentStack: expect.stringContaining('Fragile') })
    ])
    expect(screen.getByText(/Component stack:/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Copy error details/ }))
    await settle()
    expect(writeText.mock.calls[0][0]).toMatch(/^Error: x is undefined\n\n/)
    expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument()

    healthy = true
    fireEvent.click(screen.getByRole('button', { name: /Reload module/ }))
    expect(screen.getByText('module content')).toBeInTheDocument()
  })

  it('anything thrown counts; without a clipboard copying does nothing; in a browser the console gets it', async () => {
    const error = vi.mocked(console.error)
    render(
      <ModuleBoundary id="files" name="Files">
        <Fragile what="just a string" />
      </ModuleBoundary>
    )
    expect(screen.getByText(/Error: just a string/)).toBeInTheDocument()
    expect(screen.queryByText('The error was written to the log.')).not.toBeInTheDocument()
    expect(error).toHaveBeenCalledWith('[files]', 'just a string', expect.any(String))
    Reflect.deleteProperty(navigator, 'clipboard')
    fireEvent.click(screen.getByRole('button', { name: /Copy error details/ }))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => Promise.reject(new Error('denied')) }, configurable: true })
    fireEvent.click(screen.getByRole('button', { name: /Copy error details/ }))
    await settle()
    expect(screen.getByRole('button', { name: /Copy error details/ })).toBeInTheDocument()
  })

  it('speaks German', () => {
    useLocale.getState().setLocale('de')
    render(
      <ModuleBoundary id="editor" name="Editor">
        <Fragile />
      </ModuleBoundary>
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Dieses Modul ist abgestürzt')
    expect(screen.getByRole('button', { name: /Modul neu laden/ })).toBeInTheDocument()
  })
})

describe('AppBoundary', () => {
  it('the whole UI failing offers to reload the window', async () => {
    const bridge = installBridge()
    const reload = vi.fn()
    render(
      <AppBoundary reload={reload}>
        <Fragile />
      </AppBoundary>
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Mindeck’s window crashed')
    fireEvent.click(screen.getByRole('button', { name: /Reload Mindeck/ }))
    expect(reload).toHaveBeenCalled()
    await settle()
    expect(reports(bridge)[0]).toMatchObject({ kind: 'app', message: 'x is undefined' })
  })

  it('renders the app while all is well, and reloads the page by default', () => {
    healthy = true
    const { unmount } = render(
      <AppBoundary>
        <Fragile />
      </AppBoundary>
    )
    expect(screen.getByText('module content')).toBeInTheDocument()
    unmount()
    healthy = false
    const reload = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location)
    render(
      <AppBoundary>
        <Fragile />
      </AppBoundary>
    )
    fireEvent.click(screen.getByRole('button', { name: /Reload Mindeck/ }))
    expect(reload).toHaveBeenCalled()
  })
})

describe('error reporting', () => {
  it('uncaught errors and rejections go to the log; the listeners can be removed', async () => {
    const bridge = installBridge()
    const off = installErrorReporting()
    act(() => {
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('late boom'), message: 'late boom' }))
      window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))
      const rejection = new Event('unhandledrejection') as Event & { reason: unknown }
      rejection.reason = 'no network'
      window.dispatchEvent(rejection)
    })
    await settle()
    expect(reports(bridge)).toEqual([
      expect.objectContaining({ kind: 'error', message: 'late boom' }),
      expect.objectContaining({ kind: 'error', message: 'Script error.' }),
      expect.objectContaining({ kind: 'rejection', message: 'no network' })
    ])
    off()
    window.dispatchEvent(new ErrorEvent('error', { message: 'after' }))
    await settle()
    expect(reports(bridge)).toHaveLength(3)
  })

  it('a failing report is swallowed; in a browser the console says what it can', async () => {
    installBridge({ 'desktop:reportError': () => Promise.reject(new Error('gone')) })
    reportError({ kind: 'error', message: 'x' })
    await settle()
    delete (window as { mindeck?: unknown }).mindeck
    reportError({ kind: 'rejection', message: 'y' })
    expect(console.error).toHaveBeenCalledWith('[rejection]', 'y', '')
  })

  it('a boundary copes without a component stack', () => {
    const boundary = new ModuleBoundary({ id: 'x', name: 'X', children: null })
    boundary.setState = vi.fn()
    boundary.componentDidCatch(new Error('e'), {} as ErrorInfo)
    expect(boundary.setState).toHaveBeenCalledWith({ caught: { error: expect.any(Error), componentStack: '' } })
  })
})

describe('Settings → Desktop app', () => {
  const status = (over: Partial<DesktopStatus> = {}): DesktopStatus => ({
    platform: 'linux',
    logsDir: '/home/me/Mindeck/logs',
    secretsEncrypted: true,
    closeBehavior: 'ask',
    ...over
  })

  it('Linux without a keyring: warns about plain-text secrets; the close behavior is a choice', async () => {
    let current = status({ secretsEncrypted: false })
    const configure = vi.fn((p: { closeBehavior: DesktopStatus['closeBehavior'] }) => (current = { ...current, ...p }))
    const bridge = installBridge({ 'desktop:status': () => current, 'desktop:configure': configure as never, 'desktop:diagnostics': () => 'Mindeck 1.0' }, 'linux')
    render(<DesktopCard />)
    expect(await screen.findByText('Secrets are stored without encryption')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /When the window closes/ })).toHaveTextContent('Ask every time')
    choose('When the window closes while agents or terminals run', 'Keep running in the background')
    await settle()
    expect(configure).toHaveBeenCalledWith({ closeBehavior: 'background' })
    expect(screen.getByRole('combobox', { name: /When the window closes/ })).toHaveTextContent('Keep running in the background')

    fireEvent.click(screen.getByRole('button', { name: /Open logs folder/ }))
    expect(bridge.invoke).toHaveBeenCalledWith('desktop:openLogs', undefined)
    await settle()
    expect(screen.queryByRole('status')).not.toBeInTheDocument() // opened: nothing to say
    fireEvent.click(screen.getByRole('button', { name: /Copy diagnostics/ }))
    await settle()
    expect(writeText).toHaveBeenCalledWith('Mindeck 1.0')
    expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument()
  })

  it('macOS: explains the background instead; a logs folder no file manager opens is named; other failures stay quiet', async () => {
    installBridge({
      'desktop:status': () => status({ platform: 'darwin' }),
      'desktop:openLogs': () => Promise.reject(new Error('no')),
      'desktop:diagnostics': () => Promise.reject(new Error('no')),
      'desktop:configure': () => Promise.reject(new Error('no'))
    })
    render(<DesktopCard />)
    expect(await screen.findByText(/On macOS, closing the window keeps Mindeck running/)).toBeInTheDocument()
    expect(screen.queryByText('Secrets are stored without encryption')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Open logs folder/ }))
    fireEvent.click(screen.getByRole('button', { name: /Copy diagnostics/ }))
    await settle()
    expect(screen.getByRole('button', { name: /Copy diagnostics/ })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('No file manager opened the folder — the logs are in /home/me/Mindeck/logs')
  })

  it('a failing configure keeps the old choice; nothing shows outside the desktop app or without an answer', async () => {
    installBridge({ 'desktop:status': () => status(), 'desktop:configure': () => Promise.reject(new Error('no')) }, 'win32')
    const { unmount } = render(<DesktopCard />)
    await screen.findByRole('combobox', { name: /When the window closes/ })
    choose('When the window closes while agents or terminals run', 'Quit Mindeck')
    await settle()
    expect(screen.getByRole('combobox', { name: /When the window closes/ })).toHaveTextContent('Ask every time')
    unmount()
    delete (window as { mindeck?: unknown }).mindeck
    const { container } = render(<DesktopCard />)
    expect(container).toBeEmptyDOMElement()
    installBridge({ 'desktop:status': () => Promise.reject(new Error('no')) })
    const second = render(<DesktopCard />)
    await settle()
    expect(second.container).toBeEmptyDOMElement()
  })
})
