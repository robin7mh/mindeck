import { isFolder, type BookmarkFolder, type BookmarkNode } from '@shared/types/browserData'
import type { BookmarkSet } from './bookmarks'

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

function encode(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  return m ? decode(m[1] ?? m[2] ?? m[3]) : undefined
}

/** Seconds since 1970 (the format's ADD_DATE) → ms, or `fallback`. */
function date(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return value && Number.isFinite(n) && n > 0 ? n * 1000 : fallback
}

/**
 * Reads the bookmark file every browser exports (Netscape format: nested
 * `<DL>` lists of `<H3>` folders and `<A>` links). The toolbar folder's
 * contents become the bar; the rest goes to Other bookmarks. Only web
 * addresses come along — no bookmarklets, no `place:` queries.
 */
export function parseNetscape(html: string, now = Date.now()): BookmarkSet {
  const top: BookmarkFolder = { id: '', title: '', children: [], added: now }
  const bar: BookmarkNode[] = []
  const stack: BookmarkFolder[] = [top]
  let pending: { folder: BookmarkFolder; toolbar: boolean } | null = null
  let toolbar: BookmarkFolder | null = null
  const token = /<(\/?)(dl|h3|a)\b([^>]*)>/gi
  let m: RegExpExecArray | null
  while ((m = token.exec(html))) {
    const [, close, tag, attrs] = m
    const name = tag.toLowerCase()
    if (name === 'dl') {
      if (close) {
        if (stack.length > 1) stack.pop()
      } else if (pending) {
        stack.push(pending.folder)
        if (pending.toolbar && !toolbar) toolbar = pending.folder
        pending = null
      }
      continue
    }
    if (close) continue
    const closer = name === 'h3' ? /<\/h3>/gi : /<\/a>/gi
    closer.lastIndex = token.lastIndex
    const end = closer.exec(html)?.index ?? -1
    // An unclosed tag's text runs to the next tag.
    const stop = end >= 0 ? end : html.indexOf('<', token.lastIndex)
    const text = decode(html.slice(token.lastIndex, stop < 0 ? undefined : stop).replace(/<[^>]*>/g, '')).trim()
    if (end >= 0) token.lastIndex = end
    const parent = stack[stack.length - 1]
    const added = date(attr(attrs, 'add_date'), now)
    if (name === 'h3') {
      const folder: BookmarkFolder = { id: '', title: text, children: [], added }
      parent.children.push(folder)
      pending = { folder, toolbar: attr(attrs, 'personal_toolbar_folder')?.toLowerCase() === 'true' }
    } else {
      const href = attr(attrs, 'href') ?? ''
      if (/^(https?|file):/i.test(href)) parent.children.push({ id: '', title: text || href, url: href, added })
    }
  }
  if (toolbar) {
    bar.push(...toolbar.children)
    removeFolder(top, toolbar)
  }
  return { bar, other: top.children }
}

function removeFolder(from: BookmarkFolder, target: BookmarkFolder): void {
  const i = from.children.indexOf(target)
  if (i >= 0) from.children.splice(i, 1)
  else for (const c of from.children) if (isFolder(c)) removeFolder(c, target)
}

/** The bookmarks as a Netscape bookmark file, which every browser imports: the bar as the toolbar folder, then the rest. */
export function toNetscape(roots: { bar: BookmarkFolder; other: BookmarkFolder }, barTitle: string): string {
  const secs = (ms: number) => Math.floor(ms / 1000)
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ]
  const list = (nodes: BookmarkNode[], depth: number) => {
    const pad = '    '.repeat(depth)
    for (const n of nodes) {
      if (isFolder(n)) {
        lines.push(`${pad}<DT><H3 ADD_DATE="${secs(n.added)}">${encode(n.title)}</H3>`, `${pad}<DL><p>`)
        list(n.children, depth + 1)
        lines.push(`${pad}</DL><p>`)
      } else {
        lines.push(`${pad}<DT><A HREF="${encode(n.url)}" ADD_DATE="${secs(n.added)}">${encode(n.title)}</A>`)
      }
    }
  }
  lines.push(`    <DT><H3 ADD_DATE="${secs(roots.bar.added)}" PERSONAL_TOOLBAR_FOLDER="true">${encode(barTitle)}</H3>`, '    <DL><p>')
  list(roots.bar.children, 2)
  lines.push('    </DL><p>')
  list(roots.other.children, 1)
  lines.push('</DL><p>', '')
  return lines.join('\n')
}
