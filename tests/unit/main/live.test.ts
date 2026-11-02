import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { inject, listen, LiveServerService, matchesGlob, RELOAD_SCRIPT, unchanged } from '../../../electron/main/services/live/LiveServerService'
import { outputPath, SassService, type SassCompiler } from '../../../electron/main/services/live/SassService'
import { liveServerSettings, sassSettings } from '../../../electron/main/services/migrate/MigrateService'
import type { LiveServerSettings, SassSettings } from '@shared/types/migrate'
import type { LiveServerStatus } from '@shared/types/live'

const services: LiveServerService[] = []
afterEach(() => services.splice(0).forEach((s) => s.dispose()))

async function site() {
  const root = await tempDir('mindeck-live-')
  await mkdir(join(root, 'public/css'), { recursive: true })
  await mkdir(join(root, 'public/empty'), { recursive: true })
  await writeFile(join(root, 'public/index.html'), '<html><body><h1>Hi</h1></body></html>')
  await writeFile(join(root, 'public/about.html'), '<p>no body tag</p>')
  await writeFile(join(root, 'public/css/site.css'), 'h1 { color: red }')
  await writeFile(join(root, 'public/empty/notes.txt'), 'text')
  await mkdir(join(root, 'public/empty/sub'), { recursive: true })
  await writeFile(join(root, 'public/empty/more.txt'), 'text')
  await writeFile(join(root, 'public/data.bin'), Buffer.from([1, 2, 3]))
  await writeFile(join(root, 'public/.hidden'), '')
  return root
}

function make(root: string | undefined, settings: LiveServerSettings = {}) {
  const opened: string[] = []
  const published: LiveServerStatus[][] = []
  const service = new LiveServerService({ resolveRoot: () => root, settings: () => settings, open: async (url) => void opened.push(url), publish: (s) => published.push(s) })
  services.push(service)
  return { service, opened, published }
}

/** Read the reload stream until a message arrives. */
async function nextEvent(url: string): Promise<string> {
  const res = await fetch(`${url}/__mindeck_live`)
  const reader = res.body!.getReader()
  let text = ''
  for (;;) {
    const { value } = await reader.read()
    text += new TextDecoder().decode(value)
    const data = /data: (\w+)/.exec(text)
    if (data) {
      await reader.cancel()
      return data[1]
    }
  }
}

