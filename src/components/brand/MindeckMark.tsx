import { useId } from 'react'
import { useAppearance } from '@/lib/theme'
import { MARK, MARK_COLORS } from './markPaths'

/**
 * Mindeck's mark — the M with its layers stacked under the V (build/brand/logo.mjs).
 * `size` is its height in px; below 40 it draws the bolder small mark, which stays crisp there.
 * Light on the dark theme, dark on the light one.
 */
export function MindeckMark({ size, className }: { size: number; className?: string }) {
  // useId's colons would end the url(#…) reference early.
  const id = `mindeck-mark${useId().replace(/[^\w-]/g, '')}`
  const colors = MARK_COLORS[useAppearance((s) => s.theme)]
  const small = size < 40
  const shape = small ? MARK.small : MARK.normal
  const bands = small ? colors.small : colors.bands
  return (
    <svg
      viewBox={`0 0 ${shape.width} ${shape.height}`}
      width={(size * shape.width) / shape.height}
      height={size}
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={shape.height}>
          {colors.m.map((color, i) => (
            <stop key={color} offset={i / (colors.m.length - 1)} stopColor={color} />
          ))}
        </linearGradient>
      </defs>
      {shape.bands.map((d, i) => (
        <path key={d} d={d} fill={bands[i]} />
      ))}
      <path d={shape.m} fill={`url(#${id})`} />
    </svg>
  )
}
