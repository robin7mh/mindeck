import { ChevronDown, ChevronUp, CheckCheck, GitMerge } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { editorActions } from '../actions'
import { useConflicts } from '../conflicts'
import { useEditor, type EditorTab } from '../store'
import { useScm } from '../scm'

const button = 'flex items-center gap-1 rounded-md border border-hud/60 px-2 py-0.5 font-sans text-[11.5px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-cyan disabled:opacity-40'

/**
 * Above a file with merge conflicts: how many are left, previous / next,
 * accept a side for all of them — and, once none are left, "Mark as
 * resolved" (saves, then stages the file, like VS Code).
 */
export function ConflictBar({ tab, readOnly }: { tab: EditorTab; readOnly: boolean }) {
  const t = useT()
  const count = useConflicts((s) => s.counts[tab.id] ?? 0)
  const conflicted = useScm((s) => !!s.status?.files.some((f) => f.path === tab.path && f.unstaged === 'conflicted'))
  const busy = useScm((s) => !!s.busy)
  const ours = useEditor((s) => s.projectId === tab.projectId)
  if (!count && !(conflicted && ours)) return null
  const run = (id: string) => editorActions()?.run(id)
  const resolve = async () => {
    if (tab.dirty && !(await useEditor.getState().save(tab.id))) return
    await useScm.getState().stage([tab.path])
  }
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-amber/30 bg-amber/[0.07] px-3 py-1 font-sans text-[12px] text-text-primary">
      <GitMerge size={13} className="shrink-0 text-amber" />
      <span className="mr-auto">{count ? t.conflicts.count(count) : t.conflicts.noneLeft}</span>
      {count > 0 && (
        <>
          <button type="button" aria-label={t.conflicts.previousShort} title={t.conflicts.previousShort} className={button} onClick={() => run('mindeck.conflict.previous')}>
            <ChevronUp size={12} />
          </button>
          <button type="button" aria-label={t.conflicts.nextShort} title={t.conflicts.nextShort} className={button} onClick={() => run('mindeck.conflict.next')}>
            <ChevronDown size={12} />
          </button>
          {!readOnly && (
            <>
              <button type="button" className={button} onClick={() => run('mindeck.conflict.acceptAllCurrent')}>
                {t.conflicts.allCurrent}
              </button>
              <button type="button" className={button} onClick={() => run('mindeck.conflict.acceptAllIncoming')}>
                {t.conflicts.allIncoming}
              </button>
            </>
          )}
        </>
      )}
      {conflicted && ours && !readOnly && (
        <button type="button" className={button} disabled={count > 0 || busy} onClick={() => void resolve()}>
          <CheckCheck size={12} /> {t.conflicts.markResolved}
        </button>
      )}
    </div>
  )
}
