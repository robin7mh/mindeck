import type { CloseBehavior } from '@shared/types/desktop'

/** What closing the window or quitting would end. */
export interface Running {
  agents: number
  terminals: number
}

/** The main window as far as the lifecycle needs it (an Electron BrowserWindow). */
export interface LifecycleWindow {
  hide(): void
  show(): void
  focus(): void
  restore(): void
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
  isDestroyed(): boolean
}

export interface AskOptions {
  type: 'warning' | 'error'
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  checkboxLabel?: string
  /** Closes the dialog (the window became responsive again). */
  signal?: AbortSignal
}

/** The tray icon while Mindeck runs in the background (Windows/Linux). */
export interface TrayHandle {
  destroy(): void
}

export interface LifecycleDeps {
  platform: NodeJS.Platform
  running(): Running
  closeBehavior(): CloseBehavior
  remember(choice: CloseBehavior): Promise<unknown>
  /** A native message box (Electron's dialog.showMessageBox). */
  ask(options: AskOptions): Promise<{ response: number; checkboxChecked: boolean }>
  locale(): 'de' | 'en'
  createTray(labels: LifecycleLabels, actions: { show(): void; quit(): void }): TrayHandle
  /** app.quit() */
  quit(): void
  /** Loads Mindeck's page again in the window. */
  reload(): void
  now?: () => number
}

/** Focus within this long still counts as using Mindeck (reading, switching windows briefly). */
export const FOCUS_GRACE_MS = 2 * 60_000
/** Two renderer crashes within this long: ask instead of reloading in a loop. */
export const CRASH_WINDOW_MS = 60_000

const EN = {
  running: ({ agents, terminals }: Running) => {
    const parts = [agents && `${agents} agent session${agents === 1 ? '' : 's'}`, terminals && `${terminals} terminal${terminals === 1 ? '' : 's'}`].filter(Boolean)
    return `${parts.join(' and ')} ${agents + terminals === 1 ? 'is' : 'are'} still running`
  },
  closeDetail: 'Mindeck can keep running in the background — open it again from the tray icon. Quitting ends them.',
  quitDetail: 'Quitting Mindeck ends them.',
  keepRunning: 'Keep running in background',
  quit: 'Quit Mindeck',
  cancel: 'Cancel',
  remember: 'Remember my choice (Settings → Desktop app)',
  show: 'Show Mindeck',
  tooltip: 'Mindeck — running in the background',
  crashedTitle: 'Mindeck’s window crashed again',
  crashedDetail: 'Agents and terminals are still running. Reload the window, or quit Mindeck. The details are in the log (Settings → Desktop app).',
  reload: 'Reload',
  hangTitle: 'Mindeck’s window is not responding',
  hangDetail: 'You can wait for it, or reload the window (agents and terminals keep running).',
  wait: 'Wait'
}

const DE: typeof EN = {
  running: ({ agents, terminals }) => {
    const parts = [agents && `${agents} Agent-Sitzung${agents === 1 ? '' : 'en'}`, terminals && `${terminals} Terminal${terminals === 1 ? '' : 's'}`].filter(Boolean)
    return `${parts.join(' und ')} ${agents + terminals === 1 ? 'läuft' : 'laufen'} noch`
  },
  closeDetail: 'Mindeck kann im Hintergrund weiterlaufen – über das Symbol im Infobereich öffnest du es wieder. Beenden beendet sie.',
  quitDetail: 'Wenn du Mindeck beendest, werden sie beendet.',
  keepRunning: 'Im Hintergrund weiterlaufen',
  quit: 'Mindeck beenden',
  cancel: 'Abbrechen',
  remember: 'Auswahl merken (Einstellungen → Desktop-App)',
  show: 'Mindeck zeigen',
  tooltip: 'Mindeck – läuft im Hintergrund',
  crashedTitle: 'Das Mindeck-Fenster ist erneut abgestürzt',
  crashedDetail: 'Agenten und Terminals laufen weiter. Lade das Fenster neu oder beende Mindeck. Details stehen im Log (Einstellungen → Desktop-App).',
  reload: 'Neu laden',
  hangTitle: 'Das Mindeck-Fenster reagiert nicht',
  hangDetail: 'Du kannst warten oder das Fenster neu laden (Agenten und Terminals laufen weiter).',
  wait: 'Warten'
}

export type LifecycleLabels = typeof EN

export function lifecycleLabels(locale: 'de' | 'en'): LifecycleLabels {
  return locale === 'de' ? DE : EN
}

/**
 * Someone is using Mindeck — what the trial clock counts: its window is on
 * screen and focused (or was, within FOCUS_GRACE_MS) and the user is at the
 * computer. Mindeck running in the background, hidden or minimized does not
 * count.
 */
export function usingMindeck(win: LifecycleWindow | null, lastFocusAt: number, now: number, userIdle: boolean): boolean {
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || userIdle) return false
  return win.isFocused() || now - lastFocusAt <= FOCUS_GRACE_MS
}

/**
 * What closing the window, quitting and a crashed window mean for the work
 * that runs in Mindeck. Closing the window never ends agents or terminals
 * unasked: macOS keeps Mindeck running in the background (the Dock brings it
 * back); Windows and Linux ask — keep running with a tray icon, or quit — and
 * may remember the answer. Quitting while work runs asks first.
 */
