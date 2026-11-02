import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowUpFromLine, BookOpen, Bug, CircleX, Database, FlaskConical, Radio, Paintbrush, Server, Code2, ExternalLink, Files, FileWarning, FolderGit2, GitBranch, GitGraph as GraphIcon, GitPullRequest, Lock, RefreshCcw, RefreshCw, Search, X, type LucideIcon } from 'lucide-react'
import { create } from 'zustand'
import { ipc, isDesktop } from '@shared/ipc/client'
import { Panel } from '@/components/ui/Panel'
import { isMac } from '@/lib/platform'
import { cn } from '@/lib/cn'
import { Select } from '@/components/ui/Select'
import { useT } from '@/lib/i18n'
import { useProjects } from '@/features/projects/store'
import { useSession } from '@/features/session/store'
import type { ModuleId } from '@/types'
import { useEditor, type EditorTab } from '../store'
import { useScm, type EditorPane } from '../scm'
import { FileTree } from './FileTree'
import { EditorTabs } from './EditorTabs'
import { DiffHeader, ScmPanel } from './ScmPanel'
import { SearchPanel } from './SearchPanel'
import { QuickOpen } from './QuickOpen'
import { buildCommands } from '../commands'
import { projectProblems, useProblems } from '../problems'
import { useDebug } from '../debug'
import { useLanguages } from '../languages'
import { isSassFile, useLive } from '../live'
import { LANGUAGES } from '@shared/types/languages'
import { WORKBENCH_COMMANDS } from '@shared/types/migrate'
import { useEditorPrefs } from '../prefs'
import { matchesStroke, parseKeybinding } from '../keys'
import { DebugConsole, DebugPanel } from './DebugPanel'
import { RemotePanel } from './RemotePanel'
import { useSftp } from '../sftp'
import { PullsPanel } from './PullsPanel'
import { PullDetail } from './PullDetail'
import { useGitHub } from '../github'
import { MongoPanel } from './MongoPanel'
import { TestsPanel } from './TestsPanel'
import { useTests } from '../tests'
import { MongoView } from './MongoView'
import { useMongo } from '../mongo'
import { useRemote } from '@/features/remote/store'
import { useLintStatus } from '../lintStatus'
import type { PickItem } from '../scm'
import { GitGraph } from './GitGraph'
import type { CursorInfo } from './CodeEditor'

// Monaco is a few MB — it loads the first time the Editor module opens.
const CodeEditor = lazy(() => import('./CodeEditor'))
const DiffView = lazy(() => import('./DiffView'))
const NotebookView = lazy(() => import('./NotebookView'))

const isNotebook = (tab?: { path: string }) => !!tab?.path.toLowerCase().endsWith('.ipynb')

const PANES: { id: EditorPane; icon: LucideIcon }[] = [
  { id: 'files', icon: Files },
  { id: 'search', icon: Search },
  { id: 'scm', icon: GitBranch },
  { id: 'graph', icon: GraphIcon },
  { id: 'debug', icon: Bug },
  { id: 'tests', icon: FlaskConical },
  // Only for git repositories.
  { id: 'prs', icon: GitPullRequest },
  { id: 'mongo', icon: Database },
  // Only for projects with a .vscode/sftp.json.
  { id: 'remote', icon: Server }
]

/** VS Code's activity bar: explorer, search, source control (with the change count) and the git graph. */
function ActivityBar() {
  const t = useT()
  const pane = useScm((s) => s.pane)
  const changes = useScm((s) => s.status?.files.length ?? 0)
  const sftp = useSftp((s) => s.targets.length > 0)
  const repo = useScm((s) => !!s.status?.repo)
  const shown = (id: EditorPane) => (id === 'remote' ? sftp : id === 'prs' ? repo : true)
  return (
    <nav aria-label={t.editor.title} className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-hud/60 py-2">
      {PANES.filter((p) => shown(p.id)).map(({ id, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-label={t.scm.panes[id]}
          title={t.scm.panes[id]}
          aria-pressed={pane === id}
          onClick={() => useScm.getState().setPane(id)}
          className={cn(
            'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors',
            pane === id ? 'bg-cyan/[0.1] text-cyan' : 'text-text-muted hover:bg-elevated/60 hover:text-text-primary'
          )}
        >
          <Icon size={17} />
          {id === 'scm' && changes > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-cyan px-1 text-center font-mono text-[9.5px] font-semibold leading-4 text-void">
              {changes > 99 ? '99+' : changes}
            </span>
          )}
        </button>
      ))}
    </nav>
  )
}

