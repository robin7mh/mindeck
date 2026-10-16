import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import {
  DEFAULT_SERVER_CONFIG,
  type CoreMode,
  type Device,
  type DeviceRole,
  type PairingCode,
  type ServerConfig,
  type ServerStatus
} from '@shared/types/server'
import type { IpcEvent } from '@shared/ipc/contract'
import type { Router } from '../../ipc/router'
import type { EventHub } from '../core/EventHub'
import type { AuthService } from '../services/auth/AuthService'
import type { SettingsService } from '../services/settings/SettingsService'
import type { Certificates, TlsCredentials } from './Certificates'
import { HttpServer, allowedHostsFromEnv } from './HttpServer'
import { rateLimitsFromEnv } from './RateLimit'

/** How often a running HTTPS server checks that its certificate still fits (end, addresses). */
const RENEW_CHECK_MS = 12 * 60 * 60_000

/**
 * Whether the server speaks HTTPS: when it is switched on and the network can
 * reach the core — or the core was given a certificate of its own.
 */
export function tlsWanted(config: ServerConfig, ownCertificate: boolean): boolean {
  return config.tls && (config.lan || ownCertificate)
}

/** Non-internal IPv4 addresses — what a phone on the same network can reach. */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  return Object.values(ifaces)
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
}

export interface ServerControllerOptions {
  mode: CoreMode
  version: string
  router: Router
  hub: EventHub
  auth: AuthService
  /** Desktop: config lives in settings and is editable. */
  settings?: SettingsService
  /** Standalone: fixed config from the environment. */
  fixedConfig?: ServerConfig
  webRoot?: string
  /** The TLS certificate (self-signed in the data folder, or one from the environment). */
  certificates: Certificates
  onClients?: (count: number) => void
  /** Push events as paired devices may see them (RemoteScope). */
  scope?: (channel: IpcEvent, payload: unknown) => Promise<unknown>
  /** Injected for tests. */
  addresses?: () => string[]
  createServer?: (opts: ConstructorParameters<typeof HttpServer>[0]) => HttpServer
}

/**
 * Owns the network API's lifecycle and configuration. On the desktop the
 * server is opt-in (Settings → Server), bound to 127.0.0.1 unless LAN access
 * is switched on; the standalone server is always on with its env config.
 * The network gets HTTPS only (unless switched off), with the certificate from
 * `Certificates`.
 */
export class ServerController {
  private http?: HttpServer
  /** The certificate the running server presents. */
  private tls?: TlsCredentials
  private renewTimer?: NodeJS.Timeout
  private error?: string
  private config: ServerConfig

  constructor(private readonly opts: ServerControllerOptions) {
    this.config = opts.fixedConfig ?? { ...DEFAULT_SERVER_CONFIG, ...opts.settings?.get().server }
  }

  remoteTerminal(): boolean {
    return this.config.remoteTerminal
  }

  /** The folders shared with paired devices. */
  remoteRoots(): string[] {
    return [...this.config.remoteRoots]
  }

  status(): ServerStatus {
    return {
      config: { ...this.config },
      running: !!this.http,
      urls: this.urls(),
      error: this.error,
      configurable: !this.opts.fixedConfig,
      ...(this.tls
        ? { tls: { fingerprint: this.tls.fingerprint, spkiFingerprint: this.tls.spkiFingerprint, expiresAt: this.tls.expiresAt, selfSigned: this.tls.selfSigned } }
        : {})
    }
  }

