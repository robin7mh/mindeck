import { describe, expect, it, vi } from 'vitest'

const mon = vi.hoisted(() => {
  class Range {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number
    ) {}
  }
  const state = { providers: [] as { lang: string; provider: unknown }[] }
  const monaco = {
    Range,
    KeyMod: { Shift: 1024, Alt: 512 },
    KeyCode: { KeyF: 36 },
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    languages: { registerCodeActionProvider: (lang: string, provider: unknown) => state.providers.push({ lang, provider }) }
  }
  return { monaco, state, Range }
})
vi.mock('@/features/editor/monaco/setup', () => ({ monaco: mon.monaco }))

import { tidyBlankLines } from '@/features/editor/text'
import { phpAccessors, phpClassEnd, phpGetter, phpProperties, phpSetter } from '@/features/editor/php'
import { addEditorActions, phpActions, replaceText, setupExtras } from '@/features/editor/monaco/extras'
import { DEFAULTS, monacoOptions, settingsFor } from '@/features/editor/prefs'

describe('blank lines (Blank Line Organizer)', () => {
  it('squeezes runs to one blank line, or removes them; keeps the final newline and CRLF', () => {
    expect(tidyBlankLines('a\n\n\n\nb\n', true)).toBe('a\n\nb\n')
    expect(tidyBlankLines('a\n  \n\t\nb', true)).toBe('a\n\nb')
    expect(tidyBlankLines('a\n\n\nb\n\n\n', false)).toBe('a\nb\n')
    expect(tidyBlankLines('a\r\n\r\n\r\nb\r\n', true)).toBe('a\r\n\r\nb\r\n')
    expect(tidyBlankLines('\n\nx', true)).toBe('\nx')
    expect(tidyBlankLines('', true)).toBe('')
  })
})

const CLASS = `<?php

class User
{
    private ?string $name = null;
    protected int $age;
    public static $count = 0;
    private readonly array $tags;
    var $legacy;

    public function getAge(): int
    {
        return $this->age; // "}" in a comment
    }
}
`

