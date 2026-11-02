import { createContext, useContext } from 'react'

/** The pane a module is drawn in. */
export interface PaneInfo {
  /** The pane has the focus: the keyboard (and the side navigation) act on it. */
  focused: boolean
}

/** Outside a workspace (a module on its own, tests) a module counts as focused. */
export const PaneContext = createContext<PaneInfo>({ focused: true })

/**
 * Whether this module's pane has the focus. Modules that listen for keys on
 * `window` (⌘S, ⌘P, …) take them only then — with two modules on screen, the
 * one you work in answers, not both.
 */
export function usePaneFocused(): boolean {
  return useContext(PaneContext).focused
}
