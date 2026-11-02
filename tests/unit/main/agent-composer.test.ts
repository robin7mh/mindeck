import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { acpPrompt, attachments, checkInput, claudePrompt, resolveRefs, saveImages, type ResolvedRef } from '../../../electron/main/services/agents/input'
import { acpCommands, grantKey, KIND_TITLES, sessionControls } from '../../../electron/main/services/agents/acp'
import { CLAUDE_COMMANDS, claudeArgs } from '../../../electron/main/services/agents/claudeLaunch'
import { base64Bytes, MAX_IMAGE_BYTES, type ComposerImage } from '../../../src/shared/types/composer'
import { CLAUDE_MODELS, CLAUDE_MODES } from '../../../src/shared/types/claude'

const png = (bytes = 3, name = 'shot.png'): ComposerImage => ({ name, mimeType: 'image/png', data: Buffer.alloc(bytes, 1).toString('base64') })

describe('composer input → agents', () => {
  it('counts the bytes behind base64', () => {
    expect([1, 2, 3, 4].map((n) => base64Bytes(Buffer.alloc(n).toString('base64')))).toEqual([1, 2, 3, 4])
  })

  it('refuses too many references or images, foreign types and too large images', () => {
    expect(() => checkInput([], [png()])).not.toThrow()
    expect(() => checkInput(Array.from({ length: 41 }, () => ({ kind: 'file' as const, path: 'a' })), [])).toThrow(/At most 40 references/)
    expect(() => checkInput([], Array.from({ length: 7 }, () => png()))).toThrow(/At most 6 images/)
    expect(() => checkInput([], [{ ...png(), mimeType: 'image/svg+xml' as never }])).toThrow(expect.objectContaining({ code: 'bad-input' }))
    expect(() => checkInput([], [png(MAX_IMAGE_BYTES + 1, 'big.png')])).toThrow(expect.objectContaining({ code: 'too-large', message: 'big.png is larger than 5 MB' }))
    const half = png(MAX_IMAGE_BYTES / 2 + 10)
    expect(() => checkInput([], [half, half])).toThrow(/larger than 5 MB together/)
  })

  it('resolves references inside their roots: files and folders in the session, notes in the vault, tabs on the web', async () => {
    const cwd = await tempDir()
    const vault = await tempDir()
    await mkdir(join(cwd, 'src'))
    await writeFile(join(cwd, 'src', 'a.ts'), 'x')
    const root = async () => vault
    const refs = await resolveRefs(
      [
        { kind: 'file', path: 'src/a.ts' },
        { kind: 'folder', path: 'src', label: 'Sources' },
        { kind: 'note', path: 'Projects/Plan.md' },
        { kind: 'note', path: 'Ideas.md', label: ' My ideas ' },
        { kind: 'tab', path: 'https://example.com/docs', label: 'Docs' },
        { kind: 'tab', path: 'http://localhost:5173' }
      ],
      cwd,
      root
    )
    expect(refs.map(({ kind, path, label }) => [kind, path, label])).toEqual([
      ['file', 'src/a.ts', 'a.ts'],
      ['folder', 'src', 'Sources'],
      ['note', join(vault, 'Projects/Plan.md'), 'Plan'],
      ['note', join(vault, 'Ideas.md'), 'My ideas'],
      ['tab', 'https://example.com/docs', 'Docs'],
      ['tab', 'http://localhost:5173/', 'http://localhost:5173/']
    ])
    expect(refs[0].abs).toBe(join(cwd, 'src', 'a.ts'))

    await expect(resolveRefs([{ kind: 'file', path: '../outside.ts' }], cwd, root)).rejects.toMatchObject({ code: 'outside-project' })
    await expect(resolveRefs([{ kind: 'folder', path: '.' }], cwd, root)).rejects.toMatchObject({ code: 'bad-input' })
    await expect(resolveRefs([{ kind: 'note', path: '../../etc/passwd' }], cwd, root)).rejects.toMatchObject({ code: 'outside-project' })
    await expect(resolveRefs([{ kind: 'note', path: 'a.md' }], cwd, async () => undefined)).rejects.toMatchObject({ code: 'no-vault' })
    await expect(resolveRefs([{ kind: 'tab', path: 'file:///etc/passwd' }], cwd, root)).rejects.toMatchObject({ code: 'bad-input' })
    await expect(resolveRefs([{ kind: 'tab', path: 'not a url' }], cwd, root)).rejects.toMatchObject({ code: 'bad-input' })
  })

  it('a link out of the session folder is refused', async () => {
    const cwd = await tempDir()
    const other = await tempDir()
    await symlink(other, join(cwd, 'escape'), 'dir')
    await expect(resolveRefs([{ kind: 'folder', path: 'escape' }], cwd, async () => undefined)).rejects.toMatchObject({ code: 'outside-project' })
  })

  const refs: ResolvedRef[] = [
    { kind: 'file', path: 'src/a.ts', abs: '/p/src/a.ts', label: 'a.ts' },
    { kind: 'folder', path: 'my docs', abs: '/p/my docs', label: 'my docs' },
    { kind: 'note', path: '/vault/Plan.md', abs: '/vault/Plan.md', label: 'Plan' },
    { kind: 'tab', path: 'https://example.com/', label: 'Example' }
  ]

  it('Claude Code: @ mentions on a line of their own (quoted with spaces), tabs as a line with the URL', () => {
    expect(claudePrompt('Fix it', [], [])).toBe('Fix it')
    expect(claudePrompt('Fix it  ', refs, ['/tmp/s1/x.png'])).toBe(
      'Fix it\n\n@src/a.ts @"my docs/" @/vault/Plan.md @/tmp/s1/x.png\n\nBrowser tab: Example <https://example.com/>'
    )
    expect(claudePrompt('', [refs[3]], [])).toBe('Browser tab: Example <https://example.com/>')
    expect(claudePrompt('', [], ['/tmp/a b/x.png'])).toBe('@"/tmp/a b/x.png"')
  })

  it('Claude Code reads images from files in the session\'s temp folder', async () => {
    const dir = join(await tempDir(), 's1')
    expect(await saveImages(dir, [])).toEqual([])
    const [a, b] = await saveImages(dir, [png(3), { name: 'p.jpg', mimeType: 'image/jpeg', data: Buffer.from('jpg').toString('base64') }])
    expect(a).toMatch(/\.png$/)
    expect(b).toMatch(/\.jpg$/)
    expect(await readFile(a)).toEqual(Buffer.alloc(3, 1))
    expect(await readFile(b, 'utf8')).toBe('jpg')
    expect(await readdir(dir)).toHaveLength(2)
    if (process.platform !== 'win32') expect((await stat(a)).mode & 0o777).toBe(0o600)
  })

  it('ACP: text, resource links, embedded notes when the agent takes them, images when it takes them', async () => {
    const vault = await tempDir()
    await writeFile(join(vault, 'Plan.md'), '# Plan')
    await writeFile(join(vault, 'Huge.md'), 'x'.repeat(100_001))
    const note = (name: string): ResolvedRef => ({ kind: 'note', path: join(vault, name), abs: join(vault, name), label: name.slice(0, -3) })
    const uri = (p: string) => pathToFileURL(p).href

    expect(await acpPrompt('Hi', [refs[0], refs[1], refs[3]], [], {})).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'resource_link', uri: uri('/p/src/a.ts'), name: 'src/a.ts' },
      { type: 'resource_link', uri: uri('/p/my docs'), name: 'my docs/' },
      { type: 'resource_link', uri: 'https://example.com/', name: 'Example', title: 'Example' }
    ])
    // notes: embedded with embedded context — unless unreadable or too large
    expect(await acpPrompt(' ', [note('Plan.md'), note('Gone.md'), note('Huge.md')], [png()], { embeddedContext: true, image: true })).toEqual([
      { type: 'resource', resource: { uri: uri(join(vault, 'Plan.md')), mimeType: 'text/markdown', text: '# Plan' } },
      { type: 'resource_link', uri: uri(join(vault, 'Gone.md')), name: 'Gone' },
      { type: 'resource_link', uri: uri(join(vault, 'Huge.md')), name: 'Huge' },
      { type: 'image', mimeType: 'image/png', data: png().data }
    ])
    expect(await acpPrompt('x', [note('Plan.md')], [], {})).toEqual([
      { type: 'text', text: 'x' },
      { type: 'resource_link', uri: uri(join(vault, 'Plan.md')), name: 'Plan' }
    ])
    await expect(acpPrompt('x', [], [png()], { image: false })).rejects.toMatchObject({ code: 'images-unsupported' })
  })

  it('chips for the chat: paths for files, names for the rest', () => {
    expect(attachments([], [])).toBeUndefined()
    expect(attachments(refs, [png()])).toEqual([
      { kind: 'file', label: 'src/a.ts' },
      { kind: 'folder', label: 'my docs' },
      { kind: 'note', label: 'Plan' },
      { kind: 'tab', label: 'Example' },
      { kind: 'image', label: 'shot.png' }
    ])
  })
})

