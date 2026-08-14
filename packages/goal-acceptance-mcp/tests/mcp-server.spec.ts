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
    expect(tools.tools).toHaveLength(6)
    const names = tools.tools.map(t => t.name)
    expect(names).toContain('set_acceptance_criteria')
    expect(names).toContain('get_acceptance_criteria')
    expect(names).toContain('validate_criterion')
    expect(names).toContain('update_task_status')
    expect(names).toContain('amend_acceptance_criteria')
    expect(names).toContain('can_complete_goal')
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
})
