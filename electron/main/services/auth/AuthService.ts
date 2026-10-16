import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Device, DeviceRole, PairResult } from '@shared/types/server'
import { readJsonOrThrow } from '../../lib/jsonFile'

interface DeviceRecord extends Device {
  tokenHash: string
}
interface PendingCode {
  hash: string
  expiresAt: string
  role?: DeviceRole
}
interface Store {
  devices: DeviceRecord[]
  codes: PendingCode[]
}

/** No 0/O, 1/I/L — readable on a phone screen and over the phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_TTL_MS = 10 * 60_000
const SEEN_PERSIST_MS = 60_000
/** Open codes at most — older ones give way. */
const MAX_CODES = 20
/** A token unused this long expires: a lost phone or an old backup does not stay a key forever. */
export const TOKEN_IDLE_MS = 90 * 24 * 60 * 60_000

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const normalizeCode = (code: string) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const publicDevice = ({ tokenHash: _t, ...d }: DeviceRecord): Device => d

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Who may use the network API. A device pairs once with a short-lived
 * one-time code and receives a random bearer token; only the token's SHA-256
 * is stored (devices.json, mode 0600). Codes are stored hashed too, and every
 * change re-reads the file first, so a code `mindeck pair` (a second process)
 * wrote is never written over by the running core.
 *
 * Every device has a role, set by the code it redeemed. A headless core has
 * no desktop to hand out roles: its first device is admin, and so are devices
 * paired before roles existed (they could do everything then); on the desktop
 * those become members.
 */
export class AuthService {
  private store?: Store
  private writing: Promise<void> = Promise.resolve()
  private readonly persistedSeen = new Map<string, number>()

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
    private readonly headless = false
  ) {}

  /** A new one-time pairing code, valid for 10 minutes, for a device with `role`. */
  async createPairingCode(role: DeviceRole = 'member'): Promise<{ code: string; role: DeviceRole; expiresAt: string }> {
    const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    const expiresAt = new Date(this.now() + CODE_TTL_MS).toISOString()
    await this.mutate((s) => {
      s.codes = [...s.codes, { hash: sha256(raw), expiresAt, role }].slice(-MAX_CODES)
    })
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, role, expiresAt }
  }

  /** Redeem a code (once) for a device token. */
  async pair(code: string, name: string): Promise<PairResult> {
    const hash = sha256(normalizeCode(code))
    const token = `mindeck_${randomBytes(32).toString('base64url')}`
    const device: DeviceRecord = {
      id: randomUUID(),
      name: String(name ?? '').trim().slice(0, 80) || 'Device',
      role: 'member',
      createdAt: new Date(this.now()).toISOString(),
      tokenHash: sha256(token)
    }
    let matched = false
    await this.mutate((s) => {
      const now = this.now()
      const i = s.codes.findIndex((c) => c.hash === hash && Date.parse(c.expiresAt) > now)
      if (i < 0) return
      device.role = this.headless && !s.devices.length ? 'admin' : (s.codes[i].role ?? 'member')
      s.codes.splice(i, 1)
      s.devices.push(device)
      matched = true
    })
    if (!matched) throw coded('bad-code', 'Pairing code is invalid or expired')
    return { token, device: publicDevice(device) }
  }

  /** The device a bearer token belongs to, or null. A device unseen for 90 days is forgotten (it pairs again). */
  async verify(token: string | undefined | null): Promise<Device | null> {
    if (!token) return null
    const store = await this.load()
    const hash = sha256(token)
    const device = store.devices.find((d) => d.tokenHash === hash)
    if (!device) return null
    const now = this.now()
    if (now - Date.parse(device.lastSeenAt ?? device.createdAt) > TOKEN_IDLE_MS) {
      await this.revoke(device.id)
      return null
    }
    device.lastSeenAt = new Date(now).toISOString()
    if (now - (this.persistedSeen.get(device.id) ?? 0) >= SEEN_PERSIST_MS) {
      this.persistedSeen.set(device.id, now)
      await this.mutate(() => {})
    }
    return publicDevice(device)
  }

  async devices(): Promise<Device[]> {
    return (await this.load()).devices.map(publicDevice)
  }

  /** Give a device another role; answers the updated list. */
  async setRole(id: string, role: DeviceRole): Promise<Device[]> {
    let found = false
    await this.mutate((s) => {
      const device = s.devices.find((d) => d.id === id)
      if (!device) return
      device.role = role
      // The browser is for admin devices: a member keeps no share of it.
      if (role !== 'admin') delete device.browser
      found = true
    })
    if (!found) throw coded('not-found', 'No such device')
    return this.devices()
  }

  /** Share the desktop's browser with a device, or stop (admin devices only); answers the updated list. */
  async setBrowser(id: string, browser: boolean): Promise<Device[]> {
    let role: DeviceRole | undefined
    await this.mutate((s) => {
      const device = s.devices.find((d) => d.id === id)
      if (!device) return
      role = device.role
      if (browser && role !== 'admin') return
      if (browser) device.browser = true
      else delete device.browser
    })
    if (!role) throw coded('not-found', 'No such device')
    if (browser && role !== 'admin') throw coded('admin-only', 'Only an admin device may use the browser')
    return this.devices()
  }

  async revoke(id: string): Promise<void> {
    await this.mutate((s) => {
      s.devices = s.devices.filter((d) => d.id !== id)
    })
  }

  async hasDevices(): Promise<boolean> {
    return (await this.load()).devices.length > 0
  }

  // --- persistence ---

  private async load(fresh = false): Promise<Store> {
    if (this.store && !fresh) return this.store
    // Missing or damaged → empty (a damaged file is set aside, see readJson). One that can't be
    // read right now (EACCES, EIO) throws: starting empty would unpair every device on the next save.
    const parsed: Partial<Store> = (await readJsonOrThrow<Partial<Store> | null>(this.file)) ?? {}
    const store: Store = {
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      codes: Array.isArray(parsed.codes) ? parsed.codes : []
    }
    // Keep in-memory lastSeen values the file does not have yet; devices from before roles get one.
    for (const d of store.devices) {
      const known = this.store?.devices.find((k) => k.id === d.id)
      if (known?.lastSeenAt) d.lastSeenAt = known.lastSeenAt
      if (d.role !== 'admin' && d.role !== 'member') d.role = this.headless ? 'admin' : 'member'
    }
    this.store = store
    return store
  }

  /**
   * Serialized read-modify-write on what the file holds now (another process may have added a
   * code since); expired codes are pruned on every write.
   */
  private mutate(fn: (s: Store) => void): Promise<void> {
    const run = this.writing.then(async () => {
      const store = await this.load(true)
      fn(store)
      const now = this.now()
      store.codes = store.codes.filter((c) => Date.parse(c.expiresAt) > now)
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, JSON.stringify({ version: 1, ...store }, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.file)
    })
    this.writing = run.catch(() => {})
    return run
  }
}
