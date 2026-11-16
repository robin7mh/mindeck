import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Files on the system clipboard, so ⌘C in Mindeck pastes in Finder / Files /
 * Nautilus and the other way round. Each OS has its own raw format, which
 * Electron reaches as `electron application/osclipboard;format="…"`:
 * - macOS: `NSFilenamesPboardType`, a property list of paths;
 * - Linux: `x-special/gnome-copied-files` ("copy" or "cut", then file URIs),
 *   plus `text/uri-list` (KDE, browsers);
 * - Windows: Explorer's `FileNameW` (one path, UTF-16) can be read; writing
 *   puts the paths as text — Explorer only pastes its own CF_HDROP format.
 * The paths always go along as plain text too (a terminal pastes them).
 */

/** What is used of Electron's (async, W3C-style) clipboard — injected, so it is testable. */
export interface ClipboardLike {
  read(): Promise<{ readonly types: readonly string[]; getType(type: string): Promise<unknown> }[]>
  write(items: never[]): Promise<void>
}

/** A raw OS clipboard format, the way Electron names it. */
export const raw = (format: string): string => `electron application/osclipboard;format="${format}"`

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Paths as the property list macOS's pasteboard expects. */
export function pathsToPlist(paths: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<array>',
    ...paths.map((p) => `\t<string>${xml(p)}</string>`),
    '</array>',
    '</plist>'
  ].join('\n')
}

export function plistToPaths(plist: string): string[] {
  return [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]))
}

/** The file:// URIs in a list ("copy"/"cut" and comments skipped). */
export function urisToPaths(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('file://')) continue
    try {
      out.push(fileURLToPath(line.trim()))
    } catch {
      // not a local file (file://host/…)
    }
  }
  return out
}

export function fileClipboard(clipboard: ClipboardLike, makeItem: (data: Record<string, string>) => unknown, platform: NodeJS.Platform) {
  return {
    async write(paths: string[], cut: boolean): Promise<void> {
      const text = paths.join(platform === 'win32' ? '\r\n' : '\n')
      const data: Record<string, string> = { 'text/plain': text }
      if (platform === 'darwin') data[raw('NSFilenamesPboardType')] = pathsToPlist(paths)
      if (platform === 'linux') {
        const uris = paths.map((p) => pathToFileURL(p).href)
        data[raw('x-special/gnome-copied-files')] = [cut ? 'cut' : 'copy', ...uris].join('\n')
        data['text/uri-list'] = uris.join('\r\n')
      }
      try {
        await clipboard.write([makeItem(data) as never])
      } catch {
        // A clipboard that takes no raw formats: the paths as text at least.
        await clipboard.write([makeItem({ 'text/plain': text }) as never])
      }
    },

    async read(): Promise<string[]> {
      const items = await clipboard.read().catch(() => [])
      for (const item of items) {
        const take = async (type: string, encoding: BufferEncoding = 'utf8') =>
          item.types.includes(type) ? Buffer.from(await (await item.getType(type) as Blob).arrayBuffer()).toString(encoding) : ''
        const found =
          platform === 'darwin'
            ? plistToPaths(await take(raw('NSFilenamesPboardType')))
            : platform === 'linux'
              ? urisToPaths(`${await take(raw('x-special/gnome-copied-files'))}\n${await take('text/uri-list')}`)
              : [(await take(raw('FileNameW'), 'utf16le')).replace(/\0.*$/s, '')].filter(Boolean)
        if (found.length) return [...new Set(found)]
      }
      return []
    }
  }
}
