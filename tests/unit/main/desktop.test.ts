import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'
import { captureConsole, catchCrashes, Logger, redact, rendererErrors } from '../../../electron/main/lib/log'
import { diagnosticsReport, type DiagnosticsInfo } from '../../../electron/main/lib/diagnostics'
import {
  CRASH_WINDOW_MS,
  DesktopLifecycle,
  FOCUS_GRACE_MS,
  lifecycleLabels,
  usingMindeck,
  type AskOptions,
  type LifecycleDeps,
  type LifecycleWindow
} from '../../../electron/main/platform/lifecycle'
import { registerDesktopIpc } from '../../../electron/ipc/desktop.ipc'
import { Router } from '../../../electron/ipc/router'
import type { AppSettings } from '@shared/types/settings'

const at = () => new Date('2026-10-15T09:30:00.000Z')

describe('log', () => {
  it('takes secrets out of every line', () => {
    expect(redact('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer ‹redacted›')
    expect(redact('sent Bearer abc.def-123 to the cloud')).toBe('sent Bearer ‹redacted› to the cloud')
    expect(redact('lease mindeck1.eyJzdWIiOiJ1In0.c2ln ok')).toBe('lease mindeck1.‹redacted› ok')
    expect(redact('key sk-ant-api03-abcdefghij and ghp_ABCDEFGHIJKL')).toBe('key sk-ant-‹redacted› and ghp_‹redacted›')
    expect(redact('GET /cb?code=1&token=s3cr3t&x=1')).toBe('GET /cb?code=1&token=‹redacted›&x=1')
    expect(redact('{"password":"hunter2","name":"x"}')).toBe('{"password":"‹redacted›","name":"x"}')
    expect(redact('api_key = abc; secret: def')).toBe('api_key = ‹redacted›; secret: ‹redacted›')
    expect(redact('nothing to hide')).toBe('nothing to hide')
  })

  it('also takes out passwords in URLs, JWTs, private keys and more token kinds', () => {
    expect(redact('connect mongodb+srv://admin:Pa55w0rd@db.example.net/app failed')).toBe('connect mongodb+srv://admin:‹redacted›@db.example.net/app failed')
    expect(redact('fatal: https://x-access-token:abc123@github.com/o/r.git')).toBe('fatal: https://x-access-token:‹redacted›@github.com/o/r.git')
    expect(redact('see https://github.com/o/r and user@host:22')).toBe('see https://github.com/o/r and user@host:22')
    expect(redact('id eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig-nature_x end')).toBe('id ‹redacted› end')
    expect(redact('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nnext')).toBe('-----BEGIN OPENSSH PRIVATE KEY-----‹redacted›\nnext')
    expect(redact('cut -----BEGIN PRIVATE KEY-----\nMIIEv')).toBe('cut -----BEGIN PRIVATE KEY-----‹redacted›')
    expect(redact('glpat-abcdefghijk npm_abcdefghijkl AIzaSyA1234567890 xoxe-123456789')).toBe('glpat-‹redacted› npm_‹redacted› AIza‹redacted› xoxe-‹redacted›')
    // Mindeck's own device tokens and pairing codes (BE-SEC-22).
    expect(redact('paired: {"token":"mindeck_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_"}')).toBe('paired: {"token":"‹redacted›"}')
    expect(redact('ws mindeck.bearer.mindeck_AbCdEfGhIjKlMnOpQrStUvWx failed')).toBe('ws mindeck.bearer.mindeck_‹redacted› failed')
    expect(redact('saved mindeck_AbCdEfGhIjKlMnOpQrStUvWx')).toBe('saved mindeck_‹redacted›')
    expect(redact('  │  Code:  K7QM-2XPA   (valid 10 minutes, one use, admin device)')).toBe('  │  Code:  ‹redacted›   (valid 10 minutes, one use, admin device)')
    expect(redact('{"code":"K7QM2XPA","name":"Phone"}')).toBe('{"code":"‹redacted›","name":"Phone"}')
    expect(redact('open https://192.168.1.5:7420/#pair=K7QM-2XPA&fp=ab12')).toBe('open https://192.168.1.5:7420/#pair=‹redacted›&fp=ab12')
    // …but not error codes, ids or names that only look a bit like them.
    for (const kept of ["code: 'not-found'", 'code=ENOENT', 'code: EADDRINUSE', 'GET /cb?code=1', 'Code: ABCD-EFGH-IJKL', 'mindeck_live', 'MINDECK_ALLOWED_HOSTS_AND_MORE_NAMES', 'code: K0QM-2XPA']) {
      expect(redact(kept), kept).toBe(kept)
    }
  })

  it('writes lines to ~/Mindeck/logs (0600), keeps recent warnings and errors, formats errors with their stack', async () => {
    const dir = join(await tempDir(), 'logs')
    const log = new Logger({ dir, now: at })
    expect(log.file).toBe(join(dir, 'mindeck.log'))
    log.info('main', 'started', { version: '1.0' })
    log.warn('main', 'slow disk')
    log.error('renderer', new Error('boom'))
    const text = await readFile(log.file, 'utf8')
    expect(text).toContain("2026-10-15T09:30:00.000Z INFO  [main] started { version: '1.0' }\n")
    expect(text).toContain('WARN  [main] slow disk\n')
    expect(text).toMatch(/ERROR \[renderer\] Error: boom\n {4}at /)
    expect((await stat(log.file)).mode & 0o777).toBe(0o600)
    expect(log.recent().map((e) => [e.level, e.source])).toEqual([
      ['warn', 'main'],
      ['error', 'renderer']
    ])
    for (let i = 0; i < 60; i += 1) log.warn('main', `w${i}`)
    expect(log.recent()).toHaveLength(50)
    expect(log.recent().at(-1)!.message).toBe('w59')
    expect(new Logger({ dir }).recent()).toEqual([]) // defaults
  })

  it('rotates by size and keeps a few old files', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'mindeck.log'), 'x'.repeat(150)) // from the last run
    const log = new Logger({ dir, maxBytes: 200, keep: 2, now: at })
    const line = 'y'.repeat(40) // ~80 bytes a line with the prefix
    for (let i = 0; i < 12; i += 1) log.info('main', line)
    const files = (await readdir(dir)).sort()
    expect(files).toEqual(['mindeck.1.log', 'mindeck.2.log', 'mindeck.log'])
    for (const f of files) expect((await stat(join(dir, f))).size).toBeLessThanOrEqual(200)
    // a single line bigger than the limit still lands
    log.info('main', 'z'.repeat(300))
    expect(await readFile(join(dir, 'mindeck.log'), 'utf8')).toContain('z'.repeat(300))
  })

  it('never throws when the log cannot be written, and tries again later', async () => {
    const root = await tempDir()
    const dir = join(root, 'logs')
    await writeFile(dir, 'a file where the folder should be')
    const log = new Logger({ dir })
    expect(() => log.error('main', 'lost')).not.toThrow()
    expect(log.recent()).toHaveLength(1) // still in memory for the diagnostics
  })

  it('echoes what nothing printed yet to stderr', async () => {
    const out = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const log = new Logger({ dir: await tempDir(), now: at })
    log.write('error', 'main', ['crash'], true)
    expect(out).toHaveBeenCalledWith('2026-10-15T09:30:00.000Z ERROR [main] crash\n')
  })

  it('copies the console into the log, and puts it back', async () => {
    const log = new Logger({ dir: await tempDir(), now: at })
    const seen: string[] = []
    const target = {
      log: (...a: unknown[]) => seen.push(`log ${a.join(' ')}`),
      info: (...a: unknown[]) => seen.push(`info ${a.join(' ')}`),
      warn: (...a: unknown[]) => seen.push(`warn ${a.join(' ')}`),
      error: (...a: unknown[]) => seen.push(`error ${a.join(' ')}`)
    }
    const original = target.warn
    const restore = captureConsole(log, target)
    target.log('[data] copied')
    target.info('hello')
    target.warn('[agents] could not save sessions:', 'EACCES')
    target.error('[browser] token=abc failed')
    expect(seen).toEqual(['log [data] copied', 'info hello', 'warn [agents] could not save sessions: EACCES', 'error [browser] token=abc failed'])
    const text = await readFile(log.file, 'utf8')
    expect(text).toContain('INFO  [main] [data] copied')
    expect(text).toContain('WARN  [main] [agents] could not save sessions: EACCES')
    expect(text).toContain('ERROR [main] [browser] token=‹redacted› failed')
    restore()
    expect(target.warn).toBe(original)
  })

  it('logs stray exceptions and rejections instead of ending the main process', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const log = new Logger({ dir: await tempDir(), now: at })
    const proc = new EventEmitter()
    const off = catchCrashes(log, proc as unknown as NodeJS.Process)
    proc.emit('uncaughtException', new Error('kaputt'))
    proc.emit('unhandledRejection', 'nope')
    expect(log.recent().map((e) => e.message)).toEqual([expect.stringContaining('Uncaught exception: Error: kaputt'), 'Unhandled promise rejection: nope'])
    off()
    expect(proc.listenerCount('uncaughtException')).toBe(0)
    expect(proc.listenerCount('unhandledRejection')).toBe(0)
    const real = catchCrashes(log) // the default: this process
    real()
  })

  it('logs renderer reports — at most a few a minute', async () => {
    let now = 0
    const log = new Logger({ dir: await tempDir(), now: at })
    const report = rendererErrors(log, { limit: 2, now: () => now })
    report({ kind: 'module', module: 'editor', message: 'x is undefined', stack: 'TypeError: x\n  at Editor', componentStack: '\n  in EditorView' })
    report({ kind: 'rejection', message: 'fetch failed' })
    report({ kind: 'error', message: 'dropped' })
    report({ kind: 'error', message: 'dropped too' })
    expect(log.recent().map((e) => [e.source, e.message])).toEqual([
      ['renderer:editor', 'module: x is undefined\nTypeError: x\n  at Editor\nComponent stack:\n  in EditorView'],
      ['renderer', 'rejection: fetch failed']
    ])
    now = 61_000
    report({ kind: 'app', message: 'later' })
    expect(log.recent().slice(-2).map((e) => e.message)).toEqual(['2 more error report(s) were dropped', 'app: later'])
    now = 130_000 // a quiet minute: nothing to say about drops
    report({ kind: 'app', message: 'again' })
    expect(log.recent().at(-1)!.message).toBe('app: again')
    rendererErrors(log)({ kind: 'app', message: 'defaults' })
  })
})

