import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from "@deepseek-ai/dsh-goal-acceptance-core";
import { existsSync, readFileSync } from "node:fs";
//#region lib/types/store.js
/** File-backed event store using a JSON file. */
var FileAcceptanceStore = class {
	path;
	constructor(path) {
		this.path = path;
	}
	async #read() {
		if (!existsSync(this.path)) return [];
		const raw = await readFile(this.path, "utf-8");
		if (raw.trim().length === 0) return [];
		return JSON.parse(raw);
	}
	async #write(events) {
		await writeFile(this.path, JSON.stringify(events, null, 2) + "\n");
	}
	get events() {
		if (!existsSync(this.path)) return [];
		const raw = readFileSync(this.path, "utf-8");
		if (raw.trim().length === 0) return [];
		return JSON.parse(raw);
	}
	async append(event) {
		const events = await this.#read();
		events.push(event);
		await this.#write(events);
	}
};
//#endregion
//#region lib/types/mcp-server.js
/** Compact one-line summary for default (non-verbose) responses. */
function slimSummary(s) {
	return {
		allRequiredPassed: s.allRequiredPassed,
		passedCount: s.passedCount,
		selfClaimedCount: s.selfClaimedCount,
		totalCount: s.totalCount
	};
}
/** Resolve the active acceptance store. */
function resolveStore() {
	const dataDir = process.env.PLUGIN_DATA;
	if (dataDir !== void 0 && dataDir.length > 0) return new FileAcceptanceStore(`${dataDir}/acceptance-events.json`);
	return new InMemoryAcceptanceStore();
}
const CRITERION_ITEM_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["id", "description"],
	properties: {
		id: {
			type: "string",
			description: "Short unique identifier."
		},
		description: {
			type: "string",
			description: "Concrete requirement."
		},
		required: {
			type: "boolean",
			description: "Whether required for goal completion."
		},
		method: {
			type: "string",
			description: "Verification method: test, command, browser, manual."
		},
		task_ids: {
			type: "array",
			items: { type: "string" },
			description: "Task IDs linked to this criterion."
		},
		depends_on: {
			type: "array",
			items: { type: "string" },
			description: "IDs of criteria that must be passed before this one."
		}
	}
};
const TASK_PLAN_ITEM_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"id",
		"description",
		"deliverable"
	],
	properties: {
		id: {
			type: "string",
			description: "Unique task id (e.g. \"t1\", \"api-endpoint\")."
		},
		description: {
			type: "string",
			description: "Non-empty, unambiguous task description."
		},
		deliverable: {
			type: "string",
			description: "Concrete artifact that proves this task is done."
		},
		depends_on: {
			type: "array",
			items: { type: "string" },
			description: "Task ids this task depends on within the same plan."
		}
	}
};
/** Create a configured MCP server over the goal-acceptance engine. */
function createMcpServer() {
	const engine = new GoalAcceptanceEngine(resolveStore());
	const server = new Server({
		name: "dsh-goal-acceptance-mcp",
		version: "0.1.0-rc.5"
	}, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
		{
			name: "set_acceptance_criteria",
			description: "Set and lock the initial acceptance criteria for the current goal. Must be called before implementation. Each criterion may link to task IDs and declare dependencies. Optional role field controls self-claim behavior: agent marks passed as self-claimed (needs reviewer confirmation), reviewer/dual marks formal passed.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["criteria"],
				properties: {
					criteria: {
						type: "array",
						description: "Array of criteria definitions.",
						items: CRITERION_ITEM_SCHEMA
					},
					role: {
						type: "string",
						enum: [
							"agent",
							"reviewer",
							"dual"
						],
						description: "Role locking the criteria. agent: passed marks self-claimed. reviewer/dual: formal passed. Default: dual."
					}
				}
			}
		},
		{
			name: "get_acceptance_criteria",
			description: "Read the current acceptance criteria, task progress, and summary. Default returns full criteria list + summary. Pass verbose=false for a one-line summary only.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: { verbose: {
					type: "boolean",
					description: "Default true: returns criteria + full summary. false: returns only slim summary {allRequiredPassed, passedCount, selfClaimedCount, totalCount}."
				} }
			}
		},
		{
			name: "validate_criterion",
			description: "Record verification status and evidence for one criterion. Statuses passed and failed require evidence. Optional evidence_type: command/file/url/text (default text, flagged low-confidence). When role=agent, passed is marked self-claimed (needs reviewer confirmation). Default response is slim; pass verbose=true for full summary.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["criterion_id", "status"],
				properties: {
					criterion_id: {
						type: "string",
						description: "Exact criterion id."
					},
					status: {
						type: "string",
						enum: [
							"pending",
							"in_progress",
							"passed",
							"failed",
							"blocked",
							"not_run"
						],
						description: "Outcome status."
					},
					evidence: {
						type: "string",
						description: "Verification evidence. Required for passed/failed."
					},
					evidence_type: {
						type: "string",
						enum: [
							"command",
							"file",
							"url",
							"text"
						],
						description: "Type of evidence. text = low confidence. Default: text."
					},
					verbose: {
						type: "boolean",
						description: "Default false: returns criterion + slim summary. true: returns criterion + full summary."
					}
				}
			}
		},
		{
			name: "update_task_status",
			description: "Update the status of a task linked to one or more acceptance criteria. When all tasks linked to a criterion are completed, that criterion becomes ready to validate. Default response is slim; pass verbose=true for full summary.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["task_id", "status"],
				properties: {
					task_id: {
						type: "string",
						description: "The task ID to update."
					},
					status: {
						type: "string",
						enum: [
							"pending",
							"in_progress",
							"completed",
							"failed"
						],
						description: "New task status."
					},
					verbose: {
						type: "boolean",
						description: "Default false: returns taskId/status + slim summary. true: returns full summary."
					}
				}
			}
		},
		{
			name: "amend_acceptance_criteria",
			description: "Append new acceptance criteria after the initial lock. Existing criteria are not modified. Use when requirements expand during execution.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["criteria", "reason"],
				properties: {
					criteria: {
						type: "array",
						description: "New criteria to append.",
						items: CRITERION_ITEM_SCHEMA
					},
					reason: {
						type: "string",
						description: "Human-readable reason for the amendment."
					}
				}
			}
		},
		{
			name: "can_complete_goal",
			description: "Check whether the goal can be completed based on current acceptance criteria.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {}
			}
		},
		{
			name: "set_task_plan",
			description: "Set and lock the task decomposition plan for the current goal. Each task must have a unique id, an unambiguous description, and a concrete deliverable. Task dependencies must reference other tasks in the same plan; dependency cycles are rejected. Requires acceptance criteria to be locked first.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["tasks"],
				properties: { tasks: {
					type: "array",
					description: "Ordered list of atomic tasks.",
					items: TASK_PLAN_ITEM_SCHEMA
				} }
			}
		},
		{
			name: "get_task_plan",
			description: "Read the current task decomposition plan with live task statuses.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {}
			}
		}
	] }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		const input = args;
		switch (name) {
			case "set_acceptance_criteria": {
				const criteria = input.criteria;
				const role = input.role ?? "dual";
				const list = await engine.setCriteria(criteria.map((c) => ({
					id: c.id,
					description: c.description,
					...c.required !== void 0 ? { required: c.required } : {},
					...c.method !== void 0 ? { method: c.method } : {},
					...c.task_ids !== void 0 ? { taskIds: c.task_ids } : {},
					...c.depends_on !== void 0 ? { dependsOn: c.depends_on } : {}
				})), role);
				const summary = engine.summarize();
				return { content: [{
					type: "text",
					text: JSON.stringify({
						criteria: list,
						summary
					}, null, 2)
				}] };
			}
			case "get_acceptance_criteria": {
				const verbose = input.verbose !== false;
				const summary = engine.summarize();
				if (!verbose) return { content: [{
					type: "text",
					text: JSON.stringify({ summary: slimSummary(summary) })
				}] };
				const criteria = engine.getCriteria();
				return { content: [{
					type: "text",
					text: JSON.stringify({
						criteria,
						summary
					}, null, 2)
				}] };
			}
			case "validate_criterion": {
				const updated = await engine.validateCriterion({
					criterionId: input.criterion_id,
					status: input.status,
					evidence: input.evidence,
					...input.evidence_type !== void 0 ? { evidenceType: input.evidence_type } : {}
				});
				const verbose = input.verbose === true;
				const summary = engine.summarize();
				return { content: [{
					type: "text",
					text: JSON.stringify(verbose ? {
						criterion: updated,
						summary
					} : {
						criterion: updated,
						summary: slimSummary(summary)
					}, null, 2)
				}] };
			}
			case "update_task_status": {
				await engine.updateTaskStatus({
					taskId: input.task_id,
					status: input.status
				});
				const verbose = input.verbose === true;
				const summary = engine.summarize();
				return { content: [{
					type: "text",
					text: JSON.stringify(verbose ? {
						taskId: input.task_id,
						status: input.status,
						summary
					} : {
						taskId: input.task_id,
						status: input.status,
						summary: slimSummary(summary)
					}, null, 2)
				}] };
			}
			case "amend_acceptance_criteria": {
				const criteria = input.criteria;
				const added = await engine.amendCriteria({
					criteria: criteria.map((c) => ({
						id: c.id,
						description: c.description,
						...c.required !== void 0 ? { required: c.required } : {},
						...c.method !== void 0 ? { method: c.method } : {},
						...c.task_ids !== void 0 ? { taskIds: c.task_ids } : {},
						...c.depends_on !== void 0 ? { dependsOn: c.depends_on } : {}
					})),
					reason: input.reason
				});
				const summary = engine.summarize();
				return { content: [{
					type: "text",
					text: JSON.stringify({
						addedCriteria: added,
						summary
					}, null, 2)
				}] };
			}
			case "can_complete_goal": {
				const result = engine.canComplete();
				return { content: [{
					type: "text",
					text: JSON.stringify(result, null, 2)
				}] };
			}
			case "set_task_plan": {
				const tasks = input.tasks;
				const plan = await engine.setTaskPlan(tasks.map((t) => ({
					id: t.id,
					description: t.description,
					deliverable: t.deliverable,
					...t.depends_on !== void 0 ? { dependsOn: t.depends_on } : {}
				})));
				const summary = engine.summarize();
				return { content: [{
					type: "text",
					text: JSON.stringify({
						taskPlan: plan,
						summary: slimSummary(summary)
					}, null, 2)
				}] };
			}
			case "get_task_plan": {
				const plan = engine.getTaskPlan();
				return { content: [{
					type: "text",
					text: JSON.stringify({ taskPlan: plan }, null, 2)
				}] };
			}
			default: throw new Error(`Unknown tool: ${name}`);
		}
	});
	return server;
}
/** Start the stdio MCP server. */
async function main() {
	const dataDir = process.env.PLUGIN_DATA;
	if (dataDir !== void 0 && dataDir.length > 0) await mkdir(dirname(`${dataDir}/acceptance-events.json`), { recursive: true });
	const server = createMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
//#endregion
export { createMcpServer, main };
