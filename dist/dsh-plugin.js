// src/plugin/dsh-plugin.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/plugin/engine/errors.ts
var GoalAcceptanceError = class extends Error {
  code;
  constructor(message, code) {
    super(`goal-acceptance: ${message}`);
    this.code = code;
    this.name = "GoalAcceptanceError";
  }
};

// src/plugin/engine/store.ts
var InMemoryAcceptanceStore = class {
  _events = [];
  get events() {
    return this._events;
  }
  append(event) {
    this._events.push(event);
  }
};

// src/plugin/engine/engine.ts
function initialState() {
  return {
    criteria: /* @__PURE__ */ new Map(),
    order: [],
    locked: false,
    observedCount: 0,
    taskStatuses: /* @__PURE__ */ new Map(),
    role: "agent",
    taskPlan: /* @__PURE__ */ new Map(),
    taskPlanOrder: [],
    taskPlanLocked: false
  };
}
function toCriterion(spec, now, defaults) {
  return {
    id: spec.id.trim(),
    description: spec.description.trim(),
    required: spec.required !== false,
    method: typeof spec.method === "string" && spec.method.trim().length > 0 ? spec.method.trim() : "manual",
    status: "pending",
    updatedAt: now,
    taskIds: Array.isArray(spec.taskIds) ? spec.taskIds.map((t) => t.trim()).filter((t) => t.length > 0) : [],
    dependsOn: Array.isArray(spec.dependsOn) ? spec.dependsOn.map((d) => d.trim()).filter((d) => d.length > 0) : [],
    ...defaults.addedAfterLock === true ? { addedAfterLock: true, addedAt: defaults.addedAt ?? now } : {}
  };
}
function validateSpecs(specs, existingIds) {
  const seenIds = /* @__PURE__ */ new Set();
  for (const spec of specs) {
    if (typeof spec.id !== "string" || spec.id.trim().length === 0) {
      throw new GoalAcceptanceError("each criterion must have a non-empty id", "GOAL_ACCEPTANCE_INVALID_CRITERIA");
    }
    const id = spec.id.trim();
    if (seenIds.has(id)) {
      throw new GoalAcceptanceError(`duplicate criterion id "${id}"`, "GOAL_ACCEPTANCE_INVALID_CRITERIA");
    }
    if (existingIds.has(id)) {
      throw new GoalAcceptanceError(`criterion id "${id}" already exists`, "GOAL_ACCEPTANCE_DUPLICATE_AMEND_ID");
    }
    seenIds.add(id);
    if (typeof spec.description !== "string" || spec.description.trim().length === 0) {
      throw new GoalAcceptanceError(`criterion "${id}" must have a non-empty description`, "GOAL_ACCEPTANCE_INVALID_CRITERIA");
    }
  }
}
function validateTaskPlan(specs) {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new GoalAcceptanceError("task plan must be a non-empty array", "GOAL_ACCEPTANCE_INVALID_TASK_PLAN");
  }
  const ids = /* @__PURE__ */ new Set();
  const descriptions = /* @__PURE__ */ new Set();
  for (const spec of specs) {
    if (typeof spec.id !== "string" || spec.id.trim().length === 0) {
      throw new GoalAcceptanceError("each task must have a non-empty id", "GOAL_ACCEPTANCE_INVALID_TASK_PLAN");
    }
    const id = spec.id.trim();
    if (ids.has(id)) {
      throw new GoalAcceptanceError(`duplicate task id "${id}"`, "GOAL_ACCEPTANCE_INVALID_TASK_PLAN");
    }
    ids.add(id);
    if (typeof spec.description !== "string" || spec.description.trim().length === 0) {
      throw new GoalAcceptanceError(`task "${id}" must have a non-empty description`, "GOAL_ACCEPTANCE_INVALID_TASK_PLAN");
    }
    const description2 = spec.description.trim();
    if (descriptions.has(description2)) {
      throw new GoalAcceptanceError(`task "${id}" has an ambiguous description (duplicate of another task)`, "GOAL_ACCEPTANCE_INVALID_TASK_PLAN");
    }
    descriptions.add(description2);
    if (typeof spec.deliverable !== "string" || spec.deliverable.trim().length === 0) {
      throw new GoalAcceptanceError(`task "${id}" must declare a deliverable`, "GOAL_ACCEPTANCE_INVALID_TASK_PLAN");
    }
  }
  for (const spec of specs) {
    const id = spec.id.trim();
    for (const dep of spec.dependsOn ?? []) {
      const depId = dep.trim();
      if (depId.length === 0) {
        throw new GoalAcceptanceError(`task "${id}" has an empty dependency id`, "GOAL_ACCEPTANCE_INVALID_TASK_PLAN");
      }
      if (depId === id) {
        throw new GoalAcceptanceError(`task "${id}" cannot depend on itself`, "GOAL_ACCEPTANCE_INVALID_TASK_PLAN");
      }
      if (!ids.has(depId)) {
        throw new GoalAcceptanceError(`task "${id}" depends on unknown task "${depId}"`, "GOAL_ACCEPTANCE_INVALID_TASK_PLAN");
      }
    }
  }
  const deps = /* @__PURE__ */ new Map();
  for (const spec of specs) {
    deps.set(spec.id.trim(), (spec.dependsOn ?? []).map((d) => d.trim()));
  }
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      return [id];
    }
    if (visited.has(id)) {
      return [];
    }
    visiting.add(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle.length > 0) {
        return [id, ...cycle];
      }
    }
    visiting.delete(id);
    visited.add(id);
    return [];
  };
  for (const id of ids) {
    const cycle = visit(id);
    if (cycle.length > 0) {
      throw new GoalAcceptanceError(`dependency cycle detected: ${cycle.join(" -> ")}`, "GOAL_ACCEPTANCE_INVALID_TASK_PLAN");
    }
  }
}
function dependenciesMet(criterion, criteria) {
  if (criterion.dependsOn.length === 0) return true;
  return criterion.dependsOn.every((depId) => {
    const dep = criteria.get(depId);
    return dep !== void 0 && dep.status === "passed";
  });
}
function computeTaskProgress(criterion, taskStatuses) {
  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  let failed = 0;
  for (const taskId of criterion.taskIds) {
    const status = taskStatuses.get(taskId) ?? "pending";
    switch (status) {
      case "completed":
        completed += 1;
        break;
      case "in_progress":
        inProgress += 1;
        break;
      case "pending":
        pending += 1;
        break;
      case "failed":
        failed += 1;
        break;
    }
  }
  const total = criterion.taskIds.length;
  return {
    criterionId: criterion.id,
    totalTasks: total,
    completedTasks: completed,
    inProgressTasks: inProgress,
    pendingTasks: pending,
    failedTasks: failed,
    readyToValidate: total > 0 && completed === total
  };
}
var GoalAcceptanceEngine = class {
  state = initialState();
  store;
  constructor(store) {
    this.store = store;
  }
  /** Set and lock the acceptance criteria. Returns the resolved criteria list. */
  async setCriteria(specs, role = "agent") {
    if (!Array.isArray(specs) || specs.length === 0) {
      throw new GoalAcceptanceError("criteria list must be a non-empty array", "GOAL_ACCEPTANCE_INVALID_CRITERIA");
    }
    this.sync();
    if (this.state.locked) {
      throw new GoalAcceptanceError("acceptance criteria are already locked", "GOAL_ACCEPTANCE_ALREADY_LOCKED");
    }
    validateSpecs(specs, /* @__PURE__ */ new Set());
    const now = Date.now();
    const criteria = specs.map((spec) => toCriterion(spec, now, {}));
    const event = {
      type: "goal-acceptance/set",
      criteria,
      lockedAt: now,
      role
    };
    await this.store.append(event);
    this.applyEvent(event);
    return this.getCriteria();
  }
  /** Append new criteria after the initial lock. Existing criteria are not modified. */
  async amendCriteria(spec) {
    this.sync();
    if (!this.state.locked) {
      throw new GoalAcceptanceError("cannot amend before criteria are locked", "GOAL_ACCEPTANCE_NOT_LOCKED");
    }
    if (typeof spec.reason !== "string" || spec.reason.trim().length === 0) {
      throw new GoalAcceptanceError("amend reason is required", "GOAL_ACCEPTANCE_AMEND_REASON_REQUIRED");
    }
    if (!Array.isArray(spec.criteria) || spec.criteria.length === 0) {
      throw new GoalAcceptanceError("amend criteria list must be a non-empty array", "GOAL_ACCEPTANCE_INVALID_CRITERIA");
    }
    const existingIds = new Set(this.state.order);
    validateSpecs(spec.criteria, existingIds);
    const now = Date.now();
    const addedCriteria = spec.criteria.map((s) => toCriterion(s, now, { addedAfterLock: true, addedAt: now }));
    const event = {
      type: "goal-acceptance/amend",
      addedCriteria,
      reason: spec.reason.trim(),
      amendedAt: now
    };
    await this.store.append(event);
    this.applyEvent(event);
    return addedCriteria;
  }
  /** Record verification status and evidence for one criterion. */
  async validateCriterion(spec) {
    this.sync();
    const existing = this.state.criteria.get(spec.criterionId);
    if (existing === void 0) {
      throw new GoalAcceptanceError(`criterion "${spec.criterionId}" not found`, "GOAL_ACCEPTANCE_CRITERION_NOT_FOUND");
    }
    const requiresEvidence = spec.status === "passed" || spec.status === "failed";
    if (requiresEvidence && (typeof spec.evidence !== "string" || spec.evidence.trim().length === 0)) {
      throw new GoalAcceptanceError(`evidence is required when setting criterion to "${spec.status}"`, "GOAL_ACCEPTANCE_EVIDENCE_REQUIRED");
    }
    const evidenceType = spec.evidenceType ?? "text";
    const selfClaimed = spec.status === "passed" && this.state.role === "agent";
    const now = Date.now();
    const event = {
      type: "goal-acceptance/validate",
      criterionId: spec.criterionId,
      status: spec.status,
      evidence: spec.evidence !== void 0 && spec.evidence.trim().length > 0 ? spec.evidence.trim() : void 0,
      validatedAt: now,
      evidenceType,
      ...selfClaimed ? { selfClaimed: true } : {}
    };
    await this.store.append(event);
    this.applyEvent(event);
    const updated = this.state.criteria.get(spec.criterionId);
    if (updated === void 0) throw new Error("sync failed");
    return updated;
  }
  /**
   * Reviewer confirmation of a self-claimed passed criterion.
   * Converts selfClaimed=true to a formal pass. Requires independent
   * high-confidence evidence (command/file/url); 'text' evidence is rejected.
   */
  async confirmCriterion(spec) {
    this.sync();
    const existing = this.state.criteria.get(spec.criterionId);
    if (existing === void 0) {
      throw new GoalAcceptanceError(`criterion "${spec.criterionId}" not found`, "GOAL_ACCEPTANCE_CRITERION_NOT_FOUND");
    }
    if (existing.status !== "passed" || existing.selfClaimed !== true) {
      throw new GoalAcceptanceError(
        `criterion "${spec.criterionId}" is not a self-claimed pass (status: ${existing.status}, selfClaimed: ${existing.selfClaimed === true}). Only self-claimed passed criteria can be confirmed.`,
        "GOAL_ACCEPTANCE_NOT_SELF_CLAIMED"
      );
    }
    if (typeof spec.evidence !== "string" || spec.evidence.trim().length === 0) {
      throw new GoalAcceptanceError("independent re-verification evidence is required to confirm a criterion", "GOAL_ACCEPTANCE_EVIDENCE_REQUIRED");
    }
    if (spec.evidenceType === "text") {
      throw new GoalAcceptanceError(
        "confirmation requires high-confidence evidence (command, file, or url); text evidence is not accepted",
        "GOAL_ACCEPTANCE_LOW_CONFIDENCE_EVIDENCE"
      );
    }
    const now = Date.now();
    const event = {
      type: "goal-acceptance/validate",
      criterionId: spec.criterionId,
      status: "passed",
      evidence: spec.evidence.trim(),
      validatedAt: now,
      evidenceType: spec.evidenceType
    };
    await this.store.append(event);
    this.applyEvent(event);
    const updated = this.state.criteria.get(spec.criterionId);
    if (updated === void 0) throw new Error("sync failed");
    return updated;
  }
  /** Update the status of a linked task. The host calls this when its task system changes. */
  async updateTaskStatus(spec) {
    this.sync();
    const now = Date.now();
    const event = {
      type: "goal-acceptance/task-update",
      taskId: spec.taskId,
      taskStatus: spec.status,
      updatedAt: now
    };
    await this.store.append(event);
    this.applyEvent(event);
  }
  /** Set and lock the task decomposition plan. Requires criteria to be locked first. */
  async setTaskPlan(specs) {
    this.sync();
    if (!this.state.locked) {
      throw new GoalAcceptanceError("cannot set a task plan before criteria are locked", "GOAL_ACCEPTANCE_NOT_LOCKED");
    }
    if (this.state.taskPlanLocked) {
      throw new GoalAcceptanceError("task plan is already set", "GOAL_ACCEPTANCE_TASK_PLAN_ALREADY_SET");
    }
    validateTaskPlan(specs);
    const now = Date.now();
    const tasks = specs.map((spec) => ({
      id: spec.id.trim(),
      description: spec.description.trim(),
      deliverable: spec.deliverable.trim(),
      dependsOn: (spec.dependsOn ?? []).map((d) => d.trim()).filter((d) => d.length > 0),
      status: "pending",
      updatedAt: now
    }));
    const event = {
      type: "goal-acceptance/task-plan",
      tasks,
      plannedAt: now
    };
    await this.store.append(event);
    this.applyEvent(event);
    return this.getTaskPlan();
  }
  /** Get the task decomposition plan in declaration order. Empty array if no plan set. */
  getTaskPlan() {
    this.sync();
    return this.state.taskPlanOrder.map((id) => ({
      ...this.state.taskPlan.get(id),
      status: this.state.taskStatuses.get(id) ?? this.state.taskPlan.get(id).status
    }));
  }
  /** Get all criteria in declaration order. */
  getCriteria() {
    this.sync();
    return this.state.order.map((id) => this.state.criteria.get(id));
  }
  /** Get a single criterion by id. */
  getCriterion(id) {
    this.sync();
    return this.state.criteria.get(id);
  }
  /** Compute aggregate summary of criteria validation with task progress and actionable ordering. */
  summarize() {
    const list = this.getCriteria();
    const passed = [];
    const formalPassed = [];
    const selfClaimedPassed = [];
    const failures = [];
    const blockers = [];
    const pending = [];
    const notRun = [];
    let allRequiredPassed = true;
    for (const c of list) {
      switch (c.status) {
        case "passed":
          passed.push(c);
          if (c.selfClaimed === true) {
            selfClaimedPassed.push(c);
            if (c.required) allRequiredPassed = false;
          } else {
            formalPassed.push(c);
          }
          break;
        case "failed":
          failures.push(c);
          if (c.required) allRequiredPassed = false;
          break;
        case "blocked":
          blockers.push(c);
          if (c.required) allRequiredPassed = false;
          break;
        case "in_progress":
        case "pending":
          pending.push(c);
          if (c.required) allRequiredPassed = false;
          break;
        case "not_run":
          notRun.push(c);
          if (c.required) allRequiredPassed = false;
          break;
      }
    }
    const criterionTaskProgress = [];
    let totalTasks = 0;
    let completedTasks = 0;
    let inProgressTasks = 0;
    let pendingTasks = 0;
    let failedTasks = 0;
    const planTasks = this.state.taskPlanOrder.map((id) => this.state.taskPlan.get(id));
    if (planTasks.length > 0) {
      for (const task of planTasks) {
        const status = this.state.taskStatuses.get(task.id) ?? "pending";
        switch (status) {
          case "completed":
            completedTasks += 1;
            break;
          case "in_progress":
            inProgressTasks += 1;
            break;
          case "pending":
            pendingTasks += 1;
            break;
          case "failed":
            failedTasks += 1;
            break;
        }
      }
      totalTasks = planTasks.length;
    } else {
      for (const c of list) {
        if (c.taskIds.length > 0) {
          const progress = computeTaskProgress(c, this.state.taskStatuses);
          criterionTaskProgress.push(progress);
          totalTasks += progress.totalTasks;
          completedTasks += progress.completedTasks;
          inProgressTasks += progress.inProgressTasks;
          pendingTasks += progress.pendingTasks;
          failedTasks += progress.failedTasks;
        }
      }
    }
    const readyToValidate = list.filter((c) => c.taskIds.length > 0 && (c.status === "pending" || c.status === "in_progress")).filter((c) => computeTaskProgress(c, this.state.taskStatuses).readyToValidate).filter((c) => dependenciesMet(c, this.state.criteria)).sort((a, b) => topologicalCompare(a, b, this.state.criteria));
    const nextActionable = list.filter((c) => c.required && (c.status === "pending" || c.status === "in_progress")).filter((c) => dependenciesMet(c, this.state.criteria)).sort((a, b) => topologicalCompare(a, b, this.state.criteria));
    return {
      allRequiredPassed: list.length > 0 ? allRequiredPassed : true,
      totalCount: list.length,
      passedCount: passed.length,
      failedCount: failures.length,
      blockedCount: blockers.length,
      pendingCount: pending.length,
      notRunCount: notRun.length,
      selfClaimedCount: selfClaimedPassed.length,
      passed,
      formalPassed,
      selfClaimedPassed,
      failures,
      blockers,
      pending,
      notRun,
      taskProgress: {
        totalTasks,
        completedTasks,
        inProgressTasks,
        pendingTasks,
        failedTasks
      },
      criterionTaskProgress,
      readyToValidate,
      nextActionable,
      taskPlan: planTasks.map((task) => ({
        ...task,
        status: this.state.taskStatuses.get(task.id) ?? task.status
      }))
    };
  }
  /** Check whether this Goal is allowed to conclude with 'complete'. */
  canComplete() {
    this.sync();
    if (!this.state.locked || this.state.criteria.size === 0) {
      return { allowed: true };
    }
    const summary = this.summarize();
    if (summary.allRequiredPassed) {
      return { allowed: true };
    }
    const selfClaimedRequired = summary.selfClaimedPassed.filter((c) => c.required).length;
    const unresolvedCount = summary.failedCount + summary.blockedCount + summary.pendingCount + summary.notRunCount;
    if (selfClaimedRequired > 0 && unresolvedCount === 0) {
      return {
        allowed: false,
        reason: `Cannot complete goal: ${selfClaimedRequired} required criterion are self-claimed by agent, awaiting reviewer confirmation`
      };
    }
    return {
      allowed: false,
      reason: `Cannot complete goal: ${unresolvedCount} required acceptance criteria are not passed`
    };
  }
  sync() {
    const events = this.store.events.slice(this.state.observedCount);
    for (const event of events) {
      this.applyEvent(event);
      this.state.observedCount += 1;
    }
  }
  applyEvent(event) {
    if (event.type === "goal-acceptance/set") {
      const data = event;
      this.state.criteria.clear();
      this.state.order = [];
      for (const criterion of data.criteria) {
        this.state.criteria.set(criterion.id, criterion);
        this.state.order.push(criterion.id);
      }
      this.state.locked = true;
      this.state.role = data.role ?? "agent";
    } else if (event.type === "goal-acceptance/validate") {
      const data = event;
      const existing = this.state.criteria.get(data.criterionId);
      if (existing !== void 0) {
        const evidenceType = data.evidenceType ?? "text";
        this.state.criteria.set(data.criterionId, {
          ...existing,
          status: data.status,
          ...data.evidence !== void 0 ? { evidence: data.evidence } : {},
          updatedAt: data.validatedAt,
          evidenceType,
          lowConfidence: evidenceType === "text",
          ...data.selfClaimed === true ? { selfClaimed: true } : {},
          ...data.selfClaimed !== true ? { selfClaimed: false } : {}
        });
      }
    } else if (event.type === "goal-acceptance/task-update") {
      const data = event;
      this.state.taskStatuses.set(data.taskId, data.taskStatus);
    } else if (event.type === "goal-acceptance/amend") {
      const data = event;
      for (const criterion of data.addedCriteria) {
        if (!this.state.criteria.has(criterion.id)) {
          this.state.criteria.set(criterion.id, criterion);
          this.state.order.push(criterion.id);
        }
      }
    } else if (event.type === "goal-acceptance/task-plan") {
      const data = event;
      this.state.taskPlan.clear();
      this.state.taskPlanOrder = [];
      for (const task of data.tasks) {
        this.state.taskPlan.set(task.id, task);
        this.state.taskPlanOrder.push(task.id);
      }
      this.state.taskPlanLocked = true;
      for (const task of data.tasks) {
        if (!this.state.taskStatuses.has(task.id)) {
          this.state.taskStatuses.set(task.id, "pending");
        }
      }
    }
  }
};
function topologicalCompare(a, b, criteria) {
  if (dependsOnTransitive(b, a.id, criteria, /* @__PURE__ */ new Set())) return -1;
  if (dependsOnTransitive(a, b.id, criteria, /* @__PURE__ */ new Set())) return 1;
  return 0;
}
function dependsOnTransitive(criterion, targetId, criteria, visited) {
  if (criterion.dependsOn.includes(targetId)) return true;
  for (const depId of criterion.dependsOn) {
    if (visited.has(depId)) continue;
    visited.add(depId);
    const dep = criteria.get(depId);
    if (dep !== void 0 && dependsOnTransitive(dep, targetId, criteria, visited)) return true;
  }
  return false;
}

