import tile from '../../../build/brand/tile.svg'

/** Mindeck's logo — the app icon's tile with the cyan M (build/brand/logo.mjs), `size` px square. */
export function MindeckMark({ size, className }: { size: number; className?: string }) {
  return <img src={tile} width={size} height={size} alt="" draggable={false} className={className} />
}
