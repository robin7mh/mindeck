import type { ModuleId } from '@/types'
import { focusInto } from '@/features/workspace/actions'
import { useWorkspace } from '@/features/workspace/store'

/** How many frames a section has to appear in after its module was brought up. */
const FRAMES = 30
/** How long a section that was jumped to stays lit. */
export const FLASH_MS = 1600

/** Bring a module up and put the keyboard focus into its pane (once it is drawn). */
export function showModule(id: ModuleId): void {
  useWorkspace.getState().show(id)
  const pane = useWorkspace.getState().layout.focus
  requestAnimationFrame(() => focusInto(pane))
}

/**
 * Settings, scrolled to one of its sections (`Card` marks each with its
 * title): the section lights up for a moment. Settings draws its sections
 * once it is mounted — the look waits a few frames for that.
 */
export function revealSettings(title: string): void {
  showModule('settings')
  let frames = 0
  const look = () => {
    const section = document.querySelector<HTMLElement>(`[data-card="${title.replace(/["\\]/g, '\\$&')}"]`)
    if (!section) {
      frames += 1
      if (frames < FRAMES) requestAnimationFrame(look)
      return
    }
    section.scrollIntoView({ block: 'start', behavior: 'smooth' })
    section.setAttribute('data-flash', '')
    setTimeout(() => section.removeAttribute('data-flash'), FLASH_MS)
  }
  requestAnimationFrame(look)
}