// src/plugin/goal-manager.ts
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var FileAcceptanceStore = class {
  path;
  constructor(path) {
    this.path = path;
  }
  async #read() {
    if (!existsSync(this.path)) return [];
    const raw = await readFileSync(this.path, "utf-8");
    if (raw.trim().length === 0) return [];
    return JSON.parse(raw);
  }
  async #write(events) {
    await writeFileSync(this.path, JSON.stringify(events, null, 2) + "\n");
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
var GoalManager = class {
  dataDir;
  goalsDir;
  currentGoalId = null;
  engineCache = /* @__PURE__ */ new Map();
  metaCache = /* @__PURE__ */ new Map();
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.goalsDir = dataDir ? join(dataDir, "goals") : "";
    if (dataDir) {
      mkdirSync(this.goalsDir, { recursive: true });
      this.loadCurrentGoal();
    }
  }
  getCurrentGoalId() {
    return this.currentGoalId;
  }
  /** Create a store for a specific goal (file-backed when persisted). */
  storeForGoal(goalId) {
    const dir = this.goalsDir;
    if (dir) {
      return new FileAcceptanceStore(join(dir, `${goalId}.json`));
    }
    return new InMemoryAcceptanceStore();
  }
  /** Get or create the engine for a specific goal ID. */
  getOrCreateEngine(goalId) {
    let engine = this.engineCache.get(goalId);
    if (engine === void 0) {
      engine = new GoalAcceptanceEngine(this.storeForGoal(goalId));
      this.engineCache.set(goalId, engine);
    }
    return engine;
  }
  /** Get the engine for the active goal. Throws if no active goal. */
  getEngine() {
    if (this.currentGoalId === null) {
      throw new GoalAcceptanceError(
        "no active goal. Call start_goal to create one, or set_acceptance_criteria to auto-create one.",
        "GOAL_ACCEPTANCE_NO_ACTIVE_GOAL"
      );
    }
    return this.getOrCreateEngine(this.currentGoalId);
  }
  /** Ensure a goal is active; auto-create one if none exists. */
  ensureGoal() {
    if (this.currentGoalId === null) {
      this.startGoal();
    }
    return this.getEngine();
  }
  /** Start a new goal. Generates a UUID, persists metadata, sets it as current. */
  startGoal(title) {
    const id = randomUUID();
    const meta = { id, title: title ?? "", createdAt: Date.now() };
    const dir = this.goalsDir;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta, null, 2) + "\n");
      writeFileSync(join(dir, `${id}.json`), "[]");
    }
    this.metaCache.set(id, meta);
    this.currentGoalId = id;
    this.persistCurrentGoal();
    this.engineCache.set(id, new GoalAcceptanceEngine(this.storeForGoal(id)));
    return meta;
  }
  /** Persist the current goal ID to disk for restart recovery. */
  persistCurrentGoal() {
    const d = this.dataDir;
    if (d) {
      writeFileSync(join(d, "current-goal.txt"), this.currentGoalId ?? "");
    }
  }
  /** Load the current goal from disk on startup. */
  loadCurrentGoal() {
    const dir = this.goalsDir;
    if (!dir) return;
    const f = join(this.dataDir, "current-goal.txt");
    if (existsSync(f)) {
      const id = readFileSync(f, "utf-8").trim();
      if (id.length > 0 && existsSync(join(dir, `${id}.meta.json`))) {
        this.currentGoalId = id;
        this.loadGoalMeta(id);
      }
    }
  }
  /** Load a goal's metadata from disk into the cache. */
  loadGoalMeta(id) {
    const cached = this.metaCache.get(id);
    if (cached) return cached;
    const dir = this.goalsDir;
    if (!dir) return void 0;
    const metaPath = join(dir, `${id}.meta.json`);
    if (!existsSync(metaPath)) return void 0;
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    this.metaCache.set(id, meta);
    return meta;
  }
  /** List all goals with status summaries. */
  listGoals() {
    const dir = this.goalsDir;
    if (!dir) {
      return Array.from(this.metaCache.values()).map((m) => {
        const engine = this.engineCache.get(m.id);
        const summary = engine ? engine.summarize() : { totalCount: 0, passedCount: 0, allRequiredPassed: true };
        return {
          ...m,
          criteriaCount: summary.totalCount,
          passedCount: summary.passedCount,
          allRequiredPassed: summary.allRequiredPassed,
          isActive: m.id === this.currentGoalId
        };
      }).sort((a, b) => b.createdAt - a.createdAt);
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
    return files.map((f) => {
      const meta = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      this.metaCache.set(meta.id, meta);
      const engine = this.getOrCreateEngine(meta.id);
      const summary = engine.summarize();
      return {
        ...meta,
        criteriaCount: summary.totalCount,
        passedCount: summary.passedCount,
        allRequiredPassed: summary.allRequiredPassed,
        isActive: meta.id === this.currentGoalId
      };
    }).sort((a, b) => b.createdAt - a.createdAt);
  }
  /** Switch the active goal to an existing goal ID. */
  switchGoal(id) {
    const dir = this.goalsDir;
    if (dir) {
      if (!existsSync(join(dir, `${id}.meta.json`))) {
        throw new GoalAcceptanceError(`goal ${id} not found`, "GOAL_ACCEPTANCE_NOT_FOUND");
      }
    } else {
      if (!this.metaCache.has(id)) {
        throw new GoalAcceptanceError(`goal ${id} not found`, "GOAL_ACCEPTANCE_NOT_FOUND");
      }
    }
    this.currentGoalId = id;
    this.persistCurrentGoal();
    return this.loadGoalMeta(id) ?? { id, title: "", createdAt: 0 };
  }
  /** Reset (delete) the current goal's data and clear it as active. */
  resetGoal() {
    if (this.currentGoalId === null) {
      throw new GoalAcceptanceError("no active goal to reset", "GOAL_ACCEPTANCE_NO_ACTIVE_GOAL");
    }
    const id = this.currentGoalId;
    const dir = this.goalsDir;
    if (dir) {
      try {
        unlinkSync(join(dir, `${id}.json`));
      } catch {
      }
      try {
        unlinkSync(join(dir, `${id}.meta.json`));
      } catch {
      }
    }
    this.engineCache.delete(id);
    this.metaCache.delete(id);
    this.currentGoalId = null;
    this.persistCurrentGoal();
  }
};
var ACCEPTANCE_EVENT_TYPES = /* @__PURE__ */ new Set([
  "goal-acceptance/set",
  "goal-acceptance/validate",
  "goal-acceptance/task-update",
  "goal-acceptance/amend",
  "goal-acceptance/task-plan"
]);
var SessionAcceptanceStore = class {
  // Plain field (not a TS parameter property): node --test strip-only mode
  // cannot parse constructor parameter properties.
  session;
  constructor(session) {
    this.session = session;
  }
  get events() {
    return this.session.events.filter(isAcceptanceEvent).map(toGoalAcceptanceEvent);
  }
  append(event) {
    switch (event.type) {
      case "goal-acceptance/set": {
        const { type: _type, ...payload } = event;
        this.session.append("goal-acceptance/set", payload);
        break;
      }
      case "goal-acceptance/validate": {
        const { type: _type, evidence, ...payload } = event;
        this.session.append("goal-acceptance/validate", {
          ...payload,
          ...evidence !== void 0 ? { evidence } : {}
        });
        break;
      }
      case "goal-acceptance/task-update": {
        const { type: _type, ...payload } = event;
        this.session.append("goal-acceptance/task-update", payload);
        break;
      }
      case "goal-acceptance/amend": {
        const { type: _type, ...payload } = event;
        this.session.append("goal-acceptance/amend", payload);
        break;
      }
      case "goal-acceptance/task-plan": {
        const { type: _type, ...payload } = event;
        this.session.append("goal-acceptance/task-plan", payload);
        break;
      }
    }
  }
};
function isAcceptanceEvent(event) {
  return ACCEPTANCE_EVENT_TYPES.has(event.type);
}
function toGoalAcceptanceEvent(event) {
  return { ...event.data, type: event.type };
}

