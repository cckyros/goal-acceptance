import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '@deepseek-ai/dsh-goal-acceptance-core'
import { FileAcceptanceStore } from './store.ts'

interface ToolInput {
  [key: string]: unknown
}

/** Resolve the active acceptance store. */
function resolveStore(): import('@deepseek-ai/dsh-goal-acceptance-core').GoalAcceptanceStore {
  const dataDir = process.env.PLUGIN_DATA
  if (dataDir !== undefined && dataDir.length > 0) {
    const path = `${dataDir}/acceptance-events.json`
    return new FileAcceptanceStore(path)
  }
  return new InMemoryAcceptanceStore()
}

/** Create a configured MCP server over the goal-acceptance engine. */
export function createMcpServer(): Server {
  const engine = new GoalAcceptanceEngine(resolveStore())

  const server = new Server(
    {
      name: 'dsh-goal-acceptance-mcp',
      version: '0.1.0-rc.5',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'set_acceptance_criteria',
        description: 'Set and lock the initial acceptance criteria for the current goal. Must be called before implementation.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['criteria'],
          properties: {
            criteria: {
              type: 'array',
              description: 'Array of criteria definitions.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'description'],
                properties: {
                  id: { type: 'string', description: 'Short unique identifier.' },
                  description: { type: 'string', description: 'Concrete requirement.' },
                  required: { type: 'boolean', description: 'Whether required for goal completion.' },
                  method: { type: 'string', description: 'Verification method: test, command, browser, manual.' },
                },
              },
            },
          },
        },
      },
      {
        name: 'get_acceptance_criteria',
        description: 'Read the current acceptance criteria and summary.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
      {
        name: 'validate_criterion',
        description: 'Record verification status and evidence for one criterion. Statuses passed and failed require evidence.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['criterion_id', 'status'],
          properties: {
            criterion_id: { type: 'string', description: 'Exact criterion id.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'passed', 'failed', 'blocked', 'not_run'],
              description: 'Outcome status.',
            },
            evidence: { type: 'string', description: 'Verification evidence. Required for passed/failed.' },
          },
        },
      },
      {
        name: 'can_complete_goal',
        description: 'Check whether the goal can be completed based on current acceptance criteria.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const input = args as ToolInput

    switch (name) {
      case 'set_acceptance_criteria': {
        const criteria = input.criteria as Array<{ id: string; description: string; required?: boolean; method?: string }>
        const list = await engine.setCriteria(criteria)
        const summary = engine.summarize()
        return {
          content: [{ type: 'text', text: JSON.stringify({ criteria: list, summary }, null, 2) }],
        }
      }
      case 'get_acceptance_criteria': {
        const criteria = engine.getCriteria()
        const summary = engine.summarize()
        return {
          content: [{ type: 'text', text: JSON.stringify({ criteria, summary }, null, 2) }],
        }
      }
      case 'validate_criterion': {
        const updated = await engine.validateCriterion({
          criterionId: input.criterion_id as string,
          status: input.status as import('@deepseek-ai/dsh-goal-acceptance-core').GoalCriterionStatus,
          evidence: input.evidence as string | undefined,
        })
        const summary = engine.summarize()
        return {
          content: [{ type: 'text', text: JSON.stringify({ criterion: updated, summary }, null, 2) }],
        }
      }
      case 'can_complete_goal': {
        const result = engine.canComplete()
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }
      }
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  })

  return server
}

/** Start the stdio MCP server. */
export async function main(): Promise<void> {
  const dataDir = process.env.PLUGIN_DATA
  if (dataDir !== undefined && dataDir.length > 0) {
    await mkdir(dirname(`${dataDir}/acceptance-events.json`), { recursive: true })
  }

  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
