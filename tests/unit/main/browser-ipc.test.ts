import { describe, expect, it, vi } from 'vitest'
import { Router } from '../../../electron/ipc/router'
import { registerBrowserIpc } from '../../../electron/ipc/browser.ipc'
import { registerFinderIpc } from '../../../electron/ipc/finder.ipc'
import type { BrowserService } from '../../../electron/main/services/browser/BrowserService'
import type { FinderService } from '../../../electron/main/services/finder/FinderService'

/** Any method call answers with its name — enough to see which one ran with what. */
const recorder = () =>
  new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get: (target, key: string) => (target[key] ??= vi.fn((...args: unknown[]) => ({ called: key, args })))
  })

describe('browser and files channels', () => {
  const ipc = { transport: 'ipc' as const }

  it('reach the browser service with validated payloads — from paired devices only when the desktop shares the browser', async () => {
    const router = new Router()
    const browser = recorder()
    registerBrowserIpc(router, browser as unknown as BrowserService)
    const calls: [string, unknown, string, unknown[]][] = [
      ['browser:state', undefined, 'state', []],
      ['browser:open', { url: 'example.com', background: true }, 'open', [{ url: 'example.com', background: true }]],
      ['browser:open', undefined, 'open', [{ url: undefined, background: undefined }]],
      ['browser:close', { id: 't' }, 'close', ['t']],
      ['browser:activate', { id: 't' }, 'activate', ['t']],
      ['browser:navigate', { id: 't', input: 'react hooks' }, 'navigate', ['t', 'react hooks']],
      ['browser:go', { id: 't', action: 'back' }, 'go', ['t', 'back']],
      ['browser:update', { id: 't', pinned: true, shared: false }, 'update', ['t', { pinned: true, shared: false }]],
      ['browser:move', { id: 't', index: 2 }, 'move', ['t', 2, undefined]],
      ['browser:move', { id: 't', index: 2, groupId: null }, 'move', ['t', 2, null]],
      ['browser:move', { id: 't', index: 0, groupId: 'g' }, 'move', ['t', 0, 'g']],
      ['browser:duplicate', { id: 't' }, 'duplicate', ['t']],
      ['browser:reopen', undefined, 'reopen', []],
      ['browser:zoom', { id: 't', zoom: 'in' }, 'zoom', ['t', 'in']],
      ['browser:find', { id: 't', text: 'x', next: true }, 'find', ['t', 'x', undefined, true]],
      ['browser:findStop', { id: 't' }, 'findStop', ['t']],
      ['browser:tool', { id: 't', tool: 'devtools' }, 'tool', ['t', 'devtools']],
      ['browser:view', { bounds: { x: 1, y: 2, width: 3, height: 4 } }, 'setView', [{ x: 1, y: 2, width: 3, height: 4 }, undefined, undefined]],
      ['browser:view', { bounds: null }, 'setView', [null, undefined, undefined]],
      ['browser:view', { bounds: null, focused: false }, 'setView', [null, false, undefined]],
      [
        'browser:view',
        { bounds: { x: 0, y: 0, width: 10, height: 4 }, panes: [{ id: 'a', bounds: { x: 0, y: 0, width: 4, height: 4 } }] },
        'setView',
        [{ x: 0, y: 0, width: 10, height: 4 }, undefined, [{ id: 'a', bounds: { x: 0, y: 0, width: 4, height: 4 } }]]
      ],
      ['browser:freeze', undefined, 'freeze', []],
      ['browser:unfreeze', undefined, 'unfreeze', []],
      ['browser:suggest', { text: 'gi' }, 'suggest', ['gi']],
      ['browser:history', { query: 'docs', limit: 5 }, 'historyEntries', ['docs', 5]],
      ['browser:history', undefined, 'historyEntries', [undefined, undefined]],
      ['browser:clearHistory', undefined, 'clearHistory', []],
      ['browser:download', { id: 'd', action: 'reveal' }, 'download', ['d', 'reveal']],
      ['browser:permission', { id: 'p', allow: true, remember: true }, 'permission', ['p', true, true]],
      ['browser:settings', undefined, 'settings', []],
      ['browser:configure', { searchEngine: 'kagi' }, 'configure', [{ searchEngine: 'kagi' }]],
      ['browser:ui', { theme: 'dark', locale: 'de' }, 'setUi', [{ theme: 'dark', locale: 'de' }]],
      ['browser:configure', { searchSuggestions: false, bookmarksBar: true }, 'configure', [{ searchSuggestions: false, bookmarksBar: true }]],
      ['browser:searchSuggest', { text: 'rea' }, 'searchSuggestions', ['rea']],
      ['browser:historyList', { query: 'x', before: 5, limit: 50 }, 'historyList', [{ query: 'x', before: 5, limit: 50 }]],
      ['browser:historyList', undefined, 'historyList', [{}]],
      ['browser:historyDelete', { urls: ['https://a.dev/'] }, 'deleteHistory', [{ urls: ['https://a.dev/'] }]],
      ['browser:historyDelete', { from: 1, to: 2 }, 'deleteHistory', [{ from: 1, to: 2 }]],
      ['browser:historyDelete', { to: 2 }, 'deleteHistory', [{ to: 2 }]],
      ['browser:bookmarks', undefined, 'bookmarkTree', []],
      ['browser:bookmarkAdd', { title: 'A', url: 'https://a.dev/', parentId: 'bar', index: 0 }, 'addBookmark', [{ title: 'A', url: 'https://a.dev/', parentId: 'bar', index: 0 }]],
      ['browser:bookmarkUpdate', { id: 'b', title: 'B' }, 'updateBookmark', ['b', { title: 'B' }]],
      ['browser:bookmarkMove', { id: 'b', parentId: 'other', index: 2 }, 'moveBookmark', ['b', 'other', 2]],
      ['browser:bookmarkRemove', { ids: ['b'] }, 'removeBookmarks', [['b']]],
      ['browser:bookmarksExport', undefined, 'exportBookmarks', []],
      ['browser:bookmarksImport', { html: '<DL>' }, 'importBookmarksHtml', ['<DL>']],
      ['browser:importSources', undefined, 'importSources', []],
      ['browser:import', { sourceId: 'chrome:/p', kinds: ['bookmarks'] }, 'importFrom', [{ sourceId: 'chrome:/p', kinds: ['bookmarks'] }]],
      ['browser:restoreSession', { restore: true }, 'restoreSession', [true]],
      ['browser:configure', { verticalTabs: true, verticalTabsWidth: 300, verticalTabsCollapsed: false }, 'configure', [{ verticalTabs: true, verticalTabsWidth: 300, verticalTabsCollapsed: false }]],
      ['browser:group', { ids: ['t', 'u'], title: 'Work', color: 'green' }, 'group', [['t', 'u'], { title: 'Work', color: 'green' }]],
      ['browser:group', { ids: ['t'] }, 'group', [['t'], {}]],
      ['browser:groupUpdate', { id: 'g', collapsed: true }, 'updateGroup', ['g', { collapsed: true }]],
      ['browser:ungroup', { id: 'g' }, 'ungroup', ['g']],
      ['browser:groupClose', { id: 'g' }, 'closeGroup', ['g']],
      ['browser:split', { id: 't', with: 'u', vertical: true }, 'split', ['t', 'u', true]],
      ['browser:split', { id: 't' }, 'split', ['t', undefined, undefined]],
      ['browser:splitUpdate', { id: 's', ratio: 0.3, swap: true }, 'updateSplit', ['s', { ratio: 0.3, swap: true }]],
      ['browser:unsplit', { id: 's' }, 'unsplit', ['s']],
      ['browser:capture', { id: 't' }, 'capture', ['t', undefined]],
      ['browser:capture', { id: 't', width: 600 }, 'capture', ['t', 600]],
      ['browser:input', { id: 't', action: 'click', x: 10, y: 20 }, 'input', ['t', { action: 'click', x: 10, y: 20 }]],
      ['browser:input', { id: 't', action: 'scroll', x: 1, y: 2, dx: 0, dy: 300 }, 'input', ['t', { action: 'scroll', x: 1, y: 2, dx: 0, dy: 300 }]],
      ['browser:input', { id: 't', action: 'type', text: 'hello' }, 'input', ['t', { action: 'type', text: 'hello' }]],
      ['browser:input', { id: 't', action: 'key', key: 'Enter' }, 'input', ['t', { action: 'key', key: 'Enter' }]]
    ]
    for (const [channel, payload, method, args] of calls) {
      const res = await router.dispatch(channel, payload, ipc)
      expect(res, channel).toEqual({ ok: true, data: { called: method, args } })
    }
    // what the schemas refuse
    expect(await router.dispatch('browser:go', { id: 't', action: 'explode' }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:configure', { searchEngine: 'altavista' }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:view', { bounds: { x: 'a' } }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:historyDelete', {}, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:historyDelete', { urls: [] }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:import', { sourceId: 'x', kinds: ['cookies'] }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:bookmarkRemove', { ids: [] }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:group', { ids: ['t'], color: '#ff0000' }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:group', { ids: [] }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:configure', { verticalTabsWidth: 20 }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:splitUpdate', { id: 's', ratio: 2 }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:capture', { id: 't', width: 50 }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:input', { id: 't', action: 'key', key: 'F13' }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:input', { id: 't', action: 'type', text: '' }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('browser:input', { id: 't', action: 'click', x: -1, y: 0 }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    // A paired phone reaches the tabs only when the desktop shares the browser — and never its own UI's channels.
    const remote = { transport: 'remote' as const }
    expect(await router.dispatch('browser:state', undefined, remote)).toMatchObject({ ok: false, error: { code: 'remote-browser-disabled' } })
    let shared = false
    const sharing = new Router({ remoteTerminal: () => false, remoteBrowser: () => shared })
    registerBrowserIpc(sharing, browser as unknown as BrowserService)
    expect(await sharing.dispatch('browser:capture', { id: 't' }, remote)).toMatchObject({ ok: false, error: { code: 'remote-browser-disabled' } })
    shared = true
    expect(await sharing.dispatch('browser:capture', { id: 't' }, remote)).toEqual({ ok: true, data: { called: 'capture', args: ['t', undefined] } })
    expect(await sharing.dispatch('browser:freeze', undefined, remote)).toMatchObject({ ok: false, error: { code: 'desktop-only' } })
  })

  it('reach the files service — and refuse names and paths that are no names or paths', async () => {
    const router = new Router()
    const finder = recorder()
    registerFinderIpc(router, finder as unknown as FinderService)
    const calls: [string, unknown, string, unknown[]][] = [
      ['finder:places', undefined, 'places', []],
      ['finder:list', { path: '/Users/me', hidden: true }, 'list', ['/Users/me', true, undefined]],
      ['finder:list', { path: '/Users/me', offset: 1000 }, 'list', ['/Users/me', undefined, 1000]],
      ['finder:list', undefined, 'list', [undefined, undefined, undefined]],
      ['finder:search', { path: '/Users/me', query: ' report ' }, 'search', ['/Users/me', 'report']],
      ['finder:preview', { path: '/a.png' }, 'preview', ['/a.png']],
      ['finder:mkdir', { parent: '/Users/me', name: 'New' }, 'mkdir', ['/Users/me', 'New']],
      ['finder:rename', { path: '/a.txt', name: 'b.txt' }, 'rename', ['/a.txt', 'b.txt']],
      ['finder:trash', { paths: ['/a.txt'] }, 'trash', [['/a.txt']]],
      ['finder:move', { paths: ['/a.txt'], dest: '/b' }, 'move', [['/a.txt'], '/b']],
      ['finder:copy', { paths: ['/a.txt'], dest: '/b' }, 'copy', [['/a.txt'], '/b']],
      ['finder:open', { path: '/a.txt' }, 'open', ['/a.txt']],
      ['finder:reveal', { path: '/a.txt' }, 'reveal', ['/a.txt']],
      ['finder:untrash', { items: [{ path: '/a', restore: '/t/a' }] }, 'untrash', [[{ path: '/a', restore: '/t/a' }]]],
      ['finder:privacySettings', undefined, 'privacySettings', []],
      ['finder:conflicts', { paths: ['/a'], dest: '/b' }, 'conflicts', [['/a'], '/b']],
      [
        'finder:transfer',
        { id: 't1', paths: ['/a'], dest: '/b', mode: 'copy', choices: { a: 'replace' } },
        'transfer',
        [{ id: 't1', paths: ['/a'], dest: '/b', mode: 'copy', choices: { a: 'replace' } }]
      ],
      ['finder:cancel', { id: 't1' }, 'cancel', ['t1']],
      ['finder:restore', { moves: [{ from: '/b/a', to: '/a' }] }, 'restore', [[{ from: '/b/a', to: '/a' }]]],
      ['finder:info', { path: '/a' }, 'info', ['/a']],
      ['finder:folderSize', { path: '/a', id: 's' }, 'folderSize', ['/a', 's']],
      ['finder:compress', { paths: ['/a'], id: 'z' }, 'compress', [['/a'], 'z']],
      ['finder:extract', { path: '/a.zip', id: 'u' }, 'extract', ['/a.zip', 'u']],
      ['finder:clipboardWrite', { paths: ['/a'], cut: true }, 'clipboardWrite', [['/a'], true]],
      ['finder:clipboardRead', undefined, 'clipboardRead', []],
      ['finder:read', { path: '/a.png' }, 'read', ['/a.png', undefined, undefined]],
      ['finder:read', { path: '/a.png', offset: 4, length: 8 }, 'read', ['/a.png', 4, 8]],
      ['finder:write', { path: '/a.txt', data: 'aGk=' }, 'write', ['/a.txt', 'aGk=', undefined, undefined]],
      ['finder:write', { path: '/a.txt', data: 'aGk=', offset: 2, replace: true }, 'write', ['/a.txt', 'aGk=', 2, true]]
    ]
    for (const [channel, payload, method, args] of calls) {
      expect(await router.dispatch(channel, payload, ipc), channel).toEqual({ ok: true, data: { called: method, args } })
    }
    expect(await router.dispatch('finder:trash', { paths: [] }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('finder:transfer', { id: 't', paths: ['/a'], dest: '/b', mode: 'delete' }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('finder:transfer', { id: 't', paths: ['/a'], dest: '/b', mode: 'copy', choices: { a: 'overwrite' } }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('finder:mkdir', { parent: '/x', name: '   ' }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('finder:write', { path: '/a.txt', data: 'not base64!' }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await router.dispatch('finder:read', { path: '/a', length: 0 }, ipc)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    // A paired device reaches the files with remote shells only — and never the host's own apps or clipboard.
    const remote = { transport: 'remote' as const }
    expect(await router.dispatch('finder:list', undefined, remote)).toMatchObject({ ok: false, error: { code: 'remote-terminal-disabled' } })
    const shells = new Router({ remoteTerminal: () => true })
    registerFinderIpc(shells, finder as unknown as FinderService)
    expect(await shells.dispatch('finder:list', undefined, remote)).toEqual({ ok: true, data: { called: 'list', args: [undefined, undefined, undefined] } })
    expect(await shells.dispatch('finder:open', { path: '/a.txt' }, remote)).toMatchObject({ ok: false, error: { code: 'desktop-only' } })
    expect(await shells.dispatch('finder:clipboardRead', undefined, remote)).toMatchObject({ ok: false, error: { code: 'desktop-only' } })
  })
})
