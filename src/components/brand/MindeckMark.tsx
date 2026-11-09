import tile from '../../../build/brand/tile.svg'
import tileLight from '../../../build/brand/tile-light.svg'
import { useAppearance } from '@/lib/theme'

/** Mindeck's logo — the app icon's tile with the cyan M (build/brand/logo.mjs), `size` px square: the dark tile in the dark theme, the white one in the light. */
export function MindeckMark({ size, className }: { size: number; className?: string }) {
  const theme = useAppearance((s) => s.theme)
  return <img src={theme === 'light' ? tileLight : tile} width={size} height={size} alt="" draggable={false} className={className} />
}
