import { vi } from 'vitest'
import type { BookmarkFolder, BookmarkItem, BookmarkNode } from '@shared/types/browserData'
import { installBridge } from './bridge'

export const link = (id: string, title: string, url: string): BookmarkItem => ({ id, title, url, added: 0 })
export const folder = (id: string, title: string, children: BookmarkNode[] = []): BookmarkFolder => ({ id, title, children, added: 0 })
/** The two roots with what is in them. */
export const library = (bar: BookmarkNode[] = [], other: BookmarkNode[] = []): BookmarkFolder[] => [folder('bar', '', bar), folder('other', '', other)]

/** The desktop bridge, answering browser channels and recording every call. */
export function bridge(routes: Record<string, (p: never) => unknown> = {}) {
  const calls: [string, unknown][] = []
  const b = installBridge(routes)
  const invoke = b.invoke.getMockImplementation()!
  b.invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    calls.push([channel, payload])
    return invoke(channel, payload)
  })
  const sent = (channel: string) => calls.filter(([c]) => c === channel).map(([, p]) => p)
  return { b, calls, sent }
}

/** A drag carrying `types` (and `id` for the bookmark type). */
export function dataTransfer(types: string[], id = '') {
  return { types, getData: vi.fn(() => id), setData: vi.fn() }
}
