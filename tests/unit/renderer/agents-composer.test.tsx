import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, installRemote, settle } from './bridge'
import { Composer, type ComposerAgent } from '@/features/agents/components/Composer'
import { loadDraft, promptHistory, rememberPrompt, saveDraft, useComposerPrefs } from '@/features/agents/composerPrefs'
import { fileMentions, loadMentions, rankMentions, tokenAt } from '@/features/agents/mentions'

beforeEach(() => useComposerPrefs.setState({ sendKey: 'enter' }))

const tabs = [
  { id: 't1', url: 'https://docs.example.com/api', title: 'API docs' },
  { id: 't2', url: '', title: 'New tab' },
  { id: 't3', url: 'http://localhost:5173', title: '' }
]
const routes = () => ({
  'scm:files': () => ['src/app.ts', 'src/lib/util.ts', 'README.md'],
  'memory:list': () => [{ path: 'Projects/Plan.md', title: 'Plan', folder: 'Projects' }],
  'browser:state': () => ({ tabs })
})

describe('composer preferences', () => {
  it('remembers sent prompts (newest first, no doubles), drafts per session, the send key', () => {
    expect(promptHistory()).toEqual([])
    rememberPrompt('one')
    rememberPrompt('  ')
    rememberPrompt('two')
    rememberPrompt('one')
    expect(promptHistory()).toEqual(['one', 'two'])
    localStorage.setItem('mindeck.agents.history', '{"not":"a list"}')
    expect(promptHistory()).toEqual([])
    localStorage.setItem('mindeck.agents.history', '["ok", 3]')
    expect(promptHistory()).toEqual(['ok'])

    expect(loadDraft('s1')).toEqual({ text: '', refs: [] })
    saveDraft('s1', { text: 'half', refs: [{ kind: 'file', path: 'a.ts' }] })
    expect(loadDraft('s1')).toEqual({ text: 'half', refs: [{ kind: 'file', path: 'a.ts' }] })
    saveDraft('s1', { text: '', refs: [] })
    expect(localStorage.getItem('mindeck.agents.draft.s1')).toBeNull()
    localStorage.setItem('mindeck.agents.draft.s2', '{"text":5,"refs":"x"}')
    expect(loadDraft('s2')).toEqual({ text: '', refs: [] })

    useComposerPrefs.getState().setSendKey('mod-enter')
    expect(localStorage.getItem('mindeck.agents.sendKey')).toBe('"mod-enter"')
  })

  it('reads the stored send key at start; storage that fails is no storage', async () => {
    localStorage.setItem('mindeck.agents.sendKey', '"mod-enter"')
    vi.resetModules()
    expect((await import('@/features/agents/composerPrefs')).useComposerPrefs.getState().sendKey).toBe('mod-enter')
    localStorage.setItem('mindeck.agents.sendKey', '"weird"')
    vi.resetModules()
    expect((await import('@/features/agents/composerPrefs')).useComposerPrefs.getState().sendKey).toBe('enter')

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    expect(promptHistory()).toEqual([])
    expect(() => rememberPrompt('x')).not.toThrow()
  })
})