/** Live Server and the Sass watcher in the command palette. */
function liveCommands(t: ReturnType<typeof useT>): PickItem[] {
  const live = () => useLive.getState()
  const shown = () => useEditor.getState().tabs.find((x) => x.id === useEditor.getState().focusedId())
  return [
    { id: 'live.start', label: `Live Server: ${t.live.goLive}`, run: () => live().start(shown()?.path.match(/\.html?$/i) ? shown()!.path : undefined) },
    { id: 'live.stop', label: `Live Server: ${t.live.stop}`, run: () => live().stop() },
    { id: 'sass.watch', label: `Sass: ${t.live.toggleSass}`, run: () => live().toggleSass() }
  ]
}

/** Remote-SSH and Dev Containers in the command palette (desktop app). */
function remoteCommands(t: ReturnType<typeof useT>): PickItem[] {
  const remote = () => useRemote.getState()
  return [
    {
      id: 'remote.ssh',
      label: t.remote.paletteSsh,
      run: async () => {
        await remote().loadHosts()
        useScm.getState().openPick({
          placeholder: t.remote.pickHost,
          items: remote().hosts.map((h) => ({ id: h.name, label: h.name, detail: h.hostName && `${h.user ? `${h.user}@` : ''}${h.hostName}`, run: () => remote().ssh(h.name) })),
          onText: (target) => remote().ssh(target)
        })
      }
    },
    { id: 'remote.container', label: t.remote.paletteContainer, run: () => remote().container(useEditor.getState().projectId!) }
  ]
}

/** The test explorer in the command palette. */
function testCommands(t: ReturnType<typeof useT>): PickItem[] {
  const run = (id?: string) => {
    useScm.getState().setPane('tests')
    return useTests.getState().runTests(id)
  }
  return [
    { id: 'tests.runAll', label: t.tests.paletteRunAll, run: () => run() },
    {
      id: 'tests.runFile',
      label: t.tests.paletteRunFile,
      run: () => {
        const editor = useEditor.getState()
        const path = editor.tabs.find((x) => x.id === editor.focusedId())?.path
        return path && run(path)
      }
    }
  ]
}

/** The debugger in the command palette. */
function debugCommands(t: ReturnType<typeof useT>): PickItem[] {
  const d = t.debug
  const debug = () => useDebug.getState()
  const label = (s: string) => `${t.palette.debugCategory}: ${s}`
  return [
    { id: 'debug.start', label: label(d.start), keys: 'F5', run: () => debug().start() },
    { id: 'debug.stop', label: label(d.stop), keys: '⇧F5', run: () => debug().stop() },
    { id: 'debug.restart', label: label(d.restart), keys: '⇧⌘F5', run: () => debug().restart() },
    { id: 'debug.continue', label: label(d.continue), run: () => debug().control('continue') },
    { id: 'debug.stepOver', label: label(d.stepOver), keys: 'F10', run: () => debug().control('stepOver') },
    { id: 'debug.stepInto', label: label(d.stepInto), keys: 'F11', run: () => debug().control('stepInto') },
    { id: 'debug.stepOut', label: label(d.stepOut), keys: '⇧F11', run: () => debug().control('stepOut') },
    { id: 'debug.breakpoint', label: label(d.toggleBreakpoint), keys: 'F9', run: toggleBreakpointAtCursor },
    { id: 'debug.view', label: label(d.title), run: () => useScm.getState().setPane('debug') },
    { id: 'debug.console', label: label(d.console), run: () => debug().setConsoleOpen(true) }
  ]
}

/** The user's own keybindings for workbench commands (moved over from VS Code): true when one ran. */
function runUserBinding(e: KeyboardEvent, commands: () => PickItem[]): boolean {
  for (const b of useEditorPrefs.getState().settings.keybindings ?? []) {
    const id = WORKBENCH_COMMANDS[b.command]
    const strokes = id ? parseKeybinding(b.key) : null
    if (!strokes || strokes.length !== 1 || !matchesStroke(strokes[0], e)) continue
    if (id === 'palette') useScm.getState().setQuickOpen(true, '>')
    else void commands().find((c) => c.id === id)?.run()
    return true
  }
  return false
}

