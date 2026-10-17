import { useEffect, useState, type DragEvent } from 'react'
import { Bot, Boxes, Clock, Columns2, Globe, Loader2, Play, Star, VenetianMask, Volume2, VolumeX } from 'lucide-react'
import type { BrowserTab } from '@shared/types/browser'
import { internalPage } from '@shared/types/browserData'
import { useT } from '@/lib/i18n'
import { useBrowser } from '../store'
import { TAB_DRAG, type Drop } from '../tabs'

export function Favicon({ tab }: { tab: BrowserTab }) {
  const own = internalPage(tab.url)
  if (own) return own === 'history' ? <Clock size={13} className="shrink-0 text-cyan" aria-hidden /> : <Star size={13} className="shrink-0 text-cyan" aria-hidden />
  if (tab.loading) return <Loader2 size={13} className="shrink-0 animate-spin text-cyan" aria-hidden />
  if (tab.favicon) return <img src={tab.favicon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-xs object-contain" draggable={false} />
  return <Globe size={13} className="shrink-0 text-text-muted" aria-hidden />
}

/** Whose profile the tab uses, when it is not the user's: a private tab, the agents' container. */
export function ProfileMark({ tab }: { tab: BrowserTab }) {
  const t = useT()
  if (tab.profile === 'private') return <VenetianMask size={12} className="shrink-0 text-purple" aria-label={t.browserExtras.privateTab} />
  if (tab.profile === 'agents' && !tab.openedBy) return <Boxes size={12} className="shrink-0 text-purple" aria-label={t.browserExtras.agentsContainer} />
  return null
}

/** What goes on in the tab: in a split view, media playing silently, an agent's tab, sound (a button that mutes). */
export function TabStatus({ tab, split }: { tab: BrowserTab; split: boolean }) {
  const t = useT()
  const run = useBrowser((s) => s.run)
  return (
    <>
      {split && <Columns2 size={12} className="shrink-0 text-cyan" aria-label={t.browserTabs.inSplit} />}
      {tab.playing && !tab.audible && !tab.muted && <Play size={11} className="shrink-0 text-text-muted" aria-label={t.browserExtras.playing} />}
      {tab.openedBy && <Bot size={12} className="shrink-0 text-purple" aria-label={t.browser.agentTab(tab.openedBy)} />}
      {(tab.audible || tab.muted) && (
        <button
          type="button"
          aria-label={tab.muted ? t.browser.unmute : t.browser.mute}
          title={tab.muted ? t.browser.unmute : t.browser.mute}
          onClick={(e) => {
            e.stopPropagation()
            void run('browser:update', { id: tab.id, muted: !tab.muted })
          }}
          className="shrink-0 rounded-sm p-0.5 text-text-muted hover:bg-elevated hover:text-text-primary"
        >
          {tab.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
        </button>
      )}
    </>
  )
}

/** Carry out a drop: pin or unpin the tab first if it changes sides, then move it (into its group). */
export async function applyDrop(id: string, drop: Drop): Promise<void> {
  const { run } = useBrowser.getState()
  if (drop.pin !== undefined) await run('browser:update', { id, pinned: drop.pin })
  await run('browser:move', { id, index: drop.index, groupId: drop.groupId })
}

/**
 * Dragging tabs: a tab says it is dragged (the page area then offers its
 * edges for a split view); drop targets show where it would land, and only
 * when it may land there.
 */
export function useTabDrag() {
  const [over, setOver] = useState<string | null>(null)
  return {
    over,
    source: (tab: BrowserTab) => ({
      draggable: true,
      onDragStart: (e: DragEvent) => {
        e.dataTransfer.setData(TAB_DRAG, tab.id)
        e.dataTransfer.effectAllowed = 'move'
        useBrowser.getState().setDragging(tab.id)
      },
      onDragEnd: () => {
        setOver(null)
        useBrowser.getState().setDragging(undefined)
      }
    }),
    target: (key: string, plan: (id: string) => Drop | null) => ({
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG)) return
        // Over this target the tab lands here or nowhere (not on what lies behind it).
        e.stopPropagation()
        const id = useBrowser.getState().dragging
        if (!id || !plan(id)) return
        e.preventDefault()
        setOver(key)
      },
      onDragLeave: () => setOver((o) => (o === key ? null : o)),
      onDrop: (e: DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(null)
        const id = e.dataTransfer.getData(TAB_DRAG)
        const drop = id ? plan(id) : null
        if (drop) void applyDrop(id, drop)
      }
    })
  }
}

/** A drag that ends anywhere (or whose tab went away meanwhile) is over: the page area stops offering its edges. */
export function useDragEnd(): void {
  const dragging = useBrowser((s) => !!s.dragging)
  useEffect(() => {
    if (!dragging) return
    // After the drop's own handlers (they still read which tab is dragged).
    const done = () => setTimeout(() => useBrowser.getState().setDragging(undefined))
    window.addEventListener('dragend', done, true)
    window.addEventListener('drop', done, true)
    return () => {
      window.removeEventListener('dragend', done, true)
      window.removeEventListener('drop', done, true)
    }
  }, [dragging])
}
