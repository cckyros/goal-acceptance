/**
 * Headless CLI subcommands for the goal-acceptance plugin.
 *
 * These exist so external orchestrators (e.g. ralph-orchestrator's
 * `pre.loop.complete` hook with `on_error: block`) can gate on the same
 * can_complete_goal verdict the MCP tools expose — without speaking MCP:
 *
 *   goal-acceptance check   → exit 0 when the goal may complete, exit 1
 *                             (with blocking criteria on stderr) otherwise
 *   goal-acceptance status  → JSON summary of goal + criteria on stdout
 *
 * Both resolve the data directory exactly like the MCP server: PLUGIN_DATA
 * env / config `pluginData`. Point the orchestrator's hook env at the same
 * directory the agent's MCP server uses.
 */

import type { BizCliContext } from "../framework/manifest.ts";
import { GoalManager } from "./goal-manager.ts";

function managerFor(config: BizCliContext["config"]): GoalManager {
  return new GoalManager(String(config.pluginData ?? ""));
}

/** `goal-acceptance check` — hard gate for orchestrator hooks. */
export async function checkCli(_argv: string[], ctx: BizCliContext): Promise<void> {
  const mgr = managerFor(ctx.config);
  const goalId = mgr.getCurrentGoalId();
  if (goalId === null) ctx.fail("check: no active goal");

  const result = mgr.getEngine().canComplete();
  if (result.allowed) {
    ctx.log(`check: allowed (goal ${goalId})`);
    return;
  }

  const blocking = mgr
    .getEngine()
    .getCriteria()
    .filter((c) => c.required && (c.status !== "passed" || c.selfClaimed === true))
    .map((c) => {
      const flags: string[] = [c.status];
      if (c.selfClaimed === true) flags.push("self-claimed, needs confirm_criterion");
      return `  - ${c.id}: ${c.description} [${flags.join(", ")}]`;
    })
    .join("\n");
  ctx.fail(`check: blocked (goal ${goalId})\n${result.reason ?? ""}${blocking ? `\nblocking criteria:\n${blocking}` : ""}`);
}

/** `goal-acceptance status` — machine-readable summary for scripts/hats. */
export async function statusCli(_argv: string[], ctx: BizCliContext): Promise<void> {
  const mgr = managerFor(ctx.config);
  const goalId = mgr.getCurrentGoalId();
  if (goalId === null) {
    ctx.log(JSON.stringify({ goalId: null, allowed: false, reason: "no active goal" }));
    return;
  }

  const engine = mgr.getEngine();
  const result = engine.canComplete();
  const summary = engine.summarize();
  const meta = mgr.getCurrentGoalMeta();
  ctx.log(
    JSON.stringify({
      goalId,
      goal: meta ? { id: meta.id, title: meta.title, description: meta.description } : undefined,
      allowed: result.allowed,
      reason: result.reason,
      criteria: engine.getCriteria().map((c) => ({
        id: c.id,
        description: c.description,
        status: c.status,
        required: c.required,
        selfClaimed: c.selfClaimed === true,
      })),
      summary,
    }),
  );
}
