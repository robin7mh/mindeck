// The Mindeck browser (architecture §12.9): real Chromium tabs inside the
// desktop window, which the user's agents can read and — with approval — use.
// Pure module (no DOM/Node/Electron) so it compiles under both tsconfigs.

import type { BrowserExtension } from './browserExtensions'

/** Search engines for what the address bar does not take as an address. */
export const SEARCH_ENGINES = ['google', 'duckduckgo', 'bing', 'ecosia', 'brave', 'kagi'] as const
export type SearchEngine = (typeof SEARCH_ENGINES)[number]

export interface BrowserSettings {
  searchEngine: SearchEngine
  /** Links clicked inside Mindeck (agent chats, notes) open in the Mindeck browser, not the system's. */
  openLinksInMindeck: boolean
  /** Block ads and trackers (filter lists, cached and updated daily). */
  adblock: boolean
  /** Warn before pages on a malware list open. */
  malwareProtection: boolean
  /** Tabs agents open use the user's own profile (logins, cookies) instead of the agents' container. */
  agentsUseLogins: boolean
  /** Ask where each download goes instead of saving it to `downloadDir`. */
  askDownloadLocation: boolean
  /** Where downloads go; '' = the system's Downloads folder. */
  downloadDir: string
  /** The address bar asks the search engine for suggestions (what is typed goes to it). */
  searchSuggestions: boolean
  /** The bookmarks bar under the toolbar (⌘⇧B). */
  bookmarksBar: boolean
  /** The tabs in a sidebar on the left instead of a strip on top (⌘⇧,). */
  verticalTabs: boolean
  /** The sidebar's width (CSS px) while it is open. */
  verticalTabsWidth: number
  /** The sidebar is folded to its icons. */
  verticalTabsCollapsed: boolean
}

/** The vertical tab sidebar's width: its bounds and where it starts. */
export const VERTICAL_TABS_WIDTH = { min: 160, max: 480, default: 240 } as const

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  searchEngine: 'google',
  openLinksInMindeck: true,
  searchSuggestions: true,
  bookmarksBar: true,
  verticalTabs: false,
  verticalTabsWidth: VERTICAL_TABS_WIDTH.default,
  verticalTabsCollapsed: false,
  adblock: true,
  malwareProtection: true,
  agentsUseLogins: false,
  askDownloadLocation: false,
  downloadDir: ''
}

/**
 * Whose cookies and logins a tab uses: the user's profile (absent), a
 * private tab (in memory only, gone with the last private tab), or the
 * agents' container (`persist:mindeck-agents`, without the user's logins).
 */
export type BrowserProfile = 'private' | 'agents'

/** What an agent did in a tab — the UI says it in its language. */
export type AgentAction = 'open' | 'navigate' | 'read' | 'snapshot' | 'screenshot' | 'console' | 'click' | 'type' | 'press'

export interface AgentActivity {
  name: string
  action: AgentAction
  /** What it acted on (a button's name, an address). */
  detail?: string
  at: string
}

/** A main-frame load that failed (Chromium's net error code and text). */
export interface TabError {
  code: number
  description: string
  url: string
  /** Mindeck stopped it: the address is on a malware list. */
  danger?: 'malware'
}

export interface BrowserTab {
  id: string
  /** '' = the new-tab page (drawn by Mindeck, no web page behind it). */
  url: string
  title: string
  /** The page's favicon (http, https or data URL). */
  favicon?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Playing sound right now. */
  audible: boolean
  muted: boolean
  pinned: boolean
  /** Page zoom, 1 = 100 %. */
  zoom: number
  /** Agents may see this tab: local dev pages, tabs an agent opened, tabs the user shared. */
  shared: boolean
  /** The agent that opened this tab. */
  openedBy?: string
  /** The latest thing an agent did here. */
  agent?: AgentActivity
  error?: TabError
  /** The page's renderer process died. */
  crashed?: boolean
  /** Not the user's profile: a private tab or the agents' container. */
  profile?: BrowserProfile
  /** Ad and tracker blocking on this page's site (web pages only). */
  shield?: { on: boolean; blocked: number }
  /** Video or audio plays (perhaps silently). */
  playing?: boolean
  /** The page needs DRM (Widevine), which Mindeck's Chromium does not have. */
  drm?: boolean
  /** The tab group it belongs to. */
  groupId?: string
}

/** The colors a tab group can have — the UI's accent tokens. */
export const TAB_GROUP_COLORS = ['cyan', 'blue', 'purple', 'green', 'amber', 'danger'] as const
export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number]

/** Tabs that belong together: one run in the tab order, under a name and a color. */
export interface BrowserTabGroup {
  id: string
  /** '' = no name (the group shows as its color only). */
  title: string
  color: TabGroupColor
  /** Its tabs are folded away behind the group's chip. */
  collapsed: boolean
  /** A group of private tabs — private and other tabs never share a group. */
  private?: boolean
}

