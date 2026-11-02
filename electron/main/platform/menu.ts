import type { MenuItemConstructorOptions } from 'electron'

/**
 * Mindeck's application menu. Electron's default one answers every key no
 * module takes: ⌘R / Ctrl+R and ⇧⌘R reload the whole UI (the editor's undo
 * history and a half-written message go), ⌥⌘I / Ctrl+Shift+I open DevTools on
 * Mindeck itself, and ⌘W / Ctrl+W meant for a tab closes the window. What
 * stays: the Edit menu (macOS needs it for ⌘C, ⌘V and ⌘Z in text fields), the
 * zoom, the app's own keys (hide, quit, minimize) — and reloading and DevTools
 * while developing. Full screen is main.ts's (⌃⌘F, F11), so it toggles once.
 */
export function appMenuTemplate(platform: NodeJS.Platform, dev: boolean): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [
    ...(dev ? ([{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as const) : []),
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' }
  ]
  if (platform === 'darwin') {
    return [
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu', submenu: view },
      { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }
    ]
  }
  // Windows and Linux draw no menu bar (the window is frameless): only its keys count.
  return [{ role: 'fileMenu', submenu: [{ role: 'quit' }] }, { role: 'editMenu' }, { role: 'viewMenu', submenu: view }]
}
