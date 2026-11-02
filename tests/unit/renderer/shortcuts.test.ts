import { describe, expect, it } from 'vitest'
import { chords, findConflicts, formatBinding, matchesBinding, shortcutBindings, shortcutLabel, SHORTCUTS, type Shortcut, type ShortcutId } from '@/lib/shortcuts'
import { isCloseKey, matchWorkspaceKey, type KeyLike, type WorkspaceAction } from '@/features/workspace/keys'
import { shortcutLabel as terminalLabel, terminalAction, type TerminalAction } from '@/features/terminal/keys'
import { matchPaletteKey } from '@/features/palette/keys'
import { de } from '@/lib/i18n/de'
import { en } from '@/lib/i18n/en'

const NAMED: Record<string, string> = { enter: 'Enter', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', space: ' ', backspace: 'Backspace', tab: 'Tab', insert: 'Insert' }

/** The key presses a binding stands for, as keyboard events (US layout). */
function presses(binding: string, mac: boolean): KeyLike[] {
  return chords(binding, mac).map((chord) => {
    const parts = chord.split('+')
    const key = parts.pop()!
    const has = (m: string) => parts.includes(m)
    const letter = /^[a-z]$/.test(key)
    return {
      key: NAMED[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : letter && has('shift') ? key.toUpperCase() : key),
      code: letter ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key === '\\' ? 'Backslash' : '',
      metaKey: has('meta'),
      ctrlKey: has('ctrl'),
      altKey: has('alt'),
      shiftKey: has('shift')
    }
  })
}

describe('the shortcut list', () => {
  it('writes keys as each platform does', () => {
    expect(formatBinding('mod+shift+p', true)).toBe('⇧⌘P')
    expect(formatBinding('mod+shift+p', false)).toBe('Ctrl+Shift+P')
    expect(formatBinding('ctrl+mod+f', true)).toBe('⌃⌘F')
    expect(formatBinding('ctrl+mod+f', false)).toBe('Ctrl+F')
    expect(formatBinding('mod+alt+arrows', true)).toBe('⌥⌘←→↑↓')
    expect(formatBinding('mod+alt+1-9', false)).toBe('Ctrl+Alt+1…9')
    expect(formatBinding('mod+shift+enter', true)).toBe('⇧⌘↵')
    expect(formatBinding('mod+shift+enter', false)).toBe('Ctrl+Shift+Enter')
    expect(formatBinding('mod+backspace', true)).toBe('⌘⌫')
    expect(formatBinding('mod+backspace', false)).toBe('Ctrl+Backspace')
    expect(formatBinding('ctrl+shift+tab', true)).toBe('⌃⇧⇥')
    expect(formatBinding('ctrl+tab', false)).toBe('Ctrl+Tab')
    expect(formatBinding('space', true)).toBe('Space')
    expect(formatBinding('mod++', true)).toBe('⌘+')
    expect(formatBinding('f11', false)).toBe('F11')
    expect(formatBinding('?', false)).toBe('?')
    expect(formatBinding('mod+k mod+\\', true)).toBe('⌘K ⌘\\')
    expect(formatBinding('mod+k mod+\\', false)).toBe('Ctrl+K Ctrl+\\')
  })

  it('labels a shortcut by all of its keys on this platform — none where it has none', () => {
    expect(shortcutLabel('palette', true)).toBe('⌘K / ⇧⌘P')
    expect(shortcutLabel('palette', false)).toBe('Ctrl+K / Ctrl+Shift+P')
    expect(shortcutLabel('workspace.fullscreen', false)).toBe('F11')
    expect(shortcutLabel('browser.back', true)).toBe('⌘[')
    expect(shortcutLabel('browser.back', false)).toBe('Ctrl+[ / Alt+←')
    expect(shortcutLabel('editor.stepInto', true)).toBe('F11')
    expect(shortcutLabel('editor.stepInto', false)).toBeUndefined()
    expect(shortcutBindings('shortcuts', true)).toEqual(['mod+/', '?'])
  })

  it('spreads ranges and arrows into single key presses, ⌘ only on a Mac', () => {
    expect(chords('mod+alt+arrows', true)).toEqual(['alt+meta+left', 'alt+meta+right', 'alt+meta+up', 'alt+meta+down'])
    expect(chords('mod+1-3', false)).toEqual(['ctrl+1', 'ctrl+2', 'ctrl+3'])
    expect(chords('ctrl+mod+shift+f', true)).toEqual(['ctrl+shift+meta+f'])
    expect(chords('f5', true)).toEqual(['f5'])
    // A sequence is one entry: ⌘K ⌘\\ doesn't take ⌘K from the inline AI.
    expect(chords('mod+k mod+\\', true)).toEqual(['meta+k meta+\\'])
    expect(chords('mod+k mod+\\', false)).toEqual(['ctrl+k ctrl+\\'])
  })

  it('has no two shortcuts on the same key where both would be meant — on a Mac or elsewhere', () => {
    expect(findConflicts(SHORTCUTS, true)).toEqual([])
    expect(findConflicts(SHORTCUTS, false)).toEqual([])
  })

  it('finds doubled keys: in one context, and a global key over a module’s it doesn’t yield to', () => {
    const list = [
      { id: 'editor.save', context: 'editor', keys: ['mod+s'] },
      { id: 'editor.saveAll', context: 'editor', keys: [{ mac: 'mod+s' }] },
      { id: 'palette', context: 'global', keys: ['mod+k', 'mod+t'], yields: ['terminal'] },
      { id: 'terminal.clear', context: 'terminal', keys: ['mod+k'] },
      { id: 'browser.newTab', context: 'browser', keys: ['mod+t'] },
      { id: 'files.newTab', context: 'files', keys: ['mod+1-9'] },
      { id: 'workspace.switch', context: 'global', keys: ['mod+5'] }
    ] as unknown as Shortcut[]
    expect(findConflicts(list, true)).toEqual([
      { chord: 'meta+s', ids: ['editor.save', 'editor.saveAll'] },
      { chord: 'meta+t', ids: ['palette', 'browser.newTab'] },
      { chord: 'meta+5', ids: ['workspace.switch', 'files.newTab'] }
    ])
    // Elsewhere ⌘ is Ctrl, and the second save has no key.
    expect(findConflicts(list, false).map((c) => c.chord)).toEqual(['ctrl+t', 'ctrl+5'])
  })

  it('names every shortcut in both languages', () => {
    for (const s of SHORTCUTS) {
      expect(en.shortcuts.items[s.id], s.id).toBeTruthy()
      expect(de.shortcuts.items[s.id], s.id).toBeTruthy()
    }
  })

  it('matches key presses: letters by their place on a Mac, ⇧ only where it is named or a letter', () => {
    const e = (k: Partial<KeyLike>) => ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k })
    expect(matchesBinding('mod+k', e({ key: 'k', code: 'KeyK', metaKey: true }), true)).toBe(true)
    expect(matchesBinding('mod+alt+k', e({ key: '˚', code: 'KeyK', metaKey: true, altKey: true }), true)).toBe(true)
    expect(matchesBinding('mod+k', e({ key: 'k', ctrlKey: true }), true)).toBe(false)
    expect(matchesBinding('mod+k', e({ key: 'k', ctrlKey: true }), false)).toBe(true)
    expect(matchesBinding('mod+k', e({ key: 'K', ctrlKey: true, shiftKey: true }), false)).toBe(false)
    expect(matchesBinding('mod+shift+p', e({ key: 'P', ctrlKey: true, shiftKey: true }), false)).toBe(true)
    expect(matchesBinding('mod+k', e({ key: 'k', metaKey: true }), true)).toBe(true) // no code: by the character
    // "/" is ⇧7 on a German keyboard, "?" ⇧ß.
    expect(matchesBinding('mod+/', e({ key: '/', code: 'Digit7', metaKey: true, shiftKey: true }), true)).toBe(true)
    expect(matchesBinding('?', e({ key: '?', shiftKey: true }), false)).toBe(true)
    expect(matchesBinding('shift+f5', e({ key: 'F5' }), false)).toBe(false)
    expect(matchesBinding('shift+f5', e({ key: 'F5', shiftKey: true }), false)).toBe(true)
    expect(matchesBinding('mod+k mod+\\', e({ key: 'k', code: 'KeyK', metaKey: true }), true)).toBe(false) // a sequence: its module follows it
  })
})

