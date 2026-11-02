import { act, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CompletionContext, currentCompletions, startCompletion, type Completion, type CompletionResult } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type Extension, type Range as DecoRange } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { NoteMeta } from '@shared/types/memory'

import { ObsidianSyntax } from '@/features/memory/editor/syntax'
import { decorate, linkClicks, liveHooks, livePreview, refreshLive, type LiveHooks } from '@/features/memory/editor/livePreview'
import { noteCompletions } from '@/features/memory/editor/complete'
import { pictureDrops } from '@/features/memory/editor/pictures'
import { fromOutside, noteEditorExtensions, toggleWrap } from '@/features/memory/editor/setup'
import { MarkdownEditor, type MarkdownEditorHandle } from '@/features/memory/components/MarkdownEditor'
import { allTags, findNote, linkTarget, linkText } from '@/features/memory/links'

// jsdom has no layout: CodeMirror's measuring gets empty rectangles.
beforeAll(() => {
  const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = rects
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((v) => v.destroy()))

const meta = (path: string, extra: Partial<NoteMeta> = {}): NoteMeta => ({
  path,
  title: path.replace(/^.*\//, '').replace(/\.md$/, ''),
  folder: path.includes('/') ? path.split('/')[0] : '',
  tags: [],
  modifiedAt: '',
  linkCount: 0,
  ...extra
})

const lang = () => markdown({ base: markdownLanguage, extensions: [ObsidianSyntax] })

function hooks(over: Partial<LiveHooks> = {}): LiveHooks {
  return { resolves: (t) => t !== 'Ghost', image: vi.fn(async () => null), openNote: vi.fn(), openUrl: vi.fn(), ...over }
}

function stateOf(doc: string, cursor = doc.length, extra: Extension[] = []) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [lang(), ...extra] })
  ensureSyntaxTree(state, state.doc.length, 1e9)
  return state
}

/** The decorations as readable strings: `hide 0-2`, `mark cm-md-strong 4-12`, `line cm-md-h1 @0`, `widget Bullet 0-1`. */
function show(state: EditorState): string[] {
  const doc = state.doc
  return decorate(state, 0, doc.length)
    .map((r: DecoRange<Decoration>) => {
      const spec = r.value.spec as { class?: string; widget?: { constructor: { name: string } }; attributes?: Record<string, string> }
      if (spec.widget) return `widget ${spec.widget.constructor.name.replace('Widget', '')} ${doc.sliceString(r.from, r.to)}`
      if (r.from === r.to) return `line ${spec.class} @${doc.lineAt(r.from).number}`
      const attrs = spec.attributes ? ` ${JSON.stringify(spec.attributes)}` : ''
      if (spec.class) return `mark ${spec.class} "${doc.sliceString(r.from, r.to)}"${attrs}`
      return `hide "${doc.sliceString(r.from, r.to)}"`
    })
}

function mount(doc: string, extra: Extension[] = [], cursor = doc.length) {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({ parent, state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [lang(), ...extra] }) })
  ensureSyntaxTree(view.state, view.state.doc.length, 1e9)
  views.push(view)
  return view
}

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0))
})

describe('note links (renderer)', () => {
  const notes = [meta('Plan.md'), meta('Projekte/Plan.md'), meta('Mindeck.md', { tags: ['app', 'idee'] }), meta('Ideen/Neu.md', { tags: ['idee'] })]

  it('resolves like Obsidian: by name, by path suffix, shortest path first; anchors ignored', () => {
    expect(linkTarget(' Plan#Ziele ')).toBe('Plan')
    expect(linkTarget('Plan^block')).toBe('Plan')
    expect(findNote('plan', notes)!.path).toBe('Plan.md')
    expect(findNote('Projekte/Plan.md', notes)!.path).toBe('Projekte/Plan.md')
    expect(findNote('./Projekte\\Plan', notes)!.path).toBe('Projekte/Plan.md')
    expect(findNote('Mindeck#Ziele', notes)!.path).toBe('Mindeck.md')
    expect(findNote('#only-anchor', notes)).toBeUndefined()
    expect(findNote('Nope', notes)).toBeUndefined()
    const tie = [meta('B/X.md'), meta('A/X.md')]
    expect(findNote('X', tie)!.path).toBe('A/X.md')
  })

  it('writes a link by name unless the name is ambiguous; lists tags by use', () => {
    expect(linkText(notes[2], notes)).toBe('Mindeck')
    expect(linkText(notes[1], notes)).toBe('Projekte/Plan')
    expect(allTags(notes)).toEqual(['idee', 'app'])
  })
})

