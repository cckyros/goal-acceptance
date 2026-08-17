import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GoalAcceptanceEngine, GoalAcceptanceError, InMemoryAcceptanceStore } from "@cckyros/goal-acceptance-core";
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
/** Levenshtein distance for fuzzy matching. */
function levenshtein(a, b) {
	const m = a.length, n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	const dp = new Array(n + 1);
	for (let j = 0; j <= n; j++) dp[j] = j;
	for (let i = 1; i <= m; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= n; j++) {
			const tmp = dp[j];
			dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return dp[n];
}
/** Find closest match from candidates. Returns suggestion if distance <= threshold. */
function suggestClosest(input, candidates, threshold = 3) {
	let best;
	let bestDist = threshold + 1;
	for (const c of candidates) {
		const d = levenshtein(input.toLowerCase(), c.toLowerCase());
		if (d < bestDist) {
			bestDist = d;
			best = c;
		}
	}
	return best;
}
/** Package version read from package.json (single source of truth). */
const PACKAGE_VERSION = (() => {
	try {
		const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		return JSON.parse(readFileSync(pkgPath, "utf-8")).version;
	} catch {
		return "0.0.0";
	}
})();
/** Compact one-line summary for default (non-verbose) responses. */
function slimSummary(s) {
	return {
		allRequiredPassed: s.allRequiredPassed,
		passedCount: s.passedCount,
		selfClaimedCount: s.selfClaimedCount,
		totalCount: s.totalCount
	};
}
let currentGoalId = null;
const engineCache = /* @__PURE__ */ new Map();
const metaCache = /* @__PURE__ */ new Map();
/** Resolve the PLUGIN_DATA directory, or empty string for in-memory mode. */
function dataDir() {
	const d = process.env.PLUGIN_DATA;
	return d !== void 0 && d.length > 0 ? d : "";
}
/** Directory storing per-goal event files and metadata. */
function goalsDir() {
	const d = dataDir();
	return d ? join(d, "goals") : "";
}
/** File recording the currently active goal ID (for restart recovery). */
function currentGoalFile() {
	const d = dataDir();
	return d ? join(d, "current-goal.txt") : "";
}
/** Create a store for a specific goal. */
function storeForGoal(goalId) {
	const dir = goalsDir();
	if (dir) return new FileAcceptanceStore(join(dir, `${goalId}.json`));
	return new InMemoryAcceptanceStore();
}
/** Get or create the engine for the current goal. Throws if no active goal. */
function getEngine() {
	if (currentGoalId === null) throw new GoalAcceptanceError("no active goal. Call start_goal to create one, or set_acceptance_criteria to auto-create one.", "GOAL_ACCEPTANCE_NO_ACTIVE_GOAL");
	return getOrCreateEngine(currentGoalId);
}
/** Get or create an engine for a specific goal ID (bypasses current-goal check). */
function getOrCreateEngine(goalId) {
	let engine = engineCache.get(goalId);
	if (engine === void 0) {
		engine = new GoalAcceptanceEngine(storeForGoal(goalId));
		engineCache.set(goalId, engine);
	}
	return engine;
}
/** Start a new goal. Generates a UUID, persists metadata, sets it as current. */
function startGoal(title) {
	const id = randomUUID();
	const meta = {
		id,
		title: title ?? "",
		createdAt: Date.now()
	};
	const dir = goalsDir();
	if (dir) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta, null, 2) + "\n");
		writeFileSync(join(dir, `${id}.json`), "[]");
	}
	metaCache.set(id, meta);
	currentGoalId = id;
	persistCurrentGoal();
	engineCache.set(id, new GoalAcceptanceEngine(storeForGoal(id)));
	return meta;
}
/** Persist the current goal ID to disk for restart recovery. */
function persistCurrentGoal() {
	const f = currentGoalFile();
	if (f) writeFileSync(f, currentGoalId ?? "");
}
/** Load the current goal from disk on startup. */
function loadCurrentGoal() {
	const dir = goalsDir();
	if (!dir) return;
	const f = currentGoalFile();
	if (existsSync(f)) {
		const id = readFileSync(f, "utf-8").trim();
		if (id.length > 0 && existsSync(join(dir, `${id}.meta.json`))) {
			currentGoalId = id;
			loadGoalMeta(id);
		}
	}
}
/** Load a goal's metadata from disk into the cache. */
function loadGoalMeta(id) {
	const cached = metaCache.get(id);
	if (cached) return cached;
	const dir = goalsDir();
	if (!dir) return void 0;
	const metaPath = join(dir, `${id}.meta.json`);
	if (!existsSync(metaPath)) return void 0;
	const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
	metaCache.set(id, meta);
	return meta;
}
/** List all goals with status summaries. */
function listGoals() {
	const dir = goalsDir();
	if (!dir) return Array.from(metaCache.values()).map((m) => {
		const engine = engineCache.get(m.id);
		const summary = engine ? engine.summarize() : {
			totalCount: 0,
			passedCount: 0,
			allRequiredPassed: true
		};
		return {
			...m,
			criteriaCount: summary.totalCount,
			passedCount: summary.passedCount,
			allRequiredPassed: summary.allRequiredPassed,
			isActive: m.id === currentGoalId
		};
	}).sort((a, b) => b.createdAt - a.createdAt);
	return readdirSync(dir).filter((f) => f.endsWith(".meta.json")).map((f) => {
		const meta = JSON.parse(readFileSync(join(dir, f), "utf-8"));
		metaCache.set(meta.id, meta);
		const summary = getOrCreateEngine(meta.id).summarize();
		return {
			...meta,
			criteriaCount: summary.totalCount,
			passedCount: summary.passedCount,
			allRequiredPassed: summary.allRequiredPassed,
			isActive: meta.id === currentGoalId
		};
	}).sort((a, b) => b.createdAt - a.createdAt);
}
/** Switch the active goal to an existing goal ID. */
function switchGoal(id) {
	const dir = goalsDir();
	if (dir) {
		if (!existsSync(join(dir, `${id}.meta.json`))) throw new GoalAcceptanceError(`goal ${id} not found`, "GOAL_ACCEPTANCE_NOT_FOUND");
	} else if (!metaCache.has(id)) throw new GoalAcceptanceError(`goal ${id} not found`, "GOAL_ACCEPTANCE_NOT_FOUND");
	currentGoalId = id;
	persistCurrentGoal();
	return loadGoalMeta(id) ?? {
		id,
		title: "",
		createdAt: 0
	};
}
/** Reset (delete) the current goal's data and clear it as active. */
function resetGoal() {
	if (currentGoalId === null) throw new GoalAcceptanceError("no active goal to reset", "GOAL_ACCEPTANCE_NO_ACTIVE_GOAL");
	const id = currentGoalId;
	const dir = goalsDir();
	if (dir) {
		try {
			unlinkSync(join(dir, `${id}.json`));
		} catch {}
		try {
			unlinkSync(join(dir, `${id}.meta.json`));
		} catch {}
	}
	engineCache.delete(id);
	metaCache.delete(id);
	currentGoalId = null;
	persistCurrentGoal();
}
/** Ensure a goal is active; auto-create one if none exists. */
function ensureGoal() {
	if (currentGoalId === null) startGoal();
	return getEngine();
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
/** Reset all goal manager state (for testing: each createMcpServer gets fresh state). */
function resetGoalState() {
	currentGoalId = null;
	engineCache.clear();
	metaCache.clear();
}
/** Create a configured MCP server over the goal-acceptance engine. */
function createMcpServer() {
	resetGoalState();
	loadCurrentGoal();
	const server = new Server({
		name: "@cckyros/goal-acceptance-mcp",
		version: PACKAGE_VERSION
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
		},
		{
			name: "start_goal",
			description: "Start a new goal with a fresh state. Use this when the current goal is locked and you need to begin a new independent task. Each goal has its own acceptance criteria and task plan. The new goal becomes the active goal.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: { title: {
					type: "string",
					description: "Optional human-readable title for the goal."
				} }
			}
		},
		{
			name: "list_goals",
			description: "List all goals with their status summaries. Shows goal ID, title, creation time, criteria counts, and which goal is currently active.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {}
			}
		},
		{
			name: "switch_goal",
			description: "Switch the active goal to an existing goal by ID. Use list_goals to find goal IDs.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["goal_id"],
				properties: { goal_id: {
					type: "string",
					description: "The goal ID to switch to (from list_goals)."
				} }
			}
		},
		{
			name: "reset_goal",
			description: "Delete the current goal and all its data (criteria, task plan, validations). The goal is permanently removed. Use this to clear a messed-up goal and start fresh.",
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
		try {
			switch (name) {
				case "set_acceptance_criteria": {
					const criteria = input.criteria;
					const role = input.role ?? "dual";
					let engine = ensureGoal();
					try {
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
								goalId: currentGoalId,
								criteria: list,
								summary
							}, null, 2)
						}] };
					} catch (e) {
						if (e instanceof GoalAcceptanceError && e.code === "GOAL_ACCEPTANCE_ALREADY_LOCKED") {
							const completedGoalId = currentGoalId;
							if (engine.canComplete().allowed) {
								startGoal();
								engine = getEngine();
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
										goalId: currentGoalId,
										previousGoalId: completedGoalId,
										autoStarted: true,
										criteria: list,
										summary
									}, null, 2)
								}] };
							}
							throw new GoalAcceptanceError(`criteria are already locked for goal ${currentGoalId}. Call start_goal to begin a new goal, or reset_goal to clear the current one.`, "GOAL_ACCEPTANCE_ALREADY_LOCKED");
						}
						throw e;
					}
				}
				case "get_acceptance_criteria": {
					const verbose = input.verbose !== false;
					const engine = getEngine();
					const summary = engine.summarize();
					if (!verbose) return { content: [{
						type: "text",
						text: JSON.stringify({
							goalId: currentGoalId,
							summary: slimSummary(summary)
						})
					}] };
					const criteria = engine.getCriteria();
					return { content: [{
						type: "text",
						text: JSON.stringify({
							goalId: currentGoalId,
							criteria,
							summary
						}, null, 2)
					}] };
				}
				case "validate_criterion": {
					const engine = getEngine();
					try {
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
								goalId: currentGoalId,
								criterion: updated,
								summary
							} : {
								goalId: currentGoalId,
								criterion: updated,
								summary: slimSummary(summary)
							}, null, 2)
						}] };
					} catch (e) {
						if (e instanceof GoalAcceptanceError && e.code === "GOAL_ACCEPTANCE_CRITERION_NOT_FOUND") {
							const allIds = engine.getCriteria().map((c) => c.id);
							const suggestion = suggestClosest(input.criterion_id, allIds);
							throw new GoalAcceptanceError(`criterion_id "${input.criterion_id}" not found. Available IDs: [${allIds.join(", ")}].${suggestion ? ` Did you mean "${suggestion}"?` : ""} Call get_acceptance_criteria to see the full list.`, "GOAL_ACCEPTANCE_CRITERION_NOT_FOUND");
						}
						throw e;
					}
				}
				case "update_task_status": {
					const engine = getEngine();
					await engine.updateTaskStatus({
						taskId: input.task_id,
						status: input.status
					});
					const verbose = input.verbose === true;
					const summary = engine.summarize();
					return { content: [{
						type: "text",
						text: JSON.stringify(verbose ? {
							goalId: currentGoalId,
							taskId: input.task_id,
							status: input.status,
							summary
						} : {
							goalId: currentGoalId,
							taskId: input.task_id,
							status: input.status,
							summary: slimSummary(summary)
						}, null, 2)
					}] };
				}
				case "amend_acceptance_criteria": {
					const engine = getEngine();
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
							goalId: currentGoalId,
							addedCriteria: added,
							summary
						}, null, 2)
					}] };
				}
				case "can_complete_goal": {
					const result = getEngine().canComplete();
					return { content: [{
						type: "text",
						text: JSON.stringify({
							goalId: currentGoalId,
							...result
						}, null, 2)
					}] };
				}
				case "set_task_plan": {
					const engine = getEngine();
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
							goalId: currentGoalId,
							taskPlan: plan,
							summary: slimSummary(summary)
						}, null, 2)
					}] };
				}
				case "get_task_plan": {
					const plan = getEngine().getTaskPlan();
					return { content: [{
						type: "text",
						text: JSON.stringify({
							goalId: currentGoalId,
							taskPlan: plan
						}, null, 2)
					}] };
				}
				case "start_goal": {
					const title = input.title;
					const meta = startGoal(title);
					return { content: [{
						type: "text",
						text: JSON.stringify({
							goal: meta,
							message: "New goal started and set as active."
						}, null, 2)
					}] };
				}
				case "list_goals": {
					const goals = listGoals();
					return { content: [{
						type: "text",
						text: JSON.stringify({ goals }, null, 2)
					}] };
				}
				case "switch_goal": {
					const id = input.goal_id;
					const meta = switchGoal(id);
					return { content: [{
						type: "text",
						text: JSON.stringify({
							goal: meta,
							message: "Switched active goal."
						}, null, 2)
					}] };
				}
				case "reset_goal":
					resetGoal();
					return { content: [{
						type: "text",
						text: JSON.stringify({ message: "Current goal deleted. No active goal. Call set_acceptance_criteria to auto-create a new one, or start_goal." }, null, 2)
					}] };
				default: throw new Error(`Unknown tool: ${name}`);
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			const code = e instanceof GoalAcceptanceError ? e.code : "GOAL_ACCEPTANCE_INTERNAL_ERROR";
			return {
				content: [{
					type: "text",
					text: JSON.stringify({
						error: message,
						code
					}, null, 2)
				}],
				isError: true
			};
		}
	});
	return server;
}
/** Start the stdio MCP server. */
async function main() {
	const dir = goalsDir();
	if (dir) await mkdir(dir, { recursive: true });
	const server = createMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	const keepAlive = setInterval(() => {}, 1 << 30);
	process.stdin.on("close", () => {
		clearInterval(keepAlive);
		process.exit(0);
	});
}
function isMainEntry() {
	try {
		const argv1 = process.argv[1];
		if (!argv1) return false;
		const realArgv = realpathSync(argv1);
		return import.meta.url === pathToFileURL(realArgv).href;
	} catch {
		return false;
	}
}
if (isMainEntry()) main();
//#endregion
export { createMcpServer, main };
