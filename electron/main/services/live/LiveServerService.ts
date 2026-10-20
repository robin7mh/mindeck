import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, relative, sep } from 'node:path'
import type { LiveServerSettings } from '@shared/types/migrate'
import type { LiveServerStatus } from '@shared/types/live'
import { confine } from '../../lib/confine'
import { isDeniedName } from '../../server/RemoteAccess'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * The names the server answers to. It listens on 127.0.0.1 only, but a web page
 * can rebind its own name to 127.0.0.1 (DNS rebinding) and then read answers
 * same-origin — its Host header still says `evil.example`.
 */
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i

/** Never served: dotfiles and folders (`.env`, `.git/config` — `.well-known` excepted) and keys or credentials. */
export function isPrivatePath(path: string): boolean {
  return path.split(/[\\/]+/).some((name) => (name.startsWith('.') && name !== '.well-known') || isDeniedName(name))
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf'
}

const EVENTS = '/__mindeck_live'

/** What every served HTML page gets: reload on changes, styles swapped in place. */
export const RELOAD_SCRIPT = `<script>(function(){var s=new EventSource('${EVENTS}');s.onmessage=function(e){if(e.data==='css'){document.querySelectorAll('link[rel="stylesheet"]').forEach(function(l){var u=new URL(l.href);u.searchParams.set('mindeck',Date.now());l.href=u.href})}else{location.reload()}}})();</script>`

/** Insert the reload script before </body> (or at the end). */
export function inject(html: string): string {
  const at = html.toLowerCase().lastIndexOf('</body>')
  return at < 0 ? html + RELOAD_SCRIPT : html.slice(0, at) + RELOAD_SCRIPT + html.slice(at)
}

