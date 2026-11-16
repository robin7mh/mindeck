import type { NodeLauncher } from '../lib/nodeProcess'
import type { RestorableTrash } from './trash'

/**
 * What the core needs from its host. The same services run inside Electron
 * (desktop: native dialogs, Finder, OS trash) and as a headless Node server
 * (Docker / home server: no GUI on the host, so pickers and "open on this
 * machine" are unavailable and the trash is the vault's own `.trash`).
 */
export interface Platform {
  readonly kind: 'desktop' | 'server'
  /** Native folder picker; null on cancel. Absent where the host has no GUI. */
  pickFolder?: (title: string) => Promise<string | null>
  /** Open a file or folder with the host's default app. Absent on a server. */
  openPath?: (path: string) => Promise<void>
  /** Show a file or folder in the OS file manager (Finder), selected. Absent on a server. */
  revealPath?: (path: string) => void
  /** Hand a link to the app registered for it (browser, GitHub Desktop, …). Absent on a server. */
  openExternal?: (url: string) => Promise<void>
  /** Name of the app that handles links like `url` (`scheme://`), '' if none. Absent on a server. */
  appForUrl?: (url: string) => string
  /** Move a file to a recoverable trash. `root` is the vault it belongs to. */
  trashItem: (path: string, root: string) => Promise<void>
  /** A trash Mindeck can also put things back from (the desktop app) — Files' ⌘Z after trashing. */
  restorableTrash?: RestorableTrash
  /** Files on the system clipboard (Finder / Explorer copy and paste). Absent on a server. */
  fileClipboard?: { write(paths: string[], cut: boolean): Promise<void>; read(): Promise<string[]> }
  /**
   * A window on a remote core's web UI (Remote-SSH, Dev Container), signed in
   * with its device token. Resolves once it is closed. Absent on a server.
   */
  openRemoteWindow?: (opts: { title: string; url: string; token: string; deviceId: string }) => { closed: Promise<void>; close: () => void }
  /**
   * How Node programs run (tsserver, the lint worker, the PHP debug adapter,
   * the Dev Containers CLI): the desktop's in Electron utility processes. Absent:
   * `process.execPath` is a real Node (the headless core).
   */
  node?: NodeLauncher
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** The error every desktop-only capability raises on a headless host. */
export const desktopOnly = (what: string): Error =>
  coded('desktop-only', `${what} is only available in the Mindeck desktop app`)
