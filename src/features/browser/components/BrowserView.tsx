import { useEffect } from 'react'
import { AlertTriangle, ArrowLeft, ArrowRight, Bot, Download, Eye, EyeOff, Globe, MoreHorizontal, Puzzle, RotateCw, X } from 'lucide-react'
import { isDesktop } from '@shared/ipc/client'
import { internalPage } from '@shared/types/browserData'
import { cn } from '@/lib/cn'
import { useLocale, useT } from '@/lib/i18n'
import { useAppearance } from '@/lib/theme'
import { useActiveTab, useBrowser } from '../store'
import { Omnibox } from './Omnibox'
import { TabStrip } from './TabStrip'
import { Viewport } from './Viewport'
import { AgentBar, ApprovalDock, FindBar, PermissionBar } from './Bars'
import { DownloadsPanel } from './DownloadsPanel'
import { BookmarksBar } from './BookmarksBar'
import { BookmarkEditor } from './BookmarkEditor'
import { ImportDialog } from './ImportDialog'
import { RestoreBar } from './RestoreBar'
import { TabSearch } from './TabSearch'
import { ExtensionButtons, ExtensionsPanel } from './Extensions'
import { DrmBar } from './Protection'
import { VerticalTabs } from './VerticalTabs'
import { GroupEditor } from './GroupEditor'
import { SplitTools } from './SplitView'
import { useDragEnd } from './TabParts'

const tool =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text-primary disabled:pointer-events-none disabled:opacity-35'

/** The web isn't on a headless core: say where the browser is. */
function Unavailable() {
  const t = useT()
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <Globe size={28} className="mx-auto text-text-muted" />
        <p className="mt-3 font-sans text-[14px] font-semibold text-text-primary">{t.browser.unavailable}</p>
        <p className="mt-1.5 font-sans text-[12.5px] text-text-secondary">{t.browser.unavailableHint}</p>
      </div>
    </div>
  )
}

/**
 * The Browser module (architecture §12.9): real Chromium tabs inside Mindeck,
 * which the user's agents can read — and, after asking, use. Tabs keep
 * running while other modules are on screen; the shell mounts this view once.
 */
