import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir, tick } from './helpers'
import { isLoopback, isLoopbackHost, isPageUrl, isWebUrl, originOf, resolveInput, searchUrl } from '../../../electron/main/services/browser/url'
import { bareUrl, BrowserHistory, frecency } from '../../../electron/main/services/browser/history'
import { DevServerDetector } from '../../../electron/main/services/browser/devServers'
import { ENGINE_NAMES, labels } from '../../../electron/main/services/browser/labels'
import { keyEvents, KEY_NAMES, quadCenter, renderSnapshot, type AxNode } from '../../../electron/main/services/browser/snapshot'

const DAY = 86_400_000

describe('browser addresses', () => {
  it('searches with each engine', () => {
    expect(searchUrl('google', 'a b&c')).toBe('https://www.google.com/search?q=a%20b%26c')
    expect(searchUrl('duckduckgo', 'x')).toBe('https://duckduckgo.com/?q=x')
    expect(searchUrl('kagi', 'x')).toBe('https://kagi.com/search?q=x')
  })

  it('tells pages, web addresses, loopback hosts and origins apart', () => {
    expect(isPageUrl('https://x.dev/')).toBe(true)
    expect(isPageUrl('file:///Users/me/a.html')).toBe(true)
    expect(isPageUrl('about:blank')).toBe(true)
    expect(isPageUrl('mailto:me@example.com')).toBe(false)
    expect(isPageUrl('not a url')).toBe(false)
    expect(isWebUrl('HTTPS://x')).toBe(true)
    expect(isWebUrl('file:///x')).toBe(false)
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', 'app.localhost']) expect(isLoopbackHost(host)).toBe(true)
    for (const host of ['example.com', '128.0.0.1', 'localhost.evil.com']) expect(isLoopbackHost(host)).toBe(false)
    expect(isLoopback('http://localhost:5173/x')).toBe(true)
    expect(isLoopback('https://[::1]:3000/')).toBe(true)
    expect(isLoopback('ws://localhost:1/')).toBe(false)
    expect(isLoopback('https://example.com/')).toBe(false)
    expect(isLoopback('::nope')).toBe(false)
    expect(originOf('https://example.com/a?b')).toBe('https://example.com')
    expect(originOf('file:///x')).toBe('')
    expect(originOf('nope')).toBe('')
  })

  it('makes addresses of what was typed: http on this machine and the local network, https elsewhere', () => {
    expect(resolveInput('   ', 'google')).toBe('')
    expect(resolveInput('localhost:3000', 'google')).toBe('http://localhost:3000/')
    expect(resolveInput('localhost', 'google')).toBe('http://localhost/')
    expect(resolveInput('127.0.0.1:8080/api', 'google')).toBe('http://127.0.0.1:8080/api')
    expect(resolveInput('[::1]:3000', 'google')).toBe('http://[::1]:3000/')
    expect(resolveInput('192.168.1.20:3000', 'google')).toBe('http://192.168.1.20:3000/')
    expect(resolveInput('printer.local', 'google')).toBe('http://printer.local/')
    expect(resolveInput('shop.localhost:5173', 'google')).toBe('http://shop.localhost:5173/')
    expect(resolveInput('example.com', 'google')).toBe('https://example.com/')
    expect(resolveInput('github.com/acme/shop?tab=1#x', 'google')).toBe('https://github.com/acme/shop?tab=1#x')
    expect(resolveInput('a.b', 'google')).toBe('https://a.b/')
    // file and library names typed alone are searches; with a path they are addresses
    expect(resolveInput('node.js', 'duckduckgo')).toBe('https://duckduckgo.com/?q=node.js')
    expect(resolveInput('config.json/x', 'google')).toBe('https://config.json/x')
    // a port no address can have: search for it
    expect(resolveInput('example.com:99999', 'google')).toBe('https://www.google.com/search?q=example.com%3A99999')
    // own schemes stay as they are; words and spaces search
    expect(resolveInput('https://x.dev/a', 'google')).toBe('https://x.dev/a')
    expect(resolveInput('mailto:me@example.com', 'google')).toBe('mailto:me@example.com')
    expect(resolveInput('react hooks', 'bing')).toBe('https://www.bing.com/search?q=react%20hooks')
    expect(resolveInput('mindeck', 'google')).toBe('https://www.google.com/search?q=mindeck')
    // absolute paths open as files
    expect(resolveInput('/Users/me/My Page.html', 'google')).toBe('file:///Users/me/My%20Page.html')
  })
})

