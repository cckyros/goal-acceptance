import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp-server.ts'

describe('GoalAcceptanceMcpServer', () => {
  async function createClient() {
    const server = createMcpServer()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await serverTransport.start()
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    await client.connect(clientTransport)
    return { client, server }
  }

  it('lists tools', async () => {
    const { client } = await createClient()
    const tools = await client.listTools()
    expect(tools.tools).toHaveLength(12)
    const names = tools.tools.map(t => t.name)
    expect(names).toContain('set_acceptance_criteria')
    expect(names).toContain('get_acceptance_criteria')
    expect(names).toContain('validate_criterion')
    expect(names).toContain('update_task_status')
    expect(names).toContain('amend_acceptance_criteria')
    expect(names).toContain('can_complete_goal')
    expect(names).toContain('set_task_plan')
    expect(names).toContain('get_task_plan')
    expect(names).toContain('start_goal')
    expect(names).toContain('list_goals')
    expect(names).toContain('switch_goal')
    expect(names).toContain('reset_goal')
  })

  it('sets criteria with task links and dependencies', async () => {
    const { client } = await createClient()
    const result = await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: {
        criteria: [
          { id: 'c1', description: 'API returns 200', required: true, method: 'test', task_ids: ['t1', 't2'] },
          { id: 'c2', description: 'Docs updated', depends_on: ['c1'] },
        ],
      },
    })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.criteria).toHaveLength(2)
    expect(parsed.summary.totalCount).toBe(2)
    expect(parsed.summary.taskProgress.totalTasks).toBe(2)
  })

  it('tracks task progress via update_task_status', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: {
        criteria: [
          { id: 'c1', description: 'Implement API', task_ids: ['t1', 't2'] },
        ],
      },
    })

    await client.callTool({
      name: 'update_task_status',
      arguments: { task_id: 't1', status: 'completed' },
    })

    const result = await client.callTool({
      name: 'get_acceptance_criteria',
      arguments: {},
    })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.summary.taskProgress.completedTasks).toBe(1)
    expect(parsed.summary.taskProgress.inProgressTasks).toBe(0)
    expect(parsed.summary.readyToValidate).toHaveLength(0)
  })

  it('marks criterion ready to validate when all tasks complete', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: {
        criteria: [
          { id: 'c1', description: 'Implement API', task_ids: ['t1', 't2'] },
        ],
      },
    })

    await client.callTool({ name: 'update_task_status', arguments: { task_id: 't1', status: 'completed' } })
    await client.callTool({ name: 'update_task_status', arguments: { task_id: 't2', status: 'completed' } })

    const result = await client.callTool({ name: 'get_acceptance_criteria', arguments: {} })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.summary.readyToValidate).toHaveLength(1)
    expect(parsed.summary.readyToValidate[0].id).toBe('c1')
  })

  it('amends criteria after lock', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'Original' }] },
    })

    const result = await client.callTool({
      name: 'amend_acceptance_criteria',
      arguments: {
        criteria: [{ id: 'c2', description: 'Added later', required: true }],
        reason: 'User expanded scope',
      },
    })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.addedCriteria).toHaveLength(1)
    expect(parsed.addedCriteria[0].addedAfterLock).toBe(true)
    expect(parsed.summary.totalCount).toBe(2)
  })

  it('rejects completion when required criteria are pending', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: {
        criteria: [
          { id: 'c1', description: 'API returns 200', required: true },
        ],
      },
    })
    const result = await client.callTool({ name: 'can_complete_goal', arguments: {} })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.allowed).toBe(false)
  })

  it('accepts role=agent and marks passed as self-claimed', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: {
        criteria: [{ id: 'c1', description: 'test', required: true }],
        role: 'agent',
      },
    })
    const result = await client.callTool({
      name: 'validate_criterion',
      arguments: { criterion_id: 'c1', status: 'passed', evidence: 'agent says ok' },
    })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.criterion.selfClaimed).toBe(true)
    expect(parsed.criterion.evidenceType).toBe('text')
    expect(parsed.criterion.lowConfidence).toBe(true)
  })

  it('can_complete_goal blocks on self-claimed required', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'req', required: true }], role: 'agent' },
    })
    await client.callTool({
      name: 'validate_criterion',
      arguments: { criterion_id: 'c1', status: 'passed', evidence: 'ok' },
    })
    const result = await client.callTool({ name: 'can_complete_goal', arguments: {} })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.allowed).toBe(false)
    expect(parsed.reason).toContain('self-claimed')
  })

  it('accepts evidence_type=command', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'test' }] },
    })
    const result = await client.callTool({
      name: 'validate_criterion',
      arguments: {
        criterion_id: 'c1',
        status: 'passed',
        evidence: 'dotnet test: 368 passed',
        evidence_type: 'command',
      },
    })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.criterion.evidenceType).toBe('command')
    expect(parsed.criterion.lowConfidence).toBe(false)
  })

  it('default validate response is slim (no full summary)', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'test' }, { id: 'c2', description: 'two' }] },
    })
    const result = await client.callTool({
      name: 'validate_criterion',
      arguments: { criterion_id: 'c1', status: 'passed', evidence: 'ok' },
    })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.criterion).toBeDefined()
    expect(parsed.summary).toBeDefined()
    expect(parsed.summary.allRequiredPassed).toBeDefined()
    expect(parsed.summary.passedCount).toBe(1)
    expect(parsed.summary.selfClaimedCount).toBe(0)
    expect(parsed.summary.totalCount).toBe(2)
    // Slim summary should NOT have these heavy fields
    expect(parsed.summary.passed).toBeUndefined()
    expect(parsed.summary.failures).toBeUndefined()
    expect(parsed.summary.nextActionable).toBeUndefined()
  })

  it('verbose=true validate returns full summary', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'test' }] },
    })
    const result = await client.callTool({
      name: 'validate_criterion',
      arguments: { criterion_id: 'c1', status: 'passed', evidence: 'ok', verbose: true },
    })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.summary.passed).toBeDefined()
    expect(parsed.summary.failures).toBeDefined()
  })

  it('default update_task_status response is slim', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'test', task_ids: ['t1'] }] },
    })
    const result = await client.callTool({
      name: 'update_task_status',
      arguments: { task_id: 't1', status: 'completed' },
    })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.taskId).toBe('t1')
    expect(parsed.status).toBe('completed')
    expect(parsed.summary.allRequiredPassed).toBeDefined()
    expect(parsed.summary.totalCount).toBe(1)
    // Slim: no heavy fields
    expect(parsed.summary.criterionTaskProgress).toBeUndefined()
  })

  it('get_acceptance_criteria verbose=false returns slim only', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'test' }] },
    })
    const result = await client.callTool({
      name: 'get_acceptance_criteria',
      arguments: { verbose: false },
    })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.criteria).toBeUndefined()
    expect(parsed.summary.allRequiredPassed).toBeDefined()
    expect(parsed.summary.totalCount).toBe(1)
  })

  it('get_acceptance_criteria default returns full (backward compat)', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'test' }] },
    })
    const result = await client.callTool({
      name: 'get_acceptance_criteria',
      arguments: {},
    })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.criteria).toBeDefined()
    expect(parsed.summary).toBeDefined()
    expect(parsed.summary.passed).toBeDefined()
  })

  it('sets and reads a task plan via set_task_plan/get_task_plan', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'Implement API' }] },
    })

    const setResult = await client.callTool({
      name: 'set_task_plan',
      arguments: {
        tasks: [
          { id: 't1', description: 'Define route handler', deliverable: 'handler.ts' },
          { id: 't2', description: 'Write integration tests', deliverable: 'api.spec.ts', depends_on: ['t1'] },
        ],
      },
    })
    const setText = String((setResult.content as Array<{ type: string; text: string }>)[0]!.text)
    const setParsed = JSON.parse(setText)
    expect(setParsed.taskPlan).toHaveLength(2)
    expect(setParsed.taskPlan[1].dependsOn).toEqual(['t1'])

    const getResult = await client.callTool({ name: 'get_task_plan', arguments: {} })
    const getText = String((getResult.content as Array<{ type: string; text: string }>)[0]!.text)
    const getParsed = JSON.parse(getText)
    expect(getParsed.taskPlan).toHaveLength(2)
    expect(getParsed.taskPlan[0].id).toBe('t1')
    expect(getParsed.taskPlan[0].status).toBe('pending')
  })

  it('rejects task plan with duplicate ids', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'test' }] },
    })
    await expect(client.callTool({
      name: 'set_task_plan',
      arguments: {
        tasks: [
          { id: 't1', description: 'One', deliverable: 'a.txt' },
          { id: 't1', description: 'Two', deliverable: 'b.txt' },
        ],
      },
    })).rejects.toThrow('duplicate task id')
  })

  it('rejects task plan with missing deliverable', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'test' }] },
    })
    await expect(client.callTool({
      name: 'set_task_plan',
      arguments: {
        tasks: [
          { id: 't1', description: 'No deliverable', deliverable: '' },
        ],
      },
    })).rejects.toThrow('must declare a deliverable')
  })

  it('rejects task plan with dependency cycle', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'test' }] },
    })
    await expect(client.callTool({
      name: 'set_task_plan',
      arguments: {
        tasks: [
          { id: 't1', description: 'One', deliverable: 'a.txt', depends_on: ['t2'] },
          { id: 't2', description: 'Two', deliverable: 'b.txt', depends_on: ['t1'] },
        ],
      },
    })).rejects.toThrow('dependency cycle')
  })

  it('rejects task plan with unknown dependency', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'test' }] },
    })
    await expect(client.callTool({
      name: 'set_task_plan',
      arguments: {
        tasks: [
          { id: 't1', description: 'One', deliverable: 'a.txt', depends_on: ['ghost'] },
        ],
      },
    })).rejects.toThrow('unknown task')
  })

  it('rejects task plan before criteria are locked', async () => {
    const { client } = await createClient()
    // No active goal yet — set_task_plan should fail
    await expect(client.callTool({
      name: 'set_task_plan',
      arguments: {
        tasks: [{ id: 't1', description: 'One', deliverable: 'a.txt' }],
      },
    })).rejects.toThrow()
  })

  it('rejects setting task plan twice', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'test' }] },
    })
    await client.callTool({
      name: 'set_task_plan',
      arguments: { tasks: [{ id: 't1', description: 'One', deliverable: 'a.txt' }] },
    })
    await expect(client.callTool({
      name: 'set_task_plan',
      arguments: { tasks: [{ id: 't2', description: 'Two', deliverable: 'b.txt' }] },
    })).rejects.toThrow('already set')
  })

  it('task plan statuses flow through update_task_status and get_task_plan', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'Implement API', task_ids: ['t1', 't2'] }] },
    })
    await client.callTool({
      name: 'set_task_plan',
      arguments: {
        tasks: [
          { id: 't1', description: 'Define route handler', deliverable: 'handler.ts' },
          { id: 't2', description: 'Write tests', deliverable: 'api.spec.ts', depends_on: ['t1'] },
        ],
      },
    })
    await client.callTool({ name: 'update_task_status', arguments: { task_id: 't1', status: 'completed' } })

    const getResult = await client.callTool({ name: 'get_task_plan', arguments: {} })
    const getText = String((getResult.content as Array<{ type: string; text: string }>)[0]!.text)
    const getParsed = JSON.parse(getText)
    expect(getParsed.taskPlan[0].status).toBe('completed')
    expect(getParsed.taskPlan[1].status).toBe('pending')

    const summaryResult = await client.callTool({ name: 'get_acceptance_criteria', arguments: {} })
    const summaryText = String((summaryResult.content as Array<{ type: string; text: string }>)[0]!.text)
    const summaryParsed = JSON.parse(summaryText)
    expect(summaryParsed.summary.taskPlan).toHaveLength(2)
    expect(summaryParsed.summary.taskProgress.completedTasks).toBe(1)
  })

  // ─── Multi-goal tests ───

  it('auto-creates a goal on first set_acceptance_criteria', async () => {
    const { client } = await createClient()
    const result = await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'test' }] },
    })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.goalId).toBeDefined()
    expect(typeof parsed.goalId).toBe('string')
    expect(parsed.goalId.length).toBeGreaterThan(0)
  })

  it('start_goal creates a new goal and set_acceptance_criteria works on it', async () => {
    const { client } = await createClient()
    // First goal
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'goal A' }] },
    })
    // Start a new goal
    const startResult = await client.callTool({
      name: 'start_goal',
      arguments: { title: 'Goal B' },
    })
    const startText = String((startResult.content as Array<{ type: string; text: string }>)[0]!.text)
    const startParsed = JSON.parse(startText)
    expect(startParsed.goal.id).toBeDefined()
    expect(startParsed.goal.title).toBe('Goal B')

    // set_acceptance_criteria should work on the new goal
    const setResult = await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'goal B criterion' }] },
    })
    const setText = String((setResult.content as Array<{ type: string; text: string }>)[0]!.text)
    const setParsed = JSON.parse(setText)
    expect(setParsed.goalId).toBe(startParsed.goal.id)
    expect(setParsed.criteria).toHaveLength(1)
  })

  it('set_acceptance_criteria on locked goal gives clear error pointing to start_goal', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'first' }] },
    })
    await expect(client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c2', description: 'second' }] },
    })).rejects.toThrow('start_goal')
  })

  it('two goals have independent criteria locks', async () => {
    const { client } = await createClient()
    // Goal A
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'goal A' }] },
    })
    // Goal B
    await client.callTool({ name: 'start_goal', arguments: { title: 'B' } })
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'goal B' }] },
    })
    // Switch back to goal A — its criteria should be intact
    const goalsResult = await client.callTool({ name: 'list_goals', arguments: {} })
    const goalsText = String((goalsResult.content as Array<{ type: string; text: string }>)[0]!.text)
    const goalsParsed = JSON.parse(goalsText)
    expect(goalsParsed.goals).toHaveLength(2)
    // Both goals should have 1 criterion each
    expect(goalsParsed.goals[0].criteriaCount).toBe(1)
    expect(goalsParsed.goals[1].criteriaCount).toBe(1)
  })

  it('list_goals shows all goals with active flag', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'A' }] },
    })
    await client.callTool({ name: 'start_goal', arguments: { title: 'B' } })

    const result = await client.callTool({ name: 'list_goals', arguments: {} })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.goals).toHaveLength(2)
    const activeGoals = parsed.goals.filter((g: { isActive: boolean }) => g.isActive)
    expect(activeGoals).toHaveLength(1)
  })

  it('switch_goal changes active goal', async () => {
    const { client } = await createClient()
    // Goal A
    const resA = await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'A' }] },
    })
    const goalAId = JSON.parse(String((resA.content as Array<{ type: string; text: string }>)[0]!.text)).goalId

    // Goal B
    await client.callTool({ name: 'start_goal', arguments: { title: 'B' } })

    // Switch back to A
    const switchResult = await client.callTool({
      name: 'switch_goal',
      arguments: { goal_id: goalAId },
    })
    const switchText = String((switchResult.content as Array<{ type: string; text: string }>)[0]!.text)
    const switchParsed = JSON.parse(switchText)
    expect(switchParsed.goal.id).toBe(goalAId)

    // Verify we can read A's criteria
    const getResult = await client.callTool({ name: 'get_acceptance_criteria', arguments: {} })
    const getText = String((getResult.content as Array<{ type: string; text: string }>)[0]!.text)
    const getParsed = JSON.parse(getText)
    expect(getParsed.goalId).toBe(goalAId)
    expect(getParsed.criteria).toHaveLength(1)
    expect(getParsed.criteria[0].description).toBe('A')
  })

  it('reset_goal clears current goal and allows fresh start', async () => {
    const { client } = await createClient()
    await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'to be deleted' }] },
    })
    // Reset
    const resetResult = await client.callTool({ name: 'reset_goal', arguments: {} })
    const resetText = String((resetResult.content as Array<{ type: string; text: string }>)[0]!.text)
    const resetParsed = JSON.parse(resetText)
    expect(resetParsed.message).toContain('deleted')

    // Should be able to set_acceptance_criteria again (auto-creates new goal)
    const setResult = await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: { criteria: [{ id: 'c1', description: 'fresh start' }] },
    })
    const setText = String((setResult.content as Array<{ type: string; text: string }>)[0]!.text)
    const setParsed = JSON.parse(setText)
    expect(setParsed.criteria).toHaveLength(1)
    expect(setParsed.criteria[0].description).toBe('fresh start')
  })

  it('switch_goal rejects unknown goal id', async () => {
    const { client } = await createClient()
    await expect(client.callTool({
      name: 'switch_goal',
      arguments: { goal_id: 'nonexistent-id' },
    })).rejects.toThrow('not found')
  })

  it('reset_goal rejects when no active goal', async () => {
    const { client } = await createClient()
    await expect(client.callTool({
      name: 'reset_goal',
      arguments: {},
    })).rejects.toThrow('no active goal')
  })
})
