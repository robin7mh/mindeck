import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBridge, settle } from './bridge'

import { cn } from '@/lib/cn'
import { clamp, formatDate, formatTime, formatUptime, pad2 } from '@/lib/format'
import { ACCENTS, applyAppearance, DEFAULT_APPEARANCE, loadAppearance, resolveTheme, startAppearance, surfaceTokens, useAppearance } from '@/lib/theme'
import { useClock } from '@/hooks/useClock'
import { useBoot } from '@/hooks/useBoot'
import { NAV_ITEMS } from '@/data/navigation'
import { BOOT_LINES } from '@/data/bootLines'
import { errorMessage, ipc, IpcError, onEvent, setTransport } from '@shared/ipc/client'
import { useLocale } from '@/lib/i18n'
import { blameHover } from '@/features/editor/blame'
import { BROWSER_EVENTS, CHANNEL_ACCESS, DESKTOP_EVENTS, IPC_CHANNELS, IPC_EVENTS, TERMINAL_EVENTS } from '@shared/ipc/contract'
import { DEFAULT_GRAPH_STYLE, GRAPH_COLORS } from '@shared/types/memory'
import { EVENT_CATALOG } from '@shared/types/events'
import { renderMarkdown } from '@/features/memory/markdown'
import { themeFromTokens } from '@/features/terminal/theme'

afterEach(() => {
  vi.useRealTimers()
  document.documentElement.style.cssText = ''
})