// src/plugin/tools.ts
var CRITERION_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "description"],
  properties: {
    id: { type: "string", description: "Short unique identifier." },
    description: { type: "string", description: "Concrete requirement." },
    required: { type: "boolean", description: "Whether required for goal completion." },
    method: { type: "string", description: "Verification method: test, command, browser, manual." },
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
var TASK_PLAN_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "description", "deliverable"],
  properties: {
    id: { type: "string", description: 'Unique task id (e.g. "t1", "api-endpoint").' },
    description: { type: "string", description: "Non-empty, unambiguous task description." },
    deliverable: { type: "string", description: "Concrete artifact that proves this task is done." },
    depends_on: {
      type: "array",
      items: { type: "string" },
      description: "Task ids this task depends on within the same plan."
    }
  }
};
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
function fail(e) {
  const message = e instanceof Error ? e.message : String(e);
  const code = e instanceof GoalAcceptanceError ? e.code : "GOAL_ACCEPTANCE_INTERNAL_ERROR";
  return { error: message, code };
}
function slimSummary(s) {
  return {
    allRequiredPassed: s.allRequiredPassed,
    passedCount: s.passedCount,
    selfClaimedCount: s.selfClaimedCount,
    totalCount: s.totalCount
  };
}
function mapCriterion(c) {
  return {
    id: c.id,
    description: c.description,
    ...c.required !== void 0 ? { required: c.required } : {},
    ...c.method !== void 0 ? { method: c.method } : {},
    ...c.task_ids !== void 0 ? { taskIds: c.task_ids } : {},
    ...c.depends_on !== void 0 ? { dependsOn: c.depends_on } : {}
  };
}
function mapTask(t) {
  return {
    id: t.id,
    description: t.description,
    deliverable: t.deliverable,
    ...t.depends_on !== void 0 ? { dependsOn: t.depends_on } : {}
  };
}
var manager = null;
var managerDataDir;
function getManager(config) {
  const d = config.pluginData ?? "";
  if (manager === null || managerDataDir !== d) {
    manager = new GoalManager(d);
    managerDataDir = d;
  }
  return manager;
}
var tools = [
  {
    name: "set_acceptance_criteria",
    description: [
      "Set and lock the initial acceptance criteria for the current goal. Must be called before implementation.",
      "",
      "WORKFLOW (follow in order):",
      "1. PLANNING: For multi-step tasks, spawn a planning subagent (subagent_explore profile) to explore the codebase, draft criteria with goal-backward coverage analysis (every requirement mapped to a criterion, no overlaps, no gaps), then call this tool. Do NOT write criteria directly under execution pressure.",
      "2. TASK PLAN: Call set_task_plan to decompose the goal into atomic tasks with dependencies.",
      "3. EXECUTE: update_task_status as tasks progress.",
      "4. VALIDATE: validate_criterion with evidence_type=command/file/url (NEVER text). You MUST run the actual command before validating.",
      "5. CONFIRM: confirm_criterion MUST be called by an independent reviewer agent with fresh high-confidence evidence. Converts self-claimed passes to formal passes.",
      "6. COMPLETE: can_complete_goal checks all required criteria are formally passed. Self-claimed required criteria block completion.",
      "",
      "CRITERION QUALITY RULES:",
      "- id: kebab-case, unique",
      '- description: concrete and verifiable (NOT vague verbs like "implement", "ensure", "handle")',
      "- method: command | file | url (NEVER text)",
      "- required: true if the goal cannot be achieved without it",
      "- role: agent (default) marks passed as self-claimed; reviewer/dual marks formal passed",
      "",
      "CRITICAL: Default role=agent. Passed criteria are self-claimed, requiring confirm_criterion before completion. Do NOT declare a task complete until can_complete_goal returns allowed=true.",
      "",
      "ALREADY-LOCKED BEHAVIOUR: Criteria are immutable once locked, so calling this again rotates to a NEW goal instead of failing. The response reports previousGoalId, and previousGoalIncomplete=true when the goal you just left still had unfinished required criteria. To add criteria to the CURRENT goal use amend_acceptance_criteria; to return to a rotated-away goal use list_goals then switch_goal."
    ].join("\n"),
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
          enum: ["agent", "reviewer", "dual"],
          description: "Role locking the criteria. agent (default): passed marks self-claimed, requiring confirm_criterion by an independent reviewer. reviewer/dual: formal passed immediately (use only when the user explicitly waives independent review)."
        }
      }
    },
    handler: async (args, ctx) => {
      const mgr = getManager(ctx.config);
      const criteria = args.criteria;
      const role = args.role ?? "agent";
      let engine = mgr.ensureGoal();
      try {
        const list = await engine.setCriteria(criteria.map(mapCriterion), role);
        const summary = engine.summarize();
        return { goalId: mgr.getCurrentGoalId(), criteria: list, summary };
      } catch (e) {
        if (e instanceof GoalAcceptanceError && e.code === "GOAL_ACCEPTANCE_ALREADY_LOCKED") {
          const previousGoalId = mgr.getCurrentGoalId();
          const completion = engine.canComplete();
          const previousGoalSummary = slimSummary(engine.summarize());
          mgr.startGoal();
          engine = mgr.getEngine();
          const list = await engine.setCriteria(criteria.map(mapCriterion), role);
          return {
            goalId: mgr.getCurrentGoalId(),
            previousGoalId,
            autoStarted: true,
            previousGoalIncomplete: !completion.allowed,
            ...completion.allowed ? {} : { previousGoalReason: completion.reason, previousGoalSummary },
            criteria: list,
            summary: engine.summarize()
          };
        }
        return fail(e);
      }
    }
  },
  {
    name: "get_acceptance_criteria",
    description: "Read the current acceptance criteria, task progress, and summary. Default returns full criteria list + summary. Pass verbose=false for a one-line summary only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        verbose: {
          type: "boolean",
          description: "Default true: returns criteria + full summary. false: returns only slim summary {allRequiredPassed, passedCount, selfClaimedCount, totalCount}."
        }
      }
    },
    handler: async (args, ctx) => {
      const mgr = getManager(ctx.config);
      try {
        const verbose = args.verbose !== false;
        const engine = mgr.getEngine();
        const summary = engine.summarize();
        if (!verbose) {
          return { goalId: mgr.getCurrentGoalId(), summary: slimSummary(summary) };
        }
        const criteria = engine.getCriteria();
        return { goalId: mgr.getCurrentGoalId(), criteria, summary };
      } catch (e) {
        return fail(e);
      }
    }
  },
  {
    name: "validate_criterion",
    description: [
      "Record verification status and evidence for one criterion. Statuses passed and failed require evidence.",
      "",
      "EVIDENCE REQUIREMENTS \u2014 you MUST run the actual verification before calling this:",
      "- method=command: run the exact command in a shell, paste real stdout/stderr + exit code",
      "- method=file: read the file and check the content, paste relevant lines",
      "- method=url: make the HTTP request, paste response status + body",
      "",
      "FORBIDDEN:",
      "- Do NOT validate passed without running anything",
      '- Do NOT write "should work" or "looks correct" as evidence',
      "- Do NOT use evidence_type=text for a criterion with method=command",
      "- Do NOT copy evidence from a previous run without re-running",
      "",
      "When role=agent (default), passed is marked self-claimed (needs confirm_criterion by an independent reviewer before completion). Default response is slim; pass verbose=true for full summary."
    ].join("\n"),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["criterion_id", "status"],
      properties: {
        criterion_id: { type: "string", description: "Exact criterion id." },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "passed", "failed", "blocked", "not_run"],
          description: "Outcome status."
        },
        evidence: { type: "string", description: "Verification evidence. Required for passed/failed." },
        evidence_type: {
          type: "string",
          enum: ["command", "file", "url", "text"],
          description: "Type of evidence. text = low confidence. Default: text."
        },
        verbose: {
          type: "boolean",
          description: "Default false: returns criterion + slim summary. true: returns criterion + full summary."
        }
      }
    },
    handler: async (args, ctx) => {
      const mgr = getManager(ctx.config);
      const engine = mgr.getEngine();
      try {
        const updated = await engine.validateCriterion({
          criterionId: args.criterion_id,
          status: args.status,
          evidence: args.evidence,
          ...args.evidence_type !== void 0 ? { evidenceType: args.evidence_type } : {}
        });
        const verbose = args.verbose === true;
        const summary = engine.summarize();
        return {
          goalId: mgr.getCurrentGoalId(),
          criterion: updated,
          summary: verbose ? summary : slimSummary(summary)
        };
      } catch (e) {
        if (e instanceof GoalAcceptanceError && e.code === "GOAL_ACCEPTANCE_CRITERION_NOT_FOUND") {
          const allIds = engine.getCriteria().map((c) => c.id);
          const suggestion = suggestClosest(args.criterion_id, allIds);
          return fail(new GoalAcceptanceError(
            `criterion_id "${String(args.criterion_id)}" not found. Available IDs: [${allIds.join(", ")}].${suggestion ? ` Did you mean "${suggestion}"?` : ""} Call get_acceptance_criteria to see the full list.`,
            "GOAL_ACCEPTANCE_CRITERION_NOT_FOUND"
          ));
        }
        return fail(e);
      }
    }
  },
  {
    name: "confirm_criterion",
    description: [
      "Reviewer confirmation of a self-claimed passed criterion. Converts self-claimed to formal pass, unblocking can_complete_goal.",
      "",
      "WHO SHOULD CALL: An independent reviewer agent (e.g. a subagent spawned to review the work). NOT the agent that performed the task.",
      "",
      "WHAT TO DO:",
      "1. Read the criterion description and its original evidence",
      "2. Independently re-verify \u2014 do NOT trust the original evidence:",
      "   - method=command: re-run the command yourself",
      "   - method=file: read the file yourself and check the content",
      "   - method=url: make the HTTP request yourself",
      "3. If re-verification passes, call this tool with YOUR fresh evidence",
      "4. If re-verification fails, call validate_criterion with status=failed",
      "",
      "REQUIRES high-confidence evidence_type (command/file/url); text is rejected."
    ].join("\n"),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["criterion_id", "evidence", "evidence_type"],
      properties: {
        criterion_id: { type: "string", description: "Criterion id to confirm. Must currently be passed and self-claimed." },
        evidence: { type: "string", description: "Independent re-verification evidence gathered by the reviewer (not copied from the original validation)." },
        evidence_type: {
          type: "string",
          enum: ["command", "file", "url"],
          description: "Type of evidence. Must be high-confidence; text is not accepted."
        }
      }
    },
    handler: async (args, ctx) => {
      const mgr = getManager(ctx.config);
      try {
        const engine = mgr.getEngine();
        const updated = await engine.confirmCriterion({
          criterionId: args.criterion_id,
          evidence: args.evidence,
          evidenceType: args.evidence_type
        });
        const summary = engine.summarize();
        return { goalId: mgr.getCurrentGoalId(), criterion: updated, summary: slimSummary(summary) };
      } catch (e) {
        return fail(e);
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
        task_id: { type: "string", description: "The task ID to update." },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "failed"],
          description: "New task status."
        },
        verbose: {
          type: "boolean",
          description: "Default false: returns taskId/status + slim summary. true: returns full summary."
        }
      }
    },
    handler: async (args, ctx) => {
      const mgr = getManager(ctx.config);
      try {
        const engine = mgr.getEngine();
        await engine.updateTaskStatus({
          taskId: args.task_id,
          status: args.status
        });
        const verbose = args.verbose === true;
        const summary = engine.summarize();
        return {
          goalId: mgr.getCurrentGoalId(),
          taskId: args.task_id,
          status: args.status,
          summary: verbose ? summary : slimSummary(summary)
        };
      } catch (e) {
        return fail(e);
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
        reason: { type: "string", description: "Human-readable reason for the amendment." }
      }
    },
    handler: async (args, ctx) => {
      const mgr = getManager(ctx.config);
      try {
        const engine = mgr.getEngine();
        const criteria = args.criteria;
        const added = await engine.amendCriteria({
          criteria: criteria.map(mapCriterion),
          reason: args.reason
        });
        const summary = engine.summarize();
        return { goalId: mgr.getCurrentGoalId(), addedCriteria: added, summary };
      } catch (e) {
        return fail(e);
      }
    }
  },
  {
    name: "can_complete_goal",
    description: [
      "Check whether the goal can be completed based on current acceptance criteria.",
      "",
      "BLOCKING CONDITIONS:",
      "- passed + selfClaimed=false: OK (formal pass)",
      "- passed + selfClaimed=true: BLOCKED (needs confirm_criterion by independent reviewer)",
      "- failed/blocked/pending/in_progress: BLOCKED",
      "- not_run (required only): BLOCKED",
      "",
      "Do NOT declare the task complete until this returns allowed=true. If allowed=false, read the reason field and address each blocking criterion."
    ].join("\n"),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    },
    handler: async (_args, ctx) => {
      const mgr = getManager(ctx.config);
      try {
        const result = mgr.getEngine().canComplete();
        return { goalId: mgr.getCurrentGoalId(), ...result };
      } catch (e) {
        return fail(e);
      }
    }
  },
  {
    name: "set_task_plan",
    description: "Set and lock the task decomposition plan for the current goal. Each task must have a unique id, an unambiguous description, and a concrete deliverable. Task dependencies must reference other tasks in the same plan; dependency cycles are rejected. Requires acceptance criteria to be locked first.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tasks"],
      properties: {
        tasks: {
          type: "array",
          description: "Ordered list of atomic tasks.",
          items: TASK_PLAN_ITEM_SCHEMA
        }
      }
    },
    handler: async (args, ctx) => {
      const mgr = getManager(ctx.config);
      try {
        const engine = mgr.getEngine();
        const tasks = args.tasks;
        const plan = await engine.setTaskPlan(tasks.map(mapTask));
        const summary = engine.summarize();
        return { goalId: mgr.getCurrentGoalId(), taskPlan: plan, summary: slimSummary(summary) };
      } catch (e) {
        return fail(e);
      }
    }
  },
  {
    name: "get_task_plan",
    description: "Read the current task decomposition plan with live task statuses.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    },
    handler: async (_args, ctx) => {
      const mgr = getManager(ctx.config);
      try {
        const plan = mgr.getEngine().getTaskPlan();
        return { goalId: mgr.getCurrentGoalId(), taskPlan: plan };
      } catch (e) {
        return fail(e);
      }
    }
  },
  {
    name: "start_goal",
    description: "Start a new goal with a fresh state. Use this when the current goal is locked and you need to begin a new independent task. Each goal has its own acceptance criteria and task plan. The new goal becomes the active goal.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: {
          type: "string",
          description: "Optional human-readable title for the goal."
        }
      }
    },
    handler: async (args, ctx) => {
      const mgr = getManager(ctx.config);
      try {
        const title = args.title;
        const meta = mgr.startGoal(title);
        return { goal: meta, message: "New goal started and set as active." };
      } catch (e) {
        return fail(e);
      }
    }
  },
  {
    name: "list_goals",
    description: "List all goals with their status summaries. Shows goal ID, title, creation time, criteria counts, and which goal is currently active.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    },
    handler: async (_args, ctx) => {
      const mgr = getManager(ctx.config);
      try {
        const goals = mgr.listGoals();
        return { goals };
      } catch (e) {
        return fail(e);
      }
    }
  },
  {
    name: "switch_goal",
    description: "Switch the active goal to an existing goal by ID. Use list_goals to find goal IDs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["goal_id"],
      properties: {
        goal_id: {
          type: "string",
          description: "The goal ID to switch to (from list_goals)."
        }
      }
    },
    handler: async (args, ctx) => {
      const mgr = getManager(ctx.config);
      try {
        const id = args.goal_id;
        const meta = mgr.switchGoal(id);
        return { goal: meta, message: "Switched active goal." };
      } catch (e) {
        return fail(e);
      }
    }
  },
  {
    name: "reset_goal",
    description: "Delete the current goal and all its data (criteria, task plan, validations). The goal is permanently removed. Use this to clear a messed-up goal and start fresh.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    },
    handler: async (_args, ctx) => {
      const mgr = getManager(ctx.config);
      try {
        mgr.resetGoal();
        return { message: "Current goal deleted. No active goal. Call set_acceptance_criteria to auto-create a new one, or start_goal." };
      } catch (e) {
        return fail(e);
      }
    }
  }
];

