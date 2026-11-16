import type { ElectronApplication } from '@playwright/test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

type Route = (req: IncomingMessage, res: ServerResponse) => void

const page = (title: string, body: string) => `<!doctype html><title>${title}</title>${body}`

/**
 * A local site for the browser: `/` and `/second` (each with its own title),
 * `/private` behind HTTP Basic auth (e2e / secret), `/report.txt` as a
 * download — plus whatever routes a test adds.
 */
export async function localSite(extra: Record<string, Route> = {}) {
  const routes: Record<string, Route> = {
    '/': (_req, res) => res.end(page('Mindeck E2E', '<h1>Hello from localhost</h1>')),
    '/second': (_req, res) => res.end(page('Second page', '<h1>Second</h1>')),
    '/third': (_req, res) => res.end(page('Third page', '<h1>Third</h1>')),
    '/private': (req, res) => {
      if (req.headers.authorization !== `Basic ${Buffer.from('e2e:secret').toString('base64')}`) {
        res.statusCode = 401
        res.setHeader('www-authenticate', 'Basic realm="Mindeck QA"')
        return void res.end('locked')
      }
      res.end(page('Members only', '<h1>Welcome in</h1>'))
    },
    '/report.txt': (_req, res) => {
      res.setHeader('content-type', 'text/plain')
      res.setHeader('content-disposition', 'attachment; filename="report.txt"')
      res.end('quarterly numbers\n')
    },
    ...extra
  }
  const server = createServer((req, res) => {
    const route = routes[(req.url ?? '/').split('?')[0]]
    if (!route) {
      res.statusCode = 404
      return void res.end()
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    route(req, res)
  })
  await new Promise<void>((done) => server.listen(0, done))
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

/**
 * A shortcut the main process takes (the browser's keys, full screen): those
 * wait for real input, which Playwright's keyboard (CDP) never is — this sends
 * it through Chromium's input pipeline like a key press. `mod`: ⌘ on macOS,
 * Ctrl elsewhere.
 */
export async function pressInMain(app: ElectronApplication, keyCode: string, modifiers: ('mod' | 'shift' | 'alt')[] = []) {
  const mods = modifiers.map((m) => (m === 'mod' ? (process.platform === 'darwin' ? 'meta' : 'control') : m))
  await app.evaluate(
    ({ BrowserWindow }, { keyCode, mods }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods as Electron.KeyboardInputEvent['modifiers'] })
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods as Electron.KeyboardInputEvent['modifiers'] })
    },
    { keyCode, mods }
  )
}
