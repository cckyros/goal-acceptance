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
    expect(tools.tools).toHaveLength(4)
    const names = tools.tools.map(t => t.name)
    expect(names).toContain('set_acceptance_criteria')
    expect(names).toContain('get_acceptance_criteria')
    expect(names).toContain('validate_criterion')
    expect(names).toContain('can_complete_goal')
  })

  it('sets criteria and reports summary', async () => {
    const { client } = await createClient()
    const result = await client.callTool({
      name: 'set_acceptance_criteria',
      arguments: {
        criteria: [
          { id: 'c1', description: 'API returns 200', required: true, method: 'test' },
        ],
      },
    })
    const text = String((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const parsed = JSON.parse(text)
    expect(parsed.criteria).toHaveLength(1)
    expect(parsed.summary.totalCount).toBe(1)
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
