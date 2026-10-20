import type { Session } from 'electron'

/** What any page of the session gets without a question: full screen and writing (sanitized) text to the clipboard. */
const HARMLESS = new Set(['fullscreen', 'clipboard-sanitized-write'])

const guarded = new WeakSet<Session>()

/**
 * Mindeck's own windows answer the web's permission questions themselves —
 * Electron's default says yes to everything (microphone, camera, location,
 * the screen, reading the clipboard, devices). Allowed: full screen and
 * copying; reading the clipboard (the terminal's Paste) only for a page
 * `trusted` names and only in its top frame. Everything else is refused
 * without a question. The browser's profiles have their own handlers
 * (`browser/session.ts`) that ask the user instead. Once per session.
 */
export function guardSession(ses: Session, trusted: (url: string) => boolean): void {
  if (guarded.has(ses)) return
  guarded.add(ses)
  const allows = (permission: string, url: string, mainFrame: boolean) =>
    HARMLESS.has(permission) || (permission === 'clipboard-read' && mainFrame && trusted(url))
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allows(permission, details.requestingUrl, details.isMainFrame)))
  ses.setPermissionCheckHandler((_contents, permission, _origin, details) => allows(permission, details.requestingUrl ?? '', details.isMainFrame))
  // No screen sharing, no USB/HID/serial devices.
  ses.setDisplayMediaRequestHandler((_request, callback) => callback(null))
  ses.setDevicePermissionHandler(() => false)
}
