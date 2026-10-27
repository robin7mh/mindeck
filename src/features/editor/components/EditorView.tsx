import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpFromLine, Bug, CircleX, CloudUpload, Code2, Database, FlaskConical, Radio, Paintbrush, Server, Files, FolderGit2, GitBranch, GitGraph as GraphIcon, GitPullRequest, ListTree, Lock, RefreshCcw, RefreshCw, Search, X, type LucideIcon } from 'lucide-react'
import { isDesktop } from '@shared/ipc/client'
import { Panel } from '@/components/ui/Panel'
import { cn } from '@/lib/cn'
import { Select } from '@/components/ui/Select'
import { useT } from '@/lib/i18n'
import { useProjects } from '@/features/projects/store'
import { useSession } from '@/features/session/store'
import type { ModuleId } from '@/types'
import { useEditor } from '../store'
import { needsPublish, useScm, type EditorPane } from '../scm'
import { useOutline } from '../outline'
import { FileTree } from './FileTree'
import { DiffHeader, ScmPanel } from './ScmPanel'
import { SearchPanel } from './SearchPanel'
import { Banner, Centered, EditorGroup, primary, Starting } from './EditorGroup'
import { EditorGrid } from './EditorGrid'
import { OutlinePanel } from './OutlinePanel'
import { useSearch } from '../search'
import { useBlame } from '../blame'
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
import { TrustBanner } from './TrustBanner'
import type { CursorInfo } from './CodeEditor'
import { usePaneFocused } from '@/features/workspace/pane'
import { usePalette } from '@/features/palette/store'
import { allCommands, registerCommands } from '@/features/palette/registry'
import { showModule } from '@/features/palette/reveal'

// Monaco is a few MB — it loads the first time the Editor module opens.
const DiffView = lazy(() => import('./DiffView'))

