/**
 * Every keyboard shortcut of Mindeck in one list — the source of the
 * shortcut overview (⌘/), of the keys shown in tooltips and the command
 * palette, and of the conflict check (tests/unit/renderer/shortcuts.test.ts).
 * The modules match keys with their own code (workspace/keys.ts,
 * terminal/keys.ts, the browser's shortcuts.ts in main, …); tests hold that
 * code to this list.
 */

/** Where a shortcut works: everywhere, or while that module's pane has the focus. */
export type ShortcutContext = 'global' | 'editor' | 'terminal' | 'browser' | 'files'
export const CONTEXTS: ShortcutContext[] = ['global', 'editor', 'terminal', 'browser', 'files']

/**
 * A key combination, platform-neutral: modifiers and the key, joined by "+".
 * `mod` is ⌘ on macOS and Ctrl elsewhere, `ctrl` the Control key on both,
 * `alt` ⌥ / Alt. The key is a character (`k`, `/`, `\`, `?`), a range of
 * digits (`1-9`), `arrows` (all four) or a name (`enter`, `up`, `f11`,
 * `space`, `backspace`, `tab`, `insert`). Two of them with a space between
 * are a sequence (`mod+k mod+\\`: ⌘K, then ⌘\).
 */
export type Binding = string

/** One binding for both platforms, or each its own (a missing one: none there). */
export type KeySpec = Binding | { mac?: Binding; other?: Binding }

export interface Shortcut {
  /** Also its name: `t.shortcuts.items[id]`. */
  id: ShortcutId
  context: ShortcutContext
  keys: KeySpec[]
  /** Global keys only: modules whose pane keeps this key for itself while it has the focus. */
  yields?: ShortcutContext[]
}