describe('lib', () => {
  it('cn joins truthy class names', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b')
  })

  it('format helpers', () => {
    const d = new Date(2026, 9, 1, 9, 5, 3)
    expect(pad2(7)).toBe('07')
    expect(formatTime(d)).toBe('09:05:03')
    expect(formatDate(d)).toBe('THU 01 OCT 2026') // jsdom locale: en-US
    expect(formatUptime(3725)).toBe('01:02:05')
    expect(clamp(150)).toBe(100)
    expect(clamp(-5)).toBe(0)
    expect(clamp(5, 10, 20)).toBe(10)
  })

  it('appearance: saved choice, the old dark/light choice, defaults for anything unknown; storage errors never throw', () => {
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)
    localStorage.setItem('mindeck.theme', 'light')
    expect(loadAppearance()).toEqual({ ...DEFAULT_APPEARANCE, mode: 'light' })
    localStorage.setItem('mindeck.theme', 'bogus')
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)

    const saved = { mode: 'dark', accent: 'pink', surface: 'graphite' }
    localStorage.setItem('mindeck.appearance', JSON.stringify(saved))
    expect(loadAppearance()).toEqual(saved)
    // Unknown values (and fields of older versions) fall back field by field.
    localStorage.setItem('mindeck.appearance', JSON.stringify({ mode: 'neon', accent: 'violet', surface: 'midnight', effects: 'off' }))
    expect(loadAppearance()).toEqual({ ...DEFAULT_APPEARANCE, accent: 'violet' })
    localStorage.setItem('mindeck.appearance', 'null')
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)
    localStorage.setItem('mindeck.appearance', '{broken')
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)

    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)
    get.mockRestore()
  })

  it('applyAppearance: system follows the OS; the accent per theme; dark backgrounds only in dark', () => {
    const root = document.documentElement
    const css = (name: string) => root.style.getPropertyValue(name)
    expect(resolveTheme('system')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')

    expect(applyAppearance({ mode: 'dark', accent: 'green', surface: 'black' })).toBe('dark')
    expect({ ...root.dataset }).toEqual({ theme: 'dark', accent: 'green', surface: 'black' })
    expect([css('--accent-cyan'), css('--accent-2'), css('--accent-3')]).toEqual(ACCENTS.green.dark)
    expect(css('--bg-void')).toBe('0 0 0')

    // Cyber: surfaces, lines and text in the accent's hue.
    applyAppearance({ mode: 'dark', accent: 'green', surface: 'cyber' })
    expect([css('--bg-void'), css('--border-hud')]).toEqual(['4 11 8', '42 84 64'])

    ;(globalThis as { matchMediaMatches: Record<string, boolean> }).matchMediaMatches['(prefers-color-scheme: light)'] = true
    expect(applyAppearance({ mode: 'system', accent: 'green', surface: 'graphite' })).toBe('light')
    expect(css('--accent-cyan')).toBe(ACCENTS.green.light[0])
    expect(css('--bg-void')).toBe('') // light keeps its own surfaces
  })

  it('the cyber background in cyan is index.css; mono turns it grey; black and graphite stay neutral', () => {
    expect(surfaceTokens('cyber', 'cyan')).toMatchObject({ '--bg-void': '4 7 11', '--bg-panel': '12 18 26', '--border-hud': '42 60 84' })
    expect(surfaceTokens('cyber', 'mono')['--bg-void']).toBe('7 7 7')
    expect(surfaceTokens('graphite', 'pink')).toEqual(surfaceTokens('graphite', 'green'))
  })

  it('useAppearance updates, toggles, resets and remembers; on system it follows OS changes', () => {
    const LIGHT = '(prefers-color-scheme: light)'
    const os = (globalThis as { matchMediaMatches: Record<string, boolean> }).matchMediaMatches
    const real = window.matchMedia
    let osChanged = () => {}
    window.matchMedia = ((q: string) => ({
      ...real(q),
      addEventListener: (_: string, cb: () => void) => {
        osChanged = cb
      }
    })) as unknown as typeof window.matchMedia
    const s = () => useAppearance.getState()

    useAppearance.setState({ appearance: DEFAULT_APPEARANCE })
    startAppearance()
    expect(s().theme).toBe('dark')
    os[LIGHT] = true
    osChanged()
    expect([s().theme, document.documentElement.dataset.theme]).toEqual(['light', 'light'])

    s().update({ accent: 'violet' })
    expect(JSON.parse(localStorage.getItem('mindeck.appearance')!)).toEqual({ ...DEFAULT_APPEARANCE, accent: 'violet' })
    s().update({ mode: 'dark' }) // a fixed choice
    expect([s().appearance.mode, s().theme]).toEqual(['dark', 'dark'])
    osChanged() // fixed: the OS no longer decides
    expect(document.documentElement.dataset.theme).toBe('dark')

    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => s().reset()).not.toThrow()
    expect(s().appearance).toEqual(DEFAULT_APPEARANCE)
    set.mockRestore()
    window.matchMedia = real
  })
})

describe('platform', () => {
  it('detects macOS from the bridge and follows fullscreen changes', async () => {
    const bridge = installBridge({}, 'darwin')
    bridge.isFullScreen.mockResolvedValueOnce(true)
    vi.resetModules()
    const platform = await import('@/lib/platform')
    expect(platform.isMac).toBe(true)
    const { result, unmount } = renderHook(() => platform.useFullScreen())
    await act(settle)
    expect(result.current).toBe(true)
    act(() => bridge.setFullScreen(false))
    expect(result.current).toBe(false)
    unmount()

    bridge.isFullScreen.mockRejectedValueOnce(new Error('x'))
    renderHook(() => platform.useFullScreen())
    await act(settle)
  })

  it('is not macOS (and fullscreen stays false) without a bridge or on Windows', async () => {
    vi.resetModules()
    const noBridge = await import('@/lib/platform')
    expect(noBridge.isMac).toBe(false)
    const { result } = renderHook(() => noBridge.useFullScreen())
    expect(result.current).toBe(false)

    installBridge({}, 'win32')
    vi.resetModules()
    expect((await import('@/lib/platform')).isMac).toBe(false)
  })
})