const PANES: { id: EditorPane; icon: LucideIcon }[] = [
  { id: 'files', icon: Files },
  { id: 'outline', icon: ListTree },
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

/** VS Code's activity bar: explorer, outline, search, source control (with the change count) and the git graph. */
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
    if (id === 'palette') usePalette.getState().show()
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

/** The cursor line of the file in the focused group, for F9. */
let cursorLine = 1
function toggleBreakpointAtCursor(): void {
  const { tabs, focusedId } = useEditor.getState()
  const tab = tabs.find((x) => x.id === focusedId())
  if (tab) useDebug.getState().toggleBreakpoint(tab.projectId, tab.path, cursorLine)
}

/** How often open files are compared with the disk while the editor is visible. */
const DISK_POLL_MS = 3000
/** …and while the window is on screen without the focus (next to another app, an agent at work): less often. */
const BLURRED_POLL_MS = 15_000

/** ⌘1…⌘9 (Ctrl elsewhere) — the editor group to focus (0-based), or undefined. */
function groupKey(e: KeyboardEvent): number | undefined {
  const digit = /^Digit([1-9])$/.exec(e.code)?.[1] ?? /^[1-9]$/.exec(e.key)?.[0]
  return digit && !e.shiftKey && !e.altKey ? Number(digit) - 1 : undefined
}

/**
 * The Editor module: a project's files on the left, open files in editor
 * groups (tabs and Monaco — VS Code's editor core — in a grid of as many as
 * the user splits). Saving is explicit (⌘S); the disk stays the source of
 * truth: changes made elsewhere (an agent, git, VS Code) flow into clean
 * tabs, and conflicting ones ask first.
 */
export function EditorView({ active, onNavigate }: { active: boolean; onNavigate: (id: ModuleId) => void }) {
  const t = useT()
  // Next to other modules, the editor's keys work while its pane has the focus.
  const paneFocused = usePaneFocused()
  const projects = useProjects((s) => s.projects)
  const [projectsLoaded, setProjectsLoaded] = useState(projects.length > 0)
  const projectId = useEditor((s) => s.projectId)
  const editorProject = projects.find((p) => p.id === projectId)
  const activeGroup = useEditor((s) => s.activeGroup)
  /** The file of the focused group — the status bar and file commands are about it. */
  const focused = useEditor((s) => s.tabs.find((x) => x.id === s.activeId))
  const info = useSession((s) => s.info)
  const desktop = isDesktop()
  // Writing project files can run code (hooks, scripts) — remote clients may
  // only when the core allows remote shells.
  const readOnly = !desktop && info?.remoteTerminal === false
  const [cursors, setCursors] = useState<Record<string, CursorInfo>>({})
  const cursor = cursors[activeGroup]
  cursorLine = cursor?.line ?? 1
  const onCursor = (group: string, info: CursorInfo) => {
    setCursors((c) => ({ ...c, [group]: info }))
    useOutline.getState().setCursor(group, { line: info.line, column: info.col })
  }
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
  const blameShown = useBlame((s) => s.shown)
  // A pull request takes the editor area while its pane is open.
  const pullOpen = useGitHub((s) => !!s.detail) && pane === 'prs'
  // So does a MongoDB collection while the databases pane is open.
  const mongoOpen = useMongo((s) => !!s.open) && pane === 'mongo'
  const mongoError = useMongo((s) => s.error)
  const lintError = useLintStatus((s) => (projectId ? s.errors[projectId] : undefined))
  const overlayKind = diff ? 'diff' : pane === 'graph' ? 'graph' : pullOpen ? 'pull' : mongoOpen ? 'mongo' : undefined
  const [overlayHost, setOverlayHost] = useState<string>()
  useEffect(() => {
    if (overlayKind) setOverlayHost(useEditor.getState().activeGroup)
  }, [overlayKind, diff])
  const hostAlive = useEditor((s) => s.groups.some((g) => g.id === overlayHost))
  const overlayGroup = hostAlive ? overlayHost : activeGroup
  const commands = useRef<() => PickItem[]>()
  commands.current = () =>
    buildCommands(t, {
      readOnly,
      extra: [...(readOnly ? [] : [...debugCommands(t), ...liveCommands(t), ...testCommands(t)]), ...(desktop && projectId ? remoteCommands(t) : [])]
    })
  // The palette lists the editor's commands while the editor is there; running one brings the editor up.
  useEffect(
    () =>
      registerCommands('editor', (dict) =>
        commands.current!().map((c) => ({
          ...c,
          group: dict.nav.editor,
          icon: Code2,
          run: () => {
            showModule('editor')
            return c.run()
          }
        }))
      ),
    []
  )
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

  // While visible: follow the disk, and ⌘S / Ctrl+S saves (while focused).
  useEffect(() => {
    if (!active) return
    // Disk and git both follow edits made elsewhere (agents, terminals, other editors) — not while the
    // window is hidden with Mindeck running in the background (no git status every few seconds for hours),
    // and only now and then while it's on screen without the focus. The window coming back (shown again,
    // or focused) looks right away — once, though both usually come together.
    let blurred = false
    let last = 0
    let returned = -Infinity
    const look = () => {
      last = Date.now()
      void useEditor.getState().checkDisk()
      void useScm.getState().refresh()
    }
    const poll = () => {
      if (document.hidden || (blurred && Date.now() - last < BLURRED_POLL_MS)) return
      look()
    }
    const back = () => {
      if (document.hidden || Date.now() - returned < 1000) return
      returned = Date.now()
      look()
    }
    const onFocus = () => {
      blurred = false
      back()
    }
    const onBlur = () => {
      blurred = true
    }
    const onKey = (e: KeyboardEvent) => {
      const scm = useScm.getState()
      if (runUserBinding(e, () => allCommands(t))) return e.preventDefault()
      if (debugKey(e)) return e.preventDefault()
      if (e.key === 'F1') {
        usePalette.getState().show()
        return e.preventDefault()
      }
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'g') {
        scm.setQuickOpen(true, ':')
        return e.preventDefault()
      }
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      const group = groupKey(e)
      if (group !== undefined) useEditor.getState().focusGroupAt(group)
      else if (key === 's' && e.altKey) void useEditor.getState().saveAll()
      else if (key === 's') void useEditor.getState().save()
      else if (key === 'p' && e.shiftKey) usePalette.getState().show()
      else if (key === 'p') scm.setQuickOpen(true)
      else if (key === 'f' && e.shiftKey) scm.setPane('search')
      else if (key === 'h' && e.shiftKey) {
        scm.setPane('search')
        useSearch.getState().set({ showReplace: true })
      }
      else if (key === 'g' && e.shiftKey) scm.setPane('scm')
      // ⌘W / Ctrl+W: the focused group's tab (asking first when it has unsaved edits) — an empty group of several
      // closes itself, like VS Code; with nothing to close, the workspace closes the pane.
      else if (key === 'w' && !e.shiftKey && !e.altKey && (useEditor.getState().activeId || useEditor.getState().groups.length > 1)) {
        const editor = useEditor.getState()
        if (editor.activeId) editor.requestClose(editor.activeId)
        else editor.closeGroup()
      } else if (key === '\\') useEditor.getState().split('right')
      else return
      e.preventDefault()
    }
    poll()
    const timer = window.setInterval(poll, DISK_POLL_MS)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', back)
    if (paneFocused) window.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', back)
      window.removeEventListener('keydown', onKey)
    }
    // `t`: command titles (user key bindings) follow a language switch.
  }, [active, paneFocused, t])

  // The debugger follows the core's session events while the editor is mounted.
  useEffect(() => useDebug.getState().connect(), [])
  // Project search results stream in as events.
  useEffect(() => useSearch.getState().connect(), [])
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

  // A diff, the git graph, a pull request or a collection takes the place of a group (the focused one when it opened).
  const overlay = diff ? (
    <>
      <DiffHeader title={diff.title} onClose={() => useScm.getState().closeDiff()} />
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<Starting />}>
          <DiffView path={diff.path} original={diff.original} modified={diff.modified} />
        </Suspense>
      </div>
    </>
  ) : pane === 'graph' ? (
    <div className="min-h-0 flex-1">
      <GitGraph />
    </div>
  ) : pullOpen ? (
    <PullDetail />
  ) : mongoOpen ? (
    <MongoView />
  ) : undefined

  return (
    <Panel
      title={t.editor.title}
      corners
      flush
      className="min-h-0 flex-1"
      bodyClassName="flex"
    >
      <ActivityBar />

      {/* Sidebar: explorer, outline, search or source control */}
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
          <SearchPanel readOnly={readOnly} />
        ) : pane === 'scm' || pane === 'graph' ? (
          <ScmPanel readOnly={readOnly} />
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
        ) : pane === 'outline' ? (
          <OutlinePanel />
        ) : (
          projectId && <FileTree projectId={projectId} readOnly={readOnly} />
        )}
      </aside>

      {/* Editor groups (one may show a diff, the graph …) · debug console · status */}
      <section className="flex min-w-0 flex-1 flex-col">
        {editorProject && <TrustBanner project={editorProject} />}
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
        <EditorGrid
          renderGroup={(id, index) => (
            <EditorGroup id={id} index={index} projectNames={names} readOnly={readOnly} overlay={id === overlayGroup ? overlay : undefined} onCursor={onCursor} />
          )}
        />

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
              ) : needsPublish(status) ? (
                <button
                  type="button"
                  onClick={() => {
                    useScm.getState().setPane('scm')
                    useGitHub.getState().setPublishing(true)
                  }}
                  className="flex items-center gap-1 hover:text-text-primary"
                >
                  <CloudUpload size={11} /> {t.scm.publishGitHub}
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
              {cursor && (
                <span>{t.editor.lineCol(cursor.line, cursor.col)}</span>
              )}
              {missingServer && (
                <button type="button" title={t.languages.noServerHint} onClick={() => onNavigate('settings')} className="shrink-0 text-amber/80 hover:text-amber">
                  {t.languages.noServer(missingServer.name)}
                </button>
              )}
              {cursor && <span>{cursor.language}</span>}
              {status?.repo && (
                <button type="button" aria-pressed={!!blameShown[focused.id]} title={t.blame.toggle} onClick={() => useBlame.getState().toggle(focused.id)} className={cn('hover:text-text-primary', blameShown[focused.id] && 'text-cyan')}>
                  {t.blame.show}
                </button>
              )}
              <span className={cn(focused.dirty && 'text-amber')}>{focused.saving ? t.editor.saving : focused.dirty ? t.editor.unsaved : t.editor.saved}</span>
            </>
          )}
        </footer>
      </section>
      {quickOpen && (
        <QuickOpen key={pick ? `pick:${pick.placeholder}` : `q:${quickQuery}`} />
      )}
    </Panel>
  )
}
