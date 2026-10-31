import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BOOT_LINES } from '@/data/bootLines'
import { MindeckMark } from '@/components/brand/MindeckMark'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'

const TONE: Record<string, string> = {
  accent: 'text-cyan text-glow-cyan',
  ok: 'text-green',
  dim: 'text-text-muted'
}

/**
 * Fullscreen boot overlay. Reveals lines one-by-one on their cumulative delay,
 * runs a progress bar, then fades out (parent unmounts it once `booted`).
 * Clicking anywhere skips.
 */
export function BootSequence({ onSkip }: { onSkip: () => void }) {
  const t = useT()
  const [visibleCount, setVisibleCount] = useState(0)

  // Precompute cumulative timestamps for each line.
  const marks = useMemo(() => {
    let acc = 0
    return BOOT_LINES.map((l) => (acc += l.t))
  }, [])

  useEffect(() => {
    const timers = marks.map((m, i) =>
      window.setTimeout(() => setVisibleCount(i + 1), m)
    )
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [marks])

  const total = marks[marks.length - 1]
  const progress = Math.min(100, (visibleCount / BOOT_LINES.length) * 100)

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-void"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
      onClick={onSkip}
    >
      <div className="relative w-[min(560px,90vw)] px-6">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center">
            <MindeckMark size={26} className="drop-shadow-[0_0_8px_rgba(56,214,232,0.45)]" />
          </div>
          <div>
            <div className="font-sans text-sm font-semibold tracking-wide text-text-primary">
              Mindeck COMMAND CENTER
            </div>
            <div className="tech-label mt-0.5 text-text-muted">{t.boot.bootstrap}</div>
          </div>
        </div>

        <div className="min-h-[190px] font-mono text-[12.5px] leading-relaxed">
          {BOOT_LINES.slice(0, visibleCount).map((line, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.18 }}
              className={cn('flex gap-2', TONE[line.tone])}
            >
              <span className="select-none text-text-muted">›</span>
              <span>{t.boot.lines[i]}</span>
            </motion.div>
          ))}
          {visibleCount < BOOT_LINES.length && (
            <span className="ml-3 inline-block h-3.5 w-2 animate-pulse bg-cyan align-middle" />
          )}
        </div>

        <div className="mt-6">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="tech-label text-text-muted">{t.boot.initializing}</span>
            <span className="font-mono text-[11px] text-cyan">{Math.round(progress)}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-elevated">
            <motion.div
              className="h-full rounded-full bg-linear-to-r from-cyan via-blue to-purple"
              animate={{ width: `${progress}%` }}
              transition={{ duration: total / 1000 / BOOT_LINES.length, ease: 'linear' }}
              style={{ boxShadow: '0 0 12px rgb(var(--accent-cyan) / 0.6)' }}
            />
          </div>
          <div className="tech-label mt-3 text-center text-text-muted opacity-60">
            {t.boot.skip}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

/** Convenience: total boot time so the shell can time the reveal. */
export const BOOT_TOTAL_MS = BOOT_LINES.reduce((a, l) => a + l.t, 0) + 400

export { AnimatePresence }