describe('hooks', () => {
  it('useClock ticks every second and cleans up', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 0))
    const { result, unmount } = renderHook(() => useClock())
    expect(result.current.getSeconds()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.getSeconds()).toBe(1)
    unmount()
  })

  it('useBoot finishes after the total time, or immediately on skip', () => {
    vi.useFakeTimers()
    const a = renderHook(() => useBoot(500))
    expect(a.result.current.booted).toBe(false)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(a.result.current.booted).toBe(true)

    const b = renderHook(() => useBoot(10_000))
    act(() => b.result.current.skip())
    expect(b.result.current.booted).toBe(true)
    b.unmount()
  })
})

describe('data & shared constants', () => {
  it('navigation and boot lines', () => {
    expect(NAV_ITEMS.map((n) => n.id)).toEqual(['core', 'editor', 'terminal', 'browser', 'files', 'projects', 'memory', 'agents', 'system', 'logs', 'settings'])
    expect(BOOT_LINES.length).toBeGreaterThan(3)
  })

  it('contract allowlists, graph palette and event catalog', async () => {
    expect(IPC_CHANNELS).toContain('memory:link')
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length)
    expect(IPC_EVENTS).toEqual([
      'system:tick',
      'context:progress',
      'memory:changed',
      'terminal:data',
      'terminal:exit',
      'terminal:info',
      'terminal:reveal',
      'ai:delta',
      'ai:inlineDelta',
      'ai:message',
      'ai:conversationsChanged',
      'permission:request',
      'permission:resolved',
      'events:event',
      'agents:changed',
      'agents:message',
      'cloud:status',
      'update:status',
      'debug:session',
      'debug:output',
      'lsp:diagnostics',
      'tools:progress',
      'liveServer:changed',
      'sftp:progress',
      'remote:changed',
      'tests:changed',
      'search:progress',
      'notebook:event',
      'browser:state',
      'browser:find',
      'browser:command',
      'browser:reveal',
      'browser:bookmarks',
      'browser:import',
      'finder:progress'
    ])
    // The browser's tabs reach paired devices only while the desktop shares them, Files only with remote shells;
    // the desktop's own browser UI, the host's apps and its clipboard never.
    expect(DESKTOP_EVENTS).toEqual(['browser:find', 'browser:command', 'browser:reveal', 'browser:import', 'remote:changed'])
    expect(BROWSER_EVENTS).toEqual(['browser:state', 'browser:bookmarks'])
    expect(TERMINAL_EVENTS).toContain('finder:progress')
    const shared = (prefix: string) => IPC_CHANNELS.filter((c) => c.startsWith(prefix) && CHANNEL_ACCESS[c] !== 'desktop')
    expect(shared('browser:').every((c) => CHANNEL_ACCESS[c] === 'browser')).toBe(true)
    expect(shared('browser:')).toEqual(expect.arrayContaining(['browser:state', 'browser:capture', 'browser:input']))
    expect(shared('browser:')).not.toEqual(expect.arrayContaining(['browser:extensions']))
    expect(shared('finder:').every((c) => CHANNEL_ACCESS[c] === 'terminal')).toBe(true)
    for (const channel of ['finder:open', 'finder:reveal', 'finder:clipboardRead', 'finder:clipboardWrite', 'finder:privacySettings', 'browser:freeze', 'browser:extensions'] as const) expect(CHANNEL_ACCESS[channel]).toBe('desktop')
    expect(GRAPH_COLORS).toHaveLength(8)
    expect(DEFAULT_GRAPH_STYLE).toEqual({ mode: 'colorful', color: 'cyan' })
    expect(EVENT_CATALOG['app.started']).toBe('activity')
    // type-only modules: loading them proves they compile to side-effect-free modules
    for (const mod of await Promise.all([
      import('@shared/types/context'),
      import('@shared/types/agents'),
      import('@shared/types/entity'),
      import('@shared/types/files'),
      import('@shared/types/project'),
      import('@shared/types/settings'),
      import('@shared/types/system'),
      import('@/types')
    ])) {
      expect(Object.keys(mod)).toEqual([])
    }
    // the Terminal's types come with its defaults and bounds
    expect(Object.keys(await import('@shared/types/terminal')).sort()).toEqual(['DEFAULT_TERMINAL_SETTINGS', 'TERMINAL_CURSORS', 'TERMINAL_LIMITS'])
  })
})

