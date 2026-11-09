// The Mindeck logo: a cyan M on its tile — the same design everywhere, from the Dock to the favicon,
// in two appearances: the dark tile (dark mode) and the white tile (light mode, and wherever a system
// has no appearance to follow). The builders below turn it into the app icons (macOS, Windows, Linux,
// iOS, Android), the tile the apps and the website show as their logo, and the bare M; render.mjs
// writes them out.

/** The M: stroke width, half the distance between the stems, stem height, depth of the V (its centre line). */
export const SHAPE = { w: 100, half: 226, h: 360, depth: 235.75 }

/**
 * The two appearances (and iOS/macOS's tinted one, which the system colors itself): the tile's ground
 * (a diagonal gradient, cyan light from the top left, blue from the bottom right), the M's ink (top to
 * bottom), its glow, and the hairline along the tile's edge.
 */
export const THEMES = {
  dark: {
    ground: ['#15212f', '#080c14', '#04060b'],
    cyan: '.30',
    blue: '.26',
    ink: ['#c2faff', '#55e3f2', '#2cc2e6'],
    glow: '.5',
    edge: ['#fff', '.08']
  },
  // The same tile in daylight: white, the same two lights a little softer, the M in a deeper cyan so it reads on white.
  light: {
    ground: ['#ffffff', '#f5f8fb', '#e9eff5'],
    cyan: '.20',
    blue: '.14',
    ink: ['#3cc9e8', '#13a9d6', '#0a86bf'],
    glow: '.22',
    edge: ['#0b1220', '.08']
  },
  // Tinted (iOS 18+, macOS 26+): grey levels only — the system tints them with the user's color.
  tinted: {
    ground: ['#1c1c1c', '#0a0a0a', '#000000'],
    cyan: '0',
    blue: '0',
    ink: ['#ffffff', '#ececec', '#d6d6d6'],
    glow: '.35',
    edge: ['#fff', '.06']
  }
}

/** The M runs from ice to cyan, top to bottom (the dark appearance's ink). */
export const INK = THEMES.dark.ink

/** The M's outline in its own units, centred on x = 0: sharp peaks (mitred), a flat foot. */
export function geometry({ w, half, h, depth }) {
  const hw = w / 2
  const s = Math.hypot(half, depth)
  const m = depth / half
  // The left diagonal's two edges; the right one mirrors them.
  const upper = { x: -half + (depth * hw) / s, y: (-half * hw) / s }
  const lower = { x: -half - (depth * hw) / s, y: (half * hw) / s }
  const at = (edge, x) => edge.y + m * (x - edge.x)
  const peak = at(upper, -half - hw)
  const notch = at(upper, 0)
  const inner = at(lower, -half + hw)
  const vee = at(lower, 0)
  const M = [[-half - hw, h], [-half - hw, peak], [0, notch], [half + hw, peak], [half + hw, h], [half - hw, h], [half - hw, inner], [0, vee], [-half + hw, inner], [-half + hw, h]]
  return { M, box: { x: -half - hw, y: peak, w: 2 * (half + hw), h: h - peak } }
}

const num = (v) => String(Math.round(v * 100) / 100)

/** The M's path fitted to a box `width` wide, centred on (cx, cy). */
export function placed(width, cx, cy) {
  const g = geometry(SHAPE)
  const k = width / g.box.w
  const tx = cx - (g.box.x + g.box.w / 2) * k
  const ty = cy - (g.box.y + g.box.h / 2) * k
  return { d: 'M' + g.M.map(([x, y]) => `${num(x * k + tx)} ${num(y * k + ty)}`).join('L') + 'Z', top: g.box.y * k + ty, bottom: (g.box.y + g.box.h) * k + ty }
}

/**
 * The M's SVG elements: its appearance's gradient (with a soft glow when `glow` is set), or one flat
 * CSS color. `id` keeps the gradient's ids apart when two appearances share one SVG (the favicon).
 */
function markElements(p, { color, glow = 0, theme = 'dark', id = '' } = {}) {
  if (color) return { defs: '', body: `<path d="${p.d}" fill="${color}"/>` }
  const t = THEMES[theme]
  const defs = `<linearGradient id="${id}mk-ink" gradientUnits="userSpaceOnUse" x1="0" y1="${num(p.top)}" x2="0" y2="${num(p.bottom)}">${t.ink.map((c, i) => `<stop offset="${i / (t.ink.length - 1)}" stop-color="${c}"/>`).join('')}</linearGradient>` +
    (glow ? `<filter id="${id}mk-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${num(glow)}"/></filter>` : '')
  const m = `<path d="${p.d}" fill="url(#${id}mk-ink)"/>`
  return { defs, body: (glow ? `<g opacity="${t.glow}" filter="url(#${id}mk-glow)">${m}</g>` : '') + m }
}