describe('Obsidian syntax', () => {
  const names = (doc: string) => {
    const state = stateOf(doc)
    const out: string[] = []
    ensureSyntaxTree(state, doc.length, 1e9)!.iterate({
      enter: (n) => {
        if (/^(Wiki|Tag)/.test(n.name)) out.push(`${n.name}:${doc.slice(n.from, n.to)}`)
      }
    })
    return out
  }

  it('parses [[links]], ![[embeds]] with aliases and #tags', () => {
    expect(names('See [[Plan#Ziele|den Plan]] and ![[bild.png]] #idee/neu')).toEqual([
      'WikiLink:[[Plan#Ziele|den Plan]]',
      'WikiMark:[[',
      'WikiTarget:Plan#Ziele',
      'WikiAlias:|den Plan',
      'WikiMark:]]',
      'WikiEmbed:![[bild.png]]',
      'WikiMark:![[',
      'WikiTarget:bild.png',
      'WikiMark:]]',
      'Tag:#idee/neu'
    ])
  })

  it('leaves things alone that only look similar', () => {
    expect(names('#tag at the start, (#paren), a#b #123 [x] [[open ![x] ! [[]]')).toEqual(['Tag:#tag', 'Tag:#paren'])
  })
})

describe('Live Preview decorations', () => {
  it('renders headings, emphasis, code and quotes — the cursor line keeps its Markdown', () => {
    const doc = '# Title ##\n\n**bold** *it* ~~gone~~ `code`\n\n> quoted\n\nend'
    expect(show(stateOf(doc))).toEqual([
      'line cm-md-h1 @1',
      'hide "# "',
      'hide "##"',
      'mark cm-md-strong "**bold**"',
      'hide "**"',
      'hide "**"',
      'mark cm-md-em "*it*"',
      'hide "*"',
      'hide "*"',
      'mark cm-md-strike "~~gone~~"',
      'hide "~~"',
      'hide "~~"',
      'mark cm-md-code "`code`"',
      'hide "`"',
      'hide "`"',
      'line cm-md-quote @5',
      'hide "> "'
    ])
    // On the cursor's line nothing is hidden.
    expect(show(stateOf(doc, 3))).toEqual(expect.arrayContaining(['line cm-md-h1 @1']))
    expect(show(stateOf(doc, 3)).filter((d) => d.startsWith('hide')).length).toBe(9)
    expect(show(stateOf(doc, 13)).filter((d) => d.startsWith('hide'))).toEqual(['hide "# "', 'hide "##"', 'hide "> "']) // on the emphasis line
    expect(show(stateOf(doc, 44)).filter((d) => d.startsWith('hide')).length).toBe(10) // on the quote: its mark shows
    expect(show(stateOf('Setext\n===\n\n#  x', 0))).toEqual(['line cm-md-h1 @1', 'line cm-md-h1 @4', 'hide "# "'])
  })

  it('shows code blocks as blocks, with the fences hidden unless the cursor is inside', () => {
    const doc = '```ts\nconst a = 1\n```\n\n    indented\n\nx'
    expect(show(stateOf(doc))).toEqual([
      'line cm-md-codeblock @1',
      'line cm-md-codeblock @2',
      'line cm-md-codeblock @3',
      'hide "```"',
      'mark cm-md-codeinfo "ts"',
      'hide "```"',
      'line cm-md-codeblock @5'
    ])
    expect(show(stateOf(doc, 8)).filter((d) => d.startsWith('hide'))).toEqual([])
  })

  it('turns list dashes into bullets and tasks into checkboxes', () => {
    const doc = '- one\n- [ ] todo\n- [x] done\n- [X] \n- [x]\n1. first\n\nend'
    expect(show(stateOf(doc))).toEqual([
      'widget Bullet -',
      'hide "- "',
      'widget Checkbox [ ]',
      'hide "- "',
      'mark cm-md-done " done"',
      'widget Checkbox [x]',
      'hide "- "',
      'mark cm-md-done " "',
      'widget Checkbox [X]',
      'widget Bullet -'
    ])
    // The cursor's line shows the text it is.
    expect(show(stateOf(doc, 8))).toContain('hide "- "')
    expect(show(stateOf(doc, 8)).filter((d) => d.startsWith('widget Checkbox')).length).toBe(2)
  })

  it('renders rules, links, bare addresses and pictures', () => {
    const doc = '---\n\n[Mindeck](https://mindeck.app) <https://x.dev> https://bare.dev [ref][r] ![alt](img/a.png) ![multi\nline](b.png)\n\n[r]: https://r.dev\n\nend'
    expect(show(stateOf(doc))).toEqual([
      'widget Rule ---',
      'hide "["',
      'mark cm-md-link "Mindeck" {"data-href":"https://mindeck.app","data-live":"1"}',
      'hide "](https://mindeck.app)"',
      'mark cm-md-link "https://x.dev" {"data-href":"https://x.dev","data-live":"1"}',
      'mark cm-md-link "https://bare.dev" {"data-href":"https://bare.dev","data-live":"1"}',
      'widget Image ![alt](img/a.png)',
      'mark cm-md-link "https://r.dev" {"data-href":"https://r.dev","data-live":"1"}'
    ])
    const active = show(stateOf(doc, 10))
    expect(active).toContain('mark cm-md-link "[Mindeck](https://mindeck.app)" {"data-href":"https://mindeck.app"}')
    expect(active.some((d) => d.startsWith('widget Rule'))).toBe(true)
    expect(show(stateOf(doc, 1)).some((d) => d.startsWith('widget Rule'))).toBe(false) // on the rule: its dashes show
    expect(show(stateOf('[a\nb](https://x.dev)\n\nz'))).toEqual(['mark cm-md-link "[a\nb](https://x.dev)" {"data-href":"https://x.dev"}'])
  })

  it('renders [[links]] by their name or alias, unresolved ones dimmed, and embedded pictures', () => {
    const doc = '[[Plan#Ziele]] [[Ghost|Geist]] ![[Notiz]] ![[bild.png|300]] ![[x.png]] #tag\n\nz'
    const h = hooks()
    expect(show(stateOf(doc, doc.length, [liveHooks.of(h)]))).toEqual([
      'hide "[["',
      'mark cm-md-wikilink "Plan#Ziele" {"data-target":"Plan#Ziele","data-live":"1"}',
      'hide "]]"',
      'hide "[["',
      'hide "Ghost|"',
      'mark cm-md-wikilink cm-md-unresolved "Geist" {"data-target":"Ghost","data-live":"1"}',
      'hide "]]"',
      'hide "![["',
      'mark cm-md-wikilink "Notiz" {"data-target":"Notiz","data-live":"1"}',
      'hide "]]"',
      'widget Image ![[bild.png|300]]',
      'widget Image ![[x.png]]',
      'mark cm-md-tag "#tag"'
    ])
    expect(show(stateOf(doc, 1, [liveHooks.of(h)]))).toEqual([
      'mark cm-md-wikilink "[[Plan#Ziele]]" {"data-target":"Plan#Ziele"}',
      'mark cm-md-wikilink cm-md-unresolved "[[Ghost|Geist]]" {"data-target":"Ghost"}',
      'mark cm-md-wikilink "![[Notiz]]" {"data-target":"Notiz"}',
      'mark cm-md-tag "#tag"'
    ])
  })

  it('without hooks every link counts as resolved', () => {
    expect(show(stateOf('[[A]]\n\nz'))).toContain('mark cm-md-wikilink "A" {"data-target":"A","data-live":"1"}')
  })

  it('hides marks without a following space as they are; a picture alias that is no number is no width', () => {
    expect(show(stateOf('>quote\n\nz'))).toEqual(['line cm-md-quote @1', 'hide ">"'])
    expect(show(stateOf('![[a.png|Bild]]\n\nz'))).toEqual(['widget Image ![[a.png|Bild]]'])
  })
})