export class DesktopLifecycle {
  private quitting = false
  private asking = false
  private tray: TrayHandle | null = null
  private crashes: number[] = []
  private hang: AbortController | null = null
  private readonly now: () => number

  constructor(private readonly deps: LifecycleDeps) {
    this.now = deps.now ?? Date.now
  }

  /** A real quit is under way (confirmed, or nothing was running). */
  get isQuitting(): boolean {
    return this.quitting
  }

  private labels(): LifecycleLabels {
    return lifecycleLabels(this.deps.locale())
  }

  private busy(): Running | null {
    const r = this.deps.running()
    return r.agents + r.terminals > 0 ? r : null
  }

  /** The window's `close` event: let it close, or keep Mindeck running in the background. */
  onClose(win: LifecycleWindow, event: { preventDefault(): void }): void {
    if (this.quitting) return
    const running = this.busy()
    if (!running) return // nothing would be lost
    event.preventDefault()
    if (this.deps.platform === 'darwin') return this.background(win)
    const choice = this.deps.closeBehavior()
    if (choice === 'background') return this.background(win)
    if (choice === 'quit') return this.quitNow()
    void this.askOnClose(win, running)
  }

  private async askOnClose(win: LifecycleWindow, running: Running): Promise<void> {
    if (this.asking) return
    this.asking = true
    const l = this.labels()
    try {
      const { response, checkboxChecked } = await this.deps.ask({
        type: 'warning',
        message: l.running(running),
        detail: l.closeDetail,
        buttons: [l.keepRunning, l.quit, l.cancel],
        defaultId: 0,
        cancelId: 2,
        checkboxLabel: l.remember
      })
      if (response === 2) return
      const choice: CloseBehavior = response === 0 ? 'background' : 'quit'
      if (checkboxChecked) await this.deps.remember(choice).catch(() => {})
      if (choice === 'background') this.background(win)
      else this.quitNow()
    } finally {
      this.asking = false
    }
  }

  /** The app's `before-quit` (⌘Q, the tray, the menu, an update): confirm while work runs. */
  onBeforeQuit(event: { preventDefault(): void }): void {
    if (this.quitting) return
    const running = this.busy()
    if (!running) {
      this.quitting = true
      return
    }
    event.preventDefault()
    void this.askOnQuit(running)
  }

  private async askOnQuit(running: Running): Promise<void> {
    if (this.asking) return
    this.asking = true
    const l = this.labels()
    try {
      const { response } = await this.deps.ask({ type: 'warning', message: l.running(running), detail: l.quitDetail, buttons: [l.quit, l.cancel], defaultId: 1, cancelId: 1 })
      if (response === 0) this.quitNow()
    } finally {
      this.asking = false
    }
  }

  /** The quit did not happen after all (the editor's unsaved changes kept a window open). */
  cancelQuit(): void {
    this.quitting = false
  }

  /** Quit without asking again: it was asked (or chosen) already. */
  quitNow(): void {
    this.quitting = true
    this.dropTray()
    this.deps.quit()
  }

  /** Hide the window; Mindeck keeps running (Windows/Linux: with a tray icon). */
  background(win: LifecycleWindow): void {
    win.hide()
    if (this.deps.platform === 'darwin' || this.tray) return
    this.tray = this.deps.createTray(this.labels(), { show: () => this.reveal(win), quit: () => this.deps.quit() })
  }

  /** Bring the window back (the Dock, the tray, a notification, a second start). */
  reveal(win: LifecycleWindow): void {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    this.dropTray()
  }

  private dropTray(): void {
    this.tray?.destroy()
    this.tray = null
  }

  /**
   * The window's renderer is gone (a crash, killed, out of memory): reload it
   * — Mindeck's work runs in this process and goes on. A second crash within
   * CRASH_WINDOW_MS asks instead of reloading in a loop.
   */
  async onRendererGone(reason: string): Promise<void> {
    if (reason === 'clean-exit' || this.quitting) return
    const now = this.now()
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now]
    if (this.crashes.length < 2) return this.deps.reload()
    const l = this.labels()
    const { response } = await this.deps.ask({
      type: 'error',
      message: l.crashedTitle,
      detail: l.crashedDetail,
      buttons: [l.reload, l.quit],
      defaultId: 0,
      cancelId: 0
    })
    if (response === 1) return this.quitNow()
    this.crashes = []
    this.deps.reload()
  }

  /** The window stopped responding: offer to reload it (the dialog goes when it recovers). */
  async onUnresponsive(): Promise<void> {
    if (this.hang || this.quitting) return
    const hang = new AbortController()
    this.hang = hang
    const l = this.labels()
    try {
      const { response } = await this.deps.ask({
        type: 'warning',
        message: l.hangTitle,
        detail: l.hangDetail,
        buttons: [l.wait, l.reload],
        defaultId: 0,
        cancelId: 0,
        signal: hang.signal
      })
      if (response === 1 && !hang.signal.aborted) this.deps.reload()
    } finally {
      this.hang = null
    }
  }

  onResponsive(): void {
    this.hang?.abort()
  }
}
