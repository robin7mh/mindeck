import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModuleId } from '@/types'
import { en } from '@/lib/i18n/en'
import { useOverlays } from '@/lib/overlay'
import { makeLayout, singleLayout } from '@/features/workspace/layout'
import { useWorkspace } from '@/features/workspace/store'
import { MODULE_TYPE, useModuleDrag } from '@/features/workspace/drag'
import { Workspace } from '@/features/workspace/components/Workspace'
import { SplitButton } from '@/features/workspace/components/SplitButton'
import { SplitDemo } from '@/features/workspace/components/SplitDemo'
import { SideNavigation } from '@/components/nav/SideNavigation'
import { useOnboarding } from '@/features/onboarding/store'

const w = en.workspace
const initial = useWorkspace.getState()
const s = () => useWorkspace.getState()
const modules = () => s().layout.panes.map((p) => p.module)
const draw = (id: ModuleId) => <div data-testid={`m-${id}`}>{id}</div>
const transfer = () => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' })

beforeEach(() => {
  useWorkspace.setState(initial, true)
  useModuleDrag.setState({ module: undefined })
  useOverlays.setState({ count: 0 })
  useOnboarding.setState({ open: false })
  // Mac keys (⌘) unless a test says otherwise.
  ;(window as unknown as { mindeck: { platform: string } }).mindeck = { platform: 'darwin' }
})

describe('dragging a module from the side navigation', () => {
  const ui = (onSelect = vi.fn()) =>
    render(
      <>
        <SideNavigation active="core" onSelect={onSelect} />
        <Workspace render={draw} keep={[]} />
      </>
    )

  it('shows where it can go — and opens it in a new pane on the edge it is dropped on', () => {
    ui()
    expect(screen.queryByTestId('drop-core')).toBeNull()
    const dataTransfer = transfer()
    fireEvent.dragStart(screen.getByTitle('Browser'), { dataTransfer })
    expect(dataTransfer.setData).toHaveBeenCalledWith(MODULE_TYPE, 'browser')
    expect(dataTransfer.effectAllowed).toBe('copyMove')
    expect(useOverlays.getState().count).toBe(1) // a page of the browser steps back
    const pane = within(screen.getByTestId('drop-core'))
    for (const side of ['center', 'left', 'right', 'top', 'bottom']) expect(pane.getByTestId(`drop-core-${side}`)).toBeInTheDocument()
    // top and bottom sit between left and right
    expect(pane.getByTestId('drop-core-top').className).toContain('inset-x-1/3')

    const right = pane.getByTestId('drop-core-right')
    const over = transfer()
    fireEvent.dragOver(right, { dataTransfer: over })
    expect(over.dropEffect).toBe('move')
    expect(screen.getByText('New pane on the right')).toBeInTheDocument() // the room it would take lights up
    fireEvent.dragLeave(pane.getByTestId('drop-core-left')) // leaving another zone changes nothing
    expect(screen.getByText('New pane on the right')).toBeInTheDocument()
    fireEvent.dragLeave(right)
    expect(screen.queryByText('New pane on the right')).toBeNull()
    fireEvent.dragEnter(right, { dataTransfer: transfer() })
    fireEvent.drop(right, { dataTransfer: transfer() })
    expect(modules()).toEqual(['core', 'browser'])
    expect(s().layout.focus).toBe('p2')
    expect(useModuleDrag.getState().module).toBeUndefined()
    expect(screen.queryByTestId('drop-core')).toBeNull()
    expect(useOverlays.getState().count).toBe(0)
  })

  it('into a pane: the module takes its place; one on screen already can only swap', () => {
    useWorkspace.setState({ layout: makeLayout('columns', ['core', 'editor']) })
    ui()
    fireEvent.dragStart(screen.getByTitle('Editor'), { dataTransfer: transfer() })
    // Editor is on screen: no new pane for it, only the middle of each pane.
    expect(screen.queryByTestId('drop-editor-top')).toBeNull()
    fireEvent.dragOver(screen.getByTestId('drop-core-center'), { dataTransfer: transfer() })
    expect(screen.getByText('Show Editor here')).toBeInTheDocument()
    fireEvent.drop(screen.getByTestId('drop-core-center'), { dataTransfer: transfer() })
    expect(modules()).toEqual(['editor', 'core'])

    // A module not on screen: the right column of two can stack.
    fireEvent.dragStart(screen.getByTitle('Terminal'), { dataTransfer: transfer() })
    expect(screen.queryByTestId('drop-editor-top')).toBeNull()
    expect(screen.getByTestId('drop-core-top').className).toContain('inset-x-0')
    fireEvent.drop(screen.getByTestId('drop-core-bottom'), { dataTransfer: transfer() })
    expect(modules()).toEqual(['editor', 'core', 'terminal'])
  })

  it('let go anywhere else: the zones go away', () => {
    ui()
    fireEvent.dragStart(screen.getByTitle('Files'), { dataTransfer: transfer() })
    expect(screen.getByTestId('drop-core')).toBeInTheDocument()
    fireEvent.dragEnd(screen.getByTitle('Files'))
    expect(screen.queryByTestId('drop-core')).toBeNull()
    expect(modules()).toEqual(['core'])
  })
})