describe('the modules keep to the list', () => {
  const WORKSPACE: Partial<Record<ShortcutId, (index: number) => WorkspaceAction>> = {
    'workspace.split': () => ({ type: 'split' }),
    'workspace.close': () => ({ type: 'close' }),
    'workspace.maximize': () => ({ type: 'maximize' }),
    'workspace.zen': () => ({ type: 'zen' }),
    'workspace.focus': (i) => ({ type: 'focus', dir: (['left', 'right', 'up', 'down'] as const)[i] }),
    'workspace.switch': (i) => ({ type: 'workspace', index: i })
  }
  const TERMINAL: Partial<Record<ShortcutId, TerminalAction>> = {
    'terminal.find': 'find',
    'terminal.clear': 'clear',
    'terminal.prevCommand': 'prevCommand',
    'terminal.nextCommand': 'nextCommand',
    'terminal.copy': 'copy',
    'terminal.paste': 'paste',
    'terminal.close': 'close'
  }

  for (const mac of [true, false]) {
    it(`the workspace answers its keys (${mac ? 'Mac' : 'elsewhere'})`, () => {
      for (const [id, action] of Object.entries(WORKSPACE)) {
        presses(shortcutBindings(id as ShortcutId, mac)[0], mac).forEach((press, i) => expect(matchWorkspaceKey(press, mac), `${id} ${i}`).toEqual(action!(i)))
      }
      const [closeAny] = presses(shortcutBindings('workspace.closeAny', mac)[0], mac)
      expect(isCloseKey(closeAny, mac)).toBe(true)
      expect(matchWorkspaceKey(closeAny, mac)).toBeNull() // after the modules, not ahead of them
    })

    it(`the terminal answers its keys, and labels them as the list does (${mac ? 'Mac' : 'elsewhere'})`, () => {
      for (const [id, action] of Object.entries(TERMINAL)) {
        const bindings = shortcutBindings(id as ShortcutId, mac)
        for (const binding of bindings) for (const press of presses(binding, mac)) expect(terminalAction({ type: 'keydown', ...press }, mac), `${id} ${binding}`).toBe(action)
        if (bindings.length) expect(terminalLabel(action!, mac)).toBe(formatBinding(bindings[0], mac))
      }
    })

    it(`the palette answers its keys (${mac ? 'Mac' : 'elsewhere'})`, () => {
      for (const id of ['palette', 'shortcuts'] as const) {
        for (const binding of shortcutBindings(id, mac)) for (const press of presses(binding, mac)) expect(matchPaletteKey(press, mac, null), binding).toBe(id)
      }
    })
  }
})
