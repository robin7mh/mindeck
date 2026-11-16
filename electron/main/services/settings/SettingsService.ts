import { readJson } from '../../lib/jsonFile'
import { writeAtomic } from '../../lib/writeAtomic'
import type { AppSettings } from '@shared/types/settings'

/**
 * Typed app settings backed by a single JSON file. Electron-agnostic: the file
 * path is injected, so it is fully testable against a temp dir. Writes are
 * atomic (temp file + rename), same pattern as ProjectRegistry.
 */
export class SettingsService {
  private settings: AppSettings = {}
  private loaded = false

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    if (this.loaded) return
    // Missing/damaged file → defaults (a damaged one is set aside, see readJson).
    const parsed = await readJson<{ settings?: AppSettings }>(this.file)
    this.settings = parsed && typeof parsed.settings === 'object' && parsed.settings ? parsed.settings : {}
    this.loaded = true
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch }
    await this.persist()
    return this.get()
  }

  private persist(): Promise<void> {
    return writeAtomic(this.file, JSON.stringify({ version: 1, settings: this.settings }, null, 2))
  }
}