describe('ACP models, modes, commands, grants', () => {
  it('grants are keyed by the tool kind; every kind has a title', () => {
    expect(grantKey('edit')).toBe('edit')
    expect(grantKey(undefined)).toBe('other')
    expect(grantKey(null)).toBe('other')
    expect(KIND_TITLES.execute).toBe('Run command')
  })

  it('config options first: model and mode selects (grouped or flat)', () => {
    const { patch, controls } = sessionControls({
      configOptions: [
        { id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: true, category: 'thought_level' } as never,
        {
          id: 'm',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: 'fast',
          options: [
            { group: 'g1', name: 'OpenAI', options: [{ value: 'fast', name: 'Fast', description: 'Quick' }] },
            { group: 'g2', name: 'Other', options: [{ value: 'deep', name: 'Deep' }] }
          ]
        },
        { id: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask' }, { value: 'code', name: 'Code', description: null }] }
      ],
      modes: { currentModeId: 'x', availableModes: [{ id: 'x', name: 'X' }] },
      models: { currentModelId: 'y', availableModels: [{ modelId: 'y', name: 'Y' }] }
    })
    expect(patch).toEqual({
      models: [{ id: 'fast', name: 'Fast', description: 'Quick' }, { id: 'deep', name: 'Deep' }],
      model: 'fast',
      modes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }],
      mode: 'ask'
    })
    expect(controls).toEqual({ model: { configId: 'm' }, mode: { configId: 'mode' } })
  })

  it('else the session modes and the legacy model list; nothing offered: nothing to switch', () => {
    const { patch, controls } = sessionControls({
      configOptions: [{ id: 'b', name: 'B', type: 'boolean', currentValue: false, category: 'model' } as never],
      modes: { currentModeId: 'plan', availableModes: [{ id: 'plan', name: 'Plan', description: 'Only plans' }] },
      models: { currentModelId: 'gpt', availableModels: [{ modelId: 'gpt', name: 'GPT', description: null }] }
    })
    expect(patch).toEqual({ models: [{ id: 'gpt', name: 'GPT' }], model: 'gpt', modes: [{ id: 'plan', name: 'Plan', description: 'Only plans' }], mode: 'plan' })
    expect(controls).toEqual({ model: { legacy: true }, mode: { legacy: true } })
    expect(sessionControls({ modes: { currentModeId: 'a', availableModes: [] }, models: { currentModelId: 'a', availableModels: [] } })).toEqual({ patch: {}, controls: {} })
    expect(sessionControls({ modes: null, models: null, configOptions: null })).toEqual({ patch: {}, controls: {} })
  })

  it('slash commands, with their input hint', () => {
    expect(acpCommands([{ name: 'review', description: 'Review', input: { hint: 'PR' } }, { name: 'init', description: 'Init', input: null }])).toEqual([
      { name: 'review', description: 'Review', hint: 'PR' },
      { name: 'init', description: 'Init' }
    ])
  })
})

describe('Claude Code: model, permission mode, commands', () => {
  const base = { sessionId: 's', title: 'T', settingsFile: 'settings.json', mcpFile: 'mcp.json' }
  it('passes a chosen model and permission mode — none for the defaults', () => {
    const args = claudeArgs({ ...base, model: 'opus', mode: 'plan', prompt: 'go' })
    expect(args.slice(4, 8)).toEqual(['--model', 'opus', '--permission-mode', 'plan'])
    expect(args.slice(-2)).toEqual(['--', 'go'])
    const plain = claudeArgs({ ...base, model: 'default', mode: 'default' })
    expect(plain).not.toContain('--model')
    expect(plain).not.toContain('--permission-mode')
    expect(CLAUDE_MODELS.map((m) => m.id)).toEqual(['default', 'opus', 'sonnet', 'haiku'])
    expect(CLAUDE_MODES.map((m) => m.id)).not.toContain('bypassPermissions')
    expect(CLAUDE_COMMANDS.map((c) => c.name)).not.toContain('clear') // it would end the session
  })
})
