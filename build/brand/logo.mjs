// The Mindeck logo: an M with two layers stacked under its V — a deck.
// One geometry for every place the logo appears. The builders below turn it into the app
// icons (macOS, Windows, Linux, iOS, Android), the favicon and the bare mark; render.mjs
// writes them out. Plain polygons only (no masks or clip paths): every renderer draws them alike.

/** normal: 40 px and up (app icons, splash, headers). small: below that (favicon, tray, UI chrome) — bolder, one layer. */
export const SHAPES = {
  normal: { w: 100, half: 226, h: 360, off: 66, gap: 16, n: 3, overshoot: 80 },
  small: { w: 160, half: 250, h: 380, off: 160, gap: 48, n: 2, overshoot: 40 }
}

/** The M runs light to dark top to bottom; the layers are the brand's blue and purple (the small mark's one layer a lighter blue). */
export const COLORS = {
  dark: { m: ['#c2faff', '#55e3f2', '#2cc2e6'], bands: ['#4a84ff', '#9e7aff'], small: ['#6f9bff'] },
  light: { m: ['#1b2a44', '#111b2e', '#0a111e'], bands: ['#3d74f2', '#8a62f2'], small: ['#3d74f2'] }
}

/** The outlines in the mark's own units, centered on x = 0. */
export function geometry({ w, half, h, off, gap, n, overshoot }) {
  const hw = w / 2
  // The V's depth puts the lowest layer's tip `overshoot` below the stems.
  let yv = h * 0.6
  for (let k = 0; k < 30; k++) yv += h + overshoot - (yv + (hw * Math.hypot(half, yv)) / half + (n - 1) * off)
  const s = Math.hypot(half, yv)
  const m = yv / half
  // The left diagonal's two edges; the right one mirrors them.
  const upper = { x: -half + (yv * hw) / s, y: (-half * hw) / s }
  const lower = { x: -half - (yv * hw) / s, y: (half * hw) / s }
  const at = (edge, x) => edge.y + m * (x - edge.x)
  const peak = at(upper, -half - hw)
  const notch = at(upper, 0)
  const inner = at(lower, -half + hw)
  const vee = at(lower, 0)
  const M = [[-half - hw, h], [-half - hw, peak], [0, notch], [half + hw, peak], [half + hw, h], [half - hw, h], [half - hw, inner], [0, vee], [-half + hw, inner], [-half + hw, h]]
  // Each layer is the strip between the one above it (plus the gap) and its own lower edge, kept off the stems by the gap too.
  const gapY = (gap * s) / half
  const x = -half + hw + gap
  const bands = []
  for (let i = 1; i < n; i++) {
    const top = (px) => vee + (i - 1) * off + gapY - Math.abs(px) * m
    const bottom = (px) => vee + i * off - Math.abs(px) * m
    bands.push([[x, top(x)], [0, top(0)], [-x, top(-x)], [-x, bottom(-x)], [0, bottom(0)], [x, bottom(x)]])
  }
  const bottom = Math.max(h, vee + (n - 1) * off)
  return { M, bands, box: { x: -half - hw, y: peak, w: 2 * (half + hw), h: bottom - peak } }
}

const num = (v) => String(Math.round(v * 100) / 100)
/** Polygon → path data, scaled by k and moved by (tx, ty). */
const path = (pts, k, tx, ty) => 'M' + pts.map(([x, y]) => `${num(x * k + tx)} ${num(y * k + ty)}`).join('L') + 'Z'

/** The mark's paths fitted to a box `width` wide, centered on (cx, cy). */
export function placed(shape, width, cx, cy) {
  const g = geometry(SHAPES[shape])
  const k = width / g.box.w
  const tx = cx - (g.box.x + g.box.w / 2) * k
  const ty = cy - (g.box.y + g.box.h / 2) * k
  return { shape, m: path(g.M, k, tx, ty), bands: g.bands.map((b) => path(b, k, tx, ty)), top: g.box.y * k + ty, bottom: (g.box.y + g.box.h) * k + ty }
}

/** The bare mark in a box from (0,0), 100 units tall — what the apps' and the website's components draw. */
export function outline(shape) {
  const g = geometry(SHAPES[shape])
  const width = (g.box.w / g.box.h) * 100
  const p = placed(shape, width, width / 2, 50)
  return { width: Number(num(width)), height: 100, m: p.m, bands: p.bands }
}

const stops = (c) => c.map((col, i) => `<stop offset="${i / (c.length - 1)}" stop-color="${col}"/>`).join('')

/**
 * The mark's SVG elements. `scheme`: dark (on dark grounds), light (on light grounds), or one
 * CSS color for every part (monochrome: '#fff', 'currentColor').
 */