  /** Start if enabled (desktop) or always (standalone). Errors are kept in status. */
  async start(): Promise<void> {
    if (this.http || !this.config.enabled) return
    const http = (this.opts.createServer ?? ((o) => new HttpServer(o)))({
      router: this.opts.router,
      hub: this.opts.hub,
      auth: this.opts.auth,
      mode: this.opts.mode,
      version: this.opts.version,
      webRoot: this.opts.webRoot,
      remoteTerminal: () => this.config.remoteTerminal,
      onClients: this.opts.onClients,
      scope: this.opts.scope,
      allowedHosts: allowedHostsFromEnv(),
      rateLimits: rateLimitsFromEnv()
    })
    try {
      // No plain fallback: a certificate that cannot be made or read keeps the server off.
      const tls = this.secure() ? await this.opts.certificates.credentials(this.lanAddresses()) : undefined
      await http.listen(this.host(), this.config.port, tls)
      this.http = http
      this.tls = tls
      this.error = undefined
      if (tls) {
        this.renewTimer = setInterval(() => void this.renewTls(), RENEW_CHECK_MS)
        this.renewTimer.unref()
      }
    } catch (err) {
      this.error = (err as Error).message
      await http.close()
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.renewTimer)
    const http = this.http
    this.http = this.tls = this.renewTimer = undefined
    await http?.close()
  }

  /**
   * A running HTTPS server gets a new certificate when its own nears its end
   * or misses an address the computer has now (e.g. another Wi-Fi). Checked
   * twice a day and before every pairing — the QR code names the certificate.
   */
  async renewTls(): Promise<void> {
    const { http, tls } = this
    if (!http || !tls) return
    try {
      const next = await this.opts.certificates.credentials(this.lanAddresses())
      if (next.fingerprint === tls.fingerprint || this.http !== http) return
      http.setTls(next)
      this.tls = next
    } catch (err) {
      this.error = (err as Error).message
    }
  }

  /** Desktop only: change settings, persist, and restart when needed. */
  async configure(patch: Partial<ServerConfig>): Promise<ServerStatus> {
    if (this.opts.fixedConfig || !this.opts.settings) {
      throw Object.assign(new Error('This server is configured through its environment'), { code: 'not-configurable' })
    }
    const next = { ...this.config, ...patch }
    const restart = (['enabled', 'lan', 'tls', 'port'] as const).some((k) => next[k] !== this.config[k])
    // What devices may see changes: events kept for their reconnect were sorted by the old rules.
    const rescope = next.remoteTerminal !== this.config.remoteTerminal || next.remoteRoots.join('\n') !== this.config.remoteRoots.join('\n')
    this.config = next
    if (rescope) this.http?.resetReplay()
    await this.opts.settings.update({ server: next })
    if (restart) {
      await this.stop()
      await this.start()
    }
    return this.status()
  }

  async createPairingCode(role?: DeviceRole): Promise<PairingCode> {
    await this.renewTls()
    const code = await this.opts.auth.createPairingCode(role)
    return { ...code, urls: this.urls(), ...(this.tls ? { fingerprint: this.tls.fingerprint, spkiFingerprint: this.tls.spkiFingerprint } : {}) }
  }

  devices(): Promise<Device[]> {
    return this.opts.auth.devices()
  }

  setDeviceRole(id: string, role: DeviceRole): Promise<Device[]> {
    return this.opts.auth.setRole(id, role)
  }

  /** Share the browser with a device or stop: its next call and push already go by it. */
  setDeviceBrowser(id: string, browser: boolean): Promise<Device[]> {
    return this.opts.auth.setBrowser(id, browser)
  }

  async revoke(id: string): Promise<void> {
    await this.opts.auth.revoke(id)
    this.http?.disconnectDevice(id)
  }

  private host(): string {
    return this.config.lan ? '0.0.0.0' : '127.0.0.1'
  }

  private secure(): boolean {
    return tlsWanted(this.config, this.opts.certificates.custom)
  }

  private lanAddresses(): string[] {
    return this.config.lan ? (this.opts.addresses ?? lanAddresses)() : []
  }

  private urls(): string[] {
    const port = this.http?.port || this.config.port // the bound port (port 0 = any free one)
    const scheme = this.secure() ? 'https' : 'http'
    // This computer may keep plain HTTP — but a headless core mostly runs in Docker, where
    // "127.0.0.1" on the host is a forwarded port, not loopback for the core: HTTPS there too.
    const local = this.opts.mode === 'server' ? scheme : 'http'
    return [`${local}://127.0.0.1:${port}`, ...this.lanAddresses().map((h) => `${scheme}://${h}:${port}`)]
  }
}
