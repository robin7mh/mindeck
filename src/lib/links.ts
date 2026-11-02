import type { MouseEvent } from 'react'

/** Addresses that may leave the app: the web and mail — no `javascript:`, `file:`, app schemes. */
export const isExternalUrl = (url: string): boolean => /^(https?:\/\/|mailto:)/i.test(url)

/**
 * Opens a web or mail address outside Mindeck (Electron: main routes
 * window.open to Mindeck's browser or the OS; web UI: a new tab). Always
 * without `opener` and referrer, so the page cannot steer the Mindeck tab
 * (reverse tabnabbing). Anything else is ignored. True when it opened.
 */
export function openExternal(url: string): boolean {
  if (!isExternalUrl(url)) return false
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}

/**
 * Click handler for rendered Markdown: a link never navigates the app's own
 * window or tab — web and mail addresses open outside, everything else (a
 * relative path, an anchor, a wikilink) does nothing here.
 */
export function interceptLinks(e: MouseEvent<HTMLElement>): void {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  e.preventDefault()
  openExternal(a.getAttribute('href') ?? '')
}
