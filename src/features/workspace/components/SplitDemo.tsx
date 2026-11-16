import { motion } from 'framer-motion'
import { Bot, Columns2, Globe } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'

/** One cycle: a module alone, Split, two side by side, back. */
const CYCLE = { duration: 4.2, times: [0, 0.3, 0.42, 0.86, 1], repeat: Infinity, ease: 'easeInOut' as const }

/** A pane of the picture: a module's icon over a few lines of "content". */
function MiniPane({ icon: Icon, lines }: { icon: typeof Bot; lines: number[] }) {
  return (
    <div className="flex h-full flex-col gap-1 rounded-sm border border-hud/70 bg-panel/80 p-1.5">
      <Icon size={10} className="text-cyan" />
      {lines.map((w, i) => (
        <span key={i} className="h-1 rounded-full bg-hud/80" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}

/**
 * A small moving picture of the split screen for the setup's tips: Mindeck
 * with one module, the Split button lighting up, a second module sliding in
 * next to it. Drawn from tokens, no files; still (split) when the system asks
 * for reduced motion.
 */
export function SplitDemo({ className }: { className?: string }) {
  const t = useT()
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // Each property's keyframes; held still at the split (the third frame).
  const play = (frames: Record<string, (string | number)[]>) =>
    still ? { initial: false as const, animate: Object.fromEntries(Object.entries(frames).map(([key, values]) => [key, values[2]])) } : { animate: frames, transition: CYCLE }
  return (
    <div role="img" aria-label={t.onboarding.splitDemo} className={cn('relative h-28 overflow-hidden rounded-md border border-hud/60 bg-void/60', className)}>
      {/* The top bar, with the Split button. */}
      <div className="absolute inset-x-0 top-0 flex h-4 items-center justify-end gap-1 border-b border-hud/50 bg-surface/70 px-1.5">
        <span className="relative flex h-2.5 items-center rounded-xs border border-hud/80 px-1 text-cyan">
          <Columns2 size={7} />
          {/* It lights up as it is pressed. */}
          <motion.span data-testid="split-demo-press" className="absolute -inset-px rounded-xs border border-cyan bg-cyan/20" style={{ opacity: 0 }} {...play({ opacity: [0, 1, 1, 0, 0] })} />
        </span>
        <span className="h-2.5 w-4 rounded-xs border border-hud/80" />
      </div>
      {/* The side navigation. */}
      <div className="absolute bottom-0 left-0 top-4 flex w-5 flex-col items-center gap-1.5 border-r border-hud/50 bg-surface/50 pt-1.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={cn('h-1.5 w-1.5 rounded-xs', i === 3 ? 'bg-cyan/80' : 'bg-hud')} />
        ))}
      </div>
      {/* The workspace: the first pane makes room, the second slides in. */}
      <div className="absolute bottom-1.5 left-7 right-1.5 top-5">
        <motion.div className="absolute inset-y-0 left-0" style={{ width: '100%' }} {...play({ width: ['100%', '100%', '49%', '49%', '100%'] })}>
          <MiniPane icon={Bot} lines={[80, 55, 70, 40]} />
        </motion.div>
        <motion.div className="absolute inset-y-0 right-0 w-[49%]" style={{ opacity: 0 }} {...play({ opacity: [0, 0, 1, 1, 0], x: [16, 16, 0, 0, 16] })}>
          <MiniPane icon={Globe} lines={[65, 85, 50]} />
        </motion.div>
      </div>
    </div>
  )
}