const SHORTCUT_LIST = [
  // Everywhere. The palette's ⌘K is the code editor's inline AI there, and clears the terminal (Ctrl+K is the shell's).
  { id: 'palette', context: 'global', keys: ['mod+k', 'mod+shift+p'], yields: ['editor', 'terminal'] },
  // ⌘/ comments a line in the code editor; "?" only works outside text fields.
  { id: 'shortcuts', context: 'global', keys: ['mod+/', '?'], yields: ['editor'] },
  // The editor splits itself on ⌘\; Ctrl+\ in a terminal is SIGQUIT.
  { id: 'workspace.split', context: 'global', keys: ['mod+\\'], yields: ['editor', 'terminal'] },
  { id: 'workspace.close', context: 'global', keys: ['mod+shift+w'] },
  // ⌘W closes what the module in focus has open (a tab); where it has nothing, the pane (workspace/keys.ts `isCloseKey`).
  { id: 'workspace.closeAny', context: 'global', keys: ['mod+w'], yields: ['editor', 'terminal', 'browser', 'files'] },
  // ⇧⌘↵ in the code editor inserts a line above.
  { id: 'workspace.maximize', context: 'global', keys: ['mod+shift+enter'], yields: ['editor'] },
  { id: 'workspace.focus', context: 'global', keys: ['mod+alt+arrows'] },
  { id: 'workspace.switch', context: 'global', keys: ['mod+alt+1-9'] },
  { id: 'workspace.zen', context: 'global', keys: ['mod+alt+z'] },
  { id: 'workspace.fullscreen', context: 'global', keys: [{ mac: 'ctrl+mod+f', other: 'f11' }] },

  { id: 'editor.quickOpen', context: 'editor', keys: ['mod+p'] },
  { id: 'editor.palette', context: 'editor', keys: ['f1'] },
  { id: 'editor.goToLine', context: 'editor', keys: ['ctrl+g'] },
  { id: 'editor.save', context: 'editor', keys: ['mod+s'] },
  { id: 'editor.saveAll', context: 'editor', keys: ['mod+alt+s'] },
  { id: 'editor.closeTab', context: 'editor', keys: ['mod+w'] },
  { id: 'editor.split', context: 'editor', keys: ['mod+\\'] },
  // Starts with the inline AI's ⌘K: its prompt takes ⌘\ as the first key and splits instead (monaco/inlineAi.ts).
  { id: 'editor.splitDown', context: 'editor', keys: ['mod+k mod+\\'] },
  // The workspace's are ⌘⌥1…9; the browser's ⌘1…9 only work in the browser.
  { id: 'editor.focusGroup', context: 'editor', keys: ['mod+1-9'] },
  { id: 'editor.search', context: 'editor', keys: ['mod+shift+f'] },
  { id: 'editor.replace', context: 'editor', keys: ['mod+shift+h'] },
  { id: 'editor.scm', context: 'editor', keys: ['mod+shift+g'] },
  { id: 'editor.inlineAi', context: 'editor', keys: ['mod+k'] },
  { id: 'editor.comment', context: 'editor', keys: ['mod+/'] },
  { id: 'editor.format', context: 'editor', keys: ['alt+shift+f'] },
  { id: 'editor.find', context: 'editor', keys: ['mod+f'] },
  { id: 'editor.findReplace', context: 'editor', keys: ['mod+alt+f'] },
  { id: 'editor.definition', context: 'editor', keys: ['f12'] },
  { id: 'editor.references', context: 'editor', keys: ['shift+f12'] },
  { id: 'editor.rename', context: 'editor', keys: ['f2'] },
  { id: 'editor.symbol', context: 'editor', keys: ['mod+shift+o'] },
  { id: 'editor.quickFix', context: 'editor', keys: ['mod+.'] },
  { id: 'editor.debugStart', context: 'editor', keys: ['f5'] },
  { id: 'editor.debugStop', context: 'editor', keys: ['shift+f5'] },
  { id: 'editor.debugRestart', context: 'editor', keys: ['mod+shift+f5'] },
  { id: 'editor.breakpoint', context: 'editor', keys: ['f9'] },
  { id: 'editor.stepOver', context: 'editor', keys: ['f10'] },
  // On Windows and Linux F11 is full screen (the main process takes it first).
  { id: 'editor.stepInto', context: 'editor', keys: [{ mac: 'f11' }] },
  { id: 'editor.stepOut', context: 'editor', keys: ['shift+f11'] },

  // Ctrl alone belongs to the shell on Windows and Linux (terminal/keys.ts).
  { id: 'terminal.find', context: 'terminal', keys: [{ mac: 'mod+f', other: 'ctrl+shift+f' }] },
  { id: 'terminal.clear', context: 'terminal', keys: [{ mac: 'mod+k', other: 'ctrl+shift+k' }] },
  { id: 'terminal.prevCommand', context: 'terminal', keys: [{ mac: 'mod+up', other: 'ctrl+shift+up' }] },
  { id: 'terminal.nextCommand', context: 'terminal', keys: [{ mac: 'mod+down', other: 'ctrl+shift+down' }] },
  // On a Mac ⌘C / ⌘V are the Edit menu's; Ctrl+W stays the shell's elsewhere.
  { id: 'terminal.copy', context: 'terminal', keys: [{ other: 'ctrl+shift+c' }, { other: 'ctrl+insert' }] },
  { id: 'terminal.paste', context: 'terminal', keys: [{ other: 'ctrl+shift+v' }, { other: 'shift+insert' }] },
  { id: 'terminal.close', context: 'terminal', keys: [{ mac: 'mod+w' }] },

  // As in Chrome (electron/main/platform/browser/shortcuts.ts).
  { id: 'browser.newTab', context: 'browser', keys: ['mod+t'] },
  { id: 'browser.privateTab', context: 'browser', keys: ['mod+shift+n'] },
  { id: 'browser.closeTab', context: 'browser', keys: ['mod+w'] },
  { id: 'browser.reopenTab', context: 'browser', keys: ['mod+shift+t'] },
  { id: 'browser.address', context: 'browser', keys: ['mod+l'] },
  { id: 'browser.reload', context: 'browser', keys: ['mod+r', 'f5'] },
  { id: 'browser.hardReload', context: 'browser', keys: ['mod+shift+r', 'shift+f5'] },
  { id: 'browser.back', context: 'browser', keys: ['mod+[', { other: 'alt+left' }] },
  { id: 'browser.forward', context: 'browser', keys: ['mod+]', { other: 'alt+right' }] },
  { id: 'browser.find', context: 'browser', keys: ['mod+f'] },
  { id: 'browser.zoomIn', context: 'browser', keys: ['mod+='] },
  { id: 'browser.zoomOut', context: 'browser', keys: ['mod+-'] },
  { id: 'browser.zoomReset', context: 'browser', keys: ['mod+0'] },
  // ⌘⌥←/→ are the workspace's (the focus to the next pane).
  { id: 'browser.nextTab', context: 'browser', keys: ['ctrl+tab', 'mod+shift+]'] },
  { id: 'browser.prevTab', context: 'browser', keys: ['ctrl+shift+tab', 'mod+shift+['] },
  { id: 'browser.tabN', context: 'browser', keys: ['mod+1-8'] },
  { id: 'browser.lastTab', context: 'browser', keys: ['mod+9'] },
  { id: 'browser.bookmark', context: 'browser', keys: ['mod+d'] },
  { id: 'browser.bookmarksBar', context: 'browser', keys: ['mod+shift+b'] },
  { id: 'browser.tabSearch', context: 'browser', keys: ['mod+shift+a'] },
  { id: 'browser.newGroup', context: 'browser', keys: ['mod+shift+g'] },
  { id: 'browser.split', context: 'browser', keys: ['mod+shift+d'] },
  { id: 'browser.verticalTabs', context: 'browser', keys: ['mod+shift+,'] },
  { id: 'browser.history', context: 'browser', keys: [{ mac: 'mod+y', other: 'ctrl+h' }] },
  { id: 'browser.bookmarkManager', context: 'browser', keys: [{ mac: 'mod+alt+b', other: 'ctrl+shift+o' }] },
  { id: 'browser.devtools', context: 'browser', keys: [{ mac: 'mod+alt+i', other: 'ctrl+shift+i' }] },
  { id: 'browser.print', context: 'browser', keys: ['mod+p'] },

  // Finder's keys (files/components/FilesView.tsx).
  { id: 'files.open', context: 'files', keys: ['enter', 'mod+down'] },
  { id: 'files.up', context: 'files', keys: ['mod+up'] },
  { id: 'files.back', context: 'files', keys: ['mod+['] },
  { id: 'files.forward', context: 'files', keys: ['mod+]'] },
  { id: 'files.rename', context: 'files', keys: ['f2'] },
  { id: 'files.preview', context: 'files', keys: ['space'] },
  { id: 'files.trash', context: 'files', keys: ['mod+backspace'] },
  { id: 'files.selectAll', context: 'files', keys: ['mod+a'] },
  { id: 'files.copy', context: 'files', keys: ['mod+c'] },
  { id: 'files.cut', context: 'files', keys: ['mod+x'] },
  { id: 'files.paste', context: 'files', keys: ['mod+v'] },
  { id: 'files.undo', context: 'files', keys: ['mod+z'] },
  { id: 'files.newFolder', context: 'files', keys: ['mod+shift+n'] },
  { id: 'files.goTo', context: 'files', keys: ['mod+shift+g'] },
  { id: 'files.newTab', context: 'files', keys: ['mod+t'] },
  { id: 'files.closeTab', context: 'files', keys: ['mod+w'] }
] as const satisfies readonly { id: string; context: ShortcutContext; keys: readonly KeySpec[]; yields?: readonly ShortcutContext[] }[]

