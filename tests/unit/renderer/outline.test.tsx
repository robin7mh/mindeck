import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, settle } from './bridge'
import { oneGroup, tabKey, useEditor, type EditorTab } from '@/features/editor/store'
import { useOutline, type OutlineSymbol } from '@/features/editor/outline'
import { Breadcrumbs } from '@/features/editor/components/Breadcrumbs'
import { OutlinePanel } from '@/features/editor/components/OutlinePanel'
import { symbolIcon } from '@/features/editor/components/symbolIcon'

const initial = useEditor.getState()
const e = () => useEditor.getState()
const tab = (path: string): EditorTab => ({
  id: tabKey('p', path),
  projectId: 'p',
  path,
  name: path.split('/').pop()!,
  loading: false,
  content: 'x',
  mtimeMs: 1,
  revision: 1,
  dirty: false,
  saving: false,
  conflict: false,
  deleted: false
})
const r = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({ startLine, startColumn, endLine, endColumn })
const sym = (name: string, kind: number, range: ReturnType<typeof r>, children: OutlineSymbol[] = [], detail?: string): OutlineSymbol => ({
  name,
  kind,
  detail,
  range,
  selection: r(range.startLine, range.startColumn + 6, range.startLine, range.startColumn + 6 + name.length),
  children
})
const symbols = [
  sym('Server', 4, r(1, 1, 10, 2), [sym('run', 5, r(2, 3, 4, 4), [], '(): void'), sym('stop', 5, r(5, 3, 7, 4))]),
  sym('main', 11, r(12, 1, 14, 2))
]
const entry = (path: string, kind: 'file' | 'dir' = 'file') => ({ name: path.split('/').pop()!, path, kind, ignored: false })

beforeEach(() => {
  useEditor.setState(initial, true)
  useEditor.setState({ projectId: 'p' })
  useOutline.setState({ symbols: {}, cursors: {} })
})