/** F5 & co. — VS Code's debug keys. True when the key was one of them. */
function debugKey(e: KeyboardEvent): boolean {
  const debug = useDebug.getState()
  const { session } = debug
  const live = !!session && session.status !== 'exited'
  const paused = session?.status === 'paused'
  if (e.key === 'F5' && e.shiftKey && (e.metaKey || e.ctrlKey)) void debug.restart()
  else if (e.key === 'F5' && e.shiftKey) void debug.stop()
  else if (e.key === 'F5') void (paused ? debug.control('continue') : live ? undefined : debug.start())
  else if (e.key === 'F6' && live && !paused) void debug.control('pause')
  else if (e.key === 'F10' && paused) void debug.control('stepOver')
  else if (e.key === 'F11' && paused) void debug.control(e.shiftKey ? 'stepOut' : 'stepInto')
  else if (e.key === 'F9') toggleBreakpointAtCursor()
  else return false
  return true
}

/**
 * The focused editor's cursor. A store of its own, not EditorView state: it
 * moves on every keystroke, and only the status bar bits showing it should
 * re-render then — not the whole editor (tree, tabs, panels).
 */
const useCursor = create<{ cursor?: CursorInfo }>(() => ({}))
const setCursor = (cursor: CursorInfo) => useCursor.setState({ cursor })

function CursorPosition() {
  const t = useT()
  const cursor = useCursor((s) => s.cursor)
  return cursor ? <span>{t.editor.lineCol(cursor.line, cursor.col)}</span> : null
}

function CursorLanguage() {
  const language = useCursor((s) => s.cursor?.language)
  return language ? <span>{language}</span> : null
}

/** F9: a breakpoint on the cursor line of the file on screen. */
function toggleBreakpointAtCursor(): void {
  const { tabs, focusedId } = useEditor.getState()
  const tab = tabs.find((x) => x.id === focusedId())
  if (tab) useDebug.getState().toggleBreakpoint(tab.projectId, tab.path, useCursor.getState().cursor?.line ?? 1)
}

/** How often open files are compared with the disk while the editor is visible. */
const DISK_POLL_MS = 3000

const button =
  'flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-sans text-[12px] font-medium transition-colors'
const primary = cn(button, 'border-cyan/40 bg-cyan/[0.06] text-cyan hover:bg-cyan/[0.12]')
const quiet = cn(button, 'border-hud/60 text-text-secondary hover:border-hud-strong hover:text-text-primary')

function Banner({ tone, children }: { tone: 'warn' | 'info'; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 font-sans text-[12.5px]',
        tone === 'warn' ? 'border-amber/30 bg-amber/[0.07] text-text-primary' : 'border-hud/60 bg-elevated/40 text-text-secondary'
      )}
    >
      {children}
    </div>
  )
}

function Centered({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
      {icon}
      <p className="font-sans text-[14px] font-semibold text-text-primary">{title}</p>
      {children}
    </div>
  )
}

/** What the editor area shows when the active tab has no text to edit. */
function Placeholder({ tab, onExternal }: { tab?: EditorTab; onExternal?: () => void }) {
  const t = useT()
  const key = isMac ? '⌘' : 'Ctrl+'
  if (!tab) {
    return (
      <Centered icon={<Code2 size={28} className="text-text-muted" />} title={t.editor.openFromExplorer}>
        <p className="font-mono text-[11px] text-text-muted">
          {t.editor.shortcuts(key)}
        </p>
      </Centered>
    )
  }
  if (tab.loading) return <Centered icon={<RefreshCw size={22} className="animate-spin text-text-muted" />} title={t.common.loading} />
  const vsCode = onExternal && (
    <button type="button" onClick={onExternal} className={quiet}>
      <ExternalLink size={13} /> {t.editor.openInVsCode}
    </button>
  )
  if (tab.unsupported) {
    return (
      <Centered
        icon={<FileWarning size={28} className="text-text-muted" />}
        title={tab.unsupported === 'binary' ? t.editor.binary : t.editor.tooLarge}
      >
        <p className="font-sans text-[13px] text-text-secondary">{t.editor.textOnly}</p>
        {vsCode}
      </Centered>
    )
  }
  return (
    <Centered icon={<AlertTriangle size={26} className="text-danger" />} title={t.editor.cantOpen}>
      <p className="font-sans text-[13px] text-text-secondary">{tab.error}</p>
      <button type="button" onClick={() => void useEditor.getState().reload(tab.id)} className={quiet}>
        <RefreshCw size={13} /> {t.editor.tryAgain}
      </button>
    </Centered>
  )
}