describe('@ and / suggestions', () => {
  it('folders come from the file list; tokens are found right before the caret', () => {
    expect(fileMentions(['a/b/c.ts', 'a/d.ts', 'e.ts']).map((m) => [m.kind, m.path, m.label, m.detail])).toEqual([
      ['folder', 'a', 'a/', ''],
      ['folder', 'a/b', 'b/', 'a/'],
      ['file', 'a/b/c.ts', 'c.ts', 'a/b/'],
      ['file', 'a/d.ts', 'd.ts', 'a/'],
      ['file', 'e.ts', 'e.ts', '']
    ])
    expect(tokenAt('see @src/ap', 11)).toEqual({ trigger: '@', query: 'src/ap', start: 4 })
    expect(tokenAt('@', 1)).toEqual({ trigger: '@', query: '', start: 0 })
    expect(tokenAt('mail me@home', 12)).toBeNull()
    expect(tokenAt('see @a b', 8)).toBeNull()
    expect(tokenAt('/rev', 4)).toEqual({ trigger: '/', query: 'rev', start: 0 })
    expect(tokenAt('/review now', 11)).toBeNull()
    expect(tokenAt('a /b', 4)).toBeNull()
  })

  it('loads files, notes and web tabs (desktop); a failing source is left out', async () => {
    installBridge(routes())
    const all = await loadMentions('p1')
    expect(all.filter((m) => m.kind !== 'file' && m.kind !== 'folder')).toEqual([
      { kind: 'note', path: 'Projects/Plan.md', label: 'Plan', detail: 'Projects' },
      { kind: 'tab', path: 'https://docs.example.com/api', label: 'API docs', detail: 'https://docs.example.com/api' },
      { kind: 'tab', path: 'http://localhost:5173', label: 'http://localhost:5173', detail: 'http://localhost:5173' }
    ])
    expect(rankMentions(all, 'util').map((m) => m.path)).toEqual(['src/lib/util.ts'])
    expect(rankMentions(all, 'plan')[0].path).toBe('Projects/Plan.md')
    expect(rankMentions(all, '')).toHaveLength(all.length)
    expect(rankMentions(all, 'zzz')).toEqual([])

    installBridge({ 'scm:files': () => Promise.reject(new Error('x')), 'memory:list': () => Promise.reject(new Error('x')), 'browser:state': () => Promise.reject(new Error('x')) })
    expect(await loadMentions('p1')).toEqual([])
    delete (window as { mindeck?: unknown }).mindeck
    installRemote(routes()) // the web UI has no browser
    expect((await loadMentions('p1')).some((m) => m.kind === 'tab')).toBe(false)
  })
})

