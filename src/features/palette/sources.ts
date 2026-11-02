import {
  ArrowRightLeft,
  Bookmark,
  Bot,
  BrainCircuit,
  CalendarDays,
  Code2,
  Columns2,
  FileText,
  FolderGit2,
  Globe,
  Info,
  Keyboard,
  Languages,
  MonitorCog,
  Moon,
  Network,
  Palette,
  Plus,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Sun,
  SunMoon,
  TerminalSquare,
  UserRound,
  Wifi,
  type LucideIcon
} from 'lucide-react'
import { ipc, isDesktop } from '@shared/ipc/client'
import { isFolder, type BookmarkItem } from '@shared/types/browserData'
import type { ModuleId } from '@/types'
import type { Dict } from '@/lib/i18n/en'
import { LOCALES, useLocale } from '@/lib/i18n'
import { MODES, useAppearance, type Mode } from '@/lib/theme'
import { shortcutLabel } from '@/lib/shortcuts'
import { NAV_ITEMS } from '@/data/navigation'
import { macKeys } from '@/features/workspace/keys'
import { useWorkspace } from '@/features/workspace/store'
import { workspaceCommands } from '@/features/workspace/commands'
import { useProjects } from '@/features/projects/store'
import { useEditor } from '@/features/editor/store'
import { useAgents } from '@/features/agents/sessions'
import { useBrowser } from '@/features/browser/store'
import { tabLabel, walk } from '@/features/browser/library'
import { useMemory } from '@/features/memory/store'
import { useTerminals, type TerminalLayout } from '@/features/terminal/store'
import { useTerminalSettings } from '@/features/terminal/settings'
import { useOnboarding } from '@/features/onboarding/store'
import { registerCommands, type Command, type CommandSource } from './registry'
import { useRecentFiles } from './recentFiles'
import { revealSettings, showModule } from './reveal'
import { usePalette } from './store'

const MODULE_ICONS: Record<ModuleId, LucideIcon> = { ...(Object.fromEntries(NAV_ITEMS.map((i) => [i.id, i.icon])) as Record<Exclude<ModuleId, 'account'>, LucideIcon>), account: UserRound }
const MODULES: ModuleId[] = [...NAV_ITEMS.map((i) => i.id), 'account']

/** Changes of a store re-list the palette. */
const follow =
  (...stores: { subscribe: (listener: () => void) => () => void }[]) =>
  (changed: () => void) => {
    const offs = stores.map((s) => s.subscribe(changed))
    return () => offs.forEach((off) => off())
  }

/** Every module: in the focused pane, or in a new pane beside it. */
function moduleCommands(t: Dict): Command[] {
  const c = t.commands
  return MODULES.flatMap((id) => [
    { id: `module.${id}`, label: t.nav[id], group: c.groups.open, icon: MODULE_ICONS[id], keywords: c.keywords.module, run: () => showModule(id) },
    { id: `module.${id}.beside`, label: c.openBeside(t.nav[id]), group: t.workspace.title, icon: Columns2, keywords: c.keywords.beside, run: () => useWorkspace.getState().openBeside(id) }
  ])
}

/** Settings' sections, each a link into Settings (the titles their cards carry). */
function settingsCommands(t: Dict): Command[] {
  const group = t.nav.settings
  const sections: [key: string, title: string, icon: LucideIcon, desktopOnly?: boolean][] = [
    ['appearance', t.settings.appearanceCard, Palette],
    ['language', t.account.languageCard, Languages],
    ['agents', t.settings.agentsCard, TerminalSquare],
    ['browser', t.settings.browserCard, Globe],
    ['editor', t.editorSettings.title, Code2],
    ['terminal', t.terminalSettings.title, SquareTerminal],
    ['migrate', t.migrate.title, ArrowRightLeft],
    ['languages', t.languages.title, Code2],
    ['ai', t.settings.aiCard, BrainCircuit],
    ['remote', t.settings.remoteCard, Wifi],
    ['permissions', t.settings.permissionsCard, ShieldCheck],
    ['vault', t.settings.vaultCard, Network],
    ['desktop', t.stability.card, MonitorCog, true],
    ['setup', t.onboarding.settingsCard, Sparkles, true],
    ['about', t.settings.aboutCard, Info]
  ]
  return sections
    .filter(([, , , desktopOnly]) => !desktopOnly || isDesktop())
    .map(([key, title, icon]) => ({ id: `settings.${key}`, label: title, group, icon, keywords: t.commands.keywords.settings, run: () => revealSettings(title) }))
}

