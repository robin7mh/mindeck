import { readJsonOrThrow } from '../../lib/jsonFile'
import { writeAtomic } from '../../lib/writeAtomic'

/** Encrypts values at rest (desktop: Electron safeStorage / OS keychain). */
export interface Cipher {
  encrypt(plain: string): string
  decrypt(stored: string): string
}

/**
 * Secrets (the LLM API key) in one JSON file, mode 0600. With a cipher the
 * values are encrypted by the OS keychain (desktop); on a headless server the
 * file permissions are the protection — or pass the key via environment.
 * Values never leave the core: no channel ever returns a secret.
 */
export class SecretStore {
  /** What the file holds — and whether its values are the cipher's (the file says so). */
  private cache?: { encrypted: boolean; secrets: Record<string, string> }
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly cipher?: Cipher
  ) {}

  async get(name: string): Promise<string | undefined> {
    let state: { encrypted: boolean; secrets: Record<string, string> }
    try {
      state = await this.load()
    } catch {
      return undefined // the file can't be read right now (logged) — nor is it written over
    }
    const stored = state.secrets[name]
    if (stored === undefined) return undefined
    if (!state.encrypted) return stored
    // Encrypted by a keychain that isn't there now: locked, never handed out as if it were the value.
    if (!this.cipher) return undefined
    try {
      return this.cipher.decrypt(stored)
    } catch {
      return undefined // keychain changed — the user re-enters the key
    }
  }

  /**
   * One change at a time: each builds on the one before (two at once — the
   * cloud's heartbeat and the user saving a key — must not drop either).
   */
  set(name: string, value: string | null): Promise<void> {
    const run = this.writing.then(async () => {
      const state = await this.load()
      if (state.encrypted && !this.cipher) {
        // Saving now would mix plain values into the keychain's (or lose them): wait for the keychain.
        throw Object.assign(new Error('The stored secrets are encrypted by the OS keychain, which is not available'), { code: 'secrets-locked' })
      }
      // Written in plain text before (no keychain then): encrypted from now on.
      const all = Object.fromEntries(Object.entries(state.secrets).map(([k, v]) => [k, this.cipher && !state.encrypted ? this.cipher.encrypt(v) : v]))
      if (value === null) delete all[name]
      else all[name] = this.cipher ? this.cipher.encrypt(value) : value
      await writeAtomic(this.file, JSON.stringify({ version: 1, encrypted: !!this.cipher, secrets: all }, null, 2), 0o600)
      this.cache = { encrypted: !!this.cipher, secrets: all }
    })
    this.writing = run.catch(() => {})
    return run
  }

  private async load(): Promise<{ encrypted: boolean; secrets: Record<string, string> }> {
    if (this.cache) return this.cache
    // A damaged file is set aside (see readJson) — never overwritten with an empty store; one
    // that can't be read right now throws (and stays as it is).
    const parsed = await readJsonOrThrow<{ encrypted?: unknown; secrets?: Record<string, string> }>(this.file)
    const secrets = parsed && typeof parsed.secrets === 'object' && parsed.secrets ? parsed.secrets : {}
    // Files from before the flag: encrypted when this machine encrypts.
    const encrypted = typeof parsed?.encrypted === 'boolean' ? parsed.encrypted : !!this.cipher
    this.cache = { encrypted, secrets }
    return this.cache
  }
}
