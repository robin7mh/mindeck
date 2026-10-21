import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { TerminalSquare } from 'lucide-react'
import { GlowBackground } from './GlowBackground'
import { Panel } from '@/components/ui/Panel'
import { isDesktop, onEvent } from '@shared/ipc/client'
import { TopStatusBar } from '@/components/topbar/TopStatusBar'
import { SideNavigation } from '@/components/nav/SideNavigation'
import { TerminalView } from '@/features/terminal/components/TerminalView'
import { useTerminals } from '@/features/terminal/store'
import { EditorView } from '@/features/editor/components/EditorView'
import { Dashboard } from '@/features/dashboard/components/Dashboard'
import { ProjectsView } from '@/features/projects/components/ProjectsView'
import { MemoryView } from '@/features/memory/components/MemoryView'
import { AgentsView } from '@/features/agents/components/AgentsView'
import { ApprovalToasts } from '@/features/agents/components/ApprovalToasts'
import { useAssistant } from '@/features/agents/store'
import { useAgents } from '@/features/agents/sessions'
import { useMemory } from '@/features/memory/store'
import { SettingsView } from '@/features/settings/components/SettingsView'
import { SystemView } from '@/features/system/components/SystemView'
import { AccountView } from '@/features/account/components/AccountView'
import { BrowserView } from '@/features/browser/components/BrowserView'
import { useBrowser } from '@/features/browser/store'
import { FilesView } from '@/features/files/components/FilesView'
import { getT, useT } from '@/lib/i18n'
import { useSession } from '@/features/session/store'
import { SystemMonitorPanel } from '@/components/monitor/SystemMonitorPanel'
import { BottomDashboard } from '@/components/dashboard/BottomDashboard'
import { BootSequence, BOOT_TOTAL_MS } from '@/components/boot/BootSequence'
import { ModuleBoundary } from '@/components/shell/ErrorBoundary'
import { useBoot } from '@/hooks/useBoot'
import type { ModuleId } from '@/types'
import { Workspace } from '@/features/workspace/components/Workspace'
import { ZenBar } from '@/features/workspace/components/ZenBar'
import { useWorkspace } from '@/features/workspace/store'
import { visiblePanes, focusedPane } from '@/features/workspace/layout'
import { relayout } from '@/lib/relayout'
import { PaletteHost } from '@/features/palette/components/PaletteHost'
import { usePalette } from '@/features/palette/store'
import { macKeys, matchWorkspaceKey } from '@/features/workspace/keys'
import { perform } from '@/features/workspace/actions'

/** Browser without remote shells: explain instead of failing. */
function RemoteShellsOff() {
  const t = useT()
  return (
    <Panel title={t.nav.terminal} corners className="min-h-0 flex-1" bodyClassName="flex items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-3 p-6 text-center">
        <TerminalSquare size={28} className="text-text-muted" />
        <p className="font-sans text-[14px] font-semibold text-text-primary">{t.shell.shellsOffTitle}</p>
        <p className="font-sans text-[13px] text-text-secondary">
          {t.shell.shellsOffBefore} <code className="font-mono text-cyan">MINDECK_REMOTE_TERMINAL=1</code>
          {t.shell.shellsOffAfter}
        </p>
      </div>
    </Panel>
  )
}

/** Framer stagger for the primary panels entering after boot. */
const panelIn = (delay: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] as const }
})

/** Modules that stay mounted once shown: running shells, open files and their undo history, the browser's tabs. */
const KEEP: ModuleId[] = ['terminal', 'editor', 'browser']

/** Bring a module up: its pane gets the focus, or the focused pane shows it. */
const show = (id: ModuleId) => useWorkspace.getState().show(id)