/** The projects: open one in the editor, or a terminal in it. */
const projectsSource: CommandSource = {
  commands: (t) =>
    useProjects.getState().projects.flatMap((p) => [
      {
        id: `project.${p.id}`,
        label: p.name,
        detail: p.path,
        group: t.nav.projects,
        icon: FolderGit2,
        keywords: t.commands.keywords.project,
        run: async () => {
          showModule('editor')
          await useEditor.getState().selectProject(p.id)
        }
      },
      { id: `project.${p.id}.terminal`, label: t.commands.terminalIn(p.name), detail: p.path, group: t.nav.terminal, icon: SquareTerminal, run: () => openTerminal(() => useTerminals.getState().open(p.id)) }
    ]),
  prepare: () => {
    if (!useProjects.getState().projects.length) void useProjects.getState().load()
  },
  subscribe: follow(useProjects)
}

/** The files last shown in the editor. */
const recentFilesSource: CommandSource = {
  commands: (t) => {
    const names = new Map(useProjects.getState().projects.map((p) => [p.id, p.name]))
    return useRecentFiles
      .getState()
      .files.filter((f) => names.has(f.projectId))
      .map((f) => {
        const slash = f.path.lastIndexOf('/')
        return {
          id: `file.${f.projectId}:${f.path}`,
          label: f.path.slice(slash + 1),
          detail: [names.get(f.projectId), ...f.path.slice(0, Math.max(0, slash)).split('/').filter(Boolean)].join(' › '),
          group: t.commands.groups.recentFiles,
          icon: FileText,
          run: async () => {
            showModule('editor')
            await useEditor.getState().selectProject(f.projectId)
            await useEditor.getState().open(f.path)
          }
        }
      })
  },
  subscribe: follow(useRecentFiles, useProjects)
}

/** Agent sessions: a new one, and the ones there are (the five latest without a search). */
const agentsSource: CommandSource = {
  commands: (t) => {
    const group = t.nav.agents
    const open = (fn: () => unknown) => () => {
      showModule('agents')
      return fn()
    }
    return [
      { id: 'agents.new', label: t.commands.newSession, group, icon: Plus, keywords: t.commands.keywords.agent, run: open(() => useAgents.getState().openDialog()) },
      { id: 'agents.assistant', label: t.commands.assistant, group, icon: Bot, keywords: t.commands.keywords.agent, run: open(() => useAgents.getState().showAssistant()) },
      ...useAgents.getState().sessions.map((s, i) => ({
        id: `agent.${s.id}`,
        label: s.title,
        detail: s.projectName,
        group,
        icon: Bot,
        searchOnly: i >= 5,
        run: open(() => useAgents.getState().open(s.id))
      }))
    ]
  },
  subscribe: follow(useAgents)
}

/** The browser (where the core has it): a new tab, the open ones, the bookmarks. */
const browserSource: CommandSource = {
  commands: (t) => {
    const { state, bookmarks } = useBrowser.getState()
    if (!state.available) return []
    const group = t.nav.browser
    const bookmarkItems = walk(bookmarks)
      .map((w) => w.node)
      .filter((n): n is BookmarkItem => !isFolder(n))
    return [
      {
        id: 'browser.newTab',
        label: t.browser.newTab,
        group,
        icon: Plus,
        keys: shortcutLabel('browser.newTab', macKeys()),
        run: () => {
          showModule('browser')
          return useBrowser.getState().newTab()
        }
      },
      ...state.tabs.map((tab) => ({
        id: `browser.tab.${tab.id}`,
        label: tabLabel(tab, t.library.pages) || t.browser.untitled,
        detail: tab.url,
        group,
        icon: Globe,
        run: () => {
          showModule('browser')
          return useBrowser.getState().run('browser:activate', { id: tab.id })
        }
      })),
      ...bookmarkItems.map((b) => ({
        id: `bookmark.${b.id}`,
        label: b.title || b.url,
        detail: b.url,
        group: t.commands.groups.bookmarks,
        icon: Bookmark,
        searchOnly: true,
        run: () => useBrowser.getState().show(b.url)
      }))
    ]
  },
  subscribe: follow(useBrowser)
}

