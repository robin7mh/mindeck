import { beforeEach, describe, expect, it, vi } from 'vitest'

const vim = vi.hoisted(() => {
  const ex = new Map<string, (cm: unknown, params: { argString?: string }) => void>()
  const maps: unknown[][] = []
  const attached: { editor: unknown; status: HTMLElement; disposed: boolean }[] = []
  const VimMode = {
    commands: {} as Record<string, () => void>,
    Vim: {
      map: (...a: unknown[]) => maps.push(a),
      mapclear: () => (maps.length = 0),
      defineEx: (name: string, prefix: string, run: (cm: unknown, params: { argString?: string }) => void) => {
        ex.set(name, run)
        ex.set(prefix, run)
      }
    }
  }
  return {
    ex,
    maps,
    attached,
    module: {
      VimMode,
      initVimMode: (editor: unknown, status: HTMLElement) => {
        status.textContent = '--NORMAL--'
        const a = { editor, status, disposed: false }
        attached.push(a)
        return { dispose: () => (a.disposed = true) }
      }
    }
  }
})
vi.mock('monaco-vim', () => vim.module)

import { applyMappings, attachVim, defineCommands } from '@/features/editor/monaco/vim'
import { useEditorPrefs } from '@/features/editor/prefs'
import { useEditor } from '@/features/editor/store'

const settings = (over: Record<string, unknown>) => useEditorPrefs.setState({ settings: { ...useEditorPrefs.getState().settings, ...over } })

beforeEach(() => {
  vim.attached.length = 0
  settings({ vim: false, vimMappings: undefined })
})

describe('Vim mode', () => {
  it('follows the setting: on with the mode shown, the remappings set (again when they change), off again', () => {
    const status = document.createElement('div')
    const editor = {}
    const detach = attachVim(editor as never, status)
    expect(status.hidden).toBe(true)
    expect(vim.attached).toEqual([])

    const jj = [{ mode: 'insert' as const, before: 'jj', after: '<Esc>' }]
    settings({ vim: true, vimMappings: jj })
    expect(vim.attached).toHaveLength(1)
    expect(status.hidden).toBe(false)
    expect(vim.maps).toEqual([['jj', '<Esc>', 'insert']])
    // Something else changed: the mappings stay as they are.
    settings({ fontSize: 15 })
    expect(vim.attached).toHaveLength(1)
    useEditorPrefs.setState({ snippets: [] }) // not the settings at all
    expect(vim.attached).toHaveLength(1)
    expect(vim.maps).toEqual([['jj', '<Esc>', 'insert']])
    settings({ vimMappings: [{ mode: 'normal', before: '<space>w', after: ':w<CR>' }] })
    expect(vim.maps).toEqual([['<space>w', ':w<CR>', 'normal']])

    settings({ vim: false })
    expect(vim.attached[0].disposed).toBe(true)
    expect([status.hidden, status.textContent]).toEqual([true, ''])
    settings({ vim: true })
    expect(vim.attached).toHaveLength(2)
    detach()
    expect(vim.attached[1].disposed).toBe(true)
    // After detaching, the setting reaches nothing.
    settings({ vim: false })
    settings({ vim: true })
    expect(vim.attached).toHaveLength(2)
    detach()

    applyMappings()
    expect(vim.maps).toEqual([])
  })

  it(':w saves, :q closes the tab (asks when unsaved, :q! doesn’t), :wq / :x save and close; defined once', async () => {
    const save = vi.fn(async () => true)
    const close = vi.fn()
    const requestClose = vi.fn()
    let focused: string | undefined = 'p:a.ts'
    useEditor.setState({ save, close, requestClose, focusedId: () => focused })
    defineCommands()
    defineCommands()
    vim.module.VimMode.commands.save()
    expect(save).toHaveBeenCalledTimes(1)
    vim.ex.get('q')!({}, {})
    expect(requestClose).toHaveBeenCalledWith('p:a.ts')
    vim.ex.get('quit')!({}, { argString: ' !' })
    expect(close).toHaveBeenCalledWith('p:a.ts')
    vim.ex.get('wq')!({}, {})
    await Promise.resolve()
    await Promise.resolve()
    expect(requestClose).toHaveBeenCalledTimes(2)
    save.mockResolvedValueOnce(false) // not saved: stays open
    vim.ex.get('x')!({}, {})
    await Promise.resolve()
    await Promise.resolve()
    expect(requestClose).toHaveBeenCalledTimes(2)
    focused = undefined
    vim.ex.get('q')!({}, {})
    expect(requestClose).toHaveBeenCalledTimes(2)
  })
})