describe('ipc client', () => {
  it('unwraps ok results and throws IpcError on failures', async () => {
    installBridge({ 'projects:list': () => [1], 'projects:remove': () => Promise.reject(Object.assign(new Error('gone'), { code: 'not-found' })) })
    expect(await ipc('projects:list')).toEqual([1])
    const err = await ipc('projects:remove', { id: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(IpcError)
    expect(err).toMatchObject({ name: 'IpcError', code: 'not-found', message: 'gone' })
  })

  it('fails cleanly without a bridge; events no-op', async () => {
    await expect(ipc('projects:list')).rejects.toMatchObject({ code: 'no-bridge' })
    expect(onEvent('system:tick', () => {})()).toBeUndefined()
  })

  it('subscribes to push events', () => {
    const bridge = installBridge()
    const cb = vi.fn()
    const off = onEvent('system:tick', cb)
    bridge.emit('system:tick', { ts: 1 })
    expect(cb).toHaveBeenCalledWith({ ts: 1 })
    off()
    expect(bridge.listenerCount('system:tick')).toBe(0)
  })

  it('errorMessage', () => {
    expect(errorMessage(new IpcError('c', 'ipc'))).toBe('ipc')
    expect(errorMessage(new Error('plain'))).toBe('plain')
    expect(errorMessage('str')).toBe('str')
  })

  it('words the client\'s own failures in the UI language; the core\'s messages stay as they come', async () => {
    useLocale.getState().setLocale('de')
    expect(errorMessage(Object.assign(new Error('Mindeck core unreachable: Failed to fetch'), { code: 'offline' }))).toBe('Der Mindeck-Core ist nicht erreichbar.')
    expect(errorMessage(Object.assign(new Error('Unexpected response (502)'), { code: 'bad-response' }))).toBe('Unerwartete Antwort vom Mindeck-Core (502)')
    expect(errorMessage(new IpcError('bad-response', 'odd'))).toBe('Unerwartete Antwort vom Mindeck-Core (?)')
    expect(errorMessage(new IpcError('not-found', 'Note not found'))).toBe('Note not found')
    expect(errorMessage(new IpcError('rate-limited', 'Too many ai calls from this device — try again in 42 s'))).toBe('Zu viele Anfragen — bitte versuch es in 42 s noch einmal.')
    expect(errorMessage(new IpcError('rate-limited', 'Too many failed pairing attempts — try again later'))).toBe('Zu viele Anfragen — bitte versuch es gleich noch einmal.')
    expect(errorMessage(Object.assign(new Error('x'), { code: 7 }))).toBe('x')
    await expect(ipc('projects:list')).rejects.toThrow('Nicht mit einem Mindeck-Core verbunden')
    setTransport({ kind: 'remote', invoke: async () => ({ ok: false, error: { code: 'offline', message: 'Mindeck core unreachable: x' } }), on: () => () => {} })
    await expect(ipc('projects:list')).rejects.toMatchObject({ code: 'offline', message: 'Der Mindeck-Core ist nicht erreichbar.' })
    // Dates follow the app's language, not the system's.
    const date = '2026-10-17T09:00:00Z'
    expect(blameHover({ hash: 'abcdef1234567', summary: 's', author: 'a', email: 'e', date } as never)).toContain(new Date(date).toLocaleString('de-DE'))
    useLocale.getState().setLocale('en')
    await expect(ipc('projects:list')).rejects.toThrow('The Mindeck core is not reachable.')
    expect(errorMessage(new IpcError('rate-limited', 'Too many github calls from this device — try again in 3 s'))).toBe('Too many requests — please try again in 3 s.')
    expect(errorMessage(new IpcError('rate-limited', 'x'))).toBe('Too many requests — please try again in a moment.')
    setTransport(null)
  })
})

describe('markdown', () => {
  it('renders wikilinks (alias, anchor, unresolved), tags, and sanitizes', () => {
    const html = renderMarkdown(
      'See [[A]] [[B|Bee]] [[C#Part]] [[Missing]] ![[Embed]] [[]] #tag #123 C#sharp\n\n<a class="wikilink">raw</a><script>x()</script><img src=x onerror=alert(1)>',
      { A: 'A.md', B: 'B.md', C: 'C.md', Embed: 'E.md' }
    )
    expect(html).toContain('<a class="wikilink" href="#" data-target="A">A</a>')
    expect(html).toContain('data-target="B">Bee</a>')
    expect(html).toContain('data-target="C">C › Part</a>')
    expect(html).toContain('class="wikilink unresolved" href="#" data-target="Missing"')
    expect(html).toContain('<a class="wikilink unresolved">raw</a>')
    expect(html).toContain('[[]]')
    expect(html).toContain('<span class="md-tag">#tag</span>')
    expect(html).not.toContain('#123</span>')
    expect(html).not.toContain('#sharp</span>')
    expect(html).not.toMatch(/<script|onerror/)
  })

  it('shows pictures only from the vault: embeds and sources move to data-embed, data: stays', () => {
    const html = renderMarkdown('![[bild.png]] ![[w.jpg|300]] ![[Note]] ![alt](attachments/a%20b.png) ![remote](https://x.dev/p.png) ![inline](data:image/png;base64,AA)', {})
    expect(html).toContain('<img class="embed" data-embed="bild.png" alt="bild.png">')
    expect(html).toContain('<img class="embed" data-embed="w.jpg" alt="w.jpg" width="300">')
    expect(html).toContain('data-target="Note">Note</a>')
    expect(html).toContain('<img alt="alt" data-embed="attachments/a%20b.png">')
    expect(html).toContain('<img alt="remote" data-embed="https://x.dev/p.png">')
    expect(html).toContain('<img src="data:image/png;base64,AA" alt="inline">')
  })

  it('escapes HTML inside link labels and tags', () => {
    const html = renderMarkdown('[[a&b|<x>"]]', {})
    expect(html).toContain('data-target="a&amp;b"')
    expect(html).toContain('&lt;x&gt;"')
  })
})

describe('terminal theme', () => {
  it('maps CSS tokens to xterm colors with fallbacks', () => {
    document.documentElement.style.setProperty('--accent-cyan', '1 2 3')
    document.documentElement.style.setProperty('--text-primary', 'nope nope nope')
    const t = themeFromTokens()
    expect(t.cyan).toBe('#010203')
    expect(t.selectionBackground).toBe('#01020340')
    expect(t.foreground).toBe('#e2ecf7') // NaN → fallback
    expect(t.blue).toBe('#4a84ff') // unset → fallback
  })
})

describe('entry points', () => {
  it('main.tsx applies the theme before rendering <App/> into #root', async () => {
    const render = vi.fn()
    vi.doMock('react-dom/client', () => ({ default: { createRoot: vi.fn(() => ({ render })) } }))
    vi.doMock('@/App', () => ({ default: () => null }))
    document.body.innerHTML = '<div id="root"></div>'
    localStorage.setItem('mindeck.theme', 'light')
    vi.resetModules()
    await import('@/main')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(render).toHaveBeenCalledTimes(1)
    vi.doUnmock('react-dom/client')
    vi.doUnmock('@/App')
  })

  it('App renders the shell behind the session gate', async () => {
    installBridge({ 'app:info': () => ({ mode: 'desktop' }) })
    vi.doMock('@/components/shell/AppShell', () => ({ AppShell: () => <div>shell</div> }))
    vi.resetModules()
    const { default: App } = await import('@/App')
    render(<App />)
    expect(await screen.findByText('shell')).toBeInTheDocument()
    vi.doUnmock('@/components/shell/AppShell')
  })
})