describe('Live Preview in the editor', () => {
  it('toggles task boxes, fills pictures from the vault, follows rendered links', async () => {
    const h = hooks({
      image: vi.fn(async (t: string) => (t === 'ok.png' ? 'data:image/png;base64,AA' : t === 'boom.png' ? Promise.reject(new Error('x')) : null))
    })
    const view = mount('- [ ] todo\n- [x] done\n- item\n\n---\n\n![[ok.png|120]] ![[gone.png]] ![[boom.png]]\n\n[[Plan]] [web](https://w.dev)\n\nend', [liveHooks.of(h), livePreview, linkClicks])
    const boxes = view.dom.querySelectorAll<HTMLInputElement>('.cm-md-checkbox')
    expect([...boxes].map((b) => b.checked)).toEqual([false, true])
    boxes[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(view.state.doc.line(1).text).toBe('- [x] todo')
    view.dom.querySelectorAll<HTMLInputElement>('.cm-md-checkbox')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(view.state.doc.line(2).text).toBe('- [ ] done')
    expect(view.dom.querySelector('.cm-md-bullet')!.textContent).toBe('•')
    expect(view.dom.querySelector('.cm-md-hr')).not.toBeNull()
    // Moving the cursor elsewhere keeps the widgets (compared, not rebuilt).
    const bulletEl = view.dom.querySelector('.cm-md-bullet')
    view.dispatch({ selection: { anchor: view.state.doc.length - 1 } })
    expect(view.dom.querySelector('.cm-md-bullet')).toBe(bulletEl)

    await flush()
    const img = view.dom.querySelector<HTMLImageElement>('.cm-md-embed img')!
    expect(img.src).toBe('data:image/png;base64,AA')
    expect(img.width).toBe(120)
    const measure = vi.spyOn(view, 'requestMeasure')
    img.onload!(new Event('load'))
    expect(measure).toHaveBeenCalled()
    expect([...view.dom.querySelectorAll('.cm-md-embed-missing')].map((e) => e.textContent)).toEqual(['gone.png', 'boom.png'])

    const link = view.dom.querySelector<HTMLElement>('[data-target="Plan"]')!
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(h.openNote).toHaveBeenCalledWith('Plan')
    view.dom.querySelector<HTMLElement>('[data-href]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(h.openUrl).toHaveBeenCalledWith('https://w.dev')
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }))
    expect(h.openNote).toHaveBeenCalledTimes(1)
  })

  it('works without hooks: pictures stay missing, links go nowhere', async () => {
    const view = mount('![[a.png]] [[B]] [w](https://w.dev)\n\nz', [livePreview, linkClicks])
    await flush()
    expect(view.dom.querySelector('.cm-md-embed-missing')!.textContent).toBe('a.png')
    view.dom.querySelector<HTMLElement>('[data-target]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    view.dom.querySelector<HTMLElement>('[data-href]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(view.state.doc.toString()).toContain('[[B]]')
  })

  it('on the cursor line a plain click edits; ⌘/Ctrl-click still follows', () => {
    const h = hooks()
    const view = mount('[[Plan]] text', [liveHooks.of(h), livePreview, linkClicks], 3)
    const link = view.dom.querySelector<HTMLElement>('[data-target="Plan"]')!
    expect(link.dataset.live).toBeUndefined()
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(h.openNote).not.toHaveBeenCalled()
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }))
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, metaKey: true }))
    expect(h.openNote).toHaveBeenCalledTimes(2)
    view.dom.querySelector('.cm-line')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(h.openNote).toHaveBeenCalledTimes(2)
  })

  it('rebuilds on transactions and scrolling, not on other updates', () => {
    const view = mount('**a**\n\nz', [livePreview])
    const plugin = view.plugin(livePreview)!
    const before = plugin.decorations
    plugin.update({ viewportChanged: false, transactions: [], view } as never)
    expect(plugin.decorations).toBe(before)
    plugin.update({ viewportChanged: true, transactions: [], view } as never)
    expect(plugin.decorations).not.toBe(before)
    const again = plugin.decorations
    view.dispatch({ effects: refreshLive.of(null) })
    expect(view.plugin(livePreview)!.decorations).not.toBe(again)
  })
})