describe('browser history', () => {
  const at = (now: number) => () => now

  it('counts visits per page, keeps the latest title, and weighs recent visits more', async () => {
    const dir = await tempDir()
    const file = join(dir, 'h', 'history.jsonl')
    let now = 1_000 * DAY
    const h = new BrowserHistory(file, () => now)
    await h.load() // no file yet
    h.visit('https://github.com/acme', 'acme')
    now += 1000
    h.visit('https://github.com/acme')
    h.title('https://github.com/acme', 'Acme · GitHub')
    h.title('https://github.com/acme', 'Acme · GitHub') // unchanged: nothing written
    h.title('https://github.com/acme', '') // empty: ignored
    h.title('https://unknown.dev/', 'x') // never visited: ignored
    now += 1000
    h.visit('https://example.com/docs', 'Docs')
    now += 1000
    h.visit('http://localhost:5173/', 'Dev')
    h.visit('mailto:x@y.z') // not a web page
    h.visit(`https://long.dev/${'x'.repeat(5000)}`) // too long to keep
    await h.flush()

    const again = new BrowserHistory(file, at(now))
    await again.load()
    expect(again.search('', 10).map((e) => e.url)).toEqual(['http://localhost:5173/', 'https://example.com/docs', 'https://github.com/acme'])
    expect(again.search('acme github')).toEqual([{ url: 'https://github.com/acme', title: 'Acme · GitHub', visits: 2, lastVisit: new Date(1_000 * DAY + 1000).toISOString() }])
    expect(again.search('nothing here')).toEqual([])
    // address-bar matches: the start of an address first, then anything containing the text
    expect(again.suggest('').length).toBe(0)
    expect(again.suggest('git').map((e) => e.url)).toEqual(['https://github.com/acme'])
    expect(again.suggest('docs').map((e) => e.url)).toEqual(['https://example.com/docs'])
    expect(again.suggest('DEV').map((e) => e.url)).toEqual(['http://localhost:5173/'])
    expect(again.suggest('e').map((e) => e.url)).toEqual(['https://example.com/docs', 'https://github.com/acme', 'http://localhost:5173/'])
    // top sites leave local dev pages out
    expect(again.top().map((e) => e.url)).toEqual(['https://github.com/acme', 'https://example.com/docs'])
  })

  it('weighs by age and reads URLs bare', () => {
    const now = 100 * DAY
    expect(frecency({ visits: 2, last: now - 1 * DAY }, now)).toBe(2)
    expect(frecency({ visits: 2, last: now - 10 * DAY }, now)).toBeCloseTo(1.4)
    expect(frecency({ visits: 2, last: now - 20 * DAY }, now)).toBe(1)
    expect(frecency({ visits: 2, last: now - 60 * DAY }, now)).toBeCloseTo(0.6)
    expect(frecency({ visits: 2, last: now - 99 * DAY }, now)).toBeCloseTo(0.2)
    expect(bareUrl('https://www.github.com/a')).toBe('github.com/a')
  })

  it('skips torn lines and junk, compacts once lines pile up, and caps the pages kept', async () => {
    const dir = await tempDir()
    const file = join(dir, 'history.jsonl')
    const lines = [
      '{"u":"https://a.dev/","t":"A","l":1}',
      '{"u":"https://a.dev/","l":5}',
      '{"u":42}',
      '{"u":"ftp://old/","l":1}',
      '{"u":"https://b.dev/","t":"","v":3}',
      '',
      '{"u":"https://c.dev/","l":2' // torn by a crash
    ]
    await writeFile(file, lines.join('\n'))
    const h = new BrowserHistory(file, at(10))
    await h.load()
    expect(h.search('', 10)).toEqual([
      { url: 'https://a.dev/', title: 'A', visits: 2, lastVisit: new Date(5).toISOString() },
      { url: 'https://b.dev/', title: '', visits: 3, lastVisit: new Date(0).toISOString() }
    ])

    // 2000 extra lines for one page: the next visit rewrites the file, one line per page
    await writeFile(file, Array.from({ length: 2001 }, (_, i) => JSON.stringify({ u: 'https://x.dev/', l: i })).join('\n'))
    const big = new BrowserHistory(file, at(3000))
    await big.load()
    big.visit('https://y.dev/', 'Y')
    await big.flush()
    const compacted = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(compacted).toEqual([
      { u: 'https://x.dev/', t: '', v: 2001, l: 2000 },
      { u: 'https://y.dev/', t: 'Y', v: 1, l: 3000 }
    ])

    // beyond 10,000 pages the least valuable go
    const many = Array.from({ length: 10_005 }, (_, i) => JSON.stringify({ u: `https://p${i}.dev/`, l: i }))
    const extra = Array.from({ length: 10_006 }, () => JSON.stringify({ u: 'https://p0.dev/', v: 0, l: 0 }))
    await writeFile(file, [...many, ...extra].join('\n'))
    const capped = new BrowserHistory(file, at(20_000))
    await capped.load()
    capped.visit('https://p1.dev/')
    await capped.flush()
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(10_000)
  })

  it('clears everything; a failed write is logged and the next still works', async () => {
    const dir = await tempDir()
    const file = join(dir, 'history.jsonl')
    const h = new BrowserHistory(file, at(1))
    h.visit('https://a.dev/')
    await h.flush()
    await h.clear()
    expect(h.search()).toEqual([])
    await expect(readFile(file, 'utf8')).rejects.toThrow()

    // lines without a single page worth keeping load as nothing
    await writeFile(file, Array.from({ length: 2001 }, () => JSON.stringify({ u: 'nope' })).join('\n'))
    const empty = new BrowserHistory(file, at(1))
    await empty.load()
    expect(empty.search()).toEqual([])

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const blocked = join(dir, 'blocked')
    await mkdir(join(blocked, 'history.jsonl'), { recursive: true }) // a folder where the file should be
    const broken = new BrowserHistory(join(blocked, 'history.jsonl'), at(1))
    broken.visit('https://a.dev/')
    await broken.flush()
    expect(err.mock.calls[0][0]).toBe('[browser] history write failed')
    broken.visit('https://b.dev/')
    await broken.flush()
    expect(broken.search().map((e) => e.url)).toEqual(['https://a.dev/', 'https://b.dev/'])
  })
})

