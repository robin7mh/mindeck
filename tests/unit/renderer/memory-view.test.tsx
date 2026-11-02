import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, installRemote } from './bridge'
import type { Note, VaultStatus } from '@shared/types/memory'

// Children are covered by their own tests — here they only expose their props.
const seen = vi.hoisted(() => ({ list: {} as Record<string, unknown>, graph: {} as Record<string, unknown>, editor: {} as Record<string, unknown> }))
vi.mock('@/features/memory/components/NoteList', () => ({
  NoteList: (p: Record<string, unknown>) => {
    seen.list = p
    return <div>NOTE-LIST</div>
  }
}))
vi.mock('@/features/memory/components/GraphView', async (orig) => ({
  ...(await orig<typeof import('@/features/memory/components/GraphView')>()),
  GraphView: (p: Record<string, unknown>) => {
    seen.graph = p
    return <div>GRAPH</div>
  }
}))
vi.mock('@/features/memory/components/NoteEditor', () => ({
  NoteEditor: (p: Record<string, unknown>) => {
    seen.editor = p
    return <div>EDITOR</div>
  }
}))

import { MemoryView } from '@/features/memory/components/MemoryView'
import { PaneContext } from '@/features/workspace/pane'
import { useMemory } from '@/features/memory/store'

const initial = useMemory.getState()
const status = (over: Partial<VaultStatus> = {}): VaultStatus => ({
  root: '/Users/robin/Mindeck/vault',
  defaultRoot: '/Users/robin/Mindeck/vault',
  name: 'vault',
  isDefault: true,
  exists: true,
  noteCount: 3,
  graphStyle: { mode: 'single', color: 'pink' },
  dailyNotes: { folder: 'Daily', template: '' },
  ...over
})
const note = { path: 'A.md', title: 'A', body: '' } as Note

/** Every store action replaced by a spy, so the view's wiring is observable. */
function spyActions() {
  const names = [
    'init', 'onChanged', 'save', 'setGraphStyle', 'setView', 'startCreate', 'clearError', 'createVault', 'pickVault',
    'reveal', 'setVault', 'search', 'open', 'cancelCreate', 'submitCreate', 'moveNote', 'moveFolder', 'openOrCreate', 'setDraft',
    'setMode', 'rename', 'link', 'unlink', 'trash', 'openDaily', 'setDailyNotes', 'setSource', 'renderTemplate', 'attach', 'loadImage'
  ] as const
  const spies = Object.fromEntries(names.map((n) => [n, vi.fn(async () => {})])) as Record<(typeof names)[number], ReturnType<typeof vi.fn>>
  useMemory.setState(spies as never)
  return spies
}

beforeEach(() => useMemory.setState(initial, true))

