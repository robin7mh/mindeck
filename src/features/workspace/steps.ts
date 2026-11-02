/**
 * Pane widths (CSS px) for Tailwind's `pane-*` variants (tailwind.config.ts):
 * like `sm:`…`2xl:`, but for the pane a module is in instead of the window —
 * a module next to another gets the layout of a narrow window. A pane lists
 * the steps it reaches in `data-pane`. Each is its window breakpoint minus
 * the side navigation, so a module alone in the workspace looks as before.
 */
export const PANE_STEPS = { sm: 560, md: 690, lg: 940, xl: 1050, '2xl': 1300 } as const

/** The `data-pane` value of a pane `width` pixels wide. */
export function paneSteps(width: number): string {
  return Object.entries(PANE_STEPS)
    .filter(([, min]) => width >= min)
    .map(([step]) => step)
    .join(' ')
}
