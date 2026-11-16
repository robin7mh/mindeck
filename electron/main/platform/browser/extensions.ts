import { session, WebContentsView, type BrowserWindow } from 'electron'
import type { ViewBounds } from '@shared/types/browser'
import { BROWSER_PARTITION } from './session'

/** Chrome's limits for an extension popup. */
const MIN = { width: 25, height: 25 }
const MAX = { width: 800, height: 600 }
/** Until the page says how big it wants to be. */
const INITIAL = { width: 320, height: 240 }

/**
 * Loads an unpacked extension into the user's browser profile — once: the
 * session keeps it while Mindeck runs, also across windows.
 */
export async function loadExtension(path: string): Promise<{ id: string }> {
  const { extensions } = session.fromPartition(BROWSER_PARTITION)
  const loaded = extensions.getAllExtensions().find((e) => e.path === path)
  if (loaded) return { id: loaded.id }
  const extension = await extensions.loadExtension(path)
  return { id: extension.id }
}

export function unloadExtension(id: string): void {
  const { extensions } = session.fromPartition(BROWSER_PARTITION)
  if (extensions.getExtension(id)) extensions.removeExtension(id)
}

/**
 * An extension's toolbar popup (`action.default_popup`): its page in a view
 * of its own over the window, under the icon, as large as the page asks
 * (within Chrome's limits). Like Chrome's, it closes when it loses the focus,
 * on Escape, or when the page closes itself.
 */
export class ExtensionPopup {
  private view?: WebContentsView
  private anchor: ViewBounds = { x: 0, y: 0, width: 0, height: 0 }
  private size = INITIAL

  constructor(
    private readonly win: BrowserWindow,
    /** Links the popup opens go to a tab. */
    private readonly openTab: (url: string) => void
  ) {}

  open(url: string, anchor: ViewBounds): void {
    this.close()
    this.anchor = anchor
    this.size = INITIAL
    const view = new WebContentsView({
      webPreferences: { partition: BROWSER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, enablePreferredSizeMode: true }
    })
    this.view = view
    view.setVisible(false)
    this.win.contentView.addChildView(view)
    this.place()
    const c = view.webContents
    c.on('preferred-size-changed', (_e, size) => {
      this.size = {
        width: Math.max(MIN.width, Math.min(MAX.width, size.width)),
        height: Math.max(MIN.height, Math.min(MAX.height, size.height))
      }
      this.place()
      view.setVisible(true)
    })
    c.once('did-finish-load', () => {
      view.setVisible(true)
      c.focus()
    })
    c.on('blur', () => this.close(view))
    c.on('destroyed', () => this.close(view))
    c.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      event.preventDefault()
      this.close(view)
    })
    c.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) this.openTab(target)
      return { action: 'deny' }
    })
    void c.loadURL(url).catch(() => this.close(view))
  }

  /** Closes the popup (only `which`, when given — an older popup's late events leave a newer one alone). */
  close(which?: WebContentsView): void {
    const view = this.view
    if (!view || (which && which !== view)) return
    this.view = undefined
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  /** Under the icon, its right edge at the icon's, inside the window. */
  private place(): void {
    const zoom = this.win.webContents.getZoomFactor()
    const { width: winWidth } = this.win.getContentBounds()
    const { width, height } = this.size
    const right = Math.round((this.anchor.x + this.anchor.width) * zoom)
    const x = Math.max(0, Math.min(winWidth - width, right - width))
    const y = Math.round((this.anchor.y + this.anchor.height) * zoom) + 4
    this.view!.setBounds({ x, y, width, height })
  }
}
