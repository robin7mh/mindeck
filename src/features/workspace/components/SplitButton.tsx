import { useEffect, useState } from 'react'
import { Columns2, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOnboarding } from '@/features/onboarding/store'
import { focusInto } from '../actions'
import { keyLabel } from '../keys'
import { SLOTS } from '../layout'
import { useWorkspace } from '../store'
import { SplitDemo } from './SplitDemo'

const TIP_KEY = 'mindeck.tips.split'

function tipSeen(): boolean {
  try {
    return localStorage.getItem(TIP_KEY) === '1'
  } catch {
    return true
  }
}

function markTipSeen(): void {
  try {
    localStorage.setItem(TIP_KEY, '1')
  } catch {
    /* storage unavailable: the tip shows again next time */
  }
}

/** Split: a pane opens next to the focused one, and gets the keyboard. */
function split(): void {
  useWorkspace.getState().split()
  const id = useWorkspace.getState().layout.focus
  requestAnimationFrame(() => focusInto(id))
}

/**
 * Split the screen, from the top bar: a pane opens next to the focused one —
 * also while a single pane shows no head of its own. Four panes at most.
 * Until the screen was split once (or the tip dismissed), a tip below it
 * shows what it does.
 */
export function SplitButton() {
  const t = useT()
  const w = t.workspace
  const count = useWorkspace((s) => s.layout.panes.length)
  const setupOpen = useOnboarding((s) => s.open)
  const [seen, setSeen] = useState(tipSeen)
  const full = count >= SLOTS.grid
  const dismiss = () => {
    markTipSeen()
    setSeen(true)
  }
  // Split once: the tip has done its job.
  useEffect(() => {
    if (count > 1 && !seen) dismiss()
  }, [count, seen])
  const tip = !seen && count === 1 && !setupOpen

  return (
    <div className="no-drag relative">
      <button
        type="button"
        aria-label={w.splitScreen}
        title={full ? w.splitFull : `${w.splitHint} (${keyLabel('split')})`}
        disabled={full}
        onClick={split}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md border px-2 transition-colors hover:border-cyan/50 hover:text-cyan disabled:pointer-events-none disabled:opacity-40',
          tip ? 'border-cyan/50 text-cyan' : 'border-hud/60 text-text-secondary'
        )}
      >
        <Columns2 size={14} />
        <span className="hidden font-sans text-[12px] md:inline">{w.splitShort}</span>
      </button>
      {tip && (
        <div role="dialog" aria-label={t.onboarding.splitTip.title} className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-cyan/40 bg-panel/95 p-3 shadow-xl shadow-black/40 backdrop-blur-md">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1">
              <span className="block font-sans text-[13px] font-medium text-text-primary">{t.onboarding.splitTip.title}</span>
              <span className="mt-0.5 block font-sans text-[12px] text-text-secondary">{t.onboarding.splitTip.body}</span>
            </span>
            <button type="button" aria-label={t.common.dismiss} onClick={dismiss} className="text-text-muted hover:text-text-primary">
              <X size={13} />
            </button>
          </div>
          <SplitDemo className="mt-2.5" />
          <button
            type="button"
            onClick={split}
            className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-cyan/40 bg-cyan/6 px-2.5 py-1 font-sans text-[12px] font-medium text-cyan transition-colors hover:bg-cyan/12"
          >
            <Columns2 size={13} /> {w.splitTry(keyLabel('split'))}
          </button>
        </div>
      )}
    </div>
  )
}
