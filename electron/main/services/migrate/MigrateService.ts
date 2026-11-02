import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  isSupportedCommand,
  KNOWN_EXTENSIONS,
  type EditorKeybinding,
  type EditorSettings,
  type LanguageSettings,
  type LiveServerSettings,
  type VimMapping,
  type SassFormat,
  type SassSettings,
  type MigrationExtension,
  type MigrationResult,
  type MigrationSource,
  type Snippet
} from '@shared/types/migrate'
import type { SettingsService } from '../settings/SettingsService'
import { writeAtomic } from '../../lib/writeAtomic'

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * JSON with comments and trailing commas — what VS Code writes its settings,
 * keybindings and snippets in. Strings stay untouched.
 */
export function parseJsonc(text: string): unknown {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"') {
      const start = i
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1
      out += text.slice(start, i + 1)
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) break
      i += 1
    } else out += ch
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

async function readJsonc(file: string): Promise<unknown> {
  try {
    return parseJsonc(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Where apps keep their data on this platform. */
export function appDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  if (platform === 'win32') return env.APPDATA ?? join(home, 'AppData', 'Roaming')
  return env.XDG_CONFIG_HOME ?? join(home, '.config')
}

/** The apps Mindeck can move over from — the user data folder name, how people call it, its extensions folder. */
export const APPS: { app: string; name: string; extensions: string }[] = [
  { app: 'Code', name: 'Visual Studio Code', extensions: '.vscode' },
  { app: 'Cursor', name: 'Cursor', extensions: '.cursor' },
  { app: 'VSCodium', name: 'VSCodium', extensions: '.vscode-oss' },
  { app: 'Windsurf', name: 'Windsurf', extensions: '.windsurf' }
]

const ENUMS: Record<string, string[]> = {
  wordWrap: ['off', 'on', 'wordWrapColumn', 'bounded'],
  lineNumbers: ['on', 'off', 'relative', 'interval'],
  renderWhitespace: ['none', 'boundary', 'selection', 'trailing', 'all'],
  cursorStyle: ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'],
  cursorBlinking: ['blink', 'smooth', 'phase', 'expand', 'solid']
}

/** VS Code setting → Mindeck editor setting (the value checked, else dropped). */
const SETTINGS: [string, keyof EditorSettings, (v: unknown) => unknown][] = [
  ['editor.fontSize', 'fontSize', (v) => (typeof v === 'number' && v > 4 && v < 80 ? v : undefined)],
  ['editor.fontFamily', 'fontFamily', (v) => (typeof v === 'string' && v.trim() ? v : undefined)],
  ['editor.fontLigatures', 'fontLigatures', (v) => (typeof v === 'boolean' ? v : typeof v === 'string' ? v.length > 0 : undefined)],
  ['editor.lineHeight', 'lineHeight', (v) => (typeof v === 'number' && v > 0 && v < 100 ? v : undefined)],
  ['editor.tabSize', 'tabSize', (v) => (typeof v === 'number' && v >= 1 && v <= 16 ? v : undefined)],
  ['editor.insertSpaces', 'insertSpaces', (v) => (typeof v === 'boolean' ? v : undefined)],
  ['editor.wordWrap', 'wordWrap', (v) => (ENUMS.wordWrap.includes(v as string) ? v : undefined)],
  ['editor.wordWrapColumn', 'wordWrapColumn', (v) => (typeof v === 'number' && v > 0 ? v : undefined)],
  ['editor.minimap.enabled', 'minimap', (v) => (typeof v === 'boolean' ? v : undefined)],
  ['editor.lineNumbers', 'lineNumbers', (v) => (ENUMS.lineNumbers.includes(v as string) ? v : undefined)],
  ['editor.renderWhitespace', 'renderWhitespace', (v) => (ENUMS.renderWhitespace.includes(v as string) ? v : undefined)],
  ['editor.cursorStyle', 'cursorStyle', (v) => (ENUMS.cursorStyle.includes(v as string) ? v : undefined)],
  ['editor.cursorBlinking', 'cursorBlinking', (v) => (ENUMS.cursorBlinking.includes(v as string) ? v : undefined)],
  [
    'editor.rulers',
    'rulers',
    (v) => (Array.isArray(v) ? v.map((r) => (typeof r === 'number' ? r : (r as { column?: number })?.column)).filter((r): r is number => typeof r === 'number') : undefined)
  ],
  ['editor.stickyScroll.enabled', 'stickyScroll', (v) => (typeof v === 'boolean' ? v : undefined)],
  ['editor.smoothScrolling', 'smoothScrolling', (v) => (typeof v === 'boolean' ? v : undefined)],
  ['editor.bracketPairColorization.enabled', 'bracketPairColorization', (v) => (typeof v === 'boolean' ? v : undefined)],
  ['editor.formatOnSave', 'formatOnSave', (v) => (typeof v === 'boolean' ? v : undefined)],
  // Prettier as the formatter (also per language: "[markdown]": { "editor.defaultFormatter": … }).
  ['editor.defaultFormatter', 'prettier', (v) => (typeof v === 'string' ? v === 'esbenp.prettier-vscode' : undefined)]
]

/** The editor settings Mindeck understands in a VS Code settings object, and how many. */
function mapSettings(raw: Record<string, unknown>): { settings: LanguageSettings; count: number } {
  const settings: LanguageSettings = {}
  let count = 0
  for (const [from, to, check] of SETTINGS) {
    const value = from in raw ? check(raw[from]) : undefined
    if (value === undefined) continue
    ;(settings as Record<string, unknown>)[to] = value
    count += 1
  }
  return { settings, count }
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
const defined = <T extends object>(o: T): T | undefined => {
  const kept = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
  return Object.keys(kept).length ? kept : undefined
}

/** editor.codeActionsOnSave asks for ESLint's fixes ({ "source.fixAll.eslint": "explicit" } or a list). */
export function fixesEslintOnSave(v: unknown): boolean {
  if (Array.isArray(v)) return v.includes('source.fixAll.eslint') || v.includes('source.fixAll')
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return [o['source.fixAll.eslint'], o['source.fixAll']].some((x) => x === true || x === 'explicit' || x === 'always')
}

/** The Prettier extension's prettier.* settings → Prettier options. */
export function prettierSettings(raw: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  const options = Object.fromEntries(
    Object.entries(raw)
      .filter(([k, v]) => k.startsWith('prettier.') && ['string', 'number', 'boolean'].includes(typeof v))
      .map(([k, v]) => [k.slice('prettier.'.length), v as string | number | boolean])
      // The extension's own switches aren't Prettier's options.
      .filter(([k]) => !['enable', 'requireConfig', 'resolveGlobalModules', 'prettierPath', 'configPath', 'ignorePath', 'withNodeModules', 'useEditorConfig', 'documentSelectors', 'enableDebugLogs'].includes(k as string))
  )
  return Object.keys(options).length ? options : undefined
}

/** VSCodeVim's remappings (keys → keys; command bindings have no equivalent) in Vim's notation. */
export function vimMappings(raw: Record<string, unknown>): VimMapping[] | undefined {
  const leader = typeof raw['vim.leader'] === 'string' && raw['vim.leader'] ? (raw['vim.leader'] as string) : '\\'
  const keys = (list: unknown) => (Array.isArray(list) && list.length && list.every((k) => typeof k === 'string') ? (list as string[]).join('').split('<leader>').join(leader) : undefined)
  const out: VimMapping[] = []
  for (const mode of ['normal', 'insert', 'visual'] as const) {
    for (const suffix of ['KeyBindings', 'KeyBindingsNonRecursive']) {
      const list = raw[`vim.${mode}Mode${suffix}`]
      for (const entry of Array.isArray(list) ? (list as { before?: unknown; after?: unknown }[]) : []) {
        const before = keys(entry?.before)
        const after = keys(entry?.after)
        if (before && after) out.push({ mode, before, after })
      }
    }
  }
  return out.length ? out : undefined
}

/** liveServer.settings.* → Mindeck's Live Server settings. */
export function liveServerSettings(raw: Record<string, unknown>): LiveServerSettings | undefined {
  const get = (k: string) => raw[`liveServer.settings.${k}`]
  const port = get('port')
  const root = get('root')
  return defined<LiveServerSettings>({
    port: typeof port === 'number' && port > 0 && port < 65536 ? port : undefined,
    root: typeof root === 'string' && root.trim() ? root : undefined,
    noBrowser: typeof get('NoBrowser') === 'boolean' ? (get('NoBrowser') as boolean) : undefined,
    fullReload: typeof get('fullReload') === 'boolean' ? (get('fullReload') as boolean) : undefined,
    ignore: strings(get('ignoreFiles')),
    wait: typeof get('wait') === 'number' && (get('wait') as number) >= 0 ? (get('wait') as number) : undefined
  })
}

/** liveSassCompile.settings.* → Mindeck's Sass settings. */
export function sassSettings(raw: Record<string, unknown>): SassSettings | undefined {
  const get = (k: string) => raw[`liveSassCompile.settings.${k}`]
  const formats = Array.isArray(get('formats'))
    ? (get('formats') as Record<string, unknown>[]).flatMap((f): SassFormat[] =>
        f && (f.format === 'expanded' || f.format === 'compressed') && typeof f.extensionName === 'string'
          ? [{ format: f.format, extensionName: f.extensionName, savePath: typeof f.savePath === 'string' ? f.savePath : null }]
          : []
      )
    : undefined
  return defined<SassSettings>({
    formats: formats?.length ? formats : undefined,
    generateMap: typeof get('generateMap') === 'boolean' ? (get('generateMap') as boolean) : undefined,
    exclude: strings(get('excludeList')),
    watchOnLaunch: typeof get('watchOnLaunch') === 'boolean' ? (get('watchOnLaunch') as boolean) : undefined
  })
}

/** VS Code's language ids → Monaco's (React flavors share their language's id there). */
const LANGUAGE_IDS: Record<string, string> = { typescriptreact: 'typescript', javascriptreact: 'javascript', shellscript: 'shell', global: '*' }
const monacoLanguage = (id: string) => LANGUAGE_IDS[id] ?? id

type SnippetFile = Record<string, { prefix?: string | string[]; body?: string | string[]; description?: string | string[]; scope?: string }>

/** Snippets of one file: a language's (`language`), or a `.code-snippets` file with its own scopes. */
export function snippetsOf(file: SnippetFile | undefined, language?: string): Snippet[] {
  if (!file || typeof file !== 'object') return []
  return Object.entries(file).flatMap(([name, s]) => {
    if (!s?.prefix || s.body === undefined) return []
    const body = Array.isArray(s.body) ? s.body.join('\n') : String(s.body)
    const description = Array.isArray(s.description) ? s.description.join(' ') : s.description
    const languages = language ? [language] : typeof s.scope === 'string' && s.scope ? s.scope.split(',').map((l) => l.trim()).filter(Boolean) : ['*']
    const prefixes = Array.isArray(s.prefix) ? s.prefix : [s.prefix]
    return languages.flatMap((l) => prefixes.map((prefix) => ({ name, language: monacoLanguage(l), prefix, body, description })))
  })
}

export interface MigrateOptions {
  home: string
  /** Where apps keep their data: macOS `~/Library/Application Support`, Linux `~/.config`, Windows `%APPDATA%`. */
  appData: string
  settings: SettingsService
  /** Mindeck's copy of the imported snippets. */
  snippetsFile: string
}

interface Found {
  settings: EditorSettings
  settingsCount: number
  keybindings: EditorKeybinding[]
  snippets: Snippet[]
  extensions: MigrationExtension[]
}

/**
 * Moving over from VS Code, Cursor, VSCodium or Windsurf: reads their
 * editor settings, keybindings, snippets (the user's and those of snippet
 * extensions) and installed extensions — only reading, never changing them —
 * and copies what Mindeck understands into its own settings.
 */
export class MigrateService {
  constructor(private readonly opts: MigrateOptions) {}

  /** The apps found on this machine, each with what moving over would bring. */
  async scan(): Promise<MigrationSource[]> {
    const found: MigrationSource[] = []
    for (const app of APPS) {
      if (!existsSync(this.userDir(app.app))) continue
      const f = await this.read(app.app)
      found.push({ app: app.app, name: app.name, settings: f.settingsCount, keybindings: f.keybindings.length, snippets: f.snippets.length, extensions: f.extensions })
    }
    return found
  }

  /** Take an app's settings, keybindings and snippets over (replacing earlier imports). */
  async apply(app: string): Promise<MigrationResult> {
    if (!APPS.some((a) => a.app === app) || !existsSync(this.userDir(app))) throw coded('not-found', `${app} is not installed here`)
    const f = await this.read(app)
    const keybindings = f.keybindings.filter((k) => isSupportedCommand(k.command))
    await this.opts.settings.update({ editor: { ...f.settings, keybindings, importedFrom: { app, at: new Date().toISOString() } } })
    await writeAtomic(this.opts.snippetsFile, JSON.stringify(f.snippets))
    return { settings: f.settingsCount, keybindings: keybindings.length, snippets: f.snippets.length }
  }

  /** Change some editor settings (Settings → Editor). */
  async updateEditor(patch: Partial<EditorSettings>): Promise<EditorSettings> {
    const editor = { ...this.opts.settings.get().editor, ...patch }
    await this.opts.settings.update({ editor })
    return editor
  }

  /** The editor's settings and snippets, as the editor applies them. */
  async editor(): Promise<{ settings: EditorSettings; snippets: Snippet[] }> {
    const snippets = (await readJsonc(this.opts.snippetsFile)) as Snippet[] | undefined
    return { settings: this.opts.settings.get().editor ?? {}, snippets: Array.isArray(snippets) ? snippets : [] }
  }

  // --- reading an app ---

  private userDir(app: string): string {
    return join(this.opts.appData, app, 'User')
  }

  private async read(app: string): Promise<Found> {
    const dir = this.userDir(app)
    const raw = ((await readJsonc(join(dir, 'settings.json'))) ?? {}) as Record<string, unknown>
    const mapped = mapSettings(raw)
    const settings: EditorSettings = mapped.settings
    let settingsCount = mapped.count
    // Language overrides: "[python]": { … }, also for several at once: "[javascript][typescript]".
    for (const [key, value] of Object.entries(raw)) {
      const ids = key.match(/\[([^\]]+)\]/g)
      if (!ids || key.replace(/\[[^\]]+\]/g, '') !== '' || !value || typeof value !== 'object') continue
      const override = mapSettings(value as Record<string, unknown>)
      if (!override.count) continue
      for (const id of ids.map((i) => monacoLanguage(i.slice(1, -1)))) settings.languages = { ...settings.languages, [id]: { ...settings.languages?.[id], ...override.settings } }
      settingsCount += override.count
    }

    const bindings = await readJsonc(join(dir, 'keybindings.json'))
    const keybindings = (Array.isArray(bindings) ? bindings : [])
      .filter((b): b is EditorKeybinding => typeof b?.key === 'string' && typeof b?.command === 'string' && !b.command.startsWith('-'))
      .map((b) => ({ key: b.key, command: b.command, ...(b.when ? { when: b.when } : {}) }))

    const snippets: Snippet[] = []
    const snippetDir = join(dir, 'snippets')
    for (const name of existsSync(snippetDir) ? await readdir(snippetDir) : []) {
      const file = (await readJsonc(join(snippetDir, name))) as SnippetFile | undefined
      if (name.endsWith('.code-snippets')) snippets.push(...snippetsOf(file))
      else if (name.endsWith('.json')) snippets.push(...snippetsOf(file, monacoLanguage(name.slice(0, -5))))
    }

    const extensions: MigrationExtension[] = []
    const extDir = join(this.opts.home, APPS.find((a) => a.app === app)!.extensions, 'extensions')
    for (const folder of existsSync(extDir) ? (await readdir(extDir)).sort() : []) {
      const pkg = (await readJsonc(join(extDir, folder, 'package.json'))) as ExtensionManifest | undefined
      if (!pkg?.name || !pkg.publisher) continue
      const id = `${pkg.publisher}.${pkg.name}`.toLowerCase()
      if (extensions.some((e) => e.id === id)) continue // older versions side by side
      const fate = await this.fate(id, pkg, join(extDir, folder), snippets)
      extensions.push({ id, name: await this.displayName(pkg, join(extDir, folder)), ...fate })
    }
    // Live Server and Live Sass Compiler: their settings come along.
    const liveServer = liveServerSettings(raw)
    if (liveServer) {
      settings.liveServer = liveServer
      settingsCount += Object.keys(liveServer).length
    }
    const sass = sassSettings(raw)
    if (sass) {
      settings.sass = sass
      settingsCount += Object.keys(sass).length
    }
    // ESLint fixed on save; Prettier's own defaults (used where a project has no config).
    if (fixesEslintOnSave(raw['editor.codeActionsOnSave'])) {
      settings.eslintFixOnSave = true
      settingsCount += 1
    }
    const prettierOptions = prettierSettings(raw)
    if (prettierOptions) {
      settings.prettierOptions = prettierOptions
      settingsCount += Object.keys(prettierOptions).length
    }
    // VSCodeVim installed: Vim keys here too, with the user's remappings.
    if (extensions.some((e) => e.id === 'vscodevim.vim')) {
      settings.vim = true
      settingsCount += 1
      const mappings = vimMappings(raw)
      if (mappings) {
        settings.vimMappings = mappings
        settingsCount += mappings.length
      }
    }
    // Blank Line Organizer installed: it ran on every save — so does Mindeck's.
    if (extensions.some((e) => e.id === 'ctf0.blank-line-organizer')) {
      settings.blankLines = { onSave: true, keepOne: raw['blankLine.keepOneEmptyLine'] !== false }
      settingsCount += 1
    }
    // React flavors map onto their language — the same snippet often comes twice.
    const seen = new Set<string>()
    const unique = snippets.filter((s) => {
      const key = `${s.language}\u0000${s.prefix}\u0000${s.body}`
      return !seen.has(key) && !!seen.add(key)
    })
    return { settings, settingsCount, keybindings, snippets: unique, extensions }
  }

  /** What becomes of an extension: known ones by id; others by what they contain (snippets come along). */
  private async fate(id: string, pkg: ExtensionManifest, dir: string, snippets: Snippet[]): Promise<Pick<MigrationExtension, 'fate' | 'language'>> {
    const contributes = pkg.contributes ?? {}
    for (const s of contributes.snippets ?? []) snippets.push(...snippetsOf((await readJsonc(join(dir, s.path))) as SnippetFile | undefined, monacoLanguage(s.language)))
    if (KNOWN_EXTENSIONS[id]) return KNOWN_EXTENSIONS[id]
    // Snippets come along (whatever else the extension does); themes stay behind on purpose.
    if (contributes.snippets?.length) return { fate: 'snippets' }
    if (contributes.themes?.length || contributes.iconThemes?.length) return { fate: 'theme' }
    return { fate: 'unsupported' }
  }

  /** The extension's name as its marketplace page shows it (`%key%` names come from package.nls.json). */
  private async displayName(pkg: ExtensionManifest, dir: string): Promise<string> {
    const name = pkg.displayName ?? pkg.name!
    const key = /^%(.+)%$/.exec(name)?.[1]
    if (!key) return name
    const nls = (await readJsonc(join(dir, 'package.nls.json'))) as Record<string, string | { message: string }> | undefined
    const value = nls?.[key]
    return (typeof value === 'string' ? value : value?.message) ?? pkg.name!
  }
}

interface ExtensionManifest {
  name?: string
  publisher?: string
  displayName?: string
  contributes?: { snippets?: { language: string; path: string }[]; themes?: unknown[]; iconThemes?: unknown[] }
}