/** The tile's ground: a diagonal gradient, cyan light from the top left, blue from the bottom right. */
function ground(x, size, theme = 'dark', id = '') {
  const t = THEMES[theme]
  const defs = `<linearGradient id="${id}t-bg" gradientUnits="userSpaceOnUse" x1="${x}" y1="${x}" x2="${x + size}" y2="${x + size}"><stop offset="0" stop-color="${t.ground[0]}"/><stop offset=".55" stop-color="${t.ground[1]}"/><stop offset="1" stop-color="${t.ground[2]}"/></linearGradient>` +
    `<radialGradient id="${id}t-cyan" gradientUnits="userSpaceOnUse" cx="${x + size * 0.16}" cy="${x + size * 0.06}" r="${size * 0.85}"><stop offset="0" stop-color="#38d6e8" stop-opacity="${t.cyan}"/><stop offset="1" stop-color="#38d6e8" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="${id}t-blue" gradientUnits="userSpaceOnUse" cx="${x + size * 0.96}" cy="${x + size}" r="${size * 0.75}"><stop offset="0" stop-color="#4a84ff" stop-opacity="${t.blue}"/><stop offset="1" stop-color="#4a84ff" stop-opacity="0"/></radialGradient>`
  return { defs, fills: [`url(#${id}t-bg)`, `url(#${id}t-cyan)`, `url(#${id}t-blue)`] }
}

const svg = (w, h, defs, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><defs>${defs}</defs>${body}</svg>\n`

/**
 * An app icon, 1024 units square, in an appearance (`dark`, `light` or `tinted`). The M is always 56 % of the tile's width.
 * - full:     edge to edge and opaque (iOS, apple-touch-icon — the system rounds the corners)
 * - macos:    Apple's macOS grid — an 824 tile at (100,100), rounded, with its shadow
 * - rounded:  a rounded tile with a little margin (Windows, Linux)
 * - tile:     the rounded tile edge to edge — the logo in the apps and on the website, favicon, tray, splash
 * - android-bg / android-fg / android-mono: the layers of Android's adaptive icon (the M stays inside the safe zone)
 */
export function icon(kind, theme = 'dark') {
  return svg(1024, 1024, ...iconParts(kind, theme))
}

/** An icon's defs and body (ids prefixed with `id`), to put into an SVG of one's own. */
function iconParts(kind, theme, id = '') {
  if (kind === 'android-fg' || kind === 'android-mono') {
    const mono = kind === 'android-mono'
    const { defs, body } = markElements(placed(400, 512, 512), mono ? { color: '#fff' } : { glow: 20, theme, id })
    return [defs, body]
  }
  const [o, size, radius] = { full: [0, 1024, 0], 'android-bg': [0, 1024, 0], macos: [100, 824, 185.4], rounded: [40, 944, 212], tile: [0, 1024, 229] }[kind]
  const t = THEMES[theme]
  const gr = ground(o, size, theme, id)
  const rect = (fill, extra = '') => `<rect x="${o}" y="${o}" width="${size}" height="${size}" rx="${radius}" fill="${fill}"${extra}/>`
  let defs = gr.defs
  let body = gr.fills.map((f) => rect(f)).join('')
  if (kind === 'macos') {
    defs += `<filter id="${id}t-shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity=".36"/></filter>`
    body = rect(t.ground[1], ` filter="url(#${id}t-shadow)"`) + body
  }
  if (kind === 'android-bg') return [defs, body]
  // A hairline along the tile's edge: light on the dark tile, a shade on the white one.
  if (kind !== 'full') body += `<rect x="${o + 1.5}" y="${o + 1.5}" width="${size - 3}" height="${size - 3}" rx="${radius - 1.5}" fill="none" stroke="${t.edge[0]}" stroke-opacity="${t.edge[1]}" stroke-width="3"/>`
  const mk = markElements(placed(size * 0.56, o + size / 2, o + size / 2), { glow: size * 0.028, theme, id })
  return [defs + mk.defs, body + mk.body]
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

/** The bare M in a tight box — ice to cyan, or one flat color (print, one-color uses). */
export function mark(color) {
  const g = geometry(SHAPE)
  const { defs, body } = markElements(placed(g.box.w, g.box.w / 2, g.box.h / 2), { color })
  return svg(num(g.box.w), num(g.box.h), defs, body)
}
