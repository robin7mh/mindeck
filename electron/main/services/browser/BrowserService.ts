import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IpcEvents } from '@shared/ipc/contract'
import {
  DEFAULT_BROWSER_SETTINGS,
  type AgentAction,
  type AgentActivity,
  type BrowserAuthRequest,
  type BrowserCapture,
  type BrowserCommand,
  type BrowserDownload,
  type BrowserGo,
  type BrowserInput,
  type BrowserKey,
  type BrowserPermissionRequest,
  type BrowserProfile,
  type BrowserPane,
  type BrowserSettings,
  type BrowserSplit,
  type BrowserState,
  type BrowserSuggestion,
  type BrowserTab,
  type BrowserTabGroup,
  type BrowserTool,
  type HistoryEntry,
  type TabError,
  type TabGroupColor,
  type ViewBounds
} from '@shared/types/browser'
import {
  BROWSER_NAMES,
  INTERNAL_PAGES,
  internalPage,
  type BookmarkFolder,
  type BookmarkNode,
  type ImportKind,
  type ImportRequest,
  type ImportResult,
  type ImportSource
} from '@shared/types/browserData'
import type { AppSettings } from '@shared/types/settings'
import { readJson } from '../../lib/jsonFile'
import { writeAtomic } from '../../lib/writeAtomic'
import { AdblockService, type RequestVerdict } from './adblock'
import { savedGroups, savedSplits, TabArrangement } from './arrangement'
import { BrowserBookmarks } from './bookmarks'
import { drmFailure, needsDrm } from './drm'
import { ExtensionService, type FetchResponse } from './extensions/ExtensionService'
import { browserRoots, type BrowserRoot } from './extensions/profiles'
import { bareUrl, BrowserHistory } from './history'
import { DevServerDetector } from './devServers'
import { BrowserImporter, type ImportEnv } from './import'
import { arrangeMenu } from './arrangeMenu'
import { ENGINE_NAMES, labels, type Labels } from './labels'
import { parseNetscape, toNetscape } from './netscape'
import { SearchSuggestions, type Fetch } from './suggestions'
import type { AutomationTarget, BrowserHost, BrowserHostEvents, ConsoleEntry, LoginAsk, MenuEntry, PermissionAsk, ShortcutAction, TabNavigation } from './types'
import { hostOf, isLoopback, isPageUrl, isWebUrl, originOf, resolveInput, searchUrl } from './url'

type BrowserEvent = 'browser:state' | 'browser:find' | 'browser:command' | 'browser:reveal' | 'browser:bookmarks' | 'browser:import'

export interface BrowserDeps {
  /** ~/Mindeck/data/browser — the session, the history, per-site choices. */
  dir: string
  settings: { get(): AppSettings; update(patch: Partial<AppSettings>): Promise<AppSettings> }
  publish: <K extends BrowserEvent>(channel: K, payload: IpcEvents[K]) => void
  /** The host's link handlers (the system browser, mailto:, other apps). */
  openExternal?: (url: string) => Promise<void>
  /** Name of the app that opens links like `url`. */
  appForUrl?: (url: string) => string
  openPath?: (path: string) => Promise<void>
  revealPath?: (path: string) => void
  /** State pushes are coalesced over this long (ms). */
  publishDelayMs?: number
  now?: () => number
  /** Where other browsers keep their profiles (no import without it). */
  importEnv?: ImportEnv
  /** How search suggestions are fetched (default: global fetch). */
  fetch?: Fetch
  /** Network for filter lists and the Chrome Web Store (default: the global fetch). */
  download?: (url: string) => Promise<FetchResponse>
  /** Chrome's version, which the Web Store asks for (the desktop app's Chromium). */
  chromeVersion?: string
  /** Native folder picker (extension folders, the downloads folder). */
  pickFolder?: (title: string) => Promise<string | null>
  /** Where other browsers keep their extensions (default: this computer's). */
  browserRoots?: () => BrowserRoot[]
}

interface Tab {
  id: string
  url: string
  title: string
  favicon?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  audible: boolean
  muted: boolean
  pinned: boolean
  zoom: number
  /** The user's sharing choice — it holds for the site it was made on. */
  share?: { on: boolean; origin: string }
  openedBy?: string
  agent?: AgentActivity
  error?: TabError
  crashed?: boolean
  /** Its view exists. Tabs restored from the last session load when first shown. */
  live: boolean
  /** Restored back/forward list, handed to the view when it is created. */
  nav?: TabNavigation
  profile?: BrowserProfile
  /** Requests blocked on the page. */
  blocked: number
  playing?: boolean
  drm?: boolean
  /** The site whose DRM bar the user closed. */
  drmOff?: string
  /** The address the malware list stopped. */
  danger?: string
  groupId?: string
}

type SavedTab = Pick<Tab, 'id' | 'url' | 'title'> & Partial<Pick<Tab, 'favicon' | 'pinned' | 'muted' | 'share' | 'openedBy' | 'nav' | 'profile' | 'groupId'>>

interface ClosedTab {
  url: string
  title: string
  index: number
  pinned: boolean
  nav?: TabNavigation
  profile?: BrowserProfile
  /** The group it was in — it goes back there if the group is still open. */
  groupId?: string
}

interface SiteData {
  zoom?: number
  /** Decisions the user asked to remember, by permission (`external:<scheme>` for other apps). */
  permissions?: Record<string, boolean>
}

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
const MAX_CLOSED = 25
const MAX_DOWNLOADS = 30
/** Back/forward entries kept per tab across restarts. */
const MAX_NAV = 50
const MAX_CONSOLE = 300
const MAX_FAVICON = 8 * 1024
const SAVE_DELAY_MS = 400
const LOAD_TIMEOUT_MS = 15_000
/** A picture for another device: wide enough for a tablet, small enough to send often. */
const CAPTURE_WIDTH = 900
const CAPTURE_QUALITY = 70

/** Keys a phone sends by name, as DevTools types them (`text`: what the key writes). */
const KEY_CODES: Record<BrowserKey, { code: number; text?: string }> = {
  Enter: { code: 13, text: '\r' },
  Backspace: { code: 8 },
  Tab: { code: 9 },
  Escape: { code: 27 },
  ArrowUp: { code: 38 },
  ArrowDown: { code: 40 },
  ArrowLeft: { code: 37 },
  ArrowRight: { code: 39 },
  PageUp: { code: 33 },
  PageDown: { code: 34 },
  Home: { code: 36 },
  End: { code: 35 },
  Delete: { code: 46 }
}
/** What the Web Store is told when the host did not say (a headless core installs nothing anyway). */
const CHROME_VERSION = '140.0.0.0'
const noop = () => {}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** A saved back/forward list, if it is one — at most MAX_NAV entries around the current one. */
export function cleanNav(raw: unknown): TabNavigation | undefined {
  const r = raw as Partial<TabNavigation> | undefined
  if (!r || !Array.isArray(r.entries) || typeof r.index !== 'number' || !r.entries[r.index]) return undefined
  // Only web pages come back (not about:blank or a file); the current one must be among them.
  const ok = (e: unknown) => typeof (e as TabNavigation['entries'][number])?.url === 'string' && isWebUrl((e as TabNavigation['entries'][number]).url)
  if (!ok(r.entries[r.index])) return undefined
  const index = r.entries.slice(0, r.index).filter(ok).length
  const entries = r.entries.filter(ok).map((e) => ({ url: e.url, title: typeof e.title === 'string' ? e.title : '' }))
  if (entries.length < 2) return undefined
  const start = Math.max(0, Math.min(index - Math.floor(MAX_NAV / 2), entries.length - MAX_NAV))
  return { entries: entries.slice(start, start + MAX_NAV), index: index - start }
}

const DOWNLOAD_STATES = new Set(['progressing', 'completed', 'cancelled', 'interrupted'])

/** A download from the saved list — one that was running when Mindeck went down is interrupted now. */
function savedDownload(raw: unknown): BrowserDownload | null {
  const d = raw as Partial<BrowserDownload> | null
  if (!d || typeof d.id !== 'string' || typeof d.path !== 'string' || typeof d.filename !== 'string' || !DOWNLOAD_STATES.has(String(d.state))) return null
  return {
    id: d.id,
    filename: d.filename,
    path: d.path,
    url: typeof d.url === 'string' ? d.url : '',
    state: d.state === 'progressing' ? 'interrupted' : d.state!,
    received: typeof d.received === 'number' ? d.received : 0,
    total: typeof d.total === 'number' ? d.total : 0,
    startedAt: typeof d.startedAt === 'string' ? d.startedAt : ''
  }
}

/** Commands the UI answers with a field to type into. */
const FOCUSING = new Set<BrowserCommand>(['focusOmnibox', 'find', 'tabSearch', 'bookmark', 'import', 'editGroup', 'palette'])

/** A tab with this address has a web view (not the new-tab page, not one of Mindeck's own pages). */
function hasView(url: string): boolean {
  return !!url && !internalPage(url)
}