export function BrowserView({ active }: { active: boolean }) {
  const t = useT()
  const tab = useActiveTab()
  const available = useBrowser((s) => s.state.available)
  const findOpen = useBrowser((s) => s.findOpen)
  const downloadsOpen = useBrowser((s) => s.downloadsOpen)
  const extensionsOpen = useBrowser((s) => s.extensionsOpen)
  const downloading = useBrowser((s) => s.state.downloads.filter((d) => d.state === 'progressing').length)
  const error = useBrowser((s) => s.error)
  const importOpen = useBrowser((s) => s.importOpen)
  const run = useBrowser((s) => s.run)
  const vertical = useBrowser((s) => s.settings.verticalTabs)
  const mode = useAppearance((s) => s.appearance.mode)
  const locale = useLocale((s) => s.locale)
  useDragEnd()

  // Pages follow Mindeck's light/dark mode; native menus speak its language.
  useEffect(() => {
    if (isDesktop()) void run('browser:ui', { theme: mode, locale })
  }, [mode, locale, run])

  if (!isDesktop() || !available) {
    return (
      <section className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
        <Unavailable />
      </section>
    )
  }

  const id = tab?.id ?? ''
  // A web page — not the new-tab page, not Mindeck's own history or bookmarks.
  const page = !!tab?.url && !internalPage(tab.url)
  return (
    <section className={cn('panel flex min-h-0 flex-1 overflow-hidden', !vertical && 'flex-col')} aria-label={t.browser.title}>
      {vertical ? <VerticalTabs /> : <TabStrip />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-hud/50 bg-surface/30 px-2 py-1.5">
          <button type="button" aria-label={t.browser.back} title={`${t.browser.back} (⌘[)`} disabled={!tab?.canGoBack} onClick={() => void run('browser:go', { id, action: 'back' })} className={tool}>
            <ArrowLeft size={15} />
          </button>
          <button type="button" aria-label={t.browser.forward} title={`${t.browser.forward} (⌘])`} disabled={!tab?.canGoForward} onClick={() => void run('browser:go', { id, action: 'forward' })} className={tool}>
            <ArrowRight size={15} />
          </button>
          {tab?.loading ? (
            <button type="button" aria-label={t.browser.stop} title={t.browser.stop} onClick={() => void run('browser:go', { id, action: 'stop' })} className={tool}>
              <X size={15} />
            </button>
          ) : (
            <button type="button" aria-label={t.browser.reload} title={`${t.browser.reload} (⌘R)`} disabled={!page} onClick={() => void run('browser:go', { id, action: 'reload' })} className={tool}>
              <RotateCw size={14} />
            </button>
          )}
          <Omnibox tab={tab} />
          {tab && tab.zoom !== 1 && (
            <button
              type="button"
              title={t.browser.zoom(Math.round(tab.zoom * 100))}
              onClick={() => void run('browser:zoom', { id, zoom: 'reset' })}
              className="shrink-0 rounded-md border border-hud/60 px-1.5 py-0.5 font-mono text-[10.5px] text-text-secondary hover:border-cyan/50 hover:text-cyan"
            >
              {Math.round(tab.zoom * 100)} %
            </button>
          )}
          <button
            type="button"
            aria-label={tab?.shared ? t.browser.shared : t.browser.private}
            aria-pressed={!!tab?.shared}
            title={tab?.shared ? t.browser.shared : t.browser.private}
            disabled={!page || tab?.profile === 'private'}
            onClick={() => void run('browser:update', { id, shared: !tab?.shared })}
            className={cn(tool, tab?.shared && 'text-purple hover:text-purple')}
          >
            {tab?.shared ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
          <button type="button" aria-label={t.browser.sendToAgent} title={t.browser.sendToAgent} disabled={!page} onClick={() => void useBrowser.getState().sendToAgent()} className={tool}>
            <Bot size={15} />
          </button>
          <SplitTools tabId={id} />
          <ExtensionButtons />
          <button
            type="button"
            aria-label={t.browserExtras.manageExtensions}
            aria-pressed={extensionsOpen}
            title={t.browserExtras.manageExtensions}
            onClick={() => useBrowser.getState().toggleExtensions()}
            className={cn(tool, extensionsOpen && 'bg-elevated text-cyan')}
          >
            <Puzzle size={15} />
          </button>
          <button
            type="button"
            aria-label={t.browser.downloads}
            aria-pressed={downloadsOpen}
            title={t.browser.downloads}
            onClick={() => useBrowser.getState().toggleDownloads()}
            className={cn(tool, 'relative', downloadsOpen && 'bg-elevated text-cyan')}
          >
            <Download size={15} />
            {downloading > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-cyan" />}
          </button>
          <button type="button" aria-label={t.browser.menu} title={t.browser.menu} onClick={() => void run('browser:tool', { id, tool: 'pageMenu' })} className={tool}>
            <MoreHorizontal size={15} />
          </button>
        </div>
        <BookmarksBar />
        {/* The loading line sits outside the page area: the web view would cover it. */}
        <div className="relative h-0.5 shrink-0 overflow-hidden">{tab?.loading && <div className="absolute inset-y-0 left-0 w-1/3 animate-loadbar bg-cyan" />}</div>
        {error && (
          <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/6 px-3 py-1.5">
            <AlertTriangle size={13} className="shrink-0 text-danger" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">{error}</span>
            <button type="button" aria-label={t.common.dismiss} onClick={() => useBrowser.getState().clearError()} className="rounded-sm p-0.5 text-text-muted hover:text-text-primary">
              <X size={12} />
            </button>
          </div>
        )}
        <RestoreBar />
        {findOpen && tab && page && <FindBar tab={tab} />}
        <PermissionBar tabId={tab?.id} />
        {active && <ApprovalDock />}
        {tab && <AgentBar tab={tab} />}
        {tab && <DrmBar tab={tab} />}
        <div className="flex min-h-0 flex-1">
          <Viewport active={active} />
          {downloadsOpen && <DownloadsPanel />}
          {extensionsOpen && <ExtensionsPanel />}
        </div>
      </div>
      <BookmarkEditor />
      <GroupEditor />
      <TabSearch />
      {importOpen && <ImportDialog onClose={() => useBrowser.getState().setImport(false)} />}
    </section>
  )
}