/** GET with an explicit Host header (fetch can't set one). */
function statusWithHost(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('Live Server', () => {
  it('starting twice at once opens one server', async () => {
    const root = await site()
    const { service } = make(root, { port: 0, noBrowser: true })
    const [a, b] = await Promise.all([service.start('p'), service.start('p')])
    expect(a).toEqual(b)
    expect(service.status()).toHaveLength(1)
  })

  it('serves a folder with the reload script, index pages, listings, files and 404s', async () => {
    const root = await site()
    const { service, opened, published } = make(root, { root: '/public/', port: 0 })
    const status = await service.start('p', 'public/about.html')
    expect(status).toMatchObject({ projectId: 'p', root: 'public' })
    expect(opened).toEqual([`${status.url}/about.html`])
    expect(published.at(-1)).toEqual([status])
    expect(service.status()).toEqual([status])

    const index = await (await fetch(`${status.url}/`)).text()
    expect(index).toBe(`<html><body><h1>Hi</h1>${RELOAD_SCRIPT}</body></html>`)
    expect(await (await fetch(`${status.url}/about.html`)).text()).toBe(`<p>no body tag</p>${RELOAD_SCRIPT}`)
    const css = await fetch(`${status.url}/css/site.css`)
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await css.text()).toBe('h1 { color: red }')
    expect((await fetch(`${status.url}/data.bin`)).headers.get('content-type')).toBe('application/octet-stream')
    const listing = await (await fetch(`${status.url}/empty/`)).text()
    expect(listing).toContain('<a href="notes.txt">notes.txt</a>')
    expect(listing).toContain('<a href="sub/">sub/</a>')
    expect(listing.indexOf('sub/')).toBeLessThan(listing.indexOf('notes.txt')) // folders first
    const top = await (await fetch(`${status.url}/css`)).text()
    expect(top).toContain('site.css')
    const missing = await fetch(`${status.url}/nope.html`)
    expect(missing.status).toBe(404)
    expect(await (await fetch(`${status.url}/../../etc/passwd`)).text()).toContain('Not found')
    // A malformed escape is a 400, not an unhandled rejection; a foreign Host (DNS rebinding) is refused.
    expect((await fetch(`${status.url}/%E0%A4%A`)).status).toBe(400)
    expect(await statusWithHost(status.port, '/index.html', 'evil.example:5500')).toBe(403)
    expect(await statusWithHost(status.port, '/index.html', `localhost:${status.port}`)).toBe(200)

    // Started again: the same server, the page opens.
    expect(await service.start('p')).toEqual(status)
    expect(opened.at(-1)).toBe(`${status.url}/`)
    expect(await service.start('p', 'outside/x.html')).toEqual(status)
    expect(opened.at(-1)).toBe(`${status.url}/`)
    await service.stop('p')
    await service.stop('p')
    expect(service.status()).toEqual([])
    expect(published.at(-1)).toEqual([])
  })

  it('reloads pages on changes, swaps styles in place, ignores what it should', async () => {
    const root = await site()
    const { service } = make(root, { port: 0, wait: 10, ignore: ['**/*.log'] })
    const { url } = await service.start('p')
    const reload = nextEvent(url)
    await new Promise((r) => setTimeout(r, 100))
    await writeFile(join(root, 'debug.log'), 'x') // ignored
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await writeFile(join(root, 'node_modules/x.js'), 'x') // ignored
    await writeFile(join(root, 'public/index.html'), '<body>v2</body>')
    expect(await reload).toBe('reload')
    const swap = nextEvent(url)
    await new Promise((r) => setTimeout(r, 100))
    await writeFile(join(root, 'public/css/site.css'), 'h1 { color: blue }')
    expect(await swap).toBe('css')

    // A stylesheet and a page in the same moment (one window): the page needs a reload.
    const calm = make(root, { port: 0, wait: 400, noBrowser: true })
    const third = await calm.service.start('r')
    const both = nextEvent(third.url)
    await new Promise((r) => setTimeout(r, 100))
    await writeFile(join(root, 'public/css/site.css'), 'h1 { color: red }')
    await writeFile(join(root, 'public/index.html'), '<body>v3</body>')
    expect(await both).toBe('reload')
    // A deleted page reloads too.
    const gone = nextEvent(third.url)
    await new Promise((r) => setTimeout(r, 100))
    await rm(join(root, 'public/index.html'))
    expect(await gone).toBe('reload')
    await writeFile(join(root, 'public/index.html'), '<body>back</body>')

    const full = make(root, { port: 0, fullReload: true, noBrowser: true })
    const second = await full.service.start('q', 'public/index.html')
    expect(full.opened).toEqual([])
    const again = nextEvent(second.url)
    await new Promise((r) => setTimeout(r, 100))
    await writeFile(join(root, 'public/css/site.css'), 'h1 { color: green }')
    expect(await again).toBe('reload')
  }, 20_000)

  it('a new folder (and events replayed from before the watch) change nothing: a style still swaps in place', async () => {
    const root = await site() // fresh: no late events from other writes
    // The site's files are older than the watch (not written in the millisecond it starts).
    await new Promise((r) => setTimeout(r, 50))
    const { service } = make(root, { port: 0, wait: 10, noBrowser: true })
    const { url } = await service.start('p')
    const swap = nextEvent(url)
    await new Promise((r) => setTimeout(r, 100))
    await mkdir(join(root, 'public/fresh'))
    await new Promise((r) => setTimeout(r, 100))
    await writeFile(join(root, 'public/css/site.css'), 'h1 { color: blue }')
    expect(await swap).toBe('css')
  }, 10_000)

  it('what a watch event means: folders and files older than the watch changed nothing; deleted files did', () => {
    const file = (mtimeMs: number, dir = false) => ({ isDirectory: () => dir, mtimeMs })
    expect([unchanged(file(5, true), 10), unchanged(file(5), 10), unchanged(file(15), 10), unchanged(null, 10)]).toEqual([true, true, false, false])
  })

  it('refuses unknown projects and roots that aren’t folders; takes the next free port', async () => {
    const root = await site()
    await expect(make(undefined).service.start('p')).rejects.toMatchObject({ code: 'not-found' })
    await expect(make(root, { root: 'public/index.html', port: 0 }).service.start('p')).rejects.toMatchObject({ code: 'not-found' })
    await expect(make(root, { root: 'missing', port: 0 }).service.start('p')).rejects.toMatchObject({ code: 'not-found' })
    const plain = new LiveServerService({ resolveRoot: () => root })
    services.push(plain)
    expect((await plain.start('p')).port).toBeGreaterThanOrEqual(5500) // no settings, no browser to open

    const taken = createServer()
    const port = await listen(taken, 0)
    const next = createServer()
    expect(await listen(next, port)).not.toBe(port)
    const none = createServer()
    await expect(listen(none, port, 1)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    taken.close()
    next.close()
  })

  it('injects and matches globs', () => {
    expect(inject('<BODY></BODY>')).toBe(`<BODY>${RELOAD_SCRIPT}</BODY>`)
    expect(matchesGlob('a/b/c.log', '**/*.log')).toBe(true)
    expect(matchesGlob('c.log', '**/*.log')).toBe(true)
    expect(matchesGlob('src/x.ts', './src/*.ts')).toBe(true)
    expect(matchesGlob('src/a/x.ts', 'src/*.ts')).toBe(false)
    expect(matchesGlob('ab', 'a?')).toBe(true)
  })
})

describe('Live Sass Compiler', () => {
  async function styles() {
    const root = await tempDir('mindeck-sass-')
    await mkdir(join(root, 'scss/parts'), { recursive: true })
    await mkdir(join(root, 'node_modules/lib'), { recursive: true })
    await mkdir(join(root, 'vendor'), { recursive: true })
    await writeFile(join(root, 'scss/parts/_colors.scss'), '$brand: #f00;')
    await writeFile(join(root, 'scss/main.scss'), "@use 'parts/colors';\nh1 { color: colors.$brand; .x { margin: 0 } }")
    await writeFile(join(root, 'scss/broken.scss'), 'h1 { color: ; ')
    await writeFile(join(root, 'scss/indented.sass'), 'p\n  margin: 0')
    await writeFile(join(root, 'node_modules/lib/x.scss'), 'a { b: c }')
    await writeFile(join(root, 'vendor/v.scss'), 'a { b: c }')
    await writeFile(join(root, 'notes.txt'), '')
    return root
  }

  it('compiles a saved file next to it; a partial recompiles everything; errors point at the line', async () => {
    const root = await styles()
    let settings: SassSettings | undefined
    const sass = new SassService(() => root, () => settings)
    expect(await sass.compile('p', 'notes.txt')).toEqual({ written: [], errors: {} })
    const one = await sass.compile('p', 'scss/main.scss')
    expect(one).toEqual({ written: ['scss/main.css'], errors: { 'scss/main.scss': [] } })
    expect(await readFile(join(root, 'scss/main.css'), 'utf8')).toBe('h1 {\n  color: #f00;\n}\nh1 .x {\n  margin: 0;\n}\n')

    const all = await sass.compile('p', 'scss/parts/_colors.scss')
    expect(all.written.sort()).toEqual(['scss/indented.css', 'scss/main.css', 'vendor/v.css'])
    expect(all.errors['scss/broken.scss'][0]).toMatchObject({ severity: 'error', source: 'Sass', range: { start: { line: 1 } } })

    settings = {
      formats: [
        { format: 'compressed', extensionName: '.min.css', savePath: '/dist/css' },
        { format: 'expanded', extensionName: '.css', savePath: '~/../out' }
      ],
      generateMap: true,
      exclude: ['vendor', '**/broken.scss']
    }
    const custom = await sass.compileAll('p')
    expect(custom.written).toEqual(['dist/css/indented.min.css', 'out/indented.css', 'dist/css/main.min.css', 'out/main.css'])
    expect(await readFile(join(root, 'dist/css/main.min.css'), 'utf8')).toBe('h1{color:red}h1 .x{margin:0}\n/*# sourceMappingURL=main.min.css.map */\n')
    expect(JSON.parse(await readFile(join(root, 'dist/css/main.min.css.map'), 'utf8'))).toHaveProperty('mappings')
    expect(await sass.compile('p', 'vendor/v.scss')).toEqual({ written: [], errors: {} })
    expect(await sass.compile('p', 'scss/broken.scss')).toEqual({ written: [], errors: {} })
  })

  it('never writes outside the project; unknown projects; a compiler without maps or spans', async () => {
    const root = await styles()
    // Without settings: next to the file, expanded.
    expect((await new SassService(() => root).compile('p', 'scss/main.scss')).written).toEqual(['scss/main.css'])
    const escape = new SassService(() => root, () => ({ formats: [{ format: 'expanded', extensionName: '.css', savePath: '/../../evil' }] }))
    await expect(escape.compile('p', 'scss/main.scss')).rejects.toMatchObject({ code: 'outside-project' })
    await expect(new SassService(() => undefined).compileAll('p')).rejects.toMatchObject({ code: 'not-found' })
    const fake: SassCompiler = {
      compileAsync: async (path) => {
        if (path.endsWith('main.scss')) return { css: 'x{}' }
        throw 'plain failure'
      }
    }
    const result = await new SassService(() => root, () => ({ generateMap: true, exclude: ['vendor'] }), async () => fake).compileAll('p')
    expect(result.written).toEqual(['scss/main.css'])
    expect(result.errors['scss/indented.sass']).toEqual([{ range: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 2 } }, message: 'plain failure', severity: 'error', source: 'Sass' }])
  })

  it('output paths follow the Live Sass Compiler’s rules', () => {
    expect(outputPath('/r', '/r/a/b.scss', { format: 'expanded', extensionName: '.css' })).toBe('/r/a/b.css')
    expect(outputPath('/r', '/r/a/b.scss', { format: 'expanded', extensionName: '.css', savePath: '/css' })).toBe('/r/css/b.css')
    expect(outputPath('/r', '/r/a/b.scss', { format: 'expanded', extensionName: '.css', savePath: '~/../css' })).toBe('/r/css/b.css')
  })
})

