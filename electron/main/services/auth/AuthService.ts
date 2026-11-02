import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Device, PairResult } from '@shared/types/server'

interface DeviceRecord extends Device {
  tokenHash: string
}
interface PendingCode {
  hash: string
  expiresAt: string
}
interface Store {
  devices: DeviceRecord[]
  codes: PendingCode[]
}

/** No 0/O, 1/I/L — readable on a phone screen and over the phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_TTL_MS = 10 * 60_000
const SEEN_PERSIST_MS = 60_000

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const normalizeCode = (code: string) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const publicDevice = ({ tokenHash: _t, ...d }: DeviceRecord): Device => d

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Who may use the network API. A device pairs once with a short-lived
 * one-time code and receives a random bearer token; only the token's SHA-256
 * is stored (devices.json, mode 0600). Codes are stored hashed too, and the
 * file is re-read when pairing, so `mindeck pair` from a second process works.
 */
export class AuthService {
  private store?: Store
  private writing: Promise<void> = Promise.resolve()
  private readonly persistedSeen = new Map<string, number>()

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now
  ) {}

  /** A new one-time pairing code, valid for 10 minutes. */
  async createPairingCode(): Promise<{ code: string; expiresAt: string }> {
    const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    const expiresAt = new Date(this.now() + CODE_TTL_MS).toISOString()
    await this.mutate(true, (s) => {
      s.codes.push({ hash: sha256(raw), expiresAt })
    })
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt }
  }

  /** Redeem a code (once) for a device token. */
  async pair(code: string, name: string): Promise<PairResult> {
    const hash = sha256(normalizeCode(code))
    const token = `mindeck_${randomBytes(32).toString('base64url')}`
    const device: DeviceRecord = {
      id: randomUUID(),
      name: String(name ?? '').trim().slice(0, 80) || 'Device',
      createdAt: new Date(this.now()).toISOString(),
      tokenHash: sha256(token)
    }
    let matched = false
    await this.mutate(true, (s) => {
      const now = this.now()
      const i = s.codes.findIndex((c) => c.hash === hash && Date.parse(c.expiresAt) > now)
      if (i < 0) return
      s.codes.splice(i, 1)
      s.devices.push(device)
      matched = true
    })
    if (!matched) throw coded('bad-code', 'Pairing code is invalid or expired')
    return { token, device: publicDevice(device) }
  }

  /** The device a bearer token belongs to, or null. */
  async verify(token: string | undefined | null): Promise<Device | null> {
    if (!token) return null
    const store = await this.load()
    const hash = sha256(token)
    const device = store.devices.find((d) => d.tokenHash === hash)
    if (!device) return null
    const now = this.now()
    device.lastSeenAt = new Date(now).toISOString()
    if (now - (this.persistedSeen.get(device.id) ?? 0) >= SEEN_PERSIST_MS) {
      this.persistedSeen.set(device.id, now)
      await this.mutate(false, () => {})
    }
    return publicDevice(device)
  }

  async devices(): Promise<Device[]> {
    return (await this.load()).devices.map(publicDevice)
  }

  async revoke(id: string): Promise<void> {
    await this.mutate(false, (s) => {
      s.devices = s.devices.filter((d) => d.id !== id)
    })
  }

  async hasDevices(): Promise<boolean> {
    return (await this.load()).devices.length > 0
  }

  // --- persistence ---

  private async load(fresh = false): Promise<Store> {
    if (this.store && !fresh) return this.store
    let parsed: Partial<Store> = {}
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      /* missing or corrupt → empty */
    }
    const store: Store = {
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      codes: Array.isArray(parsed.codes) ? parsed.codes : []
    }
    // Keep in-memory lastSeen values the file does not have yet.
    for (const d of store.devices) {
      const known = this.store?.devices.find((k) => k.id === d.id)
      if (known?.lastSeenAt) d.lastSeenAt = known.lastSeenAt
    }
    this.store = store
    return store
  }

  private async diskCodes(): Promise<PendingCode[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Store>
      return Array.isArray(parsed?.codes) ? parsed.codes : []
    } catch {
      return []
    }
  }

  /** Serialized read-modify-write; expired codes are pruned on every write. */
  private mutate(fresh: boolean, fn: (s: Store) => void): Promise<void> {
    const run = this.writing.then(async () => {
      const store = await this.load(fresh)
      // Never drop codes another process (`mindeck pair`) wrote since the last read.
      if (!fresh) {
        for (const c of await this.diskCodes()) if (!store.codes.some((k) => k.hash === c.hash)) store.codes.push(c)
      }
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