/** The next zoom step in `direction` (or 100 %). */
export function zoomStep(current: number, direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'reset') return 1
  if (direction === 'in') return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0]
}

/**
 * The Mindeck browser's core (architecture §12.9): tabs and their order,
 * what was typed, history, downloads, a page's requests, the session across
 * restarts — and which tabs agents may use. It never touches Electron: the
 * desktop app attaches a BrowserHost that owns the real web views and reports
 * back through `hostEvents()`. Without a host (a headless core) the browser
 * reports itself unavailable.
 */
export class BrowserService {
  readonly history: BrowserHistory
  readonly devServers: DevServerDetector
  readonly bookmarks: BrowserBookmarks
  readonly adblock: AdblockService
  readonly extensions: ExtensionService
  private readonly suggestions: SearchSuggestions
  private readonly importer?: BrowserImporter
  private host: BrowserHost | null = null
  private tabs: Tab[] = []
  /** Tab groups and split views over `tabs`. */
  private readonly arrangement = new TabArrangement<Tab>(
    () => this.tabs,
    (tabs) => (this.tabs = tabs)
  )
  private activeId?: string
  private closed: ClosedTab[] = []
  /** The tabs of a session that ended in a crash (with their groups and splits), until the user restores or dismisses them. */
  private restorable: { tabs: Tab[]; activeId?: string; groups: BrowserTabGroup[]; splits: BrowserSplit[] } | null = null
  /** The session file says "running" — on a clean quit it must say so. */
  private marked = false
  private auth: BrowserAuthRequest[] = []
  private readonly authResponders = new Map<string, (credentials: { username: string; password: string } | null) => void>()
  private downloads: BrowserDownload[] = []
  private readonly downloadControls = new Map<string, { cancel(): void }>()
  private permissions: BrowserPermissionRequest[] = []
  private readonly responders = new Map<string, ((allow: boolean) => void)[]>()
  private sites: Record<string, SiteData> = {}
  private readonly consoles = new Map<string, ConsoleEntry[]>()
  private readonly waiters = new Map<string, (() => void)[]>()
  private bounds: ViewBounds | null = null
  /** Where each page of the split on screen sits (none: the active page fills `bounds`). */
  private panes?: BrowserPane[]
  private ui: { theme: 'dark' | 'light' | 'system'; locale: 'de' | 'en' } = { theme: 'system', locale: 'en' }
  private publishTimer?: NodeJS.Timeout
  private saveTimer?: NodeJS.Timeout
  private sitesTimer?: NodeJS.Timeout
  /** Unsaved changes (written on a timer, and at the latest on dispose). */
  private sessionDirty = false
  private sitesDirty = false

  constructor(private readonly deps: BrowserDeps) {
    this.history = new BrowserHistory(join(deps.dir, 'history.jsonl'), deps.now)
    this.devServers = new DevServerDetector(() => this.changed())
    this.bookmarks = new BrowserBookmarks(join(deps.dir, 'bookmarks.json'), () => this.deps.publish('browser:bookmarks', this.bookmarks.tree()), deps.now)
    this.suggestions = new SearchSuggestions(deps.fetch)
    if (deps.importEnv) this.importer = new BrowserImporter(deps.importEnv)
    const download = deps.download ?? ((url: string) => globalThis.fetch(url))
    const wanted = () => ({ ads: this.settings().adblock, malware: this.settings().malwareProtection })
    this.adblock = new AdblockService({ dir: deps.dir, fetch: download, wanted, now: deps.now })
    this.extensions = new ExtensionService({
      dir: deps.dir,
      fetch: download,
      chromeVersion: deps.chromeVersion ?? CHROME_VERSION,
      locale: () => this.ui.locale,
      pickFolder: deps.pickFolder,
      roots: deps.browserRoots ?? (() => browserRoots(process.platform, homedir(), process.env)),
      onChange: () => this.changed(),
      now: deps.now
    })
  }