describe('Composer in an agent session', () => {
  const agent = (over: Partial<ComposerAgent> = {}): ComposerAgent => ({
    sessionId: 's1',
    projectId: 'p1',
    commands: [
      { name: 'review', description: 'Review a pull request', hint: 'PR' },
      { name: 'compact', description: 'Summarize' }
    ],
    images: true,
    ...over
  })
  const props = (over: Partial<ComposerAgent> = {}) => ({
    running: false,
    sending: false,
    placeholder: 'Message…',
    agent: agent(over),
    onSend: vi.fn(async () => true),
    onStop: vi.fn()
  })
  const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement
  const type = (value: string) => fireEvent.change(box(), { target: { value } })
  const key = (k: string, opts: Record<string, unknown> = {}) => fireEvent.keyDown(box(), { key: k, ...opts })
  const image = (name = 'shot.png', type = 'image/png', bytes = 3) => new File([new Uint8Array(bytes).fill(1)], name, { type })

  it('@ references files, folders, notes and tabs as chips; the agent gets them with the text', async () => {
    const bridge = installBridge(routes())
    const p = props()
    render(<Composer {...p} />)
    type('Look at @')
    expect(screen.getByText('Looking for files, notes and tabs…')).toBeInTheDocument()
    await act(settle)
    expect(screen.getByRole('listbox', { name: 'Files, notes and tabs' })).toBeInTheDocument()
    type('Look at @util')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    key('Enter')
    expect(box()).toHaveValue('Look at ')
    expect(screen.getByLabelText('Remove util.ts')).toBeInTheDocument()
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))))

    // arrows move, Tab picks; a pick twice stays one chip
    type('Look at @src')
    key('ArrowDown')
    key('ArrowUp')
    key('ArrowUp')
    expect(screen.getAllByRole('option').at(-1)).toHaveAttribute('aria-selected', 'true')
    key('ArrowDown')
    key('Tab')
    expect(screen.getByLabelText('Remove src/')).toBeInTheDocument()
    type('Look at @util')
    fireEvent.mouseEnter(screen.getByRole('option'))
    fireEvent.mouseDown(screen.getByRole('option'))
    expect(screen.getAllByLabelText('Remove util.ts')).toHaveLength(1)
    // Escape closes the list; leaving the field too
    type('Look at @Plan')
    key('Escape')
    expect(screen.queryByRole('listbox')).toBeNull()
    type('Look at @API')
    fireEvent.mouseDown(screen.getByRole('option', { name: /API docs/ }))
    type('Look at @x')
    fireEvent.blur(box())
    expect(screen.queryByRole('listbox')).toBeNull()

    type('Look at ')
    fireEvent.click(screen.getByLabelText('Remove src/'))
    key('Enter')
    await act(settle)
    expect(p.onSend).toHaveBeenCalledWith('Look at ', {
      refs: [
        { kind: 'file', path: 'src/lib/util.ts', label: 'util.ts' },
        { kind: 'tab', path: 'https://docs.example.com/api', label: 'API docs' }
      ],
      images: []
    })
    expect(box()).toHaveValue('')
    expect(screen.queryByLabelText('Remove util.ts')).toBeNull()
    // each new `@` looks again (files come and go)
    expect(bridge.invoke.mock.calls.filter(([ch]) => ch === 'scm:files').length).toBeGreaterThan(1)
  })

  it('/ suggests the agent\'s commands (none without any)', async () => {
    installBridge(routes())
    const { unmount } = render(<Composer {...props()} />)
    type('/re')
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument()
    expect(screen.getByRole('option')).toHaveTextContent('/reviewReview a pull request')
    key('Enter')
    expect(box()).toHaveValue('/review ')
    type('/nothing')
    expect(screen.queryByRole('listbox')).toBeNull()
    key('Escape') // the token is still there: Escape just drops it
    unmount()
    render(<Composer {...props({ commands: [], sessionId: 's2' })} />)
    type('/re')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('images: pasted, dropped or attached, as thumbnails; checked for type, size and number', async () => {
    installBridge(routes())
    const p = props()
    const { container } = render(<Composer {...p} />)
    // pasted text stays the textarea's business
    const pasteText = fireEvent.paste(box(), { clipboardData: { files: [] } })
    expect(pasteText).toBe(true)
    fireEvent.paste(box(), { clipboardData: { files: [image()] } })
    await act(settle)
    expect(screen.getByAltText('shot.png')).toHaveAttribute('src', 'data:image/png;base64,AQEB')
    fireEvent.paste(box(), { clipboardData: { files: [image('v.svg', 'image/svg+xml')] } })
    await act(settle)
    expect(screen.getByRole('alert')).toHaveTextContent('v.svg is not a PNG, JPEG, GIF or WebP image.')
    type('x') // typing clears the error
    expect(screen.queryByRole('alert')).toBeNull()

    const root = container.firstElementChild!
    expect(fireEvent.dragOver(root)).toBe(false) // a drop is welcome
    fireEvent.drop(root, { dataTransfer: { files: [image('a.pdf', 'application/pdf')] } })
    await act(settle)
    expect(screen.getByRole('alert')).toHaveTextContent('a.pdf is not')
    fireEvent.drop(root, { dataTransfer: { files: [] } }) // nothing dropped
    fireEvent.drop(root, { dataTransfer: { files: [new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' })] } })
    await act(settle)
    expect(screen.getByRole('alert')).toHaveTextContent('huge.png is larger than 5 MB.')
    const third = new File([new Uint8Array(3 * 1024 * 1024)], 'third.png', { type: 'image/png' })
    fireEvent.drop(root, { dataTransfer: { files: [third, third] } })
    await act(settle)
    expect(screen.getByRole('alert')).toHaveTextContent('The images together may be at most 5 MB.')
    expect(screen.getAllByRole('img')).toHaveLength(2)
    fireEvent.click(screen.getByLabelText('Remove image third.png'))
    fireEvent.drop(root, { dataTransfer: { files: Array.from({ length: 6 }, (_, i) => image(`n${i}.png`)) } })
    await act(settle)
    expect(screen.getByRole('alert')).toHaveTextContent('At most 6 images per message.')
    expect(screen.getAllByRole('img')).toHaveLength(6)

    // the attach button opens the file picker
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByLabelText('Attach an image'))
    expect(click).toHaveBeenCalled()
    for (const img of screen.getAllByRole('img').slice(1)) fireEvent.click(screen.getByLabelText(`Remove image ${img.getAttribute('alt')}`))
    fireEvent.change(screen.getByTestId('image-input'), { target: { files: [image('picked.jpg', 'image/jpeg')] } })
    await act(settle)
    expect(screen.getByAltText('picked.jpg')).toBeInTheDocument()

    type('')
    fireEvent.click(screen.getByLabelText('Send'))
    await act(settle)
    expect(p.onSend).toHaveBeenCalledWith('', {
      refs: [],
      images: [
        { name: 'shot.png', mimeType: 'image/png', data: 'AQEB' },
        { name: 'picked.jpg', mimeType: 'image/jpeg', data: 'AQEB' }
      ]
    })
    expect(screen.queryAllByRole('img')).toHaveLength(0)
  })

  it('an agent without images says so; an unreadable image too', async () => {
    installBridge(routes())
    const { unmount } = render(<Composer {...props({ images: false })} />)
    expect(screen.queryByLabelText('Attach an image')).toBeNull()
    fireEvent.paste(box(), { clipboardData: { files: [image()] } })
    await act(settle)
    expect(screen.getByRole('alert')).toHaveTextContent('This agent does not take images.')
    unmount()

    render(<Composer {...props({ sessionId: 's3' })} />)
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>)
    })
    fireEvent.paste(box(), { clipboardData: { files: [image('bad.png')] } })
    await act(settle)
    expect(screen.getByRole('alert')).toHaveTextContent('bad.png could not be read.')
  })

  it('↑/↓ bring back earlier prompts; the draft of each session stays until it is sent', async () => {
    installBridge(routes())
    rememberPrompt('older')
    rememberPrompt('newer')
    const p = props()
    const { unmount } = render(<Composer {...p} />)
    key('ArrowDown') // nothing newer
    key('ArrowUp')
    expect(box()).toHaveValue('newer')
    key('ArrowUp')
    expect(box()).toHaveValue('older')
    key('ArrowUp') // the oldest
    expect(box()).toHaveValue('older')
    key('ArrowDown')
    expect(box()).toHaveValue('newer')
    key('ArrowDown')
    expect(box()).toHaveValue('')
    type('my own\ntext')
    key('ArrowUp') // edited text is never replaced
    expect(box()).toHaveValue('my own\ntext')
    unmount()

    // the draft came back with the session (a reference without a label shows its path)
    saveDraft('s1', { ...loadDraft('s1'), refs: [{ kind: 'file', path: 'src/a.ts' }] })
    render(<Composer {...p} />)
    expect(box()).toHaveValue('my own\ntext')
    fireEvent.click(screen.getByLabelText('Remove src/a.ts'))
    type('line one\nline two')
    box().setSelectionRange(17, 17) // on the last line
    key('ArrowUp')
    expect(box()).toHaveValue('line one\nline two')
    type('')
    key('ArrowUp')
    expect(box()).toHaveValue('newer')
    type('newer\nmore')
    key('Enter')
    await act(settle)
    expect(promptHistory()[0]).toBe('newer\nmore')
    expect(loadDraft('s1')).toEqual({ text: '', refs: [] })
    type('a\nb')
    box().setSelectionRange(0, 0)
    key('ArrowUp') // edited
    key('ArrowDown')
    expect(box()).toHaveValue('a\nb')
  })

  it('⌘Enter sends when set so — Enter then breaks the line; composing text never sends', async () => {
    installBridge(routes())
    useComposerPrefs.setState({ sendKey: 'mod-enter' })
    const p = props()
    render(<Composer {...p} />)
    expect(screen.getByText('⌘/Ctrl+Enter to send · Enter new line')).toBeInTheDocument()
    type('hi')
    key('Enter')
    key('Enter', { metaKey: true, isComposing: true })
    expect(p.onSend).not.toHaveBeenCalled()
    key('Enter', { metaKey: true })
    await act(settle)
    expect(p.onSend).toHaveBeenCalledTimes(1)
    type('again')
    key('Enter', { ctrlKey: true })
    await act(settle)
    expect(p.onSend).toHaveBeenCalledTimes(2)
  })

  it('without an agent: no drop zone, pasting stays plain', () => {
    const { container } = render(<Composer running={false} sending={false} placeholder="x" onSend={vi.fn(async () => true)} onStop={vi.fn()} />)
    const root = container.firstElementChild!
    expect(fireEvent.dragOver(root)).toBe(true)
    fireEvent.drop(root, { dataTransfer: { files: [image()] } })
    expect(fireEvent.paste(box(), { clipboardData: { files: [image()] } })).toBe(true)
    type('@x')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
