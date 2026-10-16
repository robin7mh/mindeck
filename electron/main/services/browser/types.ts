import type {
  BrowserDownload,
  BrowserFind,
  BrowserGo,
  BrowserPane,
  BrowserPermissionKind,
  BrowserProfile,
  TabError,
  ViewBounds,
  WorkspaceKey
} from '@shared/types/browser'
import type { RequestVerdict } from './adblock'
import type { ExtensionHost } from './extensions/ExtensionService'

/** Keys the browser takes over while it is on screen — even when a page has the focus. */
export type ShortcutAction =
  | 'newTab'
  | 'newPrivateTab'
  | 'closeTab'
  | 'reopenTab'
  | 'focusOmnibox'
  | 'reload'
  | 'hardReload'
  | 'back'
  | 'forward'
  | 'find'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'nextTab'
  | 'prevTab'
  | 'lastTab'
  | 'tab1'
  | 'tab2'
  | 'tab3'
  | 'tab4'
  | 'tab5'
  | 'tab6'
  | 'tab7'
  | 'tab8'
  | 'devtools'
  | 'print'
  | 'bookmark'
  | 'bookmarksBar'
  | 'tabSearch'
  | 'history'
  | 'bookmarkManager'
  | 'verticalTabs'
  | 'newGroup'
  | 'split'
  | 'palette'

export interface ConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error'
  message: string
  source?: string
  line?: number
  at: string
}

/** One entry of a native menu (`submenu`: it opens these instead of running). */
export type MenuEntry = { label: string; enabled?: boolean; checked?: boolean; run: () => void; submenu?: MenuEntry[] } | { separator: true }

/** A page's request the user decides on (camera, notifications, another app, …). */
export interface PermissionAsk {
  tabId?: string
  origin: string
  kind: BrowserPermissionKind
  target?: string
  app?: string
}

/** A tab's back/forward list — what a restart brings back. */
export interface TabNavigation {
  entries: { url: string; title: string }[]
  /** The entry on screen. */
  index: number
}

/** Chrome DevTools Protocol on one tab, and its picture — what agents act through. */
export interface AutomationTarget {
  cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  /** The visible page as PNG (base64). */
  capture(): Promise<{ png: string; width: number; height: number }>
  /** The visible page as JPEG (base64), at most `width` pixels wide — a picture for another device. */
  preview(width: number, quality: number): Promise<{ jpeg: string; width: number; height: number }>
}

/** A server's question for a login (HTTP authentication). */
export interface LoginAsk {
  url: string
  /** host:port */
  host: string
  realm: string
  isProxy: boolean
}

/**
 * The web views behind the tabs. Implemented by the desktop app (Electron's
 * WebContentsView, `platform/browser`); the core decides, the host shows.
 * It also loads the user's Chrome extensions (into the user's profile).
 */
export interface BrowserHost extends ExtensionHost {
  /**
   * Create the tab's view and load `url`. `agent`: an agent works here (keeps running in the background).
   * `profile`: a private tab or the agents' container instead of the user's profile.
   * `history`: its back/forward list from before a restart, restored instead of loading `url` alone.
   */
  create(tabId: string, url: string, opts?: { agent?: boolean; zoom?: number; muted?: boolean; profile?: BrowserProfile; history?: TabNavigation }): void
  /** The last private tab closed: its cookies, cache and storage go. */
  clearPrivate(): void
  destroy(tabId: string): void
  /** The tab's back/forward list right now (undefined: no view). */
  navigation(tabId: string): TabNavigation | undefined
  load(tabId: string, url: string): void
  go(tabId: string, action: BrowserGo): void
  /**
   * The view on screen (undefined: none — the new-tab page or an error page shows instead);
   * `beside`: the other page of a split, on screen too once its pane is known.
   */
  show(tabId: string | undefined, beside?: string): void
  /**
   * Where views sit; null hides them all (the module is not on screen).
   * `focused`: the browser's pane has the focus, so its keys work from the UI too.
   * `panes`: in a split, where each of the two pages goes (else the page fills `bounds`).
   */
  setBounds(bounds: ViewBounds | null, focused?: boolean, panes?: BrowserPane[]): void
  /** Pictures of the visible views (data URLs by tab), which hide until `unfreeze`; null when none is visible. */
  freeze(): Promise<Record<string, string> | null>
  unfreeze(): void
  find(tabId: string, text: string, opts: { forward: boolean; next: boolean }): void
  stopFind(tabId: string): void
  setZoom(tabId: string, factor: number): void
  setMuted(tabId: string, muted: boolean): void
  devtools(tabId: string): void
  print(tabId: string): void
  /** A native menu at the mouse pointer. */
  popup(entries: MenuEntry[]): void
  /** Keyboard focus back to the Mindeck UI (the address bar), away from the page. */
  focusUi(): void
  /** Pages follow the UI's light/dark mode. */
  setTheme(theme: 'dark' | 'light' | 'system'): void
  automation(tabId: string): AutomationTarget
  dispose(): void
}

/** What the views report back to the core. */
export interface BrowserHostEvents {
  navigated(tabId: string, nav: { url: string; canGoBack: boolean; canGoForward: boolean; inPage?: boolean }): void
  title(tabId: string, title: string): void
  favicon(tabId: string, url: string | undefined): void
  loading(tabId: string, loading: boolean): void
  failed(tabId: string, error: TabError): void
  crashed(tabId: string): void
  audible(tabId: string, audible: boolean): void
  /** ⌘-scroll or pinch on the page. */
  zoomed(tabId: string, direction: 'in' | 'out'): void
  /** A link wants a new tab (target=_blank, ⌘-click, "Open in new tab"; `private`: "Open in private tab"). */
  openTab(url: string, opts: { background: boolean; opener?: string; private?: boolean }): void
  found(result: BrowserFind): void
  console(tabId: string, entry: ConsoleEntry): void
  shortcut(action: ShortcutAction, tabId?: string): void
  /** A page took the keyboard focus (the user clicked into it). */
  focused(tabId: string): void
  /** A workspace key pressed in a page (the UI has the keyboard again): the UI's to act on. */
  workspaceKey(key: WorkspaceKey): void
  /** The page's context menu wants something only the core knows. */
  command(tabId: string, command: 'sendToAgent' | 'search', arg?: string): void
  permission(ask: PermissionAsk, respond: (allow: boolean) => void): void
  /** Synchronous check for what the user allowed before (Chromium asks often). */
  permissionCheck(origin: string, kind: BrowserPermissionKind): boolean
  download(download: BrowserDownload, control: { cancel(): void }): void
  downloadUpdated(download: BrowserDownload): void
  /** Where downloads go ('' = the system's Downloads folder) and whether to ask each time. */
  downloadPrefs(): { ask: boolean; dir: string }
  /** A request of a page (`tabId` undefined: a popup window or an extension): blocked, redirected or let through. */
  request(tabId: string | undefined, req: { url: string; type: string; referrer: string }): RequestVerdict
  /** Element-hiding CSS for the page the tab just loaded ('' = none). */
  cosmetics(tabId: string, url: string): string
  /** Video or audio started (or stopped) playing. */
  media(tabId: string, playing: boolean): void
  /** A server asks for a login; `respond(null)` cancels. */
  login(tabId: string | undefined, ask: LoginAsk, respond: (credentials: { username: string; password: string } | null) => void): void
  /** The UI language, for menus the host draws itself. */
  locale(): 'de' | 'en'
  /** The search engine, for "Search for …" in the context menu. */
  searchLabel(): string
}
