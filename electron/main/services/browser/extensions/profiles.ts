import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChromiumBrowser, ChromiumProfile, ProfileExtension } from '@shared/types/browserExtensions'
import { readManifest } from './manifest'
import { compareVersions, EXTENSION_ID } from './webstore'

/** Where a Chromium browser keeps its profiles ("User Data"). */
export interface BrowserRoot {
  browser: ChromiumBrowser
  root: string
}

/** The user-data folders of Chrome, Brave, Edge, Chromium, Vivaldi and Arc on this OS. */
export function browserRoots(platform: NodeJS.Platform, home: string, env: Record<string, string | undefined> = {}): BrowserRoot[] {
  const at = (browser: ChromiumBrowser, ...parts: string[]): BrowserRoot => ({ browser, root: join(...parts) })
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    return [
      at('chrome', support, 'Google', 'Chrome'),
      at('brave', support, 'BraveSoftware', 'Brave-Browser'),
      at('edge', support, 'Microsoft Edge'),
      at('arc', support, 'Arc', 'User Data'),
      at('vivaldi', support, 'Vivaldi'),
      at('chromium', support, 'Chromium')
    ]
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return [
      at('chrome', local, 'Google', 'Chrome', 'User Data'),
      at('brave', local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      at('edge', local, 'Microsoft', 'Edge', 'User Data'),
      at('vivaldi', local, 'Vivaldi', 'User Data'),
      at('chromium', local, 'Chromium', 'User Data')
    ]
  }
  const config = env.XDG_CONFIG_HOME || join(home, '.config')
  return [
    at('chrome', config, 'google-chrome'),
    at('brave', config, 'BraveSoftware', 'Brave-Browser'),
    at('edge', config, 'microsoft-edge'),
    at('vivaldi', config, 'vivaldi'),
    at('chromium', config, 'chromium')
  ]
}

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Profile folders and the names the browser shows for them (from its `Local State`). */
async function profileNames(root: string): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  try {
    const state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, { name?: unknown }> } }
    for (const [dir, info] of Object.entries(state.profile?.info_cache ?? {})) names.set(dir, typeof info?.name === 'string' && info.name ? info.name : dir)
  } catch {
    // no Local State: the folder names will do
  }
  for (const dir of await dirs(root)) if (!names.has(dir) && (dir === 'Default' || /^Profile \d+$/.test(dir))) names.set(dir, dir)
  return names
}

/** A profile's extensions: `Extensions/<id>/<version>/`, the newest version that reads as an extension. */
async function profileExtensions(profile: string, installed: Set<string>, locale: string): Promise<ProfileExtension[]> {
  const out: ProfileExtension[] = []
  const base = join(profile, 'Extensions')
  for (const id of await dirs(base)) {
    if (!EXTENSION_ID.test(id)) continue
    const versions = (await dirs(join(base, id))).filter((v) => /^\d/.test(v)).sort((a, b) => compareVersions(b.replace(/_\d+$/, ''), a.replace(/_\d+$/, '')))
    for (const version of versions) {
      const path = join(base, id, version)
      try {
        const info = await readManifest(path, locale)
        out.push({ id, name: info.name, version: info.version, path, installed: installed.has(id) })
        break
      } catch {
        // a broken or unsupported copy (theme, Chrome app): try the next, else skip it
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Every profile of every Chromium browser on this computer that has extensions. */
export async function findProfiles(roots: BrowserRoot[], installed: Set<string>, locale = 'en'): Promise<ChromiumProfile[]> {
  const out: ChromiumProfile[] = []
  for (const { browser, root } of roots) {
    for (const [dir, name] of await profileNames(root)) {
      const path = join(root, dir)
      const extensions = await profileExtensions(path, installed, locale)
      if (extensions.length) out.push({ browser, name, path, extensions })
    }
  }
  return out
}

/** Whether `path` is an extension folder inside one of the browsers' profiles (`<root>/<profile>/Extensions/<id>/<version>`). */
export function inProfile(roots: BrowserRoot[], path: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const target = norm(path)
  return roots.some(({ root }) => {
    const prefix = `${norm(root)}/`
    if (!target.startsWith(prefix)) return false
    const rest = target.slice(prefix.length).split('/')
    return rest.length === 4 && rest[1] === 'Extensions' && EXTENSION_ID.test(rest[2]) && !rest.includes('..')
  })
}
