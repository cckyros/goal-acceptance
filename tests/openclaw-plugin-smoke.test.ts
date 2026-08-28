// Smoke test: load the built OpenClaw plugin and drive the 13 tools with a
// mock OpenClaw runtime, then assert the plugin mirrors the active acceptance
// goal into the canonical SessionEntry.goal slot so built-in get_goal/update_goal
// can read it.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const sessionKey = 'agent:main:smoke'
const agentId = 'main'

function createApi() {
  const sessionStore = new Map<string, Map<string, { goal?: unknown }>>()
  function getStore(sessionKey: string, agentId: string) {
    if (!sessionStore.has(agentId)) sessionStore.set(agentId, new Map())
    const byAgent = sessionStore.get(agentId)!
    if (!byAgent.has(sessionKey)) byAgent.set(sessionKey, {})
    return byAgent.get(sessionKey)!
  }

  const registeredTools = new Map<string, any>()
  const api = {
    runtime: {
      agent: {
        session: {
          getSessionEntry: ({ sessionKey, agentId }: { sessionKey: string; agentId: string }) => {
            return getStore(sessionKey, agentId)
          },
          patchSessionEntry: async ({ sessionKey, agentId, update }: any) => {
            const entry = getStore(sessionKey, agentId)
            const patch = update(entry)
            if (patch && patch.goal === undefined) {
              delete (entry as any).goal
            } else if (patch) {
              Object.assign(entry, patch)
            }
            return entry
          },
        },
      },
    },
    logger: { warn: () => {} },
    registerTool: (factoryOrTool: any, opts?: any) => {
      const toolContext = { sessionKey, agentId, agentDir: '/tmp/agent', workspaceDir: '/tmp/ws' }
      if (typeof factoryOrTool === 'function') {
        const tool = factoryOrTool(toolContext)
        if (Array.isArray(tool)) {
          for (const t of tool) registeredTools.set(t.name, t)
        } else if (tool) {
          registeredTools.set(tool.name, tool)
        }
      } else {
        registeredTools.set(factoryOrTool.name || opts?.name, factoryOrTool)
      }
    },
  }
  return { api, registeredTools, getStore }
}

test('OpenClaw plugin mirrors active goal into SessionEntry.goal', async () => {
  const { api, registeredTools, getStore } = createApi()
  // @ts-expect-error built bundle has no declaration file
  const mod = await import('../dist/openclaw-plugin.js')
  mod.default.register(api)

  const startGoal = registeredTools.get('start_goal')
  const setCriteria = registeredTools.get('set_acceptance_criteria')
  const validate = registeredTools.get('validate_criterion')

  assert.ok(startGoal, 'start_goal tool registered')
  assert.ok(setCriteria, 'set_acceptance_criteria tool registered')
  assert.ok(validate, 'validate_criterion tool registered')

  await startGoal.execute('call-1', { title: 'ship sync fix' })
  await setCriteria.execute('call-2', {
    criteria: [{ id: 'c1', description: 'mirror to session entry' }],
    role: 'dual',
  })

  const entry = getStore(sessionKey, agentId)
  assert.ok(entry.goal, 'SessionEntry.goal is written after set_acceptance_criteria')
  assert.equal((entry.goal as any).status, 'active')
  assert.equal((entry.goal as any).objective, 'ship sync fix')

  await validate.execute('call-3', {
    criterion_id: 'c1',
    status: 'passed',
    evidence: 'smoke passed',
    evidence_type: 'text',
  })

  assert.equal((entry.goal as any).status, 'complete', 'goal becomes complete when all required criteria pass')
})
