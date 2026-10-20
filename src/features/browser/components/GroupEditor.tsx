import { useState } from 'react'
import { Check, Plus, Ungroup, X } from 'lucide-react'
import { TAB_GROUP_COLORS, type BrowserTabGroup } from '@shared/types/browser'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlay } from '@/lib/overlay'
import { useBrowser } from '../store'
import { GROUP_STYLES } from '../tabs'

const WIDTH = 280
const action =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-sans text-[12.5px] text-text-secondary transition-colors hover:bg-elevated hover:text-text-primary'

function Editor({ group, at }: { group: BrowserTabGroup; at?: { x: number; y: number } }) {
  const t = useT()
  useOverlay(true)
  const run = useBrowser((s) => s.run)
  const [title, setTitle] = useState(group.title)
  const close = () => {
    if (title.trim() !== group.title) void run('browser:groupUpdate', { id: group.id, title })
    useBrowser.getState().editGroup()
  }
  const finish = (fn: () => Promise<unknown>) => {
    useBrowser.getState().editGroup()
    void fn()
  }
  // Where it was asked from (a group's chip), kept inside the window; else at the top.
  const place = at ? { left: Math.max(8, Math.min(at.x, window.innerWidth - WIDTH - 8)), top: Math.min(at.y + 6, window.innerHeight - 260) } : { left: `calc(50% - ${WIDTH / 2}px)`, top: '12vh' }

  return (
    <div className="fixed inset-0 z-60" onMouseDown={close}>
      <div
        role="dialog"
        aria-label={t.browserTabs.editGroup}
        style={{ ...place, width: WIDTH }}
        className="absolute rounded-lg border border-hud/70 bg-panel/95 p-2.5 shadow-2xl shadow-black/50 backdrop-blur-md"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          aria-label={t.browserTabs.groupName}
          placeholder={t.browserTabs.groupName}
          value={title}
          maxLength={100}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && close()}
          className="w-full rounded-md border border-hud/60 bg-surface/60 px-2.5 py-1.5 font-sans text-[13px] text-text-primary outline-hidden placeholder:text-text-muted focus:border-cyan/60"
        />
        <div role="radiogroup" aria-label={t.browserTabs.groupColor} className="mt-2.5 flex gap-2 px-0.5">
          {TAB_GROUP_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={group.color === color}
              aria-label={t.browserTabs.colors[color]}
              title={t.browserTabs.colors[color]}
              onClick={() => void run('browser:groupUpdate', { id: group.id, color })}
              className={cn('flex h-6 w-6 items-center justify-center rounded-full ring-offset-2 ring-offset-panel', GROUP_STYLES[color].dot, group.color === color && 'ring-2 ring-text-primary/70')}
            >
              {group.color === color && <Check size={12} className="text-void" />}
            </button>
          ))}
        </div>
        <div className="mt-2.5 border-t border-hud/50 pt-1.5">
          <button
            type="button"
            className={action}
            onClick={() =>
              finish(async () => {
                const store = useBrowser.getState()
                const tab = await store.run('browser:open', group.private ? { private: true } : {})
                if (tab) await store.run('browser:move', { id: tab.id, index: useBrowser.getState().state.tabs.length, groupId: group.id })
                useBrowser.setState((s) => ({ focusTick: s.focusTick + 1 }))
              })
            }
          >
            <Plus size={13} /> {t.browserTabs.newTabInGroup}
          </button>
          <button type="button" className={action} onClick={() => finish(() => run('browser:ungroup', { id: group.id }))}>
            <Ungroup size={13} /> {t.browserTabs.ungroup}
          </button>
          <button type="button" className={cn(action, 'hover:text-danger')} onClick={() => finish(() => run('browser:groupClose', { id: group.id }))}>
            <X size={13} /> {t.browserTabs.closeGroup}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A group's name and color, and what else can be done with it (Chrome's group bubble). */
export function GroupEditor() {
  const editor = useBrowser((s) => s.groupEditor)
  const group = useBrowser((s) => s.state.groups.find((g) => g.id === s.groupEditor?.id))
  return editor && group ? <Editor key={group.id} group={group} at={editor.at} /> : null
}