describe('diagnostics', () => {
  const info: DiagnosticsInfo = {
    version: '1.2.3',
    platform: 'darwin',
    arch: 'arm64',
    os: 'Darwin 24.1.0',
    versions: { electron: '44.7.2', chrome: '140.0', node: '24.1.0' },
    locale: 'de-DE',
    packaged: true,
    secretsEncrypted: true,
    license: 'active',
    running: { agents: 2, terminals: 1 },
    uptime: 600,
    logsDir: '/Users/robin/Mindeck/logs',
    home: '/Users/robin'
  }

  it('a report for bug tickets: versions, OS, state, latest errors — without the user name or secrets', () => {
    const text = diagnosticsReport(info, [
      { time: 't1', level: 'error', source: 'main', message: 'open /Users/robin/x failed, Bearer abc' }
    ])
    expect(text).toContain('Mindeck 1.2.3\n')
    expect(text).toContain('OS: darwin arm64 · Darwin 24.1.0')
    expect(text).toContain('Electron 44.7.2 · Chromium 140.0 · Node 24.1.0')
    expect(text).toContain('Secrets: encrypted by the OS keychain')
    expect(text).toContain('License: active')
    expect(text).toContain('Running: 2 agent session(s), 1 terminal(s)')
    expect(text).toContain('Uptime: 10 min')
    expect(text).toContain('Logs: ~/Mindeck/logs')
    expect(text).toContain('t1 ERROR [main] open ~/x failed, Bearer ‹redacted›')
    expect(text).not.toContain('robin')
  })

  it('says so when there is nothing to report, and copes with missing facts', () => {
    const text = diagnosticsReport({ ...info, packaged: false, secretsEncrypted: false, versions: {}, home: '' }, [])
    expect(text).toContain('Mindeck 1.2.3 (dev)')
    expect(text).toContain('Electron ? · Chromium ? · Node ?')
    expect(text).toContain('Secrets: plain text (no keychain available)')
    expect(text).toContain('No warnings or errors since the start.')
    expect(text).toContain('Logs: /Users/robin/Mindeck/logs')
  })
})