describe('their VS Code settings come along', () => {
  it('Live Server: port, root, browser, reload, ignores, wait', () => {
    expect(liveServerSettings({})).toBeUndefined()
    expect(
      liveServerSettings({
        'liveServer.settings.port': 5501,
        'liveServer.settings.root': '/public',
        'liveServer.settings.NoBrowser': true,
        'liveServer.settings.fullReload': false,
        'liveServer.settings.ignoreFiles': ['**/*.scss', 3],
        'liveServer.settings.wait': 200
      })
    ).toEqual({ port: 5501, root: '/public', noBrowser: true, fullReload: false, ignore: ['**/*.scss'], wait: 200 })
    expect(liveServerSettings({ 'liveServer.settings.port': 99999, 'liveServer.settings.root': ' ', 'liveServer.settings.wait': -1, 'liveServer.settings.ignoreFiles': 'x' })).toBeUndefined()
  })

  it('Live Sass: formats, maps, excludes, watch on launch', () => {
    expect(sassSettings({})).toBeUndefined()
    expect(
      sassSettings({
        'liveSassCompile.settings.formats': [
          { format: 'compressed', extensionName: '.min.css', savePath: '/dist' },
          { format: 'expanded', extensionName: '.css' },
          { format: 'nested', extensionName: '.css' },
          null
        ],
        'liveSassCompile.settings.generateMap': false,
        'liveSassCompile.settings.excludeList': ['/node_modules/**'],
        'liveSassCompile.settings.watchOnLaunch': true
      })
    ).toEqual({
      formats: [
        { format: 'compressed', extensionName: '.min.css', savePath: '/dist' },
        { format: 'expanded', extensionName: '.css', savePath: null }
      ],
      generateMap: false,
      exclude: ['/node_modules/**'],
      watchOnLaunch: true
    })
    expect(sassSettings({ 'liveSassCompile.settings.formats': [{ format: 'x' }] })).toBeUndefined()
  })
})
