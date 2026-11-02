// What Claude Code can be started with from Mindeck — shared, so the new-chat
// dialog offers exactly what the core passes on the command line.

import type { SessionOption } from './agents'

/** Claude Code's model aliases (they follow its newest models); `default` = the account's default. */
export const CLAUDE_MODELS: SessionOption[] = [
  { id: 'default', name: 'Default' },
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' }
]

/** Permission modes (`--permission-mode`): bypassing permissions is left out — approvals stay in Mindeck. */
export const CLAUDE_MODES: SessionOption[] = [
  { id: 'default', name: 'Ask before edits' },
  { id: 'acceptEdits', name: 'Accept edits' },
  { id: 'plan', name: 'Plan' }
]
