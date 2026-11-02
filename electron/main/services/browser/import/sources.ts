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

/** A profile found on disk, with the folders the import reads. */
export interface FoundProfile extends ImportSource {
  /** The profile's own folder. */
  dir: string
  /** Arc: its sidebar file (the bookmarks). */
  sidebar?: string
}

type Chromium = Exclude<ImportBrowser, 'firefox'>

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

/** Folders matching `prefix*` in `dir` (Windows Store apps carry a publisher hash in their folder name). */
async function matching(dir: string, prefix: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((n) => n.startsWith(prefix)).map((n) => join(dir, n))
}

/** The "User Data" folders of the Chromium browsers on this OS. */
async function chromiumRoots(e: ImportEnv): Promise<[Chromium, string][]> {
  if (e.platform === 'darwin') {
    const base = join(e.home, 'Library', 'Application Support')
    return [
      ['chrome', join(base, 'Google', 'Chrome')],
      ['brave', join(base, 'BraveSoftware', 'Brave-Browser')],
      ['edge', join(base, 'Microsoft Edge')],
      ['arc', join(base, 'Arc', 'User Data')],
      ['vivaldi', join(base, 'Vivaldi')],
      ['chromium', join(base, 'Chromium')]
    ]
  }
  if (e.platform === 'win32') {
    const local = e.env.LOCALAPPDATA || join(e.home, 'AppData', 'Local')
    const arc = await matching(join(local, 'Packages'), 'TheBrowserCompany.Arc_')
    return [
      ['chrome', join(local, 'Google', 'Chrome', 'User Data')],
      ['brave', join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
      ['edge', join(local, 'Microsoft', 'Edge', 'User Data')],
      ...arc.map((dir): [Chromium, string] => ['arc', join(dir, 'LocalCache', 'Local', 'Arc', 'User Data')]),
      ['vivaldi', join(local, 'Vivaldi', 'User Data')],
      ['chromium', join(local, 'Chromium', 'User Data')]
    ]
  }
  const config = e.env.XDG_CONFIG_HOME || join(e.home, '.config')
  return [
    ['chrome', join(config, 'google-chrome')],
    ['brave', join(config, 'BraveSoftware', 'Brave-Browser')],
    ['edge', join(config, 'microsoft-edge')],
    ['vivaldi', join(config, 'vivaldi')],
    ['chromium', join(config, 'chromium')],
    ['chromium', join(e.home, 'snap', 'chromium', 'common', 'chromium')]
  ]
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

/** A Chromium browser's profiles: named in `Local State`, else every `Default` / `Profile N` folder. */
async function chromiumProfiles(browser: Chromium, root: string): Promise<FoundProfile[]> {
  let names: Record<string, string> = {}
  try {
    const state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, { name?: unknown }> } }
    for (const [folder, info] of Object.entries(state.profile?.info_cache ?? {})) names[folder] = typeof info?.name === 'string' && info.name ? info.name : folder
  } catch {
    names = {}
  }
  if (!Object.keys(names).length) {
    for (const folder of await readdir(root).catch(() => [] as string[])) if (folder === 'Default' || /^Profile \d+$/.test(folder)) names[folder] = folder
  }
  // Arc keeps its bookmarks in the sidebar file next to "User Data" (Windows: under Roaming).
  const sidebars = browser === 'arc' ? [join(root, '..', 'StorableSidebar.json'), join(root, '..', '..', '..', 'Roaming', 'Arc', 'StorableSidebar.json')] : []
  let sidebar: string | undefined
  for (const s of sidebars) if (!sidebar && (await exists(s))) sidebar = s
  const out: FoundProfile[] = []
  for (const [folder, profile] of Object.entries(names)) {
    const dir = join(root, folder)
    const kinds: ImportKind[] = []
    if (sidebar || (browser !== 'arc' && (await exists(join(dir, 'Bookmarks'))))) kinds.push('bookmarks')
    if (await exists(join(dir, 'History'))) kinds.push('history')
    if (await exists(join(dir, 'Preferences'))) kinds.push('settings')
    if (kinds.length) out.push({ id: `${browser}:${dir}`, browser, profile, kinds, dir, ...(sidebar ? { sidebar } : {}) })
  }
  return out
}

async function firefoxProfiles(root: string): Promise<FoundProfile[]> {
  const ini = await readFile(join(root, 'profiles.ini'), 'utf8').catch(() => '')
  const out: FoundProfile[] = []
  for (const p of parseProfilesIni(ini, root)) {
    if (await exists(join(p.dir, 'places.sqlite'))) out.push({ id: `firefox:${p.dir}`, browser: 'firefox', profile: p.name, kinds: ['bookmarks', 'history'], dir: p.dir })
  }
  return out
}

/** Every browser profile on this machine Mindeck can import from. */
export async function findSources(e: ImportEnv): Promise<FoundProfile[]> {
  const found: FoundProfile[] = []
  for (const [browser, root] of await chromiumRoots(e)) found.push(...(await chromiumProfiles(browser, root)))
  for (const root of firefoxRoots(e)) found.push(...(await firefoxProfiles(root)))
  return found
}
