import type { Config } from 'tailwindcss'
import plugin from 'tailwindcss/plugin'
import { PANE_STEPS } from './src/features/workspace/steps'

/**
 * Colors map to CSS variables declared in src/index.css so the whole app has a
 * single source of truth. Never hardcode hex in components — use these tokens.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: 'rgb(var(--bg-void) / <alpha-value>)',
        surface: 'rgb(var(--bg-surface) / <alpha-value>)',
        panel: 'rgb(var(--bg-panel) / <alpha-value>)',
        elevated: 'rgb(var(--bg-elevated) / <alpha-value>)',
        hud: 'rgb(var(--border-hud) / <alpha-value>)',
        'hud-strong': 'rgb(var(--border-hud-strong) / <alpha-value>)',
        cyan: 'rgb(var(--accent-cyan) / <alpha-value>)',
        blue: 'rgb(var(--accent-blue) / <alpha-value>)',
        purple: 'rgb(var(--accent-purple) / <alpha-value>)',
        amber: 'rgb(var(--accent-amber) / <alpha-value>)',
        green: 'rgb(var(--accent-green) / <alpha-value>)',
        danger: 'rgb(var(--accent-danger) / <alpha-value>)',
        'text-primary': 'rgb(var(--text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--text-secondary) / <alpha-value>)',
        'text-muted': 'rgb(var(--text-muted) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['Inter Variable', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace']
      },
      boxShadow: {
        glow: '0 0 0 1px rgb(var(--accent-cyan) / 0.25), 0 0 18px -2px rgb(var(--accent-cyan) / calc(0.35 * var(--glow)))',
        'glow-sm': '0 0 12px -2px rgb(var(--accent-cyan) / calc(0.30 * var(--glow)))',
        panel: '0 1px 0 0 rgb(var(--border-hud) / 0.6), inset 0 1px 0 0 rgb(255 255 255 / 0.02)'
      },
      letterSpacing: {
        label: '0.18em'
      },
      keyframes: {
        // Transform + opacity only: the compositor runs it without repainting.
        // (An animated box-shadow repainted — and re-blurred the backdrop — every frame.)
        pulseDot: {
          '0%': { opacity: '0.55', transform: 'scale(1)' },
          '70%, 100%': { opacity: '0', transform: 'scale(2.25)' }
        },
        // The browser's loading line: slides across while a page loads (transform only).
        loadbar: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' }
        },
        flicker: {
          '0%, 100%': { opacity: '1' },
          '92%': { opacity: '1' },
          '94%': { opacity: '0.72' },
          '96%': { opacity: '1' }
        }
      },
      animation: {
        // Stepped: a smooth infinite loop makes Chromium composite the whole
        // window at 60 fps (~20 % of a core in GPU + renderer); 8 steps ≈ 4 fps.
        'pulse-dot': 'pulseDot 2.2s steps(8, end) infinite',
        flicker: 'flicker 6s linear infinite',
        loadbar: 'loadbar 1.1s ease-in-out infinite'
      }
    }
  },
  plugins: [
    // `pane-lg:flex`: like `lg:`, but for the width of the module's pane (see steps.ts).
    plugin(({ addVariant }) => {
      for (const step of Object.keys(PANE_STEPS)) addVariant(`pane-${step}`, `[data-pane~="${step}"] &`)
    })
  ]
} satisfies Config
