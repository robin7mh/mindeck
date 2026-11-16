import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ErrorInfo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle, choose } from './bridge'
import { AppBoundary, installErrorReporting, ModuleBoundary, reportError } from '@/components/shell/ErrorBoundary'
import { AboutSection } from '@/features/settings/components/sections/AboutSection'
import { GeneralSection } from '@/features/settings/components/sections/GeneralSection'
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

describe('Settings → the desktop app (General, About)', () => {
  const status = (over: Partial<DesktopStatus> = {}): DesktopStatus => ({
    platform: 'linux',
    logsDir: '/home/me/Mindeck/logs',
    secretsEncrypted: true,
    closeBehavior: 'ask',
    ...over
  })
  const close = () => screen.getByRole('combobox', { name: /When the window closes/ })

  it('Linux without a keyring: warns about plain-text secrets; the close behavior is a choice', async () => {
    let current = status({ secretsEncrypted: false })
    const configure = vi.fn((p: { closeBehavior: DesktopStatus['closeBehavior'] }) => (current = { ...current, ...p }))
    const bridge = installBridge({ 'desktop:status': () => current, 'desktop:configure': configure as never, 'desktop:diagnostics': () => 'Mindeck 1.0' }, 'linux')
    const { unmount } = render(<GeneralSection />)
    expect(await screen.findByText('Secrets are stored without encryption')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/Secrets are stored without encryption.*No keyring/)
    expect(close()).toHaveTextContent('Ask every time')
    expect(screen.queryByText('Always')).not.toBeInTheDocument()
    choose('When the window closes while agents or terminals run', 'Keep running in the background')
    await settle()
    expect(configure).toHaveBeenCalledWith({ closeBehavior: 'background' })
    expect(close()).toHaveTextContent('Keep running in the background')
    expect(screen.queryByRole('button', { name: /Open logs folder/ })).not.toBeInTheDocument() // under About
    unmount()

    render(<AboutSection />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument() // the warning is under General
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
    let opens = 0
    const bridge = installBridge({
      'desktop:status': () => status({ platform: 'darwin' }),
      'desktop:openLogs': () => (opens++ ? undefined : Promise.reject(new Error('no'))),
      'desktop:diagnostics': () => Promise.reject(new Error('no')),
      'desktop:configure': () => Promise.reject(new Error('no'))
    })
    const { unmount } = render(<GeneralSection />)
    const mac = await screen.findByText(/On macOS, closing the window keeps Mindeck running/)
    expect(mac.parentElement!.parentElement).toHaveTextContent('Always')
    expect(screen.queryByRole('combobox', { name: /When the window closes/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Secrets are stored without encryption')).not.toBeInTheDocument()
    unmount()

    render(<AboutSection />)
    fireEvent.click(screen.getByRole('button', { name: /Open logs folder/ }))
    fireEvent.click(screen.getByRole('button', { name: /Copy diagnostics/ }))
    await settle()
    expect(screen.getByRole('button', { name: /Copy diagnostics/ })).toBeInTheDocument()
    expect(writeText).not.toHaveBeenCalled()
    expect(bridge.invoke).toHaveBeenCalledWith('desktop:status', undefined) // where the logs are, asked only now
    expect(screen.getByRole('status')).toHaveTextContent('No file manager opened the folder — the logs are in /home/me/Mindeck/logs')
    fireEvent.click(screen.getByRole('button', { name: /Open logs folder/ }))
    await settle()
    expect(screen.queryByRole('status')).not.toBeInTheDocument() // opened this time: the note goes
  })

  it('a failing configure keeps the old choice; nothing shows outside the desktop app or without an answer', async () => {
    installBridge({ 'desktop:status': () => status(), 'desktop:configure': () => Promise.reject(new Error('no')) }, 'win32')
    const { unmount } = render(<GeneralSection />)
    await screen.findByRole('combobox', { name: /When the window closes/ })
    choose('When the window closes while agents or terminals run', 'Quit Mindeck')
    await settle()
    expect(close()).toHaveTextContent('Ask every time')
    unmount()

    // A logs folder that can't be opened, and no status to name it: quiet.
    installBridge({ 'desktop:openLogs': () => Promise.reject(new Error('no')), 'desktop:status': () => Promise.reject(new Error('no')) })
    const about = render(<AboutSection />)
    fireEvent.click(screen.getByRole('button', { name: /Open logs folder/ }))
    await settle()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    about.unmount()

    delete (window as { mindeck?: unknown }).mindeck
    const web = render(
      <>
        <GeneralSection />
        <AboutSection />
      </>
    )
    await settle()
    expect(screen.getByRole('heading', { name: 'General & appearance' })).toBeInTheDocument() // the section itself is there
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /When the window closes/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/On macOS, closing the window/)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'App behaviour' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open logs folder/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Copy diagnostics/ })).not.toBeInTheDocument()
    web.unmount()

    installBridge({ 'desktop:status': () => Promise.reject(new Error('no')) })
    render(<GeneralSection />)
    await settle()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /When the window closes/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'App behaviour' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('heading', { name: 'Appearance' }).closest('section')!).getByRole('radiogroup', { name: 'Mode' })).toBeInTheDocument()
  })
})
