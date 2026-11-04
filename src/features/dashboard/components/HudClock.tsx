/**
 * Large, calm digital clock. Inter (not the mono font, whose zero is dotted) in
 * a light weight and the secondary text color — present, but it doesn't glare.
 */
export function HudClock({ now }: { now: Date }) {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')

  return (
    <div className="flex flex-col items-center" aria-label={`${hh}:${mm}:${ss}`}>
      <div
        className="font-sans font-extralight leading-none tracking-tight text-text-secondary tabular-nums"
        style={{ fontSize: 'clamp(64px, 14vh, 136px)' }}
      >
        {hh}:{mm}
      </div>
      <div className="mt-2 font-sans text-[16px] font-medium tracking-[0.08em] text-text-muted tabular-nums">{ss}</div>
    </div>
  )
}
