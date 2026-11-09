// The Mindeck logo: the reactor — a deck of three layers (Mindeck's stack of projects, agents and
// notes) inside a ring of four arcs, a dotted inner ring and four lights where the arcs part. One
// design everywhere, from the Dock to the favicon, in the system's appearances:
//   light   the white tile (light mode, and wherever a system shows one icon only)
//   dark    the navy tile with its cyan halo (dark mode)
//   tinted  grey levels on black (iOS 18+ and macOS 26+ tint them with the user's color)
//   clear   white on nothing (macOS 26+ and iOS 26+ clear icons; one-color uses)
// Drawn after Robin's reference artwork (build/brand/reactor/, 2026-11-09). The builders below turn
// it into the app icons (macOS, Windows, Linux, iOS, Android), the tile the apps show as their logo,
// and the bare mark; render.mjs writes them out.

/** The four appearances: the tile's ground, the reactor's colors, the dark one's halo and glow. */
export const THEMES = {
  dark: {
    ground: { from: [0, 0], to: [1024, 1024], stops: [['0', '#15212f'], ['.55', '#080c14'], ['1', '#04060b']] },
    halo: '.35',
    glow: { opacity: '.7', ring: '#38d6e8', deck: '#7ff0fb' },
    dots: '#4a84ff', ring: '#38d6e8', lights: '#c2faff', lower: '#4a84ff', middle: '#38d6e8', top: '#c2faff',
    edge: ['#fff', '.08']
  },
  light: {
    ground: { from: [0, 0], to: [0, 1024], stops: [['0', '#ffffff'], ['1', '#dfe8ef']] },
    dots: '#3f6fe0', ring: '#17a9c4', lights: '#0a7e95', lower: '#3f6fe0', middle: '#17a9c4', top: '#0a7e95',
    edge: ['#0b1220', '.08']
  },
  tinted: {
    ground: { solid: '#000000' },
    dots: '#7a7a7a', ring: '#bdbdbd', lights: '#ffffff', lower: '#7a7a7a', middle: '#bdbdbd', top: '#ffffff',
    edge: ['#fff', '.06']
  },
  clear: {
    dots: 'rgba(255,255,255,.45)', ring: 'rgba(255,255,255,.75)', lights: '#ffffff', lower: 'rgba(255,255,255,.45)', middle: 'rgba(255,255,255,.75)', top: '#ffffff'
  }
}

/** The reactor's parts on its 1024 canvas, centred on (512, 512). */
const RING = 'r="330" fill="none" stroke-width="40" stroke-dasharray="408.4 110" stroke-dashoffset="204.2"'
const DOTS = 'r="262" fill="none" stroke-width="22" stroke-dasharray="5 17.86"'
const LIGHTS = [[745.3, 745.3], [278.7, 745.3], [278.7, 278.7], [745.3, 278.7]]
const DECK = 'translate(512 512) scale(0.62) translate(-512 -494)'
const TOP = 'M512 262L800 406L512 550L224 406Z'
const MIDDLE = 'M224 494L512 638L800 494'
const LOWER = 'M224 582L512 726L800 582'
/** How far the reactor reaches from its centre (the ring's outer edge), on the 1024 canvas. */
export const REACH = 350

const num = (v) => String(Math.round(v * 1000) / 1000)

/**
 * The reactor in an appearance, scaled by `k` about its centre and put at (cx, cy); `color`
 * draws it in one flat color instead (Android's monochrome layer, one-color marks). `id` keeps
 * gradient and filter ids apart when two appearances share one SVG (the favicon).
 */
function reactor(theme, { k = 1, cx = 512, cy = 512, color, id = '' } = {}) {
  const t = color ? { dots: color, ring: color, lights: color, lower: color, middle: color, top: color } : THEMES[theme]
  const parts =
    `<circle cx="512" cy="512" ${DOTS} stroke="${t.dots}"/>` +
    `<circle cx="512" cy="512" ${RING} stroke="${t.ring}" stroke-linecap="round"/>` +
    `<g fill="${t.lights}">${LIGHTS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="22"/>`).join('')}</g>` +
    `<g transform="${DECK}"><path d="${LOWER}" fill="none" stroke="${t.lower}" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${MIDDLE}" fill="none" stroke="${t.middle}" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${TOP}" fill="${t.top}" stroke="${t.top}" stroke-width="44" stroke-linejoin="round"/></g>`
  // The dark tile's glow: the ring and the top layer, blurred, under the sharp ones.
  const glow = !color && t.glow
  const defs = glow ? `<filter id="${id}r-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="16"/></filter>` : ''
  const glowing = glow
    ? `<g filter="url(#${id}r-glow)" opacity="${t.glow.opacity}"><circle cx="512" cy="512" ${RING} stroke="${t.glow.ring}"/><g transform="${DECK}"><path d="${TOP}" fill="${t.glow.deck}"/></g></g>`
    : ''
  const place = k === 1 && cx === 512 && cy === 512 ? '' : ` transform="translate(${num(cx)} ${num(cy)}) scale(${num(k)}) translate(-512 -512)"`
  return { defs, body: `<g${place}>${glowing}${parts}</g>` }
}