describe('breadcrumbs', () => {
  it('the path: each folder lists its neighbours — files open in the group, folders open further', async () => {
    const bridge = installBridge({
      'files:list': ({ dir }: { dir: string }) => (dir === 'src' ? [entry('src/lib', 'dir'), entry('src/x.ts')] : dir === 'src/lib' ? [entry('src/lib/a.ts'), entry('src/lib/b.ts')] : fail('no'))
    })
    const open = vi.fn(async () => {})
    useEditor.setState({ open })
    render(<Breadcrumbs tab={tab('src/lib/a.ts')} group="g2" />)
    const nav = screen.getByRole('navigation', { name: 'Breadcrumbs' })
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['src', 'lib', 'a.ts'])

    fireEvent.click(within(nav).getByRole('button', { name: 'lib' }))
    await act(settle)
    expect(bridge.invoke).toHaveBeenCalledWith('files:list', { projectId: 'p', dir: 'src' })
    const picker = screen.getByRole('dialog', { name: 'In lib' })
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['lib', 'x.ts'])
    fireEvent.click(within(picker).getByRole('option', { name: 'lib' })) // a folder: its entries
    await act(settle)
    expect(within(screen.getByRole('dialog')).getAllByRole('option').map((o) => o.textContent)).toEqual(['a.ts', 'b.ts'])
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox'), { target: { value: 'B' } })
    fireEvent.keyDown(within(screen.getByRole('dialog')).getByRole('textbox'), { key: 'Enter' })
    expect(open).toHaveBeenCalledWith('src/lib/b.ts', { group: 'g2' })
    expect(screen.queryByRole('dialog')).toBeNull()

    // The root's own listing fails: an empty list.
    fireEvent.click(within(nav).getByRole('button', { name: 'src' }))
    await act(settle)
    expect(within(screen.getByRole('dialog')).queryAllByRole('option')).toEqual([])
    const input = within(screen.getByRole('dialog')).getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' }) // nothing to pick
    fireEvent.keyDown(input, { key: 'x' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // A second click on the open crumb closes it; so does a click elsewhere.
    fireEvent.click(within(nav).getByRole('button', { name: 'a.ts' }))
    fireEvent.click(within(nav).getByRole('button', { name: 'a.ts' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(nav).getByRole('button', { name: 'a.ts' }))
    await act(settle)
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a listing that arrives after the list closed is dropped; another file closes the list', async () => {
    let release!: (v: unknown) => void
    installBridge({ 'files:list': () => new Promise((res) => (release = res)) })
    const { rerender } = render(<Breadcrumbs tab={tab('a.ts')} group="g1" />)
    fireEvent.click(screen.getByRole('button', { name: 'a.ts' }))
    rerender(<Breadcrumbs tab={tab('b.ts')} group="g1" />)
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => {
      release([entry('late.ts')])
      await settle()
    })
    expect(screen.queryByText('late.ts')).toBeNull()
  })

  it('the symbols around the cursor; each lists its neighbours, a pick puts the cursor there (in this group)', () => {
    installBridge({ 'files:list': () => [] })
    useOutline.setState({ symbols: { 'p:a.ts': symbols }, cursors: { g1: { line: 3, column: 1 } } })
    render(<Breadcrumbs tab={tab('a.ts')} group="g1" />)
    const nav = screen.getByRole('navigation')
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['a.ts', 'Server', 'run'])
    fireEvent.click(within(nav).getByRole('button', { name: 'run' }))
    expect(within(screen.getByRole('dialog')).getAllByRole('option').map((o) => o.textContent)).toEqual(['run', 'stop'])
    fireEvent.click(screen.getByRole('option', { name: 'stop' }))
    expect(e().reveal).toEqual({ id: 'p:a.ts', line: 5, match: { column: 8, length: 4 }, group: 'g1' })
    fireEvent.click(within(nav).getByRole('button', { name: 'Server' }))
    expect(within(screen.getByRole('dialog')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Server', 'main'])

    // Outside every symbol: the file's symbols are behind “…”.
    act(() => useOutline.getState().setCursor('g1', { line: 11, column: 1 }))
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['a.ts', ''])
    fireEvent.click(within(nav).getByRole('button', { name: 'Outline' }))
    expect(within(screen.getByRole('dialog', { name: 'In Outline' })).getAllByRole('option')).toHaveLength(2)
    // A file without symbols has no “…”.
    act(() => useOutline.getState().setSymbols('p:a.ts', []))
    expect(within(nav).queryByRole('button', { name: 'Outline' })).toBeNull()
  })
})

describe('the outline', () => {
  it('nothing open; a file without symbols', () => {
    render(<OutlinePanel />)
    expect(screen.getByText('Open a file to see its outline')).toBeInTheDocument()
    act(() => useEditor.setState({ tabs: [tab('a.ts')], ...oneGroup(['p:a.ts']) }))
    expect(screen.getByText('No symbols in this file')).toBeInTheDocument()
  })

  it('a tree that follows the cursor; a click goes there; folding; filtering keeps the way to a match', () => {
    const scroll = vi.mocked(Element.prototype.scrollIntoView)
    scroll.mockClear()
    useEditor.setState({ tabs: [tab('a.ts'), tab('b.ts')], ...oneGroup(['p:a.ts', 'p:b.ts']) })
    useOutline.setState({ symbols: { 'p:a.ts': symbols, 'p:b.ts': [sym('other', 12, r(1, 1, 1, 9))] }, cursors: { g1: { line: 6, column: 1 } } })
    render(<OutlinePanel />)
    const tree = () => screen.getByRole('tree', { name: 'Outline' })
    const items = () => within(tree()).getAllByRole('treeitem').map((i) => i.textContent)
    expect(items()).toEqual(['Server', 'run(): void', 'stop', 'main'])
    expect(within(tree()).getByRole('treeitem', { name: /stop/ })).toHaveAttribute('aria-current', 'true')
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })

    fireEvent.click(within(tree()).getByRole('treeitem', { name: /main/ }))
    expect(e().reveal).toEqual({ id: 'p:a.ts', line: 12, match: { column: 6, length: 4 }, group: 'g1' })
    fireEvent.click(within(tree()).getByRole('button', { name: 'Server' })) // fold
    expect(items()).toEqual(['Server', 'main'])
    expect(within(tree()).getByRole('treeitem', { name: /Server/ })).toHaveAttribute('aria-expanded', 'false')
    expect(e().reveal?.line).toBe(12) // folding isn't a jump

    const filter = screen.getByPlaceholderText('Filter symbols')
    fireEvent.change(filter, { target: { value: 'ru' } })
    expect(items()).toEqual(['Server', 'run(): void']) // the match, inside its (folded) class
    fireEvent.change(filter, { target: { value: 'zzz' } })
    expect(screen.getByText('No symbols in this file')).toBeInTheDocument()
    fireEvent.change(filter, { target: { value: '' } })
    expect(items()).toEqual(['Server', 'main'])
    fireEvent.click(within(tree()).getByRole('button', { name: 'Server' })) // unfold
    expect(items()).toHaveLength(4)

    // Another file: its own tree, nothing folded.
    fireEvent.click(within(tree()).getByRole('button', { name: 'Server' }))
    act(() => e().setActive('p:b.ts'))
    expect(within(screen.getByRole('tree')).getAllByRole('treeitem').map((i) => i.textContent)).toEqual(['other'])
    act(() => e().setActive('p:a.ts'))
    expect(items()).toHaveLength(4)
  })
})

describe('symbol icons', () => {
  it('a family per kind', () => {
    const tints = Array.from({ length: 27 }, (_, kind) => symbolIcon(kind).tint)
    expect(new Set(tints).size).toBeGreaterThan(5)
    expect(symbolIcon(4)).toEqual(symbolIcon(22))
    expect(symbolIcon(99).tint).toBe('text-text-secondary')
  })
})
