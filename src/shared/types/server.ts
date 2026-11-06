// The Mindeck core as a network service: the same services the desktop app
// uses, reachable over HTTP + WebSocket by the web UI and the mobile app.
// Pure module (no DOM/Node/Electron) so it compiles under every tsconfig.

/** Where the core runs: inside the Electron app, or headless (Docker/server). */
export type CoreMode = 'desktop' | 'server'

export interface AppInfo {
  mode: CoreMode
  version: string
  /** Host OS (`process.platform`) and machine name — what the core sees. */
  platform: string
  hostname: string
  /** Whether remote clients may open shells (opt-in). */
  remoteTerminal: boolean
  /**
   * The core is reachable through the Mindeck Cloud relay (signed in, "Away
   * access" on): a paired phone dials it there by this id when the Wi-Fi
   * does not reach it. The pinned TLS inside keeps the cloud out.
   */
  relay?: { installId: string }
}

/** Embedded/standalone API server settings. */
export interface ServerConfig {
  /** Desktop only: run the API server inside the app (standalone: always on). */
  enabled: boolean
  /** Listen on all interfaces (LAN/phone) instead of 127.0.0.1 only. */
  lan: boolean
  /**
   * Encrypt the network: with `lan`, other devices reach the core over HTTPS
   * (and WSS) only — a self-signed certificate, trusted by its fingerprint.
   * The core's own computer may still use plain HTTP on 127.0.0.1.
   */
  tls: boolean
  port: number
  /** Remote clients may open real shells. Off by default. */
  remoteTerminal: boolean
  /**
   * Folders paired devices may browse and add as projects or vault (absolute
   * paths), besides the projects added at the desktop. Without remote shells
   * they are all a device can reach.
   */
  remoteRoots: string[]
  /**
   * "Away access": the core keeps a connection out to Mindeck Cloud, and paired
   * phones reach it through there from anywhere (mobile data, another Wi-Fi).
   * The cloud passes bytes of the TLS the phone pinned at pairing — it reads
   * nothing. Needs the account signed in and `tls`. On by default.
   */
  relay: boolean
  /** Desktop: the Mac does not go to sleep on its own while it is on power and away access is on. */
  keepAwake: boolean
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  enabled: false,
  lan: false,
  tls: true,
  port: 7420,
  remoteTerminal: false,
  remoteRoots: [],
  relay: true,
  keepAwake: false
}

/**
 * Where the relay link stands. `off`: switched off. `unavailable`: it would
 * be on but cannot run (`reason`: the server is off, TLS is off, the account
 * is signed out). `connecting` / `online` / `error` as they say.
 */
export type RelayState = 'off' | 'unavailable' | 'connecting' | 'online' | 'error'

export interface RelayStatus {
  state: RelayState
  /** Why it is unavailable or failed: `server-off`, `tls-off`, `signed-out`, `session-invalid`, `replaced`, or the cloud's error code. */
  reason?: string
  /** Online since (ISO). */
  since?: string
  /** Pipes open now (phones' connections through the cloud). */
  pipes?: number
}

export interface ServerStatus {
  config: ServerConfig
  running: boolean
  /** Base URLs a client can use (loopback, plus LAN addresses when `lan`). */
  urls: string[]
  /** Last start error (e.g. port in use). */
  error?: string
  /** False when the settings come from the environment (standalone server). */
  configurable: boolean
  /** The certificate the running server presents (only while it speaks HTTPS). */
  tls?: TlsInfo
  /** The link to Mindeck Cloud that lets paired phones in from anywhere. */
  relay?: RelayStatus
}

/** The certificate of a core that speaks HTTPS. */
export interface TlsInfo {
  /** SHA-256 of the certificate, `AB:CD:…` — what a browser's certificate viewer shows. */
  fingerprint: string
  /**
   * SHA-256 of the certificate's public key (its DER SubjectPublicKeyInfo), `AB:CD:…`. The core
   * renews its certificate on the same key (a new address, the end of its validity), so this one
   * stays when `fingerprint` changes: what a native client should pin.
   */
  spkiFingerprint: string
  expiresAt: string
  /** Made by the core itself (trusted by comparing the fingerprint), or one set in the environment. */
  selfSigned: boolean
}

export interface PairingCode {
  /** Short one-time code, e.g. `K7QM-2XPA`. */
  code: string
  /** The role the device that redeems it gets. */
  role: DeviceRole
  expiresAt: string
  urls: string[]
  /** The certificate's SHA-256 when the core speaks HTTPS: goes into the pairing link (`&fp=`). */
  fingerprint?: string
  /** Its public key's SHA-256 (see `TlsInfo.spkiFingerprint`): goes into the pairing link as `&pk=`. */
  spkiFingerprint?: string
  /** The core's id at Mindeck Cloud while away access works: goes into the pairing link as `&ci=` (pairing from outside the Wi-Fi). */
  installId?: string
}

/**
 * What a paired device may do. `member`: use Mindeck (projects, memory,
 * assistant, approvals within the remote rules). `admin`: also pair and remove
 * devices, set the AI key and sign the core in or out of the Mindeck account.
 * Given at the desktop when pairing (a headless core's first device is admin).
 */
export type DeviceRole = 'member' | 'admin'

export const DEVICE_ROLES: readonly DeviceRole[] = ['member', 'admin']

export interface Device {
  id: string
  name: string
  role: DeviceRole
  createdAt: string
  lastSeenAt?: string
}

/** Result of `POST /api/pair`. The token is shown exactly once. */
export interface PairResult {
  token: string
  device: Device
  /**
   * Paired over HTTPS: the SHA-256 of the certificate the core presents. A
   * native client pins it (and compares it with the `fp` of the pairing link).
   */
  fingerprint?: string
  /** Over HTTPS: the SHA-256 of its public key — a pin that survives the certificate's renewal. */
  spkiFingerprint?: string
}

/** One level of the server-side folder browser (web/mobile folder picker). */
export interface DirListing {
  path: string
  parent: string | null
  home: string
  dirs: string[]
  /** Paired devices only: the folders they may browse (shared folders and the desktop's projects). */
  roots?: string[]
}

/**
 * App updates (desktop, packaged): GitHub Releases via electron-updater.
 * `disabled` in dev runs; `available` where the app can't replace itself
 * (Linux .deb) — the new version is downloaded by the user (`downloadUrl`).
 */
export type UpdateState = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  /** The version being downloaded or ready to install. */
  version?: string
  /** Download progress, 0–100. */
  progress?: number
  /** `available`: where the new version's installer is. */
  downloadUrl?: string
  error?: string
}
