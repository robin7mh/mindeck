import type { BrowserState, BrowserTab } from '@shared/types/browser'

/** A browser tab as the core reports it — defaults for everything not given. */
export const tab = (id: string, url: string, extra: Partial<BrowserTab> = {}): BrowserTab => ({
  id,
  url,
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  muted: false,
  pinned: false,
  zoom: 1,
  shared: false,
  ...extra
})

/** The browser's state as the core pushes it. */
export const state = (tabs: BrowserTab[], extra: Partial<BrowserState> = {}): BrowserState => ({
  available: true,
  tabs,
  activeId: tabs[0]?.id,
  closed: 0,
  downloads: [],
  permissions: [],
  devServers: [],
  groups: [],
  splits: [],
  ...extra
})