  /**
   * Loads closed tabs, downloads, the history, bookmarks and per-site choices.
   * Every start begins with one new tab: the pages of the last session wait
   * in the closed tabs (⌘⇧T, the last one open first). A session that ended
   * in a crash is not reopened at once either: its tabs wait for the user to
   * restore them (a page may have caused it).
   */
  async init(): Promise<void> {
    await Promise.all([this.history.load(), this.bookmarks.load(), this.adblock.init(), this.extensions.init()])
    const sites = await readJson<{ sites?: Record<string, SiteData> }>(this.file('sites.json'))
    this.sites = sites?.sites && typeof sites.sites === 'object' ? sites.sites : {}
    const saved = await readJson<{ tabs?: SavedTab[]; activeId?: string; closed?: unknown; downloads?: unknown; exit?: unknown; groups?: unknown; splits?: unknown }>(
      this.file('session.json')
    )
    let tabs: Tab[] = []
    for (const t of Array.isArray(saved?.tabs) ? saved.tabs : []) {
      if (typeof t?.id !== 'string' || typeof t.url !== 'string') continue
      const share = t.share && typeof t.share.on === 'boolean' && typeof t.share.origin === 'string' ? { on: t.share.on, origin: t.share.origin } : undefined
      tabs.push(
        this.model({
          id: t.id,
          url: t.url,
          title: typeof t.title === 'string' ? t.title : '',
          favicon: typeof t.favicon === 'string' ? t.favicon : undefined,
          pinned: t.pinned === true,
          muted: t.muted === true,
          share,
          openedBy: typeof t.openedBy === 'string' ? t.openedBy : undefined,
          ...(t.profile === 'agents' ? { profile: 'agents' as const } : {}),
          zoom: this.siteZoom(t.url),
          nav: cleanNav(t.nav),
          ...(typeof t.groupId === 'string' ? { groupId: t.groupId } : {})
        })
      )
    }
    tabs = [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)]
    const activeId = tabs.find((t) => t.id === saved?.activeId)?.id
    let lastSession: ClosedTab[] = []
    if (saved?.exit === 'running' && tabs.some((t) => t.url)) {
      const ids = new Set(tabs.map((t) => t.id))
      this.restorable = { tabs, activeId, groups: savedGroups(saved.groups), splits: savedSplits(saved.splits, ids) }
    } else {
      lastSession = tabs
        .map((t, index) => ({ url: t.url, title: t.title, index, pinned: t.pinned, ...(t.nav ? { nav: t.nav } : {}), ...(t.profile ? { profile: t.profile } : {}) }))
        .filter((t) => t.url)
        .reverse()
    }
    this.tabs = [this.model({ url: '' })]
    this.activeId = this.tabs[0].id
    this.closed = (Array.isArray(saved?.closed) ? (saved.closed as Partial<ClosedTab>[]) : [])
      .filter((c) => typeof c?.url === 'string' && c.url && typeof c.index === 'number')
      // An agent's closed tab reopens in the agents' container, never in the user's profile.
      .map((c) => ({
        url: c.url!,
        title: typeof c.title === 'string' ? c.title : '',
        index: c.index!,
        pinned: c.pinned === true,
        nav: cleanNav(c.nav),
        ...(c.profile === 'agents' ? { profile: 'agents' as const } : {}),
        ...(typeof c.groupId === 'string' ? { groupId: c.groupId } : {})
      }))
    this.closed = [...lastSession, ...this.closed].slice(0, MAX_CLOSED)
    this.downloads = (Array.isArray(saved?.downloads) ? saved.downloads : [])
      .map(savedDownload)
      .filter((d): d is BrowserDownload => !!d)
      .slice(0, MAX_DOWNLOADS)
  }

  // --- the desktop host ---------------------------------------------------------

  attach(host: BrowserHost): void {
    this.host = host
    host.setTheme(this.ui.theme)
    this.adblock.start()
    void this.extensions.attach(host)
    this.changed()
  }

  /**
   * The window closed: its views are gone, and so are the requests of their pages.
   * Their back/forward lists stay with the tabs — the quit that follows saves them.
   */
  detach(): void {
    for (const t of this.tabs) if (t.live) t.nav = this.navOf(t)
    this.host = null
    this.bounds = null
    this.panes = undefined
    for (const t of this.tabs) {
      t.live = false
      t.loading = false
      this.wake(t.id)
    }
    for (const fns of this.responders.values()) fns.forEach((fn) => fn(false))
    this.responders.clear()
    this.permissions = []
    for (const respond of this.authResponders.values()) respond(null)
    this.authResponders.clear()
    this.auth = []
    // No pages, no filter-list downloads in the background (macOS keeps running without a window).
    this.adblock.stop()
    this.extensions.detach()
    this.changed()
  }

  hostEvents(): BrowserHostEvents {
    return {
      navigated: (id, nav) => this.onNavigated(id, nav),
      title: (id, title) =>
        this.patch(id, (t) => {
          t.title = title
          if (t.profile !== 'private') this.history.title(t.url, title)
        }),
      favicon: (id, url) => this.patch(id, (t) => (t.favicon = url)),
      loading: (id, loading) => this.onLoading(id, loading),
      failed: (id, error) => this.onEnded(id, (t) => (t.error = t.danger === error.url ? { ...error, danger: 'malware' } : error)),
      crashed: (id) => this.onEnded(id, (t) => (t.crashed = true)),
      audible: (id, audible) => this.patch(id, (t) => (t.audible = audible), false),
      zoomed: (id, direction) => void (this.lookup(id) && this.zoom(id, direction)),
      openTab: (url, opts) => void this.open({ url, background: opts.background, opener: opts.opener, private: opts.private }),
      found: (result) => this.deps.publish('browser:find', result),
      console: (id, entry) => this.onConsole(id, entry),
      shortcut: (action) => this.onShortcut(action),
      // The UI moves its focus to the browser's pane — and to the side of a split the user clicked into.
      focused: (id) => {
        if (id !== this.activeId && this.arrangement.partner(this.activeId) === id) this.activate(id)
        this.deps.publish('browser:command', { command: 'focused' })
      },
      workspaceKey: (key) => this.deps.publish('browser:command', { command: 'workspaceKey', key }),
      command: (id, command, arg) => this.lookup(id) && this.onCommand(id, command, arg),
      permission: (ask, respond) => this.onPermission(ask, respond),
      permissionCheck: (origin, kind) => this.sites[origin]?.permissions?.[kind] === true,
      download: (download, control) => {
        this.downloads = [download, ...this.downloads].slice(0, MAX_DOWNLOADS)
        this.downloadControls.set(download.id, control)
        this.changed()
        this.save()
      },
      downloadUpdated: (download) => {
        this.downloads = this.downloads.map((d) => (d.id === download.id ? download : d))
        if (download.state !== 'progressing') {
          this.downloadControls.delete(download.id)
          this.save()
        }
        this.changed()
      },
      locale: () => this.ui.locale,
      searchLabel: () => ENGINE_NAMES[this.settings().searchEngine],
      downloadPrefs: () => ({ ask: this.settings().askDownloadLocation, dir: this.settings().downloadDir }),
      request: (id, req) => this.onRequest(id, req),
      cosmetics: (id, url) => (this.lookup(id) ? this.adblock.cosmetics(url) : ''),
      media: (id, playing) => this.patch(id, (t) => (t.playing = playing), false),
      login: (id, ask, respond) => this.onLogin(id, ask, respond)
    }
  }

  // --- the UI's view of the browser -----------------------------------------------

  state(): BrowserState {
    return {
      available: !!this.host,
      tabs: this.tabs.map((t) => this.view(t)),
      activeId: this.activeId,
      closed: this.closed.length,
      downloads: this.downloads.map((d) => ({ ...d })),
      permissions: this.permissions.map((p) => ({ ...p })),
      devServers: this.devServers.list(),
      ...(this.restorable ? { restorable: this.restorable.tabs.length } : {}),
      auth: this.auth.map((a) => ({ ...a })),
      extensions: this.extensions.list(),
      groups: this.arrangement.groups.map((g) => ({ ...g })),
      splits: this.arrangement.splits.map((x) => ({ ...x, tabs: [...x.tabs] }))
    }
  }

  /**
   * A new tab with what was typed (an address or search words); nothing = the new-tab page.
   * It stays in its opener's profile; `private` makes a private tab, and agents' tabs go to
   * their container unless the user lets agents use the logins.
   */
  open(req: { url?: string; background?: boolean; opener?: string; openedBy?: string; private?: boolean } = {}): BrowserTab {
    let url = ''
    if (req.url) {
      const target = this.target(req.url)
      if (target?.kind === 'external') {
        this.external(target.url)
        return this.view(this.active())
      }
      // Mindeck's own pages (history, bookmarks) open once: a second ask shows the open one.
      const open = target?.kind === 'internal' && this.tabs.find((t) => t.url === target.url)
      if (open) {
        this.activate(open.id)
        return this.view(open)
      }
      url = target?.url ?? ''
    }
    const opener = req.opener ? this.lookup(req.opener) : undefined
    const profile = req.private ? 'private' : (opener?.profile ?? (req.openedBy && !this.settings().agentsUseLogins ? 'agents' : undefined))
    // A tab opened from a grouped tab joins its group (when it is of the same kind).
    const groupId = opener?.groupId && (profile === 'private') === (opener.profile === 'private') ? opener.groupId : undefined
    const tab = this.model({ url, openedBy: req.openedBy ?? opener?.openedBy, zoom: this.siteZoom(url), ...(profile ? { profile } : {}), ...(groupId ? { groupId } : {}) })
    this.insert(tab, opener)
    this.arrangement.prune()
    if (hasView(url) && this.host) this.goLive(tab)
    if (!req.background) this.activeId = tab.id
    this.touched()
    return this.view(tab)
  }

  close(id: string): void {
    const tab = this.require(id)
    const index = this.tabs.indexOf(tab)
    // Private tabs leave nothing behind — not even in the list of closed tabs.
    if (tab.url && tab.profile !== 'private') {
      const nav = this.navOf(tab)
      this.closed = [
        {
          url: tab.url,
          title: tab.title,
          index,
          pinned: tab.pinned,
          ...(nav ? { nav } : {}),
          ...(tab.profile ? { profile: tab.profile } : {}),
          ...(tab.groupId ? { groupId: tab.groupId } : {})
        },
        ...this.closed
      ].slice(0, MAX_CLOSED)
    }
    if (tab.live) this.host?.destroy(id)
    // The page beside it in a split takes over the screen.
    const partner = this.arrangement.partner(id)
    this.tabs.splice(index, 1)
    this.arrangement.prune()
    this.forget(id)
    if (tab.profile === 'private' && !this.tabs.some((t) => t.profile === 'private')) {
      this.host?.clearPrivate()
      // The last private tab closed: its downloads leave the list (the files stay where they were saved).
      this.downloads = this.downloads.filter((d) => !d.private)
    }
    if (this.activeId === id) this.activeId = partner ?? (this.tabs[index] ?? this.tabs[index - 1])?.id
    if (!this.tabs.length) {
      const fresh = this.model({ url: '' })
      this.tabs.push(fresh)
      this.activeId = fresh.id
    }
    this.touched()
  }

  activate(id: string): void {
    const tab = this.require(id)
    this.activeId = id
    // A tab in a folded group comes into view: its group unfolds.
    if (tab.groupId) this.arrangement.group(tab.groupId).collapsed = false
    this.ensureOnScreen()
    this.touched()
  }

  /** What was typed into the address bar: an address, a search, or a link for another app. */
  navigate(id: string, input: string): void {
    const tab = this.require(id)
    const target = this.target(input)
    if (!target) return
    if (target.kind === 'external') return this.external(target.url, id)
    // Typing an address takes the tab over: no longer the agent's, no earlier sharing choice.
    tab.openedBy = undefined
    tab.agent = undefined
    tab.share = undefined
    if (target.kind === 'internal') return this.showInternal(tab, target.url)
    this.load(tab, target.url)
  }

  go(id: string, action: BrowserGo): void {
    const tab = this.require(id)
    if (!hasView(tab.url)) return
    if (!tab.live) {
      if (action === 'reload' || action === 'hardReload') this.ensureLive(tab, true)
      return
    }
    if ((action === 'reload' || action === 'hardReload') && tab.error) {
      // A page that failed: load its address again — the error page stays until the new page is there.
      this.host?.load(id, tab.error.url)
      tab.loading = true
      return this.changed()
    }
    // Loading starts with the request, so a waiting agent waits for the right page
    // (back/forward only when there is somewhere to go).
    const goes = action === 'back' ? tab.canGoBack : action === 'forward' ? tab.canGoForward : true
    if (action === 'stop') tab.loading = false
    else if (goes) tab.loading = true
    this.host?.go(id, action)
    this.changed()
    this.syncView()
  }

  update(id: string, patch: { pinned?: boolean; muted?: boolean; shared?: boolean }): void {
    const tab = this.require(id)
    if (patch.pinned !== undefined && patch.pinned !== tab.pinned) {
      this.tabs.splice(this.tabs.indexOf(tab), 1)
      tab.pinned = patch.pinned
      this.tabs.splice(this.pinnedCount(), 0, tab)
      // A pinned tab leaves its group.
      this.arrangement.prune()
    }
    if (patch.muted !== undefined) {
      tab.muted = patch.muted
      if (tab.live) this.host?.setMuted(id, patch.muted)
    }
    // A private tab is never shared with agents.
    if (patch.shared !== undefined && tab.profile !== 'private') tab.share = { on: patch.shared, origin: originOf(tab.url) }
    this.touched()
  }

  /**
   * Reorder — within the pinned tabs, or within the others; a group's tabs stay together.
   * `groupId`: the group it joins there (null: out of its group; absent: it stays in its own).
   */
  move(id: string, index: number, groupId?: string | null): void {
    const tab = this.require(id)
    this.arrangement.place(tab, index, groupId)
    this.touched()
  }

  duplicate(id: string): BrowserTab {
    const tab = this.require(id)
    return this.open({ url: tab.url, opener: id })
  }

  reopen(): BrowserTab | null {
    const last = this.closed.shift()
    if (!last) return null
    const tab = this.model({
      url: last.url,
      title: last.title,
      pinned: last.pinned,
      zoom: this.siteZoom(last.url),
      nav: last.nav,
      ...(last.profile ? { profile: last.profile } : {})
    })
    // Back into its group, if that is still open.
    const group = last.groupId && this.arrangement.groups.find((g) => g.id === last.groupId)
    this.arrangement.place(tab, last.index, group ? group.id : undefined)
    if (this.host && hasView(tab.url)) this.goLive(tab)
    this.activeId = tab.id
    this.touched()
    return this.view(tab)
  }

  /** Zoom like Chrome: in steps, remembered for the site. */
  zoom(id: string, direction: 'in' | 'out' | 'reset'): number {
    const tab = this.require(id)
    tab.zoom = zoomStep(tab.zoom, direction)
    if (tab.live) this.host?.setZoom(id, tab.zoom)
    const origin = originOf(tab.url)
    if (origin && tab.profile !== 'private') {
      const site = (this.sites[origin] ??= {})
      if (tab.zoom === 1) delete site.zoom
      else site.zoom = tab.zoom
      this.saveSites()
    }
    this.changed()
    return tab.zoom
  }

  find(id: string, text: string, forward = true, next = false): void {
    this.require(id)
    if (!text) return this.findStop(id)
    this.host?.find(id, text, { forward, next })
  }

  findStop(id: string): void {
    this.require(id)
    this.host?.stopFind(id)
  }

  tool(id: string, tool: BrowserTool): void {
    const tab = this.require(id)
    if (tool === 'tabMenu') return this.host?.popup(this.tabMenu(tab))
    if (tool === 'pageMenu') return this.host?.popup(this.pageMenu(tab))
    if (tool === 'shield') return this.host?.popup(this.shieldMenu(tab))
    if (tool === 'handoff') {
      if (isWebUrl(tab.url)) void this.deps.openExternal?.(tab.url)
      return
    }
    if (!tab.live) return
    if (tool === 'devtools') this.host?.devtools(id)
    else this.host?.print(id)
  }

  /**
   * Where the web view goes; null takes it off screen (the module is hidden).
   * `focused`: the browser's pane has the focus — only then do its keys win
   * over the UI's (next to an editor, ⌘S and ⌘W stay the editor's).
   */
  setView(bounds: ViewBounds | null, focused = true, panes?: BrowserPane[]): void {
    this.bounds = bounds
    this.panes = bounds ? panes : undefined
    if (this.panes) this.host?.setBounds(bounds, focused, this.panes)
    else this.host?.setBounds(bounds, focused)
    this.ensureOnScreen()
    this.syncView()
  }

  freeze(): Promise<Record<string, string> | null> {
    return this.host ? this.host.freeze() : Promise.resolve(null)
  }

  unfreeze(): void {
    this.host?.unfreeze()
  }

  /** Address-bar suggestions: go there or search first, then open tabs, bookmarks and history. */
  suggest(text: string): BrowserSuggestion[] {
    const q = text.trim()
    if (!q) return []
    const engine = this.settings().searchEngine
    const search: BrowserSuggestion = { kind: 'search', url: searchUrl(engine, q), title: q }
    const target = this.target(q)
    const navigate = target?.kind === 'page' && target.url !== search.url
    const out: BrowserSuggestion[] = [navigate ? { kind: 'navigate', url: target.url, title: target.url } : search]
    const lower = q.toLowerCase()
    out.push(
      ...this.tabs
        .filter((t) => t.url && t.id !== this.activeId && `${bareUrl(t.url)} ${t.title}`.toLowerCase().includes(lower))
        .slice(0, 3)
        .map((t): BrowserSuggestion => ({ kind: 'tab', url: t.url, title: t.title || t.url, tabId: t.id }))
    )
    out.push(...this.bookmarks.suggest(q, 3).map((b): BrowserSuggestion => ({ kind: 'bookmark', url: b.url, title: b.title || b.url })))
    out.push(...this.history.suggest(q, 6).map((h): BrowserSuggestion => ({ kind: 'history', url: h.url, title: h.title || h.url })))
    if (navigate) out.push(search)
    const seen = new Set<string>()
    return out.filter((s) => (s.kind === 'tab' || !seen.has(s.url)) && !!seen.add(s.url)).slice(0, 8)
  }

  /** What the search engine suggests for the words typed — when the user allows asking it. */
  async searchSuggestions(text: string): Promise<BrowserSuggestion[]> {
    const { searchEngine, searchSuggestions } = this.settings()
    if (!searchSuggestions) return []
    const list = await this.suggestions.get(searchEngine, text)
    return list.map((s) => ({ kind: 'suggestion', url: searchUrl(searchEngine, s), title: s }))
  }

  /** Visited pages matching `query`; without one, the most visited sites. */
  historyEntries(query?: string, limit?: number): HistoryEntry[] {
    return query?.trim() ? this.history.search(query, limit) : this.history.top(limit)
  }

  /** The history page: newest first, before `before` (ms), matching `query`. */
  historyList(opts: { query?: string; before?: number; limit?: number }): HistoryEntry[] {
    return this.history.list(opts)
  }

  /** Forget pages by address, or every page visited in a time span. */
  deleteHistory(what: { urls?: string[]; from?: number; to?: number }): Promise<number> {
    return this.history.remove(what)
  }

  clearHistory(): Promise<void> {
    return this.history.clear()
  }

  // --- bookmarks ------------------------------------------------------------------

  bookmarkTree(): BookmarkFolder[] {
    return this.bookmarks.tree()
  }

  addBookmark(req: { parentId?: string; index?: number; title: string; url?: string }): BookmarkNode {
    return this.bookmarks.add(req)
  }

  updateBookmark(id: string, patch: { title?: string; url?: string }): void {
    this.bookmarks.update(id, patch)
  }

  moveBookmark(id: string, parentId: string, index: number): void {
    this.bookmarks.move(id, parentId, index)
  }

  removeBookmarks(ids: string[]): number {
    return this.bookmarks.remove(ids)
  }

  /** All bookmarks as a Netscape bookmark file (what every browser imports). */
  exportBookmarks(): string {
    const [bar, other] = this.bookmarks.tree()
    return toNetscape({ bar, other }, labels(this.ui.locale).barFolder)
  }

  /** Bookmarks from a Netscape bookmark file (exported from any browser); how many were new. */
  importBookmarksHtml(html: string): number {
    return this.bookmarks.merge(parseNetscape(html, this.now()), labels(this.ui.locale).imported)
  }

  // --- other browsers -------------------------------------------------------------

  /** The other browsers' profiles on this machine (none on a core that can't see the user's files). */
  importSources(): Promise<ImportSource[]> {
    return this.importer ? this.importer.sources() : Promise.resolve([])
  }

  /**
   * Takes bookmarks, history and the search engine over from another
   * browser's profile. Each kind on its own: one that fails is reported and
   * the others still come. Progress goes out as `browser:import` events.
   */
  async importFrom(req: ImportRequest): Promise<ImportResult> {
    const importer = this.importer
    if (!importer) throw coded('desktop-only', 'Importing is only available in the Mindeck desktop app')
    const source = (await importer.sources()).find((s) => s.id === req.sourceId)
    if (!source) throw coded('not-found', 'That browser profile is gone')
    const result: ImportResult = { sourceId: source.id, bookmarks: 0, history: 0, errors: [] }
    const order: ImportKind[] = ['bookmarks', 'history', 'settings']
    for (const kind of order.filter((k) => req.kinds.includes(k) && source.kinds.includes(k))) {
      this.deps.publish('browser:import', { sourceId: source.id, kind })
      try {
        if (kind === 'bookmarks') {
          result.bookmarks = this.bookmarks.merge(await importer.bookmarks(source.id), labels(this.ui.locale).importedFrom(BROWSER_NAMES[source.browser]))
        } else if (kind === 'history') {
          result.history = await this.history.merge(await importer.history(source.id))
        } else {
          const engine = await importer.searchEngine(source.id)
          if (engine) {
            await this.configure({ searchEngine: engine })
            result.searchEngine = engine
          }
        }
      } catch (err) {
        console.error(`[browser] importing ${kind} failed`, err)
        result.errors.push({ kind, message: err instanceof Error ? err.message : String(err) })
      }
    }
    return result
  }

  // --- the session after a crash ---------------------------------------------------

  /** Bring back the tabs of a session that ended in a crash — or let them go. */
  restoreSession(restore: boolean): void {
    const pending = this.restorable
    if (!pending) return
    this.restorable = null
    if (restore) {
      // A lone new-tab page (what the browser started with) makes way.
      if (this.tabs.length === 1 && !this.tabs[0].url) this.tabs = []
      this.tabs.push(...pending.tabs)
      this.tabs = [...this.tabs.filter((t) => t.pinned), ...this.tabs.filter((t) => !t.pinned)]
      this.arrangement.groups.push(...pending.groups)
      this.arrangement.splits.push(...pending.splits)
      this.arrangement.prune()
      if (pending.activeId) this.activate(pending.activeId)
      else this.activeId = this.tabs[0].id
    }
    this.touched()
  }

  // --- tab groups ---------------------------------------------------------------------

  /** A new group of these tabs (private and other tabs can't share one), in one run where the first of them is. */
  group(ids: string[], opts: { title?: string; color?: TabGroupColor } = {}): BrowserTabGroup {
    const group = this.arrangement.create(
      ids.map((id) => this.require(id)),
      opts
    )
    this.touched()
    return { ...group }
  }

  /** Rename, recolor, fold or unfold a group. Folding the group of the tab on screen shows the next tab outside it. */
  updateGroup(id: string, patch: { title?: string; color?: TabGroupColor; collapsed?: boolean }): void {
    this.arrangement.update(id, patch)
    if (patch.collapsed && this.active().groupId === id) {
      const index = this.tabs.indexOf(this.active())
      const outside = [...this.tabs.slice(index), ...this.tabs.slice(0, index).reverse()].find((t) => t.groupId !== id)
      if (outside) this.activate(outside.id)
      else this.open()
    }
    this.touched()
  }

  /** The group goes, its tabs stay. */
  ungroup(id: string): void {
    this.arrangement.ungroup(id)
    this.touched()
  }

  /** Close every tab of the group. */
  closeGroup(id: string): void {
    this.arrangement.group(id)
    for (const tab of this.arrangement.members(id)) this.close(tab.id)
  }

  // --- split view ---------------------------------------------------------------------

  /**
   * Two tabs side by side: `id` on the left (top), `withId` beside it — or a
   * new tab there (of the same kind, in the same group) whose address bar
   * takes the keyboard. The tab that was not on screen gets the focus.
   */
  split(id: string, withId?: string, vertical?: boolean): BrowserSplit {
    const first = this.require(id)
    let second: Tab
    if (withId) second = this.require(withId)
    else {
      second = this.model({ url: '', ...(first.profile === 'private' ? { profile: 'private' as const } : {}), ...(first.groupId ? { groupId: first.groupId } : {}) })
      this.tabs.splice(this.tabs.indexOf(first) + 1, 0, second)
    }
    const split = this.arrangement.pair(first, second, vertical)
    this.arrangement.prune()
    this.activeId = this.activeId === second.id ? first.id : second.id
    this.ensureOnScreen()
    this.touched()
    if (!withId) this.command('focusOmnibox')
    return { ...split, tabs: [...split.tabs] }
  }

  /** Move the divider (`ratio`: the first page's share), stack or unstack, or swap the sides. */
  updateSplit(id: string, patch: { ratio?: number; vertical?: boolean; swap?: boolean }): void {
    this.arrangement.updateSplit(id, patch)
    this.touched()
  }

  /** Back to one page: the focused one stays on screen. */
  unsplit(id: string): void {
    this.arrangement.unsplit(id)
    this.touched()
  }

  download(id: string, action: 'open' | 'reveal' | 'cancel' | 'remove'): void {
    const d = this.downloads.find((x) => x.id === id)
    if (!d) throw coded('not-found', 'Download not found')
    if (action === 'open') void this.deps.openPath?.(d.path)
    else if (action === 'reveal') this.deps.revealPath?.(d.path)
    else {
      this.downloadControls.get(id)?.cancel()
      if (action === 'remove') {
        this.downloads = this.downloads.filter((x) => x.id !== id)
        this.downloadControls.delete(id)
      }
      this.changed()
    }
  }

  /** The user's answer to a page's request. */
  permission(id: string, allow: boolean, remember = false): void {
    const req = this.permissions.find((p) => p.id === id)
    if (!req) throw coded('not-pending', 'This request is no longer pending')
    this.permissions = this.permissions.filter((p) => p.id !== id)
    this.responders.get(id)!.forEach((fn) => fn(allow))
    this.responders.delete(id)
    // A private tab's choices are not kept.
    if (remember && this.lookup(req.tabId ?? '')?.profile !== 'private') {
      const site = (this.sites[req.origin] ??= {})
      site.permissions = { ...site.permissions, [permissionKey(req)]: allow }
      this.saveSites()
    }
    this.changed()
  }

  /** The user's answer to a page's login: a user name and password, or none (cancel). */
  answerAuth(id: string, username?: string, password?: string): void {
    const req = this.auth.find((a) => a.id === id)
    if (!req) throw coded('not-pending', 'This login is no longer pending')
    this.auth = this.auth.filter((a) => a !== req)
    const respond = this.authResponders.get(id)!
    this.authResponders.delete(id)
    respond(username === undefined ? null : { username, password: password ?? '' })
    this.changed()
  }

  /** Open a page the malware list stopped anyway — its site stays allowed until Mindeck quits. */
  proceed(id: string): void {
    const tab = this.require(id)
    if (!tab.error?.danger) throw coded('not-blocked', 'This tab shows no blocked page')
    this.adblock.trust(tab.error.url)
    this.load(tab, tab.error.url)
  }

  /** The user closed the DRM bar: not again on this site, in this tab. */
  dismissDrm(id: string): void {
    const tab = this.require(id)
    tab.drm = false
    tab.drmOff = originOf(tab.url)
    this.changed()
  }

  /** Ad and tracker blocking on the tab's site, on or off — the page reloads to show the difference. */
  async setShield(id: string, on: boolean): Promise<void> {
    const tab = this.require(id)
    await this.adblock.setSite(tab.url, on)
    this.go(id, 'reload')
  }

  /** The downloads folder, chosen with the native picker (null: cancelled). */
  async pickDownloadDir(): Promise<BrowserSettings | null> {
    if (!this.deps.pickFolder) throw coded('desktop-only', 'The folder picker is only available in the Mindeck desktop app')
    const dir = await this.deps.pickFolder('Choose a downloads folder')
    return dir ? this.configure({ downloadDir: dir }) : null
  }

  settings(): BrowserSettings {
    return { ...DEFAULT_BROWSER_SETTINGS, ...this.deps.settings.get().browser }
  }

  async configure(patch: Partial<BrowserSettings>): Promise<BrowserSettings> {
    await this.deps.settings.update({ browser: { ...this.settings(), ...patch } })
    return this.settings()
  }

  /** The UI's look and language. */
  setUi(ui: { theme: 'dark' | 'light' | 'system'; locale: 'de' | 'en' }): void {
    this.ui = ui
    this.host?.setTheme(ui.theme)
  }

  /**
   * A link clicked somewhere in Mindeck (a chat, a note, the Live Server):
   * opens in a tab and brings the browser up. False when it can't (no
   * window, the user prefers the system browser, not a web address).
   */
  openFromApp(url: string): boolean {
    if (!this.host || !this.settings().openLinksInMindeck || !isWebUrl(url)) return false
    const tab = this.open({ url })
    this.deps.publish('browser:reveal', { tabId: tab.id })
    return true
  }

  // --- agents ---------------------------------------------------------------------

  /** The tabs agents may see: local dev pages, tabs agents opened, tabs the user shared. */
  agentTabs(): BrowserTab[] {
    return this.tabs.filter((t) => t.url && this.isShared(t)).map((t) => this.view(t))
  }

  /** The tab an agent means: the given one, else the active tab, else the one an agent used last. */
  agentTab(id?: string): BrowserTab {
    this.requireHost()
    const shared = this.tabs.filter((t) => t.url && this.isShared(t))
    if (id) {
      const tab = shared.find((t) => t.id === id)
      if (!tab) throw coded('not-shared', `Tab ${id} is not open or not shared with agents. List the shared tabs with browser_tabs.`)
      return this.view(tab)
    }
    const lastUsed = [...shared].filter((t) => t.agent).sort((a, b) => b.agent!.at.localeCompare(a.agent!.at))[0]
    // The page the user looks at — in a split, the focused side first, then the one beside it.
    const beside = this.arrangement.partner(this.activeId)
    const tab = shared.find((t) => t.id === this.activeId) ?? shared.find((t) => t.id === beside) ?? lastUsed ?? shared[0]
    if (!tab) {
      throw coded('no-tab', 'No tab is shared with agents. Open one with browser_open, or ask the user to share a tab (the eye icon in the Mindeck browser).')
    }
    return this.view(tab)
  }

  /** The tabs on screen: the active one, then the one beside it in a split. */
  onScreen(): string[] {
    const beside = this.arrangement.partner(this.activeId)
    return [this.active().id, ...(beside ? [beside] : [])]
  }

  /** An agent opens a page — in a tab of its own, in the background, then waits for it to load. */
  async agentOpen(url: string, agent: string): Promise<BrowserTab> {
    this.requireHost()
    if (!isWebUrl(url)) throw coded('bad-url', 'Agents can open http and https addresses only')
    const tab = this.open({ url, background: true, openedBy: agent })
    this.noteAgent(tab.id, agent, 'open', url)
    await this.waitForLoad(tab.id)
    return this.view(this.require(tab.id))
  }

  async agentNavigate(id: string, to: { url?: string; action?: 'back' | 'forward' | 'reload' }, agent: string): Promise<BrowserTab> {
    const tab = this.require(this.agentTab(id).id)
    if (to.url) {
      if (!isWebUrl(to.url)) throw coded('bad-url', 'Agents can open http and https addresses only')
      this.load(tab, to.url)
    } else {
      this.go(id, to.action ?? 'reload')
    }
    this.noteAgent(id, agent, 'navigate', to.url ?? to.action ?? 'reload')
    await this.waitForLoad(id)
    return this.view(tab)
  }

  /** CDP and pictures of a shared tab, its view created first when it was not loaded yet. */
  async automation(id: string): Promise<AutomationTarget> {
    const host = this.requireHost()
    const tab = this.require(this.agentTab(id).id)
    if (!tab.live) {
      this.ensureLive(tab, true)
      await this.waitForLoad(id)
    }
    return host.automation(id)
  }

  /**
   * A tab's picture for a paired device (`browser:capture`), with the page's
   * size so a tap lands where it was meant. Private tabs are never shown; the
   * new-tab page and Mindeck's own pages have no picture.
   */
  async capture(id: string, width = CAPTURE_WIDTH): Promise<BrowserCapture | null> {
    const target = await this.remoteTarget(id)
    if (!target) return null
    const [shot, metrics] = await Promise.all([
      target.preview(width, CAPTURE_QUALITY),
      target.cdp<{ cssLayoutViewport?: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics').catch(() => ({}) as { cssLayoutViewport?: undefined })
    ])
    const viewport = metrics.cssLayoutViewport
    return {
      image: `data:image/jpeg;base64,${shot.jpeg}`,
      width: shot.width,
      height: shot.height,
      viewport: viewport ? { width: viewport.clientWidth, height: viewport.clientHeight } : { width: shot.width, height: shot.height }
    }
  }

  /** A tap, scroll, text or key from a paired device, through the page's DevTools protocol. */
  async input(id: string, input: BrowserInput): Promise<void> {
    const target = await this.remoteTarget(id)
    if (!target) throw coded('no-page', 'This tab shows no web page')
    if (input.action === 'click') {
      const at = { x: input.x, y: input.y }
      await target.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
      await target.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 })
      await target.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 })
    } else if (input.action === 'scroll') {
      await target.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.dx, deltaY: input.dy })
    } else if (input.action === 'type') {
      await target.cdp('Input.insertText', { text: input.text })
    } else {
      const key = KEY_CODES[input.key]
      const base = { key: input.key, code: input.key, windowsVirtualKeyCode: key.code, nativeVirtualKeyCode: key.code }
      await target.cdp('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}) })
      await target.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    }
  }

  /** A tab another device may see and use: never a private one; loaded first when it was not yet. Null for pages without a view. */
  private async remoteTarget(id: string): Promise<AutomationTarget | null> {
    const host = this.requireHost()
    const tab = this.require(id)
    if (tab.profile === 'private') throw coded('remote-forbidden', 'Private tabs stay on the desktop')
    if (!hasView(tab.url)) return null
    if (!tab.live) {
      this.ensureLive(tab, true)
      await this.waitForLoad(id)
    }
    return host.automation(id)
  }

  /** Show in the tab what an agent just did. */
  noteAgent(id: string, name: string, action: AgentAction, detail?: string): void {
    this.patch(id, (t) => (t.agent = { name, action, ...(detail ? { detail } : {}), at: new Date(this.now()).toISOString() }), false)
  }

  /** The page's console since it was opened (newest last). */
  consoleOf(id: string): ConsoleEntry[] {
    return [...(this.consoles.get(id) ?? [])]
  }

  /** Resolves once the tab stopped loading (or after the timeout). */
  waitForLoad(id: string, timeoutMs = LOAD_TIMEOUT_MS): Promise<void> {
    if (!this.lookup(id)?.loading) return Promise.resolve()
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? []
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        // Still waiting (a wake would have cleared this timer): leave the others waiting.
        const rest = this.waiters.get(id)!.filter((fn) => fn !== done)
        if (rest.length) this.waiters.set(id, rest)
        else this.waiters.delete(id)
        resolve()
      }, timeoutMs)
      list.push(done)
      this.waiters.set(id, list)
    })
  }

  /** A clean quit: everything unsaved goes to disk, and the session says it ended well. */
  async dispose(): Promise<void> {
    clearTimeout(this.publishTimer)
    this.adblock.dispose()
    this.extensions.dispose()
    await Promise.all([
      (this.sessionDirty || this.marked) && this.saveSession(true),
      this.sitesDirty && this.writeSites(),
      this.history.flush(),
      this.bookmarks.flush()
    ])
  }

  // --- internals ------------------------------------------------------------------

  private file(name: string): string {
    return join(this.deps.dir, name)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private model(init: Partial<Tab> & { url: string }): Tab {
    return {
      id: randomUUID(),
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      audible: false,
      muted: false,
      pinned: false,
      zoom: 1,
      live: false,
      blocked: 0,
      ...init
    }
  }

  private view(t: Tab): BrowserTab {
    const { live: _live, share: _share, nav: _nav, blocked, drm, drmOff: _drmOff, danger: _danger, ...rest } = t
    const shield = isWebUrl(t.url) ? { shield: { on: this.settings().adblock && this.adblock.siteOn(t.url), blocked } } : {}
    return { ...rest, shared: this.isShared(t), ...(drm ? { drm } : {}), ...shield }
  }

  private isShared(t: Tab): boolean {
    if (!hasView(t.url) || t.profile === 'private') return false
    if (t.share && t.share.origin === originOf(t.url)) return t.share.on
    return !!t.openedBy || isLoopback(t.url)
  }

  private lookup(id: string): Tab | undefined {
    return this.tabs.find((t) => t.id === id)
  }

  private require(id: string): Tab {
    const tab = this.lookup(id)
    if (!tab) throw coded('not-found', 'Tab not found')
    return tab
  }

  private requireHost(): BrowserHost {
    if (!this.host) throw coded('desktop-only', 'The browser is only available in the Mindeck desktop app')
    return this.host
  }

  private active(): Tab {
    return this.tabs.find((t) => t.id === this.activeId) ?? this.tabs[0]
  }

  private pinnedCount(): number {
    return this.tabs.filter((t) => t.pinned).length
  }

  private siteZoom(url: string): number {
    return this.sites[originOf(url)]?.zoom ?? 1
  }

  /** What typed text leads to: a page for a tab, one of Mindeck's own pages, a link for another app, or nothing. */
  private target(input: string): { kind: 'page' | 'internal' | 'external'; url: string } | null {
    const page = internalPage(input)
    if (page) return { kind: 'internal', url: INTERNAL_PAGES[page] }
    const url = resolveInput(input, this.settings().searchEngine)
    if (!url || /^(javascript|vbscript):/i.test(url)) return null
    return { kind: isPageUrl(url) ? 'page' : 'external', url }
  }

  /**
   * A link for another app that was typed, or opened from a bookmark or the
   * history: the OS gets it only once the user said yes (asked like a page's
   * link, remembered per app) — Chrome asks too. Network shares and Windows'
   * handlers with a record of running code (ms-msdt:, search-ms: …) never.
   */
  private external(url: string, tabId?: string): void {
    if (NEVER_EXTERNAL.test(url)) return
    // Nothing on this machine opens it: nothing to ask.
    const app = this.deps.appForUrl?.(url)
    if (!app) return
    const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase()
    this.onPermission({ tabId, origin: scheme, kind: 'external', target: url, app }, (allow) => {
      if (allow) void this.deps.openExternal?.(url).catch(() => {})
    })
  }

  /** After the opener (and the tabs it opened before), else at the end — pinned tabs stay first. */
  private insert(tab: Tab, after?: Tab): void {
    const index = after ? Math.max(this.tabs.indexOf(after) + 1, this.pinnedCount()) : this.tabs.length
    this.tabs.splice(index, 0, tab)
  }

  private goLive(tab: Tab): void {
    this.host!.create(tab.id, tab.url, {
      agent: !!tab.openedBy,
      zoom: tab.zoom,
      muted: tab.muted,
      ...(tab.profile ? { profile: tab.profile } : {}),
      ...(tab.nav ? { history: tab.nav } : {})
    })
    tab.nav = undefined
    tab.live = true
    tab.loading = true
  }

  /** Load the tab's page if it has none yet (on screen, or `force`d for an agent / a reload). */
  private ensureLive(tab: Tab, force = false): void {
    if (hasView(tab.url) && !tab.live && this.host && (force || this.bounds)) {
      this.goLive(tab)
      this.touched()
    }
  }

  /** The pages on screen (the active tab, and the one beside it in a split) are loaded. */
  private ensureOnScreen(): void {
    if (!this.bounds) return
    const active = this.active()
    this.ensureLive(active)
    const beside = this.lookup(this.arrangement.partner(active.id) ?? '')
    if (beside) this.ensureLive(beside)
  }

  /** One of Mindeck's own pages in this tab: the web view (if any) goes. */
  private showInternal(tab: Tab, url: string): void {
    if (tab.live) {
      this.host?.destroy(tab.id)
      tab.live = false
      this.forget(tab.id)
    }
    Object.assign(tab, {
      url,
      title: '',
      favicon: undefined,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: undefined,
      crashed: false,
      nav: undefined
    })
    this.touched()
  }

  /** The tab's back/forward list: from its view, else as restored. */
  private navOf(tab: Tab): TabNavigation | undefined {
    return cleanNav(tab.live ? this.host?.navigation(tab.id) : tab.nav)
  }

  private load(tab: Tab, url: string): void {
    tab.url = url
    tab.nav = undefined
    tab.error = undefined
    tab.crashed = false
    if (this.host) {
      if (tab.live) this.host.load(tab.id, url)
      else this.goLive(tab)
      tab.loading = true
    }
    this.touched()
  }

  /**
   * The visible web views: the active tab's (and in a split the one beside
   * it), unless the new-tab page or an error page shows instead.
   */
  private syncView(): void {
    const page = (t: Tab | undefined) => (t && t.live && t.url && !t.error && !t.crashed ? t.id : undefined)
    const t = this.active()
    const beside = page(this.lookup(this.arrangement.partner(t.id) ?? ''))
    if (beside) this.host?.show(page(t), beside)
    else this.host?.show(page(t))
  }

  /** Something the UI shows changed — and the session with it. */
  private touched(): void {
    this.changed()
    this.syncView()
    this.save()
  }

  private changed(): void {
    if (this.publishTimer) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined
      this.deps.publish('browser:state', this.state())
    }, this.deps.publishDelayMs ?? 33)
  }

  private patch(id: string, fn: (t: Tab) => void, persist = true): void {
    const tab = this.lookup(id)
    if (!tab) return
    fn(tab)
    this.changed()
    if (persist) this.save()
  }

  private wake(id: string): void {
    this.waiters.get(id)?.forEach((fn) => fn())
    this.waiters.delete(id)
  }

  /** A closed tab: its console, its waiters and its page's open requests go. */
  private forget(id: string): void {
    this.consoles.delete(id)
    this.wake(id)
    this.denyRequests(id)
  }

  private denyRequests(tabId: string): void {
    for (const p of this.permissions.filter((x) => x.tabId === tabId)) {
      this.responders.get(p.id)!.forEach((fn) => fn(false))
      this.responders.delete(p.id)
    }
    this.permissions = this.permissions.filter((x) => x.tabId !== tabId)
    for (const a of this.auth.filter((x) => x.tabId === tabId)) {
      this.authResponders.get(a.id)!(null)
      this.authResponders.delete(a.id)
    }
    this.auth = this.auth.filter((x) => x.tabId !== tabId)
  }

  private onNavigated(id: string, nav: { url: string; canGoBack: boolean; canGoForward: boolean; inPage?: boolean }): void {
    const tab = this.lookup(id)
    if (!tab) return
    const newOrigin = originOf(nav.url) !== originOf(tab.url)
    tab.url = nav.url
    tab.canGoBack = nav.canGoBack
    tab.canGoForward = nav.canGoForward
    tab.error = undefined
    tab.crashed = false
    if (!nav.inPage) {
      tab.title = ''
      if (newOrigin) tab.favicon = undefined
      this.denyRequests(id)
      const zoom = this.siteZoom(nav.url)
      if (zoom !== tab.zoom) {
        tab.zoom = zoom
        this.host?.setZoom(id, zoom)
      }
      tab.drm = needsDrm(nav.url) && tab.drmOff !== originOf(nav.url)
    }
    if (tab.profile !== 'private') this.history.visit(nav.url, nav.inPage ? tab.title : '')
    this.touched()
  }

  private onLoading(id: string, loading: boolean): void {
    const tab = this.lookup(id)
    if (!tab) return
    tab.loading = loading
    // An error or crash page stays until a new page commits (navigated) — no blank flash on retry.
    if (!loading) this.wake(id)
    this.changed()
  }

  /** The page failed or crashed: no longer loading, and the UI shows why instead of the view. */
  private onEnded(id: string, mark: (t: Tab) => void): void {
    const tab = this.lookup(id)
    if (!tab) return
    mark(tab)
    tab.loading = false
    this.wake(id)
    this.changed()
    this.syncView()
  }

  private onConsole(id: string, entry: ConsoleEntry): void {
    const tab = this.lookup(id)
    if (tab && !tab.drm && drmFailure(entry.level, entry.message) && tab.drmOff !== originOf(tab.url)) {
      tab.drm = true
      this.changed()
    }
    const list = this.consoles.get(id) ?? []
    list.push(entry)
    if (list.length > MAX_CONSOLE) list.splice(0, list.length - MAX_CONSOLE)
    this.consoles.set(id, list)
  }

  private command(command: BrowserCommand, id?: string): void {
    // What the UI answers with a field to type into takes the keyboard from the page.
    if (FOCUSING.has(command)) this.host?.focusUi()
    this.deps.publish('browser:command', id ? { command, id } : { command })
  }

  /** ⌘⇧G: the tab on screen goes into a new group, whose name the UI asks for. */
  private newGroup(tab: Tab): void {
    const group = this.group([tab.id])
    this.command('editGroup', group.id)
  }

  /** ⌘⇧D: the tab on screen splits with a new tab — or, in a split already, goes back to one page. */
  private toggleSplit(tab: Tab): void {
    const split = this.arrangement.splitOf(tab.id)
    if (split) this.unsplit(split.id)
    else this.split(tab.id)
  }

  private onShortcut(action: ShortcutAction): void {
    const tab = this.active()
    const index = this.tabs.indexOf(tab)
    const pick = (i: number): void => {
      const target = this.tabs[i]
      if (target) this.activate(target.id)
    }
    switch (action) {
      case 'newTab':
      case 'newPrivateTab':
        this.open({ private: action === 'newPrivateTab' })
        return this.command('focusOmnibox')
      case 'closeTab':
        return this.close(tab.id)
      case 'reopenTab':
        return void this.reopen()
      case 'focusOmnibox':
      case 'find':
        return this.command(action)
      case 'reload':
      case 'hardReload':
      case 'back':
      case 'forward':
        return this.go(tab.id, action)
      case 'zoomIn':
      case 'zoomOut':
      case 'zoomReset':
        return void this.zoom(tab.id, action === 'zoomIn' ? 'in' : action === 'zoomOut' ? 'out' : 'reset')
      case 'nextTab':
        return pick((index + 1) % this.tabs.length)
      case 'prevTab':
        return pick((index - 1 + this.tabs.length) % this.tabs.length)
      case 'lastTab':
        return pick(this.tabs.length - 1)
      case 'devtools':
      case 'print':
        return this.tool(tab.id, action)
      case 'bookmark':
      case 'tabSearch':
      case 'bookmarksBar':
      case 'verticalTabs':
      case 'palette':
        return this.command(action)
      case 'newGroup':
        return this.newGroup(tab)
      case 'split':
        return this.toggleSplit(tab)
      case 'history':
      case 'bookmarkManager':
        return void this.open({ url: INTERNAL_PAGES[action === 'history' ? 'history' : 'bookmarks'] })
      default:
        return pick(Number(action.slice(3)) - 1)
    }
  }

  private onCommand(id: string, command: 'sendToAgent' | 'search', arg?: string): void {
    if (command === 'search') {
      if (arg) this.open({ url: searchUrl(this.settings().searchEngine, arg), opener: id })
      return
    }
    this.update(id, { shared: true })
    this.deps.publish('browser:command', { command: 'sendToAgent' })
  }

  private onPermission(ask: PermissionAsk, respond: (allow: boolean) => void): void {
    const stored = this.sites[ask.origin]?.permissions?.[permissionKey(ask)]
    if (stored !== undefined) return respond(stored)
    const same = this.permissions.find((p) => p.tabId === ask.tabId && p.origin === ask.origin && p.kind === ask.kind && p.target === ask.target)
    if (same) {
      this.responders.get(same.id)!.push(respond)
      return
    }
    const req: BrowserPermissionRequest = { id: randomUUID(), ...ask }
    this.permissions.push(req)
    this.responders.set(req.id, [respond])
    this.changed()
  }

  /** A request of a page: the blocker decides; the tab counts what it blocked (from its page's main request on). */
  private onRequest(id: string | undefined, req: { url: string; type: string; referrer: string }): RequestVerdict {
    const tab = this.lookup(id ?? '')
    const main = req.type === 'mainFrame'
    if (tab && main) {
      tab.blocked = 0
      tab.danger = undefined
      this.changed()
    }
    const verdict = this.adblock.check({ url: req.url, type: req.type, sourceUrl: req.referrer, page: main ? req.url : tab?.url || req.referrer })
    if (tab && verdict.danger) tab.danger = req.url
    else if (tab && (verdict.cancel || verdict.redirectURL)) {
      tab.blocked += 1
      this.changed()
    }
    return verdict
  }

  private onLogin(tabId: string | undefined, ask: LoginAsk, respond: (credentials: { username: string; password: string } | null) => void): void {
    const tab = this.lookup(tabId ?? '')
    const req: BrowserAuthRequest = { id: randomUUID(), ...(tab ? { tabId: tab.id } : {}), host: ask.host, realm: ask.realm, isProxy: ask.isProxy }
    this.auth.push(req)
    this.authResponders.set(req.id, respond)
    this.changed()
  }

  /** The shield in the address bar: what was blocked here, and blocking on this site on or off. */
  private shieldMenu(tab: Tab): MenuEntry[] {
    const l = labels(this.ui.locale)
    const on = this.adblock.siteOn(tab.url)
    return [
      { label: l.blocked(tab.blocked), enabled: false, run: noop },
      { separator: true },
      this.settings().adblock
        ? { label: l.blockOn(hostOf(tab.url)), checked: on, enabled: isWebUrl(tab.url) && !isLoopback(tab.url), run: () => void this.setShield(tab.id, !on) }
        : { label: l.blockingOff, enabled: false, run: noop },
      { label: l.settings, run: () => this.command('settings') }
    ]
  }

  private tabMenu(tab: Tab): MenuEntry[] {
    const l = labels(this.ui.locale)
    const shared = this.isShared(tab)
    return [
      { label: l.reload, enabled: !!tab.url, run: () => this.go(tab.id, 'reload') },
      { label: l.duplicate, run: () => void this.duplicate(tab.id) },
      { label: tab.pinned ? l.unpin : l.pin, run: () => this.update(tab.id, { pinned: !tab.pinned }) },
      { label: tab.muted ? l.unmute : l.mute, run: () => this.update(tab.id, { muted: !tab.muted }) },
      { label: shared ? l.unshare : l.share, enabled: !!tab.url, run: () => this.update(tab.id, { shared: !shared }) },
      { label: l.handoff(this.deps.appForUrl?.('https://') ?? ''), enabled: isWebUrl(tab.url), run: () => this.tool(tab.id, 'handoff') },
      { separator: true },
      ...this.arrangeEntries(tab, l),
      { separator: true },
      { label: l.verticalTabs, checked: this.settings().verticalTabs, run: () => this.command('verticalTabs') },
      { separator: true },
      { label: l.close, run: () => this.close(tab.id) },
      {
        label: l.closeOthers,
        enabled: this.tabs.some((t) => t !== tab && !t.pinned),
        run: () => this.tabs.filter((t) => t !== tab && !t.pinned).forEach((t) => this.close(t.id))
      }
    ]
  }

  /** The tab menu's group and split entries. */
  private arrangeEntries(tab: Tab, l: Labels): MenuEntry[] {
    const a = this.arrangement
    const split = a.splitOf(tab.id)
    const other = this.activeId !== tab.id && a.partner(this.activeId) !== tab.id ? this.activeId : undefined
    const groupEnd = (id: string) => this.tabs.indexOf(a.members(id).pop()!)
    return arrangeMenu(
      { grouped: !!tab.groupId, groups: a.groups.filter((g) => g.id !== tab.groupId && a.fits(tab, g.id)), split, active: other },
      {
        newGroup: () => this.newGroup(tab),
        join: (groupId) => this.move(tab.id, this.tabs.length, groupId),
        leave: () => this.move(tab.id, groupEnd(tab.groupId!), null),
        splitNew: () => void this.split(tab.id),
        splitBeside: (active) => void this.split(active, tab.id),
        updateSplit: (s, patch) => this.updateSplit(s.id, patch),
        unsplit: (s) => this.unsplit(s.id)
      },
      l
    )
  }

  private pageMenu(tab: Tab): MenuEntry[] {
    const l = labels(this.ui.locale)
    const page = tab.live && !!tab.url
    return [
      { label: l.newTab, run: () => this.onShortcut('newTab') },
      { label: l.newPrivateTab, run: () => this.onShortcut('newPrivateTab') },
      { label: l.reopen, enabled: this.closed.length > 0, run: () => void this.reopen() },
      { label: l.tabSearch, run: () => this.command('tabSearch') },
      { separator: true },
      // A private tab leaves no bookmarks behind either.
      { label: l.bookmarkPage, enabled: hasView(tab.url) && tab.profile !== 'private', run: () => this.command('bookmark') },
      { label: l.bookmarksBar, checked: this.settings().bookmarksBar, run: () => this.onShortcut('bookmarksBar') },
      { label: l.bookmarkManager, run: () => this.onShortcut('bookmarkManager') },
      { label: l.history, run: () => this.onShortcut('history') },
      { label: l.importData, enabled: !!this.importer, run: () => this.command('import') },
      { separator: true },
      { label: l.find, enabled: page, run: () => this.command('find') },
      { label: l.zoomIn, run: () => void this.zoom(tab.id, 'in') },
      { label: l.zoomOut, run: () => void this.zoom(tab.id, 'out') },
      { label: l.zoomReset(Math.round(tab.zoom * 100)), enabled: tab.zoom !== 1, run: () => void this.zoom(tab.id, 'reset') },
      { separator: true },
      { label: l.print, enabled: page, run: () => this.tool(tab.id, 'print') },
      { label: l.devtools, enabled: page, run: () => this.tool(tab.id, 'devtools') },
      { label: l.handoff(this.deps.appForUrl?.('https://') ?? ''), enabled: isWebUrl(tab.url), run: () => this.tool(tab.id, 'handoff') },
      { separator: true },
      { label: l.sendToAgent, enabled: !!tab.url, run: () => this.onCommand(tab.id, 'sendToAgent') },
      { label: l.settings, run: () => this.command('settings') }
    ]
  }

  private save(): void {
    this.sessionDirty = true
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.saveSession(), SAVE_DELAY_MS)
  }

  /**
   * The session: tabs with their back/forward lists, closed tabs, downloads —
   * and whether Mindeck is still running (`exit`), so a crash shows on the next start.
   * Tabs still waiting to be restored after a crash are kept, behind the open ones.
   */
  private async saveSession(clean = false): Promise<void> {
    clearTimeout(this.saveTimer)
    this.sessionDirty = false
    this.marked = !clean
    const save = (t: Tab): SavedTab => {
      const nav = this.navOf(t)
      return {
        id: t.id,
        url: t.url,
        title: t.title,
        ...(t.favicon && t.favicon.length <= MAX_FAVICON ? { favicon: t.favicon } : {}),
        ...(t.pinned ? { pinned: true } : {}),
        ...(t.muted ? { muted: true } : {}),
        ...(t.share ? { share: t.share } : {}),
        ...(t.openedBy ? { openedBy: t.openedBy } : {}),
        ...(nav ? { nav } : {}),
        ...(t.profile ? { profile: t.profile } : {}),
        ...(t.groupId ? { groupId: t.groupId } : {})
      }
    }
    // Private tabs are never written down (nor their groups).
    const kept = this.tabs.filter((t) => t.profile !== 'private')
    const { groups, splits } = this.arrangement.saved(kept)
    const pending = this.restorable
    const tabs = [...kept, ...(pending?.tabs ?? [])].map(save)
    const data = {
      version: 1,
      exit: clean ? 'clean' : 'running',
      activeId: this.activeId,
      tabs,
      groups: [...groups, ...(pending?.groups ?? [])],
      splits: [...splits, ...(pending?.splits ?? [])],
      closed: this.closed,
      downloads: this.downloads.filter((d) => !d.private)
    }
    await writeAtomic(this.file('session.json'), JSON.stringify(data), 0o600).catch((err) => console.error('[browser] saving the session failed', err))
  }

  private saveSites(): void {
    this.sitesDirty = true
    clearTimeout(this.sitesTimer)
    this.sitesTimer = setTimeout(() => void this.writeSites(), SAVE_DELAY_MS)
  }

  private async writeSites(): Promise<void> {
    clearTimeout(this.sitesTimer)
    this.sitesDirty = false
    await writeAtomic(this.file('sites.json'), JSON.stringify({ version: 1, sites: this.sites }, null, 2)).catch((err) =>
      console.error('[browser] saving site settings failed', err)
    )
  }
}

/** Links that never leave for the OS from the address bar: shares (file:// is a page here), and Windows' risky handlers. */
const NEVER_EXTERNAL = /^(?:smb|cifs|nfs|afp|ms-[a-z0-9.+-]*|search-ms|search):/i

/** Remembered per permission — and per app for links to other apps (mailto:, zoommtg:, …). */
function permissionKey(p: { kind: string; target?: string }): string {
  if (p.kind !== 'external') return p.kind
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(p.target ?? '')?.[1].toLowerCase() ?? ''
  return `external:${scheme}`
}
