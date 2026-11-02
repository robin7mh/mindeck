import type { WorkspaceAction } from './keys'
import { focusedPane } from './layout'
import { useWorkspace } from './store'

/** The element each pane last had the keyboard focus on — moving the focus there by key puts it back. */
const lastFocus = new Map<string, HTMLElement>()

export function rememberFocus(paneId: string, el: HTMLElement): void {
  lastFocus.set(paneId, el)
}

/**
 * Put the keyboard focus into a pane: where it was last, else on the pane
 * itself. Callers do it a frame later — a dialog that opened meanwhile (⌘/
 * typed right after the palette) keeps the focus.
 */
export function focusInto(paneId: string): void {
  const host = document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`)
  if (!host || host.contains(document.activeElement)) return
  if (document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')) return
  const last = lastFocus.get(paneId)
  if (last?.isConnected && host.contains(last)) last.focus({ preventScroll: true })
  else host.focus({ preventScroll: true })
}

/** The window's full screen: the desktop app's own, the page's in a browser. */
export function toggleFullScreen(): void {
  if (window.mindeck) return window.mindeck.toggleFullScreen()
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  else void document.documentElement.requestFullscreen?.().catch(() => {})
}

export function toggleZen(): void {
  const s = useWorkspace.getState()
  s.setZen(!s.zen)
}

/** Do what a shortcut (or a palette entry) asks. */
export function perform(action: WorkspaceAction): void {
  const s = useWorkspace.getState()
  switch (action.type) {
    case 'focus': {
      s.moveFocus(action.dir)
      // Once the pane is drawn (a maximized workspace shows it only now).
      const id = focusedPane(useWorkspace.getState().layout).id
      requestAnimationFrame(() => focusInto(id))
      return
    }
    case 'split':
      return s.split()
    case 'close':
      return s.close()
    case 'maximize':
      return s.toggleMaximize()
    case 'zen':
      return toggleZen()
    case 'fullscreen':
      return toggleFullScreen()
    case 'workspace':
      return s.apply(action.index)
  }
}