// src/plugin/manifest.ts
var manifest = {
  name: "@cckyros/goal-acceptance",
  version: "0.2.1",
  // 0.1.x monorepo → 0.2.0 single-package scaffold
  brand: "goal-acceptance",
  description: "Acceptance-criteria-driven goal completion for autonomous agents.",
  githubSlug: "cckyros/goal-acceptance",
  // Identity markers. Keep stable across releases — uninstall recognizes
  // artifacts by these strings and never touches files without them.
  markers: {
    hook: "goal-acceptance-hook",
    hookCommand: "goal-acceptance-hook",
    skill: "@cckyros/goal-acceptance:skill",
    // matches SKILL.md frontmatter `# {{name}}:skill` fill
    command: "goal-acceptance:command",
    commandFile: "goal-acceptance.md",
    skillDir: "goal-acceptance",
    configDir: ".goal-acceptance",
    cursorDir: "goal-acceptance",
    cursorMarkerFile: ".goal-acceptance-managed",
    cursorMarker: "goal-acceptance:managed",
    agentsStart: "<!-- goal-acceptance:start -->",
    agentsEnd: "<!-- goal-acceptance:end -->"
  },
  config: [
    {
      key: "pluginData",
      label: "Plugin data dir",
      type: "string",
      env: "PLUGIN_DATA",
      default: "",
      placeholder: "e.g. ~/.goal-acceptance (empty = in-memory)"
    },
    {
      key: "autoSteerUncompleted",
      label: "Auto steer on uncompleted goals",
      type: "boolean",
      env: "GOAL_ACCEPTANCE_AUTOSTEER",
      default: true
    },
    {
      key: "maxSteeringTurns",
      label: "Max steering turns per session",
      type: "number",
      env: "GOAL_ACCEPTANCE_MAX_STEERING_TURNS",
      default: 5
    }
  ],
  tools,
  // Skill body ships as assets/SKILL.md (byte-synced to skills/<skillDir>/).
  skill: { filename: "SKILL.md" }
  // No hook / bizCli / doctorChecks — goal acceptance is tool-driven; the
  // dsh steering behavior lives in src/plugin/dsh-plugin.ts (cordis plugin).
};

