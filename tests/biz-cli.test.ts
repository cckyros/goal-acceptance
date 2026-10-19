// bizCli headless subcommands (`check` / `status`): gate semantics for
// external orchestrators. `check` exits 0 only when can_complete_goal allows;
// `status` prints a JSON summary. Both resolve the shared PLUGIN_DATA dir,
// which is the same dir an agent-side MCP server would use.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

interface Rpc {
  result?: { content?: Array<{ type: string; text: string }> };
}

function cli(args: string[], dataDir: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, PLUGIN_DATA: dataDir },
  });
}

function mcp(lines: string[], dataDir: string) {
  const r = spawnSync(process.execPath, [CLI, "mcp"], {
    input: lines.join("\n") + "\n",
    encoding: "utf8",
    env: { ...process.env, PLUGIN_DATA: dataDir },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Rpc);
}

function toolCall(id: number, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

test("check: exit 1 with no goal, 1 while criteria unmet, 0 once complete", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ga-biz-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const noGoal = cli(["check"], dir);
  assert.equal(noGoal.status, 1);
  assert.ok(noGoal.stderr.includes("no active goal"), noGoal.stderr);

  mcp(
    [
      toolCall(1, "set_acceptance_criteria", {
        criteria: [{ id: "c1", description: "echo works", required: true, method: "command" }],
      }),
      toolCall(2, "run_and_validate", { criterion_id: "c1", command: "node -e \"console.log('ok')\"" }),
    ],
    dir,
  );

  // run_and_validate marks c1 passed but self-claimed → still blocked.
  const selfClaimed = cli(["check"], dir);
  assert.equal(selfClaimed.status, 1);
  assert.ok(selfClaimed.stderr.includes("c1"), selfClaimed.stderr);

  // Reviewer confirmation needs high-confidence evidence (command/file/url).
  mcp(
    [
      toolCall(3, "confirm_criterion", {
        criterion_id: "c1",
        evidence: "re-ran node -e print, output verified",
        evidence_type: "command",
      }),
    ],
    dir,
  );

  const done = cli(["check"], dir);
  assert.equal(done.status, 0, done.stderr);
  assert.ok(done.stdout.includes("allowed"), done.stdout);
});

test("status: JSON summary reflects the shared store", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ga-biz-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const empty = cli(["status"], dir);
  assert.equal(empty.status, 0);
  assert.equal(JSON.parse(empty.stdout).goalId, null);

  mcp(
    [
      toolCall(1, "set_acceptance_criteria", {
        criteria: [
          { id: "c1", description: "required one", required: true, method: "command" },
          { id: "c2", description: "optional one", required: false, method: "text" },
        ],
      }),
    ],
    dir,
  );

  const r = cli(["status"], dir);
  assert.equal(r.status, 0);
  const data = JSON.parse(r.stdout) as {
    goalId: string;
    allowed: boolean;
    criteria: Array<{ id: string; status: string; required: boolean }>;
  };
  assert.ok(data.goalId);
  assert.equal(data.allowed, false);
  assert.equal(data.criteria.length, 2);
  assert.deepEqual(data.criteria.map((c) => c.id), ["c1", "c2"]);
});

test("integrity: check exits 1 on artifact drift, 0 after re-validation", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ga-biz-"));
  const ws = mkdtempSync(join(tmpdir(), "ga-ws-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });
  const artifact = join(ws, "out.txt");
  writeFileSync(artifact, "v1");

  mcp(
    [
      toolCall(1, "set_acceptance_criteria", {
        workspace: ws,
        criteria: [
          { id: "c1", description: "out.txt verified", required: true, artifacts: ["out.txt"], task_ids: ["t1"] },
        ],
      }),
      toolCall(2, "set_task_plan", {
        tasks: [{ id: "t1", description: "produce out.txt", deliverable: "out.txt" }],
      }),
      toolCall(3, "claim_task", { task_id: "t1" }),
      toolCall(4, "review_task", {
        task_id: "t1",
        verdicts: [{ criterion_id: "c1", status: "passed", evidence: "content verified", evidence_type: "file" }],
      }),
    ],
    dir,
  );

  const clean = cli(["check"], dir);
  assert.equal(clean.status, 0, clean.stderr);

  // Post-review tamper → drift blocks the gate.
  writeFileSync(artifact, "tampered");
  const drifted = cli(["check"], dir);
  assert.equal(drifted.status, 1);
  assert.ok(drifted.stderr.includes("drifted"), drifted.stderr);

  const status = cli(["status"], dir);
  const data = JSON.parse(status.stdout) as { allowed: boolean; drift?: Array<{ criterion: { id: string } }> };
  assert.equal(data.allowed, false);
  assert.equal(data.drift?.[0]?.criterion.id, "c1");

  // Rework path: claim_task reclaims the completed task, re-review clears.
  writeFileSync(artifact, "v1-fixed");
  mcp(
    [
      toolCall(5, "claim_task", {}),
      toolCall(6, "review_task", {
        task_id: "t1",
        verdicts: [{ criterion_id: "c1", status: "passed", evidence: "re-verified", evidence_type: "file" }],
      }),
    ],
    dir,
  );
  const done = cli(["check"], dir);
  assert.equal(done.status, 0, done.stderr);
});

test("verify_command pinning: run_and_validate runs only the pinned command", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ga-biz-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const res = mcp(
    [
      toolCall(1, "set_acceptance_criteria", {
        criteria: [{ id: "c1", description: "pinned", required: true, verify_command: "node -e \"console.log('pinned')\"" }],
      }),
      // wrong command → tool-level error
      toolCall(2, "run_and_validate", { criterion_id: "c1", command: "node -e \"process.exit(1)\"" }),
      // no command arg → runs the pinned one
      toolCall(3, "run_and_validate", { criterion_id: "c1" }),
    ],
    dir,
  );

  const mismatch = res[1]?.result?.content?.[0]?.text ?? "";
  assert.ok(mismatch.includes("VERIFY_COMMAND_MISMATCH") || mismatch.includes("pins verify_command"), mismatch);
  const pinned = res[2]?.result?.content?.[0]?.text ?? "";
  assert.ok(pinned.includes("passed") && !pinned.includes("MISMATCH"), pinned);
});
