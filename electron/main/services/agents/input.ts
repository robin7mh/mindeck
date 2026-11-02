import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { ContentBlock, PromptCapabilities } from '@agentclientprotocol/sdk'
import type { MessageAttachment } from '@shared/types/ai'
import { base64Bytes, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_IMAGES_BYTES, MAX_REFS, type ComposerImage, type ComposerRef } from '@shared/types/composer'
import { confine } from '../../lib/confine'

// A message from the composer → what each agent understands: Claude Code gets
// `@path` mentions in its prompt (images saved as files first), ACP agents get
// content blocks (resource links, embedded notes, images).

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** A reference checked and resolved: files and notes inside their roots, tabs only on the web. */
export interface ResolvedRef {
  kind: ComposerRef['kind']
  /** file / folder: relative to the session's folder (posix) · note: absolute · tab: the URL. */
  path: string
  /** Absolute path (files, folders, notes). */
  abs?: string
  label: string
}

/** Embedded vault notes are capped: a link would do for anything larger. */
const NOTE_LIMIT = 100_000
const EXT: Record<ComposerImage['mimeType'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** Refuses what no agent should get: too many references, foreign image types, too large images. */
export function checkInput(refs: ComposerRef[], images: ComposerImage[]): void {
  if (refs.length > MAX_REFS) throw coded('bad-input', `At most ${MAX_REFS} references per message`)
  if (images.length > MAX_IMAGES) throw coded('bad-input', `At most ${MAX_IMAGES} images per message`)
  let total = 0
  for (const image of images) {
    if (!IMAGE_TYPES.includes(image.mimeType)) throw coded('bad-input', `${image.name}: not a PNG, JPEG, GIF or WebP image`)
    const bytes = base64Bytes(image.data)
    if (bytes > MAX_IMAGE_BYTES) throw coded('too-large', `${image.name} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`)
    total += bytes
  }
  if (total > MAX_IMAGES_BYTES) throw coded('too-large', `The images are larger than ${MAX_IMAGES_BYTES / 1024 / 1024} MB together`)
}

/** Each reference inside its root (the session's folder, the vault); a tab only with an http(s) URL. */
export async function resolveRefs(refs: ComposerRef[], cwd: string, vaultRoot: () => Promise<string | undefined>): Promise<ResolvedRef[]> {
  const out: ResolvedRef[] = []
  for (const ref of refs) {
    if (ref.kind === 'tab') {
      let url: URL
      try {
        url = new URL(ref.path)
      } catch {
        throw coded('bad-input', `Not a web address: ${ref.path}`)
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw coded('bad-input', `Not a web address: ${ref.path}`)
      out.push({ kind: 'tab', path: url.href, label: ref.label?.trim() || url.href })
      continue
    }
    if (ref.kind === 'note') {
      const root = await vaultRoot()
      if (!root) throw coded('no-vault', 'There is no memory vault')
      const abs = await confine(root, ref.path)
      out.push({ kind: 'note', path: abs, abs, label: ref.label?.trim() || basename(ref.path, '.md') })
      continue
    }
    const abs = await confine(cwd, ref.path)
    const rel = relative(await confine(cwd, '.'), abs).split(sep).join('/')
    if (!rel) throw coded('bad-input', 'Reference a file or folder inside the session')
    out.push({ kind: ref.kind, path: rel, abs, label: ref.label?.trim() || basename(rel) })
  }
  return out
}

/** `@path`, quoted when the path has spaces. */
const mention = (path: string) => (/\s/.test(path) ? `@"${path}"` : `@${path}`)

/**
 * Claude Code's prompt: the text, then a line with `@` mentions — the CLI
 * reads the files (and image files) itself; tabs become a line with the URL.
 */
export function claudePrompt(text: string, refs: ResolvedRef[], imagePaths: string[]): string {
  const mentions = [
    ...refs.filter((r) => r.kind !== 'tab').map((r) => mention(r.kind === 'folder' ? `${r.path}/` : r.path)),
    ...imagePaths.map(mention)
  ]
  const tabs = refs.filter((r) => r.kind === 'tab').map((r) => `Browser tab: ${r.label} <${r.path}>`)
  const extra = [...(mentions.length ? [mentions.join(' ')] : []), ...tabs]
  return extra.length ? [text.trimEnd(), ...extra].filter(Boolean).join('\n\n') : text
}

/** Claude Code reads images from files: each one in the session's own temp folder. */
export async function saveImages(dir: string, images: ComposerImage[]): Promise<string[]> {
  if (!images.length) return []
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return Promise.all(
    images.map(async (image) => {
      const file = join(dir, `${randomUUID()}.${EXT[image.mimeType]}`)
      await writeFile(file, Buffer.from(image.data, 'base64'), { mode: 0o600 })
      return file
    })
  )
}

/**
 * An ACP prompt: text, a resource link per file, folder and tab, vault notes
 * embedded when the agent takes embedded context (else linked), images when
 * it takes images.
 */
export async function acpPrompt(text: string, refs: ResolvedRef[], images: ComposerImage[], caps: PromptCapabilities): Promise<ContentBlock[]> {
  if (images.length && !caps.image) throw coded('images-unsupported', 'This agent does not take images')
  const blocks: ContentBlock[] = text.trim() ? [{ type: 'text', text }] : []
  for (const ref of refs) {
    if (ref.kind === 'tab') {
      blocks.push({ type: 'resource_link', uri: ref.path, name: ref.label, title: ref.label })
      continue
    }
    const uri = pathToFileURL(ref.abs!).href
    if (ref.kind === 'note' && caps.embeddedContext) {
      const note = await readFile(ref.abs!, 'utf8').catch(() => null)
      if (note !== null && note.length <= NOTE_LIMIT) {
        blocks.push({ type: 'resource', resource: { uri, mimeType: 'text/markdown', text: note } })
        continue
      }
    }
    blocks.push({ type: 'resource_link', uri, name: ref.kind === 'folder' ? `${ref.path}/` : ref.kind === 'note' ? ref.label : ref.path })
  }
  for (const image of images) blocks.push({ type: 'image', mimeType: image.mimeType, data: image.data })
  return blocks
}

/** The chips under the user's message in the chat. */
export function attachments(refs: ResolvedRef[], images: ComposerImage[]): MessageAttachment[] | undefined {
  const list: MessageAttachment[] = [
    ...refs.map((r) => ({ kind: r.kind, label: r.kind === 'file' || r.kind === 'folder' ? r.path : r.label })),
    ...images.map((i) => ({ kind: 'image' as const, label: i.name }))
  ]
  return list.length ? list : undefined
}
