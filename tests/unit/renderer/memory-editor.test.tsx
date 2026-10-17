import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import type { Note, NoteMeta, SearchHit } from '@shared/types/memory'

import { GraphStyleControl } from '@/features/memory/components/GraphStyleControl'
import { NoteList } from '@/features/memory/components/NoteList'
import { NoteEditor } from '@/features/memory/components/NoteEditor'
import { PaneContext } from '@/features/workspace/pane'

const meta = (path: string, extra: Partial<NoteMeta> = {}): NoteMeta => ({
  path,
  title: path.split('/').pop()!.replace(/\.md$/, ''),
  folder: path.includes('/') ? path.split('/')[0] : '',
  tags: [],
  modifiedAt: '',
  linkCount: 0,
  ...extra
})

describe('GraphStyleControl', () => {
  it('switches mode and picks a single color', () => {
    const onChange = vi.fn()
    const { rerender } = render(<GraphStyleControl style={{ mode: 'colorful', color: 'cyan' }} onChange={onChange} />)
    expect(screen.queryByLabelText('Graph color blue')).toBeNull()
    fireEvent.click(screen.getByText('Single'))
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'single', color: 'cyan' })

    rerender(<GraphStyleControl style={{ mode: 'single', color: 'cyan' }} onChange={onChange} />)
    expect(screen.getByLabelText('Graph color cyan').className).toContain('ring-2')
    expect(screen.getByLabelText('Graph color blue').className).not.toContain('ring-2')
    fireEvent.click(screen.getByLabelText('Graph color blue'))
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'single', color: 'blue' })
    fireEvent.click(screen.getByText('Colorful'))
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'colorful', color: 'cyan' })
  })
})

// --- NoteList --------------------------------------------------------------------
function listProps(over: Partial<Parameters<typeof NoteList>[0]> = {}) {
  return {
    notes: [
      meta('Root.md', { linkCount: 2 }),
      meta('Alpha.md'),
      meta('Ideen/B.md'),
      meta('Ideen/A.md'),
      meta('Ideen/Sub/C.md'),
      meta('Loose/D.md') // folder not in `folders`
    ],
    folders: ['Ideen', 'Ideen/Sub', 'Leer', 'Zeta'],
    hits: [] as SearchHit[],
    query: '',
    activePath: 'Ideen/A.md',
    folderSlots: new Map([['Ideen', 1]]),
    style: { mode: 'colorful' as const, color: 'cyan' as const },
    creating: null,
    onSearch: vi.fn(),
    onOpen: vi.fn(),
    onStartCreate: vi.fn(),
    onCancelCreate: vi.fn(),
    onSubmitCreate: vi.fn(),
    onMoveNote: vi.fn(),
    onMoveFolder: vi.fn(),
    ...over
  }
}

const dt = (data: Record<string, string> = {}) => ({
  types: Object.keys(data),
  getData: (k: string) => data[k] ?? '',
  setData: vi.fn(),
  dropEffect: '',
  effectAllowed: ''
})

