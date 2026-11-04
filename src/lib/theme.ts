import { create } from 'zustand'

/** The token set in use (index.css). */
export type Theme = 'dark' | 'light'
/** What the user picked: a fixed theme, or follow the OS. */
export type Mode = Theme | 'system'
export type Accent = 'cyan' | 'blue' | 'violet' | 'pink' | 'green' | 'amber' | 'mono'
/** Background of the dark theme: tinted in the accent's hue, or neutral. */
export type Surface = 'cyber' | 'black' | 'graphite'

export interface Appearance {
  mode: Mode
  accent: Accent
  surface: Surface
}

export const DEFAULT_APPEARANCE: Appearance = { mode: 'system', accent: 'cyan', surface: 'cyber' }

export const MODES: Mode[] = ['dark', 'light', 'system']
export const SURFACES: Surface[] = ['cyber', 'black', 'graphite']

/** RGB channels, space-separated — the format of every token in index.css. */
type Rgb = string

/**
 * Accent presets: the primary accent (the `cyan` token — lines, focus, active
 * states) and two companions for the ambient background light. Light values
 * are deepened so text and thin lines keep contrast on white. `hue` tints the
 * cyber background (null: neutral grey).
 */
export const ACCENTS: Record<Accent, Record<Theme, [Rgb, Rgb, Rgb]> & { hue: number | null }> = {
  cyan: { hue: 215, dark: ['56 214 232', '74 132 255', '158 122 255'], light: ['0 132 158', '37 99 235', '109 64 230'] },
  blue: { hue: 224, dark: ['96 156 255', '120 104 255', '56 214 232'], light: ['37 99 235', '79 70 229', '0 132 158'] },
  violet: { hue: 262, dark: ['172 132 255', '236 112 200', '74 132 255'], light: ['109 64 230', '190 40 140', '37 99 235'] },
  pink: { hue: 318, dark: ['255 102 196', '172 132 255', '255 146 82'], light: ['200 30 140', '109 64 230', '200 80 20'] },
  green: { hue: 152, dark: ['84 230 140', '56 214 232', '190 228 92'], light: ['16 140 70', '0 132 158', '101 140 13'] },
  amber: { hue: 32, dark: ['255 184 76', '255 120 72', '236 112 200'], light: ['176 104 0', '200 70 20', '190 40 140'] },
  mono: { hue: null, dark: ['222 230 240', '140 152 170', '110 120 136'], light: ['30 41 59', '71 85 105', '100 116 139'] }
}

/**
 * Saturation and lightness of every dark surface, line and text token — the
 * original blue palette of index.css, so the cyber background is that palette
 * turned to the accent's hue (cyan's 215° gives index.css back).
 */
const CYBER: Record<string, [number, number]> = {
  '--bg-void': [0.47, 0.029],
  '--bg-surface': [0.38, 0.051],
  '--bg-panel': [0.37, 0.075],
  '--bg-elevated': [0.36, 0.104],
  '--border-hud': [0.33, 0.247],
  '--border-hud-strong': [0.33, 0.388],
  '--text-primary': [0.57, 0.927],
  '--text-secondary': [0.23, 0.665],
  '--text-muted': [0.16, 0.55]
}

/** Neutral dark backgrounds — they keep their greys whatever the accent. */
const NEUTRAL: Record<Exclude<Surface, 'cyber'>, Record<string, Rgb>> = {
  black: {
    '--bg-void': '0 0 0',
    '--bg-surface': '6 7 9',
    '--bg-panel': '11 12 15',
    '--bg-elevated': '18 20 24',
    '--border-hud': '40 44 52',
    '--border-hud-strong': '64 70 82',
    '--text-primary': '232 234 238',
    '--text-secondary': '158 164 174',
    '--text-muted': '128 134 144'
  },
  graphite: {
    '--bg-void': '20 21 24',
    '--bg-surface': '26 27 31',
    '--bg-panel': '32 34 38',
    '--bg-elevated': '40 42 47',
    '--border-hud': '60 63 70',
    '--border-hud-strong': '88 92 101',
    '--text-primary': '234 235 238',
    '--text-secondary': '164 168 176',
    '--text-muted': '138 142 150'
  }
}

