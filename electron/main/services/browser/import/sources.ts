import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImportBrowser, ImportKind, ImportSource } from '@shared/types/browserData'
import { parseProfilesIni } from './firefox'

/** Where to look: the user's home, the OS, and its folder variables (LOCALAPPDATA, APPDATA, XDG_CONFIG_HOME). */
export interface ImportEnv {
  home: string
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
}

/** A profile found on disk, with the folder the import reads. */
export interface FoundProfile extends ImportSource {
  /** The profile's own folder (a locked browser: the folder that may not be read). */
  dir: string
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

/** The system refused to read it (macOS guards Safari's data, and other apps' where it chooses to), not "not there". */
function refused(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES'
}

/** A browser that is there but may not be read: one entry that says so (Full Disk Access opens it). */
const locked = (browser: ImportBrowser, dir: string): FoundProfile => ({ id: `${browser}:${dir}`, browser, profile: '', kinds: [], dir, locked: true })

/** Chrome's "User Data" folder on this OS. */
function chromeRoot(e: ImportEnv): string {
  if (e.platform === 'darwin') return join(e.home, 'Library', 'Application Support', 'Google', 'Chrome')
  if (e.platform === 'win32') return join(e.env.LOCALAPPDATA || join(e.home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
  return join(e.env.XDG_CONFIG_HOME || join(e.home, '.config'), 'google-chrome')
}

/** Folders holding Firefox's `profiles.ini`. */
function firefoxRoots(e: ImportEnv): string[] {
  if (e.platform === 'darwin') return [join(e.home, 'Library', 'Application Support', 'Firefox')]
  if (e.platform === 'win32') return [join(e.env.APPDATA || join(e.home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox')]
  return [
    join(e.home, '.mozilla', 'firefox'),
    join(e.home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    join(e.home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox')
  ]
}

/** Chrome's profiles: named in `Local State`, else every `Default` / `Profile N` folder. */
async function chromeProfiles(root: string): Promise<FoundProfile[]> {
  let folders: string[]
  try {
    folders = await readdir(root)
  } catch (err) {
    return refused(err) ? [locked('chrome', root)] : []
  }
  let names: Record<string, string> = {}
  try {
    const state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, { name?: unknown }> } }
    for (const [folder, info] of Object.entries(state.profile?.info_cache ?? {})) names[folder] = typeof info?.name === 'string' && info.name ? info.name : folder
  } catch {
    names = {}
  }
  if (!Object.keys(names).length) {
    for (const folder of folders) if (folder === 'Default' || /^Profile \d+$/.test(folder)) names[folder] = folder
  }
  const out: FoundProfile[] = []
  for (const [folder, profile] of Object.entries(names)) {
    const dir = join(root, folder)
    const kinds: ImportKind[] = []
    if (await exists(join(dir, 'Bookmarks'))) kinds.push('bookmarks')
    if (await exists(join(dir, 'History'))) kinds.push('history')
    if (await exists(join(dir, 'Preferences'))) kinds.push('settings')
    if (kinds.length) out.push({ id: `chrome:${dir}`, browser: 'chrome', profile, kinds, dir })
  }
  return out
}

/** Safari's library (macOS): its bookmarks and history — macOS lets an app read them only with Full Disk Access. */
async function safariProfiles(e: ImportEnv): Promise<FoundProfile[]> {
  if (e.platform !== 'darwin') return []
  const dir = join(e.home, 'Library', 'Safari')
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (err) {
    return refused(err) ? [locked('safari', dir)] : []
  }
  const kinds: ImportKind[] = []
  if (files.includes('Bookmarks.plist')) kinds.push('bookmarks')
  if (files.includes('History.db')) kinds.push('history')
  return kinds.length ? [{ id: `safari:${dir}`, browser: 'safari', profile: '', kinds, dir }] : []
}

async function firefoxProfiles(root: string): Promise<FoundProfile[]> {
  let ini: string
  try {
    ini = await readFile(join(root, 'profiles.ini'), 'utf8')
  } catch (err) {
    return refused(err) ? [locked('firefox', root)] : []
  }
  const out: FoundProfile[] = []
  for (const p of parseProfilesIni(ini, root)) {
    if (await exists(join(p.dir, 'places.sqlite'))) out.push({ id: `firefox:${p.dir}`, browser: 'firefox', profile: p.name, kinds: ['bookmarks', 'history'], dir: p.dir })
  }
  return out
}

/** Every profile of Chrome, Safari and Firefox on this machine — and those of them the system won't let Mindeck read. */
export async function findSources(e: ImportEnv): Promise<FoundProfile[]> {
  const found = [...(await chromeProfiles(chromeRoot(e))), ...(await safariProfiles(e))]
  for (const root of firefoxRoots(e)) found.push(...(await firefoxProfiles(root)))
  return found
}
