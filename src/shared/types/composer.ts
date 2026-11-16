// What a message to a coding agent carries besides its text: references the
// user picked with `@` and images they pasted or dropped. Limits live here so
// the composer, the IPC schema and the core agree on them.

/** Something the user points the agent at (`@` in the composer). */
export interface ComposerRef {
  kind: 'file' | 'folder' | 'note' | 'tab'
  /** file / folder: relative to the session's folder · note: path in the vault · tab: the page's URL. */
  path: string
  /** What the chip shows (a tab's title); the path's last segment otherwise. */
  label?: string
}

/** An image for the agent, base64-encoded (no `data:` prefix). */
export interface ComposerImage {
  name: string
  mimeType: ImageType
  data: string
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]

/** One image, and all of a message's images together (a remote client's request body stays below 8 MB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES = 6
export const MAX_REFS = 40

/** Bytes behind a base64 string. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}
