import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate } from '../../../electron/main/platform/menu'

/** Every role in a menu, submenus included. */
const roles = (items: MenuItemConstructorOptions[]): string[] =>
  items.flatMap((i) => [...(i.role ? [i.role] : []), ...(Array.isArray(i.submenu) ? roles(i.submenu) : [])])

describe('the application menu', () => {
  it('macOS: app, edit, zoom and window keys — no reload, DevTools, full screen or window closing on ⌘W', () => {
    const mac = roles(appMenuTemplate('darwin', false))
    expect(mac).toEqual(['appMenu', 'editMenu', 'viewMenu', 'resetZoom', 'zoomIn', 'zoomOut', 'windowMenu', 'minimize', 'zoom', 'front'])
  })

  it('Windows and Linux: quit, edit and zoom only (the frameless window draws no menu bar)', () => {
    expect(roles(appMenuTemplate('win32', false))).toEqual(['fileMenu', 'quit', 'editMenu', 'viewMenu', 'resetZoom', 'zoomIn', 'zoomOut'])
    expect(roles(appMenuTemplate('linux', false))).not.toContain('close')
  })

  it('keeps reloading and DevTools while developing', () => {
    expect(roles(appMenuTemplate('linux', true))).toEqual(['fileMenu', 'quit', 'editMenu', 'viewMenu', 'reload', 'forceReload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut'])
  })
})