export function AppShell() {
  const t = useT()
  const { booted, skip } = useBoot(BOOT_TOTAL_MS)
  // Session uptime counts from boot. Only the top bar's indicator ticks — a
  // per-second state here would re-render every module, editor included.
  const [bootedAt, setBootedAt] = useState<number>()
  useEffect(() => {
    if (booted) setBootedAt(Date.now())
  }, [booted])

  const zen = useWorkspace((s) => s.zen)
  // The module in the focused pane (the side navigation marks it), and every module on screen.
  const focused = useWorkspace((s) => focusedPane(s.layout).module)
  const onScreen = useWorkspace((s) => visiblePanes(s.layout).map((p) => p.module).join(' '))
  const visible = (id: ModuleId) => onScreen.split(' ').includes(id)

  // Agents' push events (approvals, sessions, activity) matter in every module —
  // and so does the browser: links from anywhere open in it.
  useEffect(() => {
    const offAssistant = useAssistant.getState().connect()
    const offAgents = useAgents.getState().connect()
    const offBrowser = useBrowser.getState().connect({
      reveal: () => show('browser'),
      sendToAgent: (tab) => {
        show('agents')
        useAgents.getState().openDialog(getT().browser.agentPrompt(tab.title || tab.url, tab.url))
      },
      settings: () => show('settings'),
      // A click into a page focuses the browser's pane.
      focused: () => show('browser'),
      // A workspace key pressed in a page: the workspace acts on it as if the UI had it.
      workspaceKey: (key) => {
        const action = matchWorkspaceKey(key, macKeys())
        if (action) perform(action)
      },
      // ⇧⌘P in a page: the command palette (the same key closes it).
      palette: () => usePalette.getState().toggle('commands')
    })
    // An agent started a command in a terminal: that terminal comes on screen, beside the chat (which keeps the focus).
    const offTerminal = onEvent('terminal:reveal', ({ info }) => {
      void useTerminals.getState().reveal(info)
      useWorkspace.getState().reveal('terminal')
    })
    return () => {
      offAssistant()
      offAgents()
      offBrowser()
      offTerminal()
    }
  }, [])
  // The chat open in the Agents module shows its approvals inline — no toast for it.
  const activeChat = useAssistant((s) => s.activeId)
  const activeSession = useAgents((s) => (s.view === 'session' ? s.activeId : undefined))
  const activeConversation = activeSession ?? activeChat
  const info = useSession((s) => s.info)
  const shellsOff = !isDesktop() && info?.remoteTerminal === false

  const openConversation = (id: string) => {
    show('agents')
    useAgents.getState().showAssistant()
    void useAssistant.getState().open(id)
  }
  const openSession = (id: string) => {
    show('agents')
    void useAgents.getState().open(id)
  }

  // One module, drawn in its pane. `visible`: its pane is on screen (kept modules stay mounted while hidden).
  const moduleView = (id: ModuleId, visible: boolean) => {
    const openNote = (path: string) => {
      show('memory')
      void useMemory.getState().open(path)
    }
    if (id === 'projects') return <ProjectsView onNavigate={show} />
    if (id === 'memory') return <MemoryView />
    if (id === 'agents') return <AgentsView onOpenNote={openNote} onOpenSettings={() => show('settings')} />
    if (id === 'system') return <SystemView />
    if (id === 'settings') return <SettingsView />
    if (id === 'account') return <AccountView />
    if (id === 'files') return <FilesView onNavigate={show} />
    if (id === 'terminal') return shellsOff ? <RemoteShellsOff /> : <TerminalView onNavigate={show} />
    if (id === 'editor') return <EditorView active={visible} onNavigate={show} />
    // The page is a native view over the UI: not while the boot screen is up.
    if (id === 'browser') return <BrowserView active={visible && booted} />
    // The monitor rail belongs to the Core dashboard, when its pane is wide enough.
    return (
      <div className="flex min-h-0 min-w-0 flex-1 gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <Dashboard onNavigate={show} />
        </div>
        <div className="hidden w-72 shrink-0 pane-lg:flex pane-2xl:w-80">
          <ModuleBoundary id="monitor" name={t.monitor.title}>
            <SystemMonitorPanel />
          </ModuleBoundary>
        </div>
      </div>
    )
  }
  // Each pane's module in its own error boundary: one that crashes shows a panel there, the other panes keep running.
  const renderModule = useCallback(
    (id: ModuleId, visible: boolean) => (
      <ModuleBoundary id={id} name={t.nav[id]}>
        {moduleView(id, visible)}
      </ModuleBoundary>
    ),
    // What moduleView reads beyond module-level functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- moduleView is recreated each render; these are its inputs
    [shellsOff, booted, t]
  )

  return (
    <div className="relative flex h-screen min-h-[560px] w-screen flex-col overflow-hidden">
      <GlowBackground />

      <AnimatePresence>{!booted && <BootSequence onSkip={skip} />}</AnimatePresence>

      {/* Top bar (zen mode: a slim strip) */}
      {zen ? (
        <ZenBar />
      ) : (
        <motion.div {...panelIn(0.05)}>
          <TopStatusBar since={bootedAt} showClock={!visible('core')} />
        </motion.div>
      )}

      {/* Body: nav · workspace */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!zen && (
          <motion.div {...panelIn(0.12)} className="flex">
            <SideNavigation active={focused} open={onScreen.split(' ') as ModuleId[]} onSelect={show} />
          </motion.div>
        )}

        <main className={zen ? 'flex min-w-0 flex-1 overflow-hidden p-1.5' : 'flex min-w-0 flex-1 overflow-hidden p-2.5'}>
          {/* Once it has slid in, native views (the browser's page) measure their place again. */}
          <motion.div {...panelIn(0.18)} onAnimationComplete={relayout} className="flex min-w-0 flex-1 flex-col">
            <Workspace render={renderModule} keep={KEEP} />
          </motion.div>
        </main>
      </div>

      {/* Bottom command deck (collapsible) */}
      {!zen && (
        <motion.div {...panelIn(0.3)}>
          <ModuleBoundary id="deck" name={t.deck.title}>
            <BottomDashboard onOpenConversation={openConversation} onOpenSession={openSession} />
          </ModuleBoundary>
        </motion.div>
      )}

      {/* The command palette (⌘K) and the shortcut overview (⌘/), over everything. */}
      <PaletteHost />

      {/* Approvals float above every module (the open chat shows its own inline; the
          browser's page would cover them, so it shows them above the page). */}
      {booted && !(visible('browser') && isDesktop()) && <ApprovalToasts hideConversation={visible('agents') ? activeConversation : undefined} />}
    </div>
  )
}