export type ShortcutId = (typeof SHORTCUT_LIST)[number]['id']

export const SHORTCUTS: readonly Shortcut[] = SHORTCUT_LIST as unknown as readonly Shortcut[]

/** The bindings of a key spec on this platform. */
function bindingsOf(keys: KeySpec[], mac: boolean): Binding[] {
  return keys.flatMap((k) => {
    const b = typeof k === 'string' ? k : mac ? k.mac : k.other
    return b ? [b] : []
  })
}

interface Parsed {
  mods: Set<string>
  key: string
}

function parse(binding: Binding): Parsed {
  // "mod++" would be the plus key; a trailing "+" after the modifiers is the key itself.
  const parts = binding.split('+')
  const key = parts.pop() || '+'
  return { mods: new Set(parts.filter(Boolean)), key }
}

const MAC_KEYS: Record<string, string> = { enter: '↵', up: '↑', down: '↓', left: '←', right: '→', arrows: '←→↑↓', backspace: '⌫', space: 'Space', tab: '⇥', insert: 'Insert' }
const OTHER_KEYS: Record<string, string> = { enter: 'Enter', up: '↑', down: '↓', left: '←', right: '→', arrows: '←→↑↓', backspace: 'Backspace', space: 'Space', tab: 'Tab', insert: 'Insert' }

function keyName(key: string, mac: boolean): string {
  const named = (mac ? MAC_KEYS : OTHER_KEYS)[key]
  if (named) return named
  const range = /^(\d)-(\d)$/.exec(key)
  if (range) return `${range[1]}…${range[2]}`
  return key.toUpperCase()
}

/** A binding as this platform writes it: `⇧⌘P` on a Mac, `Ctrl+Shift+P` elsewhere. */
export function formatBinding(binding: Binding, mac: boolean): string {
  if (binding.includes(' ')) return binding.split(' ').map((stroke) => formatBinding(stroke, mac)).join(' ')
  const { mods, key } = parse(binding)
  const name = keyName(key, mac)
  if (mac) {
    // Apple's order: ⌃ ⌥ ⇧ ⌘.
    const marks = [mods.has('ctrl') && '⌃', mods.has('alt') && '⌥', mods.has('shift') && '⇧', mods.has('mod') && '⌘'].filter(Boolean).join('')
    return marks + name
  }
  const words = [(mods.has('ctrl') || mods.has('mod')) && 'Ctrl', mods.has('alt') && 'Alt', mods.has('shift') && 'Shift'].filter(Boolean) as string[]
  return [...words, name].join('+')
}

