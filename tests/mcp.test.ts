// MCP stdio server: JSON-RPC handshake, tools/list from the manifest, and a
// real tools/call through set_acceptance_criteria (config flows into tool
// context; default pluginData "" = in-memory goal manager).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { manifest } from "../src/plugin/manifest.ts";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

interface Rpc {
  id?: unknown;
  result?: { serverInfo?: { name?: string; version?: string }; tools?: Array<{ name: string }>; content?: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

function mcpSession(lines: string[]): Rpc[] {
  const r = spawnSync(process.execPath, [CLI, "mcp"], {
    input: lines.join("\n") + "\n",
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Rpc);
}

test("initialize returns the manifest's identity", () => {
  const [res] = mcpSession([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })]);
  assert.equal(res.result?.serverInfo?.name, manifest.name);
  assert.equal(res.result?.serverInfo?.version, manifest.version);
});

test("tools/list exposes all 13 manifest tools", () => {
  const [res] = mcpSession([JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })]);
  const names = res.result?.tools?.map((t) => t.name) ?? [];
  assert.equal(names.length, manifest.tools.length);
  for (const t of manifest.tools) {
    assert.ok(names.includes(t.name), `missing ${t.name} in ${names.join(", ")}`);
  }
});

test("tools/call set_acceptance_criteria starts an in-memory goal and locks criteria", () => {
  const [res] = mcpSession([
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "set_acceptance_criteria",
        arguments: {
          criteria: [{ id: "compile", description: "tsc passes", required: true, method: "command" }],
        },
      },
    }),
  ]);
  const text = res.result?.content?.[0]?.text ?? "";
  const data = JSON.parse(text);
  assert.ok(data.goalId, "goalId present");
  assert.equal(data.criteria.length, 1);
  assert.equal(data.summary.totalCount, 1);
  // role=agent default: passed would be self-claimed; a pending required
  // criterion keeps the goal uncompletable.
  assert.equal(data.summary.allRequiredPassed, false);
});

test("tools/call set_acceptance_criteria again rotates to a new goal when locked", () => {
  // Same stdio session (one process), so the first call's goal is still locked.
  const [first, second] = mcpSession([
    JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "set_acceptance_criteria",
        arguments: { criteria: [{ id: "c1", description: "first", required: true }] },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "set_acceptance_criteria",
        arguments: { criteria: [{ id: "c2", description: "second", required: true }] },
      },
    }),
  ]);
  const firstData = JSON.parse(first.result?.content?.[0]?.text ?? "");
  const secondData = JSON.parse(second.result?.content?.[0]?.text ?? "");
  // Locked criteria are immutable, so the second call rotates to a fresh goal
  // instead of dead-ending the caller (upstream b883e95 semantics).
  assert.notEqual(secondData.goalId, firstData.goalId);
  assert.equal(secondData.autoStarted, true);
  assert.equal(secondData.previousGoalId, firstData.goalId);
  assert.equal(secondData.previousGoalIncomplete, true);
  assert.ok(secondData.previousGoalReason);
  assert.equal(secondData.previousGoalSummary.allRequiredPassed, false);
  assert.deepEqual(secondData.criteria.map((c: { id: string }) => c.id), ["c2"]);
});

test("tools/call against no active goal returns a structured error", () => {
  // Fresh server, in-memory mode: no goal has been started, so the engine
  // error surfaces as {error, code} inside the tool result (not a throw).
  const [res] = mcpSession([
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "can_complete_goal", arguments: {} } }),
  ]);
  const text = res.result?.content?.[0]?.text ?? "";
  const data = JSON.parse(text);
  assert.equal(data.code, "GOAL_ACCEPTANCE_NO_ACTIVE_GOAL");
  assert.ok(data.error.includes("no active goal"), data.error);
});

test("tools/call unknown tool returns a JSON-RPC error", () => {
  const [res] = mcpSession([JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } })]);
  assert.equal(res.error?.code, -32602);
});
