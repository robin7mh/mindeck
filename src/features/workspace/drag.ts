import type { DragEvent } from 'react'
import { create } from 'zustand'
import type { ModuleId } from '@/types'

/** What a module dragged from the side navigation carries (other apps see it as text). */
export const MODULE_TYPE = 'application/x-mindeck-module'

/** The module being dragged from the side navigation: the workspace shows where it can go. */
export const useModuleDrag = create<{ module?: ModuleId }>(() => ({}))

export function startModuleDrag(e: DragEvent, module: ModuleId): void {
  e.dataTransfer.setData(MODULE_TYPE, module)
  e.dataTransfer.effectAllowed = 'copyMove'
  useModuleDrag.setState({ module })
}

/** Dropped, or let go anywhere else (Escape too). */
export function endModuleDrag(): void {
  useModuleDrag.setState({ module: undefined })
}