/** The tile's ground in an appearance (none for clear), and the dark one's halo — on a square `size` wide at (x, x). */
function ground(theme, x, size, id = '') {
  const g = THEMES[theme].ground
  if (!g) return { defs: '', fills: [] }
  const s = size / 1024
  let defs = ''
  const fills = []
  if (g.solid) fills.push(g.solid)
  else {
    const [x1, y1] = g.from.map((v) => x + v * s)
    const [x2, y2] = g.to.map((v) => x + v * s)
    defs += `<linearGradient id="${id}t-bg" gradientUnits="userSpaceOnUse" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}">${g.stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>`
    fills.push(`url(#${id}t-bg)`)
  }
  if (THEMES[theme].halo) {
    const c = x + size / 2
    defs += `<radialGradient id="${id}t-halo" gradientUnits="userSpaceOnUse" cx="${num(c)}" cy="${num(c)}" r="${num(420 * s)}"><stop offset="0" stop-color="#38d6e8" stop-opacity="${THEMES[theme].halo}"/><stop offset="1" stop-color="#38d6e8" stop-opacity="0"/></radialGradient>`
    fills.push(`url(#${id}t-halo)`)
  }
  return { defs, fills }
}

const svg = (w, h, defs, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><defs>${defs}</defs>${body}</svg>\n`

/**
 * An app icon, 1024 units square, in an appearance (`light`, `dark`, `tinted`, `clear`). The
 * reactor fills the tile as in the reference artwork (its ring 68 % of the tile's width).
 * - full:     edge to edge (iOS, Icon Composer, apple-touch-icon — the system shapes it)
 * - macos:    Apple's macOS grid — an 824 tile at (100,100), rounded, with its shadow
 * - rounded:  a rounded tile with a little margin (Windows, Linux)
 * - tile:     the rounded tile edge to edge — the logo in the apps, favicon, tray, splash
 * - android-bg / android-fg / android-mono: the layers of Android's adaptive icon (the reactor inside the safe zone)
 */
export function icon(kind, theme = 'dark') {
  return svg(1024, 1024, ...iconParts(kind, theme))
}

/** An icon's defs and body (ids prefixed with `id`), to put into an SVG of one's own. */
function iconParts(kind, theme, id = '') {
  if (kind === 'android-fg' || kind === 'android-mono') {
    // Android's safe zone is a circle 61 % of the layer wide: the ring's outer edge stays inside it.
    const r = reactor(theme, { k: 0.84, ...(kind === 'android-mono' ? { color: '#fff' } : {}), id })
    return [r.defs, r.body]
  }
  const [o, size, radius] = { full: [0, 1024, 0], 'android-bg': [0, 1024, 0], macos: [100, 824, 185.4], rounded: [40, 944, 212], tile: [0, 1024, 229] }[kind]
  const t = THEMES[theme]
  const gr = ground(theme, o, size, id)
  const rect = (fill, extra = '') => `<rect x="${o}" y="${o}" width="${size}" height="${size}" rx="${radius}" fill="${fill}"${extra}/>`
  let defs = gr.defs
  let body = gr.fills.map((f) => rect(f)).join('')
  if (kind === 'macos' && gr.fills.length) {
    defs += `<filter id="${id}t-shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity=".36"/></filter>`
    body = rect(t.ground.solid ?? t.ground.stops[1][1], ` filter="url(#${id}t-shadow)"`) + body
  }
  if (kind === 'android-bg') return [defs, body]
  // A hairline along the tile's edge: light on the dark tile, a shade on the white one.
  if (kind !== 'full' && t.edge) body += `<rect x="${o + 1.5}" y="${o + 1.5}" width="${size - 3}" height="${size - 3}" rx="${radius - 1.5}" fill="none" stroke="${t.edge[0]}" stroke-opacity="${t.edge[1]}" stroke-width="3"/>`
  const r = reactor(theme, { k: size / 1024, cx: o + size / 2, cy: o + size / 2, id })
  return [defs + r.defs, body + r.body]
}

/**
 * One SVG with both appearances that follows the viewer's: the white tile, and the dark one under
 * `prefers-color-scheme: dark` — for favicons and web pages, which the browser draws in the system's
 * appearance. Without one (older browsers, no setting) it is the white tile.
 */
export function adaptiveIcon(kind) {
  const [ld, lb] = iconParts(kind, 'light', 'l-')
  const [dd, db] = iconParts(kind, 'dark', 'd-')
  const style = '<style>.d{display:none}@media (prefers-color-scheme: dark){.l{display:none}.d{display:inline}}</style>'
  return svg(1024, 1024, ld + dd, `${style}<g class="l">${lb}</g><g class="d">${db}</g>`)
}

/**
 * The bare reactor in a tight box (the ring's outer edge): in an appearance's colors without a
 * ground (default: dark — for dark backgrounds; `clear` is white), or in one flat color.
 */
export function mark(color, theme = 'dark') {
  const size = REACH * 2
  const r = reactor(theme, { cx: size / 2, cy: size / 2, ...(color ? { color } : {}) })
  return svg(size, size, r.defs, r.body)
}

/**
 * The Icon Composer document's two layers in an appearance (macOS 26+, iOS 26+): the ground (the
 * gradient, the dark one's halo — none for clear) and the reactor on nothing. Light and dark come out
 * as in the full icon; in the tinted and clear looks the system shows the clear reactor on its own glass.
 */
export function layers(theme) {
  const gr = ground(theme, 0, 1024)
  const r = reactor(theme)
  return {
    ground: gr.fills.length ? svg(1024, 1024, gr.defs, gr.fills.map((f) => `<rect width="1024" height="1024" fill="${f}"/>`).join('')) : null,
    reactor: svg(1024, 1024, r.defs, r.body)
  }
}
