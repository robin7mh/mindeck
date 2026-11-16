// Project-wide search & replace (VS Code's ⇧⌘F / ⇧⌘H): the query, the
// streamed results, and the pure text helpers both sides share — the core's
// built-in engine and the renderer (open buffers, replacing) match the same way.
// Pure module (no DOM/Node/Electron) so it compiles under every tsconfig.

export interface TextSearchQuery {
  pattern: string
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  /** Globs (gitignore syntax: `*.ts`, `src`, `src/**`); none = every file. */
  include?: string[]
  exclude?: string[]
  /** Posix paths the client searches itself (open files with unsaved edits). */
  skip?: string[]
}

export interface TextMatch {
  /** 1-based. */
  line: number
  /** 0-based offset in the line (UTF-16 code units, like JavaScript strings and Monaco). */
  column: number
  length: number
  /** The line around the match, trimmed for the result list. */
  before: string
  text: string
  after: string
}

export interface FileMatches {
  /** Posix path relative to the project root. */
  path: string
  matches: TextMatch[]
}

/** A batch of results of one search (`search:progress`); the last one has `done`. */
export interface SearchProgress {
  id: string
  files: FileMatches[]
  done: boolean
  /** Stopped at the match limit — there is more. */
  truncated?: boolean
  error?: string
  /** The paired device that searched: only it hears the results (none: the desktop's search, for no device). */
  device?: string
}

export type SearchEngine = 'ripgrep' | 'builtin'

/** Characters of context kept before a match in the result list, and of the whole preview line. */
const CONTEXT = 40
const PREVIEW = 250

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The query as a JavaScript RegExp (global): literal text is escaped, a whole
 * word is bounded by `\b`. Throws a SyntaxError for an invalid pattern.
 */
export function searchRegExp(q: Pick<TextSearchQuery, 'pattern' | 'regex' | 'caseSensitive' | 'wholeWord'>, flags = 'g'): RegExp {
  const source = q.regex ? q.pattern : escapeRegExp(q.pattern)
  return new RegExp(q.wholeWord ? `\\b(?:${source})\\b` : source, `${flags}${q.caseSensitive ? '' : 'i'}`)
}

/**
 * A user's glob list (comma separated in the UI) in gitignore syntax, the way
 * VS Code reads it: `src` means that folder (anywhere) and everything in it,
 * `src/app` the folder at the root. Ripgrep and `ignore` agree on these.
 */
export function expandGlobs(globs: string[] = []): string[] {
  const out: string[] = []
  for (const raw of globs) {
    const glob = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '')
    if (!glob) continue
    out.push(glob)
    if (glob.endsWith('/**')) continue
    out.push(glob.includes('/') ? `${glob}/**` : `**/${glob}/**`)
  }
  return out
}

