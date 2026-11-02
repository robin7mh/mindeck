import type { ComponentType } from 'react'
import { IPC_CHANNELS } from '@shared/ipc/contract'
import { ImportStep } from '@/features/browser/components/ImportDialog'

/** What a step's content gets from the setup around it. */
export interface StepProps {
  /** On to the next step (a step may move on by itself once its job is done). */
  next: () => void
}

/**
 * The channel through which the core offers importing browser data
 * (bookmarks, history, …). Built by the browser package — the setup only
 * keeps a place for its step.
 */
export const BROWSER_IMPORT_CHANNEL = 'browser:importSources'

const slots: { browserImport?: ComponentType<StepProps> } = { browserImport: ImportStep }

/**
 * The "Import browser data" step (the browser's import panel by default;
 * tests swap it). Its title is `onboarding.steps.browserImport`.
 */
export function fillBrowserImportSlot(step: ComponentType<StepProps> | undefined): void {
  slots.browserImport = step
}

/** The browser-import step — only when its slot is filled and the core has the channel. */
export function browserImportStep(channels: readonly string[] = IPC_CHANNELS): ComponentType<StepProps> | undefined {
  return channels.includes(BROWSER_IMPORT_CHANNEL) ? slots.browserImport : undefined
}
