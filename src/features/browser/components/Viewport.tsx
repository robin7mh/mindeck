import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { AlertTriangle, ExternalLink, RotateCw, ServerCrash } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import type { BrowserPane, BrowserTab, ViewBounds } from '@shared/types/browser'
import { internalPage } from '@shared/types/browserData'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlays } from '@/lib/overlay'
import { onRelayout } from '@/lib/relayout'
import { usePaneFocused } from '@/features/workspace/pane'
import { useActiveSplit, useActiveTab, useBrowser } from '../store'
import { hostOf, security } from '../url'
import { NewTabPage } from './NewTabPage'
import { HistoryPage } from './HistoryPage'
import { BookmarksPage } from './BookmarksPage'
import { AuthDialog, DangerPage, PrivateTabPage } from './Protection'
import { DIVIDER, DropZones, SplitDivider } from './SplitView'

/** Net errors that mean "nothing answers there (yet)" — on this machine, a dev server still starting. */
const NOT_UP_YET = new Set([-102, -100, -101, -324, -7, -21])
const RETRY_MS = 2000

const button =
  'flex items-center gap-1.5 rounded-md border border-hud/60 px-3 py-1.5 font-sans text-[12.5px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan'

function ErrorPage({ tab }: { tab: BrowserTab }) {
  const t = useT()
  const error = tab.error!
  const waiting = security(error.url) === 'local' && NOT_UP_YET.has(error.code)
  const retry = () => void useBrowser.getState().run('browser:go', { id: tab.id, action: 'reload' })

  // A local dev server that is not up yet: keep trying, quietly.
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(retry, RETRY_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retry only depends on the tab id
  }, [waiting, tab.id])

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <AlertTriangle size={28} className={waiting ? 'mx-auto text-amber' : 'mx-auto text-danger'} />
        <h2 className="mt-3 font-sans text-[16px] font-semibold text-text-primary">{t.browser.errorTitle}</h2>
        <p className="mt-1.5 font-sans text-[13px] text-text-secondary">
          {waiting ? t.browser.errorWaiting(hostOf(error.url)) : error.description}
        </p>
        <p className="mt-1 break-all font-mono text-[11px] text-text-muted">
          {error.url} · {error.code}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" onClick={retry} className={button}>
            <RotateCw size={13} className={tab.loading ? 'animate-spin' : ''} /> {t.browser.retry}
          </button>
          {!waiting && (
            <button type="button" onClick={() => void useBrowser.getState().run('browser:tool', { id: tab.id, tool: 'handoff' })} className={button}>
              <ExternalLink size={13} /> {t.browser.openExternal}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function CrashPage({ tab }: { tab: BrowserTab }) {
  const t = useT()
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div>
        <ServerCrash size={28} className="mx-auto text-danger" />
        <h2 className="mt-3 font-sans text-[16px] font-semibold text-text-primary">{t.browser.crashed}</h2>
        <p className="mt-1.5 font-sans text-[13px] text-text-secondary">{t.browser.crashedHint}</p>
        <button type="button" onClick={() => void useBrowser.getState().run('browser:go', { id: tab.id, action: 'reload' })} className={`${button} mx-auto mt-4`}>
          <RotateCw size={13} /> {t.browser.reload}
        </button>
      </div>
    </div>
  )
}

type Report = { bounds: ViewBounds | null; focused: boolean; panes?: BrowserPane[] }

const same = (a: ViewBounds | null, b: ViewBounds | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
const samePanes = (a?: BrowserPane[], b?: BrowserPane[]) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((p, i) => p.id === b[i].id && same(p.bounds, b[i].bounds)))

const rectOf = (el: HTMLElement): ViewBounds => {
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
}

/** A web page shows in this tab (Mindeck's own pages, the new-tab page and error pages are drawn here instead). */
const isPage = (tab: BrowserTab | undefined) => !!tab?.url && !internalPage(tab.url) && !tab.error && !tab.crashed

/** What the UI draws for a tab where no web page shows — and its page's picture while a menu covers it. */
function TabContent({ tab, shot }: { tab: BrowserTab; shot?: string }) {
  const own = internalPage(tab.url)
  return (
    <>
      {!tab.url && (tab.profile === 'private' ? <PrivateTabPage /> : <NewTabPage />)}
      {own === 'history' && <HistoryPage />}
      {own === 'bookmarks' && <BookmarksPage />}
      {tab.error && (tab.error.danger ? <DangerPage tab={tab} /> : <ErrorPage tab={tab} />)}
      {tab.crashed && !tab.error && <CrashPage tab={tab} />}
      {shot && <img src={shot} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-fill" />}
    </>
  )
}

/**
 * Where the pages go. Web views are native layers on top of the UI: this
 * placeholder reports its place to the core (and null when the module is not
 * on screen), and whether its pane has the focus (only then do the browser's
 * keys win over the UI's); while any menu or dialog of the UI is open, still
 * pictures of the pages stand in for the views, so nothing hides behind them.
 * In a split view two pages share the place — each in its own pane, the
 * focused one framed — and the core gets each pane's place too. While a tab
 * is dragged, the edges take it for a split view.
 */
export function Viewport({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const panes = useRef(new Map<string, HTMLDivElement>())
  const sent = useRef<Report>()
  const focused = useRef(true)
  focused.current = usePaneFocused()
  const tab = useActiveTab()
  const split = useActiveSplit()
  const tabs = useBrowser((s) => s.state.tabs)
  const dragged = useBrowser((s) => s.dragging)
  const covered = useOverlays((s) => s.count > 0)
  const [shots, setShots] = useState<Record<string, string> | null>(null)
  const [ratio, setRatio] = useState<number | null>(null)
  const shown = split ? split.tabs.map((id) => tabs.find((x) => x.id === id)).filter((x): x is BrowserTab => !!x) : tab ? [tab] : []
  const page = shown.some(isPage)
  // A tab dragged here from the tabs (not the one on screen): the edges offer a split view.
  const dropping = active && !!tab && !!dragged && dragged !== tab.id

  const report = (bounds: ViewBounds | null, list?: BrowserPane[]) => {
    const last = sent.current
    if (last && same(last.bounds, bounds) && last.focused === focused.current && samePanes(last.panes, list)) return
    sent.current = { bounds, focused: focused.current, ...(list ? { panes: list } : {}) }
    void ipc('browser:view', sent.current).catch(() => {})
  }
  const measure = () => {
    const list = split ? shown.map((x) => ({ id: x.id, bounds: rectOf(panes.current.get(x.id)!) })) : undefined
    report(rectOf(ref.current!), list)
  }
  const latest = useRef(measure)
  latest.current = measure

  // Every render may have moved it (bars above it come and go, the divider moves); only real changes go out.
  useLayoutEffect(() => {
    if (active) measure()
  })

  useEffect(() => {
    if (!active) {
      report(null)
      return
    }
    const run = () => latest.current()
    const observer = new ResizeObserver(run)
    observer.observe(ref.current!)
    window.addEventListener('resize', run)
    const offRelayout = onRelayout(run)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', run)
      offRelayout()
      report(null)
    }
  }, [active])

  // A menu or dialog over the pages: their pictures instead of the live views.
  useEffect(() => {
    if (!active || !covered || !page) return
    let stale = false
    void ipc('browser:freeze')
      .then((img) => !stale && setShots(img))
      .catch(() => {})
    return () => {
      stale = true
      setShots(null)
      void ipc('browser:unfreeze').catch(() => {})
    }
  }, [active, covered, page])

  const share = ratio ?? split?.ratio ?? 1
  const paneStyle = (i: number): CSSProperties | undefined =>
    split && i === 0 ? { flexBasis: `calc((100% - ${DIVIDER}px) * ${share})`, flexGrow: 0, flexShrink: 0 } : undefined
  // Clicking into the other side of a split moves the focus there (at once here, so what is typed goes to it).
  const focus = (id: string) => {
    if (id === useBrowser.getState().state.activeId) return
    useBrowser.setState((s) => ({ state: { ...s.state, activeId: id } }))
    void useBrowser.getState().run('browser:activate', { id })
  }

  return (
    <div
      ref={ref}
      className={cn('relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-surface/30', split?.vertical && 'flex-col')}
      data-testid="browser-viewport"
      data-native-view
    >
      {shown.map((x, i) => (
        <div key={x.id} className="contents">
          {i === 1 && split && <SplitDivider split={split} area={ref} onRatio={setRatio} />}
          {/* In a split, a frame around each page (the focused one lit) — outside the page, which would cover it. */}
          <div
            style={paneStyle(i)}
            data-testid={split ? 'browser-pane' : undefined}
            aria-current={split && x.id === tab?.id ? 'true' : undefined}
            onPointerDownCapture={split ? () => focus(x.id) : undefined}
            className={cn('flex min-h-0 min-w-0 flex-1', split && 'rounded-xs border-2', split && (x.id === tab?.id ? 'border-cyan/50' : 'border-hud/30'))}
          >
            <div
              ref={(el) => {
                if (el) panes.current.set(x.id, el)
                else panes.current.delete(x.id)
              }}
              className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
            >
              <TabContent tab={x} shot={shots?.[x.id]} />
            </div>
          </div>
        </div>
      ))}
      {dropping && <DropZones dragged={dragged!} active={tab!.id} />}
      {active && <AuthDialog tabId={tab?.id} />}
    </div>
  )
}