describe('MemoryView', () => {
  it('loading, then nothing while idle; inits, follows changes, saves on leave', () => {
    const bridge = installBridge()
    const a = spyActions()
    useMemory.setState({ loading: true })
    const { unmount } = render(<MemoryView />)
    expect(screen.getByText('Loading memory…')).toBeInTheDocument()
    expect(a.init).toHaveBeenCalled()
    act(() => bridge.emit('memory:changed', { paths: ['A.md'] }))
    expect(a.onChanged).toHaveBeenCalledWith({ paths: ['A.md'] })
    act(() => useMemory.setState({ loading: false }))
    expect(screen.queryByText('Loading memory…')).toBeNull()
    unmount()
    expect(a.save).toHaveBeenCalled()
  })

  it('in a browser: no Finder button, the vault is chosen with the folder browser', async () => {
    installRemote({ 'fs:dirs': () => ({ path: '/srv/notes', parent: '/srv', home: '/root', dirs: [] }) })
    const a = spyActions()
    useMemory.setState({ status: status() })
    render(<MemoryView />)
    expect(screen.queryByLabelText('Show vault in Finder')).toBeNull()
    fireEvent.click(screen.getByLabelText('Open another vault'))
    expect(a.pickVault).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByText('Use as vault'))
    expect(a.setVault).toHaveBeenCalledWith('/srv/notes')
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByLabelText('Open another vault'))
    fireEvent.click(await screen.findByLabelText('Close'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('vault setup: create, pick, and a missing custom vault', () => {
    installBridge()
    const a = spyActions()
    useMemory.setState({ status: status({ exists: false }) })
    const { rerender } = render(<MemoryView />)
    expect(screen.queryByText('New note')).toBeNull() // no header actions yet
    fireEvent.click(screen.getByText('Create Mindeck vault'))
    fireEvent.click(screen.getByText('Open existing vault…'))
    expect(a.createVault).toHaveBeenCalled()
    expect(a.pickVault).toHaveBeenCalled()
    expect(screen.queryByText(/Vault not found/)).toBeNull()

    act(() => useMemory.setState({ status: status({ exists: false, isDefault: false, root: '/Volumes/X/vault' }) }))
    rerender(<MemoryView />)
    expect(screen.getByText('Vault not found: /Volumes/X/vault')).toBeInTheDocument()
  })

  it('graph view: style control, view switch, new note, vault actions, error banner', () => {
    installBridge()
    const a = spyActions()
    useMemory.setState({ status: status(), view: 'graph', graph: { nodes: [], edges: [] }, notes: [], error: 'boom' })
    render(<MemoryView />)
    expect(screen.getByText('GRAPH')).toBeInTheDocument()
    expect(screen.getByText('~/Mindeck/vault')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(a.clearError).toHaveBeenCalled()

    fireEvent.click(screen.getByText('Colorful'))
    expect(a.setGraphStyle).toHaveBeenCalledWith({ mode: 'colorful', color: 'pink' })
    fireEvent.click(screen.getByText('Note'))
    expect(a.setView).toHaveBeenCalledWith('note')
    fireEvent.click(screen.getByText('Graph'))
    expect(a.setView).toHaveBeenCalledWith('graph')
    fireEvent.click(screen.getByText('New note'))
    expect(a.startCreate).toHaveBeenCalledWith('note', '')
    fireEvent.click(screen.getByLabelText('Show vault in Finder'))
    fireEvent.click(screen.getByLabelText('Open another vault'))
    expect(a.reveal).toHaveBeenCalled()
    expect(a.pickVault).toHaveBeenCalled()

    const g = seen.graph as { onOpen(p: string): void; onOpenGhost(t: string): void; style: unknown }
    expect(g.style).toEqual({ mode: 'single', color: 'pink' })
    g.onOpen('A.md')
    g.onOpenGhost('Ghost')
    expect(a.open).toHaveBeenCalledWith('A.md')
    expect(a.openOrCreate).toHaveBeenCalledWith('Ghost')

    const l = seen.list as Record<string, (...args: string[]) => void>
    l.onOpen('B.md')
    l.onSubmitCreate('Neu')
    l.onMoveNote('A.md', 'X')
    l.onMoveFolder('X', 'Y')
    expect(a.open).toHaveBeenCalledWith('B.md')
    expect(a.submitCreate).toHaveBeenCalledWith('Neu')
    expect(a.moveNote).toHaveBeenCalledWith('A.md', 'X')
    expect(a.moveFolder).toHaveBeenCalledWith('X', 'Y')
  })

  it('note view: the editor and its callbacks; default style; Windows home shortening', () => {
    const a = spyActions()
    useMemory.setState({
      status: { ...status({ root: 'C:\\Users\\robin\\vault' }), graphStyle: undefined as never },
      view: 'note',
      note,
      notes: []
    })
    render(<MemoryView />)
    expect(screen.getByText('EDITOR')).toBeInTheDocument()
    expect(screen.getByText('~\\vault')).toBeInTheDocument()
    expect(screen.queryByText('Colorful')).toBeNull() // style control only in graph view
    expect((seen.list as { style: unknown }).style).toEqual({ mode: 'colorful', color: 'cyan' })

    const e = seen.editor as Record<string, (...args: string[]) => void>
    e.onSave()
    e.onRename('B')
    e.onOpen('C.md')
    e.onOpenOrCreate('D')
    e.onLink('E.md')
    e.onUnlink('A.md', 'E.md')
    e.onTrash()
    expect(a.save).toHaveBeenCalled()
    expect(a.rename).toHaveBeenCalledWith('B')
    expect(a.open).toHaveBeenCalledWith('C.md')
    expect(a.openOrCreate).toHaveBeenCalledWith('D')
    expect(a.link).toHaveBeenCalledWith('E.md')
    expect(a.unlink).toHaveBeenCalledWith('A.md', 'E.md')
    expect(a.trash).toHaveBeenCalledWith('A.md')
  })

  it('graph view without a graph yet, and no note open', () => {
    spyActions()
    useMemory.setState({ status: status(), view: 'graph', graph: undefined, note: undefined, notes: [] })
    const { rerender } = render(<MemoryView />)
    expect(screen.getByText('Select a note, or create one')).toBeInTheDocument()
    act(() => useMemory.setState({ view: 'graph', note }))
    rerender(<MemoryView />)
    expect(screen.getByText('EDITOR')).toBeInTheDocument()
    act(() => useMemory.setState({ graph: { nodes: [], edges: [] } }))
    rerender(<MemoryView />)
    expect((seen.graph as { activeId?: string }).activeId).toBe('A.md')
  })
})

describe('MemoryView · daily notes and templates', () => {
  const meta = (path: string) => ({ path, title: path.replace(/^.*\//, '').replace(/\.md$/, ''), folder: '', tags: [], modifiedAt: '', linkCount: 0 })

  it('opens today with the button and ⌘⇧D (not with plain ⌘D)', () => {
    const a = spyActions()
    useMemory.setState({ status: status(), view: 'graph', graph: { nodes: [], edges: [] }, notes: [] })
    const { unmount } = render(<MemoryView />)
    expect(screen.queryByLabelText('New note from template')).toBeNull() // no templates yet
    fireEvent.click(screen.getByText('Today'))
    fireEvent.keyDown(window, { key: 'D', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'd', metaKey: true })
    fireEvent.keyDown(window, { key: 'x', metaKey: true, shiftKey: true })
    expect(a.openDaily).toHaveBeenCalledTimes(3)
    unmount()
    fireEvent.keyDown(window, { key: 'd', metaKey: true, shiftKey: true })
    expect(a.openDaily).toHaveBeenCalledTimes(3)
    // Next to another module, without the focus: not Memory's key.
    render(
      <PaneContext.Provider value={{ focused: false }}>
        <MemoryView />
      </PaneContext.Provider>
    )
    fireEvent.keyDown(window, { key: 'd', metaKey: true, shiftKey: true })
    expect(a.openDaily).toHaveBeenCalledTimes(3)
  })

  it('starts a note from a template and hands templates and editor actions to the editor', () => {
    const a = spyActions()
    const notes = [meta('Templates/Projekt.md'), meta('Templates/Tag.md'), meta('Plan.md')]
    useMemory.setState({ status: status(), view: 'note', note, notes, source: true })
    render(<MemoryView />)
    fireEvent.click(screen.getByLabelText('New note from template'))
    expect(screen.getByRole('menu', { name: 'New note from template' })).toBeInTheDocument()
    fireEvent.mouseDown(document.body) // a click elsewhere closes it
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByLabelText('New note from template'))
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Tag' }))
    expect(a.startCreate).toHaveBeenCalledWith('note', '', 'Templates/Tag.md')
    expect(screen.queryByRole('menu')).toBeNull()

    const e = seen.editor as Record<string, unknown>
    expect((e.templates as { path: string }[]).map((n) => n.path)).toEqual(['Templates/Projekt.md', 'Templates/Tag.md'])
    expect(e.source).toBe(true)
    expect(e.onSource).toBe(a.setSource)
    expect(e.onInsertTemplate).toBe(a.renderTemplate)
    expect(e.onAttach).toBe(a.attach)
    expect(e.loadImage).toBe(a.loadImage)
  })

  it('sets where daily notes go and their template', async () => {
    installBridge()
    const a = spyActions()
    useMemory.setState({ status: status({ dailyNotes: { folder: 'Journal', template: '' } }), view: 'graph', graph: { nodes: [], edges: [] }, notes: [meta('Templates/Tag.md')], folders: ['Ich', 'Templates'] })
    render(<MemoryView />)
    fireEvent.click(screen.getByRole('button', { name: 'Daily notes' }))
    const dialog = screen.getByRole('dialog', { name: 'Daily notes' })
    expect(dialog).toHaveTextContent('Notes in “Templates/” are templates')
    fireEvent.click(screen.getByRole('combobox', { name: 'Folder for daily notes' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Vault root', 'Journal', 'Ich', 'Templates'])
    fireEvent.click(screen.getByRole('option', { name: 'Ich' }))
    expect(a.setDailyNotes).toHaveBeenCalledWith({ folder: 'Ich', template: '' })
    // Picking in the (portaled) menu kept the panel open.
    fireEvent.click(screen.getByRole('combobox', { name: 'Template' }))
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Tag' }))
    fireEvent.click(screen.getByRole('option', { name: 'Tag' }))
    expect(a.setDailyNotes).toHaveBeenCalledWith({ folder: 'Journal', template: 'Templates/Tag.md' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Daily notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Daily notes' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