/** The memory vault: today's note, the graph, every note (for a search). */
const notesSource: CommandSource = {
  commands: (t) => {
    const group = t.nav.memory
    const memory = () => useMemory.getState()
    const open = (fn: () => unknown) => () => {
      showModule('memory')
      return fn()
    }
    return [
      { id: 'memory.daily', label: t.commands.daily, group, icon: CalendarDays, run: open(() => memory().openDaily()) },
      { id: 'memory.graph', label: t.commands.graph, group, icon: Network, run: open(() => memory().setView('graph')) },
      ...memory().notes.map((n) => ({
        id: `note.${n.path}`,
        label: n.title,
        detail: n.folder || undefined,
        group: t.commands.groups.notes,
        icon: FileText,
        keywords: n.tags.join(' '),
        searchOnly: true,
        run: open(() => memory().open(n.path))
      }))
    ]
  },
  // The vault's notes: the memory module reads them when it opens; the palette may come first.
  prepare: () => {
    if (useMemory.getState().notes.length) return
    void ipc('memory:list').then(
      (notes) => Array.isArray(notes) && !useMemory.getState().notes.length && useMemory.setState({ notes }),
      () => {}
    )
  },
  subscribe: follow(useMemory)
}

/** A new shell, once the terminals are up (without the extra Home shell of a first visit). */
async function openTerminal(open: () => Promise<void>): Promise<void> {
  showModule('terminal')
  await useTerminals.getState().init(false)
  await open()
}

const TERMINAL_LAYOUTS: TerminalLayout[] = ['single', 'cols', 'rows', 'grid']

/** Terminals: a new one, with each shell and profile, and the terminal's own layouts. */
const terminalSource: CommandSource = {
  commands: (t) => {
    const group = t.nav.terminal
    const { shells, settings } = useTerminalSettings.getState()
    const profiles = [...shells.map((s) => ({ id: s.id, name: s.name })), ...settings.profiles.map((p) => ({ id: p.id, name: p.name }))]
    return [
      { id: 'terminal.new', label: t.commands.newTerminal, group, icon: Plus, keywords: t.commands.keywords.terminal, run: () => openTerminal(() => useTerminals.getState().open()) },
      ...profiles.map((p) => ({
        id: `terminal.profile.${p.id}`,
        label: t.commands.newTerminalWith(p.name),
        group,
        icon: SquareTerminal,
        keywords: t.commands.keywords.terminal,
        run: () => openTerminal(() => useTerminals.getState().open(undefined, p.id))
      })),
      ...TERMINAL_LAYOUTS.map((l) => ({
        id: `terminal.layout.${l}`,
        label: t.commands.terminalLayout(t.terminal[l]),
        group,
        icon: TerminalSquare,
        keywords: t.commands.keywords.layout,
        run: () => {
          showModule('terminal')
          useTerminals.getState().setLayout(l)
        }
      }))
    ]
  },
  prepare: () => void useTerminalSettings.getState().load(),
  subscribe: follow(useTerminalSettings)
}

const MODE_ICONS: Record<Mode, LucideIcon> = { dark: Moon, light: Sun, system: SunMoon }

/** The look and the language, and help. */
function preferenceCommands(t: Dict): Command[] {
  const c = t.commands
  return [
    ...MODES.map((mode) => ({
      id: `theme.${mode}`,
      label: c.theme(t.settings.themeModes[mode]),
      group: c.groups.appearance,
      icon: MODE_ICONS[mode],
      keywords: c.keywords.theme,
      run: () => useAppearance.getState().update({ mode })
    })),
    ...LOCALES.map((l) => ({ id: `language.${l.id}`, label: c.language(l.label), group: c.groups.language, icon: Languages, keywords: c.keywords.language, run: () => useLocale.getState().setLocale(l.id) })),
    {
      id: 'help.shortcuts',
      label: t.shortcuts.title,
      group: c.groups.help,
      icon: Keyboard,
      keys: shortcutLabel('shortcuts', macKeys()),
      keywords: c.keywords.shortcuts,
      run: () => usePalette.getState().showShortcuts()
    },
    ...(isDesktop() ? [{ id: 'help.setup', label: t.onboarding.restart, group: c.groups.help, icon: Sparkles, run: () => useOnboarding.getState().restart() }] : [])
  ]
}

/** What the palette offers of itself — modules contribute more (registerCommands). Returns: take them back. */
export function registerBuiltinCommands(): () => void {
  const offs = [
    registerCommands('modules', moduleCommands),
    registerCommands('workspace', { commands: workspaceCommands, subscribe: follow(useWorkspace) }),
    registerCommands('recentFiles', recentFilesSource),
    registerCommands('projects', projectsSource),
    registerCommands('agents', agentsSource),
    registerCommands('terminal', terminalSource),
    registerCommands('browser', browserSource),
    registerCommands('notes', notesSource),
    registerCommands('settings', settingsCommands),
    registerCommands('preferences', { commands: preferenceCommands, subscribe: follow(useAppearance, useLocale) })
  ]
  return () => offs.forEach((off) => off())
}
