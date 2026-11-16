import { Palette, Circle } from 'lucide-react'
import { GRAPH_COLORS, type GraphStyle } from '@shared/types/memory'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'

/** Colorful (one hue per folder) vs. single color, plus the accent swatches. */
export function GraphStyleControl({ style, onChange }: { style: GraphStyle; onChange: (s: GraphStyle) => void }) {
  const t = useT()
  const seg = 'flex items-center gap-1.5 rounded-sm px-2 py-1 font-sans text-[11px] font-medium transition-colors'
  return (
    <div className="flex items-center gap-2">
      <div className="flex rounded-md border border-hud/60 bg-surface/50 p-0.5">
        <button
          type="button"
          onClick={() => onChange({ ...style, mode: 'colorful' })}
          className={cn(seg, style.mode === 'colorful' ? 'bg-cyan/10 text-cyan' : 'text-text-muted hover:text-text-secondary')}
        >
          <Palette size={12} />
          {t.memory.colorful}
        </button>
        <button
          type="button"
          onClick={() => onChange({ ...style, mode: 'single' })}
          className={cn(seg, style.mode === 'single' ? 'bg-cyan/10 text-cyan' : 'text-text-muted hover:text-text-secondary')}
        >
          <Circle size={11} />
          {t.memory.single}
        </button>
      </div>

      {style.mode === 'single' && (
        <div className="flex items-center gap-1">
          {GRAPH_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              aria-label={t.memory.graphColor(c)}
              onClick={() => onChange({ mode: 'single', color: c })}
              className={cn(
                'h-4 w-4 rounded-full transition-transform hover:scale-110',
                style.color === c && 'ring-2 ring-text-primary/70 ring-offset-2 ring-offset-panel'
              )}
              style={{ background: `rgb(var(--graph-${c}))` }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