/** HSL (degrees, 0–1, 0–1) → RGB channels. */
function hsl(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return `${f(0)} ${f(8)} ${f(4)}`
}

/** The surface, line and text tokens of a dark background (cyber: in the accent's hue). */
export function surfaceTokens(surface: Surface, accent: Accent): Record<string, Rgb> {
  if (surface !== 'cyber') return NEUTRAL[surface]
  const hue = ACCENTS[accent].hue
  return Object.fromEntries(Object.entries(CYBER).map(([name, [s, l]]) => [name, hsl(hue ?? 0, hue === null ? 0 : s, l)]))
}

/** Attributes of <html> that change when the appearance does — watch these to re-read tokens. */
export const APPEARANCE_ATTRIBUTES = ['data-theme', 'data-accent', 'data-surface', 'style']

const KEY = 'mindeck.appearance'
/** Before the appearance settings, only dark/light was stored. */
const LEGACY_KEY = 'mindeck.theme'
const LIGHT_QUERY = '(prefers-color-scheme: light)'
const SURFACE_TOKENS = Object.keys(CYBER)

const pick = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback

/** An appearance from storage or elsewhere (Settings Sync); unknown or missing fields fall back to the defaults. */
export function toAppearance(value: unknown): Appearance {
  const d = DEFAULT_APPEARANCE
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof Appearance, unknown>>
  return {
    mode: pick(v.mode, MODES, d.mode),
    accent: pick(v.accent, Object.keys(ACCENTS) as Accent[], d.accent),
    surface: pick(v.surface, SURFACES, d.surface)
  }
}

/** The saved appearance; unknown or missing fields fall back to the defaults. Never throws. */
export function loadAppearance(): Appearance {
  const d = DEFAULT_APPEARANCE
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return toAppearance(JSON.parse(raw))
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy === 'dark' || legacy === 'light') return { ...d, mode: legacy }
  } catch {
    /* unreadable or blocked storage — defaults */
  }
  return d
}

function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a))
  } catch {
    /* the choice just won't survive a restart */
  }
}

export function resolveTheme(mode: Mode): Theme {
  if (mode !== 'system') return mode
  return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark'
}

/**
 * Puts an appearance on <html>: `data-theme` swaps the token set (index.css),
 * accent and dark background override single tokens inline. Components never
 * branch on any of it.
 */
export function applyAppearance(a: Appearance): Theme {
  const root = document.documentElement
  const theme = resolveTheme(a.mode)
  const [accent, second, third] = ACCENTS[a.accent][theme]
  root.style.setProperty('--accent-cyan', accent)
  root.style.setProperty('--accent-2', second)
  root.style.setProperty('--accent-3', third)
  const surface = theme === 'dark' ? surfaceTokens(a.surface, a.accent) : undefined
  for (const name of SURFACE_TOKENS) {
    if (surface) root.style.setProperty(name, surface[name])
    else root.style.removeProperty(name)
  }
  root.dataset.theme = theme
  root.dataset.accent = a.accent
  root.dataset.surface = a.surface
  return theme
}

interface AppearanceState {
  appearance: Appearance
  /** The token set actually in use (`system` resolved). */
  theme: Theme
  update: (patch: Partial<Appearance>) => void
  reset: () => void
}

/** The appearance — remembered per device, like the language. */
export const useAppearance = create<AppearanceState>((set, get) => {
  const commit = (appearance: Appearance) => {
    saveAppearance(appearance)
    set({ appearance, theme: applyAppearance(appearance) })
  }
  const appearance = loadAppearance()
  return {
    appearance,
    theme: resolveTheme(appearance.mode),
    update: (patch) => commit({ ...get().appearance, ...patch }),
    reset: () => commit(DEFAULT_APPEARANCE)
  }
})

/** Before the first paint: apply the saved appearance and follow OS changes while on `system`. */
export function startAppearance(): void {
  const s = useAppearance.getState()
  useAppearance.setState({ theme: applyAppearance(s.appearance) })
  window.matchMedia(LIGHT_QUERY).addEventListener('change', () => {
    const { appearance } = useAppearance.getState()
    if (appearance.mode === 'system') useAppearance.setState({ theme: applyAppearance(appearance) })
  })
}