// src/plugin/prompt.ts
function renderAcceptanceGuidance(summary) {
  let text = 'Goal Acceptance Policy:\n- Before autonomous implementation, establish and confirm delivery criteria with the user using `set_acceptance_criteria`.\n- Each criterion may link to task IDs (`task_ids`) and declare dependencies on other criteria (`depends_on`). Link tasks so progress is tracked automatically.\n- Once confirmed, criteria are locked for this Goal run. Do not edit, downgrade, or remove criteria during execution.\n- If requirements expand during execution, use `amend_acceptance_criteria` to append new criteria with a reason. Existing criteria are not modified.\n- As tasks complete, call `update_task_status` to reflect progress. When all tasks linked to a criterion are completed, that criterion is "ready to validate".\n- Validate each criterion with concrete evidence using `validate_criterion` (status: `passed` or `failed` requires evidence).\n- Required criteria passed by the agent are self-claimed; an independent reviewer must re-verify them and call `confirm_criterion` with command, file, or url evidence before completion.\n- Respect dependency ordering: validate criteria whose `depends_on` are all passed first.\n- If a criterion cannot be verified because this environment lacks a vision model, screenshot comparison, permission, or external service, mark it as `blocked`.\n- Continue executing all achievable independent criteria even if one criterion has failed.\n- The Goal can only conclude when all required criteria are formally passed; self-claimed passes require independent `confirm_criterion` review. Otherwise report a structured summary of failures and blockers.';
  if (summary !== void 0 && summary.totalCount > 0) {
    const tp = summary.taskProgress;
    text += `

Current Criteria (${summary.passedCount}/${summary.totalCount} passed, all required passed: ${String(summary.allRequiredPassed)}):`;
    if (tp.totalTasks > 0) {
      text += `
Task Progress: ${tp.completedTasks}/${tp.totalTasks} completed, ${tp.inProgressTasks} in progress, ${tp.pendingTasks} pending, ${tp.failedTasks} failed`;
    }
    if (summary.failures.length > 0) {
      text += `
- Failures (${summary.failedCount}): ${summary.failures.map((f) => f.id).join(", ")}`;
    }
    if (summary.blockers.length > 0) {
      text += `
- Blockers (${summary.blockedCount}): ${summary.blockers.map((b) => b.id).join(", ")}`;
    }
    if (summary.pending.length > 0) {
      text += `
- Pending (${summary.pendingCount}): ${summary.pending.map((p) => p.id).join(", ")}`;
    }
    if (summary.readyToValidate.length > 0) {
      text += `
- Ready to validate (all linked tasks completed): ${summary.readyToValidate.map((c) => c.id).join(", ")}`;
    }
    if (summary.nextActionable.length > 0) {
      const next = summary.nextActionable[0];
      text += `
- Next actionable: "${next.id}" (${next.description})`;
      if (summary.nextActionable.length > 1) {
        text += `; followed by: ${summary.nextActionable.slice(1).map((c) => `"${c.id}"`).join(", ")}`;
      }
    }
  }
  return text;
}

