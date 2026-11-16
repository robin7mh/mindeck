import { randomUUID } from 'node:crypto'
import { stringify as toYaml } from 'yaml'
import { splitFrontmatter } from './parse'

/**
 * Note templates the Obsidian way (core "Templates" plugin): `{{title}}`,
 * `{{date}}`, `{{time}}` and custom formats like `{{date:DD.MM.YYYY}}` or
 * `{{time:HH:mm}}`. Pure text in, text out.
 */

/**
 * The UI's wall-clock time ("2026-10-15T09:30:00", no zone) — the date the
 * user sees, even when the core runs on a server in another time zone.
 */
export function localTime(now?: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(now ?? '')
  if (!m) return new Date()
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
}

const pad = (n: number) => String(n).padStart(2, '0')

/** moment.js-style tokens: YYYY YY MM M DD D HH H mm ss; `[text]` is literal. */
export function formatDate(d: Date, format: string): string {
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MM|M|DD|D|HH|H|mm|ss/g, (token, literal?: string) => {
    if (literal !== undefined) return literal
    switch (token) {
      case 'YYYY':
        return String(d.getFullYear())
      case 'YY':
        return String(d.getFullYear()).slice(-2)
      case 'MM':
        return pad(d.getMonth() + 1)
      case 'M':
        return String(d.getMonth() + 1)
      case 'DD':
        return pad(d.getDate())
      case 'D':
        return String(d.getDate())
      case 'HH':
        return pad(d.getHours())
      case 'H':
        return String(d.getHours())
      case 'mm':
        return pad(d.getMinutes())
      default:
        return pad(d.getSeconds())
    }
  })
}

/** The template's text with its variables filled in. */
export function fillTemplate(text: string, vars: { title: string; now: Date }): string {
  return text.replace(/\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/gi, (_m, name: string, format?: string) => {
    const key = name.toLowerCase()
    if (key === 'title') return vars.title
    return formatDate(vars.now, format?.trim() || (key === 'date' ? 'YYYY-MM-DD' : 'HH:mm'))
  })
}

/**
 * A new note's file from a template: the template's frontmatter (if any)
 * merged under Mindeck's own fields — a fresh `id` and `created` always win,
 * a `type` the template sets wins over the folder's.
 */
export function noteFromTemplate(template: string, vars: { title: string; now: Date; type?: string }): string {
  const filled = fillTemplate(template, vars)
  const { frontmatter, body } = splitFrontmatter(filled)
  const { id: _id, created: _created, ...own } = frontmatter
  const fields: Record<string, unknown> = {
    id: randomUUID(),
    ...(vars.type ? { type: vars.type } : {}),
    created: vars.now.toISOString(),
    tags: [],
    ...own
  }
  return `---\n${toYaml(fields)}---\n${body}`
}

/** What "Insert template" puts at the cursor: the filled body, without frontmatter. */
export function templateBody(template: string, vars: { title: string; now: Date }): string {
  return splitFrontmatter(fillTemplate(template, vars)).body
}