describe('completions', () => {
  const notes = [meta('Plan.md'), meta('Projekte/Plan.md'), meta('Mindeck.md', { tags: ['idee', 'app'] })]
  const complete = (doc: string, explicit = false) => {
    const state = EditorState.create({ doc, extensions: [lang()] })
    return noteCompletions(() => notes)(new CompletionContext(state, doc.length, explicit)) as CompletionResult | null
  }

  it('[[ suggests notes and completes the link (closing it once)', () => {
    const r = complete('See [[Pl')!
    expect(r.from).toBe(6)
    expect(r.options.map((o) => [o.label, o.detail])).toEqual([
      ['Plan', undefined],
      ['Plan', 'Projekte'],
      ['Mindeck', undefined]
    ])
    const view = mount('See [[Pl')
    const apply = r.options[1].apply as (v: EditorView, c: Completion, from: number, to: number) => void
    apply(view, r.options[1], 6, 8)
    expect(view.state.doc.toString()).toBe('See [[Projekte/Plan]]')
    expect(view.state.selection.main.head).toBe(view.state.doc.length)

    const closed = mount('[[Mi]] after')
    ;(r.options[2].apply as typeof apply)(closed, r.options[2], 2, 4)
    expect(closed.state.doc.toString()).toBe('[[Mindeck]] after')
    expect(closed.state.selection.main.head).toBe(11)
  })

  it('# suggests tags once something is typed (or on request)', () => {
    expect(complete('text #id')!.options.map((o) => o.label)).toEqual(['app', 'idee'])
    expect(complete('text #id')!.from).toBe(6)
    expect(complete('#')).toBeNull()
    expect(complete('#', true)!.from).toBe(1)
    expect(complete('plain')).toBeNull()
    expect(complete('a#b')).toBeNull()
  })
})

