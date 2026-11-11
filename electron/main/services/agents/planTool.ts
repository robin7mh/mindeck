// The plan Mindeck shows beside a Claude Code session, kept up to date by the
// agent itself: once the user approves a plan, Claude Code gets its steps and
// marks them with `plan_update` (a tool of Mindeck's MCP server, offered to
// Claude Code sessions only — ACP agents report their plan themselves).

import type { PlanItem } from '@shared/types/agents'

/** The tool, as `tools/list` offers it. */
export const PLAN_TOOL = {
  name: 'plan_update',
  description:
    'Mark progress on the plan Mindeck shows the user beside this session (the steps of the plan they approved). ' +
    'Call it when you start a step (`doing`) and when you finish one or more (`done`). Steps are numbered from 1, as listed.',
  inputSchema: {
    type: 'object',
    properties: {
      done: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Steps that are finished' },
      doing: { type: 'integer', minimum: 1, description: 'The step you are working on now' }
    },
    additionalProperties: false
  }
}

/** Its name for Claude Code (what `--allowedTools` and the hooks see). */
export const PLAN_TOOL_KEY = `mcp__mindeck__${PLAN_TOOL.name}`

/** A plan Claude Code wrote down (its answer while planning, or the one it presented) — not its own task list. */
export const writtenStep = (p: PlanItem) => p.id.startsWith('answer-') || p.id.startsWith('mode-')

/** The steps as the agent sees them: "1. Tests". */
export const stepList = (plan: PlanItem[], only: (p: PlanItem) => boolean = () => true) =>
  plan
    .map((p, i) => ({ p, line: `${i + 1}. ${p.text}` }))
    .filter(({ p }) => only(p))
    .map(({ line }) => line)
    .join('\n')

/** Told right after the plan is approved: its steps, and how to mark them. */
export function approvedHint(plan: PlanItem[]): string {
  return (
    `Mindeck shows the user this plan's steps beside the session:\n${stepList(plan)}\n` +
    `While you carry it out, mark them with ${PLAN_TOOL_KEY}: \`doing\` when you start a step, \`done\` when it is finished ` +
    '(several at once are fine). Mark every step you finish before you end your turn.'
  )
}

/** Told when it would stop with steps still open (once for each state of the plan). */
export function stopHint(plan: PlanItem[]): string {
  return (
    `Mindeck still shows these plan steps as open:\n${stepList(plan, (p) => !p.done)}\n` +
    `Mark the ones you finished with ${PLAN_TOOL_KEY} (\`done\`). Leave a step open only if it really is — ` +
    'then end your turn with one short line; no new summary.'
  )
}

/** What the plan looks like now, for the agent. */
function summary(plan: PlanItem[]): string {
  const done = plan.filter((p) => p.done).length
  const open = stepList(plan, (p) => !p.done)
  return `Plan: ${done} of ${plan.length} steps done.` + (open ? `\nOpen:\n${open}` : ' All steps are done.')
}

const isStep = (n: unknown, length: number): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= length

/**
 * A `plan_update` call on the plan: the steps it names done (and no longer
 * being worked on), the one it names `doing` worked on — only one at a time.
 */
export function markPlan(plan: PlanItem[], args: Record<string, unknown>): { plan: PlanItem[]; text: string } | { error: string } {
  if (!plan.length) return { error: 'Mindeck shows no plan for this session.' }
  const done = args.done ?? []
  const doing = args.doing
  if (!Array.isArray(done) || !done.every((n) => isStep(n, plan.length)) || (doing !== undefined && !isStep(doing, plan.length))) {
    return { error: `Steps are numbered 1 to ${plan.length}.` }
  }
  const next = plan.map((p, i) => {
    const finished = p.done || done.includes(i + 1)
    const active = !finished && (doing === undefined ? !!p.active : doing === i + 1)
    return { ...p, done: finished, active }
  })
  return { plan: next, text: summary(next) }
}
