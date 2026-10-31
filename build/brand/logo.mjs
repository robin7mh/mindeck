// The Mindeck logo: a cyan M on the dark tile — the same everywhere, from the Dock to the favicon.
// The builders below turn it into the app icons (macOS, Windows, Linux, iOS, Android), the tile the
// apps and the website show as their logo, and the bare M; render.mjs writes them out.

/** The M: stroke width, half the distance between the stems, stem height, depth of the V (its centre line). */
export const SHAPE = { w: 100, half: 226, h: 360, depth: 235.75 }

/** The M runs from ice to cyan, top to bottom. */
export const INK = ['#c2faff', '#55e3f2', '#2cc2e6']

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

/** The M's SVG elements: the ice-to-cyan gradient (with a soft glow when `glow` is set), or one flat CSS color. */
function markElements(p, { color, glow = 0 } = {}) {
  if (color) return { defs: '', body: `<path d="${p.d}" fill="${color}"/>` }
  const defs = `<linearGradient id="mk-ink" gradientUnits="userSpaceOnUse" x1="0" y1="${num(p.top)}" x2="0" y2="${num(p.bottom)}">${INK.map((c, i) => `<stop offset="${i / (INK.length - 1)}" stop-color="${c}"/>`).join('')}</linearGradient>` +
    (glow ? `<filter id="mk-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${num(glow)}"/></filter>` : '')
  const m = `<path d="${p.d}" fill="url(#mk-ink)"/>`
  return { defs, body: (glow ? `<g opacity=".5" filter="url(#mk-glow)">${m}</g>` : '') + m }
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
 * An app icon, 1024 units square. The M is always 56 % of the tile's width.
 * - full:     edge to edge and opaque (iOS, apple-touch-icon — the system rounds the corners)
 * - macos:    Apple's macOS grid — an 824 tile at (100,100), rounded, with its shadow
 * - rounded:  a rounded tile with a little margin (Windows, Linux)
 * - tile:     the rounded tile edge to edge — the logo in the apps and on the website, favicon, tray, splash
 * - android-bg / android-fg / android-mono: the layers of Android's adaptive icon (the M stays inside the safe zone)
 */
export function icon(kind) {
  if (kind === 'android-fg' || kind === 'android-mono') {
    const mono = kind === 'android-mono'
    const { defs, body } = markElements(placed(400, 512, 512), mono ? { color: '#fff' } : { glow: 20 })
    return svg(1024, 1024, defs, body)
  }
  const [o, size, radius] = { full: [0, 1024, 0], 'android-bg': [0, 1024, 0], macos: [100, 824, 185.4], rounded: [40, 944, 212], tile: [0, 1024, 229] }[kind]
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
  const mk = markElements(placed(size * 0.56, o + size / 2, o + size / 2), { glow: size * 0.028 })
  return svg(1024, 1024, defs + mk.defs, body + mk.body)
}

/** The bare M in a tight box — ice to cyan, or one flat color (print, one-color uses). */
export function mark(color) {
  const g = geometry(SHAPE)
  const { defs, body } = markElements(placed(g.box.w, g.box.w / 2, g.box.h / 2), { color })
  return svg(num(g.box.w), num(g.box.h), defs, body)
}