describe('pictures by paste and drop', () => {
  const png = (name = 'a.png') => new File(['x'], name, { type: 'image/png' })
  const paste = (view: EditorView, files: File[] | null) => {
    const e = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'clipboardData', { value: files ? { files, getData: () => '', types: [] } : null })
    view.contentDOM.dispatchEvent(e)
    return e
  }
  const drop = (view: EditorView, files: File[] | undefined) => {
    const e = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 })
    Object.defineProperty(e, 'dataTransfer', { value: files ? { files } : undefined })
    view.contentDOM.dispatchEvent(e)
    return e
  }

  it('embeds pasted pictures at the cursor, replacing the selection', async () => {
    const save = vi.fn(async (f: File) => (f.name === 'bad.png' ? null : f.name))
    const view = mount('Hello World', [pictureDrops(save)])
    view.dispatch({ selection: { anchor: 6, head: 11 } })
    expect(paste(view, [png(), new File(['t'], 't.txt', { type: 'text/plain' }), png('bad.png'), png('b.png')]).defaultPrevented).toBe(true)
    await flush()
    expect(view.state.doc.toString()).toBe('Hello ![[a.png]]\n![[b.png]]')
    expect(view.state.selection.main.head).toBe(view.state.doc.length)
    // Text pastes are CodeMirror's own business.
    paste(view, [new File(['t'], 't.txt', { type: 'text/plain' })])
    paste(view, null)
    expect(save).toHaveBeenCalledTimes(3)
  })

  it('embeds dropped pictures where they land, and nothing when saving fails', async () => {
    const view = mount('ab', [pictureDrops(async (f) => f.name)])
    view.posAtCoords = vi.fn(() => 1) as never
    expect(drop(view, [png('d.png')]).defaultPrevented).toBe(true)
    await flush()
    expect(view.state.doc.toString()).toBe('a![[d.png]]b')
    view.posAtCoords = vi.fn(() => null) as never
    view.dispatch({ selection: { anchor: 0 } })
    drop(view, [png('e.png')])
    await flush()
    expect(view.state.doc.toString()).toBe('![[e.png]]a![[d.png]]b')
    expect(drop(view, undefined).defaultPrevented).toBe(false)

    const failing = mount('x', [pictureDrops(async () => null)])
    paste(failing, [png()])
    await flush()
    expect(failing.state.doc.toString()).toBe('x')
  })

  it('keeps the position inside the note when it shrank meanwhile', async () => {
    let finish!: (link: string) => void
    const view = mount('long text here', [pictureDrops(() => new Promise((r) => (finish = r)))])
    view.dispatch({ selection: { anchor: 10 } })
    paste(view, [png()])
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'ab' } })
    finish('p.png')
    await flush()
    expect(view.state.doc.toString()).toBe('ab![[p.png]]')
  })
})