describe('NoteList', () => {
  it('groups notes by folder (root first, sorted), marks the active note and link counts', () => {
    const p = listProps()
    const { container } = render(<NoteList {...p} />)
    const folderNames = [...container.querySelectorAll('span.truncate.font-sans.text-\\[12px\\]')].map((e) => e.textContent)
    expect(folderNames).toEqual(['Ideen', 'Ideen/Sub', 'Leer', 'Loose', 'Zeta'])
    const titles = [...container.querySelectorAll('span.min-w-0.flex-1.truncate')].map((e) => e.textContent)
    expect(titles.slice(0, 2)).toEqual(['Alpha', 'Root'])
    expect(screen.getByText('A').closest('button')!.className).toContain('bg-cyan/8')
    expect(screen.getByText('Root').nextElementSibling).toHaveTextContent('2') // link count
    expect(screen.getByText('Alpha').nextElementSibling).toBeNull()
    expect(screen.getAllByText('Empty — drop notes here')).toHaveLength(2) // Leer, Zeta

    fireEvent.click(screen.getByText('Root'))
    expect(p.onOpen).toHaveBeenCalledWith('Root.md')
    fireEvent.click(screen.getByText('Ideen'))
    expect(screen.queryByText('A')).toBeNull() // collapsed
    fireEvent.click(screen.getByText('Ideen'))
    expect(screen.getByText('A')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('New note in Ideen'))
    expect(p.onStartCreate).toHaveBeenCalledWith('note', 'Ideen')
    fireEvent.click(screen.getByTitle('New folder in Ideen'))
    expect(p.onStartCreate).toHaveBeenCalledWith('folder', 'Ideen')
    fireEvent.click(screen.getByLabelText('New note'))
    expect(p.onStartCreate).toHaveBeenCalledWith('note', '')
    fireEvent.click(screen.getByLabelText('New folder'))
    expect(p.onStartCreate).toHaveBeenCalledWith('folder', '')
  })

  it('folder dots follow the graph style', () => {
    const { container, rerender } = render(<NoteList {...listProps()} />)
    const dots = () => [...container.querySelectorAll<HTMLElement>('span.h-1\\.5.w-1\\.5')].map((e) => e.style.background)
    expect(dots()[0]).toBe('rgb(var(--graph-blue))') // Ideen → slot 1
    expect(dots()[2]).toBe('rgb(var(--graph-cyan))') // Leer → no slot → 0
    rerender(<NoteList {...listProps({ style: { mode: 'single', color: 'pink' } })} />)
    expect(new Set(dots())).toEqual(new Set(['rgb(var(--graph-pink))']))
  })

  it('debounces the search, shows hits and clears', async () => {
    vi.useFakeTimers()
    const p = listProps()
    const { rerender } = render(<NoteList {...p} />)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(p.onSearch).toHaveBeenLastCalledWith('')
    fireEvent.change(screen.getByPlaceholderText('Search memory…'), { target: { value: 'ide' } })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(p.onSearch).toHaveBeenLastCalledWith('ide')

    rerender(
      <NoteList
        {...p}
        query="ide"
        hits={[
          { path: 'Ideen/A.md', title: 'A', snippet: 'aaa' },
          { path: 'Root.md', title: 'Root', snippet: 'rrr' },
          { path: 'Ideen.md', title: 'Ideen', snippet: '', titleMatches: [[0, 3]] },
          { path: 'Mark.md', title: 'Mark', snippet: 'one ide two ide', matches: [[4, 7], [12, 15]] }
        ]}
      />
    )
    expect(screen.getByText('4 results')).toBeInTheDocument()
    // Matches are marked, in titles and snippets; an empty snippet shows no line.
    expect([...document.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Ide', 'ide', 'ide'])
    expect(screen.getAllByRole('button').find((b) => b.textContent === 'Ideen')!.querySelectorAll(':scope > span').length).toBe(1)
    expect(screen.getByText('two', { exact: false }).textContent).toBe('one ide two ide')
    expect(screen.getByText('aaa').closest('button')!.className).toContain('border-cyan/40')
    expect(screen.getByText('rrr').closest('button')!.className).toContain('border-transparent')
    fireEvent.click(screen.getByText('rrr'))
    expect(p.onOpen).toHaveBeenCalledWith('Root.md')
    fireEvent.click(screen.getByLabelText('Clear search'))
    expect(screen.queryByLabelText('Clear search')).toBeNull()
    vi.useRealTimers()
  })

  it('inline create: note at root, folder inside a folder; Enter, Escape and blur', () => {
    const p = listProps({ creating: { kind: 'note', parent: '' } })
    const { rerender } = render(<NoteList {...p} />)
    const input = screen.getByRole('textbox', { name: 'Note title…' })
    expect(input).toHaveFocus()
    expect(input.parentElement!.className).toContain('pl-2')
    fireEvent.change(input, { target: { value: 'Neu' } })
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(p.onSubmitCreate).toHaveBeenCalledWith('Neu')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(p.onCancelCreate).toHaveBeenCalledTimes(1)
    fireEvent.blur(input)
    expect(p.onSubmitCreate).toHaveBeenCalledTimes(2)

    rerender(<NoteList {...p} creating={{ kind: 'folder', parent: 'Leer' }} />)
    const folderInput = screen.getByRole('textbox', { name: 'Folder name…' })
    expect(folderInput.parentElement!.className).toContain('pl-7')
    expect(screen.getAllByText('Empty — drop notes here')).toHaveLength(1) // Leer shows the input instead
    fireEvent.blur(folderInput) // blank → cancel
    expect(p.onCancelCreate).toHaveBeenCalledTimes(2)
  })

  it('drag & drop moves notes and folders, ignoring no-op and foreign drops', () => {
    const p = listProps()
    const { container } = render(<NoteList {...p} />)
    const root = container.querySelector('.overflow-y-auto') as HTMLElement
    const folderHeader = (name: string) => screen.getByText(name, { selector: 'span.truncate' }).closest('div[draggable]') as HTMLElement
    const folderZone = (name: string) => folderHeader(name).parentElement as HTMLElement

    // drag sources
    const noteData = dt()
    fireEvent.dragStart(screen.getByText('Root').closest('button')!, { dataTransfer: noteData })
    expect(noteData.setData).toHaveBeenCalledWith('application/x-mindeck-note', 'Root.md')
    const folderData = dt()
    fireEvent.dragStart(folderHeader('Ideen/Sub'), { dataTransfer: folderData })
    expect(folderData.setData).toHaveBeenCalledWith('application/x-mindeck-folder', 'Ideen/Sub')

    // foreign drag (e.g. files from the OS) is not a drop target
    fireEvent.dragOver(folderZone('Leer'), { dataTransfer: dt({ Files: 'x' }) })
    expect(folderHeader('Leer').className).not.toContain('ring-1')

    // hover highlights the folder (twice → no extra state change), leaving clears it
    const over = dt({ 'application/x-mindeck-note': 'Root.md' })
    fireEvent.dragOver(folderZone('Leer'), { dataTransfer: over })
    fireEvent.dragOver(folderZone('Leer'), { dataTransfer: over })
    expect(folderHeader('Leer').className).toContain('ring-1')
    const inside = createEvent.dragLeave(folderZone('Leer'))
    Object.defineProperty(inside, 'relatedTarget', { value: folderHeader('Leer') })
    fireEvent(folderZone('Leer'), inside)
    expect(folderHeader('Leer').className).toContain('ring-1') // still inside
    fireEvent.dragLeave(root) // another zone's leave keeps it
    expect(folderHeader('Leer').className).toContain('ring-1')
    fireEvent.dragLeave(folderZone('Leer'))
    expect(folderHeader('Leer').className).not.toContain('ring-1')

    // root zone
    fireEvent.dragOver(root, { dataTransfer: dt({ 'application/x-mindeck-folder': 'Ideen/Sub' }) })
    expect(root.className).toContain('outline-dashed')
    fireEvent.dragLeave(root)
    expect(root.className).not.toContain('outline-dashed')

    // drops
    fireEvent.drop(folderZone('Leer'), { dataTransfer: dt({ 'application/x-mindeck-note': 'Root.md' }) })
    expect(p.onMoveNote).toHaveBeenCalledWith('Root.md', 'Leer')
    fireEvent.drop(folderZone('Ideen'), { dataTransfer: dt({ 'application/x-mindeck-note': 'Ideen/A.md' }) }) // same folder
    fireEvent.drop(root, { dataTransfer: dt({ 'application/x-mindeck-folder': 'Ideen/Sub' }) })
    expect(p.onMoveFolder).toHaveBeenCalledWith('Ideen/Sub', '')
    fireEvent.drop(folderZone('Ideen/Sub'), { dataTransfer: dt({ 'application/x-mindeck-folder': 'Ideen/Sub' }) }) // onto itself
    fireEvent.drop(folderZone('Ideen/Sub'), { dataTransfer: dt({ 'application/x-mindeck-folder': 'Ideen' }) }) // into its own child
    fireEvent.drop(folderZone('Ideen'), { dataTransfer: dt({ 'application/x-mindeck-folder': 'Ideen/Sub' }) }) // already there
    fireEvent.drop(folderZone('Zeta'), { dataTransfer: dt({}) }) // nothing dragged
    expect(p.onMoveNote).toHaveBeenCalledTimes(1)
    expect(p.onMoveFolder).toHaveBeenCalledTimes(1)
  })
})

// --- NoteEditor ------------------------------------------------------------------
const baseNote = (over: Partial<Note> = {}): Note => ({
  ...meta('Ideen/Sub/Plan.md'),
  raw: '',
  body: 'Hello [[Other]] and [[Ghost]]',
  frontmatter: {},
  backlinks: [],
  links: { Other: 'Other.md', Ghost: null },
  ...over
})

function editorProps(over: Partial<Parameters<typeof NoteEditor>[0]> = {}) {
  const note = over.note ?? baseNote()
  return {
    note,
    notes: [meta('Other.md'), meta('Ideen/Sub/Plan.md'), meta('Mindeck.md'), meta('Ideen für Mindeck.md'), meta('Projekte/Mindeck Pro.md')],
    templates: [] as NoteMeta[],
    draft: note.body,
    mode: 'preview' as const,
    source: false,
    saving: false,
    onDraft: vi.fn(),
    onMode: vi.fn(),
    onSource: vi.fn(),
    onInsertTemplate: vi.fn(async () => 'from template'),
    onAttach: vi.fn(async () => null),
    loadImage: vi.fn(async () => null),
    onSave: vi.fn(),
    onRename: vi.fn(),
    onOpen: vi.fn(),
    onOpenOrCreate: vi.fn(),
    onLink: vi.fn(),
    onUnlink: vi.fn(),
    onTrash: vi.fn(),
    ...over
  }
}

describe('NoteEditor', () => {
  it('header: folder path, type, tags, save state; properties formatting', () => {
    const date = new Date(2026, 0, 1, 12, 0)
    const note = baseNote({
      type: 'idea',
      tags: ['x', 'y'],
      frontmatter: {
        id: 'hidden',
        type: 'hidden',
        tags: ['hidden'],
        created: date,
        updated: '2026-01-02T10:00:00Z',
        bogus: '2026-99-99T99:99',
        list: ['a', 'b'],
        obj: { k: 1 },
        nothing: null,
        count: 3
      }
    })
    const { rerender } = render(<NoteEditor {...editorProps({ note })} />)
    expect(screen.getByText('Ideen / Sub')).toBeInTheDocument()
    expect(screen.getByText('idea')).toBeInTheDocument()
    expect(screen.getByText('#x')).toBeInTheDocument()
    expect(screen.getByText('saved')).toBeInTheDocument()
    expect(screen.queryByText('id')).toBeNull()
    expect(screen.getByText(date.toLocaleString())).toBeInTheDocument()
    expect(screen.getByText(new Date('2026-01-02T10:00:00Z').toLocaleString())).toBeInTheDocument()
    expect(screen.getByText('2026-99-99T99:99')).toBeInTheDocument()
    expect(screen.getByText('a, b')).toBeInTheDocument()
    expect(screen.getByText('{"k":1}')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('nothing').nextElementSibling!.textContent).toBe('')

    rerender(<NoteEditor {...editorProps({ note, draft: 'changed' })} />)
    expect(screen.getByText('unsaved')).toBeInTheDocument()
    rerender(<NoteEditor {...editorProps({ note, saving: true })} />)
    expect(screen.getByText('saving')).toBeInTheDocument()
  })

  it('root note without type/tags/properties; empty body invites editing', () => {
    const p = editorProps({ note: baseNote({ ...meta('Solo.md'), body: '  ', links: {} }) })
    const { container } = render(<NoteEditor {...p} />)
    expect(container.querySelector('dl')).toBeNull()
    expect(screen.queryByText('Ideen / Sub')).toBeNull()
    fireEvent.click(screen.getByText('Empty note — click to start writing'))
    expect(p.onMode).toHaveBeenCalledWith('edit')
    expect(screen.getByText(/Not connected yet/)).toBeInTheDocument()
  })

  it('mode buttons (Live, Source, Read), the editor and keyboard shortcuts', () => {
    const p = editorProps()
    const { rerender, container } = render(<NoteEditor {...p} />)
    expect(screen.getByTitle('Read (⌘E)')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByTitle(/^Live Preview/))
    expect(p.onSource).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByTitle('Source — plain Markdown'))
    expect(p.onSource).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByTitle('Read (⌘E)'))
    expect(p.onMode).toHaveBeenLastCalledWith('preview')

    fireEvent.keyDown(window, { key: 'e' }) // no modifier → ignored
    fireEvent.keyDown(window, { key: 'E', metaKey: true })
    expect(p.onMode).toHaveBeenLastCalledWith('edit')
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(p.onSave).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'x', ctrlKey: true })
    expect(p.onMode).toHaveBeenCalledTimes(2)

    rerender(<NoteEditor {...p} mode="edit" />)
    expect(screen.getByTitle(/^Live Preview/)).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true })
    expect(p.onMode).toHaveBeenLastCalledWith('preview')
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    expect(view.state.doc.toString()).toBe(p.draft)
    act(() => view.dispatch({ changes: { from: 0, insert: 'typed ' } }))
    expect(p.onDraft).toHaveBeenCalledWith(`typed ${p.draft}`)

    rerender(<NoteEditor {...p} mode="edit" source />)
    expect(screen.getByTitle('Source — plain Markdown')).toHaveAttribute('aria-pressed', 'true')

    // next to the editor, without the focus: ⌘S is the editor's
    const { unmount } = render(
      <PaneContext.Provider value={{ focused: false }}>
        <NoteEditor {...p} />
      </PaneContext.Provider>
    )
    rerender(<div />)
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(p.onSave).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('preview links: wikilinks, external, relative markdown and plain anchors', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const body = [
      '[[Other]] [[Ghost]]',
      '[web](https://example.com) [mail](mailto:a@b.c)',
      '[rel](Other.md#part) [new](New%20Note.md) [img](pic.png) [bad](%E0%A4%A.md)',
      '<a class="wikilink">bare</a> <a>nohref</a> plain'
    ].join('\n\n')
    const p = editorProps({ note: baseNote({ body, links: { Other: 'Other.md', Ghost: null, 'Other.md': 'Other.md' } }) })
    const { container } = render(<NoteEditor {...p} />)
    const prose = container.querySelector('.md-prose') as HTMLElement
    fireEvent.click(within(prose).getByText('Other'))
    expect(p.onOpen).toHaveBeenLastCalledWith('Other.md')
    fireEvent.click(within(prose).getByText('Ghost'))
    expect(p.onOpenOrCreate).toHaveBeenLastCalledWith('Ghost')
    fireEvent.click(screen.getByText('bare'))
    expect(p.onOpenOrCreate).toHaveBeenLastCalledWith('')
    fireEvent.click(screen.getByText('web'))
    fireEvent.click(screen.getByText('mail'))
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    expect(open).toHaveBeenCalledWith('mailto:a@b.c', '_blank', 'noopener,noreferrer')
    fireEvent.click(screen.getByText('rel'))
    expect(p.onOpen).toHaveBeenLastCalledWith('Other.md')
    fireEvent.click(screen.getByText('new'))
    expect(p.onOpenOrCreate).toHaveBeenLastCalledWith('New Note.md')
    fireEvent.click(screen.getByText('bad'))
    expect(p.onOpenOrCreate).toHaveBeenLastCalledWith('%E0%A4%A.md')
    const calls = vi.mocked(p.onOpen).mock.calls.length + vi.mocked(p.onOpenOrCreate).mock.calls.length
    fireEvent.click(screen.getByText('img'))
    fireEvent.click(screen.getByText('nohref'))
    fireEvent.click(screen.getByText(/plain/))
    expect(vi.mocked(p.onOpen).mock.calls.length + vi.mocked(p.onOpenOrCreate).mock.calls.length).toBe(calls)
  })

  it('read mode fills pictures from the vault; missing ones are marked', async () => {
    const loadImage = vi.fn(async (t: string) => (t === 'ok.png' ? 'data:image/png;base64,AA' : null))
    const p = editorProps({ note: baseNote({ body: '![[ok.png]] ![[gone.png]]' }), loadImage })
    const { container, unmount } = render(<NoteEditor {...p} />)
    await act(async () => {})
    const imgs = container.querySelectorAll<HTMLImageElement>('.md-prose img')
    expect(imgs[0].src).toBe('data:image/png;base64,AA')
    expect(imgs[1].className).toContain('missing')
    expect(loadImage.mock.calls.map((c) => c[0])).toEqual(['ok.png', 'gone.png'])

    // Answers that arrive after leaving are dropped.
    let late!: (url: string) => void
    const slow = editorProps({ note: baseNote({ body: '![[late.png]]' }), loadImage: vi.fn(() => new Promise<string | null>((r) => (late = r))) })
    unmount()
    const second = render(<NoteEditor {...slow} />)
    const img = second.container.querySelector<HTMLImageElement>('.md-prose img')!
    second.rerender(<NoteEditor {...slow} mode="edit" />)
    await act(async () => late('data:image/png;base64,BB'))
    expect(img.getAttribute('src')).toBeNull()
  })

  it('edit mode: links in the editor open notes or pages; templates insert at the cursor', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const templates = [meta('Templates/Tag.md'), meta('Templates/Leer.md')]
    const onInsertTemplate = vi.fn(async (path: string) => (path === 'Templates/Tag.md' ? '## Heute\n' : null))
    const p = editorProps({ mode: 'edit', templates, onInsertTemplate, note: baseNote({ body: '[[Other]] [w](https://w.dev) [n](Neu.md) [o](Other.md)\n\nend', links: { Other: 'Other.md', 'Other.md': 'Other.md' } }) })
    const { container } = render(<NoteEditor {...p} />)
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }))
    const click = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    click(container.querySelector('[data-target="Other"]')!)
    expect(p.onOpenOrCreate).toHaveBeenLastCalledWith('Other')
    const hrefs = container.querySelectorAll('[data-href]')
    click(hrefs[0])
    expect(open).toHaveBeenCalledWith('https://w.dev', '_blank', 'noopener,noreferrer')
    click(hrefs[1])
    expect(p.onOpenOrCreate).toHaveBeenLastCalledWith('Neu.md')
    click(hrefs[2])
    expect(p.onOpen).toHaveBeenLastCalledWith('Other.md')

    // Insert template: a menu of the template notes.
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Insert template' }))
    fireEvent.click(screen.getByRole('button', { name: 'Insert template' }))
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Tag', 'Leer'])
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Insert template' }))
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Tag' }))
    fireEvent.mouseDown(screen.getByRole('menu'))
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Tag' })))
    expect(onInsertTemplate).toHaveBeenCalledWith('Templates/Tag.md')
    expect(view.state.doc.toString().endsWith('end## Heute\n')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Insert template' }))
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Leer' })))
    expect(view.state.doc.toString().endsWith('end## Heute\n')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Insert template' }))
    fireEvent.click(screen.getByRole('button', { name: 'Insert template' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('no template button without templates or while reading', () => {
    const { rerender } = render(<NoteEditor {...editorProps({ mode: 'edit' })} />)
    expect(screen.queryByLabelText('Insert template')).toBeNull()
    rerender(<NoteEditor {...editorProps({ templates: [meta('Templates/T.md')] })} />)
    expect(screen.queryByLabelText('Insert template')).toBeNull()
  })

  it('rename via the title input: Enter commits, Escape and blank/same revert', () => {
    const p = editorProps()
    render(<NoteEditor {...p} />)
    const title = screen.getByTitle('Rename — links in other notes are updated') as HTMLInputElement
    fireEvent.change(title, { target: { value: 'Neu' } })
    fireEvent.keyDown(title, { key: 'a' })
    fireEvent.keyDown(title, { key: 'Enter' })
    fireEvent.blur(title)
    expect(p.onRename).toHaveBeenCalledWith('Neu')
    fireEvent.change(title, { target: { value: 'Other' } })
    fireEvent.keyDown(title, { key: 'Escape' })
    expect(title.value).toBe('Plan')
    fireEvent.change(title, { target: { value: '   ' } })
    fireEvent.blur(title)
    expect(title.value).toBe('Plan')
    fireEvent.change(title, { target: { value: 'Plan' } })
    fireEvent.blur(title)
    expect(p.onRename).toHaveBeenCalledTimes(1)
  })

  it('trash asks for confirmation, which resets on blur and on another note', () => {
    const p = editorProps()
    const { rerender } = render(<NoteEditor {...p} />)
    fireEvent.click(screen.getByTitle('Move to trash'))
    fireEvent.blur(screen.getByText('Move to trash?'))
    expect(screen.queryByText('Move to trash?')).toBeNull()
    fireEvent.click(screen.getByTitle('Move to trash'))
    fireEvent.click(screen.getByText('Move to trash?'))
    expect(p.onTrash).toHaveBeenCalled()
    rerender(<NoteEditor {...p} note={baseNote({ ...meta('Other.md') })} />)
    expect(screen.queryByText('Move to trash?')).toBeNull()
  })

  it('connections: outgoing and (deduplicated) backlinks open and disconnect', () => {
    const note = baseNote({
      links: { Other: 'Other.md', Self: 'Ideen/Sub/Plan.md', Gone: 'Gone.md', Ghost: null, W: 'Mindeck.md' },
      backlinks: [meta('Other.md'), meta('Projekte/Mindeck Pro.md')]
    })
    const p = editorProps({ note })
    render(<NoteEditor {...p} />)
    expect(screen.getByText('4')).toBeInTheDocument() // 2 outgoing + 2 backlinks
    expect(screen.getAllByTitle('This note links to it').map((b) => b.textContent)).toEqual(['Mindeck', 'Other'])
    expect(screen.getAllByTitle('It links to this note').map((b) => b.textContent)).toEqual(['Mindeck Pro'])
    fireEvent.click(screen.getByTitle('It links to this note'))
    expect(p.onOpen).toHaveBeenCalledWith('Projekte/Mindeck Pro.md')
    fireEvent.click(screen.getAllByTitle('This note links to it')[1])
    expect(p.onOpen).toHaveBeenCalledWith('Other.md')
    fireEvent.click(screen.getByLabelText('Disconnect Other'))
    expect(p.onUnlink).toHaveBeenCalledWith('Ideen/Sub/Plan.md', 'Other.md')
    fireEvent.click(screen.getByLabelText('Disconnect Mindeck Pro'))
    expect(p.onUnlink).toHaveBeenCalledWith('Projekte/Mindeck Pro.md', 'Ideen/Sub/Plan.md')
  })

  it('Connect picker: ranks matches, picks by click or Enter, closes on Escape/outside', () => {
    const p = editorProps({ note: baseNote({ links: {} }) })
    render(<NoteEditor {...p} />)
    const toggle = screen.getByText('Connect')
    fireEvent.click(toggle)
    const search = screen.getByPlaceholderText('Connect to…')
    expect(screen.queryByText('Plan', { selector: 'span.truncate' })).toBeNull() // itself excluded
    fireEvent.change(search, { target: { value: 'mindeck' } })
    const ranked = [...document.querySelectorAll('.max-h-56 button span.flex-1')].map((e) => e.textContent)
    expect(ranked).toEqual(['Mindeck', 'Mindeck Pro', 'Ideen für Mindeck'])
    expect(screen.getByText('Projekte')).toBeInTheDocument() // folder hint
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(p.onLink).toHaveBeenLastCalledWith('Mindeck.md')
    expect(screen.queryByPlaceholderText('Connect to…')).toBeNull()

    fireEvent.click(toggle)
    fireEvent.change(screen.getByPlaceholderText('Connect to…'), { target: { value: 'zzz' } })
    expect(screen.getByText('No matching note')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByPlaceholderText('Connect to…'), { key: 'Enter' }) // no match → stays
    fireEvent.keyDown(screen.getByPlaceholderText('Connect to…'), { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Connect to…')).toBeNull()

    fireEvent.click(toggle)
    fireEvent.mouseDown(screen.getByPlaceholderText('Connect to…')) // inside
    fireEvent.click(screen.getByText('Other', { selector: '.max-h-56 span' }))
    expect(p.onLink).toHaveBeenLastCalledWith('Other.md')

    fireEvent.click(toggle)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByPlaceholderText('Connect to…')).toBeNull()
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(screen.queryByPlaceholderText('Connect to…')).toBeNull()
  })
})