/** Tabs showing their notebook as JSON (the text editor underneath). */
const rawNotebooks = new Set<string>()

/** A notebook over its file's text editor — or the JSON, with the way back. */
function NotebookLayer({ tab, readOnly }: { tab: EditorTab; readOnly: boolean }) {
  const t = useT()
  const [raw, setRaw] = useState(rawNotebooks.has(tab.id))
  const toggle = () => {
    if (raw) rawNotebooks.delete(tab.id)
    else rawNotebooks.add(tab.id)
    setRaw(!raw)
  }
  if (raw)
    return (
      <button type="button" onClick={toggle} className="absolute right-6 top-2 z-10 flex items-center gap-1 rounded border border-cyan/40 bg-elevated/95 px-2 py-1 font-sans text-[11.5px] text-cyan hover:bg-elevated">
        <BookOpen size={12} /> {t.notebook.notebook}
      </button>
    )
  return (
    <div className="absolute inset-0 z-[5]">
      <Suspense fallback={null}>
        <NotebookView key={tab.id} tab={tab} readOnly={readOnly} onRaw={toggle} />
      </Suspense>
    </div>
  )
}

/**
 * The Editor module: a project's files on the left, open files as tabs, and
 * Monaco — VS Code's editor core — in the middle. Saving is explicit (⌘S);
 * the disk stays the source of truth: changes made elsewhere (an agent, git,
 * VS Code) flow into clean tabs, and conflicting ones ask first.
 */
