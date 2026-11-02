import type { ProcessInfo, SystemSnapshot } from '@shared/types/system'
import { collect, collectProcesses, currentUser } from './collectors'

/**
 * Samples system telemetry and pushes it to the renderer via an injected sender.
 * The interval only runs while there is at least one subscriber AND the window
 * is not paused (minimized/hidden) — so a backgrounded app costs nothing.
 * The expensive process scan runs on a slower cadence than the cheap metrics,
 * in the background, so it never delays a tick.
 */
export class SystemService {
  private subscribers = 0
  private remoteClients = 0
  private paused = false
  private timer: NodeJS.Timeout | null = null
  private tickCount = 0
  private lastProcesses: ProcessInfo[] = []
  private scanning = false
  private sampling = false

  constructor(
    private readonly send: (snapshot: SystemSnapshot) => void,
    private readonly intervalMs = 1500,
    private readonly processEveryNTicks = 3
  ) {}

  subscribe(): void {
    this.subscribers += 1
    this.evaluate()
  }

  unsubscribe(): void {
    this.subscribers = Math.max(0, this.subscribers - 1)
    this.evaluate()
  }

  /**
   * Connected network clients (web UI / phone). They keep sampling alive even
   * while the desktop window is hidden — someone is still watching.
   */
  setRemoteClients(count: number): void {
    this.remoteClients = Math.max(0, count)
    this.evaluate()
  }

  /** Called from window visibility events to stop sampling when hidden. */
  setPaused(paused: boolean): void {
    this.paused = paused
    this.evaluate()
  }

  /** OS account display name, for the dashboard greeting. */
  user(): Promise<{ name: string; firstName: string }> {
    return currentUser()
  }

  async snapshot(): Promise<SystemSnapshot> {
    void this.refreshProcesses()
    return collect(this.lastProcesses)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private evaluate(): void {
    const shouldRun = (this.subscribers > 0 && !this.paused) || this.remoteClients > 0
    if (shouldRun && !this.timer) {
      void this.tick() // immediate first sample
      this.timer = setInterval(() => void this.tick(), this.intervalMs)
    } else if (!shouldRun && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    // A sample still in flight (e.g. `df` stuck on a dead network mount): skip, don't pile up processes.
    if (this.sampling) return
    this.sampling = true
    this.tickCount += 1
    if (this.tickCount % this.processEveryNTicks === 1) void this.refreshProcesses()
    try {
      this.send(await collect(this.lastProcesses))
    } catch {
      // Skip a bad sample rather than crash the sampler.
    } finally {
      this.sampling = false
    }
  }

  private async refreshProcesses(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      this.lastProcesses = await collectProcesses()
    } catch {
      // Keep the previous list on a failed scan.
    } finally {
      this.scanning = false
    }
  }
}