export function markElements(p, { scheme = 'dark', id = 'mk', glow = 0 } = {}) {
  if (scheme !== 'dark' && scheme !== 'light') return { defs: '', body: [p.m, ...p.bands].map((d) => `<path d="${d}" fill="${scheme}"/>`).join('') }
  const c = COLORS[scheme]
  const bands = p.shape === 'small' ? c.small : c.bands
  const defs = `<linearGradient id="${id}-ink" gradientUnits="userSpaceOnUse" x1="0" y1="${num(p.top)}" x2="0" y2="${num(p.bottom)}">${stops(c.m)}</linearGradient>` +
    (glow ? `<filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${num(glow)}"/></filter>` : '')
  const m = `<path d="${p.m}" fill="url(#${id}-ink)"/>`
  return { defs, body: p.bands.map((d, i) => `<path d="${d}" fill="${bands[i]}"/>`).join('') + (glow ? `<g opacity=".5" filter="url(#${id}-glow)">${m}</g>` : '') + m }
}

/** The tile's ground: deep navy, cyan light from the top left, blue from the bottom right. */
function ground(x, size) {
  const defs = `<linearGradient id="t-bg" gradientUnits="userSpaceOnUse" x1="${x}" y1="${x}" x2="${x + size}" y2="${x + size}"><stop offset="0" stop-color="#15212f"/><stop offset=".55" stop-color="#080c14"/><stop offset="1" stop-color="#04060b"/></linearGradient>` +
    `<radialGradient id="t-cyan" gradientUnits="userSpaceOnUse" cx="${x + size * 0.16}" cy="${x + size * 0.06}" r="${size * 0.85}"><stop offset="0" stop-color="#38d6e8" stop-opacity=".30"/><stop offset="1" stop-color="#38d6e8" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="t-blue" gradientUnits="userSpaceOnUse" cx="${x + size * 0.96}" cy="${x + size}" r="${size * 0.75}"><stop offset="0" stop-color="#4a84ff" stop-opacity=".26"/><stop offset="1" stop-color="#4a84ff" stop-opacity="0"/></radialGradient>`
  return { defs, fills: ['url(#t-bg)', 'url(#t-cyan)', 'url(#t-blue)'] }
}

const svg = (w, h, defs, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><defs>${defs}</defs>${body}</svg>\n`

/**
 * An app icon, 1024 units square.
 * - full:     edge to edge and opaque (iOS, apple-touch-icon — the system rounds the corners)
 * - macos:    Apple's macOS grid — an 824 tile at (100,100), rounded, with its shadow
 * - rounded:  a rounded tile almost edge to edge (Windows, Linux, favicon, tray)
 * - android-bg / android-fg / android-mono: the layers of Android's adaptive icon (the mark stays inside the safe zone)
 * - glyph:    the mark alone on transparent (splash screen)
 * `shape`: normal, or small for icons shown at 16–48 px.
 */
export function icon(kind, shape = 'normal') {
  if (kind === 'android-fg' || kind === 'android-mono' || kind === 'glyph') {
    const width = kind === 'glyph' ? 760 : 400
    const mono = kind === 'android-mono'
    const { defs, body } = markElements(placed(shape, width, 512, 512), { scheme: mono ? '#fff' : 'dark', glow: mono ? 0 : width * 0.05 })
    return svg(1024, 1024, defs, body)
  }
  const [o, size, radius] = { full: [0, 1024, 0], 'android-bg': [0, 1024, 0], macos: [100, 824, 185.4], rounded: [40, 944, 212] }[kind]
  const gr = ground(o, size)
  const rect = (fill, extra = '') => `<rect x="${o}" y="${o}" width="${size}" height="${size}" rx="${radius}" fill="${fill}"${extra}/>`
  let defs = gr.defs
  let body = gr.fills.map((f) => rect(f)).join('')
  if (kind === 'macos') {
    defs += '<filter id="t-shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity=".36"/></filter>'
    body = rect('#080c14', ' filter="url(#t-shadow)"') + body
  }
  if (kind === 'android-bg') return svg(1024, 1024, defs, body)
  // A hairline of light along the tile's edge.
  if (kind !== 'full') body += `<rect x="${o + 1.5}" y="${o + 1.5}" width="${size - 3}" height="${size - 3}" rx="${radius - 1.5}" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="3"/>`
  const mk = markElements(placed(shape, size * (shape === 'small' ? 0.66 : 0.56), o + size / 2, o + size / 2), { glow: shape === 'small' ? 0 : size * 0.028 })
  return svg(1024, 1024, defs + mk.defs, body + mk.body)
}

/** The bare mark in a tight box (docs, print, anywhere an <img> does). */
export function mark(scheme = 'dark', shape = 'normal') {
  const o = outline(shape)
  const { defs, body } = markElements({ ...placed(shape, o.width, o.width / 2, 50), shape }, { scheme })
  return svg(o.width, o.height, defs, body)
}