/** Two tabs side by side (or one above the other) in the browser's page area. */
export interface BrowserSplit {
  id: string
  /** The left (top) tab, then the right (bottom) one. */
  tabs: [string, string]
  /** The first tab's share of the space, 0.1–0.9. */
  ratio: number
  /** One above the other instead of side by side. */
  vertical?: boolean
}

/** Where a tab's page sits when two are on screen (split view). */
export interface BrowserPane {
  id: string
  bounds: ViewBounds
}

export interface BrowserDownload {
  id: string
  filename: string
  /** Where the file is saved. */
  path: string
  url: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  received: number
  /** 0 when the server did not say. */
  total: number
  startedAt: string
  /** From a private tab: listed while private tabs are open, never written down. */
  private?: boolean
}

export type BrowserPermissionKind =
  | 'camera'
  | 'microphone'
  | 'media'
  | 'notifications'
  | 'geolocation'
  | 'clipboard'
  | 'screen'
  | 'external'

/** A page asks for something only the user can allow. */
export interface BrowserPermissionRequest {
  id: string
  tabId?: string
  origin: string
  kind: BrowserPermissionKind
  /** 'external': the link another app would open, and that app's name. */
  target?: string
  app?: string
}

/** A local dev server Mindeck saw starting in a terminal. */
export interface DevServer {
  url: string
  /** host:port, for display. */
  label: string
  terminalId: string
  projectId?: string
  detectedAt: string
}

export interface BrowserState {
  /** The desktop window hosts the browser (false on a headless core). */
  available: boolean
  tabs: BrowserTab[]
  activeId?: string
  /** How many closed tabs ⌘⇧T can bring back. */
  closed: number
  downloads: BrowserDownload[]
  permissions: BrowserPermissionRequest[]
  devServers: DevServer[]
  /** Mindeck quit unexpectedly: this many tabs of that session wait to be restored (or dismissed). */
  restorable?: number
  /** Pages asking for a user name and password (HTTP authentication). */
  auth?: BrowserAuthRequest[]
  /** Installed Chrome extensions. */
  extensions?: BrowserExtension[]
  /** Tab groups, in the order of their tabs. */
  groups: BrowserTabGroup[]
  /** Pairs of tabs shown side by side; the active tab's pair is on screen, `activeId` is its focused side. */
  splits: BrowserSplit[]
}

/** A server asks for a user name and password (HTTP Basic/Digest, or a proxy). */
export interface BrowserAuthRequest {
  id: string
  tabId?: string
  /** host:port */
  host: string
  realm: string
  isProxy: boolean
}

export interface BrowserSuggestion {
  /**
   * navigate: an address · search: the search engine · history: a visited page · tab: switch to an open tab ·
   * bookmark: a saved page · suggestion: what the search engine suggests for the words typed.
   */
  kind: 'navigate' | 'search' | 'history' | 'tab' | 'bookmark' | 'suggestion'
  url: string
  title: string
  tabId?: string
}

export interface HistoryEntry {
  url: string
  title: string
  visits: number
  lastVisit: string
}

/** In-page search progress (`active` of `matches`). */
export interface BrowserFind {
  tabId: string
  active: number
  matches: number
}

/** Where the web view sits in the window (CSS pixels of the Mindeck UI). */
export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserGo = 'back' | 'forward' | 'reload' | 'hardReload' | 'stop'

/** A tab's picture for another device (`browser:capture`): JPEG, and the page's size to map taps onto. */
export interface BrowserCapture {
  /** `data:image/jpeg;base64,…` */
  image: string
  /** The picture's size in pixels. */
  width: number
  height: number
  /** The page's visible area in CSS pixels — where `browser:input` coordinates live. */
  viewport: { width: number; height: number }
}

/** What another device does on a tab (`browser:input`): coordinates in the page's CSS pixels. */
export type BrowserInput =
  | { action: 'click'; x: number; y: number }
  | { action: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { action: 'type'; text: string }
  | { action: 'key'; key: BrowserKey }

/** Keys a phone keyboard can't send as text. */
export const BROWSER_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Delete'] as const
export type BrowserKey = (typeof BROWSER_KEYS)[number]

/** Native menus and tools of a tab. */
export type BrowserTool = 'tabMenu' | 'pageMenu' | 'devtools' | 'print' | 'handoff' | 'shield'

/** A workspace key pressed while a page had the keyboard — handed on to the Mindeck UI (`browser:command`). */
export interface WorkspaceKey {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** What a shortcut or menu asks the Mindeck UI to do (the page may have the keyboard focus). */
export type BrowserCommand =
  | 'focusOmnibox'
  | 'find'
  | 'sendToAgent'
  | 'settings'
  | 'focused'
  | 'tabSearch'
  | 'bookmark'
  | 'bookmarksBar'
  | 'import'
  | 'workspaceKey'
  | 'verticalTabs'
  | 'editGroup'
  | 'palette'
