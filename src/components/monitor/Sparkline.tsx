import { useId } from 'react'

/** The accent color (Settings → Appearance): the System module draws every metric in it. */
const ACCENT = 'var(--accent-cyan)'

/**
 * Lightweight rolling SVG sparkline with an area fill + glow, in the accent
 * color. No chart library — matches the HUD aesthetic and stays cheap.
 */
export function Sparkline({ data, height = 40, max = 100 }: { data: number[]; height?: number; max?: number }) {
  const id = useId()
  const w = 100
  const h = height
  const n = data.length

  if (n < 2) return <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" />

  const pts = data.map((v, i) => {
    const x = (i / (n - 1)) * w
    const y = h - (Math.min(v, max) / max) * (h - 4) - 2
    return [x, y] as const
  })

  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  const area = `${line} L${w},${h} L0,${h} Z`
  const [lastX, lastY] = pts[pts.length - 1]

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full">
      <defs>
        <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={`rgb(${ACCENT} / 0.35)`} />
          <stop offset="100%" stopColor={`rgb(${ACCENT} / 0)`} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#fill-${id})`} />
      <path
        d={line}
        fill="none"
        stroke={`rgb(${ACCENT})`}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        style={{ filter: `drop-shadow(0 0 3px rgb(${ACCENT} / calc(0.7 * var(--glow))))` }}
      />
      <circle cx={lastX} cy={lastY} r={1.8} fill={`rgb(${ACCENT})`} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
