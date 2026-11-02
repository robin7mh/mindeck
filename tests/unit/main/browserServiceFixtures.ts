import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import { onCleanup, tempDir } from './helpers'
import { BrowserService, type BrowserDeps } from '../../../electron/main/services/browser/BrowserService'
import type { AutomationTarget, BrowserHost, MenuEntry, TabNavigation } from '../../../electron/main/services/browser/types'
import type { AppSettings } from '@shared/types/settings'
import type { BrowserState } from '@shared/types/browser'

/** The web views, as the core sees them: every call recorded. */
export function fakeHost() {
  const automation = { cdp: vi.fn(async () => ({})), capture: vi.fn(async () => ({ png: 'png', width: 1, height: 1 })) }
  return {
    create: vi.fn(),
    destroy: vi.fn(),
    navigation: vi.fn((_id: string): TabNavigation | undefined => undefined),
    load: vi.fn(),
    go: vi.fn(),
    show: vi.fn(),
    setBounds: vi.fn(),
    freeze: vi.fn(async (): Promise<Record<string, string> | null> => ({ t: 'data:image/jpeg;base64,x' })),
    unfreeze: vi.fn(),
    find: vi.fn(),
    stopFind: vi.fn(),
    setZoom: vi.fn(),
    setMuted: vi.fn(),
    devtools: vi.fn(),
    print: vi.fn(),
    popup: vi.fn(),
    focusUi: vi.fn(),
    setTheme: vi.fn(),
    automation: vi.fn(() => automation as unknown as AutomationTarget),
    dispose: vi.fn(),
    clearPrivate: vi.fn(),
    loadExtension: vi.fn(async (path: string) => ({ id: `id:${path}` })),
    unloadExtension: vi.fn(),
    openPopup: vi.fn()
  } satisfies BrowserHost
}

export function settingsStore(initial: AppSettings = {}) {
  let current = initial
  return {
    get: () => current,
    update: vi.fn(async (patch: Partial<AppSettings>) => (current = { ...current, ...patch }))
  }
}

/** A browser core on a temp folder (an earlier session.json if given), its pushes recorded. */
export async function setupBrowser(opts: { session?: unknown; deps?: Partial<BrowserDeps>; dir?: string } = {}) {
  const dir = opts.dir ?? (await tempDir())
  if (opts.session !== undefined) await writeFile(join(dir, 'session.json'), JSON.stringify(opts.session))
  const published: { channel: string; payload: unknown }[] = []
  const deps: BrowserDeps = {
    dir,
    settings: settingsStore(),
    publish: (channel, payload) => published.push({ channel, payload }),
    publishDelayMs: 0,
    openExternal: vi.fn(async () => {}),
    ...opts.deps
  }
  const b = new BrowserService(deps)
  await b.init()
  const host = fakeHost()
  onCleanup(() => b.dispose())
  const sent = (channel: string) => published.filter((p) => p.channel === channel).map((p) => p.payload)
  return { b, dir, deps, host, published, sent, events: b.hostEvents(), state: (): BrowserState => b.state() }
}

export const lastMenu = (host: ReturnType<typeof fakeHost>) => host.popup.mock.calls[host.popup.mock.calls.length - 1][0] as MenuEntry[]
export const menuEntry = (entries: MenuEntry[], label: string) => entries.find((e) => 'label' in e && e.label === label) as Exclude<MenuEntry, { separator: true }>
