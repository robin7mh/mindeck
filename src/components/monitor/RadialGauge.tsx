/** The accent color (Settings → Appearance): the System module draws every metric in it. */
const ACCENT = 'var(--accent-cyan)'

/** Circular gauge (0..100) with a glowing arc, in the accent color. Used for the headline metric. */
export function RadialGauge({ value, size = 68, label }: { value: number; size?: number; label?: string }) {
  const stroke = 5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, value)) / 100
  const dash = c * pct

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgb(var(--border-hud) / 0.6)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`rgb(${ACCENT})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          style={{ filter: `drop-shadow(0 0 4px rgb(${ACCENT} / calc(0.6 * var(--glow))))`, transition: 'stroke-dasharray 0.6s ease' }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="font-mono text-sm font-semibold text-text-primary tabular-nums">
          {Math.round(value)}
        </span>
        {label && <span className="tech-label text-text-muted">{label}</span>}
      </div>
    </div>
  )
}
