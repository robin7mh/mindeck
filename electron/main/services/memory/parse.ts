import { parse as parseYaml } from 'yaml'
import { isAttachmentTarget } from '@shared/types/memory'

/** Pure markdown parsing with Obsidian semantics — no fs, fully testable. */

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)(?:\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

export interface ParsedNote {
  frontmatter: Record<string, unknown>
  body: string
  tags: string[]
  /** Raw link targets as written (`[[Target#Heading|alias]]` → `Target`); attachments (`![[bild.png]]`) are not links. */
  links: string[]
}

/** The raw frontmatter block (delimiters included), or '' — kept byte-for-byte on body edits. */
export function frontmatterBlock(raw: string): string {
  return FRONTMATTER.exec(raw)?.[0] ?? ''
}

export function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = FRONTMATTER.exec(raw)
  if (!m) return { frontmatter: {}, body: raw }
  let frontmatter: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(m[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>
    }
  } catch {
    /* invalid YAML — Obsidian still shows the note; so do we */
  }
  return { frontmatter, body: raw.slice(m[0].length) }
}

/** Code never contributes links or tags (same as Obsidian). */
function stripCode(text: string): string {
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '')
    .replace(/`[^`\n]*`/g, '')
}

const WIKILINK = /!?\[\[([^\]\n|#^]+)(?:[#^][^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g
const MD_LINK = /\[[^\]\n]*\]\(<?([^)\s>]+\.md)>?(?:#[^)]*)?\)/gi
const INLINE_TAG = /(?:^|[\s(,])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string | number => ['string', 'number'].includes(typeof x)).map(String)
  if (typeof v === 'string') return v.split(/[,\s]+/)
  return []
}

export function parseNote(raw: string): ParsedNote {
  const { frontmatter, body } = splitFrontmatter(raw)
  const text = stripCode(body)

  const links: string[] = []
  for (const m of text.matchAll(WIKILINK)) if (!isAttachmentTarget(m[1])) links.push(m[1].trim())
  for (const m of text.matchAll(MD_LINK)) {
    if (/^[a-z]+:/i.test(m[1])) continue // external URL
    try {
      links.push(decodeURI(m[1]).trim())
    } catch {
      links.push(m[1].trim())
    }
  }

  const tags = new Set<string>()
  for (const t of [...toList(frontmatter.tags), ...toList(frontmatter.tag)]) {
    const clean = t.replace(/^#/, '').trim()
    if (clean) tags.add(clean.toLowerCase())
  }
  for (const m of text.matchAll(INLINE_TAG)) tags.add(m[1].toLowerCase())

  return { frontmatter, body, tags: [...tags].sort(), links: links.filter(Boolean) }
}

/** Link target → lookup key: no `.md`, POSIX separators, case-insensitive. */
export function linkKey(target: string): string {
  return target
    .trim() // first — otherwise surrounding spaces block the ./ and .md strips
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\.md$/i, '')
    .toLowerCase()
}

/** Filename-safe note title (Obsidian forbids these in names). */
export function sanitizeTitle(title: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return clean || 'Untitled'
}
