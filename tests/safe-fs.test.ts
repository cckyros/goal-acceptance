// safe-fs safety rules: markers, backups, deep-merge, idempotency, and the
// "never touch a user file without our marker" invariant. (AC4)
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backupFile,
  deepMerge,
  removeJsonKey,
  removeManagedBlock,
  upsertJsonKey,
  upsertManagedBlock,
  upsertTomlSection,
  removeTomlSection,
} from "../src/framework/safe-fs.ts";

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aps-safe-"));
  mkdirSync(d, { recursive: true });
  return d;
}

const MARKER = "my-plugin:managed";
const START = "<!-- my-plugin:start -->";
const END = "<!-- my-plugin:end -->";

test("upsertJsonKey: creates file, deep-merges, idempotent, leaves unknown keys", () => {
  const d = tmpDir();
  const p = join(d, "settings.json");

  const first = upsertJsonKey(p, "hook", { command: "node hook.cjs", enabled: true });
  assert.equal(first.changed, true);

  const second = upsertJsonKey(p, "hook", { enabled: false }); // patch only
  assert.equal(second.changed, true);
  const data = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(data.hook.command, "node hook.cjs"); // untouched
  assert.equal(data.hook.enabled, false); // patched

  const third = upsertJsonKey(p, "hook", { enabled: false });
  assert.equal(third.changed, false); // idempotent
});

test("removeJsonKey: only removes entries carrying our marker", () => {
  const d = tmpDir();
  const p = join(d, "settings.json");
  writeFileSync(
    p,
    JSON.stringify(
      {
        ours: { command: `node hook.cjs ${MARKER}` },
        theirs: { command: "node user-hook.cjs" },
      },
      null,
      2,
    ) + "\n",
  );

  const removed = removeJsonKey(p, "theirs", MARKER);
  assert.equal(removed.changed, false); // no marker → untouched

  const ours = removeJsonKey(p, "ours", MARKER);
  assert.equal(ours.changed, true);
  const data = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(data.theirs.command, "node user-hook.cjs"); // survivor kept
  assert.equal("ours" in data, false);
});

test("upsertManagedBlock: insert, replace, idempotent, backup on first change", () => {
  const d = tmpDir();
  const p = join(d, "AGENTS.md");
  writeFileSync(p, "# Project\n");

  const first = upsertManagedBlock(p, `${START}\nblock\n${END}`, START, END);
  assert.equal(first.changed, true);
  assert.equal(existsSync(`${p}.bak`), true); // first modification backs up

  const content1 = readFileSync(p, "utf8");
  assert.ok(content1.includes(START) && content1.includes("# Project"));

  // replace with new content → backs up again (pre-modification state)
  const second = upsertManagedBlock(p, `${START}\nnew block\n${END}`, START, END);
  assert.equal(second.changed, true);
  assert.ok(readFileSync(p, "utf8").includes("new block"));

  const third = upsertManagedBlock(p, `${START}\nnew block\n${END}`, START, END);
  assert.equal(third.changed, false); // idempotent
});

test("removeManagedBlock: removes only the block, keeps the rest", () => {
  const d = tmpDir();
  const p = join(d, "AGENTS.md");
  writeFileSync(p, `# Project\n\n${START}\nblock\n${END}\n\n# End\n`);
  const r = removeManagedBlock(p, START, END);
  assert.equal(r.changed, true);
  const content = readFileSync(p, "utf8");
  assert.ok(!content.includes(START));
  assert.ok(content.includes("# Project"));
  assert.ok(content.includes("# End"));
});

test("deepMerge: patch wins, arrays replace, unknown keys kept", () => {
  assert.deepEqual(deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 } }), {
    a: 1,
    b: { c: 9, d: 3 },
  });
  assert.deepEqual(deepMerge({ arr: [1, 2] }, { arr: [3] }), { arr: [3] });
  assert.deepEqual(deepMerge({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
});

test("backupFile: copies the pre-modification state", () => {
  const d = tmpDir();
  const p = join(d, "f.txt");
  writeFileSync(p, "original");
  const bak = backupFile(p);
  assert.ok(bak && bak.endsWith(".bak"));
  assert.equal(readFileSync(bak!, "utf8"), "original");
});

test("upsertTomlSection / removeTomlSection: section-scoped edits", () => {
  const d = tmpDir();
  const p = join(d, "config.toml");
  writeFileSync(p, "[user]\nname = \"limc\"\n");

  const first = upsertTomlSection(p, "mcp_servers.demo", "[mcp_servers.demo]\ncommand = \"npx\"\n");
  assert.equal(first.changed, true);
  let content = readFileSync(p, "utf8");
  assert.ok(content.includes("[mcp_servers.demo]"));
  assert.ok(content.includes("[user]"));

  const again = upsertTomlSection(p, "mcp_servers.demo", "[mcp_servers.demo]\ncommand = \"npx\"\n");
  assert.equal(again.changed, false); // idempotent

  const removed = removeTomlSection(p, "mcp_servers.demo");
  assert.equal(removed.changed, true);
  content = readFileSync(p, "utf8");
  assert.ok(!content.includes("mcp_servers.demo"));
  assert.ok(content.includes("[user]"));
});