describe('a module’s menu in the side navigation', () => {
  it('opens it here or in a new pane on the right; ⌘-click goes straight there', () => {
    const onSelect = vi.fn()
    const { unmount } = render(<SideNavigation active="core" onSelect={onSelect} />)
    fireEvent.contextMenu(screen.getByTitle('Terminal'), { clientX: 40, clientY: 80 })
    const menu = screen.getByRole('menu', { name: 'Terminal' })
    expect(menu).toHaveStyle({ left: '40px', top: '80px' })
    expect(useOverlays.getState().count).toBe(1)
    const [here, right] = within(menu).getAllByRole('menuitem')
    expect(here).toHaveFocus()
    expect(right).toHaveTextContent('Open in new pane on the right')
    expect(right).toHaveTextContent('⌘-click')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(right).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' }) // round again
    expect(here).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(right).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'x' })
    fireEvent.click(here)
    expect(onSelect).toHaveBeenCalledWith('terminal')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(screen.getByTitle('Terminal'), { clientX: 40, clientY: 80 })
    fireEvent.click(screen.getByRole('menuitem', { name: /new pane on the right/ }))
    expect(modules()).toEqual(['core', 'terminal'])

    // Two panes: the focused right one has no room on its right — a new pane (below).
    fireEvent.contextMenu(screen.getByTitle('Files'))
    expect(screen.getByRole('menuitem', { name: /Open in a new pane/ })).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('menu')) // inside: stays
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByTitle('Files'))
    fireEvent.keyDown(document, { key: 'a' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(screen.getByTitle('Memory'), { metaKey: true })
    expect(modules()).toEqual(['core', 'terminal', 'memory'])
    fireEvent.click(screen.getByTitle('Memory'), { ctrlKey: true }) // Ctrl is not ⌘ on a Mac
    expect(onSelect).toHaveBeenLastCalledWith('memory')
    unmount()

    // Windows and Linux: Ctrl-click.
    ;(window as unknown as { mindeck: { platform: string } }).mindeck = { platform: 'win32' }
    useWorkspace.setState({ layout: singleLayout('core') })
    render(<SideNavigation active="core" onSelect={onSelect} />)
    fireEvent.click(screen.getByTitle('Agents'), { ctrlKey: true })
    expect(modules()).toEqual(['core', 'agents'])
    fireEvent.contextMenu(screen.getByTitle('Agents'))
    expect(screen.getByRole('menuitem', { name: /Ctrl-click/ })).toBeInTheDocument()
  })
})

describe('the Split button', () => {
  it('splits the screen, focuses the new pane, and stops at four', async () => {
    localStorage.setItem('mindeck.tips.split', '1')
    document.body.innerHTML = ''
    render(
      <>
        <SplitButton />
        <Workspace render={draw} keep={[]} />
      </>
    )
    const button = screen.getByRole('button', { name: w.splitScreen })
    expect(button).toHaveAttribute('title', `${w.splitHint} (⌘\\)`)
    expect(screen.queryByRole('dialog')).toBeNull() // the tip was seen
    fireEvent.click(button)
    expect(modules()).toEqual(['core', 'terminal'])
    await act(() => new Promise((r) => requestAnimationFrame(r)))
    expect(document.activeElement).toBe(document.querySelector('[data-pane-id="p2"]'))
    fireEvent.click(button)
    fireEvent.click(button)
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', w.splitFull)
  })

  it('shows a tip until the screen was split once — or it is dismissed; never over the setup', () => {
    useOnboarding.setState({ open: true })
    const { unmount } = render(<SplitButton />)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => useOnboarding.setState({ open: false }))
    const tip = screen.getByRole('dialog', { name: 'Split screen' })
    expect(within(tip).getByRole('img', { name: en.onboarding.splitDemo })).toBeInTheDocument()
    fireEvent.click(within(tip).getByRole('button', { name: 'Try it (⌘\\)' }))
    expect(modules()).toEqual(['core', 'terminal'])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(localStorage.getItem('mindeck.tips.split')).toBe('1')
    unmount()

    localStorage.clear()
    useWorkspace.setState({ layout: singleLayout('core') })
    render(<SplitButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(localStorage.getItem('mindeck.tips.split')).toBe('1')
  })

  it('without storage: no tip, and nothing breaks', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const { unmount } = render(<SplitButton />)
    expect(screen.queryByRole('dialog')).toBeNull()
    unmount()
    get.mockRestore()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    render(<SplitButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the split picture', () => {
  it('moves — or holds still at the split when the system asks for less motion', () => {
    const { unmount } = render(<SplitDemo className="mt-2" />)
    const picture = screen.getByRole('img', { name: en.onboarding.splitDemo })
    expect(picture.className).toContain('mt-2')
    expect(screen.getByTestId('split-demo-press')).toBeInTheDocument()
    unmount()
    ;(globalThis as unknown as { matchMediaMatches: Record<string, boolean> }).matchMediaMatches['(prefers-reduced-motion: reduce)'] = true
    render(<SplitDemo />)
    expect(screen.getByTestId('split-demo-press')).toHaveStyle({ opacity: '1' })
  })
})