describe('PHP getters and setters', () => {
  const lines = CLASS.split('\n')

  it('finds properties, their types, and where the class ends', () => {
    expect(phpProperties(lines, 1, lines.length)).toEqual([
      { name: 'name', type: '?string', line: 5 },
      { name: 'age', type: 'int', line: 6 },
      { name: 'count', type: undefined, line: 7 },
      { name: 'tags', type: 'array', line: 8 },
      { name: 'legacy', type: undefined, line: 9 }
    ])
    expect(phpProperties(['public function x($a);'], 1, 1)).toEqual([])
    expect(phpProperties(['private $a;'], 1, 3)).toEqual([{ name: 'a', type: undefined, line: 1 }]) // past the end
    expect(phpClassEnd(lines, 5)).toBe(15)
    expect(phpClassEnd(['$x = 1;'], 1)).toBeUndefined()
    expect(phpClassEnd(['class A', '{', '  $x = "{";'], 3)).toBeUndefined() // never closed
  })

  it('writes them like the VS Code extension, skipping ones that exist', () => {
    expect(phpGetter({ name: 'name', type: '?string', line: 1 })).toBe(
      ['    /**', '     * Get the value of name', '     */', '    public function getName(): ?string', '    {', '        return $this->name;', '    }'].join('\n')
    )
    expect(phpSetter({ name: 'count', line: 1 }, '  ')).toContain('  public function setCount($count): self')
    const code = phpAccessors(CLASS, phpProperties(lines, 5, 6), ['get', 'set'])
    expect(code).toContain('function getName()')
    expect(code).toContain('function setName(?string $name): self')
    expect(code).toContain('function setAge(int $age)')
    expect(code).not.toContain('function getAge') // already there
    expect(phpAccessors(CLASS, phpProperties(lines, 6, 6), ['get'])).toBe('')
    expect(phpAccessors('class A {}', [{ name: 'x', line: 1 }], ['get'])).toContain('    public function getX()') // default indent
  })

  it('a code action on the property line — none outside a class or on other lines', () => {
    setupExtras()
    setupExtras() // once
    expect(mon.state.providers.map((p) => p.lang)).toEqual(['php'])
    const model = { getLinesContent: () => lines, getValue: () => CLASS, uri: { path: '/p/User.php' }, getVersionId: () => 3 }
    const res = phpActions.provideCodeActions(model as never, new mon.Range(5, 1, 5, 1) as never, {} as never, {} as never) as {
      actions: { title: string; edit: { edits: { textEdit: { range: { startLineNumber: number }; text: string } }[] } }[]
      dispose(): void
    }
    res.dispose()
    expect(res.actions.map((a) => a.title)).toEqual(['Generate getter and setter for $name', 'Generate getter for $name', 'Generate setter for $name'])
    expect(res.actions[0].edit.edits[0].textEdit.range.startLineNumber).toBe(15)
    const ageOnly = phpActions.provideCodeActions(model as never, new mon.Range(6, 1, 6, 1) as never, {} as never, {} as never) as unknown as { actions: { title: string }[] }
    expect(ageOnly.actions.map((a) => a.title)).toEqual(['Generate getter and setter for $age', 'Generate setter for $age']) // getter exists
    const none = phpActions.provideCodeActions(model as never, new mon.Range(11, 1, 11, 1) as never, {} as never, {} as never) as { actions: unknown[]; dispose(): void }
    none.dispose()
    expect(none.actions).toEqual([])
    const loose = { ...model, getLinesContent: () => ['private $x;'], getValue: () => 'private $x;' }
    expect((phpActions.provideCodeActions(loose as never, new mon.Range(1, 1, 1, 1) as never, {} as never, {} as never) as unknown as { actions: unknown[] }).actions).toEqual([])
  })
})

describe('editor actions and text edits', () => {
  it('replaces a whole text as one edit, only when it changes; tidies through the palette', () => {
    let value = 'a\n\n\nb'
    const pushes: unknown[] = []
    const model = {
      getValue: () => value,
      getFullModelRange: () => 'all',
      pushEditOperations: (_s: unknown, edits: { text: string }[], cursor?: (inverse: unknown[]) => unknown) => {
        pushes.push(edits)
        value = edits[0].text
        return cursor?.([]) ?? null // like Monaco: the cursor afterwards comes from the caller
      }
    }
    replaceText(model as never, 'a\n\n\nb')
    expect(pushes).toEqual([])
    const actions: { id: string; label: string; run: (ed: unknown) => void }[] = []
    const editor = { addAction: (a: (typeof actions)[number]) => (actions.push(a), { dispose: () => {} }), getModel: () => model }
    const disposables = addEditorActions(editor as never)
    expect(disposables).toHaveLength(4)
    const tidy = actions.find((a) => a.id === 'mindeck.tidyBlankLines')!
    expect(tidy).toMatchObject({ label: 'Remove Blank Lines' })
    tidy.run(editor)
    expect(value).toBe('a\n\nb')
    tidy.run({ getModel: () => null }) // no file on screen
  })
})

describe('settings per language', () => {
  it('Mindeck’s defaults, then the user’s, then the language’s', () => {
    const user = { fontSize: 15, tabSize: 2, languages: { python: { tabSize: 4, rulers: [88] } } }
    expect(settingsFor(user, 'python')).toMatchObject({ fontSize: 15, tabSize: 4, rulers: [88], wordWrap: 'off' })
    expect(settingsFor(user, 'go')).toMatchObject({ tabSize: 2, rulers: [] })
    expect(settingsFor(user)).toMatchObject({ tabSize: 2 })
    expect(monacoOptions(settingsFor({}, 'x'))).toMatchObject({ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: DEFAULTS.fontSize, minimap: { enabled: true } })
  })
})
