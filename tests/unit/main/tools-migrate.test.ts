import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './helpers'
import { APPS, appDataDir, fixesEslintOnSave, MigrateService, parseJsonc, prettierSettings, snippetsOf, vimMappings } from '../../../electron/main/services/migrate/MigrateService'
import { SettingsService } from '../../../electron/main/services/settings/SettingsService'
import { isSupportedCommand } from '@shared/types/migrate'

describe('moving over from VS Code / Cursor', () => {
  async function machine() {
    const home = await tempDir('mindeck-home-')
    const appData = join(home, 'AppData')
    const user = join(appData, 'Code', 'User')
    await mkdir(join(user, 'snippets'), { recursive: true })
    await writeFile(
      join(user, 'settings.json'),
      `{
  // my editor
  "editor.fontSize": 15,
  "editor.fontFamily": "Fira Code",
  "editor.fontLigatures": "'ss01'",
  "editor.tabSize": 2,
  "editor.insertSpaces": true,
  "editor.wordWrap": "on",
  "editor.minimap.enabled": false,
  "editor.lineNumbers": "relative",
  "editor.renderWhitespace": "all",
  "editor.cursorStyle": "block",
  "editor.cursorBlinking": "smooth",
  "editor.rulers": [80, { "column": 120 }, "x"],
  "editor.stickyScroll.enabled": true,
  "editor.smoothScrolling": true,
  "editor.bracketPairColorization.enabled": false,
  "editor.lineHeight": 22,
  "editor.wordWrapColumn": 100,
  "editor.cursorStyle.bogus": 1,
  "editor.fontSize.x": "y",
  "editor.formatOnSave": true,
  "liveServer.settings.port": 5501,
  "liveSassCompile.settings.generateMap": true,
  "blankLine.keepOneEmptyLine": false,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": { "source.fixAll.eslint": "explicit" },
  "prettier.singleQuote": true,
  "prettier.printWidth": 100,
  "prettier.requireConfig": true,
  "prettier.ignore": { "x": 1 },
  "vim.leader": "<space>",
  "vim.insertModeKeyBindings": [{ "before": ["j", "j"], "after": ["<Esc>"] }],
  "vim.normalModeKeyBindingsNonRecursive": [{ "before": ["<leader>", "w"], "after": [":", "w", "<CR>"] }, { "before": ["x"], "commands": [":w"] }],
  "[python]": { "editor.tabSize": 4, "editor.formatOnSave": false, "editor.defaultFormatter": "ms-python.black-formatter" },
  "[javascript][typescriptreact]": { "editor.tabSize": 2 },
  "[markdown]": { "markdown.preview": true, "editor.defaultFormatter": null },
  "[go]": "not settings",
  "workbench.colorTheme": "One Dark Pro", /* themes stay */
  "url": "https://example.com/a//b",
  "quote": "say \\"hi\\" // not a comment",
}`
    )
    await writeFile(
      join(user, 'keybindings.json'),
      `[
  { "key": "cmd+k cmd+c", "command": "editor.action.commentLine", "when": "editorTextFocus" },
  { "key": "cmd+shift+o", "command": "workbench.action.quickOpen" },
  { "key": "cmd+j", "command": "-workbench.action.togglePanel" },
  { "key": "cmd+y", "command": "gitlens.showGraph" },
  { "nope": true },
]`
    )
    await writeFile(join(user, 'snippets', 'typescriptreact.json'), JSON.stringify({ Comp: { prefix: ['rfc', 'comp'], body: ['export function $1() {', '  return null', '}'], description: ['A', 'component'] } }))
    await writeFile(join(user, 'snippets', 'mine.code-snippets'), JSON.stringify({ Log: { prefix: 'log', body: 'console.log($1)', scope: 'javascript, typescript' }, Any: { prefix: 'todo', body: 'TODO' }, Broken: { body: 'x' } }))
    await writeFile(join(user, 'snippets', 'notes.txt'), 'ignored')
    await writeFile(join(user, 'snippets', 'bad.json'), '{ not json')

    const ext = join(home, '.vscode', 'extensions')
    const extension = async (folder: string, pkg: object, files: Record<string, string> = {}) => {
      await mkdir(join(ext, folder), { recursive: true })
      await writeFile(join(ext, folder, 'package.json'), JSON.stringify(pkg))
      for (const [name, body] of Object.entries(files)) await writeFile(join(ext, folder, name), body)
    }
    await extension('ms-python.python-1', { publisher: 'ms-python', name: 'python', displayName: '%ext.name%' }, { 'package.nls.json': JSON.stringify({ 'ext.name': 'Python' }) })
    await extension('dsznajder.es7-1', {
      publisher: 'dsznajder',
      name: 'es7',
      displayName: 'ES7 snippets',
      main: './x.js',
      contributes: { snippets: [{ language: 'javascriptreact', path: './s.json' }, { language: 'javascript', path: './s.json' }] }
    }, { 's.json': JSON.stringify({ rafce: { prefix: 'rafce', body: 'export default $1' } }) })
    await extension('zhuangtongfa.material-theme-3', { publisher: 'zhuangtongfa', name: 'material-theme', displayName: 'One Dark Pro', main: './x.js', contributes: { themes: [{}] } })
    await extension('pkief.icons-1', { publisher: 'pkief', name: 'icons', displayName: '%missing%', contributes: { iconThemes: [{}] } }, { 'package.nls.json': JSON.stringify({ other: { message: 'x' } }) })
    await extension('obj.nls-1', { publisher: 'obj', name: 'nls', displayName: '%n%' }, { 'package.nls.json': JSON.stringify({ n: { message: 'Object Name' } }) })
    await extension('mhutchie.git-graph-1', { publisher: 'mhutchie', name: 'git-graph' })
    await extension('mhutchie.git-graph-2', { publisher: 'mhutchie', name: 'git-graph' }) // two versions side by side
    await extension('random.tool-1', { publisher: 'random', name: 'tool', main: './x.js' })
    await extension('ctf0.blank-line-organizer-0', { publisher: 'ctf0', name: 'blank-line-organizer', main: './x.js' })
    await extension('vscodevim.vim-1', { publisher: 'vscodevim', name: 'vim', displayName: 'Vim', main: './x.js' })
    await extension('broken-1', { name: 'no-publisher' })
    await mkdir(join(ext, 'empty-1'))
    // Cursor installed too, with one setting; VSCodium with settings Mindeck can't use.
    await mkdir(join(appData, 'Cursor', 'User'), { recursive: true })
    await writeFile(join(appData, 'Cursor', 'User', 'settings.json'), '{ "editor.fontLigatures": false }')
    // Vim in Cursor too — without remappings
    await mkdir(join(home, '.cursor', 'extensions', 'vscodevim.vim-1'), { recursive: true })
    await writeFile(join(home, '.cursor', 'extensions', 'vscodevim.vim-1', 'package.json'), JSON.stringify({ publisher: 'vscodevim', name: 'vim', displayName: 'Vim', main: './x.js' }))
    await mkdir(join(appData, 'VSCodium', 'User'), { recursive: true })
    const invalid = {
      'editor.fontSize': 2,
      'editor.fontFamily': '  ',
      'editor.fontLigatures': 3,
      'editor.lineHeight': -1,
      'editor.tabSize': 40,
      'editor.insertSpaces': 'yes',
      'editor.wordWrap': 'sometimes',
      'editor.wordWrapColumn': 0,
      'editor.minimap.enabled': 1,
      'editor.lineNumbers': 'roman',
      'editor.renderWhitespace': 'some',
      'editor.cursorStyle': 'heart',
      'editor.cursorBlinking': 'disco',
      'editor.rulers': 'eighty',
      'editor.stickyScroll.enabled': 'on',
      'editor.smoothScrolling': null,
      'editor.bracketPairColorization.enabled': 'true',
      'editor.formatOnSave': 'yes'
    }
    await writeFile(join(appData, 'VSCodium', 'User', 'settings.json'), JSON.stringify(invalid))
    // Windsurf installed, never configured.
    await mkdir(join(appData, 'Windsurf', 'User'), { recursive: true })

    const data = await tempDir()
    const settings = new SettingsService(join(data, 'settings.json'))
    await settings.init()
    const service = new MigrateService({ home, appData, settings, snippetsFile: join(data, 'snippets.json') })
    return { service, settings, data }
  }

  it('finds the apps and tells what moving over brings — without changing anything', async () => {
    const { service } = await machine()
    const [code, cursor, codium, windsurf] = await service.scan()
    expect(windsurf).toMatchObject({ app: 'Windsurf', settings: 0, keybindings: 0 })
    expect(codium).toMatchObject({ app: 'VSCodium', settings: 0 }) // nothing Mindeck could use
    expect(code).toMatchObject({ app: 'Code', name: 'Visual Studio Code', settings: 32, keybindings: 3, snippets: 6 })
    expect(code.extensions.map((e) => `${e.id}|${e.name}|${e.fate}|${e.language ?? ''}`)).toEqual([
      'ctf0.blank-line-organizer|blank-line-organizer|built-in|',
      'dsznajder.es7|ES7 snippets|snippets|',
      'mhutchie.git-graph|git-graph|built-in|',
      'ms-python.python|Python|language|python',
      'obj.nls|Object Name|unsupported|',
      'pkief.icons|icons|theme|',
      'random.tool|tool|unsupported|',
      'vscodevim.vim|Vim|built-in|',
      'zhuangtongfa.material-theme|One Dark Pro|theme|'
    ])
    expect(cursor).toEqual({ app: 'Cursor', name: 'Cursor', settings: 2, keybindings: 0, snippets: 0, extensions: [{ id: 'vscodevim.vim', name: 'Vim', fate: 'built-in' }] })
  })

  it('takes settings, the keybindings Mindeck can honor and every snippet over', async () => {
    const { service, settings, data } = await machine()
    expect(await service.apply('Code')).toEqual({ settings: 32, keybindings: 2, snippets: 6 })
    const editor = settings.get().editor!
    expect(editor).toMatchObject({
      fontSize: 15,
      fontFamily: 'Fira Code',
      fontLigatures: true,
      tabSize: 2,
      wordWrap: 'on',
      minimap: false,
      lineNumbers: 'relative',
      rulers: [80, 120],
      bracketPairColorization: false,
      formatOnSave: true,
      // Prettier formatted, ESLint fixed on save (Python had its own formatter).
      prettier: true,
      eslintFixOnSave: true,
      prettierOptions: { singleQuote: true, printWidth: 100 },
      // The Blank Line Organizer was installed: it ran on save, and kept no blank lines.
      blankLines: { onSave: true, keepOne: false },
      // VSCodeVim was installed: Vim keys, with the user's remappings (key → key only).
      vim: true,
      vimMappings: [
        { mode: 'normal', before: '<space>w', after: ':w<CR>' },
        { mode: 'insert', before: 'jj', after: '<Esc>' }
      ],
      languages: { python: { tabSize: 4, formatOnSave: false, prettier: false }, javascript: { tabSize: 2 }, typescript: { tabSize: 2 } },
      importedFrom: { app: 'Code', at: expect.any(String) }
    })
    expect(editor.keybindings).toEqual([
      { key: 'cmd+k cmd+c', command: 'editor.action.commentLine', when: 'editorTextFocus' },
      { key: 'cmd+shift+o', command: 'workbench.action.quickOpen' }
    ])
    const snippets = JSON.parse(await readFile(join(data, 'snippets.json'), 'utf8'))
    expect(snippets.map((s: { language: string; prefix: string }) => `${s.language}:${s.prefix}`).sort()).toEqual(['*:todo', 'javascript:log', 'javascript:rafce', 'typescript:comp', 'typescript:log', 'typescript:rfc'])
    expect(snippets.find((s: { prefix: string }) => s.prefix === 'rfc')).toMatchObject({ name: 'Comp', body: 'export function $1() {\n  return null\n}', description: 'A component' })
    expect(await service.editor()).toMatchObject({ settings: { fontSize: 15 }, snippets: expect.any(Array) })
    await expect(service.apply('Notepad')).rejects.toMatchObject({ code: 'not-found' })
    // From Cursor: Vim keys, but no remappings to take
    expect(await service.apply('Cursor')).toEqual({ settings: 2, keybindings: 0, snippets: 0 })
    expect(settings.get().editor).toMatchObject({ vim: true, importedFrom: { app: 'Cursor' } })
    expect(settings.get().editor).not.toHaveProperty('vimMappings')
    const elsewhere = new MigrateService({ home: '/nowhere', appData: await tempDir(), settings, snippetsFile: join(data, 'x.json') })
    await expect(elsewhere.apply('Code')).rejects.toMatchObject({ code: 'not-found' }) // not installed here
    expect(await elsewhere.scan()).toEqual([])
  })

  it('Settings → Editor changes single settings, keeping the rest', async () => {
    const { service, settings } = await machine()
    await settings.update({ editor: { fontSize: 15, formatOnSave: true } })
    expect(await service.updateEditor({ formatOnSave: false, prettier: true })).toEqual({ fontSize: 15, formatOnSave: false, prettier: true })
    expect(settings.get().editor).toEqual({ fontSize: 15, formatOnSave: false, prettier: true })
  })

  it('ESLint fixes on save in every way VS Code writes it; Prettier’s options only', () => {
    expect([
      { 'source.fixAll.eslint': 'explicit' },
      { 'source.fixAll.eslint': true },
      { 'source.fixAll': 'always' },
      ['source.fixAll.eslint'],
      ['source.fixAll'],
      { 'source.fixAll.eslint': 'never' },
      { 'source.organizeImports': true },
      ['source.organizeImports'],
      'source.fixAll.eslint',
      null
    ].map(fixesEslintOnSave)).toEqual([true, true, true, true, true, false, false, false, false, false])
    expect(prettierSettings({ 'prettier.semi': false, 'prettier.enable': true, 'prettier.configPath': 'x', 'prettier.overrides': [] })).toEqual({ semi: false })
    expect(prettierSettings({ 'editor.fontSize': 1 })).toBeUndefined()
    // Vim: the default leader is a backslash; malformed entries are skipped.
    expect(vimMappings({ 'vim.visualModeKeyBindings': [{ before: ['<leader>', 'y'], after: ['"', '+', 'y'] }, { before: [], after: ['x'] }, { before: ['a', 1], after: ['b'] }, null] })).toEqual([
      { mode: 'visual', before: '\\y', after: '"+y' }
    ])
    expect(vimMappings({ 'vim.leader': '', 'vim.normalModeKeyBindings': 'nope' })).toBeUndefined()
  })

  it('without anything imported the editor gets defaults; a broken snippet file is no snippets', async () => {
    const { service, data } = await machine()
    expect(await service.editor()).toEqual({ settings: {}, snippets: [] })
    await writeFile(join(data, 'snippets.json'), '{"not": "a list"}')
    expect((await service.editor()).snippets).toEqual([])
  })

  it('JSONC, snippet files, app folders per platform, supported commands', () => {
    expect(parseJsonc('{"a": "x // y", /* c */ "b": [1,2,],}')).toEqual({ a: 'x // y', b: [1, 2] })
    expect(parseJsonc('{"a": 1} /* never closed')).toEqual({ a: 1 })
    expect(snippetsOf(undefined)).toEqual([])
    expect(snippetsOf({ s: { prefix: 'p', body: 'b' } }, 'go')).toEqual([{ name: 's', language: 'go', prefix: 'p', body: 'b', description: undefined }])
    expect(snippetsOf({ s: { prefix: 'p', body: 'b', scope: 'shellscript' } })[0].language).toBe('shell')
    expect(appDataDir('darwin', {}, '/h')).toBe('/h/Library/Application Support')
    expect(appDataDir('win32', { APPDATA: 'C:\\A' }, '/h')).toBe('C:\\A')
    expect(appDataDir('win32', {}, '/h')).toBe('/h/AppData/Roaming')
    expect(appDataDir('linux', { XDG_CONFIG_HOME: '/x' }, '/h')).toBe('/x')
    expect(appDataDir('linux', {}, '/h')).toBe('/h/.config')
    expect(appDataDir()).toBeTruthy()
    expect(APPS.map((a) => a.app)).toEqual(['Code', 'Cursor', 'VSCodium', 'Windsurf'])
    expect(['editor.action.commentLine', 'workbench.action.quickOpen', 'cursorDown', 'gitlens.showGraph'].map(isSupportedCommand)).toEqual([true, true, true, false])
  })
})