export function shortcutById(id: ShortcutId): Shortcut {
  return SHORTCUTS.find((s) => s.id === id)!
}

/** A shortcut's bindings on this platform. */
export function shortcutBindings(id: ShortcutId, mac: boolean): Binding[] {
  return bindingsOf(shortcutById(id).keys, mac)
}

/** A shortcut's keys on this platform (`⌘K / ⇧⌘P`); undefined when it has none here. */
export function shortcutLabel(id: ShortcutId, mac: boolean): string | undefined {
  const labels = shortcutBindings(id, mac).map((b) => formatBinding(b, mac))
  return labels.length ? labels.join(' / ') : undefined
}

/** Each key press a binding stands for, as `ctrl+alt+shift+meta+key` (ranges and `arrows` spread out). */
export function chords(binding: Binding, mac: boolean): string[] {
  // A sequence is one entry: it only meets the very same sequence (its first key may be another shortcut's).
  if (binding.includes(' ')) return [binding.split(' ').map((stroke) => chords(stroke, mac)[0]).join(' ')]
  const { mods, key } = parse(binding)
  const ctrl = mods.has('ctrl') || (!mac && mods.has('mod'))
  const meta = mac && mods.has('mod')
  const prefix = [ctrl && 'ctrl', mods.has('alt') && 'alt', mods.has('shift') && 'shift', meta && 'meta'].filter(Boolean).join('+')
  const range = /^(\d)-(\d)$/.exec(key)
  const keys = key === 'arrows' ? ['left', 'right', 'up', 'down'] : range ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => String(Number(range[1]) + i)) : [key]
  return keys.map((k) => (prefix ? `${prefix}+${k}` : k))
}

export interface Conflict {
  chord: string
  /** The shortcuts that share it. */
  ids: ShortcutId[]
}

/**
 * Shortcuts that share a key press where both would be meant: two in the same
 * context, or a global one and a module's — unless the global one yields to
 * that module.
 */
export function findConflicts(list: readonly Shortcut[], mac: boolean): Conflict[] {
  const byContext = new Map<ShortcutContext, Map<string, Shortcut[]>>(CONTEXTS.map((c) => [c, new Map()]))
  for (const s of list) {
    const table = byContext.get(s.context)!
    for (const chord of new Set(bindingsOf(s.keys, mac).flatMap((b) => chords(b, mac)))) table.set(chord, [...(table.get(chord) ?? []), s])
  }
  const conflicts: Conflict[] = []
  for (const table of byContext.values()) {
    for (const [chord, owners] of table) if (owners.length > 1) conflicts.push({ chord, ids: owners.map((s) => s.id) })
  }
  for (const [chord, globals] of byContext.get('global')!) {
    for (const context of CONTEXTS.slice(1)) {
      const local = byContext.get(context)!.get(chord)
      if (!local) continue
      const blocking = globals.filter((g) => !g.yields?.includes(context))
      if (blocking.length) conflicts.push({ chord, ids: [...blocking, ...local].map((s) => s.id) })
    }
  }
  return conflicts
}

/** Characters typed with ⇧ on some keyboard: their bindings don't ask about ⇧ unless they name it. */
const isLetterOrDigit = (key: string) => /^[a-z0-9]$/.test(key)

/** Whether a key press is this binding (letters and digits by their place on a Mac, where ⌥ changes the character). */
export function matchesBinding(binding: Binding, e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, mac: boolean): boolean {
  // A sequence is more than one key press: its module follows it.
  if (binding.includes(' ')) return false
  const { mods, key } = parse(binding)
  const ctrl = mods.has('ctrl') || (!mac && mods.has('mod'))
  const meta = mac && mods.has('mod')
  if (e.ctrlKey !== ctrl || e.metaKey !== meta || e.altKey !== mods.has('alt')) return false
  if (isLetterOrDigit(key)) {
    if (e.shiftKey !== mods.has('shift')) return false
    const place = /^(?:Key|Digit)(.)$/.exec(e.code)?.[1]?.toLowerCase()
    return mac && place ? place === key : e.key.toLowerCase() === key
  }
  if (mods.has('shift') && !e.shiftKey) return false
  return e.key.toLowerCase() === key
}
