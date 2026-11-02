// Chrome extensions in the Mindeck browser (architecture §12.9): installed
// from the Chrome Web Store, from a folder, or taken over from Chrome, Brave
// or Edge. Pure module (no DOM/Node/Electron) so it compiles under both tsconfigs.

/** Where an extension came from: the Web Store, a folder on disk ("load unpacked"), another browser's profile. */
export const EXTENSION_SOURCES = ['store', 'folder', 'profile'] as const
export type ExtensionSource = (typeof EXTENSION_SOURCES)[number]

/** Chromium browsers whose installed extensions Mindeck can take over. */
export const CHROMIUM_BROWSERS = ['chrome', 'brave', 'edge', 'chromium', 'vivaldi', 'arc'] as const
export type ChromiumBrowser = (typeof CHROMIUM_BROWSERS)[number]

export interface BrowserExtension {
  id: string
  name: string
  version: string
  description: string
  source: ExtensionSource
  enabled: boolean
  /** The toolbar icon (data URL). */
  icon?: string
  /** It has a toolbar popup (`action.default_popup`). */
  popup: boolean
  /** What it asks for: API permissions, then the sites it may read and change. */
  permissions: string[]
  /** APIs it asks for that Mindeck's Chromium (Electron) lacks — those features may not work. */
  unsupported: string[]
  /** Why it could not be loaded. */
  error?: string
  installedAt: string
}

/** An extension found in another browser's profile. */
export interface ProfileExtension {
  id: string
  name: string
  version: string
  /** Its unpacked folder (`Extensions/<id>/<version>`). */
  path: string
  /** Mindeck has an extension with this id already. */
  installed: boolean
}

/** A profile of Chrome, Brave, Edge … on this computer. */
export interface ChromiumProfile {
  browser: ChromiumBrowser
  /** The profile's name as the browser shows it ("Person 1", "Work"). */
  name: string
  path: string
  extensions: ProfileExtension[]
}

/** How an extension gets installed. */
export type ExtensionInstall =
  /** A Chrome Web Store address or a 32-letter extension id. */
  | { source: 'store'; input: string }
  /** An unpacked extension folder (loaded in place, like "Load unpacked"). */
  | { source: 'folder'; path?: string }
  /** An extension folder from another browser's profile (copied). */
  | { source: 'profile'; path: string }

export interface ExtensionUpdateReport {
  checked: number
  /** Names of the extensions that were updated. */
  updated: string[]
  failed: string[]
}