export function EditorView({ active, onNavigate }: { active: boolean; onNavigate: (id: ModuleId) => void }) {
  const t = useT()
  const projects = useProjects((s) => s.projects)
  const [projectsLoaded, setProjectsLoaded] = useState(projects.length > 0)
  const { projectId, tabs, activeId, closing, splitId, focusRight } = useEditor()
  const tab = tabs.find((x) => x.id === activeId)
  const splitTab = tabs.find((x) => x.id === splitId)
  /** The file of the focused editor (of a split) — the status bar and file commands are about it. */
  const focused = focusRight && splitTab ? splitTab : tab
  const closingTab = tabs.find((x) => x.id === closing)
  const info = useSession((s) => s.info)
  const desktop = isDesktop()
  // Writing project files can run code (hooks, scripts) — remote clients may
  // only when the core allows remote shells.
  const readOnly = !desktop && info?.remoteTerminal === false
  const session = useDebug((s) => s.session)
  const fileLanguage = useLanguages((s) => (focused ? s.files[focused.id] : undefined))
  const live = useLive()
  const server = live.servers.find((x) => x.projectId === projectId)
  const sassOn = !!(projectId && live.sassWatching[projectId])
  const missingServer = fileLanguage && !fileLanguage.available ? LANGUAGES.find((l) => l.id === fileLanguage.language) : undefined
  const consoleOpen = useDebug((s) => s.consoleOpen)
  const names = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const { pane, diff, quickOpen, quickQuery, pick, status, busy, error: scmError } = useScm()
  const ghError = useGitHub((s) => s.error)
  // A pull request takes the editor area while its pane is open.
  const pullOpen = useGitHub((s) => !!s.detail) && pane === 'prs'
  // So does a MongoDB collection while the databases pane is open.
  const mongoOpen = useMongo((s) => !!s.open) && pane === 'mongo'
  const mongoError = useMongo((s) => s.error)
  const lintError = useLintStatus((s) => (projectId ? s.errors[projectId] : undefined))
  const commands = useRef<() => PickItem[]>()
  commands.current = () =>
    buildCommands(t, {
      onNavigate,
      readOnly,
      extra: [...(readOnly ? [] : [...debugCommands(t), ...liveCommands(t), ...testCommands(t)]), ...(desktop && projectId ? remoteCommands(t) : []), { id: 'migrate', label: `Mindeck: ${t.migrate.title}`, run: () => onNavigate('settings') }]
    })
  const byFile = useProblems((s) => s.byFile)
  const problems = useMemo(() => (projectId ? projectProblems(byFile, projectId) : []), [byFile, projectId])
  const errors = problems.filter((p) => p.severity === 'error').length
  const showProblems = () =>
    useScm.getState().openPick({
      placeholder: t.problems.title,
      items: problems.map((p) => ({
        id: `${p.path}:${p.line}:${p.col}:${p.message}`,
        label: `${p.severity === 'error' ? '⛔' : '⚠️'} ${p.message}`,
        detail: `${p.path}:${p.line}${p.code === undefined ? '' : ` · ${p.source ? `${p.source} ${p.code}` : `TS${p.code}`}`}`,
        run: () => {
          useScm.getState().closeDiff()
          return useEditor.getState().openAt(p.path, p.line)
        }
      }))
    })

  useEffect(() => {
    void useProjects
      .getState()
      .load()
      .then(() => setProjectsLoaded(true))
  }, [])

  // Pick a project: the one selected in Projects, else the first.
  useEffect(() => {
    if (!projects.length || projects.some((p) => p.id === useEditor.getState().projectId)) return
    const selected = useProjects.getState().selectedId
    void useEditor.getState().selectProject((projects.find((p) => p.id === selected) ?? projects[0]).id)
  }, [projects])

  // While visible: follow the disk, and ⌘S / Ctrl+S saves.
  useEffect(() => {
    if (!active) return
    // Disk and git both follow edits made elsewhere (agents, terminals, other editors).
    // One check at a time: a slow core (big repo, remote link) must not pile up polls.
    let checking = false
    const check = () => {
      if (checking) return
      checking = true
      void Promise.allSettled([useEditor.getState().checkDisk(), useScm.getState().refresh()]).then(() => {
        checking = false
      })
    }
    const onKey = (e: KeyboardEvent) => {
      const scm = useScm.getState()
      if (runUserBinding(e, () => commands.current!())) return e.preventDefault()
      if (debugKey(e)) return e.preventDefault()
      if (e.key === 'F1') {
        scm.setQuickOpen(true, '>')
        return e.preventDefault()
      }
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'g') {
        scm.setQuickOpen(true, ':')
        return e.preventDefault()
      }
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key === 's' && e.altKey) void useEditor.getState().saveAll()
      else if (key === 's') void useEditor.getState().save()
      else if (key === 'p') scm.setQuickOpen(true, e.shiftKey ? '>' : '')
      else if (key === 'f' && e.shiftKey) scm.setPane('search')
      else if (key === 'g' && e.shiftKey) scm.setPane('scm')
      else if (key === '\\') {
        const editor = useEditor.getState()
        if (editor.splitId) editor.closeSplit()
        else editor.split()
      } else return
      e.preventDefault()
    }
    check()
    const timer = window.setInterval(check, DISK_POLL_MS)
    window.addEventListener('focus', check)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
      window.removeEventListener('keydown', onKey)
    }
  }, [active])

  // The debugger follows the core's session events while the editor is mounted.
  useEffect(() => useDebug.getState().connect(), [])
  // Live Server and the Sass watcher follow the core.
  useEffect(() => useLive.getState().connect(), [])
  // SFTP: the project's targets, upload on save.
  useEffect(() => {
    void useSftp.getState().load()
    const offTests = useTests.getState().connect()
    const offSftp = useSftp.getState().connect()
    return () => {
      offTests()
      offSftp()
    }
  }, [])
  // The cursor belongs to this view: gone with it.
  useEffect(() => () => useCursor.setState({ cursor: undefined }), [])
  // Settings, keybindings and snippets taken over from VS Code / Cursor.
  useEffect(() => void useEditorPrefs.getState().load(), [])

  // Unsaved edits veto closing the window; the desktop app then asks (main.ts).
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (!useEditor.getState().tabs.some((x) => x.dirty)) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])

  const openExternal = desktop
    ? () => {
        const call = focused
          ? ipc('projects:openFile', { id: focused.projectId, file: focused.path, line: useCursor.getState().cursor?.line })
          : ipc('projects:openInEditor', { id: projectId! })
        void call.catch(() => {})
      }
    : undefined

  if (!projects.length) {
    return (
      <Panel title={t.editor.title} corners className="min-h-0 flex-1" bodyClassName="relative">
        {projectsLoaded && (
          <Centered icon={<FolderGit2 size={28} className="text-text-muted" />} title={t.editor.noProjects}>
            <p className="font-sans text-[13px] text-text-secondary">{t.editor.opensProjectFiles}</p>
            <button type="button" onClick={() => onNavigate('projects')} className={primary}>
              {t.editor.addProject}
            </button>
          </Centered>
        )}
      </Panel>
    )
  }

  const hasText = tab?.content !== undefined

  return (
    <Panel
      title={t.editor.title}
      corners
      flush
      className="min-h-0 flex-1"
      bodyClassName="flex"
      headerRight={
        openExternal && (
          <button type="button" onClick={openExternal} className={quiet} title={t.editor.openInVsCode}>
            <ExternalLink size={13} /> VS Code
          </button>
        )
      }
    >
      <ActivityBar />

      {/* Sidebar: explorer, search or source control */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-hud/60">
        <div className="flex items-center gap-1.5 p-2">
          <Select
            label={t.editor.project}
            icon={FolderGit2}
            value={projectId ?? ''}
            onChange={(id) => void useEditor.getState().selectProject(id)}
            options={projects.map((p) => ({ value: p.id, label: p.name, hint: p.path }))}
            className="flex-1"
          />
          <button
            type="button"
            aria-label={t.editor.refreshFiles}
            onClick={() => void useEditor.getState().refreshTree()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated/60 hover:text-cyan"
          >
            <RefreshCw size={13} />
          </button>
        </div>
        {pane === 'search' ? (
          <SearchPanel />
        ) : pane === 'scm' || pane === 'graph' ? (
          <ScmPanel />
        ) : pane === 'remote' ? (
          <RemotePanel />
        ) : pane === 'prs' ? (
          <PullsPanel />
        ) : pane === 'mongo' ? (
          <MongoPanel />
        ) : pane === 'tests' ? (
          projectId && <TestsPanel key={projectId} />
        ) : pane === 'debug' ? (
          projectId && <DebugPanel />
        ) : (
          projectId && <FileTree projectId={projectId} readOnly={readOnly} />
        )}
      </aside>

      {/* Tabs · banners · Monaco (or a diff, or the graph) · status */}
      <section className="flex min-w-0 flex-1 flex-col">
        {live.error && (
          <Banner tone="warn">
            <AlertTriangle size={13} className="shrink-0 text-danger" />
            <span className="mr-auto whitespace-pre-wrap font-mono text-[11.5px]">{live.error}</span>
            <button type="button" aria-label={t.common.dismiss} onClick={() => useLive.getState().clearError()} className="text-text-muted hover:text-text-primary">
              <X size={13} />
            </button>
          </Banner>
        )}
        {mongoError && (
          <Banner tone="warn">
            <AlertTriangle size={13} className="shrink-0 text-danger" />
            <span className="mr-auto whitespace-pre-wrap font-mono text-[11.5px]">{mongoError}</span>
            <button type="button" aria-label={t.common.dismiss} onClick={() => useMongo.getState().clearError()} className="text-text-muted hover:text-text-primary">
              <X size={13} />
            </button>
          </Banner>
        )}
        {ghError && (
          <Banner tone="warn">
            <AlertTriangle size={13} className="shrink-0 text-danger" />
            <span className="mr-auto whitespace-pre-wrap font-mono text-[11.5px]">{ghError}</span>
            <button type="button" aria-label={t.common.dismiss} onClick={() => useGitHub.getState().clearError()} className="text-text-muted hover:text-text-primary">
              <X size={13} />
            </button>
          </Banner>
        )}
        {scmError && (
          <Banner tone="warn">
            <AlertTriangle size={13} className="shrink-0 text-danger" />
            <span className="mr-auto whitespace-pre-wrap font-mono text-[11.5px]">{scmError}</span>
            <button type="button" aria-label={t.common.dismiss} onClick={() => useScm.getState().clearError()} className="text-text-muted hover:text-text-primary">
              <X size={13} />
            </button>
          </Banner>
        )}
        {diff ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <DiffHeader title={diff.title} onClose={() => useScm.getState().closeDiff()} />
            <div className="relative min-h-0 flex-1">
              <Suspense fallback={<Centered icon={<RefreshCw size={22} className="animate-spin text-text-muted" />} title={t.editor.starting} />}>
                <DiffView path={diff.path} original={diff.original} modified={diff.modified} />
              </Suspense>
            </div>
          </div>
        ) : pane === 'graph' ? (
          <div className="min-h-0 flex-1">
            <GitGraph />
          </div>
        ) : pullOpen ? (
          <PullDetail />
        ) : mongoOpen ? (
          <MongoView />
        ) : null}
        <div className={cn('flex min-h-0 flex-1 flex-col', (diff || pane === 'graph' || pullOpen || mongoOpen) && 'hidden')}>
          <EditorTabs projectNames={names} />

          {closingTab ? (
            <Banner tone="warn">
              <span className="mr-auto">{t.editor.saveBeforeClose(closingTab.name)}</span>
              <button type="button" onClick={() => void useEditor.getState().saveAndClose(closingTab.id)} className={primary} disabled={readOnly}>
                {t.common.save}
              </button>
              <button type="button" onClick={() => useEditor.getState().close(closingTab.id)} className={quiet}>
                {t.editor.dontSave}
              </button>
              <button type="button" onClick={() => useEditor.getState().cancelClose()} className={quiet}>
                {t.common.cancel}
              </button>
            </Banner>
          ) : tab?.conflict ? (
            <Banner tone="warn">
              <span className="mr-auto">{t.editor.changedOnDisk(tab.name)}</span>
              <button type="button" onClick={() => void useEditor.getState().reload(tab.id)} className={quiet}>
                {t.editor.loadDisk}
              </button>
              <button type="button" onClick={() => void useEditor.getState().save(tab.id, { force: true })} className={primary} disabled={readOnly}>
                {t.editor.keepMine}
              </button>
            </Banner>
          ) : tab?.deleted ? (
            <Banner tone="info">{t.editor.deletedOnDisk(tab.name)}</Banner>
          ) : tab?.error && hasText ? (
            <Banner tone="warn">
              <AlertTriangle size={13} className="text-danger" /> {tab.error}
            </Banner>
          ) : null}

          <div className="flex min-h-0 flex-1">
            <div className={cn('relative min-h-0 min-w-0 flex-1', splitTab && 'border-r border-hud/60')} onMouseDown={() => useEditor.getState().focusGroup(false)}>
              {splitTab && <span aria-hidden className={cn('absolute inset-x-0 top-0 z-10 h-px', focusRight ? 'bg-transparent' : 'bg-cyan')} />}
              <Suspense fallback={<Centered icon={<RefreshCw size={22} className="animate-spin text-text-muted" />} title={t.editor.starting} />}>
                <CodeEditor tab={tab} readOnly={readOnly} onCursor={setCursor} />
              </Suspense>
              {hasText && isNotebook(tab) && <NotebookLayer tab={tab!} readOnly={readOnly} />}
              {!hasText && (
                <div className="absolute inset-0 bg-panel/80">
                  <Placeholder tab={tab} onExternal={openExternal} />
                </div>
              )}
            </div>
            {splitTab && (
              <section aria-label={t.editor.splitLabel(splitTab.name)} className="flex min-h-0 min-w-0 flex-1 flex-col" onMouseDown={() => useEditor.getState().focusGroup(true)}>
                <div className={cn('flex h-7 shrink-0 items-center gap-1.5 border-b px-2 font-sans text-[12px]', focusRight ? 'border-cyan/50 text-text-primary' : 'border-hud/60 text-text-muted')}>
                  <span className="truncate">{splitTab.name}</span>
                  {splitTab.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary" />}
                  <button type="button" aria-label={t.editor.closeSplit} title={t.editor.closeSplit} onClick={() => useEditor.getState().closeSplit()} className="ml-auto rounded p-0.5 text-text-muted hover:bg-elevated hover:text-text-primary">
                    <X size={12} />
                  </button>
                </div>
                <div className="relative min-h-0 flex-1">
                  <Suspense fallback={null}>
                    <CodeEditor secondary tab={splitTab} readOnly={readOnly} onCursor={setCursor} />
                  </Suspense>
                  {splitTab.content !== undefined && isNotebook(splitTab) && <NotebookLayer tab={splitTab} readOnly={readOnly} />}
                  {splitTab.content === undefined && (
                    <div className="absolute inset-0 bg-panel/80">
                      <Placeholder tab={splitTab} onExternal={openExternal} />
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>

        </div>

        {consoleOpen && <DebugConsole />}

        <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-hud/60 px-3 font-mono text-[11px] text-text-muted">
          {lintError && (
            <button type="button" title={t.lint.error(lintError)} onClick={() => void useLintStatus.getState().restart()} className="shrink-0 text-amber hover:text-text-primary">
              {t.lint.failed}
            </button>
          )}
          {session && session.status !== 'exited' && (
            <button
              type="button"
              onClick={() => {
                useScm.getState().setPane('debug')
                useDebug.getState().setConsoleOpen(true)
              }}
              className={cn('flex shrink-0 items-center gap-1 hover:text-text-primary', session.status === 'paused' ? 'text-amber' : 'text-cyan')}
            >
              <Bug size={11} /> {t.debug.status}: {session.status === 'paused' ? t.debug.paused(t.debug.reasons[session.reason as keyof typeof t.debug.reasons] ?? session.reason ?? '') : t.debug[session.status]}
            </button>
          )}
          {status?.repo && (
            <span className="flex shrink-0 items-center gap-3">
              <button type="button" onClick={() => useScm.getState().setPane('scm')} title={t.scm.panes.scm} className="flex items-center gap-1 hover:text-text-primary">
                <GitBranch size={12} /> {status.branch ?? `${status.head} (${t.scm.detached})`}
              </button>
              {status.upstream ? (
                <button
                  type="button"
                  aria-label={t.scm.sync(status.behind, status.ahead)}
                  title={t.scm.sync(status.behind, status.ahead)}
                  disabled={!!busy}
                  onClick={() => void useScm.getState().sync()}
                  className="flex items-center gap-1 hover:text-text-primary disabled:opacity-50"
                >
                  <RefreshCcw size={11} className={cn(busy && 'animate-spin')} /> {status.behind}↓ {status.ahead}↑
                </button>
              ) : (
                <button type="button" aria-label={t.scm.publish} title={t.scm.publish} disabled={!!busy} onClick={() => void useScm.getState().push()} className="flex items-center gap-1 hover:text-text-primary disabled:opacity-50">
                  <ArrowUpFromLine size={11} /> {t.scm.publish}
                </button>
              )}
            </span>
          )}
          {!readOnly && (server || focused?.path.match(/\.html?$/i)) && (
            <button
              type="button"
              title={server ? t.live.stopServer(server.url) : t.live.goLive}
              onClick={() => void (server ? useLive.getState().stop() : useLive.getState().start(focused?.path))}
              className={cn('flex shrink-0 items-center gap-1 hover:text-text-primary', server && 'text-cyan')}
            >
              <Radio size={11} /> {server ? t.live.port(server.port) : t.live.goLive}
            </button>
          )}
          {!readOnly && (sassOn || (focused && isSassFile(focused.path))) && (
            <button
              type="button"
              title={sassOn && live.sass?.projectId === projectId && live.sass.written.length ? t.live.compiled(live.sass.written.join(', ')) : t.live.watchSassHint}
              onClick={() => void useLive.getState().toggleSass()}
              className={cn('flex shrink-0 items-center gap-1 hover:text-text-primary', sassOn && 'text-cyan')}
            >
              <Paintbrush size={11} /> {sassOn ? t.live.watchingSass : t.live.watchSass}
            </button>
          )}
          {problems.length > 0 && (
            <button type="button" onClick={showProblems} title={t.problems.title} className="flex shrink-0 items-center gap-2 hover:text-text-primary">
              <span className={cn('flex items-center gap-1', errors > 0 && 'text-danger')}>
                <CircleX size={11} /> {errors}
              </span>
              <span className={cn('flex items-center gap-1', problems.length > errors && 'text-amber')}>
                <AlertTriangle size={11} /> {problems.length - errors}
              </span>
            </button>
          )}
          {focused && focused.content !== undefined && (
            <>
              <span className="min-w-0 flex-1 truncate">
                {names.get(focused.projectId)} › {focused.path.split('/').join(' › ')}
              </span>
              {readOnly && (
                <span className="flex items-center gap-1" title={t.editor.readOnlyHint}>
                  <Lock size={11} /> {t.editor.readOnly}
                </span>
              )}
              <CursorPosition />
              {missingServer && (
                <button type="button" title={t.languages.noServerHint} onClick={() => onNavigate('settings')} className="shrink-0 text-amber/80 hover:text-amber">
                  {t.languages.noServer(missingServer.name)}
                </button>
              )}
              <CursorLanguage />
              <span className={cn(focused.dirty && 'text-amber')}>{focused.saving ? t.editor.saving : focused.dirty ? t.editor.unsaved : t.editor.saved}</span>
            </>
          )}
        </footer>
      </section>
      {quickOpen && (
        <QuickOpen key={pick ? `pick:${pick.placeholder}` : `q:${quickQuery}`} commands={commands.current()} />
      )}
    </Panel>
  )
}
