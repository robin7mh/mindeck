import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

/**
 * API permissions Electron's Chromium provides to extensions (see Electron's
 * "Supported Extensions APIs"), plus those that need no API at all. Anything
 * else an extension asks for is missing — the features that use it fail.
 */
const SUPPORTED = new Set([
  'activeTab',
  'background',
  'clipboardRead',
  'clipboardWrite',
  'management',
  'scripting',
  'storage',
  'tabs',
  'unlimitedStorage',
  'webRequest',
  'webRequestBlocking'
])

/** The update URL of the Chrome Web Store (extensions without one come from it too). */
const STORE_UPDATE_URL = /^https:\/\/clients2\.google\.com\/service\/update2\/crx\b/

export interface ManifestInfo {
  name: string
  version: string
  description: string
  /** Chrome's key: makes the id the same wherever the folder is. */
  key?: string
  /** The toolbar popup, relative to the extension's folder. */
  popup?: string
  /** The toolbar icon, relative to the extension's folder. */
  icon?: string
  permissions: string[]
  unsupported: string[]
  /** Updates come from the Chrome Web Store. */
  fromStore: boolean
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'bad-extension' })
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A path inside the extension (popup, icon) — never outside its folder. */
function inside(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path) return undefined
  const clean = posix.normalize(path.replace(/\\/g, '/').replace(/^\/+/, ''))
  return clean === '.' || clean.startsWith('..') ? undefined : clean
}

/** The icon nearest to 32 px (Chrome's toolbar size at 2×), else the biggest. */
export function pickIcon(icons: unknown): string | undefined {
  if (typeof icons === 'string') return inside(icons)
  if (!icons || typeof icons !== 'object') return undefined
  const sizes = Object.entries(icons as Record<string, unknown>)
    .map(([size, path]) => ({ size: Number(size), path: inside(path) }))
    .filter((i): i is { size: number; path: string } => i.size > 0 && !!i.path)
    .sort((a, b) => a.size - b.size)
  return (sizes.find((i) => i.size >= 32) ?? sizes[sizes.length - 1])?.path
}

/** `__MSG_appName__` → the text in the extension's `_locales` (UI language first, then its default). */
async function localizer(dir: string, manifest: Record<string, unknown>, locale: string): Promise<(text: string) => string> {
  const messages: Record<string, string> = {}
  for (const lang of [str(manifest.default_locale), locale].filter(Boolean)) {
    try {
      const raw = JSON.parse((await readFile(join(dir, '_locales', lang, 'messages.json'), 'utf8')).replace(/^﻿/, '')) as Record<string, { message?: unknown }>
      for (const [key, value] of Object.entries(raw)) if (typeof value?.message === 'string') messages[key.toLowerCase()] = value.message
    } catch {
      // that language is missing
    }
  }
  return (text) => text.replace(/__MSG_(\w+)__/g, (m, key: string) => messages[key.toLowerCase()] ?? m)
}

/**
 * Reads and checks an unpacked extension's `manifest.json`: Manifest V2 or
 * V3, a name and a version — no themes, no Chrome apps. Names come in the
 * UI's language when the extension has it.
 */
export async function readManifest(dir: string, locale = 'en'): Promise<ManifestInfo> {
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse((await readFile(join(dir, 'manifest.json'), 'utf8')).replace(/^﻿/, '')) as Record<string, unknown>
  } catch {
    throw invalid('No readable manifest.json — this is not an unpacked extension')
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw invalid('manifest.json is not an object')
  if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) throw invalid('Only Manifest V2 and V3 extensions are supported')
  if (manifest.theme) throw invalid('Themes are not supported')
  if (manifest.app) throw invalid('Chrome apps are not supported')
  const version = str(manifest.version)
  if (!/^\d{1,9}(\.\d{1,9}){0,3}$/.test(version)) throw invalid('The manifest has no valid version')
  const t = await localizer(dir, manifest, locale)
  const name = t(str(manifest.name)).trim()
  if (!name) throw invalid('The manifest has no name')

  const action = (manifest.action ?? manifest.browser_action ?? manifest.page_action) as Record<string, unknown> | undefined
  const declared = [...(Array.isArray(manifest.permissions) ? manifest.permissions : []), ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [])].filter(
    (p): p is string => typeof p === 'string'
  )
  const scripts = Array.isArray(manifest.content_scripts) ? (manifest.content_scripts as { matches?: unknown }[]) : []
  const matches = scripts.flatMap((s) => (Array.isArray(s?.matches) ? s.matches.filter((m): m is string => typeof m === 'string') : []))
  const isHost = (p: string) => p === '<all_urls>' || p.includes('://')
  const apis = [...new Set(declared.filter((p) => !isHost(p)))]
  const hosts = [...new Set([...declared.filter(isHost), ...matches])]
  const key = str(manifest.key)
  const updateUrl = str(manifest.update_url)
  const popup = inside(action?.default_popup)
  const icon = pickIcon(action?.default_icon) ?? pickIcon(manifest.icons)

  return {
    name,
    version,
    description: t(str(manifest.description)).trim(),
    ...(key ? { key } : {}),
    ...(popup ? { popup } : {}),
    ...(icon ? { icon } : {}),
    permissions: [...apis, ...hosts],
    unsupported: apis.filter((p) => !SUPPORTED.has(p)),
    fromStore: !updateUrl || STORE_UPDATE_URL.test(updateUrl)
  }
}
