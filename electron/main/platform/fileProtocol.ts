import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, posix, win32 } from 'node:path'
import { Readable } from 'node:stream'

/**
 * `mindeck-file://local/<path>` — a file for the Files module's previews (images,
 * video with seeking, audio); `mindeck-file://thumb/<path>?size=256` — the OS's
 * thumbnail of any file (Quick Look on macOS). Registered on the Mindeck UI's
 * own session only: web pages in the browser never reach it.
 */
export const FILE_SCHEME = 'mindeck-file'

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  '.pdf': 'application/pdf'
}

export interface FileProtocolDeps {
  /** The OS's thumbnail of a file as PNG; null when there is none. */
  thumbnail?: (path: string, size: number) => Promise<Buffer | null>
  platform?: NodeJS.Platform
}

const text = (status: number, body = '', headers: Record<string, string> = {}) => new Response(body, { status, headers })

/** A served file never runs as a page: no scripts, nothing loaded from elsewhere, its own opaque origin. */
const SANDBOX = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"


/** A Windows path to another machine or a device (`\\host\share`, `//host/share`, `\\?\C:\…`). */
const NETWORK_PATH = /^[\\/]{2}/

/** The absolute path a protocol URL stands for (null when it is none). */
export function pathOf(url: URL, platform: NodeJS.Platform = process.platform): string | null {
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  // Windows: /C:/Users/… → C:/Users/…
  if (platform === 'win32' && /^\/[a-z]:\//i.test(path)) path = path.slice(1)
  // …and never `\\host\share` or `\\?\…` (either slash): merely looking there sends the user's credentials (NTLM).
  if (platform === 'win32' && NETWORK_PATH.test(path)) return null
  const absolute = platform === 'win32' ? win32.isAbsolute(path) : posix.isAbsolute(path)
  return absolute && !path.includes('\0') ? path : null
}

export async function serveFile(request: Request, deps: FileProtocolDeps = {}): Promise<Response> {
  const url = new URL(request.url)
  const path = pathOf(url, deps.platform)
  if (!path) return text(400, 'Bad path')

  if (url.hostname === 'thumb') {
    const size = Math.max(16, Math.min(1024, Number(url.searchParams.get('size')) || 256))
    const png = await deps.thumbnail?.(path, size).catch(() => null)
    return png ? new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'max-age=60' } }) : text(404)
  }
  if (url.hostname !== 'local') return text(404)

  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return text(404, 'Not found')
  // Only media is served as itself — anything else as plain text, so nothing runs here. Should a
  // picture ever be opened as a page (an SVG with a script), it is a sandboxed one without scripts.
  const type = TYPES[extname(path).toLowerCase()] ?? 'text/plain; charset=utf-8'
  const headers: Record<string, string> = { 'content-type': type, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'content-security-policy': SANDBOX }

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
  if (range && (range[1] || range[2])) {
    const size = info.size
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start > end || start >= size) return text(416, '', { 'content-range': `bytes */${size}` })
    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
    return new Response(body, { status: 206, headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` } })
  }
  const body = Readable.toWeb(createReadStream(path)) as ReadableStream
  return new Response(body, { status: 200, headers: { ...headers, 'content-length': String(info.size) } })
}