// src/plugin/invariant.ts
var PACKAGE_NAME = "@cckyros/goal-acceptance";
var name = "goal-acceptance-invariant";
var inject = ["invariants"];
function validateEvent(event, fail2) {
  if (event.type === "goal-acceptance/set") {
    const data = event.data;
    if (!Array.isArray(data.criteria) || data.criteria.length === 0) {
      fail2("goal-acceptance/set event must contain a non-empty criteria array");
    }
  }
}
var install = Object.assign((ctx, fail2) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) {
      validateEvent(event, fail2);
    }
  }
  ctx.on("internal/dispatch", (_mode, eventName, args) => {
    if (eventName !== "session/event") return;
    const [, event] = args;
    validateEvent(event, fail2);
  }, { global: true });
}, { inject: ["sessions"] });
var apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));

// src/plugin/dsh-plugin.ts
var name2 = manifest.name;
var inject2 = ["agents", "tools", "systemPrompt"];
var Config = z.object({
  autoSteerUncompleted: z.boolean().default(true),
  maxSteeringTurns: z.number().step(1).min(1).default(5)
});
var GoalAcceptanceService = class extends Service {
  static inject = ["agents"];
  engines = /* @__PURE__ */ new WeakMap();
  goals = /* @__PURE__ */ new WeakMap();
  activeGoals = /* @__PURE__ */ new WeakMap();
  constructor(ctx) {
    super(ctx, "goalAcceptance");
  }
  getEngine(agent) {
    let engine = this.engines.get(agent);
    if (engine === void 0) {
      engine = new GoalAcceptanceEngine(new SessionAcceptanceStore(agent.session));
      this.engines.set(agent, engine);
      const id = randomUUID2();
      const goals = /* @__PURE__ */ new Map([[id, { engine, title: "", createdAt: Date.now() }]]);
      this.goals.set(agent, goals);
      this.activeGoals.set(agent, id);
    }
    return engine;
  }
  goalMap(agent) {
    this.getEngine(agent);
    return this.goals.get(agent);
  }
  startGoal(agent, title) {
    const goals = this.goalMap(agent);
    const id = randomUUID2();
    const meta = { id, title: title ?? "", createdAt: Date.now() };
    goals.set(id, { ...meta, engine: new GoalAcceptanceEngine(new InMemoryAcceptanceStore()) });
    this.activeGoals.set(agent, id);
    this.engines.set(agent, goals.get(id).engine);
    return meta;
  }
  listGoals(agent) {
    const active = this.activeGoals.get(agent);
    return Array.from(this.goalMap(agent).entries()).map(([id, goal]) => {
      const summary = goal.engine.summarize();
      return { id, title: goal.title, createdAt: goal.createdAt, criteriaCount: summary.totalCount, passedCount: summary.passedCount, allRequiredPassed: summary.allRequiredPassed, isActive: id === active };
    }).sort((a, b) => b.createdAt - a.createdAt);
  }
  switchGoal(agent, id) {
    const goal = this.goalMap(agent).get(id);
    if (goal === void 0) throw new GoalAcceptanceError(`goal ${id} not found`, "GOAL_ACCEPTANCE_NOT_FOUND");
    this.activeGoals.set(agent, id);
    this.engines.set(agent, goal.engine);
    return { id, title: goal.title, createdAt: goal.createdAt };
  }
  resetGoal(agent) {
    const goals = this.goalMap(agent);
    const id = this.activeGoals.get(agent);
    if (id === void 0) throw new GoalAcceptanceError("no active goal to reset", "GOAL_ACCEPTANCE_NO_ACTIVE_GOAL");
    goals.delete(id);
    this.activeGoals.delete(agent);
    this.engines.delete(agent);
  }
  getActiveGoalId(agent) {
    this.getEngine(agent);
    return this.activeGoals.get(agent);
  }
  /** Set and lock the acceptance criteria for the agent's current Goal. */
  setCriteria(agent, specs, role = "agent") {
    return this.getEngine(agent).setCriteria(specs, role);
  }
  /** Append new criteria after the initial lock. */
  amendCriteria(agent, spec) {
    return this.getEngine(agent).amendCriteria(spec);
  }
  /** Record verification status and evidence for one criterion. */
  validateCriterion(agent, spec) {
    return this.getEngine(agent).validateCriterion(spec);
  }
  confirmCriterion(agent, spec) {
    return this.getEngine(agent).confirmCriterion(spec);
  }
  setTaskPlan(agent, specs) {
    return this.getEngine(agent).setTaskPlan(specs);
  }
  getTaskPlan(agent) {
    return this.getEngine(agent).getTaskPlan();
  }
  /** Update the status of a linked task. */
  updateTaskStatus(agent, spec) {
    return this.getEngine(agent).updateTaskStatus(spec);
  }
  /** Get all criteria for the given agent in declaration order. */
  getCriteria(agent) {
    return this.getEngine(agent).getCriteria();
  }
  /** Get a single criterion by id. */
  getCriterion(agent, id) {
    return this.getEngine(agent).getCriterion(id);
  }
  /** Compute aggregate summary of criteria validation. */
  summarize(agent) {
    return this.getEngine(agent).summarize();
  }
  /** Check whether this Goal is allowed to conclude with 'complete'. */
  canComplete(agent) {
    return this.getEngine(agent).canComplete();
  }
};
var STATUSES = [
  "pending",
  "in_progress",
  "passed",
  "failed",
  "blocked",
  "not_run"
];
var TASK_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed"
];
function present(title, kind, rawInput) {
  return { card: "generic", title, kind, ...rawInput === void 0 ? {} : { rawInput } };
}
var CRITERION_ITEM_SCHEMA2 = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true, description: 'Short unique identifier (e.g. "auth-1", "test-pass").' },
    description: { type: "string", required: true, description: "Concrete requirement description." },
    required: { type: "boolean", description: "Whether required for goal completion. Defaults to true." },
    method: { type: "string", description: 'Verification method: "test", "command", "browser", "manual".' },
    task_ids: {
      type: "array",
      items: { type: "string" },
      description: "Task IDs linked to this criterion. When all linked tasks are completed, the criterion is ready to validate."
    },
    depends_on: {
      type: "array",
      items: { type: "string" },
      description: "IDs of criteria that must be passed before this criterion should be validated. Affects steering priority."
    }
  }
};
var TASK_PLAN_ITEM_SCHEMA2 = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    description: { type: "string", required: true },
    deliverable: { type: "string", required: true },
    depends_on: { type: "array", items: { type: "string" } }
  }
};
var ROLE_SCHEMA = { type: "string", enum: ["agent", "reviewer", "dual"] };
var OUTPUT_OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: true
};
function description(toolName) {
  return manifest.tools.find((t) => t.name === toolName).description;
}
function createAcceptanceTools(ctx) {
  const getTool = defineTool({
    name: "get_acceptance_criteria",
    description: description("get_acceptance_criteria"),
    parameters: {},
    output: {
      schema: OUTPUT_OBJECT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    execute(_args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("acceptance tools require a calling agent");
      const service = ctx.get("goalAcceptance");
      if (service === void 0) throw new Error("goalAcceptance service is not mounted");
      const criteria = service.getCriteria(agent);
      const summary = service.summarize(agent);
      return Promise.resolve({
        criteria,
        summary
      });
    },
    presentCall: () => present("Read acceptance criteria", "read")
  });
  function slimSummary2(s) {
    return {
      allRequiredPassed: s.allRequiredPassed,
      passedCount: s.passedCount,
      selfClaimedCount: s.selfClaimedCount,
      totalCount: s.totalCount
    };
  }
  const setTool = defineTool({
    name: "set_acceptance_criteria",
    description: description("set_acceptance_criteria"),
    parameters: {
      criteria: {
        type: "array",
        required: true,
        description: "Array of criteria definitions with id, description, required flag, verification method, optional task IDs, and optional dependencies.",
        items: CRITERION_ITEM_SCHEMA2
      },
      role: { ...ROLE_SCHEMA, description: "Role locking criteria; defaults to agent." }
    },
    output: {
      schema: OUTPUT_OBJECT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("acceptance tools require a calling agent");
      const service = ctx.get("goalAcceptance");
      if (service === void 0) throw new Error("goalAcceptance service is not mounted");
      const rawCriteria = args.criteria;
      const mapped = rawCriteria.map((c) => ({
        id: c.id,
        description: c.description,
        ...c.required !== void 0 ? { required: c.required } : {},
        ...c.method !== void 0 ? { method: c.method } : {},
        ...c.task_ids !== void 0 ? { taskIds: c.task_ids } : {},
        ...c.depends_on !== void 0 ? { dependsOn: c.depends_on } : {}
      }));
      const role = args.role ?? "agent";
      try {
        const criteria = await service.setCriteria(agent, mapped, role);
        return {
          criteria,
          goalId: service.getActiveGoalId(agent),
          summary: service.summarize(agent)
        };
      } catch (e) {
        if (e instanceof GoalAcceptanceError && e.code === "GOAL_ACCEPTANCE_ALREADY_LOCKED") {
          const previousGoalId = service.getActiveGoalId(agent);
          const completion = service.canComplete(agent);
          const previousGoalSummary = slimSummary2(service.summarize(agent));
          await service.startGoal(agent);
          const criteria = await service.setCriteria(agent, mapped, role);
          return {
            goalId: service.getActiveGoalId(agent),
            previousGoalId,
            autoStarted: true,
            previousGoalIncomplete: !completion.allowed,
            ...completion.allowed ? {} : { previousGoalReason: completion.reason, previousGoalSummary },
            criteria,
            summary: service.summarize(agent)
          };
        }
        throw e;
      }
    },
    presentCall: (args) => present("Set acceptance criteria", "other", args.criteria)
  });
  const validateTool = defineTool({
    name: "validate_criterion",
    description: description("validate_criterion"),
    parameters: {
      criterion_id: {
        type: "string",
        required: true,
        description: "Exact criterion id to validate."
      },
      status: {
        type: "string",
        required: true,
        enum: STATUSES,
        description: "Outcome status: pending | in_progress | passed | failed | blocked | not_run"
      },
      evidence: {
        type: "string",
        description: "Verification evidence (e.g. test output, command result, error log). Required for passed/failed."
      },
      evidence_type: { type: "string", enum: ["command", "file", "url", "text"] }
    },
    output: {
      schema: OUTPUT_OBJECT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    execute(args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("acceptance tools require a calling agent");
      const service = ctx.get("goalAcceptance");
      if (service === void 0) throw new Error("goalAcceptance service is not mounted");
      return service.validateCriterion(agent, {
        criterionId: args.criterion_id,
        status: args.status,
        evidence: args.evidence,
        ...args.evidence_type !== void 0 ? { evidenceType: args.evidence_type } : {}
      }).then((updated) => ({
        criterion: updated,
        goalId: service.getActiveGoalId(agent),
        summary: service.summarize(agent)
      }));
    },
    presentCall: (args) => present(`Validate criterion "${String(args.criterion_id)}"`, "other", args)
  });
  const updateTaskTool = defineTool({
    name: "update_task_status",
    description: description("update_task_status"),
    parameters: {
      task_id: {
        type: "string",
        required: true,
        description: "The task ID to update."
      },
      status: {
        type: "string",
        required: true,
        enum: TASK_STATUSES,
        description: "New task status: pending | in_progress | completed | failed"
      }
    },
    output: {
      schema: OUTPUT_OBJECT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    execute(args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("acceptance tools require a calling agent");
      const service = ctx.get("goalAcceptance");
      if (service === void 0) throw new Error("goalAcceptance service is not mounted");
      return service.updateTaskStatus(agent, {
        taskId: args.task_id,
        status: args.status
      }).then(() => ({
        taskId: args.task_id,
        status: args.status,
        goalId: service.getActiveGoalId(agent),
        summary: service.summarize(agent)
      }));
    },
    presentCall: (args) => present(`Update task "${String(args.task_id)}" -> ${String(args.status)}`, "other", args)
  });
  const amendTool = defineTool({
    name: "amend_acceptance_criteria",
    description: description("amend_acceptance_criteria"),
    parameters: {
      criteria: {
        type: "array",
        required: true,
        description: "New criteria to append. Each must have a unique id not already present.",
        items: CRITERION_ITEM_SCHEMA2
      },
      reason: {
        type: "string",
        required: true,
        description: "Human-readable reason for the amendment (recorded in audit trail)."
      }
    },
    output: {
      schema: OUTPUT_OBJECT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    execute(args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("acceptance tools require a calling agent");
      const service = ctx.get("goalAcceptance");
      if (service === void 0) throw new Error("goalAcceptance service is not mounted");
      const rawCriteria = args.criteria;
      return service.amendCriteria(agent, {
        criteria: rawCriteria.map((c) => ({
          id: c.id,
          description: c.description,
          ...c.required !== void 0 ? { required: c.required } : {},
          ...c.method !== void 0 ? { method: c.method } : {},
          ...c.task_ids !== void 0 ? { taskIds: c.task_ids } : {},
          ...c.depends_on !== void 0 ? { dependsOn: c.depends_on } : {}
        })),
        reason: args.reason
      }).then((added) => ({
        addedCriteria: added,
        goalId: service.getActiveGoalId(agent),
        summary: service.summarize(agent)
      }));
    },
    presentCall: (args) => present("Amend acceptance criteria", "other", args)
  });
  const requireService = (exec) => {
    if (exec.agent === void 0) throw new Error("acceptance tools require a calling agent");
    const service = ctx.get("goalAcceptance");
    if (service === void 0) throw new Error("goalAcceptance service is not mounted");
    return { agent: exec.agent, service };
  };
  const confirmTool = defineTool({
    name: "confirm_criterion",
    description: description("confirm_criterion"),
    parameters: { criterion_id: { type: "string", required: true }, evidence: { type: "string", required: true }, evidence_type: { type: "string", required: true, enum: ["command", "file", "url"] } },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) {
      const { agent, service } = requireService(exec);
      return service.confirmCriterion(agent, { criterionId: args.criterion_id, evidence: args.evidence, evidenceType: args.evidence_type }).then((criterion) => ({ criterion, summary: service.summarize(agent) }));
    },
    presentCall: (args) => present("Confirm criterion", "other", args)
  });
  const canCompleteTool = defineTool({
    name: "can_complete_goal",
    description: description("can_complete_goal"),
    parameters: {},
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    execute(_args, exec) {
      const { agent, service } = requireService(exec);
      return Promise.resolve(service.canComplete(agent));
    },
    presentCall: () => present("Check goal completion", "read")
  });
  const setPlanTool = defineTool({
    name: "set_task_plan",
    description: description("set_task_plan"),
    parameters: { tasks: { type: "array", required: true, items: TASK_PLAN_ITEM_SCHEMA2 } },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) {
      const { agent, service } = requireService(exec);
      const tasks = args.tasks;
      return service.setTaskPlan(agent, tasks.map((t) => ({ id: t.id, description: t.description, deliverable: t.deliverable, ...t.depends_on !== void 0 ? { dependsOn: t.depends_on } : {} }))).then((taskPlan) => ({ taskPlan, summary: service.summarize(agent) }));
    },
    presentCall: (args) => present("Set task plan", "other", args)
  });
  const getPlanTool = defineTool({
    name: "get_task_plan",
    description: description("get_task_plan"),
    parameters: {},
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    execute(_args, exec) {
      const { agent, service } = requireService(exec);
      return Promise.resolve({ taskPlan: service.getTaskPlan(agent) });
    },
    presentCall: () => present("Read task plan", "read")
  });
  const startTool = defineTool({
    name: "start_goal",
    description: description("start_goal"),
    parameters: { title: { type: "string" } },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) {
      const { agent, service } = requireService(exec);
      return Promise.resolve({ goal: service.startGoal(agent, args.title), message: "New goal started and set as active." });
    },
    presentCall: (args) => present("Start goal", "other", args)
  });
  const listTool = defineTool({
    name: "list_goals",
    description: description("list_goals"),
    parameters: {},
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    execute(_args, exec) {
      const { agent, service } = requireService(exec);
      return Promise.resolve({ goals: service.listGoals(agent) });
    },
    presentCall: () => present("List goals", "read")
  });
  const switchTool = defineTool({
    name: "switch_goal",
    description: description("switch_goal"),
    parameters: { goal_id: { type: "string", required: true } },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) {
      const { agent, service } = requireService(exec);
      return Promise.resolve({ goal: service.switchGoal(agent, args.goal_id), message: "Switched active goal." });
    },
    presentCall: (args) => present("Switch goal", "other", args)
  });
  const resetTool = defineTool({
    name: "reset_goal",
    description: description("reset_goal"),
    parameters: {},
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    execute(_args, exec) {
      const { agent, service } = requireService(exec);
      service.resetGoal(agent);
      return Promise.resolve({ message: "Current goal deleted. No active goal." });
    },
    presentCall: () => present("Reset goal", "other")
  });
  return [setTool, getTool, validateTool, confirmTool, updateTaskTool, amendTool, canCompleteTool, setPlanTool, getPlanTool, startTool, listTool, switchTool, resetTool];
}
async function apply2(ctx, config = {}) {
  const autoSteer = config.autoSteerUncompleted !== false;
  const maxSteering = config.maxSteeringTurns ?? 5;
  if (ctx.get("goalAcceptance") === void 0) {
    await ctx.plugin(GoalAcceptanceService);
  }
  if (ctx.get("invariants") !== void 0) {
    await ctx.plugin({ name, inject, apply });
  }
  const tools2 = createAcceptanceTools(ctx);
  for (const tool of tools2) {
    ctx.tools.register(tool);
  }
  ctx.systemPrompt.section({
    name: "policy:goal-acceptance",
    order: 115,
    text: (context) => {
      const agent = context.agent;
      const service = ctx.get("goalAcceptance");
      const summary = agent !== void 0 && service !== void 0 ? service.summarize(agent) : void 0;
      return renderAcceptanceGuidance(summary);
    }
  });
  const steeringCounts = /* @__PURE__ */ new WeakMap();
  ctx.on("agent/turn-stopping", ({ agent }) => {
    const service = ctx.get("goalAcceptance");
    if (service === void 0) return;
    const criteria = service.getCriteria(agent);
    if (criteria.length === 0) return;
    const summary = service.summarize(agent);
    if (summary.allRequiredPassed) return;
    const actionable = criteria.filter((c) => c.required && (c.status === "pending" || c.status === "in_progress"));
    const selfClaimedRequired = summary.selfClaimedPassed.filter((c) => c.required);
    if (actionable.length === 0 && selfClaimedRequired.length === 0) return;
    if (!autoSteer) return;
    const count = steeringCounts.get(agent) ?? 0;
    if (count >= maxSteering) return;
    steeringCounts.set(agent, count + 1);
    const parts = [];
    parts.push(`Goal Acceptance Reminder (attempt ${count + 1}/${maxSteering}):`);
    if (selfClaimedRequired.length > 0) {
      const ids = selfClaimedRequired.map((c) => `"${c.id}"`).join(", ");
      parts.push(`Required criteria ${ids} are self-claimed. Ask an independent reviewer to re-verify and call \`confirm_criterion\` with fresh command, file, or url evidence.`);
    } else if (actionable.length > 0) {
      parts.push("Required criteria remain pending or in progress; continue the work before stopping.");
    }
    const tp = summary.taskProgress;
    if (tp.totalTasks > 0) {
      parts.push(`Task progress: ${tp.completedTasks}/${tp.totalTasks} completed.`);
    }
    if (summary.readyToValidate.length > 0) {
      const ready = summary.readyToValidate.map((c) => `"${c.id}"`).join(", ");
      parts.push(`Ready to validate (all linked tasks done): ${ready}. Call \`validate_criterion\` with evidence now.`);
    }
    if (summary.nextActionable.length > 0) {
      const next = summary.nextActionable[0];
      parts.push(`Next priority: "${next.id}" (${next.description}).`);
      if (summary.nextActionable.length > 1) {
        const rest = summary.nextActionable.slice(1).map((c) => `"${c.id}"`).join(", ");
        parts.push(`Then: ${rest}.`);
      }
    } else {
      const blocked = actionable.filter((c) => !summary.nextActionable.includes(c));
      if (blocked.length > 0) {
        const blockedDesc = blocked.map((c) => `"${c.id}" (waiting on: ${c.dependsOn.join(", ")})`).join(", ");
        parts.push(`Waiting on dependencies: ${blockedDesc}.`);
      }
    }
    const noTaskPending = actionable.filter((c) => c.taskIds.length === 0 && !summary.readyToValidate.includes(c));
    if (noTaskPending.length > 0 && summary.nextActionable.length === 0) {
      const ids = noTaskPending.map((c) => `"${c.id}" (${c.description})`).join(", ");
      parts.push(`Required criteria not yet validated: ${ids}.`);
    }
    parts.push("If an item cannot be validated in this environment, mark it as `blocked`.");
    agent.steer(createUserMessage({
      content: [{ type: "text", text: parts.join(" ") }],
      source: { kind: "plugin", plugin: manifest.name }
    }));
  });
}
export {
  Config,
  GoalAcceptanceService,
  apply2 as apply,
  createAcceptanceTools,
  inject2 as inject,
  name2 as name
};
