import type { BookmarkNode } from '@shared/types/browserData'
import type { BookmarkSet } from '../bookmarks'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** Arc keeps its lists as `[id, object, id, object, …]`. */
function byId(list: unknown[]): Map<string, Obj> {
  const out = new Map<string, Obj>()
  for (const v of list) if (isObj(v) && typeof v.id === 'string') out.set(v.id, v)
  return out
}

/** The profile folder a space belongs to ("Default" unless it has its own). */
function profileOf(space: Obj): string {
  const custom = isObj(space.profile) && isObj(space.profile.custom) ? space.profile.custom._0 : undefined
  return isObj(custom) && typeof custom.directoryBasename === 'string' ? custom.directoryBasename : 'Default'
}

/**
 * Arc's bookmarks are its sidebar (`StorableSidebar.json`): the pinned tabs of
 * each space become a folder named after the space, with Arc's folders inside;
 * the favorites (the icons on top) go to the bar. Only the spaces of
 * `profile` (a profile folder like "Default") are taken.
 */
export function arcBookmarks(sidebar: unknown, profile: string): BookmarkSet {
  const containers = isObj(sidebar) && isObj(sidebar.sidebar) && Array.isArray(sidebar.sidebar.containers) ? sidebar.sidebar.containers : []
  const main = containers.find((c): c is Obj & { items: unknown[]; spaces: unknown[] } => isObj(c) && Array.isArray(c.items) && Array.isArray(c.spaces))
  if (!main) return { bar: [], other: [] }
  const items = byId(main.items)
  const seen = new Set<string>()
  const build = (id: string): BookmarkNode[] => {
    const parent = items.get(id)
    if (!parent || seen.has(id)) return []
    seen.add(id)
    const ids = Array.isArray(parent.childrenIds) ? parent.childrenIds.filter((c): c is string => typeof c === 'string') : []
    return ids.flatMap((cid): BookmarkNode[] => {
      const item = items.get(cid)
      if (!item) return []
      const tab = isObj(item.data) && isObj(item.data.tab) ? item.data.tab : undefined
      const title = typeof item.title === 'string' ? item.title : ''
      if (tab) {
        const url = typeof tab.savedURL === 'string' ? tab.savedURL : ''
        return /^https?:/i.test(url) ? [{ id: '', title: title || (typeof tab.savedTitle === 'string' ? tab.savedTitle : ''), url, added: 0 }] : []
      }
      const children = build(cid)
      return children.length ? [{ id: '', title, children, added: 0 }] : []
    })
  }
  const other: BookmarkNode[] = []
  for (const space of byId(main.spaces).values()) {
    if (profileOf(space) !== profile) continue
    const ids = Array.isArray(space.containerIDs) ? space.containerIDs : []
    const pinned = ids[ids.indexOf('pinned') + 1]
    const children = ids.includes('pinned') && typeof pinned === 'string' ? build(pinned) : []
    if (children.length) other.push({ id: '', title: typeof space.title === 'string' && space.title ? space.title : 'Arc', children, added: 0 })
  }
  // Favorites are the default profile's: `topAppsContainerIDs` is `[{default: true}, id, …]`.
  const favorites = profile === 'Default' && Array.isArray(main.topAppsContainerIDs) ? main.topAppsContainerIDs.filter((v): v is string => typeof v === 'string') : []
  return { bar: favorites.flatMap(build), other }
}