describe('editor setup', () => {
  it('⌘B / ⌘I wrap and unwrap the selection', () => {
    const view = mount('make bold')
    view.dispatch({ selection: { anchor: 5, head: 9 } })
    toggleWrap('**')(view)
    expect(view.state.doc.toString()).toBe('make **bold**')
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('bold')
    toggleWrap('**')(view)
    expect(view.state.doc.toString()).toBe('make bold')
    view.dispatch({ selection: { anchor: 0, head: 4 } })
    toggleWrap('*')(view)
    expect(view.state.doc.toString()).toBe('*make* bold')
  })

  it('reports typing, not changes that came from the file', () => {
    const onChange = vi.fn()
    const parent = document.createElement('div')
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'a',
        extensions: noteEditorExtensions({ hooks: hooks(), notes: () => [], attach: async () => null, onChange, placeholder: 'Write' })
      })
    })
    views.push(view)
    view.dispatch({ changes: { from: 1, insert: 'b' } })
    expect(onChange).toHaveBeenLastCalledWith('ab')
    view.dispatch({ changes: { from: 0, to: 2, insert: 'disk' }, annotations: fromOutside.of(true) })
    view.dispatch({ selection: { anchor: 0 } })
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('MarkdownEditor', () => {
  function props(over: Partial<Parameters<typeof MarkdownEditor>[0]> = {}) {
    return {
      value: '- item [[Plan]] [[Ghost]] ![[p.png]] [w](https://w.dev)\n\nend',
      live: true,
      notes: [meta('Plan.md')],
      placeholder: 'Write…',
      onChange: vi.fn(),
      onOpenNote: vi.fn(),
      onOpenUrl: vi.fn(),
      onAttach: vi.fn(async () => 'x.png'),
      loadImage: vi.fn(async () => null),
      ...over
    }
  }
  const viewOf = (c: HTMLElement) => EditorView.findFromDOM(c.querySelector('.cm-editor') as HTMLElement)!

  it('edits the text, follows links through the note view, and switches Live Preview off and on', async () => {
    const p = props()
    const { container, rerender } = render(<MarkdownEditor {...p} />)
    const view = viewOf(container)
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    expect(container.querySelector('.cm-md-bullet')).not.toBeNull()
    expect(container.querySelector('[data-target="Plan"]')!.className).not.toContain('unresolved')
    expect(container.querySelector('[data-target="Ghost"]')!.className).toContain('unresolved')
    container.querySelector('[data-target="Plan"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(p.onOpenNote).toHaveBeenCalledWith('Plan')
    container.querySelector('[data-href]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(p.onOpenUrl).toHaveBeenCalledWith('https://w.dev')
    await flush()
    expect(p.loadImage).toHaveBeenCalledWith('p.png')

    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: 'X' } }))
    expect(p.onChange).toHaveBeenLastCalledWith(`${p.value}X`)

    // A note appears: [[Ghost]] resolves now.
    rerender(<MarkdownEditor {...p} notes={[meta('Plan.md'), meta('Ghost.md')]} />)
    expect(container.querySelector('[data-target="Ghost"]')!.className).not.toContain('unresolved')

    rerender(<MarkdownEditor {...p} live={false} />)
    expect(container.querySelector('.cm-md-bullet')).toBeNull()
    rerender(<MarkdownEditor {...p} live />)
    expect(container.querySelector('.cm-md-bullet')).not.toBeNull()
  })

  it('suggests the current notes after [[', async () => {
    const { container } = render(<MarkdownEditor {...props({ value: '[[' })} />)
    const view = viewOf(container)
    view.dispatch({ selection: { anchor: 2 } })
    startCompletion(view)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120))
    })
    expect(currentCompletions(view.state).map((c) => c.label)).toEqual(['Plan'])
  })

  it('can start in source mode', () => {
    const { container, unmount } = render(<MarkdownEditor {...props({ live: false })} />)
    expect(container.querySelector('.cm-md-bullet')).toBeNull()
    expect(container.querySelector('[data-target]')).toBeNull()
    unmount()
    expect(container.querySelector('.cm-editor')).toBeNull()
  })

  it('follows the file when it changed outside, without reporting it as typing', () => {
    const p = props({ value: 'old' })
    const { container, rerender } = render(<MarkdownEditor {...p} />)
    rerender(<MarkdownEditor {...p} value="new from disk" />)
    expect(viewOf(container).state.doc.toString()).toBe('new from disk')
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('inserts text at the cursor (a template) and saves pasted pictures through the note view', async () => {
    const ref = createRef<MarkdownEditorHandle>()
    const p = props({ value: 'ab' })
    const { container } = render(<MarkdownEditor ref={ref} {...p} />)
    const view = viewOf(container)
    view.dispatch({ selection: { anchor: 1 } })
    act(() => ref.current!.insert('-T-'))
    expect(view.state.doc.toString()).toBe('a-T-b')
    expect(view.state.selection.main.head).toBe(4)

    const e = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'clipboardData', { value: { files: [new File(['x'], 'image.png', { type: 'image/png' })] } })
    view.contentDOM.dispatchEvent(e)
    await flush()
    expect(p.onAttach).toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('a-T-![[x.png]]b')
  })
})