describe('dev server detection', () => {
  it('reads complete lines only, strips terminal codes, and offers each local address once', () => {
    const changes: string[][] = []
    let clock = 0
    const d = new DevServerDetector((list) => changes.push(list.map((s) => `${s.label}@${s.terminalId}`)), () => new Date(1000 + clock++))
    d.feed({ id: 't1', projectId: 'shop' }, '\x1b[32m  ➜  Local:   http://localhost:51')
    expect(changes).toEqual([]) // the line has not ended yet
    d.feed({ id: 't1', projectId: 'shop' }, '73/\x1b[39m\n  ➜  Network: use --host to expose\n')
    expect(changes).toEqual([['localhost:5173@t1']])
    expect(d.list()[0]).toMatchObject({ url: 'http://localhost:5173/', projectId: 'shop', terminalId: 't1' })

    // the same address again changes nothing
    d.feed({ id: 't1' }, 'ready in 300 ms — http://localhost:5173/\n')
    expect(changes).toHaveLength(1)
    // 0.0.0.0 means this machine; OSC hyperlinks and trailing punctuation are no part of the address
    d.feed({ id: 't2' }, '\x1b]8;;http://x\x07link\x1b]8;;\x07 Listening on http://0.0.0.0:3000.\n')
    expect(d.list().map((s) => s.url)).toEqual(['http://localhost:3000/', 'http://localhost:5173/'])
    // nothing that is not an address with a port
    d.feed({ id: 't2' }, 'see http://localhost/ and http://example.com:8080 and http://localhost:99999\n')
    expect(d.list()).toHaveLength(2)

    // the same server in two terminals shows once; at most four per terminal
    d.feed({ id: 't3' }, 'http://127.0.0.1:8000/ http://127.0.0.1:8001 http://[::1]:8002 http://app.localhost:8003 http://localhost:8004\nhttp://localhost:3000\n')
    expect(d.list().filter((s) => s.terminalId === 't3').map((s) => s.label)).toEqual(['localhost:3000', 'localhost:8004', 'app.localhost:8003', '[::1]:8002'])
    expect(d.list().filter((s) => s.url === 'http://localhost:3000/')).toHaveLength(1)

    // a terminal that ends takes its servers along
    const before = changes.length
    d.exit('t3')
    expect(changes).toHaveLength(before + 1)
    d.exit('t3') // already gone: no change
    d.exit('t9')
    expect(changes).toHaveLength(before + 1)
  })

  it('stamps detections with the real clock by default', () => {
    const d = new DevServerDetector(() => {})
    d.feed({ id: 't' }, 'http://localhost:4321\n')
    expect(Date.parse(d.list()[0].detectedAt)).toBeGreaterThan(0)
  })
})