// --- the window's lifecycle ----------------------------------------------------------

function fakeWindow(over: Partial<{ visible: boolean; minimized: boolean; focused: boolean; destroyed: boolean }> = {}) {
  const s = { visible: true, minimized: false, focused: true, destroyed: false, ...over }
  const win = {
    s,
    hide: vi.fn(() => (s.visible = false)),
    show: vi.fn(() => (s.visible = true)),
    focus: vi.fn(),
    restore: vi.fn(() => (s.minimized = false)),
    isVisible: () => s.visible,
    isMinimized: () => s.minimized,
    isFocused: () => s.focused,
    isDestroyed: () => s.destroyed
  }
  return win satisfies LifecycleWindow
}

function lifecycle(over: Partial<LifecycleDeps> & { answers?: { response: number; checkboxChecked?: boolean }[] } = {}) {
  const asked: AskOptions[] = []
  const answers = over.answers ?? []
  const tray = { destroy: vi.fn() }
  const state = { running: { agents: 1, terminals: 0 }, behavior: 'ask' as 'ask' | 'background' | 'quit', now: 1_000_000 }
  const deps: LifecycleDeps = {
    platform: 'linux',
    running: () => state.running,
    closeBehavior: () => state.behavior,
    remember: vi.fn(async (b) => void (state.behavior = b)),
    ask: vi.fn(async (o: AskOptions) => {
      asked.push(o)
      const a = answers.shift() ?? { response: o.cancelId }
      return { response: a.response, checkboxChecked: !!a.checkboxChecked }
    }),
    locale: () => 'en',
    createTray: vi.fn(() => tray),
    quit: vi.fn(),
    reload: vi.fn(),
    now: () => state.now,
    ...over
  }
  return { l: new DesktopLifecycle(deps), deps, asked, tray, state }
}

