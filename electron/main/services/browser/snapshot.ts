/** A node of Chromium's accessibility tree (CDP `Accessibility.getFullAXTree`). */
export interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  properties?: { name: string; value?: { value?: unknown } }[]
  childIds?: string[]
  backendDOMNodeId?: number
}

/** Roles an agent can act on — each gets a ref (`e12`) to click or type into. */
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
  'listbox'
])

/** Structure worth a line even without a name. */
const STRUCTURE = new Set([
  'banner',
  'navigation',
  'main',
  'contentinfo',
  'complementary',
  'region',
  'form',
  'search',
  'dialog',
  'alertdialog',
  'alert',
  'list',
  'table',
  'row',
  'tablist',
  'menu',
  'menubar',
  'toolbar',
  'tree',
  'grid'
])

/** Content worth a line when it has a name. */
const NAMED = new Set(['heading', 'img', 'image', 'listitem', 'cell', 'columnheader', 'rowheader', 'paragraph', 'figure', 'group', 'status', 'progressbar', 'meter', 'tabpanel', 'article', 'blockquote', 'code'])

const STATES = ['checked', 'pressed', 'selected', 'expanded', 'disabled', 'required', 'invalid', 'focused']
const MAX_TEXT = 160

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT)}…` : one
}

/** What a ref stands for: the DOM node (CDP backendNodeId) and how the snapshot named it. */
export interface SnapshotRef {
  node: number
  label: string
}

export interface Snapshot {
  text: string
  refs: Map<string, SnapshotRef>
  truncated: boolean
}

/**
 * The page as an agent reads it: one line per meaningful node, indented by
 * nesting — roles, names, values, states — and a ref for everything it can
 * act on. Text the user cannot see is not in the tree (Chromium leaves hidden
 * content out), and values of `secret` fields (password inputs) never appear.
 */
export function renderSnapshot(nodes: AxNode[], opts: { secret?: Set<number>; maxChars?: number } = {}): Snapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const refs = new Map<string, SnapshotRef>()
  const lines: string[] = []
  const max = opts.maxChars ?? 24_000
  let size = 0
  let truncated = false
  let lastText = ''

  const add = (depth: number, line: string): boolean => {
    if (size + line.length > max) {
      truncated = true
      return false
    }
    lines.push(`${'  '.repeat(depth)}- ${line}`)
    size += line.length + depth * 2 + 3
    return true
  }

  const visit = (node: AxNode | undefined, depth: number, parentName: string): void => {
    if (!node || truncated) return
    const role = str(node.role?.value)
    const name = clip(str(node.name?.value))
    let printed = false
    if (!node.ignored) {
      if (role === 'StaticText' || role === 'text') {
        if (name && name !== parentName && name !== lastText) {
          printed = add(depth, `text "${name}"`)
          lastText = name
        }
      } else if (INTERACTIVE.has(role) || STRUCTURE.has(role) || (NAMED.has(role) && name)) {
        let line = name ? `${role} "${name}"` : role
        if (INTERACTIVE.has(role) && node.backendDOMNodeId !== undefined) {
          const ref = `e${refs.size + 1}`
          refs.set(ref, { node: node.backendDOMNodeId, label: line })
          line += ` [${ref}]`
        }
        const level = node.properties?.find((p) => p.name === 'level')?.value?.value
        if (role === 'heading' && level !== undefined) line += ` (h${str(level)})`
        const states = (node.properties ?? [])
          .filter((p) => STATES.includes(p.name) && p.value?.value !== undefined && p.value.value !== false && p.value.value !== 'false')
          .map((p) => (p.value!.value === true || p.value!.value === 'true' ? p.name : `${p.name}=${str(p.value!.value)}`))
        if (states.length) line += ` (${states.join(', ')})`
        const value = str(node.value?.value)
        if (value && value !== name) {
          line += node.backendDOMNodeId !== undefined && opts.secret?.has(node.backendDOMNodeId) ? ' = [protected]' : ` = "${clip(value)}"`
        }
        printed = add(depth, line)
        lastText = ''
      }
    }
    for (const child of node.childIds ?? []) visit(byId.get(child), printed ? depth + 1 : depth, printed ? name : parentName)
  }

  visit(nodes[0], 0, '')
  if (truncated) lines.push('… (the page goes on — act on what is above, or scroll and take a new snapshot)')
  return { text: lines.join('\n'), refs, truncated }
}

/** The middle of a CDP box-model quad (x1,y1, …, x4,y4). */
export function quadCenter(quad: number[]): { x: number; y: number } {
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

/** CDP key events for the keys agents press. */
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' }
}

export const KEY_NAMES = Object.keys(KEYS)

/** The keyDown/keyUp pair CDP's `Input.dispatchKeyEvent` takes for `key`. */
export function keyEvents(key: string): Record<string, unknown>[] {
  const k = KEYS[key]
  if (!k) throw Object.assign(new Error(`Unknown key: ${key} (known: ${KEY_NAMES.join(', ')})`), { code: 'bad-key' })
  const base = { key: key === 'Space' ? ' ' : key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode }
  return [{ type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) }, { type: 'keyUp', ...base }]
}