describe('native menu words', () => {
  it('speaks German and English', () => {
    const de = labels('de')
    const en = labels('en')
    expect(de.reload).toBe('Neu laden')
    expect(en.reload).toBe('Reload')
    expect(de.handoff('Arc')).toBe('In Arc öffnen')
    expect(de.handoff('')).toBe('Im System-Browser öffnen')
    expect(en.handoff('Safari')).toBe('Open in Safari')
    expect(en.handoff('')).toBe('Open in System Browser')
    expect(de.zoomReset(110)).toBe('Originalgröße (110 %)')
    expect(en.zoomReset(90)).toBe('Actual Size (90 %)')
    expect(en.searchFor('Google', 'short')).toBe('Search Google for “short”')
    expect(de.searchFor('Google', 'kurz')).toBe('Mit Google nach „kurz“ suchen')
    expect(de.searchFor('Google', 'a really long piece of selected text')).toBe('Mit Google nach „a really long piece of s…“ suchen')
    expect(en.searchFor('Kagi', 'a really long piece of selected text')).toBe('Search Kagi for “a really long piece of s…”')
    expect(ENGINE_NAMES.duckduckgo).toBe('DuckDuckGo')
  })
})

describe('page snapshots for agents', () => {
  const node = (nodeId: string, role: string, extra: Partial<AxNode> = {}): AxNode => ({ nodeId, role: { value: role }, ...extra })

  it('lists what matters, gives everything actionable a ref, and never shows a password', () => {
    const nodes: AxNode[] = [
      node('1', 'RootWebArea', { name: { value: 'Shop' }, childIds: ['2', '3', '20', '99'] }),
      node('2', 'banner', { childIds: ['4'] }),
      node('4', 'link', { name: { value: 'Acme' }, backendDOMNodeId: 40, childIds: ['5'] }),
      node('5', 'StaticText', { name: { value: 'Acme' } }), // same as the link's name: left out
      node('3', 'main', { childIds: ['6', '7', '8', '9', '10', '11', '12', '13', '14'] }),
      node('6', 'heading', { name: { value: 'Choose a plan' }, properties: [{ name: 'level', value: { value: 1 } }] }),
      node('7', 'generic', { ignored: true, childIds: ['15'] }), // ignored, its child still counts
      node('15', 'StaticText', { name: { value: '€29 / month' } }),
      node('8', 'text', { name: { value: '€29 / month' } }), // the same text twice in a row: once
      node('9', 'button', {
        name: { value: 'Upgrade' },
        backendDOMNodeId: 90,
        properties: [
          { name: 'pressed', value: { value: 'mixed' } },
          { name: 'disabled', value: { value: false } },
          { name: 'focused', value: { value: 'false' } },
          { name: 'expanded', value: { value: undefined } },
          { name: 'url', value: { value: 'x' } }
        ]
      }),
      node('10', 'checkbox', { name: { value: 'Yearly' }, backendDOMNodeId: 100, properties: [{ name: 'checked', value: { value: 'true' } }, { name: 'required', value: { value: true } }] }),
      node('11', 'textbox', { name: { value: 'Email' }, backendDOMNodeId: 110, value: { value: 'robin@example.com' } }),
      node('12', 'textbox', { name: { value: 'Password' }, backendDOMNodeId: 120, value: { value: 'hunter2' } }),
      node('13', 'textbox', { name: { value: 'Same' }, value: { value: 'Same' } }), // no DOM node: no ref; value equal to name: left out
      node('14', 'img', { name: { value: 'x'.repeat(200) } }), // long names are clipped
      node('20', 'list', { childIds: ['21', '22'] }),
      node('21', 'listitem', { name: { value: '' } }), // nameless content: left out
      node('22', 'paragraph', { name: { value: 42 as unknown as string } }) // numbers read as text
    ]
    const snap = renderSnapshot(nodes, { secret: new Set([120]) })
    expect(snap.text).toBe(
      [
        '- banner',
        '  - link "Acme" [e1]',
        '- main',
        '  - heading "Choose a plan" (h1)',
        '  - text "€29 / month"',
        '  - button "Upgrade" [e2] (pressed=mixed)',
        '  - checkbox "Yearly" [e3] (checked, required)',
        '  - textbox "Email" [e4] = "robin@example.com"',
        '  - textbox "Password" [e5] = [protected]',
        '  - textbox "Same"',
        `  - img "${'x'.repeat(160)}…"`,
        '- list',
        '  - paragraph "42"'
      ].join('\n')
    )
    expect(snap.refs.get('e2')).toEqual({ node: 90, label: 'button "Upgrade"' })
    expect(snap.refs.get('e5')).toEqual({ node: 120, label: 'textbox "Password"' })
    expect(snap.truncated).toBe(false)
  })

  it('stops at its size limit and says so; reads odd values as nothing', () => {
    const nodes: AxNode[] = [node('1', 'RootWebArea', { childIds: ['2', '3', '4', 'missing'] })]
    nodes.push(node('2', 'button', { name: { value: 'One' }, backendDOMNodeId: 1 }))
    nodes.push(node('3', 'button', { name: { value: { odd: true } as unknown as string }, backendDOMNodeId: 2 }))
    nodes.push(node('4', 'button', { name: { value: 'Three' }, backendDOMNodeId: 3 }))
    const snap = renderSnapshot(nodes, { maxChars: 34 })
    expect(snap.text).toBe('- button "One" [e1]\n- button [e2]\n… (the page goes on — act on what is above, or scroll and take a new snapshot)')
    expect(snap.truncated).toBe(true)
    expect(renderSnapshot([]).text).toBe('')
    expect(renderSnapshot([{ nodeId: '1' }]).text).toBe('')
  })

  it('finds the middle of an element and the keys to press', () => {
    expect(quadCenter([10, 20, 110, 20, 110, 60, 10, 60])).toEqual({ x: 60, y: 40 })
    expect(keyEvents('Enter')).toEqual([
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    ])
    expect(keyEvents('Tab')[0]).toMatchObject({ type: 'rawKeyDown', key: 'Tab' })
    expect(keyEvents('Space')[0]).toMatchObject({ type: 'keyDown', key: ' ', text: ' ' })
    expect(KEY_NAMES).toContain('Escape')
    expect(() => keyEvents('F13')).toThrow(/Unknown key: F13/)
  })
})

void tick