/** "a, b ,c" → ['a', 'b', 'c'] (braces keep their commas: `*.{ts,tsx}`). */
export function splitGlobs(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let part = ''
  for (const ch of text) {
    if (ch === ',' && depth === 0) {
      out.push(part)
      part = ''
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') depth = Math.max(0, depth - 1)
    part += ch
  }
  out.push(part)
  return out.map((p) => p.trim()).filter(Boolean)
}

/** One result row: a bit of context before the match, the match, and the rest of the line — capped. */
export function previewOf(line: string, column: number, length: number): Pick<TextMatch, 'before' | 'text' | 'after'> {
  const start = Math.max(0, column - CONTEXT)
  const before = `${start > 0 ? '…' : ''}${line.slice(start, column).trimStart()}`
  const text = line.slice(column, column + Math.min(length, PREVIEW))
  const rest = Math.max(0, PREVIEW - before.length - text.length)
  const tail = line.slice(column + length)
  const after = tail.length > rest ? `${tail.slice(0, rest)}…` : tail
  return { before, text, after: after.trimEnd() }
}

/** A text's lines without their line breaks (`\n` or `\r\n`) and without a byte order mark — ripgrep's and Monaco's view. */
export function textLines(text: string): string[] {
  const body = text.startsWith('﻿') ? text.slice(1) : text
  return body.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
}

/** Every match of `re` (global) in one line; an empty match moves on by one, like ripgrep. */
export function matchLine(re: RegExp, line: string, lineNumber: number, max = Infinity): TextMatch[] {
  const out: TextMatch[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while (out.length < max && (m = re.exec(line))) {
    out.push({ line: lineNumber, column: m.index, length: m[0].length, ...previewOf(line, m.index, m[0].length) })
    if (!m[0].length) re.lastIndex += 1
  }
  return out
}

/** Every match in a text, at most `max`. */
export function matchText(re: RegExp, text: string, max = Infinity): TextMatch[] {
  const out: TextMatch[] = []
  const lines = textLines(text)
  for (let i = 0; i < lines.length && out.length < max; i += 1) out.push(...matchLine(re, lines[i], i + 1, max - out.length))
  return out
}

/**
 * The replacement for one regex match, as VS Code expands it: `$&`, `$1`…`$99`,
 * `$<name>`, `$$`, and `\n` `\t` `\\` escapes. Literal searches replace literally.
 */
export function expandReplacement(m: RegExpExecArray, replacement: string, regex: boolean): string {
  if (!regex) return replacement
  let out = ''
  for (let i = 0; i < replacement.length; i += 1) {
    const ch = replacement[i]
    const next = replacement[i + 1]
    if (ch === '\\' && next !== undefined && 'nt\\'.includes(next)) {
      out += next === 'n' ? '\n' : next === 't' ? '\t' : '\\'
      i += 1
    } else if (ch === '$' && next === '$') {
      out += '$'
      i += 1
    } else if (ch === '$' && next === '&') {
      out += m[0]
      i += 1
    } else if (ch === '$' && next === '<' && replacement.indexOf('>', i) > i) {
      const end = replacement.indexOf('>', i)
      const name = replacement.slice(i + 2, end)
      if (m.groups && name in m.groups) {
        out += m.groups[name] ?? ''
        i = end
      } else out += ch
    } else if (ch === '$' && next !== undefined && /\d/.test(next)) {
      const two = replacement.slice(i + 1, i + 3)
      const n = /^\d\d$/.test(two) && Number(two) < m.length ? two : next
      if (Number(n) > 0 && Number(n) < m.length) {
        out += m[Number(n)] ?? ''
        i += n.length
      } else out += ch
    } else out += ch
  }
  return out
}

/** Where a match is, and what replaces it. */
export interface Replacement {
  line: number
  column: number
  length: number
  text: string
}

/**
 * The replacements for matches of a text — each checked against the text as
 * it is now: a match that isn't there any more (the file changed) is left out.
 */
export function replacementsFor(text: string, matches: Pick<TextMatch, 'line' | 'column' | 'length'>[], re: RegExp, replacement: string, regex: boolean): Replacement[] {
  const lines = textLines(text)
  const sticky = new RegExp(re.source, re.flags.replace('g', '').replace('y', '') + 'y')
  const out: Replacement[] = []
  for (const match of matches) {
    const line = lines[match.line - 1]
    if (line === undefined) continue
    sticky.lastIndex = match.column
    const m = sticky.exec(line)
    if (!m || m[0].length !== match.length) continue
    out.push({ line: match.line, column: match.column, length: match.length, text: expandReplacement(m, replacement, regex) })
  }
  return out
}

/** The text with the replacements applied (line breaks and a byte order mark kept). Overlapping ones are skipped. */
export function applyReplacements(text: string, replacements: Replacement[]): string {
  const bom = text.startsWith('﻿') ? '﻿' : ''
  const rows = (bom ? text.slice(1) : text).split('\n')
  const byLine = new Map<number, Replacement[]>()
  for (const r of replacements) byLine.set(r.line, [...(byLine.get(r.line) ?? []), r])
  for (const [line, list] of byLine) {
    const raw = rows[line - 1]
    if (raw === undefined) continue
    const cr = raw.endsWith('\r')
    let content = cr ? raw.slice(0, -1) : raw
    let limit = Infinity
    for (const r of [...list].sort((a, b) => b.column - a.column)) {
      if (r.column + r.length > limit || r.column + r.length > content.length) continue
      content = content.slice(0, r.column) + r.text + content.slice(r.column + r.length)
      limit = r.column
    }
    rows[line - 1] = cr ? `${content}\r` : content
  }
  return bom + rows.join('\n')
}
