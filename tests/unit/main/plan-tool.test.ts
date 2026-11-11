import { describe, expect, it } from 'vitest'
import { planPhase, type PlanItem } from '@shared/types/agents'
import { approvedHint, markPlan, PLAN_TOOL, PLAN_TOOL_KEY, stepList, stopHint, writtenStep } from '../../../electron/main/services/agents/planTool'
import { toolRisk, toolTitle } from '../../../electron/main/services/agents/transcript'

const plan = (done: boolean[] = [false, false, false]): PlanItem[] => ['Tests', 'CI', 'Docs'].map((text, i) => ({ id: `mode-${i}`, text, done: done[i] }))

describe('the plan Claude Code marks (plan_update)', () => {
  it('is offered as an MCP tool that runs unasked and shows as "Update plan"', () => {
    expect(PLAN_TOOL.name).toBe('plan_update')
    expect(PLAN_TOOL_KEY).toBe('mcp__mindeck__plan_update')
    expect(Object.keys(PLAN_TOOL.inputSchema.properties)).toEqual(['done', 'doing'])
    expect([toolRisk(PLAN_TOOL_KEY), toolTitle(PLAN_TOOL_KEY)]).toEqual(['read', 'Update plan'])
  })

  it('marks steps done, one as being worked on; tells where the plan stands', () => {
    const first = markPlan(plan(), { doing: 1 })
    expect('plan' in first && first.plan.map((p) => [p.done, p.active])).toEqual([
      [false, true],
      [false, false],
      [false, false]
    ])
    // done, the next in hand — several at once
    const next = markPlan(plan(), { done: [1, 2], doing: 3 })
    expect(next).toEqual({
      plan: [
        { id: 'mode-0', text: 'Tests', done: true, active: false },
        { id: 'mode-1', text: 'CI', done: true, active: false },
        { id: 'mode-2', text: 'Docs', done: false, active: true }
      ],
      text: 'Plan: 2 of 3 steps done.\nOpen:\n3. Docs'
    })
    // no `doing`: the step in hand stays so — unless it is done now
    const kept = markPlan([{ ...plan()[0], active: true }, ...plan().slice(1)], { done: [] })
    expect('plan' in kept && kept.plan[0].active).toBe(true)
    const finished = markPlan([{ ...plan()[0], active: true }, ...plan().slice(1)], { done: [1] })
    expect('plan' in finished && finished.plan[0]).toMatchObject({ done: true, active: false })
    // done stays done; all of them
    expect(markPlan(plan([true, true, false]), { done: [3] })).toMatchObject({ text: 'Plan: 3 of 3 steps done. All steps are done.' })
  })

  it('refuses what is no step, and works only on a plan there is', () => {
    expect(markPlan([], { done: [1] })).toEqual({ error: 'Mindeck shows no plan for this session.' })
    for (const args of [{ done: [0] }, { done: [4] }, { done: [1.5] }, { done: '1' }, { doing: 9 }, { doing: '2' }]) {
      expect(markPlan(plan(), args), JSON.stringify(args)).toEqual({ error: 'Steps are numbered 1 to 3.' })
    }
  })

  it('hands the steps over on approval and lists the open ones when asked to catch up', () => {
    expect(stepList(plan())).toBe('1. Tests\n2. CI\n3. Docs')
    expect(approvedHint(plan())).toContain('1. Tests\n2. CI\n3. Docs')
    expect(approvedHint(plan())).toContain(PLAN_TOOL_KEY)
    const hint = stopHint(plan([true, false, false]))
    expect(hint).toContain('2. CI\n3. Docs')
    expect(hint).not.toContain('1. Tests')
    // a plan written down — not the agent's own tasks
    expect([writtenStep({ id: 'mode-1', text: '', done: false }), writtenStep({ id: 'answer-0', text: '', done: false }), writtenStep({ id: 't1', text: '', done: false })]).toEqual([true, true, false])
  })
})

describe('where a plan stands', () => {
  it('none, proposed, in progress, paused, done', () => {
    expect(planPhase({ plan: [], status: 'working' })).toBeUndefined()
    expect(planPhase({ plan: plan(), planStatus: 'draft', status: 'approval' })).toBe('draft')
    for (const status of ['working', 'approval', 'starting'] as const) expect(planPhase({ plan: plan(), planStatus: 'active', status })).toBe('working')
    for (const status of ['idle', 'waiting', 'ended', 'error'] as const) expect(planPhase({ plan: plan(), planStatus: 'active', status })).toBe('paused')
    // a plan from before plan states: being carried out
    expect(planPhase({ plan: plan([true, true, true]), status: 'idle' })).toBe('done')
  })
})