/** A simple glob test (`*`, `**`, `?`) on a posix path. */
export function matchesGlob(path: string, glob: string): boolean {
  const re = glob
    .replace(/^\.?\//, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${re}$`).test(path)
}

const IGNORED = /(^|\/)(\.git|node_modules)(\/|$)/

/** A watch event that changed nothing a page shows: a folder (its files report themselves), or a file older than the watch (macOS replays recent events). Gone files did change. */
export function unchanged(info: { isDirectory(): boolean; mtimeMs: number } | null, since: number): boolean {
  return !!info && (info.isDirectory() || info.mtimeMs < since)
}

interface Running {
  status: LiveServerStatus
  server: Server
  clients: Set<ServerResponse>
  watcher: FSWatcher
  timer?: NodeJS.Timeout
  /** When watching began — macOS replays recent changes at the start; older files don't count. */
  since: number
  /** A change in this window needs a full reload (anything but a stylesheet changed). */
  reload: boolean
}

export interface LiveServerOptions {
  resolveRoot: (projectId: string) => string | undefined
  /** The user's Live Server settings (moved over from VS Code). */
  settings?: () => LiveServerSettings | undefined
  /** Open a URL in the browser (desktop). */
  open?: (url: string) => Promise<void>
  /** Which servers run changed. */
  publish?: (status: LiveServerStatus[]) => void
}

/** Ports tried after the first one when it is taken. */
const PORT_TRIES = 20

/**
 * Live Server: a project folder served on 127.0.0.1, and every page reloads
 * when a file changes — styles swap in place without a reload. One server
 * per project; its settings come over from VS Code's Live Server extension.
 */
export class LiveServerService {
  private readonly running = new Map<string, Running>()

  constructor(private readonly opts: LiveServerOptions) {}

  status(): LiveServerStatus[] {
    return [...this.running.values()].map((r) => r.status)
  }

  /** Serve the project (its configured root, or `dir`); opens `page` (a project file) in the browser unless told not to. */
  async start(projectId: string, page?: string): Promise<LiveServerStatus> {
    const settings = this.opts.settings?.() ?? {}
    const existing = this.running.get(projectId)
    if (existing) {
      await this.browse(existing.status, page, settings)
      return existing.status
    }
    const configured = this.opts.resolveRoot(projectId)
    if (!configured) throw coded('not-found', `Unknown project: ${projectId}`)
    const project = await realpath(configured)
    const rootRel = (settings.root ?? '').replace(/^\/+|\/+$/g, '')
    const root = await confine(project, rootRel || '.')
    if (!(await stat(root).catch(() => null))?.isDirectory()) throw coded('not-found', `${rootRel} is not a folder`)

    const clients = new Set<ServerResponse>()
    const server = createServer((req, res) => void this.serve(root, clients, req, res))
    const port = await listen(server, settings.port ?? 5500)
    const status: LiveServerStatus = { projectId, url: `http://127.0.0.1:${port}`, port, root: rootRel }
    const run: Running = { status, server, clients, watcher: watch(root, { recursive: true }), since: Date.now(), reload: false }
    run.watcher.on('change', (_event, file) => void this.changed(run, root, String(file), settings))
    run.watcher.on('error', () => {})
    this.running.set(projectId, run)
    this.publish()
    await this.browse(status, page, settings)
    return status
  }

  async stop(projectId: string): Promise<void> {
    const run = this.running.get(projectId)
    if (!run) return
    this.running.delete(projectId)
    clearTimeout(run.timer)
    run.watcher.close()
    for (const c of run.clients) c.end()
    await new Promise<void>((r) => run.server.close(() => r()))
    this.publish()
  }

  dispose(): void {
    for (const id of [...this.running.keys()]) void this.stop(id)
  }

  // --- helpers ---

  private async browse(status: LiveServerStatus, page: string | undefined, settings: LiveServerSettings): Promise<void> {
    if (settings.noBrowser || !this.opts.open) return
    // A page inside the served folder opens at its own path.
    const prefix = status.root ? `${status.root}/` : ''
    const rel = page && (!prefix || page.startsWith(prefix)) ? page.slice(prefix.length) : ''
    await this.opts.open(`${status.url}/${rel.split('/').map(encodeURIComponent).join('/')}`)
  }

  private async changed(run: Running, root: string, file: string, settings: LiveServerSettings): Promise<void> {
    const rel = file.split(sep).join('/')
    if (IGNORED.test(rel) || settings.ignore?.some((g) => matchesGlob(rel, g))) return
    // A folder (its files report themselves) or a file untouched since watching began (a replayed event): nothing changed.
    if (unchanged(await stat(join(root, file)).catch(() => null), run.since)) return
    // Within one window: stylesheets swap in place only if nothing else changed.
    run.reload ||= settings.fullReload || extname(rel) !== '.css'
    clearTimeout(run.timer)
    run.timer = setTimeout(() => {
      const kind = run.reload ? 'reload' : 'css'
      run.reload = false
      for (const c of run.clients) c.write(`data: ${kind}\n\n`)
    }, settings.wait ?? 100)
  }

  private async serve(root: string, clients: Set<ServerResponse>, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!LOCAL_HOST.test(req.headers.host ?? '')) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      return void res.end('Forbidden')
    }
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url!, 'http://x').pathname)
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      return void res.end('Bad request')
    }
    if (path === EVENTS) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    try {
      if (isPrivatePath(path)) throw coded('not-found', 'private')
      let file = await confine(root, `.${path}`)
      // …and what it really is: `config.txt -> .env` is just as private.
      if (isPrivatePath(relative(await realpath(root), await realpath(file)))) throw coded('not-found', 'private')
      let info = await stat(file)
      if (info.isDirectory()) {
        const index = join(file, 'index.html')
        if (!(await stat(index).catch(() => null))) return this.listing(root, file, res)
        file = index
        info = await stat(file)
      }
      const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(type.startsWith('text/html') ? inject(body.toString('utf8')) : body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end(inject(`<!doctype html><title>404</title><p>Not found: ${escape(path)}</p>`))
    }
  }

  /** A folder without index.html: its entries as links. */
  private async listing(root: string, dir: string, res: ServerResponse): Promise<void> {
    const rel = relative(root, dir).split(sep).join('/')
    const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => !isPrivatePath(e.name))
    const items = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${escape(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`)
      .join('')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(inject(`<!doctype html><title>/${escape(rel)}</title><h1>/${escape(rel)}</h1><ul>${items}</ul>`))
  }

  private publish(): void {
    this.opts.publish?.(this.status())
  }
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** Listen on the first free port from `first` on (127.0.0.1 only). */
export function listen(server: Server, first: number, tries = PORT_TRIES): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number, left: number) => {
      const failed = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && left > 1) attempt(port + 1, left - 1)
        else reject(err)
      }
      server.once('error', failed)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', failed)
        resolve((server.address() as { port: number }).port)
      })
    }
    attempt(first, tries)
  })
}
