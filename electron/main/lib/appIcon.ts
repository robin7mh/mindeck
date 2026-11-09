import { join } from 'node:path'

// The app's icon follows the system's appearance: the white tile in light mode, the dark one in dark
// mode (build/brand/logo.mjs). macOS 26+ does that for a packaged app itself (its Assets.car); the
// .exe, the .icns of older macOS and Linux's icons are the white tile — so while Mindeck runs, it
// switches its tray, window and Dock icons itself.

export type IconKind = 'tray' | 'window' | 'dock'

/** Where the running app's icons lie: build/runtime in `npm run dev`, resources/icons packaged. */
export interface IconPlace {
  packaged: boolean
  resourcesPath: string
  /** The repository (dev). */
  root: string
}

/** The icon of `kind` in an appearance. */
export function runtimeIcon(kind: IconKind, dark: boolean, place: IconPlace): string {
  const file = `${kind}-${dark ? 'dark' : 'light'}.png`
  return place.packaged ? join(place.resourcesPath, 'icons', file) : join(place.root, 'build/runtime', file)
}

/**
 * Whether the Dock's icon is Mindeck's to switch: macOS 26 and later switch a packaged app's
 * themselves — setting one would replace the system's rendering with a flat picture. In
 * `npm run dev` the Dock shows Electron's app, so Mindeck sets its own there. `macosVersion`:
 * Electron's `process.getSystemVersion()` ("26.1.0").
 */
export function switchesDock(packaged: boolean, macosVersion: string): boolean {
  return !packaged || Number.parseInt(macosVersion, 10) < 26
}

/** What the system's appearance is read from (Electron's modules; tests pass their own). */
export interface AppearanceSource {
  platform: NodeJS.Platform
  nativeTheme: { shouldUseDarkColors: boolean; shouldUseDarkColorsForSystemIntegratedUI: boolean; on(event: 'updated', cb: () => void): unknown }
  systemPreferences: { getUserDefault(key: string, type: 'string'): unknown; subscribeNotification(event: string, cb: () => void): unknown }
}

/**
 * Whether the system shows its icons dark — not Mindeck's own theme, which sets
 * `nativeTheme.themeSource` for the pages in its browser. macOS 26+: its icon style when that is fixed
 * (`RegularDark`, `ClearLight` … — every other app's icon looks that way), else the appearance;
 * Windows: the taskbar's mode ("Windows mode", where the icons are); Linux: its theme.
 */
export function systemDark(source: AppearanceSource): boolean {
  if (source.platform === 'win32') return source.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
  if (source.platform === 'darwin') {
    const style = String(source.systemPreferences.getUserDefault('AppleIconAppearanceTheme', 'string'))
    if (/Dark$/.test(style)) return true
    if (/Light$/.test(style)) return false
    return source.systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark'
  }
  return source.nativeTheme.shouldUseDarkColors
}

/** Calls `cb` whenever the system's appearance may have changed (macOS tells it apart from Mindeck's own theme). */
export function onSystemAppearance(source: AppearanceSource, cb: () => void): void {
  source.nativeTheme.on('updated', cb)
  if (source.platform === 'darwin') source.systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', cb)
}