const event = () => ({ preventDefault: vi.fn() })
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('lifecycle labels', () => {
  it('counts what runs, in English and German', () => {
    const en = lifecycleLabels('en')
    expect(en.running({ agents: 1, terminals: 0 })).toBe('1 agent session is still running')
    expect(en.running({ agents: 2, terminals: 1 })).toBe('2 agent sessions and 1 terminal are still running')
    expect(en.running({ agents: 0, terminals: 3 })).toBe('3 terminals are still running')
    const de = lifecycleLabels('de')
    expect(de.running({ agents: 1, terminals: 0 })).toBe('1 Agent-Sitzung läuft noch')
    expect(de.running({ agents: 2, terminals: 1 })).toBe('2 Agent-Sitzungen und 1 Terminal laufen noch')
    expect(de.running({ agents: 0, terminals: 2 })).toBe('2 Terminals laufen noch')
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('using Mindeck (the trial clock)', () => {
  it('counts only while the window is on screen, focused (or just was) and the user is here', () => {
    const now = 10_000_000
    expect(usingMindeck(null, 0, now, false)).toBe(false)
    expect(usingMindeck(fakeWindow(), 0, now, false)).toBe(true)
    expect(usingMindeck(fakeWindow(), 0, now, true)).toBe(false) // idle
    expect(usingMindeck(fakeWindow({ visible: false }), 0, now, false)).toBe(false) // in the background
    expect(usingMindeck(fakeWindow({ minimized: true }), 0, now, false)).toBe(false)
    expect(usingMindeck(fakeWindow({ destroyed: true }), 0, now, false)).toBe(false)
    expect(usingMindeck(fakeWindow({ focused: false }), now - FOCUS_GRACE_MS, now, false)).toBe(true) // switched away a moment ago
    expect(usingMindeck(fakeWindow({ focused: false }), now - FOCUS_GRACE_MS - 1, now, false)).toBe(false)
  })
})

describe('DesktopLifecycle', () => {
  it('lets the window close when nothing runs — and a real quit go through', () => {
    const t = lifecycle()
    t.state.running = { agents: 0, terminals: 0 }
    const win = fakeWindow()
    const e = event()
    t.l.onClose(win, e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    const q = event()
    t.l.onBeforeQuit(q)
    expect(q.preventDefault).not.toHaveBeenCalled()
    expect(t.l.isQuitting).toBe(true)
    // quitting: the window closes without a word
    t.state.running = { agents: 3, terminals: 0 }
    const c = event()
    t.l.onClose(win, c)
    expect(c.preventDefault).not.toHaveBeenCalled()
    t.l.onBeforeQuit(event())
    expect(t.deps.ask).not.toHaveBeenCalled()
  })

  it('macOS: closing the window keeps Mindeck running in the background; the Dock brings it back', () => {
    const t = lifecycle({ platform: 'darwin' })
    const win = fakeWindow()
    const e = event()
    t.l.onClose(win, e)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(win.hide).toHaveBeenCalled()
    expect(t.deps.createTray).not.toHaveBeenCalled() // the Dock icon is there
    expect(t.deps.ask).not.toHaveBeenCalled()
    win.s.minimized = true
    t.l.reveal(win)
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    t.l.reveal(fakeWindow({ destroyed: true })) // a closed window: nothing to show
  })

  it('Windows/Linux: asks — keep running with a tray icon (remembered if wished), quit, or cancel', async () => {
    const t = lifecycle({ answers: [{ response: 2 }, { response: 0, checkboxChecked: true }] })
    const win = fakeWindow()
    const e = event()
    t.l.onClose(win, e)
    expect(e.preventDefault).toHaveBeenCalled()
    await flush()
    expect(t.asked[0]).toMatchObject({
      message: '1 agent session is still running',
      buttons: ['Keep running in background', 'Quit Mindeck', 'Cancel'],
      cancelId: 2,
      checkboxLabel: expect.stringContaining('Remember')
    })
    expect(win.hide).not.toHaveBeenCalled() // cancelled

    t.l.onClose(win, event())
    t.l.onClose(win, event()) // a second click while the dialog is open: one dialog
    await flush()
    expect(t.deps.ask).toHaveBeenCalledTimes(2)
    expect(win.hide).toHaveBeenCalled()
    expect(t.deps.remember).toHaveBeenCalledWith('background')
    expect(t.deps.createTray).toHaveBeenCalledTimes(1)
    const [labels, actions] = vi.mocked(t.deps.createTray).mock.calls[0]
    expect(labels.show).toBe('Show Mindeck')

    // remembered: the next close goes to the background without asking, the tray stays one
    t.l.onClose(win, event())
    expect(t.deps.ask).toHaveBeenCalledTimes(2)
    expect(t.deps.createTray).toHaveBeenCalledTimes(1)

    // the tray brings the window back (and goes), or quits (which asks — see onBeforeQuit)
    actions.show()
    expect(win.show).toHaveBeenCalled()
    expect(t.tray.destroy).toHaveBeenCalled()
    actions.quit()
    expect(t.deps.quit).toHaveBeenCalled()
  })

  it('Windows/Linux: "Quit" from the dialog quits without asking again; a remembered "quit" quits at once', async () => {
    const t = lifecycle({ answers: [{ response: 1 }] })
    t.l.onClose(fakeWindow(), event())
    await flush()
    expect(t.deps.quit).toHaveBeenCalledTimes(1)
    expect(t.deps.remember).not.toHaveBeenCalled()
    expect(t.l.isQuitting).toBe(true)

    const r = lifecycle()
    r.state.behavior = 'quit'
    r.l.onClose(fakeWindow(), event())
    expect(r.deps.quit).toHaveBeenCalled()
    expect(r.deps.ask).not.toHaveBeenCalled()
  })

  it('a failing settings write does not stop the chosen action', async () => {
    const t = lifecycle({ answers: [{ response: 0, checkboxChecked: true }], remember: vi.fn(async () => Promise.reject(new Error('disk full'))) })
    const win = fakeWindow()
    t.l.onClose(win, event())
    await flush()
    expect(win.hide).toHaveBeenCalled()
  })

  it('quitting while work runs asks first (once); the editor keeping its window cancels the quit', async () => {
    const t = lifecycle({ answers: [{ response: 1 }, { response: 0 }] })
    t.state.running = { agents: 0, terminals: 2 }
    const q = event()
    t.l.onBeforeQuit(q)
    t.l.onBeforeQuit(event()) // ⌘Q twice: one dialog
    expect(q.preventDefault).toHaveBeenCalled()
    await flush()
    expect(t.asked[0]).toMatchObject({ message: '2 terminals are still running', buttons: ['Quit Mindeck', 'Cancel'] })
    expect(t.deps.quit).not.toHaveBeenCalled()
    t.l.onBeforeQuit(event())
    await flush()
    expect(t.deps.quit).toHaveBeenCalledTimes(1)
    expect(t.l.isQuitting).toBe(true)
    t.l.cancelQuit()
    expect(t.l.isQuitting).toBe(false)
  })

  it('reloads a crashed window; a second crash within a minute asks — reload or quit', async () => {
    const t = lifecycle({ answers: [{ response: 0 }, { response: 1 }] })
    await t.l.onRendererGone('clean-exit')
    expect(t.deps.reload).not.toHaveBeenCalled()
    await t.l.onRendererGone('crashed')
    expect(t.deps.reload).toHaveBeenCalledTimes(1)
    t.state.now += CRASH_WINDOW_MS + 1
    await t.l.onRendererGone('oom') // the first one is long ago: just reload
    expect(t.deps.reload).toHaveBeenCalledTimes(2)
    t.state.now += 1000
    await t.l.onRendererGone('crashed')
    expect(t.asked[0]).toMatchObject({ type: 'error', message: 'Mindeck’s window crashed again', buttons: ['Reload', 'Quit Mindeck'] })
    expect(t.deps.reload).toHaveBeenCalledTimes(3)
    await t.l.onRendererGone('crashed') // counting starts over after a reload by choice
    expect(t.deps.reload).toHaveBeenCalledTimes(4)
    await t.l.onRendererGone('crashed')
    expect(t.deps.quit).toHaveBeenCalled()
    await t.l.onRendererGone('crashed') // quitting: leave it
    expect(t.deps.reload).toHaveBeenCalledTimes(4)
  })

  it('a hanging window: wait or reload; the dialog goes when it recovers', async () => {
    let resolve!: (r: { response: number; checkboxChecked: boolean }) => void
    const ask = vi.fn((o: AskOptions) => new Promise<{ response: number; checkboxChecked: boolean }>((r) => (resolve = r)).then((a) => (o.signal?.aborted ? { ...a, response: 0 } : a)))
    const t = lifecycle({ ask })
    const first = t.l.onUnresponsive()
    void t.l.onUnresponsive() // still the same hang: one dialog
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toMatchObject({ message: 'Mindeck’s window is not responding', buttons: ['Wait', 'Reload'] })
    resolve({ response: 1, checkboxChecked: false })
    await first
    expect(t.deps.reload).toHaveBeenCalledTimes(1)

    const second = t.l.onUnresponsive()
    t.l.onResponsive() // it recovered: the dialog closes, nothing reloads
    expect(ask.mock.calls[1][0].signal!.aborted).toBe(true)
    resolve({ response: 1, checkboxChecked: false })
    await second
    expect(t.deps.reload).toHaveBeenCalledTimes(1)
    t.l.onResponsive() // no dialog open: nothing to do

    const third = t.l.onUnresponsive()
    resolve({ response: 0, checkboxChecked: false }) // wait
    await third
    expect(t.deps.reload).toHaveBeenCalledTimes(1)
    t.l.quitNow()
    await t.l.onUnresponsive() // quitting: no dialog
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it('uses the UI language and the system clock by default', () => {
    const t = lifecycle({ locale: () => 'de', now: undefined })
    t.l.onClose(fakeWindow(), event())
    expect(vi.mocked(t.deps.ask).mock.calls[0][0].buttons).toEqual(['Im Hintergrund weiterlaufen', 'Mindeck beenden', 'Abbrechen'])
  })
})

describe('desktop:* channels', () => {
  async function setup(over: { encrypted?: boolean; openError?: string } = {}) {
    const dir = join(await tempDir(), 'logs')
    const logger = new Logger({ dir, now: at })
    let settings: AppSettings = {}
    const router = new Router({ remoteTerminal: () => false })
    const openPath = vi.fn(async () => over.openError ?? '')
    registerDesktopIpc(router, {
      logger,
      settings: { get: () => settings, update: async (p) => (settings = { ...settings, ...p }) },
      secretsEncrypted: over.encrypted ?? true,
      openPath,
      diagnostics: () => ({
        version: '1.0.0',
        platform: 'linux',
        arch: 'x64',
        os: 'Linux 6.1',
        versions: {},
        locale: 'en-US',
        packaged: true,
        license: 'active',
        running: { agents: 0, terminals: 0 },
        uptime: 60,
        home: '/home/me'
      })
    })
    const call = (channel: string, payload?: unknown, transport: 'ipc' | 'remote' = 'ipc') => router.dispatch(channel, payload, { transport })
    return { call, dir, logger, openPath, settings: () => settings }
  }

  it('status and the close behavior (kept in settings)', async () => {
    const t = await setup({ encrypted: false })
    expect(await t.call('desktop:status')).toEqual({
      ok: true,
      data: { platform: process.platform, logsDir: t.dir, secretsEncrypted: false, closeBehavior: 'ask' }
    })
    expect(await t.call('desktop:configure', { closeBehavior: 'background' })).toMatchObject({ ok: true, data: { closeBehavior: 'background' } })
    expect(t.settings().closeBehavior).toBe('background')
    expect(await t.call('desktop:configure', { closeBehavior: 'never' })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    // the desktop window only
    expect(await t.call('desktop:status', undefined, 'remote')).toMatchObject({ ok: false, error: { code: 'desktop-only' } })
  })

  it('opens the logs folder (creating it), and says when that failed', async () => {
    const t = await setup()
    expect(await t.call('desktop:openLogs')).toEqual({ ok: true, data: undefined })
    expect(t.openPath).toHaveBeenCalledWith(t.dir)
    expect((await stat(t.dir)).isDirectory()).toBe(true)
    const bad = await setup({ openError: 'No application' })
    expect(await bad.call('desktop:openLogs')).toEqual({ ok: false, error: { code: 'open-failed', message: 'No application' } })
  })

  it('diagnostics carry the latest errors, including what the renderer reported', async () => {
    const t = await setup()
    expect(await t.call('desktop:reportError', { kind: 'module', module: 'files', message: 'cannot read x', stack: 'at Files' })).toEqual({ ok: true, data: undefined })
    expect(await t.call('desktop:reportError', { kind: 'module', message: 'x'.repeat(3000) })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const res = (await t.call('desktop:diagnostics')) as { ok: true; data: string }
    expect(res.data).toContain('Mindeck 1.0.0')
    expect(res.data).toContain(`Logs: ${t.dir}`)
    expect(res.data).toContain('[renderer:files] module: cannot read x\nat Files')
    await mkdir(t.dir, { recursive: true })
    expect(await readFile(t.logger.file, 'utf8')).toContain('[renderer:files]')
  })
})
